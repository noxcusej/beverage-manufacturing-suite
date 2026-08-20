import { useState } from 'react';

// Comment thread on one bill or purchase order.
//
// Shared by the staff dashboard and the client portal. The two differ only in
// what they pass in: the portal never sets `allowInternal`, so it has no way to
// write — or even name — an internal-only note.

function fmtWhen(iso) {
  if (!iso) return '';
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '';
  return d.toLocaleString('en-US', { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' });
}

export default function CommentThread({
  comments = [],
  authorName,
  placeholder = 'Add a comment…',
  allowInternal = false,
  // Set when the review is locked: the client-visible conversation is closed,
  // but the team can still write to its own record. The toggle is pinned on and
  // explained rather than hidden, so it is obvious why.
  forceInternal = false,
  forceInternalReason = null,
  disabled = false,
  disabledReason = null,
  onPost,
  onDelete,
  emptyLabel = 'No comments yet.',
}) {
  const [draft, setDraft] = useState('');
  const [internal, setInternal] = useState(false);
  const postAsInternal = forceInternal || internal;
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(null);

  async function submit(e) {
    e.preventDefault();
    const body = draft.trim();
    if (!body || busy) return;
    setBusy(true);
    setError(null);
    try {
      await onPost({ body, visibility: postAsInternal ? 'internal' : 'shared' });
      setDraft('');
      setInternal(false);
    } catch (err) {
      setError(err.message);
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="cmt">
      {comments.length === 0 ? (
        <p className="cmt-empty">{emptyLabel}</p>
      ) : (
        <ul className="cmt-list">
          {/* Author and visibility are separate axes: a team-authored comment is
              usually shared, and must not be styled as if it were private. */}
          {comments.map((c) => (
            <li key={c.id} className={`cmt-item cmt-item--by-${c.authorType}${c.visibility === 'internal' ? ' cmt-item--private' : ''}`}>
              <div className="cmt-meta">
                <strong>{c.authorName || (c.authorType === 'client' ? 'Client' : 'Team')}</strong>
                <span className={`cmt-who cmt-who--${c.authorType}`}>
                  {c.authorType === 'client' ? 'Client' : 'Team'}
                </span>
                {c.visibility === 'internal' && (
                  <span className="cmt-who cmt-who--internal" title="Not visible on the client portal">Internal only</span>
                )}
                {c.local && (
                  <span className="cmt-who cmt-who--local" title="Stored on this device only — not shared with the client portal">Local</span>
                )}
                <span className="cmt-when">{fmtWhen(c.createdAt)}</span>
                {onDelete && (
                  <button className="cmt-delete" onClick={() => onDelete(c)} title="Delete this comment" aria-label="Delete comment">
                    &times;
                  </button>
                )}
              </div>
              <div className="cmt-body">{c.body}</div>
            </li>
          ))}
        </ul>
      )}

      {disabled ? (
        <p className="cmt-disabled">{disabledReason || 'Commenting is unavailable.'}</p>
      ) : (
        <form className="cmt-form" onSubmit={submit}>
          {forceInternal && (
            <p className="cmt-forced">{forceInternalReason || 'This review is closed — anything posted here is an internal note.'}</p>
          )}
          <textarea
            className="cmt-input"
            rows={2}
            value={draft}
            placeholder={forceInternal ? 'Internal note…' : placeholder}
            maxLength={4000}
            onChange={(e) => setDraft(e.target.value)}
          />
          <div className="cmt-form-row">
            {allowInternal && (
              <label
                className={`cmt-internal-toggle${forceInternal ? ' cmt-internal-toggle--forced' : ''}`}
                title={forceInternal
                  ? 'The review deadline has passed, so only internal notes can be added.'
                  : 'Internal notes are never shown on a client portal'}
              >
                <input
                  type="checkbox"
                  checked={postAsInternal}
                  disabled={forceInternal}
                  onChange={(e) => setInternal(e.target.checked)}
                />
                {' '}Internal only
              </label>
            )}
            <span className="cmt-author">{authorName ? `as ${authorName}` : ''}</span>
            <button className="btn btn-small btn-primary" type="submit" disabled={busy || !draft.trim()}>
              {busy ? 'Posting…' : 'Post'}
            </button>
          </div>
          {error && <p className="cmt-error">{error}</p>}
        </form>
      )}
    </div>
  );
}
