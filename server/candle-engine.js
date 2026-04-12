const config = require('./config');
const db = require('./db');
const { priceTracker } = require('./price-tracker');

const MAX_CANDLES_PER_LANE = 20;

class CandleEngine {
  constructor() {
    this.candles = new Map();
    this.liveBuffers = new Map();
    this._resolvedSet = new Set();
    this.tradeEntries = new Map();
  }

  recordTick(laneId, price, timestamp) {
    const parts = laneId.split('-');
    const rawInterval = parts[1];
    let interval;
    if (rawInterval.endsWith('H')) {
      interval = parseInt(rawInterval, 10) * 60;
    } else if (rawInterval.endsWith('M')) {
      interval = parseInt(rawInterval, 10);
    } else {
      interval = parseInt(rawInterval, 10);
    }
    const windowTs = priceTracker.getWindowTs(interval);

    let buf = this.liveBuffers.get(laneId);

    if (buf && buf.windowTs !== windowTs) {
      const completed = {
        windowTs: buf.windowTs,
        open: buf.open,
        high: buf.high,
        low: buf.low,
        close: buf.latest,
        direction: buf.latest >= buf.open ? 'UP' : 'DOWN',
        resolved: false,
        resolvedDirection: null,
        tradeEntries: this.tradeEntries.get(`${laneId}:${buf.windowTs}`) || [],
      };

      let arr = this.candles.get(laneId);
      if (!arr) {
        arr = [];
        this.candles.set(laneId, arr);
      }
      arr.push(completed);
      if (arr.length > MAX_CANDLES_PER_LANE) {
        arr.splice(0, arr.length - MAX_CANDLES_PER_LANE);
      }

      buf = null;
    }

    if (!buf) {
      buf = { windowTs, open: price, high: price, low: price, latest: price };
      this.liveBuffers.set(laneId, buf);
      return;
    }

    if (price > buf.high) buf.high = price;
    if (price < buf.low) buf.low = price;
    buf.latest = price;
  }

  markTradeEntry(laneId, windowTs, tradeId, price, timestamp) {
    const key = `${laneId}:${windowTs}`;
    let entries = this.tradeEntries.get(key);
    if (!entries) {
      entries = [];
      this.tradeEntries.set(key, entries);
    }
    entries.push({ tradeId, price, timestamp });
    console.log(`[candles] Marked trade #${tradeId} entry on ${laneId} window ${windowTs} @ $${price}`);
  }

  markResolved(laneId, windowTs, resolvedDirection) {
    const dedupKey = `${laneId}:${windowTs}`;
    if (this._resolvedSet.has(dedupKey)) return;
    this._resolvedSet.add(dedupKey);

    if (this._resolvedSet.size > 200) {
      const entries = [...this._resolvedSet];
      this._resolvedSet = new Set(entries.slice(-100));
    }

    const arr = this.candles.get(laneId);
    if (!arr) return;

    const candle = arr.find(c => c.windowTs === windowTs);
    if (!candle) return;

    candle.resolved = true;
    candle.resolvedDirection = resolvedDirection;

    const isFlip = candle.direction !== resolvedDirection;
    db.recordLaneResolution(laneId, isFlip);

    console.log(`[candles] ${laneId} window ${windowTs} resolved ${resolvedDirection}, candle was ${candle.direction} → ${isFlip ? 'FLIP' : 'HELD'}`);
  }

  getCompletedCandles(laneId, count = 5) {
    const arr = this.candles.get(laneId);
    if (!arr || arr.length === 0) return [];
    return arr.slice(-count);
  }

  getLiveCandle(laneId) {
    const buf = this.liveBuffers.get(laneId);
    if (!buf) return null;
    return {
      windowTs: buf.windowTs,
      open: buf.open,
      high: buf.high,
      low: buf.low,
      current: buf.latest,
      direction: buf.latest >= buf.open ? 'UP' : 'DOWN',
      tradeEntries: this.tradeEntries.get(`${laneId}:${buf.windowTs}`) || [],
    };
  }

  getLiveCandleWithTimer(laneId) {
    const live = this.getLiveCandle(laneId);
    if (!live) return null;
    const rawInt = laneId.split('-')[1];
    const interval = rawInt.endsWith('H') ? parseInt(rawInt, 10) * 60 : parseInt(rawInt, 10);
    live.remainingSeconds = priceTracker.getRemainingSeconds(interval);
    return live;
  }

  getFlipRate(laneId, days = 7) {
    const rows = db.getLaneReliability(laneId, days);
    if (!rows || rows.length === 0) {
      return { flipRate: 0, observed: 0, flipped: 0, days: 0 };
    }
    let totalObserved = 0;
    let totalFlipped = 0;
    for (const row of rows) {
      totalObserved += row.observed;
      totalFlipped += row.flipped;
    }
    return {
      flipRate: totalObserved > 0 ? totalFlipped / totalObserved : 0,
      observed: totalObserved,
      flipped: totalFlipped,
      days: rows.length,
    };
  }

  getActiveCandles() {
    const result = {};
    for (const lane of config.lanes) {
      result[lane.id] = {
        live: this.getLiveCandleWithTimer(lane.id),
        completed: this.getCompletedCandles(lane.id, 5),
        reliability: this.getFlipRate(lane.id, 7),
      };
    }
    return result;
  }

  resetLane(laneId) {
    this.liveBuffers.delete(laneId);
  }
}

const candleEngine = new CandleEngine();
module.exports = { CandleEngine, candleEngine };
