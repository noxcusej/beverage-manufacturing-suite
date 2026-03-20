import * as XLSX from 'xlsx';

function s(ws, ref, val, opts = {}) {
  const cell = { v: val, t: typeof val === 'number' ? 'n' : 's' };
  if (opts.f) { cell.f = opts.f; delete cell.v; cell.t = 'n'; }
  if (opts.z) cell.z = opts.z;
  ws[ref] = cell;
}

function colLetter(i) {
  let r = '';
  while (i >= 0) { r = String.fromCharCode(65 + (i % 26)) + r; i = Math.floor(i / 26) - 1; }
  return r;
}

// ── Co-Packing Export ──

export function exportCoPackingToExcel(runData) {
  const wb = XLSX.utils.book_new();
  const config = runData.config || {};
  const flavors = runData.flavors || [];
  const pkgItems = runData.packagingItems || [];
  const tollItems = runData.tollingItems || [];
  const bomItems = runData.bomItems || [];
  const taxItems = runData.taxItems || [];
  const upc = config.unitsPerCase || 24;

  // === Sheet 1: Summary ===
  const ws = {};
  let r = 1;
  s(ws, 'A1', 'Co-Packing Cost Sheet');
  s(ws, 'A2', runData.name || 'Untitled Run');
  s(ws, 'A3', `Generated: ${new Date().toLocaleDateString()}`);
  r = 5;

  // Config
  s(ws, 'A' + r, 'Run Configuration'); r++;
  const cfgPairs = [
    ['Fill Volume', `${config.fillVolume || 12} ${config.fillVolumeUnit || 'oz'}`],
    ['Pack Size', `${config.packSize || 4}-pack`],
    ['Carrier', config.carrierType || 'paktech'],
    ['ABV', `${config.abv || 0}%`],
    ['Units/Case', upc],
    ['Cases/Pallet', config.casesPerPallet || 80],
  ];
  cfgPairs.forEach(([k, v]) => { s(ws, 'A' + r, k); s(ws, 'B' + r, v); r++; });
  r++;

  // Flavor Lineup
  const flvStart = r;
  s(ws, 'A' + r, 'Flavor Lineup'); r++;
  s(ws, 'A' + r, 'SKU'); s(ws, 'B' + r, 'Cases'); s(ws, 'C' + r, 'Cans');
  s(ws, 'D' + r, 'Ingr $/can'); s(ws, 'E' + r, 'Stab $/can'); s(ws, 'F' + r, 'Batching Fee');
  s(ws, 'G' + r, 'Ingr Cost'); s(ws, 'H' + r, 'Stab Cost'); r++;

  const flvDataStart = r;
  flavors.forEach((f, i) => {
    const row = r + i;
    s(ws, 'A' + row, f.name || `SKU ${i + 1}`);
    s(ws, 'B' + row, f.cases || 0);
    s(ws, `C${row}`, null, { f: `B${row}*${upc}` }); // cans = cases * upc
    s(ws, 'D' + row, f.ingredientCost || 0, { z: '$#,##0.0000' });
    s(ws, 'E' + row, f.stabilizationCost || 0, { z: '$#,##0.0000' });
    s(ws, 'F' + row, f.batchingFee || 0, { z: '$#,##0.00' });
    s(ws, `G${row}`, null, { f: `D${row}*C${row}`, z: '$#,##0.00' }); // ingr cost = rate * cans
    s(ws, `H${row}`, null, { f: `E${row}*C${row}`, z: '$#,##0.00' }); // stab cost = rate * cans
  });
  const flvDataEnd = r + flavors.length - 1;
  r = flvDataEnd + 1;

  // Totals row
  s(ws, 'A' + r, 'TOTAL');
  s(ws, `B${r}`, null, { f: `SUM(B${flvDataStart}:B${flvDataEnd})` });
  s(ws, `C${r}`, null, { f: `SUM(C${flvDataStart}:C${flvDataEnd})` });
  s(ws, `F${r}`, null, { f: `SUM(F${flvDataStart}:F${flvDataEnd})`, z: '$#,##0.00' });
  s(ws, `G${r}`, null, { f: `SUM(G${flvDataStart}:G${flvDataEnd})`, z: '$#,##0.00' });
  s(ws, `H${r}`, null, { f: `SUM(H${flvDataStart}:H${flvDataEnd})`, z: '$#,##0.00' });
  const totalCansCell = `C${r}`;
  const totalCasesCell = `B${r}`;
  const totalIngCell = `G${r}`;
  const totalStabCell = `H${r}`;
  const totalBatchCell = `F${r}`;
  r += 2;

  // Line item sections
  function writeSection(title, items, startRow) {
    let row = startRow;
    s(ws, 'A' + row, title); row++;
    s(ws, 'A' + row, 'Item'); s(ws, 'B' + row, 'Fee Type'); s(ws, 'C' + row, 'Rate');
    s(ws, 'D' + row, 'Qty'); s(ws, 'E' + row, 'Line Cost'); row++;
    const dataStart = row;
    items.forEach((item, i) => {
      const ir = row + i;
      s(ws, 'A' + ir, item.name);
      s(ws, 'B' + ir, item.feeType);
      s(ws, 'C' + ir, item.rate || 0, { z: '$#,##0.0000' });
      s(ws, 'D' + ir, item.qty || 0);
      s(ws, `E${ir}`, null, { f: `C${ir}*D${ir}`, z: '$#,##0.00' }); // line cost = rate * qty
    });
    const dataEnd = row + items.length - 1;
    row = dataEnd + 1;
    s(ws, 'A' + row, 'Subtotal');
    s(ws, `E${row}`, null, { f: `SUM(E${dataStart}:E${dataEnd})`, z: '$#,##0.00' });
    return { endRow: row + 1, subtotalCell: `E${row}` };
  }

  const pkg = writeSection('Packaging Materials', pkgItems, r);
  r = pkg.endRow + 1;
  const toll = writeSection('Tolling', tollItems, r);
  r = toll.endRow + 1;
  const bom = writeSection('Bill of Materials', bomItems, r);
  r = bom.endRow + 1;
  const tax = writeSection('Taxes & Regulatory', taxItems, r);
  r = tax.endRow + 2;

  // Grand totals with formulas
  s(ws, 'A' + r, 'COST SUMMARY'); r++;
  const summaryItems = [
    ['Ingredients', totalIngCell],
    ['Stabilization', totalStabCell],
    ['Batching Fees', totalBatchCell],
    ['Packaging Materials', pkg.subtotalCell],
    ['Tolling', toll.subtotalCell],
    ['Bill of Materials', bom.subtotalCell],
    ['Taxes & Regulatory', tax.subtotalCell],
  ];
  const sumStart = r;
  summaryItems.forEach(([label, ref], i) => {
    s(ws, 'A' + (r + i), label);
    s(ws, `B${r + i}`, null, { f: ref, z: '$#,##0.00' });
  });
  r += summaryItems.length;
  s(ws, 'A' + r, 'GRAND TOTAL');
  s(ws, `B${r}`, null, { f: `SUM(B${sumStart}:B${r - 1})`, z: '$#,##0.00' });
  const grandTotalCell = `B${r}`;
  r++;
  s(ws, 'A' + r, 'Cost per Unit');
  s(ws, `B${r}`, null, { f: `IF(${totalCansCell}>0,${grandTotalCell}/${totalCansCell},0)`, z: '$#,##0.0000' });
  r++;
  s(ws, 'A' + r, 'Cost per Case');
  s(ws, `B${r}`, null, { f: `IF(${totalCansCell}>0,${grandTotalCell}/${totalCansCell}*${upc},0)`, z: '$#,##0.00' });
  r++;
  s(ws, 'A' + r, 'Cost per Pack');
  s(ws, `B${r}`, null, { f: `IF(${totalCansCell}>0,${grandTotalCell}/${totalCansCell}*${config.packSize || 4},0)`, z: '$#,##0.00' });

  // Set column widths
  ws['!cols'] = [{ wch: 30 }, { wch: 14 }, { wch: 14 }, { wch: 14 }, { wch: 14 }, { wch: 14 }, { wch: 14 }, { wch: 14 }];
  ws['!ref'] = XLSX.utils.encode_range({ s: { r: 0, c: 0 }, e: { r: r, c: 7 } });

  XLSX.utils.book_append_sheet(wb, ws, 'Cost Sheet');

  // Download
  XLSX.writeFile(wb, `copacking_${(runData.name || 'run').replace(/\s+/g, '_')}_${new Date().toISOString().split('T')[0]}.xlsx`);
}

