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
  calculateAllocation(poolBalance, irrev) {
    const tier = config.compoundingTiers.find(
      t => poolBalance >= t.minBalance && poolBalance < t.maxBalance
    );
    if (!tier) return 0;

    let allocation = poolBalance * tier.allocation;

    if (irrev >= config.irrevMultipliers.extreme.threshold) {
      allocation *= config.irrevMultipliers.extreme.multiplier;
    } else if (irrev >= config.irrevMultipliers.high.threshold) {
      allocation *= config.irrevMultipliers.high.multiplier;
    }

    // Floor: always enough to buy minShares at max midpoint price ($0.55)
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

  // --- Velocity check ---
  checkVelocity(asset, direction, seconds = 10) {
    const arr = volatilityTracker.ticks.get(asset);
    if (!arr || arr.length < 3) return true;

    const cutoff = Date.now() - seconds * 1000;
    const recent = arr.filter(t => t.timestamp >= cutoff);
    if (recent.length < 3) return true;

    const last3 = recent.slice(-3);
    let consistent = 0;
    for (let i = 1; i < last3.length; i++) {
      const diff = last3[i].price - last3[i - 1].price;
      if (direction === 'UP' && diff >= 0) consistent++;
      if (direction === 'DOWN' && diff <= 0) consistent++;
    }

    return consistent >= last3.length - 1;
  }

  // --- Stack tracking ---
  getStackLevel(laneId) {
    const entries = this.activeEntries.get(laneId);
    return entries ? entries.length : 0;
  }

  getIrrevThreshold(stackLevel) {
    const rc = global.runtimeConfig || {};
    if (stackLevel === 0) return rc.irrevThreshold != null ? rc.irrevThreshold : config.irrevThresholds.base;
    if (stackLevel === 1) return rc.irrevStack2 != null ? rc.irrevStack2 : config.irrevThresholds.stack2;
    return rc.irrevStack3 != null ? rc.irrevStack3 : config.irrevThresholds.stack3;
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

    const irrev = this.calculateIrrev(asset, openPrice, currentPrice, remainingSeconds, totalSeconds);
    const direction = this.getDirection(openPrice, currentPrice);

    // Throttled logging: every 30 seconds per lane
    const now = Date.now();
    const lastLog = this._lastLogTime.get(laneId) || 0;
    if (now - lastLog >= 30000) {
      this._lastLogTime.set(laneId, now);
      console.log(`[scalp] ${laneId} irrev=${irrev.toFixed(2)} dir=${direction} remaining=${remainingSeconds}s open=$${openPrice}`);
    }

    // === STRATEGY SPLIT BY TIMEFRAME ===
    const elapsedSec = totalSeconds - remainingSeconds;

    if (interval <= 15) {
      // === 5M / 15M: CONTRARIAN (mean reversion) ===
      // Academic evidence: crypto has negative return autocorrelation at 5M.
      // Strategy: if price moved significantly from open, bet on reversal.
      // We bet AGAINST the current direction — buy the losing side cheap.

      const call1Elapsed = Math.floor(totalSeconds * 0.30);

      // Wait until 30% of candle elapsed before evaluating
      if (elapsedSec < call1Elapsed) {
        return null;
      }

      // Need minimum irrev of 0.5 to confirm a meaningful move happened
      if (irrev < 0.5) {
        return null;
      }

      // Contrarian direction: OPPOSITE of current price movement
      const contrarianDirection = direction === 'UP' ? 'DOWN' : 'UP';

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
        const tokenId = contrarianDirection === 'UP' ? market.upTokenId : market.downTokenId;
        let askPrice = null;
        if (orderExecutor.initialized && orderExecutor.client) {
          try { askPrice = await orderExecutor.getOrderbookPrice(tokenId, 'buy'); } catch (_) {}
        }
        if (askPrice == null) return null;

        // CRITICAL: only enter if the contrarian (losing) side is CHEAP
        // This is the entire edge — we buy the losing side at $0.30-$0.52
        // Breakeven at these prices is 30-52% — mean reversion gives us ~52-55%
        const maxContrarianAsk = 0.52;
        if (askPrice > maxContrarianAsk) {
          const logKey = `contra-cap-${laneId}`;
          const lastCapLog = this._lastLogTime.get(logKey) || 0;
          if (now - lastCapLog >= 10000) {
            this._lastLogTime.set(logKey, now);
            console.log(`[scalp] ${laneId} CONTRARIAN_CAP: losing side $${askPrice} > $${maxContrarianAsk}`);
          }
          return null;
        }

        const poolBalance = db.getPoolBalance();
        if (poolBalance < config.minPoolBalance) return null;

        const allocation = this.calculateAllocation(poolBalance, irrev);
        const shareCalc = this.calculateShares(allocation, askPrice);
        if (!shareCalc) return null;

        console.log(`[scalp] ${laneId} CONTRARIAN ENTRY: bet ${contrarianDirection} (price moved ${direction}) irrev=${irrev.toFixed(2)} ask=$${askPrice}`);

        return {
          type: 'contrarian',
          laneId,
          asset,
          direction: contrarianDirection,
          irrev,
          entryPrice: askPrice,
          allocation,
          shares: shareCalc.shares,
          cost: shareCalc.cost,
          windowTs,
        };
      } finally {
        this.executionLock.delete(lockKey);
      }

    } else {
      // === 1H / 4H: MOMENTUM (Haiku-confirmed) ===
      // Research: momentum works from 1H+. Use Haiku for pattern reading.
      // Only enter when Haiku confirms AND shares are affordable.

      const { haikuAgent } = require('./haiku-agent');
      const haikuResult = await haikuAgent.evaluate(laneId, asset, interval, windowTs, irrev, elapsedSec);

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

        // Minimum irrev at execution time — the move must still be alive
        if (irrev < 0.5) {
          console.log(`[scalp] ${laneId} IRREV_FLOOR: ${irrev.toFixed(2)} < 0.5 at execution`);
          return null;
        }

        const { orderExecutor } = require('./order-executor');
        const tokenId = finalDirection === 'UP' ? market.upTokenId : market.downTokenId;
        let askPrice = null;
        if (orderExecutor.initialized && orderExecutor.client) {
          try { askPrice = await orderExecutor.getOrderbookPrice(tokenId, 'buy'); } catch (_) {}
        }
        if (askPrice == null) return null;

        // Max ask for momentum: $0.65 (breakeven = 65%, achievable with Haiku + momentum regime)
        const maxMomentumAsk = 0.65;
        if (askPrice > maxMomentumAsk) {
          const logKey = `momentum-cap-${laneId}`;
          const lastCapLog = this._lastLogTime.get(logKey) || 0;
          if (now - lastCapLog >= 10000) {
            this._lastLogTime.set(logKey, now);
            console.log(`[scalp] ${laneId} MOMENTUM_CAP: $${askPrice} > $${maxMomentumAsk}`);
          }
          return null;
        }

        const poolBalance = db.getPoolBalance();
        if (poolBalance < config.minPoolBalance) return null;

        const allocation = this.calculateAllocation(poolBalance, irrev);
        const shareCalc = this.calculateShares(allocation, askPrice);
        if (!shareCalc) return null;

        console.log(`[scalp] ${laneId} HAIKU MOMENTUM: ${finalDirection} irrev=${irrev.toFixed(2)} ask=$${askPrice}`);

        return {
          type: 'haiku_momentum',
          laneId,
          asset,
          direction: finalDirection,
          irrev,
          entryPrice: askPrice,
          allocation,
          shares: shareCalc.shares,
          cost: shareCalc.cost,
          windowTs,
        };
      } finally {
        this.executionLock.delete(lockKey);
      }
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
