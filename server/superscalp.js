const config = require('./config');
const { coinbaseWS } = require('./coinbase-ws');
const { priceTracker } = require('./price-tracker');
const { volatilityTracker } = require('./volatility');
const { polymarketRTDS } = require('./polymarket-ws');
const marketDiscovery = require('./market-discovery');
const db = require('./db');

const SECONDS_PER_YEAR = 31536000;

class SuperScalp {
  constructor() {
    this.activeEntries = new Map();
    this._lastLogTime = new Map();
    this.peakDeltas = new Map();
    this.executionLock = new Set(); // laneId currently executing — prevents async race
  }

  // --- Core irreversibility formula ---
  calculateIrrev(asset, openPrice, currentPrice, remainingSeconds, totalSeconds) {
    const delta = Math.abs(currentPrice - openPrice) / openPrice;
    const vol = volatilityTracker.getVolatility(asset);
    const windowVol = vol * Math.sqrt(totalSeconds / SECONDS_PER_YEAR);
    const timeRemaining = Math.sqrt(remainingSeconds / totalSeconds);
    const expectedMove = windowVol * timeRemaining;

    if (!expectedMove || expectedMove < 0.0001) return 0;
    return delta / expectedMove;
  }

  // --- Direction determination ---
  getDirection(openPrice, currentPrice) {
    return currentPrice >= openPrice ? 'UP' : 'DOWN';
  }

  // --- Allocation sizing ---
  calculateAllocation(poolBalance) {
    const tier = config.compoundingTiers.find(
      t => poolBalance >= t.minBalance && poolBalance < t.maxBalance
    );
    if (!tier) return 0;

    let allocation = poolBalance * tier.allocation;

    // Floor: always enough to buy minShares at max ask price ($0.55)
    allocation = Math.max(allocation, config.minShares * 0.55);

    // Safety net: never exceed 25% of pool regardless of tier
    allocation = Math.min(allocation, poolBalance * 0.25);

    return Math.min(allocation, config.maxTradeSize);
  }

  // --- Share calculation with loss cap ---
  calculateShares(allocation, entryPrice) {
    let shares = allocation / entryPrice;

    // Check potential loss: shares * (1 - entryPrice)
    const potentialLoss = shares * (1 - entryPrice);
    if (potentialLoss > config.maxLossPerTrade) {
      shares = config.maxLossPerTrade / (1 - entryPrice);
    }

    if (shares < config.minShares) return null;

    return {
      shares: Math.floor(shares),
      cost: Math.floor(shares) * entryPrice,
    };
  }

