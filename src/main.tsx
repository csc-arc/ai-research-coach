import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import 'katex/dist/katex.min.css'
import './index.css'
import App from './App.tsx'
import PIApp from './pi/PIApp.tsx'
import PIDraftsApp from './pi/PIDraftsApp.tsx'

// Evict any previously-stored OpenRouter API key from browsers that used the
// old client-side key flow. The key now lives server-side only.
try {
  localStorage.removeItem('openrouter_api_key')
} catch {
  // sessionStorage may be unavailable in some privacy modes; safe to ignore.
}

// Tiny path-based router. The PI dashboard lives at /pi; the drafts editor
// has its own dedicated route at /pi/drafts. Everything else continues to
// render the student-facing app exactly as it did before.
const path = window.location.pathname
const isPiDrafts = path === '/pi/drafts' || path === '/pi/drafts/'
const isPiRoute = !isPiDrafts && (path === '/pi' || path === '/pi/' || path.startsWith('/pi/'))

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    {isPiDrafts ? <PIDraftsApp /> : isPiRoute ? <PIApp /> : <App />}
  </StrictMode>,
)
