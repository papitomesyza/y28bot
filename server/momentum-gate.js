const axios = require('axios');

const SUPPORTED_COINS = ['BTC', 'ETH'];
const EMA9_ALPHA = 2 / 10;   // 0.2
const EMA21_ALPHA = 2 / 22;  // ~0.0909
const RSI_PERIOD = 9;
const RSI_ALPHA = 1 / RSI_PERIOD;

class MomentumGate {
  constructor() {
    // Per-coin indicator state
    this.state = {};
    for (const coin of SUPPORTED_COINS) {
      this.state[coin] = {
        ema9: null,
        ema21: null,
        rsi: null,
        avgGain: null,
        avgLoss: null,
        initialized: false,
        blockedCount: 0,
      };
    }

    // VWAP state per coin
    this.vwap = {};
    for (const coin of SUPPORTED_COINS) {
      this.vwap[coin] = { sumPV: 0, sumV: 0, lastResetDate: null };
    }

    // Dry-run log throttle
    this._dryRunLogTime = new Map();

    // DB insert throttle per lane (prevent 10 rows/sec in sustained bearish regime)
    this._lastDbInsertTime = new Map();
  }

  async init() {
    const now = Math.floor(Date.now() / 1000);
    const start = now - 500 * 60; // 500 minutes ago

    // Reset VWAP date tracking
    const todayStr = new Date().toISOString().slice(0, 10);
    for (const coin of SUPPORTED_COINS) {
      this.vwap[coin].lastResetDate = todayStr;
    }

    for (const coin of SUPPORTED_COINS) {
      try {
        const url = `https://api.coinbase.com/api/v3/brokerage/market/products/${coin}-USD/candles?start=${start}&end=${now}&granularity=FIVE_MINUTE&limit=100`;
        const resp = await axios.get(url, { timeout: 15000 });
        const candles = resp.data.candles;
        if (!candles || candles.length === 0) {
          console.log(`[momentum-gate] No candles for ${coin}, defaulting to allow-all`);
          continue;
        }

        // Sort ascending by start
        candles.sort((a, b) => parseInt(a.start) - parseInt(b.start));

        // Discard last candle if it's in the current 5-minute window
        const currentWindowStart = now - (now % 300);
        const filtered = candles.filter(c => parseInt(c.start) < currentWindowStart);

        if (filtered.length < 21) {
          console.log(`[momentum-gate] Only ${filtered.length} candles for ${coin}, need 21+. Defaulting to allow-all`);
          continue;
        }

        const closes = filtered.map(c => parseFloat(c.close));
        this._bootstrapIndicators(coin, closes);
      } catch (err) {
        console.error(`[momentum-gate] Failed to fetch candles for ${coin}: ${err.message}. Defaulting to allow-all`);
      }
    }
  }

  _bootstrapIndicators(coin, closes) {
    const s = this.state[coin];

    // EMA(9): seed with SMA of first 9
    let ema9 = closes.slice(0, 9).reduce((a, b) => a + b, 0) / 9;
    for (let i = 9; i < closes.length; i++) {
      ema9 = (closes[i] - ema9) * EMA9_ALPHA + ema9;
    }
    s.ema9 = ema9;

    // EMA(21): seed with SMA of first 21
    let ema21 = closes.slice(0, 21).reduce((a, b) => a + b, 0) / 21;
    for (let i = 21; i < closes.length; i++) {
      ema21 = (closes[i] - ema21) * EMA21_ALPHA + ema21;
    }
    s.ema21 = ema21;

    // RSI(9): Wilder's smoothing
    const changes = [];
    for (let i = 1; i < closes.length; i++) {
      changes.push(closes[i] - closes[i - 1]);
    }

    let avgGain = 0;
    let avgLoss = 0;
    for (let i = 0; i < RSI_PERIOD; i++) {
      if (changes[i] > 0) avgGain += changes[i];
      else avgLoss += Math.abs(changes[i]);
    }
    avgGain /= RSI_PERIOD;
    avgLoss /= RSI_PERIOD;

    for (let i = RSI_PERIOD; i < changes.length; i++) {
      const gain = changes[i] > 0 ? changes[i] : 0;
      const loss = changes[i] < 0 ? Math.abs(changes[i]) : 0;
      avgGain = (avgGain * (RSI_PERIOD - 1) + gain) / RSI_PERIOD;
      avgLoss = (avgLoss * (RSI_PERIOD - 1) + loss) / RSI_PERIOD;
    }

    s.avgGain = avgGain;
    s.avgLoss = avgLoss;

    if (avgLoss === 0) {
      s.rsi = 100;
    } else {
      const rs = avgGain / avgLoss;
      s.rsi = 100 - (100 / (1 + rs));
    }

    s.initialized = true;
    console.log(`[momentum-gate] Bootstrapped ${coin}: ${closes.length} candles, EMA9=${ema9.toFixed(2)} EMA21=${ema21.toFixed(2)} RSI=${s.rsi.toFixed(2)}`);
  }

