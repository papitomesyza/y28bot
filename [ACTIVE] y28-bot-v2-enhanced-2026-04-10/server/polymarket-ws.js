const WebSocket = require('ws');

const WS_URL = 'wss://ws-live-data.polymarket.com';
const RECONNECT_DELAY_MS = 3000;
const MAX_RECONNECT_ATTEMPTS = 50;
const PING_INTERVAL_MS = 5000;
const LOG_THROTTLE_MS = 30000;
const STALE_THRESHOLD_MS = 60000;
const STALE_CHECK_INTERVAL_MS = 30000;
const SYMBOL_MAP = { 'btc/usd': 'BTC', 'eth/usd': 'ETH', 'xrp/usd': 'XRP', 'hype/usd': 'HYPE' };

class PolymarketRTDS {
  constructor() {
    this.ws = null;
    this.prices = { BTC: null, ETH: null, XRP: null, HYPE: null };
    this.connected = false;
    this.reconnectAttempts = 0;
    this.closed = false;
    this.lastLogTime = 0;
    this.lastUpdateTime = 0;
    this._pingInterval = null;
    this._staleInterval = null;
  }

  connect() {
    this.closed = false;
    this.ws = new WebSocket(WS_URL);

    this.ws.on('open', () => {
      console.log('[polymarket-ws] Connected to Polymarket RTDS');
      this.connected = true;
      this.reconnectAttempts = 0;

      const subscribe = {
        action: 'subscribe',
        subscriptions: [
          { topic: 'crypto_prices_chainlink', type: 'update' }
        ]
      };
      this.ws.send(JSON.stringify(subscribe));

      // Keep-alive ping
      this._pingInterval = setInterval(() => {
        if (this.ws && this.ws.readyState === WebSocket.OPEN) {
          this.ws.send(JSON.stringify('PING'));
        }
      }, PING_INTERVAL_MS);

      // Staleness detection — force reconnect if no data in 60s
      this._clearStaleCheck();
      this._staleInterval = setInterval(() => {
        if (this.isStale()) {
          console.log('[polymarket-ws] RTDS STALE — no update in 60s, forcing reconnect');
          this._clearPing();
          this._clearStaleCheck();
          if (this.ws) {
            this.ws.close();
          }
        }
      }, STALE_CHECK_INTERVAL_MS);
    });

    this.ws.on('message', (raw) => {
      const str = String(raw).trim();
      if (!str.startsWith('{') && !str.startsWith('[')) return;

      try {
        const data = JSON.parse(str);

        if (data.topic === 'crypto_prices_chainlink' && data.type === 'update') {
          const symbol = data.payload && data.payload.symbol;
          const value = data.payload && data.payload.value;
          if (symbol && value != null) {
            const asset = SYMBOL_MAP[symbol.toLowerCase()];
            if (asset) {
              this.prices[asset] = parseFloat(value);
              this.lastUpdateTime = Date.now();

              try {
                const { candleEngine } = require('./candle-engine');
                const config = require('./config');
                for (const lane of config.lanes) {
                  if (lane.asset === asset) {
                    candleEngine.recordTick(lane.id, parseFloat(value), Date.now());
                  }
                }
              } catch (err) {
                // Candle engine not ready yet during startup — safe to ignore
              }
            }
          }

          // Throttled log
          const now = Date.now();
          if (now - this.lastLogTime >= LOG_THROTTLE_MS) {
            this.lastLogTime = now;
            const parts = Object.entries(this.prices)
              .map(([a, p]) => `${a}=$${p != null ? p : '—'}`)
              .join(' ');
            console.log(`[polymarket-ws] Chainlink stream: ${parts}`);
          }
        }
      } catch (err) {
        console.error('[polymarket-ws] Message parse error:', err.message);
      }
    });

    this.ws.on('close', () => {
      console.log('[polymarket-ws] Connection closed');
      this.connected = false;
      this._clearPing();
      this._reconnect();
    });

    this.ws.on('error', (err) => {
      console.error('[polymarket-ws] Error:', err.message);
    });
  }

  isStale() {
    return this.lastUpdateTime > 0 && (Date.now() - this.lastUpdateTime > STALE_THRESHOLD_MS);
  }

  _clearPing() {
    if (this._pingInterval) {
      clearInterval(this._pingInterval);
      this._pingInterval = null;
    }
  }

  _clearStaleCheck() {
    if (this._staleInterval) {
      clearInterval(this._staleInterval);
      this._staleInterval = null;
    }
  }

  _reconnect() {
    if (this.closed) return;

    this.reconnectAttempts++;
    if (this.reconnectAttempts > MAX_RECONNECT_ATTEMPTS) {
      console.error(`[polymarket-ws] FATAL: Max reconnect attempts (${MAX_RECONNECT_ATTEMPTS}) reached. Giving up.`);
      return;
    }

    console.log(`[polymarket-ws] Reconnecting in ${RECONNECT_DELAY_MS / 1000}s (attempt ${this.reconnectAttempts}/${MAX_RECONNECT_ATTEMPTS})...`);
    setTimeout(() => this.connect(), RECONNECT_DELAY_MS);
  }

  getPrice(asset) {
    return this.prices[asset] != null ? this.prices[asset] : null;
  }

  close() {
    this.closed = true;
    this._clearPing();
    this._clearStaleCheck();
    if (this.ws) {
      this.ws.close();
      this.ws = null;
    }
    this.connected = false;
  }
}

const polymarketRTDS = new PolymarketRTDS();

module.exports = { PolymarketRTDS, polymarketRTDS };
