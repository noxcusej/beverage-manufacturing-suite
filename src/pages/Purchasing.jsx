import { useState, useMemo, useEffect } from 'react';
import { getRuns, getFormulas, getInventory, getSavedPOs, upsertSavedPO, deleteSavedPO } from '../data/store';
import { prepareRawPOData } from '../utils/runWorkbookRawPO';
import { exportConsolidatedPO } from '../utils/exportConsolidatedPO';

const money = (n) => '$' + (Number(n) || 0).toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 });
const dec = (n, d = 2) => (Number(n) || 0).toLocaleString(undefined, { minimumFractionDigits: d, maximumFractionDigits: d });
const int = (n) => (Number(n) || 0).toLocaleString();

export default function Purchasing() {
  const [runs, setRuns] = useState([]);
  const [formulas, setFormulas] = useState([]);
  const [inventory, setInventory] = useState([]);
  const [savedPOs, setSavedPOs] = useState([]);
  const [selectedIds, setSelectedIds] = useState(() => new Set());
  const [loaded, setLoaded] = useState(null); // { id, name } of the currently-open saved PO
  const [query, setQuery] = useState('');

  useEffect(() => {
    const refresh = () => {
      setRuns(getRuns());
      setFormulas(getFormulas());
      setInventory(getInventory());
      setSavedPOs(getSavedPOs());
    };
    refresh();
    window.addEventListener('comanufacturing:datachange', refresh);
    return () => window.removeEventListener('comanufacturing:datachange', refresh);
  }, []);

  const formulasById = useMemo(() => Object.fromEntries(formulas.map((f) => [f.id, f])), [formulas]);
  const inventoryMap = useMemo(() => Object.fromEntries(inventory.map((i) => [i.id, i])), [inventory]);

  const toggle = (id) => setSelectedIds((s) => { const n = new Set(s); n.has(id) ? n.delete(id) : n.add(id); return n; });
  const setMany = (ids, on) => setSelectedIds((s) => { const n = new Set(s); ids.forEach((id) => on ? n.add(id) : n.delete(id)); return n; });

  const selectedRuns = useMemo(() => runs.filter((r) => selectedIds.has(r.id)), [runs, selectedIds]);

  const { caseCounts, selectedFormulas, totalCases } = useMemo(() => {
    const cc = {};
    selectedRuns.forEach((run) => (run.flavors || []).forEach((f) => {
      if (f.formulaId && (f.cases || 0) > 0) cc[f.formulaId] = (cc[f.formulaId] || 0) + f.cases;
    }));
    const sf = Object.keys(cc).map((id) => formulasById[id]).filter(Boolean);
    const tc = Object.values(cc).reduce((s, v) => s + v, 0);
    return { caseCounts: cc, selectedFormulas: sf, totalCases: tc };
  }, [selectedRuns, formulasById]);

  const poData = useMemo(
    () => (selectedFormulas.length ? prepareRawPOData({ selectedFormulas, inventoryMap, caseCounts }) : null),
    [selectedFormulas, inventoryMap, caseCounts],
  );
  const missingPrices = poData ? poData.masterList.filter((m) => !(m.pricePerBuyUnit > 0)).length : 0;

  // Runs grouped by client for the selector, filtered by search.
  const grouped = useMemo(() => {
    const q = query.trim().toLowerCase();
    const filtered = runs.filter((r) => !q || (r.name || '').toLowerCase().includes(q) || (r.client || '').toLowerCase().includes(q));
    const g = {};
    filtered.forEach((r) => { const c = r.client || 'Uncategorized'; (g[c] = g[c] || []).push(r); });
    return Object.entries(g).sort(([a], [b]) => a.localeCompare(b));
  }, [runs, query]);

  const runCases = (run) => (run.flavors || []).filter((f) => f.formulaId && (f.cases || 0) > 0).reduce((s, f) => s + (f.cases || 0), 0);
  const runSkus = (run) => (run.flavors || []).filter((f) => f.formulaId && (f.cases || 0) > 0).length;

  // ── Saved POs ──
  const dirty = useMemo(() => {
    if (!loaded) return false;
    const p = savedPOs.find((x) => x.id === loaded.id);
    if (!p) return true;
    return [...selectedIds].sort().join(',') !== [...(p.runIds || [])].sort().join(',');
  }, [loaded, savedPOs, selectedIds]);

  const savePO = () => {
    if (selectedIds.size === 0) return;
    const name = window.prompt('Name this PO:', loaded?.name || `PO ${new Date().toLocaleDateString()}`);
    if (!name || !name.trim()) return;
    const now = new Date().toISOString();
    const id = loaded?.id || 'PO-' + Date.now();
    const existing = savedPOs.find((p) => p.id === id);
    upsertSavedPO({ id, name: name.trim(), runIds: [...selectedIds], createdAt: existing?.createdAt || now, updatedAt: now });
    setLoaded({ id, name: name.trim() });
  };
  const openPO = (po) => {
    if (!po) return;
    const validIds = (po.runIds || []).filter((id) => runs.some((r) => r.id === id));
    setSelectedIds(new Set(validIds));
    setLoaded({ id: po.id, name: po.name });
  };
  const renamePO = (po) => {
    const n = window.prompt('Rename PO:', po.name);
    if (n && n.trim()) {
      upsertSavedPO({ ...po, name: n.trim(), updatedAt: new Date().toISOString() });
      if (loaded?.id === po.id) setLoaded({ id: po.id, name: n.trim() });
    }
  };
  const removePO = (po) => {
    if (window.confirm(`Delete PO "${po.name}"? This can't be undone.`)) {
      deleteSavedPO(po.id);
      if (loaded?.id === po.id) setLoaded(null);
    }
  };

  const doExport = () => exportConsolidatedPO({
    runs: selectedRuns, poData, caseCounts, selectedFormulas, inventoryMap,
    formulaNamesById: Object.fromEntries(formulas.map((f) => [f.id, f.name])),
  }).catch((e) => alert(e?.message || String(e)));

  const th = { textAlign: 'left', padding: '6px 8px', fontSize: 11, fontWeight: 600, color: 'var(--text-muted)', borderBottom: '1px solid var(--border)', whiteSpace: 'nowrap' };
  const thR = { ...th, textAlign: 'right' };
  const td = { padding: '5px 8px', borderBottom: '1px solid var(--border-light)', fontSize: 13 };
  const tdR = { ...td, textAlign: 'right', fontFamily: 'monospace' };

  return (
    <div className="container" style={{ padding: 24 }}>
      {/* Header + saved-PO toolbar */}
      <div className="section-header" style={{ display: 'flex', alignItems: 'center', gap: 12, flexWrap: 'wrap', marginBottom: 6 }}>
        <div>
          <div className="section-title" style={{ marginBottom: 2 }}>Purchasing</div>
          <div style={{ fontSize: 13, color: 'var(--text-muted)' }}>Combine multiple runs into one consolidated ingredient PO.</div>
        </div>
        <div style={{ flex: 1 }} />
        <select value={loaded?.id || ''} onChange={(e) => { const p = savedPOs.find((x) => x.id === e.target.value); if (p) openPO(p); }}
          style={{ fontSize: 13 }} title="Open a saved PO">
          <option value="">{savedPOs.length ? 'Open saved PO…' : 'No saved POs yet'}</option>
          {savedPOs.map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}
        </select>
        {loaded && <button className="btn btn-small" onClick={() => renamePO(savedPOs.find((x) => x.id === loaded.id) || loaded)}>Rename</button>}
        {loaded && <button className="btn btn-small" onClick={() => removePO(savedPOs.find((x) => x.id === loaded.id) || loaded)}>Delete</button>}
        <button className="btn btn-small btn-primary" onClick={savePO} disabled={selectedIds.size === 0}
          title={loaded ? 'Update this saved PO (or save as new name)' : 'Save the selected runs as a PO'}>
          {loaded ? (dirty ? 'Save changes' : 'Save as…') : 'Save PO'}
        </button>
        <button className="btn btn-small" onClick={doExport} disabled={!poData}>⬇ Export Excel</button>
      </div>
      {loaded && (
        <div style={{ fontSize: 12, color: dirty ? '#b45309' : 'var(--text-muted)', marginBottom: 14 }}>
          {dirty ? '● Unsaved changes to ' : 'Editing '}<strong>{loaded.name}</strong>
        </div>
      )}

      <div style={{ display: 'grid', gridTemplateColumns: 'minmax(300px, 360px) 1fr', gap: 16, alignItems: 'start' }}>
        {/* Left: run multi-select */}
        <div className="section" style={{ padding: 0, overflow: 'hidden' }}>
          <div style={{ padding: 12, borderBottom: '1px solid var(--border)' }}>
            <input className="inp" placeholder="Search runs or clients…" value={query} onChange={(e) => setQuery(e.target.value)}
              style={{ width: '100%', boxSizing: 'border-box', padding: '7px 9px', border: '1px solid var(--border)', borderRadius: 7, fontSize: 13 }} />
            <div style={{ fontSize: 12, color: 'var(--text-muted)', marginTop: 8 }}>
              <strong style={{ color: 'var(--text-primary)' }}>{selectedIds.size}</strong> run{selectedIds.size === 1 ? '' : 's'} · <strong style={{ color: 'var(--text-primary)' }}>{int(totalCases)}</strong> cases selected
              {selectedIds.size > 0 && <button className="btn btn-small" style={{ marginLeft: 8 }} onClick={() => setSelectedIds(new Set())}>Clear</button>}
            </div>
          </div>
          <div style={{ maxHeight: '70vh', overflowY: 'auto' }}>
            {grouped.length === 0 && <div style={{ padding: 20, color: 'var(--text-muted)', fontSize: 13 }}>No runs found.</div>}
            {grouped.map(([client, clientRuns]) => {
              const ids = clientRuns.map((r) => r.id);
              const allOn = ids.every((id) => selectedIds.has(id));
              return (
                <div key={client}>
                  <div style={{ display: 'flex', alignItems: 'center', gap: 8, padding: '7px 12px', background: 'var(--surface-alt)', borderBottom: '1px solid var(--border-light)', position: 'sticky', top: 0 }}>
                    <input type="checkbox" checked={allOn} onChange={() => setMany(ids, !allOn)} title="Select all in this client" />
                    <span style={{ fontWeight: 600, fontSize: 12 }}>{client}</span>
                    <span style={{ fontSize: 11, color: 'var(--text-muted)' }}>{clientRuns.length}</span>
                  </div>
                  {clientRuns.map((run) => (
                    <label key={run.id} style={{ display: 'flex', alignItems: 'center', gap: 8, padding: '7px 12px 7px 16px', borderBottom: '1px solid var(--border-light)', cursor: 'pointer', background: selectedIds.has(run.id) ? '#eef2ff' : 'transparent' }}>
                      <input type="checkbox" checked={selectedIds.has(run.id)} onChange={() => toggle(run.id)} />
                      <span style={{ flex: 1, fontSize: 13 }}>{run.name || '(unnamed run)'}</span>
                      <span style={{ fontSize: 11, color: 'var(--text-muted)', fontFamily: 'monospace' }}>{int(runCases(run))} cs · {runSkus(run)} SKU</span>
                    </label>
                  ))}
                </div>
              );
            })}
          </div>
        </div>

        {/* Right: consolidated PO */}
        <div>
          {!poData ? (
            <div className="section" style={{ padding: 40, textAlign: 'center', color: 'var(--text-muted)' }}>
              <div style={{ fontSize: 34 }}>🧾</div>
              <div style={{ marginTop: 8, fontWeight: 600, color: 'var(--text-secondary)' }}>Select runs to build a consolidated PO</div>
              <div style={{ fontSize: 13, marginTop: 6 }}>Shared ingredients across the chosen runs are pooled into one order (MOQ applied once to the combined quantity).</div>
            </div>
          ) : (
            <>
              <div className="cost-summary" style={{ gridTemplateColumns: 'repeat(auto-fit, minmax(150px, 1fr))', marginBottom: 16 }}>
                <div className="cost-card"><div className="cost-card-label">Total PO</div><div className="cost-card-value">{money(poData.grossSubtotalAll)}</div><div className="cost-card-subtitle">gross · flat pricing</div></div>
                <div className="cost-card"><div className="cost-card-label">Ingredients</div><div className="cost-card-value">{poData.masterList.length}</div><div className="cost-card-subtitle">consolidated lines</div></div>
                <div className="cost-card"><div className="cost-card-label">Runs</div><div className="cost-card-value">{selectedRuns.length}</div><div className="cost-card-subtitle">{int(totalCases)} cases · {selectedFormulas.length} formulas</div></div>
                <div className="cost-card"><div className="cost-card-label">Missing prices</div><div className="cost-card-value" style={{ color: missingPrices > 0 ? '#b45309' : undefined }}>{missingPrices}</div><div className="cost-card-subtitle">ingredients w/o price</div></div>
              </div>

              {Object.keys(poData.byVendor).sort().map((vendor) => {
                const items = poData.byVendor[vendor];
                const subtotal = items.reduce((s, m) => s + m.grossLineTotal, 0);
                return (
                  <div key={vendor} style={{ border: '1px solid var(--border-light)', borderRadius: 'var(--radius)', overflow: 'hidden', marginBottom: 14 }}>
                    <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', padding: '9px 14px', background: 'var(--surface-alt)', fontWeight: 700, fontSize: 13 }}>
                      <span>{vendor}</span><span style={{ fontFamily: 'monospace' }}>{money(subtotal)}</span>
                    </div>
                    <div style={{ overflowX: 'auto' }}>
                      <table style={{ width: '100%', borderCollapse: 'collapse' }}>
                        <thead><tr>
                          <th style={th}>Ingredient</th><th style={th}>Formulas</th><th style={th}>SKU</th><th style={thR}>Total Demand</th>
                          <th style={th}>Unit</th><th style={thR}>MOQ</th><th style={thR}>Order Qty</th>
                          <th style={thR}>Price</th><th style={thR}>Line Total</th>
                        </tr></thead>
                        <tbody>
                          {items.map((m) => {
                            const fNames = Object.keys(m.demandByFormulaId || {}).map((fid) => formulasById[fid]?.name || fid);
                            return (
                              <tr key={m.key}>
                                <td style={td}><strong>{m.name}</strong></td>
                                <td style={{ ...td, fontSize: 12, color: 'var(--text-secondary)', maxWidth: 240 }} title={fNames.join(', ')}>{fNames.join(', ') || '—'}</td>
                                <td style={{ ...td, color: 'var(--text-muted)' }}>{m.sku || '—'}</td>
                                <td style={tdR}>{dec(m.totalDemand)}</td>
                                <td style={td}>{m.buyUnit}</td>
                                <td style={tdR}>{dec(m.moq)}</td>
                                <td style={{ ...tdR, fontWeight: 700 }}>{dec(m.grossOrderQty)}</td>
                                <td style={tdR}>{m.pricePerBuyUnit > 0 ? '$' + dec(m.pricePerBuyUnit, 4) : <span style={{ color: '#b45309' }}>—</span>}</td>
                                <td style={{ ...tdR, fontWeight: 700 }}>{money(m.grossLineTotal)}</td>
                              </tr>
                            );
                          })}
                        </tbody>
                      </table>
                    </div>
                  </div>
                );
              })}
            </>
          )}
        </div>
      </div>
    </div>
  );
}
