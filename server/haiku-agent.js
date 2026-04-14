const axios = require('axios');
const { candleEngine } = require('./candle-engine');
const { coinbaseWS } = require('./coinbase-ws');
const { polymarketRTDS } = require('./polymarket-ws');

const HAIKU_MODEL = 'claude-haiku-4-5-20251001';
const API_URL = 'https://api.anthropic.com/v1/messages';
const API_KEY = process.env.ANTHROPIC_API_KEY;

// Cache: one Haiku call result per lane per window
// Key: `${laneId}:${windowTs}`, Value: { final, finalResult }
const callCache = new Map();

// Confirmation timer tracking
// Key: `${laneId}:${windowTs}`, Value: { firstDirection, firstCallTime }
const confirmationState = new Map();

class HaikuAgent {
  constructor() {
    this._lastLogTime = new Map();
    this._inFlight = new Set();
  }

  /**
   * Build OHLC text data for the last N candles of an asset.
   * Uses candleEngine completed candles + live candle.
   */
  _buildCandleText(asset, interval, windowTs, numCandles = 7, laneId = null) {
    if (!laneId) laneId = `${asset}-${interval}M`;
    const candles = [];

    // Get completed candles (most recent N)
    const completed = candleEngine.getCompletedCandles(laneId, numCandles);
    for (let i = 0; i < completed.length; i++) {
      const c = completed[i];
      if (c.open != null && c.close != null) {
        const dir = c.close >= c.open ? 'GREEN' : 'RED';
        const bodyPct = c.open > 0 ? (((c.close - c.open) / c.open) * 100).toFixed(3) : '0.000';
        candles.push(`Candle ${i + 1}: O=${c.open.toFixed(2)} H=${c.high.toFixed(2)} L=${c.low.toFixed(2)} C=${c.close.toFixed(2)} (${dir}, ${bodyPct}%)`);
      }
    }

    // Add current live candle (in progress)
    let livePrice = polymarketRTDS.getPrice(asset);
    if (livePrice == null || polymarketRTDS.isStale()) {
      livePrice = coinbaseWS.getPrice(asset);
    }

    const liveCandle = candleEngine.getLiveCandle(laneId);
    if (livePrice != null && liveCandle && liveCandle.open != null) {
      const dir = livePrice >= liveCandle.open ? 'GREEN' : 'RED';
      const bodyPct = liveCandle.open > 0 ? (((livePrice - liveCandle.open) / liveCandle.open) * 100).toFixed(3) : '0.000';
      candles.push(`LIVE: O=${liveCandle.open.toFixed(2)} H=${liveCandle.high.toFixed(2)} L=${liveCandle.low.toFixed(2)} C=${livePrice.toFixed(2)} (${dir}, ${bodyPct}%) [in progress]`);
    } else if (livePrice != null) {
      candles.push(`LIVE: price=${livePrice.toFixed(2)} [no candle data yet]`);
    }

    if (candles.length === 0) return null;
    return candles.join('\n');
  }

  /**
   * Call Haiku API with candle data. Returns 'UP', 'DOWN', or 'WAIT'.
   */
  async _callHaiku(asset, interval, candleText) {
    if (!API_KEY) {
      console.error('[haiku-agent] ANTHROPIC_API_KEY not set');
      return null;
    }

    const systemPrompt = `You are a crypto momentum analyst. You receive OHLC candle data for ${asset} on a ${interval}-minute timeframe. Your job is to predict whether the current candle will CONTINUE in its current direction or reverse by the time it closes.

Rules:
- Respond with exactly one word: UP, DOWN, or WAIT
- UP = price will close higher than the candle open
- DOWN = price will close lower than the candle open
- WAIT = no clear momentum, skip this candle
- Focus on: trend strength, momentum persistence, higher highs/higher lows (bullish), lower highs/lower lows (bearish), volume of recent moves, whether the current move is accelerating or decelerating
- At hourly and 4-hourly timeframes, trends tend to persist (momentum effect)
- If the move is strong and accelerating, bet on continuation
- If the move is weak, choppy, or showing signs of exhaustion, say WAIT
- Be decisive. Only say WAIT if the structure is genuinely ambiguous.

CRITICAL: Your response must be ONLY one word. No analysis, no headers, no markdown, no reasoning. Just reply with one word: UP, DOWN, or WAIT. Nothing else.`;

    const userMessage = `Here are the recent ${interval}-minute candles for ${asset}:\n\n${candleText}\n\nWhat is your prediction for the current candle's close? Reply with exactly one word: UP, DOWN, or WAIT.`;

    const requestBody = {
      model: HAIKU_MODEL,
      max_tokens: 10,
      messages: [{ role: 'user', content: userMessage }],
      system: systemPrompt,
    };
    const requestConfig = {
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': API_KEY,
        'anthropic-version': '2023-06-01',
      },
      timeout: 15000,
    };

    const parseResponse = (resp) => {
      const text = resp.data.content[0].text.trim().toUpperCase();
      if (text === 'UP' || text === 'DOWN' || text === 'WAIT') return text;
      if (text.includes('UP')) return 'UP';
      if (text.includes('DOWN')) return 'DOWN';
      if (text.includes('WAIT')) return 'WAIT';
      return null;
    };

