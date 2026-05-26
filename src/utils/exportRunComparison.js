import { PAGE_W, M, PdfDoc, money, number, filename, drawSectionTitle } from './pdf';
import { computeRunResults } from './runResults';

const COL_LABEL = 186;
const COL_VAL = 114;
const TABLE_W = COL_LABEL + COL_VAL * 3;

function signedMoney(value) {
  const sign = value > 0 ? '+' : value < 0 ? '-' : '';
  return `${sign}${money(Math.abs(value))}`;
}

function signedNumber(value, digits = 0) {
  const sign = value > 0 ? '+' : value < 0 ? '-' : '';
  return `${sign}${number(Math.abs(value), digits)}`;
}

// Green when B is cheaper than A, red when pricier.
function deltaColor(value) {
  if (value > 0.005) return '#b91c1c';
  if (value < -0.005) return '#15803d';
  return '#64748b';
}

function drawCompareTable(pdf, columnsLabels, rows) {
  const headerH = 26;
  const rowH = 24;
  pdf.ensure(headerH + rowH * Math.min(rows.length || 1, 4) + 8);

  pdf.rect(M, pdf.y, TABLE_W, headerH, '#eff5f3');
  const cols = [
    { label: columnsLabels[0], x: M, w: COL_LABEL, align: 'left' },
    { label: columnsLabels[1], x: M + COL_LABEL, w: COL_VAL, align: 'right' },
    { label: columnsLabels[2], x: M + COL_LABEL + COL_VAL, w: COL_VAL, align: 'right' },
    { label: columnsLabels[3], x: M + COL_LABEL + COL_VAL * 2, w: COL_VAL, align: 'right' },
  ];
  cols.forEach((c) => pdf.text(c.label, c.x + 8, pdf.y + 17, { size: 8, bold: true, color: '#49615e', align: c.align, width: c.w - 16 }));
  pdf.y += headerH;

  rows.forEach((row, i) => {
    pdf.ensure(rowH + 6);
    if (i % 2 === 0) pdf.rect(M, pdf.y, TABLE_W, rowH, '#fbfaf6');
    pdf.text(row.label, cols[0].x + 8, pdf.y + 16, { size: 9, bold: !!row.bold, color: '#172033', align: 'left', width: cols[0].w - 16 });
    pdf.text(row.a, cols[1].x + 8, pdf.y + 16, { size: 9, bold: !!row.bold, color: '#172033', align: 'right', width: cols[1].w - 16 });
    pdf.text(row.b, cols[2].x + 8, pdf.y + 16, { size: 9, bold: !!row.bold, color: '#172033', align: 'right', width: cols[2].w - 16 });
    pdf.text(row.delta, cols[3].x + 8, pdf.y + 16, { size: 9, bold: true, color: row.deltaColor || '#64748b', align: 'right', width: cols[3].w - 16 });
    pdf.line(M, pdf.y + rowH, M + TABLE_W, pdf.y + rowH, '#e8edf2', 0.5);
    pdf.y += rowH;
  });
}

