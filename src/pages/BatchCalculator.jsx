import { useState, useEffect, useMemo, useCallback, useRef } from 'react';
import { getInventory, saveInventory, addInventoryItem, getVendors, getTankConfig, getCurrentBatch, saveBatch, getFormulas, saveFormula as saveFormulaToStore } from '../data/store';
import { useKeyboardShortcuts } from '../hooks/useKeyboardShortcuts';
import * as XLSX from 'xlsx';

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

export default function BatchCalculator() {
  const [inventoryArr, setInventoryArr] = useState(getInventory());
  const inventory = useMemo(() => {
    const obj = {};
    inventoryArr.forEach((item) => { obj[item.id] = item; });
    return obj;
  }, [inventoryArr]);

  const [unitSystem, setUnitSystem] = useState('imperial');
  const [formulaName, setFormulaName] = useState('');
  const [baseYield, setBaseYield] = useState(100);
  const [baseYieldUnit, setBaseYieldUnit] = useState('gal');
  const [batchSize, setBatchSize] = useState(500);
  const [batchSizeUnit, setBatchSizeUnit] = useState('gal');
  const [unitSizeVal, setUnitSizeVal] = useState(12);
  const [unitSizeUnit, setUnitSizeUnitState] = useState('oz');
  const [unitsPerCase, setUnitsPerCase] = useState(24);
  const [ingredients, setIngredients] = useState([]);
  const [showUnitCalc, setShowUnitCalc] = useState(false);
  const [showLoadModal, setShowLoadModal] = useState(false);
  const [loadSearch, setLoadSearch] = useState('');
  const [showAddIngModal, setShowAddIngModal] = useState(false);
  const [addIngSearch, setAddIngSearch] = useState('');
  const [toast, setToast] = useState(null);
  const [collapsedFolders, setCollapsedFolders] = useState({});

  const [formulas, setFormulas] = useState(() => getFormulas());

  useEffect(() => {
    const handler = () => {
      setInventoryArr(getInventory());
      setFormulas(getFormulas());
    };
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
    let totalCostWithInventory = 0;
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

      // Current inventory in buy units (from manually entered field)
      let onHandBuyUnits = 0;
      const invQty = ing.currentInventory || 0;
      const invUnit = ing.inventoryUnit || ing.buyUnit;
      if (invQty > 0) {
        if (invUnit === ing.buyUnit) {
          onHandBuyUnits = invQty;
        } else {
          onHandBuyUnits = convert(invQty, invUnit, ing.buyUnit);
        }
      }

      // Net amount to purchase (what we actually need to buy)
      const netNeeded = Math.max(0, buyUnitAmount - onHandBuyUnits);
      const netOrderQty = netNeeded > 0 ? Math.ceil(netNeeded / (ing.moq || 1)) * (ing.moq || 1) : 0;
      const netLineCost = netOrderQty * (ing.pricePerBuyUnit || 0);
      totalCostWithInventory += netLineCost;

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
        onHandBuyUnits,
        netNeeded,
        netOrderQty,
        netLineCost,
        stockOk: onHandBuyUnits >= buyUnitAmount && buyUnitAmount > 0,
        stockPartial: onHandBuyUnits > 0 && onHandBuyUnits < buyUnitAmount,
      };
    });

    return { rows, totalCost, totalCostWithInventory };
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
    // Net cost (after using inventory on hand)
    const netCostPerUnit = totalUnits > 0 ? scaledData.totalCostWithInventory / totalUnits : 0;
    const netCostPerCase = netCostPerUnit * unitsPerCase;
    const inventorySavings = scaledData.totalCost - scaledData.totalCostWithInventory;
    return { totalUnits, totalCases, costPerUnit, costPerCase, netCostPerUnit, netCostPerCase, inventorySavings };
  }, [batchSize, batchSizeUnit, unitSizeVal, unitSizeUnit, unitsPerCase, scaledData.totalCost, scaledData.totalCostWithInventory]);

  function updateIngredient(index, field, value) {
    setIngredients((prev) => prev.map((ing, i) => {
      if (i !== index) return ing;
      const updated = { ...ing, [field]: value };
      // When buy unit changes, sync inventory unit to match
      if (field === 'buyUnit' && ing.inventoryUnit === ing.buyUnit) {
        updated.inventoryUnit = value;
      }
      return updated;
    }));
  }

  function removeIngredient(index) {
    setIngredients((prev) => prev.filter((_, i) => i !== index));
  }

  function addIngredientFromInventory(item) {
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
        currentInventory: item.currentStock || 0,
        inventoryUnit: tier?.buyUnit || item.unit || 'gal',
      },
    ]);
    showToast(`Added "${item.name}"`);
  }

  function openAddIngredientModal() {
    const used = new Set(ingredients.map((i) => i.inventoryId));
    const available = inventoryArr.filter((i) => !used.has(i.id));
    if (available.length === 0) {
      showToast('All inventory items are already in the formula', 'warning');
      return;
    }
    setShowAddIngModal(true);
    setAddIngSearch('');
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
        currentInventory: 0,
        inventoryUnit: 'gal', // defaults to buy unit
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
    showToast('Formula saved!');
  }

  function handleSaveBatch() {
    saveBatch({
      formulaName, batchSize, batchSizeUnit, baseYield, baseYieldUnit,
      totalUnits: unitEcon.totalUnits,
      ingredients: JSON.parse(JSON.stringify(ingredients)),
    });
    showToast('Batch saved! Context will persist across all calculator pages.');
  }

  function showToast(message, type = 'success') {
    setToast({ message, type });
    setTimeout(() => setToast(null), 3000);
  }

  function handleLoadFormula(name) {
    const formula = formulas.find((f) => f.name === name);
    if (!formula) return;
    setFormulaName(formula.name);
    if (formula.baseYield) setBaseYield(formula.baseYield);
    if (formula.baseYieldUnit) setBaseYieldUnit(formula.baseYieldUnit);
    if (formula.batchSize) setBatchSize(formula.batchSize);
    if (formula.batchSizeUnit) setBatchSizeUnit(formula.batchSizeUnit);
    if (formula.ingredients) setIngredients(formula.ingredients);
    setShowLoadModal(false);
    setLoadSearch('');
    showToast(`Loaded "${formula.name}"`);
  }

  function handleNewFormula() {
    setFormulaName('New Formula');
    setBaseYield(100);
    setBaseYieldUnit('gal');
    setBatchSize(500);
    setBatchSizeUnit('gal');
    setIngredients([]);
  }

  useKeyboardShortcuts([
    { key: 'n', ctrl: true, handler: () => handleNewFormula(), allowInInput: true },
    { key: 's', ctrl: true, handler: () => handleSaveFormula(), allowInInput: true },
    { key: 'o', ctrl: true, handler: () => setShowLoadModal(true), allowInInput: true },
    { key: 'e', ctrl: true, handler: () => exportToExcel(), allowInInput: true },
    { key: 'i', ctrl: true, handler: () => openAddIngredientModal(), allowInInput: true },
    { key: 'd', ctrl: true, handler: () => addDraftIngredient(), allowInInput: true },
  ]);

  function exportToExcel() {
    const batchSizeGal = batchSizeUnit === 'L' ? batchSize / 3.78541 : batchSize;
    const wb = XLSX.utils.book_new();

    // SHEET 1: Overview
    const overviewData = [
      ['BEVERAGE BATCH CALCULATOR'],
      ['Formula Export - ' + new Date().toLocaleString()],
      [],
      ['FORMULA DETAILS', '', 'VALUE', 'UNIT'],
      ['Formula Name', formulaName],
      ['Base Yield', '', baseYield, baseYieldUnit],
      ['Target Batch Size', '', batchSize, batchSizeUnit],
      ['Scale Factor', '', scaleFactor.toFixed(4) + 'x'],
      ['Unit Size', '', unitSizeVal, unitSizeUnit],
      ['Units per Case', '', unitsPerCase],
      [],
      ['UNIT ECONOMICS'],
      ['Total Units', '', unitEcon.totalUnits],
      ['Total Cases', '', unitEcon.totalCases],
      ['Total Ingredient Cost', '', '$' + scaledData.totalCost.toFixed(2)],
      ['Net Purchase Cost', '', '$' + scaledData.totalCostWithInventory.toFixed(2)],
      ['Inventory Savings', '', '$' + unitEcon.inventorySavings.toFixed(2)],
      ['Cost per Unit (Full)', '', '$' + unitEcon.costPerUnit.toFixed(4)],
      ['Cost per Unit (Net)', '', '$' + unitEcon.netCostPerUnit.toFixed(4)],
      ['Cost per Case (Full)', '', '$' + unitEcon.costPerCase.toFixed(2)],
      ['Cost per Case (Net)', '', '$' + unitEcon.netCostPerCase.toFixed(2)],
    ];
    const wsOverview = XLSX.utils.aoa_to_sheet(overviewData);
    wsOverview['!cols'] = [{ wch: 25 }, { wch: 20 }, { wch: 15 }, { wch: 10 }];
    XLSX.utils.book_append_sheet(wb, wsOverview, 'Overview');

    // SHEET 2: Base Recipe
    const recipeData = [
      ['BASE RECIPE (per ' + baseYield + ' ' + baseYieldUnit + ')'],
      [],
      ['Item', 'SKU', 'Type', 'Recipe Amt', 'Recipe Unit', 'SG', 'Buy Unit', 'Price/Buy Unit', 'MOQ', 'On Hand', 'Inv Unit'],
      ...ingredients.map((ing) => {
        const item = inventory[ing.inventoryId];
        return [
          item?.name || ing.draftName || 'Unknown',
          item?.sku || '',
          ing.type,
          ing.recipeAmount,
          ing.recipeUnit,
          ing.specificGravity,
          ing.buyUnit,
          ing.pricePerBuyUnit,
          ing.moq,
          ing.currentInventory || 0,
          ing.inventoryUnit || ing.buyUnit,
        ];
      }),
    ];
    const wsRecipe = XLSX.utils.aoa_to_sheet(recipeData);
    wsRecipe['!cols'] = [
      { wch: 25 }, { wch: 12 }, { wch: 8 }, { wch: 12 }, { wch: 10 },
      { wch: 8 }, { wch: 10 }, { wch: 14 }, { wch: 10 }, { wch: 10 }, { wch: 10 },
    ];
    XLSX.utils.book_append_sheet(wb, wsRecipe, 'Base Recipe');

    // SHEET 3: Scaled Requirements
    const scaledSheetData = [
      ['SCALED BATCH REQUIREMENTS (' + batchSize + ' ' + batchSizeUnit + ')'],
      [],
      ['Item', 'SKU', 'Required', 'Unit', 'On Hand', 'Net to Order', 'Price/Unit', 'MOQ', 'Order Qty', 'Full Cost', 'Net Cost', 'Status'],
      ...scaledData.rows.map((r) => [
        r.item?.name || r.draftName || 'Unknown',
        r.item?.sku || '',
        r.buyUnitAmount.toFixed(2),
        r.buyUnit,
        r.onHandBuyUnits.toFixed(2),
        r.netNeeded.toFixed(2),
        r.pricePerBuyUnit?.toFixed(4) || '0',
        r.moq,
        r.netOrderQty.toFixed(2),
        r.lineCost.toFixed(2),
        r.netLineCost.toFixed(2),
        r.stockOk ? 'In Stock' : r.stockPartial ? 'Partial' : 'Order',
      ]),
      [],
      ['', '', '', '', '', '', '', '', 'TOTALS:', scaledData.totalCost.toFixed(2), scaledData.totalCostWithInventory.toFixed(2)],
      ['', '', '', '', '', '', '', '', 'SAVINGS:', '', unitEcon.inventorySavings.toFixed(2)],
    ];
    const wsScaled = XLSX.utils.aoa_to_sheet(scaledSheetData);
    wsScaled['!cols'] = [
      { wch: 25 }, { wch: 12 }, { wch: 12 }, { wch: 8 }, { wch: 12 },
      { wch: 12 }, { wch: 12 }, { wch: 10 }, { wch: 12 }, { wch: 12 }, { wch: 12 }, { wch: 10 },
    ];
    XLSX.utils.book_append_sheet(wb, wsScaled, 'Scaled Recipe');

    // SHEET 4: Purchase Order
    const poRows = scaledData.rows.filter((r) => r.netOrderQty > 0);
    const poData = [
      ['PURCHASE ORDER'],
      ['Generated: ' + new Date().toLocaleString()],
      ['Formula: ' + formulaName],
      ['Batch Size: ' + batchSize + ' ' + batchSizeUnit],
      [],
      ['Item', 'SKU', 'Qty to Order', 'Unit', 'Price/Unit', 'Line Total', 'Vendor'],
      ...poRows.map((r) => [
        r.item?.name || r.draftName || 'Unknown',
        r.item?.sku || '',
        r.netOrderQty.toFixed(2),
        r.buyUnit,
        (r.pricePerBuyUnit || 0).toFixed(4),
        r.netLineCost.toFixed(2),
        r.item?.vendor || '',
      ]),
      [],
      ['', '', '', '', 'TOTAL:', scaledData.totalCostWithInventory.toFixed(2)],
    ];
    const wsPO = XLSX.utils.aoa_to_sheet(poData);
    wsPO['!cols'] = [{ wch: 25 }, { wch: 12 }, { wch: 14 }, { wch: 8 }, { wch: 12 }, { wch: 12 }, { wch: 20 }];
    XLSX.utils.book_append_sheet(wb, wsPO, 'Purchase Order');

    XLSX.writeFile(wb, `${formulaName.replace(/\s+/g, '_')}_${batchSize}${batchSizeUnit}_${new Date().toISOString().split('T')[0]}.xlsx`);
  }

  const tableRef = useRef(null);

  function handleCellKeyDown(e, row, col) {
    // Enter on a select: simulate a click to open the dropdown
    if (e.key === 'Enter' && e.target.tagName === 'SELECT') {
      e.preventDefault();
      // showPicker is the modern API to open selects programmatically
      if (e.target.showPicker) {
        try { e.target.showPicker(); } catch (_) { /* some browsers restrict this */ }
      } else {
        // Fallback: simulate mousedown to open
        e.target.dispatchEvent(new MouseEvent('mousedown', { bubbles: true }));
      }
      return;
    }

    // Tab moves to next/prev cell
    if (e.key === 'Tab') {
      e.preventDefault();
      const nextCol2 = e.shiftKey ? col - 1 : col + 1;
      let nextRow2 = row;
      let nc = nextCol2;
      if (nc > 9) { nc = 0; nextRow2 = row + 1; }
      if (nc < 0) { nc = 9; nextRow2 = row - 1; }
      const next = tableRef.current?.querySelector(`[data-row="${nextRow2}"][data-col="${nc}"]`);
      if (next) {
        next.focus();
        if (next.tagName === 'INPUT') next.select();
      }
      return;
    }

    const arrows = { ArrowUp: [-1, 0], ArrowDown: [1, 0], ArrowLeft: [0, -1], ArrowRight: [0, 1] };
    const dir = arrows[e.key];
    if (!dir) return;
    e.preventDefault();
    const nextRow = row + dir[0];
    const nextCol = col + dir[1];
    const next = tableRef.current?.querySelector(`[data-row="${nextRow}"][data-col="${nextCol}"]`);
    if (next) {
      next.focus();
      if (next.tagName === 'INPUT') next.select();
    }
  }

  function handleCellFocus(e) {
    if (e.target.tagName === 'INPUT' && (e.target.type === 'number' || e.target.type === 'text')) {
      e.target.select();
    }
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
      {/* Page Header */}
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', marginBottom: 24 }}>
        <div>
          <div style={{ display: 'inline-block', padding: '3px 10px', background: 'var(--brand-100)', color: 'var(--brand)', borderRadius: 4, fontSize: 11, fontWeight: 700, letterSpacing: 0.5, textTransform: 'uppercase', marginBottom: 8 }}>
            Pro Edition
          </div>
          <h1 style={{ fontSize: 28, fontWeight: 800, color: 'var(--text-primary)', margin: 0, lineHeight: 1.2 }}>Formula Calculator</h1>
          <p style={{ fontSize: 14, color: 'var(--text-secondary)', marginTop: 4 }}>Configure batch scaling and ingredient costs for production runs.</p>
        </div>
        <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
          <button className="btn" onClick={handleNewFormula}>New Formula</button>
          <button className="btn" onClick={exportToExcel}>Export Excel</button>
          <button className="btn btn-primary" onClick={handleSaveFormula}>Save Recipe</button>
        </div>
      </div>

      {/* KPI Cards */}
      <div className="cost-summary" style={{ gridTemplateColumns: 'repeat(4, 1fr)', marginBottom: 24 }}>
        <div className="cost-card">
          <div className="cost-card-label">Scale Factor</div>
          <div className="cost-card-value">{scaleFactor.toFixed(2)}x</div>
          <div className="cost-card-subtitle">{baseYield} {baseYieldUnit} &rarr; {batchSize} {batchSizeUnit}</div>
        </div>
        <div className="cost-card">
          <div className="cost-card-label">Total Ingredient Cost</div>
          <div className="cost-card-value">${scaledData.totalCost.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}</div>
          <div className="cost-card-subtitle">${unitEcon.costPerUnit.toFixed(3)} / unit</div>
        </div>
        <div className="cost-card hero">
          <div className="cost-card-label">Net Purchase Cost</div>
          <div className="cost-card-value">${scaledData.totalCostWithInventory.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}</div>
          <div className="cost-card-subtitle">${unitEcon.netCostPerUnit.toFixed(3)} / unit</div>
        </div>
        <div className="cost-card" style={{ background: unitEcon.inventorySavings > 0 ? '#d1fae5' : undefined }}>
          <div className="cost-card-label">Inventory Savings</div>
          <div className="cost-card-value" style={{ color: unitEcon.inventorySavings > 0 ? '#065f46' : undefined }}>${unitEcon.inventorySavings.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}</div>
          <div className="cost-card-subtitle">{unitEcon.totalCases.toLocaleString()} cases &bull; {unitEcon.totalUnits.toLocaleString()} units</div>
        </div>
      </div>

      <div style={{ display: 'grid', gridTemplateColumns: '1fr 340px', gap: 24, alignItems: 'start' }}>
        {/* Main Column */}
        <div>
          {/* Formula Architecture */}
          <div className="section" style={{ marginBottom: 20 }}>
            <div className="section-header">
              <div className="section-title">Formula Architecture</div>
              <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
                <button className="btn btn-small" onClick={() => setShowLoadModal(true)}>💥 Load Formula</button>
                <button className="btn btn-small" onClick={handleSaveBatch}>Push to Production</button>
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
              <table ref={tableRef}>
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
                    <th>On Hand</th>
                    <th>Inv. Unit</th>
                    <th>Status</th>
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
                              data-row={idx} data-col={0}
                              value={ing.inventoryId}
                              onKeyDown={(e) => handleCellKeyDown(e, idx, 0)}
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
                                            currentInventory: newItem.currentStock || 0,
                                            inventoryUnit: tier?.buyUnit || newItem.unit || i.inventoryUnit,
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
                              data-row={idx} data-col={0}
                              type="text"
                              value={ing.draftName || ''}
                              onChange={(e) => updateIngredient(idx, 'draftName', e.target.value)}
                              onFocus={handleCellFocus}
                              onKeyDown={(e) => handleCellKeyDown(e, idx, 0)}
                              placeholder="Draft ingredient"
                              style={{ minWidth: 160 }}
                            />
                          )}
                        </td>
                        <td>
                          <select data-row={idx} data-col={1} value={ing.type} onChange={(e) => updateIngredient(idx, 'type', e.target.value)} onKeyDown={(e) => handleCellKeyDown(e, idx, 1)}>
                            <option value="liquid">Liquid</option>
                            <option value="dry">Dry</option>
                          </select>
                        </td>
                        <td>
                          <input
                            data-row={idx} data-col={2}
                            type="number"
                            value={ing.recipeAmount}
                            onChange={(e) => updateIngredient(idx, 'recipeAmount', parseFloat(e.target.value) || 0)}
                            onFocus={handleCellFocus}
                            onKeyDown={(e) => handleCellKeyDown(e, idx, 2)}
                            style={{ width: 80 }}
                          />
                        </td>
                        <td>
                          <select data-row={idx} data-col={3} value={ing.recipeUnit} onChange={(e) => updateIngredient(idx, 'recipeUnit', e.target.value)} onKeyDown={(e) => handleCellKeyDown(e, idx, 3)}>
                            <option value="gal">gal</option><option value="L">L</option><option value="oz">oz</option>
                            <option value="ml">mL</option><option value="lbs">lbs</option><option value="kg">kg</option><option value="g">g</option>
                          </select>
                        </td>
                        <td>
                          <input
                            data-row={idx} data-col={4}
                            type="number"
                            value={ing.specificGravity}
                            onChange={(e) => updateIngredient(idx, 'specificGravity', parseFloat(e.target.value) || 1.0)}
                            onFocus={handleCellFocus}
                            onKeyDown={(e) => handleCellKeyDown(e, idx, 4)}
                            step="0.01"
                            style={{ width: 60 }}
                          />
                        </td>
                        <td>
                          <select data-row={idx} data-col={5} value={ing.buyUnit} onChange={(e) => updateIngredient(idx, 'buyUnit', e.target.value)} onKeyDown={(e) => handleCellKeyDown(e, idx, 5)}>
                            <option value="gal">gal</option><option value="L">L</option><option value="lbs">lbs</option>
                            <option value="kg">kg</option><option value="oz">oz</option><option value="g">g</option>
                          </select>
                        </td>
                        <td>
                          <input
                            data-row={idx} data-col={6}
                            type="number"
                            value={ing.pricePerBuyUnit}
                            onChange={(e) => updateIngredient(idx, 'pricePerBuyUnit', parseFloat(e.target.value) || 0)}
                            onFocus={handleCellFocus}
                            onKeyDown={(e) => handleCellKeyDown(e, idx, 6)}
                            step="0.0001"
                            style={{ width: 90 }}
                          />
                        </td>
                        <td>
                          <input
                            data-row={idx} data-col={7}
                            type="number"
                            value={ing.moq}
                            onChange={(e) => updateIngredient(idx, 'moq', parseFloat(e.target.value) || 1)}
                            onFocus={handleCellFocus}
                            onKeyDown={(e) => handleCellKeyDown(e, idx, 7)}
                            style={{ width: 70 }}
                          />
                        </td>
                        <td>
                          <input
                            data-row={idx} data-col={8}
                            type="number"
                            value={ing.currentInventory || 0}
                            onChange={(e) => updateIngredient(idx, 'currentInventory', parseFloat(e.target.value) || 0)}
                            onFocus={handleCellFocus}
                            onKeyDown={(e) => handleCellKeyDown(e, idx, 8)}
                            style={{ width: 80 }}
                          />
                        </td>
                        <td>
                          <select data-row={idx} data-col={9} value={ing.inventoryUnit || 'gal'} onChange={(e) => updateIngredient(idx, 'inventoryUnit', e.target.value)} onKeyDown={(e) => handleCellKeyDown(e, idx, 9)}>
                            <option value="gal">gal</option><option value="L">L</option><option value="lbs">lbs</option>
                            <option value="kg">kg</option><option value="oz">oz</option><option value="g">g</option>
                          </select>
                        </td>
                        <td style={{ fontSize: 12 }}>
                          {scaleFactor > 0 && ing.recipeAmount > 0 ? (() => {
                            const scaledRecipe = ing.recipeAmount * scaleFactor;
                            let buyNeeded = scaledRecipe;
                            if (ing.recipeUnit !== ing.buyUnit) buyNeeded = convert(scaledRecipe, ing.recipeUnit, ing.buyUnit);
                            const invQty = ing.currentInventory || 0;
                            const invUnit = ing.inventoryUnit || ing.buyUnit;
                            let onHand = invUnit === ing.buyUnit ? invQty : convert(invQty, invUnit, ing.buyUnit);
                            const pct = buyNeeded > 0 ? Math.min((onHand / buyNeeded) * 100, 100) : 100;
                            const net = Math.max(0, buyNeeded - onHand);
                            const color = pct >= 100 ? '#10b981' : pct >= 50 ? '#f59e0b' : '#ef4444';
                            return (
                              <div>
                                <div style={{ height: 4, background: '#e5e7eb', borderRadius: 2, overflow: 'hidden', marginBottom: 3 }}>
                                  <div style={{ height: '100%', background: color, width: `${pct}%`, transition: 'width 0.3s' }} />
                                </div>
                                {net > 0 ? (
                                  <span style={{ color, fontWeight: 600 }}>Need {net.toFixed(1)} {ing.buyUnit}</span>
                                ) : (
                                  <span style={{ color: '#10b981', fontWeight: 600 }}>Covered ✓</span>
                                )}
                              </div>
                            );
                          })() : '\u2014'}
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
                    <td colSpan={12} style={{ padding: 12, background: '#f9fafb', borderTop: '2px solid #e5e7eb' }}>
                      <div style={{ display: 'flex', gap: 8 }}>
                        <button className="btn btn-primary" onClick={openAddIngredientModal} style={{ flex: 1, justifyContent: 'center' }}>
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
                    <th>Required</th>
                    <th>On Hand</th>
                    <th>Net to Order</th>
                    <th>Price/Unit</th>
                    <th>MOQ</th>
                    <th>Order Qty</th>
                    <th>Full Cost</th>
                    <th>Net Cost</th>
                    <th>Status</th>
                  </tr>
                </thead>
                <tbody>
                  {scaledData.rows.map((row, idx) => (
                    <tr key={idx}>
                      <td style={{ fontWeight: 600 }}>{row.item?.name || row.draftName || 'Unknown'}</td>
                      <td style={{ fontSize: 12, color: '#6b7280' }}>{row.item?.sku || '\u2014'}</td>
                      <td>{row.buyUnitAmount.toFixed(2)} {row.buyUnit}</td>
                      <td style={{ fontWeight: 600, color: row.stockOk ? '#10b981' : row.stockPartial ? '#f59e0b' : '#6b7280' }}>
                        {row.onHandBuyUnits > 0 ? `${row.onHandBuyUnits.toFixed(2)} ${row.buyUnit}` : '\u2014'}
                      </td>
                      <td style={{ fontWeight: 600, color: row.netNeeded > 0 ? '#ef4444' : '#10b981' }}>
                        {row.netNeeded > 0 ? `${row.netNeeded.toFixed(2)} ${row.buyUnit}` : 'Covered ✓'}
                      </td>
                      <td>${(row.pricePerBuyUnit || 0).toFixed(4)}</td>
                      <td>{row.moq}</td>
                      <td style={{ fontWeight: 600 }}>{row.netOrderQty > 0 ? `${row.netOrderQty.toFixed(2)} ${row.buyUnit}` : '\u2014'}</td>
                      <td style={{ color: '#6b7280', fontSize: 12 }}>${row.lineCost.toFixed(2)}</td>
                      <td style={{ fontWeight: 700 }}>${row.netLineCost.toFixed(2)}</td>
                      <td>
                        <span className={`badge ${row.stockOk ? 'badge-success' : row.stockPartial ? 'badge-warning' : 'badge-danger'}`}>
                          {row.stockOk ? 'In Stock' : row.stockPartial ? 'Partial' : 'Order'}
                        </span>
                      </td>
                    </tr>
                  ))}
                </tbody>
                <tfoot>
                  <tr>
                    <td colSpan={8} style={{ textAlign: 'right', fontWeight: 600 }}>Totals:</td>
                    <td style={{ fontSize: 13, color: '#6b7280' }}>${scaledData.totalCost.toFixed(2)}</td>
                    <td style={{ fontWeight: 700, fontSize: 15 }}>${scaledData.totalCostWithInventory.toFixed(2)}</td>
                    <td></td>
                  </tr>
                  {unitEcon.inventorySavings > 0 && (
                    <tr>
                      <td colSpan={8} style={{ textAlign: 'right', fontWeight: 600, color: '#10b981' }}>Inventory Savings:</td>
                      <td colSpan={2} style={{ fontWeight: 700, color: '#10b981', fontSize: 14 }}>−${unitEcon.inventorySavings.toFixed(2)}</td>
                      <td></td>
                    </tr>
                  )}
                </tfoot>
              </table>
            </div>
          </div>
        </div>

        {/* Sidebar */}
        <div>
          {/* Calculated Batch ROI */}
          <div className="projection-card" style={{ marginBottom: 20 }}>
            <h3>Calculated Batch ROI</h3>
            <div style={{ fontSize: 11, color: 'rgba(255,255,255,0.6)', textTransform: 'uppercase', letterSpacing: 0.5 }}>Net Purchase Cost</div>
            <div className="projection-total">${scaledData.totalCostWithInventory.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}</div>
            {unitEcon.inventorySavings > 0 && (
              <div style={{ fontSize: 12, color: '#6ee7b7', marginBottom: 8 }}>
                Saving ${unitEcon.inventorySavings.toFixed(2)} from inventory on hand
              </div>
            )}
            <div style={{ display: 'flex', gap: 24, marginBottom: 16 }}>
              <div>
                <div style={{ fontSize: 11, color: 'rgba(255,255,255,0.6)', textTransform: 'uppercase' }}>Net Cost/Unit</div>
                <div style={{ fontSize: 18, fontWeight: 700 }}>${unitEcon.netCostPerUnit.toFixed(3)}</div>
              </div>
              <div>
                <div style={{ fontSize: 11, color: 'rgba(255,255,255,0.6)', textTransform: 'uppercase' }}>Yield</div>
                <div style={{ fontSize: 18, fontWeight: 700 }}>{unitEcon.totalUnits.toLocaleString()}</div>
              </div>
            </div>
            <div style={{ marginBottom: 8 }}>
              <div style={{ fontSize: 11, color: 'rgba(255,255,255,0.6)', textTransform: 'uppercase', marginBottom: 4 }}>Capacity Utilization</div>
              <div style={{ background: 'rgba(255,255,255,0.15)', borderRadius: 4, height: 8 }}>
                <div style={{ background: '#A78BFA', borderRadius: 4, height: 8, width: `${Math.min(scaleFactor * 10, 100)}%`, transition: 'width 0.3s' }}></div>
              </div>
              <div style={{ fontSize: 12, marginTop: 4, textAlign: 'right' }}>{Math.min(scaleFactor * 10, 100).toFixed(0)}%</div>
            </div>
            <div className="cost-breakdown" style={{ marginTop: 12 }}>
              {scaledData.rows.slice(0, 5).map((row, idx) => (
                <div key={idx} style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', padding: '6px 0', fontSize: 13, borderBottom: '1px solid rgba(255,255,255,0.1)' }}>
                  <span style={{ color: 'rgba(255,255,255,0.6)' }}>
                    {row.item?.name || row.draftName || 'Unknown'}
                    {row.stockOk && <span style={{ color: '#6ee7b7', marginLeft: 4, fontSize: 10 }}>✓</span>}
                  </span>
                  <span style={{ fontWeight: 600 }}>
                    {row.netLineCost < row.lineCost ? (
                      <>
                        <span style={{ textDecoration: 'line-through', color: 'rgba(255,255,255,0.3)', marginRight: 6, fontSize: 11 }}>${row.lineCost.toFixed(2)}</span>
                        ${row.netLineCost.toFixed(2)}
                      </>
                    ) : `$${row.lineCost.toFixed(2)}`}
                  </span>
                </div>
              ))}
            </div>
          </div>

          {/* Production Constants */}
          <div style={{ background: 'var(--surface)', border: '1px solid var(--border-light)', borderRadius: 'var(--radius)', overflow: 'hidden', boxShadow: '0 1px 2px rgba(0,0,0,0.04)', marginBottom: 20 }}>
            <div style={{ padding: '10px 14px', borderBottom: '1px solid var(--border)', background: 'var(--surface-alt)' }}>
              <div style={{ fontSize: 13, fontWeight: 700 }}>Production Constants</div>
            </div>
            <div style={{ padding: 14 }}>
              <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', padding: '6px 0', borderBottom: '1px solid #F1F5F9' }}>
                <span style={{ fontSize: 13, color: 'var(--text-secondary)' }}>Total Units</span>
                <span style={{ fontSize: 13, fontWeight: 700 }}>{unitEcon.totalUnits.toLocaleString()}</span>
              </div>
              <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', padding: '6px 0', borderBottom: '1px solid #F1F5F9' }}>
                <span style={{ fontSize: 13, color: 'var(--text-secondary)' }}>Total Cases</span>
                <span style={{ fontSize: 13, fontWeight: 700 }}>{unitEcon.totalCases.toLocaleString()}</span>
              </div>
              <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', padding: '6px 0', borderBottom: '1px solid #F1F5F9' }}>
                <span style={{ fontSize: 13, color: 'var(--text-secondary)' }}>Cost per Case (Full)</span>
                <span style={{ fontSize: 13, fontWeight: 700 }}>${unitEcon.costPerCase.toFixed(2)}</span>
              </div>
              <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', padding: '6px 0', borderBottom: '1px solid #F1F5F9' }}>
                <span style={{ fontSize: 13, color: 'var(--text-secondary)' }}>Cost per Case (Net)</span>
                <span style={{ fontSize: 13, fontWeight: 700, color: '#10b981' }}>${unitEcon.netCostPerCase.toFixed(2)}</span>
              </div>
              <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', padding: '6px 0' }}>
                <span style={{ fontSize: 13, color: 'var(--text-secondary)' }}>Scale Factor</span>
                <span style={{ fontSize: 13, fontWeight: 700 }}>{scaleFactor.toFixed(2)}x</span>
              </div>
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
          <div style={{ background: 'var(--surface)', border: '1px solid var(--border-light)', borderRadius: 'var(--radius)', overflow: 'hidden', boxShadow: '0 1px 2px rgba(0,0,0,0.04)' }}>
            <div style={{ padding: '10px 14px', borderBottom: '1px solid var(--border)', background: 'var(--surface-alt)' }}>
              <div style={{ fontSize: 13, fontWeight: 700 }}>Inventory Alerts</div>
            </div>
            <div style={{ padding: 14 }}>
              {scaledData.rows.filter((r) => !r.stockOk).length === 0 ? (
                <div style={{ fontSize: 13, color: '#10b981', padding: '8px 0' }}>✓ All ingredients covered by current inventory</div>
              ) : (
                scaledData.rows
                  .filter((r) => !r.stockOk)
                  .map((r, idx) => (
                    <div key={idx} style={{ display: 'flex', alignItems: 'center', gap: 8, padding: '8px 0', borderBottom: '1px solid #F1F5F9', fontSize: 13 }}>
                      <span style={{ color: r.stockPartial ? '#F59E0B' : '#EF4444', fontSize: 16 }}>{r.stockPartial ? '⚠' : '✕'}</span>
                      <div>
                        <div style={{ fontWeight: 600, color: 'var(--text-primary)' }}>{r.item?.name || r.draftName}</div>
                        <div style={{ fontSize: 12, color: 'var(--text-muted)' }}>
                          Need {r.buyUnitAmount.toFixed(2)} {r.buyUnit} — have {r.onHandBuyUnits.toFixed(2)} — order {r.netNeeded.toFixed(2)} {r.buyUnit}
                        </div>
                        <div style={{ fontSize: 11, color: '#ef4444', fontWeight: 600 }}>Est. ${r.netLineCost.toFixed(2)}</div>
                      </div>
                    </div>
                  ))
              )}
            </div>
          </div>
        </div>
      </div>

      {/* Insight Cards */}
      <div className="insight-cards" style={{ marginTop: 24 }}>
        <div className="insight-card">
          <h4>Efficiency Alert</h4>
          <p>
            {scaleFactor > 5
              ? `Scale factor of ${scaleFactor.toFixed(1)}x may exceed optimal capacity. Consider splitting into multiple batches.`
              : `Batch is within efficient range at ${scaleFactor.toFixed(1)}x scale.`}
          </p>
        </div>
        <div className="insight-card">
          <h4>Cost Optimization</h4>
          <p>
            {scaledData.totalCost > 0
              ? `Total ingredient cost $${scaledData.totalCost.toFixed(2)}. Unit cost $${unitEcon.costPerUnit.toFixed(3)} across ${unitEcon.totalUnits.toLocaleString()} units.`
              : 'Add ingredients to see cost analysis.'}
          </p>
        </div>
        <div className="insight-card">
          <h4>Stock Status</h4>
          <p>
            {scaledData.rows.filter((r) => !r.stockOk).length === 0
              ? 'All ingredients are in stock for this batch size.'
              : `${scaledData.rows.filter((r) => !r.stockOk).length} ingredient(s) need ordering before production.`}
          </p>
        </div>
      </div>

      {/* Load Formula Modal */}
      {showLoadModal && (
        <div style={{ position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.5)', display: 'flex', alignItems: 'center', justifyContent: 'center', zIndex: 1000 }} onClick={() => { setShowLoadModal(false); setLoadSearch(''); }}>
          <div style={{ background: 'white', borderRadius: 12, width: 480, maxHeight: '80vh', display: 'flex', flexDirection: 'column', boxShadow: '0 20px 60px rgba(0,0,0,0.3)' }} onClick={(e) => e.stopPropagation()}>
            <div style={{ padding: '20px 24px 16px', borderBottom: '1px solid #e5e7eb' }}>
              <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 12 }}>
                <h3 style={{ fontSize: 18, fontWeight: 700, margin: 0 }}>💥 Load Formula</h3>
                <button onClick={() => { setShowLoadModal(false); setLoadSearch(''); }} style={{ background: 'none', border: 'none', fontSize: 20, cursor: 'pointer', color: '#9ca3af', padding: '4px 8px' }}>&times;</button>
              </div>
              <input
                type="text"
                placeholder="Search formulas..."
                value={loadSearch}
                onChange={(e) => setLoadSearch(e.target.value)}
                autoFocus
                style={{ width: '100%', padding: '10px 12px', border: '1px solid #d1d5db', borderRadius: 8, fontSize: 14 }}
              />
            </div>
            <div style={{ overflowY: 'auto', padding: '8px 12px', flex: 1 }}>
              {(() => {
                const grouped = {};
                formulas
                  .filter((f) => !loadSearch || f.name.toLowerCase().includes(loadSearch.toLowerCase()) || (f.client || '').toLowerCase().includes(loadSearch.toLowerCase()))
                  .forEach((f) => {
                    const client = f.client || 'Uncategorized';
                    if (!grouped[client]) grouped[client] = [];
                    grouped[client].push(f);
                  });
                const entries = Object.entries(grouped);
                if (entries.length === 0) {
                  return <div style={{ padding: 24, textAlign: 'center', color: '#9ca3af' }}>No formulas found</div>;
                }
                return entries.map(([client, fms]) => {
                  const isCollapsed = collapsedFolders[client] && !loadSearch;
                  return (
                    <div key={client} style={{ marginBottom: 4 }}>
                      <div
                        onClick={() => setCollapsedFolders((prev) => ({ ...prev, [client]: !prev[client] }))}
                        style={{ fontSize: 11, fontWeight: 700, color: '#6b7280', textTransform: 'uppercase', letterSpacing: 0.5, padding: '8px 12px 4px', display: 'flex', alignItems: 'center', gap: 6, cursor: 'pointer', userSelect: 'none', borderRadius: 6, transition: 'background 0.15s' }}
                        onMouseEnter={(e) => e.currentTarget.style.background = '#f3f4f6'}
                        onMouseLeave={(e) => e.currentTarget.style.background = 'transparent'}
                      >
                        <span style={{ fontSize: 10, transition: 'transform 0.2s', display: 'inline-block', transform: isCollapsed ? 'rotate(-90deg)' : 'rotate(0deg)' }}>▼</span>
                        <span>📁</span> {client}
                        <span style={{ fontSize: 10, color: '#9ca3af', fontWeight: 500 }}>({fms.length})</span>
                      </div>
                      {!isCollapsed && fms.map((f) => (
                        <div
                          key={f.name}
                          onClick={() => handleLoadFormula(f.name)}
                          style={{ padding: '10px 12px 10px 32px', borderRadius: 8, cursor: 'pointer', display: 'flex', justifyContent: 'space-between', alignItems: 'center', transition: 'background 0.15s' }}
                          onMouseEnter={(e) => e.currentTarget.style.background = '#f0f4ff'}
                          onMouseLeave={(e) => e.currentTarget.style.background = 'transparent'}
                        >
                          <div>
                            <div style={{ fontSize: 14, fontWeight: 600, color: '#1f2937' }}>{f.name}</div>
                            <div style={{ fontSize: 12, color: '#9ca3af', marginTop: 2 }}>
                              {f.ingredients?.length || 0} ingredients
                              {f.baseYield ? ` · ${f.baseYield} ${f.baseYieldUnit || 'gal'} base` : ''}
                              {f.updatedAt ? ` · ${new Date(f.updatedAt).toLocaleDateString()}` : ''}
                            </div>
                          </div>
                          <span style={{ fontSize: 18, color: '#d1d5db' }}>&rsaquo;</span>
                        </div>
                      ))}
                    </div>
                  );
                });
              })()}
            </div>
            <div style={{ padding: '12px 24px', borderTop: '1px solid #e5e7eb', display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
              <span style={{ fontSize: 12, color: '#9ca3af' }}>{formulas.length} formula{formulas.length !== 1 ? 's' : ''} saved</span>
              <button className="btn btn-small" onClick={() => { setShowLoadModal(false); setLoadSearch(''); }}>Cancel</button>
            </div>
          </div>
        </div>
      )}

      {/* Add Ingredient Modal */}
      {showAddIngModal && (() => {
        const used = new Set(ingredients.map((i) => i.inventoryId));
        const available = inventoryArr.filter((i) => !used.has(i.id));
        const filtered = addIngSearch
          ? available.filter((i) => i.name.toLowerCase().includes(addIngSearch.toLowerCase()) || (i.sku || '').toLowerCase().includes(addIngSearch.toLowerCase()))
          : available;
        return (
          <div style={{ position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.5)', display: 'flex', alignItems: 'center', justifyContent: 'center', zIndex: 1000 }} onClick={() => { setShowAddIngModal(false); setAddIngSearch(''); }}>
            <div style={{ background: 'white', borderRadius: 12, width: 480, maxHeight: '80vh', display: 'flex', flexDirection: 'column', boxShadow: '0 20px 60px rgba(0,0,0,0.3)' }} onClick={(e) => e.stopPropagation()}>
              <div style={{ padding: '20px 24px 16px', borderBottom: '1px solid #e5e7eb' }}>
                <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 12 }}>
                  <h3 style={{ fontSize: 18, fontWeight: 700, margin: 0 }}>Add from Inventory</h3>
                  <button onClick={() => { setShowAddIngModal(false); setAddIngSearch(''); }} style={{ background: 'none', border: 'none', fontSize: 20, cursor: 'pointer', color: '#9ca3af', padding: '4px 8px' }}>&times;</button>
                </div>
                <input
                  type="text"
                  placeholder="Search ingredients..."
                  value={addIngSearch}
                  onChange={(e) => setAddIngSearch(e.target.value)}
                  autoFocus
                  style={{ width: '100%', padding: '10px 12px', border: '1px solid #d1d5db', borderRadius: 8, fontSize: 14 }}
                />
              </div>
              <div style={{ overflowY: 'auto', padding: '8px 12px', flex: 1 }}>
                {filtered.length === 0 ? (
                  <div style={{ padding: 24, textAlign: 'center', color: '#9ca3af' }}>
                    {available.length === 0 ? 'All inventory items are in the formula' : 'No matches found'}
                  </div>
                ) : (
                  filtered.map((item) => {
                    const tier = item.priceTiers?.[0];
                    return (
                      <div
                        key={item.id}
                        onClick={() => addIngredientFromInventory(item)}
                        style={{ padding: '10px 12px', borderRadius: 8, cursor: 'pointer', display: 'flex', justifyContent: 'space-between', alignItems: 'center', transition: 'background 0.15s' }}
                        onMouseEnter={(e) => e.currentTarget.style.background = '#f0f4ff'}
                        onMouseLeave={(e) => e.currentTarget.style.background = 'transparent'}
                      >
                        <div>
                          <div style={{ fontSize: 14, fontWeight: 600, color: '#1f2937' }}>{item.name}</div>
                          <div style={{ fontSize: 12, color: '#9ca3af', marginTop: 2 }}>
                            {item.sku || 'No SKU'} · {item.type || 'liquid'} · {item.currentStock || 0} {item.unit} on hand
                            {tier ? ` · $${tier.price}/${tier.buyUnit}` : ''}
                          </div>
                        </div>
                        <span style={{ fontSize: 13, color: '#7062E0', fontWeight: 600 }}>+ Add</span>
                      </div>
                    );
                  })
                )}
              </div>
              <div style={{ padding: '12px 24px', borderTop: '1px solid #e5e7eb', display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
                <span style={{ fontSize: 12, color: '#9ca3af' }}>{available.length} available · {used.size} in formula</span>
                <button className="btn btn-small" onClick={() => { setShowAddIngModal(false); setAddIngSearch(''); }}>Cancel</button>
              </div>
            </div>
          </div>
        );
      })()}

      {/* Toast Notification */}
      {toast && (
        <div style={{
          position: 'fixed', bottom: 24, right: 24, zIndex: 1100,
          padding: '12px 20px', borderRadius: 10,
          background: toast.type === 'warning' ? '#fef3c7' : toast.type === 'error' ? '#fee2e2' : '#d1fae5',
          color: toast.type === 'warning' ? '#92400e' : toast.type === 'error' ? '#991b1b' : '#065f46',
          fontWeight: 600, fontSize: 14,
          boxShadow: '0 4px 20px rgba(0,0,0,0.15)',
          animation: 'fadeInUp 0.3s ease',
        }}>
          {toast.type === 'warning' ? '⚠️ ' : toast.type === 'error' ? '❌ ' : '✅ '}{toast.message}
        </div>
      )}
    </div>
  );
}
