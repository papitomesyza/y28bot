const config = require('./config');
const db = require('./db');
const { coinbaseWS } = require('./coinbase-ws');
const { polymarketRTDS } = require('./polymarket-ws');
const { priceTracker } = require('./price-tracker');
const { volatilityTracker } = require('./volatility');
const marketDiscovery = require('./market-discovery');
const { orderExecutor } = require('./order-executor');

const SECONDS_PER_YEAR = 31536000;

class SpreadScalp {
  constructor() {
    this.losses = [];
    this.lastEntryKey = new Map();
    this.tooCloseLogKey = new Map();
  }

  // --- Circuit breaker: 3 losses in 1hr = 2hr pause ---
  checkCircuitBreaker() {
    const cb = config.spreadScalpCircuitBreaker;
    const oneHourAgo = Date.now() - cb.windowHours * 60 * 60 * 1000;

    // Clean up losses older than 3 hours
    const threeHoursAgo = Date.now() - 3 * 60 * 60 * 1000;
    this.losses = this.losses.filter(ts => ts >= threeHoursAgo);

    const recentLosses = this.losses.filter(ts => ts >= oneHourAgo);
    if (recentLosses.length >= cb.maxLosses) {
      const lastLoss = Math.max(...recentLosses);
      const pauseEnd = lastLoss + cb.pauseHours * 60 * 60 * 1000;
      if (Date.now() < pauseEnd) {
        return { blocked: true, resumeIn: pauseEnd - Date.now() };
      }
    }

    return { blocked: false };
  }

  // --- Record a spread scalp loss ---
  recordLoss() {
    this.losses.push(Date.now());
  }

  // --- Irrev calculation (same formula as superscalp) ---
  calculateIrrev(asset, openPrice, currentPrice, remainingSeconds, totalSeconds) {
    const delta = Math.abs(currentPrice - openPrice) / openPrice;
    const vol = volatilityTracker.getVolatility(asset);
    const windowVol = vol * Math.sqrt(totalSeconds / SECONDS_PER_YEAR);
    const timeRemaining = Math.sqrt(remainingSeconds / totalSeconds);
    const expectedMove = windowVol * timeRemaining;

    if (!expectedMove || expectedMove < 0.0001) return 0;
    return delta / expectedMove;
  }

  // --- Allocation sizing (same compounding tiers, spread scalp floor) ---
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

    // Floor: enough to buy minShares at $0.99 (spread scalp worst-case ask)
    allocation = Math.max(allocation, config.minShares * 0.99);

