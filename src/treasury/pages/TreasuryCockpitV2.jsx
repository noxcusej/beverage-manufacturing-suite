// Treasury Cockpit v2 — sprint-based cash planner. Composition + persistence +
// cross-window coordination only; every number comes from model/engine.js.
//
// Persistence (CONTRACT §7): v2 reads/writes ONLY app_data key `treasury_cockpit_v3`.
// The v1 key `treasury_cockpit` is read once, read-only, to migrate an existing plan
// when no v3 store exists yet; v1 keeps working untouched on that key.
import React, { useState, useMemo, useRef, useCallback, useEffect } from "react";
import { loadAppData, saveAppData } from "../../data/supabase";
import { computeRunResults } from "../../utils/runResults";
import { DEFAULT_EPOCH, sprintOfToday, isoLocal, parseLocalDate, addDays, fmtMD } from "../model/sprints.js";
import { computeCash, billPayDate } from "../model/engine.js";
import { STORE_KEY, LEGACY_KEY, newId, canon, storeSig, isV3, migrateLegacyToV3, normalizeStore, mergeScenarios, emptyScenarioState, newScenario, DEFAULT_HORIZON_SPRINTS } from "../model/store.js";
import { newRun, quoteToRun, applySuiteCosts, PALETTE } from "../model/runs.js";
import { monthlyTotal } from "../model/burn.js";
import { COCKPIT_CSS, fmt, fmtK, NumberInput, Stat, Chevron, Cross } from "../components/ui.jsx";
import { ScenarioPicker, QuotePicker } from "../components/Pickers.jsx";
import { Planner } from "../components/Planner.jsx";
import { RunDetail } from "../components/RunDetail.jsx";
import { CashFlowTable } from "../components/CashFlowTable.jsx";
import { OrderAheadTab } from "../components/OrderAheadTab.jsx";
import { BurnTab } from "../components/BurnTab.jsx";
import { APTab } from "../components/APTab.jsx";
import { CapitalTab, CapitalEditor } from "../components/CapitalTab.jsx";
import { NotesCard } from "../components/Notes.jsx";

const SYNC_CHANNEL = "treasury_cockpit_v3_sync";
const TABS = [["plan", "Run planner"], ["order", "Materials to order"], ["burn", "Burn"], ["ap", "Accounts payable"], ["capital", "Capital"]];

/* view-only fields (which tab is open, which run is selected) are persisted for convenience
   but must not count as "unsaved changes" */
const stripView = (st) => { if (!st) return st; const { tab, selId, ...rest } = st; void tab; void selId; return rest; };
const sigOf = (store) => storeSig({ ...store, scenarios: (store.scenarios || []).map((s) => ({ ...s, state: stripView(s.state) })) });
const sameState = (a, b) => JSON.stringify(canon(stripView(a))) === JSON.stringify(canon(stripView(b)));

