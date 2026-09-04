// Budget vs actuals for one run: link Xero bills to the run's material lines. A linked
// bill REPLACES the covered portion of the line's estimate and retimes it to the bill's
// pay date (v1 no-double-count invariant, carried into v2).
import React from "react";
import { parseLocalDate, fmtMD, isoLocal } from "../model/sprints.js";
import { defaultInclude } from "../model/xero.js";
import { fmt, Cross } from "./ui.jsx";

const fmtDate = (iso) => { const d = parseLocalDate(iso); return d ? fmtMD(d) : "—"; };

/**
 * props: run, ap, billedByLine {lineId: Σ included linked}, linkBill(billId, runId, lineId), unlinkBill(billId),
 *        payDateOf(bill) → ISO, setPayDate(billId, isoOrNull), orderDateOf(line) → Date, today (ISO)
 */
export function BillLinks({ run, ap, billedByLine, linkBill, unlinkBill, payDateOf, setPayDate, orderDateOf, today }) {
  const lines = (run.materials || []).filter((l) => (l.amount || 0) > 0 || ap.some((b) => b.lineId === l.id));
  const unlinked = ap.filter((b) => !b.lineId);
  if (!lines.length) return <div style={{ fontSize: 11.5, color: "var(--muted)", padding: "6px 0" }}>Enter material costs above, then link the real Xero bills here as they arrive.</div>;
  return (
    <div style={{ display: "grid", gap: 8 }}>
      {lines.map((l) => {
        const budget = l.amount || 0, billed = billedByLine[l.id] || 0;
        const remaining = Math.max(0, budget - billed), variance = billed - budget;
        const linked = ap.filter((b) => b.lineId === l.id);
        const orderISO = isoLocal(orderDateOf(l));
        return (
          <div key={l.id} style={{ border: "1px solid var(--line)", borderRadius: 9, padding: "9px 12px", background: "#FBFAF6" }}>
            <div style={{ display: "flex", alignItems: "center", gap: 12, flexWrap: "wrap", fontSize: 12 }}>
              <span style={{ fontWeight: 600, fontSize: 12.5 }}>{l.label}</span>
              <span className="num" style={{ color: "var(--muted)" }}>budget {fmt(budget)} · orders {fmtDate(orderISO)}</span>
              <span className="num" style={{ color: "var(--ap)" }}>billed {fmt(billed)}</span>
              <span className="num" style={{ color: "var(--muted)" }}>remaining {fmt(remaining)}</span>
              {billed !== 0 && (<span className="tag" style={{ color: variance > 0 ? "#8a3a2e" : "#1f5e54", background: variance > 0 ? "#f4ddd6" : "#dcefe9" }}>{variance > 0 ? "+" + fmt(variance) + " over" : fmt(-variance) + " under"}</span>)}
            </div>
            {linked.length > 0 && (
              <div style={{ marginTop: 8, display: "grid", gap: 6 }}>
                {linked.map((b) => {
                  const on = b.include ?? defaultInclude(b.status);
                  const eff = payDateOf(b);
                  const overridden = !!b.payDate;
                  const late = parseLocalDate(eff) > parseLocalDate(b.dueDate);
                  return (
                    <div key={b.id} style={{ display: "flex", alignItems: "center", gap: 10, flexWrap: "wrap", fontSize: 12, padding: "5px 8px", border: "1px solid var(--line2)", borderRadius: 7, background: "#fff", opacity: on ? 1 : 0.5 }}>
                      <span style={{ fontWeight: 600 }}>{b.vendor}</span>
                      <span className="num" style={{ color: "var(--muted)" }}>{fmt(b.amount)}</span>
                      <span style={{ color: "var(--muted)", fontSize: 11 }}>due {fmtDate(b.dueDate)}</span>
                      <div style={{ flex: 1 }} />
                      <label style={{ display: "flex", alignItems: "center", gap: 6, fontSize: 11, color: "var(--muted)" }}>pay
                        <input className="inp num sm" style={{ width: 138 }} type="date" min={today} value={eff} onChange={(ev) => setPayDate(b.id, ev.target.value || null)} />
                      </label>
                      {overridden
                        ? <button className="btn-x" style={{ fontSize: 11 }} title={"reset to the order date (" + fmtDate(orderISO) + ")"} onClick={() => setPayDate(b.id, null)}>↺ order date</button>
                        : <span className="tag" style={{ color: "#5a5f66", background: "var(--chip)" }}>order date</span>}
                      {late && <span className="late" title="paying after due date">late</span>}
                      <button className="btn-x" title="Unlink" onClick={() => unlinkBill(b.id)}><Cross size={10} /></button>
                    </div>
                  );
                })}
              </div>
            )}
            <div style={{ marginTop: 8, display: "flex", alignItems: "center", gap: 8 }}>
              <select className="sel" style={{ fontSize: 12 }} value="" onChange={(ev) => { if (ev.target.value) linkBill(ev.target.value, run.id, l.id); }}>
                <option value="">+ Link a bill…</option>
                {unlinked.map((b) => <option key={b.id} value={b.id}>{b.vendor} · {fmt(b.amount)} · due {fmtDate(b.dueDate)}</option>)}
              </select>
              {unlinked.length === 0 && <span style={{ fontSize: 11, color: "var(--muted)" }}>all bills linked</span>}
            </div>
          </div>
        );
      })}
    </div>
  );
}