  onCandleClose(asset, closePrice) {
    if (!SUPPORTED_COINS.includes(asset)) return;
    const s = this.state[asset];
    if (!s.initialized) return;

    // Update EMA(9)
    s.ema9 = (closePrice - s.ema9) * EMA9_ALPHA + s.ema9;

    // Update EMA(21)
    s.ema21 = (closePrice - s.ema21) * EMA21_ALPHA + s.ema21;

    // Update RSI(9) with Wilder's smoothing
    const prevClose = s._lastClose != null ? s._lastClose : closePrice;
    const change = closePrice - prevClose;
    const gain = change > 0 ? change : 0;
    const loss = change < 0 ? Math.abs(change) : 0;

    s.avgGain = (s.avgGain * (RSI_PERIOD - 1) + gain) / RSI_PERIOD;
    s.avgLoss = (s.avgLoss * (RSI_PERIOD - 1) + loss) / RSI_PERIOD;

    if (s.avgLoss === 0) {
      s.rsi = 100;
    } else {
      const rs = s.avgGain / s.avgLoss;
      s.rsi = 100 - (100 / (1 + rs));
    }

    s._lastClose = closePrice;
  }

  recordTrade(asset, price, size) {
    if (!SUPPORTED_COINS.includes(asset)) return;

    // Daily VWAP reset
    const todayStr = new Date().toISOString().slice(0, 10);
    if (this.vwap[asset].lastResetDate !== todayStr) {
      this.vwap[asset].sumPV = 0;
      this.vwap[asset].sumV = 0;
      this.vwap[asset].lastResetDate = todayStr;

      // Reset blocked counts
      this.state[asset].blockedCount = 0;

      // Only log once per coin per day
      if (asset === SUPPORTED_COINS[0]) {
        console.log('[momentum-gate] VWAP reset for daily session');
      }
    }

    this.vwap[asset].sumPV += price * size;
    this.vwap[asset].sumV += size;
  }

  _getVwap(asset) {
    const v = this.vwap[asset];
    if (!v || v.sumV === 0) return null;
    return v.sumPV / v.sumV;
  }

  _isVwapStable() {
    // Unstable in first 30 minutes after midnight UTC
    const now = new Date();
    const minutesSinceMidnight = now.getUTCHours() * 60 + now.getUTCMinutes();
    return minutesSinceMidnight >= 30;
  }

