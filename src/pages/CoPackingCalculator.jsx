import { useState, useMemo, useEffect } from 'react';
import { getPackaging, getServices, getVendors, getCurrentBatch } from '../data/store';

const categoryColors = {
  cans: { bg: '#dbeafe', color: '#1e40af' },
  labels: { bg: '#fce7f3', color: '#9d174d' },
  cases: { bg: '#d1fae5', color: '#065f46' },
  carriers: { bg: '#fef3c7', color: '#92400e' },
  pallets: { bg: '#e0e7ff', color: '#3730a3' },
};

export default function CoPackingCalculator() {
  const vendors = getVendors();

  const [formulaName, setFormulaName] = useState('Citrus Energy Drink');
  const [batchSize, setBatchSize] = useState(500);
  const [batchSizeUnit, setBatchSizeUnit] = useState('gal');
  const [ingredientCost, setIngredientCost] = useState(778.15);
  const [fillVolume, setFillVolume] = useState(12);
  const [fillVolumeUnit, setFillVolumeUnit] = useState('oz');
  const [unitsPerCase, setUnitsPerCase] = useState(24);
  const [casesPerPallet, setCasesPerPallet] = useState(80);

  const [packagingItems, setPackagingItems] = useState(() => {
    return getPackaging().map((item) => ({
      ...item,
      qtyNeeded: 0,
      qtyOverride: null,
    }));
  });

  const [serviceItems, setServiceItems] = useState(() => {
    return getServices().map((item) => ({ ...item, qty: 0 }));
  });

  // Load batch on mount
  useEffect(() => {
    const batch = getCurrentBatch();
    if (batch) {
      if (batch.formulaName) setFormulaName(batch.formulaName);
      if (batch.batchSize) setBatchSize(batch.batchSize);
      if (batch.batchSizeUnit) setBatchSizeUnit(batch.batchSizeUnit);
    }
  }, []);

  // Compute unit/case/pallet counts
  const counts = useMemo(() => {
    let batchGal = batchSize;
    if (batchSizeUnit === 'L') batchGal = batchSize / 3.78541;

    let fillOz = fillVolume;
    if (fillVolumeUnit === 'mL') fillOz = fillVolume / 29.5735;
    else if (fillVolumeUnit === 'L') fillOz = fillVolume * 33.814;

    const totalUnits = fillOz > 0 ? Math.floor((batchGal * 128) / fillOz) : 0;
    const totalCases = unitsPerCase > 0 ? Math.ceil(totalUnits / unitsPerCase) : 0;
    const totalPallets = casesPerPallet > 0 ? Math.ceil(totalCases / casesPerPallet) : 0;

    return { totalUnits, totalCases, totalPallets };
  }, [batchSize, batchSizeUnit, fillVolume, fillVolumeUnit, unitsPerCase, casesPerPallet]);

  // Auto-populate packaging quantities
  useEffect(() => {
    setPackagingItems((prev) =>
      prev.map((item) => {
        if (item.qtyOverride !== null) return item;
        let qty = 0;
        const cat = item.category;
        if (cat === 'cans' || cat === 'labels') qty = counts.totalUnits;
        else if (cat === 'cases') qty = counts.totalCases;
        else if (cat === 'carriers') qty = Math.ceil(counts.totalUnits / 6);
        else if (cat === 'pallets') qty = counts.totalPallets;
        return { ...item, qtyNeeded: qty };
      })
    );
  }, [counts]);

  // Auto-populate service quantities
  useEffect(() => {
    setServiceItems((prev) =>
      prev.map((item) => {
        let qty = 0;
        if (item.feeType === 'per-unit') qty = counts.totalUnits;
        else if (item.feeType === 'fixed' || item.feeType === 'per-batch') qty = 1;
        else if (item.feeType === 'per-pallet') qty = counts.totalPallets;
        return { ...item, qty };
      })
    );
  }, [counts]);

  // Calculate costs
  const costs = useMemo(() => {
    let packagingCost = 0;
    const pkgRows = packagingItems.map((item) => {
      const firstTier = item.priceTiers?.[0] || {};
      const unitCost = firstTier.price || 0;
      const moq = firstTier.minQty || 1;
      const setupFee = firstTier.setupFee || 0;
      const qtyNeeded = item.qtyOverride !== null ? item.qtyOverride : item.qtyNeeded;
      const orderQty = Math.ceil(qtyNeeded / moq) * moq;
      const lineCost = orderQty * unitCost + setupFee;
      packagingCost += lineCost;
      return { ...item, unitCost, moq, setupFee, qtyNeeded, orderQty, lineCost };
    });

    let serviceCost = 0;
    const svcRows = serviceItems.map((item) => {
      const lineCost = (item.rate || 0) * (item.qty || 0);
      serviceCost += lineCost;
      return { ...item, lineCost };
    });

    const totalCost = ingredientCost + packagingCost + serviceCost;
    const costPerUnit = counts.totalUnits > 0 ? totalCost / counts.totalUnits : 0;
    const costPerCase = costPerUnit * unitsPerCase;

    return { pkgRows, svcRows, packagingCost, serviceCost, totalCost, costPerUnit, costPerCase };
  }, [packagingItems, serviceItems, ingredientCost, counts, unitsPerCase]);

  // Breakdown rows
  const breakdown = useMemo(() => {
    const total = costs.totalCost;
    const rows = [
      { label: 'Ingredients', cost: ingredientCost },
      { label: 'Packaging Materials', cost: costs.packagingCost },
      { label: 'Co-Packing Services', cost: costs.serviceCost },
    ];
    return rows.map((r) => ({
      ...r,
      perUnit: counts.totalUnits > 0 ? r.cost / counts.totalUnits : 0,
      pct: total > 0 ? (r.cost / total) * 100 : 0,
    }));
  }, [ingredientCost, costs, counts]);

  function addNewPackagingItem() {
    setPackagingItems((prev) => [
      ...prev,
      {
        id: 'PKG-NEW-' + Date.now(),
        name: 'New Item',
        category: 'cans',
        vendorId: '',
        priceTiers: [{ minQty: 1, maxQty: null, price: 0, setupFee: 0 }],
        qtyNeeded: counts.totalUnits,
        qtyOverride: null,
      },
    ]);
  }

  function addNewServiceItem() {
    setServiceItems((prev) => [
      ...prev,
      {
        id: 'SVC-NEW-' + Date.now(),
        name: 'New Service',
        providerId: '',
        feeType: 'per-unit',
        rate: 0,
        qty: counts.totalUnits,
      },
    ]);
  }

  function removePackagingItem(index) {
    setPackagingItems((prev) => prev.filter((_, i) => i !== index));
  }

  function removeServiceItem(index) {
    setServiceItems((prev) => prev.filter((_, i) => i !== index));
  }

  return (
    <div className="container">
      {/* Batch Info */}
      <div className="section">
        <div className="section-header">
          <div className="section-title">Batch Information</div>
        </div>
        <div className="section-body">
          <div className="form-grid-3">
            <div className="form-group" style={{ margin: 0 }}>
              <label className="form-label">Formula Name</label>
              <input type="text" value={formulaName} onChange={(e) => setFormulaName(e.target.value)} />
            </div>
            <div className="form-group" style={{ margin: 0 }}>
              <label className="form-label">Batch Size</label>
              <div className="input-with-unit">
                <input type="number" value={batchSize} onChange={(e) => setBatchSize(parseFloat(e.target.value) || 0)} />
                <select value={batchSizeUnit} onChange={(e) => setBatchSizeUnit(e.target.value)}>
                  <option value="gal">gal</option>
                  <option value="L">L</option>
                </select>
              </div>
            </div>
            <div className="form-group" style={{ margin: 0 }}>
              <label className="form-label">Ingredient Cost (from batch calc)</label>
              <input type="number" value={ingredientCost} step="0.01" onChange={(e) => setIngredientCost(parseFloat(e.target.value) || 0)} />
            </div>
          </div>
          <div className="form-grid-3" style={{ marginTop: 16 }}>
            <div className="form-group" style={{ margin: 0 }}>
              <label className="form-label">Fill Volume per Unit</label>
              <div className="input-with-unit">
                <input type="number" value={fillVolume} step="0.1" onChange={(e) => setFillVolume(parseFloat(e.target.value) || 0)} />
                <select value={fillVolumeUnit} onChange={(e) => setFillVolumeUnit(e.target.value)}>
                  <option value="oz">oz</option>
                  <option value="mL">mL</option>
                  <option value="L">L</option>
                </select>
              </div>
            </div>
            <div className="form-group" style={{ margin: 0 }}>
              <label className="form-label">Units per Case</label>
              <input type="number" value={unitsPerCase} onChange={(e) => setUnitsPerCase(parseInt(e.target.value) || 1)} />
            </div>
            <div className="form-group" style={{ margin: 0 }}>
              <label className="form-label">Cases per Pallet</label>
              <input type="number" value={casesPerPallet} onChange={(e) => setCasesPerPallet(parseInt(e.target.value) || 1)} />
            </div>
          </div>
        </div>
      </div>

      {/* Cost Summary */}
      <div className="cost-summary">
        <div className="cost-card">
          <div className="cost-card-label">Total Units</div>
          <div className="cost-card-value">{counts.totalUnits.toLocaleString()}</div>
          <div className="cost-card-subtitle">{counts.totalCases} cases &bull; {counts.totalPallets} pallets</div>
        </div>
        <div className="cost-card">
          <div className="cost-card-label">Total Cost</div>
          <div className="cost-card-value">${costs.totalCost.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}</div>
          <div className="cost-card-subtitle">All-in landed cost</div>
        </div>
        <div className="cost-card">
          <div className="cost-card-label">Cost per Unit</div>
          <div className="cost-card-value">${costs.costPerUnit.toFixed(4)}</div>
          <div className="cost-card-subtitle">Including all packaging & services</div>
        </div>
        <div className="cost-card">
          <div className="cost-card-label">Cost per Case</div>
          <div className="cost-card-value">${costs.costPerCase.toFixed(2)}</div>
          <div className="cost-card-subtitle">{unitsPerCase} units per case</div>
        </div>
      </div>

      {/* Smart Auto-Population Info */}
      <div className="alert alert-info" style={{ marginBottom: 20 }}>
        <div>
          <strong>Smart Auto-Population Enabled</strong>
          <div style={{ marginTop: 4 }}>
            Quantities auto-calculated based on batch parameters. <strong>Cans, labels</strong> = total units.{' '}
            <strong>Cases</strong> = total cases. <strong>Carriers</strong> = units / 6. <strong>Pallets</strong> = total pallets.
          </div>
        </div>
      </div>

      {/* Packaging Materials */}
      <div className="section" style={{ marginBottom: 20 }}>
        <div className="section-header">
          <div className="section-title">Hard Goods & Packaging Materials</div>
        </div>
        <div>
          <table>
            <thead>
              <tr>
                <th>Item & Vendor</th>
                <th style={{ textAlign: 'right' }}>Unit Cost</th>
                <th style={{ textAlign: 'right' }}>Qty Needed</th>
                <th style={{ textAlign: 'right' }}>Order Qty</th>
                <th style={{ textAlign: 'right' }}>Setup Fee</th>
                <th style={{ textAlign: 'right' }}>Line Cost</th>
                <th></th>
              </tr>
            </thead>
            <tbody>
              {costs.pkgRows.map((row, idx) => {
                const catStyle = categoryColors[row.category] || { bg: '#f3f4f6', color: '#374151' };
                return (
                  <tr key={row.id || idx}>
                    <td>
                      <div style={{ fontWeight: 600, marginBottom: 2 }}>{row.name}</div>
                      <div style={{ fontSize: 12, display: 'flex', gap: 8, alignItems: 'center' }}>
                        <span className="badge" style={{ background: catStyle.bg, color: catStyle.color }}>{row.category}</span>
                        <span style={{ color: '#6b7280' }}>{vendors.find((v) => v.id === row.vendorId)?.name || ''}</span>
                      </div>
                    </td>
                    <td style={{ textAlign: 'right' }}>${row.unitCost.toFixed(2)}</td>
                    <td style={{ textAlign: 'right' }}>
                      <input
                        type="number"
                        value={row.qtyOverride !== null ? row.qtyOverride : row.qtyNeeded}
                        style={{ width: 80, textAlign: 'right' }}
                        onChange={(e) => {
                          const val = parseInt(e.target.value) || 0;
                          setPackagingItems((prev) =>
                            prev.map((item, i) => (i === idx ? { ...item, qtyOverride: val, qtyNeeded: val } : item))
                          );
                        }}
                      />
                    </td>
                    <td style={{ textAlign: 'right', fontWeight: 600 }}>{row.orderQty.toLocaleString()}</td>
                    <td style={{ textAlign: 'right' }}>${row.setupFee.toFixed(2)}</td>
                    <td style={{ textAlign: 'right', fontWeight: 600 }}>${row.lineCost.toFixed(2)}</td>
                    <td>
                      <button className="btn btn-small btn-danger" onClick={() => removePackagingItem(idx)}>x</button>
                    </td>
                  </tr>
                );
              })}
            </tbody>
            <tfoot>
              <tr>
                <td colSpan={7} style={{ padding: 12 }}>
                  <button className="btn btn-primary" onClick={addNewPackagingItem} style={{ width: '100%', justifyContent: 'center' }}>
                    + Add Packaging Item
                  </button>
                </td>
              </tr>
            </tfoot>
          </table>
        </div>
      </div>

      {/* Services */}
      <div className="section" style={{ marginBottom: 20 }}>
        <div className="section-header">
          <div className="section-title">Co-Packing Services & Fees</div>
        </div>
        <div>
          <table>
            <thead>
              <tr>
                <th>Service</th>
                <th>Provider</th>
                <th>Fee Type</th>
                <th style={{ textAlign: 'right' }}>Rate</th>
                <th style={{ textAlign: 'right' }}>Qty/Units</th>
                <th style={{ textAlign: 'right' }}>Line Cost</th>
                <th></th>
              </tr>
            </thead>
            <tbody>
              {costs.svcRows.map((row, idx) => (
                <tr key={row.id || idx}>
                  <td style={{ fontWeight: 600 }}>{row.name}</td>
                  <td style={{ fontSize: 12, color: '#6b7280' }}>{vendors.find((v) => v.id === row.providerId)?.name || ''}</td>
                  <td>
                    <span className="badge badge-info">{row.feeType}</span>
                  </td>
                  <td style={{ textAlign: 'right' }}>
                    <input
                      type="number"
                      value={row.rate}
                      step="0.01"
                      style={{ width: 80, textAlign: 'right' }}
                      onChange={(e) => {
                        const val = parseFloat(e.target.value) || 0;
                        setServiceItems((prev) => prev.map((s, i) => (i === idx ? { ...s, rate: val } : s)));
                      }}
                    />
                  </td>
                  <td style={{ textAlign: 'right' }}>
                    <input
                      type="number"
                      value={row.qty}
                      style={{ width: 80, textAlign: 'right' }}
                      onChange={(e) => {
                        const val = parseInt(e.target.value) || 0;
                        setServiceItems((prev) => prev.map((s, i) => (i === idx ? { ...s, qty: val } : s)));
                      }}
                    />
                  </td>
                  <td style={{ textAlign: 'right', fontWeight: 600 }}>${row.lineCost.toFixed(2)}</td>
                  <td>
                    <button className="btn btn-small btn-danger" onClick={() => removeServiceItem(idx)}>x</button>
                  </td>
                </tr>
              ))}
            </tbody>
            <tfoot>
              <tr>
                <td colSpan={7} style={{ padding: 12 }}>
                  <button className="btn btn-primary" onClick={addNewServiceItem} style={{ width: '100%', justifyContent: 'center' }}>
                    + Add Service
                  </button>
                </td>
              </tr>
            </tfoot>
          </table>
        </div>
      </div>

      {/* Cost Breakdown */}
      <div className="section">
        <div className="section-header">
          <div className="section-title">Cost Breakdown</div>
        </div>
        <div>
          <table>
            <thead>
              <tr>
                <th>Category</th>
                <th style={{ textAlign: 'right' }}>Total Cost</th>
                <th style={{ textAlign: 'right' }}>Cost per Unit</th>
                <th style={{ textAlign: 'right' }}>% of Total</th>
              </tr>
            </thead>
            <tbody>
              {breakdown.map((row) => (
                <tr key={row.label}>
                  <td style={{ fontWeight: 600 }}>{row.label}</td>
                  <td style={{ textAlign: 'right' }}>${row.cost.toFixed(2)}</td>
                  <td style={{ textAlign: 'right' }}>${row.perUnit.toFixed(4)}</td>
                  <td style={{ textAlign: 'right' }}>{row.pct.toFixed(1)}%</td>
                </tr>
              ))}
            </tbody>
            <tfoot>
              <tr>
                <td style={{ fontWeight: 700 }}>Total</td>
                <td style={{ textAlign: 'right', fontWeight: 700 }}>${costs.totalCost.toFixed(2)}</td>
                <td style={{ textAlign: 'right', fontWeight: 700 }}>${costs.costPerUnit.toFixed(4)}</td>
                <td style={{ textAlign: 'right', fontWeight: 700 }}>100%</td>
              </tr>
            </tfoot>
          </table>
        </div>
      </div>
    </div>
  );
}