// ── Batch Calculator Export ──

export function exportBatchToExcel({ formulaName, baseYield, baseYieldUnit, batchSize, batchSizeUnit, unitSizeVal, unitSizeUnit, unitsPerCase, ingredients, scaledRows, totalCost, unitEcon }) {
  const wb = XLSX.utils.book_new();
  const ws = {};
  let r = 1;

  s(ws, 'A1', 'Batch Calculator');
  s(ws, 'A2', formulaName || 'Untitled Formula');
  s(ws, 'A3', `Generated: ${new Date().toLocaleDateString()}`);
  r = 5;

  // Config
  s(ws, 'A' + r, 'Base Yield'); s(ws, 'B' + r, baseYield); s(ws, 'C' + r, baseYieldUnit); r++;
  s(ws, 'A' + r, 'Batch Size'); s(ws, 'B' + r, batchSize); s(ws, 'C' + r, batchSizeUnit); r++;
  s(ws, 'A' + r, 'Scale Factor');
  s(ws, `B${r}`, null, { f: `B${r - 1}/B${r - 2}`, z: '0.00"x"' });
  const sfCell = `B${r}`;
  r++;
  s(ws, 'A' + r, 'Unit Size'); s(ws, 'B' + r, unitSizeVal); s(ws, 'C' + r, unitSizeUnit); r++;
  s(ws, 'A' + r, 'Units/Case'); s(ws, 'B' + r, unitsPerCase); r += 2;

  // Ingredient matrix
  s(ws, 'A' + r, 'Ingredient Matrix'); r++;
  s(ws, 'A' + r, 'Ingredient'); s(ws, 'B' + r, 'Recipe Amt'); s(ws, 'C' + r, 'Unit');
  s(ws, 'D' + r, 'Scaled Amt'); s(ws, 'E' + r, 'Buy Unit'); s(ws, 'F' + r, 'Price/Unit');
  s(ws, 'G' + r, 'MOQ'); s(ws, 'H' + r, 'Order Qty'); s(ws, 'I' + r, 'Line Cost'); r++;

  const ingStart = r;
  (scaledRows || []).forEach((row, i) => {
    const ir = r + i;
    s(ws, 'A' + ir, row.item?.name || row.draftName || 'Unknown');
    s(ws, 'B' + ir, row.recipeAmount || 0);
    s(ws, 'C' + ir, row.recipeUnit || '');
    s(ws, `D${ir}`, null, { f: `B${ir}*${sfCell}` }); // scaled = recipe * scale factor
    s(ws, 'E' + ir, row.buyUnit || '');
    s(ws, 'F' + ir, row.pricePerBuyUnit || 0, { z: '$#,##0.0000' });
    s(ws, 'G' + ir, row.moq || 1);
    s(ws, `H${ir}`, null, { f: `CEILING(D${ir}/G${ir},1)*G${ir}` }); // order qty
    s(ws, `I${ir}`, null, { f: `H${ir}*F${ir}`, z: '$#,##0.00' }); // line cost
  });
  const ingEnd = r + (scaledRows || []).length - 1;
  r = ingEnd + 1;

  s(ws, 'A' + r, 'TOTAL');
  s(ws, `I${r}`, null, { f: `SUM(I${ingStart}:I${ingEnd})`, z: '$#,##0.00' });
  const totalCell = `I${r}`;
  r += 2;

  // Unit economics
  s(ws, 'A' + r, 'Unit Economics'); r++;
  s(ws, 'A' + r, 'Total Batch Cost'); s(ws, `B${r}`, null, { f: totalCell, z: '$#,##0.00' }); r++;
  s(ws, 'A' + r, 'Total Units'); s(ws, 'B' + r, unitEcon?.totalUnits || 0); r++;
  s(ws, 'A' + r, 'Cost per Unit');
  s(ws, `B${r}`, null, { f: `IF(B${r - 1}>0,B${r - 2}/B${r - 1},0)`, z: '$#,##0.0000' }); r++;
  s(ws, 'A' + r, 'Cost per Case');
  s(ws, `B${r}`, null, { f: `B${r - 1}*${unitsPerCase}`, z: '$#,##0.00' });

  ws['!cols'] = [{ wch: 25 }, { wch: 14 }, { wch: 10 }, { wch: 14 }, { wch: 10 }, { wch: 14 }, { wch: 8 }, { wch: 14 }, { wch: 14 }];
  ws['!ref'] = XLSX.utils.encode_range({ s: { r: 0, c: 0 }, e: { r: r, c: 8 } });

  XLSX.utils.book_append_sheet(wb, ws, 'Batch Calculator');
  XLSX.writeFile(wb, `batch_${(formulaName || 'formula').replace(/\s+/g, '_')}_${new Date().toISOString().split('T')[0]}.xlsx`);
}
