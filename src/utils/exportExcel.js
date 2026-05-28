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
  C, MONEY, MONEY4, INT,
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
  // PRODUCTION SCOPE (top — sets context before any numbers)
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
  r += 1;

  // ─────────────────────────────────────────────────────────────────────
  // HEADLINE METRICS — saved/quoted figures + (if PO) the blended raw-PO
  // cost-per-can/case (PO Net ÷ Total Cans / Cases). Blended is THE
  // consolidated cost-per-can the user asked to surface prominently.
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
    kpi('Raw Materials Cost per Can (blended)', poRefs.blendedPerCan,
      res.counts.totalUnits > 0 ? poData.netSubtotalAll / res.counts.totalUnits : 0, MONEY4);
    kpi('Raw Materials Cost per Case (blended)', poRefs.blendedPerCase,
      res.counts.totalCases > 0 ? poData.netSubtotalAll / res.counts.totalCases : 0, MONEY);
  }
  kpi('Total Cans', runRefs.cans, res.counts.totalUnits, INT);
  kpi('Total Cases', runRefs.cases, res.counts.totalCases, INT);
  kpi('Total Pallets', runRefs.pallets, res.counts.totalPallets, INT);
  r += 1;

  // ─────────────────────────────────────────────────────────────────────
  // COST PER FORMULA — per-formula ingredient cost (allocated PO share).
  // This is per-recipe, NOT per-finished-good; the finished-good cost is
  // the COST BREAKDOWN below (all-in: ingredients + packaging + tolling…).
  // ─────────────────────────────────────────────────────────────────────
  if (poRefs && Object.keys(poRefs.formulas).length > 0) {
    band(ws, r, 5, 'COST PER FORMULA — ingredient cost only (PO-allocated)', C.teal); r += 1;
    tableHeader(ws, r, ['Formula', 'Cases', 'Cans', 'Ingredient Cost', '$/Can']); r += 1;
    poData.formulaData.forEach((fd) => {
      const fref = poRefs.formulas[fd.formula.id];
      if (!fref) return;
      const zebra = (r % 2 === 0) ? C.zebra : null;
      put(ws, `A${r}`, fd.formula.name, { color: C.ink, bg: zebra, border: true });
      putF(ws, `B${r}`, fref.cases, fd.cases, { color: C.ink, bg: zebra, align: 'right', numFmt: INT, border: true });
      putF(ws, `C${r}`, fref.units, fd.totalUnits, { color: C.ink, bg: zebra, align: 'right', numFmt: INT, border: true });
      putF(ws, `D${r}`, fref.cost, fd.allocatedIngredientCost, { color: C.ink, bg: zebra, align: 'right', numFmt: MONEY, border: true });
      putF(ws, `E${r}`, fref.perCan, fd.costPerCan, { color: C.ink, bg: zebra, align: 'right', numFmt: MONEY4, border: true });
      r += 1;
    });
    // Blended total
    put(ws, `A${r}`, 'BLENDED', { bold: true, color: C.white, bg: C.dark, border: true });
    putF(ws, `B${r}`, poRefs.casesTotal, poData.totalCasesAll, { bold: true, color: C.white, bg: C.dark, align: 'right', numFmt: INT, border: true });
    putF(ws, `C${r}`, poRefs.unitsTotal, poData.totalUnitsAll, { bold: true, color: C.white, bg: C.dark, align: 'right', numFmt: INT, border: true });
    putF(ws, `D${r}`, poRefs.blendedCost, poData.netSubtotalAll, { bold: true, color: C.white, bg: C.dark, align: 'right', numFmt: MONEY, border: true });
    putF(ws, `E${r}`, poRefs.blendedPerCan,
      poData.totalUnitsAll > 0 ? poData.netSubtotalAll / poData.totalUnitsAll : 0,
      { bold: true, color: C.white, bg: C.dark, align: 'right', numFmt: MONEY4, border: true });
    r += 2;
  }

  // ─────────────────────────────────────────────────────────────────────
  // COST BREAKDOWN — the finished-good cost: ingredients + packaging +
  // tolling + BOM + taxes, with $/Can, $/Case, % of total per category.
  // ─────────────────────────────────────────────────────────────────────
  band(ws, r, 5, 'FINISHED GOOD COST BREAKDOWN', C.teal); r += 1;
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
  // RAW MATERIAL PO SUMMARY (no spreadsheet-level Freight/Waste/Tax — those
  // are already priced in at the formula/ingredient level).
  // ─────────────────────────────────────────────────────────────────────
  if (poRefs) {
    band(ws, r, 5, 'RAW MATERIAL PO SUMMARY', C.teal); r += 1;
    tableHeader(ws, r, ['Line', 'Amount', '', '', '']); r += 1;
    const poRow = (label, ref, value, fmt, bold) => {
      const zebra = (r % 2 === 0) ? C.zebra : null;
      put(ws, `A${r}`, label, { bold, color: C.ink, bg: zebra, border: true });
      if (ref) putF(ws, `B${r}`, ref, value, { bold, color: C.ink, bg: zebra, align: 'right', numFmt: fmt, border: true });
      else put(ws, `B${r}`, value, { bold, color: C.ink, bg: zebra, align: 'right', numFmt: fmt, border: true });
      ['C', 'D', 'E'].forEach((c) => put(ws, `${c}${r}`, '', { bg: zebra, border: true }));
      r += 1;
    };
    poRow('Net Total (what you pay for ingredients)', poRefs.grandNet, poData.netSubtotalAll, MONEY, true);
    poRow('Blended Cost per Can', poRefs.blendedPerCan,
      poData.totalUnitsAll > 0 ? poData.netSubtotalAll / poData.totalUnitsAll : 0, MONEY4);
    poRow('Blended Cost per Case', poRefs.blendedPerCase,
      poData.totalCasesAll > 0 ? poData.netSubtotalAll / poData.totalCasesAll : 0, MONEY);
    poRow('Vendors', null, Object.keys(poRefs.vendors).length, INT);
    poRow('Ingredients', null, poData.masterList.length, INT);
    r += 1;

    // ── VENDOR BREAKDOWN ──
    band(ws, r, 5, 'VENDOR BREAKDOWN', C.teal); r += 1;
    tableHeader(ws, r, ['Vendor', 'Net Total', '# Items', '', '']); r += 1;
    Object.entries(poRefs.vendors).forEach(([vendor, vref]) => {
      const items = poData.byVendor[vendor];
      const vNet = items.reduce((s, m) => s + m.netLineTotal, 0);
      const zebra = (r % 2 === 0) ? C.zebra : null;
      put(ws, `A${r}`, vendor, { color: C.ink, bg: zebra, border: true });
      putF(ws, `B${r}`, vref.net, vNet, { color: C.ink, bg: zebra, align: 'right', numFmt: MONEY, border: true });
      put(ws, `C${r}`, vref.count, { color: C.ink, bg: zebra, align: 'right', numFmt: INT, border: true });
      ['D', 'E'].forEach((c) => put(ws, `${c}${r}`, '', { bg: zebra, border: true }));
      r += 1;
    });
  }

  ws.views = [{ state: 'frozen', ySplit: 5 }];
}