export function exportRunComparison(runA, runB) {
  const a = computeRunResults(runA);
  const b = computeRunResults(runB);
  const nameA = runA.name || 'Run A';
  const nameB = runB.name || 'Run B';
  const pdf = new PdfDoc();

  // Header band
  pdf.rect(0, 0, PAGE_W, 150, '#0f766e');
  pdf.rect(0, 0, PAGE_W, 150, '#102033');
  pdf.pill('RUN COMPARISON', M, 34, 116, '#f59e0b', '#111827');
  pdf.text('Production Run Comparison', M, 86, { size: 26, bold: true, color: '#ffffff' });
  pdf.text(`Generated ${new Date().toLocaleDateString()}`, M, 116, { size: 10, color: '#bff6ee' });
  pdf.y = 176;

  // Run name cards
  const cardW = (PAGE_W - M * 2 - 16) / 2;
  [[nameA, runA.client, '#0f766e'], [nameB, runB.client, '#6d28d9']].forEach(([name, client, color], i) => {
    const x = M + i * (cardW + 16);
    pdf.rect(x, pdf.y, cardW, 56, '#f8fafc');
    pdf.rect(x, pdf.y, 5, 56, color);
    pdf.text((i === 0 ? 'RUN A' : 'RUN B'), x + 16, pdf.y + 18, { size: 7, bold: true, color: '#64748b' });
    pdf.text(name, x + 16, pdf.y + 36, { size: 13, bold: true, color: '#102033' });
    if (client) pdf.text(client, x + 16, pdf.y + 50, { size: 9, color: '#64748b' });
  });
  pdf.y += 80;

  // Headline metrics
  drawSectionTitle(pdf, 'Headline Metrics');
  drawCompareTable(pdf, ['Metric', 'Run A', 'Run B', 'Difference'], [
    { label: 'Total Production Cost', a: money(a.costs.totalCost), b: money(b.costs.totalCost), delta: signedMoney(b.costs.totalCost - a.costs.totalCost), deltaColor: deltaColor(b.costs.totalCost - a.costs.totalCost), bold: true },
    { label: 'Cost per Can', a: money(a.costs.costPerUnit, 4), b: money(b.costs.costPerUnit, 4), delta: signedMoney(b.costs.costPerUnit - a.costs.costPerUnit), deltaColor: deltaColor(b.costs.costPerUnit - a.costs.costPerUnit) },
    { label: 'Cost per Case', a: money(a.costs.costPerCase), b: money(b.costs.costPerCase), delta: signedMoney(b.costs.costPerCase - a.costs.costPerCase), deltaColor: deltaColor(b.costs.costPerCase - a.costs.costPerCase) },
    { label: 'Total Cans', a: number(a.counts.totalUnits), b: number(b.counts.totalUnits), delta: signedNumber(b.counts.totalUnits - a.counts.totalUnits), deltaColor: '#475569' },
    { label: 'Total Cases', a: number(a.counts.totalCases), b: number(b.counts.totalCases), delta: signedNumber(b.counts.totalCases - a.counts.totalCases), deltaColor: '#475569' },
    { label: 'Total Pallets', a: number(a.counts.totalPallets), b: number(b.counts.totalPallets), delta: signedNumber(b.counts.totalPallets - a.counts.totalPallets), deltaColor: '#475569' },
  ]);

  // Cost breakdown (union of category labels)
  drawSectionTitle(pdf, 'Cost Breakdown');
  const labels = [];
  [...a.breakdown, ...b.breakdown].forEach((r) => { if (!labels.includes(r.label)) labels.push(r.label); });
  const findCost = (bd, label) => (bd.find((r) => r.label === label)?.cost || 0);
  drawCompareTable(pdf, ['Category', 'Run A', 'Run B', 'Difference'], labels.map((label) => {
    const ca = findCost(a.breakdown, label);
    const cb = findCost(b.breakdown, label);
    return { label, a: money(ca), b: money(cb), delta: signedMoney(cb - ca), deltaColor: deltaColor(cb - ca) };
  }));

  // Production scope
  drawSectionTitle(pdf, 'Production Scope');
  const fmtScope = (cfg, counts) => ({
    fill: `${number(cfg.fillVolume, 2)} ${cfg.fillVolumeUnit || 'oz'}`,
    pack: `${number(cfg.packSize)}-pk / ${number(cfg.unitsPerCase)} per case`,
    carrier: cfg.carrierType || 'paktech',
    abv: `${number(cfg.abv, 2)}%`,
    trucks: number(counts.totalTrucks, 1),
    flavors: number(counts.flavorCount),
  });
  const sa = fmtScope(a.config, a.counts);
  const sb = fmtScope(b.config, b.counts);
  drawCompareTable(pdf, ['Setting', 'Run A', 'Run B', ''], [
    { label: 'Fill Volume', a: sa.fill, b: sb.fill, delta: '' },
    { label: 'Pack Format', a: sa.pack, b: sb.pack, delta: '' },
    { label: 'Carrier', a: sa.carrier, b: sb.carrier, delta: '' },
    { label: 'ABV', a: sa.abv, b: sb.abv, delta: '' },
    { label: 'Trucks', a: sa.trucks, b: sb.trucks, delta: '' },
    { label: 'Flavors / SKUs', a: sa.flavors, b: sb.flavors, delta: '' },
  ]);

  pdf.ensure(64);
  pdf.y += 16;
  pdf.rect(M, pdf.y, PAGE_W - M * 2, 44, '#f8fafc');
  pdf.wrapped(
    'Comparison of estimated production costs based on each run\'s saved assumptions. Ingredient costs reflect the values quoted when each run was saved.',
    M + 16, pdf.y + 18, 96, { size: 9, color: '#64748b' },
  );

  pdf.download(`${filename(nameA)}_vs_${filename(nameB)}_comparison`);
}
