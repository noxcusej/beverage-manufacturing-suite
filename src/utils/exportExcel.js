// Single-run cost-sheet export. Mirrors the comparison export's design and
// breakdown structure: a Summary tab with headline KPIs + cost breakdown that
// references a Line Item Details tab where rates, quantities and config inputs
// are editable and every downstream figure recomputes via formula.

import { computeRunResults } from './runResults';
import {
  C, MONEY, MONEY4, INT,
  put, putF, band, tableHeader,
  filename, loadExcelJS, downloadWorkbook,
} from './excelStyle';
import {
  CATEGORIES, ALWAYS_CATEGORIES, LINE_ITEMS_COLUMNS, SHEET_LINE_ITEMS,
  writeRunBlock,
} from './runWorkbookBlocks';

function buildSummarySheet(ws, res, run, refs) {
  ws.columns = [{ width: 34 }, { width: 22 }, { width: 22 }];

  band(ws, 1, 3, run.name || 'Production Run', C.dark, C.white, 18, 30);
  ws.mergeCells('A2:C2');
  put(ws, 'A2', `Generated ${new Date().toLocaleDateString()}  ·  values link to the ${SHEET_LINE_ITEMS} tab`, { color: C.muted, size: 10 });
  ws.getRow(2).height = 16;

  put(ws, 'A4', 'RUN', { bold: true, color: C.teal, size: 10 });
  ws.mergeCells('B4:C4');
  put(ws, 'B4', run.name + (run.client ? `  —  ${run.client}` : ''), { bold: true, color: C.ink });

  let r = 6;

  // Headline metrics — each cost cell references the Line Item Details total / per-unit cell.
  const headerRow = (labels) => { tableHeader(ws, r, labels); r += 1; };
  const refRow = (label, ref, value, fmt, bold) => {
    const zebra = (r % 2 === 0) ? C.zebra : null;
    put(ws, `A${r}`, label, { bold, color: C.ink, bg: zebra, border: true });
    putF(ws, `B${r}`, ref, value, { bold, color: C.ink, bg: zebra, align: 'right', numFmt: fmt, border: true });
    put(ws, `C${r}`, '', { bg: zebra, border: true });
    r += 1;
  };
  const refRow2 = (label, ref, value, pctRef, pctValue) => {
    const zebra = (r % 2 === 0) ? C.zebra : null;
    put(ws, `A${r}`, label, { color: C.ink, bg: zebra, border: true });
    putF(ws, `B${r}`, ref, value, { color: C.ink, bg: zebra, align: 'right', numFmt: MONEY, border: true });
    putF(ws, `C${r}`, pctRef, pctValue, { color: C.muted, bg: zebra, align: 'right', numFmt: '0.0%', border: true });
    r += 1;
  };

  band(ws, r, 3, 'HEADLINE METRICS', C.teal); r += 1;
  headerRow(['Metric', 'Value', '']);
  refRow('Total Production Cost', refs.total, res.costs.totalCost, MONEY, true);
  refRow('Cost per Can', refs.perCan, res.costs.costPerUnit, MONEY4);
  refRow('Cost per Case', refs.perCase, res.costs.costPerCase, MONEY);
  refRow('Total Cans', refs.cans, res.counts.totalUnits, INT);
  refRow('Total Cases', refs.cases, res.counts.totalCases, INT);
  refRow('Total Pallets', refs.pallets, res.counts.totalPallets, INT);
  r += 1;

  band(ws, r, 3, 'COST BREAKDOWN', C.teal); r += 1;
  headerRow(['Category', 'Cost', '% of Total']);
  const totalRef = refs.total;
  CATEGORIES.forEach(([label, key]) => {
    const cost = res.breakdown.find((x) => x.label === label)?.cost || 0;
    if (!ALWAYS_CATEGORIES.has(key) && cost <= 0) return;
    const ref = refs.cat[key];
    const pct = res.costs.totalCost > 0 ? cost / res.costs.totalCost : 0;
    refRow2(label, ref, cost, `IF(${totalRef}>0,${ref}/${totalRef},0)`, pct);
  });
  r += 1;

  band(ws, r, 3, 'PRODUCTION SCOPE', C.teal); r += 1;
  tableHeader(ws, r, ['Setting', 'Value', '']);
  r += 1;
  const cfg = res.config;
  const scope = [
    ['Fill Volume', `${cfg.fillVolume ?? ''} ${cfg.fillVolumeUnit || 'oz'}`.trim()],
    ['Pack Format', `${cfg.packSize ?? ''}-pk / ${cfg.unitsPerCase ?? ''} per case`],
    ['Carrier', cfg.carrierType || 'paktech'],
    ['ABV', `${cfg.abv ?? 0}%`],
    ['Trucks', res.counts.totalTrucks],
    ['Flavors / SKUs', res.counts.flavorCount],
  ];
  scope.forEach(([label, value]) => {
    const zebra = (r % 2 === 0) ? C.zebra : null;
    put(ws, `A${r}`, label, { color: C.ink, bg: zebra, border: true });
    put(ws, `B${r}`, value, { color: C.ink, bg: zebra, align: 'right', border: true });
    put(ws, `C${r}`, '', { bg: zebra, border: true });
    r += 1;
  });

  ws.views = [{ state: 'frozen', ySplit: 5 }];
}

function buildLineItemsSheet(ws, res, run) {
  ws.columns = LINE_ITEMS_COLUMNS;
  const { refs } = writeRunBlock({ ws, startRow: 1, label: 'RUN', run, res, color: C.teal });
  return refs;
}

export async function exportCoPackingToExcel(runData) {
  const ExcelJS = await loadExcelJS();
  const res = computeRunResults(runData);

  const wb = new ExcelJS.Workbook();
  wb.creator = 'Beverage Manufacturing Suite';
  wb.created = new Date();
  wb.calcProperties = { fullCalcOnLoad: true };

  const wsSummary = wb.addWorksheet('Summary', { properties: { tabColor: { argb: C.teal } } });
  const wsLines = wb.addWorksheet(SHEET_LINE_ITEMS, { properties: { tabColor: { argb: C.purple } } });

  // Build the line-item sheet first so the summary can reference its cells.
  const refs = buildLineItemsSheet(wsLines, res, runData);
  buildSummarySheet(wsSummary, res, runData, refs);

  const stamp = new Date().toISOString().split('T')[0];
  await downloadWorkbook(wb, `${filename(runData.name || 'run_quote')}_${stamp}`);
}
