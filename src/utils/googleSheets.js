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
const SCOPE = 'https://www.googleapis.com/auth/drive.file';

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

// Returns the OAuth access token (popup flow). Rejects if the user
// cancels or the client ID is invalid.
async function requestAccessToken(clientId) {
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
        resolve(response.access_token);
      },
      error_callback: (err) => reject(new Error(err?.message || 'OAuth popup closed')),
    });
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

// Public entry point: uploads + converts in one call. Caller is responsible
// for opening the resulting URL in a window (sync from click).
export async function uploadXlsxToSheets({ blob, filename, clientId }) {
  const token = await requestAccessToken(clientId);
  const file = await uploadAsSheet(token, filename, blob);
  return {
    fileId: file.id,
    url: `https://docs.google.com/spreadsheets/d/${file.id}/edit`,
    webViewLink: file.webViewLink,
  };
}

export function getGoogleClientId() {
  return import.meta.env.VITE_GOOGLE_CLIENT_ID || null;
}
