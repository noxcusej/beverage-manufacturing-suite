import { useState, useEffect, useMemo, useCallback } from 'react';
import { useParams } from 'react-router-dom';
import { buildProcurementModel, formatMoney } from '../data/procurement';
import { fetchPortalData, postPortalComment, portalAttachmentUrl } from '../data/portalClient';
import { groupComments, commentKey } from '../data/comments';
import CommentThread from '../components/CommentThread';
import {
  Stat, ApprovalBadge, PaymentBadge, AttachmentList, LineItems, TotalsStrip,
} from '../components/procurement/Primitives';
import { fmtDate } from '../components/procurement/format';

// Client Portal — the standalone, shareable view of one client's procurement.
//
// Rendered outside the suite's Layout: no sidebar, no navigation, no route
// into the manufacturing or financial tools. The only data it can obtain is
// whatever /api/portal returns for its share token, and the server derives the
// client from that token rather than from anything in this file.
//
// Clients may read and comment. Approving and rejecting are staff actions and
// have no control here.

function PortalBillRow({ bill, token, comments, onPost, authorName }) {
  const [open, setOpen] = useState(false);
  const count = comments.length;

  return (
    <>
      <tr className={`proc-bill-row${bill.approval.state === 'rejected' ? ' proc-bill-row--rejected' : ''}`}>
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
        </td>
        <td>{bill.vendorName}</td>
        <td>{fmtDate(bill.issuedAt)}</td>
        <td>{fmtDate(bill.dueAt)}</td>
        <td><PaymentBadge bill={bill} /></td>
        <td><ApprovalBadge approval={bill.approval} /></td>
        <td className="num proc-amount">{formatMoney(bill.amountCents, bill.currency)}</td>
        <td className="proc-actions">
          <button className="btn btn-small" onClick={() => setOpen(true)}>
            {count ? `Comments (${count})` : 'Comment'}
          </button>
        </td>
      </tr>
      {open && (
        <tr className="proc-bill-detail">
          <td colSpan={8}>
            <div className="proc-detail-grid">
              <div>
                <div className="proc-detail-heading">Line items</div>
                <LineItems items={bill.lineItems} currency={bill.currency} />
                {bill.memo && <p className="proc-memo">{bill.memo}</p>}
                <div className="proc-detail-heading" style={{ marginTop: 16 }}>Attachments</div>
                <AttachmentList
                  documents={bill.documents}
                  urlFor={(doc, opts) => portalAttachmentUrl(token, doc, opts)}
                />
              </div>
              <div>
                <div className="proc-detail-heading">Comments</div>
                <CommentThread
                  comments={comments}
                  authorName={authorName}
                  placeholder="Question about this bill?"
                  emptyLabel="No comments on this bill yet. Ask us anything about it."
                  onPost={({ body }) => onPost({ targetType: 'bill', targetId: bill.id, body })}
                />
                {bill.approval.state === 'rejected' && (
                  <p className="proc-decision proc-decision--rejected" style={{ marginTop: 12 }}>
                    This bill was rejected on {fmtDate(bill.approval.at)}
                    {bill.approval.reason ? `: ${bill.approval.reason}` : '.'}
                  </p>
                )}
              </div>
            </div>
          </td>
        </tr>
      )}
    </>
  );
}

