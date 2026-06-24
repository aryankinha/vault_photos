import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import tailwindcss from '@tailwindcss/vite'

// https://vite.dev/config/
export default defineConfig({
  plugins: [react(), tailwindcss()],
  worker: {
    // Bundle workers as ES modules so `?worker` imports work and Vite can
    // tree-shake them. Required for the cryptoWorkerPool.
    format: 'es',
  },
})
