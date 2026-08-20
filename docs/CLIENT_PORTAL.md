# Client Portal

A standalone, per-client view of procurement, opened by a unique share link.
It shows one client their purchase orders, bills and invoice files, and lets
them comment. It shows them nothing else.

Route: **`/portal/<token>`**. Endpoint: **`/api/portal`**.

---

## What a client can and cannot do

| | |
| --- | --- |
| **Can** | See their own POs and bills, with totals and per-PO subtotals. View and download the invoice files attached to each. Read the shared comment thread and post to it, until the review deadline closes. |
| **Cannot** | See another client's data. See internal-only comments. Approve or reject anything — that stays with your team. Comment after the review deadline has passed (see [REVIEW_DEADLINES.md](REVIEW_DEADLINES.md)). Reach any other part of the suite: the portal renders outside the app `Layout`, so there is no sidebar, no navigation, and no link out of it. |

The client sees the approval state of their bills (including *Rejected*, with the
reason) because that is their money — but the controls that change it exist only
in the staff dashboard.

---

## How the isolation works

1. The client's browser sends the share token to `/api/portal` — and nothing else.
2. The server hashes the token and looks it up in `portal_links`.
3. **The client name comes from that database row.** No request parameter can
   change it. There is no "which client?" input to tamper with.
4. Bills and POs are scoped server-side before the response is written, so the
   browser never receives another client's data even momentarily.
5. Attachment requests are re-checked: the server recomputes the client's own
   bill and PO ids and refuses a file that is not among them. Editing an
   attachment URL gets a 403, not somebody else's invoice.
6. Comments are read with `visibility = 'shared'` and `client_name = <this
   client>`. Internal notes are filtered in the query, not in the UI.

`src/data/portal.test.mjs` asserts these boundaries directly: no two clients'
scoped bill sets overlap, an untagged bill reaches nobody, a partial client name
matches nothing, and internal notes never appear in a client's visible set.

### Tokens

A token is 32 random bytes, URL-safe. **Only its SHA-256 hash is stored**, so a
leaked `portal_links` row cannot be turned back into a working link. The
consequence is that a link is displayed exactly once, when it is minted — there
is no endpoint that can show it again. If a client loses their link, mint a new
one and revoke the old.

Comparison is constant-time, so a failed lookup leaks nothing about which part
of a token was wrong. Revoked, expired and never-existed links all produce the
same shape of refusal.

### Database

`portal_links` and `procurement_comments` have RLS enabled with **no policy for
the anon role**. This is deliberate and differs from the older tables in this
project, which are readable by anyone holding the public anon key. The portal
bundle has no Supabase client in it at all; every read and write goes through
`/api/portal` using the **service** key.

### Which Supabase instance?

The same one the rest of the suite already uses — there is no second project.
`api/_portalStore.js` falls back to `VITE_SUPABASE_URL`, so the URL is shared
automatically; migrations 003 and 004 add tables alongside the existing
`app_data`, `formulas` and `inventory`.

What is **not** shared is the key. The suite's browser code uses the anon key,
and the portal tables have RLS on with no anon policy, so the anon key reads
nothing from them by design. The server needs the **service role** key from that
same project (Supabase → Project Settings → API → `service_role`), set as
`SUPABASE_SERVICE_KEY`. It stays server-side; never prefix it with `VITE_`,
which would bundle it into the browser build.

Run `supabase/migrations/003_create_portal_tables.sql` and
`004_create_review_deadlines.sql` before using the portal — `supabase db push`,
or paste them into the SQL editor.

Then confirm the whole setup:

```bash
npm run check:supabase              # tables exist, anon cannot read them
npm run check:supabase -- --probe-write   # also proves anon cannot insert
```

That script never prints a key value. It fails loudly if the anon key can reach
`portal_links` or `procurement_comments`, which is the boundary the client
portal depends on.

---

## Setup

In addition to the Ramp variables in [PROCUREMENT.md](PROCUREMENT.md):

