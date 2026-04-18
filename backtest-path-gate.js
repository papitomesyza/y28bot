// Standalone read-only backtest for path-gate 80% threshold.
// Does not touch superscalp.js or any live trading code.

const fs = require('fs');
const path = require('path');
const axios = require('axios');

const TRADES_PATH = path.resolve(__dirname, 'target_trades.json');
const PRIMARY = 'https://data-api.binance.vision';
const FALLBACK = 'https://api.binance.com';
const RATE_LIMIT_MS = 200;
const SAMPLE_CAP = 100; // matches superscalp.js L134

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

async function fetchKlinesChunk(startMs, endMs) {
  const params = { symbol: 'BTCUSDT', interval: '1s', startTime: startMs, endTime: endMs, limit: 1000 };
  try {
    const r = await axios.get(PRIMARY + '/api/v3/klines', { params, timeout: 15000 });
    return r.data || [];
  } catch (e) {
    const r = await axios.get(FALLBACK + '/api/v3/klines', { params, timeout: 15000 });
    return r.data || [];
  }
}

async function fetchWindow(startSec, endSec) {
  // Returns Map<tSec, closePrice>
  const map = new Map();
  let cursorMs = startSec * 1000;
  const endMs = endSec * 1000;
  while (cursorMs <= endMs) {
    const chunkEndMs = Math.min(cursorMs + 999 * 1000, endMs);
    const rows = await fetchKlinesChunk(cursorMs, chunkEndMs);
    if (!rows.length) break;
    for (const row of rows) {
      const tSec = Math.floor(row[0] / 1000);
      map.set(tSec, parseFloat(row[4]));
    }
    const lastOpenMs = rows[rows.length - 1][0];
    if (lastOpenMs + 1000 <= cursorMs) break;
    cursorMs = lastOpenMs + 1000;
    await sleep(RATE_LIMIT_MS);
    if (rows.length < 1000) break;
  }
  return map;
}

function priceAtOrBefore(map, tSec) {
  for (let t = tSec; t >= tSec - 120; t--) {
    if (map.has(t)) return map.get(t);
  }
  return null;
}

// Matches superscalp.js checkPathGate logic (L21-45).
function computePathPct(samples, haikuDirection, openPrice) {
  if (samples.length < 3) return { skip: true, pct: null, total: samples.length };
  let inDir = 0;
  for (const s of samples) {
    if (haikuDirection === 'UP' && s.price > openPrice) inDir++;
    else if (haikuDirection === 'DOWN' && s.price < openPrice) inDir++;
  }
  return { skip: false, pct: (inDir / samples.length) * 100, total: samples.length };
}

function confusionMatrix(results, threshold) {
  let winBlock = 0, winPass = 0, loseBlock = 0, losePass = 0;
  let blockPnl = 0, passPnl = 0;
  let skipped = 0;
  for (const r of results) {
    if (r.skip) { skipped++; continue; }
    const block = r.pct > threshold;
    if (r.won) {
      if (block) { winBlock++; blockPnl += r.pnl; }
      else { winPass++; passPnl += r.pnl; }
    } else {
      if (block) { loseBlock++; blockPnl += r.pnl; }
      else { losePass++; passPnl += r.pnl; }
    }
  }
  const total = winBlock + winPass + loseBlock + losePass;
  const blockRate = total ? ((winBlock + loseBlock) / total * 100).toFixed(1) : '0';
  // P&L delta = money saved by not taking blocked trades
  // (positive delta = gate helps; gate avoids blockPnl net outcome)
  const savedByBlocking = -blockPnl; // if blockPnl is negative, we save |blockPnl|
  return {
    threshold, winBlock, winPass, loseBlock, losePass,
    blockPnl: blockPnl.toFixed(2), passPnl: passPnl.toFixed(2),
    blockRate, skipped,
    savedByBlocking: savedByBlocking.toFixed(2),
  };
}

