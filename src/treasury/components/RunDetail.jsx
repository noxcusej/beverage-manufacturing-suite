// Run detail — where a run's materials and payments are ENTERED. Materials are a simple
// table: the five standard lines are always present (Soft goods · Cans · Cartons ·
// Imported spirits · Domestic spirits) plus "Add more". Payments: deposit + BOM funding
// (fixed dates), optional progress lines, and a completion pinned to run end that
// auto-balances to the run value.
import React from "react";
import { materialOrderDate, paymentDate, runStartDate, runEndDate, materialsTotal, balancePayments, newMaterialLine, DEFAULT_EXTRA_LEAD } from "../model/runs.js";
import { isoLocal, fmtMD, parseLocalDate } from "../model/sprints.js";
import { NumberInput, fmt, Tag, Check, Warn, Cross } from "./ui.jsx";
import { BillLinks } from "./BillLinks.jsx";

/**
 * props: run, patchRun(id, fn), delRun(id), dupRun(run), toggleHide(id), epoch, origin, today, newId,
 *        ap, billedByLine, linkBill, unlinkBill, payDateOf, setPayDate, refreshFromSuite(run), coverage, onClose
 */
export function RunDetail({ run, patchRun, delRun, dupRun, toggleHide, epoch, origin, today, newId, ap, billedByLine, linkBill, unlinkBill, payDateOf, setPayDate, refreshFromSuite, coverage, onClose }) {
  const r = run;
  const set = (k, v) => patchRun(r.id, (x) => ({ ...x, [k]: v }));
  const setLine = (lineId, k, v) => patchRun(r.id, (x) => ({ ...x, materials: x.materials.map((l) => (l.id === lineId ? { ...l, [k]: v, ...(k === "amount" ? { source: "manual" } : {}) } : l)) }));
  const delLine = (lineId) => patchRun(r.id, (x) => ({ ...x, materials: x.materials.filter((l) => l.id !== lineId || l.standard) }));
  const addLine = () => patchRun(r.id, (x) => ({ ...x, materials: [...x.materials, newMaterialLine({ label: "", leadWeeks: DEFAULT_EXTRA_LEAD, feedsSprint: 1, amount: 0, category: "outsourced" }, newId)] }));
  // payments: editing a non-completion amount rebalances the completion; editing completion directly keeps it (warn if off)
  const setPay = (pid, k, v) => patchRun(r.id, (x) => {
    const p = x.payments.find((q) => q.id === pid);
    const next = { ...x, payments: x.payments.map((q) => (q.id === pid ? { ...q, [k]: v } : q)) };
    return p && p.kind !== "completion" && k === "amount" ? { ...next, payments: balancePayments(next) } : next;
  });
  const setPayTiming = (pid, timing) => patchRun(r.id, (x) => ({ ...x, payments: x.payments.map((q) => (q.id === pid ? { ...q, timing } : q)) }));
  const delPay = (pid) => patchRun(r.id, (x) => { const next = { ...x, payments: x.payments.filter((q) => q.id !== pid) }; return { ...next, payments: balancePayments(next) }; });
  const addProgress = () => patchRun(r.id, (x) => { const next = { ...x, payments: [...x.payments.filter((q) => q.kind !== "completion"), { id: newId("pay"), kind: "progress", label: "Progress payment", amount: 0, timing: { mode: "date", date: isoLocal(runStartDate(x, epoch)) } }, ...x.payments.filter((q) => q.kind === "completion")] }; return { ...next, payments: balancePayments(next) }; });
  const rebalance = () => patchRun(r.id, (x) => ({ ...x, payments: balancePayments(x) }));
  const setValue = (v) => patchRun(r.id, (x) => { const next = { ...x, value: v }; return { ...next, payments: balancePayments(next) }; });

  const matTotal = materialsTotal(r);
  const payTotal = (r.payments || []).reduce((s, p) => s + (Number(p.amount) || 0), 0);
  const balanced = Math.abs(payTotal - (Number(r.value) || 0)) < 0.5;
  const startOrd = r.startSprint - origin;
  const inpS = { padding: "3px 6px", fontSize: 12, borderRadius: 6 };

  return (
    <div className="card" style={{ marginTop: 12, overflow: "hidden", borderColor: r.color }}>
      <div style={{ padding: "10px 14px", borderBottom: "1px solid var(--line)", display: "flex", alignItems: "center", gap: 10, flexWrap: "wrap", background: "#FBFAF6" }}>
        <span style={{ width: 10, height: 10, borderRadius: 3, background: r.color }} />
        <input className="inp" value={r.name} onChange={(e) => set("name", e.target.value)} style={{ width: 200, fontWeight: 700 }} />
        <input className="inp" value={r.client || ""} placeholder="client" onChange={(e) => set("client", e.target.value)} style={{ width: 150 }} />
        <input type="color" value={r.color} onChange={(e) => set("color", e.target.value)} title="Run color" style={{ width: 28, height: 28, border: "1px solid var(--line)", borderRadius: 6, padding: 1, background: "#fff" }} />
        <label style={{ display: "flex", alignItems: "center", gap: 6, fontSize: 12, color: "var(--muted)" }}>starts sprint <NumberInput value={startOrd} onChange={(v) => set("startSprint", origin + v)} integer className="inp num" style={{ width: 56, ...inpS }} /></label>
        <label style={{ display: "flex", alignItems: "center", gap: 6, fontSize: 12, color: "var(--muted)" }}>sprints <NumberInput value={r.sprints} onChange={(v) => set("sprints", Math.max(1, v))} min={1} integer className="inp num" style={{ width: 56, ...inpS }} /></label>
        <span className="num" style={{ fontSize: 11.5, color: "var(--muted)" }}>{fmtMD(runStartDate(r, epoch))} → {fmtMD(runEndDate(r, epoch))}</span>
        <div style={{ flex: 1 }} />
        {r.suiteRunId && <button className="btn" style={{ fontSize: 12 }} title="Re-pull costs from the suite quote (keeps your schedule, payments and manual overrides)" onClick={() => refreshFromSuite(r)}>↻ Refresh cost from suite</button>}
        <button className="btn" style={{ fontSize: 12 }} onClick={() => dupRun(r)}>Duplicate</button>
        <button className="btn" style={{ fontSize: 12 }} onClick={() => toggleHide(r.id)}>{r.hidden ? "Show in position" : "Hide from position"}</button>
        <button className="btn" style={{ fontSize: 12, color: "var(--danger)" }} onClick={() => { if (window.confirm('Delete run "' + r.name + '"?')) delRun(r.id); }}>Delete</button>
        {onClose && <button className="btn-x" title="Close" onClick={onClose}><Cross /></button>}
      </div>

      <div style={{ display: "flex", gap: 14, padding: 14, flexWrap: "wrap", alignItems: "flex-start" }}>
        {/* materials table */}
        <div style={{ flex: "1 1 560px" }}>
          <div style={{ display: "flex", alignItems: "baseline", gap: 10, marginBottom: 8 }}>
            <span className="eyebrow">Materials</span>
            <span style={{ fontSize: 11.5, color: "var(--muted)" }}>paid on order · order date = start of the sprint it feeds − lead time</span>
            <span className="num" style={{ marginLeft: "auto", fontSize: 12, fontWeight: 700, color: "var(--out)" }}>{fmt(matTotal)}</span>
          </div>
          <table style={{ width: "100%", borderCollapse: "collapse" }}>
            <thead><tr>
              {["Material", "Lead time (wks)", "Feeds sprint", "Total cost", "Orders on", "Status", ""].map((h, i) => (<th key={i} className="th" style={{ textAlign: i === 1 || i === 2 || i === 3 ? "right" : "left", padding: "0 6px 6px", fontWeight: 600 }}>{h}</th>))}
            </tr></thead>
            <tbody>
              {(r.materials || []).map((l) => {
                const d = materialOrderDate(r, l, epoch);
                const late = (l.amount || 0) > 0 && d < parseLocalDate(today) && l.status !== "ordered" && l.status !== "linked";
                return (
                  <tr key={l.id} className="evrow">
                    <td>{l.standard ? <span style={{ fontWeight: 600, fontSize: 12.5 }}>{l.label}</span> : <input className="inp" value={l.label} placeholder="e.g. Cartoning (outsourced)" onChange={(e) => setLine(l.id, "label", e.target.value)} style={{ minWidth: 150, ...inpS }} />}</td>
                    <td style={{ textAlign: "right" }}><NumberInput value={l.leadWeeks} onChange={(v) => setLine(l.id, "leadWeeks", Math.max(0, v))} min={0} integer className="inp num" style={{ width: 62, textAlign: "center", ...inpS }} /></td>
                    <td style={{ textAlign: "right" }}><NumberInput value={l.feedsSprint || 1} onChange={(v) => setLine(l.id, "feedsSprint", Math.max(1, Math.min(r.sprints, v)))} min={1} max={r.sprints} integer className="inp num" style={{ width: 62, textAlign: "center", ...inpS }} title="Which sprint of this run the material must arrive for (1 = first)" /></td>
                    <td style={{ textAlign: "right" }}><NumberInput value={l.amount} onChange={(v) => setLine(l.id, "amount", Math.max(0, v))} min={0} className="inp num" style={{ width: 104, textAlign: "right", color: "var(--out)", fontWeight: 600, ...inpS }} /></td>
                    <td className="num" style={{ fontSize: 12, color: late ? "var(--danger)" : (l.amount || 0) > 0 ? "var(--ink)" : "var(--muted)", whiteSpace: "nowrap" }}>{fmtMD(d)}{late && <span className="late">overdue</span>}</td>
                    <td>{(l.amount || 0) > 0 ? (l.status === "linked" ? <Tag tone="in">linked to bill</Tag> : l.status === "ordered" ? <span style={{ display: "inline-flex", gap: 6, alignItems: "center" }}><Tag tone="in">ordered</Tag><button className="btn-x" style={{ fontSize: 10.5 }} onClick={() => setLine(l.id, "status", "planned")}>undo</button></span> : <button className="btn-x" style={{ fontSize: 11, color: "var(--pos)", fontWeight: 600 }} onClick={() => { setLine(l.id, "status", "ordered"); setLine(l.id, "orderedOn", today); }}>mark ordered</button>) : <span style={{ color: "#b8b2a4", fontSize: 11 }}>—</span>}</td>
                    <td style={{ textAlign: "right" }}>{!l.standard && <button className="btn-x" title="Remove line" onClick={() => delLine(l.id)}><Cross /></button>}{l.source === "suite" && <span title="pre-filled from the suite quote" className="tag" style={{ color: "#4b3f66", background: "#e8e2f2", marginLeft: 4 }}>suite</span>}</td>
                  </tr>
                );
              })}
            </tbody>
          </table>
          <div style={{ display: "flex", gap: 10, alignItems: "center", marginTop: 8 }}>
            <button className="btn" style={{ fontSize: 12 }} onClick={addLine}>+ Add more</button>
            <span style={{ fontSize: 11, color: "var(--muted)" }}>the five standard lines are always here — zero them if unused · extras default to a 1-week lead</span>
          </div>

          <div style={{ marginTop: 14 }}>
            <div style={{ display: "flex", alignItems: "baseline", gap: 10, marginBottom: 8 }}><span className="eyebrow">Budget vs actuals</span><span style={{ fontSize: 11.5, color: "var(--muted)" }}>link Xero bills to a line — the bill replaces that part of the estimate</span></div>
            <BillLinks {...{ run: r, ap, billedByLine, linkBill, unlinkBill, payDateOf, setPayDate, today, orderDateOf: (l) => materialOrderDate(r, l, epoch) }} />
          </div>
        </div>

        {/* payments + summary */}
        <div style={{ flex: "1 1 420px", display: "flex", flexDirection: "column", gap: 12 }}>
          <div>
            <div style={{ display: "flex", alignItems: "baseline", gap: 10, marginBottom: 8 }}>
              <span className="eyebrow">Client payments</span>
              <span style={{ fontSize: 11.5, color: "var(--muted)" }}>completion is due on receipt at run end and slides with the run</span>
            </div>
            <table style={{ width: "100%", borderCollapse: "collapse" }}>
              <thead><tr>{["Payment", "Amount", "When", "Lands", ""].map((h, i) => (<th key={i} className="th" style={{ textAlign: i === 1 ? "right" : "left", padding: "0 6px 6px", fontWeight: 600 }}>{h}</th>))}</tr></thead>
              <tbody>
                {(r.payments || []).map((p) => {
                  const d = paymentDate(r, p, epoch);
                  const isEnd = p.kind === "completion";
                  return (
                    <tr key={p.id} className="evrow">
                      <td><input className="inp" value={p.label} onChange={(e) => setPay(p.id, "label", e.target.value)} style={{ minWidth: 130, ...inpS }} /> <span style={{ fontSize: 10, color: "var(--muted)" }}>{p.kind}</span></td>
                      <td style={{ textAlign: "right" }}><NumberInput value={p.amount} onChange={(v) => setPay(p.id, "amount", v)} className="inp num" style={{ width: 104, textAlign: "right", color: "var(--in)", fontWeight: 600, ...inpS }} /></td>
                      <td>{isEnd ? <span style={{ fontSize: 11.5, color: "var(--in)", fontWeight: 600 }}>run end (auto)</span> : (
                        <span style={{ display: "inline-flex", alignItems: "center", gap: 6 }}>
                          <select className="sel" style={{ padding: "2px 4px", fontSize: 11.5 }} value={p.timing.mode} onChange={(e) => setPayTiming(p.id, e.target.value === "date" ? { mode: "date", date: isoLocal(d) } : { mode: "beforeStart", weeks: 4 })}>
                            <option value="date">fixed date</option><option value="beforeStart">before run start</option>
                          </select>
                          {p.timing.mode === "date"
                            ? <input className="inp num" type="date" value={p.timing.date} onChange={(e) => setPayTiming(p.id, { mode: "date", date: e.target.value })} style={{ width: 138, ...inpS }} />
                            : <span style={{ display: "inline-flex", alignItems: "center", gap: 4, fontSize: 11.5 }}><NumberInput value={p.timing.weeks} onChange={(v) => setPayTiming(p.id, { mode: "beforeStart", weeks: Math.max(0, v) })} min={0} integer className="inp num" style={{ width: 48, textAlign: "center", ...inpS }} /> wks</span>}
                        </span>)}
                      </td>
                      <td className="num" style={{ fontSize: 12, whiteSpace: "nowrap" }}>{fmtMD(d)}</td>
                      <td style={{ textAlign: "right" }}>{!isEnd && <button className="btn-x" title="Remove (completion rebalances)" onClick={() => delPay(p.id)}><Cross /></button>}</td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
            <div style={{ display: "flex", gap: 10, alignItems: "center", marginTop: 8, flexWrap: "wrap" }}>
              <button className="btn" style={{ fontSize: 12 }} onClick={addProgress}>+ Progress payment</button>
              {balanced ? <span style={{ display: "inline-flex", alignItems: "center", gap: 4, fontSize: 11.5, color: "var(--in)", fontWeight: 600 }}><Check /> schedule balances to the run value</span>
                : <span style={{ display: "inline-flex", alignItems: "center", gap: 6, fontSize: 11.5, color: "var(--danger)", fontWeight: 600 }}><Warn /> schedule ≠ run value by {fmt(payTotal - (r.value || 0))} <button className="btn-x" style={{ fontSize: 11 }} onClick={rebalance}>rebalance completion</button></span>}
            </div>
          </div>

          <div className="card" style={{ padding: "10px 12px", background: "#FBFAF6", display: "grid", gridTemplateColumns: "1fr 1fr", gap: 8, fontSize: 12 }}>
            <label style={{ display: "flex", flexDirection: "column", gap: 2 }}><span className="eyebrow">Run value</span><NumberInput value={r.value} onChange={setValue} className="inp num" style={{ ...inpS, fontWeight: 700 }} /></label>
            <label style={{ display: "flex", flexDirection: "column", gap: 2 }}><span className="eyebrow">Tolling (margin)</span><NumberInput value={r.tolling} onChange={(v) => set("tolling", v)} className="inp num" style={{ ...inpS, color: "var(--in)", fontWeight: 700 }} /></label>
            <label style={{ display: "flex", flexDirection: "column", gap: 2 }}><span className="eyebrow">Taxes & regulatory</span><NumberInput value={r.taxes} onChange={(v) => set("taxes", v)} className="inp num" style={{ ...inpS, color: "var(--out)" }} /><span style={{ fontSize: 10.5, color: "var(--muted)" }}>paid at run end</span></label>
            <div style={{ display: "flex", flexDirection: "column", gap: 2 }}><span className="eyebrow">Net cash from this run</span><span className="num" style={{ fontSize: 15, fontWeight: 700, color: payTotal - matTotal - (r.taxes || 0) >= 0 ? "var(--in)" : "var(--out)" }}>{fmt(payTotal - matTotal - (r.taxes || 0))}</span><span style={{ fontSize: 10.5, color: "var(--muted)" }}>payments − materials − taxes</span></div>
          </div>

          {coverage && (
            <div style={{ display: "flex", alignItems: "center", gap: 8, fontSize: 12 }}>
              {coverage.total === 0 ? null : coverage.overdue === 0 ? <Check size={14} /> : <Warn size={14} />}
              <span style={{ color: coverage.overdue ? "var(--danger)" : "var(--muted)" }}>{coverage.total === 0 ? "No materials entered yet." : coverage.overdue ? `${coverage.overdue} material order${coverage.overdue === 1 ? "" : "s"} overdue — order now or move the run later.` : `All ${coverage.total} material line${coverage.total === 1 ? "" : "s"} on time${coverage.firstDue ? " · next order " + fmtMD(coverage.firstDue) : ""}.`}</span>
            </div>
          )}
          <div style={{ fontSize: 11, color: "var(--muted)", lineHeight: 1.5 }}>Notes on this run: <input className="inp" value={r.notes || ""} placeholder="optional" onChange={(e) => set("notes", e.target.value || undefined)} style={{ ...inpS, marginTop: 4 }} /></div>
        </div>
      </div>
    </div>
  );
}
