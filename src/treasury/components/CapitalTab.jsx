// Capital — injections only (equity / debt draws IN). Debt SERVICING lives in Burn.
import React from "react";
import { sprintIndex, parseLocalDate, isoLocal, addDays } from "../model/sprints.js";
import { NumberInput, Stat, fmt, Cross } from "./ui.jsx";

/** Shared editor (used by the Capital tab and the inline Financing panel on the planner).
 *  props: capital, setCapital, epoch, origin, horizon, today (ISO), newId, droppedIds? (Set of ids the engine did not count) */
export function CapitalEditor({ capital, setCapital, epoch, origin, horizon, today, newId }) {
  const setC = (id, k, val) => setCapital((xs) => xs.map((x) => (x.id === id ? { ...x, [k]: val } : x)));
  const del = (id) => setCapital((xs) => xs.filter((x) => x.id !== id));
  const in4w = isoLocal(addDays(parseLocalDate(today), 28));
  const addEquity = () => setCapital((xs) => [...xs, { id: newId("cap"), type: "equity", label: "Equity raise", amount: 250000, date: in4w }]);
  const addDebt = () => setCapital((xs) => [...xs, { id: newId("cap"), type: "debt", label: "Term loan draw", amount: 250000, date: in4w }]);
  return (
    <div style={{ overflowX: "auto" }}>
      <table style={{ width: "100%", borderCollapse: "collapse", minWidth: 640 }}>
        <thead><tr>{["Source", "Type", "Amount", "Funding date", ""].map((h, i) => (<th key={i} className="th" style={{ textAlign: i === 2 ? "right" : "left", padding: "0 6px 8px", fontWeight: 600 }}>{h}</th>))}</tr></thead>
        <tbody>
          {capital.length === 0 && (<tr><td colSpan={5} style={{ padding: "10px 6px", color: "var(--muted)", fontSize: 12.5 }}>No financing yet — add an equity injection or debt draw below.</td></tr>)}
          {capital.map((c) => {
            const k = sprintIndex(c.date, epoch);
            const past = k != null && k < origin, future = k != null && k >= origin + horizon;
            const warn = past ? "This " + c.type + " is dated before the chart start (today's sprint) — it is NOT counted in the cash position. Set the date to today or later."
              : future ? "This " + c.type + " is dated after the chart window ends — it is NOT counted in the cash position." : null;
            return (
              <tr key={c.id} className="evrow">
                <td><input className="inp" style={{ minWidth: 170 }} value={c.label} onChange={(e) => setC(c.id, "label", e.target.value)} /></td>
                <td><select className="sel" value={c.type} onChange={(e) => setC(c.id, "type", e.target.value)}><option value="equity">Equity</option><option value="debt">Debt draw</option></select></td>
                <td style={{ textAlign: "right" }}><NumberInput value={c.amount} onChange={(v) => setC(c.id, "amount", v)} className="inp num" style={{ width: 120, textAlign: "right" }} /></td>
                <td>
                  <input className="inp num" style={{ width: 144, borderColor: warn ? "var(--danger)" : undefined }} type="date" value={c.date} onChange={(e) => setC(c.id, "date", e.target.value)} />
                  {warn && <div title={warn} style={{ color: "var(--danger)", fontSize: 9.5, fontWeight: 700, marginTop: 2, cursor: "help" }}>{past ? "◀ before start — not counted" : "▶ after end — not counted"}</div>}
                </td>
                <td><button className="btn-x" onClick={() => del(c.id)}><Cross /></button></td>
              </tr>
            );
          })}
        </tbody>
      </table>
      <div style={{ display: "flex", gap: 8, marginTop: 12 }}>
        <button className="btn" onClick={addEquity}>+ Equity injection</button>
        <button className="btn" onClick={addDebt}>+ Debt draw</button>
      </div>
    </div>
  );
}

export function CapitalTab({ capital, setCapital, epoch, origin, horizon, today, newId, totalIn, strip }) {
  const equityIn = capital.filter((c) => c.type === "equity").reduce((s, c) => s + (Number(c.amount) || 0), 0);
  const debtIn = capital.filter((c) => c.type === "debt").reduce((s, c) => s + (Number(c.amount) || 0), 0);
  return (
    <>
      <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit,minmax(150px,1fr))", gap: 10, marginTop: 18 }}>
        <Stat label="Equity in" value={fmt(equityIn)} tone="in" />
        <Stat label="Debt drawn" value={fmt(debtIn)} tone="cap" />
        <Stat label="Capital in (window)" value={fmt(totalIn)} tone="cap" sub="lands within the chart horizon" />
      </div>
      {strip}
      <div className="card" style={{ marginTop: 14, padding: 16 }}>
        <CapitalEditor {...{ capital, setCapital, epoch, origin, horizon, today, newId }} />
      </div>
      <div style={{ fontSize: 11.5, color: "var(--muted)", marginTop: 16, lineHeight: 1.6 }}>
        Each source adds cash on its <b>funding date</b> and lifts the position there. Loan <b>servicing</b> (principal + interest) is entered once on the <b>Burn</b> tab under Debt service, so nothing is counted twice.
      </div>
    </>
  );
}
