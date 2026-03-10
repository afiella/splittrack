import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import './index.css'
import App from './App.jsx'

// ── Version check: reload once when a new build is first loaded ────────
/* global __BUILD_VERSION__ */
const APP_VERSION = typeof __BUILD_VERSION__ !== 'undefined' ? __BUILD_VERSION__ : 'dev';
const STORED_VERSION = localStorage.getItem('splittrack_version');

if (APP_VERSION !== 'dev' && STORED_VERSION && STORED_VERSION !== APP_VERSION) {
  localStorage.setItem('splittrack_version', APP_VERSION);
  window.location.reload();
} else {
  localStorage.setItem('splittrack_version', APP_VERSION);
}
// ──────────────────────────────────────────────────────────────────────

createRoot(document.getElementById('root')).render(
  <StrictMode>
    <App />
  </StrictMode>,
)
