import test from 'node:test'
import assert from 'node:assert/strict'
import { enqueueSelectedFiles } from '../src/utils/uploadQueue.js'

test('a selection larger than the remaining queue capacity is rejected without partial acceptance', () => {
  const existing = { type: 'resume', ids: ['pending'] }
  const queue = [existing]
  assert.throws(() => enqueueSelectedFiles(queue, ['a', 'b'], 2), /select these 2 files again/)
  assert.deepEqual(queue, [existing])
})

test('a full queue rejects explicitly rather than silently discarding selected files', () => {
  const queue = [{ type: 'file', file: 'already queued' }]
  assert.throws(() => enqueueSelectedFiles(queue, ['new'], 1), /Upload queue is full/)
  assert.equal(queue.length, 1)
})

test('a selection fitting exactly is queued in order with the original file objects', () => {
  const files = [new File(['a'], 'a.jpg'), new File(['b'], 'b.jpg')]
  const queue = []
  enqueueSelectedFiles(queue, files, 2)
  assert.deepEqual(queue, files.map((file) => ({ type: 'file', file })))
})
