// Shared lightweight PDF generator (no external deps).
// Emits a minimal PDF 1.4 document with Helvetica / Helvetica-Bold,
// rectangles, lines and text. Used by the client-quote and run-comparison exports.

export const PAGE_W = 612;
export const PAGE_H = 792;
export const M = 42;

export function money(value, digits = 2) {
  return (value || 0).toLocaleString(undefined, {
    style: 'currency',
    currency: 'USD',
    minimumFractionDigits: digits,
    maximumFractionDigits: digits,
  });
}

export function number(value, digits = 0) {
  return (value || 0).toLocaleString(undefined, {
    minimumFractionDigits: digits,
    maximumFractionDigits: digits,
  });
}

export function filename(value) {
  return String(value || 'export')
    .trim()
    .replace(/[^a-z0-9]+/gi, '_')
    .replace(/^_+|_+$/g, '')
    .toLowerCase();
}

function clean(value) {
  return String(value ?? '')
    .replace(/[‘’]/g, "'")
    .replace(/[“”]/g, '"')
    .replace(/[–—]/g, '-')
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

export class PdfDoc {
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
    link.download = name.endsWith('.pdf') ? name : `${name}.pdf`;
    document.body.appendChild(link);
    link.click();
    link.remove();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  }
}

export function drawSectionTitle(pdf, title) {
  pdf.ensure(40);
  pdf.line(M, pdf.y, PAGE_W - M, pdf.y, '#d8d3c8', 1);
  pdf.y += 24;
  pdf.text(title, M, pdf.y, { size: 16, bold: true, color: '#102033' });
  pdf.y += 18;
}

export function drawTable(pdf, columns, rows) {
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
