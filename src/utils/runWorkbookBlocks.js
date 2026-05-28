// Shared "Line Item Details" writer used by the single-run export and the
// two-run comparison export. Lays out one run as: editable config inputs ->
// flavor formulas -> fee sections -> carton -> run total + per-can/per-case.
// Returns sheet-qualified A1 cell refs so a Summary sheet can reference each
// category subtotal, total, and quantity directly.

import {
  C, MONEY, MONEY4, INT,
  put, putF, band, tableHeader,
} from './excelStyle';

export const SHEET_LINE_ITEMS = 'Line Item Details';

// Canonical category order used by every "cost breakdown" view in the app.
// Each entry is [display label, key], with the key matching the field on the
// `cat` ref object returned by writeRunBlock.
export const CATEGORIES = [
  ['Packaging Materials', 'packaging'],
  ['Cartons (Drayhorse)', 'carton'],
  ['Ingredients (optimized PO)', 'ingredients'],
  ['Tolling', 'tolling'],
  ['Bill of Materials', 'bom'],
  ['Batching Fees', 'batching'],
  ['Taxes & Regulatory', 'taxes'],
];

// Always-shown categories regardless of value (the others appear only when
// at least one run/quote has a non-zero value for them).
export const ALWAYS_CATEGORIES = new Set(['packaging', 'tolling', 'bom', 'taxes']);

export const LINE_ITEMS_COLUMNS = [
  { width: 30 }, { width: 12 }, { width: 12 }, { width: 10 },
  { width: 13 }, { width: 13 }, { width: 16 },
];

function feeRows(rows) {
  return (rows || []).filter((row) => !row.inactive);
}

