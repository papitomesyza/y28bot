/**
 * analyze-historical.js
 *
 * One-off analysis: what entry conditions separated winners from losers
 * in the $0.40-$0.56 ask band with ~50-60% elapsed timing.
 *
 * READ-ONLY. Does not touch DB, live bot, Polymarket, Anthropic, or CLOB.
 * Only hits Binance public klines API.
 *
 * Run: node server/analyze-historical.js
 */

const fs = require('fs');
const path = require('path');
const axios = require('axios');

// ---------- Trade loading ----------

const CANDIDATE_PATHS = [
  '/tmp/target_trades.json',
  path.resolve(__dirname, '..', 'target_trades.json'),
  path.resolve(__dirname, 'target_trades.json'),
];

// Fallback placeholder. If no JSON file is found, the script exits with a
// clear message telling the user where to drop target_trades.json.
const HARDCODED_TRADES = [
  // { tf: "5M", window_start: 0, trade_ts: 0, elapsed_sec: 0,
  //   elapsed_pct: 0, side: "Up", price: 0.50, shares: 0, cost: 0,
  //   won: false, pnl: 0 },
];

function loadTrades() {
  for (const p of CANDIDATE_PATHS) {
    try {
      if (fs.existsSync(p)) {
        const raw = fs.readFileSync(p, 'utf8');
        const data = JSON.parse(raw);
        if (Array.isArray(data) && data.length > 0) {
          console.log(`Loaded ${data.length} trades from ${p}`);
          return data;
        }
      }
    } catch (e) {
      console.warn(`Could not read ${p}: ${e.message}`);
    }
  }
  if (HARDCODED_TRADES.length > 0) {
    console.log(`Loaded ${HARDCODED_TRADES.length} hardcoded trades`);
    return HARDCODED_TRADES;
  }
  console.error('No target_trades.json found in any of:');
  for (const p of CANDIDATE_PATHS) console.error('  ' + p);
  console.error('\nDrop a JSON array of 47 trade records at one of those paths and re-run.');
  console.error('Expected fields per trade: tf, window_start, trade_ts, elapsed_sec,');
  console.error('elapsed_pct, side, price, shares, cost, won, pnl');
  process.exit(1);
}

// ---------- Binance klines ----------

const PRIMARY_BASE = 'https://data-api.binance.vision';
const FALLBACK_BASE = 'https://api.binance.com';
const RATE_LIMIT_MS = 150;

// Map of (startTimeSec) -> kline row. Dedupes overlapping ranges.
const klineCache = new Map();

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

async function fetchKlinesChunk(startMs, endMs) {
  const params = {
    symbol: 'BTCUSDT',
    interval: '1s',
    startTime: startMs,
    endTime: endMs,
    limit: 1000,
  };
  try {
    const r = await axios.get(PRIMARY_BASE + '/api/v3/klines', {
      params,
      timeout: 15000,
    });
    return r.data || [];
  } catch (e) {
    const r = await axios.get(FALLBACK_BASE + '/api/v3/klines', {
      params,
      timeout: 15000,
    });
    return r.data || [];
  }
}

async function fetchRange(startSec, endSec) {
  // Returns sorted array of { tSec, close } covering [startSec, endSec].
  // Uses paginated 1-second klines and caches by tSec.
  const needed = [];
  for (let t = startSec; t <= endSec; t++) {
    if (!klineCache.has(t)) needed.push(t);
  }
  if (needed.length === 0) {
    return collectFromCache(startSec, endSec);
  }

  let cursorMs = startSec * 1000;
  const endMs = endSec * 1000;
  // Binance 1s klines: limit=1000 covers 1000 seconds. Paginate.
  while (cursorMs <= endMs) {
    const chunkEndMs = Math.min(cursorMs + 999 * 1000, endMs);
    const rows = await fetchKlinesChunk(cursorMs, chunkEndMs);
    if (!rows.length) break;
    for (const row of rows) {
      // row[0] = open time ms, row[4] = close price
      const tSec = Math.floor(row[0] / 1000);
      const close = parseFloat(row[4]);
      if (!klineCache.has(tSec)) klineCache.set(tSec, close);
    }
    const lastOpenMs = rows[rows.length - 1][0];
    if (lastOpenMs + 1000 <= cursorMs) break; // no progress guard
    cursorMs = lastOpenMs + 1000;
    await sleep(RATE_LIMIT_MS);
    if (rows.length < 1000) break; // reached end
  }

  return collectFromCache(startSec, endSec);
}

