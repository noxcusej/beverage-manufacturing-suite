/* eslint-disable react-refresh/only-export-components -- shared helpers live beside the components that use them */
// Modal pickers for Treasury Cockpit v2 — ported from v1 (same overlay/card/.tag conventions).
import React, { useEffect, useMemo, useState } from "react";
import { loadAppData } from "../../data/supabase";
import { computeRunResults } from "../../utils/runResults";
import { MON } from "../model/sprints.js";
import { fmt, Chevron, Cross } from "./ui.jsx";

/* one-quote rollup for the picker UI (units/cases/total/tolling margin) */
export function quoteSummary(run) {
  try { const r = computeRunResults(run); return { units: r.counts.totalUnits || 0, cases: r.counts.totalCases || 0, total: r.costs.totalCost || 0, tolling: r.costs.tollingCost || 0, costs: r.costs }; }
  catch { return { units: 0, cases: 0, total: 0, tolling: 0, costs: null }; }
}

/* Scenario picker — switch / create / rename / group / delete budget scenarios. NOT a dropdown. */
export function ScenarioPicker({ scenarios, activeId, onClose, onSwitch, onSaveAs, onRename, onDelete, onSetGroup }) {
  const [newName, setNewName] = useState("");
  const [newGroup, setNewGroup] = useState("");
  const [collapsed, setCollapsed] = useState(() => new Set());
  const fmtWhen = (ts) => { if (!ts) return ""; const d = new Date(ts); return MON[d.getMonth()] + " " + d.getDate(); };
  const groups = []; const idx = {};
  for (const s of scenarios) { const g = s.group || ""; if (!(g in idx)) { idx[g] = groups.length; groups.push({ name: g, items: [] }); } groups[idx[g]].items.push(s); }
  groups.sort((a, b) => (a.name === "" ? -1 : b.name === "" ? 1 : 0));
  const groupNames = [...new Set(scenarios.map((s) => s.group).filter(Boolean))];
  const sectioned = groups.length > 1 || (groups.length === 1 && groups[0].name !== "");
  const toggle = (g) => setCollapsed((c) => { const n = new Set(c); n.has(g) ? n.delete(g) : n.add(g); return n; });
  const row = (s) => {
    const active = s.id === activeId;
    return (
      <div key={s.id} onClick={() => onSwitch(s.id)} style={{ padding: "10px 16px", borderBottom: "1px solid var(--line2)", cursor: "pointer", background: active ? "#F1EFE7" : "transparent" }}>
        <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
          <span style={{ fontWeight: 600, fontSize: 13 }}>{s.name}</span>
          {active && <span className="tag" style={{ color: "#1f5e54", background: "#dcefe9" }}>active</span>}
          <span style={{ fontSize: 11, color: "var(--muted)" }}>updated {fmtWhen(s.updatedAt)}</span>
          <div style={{ flex: 1 }} />
          <button className="btn-x" style={{ fontSize: 11 }} title="Assign to a group" onClick={(e) => { e.stopPropagation(); const n = window.prompt("Group name (leave blank to ungroup):", s.group || ""); if (n !== null) onSetGroup(s.id, n); }}>Group</button>
          <button className="btn-x" style={{ fontSize: 11 }} title="Rename" onClick={(e) => { e.stopPropagation(); const n = window.prompt("Rename scenario:", s.name); if (n) onRename(s.id, n); }}>Rename</button>
          {scenarios.length > 1 && <button className="btn-x" style={{ fontSize: 11 }} title="Delete" onClick={(e) => { e.stopPropagation(); if (window.confirm('Delete scenario "' + s.name + '"? This can\'t be undone.')) onDelete(s.id); }}>Delete</button>}
        </div>
        {s.notes && <div style={{ marginTop: 3, fontSize: 11.5, color: "var(--muted)", whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }} title={s.notes}>{s.notes}</div>}
      </div>
    );
  };
  return (
    <div onClick={onClose} style={{ position: "fixed", inset: 0, background: "rgba(20,22,26,.45)", zIndex: 50, display: "flex", alignItems: "center", justifyContent: "center", padding: 24 }}>
      <div className="card" onClick={(e) => e.stopPropagation()} style={{ width: "min(560px, 96vw)", maxHeight: "82vh", display: "flex", flexDirection: "column", overflow: "hidden" }}>
        <div style={{ padding: "12px 16px", borderBottom: "1px solid var(--line)", display: "flex", alignItems: "center", gap: 12 }}>
          <span className="eyebrow">Budget scenarios</span>
          <span style={{ marginLeft: "auto", fontSize: 11.5, color: "var(--muted)" }}>click a scenario to switch</span>
          <button className="btn-x" onClick={onClose} title="Close"><Cross /></button>
        </div>
        <div style={{ overflowY: "auto", flex: 1 }}>
          {!sectioned ? scenarios.map(row) : groups.map((g) => {
            const isOpen = !collapsed.has(g.name || " ");
            return (
              <div key={g.name || "__ungrouped"}>
                <div onClick={() => toggle(g.name || " ")} style={{ display: "flex", alignItems: "center", gap: 8, padding: "7px 16px", background: "#F1EFE7", borderBottom: "1px solid var(--line)", cursor: "pointer", position: "sticky", top: 0, zIndex: 1 }}>
                  <span style={{ color: "var(--muted)", display: "inline-flex" }}><Chevron open={isOpen} size={10} /></span>
                  <span className="eyebrow" style={{ color: g.name ? "var(--ink)" : "var(--muted)" }}>{g.name || "Ungrouped"}</span>
                  <span style={{ fontSize: 11, color: "var(--muted)" }}>{g.items.length}</span>
                </div>
                {isOpen && g.items.map(row)}
              </div>
            );
          })}
        </div>
        <div style={{ padding: "10px 16px", borderTop: "1px solid var(--line)", display: "flex", alignItems: "center", gap: 8, flexWrap: "wrap" }}>
          <input className="inp" placeholder="New scenario name…" value={newName} onChange={(e) => setNewName(e.target.value)} onKeyDown={(e) => { if (e.key === "Enter" && newName.trim()) onSaveAs(newName.trim(), newGroup.trim()); }} style={{ flex: 2, minWidth: 160 }} />
          <input className="inp" placeholder="Group (optional)" list="tc-group-names" value={newGroup} onChange={(e) => setNewGroup(e.target.value)} onKeyDown={(e) => { if (e.key === "Enter" && newName.trim()) onSaveAs(newName.trim(), newGroup.trim()); }} style={{ flex: 1, minWidth: 110 }} />
          <datalist id="tc-group-names">{groupNames.map((g) => <option key={g} value={g} />)}</datalist>
          <button className="btn" disabled={!newName.trim()} style={{ fontWeight: 600, opacity: newName.trim() ? 1 : 0.5 }} onClick={() => newName.trim() && onSaveAs(newName.trim(), newGroup.trim())} title="Fork the current plan into a new named scenario (remember to Save afterward)">+ Create scenario from current</button>
        </div>
      </div>
    </div>
  );
}

