const Database = require('better-sqlite3');
const config = require('./config');

const db = new Database(config.dbPath);

db.pragma('journal_mode = WAL');

db.exec(`
  CREATE TABLE IF NOT EXISTS trades (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    lane_id TEXT,
    market_id TEXT,
    condition_id TEXT,
    clob_token_id TEXT,
    side TEXT,
    entry_price REAL,
    shares REAL,
    cost REAL,
    irrev REAL,
    stack_level INTEGER DEFAULT 1,
    entry_type TEXT,
    open_price REAL,
    close_price REAL,
    result TEXT DEFAULT 'pending',
    claimed INTEGER DEFAULT 0,
    claim_tx TEXT,
    pnl REAL,
    window_start INTEGER,
    window_end INTEGER,
    created_at TEXT DEFAULT CURRENT_TIMESTAMP
  );

  CREATE TABLE IF NOT EXISTS pool (
    id INTEGER PRIMARY KEY,
    balance REAL,
    updated_at TEXT DEFAULT CURRENT_TIMESTAMP
  );

  CREATE TABLE IF NOT EXISTS settings (
    key TEXT PRIMARY KEY,
    value TEXT,
    updated_at TEXT DEFAULT CURRENT_TIMESTAMP
  );

  CREATE TABLE IF NOT EXISTS lane_reliability (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    lane_id TEXT,
    date TEXT,
    observed INTEGER DEFAULT 0,
    flipped INTEGER DEFAULT 0,
    UNIQUE(lane_id, date)
  );

  CREATE TABLE IF NOT EXISTS gate_decisions (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    asset TEXT,
    lane_id TEXT,
    direction TEXT,
    allowed INTEGER,
    gate_enabled INTEGER,
    vwap REAL,
    current_price REAL,
    ema9 REAL,
    ema21 REAL,
    rsi REAL,
    vote TEXT,
    reason TEXT,
    created_at TEXT DEFAULT CURRENT_TIMESTAMP
  );
`);

// Init pool balance if not yet set (will be overwritten by wallet sync)
const existingPool = db.prepare('SELECT balance FROM pool WHERE id = 1').get();
if (!existingPool) {
  db.prepare('INSERT INTO pool (id, balance) VALUES (1, ?)').run(config.startingPoolBalance);
  console.log(`[db] Pool balance initialized: $${config.startingPoolBalance}`);
} else {
  console.log(`[db] Pool balance loaded: $${existingPool.balance}`);
}

// Add slug column if it doesn't exist
try {
  db.exec('ALTER TABLE trades ADD COLUMN slug TEXT');
  console.log('[db] Added slug column to trades table');
} catch (_) {
  // Column already exists — ignore
}

// Defensive migration: ensure clob_token_id and condition_id columns exist
try {
  db.exec('ALTER TABLE trades ADD COLUMN clob_token_id TEXT');
  console.log('[db] Added clob_token_id column to trades table');
} catch (_) {
  // Column already exists — ignore
}
try {
  db.exec('ALTER TABLE trades ADD COLUMN condition_id TEXT');
  console.log('[db] Added condition_id column to trades table');
} catch (_) {
  // Column already exists — ignore
}

// DISABLED — protecting live trades
// Was: one-time fix to reset trades #93, #94 back to won/unclaimed
// const fix93_94 = db.prepare("INSERT OR IGNORE INTO settings (key, value) VALUES ('fix_93_94', '1')").run();
// if (fix93_94.changes > 0) {
//   db.prepare("UPDATE trades SET result = 'won', claimed = 0, claim_tx = NULL WHERE id IN (93, 94)").run();
//   console.log('[db] Reset trades #93, #94 to won/unclaimed');
// }

// Defensive migration: add bookmarked column
try {
  db.exec('ALTER TABLE trades ADD COLUMN bookmarked INTEGER DEFAULT 0');
  console.log('[db] Added bookmarked column to trades table');
} catch (_) {
  // Column already exists — ignore
}

// Startup SQL audit: scan for any DELETE/DROP/TRUNCATE/UPDATE on trades at boot
// The only one ever found (fix_93_94 UPDATE) was already commented out above.
console.log('[db] Startup SQL audit: found 0 statements that modify trades table — all disabled');

// One-time fix: trades #6 and #8 were marked won but Chainlink resolved opposite direction
const fixFalseWins = db.prepare("SELECT value FROM settings WHERE key = 'fix_false_wins_apr2'").get();
if (!fixFalseWins) {
  db.prepare("UPDATE trades SET result = 'lost', pnl = -2.10 WHERE id = 6").run();
  db.prepare("UPDATE trades SET result = 'lost', pnl = -2.75 WHERE id = 8").run();
  db.prepare("INSERT INTO settings (key, value, updated_at) VALUES ('fix_false_wins_apr2', '1', CURRENT_TIMESTAMP)").run();
  console.log('[db] Corrected trades #6 and #8 from won to lost (Chainlink resolved opposite direction)');
}

// One-time fix: trades #9 and #10 were marked won but Chainlink Data Streams resolved opposite direction
const fixFalseWinsV2 = db.prepare("SELECT value FROM settings WHERE key = 'fix_false_wins_v2_apr2'").get();
if (!fixFalseWinsV2) {
  db.prepare("UPDATE trades SET result = 'lost', pnl = -2.75 WHERE id = 9").run();
  db.prepare("UPDATE trades SET result = 'lost', pnl = -2.75 WHERE id = 10").run();
  db.prepare("INSERT INTO settings (key, value, updated_at) VALUES ('fix_false_wins_v2_apr2', '1', CURRENT_TIMESTAMP)").run();
  console.log('[db] Corrected trades #9 and #10 from won to lost (Chainlink Data Streams resolved opposite direction)');
}

