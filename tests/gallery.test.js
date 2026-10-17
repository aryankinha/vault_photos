import test from 'node:test'
import assert from 'node:assert/strict'

const {
  computeInitialPage,
  computeNextPage,
  shouldMarkPageLoaded,
} = await import('../src/services/galleryPage.js')

// ---------------------------------------------------------------------------
// computeInitialPage
// ---------------------------------------------------------------------------

test('computeInitialPage returns 0 when all entries have cached thumbs', () => {
  const entries = [
    { id: 'a', page_index: 0 },
    { id: 'b', page_index: 1 },
    { id: 'c', page_index: 2 },
  ]
  const thumbs = new Map([
    ['a', {}], ['b', {}], ['c', {}],
  ])
  assert.equal(computeInitialPage(entries, thumbs), 0)
})

test('computeInitialPage returns page of first uncached entry (newest-first)', () => {
  // Entries are sorted newest-first. The first uncached entry is on page 3.
  const entries = [
    { id: 'newest', page_index: 3 },
    { id: 'mid', page_index: 2 },
    { id: 'oldest', page_index: 0 },
  ]
  const thumbs = new Map()
  assert.equal(computeInitialPage(entries, thumbs), 3)
})

test('computeInitialPage skips cached entries and returns first uncached page', () => {
  const entries = [
    { id: 'cached-newest', page_index: 2 },
    { id: 'uncached-mid', page_index: 1 },
    { id: 'cached-oldest', page_index: 0 },
  ]
  const thumbs = new Map([
    ['cached-newest', {}],
    ['cached-oldest', {}],
  ])
  assert.equal(computeInitialPage(entries, thumbs), 1)
})

test('computeInitialPage defaults to 0 when entries have no page_index', () => {
  const entries = [
    { id: 'a' },
    { id: 'b' },
  ]
  const thumbs = new Map()
  assert.equal(computeInitialPage(entries, thumbs), 0)
})

test('computeInitialPage returns 0 for empty entries', () => {
  assert.equal(computeInitialPage([], new Map()), 0)
})

test('computeInitialPage handles null thumbs', () => {
  const entries = [{ id: 'a', page_index: 2 }]
  assert.equal(computeInitialPage(entries, null), 2)
})

// ---------------------------------------------------------------------------
// computeNextPage
// ---------------------------------------------------------------------------

test('computeNextPage returns null when all pages are loaded', () => {
  const entries = [{ id: 'a', page_index: 0 }]
  const loadedPages = new Set([0])
  assert.equal(computeNextPage(entries, 1, loadedPages), null)
})

test('computeNextPage returns first unloaded page in numerical order when no entries', () => {
  assert.equal(computeNextPage([], 3, new Set([0])), 1)
  assert.equal(computeNextPage([], 3, new Set([0, 1, 2])), null)
})

test('computeNextPage returns page of first non-visible entry (display order)', () => {
  // Entries sorted newest-first: page 3 is newest, page 0 is oldest.
  const entries = [
    { id: 'newest', page_index: 3 },
    { id: 'mid', page_index: 2 },
    { id: 'oldest', page_index: 0 },
  ]
  const loadedPages = new Set()
  const thumbs = new Map()
  // The first non-visible entry is on page 3 — should load it first.
  assert.equal(computeNextPage(entries, 4, loadedPages, thumbs), 3)
})

test('computeNextPage skips entries with cached thumbs', () => {
  const entries = [
    { id: 'cached', page_index: 2 },
    { id: 'uncached', page_index: 1 },
  ]
  const loadedPages = new Set()
  const thumbs = new Map([['cached', {}]])
  assert.equal(computeNextPage(entries, 3, loadedPages, thumbs), 1)
})

test('computeNextPage skips optimistic entries', () => {
  const entries = [
    { id: 'optimistic', page_index: 2 },
    { id: 'real', page_index: 1 },
  ]
  const loadedPages = new Set()
  const thumbs = new Map()
  const optimisticStates = new Map([['optimistic', { status: 'uploading' }]])
  assert.equal(computeNextPage(entries, 3, loadedPages, thumbs, optimisticStates), 1)
})

test('computeNextPage skips entries on loaded pages', () => {
  const entries = [
    { id: 'on-loaded-page', page_index: 0 },
    { id: 'not-loaded', page_index: 1 },
  ]
  const loadedPages = new Set([0])
  const thumbs = new Map()
  assert.equal(computeNextPage(entries, 2, loadedPages, thumbs), 1)
})

test('computeNextPage falls back to numerical order when all entries visible', () => {
  const entries = [
    { id: 'a', page_index: 0 },
    { id: 'b', page_index: 1 },
  ]
  const loadedPages = new Set([0])
  const thumbs = new Map([['a', {}], ['b', {}]])
  // All entries have thumbs, but page 1 is not loaded — return 1.
  assert.equal(computeNextPage(entries, 2, loadedPages, thumbs), 1)
})

test('computeNextPage handles null thumbs and optimisticStates', () => {
  const entries = [{ id: 'a', page_index: 0 }]
  const loadedPages = new Set()
  assert.equal(computeNextPage(entries, 1, loadedPages, null, null), 0)
})

// ---------------------------------------------------------------------------
// Page ordering: newest-first means highest page index loads first
// ---------------------------------------------------------------------------

test('page ordering: newest entries on highest page load before oldest', () => {
  // Simulate a 3-page vault where page 0 = oldest, page 2 = newest.
  const entries = [
    { id: 'newest-1', page_index: 2, date_taken: '2026-03-01T00:00:00Z' },
    { id: 'newest-2', page_index: 2, date_taken: '2026-02-15T00:00:00Z' },
    { id: 'mid', page_index: 1, date_taken: '2026-01-15T00:00:00Z' },
    { id: 'oldest', page_index: 0, date_taken: '2025-12-01T00:00:00Z' },
  ]
  const thumbs = new Map()
  const loadedPages = new Set()

  // First page to load should be page 2 (newest).
  assert.equal(computeNextPage(entries, 3, loadedPages, thumbs), 2)

  // After loading page 2, next should be page 1.
  loadedPages.add(2)
  assert.equal(computeNextPage(entries, 3, loadedPages, thumbs), 1)

  // After loading page 1, next should be page 0 (oldest).
  loadedPages.add(1)
  assert.equal(computeNextPage(entries, 3, loadedPages, thumbs), 0)

  // After loading all, null.
  loadedPages.add(0)
  assert.equal(computeNextPage(entries, 3, loadedPages, thumbs), null)
})

// ---------------------------------------------------------------------------
// shouldMarkPageLoaded — phantom page completeness
// ---------------------------------------------------------------------------

test('shouldMarkPageLoaded returns true when page returned entries', () => {
  assert.equal(shouldMarkPageLoaded(5, 3), true)
  assert.equal(shouldMarkPageLoaded(1, 1), true)
})

test('shouldMarkPageLoaded returns true when all ids were cached (no fetch needed)', () => {
  assert.equal(shouldMarkPageLoaded(0, 0), true)
})

test('shouldMarkPageLoaded returns false on phantom completeness (0 entries but missing ids)', () => {
  assert.equal(shouldMarkPageLoaded(0, 3), false)
  assert.equal(shouldMarkPageLoaded(0, 1), false)
})
