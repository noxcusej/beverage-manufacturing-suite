// Baseline burn — the overhead heartbeat, entered once as flat monthly amounts in
// standard P&L categories (debt service included). Replaces the v1 Fixed-costs tab.
import React, { useMemo } from "react";
import { BURN_CATEGORIES, burnBySprint, monthlyTotal } from "../model/burn.js";
import { parseLocalDate, fmtMD } from "../model/sprints.js";
import { NumberInput, fmt, fmtK, Cross } from "./ui.jsx";

const fmtDate = (iso) => { const d = parseLocalDate(iso); return d ? fmtMD(d) : ""; };

/** props: burn, setBurn, epoch, origin, horizon, today (ISO), newId, cols (sprint columns from the engine) */
export function BurnTab({ burn, setBurn, epoch, origin, horizon, today, newId, cols }) {
  const setL = (id, k, val) => setBurn((xs) => xs.map((x) => (x.id === id ? { ...x, [k]: val } : x)));
  const del = (id) => setBurn((xs) => xs.filter((x) => x.id !== id));
  const addLine = (category) => setBurn((xs) => [...xs, { id: newId("burn"), category, label: "", monthly: 0, dayOfMonth: 1, cadence: "monthly" }]);

  const byCat = useMemo(() => { const m = {}; for (const c of BURN_CATEGORIES) m[c] = []; for (const l of burn) (m[l.category] || (m[l.category] = [])).push(l); return m; }, [burn]);
  const total = useMemo(() => monthlyTotal(burn, today), [burn, today]);
  const heartbeat = useMemo(() => burnBySprint(burn, epoch, origin, horizon), [burn, epoch, origin, horizon]);
  const maxBar = Math.max(1, ...heartbeat.arr);
  const perSprint = total * 12 / 26;
  const changes = useMemo(() => burn.filter((l) => l.from || l.to).map((l) => ({ l, txt: [l.from ? "from " + fmtDate(l.from) : "", l.to ? "until " + fmtDate(l.to) : ""].filter(Boolean).join(" · ") })), [burn]);

  return (
    <>
      <div style={{ display: "flex", gap: 14, alignItems: "flex-start", marginTop: 18, flexWrap: "wrap" }}>
        <div className="card" style={{ flex: "1 1 720px", padding: 16 }}>
          <div style={{ display: "flex", alignItems: "baseline", gap: 12, marginBottom: 10, flexWrap: "wrap" }}>
            <span className="eyebrow">Monthly overhead · standard P&L</span>
            <span style={{ fontSize: 11.5, color: "var(--muted)" }}>enter a monthly number per line · add a from / to date only for a known step-change · debt payments live here</span>
          </div>
          <table style={{ width: "100%", borderCollapse: "collapse" }}>
            <thead><tr>
              {["Category", "Detail", "Monthly", "Day", "Cadence", "From", "To", ""].map((h, i) => (<th key={i} className="th" style={{ textAlign: i === 2 ? "right" : "left", padding: "0 6px 8px", fontWeight: 600 }}>{h}</th>))}
            </tr></thead>
            <tbody>
              {BURN_CATEGORIES.map((cat) => {
                const lines = byCat[cat] || [];
                const rows = lines.length ? lines : [null];
                return rows.map((l, i) => (
                  <tr key={l ? l.id : cat + "-empty"} className="evrow">
                    <td style={{ fontWeight: 600, color: i === 0 ? "var(--ink)" : "var(--muted)", paddingLeft: i === 0 ? 6 : 24, whiteSpace: "nowrap" }}>{i === 0 ? cat : ""}</td>
                    {l ? (<>
                      <td><input className="inp" style={{ minWidth: 170 }} placeholder="detail (optional)" value={l.label || ""} onChange={(e) => setL(l.id, "label", e.target.value)} /></td>
                      <td style={{ textAlign: "right" }}><NumberInput value={l.monthly} onChange={(v) => setL(l.id, "monthly", v)} min={0} className="inp num" style={{ width: 110, textAlign: "right" }} /></td>
                      <td><NumberInput value={l.dayOfMonth ?? 1} onChange={(v) => setL(l.id, "dayOfMonth", v)} min={1} max={28} integer className="inp num" style={{ width: 56 }} /></td>
                      <td><select className="sel" value={l.cadence || "monthly"} onChange={(e) => setL(l.id, "cadence", e.target.value)}><option value="monthly">Monthly</option><option value="per-sprint">Every sprint (spread)</option><option value="quarterly">Quarterly</option><option value="annual">Annual</option><option value="one-time">One-time</option></select></td>
                      <td><input className="inp num" style={{ width: 138 }} type="date" value={l.from || ""} onChange={(e) => setL(l.id, "from", e.target.value || undefined)} /></td>
                      <td><input className="inp num" style={{ width: 138 }} type="date" value={l.to || ""} onChange={(e) => setL(l.id, "to", e.target.value || undefined)} /></td>
                      <td style={{ whiteSpace: "nowrap" }}>
                        {i === lines.length - 1 && <button className="btn-x" title={"Add another " + cat + " line"} onClick={() => addLine(cat)}>+ line</button>}
                        <button className="btn-x" title="Remove" onClick={() => del(l.id)}><Cross /></button>
                      </td>
                    </>) : (<>
                      <td colSpan={6} style={{ color: "var(--muted)", fontSize: 12 }}>—</td>
                      <td><button className="btn-x" onClick={() => addLine(cat)}>+ line</button></td>
                    </>)}
                  </tr>
                ));
              })}
              <tr style={{ background: "#FBFAF6" }}>
                <td colSpan={2} style={{ fontWeight: 700, borderTop: "1px solid var(--line)", padding: "8px 6px" }}>Monthly burn</td>
                <td className="num" style={{ textAlign: "right", fontWeight: 700, fontSize: 14, color: "var(--fixed)", borderTop: "1px solid var(--line)" }}>{fmt(total)}</td>
                <td colSpan={5} style={{ borderTop: "1px solid var(--line)", fontSize: 11.5, color: "var(--muted)" }}>≈ <span className="num" style={{ fontWeight: 600, color: "var(--ink)" }}>{fmt(perSprint)}</span> per sprint · <span className="num" style={{ fontWeight: 600, color: "var(--ink)" }}>{fmt(perSprint / 2)}</span> per week</td>
              </tr>
            </tbody>
          </table>
        </div>

        <div style={{ flex: "0 0 360px", display: "flex", flexDirection: "column", gap: 14 }}>
          <div className="card" style={{ padding: "14px 16px", display: "flex", flexDirection: "column", gap: 10 }}>
            <div className="eyebrow">Heartbeat · per sprint</div>
            <div style={{ display: "flex", alignItems: "flex-end", gap: 5, height: 96, paddingTop: 6 }}>
              {heartbeat.arr.map((v, i) => (
                <div key={i} title={(cols[i] ? cols[i].range : "") + "  " + fmt(v)} style={{ flex: 1, display: "flex", flexDirection: "column", alignItems: "center", gap: 4, minWidth: 0 }}>
                  <span className="num" style={{ fontSize: 9, color: "var(--muted)" }}>{fmtK(v).replace("$", "")}</span>
                  <div style={{ width: "100%", height: Math.max(2, Math.round(70 * v / maxBar)), background: "var(--fixed)", opacity: .7, borderRadius: "3px 3px 0 0" }} />
                </div>
              ))}
            </div>
            <div style={{ display: "flex", justifyContent: "space-between", fontSize: 10, color: "var(--muted)" }} className="num"><span>{cols[0] ? "Sprint " + cols[0].ordinal + " · " + fmtMD(cols[0].start) : ""}</span><span>{cols[cols.length - 1] ? "Sprint " + cols[cols.length - 1].ordinal : ""}</span></div>
            <div style={{ fontSize: 11.5, color: "var(--muted)" }}>Flat by design. It only steps where a line has a from / to date.</div>
          </div>
          <div className="card" style={{ padding: "14px 16px", display: "flex", flexDirection: "column", gap: 8 }}>
            <div className="eyebrow">Known step-changes</div>
            {changes.length === 0 && <div style={{ fontSize: 11.5, color: "var(--muted)" }}>None yet — give a line a from / to date (a loan paying off, a hire) and it appears here.</div>}
            {changes.map(({ l, txt }) => (
              <div key={l.id} style={{ display: "flex", alignItems: "baseline", gap: 10, fontSize: 12 }}>
                <span className="num" style={{ fontWeight: 700, minWidth: 70, color: "var(--fixed)" }}>{fmt(l.monthly)}/mo</span>
                <span><span style={{ fontWeight: 600 }}>{l.category}</span>{l.label ? " · " + l.label : ""} <span className="num" style={{ color: "var(--muted)" }}>· {txt}</span></span>
              </div>
            ))}
          </div>
          <div className="card" style={{ padding: "12px 16px", display: "flex", flexDirection: "column", gap: 6, borderColor: "#d8d3c6", background: "#FBFAF6" }}>
            <div className="eyebrow">Why debt lives here</div>
            <div style={{ fontSize: 11.5, color: "var(--muted)", lineHeight: 1.5 }}>Loan payments are part of the monthly heartbeat, so they're entered once here as <b>Debt service</b>. The Capital tab tracks only money coming <b>in</b> (equity, debt draws) — no amortization math, no double-counting.</div>
          </div>
        </div>
      </div>
    </>
  );
}
