/**
 * v2 4-Tier Trading System — Frozen Configuration
 *
 * Slug formats per interval:
 *   5M  → {asset}-updown-5m-{ts}
 *   15M → {asset}-updown-15m-{ts}
 *   1H  → {asset}-updown-1h-{ts}
 *   4H  → {asset}-updown-4h-{ts}
 */

function deepFreeze(obj) {
  Object.freeze(obj);
  for (const val of Object.values(obj)) {
    if (val && typeof val === 'object' && !Object.isFrozen(val)) {
      deepFreeze(val);
    }
  }
  return obj;
}

const TIERS = deepFreeze([
  {
    id: 1,
    name: '5M',
    interval: 5,
    allocationPct: 0.10,
    observationSeconds: 0,
    entryMode: 'single',
    irrevThreshold: 2.5,
    priceRange: { min: 0.40, max: 0.65 },
    maxEntriesPerCandle: 1,
    hedgeEnabled: false,
    assets: ['BTC', 'ETH'],
  },
  {
    id: 2,
    name: '15M',
    interval: 15,
    allocationPct: 0.15,
    observationSeconds: 0,
    entryMode: 'single',
    irrevThreshold: 1.5,
    priceRange: { min: 0.40, max: 0.75 },
    maxEntriesPerCandle: 2,
    hedgeEnabled: false,
    assets: ['BTC', 'ETH'],
  },
  {
    id: 3,
    name: '1H',
    interval: 60,
    allocationPct: 0.55,
    observationSeconds: 600,       // 10 min observation before first entry
    entryMode: 'dca',
    entryIntervalSeconds: 180,     // buy every 3 min after observation
    irrevThreshold: 0.8,
    priceRange: { min: 0.35, max: 0.70 },
    maxEntriesPerCandle: 16,
    hedgeEnabled: true,
    hedgeReversalSeconds: 120,     // price must stay reversed 2 min before hedge
    hedgeMaxPct: 0.25,             // max 25% of position size
    assets: ['BTC', 'ETH'],
  },
  {
    id: 4,
    name: '4H',
    interval: 240,
    allocationPct: 0.20,
    observationSeconds: 1800,      // 30 min observation before first entry
    entryMode: 'dca',
    entryIntervalSeconds: 300,     // buy every 5 min after observation
    irrevThreshold: 1.0,
    priceRange: { min: 0.35, max: 0.70 },
    maxEntriesPerCandle: 20,
    hedgeEnabled: true,
    hedgeReversalSeconds: 180,     // 3 min sustained reversal
    hedgeMaxPct: 0.25,
    assets: ['BTC', 'ETH'],
  },
]);

// Interval-to-slug suffix mapping
const INTERVAL_SLUG = deepFreeze({
  5: '5m',
  15: '15m',
  60: '1h',
  240: '4h',
});

/**
 * Get tier config by interval (minutes).
 * @param {number} interval
 * @returns {object|undefined}
 */
function getTierByInterval(interval) {
  return TIERS.find(t => t.interval === interval);
}

/**
 * Build the full v2 lane list across all 4 tiers.
 * Each asset × interval combo = one lane.
 * Lane id format: BTC-5M, ETH-1H, SOL-4H, etc.
 */
function buildV2Lanes() {
  const lanes = [];
  for (const tier of TIERS) {
    for (const asset of tier.assets) {
      lanes.push({
        asset,
        interval: tier.interval,
        tierId: tier.id,
        tierName: tier.name,
        id: `${asset}-${tier.name}`,
      });
    }
  }
  return deepFreeze(lanes);
}

module.exports = { TIERS, INTERVAL_SLUG, getTierByInterval, buildV2Lanes };
