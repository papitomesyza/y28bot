class TrendObserver {
  constructor() {
    /** @type {Map<string, object>} key = `${laneId}:${windowTs}` */
    this.observations = new Map();
  }

  _key(laneId, windowTs) {
    return `${laneId}:${windowTs}`;
  }

  /**
   * Initialize observation state for a lane/window.
   * If already exists, return existing state.
   */
  startObservation(laneId, windowTs, openPrice) {
    const key = this._key(laneId, windowTs);
    if (this.observations.has(key)) return this.observations.get(key);

    const state = {
      openPrice,
      startTime: Date.now(),
      prices: [],
      trendDirection: null,
      trendStrength: 0,
      goSignal: false,
      observationComplete: false,
    };

    this.observations.set(key, state);
    return state;
  }

  /**
   * Record a price tick during the observation period.
   */
  recordPrice(laneId, windowTs, price, timestamp) {
    const key = this._key(laneId, windowTs);
    const state = this.observations.get(key);
    if (!state) return;
    if (state.observationComplete) return;

    state.prices.push({ price, timestamp });
  }

  /**
   * Evaluate whether observation is complete and whether a go signal exists.
   * Returns { goSignal, direction, trendStrength }.
   */
  evaluate(laneId, windowTs, tierConfig, irrev) {
    const key = this._key(laneId, windowTs);
    const state = this.observations.get(key);

    if (!state) {
      return { goSignal: false, direction: null, trendStrength: 0 };
    }

    // Return cached result if already evaluated
    if (state.observationComplete) {
      return {
        goSignal: state.goSignal,
        direction: state.trendDirection,
        trendStrength: state.trendStrength,
      };
    }

    // Still within observation window
    const elapsed = (Date.now() - state.startTime) / 1000;
    if (elapsed < tierConfig.observationSeconds) {
      return { goSignal: false, direction: null, trendStrength: 0 };
    }

    // Observation period complete — analyze
    const result = this._analyze(state);

    // Strong-move override: irrev >= 1.5 bypasses trend threshold
    if (irrev != null && irrev >= 1.5 && result.direction) {
      result.goSignal = true;
    }

    // Cache result
    state.observationComplete = true;
    state.trendDirection = result.direction;
    state.trendStrength = result.trendStrength;
    state.goSignal = result.goSignal;

    return {
      goSignal: state.goSignal,
      direction: state.trendDirection,
      trendStrength: state.trendStrength,
    };
  }

  /**
   * Split prices into 1-minute buckets, compute trend strength.
   */
  _analyze(state) {
    if (state.prices.length === 0) {
      return { goSignal: false, direction: null, trendStrength: 0 };
    }

    // Split into 1-minute buckets relative to startTime
    const bucketMs = 60 * 1000;
    const bucketMap = new Map();

    for (const tick of state.prices) {
      const bucketIdx = Math.floor((tick.timestamp - state.startTime) / bucketMs);
      if (!bucketMap.has(bucketIdx)) bucketMap.set(bucketIdx, []);
      bucketMap.get(bucketIdx).push(tick.price);
    }

    // Compute average price per bucket, sorted by bucket index
    const bucketIndices = Array.from(bucketMap.keys()).sort((a, b) => a - b);
    const bucketAvgs = bucketIndices.map((idx) => {
      const prices = bucketMap.get(idx);
      return prices.reduce((sum, p) => sum + p, 0) / prices.length;
    });

    if (bucketAvgs.length === 0) {
      return { goSignal: false, direction: null, trendStrength: 0 };
    }

    // Count consecutive buckets moving in the same direction from open
    let consecutive = 0;
    let prevAvg = state.openPrice;
    let consistentDir = null;

    for (const avg of bucketAvgs) {
      const dir = avg > prevAvg ? 'UP' : 'DOWN';
      if (consistentDir === null) {
        consistentDir = dir;
        consecutive = 1;
      } else if (dir === consistentDir) {
        consecutive++;
      } else {
        break;
      }
      prevAvg = avg;
    }

    const totalBuckets = bucketAvgs.length;
    const trendStrength = totalBuckets > 0 ? consecutive / totalBuckets : 0;

    // Final direction based on last bucket vs open
    const lastAvg = bucketAvgs[bucketAvgs.length - 1];
    const direction = lastAvg > state.openPrice ? 'UP' : 'DOWN';

    const goSignal = trendStrength >= 0.4;

    return { goSignal, direction, trendStrength };
  }

  /**
   * Returns true if observation is active and not yet complete.
   */
  isObserving(laneId, windowTs) {
    const key = this._key(laneId, windowTs);
    const state = this.observations.get(key);
    if (!state) return false;
    return !state.observationComplete;
  }

  /**
   * Clear state for a lane/window (called on window transition).
   */
  reset(laneId, windowTs) {
    const key = this._key(laneId, windowTs);
    this.observations.delete(key);
  }

  /**
   * Remove entries older than 5 hours.
   */
  cleanup() {
    const cutoff = Date.now() - 5 * 60 * 60 * 1000;
    for (const [key, state] of this.observations) {
      if (state.startTime < cutoff) {
        this.observations.delete(key);
      }
    }
  }
}

module.exports = new TrendObserver();
