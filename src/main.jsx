import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import './index.css'
import App from './App.jsx'
import { clearCache } from './session/cache'

// Register the service worker for Background Sync (upload queue recovery).
// Only on supported browsers — silently skipped elsewhere.
if ('serviceWorker' in navigator) {
  navigator.serviceWorker.register('/sw.js', { updateViaCache: 'none' }).catch((err) => {
    // Non-fatal — SW is an enhancement, not required.
    if (import.meta.env.DEV) console.warn('Service worker registration failed:', err)
  })
}

async function bootstrap() {
  // IndexedDB/OPFS do not have a reliable synchronous page-close hook. Clear
  // decrypted session metadata before every fresh document starts instead.
  await clearCache().catch(() => {})

  createRoot(document.getElementById('root')).render(
    <StrictMode>
      <App />
    </StrictMode>,
  )
}

void bootstrap()
