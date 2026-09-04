/* eslint-disable react-refresh/only-export-components -- shared helpers live beside the components that use them */
// Accounts payable tab — Xero-shaped bills with a local planning layer (include, pay
// date, link to a run's material line). Ported from v1; links now point at material
// lines (`lineId`) instead of run events.
import React, { useMemo, useState } from "react";
import { loadAppData } from "../../data/supabase";
import { XERO_SNAPSHOT_KEY, mapXeroBill, mergeXeroBills, defaultInclude } from "../model/xero.js";
import { parseLocalDate, fmtMD } from "../model/sprints.js";
import { NumberInput, Stat, StatusTag, fmt, Cross } from "./ui.jsx";

export const fmtDate = (iso) => { const d = parseLocalDate(iso); return d ? fmtMD(d) : "—"; };

/**
 * props: ap, setAp, runs, unlinkBill, payDateOf(bill) → ISO, today (ISO), apTotalWindow, newId, strip? (position strip node)
 */
export function APTab({ ap, setAp, runs, unlinkBill, payDateOf, today, apTotalWindow, newId, strip }) {
  const setB = (id, k, val) => setAp((xs) => xs.map((x) => (x.id === id ? { ...x, [k]: val } : x)));
  const del = (id) => setAp((xs) => xs.filter((x) => x.id !== id));
  const add = () => setAp((xs) => [...xs, { id: newId("b"), vendor: "New vendor", ref: "", billDate: today, dueDate: today, amount: 5000, status: "AUTHORISED", include: true }]);
  const linkMap = useMemo(() => { const m = {}; for (const r of runs) for (const l of r.materials || []) m[l.id] = { run: r.name, label: l.label, color: r.color }; return m; }, [runs]);

  const [importing, setImporting] = useState(false);
  const [importMsg, setImportMsg] = useState("");
  const importXero = async () => {
    setImporting(true); setImportMsg("");
    try {
      const snapshot = await loadAppData(XERO_SNAPSHOT_KEY);
      if (!Array.isArray(snapshot) || snapshot.length === 0) { setImportMsg("No Xero bills found yet — connect the Xero feed to sync ACCPAY bills."); return; }
      const facts = snapshot.map(mapXeroBill).filter((f) => f.xeroId);
      const { merged, added, updated } = mergeXeroBills(ap, facts, newId);
      setAp(merged);
      setImportMsg(`Imported from Xero — ${added} new, ${updated} updated.`);
    } catch (err) { setImportMsg("Xero import failed: " + (err?.message || "unknown error")); }
    finally { setImporting(false); }
  };

  const inc = (b) => b.include ?? defaultInclude(b.status);
  const todayD = parseLocalDate(today);
  const summary = useMemo(() => {
    let totalIncluded = 0, overdue = 0, b0 = 0, b1 = 0;
    for (const b of ap) {
      if (!inc(b)) continue;
      totalIncluded += b.amount;
      const due = parseLocalDate(b.dueDate);
      const days = due ? Math.round((due - todayD) / 86400000) : 0;
      if (days < 0) overdue += b.amount; else if (days <= 14) b0 += b.amount; else if (days <= 42) b1 += b.amount;
    }
    return { totalIncluded, overdue, b0, b1 };
  }, [ap, todayD]);
  const rows = [...ap].sort((a, b) => (parseLocalDate(a.dueDate) || 0) - (parseLocalDate(b.dueDate) || 0));

  return (
    <>
      <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit,minmax(150px,1fr))", gap: 10, marginTop: 18 }}>
        <Stat label="Total payable (incl.)" value={fmt(summary.totalIncluded)} tone="ap" />
        <Stat label="Overdue" value={fmt(summary.overdue)} tone={summary.overdue > 0 ? "danger" : "ink"} />
        <Stat label="Due ≤ 2 wks" value={fmt(summary.b0)} />
        <Stat label="Due 3–6 wks" value={fmt(summary.b1)} />
        <Stat label="Hits position (window)" value={fmt(apTotalWindow)} tone="ap" sub="paid within the chart horizon" />
      </div>

      {strip}

      <div style={{ marginTop: 14, border: "1px solid #d9e0d2", background: "#f3f6ee", color: "#4d5a3f", borderRadius: 9, padding: "9px 13px", fontSize: 12.5, lineHeight: 1.55 }}>
        <b>Connected to Xero (via Maton).</b> <b>Import from Xero</b> pulls bills where <span className="num">Type = ACCPAY</span> and <span className="num">Status ≠ PAID/VOIDED</span>. Re-importing refreshes the Xero facts but keeps your local edits (include toggle, pay date, run links). A bill linked to a run's material line <b>replaces</b> that line's estimate — never double-counted. Pay date defaults to the linked line's order date, else the due date (never before today).
      </div>

      <div className="card" style={{ marginTop: 14, padding: 16, overflowX: "auto" }}>
        <table style={{ width: "100%", borderCollapse: "collapse", minWidth: 1120 }}>
          <thead><tr>{["", "Vendor", "Ref", "Bill date", "Due date", "Status", "Amount", "Pay date", "Linked to", ""].map((h, i) => (<th key={i} className="th" style={{ textAlign: i === 6 ? "right" : "left", padding: "0 6px 8px", fontWeight: 600 }}>{h}</th>))}</tr></thead>
          <tbody>
            {rows.map((b) => {
              const included = inc(b);
              const payISO = payDateOf(b);
              const late = parseLocalDate(payISO) > parseLocalDate(b.dueDate);
              const overdue = parseLocalDate(b.dueDate) < todayD;
              const link = b.lineId && linkMap[b.lineId];
              return (
                <tr key={b.id} className="evrow" style={{ opacity: included ? 1 : 0.45 }}>
                  <td><input type="checkbox" checked={included} onChange={(e) => setB(b.id, "include", e.target.checked)} title="Include in cash position" /></td>
                  <td><input className="inp" style={{ minWidth: 150 }} value={b.vendor} onChange={(e) => setB(b.id, "vendor", e.target.value)} /></td>
                  <td className="num" style={{ fontSize: 12, color: "var(--muted)" }}>{b.ref}</td>
                  <td className="num" style={{ fontSize: 12, color: "var(--muted)" }}>{fmtDate(b.billDate)}</td>
                  <td className="num" style={{ fontSize: 12, color: overdue ? "var(--danger)" : "var(--ink)" }}>{fmtDate(b.dueDate)}{overdue && <span className="late">overdue</span>}</td>
                  <td><StatusTag status={b.status} /></td>
                  <td className="num" style={{ textAlign: "right" }}><NumberInput value={b.amount} onChange={(v) => setB(b.id, "amount", v)} className="inp num" style={{ width: 104, textAlign: "right" }} /></td>
                  <td><div style={{ display: "flex", alignItems: "center", gap: 6 }}><input className="inp num" style={{ width: 144 }} type="date" min={today} value={payISO} onChange={(e) => setB(b.id, "payDate", e.target.value || null)} />{late && <span className="late" title="paying after due date">late</span>}</div></td>
                  <td>{link ? (
                    <span style={{ display: "inline-flex", alignItems: "center", gap: 6, fontSize: 11.5 }}>
                      <span style={{ width: 8, height: 8, borderRadius: 2, background: link.color, flex: "0 0 auto" }} />
                      <span style={{ color: "var(--muted)" }}>{link.run} · {link.label}</span>
                      <button className="btn-x" style={{ padding: "0 4px" }} title="Unlink" onClick={() => unlinkBill(b.id)}><Cross size={10} /></button>
                    </span>
                  ) : <span style={{ fontSize: 11.5, color: "#b8b2a4" }}>—</span>}</td>
                  <td><button className="btn-x" onClick={() => del(b.id)}><Cross /></button></td>
                </tr>
              );
            })}
          </tbody>
        </table>
        <div style={{ display: "flex", gap: 8, marginTop: 12, alignItems: "center", flexWrap: "wrap" }}>
          <button className="btn" onClick={add}>+ Add bill</button>
          <button className="btn" onClick={importXero} disabled={importing} title="Pull ACCPAY bills from Xero (preserves your pay-date and link overrides)">{importing ? "Importing…" : "↓ Import from Xero"}</button>
          {importMsg && <span style={{ fontSize: 11.5, color: "var(--muted)" }}>{importMsg}</span>}
        </div>
      </div>

      <div style={{ fontSize: 11.5, color: "var(--muted)", marginTop: 16, lineHeight: 1.6 }}>
        The checkbox controls whether a bill hits the cash position (DRAFT, PAID and VOIDED are off by default). <b>Pay date</b> is the lever — move a bill into a sprint with headroom above the floor and the position recomputes. Link a bill to a run's material line from the run (expand it on the planner).
      </div>
    </>
  );
}
