const fs = require('fs');
const path = require('path');

const LOG_DIR = path.join(__dirname, '..', 'data', 'logs');
fs.mkdirSync(LOG_DIR, { recursive: true });
const LOG_FILE = path.join(LOG_DIR, 'bot.log');
const LOG_FILE_1 = path.join(LOG_DIR, 'bot.log.1');
const MAX_LOG_FILE_SIZE = 50 * 1024 * 1024; // 50MB

let logFileSize = 0;
try { logFileSize = fs.statSync(LOG_FILE).size; } catch { logFileSize = 0; }
let logStream = fs.createWriteStream(LOG_FILE, { flags: 'a' });

function rotateLogFile() {
  logStream.end();
  try { fs.renameSync(LOG_FILE, LOG_FILE_1); } catch {}
  logStream = fs.createWriteStream(LOG_FILE, { flags: 'a' });
  logFileSize = 0;
}

// --- Log buffer for /api/logs (dashboard) ---
global.logBuffer = [];
const MAX_LOG_BUFFER = 5000;
const _origLog = console.log;
const _origErr = console.error;

function formatArg(a) {
  if (typeof a === 'string') return a;
  if (a instanceof Error) return a.stack || a.message;
  try { return JSON.stringify(a); } catch { return String(a); }
}

function writeLogLine(line) {
  const buf = Buffer.byteLength(line + '\n', 'utf8');
  logStream.write(line + '\n');
  logFileSize += buf;
  if (logFileSize > MAX_LOG_FILE_SIZE) rotateLogFile();
}

console.log = (...args) => {
  _origLog.apply(console, args);
  const ts = new Date().toISOString();
  const msg = args.map(formatArg).join(' ');
  global.logBuffer.push({ timestamp: ts, level: 'info', message: msg });
  if (global.logBuffer.length > MAX_LOG_BUFFER) global.logBuffer.shift();
  writeLogLine(`[${ts}] [info] ${msg}`);
};

console.error = (...args) => {
  _origErr.apply(console, args);
  const ts = new Date().toISOString();
  const msg = args.map(formatArg).join(' ');
  global.logBuffer.push({ timestamp: ts, level: 'error', message: msg });
  if (global.logBuffer.length > MAX_LOG_BUFFER) global.logBuffer.shift();
  writeLogLine(`[${ts}] [error] ${msg}`);
};

const express = require('express');
const cors = require('cors');
const config = require('./config');
const db = require('./db');
const auth = require('./auth');
const { coinbaseWS } = require('./coinbase-ws');
const { priceTracker } = require('./price-tracker');
const { volatilityTracker } = require('./volatility');
const marketDiscovery = require('./market-discovery');
const { superScalp } = require('./superscalp');
const { orderExecutor } = require('./order-executor');
const { resolver } = require('./resolver');
const { claimer } = require('./claimer');
const notifications = require('./notifications');
const { polymarketRTDS } = require('./polymarket-ws');
const { candleEngine } = require('./candle-engine');
const { TIERS, getTierByInterval, buildV2Lanes } = require('./tier-config');
const { dcaEngine } = require('./dca-engine');
const positionManager = require('./position-manager');
const trendObserver = require('./trend-observer');

// --- Log rotation is size-based (50MB) — see rotateLogFile() above ---

let startupComplete = false;
let scalpInterval = null;

// --- Pause state (persisted in settings DB, global for resolver access) ---
global.botPaused = false;
const pausedRaw = db.getSetting('paused');
if (pausedRaw === 'true') {
  global.botPaused = true;
  console.log('[boot] Bot starting in PAUSED state (restored from DB)');
}

// Mutable runtime config overlay — modules can check this for live-adjustable settings
global.runtimeConfig = {
  irrevThreshold: config.irrevThresholds.base,
  irrevStack2: config.irrevThresholds.stack2,
  irrevStack3: config.irrevThresholds.stack3,
  dryRun: config.dryRun,
  laneEnabled: {},
  maxTradeSize: config.maxTradeSize,
  maxLossPerTrade: config.maxLossPerTrade,
  minShares: config.minShares,
  spreadScalpIrrev: config.spreadScalpIrrev,
  limitOrderTimeoutMs: config.limitOrderTimeoutMs,
  gateEnabled: true,
  maxAskPrice: 0.85,
};

// During startup, let crashes propagate so broken config is caught immediately
process.on('uncaughtException', (err) => {
  console.error('[fatal] Uncaught exception:', err);
  notifications.error(err.message);
  if (!startupComplete) process.exit(1);
});

process.on('unhandledRejection', (reason) => {
  console.error('[fatal] Unhandled rejection:', reason);
  notifications.error(reason instanceof Error ? reason.message : String(reason));
  if (!startupComplete) process.exit(1);
});

const app = express();

app.use(express.json());

// CORS — allow all origins (dashboard served from same server, JWT handles security)
app.use(cors({ origin: true, credentials: true }));

// --- Public routes ---

app.post('/api/login', (req, res) => {
  const { password } = req.body;
  if (!password) return res.status(400).json({ error: 'Password required' });

  const token = auth.login(password);
  if (!token) return res.status(401).json({ error: 'Invalid password' });

  res.json({ token });
});