/* Quote picker — choose which co-packing quotes to bring onto the planner. onImport(selectedQuotes) */
export function QuotePicker({ existingIds, onClose, onImport }) {
  const [quotes, setQuotes] = useState(null);
  const [sel, setSel] = useState(() => new Set());
  const [q, setQ] = useState("");
  useEffect(() => { let alive = true; (async () => { const r = await loadAppData("runs"); if (alive) setQuotes(Array.isArray(r) ? r : []); })(); return () => { alive = false; }; }, []);
  const rows = useMemo(() => (quotes || []).map((run) => ({ run, ...quoteSummary(run) })), [quotes]);
  const ql = q.toLowerCase();
  const filtered = rows.filter((r) => !q || (r.run.name || "").toLowerCase().includes(ql) || (r.run.client || "").toLowerCase().includes(ql));
  const toggle = (id) => setSel((s) => { const n = new Set(s); n.has(id) ? n.delete(id) : n.add(id); return n; });
  const allShown = filtered.length > 0 && filtered.every((r) => sel.has(r.run.id));
  const toggleAll = () => setSel((s) => { const n = new Set(s); filtered.forEach((r) => allShown ? n.delete(r.run.id) : n.add(r.run.id)); return n; });
  const doImport = () => onImport((quotes || []).filter((run) => sel.has(run.id)));
  return (
    <div onClick={onClose} style={{ position: "fixed", inset: 0, background: "rgba(20,22,26,.45)", zIndex: 50, display: "flex", alignItems: "center", justifyContent: "center", padding: 24 }}>
      <div className="card" onClick={(e) => e.stopPropagation()} style={{ width: "min(740px, 96vw)", maxHeight: "82vh", display: "flex", flexDirection: "column", overflow: "hidden" }}>
        <div style={{ padding: "12px 16px", borderBottom: "1px solid var(--line)", display: "flex", alignItems: "center", gap: 12 }}>
          <span className="eyebrow">Import runs from quoting</span>
          <input className="inp" placeholder="Search name or client…" value={q} onChange={(e) => setQ(e.target.value)} style={{ width: 220, marginLeft: "auto" }} />
          <button className="btn-x" onClick={onClose} title="Close"><Cross /></button>
        </div>
        <div style={{ overflowY: "auto", flex: 1 }}>
          {quotes === null ? <div style={{ padding: 24, color: "var(--muted)", fontSize: 13 }}>Loading quotes…</div>
            : rows.length === 0 ? <div style={{ padding: 24, color: "var(--muted)", fontSize: 13 }}>No quotes found in Run Quoting yet.</div>
            : (
              <table style={{ width: "100%", borderCollapse: "collapse", fontSize: 13 }}>
                <thead><tr>
                  <th style={{ padding: "6px 10px", textAlign: "left" }}><input type="checkbox" checked={allShown} onChange={toggleAll} title="Select all shown" /></th>
                  {["Run", "Client", "Cases", "Quote", "Tolling (margin)"].map((h, i) => (<th key={i} className="th" style={{ textAlign: i >= 2 ? "right" : "left", padding: "6px 10px", fontWeight: 600 }}>{h}</th>))}
                </tr></thead>
                <tbody>
                  {filtered.map(({ run, cases, total, tolling }) => {
                    const on = sel.has(run.id);
                    return (
                      <tr key={run.id} className="evrow" style={{ cursor: "pointer", background: on ? "#F1EFE7" : "transparent" }} onClick={() => toggle(run.id)}>
                        <td style={{ padding: "5px 10px" }}><input type="checkbox" checked={on} onChange={() => toggle(run.id)} onClick={(e) => e.stopPropagation()} /></td>
                        <td style={{ padding: "5px 10px" }}>{run.name || "(unnamed)"} {existingIds.has(String(run.id)) && <span className="tag" style={{ color: "#5a5f66", background: "var(--chip)" }}>on board</span>}</td>
                        <td style={{ padding: "5px 10px", color: "var(--muted)" }}>{run.client || "—"}</td>
                        <td className="num" style={{ padding: "5px 10px", textAlign: "right" }}>{cases ? cases.toLocaleString() : "—"}</td>
                        <td className="num" style={{ padding: "5px 10px", textAlign: "right" }}>{fmt(total)}</td>
                        <td className="num" style={{ padding: "5px 10px", textAlign: "right", color: "var(--in)" }}>{fmt(tolling)}</td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            )}
        </div>
        <div style={{ padding: "10px 16px", borderTop: "1px solid var(--line)", display: "flex", alignItems: "center", gap: 10 }}>
          <span style={{ fontSize: 12, color: "var(--muted)" }}>{sel.size} selected</span>
          <div style={{ flex: 1 }} />
          <button className="btn" onClick={onClose}>Cancel</button>
          <button className="btn" disabled={sel.size === 0} onClick={doImport} style={{ fontWeight: 600, opacity: sel.size === 0 ? 0.5 : 1 }}>Import {sel.size || ""} run{sel.size === 1 ? "" : "s"}</button>
        </div>
      </div>
    </div>
  );
}
