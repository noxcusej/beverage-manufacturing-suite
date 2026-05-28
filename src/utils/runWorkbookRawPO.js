// Raw-material PO data prep and writer. Computes the per-vendor consolidated
// PO and writes it into a sheet whose Total Demand column is a SUMPRODUCT over
// a "Formula Cases" mini-table — that mini-table itself derives from cell refs
// on the Line Item Details sheet so the run's flavor lineup is the single
// source of truth for case counts.

import {
  C, MONEY, MONEY4, INT, DEC,
  put, putF, band, tableHeader,
} from './excelStyle';

export const SHEET_RAW_PO = 'Raw Material PO';
const QUAL_PO = `'${SHEET_RAW_PO}'!`;

// ── Unit conversion ──────────────────────────────────────────────────
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
  const { unitSizeVal = 12, unitSizeUnit = 'oz', unitsPerCase = 24, batchSizeUnit = 'gal' } = formula;
  const units = cases * unitsPerCase;
  let unitOz = unitSizeVal;
  if (unitSizeUnit === 'ml' || unitSizeUnit === 'mL') unitOz = unitSizeVal / 29.5703;
  else if (unitSizeUnit === 'L') unitOz = unitSizeVal * 33.814;
  const totalGal = (units * unitOz) / 128;
  return batchSizeUnit === 'L' ? totalGal * 3.78541 : totalGal;
}

