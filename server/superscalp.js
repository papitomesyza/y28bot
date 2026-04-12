const config = require('./config');
const { coinbaseWS } = require('./coinbase-ws');
const { priceTracker } = require('./price-tracker');
const { volatilityTracker } = require('./volatility');
const { getChainlinkPrice } = require('./chainlink');
const { polymarketRTDS } = require('./polymarket-ws');
const marketDiscovery = require('./market-discovery');
const db = require('./db');

const SECONDS_PER_YEAR = 31536000;

class SuperScalp {
  constructor() {
    this.activeEntries = new Map();
    this.spreadScalpLosses = [];
    this._lastLogTime = new Map();
    this.peakDeltas = new Map();
    this._lastEnhancedLogTime = new Map();
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

  // FIX 2: Unified minimum irrev threshold — midpoint must match scalp gate minimums
  getUnifiedMinThreshold(asset, interval) {
    if (interval === 5) return config.irrevThresholds.base; // 1.9 for 5M
    // 15M lanes
    if (asset === 'BTC') return 3.5;
    return 2.5; // ETH, SOL, XRP
  }

  // --- Midpoint gate check ---
  checkGates(laneId, asset, interval, irrev, entryPrice, remainingSeconds, direction, stackLevel) {
    const threshold = this.getIrrevThreshold(stackLevel);
    if (irrev < threshold) {
      return { pass: false, reason: `irrev ${irrev.toFixed(2)} < threshold ${threshold}` };
    }

    const entryWindow = config.entryWindows[interval];
    if (remainingSeconds > entryWindow) {
      return { pass: false, reason: `remaining ${remainingSeconds}s > entry window ${entryWindow}s` };
    }
    if (remainingSeconds <= 10) {
      return { pass: false, reason: `remaining ${remainingSeconds}s too close to window end` };
    }

    if (!this.checkVelocity(asset, direction)) {
      return { pass: false, reason: 'velocity reversing' };
    }

    if (entryPrice < config.midpointPriceRange.min || entryPrice > config.midpointPriceRange.max) {
      return { pass: false, reason: `entry price $${entryPrice} outside midpoint range $${config.midpointPriceRange.min}-$${config.midpointPriceRange.max}` };
    }

    const poolBalance = db.getPoolBalance();
    if (poolBalance < config.minPoolBalance) {
      return { pass: false, reason: `pool $${poolBalance.toFixed(2)} < minimum $${config.minPoolBalance}` };
    }

    const entries = this.activeEntries.get(laneId) || [];
    if (entries.length >= config.stackMaxEntries) {
      return { pass: false, reason: `max stacks (${config.stackMaxEntries}) reached` };
    }

    if (stackLevel > 0 && entries.length > 0) {
      const lastEntry = entries[entries.length - 1];
      if (entryPrice > lastEntry.entryPrice - config.stackPriceImprovement) {
        return { pass: false, reason: `entry $${entryPrice} not $${config.stackPriceImprovement} better than prev $${lastEntry.entryPrice}` };
      }
    }

    const allocation = this.calculateAllocation(poolBalance, irrev);
    const shareCalc = this.calculateShares(allocation, entryPrice);
    if (!shareCalc) {
      return { pass: false, reason: 'insufficient shares (below min or exceeds loss cap)' };
    }

    return { pass: true, reason: 'all gates passed' };
  }

  // --- Spread scalp gate check ---
  checkSpreadScalpGates(laneId, asset, interval, irrev, askPrice, remainingSeconds) {
    if (irrev < config.spreadScalpIrrev) {
      return { pass: false, reason: `irrev ${irrev.toFixed(2)} < spread scalp threshold ${config.spreadScalpIrrev}` };
    }

    if (remainingSeconds > config.spreadScalpLastSeconds) {
      return { pass: false, reason: `remaining ${remainingSeconds}s > last ${config.spreadScalpLastSeconds}s window` };
    }

    if (askPrice < config.spreadScalpPriceRange.min || askPrice > config.spreadScalpPriceRange.max) {
      return { pass: false, reason: `ask price $${askPrice} outside range $${config.spreadScalpPriceRange.min}-$${config.spreadScalpPriceRange.max}` };
    }

    const poolBalance = db.getPoolBalance();
    if (poolBalance < config.minPoolBalance) {
      return { pass: false, reason: `pool $${poolBalance.toFixed(2)} < minimum $${config.minPoolBalance}` };
    }

    // Circuit breaker check
    const cb = config.spreadScalpCircuitBreaker;
    const oneHourAgo = Date.now() - cb.windowHours * 60 * 60 * 1000;
    const recentLosses = this.spreadScalpLosses.filter(ts => ts >= oneHourAgo);
    if (recentLosses.length >= cb.maxLosses) {
      const lastLoss = Math.max(...recentLosses);
      const pauseEnd = lastLoss + cb.pauseHours * 60 * 60 * 1000;
      if (Date.now() < pauseEnd) {
        const remainPause = Math.ceil((pauseEnd - Date.now()) / 1000 / 60);
        return { pass: false, reason: `circuit breaker: ${recentLosses.length} losses in 1hr, paused ${remainPause}min` };
      }
    }

    return { pass: true, reason: 'all spread scalp gates passed' };
  }

  // --- Enhanced multi-layer gate filter ---
  async checkEnhancedGates(laneId, asset, interval, direction, openPrice, currentPrice, windowTs) {
    const gates = config.enhancedGates;
    const peakKey = `${laneId}-${windowTs}`;

    // Update peak delta tracking (Layer 6)
    const currentDelta = Math.abs(currentPrice - openPrice);
    const prevPeak = this.peakDeltas.get(peakKey) || 0;
    if (currentDelta > prevPeak) {
      this.peakDeltas.set(peakKey, currentDelta);
    }
    const peakDelta = this.peakDeltas.get(peakKey);

    // Throttle enhanced gate logs (10s per lane)
    const now = Date.now();
    const logKey = `enhanced-${laneId}`;
    const lastEnhLog = this._lastEnhancedLogTime.get(logKey) || 0;
    const shouldLog = now - lastEnhLog >= 10000;
    if (shouldLog) this._lastEnhancedLogTime.set(logKey, now);

    // LAYER 7 — Time-Scaled Minimum Delta Filter (HARD GATE)
    const delta = Math.abs(currentPrice - openPrice);
    const baseDelta = gates.minDelta[asset];
    const remainingSeconds = priceTracker.getRemainingSeconds(interval);
    let timeMultiplier = 1.0;
    if (remainingSeconds <= 10) timeMultiplier = 1.5;
    else if (remainingSeconds <= 30) timeMultiplier = 1.4;
    else if (remainingSeconds <= 60) timeMultiplier = 1.3;
    else if (remainingSeconds <= 120) timeMultiplier = 1.2;
    const scaledDelta = baseDelta * timeMultiplier;
    if (delta < scaledDelta) {
      if (shouldLog) console.log(`[enhanced] ${laneId} KILLED: delta $${delta.toFixed(4)} < scaled min $${scaledDelta.toFixed(4)} (base=$${baseDelta} x${timeMultiplier} at ${remainingSeconds}s remaining)`);
      return { pass: false, reason: 'enhanced L7: delta too small' };
    }

    // LAYER 6 — No-Reversal Check (HARD GATE)
    if (peakDelta > 0) {
      const retracement = 1 - (currentDelta / peakDelta);
      if (retracement > gates.maxRetracement) {
        if (shouldLog) console.log(`[enhanced] ${laneId} KILLED: retracement ${(retracement * 100).toFixed(1)}% > max ${gates.maxRetracement * 100}%`);
        return { pass: false, reason: 'enhanced L6: retracement too high' };
      }
    }

    // LAYER 2 — Chainlink Non-Contradiction (HARD GATE)
    let chainlinkDirection = 'neutral';
    let chainlinkDelta = 0;
    try {
      let currentChainlinkPrice = polymarketRTDS.getPrice(asset);
      if (currentChainlinkPrice == null) {
        currentChainlinkPrice = await getChainlinkPrice(asset);
      }
      if (currentChainlinkPrice != null) {
        chainlinkDelta = currentChainlinkPrice - openPrice;
        if (Math.abs(chainlinkDelta) <= gates.chainlinkNoise[asset]) {
          chainlinkDirection = 'neutral';
        } else {
          chainlinkDirection = chainlinkDelta > 0 ? 'UP' : 'DOWN';
        }
      }
    } catch (_) {
      // RPC failure → pass (don't block on RPC errors)
      chainlinkDirection = 'neutral';
    }

    if (chainlinkDirection !== 'neutral' && chainlinkDirection !== direction) {
      console.log(`[enhanced] ${laneId} KILLED: Chainlink contradicts (signal=${direction}, chainlink=${chainlinkDirection}, delta=$${chainlinkDelta.toFixed(4)})`);
      return { pass: false, reason: 'enhanced L2: Chainlink contradicts' };
    }

    // LAYER 3 — Chainlink Delta Ratio (HARD GATE, only when Chainlink not neutral)
    if (chainlinkDirection !== 'neutral') {
      const coinbaseDelta = Math.abs(currentPrice - openPrice);
      const chainlinkAbsDelta = Math.abs(chainlinkDelta);
      if (coinbaseDelta > 0) {
        const ratio = chainlinkAbsDelta / coinbaseDelta;
        if (ratio < gates.chainlinkDeltaRatio) {
          console.log(`[enhanced] ${laneId} KILLED: Chainlink ratio too low (${(ratio * 100).toFixed(1)}% < ${gates.chainlinkDeltaRatio * 100}%)`);
          return { pass: false, reason: 'enhanced L3: Chainlink ratio too low' };
        }
      }
    }

    // LAYER 4 — Trend Consistency (SOFT — log only)
    if (shouldLog) {
      const arr = volatilityTracker.ticks.get(asset);
      if (arr && arr.length >= 2) {
        const cutoff = now - gates.trendLookbackSeconds * 1000;
        const recent = arr.filter(t => t.timestamp >= cutoff);
        if (recent.length >= 2) {
          const bucketSize = 5000;
          const buckets = [];
          let bucketStart = recent[0].timestamp;
          let bucketTicks = [recent[0]];
          for (let i = 1; i < recent.length; i++) {
            if (recent[i].timestamp - bucketStart >= bucketSize) {
              buckets.push(bucketTicks);
              bucketTicks = [recent[i]];
              bucketStart = recent[i].timestamp;
            } else {
              bucketTicks.push(recent[i]);
            }
          }
          if (bucketTicks.length > 0) buckets.push(bucketTicks);

          if (buckets.length >= 2) {
            let matching = 0;
            let total = 0;
            for (let i = 1; i < buckets.length; i++) {
              const prevAvg = buckets[i - 1].reduce((s, t) => s + t.price, 0) / buckets[i - 1].length;
              const currAvg = buckets[i].reduce((s, t) => s + t.price, 0) / buckets[i].length;
              const bucketDir = currAvg >= prevAvg ? 'UP' : 'DOWN';
              if (bucketDir === direction) matching++;
              total++;
            }
            const trendScore = matching / total;
            console.log(`[enhanced] ${laneId} trend=${trendScore.toFixed(2)} (${direction})`);
          }
        }
      }
    }

    // LAYER 5 — Cross-Asset Momentum (SOFT — log only)
    if (shouldLog) {
      const otherAssets = config.assets.filter(a => a !== asset);
      let confirmCount = 0;
      const totalSeconds = interval * 60;
      const remainingSeconds = priceTracker.getRemainingSeconds(interval);
      for (const otherAsset of otherAssets) {
        const otherLaneId = `${otherAsset}-${interval}M`;
        const otherKey = `${otherLaneId}:${windowTs}`;
        const otherWin = priceTracker.windows.get(otherKey);
        if (!otherWin || !otherWin.capturedOpen || otherWin.openPrice == null) continue;
        const otherOpen = otherWin.openPrice;
        const otherPrice = coinbaseWS.getPrice(otherAsset);
        if (otherPrice == null) continue;
        const otherIrrev = this.calculateIrrev(otherAsset, otherOpen, otherPrice, remainingSeconds, totalSeconds);
        const otherDir = this.getDirection(otherOpen, otherPrice);
        if (otherIrrev > gates.crossAssetMinIrrev && otherDir === direction) {
          confirmCount++;
        }
      }
      console.log(`[enhanced] ${laneId} cross-asset: ${confirmCount}/3 confirm ${direction}`);
    }

    return { pass: true, reason: 'all enhanced gates passed' };
  }

  // --- Main evaluation loop (called every second per lane) ---
  async evaluate(laneId) {
    const parts = laneId.split('-');
    const asset = parts[0];
    const interval = parseInt(parts[1], 10);
    const totalSeconds = interval * 60;

    const windowTs = priceTracker.getWindowTs(interval);
    const remainingSeconds = priceTracker.getRemainingSeconds(interval);

    // FIX 3: 15M time gate — only evaluate 15M lanes in last 5 minutes
    if (interval === 15 && remainingSeconds > 300) {
      const now15 = Date.now();
      const logKey15 = `15m-gate-${laneId}`;
      const lastLog15 = this._lastLogTime.get(logKey15) || 0;
      if (now15 - lastLog15 >= 30000) {
        this._lastLogTime.set(logKey15, now15);
        console.log(`[scalp] ${laneId} SKIPPED: 15M time gate, remaining ${remainingSeconds}s > 300s`);
      }
      return null;
    }

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

    // Momentum gate — block counter-trend UP trades
    try {
      const { momentumGate } = require('./momentum-gate');
      const gateResult = momentumGate.isDirectionAllowed(asset, direction, laneId);
      if (!gateResult.allowed) {
        const now = Date.now();
        const logKey = `gate-${laneId}`;
        const lastLog = this._lastLogTime.get(logKey) || 0;
        if (now - lastLog >= 10000) {
          this._lastLogTime.set(logKey, now);
          console.log(`[momentum-gate] ${laneId} ${direction} BLOCKED: ${gateResult.reason}`);
        }
        return null;
      }
      // Dry-run logging for would-be blocks (gate disabled)
      if (gateResult.reason && gateResult.reason.includes('would block')) {
        const now = Date.now();
        const logKey = `gate-dry-${laneId}`;
        const lastLog = this._lastLogTime.get(logKey) || 0;
        if (now - lastLog >= 30000) {
          this._lastLogTime.set(logKey, now);
          console.log(`[momentum-gate] DRY RUN: ${laneId} ${direction} would be blocked: ${gateResult.reason}`);
        }
      }
    } catch (err) {
      // Gate not ready yet — allow trade
    }

    // Throttled logging: every 30 seconds per lane
    const now = Date.now();
    const lastLog = this._lastLogTime.get(laneId) || 0;
    if (now - lastLog >= 30000) {
      this._lastLogTime.set(laneId, now);
      console.log(`[scalp] ${laneId} irrev=${irrev.toFixed(2)} dir=${direction} remaining=${remainingSeconds}s open=$${openPrice}`);
    }

    // Midpoint path — fetch real orderbook price when available
    const stackLevel = this.getStackLevel(laneId);
    const { orderExecutor } = require('./order-executor');
    let entryPrice = 0.50; // fallback placeholder

    // Attempt real orderbook price for midpoint
    let midpointUsedRealPrice = false;
    if (orderExecutor.initialized && orderExecutor.client && market) {
      try {
        const tokenId = direction === 'UP' ? market.upTokenId : market.downTokenId;
        const realAsk = await orderExecutor.getOrderbookPrice(tokenId, 'buy');
        if (realAsk !== null) {
          entryPrice = realAsk;
          midpointUsedRealPrice = true;
        }
      } catch (_) {
        // Fall back to placeholder
      }
    }

    // If real ask exceeds midpoint range, skip midpoint path
    let midpointCheck = { pass: false, reason: 'real ask outside midpoint range' };
    if (entryPrice <= config.midpointPriceRange.max) {
      midpointCheck = this.checkGates(laneId, asset, interval, irrev, entryPrice, remainingSeconds, direction, stackLevel);
    }

    // FIX 2: Unified minimum irrev threshold for midpoint path
    if (midpointCheck.pass) {
      const unifiedThreshold = this.getUnifiedMinThreshold(asset, interval);
      if (irrev < unifiedThreshold) {
        console.log(`[signal] midpoint ${laneId} irrev=${irrev.toFixed(2)} BLOCKED: below threshold ${unifiedThreshold}`);
        midpointCheck = { pass: false, reason: `irrev below unified threshold ${unifiedThreshold}` };
      }
    }

    if (midpointCheck.pass) {
      const poolBalance = db.getPoolBalance();
      const allocation = this.calculateAllocation(poolBalance, irrev);
      const shareCalc = this.calculateShares(allocation, entryPrice);
      if (shareCalc) {
        // Minimum edge gate: expected profit must be >= $0.10
        const expectedProfit = (shareCalc.shares * 1.00) - (shareCalc.shares * entryPrice);
        if (expectedProfit < 0.10) {
          console.log(`[scalp] ${laneId} GATE BLOCKED: edge too thin (profit $${expectedProfit.toFixed(2)} at ask $${entryPrice.toFixed(2)})`);
        } else {
          const enhancedResult = await this.checkEnhancedGates(laneId, asset, interval, direction, openPrice, currentPrice, windowTs);
          if (!enhancedResult.pass) {
            // Already logged inside checkEnhancedGates
          } else {
            // Haiku agent confirmation gate
            const { haikuAgent } = require('./haiku-agent');
            const elapsedSec = (interval * 60) - remainingSeconds;
            const haikuResult = await haikuAgent.evaluate(laneId, asset, interval, windowTs, irrev, elapsedSec);

            if (haikuResult.approved) {
              // If Haiku returned a direction, use it instead of the irrev-based direction
              const finalDirection = haikuResult.direction || direction;
              return {
                type: 'midpoint',
                laneId,
                asset,
                direction: finalDirection,
                irrev,
                entryPrice,
                allocation,
                shares: shareCalc.shares,
                cost: shareCalc.cost,
                windowTs,
              };
            } else {
              const now = Date.now();
              const logKey = `haiku-mid-${laneId}`;
              const lastLog = this._lastLogTime.get(logKey) || 0;
              if (now - lastLog >= 10000) {
                this._lastLogTime.set(logKey, now);
                console.log(`[haiku-gate] ${laneId} midpoint BLOCKED: ${haikuResult.reason}`);
              }
            }
          }
        }
      }
    }

    // Spread scalp path — fetch real orderbook price when available
    let askPrice = 0.95; // fallback placeholder
    if (orderExecutor.initialized && orderExecutor.client && market) {
      try {
        const tokenId = direction === 'UP' ? market.upTokenId : market.downTokenId;
        const realAsk = await orderExecutor.getOrderbookPrice(tokenId, 'buy');
        if (realAsk !== null) {
          askPrice = realAsk;
        }
      } catch (_) {
        // Fall back to placeholder
      }
    }

    const spreadCheck = this.checkSpreadScalpGates(laneId, asset, interval, irrev, askPrice, remainingSeconds);
    if (spreadCheck.pass) {
      const poolBalance = db.getPoolBalance();
      const allocation = this.calculateAllocation(poolBalance, irrev);
      const shareCalc = this.calculateShares(allocation, askPrice);
      if (shareCalc) {
        const enhancedResult = await this.checkEnhancedGates(laneId, asset, interval, direction, openPrice, currentPrice, windowTs);
        if (enhancedResult.pass) {
          // Haiku agent confirmation gate
          const { haikuAgent } = require('./haiku-agent');
          const elapsedSec = (interval * 60) - remainingSeconds;
          const haikuResult = await haikuAgent.evaluate(laneId, asset, interval, windowTs, irrev, elapsedSec);

          if (haikuResult.approved) {
            const finalDirection = haikuResult.direction || direction;
            return {
              type: 'spread_scalp',
              laneId,
              asset,
              direction: finalDirection,
              irrev,
              askPrice,
              allocation,
              shares: shareCalc.shares,
              cost: shareCalc.cost,
              windowTs,
            };
          } else {
            const now = Date.now();
            const logKey = `haiku-ss-${laneId}`;
            const lastLog = this._lastLogTime.get(logKey) || 0;
            if (now - lastLog >= 10000) {
              this._lastLogTime.set(logKey, now);
              console.log(`[haiku-gate] ${laneId} spread scalp BLOCKED: ${haikuResult.reason}`);
            }
          }
        }
      }
    }

    // Log gate rejections when irrev is notable (>=1.5) to aid debugging
    if (irrev >= 1.5) {
      const reasons = [];
      if (!midpointCheck.pass) reasons.push(`midpoint: ${midpointCheck.reason}`);
      if (!spreadCheck.pass) reasons.push(`spread: ${spreadCheck.reason}`);
      console.log(`[scalp] ${laneId} irrev=${irrev.toFixed(2)} GATE BLOCKED: ${reasons.join(' | ')}`);
    }

    return null;
  }

  // --- Reset lane entries for new window ---
  resetWindow(laneId, windowTs) {
    this.activeEntries.set(laneId, []);
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