function collectFromCache(startSec, endSec) {
  const out = [];
  for (let t = startSec; t <= endSec; t++) {
    if (klineCache.has(t)) out.push({ tSec: t, close: klineCache.get(t) });
  }
  return out;
}

function priceAtOrBefore(series, tSec) {
  // Binary search descending from tSec for first kline with tSec <= target.
  for (let t = tSec; t >= tSec - 120; t--) {
    if (klineCache.has(t)) return klineCache.get(t);
  }
  // Fall back to first in series
  return series.length ? series[0].close : null;
}

// ---------- Feature math ----------

function computeEMA(values, period) {
  if (values.length < period) return null;
  const k = 2 / (period + 1);
  let sma = 0;
  for (let i = 0; i < period; i++) sma += values[i];
  sma /= period;
  let ema = sma;
  for (let i = period; i < values.length; i++) {
    ema = values[i] * k + ema * (1 - k);
  }
  return ema;
}

function computeFeatures(trade, series) {
  const { window_start, trade_ts, side } = trade;

  const priceAtOpen = priceAtOrBefore(series, window_start);
  const priceAtEntry = priceAtOrBefore(series, trade_ts);
  if (priceAtOpen == null || priceAtEntry == null) return null;

  const priceDeltaPct = ((priceAtEntry - priceAtOpen) / priceAtOpen) * 100;
  const directionalDeltaPct = side === 'Up' ? priceDeltaPct : -priceDeltaPct;

  // EMA inputs: closes strictly before window_start.
  const preCloses21 = [];
  for (let t = window_start - 21; t < window_start; t++) {
    if (klineCache.has(t)) preCloses21.push(klineCache.get(t));
  }
  const preCloses9 = [];
  for (let t = window_start - 9; t < window_start; t++) {
    if (klineCache.has(t)) preCloses9.push(klineCache.get(t));
  }
  const ema9 = computeEMA(preCloses9, 9);
  const ema21 = computeEMA(preCloses21, 21);
  const emaSlopePct =
    ema9 != null && ema21 != null && ema21 !== 0
      ? ((ema9 - ema21) / ema21) * 100
      : null;
  const emaDirMatch =
    emaSlopePct == null
      ? null
      : (emaSlopePct > 0 && side === 'Up') ||
        (emaSlopePct < 0 && side === 'Down');

  // Live candle: window_start .. trade_ts
  let liveMin = Infinity;
  let liveMax = -Infinity;
  let ticksInDir = 0;
  let ticksTotal = 0;
  for (let t = window_start; t <= trade_ts; t++) {
    if (!klineCache.has(t)) continue;
    const p = klineCache.get(t);
    if (p < liveMin) liveMin = p;
    if (p > liveMax) liveMax = p;
    ticksTotal += 1;
    if (side === 'Up' && p > priceAtOpen) ticksInDir += 1;
    if (side === 'Down' && p < priceAtOpen) ticksInDir += 1;
  }
  const liveRangePct =
    ticksTotal > 0 ? ((liveMax - liveMin) / priceAtOpen) * 100 : null;
  const pathInDirPct = ticksTotal > 0 ? (ticksInDir / ticksTotal) * 100 : null;

  return {
    price_at_open: priceAtOpen,
    price_at_entry: priceAtEntry,
    price_delta_pct: priceDeltaPct,
    directional_delta_pct: directionalDeltaPct,
    ema9_at_open: ema9,
    ema21_at_open: ema21,
    ema_slope_at_open: emaSlopePct,
    ema_direction_match: emaDirMatch,
    live_candle_range_pct: liveRangePct,
    path_in_haiku_direction_pct: pathInDirPct,
  };
}

// ---------- Stats helpers ----------