    try {
      const response = await axios.post(API_URL, requestBody, requestConfig);
      const result = parseResponse(response);
      if (result) return result;

      // First attempt returned unexpected response — retry once
      console.log(`[haiku-agent] Unexpected response, retrying...`);
      const retry = await axios.post(API_URL, requestBody, requestConfig);
      const retryResult = parseResponse(retry);
      if (retryResult) return retryResult;

      console.log(`[haiku-agent] Unexpected response after retry: "${retry.data.content[0].text.trim()}"`);
      return null;
    } catch (err) {
      console.error(`[haiku-agent] API error: ${err.message}`);
      return null;
    }
  }

  /**
   * Main gate check — called before any trade entry.
   * Single-call flow at 50% elapsed with DOWN skepticism bias:
   *
   * 1. At 50% elapsed → one Haiku call
   * 2. WAIT → final skip
   * 3. UP → immediately approved
   * 4. DOWN → delayed until 55% elapsed (skepticism bias)
   *
   * Returns: { approved: boolean, direction: string|null, reason: string }
   */
  async evaluate(laneId, asset, interval, windowTs, elapsedSeconds) {
    const cacheKey = `${laneId}:${windowTs}`;

    // Proportional timing based on interval
    const totalSeconds = interval * 60;
    const callElapsed = Math.floor(totalSeconds * 0.50);
    const downThreshold = Math.floor(totalSeconds * 0.55);

    if (elapsedSeconds < callElapsed) {
      return { approved: false, direction: null, reason: 'too early in candle' };
    }

    // Check if we already have a final decision for this window
    const cached = callCache.get(cacheKey);
    if (cached && cached.final) {
      const logKey = `haiku-cached-${cacheKey}`;
      const now = Date.now();
      const lastLog = this._lastLogTime.get(logKey) || 0;
      if (now - lastLog >= 30000) {
        this._lastLogTime.set(logKey, now);
        const reason = cached.executed ? 'already executed' : cached.finalResult.reason;
        console.log(`[haiku-agent] ${laneId} cached: ${reason}`);
      }
      if (cached.executed) {
        return { approved: false, direction: null, reason: 'already executed' };
      }
      return cached.finalResult;
    }

    // Check for a pending DOWN prediction waiting for 55% elapsed
    const pending = confirmationState.get(cacheKey);
    if (pending && pending.type === 'down_delay') {
      if (elapsedSeconds >= downThreshold) {
        console.log(`[haiku-agent] ${laneId} DOWN approved at ${elapsedSeconds}s (>= ${downThreshold}s threshold)`);
        const result = { approved: true, direction: 'DOWN', reason: 'haiku DOWN (delayed)' };
        callCache.set(cacheKey, { final: true, executed: true, finalResult: result });
        confirmationState.delete(cacheKey);
        return result;
      }
      return { approved: false, direction: 'DOWN', reason: `DOWN requires ${downThreshold - elapsedSeconds}s more` };
    }

    // In-flight lock — prevent duplicate API calls from the 1s loop
    if (this._inFlight.has(cacheKey)) {
      return { approved: false, direction: null, reason: 'haiku call in progress' };
    }

    // --- SINGLE HAIKU CALL ---
    const candleText = this._buildCandleText(asset, interval, windowTs, 7, laneId);
    if (!candleText) {
      return { approved: false, direction: null, reason: 'no candle data available' };
    }

    this._inFlight.add(cacheKey);
    const prediction = await this._callHaiku(asset, interval, candleText);

    if (prediction == null) {
      this._inFlight.delete(cacheKey);
      return { approved: false, direction: null, reason: 'haiku API failed' };
    }

    console.log(`[haiku-agent] ${laneId} prediction: ${prediction} (elapsed=${elapsedSeconds}s)`);

    if (prediction === 'WAIT') {
      const result = { approved: false, direction: null, reason: 'haiku says WAIT' };
      callCache.set(cacheKey, { final: true, finalResult: result });
      this._inFlight.delete(cacheKey);
      return result;
    }

    // DOWN skepticism — require 55% elapsed before acting
    if (prediction === 'DOWN' && elapsedSeconds < downThreshold) {
      console.log(`[haiku-agent] ${laneId} DOWN at ${elapsedSeconds}s, delaying until ${downThreshold}s`);
      confirmationState.set(cacheKey, { firstDirection: 'DOWN', type: 'down_delay' });
      this._inFlight.delete(cacheKey);
      return { approved: false, direction: 'DOWN', reason: `DOWN requires 55% elapsed` };
    }

    // UP or DOWN past threshold — approve immediately
    console.log(`[haiku-agent] ${laneId} APPROVED: ${prediction}`);
    const result = { approved: true, direction: prediction, reason: `haiku ${prediction}` };
    callCache.set(cacheKey, { final: true, executed: true, finalResult: result });
    this._inFlight.delete(cacheKey);
    return result;
  }

  /**
   * Mark a lane+window as executed so Haiku never re-approves.
   */
  markExecuted(laneId, windowTs) {
    const cacheKey = `${laneId}:${windowTs}`;
    const cached = callCache.get(cacheKey);
    if (cached) {
      cached.executed = true;
    } else {
      callCache.set(cacheKey, { final: true, executed: true, finalResult: { approved: false, direction: null, reason: 'already executed' } });
    }
  }

  /**
   * Clean up cache entries for old windows.
   */
  cleanup(windowTs) {
    for (const [key] of callCache) {
      const ts = parseInt(key.split(':')[1], 10);
      if (ts < windowTs - 3600) {
        callCache.delete(key);
        confirmationState.delete(key);
      }
    }
  }

  /**
   * Get current state for dashboard display.
   */
  getState() {
    const states = [];
    for (const [key, val] of confirmationState) {
      states.push({ key, ...val });
    }
    return {
      pendingDownDelays: states,
      cachedDecisions: callCache.size,
      inFlightCalls: this._inFlight.size,
      apiKeySet: !!API_KEY,
    };
  }
}

const haikuAgent = new HaikuAgent();
module.exports = { HaikuAgent, haikuAgent };
