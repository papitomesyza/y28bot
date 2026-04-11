const config = require('./config');
const axios = require('axios');
const db = require('./db');
const { ethers } = require('ethers');

class OrderExecutor {
  constructor() {
    this.client = null;
    this.provider = null;
    this.wallet = null;
    this.initialized = false;
    this._lastOrderbookLogTime = new Map();
    this._pendingEntries = new Map();
  }

  _shouldLogOrderbook(tokenId) {
    const key = tokenId || 'unknown';
    const now = Date.now();
    const last = this._lastOrderbookLogTime.get(key) || 0;
    if (now - last >= 30000) {
      this._lastOrderbookLogTime.set(key, now);
      return true;
    }
    return false;
  }

  async init() {
    if (!config.polygonPrivateKey) {
      console.log('[executor] No POLYGON_PRIVATE_KEY set — running in observe-only mode');
      this.initialized = false;
      return;
    }

    try {
      const { ClobClient } = await import('@polymarket/clob-client');

      this.provider = new ethers.providers.JsonRpcProvider(config.polygonRpc);
      this.wallet = new ethers.Wallet(config.polygonPrivateKey, this.provider);

      // Create initial client (L1 auth only — wallet signature)
      let client = new ClobClient(config.clobUrl, config.chainId, this.wallet);

      // Derive API credentials (L2 auth)
      const creds = await client.createOrDeriveApiKey();

      // Re-create client with full credentials
      this.client = new ClobClient(config.clobUrl, config.chainId, this.wallet, creds);

      this.initialized = true;
      console.log('[executor] ClobClient initialized');
    } catch (err) {
      console.error('[executor] Failed to initialize ClobClient:', err.message);
      this.initialized = false;
    }
  }

  async getOrderbookPrice(tokenId, side) {
    const shouldLog = this._shouldLogOrderbook(tokenId);
    try {
      if (shouldLog) {
        console.log(`[executor] Fetching orderbook for ${tokenId?.slice(0,20)}... (${side})`);
      }
      const book = await this.client.getOrderBook(tokenId);

      if (side === 'buy') {
        // Best ask = lowest sell price
        if (!book.asks || book.asks.length === 0) {
          if (shouldLog) {
            console.log(`[executor] Orderbook empty for ${tokenId?.slice(0,20)}... (${side}) — no asks`);
          }
          return null;
        }
        const sorted = [...book.asks].sort((a, b) => parseFloat(a.price) - parseFloat(b.price));
        return Math.round(parseFloat(sorted[0].price) * 100) / 100;
      } else {
        // Best bid = highest buy price
        if (!book.bids || book.bids.length === 0) {
          if (shouldLog) {
            console.log(`[executor] Orderbook empty for ${tokenId?.slice(0,20)}... (${side}) — no bids`);
          }
          return null;
        }
        const sorted = [...book.bids].sort((a, b) => parseFloat(b.price) - parseFloat(a.price));
        return Math.round(parseFloat(sorted[0].price) * 100) / 100;
      }
    } catch (err) {
      if (shouldLog) {
        console.error(`[executor] Orderbook error for ${tokenId?.slice(0,20)}... (${side}):`, err.message);
      }
      return null;
    }
  }

  async placeLimitOrder(tokenId, side, price, size) {
    try {
      const response = await this.client.createAndPostOrder(
        {
          tokenID: tokenId,
          price: parseFloat(price),
          size: parseFloat(size),
          side: side,
        },
        { tickSize: '0.01' },
        'GTC'
      );
      console.log(`[executor] Limit order placed: ${size} shares @ $${price}`);
      return response;
    } catch (err) {
      console.error('[executor] Limit order failed:', err.message);
      return null;
    }
  }

  async placeFokOrder(tokenId, side, price, size) {
    try {
      const response = await this.client.createAndPostOrder(
        {
          tokenID: tokenId,
          price: parseFloat(price),
          size: parseFloat(size),
          side: side,
        },
        { tickSize: '0.01' },
        'FOK'
      );
      console.log(`[executor] FOK order placed: ${size} shares @ $${price}`);
      return response;
    } catch (err) {
      console.error('[executor] FOK order failed:', err.message);
      return null;
    }
  }

  clearPendingEntries(laneId) {
    for (const key of this._pendingEntries.keys()) {
      if (key.startsWith(`${laneId}:`)) {
        this._pendingEntries.delete(key);
      }
    }
  }

