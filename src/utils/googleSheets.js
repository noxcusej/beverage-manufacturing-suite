// Google Sheets OAuth + Drive API helpers.
//
// Setup (one time):
//   1. Google Cloud Console → enable the Google Drive API
//   2. APIs & Services → Credentials → Create OAuth client ID (Web app)
//   3. Add authorized JavaScript origins for your dev + prod hosts
//      (e.g., http://localhost:5173, https://your-app.vercel.app)
//   4. Copy the Client ID into .env.local as:
//        VITE_GOOGLE_CLIENT_ID=<client-id>.apps.googleusercontent.com
//   5. Restart `npm run dev`
//
// Behavior:
//   - When VITE_GOOGLE_CLIENT_ID is set, `uploadXlsxToSheets()` triggers
//     the OAuth popup (drive.file scope only — no read/list access to
//     the user's existing Drive), uploads the .xlsx as a Google Sheet,
//     and returns the editable URL.
//   - When the env var is missing, callers should fall back to the
//     download-and-import flow.

const GIS_SRC = 'https://accounts.google.com/gsi/client';
// drive.file grants per-file access (only files this app creates) — narrow
// scope, no consent-screen warning for "view all Drive files." The Sheets
// API can act on the file too via the same scope.
const SCOPE = 'https://www.googleapis.com/auth/drive.file';

// Token cache — sessionStorage so refresh keeps the consent but a closed
// tab requires a fresh login. Access tokens live ~1 hour; we trim a safety
// margin so we never use a token within ~60s of expiry.
const STORAGE_KEY = 'bms_google_token';
const SAFETY_MARGIN_MS = 60_000;

function loadCachedToken() {
  try {
    const raw = (typeof sessionStorage !== 'undefined') ? sessionStorage.getItem(STORAGE_KEY) : null;
    if (!raw) return null;
    const { token, expiresAt } = JSON.parse(raw);
    if (!token || typeof expiresAt !== 'number') return null;
    if (Date.now() >= expiresAt) return null;
    return token;
  } catch { return null; }
}

function saveCachedToken(token, expiresInSeconds) {
  const expiresAt = Date.now() + (Number(expiresInSeconds) || 3600) * 1000 - SAFETY_MARGIN_MS;
  try {
    if (typeof sessionStorage !== 'undefined') {
      sessionStorage.setItem(STORAGE_KEY, JSON.stringify({ token, expiresAt }));
    }
  } catch { /* ignore quota / private mode */ }
}

function clearCachedToken() {
  try {
    if (typeof sessionStorage !== 'undefined') sessionStorage.removeItem(STORAGE_KEY);
  } catch { /* ignore */ }
}

let gisLoaded = false;
let gisLoading = null;

function loadGis() {
  if (gisLoaded) return Promise.resolve();
  if (gisLoading) return gisLoading;
  gisLoading = new Promise((resolve, reject) => {
    const existing = document.querySelector(`script[src="${GIS_SRC}"]`);
    if (existing) {
      gisLoaded = true;
      resolve();
      return;
    }
    const script = document.createElement('script');
    script.src = GIS_SRC;
    script.async = true;
    script.defer = true;
    script.onload = () => { gisLoaded = true; resolve(); };
    script.onerror = () => reject(new Error('Failed to load Google Identity Services'));
    document.head.appendChild(script);
  });
  return gisLoading;
}