(async () => {
  const trades = JSON.parse(fs.readFileSync(TRADES_PATH, 'utf8'));
  console.log(`Loaded ${trades.length} trades`);

  const results = [];
  for (let i = 0; i < trades.length; i++) {
    const t = trades[i];
    const side = t.side === 'Up' ? 'UP' : 'DOWN';
    // Fetch from (window_start - 5) to trade_ts, covering open-price lookup + all samples.
    let map;
    try {
      map = await fetchWindow(t.window_start - 5, t.trade_ts + 1);
    } catch (e) {
      console.error(`trade ${i}: fetch failed - ${e.message}`);
      results.push({ idx: i, skip: true, pct: null, total: 0, won: t.won, pnl: t.pnl, reason: 'fetch_failed' });
      continue;
    }

    const openPrice = priceAtOrBefore(map, t.window_start);
    if (openPrice == null) {
      results.push({ idx: i, skip: true, pct: null, total: 0, won: t.won, pnl: t.pnl, reason: 'no_open' });
      continue;
    }

    // Reconstruct priceSamplesInWindow: the bot samples at ~1 Hz during evaluate().
    // Samples arrive from window_start+1 to trade_ts (gate runs at trade_ts).
    const samples = [];
    for (let tSec = t.window_start + 1; tSec <= t.trade_ts; tSec++) {
      const p = priceAtOrBefore(map, tSec);
      if (p != null) samples.push({ timestamp: tSec * 1000, price: p });
    }
    // Apply 100-sample cap (matches superscalp.js L134 shift())
    const capped = samples.length > SAMPLE_CAP ? samples.slice(-SAMPLE_CAP) : samples;

    const r = computePathPct(capped, side, openPrice);
    results.push({ idx: i, ...r, won: t.won, pnl: t.pnl, side, tf: t.tf, openPrice, rawSampleCount: samples.length });

    if ((i + 1) % 5 === 0) console.log(`  processed ${i + 1}/${trades.length}`);
    await sleep(100);
  }

  // --- STEP 5: confusion matrix at 80% ---
  console.log('\n=== STEP 5: CONFUSION MATRIX @ 80% ===');
  const m80 = confusionMatrix(results, 80);
  console.log(`Total analyzed: ${results.length - m80.skipped} (skipped ${m80.skipped})`);
  console.log(`                WOULD_BLOCK   WOULD_PASS`);
  console.log(`Winners         ${String(m80.winBlock).padStart(11)}   ${String(m80.winPass).padStart(10)}`);
  console.log(`Losers          ${String(m80.loseBlock).padStart(11)}   ${String(m80.losePass).padStart(10)}`);
  console.log(`Block P&L:      $${m80.blockPnl}`);
  console.log(`Pass P&L:       $${m80.passPnl}`);
  console.log(`Block rate:     ${m80.blockRate}%`);
  console.log(`Saved by block: $${m80.savedByBlocking}`);

  // --- STEP 6: threshold sweep ---
  console.log('\n=== STEP 6: THRESHOLD SWEEP ===');
  console.log('Thr  WinBlock WinPass LoseBlock LosePass  BlockPnl  PassPnl  BlockRate  Saved');
  const sweep = [70, 75, 80, 85, 90];
  const matrices = [];
  for (const thr of sweep) {
    const m = confusionMatrix(results, thr);
    matrices.push(m);
    console.log(
      `${String(thr).padStart(3)}% ${String(m.winBlock).padStart(8)} ${String(m.winPass).padStart(7)} ${String(m.loseBlock).padStart(9)} ${String(m.losePass).padStart(8)}  $${String(m.blockPnl).padStart(7)} $${String(m.passPnl).padStart(7)}    ${String(m.blockRate).padStart(4)}%   $${m.savedByBlocking}`
    );
  }

  // Best threshold by savings (larger savedByBlocking = better)
  const best = matrices.reduce((a, b) => (parseFloat(b.savedByBlocking) > parseFloat(a.savedByBlocking) ? b : a));
  console.log(`\nBest threshold by savings: ${best.threshold}% (saves $${best.savedByBlocking})`);

  // --- VERDICT ---
  const m80pick = matrices.find(m => m.threshold === 80);
  const savings80 = parseFloat(m80pick.savedByBlocking);
  const savingsBest = parseFloat(best.savedByBlocking);
  const delta = savingsBest - savings80;
  console.log('\n=== VERDICT ===');
  if (savingsBest <= 0) {
    console.log('DO NOT DEPLOY');
  } else if (best.threshold === 80 || delta < 1.0) {
    console.log(`DEPLOY AT 80% (saves $${savings80})`);
  } else {
    console.log(`DEPLOY AT ${best.threshold}% (saves $${savingsBest}, +$${delta.toFixed(2)} over 80%)`);
  }

  // Dump per-trade detail
  fs.writeFileSync(path.resolve(__dirname, 'path-gate-backtest-results.json'), JSON.stringify(results, null, 2));
  console.log('\nPer-trade results written to path-gate-backtest-results.json');
})().catch(e => { console.error(e); process.exit(1); });
