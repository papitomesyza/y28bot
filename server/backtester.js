const axios = require('axios');

const HAIKU_MODEL = 'claude-haiku-4-5-20251001';
const ANTHROPIC_API_URL = 'https://api.anthropic.com/v1/messages';

const BINANCE_PRIMARY = 'https://data-api.binance.vision/api/v3/klines';
const BINANCE_FALLBACK = 'https://api.binance.com/api/v3/klines';

/**
 * Build the Haiku system prompt — identical to haiku-agent.js _callHaiku
 */
function buildSystemPrompt(asset, interval) {
  return `You are a crypto momentum analyst. You receive OHLC candle data for ${asset} on a ${interval}-minute timeframe. Your job is to predict whether the current candle will CONTINUE in its current direction or reverse by the time it closes.

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
}

/**
 * Binary search sorted 1-second klines for the closest price at or before timestampMs.
 * Each kline: [openTime, open, high, low, close, ...]
 */
function getPrice(sortedKlines, timestampMs) {
  if (sortedKlines.length === 0) return null;

  let lo = 0;
  let hi = sortedKlines.length - 1;

  if (timestampMs < sortedKlines[0][0]) return parseFloat(sortedKlines[0][4]);
  if (timestampMs >= sortedKlines[hi][0]) return parseFloat(sortedKlines[hi][4]);

  while (lo <= hi) {
    const mid = (lo + hi) >>> 1;
    const t = sortedKlines[mid][0];
    if (t === timestampMs) return parseFloat(sortedKlines[mid][4]);
    if (t < timestampMs) lo = mid + 1;
    else hi = mid - 1;
  }

  // hi is the largest index where openTime <= timestampMs
  return parseFloat(sortedKlines[hi][4]);
}

/**
 * Aggregate 1-second klines into a single candle for the given time range.
 * Returns { open, high, low, close } or null if no data.
 */
function aggregateCandle(sortedKlines, startMs, endMs) {
  // Find the start index via binary search
  let lo = 0;
  let hi = sortedKlines.length - 1;

  while (lo <= hi) {
    const mid = (lo + hi) >>> 1;
    if (sortedKlines[mid][0] < startMs) lo = mid + 1;
    else hi = mid - 1;
  }

  const startIdx = lo;

  let open = null;
  let high = -Infinity;
  let low = Infinity;
  let close = null;
  let count = 0;

  for (let i = startIdx; i < sortedKlines.length; i++) {
    const k = sortedKlines[i];
    if (k[0] >= endMs) break;

    const kOpen = parseFloat(k[1]);
    const kHigh = parseFloat(k[2]);
    const kLow = parseFloat(k[3]);
    const kClose = parseFloat(k[4]);

    if (open === null) open = kOpen;
    if (kHigh > high) high = kHigh;
    if (kLow < low) low = kLow;
    close = kClose;
    count++;
  }

  if (count === 0) return null;
  return { open, high, low, close };
}

/**
 * Build candle text matching haiku-agent._buildCandleText format.
 */
function buildCandleText(sortedKlines, asset, intervalMin, windowStartMs, elapsedMs, numPrev = 7) {
  const intervalMs = intervalMin * 60 * 1000;
  const lines = [];

  // Previous N completed candles
  for (let i = numPrev; i >= 1; i--) {
    const prevStart = windowStartMs - i * intervalMs;
    const prevEnd = prevStart + intervalMs;
    const c = aggregateCandle(sortedKlines, prevStart, prevEnd);
    if (c && c.open != null && c.close != null) {
      const dir = c.close >= c.open ? 'GREEN' : 'RED';
      const bodyPct = c.open > 0 ? (((c.close - c.open) / c.open) * 100).toFixed(3) : '0.000';
      lines.push(`Candle ${numPrev - i + 1}: O=${c.open.toFixed(2)} H=${c.high.toFixed(2)} L=${c.low.toFixed(2)} C=${c.close.toFixed(2)} (${dir}, ${bodyPct}%)`);
    }
  }

  // Live candle: from window start to elapsed point
  const elapsedEnd = windowStartMs + elapsedMs;
  const live = aggregateCandle(sortedKlines, windowStartMs, elapsedEnd);
  if (live && live.open != null && live.close != null) {
    const dir = live.close >= live.open ? 'GREEN' : 'RED';
    const bodyPct = live.open > 0 ? (((live.close - live.open) / live.open) * 100).toFixed(3) : '0.000';
    lines.push(`LIVE: O=${live.open.toFixed(2)} H=${live.high.toFixed(2)} L=${live.low.toFixed(2)} C=${live.close.toFixed(2)} (${dir}, ${bodyPct}%) [in progress]`);
  }

  return lines.length > 0 ? lines.join('\n') : null;
}

/**
 * Fetch Binance 1-second klines for a time range. Paginates automatically.
 */
async function fetchBinanceKlines(asset, startMs, endMs, onProgress) {
  const symbol = `${asset}USDT`;
  const limit = 1000;
  let allKlines = [];
  let currentStart = startMs;
  let requestCount = 0;
  const totalRequests = Math.ceil((endMs - startMs) / (limit * 1000));

  // Try primary URL first, fall back if needed
  let baseUrl = BINANCE_PRIMARY;
  let usedFallback = false;

  while (currentStart < endMs) {
    const params = {
      symbol,
      interval: '1s',
      startTime: currentStart,
      endTime: endMs,
      limit,
    };

    try {
      const resp = await axios.get(baseUrl, { params, timeout: 15000 });
      const data = resp.data;

      if (!data || data.length === 0) break;

      allKlines = allKlines.concat(data);
      requestCount++;

      // Advance past last returned kline
      currentStart = data[data.length - 1][0] + 1000;

      if (onProgress) {
        onProgress({
          status: 'running',
          phase: 'fetch',
          pct: Math.min(30, Math.round((requestCount / totalRequests) * 30)),
          message: `Fetching ${asset} 1s data: ${requestCount}/${totalRequests} requests`,
        });
      }

      // Rate limit: 200ms between requests
      await new Promise(r => setTimeout(r, 200));
    } catch (err) {
      // If primary fails with network error, try fallback once
      if (!usedFallback && (err.code === 'ECONNREFUSED' || err.code === 'ENOTFOUND' || err.code === 'ETIMEDOUT' || err.code === 'ERR_BAD_REQUEST')) {
        console.log(`[backtest] Primary Binance URL failed (${err.code}), trying fallback...`);
        baseUrl = BINANCE_FALLBACK;
        usedFallback = true;
        // Retry this request with fallback URL — don't advance
        continue;
      }

      // If fallback also fails, or a different error
      if (usedFallback && (err.code === 'ECONNREFUSED' || err.code === 'ENOTFOUND' || err.code === 'ETIMEDOUT')) {
        throw new Error(`Both Binance API domains unreachable. You may need to whitelist data-api.binance.vision and api.binance.com in your hosting provider's egress rules.`);
      }

      // For rate-limit (429) or server errors, wait and retry
      if (err.response && (err.response.status === 429 || err.response.status >= 500)) {
        console.log(`[backtest] Binance ${err.response.status}, retrying in 2s...`);
        await new Promise(r => setTimeout(r, 2000));
        continue;
      }

      throw err;
    }
  }

  // Sort by openTime just in case
  allKlines.sort((a, b) => a[0] - b[0]);

  console.log(`[backtest] Fetched ${allKlines.length} 1s klines for ${asset} (${requestCount} requests)`);
  return allKlines;
}

