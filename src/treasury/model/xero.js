// Xero AP bills — mapping + merge (ported from v1). Xero owns the bill facts; the
// cockpit keeps a local planning layer on top (include, payDate, runId, lineId).
// Bills are matched across syncs by their Xero InvoiceID so re-importing refreshes
// the facts without clobbering the user's planning edits. The cockpit reads a mapped
// snapshot from the Supabase `xero_bills` key (populated by the Xero connector / a sync).

export const XERO_SNAPSHOT_KEY = "xero_bills";

/** DRAFT / PAID / VOIDED bills are excluded from cash by default. */
export const defaultInclude = (s) => s === "AUTHORISED" || s === "SUBMITTED";

export function xeroDate(d) {
  if (!d) return "";
  const m = /\/Date\((\d+)/.exec(String(d)); // Xero sometimes returns /Date(ms+0000)/
  const dt = m ? new Date(Number(m[1])) : new Date(d);
  return isNaN(dt.getTime()) ? "" : dt.toISOString().slice(0, 10);
}

/** One Xero ACCPAY invoice → bill facts (AmountDue, not Total, so partial payments show). No local id. */
export function mapXeroBill(inv) {
  return {
    xeroId: inv.InvoiceID || inv.invoiceID || inv.id,
    vendor: inv.Contact?.Name || inv.contact?.name || "(unknown vendor)",
    ref: inv.Reference || inv.InvoiceNumber || inv.reference || "",
    billDate: xeroDate(inv.Date || inv.date),
    dueDate: xeroDate(inv.DueDate || inv.dueDate) || xeroDate(inv.Date || inv.date),
    amount: Number(inv.AmountDue ?? inv.amountDue ?? inv.Total ?? 0),
    status: inv.Status || inv.status || "AUTHORISED",
  };
}

/** Merge mapped facts into the current AP list: refresh facts on bills already known by xeroId
 *  (keeping include / payDate / runId / lineId), append the rest. `newId` mints ids for new bills. */
export function mergeXeroBills(current, facts, newId) {
  const byXero = new Map(facts.map((f) => [f.xeroId, f]));
  const seen = new Set();
  const merged = current.map((b) => {
    if (b.xeroId && byXero.has(b.xeroId)) {
      seen.add(b.xeroId);
      const f = byXero.get(b.xeroId);
      return { ...b, vendor: f.vendor, ref: f.ref, billDate: f.billDate, dueDate: f.dueDate, amount: f.amount, status: f.status };
    }
    return b;
  });
  let added = 0;
  for (const f of facts) if (f.xeroId && !seen.has(f.xeroId)) { merged.push({ id: newId("b"), include: defaultInclude(f.status), ...f }); added++; }
  return { merged, added, updated: seen.size };
}
