/* eslint-disable react-refresh/only-export-components -- shared helpers live beside the components that use them */
// Small shared UI pieces for Treasury Cockpit v2 — ported from v1 so the look and
// input behavior are identical (buffered NumberInput that commits on blur, etc.).
import React, { useState } from "react";

export const fmt = (n) => { const s = n < 0 ? "-" : ""; return s + "$" + Math.abs(Math.round(n || 0)).toLocaleString(); };
export const fmtK = (n) => { const a = Math.abs(n || 0), s = n < 0 ? "-" : ""; if (a >= 1000) return s + "$" + (a / 1000).toFixed(a >= 10000 ? 0 : 1) + "k"; return s + "$" + Math.round(a); };
export function hexA(hex, a) { const h = (hex || "#888888").replace("#", ""); return "rgba(" + parseInt(h.slice(0, 2), 16) + "," + parseInt(h.slice(2, 4), 16) + "," + parseInt(h.slice(4, 6), 16) + "," + a + ")"; }
export const toneColor = (t) => t === "in" ? "var(--in)" : t === "out" ? "var(--out)" : t === "fixed" ? "var(--fixed)" : t === "ap" ? "var(--ap)" : t === "cap" ? "var(--cap)" : t === "danger" ? "var(--danger)" : "var(--ink)";

/* Buffered numeric input: keeps the raw text while typing, commits a clamped number on blur;
   ArrowUp/Down nudge by `step`. Identical to v1 (fixes "fields don't overwrite" bugs). */
export function NumberInput({ value, onChange, min, max, step = 1, integer = false, emptyValue, className = "inp num", style, placeholder, title, disabled = false }) {
  const [buf, setBuf] = useState(null);
  const empty = emptyValue !== undefined ? emptyValue : (min != null ? min : 0);
  const re = integer ? /^-?\d*$/ : /^-?\d*\.?\d*$/;
  const ext = value === "" || value === null || value === undefined ? "" : String(value);
  const shown = buf !== null ? buf : ext;
  const partial = (s) => s === "" || s === "-" || s === "." || s === "-.";
  const emit = (raw) => { if (partial(raw)) { onChange(empty); return; } const n = Number(raw); onChange(Number.isFinite(n) ? n : empty); };
  const onChangeRaw = (e) => { const raw = e.target.value; if (!re.test(raw)) return; setBuf(raw); emit(raw); };
  const onBlur = () => {
    const raw = buf; setBuf(null);
    if (raw === null) return;
    if (partial(raw)) { onChange(empty); return; }
    let n = Number(raw);
    if (!Number.isFinite(n)) { onChange(empty); return; }
    if (integer) n = Math.trunc(n);
    if (min != null && n < min) n = min;
    if (max != null && n > max) n = max;
    onChange(n);
  };
  const onKeyDown = (e) => {
    if (e.key !== "ArrowUp" && e.key !== "ArrowDown") return;
    e.preventDefault();
    const cur = Number(buf !== null ? buf : value);
    let n = (Number.isFinite(cur) ? cur : empty) + (e.key === "ArrowUp" ? step : -step);
    if (integer) n = Math.round(n);
    if (min != null && n < min) n = min;
    if (max != null && n > max) n = max;
    setBuf(String(n)); onChange(n);
  };
  return (<input type="text" inputMode={integer ? "numeric" : "decimal"} className={className} style={style} disabled={disabled}
    placeholder={placeholder} title={title} value={shown} onChange={onChangeRaw} onBlur={onBlur} onKeyDown={onKeyDown} />);
}

export function Field({ label, value, onChange, hint }) {
  return (<label className="card" style={{ padding: "7px 11px", display: "block" }}>
    <div className="eyebrow">{label}{hint ? <span style={{ textTransform: "none", letterSpacing: 0, fontWeight: 400 }}> · {hint}</span> : null}</div>
    <div style={{ display: "flex", alignItems: "center", gap: 2, marginTop: 2 }}><span style={{ color: "var(--muted)" }}>$</span><NumberInput value={value} onChange={onChange} className="num" style={{ border: "none", outline: "none", width: 92, fontSize: 16, fontWeight: 600, background: "transparent", color: "var(--ink)" }} /></div>
  </label>);
}

