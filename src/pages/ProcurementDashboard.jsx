import { useState, useEffect, useMemo, useCallback } from 'react';
import { useParams, useNavigate } from 'react-router-dom';
import {
  buildProcurementModel,
  formatMoney,
  poMatchesQuery,
  billMatchesQuery,
  toCsvRows,
  UNASSIGNED_CLIENT,
  APPROVED,
  REJECTED,
} from '../data/procurement';
import { fetchProcurementData, attachmentUrl, SOURCE_DEMO } from '../data/ramp';
import { loadComments, postComment, removeComment, groupComments, commentKey, SOURCE_LOCAL } from '../data/comments';
import CommentThread from '../components/CommentThread';
import PortalLinksPanel from '../components/procurement/PortalLinksPanel';
import {
  Stat, ApprovalBadge, PaymentBadge, AttachmentList, LineItems, TotalsStrip,
} from '../components/procurement/Primitives';
import { fmtDate } from '../components/procurement/format';
import {
  getBillDecisions,
  setBillDecision,
  clearBillDecision,
  seedBillDecisions,
  getProcurementSettings,
  saveProcurementSettings,
} from '../data/store';

const ALL_CLIENTS = '__all__';

function csvEscape(cell) {
  const s = String(cell ?? '');
  return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

function downloadCsv(rows, filename) {
  const blob = new Blob([rows.map((r) => r.map(csvEscape).join(',')).join('\n')], {
    type: 'text/csv;charset=utf-8',
  });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  URL.revokeObjectURL(url);
}

// ── Bill row ────────────────────────────────────────────────────────────────

function BillRow({ bill, isDemo, reviewer, comments, onDecision, onClearDecision, onPostComment, onDeleteComment }) {
  const [open, setOpen] = useState(false);
  const rejected = bill.approval.state === REJECTED;
  const shared = comments.filter((c) => c.visibility !== 'internal').length;

  return (
    <>
      <tr className={`proc-bill-row${rejected ? ' proc-bill-row--rejected' : ''}`}>
        <td>
          <button className="proc-disclosure" onClick={() => setOpen((o) => !o)} aria-expanded={open}>
            <span aria-hidden="true">{open ? '▾' : '▸'}</span>
            <span className="proc-bill-number">{bill.number || bill.id}</span>
          </button>
          {bill.documents.length > 0 && (
            <span className="proc-clip" title={`${bill.documents.length} attachment${bill.documents.length === 1 ? '' : 's'}`}>
              &#x1F4CE;{bill.documents.length}
            </span>
          )}
          {comments.length > 0 && (
            <span
              className="proc-clip"
              title={`${comments.length} comment${comments.length === 1 ? '' : 's'}${shared < comments.length ? ` (${comments.length - shared} internal)` : ''}`}
            >
              &#x1F4AC;{comments.length}
            </span>
          )}
        </td>
        <td>{bill.vendorName}</td>
        <td>
          {bill.clientLabel}
          {bill.clientInherited && <span className="proc-hint-mark" title="Inherited from the purchase order — the bill itself carries no client field."> ↳</span>}
        </td>
        <td>{fmtDate(bill.issuedAt)}</td>
        <td>{fmtDate(bill.dueAt)}</td>
        <td><PaymentBadge bill={bill} /></td>
        <td><ApprovalBadge approval={bill.approval} /></td>
        <td className="num proc-amount">{formatMoney(bill.amountCents, bill.currency)}</td>
        <td className="proc-actions">
          {rejected ? (
            <button className="btn btn-small" onClick={() => onClearDecision(bill)} title="Return this bill to approved">
              Restore
            </button>
          ) : (
            <>
              {bill.approval.auto && (
                <button
                  className="btn btn-small"
                  onClick={() => onDecision(bill, APPROVED)}
                  title={reviewer ? `Confirm as ${reviewer}` : 'Confirm this approval explicitly'}
                >
                  Confirm
                </button>
              )}
              <button className="btn btn-small btn-danger" onClick={() => onDecision(bill, REJECTED)}>
                Reject
              </button>
            </>
          )}
        </td>
      </tr>
      {open && (
        <tr className="proc-bill-detail">
          <td colSpan={9}>
            <div className="proc-detail-grid">
              <div>
                <div className="proc-detail-heading">Line items</div>
                <LineItems items={bill.lineItems} currency={bill.currency} />
                {bill.memo && <p className="proc-memo">{bill.memo}</p>}

                <div className="proc-detail-heading" style={{ marginTop: 16 }}>
                  Comments <span className="proc-detail-note">shared with the client portal unless marked internal</span>
                </div>
                <CommentThread
                  comments={comments}
                  authorName={reviewer}
                  allowInternal
                  placeholder="Reply to the client, or leave an internal note…"
                  onPost={({ body, visibility }) => onPostComment({
                    targetType: 'bill', targetId: bill.id, clientName: bill.clientLabel, body, visibility,
                  })}
                  onDelete={onDeleteComment}
                />
              </div>
              <div>
                <div className="proc-detail-heading">Attachments</div>
                <AttachmentList
                  documents={bill.documents}
                  urlFor={(doc, opts) => (isDemo ? null : attachmentUrl(doc, opts))}
                  unavailableNote="demo · no file"
                />
                <div className="proc-detail-heading" style={{ marginTop: 16 }}>Approval</div>
                {rejected ? (
                  <p className="proc-decision proc-decision--rejected">
                    Rejected{bill.approval.by ? ` by ${bill.approval.by}` : ''} on {fmtDate(bill.approval.at)}.
                    {bill.approval.reason && <><br /><em>{bill.approval.reason}</em></>}
                  </p>
                ) : bill.approval.auto ? (
                  <p className="proc-decision">
                    Approved automatically on arrival. Bills stay approved unless they are rejected here.
                  </p>
                ) : (
                  <p className="proc-decision">
                    Confirmed{bill.approval.by ? ` by ${bill.approval.by}` : ''} on {fmtDate(bill.approval.at)}.
                  </p>
                )}
                {bill.deepLink && (
                  <a className="proc-link" href={bill.deepLink} target="_blank" rel="noopener noreferrer">Open in Ramp &#x2197;</a>
                )}
              </div>
            </div>
          </td>
        </tr>
      )}
    </>
  );
}

function BillTable({ bills, commentsByTarget, ...handlers }) {
  return (
    <table className="proc-table">
      <thead>
        <tr>
          <th>Bill</th><th>Vendor</th><th>Client</th><th>Invoiced</th><th>Due</th>
          <th>Payment</th><th>Approval</th><th className="num">Amount</th><th />
        </tr>
      </thead>
      <tbody>
        {bills.map((bill) => (
          <BillRow
            key={bill.id}
            bill={bill}
            comments={commentsByTarget.get(commentKey('bill', bill.id)) || []}
            {...handlers}
          />
        ))}
      </tbody>
    </table>
  );
}

// ── Purchase order group ────────────────────────────────────────────────────

function PoGroup({ po, isDemo, reviewer, commentsByTarget, onPostComment, onDeleteComment, ...billHandlers }) {
  const [open, setOpen] = useState(true);
  const [showPoComments, setShowPoComments] = useState(false);
  const { subtotal } = po;
  const hasCommitment = po.amountCents > 0;
  const pct = hasCommitment ? Math.min(100, Math.round((subtotal.approvedCents / po.amountCents) * 100)) : 0;
  const poComments = commentsByTarget.get(commentKey('purchase_order', po.id)) || [];

  return (
    <section className="proc-po">
      <header className="proc-po-header">
        <button className="proc-disclosure proc-disclosure--lg" onClick={() => setOpen((o) => !o)} aria-expanded={open}>
          <span aria-hidden="true">{open ? '▾' : '▸'}</span>
          <span className="proc-po-number">{po.number || po.id}</span>
        </button>
        <div className="proc-po-meta">
          <span>{po.vendorName}</span>
          <span className="proc-sep">&middot;</span>
          <span className="proc-po-client">{po.clientLabel}</span>
          <span className="proc-sep">&middot;</span>
          <span>Issued {fmtDate(po.issuedAt)}</span>
          <span className={`proc-badge proc-badge--${po.status === 'CLOSED' ? 'muted' : 'open'}`}>{po.status}</span>
        </div>
        <div className="proc-po-numbers">
          <div>
            <span className="proc-po-numbers-label">Committed</span>
            <strong>{hasCommitment ? formatMoney(po.amountCents, po.currency) : 'n/a'}</strong>
          </div>
          <div>
            <span className="proc-po-numbers-label">Billed (approved)</span>
            <strong>{formatMoney(subtotal.approvedCents, po.currency)}</strong>
          </div>
          <div>
            <span className="proc-po-numbers-label">Remaining</span>
            <strong className={po.overBilled ? 'proc-over' : undefined}>
              {hasCommitment ? formatMoney(po.remainingCents, po.currency) : 'n/a'}
            </strong>
          </div>
        </div>
      </header>

      {hasCommitment && (
        <div className="proc-progress" title={`${pct}% of the PO billed and approved`}>
          <div className={`proc-progress-fill${po.overBilled ? ' proc-progress-fill--over' : ''}`} style={{ width: `${po.overBilled ? 100 : pct}%` }} />
        </div>
      )}
      {po.overBilled && (
        <p className="proc-warning-inline">
          Approved bills exceed this PO by {formatMoney(subtotal.approvedCents - po.amountCents, po.currency)}.
        </p>
      )}

      {open && (
        <>
          {po.bills.length === 0 ? (
            <p className="proc-empty-inline">No bills against this PO yet.</p>
          ) : (
            <BillTable
              bills={po.bills}
              isDemo={isDemo}
              reviewer={reviewer}
              commentsByTarget={commentsByTarget}
              onPostComment={onPostComment}
              onDeleteComment={onDeleteComment}
              {...billHandlers}
            />
          )}

          <footer className="proc-po-footer">
            <span>
              {subtotal.billCount} bill{subtotal.billCount === 1 ? '' : 's'}
              {subtotal.rejectedCount > 0 && ` · ${subtotal.rejectedCount} rejected`}
              {' · '}
              <button className="proc-linkbtn" onClick={() => setShowPoComments((s) => !s)}>
                {poComments.length ? `${poComments.length} comment${poComments.length === 1 ? '' : 's'}` : 'Comment on this PO'}
              </button>
            </span>
            <TotalsStrip totals={subtotal} currency={po.currency} />
          </footer>

          {showPoComments && (
            <div className="proc-po-docs">
              <CommentThread
                comments={poComments}
                authorName={reviewer}
                allowInternal
                placeholder="Comment on this purchase order…"
                onPost={({ body, visibility }) => onPostComment({
                  targetType: 'purchase_order', targetId: po.id, clientName: po.clientLabel, body, visibility,
                })}
                onDelete={onDeleteComment}
              />
            </div>
          )}

          {po.documents.length > 0 && (
            <div className="proc-po-docs">
              <span className="proc-detail-heading">PO documents</span>
              <AttachmentList
                documents={po.documents}
                urlFor={(doc, opts) => (isDemo ? null : attachmentUrl(doc, opts))}
                unavailableNote="demo · no file"
              />
            </div>
          )}
        </>
      )}
    </section>
  );
}

// ── Page ────────────────────────────────────────────────────────────────────

export default function ProcurementDashboard() {
  const { clientName } = useParams();
  const navigate = useNavigate();
  const routeClient = clientName ? decodeURIComponent(clientName) : null;

  const [payload, setPayload] = useState(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);
  const [decisions, setDecisions] = useState(getBillDecisions());
  const [settings, setSettings] = useState(getProcurementSettings());
  const [comments, setComments] = useState([]);
  const [commentSource, setCommentSource] = useState(null);
  const [commentNotice, setCommentNotice] = useState(null);
  const [query, setQuery] = useState('');
  const [statusFilter, setStatusFilter] = useState('all');
  const [showSettings, setShowSettings] = useState(false);
  const [showLinks, setShowLinks] = useState(false);
  // A client pinned in the URL always wins over the in-page picker, so the
  // selection is derived rather than mirrored into state.
  const [pickedClient, setPickedClient] = useState(ALL_CLIENTS);
  const selectedClient = routeClient || pickedClient;

  // Every state update below happens in a promise callback, never synchronously
  // in the effect body — the spinner is turned on by whoever triggers the load.
  const load = useCallback((signal) => Promise.all([
    fetchProcurementData({
      client: routeClient || undefined,
      clientFields: settings.clientFieldNames,
      signal,
    })
      .then((data) => {
        setPayload(data);
        setError(null);
        if (data.seedDecisions) {
          seedBillDecisions(data.seedDecisions);
          setDecisions(getBillDecisions());
        }
      })
      .catch((err) => {
        if (err?.name === 'AbortError') return;
        setError(err.message);
      }),
    loadComments({ client: routeClient || undefined, signal })
      .then(({ source, comments: list, reason }) => {
        setComments(list);
        setCommentSource(source);
        setCommentNotice(reason);
      })
      .catch((err) => {
        if (err?.name === 'AbortError') return;
        setCommentNotice(err.message);
      }),
  ]).finally(() => setLoading(false)), [routeClient, settings.clientFieldNames]);

  useEffect(() => {
    const controller = new AbortController();
    load(controller.signal);
    return () => controller.abort();
  }, [load]);

  useEffect(() => {
    const refresh = () => {
      setDecisions(getBillDecisions());
      setSettings(getProcurementSettings());
    };
    window.addEventListener('comanufacturing:datachange', refresh);
    return () => window.removeEventListener('comanufacturing:datachange', refresh);
  }, []);

  const isDemo = payload?.source === SOURCE_DEMO;

  const modelOptions = useMemo(() => ({
    clientFieldNames: settings.clientFieldNames,
    useEntityAsClient: settings.useEntityAsClient,
    overrides: settings.clientOverrides,
  }), [settings]);

  // Full model, unscoped — the client picker and the per-client strip need to
  // see every client, even while one is selected.
  const fullModel = useMemo(() => buildProcurementModel({
    bills: payload?.bills || [],
    purchaseOrders: payload?.purchaseOrders || [],
    decisions,
    options: modelOptions,
  }), [payload, decisions, modelOptions]);

  const activeClient = selectedClient === ALL_CLIENTS ? null : selectedClient;

  const model = useMemo(() => (activeClient
    ? buildProcurementModel({
      bills: payload?.bills || [],
      purchaseOrders: payload?.purchaseOrders || [],
      decisions,
      client: activeClient,
      options: modelOptions,
    })
    : fullModel), [activeClient, payload, decisions, modelOptions, fullModel]);

  const commentsByTarget = useMemo(() => groupComments(comments), [comments]);

  const billPassesStatus = useCallback((bill) => {
    switch (statusFilter) {
      case 'approved': return bill.approval.state === APPROVED;
      case 'rejected': return bill.approval.state === REJECTED;
      case 'outstanding': return bill.approval.state === APPROVED && !bill.isPaid;
      case 'paid': return bill.approval.state === APPROVED && bill.isPaid;
      default: return true;
    }
  }, [statusFilter]);

  const visible = useMemo(() => {
    const pos = model.purchaseOrders
      .map((po) => ({ ...po, bills: po.bills.filter(billPassesStatus) }))
      .filter((po) => poMatchesQuery(po, query))
      // A PO with no bills is still worth showing when nothing is filtering
      // bills out — it is a live commitment with nothing drawn against it yet.
      .filter((po) => po.bills.length > 0 || statusFilter === 'all');
    const unlinked = model.unlinkedBills
      .filter(billPassesStatus)
      .filter((b) => billMatchesQuery(b, query));
    return { pos, unlinked };
  }, [model, query, statusFilter, billPassesStatus]);

  function handleDecision(bill, state) {
    let reason = null;
    if (state === REJECTED) {
      reason = window.prompt(`Reject ${bill.number || bill.id} (${formatMoney(bill.amountCents, bill.currency)})?\n\nReason:`);
      if (reason === null) return; // cancelled
    }
    setBillDecision(bill.id, {
      status: state,
      by: settings.reviewerName || null,
      reason: reason?.trim() || null,
    });
    setDecisions(getBillDecisions());
  }

  function handleClearDecision(bill) {
    clearBillDecision(bill.id);
    setDecisions(getBillDecisions());
  }

  const handlePostComment = useCallback(async ({ targetType, targetId, clientName: target, body, visibility }) => {
    const { comment, source } = await postComment({
      targetType, targetId, clientName: target, body, visibility,
      authorName: settings.reviewerName || null,
    });
    setComments((prev) => [...prev, comment]);
    setCommentSource(source);
  }, [settings.reviewerName]);

  const handleDeleteComment = useCallback(async (comment) => {
    if (!window.confirm('Delete this comment? The client will no longer see it.')) return;
    await removeComment(comment);
    setComments((prev) => prev.filter((c) => c.id !== comment.id));
  }, []);

  function handleClientChange(value) {
    setPickedClient(value);
    // Keep the URL honest: a pinned client is a shareable, server-scoped view.
    if (routeClient) navigate(value === ALL_CLIENTS ? '/procurement' : `/procurement/${encodeURIComponent(value)}`);
  }

  function updateSettings(patch) {
    saveProcurementSettings(patch);
    setSettings(getProcurementSettings());
  }

  const { totals } = model;
  const scopeLabel = activeClient || 'All clients';

  const billHandlers = {
    isDemo,
    reviewer: settings.reviewerName,
    onDecision: handleDecision,
    onClearDecision: handleClearDecision,
    onPostComment: handlePostComment,
    onDeleteComment: handleDeleteComment,
  };

  if (loading && !payload) {
    return <div className="proc-page"><p className="proc-empty">Loading procurement data…</p></div>;
  }

  return (
    <div className="proc-page">
      <header className="proc-header">
        <div>
          <h1 className="proc-title">Procurement</h1>
          <p className="proc-subtitle">
            Purchase orders, bills and invoice files for <strong>{scopeLabel}</strong>
            {payload?.fetchedAt && <> &middot; updated {new Date(payload.fetchedAt).toLocaleTimeString()}</>}
          </p>
        </div>
        <div className="proc-header-actions">
          <span className={`proc-source proc-source--${isDemo ? 'demo' : 'live'}`}>
            {isDemo ? 'Demo data' : `Ramp · ${payload?.env || 'live'}`}
          </span>
          <button className="btn btn-small" onClick={() => { setLoading(true); load(); }} disabled={loading}>
            {loading ? 'Refreshing…' : 'Refresh'}
          </button>
          <button
            className="btn btn-small"
            onClick={() => downloadCsv(toCsvRows(model), `procurement-${activeClient || 'all'}-${new Date().toISOString().slice(0, 10)}.csv`)}
          >
            Export CSV
          </button>
          <button className="btn btn-small" onClick={() => setShowLinks((s) => !s)}>
            {showLinks ? 'Close client links' : 'Client links'}
          </button>
          <button className="btn btn-small" onClick={() => setShowSettings((s) => !s)}>
            {showSettings ? 'Close settings' : 'Settings'}
          </button>
        </div>
      </header>

      {error && (
        <div className="proc-banner proc-banner--error">
          <strong>Ramp request failed.</strong> {error}
        </div>
      )}
      {isDemo && payload?.reason && (
        <div className="proc-banner">
          <strong>Showing demo data.</strong> {payload.reason} Set <code>RAMP_CLIENT_ID</code> and{' '}
          <code>RAMP_CLIENT_SECRET</code> on the deployment to pull live purchase orders and bills.
        </div>
      )}
      {commentSource === SOURCE_LOCAL && commentNotice && (
        <div className="proc-banner proc-banner--warn">
          <strong>Comments are local.</strong> {commentNotice}
        </div>
      )}
      {payload?.warnings?.map((w) => (
        <div className="proc-banner proc-banner--warn" key={w}>{w}</div>
      ))}
      {totals.mixedCurrency && (
        <div className="proc-banner proc-banner--warn">
          These bills span {totals.currencies.join(', ')}. Totals below add the raw amounts together
          without converting, so read them per currency rather than as one figure.
        </div>
      )}

      {showLinks && (
        <PortalLinksPanel
          clients={fullModel.clients.map((c) => c.name)}
          defaultClient={activeClient}
          createdBy={settings.reviewerName}
        />
      )}

      {showSettings && (
        <section className="proc-settings">
          <div className="proc-settings-field">
            <label htmlFor="proc-client-fields">Ramp accounting field(s) that carry the client</label>
            <input
              id="proc-client-fields"
              className="search-box"
              value={settings.clientFieldNames.join(', ')}
              onChange={(e) => updateSettings({
                clientFieldNames: e.target.value.split(',').map((s) => s.trim().toLowerCase()).filter(Boolean),
              })}
            />
            <small>
              Matched case-insensitively against each bill&apos;s accounting field names. Confirm this
              against the tenant&apos;s Ramp setup — the field is usually a custom dimension.
            </small>
          </div>
          <div className="proc-settings-field">
            <label htmlFor="proc-reviewer">Record approvals and comments as</label>
            <input
              id="proc-reviewer"
              className="search-box"
              placeholder="name or email"
              value={settings.reviewerName}
              onChange={(e) => updateSettings({ reviewerName: e.target.value })}
            />
          </div>
          <div className="proc-settings-field">
            <label>
              <input
                type="checkbox"
                checked={settings.useEntityAsClient}
                onChange={(e) => updateSettings({ useEntityAsClient: e.target.checked })}
              />{' '}
              Fall back to the Ramp entity name as the client
            </label>
            <small>Use this when each client is set up as its own Ramp entity rather than a field value.</small>
          </div>
        </section>
      )}

      <div className="proc-controls">
        <select
          className="proc-select"
          value={selectedClient}
          onChange={(e) => handleClientChange(e.target.value)}
          aria-label="Client"
        >
          <option value={ALL_CLIENTS}>All clients ({fullModel.clients.length})</option>
          {fullModel.clients.map((c) => (
            <option key={c.name} value={c.name}>{c.name}</option>
          ))}
        </select>
        <input
          className="search-box proc-search"
          placeholder="Search POs, bills, vendors, files…"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
        />
        <select className="proc-select" value={statusFilter} onChange={(e) => setStatusFilter(e.target.value)} aria-label="Status filter">
          <option value="all">All bills</option>
          <option value="approved">Approved only</option>
          <option value="outstanding">Approved &amp; unpaid</option>
          <option value="paid">Approved &amp; paid</option>
          <option value="rejected">Rejected only</option>
        </select>
        {activeClient && !routeClient && (
          <button className="btn btn-small" onClick={() => navigate(`/procurement/${encodeURIComponent(activeClient)}`)}>
            Pin this client view
          </button>
        )}
        {routeClient && (
          <button className="btn btn-small" onClick={() => navigate('/procurement')}>
            Leave client view
          </button>
        )}
      </div>

      <div className="proc-stats">
        <Stat label="PO committed" value={formatMoney(totals.poCommittedCents, totals.currency)} hint={`${totals.poCount} purchase order${totals.poCount === 1 ? '' : 's'}`} />
        <Stat label="Approved billed" value={formatMoney(totals.approvedCents, totals.currency)} hint={`${totals.approvedCount} of ${totals.billCount} bills`} tone="brand" />
        <Stat label="Outstanding" value={formatMoney(totals.outstandingCents, totals.currency)} hint="approved, not yet paid" tone="warn" />
        <Stat label="Paid" value={formatMoney(totals.paidCents, totals.currency)} hint="approved and settled" tone="ok" />
        <Stat label="Rejected" value={formatMoney(totals.rejectedCents, totals.currency)} hint={`${totals.rejectedCount} excluded from totals`} tone="danger" />
        <Stat label="PO remaining" value={formatMoney(totals.poRemainingCents, totals.currency)} hint="committed less approved" />
      </div>

      {!activeClient && fullModel.clients.length > 1 && (
        <section className="proc-client-strip">
          <div className="proc-detail-heading">Subtotal by client</div>
          <div className="proc-client-cards">
            {fullModel.clients.map((c) => (
              <button key={c.name} className="proc-client-card" onClick={() => handleClientChange(c.name)} title={`Show only ${c.name}`}>
                <div className="proc-client-name">{c.name}</div>
                <div className="proc-client-amount">{formatMoney(c.approvedCents, c.currency)}</div>
                <div className="proc-client-meta">
                  {c.approvedCount} approved
                  {c.rejectedCount > 0 && ` · ${c.rejectedCount} rejected`}
                  {c.outstandingCents > 0 && ` · ${formatMoney(c.outstandingCents, c.currency)} open`}
                </div>
              </button>
            ))}
          </div>
          {fullModel.clients.some((c) => c.name === UNASSIGNED_CLIENT) && (
            <p className="proc-note">
              Bills under <em>{UNASSIGNED_CLIENT}</em> carry no client field in Ramp and belong to no PO
              that does. Set the right field name in Settings, or tag them in Ramp.
            </p>
          )}
        </section>
      )}

      {visible.pos.length === 0 && visible.unlinked.length === 0 ? (
        <p className="proc-empty">Nothing matches the current filters.</p>
      ) : (
        <>
          {visible.pos.map((po) => (
            <PoGroup key={po.id} po={po} commentsByTarget={commentsByTarget} {...billHandlers} />
          ))}

          {visible.unlinked.length > 0 && (
            <section className="proc-po proc-po--unlinked">
              <header className="proc-po-header">
                <span className="proc-po-number">No purchase order</span>
                <div className="proc-po-meta">
                  <span>{visible.unlinked.length} bill{visible.unlinked.length === 1 ? '' : 's'} with no PO reference</span>
                </div>
              </header>
              <BillTable bills={visible.unlinked} commentsByTarget={commentsByTarget} {...billHandlers} />
            </section>
          )}
        </>
      )}

      <footer className="proc-grand-total">
        <span>{scopeLabel} &middot; {totals.billCount} bill{totals.billCount === 1 ? '' : 's'}</span>
        <TotalsStrip totals={totals} currency={totals.currency} bold />
      </footer>
    </div>
  );
}
