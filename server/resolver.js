const db = require('./db');
const { priceTracker } = require('./price-tracker');
const { coinbaseWS } = require('./coinbase-ws');
const { getChainlinkPrice } = require('./chainlink');
const { polymarketRTDS } = require('./polymarket-ws');
const positionManager = require('./position-manager');

const CLEANUP_AGE_MS = 60 * 60 * 1000; // 1 hour
const PENDING_CHECK_INTERVAL_MS = 60 * 1000; // 1 minute
const EXPIRY_AGE_S = 15 * 60; // 15 minutes in seconds

class Resolver {
  constructor() {
    this.processedWindows = new Set();
    this._pendingTimer = null;
  }

  async resolveWindow(laneId, windowTs, interval) {
    const key = `${laneId}:${windowTs}`;
    if (this.processedWindows.has(key)) return;

    const win = priceTracker.getWindow(laneId, windowTs);

    if (!win || win.openPrice == null) {
      console.log(`[resolver] ${laneId} window ${windowTs} missing open price — skipping`);
      return;
    }

    // Get close price for display/logging only — win/loss comes from Data API oracle
    const asset = laneId.split('-')[0];
    let closePrice = null;
    let source = null;

    const rtdsPrice = polymarketRTDS.getPrice(asset);
    if (rtdsPrice != null && !polymarketRTDS.isStale()) {
      closePrice = rtdsPrice;
      source = 'polymarket-rtds';
    } else {
      if (polymarketRTDS.isStale()) {
        console.log(`[resolver] RTDS stale — using Coinbase for ${laneId} close price`);
      }
      const coinbasePrice = coinbaseWS.getPrice(asset);
      if (coinbasePrice != null) {
        closePrice = coinbasePrice;
        source = 'coinbase-fallback';
      } else {
        const chainlinkPrice = await getChainlinkPrice(asset);
        if (chainlinkPrice != null) {
          closePrice = chainlinkPrice;
          source = 'chainlink-fallback';
        } else {
          closePrice = win.closePrice;
          source = 'window-fallback';
        }
      }
    }

    if (closePrice != null) {
      console.log(`[resolver] ${laneId} close price: $${closePrice} (source: ${source})`);

      // Record close price on pending trades for display — do NOT determine win/loss
      const trades = db.getTrades({ lane_id: laneId, window_start: windowTs, result: 'pending' });
      for (const trade of trades) {
        db.updateTrade(trade.id, { close_price: closePrice });
      }
    } else {
      console.log(`[resolver] ${laneId} window ${windowTs} missing close price`);
    }

    this.processedWindows.add(key);
    this._cleanupProcessedWindows();
  }

  _cleanupProcessedWindows() {
    const cutoff = Math.floor(Date.now() / 1000) - CLEANUP_AGE_MS / 1000;
    for (const key of this.processedWindows) {
      const ts = parseInt(key.split(':')[1], 10);
      if (ts < cutoff) {
        this.processedWindows.delete(key);
      }
    }
  }

  resolvePending() {
    const pendingTrades = db.getTrades({ result: 'pending' });
    if (pendingTrades.length > 0) {
      console.log(`[resolver] ${pendingTrades.length} pending trade(s) awaiting oracle resolution`);
    }

    // Expire very old pending trades (>15 min past window end with no oracle resolution)
    const nowS = Math.floor(Date.now() / 1000);
    for (const trade of pendingTrades) {
      if (!trade.window_start || !trade.lane_id) continue;
      const windowEnd = trade.window_start + (trade.lane_id.includes('15M') ? 900 : 300);
      if (nowS - windowEnd > EXPIRY_AGE_S) {
        db.updateTrade(trade.id, {
          result: 'expired',
          pnl: 0,
          close_price: null,
        });
        console.log(`[resolver] Trade #${trade.id} (${trade.lane_id}) expired — no oracle resolution after ${EXPIRY_AGE_S / 60} min`);
      }
    }

    // Bridge: resolve candle_positions once all their trades are settled
    this.resolvePositions();
  }

  /**
   * Position resolution bridge.
   * Checks active candle_positions — if ALL trades for a position are resolved
   * (won/lost/expired), aggregates the result via positionManager.resolvePosition().
   */
  resolvePositions() {
    try {
      const activePositions = db.getActivePositions();
      if (activePositions.length === 0) return;

      for (const pos of activePositions) {
        // Get all trades linked to this position
        const trades = db.getTrades({ position_id: pos.id });
        if (trades.length === 0) continue;

        // Check if all trades are settled (no pending ones left)
        const hasPending = trades.some(t => t.result === 'pending');
        if (hasPending) continue;

        // Determine winning side from dominant-side trades (non-hedge)
        const dominantTrades = trades.filter(t => !t.is_hedge);
        if (dominantTrades.length === 0) continue;

        // If any dominant trade won, the dominant direction won.
        // If all dominant trades lost/expired, the opposite direction won.
        const anyDominantWon = dominantTrades.some(t => t.result === 'won');
        const wonSide = anyDominantWon ? pos.direction : (pos.direction === 'UP' ? 'DOWN' : 'UP');

        const { result, pnl } = positionManager.resolvePosition(pos.id, wonSide);
        console.log(`[resolver] Position #${pos.id} (${pos.lane_id}) resolved: ${result} pnl=$${pnl.toFixed(2)}`);
      }
    } catch (err) {
      console.error('[resolver] resolvePositions error:', err.message);
    }
  }

  start() {
    this._pendingTimer = setInterval(() => this.resolvePending(), PENDING_CHECK_INTERVAL_MS);
    console.log('[resolver] Pending trade scanner started (60s interval)');
  }

  close() {
    if (this._pendingTimer) {
      clearInterval(this._pendingTimer);
      this._pendingTimer = null;
    }
  }
}

const resolver = new Resolver();

module.exports = { Resolver, resolver };
