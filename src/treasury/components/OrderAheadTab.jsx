// Materials to order — every material line across all runs, grouped by the sprint it
// must be ORDERED in (not the run's sprint). Amounts/leads are entered on the run; this
// board tracks the ordering (planned → ordered → linked to a bill) and flags overdue.
import React from "react";
import { fmtMD, isoLocal } from "../model/sprints.js";
import { fmt, fmtK, Tag, Check, Warn } from "./ui.jsx";

/** props: result (engine Result), runs, setLineStatus(runId, lineId, status), today (ISO), selectRun(runId) */
export function OrderAheadTab({ result, runs, setLineStatus, today, selectRun }) {
  const { cols, orderAhead, overdue, perRun } = result;
  const runById = Object.fromEntries(runs.map((r) => [r.id, r]));
  const lineOf = (runId, lineId) => (runById[runId]?.materials || []).find((l) => l.id === lineId);
  const groups = orderAhead.map((g, i) => ({ ...g, col: cols[i] })).filter((g) => g.lines.length > 0 || g.i === 0);
  const visibleRuns = runs.filter((r) => !r.hidden);
  const next4 = orderAhead.slice(0, 4);
  const maxBar = Math.max(1, ...next4.map((g) => g.total));

  const statusChip = (l) => {
    const st = l?.status || "planned";
    if (st === "linked") return <Tag tone="in">linked to bill</Tag>;
    if (st === "ordered") return <Tag tone="in">ordered{l.orderedOn ? " · " + fmtMD(new Date(l.orderedOn + "T00:00:00")) : ""}</Tag>;
    return <Tag>planned</Tag>;
  };

  const row = (x, opts = {}) => {
    const l = lineOf(x.runId, x.lineId);
    const r = runById[x.runId];
    return (
      <div key={x.lineId + (opts.overdue ? "-od" : "")} style={{ display: "grid", gridTemplateColumns: "160px minmax(180px,1fr) 70px 110px 110px 150px 200px", gap: 10, alignItems: "center", padding: "6px 12px", borderTop: "1px solid var(--line2)", fontSize: 12, background: opts.overdue ? "#fbeeea" : undefined }}>
        <span style={{ display: "flex", alignItems: "center", gap: 6, fontWeight: 600, cursor: "pointer" }} onClick={() => selectRun && selectRun(x.runId)} title="Open this run on the planner"><span style={{ width: 8, height: 8, borderRadius: 2, background: r?.color || "#888" }} />{x.runName}</span>
        <span>{x.label}</span>
        <span className="num" style={{ textAlign: "right", color: "var(--muted)" }}>{l ? (l.leadWeeks || 0) + " wk" + ((l.leadWeeks || 0) === 1 ? "" : "s") : ""}</span>
        <span className="num" style={{ textAlign: "right", fontWeight: 600, color: opts.overdue ? "var(--danger)" : "var(--out)" }}>{fmt(x.amount)}</span>
        <span className="num" style={{ color: opts.overdue ? "var(--danger)" : "var(--ink)", fontWeight: opts.overdue ? 700 : 400 }}>{opts.overdue ? "was " : ""}{fmtMD(x.orderDate)}</span>
        <span style={{ color: "var(--muted)" }}>{r ? "Sprint " + (x.feedsK - result.origin) + " · " + fmtMD(cols[0] ? new Date(cols[0].start.getTime() + (x.feedsK - result.origin) * 14 * 86400000) : x.orderDate) : ""}</span>
        <span style={{ display: "flex", alignItems: "center", gap: 6, flexWrap: "wrap" }}>
          {opts.overdue ? <Tag tone="out">overdue</Tag> : statusChip(l)}
          {l && l.status !== "linked" && (l.status === "ordered"
            ? <button className="btn-x" style={{ fontSize: 11 }} onClick={() => setLineStatus(x.runId, x.lineId, "planned")}>undo</button>
            : <button className="btn-x" style={{ fontSize: 11, color: "var(--pos)", fontWeight: 600 }} onClick={() => setLineStatus(x.runId, x.lineId, "ordered", today)}>mark ordered</button>)}
        </span>
      </div>
    );
  };

  return (
    <div style={{ display: "flex", gap: 14, alignItems: "flex-start", marginTop: 18, flexWrap: "wrap" }}>
      <div className="card" style={{ flex: "1 1 860px", overflow: "hidden" }}>
        <div style={{ padding: "10px 14px", borderBottom: "1px solid var(--line)", display: "flex", alignItems: "center", gap: 12, flexWrap: "wrap" }}>
          <span className="eyebrow">Order-ahead board</span>
          <span style={{ fontSize: 11.5, color: "var(--muted)" }}>order date = start of the sprint the line feeds − lead time · paid on order</span>
          <span style={{ marginLeft: "auto", fontSize: 11.5, color: "var(--pos)", fontWeight: 600 }}>amounts &amp; lead times are entered on the run — this board tracks the ordering</span>
        </div>
        <div style={{ display: "grid", gridTemplateColumns: "160px minmax(180px,1fr) 70px 110px 110px 150px 200px", gap: 10, padding: "8px 12px 6px", fontSize: 11, color: "var(--muted)", fontWeight: 600 }}>
          <span>Run</span><span>Material</span><span style={{ textAlign: "right" }}>Lead</span><span style={{ textAlign: "right" }}>Total cost</span><span>Order by</span><span>Feeds</span><span>Status</span>
        </div>

        {overdue.length > 0 && (
          <>
            <div style={{ display: "flex", alignItems: "baseline", gap: 10, padding: "10px 12px 6px", background: "#fbeeea", borderTop: "1px solid #e6c4bd" }}>
              <span className="eyebrow" style={{ color: "var(--danger)" }}>Overdue · should already be ordered</span>
              <span style={{ fontSize: 11, color: "#8f3322" }}>before this sprint — <b>not in the cash plan</b>. Ordering now lands the cash in the current sprint.</span>
              <span className="num" style={{ marginLeft: "auto", fontSize: 12, fontWeight: 700, color: "var(--danger)" }}>{fmt(overdue.reduce((s, x) => s + x.amount, 0))}</span>
            </div>
            {overdue.map((x) => row(x, { overdue: true }))}
          </>
        )}

        {groups.map((g) => (
          <React.Fragment key={g.k}>
            <div style={{ display: "flex", alignItems: "baseline", gap: 10, padding: "10px 12px 6px", background: "#F7F5EE", borderTop: "1px solid var(--line)" }}>
              <span className="eyebrow" style={{ color: "var(--ink)" }}>Sprint {g.col.ordinal} · {g.col.range}</span>
              {g.i === 0 && <span style={{ fontSize: 11, color: "var(--danger)", fontWeight: 700 }}>order now</span>}
              <span className="num" style={{ marginLeft: "auto", fontSize: 12, fontWeight: 700, color: "var(--out)" }}>{fmt(g.total)}</span>
              <span style={{ fontSize: 11, color: "var(--muted)" }}>cash committed this sprint · {g.count} order{g.count === 1 ? "" : "s"}</span>
            </div>
            {g.lines.length === 0 && <div style={{ padding: "8px 12px", fontSize: 12, color: "var(--muted)", borderTop: "1px solid var(--line2)" }}>nothing to order this sprint</div>}
            {g.lines.map((x) => row(x))}
          </React.Fragment>
        ))}
        {groups.length === 0 && overdue.length === 0 && <div style={{ padding: 20, fontSize: 12.5, color: "var(--muted)" }}>No materials scheduled yet — expand a run on the planner and enter its materials table.</div>}
      </div>

      <div style={{ flex: "0 0 340px", display: "flex", flexDirection: "column", gap: 14 }}>
        <div className="card" style={{ padding: "14px 16px", display: "flex", flexDirection: "column", gap: 10 }}>
          <div className="eyebrow">Coverage by run</div>
          {visibleRuns.length === 0 && <div style={{ fontSize: 11.5, color: "var(--muted)" }}>No runs yet.</div>}
          {visibleRuns.map((r) => {
            const c = perRun[r.id]?.coverage || { total: 0, overdue: 0, firstDue: null };
            const ok = c.overdue === 0;
            return (
              <div key={r.id} style={{ display: "flex", alignItems: "center", gap: 8, fontSize: 12 }}>
                {c.total === 0 ? <span style={{ width: 14 }} /> : ok ? <Check size={14} /> : <Warn size={14} />}
                <span style={{ fontWeight: 600 }}>{r.name}</span>
                <span style={{ color: ok ? "var(--muted)" : "var(--danger)" }}>{c.total === 0 ? "no materials entered" : ok ? `${c.total} line${c.total === 1 ? "" : "s"}${c.firstDue ? " · next due " + fmtMD(c.firstDue) : " · all ordered"}` : `${c.overdue} overdue${c.firstDue ? " · since " + fmtMD(c.firstDue) : ""}`}</span>
              </div>
            );
          })}
        </div>
        <div className="card" style={{ padding: "14px 16px", display: "flex", flexDirection: "column", gap: 8 }}>
          <div className="eyebrow">Cash committed ahead · next 4 sprints</div>
          <div style={{ display: "flex", alignItems: "flex-end", gap: 8, height: 72, paddingTop: 4 }}>
            {next4.map((g, i) => (
              <div key={i} style={{ flex: 1, display: "flex", flexDirection: "column", alignItems: "center", gap: 4 }}>
                <span className="num" style={{ fontSize: 10, color: "var(--muted)" }}>{fmtK(g.total).replace("$", "")}</span>
                <div style={{ width: "100%", height: Math.max(2, Math.round(56 * g.total / maxBar)), background: "var(--out)", opacity: .7, borderRadius: "3px 3px 0 0" }} />
              </div>
            ))}
          </div>
          <div style={{ display: "flex", justifyContent: "space-between", fontSize: 10, color: "var(--muted)" }} className="num">{next4.map((g, i) => <span key={i}>S{cols[i] ? cols[i].ordinal : i}</span>)}</div>
          <div style={{ fontSize: 11.5, color: "var(--muted)" }}>The same money as the Materials row in the cash flow — shown by the sprint you have to <b>spend</b> it.</div>
        </div>
        <div className="card" style={{ padding: "12px 16px", display: "flex", flexDirection: "column", gap: 6, borderColor: "#d8d3c6", background: "#FBFAF6" }}>
          <div className="eyebrow">The five standard lines</div>
          <div style={{ fontSize: 11.5, color: "var(--muted)", lineHeight: 1.5 }}>Every run starts with <b>Soft goods · Cans · Cartons · Imported spirits · Domestic spirits</b> (default leads 3 · 4 · 3 · 4 · 2 wks) plus "Add more". Mark a line <b>ordered</b> when the PO goes out, or link its Xero bill from the run — the estimate is replaced by the actual, never double-counted. Today: {fmtMD(new Date(isoLocal(new Date(today + "T00:00:00")) + "T00:00:00"))}.</div>
        </div>
      </div>
    </div>
  );
}
