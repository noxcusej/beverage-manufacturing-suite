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

function put(ws, addr, value, style) {
  const cell = ws.getCell(addr);
  cell.value = value;
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

// Writes a header band spanning columns 1..span at the given row.
function band(ws, row, span, text, bg, color = C.white, size = 12, height = 22) {
  ws.mergeCells(`A${row}:${colLetter(span)}${row}`);
  put(ws, `A${row}`, text, { bold: true, color, bg, size, align: 'left' });
  ws.getRow(row).height = height;
}

// ── Tab 1: Comparison summary ──

function buildComparisonSheet(ws, a, b, runA, runB, basis) {
  const perCase = basis === 'perCase';
  const basisCost = (res, cost) => (perCase ? (res.counts.totalCases > 0 ? cost / res.counts.totalCases : 0) : cost);
  const breakdownFmt = perCase ? MONEY4 : MONEY;
  const breakdownDeltaFmt = perCase ? DELTA_MONEY4 : DELTA_MONEY;
  ws.columns = [{ width: 34 }, { width: 20 }, { width: 20 }, { width: 20 }];

  band(ws, 1, 4, 'Production Run Comparison', C.dark, C.white, 18, 30);
  ws.mergeCells('A2:D2');
  put(ws, 'A2', `Generated ${new Date().toLocaleDateString()}`, { color: C.muted, size: 10 });
  ws.getRow(2).height = 16;

  put(ws, 'A4', 'RUN A', { bold: true, color: C.teal, size: 10 });
  ws.mergeCells('B4:D4');
  put(ws, 'B4', runA.name + (runA.client ? `  —  ${runA.client}` : ''), { bold: true, color: C.ink });
  put(ws, 'A5', 'RUN B', { bold: true, color: C.purple, size: 10 });
  ws.mergeCells('B5:D5');
  put(ws, 'B5', runB.name + (runB.client ? `  —  ${runB.client}` : ''), { bold: true, color: C.ink });

  let r = 7;

  const headerRow = (row) => {
    put(ws, `A${row}`, 'Metric', { bold: true, color: C.muted, bg: C.headerBg, border: true });
    put(ws, `B${row}`, 'Run A', { bold: true, color: C.muted, bg: C.headerBg, align: 'right', border: true });
    put(ws, `C${row}`, 'Run B', { bold: true, color: C.muted, bg: C.headerBg, align: 'right', border: true });
    put(ws, `D${row}`, 'Difference', { bold: true, color: C.muted, bg: C.headerBg, align: 'right', border: true });
  };

  const metricRow = (row, label, av, bv, fmt, deltaFmt, bold) => {
    const zebra = (row % 2 === 0) ? C.zebra : null;
    const d = bv - av;
    put(ws, `A${row}`, label, { bold, color: C.ink, bg: zebra, border: true });
    put(ws, `B${row}`, av, { bold, color: C.ink, bg: zebra, align: 'right', numFmt: fmt, border: true });
    put(ws, `C${row}`, bv, { bold, color: C.ink, bg: zebra, align: 'right', numFmt: fmt, border: true });
    put(ws, `D${row}`, d, { bold: true, color: deltaFont(d), bg: zebra, align: 'right', numFmt: deltaFmt, border: true });
  };

  band(ws, r, 4, 'HEADLINE METRICS', C.teal); r += 1;
  headerRow(r); r += 1;
  metricRow(r, 'Total Production Cost', a.costs.totalCost, b.costs.totalCost, MONEY, DELTA_MONEY, true); r += 1;
  metricRow(r, 'Cost per Can', a.costs.costPerUnit, b.costs.costPerUnit, MONEY4, DELTA_MONEY); r += 1;
  metricRow(r, 'Cost per Case', a.costs.costPerCase, b.costs.costPerCase, MONEY, DELTA_MONEY); r += 1;
  metricRow(r, 'Total Cans', a.counts.totalUnits, b.counts.totalUnits, INT, DELTA_INT); r += 1;
  metricRow(r, 'Total Cases', a.counts.totalCases, b.counts.totalCases, INT, DELTA_INT); r += 1;
  metricRow(r, 'Total Pallets', a.counts.totalPallets, b.counts.totalPallets, INT, DELTA_INT); r += 2;

  band(ws, r, 4, `COST BREAKDOWN ${perCase ? '(PER CASE)' : '(TOTAL $)'}`, C.teal); r += 1;
  headerRow(r); r += 1;
  const labels = [];
  [...a.breakdown, ...b.breakdown].forEach((row) => { if (!labels.includes(row.label)) labels.push(row.label); });
  const findCost = (bd, label) => (bd.find((x) => x.label === label)?.cost || 0);
  labels.forEach((label) => {
    metricRow(r, label, basisCost(a, findCost(a.breakdown, label)), basisCost(b, findCost(b.breakdown, label)), breakdownFmt, breakdownDeltaFmt);
    r += 1;
  });
  r += 1;

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

// ── Tab 2: Line item details ──

function feeRows(rows) {
  return (rows || []).filter((row) => !row.inactive).map((row) => [row.name || 'Line item', row.feeType || '', row.rate || 0, row.qty || 0, row.lineCost || 0]);
}

function writeRunBlock(ws, startRow, label, run, res, color) {
  let r = startRow;
  band(ws, r, 6, `${label}  —  ${run.name}${run.client ? `  (${run.client})` : ''}`, color, C.white, 13, 24);
  r += 1;

  const sectionHeader = (title) => { band(ws, r, 6, title, C.headerBg, C.ink, 11, 18); r += 1; };
  const tableHead = (cols) => {
    cols.forEach((label, i) => {
      put(ws, `${colLetter(i + 1)}${r}`, label, { bold: true, color: C.muted, bg: C.headerBg, align: i === 0 ? 'left' : 'right', border: true });
    });
    r += 1;
  };

  // Flavors
  sectionHeader('Flavors / SKUs');
  tableHead(['Flavor', 'Cases', 'Cans', 'Ingr $/Can', 'Batching Fee', 'Ingredient Cost']);
  const flvStart = r;
  res.counts.flavorRows.forEach((f) => {
    const zebra = (r % 2 === 0) ? C.zebra : null;
    put(ws, `A${r}`, f.name || 'Flavor', { color: C.ink, bg: zebra, border: true });
    put(ws, `B${r}`, f.cases || 0, { color: C.ink, bg: zebra, align: 'right', numFmt: INT, border: true });
    put(ws, `C${r}`, f.cans || 0, { color: C.ink, bg: zebra, align: 'right', numFmt: INT, border: true });
    put(ws, `D${r}`, f.ingredientCost || 0, { color: C.ink, bg: zebra, align: 'right', numFmt: MONEY4, border: true });
    put(ws, `E${r}`, f.batchingFee || 0, { color: C.ink, bg: zebra, align: 'right', numFmt: MONEY, border: true });
    put(ws, `F${r}`, (f.ingredientCost || 0) * (f.cans || 0), { color: C.ink, bg: zebra, align: 'right', numFmt: MONEY, border: true });
    r += 1;
  });
  const flvEnd = r - 1;
  put(ws, `A${r}`, 'Subtotal', { bold: true, color: C.ink, border: true });
  put(ws, `B${r}`, { formula: `SUM(B${flvStart}:B${flvEnd})` }, { bold: true, align: 'right', numFmt: INT, border: true });
  put(ws, `C${r}`, { formula: `SUM(C${flvStart}:C${flvEnd})` }, { bold: true, align: 'right', numFmt: INT, border: true });
  put(ws, `E${r}`, { formula: `SUM(E${flvStart}:E${flvEnd})` }, { bold: true, align: 'right', numFmt: MONEY, border: true });
  put(ws, `F${r}`, { formula: `SUM(F${flvStart}:F${flvEnd})` }, { bold: true, align: 'right', numFmt: MONEY, border: true });
  put(ws, `D${r}`, '', { border: true });
  r += 2;

  const feeSections = [
    ['Packaging Materials', res.costs.pkgRows],
    ['Tolling', res.costs.tollRows],
    ['Bill of Materials', res.costs.bomRows],
    ['Taxes & Regulatory', res.costs.taxRows],
  ];
  feeSections.forEach(([title, rows]) => {
    sectionHeader(title);
    tableHead(['Item', 'Fee Type', 'Rate', 'Qty', '', 'Line Cost']);
    const dataStart = r;
    const data = feeRows(rows);
    data.forEach(([name, feeType, rate, qty, lineCost]) => {
      const zebra = (r % 2 === 0) ? C.zebra : null;
      put(ws, `A${r}`, name, { color: C.ink, bg: zebra, border: true });
      put(ws, `B${r}`, feeType, { color: C.ink, bg: zebra, align: 'right', border: true });
      put(ws, `C${r}`, rate, { color: C.ink, bg: zebra, align: 'right', numFmt: MONEY4, border: true });
      put(ws, `D${r}`, qty, { color: C.ink, bg: zebra, align: 'right', numFmt: INT, border: true });
      put(ws, `E${r}`, '', { bg: zebra, border: true });
      put(ws, `F${r}`, lineCost, { color: C.ink, bg: zebra, align: 'right', numFmt: MONEY, border: true });
      r += 1;
    });
    if (data.length === 0) {
      put(ws, `A${r}`, 'No items', { color: C.muted, border: true });
      ['B', 'C', 'D', 'E', 'F'].forEach((c) => put(ws, `${c}${r}`, '', { border: true }));
      r += 1;
    }
    const dataEnd = r - 1;
    put(ws, `A${r}`, 'Subtotal', { bold: true, color: C.ink, border: true });
    ['B', 'C', 'D', 'E'].forEach((c) => put(ws, `${c}${r}`, '', { border: true }));
    put(ws, `F${r}`, data.length ? { formula: `SUM(F${dataStart}:F${dataEnd})` } : 0, { bold: true, align: 'right', numFmt: MONEY, border: true });
    r += 2;
  });

  band(ws, r, 6, 'RUN TOTAL', color, C.white, 12, 22);
  put(ws, `F${r}`, res.costs.totalCost, { bold: true, color: C.white, bg: color, align: 'right', numFmt: MONEY });
  r += 1;
  put(ws, `A${r}`, 'Cost per Can', { color: C.muted });
  put(ws, `F${r}`, res.costs.costPerUnit, { align: 'right', numFmt: MONEY4, color: C.ink, bold: true });
  r += 1;
  put(ws, `A${r}`, 'Cost per Case', { color: C.muted });
  put(ws, `F${r}`, res.costs.costPerCase, { align: 'right', numFmt: MONEY, color: C.ink, bold: true });
  r += 1;

  return r;
}

function buildLineItemsSheet(ws, a, b, runA, runB) {
  ws.columns = [{ width: 32 }, { width: 16 }, { width: 14 }, { width: 12 }, { width: 14 }, { width: 18 }];
  let r = 1;
  r = writeRunBlock(ws, r, 'RUN A', runA, a, C.teal);
  r += 2;
  writeRunBlock(ws, r, 'RUN B', runB, b, C.purple);
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

  buildComparisonSheet(wb.addWorksheet('Comparison', { properties: { tabColor: { argb: C.teal } } }), a, b, runA, runB, basis);
  buildLineItemsSheet(wb.addWorksheet('Line Item Details', { properties: { tabColor: { argb: C.purple } } }), a, b, runA, runB);

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
