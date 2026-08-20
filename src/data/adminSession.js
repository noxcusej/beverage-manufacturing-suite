// Admin key for the current browser tab.
//
// "Only an admin can edit or reopen a deadline" needs some way for a staff user
// to prove they are one. With no login in this application, that is a shared
// key the server verifies — so the browser's only job is to hold it for the
// session and attach it to the requests that need it.
//
// Held in sessionStorage deliberately: it dies with the tab, is never written
// to localStorage, never synced to Supabase, and never included in any payload
// the portal can see.

const KEY = 'procurement.adminKey';

function storage() {
  try {
    return window.sessionStorage;
  } catch {
    // Private mode or a blocked storage partition — degrade to prompting each
    // time rather than failing the action outright.
    return null;
  }
}

export function getAdminKey() {
  return storage()?.getItem(KEY) || null;
}

export function setAdminKey(key) {
  const value = String(key || '').trim();
  if (!value) return null;
  storage()?.setItem(KEY, value);
  return value;
}

export function clearAdminKey() {
  storage()?.removeItem(KEY);
}

export function hasAdminKey() {
  return Boolean(getAdminKey());
}

/**
 * Return the key, asking for it if this tab does not have one yet.
 * @returns {string|null} null when the user cancels.
 */
export function requireAdminKey(purpose = 'this admin action') {
  const existing = getAdminKey();
  if (existing) return existing;
  const entered = window.prompt(
    `Admin key required for ${purpose}.\n\nIt is kept for this browser tab only.`
  );
  return entered === null ? null : setAdminKey(entered);
}

export function adminHeaders() {
  const key = getAdminKey();
  return key ? { 'x-admin-key': key } : {};
}
