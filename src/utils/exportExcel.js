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

// ─────────────────────────────────────────────────────────────────────────
// COST SHEET — mirrors the in-app Summary page.
//
//   KEY METRICS (vertical strip, references Line Items where possible)
//   COST BREAKDOWN BY SKU (flavors as columns, categories as rows,
//                          Cost/Unit and Cost/Case footer rows)
//   CHANNEL PRICING (COGS → FOB → Distributor → MSRP at per-case /
//                    per-pack / per-unit basis, with editable margin %
//                    cells that drive every other row via formula)
// ─────────────────────────────────────────────────────────────────────────
function buildCostSheetSheet(ws, res, run, runRefs) {
  const flavors = (run.flavors || []);
  // Resolve effective per-flavor counts from the saved run.
  const config = res.config || {};
  const unitsPerCase = config.unitsPerCase || 24;
  const packSize = config.packSize || 4;
  const casesPerPallet = config.casesPerPallet || 80;
  const totalCans = res.counts.totalUnits || 0;

  const flavorRows = (res.counts.flavorRows || []).map((fr) => {
    const original = flavors.find((f) => f.id === fr.id) || {};
    return {
      id: fr.id,
      name: original.name || fr.name || 'Unnamed',
      cases: fr.cases || 0,
      cans: fr.cans || 0,
      ingredientCost: Number(original.ingredientCost || 0),
      batchingFee: Number(original.batchingFee || 0),
    };
  });
  const flavorCount = flavorRows.length;

  // Categories shown in the matrix (same canonical list as the breakdown,
  // skipping any with zero cost). Maps category label to runRefs.cat key
  // for formula references.
  const labelToKey = {
    'Packaging Materials': 'packaging',
    'Ingredients (optimized PO)': 'ingredients',
    'Tolling': 'tolling',
    'Freight & Other': 'bom',
    'Batching Fees': 'batching',
    'Taxes & Regulatory': 'taxes',
  };
  const matrixRows = (res.breakdown || [])
    .filter((row) => (row.cost || 0) !== 0)
    .map((row) => ({
      label: row.label,
      total: row.cost || 0,
      key: labelToKey[row.label] || null,
    }));

  // Column layout: A=label, B..=per-flavor, then Run Total
  const baseWidths = [{ width: 32 }];
  for (let i = 0; i < flavorCount; i += 1) baseWidths.push({ width: 16 });
  baseWidths.push({ width: 16 }); // Run Total column
  ws.columns = baseWidths;

  const colLetter = (n) => {
    // 0-indexed → A, B, ... AA, AB
    let s = '';
    let x = n;
    while (x >= 0) {
      s = String.fromCharCode(65 + (x % 26)) + s;
      x = Math.floor(x / 26) - 1;
    }
    return s;
  };
  const lastCol = colLetter(flavorCount + 1); // includes Run Total
  const totalColIdx = flavorCount + 1;
  const totalColLetter = colLetter(totalColIdx);

  let r = 1;

  // ── HEADER ──
  band(ws, r, totalColIdx + 1, run.name || 'Cost Sheet', C.dark, C.white, 18, 30); r += 1;
  ws.mergeCells(`A${r}:${lastCol}${r}`);
  put(ws, `A${r}`,
    `Cost Sheet  ·  Generated ${new Date().toLocaleDateString()}  ·  cost cells link to the ${SHEET_LINE_ITEMS} tab where possible`,
    { color: C.muted, size: 10 });
  ws.getRow(r).height = 16;
  r += 2;

  // ── KEY METRICS — vertical strip mirrors the 6-card in-app KPI row ──
  band(ws, r, totalColIdx + 1, 'KEY METRICS', C.teal); r += 1;
  tableHeader(ws, r, ['Metric', 'Value', ...Array(flavorCount).fill('')]); r += 1;

  const metric = (label, ref, fallbackValue, fmt, bold = false, subtitle = null) => {
    const zebra = (r % 2 === 0) ? C.zebra : null;
    put(ws, `A${r}`, label + (subtitle ? `  (${subtitle})` : ''), { bold, color: C.ink, bg: zebra, border: true });
    if (typeof ref === 'string') {
      putF(ws, `B${r}`, ref, fallbackValue, { bold, color: C.ink, bg: zebra, align: 'right', numFmt: fmt, border: true });
    } else {
      put(ws, `B${r}`, fallbackValue, { bold, color: C.ink, bg: zebra, align: 'right', numFmt: fmt, border: true });
    }
    for (let i = 2; i <= totalColIdx; i += 1) {
      put(ws, `${colLetter(i)}${r}`, '', { bg: zebra, border: true });
    }
    r += 1;
  };

  metric('Total Cost', runRefs.total, res.costs.totalCost, MONEY, true);
  metric('All-in / Can', runRefs.perCan, res.costs.costPerUnit, MONEY4);
  // Blended Raw Mat / Can — totalIngredientCost / totalUnits, referencing
  // the Ingredients subtotal cell and the totalCans cell on Line Items.
  const ingRef = runRefs.cat.ingredients;
  const cansRef = runRefs.cans;
  const blendedPerCan = totalCans > 0 ? (res.costs.totalIngredientCost || 0) / totalCans : 0;
  metric('Raw Mat / Can', `IF(${cansRef}>0,${ingRef}/${cansRef},0)`,
    blendedPerCan, MONEY4, false, 'blended PO');
  metric('Per Case', runRefs.perCase, res.costs.costPerCase, MONEY);
  // Per-pack and Per-full-pallet are simple multiples of unit cost.
  metric('Per Pack', `${runRefs.perCan}*${packSize}`,
    (res.costs.costPerUnit || 0) * packSize, MONEY, false, `${packSize}-pack`);
  metric('Per Full Pallet', `${runRefs.perCase}*${casesPerPallet}`,
    (res.costs.costPerCase || 0) * casesPerPallet, MONEY, false, `${casesPerPallet} cases`);
  r += 1;

  // ── COST BREAKDOWN BY SKU — matrix ──
  band(ws, r, totalColIdx + 1, 'COST BREAKDOWN BY SKU', C.teal); r += 1;
  ws.mergeCells(`A${r}:${lastCol}${r}`);
  put(ws, `A${r}`,
    'Ingredients are per-SKU (allocated from consolidated PO, captures bulk pricing). Shared categories allocated pro-rata by can share.',
    { color: C.muted, size: 9, italic: true });
  ws.getRow(r).height = 16;
  r += 1;
  const matrixHeader = ['Cost Component'];
  flavorRows.forEach((f) => matrixHeader.push(`${f.name}\n${f.cases} cs / ${f.cans} cn`));
  matrixHeader.push('Run Total');
  tableHeader(ws, r, matrixHeader); r += 1;

  // Each row: per-flavor cells, then Run Total.
  // Per-flavor allocation: ingredients = ingredientCost × cans; batching =
  // batchingFee; everything else = (flavor.cans / totalCans) × categoryTotal.
  const allocateProRata = (totalCost) => flavorRows.map((f) => (totalCans > 0 ? (f.cans / totalCans) * totalCost : 0));

  matrixRows.forEach((mr) => {
    const zebra = (r % 2 === 0) ? C.zebra : null;
    let perFlavor;
    if (mr.label.startsWith('Ingredients')) {
      perFlavor = flavorRows.map((f) => f.ingredientCost * f.cans);
    } else if (mr.label.startsWith('Batching')) {
      perFlavor = flavorRows.map((f) => f.batchingFee);
    } else {
      perFlavor = allocateProRata(mr.total);
    }
    put(ws, `A${r}`, mr.label, { bold: true, color: C.ink, bg: zebra, border: true });
    flavorRows.forEach((_, i) => {
      put(ws, `${colLetter(i + 1)}${r}`, perFlavor[i], {
        color: C.ink, bg: zebra, align: 'right', numFmt: MONEY, border: true,
      });
    });
    // Run Total — reference the canonical subtotal cell from Line Items
    // when we have one. Otherwise sum the row's per-flavor cells.
    const ref = mr.key ? runRefs.cat[mr.key] : null;
    if (ref) {
      putF(ws, `${totalColLetter}${r}`, ref, mr.total, {
        bold: true, color: C.ink, bg: zebra, align: 'right', numFmt: MONEY, border: true,
      });
    } else {
      put(ws, `${totalColLetter}${r}`, mr.total, {
        bold: true, color: C.ink, bg: zebra, align: 'right', numFmt: MONEY, border: true,
      });
    }
    r += 1;
  });

  // Total row
  const totalRowR = r;
  put(ws, `A${r}`, 'TOTAL', { bold: true, color: C.white, bg: C.dark, border: true });
  flavorRows.forEach((_, i) => {
    const col = colLetter(i + 1);
    // Sum the per-flavor cells in this column across all matrix rows.
    const colStart = totalRowR - matrixRows.length;
    const colEnd = totalRowR - 1;
    putF(ws, `${col}${r}`, `SUM(${col}${colStart}:${col}${colEnd})`,
      matrixRows.reduce((s, mr) => {
        if (mr.label.startsWith('Ingredients')) return s + flavorRows[i].ingredientCost * flavorRows[i].cans;
        if (mr.label.startsWith('Batching')) return s + flavorRows[i].batchingFee;
        return s + (totalCans > 0 ? (flavorRows[i].cans / totalCans) * mr.total : 0);
      }, 0),
      { bold: true, color: C.white, bg: C.dark, align: 'right', numFmt: MONEY, border: true });
  });
  // Run total — reference the line-items run total directly.
  putF(ws, `${totalColLetter}${r}`, runRefs.total, res.costs.totalCost,
    { bold: true, color: C.white, bg: C.dark, align: 'right', numFmt: MONEY, border: true });
  r += 1;

  // Cost / Unit row
  put(ws, `A${r}`, 'Cost / Unit', { bold: true, color: C.muted, border: true });
  flavorRows.forEach((f, i) => {
    const col = colLetter(i + 1);
    putF(ws, `${col}${r}`, `IF(${f.cans}>0,${col}${totalRowR}/${f.cans},0)`,
      f.cans > 0 ? (matrixRows.reduce((s, mr) => {
        if (mr.label.startsWith('Ingredients')) return s + f.ingredientCost * f.cans;
        if (mr.label.startsWith('Batching')) return s + f.batchingFee;
        return s + (totalCans > 0 ? (f.cans / totalCans) * mr.total : 0);
      }, 0)) / f.cans : 0,
      { color: C.muted, align: 'right', numFmt: MONEY4, border: true });
  });
  putF(ws, `${totalColLetter}${r}`, runRefs.perCan, res.costs.costPerUnit,
    { bold: true, color: C.ink, align: 'right', numFmt: MONEY4, border: true });
  r += 1;

  // Cost / Case row
  put(ws, `A${r}`, 'Cost / Case', { bold: true, color: C.muted, border: true });
  flavorRows.forEach((f, i) => {
    const col = colLetter(i + 1);
    putF(ws, `${col}${r}`, `IF(${f.cases}>0,${col}${totalRowR}/${f.cases},0)`,
      f.cases > 0 ? (matrixRows.reduce((s, mr) => {
        if (mr.label.startsWith('Ingredients')) return s + f.ingredientCost * f.cans;
        if (mr.label.startsWith('Batching')) return s + f.batchingFee;
        return s + (totalCans > 0 ? (f.cans / totalCans) * mr.total : 0);
      }, 0)) / f.cases : 0,
      { color: C.muted, align: 'right', numFmt: MONEY, border: true });
  });
  putF(ws, `${totalColLetter}${r}`, runRefs.perCase, res.costs.costPerCase,
    { bold: true, color: C.ink, align: 'right', numFmt: MONEY, border: true });
  r += 2;

  // ── CHANNEL PRICING — formula-driven, margin inputs at the top ──
  band(ws, r, totalColIdx + 1, 'CHANNEL PRICING', C.teal); r += 1;

  // Margin inputs row — user-editable cells.
  put(ws, `A${r}`, 'Distributor Margin', { bold: true, color: C.ink, border: true });
  put(ws, `B${r}`, 0.30, { bold: true, color: C.ink, bg: '#FFF8E1', align: 'right', numFmt: '0.0%', border: true });
  const distMarginCell = `B${r}`;
  for (let i = 2; i <= totalColIdx; i += 1) put(ws, `${colLetter(i)}${r}`, '', { border: true });
  r += 1;

  put(ws, `A${r}`, 'Retail Margin', { bold: true, color: C.ink, border: true });
  put(ws, `B${r}`, 0.40, { bold: true, color: C.ink, bg: '#FFF8E1', align: 'right', numFmt: '0.0%', border: true });
  const retailMarginCell = `B${r}`;
  for (let i = 2; i <= totalColIdx; i += 1) put(ws, `${colLetter(i)}${r}`, '', { border: true });
  r += 1;

  put(ws, `A${r}`, 'FOB Price / Case', { bold: true, color: C.ink, border: true });
  // Default FOB = COGS per case (user can override the cell). Formula
  // references the COGS per-case cell directly so editing COGS upstream
  // flows through unless the user types a literal value here.
  putF(ws, `B${r}`, runRefs.perCase, res.costs.costPerCase,
    { bold: true, color: C.ink, bg: '#FFF8E1', align: 'right', numFmt: MONEY, border: true });
  const fobCell = `B${r}`;
  for (let i = 2; i <= totalColIdx; i += 1) put(ws, `${colLetter(i)}${r}`, '', { border: true });
  r += 2;

  // Pricing table
  tableHeader(ws, r, ['Level', 'Per Case', 'Per Pack', 'Per Unit', ...Array(Math.max(0, totalColIdx - 3)).fill('')]);
  r += 1;

  const upc = unitsPerCase;
  const psz = packSize;
  const perCaseRef = runRefs.perCase;
  const perCanRef = runRefs.perCan;

  // COGS row
  {
    const zebra = (r % 2 === 0) ? C.zebra : null;
    put(ws, `A${r}`, 'COGS', { bold: true, color: C.ink, bg: zebra, border: true });
    putF(ws, `B${r}`, perCaseRef, res.costs.costPerCase, { color: C.ink, bg: zebra, align: 'right', numFmt: MONEY, border: true });
    putF(ws, `C${r}`, `${perCanRef}*${psz}`, (res.costs.costPerUnit || 0) * psz, { color: C.ink, bg: zebra, align: 'right', numFmt: MONEY, border: true });
    putF(ws, `D${r}`, perCanRef, res.costs.costPerUnit, { color: C.ink, bg: zebra, align: 'right', numFmt: MONEY4, border: true });
    for (let i = 4; i <= totalColIdx; i += 1) put(ws, `${colLetter(i)}${r}`, '', { bg: zebra, border: true });
    r += 1;
  }

  // FOB to Distributor row
  {
    const zebra = (r % 2 === 0) ? C.zebra : null;
    put(ws, `A${r}`, 'FOB to Distributor', { bold: true, color: C.ink, bg: zebra, border: true });
    putF(ws, `B${r}`, fobCell, res.costs.costPerCase, { bold: true, color: C.teal, bg: zebra, align: 'right', numFmt: MONEY, border: true });
    putF(ws, `C${r}`, `${fobCell}/${upc}*${psz}`, (res.costs.costPerCase || 0) / upc * psz, { color: C.ink, bg: zebra, align: 'right', numFmt: MONEY, border: true });
    putF(ws, `D${r}`, `${fobCell}/${upc}`, (res.costs.costPerCase || 0) / upc, { color: C.ink, bg: zebra, align: 'right', numFmt: MONEY4, border: true });
    for (let i = 4; i <= totalColIdx; i += 1) put(ws, `${colLetter(i)}${r}`, '', { bg: zebra, border: true });
    r += 1;
  }

  // Distributor to Retail row
  const distCaseRow = r;
  {
    const zebra = (r % 2 === 0) ? C.zebra : null;
    put(ws, `A${r}`, 'Distributor to Retail', { bold: true, color: C.ink, bg: zebra, border: true });
    // distPrice = fob / (1 - distMargin)
    putF(ws, `B${r}`, `${fobCell}/(1-${distMarginCell})`, (res.costs.costPerCase || 0) / 0.7,
      { color: C.ink, bg: zebra, align: 'right', numFmt: MONEY, border: true });
    putF(ws, `C${r}`, `B${r}/${upc}*${psz}`, ((res.costs.costPerCase || 0) / 0.7) / upc * psz,
      { color: C.ink, bg: zebra, align: 'right', numFmt: MONEY, border: true });
    putF(ws, `D${r}`, `B${r}/${upc}`, ((res.costs.costPerCase || 0) / 0.7) / upc,
      { color: C.ink, bg: zebra, align: 'right', numFmt: MONEY4, border: true });
    for (let i = 4; i <= totalColIdx; i += 1) put(ws, `${colLetter(i)}${r}`, '', { bg: zebra, border: true });
    r += 1;
  }

  // Retail MSRP row
  {
    put(ws, `A${r}`, 'Retail MSRP', { bold: true, color: C.white, bg: C.dark, border: true });
    putF(ws, `B${r}`, `B${distCaseRow}/(1-${retailMarginCell})`, ((res.costs.costPerCase || 0) / 0.7) / 0.6,
      { bold: true, color: C.white, bg: C.dark, align: 'right', numFmt: MONEY, border: true });
    putF(ws, `C${r}`, `B${r}/${upc}*${psz}`, (((res.costs.costPerCase || 0) / 0.7) / 0.6) / upc * psz,
      { bold: true, color: C.white, bg: C.dark, align: 'right', numFmt: MONEY, border: true });
    putF(ws, `D${r}`, `B${r}/${upc}`, (((res.costs.costPerCase || 0) / 0.7) / 0.6) / upc,
      { bold: true, color: C.white, bg: C.dark, align: 'right', numFmt: MONEY4, border: true });
    for (let i = 4; i <= totalColIdx; i += 1) put(ws, `${colLetter(i)}${r}`, '', { bg: C.dark, border: true });
    r += 1;
  }
  r += 1;

  // Margin caption
  ws.mergeCells(`A${r}:${lastCol}${r}`);
  put(ws, `A${r}`,
    'Margin = (price − cost) / price. Edit the yellow cells (Distributor Margin, Retail Margin, FOB Price) to recalculate channel pricing.',
    { color: C.muted, size: 9, italic: true });
  ws.getRow(r).height = 16;

  ws.views = [{ state: 'frozen', ySplit: 4 }];
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

  const wsCostSheet = wb.addWorksheet('Cost Sheet', { properties: { tabColor: { argb: C.teal } } });
  const wsSummary = wb.addWorksheet('Summary', { properties: { tabColor: { argb: C.teal } } });
  const wsLines = wb.addWorksheet(SHEET_LINE_ITEMS, { properties: { tabColor: { argb: C.purple } } });

  // Build line items first so the Cost Sheet and Summary can reference its cells.
  const runRefs = buildLineItemsSheet(wsLines, res, run);

  // Cost Sheet — mirrors the in-app Summary page (KPI strip, per-SKU
  // cost matrix, Channel Pricing with editable margin %).
  buildCostSheetSheet(wsCostSheet, res, run, runRefs);

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

  // Turn off gridlines on every sheet. Merges into any existing views
  // entry (frozen panes etc.) so we don't clobber them.
  wb.eachSheet((ws) => {
    if (ws.views && ws.views.length > 0) {
      ws.views = ws.views.map((v) => ({ ...v, showGridLines: false }));
    } else {
      ws.views = [{ showGridLines: false }];
    }
  });

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

// Returns one of:
//   { mode: 'oauth', url }      — workbook uploaded to Drive + converted
//                                  to a Google Sheet. Caller decides how
//                                  to open the URL (window.open may be
//                                  blocked post-OAuth; surface a
//                                  click-to-open banner as a fallback).
//   { mode: 'fallback' }        — no OAuth client configured. Caller
//                                  should pre-open sheets.new in the
//                                  click handler AND show the import
//                                  hint after the .xlsx download.
//
// Window-management is INTENTIONALLY left to the caller. The OAuth popup
// must claim the user-gesture activation (calling window.open beforehand
// burns it and the popup gets blocked).
export async function exportCoPackingToGoogleSheets({ run, rawPO } = {}) {
  const { getGoogleClientId, uploadXlsxToSheets } = await import('./googleSheets');
  const clientId = getGoogleClientId();

  if (!clientId) {
    const wb = await buildWorkbook({ run, rawPO });
    await downloadWorkbook(wb, workbookName(run));
    return { mode: 'fallback' };
  }

  const wb = await buildWorkbook({ run, rawPO });
  const buffer = await wb.xlsx.writeBuffer();
  const blob = new Blob([buffer], {
    type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  });
  const { url } = await uploadXlsxToSheets({
    blob,
    filename: workbookName(run),
    clientId,
  });
  return { mode: 'oauth', url };
}