function buildLineItemsSheet(ws, res, run) {
  ws.columns = LINE_ITEMS_COLUMNS;
  const { refs } = writeRunBlock({ ws, startRow: 1, label: 'RUN', run, res, color: C.teal });
  return refs;
}

// Packaging plan tab — one row per pack group with type, packSize, packsCount,
// carrier, SKU mix, cans consumed, cases. Includes a per-SKU allocation
// summary so the variety-mix math is auditable in the spreadsheet.
function buildPackagingPlanSheet(ws, res) {
  ws.columns = [
    { width: 4 }, { width: 24 }, { width: 12 }, { width: 12 }, { width: 12 },
    { width: 14 }, { width: 12 }, { width: 12 }, { width: 38 },
  ];
  const plan = res.planDerived;
  const flavorById = {};
  (res.baseCounts?.flavorRows || []).forEach((f) => { flavorById[f.id] = f; });

  let r = 1;
  band(ws, r, 9, 'PACKAGING PLAN', C.dark, C.white, 16, 28); r += 1;
  ws.mergeCells(`A${r}:I${r}`);
  put(ws, `A${r}`,
    plan.active
      ? `${plan.totalPacks.toLocaleString()} packs across ${plan.groups.length} group(s) · ${plan.totalCases.toLocaleString()} cases · ${plan.totalVarietyPacks.toLocaleString()} variety packs`
      : 'No packaging plan configured — using the run-level single pack size.',
    { color: C.muted, size: 10 });
  r += 2;

  // Per-SKU allocation summary
  band(ws, r, 9, 'PER-SKU ALLOCATION', C.teal); r += 1;
  tableHeader(ws, r, ['', 'SKU', 'Produced', 'Allocated', 'Remaining', '', '', '', '']); r += 1;
  (res.baseCounts?.flavorRows || []).forEach((f) => {
    const allocated = plan.cansAllocatedPerSku?.[f.id] || 0;
    const remaining = (f.cans || 0) - allocated;
    const zebra = (r % 2 === 0) ? C.zebra : null;
    put(ws, `A${r}`, '', { bg: zebra, border: true });
    put(ws, `B${r}`, f.name || '(unnamed)', { color: C.ink, bg: zebra, border: true });
    put(ws, `C${r}`, f.cans || 0, { color: C.ink, bg: zebra, align: 'right', numFmt: INT, border: true });
    put(ws, `D${r}`, allocated, { color: C.ink, bg: zebra, align: 'right', numFmt: INT, border: true });
    put(ws, `E${r}`, remaining, {
      color: remaining < 0 ? 'FFB91C1C' : C.ink, bold: remaining !== 0,
      bg: zebra, align: 'right', numFmt: INT, border: true,
    });
    ['F', 'G', 'H', 'I'].forEach((c) => put(ws, `${c}${r}`, '', { bg: zebra, border: true }));
    r += 1;
  });
  r += 1;

  // Pack groups
  band(ws, r, 9, 'PACK GROUPS', C.teal); r += 1;
  tableHeader(ws, r, ['#', 'Label', 'Type', 'Pack size', 'Packs', 'Cans', 'Cases', 'Carrier', 'SKU / Mix']); r += 1;
  if (plan.groups.length === 0) {
    ws.mergeCells(`A${r}:I${r}`);
    put(ws, `A${r}`, 'No pack groups configured.', { color: C.muted, align: 'center', border: true });
    r += 1;
  } else {
    plan.groups.forEach((g, idx) => {
      const zebra = (r % 2 === 0) ? C.zebra : null;
      const mixText = g.type === 'straight'
        ? (flavorById[g.skuId]?.name || g.skuId || '—')
        : (g.mix || [])
            .filter((m) => (m.cans || 0) > 0)
            .map((m) => `${flavorById[m.skuId]?.name || m.skuId}: ${m.cans}`)
            .join(', ') || '—';
      put(ws, `A${r}`, idx + 1, { color: C.muted, bg: zebra, align: 'right', border: true });
      put(ws, `B${r}`, g.label || (g.type === 'variety' ? `Variety ${g.packSize}-pk` : `${flavorById[g.skuId]?.name || 'Straight'} ${g.packSize}-pk`), { color: C.ink, bg: zebra, border: true });
      put(ws, `C${r}`, g.type === 'variety' ? 'Variety' : 'Straight', { color: C.ink, bg: zebra, border: true });
      put(ws, `D${r}`, g.packSize, { color: C.ink, bg: zebra, align: 'right', numFmt: INT, border: true });
      put(ws, `E${r}`, g.packsCount || 0, { color: C.ink, bg: zebra, align: 'right', numFmt: INT, border: true });
      put(ws, `F${r}`, g.cansConsumed || 0, { color: C.ink, bg: zebra, align: 'right', numFmt: INT, border: true });
      put(ws, `G${r}`, Math.ceil(g.casesConsumed || 0), { color: C.ink, bg: zebra, align: 'right', numFmt: INT, border: true });
      put(ws, `H${r}`, g.carrierType || 'paktech', { color: C.ink, bg: zebra, border: true });
      put(ws, `I${r}`, mixText, { color: C.muted, bg: zebra, border: true });
      r += 1;
    });

    // Totals
    put(ws, `A${r}`, '', { bold: true, color: C.white, bg: C.dark, border: true });
    put(ws, `B${r}`, 'TOTAL', { bold: true, color: C.white, bg: C.dark, border: true });
    put(ws, `C${r}`, '', { bold: true, color: C.white, bg: C.dark, border: true });
    put(ws, `D${r}`, '', { bold: true, color: C.white, bg: C.dark, border: true });
    put(ws, `E${r}`, plan.totalPacks, { bold: true, color: C.white, bg: C.dark, align: 'right', numFmt: INT, border: true });
    put(ws, `F${r}`, plan.totalCansAllocated, { bold: true, color: C.white, bg: C.dark, align: 'right', numFmt: INT, border: true });
    put(ws, `G${r}`, plan.totalCases, { bold: true, color: C.white, bg: C.dark, align: 'right', numFmt: INT, border: true });
    put(ws, `H${r}`, '', { bold: true, color: C.white, bg: C.dark, border: true });
    put(ws, `I${r}`, '', { bold: true, color: C.white, bg: C.dark, border: true });
    r += 2;
  }

  // Carrier totals
  band(ws, r, 9, 'CARRIER TOTALS', C.teal); r += 1;
  tableHeader(ws, r, ['', 'Metric', 'Packs', '', '', '', '', '', '']); r += 1;
  const carrierRows = [
    ['PakTech packs', plan.totalPaktechPacks || 0],
    ['Carton packs', plan.totalCartonPacks || 0],
    ['Variety packs', plan.totalVarietyPacks || 0],
    ['Straight packs', plan.totalStraightPacks || 0],
  ];
  carrierRows.forEach(([label, val]) => {
    const zebra = (r % 2 === 0) ? C.zebra : null;
    put(ws, `A${r}`, '', { bg: zebra, border: true });
    put(ws, `B${r}`, label, { color: C.ink, bg: zebra, border: true });
    put(ws, `C${r}`, val, { color: C.ink, bg: zebra, align: 'right', numFmt: INT, border: true });
    ['D', 'E', 'F', 'G', 'H', 'I'].forEach((c) => put(ws, `${c}${r}`, '', { bg: zebra, border: true }));
    r += 1;
  });

  ws.views = [{ state: 'frozen', ySplit: 4 }];
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

  // Packaging plan tab — always include so a run with no plan still has the
  // sheet (it shows "not configured"). Helps QA the math against the plan.
  const wsPlan = wb.addWorksheet('Packaging Plan', { properties: { tabColor: { argb: C.amber } } });
  buildPackagingPlanSheet(wsPlan, res);

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