  // --- Main evaluation loop (called every second per lane) ---
  async evaluate(laneId) {
    const parts = laneId.split('-');
    const asset = parts[0];
    const interval = parseInt(parts[1], 10);
    const totalSeconds = interval * 60;

    const windowTs = priceTracker.getWindowTs(interval);
    const remainingSeconds = priceTracker.getRemainingSeconds(interval);

    // Reset active entries on new window
    const entries = this.activeEntries.get(laneId);
    if (entries && entries.length > 0 && entries[0].windowTs !== windowTs) {
      this.resetWindow(laneId, windowTs);
    }

    let currentPrice = polymarketRTDS.getPrice(asset);
    if (currentPrice == null || polymarketRTDS.isStale()) {
      currentPrice = coinbaseWS.getPrice(asset);
      if (currentPrice != null && polymarketRTDS.isStale()) {
        const now2 = Date.now();
        const staleLogKey = `rtds-stale-${laneId}`;
        const lastStaleLog = this._lastLogTime.get(staleLogKey) || 0;
        if (now2 - lastStaleLog >= 30000) {
          this._lastLogTime.set(staleLogKey, now2);
          console.log(`[scalp] ${laneId} RTDS stale, using Coinbase fallback`);
        }
      }
    }
    if (currentPrice == null) return null;

    const openPrice = await priceTracker.captureOpenPrice(laneId, interval);
    if (openPrice == null) return null;

    // Find market for orderbook/token lookups (not for open price)
    let market = null;
    try {
      market = await marketDiscovery.findMarket(laneId, windowTs, interval);
    } catch (_) {}

    // Irrev calculated for logging/DB only — does NOT gate anything
    const irrev = this.calculateIrrev(asset, openPrice, currentPrice, remainingSeconds, totalSeconds);
    const direction = this.getDirection(openPrice, currentPrice);
    const elapsedSec = totalSeconds - remainingSeconds;

    // Throttled logging: every 30 seconds per lane
    const now = Date.now();
    const lastLog = this._lastLogTime.get(laneId) || 0;
    if (now - lastLog >= 30000) {
      this._lastLogTime.set(laneId, now);
      console.log(`[scalp] ${laneId} irrev=${irrev.toFixed(2)} dir=${direction} remaining=${remainingSeconds}s open=$${openPrice}`);
    }

    // === HAIKU AGENT: sole trade decision-maker ===
    const { haikuAgent } = require('./haiku-agent');
    const haikuResult = await haikuAgent.evaluate(laneId, asset, interval, windowTs, elapsedSec);

    if (!haikuResult.approved) {
      if (haikuResult.reason !== 'too early in candle' && !haikuResult.reason.startsWith('confirmation in') && haikuResult.reason !== 'already executed') {
        const logKey = `haiku-${laneId}`;
        const lastHaikuLog = this._lastLogTime.get(logKey) || 0;
        if (now - lastHaikuLog >= 10000) {
          this._lastLogTime.set(logKey, now);
          console.log(`[haiku-gate] ${laneId} BLOCKED: ${haikuResult.reason}`);
        }
      }
      return null;
    }

    const finalDirection = haikuResult.direction || direction;

    // === ATOMIC EXECUTION LOCK ===
    const lockKey = `${laneId}:${windowTs}`;
    if (this.executionLock.has(lockKey)) return null;
    const existingEntries = this.activeEntries.get(laneId) || [];
    if (existingEntries.length >= 1) return null;
    this.executionLock.add(lockKey);

    try {
      if (remainingSeconds <= 10) return null;
      if (!market) return null;

      const { orderExecutor } = require('./order-executor');
      const tokenId = finalDirection === 'UP' ? market.upTokenId : market.downTokenId;
      let askPrice = null;
      if (orderExecutor.initialized && orderExecutor.client) {
        try { askPrice = await orderExecutor.getOrderbookPrice(tokenId, 'buy'); } catch (_) {}
      }
      if (askPrice == null) return null;

      // Valid entry range: $0.40–$0.55
      // Below $0.40 = market strongly disagrees with Haiku — skip
      const minAsk = 0.40;
      if (askPrice < minAsk) {
        const logKey = `ask-floor-${laneId}`;
        const lastFloorLog = this._lastLogTime.get(logKey) || 0;
        if (now - lastFloorLog >= 10000) {
          this._lastLogTime.set(logKey, now);
          console.log(`[scalp] ${laneId} ASK_FLOOR: $${askPrice} < $${minAsk}`);
        }
        return null;
      }

      // Above $0.55 = breakeven too high — skip
      const maxAsk = 0.55;
      if (askPrice > maxAsk) {
        const logKey = `ask-cap-${laneId}`;
        const lastCapLog = this._lastLogTime.get(logKey) || 0;
        if (now - lastCapLog >= 10000) {
          this._lastLogTime.set(logKey, now);
          console.log(`[scalp] ${laneId} ASK_CAP: $${askPrice} > $${maxAsk}`);
        }
        return null;
      }

      const poolBalance = db.getPoolBalance();
      if (poolBalance < config.minPoolBalance) return null;

      const allocation = this.calculateAllocation(poolBalance);
      const shareCalc = this.calculateShares(allocation, askPrice);
      if (!shareCalc) return null;

      // Asian off-hours share cap: 22:00–06:00 UTC+2
      let { shares, cost } = shareCalc;
      const hour = new Date().getHours();
      if (hour >= 22 || hour <= 5) {
        if (shares > 3) {
          console.log(`[scalp] ${laneId} ASIAN_CAP: shares capped from ${shares} to 3`);
          shares = 3;
          cost = 3 * askPrice;
        }
      }

      console.log(`[scalp] ${laneId} HAIKU ENTRY: ${finalDirection} irrev=${irrev.toFixed(2)} ask=$${askPrice}`);

      return {
        type: 'haiku',
        laneId,
        asset,
        direction: finalDirection,
        irrev,
        entryPrice: askPrice,
        allocation,
        shares,
        cost,
        windowTs,
      };
    } finally {
      this.executionLock.delete(lockKey);
    }
  }

  // --- Reset lane entries for new window ---
  resetWindow(laneId, windowTs) {
    this.activeEntries.set(laneId, []);
    // Clear stale execution locks for this lane
    for (const key of this.executionLock) {
      if (key.startsWith(`${laneId}:`)) this.executionLock.delete(key);
    }
    // Clear stale peak deltas for this lane (any previous window keys)
    for (const key of this.peakDeltas.keys()) {
      if (key.startsWith(`${laneId}-`) && !key.endsWith(`-${windowTs}`)) {
        this.peakDeltas.delete(key);
      }
    }
  }
}

const superScalp = new SuperScalp();

module.exports = { SuperScalp, superScalp };
