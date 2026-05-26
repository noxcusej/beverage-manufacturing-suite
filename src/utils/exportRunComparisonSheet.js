import { computeRunResults } from './runResults';

const C = {
  dark: 'FF102033',
  teal: 'FF0F766E',
  purple: 'FF6D28D9',
  amber: 'FFF59E0B',
  headerBg: 'FFEFF5F3',
  zebra: 'FFF7FAF9',
  white: 'FFFFFFFF',
  muted: 'FF64748B',
  ink: 'FF172033',
  red: 'FFB91C1C',
  green: 'FF15803D',
  border: 'FFD8DEE7',
};

const MONEY = '$#,##0.00';
const MONEY4 = '$#,##0.0000';
const INT = '#,##0';
const DELTA_MONEY = '"+"$#,##0.00;"-"$#,##0.00;$0.00';
const DELTA_MONEY4 = '"+"$#,##0.0000;"-"$#,##0.0000;$0.0000';
const DELTA_INT = '"+"#,##0;"-"#,##0;0';

const SHEET2 = 'Line Item Details';
const QUAL = `'${SHEET2}'!`;

function applyStyle(cell, s = {}) {
  const font = {};
  if (s.bold) font.bold = true;
  if (s.size) font.size = s.size;
  if (s.color) font.color = { argb: s.color };
  if (Object.keys(font).length) cell.font = font;
  if (s.bg) cell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: s.bg } };
  cell.alignment = { vertical: 'middle', horizontal: s.align || 'left', wrapText: !!s.wrap };
  if (s.numFmt) cell.numFmt = s.numFmt;
  if (s.border) {
    const b = { style: 'thin', color: { argb: C.border } };
    cell.border = { top: b, left: b, bottom: b, right: b };
  }
}

// value cell
function put(ws, addr, value, style) {
  const cell = ws.getCell(addr);
  cell.value = value;
  applyStyle(cell, style);
  return cell;
}

// formula cell (carries a cached result for viewers that don't auto-recalc)
function putF(ws, addr, formula, result, style) {
  const cell = ws.getCell(addr);
  cell.value = { formula, result };
  applyStyle(cell, style);
  return cell;
}

function deltaFont(value) {
  if (value > 0.005) return C.red;
  if (value < -0.005) return C.green;
  return C.muted;
}

function colLetter(i) {
  return String.fromCharCode(64 + i);
}

function band(ws, row, span, text, bg, color = C.white, size = 12, height = 22) {
  ws.mergeCells(`A${row}:${colLetter(span)}${row}`);
  put(ws, `A${row}`, text, { bold: true, color, bg, size, align: 'left' });
  ws.getRow(row).height = height;
}

// ── Tab 2: Line item details (formula-driven, returns cross-sheet refs) ──

const CATEGORIES = [
  ['Packaging Materials', 'packaging'],
  ['Cartons (Drayhorse)', 'carton'],
  ['Ingredients (optimized PO)', 'ingredients'],
  ['Tolling', 'tolling'],
  ['Bill of Materials', 'bom'],
  ['Batching Fees', 'batching'],
  ['Taxes & Regulatory', 'taxes'],
];

function feeRows(rows) {
  return (rows || []).filter((row) => !row.inactive);
}

