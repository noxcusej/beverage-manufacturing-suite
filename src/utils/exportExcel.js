// Unified run-quote workbook. Single export covers both the production cost
// breakdown and the consolidated raw-material PO so the user doesn't have to
// reconcile two separate spreadsheets. Tabs:
//
//   Summary           — banner, headline KPIs (cost-per-can/case AND the blended
//                       raw-PO cost-per-can), cost breakdown with unit prices on
//                       every row, PO summary, vendor breakdown, adjustments,
//                       production scope, per-finished-good costs.
//   Line Item Details — editable config inputs + flavor lineup + fee sections +
//                       carton + run total. Flavor cases here drive the PO tab.
//   Raw Material PO   — per-vendor ingredient PO; demand SUMPRODUCTs reference
//                       the Line Item Details flavor cells, so editing cases on
//                       Tab 2 recalculates everything including the PO grand
//                       total on Tab 1.

import { computeRunResults } from './runResults';
import {
  C, MONEY, MONEY4, INT, PERCENT,
  put, putF, band, tableHeader,
  filename, loadExcelJS, downloadWorkbook,
} from './excelStyle';
import {
  CATEGORIES, ALWAYS_CATEGORIES, LINE_ITEMS_COLUMNS, SHEET_LINE_ITEMS,
  writeRunBlock,
} from './runWorkbookBlocks';
import {
  SHEET_RAW_PO, prepareRawPOData, writeRawPOSheet,
} from './runWorkbookRawPO';

const INPUT_BG = 'FFFEF3C7';

