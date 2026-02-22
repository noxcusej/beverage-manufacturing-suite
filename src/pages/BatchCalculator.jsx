import { useState, useEffect, useMemo, useCallback } from 'react';
import { getInventory, saveInventory, addInventoryItem, getVendors, getTankConfig, getCurrentBatch, saveBatch, getFormulas, saveFormula as saveFormulaToStore } from '../data/store';

const conversions = {
  gal_L: 3.78541, L_gal: 0.264172, gal_ml: 3785.41, ml_gal: 0.000264172,
  gal_oz: 128, oz_gal: 0.0078125, L_ml: 1000, ml_L: 0.001,
  L_oz: 33.814, oz_L: 0.0295735, oz_ml: 29.5735, ml_oz: 0.033814,
  lbs_kg: 0.453592, kg_lbs: 2.20462, lbs_g: 453.592, g_lbs: 0.00220462,
  oz_g: 28.3495, g_oz: 0.035274,
};

function convert(value, from, to) {
  if (from === to) return value;
  const key = `${from}_${to}`;
  if (conversions[key]) return value * conversions[key];
  const rev = `${to}_${from}`;
  if (conversions[rev]) return value / conversions[rev];
  return value;
}

const defaultIngredients = [
  { inventoryId: 'INV-001', type: 'liquid', recipeAmount: 85.5, recipeUnit: 'gal', specificGravity: 1.0, buyUnit: 'gal', pricePerBuyUnit: 0.003, moq: 1000 },
  { inventoryId: 'INV-002', type: 'dry', recipeAmount: 120, recipeUnit: 'lbs', specificGravity: 1.59, buyUnit: 'lbs', pricePerBuyUnit: 0.65, moq: 50 },
  { inventoryId: 'INV-003', type: 'dry', recipeAmount: 2.5, recipeUnit: 'lbs', specificGravity: 1.665, buyUnit: 'kg', pricePerBuyUnit: 6.50, moq: 11.34 },
  { inventoryId: 'INV-004', type: 'liquid', recipeAmount: 1.2, recipeUnit: 'gal', specificGravity: 1.0, buyUnit: 'gal', pricePerBuyUnit: 85.00, moq: 5 },
  { inventoryId: 'INV-005', type: 'dry', recipeAmount: 0.8, recipeUnit: 'lbs', specificGravity: 1.23, buyUnit: 'kg', pricePerBuyUnit: 275.00, moq: 2.27 },
  { inventoryId: 'INV-006', type: 'dry', recipeAmount: 0.15, recipeUnit: 'lbs', specificGravity: 1.44, buyUnit: 'lbs', pricePerBuyUnit: 4.50, moq: 10 },
];