app.get('/api/health', (req, res) => {
  res.json({ status: 'ok', uptime: process.uptime(), version: '1.0.0' });
});

// --- Protected routes ---

app.get('/api/pool', auth.authMiddleware, (req, res) => {
  res.json({ balance: db.getPoolBalance() });
});

app.get('/api/trades', auth.authMiddleware, (req, res) => {
  // Return ALL trades — no filters, no exclusions. Frontend tabs handle filtering.
  const allTrades = db.getDb().prepare('SELECT * FROM trades ORDER BY id DESC LIMIT 100').all();
  res.json(allTrades);
});

app.get('/api/prices', auth.authMiddleware, (req, res) => {
  res.json(coinbaseWS.prices);
});

app.get('/api/market/:laneId', auth.authMiddleware, async (req, res) => {
  const lane = config.lanes.find((l) => l.id === req.params.laneId);
  if (!lane) return res.status(400).json({ error: 'Invalid laneId' });

  const now = Math.floor(Date.now() / 1000);
  const windowTs = now - (now % (lane.interval * 60));

  const market = await marketDiscovery.findMarket(lane.id, windowTs, lane.interval);
  if (!market) return res.status(404).json({ error: 'Market not found' });

  res.json(market);
});

app.get('/api/windows', auth.authMiddleware, (req, res) => {
  const windows = {};
  for (const lane of config.lanes) {
    const windowTs = priceTracker.getWindowTs(lane.interval);
    const remaining = priceTracker.getRemainingSeconds(lane.interval);
    const win = priceTracker.getWindow(lane.id, windowTs);
    windows[lane.id] = {
      windowTs,
      remaining,
      openPrice: win ? win.openPrice : null,
      spotPrice: coinbaseWS.getPrice(lane.asset),
    };
  }
  res.json(windows);
});

app.get('/api/superscalp/status', auth.authMiddleware, (req, res) => {
  const status = {};
  for (const lane of config.lanes) {
    const currentPrice = coinbaseWS.getPrice(lane.asset);
    const windowTs = priceTracker.getWindowTs(lane.interval);
    const remainingSeconds = priceTracker.getRemainingSeconds(lane.interval);
    const totalSeconds = lane.interval * 60;
    const win = priceTracker.getWindow(lane.id, windowTs);
    const openPrice = win ? win.openPrice : null;

    let irrev = 0;
    let direction = null;
    if (currentPrice != null && openPrice != null) {
      irrev = superScalp.calculateIrrev(lane.asset, openPrice, currentPrice, remainingSeconds, totalSeconds);
      direction = superScalp.getDirection(openPrice, currentPrice);
    }

    status[lane.id] = {
      laneId: lane.id,
      currentPrice,
      openPrice,
      irrev: parseFloat(irrev.toFixed(3)),
      direction,
      remainingSeconds,
      stackLevel: superScalp.getStackLevel(lane.id),
      volatility: volatilityTracker.getVolatility(lane.asset),
    };
  }
  res.json(status);
});

app.get('/api/trades/summary', auth.authMiddleware, (req, res) => {
  const raw = db.getDb();
  const totals = raw.prepare(`
    SELECT
      COUNT(*) AS total,
      SUM(CASE WHEN result = 'won' THEN 1 ELSE 0 END) AS wins,
      SUM(CASE WHEN result = 'lost' THEN 1 ELSE 0 END) AS losses,
      SUM(CASE WHEN result = 'pending' THEN 1 ELSE 0 END) AS pending,
      SUM(CASE WHEN result = 'expired' THEN 1 ELSE 0 END) AS expired,
      SUM(CASE WHEN result = 'burned' THEN 1 ELSE 0 END) AS burned,
      COALESCE(SUM(CASE WHEN result != 'burned' THEN pnl ELSE 0 END), 0) AS totalPnl
    FROM trades
  `).get();

  const todayStart = new Date();
  todayStart.setUTCHours(0, 0, 0, 0);
  const todayPnl = raw.prepare(`
    SELECT COALESCE(SUM(pnl), 0) AS todayPnl
    FROM trades
    WHERE created_at >= ? AND result IN ('won', 'lost')
  `).get(todayStart.toISOString()).todayPnl;

  const decided = totals.wins + totals.losses + totals.burned;
  res.json({
    total: totals.total,
    wins: totals.wins,
    losses: totals.losses,
    pending: totals.pending,
    expired: totals.expired,
    burned: totals.burned,
    winRate: decided > 0 ? parseFloat((totals.wins / decided).toFixed(4)) : 0,
    totalPnl: parseFloat(totals.totalPnl.toFixed(2)),
    todayPnl: parseFloat(todayPnl.toFixed(2)),
    poolBalance: db.getPoolBalance(),
  });
});

app.get('/api/trades/won', auth.authMiddleware, (req, res) => {
  res.json(db.getTrades({ result: 'won', claimed: 0 }));
});