function buildSummarySheet(ws, res, run, runRefs, poData, poRefs) {
  ws.columns = [{ width: 36 }, { width: 16 }, { width: 16 }, { width: 14 }, { width: 14 }];

  let r = 1;
  band(ws, r, 5, run.name || 'Production Run', C.dark, C.white, 18, 30); r += 1;
  ws.mergeCells(`A${r}:E${r}`);
  put(
    ws, `A${r}`,
    `Generated ${new Date().toLocaleDateString()}  ·  cost cells link to the ${SHEET_LINE_ITEMS} tab${poRefs ? `, raw materials link to the ${SHEET_RAW_PO} tab` : ''}`,
    { color: C.muted, size: 10 },
  );
  ws.getRow(r).height = 16;
  r += 1;

  put(ws, `A${r}`, 'RUN', { bold: true, color: C.teal, size: 10 });
  ws.mergeCells(`B${r}:E${r}`);
  put(ws, `B${r}`, run.name + (run.client ? `  —  ${run.client}` : ''), { bold: true, color: C.ink });
  r += 2;

  // ─────────────────────────────────────────────────────────────────────
  // HEADLINE METRICS — both the saved/quoted figures and the live blended
  // raw-PO cost-per-can/case (Net Subtotal ÷ Total Cans / Cases).
  // ─────────────────────────────────────────────────────────────────────
  band(ws, r, 5, 'HEADLINE METRICS', C.teal); r += 1;
  tableHeader(ws, r, ['Metric', 'Value', '', '', '']); r += 1;
  const kpi = (label, ref, value, fmt, bold) => {
    const zebra = (r % 2 === 0) ? C.zebra : null;
    put(ws, `A${r}`, label, { bold, color: C.ink, bg: zebra, border: true });
    if (typeof ref === 'string') {
      putF(ws, `B${r}`, ref, value, { bold, color: C.ink, bg: zebra, align: 'right', numFmt: fmt, border: true });
    } else {
      put(ws, `B${r}`, value, { bold, color: C.ink, bg: zebra, align: 'right', numFmt: fmt, border: true });
    }
    ['C', 'D', 'E'].forEach((c) => put(ws, `${c}${r}`, '', { bg: zebra, border: true }));
    r += 1;
  };
  kpi('Total Production Cost', runRefs.total, res.costs.totalCost, MONEY, true);
  kpi('Cost per Can', runRefs.perCan, res.costs.costPerUnit, MONEY4);
  kpi('Cost per Case', runRefs.perCase, res.costs.costPerCase, MONEY);
  if (poRefs) {
    const blendedPerCan = res.counts.totalUnits > 0 ? poData.netSubtotalAll / res.counts.totalUnits : 0;
    const blendedPerCase = res.counts.totalCases > 0 ? poData.netSubtotalAll / res.counts.totalCases : 0;
    kpi(
      'Raw Materials per Can (blended)',
      `IF(${runRefs.cans}>0,${poRefs.grandNet}/${runRefs.cans},0)`,
      blendedPerCan, MONEY4,
    );
    kpi(
      'Raw Materials per Case (blended)',
      `IF(${runRefs.cases}>0,${poRefs.grandNet}/${runRefs.cases},0)`,
      blendedPerCase, MONEY,
    );
  }
  kpi('Total Cans', runRefs.cans, res.counts.totalUnits, INT);
  kpi('Total Cases', runRefs.cases, res.counts.totalCases, INT);
  kpi('Total Pallets', runRefs.pallets, res.counts.totalPallets, INT);
  r += 1;

  // ─────────────────────────────────────────────────────────────────────
  // COST BREAKDOWN — every category with $/Can, $/Case, % of total, on one
  // line. This is where the user wants unit economics, not scattered.
  // ─────────────────────────────────────────────────────────────────────
  band(ws, r, 5, 'COST BREAKDOWN — unit economics per category', C.teal); r += 1;
  tableHeader(ws, r, ['Category', 'Cost', '$/Can', '$/Case', '% of Total']);
  r += 1;
  const totalRef = runRefs.total;
  const cansRef = runRefs.cans;
  const casesRef = runRefs.cases;
  CATEGORIES.forEach(([label, key]) => {
    const cost = res.breakdown.find((x) => x.label === label)?.cost || 0;
    if (!ALWAYS_CATEGORIES.has(key) && cost <= 0) return;
    const ref = runRefs.cat[key];
    const zebra = (r % 2 === 0) ? C.zebra : null;
    put(ws, `A${r}`, label, { color: C.ink, bg: zebra, border: true });
    putF(ws, `B${r}`, ref, cost, { color: C.ink, bg: zebra, align: 'right', numFmt: MONEY, border: true });
    putF(ws, `C${r}`, `IF(${cansRef}>0,${ref}/${cansRef},0)`,
      res.counts.totalUnits > 0 ? cost / res.counts.totalUnits : 0,
      { color: C.ink, bg: zebra, align: 'right', numFmt: MONEY4, border: true });
    putF(ws, `D${r}`, `IF(${casesRef}>0,${ref}/${casesRef},0)`,
      res.counts.totalCases > 0 ? cost / res.counts.totalCases : 0,
      { color: C.ink, bg: zebra, align: 'right', numFmt: MONEY, border: true });
    putF(ws, `E${r}`, `IF(${totalRef}>0,${ref}/${totalRef},0)`,
      res.costs.totalCost > 0 ? cost / res.costs.totalCost : 0,
      { color: C.muted, bg: zebra, align: 'right', numFmt: '0.0%', border: true });
    r += 1;
  });
  // Total row
  put(ws, `A${r}`, 'TOTAL', { bold: true, color: C.white, bg: C.dark, border: true });
  putF(ws, `B${r}`, totalRef, res.costs.totalCost,
    { bold: true, color: C.white, bg: C.dark, align: 'right', numFmt: MONEY, border: true });
  putF(ws, `C${r}`, runRefs.perCan, res.costs.costPerUnit,
    { bold: true, color: C.white, bg: C.dark, align: 'right', numFmt: MONEY4, border: true });
  putF(ws, `D${r}`, runRefs.perCase, res.costs.costPerCase,
    { bold: true, color: C.white, bg: C.dark, align: 'right', numFmt: MONEY, border: true });
  put(ws, `E${r}`, 1, { bold: true, color: C.white, bg: C.dark, align: 'right', numFmt: '0.0%', border: true });
  r += 2;

  // ─────────────────────────────────────────────────────────────────────
  // RAW MATERIAL PO SUMMARY (if applicable)
  // ─────────────────────────────────────────────────────────────────────
  let adjustmentRefs = null;
  if (poRefs) {
    band(ws, r, 5, 'RAW MATERIAL PO SUMMARY', C.teal); r += 1;
    tableHeader(ws, r, ['Line', 'Net', 'Gross', 'Savings', '']); r += 1;
    const poLine = (label, netRef, netVal, grossRef, grossVal, savingsRef, savingsVal, bold) => {
      const zebra = (r % 2 === 0) ? C.zebra : null;
      put(ws, `A${r}`, label, { bold, color: C.ink, bg: zebra, border: true });
      if (netRef) putF(ws, `B${r}`, netRef, netVal, { bold, color: C.ink, bg: zebra, align: 'right', numFmt: MONEY, border: true });
      else put(ws, `B${r}`, netVal, { bold, color: C.ink, bg: zebra, align: 'right', numFmt: MONEY, border: true });
      if (grossRef) putF(ws, `C${r}`, grossRef, grossVal, { bold, color: C.ink, bg: zebra, align: 'right', numFmt: MONEY, border: true });
      else put(ws, `C${r}`, grossVal, { color: C.muted, bg: zebra, align: 'right', numFmt: MONEY, border: true });
      if (savingsRef) putF(ws, `D${r}`, savingsRef, savingsVal, { bold, color: C.ink, bg: zebra, align: 'right', numFmt: MONEY, border: true });
      else put(ws, `D${r}`, savingsVal, { color: C.muted, bg: zebra, align: 'right', numFmt: MONEY, border: true });
      put(ws, `E${r}`, '', { bg: zebra, border: true });
      r += 1;
    };
    poLine('Ingredients (after on-hand applied)', poRefs.grandNet, poData.netSubtotalAll, poRefs.grandGross, poData.grossSubtotalAll, poRefs.grandSavings, poData.grossSubtotalAll - poData.netSubtotalAll, true);

    // Adjustments rows (editable rates, computed amounts).
    const editPct = (label, defaultPct) => {
      const zebra = (r % 2 === 0) ? C.zebra : null;
      put(ws, `A${r}`, `  ${label}`, { color: C.ink, bg: zebra, border: true });
      put(ws, `B${r}`, defaultPct, { color: C.ink, bg: INPUT_BG, bold: true, align: 'right', numFmt: PERCENT, border: true });
      ['C', 'D', 'E'].forEach((c) => put(ws, `${c}${r}`, '', { bg: zebra, border: true }));
      const cell = `$B$${r}`;
      r += 1;
      return cell;
    };
    const compRow = (label, formula, result) => {
      const zebra = (r % 2 === 0) ? C.zebra : null;
      put(ws, `A${r}`, `  ${label}`, { color: C.ink, bg: zebra, border: true });
      putF(ws, `B${r}`, formula, result, { color: C.ink, bg: zebra, align: 'right', numFmt: MONEY, border: true });
      ['C', 'D', 'E'].forEach((c) => put(ws, `${c}${r}`, '', { bg: zebra, border: true }));
      const cell = `$B$${r}`;
      r += 1;
      return cell;
    };
    const freightPct = editPct('Freight %', 0);
    const wastePct = editPct('Waste / Shrinkage %', 0);
    const taxPct = editPct('Tax %', 0);
    const net = poRefs.grandNet;
    const freightAmt = compRow('Freight $', `${net}*${freightPct}`, 0);
    const wasteAmt = compRow('Waste $', `${net}*${wastePct}`, 0);
    const taxAmt = compRow('Tax $', `(${net}+${freightAmt}+${wasteAmt})*${taxPct}`, 0);
    put(ws, `A${r}`, 'GRAND TOTAL (Net + Adjustments)', { bold: true, color: C.white, bg: C.dark, border: true });
    putF(ws, `B${r}`, `${net}+${freightAmt}+${wasteAmt}+${taxAmt}`, poData.netSubtotalAll,
      { bold: true, color: C.white, bg: C.dark, align: 'right', numFmt: MONEY, border: true });
    ['C', 'D', 'E'].forEach((c) => put(ws, `${c}${r}`, '', { bg: C.dark, border: true }));
    adjustmentRefs = { grandTotal: `$B$${r}` };
    r += 2;

    // ── VENDOR BREAKDOWN ──
    band(ws, r, 5, 'VENDOR BREAKDOWN', C.teal); r += 1;
    tableHeader(ws, r, ['Vendor', 'Net', 'Gross', 'Savings', '# Items']); r += 1;
    Object.entries(poRefs.vendors).forEach(([vendor, vref]) => {
      const items = poData.byVendor[vendor];
      const vNet = items.reduce((s, m) => s + m.netLineTotal, 0);
      const vGross = items.reduce((s, m) => s + m.grossLineTotal, 0);
      const vSavings = items.reduce((s, m) => s + m.savings, 0);
      const zebra = (r % 2 === 0) ? C.zebra : null;
      put(ws, `A${r}`, vendor, { color: C.ink, bg: zebra, border: true });
      putF(ws, `B${r}`, vref.net, vNet, { color: C.ink, bg: zebra, align: 'right', numFmt: MONEY, border: true });
      putF(ws, `C${r}`, vref.gross, vGross, { color: C.ink, bg: zebra, align: 'right', numFmt: MONEY, border: true });
      putF(ws, `D${r}`, vref.savings, vSavings, { color: C.ink, bg: zebra, align: 'right', numFmt: MONEY, border: true });
      put(ws, `E${r}`, vref.count, { color: C.ink, bg: zebra, align: 'right', numFmt: INT, border: true });
      r += 1;
    });
    r += 1;
  }

  // ─────────────────────────────────────────────────────────────────────
  // PRODUCTION SCOPE
  // ─────────────────────────────────────────────────────────────────────
  band(ws, r, 5, 'PRODUCTION SCOPE', C.teal); r += 1;
  tableHeader(ws, r, ['Setting', 'Value', '', '', '']); r += 1;
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
    ['C', 'D', 'E'].forEach((c) => put(ws, `${c}${r}`, '', { bg: zebra, border: true }));
    r += 1;
  });

  // ─────────────────────────────────────────────────────────────────────
  // COST PER FINISHED GOOD (per flavor, blended raw-material economics)
  // ─────────────────────────────────────────────────────────────────────
  if (poRefs && adjustmentRefs) {
    const flavorRows = res.counts.flavorRows.filter((f) => (f.cases || 0) > 0);
    if (flavorRows.length > 0) {
      r += 1;
      band(ws, r, 5, 'COST PER FINISHED GOOD', C.teal); r += 1;
      tableHeader(ws, r, ['Finished Good', 'Cases', 'Cans', 'Quoted $/Can', 'Blended PO $/Can']);
      r += 1;
      flavorRows.forEach((f) => {
        const zebra = (r % 2 === 0) ? C.zebra : null;
        put(ws, `A${r}`, f.name || 'Flavor', { color: C.ink, bg: zebra, border: true });
        put(ws, `B${r}`, f.cases, { color: C.ink, bg: zebra, align: 'right', numFmt: INT, border: true });
        put(ws, `C${r}`, f.cans, { color: C.ink, bg: zebra, align: 'right', numFmt: INT, border: true });
        put(ws, `D${r}`, f.ingredientCost || 0, { color: C.ink, bg: zebra, align: 'right', numFmt: MONEY4, border: true });
        // Blended share — what this flavor would cost per can if it absorbed
        // its proportional slice of the PO grand total (Net + Adjustments).
        putF(
          ws, `E${r}`,
          `IF(${runRefs.cans}>0,${adjustmentRefs.grandTotal}/${runRefs.cans},0)`,
          res.counts.totalUnits > 0 ? poData.netSubtotalAll / res.counts.totalUnits : 0,
          { color: C.ink, bg: zebra, align: 'right', numFmt: MONEY4, border: true },
        );
        r += 1;
      });
    }
  }

  ws.views = [{ state: 'frozen', ySplit: 5 }];
}

