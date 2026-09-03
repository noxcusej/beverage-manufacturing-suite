// Excel export for a Consolidated Purchase Order pooled across multiple runs.
// Reuses the run-agnostic prepareRawPOData rollup and presents its GROSS
// figures (full MOQ-rounded demand at flat per-unit price, on-hand ignored),
// matching the on-screen Purchasing page.

import {
  C, MONEY, MONEY4, INT, DEC, put, putF, band, tableHeader,
  loadExcelJS, downloadWorkbook,
} from './excelStyle';
import { prepareRawPOData } from './runWorkbookRawPO';

function writeRunsSheet(ws, runs) {
  ws.columns = [{ width: 34 }, { width: 22 }, { width: 12 }, { width: 10 }];
  band(ws, 1, 4, 'Runs Included in this PO', C.dark, C.white, 14, 24);
  tableHeader(ws, 3, ['Run', 'Client', 'Cases', 'SKUs'], ['left', 'left', 'right', 'right']);
  let r = 4;
  (runs || []).forEach((run) => {
    const flavors = (run.flavors || []).filter((f) => f.formulaId && (f.cases || 0) > 0);
    const cases = flavors.reduce((s, f) => s + (f.cases || 0), 0);
    const zebra = (r % 2 === 0) ? C.zebra : null;
    put(ws, `A${r}`, run.name || '(unnamed run)', { color: C.ink, bg: zebra, border: true });
    put(ws, `B${r}`, run.client || '', { color: C.ink, bg: zebra, border: true });
    put(ws, `C${r}`, cases, { color: C.ink, bg: zebra, align: 'right', numFmt: INT, border: true });
    put(ws, `D${r}`, flavors.length, { color: C.ink, bg: zebra, align: 'right', numFmt: INT, border: true });
    r += 1;
  });
  ws.views = [{ state: 'frozen', ySplit: 3 }];
}

function writePOSheet(ws, data) {
  ws.columns = [
    { width: 30 }, { width: 16 }, { width: 14 }, { width: 8 },
    { width: 12 }, { width: 12 }, { width: 12 }, { width: 14 },
  ];
  band(ws, 1, 8, 'Consolidated Purchase Order  ·  gross demand, flat pricing', C.dark, C.white, 14, 26);
  ws.mergeCells('A2:H2');
  put(ws, 'A2', 'Ingredient demand pooled across all selected runs. Order Qty is the combined demand rounded up to each ingredient’s MOQ.', { color: C.muted, size: 10 });
  ws.getRow(2).height = 16;
  let r = 4;

  const cols = ['Ingredient', 'SKU', 'Total Demand', 'Unit', 'MOQ', 'Order Qty', 'Price', 'Line Total'];
  const aligns = ['left', 'left', 'right', 'left', 'right', 'right', 'right', 'right'];

  const byVendor = data?.byVendor || {};
  const vendorSubtotalRows = [];
  Object.keys(byVendor).sort().forEach((vendor) => {
    const items = byVendor[vendor];
    band(ws, r, 8, vendor, C.headerBg, C.ink, 11, 18); r += 1;
    tableHeader(ws, r, cols, aligns); r += 1;
    const vStart = r;
    items.forEach((m) => {
      const zebra = (r % 2 === 0) ? C.zebra : null;
      put(ws, `A${r}`, m.name, { color: C.ink, bg: zebra, border: true });
      put(ws, `B${r}`, m.sku || '', { color: C.ink, bg: zebra, border: true });
      put(ws, `C${r}`, m.totalDemand, { color: C.ink, bg: zebra, align: 'right', numFmt: DEC, border: true });
      put(ws, `D${r}`, m.buyUnit, { color: C.ink, bg: zebra, align: 'right', border: true });
      put(ws, `E${r}`, m.moq, { color: C.ink, bg: zebra, align: 'right', numFmt: DEC, border: true });
      put(ws, `F${r}`, m.grossOrderQty, { color: C.ink, bg: zebra, align: 'right', numFmt: DEC, border: true });
      put(ws, `G${r}`, m.pricePerBuyUnit, { color: m.pricePerBuyUnit > 0 ? C.ink : C.red, bg: zebra, align: 'right', numFmt: MONEY4, border: true });
      putF(ws, `H${r}`, `F${r}*G${r}`, m.grossLineTotal, { color: C.ink, bg: zebra, align: 'right', numFmt: MONEY, border: true });
      r += 1;
    });
    const vEnd = r - 1;
    put(ws, `A${r}`, 'Subtotal', { bold: true, color: C.ink, border: true });
    ['B', 'C', 'D', 'E', 'F', 'G'].forEach((c) => put(ws, `${c}${r}`, '', { border: true }));
    putF(ws, `H${r}`, `SUM(H${vStart}:H${vEnd})`, items.reduce((s, m) => s + m.grossLineTotal, 0),
      { bold: true, color: C.ink, align: 'right', numFmt: MONEY, border: true });
    vendorSubtotalRows.push(`H${r}`);
    r += 2;
  });

  band(ws, r, 7, 'GRAND TOTAL (ingredients ordered)', C.teal);
  putF(ws, `H${r}`, vendorSubtotalRows.length ? `SUM(${vendorSubtotalRows.join(',')})` : '0',
    data?.grossSubtotalAll || 0, { bold: true, color: C.white, bg: C.teal, align: 'right', numFmt: MONEY, border: true });
  ws.views = [{ state: 'frozen', ySplit: 3 }];
}

export async function exportConsolidatedPO({ runs, selectedFormulas, inventoryMap, caseCounts, poData } = {}) {
  const data = poData || prepareRawPOData({ selectedFormulas, inventoryMap, caseCounts });
  if (!data) throw new Error('Nothing to order — the selected runs have no formulas with ingredients.');

  const ExcelJS = await loadExcelJS();
  const wb = new ExcelJS.Workbook();
  wb.creator = 'Beverage Manufacturing Suite';
  wb.created = new Date();
  wb.calcProperties = { fullCalcOnLoad: true };

  writeRunsSheet(wb.addWorksheet('Runs Included', { properties: { tabColor: { argb: C.teal } } }), runs);
  writePOSheet(wb.addWorksheet('Consolidated PO', { properties: { tabColor: { argb: C.amber } } }), data);

  // Match the app's other exports: hide gridlines without clobbering frozen panes.
  wb.eachSheet((ws) => {
    const v = ws.views && ws.views[0] ? ws.views[0] : {};
    ws.views = [{ ...v, showGridLines: false }];
  });

  await downloadWorkbook(wb, 'consolidated_po');
}
