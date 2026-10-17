import 'fake-indexeddb/auto'
import test from 'node:test'
import assert from 'node:assert/strict'
import { setRevisionScope, checkManifestRevision, clearRevisionScope } from '../src/session/revision.js'

test('rollback detection is monotonic and isolated by both worker and salt', async () => {
  const salt = new Uint8Array(16)
  await setRevisionScope('https://vault-a.example', salt)
  await checkManifestRevision({ revision: 5 })
  await assert.rejects(checkManifestRevision({ revision: 4 }), { code: 'VAULT_ROLLBACK' })
  await checkManifestRevision({ revision: 5 })
  await setRevisionScope('https://vault-b.example', salt)
  await checkManifestRevision({ revision: 1 })
  salt[0] = 1
  await setRevisionScope('https://vault-a.example', salt)
  await checkManifestRevision({})
  clearRevisionScope()
  await checkManifestRevision({ revision: 0 })
})