export default function TreasuryCockpitV2() {
  const TODAY = useMemo(() => isoLocal(new Date()), []);
  const winId = useMemo(() => newId("win"), []);

  /* ---- live state of the ACTIVE scenario ---- */
  const [epoch, setEpoch] = useState(DEFAULT_EPOCH);
  const [horizonSprints, setHorizonSprints] = useState(DEFAULT_HORIZON_SPRINTS);
  const [openingCash, setOpeningCash] = useState(60000);
  const [floor, setFloor] = useState(25000);
  const [runs, setRuns] = useState([]);
  const [burn, setBurn] = useState([]);
  const [capital, setCapital] = useState([]);
  const [ap, setAp] = useState([]);
  const [manualAdj, setManualAdj] = useState({});
  const [tab, setTab] = useState("plan");
  const [selId, setSelId] = useState(null);
  const [expandedId, setExpandedId] = useState(null);
  const [expandedSprints, setExpandedSprints] = useState(() => new Set());
  const [showCategories, setShowCategories] = useState(false);
  const [financingOpen, setFinancingOpen] = useState(false);

  /* ---- scenarios + persistence ---- */
  const [scenarios, setScenarios] = useState([]);
  const [activeId, setActiveId] = useState(null);
  const [hydrated, setHydrated] = useState(false);
  const [savedSig, setSavedSig] = useState(null);
  const [saving, setSaving] = useState(false);
  const [isWriter, setIsWriter] = useState(true);
  const [migration, setMigration] = useState(null);
  const [pickerOpen, setPickerOpen] = useState(false);
  const [importOpen, setImportOpen] = useState(false);
  const [toast, setToast] = useState("");
  const toastTimer = useRef(null);
  const showToast = (msg) => { setToast(msg); clearTimeout(toastTimer.current); toastTimer.current = setTimeout(() => setToast(""), 2800); };
  const showToastRef = useRef(showToast);
  useEffect(() => { showToastRef.current = showToast; });

  const applyState = useCallback((st) => {
    setEpoch(st.sprintEpoch || DEFAULT_EPOCH);
    setHorizonSprints(st.horizonSprints || DEFAULT_HORIZON_SPRINTS);
    setOpeningCash(st.openingCash || 0);
    setFloor(st.floor || 0);
    setRuns(st.runs || []);
    setBurn(st.burn || []);
    setCapital(st.capital || []);
    setAp(st.ap || []);
    setManualAdj(st.manualAdj || {});
    setTab(TABS.some(([k]) => k === st.tab) ? st.tab : "plan");
    setSelId(st.selId ?? null);
  }, []);
  const adoptStore = useCallback((store) => {
    setScenarios(store.scenarios);
    setActiveId(store.activeId);
    const active = store.scenarios.find((s) => s.id === store.activeId) || store.scenarios[0];
    if (active) applyState(active.state);
  }, [applyState]);

  /* hydrate: v3 store → else migrate the legacy key (read-only) → else a fresh Base case */
  useEffect(() => {
    let alive = true;
    (async () => {
      let raw = null; try { raw = await loadAppData(STORE_KEY); } catch { raw = null; }
      let store = null, fromLegacy = false, report = [];
      if (isV3(raw)) store = normalizeStore(raw, { newId });
      else {
        let legacy = null; try { legacy = await loadAppData(LEGACY_KEY); } catch { legacy = null; }
        const m = migrateLegacyToV3(legacy, { epoch: DEFAULT_EPOCH, today: TODAY, newId });
        if (m.store && m.store.scenarios.length) { store = normalizeStore(m.store, { newId }); fromLegacy = true; report = m.report; }
      }
      if (!store || store.scenarios.length === 0) {
        const sc = newScenario("Base case", emptyScenarioState({ newId }), newId);
        store = { version: 3, activeId: sc.id, scenarios: [sc] }; fromLegacy = false;
      }
      if (!alive) return;
      adoptStore(store);
      setSavedSig(isV3(raw) ? sigOf(store) : null); // migrated / fresh → "not saved yet"
      setMigration(fromLegacy ? { report, count: store.scenarios.length } : null);
      setHydrated(true);
    })();
    return () => { alive = false; };
  }, [adoptStore, TODAY]);

  const currentState = useMemo(() => ({ version: 3, sprintEpoch: epoch, horizonSprints, openingCash, floor, runs, burn, capital, ap, manualAdj, tab, selId }),
    [epoch, horizonSprints, openingCash, floor, runs, burn, capital, ap, manualAdj, tab, selId]);
  const buildStore = useCallback(() => ({ version: 3, activeId, scenarios: scenarios.map((s) => (s.id === activeId ? { ...s, state: currentState } : s)) }), [activeId, scenarios, currentState]);
  const currentSig = useMemo(() => sigOf(buildStore()), [buildStore]);
  const dirty = hydrated && savedSig != null && currentSig !== savedSig;
  const canSave = hydrated && isWriter && !saving && (dirty || savedSig == null);
  const dirtyRef = useRef(false);
  useEffect(() => { dirtyRef.current = dirty; });
  const isWriterRef = useRef(true);
  useEffect(() => { isWriterRef.current = isWriter; });
  const bc = useRef(null);

  /* Save = re-read remote, merge per scenario (active wins; others keep the newer copy),
     write ONLY the v3 key. */
  const saveNow = async () => {
    if (!hydrated || !isWriterRef.current || saving) return;
    setSaving(true);
    try {
      const now = Date.now();
      const local = buildStore();
      local.scenarios = local.scenarios.map((s) => (s.id === activeId ? { ...s, updatedAt: now } : s));
      let remote = null; try { remote = await loadAppData(STORE_KEY); } catch { remote = null; }
      const merged = mergeScenarios(local, isV3(remote) ? normalizeStore(remote, { newId }) : null, activeId);
      await saveAppData(STORE_KEY, merged);
      setScenarios(merged.scenarios);
      setSavedSig(sigOf(merged));
      setMigration(null);
      if (bc.current) { try { bc.current.postMessage({ t: "store", id: winId, store: merged }); } catch { /* closing */ } }
      showToastRef.current("Saved");
    } catch (e) { showToastRef.current("Save failed — " + (e?.message || "try again")); }
    setSaving(false);
  };
  const saveNowRef = useRef(saveNow);
  useEffect(() => { saveNowRef.current = saveNow; });

  useEffect(() => {
    const h = (e) => { if (dirtyRef.current) { e.preventDefault(); e.returnValue = ""; } };
    window.addEventListener("beforeunload", h);
    return () => window.removeEventListener("beforeunload", h);
  }, []);
  useEffect(() => {
    const h = (e) => { if ((e.metaKey || e.ctrlKey) && (e.key === "s" || e.key === "S")) { e.preventDefault(); saveNowRef.current(); } };
    window.addEventListener("keydown", h);
    return () => window.removeEventListener("keydown", h);
  }, []);

  /* cross-window: one writer at a time; siblings adopt saves when they have no local edits */
  useEffect(() => {
    if (typeof BroadcastChannel === "undefined") return;
    const ch = new BroadcastChannel(SYNC_CHANNEL);
    bc.current = ch;
    const post = (msg) => { try { ch.postMessage(msg); } catch { /* channel closing */ } };
    ch.onmessage = (ev) => {
      const m = ev.data; if (!m) return;
      if (m.t === "store" && isV3(m.store)) {
        if (dirtyRef.current) { showToastRef.current("Another window saved — you have unsaved changes here"); return; }
        adoptStore(normalizeStore(m.store, { newId }));
        setSavedSig(sigOf(m.store));
        showToastRef.current("Synced changes from another window");
      } else if (m.t === "claim" && m.id !== winId) {
        setIsWriter(false);
      } else if (m.t === "ping" && isWriterRef.current) {
        post({ t: "claim", id: winId });
      }
    };
    post({ t: "ping", id: winId });
    if (typeof document === "undefined" || document.hasFocus()) post({ t: "claim", id: winId });
    const onFocus = () => { setIsWriter(true); post({ t: "claim", id: winId }); };
    window.addEventListener("focus", onFocus);
    return () => { window.removeEventListener("focus", onFocus); ch.close(); bc.current = null; };
  }, [adoptStore, winId]);
  const takeOver = async () => {
    setIsWriter(true);
    if (bc.current) { try { bc.current.postMessage({ t: "claim", id: winId }); } catch { /* closing */ } }
    if (!dirtyRef.current) { try { const raw = await loadAppData(STORE_KEY); if (isV3(raw)) { const st = normalizeStore(raw, { newId }); adoptStore(st); setSavedSig(sigOf(st)); } } catch { /* offline */ } }
  };

  /* ---- scenarios ---- */
  const active = scenarios.find((s) => s.id === activeId) || null;
  const activeName = active?.name || "Base case";
  const foldCurrent = () => scenarios.map((s) => (s.id === activeId ? { ...s, state: currentState, updatedAt: sameState(s.state, currentState) ? (s.updatedAt || 0) : Date.now() } : s));
  const switchScenario = (id) => {
    if (id === activeId) return;
    const list = foldCurrent();
    const target = list.find((s) => s.id === id);
    if (!target) return;
    setScenarios(list); setActiveId(id); applyState(target.state); setExpandedId(null); setPickerOpen(false);
  };
  const saveAsScenario = (name, group) => {
    const list = foldCurrent();
    const sc = newScenario(name, JSON.parse(JSON.stringify(currentState)), newId, Date.now());
    if (group) sc.group = group;
    setScenarios([...list, sc]); setActiveId(sc.id); setPickerOpen(false);
    showToastRef.current(`Created "${name}" — remember to Save`);
  };
  const renameScenario = (id, name) => setScenarios((xs) => xs.map((s) => (s.id === id ? { ...s, name, updatedAt: Date.now() } : s)));
  const setScenarioGroup = (id, group) => setScenarios((xs) => xs.map((s) => (s.id === id ? { ...s, group: group || undefined, updatedAt: Date.now() } : s)));
  const deleteScenario = (id) => {
    const rest = scenarios.filter((s) => s.id !== id);
    if (rest.length === 0) return;
    if (id === activeId) { setScenarios(rest); setActiveId(rest[0].id); applyState(rest[0].state); } else setScenarios(rest);
  };
  const setNotes = (text) => setScenarios((xs) => xs.map((s) => (s.id === activeId ? { ...s, notes: text } : s)));

  /* ---- engine ---- */
  const origin = useMemo(() => sprintOfToday(epoch, parseLocalDate(TODAY)), [epoch, TODAY]);
  const horizon = useMemo(() => {
    const need = Math.max(0, ...runs.map((r) => (r.startSprint || 0) + (r.sprints || 1) - origin + 1));
    return Math.min(40, Math.max(horizonSprints, need));
  }, [horizonSprints, runs, origin]);
  const result = useMemo(() => computeCash({ epoch, origin, horizon, openingCash, floor, runs, burn, capital, ap, manualAdj, today: TODAY }),
    [epoch, origin, horizon, openingCash, floor, runs, burn, capital, ap, manualAdj, TODAY]);
  // headline burn = the run-rate two weeks out, so step-changes starting next sprint are visible
  const burnNow = useMemo(() => monthlyTotal(burn, TODAY), [burn, TODAY]);
  const burnMonthly = useMemo(() => monthlyTotal(burn, isoLocal(addDays(parseLocalDate(TODAY), 14))), [burn, TODAY]);

  /* ---- run handlers ---- */
  const patchRun = (id, fn) => setRuns((rs) => rs.map((r) => (r.id === id ? fn(r) : r)));
  const addRun = () => {
    const r = newRun({ name: "Run " + (runs.length + 1), color: PALETTE[runs.length % PALETTE.length] }, newId, { epoch, originSprint: origin });
    setRuns((rs) => [...rs, r]); setSelId(r.id); setExpandedId(r.id);
  };
  const dupRun = (run) => {
    const copy = { ...run, id: newId("run"), name: run.name + " (copy)", materials: run.materials.map((l) => ({ ...l, id: newId("m"), status: "planned", orderedOn: undefined })), payments: run.payments.map((p) => ({ ...p, id: newId("pay") })) };
    delete copy.suiteRunId;
    setRuns((rs) => { const i = rs.findIndex((r) => r.id === run.id); const n = rs.slice(); n.splice(i + 1, 0, copy); return n; });
    setSelId(copy.id); setExpandedId(copy.id);
  };
  const delRun = (id) => {
    setRuns((rs) => rs.filter((r) => r.id !== id));
    setAp((xs) => xs.map((b) => (b.runId === id ? { ...b, runId: undefined, lineId: undefined } : b)));
    if (selId === id) setSelId(null);
    if (expandedId === id) setExpandedId(null);
  };
  const toggleHide = (id) => patchRun(id, (r) => ({ ...r, hidden: !r.hidden }));
  const reorderRun = (fromId, toId, after) => setRuns((rs) => {
    const from = rs.find((r) => r.id === fromId); if (!from || fromId === toId) return rs;
    const rest = rs.filter((r) => r.id !== fromId);
    const i = rest.findIndex((r) => r.id === toId); if (i < 0) return rs;
    rest.splice(after ? i + 1 : i, 0, from); return rest;
  });
  const setLineStatus = (runId, lineId, status, onDate) => patchRun(runId, (r) => ({ ...r, materials: r.materials.map((l) => (l.id === lineId ? { ...l, status, orderedOn: status === "ordered" ? (onDate || TODAY) : undefined } : l)) }));

  /* ---- bills ↔ material lines ---- */
  const payDateOf = useCallback((bill) => billPayDate(bill, { runs, epoch, today: TODAY }), [runs, epoch, TODAY]);
  const billedByLine = useMemo(() => { const m = {}; for (const b of ap) if (b.lineId && (b.include ?? true)) m[b.lineId] = (m[b.lineId] || 0) + (Number(b.amount) || 0); return m; }, [ap]);
  const linkBill = (billId, runId, lineId) => {
    setAp((xs) => xs.map((b) => (b.id === billId ? { ...b, runId, lineId } : b)));
    patchRun(runId, (r) => ({ ...r, materials: r.materials.map((l) => (l.id === lineId ? { ...l, status: "linked" } : l)) }));
  };
  const unlinkBill = (billId) => {
    const bill = ap.find((b) => b.id === billId); if (!bill) return;
    const stillLinked = ap.some((b) => b.id !== billId && b.lineId === bill.lineId);
    setAp((xs) => xs.map((b) => (b.id === billId ? { ...b, runId: undefined, lineId: undefined, payDate: undefined } : b)));
    if (bill.runId && bill.lineId && !stillLinked) patchRun(bill.runId, (r) => ({ ...r, materials: r.materials.map((l) => (l.id === bill.lineId ? { ...l, status: "ordered", orderedOn: l.orderedOn || TODAY } : l)) }));
  };
  const setPayDate = (billId, iso) => setAp((xs) => xs.map((b) => (b.id === billId ? { ...b, payDate: iso || undefined } : b)));
  const setAdj = (k, v) => setManualAdj((m) => { const n = { ...m }; if (!v) delete n[String(k)]; else n[String(k)] = v; return n; });
  const toggleSprint = (k) => setExpandedSprints((s) => { const n = new Set(s); n.has(k) ? n.delete(k) : n.add(k); return n; });

  /* ---- suite quotes ---- */
  const costsOf = (suiteRun) => { try { return computeRunResults(suiteRun)?.costs || null; } catch { return null; } };
  const importQuotes = (selected) => {
    let added = 0, refreshed = 0;
    setRuns((rs) => {
      const out = rs.slice();
      selected.forEach((sr, i) => {
        const sid = String(sr.id);
        const costs = costsOf(sr);
        const idx = out.findIndex((r) => r.suiteRunId === sid || r.id === sid);
        if (idx >= 0) { out[idx] = applySuiteCosts(out[idx], costs, newId); refreshed++; }
        else { out.push(quoteToRun(sr, costs, out.length + i, newId, { epoch, originSprint: origin })); added++; }
      });
      return out;
    });
    setImportOpen(false);
    showToastRef.current(`${added} run${added === 1 ? "" : "s"} added · ${refreshed} refreshed from the suite`);
  };
  const refreshFromSuite = async (run) => {
    try {
      const all = await loadAppData("runs");
      const sr = (Array.isArray(all) ? all : []).find((x) => String(x.id) === String(run.suiteRunId));
      if (!sr) { showToastRef.current("Suite run not found — was it deleted in Run Quoting?"); return; }
      patchRun(run.id, (r) => applySuiteCosts(r, costsOf(sr), newId));
      showToastRef.current("Costs refreshed from the suite quote");
    } catch (e) { showToastRef.current("Refresh failed — " + (e?.message || "try again")); }
  };

  /* ---- scroll sync between the cash table and the planner ---- */
  const tableScroll = useRef(null);
  const plannerScroll = useRef(null);
  const syncing = useRef(false);
  const mirror = (from, to) => () => {
    if (syncing.current || !from.current || !to.current) return;
    syncing.current = true; to.current.scrollLeft = from.current.scrollLeft; syncing.current = false;
  };

  const detailRun = runs.find((r) => r.id === (expandedId || selId)) || null;
  const apTotalWindow = result.totals.bills;
  const troughCol = result.cols[result.troughI];
  const breachCol = result.firstBreach < result.horizon ? result.cols[result.firstBreach] : null;
  const strip = (
    <div className="card" style={{ padding: "10px 14px", display: "flex", gap: 6, overflowX: "auto", alignItems: "flex-end" }} title="Closing position by sprint (from the Run planner)">
      {result.cols.map((c, i) => { const v = result.rows.closing[i]; const bad = v < floor; return (
        <div key={c.k} style={{ minWidth: 64, textAlign: "center", fontSize: 10.5 }}>
          <div className="num" style={{ fontWeight: 700, color: bad ? "var(--danger)" : v < floor * 1.25 ? "#a1741a" : "var(--pos)" }}>{fmtK(v)}</div>
          <div style={{ color: "var(--muted)" }}>S{c.ordinal}</div>
        </div>); })}
    </div>
  );

  if (!hydrated) return <div className="tcockpit" style={{ padding: 40, color: "var(--muted)", fontFamily: "system-ui" }}><style>{COCKPIT_CSS}</style>Loading treasury cockpit…</div>;

  return (
    <div className="tcockpit">
      <style>{COCKPIT_CSS}</style>
      <div style={{ maxWidth: 1600, margin: "0 auto", padding: "18px 22px 60px" }}>
        {/* header */}
        <div style={{ display: "flex", alignItems: "center", gap: 14, flexWrap: "wrap" }}>
          <div>
            <div className="eyebrow">Treasury Cockpit · v2 sprints</div>
            <div style={{ fontSize: 20, fontWeight: 800, letterSpacing: -0.2 }}>{activeName}{active?.group ? <span style={{ fontSize: 12, color: "var(--muted)", fontWeight: 500, marginLeft: 8 }}>{active.group}</span> : null}</div>
          </div>
          <button className="btn" onClick={() => setPickerOpen(true)} title="Switch, create, rename or group scenarios">Scenarios ({scenarios.length}) ▾</button>
          <div className="tabbar" style={{ marginLeft: 6 }}>
            {TABS.map(([k, label]) => <button key={k} className={"tabbtn" + (tab === k ? " on" : "")} onClick={() => setTab(k)}>{label}{k === "order" && result.overdue.length > 0 ? <span className="late">{result.overdue.length}</span> : null}</button>)}
          </div>
          <div style={{ flex: 1 }} />
          <span className="num" style={{ fontSize: 11.5, color: dirty || savedSig == null ? "#a1741a" : "var(--muted)", fontWeight: dirty ? 700 : 500 }}>
            {saving ? "Saving…" : savedSig == null ? "Not saved yet" : dirty ? "Unsaved changes" : "All changes saved"}
          </span>
          <button className="btn" disabled={!canSave} onClick={saveNow} title="Save (⌘S). Writes this plan to the shared store." style={{ fontWeight: 700, background: canSave ? "var(--ink)" : undefined, color: canSave ? "#fff" : undefined }}>Save</button>
        </div>

        {!isWriter && (
          <div className="card" style={{ marginTop: 12, padding: "10px 14px", background: "#fff6e0", borderColor: "#e8cf8a", display: "flex", alignItems: "center", gap: 12, fontSize: 12.5 }}>
            <b>Read-only:</b> another cockpit window is editing. Saving here is disabled so a stale copy can't overwrite it.
            <button className="btn" style={{ marginLeft: "auto", fontSize: 12 }} onClick={takeOver}>Edit in this window</button>
          </div>
        )}
        {migration && (
          <div className="card" style={{ marginTop: 12, padding: "10px 14px", background: "#eef4ff", borderColor: "#b9cdf5", fontSize: 12.5, lineHeight: 1.5 }}>
            <b>Migrated from your v1 plan</b> — {migration.count} scenario{migration.count === 1 ? "" : "s"} converted to sprints. Runs were snapped to whole sprints, budget events became materials/payments, fixed costs became monthly burn. Nothing is written until you press <b>Save</b>; v1 stays untouched at <code>/treasury</code> on main.
            {migration.report.some((r) => r.unmapped?.length) && (
              <details style={{ marginTop: 6 }}>
                <summary style={{ cursor: "pointer" }}>{migration.report.reduce((n, r) => n + (r.unmapped?.length || 0), 0)} cost lines didn't match a standard material and were kept as their own line on the run (no money lost) — show</summary>
                {migration.report.filter((r) => r.unmapped?.length).map((r) => (
                  <div key={r.scenarioId} style={{ marginTop: 4 }}><b>{r.scenarioName}</b>: {r.unmapped.map((u) => `${u.run} › ${u.label} (${fmt(u.amount)})`).join(" · ")}</div>
                ))}
              </details>
            )}
          </div>
        )}

        {/* top stats */}
        <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(150px, 1fr))", gap: 10, marginTop: 14 }}>
          <div className="card" style={{ padding: "10px 12px" }}><div className="eyebrow">Opening cash</div><NumberInput value={openingCash} onChange={setOpeningCash} className="inp num" style={{ width: "100%", fontWeight: 700, marginTop: 4 }} /></div>
          <div className="card" style={{ padding: "10px 12px" }}><div className="eyebrow">Cash floor</div><NumberInput value={floor} onChange={setFloor} className="inp num" style={{ width: "100%", fontWeight: 700, marginTop: 4, color: "var(--danger)" }} /></div>
          <Stat label="Burn / month" value={fmt(burnMonthly)} sub={fmt(burnMonthly * 12 / 26) + " per sprint" + (Math.abs(burnNow - burnMonthly) > 1 ? " · " + fmt(burnNow) + " today" : "")} tone="fixed" />
          <Stat label="Trough" value={fmt(result.trough)} sub={troughCol ? "Sprint " + troughCol.ordinal + " · " + troughCol.range : ""} tone={result.trough < floor ? "danger" : "pos"} />
          <Stat label={"Ending · S" + (result.cols[result.horizon - 1]?.ordinal ?? "")} value={fmt(result.ending)} tone={result.ending < floor ? "danger" : "pos"} />
          <Stat label="First breach" value={breachCol ? "Sprint " + breachCol.ordinal : "none"} sub={breachCol ? breachCol.range : "position stays above the floor"} tone={breachCol ? "danger" : "in"} />
          <div className="card" style={{ padding: "10px 12px" }}>
            <div className="eyebrow">Sprint calendar</div>
            <div style={{ display: "flex", gap: 6, alignItems: "center", marginTop: 4, flexWrap: "wrap" }}>
              <input className="inp num sm" type="date" value={epoch} onChange={(e) => { const d = parseLocalDate(e.target.value); if (d && d.getDay() === 1) setEpoch(e.target.value); else if (d) showToastRef.current("Sprints start on a Monday — pick a Monday"); }} title="A known sprint start (Monday). Sprints are always 2 weeks." style={{ width: 130 }} />
              <label style={{ fontSize: 11, color: "var(--muted)", display: "flex", gap: 4, alignItems: "center" }}>horizon <NumberInput value={horizonSprints} onChange={(v) => setHorizonSprints(Math.max(4, Math.min(40, v)))} min={4} max={40} integer className="inp num sm" style={{ width: 46 }} /> sprints</label>
            </div>
            <div style={{ fontSize: 10.5, color: "var(--muted)", marginTop: 4 }}>today {fmtMD(parseLocalDate(TODAY))} · current sprint {result.cols[0] ? result.cols[0].range : ""}</div>
          </div>
        </div>

        {tab === "plan" && (
          <>
            <CashFlowTable result={result} floor={floor} openingCash={openingCash} manualAdj={manualAdj} setAdj={setAdj} expandedSprints={expandedSprints} toggleSprint={toggleSprint} showCategories={showCategories} scrollRef={tableScroll} onScrollSync={mirror(tableScroll, plannerScroll)}
              note={<label style={{ fontSize: 11, color: "var(--muted)", display: "inline-flex", gap: 4, alignItems: "center", cursor: "pointer" }}><input type="checkbox" checked={showCategories} onChange={(e) => setShowCategories(e.target.checked)} /> split materials by category</label>} />
            <Planner result={result} runs={runs} patchRun={patchRun} selId={selId} setSelId={setSelId} expandedId={expandedId} setExpandedId={setExpandedId} epoch={epoch} origin={origin} horizon={horizon} today={TODAY} floor={floor} reorderRun={reorderRun} toggleHide={toggleHide} scrollRef={plannerScroll} onScrollSync={mirror(plannerScroll, tableScroll)} />
            <div style={{ display: "flex", gap: 8, marginTop: 10, alignItems: "center", flexWrap: "wrap" }}>
              <button className="btn" onClick={addRun} style={{ fontWeight: 600 }}>+ Add run</button>
              <button className="btn" onClick={() => setImportOpen(true)} title="Bring co-packing quotes from Run Quoting onto the planner (costs pre-filled from the suite)">Import from quoting…</button>
              <span style={{ fontSize: 11.5, color: "var(--muted)" }}>drag a bar to move a run · drag its edges to change length · click a run to open its materials &amp; payments</span>
            </div>
            {detailRun && <RunDetail run={detailRun} patchRun={patchRun} delRun={delRun} dupRun={dupRun} toggleHide={toggleHide} epoch={epoch} origin={origin} today={TODAY} newId={newId} ap={ap} billedByLine={billedByLine} linkBill={linkBill} unlinkBill={unlinkBill} payDateOf={payDateOf} setPayDate={setPayDate} refreshFromSuite={refreshFromSuite} coverage={result.perRun[detailRun.id]?.coverage} onClose={() => { setExpandedId(null); setSelId(null); }} />}

            <div className="card" style={{ marginTop: 12, overflow: "hidden" }}>
              <div onClick={() => setFinancingOpen((o) => !o)} style={{ padding: "10px 14px", display: "flex", alignItems: "center", gap: 10, cursor: "pointer", background: "#FBFAF6" }}>
                <Chevron open={financingOpen} />
                <span className="eyebrow">Financing</span>
                <span style={{ fontSize: 11.5, color: "var(--muted)" }}>{capital.length} injection{capital.length === 1 ? "" : "s"} · {fmt(result.totals.capitalIn)} inside the window{result.droppedCapital.length ? ` · ${result.droppedCapital.length} outside` : ""}</span>
                <span style={{ marginLeft: "auto", fontSize: 11.5, color: "var(--muted)" }}>edit timing &amp; amounts inline — debt service belongs in Burn</span>
              </div>
              {financingOpen && <div style={{ padding: 14, borderTop: "1px solid var(--line)" }}><CapitalEditor capital={capital} setCapital={setCapital} epoch={epoch} origin={origin} horizon={horizon} today={TODAY} newId={newId} /></div>}
            </div>
            <NotesCard activeName={activeName} notes={active?.notes || ""} setNotes={setNotes} />
          </>
        )}
        {tab === "order" && <OrderAheadTab result={result} runs={runs} setLineStatus={setLineStatus} today={TODAY} selectRun={(id) => { setSelId(id); setExpandedId(id); setTab("plan"); }} />}
        {tab === "burn" && <BurnTab burn={burn} setBurn={setBurn} epoch={epoch} origin={origin} horizon={horizon} today={TODAY} newId={newId} cols={result.cols} />}
        {tab === "ap" && <APTab ap={ap} setAp={setAp} runs={runs} unlinkBill={unlinkBill} payDateOf={payDateOf} today={TODAY} apTotalWindow={apTotalWindow} newId={newId} strip={strip} />}
        {tab === "capital" && <CapitalTab capital={capital} setCapital={setCapital} epoch={epoch} origin={origin} horizon={horizon} today={TODAY} newId={newId} totalIn={result.totals.capitalIn} strip={strip} />}
      </div>

      {pickerOpen && <ScenarioPicker scenarios={scenarios} activeId={activeId} onClose={() => setPickerOpen(false)} onSwitch={switchScenario} onSaveAs={saveAsScenario} onRename={renameScenario} onDelete={deleteScenario} onSetGroup={setScenarioGroup} />}
      {importOpen && <QuotePicker existingIds={new Set(runs.map((r) => r.suiteRunId || r.id))} onClose={() => setImportOpen(false)} onImport={importQuotes} />}
      {toast && <div style={{ position: "fixed", bottom: 22, left: "50%", transform: "translateX(-50%)", background: "var(--ink)", color: "#fff", padding: "8px 14px", borderRadius: 8, fontSize: 12.5, zIndex: 80, display: "flex", gap: 10, alignItems: "center", boxShadow: "0 6px 20px rgba(0,0,0,.2)" }}>{toast}<button className="btn-x" style={{ color: "#fff" }} onClick={() => setToast("")}><Cross /></button></div>}
    </div>
  );
}
