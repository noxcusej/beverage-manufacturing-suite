// Sprint planner — runs as bars on a 2-week sprint grid (drag by whole sprints), the
// order-ahead lane, expand-in-place sub-rows (materials orders before the bar, payments,
// completion pinned to the bar end), and a closing-position strip aligned to the columns.
import React, { useEffect, useRef, useState } from "react";
import { materialOrderDate, paymentDate, runEndDate } from "../model/runs.js";
import { sprintStart, daysBetween, parseLocalDate, fmtMD } from "../model/sprints.js";
import { RAIL_W, COL_W } from "./CashFlowTable.jsx";
import { fmt, fmtK, hexA, EyeOn, EyeOff, Chevron, Grip, Diamond, Tri } from "./ui.jsx";

const HEADER_H = 46, LANE_H = 32, ROW_H = 46, SUB_H = 30, POS_H = 34;

/**
 * props: result, runs, patchRun(id, fn), selId, setSelId, expandedId, setExpandedId, epoch, origin, horizon, today,
 *        floor, reorderRun(fromId, toId, after), toggleHide(id), scrollRef, onScrollSync
 */
export function Planner({ result, runs, patchRun, selId, setSelId, expandedId, setExpandedId, epoch, origin, horizon, today, floor, reorderRun, toggleHide, scrollRef, onScrollSync }) {
  const { cols, perRun, orderAhead, overdue, rows } = result;
  const TL_W = horizon * COL_W;
  const left0 = sprintStart(origin, epoch);
  const xOf = (date) => (daysBetween(left0, date) / 14) * COL_W;
  const todayX = xOf(parseLocalDate(today));

  /* drag a bar (move / resize) by whole sprints */
  const dragRef = useRef(null);
  const [dragging, setDragging] = useState(false);
  const onDown = (e, r, mode) => { e.preventDefault(); e.stopPropagation(); setSelId(r.id); dragRef.current = { id: r.id, mode, x0: e.clientX, ss: r.startSprint, sp: r.sprints }; setDragging(true); };
  const patchRunRef = useRef(patchRun);
  useEffect(() => { patchRunRef.current = patchRun; });
  useEffect(() => {
    if (!dragging) return;
    const minStart = origin - 6;
    const onMove = (e) => {
      const d = dragRef.current; if (!d) return;
      const ds = Math.round((e.clientX - d.x0) / COL_W);
      patchRunRef.current(d.id, (r) => {
        if (d.mode === "move") return { ...r, startSprint: Math.max(minStart, d.ss + ds) };
        if (d.mode === "start") { const ns = Math.max(minStart, Math.min(d.ss + ds, d.ss + d.sp - 1)); return { ...r, startSprint: ns, sprints: d.sp + (d.ss - ns) }; }
        if (d.mode === "end") return { ...r, sprints: Math.max(1, d.sp + ds) };
        return r;
      });
    };
    const onUp = () => { dragRef.current = null; setDragging(false); };
    window.addEventListener("mousemove", onMove); window.addEventListener("mouseup", onUp);
    return () => { window.removeEventListener("mousemove", onMove); window.removeEventListener("mouseup", onUp); };
  }, [dragging, origin]);

  /* drag-to-reorder in the rail */
  const [dnd, setDnd] = useState(null);

  const railCell = (h, extra) => ({ height: h, borderBottom: "1px solid var(--line2)", display: "flex", alignItems: "center", gap: 6, padding: "0 6px", ...extra });
  const overdueCount = overdue.length;

  /* sub-rows for the expanded run */
  const subRows = (r) => {
    const lines = (r.materials || []).filter((l) => (l.amount || 0) > 0);
    const pays = r.payments || [];
    const barL = (r.startSprint - origin) * COL_W + 2, barR = barL + r.sprints * COL_W - 4;
    const items = [];
    items.push({ key: "mh", rail: <span className="eyebrow" style={{ fontSize: 9, paddingLeft: 32 }}>Materials {lines.length === 0 && <span style={{ textTransform: "none", letterSpacing: 0, fontWeight: 400 }}>· enter costs below</span>}</span>, tl: null });
    for (const l of lines) {
      const d = materialOrderDate(r, l, epoch); const x = xOf(d);
      const late = d < parseLocalDate(today) && l.status !== "ordered" && l.status !== "linked";
      items.push({
        key: "m" + l.id,
        rail: (<span style={{ display: "flex", alignItems: "center", gap: 6, paddingLeft: 32, fontSize: 11.5, width: "100%" }}><span style={{ flex: 1, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{l.label}</span><span className="num" style={{ color: "var(--out)" }}>{fmtK(-l.amount)}</span></span>),
        tl: (<>
          {x < barL && <div style={{ position: "absolute", left: Math.max(0, x), width: Math.max(0, barL - Math.max(0, x)), top: SUB_H / 2, height: 0, borderTop: "1px dashed " + hexA("#B14A3B", .35) }} />}
          <div style={{ position: "absolute", left: x - 6, top: SUB_H / 2 - 6, display: "flex", alignItems: "center", gap: 5 }} title={l.label + "  −" + fmt(l.amount) + "  ·  orders " + fmtMD(d) + " (" + (l.leadWeeks || 0) + " wks before the sprint it feeds)" + (late ? "  ·  OVERDUE, not counted" : "")}>
            <Diamond color={late ? "var(--danger)" : "var(--out)"} />
            <span className="num" style={{ fontSize: 10, color: late ? "var(--danger)" : "var(--muted)", whiteSpace: "nowrap" }}>{fmtMD(d)}{late ? " · overdue" : ""}</span>
          </div>
        </>),
      });
    }
    items.push({ key: "ph", rail: <span className="eyebrow" style={{ fontSize: 9, paddingLeft: 32 }}>Client payments</span>, tl: null });
    for (const p of pays) {
      const d = paymentDate(r, p, epoch); const x = xOf(d); const isEnd = p.timing && p.timing.mode === "runEnd";
      items.push({
        key: "p" + p.id,
        rail: (<span style={{ display: "flex", alignItems: "center", gap: 6, paddingLeft: 32, fontSize: 11.5, width: "100%" }}><span style={{ flex: 1, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{p.label}</span><span className="num" style={{ color: "var(--in)" }}>{fmtK(p.amount)}</span></span>),
        tl: (<>
          {isEnd && <div style={{ position: "absolute", left: barL, width: barR - barL, top: SUB_H / 2, height: 0, borderTop: "1px dashed " + hexA("#1F7A6B", .35) }} />}
          {isEnd && <div style={{ position: "absolute", left: barR - 1, top: 4, width: 2, height: SUB_H - 8, background: "var(--in)" }} />}
          <div style={{ position: "absolute", left: (isEnd ? barR + 6 : x - 6), top: SUB_H / 2 - 6, display: "flex", alignItems: "center", gap: 5 }} title={p.label + "  +" + fmt(p.amount) + "  ·  " + fmtMD(d) + (isEnd ? "  ·  due on receipt at run end (slides with the run)" : "  ·  fixed date")}>
            <Tri color="var(--in)" />
            <span className="num" style={{ fontSize: 10, color: "var(--muted)", whiteSpace: "nowrap" }}>{fmtMD(d)}{isEnd ? " · run end" : ""}</span>
          </div>
        </>),
      });
    }
    return items;
  };

  return (
    <div className="card" style={{ overflow: "hidden" }}>
      <div style={{ padding: "10px 14px", borderBottom: "1px solid var(--line)", display: "flex", alignItems: "baseline", gap: 12, flexWrap: "wrap" }}>
        <span className="eyebrow">Run planner · by sprint</span>
        <span style={{ fontSize: 11.5, color: "var(--muted)" }}>drag a run to move it by whole sprints · two runs can share a sprint · click ▸ to unfold a run's materials and payments</span>
        <span className="num" style={{ marginLeft: "auto", fontSize: 11.5, color: "var(--muted)" }}>today {fmtMD(parseLocalDate(today))} · Sprint 0 = {cols[0] ? cols[0].range : ""}</span>
      </div>
      <div style={{ display: "flex" }}>
        {/* rail */}
        <div style={{ width: RAIL_W, flex: "0 0 " + RAIL_W + "px", borderRight: "1px solid var(--line)", background: "#FBFAF6" }}>
          <div style={{ height: HEADER_H, borderBottom: "1px solid var(--line)", display: "flex", alignItems: "flex-end", padding: "0 12px 6px" }}><span className="eyebrow">Runs</span></div>
          <div style={railCell(LANE_H, { padding: "0 12px", background: "#F7F5EE", borderBottom: "1px solid var(--line)" })}><span className="eyebrow" style={{ fontSize: 9, color: "var(--out)" }}>Order ahead</span><span style={{ fontSize: 10.5, color: "var(--muted)" }}>to feed later runs</span></div>
          {runs.map((r) => {
            const pr = perRun[r.id] || { net: 0, coverage: { overdue: 0 }, pastPayments: 0 };
            const open = expandedId === r.id;
            const flag = !r.hidden && ((pr.coverage && pr.coverage.overdue > 0) || (pr.pastPayments || 0) > 0);
            return (
              <React.Fragment key={r.id}>
                <div draggable
                  onDragStart={(e) => { setDnd({ dragId: r.id, overId: r.id, after: false }); e.dataTransfer.effectAllowed = "move"; }}
                  onDragOver={(e) => { e.preventDefault(); if (!dnd) return; const rc = e.currentTarget.getBoundingClientRect(); const after = e.clientY - rc.top > rc.height / 2; if (dnd.overId !== r.id || dnd.after !== after) setDnd({ ...dnd, overId: r.id, after }); }}
                  onDrop={(e) => { e.preventDefault(); if (dnd && dnd.dragId !== r.id) reorderRun(dnd.dragId, r.id, dnd.after); setDnd(null); }}
                  onDragEnd={() => setDnd(null)}
                  onClick={() => setSelId(r.id)}
                  style={railCell(ROW_H, { cursor: "pointer", background: r.id === selId ? "#F1EFE7" : "transparent", opacity: dnd && dnd.dragId === r.id ? 0.4 : 1, boxShadow: dnd && dnd.dragId !== r.id && dnd.overId === r.id ? (dnd.after ? "inset 0 -2px 0 var(--pos)" : "inset 0 2px 0 var(--pos)") : undefined })}>
                  <span title="Drag to reorder" onClick={(ev) => ev.stopPropagation()} style={{ cursor: "grab", color: "var(--muted)", display: "inline-flex", userSelect: "none" }}><Grip /></span>
                  <button className="btn-x" title={open ? "Collapse" : "Expand — materials & payments"} onClick={(ev) => { ev.stopPropagation(); setExpandedId(open ? null : r.id); setSelId(r.id); }} style={{ padding: "0 2px", display: "inline-flex", color: "var(--ink)" }}><Chevron open={open} /></button>
                  <span style={{ width: 9, height: 9, borderRadius: 3, background: r.color, flex: "0 0 auto", opacity: r.hidden ? 0.4 : 1 }} />
                  <span className="barlabel" style={{ flex: 1, color: r.hidden ? "var(--muted)" : "inherit", textDecoration: r.hidden ? "line-through" : "none" }}>{r.name}</span>
                  {flag && <span title={(pr.coverage.overdue ? pr.coverage.overdue + " material order(s) overdue. " : "") + ((pr.pastPayments || 0) > 0 ? fmt(pr.pastPayments) + " of payments dated before today (not counted)." : "")} style={{ color: "var(--danger)", fontSize: 10.5, fontWeight: 700, cursor: "help" }}>◀!</span>}
                  <span className="num" style={{ fontSize: 11, color: r.hidden ? "var(--muted)" : pr.net >= 0 ? "var(--in)" : "var(--out)" }}>{fmtK(pr.net)}</span>
                  <button className="btn-x" title={r.hidden ? "Hidden from cash position — click to show" : "Hide from cash position"} onClick={(ev) => { ev.stopPropagation(); toggleHide(r.id); }} style={{ padding: "0 3px", display: "flex", alignItems: "center", color: r.hidden ? "var(--muted)" : "var(--ink)" }}>{r.hidden ? <EyeOff /> : <EyeOn />}</button>
                </div>
                {open && subRows(r).map((s) => (<div key={s.key} style={railCell(SUB_H, { background: "#FDFCF8" })}>{s.rail}</div>))}
              </React.Fragment>
            );
          })}
          {runs.length === 0 && <div style={{ padding: "14px 12px", fontSize: 12, color: "var(--muted)" }}>No runs yet — add one or import from quoting.</div>}
          <div style={railCell(POS_H, { padding: "0 12px", borderTop: "1px solid var(--line)", background: "#F7F5EE" })}><span className="eyebrow" style={{ fontSize: 9, color: "var(--pos)" }}>Closing position</span></div>
        </div>

        {/* timeline */}
        <div ref={scrollRef} onScroll={onScrollSync} style={{ overflowX: "auto", flex: 1 }}>
          <div style={{ width: TL_W, position: "relative" }}>
            <div style={{ height: HEADER_H, borderBottom: "1px solid var(--line)", display: "grid", gridTemplateColumns: `repeat(${horizon}, ${COL_W}px)` }}>
              {cols.map((c, i) => (
                <div key={c.k} title={"Sprint " + c.ordinal + " · " + c.range} style={{ borderRight: "1px solid var(--line2)", padding: "6px 8px", display: "flex", flexDirection: "column", gap: 2, background: i === 0 ? "#FBFAF6" : undefined, cursor: "help" }}>
                  <span className="eyebrow" style={{ fontSize: 9 }}>Sprint {c.ordinal}{i === 0 ? " · now" : ""}</span>
                  <span className="num th" style={{ color: "var(--ink)" }}>{c.range}</span>
                </div>
              ))}
            </div>
            <div style={{ height: LANE_H, borderBottom: "1px solid var(--line)", display: "grid", gridTemplateColumns: `repeat(${horizon}, ${COL_W}px)`, background: "#F7F5EE" }}>
              {orderAhead.map((g, i) => (
                <div key={i} title={g.lines.map((l) => l.runName + " — " + l.label + "  −" + fmt(l.amount) + "  · order by " + fmtMD(l.orderDate)).join("\n") || "nothing to order this sprint"} style={{ borderRight: "1px solid var(--line2)", padding: "0 8px", display: "flex", alignItems: "center", gap: 5, overflow: "hidden", whiteSpace: "nowrap", cursor: g.count ? "help" : "default" }}>
                  {g.total > 0 ? (<><span className="num" style={{ fontSize: 11, fontWeight: 700, color: "var(--out)" }}>{fmtK(g.total)}</span><span style={{ fontSize: 10, color: "var(--muted)" }}>{g.count} order{g.count === 1 ? "" : "s"}</span></>) : <span style={{ fontSize: 11, color: "#cfcabb" }}>—</span>}
                  {i === 0 && overdueCount > 0 && <span style={{ fontSize: 10, color: "var(--danger)", fontWeight: 700 }}>· {overdueCount} overdue</span>}
                </div>
              ))}
            </div>
            <div style={{ position: "relative" }}>
              {Array.from({ length: horizon }).map((_, i) => (<div key={i} className="gridline" style={{ left: (i + 1) * COL_W - 1 }} />))}
              {todayX >= 0 && todayX <= TL_W && (<><div style={{ position: "absolute", top: 0, bottom: 0, left: todayX, width: 2, background: "var(--danger)", opacity: .5, zIndex: 1 }} /><div style={{ position: "absolute", top: 3, left: todayX + 5, fontSize: 9, fontWeight: 700, color: "var(--danger)", letterSpacing: ".08em", zIndex: 1 }}>TODAY</div></>)}
              {runs.map((r) => {
                const open = expandedId === r.id;
                const barL = (r.startSprint - origin) * COL_W + 2, barW = r.sprints * COL_W - 4;
                const endD = runEndDate(r, epoch);
                return (
                  <React.Fragment key={r.id}>
                    <div style={{ height: ROW_H, borderBottom: "1px solid var(--line2)", position: "relative", background: open ? "#F7F5EE" : undefined }} onClick={() => setSelId(r.id)}>
                      <div onMouseDown={(e) => onDown(e, r, "move")} title={r.name + " · Sprint " + (r.startSprint - origin) + (r.sprints > 1 ? "–" + (r.startSprint - origin + r.sprints - 1) : "") + " · ends " + fmtMD(endD)}
                        style={{ position: "absolute", left: barL, width: barW, top: 7, height: 22, borderRadius: 6, cursor: "grab", background: hexA(r.color, .16), border: "1px " + (r.hidden ? "dashed" : "solid") + " " + hexA(r.color, .55), opacity: r.hidden ? .45 : 1, boxShadow: r.id === selId ? "0 0 0 2px " + hexA(r.color, .35) : "none", display: "flex", alignItems: "center", padding: "0 8px", overflow: "hidden", gap: 6 }}>
                        <span style={{ width: 6, height: 6, borderRadius: 2, background: r.color, flex: "0 0 auto" }} />
                        <span className="barlabel" style={{ color: "#2a2f35" }}>{r.name}</span>
                        <span className="num" style={{ marginLeft: "auto", fontSize: 10, color: "var(--muted)", whiteSpace: "nowrap" }}>{r.sprints} sprint{r.sprints === 1 ? "" : "s"}</span>
                        <div className="handle" style={{ left: -1 }} onMouseDown={(e) => onDown(e, r, "start")} />
                        <div className="handle" style={{ right: -1 }} onMouseDown={(e) => onDown(e, r, "end")} />
                      </div>
                      {!r.hidden && !open && (r.materials || []).filter((l) => (l.amount || 0) > 0).map((l) => { const d = materialOrderDate(r, l, epoch); const x = xOf(d); if (x < 0 || x > TL_W) return null; return (<span key={l.id} style={{ position: "absolute", left: x - 5, bottom: 2, zIndex: 2, display: "inline-flex" }} title={l.label + "  −" + fmt(l.amount) + "  ·  orders " + fmtMD(d)}><Diamond size={10} /></span>); })}
                      {!r.hidden && !open && (r.payments || []).map((p) => { const d = paymentDate(r, p, epoch); const x = xOf(d); if (x < 0 || x > TL_W) return null; return (<span key={p.id} style={{ position: "absolute", left: x - 5, bottom: 2, zIndex: 2, display: "inline-flex" }} title={p.label + "  +" + fmt(p.amount) + "  ·  " + fmtMD(d)}><Tri size={10} /></span>); })}
                    </div>
                    {open && subRows(r).map((s) => (<div key={s.key} style={{ height: SUB_H, borderBottom: "1px solid var(--line2)", position: "relative", background: "#FDFCF8" }}>{s.tl}</div>))}
                  </React.Fragment>
                );
              })}
              <div style={{ height: POS_H, borderTop: "1px solid var(--line)", display: "grid", gridTemplateColumns: `repeat(${horizon}, ${COL_W}px)`, background: "#F7F5EE" }}>
                {rows.closing.map((v, i) => (
                  <div key={i} className="num" style={{ borderRight: "1px solid var(--line2)", padding: "0 8px", display: "flex", alignItems: "center", justifyContent: "flex-end", fontSize: 11.5, fontWeight: 700, color: v < 0 ? "var(--danger)" : v < floor ? "#7c5e00" : "var(--pos)", background: v >= 0 && v < floor ? "#FDE047" : undefined }}>{fmtK(v)}</div>
                ))}
              </div>
            </div>
          </div>
        </div>
      </div>
      <div style={{ padding: "8px 14px", borderTop: "1px solid var(--line)", display: "flex", gap: 16, fontSize: 11, color: "var(--muted)", alignItems: "center", flexWrap: "wrap" }}>
        <span style={{ display: "inline-flex", alignItems: "center", gap: 5 }}><Diamond size={10} /> material ordered (paid on order)</span>
        <span style={{ display: "inline-flex", alignItems: "center", gap: 5 }}><Tri size={10} /> client payment</span>
        <span style={{ display: "inline-flex", alignItems: "center", gap: 5 }}><span style={{ width: 2, height: 12, background: "var(--in)", display: "inline-block" }} /> completion, pinned to run end</span>
        <span style={{ marginLeft: "auto" }}>the order-ahead lane is the cash you must commit in that sprint for runs that start later</span>
      </div>
    </div>
  );
}
