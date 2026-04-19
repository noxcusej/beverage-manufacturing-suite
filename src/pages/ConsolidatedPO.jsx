import { useState, useEffect, useMemo, useCallback } from 'react';
import {
  getFormulas,
  getInventory,
  hydrateFormulasFromSupabase,
  getFinishedGoods,
  upsertFinishedGood,
  deleteFinishedGood as deleteFinishedGoodInStore,
  getSavedPOs,
  upsertSavedPO,
  deleteSavedPO as deleteSavedPOInStore,
} from '../data/store';
import {
  exportConsolidatedPOToExcel,
  exportConsolidatedPOToGoogleSheets,
} from '../utils/exportConsolidatedPO';

// Unit conversion tables
const weightFactors = { lbs: 1, lb: 1, kg: 2.20462, g: 0.00220462, oz: 0.0625 };
const volumeFactors = { gal: 1, L: 0.264172, ml: 0.000264172, 'fl oz': 0.0078125 };
const weightUnits = new Set(['lbs', 'lb', 'kg', 'g', 'oz']);
const volumeUnits = new Set(['gal', 'L', 'ml', 'fl oz']);

function convert(value, from, to) {
  if (from === to) return value;
  if (weightFactors[from] && weightFactors[to]) return value * (weightFactors[from] / weightFactors[to]);
  if (volumeFactors[from] && volumeFactors[to]) return value * (volumeFactors[from] / volumeFactors[to]);
  return value;
}

function convertWithSG(value, from, to, sg) {
  if (from === to) return value;
  const fromIsWeight = weightUnits.has(from);
  const toIsVolume = volumeUnits.has(to);
  const fromIsVolume = volumeUnits.has(from);
  const toIsWeight = weightUnits.has(to);
  if (fromIsWeight && toIsVolume) {
    const lbs = convert(value, from, 'lbs');
    const gal = lbs / 8.345 * (sg || 1);
    return convert(gal, 'gal', to);
  }
  if (fromIsVolume && toIsWeight) {
    const gal = convert(value, from, 'gal');
    const lbs = gal * 8.345 / (sg || 1);
    return convert(lbs, 'lbs', to);
  }
  return convert(value, from, to);
}

function calcBatchSizeFromCases(formula, cases) {
  const {
    unitSizeVal = 12,
    unitSizeUnit = 'oz',
    unitsPerCase = 24,
    batchSizeUnit = 'gal',
  } = formula;
  const units = cases * unitsPerCase;
  let unitOz = unitSizeVal;
  if (unitSizeUnit === 'ml') unitOz = unitSizeVal / 29.5703;
  else if (unitSizeUnit === 'L') unitOz = unitSizeVal * 33.814;
  const totalGal = (units * unitOz) / 128;
  return batchSizeUnit === 'L' ? totalGal * 3.78541 : totalGal;
}

function calcIngredientNeeds(formula, cases, inventoryMap) {
  // batchSize is returned in batchSizeUnit; baseYield is in baseYieldUnit.
  // Formulas can (and do) have mismatched units — e.g. batchSize in L but
  // base recipe defined in gal. scaleFactor must be dimensionless, so
  // normalize both to gal before dividing. Skipping this silently inflates
  // ingredient demand by 3.78x whenever the units don't match.
  let batchSize = calcBatchSizeFromCases(formula, cases);
  let baseYield = formula.baseYield || 100;
  const batchUnit = formula.batchSizeUnit || 'gal';
  const yieldUnit = formula.baseYieldUnit || 'gal';
  if (batchUnit === 'L') batchSize = batchSize / 3.78541;
  if (yieldUnit === 'L') baseYield = baseYield / 3.78541;
  const scaleFactor = baseYield > 0 ? batchSize / baseYield : 1;

  return (formula.ingredients || []).map((ing) => {
    const item = inventoryMap[ing.inventoryId];
    const scaledRecipe = (ing.recipeAmount || 0) * scaleFactor;

    let buyUnitAmount = scaledRecipe;
    const buyUnit = ing.buyUnit || ing.recipeUnit || 'gal';
    if (ing.recipeUnit && ing.buyUnit && ing.recipeUnit !== ing.buyUnit) {
      buyUnitAmount = convertWithSG(scaledRecipe, ing.recipeUnit, ing.buyUnit, ing.specificGravity);
    }

    // On-hand snapshot lives on the ingredient (same pattern as BatchCalculator).
    // Convert into buy units so it can be compared against buyUnitAmount.
    let onHandInBuyUnits = 0;
    const invQty = ing.currentInventory || 0;
    const invUnit = ing.inventoryUnit || buyUnit;
    if (invQty > 0) {
      onHandInBuyUnits = invUnit === buyUnit
        ? invQty
        : convertWithSG(invQty, invUnit, buyUnit, ing.specificGravity);
      if (onHandInBuyUnits < 0) onHandInBuyUnits = 0;
    }

    return {
      inventoryId: ing.inventoryId || null,
      draftName: ing.draftName || '',
      name: item?.name || ing.draftName || 'Unknown',
      sku: item?.sku || '',
      vendor: item?.vendor || '',
      buyUnit,
      buyUnitAmount,
      onHandInBuyUnits,
      pricePerBuyUnit: ing.pricePerBuyUnit || 0,
      moq: ing.moq || 1,
      specificGravity: ing.specificGravity || 1,
    };
  });
}

// Build a stable key for grouping identical ingredients across formulas
function ingKey(ing) {
  return ing.inventoryId || `draft:${ing.draftName}`;
}

