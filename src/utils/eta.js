/**
 * EtaTracker — rolling-window transfer speed estimator.
 *
 * Keeps the last WINDOW_SIZE progress samples and uses the oldest-to-newest
 * delta to compute a stable bytes-per-second figure, then extrapolates ETA.
 */

const WINDOW_SIZE = 5
const STALE_SAMPLE_MS = 15_000

export class EtaTracker {
  /**
   * @param {number} totalBytes — total bytes expected to transfer
   */
  constructor(totalBytes, now = Date.now) {
    this._total = Number.isFinite(totalBytes) ? Math.max(0, totalBytes) : 0
    this._now = now
    /** @type {{ timestamp: number, loaded: number }[]} */
    this._samples = []
  }

  /**
   * Record a new progress observation. Call this on every XHR progress event.
   * @param {number} loadedBytes
   */
  update(loadedBytes) {
    if (!Number.isFinite(loadedBytes)) return
    const timestamp = this._now()
    const loaded = Math.max(0, Math.min(this._total, loadedBytes))
    const previous = this._samples.at(-1)
    // Retries can reset byte progress; pauses should not preserve a stale speed.
    if (previous && (loaded < previous.loaded || timestamp - previous.timestamp > STALE_SAMPLE_MS)) {
      this._samples = []
    }
    this._samples.push({ timestamp, loaded })
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
    const percent = this._total === 0 ? 1 : latest ? latest.loaded / this._total : 0

    if (percent === 1) {
      return { percent, bytesPerSecond: 0, etaSeconds: 0, etaDisplay: '0 sec' }
    }

    if (samples.length < 2 || this._now() - latest.timestamp > STALE_SAMPLE_MS) {
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
