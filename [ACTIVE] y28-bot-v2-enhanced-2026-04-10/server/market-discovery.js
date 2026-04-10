const axios = require('axios');

const GAMMA_EVENTS_API = 'https://gamma-api.polymarket.com/events';
const CACHE_TTL_AFTER_END = 5 * 60 * 1000; // 5 minutes after window ends

class MarketDiscovery {
  constructor() {
    this.cache = new Map();
    this._cleanupInterval = setInterval(() => this.clearExpiredCache(), 5 * 60 * 1000);
  }

  /**
   * Build deterministic slug: {asset}-updown-{interval}m-{windowTs}
   * @param {string} asset - e.g. 'BTC' or 'btc'
   * @param {number} interval - 5 or 15
   * @param {number} windowTs - window start epoch seconds
   * @returns {string}
   */
  buildSlug(asset, interval, windowTs) {
    return `${asset.toLowerCase()}-updown-${interval}m-${windowTs}`;
  }

  /**
   * Find the Polymarket market for a given lane and window.
   * @param {string} laneId - e.g. "BTC-5M"
   * @param {number} windowTs - window start epoch in seconds
   * @param {number} interval - 5 or 15 (minutes)
   * @returns {object|null} parsed market data or null
   */
  async findMarket(laneId, windowTs, interval) {
    const asset = laneId.split('-')[0];
    const slug = this.buildSlug(asset, interval, windowTs);

    // Check cache
    const cached = this.cache.get(slug);
    if (cached) {
      return cached;
    }

    try {
      const resp = await axios.get(GAMMA_EVENTS_API, {
        params: { slug },
        timeout: 10_000,
      });

      const events = resp.data;
      if (!Array.isArray(events) || events.length === 0) {
        console.log(`[MarketDiscovery] No event found for slug: ${slug}`);
        return null;
      }

      const event = events[0];
      const markets = event.markets;
      if (!Array.isArray(markets) || markets.length === 0) {
        console.log(`[MarketDiscovery] Event has no markets for slug: ${slug}`);
        return null;
      }

      const market = markets[0];

      let clobTokenIds;
      try {
        clobTokenIds = JSON.parse(market.clobTokenIds);
      } catch (err) {
        console.error(`[MarketDiscovery] Failed to parse clobTokenIds for ${slug}:`, err.message);
        return null;
      }

      const result = {
        marketId: market.id,
        conditionId: market.conditionId,
        clobTokenIds,
        upTokenId: clobTokenIds[0],
        downTokenId: clobTokenIds[1],
        question: market.question,
        endDate: market.endDate,
        outcomes: market.outcomes,
        outcomePrices: market.outcomePrices,
        slug,
      };

      // Cache keyed by slug with windowEnd for expiry
      result._windowEndMs = (windowTs + interval * 60) * 1000;
      this.cache.set(slug, result);
      console.log(`[MarketDiscovery] Found market for ${laneId}: "${market.question}"`);

      return result;
    } catch (err) {
      console.error(`[MarketDiscovery] API error for slug ${slug}:`, err.message);
      return null;
    }
  }

  /**
   * Remove cache entries whose window ended more than 5 minutes ago
   */
  clearExpiredCache() {
    const now = Date.now();
    for (const [slug, entry] of this.cache) {
      if (now > entry._windowEndMs + CACHE_TTL_AFTER_END) {
        this.cache.delete(slug);
      }
    }
  }

  /**
   * Stop the cleanup interval (for graceful shutdown)
   */
  destroy() {
    if (this._cleanupInterval) {
      clearInterval(this._cleanupInterval);
      this._cleanupInterval = null;
    }
  }
}

module.exports = new MarketDiscovery();