export default function ConsolidatedPO() {
  const [formulas, setFormulas] = useState([]);
  const [inventoryArr, setInventoryArr] = useState([]);
  const [generated, setGenerated] = useState(false);
  const [loading, setLoading] = useState(true);

  // Finished Good model — the unit of production planning.
  // A finished good is: pack composition (formulas × units), packs/case, cases/pallet.
  // Single-flavor packs are a degenerate case with one component in the pack.
  // Variety packs are the general case. No "direct formula selection" — users
  // must define a finished good, which makes unit economics unambiguous.
  //
  // Shape: { id, name, pack: [{ formulaId, units }], packsPerCase, casesPerPallet }
  // Session-only for now; promote to persistent storage once inventory is sorted.
  const [finishedGoods, setFinishedGoods] = useState([]);
  const [selectedFgs, setSelectedFgs] = useState({}); // { fgId: true }
  const [runQty, setRunQty] = useState({});           // { fgId: number }
  const [runLevel, setRunLevel] = useState({});       // { fgId: 'pallet'|'case'|'pack' }
  const [editingFg, setEditingFg] = useState(null);   // null | 'new' | fgId
  const [draftFg, setDraftFg] = useState(null);

  // Saved POs — a named snapshot of FG selections + run qty/level.
  // Stored in Supabase so runs can be recalled across sessions/devices.
  const [savedPOs, setSavedPOs] = useState([]);
  const [loadedPOId, setLoadedPOId] = useState(null);

  const refresh = useCallback(() => {
    setFormulas(getFormulas());
    setInventoryArr(getInventory());
    setFinishedGoods(getFinishedGoods());
    setSavedPOs(getSavedPOs());
  }, []);

  useEffect(() => {
    hydrateFormulasFromSupabase().then(() => {
      refresh();
      setLoading(false);
    });
    const handler = () => refresh();
    window.addEventListener('comanufacturing:datachange', handler);
    return () => window.removeEventListener('comanufacturing:datachange', handler);
  }, [refresh]);

  const inventoryMap = useMemo(() => {
    const map = {};
    inventoryArr.forEach((item) => { map[item.id] = item; });
    return map;
  }, [inventoryArr]);

  const selectedFgIds = Object.keys(selectedFgs).filter((id) => selectedFgs[id]);

  function toggleFg(id) {
    setSelectedFgs((s) => ({ ...s, [id]: !s[id] }));
    setGenerated(false);
  }

  function setFgQty(id, val) {
    const n = parseInt(val, 10);
    setRunQty((c) => ({ ...c, [id]: isNaN(n) ? 0 : n }));
    setGenerated(false);
  }

  function setFgLevel(id, level) {
    setRunLevel((c) => ({ ...c, [id]: level }));
    setGenerated(false);
  }

  function startNewFg() {
    setDraftFg({
      name: '',
      pack: [{ formulaId: '', units: 0 }],
      packsPerCase: 1,
      casesPerPallet: 56,
    });
    setEditingFg('new');
  }

  function startEditFg(id) {
    const fg = finishedGoods.find((f) => f.id === id);
    if (!fg) return;
    setDraftFg({
      name: fg.name,
      pack: fg.pack.map((c) => ({ ...c })),
      packsPerCase: fg.packsPerCase,
      casesPerPallet: fg.casesPerPallet,
    });
    setEditingFg(id);
  }

  function cancelFgEdit() {
    setEditingFg(null);
    setDraftFg(null);
  }

  function saveFg() {
    if (!draftFg) return;
    const name = (draftFg.name || '').trim();
    const pack = (draftFg.pack || []).filter(
      (c) => c.formulaId && Number(c.units) > 0
    );
    const packsPerCase = Math.max(1, parseInt(draftFg.packsPerCase, 10) || 1);
    const casesPerPallet = Math.max(1, parseInt(draftFg.casesPerPallet, 10) || 1);
    if (!name || pack.length === 0) {
      alert('Finished good needs a name and at least one formula in the pack with units > 0.');
      return;
    }
    if (editingFg === 'new') {
      const id = `fg-${Date.now()}`;
      const next = { id, name, pack, packsPerCase, casesPerPallet };
      setFinishedGoods((fgs) => [...fgs, next]);
      setSelectedFgs((s) => ({ ...s, [id]: true }));
      setRunLevel((c) => ({ ...c, [id]: 'case' }));
      upsertFinishedGood(next);
    } else {
      const next = { id: editingFg, name, pack, packsPerCase, casesPerPallet };
      setFinishedGoods((fgs) => fgs.map((f) => (f.id === editingFg ? next : f)));
      upsertFinishedGood(next);
    }
    setEditingFg(null);
    setDraftFg(null);
    setGenerated(false);
  }

  function deleteFg(id) {
    setFinishedGoods((fgs) => fgs.filter((f) => f.id !== id));
    setSelectedFgs((s) => { const { [id]: _, ...rest } = s; return rest; });
    setRunQty((c) => { const { [id]: _, ...rest } = c; return rest; });
    setRunLevel((c) => { const { [id]: _, ...rest } = c; return rest; });
    deleteFinishedGoodInStore(id);
    setGenerated(false);
  }

  // ── Saved PO handlers ──
  function savePOSnapshot() {
    const sel = selectedFgIds.filter((id) => (runQty[id] || 0) > 0);
    if (sel.length === 0) {
      alert('Nothing to save — select at least one finished good with a quantity.');
      return;
    }
    const suggested = loadedPOId
      ? savedPOs.find((p) => p.id === loadedPOId)?.name || ''
      : '';
    const name = prompt('Name this PO:', suggested);
    if (!name || !name.trim()) return;
    const fgSelections = sel.map((id) => ({
      fgId: id,
      qty: runQty[id] || 0,
      level: runLevel[id] || 'case',
    }));
    const existing = savedPOs.find((p) => p.name.trim().toLowerCase() === name.trim().toLowerCase());
    const po = {
      id: existing?.id || loadedPOId || `po-${Date.now()}`,
      name: name.trim(),
      createdAt: new Date().toISOString(),
      fgSelections,
    };
    setSavedPOs((list) => {
      const i = list.findIndex((p) => p.id === po.id);
      if (i >= 0) { const next = [...list]; next[i] = po; return next; }
      return [...list, po];
    });
    setLoadedPOId(po.id);
    upsertSavedPO(po);
  }

  function loadPO(id) {
    const po = savedPOs.find((p) => p.id === id);
    if (!po) return;
    const newSelected = {};
    const newQty = {};
    const newLevel = {};
    po.fgSelections.forEach((s) => {
      if (!finishedGoods.find((f) => f.id === s.fgId)) return; // skip if FG was deleted
      newSelected[s.fgId] = true;
      newQty[s.fgId] = s.qty;
      newLevel[s.fgId] = s.level || 'case';
    });
    setSelectedFgs(newSelected);
    setRunQty(newQty);
    setRunLevel(newLevel);
    setLoadedPOId(id);
    setGenerated(false);
  }

  function deleteSavedPO(id) {
    if (!confirm('Delete this saved PO?')) return;
    setSavedPOs((list) => list.filter((p) => p.id !== id));
    if (loadedPOId === id) setLoadedPOId(null);
    deleteSavedPOInStore(id);
  }

  // Aggregated PO data
  const poData = useMemo(() => {
    if (!generated) return null;

    // Expand each selected finished good's production qty into the 4-level
    // rollup (pallet / case / pack / unit), then into units-per-formula.
    // Units-per-formula → effective cases (units ÷ formula.unitsPerCase) →
    // the existing ingredient-needs pipeline.
    const fgRuns = []; // [{ fg, qty, level, totalPallets, totalCases, totalPacks, totalUnits, unitsByFormula }]
    const effectiveCases = {}; // formulaId → total effective cases across all FGs

    finishedGoods.forEach((fg) => {
      if (!selectedFgs[fg.id]) return;
      const qty = runQty[fg.id] || 0;
      if (qty <= 0) return;
      const level = runLevel[fg.id] || 'case';
      const packsPerCase = Math.max(1, fg.packsPerCase || 1);
      const casesPerPallet = Math.max(1, fg.casesPerPallet || 1);
      const unitsPerPack = (fg.pack || []).reduce((s, c) => s + (Number(c.units) || 0), 0);

      let totalPallets, totalCases, totalPacks, totalUnits;
      if (level === 'pallet') {
        totalPallets = qty;
        totalCases = qty * casesPerPallet;
        totalPacks = totalCases * packsPerCase;
        totalUnits = totalPacks * unitsPerPack;
      } else if (level === 'pack') {
        totalPacks = qty;
        totalUnits = qty * unitsPerPack;
        totalCases = totalPacks / packsPerCase;
        totalPallets = totalCases / casesPerPallet;
      } else {
        // default: case
        totalCases = qty;
        totalPacks = qty * packsPerCase;
        totalUnits = totalPacks * unitsPerPack;
        totalPallets = totalCases / casesPerPallet;
      }

      // Units of each formula contributed by this FG's run
      const unitsByFormula = {};
      (fg.pack || []).forEach((comp) => {
        if (!comp.formulaId || !(comp.units > 0)) return;
        const units = comp.units * totalPacks;
        unitsByFormula[comp.formulaId] = (unitsByFormula[comp.formulaId] || 0) + units;
        const f = formulas.find((x) => x.id === comp.formulaId);
        if (f) {
          const upc = f.unitsPerCase || 24;
          effectiveCases[f.id] = (effectiveCases[f.id] || 0) + units / upc;
        }
      });

      fgRuns.push({
        fg, qty, level,
        totalPallets, totalCases, totalPacks, totalUnits,
        unitsByFormula,
      });
    });

    if (fgRuns.length === 0) return null;

    const activeFormulas = Object.keys(effectiveCases)
      .map((id) => formulas.find((f) => f.id === id))
      .filter(Boolean);
    if (activeFormulas.length === 0) return null;

    // Build the aggregated ingredient map (shared MOQ across all FGs).
    const aggregated = {};
    let activeFormulaCount = 0;

    activeFormulas.forEach((formula) => {
      const cases = effectiveCases[formula.id] || 0;
      if (cases <= 0) return;
      activeFormulaCount++;
      const needs = calcIngredientNeeds(formula, cases, inventoryMap);

      needs.forEach((n) => {
        const k = ingKey(n);
        if (!aggregated[k]) {
          aggregated[k] = { ...n, totalAmount: 0, onHand: 0, formulaSet: new Set() };
        }
        aggregated[k].totalAmount += n.buyUnitAmount;
        if (n.onHandInBuyUnits > aggregated[k].onHand) {
          aggregated[k].onHand = n.onHandInBuyUnits;
        }
        aggregated[k].formulaSet.add(formula.id);
        if (n.pricePerBuyUnit > 0) aggregated[k].pricePerBuyUnit = n.pricePerBuyUnit;
        if (n.moq > 1) aggregated[k].moq = n.moq;
      });
    });

    // Per-finished-good cost rollup. Aggregate ingredient demand across the
    // formulas *inside* this FG BEFORE MOQ-rounding — otherwise a variety
    // pack triple-counts MOQ waste on ingredients shared across flavors
    // (each formula would round a shared ingredient up to its own MOQ).
    // Compute BOTH MOQ cost (what you purchase, rounded up) and non-MOQ
    // cost (what you actually consume: demand × price). Non-MOQ is the
    // right basis for unit economics; MOQ is the right basis for writing
    // the PO. Blended row below uses the shared-MOQ grand total across FGs.
    const fgCosts = fgRuns.map((run) => {
      const fgAggregated = {};
      Object.entries(run.unitsByFormula).forEach(([fId, units]) => {
        const f = formulas.find((x) => x.id === fId);
        if (!f) return;
        const cases = units / (f.unitsPerCase || 24);
        const needs = calcIngredientNeeds(f, cases, inventoryMap);
        needs.forEach((n) => {
          const k = ingKey(n);
          if (!fgAggregated[k]) {
            fgAggregated[k] = { ...n, totalAmount: 0 };
          }
          fgAggregated[k].totalAmount += n.buyUnitAmount;
          if (n.pricePerBuyUnit > 0) fgAggregated[k].pricePerBuyUnit = n.pricePerBuyUnit;
          if (n.moq > 1) fgAggregated[k].moq = n.moq;
        });
      });
      let moqCost = 0;
      let nonMoqCost = 0;
      Object.values(fgAggregated).forEach((ing) => {
        const moq = ing.moq || 1;
        const oqty = moq > 0
          ? Math.ceil(ing.totalAmount / moq) * moq
          : ing.totalAmount;
        moqCost += oqty * (ing.pricePerBuyUnit || 0);
        nonMoqCost += ing.totalAmount * (ing.pricePerBuyUnit || 0);
      });
      return {
        fgId: run.fg.id,
        name: run.fg.name,
        qty: run.qty,
        level: run.level,
        totalPallets: run.totalPallets,
        totalCases: run.totalCases,
        totalPacks: run.totalPacks,
        totalUnits: run.totalUnits,
        grossCost: moqCost,          // retained for back-compat with webapp render
        nonMoqCost,
        costPerUnit: run.totalUnits > 0 ? moqCost / run.totalUnits : 0,
        costPerPack: run.totalPacks > 0 ? moqCost / run.totalPacks : 0,
        costPerCase: run.totalCases > 0 ? moqCost / run.totalCases : 0,
        costPerPallet: run.totalPallets > 0 ? moqCost / run.totalPallets : 0,
        nonMoqPerUnit: run.totalUnits > 0 ? nonMoqCost / run.totalUnits : 0,
        nonMoqPerPack: run.totalPacks > 0 ? nonMoqCost / run.totalPacks : 0,
        nonMoqPerCase: run.totalCases > 0 ? nonMoqCost / run.totalCases : 0,
        nonMoqPerPallet: run.totalPallets > 0 ? nonMoqCost / run.totalPallets : 0,
      };
    });

    // Subtract on-hand (accumulated via max across formulas) from the aggregated
    // need once, then MOQ-round the remaining net need. Also compute the gross
    // figures (as if we had no stock) so the user can see what on-hand saved.
    const rows = Object.values(aggregated).map((item) => {
      const netNeeded = Math.max(0, item.totalAmount - item.onHand);
      const moq = item.moq || 1;
      const grossOrderQty = moq > 0
        ? Math.ceil(item.totalAmount / moq) * moq
        : item.totalAmount;
      const orderQty = netNeeded <= 0
        ? 0
        : (moq > 0 ? Math.ceil(netNeeded / moq) * moq : netNeeded);
      const price = item.pricePerBuyUnit || 0;
      const lineCost = orderQty * price;
      const grossLineCost = grossOrderQty * price;
      return {
        ...item,
        netNeeded,
        orderQty,
        grossOrderQty,
        lineCost,
        grossLineCost,
        savings: grossLineCost - lineCost,
        formulaCount: item.formulaSet.size,
      };
    });

    // Group by vendor
    const byVendor = {};
    rows.forEach((row) => {
      const vendor = row.vendor || 'No Vendor';
      if (!byVendor[vendor]) byVendor[vendor] = { rows: [], subtotal: 0, grossSubtotal: 0, savings: 0 };
      byVendor[vendor].rows.push(row);
      byVendor[vendor].subtotal += row.lineCost;
      byVendor[vendor].grossSubtotal += row.grossLineCost;
      byVendor[vendor].savings += row.savings;
    });

    const grandTotal = rows.reduce((sum, r) => sum + r.lineCost, 0);
    const grossGrandTotal = rows.reduce((sum, r) => sum + r.grossLineCost, 0);
    const totalSavings = grossGrandTotal - grandTotal;

    // Blended totals across all finished goods (shared MOQ cost / total qty
    // at each packaging level). Note pack counts and above are summed across
    // heterogeneous FGs — a mixed production plan may have different pack
    // sizes per FG, so "blended cost per pack" becomes a weighted average.
    const totalPalletsAll = fgCosts.reduce((s, f) => s + f.totalPallets, 0);
    const totalCasesAll = fgCosts.reduce((s, f) => s + f.totalCases, 0);
    const totalPacksAll = fgCosts.reduce((s, f) => s + f.totalPacks, 0);
    const totalUnitsAll = fgCosts.reduce((s, f) => s + f.totalUnits, 0);
    const blendedNet = {
      costPerUnit: totalUnitsAll > 0 ? grandTotal / totalUnitsAll : 0,
      costPerPack: totalPacksAll > 0 ? grandTotal / totalPacksAll : 0,
      costPerCase: totalCasesAll > 0 ? grandTotal / totalCasesAll : 0,
      costPerPallet: totalPalletsAll > 0 ? grandTotal / totalPalletsAll : 0,
    };
    const blendedGross = {
      costPerUnit: totalUnitsAll > 0 ? grossGrandTotal / totalUnitsAll : 0,
      costPerPack: totalPacksAll > 0 ? grossGrandTotal / totalPacksAll : 0,
      costPerCase: totalCasesAll > 0 ? grossGrandTotal / totalCasesAll : 0,
      costPerPallet: totalPalletsAll > 0 ? grossGrandTotal / totalPalletsAll : 0,
    };

    return {
      byVendor,
      grandTotal,
      grossGrandTotal,
      totalSavings,
      rowCount: rows.length,
      activeFormulaCount,
      fgCosts,
      totalPalletsAll,
      totalCasesAll,
      totalPacksAll,
      totalUnitsAll,
      blendedNet,
      blendedGross,
    };
  }, [generated, formulas, inventoryMap, finishedGoods, selectedFgs, runQty, runLevel]);

  function handleGenerate() {
    const valid = selectedFgIds.filter((id) => (runQty[id] || 0) > 0);
    if (valid.length === 0) {
      alert('Select at least one finished good with a production quantity > 0.');
      return;
    }
    setGenerated(true);
  }

  // The export is a live workbook: editable case counts on an Inputs sheet
  // drive formulas on a Detail sheet that feed SUMIF totals on a Summary
  // sheet. We pre-expand each selected finished good's production run into
  // effective per-formula case counts (units ÷ formula.unitsPerCase).
  function buildExportInput() {
    const eff = {};
    finishedGoods.forEach((fg) => {
      if (!selectedFgs[fg.id]) return;
      const qty = runQty[fg.id] || 0;
      if (qty <= 0) return;
      const level = runLevel[fg.id] || 'case';
      const packsPerCase = Math.max(1, fg.packsPerCase || 1);
      const casesPerPallet = Math.max(1, fg.casesPerPallet || 1);

      let totalPacks;
      if (level === 'pallet') totalPacks = qty * casesPerPallet * packsPerCase;
      else if (level === 'pack') totalPacks = qty;
      else totalPacks = qty * packsPerCase;

      (fg.pack || []).forEach((comp) => {
        if (!comp.formulaId || !(comp.units > 0)) return;
        const f = formulas.find((x) => x.id === comp.formulaId);
        if (!f) return;
        const upc = f.unitsPerCase || 24;
        const units = comp.units * totalPacks;
        eff[f.id] = (eff[f.id] || 0) + units / upc;
      });
    });
    const selectedFormulas = formulas.filter((f) => eff[f.id] > 0);
    return {
      selectedFormulas,
      inventoryMap,
      caseCounts: eff,
      // fgCosts drives the per-FG Cost/Unit/Pack/Case/Pallet table in the export.
      // Null-safe: export falls back to per-formula layout when absent.
      fgCosts: poData?.fgCosts || [],
    };
  }

  function exportToExcel() {
    if (!poData) return;
    const ok = exportConsolidatedPOToExcel(buildExportInput());
    if (!ok) alert('No formulas with valid case counts — nothing to export.');
  }

  function exportToGoogleSheets() {
    if (!poData) return;
    const ok = exportConsolidatedPOToGoogleSheets(buildExportInput());
    if (!ok) {
      alert('No formulas with valid case counts — nothing to export.');
      return;
    }
    // Nudge the user on the import step (popup may still be blocked).
    setTimeout(() => {
      alert(
        'Workbook downloaded.\n\n' +
        'In the Google Sheets tab that just opened:\n' +
        '  1. Click File → Import → Upload\n' +
        '  2. Drop the downloaded .xlsx\n' +
        '  3. Choose "Replace spreadsheet"\n\n' +
        'All formulas survive the import.'
      );
    }, 150);
  }

  if (loading) {
    return (
      <div style={{ padding: 40, textAlign: 'center', color: '#374151' }}>
        Loading formulas...
      </div>
    );
  }

  return (
    <div style={{ padding: '24px 32px', maxWidth: 1100, margin: '0 auto', color: '#111827' }}>
      <h1 style={{ fontSize: 22, fontWeight: 700, marginBottom: 4, color: '#111827' }}>Consolidated Purchase Order</h1>
      <p style={{ color: '#374151', marginBottom: 24, fontSize: 14 }}>
        Define finished goods (formula → pack → case → pallet), enter a production run, and get a PO with unit cost at every level.
      </p>

      {/* Finished Goods Library + Production Run */}
      <div style={{ background: '#ffffff', border: '1px solid #d1d5db', borderRadius: 10, padding: 20, marginBottom: 20 }}>
        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 14 }}>
          <h2 style={{ fontSize: 15, fontWeight: 600, color: '#111827', margin: 0 }}>
            Finished Goods
            <span style={{ fontSize: 12, fontWeight: 400, color: '#6b7280', marginLeft: 8 }}>
              — select what to produce and how many
            </span>
          </h2>
          {editingFg === null && (
            <button className="btn btn-primary" onClick={startNewFg} style={{ fontSize: 12, padding: '6px 14px' }}>
              + New Finished Good
            </button>
          )}
        </div>

        {formulas.length === 0 && (
          <div style={{ color: '#b45309', fontSize: 13, padding: '8px 0', fontStyle: 'italic' }}>
            No formulas available. Add formulas in the Formula Library before defining finished goods.
          </div>
        )}

        {finishedGoods.length === 0 && editingFg === null && formulas.length > 0 && (
          <div style={{ fontSize: 13, color: '#6b7280', fontStyle: 'italic', padding: '8px 0' }}>
            No finished goods yet. Click "+ New Finished Good" to define one. Single-flavor and variety packs both work — for single-flavor, just add one formula to the pack.
          </div>
        )}

        {/* FG list */}
        <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
          {finishedGoods.map((fg) => {
            const unitsPerPack = (fg.pack || []).reduce((s, c) => s + (Number(c.units) || 0), 0);
            const unitsPerCase = unitsPerPack * fg.packsPerCase;
            const unitsPerPallet = unitsPerCase * fg.casesPerPallet;
            const selectedCurrent = !!selectedFgs[fg.id];
            const level = runLevel[fg.id] || 'case';
            return (
              <div
                key={fg.id}
                style={{
                  padding: '10px 14px',
                  borderRadius: 8,
                  background: selectedCurrent ? '#f0fdf4' : '#f9fafb',
                  border: selectedCurrent ? '1px solid #16a34a' : '1px solid #e5e7eb',
                }}
              >
                <div style={{ display: 'flex', alignItems: 'center', gap: 12, flexWrap: 'wrap' }}>
                  <input
                    type="checkbox"
                    checked={selectedCurrent}
                    onChange={() => toggleFg(fg.id)}
                    style={{ width: 16, height: 16, cursor: 'pointer', flexShrink: 0 }}
                  />
                  <div style={{ flex: '1 1 240px', minWidth: 0 }}>
                    <div style={{ fontSize: 14, fontWeight: 600, color: '#111827' }}>{fg.name}</div>
                    <div style={{ fontSize: 11, color: '#6b7280', marginTop: 2 }}>
                      {unitsPerPack} units/pack · {fg.packsPerCase} packs/case · {fg.casesPerPallet} cases/pallet
                      <span style={{ marginLeft: 8, color: '#374151' }}>
                        ({unitsPerCase} units/case, {unitsPerPallet.toLocaleString()} units/pallet)
                      </span>
                    </div>
                    <div style={{ fontSize: 11, color: '#4b5563', marginTop: 2 }}>
                      Pack: {(fg.pack || []).map((c, i) => {
                        const f = formulas.find((x) => x.id === c.formulaId);
                        return (
                          <span key={i}>
                            {i > 0 && ' + '}
                            {c.units}× {f ? f.name : '(unknown formula)'}
                          </span>
                        );
                      })}
                    </div>
                  </div>
                  <button className="btn" onClick={() => startEditFg(fg.id)} style={{ fontSize: 11, padding: '2px 8px' }}>
                    Edit
                  </button>
                  <button
                    className="btn"
                    onClick={() => deleteFg(fg.id)}
                    style={{ fontSize: 11, padding: '2px 8px', color: '#b91c1c' }}
                  >
                    Delete
                  </button>
                  {selectedCurrent && (
                    <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
                      <input
                        type="number"
                        min="0"
                        value={runQty[fg.id] || ''}
                        onChange={(e) => setFgQty(fg.id, e.target.value)}
                        placeholder="0"
                        style={{
                          width: 90,
                          padding: '4px 8px',
                          fontSize: 14,
                          borderRadius: 5,
                          border: '1px solid #9ca3af',
                          background: '#ffffff',
                          color: '#111827',
                          textAlign: 'right',
                        }}
                      />
                      <select
                        value={level}
                        onChange={(e) => setFgLevel(fg.id, e.target.value)}
                        style={{
                          padding: '4px 8px',
                          fontSize: 13,
                          borderRadius: 5,
                          border: '1px solid #9ca3af',
                          background: '#ffffff',
                          color: '#111827',
                        }}
                      >
                        <option value="pallet">pallets</option>
                        <option value="case">cases</option>
                        <option value="pack">packs</option>
                      </select>
                    </div>
                  )}
                </div>
              </div>
            );
          })}
        </div>

        {/* Composer */}
        {editingFg !== null && draftFg && (
          <div
            style={{
              marginTop: 14,
              padding: 16,
              background: '#eff6ff',
              border: '1px solid #3b82f6',
              borderRadius: 8,
            }}
          >
            <div style={{ fontSize: 13, fontWeight: 700, color: '#1e40af', marginBottom: 12 }}>
              {editingFg === 'new' ? 'New Finished Good' : 'Edit Finished Good'}
            </div>
            <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
              <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
                <label style={{ fontSize: 13, color: '#374151', width: 120 }}>Name:</label>
                <input
                  type="text"
                  value={draftFg.name}
                  onChange={(e) => setDraftFg({ ...draftFg, name: e.target.value })}
                  placeholder="e.g. Happy Panda 12-pack Variety"
                  style={{
                    flex: 1,
                    padding: '6px 10px',
                    fontSize: 14,
                    borderRadius: 5,
                    border: '1px solid #9ca3af',
                    background: '#ffffff',
                    color: '#111827',
                  }}
                />
              </div>

              <div style={{ fontSize: 12, color: '#374151', fontWeight: 700, marginTop: 4 }}>
                Pack composition
                <span style={{ fontWeight: 400, color: '#6b7280', marginLeft: 6 }}>
                  — one row per flavor; units sum to total units per pack
                </span>
              </div>
              {draftFg.pack.map((comp, idx) => (
                <div key={idx} style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                  <select
                    value={comp.formulaId}
                    onChange={(e) => {
                      const next = [...draftFg.pack];
                      next[idx] = { ...next[idx], formulaId: e.target.value };
                      setDraftFg({ ...draftFg, pack: next });
                    }}
                    style={{
                      flex: 1,
                      padding: '6px 10px',
                      fontSize: 13,
                      borderRadius: 5,
                      border: '1px solid #9ca3af',
                      background: '#ffffff',
                      color: '#111827',
                    }}
                  >
                    <option value="">— Select formula —</option>
                    {formulas.map((f) => (
                      <option key={f.id} value={f.id}>
                        {f.name}{f.client ? ` (${f.client})` : ''}
                      </option>
                    ))}
                  </select>
                  <input
                    type="number"
                    min="0"
                    value={comp.units || ''}
                    onChange={(e) => {
                      const next = [...draftFg.pack];
                      next[idx] = { ...next[idx], units: parseInt(e.target.value, 10) || 0 };
                      setDraftFg({ ...draftFg, pack: next });
                    }}
                    placeholder="Units"
                    style={{
                      width: 80,
                      padding: '6px 10px',
                      fontSize: 13,
                      borderRadius: 5,
                      border: '1px solid #9ca3af',
                      background: '#ffffff',
                      color: '#111827',
                      textAlign: 'right',
                    }}
                  />
                  <span style={{ fontSize: 12, color: '#6b7280', width: 90 }}>units / pack</span>
                  <button
                    className="btn"
                    onClick={() => {
                      const next = draftFg.pack.filter((_, i) => i !== idx);
                      setDraftFg({
                        ...draftFg,
                        pack: next.length ? next : [{ formulaId: '', units: 0 }],
                      });
                    }}
                    style={{ fontSize: 11, padding: '2px 8px', color: '#b91c1c' }}
                  >
                    Remove
                  </button>
                </div>
              ))}
              <button
                className="btn"
                onClick={() =>
                  setDraftFg({
                    ...draftFg,
                    pack: [...draftFg.pack, { formulaId: '', units: 0 }],
                  })
                }
                style={{ fontSize: 12, padding: '4px 10px', alignSelf: 'flex-start' }}
              >
                + Add Flavor
              </button>

              <div style={{ display: 'flex', gap: 16, flexWrap: 'wrap', marginTop: 8 }}>
                <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                  <label style={{ fontSize: 13, color: '#374151' }}>Packs per case:</label>
                  <input
                    type="number"
                    min="1"
                    value={draftFg.packsPerCase || ''}
                    onChange={(e) => setDraftFg({ ...draftFg, packsPerCase: parseInt(e.target.value, 10) || 1 })}
                    style={{
                      width: 80,
                      padding: '6px 10px',
                      fontSize: 13,
                      borderRadius: 5,
                      border: '1px solid #9ca3af',
                      background: '#ffffff',
                      color: '#111827',
                      textAlign: 'right',
                    }}
                  />
                </div>
                <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                  <label style={{ fontSize: 13, color: '#374151' }}>Cases per pallet:</label>
                  <input
                    type="number"
                    min="1"
                    value={draftFg.casesPerPallet || ''}
                    onChange={(e) => setDraftFg({ ...draftFg, casesPerPallet: parseInt(e.target.value, 10) || 1 })}
                    style={{
                      width: 80,
                      padding: '6px 10px',
                      fontSize: 13,
                      borderRadius: 5,
                      border: '1px solid #9ca3af',
                      background: '#ffffff',
                      color: '#111827',
                      textAlign: 'right',
                    }}
                  />
                </div>
              </div>

              <div style={{ fontSize: 11, color: '#4338ca', fontStyle: 'italic', marginTop: 4 }}>
                Packaging cost (cans, labels, cartons) is not yet included — coming once Inventory is sorted. Current cost calculations reflect liquid ingredients only.
              </div>

              <div style={{ display: 'flex', gap: 8, marginTop: 4 }}>
                <button className="btn btn-primary" onClick={saveFg} style={{ fontSize: 13 }}>
                  Save Finished Good
                </button>
                <button className="btn" onClick={cancelFgEdit} style={{ fontSize: 13 }}>
                  Cancel
                </button>
              </div>
            </div>
          </div>
        )}

        <div style={{ marginTop: 18, display: 'flex', alignItems: 'center', gap: 12, paddingTop: 16, borderTop: '1px solid #e5e7eb', flexWrap: 'wrap' }}>
          <button
            className="btn btn-primary"
            onClick={handleGenerate}
            disabled={selectedFgIds.length === 0}
            style={{ minWidth: 140 }}
          >
            Generate PO
          </button>
          {selectedFgIds.length > 0 && (
            <span style={{ fontSize: 13, color: '#374151' }}>
              {selectedFgIds.length} finished good{selectedFgIds.length !== 1 ? 's' : ''} selected
            </span>
          )}

          <div style={{ marginLeft: 'auto', display: 'flex', alignItems: 'center', gap: 8 }}>
            {savedPOs.length > 0 && (
              <select
                value={loadedPOId || ''}
                onChange={(e) => {
                  if (e.target.value) loadPO(e.target.value);
                  else {
                    setLoadedPOId(null);
                    setSelectedFgs({});
                    setRunQty({});
                  }
                }}
                style={{
                  padding: '6px 10px',
                  fontSize: 13,
                  borderRadius: 5,
                  border: '1px solid #9ca3af',
                  background: '#ffffff',
                  color: '#111827',
                }}
              >
                <option value="">— Load saved PO —</option>
                {savedPOs.map((p) => (
                  <option key={p.id} value={p.id}>{p.name}</option>
                ))}
              </select>
            )}
            <button className="btn" onClick={savePOSnapshot} style={{ fontSize: 13 }}>
              {loadedPOId ? 'Save PO (update)' : 'Save PO'}
            </button>
            {loadedPOId && (
              <button
                className="btn"
                onClick={() => deleteSavedPO(loadedPOId)}
                style={{ fontSize: 13, color: '#b91c1c' }}
              >
                Delete
              </button>
            )}
          </div>
        </div>
      </div>

      {/* Results */}
      {generated && poData && (
        <div>
          {/* Formula summary */}
          <div style={{ background: '#ffffff', border: '1px solid #d1d5db', borderRadius: 10, padding: 16, marginBottom: 16 }}>
            <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 10 }}>
              <h2 style={{ fontSize: 15, fontWeight: 600, color: '#111827' }}>PO Summary</h2>
              <div style={{ display: 'flex', gap: 8 }}>
                <button
                  className="btn"
                  onClick={exportToExcel}
                  style={{ fontSize: 13 }}
                  title="Download a fully live workbook — edit case counts in the Inputs sheet and everything recalculates."
                >
                  Export Excel
                </button>
                <button
                  className="btn"
                  onClick={exportToGoogleSheets}
                  style={{ fontSize: 13 }}
                  title="Download the .xlsx and open Google Sheets so you can File → Import → Upload."
                >
                  Open in Google Sheets
                </button>
              </div>
            </div>
            <div style={{ display: 'flex', gap: 16, flexWrap: 'wrap', marginBottom: 10 }}>
              {poData.fgCosts.map((fc, i) => (
                <div key={i} style={{ background: '#eff6ff', border: '1px solid #bfdbfe', borderRadius: 6, padding: '6px 12px', fontSize: 13, color: '#1e40af' }}>
                  <strong>{fc.name}</strong>
                  <span style={{ marginLeft: 8, color: '#1e40af' }}>
                    {fc.qty.toLocaleString()} {fc.level}{fc.qty !== 1 ? 's' : ''}
                  </span>
                  <span style={{ marginLeft: 6, fontSize: 11, color: '#4f46e5' }}>
                    → {fc.totalUnits.toLocaleString(undefined, { maximumFractionDigits: 0 })} units
                  </span>
                </div>
              ))}
            </div>
            <div style={{ fontSize: 14, color: '#374151' }}>
              {poData.rowCount} unique ingredient{poData.rowCount !== 1 ? 's' : ''} across {Object.keys(poData.byVendor).length} supplier{Object.keys(poData.byVendor).length !== 1 ? 's' : ''}
            </div>
          </div>

          {/* Grouped by supplier */}
          {Object.entries(poData.byVendor).map(([vendor, group]) => (
            <div
              key={vendor}
              style={{
                background: '#ffffff',
                border: '1px solid #d1d5db',
                borderRadius: 10,
                marginBottom: 16,
                overflow: 'hidden',
              }}
            >
              <div style={{
                padding: '12px 16px',
                background: '#1f2937',
                borderBottom: '1px solid #374151',
                display: 'flex',
                alignItems: 'center',
                justifyContent: 'space-between',
              }}>
                <span style={{ fontWeight: 600, fontSize: 15, color: '#ffffff' }}>{vendor}</span>
                <span style={{ fontSize: 13, color: '#d1d5db', display: 'flex', gap: 16 }}>
                  <span>Net: <strong style={{ color: '#ffffff' }}>${group.subtotal.toFixed(2)}</strong></span>
                  <span>Gross: <strong style={{ color: '#ffffff' }}>${group.grossSubtotal.toFixed(2)}</strong></span>
                  {group.savings > 0 && (
                    <span>Savings: <strong style={{ color: '#86efac' }}>${group.savings.toFixed(2)}</strong></span>
                  )}
                </span>
              </div>
              <div style={{ overflowX: 'auto' }}>
                <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 13 }}>
                  <thead>
                    <tr style={{ background: '#f3f4f6', borderBottom: '2px solid #d1d5db' }}>
                      {['Ingredient', '# Formulas', 'SKU', 'Total Needed', 'On Hand', 'Net Needed', 'Unit', 'MOQ', 'Order Qty', 'Price/Unit', 'Line Total (Net)', 'Gross Total', 'Savings'].map((h) => (
                        <th
                          key={h}
                          style={{
                            padding: '8px 12px',
                            textAlign: h === 'Ingredient' ? 'left' : 'right',
                            fontWeight: 700,
                            color: '#111827',
                            whiteSpace: 'nowrap',
                          }}
                        >
                          {h}
                        </th>
                      ))}
                    </tr>
                  </thead>
                  <tbody>
                    {group.rows.map((row, i) => {
                      const moqAdjusted = row.orderQty > row.netNeeded && row.netNeeded > 0;
                      return (
                        <tr
                          key={i}
                          style={{
                            borderBottom: '1px solid #e5e7eb',
                            background: i % 2 === 0 ? '#ffffff' : '#f9fafb',
                          }}
                        >
                          <td style={{ padding: '9px 12px', fontWeight: 500, color: '#111827' }}>{row.name}</td>
                          <td style={{ padding: '9px 12px', textAlign: 'right', color: '#374151', fontFamily: 'monospace' }}>
                            <span
                              style={{
                                background: row.formulaCount === poData.activeFormulaCount ? '#dcfce7' : '#fef9c3',
                                color: row.formulaCount === poData.activeFormulaCount ? '#15803d' : '#854d0e',
                                borderRadius: 4,
                                padding: '2px 6px',
                                fontSize: 12,
                                fontWeight: 600,
                              }}
                            >
                              {row.formulaCount}/{poData.activeFormulaCount}
                            </span>
                          </td>
                          <td style={{ padding: '9px 12px', textAlign: 'right', color: '#374151' }}>{row.sku || '—'}</td>
                          <td style={{ padding: '9px 12px', textAlign: 'right', fontFamily: 'monospace', color: '#111827' }}>
                            {row.totalAmount.toFixed(2)}
                          </td>
                          <td style={{ padding: '9px 12px', textAlign: 'right', fontFamily: 'monospace', color: row.onHand > 0 ? '#15803d' : '#9ca3af' }}>
                            {row.onHand > 0 ? row.onHand.toFixed(2) : '—'}
                          </td>
                          <td style={{ padding: '9px 12px', textAlign: 'right', fontFamily: 'monospace', color: row.netNeeded <= 0 ? '#15803d' : '#111827', fontWeight: row.netNeeded <= 0 ? 600 : 400 }}>
                            {row.netNeeded <= 0 ? 'Covered' : row.netNeeded.toFixed(2)}
                          </td>
                          <td style={{ padding: '9px 12px', textAlign: 'right', color: '#374151' }}>{row.buyUnit}</td>
                          <td style={{ padding: '9px 12px', textAlign: 'right', color: '#374151' }}>{row.moq}</td>
                          <td style={{ padding: '9px 12px', textAlign: 'right', fontFamily: 'monospace', color: '#111827' }}>
                            <span style={{ color: moqAdjusted ? '#b45309' : '#111827' }}>
                              {row.orderQty.toFixed(2)}
                            </span>
                            {moqAdjusted && (
                              <span style={{ fontSize: 10, color: '#b45309', marginLeft: 4, fontWeight: 600 }} title="MOQ adjusted">MOQ</span>
                            )}
                          </td>
                          <td style={{ padding: '9px 12px', textAlign: 'right', color: '#374151', fontFamily: 'monospace' }}>
                            {row.pricePerBuyUnit > 0 ? '$' + row.pricePerBuyUnit.toFixed(4) : '—'}
                          </td>
                          <td style={{ padding: '9px 12px', textAlign: 'right', fontFamily: 'monospace', fontWeight: 600, color: '#111827' }}>
                            {row.lineCost > 0 ? '$' + row.lineCost.toFixed(2) : '—'}
                          </td>
                          <td style={{ padding: '9px 12px', textAlign: 'right', fontFamily: 'monospace', color: '#6b7280' }}>
                            {row.grossLineCost > 0 ? '$' + row.grossLineCost.toFixed(2) : '—'}
                          </td>
                          <td style={{ padding: '9px 12px', textAlign: 'right', fontFamily: 'monospace', color: row.savings > 0 ? '#15803d' : '#9ca3af', fontWeight: row.savings > 0 ? 600 : 400 }}>
                            {row.savings > 0 ? '$' + row.savings.toFixed(2) : '—'}
                          </td>
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
              </div>
            </div>
          ))}

          {/* Per-finished-good cost rollup — unit / pack / case / pallet. */}
          {poData.fgCosts.length > 0 && (
            <div style={{
              background: '#ffffff',
              border: '1px solid #d1d5db',
              borderRadius: 10,
              marginBottom: 16,
              overflow: 'hidden',
            }}>
              <div style={{
                padding: '12px 16px',
                background: '#064e3b',
                borderBottom: '1px solid #065f46',
                display: 'flex',
                alignItems: 'center',
                justifyContent: 'space-between',
              }}>
                <span style={{ fontWeight: 600, fontSize: 15, color: '#ffffff' }}>Cost Per Unit / Pack / Case / Pallet</span>
                <span style={{ fontSize: 12, color: '#6ee7b7', fontStyle: 'italic' }}>
                  Liquid ingredients only (packaging coming soon)
                </span>
              </div>
              <div style={{ overflowX: 'auto' }}>
                <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 13 }}>
                  <thead>
                    <tr style={{ background: '#f3f4f6', borderBottom: '2px solid #d1d5db' }}>
                      {['Finished Good', 'Units', 'Packs', 'Cases', 'Pallets', 'Ingredient Cost', 'Cost/Unit', 'Cost/Pack', 'Cost/Case', 'Cost/Pallet'].map((h) => (
                        <th
                          key={h}
                          style={{
                            padding: '8px 12px',
                            textAlign: h === 'Finished Good' ? 'left' : 'right',
                            fontWeight: 700,
                            color: '#111827',
                            whiteSpace: 'nowrap',
                          }}
                        >
                          {h}
                        </th>
                      ))}
                    </tr>
                  </thead>
                  <tbody>
                    {poData.fgCosts.map((fc, i) => (
                      <tr
                        key={i}
                        style={{
                          borderBottom: '1px solid #e5e7eb',
                          background: i % 2 === 0 ? '#ffffff' : '#f9fafb',
                        }}
                      >
                        <td style={{ padding: '9px 12px', fontWeight: 500, color: '#111827' }}>{fc.name}</td>
                        <td style={{ padding: '9px 12px', textAlign: 'right', color: '#374151', fontFamily: 'monospace' }}>
                          {fc.totalUnits.toLocaleString(undefined, { maximumFractionDigits: 0 })}
                        </td>
                        <td style={{ padding: '9px 12px', textAlign: 'right', color: '#374151', fontFamily: 'monospace' }}>
                          {fc.totalPacks.toLocaleString(undefined, { maximumFractionDigits: 2 })}
                        </td>
                        <td style={{ padding: '9px 12px', textAlign: 'right', color: '#374151', fontFamily: 'monospace' }}>
                          {fc.totalCases.toLocaleString(undefined, { maximumFractionDigits: 2 })}
                        </td>
                        <td style={{ padding: '9px 12px', textAlign: 'right', color: '#374151', fontFamily: 'monospace' }}>
                          {fc.totalPallets.toLocaleString(undefined, { maximumFractionDigits: 2 })}
                        </td>
                        <td style={{ padding: '9px 12px', textAlign: 'right', fontFamily: 'monospace', color: '#374151' }}>
                          {fc.grossCost > 0 ? '$' + fc.grossCost.toFixed(2) : '—'}
                        </td>
                        <td style={{ padding: '9px 12px', textAlign: 'right', fontFamily: 'monospace', fontWeight: 600, color: '#065f46' }}>
                          {fc.costPerUnit > 0 ? '$' + fc.costPerUnit.toFixed(4) : '—'}
                        </td>
                        <td style={{ padding: '9px 12px', textAlign: 'right', fontFamily: 'monospace', fontWeight: 600, color: '#065f46' }}>
                          {fc.costPerPack > 0 ? '$' + fc.costPerPack.toFixed(2) : '—'}
                        </td>
                        <td style={{ padding: '9px 12px', textAlign: 'right', fontFamily: 'monospace', fontWeight: 600, color: '#065f46' }}>
                          {fc.costPerCase > 0 ? '$' + fc.costPerCase.toFixed(2) : '—'}
                        </td>
                        <td style={{ padding: '9px 12px', textAlign: 'right', fontFamily: 'monospace', fontWeight: 600, color: '#065f46' }}>
                          {fc.costPerPallet > 0 ? '$' + fc.costPerPallet.toFixed(2) : '—'}
                        </td>
                      </tr>
                    ))}

                    {/* Blended rows (only meaningful for multi-FG runs) */}
                    {poData.fgCosts.length > 1 && (
                      <>
                        <tr style={{ background: '#f0fdf4', borderTop: '2px solid #16a34a' }}>
                          <td style={{ padding: '9px 12px', fontWeight: 700, color: '#111827' }}>
                            Blended Net
                            <span style={{ fontSize: 11, fontWeight: 400, color: '#6b7280', marginLeft: 6 }}>
                              (shared MOQ, after on-hand)
                            </span>
                          </td>
                          <td style={{ padding: '9px 12px', textAlign: 'right', fontFamily: 'monospace', fontWeight: 600, color: '#374151' }}>
                            {poData.totalUnitsAll.toLocaleString(undefined, { maximumFractionDigits: 0 })}
                          </td>
                          <td style={{ padding: '9px 12px', textAlign: 'right', fontFamily: 'monospace', color: '#374151' }}>
                            {poData.totalPacksAll.toLocaleString(undefined, { maximumFractionDigits: 2 })}
                          </td>
                          <td style={{ padding: '9px 12px', textAlign: 'right', fontFamily: 'monospace', color: '#374151' }}>
                            {poData.totalCasesAll.toLocaleString(undefined, { maximumFractionDigits: 2 })}
                          </td>
                          <td style={{ padding: '9px 12px', textAlign: 'right', fontFamily: 'monospace', color: '#374151' }}>
                            {poData.totalPalletsAll.toLocaleString(undefined, { maximumFractionDigits: 2 })}
                          </td>
                          <td style={{ padding: '9px 12px', textAlign: 'right', fontFamily: 'monospace', fontWeight: 600, color: '#374151' }}>
                            ${poData.grandTotal.toFixed(2)}
                          </td>
                          <td style={{ padding: '9px 12px', textAlign: 'right', fontFamily: 'monospace', fontWeight: 700, color: '#15803d' }}>
                            {poData.blendedNet.costPerUnit > 0 ? '$' + poData.blendedNet.costPerUnit.toFixed(4) : '—'}
                          </td>
                          <td style={{ padding: '9px 12px', textAlign: 'right', fontFamily: 'monospace', fontWeight: 700, color: '#15803d' }}>
                            {poData.blendedNet.costPerPack > 0 ? '$' + poData.blendedNet.costPerPack.toFixed(2) : '—'}
                          </td>
                          <td style={{ padding: '9px 12px', textAlign: 'right', fontFamily: 'monospace', fontWeight: 700, color: '#15803d' }}>
                            {poData.blendedNet.costPerCase > 0 ? '$' + poData.blendedNet.costPerCase.toFixed(2) : '—'}
                          </td>
                          <td style={{ padding: '9px 12px', textAlign: 'right', fontFamily: 'monospace', fontWeight: 700, color: '#15803d' }}>
                            {poData.blendedNet.costPerPallet > 0 ? '$' + poData.blendedNet.costPerPallet.toFixed(2) : '—'}
                          </td>
                        </tr>
                        <tr style={{ background: '#fafafa' }}>
                          <td style={{ padding: '9px 12px', fontWeight: 600, color: '#374151' }}>
                            Blended Gross
                            <span style={{ fontSize: 11, fontWeight: 400, color: '#6b7280', marginLeft: 6 }}>
                              (if no on-hand stock)
                            </span>
                          </td>
                          <td colSpan={4}></td>
                          <td style={{ padding: '9px 12px', textAlign: 'right', fontFamily: 'monospace', color: '#6b7280' }}>
                            ${poData.grossGrandTotal.toFixed(2)}
                          </td>
                          <td style={{ padding: '9px 12px', textAlign: 'right', fontFamily: 'monospace', color: '#6b7280' }}>
                            {poData.blendedGross.costPerUnit > 0 ? '$' + poData.blendedGross.costPerUnit.toFixed(4) : '—'}
                          </td>
                          <td style={{ padding: '9px 12px', textAlign: 'right', fontFamily: 'monospace', color: '#6b7280' }}>
                            {poData.blendedGross.costPerPack > 0 ? '$' + poData.blendedGross.costPerPack.toFixed(2) : '—'}
                          </td>
                          <td style={{ padding: '9px 12px', textAlign: 'right', fontFamily: 'monospace', color: '#6b7280' }}>
                            {poData.blendedGross.costPerCase > 0 ? '$' + poData.blendedGross.costPerCase.toFixed(2) : '—'}
                          </td>
                          <td style={{ padding: '9px 12px', textAlign: 'right', fontFamily: 'monospace', color: '#6b7280' }}>
                            {poData.blendedGross.costPerPallet > 0 ? '$' + poData.blendedGross.costPerPallet.toFixed(2) : '—'}
                          </td>
                        </tr>
                        {poData.totalSavings > 0 && (
                          <tr style={{ background: '#ecfdf5' }}>
                            <td style={{ padding: '9px 12px', fontWeight: 600, color: '#065f46' }}>
                              Savings from On-Hand
                            </td>
                            <td colSpan={4}></td>
                            <td style={{ padding: '9px 12px', textAlign: 'right', fontFamily: 'monospace', fontWeight: 700, color: '#15803d' }}>
                              ${poData.totalSavings.toFixed(2)}
                            </td>
                            <td style={{ padding: '9px 12px', textAlign: 'right', fontFamily: 'monospace', fontWeight: 700, color: '#15803d' }}>
                              {poData.blendedGross.costPerUnit - poData.blendedNet.costPerUnit > 0
                                ? '$' + (poData.blendedGross.costPerUnit - poData.blendedNet.costPerUnit).toFixed(4) : '—'}
                            </td>
                            <td style={{ padding: '9px 12px', textAlign: 'right', fontFamily: 'monospace', fontWeight: 700, color: '#15803d' }}>
                              {poData.blendedGross.costPerPack - poData.blendedNet.costPerPack > 0
                                ? '$' + (poData.blendedGross.costPerPack - poData.blendedNet.costPerPack).toFixed(2) : '—'}
                            </td>
                            <td style={{ padding: '9px 12px', textAlign: 'right', fontFamily: 'monospace', fontWeight: 700, color: '#15803d' }}>
                              {poData.blendedGross.costPerCase - poData.blendedNet.costPerCase > 0
                                ? '$' + (poData.blendedGross.costPerCase - poData.blendedNet.costPerCase).toFixed(2) : '—'}
                            </td>
                            <td style={{ padding: '9px 12px', textAlign: 'right', fontFamily: 'monospace', fontWeight: 700, color: '#15803d' }}>
                              {poData.blendedGross.costPerPallet - poData.blendedNet.costPerPallet > 0
                                ? '$' + (poData.blendedGross.costPerPallet - poData.blendedNet.costPerPallet).toFixed(2) : '—'}
                            </td>
                          </tr>
                        )}
                      </>
                    )}
                  </tbody>
                </table>
              </div>
            </div>
          )}

          {/* Grand total — Gross / Savings / Net stacked so the buyer can see
              at a glance what existing stock saved them on this run. */}
          <div style={{
            background: '#ffffff',
            border: '2px solid #16a34a',
            borderRadius: 10,
            padding: '16px 20px',
            display: 'flex',
            flexDirection: 'column',
            gap: 6,
          }}>
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
              <span style={{ fontSize: 14, color: '#6b7280' }}>Gross Total (if no stock)</span>
              <span style={{ fontSize: 16, color: '#6b7280', fontFamily: 'monospace' }}>
                ${poData.grossGrandTotal.toFixed(2)}
              </span>
            </div>
            {poData.totalSavings > 0 && (
              <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
                <span style={{ fontSize: 14, color: '#065f46' }}>Savings from On-Hand</span>
                <span style={{ fontSize: 16, color: '#15803d', fontFamily: 'monospace', fontWeight: 600 }}>
                  −${poData.totalSavings.toFixed(2)}
                </span>
              </div>
            )}
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', borderTop: '1px solid #d1d5db', paddingTop: 8, marginTop: 2 }}>
              <span style={{ fontWeight: 700, fontSize: 16, color: '#111827' }}>Grand Total (Net)</span>
              <span style={{ fontSize: 22, fontWeight: 700, color: '#15803d', fontFamily: 'monospace' }}>
                ${poData.grandTotal.toFixed(2)}
              </span>
            </div>
          </div>
        </div>
      )}

      {generated && !poData && (
        <div style={{ padding: 24, textAlign: 'center', color: '#374151', background: '#f9fafb', borderRadius: 10, border: '1px solid #d1d5db' }}>
          No formulas with valid case counts selected.
        </div>
      )}
    </div>
  );
}