  async executeEntry(signal, market) {
    // FIX 1: In-memory dedup — synchronous check before any async work
    const dedupKey = `${signal.laneId}:${signal.windowTs}`;
    const currentCount = this._pendingEntries.get(dedupKey) || 0;
    if (currentCount >= config.stackMaxEntries) {
      console.log(`[executor] BLOCKED in-memory dedup: ${signal.laneId} has ${currentCount} entries in window ${signal.windowTs}`);
      return null;
    }
    this._pendingEntries.set(dedupKey, currentCount + 1);

    // Existing DB-level dedup check (safety net)
    if (signal.windowTs) {
      const existingTrades = db.getTrades({ lane_id: signal.laneId, window_start: signal.windowTs });
      if (existingTrades.length >= 2) {
        console.log(`[executor] BLOCKED duplicate: ${signal.laneId} already has 2 trades in window ${signal.windowTs}`);
        this._pendingEntries.set(dedupKey, (this._pendingEntries.get(dedupKey) || 1) - 1);
        return null;
      }
    }

    const maxAsk = global.runtimeConfig.maxAskPrice || 0.92;

    // Dry run or not initialized — simulate trade with real prices when possible
    if (!this.initialized || config.dryRun) {
      const tokenId = signal.direction === 'UP' ? market.upTokenId : market.downTokenId;
      let entryPrice = signal.entryPrice || signal.askPrice;
      let shares = signal.shares;
      let cost = signal.cost;

      // Fetch real orderbook price if ClobClient is available
      if (this.initialized && this.client) {
        const realAsk = await this.getOrderbookPrice(tokenId, 'buy');
        if (realAsk !== null) {
          entryPrice = realAsk;

          // Ask price cap check
          if (entryPrice >= maxAsk) {
            console.log(`[executor] ASK_CAP_BLOCKED: ${signal.laneId} ask $${entryPrice} >= cap $${maxAsk}`);
            this._pendingEntries.set(dedupKey, (this._pendingEntries.get(dedupKey) || 1) - 1);
            return null;
          }

          // Recalculate shares/cost with real price
          const poolBalance = db.getPoolBalance();
          const { superScalp } = require('./superscalp');
          const allocation = superScalp.calculateAllocation(poolBalance, signal.irrev);
          const shareCalc = superScalp.calculateShares(allocation, realAsk);
          const effectiveMin = signal.minShares || config.minShares;
          if (!shareCalc || shareCalc.shares < effectiveMin) {
            console.log(`[executor] DRY RUN: real ask $${realAsk} yields insufficient shares for ${signal.laneId}`);
            this._pendingEntries.set(dedupKey, (this._pendingEntries.get(dedupKey) || 1) - 1);
            return null;
          }
          shares = shareCalc.shares;
          cost = shareCalc.cost;
          console.log(`[executor] DRY RUN: using real ask $${realAsk} for ${signal.laneId}`);
        } else {
          console.log('[executor] DRY RUN using placeholder price — real orderbook unavailable');
        }
      } else {
        console.log('[executor] DRY RUN using placeholder price — real orderbook unavailable');
      }

      console.log(
        `[executor] DRY RUN: would buy ${signal.direction} on ${signal.laneId} irrev=${signal.irrev.toFixed(2)} @ $${entryPrice}`
      );
      const dryTokenId = tokenId;
      const dryConditionId = market.conditionId || null;
      const tradeId = db.insertTrade({
        lane_id: signal.laneId,
        market_id: market.conditionId || null,
        condition_id: dryConditionId,
        clob_token_id: dryTokenId,
        side: signal.direction,
        entry_price: entryPrice,
        shares,
        cost,
        irrev: signal.irrev,
        stack_level: signal.stackLevel || 1,
        entry_type: signal.type,
        open_price: signal.openPrice || null,
        result: 'pending',
        window_start: signal.windowTs || null,
        window_end: signal.windowEnd || null,
        slug: market.slug || null,
      });
      console.log(`[executor] Trade stored with token: ${dryTokenId?.slice(0,20)}... condition: ${dryConditionId?.slice(0,20)}...`);
      return db.getTradeById(tradeId);
    }

    // Determine tokenId from direction
    const tokenId = signal.direction === 'UP' ? market.upTokenId : market.downTokenId;

    // Get real orderbook ask price
    const askPrice = await this.getOrderbookPrice(tokenId, 'buy');
    if (askPrice === null) {
      console.log(`[executor] No ask price available for ${signal.laneId}`);
      this._pendingEntries.set(dedupKey, (this._pendingEntries.get(dedupKey) || 1) - 1);
      return null;
    }

    // Ask price cap check
    if (askPrice >= maxAsk) {
      console.log(`[executor] ASK_CAP_BLOCKED: ${signal.laneId} ask $${askPrice} >= cap $${maxAsk}`);
      this._pendingEntries.set(dedupKey, (this._pendingEntries.get(dedupKey) || 1) - 1);
      return null;
    }

    // Price range validation based on entry type
    if (signal.type === 'midpoint') {
      if (askPrice < config.midpointPriceRange.min || askPrice > config.midpointPriceRange.max) {
        console.log(`[executor] Ask $${askPrice} outside midpoint range for ${signal.laneId}`);
        this._pendingEntries.set(dedupKey, (this._pendingEntries.get(dedupKey) || 1) - 1);
        return null;
      }
    } else if (signal.type === 'spread_scalp') {
      if (askPrice < config.spreadScalpPriceRange.min || askPrice > config.spreadScalpPriceRange.max) {
        console.log(`[executor] Ask $${askPrice} outside spread scalp range for ${signal.laneId}`);
        this._pendingEntries.set(dedupKey, (this._pendingEntries.get(dedupKey) || 1) - 1);
        return null;
      }
    }

    // Calculate shares and cost using real ask price (same logic as superscalp)
    const poolBalance = db.getPoolBalance();
    const { superScalp } = require('./superscalp');
    const allocation = superScalp.calculateAllocation(poolBalance, signal.irrev);
    const shareCalc = superScalp.calculateShares(allocation, askPrice);
    if (!shareCalc) {
      console.log(`[executor] Insufficient shares for ${signal.laneId}`);
      this._pendingEntries.set(dedupKey, (this._pendingEntries.get(dedupKey) || 1) - 1);
      return null;
    }

    const shares = Math.floor(shareCalc.shares);
    const effectiveMinShares = signal.minShares || config.minShares;
    if (shares < effectiveMinShares) {
      console.log(`[executor] Shares ${shares} below minimum ${effectiveMinShares} for ${signal.laneId}`);
      this._pendingEntries.set(dedupKey, (this._pendingEntries.get(dedupKey) || 1) - 1);
      return null;
    }

    const priceStr = askPrice.toFixed(2);
    const sharesStr = shares.toString();

    // Place limit order
    const limitResponse = await this.placeLimitOrder(tokenId, 'BUY', priceStr, sharesStr);

    let filled = false;
    let fillPrice = askPrice;
    let fillShares = shares;

    if (limitResponse && limitResponse.orderID) {
      // Poll for fill every 500ms up to limitOrderTimeoutMs
      const pollInterval = 500;
      const maxPolls = Math.ceil(config.limitOrderTimeoutMs / pollInterval);
      for (let i = 0; i < maxPolls && !filled; i++) {
        await this._sleep(pollInterval);
        try {
          const orderStatus = await this.client.getOrder(limitResponse.orderID);
          if (orderStatus && (orderStatus.status === 'MATCHED' || orderStatus.status === 'FILLED')) {
            filled = true;
            fillShares = parseFloat(orderStatus.size_matched) || fillShares;
          }
        } catch (err) {
          console.error('[executor] Failed to check order status:', err.message);
        }
      }

      // Cancel unfilled limit order before FOK fallback
      if (!filled) {
        try {
          await this.client.cancelOrder({ orderID: limitResponse.orderID });
        } catch (_) {
          // Best-effort cancel
        }
      }
    }

    // FOK fallback at ask + $0.01
    if (!filled) {
      const fokPrice = (askPrice + 0.01).toFixed(2);
      const fokResponse = await this.placeFokOrder(tokenId, 'BUY', fokPrice, sharesStr);

      if (fokResponse && fokResponse.orderID) {
        try {
          const fokStatus = await this.client.getOrder(fokResponse.orderID);
          if (fokStatus && (fokStatus.status === 'MATCHED' || fokStatus.status === 'FILLED')) {
            filled = true;
            fillPrice = parseFloat(fokPrice);
            fillShares = parseFloat(fokStatus.size_matched) || fillShares;
          }
        } catch (err) {
          console.error('[executor] Failed to check FOK status:', err.message);
        }
      }
    }

    if (!filled) {
      console.log(`[executor] Order NOT filled — market moved for ${signal.laneId}`);
      this._pendingEntries.set(dedupKey, (this._pendingEntries.get(dedupKey) || 1) - 1);
      return null;
    }

    // Record trade in DB and deduct cost from pool
    const cost = fillShares * fillPrice;
    const liveConditionId = market.conditionId || null;
    const tradeId = db.insertTrade({
      lane_id: signal.laneId,
      market_id: market.conditionId || null,
      condition_id: liveConditionId,
      clob_token_id: tokenId,
      side: signal.direction,
      entry_price: fillPrice,
      shares: fillShares,
      cost,
      irrev: signal.irrev,
      stack_level: signal.stackLevel || 1,
      entry_type: signal.type,
      open_price: signal.openPrice || null,
      result: 'pending',
      window_start: signal.windowTs || null,
      window_end: signal.windowEnd || null,
      slug: market.slug || null,
    });

    db.updatePoolBalance(poolBalance - cost);
    console.log(
      `[executor] Trade recorded: ${fillShares} shares @ $${fillPrice.toFixed(2)} cost=$${cost.toFixed(2)}`
    );
    console.log(`[executor] Trade stored with token: ${tokenId?.slice(0,20)}... condition: ${liveConditionId?.slice(0,20)}...`);

    return db.getTradeById(tradeId);
  }

  _sleep(ms) {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }
}

const orderExecutor = new OrderExecutor();

module.exports = { OrderExecutor, orderExecutor };
