// Treasury Cockpit → Excel export.
// Builds a multi-sheet, formatted workbook from the cockpit's cash model:
//   1. Summary          — key figures (opening, floor, ending, trough, totals)
//   2. Weekly Cash Flow — the full weekly matrix with live SUM / running-balance
//                         formulas and below-floor closings flagged red
//   3. Runs & Events    — each run's cash events, grouped, with the week each lands
//   4. Accounts Payable — bills (incl. Xero-imported), effective pay date, links
//   5. Fixed Costs      — recurring overhead with weekly-equivalent burn
//   6. Capital          — equity / debt with servicing
//
// Reuses the shared excelStyle helpers so it matches every other workbook the app
// produces. ExcelJS is lazy-loaded via loadExcelJS().
import {
  C, MONEY, INT, PERCENT, colLetter, put, putF, band, tableHeader, filename, loadExcelJS, downloadWorkbook,
} from './excelStyle';

const MON = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
const CASH = '$#,##0;($#,##0)';           // whole-dollar, negatives in parens
const CASH_RED = '$#,##0;[Red]($#,##0)';  // same, negatives in red (cash-flow body)
function addWeeks(d, n) { const x = new Date(d); x.setDate(x.getDate() + n * 7); return x; }
function longDate(d) { return MON[d.getMonth()] + ' ' + d.getDate() + ', ' + d.getFullYear(); }
function shortDate(d) { return (d.getMonth() + 1) + '/' + d.getDate(); }
const defaultInclude = (s) => s === 'AUTHORISED' || s === 'SUBMITTED';

function weeklyEquiv(it) {
  const a = Number(it.amount) || 0;
  switch (it.cadence) {
    case 'weekly': return a;
    case 'biweekly': return a / 2;
    case 'monthly': return (a * 12) / 52;
    case 'quarterly': return (a * 4) / 52;
    case 'annual': return a / 52;
    default: return 0;
  }
}

// ── Summary sheet ──
function buildSummary(ws, d) {
  const { openingCash, floor, calc, base, horizon } = d;
  ws.columns = [{ width: 28 }, { width: 20 }, { width: 22 }, { width: 20 }];
  band(ws, 1, 4, 'Treasury Cockpit — Cash Summary', C.dark, C.white, 14, 26);
  put(ws, 'A2', 'Generated ' + longDate(d.now) + ' · horizon ' + horizon + ' weeks', { italic: true, color: C.muted });

  const rows = [
    ['Opening cash', openingCash, CASH],
    ['Cash floor', floor, CASH],
    ['Ending position', calc.ending, CASH],
    ['Lowest position (trough)', calc.trough, CASH],
    ['Trough week', 'week of ' + longDate(addWeeks(base, calc.troughI)), null],
    ['Floor status', calc.trough < floor ? 'BREACHED' : 'OK', null],
  ];
  let r = 4;
  band(ws, r++, 4, 'Position', C.teal);
  rows.forEach(([label, val, fmt]) => {
    put(ws, 'A' + r, label, { bold: true, color: C.ink, border: true });
    const breach = label === 'Floor status' && val === 'BREACHED';
    put(ws, 'B' + r, val, { numFmt: fmt || undefined, align: fmt ? 'right' : 'left', border: true, color: breach ? C.red : (label.startsWith('Lowest') && calc.trough < floor ? C.red : C.ink), bold: breach });
    r++;
  });

  r++;
  band(ws, r++, 4, 'Totals over horizon', C.purple);
  const totals = [
    ['Run receipts (in)', calc.totalIn],
    ['Capital in', calc.totalCapIn],
    ['Run payments (out)', -calc.totalOut],
    ['Fixed costs (out)', -calc.totalFixed],
    ['Bills (out)', -calc.totalAP],
    ['Debt service (out)', -calc.totalCapSvc],
    ['Manual adjustment', (calc.adjW || []).reduce((t, v) => t + v, 0)],
  ];
  totals.forEach(([label, val]) => {
    put(ws, 'A' + r, label, { color: C.ink, border: true });
    put(ws, 'B' + r, val, { numFmt: CASH, align: 'right', border: true, color: val < 0 ? C.red : C.green });
    r++;
  });
  ws.views = [{ state: 'frozen', ySplit: 3 }];
}