/**
 * Call Haiku with candle text. Returns 'UP', 'DOWN', or 'WAIT'.
 */
async function callHaiku(asset, intervalMin, candleText) {
  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) {
    throw new Error('ANTHROPIC_API_KEY not set — cannot run backtest');
  }

  const systemPrompt = buildSystemPrompt(asset, intervalMin);
  const userMessage = `Here are the recent ${intervalMin}-minute candles for ${asset}:\n\n${candleText}\n\nWhat is your prediction for the current candle's close? Reply with exactly one word: UP, DOWN, or WAIT.`;

  const response = await axios.post(ANTHROPIC_API_URL, {
    model: HAIKU_MODEL,
    max_tokens: 10,
    messages: [{ role: 'user', content: userMessage }],
    system: systemPrompt,
  }, {
    headers: {
      'Content-Type': 'application/json',
      'x-api-key': apiKey,
      'anthropic-version': '2023-06-01',
    },
    timeout: 10000,
  });

  const text = response.data.content[0].text.trim().toUpperCase();

  if (text === 'UP' || text === 'DOWN' || text === 'WAIT') return text;
  if (text.includes('UP')) return 'UP';
  if (text.includes('DOWN')) return 'DOWN';
  if (text.includes('WAIT')) return 'WAIT';

  console.log(`[backtest] Unexpected Haiku response: "${text}"`);
  return 'WAIT'; // Default to WAIT for unparseable responses
}

