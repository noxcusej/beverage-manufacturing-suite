import { useState, useMemo, useEffect } from 'react';
import { getRuns } from '../data/store';
import { computeRunResults } from '../utils/runResults';

// Industry-typical margin defaults by segment. Sources: BevNET / Craft
// Brewery Finance / American Spirits Exchange / LibDib / Vividly (2024-26).
const SEGMENT_PRESETS = [
  { id: 'rtd-malt',    label: 'Hard seltzer / RTD (malt)', dist: 30, retail: 35 },
  { id: 'rtd-spirits', label: 'RTD spirits / cocktails',   dist: 32, retail: 35 },
  { id: 'non-alc',     label: 'Non-alc (DSD / warehouse)', dist: 30, retail: 35 },
  { id: 'beer',        label: 'Beer (craft)',              dist: 30, retail: 28 },
  { id: 'wine',        label: 'Wine',                      dist: 28, retail: 35 },
  { id: 'spirits',     label: 'Spirits',                   dist: 32, retail: 33 },
];

// Summary delegates ALL math to computeRunResults so totals reconcile
// with the live Calculator, Excel export, and Client PDF. Per-SKU costs
// come straight from the saved run's flavor-level ingredient cost
// (which captures each formula's allocated share of the consolidated
// raw-material PO — i.e. bulk-buy pricing). Shared categories are
// pro-rated by can share.

