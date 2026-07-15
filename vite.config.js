import { defineConfig, loadEnv } from 'vite'
import process from 'node:process'
import react from '@vitejs/plugin-react'
import tailwindcss from '@tailwindcss/vite'

// https://vite.dev/config/
export default defineConfig(({ mode }) => {
  const env = loadEnv(mode, process.cwd(), '')
  const workerOrigin = getHttpOrigin(env.VITE_WORKER_URL)

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
