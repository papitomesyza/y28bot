const { polymarketRTDS } = require('./polymarket-ws');
const { coinbaseWS } = require('./coinbase-ws');
const { priceTracker } = require('./price-tracker');
const { superScalp } = require('./superscalp');
const { orderExecutor } = require('./order-executor');
const positionManager = require('./position-manager');
const trendObserver = require('./trend-observer');
const db = require('./db');
const config = require('./config');

class DCAEngine {
  constructor() {
    this.activeLanes = new Map();
    this._lastLogTime = new Map();
  }

  /**
   * Main evaluation loop — called every second per DCA lane (Tier 3/4 only).
   * Returns a signal object or null.
   */
  async evaluate(laneId, tierConfig, windowTs, remainingSeconds) {
    const asset = laneId.split('-')[0];
    const totalSeconds = tierConfig.interval * 60;

    // --- Current price (RTDS primary, Coinbase fallback) ---
    let currentPrice = polymarketRTDS.getPrice(asset);
    if (currentPrice == null || polymarketRTDS.isStale()) {
      currentPrice = coinbaseWS.getPrice(asset);
    }
    if (currentPrice == null) return null;

    // --- Open price ---
    const openPrice = await priceTracker.captureOpenPrice(laneId, tierConfig.interval);
    if (openPrice == null) return null;

    // --- Irrev & live direction ---
    const irrev = superScalp.calculateIrrev(asset, openPrice, currentPrice, remainingSeconds, totalSeconds);
    const liveDirection = currentPrice >= openPrice ? 'UP' : 'DOWN';

    // --- Observation phase ---
    const observationCutoff = totalSeconds - tierConfig.observationSeconds;
    if (remainingSeconds > observationCutoff) {
      if (!trendObserver.isObserving(laneId, windowTs)) {
        trendObserver.startObservation(laneId, windowTs, openPrice);
      }
      trendObserver.recordPrice(laneId, windowTs, currentPrice, Date.now());
      return null;
    }

    // --- Go signal check ---
    const trendResult = trendObserver.evaluate(laneId, windowTs, tierConfig, irrev);
    if (!trendResult || !trendResult.goSignal) {
      this._throttleLog(laneId, `[DCAEngine] ${laneId} waiting for go signal (irrev=${irrev.toFixed(2)})`);
      return null;
    }
    const committedDirection = trendResult.direction;

    // --- Lane state ---
    const stateKey = `${laneId}:${windowTs}`;
    let state = this.activeLanes.get(stateKey);
    if (!state) {
      state = {
        tier: tierConfig.id,
        laneId,
        windowTs,
        direction: committedDirection,
        positionId: null,
        lastEntryTime: 0,
        entryCount: 0,
        hedgeActive: false,
        hedgeDirection: null,
        reversalStartTime: null,
        paused: false,
      };
      this.activeLanes.set(stateKey, state);
    }

    // --- DCA entry timing ---
    const now = Date.now();
    if (state.lastEntryTime > 0 && now - state.lastEntryTime < tierConfig.entryIntervalSeconds * 1000) {
      return null;
    }

    // --- Trend pause check ---
    const pauseThreshold = tierConfig.irrevThreshold * 0.5;
    if (irrev < pauseThreshold) {
      if (!state.paused) {
        state.paused = true;
        this._throttleLog(laneId, `[DCAEngine] ${laneId} trend weakening (irrev=${irrev.toFixed(2)} < ${pauseThreshold.toFixed(2)}), pausing entries`);
      }
      return null;
    }
    if (state.paused) {
      state.paused = false;
      console.log(`[DCAEngine] ${laneId} trend recovered (irrev=${irrev.toFixed(2)}), resuming entries`);
    }

    // --- Price gate: orderbook ask ---
    const tokenId = committedDirection === 'UP'
      ? null // caller must resolve token from market discovery
      : null;
    // We need the market data to get the tokenId — caller provides via tierConfig or market lookup.
    // For now, use the direction to pick the right token from the position if it exists.
    let askPrice;
    try {
      // The position tracks which tokenId we're trading — but for the first entry
      // the caller should have set tierConfig._resolvedTokenId from market discovery.
      const resolvedTokenId = tierConfig._resolvedTokenId;
      if (!resolvedTokenId) {
        this._throttleLog(laneId, `[DCAEngine] ${laneId} no resolved tokenId, skipping`);
        return null;
      }
      askPrice = await orderExecutor.getOrderbookPrice(resolvedTokenId, 'buy');
    } catch (err) {
      this._throttleLog(laneId, `[DCAEngine] ${laneId} orderbook error: ${err.message}`);
      return null;
    }
    if (askPrice == null) {
      this._throttleLog(laneId, `[DCAEngine] ${laneId} no ask in orderbook`);
      return null;
    }

    // Price range check
    if (askPrice < tierConfig.priceRange.min || askPrice > tierConfig.priceRange.max) {
      this._throttleLog(laneId, `[DCAEngine] ${laneId} ask $${askPrice} outside range [${tierConfig.priceRange.min}-${tierConfig.priceRange.max}]`);
      return null;
    }

    // maxAskPrice cap from runtimeConfig
    const maxAsk = (global.runtimeConfig && global.runtimeConfig.maxAskPrice) || 0.92;
    if (askPrice > maxAsk) {
      this._throttleLog(laneId, `[DCAEngine] ${laneId} ask $${askPrice} exceeds maxAskPrice $${maxAsk}`);
      return null;
    }

    // --- Position check ---
    if (!state.positionId) {
      const position = positionManager.openPosition(tierConfig.id, laneId, windowTs, committedDirection);
      state.positionId = position.id || position.positionId;
    }

    if (!positionManager.canAddEntry(state.positionId, tierConfig)) {
      this._throttleLog(laneId, `[DCAEngine] ${laneId} max entries reached (${tierConfig.maxEntriesPerCandle})`);
      return null;
    }

    // --- Hedge evaluation ---
    if (tierConfig.hedgeEnabled && liveDirection !== state.direction) {
      // Price crossed back through open — potential reversal
      if (state.reversalStartTime == null) {
        state.reversalStartTime = now;
        return null; // Wait for sustained reversal
      }

      if (now - state.reversalStartTime >= tierConfig.hedgeReversalSeconds * 1000) {
        // Sustained reversal confirmed
        if (positionManager.canHedge(state.positionId, tierConfig)) {
          state.hedgeActive = true;
          state.hedgeDirection = liveDirection;
          state.lastEntryTime = now;
          state.entryCount++;

          const { shares, cost } = this._calculateSize(tierConfig, askPrice);
          if (shares < 1) return null;

          return {
            type: 'dca_hedge',
            tier: tierConfig.id,
            laneId,
            asset,
            direction: liveDirection,
            irrev,
            entryPrice: askPrice,
            shares,
            cost,
            minShares: 1,
            windowTs,
            isHedge: true,
            positionId: state.positionId,
          };
        }
      }
      return null;
    }

    // Price back to original direction — reset reversal timer
    if (liveDirection === state.direction && state.reversalStartTime != null) {
      state.reversalStartTime = null;
    }

    // --- Regular DCA entry ---
    const { shares, cost } = this._calculateSize(tierConfig, askPrice);
    if (shares < 1) {
      this._throttleLog(laneId, `[DCAEngine] ${laneId} calculated shares < 1, skipping`);
      return null;
    }

    state.lastEntryTime = now;
    state.entryCount++;

    return {
      type: 'dca',
      tier: tierConfig.id,
      laneId,
      asset,
      direction: committedDirection,
      irrev,
      entryPrice: askPrice,
      shares,
      cost,
      minShares: 1,
      windowTs,
      isHedge: false,
      positionId: state.positionId,
    };
  }

