import test from 'node:test'
import assert from 'node:assert/strict'
import { readMediaMetadata } from '../src/utils/exif.js'

test('EXIF-less photos retain file modification date rather than upload date', async () => {
  const modified = Date.parse('2021-06-01T12:30:00.000Z')
  const file = new File(['not-an-exif-image'], 'plain.jpg', { type: 'image/jpeg', lastModified: modified })
  const metadata = await readMediaMetadata(file)
  assert.equal(metadata.date_taken, '2021-06-01T12:30:00.000Z')
  assert.equal(metadata.type, 'image')
})