// --- POST /api/trades/:tradeId/bookmark (toggle bookmark — only one at a time) ---
app.post('/api/trades/:tradeId/bookmark', auth.authMiddleware, (req, res) => {
  const tradeId = parseInt(req.params.tradeId, 10);
  const { bookmarked } = req.body;
  const raw = db.getDb();

  if (bookmarked) {
    // Clear all existing bookmarks, then set the new one
    raw.prepare('UPDATE trades SET bookmarked = 0 WHERE bookmarked = 1').run();
    raw.prepare('UPDATE trades SET bookmarked = 1 WHERE id = ?').run(tradeId);
  } else {
    raw.prepare('UPDATE trades SET bookmarked = 0 WHERE id = ?').run(tradeId);
  }

  res.json({ ok: true, tradeId, bookmarked: bookmarked ? 1 : 0 });
});

// --- POST /api/trades/:id/update-result (manual win/loss/delete) ---
app.post('/api/trades/:id/update-result', auth.authMiddleware, (req, res) => {
  const tradeId = parseInt(req.params.id, 10);
  const { action } = req.body;

  if (!['win', 'loss', 'delete'].includes(action)) {
    return res.status(400).json({ success: false, error: 'Invalid action. Must be win, loss, or delete.' });
  }

  const trade = db.getTradeById(tradeId);
  if (!trade) {
    return res.status(404).json({ success: false, error: `Trade #${tradeId} not found` });
  }

  const raw = db.getDb();

  if (action === 'delete') {
    raw.prepare('DELETE FROM trades WHERE id = ?').run(tradeId);
    console.log(`[admin] Trade #${tradeId} deleted`);
    return res.json({ success: true, message: 'Trade deleted' });
  }

  if (action === 'win') {
    const pnl = (trade.shares * 1.0) - trade.cost;
    db.updateTrade(tradeId, { result: 'won', pnl, close_price: null });
    console.log(`[admin] Trade #${tradeId} manually marked as won`);

    // Recalculate pool balance from wallet via RPC (next sync) — adjust pool by pnl delta
    const oldPnl = trade.pnl || 0;
    const pnlDelta = pnl - oldPnl;
    const poolBalance = db.getPoolBalance();
    db.updatePoolBalance(poolBalance + pnlDelta);
  }

  if (action === 'loss') {
    const pnl = -trade.cost;
    db.updateTrade(tradeId, { result: 'lost', pnl, close_price: null });
    console.log(`[admin] Trade #${tradeId} manually marked as lost`);

    const oldPnl = trade.pnl || 0;
    const pnlDelta = pnl - oldPnl;
    const poolBalance = db.getPoolBalance();
    db.updatePoolBalance(poolBalance + pnlDelta);
  }

  res.json({ success: true, message: 'Trade updated' });
});

app.post('/api/pause', (req, res) => {
  const { password } = req.body;
  if (!password || password !== config.jwtSecret) {
    return res.status(401).json({ error: 'Invalid password' });
  }
  global.botPaused = !global.botPaused;
  db.setSetting('paused', String(global.botPaused));
  if (global.botPaused) {
    console.log('[bot] \u23F8 Bot PAUSED by user');
    notifications.botPaused();
  } else {
    console.log('[bot] \u25B6 Bot RESUMED by user');
    notifications.botResumed();
  }
  res.json({ paused: global.botPaused });
});