// ── Weekly Cash Flow matrix ──
function buildCashFlow(ws, d) {
  const { calc, fixedW, apArr, capInW, capOutW, base, horizon, openingCash, floor } = d;
  // signed weekly series so Net = SUM(column) and the spreadsheet stays "live"
  const series = [
    { label: 'Receipts — runs', vals: calc.inW, sign: 1 },
    { label: 'Capital in', vals: capInW, sign: 1 },
    { label: 'Run payments', vals: calc.outW, sign: -1 },
    { label: 'Fixed costs', vals: fixedW, sign: -1 },
    { label: 'Bills', vals: apArr, sign: -1 },
    { label: 'Debt service', vals: capOutW, sign: -1 },
    { label: 'Manual adjustment', vals: calc.adjW || [], sign: 1 },
  ];
  band(ws, 1, horizon + 2, 'Weekly Cash Flow  ·  opening ' + Math.round(openingCash).toLocaleString('en-US', { style: 'currency', currency: 'USD', maximumFractionDigits: 0 }) + '  ·  floor ' + Math.round(floor).toLocaleString('en-US', { style: 'currency', currency: 'USD', maximumFractionDigits: 0 }), C.dark, C.white, 13, 24);

  const headRow = 3;
  put(ws, 'A' + headRow, 'Line', { bold: true, color: C.muted, bg: C.headerBg, border: true });
  for (let i = 0; i < horizon; i++) {
    put(ws, colLetter(i + 2) + headRow, shortDate(addWeeks(base, i)), { bold: true, color: C.muted, bg: C.headerBg, align: 'right', border: true });
  }
  put(ws, colLetter(horizon + 2) + headRow, 'Total', { bold: true, color: C.ink, bg: C.headerBg, align: 'right', border: true });

  // category rows (signed values + Total = SUM)
  let r = headRow + 1;
  const firstDataRow = r;
  series.forEach((s) => {
    put(ws, 'A' + r, s.label, { bold: true, color: C.ink, border: true });
    for (let i = 0; i < horizon; i++) {
      put(ws, colLetter(i + 2) + r, (s.vals[i] || 0) * s.sign, { numFmt: CASH_RED, align: 'right' });
    }
    const a = colLetter(2) + r, z = colLetter(horizon + 1) + r;
    putF(ws, colLetter(horizon + 2) + r, `SUM(${a}:${z})`, s.vals.reduce((t, v) => t + v, 0) * s.sign, { numFmt: CASH_RED, align: 'right', bold: true });
    r++;
  });
  const lastCatRow = r - 1;

  // Net change = SUM of the category cells in each column
  put(ws, 'A' + r, 'Net change', { bold: true, color: C.ink, bg: C.zebra, border: true });
  for (let i = 0; i < horizon; i++) {
    const col = colLetter(i + 2);
    putF(ws, col + r, `SUM(${col}${firstDataRow}:${col}${lastCatRow})`, calc.net[i] || 0, { numFmt: CASH_RED, align: 'right', bold: true, bg: C.zebra });
  }
  { const col = colLetter(horizon + 2); putF(ws, col + r, `SUM(${col}${firstDataRow}:${col}${lastCatRow})`, calc.net.reduce((t, v) => t + v, 0), { numFmt: CASH_RED, align: 'right', bold: true, bg: C.zebra }); }
  const netRow = r; r++;

  // Closing position = opening + running net (live formula), red below floor
  put(ws, 'A' + r, 'Closing position', { bold: true, color: C.ink, border: true });
  for (let i = 0; i < horizon; i++) {
    const col = colLetter(i + 2);
    const formula = i === 0 ? `${openingCash}+${col}${netRow}` : `${colLetter(i + 1)}${r}+${col}${netRow}`;
    const below = (calc.cum[i] || 0) < floor;
    putF(ws, col + r, formula, calc.cum[i] || 0, { numFmt: CASH, align: 'right', bold: true, color: below ? C.red : C.ink, bg: below ? 'FFFBE9E7' : undefined });
  }
  put(ws, colLetter(horizon + 2) + r, calc.ending, { numFmt: CASH, align: 'right', bold: true, color: calc.ending < floor ? C.red : C.ink });

  ws.getColumn(1).width = 18;
  for (let i = 0; i < horizon; i++) ws.getColumn(i + 2).width = 11;
  ws.getColumn(horizon + 2).width = 13;
  ws.views = [{ state: 'frozen', xSplit: 1, ySplit: headRow }];
}