function writeRunBlock(ws, startRow, label, run, res, color) {
  let r = startRow;
  band(ws, r, 7, `${label}  —  ${run.name}${run.client ? `  (${run.client})` : ''}`, color, C.white, 13, 24);
  r += 1;

  // Config inputs (referenced by the flavor formulas below)
  const upc = res.config.unitsPerCase || 24;
  const cpp = res.config.casesPerPallet || 80;
  put(ws, `A${r}`, 'Units per Case', { color: C.muted });
  put(ws, `B${r}`, upc, { color: C.ink, bold: true, align: 'right', numFmt: INT, border: true });
  const upcRow = r; r += 1;
  put(ws, `A${r}`, 'Cases per Pallet', { color: C.muted });
  put(ws, `B${r}`, cpp, { color: C.ink, bold: true, align: 'right', numFmt: INT, border: true });
  const cppRow = r; r += 2;

  const sectionHeader = (title) => { band(ws, r, 7, title, C.headerBg, C.ink, 11, 18); r += 1; };
  const tableHead = (cols) => {
    cols.forEach((cl, i) => {
      put(ws, `${colLetter(i + 1)}${r}`, cl, { bold: true, color: C.muted, bg: C.headerBg, align: i === 0 ? 'left' : 'right', border: true });
    });
    r += 1;
  };

  // Flavors — Cans = Cases * Units/Case, Pallets = CEILING(Cases/Cases-per-Pallet), Ingredient Cost = $/Can * Cans
  sectionHeader('Flavors / SKUs');
  tableHead(['Flavor', 'Cases', 'Cans', 'Pallets', 'Ingr $/Can', 'Batching Fee', 'Ingredient Cost']);
  const flvStart = r;
  res.counts.flavorRows.forEach((f) => {
    const zebra = (r % 2 === 0) ? C.zebra : null;
    const cells = { color: C.ink, bg: zebra, align: 'right', border: true };
    put(ws, `A${r}`, f.name || 'Flavor', { color: C.ink, bg: zebra, border: true });
    put(ws, `B${r}`, f.cases || 0, { ...cells, numFmt: INT });
    putF(ws, `C${r}`, `B${r}*$B$${upcRow}`, f.cans || 0, { ...cells, numFmt: INT });
    putF(ws, `D${r}`, `IF($B$${cppRow}>0,CEILING(B${r}/$B$${cppRow},1),0)`, f.pallets || 0, { ...cells, numFmt: INT });
    put(ws, `E${r}`, f.ingredientCost || 0, { ...cells, numFmt: MONEY4 });
    put(ws, `F${r}`, f.batchingFee || 0, { ...cells, numFmt: MONEY });
    putF(ws, `G${r}`, `E${r}*C${r}`, (f.ingredientCost || 0) * (f.cans || 0), { ...cells, numFmt: MONEY });
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
  const sub = (col, result) => putF(ws, `${col}${r}`, hasFlv ? `SUM(${col}${flvStart}:${col}${flvEnd})` : '0', result,
    { bold: true, color: C.ink, align: 'right', numFmt: col === 'F' || col === 'G' ? MONEY : INT, border: true });
  sub('B', res.counts.totalCases);
  sub('C', res.counts.totalUnits);
  sub('D', res.counts.totalPallets);
  put(ws, `E${r}`, '', { border: true });
  sub('F', res.costs.totalBatchingFees);
  sub('G', res.costs.totalIngredientCost);
  const casesCell = `B${r}`;
  const cansCell = `C${r}`;
  const palletsCell = `D${r}`;
  const batchingCell = `F${r}`;
  const ingredientsCell = `G${r}`;
  r += 2;

  // Fee sections — Line Cost = Rate * Qty
  const sectionCells = {};
  const feeSections = [
    ['Packaging Materials', 'packaging', res.costs.pkgRows, res.costs.rawPackagingCost],
    ['Tolling', 'tolling', res.costs.tollRows, res.costs.tollingCost],
    ['Bill of Materials', 'bom', res.costs.bomRows, res.costs.bomCost],
    ['Taxes & Regulatory', 'taxes', res.costs.taxRows, res.costs.taxCost],
  ];
  feeSections.forEach(([title, key, rows, subtotalVal]) => {
    sectionHeader(title);
    tableHead(['Item', 'Fee Type', 'Rate', 'Qty', '', '', 'Line Cost']);
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
    putF(ws, `G${r}`, data.length ? `SUM(G${dataStart}:G${dataEnd})` : '0', subtotalVal, { bold: true, color: C.ink, align: 'right', numFmt: MONEY, border: true });
    sectionCells[key] = `G${r}`;
    r += 2;
  });

  // Cartons (Drayhorse) — a priced lookup, not a rate*qty line
  sectionHeader('Cartons (Drayhorse)');
  put(ws, `A${r}`, 'Carton cost', { color: C.ink, border: true });
  ['B', 'C', 'D', 'E', 'F'].forEach((c) => put(ws, `${c}${r}`, '', { border: true }));
  put(ws, `G${r}`, res.costs.cartonCost || 0, { color: C.ink, align: 'right', numFmt: MONEY, border: true });
  sectionCells.carton = `G${r}`;
  r += 2;

  // Assemble per-category cells
  const cat = {
    packaging: sectionCells.packaging,
    carton: sectionCells.carton,
    ingredients: ingredientsCell,
    tolling: sectionCells.tolling,
    bom: sectionCells.bom,
    batching: batchingCell,
    taxes: sectionCells.taxes,
  };

  // Run total = sum of all category cells
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
  };
  return { nextRow: r, refs };
}

function buildLineItemsSheet(ws, a, b, runA, runB) {
  ws.columns = [{ width: 30 }, { width: 12 }, { width: 12 }, { width: 10 }, { width: 13 }, { width: 13 }, { width: 16 }];
  const blockA = writeRunBlock(ws, 1, 'RUN A', runA, a, C.teal);
  const blockB = writeRunBlock(ws, blockA.nextRow + 2, 'RUN B', runB, b, C.purple);
  return { refA: blockA.refs, refB: blockB.refs };
}

// ── Tab 1: Comparison summary (references the Line Item Details tab) ──

function buildComparisonSheet(ws, a, b, runA, runB, refA, refB, basis) {
  const perCase = basis === 'perCase';
  const breakdownFmt = perCase ? MONEY4 : MONEY;
  const breakdownDeltaFmt = perCase ? DELTA_MONEY4 : DELTA_MONEY;
  const basisVal = (res, cost) => (perCase ? (res.counts.totalCases > 0 ? cost / res.counts.totalCases : 0) : cost);

  ws.columns = [{ width: 34 }, { width: 20 }, { width: 20 }, { width: 20 }];

  band(ws, 1, 4, 'Production Run Comparison', C.dark, C.white, 18, 30);
  ws.mergeCells('A2:D2');
  put(ws, 'A2', `Generated ${new Date().toLocaleDateString()}  ·  values link to the ${SHEET2} tab`, { color: C.muted, size: 10 });
  ws.getRow(2).height = 16;

  put(ws, 'A4', 'RUN A', { bold: true, color: C.teal, size: 10 });
  ws.mergeCells('B4:D4');
  put(ws, 'B4', runA.name + (runA.client ? `  —  ${runA.client}` : ''), { bold: true, color: C.ink });
  put(ws, 'A5', 'RUN B', { bold: true, color: C.purple, size: 10 });
  ws.mergeCells('B5:D5');
  put(ws, 'B5', runB.name + (runB.client ? `  —  ${runB.client}` : ''), { bold: true, color: C.ink });

  let r = 7;

  const headerRow = () => {
    put(ws, `A${r}`, 'Metric', { bold: true, color: C.muted, bg: C.headerBg, border: true });
    put(ws, `B${r}`, 'Run A', { bold: true, color: C.muted, bg: C.headerBg, align: 'right', border: true });
    put(ws, `C${r}`, 'Run B', { bold: true, color: C.muted, bg: C.headerBg, align: 'right', border: true });
    put(ws, `D${r}`, 'Difference', { bold: true, color: C.muted, bg: C.headerBg, align: 'right', border: true });
    r += 1;
  };

  // label, A ref, B ref, A value, B value, number format, delta format, bold
  const refRow = (label, aRef, bRef, av, bv, fmt, dfmt, bold) => {
    const zebra = (r % 2 === 0) ? C.zebra : null;
    const d = bv - av;
    put(ws, `A${r}`, label, { bold, color: C.ink, bg: zebra, border: true });
    putF(ws, `B${r}`, aRef, av, { bold, color: C.ink, bg: zebra, align: 'right', numFmt: fmt, border: true });
    putF(ws, `C${r}`, bRef, bv, { bold, color: C.ink, bg: zebra, align: 'right', numFmt: fmt, border: true });
    putF(ws, `D${r}`, `C${r}-B${r}`, d, { bold: true, color: deltaFont(d), bg: zebra, align: 'right', numFmt: dfmt, border: true });
    r += 1;
  };

  band(ws, r, 4, 'HEADLINE METRICS', C.teal); r += 1;
  headerRow();
  refRow('Total Production Cost', refA.total, refB.total, a.costs.totalCost, b.costs.totalCost, MONEY, DELTA_MONEY, true);
  refRow('Cost per Can', refA.perCan, refB.perCan, a.costs.costPerUnit, b.costs.costPerUnit, MONEY4, DELTA_MONEY4);
  refRow('Cost per Case', refA.perCase, refB.perCase, a.costs.costPerCase, b.costs.costPerCase, MONEY, DELTA_MONEY);
  refRow('Total Cans', refA.cans, refB.cans, a.counts.totalUnits, b.counts.totalUnits, INT, DELTA_INT);
  refRow('Total Cases', refA.cases, refB.cases, a.counts.totalCases, b.counts.totalCases, INT, DELTA_INT);
  refRow('Total Pallets', refA.pallets, refB.pallets, a.counts.totalPallets, b.counts.totalPallets, INT, DELTA_INT);
  r += 1;

  band(ws, r, 4, `COST BREAKDOWN ${perCase ? '(PER CASE)' : '(TOTAL $)'}`, C.teal); r += 1;
  headerRow();
  const findCost = (bd, label) => (bd.find((x) => x.label === label)?.cost || 0);
  const always = new Set(['packaging', 'tolling', 'bom', 'taxes']);
  CATEGORIES.forEach(([label, key]) => {
    const av0 = findCost(a.breakdown, label);
    const bv0 = findCost(b.breakdown, label);
    if (!always.has(key) && av0 <= 0 && bv0 <= 0) return;
    const aRef = perCase ? `IF(${refA.cases}>0,${refA.cat[key]}/${refA.cases},0)` : refA.cat[key];
    const bRef = perCase ? `IF(${refB.cases}>0,${refB.cat[key]}/${refB.cases},0)` : refB.cat[key];
    refRow(label, aRef, bRef, basisVal(a, av0), basisVal(b, bv0), breakdownFmt, breakdownDeltaFmt);
  });
  r += 1;

  // Production scope (static descriptors)
  band(ws, r, 4, 'PRODUCTION SCOPE', C.teal); r += 1;
  put(ws, `A${r}`, 'Setting', { bold: true, color: C.muted, bg: C.headerBg, border: true });
  put(ws, `B${r}`, 'Run A', { bold: true, color: C.muted, bg: C.headerBg, align: 'right', border: true });
  put(ws, `C${r}`, 'Run B', { bold: true, color: C.muted, bg: C.headerBg, align: 'right', border: true });
  put(ws, `D${r}`, '', { bg: C.headerBg, border: true });
  r += 1;
  const scope = (cfg, counts) => [
    `${cfg.fillVolume ?? ''} ${cfg.fillVolumeUnit || 'oz'}`.trim(),
    `${cfg.packSize ?? ''}-pk / ${cfg.unitsPerCase ?? ''} per case`,
    cfg.carrierType || 'paktech',
    `${cfg.abv ?? 0}%`,
    counts.totalTrucks,
    counts.flavorCount,
  ];
  const sa = scope(a.config, a.counts);
  const sb = scope(b.config, b.counts);
  ['Fill Volume', 'Pack Format', 'Carrier', 'ABV', 'Trucks', 'Flavors / SKUs'].forEach((label, i) => {
    const zebra = (r % 2 === 0) ? C.zebra : null;
    put(ws, `A${r}`, label, { color: C.ink, bg: zebra, border: true });
    put(ws, `B${r}`, sa[i], { color: C.ink, bg: zebra, align: 'right', border: true });
    put(ws, `C${r}`, sb[i], { color: C.ink, bg: zebra, align: 'right', border: true });
    put(ws, `D${r}`, '', { bg: zebra, border: true });
    r += 1;
  });

  ws.views = [{ state: 'frozen', ySplit: 6 }];
}

function filename(value) {
  return String(value || 'run').trim().replace(/[^a-z0-9]+/gi, '_').replace(/^_+|_+$/g, '').toLowerCase();
}

export async function exportRunComparisonSheet(runA, runB, basis = 'total') {
  const { default: ExcelJS } = await import('exceljs');
  const a = computeRunResults(runA);
  const b = computeRunResults(runB);

  const wb = new ExcelJS.Workbook();
  wb.creator = 'Beverage Manufacturing Suite';
  wb.created = new Date();
  wb.calcProperties = { fullCalcOnLoad: true };

  const wsSummary = wb.addWorksheet('Comparison', { properties: { tabColor: { argb: C.teal } } });
  const wsLines = wb.addWorksheet(SHEET2, { properties: { tabColor: { argb: C.purple } } });

  // Build the line-item sheet first so the summary can reference its cells.
  const { refA, refB } = buildLineItemsSheet(wsLines, a, b, runA, runB);
  buildComparisonSheet(wsSummary, a, b, runA, runB, refA, refB, basis);

  const buffer = await wb.xlsx.writeBuffer();
  const blob = new Blob([buffer], { type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' });
  const url = URL.createObjectURL(blob);
  const link = document.createElement('a');
  link.href = url;
  link.download = `${filename(runA.name)}_vs_${filename(runB.name)}_comparison.xlsx`;
  document.body.appendChild(link);
  link.click();
  link.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}
