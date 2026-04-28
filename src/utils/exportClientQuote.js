const PAGE_W = 612;
const PAGE_H = 792;
const M = 42;

function money(value, digits = 2) {
  return (value || 0).toLocaleString(undefined, {
    style: 'currency',
    currency: 'USD',
    minimumFractionDigits: digits,
    maximumFractionDigits: digits,
  });
}

function number(value, digits = 0) {
  return (value || 0).toLocaleString(undefined, {
    minimumFractionDigits: digits,
    maximumFractionDigits: digits,
  });
}

function filename(value) {
  return String(value || 'client_quote')
    .trim()
    .replace(/[^a-z0-9]+/gi, '_')
    .replace(/^_+|_+$/g, '')
    .toLowerCase();
}

function clean(value) {
  return String(value ?? '')
    .replace(/[\u2018\u2019]/g, "'")
    .replace(/[\u201c\u201d]/g, '"')
    .replace(/[\u2013\u2014]/g, '-')
    .split('')
    .filter((char) => {
      const code = char.charCodeAt(0);
      return code === 9 || code === 10 || code === 13 || (code >= 32 && code <= 126);
    })
    .join('');
}

function pdfText(value) {
  return clean(value).replace(/\\/g, '\\\\').replace(/\(/g, '\\(').replace(/\)/g, '\\)');
}

function wrapText(value, maxChars) {
  const words = clean(value).split(/\s+/).filter(Boolean);
  const lines = [];
  let line = '';
  words.forEach((word) => {
    const next = line ? `${line} ${word}` : word;
    if (next.length > maxChars && line) {
      lines.push(line);
      line = word;
    } else {
      line = next;
    }
  });
  if (line) lines.push(line);
  return lines.length ? lines : [''];
}

class PdfDoc {
  constructor() {
    this.pages = [];
    this.current = null;
    this.y = M;
    this.addPage();
  }

  addPage() {
    this.current = [];
    this.pages.push(this.current);
    this.y = M;
  }

  ensure(height) {
    if (this.y + height > PAGE_H - M) this.addPage();
  }

  cmd(value) {
    this.current.push(value);
  }

  rgb(hex) {
    const h = hex.replace('#', '');
    const r = parseInt(h.slice(0, 2), 16) / 255;
    const g = parseInt(h.slice(2, 4), 16) / 255;
    const b = parseInt(h.slice(4, 6), 16) / 255;
    return `${r.toFixed(3)} ${g.toFixed(3)} ${b.toFixed(3)}`;
  }

  fill(hex) {
    this.cmd(`${this.rgb(hex)} rg`);
  }

  stroke(hex) {
    this.cmd(`${this.rgb(hex)} RG`);
  }

  rect(x, y, w, h, color) {
    this.fill(color);
    this.cmd(`${x.toFixed(2)} ${(PAGE_H - y - h).toFixed(2)} ${w.toFixed(2)} ${h.toFixed(2)} re f`);
  }

  line(x1, y1, x2, y2, color = '#d8dee7', width = 1) {
    this.stroke(color);
    this.cmd(`${width} w ${x1.toFixed(2)} ${(PAGE_H - y1).toFixed(2)} m ${x2.toFixed(2)} ${(PAGE_H - y2).toFixed(2)} l S`);
  }

  text(value, x, y, opts = {}) {
    const size = opts.size || 10;
    const font = opts.bold ? 'F2' : 'F1';
    const color = opts.color || '#102033';
    const align = opts.align || 'left';
    const width = opts.width || 0;
    let tx = x;
    const approx = clean(value).length * size * 0.52;
    if (align === 'right') tx = x + width - approx;
    if (align === 'center') tx = x + (width - approx) / 2;
    this.fill(color);
    this.cmd(`BT /${font} ${size} Tf ${tx.toFixed(2)} ${(PAGE_H - y).toFixed(2)} Td (${pdfText(value)}) Tj ET`);
  }

  wrapped(value, x, y, maxChars, opts = {}) {
    const size = opts.size || 10;
    const lines = wrapText(value, maxChars);
    lines.forEach((line, i) => this.text(line, x, y + i * (size + 4), opts));
    return lines.length * (size + 4);
  }

  pill(label, x, y, w, color, textColor = '#ffffff') {
    this.rect(x, y, w, 22, color);
    this.text(label, x + 10, y + 14, { size: 9, bold: true, color: textColor });
  }

