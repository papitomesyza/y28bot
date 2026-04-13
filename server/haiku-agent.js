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
- Be decisive. Only say WAIT if the structure is genuinely ambiguous.`;

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
  async evaluate(laneId, asset, interval, windowTs, elapsedSeconds) {
    const cacheKey = `${laneId}:${windowTs}`;
    const confirmKey = `${laneId}:${windowTs}`;

    // Proportional timing based on interval
    const totalSeconds = interval * 60;
    const call1Elapsed = Math.floor(totalSeconds * 0.40);
    const call2Elapsed = Math.floor(totalSeconds * 0.50);

    if (elapsedSeconds < call1Elapsed) {
      return { approved: false, direction: null, reason: 'too early in candle' };
    }

    // Check if we already have a final decision for this window
    const cached = callCache.get(cacheKey);
    if (cached && cached.final) {
      // If already executed a trade this window, never approve again
      if (cached.executed) {
        return { approved: false, direction: null, reason: 'already executed' };
      }
      return cached.finalResult;
    }

    // Check confirmation state
    const confirm = confirmationState.get(confirmKey);

    if (!confirm) {
      // --- FIRST CALL ---
      const candleText = this._buildCandleText(asset, interval, windowTs, 7, laneId);
      if (!candleText) {
        return { approved: false, direction: null, reason: 'no candle data available' };
      }

      const prediction = await this._callHaiku(asset, interval, candleText);
      if (prediction == null) {
        return { approved: false, direction: null, reason: 'haiku API failed' };
      }

      console.log(`[haiku-agent] ${laneId} call #1: ${prediction} (elapsed=${elapsedSeconds}s)`);

      if (prediction === 'WAIT') {
        const result = { approved: false, direction: null, reason: 'haiku says WAIT' };
        callCache.set(cacheKey, { final: true, finalResult: result });
        return result;
      }

      // Record first call, start confirmation timer
      confirmationState.set(confirmKey, {
        firstDirection: prediction,
        firstCallTime: Date.now(),
      });

      return { approved: false, direction: prediction, reason: 'awaiting confirmation' };
    }

    // --- CONFIRMATION PHASE ---
    const confirmGapMs = (call2Elapsed - call1Elapsed) * 1000;
    const elapsed = Date.now() - confirm.firstCallTime;
    if (elapsed < confirmGapMs) {
      return { approved: false, direction: confirm.firstDirection, reason: `confirmation in ${Math.ceil((confirmGapMs - elapsed) / 1000)}s` };
    }

    // --- SECOND CALL ---
    const candleText2 = this._buildCandleText(asset, interval, windowTs, 7, laneId);
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

    console.log(`[haiku-agent] ${laneId} call #2: ${prediction2} (first was ${confirm.firstDirection})`);

    // Check: second call matches first direction
    if (prediction2 === confirm.firstDirection) {
      console.log(`[haiku-agent] ${laneId} CONFIRMED: ${prediction2}`);
      const result = { approved: true, direction: prediction2, reason: 'haiku confirmed' };
      // Mark executed immediately — one approval per lane per window, period
      callCache.set(cacheKey, { final: true, executed: true, finalResult: result });
      confirmationState.delete(confirmKey);
      return result;
    }

    // Direction disagreement
    const reason = `haiku disagreed (${confirm.firstDirection} → ${prediction2})`;
    console.log(`[haiku-agent] ${laneId} REJECTED: ${reason}`);
    const result = { approved: false, direction: null, reason };
    callCache.set(cacheKey, { final: true, finalResult: result });
    confirmationState.delete(confirmKey);
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
      pendingConfirmations: states,
      cachedDecisions: callCache.size,
      apiKeySet: !!API_KEY,
    };
  }
}

const haikuAgent = new HaikuAgent();
module.exports = { HaikuAgent, haikuAgent };