| Variable | Required | Notes |
| --- | --- | --- |
| `SUPABASE_URL` | yes | Falls back to `VITE_SUPABASE_URL` |
| `SUPABASE_SERVICE_KEY` | yes | Service role key. The anon key **cannot** read the portal tables, by design. |
| `PROCUREMENT_STAFF_KEY` | strongly recommended | Guards the staff routes (`/api/portal-links`, `/api/comments`, `/api/decisions`, `/api/deadlines`). Without it those routes are open — see the warning below. |
| `PROCUREMENT_ADMIN_KEY` | recommended | The admin tier: editing or reopening a review deadline. Must differ from the staff key. See [REVIEW_DEADLINES.md](REVIEW_DEADLINES.md). |
| `RAMP_CLIENT_FIELDS` | no | Comma-separated accounting field names that carry the client, for the portal only. Defaults to `client, client name, customer, brand`. The staff dashboard sets this per-session in its Settings panel; the portal reads it from the environment so a client cannot influence how their own scope is computed. |

> **Set `PROCUREMENT_STAFF_KEY` before you share the first link.** Following the
> convention already used by `/api/inventory`, these routes are open when no key
> is configured. An open `/api/portal-links` lets anyone who can reach the
> deployment mint a link to any client's data. The dashboard shows a warning
> banner while the key is unset.

---

## Minting a link

Procurement dashboard → **Client links**:

1. Pick the client. The name must match what the client resolves to in the
   dashboard — the picker is prefilled from the clients already found in Ramp.
2. Optionally add a label (who it is for) and an expiry date.
3. **Create link**, then copy the URL. It is shown once.

The table below lists every link with its client, label, token prefix, creation
date, last-opened time and status, and offers **Revoke**. Revocation takes
effect on the client's next request.

Give each recipient their own link rather than sharing one: last-opened times
are then meaningful, and one person's link can be revoked without cutting off
the rest.

---

## Comments

Comments attach to a bill or a purchase order, and carry a visibility:

- **Shared** — visible to both your team and the client. Anything a client
  writes is always shared; there is no such thing as a client note the client
  cannot see. Shared comments close when the review deadline passes.
- **Internal only** — visible to your team, never sent to a portal. Staff choose
  this with the *Internal only* checkbox when posting.

In the staff dashboard, a comment count appears on each bill row, threads open
inside the bill detail, and POs have their own thread. Staff can delete any
comment; clients cannot.

**Fallback:** if `SUPABASE_SERVICE_KEY` is not configured, `/api/comments`
reports itself unavailable and the dashboard stores comments in the app's own
data instead, labelling them **Local** and showing a banner. Local comments work
internally but are *not* visible on any client portal. Configure the service key
to make commenting shared.

---

## Operational notes

- **Every portal page load pulls the full bill list from Ramp** and then scopes
  it, because scoping has to happen server-side and Ramp has no per-client
  filter. That is correct but not cheap; if portals get heavy traffic, a short
  server-side cache of the Ramp response is the place to start.
- **The token appears in attachment URLs.** Anchor tags cannot send headers, so
  `View` and `Download` carry the token as a query parameter. That is no more
  exposed than the portal URL the client is already on, but it does mean tokens
  can end up in a client's browser history and in any proxy logs on their side.
- **A share link is a bearer credential.** Anyone who has it is that client.
  Treat forwarding it the way you would treat forwarding a password, use
  expiries for temporary access, and revoke when someone leaves.
- **This is not a login.** There is no per-user identity behind a portal link,
  so a comment's author is whatever name the visitor types. If you need real
  attribution or per-user revocation, that needs an auth layer.

---

## Files

| File | Role |
| --- | --- |
| `api/portal.js` | The client-facing endpoint. Token auth, server-side scoping, attachment ownership checks. |
| `api/portal-links.js` | Staff: mint, list, revoke links |
| `api/comments.js` | Staff: read/write comments, internal notes included |
| `api/_portalStore.js` | Service-key Supabase access: tokens, links, comments |
| `api/_ramp.js` | Shared read-only Ramp layer, used by both endpoints |
| `api/_staffAuth.js` | Shared staff key check |
| `src/pages/ClientPortal.jsx` | The portal page — rendered outside the suite `Layout` |
| `src/data/portalClient.js` | Portal browser client. No Supabase import, by design. |
| `src/components/CommentThread.jsx` | Comment UI, shared by both surfaces |
| `src/components/procurement/Primitives.jsx` | Action-free presentational pieces shared by both surfaces |
| `src/data/commentModel.js` | Pure comment helpers |
| `src/data/portal.test.mjs` | `node src/data/portal.test.mjs` — isolation and token tests |
| `supabase/migrations/003_create_portal_tables.sql` | Tables and RLS |
