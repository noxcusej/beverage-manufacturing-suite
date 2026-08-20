import { useState } from 'react';
import { LOCK_NONE } from '../../data/reviewLock';
import { saveDeadline, reopenDeadline, clearDeadline } from '../../data/deadlinesClient';
import DeadlineBadge from './DeadlineBadge';

// Staff control for a record's review deadline. Never rendered on the client
// portal.
//
// Setting a first deadline is ordinary staff work. Moving one, reopening a
// locked record and clearing a deadline are admin actions — the button is
// marked, the admin key is asked for at the point of use, and the server is
// what actually enforces it. If the admin key is not configured on the
// deployment, those actions are refused with an explanation rather than
// silently doing nothing.

function isoFromDateInput(value) {
  // A date input gives a bare day. Close review at the end of that day, local
  // time, which is what "review by the 3rd" means to a person.
  if (!value) return '';
  const d = new Date(`${value}T23:59:59`);
  return Number.isNaN(d.getTime()) ? '' : d.toISOString();
}

function defaultDateInput(daysAhead) {
  const d = new Date(Date.now() + daysAhead * 86400000);
  return d.toISOString().slice(0, 10);
}

export default function DeadlineControl({
  targetType,
  targetId,
  clientName,
  deadline,
  lock,
  actor,
  adminKeyConfigured = true,
  onChanged,
  compact = false,
}) {
  const [open, setOpen] = useState(false);
  const [mode, setMode] = useState('set'); // set | edit | reopen
  const [date, setDate] = useState(defaultDateInput(14));
  const [note, setNote] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(null);

  const hasDeadline = Boolean(deadline);
  const locked = Boolean(lock?.locked);

  function start(nextMode) {
    setMode(nextMode);
    setError(null);
    setNote('');
    setDate(defaultDateInput(nextMode === 'reopen' ? 7 : 14));
    setOpen(true);
  }

  async function submit(e) {
    e.preventDefault();
    if (busy) return;
    const iso = isoFromDateInput(date);
    if (!iso) { setError('Pick a date.'); return; }

    setBusy(true);
    setError(null);
    try {
      let result;
      if (mode === 'reopen') {
        if (!note.trim()) {
          setError('Give a reason for reopening — it is recorded against the deadline.');
          setBusy(false);
          return;
        }
        result = await reopenDeadline({
          targetType, targetId, reopenedUntil: iso, reason: note.trim(), actor,
        });
      } else {
        result = await saveDeadline({
          targetType, targetId, clientName, dueAt: iso, note: note.trim() || null,
          actor, isEdit: mode === 'edit',
        });
      }
      // null means the user cancelled the admin-key prompt — not an error.
      if (result !== null) {
        setOpen(false);
        onChanged?.();
      }
    } catch (err) {
      setError(err.message);
    } finally {
      setBusy(false);
    }
  }

  async function remove() {
    if (!window.confirm('Remove this review deadline? The record will no longer lock.')) return;
    setBusy(true);
    setError(null);
    try {
      const result = await clearDeadline({ targetType, targetId, actor });
      if (result !== null) onChanged?.();
    } catch (err) {
      setError(err.message);
    } finally {
      setBusy(false);
    }
  }

  const adminNote = adminKeyConfigured
    ? undefined
    : 'No admin key is configured on this deployment, so deadlines cannot be changed once set.';

  return (
    <span className={`dl-control${compact ? ' dl-control--compact' : ''}`}>
      <DeadlineBadge lock={lock} emptyLabel={compact ? null : 'No review deadline'} />

      {!open && (
        <span className="dl-actions">
          {!hasDeadline && (
            <button className="btn btn-small" onClick={() => start('set')} disabled={busy}>
              Set deadline
            </button>
          )}
          {hasDeadline && locked && (
            <button
              className="btn btn-small btn-primary"
              onClick={() => start('reopen')}
              disabled={busy || !adminKeyConfigured}
              title={adminNote || 'Admin only — lifts the lock for a set period'}
            >
              Reopen &#x1F511;
            </button>
          )}
          {hasDeadline && (
            <button
              className="btn btn-small"
              onClick={() => start('edit')}
              disabled={busy || !adminKeyConfigured}
              title={adminNote || 'Admin only — moves the review deadline'}
            >
              Edit &#x1F511;
            </button>
          )}
          {hasDeadline && (
            <button
              className="btn btn-small"
              onClick={remove}
              disabled={busy || !adminKeyConfigured}
              title={adminNote || 'Admin only — removes the deadline entirely'}
            >
              Clear &#x1F511;
            </button>
          )}
        </span>
      )}

      {open && (
        <form className="dl-form" onSubmit={submit}>
          <label className="dl-form-label">
            {mode === 'reopen' ? 'Reopen until' : mode === 'edit' ? 'Move deadline to' : 'Review deadline'}
            <input type="date" value={date} onChange={(e) => setDate(e.target.value)} />
          </label>
          <input
            className="search-box dl-form-note"
            placeholder={mode === 'reopen' ? 'Reason (required, recorded)' : 'Note (optional)'}
            value={note}
            onChange={(e) => setNote(e.target.value)}
          />
          <button className="btn btn-small btn-primary" type="submit" disabled={busy}>
            {busy ? 'Saving…' : mode === 'reopen' ? 'Reopen' : 'Save'}
          </button>
          <button className="btn btn-small" type="button" onClick={() => setOpen(false)} disabled={busy}>
            Cancel
          </button>
        </form>
      )}

      {error && <span className="dl-error">{error}</span>}
    </span>
  );
}

export { LOCK_NONE };
