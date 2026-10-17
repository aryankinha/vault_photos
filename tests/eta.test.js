import test from 'node:test'
import assert from 'node:assert/strict'
import { EtaTracker } from '../src/utils/eta.js'

test('ETA resets after stalls/retries and never divides by zero', () => {
  let now = 0
  const tracker = new EtaTracker(1000, () => now)
  tracker.update(0)
  now = 1000
  tracker.update(100)
  assert.equal(tracker.getEta().etaSeconds, 9)
  now += 16_000
  assert.equal(tracker.getEta().bytesPerSecond, 0)
  tracker.update(200)
  assert.equal(tracker.getEta().etaSeconds, Infinity)
  now += 1000
  tracker.update(50)
  assert.equal(tracker.getEta().bytesPerSecond, 0)
  tracker.update(1100)
  assert.equal(tracker.getEta().percent, 1)
  assert.equal(tracker.getEta().etaSeconds, 0)
  assert.equal(new EtaTracker(0).getEta().percent, 1)
})
