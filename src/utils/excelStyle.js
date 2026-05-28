// Shared ExcelJS styling + workbook helpers used by every spreadsheet export
// (single-run quote, two-run comparison, consolidated raw-material PO).
//
// Keeping the design tokens and primitive cell helpers in one place ensures
// every workbook downloaded from the app uses the same colors, number formats,
// banners, table layout and download behavior.

export const C = {
  dark: 'FF102033',
  teal: 'FF0F766E',
  purple: 'FF6D28D9',
  amber: 'FFF59E0B',
  headerBg: 'FFEFF5F3',
  zebra: 'FFF7FAF9',
  white: 'FFFFFFFF',
  muted: 'FF64748B',
  ink: 'FF172033',
  red: 'FFB91C1C',
  green: 'FF15803D',
  border: 'FFD8DEE7',
};

export const MONEY = '$#,##0.00';
export const MONEY4 = '$#,##0.0000';
export const INT = '#,##0';
export const DEC = '#,##0.00';
export const PERCENT = '0.00%';
export const DELTA_MONEY = '"+"$#,##0.00;"-"$#,##0.00;$0.00';
export const DELTA_MONEY4 = '"+"$#,##0.0000;"-"$#,##0.0000;$0.0000';
export const DELTA_INT = '"+"#,##0;"-"#,##0;0';

export function colLetter(i) {
  return String.fromCharCode(64 + i);
}

export function applyStyle(cell, s = {}) {
  const font = {};
  if (s.bold) font.bold = true;
  if (s.italic) font.italic = true;
  if (s.size) font.size = s.size;
  if (s.color) font.color = { argb: s.color };
  if (Object.keys(font).length) cell.font = font;
  if (s.bg) cell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: s.bg } };
  cell.alignment = { vertical: 'middle', horizontal: s.align || 'left', wrapText: !!s.wrap };
  if (s.numFmt) cell.numFmt = s.numFmt;
  if (s.border) {
    const b = { style: 'thin', color: { argb: C.border } };
    cell.border = { top: b, left: b, bottom: b, right: b };
  }
}

// Value cell.
export function put(ws, addr, value, style) {
  const cell = ws.getCell(addr);
  cell.value = value;
  applyStyle(cell, style);
  return cell;
}

// Formula cell carrying a cached numeric result so viewers that don't
// auto-recalculate (some xlsx readers) still display the right value.
export function putF(ws, addr, formula, result, style) {
  const cell = ws.getCell(addr);
  cell.value = { formula, result };
  applyStyle(cell, style);
  return cell;
}

// Section banner — a merged, filled row spanning columns 1..span.
export function band(ws, row, span, text, bg, color = C.white, size = 12, height = 22) {
  ws.mergeCells(`A${row}:${colLetter(span)}${row}`);
  put(ws, `A${row}`, text, { bold: true, color, bg, size, align: 'left' });
  ws.getRow(row).height = height;
}

// Standard table header row (zebra-light fill, muted bold labels, optional alignments).
export function tableHeader(ws, row, labels, aligns) {
  labels.forEach((label, i) => {
    const align = aligns?.[i] || (i === 0 ? 'left' : 'right');
    put(ws, `${colLetter(i + 1)}${row}`, label, {
      bold: true, color: C.muted, bg: C.headerBg, align, border: true,
    });
  });
}

export function deltaFont(value) {
  if (value > 0.005) return C.red;
  if (value < -0.005) return C.green;
  return C.muted;
}

export function filename(value) {
  return String(value || 'run')
    .trim()
    .replace(/[^a-z0-9]+/gi, '_')
    .replace(/^_+|_+$/g, '')
    .toLowerCase();
}

// ExcelJS is heavy (~270KB gzip). Load it on demand so it stays out of the
// route bundle until the user actually clicks an export button.
export async function loadExcelJS() {
  const mod = await import('exceljs');
  return mod.default;
}

// Build the workbook buffer and trigger a browser download.
export async function downloadWorkbook(wb, name) {
  const buffer = await wb.xlsx.writeBuffer();
  const blob = new Blob([buffer], { type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' });
  const url = URL.createObjectURL(blob);
  const link = document.createElement('a');
  link.href = url;
  link.download = name.endsWith('.xlsx') ? name : `${name}.xlsx`;
  document.body.appendChild(link);
  link.click();
  link.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}