export function Stat({ label, value, sub, tone = "ink" }) {
  return (<div className="card" style={{ padding: "11px 13px" }}><div className="eyebrow">{label}</div><div className="num" style={{ fontSize: 19, fontWeight: 700, color: toneColor(tone), marginTop: 3 }}>{value}</div>{sub && <div style={{ fontSize: 11, color: "var(--muted)", marginTop: 2 }}>{sub}</div>}</div>);
}

export function StatusTag({ status }) {
  const map = { DRAFT: ["#6b7177", "#eceae3"], SUBMITTED: ["#7a5d2e", "#f3ead6"], AUTHORISED: ["#1f5e54", "#dcefe9"], PAID: ["#2f6b3a", "#dff0e2"], VOIDED: ["#8a3a2e", "#f4ddd6"] };
  const [c, bg] = map[status] || map.DRAFT;
  return <span className="tag" style={{ color: c, background: bg }}>{status}</span>;
}

export function Tag({ children, tone = "muted", title }) {
  const m = { muted: ["#5a5f66", "var(--chip)"], in: ["#1f5e54", "#dcefe9"], out: ["#8f3322", "#f4ddd6"], warn: ["#7a5d2e", "#f3ead6"], cap: ["#4b3f66", "#e8e2f2"] };
  const [c, bg] = m[tone] || m.muted;
  return <span className="tag" title={title} style={{ color: c, background: bg }}>{children}</span>;
}

