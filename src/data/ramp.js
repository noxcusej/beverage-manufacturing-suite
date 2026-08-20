// Browser-side client for the Ramp proxy at /api/ramp.
//
// The proxy holds the credentials; this module only decides where the data
// comes from and degrades to the bundled demo dataset when Ramp isn't wired up
// (fresh deployment, or `npm run dev` without a serverless runtime).

import { demoBills, demoPurchaseOrders, demoDecisions } from './procurementDemo';

const ENDPOINT = '/api/ramp';

/** Where a given payload came from, so the UI can say so plainly. */
export const SOURCE_RAMP = 'ramp';
export const SOURCE_DEMO = 'demo';

function demoPayload(reason) {
  return {
    source: SOURCE_DEMO,
    configured: false,
    reason,
    bills: demoBills,
    purchaseOrders: demoPurchaseOrders,
    seedDecisions: demoDecisions,
    warnings: [],
    fetchedAt: new Date().toISOString(),
  };
}

/**
 * Load bills and purchase orders.
 *
 * @param {object}  opts
 * @param {string}  [opts.client]       scope server-side to one client
 * @param {string[]} [opts.clientFields] accounting field names that carry the client
 * @param {string}  [opts.fromIssuedDate] YYYY-MM-DD
 * @param {string}  [opts.toIssuedDate]   YYYY-MM-DD
 * @param {AbortSignal} [opts.signal]
 * @param {boolean} [opts.forceDemo]     skip the network entirely
 */
export async function fetchProcurementData(opts = {}) {
  if (opts.forceDemo) return demoPayload('Demo data selected.');

  const params = new URLSearchParams({ resource: 'bootstrap' });
  if (opts.client) params.set('client', opts.client);
  if (opts.clientFields?.length) params.set('client_fields', opts.clientFields.join(','));
  if (opts.fromIssuedDate) params.set('from_issued_date', opts.fromIssuedDate);
  if (opts.toIssuedDate) params.set('to_issued_date', opts.toIssuedDate);

  let res;
  try {
    res = await fetch(`${ENDPOINT}?${params}`, {
      signal: opts.signal,
      headers: { Accept: 'application/json' },
    });
  } catch (err) {
    if (err?.name === 'AbortError') throw err;
    return demoPayload(`Could not reach ${ENDPOINT} (${err.message}). Showing demo data.`);
  }

  // A dev server with no serverless runtime answers the SPA fallback HTML for
  // /api/*; treat anything that isn't JSON as "not wired up yet".
  const contentType = res.headers.get('content-type') || '';
  if (!contentType.includes('application/json')) {
    return demoPayload(`${ENDPOINT} did not return JSON — the API route is not running here. Showing demo data.`);
  }

  const json = await res.json().catch(() => null);

  if (!res.ok) {
    const message = json?.error || `Ramp request failed (${res.status}).`;
    // A misconfigured or rate-limited Ramp is a real error worth showing, not
    // something to paper over with demo numbers.
    const err = new Error(message);
    err.status = res.status;
    throw err;
  }

  if (!json?.configured) {
    return demoPayload(json?.reason || 'Ramp credentials are not configured. Showing demo data.');
  }

  return {
    source: SOURCE_RAMP,
    configured: true,
    reason: null,
    bills: json.bills || [],
    purchaseOrders: json.purchaseOrders || [],
    seedDecisions: {},
    warnings: json.warnings || [],
    env: json.env,
    poEndpoint: json.poEndpoint,
    fetchedAt: json.fetchedAt || new Date().toISOString(),
  };
}

/**
 * Build the URL that views or downloads one attachment. Always points at our
 * proxy — Ramp's own links are presigned and expire, so they must be resolved
 * at click time rather than baked into the page.
 */
export function attachmentUrl(doc, { inline = false } = {}) {
  if (!doc?.downloadPath) return null;
  return `${doc.downloadPath}${inline ? '&disposition=inline' : ''}`;
}
