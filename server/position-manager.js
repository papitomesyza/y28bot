const db = require('./db');

class PositionManager {
  /**
   * Open a new candle position or return existing one for this lane+window.
   */
  openPosition(tier, laneId, windowTs, direction) {
    const existing = db.getPosition(laneId, windowTs);
    if (existing) return existing;

    const id = db.createPosition({
      tier,
      lane_id: laneId,
      window_ts: windowTs,
      direction,
    });

    return db.getPositionById(id);
  }

  /**
   * Add an entry (dominant or hedge) to a position and update the trade record.
   */
  addEntry(positionId, entryPrice, shares, cost, tradeId, isHedge) {
    const pos = db.getPositionById(positionId);
    if (!pos) throw new Error(`Position ${positionId} not found`);

    const updates = {};

    if (!isHedge) {
      const newTotalShares = pos.total_shares + shares;
      const newTotalCost = pos.total_cost + cost;
      const newEntryCount = pos.entry_count + 1;
      const newAvg = newTotalCost / newTotalShares;

      updates.total_shares = newTotalShares;
      updates.total_cost = newTotalCost;
      updates.entry_count = newEntryCount;
      updates.avg_entry_price = Math.round(newAvg * 10000) / 10000;
    } else {
      updates.hedge_shares = pos.hedge_shares + shares;
      updates.hedge_cost = pos.hedge_cost + cost;
      updates.hedge_entry_count = pos.hedge_entry_count + 1;
    }

    const totalShares = updates.total_shares !== undefined ? updates.total_shares : pos.total_shares;
    const hedgeShares = updates.hedge_shares !== undefined ? updates.hedge_shares : pos.hedge_shares;
    updates.net_exposure = totalShares - hedgeShares;

    db.updatePosition(positionId, updates);

    // Link the trade to this position
    db.updateTrade(tradeId, { position_id: positionId, is_hedge: isHedge ? 1 : 0 });
  }

  /**
   * Get net exposure breakdown for a position.
   */
  getNetExposure(positionId) {
    const pos = db.getPositionById(positionId);
    if (!pos) throw new Error(`Position ${positionId} not found`);

    const netShares = pos.total_shares - pos.hedge_shares;
    const netCost = pos.total_cost - pos.hedge_cost;

    // If dominant side wins: dominant pays out $1/share, hedge side loses cost
    const projectedWinPnl = (pos.total_shares - pos.total_cost) - pos.hedge_cost;
    // If dominant side loses: hedge pays out $1/share, dominant loses cost
    const projectedLossPnl = (pos.hedge_shares - pos.hedge_cost) - pos.total_cost;

    return {
      direction: pos.direction,
      totalShares: pos.total_shares,
      hedgeShares: pos.hedge_shares,
      netShares,
      totalCost: pos.total_cost,
      hedgeCost: pos.hedge_cost,
      netCost,
      projectedPnl: { win: projectedWinPnl, loss: projectedLossPnl },
    };
  }

  /**
   * Resolve a position after candle closes.
   * wonSide is 'UP' or 'DOWN'.
   */
  resolvePosition(positionId, wonSide) {
    const pos = db.getPositionById(positionId);
    if (!pos) throw new Error(`Position ${positionId} not found`);

    let pnl;
    let result;

    if (pos.direction === wonSide) {
      // Dominant side won: dominant shares pay $1, hedge cost is lost
      pnl = (pos.total_shares - pos.total_cost) - pos.hedge_cost;
      result = 'won';
    } else {
      // Opposite side won: hedge shares pay $1, dominant cost is lost
      pnl = (pos.hedge_shares - pos.hedge_cost) - pos.total_cost;
      result = 'lost';
    }

    // Mixed result: lost overall but hedge recovered some
    if (result === 'lost' && pos.hedge_shares > 0 && pnl > -(pos.total_cost)) {
      result = 'mixed';
    }

    pnl = Math.round(pnl * 100) / 100;

    db.updatePosition(positionId, { result, pnl });

    return { result, pnl };
  }

  /**
   * Check if another dominant-side entry is allowed for this position.
   */
  canAddEntry(positionId, tierConfig) {
    const pos = db.getPositionById(positionId);
    if (!pos) return false;
    return pos.entry_count < tierConfig.maxEntriesPerCandle;
  }

  /**
   * Check if a hedge entry is allowed for this position.
   */
  canHedge(positionId, tierConfig) {
    if (!tierConfig.hedgeEnabled) return false;
    const pos = db.getPositionById(positionId);
    if (!pos) return false;
    return pos.hedge_shares < pos.total_shares * tierConfig.hedgeMaxPct;
  }

  /**
   * Get all active (unresolved) positions.
   */
  getAllActive() {
    return db.getActivePositions();
  }
}

module.exports = new PositionManager();
