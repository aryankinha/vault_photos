/**
 * EtaTracker — rolling-window transfer speed estimator.
 *
 * Keeps the last WINDOW_SIZE progress samples and uses the oldest-to-newest
 * delta to compute a stable bytes-per-second figure, then extrapolates ETA.
 */

const WINDOW_SIZE = 5

export class EtaTracker {
  /**
   * @param {number} totalBytes — total bytes expected to transfer
   */
  constructor(totalBytes) {
    this._total = totalBytes
    /** @type {{ timestamp: number, loaded: number }[]} */
    this._samples = []
  }

  /**
   * Record a new progress observation. Call this on every XHR progress event.
   * @param {number} loadedBytes
   */
  update(loadedBytes) {
    this._samples.push({ timestamp: Date.now(), loaded: loadedBytes })
    if (this._samples.length > WINDOW_SIZE) {
      this._samples.shift()
    }
  }

  /**
   * Compute the current ETA based on the rolling window.
   * @returns {{ percent: number, bytesPerSecond: number, etaSeconds: number, etaDisplay: string }}
   */
  getEta() {
    const samples = this._samples
    const latest = samples[samples.length - 1]
    const percent = latest ? latest.loaded / this._total : 0

    if (samples.length < 2) {
      return { percent, bytesPerSecond: 0, etaSeconds: Infinity, etaDisplay: 'calculating…' }
    }

    const oldest = samples[0]
    const timeDeltaMs = latest.timestamp - oldest.timestamp
    const bytesDelta = latest.loaded - oldest.loaded

    if (timeDeltaMs <= 0 || bytesDelta <= 0) {
      return { percent, bytesPerSecond: 0, etaSeconds: Infinity, etaDisplay: 'calculating…' }
    }

    const bytesPerSecond = (bytesDelta / timeDeltaMs) * 1000
    const remaining = this._total - latest.loaded
    const etaSeconds = remaining / bytesPerSecond

    return {
      percent,
      bytesPerSecond,
      etaSeconds,
      etaDisplay: formatEta(etaSeconds),
    }
  }
}

/**
 * Format a seconds count into a human-readable ETA string.
 * @param {number} seconds
 * @returns {string}
 */
function formatEta(seconds) {
  if (!Number.isFinite(seconds) || seconds < 0) return 'calculating…'

  if (seconds > 3600) {
    const h = Math.floor(seconds / 3600)
    const m = Math.floor((seconds % 3600) / 60)
    return m > 0 ? `${h} hr ${m} min` : `${h} hr`
  }

  if (seconds >= 60) {
    const m = Math.floor(seconds / 60)
    const s = Math.floor(seconds % 60)
    return s > 0 ? `${m} min ${s} sec` : `${m} min`
  }

  return `${Math.ceil(seconds)} sec`
}
