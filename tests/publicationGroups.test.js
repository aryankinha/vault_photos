import test from 'node:test'
import assert from 'node:assert/strict'
import { groupPublications } from '../src/utils/publicationGroups.js'

test('large selections publish bounded groups without splitting a media entry', () => {
  const items = Array.from({ length: 12 }, (_, id) => ({ id, isChunked: true, chunkCount: 256 }))
  const groups = groupPublications(items)
  assert.deepEqual(groups.map((group) => group.length), [7, 5])
  assert.deepEqual(groups.flat(), items)
  assert.deepEqual(groupPublications([]), [])
  assert.equal(groupPublications(Array.from({ length: 501 }, () => ({}))).length, 3)
  assert.throws(() => groupPublications([{ isChunked: true, chunkCount: 1801 }]))
})
