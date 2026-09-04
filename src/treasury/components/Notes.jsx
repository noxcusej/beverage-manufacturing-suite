// Free-text notes for the ACTIVE scenario — assumptions, what changed, what to revisit.
// Saved with the scenario. Ported from v1 (card + full-screen editor).
import React, { useEffect, useState } from "react";
import { Cross } from "./ui.jsx";

export function NotesCard({ activeName, notes, setNotes }) {
  const [full, setFull] = useState(false);
  useEffect(() => {
    if (!full) return;
    const onKey = (e) => { if (e.key === "Escape") setFull(false); };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [full]);
  const ta = { font: "inherit", color: "var(--ink)", background: "#fff", width: "100%", boxSizing: "border-box" };
  return (
    <>
      <div className="card" style={{ marginTop: 12, padding: "10px 14px" }}>
        <div style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: 6 }}>
          <span className="eyebrow">Notes</span>
          <span style={{ fontSize: 11.5, color: "var(--muted)" }}>for <strong style={{ color: "var(--ink)" }}>{activeName}</strong> · saved with the scenario</span>
          <div style={{ flex: 1 }} />
          <button className="btn-x" title="Expand notes to full screen" onClick={() => setFull(true)}>⤢ Expand</button>
        </div>
        <textarea value={notes} onChange={(e) => setNotes(e.target.value)} rows={2} placeholder="What this scenario assumes, what you changed, what to revisit…"
          style={{ ...ta, resize: "vertical", minHeight: 42, fontSize: 12.5, lineHeight: 1.5, padding: "7px 9px", border: "1px solid var(--line)", borderRadius: 7 }} />
      </div>
      {full && (
        <div onClick={() => setFull(false)} style={{ position: "fixed", inset: 0, background: "rgba(20,22,26,.45)", zIndex: 60, display: "flex", alignItems: "center", justifyContent: "center", padding: 24 }}>
          <div className="card" onClick={(e) => e.stopPropagation()} style={{ width: "min(1040px, 96vw)", height: "88vh", display: "flex", flexDirection: "column", overflow: "hidden" }}>
            <div style={{ padding: "12px 16px", borderBottom: "1px solid var(--line)", display: "flex", alignItems: "center", gap: 12 }}>
              <span className="eyebrow">Notes</span>
              <span style={{ fontSize: 11.5, color: "var(--muted)" }}>for <strong style={{ color: "var(--ink)" }}>{activeName}</strong> · saved with the scenario</span>
              <div style={{ flex: 1 }} />
              <span style={{ fontSize: 11.5, color: "var(--muted)" }}>Esc to close</span>
              <button className="btn-x" title="Close" onClick={() => setFull(false)}><Cross /></button>
            </div>
            <textarea autoFocus value={notes} onChange={(e) => setNotes(e.target.value)} placeholder="What this scenario assumes, what you changed, what to revisit…"
              style={{ ...ta, flex: 1, resize: "none", border: "none", outline: "none", fontSize: 14, lineHeight: 1.65, padding: "16px 18px" }} />
          </div>
        </div>
      )}
    </>
  );
}