/* icons — inline SVG, stroke inherits color */
export function EyeOn() { return (<svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d="M1 12s4-7 11-7 11 7 11 7-4 7-11 7-11-7-11-7z" /><circle cx="12" cy="12" r="3" /></svg>); }
export function EyeOff() { return (<svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d="M17.94 17.94A10.07 10.07 0 0 1 12 20c-7 0-11-8-11-8a18.45 18.45 0 0 1 5.06-5.94M9.9 4.24A9.12 9.12 0 0 1 12 4c7 0 11 8 11 8a18.5 18.5 0 0 1-2.16 3.19m-6.72-1.07a3 3 0 1 1-4.24-4.24" /><line x1="1" y1="1" x2="23" y2="23" /></svg>); }
export function Chevron({ open, size = 12, color = "currentColor" }) { return (<svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke={color} strokeWidth="3" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">{open ? <path d="M6 9l6 6 6-6" /> : <path d="M9 6l6 6-6 6" />}</svg>); }
export function Grip() { return (<svg width="12" height="12" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true"><circle cx="8" cy="5" r="2" /><circle cx="16" cy="5" r="2" /><circle cx="8" cy="12" r="2" /><circle cx="16" cy="12" r="2" /><circle cx="8" cy="19" r="2" /><circle cx="16" cy="19" r="2" /></svg>); }
export function Diamond({ color = "var(--out)", size = 12 }) { return (<svg width={size} height={size} viewBox="0 0 14 14" aria-hidden="true"><path d="M7 1 L13 7 L7 13 L1 7 Z" fill={color} /></svg>); }
export function Tri({ color = "var(--in)", size = 12 }) { return (<svg width={size} height={size} viewBox="0 0 14 14" aria-hidden="true"><path d="M7 2 L13 12 L1 12 Z" fill={color} /></svg>); }
export function Check({ color = "var(--in)", size = 12 }) { return (<svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke={color} strokeWidth="3" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d="M5 13l4 4L19 7" /></svg>); }
export function Warn({ color = "var(--danger)", size = 12 }) { return (<svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke={color} strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d="M12 9v4M12 17h.01M10.3 3.9 1.8 18a2 2 0 0 0 1.7 3h17a2 2 0 0 0 1.7-3L13.7 3.9a2 2 0 0 0-3.4 0z" /></svg>); }
export function Cross({ size = 12 }) { return (<svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" aria-hidden="true"><path d="M6 6l12 12M18 6L6 18" /></svg>); }

/* the cockpit's stylesheet, scoped under .tcockpit (same tokens as v1) */
export const COCKPIT_CSS = `
.tcockpit{--canvas:#F4F2EC;--panel:#FFFFFF;--ink:#1B1F24;--muted:#727880;--line:#E4E0D6;--line2:#EDEAE2;--in:#1F7A6B;--out:#B14A3B;--pos:#34468A;--danger:#C0392B;--warn:#B7791F;--chip:#F0EDE4;--fixed:#9A6B5E;--ap:#5F6B78;--cap:#6D5B8A;width:100%;min-height:100vh;font-family:ui-sans-serif,system-ui,-apple-system,Segoe UI,Roboto,sans-serif;font-size:13px}
.tcockpit *{box-sizing:border-box}
.tcockpit .num{font-variant-numeric:tabular-nums;font-feature-settings:"tnum";font-family:ui-monospace,SFMono-Regular,Menlo,Consolas,monospace}
.tcockpit .eyebrow{letter-spacing:.14em;text-transform:uppercase;font-size:10px;color:var(--muted);font-weight:600}
.tcockpit .card{background:var(--panel);border:1px solid var(--line);border-radius:10px}
.tcockpit .btn{border:1px solid var(--line);background:var(--panel);border-radius:8px;padding:6px 11px;font-size:13px;cursor:pointer;color:var(--ink);transition:background .12s,border-color .12s;display:inline-flex;align-items:center;gap:6px}
.tcockpit .btn:hover{background:var(--chip);border-color:#d8d3c6}
.tcockpit .btn:disabled{cursor:default}
.tcockpit .btn-x{border:none;background:transparent;color:var(--muted);cursor:pointer;padding:2px 6px;border-radius:6px}
.tcockpit .btn-x:hover{background:var(--chip);color:var(--danger)}
.tcockpit .inp{border:1px solid var(--line);border-radius:7px;padding:5px 8px;font-size:13px;background:#fff;width:100%;color:var(--ink)}
.tcockpit .inp:focus{outline:2px solid rgba(52,70,138,.25);border-color:#b9c0d8}
.tcockpit .inp.sm{padding:2px 6px;font-size:11.5px;border-radius:6px}
.tcockpit .sel{border:1px solid var(--line);border-radius:7px;padding:5px 6px;font-size:13px;background:#fff;color:var(--ink)}
.tcockpit .th{font-size:11px;color:var(--muted);font-weight:600}
.tcockpit tr.evrow td{padding:4px 6px;border-top:1px solid var(--line2);vertical-align:middle}
.tcockpit .tabbar{display:inline-flex;background:var(--chip);border:1px solid var(--line);border-radius:9px;padding:3px}
.tcockpit .tabbtn{border:none;background:transparent;padding:6px 14px;border-radius:7px;font-size:13px;font-weight:600;color:var(--muted);cursor:pointer}
.tcockpit .tabbtn.on{background:#fff;color:var(--ink);box-shadow:0 1px 2px rgba(0,0,0,.06)}
.tcockpit .tag{display:inline-block;font-size:9.5px;padding:1px 6px;border-radius:5px;font-weight:700;letter-spacing:.03em}
.tcockpit .barlabel{font-size:12px;font-weight:600;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.tcockpit .gridline{position:absolute;top:0;bottom:0;width:1px;background:var(--line2)}
.tcockpit .handle{position:absolute;top:0;bottom:0;width:8px;cursor:ew-resize}
.tcockpit .late{color:var(--danger);font-size:9.5px;font-weight:700;margin-left:5px}
.tcockpit .rowhover:hover{background:#FBFAF6}
`;