// Returns an OAuth access token. Uses the cached one when still valid;
// only triggers the popup on the first call per session (or after expiry).
async function requestAccessToken(clientId, { forceRefresh = false } = {}) {
  if (!forceRefresh) {
    const cached = loadCachedToken();
    if (cached) return cached;
  }
  await loadGis();
  return new Promise((resolve, reject) => {
    if (!window.google?.accounts?.oauth2) {
      reject(new Error('Google Identity Services not available'));
      return;
    }
    const tokenClient = window.google.accounts.oauth2.initTokenClient({
      client_id: clientId,
      scope: SCOPE,
      callback: (response) => {
        if (response.error) {
          reject(new Error(response.error_description || response.error));
          return;
        }
        saveCachedToken(response.access_token, response.expires_in);
        resolve(response.access_token);
      },
      error_callback: (err) => reject(new Error(err?.message || 'OAuth popup closed')),
    });
    // prompt: '' means "no consent UI unless required" — silent if the
    // user has already granted consent in this browser profile.
    tokenClient.requestAccessToken({ prompt: '' });
  });
}

// Uploads the .xlsx blob to Drive WITH conversion to Google Sheets.
// Returns { id, webViewLink } from the Drive API.
async function uploadAsSheet(accessToken, filename, blob) {
  const metadata = {
    name: filename,
    mimeType: 'application/vnd.google-apps.spreadsheet', // convert on upload
  };
  const form = new FormData();
  form.append('metadata', new Blob([JSON.stringify(metadata)], { type: 'application/json' }));
  form.append('file', blob);
  const url = 'https://www.googleapis.com/upload/drive/v3/files?uploadType=multipart&fields=id,webViewLink';
  const res = await fetch(url, {
    method: 'POST',
    headers: { Authorization: `Bearer ${accessToken}` },
    body: form,
  });
  if (!res.ok) {
    const text = await res.text();
    throw new Error(`Drive upload failed (${res.status}): ${text.slice(0, 200)}`);
  }
  return res.json();
}

// Hide gridlines on every sheet in the newly-created spreadsheet. Google
// Sheets ignores the Excel-level showGridLines attribute on import, so we
// have to set the per-tab `hideGridlines` flag via the Sheets API. Best-
// effort: a failure here doesn't break the open flow.
async function hideGridlines(accessToken, spreadsheetId) {
  try {
    const metaUrl = `https://sheets.googleapis.com/v4/spreadsheets/${spreadsheetId}?fields=sheets.properties(sheetId,title)`;
    const metaRes = await fetch(metaUrl, { headers: { Authorization: `Bearer ${accessToken}` } });
    if (!metaRes.ok) return;
    const meta = await metaRes.json();
    const requests = (meta.sheets || []).map((s) => ({
      updateSheetProperties: {
        properties: {
          sheetId: s.properties.sheetId,
          gridProperties: { hideGridlines: true },
        },
        fields: 'gridProperties.hideGridlines',
      },
    }));
    if (requests.length === 0) return;
    await fetch(`https://sheets.googleapis.com/v4/spreadsheets/${spreadsheetId}:batchUpdate`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${accessToken}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ requests }),
    });
  } catch (e) {
    // Non-fatal — the sheet still opens, just with gridlines visible.
    console.warn('[googleSheets] hideGridlines failed:', e);
  }
}

// Public entry point: uploads + converts + hides gridlines in one call.
// Caller is responsible for opening the resulting URL in a window.
// Handles the case where a cached token has expired on the server side
// (rare, but possible if the user revoked access) — clears the cache
// and retries ONCE with a fresh popup.
export async function uploadXlsxToSheets({ blob, filename, clientId }) {
  let token = await requestAccessToken(clientId);
  let file;
  try {
    file = await uploadAsSheet(token, filename, blob);
  } catch (e) {
    if (/\b401\b|unauthorized/i.test(String(e?.message || e))) {
      clearCachedToken();
      token = await requestAccessToken(clientId, { forceRefresh: true });
      file = await uploadAsSheet(token, filename, blob);
    } else {
      throw e;
    }
  }
  await hideGridlines(token, file.id);
  return {
    fileId: file.id,
    url: `https://docs.google.com/spreadsheets/d/${file.id}/edit`,
    webViewLink: file.webViewLink,
  };
}

export function getGoogleClientId() {
  return import.meta.env.VITE_GOOGLE_CLIENT_ID || null;
}
