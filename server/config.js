require('dotenv').config();

function deepFreeze(obj) {
  Object.freeze(obj);
  for (const val of Object.values(obj)) {
    if (val && typeof val === 'object' && !Object.isFrozen(val)) {
      deepFreeze(val);
    }
  }
  return obj;
}

const assets = ['BTC', 'ETH'];
const intervals = [5, 15];

const lanes = [];
for (const asset of assets) {
  for (const interval of intervals) {
    lanes.push({ asset, interval, id: `${asset}-${interval}M` });
  }
}

const config = deepFreeze({
  port: process.env.PORT || 3000,
  dbPath: process.env.DATABASE_PATH || './data/pmb.db',
  jwtSecret: process.env.PMB_PASSWORD || 'changeme',
  polygonPrivateKey: process.env.POLYGON_PRIVATE_KEY,
  polygonRpc: process.env.POLYGON_RPC_URL || 'https://polygon-bor-rpc.publicnode.com',
  clobUrl: process.env.POLYMARKET_CLOB_URL || 'https://clob.polymarket.com',
  chainId: parseInt(process.env.CHAIN_ID || '137'),
  usdcAddress: '0x2791Bca1f2de4661ED88A30C99A7a9449Aa84174',
  walletAddress: '0x140311be486530231450118D417c6015FF7df491',
  telegramBotToken: process.env.TELEGRAM_BOT_TOKEN || null,
  telegramChatId: process.env.TELEGRAM_CHAT_ID || null,
  startingPoolBalance: 18.57,
  minPoolBalance: 5,
  maxTradeSize: 20,
  maxLossPerTrade: 5,
  minShares: 5,
  tickSize: 0.01,
  assets,
  intervals,
  lanes,
  compoundingTiers: [
    { minBalance: 0, maxBalance: 75, allocation: 0.25 },
    { minBalance: 75, maxBalance: 150, allocation: 0.10 },
    { minBalance: 150, maxBalance: 300, allocation: 0.12 },
    { minBalance: 300, maxBalance: Infinity, allocation: 0.15 },
  ],
  irrevThresholds: { base: 1.2, stack2: 2.5, stack3: 3.5 },
  irrevMultipliers: {
    high: { threshold: 5.0, multiplier: 1.25 },
    extreme: { threshold: 10.0, multiplier: 1.5 },
  },
  entryWindows: { 5: 240, 15: 540 },
  midpointPriceRange: { min: 0.30, max: 0.85 },
  spreadScalpPriceRange: { min: 0.35, max: 0.90 },
  spreadScalpIrrev: 2.5,
  spreadScalpLastSeconds: 60,
  spreadScalpCircuitBreaker: { maxLosses: 3, windowHours: 1, pauseHours: 2 },
  enhancedGates: {
    // Layer 2: Chainlink non-contradiction — noise thresholds (oracle "flat" zone)
    chainlinkNoise: {
      BTC: 2,
      ETH: 0.10,
    },
    // Layer 3: Chainlink delta ratio (only when Chainlink has moved beyond noise)
    chainlinkDeltaRatio: 0.30,
    // Layer 6: Max retracement from peak window move (0.60 = 60%)
    maxRetracement: 0.60,
    // Layer 7: Minimum absolute delta from open to enter
    minDelta: {
      BTC: 8,
      ETH: 0.40,
    },
    // Layer 5: Cross-asset minimum irrev to count as confirming
    crossAssetMinIrrev: 0.3,
    // Layer 4: Trend consistency lookback in seconds
    trendLookbackSeconds: 30,
  },
  stackMaxEntries: 2,
  stackPriceImprovement: 0.02,
  limitOrderTimeoutMs: 5000,
  dryRun: false,
  anthropicApiKey: process.env.ANTHROPIC_API_KEY || null,
});

module.exports = config;