  /**
   * Calculate DCA entry size based on pool allocation.
   * Pool allocation = poolBalance * tierConfig.allocationPct
   * Per-candle max = allocation * 0.15
   * Per-entry size = per-candle max / maxEntriesPerCandle
   * Shares = floor(per-entry size / askPrice), min 1
   */
  _calculateSize(tierConfig, askPrice) {
    const poolBalance = db.getPoolBalance();
    const allocation = poolBalance * tierConfig.allocationPct;
    const effectiveMaxEntries = Math.min(tierConfig.maxEntriesPerCandle, 4);
    const perEntrySize = Math.max(allocation / effectiveMaxEntries, 2.00);
    const cappedSize = Math.min(perEntrySize, poolBalance * 0.25);
    const shares = Math.floor(cappedSize / askPrice);
    const cost = Math.round(shares * askPrice * 100) / 100;
    return { shares, cost };
  }

  /**
   * Clear lane state on window transition.
   */
  resetLane(laneId, windowTs) {
    const stateKey = `${laneId}:${windowTs}`;
    this.activeLanes.delete(stateKey);
    this._lastLogTime.delete(laneId);
  }

  /**
   * Get current state for a specific lane (dashboard display).
   */
  getActiveLaneState(laneId, windowTs) {
    return this.activeLanes.get(`${laneId}:${windowTs}`) || null;
  }

  /**
   * Get all active lane states.
   */
  getAllActiveStates() {
    const states = [];
    for (const state of this.activeLanes.values()) {
      states.push(state);
    }
    return states;
  }

  /**
   * Throttled logging — max once per 30 seconds per lane.
   */
  _throttleLog(laneId, message) {
    const now = Date.now();
    const lastLog = this._lastLogTime.get(laneId) || 0;
    if (now - lastLog >= 30000) {
      this._lastLogTime.set(laneId, now);
      console.log(message);
    }
  }
}

const dcaEngine = new DCAEngine();
module.exports = { DCAEngine, dcaEngine };