function calcIngredientDemandPerCase(formula, inventoryMap) {
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
    let onHandInBuyUnits = 0;
    const invQty = ing.currentInventory || 0;
    const invUnit = ing.inventoryUnit || buyUnit;
    if (invQty > 0) {
      onHandInBuyUnits = invUnit === buyUnit ? invQty : convertWithSG(invQty, invUnit, buyUnit, ing.specificGravity);
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

export function prepareRawPOData({ selectedFormulas, inventoryMap, caseCounts }) {
  const formulaData = (selectedFormulas || [])
    .map((f) => ({
      formula: f,
      cases: caseCounts[f.id] || 0,
      unitsPerCase: f.unitsPerCase || 24,
      ingredients: calcIngredientDemandPerCase(f, inventoryMap),
    }))
    .filter((fd) => fd.cases > 0 && fd.ingredients.length > 0);

  if (formulaData.length === 0) return null;

  formulaData.forEach((fd) => { fd.totalUnits = fd.cases * fd.unitsPerCase; });

  const masterMap = new Map();
  formulaData.forEach((fd) => {
    fd.ingredients.forEach((ing) => {
      const k = ingKey(ing);
      if (!masterMap.has(k)) {
        masterMap.set(k, {
          key: k, name: ing.name, sku: ing.sku, vendor: ing.vendor || 'No Vendor',
          buyUnit: ing.buyUnit, pricePerBuyUnit: ing.pricePerBuyUnit, moq: ing.moq,
          onHand: 0, demandByFormulaId: {},
        });
      }
      const m = masterMap.get(k);
      if (ing.pricePerBuyUnit > 0) m.pricePerBuyUnit = ing.pricePerBuyUnit;
      if (ing.moq > 1) m.moq = ing.moq;
      if (ing.onHandInBuyUnits > m.onHand) m.onHand = ing.onHandInBuyUnits;
      m.demandByFormulaId[fd.formula.id] = (m.demandByFormulaId[fd.formula.id] || 0) + ing.buyUnitPerCase;
    });
  });
  const masterList = Array.from(masterMap.values());

  masterList.forEach((m) => {
    let totalDemand = 0;
    formulaData.forEach((fd) => {
      totalDemand += (m.demandByFormulaId[fd.formula.id] || 0) * fd.cases;
    });
    m.totalDemand = totalDemand;
    m.netNeeded = Math.max(0, totalDemand - m.onHand);
    const moq = m.moq || 1;
    m.grossOrderQty = moq > 0 ? Math.ceil(totalDemand / moq) * moq : totalDemand;
    m.netOrderQty = m.netNeeded <= 0 ? 0 : (moq > 0 ? Math.ceil(m.netNeeded / moq) * moq : m.netNeeded);
    m.grossLineTotal = m.grossOrderQty * (m.pricePerBuyUnit || 0);
    m.netLineTotal = m.netOrderQty * (m.pricePerBuyUnit || 0);
    m.savings = m.grossLineTotal - m.netLineTotal;
  });

  const byVendor = {};
  masterList.forEach((m) => {
    if (!byVendor[m.vendor]) byVendor[m.vendor] = [];
    byVendor[m.vendor].push(m);
  });

  const grossSubtotalAll = masterList.reduce((s, m) => s + m.grossLineTotal, 0);
  const netSubtotalAll = masterList.reduce((s, m) => s + m.netLineTotal, 0);
  const totalCasesAll = formulaData.reduce((s, fd) => s + fd.cases, 0);
  const totalUnitsAll = formulaData.reduce((s, fd) => s + fd.totalUnits, 0);

  return { formulaData, masterList, byVendor, grossSubtotalAll, netSubtotalAll, totalCasesAll, totalUnitsAll };
}

// Build `{d1;d2;...}` array constant matching formula order; d = per-case demand.
function arrayConst(formulaData, mapByFormulaId) {
  const vals = formulaData.map((fd) => mapByFormulaId[fd.formula.id] || 0);
  return `{${vals.map((v) => Number(v.toFixed(8))).join(';')}}`;
}

const INPUT_BG = 'FFFEF3C7'; // pale amber = editable cell

// Writes Tab 3 "Raw Material PO". `flavorsByFormulaId` maps formulaId to an
// array of qualified flavor-cell refs on the Line Item Details sheet (e.g.
// `'Line Item Details'!B7`). The Formula Cases column sums those, and the
// per-vendor SUMPRODUCT references that Cases column.
export function writeRawPOSheet({ ws, data, flavorsByFormulaId }) {
  const { formulaData, byVendor } = data;

  ws.columns = [
    { width: 30 }, { width: 16 }, { width: 14 }, { width: 12 }, { width: 12 },
    { width: 8 }, { width: 10 }, { width: 12 }, { width: 12 }, { width: 14 },
    { width: 14 }, { width: 12 },
  ];

  let r = 1;
  band(ws, r, 12, 'Raw Material PO', C.dark, C.white, 16, 28); r += 1;
  ws.mergeCells(`A${r}:L${r}`);
  put(ws, `A${r}`, 'Edit yellow cells (on-hand, price) and the flavor cases on the Line Item Details tab — everything recalculates.', { color: C.muted, size: 10 });
  ws.getRow(r).height = 16;
  r += 2;

  // ── FORMULA CASES (derived from the Line Item Details flavor lineup) ──
  band(ws, r, 12, 'FORMULA CASES  —  sums flavor cases from Line Item Details', C.teal); r += 1;
  tableHeader(ws, r, ['Formula', 'Client', 'Cases', 'Units/Case', 'Total Units', '', '', '', '', '', '', '']);
  r += 1;
  const caseStart = r;
  formulaData.forEach((fd) => {
    const zebra = (r % 2 === 0) ? C.zebra : null;
    const flavorCells = flavorsByFormulaId[fd.formula.id] || [];
    const casesFormula = flavorCells.length ? flavorCells.join('+') : '0';
    put(ws, `A${r}`, fd.formula.name, { color: C.ink, bg: zebra, border: true });
    put(ws, `B${r}`, fd.formula.client || '', { color: C.ink, bg: zebra, border: true });
    putF(ws, `C${r}`, casesFormula, fd.cases,
      { color: C.ink, bg: zebra, bold: true, align: 'right', numFmt: INT, border: true });
    put(ws, `D${r}`, fd.unitsPerCase, { color: C.ink, bg: zebra, align: 'right', numFmt: INT, border: true });
    putF(ws, `E${r}`, `C${r}*D${r}`, fd.totalUnits,
      { color: C.ink, bg: zebra, align: 'right', numFmt: INT, border: true });
    r += 1;
  });
  const caseEnd = r - 1;
  put(ws, `A${r}`, 'Total', { bold: true, color: C.ink, border: true });
  put(ws, `B${r}`, '', { border: true });
  putF(ws, `C${r}`, `SUM(C${caseStart}:C${caseEnd})`, data.totalCasesAll,
    { bold: true, color: C.ink, align: 'right', numFmt: INT, border: true });
  put(ws, `D${r}`, '', { border: true });
  putF(ws, `E${r}`, `SUM(E${caseStart}:E${caseEnd})`, data.totalUnitsAll,
    { bold: true, color: C.ink, align: 'right', numFmt: INT, border: true });
  const casesTotalCell = `C${r}`;
  const unitsTotalCell = `E${r}`;
  r += 2;

  const casesRange = `$C$${caseStart}:$C$${caseEnd}`;

  // ── PO BY VENDOR ──
  band(ws, r, 12, 'PO BY VENDOR  —  shared MOQ across all formulas', C.teal); r += 1;
  tableHeader(ws, r, [
    'Ingredient', 'SKU', 'Total Demand', 'On Hand', 'Net Needed', 'Unit',
    'MOQ', 'Order Qty', 'Price', 'Net Total', 'Gross Total', 'Savings',
  ]);
  r += 1;

  const vendorRefs = {};
  const vendorSubtotalRows = { net: [], gross: [], savings: [] };
  Object.entries(byVendor).forEach(([vendor, items]) => {
    band(ws, r, 12, vendor, C.headerBg, C.ink, 11, 18); r += 1;
    const vStart = r;
    items.forEach((m) => {
      const zebra = (r % 2 === 0) ? C.zebra : null;
      const demandArr = arrayConst(formulaData, m.demandByFormulaId);
      put(ws, `A${r}`, m.name, { color: C.ink, bg: zebra, border: true });
      put(ws, `B${r}`, m.sku || '', { color: C.ink, bg: zebra, border: true });
      putF(ws, `C${r}`, `SUMPRODUCT(${demandArr},${casesRange})`, m.totalDemand,
        { color: C.ink, bg: zebra, align: 'right', numFmt: DEC, border: true });
      put(ws, `D${r}`, m.onHand, { color: C.ink, bg: INPUT_BG, align: 'right', numFmt: DEC, border: true });
      putF(ws, `E${r}`, `MAX(0,C${r}-D${r})`, m.netNeeded,
        { color: C.ink, bg: zebra, align: 'right', numFmt: DEC, border: true });
      put(ws, `F${r}`, m.buyUnit, { color: C.ink, bg: zebra, align: 'right', border: true });
      put(ws, `G${r}`, m.moq, { color: C.ink, bg: zebra, align: 'right', numFmt: DEC, border: true });
      putF(ws, `H${r}`, `IF(E${r}<=0,0,IF(G${r}>0,CEILING(E${r}/G${r},1)*G${r},E${r}))`, m.netOrderQty,
        { color: C.ink, bg: zebra, align: 'right', numFmt: DEC, border: true });
      put(ws, `I${r}`, m.pricePerBuyUnit, { color: C.ink, bg: INPUT_BG, align: 'right', numFmt: MONEY4, border: true });
      putF(ws, `J${r}`, `H${r}*I${r}`, m.netLineTotal,
        { color: C.ink, bg: zebra, align: 'right', numFmt: MONEY, border: true });
      putF(ws, `K${r}`, `IF(G${r}>0,CEILING(C${r}/G${r},1)*G${r},C${r})*I${r}`, m.grossLineTotal,
        { color: C.ink, bg: zebra, align: 'right', numFmt: MONEY, border: true });
      putF(ws, `L${r}`, `K${r}-J${r}`, m.savings,
        { color: C.ink, bg: zebra, align: 'right', numFmt: MONEY, border: true });
      r += 1;
    });
    const vEnd = r - 1;
    put(ws, `A${r}`, 'Subtotal', { bold: true, color: C.ink, border: true });
    ['B', 'C', 'D', 'E', 'F', 'G', 'H', 'I'].forEach((c) => put(ws, `${c}${r}`, '', { border: true }));
    const vendorNet = items.reduce((s, m) => s + m.netLineTotal, 0);
    const vendorGross = items.reduce((s, m) => s + m.grossLineTotal, 0);
    const vendorSavings = items.reduce((s, m) => s + m.savings, 0);
    putF(ws, `J${r}`, `SUM(J${vStart}:J${vEnd})`, vendorNet,
      { bold: true, color: C.ink, align: 'right', numFmt: MONEY, border: true });
    putF(ws, `K${r}`, `SUM(K${vStart}:K${vEnd})`, vendorGross,
      { bold: true, color: C.ink, align: 'right', numFmt: MONEY, border: true });
    putF(ws, `L${r}`, `SUM(L${vStart}:L${vEnd})`, vendorSavings,
      { bold: true, color: C.ink, align: 'right', numFmt: MONEY, border: true });
    vendorRefs[vendor] = { net: `J${r}`, gross: `K${r}`, savings: `L${r}`, count: items.length };
    vendorSubtotalRows.net.push(`J${r}`);
    vendorSubtotalRows.gross.push(`K${r}`);
    vendorSubtotalRows.savings.push(`L${r}`);
    r += 2;
  });

  band(ws, r, 12, 'GRAND TOTAL', C.teal); r += 1;
  put(ws, `A${r}`, 'Ingredients (net / gross / savings)', { bold: true, color: C.ink, border: true });
  ['B', 'C', 'D', 'E', 'F', 'G', 'H', 'I'].forEach((c) => put(ws, `${c}${r}`, '', { border: true }));
  putF(ws, `J${r}`, `SUM(${vendorSubtotalRows.net.join(',')})`, data.netSubtotalAll,
    { bold: true, color: C.ink, align: 'right', numFmt: MONEY, border: true });
  putF(ws, `K${r}`, `SUM(${vendorSubtotalRows.gross.join(',')})`, data.grossSubtotalAll,
    { bold: true, color: C.ink, align: 'right', numFmt: MONEY, border: true });
  putF(ws, `L${r}`, `SUM(${vendorSubtotalRows.savings.join(',')})`, data.grossSubtotalAll - data.netSubtotalAll,
    { bold: true, color: C.ink, align: 'right', numFmt: MONEY, border: true });
  const grandNetCell = `J${r}`;
  const grandGrossCell = `K${r}`;
  const grandSavingsCell = `L${r}`;
  r += 1;

  ws.views = [{ state: 'frozen', ySplit: 4 }];

  return {
    casesTotal: QUAL_PO + casesTotalCell,
    unitsTotal: QUAL_PO + unitsTotalCell,
    grandNet: QUAL_PO + grandNetCell,
    grandGross: QUAL_PO + grandGrossCell,
    grandSavings: QUAL_PO + grandSavingsCell,
    vendors: Object.fromEntries(Object.entries(vendorRefs).map(([k, v]) => [k, {
      net: QUAL_PO + v.net, gross: QUAL_PO + v.gross, savings: QUAL_PO + v.savings, count: v.count,
    }])),
  };
}
