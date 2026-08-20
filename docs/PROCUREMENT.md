# Procurement Dashboard (Ramp)

A client-facing view of purchase orders, the bills raised against them, and the
invoice files attached to each — sourced from [Ramp](https://ramp.com).

Route: **`/procurement`** (all clients) and **`/procurement/<Client Name>`**
(scoped to one client).

---

## What it does

| Requirement | Where it lives |
| --- | --- |
| See POs and their associated bills | Bills are grouped under their PO by `purchase_order_id`, by PO number, or — failing both — by a `PO 1234` reference parsed out of the bill memo. Bills with no PO reference get their own "No purchase order" group so nothing is dropped. |
| See approved bills for a client name | The client comes from a Ramp accounting field (configurable — see *Client mapping*). A bill with no client of its own inherits the one on its PO. `/procurement/<name>` filters **server-side**, so the browser never receives another client's bills. |
| View and download attachments | Each bill and PO lists its files with **View** (opens inline) and **Download**. Links point at `/api/ramp?resource=document&…`, never at Ramp's own URLs — those are presigned and expire, so they are re-resolved at click time. |
| Approved unless rejected | A bill counts as approved the moment it lands. Only rejections are stored. See *Approval model*. |
| Totals and subtotals | Per-PO subtotals (paid / outstanding / rejected / approved and PO remaining), per-client subtotals, and a sticky grand total. |

---

## Setting up live Ramp data

Without credentials the dashboard runs on a bundled demo dataset and says so in
the header. To connect a real Ramp tenant, set these on the deployment
(Vercel → Project → Settings → Environment Variables):

| Variable | Required | Notes |
| --- | --- | --- |
| `RAMP_CLIENT_ID` | yes | OAuth client id from Ramp → Developer API |
| `RAMP_CLIENT_SECRET` | yes | OAuth client secret — server-side only, never exposed to the browser |
| `RAMP_ENV` | no | `demo` (default) or `production` |
| `RAMP_API_BASE` | no | Overrides the base URL entirely |
| `RAMP_SCOPES` | no | Defaults to `bills:read vendors:read entities:read accounting:read` |
| `RAMP_PROXY_API_KEY` | no | When set, callers of `/api/ramp` must send it as `x-api-key` |

The Ramp app needs **read** scopes only. `/api/ramp` rejects every method other
than `GET`; nothing in this feature can write to Ramp.

Local development: `npm run dev` serves the SPA but not `/api/*`, so the
dashboard falls back to demo data. Run `vercel dev` to exercise the proxy.

---

## Client mapping — verify this per tenant

Ramp has no built-in "client" concept; every tenant models it differently. The
dashboard resolves a client name in this order, first hit wins:

1. A manual override recorded in the app.
2. A **top-level accounting field** whose name matches one of the configured
   names (default: `client`, `client name`, `customer`, `brand` — matched
   case-insensitively as a substring).
3. The same field on the bill's **line items** (the most common value wins when
   a bill is split across clients).
4. A `[Client: Acme]` or `Client: Acme` tag in the memo.
5. The Ramp **entity** name, if *"Fall back to the Ramp entity name"* is on.

Change the field names and the entity fallback in the dashboard's **Settings**
panel; the choice is stored with the rest of the app's data. Anything that
resolves to nothing is shown under **Unassigned** rather than being hidden —
that bucket is the signal that the mapping needs adjusting.

## Purchase orders

Ramp has shipped purchase orders under more than one path, and not every tenant
is entitled to the endpoint. `api/ramp.js` tries `/purchase-orders`,
`/purchase_orders`, then `/bill-purchase-orders`, and remembers which answered.
If none does, it **derives** a PO group per distinct PO number referenced by the
bills and shows a banner saying so; those derived POs have no committed amount,
so committed and remaining render as `n/a` instead of as a false zero budget.

---

## Approval model

> Bills are approved automatically. A rejection is the only thing that changes
> that, and it is the only thing stored.

- **Approved · auto** — no decision recorded. This is the default state.
- **Approved** — a reviewer pressed *Confirm*. Identical for totals; shown
  separately so you can tell "nobody looked at it" from "somebody signed off".
- **Rejected** — a reviewer pressed *Reject* and gave a reason. Excluded from
  every approved total and from PO consumption, reported on its own line, and
  reversible with *Restore* — until the review deadline closes, after which the
  outcome is final until an admin reopens it. See
  [REVIEW_DEADLINES.md](REVIEW_DEADLINES.md).

Decisions live in this app's own `bill_decisions` table, keyed by Ramp bill id
— **they are not written back to Ramp**. They are written through
`/api/decisions` rather than straight from the browser, so that the review
deadline lock can actually be enforced on the write path. The
proxy is read-only by design; syncing rejections into Ramp would need write
scopes and a decision about which Ramp state a rejection maps to.

Set *"Record approvals as"* in Settings to stamp decisions with a reviewer name.

---

## Money and currency

Amounts are carried as integer **cents** end to end so subtotals never drift.
Ramp's `CurrencyAmount` (`{ amount, currency_code }`) is read as minor units —
`12345` is `$123.45`. If a tenant turns out to return major units, flip
`AMOUNT_OBJECTS_ARE_MINOR_UNITS` in `src/data/procurement.js`; that constant is
the only place the assumption lives.

Bills spanning multiple currencies are **not** converted. The dashboard adds the
raw figures and shows a banner naming the currencies involved, rather than
presenting one number that means nothing.

---

## Access control — do not share this page with a client

`/procurement` and `/procurement/<Client Name>` are the **staff** view. They sit
inside the suite's navigation, they expose every client in the picker, and
`/api/ramp` does not distinguish one caller from another. Do not hand either URL
to an outside client.

To give a client their own view, use the **Client Portal**: a unique link per
client, scoped by a share token the server resolves to exactly one client, with
no navigation into the rest of the suite. See
[CLIENT_PORTAL.md](CLIENT_PORTAL.md).

---

## Files

| File | Role |
| --- | --- |
| `api/ramp.js` | Read-only serverless proxy: OAuth token cache, pagination, PO path discovery, client scoping, attachment streaming |
| `src/data/ramp.js` | Browser client for the proxy, with demo fallback |
| `src/data/procurement.js` | Pure domain logic: normalization, client resolution, PO matching, approval, roll-ups |
| `src/data/procurement.test.mjs` | `node src/data/procurement.test.mjs` |
| `src/data/procurementDemo.js` | Demo dataset, shaped exactly like raw Ramp payloads |
| `src/pages/ProcurementDashboard.jsx` | The staff page |
| `docs/CLIENT_PORTAL.md` | The client-facing counterpart |
| `docs/REVIEW_DEADLINES.md` | Review windows, the lock, and the admin tier |