function buildLineItemsSheet(ws, res, run) {
  ws.columns = LINE_ITEMS_COLUMNS;
  const { refs } = writeRunBlock({ ws, startRow: 1, label: 'RUN', run, res, color: C.teal });
  return refs;
}

// Build the workbook. Returns the ExcelJS workbook instance.
async function buildWorkbook({ run, rawPO }) {
  const ExcelJS = await loadExcelJS();
  const res = computeRunResults(run);

  const wb = new ExcelJS.Workbook();
  wb.creator = 'Beverage Manufacturing Suite';
  wb.created = new Date();
  wb.calcProperties = { fullCalcOnLoad: true };

  const wsSummary = wb.addWorksheet('Summary', { properties: { tabColor: { argb: C.teal } } });
  const wsLines = wb.addWorksheet(SHEET_LINE_ITEMS, { properties: { tabColor: { argb: C.purple } } });

  // Build line items first so the Summary can reference its cells.
  const runRefs = buildLineItemsSheet(wsLines, res, run);

  // Build Raw PO if there are any formulas with cases.
  let poData = null;
  let poRefs = null;
  if (rawPO && rawPO.selectedFormulas?.length > 0) {
    poData = prepareRawPOData(rawPO);
    if (poData) {
      const wsPO = wb.addWorksheet(SHEET_RAW_PO, { properties: { tabColor: { argb: C.amber } } });
      poRefs = writeRawPOSheet({
        ws: wsPO,
        data: poData,
        flavorsByFormulaId: runRefs.flavorsByFormulaId || {},
      });
    }
  }

  buildSummarySheet(wsSummary, res, run, runRefs, poData, poRefs);
  return wb;
}

function workbookName(run) {
  const stamp = new Date().toISOString().split('T')[0];
  return `${filename(run.name || 'run_quote')}_${stamp}`;
}

export async function exportCoPackingToExcel({ run, rawPO } = {}) {
  const wb = await buildWorkbook({ run, rawPO });
  await downloadWorkbook(wb, workbookName(run));
}

// Download the workbook AND open Google Sheets in a new tab so the user can
// File → Import → Upload the file. The window.open must be invoked
// synchronously from the original click handler to bypass popup blockers.
export async function exportCoPackingToGoogleSheets({ run, rawPO } = {}) {
  // Open the tab synchronously before any awaits.
  let win = null;
  if (typeof window !== 'undefined') {
    try { win = window.open('https://sheets.new', '_blank', 'noopener,noreferrer'); } catch { /* popup blocked */ }
  }
  try {
    const wb = await buildWorkbook({ run, rawPO });
    await downloadWorkbook(wb, workbookName(run));
  } catch (e) {
    if (win) try { win.close(); } catch { /* ignore */ }
    throw e;
  }
}