/**
 * Main backtest runner.
 */
async function runBacktest(options = {}) {
  const {
    assets = ['BTC', 'ETH'],
    intervals = [5, 15, 60, 240],
    timingPoints = [0.20, 0.30, 0.40, 0.50],
    hours = 24,
    onProgress = null,
  } = options;

  const endMs = Date.now();
  const startMs = endMs - hours * 60 * 60 * 1000;

  console.log(`[backtest] Starting: ${assets.join(',')} × ${intervals.join(',')}min × ${timingPoints.length} timings × ${hours}h`);

  // --- Phase 1: Fetch 1-second data ---
  if (onProgress) onProgress({ status: 'running', phase: 'fetch', pct: 0, message: 'Starting data fetch...' });

  const assetData = new Map(); // asset → sorted klines array

  // Need extra data for previous candles (7 × largest interval)
  const maxInterval = Math.max(...intervals);
  const dataStartMs = startMs - (8 * maxInterval * 60 * 1000);

  for (const asset of assets) {
    const klines = await fetchBinanceKlines(asset, dataStartMs, endMs, onProgress);
    assetData.set(asset, klines);
  }

  // --- Phase 2: Build windows and call Haiku ---
  const rawResults = [];
  let totalCalls = 0;

  // Calculate total expected calls for progress tracking
  let expectedCalls = 0;
  for (const asset of assets) {
    for (const intervalMin of intervals) {
      const intervalMs = intervalMin * 60 * 1000;
      const windowCount = Math.floor((endMs - startMs) / intervalMs);
      expectedCalls += windowCount * timingPoints.length;
    }
  }

  if (onProgress) onProgress({ status: 'running', phase: 'haiku', pct: 30, message: `Starting Haiku calls (${expectedCalls} total)...` });

  for (const asset of assets) {
    const klines = assetData.get(asset);
    if (!klines || klines.length === 0) {
      console.log(`[backtest] No data for ${asset}, skipping`);
      continue;
    }

    for (const intervalMin of intervals) {
      const intervalMs = intervalMin * 60 * 1000;

      // Align windows to interval boundaries
      const firstWindowStart = startMs - (startMs % intervalMs);
      const lastWindowStart = endMs - (endMs % intervalMs) - intervalMs; // exclude current incomplete window

      for (let windowStart = firstWindowStart; windowStart <= lastWindowStart; windowStart += intervalMs) {
        const windowEnd = windowStart + intervalMs;

        // Get actual direction of this candle
        const fullCandle = aggregateCandle(klines, windowStart, windowEnd);
        if (!fullCandle) continue;

        const actualDirection = fullCandle.close >= fullCandle.open ? 'UP' : 'DOWN';

        for (const timing of timingPoints) {
          const elapsedMs = Math.floor(intervalMs * timing);
          const snapshotTs = windowStart + elapsedMs;

          // Build candle text at this point in time
          const candleText = buildCandleText(klines, asset, intervalMin, windowStart, elapsedMs, 7);
          if (!candleText) continue;

          // Call Haiku
          let prediction;
          try {
            prediction = await callHaiku(asset, intervalMin, candleText);
          } catch (err) {
            console.error(`[backtest] Haiku call failed: ${err.message}`);
            // Rate limit — wait and retry once
            if (err.response && err.response.status === 429) {
              await new Promise(r => setTimeout(r, 5000));
              try {
                prediction = await callHaiku(asset, intervalMin, candleText);
              } catch {
                prediction = null;
              }
            } else {
              prediction = null;
            }
          }

          totalCalls++;

          if (prediction) {
            const priceAtCall = getPrice(klines, snapshotTs);
            const elapsedSeconds = Math.floor(elapsedMs / 1000);
            const priceDeltaPct = fullCandle.open > 0
              ? (((priceAtCall - fullCandle.open) / fullCandle.open) * 100)
              : 0;

            rawResults.push({
              asset,
              interval: intervalMin,
              windowTs: windowStart,
              timingPoint: timing,
              elapsedSeconds,
              haikuPrediction: prediction,
              actualDirection,
              correct: prediction === 'WAIT' ? null : prediction === actualDirection,
              priceAtCall,
              openPrice: fullCandle.open,
              closePrice: fullCandle.close,
              priceDeltaPct: parseFloat(priceDeltaPct.toFixed(4)),
            });
          }

          // Progress update
          if (onProgress) {
            const pct = 30 + Math.round((totalCalls / expectedCalls) * 65);
            const correctSoFar = rawResults.filter(r => r.correct === true).length;
            const decidedSoFar = rawResults.filter(r => r.correct !== null).length;
            const accStr = decidedSoFar > 0 ? `${((correctSoFar / decidedSoFar) * 100).toFixed(1)}%` : 'N/A';

            onProgress({
              status: 'running',
              phase: 'haiku',
              pct: Math.min(95, pct),
              message: `Haiku calls: ${totalCalls}/${expectedCalls} (${asset}-${intervalMin}M @ ${Math.floor(elapsedMs / 1000)}s)`,
              currentAccuracy: accStr,
            });
          }

          // 100ms delay between Haiku calls
          await new Promise(r => setTimeout(r, 100));
        }
      }
    }
  }

  // --- Phase 3: Aggregate results ---
  if (onProgress) onProgress({ status: 'running', phase: 'aggregate', pct: 96, message: 'Computing results...' });

  const decided = rawResults.filter(r => r.correct !== null);
  const totalCorrect = decided.filter(r => r.correct === true).length;
  const totalWrong = decided.filter(r => r.correct === false).length;
  const totalWait = rawResults.filter(r => r.haikuPrediction === 'WAIT').length;

  const summary = {
    totalCalls: rawResults.length,
    totalCorrect,
    totalWrong,
    totalWait,
    accuracy: rawResults.length > 0 ? parseFloat(((totalCorrect / rawResults.length) * 100).toFixed(2)) : 0,
    accuracyExWait: decided.length > 0 ? parseFloat(((totalCorrect / decided.length) * 100).toFixed(2)) : 0,
  };

  // By timeframe
  const byTimeframe = {};
  for (const intervalMin of intervals) {
    const tfResults = rawResults.filter(r => r.interval === intervalMin);
    const tfDecided = tfResults.filter(r => r.correct !== null);
    const tfCorrect = tfDecided.filter(r => r.correct === true).length;
    const tfWrong = tfDecided.filter(r => r.correct === false).length;
    const tfWait = tfResults.filter(r => r.haikuPrediction === 'WAIT').length;

    // Find best timing point
    let bestTiming = null;
    let bestAcc = -1;
    for (const tp of timingPoints) {
      const tpResults = tfDecided.filter(r => r.timingPoint === tp);
      const tpCorrect = tpResults.filter(r => r.correct === true).length;
      const tpAcc = tpResults.length > 0 ? tpCorrect / tpResults.length : 0;
      if (tpAcc > bestAcc) {
        bestAcc = tpAcc;
        bestTiming = tp;
      }
    }

    byTimeframe[String(intervalMin)] = {
      calls: tfResults.length,
      correct: tfCorrect,
      wrong: tfWrong,
      wait: tfWait,
      accuracy: tfResults.length > 0 ? parseFloat(((tfCorrect / tfResults.length) * 100).toFixed(2)) : 0,
      accuracyExWait: tfDecided.length > 0 ? parseFloat(((tfCorrect / tfDecided.length) * 100).toFixed(2)) : 0,
      bestTiming,
    };
  }

  // By timing point (per timeframe)
  const byTimingPoint = {};
  for (const intervalMin of intervals) {
    for (const tp of timingPoints) {
      const key = `${intervalMin}-${tp}`;
      const tpResults = rawResults.filter(r => r.interval === intervalMin && r.timingPoint === tp);
      const tpDecided = tpResults.filter(r => r.correct !== null);
      const tpCorrect = tpDecided.filter(r => r.correct === true).length;
      const tpWrong = tpDecided.filter(r => r.correct === false).length;

      byTimingPoint[key] = {
        calls: tpResults.length,
        correct: tpCorrect,
        wrong: tpWrong,
        accuracy: tpDecided.length > 0 ? parseFloat(((tpCorrect / tpDecided.length) * 100).toFixed(2)) : 0,
      };
    }
  }

  // By asset
  const byAsset = {};
  for (const asset of assets) {
    const aResults = rawResults.filter(r => r.asset === asset);
    const aDecided = aResults.filter(r => r.correct !== null);
    const aCorrect = aDecided.filter(r => r.correct === true).length;
    const aWrong = aDecided.filter(r => r.correct === false).length;
    const aWait = aResults.filter(r => r.haikuPrediction === 'WAIT').length;

    byAsset[asset] = {
      calls: aResults.length,
      correct: aCorrect,
      wrong: aWrong,
      wait: aWait,
      accuracy: aResults.length > 0 ? parseFloat(((aCorrect / aResults.length) * 100).toFixed(2)) : 0,
      accuracyExWait: aDecided.length > 0 ? parseFloat(((aCorrect / aDecided.length) * 100).toFixed(2)) : 0,
    };
  }

  // By direction
  const byDirection = {};
  for (const dir of ['UP', 'DOWN']) {
    const dResults = rawResults.filter(r => r.haikuPrediction === dir);
    const dCorrect = dResults.filter(r => r.correct === true).length;

    byDirection[dir] = {
      predicted: dResults.length,
      correct: dCorrect,
      accuracy: dResults.length > 0 ? parseFloat(((dCorrect / dResults.length) * 100).toFixed(2)) : 0,
    };
  }

  // Estimate cost
  const estInputTokens = rawResults.length * 350; // ~350 tokens per prompt
  const estOutputTokens = rawResults.length * 3;   // ~3 tokens per response
  const estCostUsd = parseFloat(((estInputTokens * 0.80 / 1_000_000) + (estOutputTokens * 4.00 / 1_000_000)).toFixed(4));

  if (onProgress) onProgress({ status: 'running', phase: 'aggregate', pct: 100, message: 'Done!' });

  console.log(`[backtest] Complete: ${rawResults.length} calls, ${summary.accuracyExWait}% accuracy (ex-WAIT)`);

  return {
    summary,
    byTimeframe,
    byTimingPoint,
    byAsset,
    byDirection,
    rawResults,
    config: {
      assets,
      intervals,
      timingPoints,
      hours,
      startTime: new Date(startMs).toISOString(),
      endTime: new Date(endMs).toISOString(),
    },
    cost: {
      totalCalls: rawResults.length,
      estInputTokens,
      estOutputTokens,
      estCostUsd,
    },
  };
}

module.exports = { runBacktest };
