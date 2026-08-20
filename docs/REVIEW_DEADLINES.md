# Review deadlines and the lock

A review deadline gives a client a window to look at a bill and dispute it.
When the window closes, the record **locks** and the review outcome is final.
Only an admin can move a deadline once it is set, or reopen a locked record.

---

## What the lock freezes

| Frozen when locked | Still allowed |
| --- | --- |
| Client comments | Internal-only staff notes |
| Client-visible staff replies | Reading everything, including attachments |
| Approval changes — reject, confirm, restore | An admin reopening the record |

Internal notes stay open deliberately: the client never sees them, so freezing
them would protect nobody and would only cost your team its own record. When a
review is closed, the staff comment box pins the *Internal only* toggle on and
says why, so a reply cannot be posted to a client who can no longer read it.

The client still **sees** the state of their bills after the lock, including a
rejection and its reason. It is their money; what closes is their ability to
change the outcome, not their visibility of it.

---

## Where a deadline lives

A deadline can hang off a **bill** or a whole **purchase order**. A bill with no
deadline of its own inherits its PO's, so an entire run can be put on one review
clock without touching each bill. A bill-level deadline always wins over the
PO's — including when the PO's has already passed, which is how you give one
bill more time without reopening the whole order.

Inherited deadlines are marked with `↳` in the dashboard.

## States

| State | Meaning |
| --- | --- |
| *(none)* | No deadline. Nothing locks. |
| **Review by …** | Set, more than three days out. |
| **Review by …** (amber) | Inside the last three days. |
| **🔒 Review closed …** | Past due. Frozen. |
| **Reopened until …** | Past due, but an admin lifted the lock for a period. The original due date is kept and still shown. |

The deadline instant itself counts as closed — "review by the 3rd" means the
3rd is out, not still open. A deadline set through the dashboard closes at the
end of the chosen day, local time.

---

## Who can do what

| Action | Who |
| --- | --- |
| Set a deadline on a record that has none | Staff |
| Move a deadline that already exists | **Admin** |
| Reopen a locked record | **Admin** (a reason is required) |
| Clear a deadline entirely | **Admin** |

Admin actions are marked 🔑 in the dashboard. The admin key is asked for at the
point of use and kept in `sessionStorage` for that browser tab only — never in
localStorage, never synced to Supabase, never in anything the portal receives. A
rejected key is discarded so the next attempt asks again.

Every mutation appends a row to `review_deadline_events` naming the actor, their
role, the previous and new dates, and the reason. Nothing updates or deletes an
audit row. That trail is the point of the restriction: a lock that was lifted
should always be explicable afterwards.

### Configuration

| Variable | Behaviour when unset |
| --- | --- |
| `PROCUREMENT_STAFF_KEY` | Staff routes are **open**, matching the existing convention in `api/inventory.js`. Set it before sharing any portal link. |
| `PROCUREMENT_ADMIN_KEY` | The admin tier **fails closed** — nobody is an admin, so a deadline can be set once and then never moved. The dashboard says so rather than leaving the buttons to fail silently. |

The two keys must have **different values**. If they match, every staff member
would be an admin and the lock would restrict nobody, so the admin tier refuses
outright and the dashboard shows an error banner.

> These are shared keys, not per-user identity. "An admin" really means
> "someone holding the admin key". Real attribution and per-person revocation
> need an auth layer — the same caveat as the portal links themselves.

---

## Enforcement

The lock is enforced **on the server**, in every write path:

| Route | Refuses with |
| --- | --- |
| `POST /api/portal` (client comment) | `423` |
| `POST /api/comments` (shared staff reply) | `423` — internal notes pass |
| `POST`/`DELETE /api/decisions` (reject / confirm / restore) | `423` |

A disabled button is a courtesy, not a control. The rules themselves live in
`src/data/reviewLock.js` and are **imported** by the API routes rather than
restated, so the server and the UI cannot drift apart on what "locked" means.

For a bill, the server asks Ramp which purchase order it belongs to rather than
trusting the caller, so a PO-level lock cannot be dodged by omitting the link.
If Ramp is unreachable, the response carries a `caveat` saying a PO-level
deadline could not be confirmed — it does not quietly claim a clean check.

### Approval decisions moved

Decisions previously lived in a JSONB blob under `app_data`, which anyone
holding the public anon key can write. A lock the browser can write around is
not a lock, so they now live in a `bill_decisions` table reachable only through
the service key, behind `/api/decisions`. Existing decisions are carried over
automatically on first read; nothing is lost on upgrade.

**Fallback:** without `SUPABASE_SERVICE_KEY`, `/api/decisions` reports itself
unavailable and the dashboard falls back to the old local store — with a banner
saying plainly that deadlines are shown but **not enforced**. Configure the
service key before relying on a lock.

---

## Files

| File | Role |
| --- | --- |
| `src/data/reviewLock.js` | The rules: resolution, states, permissions, formatting |
| `src/data/reviewLock.test.mjs` | `node src/data/reviewLock.test.mjs` — boundaries, inheritance, reopen |
| `api/_reviewLock.js` | Server-side resolution: which deadline applies to this record |
| `api/deadlines.js` | Set (staff) / edit, reopen, clear (admin), plus the audit trail |
| `api/decisions.js` | Approval writes, gated by the lock |
| `api/_staffAuth.js` | The staff/admin split, constant-time and fail-closed |
| `src/data/adminSession.js` | Holds the admin key for one browser tab |
| `src/components/procurement/DeadlineBadge.jsx` | Shared read-only badge |
| `src/components/procurement/DeadlineControl.jsx` | Staff set/edit/reopen/clear |
| `supabase/migrations/004_create_review_deadlines.sql` | Tables, RLS, audit |