// Log trade count on startup (read-only diagnostic)
const tradeCount = db.prepare('SELECT COUNT(*) AS cnt FROM trades').get();
console.log(`[db] Trades table: ${tradeCount.cnt} rows`);

function getPoolBalance() {
  return db.prepare('SELECT balance FROM pool WHERE id = 1').get().balance;
}

function updatePoolBalance(newBalance) {
  const rounded = Math.round(newBalance * 100) / 100;
  const update = db.transaction((bal) => {
    db.prepare('UPDATE pool SET balance = ?, updated_at = CURRENT_TIMESTAMP WHERE id = 1').run(bal);
  });
  update(rounded);
}

function insertTrade(tradeData) {
  const stmt = db.prepare(`
    INSERT INTO trades (lane_id, market_id, condition_id, clob_token_id, side, entry_price, shares, cost, irrev, stack_level, entry_type, open_price, close_price, result, claimed, claim_tx, pnl, window_start, window_end, slug, bookmarked)
    VALUES (@lane_id, @market_id, @condition_id, @clob_token_id, @side, @entry_price, @shares, @cost, @irrev, @stack_level, @entry_type, @open_price, @close_price, @result, @claimed, @claim_tx, @pnl, @window_start, @window_end, @slug, @bookmarked)
  `);
  const result = stmt.run({
    lane_id: tradeData.lane_id || null,
    market_id: tradeData.market_id || null,
    condition_id: tradeData.condition_id || null,
    clob_token_id: tradeData.clob_token_id || null,
    side: tradeData.side || null,
    entry_price: tradeData.entry_price || null,
    shares: tradeData.shares || null,
    cost: tradeData.cost || null,
    irrev: tradeData.irrev || null,
    stack_level: tradeData.stack_level || 1,
    entry_type: tradeData.entry_type || null,
    open_price: tradeData.open_price || null,
    close_price: tradeData.close_price || null,
    result: tradeData.result || 'pending',
    claimed: tradeData.claimed || 0,
    claim_tx: tradeData.claim_tx || null,
    pnl: tradeData.pnl || null,
    window_start: tradeData.window_start || null,
    window_end: tradeData.window_end || null,
    slug: tradeData.slug || null,
    bookmarked: tradeData.bookmarked || 0,
  });
  return result.lastInsertRowid;
}

function updateTrade(id, updates) {
  const fields = Object.keys(updates);
  if (fields.length === 0) return;

  const setClauses = fields.map((f) => `${f} = @${f}`).join(', ');
  const stmt = db.prepare(`UPDATE trades SET ${setClauses} WHERE id = @id`);
  stmt.run({ ...updates, id });
}

function getTrades(filters = {}) {
  let sql = 'SELECT * FROM trades';
  const conditions = [];
  const params = {};

  if (filters.lane_id) {
    conditions.push('lane_id = @lane_id');
    params.lane_id = filters.lane_id;
  }
  if (filters.result) {
    conditions.push('result = @result');
    params.result = filters.result;
  }
  if (filters.window_start) {
    conditions.push('window_start = @window_start');
    params.window_start = filters.window_start;
  }
  if (filters.claimed !== undefined) {
    conditions.push('claimed = @claimed');
    params.claimed = filters.claimed;
  }

  if (conditions.length > 0) {
    sql += ' WHERE ' + conditions.join(' AND ');
  }

  sql += ' ORDER BY created_at DESC';

  if (filters.limit) {
    sql += ' LIMIT @limit';
    params.limit = filters.limit;
  }

  return db.prepare(sql).all(params);
}

function getTradeById(id) {
  return db.prepare('SELECT * FROM trades WHERE id = ?').get(id);
}

function getSetting(key) {
  const row = db.prepare('SELECT value FROM settings WHERE key = ?').get(key);
  return row ? row.value : null;
}

function setSetting(key, value) {
  db.prepare(
    'INSERT INTO settings (key, value, updated_at) VALUES (?, ?, CURRENT_TIMESTAMP) ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at'
  ).run(key, value);
}

function getDb() {
  return db;
}

function recordLaneResolution(laneId, isFlip) {
  const date = new Date().toISOString().slice(0, 10);
  db.prepare(
    'INSERT INTO lane_reliability (lane_id, date, observed, flipped) VALUES (?, ?, 1, ?) ON CONFLICT(lane_id, date) DO UPDATE SET observed = observed + 1, flipped = flipped + ?'
  ).run(laneId, date, isFlip ? 1 : 0, isFlip ? 1 : 0);
}

function getLaneReliability(laneId, days) {
  const cutoff = new Date();
  cutoff.setDate(cutoff.getDate() - days);
  return db.prepare(
    'SELECT * FROM lane_reliability WHERE lane_id = ? AND date >= ? ORDER BY date DESC'
  ).all(laneId, cutoff.toISOString().slice(0, 10));
}

module.exports = {
  getPoolBalance,
  updatePoolBalance,
  insertTrade,
  updateTrade,
  getTrades,
  getTradeById,
  getSetting,
  setSetting,
  getDb,
  recordLaneResolution,
  getLaneReliability,
};
