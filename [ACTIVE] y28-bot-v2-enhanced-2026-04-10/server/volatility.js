const config = require('./config');

const MAX_TICKS = 300;
const MIN_TICKS = 20;

const DEFAULT_VOLATILITY = {
  BTC: 0.50,
  ETH: 0.60,

  XRP: 0.80,
  HYPE: 0.90,
};

class VolatilityTracker {
  constructor() {
    this.ticks = new Map();
    for (const asset of config.assets) {
      this.ticks.set(asset, []);
    }
  }

  recordTick(asset, price) {
    let arr = this.ticks.get(asset);
    if (!arr) {
      arr = [];
      this.ticks.set(asset, arr);
    }
    arr.push({ price, timestamp: Date.now() });
    if (arr.length > MAX_TICKS) {
      arr.splice(0, arr.length - MAX_TICKS);
    }
  }

  getVolatility(asset) {
    const arr = this.ticks.get(asset);
    if (!arr || arr.length < MIN_TICKS) {
      return DEFAULT_VOLATILITY[asset] || 0.60;
    }
    return this._calculate(arr);
  }

  getShortTermVolatility(asset, seconds) {
    const arr = this.ticks.get(asset);
    if (!arr) return null;

    const cutoff = Date.now() - seconds * 1000;
    const recent = arr.filter(t => t.timestamp >= cutoff);

    if (recent.length < MIN_TICKS) return null;
    return this._calculate(recent);
  }

  _calculate(ticks) {
    const logReturns = [];
    for (let i = 1; i < ticks.length; i++) {
      logReturns.push(Math.log(ticks[i].price / ticks[i - 1].price));
    }

    if (logReturns.length < 2) return null;

    // Standard deviation of log returns
    const mean = logReturns.reduce((s, v) => s + v, 0) / logReturns.length;
    const variance = logReturns.reduce((s, v) => s + (v - mean) ** 2, 0) / (logReturns.length - 1);
    const stdDev = Math.sqrt(variance);

    // Annualize: estimate ticks per year from average interval
    const totalTimeMs = ticks[ticks.length - 1].timestamp - ticks[0].timestamp;
    const avgIntervalMs = totalTimeMs / (ticks.length - 1);
    if (avgIntervalMs <= 0) return stdDev;

    const msPerYear = 365.25 * 24 * 60 * 60 * 1000;
    const ticksPerYear = msPerYear / avgIntervalMs;

    return stdDev * Math.sqrt(ticksPerYear);
  }
}

const volatilityTracker = new VolatilityTracker();

module.exports = { VolatilityTracker, volatilityTracker };
