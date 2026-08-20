import { formatMoney, REJECTED } from '../../data/procurement';
import { daysUntil } from './format';

// Presentational pieces shared by the staff dashboard and the client portal.
//
// Everything here is action-free on purpose: it renders a record, it never
// decides what may be done to one. Each surface builds its own attachment URLs
// by passing `urlFor`, so the portal routes through /api/portal (token-checked)
// while the dashboard routes through /api/ramp.

export function Stat({ label, value, hint, tone }) {
  return (
    <div className={`proc-stat${tone ? ` proc-stat--${tone}` : ''}`}>
      <div className="proc-stat-label">{label}</div>
      <div className="proc-stat-value">{value}</div>
      {hint && <div className="proc-stat-hint">{hint}</div>}
    </div>
  );
}

export function ApprovalBadge({ approval }) {
  if (approval.state === REJECTED) {
    return <span className="proc-badge proc-badge--rejected" title={approval.reason || 'Rejected'}>Rejected</span>;
  }
  return approval.auto
    ? <span className="proc-badge proc-badge--auto" title="Approved automatically — no rejection recorded">Approved &middot; auto</span>
    : <span className="proc-badge proc-badge--approved" title={`Approved by ${approval.by || 'a reviewer'}`}>Approved</span>;
}

export function PaymentBadge({ bill }) {
  if (bill.isPaid) return <span className="proc-badge proc-badge--paid">Paid</span>;
  const due = daysUntil(bill.dueAt);
  if (due !== null && due < 0) {
    return <span className="proc-badge proc-badge--overdue">{Math.abs(due)}d overdue</span>;
  }
  return <span className="proc-badge proc-badge--open">{bill.paymentStatus || 'Open'}</span>;
}

/**
 * @param {object} props
 * @param {(doc: object, opts: {inline: boolean}) => string|null} props.urlFor
 *   Returns null when the file cannot be served (demo data), in which case
 *   `unavailableNote` is shown instead of dead links.
 */
export function AttachmentList({ documents, urlFor, unavailableNote = 'no file' }) {
  if (!documents?.length) return <div className="proc-empty-inline">No files attached.</div>;
  return (
    <ul className="proc-attachments">
      {documents.map((doc) => {
        const view = urlFor(doc, { inline: true });
        const download = urlFor(doc, { inline: false });
        return (
          <li key={doc.id}>
            <span className="proc-attachment-icon" aria-hidden="true">
              {doc.contentType?.startsWith('image/') ? '\u{1F5BC}' : '\u{1F4C4}'}
            </span>
            <span className="proc-attachment-name" title={doc.name}>{doc.name}</span>
            {doc.type === 'INVOICE' && <span className="proc-badge proc-badge--muted">Invoice</span>}
            {view && download ? (
              <>
                <a className="proc-link" href={view} target="_blank" rel="noopener noreferrer">View</a>
                <a className="proc-link" href={download} download={doc.name}>Download</a>
              </>
            ) : (
              <span className="proc-attachment-demo" title="There is no file behind this record.">{unavailableNote}</span>
            )}
          </li>
        );
      })}
    </ul>
  );
}

export function LineItems({ items, currency }) {
  if (!items?.length) return null;
  const subtotal = items.reduce((sum, li) => sum + li.amountCents, 0);
  return (
    <table className="proc-lines">
      <thead>
        <tr>
          <th>Description</th><th className="num">Qty</th><th className="num">Unit</th><th className="num">Amount</th>
        </tr>
      </thead>
      <tbody>
        {items.map((li) => (
          <tr key={li.id}>
            <td>
              {li.description}
              {li.category && <span className="proc-line-category">{li.category}</span>}
            </td>
            <td className="num">{li.quantity === null ? '—' : li.quantity.toLocaleString()}</td>
            <td className="num">{li.unitPriceCents === null ? '—' : formatMoney(li.unitPriceCents, currency)}</td>
            <td className="num">{formatMoney(li.amountCents, currency)}</td>
          </tr>
        ))}
      </tbody>
      <tfoot>
        <tr>
          <td colSpan={3}>Line subtotal</td>
          <td className="num">{formatMoney(subtotal, currency)}</td>
        </tr>
      </tfoot>
    </table>
  );
}

/** The paid / outstanding / rejected / total strip used under a PO and at page foot. */
export function TotalsStrip({ totals, currency, bold = false }) {
  return (
    <span className={bold ? 'proc-grand-figures' : 'proc-po-footer-figures'}>
      <span>Paid {formatMoney(totals.paidCents, currency)}</span>
      <span>Outstanding {formatMoney(totals.outstandingCents, currency)}</span>
      {totals.rejectedCents > 0 && (
        <span className="proc-muted">Rejected {formatMoney(totals.rejectedCents, currency)}</span>
      )}
      <strong>{bold ? 'Total approved ' : 'Subtotal '}{formatMoney(totals.approvedCents, currency)}</strong>
    </span>
  );
}
