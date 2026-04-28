// Consolidated PO export — fully live workbook with editable inputs,
// cross-sheet formulas, and a one-click handoff to Google Sheets.
//
// Workbook structure:
//   1. "Inputs"  — editable case counts per formula (yellow cells).
//                  Global adjustments block (freight/waste/tax) for the
//                  user to tweak; all downstream math respects them.
//   2. "Detail"  — per-formula × per-ingredient rows. Demand-per-case is
//                  pre-computed in JS (unit conversion w/ specific gravity
//                  doesn't translate cleanly to Excel). Cases column
//                  references Inputs!, so totals react live.
//   3. "Summary" — PO grouped by supplier with live SUMIF lookups into
//                  Detail, plus the per-formula cost/can/case table.
//
// All cells with $ / % formatting use Excel number-format strings so
// Google Sheets renders correctly after import.

import * as XLSX from 'xlsx';

// ── Unit conversion (mirrored from ConsolidatedPO.jsx) ──────────────
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
    const gal = (lbs / 8.345) * (sg || 1);
    return convert(gal, 'gal', to);
  }
  if (fromIsVolume && toIsWeight) {
    const gal = convert(value, from, 'gal');
    const lbs = (gal * 8.345) / (sg || 1);
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

function calcIngredientDemandPerCase(formula, inventoryMap) {
  // Returns the scaled buy-unit demand for 1 case. Multiplying by a live
  // case count in Excel gives correct totals because the scaling is linear.
  // Normalize batchSize and baseYield to the same unit — see calcIngredient-
  // Needs in ConsolidatedPO.jsx for the rationale (3.78x silent inflation
  // when batchSizeUnit !== baseYieldUnit).
  let perCaseBatch = calcBatchSizeFromCases(formula, 1);
  let baseYield = formula.baseYield || 100;
  const batchUnit = formula.batchSizeUnit || 'gal';
  const yieldUnit = formula.baseYieldUnit || 'gal';
  if (batchUnit === 'L') perCaseBatch = perCaseBatch / 3.78541;
  if (yieldUnit === 'L') baseYield = baseYield / 3.78541;
  const scaleFactor = baseYield > 0 ? perCaseBatch / baseYield : 1;

  return (formula.ingredients || []).map((ing) => {
    const item = inventoryMap[ing.inventoryId];
    const scaledRecipe = (ing.recipeAmount || 0) * scaleFactor;
    const buyUnit = ing.buyUnit || ing.recipeUnit || 'gal';
    let buyUnitAmount = scaledRecipe;
    if (ing.recipeUnit && ing.buyUnit && ing.recipeUnit !== ing.buyUnit) {
      buyUnitAmount = convertWithSG(scaledRecipe, ing.recipeUnit, ing.buyUnit, ing.specificGravity);
    }

    // On-hand lives on the ingredient (formula-level snapshot).
    let onHandInBuyUnits = 0;
    const invQty = ing.currentInventory || 0;
    const invUnit = ing.inventoryUnit || buyUnit;
    if (invQty > 0) {
      onHandInBuyUnits = invUnit === buyUnit
        ? invQty
        : convertWithSG(invQty, invUnit, buyUnit, ing.specificGravity);
      if (onHandInBuyUnits < 0) onHandInBuyUnits = 0;
    }

    return {
      inventoryId: ing.inventoryId || null,
      draftName: ing.draftName || '',
      name: item?.name || ing.draftName || 'Unknown',
      sku: item?.sku || '',
      vendor: item?.vendor || 'No Vendor',
      buyUnit,
      buyUnitPerCase: buyUnitAmount,
      onHandInBuyUnits,
      pricePerBuyUnit: ing.pricePerBuyUnit || 0,
      moq: ing.moq || 1,
      specificGravity: ing.specificGravity || 1,
    };
  });
}

function ingKey(ing) {
  return ing.inventoryId || `draft:${ing.draftName || ing.name}`;
}

// ── Cell helpers ────────────────────────────────────────────────────
// For formula cells, always include a cached numeric value alongside the
// formula. Google Sheets' xlsx import doesn't reliably wire up dependency
// tracking when formula cells lack a cached <v> — edits to upstream cells
// then fail to propagate downstream. Writing both <f> and <v> fixes that
// and also makes the initial open render correct without a recalc pass.
function setCell(ws, ref, val, opts = {}) {
  const cell = {};
  if (opts.f) {
    cell.f = opts.f;
    cell.t = 'n';
    cell.v = typeof val === 'number' && !Number.isNaN(val) ? val : 0;
  } else if (typeof val === 'number' && !Number.isNaN(val)) {
    cell.v = val;
    cell.t = 'n';
  } else if (val === null || val === undefined || val === '') {
    return;
  } else {
    cell.v = String(val);
    cell.t = 's';
  }
  if (opts.z) cell.z = opts.z;
  ws[ref] = cell;
}

function finalizeSheet(ws, lastRow, lastCol) {
  ws['!ref'] = XLSX.utils.encode_range({ s: { r: 0, c: 0 }, e: { r: lastRow - 1, c: lastCol - 1 } });
}

// Escape a string for use inside an Excel string literal in a formula.
function esc(s) {
  return String(s).replace(/"/g, '""');
}

// ── Main builder ────────────────────────────────────────────────────

export function buildConsolidatedPOWorkbook({ selectedFormulas, inventoryMap, caseCounts, fgCosts }) {
  const formulaData = (selectedFormulas || [])
    .map((f) => ({
      formula: f,
      cases: caseCounts[f.id] || 0,
      unitsPerCase: f.unitsPerCase || 24,
      ingredients: calcIngredientDemandPerCase(f, inventoryMap),
    }))
    .filter((fd) => fd.cases > 0 && fd.ingredients.length > 0);

  if (formulaData.length === 0) return null;

  // Pre-compute per-formula totals so we can emit cached values alongside
  // formulas (Google Sheets' xlsx import requires <v> for live recalc).
  formulaData.forEach((fd) => {
    fd.totalUnits = fd.cases * fd.unitsPerCase;
    fd.totalMOQCost = 0; // gross cost if this formula ran alone
    fd.ingredients.forEach((ing) => {
      ing.totalDemand = ing.buyUnitPerCase * fd.cases;
      const moq = ing.moq || 1;
      const moqRounded = moq > 0
        ? Math.ceil(ing.totalDemand / moq) * moq
        : ing.totalDemand;
      ing.lineCost = moqRounded * (ing.pricePerBuyUnit || 0);
      fd.totalMOQCost += ing.lineCost;
    });
    fd.costPerCan = fd.totalUnits > 0 ? fd.totalMOQCost / fd.totalUnits : 0;
    fd.costPerCase = fd.costPerCan * fd.unitsPerCase;
  });
  const totalCasesAll = formulaData.reduce((s, fd) => s + fd.cases, 0);
  const totalUnitsAll = formulaData.reduce((s, fd) => s + fd.totalUnits, 0);

  // Master list: unique ingredient across all selected formulas.
  const masterMap = new Map();
  formulaData.forEach((fd) => {
    fd.ingredients.forEach((ing) => {
      const k = ingKey(ing);
      if (!masterMap.has(k)) {
        masterMap.set(k, {
          key: k,
          name: ing.name,
          sku: ing.sku,
          vendor: ing.vendor || 'No Vendor',
          buyUnit: ing.buyUnit,
          pricePerBuyUnit: ing.pricePerBuyUnit,
          moq: ing.moq,
          onHand: 0,
          formulas: new Set(),
        });
      }
      const m = masterMap.get(k);
      m.formulas.add(fd.formula.id);
      // Adopt the most informative price/moq.
      if (ing.pricePerBuyUnit > 0) m.pricePerBuyUnit = ing.pricePerBuyUnit;
      if (ing.moq > 1) m.moq = ing.moq;
      // On-hand snapshots refer to the same physical stock — take max.
      if (ing.onHandInBuyUnits > m.onHand) m.onHand = ing.onHandInBuyUnits;
    });
  });
  const masterList = Array.from(masterMap.values());

  // Enrich each master with totals for cached values + gross/savings math.
  masterList.forEach((m) => {
    m.totalDemand = 0;
    formulaData.forEach((fd) => {
      fd.ingredients.forEach((ing) => {
        if (ingKey(ing) === m.key) m.totalDemand += ing.totalDemand;
      });
    });
    m.netNeeded = Math.max(0, m.totalDemand - m.onHand);
    const moq = m.moq || 1;
    m.grossOrderQty = moq > 0
      ? Math.ceil(m.totalDemand / moq) * moq
      : m.totalDemand;
    m.netOrderQty = m.netNeeded <= 0
      ? 0
      : (moq > 0 ? Math.ceil(m.netNeeded / moq) * moq : m.netNeeded);
    m.grossLineTotal = m.grossOrderQty * (m.pricePerBuyUnit || 0);
    m.netLineTotal = m.netOrderQty * (m.pricePerBuyUnit || 0);
    m.savings = m.grossLineTotal - m.netLineTotal;
  });

  const wb = XLSX.utils.book_new();

  // ═══════════════════════════════════════════════════════════════════
  //  Sheet 1 — Inputs
  // ═══════════════════════════════════════════════════════════════════
  const wsIn = {};
  let r = 1;
  setCell(wsIn, `A${r}`, 'CONSOLIDATED PURCHASE ORDER — INPUTS'); r++;
  setCell(wsIn, `A${r}`, `Generated: ${new Date().toLocaleString()}`); r++;
  r++;
  setCell(wsIn, `A${r}`, 'Edit the yellow cells. Everything else recalculates.');
  r += 2;

  // Global adjustments block (applied to grand total on Summary).
  setCell(wsIn, `A${r}`, 'GLOBAL ADJUSTMENTS'); r++;
  setCell(wsIn, `A${r}`, 'Freight %'); setCell(wsIn, `B${r}`, 0, { z: '0.00%' });
  const freightCell = `Inputs!$B$${r}`; r++;
  setCell(wsIn, `A${r}`, 'Waste / Shrinkage %'); setCell(wsIn, `B${r}`, 0, { z: '0.00%' });
  const wasteCell = `Inputs!$B$${r}`; r++;
  setCell(wsIn, `A${r}`, 'Tax %'); setCell(wsIn, `B${r}`, 0, { z: '0.00%' });
  const taxCell = `Inputs!$B$${r}`; r++;
  r++;

  setCell(wsIn, `A${r}`, 'FORMULA CASE COUNTS'); r++;
  setCell(wsIn, `A${r}`, 'Formula');
  setCell(wsIn, `B${r}`, 'Client');
  setCell(wsIn, `C${r}`, 'Cases');
  setCell(wsIn, `D${r}`, 'Units/Case');
  setCell(wsIn, `E${r}`, 'Total Units');
  r++;

  const caseRowStart = r;
  formulaData.forEach((fd, i) => {
    const row = r + i;
    setCell(wsIn, `A${row}`, fd.formula.name);
    setCell(wsIn, `B${row}`, fd.formula.client || '');
    setCell(wsIn, `C${row}`, fd.cases);
    setCell(wsIn, `D${row}`, fd.unitsPerCase);
    setCell(wsIn, `E${row}`, fd.totalUnits, { f: `C${row}*D${row}`, z: '#,##0' });
  });
  const caseRowEnd = caseRowStart + formulaData.length - 1;
  r = caseRowEnd + 1;
  setCell(wsIn, `A${r}`, 'TOTAL');
  setCell(wsIn, `C${r}`, totalCasesAll, { f: `SUM(C${caseRowStart}:C${caseRowEnd})`, z: '#,##0' });
  setCell(wsIn, `E${r}`, totalUnitsAll, { f: `SUM(E${caseRowStart}:E${caseRowEnd})`, z: '#,##0' });
  r++;

  // ── On-Hand Inventory (editable; one row per unique ingredient) ──────
  r++;
  setCell(wsIn, `A${r}`, 'ON-HAND INVENTORY  —  edit column C to reflect current stock'); r++;
  setCell(wsIn, `A${r}`, 'Ingredient');
  setCell(wsIn, `B${r}`, 'Unit');
  setCell(wsIn, `C${r}`, 'On Hand');
  r++;

  const onHandRefByKey = {};
  masterList.forEach((m, i) => {
    const row = r + i;
    setCell(wsIn, `A${row}`, m.name);
    setCell(wsIn, `B${row}`, m.buyUnit);
    setCell(wsIn, `C${row}`, m.onHand, { z: '#,##0.00' });
    onHandRefByKey[m.key] = `Inputs!$C$${row}`;
  });
  r += masterList.length;

  wsIn['!cols'] = [{ wch: 36 }, { wch: 20 }, { wch: 14 }, { wch: 12 }, { wch: 14 }];
  finalizeSheet(wsIn, r, 5);
  XLSX.utils.book_append_sheet(wb, wsIn, 'Inputs');

  // Map formula id → absolute Cases cell on Inputs sheet.
  const casesRefByFormulaId = {};
  formulaData.forEach((fd, i) => {
    casesRefByFormulaId[fd.formula.id] = `Inputs!$C$${caseRowStart + i}`;
  });

  // ═══════════════════════════════════════════════════════════════════
  //  Sheet 2 — Detail (per-formula × per-ingredient calc base)
  // ═══════════════════════════════════════════════════════════════════
  const wsDet = {};
  r = 1;
  setCell(wsDet, `A${r}`, 'PER-FORMULA × PER-INGREDIENT DEMAND'); r++;
  setCell(wsDet, `A${r}`, 'Feeds the Summary sheet via SUMIF lookups. Cases reference Inputs!.');
  r += 2;

  const detHeaders = [
    'Formula', 'Ingredient Key', 'Ingredient', 'Vendor', 'SKU', 'Buy Unit',
    'Demand/Case', 'Cases', 'Total Demand', 'MOQ', 'Price/Unit', 'Line Cost (MOQ)',
  ];
  detHeaders.forEach((h, i) => {
    setCell(wsDet, `${XLSX.utils.encode_col(i)}${r}`, h);
  });
  r++;

  const detStart = r;
  formulaData.forEach((fd) => {
    fd.ingredients.forEach((ing) => {
      const k = ingKey(ing);
      setCell(wsDet, `A${r}`, fd.formula.name);
      setCell(wsDet, `B${r}`, k);
      setCell(wsDet, `C${r}`, ing.name);
      setCell(wsDet, `D${r}`, ing.vendor);
      setCell(wsDet, `E${r}`, ing.sku);
      setCell(wsDet, `F${r}`, ing.buyUnit);
      setCell(wsDet, `G${r}`, ing.buyUnitPerCase, { z: '#,##0.0000' });
      // Cases → pulled live from Inputs.
      setCell(wsDet, `H${r}`, fd.cases, { f: casesRefByFormulaId[fd.formula.id], z: '#,##0' });
      // Total demand = per-case × cases.
      setCell(wsDet, `I${r}`, ing.totalDemand, { f: `G${r}*H${r}`, z: '#,##0.0000' });
      setCell(wsDet, `J${r}`, ing.moq, { z: '#,##0.####' });
      setCell(wsDet, `K${r}`, ing.pricePerBuyUnit, { z: '$#,##0.0000' });
      // Per-formula MOQ-adjusted line cost (each formula rounded independently).
      setCell(wsDet, `L${r}`, ing.lineCost, {
        f: `IF(J${r}>0,CEILING(I${r}/J${r},1)*J${r},I${r})*K${r}`,
        z: '$#,##0.00',
      });
      r++;
    });
  });
  const detEnd = r - 1;

  wsDet['!cols'] = [
    { wch: 28 }, { wch: 20 }, { wch: 28 }, { wch: 18 }, { wch: 14 }, { wch: 10 },
    { wch: 14 }, { wch: 10 }, { wch: 14 }, { wch: 10 }, { wch: 14 }, { wch: 16 },
  ];
  finalizeSheet(wsDet, r, 12);
  XLSX.utils.book_append_sheet(wb, wsDet, 'Detail');

  const detKeyRange = `Detail!$B$${detStart}:$B$${detEnd}`;
  const detDemandRange = `Detail!$I$${detStart}:$I$${detEnd}`;

  // ═══════════════════════════════════════════════════════════════════
  //  Sheet 3 — Summary (PO by Supplier + Cost/Can/Case)
  // ═══════════════════════════════════════════════════════════════════
  const wsSum = {};
  r = 1;
  setCell(wsSum, `A${r}`, 'CONSOLIDATED PO — SUMMARY'); r++;
  r++;

  // PO by Supplier (main consolidated table — shared MOQ across all formulas)
  setCell(wsSum, `A${r}`, 'PO BY SUPPLIER  —  shared MOQ across all formulas; Gross = ignoring on-hand, Net = after stock applied'); r++;
  const poHeaders = [
    'Supplier', 'Ingredient', 'SKU', 'Total Needed', 'On Hand', 'Net Needed', 'Unit',
    'MOQ', 'Order Qty', 'Price/Unit', 'Line Total (Net)', 'Gross Total', 'Savings', '# Formulas',
  ];
  poHeaders.forEach((h, i) => {
    setCell(wsSum, `${XLSX.utils.encode_col(i)}${r}`, h);
  });
  r++;

  // Group master by vendor for vendor sections.
  const byVendor = {};
  masterList.forEach((m) => {
    if (!byVendor[m.vendor]) byVendor[m.vendor] = [];
    byVendor[m.vendor].push(m);
  });

  const netSubtotalCells = [];
  const grossSubtotalCells = [];
  const savingsSubtotalCells = [];
  let grossSubtotalAll = 0;
  let netSubtotalAll = 0;
  Object.entries(byVendor).forEach(([vendor, items]) => {
    const vendorStart = r;
    let vendorNet = 0, vendorGross = 0;
    items.forEach((m, i) => {
      if (i === 0) setCell(wsSum, `A${r}`, vendor);
      setCell(wsSum, `B${r}`, m.name);
      setCell(wsSum, `C${r}`, m.sku || '');
      // Total Needed = SUMIF by ingredient key into Detail's Total Demand.
      setCell(wsSum, `D${r}`, m.totalDemand, {
        f: `SUMIF(${detKeyRange},"${esc(m.key)}",${detDemandRange})`,
        z: '#,##0.00',
      });
      // On-hand references the editable cell on Inputs so the user can
      // tweak stock and watch Net Needed / Order Qty / Line Total recalc.
      setCell(wsSum, `E${r}`, m.onHand, { f: onHandRefByKey[m.key], z: '#,##0.00' });
      setCell(wsSum, `F${r}`, m.netNeeded, { f: `MAX(0,D${r}-E${r})`, z: '#,##0.00' });
      setCell(wsSum, `G${r}`, m.buyUnit);
      setCell(wsSum, `H${r}`, m.moq, { z: '#,##0.####' });
      setCell(wsSum, `I${r}`, m.netOrderQty, {
        f: `IF(F${r}<=0,0,IF(H${r}>0,CEILING(F${r}/H${r},1)*H${r},F${r}))`,
        z: '#,##0.00',
      });
      setCell(wsSum, `J${r}`, m.pricePerBuyUnit, { z: '$#,##0.0000' });
      // Line Total (Net) — what you actually pay after applying on-hand.
      setCell(wsSum, `K${r}`, m.netLineTotal, { f: `I${r}*J${r}`, z: '$#,##0.00' });
      // Gross Total — MOQ-rounded gross demand × price (ignoring on-hand).
      setCell(wsSum, `L${r}`, m.grossLineTotal, {
        f: `IF(H${r}>0,CEILING(D${r}/H${r},1)*H${r},D${r})*J${r}`,
        z: '$#,##0.00',
      });
      // Savings = Gross − Net (highlights the benefit of existing stock).
      setCell(wsSum, `M${r}`, m.savings, { f: `L${r}-K${r}`, z: '$#,##0.00' });
      setCell(wsSum, `N${r}`, `${m.formulas.size}/${formulaData.length}`);
      vendorNet += m.netLineTotal;
      vendorGross += m.grossLineTotal;
      r++;
    });
    // Vendor subtotal (Net / Gross / Savings).
    setCell(wsSum, `J${r}`, 'Subtotal:');
    setCell(wsSum, `K${r}`, vendorNet, { f: `SUM(K${vendorStart}:K${r - 1})`, z: '$#,##0.00' });
    setCell(wsSum, `L${r}`, vendorGross, { f: `SUM(L${vendorStart}:L${r - 1})`, z: '$#,##0.00' });
    setCell(wsSum, `M${r}`, vendorGross - vendorNet, { f: `SUM(M${vendorStart}:M${r - 1})`, z: '$#,##0.00' });
    netSubtotalCells.push(`K${r}`);
    grossSubtotalCells.push(`L${r}`);
    savingsSubtotalCells.push(`M${r}`);
    grossSubtotalAll += vendorGross;
    netSubtotalAll += vendorNet;
    r += 2;
  });
  const savingsAll = grossSubtotalAll - netSubtotalAll;

  // Grand total block — shows Gross / Savings / Net side by side so the
  // user can see at a glance what existing stock saved them.
  setCell(wsSum, `J${r}`, 'GROSS SUBTOTAL (ingredients, no stock applied)');
  setCell(wsSum, `L${r}`, grossSubtotalAll, { f: `SUM(${grossSubtotalCells.join(',')})`, z: '$#,##0.00' });
  const grossSubtotalRef = `Summary!$L$${r}`;
  r++;
  setCell(wsSum, `J${r}`, 'SAVINGS FROM ON-HAND');
  setCell(wsSum, `M${r}`, savingsAll, { f: `SUM(${savingsSubtotalCells.join(',')})`, z: '$#,##0.00' });
  r++;
  setCell(wsSum, `J${r}`, 'NET SUBTOTAL (ingredients)');
  setCell(wsSum, `K${r}`, netSubtotalAll, { f: `SUM(${netSubtotalCells.join(',')})`, z: '$#,##0.00' });
  const ingSubtotalRef = `Summary!$K$${r}`;
  r++;

  // Adjustments apply to the NET subtotal (what's actually being purchased).
  setCell(wsSum, `J${r}`, 'Freight');
  setCell(wsSum, `K${r}`, 0, { f: `${ingSubtotalRef}*${freightCell}`, z: '$#,##0.00' });
  const freightLineRef = `Summary!$K$${r}`;
  r++;
  setCell(wsSum, `J${r}`, 'Waste / Shrinkage');
  setCell(wsSum, `K${r}`, 0, { f: `${ingSubtotalRef}*${wasteCell}`, z: '$#,##0.00' });
  const wasteLineRef = `Summary!$K$${r}`;
  r++;
  setCell(wsSum, `J${r}`, 'Tax');
  setCell(wsSum, `K${r}`, 0, {
    f: `(${ingSubtotalRef}+${freightLineRef}+${wasteLineRef})*${taxCell}`,
    z: '$#,##0.00',
  });
  const taxLineRef = `Summary!$K$${r}`;
  r++;
  setCell(wsSum, `J${r}`, 'GRAND TOTAL (Net, what you pay)');
  setCell(wsSum, `K${r}`, netSubtotalAll, {
    f: `${ingSubtotalRef}+${freightLineRef}+${wasteLineRef}+${taxLineRef}`,
    z: '$#,##0.00',
  });
  const grandTotalRef = `Summary!$K$${r}`;
  r++;
  // Gross grand total (what the PO would have cost without on-hand stock).
  setCell(wsSum, `J${r}`, 'GROSS GRAND TOTAL (if no stock)');
  setCell(wsSum, `L${r}`, grossSubtotalAll, {
    f: `${grossSubtotalRef}*(1+${freightCell}+${wasteCell})*(1+${taxCell})`,
    z: '$#,##0.00',
  });
  r += 2;

  // Per-finished-good cost rollup — Unit / Pack / Case / Pallet.
  // Values are pre-computed snapshots (static numbers) because pack/pallet
  // structure doesn't live on the Inputs sheet today. MOQ Cost = what you
  // purchase (rounded up). Non-MOQ Cost = what you actually consume
  // (demand × price). Per-level costs use Non-MOQ so they reflect true
  // unit economics; multiply by totals to reconcile.
  setCell(wsSum, `A${r}`, 'COST PER UNIT / PACK / CASE / PALLET  —  per finished good'); r++;
  const costHeaders = [
    'Finished Good', 'Units', 'Packs', 'Cases', 'Pallets',
    'Non-MOQ Cost', 'MOQ Cost',
    'Cost/Unit', 'Cost/Pack', 'Cost/Case', 'Cost/Pallet',
  ];
  costHeaders.forEach((h, i) => {
    setCell(wsSum, `${XLSX.utils.encode_col(i)}${r}`, h);
  });
  r++;

  (fgCosts || []).forEach((fc) => {
    setCell(wsSum, `A${r}`, fc.name);
    setCell(wsSum, `B${r}`, fc.totalUnits, { z: '#,##0' });
    setCell(wsSum, `C${r}`, fc.totalPacks, { z: '#,##0.##' });
    setCell(wsSum, `D${r}`, fc.totalCases, { z: '#,##0.##' });
    setCell(wsSum, `E${r}`, fc.totalPallets, { z: '#,##0.##' });
    setCell(wsSum, `F${r}`, fc.nonMoqCost, { z: '$#,##0.00' });
    setCell(wsSum, `G${r}`, fc.grossCost, { z: '$#,##0.00' });
    setCell(wsSum, `H${r}`, fc.nonMoqPerUnit, { z: '$#,##0.0000' });
    setCell(wsSum, `I${r}`, fc.nonMoqPerPack, { z: '$#,##0.00' });
    setCell(wsSum, `J${r}`, fc.nonMoqPerCase, { z: '$#,##0.00' });
    setCell(wsSum, `K${r}`, fc.nonMoqPerPallet, { z: '$#,##0.00' });
    r++;
  });

  // Blended row across all FGs — shared MOQ is the true PO cost, while
  // non-MOQ is the true consumption cost.
  if ((fgCosts || []).length > 1) {
    const totalUnitsAllFg = fgCosts.reduce((s, f) => s + f.totalUnits, 0);
    const totalPacksAllFg = fgCosts.reduce((s, f) => s + f.totalPacks, 0);
    const totalCasesAllFg = fgCosts.reduce((s, f) => s + f.totalCases, 0);
    const totalPalletsAllFg = fgCosts.reduce((s, f) => s + f.totalPallets, 0);
    const totalNonMoqAllFg = fgCosts.reduce((s, f) => s + f.nonMoqCost, 0);

    setCell(wsSum, `A${r}`, 'Blended Net (shared MOQ, after on-hand + adjustments)');
    setCell(wsSum, `B${r}`, totalUnitsAllFg, { z: '#,##0' });
    setCell(wsSum, `C${r}`, totalPacksAllFg, { z: '#,##0.##' });
    setCell(wsSum, `D${r}`, totalCasesAllFg, { z: '#,##0.##' });
    setCell(wsSum, `E${r}`, totalPalletsAllFg, { z: '#,##0.##' });
    setCell(wsSum, `F${r}`, totalNonMoqAllFg, { z: '$#,##0.00' });
    setCell(wsSum, `G${r}`, netSubtotalAll, { f: grandTotalRef, z: '$#,##0.00' });
    setCell(wsSum, `H${r}`, totalUnitsAllFg > 0 ? netSubtotalAll / totalUnitsAllFg : 0, {
      f: `IF(B${r}>0,G${r}/B${r},0)`, z: '$#,##0.0000',
    });
    setCell(wsSum, `I${r}`, totalPacksAllFg > 0 ? netSubtotalAll / totalPacksAllFg : 0, {
      f: `IF(C${r}>0,G${r}/C${r},0)`, z: '$#,##0.00',
    });
    setCell(wsSum, `J${r}`, totalCasesAllFg > 0 ? netSubtotalAll / totalCasesAllFg : 0, {
      f: `IF(D${r}>0,G${r}/D${r},0)`, z: '$#,##0.00',
    });
    setCell(wsSum, `K${r}`, totalPalletsAllFg > 0 ? netSubtotalAll / totalPalletsAllFg : 0, {
      f: `IF(E${r}>0,G${r}/E${r},0)`, z: '$#,##0.00',
    });
    r++;
  }

  wsSum['!cols'] = [
    { wch: 34 }, { wch: 28 }, { wch: 14 }, { wch: 14 }, { wch: 12 },
    { wch: 12 }, { wch: 10 }, { wch: 10 }, { wch: 14 }, { wch: 14 },
    { wch: 16 }, { wch: 14 }, { wch: 12 }, { wch: 12 },
  ];
  finalizeSheet(wsSum, r, 14);
  XLSX.utils.book_append_sheet(wb, wsSum, 'Summary');

  return wb;
}

// ── Public API ──────────────────────────────────────────────────────

function buildFilename() {
  return `Consolidated_PO_${new Date().toISOString().split('T')[0]}.xlsx`;
}

export function exportConsolidatedPOToExcel(input) {
  const wb = buildConsolidatedPOWorkbook(input);
  if (!wb) return false;
  XLSX.writeFile(wb, buildFilename());
  return true;
}

// Download the xlsx AND open Google Sheets in a new tab so the user
// can File → Import → Upload the file. Opens sheets.new which lands in
// a fresh blank Sheet ready to receive the upload.
export function exportConsolidatedPOToGoogleSheets(input) {
  const wb = buildConsolidatedPOWorkbook(input);
  if (!wb) return false;
  XLSX.writeFile(wb, buildFilename());
  // Open Google Sheets in a new tab. Must be called synchronously from
  // the click handler so browsers don't block the popup.
  try {
    window.open('https://sheets.new', '_blank', 'noopener,noreferrer');
  } catch {
    // Popup blocked — caller can fall back to showing a link.
  }
  return true;
}
