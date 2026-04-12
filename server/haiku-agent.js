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
// Key: `${laneId}:${windowTs}`, Value: { firstDirection, firstCallTime, firstIrrev }
const confirmationState = new Map();

class HaikuAgent {
  constructor() {
    this._lastLogTime = new Map();
  }

  /**
   * Build OHLC text data for the last N candles of an asset.
   * Uses candleEngine completed candles + live candle.
   */
  _buildCandleText(asset, interval, windowTs, numCandles = 7) {
    const laneId = `${asset}-${interval}M`;
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

    const systemPrompt = `You are a crypto candle pattern analyst. You receive OHLC candle data for ${asset} on a ${interval}-minute timeframe. Your job is to predict the direction of the current candle by the time it closes.

Rules:
- Respond with exactly one word: UP, DOWN, or WAIT
- UP = price will close higher than current price
- DOWN = price will close lower than current price
- WAIT = no clear pattern, skip this candle
- Look for: momentum direction, lower lows/lower highs (bearish), higher lows/higher highs (bullish), bounce attempts, support/resistance breaks, engulfing patterns, trend continuation vs reversal
- If the structure is choppy with no clear direction, say WAIT
- Be decisive. Only say WAIT if genuinely uncertain.`;

    const userMessage = `Here are the recent ${interval}-minute candles for ${asset}:\n\n${candleText}\n\nWhat is your prediction for the current candle's close? Reply with exactly one word: UP, DOWN, or WAIT.`;

    try {
      const response = await axios.post(API_URL, {
        model: HAIKU_MODEL,
        max_tokens: 10,
        messages: [{ role: 'user', content: userMessage }],
        system: systemPrompt,
      }, {
        headers: {
          'Content-Type': 'application/json',
          'x-api-key': API_KEY,
          'anthropic-version': '2023-06-01',
        },
        timeout: 5000,
      });

      const text = response.data.content[0].text.trim().toUpperCase();

      if (text === 'UP' || text === 'DOWN' || text === 'WAIT') {
        return text;
      }

      // Try to extract from longer response
      if (text.includes('UP')) return 'UP';
      if (text.includes('DOWN')) return 'DOWN';
      if (text.includes('WAIT')) return 'WAIT';

      console.log(`[haiku-agent] Unexpected response: "${text}"`);
      return null;
    } catch (err) {
      console.error(`[haiku-agent] API error: ${err.message}`);
      return null;
    }
  }

  /**
   * Main gate check — called before any trade entry.
   * Implements the two-call confirmation flow:
   *
   * 1. First call at ~90s elapsed → returns UP/DOWN/WAIT
   * 2. If WAIT → skip (unless irrev >= 3.0 override)
   * 3. If UP/DOWN → cache direction, return { approved: false, pending: true }
   * 4. After 30s → second call
   * 5. If second matches first AND irrev rose → approved
   * 6. If disagreement or irrev dropped → skip
   *
   * Returns: { approved: boolean, direction: string|null, reason: string }
   */
  async evaluate(laneId, asset, interval, windowTs, irrev, elapsedSeconds) {
    const cacheKey = `${laneId}:${windowTs}`;
    const confirmKey = `${laneId}:${windowTs}`;

    // Skip if too early in the candle (configurable, default 90s)
    const minElapsed = 90;
    if (elapsedSeconds < minElapsed) {
      return { approved: false, direction: null, reason: 'too early in candle' };
    }

    // Check if we already have a final decision for this window
    const cached = callCache.get(cacheKey);
    if (cached && cached.final) {
      return cached.finalResult;
    }

    // Check confirmation state
    const confirm = confirmationState.get(confirmKey);

    if (!confirm) {
      // --- FIRST CALL ---
      const candleText = this._buildCandleText(asset, interval, windowTs);
      if (!candleText) {
        return { approved: false, direction: null, reason: 'no candle data available' };
      }

      const prediction = await this._callHaiku(asset, interval, candleText);
      if (prediction == null) {
        return { approved: false, direction: null, reason: 'haiku API failed' };
      }

      console.log(`[haiku-agent] ${laneId} call #1: ${prediction} (irrev=${irrev.toFixed(2)}, elapsed=${elapsedSeconds}s)`);

      if (prediction === 'WAIT') {
        // Irrev override: if irrev >= 3.0, skip Haiku and approve
        if (irrev >= 3.0) {
          console.log(`[haiku-agent] ${laneId} WAIT overridden by irrev=${irrev.toFixed(2)} >= 3.0`);
          const result = { approved: true, direction: null, reason: 'irrev override (>=3.0), haiku said WAIT' };
          callCache.set(cacheKey, { final: true, finalResult: result });
          return result;
        }
        const result = { approved: false, direction: null, reason: 'haiku says WAIT' };
        callCache.set(cacheKey, { final: true, finalResult: result });
        return result;
      }

      // Record first call, start 30s confirmation timer
      confirmationState.set(confirmKey, {
        firstDirection: prediction,
        firstCallTime: Date.now(),
        firstIrrev: irrev,
      });

      return { approved: false, direction: prediction, reason: 'awaiting confirmation (30s)' };
    }

    // --- CONFIRMATION PHASE ---
    const elapsed = Date.now() - confirm.firstCallTime;
    if (elapsed < 30000) {
      return { approved: false, direction: confirm.firstDirection, reason: `confirmation in ${Math.ceil((30000 - elapsed) / 1000)}s` };
    }

    // --- SECOND CALL ---
    const candleText2 = this._buildCandleText(asset, interval, windowTs);
    if (!candleText2) {
      const result = { approved: false, direction: null, reason: 'no candle data for second call' };
      callCache.set(cacheKey, { final: true, finalResult: result });
      confirmationState.delete(confirmKey);
      return result;
    }

    const prediction2 = await this._callHaiku(asset, interval, candleText2);
    if (prediction2 == null) {
      const result = { approved: false, direction: null, reason: 'haiku API failed on second call' };
      callCache.set(cacheKey, { final: true, finalResult: result });
      confirmationState.delete(confirmKey);
      return result;
    }

    console.log(`[haiku-agent] ${laneId} call #2: ${prediction2} (irrev=${irrev.toFixed(2)}, first was ${confirm.firstDirection})`);

    // Check: second call matches first AND irrev rose
    if (prediction2 === confirm.firstDirection && irrev >= confirm.firstIrrev) {
      console.log(`[haiku-agent] ${laneId} CONFIRMED: ${prediction2} (irrev ${confirm.firstIrrev.toFixed(2)} → ${irrev.toFixed(2)})`);
      const result = { approved: true, direction: prediction2, reason: 'haiku confirmed' };
      callCache.set(cacheKey, { final: true, finalResult: result });
      confirmationState.delete(confirmKey);
      return result;
    }

    // Disagreement or irrev dropped
    const reason = prediction2 !== confirm.firstDirection
      ? `haiku disagreed (${confirm.firstDirection} → ${prediction2})`
      : `irrev dropped (${confirm.firstIrrev.toFixed(2)} → ${irrev.toFixed(2)})`;
    console.log(`[haiku-agent] ${laneId} REJECTED: ${reason}`);
    const result = { approved: false, direction: null, reason };
    callCache.set(cacheKey, { final: true, finalResult: result });
    confirmationState.delete(confirmKey);
    return result;
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
      pendingConfirmations: states,
      cachedDecisions: callCache.size,
      apiKeySet: !!API_KEY,
    };
  }
}

const haikuAgent = new HaikuAgent();
module.exports = { HaikuAgent, haikuAgent };
