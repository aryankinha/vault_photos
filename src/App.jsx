import { BrowserRouter, Routes, Route, Navigate, useLocation } from 'react-router-dom'
import { hasActiveKey } from './crypto/keyDerivation'
import { Unlock } from './pages/Unlock'
import { Gallery } from './pages/Gallery'
import { Viewer } from './pages/Viewer'
import { Upload } from './pages/Upload'
import { UploadProvider } from './context/UploadContext'
import { PersistentUploadBar } from './components/PersistentUploadBar'

/**
 * Blocks protected routes when the vault is locked. The key lives only in a
 * module-level variable, so a page refresh clears it and lands the user back
 * on the Unlock screen.
 */
function RequireUnlock({ children }) {
  const location = useLocation()
  if (!hasActiveKey()) {
    return <Navigate to="/unlock" replace state={{ from: location }} />
  }
  return children
}

export default function App() {
  return (
    <UploadProvider>
      <BrowserRouter>
        <Routes>
          <Route path="/unlock" element={<Unlock />} />
          <Route
            path="/gallery"
            element={
              <RequireUnlock>
                <Gallery />
              </RequireUnlock>
            }
          />
          <Route
            path="/view/:id"
            element={
              <RequireUnlock>
                <Viewer />
              </RequireUnlock>
            }
          />
          <Route
            path="/upload"
            element={
              <RequireUnlock>
                <Upload />
              </RequireUnlock>
            }
          />
          <Route path="*" element={<Navigate to="/gallery" replace />} />
        </Routes>

        {/* Persistent bottom upload bar — visible on all routes during upload */}
        <PersistentUploadBar />
      </BrowserRouter>
    </UploadProvider>
  )
}