// Writes a single run's block starting at `startRow`. Returns
// { nextRow, refs } where refs uses the qualified form `'Line Item Details'!G36`
// so other sheets can reference the cells directly via formula.
//
// `sheetName` controls the qualification prefix on the returned refs so the
// single-run export (one sheet) and the comparison export (two runs in the
// same sheet) can both consume them.
export function writeRunBlock({ ws, startRow, label, run, res, color, sheetName = SHEET_LINE_ITEMS }) {
  const QUAL = `'${sheetName}'!`;
  let r = startRow;

  band(ws, r, 7, `${label}  —  ${run.name}${run.client ? `  (${run.client})` : ''}`, color, C.white, 13, 24);
  r += 1;

  // Config inputs the flavor formulas reference.
  const upc = res.config.unitsPerCase || 24;
  const cpp = res.config.casesPerPallet || 80;
  put(ws, `A${r}`, 'Units per Case', { color: C.muted });
  put(ws, `B${r}`, upc, { color: C.ink, bold: true, align: 'right', numFmt: INT, border: true });
  const upcRow = r; r += 1;
  put(ws, `A${r}`, 'Cases per Pallet', { color: C.muted });
  put(ws, `B${r}`, cpp, { color: C.ink, bold: true, align: 'right', numFmt: INT, border: true });
  const cppRow = r; r += 2;

  const sectionHeader = (title) => { band(ws, r, 7, title, C.headerBg, C.ink, 11, 18); r += 1; };

  // Flavors — Cans = Cases * Units/Case, Pallets = CEILING(Cases / Cases-per-Pallet),
  // Ingredient Cost = $/Can * Cans.
  sectionHeader('Flavors / SKUs');
  tableHeader(ws, r, ['Flavor', 'Cases', 'Cans', 'Pallets', 'Ingr $/Can', 'Batching Fee', 'Ingredient Cost']);
  r += 1;
  const flvStart = r;
  const flavorCellsByFormulaId = {}; // formulaId -> [unqualified B cell refs]
  res.counts.flavorRows.forEach((f) => {
    const zebra = (r % 2 === 0) ? C.zebra : null;
    const baseCell = { color: C.ink, bg: zebra, align: 'right', border: true };
    put(ws, `A${r}`, f.name || 'Flavor', { color: C.ink, bg: zebra, border: true });
    put(ws, `B${r}`, f.cases || 0, { ...baseCell, numFmt: INT });
    putF(ws, `C${r}`, `B${r}*$B$${upcRow}`, f.cans || 0, { ...baseCell, numFmt: INT });
    putF(ws, `D${r}`, `IF($B$${cppRow}>0,CEILING(B${r}/$B$${cppRow},1),0)`, f.pallets || 0, { ...baseCell, numFmt: INT });
    put(ws, `E${r}`, f.ingredientCost || 0, { ...baseCell, numFmt: MONEY4 });
    put(ws, `F${r}`, f.batchingFee || 0, { ...baseCell, numFmt: MONEY });
    putF(ws, `G${r}`, `E${r}*C${r}`, (f.ingredientCost || 0) * (f.cans || 0), { ...baseCell, numFmt: MONEY });
    if (f.formulaId) {
      if (!flavorCellsByFormulaId[f.formulaId]) flavorCellsByFormulaId[f.formulaId] = [];
      flavorCellsByFormulaId[f.formulaId].push(`B${r}`);
    }
    r += 1;
  });
  if (res.counts.flavorRows.length === 0) {
    put(ws, `A${r}`, 'No flavors', { color: C.muted, border: true });
    ['B', 'C', 'D', 'E', 'F', 'G'].forEach((c) => put(ws, `${c}${r}`, '', { border: true }));
    r += 1;
  }
  const flvEnd = r - 1;
  const hasFlv = res.counts.flavorRows.length > 0;
  put(ws, `A${r}`, 'Subtotal', { bold: true, color: C.ink, border: true });
  const sub = (col, result, fmt) => putF(
    ws, `${col}${r}`,
    hasFlv ? `SUM(${col}${flvStart}:${col}${flvEnd})` : '0',
    result,
    { bold: true, color: C.ink, align: 'right', numFmt: fmt, border: true },
  );
  sub('B', res.counts.totalCases, INT);
  sub('C', res.counts.totalUnits, INT);
  sub('D', res.counts.totalPallets, INT);
  put(ws, `E${r}`, '', { border: true });
  sub('F', res.costs.totalBatchingFees, MONEY);
  sub('G', res.costs.totalIngredientCost, MONEY);
  const casesCell = `B${r}`;
  const cansCell = `C${r}`;
  const palletsCell = `D${r}`;
  const batchingCell = `F${r}`;
  const ingredientsCell = `G${r}`;
  r += 2;

  // Fee sections — Line Cost = Rate * Qty, with rate & qty kept as raw inputs.
  const sectionCells = {};
  const feeSections = [
    ['Packaging Materials', 'packaging', res.costs.pkgRows, res.costs.rawPackagingCost],
    ['Tolling', 'tolling', res.costs.tollRows, res.costs.tollingCost],
    ['Bill of Materials', 'bom', res.costs.bomRows, res.costs.bomCost],
    ['Taxes & Regulatory', 'taxes', res.costs.taxRows, res.costs.taxCost],
  ];
  feeSections.forEach(([title, key, rows, subtotalVal]) => {
    sectionHeader(title);
    tableHeader(ws, r, ['Item', 'Fee Type', 'Rate', 'Qty', '', '', 'Line Cost']);
    r += 1;
    const dataStart = r;
    const data = feeRows(rows);
    data.forEach((row) => {
      const zebra = (r % 2 === 0) ? C.zebra : null;
      put(ws, `A${r}`, row.name || 'Line item', { color: C.ink, bg: zebra, border: true });
      put(ws, `B${r}`, row.feeType || '', { color: C.ink, bg: zebra, align: 'right', border: true });
      put(ws, `C${r}`, row.rate || 0, { color: C.ink, bg: zebra, align: 'right', numFmt: MONEY4, border: true });
      put(ws, `D${r}`, row.qty || 0, { color: C.ink, bg: zebra, align: 'right', numFmt: INT, border: true });
      put(ws, `E${r}`, '', { bg: zebra, border: true });
      put(ws, `F${r}`, '', { bg: zebra, border: true });
      putF(ws, `G${r}`, `C${r}*D${r}`, row.lineCost || 0, { color: C.ink, bg: zebra, align: 'right', numFmt: MONEY, border: true });
      r += 1;
    });
    if (data.length === 0) {
      put(ws, `A${r}`, 'No items', { color: C.muted, border: true });
      ['B', 'C', 'D', 'E', 'F', 'G'].forEach((c) => put(ws, `${c}${r}`, '', { border: true }));
      r += 1;
    }
    const dataEnd = r - 1;
    put(ws, `A${r}`, 'Subtotal', { bold: true, color: C.ink, border: true });
    ['B', 'C', 'D', 'E', 'F'].forEach((c) => put(ws, `${c}${r}`, '', { border: true }));
    putF(
      ws, `G${r}`,
      data.length ? `SUM(G${dataStart}:G${dataEnd})` : '0',
      subtotalVal,
      { bold: true, color: C.ink, align: 'right', numFmt: MONEY, border: true },
    );
    sectionCells[key] = `G${r}`;
    r += 2;
  });

  // Cartons — a priced lookup, not a rate*qty line.
  sectionHeader('Cartons (Drayhorse)');
  put(ws, `A${r}`, 'Carton cost', { color: C.ink, border: true });
  ['B', 'C', 'D', 'E', 'F'].forEach((c) => put(ws, `${c}${r}`, '', { border: true }));
  put(ws, `G${r}`, res.costs.cartonCost || 0, { color: C.ink, align: 'right', numFmt: MONEY, border: true });
  sectionCells.carton = `G${r}`;
  r += 2;

  const cat = {
    packaging: sectionCells.packaging,
    carton: sectionCells.carton,
    ingredients: ingredientsCell,
    tolling: sectionCells.tolling,
    bom: sectionCells.bom,
    batching: batchingCell,
    taxes: sectionCells.taxes,
  };

  // Run total = sum of every category cell on this same sheet.
  const totalFormula = Object.values(cat).join('+');
  band(ws, r, 7, 'RUN TOTAL', color, C.white, 12, 22);
  putF(ws, `G${r}`, totalFormula, res.costs.totalCost, { bold: true, color: C.white, bg: color, align: 'right', numFmt: MONEY });
  const totalCell = `G${r}`;
  r += 1;
  put(ws, `A${r}`, 'Cost per Can', { color: C.muted });
  putF(ws, `G${r}`, `IF(${cansCell}>0,${totalCell}/${cansCell},0)`, res.costs.costPerUnit, { align: 'right', numFmt: MONEY4, color: C.ink, bold: true });
  const perCanCell = `G${r}`;
  r += 1;
  put(ws, `A${r}`, 'Cost per Case', { color: C.muted });
  putF(ws, `G${r}`, `IF(${casesCell}>0,${totalCell}/${casesCell},0)`, res.costs.costPerCase, { align: 'right', numFmt: MONEY, color: C.ink, bold: true });
  const perCaseCell = `G${r}`;
  r += 1;

  const refs = {
    cat: Object.fromEntries(Object.entries(cat).map(([k, v]) => [k, QUAL + v])),
    total: QUAL + totalCell,
    perCan: QUAL + perCanCell,
    perCase: QUAL + perCaseCell,
    cases: QUAL + casesCell,
    cans: QUAL + cansCell,
    pallets: QUAL + palletsCell,
    // Per-flavor B-cell refs grouped by formulaId, qualified to this sheet.
    // The Raw Material PO tab uses these so flavor cases drive PO demand live.
    flavorsByFormulaId: Object.fromEntries(
      Object.entries(flavorCellsByFormulaId).map(([fid, cells]) => [fid, cells.map((c) => QUAL + c)])
    ),
  };
  return { nextRow: r, refs };
}
