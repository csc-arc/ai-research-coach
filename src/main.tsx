import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import './index.css'
import App from './App.tsx'

// Evict any previously-stored OpenRouter API key from browsers that used the
// old client-side key flow. The key now lives server-side only.
try {
  localStorage.removeItem('openrouter_api_key')
} catch {
  // sessionStorage may be unavailable in some privacy modes; safe to ignore.
}

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <App />
  </StrictMode>,
)
