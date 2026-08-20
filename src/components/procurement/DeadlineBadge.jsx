import { formatRemaining, LOCK_NONE, LOCK_OPEN, LOCK_DUE_SOON, LOCK_LOCKED, LOCK_REOPENED } from '../../data/reviewLock';
import { fmtDate } from './format';

// Read-only view of a review deadline. Shared by the staff dashboard and the
// client portal so both describe the same clock in the same words.

const TONE = {
  [LOCK_OPEN]: 'open',
  [LOCK_DUE_SOON]: 'soon',
  [LOCK_LOCKED]: 'locked',
  [LOCK_REOPENED]: 'reopened',
};

export default function DeadlineBadge({ lock, inherited = false, emptyLabel = null }) {
  if (!lock || lock.state === LOCK_NONE) {
    return emptyLabel ? <span className="dl-badge dl-badge--none">{emptyLabel}</span> : null;
  }

  const remaining = formatRemaining(lock);
  const due = fmtDate(new Date(lock.dueAt).toISOString());

  const label = lock.state === LOCK_LOCKED
    ? `Review closed ${due}`
    : lock.state === LOCK_REOPENED
      ? `Reopened until ${fmtDate(new Date(lock.reopenedUntil).toISOString())}`
      : `Review by ${due}`;

  const title = lock.state === LOCK_REOPENED
    ? `Review was due ${due}; an admin reopened it.`
    : inherited
      ? 'Inherited from this bill’s purchase order.'
      : undefined;

  return (
    <span className={`dl-badge dl-badge--${TONE[lock.state]}`} title={title}>
      {lock.state === LOCK_LOCKED && <span aria-hidden="true">&#x1F512; </span>}
      {label}
      <span className="dl-remaining">{remaining}</span>
      {inherited && <span className="dl-inherited" aria-hidden="true"> ↳</span>}
    </span>
  );
}
