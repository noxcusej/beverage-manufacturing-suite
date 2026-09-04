// Cash flow by sprint — the shared statement (planner + spreadsheet). Same column grid
// as the planner (RAIL_W label column, COL_W per sprint) so columns line up vertically.
// Any sprint can be split into its two weeks. Cells carry hover breakdowns.
import React, { useState } from "react";
import { fmtMD } from "../model/sprints.js";
import { NumberInput, fmt, fmtK } from "./ui.jsx";

export const RAIL_W = 188;
export const COL_W = 108;          // one sprint column (planner uses the same)
const TOTW = COL_W + 20;

const money = (v) => (v < 0 ? "−" : "") + fmt(Math.abs(v));
const line = (label, mag, sign) => "  " + label + "   " + (sign < 0 ? "−" : "+") + fmt(Math.abs(mag));

/**
 * props: result (engine Result), floor, openingCash, manualAdj, setAdj(k, v), origin, expandedSprints (Set of i), toggleSprint(i),
 *        showCategories (bool), scrollRef, onScrollSync, note
 */
export function CashFlowTable({ result, floor, openingCash, manualAdj, setAdj, expandedSprints, toggleSprint, showCategories = false, scrollRef, onScrollSync, note }) {
  const { cols, rows, weekly, breakdown, materialsByCategory, origin, horizon } = result;
  const [catsOpen, setCatsOpen] = useState(showCategories);
  const posStyle = (v) => (v < 0 ? { color: "var(--danger)" } : v < floor ? { color: "#7c5e00", background: "#FDE047" } : { color: "var(--pos)" });

  // column plan: each sprint is 1 column, or 2 week sub-columns when expanded
  const plan = [];
  for (let i = 0; i < horizon; i++) {
    if (expandedSprints && expandedSprints.has(i)) { plan.push({ i, w: 0 }); plan.push({ i, w: 1 }); } else plan.push({ i, w: null });
  }
  const cell = (arr, warr, p) => (p.w == null ? arr[p.i] : warr[2 * p.i + p.w]);

  const rowDefs = [
    { key: "clientIn", label: "Client payments", sign: 1, tone: "var(--in)" },
    { key: "capitalIn", label: "Capital in", sign: 1, tone: "var(--cap)" },
    { key: "materials", label: "Materials", sign: -1, tone: "var(--out)", cats: true },
    { key: "taxes", label: "Taxes & regulatory", sign: -1, tone: "var(--out)" },
    { key: "burn", label: "Burn", sign: -1, tone: "var(--fixed)" },
    { key: "bills", label: "Bills", sign: -1, tone: "var(--ap)", sub: "Xero AP" },
  ];
  const catRows = [
    { key: "hard", label: "· hard goods" }, { key: "soft", label: "· soft goods" }, { key: "outsourced", label: "· outsourced" },
  ];

  const tipFor = (def, p, val) => {
    const items = (breakdown[def.key] && breakdown[def.key][p.i]) || [];
    if (!items.length) return undefined;
    const head = def.label + " · " + (def.sign < 0 ? "−" : "") + fmtK(Math.abs(val)) + "  ·  Sprint " + cols[p.i].ordinal + " (" + cols[p.i].range + ")" + (p.w != null ? " · week " + (p.w + 1) : "");
    return head + "\n" + items.map((it) => line(it.label, it.amount, def.sign)).join("\n");
  };
  const netTip = (p) => {
    const g = (k) => cell(rows[k], weekly[k], p);
    const c = [];
    const add = (label, mag, sign) => { if (mag) c.push(line(label, mag, sign)); };
    add("Client payments", g("clientIn"), 1); add("Capital in", g("capitalIn"), 1); add("Materials", g("materials"), -1); add("Taxes", g("taxes"), -1); add("Burn", g("burn"), -1); add("Bills", g("bills"), -1);
    const a = g("adjust"); if (a) c.push(line("Manual adjustment", Math.abs(a), a < 0 ? -1 : 1));
    return "Net change · Sprint " + cols[p.i].ordinal + " (" + cols[p.i].range + ")\n" + (c.join("\n") || "  (no activity)") + "\n  = " + money(g("net"));
  };
  const closeTip = (p) => {
    const idx = p.w == null ? p.i : 2 * p.i + p.w;
    const arr = p.w == null ? rows.closing : weekly.closing;
    const netArr = p.w == null ? rows.net : weekly.net;
    const prev = idx === 0 ? openingCash : arr[idx - 1];
    return "Closing position · Sprint " + cols[p.i].ordinal + "\n  " + (idx === 0 ? "Opening cash" : "Prev close") + "   " + money(prev) + "\n  Net change   " + money(netArr[idx]) + "\n  = " + money(arr[idx]);
  };

  const stickyL = { width: RAIL_W, minWidth: RAIL_W, maxWidth: RAIL_W, position: "sticky", left: 0, background: "#FBFAF6", zIndex: 1, borderRight: "1px solid var(--line)", padding: "5px 10px", whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis", textAlign: "left" };
  const stickyH = { ...stickyL, background: "#F1EFE7", zIndex: 2, padding: "6px 10px" };
  const totalW = RAIL_W + plan.reduce((s, p) => s + (p.w == null ? COL_W : COL_W / 2), 0) + TOTW;
  let tI = 0, t = rows.closing.length ? rows.closing[0] : openingCash;
  rows.closing.forEach((v, i) => { if (v < t) { t = v; tI = i; } });
  const ending = rows.closing[horizon - 1] ?? openingCash;
  const sum = (a) => a.reduce((s, v) => s + v, 0);

  const dataCell = (val, style, title, key) => (
    <td key={key} title={title} style={{ padding: "4px 6px", textAlign: "right", cursor: title ? "help" : "default", ...style }}>{val}</td>
  );

  return (
    <div className="card" style={{ overflow: "hidden" }}>
      <div style={{ padding: "10px 14px", borderBottom: "1px solid var(--line)", display: "flex", alignItems: "center", gap: 12, flexWrap: "wrap" }}>
        <span className="eyebrow">Cash flow by sprint</span>
        <span style={{ fontSize: 11.5, color: "var(--muted)" }}>click a sprint header to split it into its two weeks · hover any value for its line items</span>
        <span className="num" style={{ marginLeft: "auto", fontSize: 11.5, color: "var(--muted)" }}>ending {fmt(ending)} · lowest {fmt(t)} in Sprint {cols[tI] ? cols[tI].ordinal : "–"}</span>
      </div>
      <div ref={scrollRef} onScroll={onScrollSync} style={{ overflowX: "auto" }}>
        <table style={{ borderCollapse: "collapse", fontSize: 11.5, tableLayout: "fixed", width: totalW }} className="num">
          <colgroup>
            <col style={{ width: RAIL_W }} />
            {plan.map((p, j) => (<col key={j} style={{ width: p.w == null ? COL_W : COL_W / 2 }} />))}
            <col style={{ width: TOTW }} />
          </colgroup>
          <thead>
            <tr>
              <th style={{ ...stickyH, fontWeight: 600 }} className="th">Sprint beginning</th>
              {plan.map((p, j) => {
                const c = cols[p.i];
                const split = p.w != null;
                return (
                  <th key={j} className="th" onClick={() => toggleSprint && toggleSprint(p.i)} title={"Sprint " + c.ordinal + " · " + c.range + (split ? "  ·  click to merge weeks" : "  ·  click to split into weeks")}
                    style={{ padding: "5px 6px", textAlign: "right", fontWeight: 600, cursor: "pointer", background: split ? "#ECE9DF" : undefined, borderLeft: split && p.w === 0 ? "1px solid var(--line2)" : undefined }}>
                    {split ? <span style={{ fontSize: 10 }}>{p.w === 0 ? "wk 1" : "wk 2"}</span> : (<><div style={{ fontSize: 9, letterSpacing: ".08em", color: "var(--muted)" }}>S{c.ordinal}</div><div>{fmtMD(c.start)}</div></>)}
                  </th>
                );
              })}
              <th className="th" style={{ padding: "6px 10px", textAlign: "right", fontWeight: 700, borderLeft: "1px solid var(--line)" }}>Total</th>
            </tr>
          </thead>
          <tbody>
            {rowDefs.map((def) => {
              const arr = rows[def.key], warr = weekly[def.key];
              const tot = sum(arr) * def.sign;
              return (
                <React.Fragment key={def.key}>
                  <tr>
                    <td style={{ ...stickyL, color: def.tone, fontWeight: 600, cursor: def.cats ? "pointer" : "default" }} onClick={def.cats ? () => setCatsOpen((o) => !o) : undefined} title={def.cats ? "click to show hard / soft / outsourced" : undefined}>
                      {def.cats ? (catsOpen ? "▾ " : "▸ ") : ""}{def.label}{def.sub ? <span style={{ fontWeight: 400, color: "var(--muted)", fontSize: 10.5 }}> {def.sub}</span> : null}
                    </td>
                    {plan.map((p, j) => { const v = cell(arr, warr, p) * def.sign; return dataCell(v === 0 ? "·" : fmtK(v), { color: v === 0 ? "#cfcabb" : def.tone }, tipFor(def, p, v), j); })}
                    <td style={{ padding: "4px 10px", textAlign: "right", fontWeight: 700, color: def.tone, borderLeft: "1px solid var(--line)" }}>{fmtK(tot)}</td>
                  </tr>
                  {def.cats && catsOpen && catRows.map((cr) => {
                    const carr = materialsByCategory[cr.key] || [];
                    return (
                      <tr key={cr.key}>
                        <td style={{ ...stickyL, color: "var(--muted)", paddingLeft: 22 }}>{cr.label}</td>
                        {plan.map((p, j) => { const v = p.w == null ? -(carr[p.i] || 0) : 0; return dataCell(p.w != null ? "" : v === 0 ? "·" : fmtK(v), { color: v === 0 ? "#cfcabb" : "var(--out)" }, undefined, j); })}
                        <td style={{ padding: "4px 10px", textAlign: "right", color: "var(--muted)", borderLeft: "1px solid var(--line)" }}>{fmtK(-sum(carr))}</td>
                      </tr>
                    );
                  })}
                </React.Fragment>
              );
            })}
            {/* manual adjustment — editable, keyed by ABSOLUTE sprint */}
            <tr>
              <td style={{ ...stickyL, color: "var(--out)", fontWeight: 600 }} title="Unplanned one-off per sprint. Positive adds cash, negative is an expense.">Manual adjustment</td>
              {plan.map((p, j) => {
                const k = String(origin + p.i);
                const v = Number(manualAdj?.[k]) || 0;
                if (p.w != null) return <td key={j} style={{ padding: "2px 3px", textAlign: "right", color: "#cfcabb" }}>{p.w === 0 && v ? fmtK(v) : "·"}</td>;
                return (
                  <td key={j} style={{ padding: "2px 3px", textAlign: "right" }}>
                    {setAdj ? <NumberInput value={v || ""} onChange={(nv) => setAdj(k, nv)} emptyValue={0} placeholder="·" className="inp num sm" style={{ width: "100%", textAlign: "right", color: v > 0 ? "var(--in)" : v < 0 ? "var(--out)" : "var(--ink)" }} />
                      : <span style={{ color: v === 0 ? "#cfcabb" : v > 0 ? "var(--in)" : "var(--out)" }}>{v === 0 ? "·" : fmtK(v)}</span>}
                  </td>
                );
              })}
              <td style={{ padding: "4px 10px", textAlign: "right", fontWeight: 700, color: "var(--muted)", borderLeft: "1px solid var(--line)" }}>{sum(rows.adjust) === 0 ? "·" : fmtK(sum(rows.adjust))}</td>
            </tr>
            <tr>
              <td style={{ ...stickyL, fontWeight: 700, borderTop: "1px solid var(--line)" }}>Net change</td>
              {plan.map((p, j) => { const v = cell(rows.net, weekly.net, p); return dataCell(v === 0 ? "·" : fmtK(v), { borderTop: "1px solid var(--line)", color: v === 0 ? "#cfcabb" : v > 0 ? "var(--in)" : "var(--out)" }, netTip(p), j); })}
              <td style={{ padding: "4px 10px", textAlign: "right", fontWeight: 700, borderTop: "1px solid var(--line)", borderLeft: "1px solid var(--line)" }}>{fmtK(sum(rows.net))}</td>
            </tr>
            <tr>
              <td style={{ ...stickyL, fontWeight: 700 }}>Closing position</td>
              {plan.map((p, j) => { const v = cell(rows.closing, weekly.closing, p); return dataCell(fmtK(v), { fontWeight: 600, ...posStyle(v) }, closeTip(p), j); })}
              <td style={{ padding: "4px 10px", textAlign: "right", fontWeight: 700, borderLeft: "1px solid var(--line)", ...posStyle(ending) }}>{fmtK(ending)}</td>
            </tr>
          </tbody>
        </table>
      </div>
      <div style={{ padding: "8px 14px", borderTop: "1px solid var(--line)", fontSize: 11.5, color: "var(--muted)" }}>
        {note || <>Opening cash {fmt(openingCash)} · <span style={{ color: "var(--danger)", fontWeight: 600 }}>red</span> closing = below $0 · <span style={{ background: "#FDE047", color: "#7c5e00", fontWeight: 600, padding: "0 4px", borderRadius: 3 }}>yellow</span> = between $0 and the {fmt(floor)} floor · materials show in the sprint they are <b>ordered</b>.</>}
      </div>
    </div>
  );
}