export default function BatchCalculator() {
  const [inventoryArr, setInventoryArr] = useState(getInventory());
  const inventory = useMemo(() => {
    const obj = {};
    inventoryArr.forEach((item) => { obj[item.id] = item; });
    return obj;
  }, [inventoryArr]);

  const [unitSystem, setUnitSystem] = useState('imperial');
  const [formulaName, setFormulaName] = useState('Citrus Energy Drink');
  const [baseYield, setBaseYield] = useState(100);
  const [baseYieldUnit, setBaseYieldUnit] = useState('gal');
  const [batchSize, setBatchSize] = useState(500);
  const [batchSizeUnit, setBatchSizeUnit] = useState('gal');
  const [unitSizeVal, setUnitSizeVal] = useState(12);
  const [unitSizeUnit, setUnitSizeUnitState] = useState('oz');
  const [unitsPerCase, setUnitsPerCase] = useState(24);
  const [ingredients, setIngredients] = useState(defaultIngredients);
  const [showUnitCalc, setShowUnitCalc] = useState(false);

  useEffect(() => {
    const handler = () => setInventoryArr(getInventory());
    window.addEventListener('comanufacturing:datachange', handler);
    return () => window.removeEventListener('comanufacturing:datachange', handler);
  }, []);

  // Load saved batch on mount
  useEffect(() => {
    const batch = getCurrentBatch();
    if (batch) {
      if (batch.formulaName) setFormulaName(batch.formulaName);
      if (batch.batchSize) setBatchSize(batch.batchSize);
      if (batch.batchSizeUnit) setBatchSizeUnit(batch.batchSizeUnit);
      if (batch.baseYield) setBaseYield(batch.baseYield);
      if (batch.ingredients) setIngredients(batch.ingredients);
    }
  }, []);

  const scaleFactor = baseYield > 0 ? batchSize / baseYield : 1;

  // Calculate scaled batch data
  const scaledData = useMemo(() => {
    let totalCost = 0;
    const rows = ingredients.map((ing) => {
      const item = inventory[ing.inventoryId];
      const scaledRecipe = ing.recipeAmount * scaleFactor;

      // Convert recipe amount to buy unit amount
      let buyUnitAmount = scaledRecipe;
      if (ing.recipeUnit !== ing.buyUnit) {
        buyUnitAmount = convert(scaledRecipe, ing.recipeUnit, ing.buyUnit);
      }

      const orderQty = Math.ceil(buyUnitAmount / (ing.moq || 1)) * (ing.moq || 1);
      const slack = orderQty - buyUnitAmount;
      const lineCost = orderQty * (ing.pricePerBuyUnit || 0);
      totalCost += lineCost;

      // Liquid volume in gallons for volume tracking
      let liquidGal = 0;
      if (ing.type === 'liquid') {
        liquidGal = convert(scaledRecipe, ing.recipeUnit, 'gal');
      } else {
        const weightLbs = convert(scaledRecipe, ing.recipeUnit, 'lbs');
        const weightKg = weightLbs * 0.453592;
        const volumeL = weightKg / (ing.specificGravity || 1);
        liquidGal = volumeL * 0.264172;
      }

      return {
        ...ing,
        item,
        scaledRecipe,
        buyUnitAmount,
        orderQty,
        slack,
        lineCost,
        liquidGal,
        stockOk: item ? item.currentStock >= buyUnitAmount : false,
      };
    });

    return { rows, totalCost };
  }, [ingredients, inventory, scaleFactor]);

  // Tank allocation
  const tankAllocation = useMemo(() => {
    let batchGal = batchSize;
    if (batchSizeUnit === 'L') batchGal = batchSize / 3.78541;

    const tanks = getTankConfig();
    const sorted = [...tanks].sort((a, b) => b.capacity - a.capacity);
    let remaining = batchGal;
    const alloc = [];

    for (const tank of sorted) {
      if (remaining <= 0) break;
      const allocated = Math.min(remaining, tank.capacity);
      alloc.push({ ...tank, allocated, utilization: ((allocated / tank.capacity) * 100).toFixed(0) });
      remaining -= allocated;
    }

    const totalCap = sorted.reduce((s, t) => s + t.capacity, 0);
    return { alloc, canFit: remaining <= 0, remaining, batchGal, totalCap };
  }, [batchSize, batchSizeUnit]);

  // Unit economics
  const unitEcon = useMemo(() => {
    let batchGal = batchSize;
    if (batchSizeUnit === 'L') batchGal = batchSize / 3.78541;
    const batchOz = batchGal * 128;

    let unitOz = unitSizeVal;
    if (unitSizeUnit === 'ml') unitOz = unitSizeVal / 29.5735;
    if (unitSizeUnit === 'L') unitOz = unitSizeVal * 33.814;

    const totalUnits = unitOz > 0 ? Math.floor(batchOz / unitOz) : 0;
    const totalCases = unitsPerCase > 0 ? Math.ceil(totalUnits / unitsPerCase) : 0;
    const costPerUnit = totalUnits > 0 ? scaledData.totalCost / totalUnits : 0;
    const costPerCase = costPerUnit * unitsPerCase;
    return { totalUnits, totalCases, costPerUnit, costPerCase };
  }, [batchSize, batchSizeUnit, unitSizeVal, unitSizeUnit, unitsPerCase, scaledData.totalCost]);

  function updateIngredient(index, field, value) {
    setIngredients((prev) => prev.map((ing, i) => (i === index ? { ...ing, [field]: value } : ing)));
  }

  function removeIngredient(index) {
    setIngredients((prev) => prev.filter((_, i) => i !== index));
  }

  function addIngredient() {
    const invItems = getInventory();
    const used = new Set(ingredients.map((i) => i.inventoryId));
    const available = invItems.filter((i) => !used.has(i.id));
    if (available.length === 0) {
      alert('All inventory items are already in the formula');
      return;
    }
    const item = available[0];
    const tier = item.priceTiers?.[0];
    setIngredients((prev) => [
      ...prev,
      {
        inventoryId: item.id,
        type: item.type || 'liquid',
        recipeAmount: 0,
        recipeUnit: item.unit || 'gal',
        specificGravity: item.specificGravity || 1.0,
        buyUnit: tier?.buyUnit || item.unit || 'gal',
        pricePerBuyUnit: tier?.price || 0,
        moq: tier?.moq || 1,
      },
    ]);
  }

  function addDraftIngredient() {
    setIngredients((prev) => [
      ...prev,
      {
        inventoryId: '',
        draftName: 'New Ingredient',
        type: 'liquid',
        recipeAmount: 0,
        recipeUnit: 'gal',
        specificGravity: 1.0,
        buyUnit: 'gal',
        pricePerBuyUnit: 0,
        moq: 1,
      },
    ]);
  }

  function handleSaveFormula() {
    saveFormulaToStore({
      name: formulaName,
      baseYield, baseYieldUnit,
      batchSize, batchSizeUnit,
      ingredients,
    });
    alert('Formula saved!');
  }

  function handleSaveBatch() {
    saveBatch({
      formulaName, batchSize, batchSizeUnit, baseYield, baseYieldUnit,
      totalUnits: unitEcon.totalUnits,
      ingredients: JSON.parse(JSON.stringify(ingredients)),
    });
    alert('Batch saved! This batch context will persist across all calculator pages.');
  }

  function exportCSV() {
    const header = ['Item', 'SKU', 'Required', 'Buy Unit Amt', 'Price/Unit', 'MOQ', 'Order Qty', 'Line Cost'];
    const rows = scaledData.rows.map((r) => [
      r.item?.name || r.draftName || 'Unknown',
      r.item?.sku || '',
      r.scaledRecipe.toFixed(2) + ' ' + r.recipeUnit,
      r.buyUnitAmount.toFixed(2) + ' ' + r.buyUnit,
      '$' + (r.pricePerBuyUnit || 0).toFixed(4),
      r.moq,
      r.orderQty.toFixed(2),
      '$' + r.lineCost.toFixed(2),
    ]);
    const csv = [header, ...rows].map((r) => r.join(',')).join('\n');
    const blob = new Blob([csv], { type: 'text/csv' });
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = `batch_${formulaName.replace(/\s+/g, '_')}_${new Date().toISOString().split('T')[0]}.csv`;
    a.click();
  }

  return (
    <div className="container">
      <div className="grid batch-grid">
        {/* Main Column */}
        <div>
          {/* Formula Details */}
          <div className="section" style={{ marginBottom: 20 }}>
            <div className="section-header">
              <div className="section-title">Formula Details</div>
              <div style={{ display: 'flex', gap: 8 }}>
                <button className="btn btn-small" onClick={exportCSV}>Export CSV</button>
                <button className="btn btn-small btn-primary" onClick={handleSaveFormula}>Save Formula</button>
                <button className="btn btn-small" onClick={handleSaveBatch} style={{ background: '#059669', color: 'white', borderColor: '#059669' }}>Save Batch</button>
              </div>
            </div>
            <div className="section-body">
              <div className="form-grid-3">
                <div className="form-group" style={{ margin: 0 }}>
                  <label className="form-label">Formula Name</label>
                  <input type="text" value={formulaName} onChange={(e) => setFormulaName(e.target.value)} />
                </div>
                <div className="form-group" style={{ margin: 0 }}>
                  <label className="form-label">Base Yield</label>
                  <div className="input-with-unit">
                    <input type="number" value={baseYield} onChange={(e) => setBaseYield(parseFloat(e.target.value) || 0)} />
                    <select value={baseYieldUnit} onChange={(e) => setBaseYieldUnit(e.target.value)}>
                      <option value="gal">gal</option>
                      <option value="L">L</option>
                    </select>
                  </div>
                </div>
                <div className="form-group" style={{ margin: 0 }}>
                  <label className="form-label">Target Batch Size</label>
                  <div className="input-with-unit">
                    <input type="number" value={batchSize} onChange={(e) => setBatchSize(parseFloat(e.target.value) || 0)} />
                    <select value={batchSizeUnit} onChange={(e) => setBatchSizeUnit(e.target.value)}>
                      <option value="gal">gal</option>
                      <option value="L">L</option>
                    </select>
                  </div>
                </div>
                <div className="form-group" style={{ margin: 0 }}>
                  <label className="form-label">Unit Size</label>
                  <div className="input-with-unit">
                    <input type="number" value={unitSizeVal} onChange={(e) => setUnitSizeVal(parseFloat(e.target.value) || 0)} />
                    <select value={unitSizeUnit} onChange={(e) => setUnitSizeUnitState(e.target.value)}>
                      <option value="oz">oz</option>
                      <option value="ml">mL</option>
                      <option value="L">L</option>
                    </select>
                  </div>
                </div>
                <div className="form-group" style={{ margin: 0 }}>
                  <label className="form-label">Units per Case</label>
                  <input type="number" value={unitsPerCase} onChange={(e) => setUnitsPerCase(parseInt(e.target.value) || 1)} />
                </div>
                <div className="form-group" style={{ margin: 0 }}>
                  <label className="form-label">Unit System</label>
                  <div className="unit-toggle">
                    <button className={unitSystem === 'imperial' ? 'active' : ''} onClick={() => setUnitSystem('imperial')}>Imperial</button>
                    <button className={unitSystem === 'metric' ? 'active' : ''} onClick={() => setUnitSystem('metric')}>Metric</button>
                  </div>
                </div>
              </div>
            </div>
          </div>

          {/* Ingredients Table */}
          <div className="section" style={{ marginBottom: 20 }}>
            <div className="section-header">
              <div className="section-title">Ingredients</div>
            </div>
            <div>
              <table>
                <thead>
                  <tr>
                    <th>Inventory Item</th>
                    <th>Type</th>
                    <th>Recipe Amt</th>
                    <th>Recipe Unit</th>
                    <th>SG</th>
                    <th>Buy Unit</th>
                    <th>Price/Buy Unit</th>
                    <th>MOQ</th>
                    <th>Stock</th>
                    <th></th>
                  </tr>
                </thead>
                <tbody>
                  {ingredients.map((ing, idx) => {
                    const item = inventory[ing.inventoryId];
                    return (
                      <tr key={idx}>
                        <td>
                          {ing.inventoryId ? (
                            <select
                              value={ing.inventoryId}
                              onChange={(e) => {
                                const newItem = inventory[e.target.value];
                                if (newItem) {
                                  const tier = newItem.priceTiers?.[0];
                                  updateIngredient(idx, 'inventoryId', e.target.value);
                                  setIngredients((prev) =>
                                    prev.map((i, j) =>
                                      j === idx
                                        ? {
                                            ...i,
                                            inventoryId: e.target.value,
                                            type: newItem.type || i.type,
                                            specificGravity: newItem.specificGravity || i.specificGravity,
                                            buyUnit: tier?.buyUnit || newItem.unit || i.buyUnit,
                                            pricePerBuyUnit: tier?.price || i.pricePerBuyUnit,
                                            moq: tier?.moq || i.moq,
                                          }
                                        : i
                                    )
                                  );
                                }
                              }}
                              style={{ minWidth: 160 }}
                            >
                              <option value="">-- Select --</option>
                              {inventoryArr.map((inv) => (
                                <option key={inv.id} value={inv.id}>{inv.name}</option>
                              ))}
                            </select>
                          ) : (
                            <input
                              type="text"
                              value={ing.draftName || ''}
                              onChange={(e) => updateIngredient(idx, 'draftName', e.target.value)}
                              placeholder="Draft ingredient"
                              style={{ minWidth: 160 }}
                            />
                          )}
                        </td>
                        <td>
                          <select value={ing.type} onChange={(e) => updateIngredient(idx, 'type', e.target.value)}>
                            <option value="liquid">Liquid</option>
                            <option value="dry">Dry</option>
                          </select>
                        </td>
                        <td>
                          <input
                            type="number"
                            value={ing.recipeAmount}
                            onChange={(e) => updateIngredient(idx, 'recipeAmount', parseFloat(e.target.value) || 0)}
                            style={{ width: 80 }}
                          />
                        </td>
                        <td>
                          <select value={ing.recipeUnit} onChange={(e) => updateIngredient(idx, 'recipeUnit', e.target.value)}>
                            <option value="gal">gal</option><option value="L">L</option><option value="oz">oz</option>
                            <option value="ml">mL</option><option value="lbs">lbs</option><option value="kg">kg</option><option value="g">g</option>
                          </select>
                        </td>
                        <td>
                          <input
                            type="number"
                            value={ing.specificGravity}
                            onChange={(e) => updateIngredient(idx, 'specificGravity', parseFloat(e.target.value) || 1.0)}
                            step="0.01"
                            style={{ width: 60 }}
                          />
                        </td>
                        <td>
                          <select value={ing.buyUnit} onChange={(e) => updateIngredient(idx, 'buyUnit', e.target.value)}>
                            <option value="gal">gal</option><option value="L">L</option><option value="lbs">lbs</option>
                            <option value="kg">kg</option><option value="oz">oz</option><option value="g">g</option>
                          </select>
                        </td>
                        <td>
                          <input
                            type="number"
                            value={ing.pricePerBuyUnit}
                            onChange={(e) => updateIngredient(idx, 'pricePerBuyUnit', parseFloat(e.target.value) || 0)}
                            step="0.0001"
                            style={{ width: 90 }}
                          />
                        </td>
                        <td>
                          <input
                            type="number"
                            value={ing.moq}
                            onChange={(e) => updateIngredient(idx, 'moq', parseFloat(e.target.value) || 1)}
                            style={{ width: 70 }}
                          />
                        </td>
                        <td style={{ fontSize: 12, color: '#6b7280' }}>
                          {item ? `${item.currentStock} ${item.unit}` : '\u2014'}
                        </td>
                        <td>
                          <button className="btn btn-small btn-danger" onClick={() => removeIngredient(idx)}>x</button>
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
                <tfoot>
                  <tr>
                    <td colSpan={10} style={{ padding: 12, background: '#f9fafb', borderTop: '2px solid #e5e7eb' }}>
                      <div style={{ display: 'flex', gap: 8 }}>
                        <button className="btn btn-primary" onClick={addIngredient} style={{ flex: 1, justifyContent: 'center' }}>
                          + Add from Inventory
                        </button>
                        <button className="btn" onClick={addDraftIngredient} style={{ flex: 1, justifyContent: 'center' }}>
                          + Add Draft (Quick Entry)
                        </button>
                      </div>
                    </td>
                  </tr>
                </tfoot>
              </table>
            </div>
          </div>

          {/* Scaled Batch Requirements */}
          <div className="section">
            <div className="section-header">
              <div className="section-title">Scaled Batch Requirements & Purchase Order</div>
              <button className="btn btn-small" onClick={exportCSV}>Export CSV</button>
            </div>
            <div>
              <table>
                <thead>
                  <tr>
                    <th>Inventory Item</th>
                    <th>SKU</th>
                    <th>Required (Recipe)</th>
                    <th>Required (Buy Unit)</th>
                    <th>Price/Unit</th>
                    <th>MOQ</th>
                    <th>Order Qty</th>
                    <th>Slack</th>
                    <th>Stock</th>
                    <th>Line Cost</th>
                    <th>Status</th>
                  </tr>
                </thead>
                <tbody>
                  {scaledData.rows.map((row, idx) => (
                    <tr key={idx}>
                      <td style={{ fontWeight: 600 }}>{row.item?.name || row.draftName || 'Unknown'}</td>
                      <td style={{ fontSize: 12, color: '#6b7280' }}>{row.item?.sku || '\u2014'}</td>
                      <td>{row.scaledRecipe.toFixed(2)} {row.recipeUnit}</td>
                      <td>{row.buyUnitAmount.toFixed(2)} {row.buyUnit}</td>
                      <td>${(row.pricePerBuyUnit || 0).toFixed(4)}</td>
                      <td>{row.moq}</td>
                      <td style={{ fontWeight: 600 }}>{row.orderQty.toFixed(2)} {row.buyUnit}</td>
                      <td style={{ color: '#6b7280' }}>+{row.slack.toFixed(2)}</td>
                      <td>{row.item ? `${row.item.currentStock} ${row.item.unit}` : '\u2014'}</td>
                      <td style={{ fontWeight: 600 }}>${row.lineCost.toFixed(2)}</td>
                      <td>
                        <span className={`badge ${row.stockOk ? 'badge-success' : 'badge-warning'}`}>
                          {row.stockOk ? 'OK' : 'Order'}
                        </span>
                      </td>
                    </tr>
                  ))}
                </tbody>
                <tfoot>
                  <tr>
                    <td colSpan={9} style={{ textAlign: 'right', fontWeight: 600 }}>Total:</td>
                    <td style={{ fontWeight: 700, fontSize: 15 }}>${scaledData.totalCost.toFixed(2)}</td>
                    <td></td>
                  </tr>
                </tfoot>
              </table>
            </div>
          </div>
        </div>

        {/* Sidebar */}
        <div>
          {/* Batch Scaling */}
          <div className="section" style={{ marginBottom: 20 }}>
            <div className="section-header">
              <div className="section-title">Batch Scaling</div>
            </div>
            <div className="section-body">
              <div className="metric-box">
                <div className="metric-label">Scale Factor</div>
                <div className="metric-value">{scaleFactor.toFixed(2)}x</div>
                <div className="metric-secondary">
                  {baseYield} {baseYieldUnit} &rarr; {batchSize} {batchSizeUnit}
                </div>
              </div>
              <div className="alert alert-info" style={{ margin: 0 }}>
                Adjust "Target Batch Size" to scale the formula up or down
              </div>
            </div>
          </div>

          {/* Cost Analysis */}
          <div className="section" style={{ marginBottom: 20 }}>
            <div className="section-header">
              <div className="section-title">Cost Analysis</div>
              <button className="btn btn-small" onClick={() => setShowUnitCalc(!showUnitCalc)}>
                Unit Calculator
              </button>
            </div>
            <div className="section-body">
              <div className="metric-box">
                <div className="metric-label">Total Batch Cost</div>
                <div className="metric-value large">${scaledData.totalCost.toFixed(2)}</div>
                <div className="metric-secondary">
                  ${(batchSize > 0 ? scaledData.totalCost / batchSize : 0).toFixed(2)} per {batchSizeUnit}
                </div>
              </div>

              <div className="cost-breakdown">
                {scaledData.rows.map((row, idx) => (
                  <div key={idx} className="cost-row">
                    <span>{row.item?.name || row.draftName || 'Unknown'}</span>
                    <span>${row.lineCost.toFixed(2)}</span>
                  </div>
                ))}
                <div className="cost-row total">
                  <span>Total</span>
                  <span>${scaledData.totalCost.toFixed(2)}</span>
                </div>
              </div>

              {showUnitCalc && (
                <div style={{ marginTop: 24, paddingTop: 24, borderTop: '2px solid #e5e7eb' }}>
                  <div style={{ fontSize: 14, fontWeight: 600, marginBottom: 16 }}>
                    Finished Product Unit Economics
                  </div>
                  <div className="metric-box">
                    <div className="metric-label">Total Units</div>
                    <div className="metric-value">{unitEcon.totalUnits.toLocaleString()}</div>
                    <div className="metric-secondary">{unitEcon.totalCases.toLocaleString()} cases</div>
                  </div>
                  <div className="metric-box">
                    <div className="metric-label">Cost per Unit</div>
                    <div className="metric-value">${unitEcon.costPerUnit.toFixed(4)}</div>
                  </div>
                  <div className="metric-box">
                    <div className="metric-label">Cost per Case</div>
                    <div className="metric-value">${unitEcon.costPerCase.toFixed(2)}</div>
                  </div>
                </div>
              )}
            </div>
          </div>

          {/* Tank Allocation */}
          <div className="section" style={{ marginBottom: 20 }}>
            <div className="section-header">
              <div className="section-title">Tank Allocation</div>
            </div>
            <div className="section-body">
              {tankAllocation.batchGal === 0 ? (
                <div style={{ color: '#9ca3af', textAlign: 'center', padding: 20 }}>
                  Enter batch size to see tank allocation
                </div>
              ) : (
                <>
                  <div
                    style={{
                      marginBottom: 16, padding: 12,
                      background: tankAllocation.canFit ? '#d1fae5' : '#fee2e2',
                      border: `1px solid ${tankAllocation.canFit ? '#86efac' : '#fca5a5'}`,
                      borderRadius: 6,
                    }}
                  >
                    <div style={{ fontWeight: 600, color: tankAllocation.canFit ? '#065f46' : '#991b1b', marginBottom: 4 }}>
                      {tankAllocation.canFit ? 'Batch fits in available tanks' : 'Batch exceeds tank capacity'}
                    </div>
                    <div style={{ fontSize: 12, color: tankAllocation.canFit ? '#047857' : '#dc2626' }}>
                      {tankAllocation.batchGal.toFixed(1)} gal batch &bull; {tankAllocation.alloc.length} tank{tankAllocation.alloc.length !== 1 ? 's' : ''} needed
                    </div>
                  </div>
                  <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
                    {tankAllocation.alloc.map((tank) => (
                      <div key={tank.id} style={{ padding: 10, background: '#f9fafb', border: '1px solid #e5e7eb', borderRadius: 6 }}>
                        <div style={{ display: 'flex', justifyContent: 'space-between', marginBottom: 6 }}>
                          <span style={{ fontWeight: 600 }}>{tank.name}</span>
                          <span style={{ fontSize: 12, color: '#6b7280' }}>{tank.allocated.toFixed(1)} / {tank.capacity} {tank.unit}</span>
                        </div>
                        <div style={{ height: 6, background: '#e5e7eb', borderRadius: 3, overflow: 'hidden' }}>
                          <div style={{ height: '100%', background: '#3b82f6', width: `${tank.utilization}%` }} />
                        </div>
                        <div style={{ fontSize: 11, color: '#6b7280', marginTop: 4 }}>{tank.utilization}% full</div>
                      </div>
                    ))}
                  </div>
                </>
              )}
            </div>
          </div>

          {/* Inventory Alerts */}
          <div className="section">
            <div className="section-header">
              <div className="section-title">Inventory Alerts</div>
            </div>
            <div className="section-body">
              {scaledData.rows.filter((r) => !r.stockOk).length === 0 ? (
                <div className="alert alert-info" style={{ margin: 0 }}>All ingredients are in stock for this batch</div>
              ) : (
                scaledData.rows
                  .filter((r) => !r.stockOk)
                  .map((r, idx) => (
                    <div key={idx} className="alert alert-warning" style={{ marginBottom: 8 }}>
                      <strong>{r.item?.name || r.draftName}</strong>: Need {r.buyUnitAmount.toFixed(2)} {r.buyUnit}, have {r.item?.currentStock || 0} {r.item?.unit || r.buyUnit}
                    </div>
                  ))
              )}
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}