export default function Summary() {
  const [runs, setRuns] = useState([]);
  const [selectedRunId, setSelectedRunId] = useState('');
  const [compareRunId, setCompareRunId] = useState('');

  useEffect(() => {
    const refresh = () => {
      const all = getRuns();
      setRuns(all);
      setSelectedRunId((current) => current || (all.length > 0 ? all[all.length - 1].id : ''));
    };
    refresh();
    window.addEventListener('comanufacturing:datachange', refresh);
    return () => window.removeEventListener('comanufacturing:datachange', refresh);
  }, []);

  const run = runs.find((r) => r.id === selectedRunId);
  const compareRun = compareRunId ? runs.find((r) => r.id === compareRunId) : null;

  // Pricing calculator state
  const [fobPrice, setFobPrice] = useState(0);
  // Industry defaults by segment. Picking a preset updates both inputs;
  // the user can still override either field afterward.
  const [marginPresetId, setMarginPresetId] = useState('rtd-malt');
  const [distributorMargin, setDistributorMargin] = useState(30);
  const [retailMargin, setRetailMargin] = useState(35);

  function applyMarginPreset(id) {
    const preset = SEGMENT_PRESETS.find((p) => p.id === id);
    if (!preset) return;
    setMarginPresetId(id);
    setDistributorMargin(preset.dist);
    setRetailMargin(preset.retail);
  }

  // Single source of truth: computeRunResults. Anywhere this number
  // ends up — KPI strip, matrix, pricing, insights, comparisons — it
  // came from the same place.
  const data = useMemo(() => deriveSummary(run), [run]);
  const compareData = useMemo(() => deriveSummary(compareRun), [compareRun]);

  if (!run || !data) {
    return (
      <div className="container">
        <div style={{ textAlign: 'center', padding: 60, color: 'var(--text-muted)' }}>
          <h2 style={{ fontSize: 24, fontWeight: 700, color: 'var(--text-primary)', marginBottom: 8 }}>No Run Selected</h2>
          <p>Save a run from the Co-Packing Calculator to view its cost summary here.</p>
          {runs.length > 0 && (
            <select value="" style={{ marginTop: 16, padding: '8px 12px', fontSize: 14 }}
              onChange={(e) => setSelectedRunId(e.target.value)}>
              <option value="">Select a saved run...</option>
              {runs.map((r) => <option key={r.id} value={r.id}>{r.name}</option>)}
            </select>
          )}
        </div>
      </div>
    );
  }

  const {
    flavorData, flavorCount, totalCans, totalCases, totalPallets,
    unitsPerCase, packSize, casesPerPallet,
    costRows, grandTotal, perFlavorTotals,
    costPerUnit, costPerCase, ingredientPerUnit, ingredientTotal,
  } = data;

  const costPerPack = costPerUnit * packSize;
  const costPerPallet = costPerCase * casesPerPallet; // full-pallet cost

  // Pricing — labels are MARGIN, math is margin (price - cost)/price = m,
  // so price = cost / (1 - m).
  const fob = fobPrice || costPerCase;
  const distributorPrice = fob / (1 - distributorMargin / 100);
  const retailPrice = distributorPrice / (1 - retailMargin / 100);
  const grossMargin = fob > 0 ? ((fob - costPerCase) / fob) * 100 : 0;

  return (
    <div className="container">
      {/* Header */}
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', marginBottom: 24 }}>
        <div>
          <div style={{ display: 'inline-block', padding: '3px 10px', background: 'var(--brand-100)', color: 'var(--brand)', borderRadius: 4, fontSize: 11, fontWeight: 700, letterSpacing: 0.5, textTransform: 'uppercase', marginBottom: 8 }}>
            Cost Sheet
          </div>
          <h1 style={{ fontSize: 28, fontWeight: 800, color: 'var(--text-primary)', margin: 0, lineHeight: 1.2 }}>
            {run.name || 'Untitled Run'}
          </h1>
          <p style={{ fontSize: 14, color: 'var(--text-secondary)', marginTop: 4 }}>
            {flavorCount} SKU{flavorCount !== 1 ? 's' : ''} &bull; {totalCans.toLocaleString()} units &bull; {totalCases.toLocaleString()} cases &bull; {totalPallets} pallets
          </p>
        </div>
        <div style={{ display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap', justifyContent: 'flex-end' }}>
          <select value={selectedRunId} style={{ padding: '8px 12px', fontSize: 13 }}
            onChange={(e) => setSelectedRunId(e.target.value)}>
            {runs.map((r) => <option key={r.id} value={r.id}>{r.name}</option>)}
          </select>
          <select value={compareRunId} style={{ padding: '8px 12px', fontSize: 13, color: compareRunId ? 'var(--text-primary)' : 'var(--text-muted)' }}
            onChange={(e) => setCompareRunId(e.target.value)} title="Compare against another saved run">
            <option value="">Compare to…</option>
            {runs.filter((r) => r.id !== selectedRunId).map((r) => <option key={r.id} value={r.id}>vs. {r.name}</option>)}
          </select>
          <button className="btn" onClick={() => window.print()} style={{ display: 'inline-flex' }}>Print / PDF</button>
        </div>
      </div>

      {/* KPI Cards — 6 cards. Headline: all-in cost/can AND blended raw-PO cost/can. */}
      <div className="cost-summary" style={{ gridTemplateColumns: 'repeat(6, minmax(0, 1fr))', marginBottom: 24 }}>
        <KpiCard
          label="Total Cost"
          value={`$${formatMoney(grandTotal)}`}
          delta={compareData ? grandTotal - compareData.grandTotal : null}
          deltaPrefix="$"
        />
        <KpiCard
          label="All-in / Can"
          value={`$${costPerUnit.toFixed(4)}`}
          delta={compareData ? costPerUnit - compareData.costPerUnit : null}
          deltaPrefix="$"
          deltaDigits={4}
        />
        <KpiCard
          label="Raw Mat / Can"
          subtitle="blended PO"
          value={`$${ingredientPerUnit.toFixed(4)}`}
          delta={compareData ? ingredientPerUnit - compareData.ingredientPerUnit : null}
          deltaPrefix="$"
          deltaDigits={4}
        />
        <KpiCard
          label="Per Case"
          subtitle={`${unitsPerCase} units`}
          value={`$${costPerCase.toFixed(2)}`}
          delta={compareData ? costPerCase - compareData.costPerCase : null}
          deltaPrefix="$"
        />
        <KpiCard
          label="Per Pack"
          subtitle={`${packSize}-pack`}
          value={`$${costPerPack.toFixed(2)}`}
          delta={compareData ? costPerPack - (compareData.costPerUnit * compareData.packSize) : null}
          deltaPrefix="$"
        />
        <KpiCard
          label="Per Full Pallet"
          subtitle={`${casesPerPallet} cases`}
          value={`$${formatMoney(costPerPallet)}`}
          delta={compareData ? costPerPallet - (compareData.costPerCase * compareData.casesPerPallet) : null}
          deltaPrefix="$"
          hero
        />
      </div>

      {/* Cost Matrix: Flavors in columns, cost components in rows */}
      <div className="section" style={{ marginBottom: 24 }}>
        <div className="section-header">
          <div className="section-title">Cost Breakdown by SKU</div>
          <div style={{ fontSize: 11, color: 'var(--text-muted)' }}>
            Ingredients are per-SKU (allocated from consolidated PO with bulk pricing).
            Shared categories allocated pro-rata by can share.
          </div>
        </div>
        <div style={{ overflowX: 'auto' }}>
          <table>
            <thead>
              <tr>
                <th style={{ minWidth: 180 }}>Cost Component</th>
                {flavorData.map((f) => (
                  <th key={f.id} style={{ textAlign: 'right', minWidth: 120 }}>
                    {f.name || 'Unnamed'}
                    <div style={{ fontSize: 10, fontWeight: 400, color: 'var(--text-muted)', textTransform: 'none', letterSpacing: 0 }}>
                      {f.cases} cases / {f.cans.toLocaleString()} cans
                    </div>
                  </th>
                ))}
                <th style={{ textAlign: 'right', minWidth: 120 }}>Run Total</th>
                {compareData && (
                  <th style={{ textAlign: 'right', minWidth: 120, color: 'var(--text-muted)' }}>
                    vs. Compare
                    <div style={{ fontSize: 10, fontWeight: 400, color: 'var(--text-muted)', textTransform: 'none', letterSpacing: 0 }}>
                      {compareRun?.name}
                    </div>
                  </th>
                )}
              </tr>
            </thead>
            <tbody>
              {costRows.map((row) => {
                const cmpRow = compareData?.costRows.find((r) => r.label === row.label);
                const cmpDelta = cmpRow ? row.total - cmpRow.total : null;
                return (
                  <tr key={row.label}>
                    <td style={{ fontWeight: 600 }}>{row.label}</td>
                    {row.perFlavor.map((cost, i) => (
                      <td key={i} style={{ textAlign: 'right' }}>
                        ${cost.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}
                      </td>
                    ))}
                    <td style={{ textAlign: 'right', fontWeight: 600 }}>
                      ${row.total.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}
                    </td>
                    {compareData && (
                      <td style={{ textAlign: 'right', color: deltaColor(cmpDelta) }}>
                        {cmpDelta === null ? '—' : `${cmpDelta >= 0 ? '+' : ''}$${cmpDelta.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`}
                      </td>
                    )}
                  </tr>
                );
              })}
            </tbody>
            <tfoot>
              <tr style={{ borderTop: '2px solid var(--border)' }}>
                <td style={{ fontWeight: 700 }}>Total</td>
                {perFlavorTotals.map((cost, i) => (
                  <td key={i} style={{ textAlign: 'right', fontWeight: 700 }}>
                    ${cost.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}
                  </td>
                ))}
                <td style={{ textAlign: 'right', fontWeight: 700, fontSize: 15 }}>
                  ${grandTotal.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}
                </td>
                {compareData && (
                  <td style={{ textAlign: 'right', fontWeight: 700, color: deltaColor(grandTotal - compareData.grandTotal) }}>
                    {(() => { const d = grandTotal - compareData.grandTotal; return `${d >= 0 ? '+' : ''}$${d.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`; })()}
                  </td>
                )}
              </tr>
              <tr>
                <td style={{ fontWeight: 600, color: 'var(--text-secondary)' }}>Cost / Unit</td>
                {flavorData.map((f, i) => (
                  <td key={i} style={{ textAlign: 'right', color: 'var(--text-secondary)' }}>
                    ${f.cans > 0 ? (perFlavorTotals[i] / f.cans).toFixed(4) : '0.0000'}
                  </td>
                ))}
                <td style={{ textAlign: 'right', fontWeight: 600 }}>${costPerUnit.toFixed(4)}</td>
                {compareData && (
                  <td style={{ textAlign: 'right', color: deltaColor(costPerUnit - compareData.costPerUnit) }}>
                    {(() => { const d = costPerUnit - compareData.costPerUnit; return `${d >= 0 ? '+' : ''}$${d.toFixed(4)}`; })()}
                  </td>
                )}
              </tr>
              <tr>
                <td style={{ fontWeight: 600, color: 'var(--text-secondary)' }}>Cost / Case</td>
                {flavorData.map((f, i) => (
                  <td key={i} style={{ textAlign: 'right', color: 'var(--text-secondary)' }}>
                    ${f.cases > 0 ? (perFlavorTotals[i] / f.cases).toFixed(2) : '0.00'}
                  </td>
                ))}
                <td style={{ textAlign: 'right', fontWeight: 600 }}>${costPerCase.toFixed(2)}</td>
                {compareData && (
                  <td style={{ textAlign: 'right', color: deltaColor(costPerCase - compareData.costPerCase) }}>
                    {(() => { const d = costPerCase - compareData.costPerCase; return `${d >= 0 ? '+' : ''}$${d.toFixed(2)}`; })()}
                  </td>
                )}
              </tr>
            </tfoot>
          </table>
        </div>
      </div>

      {/* Pricing & Margin Calculator */}
      <div className="section" style={{
        marginBottom: 12, padding: '10px 14px',
        background: 'var(--surface)', border: '1px solid var(--border-light)', borderRadius: 'var(--radius)',
        display: 'flex', alignItems: 'center', gap: 10,
      }}>
        <div style={{ fontSize: 11, fontWeight: 700, color: 'var(--text-muted)', textTransform: 'uppercase', letterSpacing: 0.5 }}>
          How to use
        </div>
        <div style={{ fontSize: 13, color: 'var(--text-secondary)' }}>
          Enter your <strong>FOB Price per case</strong> (what you'd quote the distributor). The calculator works forward through
          Distributor → Retail using the margin % defaults below — industry-typical for off-premise RTD: <strong>30% / 35%</strong>.
          Override any margin to model a specific channel.
        </div>
      </div>
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(320px, 1fr))', gap: 20, marginBottom: 24 }}>
        <div className="projection-card">
          <h3>Pricing Calculator</h3>
          <div style={{ marginBottom: 16 }}>
            <div style={{ fontSize: 11, color: 'rgba(255,255,255,0.6)', textTransform: 'uppercase', marginBottom: 4 }}>FOB Price (per case)</div>
            <div className="projection-total">${fob.toFixed(2)}</div>
            <div style={{ display: 'flex', alignItems: 'center', gap: 4 }}>
              <span style={{ fontSize: 14 }}>$</span>
              <input type="text" inputMode="decimal" defaultValue={fobPrice || ''} placeholder={costPerCase.toFixed(2)}
                style={{ fontSize: 18, fontWeight: 700, width: 100, background: 'rgba(255,255,255,0.1)', border: '1px solid rgba(255,255,255,0.2)', color: 'white', borderRadius: 6, padding: '4px 8px' }}
                onBlur={(e) => setFobPrice(e.target.value === '' ? 0 : +e.target.value)} />
            </div>
          </div>
          <div className="projection-row">
            <span className="label">Cost per Case</span>
            <span className="value">${costPerCase.toFixed(2)}</span>
          </div>
          <div className="projection-row">
            <span className="label">Gross Margin</span>
            <span className="value" style={{ color: grossMargin > 0 ? '#4ADE80' : '#F87171' }}>{grossMargin.toFixed(1)}%</span>
          </div>
          <div className="projection-row">
            <span className="label">Gross Profit / Case</span>
            <span className="value">${(fob - costPerCase).toFixed(2)}</span>
          </div>
        </div>

        <div className="section" style={{ margin: 0 }}>
          <div className="section-header">
            <div className="section-title">Channel Pricing</div>
          </div>
          <div className="section-body">
            <div className="form-group" style={{ marginBottom: 12 }}>
              <label className="form-label">Segment preset</label>
              <select value={marginPresetId} onChange={(e) => applyMarginPreset(e.target.value)}
                style={{ width: '100%' }}>
                {SEGMENT_PRESETS.map((p) => (
                  <option key={p.id} value={p.id}>
                    {p.label} ({p.dist}% / {p.retail}%)
                  </option>
                ))}
              </select>
            </div>
            <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 12, marginBottom: 16 }}>
              <div className="form-group" style={{ margin: 0 }}>
                <label className="form-label">Distributor Margin %</label>
                <input key={`dist-${marginPresetId}-${distributorMargin}`} type="text" inputMode="decimal" defaultValue={distributorMargin}
                  style={{ width: '100%' }}
                  onBlur={(e) => setDistributorMargin(e.target.value === '' ? 0 : +e.target.value)} />
              </div>
              <div className="form-group" style={{ margin: 0 }}>
                <label className="form-label">Retail Margin %</label>
                <input key={`retail-${marginPresetId}-${retailMargin}`} type="text" inputMode="decimal" defaultValue={retailMargin}
                  style={{ width: '100%' }}
                  onBlur={(e) => setRetailMargin(e.target.value === '' ? 0 : +e.target.value)} />
              </div>
            </div>
            <div style={{ fontSize: 11, color: 'var(--text-muted)', marginBottom: 8, marginTop: -4 }}>
              Margin = (price − cost) / price. e.g. 30% margin on $10 cost → $14.29 price.
            </div>
            <table>
              <thead>
                <tr>
                  <th>Level</th>
                  <th style={{ textAlign: 'right' }}>Per Case</th>
                  <th style={{ textAlign: 'right' }}>Per Pack</th>
                  <th style={{ textAlign: 'right' }}>Per Unit</th>
                </tr>
              </thead>
              <tbody>
                <tr>
                  <td style={{ fontWeight: 600 }}>COGS</td>
                  <td style={{ textAlign: 'right' }}>${costPerCase.toFixed(2)}</td>
                  <td style={{ textAlign: 'right' }}>${costPerPack.toFixed(2)}</td>
                  <td style={{ textAlign: 'right' }}>${costPerUnit.toFixed(4)}</td>
                </tr>
                <tr>
                  <td style={{ fontWeight: 600 }}>FOB to Distributor</td>
                  <td style={{ textAlign: 'right', fontWeight: 600, color: 'var(--brand)' }}>${fob.toFixed(2)}</td>
                  <td style={{ textAlign: 'right' }}>${(fob / unitsPerCase * packSize).toFixed(2)}</td>
                  <td style={{ textAlign: 'right' }}>${(fob / unitsPerCase).toFixed(4)}</td>
                </tr>
                <tr>
                  <td style={{ fontWeight: 600 }}>Distributor to Retail</td>
                  <td style={{ textAlign: 'right' }}>${distributorPrice.toFixed(2)}</td>
                  <td style={{ textAlign: 'right' }}>${(distributorPrice / unitsPerCase * packSize).toFixed(2)}</td>
                  <td style={{ textAlign: 'right' }}>${(distributorPrice / unitsPerCase).toFixed(4)}</td>
                </tr>
                <tr style={{ background: 'var(--surface-alt)' }}>
                  <td style={{ fontWeight: 700 }}>Retail MSRP</td>
                  <td style={{ textAlign: 'right', fontWeight: 700, fontSize: 15 }}>${retailPrice.toFixed(2)}</td>
                  <td style={{ textAlign: 'right', fontWeight: 700 }}>${(retailPrice / unitsPerCase * packSize).toFixed(2)}</td>
                  <td style={{ textAlign: 'right', fontWeight: 700 }}>${(retailPrice / unitsPerCase).toFixed(4)}</td>
                </tr>
              </tbody>
            </table>
          </div>
        </div>
      </div>

      {/* Insight Cards */}
      <div className="insight-cards">
        <div className="insight-card">
          <h4>Margin Analysis</h4>
          <p>
            {grossMargin > 0
              ? `At $${fob.toFixed(2)} FOB, you earn $${(fob - costPerCase).toFixed(2)} per case (${grossMargin.toFixed(1)}% margin) before distribution.`
              : 'Set an FOB price to see margin analysis.'}
          </p>
        </div>
        <div className="insight-card">
          <h4>Raw Materials Share</h4>
          <p>
            Ingredients (blended from consolidated PO) account for ${ingredientTotal.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}{' '}
            ({grandTotal > 0 ? ((ingredientTotal / grandTotal) * 100).toFixed(1) : '0'}% of total cost) — ${ingredientPerUnit.toFixed(4)}/can blended.
          </p>
        </div>
        <div className="insight-card">
          <h4>Retail Positioning</h4>
          <p>
            {retailPrice > 0
              ? `Suggested retail MSRP: $${(retailPrice / unitsPerCase * packSize).toFixed(2)} per ${packSize}-pack ($${(retailPrice / unitsPerCase).toFixed(2)}/can).`
              : 'Configure pricing to see retail positioning.'}
          </p>
        </div>
        <div className="insight-card">
          <h4>Run Economics</h4>
          <p>
            {grandTotal > 0
              ? `${flavorCount} SKU run at ${totalCases.toLocaleString()} cases. Average cost $${costPerCase.toFixed(2)}/case across all flavors.`
              : 'No cost data available.'}
          </p>
        </div>
      </div>
    </div>
  );
}

