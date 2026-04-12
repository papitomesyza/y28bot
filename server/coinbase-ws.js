const WebSocket = require('ws');
const config = require('./config');
const { volatilityTracker } = require('./volatility');

const WS_URL = 'wss://advanced-trade-ws.coinbase.com';
const ALL_ASSETS = config.assets;
const PRODUCT_IDS = ALL_ASSETS.map(a => `${a}-USD`);
const RECONNECT_DELAY_MS = 3000;
const MAX_RECONNECT_ATTEMPTS = 50;
const LOG_THROTTLE_MS = 30000;

class CoinbaseWS {
  constructor() {
    this.prices = {};
    this.ws = null;
    this.reconnectAttempts = 0;
    this.lastLogTime = 0;
    this.closed = false;
  }

  connect() {
    this.closed = false;
    this.ws = new WebSocket(WS_URL);

    this.ws.on('open', () => {
      console.log('[ws] Connected to Coinbase');
      this.reconnectAttempts = 0;

      const subscribe = {
        type: 'subscribe',
        product_ids: PRODUCT_IDS,
        channel: 'ticker',
      };
      this.ws.send(JSON.stringify(subscribe));

      const subscribeTrades = {
        type: 'subscribe',
        product_ids: PRODUCT_IDS,
        channel: 'market_trades',
      };
      this.ws.send(JSON.stringify(subscribeTrades));
    });

    this.ws.on('message', (raw) => {
      try {
        const data = JSON.parse(raw);

        // Market trades channel — feed momentum gate VWAP
        if (data.channel === 'market_trades' && data.events) {
          for (const event of data.events) {
            if (!event.trades) continue;
            for (const trade of event.trades) {
              const asset = trade.product_id ? trade.product_id.split('-')[0] : null;
              const price = parseFloat(trade.price);
              const size = parseFloat(trade.size);
              if (asset && !isNaN(price) && !isNaN(size)) {
                try {
                  const { momentumGate } = require('./momentum-gate');
                  momentumGate.recordTrade(asset, price, size);
                } catch (err) {}
              }
            }
          }
          return;
        }

        if (data.channel !== 'ticker' || !data.events) return;

        for (const event of data.events) {
          if (!event.tickers) continue;
          for (const ticker of event.tickers) {
            const productId = ticker.product_id;
            const price = parseFloat(ticker.price);
            if (!productId || isNaN(price)) continue;

            const asset = productId.split('-')[0];
            this.prices[asset] = price;
            volatilityTracker.recordTick(asset, price);

            try {
              const { candleEngine } = require('./candle-engine');
              for (const lane of config.lanes) {
                if (lane.asset === asset) {
                  candleEngine.recordTick(lane.id, price, Date.now());
                }
              }
            } catch (err) {
              // Candle engine not ready yet during startup — safe to ignore
            }
          }
        }

        this._throttledLog();
      } catch (err) {
        console.error('[ws] Message parse error:', err.message);
      }
    });

    this.ws.on('close', () => {
      console.log('[ws] Connection closed');
      this._reconnect();
    });

    this.ws.on('error', (err) => {
      console.error('[ws] Error:', err.message);
      // 'close' event fires after 'error', so reconnect happens there
    });
  }

  _throttledLog() {
    const now = Date.now();
    if (now - this.lastLogTime < LOG_THROTTLE_MS) return;
    this.lastLogTime = now;

    const parts = ALL_ASSETS
      .map(a => `${a}=${this.prices[a] != null ? this.prices[a] : '—'}`)
      .join(' ');
    console.log(`[ws] Price update: ${parts}`);
  }

  _reconnect() {
    if (this.closed) return;

    this.reconnectAttempts++;
    if (this.reconnectAttempts > MAX_RECONNECT_ATTEMPTS) {
      console.error(`[ws] FATAL: Max reconnect attempts (${MAX_RECONNECT_ATTEMPTS}) reached. Giving up.`);
      return;
    }

    console.log(`[ws] Reconnecting in ${RECONNECT_DELAY_MS / 1000}s (attempt ${this.reconnectAttempts}/${MAX_RECONNECT_ATTEMPTS})...`);
    setTimeout(() => this.connect(), RECONNECT_DELAY_MS);
  }

  getPrice(asset) {
    return this.prices[asset] != null ? this.prices[asset] : null;
  }

  close() {
    this.closed = true;
    if (this.ws) {
      this.ws.close();
      this.ws = null;
    }
  }
}

const coinbaseWS = new CoinbaseWS();

module.exports = { CoinbaseWS, coinbaseWS };
