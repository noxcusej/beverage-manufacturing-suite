import { PAGE_W, M, PdfDoc, money, number, filename, drawSectionTitle, drawTable } from './pdf';

function lineRows(rows = []) {
  // Synthetic rows (pack groups, cartons) are shown in their own Pack
  // Configuration table above so the client doesn't see them twice.
  return rows
    .filter((row) => (row.lineCost || 0) > 0 && !row.synthetic)
    .map((row) => [
      row.name || 'Line item',
      row.feeType || '',
      money(row.rate || 0, row.feeType === 'per-unit' ? 4 : 2),
      number(row.qty || 0, row.feeType === 'per-proof-gallon' ? 2 : 0),
      money(row.lineCost || 0),
    ]);
}

export function exportClientQuote(quote) {
  const { client, runName, config, counts, costs, breakdown, flavors, planDerived } = quote;
  const title = runName || 'Production Quote';
  const clientName = client || 'Client';
  const pdf = new PdfDoc();

  pdf.rect(0, 0, PAGE_W, 184, '#102033');
  pdf.rect(0, 0, PAGE_W, 184, '#0f766e');
  pdf.rect(410, 0, 202, 184, '#111827');
  pdf.pill('CLIENT QUOTE', M, 38, 96, '#f59e0b', '#111827');
  pdf.text(title, M, 88, { size: 34, bold: true, color: '#ffffff' });
  pdf.wrapped(`Prepared for ${clientName}`, M, 118, 48, { size: 12, color: '#d8fffa' });
  pdf.text(`Generated ${new Date().toLocaleDateString()}`, M, 148, { size: 10, color: '#bff6ee' });
  pdf.rect(406, 52, 150, 82, '#fef3c7');
  pdf.text('ESTIMATED TOTAL', 424, 80, { size: 8, bold: true, color: '#92400e' });
  pdf.text(money(costs.totalCost), 424, 114, { size: 24, bold: true, color: '#111827' });
  pdf.y = 218;

  const kpiW = (PAGE_W - M * 2 - 30) / 4;
  [
    ['Per Can', money(costs.costPerUnit, 4)],
    ['Per Case', money(costs.costPerCase)],
    ['Cases', number(counts.totalCases)],
    ['Cans', number(counts.totalUnits)],
  ].forEach(([label, value], i) => {
    const x = M + i * (kpiW + 10);
    pdf.rect(x, pdf.y, kpiW, 58, '#f8fafc');
    pdf.text(label.toUpperCase(), x + 12, pdf.y + 20, { size: 7, bold: true, color: '#64748b' });
    pdf.text(value, x + 12, pdf.y + 43, { size: 16, bold: true, color: '#102033' });
  });
  pdf.y += 88;

  drawSectionTitle(pdf, 'Production Scope');
  const assumptions = [
    ['Fill', `${number(config.fillVolume, 2)} ${config.fillVolumeUnit}`],
    ['Pack', `${number(config.packSize)}-pack / ${number(config.unitsPerCase)} units per case`],
    ['Carrier', config.carrierType || 'paktech'],
    ['Pallets', number(counts.totalPallets, 1)],
    ['Trucks', number(counts.totalTrucks, 1)],
    ['ABV', `${number(config.abv, 2)}%`],
  ];
  assumptions.forEach(([label, value], i) => {
    const col = i % 3;
    const row = Math.floor(i / 3);
    const x = M + col * 174;
    const y = pdf.y + row * 40;
    pdf.rect(x, y, 164, 30, '#fff7ed');
    pdf.text(`${label}:`, x + 10, y + 19, { size: 9, bold: true, color: '#9a3412' });
    pdf.text(value, x + 58, y + 19, { size: 9, color: '#334155' });
  });
  pdf.y += 94;

  drawSectionTitle(pdf, 'Flavor Lineup');
  drawTable(pdf, [
    { label: 'Flavor', width: 250 },
    { label: 'Cases', width: 84, align: 'right' },
    { label: 'Cans', width: 94, align: 'right' },
    { label: 'Pallets', width: 84, align: 'right' },
  ], (flavors || []).map((flavor) => [
    flavor.name || 'Flavor',
    number(flavor.cases || 0),
    number(flavor.cans || 0),
    number(flavor.pallets || 0, 1),
  ]));

  // Pack Configuration — shown when a packaging plan is configured so the
  // client sees exactly what gets packed at what price.
  if (planDerived?.active && planDerived.groups.length > 0) {
    drawSectionTitle(pdf, 'Pack Configuration');
    const flavorById = Object.fromEntries((flavors || []).map((f) => [f.id, f]));
    drawTable(pdf, [
      { label: 'Description', width: 230 },
      { label: 'Pack', width: 46, align: 'right' },
      { label: 'Packs', width: 64, align: 'right' },
      { label: 'Cases', width: 56, align: 'right' },
      { label: '$/Pack', width: 64, align: 'right' },
      { label: 'Line Cost', width: 72, align: 'right', bold: true },
    ], planDerived.groups.map((g) => {
      const description = g.label || (g.type === 'straight'
        ? `${flavorById[g.skuId]?.name || 'Straight'} ${g.packSize}-pack`
        : `Variety ${g.packSize}-pack (${(g.mix || []).filter((m) => (m.cans || 0) > 0).map((m) => flavorById[m.skuId]?.name || m.skuId).join(' / ') || '—'})`);
      const rate = Number(g.unitPrice) || 0;
      const qty = g.packsCount || 0;
      return [
        description,
        `${g.packSize}-pk`,
        number(qty),
        number(Math.ceil(g.casesConsumed || 0)),
        money(rate, 4),
        money(rate * qty),
      ];
    }));
  }

  drawSectionTitle(pdf, 'Quote Summary');
  drawTable(pdf, [
    { label: 'Category', width: 270 },
    { label: 'Per Can', width: 120, align: 'right' },
    { label: 'Total', width: 122, align: 'right', bold: true },
  ], (breakdown || []).filter((row) => (row.cost || 0) > 0).map((row) => [
    row.label,
    money(row.perUnit || 0, 4),
    money(row.cost || 0),
  ]));

  drawSectionTitle(pdf, 'Included Quote Lines');
  drawTable(pdf, [
    { label: 'Item', width: 220 },
    { label: 'Basis', width: 86 },
    { label: 'Rate', width: 82, align: 'right' },
    { label: 'Qty', width: 62, align: 'right' },
    { label: 'Total', width: 82, align: 'right', bold: true },
  ], [
    ...lineRows(costs.pkgRows),
    ...lineRows(costs.tollRows),
    ...lineRows(costs.bomRows),
    ...lineRows(costs.taxRows),
  ]);

  pdf.ensure(64);
  pdf.y += 20;
  pdf.rect(M, pdf.y, PAGE_W - M * 2, 48, '#f8fafc');
  pdf.wrapped(
    'This quote is an estimate based on the run assumptions shown above. Final pricing may change with recipe revisions, supplier pricing, packaging availability, taxes, regulatory requirements, freight, or production schedule changes.',
    M + 16,
    pdf.y + 18,
    96,
    { size: 9, color: '#64748b' },
  );

  pdf.download(`${filename(title)}_quote`);
}