// ── Runs & events ──
function buildRuns(ws, d) {
  const { projects, base, horizon, evWeek, calc } = d;
  ws.columns = [{ width: 26 }, { width: 14 }, { width: 8 }, { width: 16 }, { width: 8 }, { width: 14 }, { width: 14 }];
  band(ws, 1, 7, 'Runs & Cash Events', C.dark, C.white, 13, 24);
  let r = 3;
  (projects || []).forEach((p) => {
    const net = calc.perProject?.[p.id] ?? 0;
    band(ws, r++, 7, `${p.name}${p.client ? ' · ' + p.client : ''}${p.hidden ? '  (hidden — excluded)' : ''}   net ${Math.round(net).toLocaleString()}`, p.hidden ? C.muted : C.teal, C.white, 11, 20);
    tableHeader(ws, r++, ['Event', 'Direction', 'Amount', 'Anchor', 'Offset', 'Lands', ''], ['left', 'left', 'right', 'left', 'right', 'left', 'left']);
    (p.events || []).forEach((e) => {
      const w = evWeek(p, e);
      const inRange = w >= 0 && w < horizon;
      put(ws, 'A' + r, e.label, { border: true });
      put(ws, 'B' + r, e.dir === 'in' ? 'In' : 'Out', { border: true, color: e.dir === 'in' ? C.green : C.red });
      put(ws, 'C' + r, (e.dir === 'in' ? 1 : -1) * (Number(e.amount) || 0), { numFmt: CASH_RED, align: 'right', border: true });
      put(ws, 'D' + r, e.anchor, { border: true });
      put(ws, 'E' + r, Number(e.offset) || 0, { numFmt: INT, align: 'right', border: true });
      put(ws, 'F' + r, longDate(addWeeks(base, w)), { border: true, color: inRange ? C.ink : C.muted });
      put(ws, 'G' + r, inRange ? '' : 'off-horizon', { border: true, italic: true, color: C.muted });
      r++;
    });
    r++;
  });
  ws.views = [{ state: 'frozen', ySplit: 2 }];
}

// ── Accounts payable ──
function buildAP(ws, d) {
  const { ap, base, eventDateMap } = d;
  const today = new Date(d.now); today.setHours(0, 0, 0, 0);
  const payDate = (b) => {
    if (b.payDate) return b.payDate;
    if (b.eventId && eventDateMap && eventDateMap[b.eventId]) return eventDateMap[b.eventId];
    const due = new Date(b.dueDate);
    return (due < base ? base : due).toISOString().slice(0, 10);
  };
  ws.columns = [{ width: 26 }, { width: 14 }, { width: 12 }, { width: 12 }, { width: 13 }, { width: 14 }, { width: 12 }, { width: 9 }, { width: 10 }];
  band(ws, 1, 9, 'Accounts Payable', C.dark, C.white, 13, 24);
  const headRow = 3;
  tableHeader(ws, headRow, ['Vendor', 'Ref', 'Bill date', 'Due date', 'Status', 'Pay date', 'Amount', 'In cash?', 'Source'], ['left', 'left', 'left', 'left', 'left', 'left', 'right', 'left', 'left']);
  let r = headRow + 1;
  const rows = [...(ap || [])].sort((a, b) => new Date(payDate(a)) - new Date(payDate(b)));
  let total = 0;
  rows.forEach((b) => {
    const incl = b.include ?? defaultInclude(b.status);
    if (incl) total += Number(b.amount) || 0;
    const pd = payDate(b);
    const overdue = new Date(b.dueDate) < today;
    put(ws, 'A' + r, b.vendor, { border: true, color: incl ? C.ink : C.muted });
    put(ws, 'B' + r, b.ref || '', { border: true, color: C.muted });
    put(ws, 'C' + r, b.billDate || '', { border: true, color: C.muted });
    put(ws, 'D' + r, b.dueDate || '', { border: true, color: overdue ? C.red : C.ink });
    put(ws, 'E' + r, b.status || '', { border: true, color: C.muted });
    put(ws, 'F' + r, pd, { border: true });
    put(ws, 'G' + r, Number(b.amount) || 0, { numFmt: MONEY, align: 'right', border: true, color: incl ? C.ink : C.muted });
    put(ws, 'H' + r, incl ? 'yes' : 'no', { border: true, align: 'center', color: incl ? C.green : C.muted });
    put(ws, 'I' + r, b.xeroId ? 'Xero' : 'manual', { border: true, color: C.muted });
    r++;
  });
  put(ws, 'F' + r, 'Total (included)', { bold: true, align: 'right' });
  put(ws, 'G' + r, total, { numFmt: MONEY, align: 'right', bold: true, color: C.red });
  ws.views = [{ state: 'frozen', xSplit: 1, ySplit: headRow }];
}

