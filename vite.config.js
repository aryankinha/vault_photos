import { defineConfig, loadEnv } from 'vite'
import process from 'node:process'
import react from '@vitejs/plugin-react'
import tailwindcss from '@tailwindcss/vite'

// https://vite.dev/config/
export default defineConfig(({ mode, command }) => {
  const env = loadEnv(mode, process.cwd(), '')
  const workerOrigin = getHttpOrigin(env.VITE_WORKER_URL)
  if (command === 'build' && !workerOrigin) {
    throw new Error('Set VITE_WORKER_URL to a valid Worker URL before building VaultPhotos.')
  }

  return {
    plugins: [
      react(),
      tailwindcss(),
      {
        name: 'vaultphotos-csp-worker-origin',
        transformIndexHtml(html) {
          return html.replace(
            '__WORKER_CONNECT_SOURCE__',
            workerOrigin ? ` ${workerOrigin}` : '',
          )
        },
      },
    ],
    worker: { format: 'es' },
  }
})

function getHttpOrigin(value) {
  try {
    const url = new URL(value)
    return url.protocol === 'https:' || url.protocol === 'http:' ? url.origin : ''
  } catch {
    return ''
  }
}
