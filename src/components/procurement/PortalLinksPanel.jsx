import { useState, useEffect, useCallback } from 'react';
import { listPortalLinks, createPortalLink, revokePortalLink } from '../../data/portalClient';

// Staff panel for minting, listing and revoking per-client portal links.
//
// A minted link is shown exactly once. Only a SHA-256 hash of the token is
// stored, so there is no endpoint — and no database row — that can show it
// again; the remedy for a lost link is to mint a new one and revoke the old.

function fmt(iso) {
  if (!iso) return '—';
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? '—' : d.toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' });
}

function linkState(link) {
  if (link.revoked_at) return { label: 'Revoked', tone: 'muted' };
  if (link.expires_at && new Date(link.expires_at) < new Date()) return { label: 'Expired', tone: 'muted' };
  return { label: 'Active', tone: 'paid' };
}

export default function PortalLinksPanel({ clients = [], defaultClient = null, createdBy = '' }) {
  const [state, setState] = useState({ available: false, links: [], reason: null });
  const [loading, setLoading] = useState(true);
  const [client, setClient] = useState(defaultClient || clients[0] || '');
  const [label, setLabel] = useState('');
  const [expires, setExpires] = useState('');
  const [minted, setMinted] = useState(null);
  const [error, setError] = useState(null);
  const [busy, setBusy] = useState(false);
  const [copied, setCopied] = useState(false);

  const refresh = useCallback((signal) => listPortalLinks({ signal })
    .then((result) => setState(result))
    .catch((err) => { if (err?.name !== 'AbortError') setError(err.message); })
    .finally(() => setLoading(false)), []);

  useEffect(() => {
    const controller = new AbortController();
    refresh(controller.signal);
    return () => controller.abort();
  }, [refresh]);

  async function mint(e) {
    e.preventDefault();
    if (!client.trim() || busy) return;
    setBusy(true);
    setError(null);
    setCopied(false);
    try {
      const result = await createPortalLink({
        clientName: client.trim(),
        label: label.trim() || null,
        createdBy: createdBy || null,
        expiresAt: expires ? new Date(`${expires}T23:59:59Z`).toISOString() : null,
      });
      setMinted(result);
      setLabel('');
      setExpires('');
      await refresh();
    } catch (err) {
      setError(err.message);
    } finally {
      setBusy(false);
    }
  }

  async function revoke(link) {
    if (!window.confirm(`Revoke this link for ${link.client_name}? Anyone holding it loses access immediately.`)) return;
    try {
      await revokePortalLink(link.id);
      await refresh();
    } catch (err) {
      setError(err.message);
    }
  }

  async function copy(url) {
    try {
      await navigator.clipboard.writeText(url);
      setCopied(true);
    } catch {
      setCopied(false);
    }
  }

  return (
    <section className="proc-settings portal-links">
      <div className="portal-links-head">
        <div>
          <div className="proc-detail-heading" style={{ marginBottom: 2 }}>Client portal links</div>
          <p className="proc-note" style={{ marginTop: 0 }}>
            Each link opens a standalone page showing only that client&apos;s purchase orders, bills and
            files. It has no navigation into the rest of the suite.
          </p>
        </div>
      </div>

      {!loading && !state.available && (
        <div className="proc-banner proc-banner--warn" style={{ gridColumn: '1 / -1' }}>
          <strong>Portal links are unavailable.</strong> {state.reason}
        </div>
      )}

      {state.available && state.adminKeyConfigured === false && (
        <div className="proc-banner proc-banner--warn" style={{ gridColumn: '1 / -1' }}>
          <strong>This endpoint is unauthenticated.</strong> Set <code>PROCUREMENT_ADMIN_KEY</code> on
          the deployment before sharing a link — without it, anyone who can reach this URL can mint a
          link to any client&apos;s data.
        </div>
      )}

      {error && (
        <div className="proc-banner proc-banner--error" style={{ gridColumn: '1 / -1' }}>{error}</div>
      )}

      {minted && (
        <div className="portal-minted" style={{ gridColumn: '1 / -1' }}>
          <div className="portal-minted-head">
            Link for <strong>{minted.link.client_name}</strong> — copy it now, it cannot be shown again.
          </div>
          <div className="portal-minted-row">
            <input className="search-box" readOnly value={minted.url} onFocus={(e) => e.target.select()} />
            <button className="btn btn-small btn-primary" onClick={() => copy(minted.url)}>
              {copied ? 'Copied' : 'Copy'}
            </button>
            <button className="btn btn-small" onClick={() => { setMinted(null); setCopied(false); }}>Done</button>
          </div>
        </div>
      )}

      <form className="portal-links-form" onSubmit={mint} style={{ gridColumn: '1 / -1' }}>
        <div className="proc-settings-field">
          <label htmlFor="plink-client">Client</label>
          <input
            id="plink-client"
            className="search-box"
            list="plink-clients"
            value={client}
            placeholder="Client name, exactly as it appears in Ramp"
            onChange={(e) => setClient(e.target.value)}
          />
          <datalist id="plink-clients">
            {clients.map((c) => <option key={c} value={c} />)}
          </datalist>
        </div>
        <div className="proc-settings-field">
          <label htmlFor="plink-label">Label (optional)</label>
          <input id="plink-label" className="search-box" placeholder="e.g. Dana in AP" value={label} onChange={(e) => setLabel(e.target.value)} />
        </div>
        <div className="proc-settings-field">
          <label htmlFor="plink-expires">Expires (optional)</label>
          <input id="plink-expires" className="search-box" type="date" value={expires} onChange={(e) => setExpires(e.target.value)} />
        </div>
        <div className="proc-settings-field portal-links-submit">
          <button className="btn btn-primary" type="submit" disabled={busy || !client.trim() || !state.available}>
            {busy ? 'Creating…' : 'Create link'}
          </button>
        </div>
      </form>

      {state.links.length > 0 && (
        <table className="proc-table" style={{ gridColumn: '1 / -1' }}>
          <thead>
            <tr>
              <th>Client</th><th>Label</th><th>Token</th><th>Created</th>
              <th>Last opened</th><th>Expires</th><th>Status</th><th />
            </tr>
          </thead>
          <tbody>
            {state.links.map((link) => {
              const s = linkState(link);
              return (
                <tr key={link.id}>
                  <td><strong>{link.client_name}</strong></td>
                  <td>{link.label || '—'}</td>
                  <td><code className="portal-token-prefix">{link.token_prefix}…</code></td>
                  <td>{fmt(link.created_at)}</td>
                  <td>{link.last_seen_at ? fmt(link.last_seen_at) : 'never'}</td>
                  <td>{link.expires_at ? fmt(link.expires_at) : 'never'}</td>
                  <td><span className={`proc-badge proc-badge--${s.tone}`}>{s.label}</span></td>
                  <td className="proc-actions">
                    {!link.revoked_at && (
                      <button className="btn btn-small btn-danger" onClick={() => revoke(link)}>Revoke</button>
                    )}
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      )}
    </section>
  );
}
