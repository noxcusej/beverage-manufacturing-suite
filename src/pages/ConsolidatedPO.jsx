import { useState, useEffect, useMemo, useCallback } from 'react';
import * as XLSX from 'xlsx';
import { getFormulas, getInventory, hydrateFormulasFromSupabase } from '../data/store';

// Unit conversion tables
const weightFactors = { lbs: 1, lb: 1, kg: 2.20462, g: 0.00220462, oz: 0.0625 };
const volumeFactors = { gal: 1, L: 0.264172, ml: 0.000264172, 'fl oz': 0.0078125 };
const weightUnits = new Set(['lbs', 'lb', 'kg', 'g', 'oz']);
const volumeUnits = new Set(['gal', 'L', 'ml', 'fl oz']);

function convert(value, from, to) {
  if (from === to) return value;
  if (weightFactors[from] && weightFactors[to]) return value * (weightFactors[from] / weightFactors[to]);
  if (volumeFactors[from] && volumeFactors[to]) return value * (volumeFactors[from] / volumeFactors[to]);
  return value;
}

function convertWithSG(value, from, to, sg) {
  if (from === to) return value;
  const fromIsWeight = weightUnits.has(from);
  const toIsVolume = volumeUnits.has(to);
  const fromIsVolume = volumeUnits.has(from);
  const toIsWeight = weightUnits.has(to);
  if (fromIsWeight && toIsVolume) {
    const lbs = convert(value, from, 'lbs');
    const gal = lbs / 8.345 * (sg || 1);
    return convert(gal, 'gal', to);
  }
  if (fromIsVolume && toIsWeight) {
    const gal = convert(value, from, 'gal');
    const lbs = gal * 8.345 / (sg || 1);
    return convert(lbs, 'lbs', to);
  }
  return convert(value, from, to);
}

function calcBatchSizeFromCases(formula, cases) {
  const {
    unitSizeVal = 12,
    unitSizeUnit = 'oz',
    unitsPerCase = 24,
    batchSizeUnit = 'gal',
  } = formula;
  const units = cases * unitsPerCase;
  let unitOz = unitSizeVal;
  if (unitSizeUnit === 'ml') unitOz = unitSizeVal / 29.5703;
  else if (unitSizeUnit === 'L') unitOz = unitSizeVal * 33.814;
  const totalGal = (units * unitOz) / 128;
  return batchSizeUnit === 'L' ? totalGal * 3.78541 : totalGal;
}

function calcIngredientNeeds(formula, cases, inventoryMap) {
  const batchSize = calcBatchSizeFromCases(formula, cases);
  const baseYield = formula.baseYield || 100;
  const scaleFactor = baseYield > 0 ? batchSize / baseYield : 1;

  return (formula.ingredients || []).map((ing) => {
    const item = inventoryMap[ing.inventoryId];
    const scaledRecipe = (ing.recipeAmount || 0) * scaleFactor;

    let buyUnitAmount = scaledRecipe;
    if (ing.recipeUnit && ing.buyUnit && ing.recipeUnit !== ing.buyUnit) {
      buyUnitAmount = convertWithSG(scaledRecipe, ing.recipeUnit, ing.buyUnit, ing.specificGravity);
    }

    return {
      inventoryId: ing.inventoryId || null,
      draftName: ing.draftName || '',
      name: item?.name || ing.draftName || 'Unknown',
      sku: item?.sku || '',
      vendor: item?.vendor || '',
      buyUnit: ing.buyUnit || ing.recipeUnit || 'gal',
      buyUnitAmount,
      pricePerBuyUnit: ing.pricePerBuyUnit || 0,
      moq: ing.moq || 1,
      specificGravity: ing.specificGravity || 1,
    };
  });
}

// Build a stable key for grouping identical ingredients across formulas
function ingKey(ing) {
  return ing.inventoryId || `draft:${ing.draftName}`;
}

