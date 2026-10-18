// Test-only entry: Vite's production build includes only index.html.
// Keep ciphertext in this document's RAM, never contact the real API.
import { createRoot } from 'react-dom/client'
import App from '../../src/App.jsx'
import '../../src/index.css'

const originalFetch = window.fetch.bind(window)
async function insertFixtures(mixed) {
  const input = document.querySelector('input[type="file"]')
  if (!input) { window.alert('Open Upload first.'); return }
  const transfer = new DataTransfer()
  const canvas = document.createElement('canvas')
  canvas.width = canvas.height = 32
  const context = canvas.getContext('2d')
  context.fillStyle = '#57b'
  context.fillRect(0, 0, 32, 32)
  const photo = await new Promise((resolve) => canvas.toBlob(resolve, 'image/jpeg'))
  transfer.items.add(new File([photo], 'synthetic-photo.jpg', { type: 'image/jpeg' }))
  if (mixed) {
    const video = await (await originalFetch('/test-fixtures.local/large.mp4')).blob()
    transfer.items.add(new File([video], 'synthetic-large.mp4', { type: 'video/mp4' }))
  }
  input.files = transfer.files
  input.dispatchEvent(new Event('change', { bubbles: true }))
}
document.querySelector('#insert-photo').onclick = () => { void insertFixtures(false) }
document.querySelector('#insert-mixed').onclick = () => { void insertFixtures(true) }
const objects = new Map()
let salt = null
let manifest = null
let head = 'a'.repeat(40)
let commitCount = 0
const decode = (value) => Uint8Array.from(atob(value), (character) => character.charCodeAt(0))
const response = (bytes) => bytes ? new Response(bytes.slice()) : new Response('Not found', { status: 404 })
const advance = () => {
  commitCount += 1
  head = commitCount.toString(16).padStart(40, '0')
  return Response.json({ ok: true, commitOid: head })
}
window.fetch = async (input, options = {}) => {
  const url = new URL(typeof input === 'string' ? input : input.url, location.origin)
  document.querySelector('#test-requests').textContent = `Test request: ${url.pathname}; service worker: ${navigator.serviceWorker?.controller ? 'active (not covered by this document storage double)' : 'none'}`
  // Modules and the explicit synthetic fixture are the only real requests.
  if (url.origin === location.origin && (url.pathname.startsWith('/src/') || url.pathname.startsWith('/test-fixtures.local/'))) {
    return originalFetch(input, options)
  }
  if (url.pathname === '/auth-mode') return Response.json({ mode: 'access' })
  if (url.pathname === '/vault-head') return Response.json({ oid: head })
  if (url.pathname === '/get-salt') return response(salt)
  if (url.pathname === '/get-manifest') return response(manifest)
  if (url.pathname.startsWith('/get-bundle-page/')) return response(objects.get(`page/${url.pathname.split('/').at(-1)}`))
  if (url.pathname.startsWith('/get-file/')) return response(objects.get(`file/${url.pathname.split('/').at(-1)}`))
  if (url.pathname.startsWith('/get-chunk/')) return response(objects.get(url.pathname.replace('/get-chunk/', 'chunk/')))
  if (url.pathname === '/list') return Response.json({ ids: [] })
  if (url.pathname === '/initialize-vault') {
    const body = JSON.parse(options.body)
    salt = decode(body.saltBytesBase64)
    manifest = decode(body.manifestBytesBase64)
    objects.set('page/0', decode(body.bundlePageBytesBase64))
    return advance()
  }
  if (['/commit-batch', '/delete-media'].includes(url.pathname)) {
    const body = JSON.parse(options.body)
    if (body.parentCommit !== head) return Response.json({ error: { code: 'VAULT_STALE' } }, { status: 409 })
    manifest = decode(body.manifestBytesBase64)
    for (const page of body.bundlePages || []) objects.set(`page/${page.pageIndex}`, decode(page.bytesBase64))
    return advance()
  }
  throw new Error(`Test blocked unexpected fetch: ${url.pathname}`)
}

window.XMLHttpRequest = class {
  upload = {}
  headers = {}
  open(method, value) { this.url = new URL(value, location.origin) }
  setRequestHeader(name, value) { this.headers[name] = value }
  getResponseHeader() { return null }
  abort() { this.aborted = true; clearTimeout(this.timer); this.onabort?.() }
  send(body) {
    const finish = () => {
      if (this.aborted) return
      if (document.querySelector('#pause-uploads').checked) {
        this.timer = setTimeout(finish, 100)
        return
      }
      const id = this.url.searchParams.get('id')
      const index = this.url.searchParams.get('index')
      objects.set(index === null ? `file/${id}` : `chunk/${id}/${index}`, new Uint8Array(body).slice())
      this.upload.onprogress?.({ loaded: body.byteLength, total: body.byteLength, lengthComputable: true })
      this.status = 200
      this.response = new TextEncoder().encode(JSON.stringify({
        ok: true, id, ...(index === null ? {} : { index: Number(index) }),
        sha256: this.headers['X-Vault-SHA256'], size: body.byteLength,
      })).buffer
      this.onload?.()
    }
    this.timer = setTimeout(finish, 200)
  }
}

createRoot(document.getElementById('root')).render(<App />)