// ── Fixed costs ──
function buildFixed(ws, d) {
  const { fixed } = d;
  ws.columns = [{ width: 26 }, { width: 16 }, { width: 12 }, { width: 13 }, { width: 10 }, { width: 11 }, { width: 11 }, { width: 12 }];
  band(ws, 1, 8, 'Fixed Costs', C.dark, C.white, 13, 24);
  const headRow = 3;
  tableHeader(ws, headRow, ['Cost', 'Category', 'Cadence', 'Amount', 'Day/Wk', 'From wk', 'Until wk', '≈ / week'], ['left', 'left', 'left', 'right', 'right', 'right', 'right', 'right']);
  let r = headRow + 1;
  let wk = 0;
  (fixed || []).forEach((it) => {
    const eq = it.cadence === 'one-time' ? 0 : weeklyEquiv(it);
    wk += eq;
    const timing = it.cadence === 'one-time' ? ('wk ' + (it.week ?? 0)) : it.cadence === 'biweekly' ? ('wk ' + (it.anchorWeek ?? 0)) : (it.cadence === 'weekly' ? '—' : ('day ' + (it.day ?? 1)));
    put(ws, 'A' + r, it.label, { border: true });
    put(ws, 'B' + r, it.cat || '', { border: true, color: C.muted });
    put(ws, 'C' + r, it.cadence, { border: true });
    put(ws, 'D' + r, Number(it.amount) || 0, { numFmt: MONEY, align: 'right', border: true });
    put(ws, 'E' + r, timing, { border: true, align: 'right', color: C.muted });
    put(ws, 'F' + r, it.from ?? 0, { numFmt: INT, align: 'right', border: true });
    put(ws, 'G' + r, (it.to == null || it.to === '') ? 'open' : it.to, { align: 'right', border: true, color: C.muted });
    put(ws, 'H' + r, eq, { numFmt: MONEY, align: 'right', border: true, color: C.muted });
    r++;
  });
  put(ws, 'G' + r, 'Weekly burn', { bold: true, align: 'right' });
  put(ws, 'H' + r, wk, { numFmt: MONEY, align: 'right', bold: true, color: C.red });
  ws.views = [{ state: 'frozen', ySplit: headRow }];
}

// ── Capital ──
function buildCapital(ws, d) {
  const { capital } = d;
  ws.columns = [{ width: 24 }, { width: 12 }, { width: 16 }, { width: 14 }, { width: 9 }, { width: 11 }, { width: 16 }];
  band(ws, 1, 7, 'Capital', C.dark, C.white, 13, 24);
  const headRow = 3;
  tableHeader(ws, headRow, ['Source', 'Type', 'Amount', 'Funding date', 'Rate %', 'Term (mo)', 'Repayment'], ['left', 'left', 'right', 'left', 'right', 'right', 'left']);
  let r = headRow + 1;
  (capital || []).forEach((c) => {
    const debt = c.type === 'debt';
    put(ws, 'A' + r, c.label, { border: true });
    put(ws, 'B' + r, c.type, { border: true, color: debt ? C.purple : C.green });
    put(ws, 'C' + r, Number(c.amount) || 0, { numFmt: MONEY, align: 'right', border: true });
    put(ws, 'D' + r, c.date || '', { border: true });
    put(ws, 'E' + r, debt ? (Number(c.rate) || 0) / 100 : '', { numFmt: debt ? PERCENT : undefined, align: 'right', border: true, color: C.muted });
    put(ws, 'F' + r, debt ? (Number(c.termMonths) || 0) : '', { numFmt: debt ? INT : undefined, align: 'right', border: true, color: C.muted });
    put(ws, 'G' + r, debt ? c.repay : '—', { border: true, color: C.muted });
    r++;
  });
  ws.views = [{ state: 'frozen', ySplit: headRow }];
}

// Pure builder — takes the ExcelJS constructor + data, returns the workbook.
// Kept separate from the download path so it's testable outside the browser.
export function buildTreasuryWorkbook(ExcelJS, data) {
  const d = { ...data, now: data.now || new Date() };
  const wb = new ExcelJS.Workbook();
  wb.creator = 'Treasury Cockpit';
  wb.created = d.now;
  buildSummary(wb.addWorksheet('Summary', { properties: { tabColor: { argb: C.teal } } }), d);
  buildCashFlow(wb.addWorksheet('Weekly Cash Flow', { properties: { tabColor: { argb: C.purple } }, views: [{ showGridLines: true }] }), d);
  buildRuns(wb.addWorksheet('Runs & Events', { properties: { tabColor: { argb: C.teal } } }), d);
  buildAP(wb.addWorksheet('Accounts Payable', { properties: { tabColor: { argb: C.amber } } }), d);
  buildFixed(wb.addWorksheet('Fixed Costs', { properties: { tabColor: { argb: C.amber } } }), d);
  buildCapital(wb.addWorksheet('Capital', { properties: { tabColor: { argb: C.purple } } }), d);
  return wb;
}

export async function exportTreasuryToExcel(data) {
  const ExcelJS = await loadExcelJS();
  const wb = buildTreasuryWorkbook(ExcelJS, data);
  const stamp = (data.now || new Date()).toISOString().slice(0, 10);
  await downloadWorkbook(wb, `treasury_cockpit_${filename(stamp)}`);
}