function mean(arr) {
  if (!arr.length) return null;
  return arr.reduce((a, b) => a + b, 0) / arr.length;
}
function median(arr) {
  if (!arr.length) return null;
  const s = [...arr].sort((a, b) => a - b);
  const mid = Math.floor(s.length / 2);
  return s.length % 2 ? s[mid] : (s[mid - 1] + s[mid]) / 2;
}
function stddev(arr) {
  if (arr.length < 2) return null;
  const m = mean(arr);
  const v = arr.reduce((a, b) => a + (b - m) ** 2, 0) / (arr.length - 1);
  return Math.sqrt(v);
}
function fmt(v, d = 4) {
  if (v == null || Number.isNaN(v)) return 'n/a';
  if (typeof v === 'boolean') return v ? 'true' : 'false';
  return Number(v).toFixed(d);
}

function printDistributionTable(featName, winVals, loseVals) {
  const row = (label, arr) => {
    const nums = arr.filter((v) => v != null && !Number.isNaN(v));
    return (
      `${label.padEnd(10)}` +
      ` n=${String(nums.length).padStart(3)}` +
      ` mean=${fmt(mean(nums)).padStart(10)}` +
      ` median=${fmt(median(nums)).padStart(10)}` +
      ` min=${fmt(Math.min(...nums)).padStart(10)}` +
      ` max=${fmt(Math.max(...nums)).padStart(10)}` +
      ` sd=${fmt(stddev(nums)).padStart(10)}`
    );
  };
  console.log(`\n-- ${featName} --`);
  console.log(row('winners', winVals));
  console.log(row('losers ', loseVals));
}

// ---------- Rule evaluation ----------

function evalRule(trades, predicate, description) {
  const kept = trades.filter((t) => {
    try {
      return predicate(t);
    } catch (e) {
      return false;
    }
  });
  const n = kept.length;
  if (n === 0) {
    return { description, n: 0, wr: 0, pnl: 0, cost: 0, roi: 0 };
  }
  const wins = kept.filter((t) => t.won).length;
  const pnl = kept.reduce((a, b) => a + (b.pnl || 0), 0);
  const cost = kept.reduce((a, b) => a + (b.cost || 0), 0);
  return {
    description,
    n,
    wr: (wins / n) * 100,
    pnl,
    cost,
    roi: cost > 0 ? (pnl / cost) * 100 : 0,
  };
}

function sweepGte(trades, feature, lo, hi, step, label) {
  const rules = [];
  for (let th = lo; th <= hi + 1e-9; th += step) {
    const thr = Math.round(th * 1e6) / 1e6;
    rules.push(
      evalRule(
        trades,
        (t) => t.features && t.features[feature] != null && t.features[feature] >= thr,
        `${label} >= ${thr.toFixed(4)}`
      )
    );
  }
  return rules;
}
function sweepLte(trades, feature, lo, hi, step, label) {
  const rules = [];
  for (let th = lo; th <= hi + 1e-9; th += step) {
    const thr = Math.round(th * 1e6) / 1e6;
    rules.push(
      evalRule(
        trades,
        (t) => t.features && t.features[feature] != null && t.features[feature] <= thr,
        `${label} <= ${thr.toFixed(4)}`
      )
    );
  }
  return rules;
}

function printRuleTable(rows, topN = 10) {
  const sorted = [...rows]
    .filter((r) => r.n >= 5) // ignore tiny samples
    .sort((a, b) => b.pnl - a.pnl)
    .slice(0, topN);
  console.log(
    'rule'.padEnd(50) +
      'n'.padStart(4) +
      'WR%'.padStart(8) +
      'P&L'.padStart(10) +
      'cost'.padStart(10) +
      'ROI%'.padStart(10)
  );
  console.log('-'.repeat(92));
  for (const r of sorted) {
    console.log(
      r.description.padEnd(50) +
        String(r.n).padStart(4) +
        r.wr.toFixed(1).padStart(8) +
        r.pnl.toFixed(2).padStart(10) +
        r.cost.toFixed(2).padStart(10) +
        r.roi.toFixed(1).padStart(10)
    );
  }
  return sorted;
}