  isDirectionAllowed(asset, direction, laneId) {
    // Always allow DOWN — never block bearish trades
    if (direction === 'DOWN') {
      return { allowed: true, reason: 'DOWN always allowed', indicators: { vwap: 'n/a', ema: 'n/a', rsi: 0, vote: 'pass' } };
    }

    const s = this.state[asset];
    if (!s.initialized) {
      return { allowed: true, reason: 'gate not initialized', indicators: { vwap: 'n/a', ema: 'n/a', rsi: 0, vote: 'pass' } };
    }

    // Get current price for VWAP comparison
    let currentPrice = null;
    try {
      const { coinbaseWS } = require('./coinbase-ws');
      currentPrice = coinbaseWS.getPrice(asset);
    } catch (_) {}

    // Count bearish votes
    let bearishVotes = 0;
    const indicators = { vwap: 'neutral', ema: 'neutral', rsi: s.rsi != null ? parseFloat(s.rsi.toFixed(1)) : 0, vote: 'allow' };

    // VWAP vote
    const vwap = this._getVwap(asset);
    if (vwap != null && currentPrice != null && this._isVwapStable()) {
      if (currentPrice < vwap) {
        indicators.vwap = 'below';
        bearishVotes++;
      } else if (currentPrice > vwap) {
        indicators.vwap = 'above';
      }
    } else {
      indicators.vwap = 'neutral';
    }

    // EMA vote
    if (s.ema9 != null && s.ema21 != null) {
      if (s.ema9 < s.ema21) {
        indicators.ema = 'bearish';
        bearishVotes++;
      } else {
        indicators.ema = 'bullish';
      }
    }

    // RSI vote
    if (s.rsi != null) {
      if (s.rsi < 45) {
        bearishVotes++;
      }
      // rsi > 55 is bullish, 45-55 neutral — neither adds bearish vote
    }

    // ASYMMETRIC: block UP only when 2+ bearish votes
    if (bearishVotes >= 2) {
      const reason = `bearish regime (VWAP: ${indicators.vwap}, EMA: ${indicators.ema}, RSI: ${indicators.rsi})`;
      indicators.vote = 'blocked';
      s.blockedCount++;

      const gateEnabled = global.runtimeConfig && global.runtimeConfig.gateEnabled === true;

      // Persist block decision to DB (throttled: max 1 insert per lane per 60s)
      const dbThrottleKey = laneId || asset;
      const lastDbInsert = this._lastDbInsertTime.get(dbThrottleKey) || 0;
      if (Date.now() - lastDbInsert >= 60000) {
        this._lastDbInsertTime.set(dbThrottleKey, Date.now());
        try {
          const db = require('./db');
          db.getDb().prepare(
            `INSERT INTO gate_decisions (asset, lane_id, direction, allowed, gate_enabled, vwap, current_price, ema9, ema21, rsi, vote, reason)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
          ).run(
            asset,
            laneId || null,
            direction,
            gateEnabled ? 0 : 1,
            gateEnabled ? 1 : 0,
            vwap,
            currentPrice,
            s.ema9,
            s.ema21,
            s.rsi != null ? parseFloat(s.rsi.toFixed(1)) : null,
            indicators.vote,
            reason
          );
        } catch (_) {}
      }

      // Check if gate is disabled — dry run mode
      if (!gateEnabled) {
        // Dry-run: log throttled to 30s per lane
        return { allowed: true, reason: `gate disabled (would block: ${reason})`, indicators };
      }

      return { allowed: false, reason, indicators };
    }

    indicators.vote = 'allow';

    // Gate disabled — early return with allowed: true already handled above for blocks
    if (global.runtimeConfig && global.runtimeConfig.gateEnabled === false) {
      return { allowed: true, reason: 'gate disabled', indicators };
    }

    return { allowed: true, reason: 'trend aligned or neutral', indicators };
  }

  getState() {
    const result = {};
    for (const coin of SUPPORTED_COINS) {
      const s = this.state[coin];
      const vwap = this._getVwap(coin);
      let currentPrice = null;
      try {
        const { coinbaseWS } = require('./coinbase-ws');
        currentPrice = coinbaseWS.getPrice(coin);
      } catch (_) {}

      result[coin] = {
        ema9: s.ema9 != null ? parseFloat(s.ema9.toFixed(2)) : null,
        ema21: s.ema21 != null ? parseFloat(s.ema21.toFixed(2)) : null,
        rsi: s.rsi != null ? parseFloat(s.rsi.toFixed(1)) : null,
        vwap: vwap != null ? parseFloat(vwap.toFixed(2)) : null,
        currentPrice,
        vote: this._getVote(coin),
        blockedCount: s.blockedCount,
        initialized: s.initialized,
      };
    }

    result.gateEnabled = global.runtimeConfig ? global.runtimeConfig.gateEnabled : false;
    return result;
  }

  _getVote(coin) {
    const s = this.state[coin];
    if (!s.initialized) return 'not ready';

    let bullish = 0;
    let bearish = 0;

    // VWAP
    const vwap = this._getVwap(coin);
    let currentPrice = null;
    try {
      const { coinbaseWS } = require('./coinbase-ws');
      currentPrice = coinbaseWS.getPrice(coin);
    } catch (_) {}

    if (vwap != null && currentPrice != null && this._isVwapStable()) {
      if (currentPrice > vwap) bullish++;
      else if (currentPrice < vwap) bearish++;
    }

    // EMA
    if (s.ema9 != null && s.ema21 != null) {
      if (s.ema9 > s.ema21) bullish++;
      else if (s.ema9 < s.ema21) bearish++;
    }

    // RSI
    if (s.rsi != null) {
      if (s.rsi > 55) bullish++;
      else if (s.rsi < 45) bearish++;
    }

    if (bearish >= 2) return 'bearish';
    if (bullish >= 2) return 'bullish';
    return 'neutral';
  }
}

const momentumGate = new MomentumGate();

module.exports = { MomentumGate, momentumGate };