function PortalPoGroup({ po, token, commentsByTarget, onPost, authorName }) {
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
          <span>Issued {fmtDate(po.issuedAt)}</span>
          <span className={`proc-badge proc-badge--${po.status === 'CLOSED' ? 'muted' : 'open'}`}>{po.status}</span>
        </div>
        <div className="proc-po-numbers">
          <div>
            <span className="proc-po-numbers-label">Committed</span>
            <strong>{hasCommitment ? formatMoney(po.amountCents, po.currency) : 'n/a'}</strong>
          </div>
          <div>
            <span className="proc-po-numbers-label">Billed</span>
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
        <div className="proc-progress" title={`${pct}% of this PO billed`}>
          <div className={`proc-progress-fill${po.overBilled ? ' proc-progress-fill--over' : ''}`} style={{ width: `${po.overBilled ? 100 : pct}%` }} />
        </div>
      )}

      {open && (
        <>
          {po.bills.length === 0 ? (
            <p className="proc-empty-inline">No bills against this PO yet.</p>
          ) : (
            <table className="proc-table">
              <thead>
                <tr>
                  <th>Bill</th><th>Vendor</th><th>Invoiced</th><th>Due</th>
                  <th>Payment</th><th>Status</th><th className="num">Amount</th><th />
                </tr>
              </thead>
              <tbody>
                {po.bills.map((bill) => (
                  <PortalBillRow
                    key={bill.id}
                    bill={bill}
                    token={token}
                    authorName={authorName}
                    comments={commentsByTarget.get(commentKey('bill', bill.id)) || []}
                    onPost={onPost}
                  />
                ))}
              </tbody>
            </table>
          )}

          <footer className="proc-po-footer">
            <span>
              {subtotal.billCount} bill{subtotal.billCount === 1 ? '' : 's'}
              {' · '}
              <button className="proc-linkbtn" onClick={() => setShowPoComments((s) => !s)}>
                {poComments.length ? `${poComments.length} comment${poComments.length === 1 ? '' : 's'} on this PO` : 'Comment on this PO'}
              </button>
            </span>
            <TotalsStrip totals={subtotal} currency={po.currency} />
          </footer>

          {showPoComments && (
            <div className="proc-po-docs">
              <CommentThread
                comments={poComments}
                authorName={authorName}
                placeholder="Question about this purchase order?"
                emptyLabel="No comments on this purchase order yet."
                onPost={({ body }) => onPost({ targetType: 'purchase_order', targetId: po.id, body })}
              />
            </div>
          )}

          {po.documents.length > 0 && (
            <div className="proc-po-docs">
              <span className="proc-detail-heading">PO documents</span>
              <AttachmentList
                documents={po.documents}
                urlFor={(doc, opts) => portalAttachmentUrl(token, doc, opts)}
              />
            </div>
          )}
        </>
      )}
    </section>
  );
}