// ---------- Main ----------

async function main() {
  const trades = loadTrades();

  const winCount = trades.filter((t) => t.won).length;
  const totalPnl = trades.reduce((a, b) => a + (b.pnl || 0), 0);
  const totalCost = trades.reduce((a, b) => a + (b.cost || 0), 0);
  console.log(
    `\nBaseline: ${trades.length} trades, ${winCount} wins ` +
      `(${((winCount / trades.length) * 100).toFixed(1)}%), ` +
      `total P&L ${totalPnl.toFixed(2)}, cost ${totalCost.toFixed(2)}, ` +
      `ROI ${totalCost > 0 ? ((totalPnl / totalCost) * 100).toFixed(1) : 'n/a'}%`
  );

  // Step 2: fetch klines per trade, compute features.
  const skipped = [];
  for (let i = 0; i < trades.length; i++) {
    const t = trades[i];
    const startSec = t.window_start - 600;
    const endSec = t.trade_ts + 60;
    try {
      const series = await fetchRange(startSec, endSec);
      if (!series.length) {
        skipped.push({ i, reason: 'no klines' });
        t.features = null;
      } else {
        t.features = computeFeatures(t, series);
        if (!t.features) skipped.push({ i, reason: 'feature compute failed' });
      }
    } catch (e) {
      skipped.push({ i, reason: e.message });
      t.features = null;
    }
    if ((i + 1) % 1 === 0) {
      process.stdout.write(`Processed ${i + 1}/${trades.length}\r`);
    }
  }
  console.log(`\nProcessed ${trades.length} trades. Skipped: ${skipped.length}`);
  if (skipped.length) {
    for (const s of skipped) console.log(`  trade #${s.i}: ${s.reason}`);
  }

  const usable = trades.filter((t) => t.features);
  const winners = usable.filter((t) => t.won);
  const losers = usable.filter((t) => !t.won);

  // Step 4: distribution tables
  console.log(
    `\n=== Feature distributions (${winners.length} winners vs ${losers.length} losers) ===`
  );
  const featureKeys = [
    'price_delta_pct',
    'directional_delta_pct',
    'ema_slope_at_open',
    'live_candle_range_pct',
    'path_in_haiku_direction_pct',
  ];
  for (const f of featureKeys) {
    printDistributionTable(
      f,
      winners.map((t) => t.features[f]).filter((v) => v != null),
      losers.map((t) => t.features[f]).filter((v) => v != null)
    );
  }

  // ema_direction_match: boolean
  const winMatchTrue = winners.filter((t) => t.features.ema_direction_match === true).length;
  const winMatchFalse = winners.filter((t) => t.features.ema_direction_match === false).length;
  const losMatchTrue = losers.filter((t) => t.features.ema_direction_match === true).length;
  const losMatchFalse = losers.filter((t) => t.features.ema_direction_match === false).length;
  console.log(`\n-- ema_direction_match --`);
  console.log(
    `winners  true=${winMatchTrue}  false=${winMatchFalse}  ` +
      `win-rate-given-true=${
        winMatchTrue + losMatchTrue > 0
          ? ((winMatchTrue / (winMatchTrue + losMatchTrue)) * 100).toFixed(1)
          : 'n/a'
      }%  ` +
      `win-rate-given-false=${
        winMatchFalse + losMatchFalse > 0
          ? ((winMatchFalse / (winMatchFalse + losMatchFalse)) * 100).toFixed(1)
          : 'n/a'
      }%`
  );

  // Step 5: single-feature rule sweeps
  const allRules = [];
  allRules.push(
    ...sweepGte(usable, 'directional_delta_pct', -0.10, 0.20, 0.01, 'directional_delta_pct'),
    ...sweepLte(usable, 'directional_delta_pct', -0.10, 0.20, 0.01, 'directional_delta_pct')
  );
  allRules.push(
    ...sweepGte(usable, 'ema_slope_at_open', -0.05, 0.05, 0.005, 'ema_slope_at_open'),
    ...sweepLte(usable, 'ema_slope_at_open', -0.05, 0.05, 0.005, 'ema_slope_at_open')
  );
  allRules.push(
    ...sweepGte(usable, 'path_in_haiku_direction_pct', 0, 100, 10, 'path_in_haiku_direction_pct'),
    ...sweepLte(usable, 'path_in_haiku_direction_pct', 0, 100, 10, 'path_in_haiku_direction_pct')
  );
  allRules.push(
    evalRule(usable, (t) => t.features.ema_direction_match === true, 'ema_direction_match == true'),
    evalRule(usable, (t) => t.features.ema_direction_match === false, 'ema_direction_match == false')
  );
  // Optional extras: live_candle_range_pct sweep (for completeness)
  allRules.push(
    ...sweepGte(usable, 'live_candle_range_pct', 0, 0.5, 0.05, 'live_candle_range_pct'),
    ...sweepLte(usable, 'live_candle_range_pct', 0, 0.5, 0.05, 'live_candle_range_pct')
  );

  console.log('\n=== Top 10 single-feature rules by total P&L (n>=5) ===');
  const topSingles = printRuleTable(allRules, 10);

  // Step 6: pair combinations of top singles (AND).
  // Use the 6 best distinct single rules as seeds.
  const seeds = topSingles.slice(0, 6);
  const combos = [];
  for (let i = 0; i < seeds.length; i++) {
    for (let j = i + 1; j < seeds.length; j++) {
      const a = seeds[i];
      const b = seeds[j];
      const predA = buildPredicate(a.description);
      const predB = buildPredicate(b.description);
      if (!predA || !predB) continue;
      const desc = `${a.description} AND ${b.description}`;
      combos.push(evalRule(usable, (t) => predA(t) && predB(t), desc));
    }
  }
  console.log('\n=== Top 5 combined (AND) rules by total P&L (n>=5) ===');
  const topCombos = printRuleTable(combos, 5);

  // Step 7: summary
  console.log('\n=== SUMMARY ===');
  console.log(
    `Baseline: ${trades.length} trades, ${winCount} wins ` +
      `(${((winCount / trades.length) * 100).toFixed(1)}%), P&L ${totalPnl.toFixed(2)}`
  );
  console.log(`Usable after feature computation: ${usable.length}`);
  if (topSingles.length) {
    const best = topSingles[0];
    console.log(
      `\nBest single rule: ${best.description}  ` +
        `n=${best.n}  WR=${best.wr.toFixed(1)}%  P&L=${best.pnl.toFixed(2)}  ROI=${best.roi.toFixed(1)}%`
    );
  }
  if (topCombos.length) {
    const best = topCombos[0];
    console.log(
      `Best combined rule: ${best.description}  ` +
        `n=${best.n}  WR=${best.wr.toFixed(1)}%  P&L=${best.pnl.toFixed(2)}  ROI=${best.roi.toFixed(1)}%`
    );
  }
  console.log(
    '\nInterpretation: compare the ROI and sample size of the top rules against the baseline.'
  );
  console.log(
    'A rule that keeps >=50% of trades, raises WR by >=10pp, and grows total P&L is preferred.'
  );
  console.log(
    'Rules that eliminate too many trades may be overfit — weigh n and ROI together.'
  );
}

// Parses rule descriptions produced by the sweep helpers back into predicates.
// Format examples:
//   "directional_delta_pct >= 0.0100"
//   "ema_slope_at_open <= -0.0050"
//   "ema_direction_match == true"
function buildPredicate(desc) {
  let m = desc.match(/^(\w+)\s*(>=|<=|==)\s*(.+)$/);
  if (!m) return null;
  const [, feat, op, rhsRaw] = m;
  if (op === '==') {
    const rhs = rhsRaw.trim() === 'true';
    return (t) => t.features && t.features[feat] === rhs;
  }
  const rhs = parseFloat(rhsRaw);
  if (Number.isNaN(rhs)) return null;
  if (op === '>=') {
    return (t) => t.features && t.features[feat] != null && t.features[feat] >= rhs;
  }
  return (t) => t.features && t.features[feat] != null && t.features[feat] <= rhs;
}

main().catch((e) => {
  console.error('Fatal:', e);
  process.exit(1);
});
