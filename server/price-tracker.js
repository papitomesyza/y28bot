const config = require('./config');
const { coinbaseWS } = require('./coinbase-ws');
const { captureChainlinkOpen } = require('./chainlink');
const { polymarketRTDS } = require('./polymarket-ws');

const CLEANUP_INTERVAL_MS = 5 * 60 * 1000;
const MAX_WINDOW_AGE_MS = 30 * 60 * 1000;

class PriceTracker {
  constructor() {
    this.windows = new Map();
    this._cleanupTimer = setInterval(() => this.cleanup(), CLEANUP_INTERVAL_MS);
  }

  getWindowTs(interval) {
    const now = Math.floor(Date.now() / 1000);
    const intervalSec = interval * 60;
    return now - (now % intervalSec);
  }

  getWindowEnd(interval) {
    return this.getWindowTs(interval) + interval * 60;
  }

  getRemainingSeconds(interval) {
    const now = Math.floor(Date.now() / 1000);
    return this.getWindowEnd(interval) - now;
  }

  async captureOpenPrice(laneId, interval) {
    const asset = laneId.split('-')[0];
    const windowTs = this.getWindowTs(interval);
    const key = `${laneId}:${windowTs}`;

    let win = this.windows.get(key);
    if (!win) {
      win = { openPrice: null, closePrice: null, capturedOpen: false, capturedClose: false };
      this.windows.set(key, win);
    }

    if (win.capturedOpen) return win.openPrice;

    // Priority 1: Polymarket RTDS (exact Chainlink Data Streams price — resolution source)
    const rtdsPrice = polymarketRTDS.getPrice(asset);
    if (rtdsPrice != null && !polymarketRTDS.isStale()) {
      win.openPrice = rtdsPrice;
      win.capturedOpen = true;
      console.log(`[price] Open price for ${laneId}: $${rtdsPrice} (source: polymarket-rtds)`);
      return win.openPrice;
    }

    if (polymarketRTDS.isStale()) {
      console.log(`[price] RTDS stale — using Coinbase for ${laneId} open price`);
    }

    // Priority 2: Coinbase (when RTDS stale or unavailable)
    const coinbasePrice = coinbaseWS.getPrice(asset);
    if (coinbasePrice != null) {
      win.openPrice = coinbasePrice;
      win.capturedOpen = true;
      console.log(`[price] Open price for ${laneId}: $${coinbasePrice} (source: coinbase-fallback)`);
      return win.openPrice;
    }

    // Priority 3: Chainlink on-chain Price Feed (last resort)
    const chainlinkPrice = await captureChainlinkOpen(asset);
    if (chainlinkPrice != null) {
      win.openPrice = chainlinkPrice;
      win.capturedOpen = true;
      console.log(`[price] Open price for ${laneId}: $${chainlinkPrice} (source: chainlink-fallback)`);
      return win.openPrice;
    }

    return null;
  }

  captureClosePrice(laneId, interval) {
    const asset = laneId.split('-')[0];
    const windowTs = this.getWindowTs(interval);
    const key = `${laneId}:${windowTs}`;

    let win = this.windows.get(key);
    if (!win) {
      win = { openPrice: null, closePrice: null, capturedOpen: false, capturedClose: false };
      this.windows.set(key, win);
    }

    if (win.capturedClose) return win.closePrice;

    const remaining = this.getRemainingSeconds(interval);
    if (remaining > 1) return null;

    const price = coinbaseWS.getPrice(asset);
    if (price == null) return null;

    win.closePrice = price;
    win.capturedClose = true;
    return win.closePrice;
  }

  getWindow(laneId, windowTs) {
    const key = `${laneId}:${windowTs}`;
    return this.windows.get(key) || null;
  }

  cleanup() {
    const cutoff = Math.floor(Date.now() / 1000) - MAX_WINDOW_AGE_MS / 1000;
    for (const key of this.windows.keys()) {
      const ts = parseInt(key.split(':')[1], 10);
      if (ts < cutoff) {
        this.windows.delete(key);
      }
    }
  }

  close() {
    clearInterval(this._cleanupTimer);
  }
}

const priceTracker = new PriceTracker();

module.exports = { PriceTracker, priceTracker };
