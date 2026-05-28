import { computeRunResults } from './runResults';
import {
  C, MONEY, MONEY4, INT,
  DELTA_MONEY, DELTA_MONEY4, DELTA_INT,
  put, putF, band, tableHeader, deltaFont,
  filename, loadExcelJS, downloadWorkbook,
} from './excelStyle';
import {
  CATEGORIES, ALWAYS_CATEGORIES, LINE_ITEMS_COLUMNS, SHEET_LINE_ITEMS,
  writeRunBlock,
} from './runWorkbookBlocks';

function buildLineItemsSheet(ws, a, b, runA, runB) {
  ws.columns = LINE_ITEMS_COLUMNS;
  const blockA = writeRunBlock({ ws, startRow: 1, label: 'RUN A', run: runA, res: a, color: C.teal });
  const blockB = writeRunBlock({ ws, startRow: blockA.nextRow + 2, label: 'RUN B', run: runB, res: b, color: C.purple });
  return { refA: blockA.refs, refB: blockB.refs };
}

function buildComparisonSheet(ws, a, b, runA, runB, refA, refB, basis) {
  const perCase = basis === 'perCase';
  const breakdownFmt = perCase ? MONEY4 : MONEY;
  const breakdownDeltaFmt = perCase ? DELTA_MONEY4 : DELTA_MONEY;
  const basisVal = (res, cost) => (perCase ? (res.counts.totalCases > 0 ? cost / res.counts.totalCases : 0) : cost);

  ws.columns = [{ width: 34 }, { width: 20 }, { width: 20 }, { width: 20 }];

  band(ws, 1, 4, 'Production Run Comparison', C.dark, C.white, 18, 30);
  ws.mergeCells('A2:D2');
  put(ws, 'A2', `Generated ${new Date().toLocaleDateString()}  ·  values link to the ${SHEET_LINE_ITEMS} tab`, { color: C.muted, size: 10 });
  ws.getRow(2).height = 16;

  put(ws, 'A4', 'RUN A', { bold: true, color: C.teal, size: 10 });
  ws.mergeCells('B4:D4');
  put(ws, 'B4', runA.name + (runA.client ? `  —  ${runA.client}` : ''), { bold: true, color: C.ink });
  put(ws, 'A5', 'RUN B', { bold: true, color: C.purple, size: 10 });
  ws.mergeCells('B5:D5');
  put(ws, 'B5', runB.name + (runB.client ? `  —  ${runB.client}` : ''), { bold: true, color: C.ink });

  let r = 7;
  const headerRow = () => { tableHeader(ws, r, ['Metric', 'Run A', 'Run B', 'Difference']); r += 1; };

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
  CATEGORIES.forEach(([label, key]) => {
    const av0 = findCost(a.breakdown, label);
    const bv0 = findCost(b.breakdown, label);
    if (!ALWAYS_CATEGORIES.has(key) && av0 <= 0 && bv0 <= 0) return;
    const aRef = perCase ? `IF(${refA.cases}>0,${refA.cat[key]}/${refA.cases},0)` : refA.cat[key];
    const bRef = perCase ? `IF(${refB.cases}>0,${refB.cat[key]}/${refB.cases},0)` : refB.cat[key];
    refRow(label, aRef, bRef, basisVal(a, av0), basisVal(b, bv0), breakdownFmt, breakdownDeltaFmt);
  });
  r += 1;

  band(ws, r, 4, 'PRODUCTION SCOPE', C.teal); r += 1;
  tableHeader(ws, r, ['Setting', 'Run A', 'Run B', '']);
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

export async function exportRunComparisonSheet(runA, runB, basis = 'total') {
  const ExcelJS = await loadExcelJS();
  const a = computeRunResults(runA);
  const b = computeRunResults(runB);

  const wb = new ExcelJS.Workbook();
  wb.creator = 'Beverage Manufacturing Suite';
  wb.created = new Date();
  wb.calcProperties = { fullCalcOnLoad: true };

  const wsSummary = wb.addWorksheet('Comparison', { properties: { tabColor: { argb: C.teal } } });
  const wsLines = wb.addWorksheet(SHEET_LINE_ITEMS, { properties: { tabColor: { argb: C.purple } } });

  const { refA, refB } = buildLineItemsSheet(wsLines, a, b, runA, runB);
  buildComparisonSheet(wsSummary, a, b, runA, runB, refA, refB, basis);

  await downloadWorkbook(wb, `${filename(runA.name)}_vs_${filename(runB.name)}_comparison`);
}