    return Math.min(allocation, config.maxTradeSize);
  }

  // --- Evaluate spread scalp opportunity for a lane (called every second) ---
  async evaluate(laneId) {
    const parts = laneId.split('-');
    const asset = parts[0];
    const interval = parseInt(parts[1], 10);
    const totalSeconds = interval * 60;

    const windowTs = priceTracker.getWindowTs(interval);
    const remainingSeconds = priceTracker.getRemainingSeconds(interval);

    // Only fire in the last N seconds of the window
    if (remainingSeconds > config.spreadScalpLastSeconds) return null;

    // Block if too close to window end (order won't fill in time)
    if (remainingSeconds <= 10) {
      if (this.tooCloseLogKey.get(laneId) !== windowTs) {
        this.tooCloseLogKey.set(laneId, windowTs);
        console.log(`[spread-scalp] ${laneId} BLOCKED: too close to window end (${remainingSeconds}s remaining)`);
      }
      return null;
    }

    // One spread scalp entry per lane per window
    if (this.lastEntryKey.get(laneId) === windowTs) return null;

    let currentPrice = polymarketRTDS.getPrice(asset);
    if (currentPrice == null || polymarketRTDS.isStale()) {
      currentPrice = coinbaseWS.getPrice(asset);
    }
    if (currentPrice == null) return null;

    const openPrice = await priceTracker.captureOpenPrice(laneId, interval);
    if (openPrice == null) return null;

    const market = await marketDiscovery.findMarket(laneId, windowTs, interval);
    if (!market) return null;

    const irrev = this.calculateIrrev(asset, openPrice, currentPrice, remainingSeconds, totalSeconds);
    if (irrev < config.spreadScalpIrrev) return null;

    // Circuit breaker
    const cb = this.checkCircuitBreaker();
    if (cb.blocked) return null;

    // Direction
    const direction = currentPrice >= openPrice ? 'UP' : 'DOWN';

    // Token based on direction
    const tokenId = direction === 'UP' ? market.upTokenId : market.downTokenId;

    // Dry run or executor not initialized — use real ask if available, else simulated
    if (!orderExecutor.initialized || config.dryRun) {
      let simPrice = 0.95;

      // Fetch real ask if ClobClient is available
      if (orderExecutor.initialized && orderExecutor.client) {
        const realAsk = await orderExecutor.getOrderbookPrice(tokenId, 'buy');
        if (realAsk !== null) {
          simPrice = realAsk;
        }
      }

      if (simPrice < 0.20 || simPrice > 0.99) return null;

      const poolBalance = db.getPoolBalance();
      const allocation = this.calculateAllocation(poolBalance, irrev);
      let shares = Math.floor(allocation / simPrice);
      if (shares < config.minShares) return null;

      const potentialLoss = shares * (1 - simPrice);
      if (potentialLoss > config.maxLossPerTrade) {
        shares = Math.floor(config.maxLossPerTrade / (1 - simPrice));
        if (shares < config.minShares) return null;
      }

      // Minimum edge check: expected profit must be >= $0.05
      const expectedProfit = (shares * 1.00) - (shares * simPrice);
      if (expectedProfit < 0.05) {
        console.log(`[spread-scalp] ${laneId} GATE BLOCKED: edge too thin (profit $${expectedProfit.toFixed(2)} at ask $${simPrice.toFixed(2)})`);
        return null;
      }

      // Return signal only — main loop handles execution and recording
      return {
        type: 'spread_scalp',
        laneId,
        asset,
        direction,
        irrev,
        entryPrice: simPrice,
        shares,
        cost: shares * simPrice,
        windowTs,
        market,
      };
    }

    // Real orderbook ask price
    const askPrice = await orderExecutor.getOrderbookPrice(tokenId, 'buy');
    if (askPrice == null || askPrice < 0.20 || askPrice > 0.99) return null;

    // Allocation
    const poolBalance = db.getPoolBalance();
    const allocation = this.calculateAllocation(poolBalance, irrev);

    // Shares
    let shares = Math.floor(allocation / askPrice);
    if (shares < config.minShares) return null;

    // Max loss cap: shares * (1 - askPrice) <= $5
    const potentialLoss = shares * (1 - askPrice);
    if (potentialLoss > config.maxLossPerTrade) {
      shares = Math.floor(config.maxLossPerTrade / (1 - askPrice));
      if (shares < config.minShares) return null;
    }

    // Minimum edge check: expected profit must be >= $0.05
    const expectedProfit = (shares * 1.00) - (shares * askPrice);
    if (expectedProfit < 0.05) {
      console.log(`[spread-scalp] ${laneId} GATE BLOCKED: edge too thin (profit $${expectedProfit.toFixed(2)} at ask $${askPrice.toFixed(2)})`);
      return null;
    }

    return {
      type: 'spread_scalp',
      laneId,
      asset,
      direction,
      irrev,
      entryPrice: askPrice,
      shares,
      cost: shares * askPrice,
      windowTs,
      market,
    };
  }

  // --- Mark that a spread scalp entry was made for this lane/window ---
  recordEntry(laneId, windowTs) {
    this.lastEntryKey.set(laneId, windowTs);
  }
}

const spreadScalp = new SpreadScalp();

module.exports = { SpreadScalp, spreadScalp };
