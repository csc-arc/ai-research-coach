import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import 'katex/dist/katex.min.css'
import './index.css'
import App from './App.tsx'
import PIApp from './pi/PIApp.tsx'

// Evict any previously-stored OpenRouter API key from browsers that used the
// old client-side key flow. The key now lives server-side only.
try {
  localStorage.removeItem('openrouter_api_key')
} catch {
  // sessionStorage may be unavailable in some privacy modes; safe to ignore.
}

// Tiny path-based router. The PI dashboard lives at /pi (and any path that
// starts with /pi/). Everything else continues to render the student-facing
// app exactly as it did before.
const isPiRoute = (() => {
  const p = window.location.pathname
  return p === '/pi' || p === '/pi/' || p.startsWith('/pi/')
})()

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    {isPiRoute ? <PIApp /> : <App />}
  </StrictMode>,
)