// ── Helpers ──────────────────────────────────────────────────────────

function deriveSummary(run) {
  if (!run) return null;
  const res = computeRunResults(run);
  if (!res) return null;
  const { config, counts, costs, breakdown } = res;
  const flavors = run.flavors || [];
  const unitsPerCase = config.unitsPerCase || 24;
  const packSize = config.packSize || 4;
  const casesPerPallet = config.casesPerPallet || 80;

  const flavorData = (counts.flavorRows || []).map((fr) => {
    const original = flavors.find((f) => f.id === fr.id) || {};
    return {
      ...original,
      id: fr.id,
      name: original.name || fr.name || 'Unnamed',
      cases: fr.cases || 0,
      cans: fr.cans || 0,
      pallets: fr.pallets || 0,
      ingredientCost: original.ingredientCost || 0,
      batchingFee: original.batchingFee || 0,
    };
  });

  const totalCans = counts.totalUnits || 0;
  const totalCases = counts.totalCases || 0;
  const totalPallets = counts.totalPallets || 0;
  const flavorCount = flavorData.length;

  // Per-flavor allocation:
  //   - Ingredients: flavor.ingredientCost × cans (each flavor's allocated
  //     share of the consolidated PO — captures bulk pricing).
  //   - Batching Fees: flavor.batchingFee (per-flavor).
  //   - Every other category: pro-rated by cans share.
  const allocateProRata = (totalCost) => flavorData.map((f) => (totalCans > 0 ? (f.cans / totalCans) * totalCost : 0));

  const costRows = (breakdown || [])
    .filter((row) => (row.cost || 0) !== 0)
    .map((row) => {
      const label = row.label;
      const total = row.cost || 0;
      let perFlavor;
      if (label.startsWith('Ingredients')) {
        perFlavor = flavorData.map((f) => (f.ingredientCost || 0) * f.cans);
      } else if (label.startsWith('Batching')) {
        perFlavor = flavorData.map((f) => f.batchingFee || 0);
      } else {
        perFlavor = allocateProRata(total);
      }
      return { label, perFlavor, total };
    });

  const grandTotal = costs.totalCost || 0;
  const perFlavorTotals = flavorData.map((_, i) => costRows.reduce((s, r) => s + r.perFlavor[i], 0));

  return {
    config, flavorData, flavorCount, totalCans, totalCases, totalPallets,
    unitsPerCase, packSize, casesPerPallet,
    costRows, grandTotal, perFlavorTotals,
    costPerUnit: costs.costPerUnit || 0,
    costPerCase: costs.costPerCase || 0,
    ingredientTotal: costs.totalIngredientCost || 0,
    ingredientPerUnit: totalCans > 0 ? (costs.totalIngredientCost || 0) / totalCans : 0,
  };
}

function KpiCard({ label, subtitle, value, delta, deltaPrefix = '', deltaDigits = 2, hero = false }) {
  return (
    <div className={`cost-card${hero ? ' hero' : ''}`}>
      <div className="cost-card-label">{label}</div>
      <div className="cost-card-value" style={{ fontSize: 22 }}>{value}</div>
      {subtitle && <div className="cost-card-subtitle">{subtitle}</div>}
      {delta !== null && delta !== undefined && (
        <div style={{ fontSize: 11, marginTop: 4, color: deltaColor(delta), fontWeight: 600 }}>
          {delta >= 0 ? '▲' : '▼'} {deltaPrefix}{Math.abs(delta).toLocaleString(undefined, {
            minimumFractionDigits: deltaDigits,
            maximumFractionDigits: deltaDigits,
          })}
        </div>
      )}
    </div>
  );
}

function deltaColor(delta) {
  if (delta == null) return 'var(--text-muted)';
  if (Math.abs(delta) < 0.005) return 'var(--text-muted)';
  return delta > 0 ? '#dc2626' : '#16a34a'; // delta > 0 means MORE cost = bad
}

function formatMoney(n) {
  return (n || 0).toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 });
}
