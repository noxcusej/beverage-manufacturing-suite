import { useState, useMemo, useEffect } from 'react';
import { getRuns } from '../data/store';

export default function Summary() {
  const [runs, setRuns] = useState([]);
  const [selectedRunId, setSelectedRunId] = useState('');

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

  // Pricing calculator state
  const [fobPrice, setFobPrice] = useState(0);
  const [distributorMarkup, setDistributorMarkup] = useState(30);
  const [retailMarkup, setRetailMarkup] = useState(40);

  // Derive all data from the run
  const data = useMemo(() => {
    if (!run) return null;
    const config = run.config || {};
    const flavors = run.flavors || [];
    const packagingItems = run.packagingItems || [];
    const tollingItems = run.tollingItems || [];
    const bomItems = run.bomItems || [];
    const taxItems = run.taxItems || [];
    const unitsPerCase = config.unitsPerCase || 24;
    const packSize = config.packSize || 4;
    const casesPerPallet = config.casesPerPallet || 80;
    // Compute per-flavor counts
    const flavorData = flavors.map((f) => {
      const cases = f.cases || 0;
      const cans = cases * unitsPerCase;
      const packs = packSize > 0 ? Math.ceil(cans / packSize) : 0;
      const pallets = casesPerPallet > 0 ? Math.ceil(cases / casesPerPallet) : 0;
      return { ...f, cans, cases, packs, pallets };
    });

    const totalCans = flavorData.reduce((s, f) => s + f.cans, 0);
    const totalCases = flavorData.reduce((s, f) => s + f.cases, 0);
    const totalPallets = flavorData.reduce((s, f) => s + f.pallets, 0);
    const flavorCount = flavors.length;

    // Shared costs (allocated proportionally by can count)
    function calcSharedCost(items, freightInId) {
      let total = 0;
      items.forEach((item) => {
        let qty = 0;
        const ft = item.feeType;
        if (ft === 'per-unit') qty = totalCans;
        else if (ft === 'per-pack') qty = packSize > 0 ? Math.ceil(totalCans / packSize) : 0;
        else if (ft === 'per-case') qty = totalCases;
        else if (ft === 'per-pallet') qty = item.id === freightInId ? Math.max(1, Math.ceil(totalPallets * 0.75)) : totalPallets;
        else if (ft === 'per-batch') qty = flavorCount;
        else if (ft === 'fixed') qty = 1;
        total += (item.rate || 0) * (item.qtyManual ? (item.qty || 0) : qty);
      });
      return total;
    }

    const packagingTotal = calcSharedCost(packagingItems.filter((p) => !(p.category === 'carriers' && config.carrierType === 'carton')));
    const tollingTotal = calcSharedCost(tollingItems);
    const bomTotal = calcSharedCost(bomItems, 'bom-freight-in');
    const taxTotal = calcSharedCost(taxItems);

    // Cost rows: each row has a label and per-flavor + total values
    const costRows = [];

    // Per-SKU ingredient costs
    costRows.push({
      label: 'Ingredients',
      perFlavor: flavorData.map((f) => (f.ingredientCost || 0) * f.cans),
      total: flavorData.reduce((s, f) => s + (f.ingredientCost || 0) * f.cans, 0),
    });

    costRows.push({
      label: 'Batching Fees',
      perFlavor: flavorData.map((f) => f.batchingFee || 0),
      total: flavorData.reduce((s, f) => s + (f.batchingFee || 0), 0),
    });

    // Shared costs — allocated proportionally by each flavor's can share
    function allocate(totalCost) {
      return flavorData.map((f) => totalCans > 0 ? (f.cans / totalCans) * totalCost : 0);
    }

    costRows.push({ label: 'Packaging Materials', perFlavor: allocate(packagingTotal), total: packagingTotal });
    costRows.push({ label: 'Tolling', perFlavor: allocate(tollingTotal), total: tollingTotal });
    costRows.push({ label: 'Bill of Materials', perFlavor: allocate(bomTotal), total: bomTotal });
    costRows.push({ label: 'Taxes & Regulatory', perFlavor: allocate(taxTotal), total: taxTotal });

    // Totals
    const grandTotal = costRows.reduce((s, r) => s + r.total, 0);
    const perFlavorTotals = flavorData.map((_, i) => costRows.reduce((s, r) => s + r.perFlavor[i], 0));

    return {
      config, flavorData, flavorCount, totalCans, totalCases, totalPallets,
      unitsPerCase, packSize, casesPerPallet,
      costRows, grandTotal, perFlavorTotals,
    };
  }, [run]);

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

  const costPerUnit = data.totalCans > 0 ? data.grandTotal / data.totalCans : 0;
  const costPerCase = costPerUnit * data.unitsPerCase;
  const costPerPack = costPerUnit * data.packSize;
  const costPerPallet = costPerCase * data.casesPerPallet;

  // Pricing calculations
  const fob = fobPrice || costPerCase;
  const distributorPrice = fob / (1 - distributorMarkup / 100);
  const retailPrice = distributorPrice / (1 - retailMarkup / 100);
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
            {data.flavorCount} SKU{data.flavorCount !== 1 ? 's' : ''} &bull; {data.totalCans.toLocaleString()} units &bull; {data.totalCases.toLocaleString()} cases &bull; {data.totalPallets} pallets
          </p>
        </div>
        <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
          <select value={selectedRunId} style={{ padding: '8px 12px', fontSize: 13 }}
            onChange={(e) => setSelectedRunId(e.target.value)}>
            {runs.map((r) => <option key={r.id} value={r.id}>{r.name}</option>)}
          </select>
          <button className="btn" onClick={() => window.print()} style={{ display: 'inline-flex' }}>Print / PDF</button>
        </div>
      </div>

      {/* KPI Cards */}
      <div className="cost-summary" style={{ gridTemplateColumns: 'repeat(5, 1fr)', marginBottom: 24 }}>
        <div className="cost-card">
          <div className="cost-card-label">Total Cost</div>
          <div className="cost-card-value" style={{ fontSize: 22 }}>${data.grandTotal.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}</div>
        </div>
        <div className="cost-card">
          <div className="cost-card-label">Per Unit</div>
          <div className="cost-card-value" style={{ fontSize: 22 }}>${costPerUnit.toFixed(4)}</div>
        </div>
        <div className="cost-card">
          <div className="cost-card-label">Per Case</div>
          <div className="cost-card-value" style={{ fontSize: 22 }}>${costPerCase.toFixed(2)}</div>
          <div className="cost-card-subtitle">{data.unitsPerCase} units</div>
        </div>
        <div className="cost-card">
          <div className="cost-card-label">Per Pack</div>
          <div className="cost-card-value" style={{ fontSize: 22 }}>${costPerPack.toFixed(2)}</div>
          <div className="cost-card-subtitle">{data.packSize}-pack</div>
        </div>
        <div className="cost-card hero">
          <div className="cost-card-label">Per Pallet</div>
          <div className="cost-card-value" style={{ fontSize: 22 }}>${costPerPallet.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}</div>
          <div className="cost-card-subtitle">{data.casesPerPallet} cases</div>
        </div>
      </div>

      {/* Cost Matrix: Flavors in columns, cost components in rows */}
      <div className="section" style={{ marginBottom: 24 }}>
        <div className="section-header">
          <div className="section-title">Cost Breakdown by SKU</div>
        </div>
        <div style={{ overflowX: 'auto' }}>
          <table>
            <thead>
              <tr>
                <th style={{ minWidth: 180 }}>Cost Component</th>
                {data.flavorData.map((f) => (
                  <th key={f.id} style={{ textAlign: 'right', minWidth: 120 }}>
                    {f.name || 'Unnamed'}
                    <div style={{ fontSize: 10, fontWeight: 400, color: 'var(--text-muted)', textTransform: 'none', letterSpacing: 0 }}>
                      {f.cases} cases / {f.cans.toLocaleString()} cans
                    </div>
                  </th>
                ))}
                <th style={{ textAlign: 'right', minWidth: 120 }}>Run Total</th>
              </tr>
            </thead>
            <tbody>
              {data.costRows.map((row) => (
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
                </tr>
              ))}
            </tbody>
            <tfoot>
              <tr style={{ borderTop: '2px solid var(--border)' }}>
                <td style={{ fontWeight: 700 }}>Total</td>
                {data.perFlavorTotals.map((cost, i) => (
                  <td key={i} style={{ textAlign: 'right', fontWeight: 700 }}>
                    ${cost.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}
                  </td>
                ))}
                <td style={{ textAlign: 'right', fontWeight: 700, fontSize: 15 }}>
                  ${data.grandTotal.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}
                </td>
              </tr>
              <tr>
                <td style={{ fontWeight: 600, color: 'var(--text-secondary)' }}>Cost / Unit</td>
                {data.flavorData.map((f, i) => (
                  <td key={i} style={{ textAlign: 'right', color: 'var(--text-secondary)' }}>
                    ${f.cans > 0 ? (data.perFlavorTotals[i] / f.cans).toFixed(4) : '0.0000'}
                  </td>
                ))}
                <td style={{ textAlign: 'right', fontWeight: 600 }}>${costPerUnit.toFixed(4)}</td>
              </tr>
              <tr>
                <td style={{ fontWeight: 600, color: 'var(--text-secondary)' }}>Cost / Case</td>
                {data.flavorData.map((f, i) => (
                  <td key={i} style={{ textAlign: 'right', color: 'var(--text-secondary)' }}>
                    ${f.cases > 0 ? (data.perFlavorTotals[i] / f.cases).toFixed(2) : '0.00'}
                  </td>
                ))}
                <td style={{ textAlign: 'right', fontWeight: 600 }}>${costPerCase.toFixed(2)}</td>
              </tr>
            </tfoot>
          </table>
        </div>
      </div>

      {/* Pricing & Margin Calculator */}
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
            <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 12, marginBottom: 16 }}>
              <div className="form-group" style={{ margin: 0 }}>
                <label className="form-label">Distributor Markup %</label>
                <input type="text" inputMode="decimal" defaultValue={distributorMarkup}
                  style={{ width: '100%' }}
                  onBlur={(e) => setDistributorMarkup(e.target.value === '' ? 0 : +e.target.value)} />
              </div>
              <div className="form-group" style={{ margin: 0 }}>
                <label className="form-label">Retail Markup %</label>
                <input type="text" inputMode="decimal" defaultValue={retailMarkup}
                  style={{ width: '100%' }}
                  onBlur={(e) => setRetailMarkup(e.target.value === '' ? 0 : +e.target.value)} />
              </div>
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
                  <td style={{ textAlign: 'right' }}>${(fob / data.unitsPerCase * data.packSize).toFixed(2)}</td>
                  <td style={{ textAlign: 'right' }}>${(fob / data.unitsPerCase).toFixed(4)}</td>
                </tr>
                <tr>
                  <td style={{ fontWeight: 600 }}>Distributor to Retail</td>
                  <td style={{ textAlign: 'right' }}>${distributorPrice.toFixed(2)}</td>
                  <td style={{ textAlign: 'right' }}>${(distributorPrice / data.unitsPerCase * data.packSize).toFixed(2)}</td>
                  <td style={{ textAlign: 'right' }}>${(distributorPrice / data.unitsPerCase).toFixed(4)}</td>
                </tr>
                <tr style={{ background: 'var(--surface-alt)' }}>
                  <td style={{ fontWeight: 700 }}>Retail MSRP</td>
                  <td style={{ textAlign: 'right', fontWeight: 700, fontSize: 15 }}>${retailPrice.toFixed(2)}</td>
                  <td style={{ textAlign: 'right', fontWeight: 700 }}>${(retailPrice / data.unitsPerCase * data.packSize).toFixed(2)}</td>
                  <td style={{ textAlign: 'right', fontWeight: 700 }}>${(retailPrice / data.unitsPerCase).toFixed(4)}</td>
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
          <h4>Retail Positioning</h4>
          <p>
            {retailPrice > 0
              ? `Suggested retail MSRP: $${(retailPrice / data.unitsPerCase * data.packSize).toFixed(2)} per ${data.packSize}-pack ($${(retailPrice / data.unitsPerCase).toFixed(2)}/can).`
              : 'Configure pricing to see retail positioning.'}
          </p>
        </div>
        <div className="insight-card">
          <h4>Run Economics</h4>
          <p>
            {data.grandTotal > 0
              ? `${data.flavorCount} SKU run at ${data.totalCases.toLocaleString()} cases. Average cost $${costPerCase.toFixed(2)}/case across all flavors.`
              : 'No cost data available.'}
          </p>
        </div>
      </div>
    </div>
  );
}