  download(name) {
    const objects = [];
    const add = (body) => {
      objects.push(body);
      return objects.length;
    };

    const fontRegular = add('<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>');
    const fontBold = add('<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica-Bold >>');

    const pageRefs = [];
    this.pages.forEach((content) => {
      const stream = content.join('\n');
      const contentRef = add(`<< /Length ${stream.length} >>\nstream\n${stream}\nendstream`);
      const pageRef = add(`<< /Type /Page /Parent PAGES_REF 0 R /MediaBox [0 0 ${PAGE_W} ${PAGE_H}] /Resources << /Font << /F1 ${fontRegular} 0 R /F2 ${fontBold} 0 R >> >> /Contents ${contentRef} 0 R >>`);
      pageRefs.push(pageRef);
    });

    const pagesRef = add(`<< /Type /Pages /Kids [${pageRefs.map((ref) => `${ref} 0 R`).join(' ')}] /Count ${pageRefs.length} >>`);
    const catalogRef = add(`<< /Type /Catalog /Pages ${pagesRef} 0 R >>`);

    const header = '%PDF-1.4\n';
    let body = '';
    const offsets = [0];
    objects.forEach((object, index) => {
      offsets.push(header.length + body.length);
      body += `${index + 1} 0 obj\n${object.replaceAll('PAGES_REF', String(pagesRef))}\nendobj\n`;
    });

    const xrefOffset = header.length + body.length;
    const xref = [
      'xref',
      `0 ${objects.length + 1}`,
      '0000000000 65535 f ',
      ...offsets.slice(1).map((offset) => `${String(offset).padStart(10, '0')} 00000 n `),
      'trailer',
      `<< /Size ${objects.length + 1} /Root ${catalogRef} 0 R >>`,
      'startxref',
      String(xrefOffset),
      '%%EOF',
    ].join('\n');

    const blob = new Blob([header, body, xref], { type: 'application/pdf' });
    const url = URL.createObjectURL(blob);
    const link = document.createElement('a');
    link.href = url;
    link.download = `${filename(name)}_quote.pdf`;
    document.body.appendChild(link);
    link.click();
    link.remove();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  }
}

function drawSectionTitle(pdf, title) {
  pdf.ensure(40);
  pdf.line(M, pdf.y, PAGE_W - M, pdf.y, '#d8d3c8', 1);
  pdf.y += 24;
  pdf.text(title, M, pdf.y, { size: 16, bold: true, color: '#102033' });
  pdf.y += 18;
}

function drawTable(pdf, columns, rows) {
  const rowH = 24;
  const headerH = 26;
  const widths = columns.map((col) => col.width);
  const tableW = widths.reduce((sum, width) => sum + width, 0);
  pdf.ensure(headerH + rowH * Math.min(rows.length || 1, 4) + 8);
  pdf.rect(M, pdf.y, tableW, headerH, '#eff5f3');
  let x = M;
  columns.forEach((col, i) => {
    pdf.text(col.label, x + 8, pdf.y + 17, { size: 8, bold: true, color: '#49615e', align: col.align, width: widths[i] - 16 });
    x += widths[i];
  });
  pdf.y += headerH;

  const safeRows = rows.length ? rows : [['No items', '', '', '', '']];
  safeRows.forEach((row, rowIndex) => {
    pdf.ensure(rowH + 6);
    if (rowIndex % 2 === 0) pdf.rect(M, pdf.y, tableW, rowH, '#fbfaf6');
    x = M;
    columns.forEach((col, i) => {
      pdf.text(row[i] ?? '', x + 8, pdf.y + 16, { size: 9, bold: col.bold, color: '#172033', align: col.align, width: widths[i] - 16 });
      x += widths[i];
    });
    pdf.line(M, pdf.y + rowH, M + tableW, pdf.y + rowH, '#e8edf2', 0.5);
    pdf.y += rowH;
  });
}

function lineRows(rows = []) {
  return rows
    .filter((row) => (row.lineCost || 0) > 0)
    .map((row) => [
      row.name || 'Line item',
      row.feeType || '',
      money(row.rate || 0, row.feeType === 'per-unit' ? 4 : 2),
      number(row.qty || 0, row.feeType === 'per-proof-gallon' ? 2 : 0),
      money(row.lineCost || 0),
    ]);
}

export function exportClientQuote(quote) {
  const { client, runName, config, counts, costs, breakdown, flavors } = quote;
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

  pdf.download(title);
}
