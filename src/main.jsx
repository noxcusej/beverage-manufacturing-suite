import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import './index.css';
import App from './App.jsx';

// A new deploy replaces hashed asset filenames, so a tab still running an older
// build gets a 404 when it lazy-loads a chunk. For a route chunk that means a
// blank/broken page, and the only recovery is to reload onto the current build.
// We skip the reload while a heavy export chunk (ExcelJS) is loading — that path
// shows its own "please refresh" message so we don't wipe unsaved work.
window.addEventListener('vite:preloadError', () => {
  if (window.__loadingHeavyChunk) return;
  const key = 'vite-preload-reloaded-at';
  const last = Number(sessionStorage.getItem(key) || 0);
  if (Date.now() - last < 15000) return; // just reloaded — avoid a loop
  sessionStorage.setItem(key, String(Date.now()));
  window.location.reload();
});

createRoot(document.getElementById('root')).render(
  <StrictMode>
    <App />
  </StrictMode>
);