// --- GET /api/positions (Data API redeemable positions) ---
app.get('/api/positions', auth.authMiddleware, async (req, res) => {
  try {
    const data = await claimer.getRedeemablePositions();
    res.json(data);
  } catch (err) {
    console.error('[api] /api/positions error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

app.post('/api/claim/speedup/:tradeId', auth.authMiddleware, async (req, res) => {
  const result = await claimer.speedUpClaim(parseInt(req.params.tradeId, 10));
  if (!result.success) {
    return res.status(400).json(result);
  }
  res.json(result);
});

app.post('/api/claim/:tradeId', auth.authMiddleware, async (req, res) => {
  const result = await claimer.claimWinnings(parseInt(req.params.tradeId, 10));
  if (!result.success) {
    return res.status(400).json(result);
  }
  res.json(result);
});

// --- POST /api/claim-all (claim all redeemable positions from Data API) ---
app.post('/api/claim-all', auth.authMiddleware, async (req, res) => {
  const result = await claimer.claimAll();
  res.json(result);
});

// --- POST /api/claim-direct (claim by conditionId + outcomeIndex, no trade record needed) ---
app.post('/api/claim-direct', auth.authMiddleware, async (req, res) => {
  const { conditionId, outcomeIndex } = req.body;
  if (!conditionId) {
    return res.status(400).json({ success: false, error: 'Missing conditionId' });
  }
  const oi = typeof outcomeIndex === 'number' ? outcomeIndex : parseInt(outcomeIndex, 10);
  if (isNaN(oi) || (oi !== 0 && oi !== 1)) {
    return res.status(400).json({ success: false, error: 'outcomeIndex must be 0 or 1' });
  }
  const result = await claimer.claimDirect(conditionId, oi);
  if (!result.success) {
    return res.status(400).json(result);
  }
  res.json(result);
});


// --- GET /api/status (combined dashboard endpoint) ---

app.get('/api/status', auth.authMiddleware, (req, res) => {
  const pool = db.getPoolBalance();

  // Lanes
  const lanesStatus = config.lanes.map((lane) => {
    const currentPrice = coinbaseWS.getPrice(lane.asset);
    const windowTs = priceTracker.getWindowTs(lane.interval);
    const remainingSeconds = priceTracker.getRemainingSeconds(lane.interval);
    const totalSeconds = lane.interval * 60;
    const win = priceTracker.getWindow(lane.id, windowTs);
    const openPrice = win ? win.openPrice : null;

    let irrev = 0;
    let direction = null;
    if (currentPrice != null && openPrice != null) {
      irrev = superScalp.calculateIrrev(lane.asset, openPrice, currentPrice, remainingSeconds, totalSeconds);
      direction = superScalp.getDirection(openPrice, currentPrice);
    }

    return {
      id: lane.id,
      asset: lane.asset,
      interval: lane.interval,
      currentPrice,
      openPrice,
      irrev: parseFloat(irrev.toFixed(3)),
      direction,
      remainingSeconds,
      stackLevel: superScalp.getStackLevel(lane.id),
      volatility: volatilityTracker.getVolatility(lane.asset),
    };
  });

  // Stats
  const raw = db.getDb();
  const totals = raw.prepare(`
    SELECT
      COUNT(*) AS total,
      SUM(CASE WHEN result = 'won' THEN 1 ELSE 0 END) AS wins,
      SUM(CASE WHEN result = 'lost' THEN 1 ELSE 0 END) AS losses,
      SUM(CASE WHEN result = 'pending' THEN 1 ELSE 0 END) AS pending,
      SUM(CASE WHEN result = 'expired' THEN 1 ELSE 0 END) AS expired,
      SUM(CASE WHEN result = 'burned' THEN 1 ELSE 0 END) AS burned,
      COALESCE(SUM(CASE WHEN result != 'burned' THEN pnl ELSE 0 END), 0) AS totalPnl
    FROM trades
  `).get();

  const todayUtc = new Date();
  todayUtc.setUTCHours(0, 0, 0, 0);
  const todayRow = raw.prepare(`
    SELECT COALESCE(SUM(pnl), 0) AS todayPnl, COUNT(*) AS todayTrades
    FROM trades WHERE created_at >= ? AND result IN ('won', 'lost')
  `).get(todayUtc.toISOString());
  const pnlKey = `${todayRow.todayPnl.toFixed(2)}|${todayRow.todayTrades}`;
  if (pnlKey !== global._lastPnlLog) {
    global._lastPnlLog = pnlKey;
    console.log(`[STATS] Today P&L: $${todayRow.todayPnl.toFixed(2)} (${todayRow.todayTrades} trades resolved today)`);
  }

  const decided = totals.wins + totals.losses + totals.burned;

  const yesterdayPoolRaw = db.getSetting('yesterdayPoolBalance');
  const yesterdayPool = yesterdayPoolRaw != null ? parseFloat(yesterdayPoolRaw) : null;

  let haikuAgentState = { error: 'not loaded' };
  try {
    const { haikuAgent } = require('./haiku-agent');
    haikuAgentState = haikuAgent.getState();
  } catch (_) {}

  res.json({
    pool,
    yesterdayPool,
    uptime: process.uptime(),
    paused: global.botPaused,
    dryRun: global.runtimeConfig.dryRun,
    prices: coinbaseWS.prices,
    walletAddress: config.walletAddress,
    lanes: lanesStatus,
    haikuAgent: haikuAgentState,
    stats: {
      totalTrades: totals.total,
      wins: totals.wins,
      losses: totals.losses,
      expired: totals.expired,
      pending: totals.pending,
      burned: totals.burned,
      winRate: decided > 0 ? parseFloat((totals.wins / decided).toFixed(4)) : 0,
      totalPnl: parseFloat(totals.totalPnl.toFixed(2)),
      todayPnl: parseFloat(todayRow.todayPnl.toFixed(2)),
      todayTrades: todayRow.todayTrades,
    },
  });
});

// --- GET /api/logs ---

app.get('/api/logs', auth.authMiddleware, (req, res) => {
  res.json(global.logBuffer);
});

app.get('/api/logs/search', auth.authMiddleware, (req, res) => {
  const query = (req.query.q || '').toLowerCase();
  if (!query) return res.json([]);
  try {
    let lines = [];
    // Read bot.log.1 first (older), then bot.log (newer)
    if (fs.existsSync(LOG_FILE_1)) {
      lines = lines.concat(fs.readFileSync(LOG_FILE_1, 'utf8').split('\n'));
    }
    if (fs.existsSync(LOG_FILE)) {
      lines = lines.concat(fs.readFileSync(LOG_FILE, 'utf8').split('\n'));
    }
    const matches = lines
      .filter(l => l && l.toLowerCase().includes(query))
      .slice(-200)
      .map(l => {
        const m = l.match(/^\[(.+?)\] \[(\w+)\] (.*)$/);
        return m
          ? { timestamp: m[1], level: m[2], message: m[3] }
          : { timestamp: '', level: 'info', message: l };
      });
    res.json(matches);
  } catch (err) {
    res.status(500).json({ error: 'Failed to search logs' });
  }
});

app.get('/api/logs/errors', auth.authMiddleware, (req, res) => {
  res.json(global.logBuffer.filter((e) => e.level === 'error'));
});

// --- Settings ---

const SETTINGS_WHITELIST = [
  'irrevThreshold', 'irrevStack2', 'irrevStack3',
  'dryRun', 'logLevel', 'laneEnabled',
  'maxTradeSize', 'maxLossPerTrade', 'minShares', 'minPoolBalance',
  'spreadScalpIrrev', 'spreadScalpLastSeconds', 'limitOrderTimeoutMs',
  'entryWindow5M', 'entryWindow15M',
  'tier1', 'tier2', 'tier3', 'tier4',
  'cbMaxLosses', 'cbWindowHours', 'cbPauseHours',
  'gateEnabled', 'maxAskPrice',
];

app.get('/api/settings', auth.authMiddleware, (req, res) => {
  const raw = db.getDb();
  const rows = raw.prepare('SELECT key, value FROM settings').all();
  const settings = {};
  for (const row of rows) {
    try { settings[row.key] = JSON.parse(row.value); } catch { settings[row.key] = row.value; }
  }
  res.json(settings);
});

app.post('/api/settings/:key', auth.authMiddleware, (req, res) => {
  const { key } = req.params;
  const { value } = req.body;

  if (!SETTINGS_WHITELIST.includes(key)) {
    return res.status(400).json({ error: `Setting '${key}' is not allowed` });
  }
  if (value === undefined) {
    return res.status(400).json({ error: 'Missing value in request body' });
  }

  db.setSetting(key, JSON.stringify(value));

  // Update in-memory runtime config for live-adjustable keys
  if (key in global.runtimeConfig) {
    global.runtimeConfig[key] = value;
  }

  res.json({ success: true });
});

// --- Log file endpoints ---

app.get('/api/logs/files', auth.authMiddleware, (req, res) => {
  try {
    const files = fs.readdirSync(LOG_DIR);
    const logFiles = files
      .filter(f => /^bot(-\d{4}-\d{2}-\d{2})?\.log(\.1)?$/.test(f))
      .map(f => {
        const stats = fs.statSync(path.join(LOG_DIR, f));
        return { filename: f, size: stats.size, modified: stats.mtime.toISOString() };
      })
      .sort((a, b) => b.modified.localeCompare(a.modified));
    res.json(logFiles);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.get('/api/logs/download/:filename', auth.authMiddleware, (req, res) => {
  const { filename } = req.params;
  if (!/^bot(-\d{4}-\d{2}-\d{2})?\.log(\.1)?$/.test(filename)) {
    return res.status(400).json({ error: 'Invalid filename' });
  }
  const filePath = path.join(LOG_DIR, filename);
  if (!fs.existsSync(filePath)) {
    return res.status(404).json({ error: 'File not found' });
  }
  res.download(filePath, filename);
});

// --- Candle engine API ---

app.get('/api/candles', auth.authMiddleware, (req, res) => {
  res.json(candleEngine.getActiveCandles());
});

// --- Momentum gate API ---

app.get('/api/momentum-gate', auth.authMiddleware, (req, res) => {
  try {
    const { momentumGate } = require('./momentum-gate');
    res.json(momentumGate.getState());
  } catch (err) {
    res.json({ error: 'Momentum gate not available' });
  }
});

// --- Gate decision log ---

app.get('/api/gate-log', auth.authMiddleware, (req, res) => {
  const rows = db.getDb().prepare('SELECT * FROM gate_decisions ORDER BY id DESC LIMIT 200').all();
  res.json(rows);
});

// --- v2 API endpoints (Tier 3/4 DCA) ---

app.get('/api/v2/positions', auth.authMiddleware, (req, res) => {
  res.json(positionManager.getAllActive());
});

app.get('/api/v2/lanes', auth.authMiddleware, (req, res) => {
  res.json(dcaEngine.getAllActiveStates());
});

app.get('/api/v2/tiers', auth.authMiddleware, (req, res) => {
  res.json(TIERS);
});

// --- Static files & client-side routing ---

const dashboardPath = path.join(__dirname, '..', 'dashboard', 'dist');
app.use(express.static(dashboardPath));

app.get('/{*splat}', (req, res) => {
  res.sendFile(path.join(dashboardPath, 'index.html'));
});

// --- Wallet balance sync (pool = wallet USDC.e, always) ---
const WALLET_SYNC_RPCS = [
  'https://polygon-rpc.com',
  'https://rpc.ankr.com/polygon',
  'https://polygon-bor-rpc.publicnode.com',
  'https://polygon.llamarpc.com',
  'https://poly-rpc.gateway.pokt.network',
];
let lastSyncedBalance = null;

async function syncWalletBalance(verbose) {
  const { ethers } = require('ethers');
  const USDC_E = '0x2791Bca1f2de4661ED88A30C99A7a9449Aa84174';
  const erc20Abi = ['function balanceOf(address) view returns (uint256)'];

  for (const url of WALLET_SYNC_RPCS) {
    try {
      const provider = new ethers.providers.JsonRpcProvider(url);
      await provider.getBlockNumber();
      if (verbose) console.log(`[boot] Pool sync connected to RPC: ${url}`);
      const wallet = new ethers.Wallet(config.polygonPrivateKey, provider);
      const usdc = new ethers.Contract(USDC_E, erc20Abi, provider);
      const raw = await usdc.balanceOf(wallet.address);
      const walletBalance = parseFloat(ethers.utils.formatUnits(raw, 6));
      const rounded = Math.round(walletBalance * 100) / 100;

      if (lastSyncedBalance === null || lastSyncedBalance !== rounded) {
        db.updatePoolBalance(rounded);
        if (verbose) {
          console.log(`[boot] Pool synced to wallet USDC.e: $${rounded.toFixed(2)}`);
        } else {
          console.log(`[WALLET] Balance sync: $${rounded.toFixed(2)}`);
        }
        lastSyncedBalance = rounded;
      }
      return true;
    } catch (err) {
      if (verbose) console.log(`[boot] Pool sync RPC failed: ${url} — ${err.message}`);
    }
  }

  if (verbose) {
    const balance = db.getPoolBalance();
    console.log(`[boot] Pool wallet sync failed — keeping DB value: $${balance}`);
  }
  return false;
}

// --- Start ---

app.listen(config.port, () => {
  const balance = db.getPoolBalance();
  console.log(`[boot] y28 Polymarket Bot started on port ${config.port}`);
  console.log(`[boot] Pool balance: $${balance}`);

  console.log('[boot] Coinbase WebSocket connecting...');
  coinbaseWS.connect();

  console.log('[boot] Polymarket RTDS connecting...');
  polymarketRTDS.connect();

  // Initialize order executor
  orderExecutor.init().then(async () => {
    console.log(`[boot] Order executor ready (initialized=${orderExecutor.initialized})`);

    // Initialize momentum gate
    const { momentumGate } = require('./momentum-gate');
    momentumGate.init().then(() => {
      console.log('[boot] Momentum gate initialized');
    }).catch((err) => {
      console.error('[boot] Momentum gate init failed (gate will default to allow-all):', err.message);
    });

    // Sync pool to wallet USDC.e balance on boot
    await syncWalletBalance(true);

    // Recurring wallet balance sync every 60s
    setInterval(() => syncWalletBalance(false), 60000);
  }).catch((err) => {
    console.error('[boot] Order executor init failed:', err.message);
  });

  // Start resolver pending-trade safety net
  resolver.start();

  // Start oracle trade resolver (Data API as single source of truth for win/loss)
  claimer.startOracleResolver();

  // --- Daily pool balance snapshot for "yesterday" comparison ---
  let lastSnapshotDate = db.getSetting('poolBalanceDate');

  function checkDailyPoolSnapshot() {
    const todayStr = new Date().toISOString().slice(0, 10);
    if (lastSnapshotDate && lastSnapshotDate !== todayStr) {
      // Day changed — snapshot yesterday's closing balance
      const currentBalance = db.getPoolBalance();
      db.setSetting('yesterdayPoolBalance', String(currentBalance));
      console.log(`[pool] Daily snapshot: yesterdayPoolBalance = $${currentBalance}`);
    }
    if (lastSnapshotDate !== todayStr) {
      db.setSetting('poolBalanceDate', todayStr);
      lastSnapshotDate = todayStr;
    }
  }

  checkDailyPoolSnapshot();
  setInterval(checkDailyPoolSnapshot, 60000); // check every minute

  // Start SuperScalp engine after 10s warmup for prices & volatility
  const lastWindowTs = new Map();
  const candleCloseDedup = new Map(); // tracks ${asset}:${windowTs} to avoid duplicate onCandleClose calls

  const bootSkipLanes = new Set(config.lanes.map(l => l.id));
  // --- v2 lanes (Tier 3/4 DCA) ---
  const v2Lanes = []; // v2 DCA disabled — 1H/4H now handled by v1 superscalp loop

  setTimeout(() => {
    const balance = db.getPoolBalance();
    console.log('[scalp] SuperScalp engine starting (10s warmup complete)');
    console.log(`[boot] Bot ready — ${config.lanes.length} lanes active, dryRun=${config.dryRun}, pool=$${balance}, paused=${global.botPaused}`);
    console.log('[boot] Cold-start protection: skipping entries until first window transition per lane');

    scalpInterval = setInterval(() => {
      for (const lane of config.lanes) {
        (async () => {
          try {
            const currentWindowTs = priceTracker.getWindowTs(lane.interval);
            const prevWindowTs = lastWindowTs.get(lane.id);

            // Detect window transition
            if (prevWindowTs != null && prevWindowTs !== currentWindowTs) {
              console.log(`[scalp] Window transition ${lane.id}: ${prevWindowTs} → ${currentWindowTs}`);

              // Capture close price for the OLD window before resolving.
              // captureClosePrice() won't work here — getWindowTs() already
              // returns the new window. Set directly on the old window object.
              const oldWin = priceTracker.getWindow(lane.id, prevWindowTs);
              if (oldWin && !oldWin.capturedClose) {
                const closePrice = coinbaseWS.getPrice(lane.asset);
                if (closePrice != null) {
                  oldWin.closePrice = closePrice;
                  oldWin.capturedClose = true;
                }
              }

              // Feed momentum gate on 5M window transitions (deduped per asset)
              if (lane.interval === 5) {
                try {
                  const dedupKey = `${lane.asset}:${currentWindowTs}`;
                  if (!candleCloseDedup.has(dedupKey)) {
                    candleCloseDedup.set(dedupKey, Date.now());
                    const closePrice = coinbaseWS.getPrice(lane.asset);
                    if (closePrice != null) {
                      const { momentumGate } = require('./momentum-gate');
                      momentumGate.onCandleClose(lane.asset, closePrice);
                    }
                  }
                  // Clean stale dedup entries (>60s old)
                  for (const [k, ts] of candleCloseDedup) {
                    if (Date.now() - ts > 60000) candleCloseDedup.delete(k);
                  }
                } catch (err) {}
              }

              resolver.resolveWindow(lane.id, prevWindowTs, lane.interval).catch(err => console.error(`[resolver] Error resolving ${lane.id}:`, err.message));
              candleEngine.resetLane(lane.id);
              superScalp.resetWindow(lane.id, currentWindowTs);
              try { const { haikuAgent } = require('./haiku-agent'); haikuAgent.cleanup(currentWindowTs); } catch (_) {}
              orderExecutor.clearPendingEntries(lane.id);
              priceTracker.captureOpenPrice(lane.id, lane.interval);
              bootSkipLanes.delete(lane.id);
            }

            lastWindowTs.set(lane.id, currentWindowTs);

            // Skip new entries when paused (resolution above still runs)
            if (global.botPaused) return;
            if (bootSkipLanes.has(lane.id)) return;

            // --- Midpoint path ---
            try {
              const signal = await superScalp.evaluate(lane.id);
              if (signal) {
                console.log(`[signal] ${signal.type} ${signal.laneId} irrev=${signal.irrev.toFixed(2)} dir=${signal.direction}`);

                const market = await marketDiscovery.findMarket(signal.laneId, signal.windowTs, lane.interval);
                if (market) {
                  const trade = await orderExecutor.executeEntry(signal, market);
                  if (trade) {
                    console.log(`[trade] Entered ${trade.lane_id} ${trade.side} @ $${trade.entry_price} shares=${trade.shares} irrev=${signal.irrev.toFixed(2)}`);
                    notifications.tradeEntry({ laneId: trade.lane_id, direction: trade.side, entryPrice: trade.entry_price, shares: trade.shares, cost: trade.cost, irrev: signal.irrev.toFixed(2), type: signal.type });
                    candleEngine.markTradeEntry(trade.lane_id, signal.windowTs, trade.id, trade.entry_price, Date.now());

                    const entries = superScalp.activeEntries.get(signal.laneId) || [];
                    entries.push({
                      entryPrice: trade.entry_price,
                      windowTs: signal.windowTs,
                      tradeId: trade.id,
                    });
                    superScalp.activeEntries.set(signal.laneId, entries);

                    // Mark Haiku as executed for this window — prevents re-approval
                    try {
                      const { haikuAgent } = require('./haiku-agent');
                      haikuAgent.markExecuted(signal.laneId, signal.windowTs);
                    } catch (_) {}
                  }
                } else {
                  console.log(`[scalp] No market found for ${signal.laneId} window=${signal.windowTs}`);
                }
              }
            } catch (err) {
              console.error(`[scalp] Error evaluating ${lane.id}:`, err.message);
            }

          } catch (err) {
            console.error(`[loop] Error in lane ${lane.id}:`, err.message);
          }
        })();
      }
    }, 1000);

    // --- v2 DCA engine (Tier 3/4) ---
    const v2LastWindowTs = new Map();
    const v2BootSkipLanes = new Set(v2Lanes.map(l => l.id));

    const v2Interval = setInterval(() => {
      for (const lane of v2Lanes) {
        (async () => {
          try {
            const tierConfig = getTierByInterval(lane.interval);
            const intervalSec = lane.interval * 60;
            const now = Math.floor(Date.now() / 1000);
            const currentWindowTs = now - (now % intervalSec);
            const prevWindowTs = v2LastWindowTs.get(lane.id);
            const remainingSeconds = (currentWindowTs + intervalSec) - now;

            // Window transition
            if (prevWindowTs != null && prevWindowTs !== currentWindowTs) {
              console.log(`[v2] Window transition ${lane.id}: ${prevWindowTs} → ${currentWindowTs}`);
              dcaEngine.resetLane(lane.id, prevWindowTs);
              trendObserver.reset(lane.id, prevWindowTs);
              try { const { haikuAgent } = require('./haiku-agent'); haikuAgent.cleanup(currentWindowTs); } catch (_) {}
              // Oracle resolver will handle actual resolution via Data API
              priceTracker.captureOpenPrice(lane.id, lane.interval);
              v2BootSkipLanes.delete(lane.id);
            }

            v2LastWindowTs.set(lane.id, currentWindowTs);

            if (global.botPaused) return;
            if (v2BootSkipLanes.has(lane.id)) return;

            // Resolve market and tokenId for this lane+window
            const market = await marketDiscovery.findMarket(lane.id, currentWindowTs, lane.interval);
            if (!market) {
              // Throttle this log to once per 60s per lane
              const logKey = `v2-nomarket-${lane.id}`;
              const now = Date.now();
              const last = (global._v2LogThrottle || (global._v2LogThrottle = new Map())).get(logKey) || 0;
              if (now - last >= 60000) {
                global._v2LogThrottle.set(logKey, now);
                console.log(`[v2] ${lane.id} no market found for window ${currentWindowTs}`);
              }
              return;
            }

            // Build a mutable config copy with resolved tokenId
            const liveDirection = (() => {
              let price = polymarketRTDS.getPrice(lane.asset);
              if (price == null || polymarketRTDS.isStale()) price = coinbaseWS.getPrice(lane.asset);
              if (price == null) return null;
              const openPrice = priceTracker.getOpenPrice(lane.id, lane.interval);
              if (openPrice == null) return null;
              return price >= openPrice ? 'UP' : 'DOWN';
            })();
            if (!liveDirection) {
              const logKey = `v2-nodir-${lane.id}`;
              const now = Date.now();
              const last = (global._v2LogThrottle || (global._v2LogThrottle = new Map())).get(logKey) || 0;
              if (now - last >= 60000) {
                global._v2LogThrottle.set(logKey, now);
                const price = polymarketRTDS.getPrice(lane.asset) || coinbaseWS.getPrice(lane.asset);
                const openPrice = priceTracker.getOpenPrice(lane.id, lane.interval);
                console.log(`[v2] ${lane.id} no live direction — price=${price}, openPrice=${openPrice}`);
              }
              return;
            }

            const resolvedTokenId = liveDirection === 'UP' ? market.upTokenId : market.downTokenId;
            let mutableTierConfig = { ...tierConfig, _resolvedTokenId: resolvedTokenId };

            // Haiku brain — runs on proportional schedule, caches result
            const { haikuAgent } = require('./haiku-agent');
            const elapsedSec = (lane.interval * 60) - remainingSeconds;
            const haikuResult = await haikuAgent.evaluate(lane.id, lane.asset, lane.interval, currentWindowTs,
              superScalp.calculateIrrev(lane.asset,
                priceTracker.getOpenPrice(lane.id, lane.interval) || 0,
                polymarketRTDS.getPrice(lane.asset) || coinbaseWS.getPrice(lane.asset) || 0,
                remainingSeconds, lane.interval * 60),
              elapsedSec);

            if (!haikuResult.approved) {
              if (haikuResult.reason !== 'too early in candle' && !haikuResult.reason.startsWith('confirmation in')) {
                const logKey = `haiku-v2-${lane.id}`;
                const now2 = Date.now();
                const last = (global._v2LogThrottle || (global._v2LogThrottle = new Map())).get(logKey) || 0;
                if (now2 - last >= 30000) {
                  global._v2LogThrottle.set(logKey, now2);
                  console.log(`[haiku-gate] ${lane.id} DCA BLOCKED: ${haikuResult.reason}`);
                }
              }
              return;
            }

            // Haiku approved — override direction in mutableTierConfig for DCA engine
            if (haikuResult.direction) {
              const overrideTokenId = haikuResult.direction === 'UP' ? market.upTokenId : market.downTokenId;
              mutableTierConfig = { ...mutableTierConfig, _resolvedTokenId: overrideTokenId };
            }

            // DCA engine evaluation (Haiku already approved, DCA handles timing/sizing)
            const signal = await dcaEngine.evaluate(lane.id, mutableTierConfig, currentWindowTs, remainingSeconds);
            if (signal) {
              // Override signal direction with Haiku's direction
              if (haikuResult.direction) {
                signal.direction = haikuResult.direction;
              }

              const trade = await orderExecutor.executeEntry(signal, market);
              if (trade) {
                positionManager.addEntry(signal.positionId, trade.entry_price, trade.shares, trade.cost, trade.id, signal.isHedge);
                const hedgeTag = signal.isHedge ? ' [HEDGE]' : '';
                console.log(`[v2] ${lane.id} ${signal.direction} @ $${trade.entry_price} shares=${trade.shares} tier=${signal.tier}${hedgeTag}`);
                notifications.tradeEntry({ laneId: trade.lane_id, direction: trade.side, entryPrice: trade.entry_price, shares: trade.shares, cost: trade.cost, irrev: signal.irrev.toFixed(2), type: signal.type });
              }
            }
          } catch (err) {
            console.error(`[v2] Error in lane ${lane.id}:`, err.message);
          }
        })();
      }
    }, 1000);
  }, 10000);

  startupComplete = true;
});

// --- Graceful shutdown ---

function shutdown() {
  console.log('[shutdown] Shutting down...');
  if (scalpInterval) clearInterval(scalpInterval);
  trendObserver.cleanup();
  resolver.close();
  claimer.close();
  polymarketRTDS.close();
  coinbaseWS.close();
  priceTracker.close();
  marketDiscovery.destroy();
  db.getDb().close();
  console.log('[shutdown] Bot stopped gracefully');
  process.exit(0);
}

process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