export default function ClientPortal() {
  const { token } = useParams();
  const [data, setData] = useState(null);
  const [comments, setComments] = useState([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);
  const [authorName, setAuthorName] = useState('');

  useEffect(() => {
    const controller = new AbortController();
    fetchPortalData(token, { signal: controller.signal })
      .then((json) => {
        setData(json);
        setComments(json.comments || []);
        setError(null);
      })
      .catch((err) => {
        if (err?.name === 'AbortError') return;
        setError(err);
      })
      .finally(() => setLoading(false));
    return () => controller.abort();
  }, [token]);

  const model = useMemo(() => buildProcurementModel({
    bills: data?.bills || [],
    purchaseOrders: data?.purchaseOrders || [],
    decisions: data?.decisions || {},
  }), [data]);

  const commentsByTarget = useMemo(() => groupComments(comments), [comments]);

  const handlePost = useCallback(async ({ targetType, targetId, body }) => {
    const comment = await postPortalComment(token, {
      targetType, targetId, body, authorName: authorName.trim() || undefined,
    });
    setComments((prev) => [...prev, comment]);
  }, [token, authorName]);

  if (loading) {
    return <div className="portal-shell"><p className="proc-empty">Loading your procurement portal…</p></div>;
  }

  // A dead or wrong link gets a plain explanation and nothing else — no hint
  // that the rest of the application exists behind this domain.
  if (error) {
    return (
      <div className="portal-shell">
        <div className="portal-error">
          <h1>Procurement portal</h1>
          <p>{error.message}</p>
          {error.detail && <p className="portal-error-detail">{error.detail}</p>}
        </div>
      </div>
    );
  }

  const { totals } = model;
  const client = data?.client || 'Your account';

  return (
    <div className="portal-shell">
      <header className="portal-header">
        <div>
          <div className="portal-eyebrow">Procurement portal</div>
          <h1 className="portal-title">{client}</h1>
          <p className="portal-subtitle">
            Purchase orders raised on your behalf, the bills against them, and the invoice files.
            {data?.fetchedAt && <> Updated {new Date(data.fetchedAt).toLocaleString()}.</>}
          </p>
        </div>
        <div className="portal-identity">
          <label htmlFor="portal-author">Your name (shown on comments)</label>
          <input
            id="portal-author"
            className="search-box"
            placeholder={data?.linkLabel || 'e.g. Dana, AP'}
            value={authorName}
            onChange={(e) => setAuthorName(e.target.value)}
          />
        </div>
      </header>

      {data?.demo && (
        <div className="proc-banner proc-banner--warn">
          This is a preview of the client portal against demo data. Nothing here is real, and
          comments cannot be saved.
        </div>
      )}
      {data?.warnings?.map((w) => <div className="proc-banner proc-banner--warn" key={w}>{w}</div>)}
      {totals.mixedCurrency && (
        <div className="proc-banner proc-banner--warn">
          These bills span {totals.currencies.join(', ')}. Totals are not converted between
          currencies — read them per currency.
        </div>
      )}

      <div className="proc-stats">
        <Stat
          label="Committed on POs"
          value={formatMoney(totals.poCommittedCents, totals.currency)}
          hint={`${totals.poCount} purchase order${totals.poCount === 1 ? '' : 's'}`}
        />
        <Stat
          label="Billed"
          value={formatMoney(totals.approvedCents, totals.currency)}
          hint={`${totals.approvedCount} bill${totals.approvedCount === 1 ? '' : 's'}`}
          tone="brand"
        />
        <Stat label="Outstanding" value={formatMoney(totals.outstandingCents, totals.currency)} hint="not yet paid" tone="warn" />
        <Stat label="Paid" value={formatMoney(totals.paidCents, totals.currency)} hint="settled" tone="ok" />
        {totals.rejectedCents > 0 && (
          <Stat
            label="Rejected"
            value={formatMoney(totals.rejectedCents, totals.currency)}
            hint={`${totals.rejectedCount} excluded`}
            tone="danger"
          />
        )}
      </div>

      {model.purchaseOrders.length === 0 && model.unlinkedBills.length === 0 ? (
        <p className="proc-empty">There is nothing on your account yet.</p>
      ) : (
        <>
          {model.purchaseOrders.map((po) => (
            <PortalPoGroup
              key={po.id}
              po={po}
              token={token}
              authorName={authorName}
              commentsByTarget={commentsByTarget}
              onPost={handlePost}
            />
          ))}

          {model.unlinkedBills.length > 0 && (
            <section className="proc-po proc-po--unlinked">
              <header className="proc-po-header">
                <span className="proc-po-number">No purchase order</span>
                <div className="proc-po-meta">
                  <span>{model.unlinkedBills.length} bill{model.unlinkedBills.length === 1 ? '' : 's'} raised without a PO</span>
                </div>
              </header>
              <table className="proc-table">
                <thead>
                  <tr>
                    <th>Bill</th><th>Vendor</th><th>Invoiced</th><th>Due</th>
                    <th>Payment</th><th>Status</th><th className="num">Amount</th><th />
                  </tr>
                </thead>
                <tbody>
                  {model.unlinkedBills.map((bill) => (
                    <PortalBillRow
                      key={bill.id}
                      bill={bill}
                      token={token}
                      authorName={authorName}
                      comments={commentsByTarget.get(commentKey('bill', bill.id)) || []}
                      onPost={handlePost}
                    />
                  ))}
                </tbody>
              </table>
            </section>
          )}
        </>
      )}

      <footer className="proc-grand-total">
        <span>{client} &middot; {totals.billCount} bill{totals.billCount === 1 ? '' : 's'}</span>
        <TotalsStrip totals={totals} currency={totals.currency} bold />
      </footer>

      <p className="portal-foot">
        Questions about anything here? Leave a comment on the bill or purchase order — your
        contact is notified with the rest of the thread.
      </p>
    </div>
  );
}
