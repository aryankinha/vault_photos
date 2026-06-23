import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import './index.css'
import App from './App.jsx'

// Register the service worker for Background Sync (upload queue recovery).
// Only on supported browsers — silently skipped elsewhere.
if ('serviceWorker' in navigator) {
  navigator.serviceWorker.register('/sw.js').catch((err) => {
    // Non-fatal — SW is an enhancement, not required.
    console.warn('Service worker registration failed:', err)
  })
}

createRoot(document.getElementById('root')).render(
  <StrictMode>
    <App />
  </StrictMode>,
)