export default function ConsolidatedPO() {
  const [formulas, setFormulas] = useState([]);
  const [inventoryArr, setInventoryArr] = useState([]);
  const [selected, setSelected] = useState({}); // { formulaId: true }
  const [caseCounts, setCaseCounts] = useState({}); // { formulaId: number }
  const [generated, setGenerated] = useState(false);
  const [loading, setLoading] = useState(true);

  const refresh = useCallback(() => {
    setFormulas(getFormulas());
    setInventoryArr(getInventory());
  }, []);

  useEffect(() => {
    hydrateFormulasFromSupabase().then(() => {
      refresh();
      setLoading(false);
    });
    const handler = () => refresh();
    window.addEventListener('comanufacturing:datachange', handler);
    return () => window.removeEventListener('comanufacturing:datachange', handler);
  }, [refresh]);

  const inventoryMap = useMemo(() => {
    const map = {};
    inventoryArr.forEach((item) => { map[item.id] = item; });
    return map;
  }, [inventoryArr]);

  // Group formulas by client for display
  const formulaGroups = useMemo(() => {
    const groups = {};
    formulas.forEach((f) => {
      const client = f.client || 'Uncategorized';
      if (!groups[client]) groups[client] = [];
      groups[client].push(f);
    });
    return groups;
  }, [formulas]);

  const selectedIds = Object.keys(selected).filter((id) => selected[id]);

  function toggleFormula(id) {
    setSelected((s) => ({ ...s, [id]: !s[id] }));
    setGenerated(false);
  }

  function setCases(id, val) {
    const n = parseInt(val, 10);
    setCaseCounts((c) => ({ ...c, [id]: isNaN(n) ? 0 : n }));
    setGenerated(false);
  }

  // Aggregated PO data
  const poData = useMemo(() => {
    if (!generated) return null;
    const selectedFormulas = formulas.filter((f) => selected[f.id]);
    if (selectedFormulas.length === 0) return null;

    // Aggregate ingredient needs
    const aggregated = {}; // key -> { name, sku, vendor, buyUnit, totalAmount, pricePerBuyUnit, moq }
    const formulaSummaries = [];

    selectedFormulas.forEach((formula) => {
      const cases = caseCounts[formula.id] || 0;
      if (cases <= 0) return;
      const needs = calcIngredientNeeds(formula, cases, inventoryMap);
      formulaSummaries.push({ name: formula.name, client: formula.client, cases });

      needs.forEach((n) => {
        const k = ingKey(n);
        if (!aggregated[k]) {
          aggregated[k] = { ...n, totalAmount: 0 };
        }
        aggregated[k].totalAmount += n.buyUnitAmount;
        // Keep freshest price/moq (same item across formulas should be consistent)
        if (n.pricePerBuyUnit > 0) aggregated[k].pricePerBuyUnit = n.pricePerBuyUnit;
        if (n.moq > 1) aggregated[k].moq = n.moq;
      });
    });

    // MOQ-adjust totals
    const rows = Object.values(aggregated).map((item) => {
      const moq = item.moq || 1;
      const orderQty = moq > 0 ? Math.ceil(item.totalAmount / moq) * moq : item.totalAmount;
      const lineCost = orderQty * (item.pricePerBuyUnit || 0);
      return { ...item, orderQty, lineCost };
    });

    // Group by vendor
    const byVendor = {};
    rows.forEach((row) => {
      const vendor = row.vendor || 'No Vendor';
      if (!byVendor[vendor]) byVendor[vendor] = { rows: [], subtotal: 0 };
      byVendor[vendor].rows.push(row);
      byVendor[vendor].subtotal += row.lineCost;
    });

    const grandTotal = rows.reduce((sum, r) => sum + r.lineCost, 0);

    return { byVendor, grandTotal, formulaSummaries, rowCount: rows.length };
  }, [generated, formulas, selected, caseCounts, inventoryMap]);

  function handleGenerate() {
    const validSelections = selectedIds.filter((id) => (caseCounts[id] || 0) > 0);
    if (validSelections.length === 0) {
      alert('Select at least one formula with a case count > 0.');
      return;
    }
    setGenerated(true);
  }

  function exportToExcel() {
    if (!poData) return;
    const wb = XLSX.utils.book_new();

    // Sheet 1: Summary
    const summaryData = [
      ['CONSOLIDATED PURCHASE ORDER'],
      ['Generated: ' + new Date().toLocaleString()],
      [],
      ['FORMULAS INCLUDED'],
      ['Formula', 'Client', 'Cases'],
      ...poData.formulaSummaries.map((f) => [f.name, f.client || '', f.cases]),
      [],
      ['GRAND TOTAL', '', '', '', '$' + poData.grandTotal.toFixed(2)],
    ];
    const wsSummary = XLSX.utils.aoa_to_sheet(summaryData);
    wsSummary['!cols'] = [{ wch: 35 }, { wch: 20 }, { wch: 12 }, { wch: 12 }, { wch: 14 }];
    XLSX.utils.book_append_sheet(wb, wsSummary, 'Summary');

    // Sheet 2: By Supplier
    const poRows = [
      ['CONSOLIDATED PO — BY SUPPLIER'],
      [],
      ['Supplier', 'Ingredient', 'SKU', 'Total Needed', 'Unit', 'MOQ', 'Order Qty', 'Price/Unit', 'Line Total'],
    ];
    Object.entries(poData.byVendor).forEach(([vendor, group]) => {
      group.rows.forEach((row, i) => {
        poRows.push([
          i === 0 ? vendor : '',
          row.name,
          row.sku || '',
          row.totalAmount.toFixed(3),
          row.buyUnit,
          row.moq,
          row.orderQty.toFixed(3),
          (row.pricePerBuyUnit || 0).toFixed(4),
          row.lineCost.toFixed(2),
        ]);
      });
      poRows.push(['', '', '', '', '', '', '', 'Subtotal:', group.subtotal.toFixed(2)]);
      poRows.push([]);
    });
    poRows.push(['', '', '', '', '', '', '', 'GRAND TOTAL:', poData.grandTotal.toFixed(2)]);
    const wsSupplier = XLSX.utils.aoa_to_sheet(poRows);
    wsSupplier['!cols'] = [
      { wch: 22 }, { wch: 30 }, { wch: 12 }, { wch: 14 }, { wch: 8 },
      { wch: 8 }, { wch: 12 }, { wch: 12 }, { wch: 14 },
    ];
    XLSX.utils.book_append_sheet(wb, wsSupplier, 'By Supplier');

    XLSX.writeFile(wb, `Consolidated_PO_${new Date().toISOString().split('T')[0]}.xlsx`);
  }

  if (loading) {
    return (
      <div style={{ padding: 40, textAlign: 'center', color: '#888' }}>
        Loading formulas...
      </div>
    );
  }

  return (
    <div style={{ padding: '24px 32px', maxWidth: 1100, margin: '0 auto' }}>
      <h1 style={{ fontSize: 22, fontWeight: 700, marginBottom: 4 }}>Consolidated Purchase Order</h1>
      <p style={{ color: '#888', marginBottom: 24, fontSize: 14 }}>
        Select multiple formulas, enter case counts, and generate a single aggregated PO grouped by supplier.
      </p>

      {/* Formula Selection */}
      <div style={{ background: 'var(--card-bg, #1a1a2e)', border: '1px solid var(--border, #2a2a4a)', borderRadius: 10, padding: 20, marginBottom: 20 }}>
        <h2 style={{ fontSize: 15, fontWeight: 600, marginBottom: 14, color: 'var(--text-primary, #e8e8f0)' }}>
          Select Formulas
        </h2>

        {formulas.length === 0 ? (
          <div style={{ color: '#888', fontSize: 14 }}>No formulas found. Add formulas in the Formula Library.</div>
        ) : (
          Object.entries(formulaGroups).map(([client, clientFormulas]) => (
            <div key={client} style={{ marginBottom: 16 }}>
              <div style={{ fontSize: 12, fontWeight: 600, color: '#888', textTransform: 'uppercase', letterSpacing: '0.05em', marginBottom: 8 }}>
                {client}
              </div>
              <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
                {clientFormulas.map((formula) => (
                  <label
                    key={formula.id}
                    style={{
                      display: 'flex',
                      alignItems: 'center',
                      gap: 12,
                      padding: '8px 12px',
                      borderRadius: 6,
                      background: selected[formula.id] ? 'rgba(100,120,255,0.1)' : 'transparent',
                      border: selected[formula.id] ? '1px solid rgba(100,120,255,0.3)' : '1px solid transparent',
                      cursor: 'pointer',
                      transition: 'all 0.15s',
                    }}
                  >
                    <input
                      type="checkbox"
                      checked={!!selected[formula.id]}
                      onChange={() => toggleFormula(formula.id)}
                      style={{ width: 16, height: 16, cursor: 'pointer', flexShrink: 0 }}
                    />
                    <span style={{ flex: 1, fontSize: 14, fontWeight: 500 }}>{formula.name}</span>
                    <span style={{ fontSize: 12, color: '#888', marginRight: 8 }}>
                      {(formula.ingredients || []).length} ingredients
                    </span>
                    {selected[formula.id] && (
                      <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
                        <span style={{ fontSize: 12, color: '#aaa' }}>Cases:</span>
                        <input
                          type="number"
                          min="0"
                          value={caseCounts[formula.id] || ''}
                          onChange={(e) => setCases(formula.id, e.target.value)}
                          onClick={(e) => e.stopPropagation()}
                          placeholder="0"
                          style={{
                            width: 80,
                            padding: '4px 8px',
                            fontSize: 14,
                            borderRadius: 5,
                            border: '1px solid var(--border, #444)',
                            background: 'var(--input-bg, #111)',
                            color: 'var(--text-primary, #e8e8f0)',
                            textAlign: 'right',
                          }}
                        />
                      </div>
                    )}
                  </label>
                ))}
              </div>
            </div>
          ))
        )}

        <div style={{ marginTop: 16, display: 'flex', alignItems: 'center', gap: 12 }}>
          <button
            className="btn btn-primary"
            onClick={handleGenerate}
            disabled={selectedIds.length === 0}
            style={{ minWidth: 140 }}
          >
            Generate PO
          </button>
          {selectedIds.length > 0 && (
            <span style={{ fontSize: 13, color: '#888' }}>
              {selectedIds.length} formula{selectedIds.length !== 1 ? 's' : ''} selected
            </span>
          )}
        </div>
      </div>

      {/* Results */}
      {generated && poData && (
        <div>
          {/* Formula summary */}
          <div style={{ background: 'var(--card-bg, #1a1a2e)', border: '1px solid var(--border, #2a2a4a)', borderRadius: 10, padding: 16, marginBottom: 16 }}>
            <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 10 }}>
              <h2 style={{ fontSize: 15, fontWeight: 600 }}>PO Summary</h2>
              <button className="btn" onClick={exportToExcel} style={{ fontSize: 13 }}>
                Export Excel
              </button>
            </div>
            <div style={{ display: 'flex', gap: 16, flexWrap: 'wrap', marginBottom: 10 }}>
              {poData.formulaSummaries.map((f, i) => (
                <div key={i} style={{ background: 'rgba(100,120,255,0.08)', borderRadius: 6, padding: '6px 12px', fontSize: 13 }}>
                  <strong>{f.name}</strong>
                  {f.client && <span style={{ color: '#888' }}> ({f.client})</span>}
                  <span style={{ marginLeft: 8, color: '#aaa' }}>{f.cases.toLocaleString()} cases</span>
                </div>
              ))}
            </div>
            <div style={{ fontSize: 14, color: '#aaa' }}>
              {poData.rowCount} unique ingredient{poData.rowCount !== 1 ? 's' : ''} across {Object.keys(poData.byVendor).length} supplier{Object.keys(poData.byVendor).length !== 1 ? 's' : ''}
            </div>
          </div>

          {/* Grouped by supplier */}
          {Object.entries(poData.byVendor).map(([vendor, group]) => (
            <div
              key={vendor}
              style={{
                background: 'var(--card-bg, #1a1a2e)',
                border: '1px solid var(--border, #2a2a4a)',
                borderRadius: 10,
                marginBottom: 16,
                overflow: 'hidden',
              }}
            >
              <div style={{
                padding: '12px 16px',
                background: 'rgba(100,120,255,0.08)',
                borderBottom: '1px solid var(--border, #2a2a4a)',
                display: 'flex',
                alignItems: 'center',
                justifyContent: 'space-between',
              }}>
                <span style={{ fontWeight: 600, fontSize: 15 }}>{vendor}</span>
                <span style={{ fontSize: 13, color: '#aaa' }}>
                  Subtotal: <strong style={{ color: 'var(--text-primary, #e8e8f0)' }}>${group.subtotal.toFixed(2)}</strong>
                </span>
              </div>
              <div style={{ overflowX: 'auto' }}>
                <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 13 }}>
                  <thead>
                    <tr style={{ borderBottom: '1px solid var(--border, #333)' }}>
                      {['Ingredient', 'SKU', 'Total Needed', 'Unit', 'MOQ', 'Order Qty', 'Price/Unit', 'Line Total'].map((h) => (
                        <th
                          key={h}
                          style={{
                            padding: '8px 12px',
                            textAlign: h === 'Ingredient' ? 'left' : 'right',
                            fontWeight: 600,
                            color: '#888',
                            whiteSpace: 'nowrap',
                          }}
                        >
                          {h}
                        </th>
                      ))}
                    </tr>
                  </thead>
                  <tbody>
                    {group.rows.map((row, i) => {
                      const moqAdjusted = row.orderQty > row.totalAmount;
                      return (
                        <tr
                          key={i}
                          style={{
                            borderBottom: '1px solid var(--border, #222)',
                            background: i % 2 === 0 ? 'transparent' : 'rgba(255,255,255,0.015)',
                          }}
                        >
                          <td style={{ padding: '9px 12px', fontWeight: 500 }}>{row.name}</td>
                          <td style={{ padding: '9px 12px', textAlign: 'right', color: '#888' }}>{row.sku || '—'}</td>
                          <td style={{ padding: '9px 12px', textAlign: 'right', fontFamily: 'monospace' }}>
                            {row.totalAmount.toFixed(2)}
                          </td>
                          <td style={{ padding: '9px 12px', textAlign: 'right', color: '#aaa' }}>{row.buyUnit}</td>
                          <td style={{ padding: '9px 12px', textAlign: 'right', color: '#aaa' }}>{row.moq}</td>
                          <td style={{ padding: '9px 12px', textAlign: 'right', fontFamily: 'monospace' }}>
                            <span style={{ color: moqAdjusted ? '#f0a500' : 'inherit' }}>
                              {row.orderQty.toFixed(2)}
                            </span>
                            {moqAdjusted && (
                              <span style={{ fontSize: 10, color: '#f0a500', marginLeft: 4 }} title="MOQ adjusted">MOQ</span>
                            )}
                          </td>
                          <td style={{ padding: '9px 12px', textAlign: 'right', color: '#aaa', fontFamily: 'monospace' }}>
                            {row.pricePerBuyUnit > 0 ? '$' + row.pricePerBuyUnit.toFixed(4) : '—'}
                          </td>
                          <td style={{ padding: '9px 12px', textAlign: 'right', fontFamily: 'monospace', fontWeight: 600 }}>
                            {row.lineCost > 0 ? '$' + row.lineCost.toFixed(2) : '—'}
                          </td>
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
              </div>
            </div>
          ))}

          {/* Grand total */}
          <div style={{
            background: 'var(--card-bg, #1a1a2e)',
            border: '1px solid rgba(100,200,100,0.3)',
            borderRadius: 10,
            padding: '16px 20px',
            display: 'flex',
            justifyContent: 'space-between',
            alignItems: 'center',
          }}>
            <span style={{ fontWeight: 600, fontSize: 16 }}>Grand Total</span>
            <span style={{ fontSize: 22, fontWeight: 700, color: '#5dba5d', fontFamily: 'monospace' }}>
              ${poData.grandTotal.toFixed(2)}
            </span>
          </div>
        </div>
      )}

      {generated && !poData && (
        <div style={{ padding: 24, textAlign: 'center', color: '#888', background: 'var(--card-bg, #1a1a2e)', borderRadius: 10, border: '1px solid var(--border, #2a2a4a)' }}>
          No formulas with valid case counts selected.
        </div>
      )}
    </div>
  );
}
