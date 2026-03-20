import { useState, useMemo, useEffect } from 'react';
import { getCurrentBatch, getFormulas, getRuns, saveRun, deleteRun } from '../data/store';
import { getProducts, lookupPrice, NEW_ART_PREP_FEE } from '../data/drayhorsePricing';
import { exportCoPackingToExcel } from '../utils/exportExcel';

// ── Constants ──

const PACK_SIZES = [4, 6, 8, 12];

const PRINT_TYPES = [
  { value: 'digital', label: 'Digital Print' },
  { value: 'sleeve', label: 'Shrink Sleeve' },
  { value: 'traditional', label: 'Traditional (Litho)' },
];

const PACKAGING_CATEGORIES = [
  { value: 'cans', label: 'Cans' },
  { value: 'ends', label: 'Ends / Lids' },
  { value: 'cases', label: 'Cases / Trays' },
  { value: 'carriers', label: 'Carriers' },
  { value: 'pallets', label: 'Pallets' },
  { value: 'wrap', label: 'Wrap / Film' },
  { value: 'other', label: 'Other' },
];

const FEE_TYPES = [
  { value: 'per-unit', label: 'Per Unit' },
  { value: 'per-pack', label: 'Per Pack' },
  { value: 'per-case', label: 'Per Case' },
  { value: 'per-pallet', label: 'Per Pallet' },
  { value: 'per-batch', label: 'Per Batch' },
  { value: 'per-proof-gallon', label: 'Per Proof Gal' },
  { value: 'fixed', label: 'Fixed' },
];

const categoryColors = {
  cans: { bg: '#dbeafe', color: '#1e40af' },
  ends: { bg: '#fce7f3', color: '#9d174d' },
  cases: { bg: '#d1fae5', color: '#065f46' },
  carriers: { bg: '#fef3c7', color: '#92400e' },
  pallets: { bg: '#e0e7ff', color: '#3730a3' },
  wrap: { bg: '#f3e8ff', color: '#6b21a8' },
  other: { bg: '#f3f4f6', color: '#374151' },
};

const feeTypeColors = {
  'per-unit': { bg: '#e0f2fe', color: '#0369a1' },
  'per-pack': { bg: '#fce7f3', color: '#be185d' },
  'per-case': { bg: '#dcfce7', color: '#15803d' },
  'per-pallet': { bg: '#fef9c3', color: '#a16207' },
  'per-batch': { bg: '#ede9fe', color: '#6d28d9' },
  'per-proof-gallon': { bg: '#ffe4e6', color: '#be123c' },
  'fixed': { bg: '#f3f4f6', color: '#374151' },
};

const dragHandleStyle = {
  cursor: 'grab', color: '#cbd5e1', fontSize: 16, padding: '0 4px', userSelect: 'none',
};

const chipStyle = (colors) => ({
  background: colors.bg,
  color: colors.color,
  fontWeight: 600,
  border: 'none',
  borderRadius: 4,
  padding: '4px 8px',
  fontSize: 12,
});

// ── Default line items with standard rate card ──

function makeDefaultPackaging() {
  return [
    { id: 'pkg-can-print', name: 'Can Printing', category: 'cans', printType: 'sleeve', feeType: 'per-unit', rate: 0.12, qty: 0, qtyManual: false },
    { id: 'pkg-can-ends', name: 'Can Ends (Silver)', category: 'ends', feeType: 'per-unit', rate: 0.035, qty: 0, qtyManual: false },
    { id: 'pkg-trays', name: 'Trays', category: 'cases', feeType: 'per-case', rate: 1.10, qty: 0, qtyManual: false },
    { id: 'pkg-carriers', name: 'PakTech Carriers', category: 'carriers', feeType: 'per-pack', rate: 0.12, qty: 0, qtyManual: false },
    { id: 'pkg-wrap', name: 'Stretch Wrap', category: 'wrap', feeType: 'per-pallet', rate: 4.00, qty: 0, qtyManual: false },
  ];
}

function makeDefaultTolling() {
  return [
    { id: 'toll-production', name: 'Production (Canning Line)', feeType: 'per-unit', rate: 0.08, qty: 0, qtyManual: false },
    { id: 'toll-case-pack', name: 'Case & Carton Packing', feeType: 'per-case', rate: 0.75, qty: 0, qtyManual: false },
    { id: 'toll-variety', name: 'Variety Pack Assembly', feeType: 'per-case', rate: 0.35, qty: 0, qtyManual: false },
  ];
}

function makeDefaultBOM() {
  return [
    { id: 'bom-lab', name: 'Lab Testing', feeType: 'per-batch', rate: 750, qty: 0, qtyManual: false },
    { id: 'bom-pa-letter', name: 'PA Letter (Prior Approval)', feeType: 'fixed', rate: 200, qty: 0, qtyManual: false },
    { id: 'bom-freight-out', name: 'Freight \u2014 Outbound Finished Goods', feeType: 'per-pallet', rate: 200, qty: 0, qtyManual: false },
    { id: 'bom-freight-in', name: 'Freight \u2014 Inbound Raw Materials', feeType: 'per-pallet', rate: 175, qty: 0, qtyManual: false },
  ];
}

function makeDefaultTaxes() {
  return [
    { id: 'tax-deposit', name: 'State Can Deposit', feeType: 'per-unit', rate: 0.05, qty: 0, qtyManual: false },
    { id: 'tax-excise', name: 'Federal Excise Tax', feeType: 'per-proof-gallon', rate: 13.50, qty: 0, qtyManual: false },
    { id: 'tax-cola', name: 'COLA Registration & Handling', feeType: 'fixed', rate: 750, qty: 0, qtyManual: false },
    { id: 'tax-import', name: 'Importation Fees', feeType: 'fixed', rate: 0, qty: 0, qtyManual: false },
    { id: 'tax-other', name: 'Other Taxes & Fees', feeType: 'fixed', rate: 0, qty: 0, qtyManual: false },
  ];
}

// ── Ingredient cost from formula ──

const conversions = {
  gal_L: 3.78541, L_gal: 0.264172, gal_oz: 128, oz_gal: 0.0078125,
  L_oz: 33.814, oz_L: 0.0295735, lbs_kg: 0.453592, kg_lbs: 2.20462,
};

function convertUnit(value, from, to) {
  if (from === to) return value;
  const key = `${from}_${to}`;
  if (conversions[key]) return value * conversions[key];
  const rev = `${to}_${from}`;
  if (conversions[rev]) return value / conversions[rev];
  return value;
}

function calcFormulaIngredientCostPerCan(formula, batchSizeGal, fillOz) {
  if (!formula?.ingredients?.length || !fillOz || !batchSizeGal) return null;
  const baseYield = formula.baseYield || 100;
  const scaleFactor = batchSizeGal / baseYield;

  let totalCost = 0;
  for (const ing of formula.ingredients) {
    const scaledRecipe = (ing.recipeAmount || 0) * scaleFactor;
    let buyAmt = scaledRecipe;
    if (ing.recipeUnit && ing.buyUnit && ing.recipeUnit !== ing.buyUnit) {
      buyAmt = convertUnit(scaledRecipe, ing.recipeUnit, ing.buyUnit);
    }
    const orderQty = Math.ceil(buyAmt / (ing.moq || 1)) * (ing.moq || 1);
    totalCost += orderQty * (ing.pricePerBuyUnit || 0);
  }

  const cans = Math.floor((batchSizeGal * 128) / fillOz);
  return cans > 0 ? totalCost / cans : null;
}

// ── Auto-qty logic ──

function getFeeAutoQty(feeType, counts) {
  if (feeType === 'per-unit') return counts.totalUnits;
  if (feeType === 'per-pack') return counts.totalPacks;
  if (feeType === 'per-case') return counts.totalCases;
  if (feeType === 'per-pallet') return counts.totalPallets;
  if (feeType === 'per-proof-gallon') return counts.proofGallons;
  if (feeType === 'per-batch') return counts.flavorCount || 1;
  if (feeType === 'fixed') return 1;
  return 0;
}

// ── Component ──

export default function CoPackingCalculator() {
  // Run config
  const [fillVolume, setFillVolume] = useState(12);
  const [fillVolumeUnit, setFillVolumeUnit] = useState('oz');
  const [packSize, setPackSize] = useState(4);
  const [carrierType, setCarrierType] = useState('paktech');
  const [abv, setAbv] = useState(0);
  const [unitsPerCase, setUnitsPerCase] = useState(24);
  const [casesPerPallet, setCasesPerPallet] = useState(80);
  const [palletsPerTruck, setPalletsPerTruck] = useState(20);
  const [cansPerMinute, setCansPerMinute] = useState(400);

  // Available formulas from the library
  const [allFormulas, setAllFormulas] = useState([]);
  useEffect(() => {
    const refresh = () => setAllFormulas(getFormulas());
    refresh();
    window.addEventListener('comanufacturing:datachange', refresh);
    return () => window.removeEventListener('comanufacturing:datachange', refresh);
  }, []);

  // Flavors in this run (each SKU has its own ingredient + stabilization cost)
  // cases = number of cases to produce for this SKU
  const [flavors, setFlavors] = useState([
    { id: 'flv-1', formulaId: '', name: '', cases: 100, batchingFee: 0, ingredientCost: 0.25, stabilizationCost: 0.02, ingredientCostAuto: false },
  ]);

  // Drayhorse carton pricing
  const [cartonProduct, setCartonProduct] = useState('sleek-4pk');
  const [skuCount, setSkuCount] = useState(1);
  const [includeNewArt, setIncludeNewArt] = useState(false);

  // Line items
  const [packagingItems, setPackagingItems] = useState(makeDefaultPackaging);
  const [tollingItems, setTollingItems] = useState(makeDefaultTolling);
  const [bomItems, setBomItems] = useState(makeDefaultBOM);
  const [taxItems, setTaxItems] = useState(makeDefaultTaxes);

  // Run management
  const [savedRuns, setSavedRuns] = useState([]);
  const [currentRunId, setCurrentRunId] = useState(null);
  const [runName, setRunName] = useState('');
  const [runClient, setRunClient] = useState('');
  useEffect(() => {
    const refresh = () => setSavedRuns(getRuns());
    refresh();
    window.addEventListener('comanufacturing:datachange', refresh);
    return () => window.removeEventListener('comanufacturing:datachange', refresh);
  }, []);

  // Load run from URL query param or batch on mount
  useEffect(() => {
    const params = new URLSearchParams(window.location.search);
    const runId = params.get('run');
    if (runId) {
      const allRuns = getRuns();
      const run = allRuns.find((r) => r.id === runId);
      if (run) { handleLoadRun(runId); return; }
    }
    const batch = getCurrentBatch();
    if (batch) {
      setFlavors((p) => p.map((f, i) => {
        if (i !== 0) return f;
        return { ...f, formulaId: batch.formulaId || '', name: batch.formulaName || f.name, cases: batch.totalUnits ? Math.ceil(batch.totalUnits / unitsPerCase) : f.cases };
      }));
    }
  }, []);

  // Sync Drayhorse product with pack size
  useEffect(() => {
    if (carrierType === 'carton') {
      const match = getProducts().find((p) => p.packSize === packSize);
      if (match) setCartonProduct(match.id);
    }
  }, [packSize, carrierType]);

  // ── Computed counts ──

  const counts = useMemo(() => {
    let fillOz = fillVolume;
    if (fillVolumeUnit === 'mL') fillOz = fillVolume / 29.5735;
    else if (fillVolumeUnit === 'L') fillOz = fillVolume * 33.814;

    let totalGallons = 0;
    const flavorRows = flavors.map((f) => {
      const cases = f.cases || 0;
      const cans = cases * unitsPerCase;
      const gallons = fillOz > 0 ? (cans * fillOz) / 128 : 0;
      totalGallons += gallons;
      const pallets = casesPerPallet > 0 ? Math.ceil(cases / casesPerPallet) : 0;
      return { ...f, gallons, cans, cases, pallets };
    });

    const totalUnits = flavorRows.reduce((s, f) => s + f.cans, 0);
    const totalCases = flavorRows.reduce((s, f) => s + f.cases, 0);
    const totalPallets = flavorRows.reduce((s, f) => s + f.pallets, 0);
    const totalPacks = packSize > 0 ? Math.ceil(totalUnits / packSize) : 0;
    const totalTrucks = palletsPerTruck > 0 ? Math.ceil(totalPallets / palletsPerTruck) : 0;
    const totalShifts = cansPerMinute > 0 ? totalUnits / cansPerMinute / 480 : 0;
    const proofGallons = Math.round(totalGallons * (abv / 100) * 2 * 100) / 100;

    const flavorCount = flavors.length;
    return { flavorRows, flavorCount, totalGallons, totalUnits, totalPacks, totalCases, totalPallets, totalTrucks, totalShifts, proofGallons };
  }, [flavors, fillVolume, fillVolumeUnit, packSize, unitsPerCase, casesPerPallet, palletsPerTruck, cansPerMinute, abv]);

  // Auto-populate packaging quantities
  useEffect(() => {
    setPackagingItems((prev) => prev.map((item) =>
      item.qtyManual ? item : { ...item, qty: getFeeAutoQty(item.feeType, counts) }
    ));
  }, [counts]);

  // Auto-populate tolling quantities
  useEffect(() => {
    setTollingItems((prev) => prev.map((item) =>
      item.qtyManual ? item : { ...item, qty: getFeeAutoQty(item.feeType, counts) }
    ));
  }, [counts]);

  // Auto-populate BOM quantities (with inbound freight estimate)
  useEffect(() => {
    setBomItems((prev) => prev.map((item) => {
      if (item.qtyManual) return item;
      const qty = item.id === 'bom-freight-in'
        ? Math.max(1, Math.ceil(counts.totalPallets * 0.75))
        : getFeeAutoQty(item.feeType, counts);
      return { ...item, qty };
    }));
  }, [counts]);

  // Auto-populate tax quantities
  useEffect(() => {
    setTaxItems((prev) => prev.map((item) =>
      item.qtyManual ? item : { ...item, qty: getFeeAutoQty(item.feeType, counts) }
    ));
  }, [counts]);

  // ── Drayhorse carton cost ──

  const cartonCost = useMemo(() => {
    if (carrierType !== 'carton') return { totalCost: 0, pricePerM: 0, pricePerCarton: 0, cartonQty: 0 };
    const product = getProducts().find((p) => p.id === cartonProduct);
    const ps = product?.packSize || packSize;
    const cartonQty = ps > 0 ? Math.ceil(counts.totalUnits / ps) : 0;
    const result = lookupPrice(cartonProduct, cartonQty, skuCount);
    if (!result) return { totalCost: 0, pricePerM: 0, pricePerCarton: 0, cartonQty: 0 };
    const artFee = includeNewArt ? NEW_ART_PREP_FEE : 0;
    return { totalCost: result.totalCost + artFee, pricePerM: result.pricePerM, pricePerCarton: result.pricePerCarton, cartonQty, tierQty: result.tierQty, artFee };
  }, [carrierType, cartonProduct, skuCount, counts.totalUnits, packSize, includeNewArt]);

  // ── Cost calculations ──

  const costs = useMemo(() => {
    const totalBatchingFees = flavors.reduce((s, f) => s + (f.batchingFee || 0), 0);

    let packagingCost = 0;
    const pkgRows = packagingItems.map((item) => {
      if (item.category === 'carriers' && carrierType === 'carton') {
        return { ...item, lineCost: 0, inactive: true };
      }
      const lineCost = (item.rate || 0) * (item.qty || 0);
      packagingCost += lineCost;
      return { ...item, lineCost, inactive: false };
    });

    // Per-SKU ingredient costs (ingredient + stabilization per can, multiplied by that SKU's can count)
    let totalIngredientCost = 0;
    counts.flavorRows.forEach((fr) => {
      const flv = flavors.find((f) => f.id === fr.id);
      if (flv) {
        totalIngredientCost += (flv.ingredientCost || 0) * fr.cans;
        totalIngredientCost += (flv.stabilizationCost || 0) * fr.cans;
      }
    });

    let tollingCost = 0;
    const tollRows = tollingItems.map((item) => {
      const lineCost = (item.rate || 0) * (item.qty || 0);
      tollingCost += lineCost;
      return { ...item, lineCost };
    });

    let bomCost = 0;
    const bomRows = bomItems.map((item) => {
      const lineCost = (item.rate || 0) * (item.qty || 0);
      bomCost += lineCost;
      return { ...item, lineCost };
    });

    let taxCost = 0;
    const taxRows = taxItems.map((item) => {
      const lineCost = (item.rate || 0) * (item.qty || 0);
      taxCost += lineCost;
      return { ...item, lineCost };
    });

    const totalPackaging = packagingCost + cartonCost.totalCost;
    const totalCost = totalPackaging + totalIngredientCost + tollingCost + bomCost + totalBatchingFees + taxCost;
    const costPerUnit = counts.totalUnits > 0 ? totalCost / counts.totalUnits : 0;
    const costPerCase = costPerUnit * unitsPerCase;

    return { pkgRows, tollRows, bomRows, taxRows, packagingCost: totalPackaging, rawPackagingCost: packagingCost, totalIngredientCost, tollingCost, bomCost, totalBatchingFees, taxCost, totalCost, costPerUnit, costPerCase };
  }, [packagingItems, tollingItems, bomItems, taxItems, flavors, counts, unitsPerCase, cartonCost, carrierType]);

  const breakdown = useMemo(() => {
    const total = costs.totalCost;
    const rows = [{ label: 'Packaging Materials', cost: costs.rawPackagingCost }];
    if (carrierType === 'carton') rows.push({ label: 'Cartons (Drayhorse)', cost: cartonCost.totalCost });
    if (costs.totalIngredientCost > 0) rows.push({ label: 'Ingredients (per SKU)', cost: costs.totalIngredientCost });
    rows.push({ label: 'Tolling', cost: costs.tollingCost });
    rows.push({ label: 'Bill of Materials', cost: costs.bomCost });
    if (costs.totalBatchingFees > 0) rows.push({ label: 'Batching Fees', cost: costs.totalBatchingFees });
    rows.push({ label: 'Taxes & Regulatory', cost: costs.taxCost });
    return rows.map((r) => ({
      ...r,
      perUnit: counts.totalUnits > 0 ? r.cost / counts.totalUnits : 0,
      pct: total > 0 ? (r.cost / total) * 100 : 0,
    }));
  }, [costs, counts, carrierType, cartonCost]);

  // ── Handlers ──

  function updateFeeItem(setter) {
    return (idx, field, value) => {
      setter((prev) => prev.map((item, i) => {
        if (i !== idx) return item;
        const u = { ...item, [field]: value };
        if (field === 'feeType' && !item.qtyManual) u.qty = getFeeAutoQty(value, counts);
        if (field === 'qty') u.qtyManual = true;
        return u;
      }));
    };
  }

  function resetItemQty(setter) {
    return (idx) => setter((prev) => prev.map((item, i) => {
      if (i !== idx) return item;
      return { ...item, qty: getFeeAutoQty(item.feeType, counts), qtyManual: false };
    }));
  }

  const updatePkg = updateFeeItem(setPackagingItems);
  const resetPkgQty = resetItemQty(setPackagingItems);
  const updateToll = updateFeeItem(setTollingItems);
  const resetTollQty = resetItemQty(setTollingItems);
  const updateBom = updateFeeItem(setBomItems);
  const resetBomQty = resetItemQty(setBomItems);
  const updateTax = updateFeeItem(setTaxItems);
  const resetTaxQty = resetItemQty(setTaxItems);

  // ── Drag & drop reorder ──
  const [dragState, setDragState] = useState({ list: null, fromIdx: null, overIdx: null });

  function makeDragHandlers(listName, setter) {
    return {
      listName,
      onDragStart: (idx) => (e) => {
        setDragState({ list: listName, fromIdx: idx, overIdx: idx });
        e.dataTransfer.effectAllowed = 'move';
        e.currentTarget.closest('tr').style.opacity = '0.4';
      },
      onDragEnd: (e) => {
        e.currentTarget.closest('tr').style.opacity = '1';
        if (dragState.list === listName && dragState.fromIdx !== null && dragState.overIdx !== null && dragState.fromIdx !== dragState.overIdx) {
          setter((prev) => {
            const items = [...prev];
            const [moved] = items.splice(dragState.fromIdx, 1);
            items.splice(dragState.overIdx, 0, moved);
            return items;
          });
        }
        setDragState({ list: null, fromIdx: null, overIdx: null });
      },
      onDragOver: (idx) => (e) => {
        e.preventDefault();
        e.dataTransfer.dropEffect = 'move';
        if (dragState.list === listName) setDragState((s) => ({ ...s, overIdx: idx }));
      },
    };
  }

  const pkgDrag = makeDragHandlers('pkg', setPackagingItems);
  const tollDrag = makeDragHandlers('toll', setTollingItems);
  const bomDrag = makeDragHandlers('bom', setBomItems);
  const taxDrag = makeDragHandlers('tax', setTaxItems);
  const flvDrag = makeDragHandlers('flv', setFlavors);

  // ── Run save / load ──

  function collectRunState() {
    return {
      config: { fillVolume, fillVolumeUnit, packSize, carrierType, abv, unitsPerCase, casesPerPallet, palletsPerTruck, cansPerMinute },
      flavors,
      carton: { cartonProduct, skuCount, includeNewArt },
      packagingItems,
      tollingItems,
      bomItems,
      taxItems,
    };
  }

  function applyRunState(run) {
    const c = run.config || {};
    if (c.fillVolume !== undefined) setFillVolume(c.fillVolume);
    if (c.fillVolumeUnit) setFillVolumeUnit(c.fillVolumeUnit);
    if (c.packSize) setPackSize(c.packSize);
    if (c.carrierType) setCarrierType(c.carrierType);
    if (c.abv !== undefined) setAbv(c.abv);
    if (c.unitsPerCase) setUnitsPerCase(c.unitsPerCase);
    if (c.casesPerPallet) setCasesPerPallet(c.casesPerPallet);
    if (c.palletsPerTruck) setPalletsPerTruck(c.palletsPerTruck);
    if (c.cansPerMinute) setCansPerMinute(c.cansPerMinute);
    if (run.flavors) setFlavors(run.flavors);
    if (run.carton) {
      setCartonProduct(run.carton.cartonProduct || 'sleek-4pk');
      setSkuCount(run.carton.skuCount || 1);
      setIncludeNewArt(run.carton.includeNewArt || false);
    }
    if (run.packagingItems) setPackagingItems(run.packagingItems);
    if (run.tollingItems) setTollingItems(run.tollingItems);
    if (run.bomItems) setBomItems(run.bomItems);
    if (run.taxItems) setTaxItems(run.taxItems);
  }

  function handleSaveRun() {
    const name = runName.trim() || ('Run ' + new Date().toLocaleDateString());
    const run = saveRun({ id: currentRunId, name, client: runClient.trim(), ...collectRunState() });
    setCurrentRunId(run.id);
    setRunName(run.name);
    setSavedRuns(getRuns());
  }

  function handleLoadRun(runId) {
    const run = savedRuns.find((r) => r.id === runId);
    if (!run) return;
    setCurrentRunId(run.id);
    setRunName(run.name);
    setRunClient(run.client || '');
    applyRunState(run);
  }

  function handleNewRun() {
    setCurrentRunId(null);
    setRunName('');
    setRunClient('');
    setFillVolume(12); setFillVolumeUnit('oz'); setPackSize(4); setCarrierType('paktech');
    setAbv(0); setUnitsPerCase(24); setCasesPerPallet(80); setPalletsPerTruck(20); setCansPerMinute(400);
    setFlavors([{ id: 'flv-1', formulaId: '', name: '', cases: 100, batchingFee: 0, ingredientCost: 0.25, stabilizationCost: 0.02, ingredientCostAuto: false }]);
    setCartonProduct('sleek-4pk'); setSkuCount(1); setIncludeNewArt(false);
    setPackagingItems(makeDefaultPackaging());
    setTollingItems(makeDefaultTolling());
    setBomItems(makeDefaultBOM());
    setTaxItems(makeDefaultTaxes());
  }

  function handleDeleteRun(runId) {
    const run = savedRuns.find((r) => r.id === runId);
    if (!confirm(`Delete "${run?.name || 'this run'}"? This cannot be undone.`)) return;
    deleteRun(runId);
    setSavedRuns(getRuns());
    if (currentRunId === runId) { setCurrentRunId(null); setRunName(''); setRunClient(''); }
  }

  // ── Render helper: fee table (shared by services, taxes) ──

  function renderFeeTable(rows, updateFn, resetFn, removeFn, addFn, addLabel, subtotal, drag) {
    return (
      <table>
        <thead>
          <tr>
            <th style={{ width: 28 }}></th>
            <th>Name</th>
            <th>Fee Type</th>
            <th style={{ textAlign: 'right' }}>Rate</th>
            <th style={{ textAlign: 'right' }}>Qty</th>
            <th style={{ textAlign: 'right' }}>Line Cost</th>
            <th style={{ width: 32 }}></th>
          </tr>
        </thead>
        <tbody>
          {rows.map((row, idx) => {
            const ftColors = feeTypeColors[row.feeType] || feeTypeColors.fixed;
            const isOver = drag && dragState.list === drag.listName && dragState.overIdx === idx && dragState.fromIdx !== idx;
            return (
              <tr key={row.id} onDragOver={drag?.onDragOver(idx)}
                style={isOver ? { borderTop: '2px solid #3b82f6' } : {}}>
                <td>
                  <span draggable onDragStart={drag?.onDragStart(idx)} onDragEnd={drag?.onDragEnd}
                    style={dragHandleStyle}>&#x2261;</span>
                </td>
                <td>
                  <input type="text" value={row.name} placeholder="Name" style={{ width: '100%', minWidth: 150 }}
                    onChange={(e) => updateFn(idx, 'name', e.target.value)} />
                </td>
                <td>
                  <select value={row.feeType} style={chipStyle(ftColors)}
                    onChange={(e) => updateFn(idx, 'feeType', e.target.value)}>
                    {FEE_TYPES.map((ft) => <option key={ft.value} value={ft.value}>{ft.label}</option>)}
                  </select>
                </td>
                <td style={{ textAlign: 'right' }}>
                  <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'flex-end', gap: 2 }}>
                    <span style={{ color: '#6b7280', fontSize: 13 }}>$</span>
                    <input type="text" inputMode="decimal" defaultValue={row.rate} style={{ width: 80, textAlign: 'right' }}
                      onBlur={(e) => updateFn(idx, 'rate', e.target.value === '' ? 0 : +e.target.value)} />
                  </div>
                </td>
                <td style={{ textAlign: 'right' }}>
                  <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'flex-end', gap: 4 }}>
                    <input type="number" value={row.qty} step={row.feeType === 'per-proof-gallon' ? '0.01' : '1'} min="0" style={{ width: 80, textAlign: 'right' }}
                      onChange={(e) => updateFn(idx, 'qty', e.target.value === '' ? 0 : +e.target.value)} />
                    {row.qtyManual && (
                      <button className="btn btn-small" onClick={() => resetFn(idx)} title="Reset to auto"
                        style={{ padding: '2px 5px', fontSize: 10, lineHeight: 1 }}>auto</button>
                    )}
                  </div>
                </td>
                <td style={{ textAlign: 'right', fontWeight: 600, whiteSpace: 'nowrap' }}>
                  ${row.lineCost.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}
                </td>
                <td>
                  <button className="btn btn-small btn-danger" onClick={() => removeFn(idx)} title="Remove">x</button>
                </td>
              </tr>
            );
          })}
        </tbody>
        <tfoot>
          <tr>
            <td colSpan={5} style={{ textAlign: 'right', fontWeight: 700 }}>Subtotal</td>
            <td style={{ textAlign: 'right', fontWeight: 700 }}>
              ${subtotal.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}
            </td>
            <td></td>
          </tr>
          <tr>
            <td colSpan={7} style={{ padding: '8px 12px' }}>
              <button className="btn btn-small" onClick={addFn} style={{ fontSize: 12 }}>+ {addLabel}</button>
            </td>
          </tr>
        </tfoot>
      </table>
    );
  }

  // ── JSX ──

  return (
    <div className="container">
      {/* Page Header */}
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', marginBottom: 24 }}>
        <div>
          <div style={{ display: 'inline-block', padding: '3px 10px', background: 'var(--brand-100)', color: 'var(--brand)', borderRadius: 4, fontSize: 11, fontWeight: 700, letterSpacing: 0.5, textTransform: 'uppercase', marginBottom: 8 }}>
            Calculator Engine v6.2
          </div>
          <h1 style={{ fontSize: 28, fontWeight: 800, color: 'var(--text-primary)', margin: 0, lineHeight: 1.2 }}>Run Quoting</h1>
          <p style={{ fontSize: 14, color: 'var(--text-secondary)', marginTop: 4 }}>Build multi-SKU production run quotes with packaging, tolling, and margin analysis.</p>
        </div>
        <div style={{ display: 'flex', gap: 8, alignItems: 'center', flexShrink: 0 }}>
          {savedRuns.length > 0 && (
            <select value="" style={{ fontSize: 13, minWidth: 160, padding: '8px 10px', border: '1px solid var(--border)', borderRadius: 6, fontFamily: 'inherit' }}
              onChange={(e) => { if (e.target.value) handleLoadRun(e.target.value); }}>
              <option value="">Load run...</option>
              {(() => {
                const groups = {};
                savedRuns.forEach((r) => {
                  const c = r.client || 'Uncategorized';
                  if (!groups[c]) groups[c] = [];
                  groups[c].push(r);
                });
                return Object.entries(groups).sort(([a], [b]) => a === 'Uncategorized' ? 1 : b === 'Uncategorized' ? -1 : a.localeCompare(b)).map(([client, runs]) => (
                  <optgroup key={client} label={client}>
                    {runs.map((r) => <option key={r.id} value={r.id}>{r.name}{r.id === currentRunId ? ' (current)' : ''}</option>)}
                  </optgroup>
                ));
              })()}
            </select>
          )}
          <button className="btn" onClick={handleNewRun}>New</button>
          {currentRunId && (
            <button className="btn btn-danger" onClick={() => handleDeleteRun(currentRunId)} style={{ fontSize: 12 }}>Delete</button>
          )}
          <button className="btn" onClick={() => exportCoPackingToExcel(collectRunState())}>Export Excel</button>
          <button className="btn btn-primary" onClick={handleSaveRun}>
            {currentRunId ? 'Save' : 'Save Configuration'}
          </button>
        </div>
      </div>

      {/* Run Name + Client */}
      <div style={{ display: 'flex', gap: 12, marginBottom: 16 }}>
        <input type="text" value={runClient} placeholder="Client name..."
          style={{ width: 200, padding: '10px 14px', border: '1px solid var(--border)', borderRadius: 'var(--radius)', fontSize: 14, fontFamily: 'inherit' }}
          onChange={(e) => setRunClient(e.target.value)}
          list="run-clients" />
        <datalist id="run-clients">
          {[...new Set(savedRuns.map((r) => r.client).filter(Boolean))].map((c) => <option key={c} value={c} />)}
        </datalist>
        <input type="text" value={runName} placeholder="Run name (e.g. Spring Seltzer Variety Pack)..."
          style={{ flex: 1, padding: '10px 14px', border: '1px solid var(--border)', borderRadius: 'var(--radius)', fontSize: 15, fontWeight: 600, fontFamily: 'inherit' }}
          onChange={(e) => setRunName(e.target.value)} />
      </div>

      {/* KPI Cards */}
      <div className="cost-summary" style={{ gridTemplateColumns: 'repeat(3, 1fr)', marginBottom: 24 }}>
        <div className="cost-card">
          <div className="cost-card-label">Estimated Unit Cost</div>
          <div className="cost-card-value">${costs.costPerUnit.toFixed(2)} <span style={{ fontSize: 14, fontWeight: 500, color: 'var(--text-muted)' }}>/ unit</span></div>
          {counts.totalUnits > 0 && <div className="cost-card-subtitle" style={{ color: 'var(--brand)', fontWeight: 600 }}>{counts.totalUnits.toLocaleString()} total units</div>}
        </div>
        <div className="cost-card">
          <div className="cost-card-label">Total Production Cost</div>
          <div className="cost-card-value">${costs.totalCost.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}</div>
          <div className="cost-card-subtitle">Based on {counts.totalPallets} pallets, {counts.totalShifts.toFixed(1)} shifts</div>
        </div>
        <div className="cost-card hero">
          <div className="cost-card-label">Total Cost Per Case</div>
          <div className="cost-card-value">${costs.costPerCase.toFixed(2)}</div>
          <div className="cost-card-subtitle">{unitsPerCase} units per case</div>
        </div>
      </div>

      {/* Compact Run Settings */}
          <div style={{ display: 'flex', flexWrap: 'wrap', gap: 12, alignItems: 'center', padding: '10px 16px', background: 'var(--surface)', border: '1px solid var(--border-light)', borderRadius: 'var(--radius)', marginBottom: 20, fontSize: 13, boxShadow: '0 1px 2px rgba(0,0,0,0.04)' }}>
            <label style={{ display: 'flex', alignItems: 'center', gap: 4 }}>
              <span style={{ color: 'var(--text-muted)', fontWeight: 600, fontSize: 11, textTransform: 'uppercase', letterSpacing: 0.5 }}>Fill</span>
              <input type="number" value={fillVolume} step="0.1" style={{ width: 55, textAlign: 'right' }} onChange={(e) => setFillVolume(e.target.value === '' ? 0 : +e.target.value)} />
              <select value={fillVolumeUnit} style={{ fontSize: 12 }} onChange={(e) => setFillVolumeUnit(e.target.value)}>
                <option value="oz">oz</option><option value="mL">mL</option><option value="L">L</option>
              </select>
            </label>
            <span style={{ color: 'var(--border)' }}>|</span>
            <label style={{ display: 'flex', alignItems: 'center', gap: 4 }}>
              <span style={{ color: 'var(--text-muted)', fontWeight: 600, fontSize: 11, textTransform: 'uppercase', letterSpacing: 0.5 }}>Pack</span>
              <select value={packSize} style={{ fontSize: 12 }} onChange={(e) => setPackSize(parseInt(e.target.value))}>
                {PACK_SIZES.map((s) => <option key={s} value={s}>{s}-pk</option>)}
              </select>
            </label>
            <span style={{ color: 'var(--border)' }}>|</span>
            <label style={{ display: 'flex', alignItems: 'center', gap: 4 }}>
              <span style={{ color: 'var(--text-muted)', fontWeight: 600, fontSize: 11, textTransform: 'uppercase', letterSpacing: 0.5 }}>Carrier</span>
              <select value={carrierType} style={{ fontSize: 12 }} onChange={(e) => setCarrierType(e.target.value)}>
                <option value="paktech">PakTech</option>
                <option value="carton">Carton</option>
              </select>
            </label>
            <span style={{ color: 'var(--border)' }}>|</span>
            <label style={{ display: 'flex', alignItems: 'center', gap: 4 }}>
              <span style={{ color: 'var(--text-muted)', fontWeight: 600, fontSize: 11, textTransform: 'uppercase', letterSpacing: 0.5 }}>ABV</span>
              <input type="number" value={abv} step="0.1" min="0" max="100" style={{ width: 50, textAlign: 'right' }} onChange={(e) => setAbv(e.target.value === '' ? 0 : +e.target.value)} />
              <span style={{ color: 'var(--text-muted)' }}>%</span>
            </label>
            <span style={{ color: 'var(--border)' }}>|</span>
            <label style={{ display: 'flex', alignItems: 'center', gap: 4 }}>
              <input type="number" value={unitsPerCase} style={{ width: 40, textAlign: 'right' }} onChange={(e) => setUnitsPerCase(parseInt(e.target.value) || 1)} />
              <span style={{ color: 'var(--text-muted)' }}>/ case</span>
            </label>
            <label style={{ display: 'flex', alignItems: 'center', gap: 4 }}>
              <input type="number" value={casesPerPallet} style={{ width: 40, textAlign: 'right' }} onChange={(e) => setCasesPerPallet(parseInt(e.target.value) || 1)} />
              <span style={{ color: 'var(--text-muted)' }}>/ plt</span>
            </label>
            <label style={{ display: 'flex', alignItems: 'center', gap: 4 }}>
              <input type="number" value={palletsPerTruck} style={{ width: 35, textAlign: 'right' }} onChange={(e) => setPalletsPerTruck(parseInt(e.target.value) || 1)} />
              <span style={{ color: 'var(--text-muted)' }}>/ truck</span>
            </label>
            <label style={{ display: 'flex', alignItems: 'center', gap: 4 }}>
              <input type="number" value={cansPerMinute} style={{ width: 50, textAlign: 'right' }} onChange={(e) => setCansPerMinute(parseInt(e.target.value) || 1)} />
              <span style={{ color: 'var(--text-muted)' }}>cpm</span>
            </label>
          </div>

          {/* Flavor Lineup */}
      <div className="section" style={{ marginBottom: 20 }}>
        <div className="section-header">
          <div className="section-title">Flavor Lineup</div>
          <button className="btn btn-primary btn-small" onClick={() => setFlavors((p) => [...p, { id: 'flv-' + Date.now(), formulaId: '', name: '', cases: 100, batchingFee: 0, ingredientCost: 0.25, stabilizationCost: 0.02, ingredientCostAuto: false }])}>
            + Add Flavor
          </button>
        </div>
        <div>
          <table>
            <thead>
              <tr>
                <th style={{ width: 28 }}></th>
                <th>Formula</th>
                <th style={{ textAlign: 'right' }}>Cases</th>
                <th style={{ textAlign: 'right' }}>Ingr. $/can</th>
                <th style={{ textAlign: 'right' }}>Stab. $/can</th>
                <th style={{ textAlign: 'right' }}>Batching Fee</th>
                <th style={{ textAlign: 'right' }}>Cans</th>
                <th style={{ textAlign: 'right' }}>Cases</th>
                <th style={{ textAlign: 'right' }}>Pallets</th>
                <th style={{ width: 32 }}></th>
              </tr>
            </thead>
            <tbody>
              {counts.flavorRows.map((row, idx) => {
                const formulaGroups = {};
                allFormulas.forEach((f) => {
                  const client = f.client || 'Uncategorized';
                  if (!formulaGroups[client]) formulaGroups[client] = [];
                  formulaGroups[client].push(f);
                });
                const isOver = dragState.list === 'flv' && dragState.overIdx === idx && dragState.fromIdx !== idx;
                return (
                <tr key={row.id} onDragOver={flvDrag.onDragOver(idx)}
                  style={isOver ? { borderTop: '2px solid #3b82f6' } : {}}>
                  <td>
                    <span draggable onDragStart={flvDrag.onDragStart(idx)} onDragEnd={flvDrag.onDragEnd}
                      style={dragHandleStyle}>&#x2261;</span>
                  </td>
                  <td>
                    <select
                      value={row.formulaId || ''}
                      style={{ width: '100%', minWidth: 150 }}
                      onChange={(e) => {
                        const selectedId = e.target.value;
                        if (selectedId === '') {
                          setFlavors((p) => p.map((f, i) => i === idx ? { ...f, formulaId: '', name: '' } : f));
                          return;
                        }
                        const formula = allFormulas.find((f) => f.id === selectedId);
                        if (formula) {
                          // Calculate ingredient cost per can from formula's ingredient data
                          let batchGal = formula.batchSize || 500;
                          if (formula.batchSizeUnit === 'L') batchGal = batchGal / 3.78541;
                          let fillOz = fillVolume;
                          if (fillVolumeUnit === 'mL') fillOz = fillVolume / 29.5735;
                          else if (fillVolumeUnit === 'L') fillOz = fillVolume * 33.814;
                          const autoIngCost = calcFormulaIngredientCostPerCan(formula, batchGal, fillOz);

                          setFlavors((p) => p.map((f, i) => i === idx ? {
                            ...f,
                            formulaId: formula.id,
                            name: formula.name,
                            cases: formula.batchSize && unitsPerCase > 0
                              ? Math.ceil((formula.batchSize * (formula.batchSizeUnit === 'L' ? 33.814 / fillVolume : 128 / fillVolume)) / unitsPerCase)
                              : f.cases,
                            ingredientCost: autoIngCost ?? f.ingredientCost,
                            ingredientCostAuto: autoIngCost !== null,
                          } : f));
                        }
                      }}
                    >
                      <option value="">— Select Formula —</option>
                      {Object.entries(formulaGroups).sort(([a], [b]) => a === 'Uncategorized' ? 1 : b === 'Uncategorized' ? -1 : a.localeCompare(b)).map(([client, formulas]) => (
                        <optgroup key={client} label={client}>
                          {formulas.map((f) => (
                            <option key={f.id} value={f.id}>{f.name}</option>
                          ))}
                        </optgroup>
                      ))}
                    </select>
                    {!row.formulaId && (
                      <input type="text" value={row.name} placeholder="or type a name" style={{ width: '100%', marginTop: 4, fontSize: 12 }}
                        onChange={(e) => setFlavors((p) => p.map((f, i) => i === idx ? { ...f, name: e.target.value } : f))} />
                    )}
                  </td>
                  <td style={{ textAlign: 'right' }}>
                    <input type="number" value={row.cases} min="0" style={{ width: 80, textAlign: 'right' }}
                      onChange={(e) => setFlavors((p) => p.map((f, i) => i === idx ? { ...f, cases: parseInt(e.target.value) || 0 } : f))} />
                  </td>
                  <td style={{ textAlign: 'right' }}>
                    <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'flex-end', gap: 2 }}>
                      <span style={{ color: 'var(--text-muted)', fontSize: 13 }}>$</span>
                      <input type="text" inputMode="decimal" defaultValue={row.ingredientCost}
                        style={{ width: 65, textAlign: 'right', background: row.ingredientCostAuto ? '#EDE9FE' : undefined }}
                        title={row.ingredientCostAuto ? 'Auto-calculated from formula ingredients' : 'Manual entry'}
                        onBlur={(e) => setFlavors((p) => p.map((f, i) => i === idx ? { ...f, ingredientCost: e.target.value === '' ? 0 : +e.target.value, ingredientCostAuto: false } : f))} />
                    </div>
                  </td>
                  <td style={{ textAlign: 'right' }}>
                    <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'flex-end', gap: 2 }}>
                      <span style={{ color: 'var(--text-muted)', fontSize: 13 }}>$</span>
                      <input type="text" inputMode="decimal" defaultValue={row.stabilizationCost} style={{ width: 65, textAlign: 'right' }}
                        onBlur={(e) => setFlavors((p) => p.map((f, i) => i === idx ? { ...f, stabilizationCost: e.target.value === '' ? 0 : +e.target.value } : f))} />
                    </div>
                  </td>
                  <td style={{ textAlign: 'right' }}>
                    <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'flex-end', gap: 2 }}>
                      <span style={{ color: 'var(--text-muted)', fontSize: 13 }}>$</span>
                      <input type="text" inputMode="decimal" defaultValue={row.batchingFee} style={{ width: 70, textAlign: 'right' }}
                        onBlur={(e) => setFlavors((p) => p.map((f, i) => i === idx ? { ...f, batchingFee: e.target.value === '' ? 0 : +e.target.value } : f))} />
                    </div>
                  </td>
                  <td style={{ textAlign: 'right', fontWeight: 600 }}>{row.cans.toLocaleString()}</td>
                  <td style={{ textAlign: 'right' }}>{row.cases.toLocaleString()}</td>
                  <td style={{ textAlign: 'right' }}>{row.pallets.toLocaleString()}</td>
                  <td>
                    {flavors.length > 1 && (
                      <button className="btn btn-small btn-danger" onClick={() => setFlavors((p) => p.filter((_, i) => i !== idx))}>x</button>
                    )}
                  </td>
                </tr>
                );
              })}
            </tbody>
            {flavors.length > 1 && (
              <tfoot>
                <tr>
                  <td></td>
                  <td style={{ fontWeight: 700 }}>Run Totals</td>
                  <td></td>
                  <td colSpan={2} style={{ textAlign: 'right', fontWeight: 600, fontSize: 12, color: 'var(--text-secondary)' }}>
                    Ingr: ${costs.totalIngredientCost?.toLocaleString(undefined, { minimumFractionDigits: 2 }) || '0.00'}
                  </td>
                  <td style={{ textAlign: 'right', fontWeight: 700 }}>
                    ${costs.totalBatchingFees.toLocaleString(undefined, { minimumFractionDigits: 2 })}
                  </td>
                  <td style={{ textAlign: 'right', fontWeight: 700 }}>{counts.totalUnits.toLocaleString()}</td>
                  <td style={{ textAlign: 'right', fontWeight: 700 }}>{counts.totalCases.toLocaleString()}</td>
                  <td style={{ textAlign: 'right', fontWeight: 700 }}>{counts.totalPallets.toLocaleString()}</td>
                  <td></td>
                </tr>
              </tfoot>
            )}
          </table>
        </div>
      </div>

      {/* Carton Pricing — only when carrier type is carton */}
      {carrierType === 'carton' && (
        <div className="section" style={{ marginBottom: 20 }}>
          <div className="section-header">
            <div className="section-title">Carton Pricing (Drayhorse)</div>
          </div>
          <div className="section-body">
            <div className="form-grid-3">
              <div className="form-group" style={{ margin: 0 }}>
                <label className="form-label">Carton Type</label>
                <select value={cartonProduct} onChange={(e) => setCartonProduct(e.target.value)}>
                  {(() => {
                    const groups = {};
                    getProducts().forEach((p) => { if (!groups[p.structure]) groups[p.structure] = []; groups[p.structure].push(p); });
                    return Object.entries(groups).map(([structure, prods]) => (
                      <optgroup key={structure} label={`${structure} Can`}>
                        {prods.map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}
                      </optgroup>
                    ));
                  })()}
                </select>
              </div>
              <div className="form-group" style={{ margin: 0 }}>
                <label className="form-label"># of SKUs</label>
                <select value={skuCount} onChange={(e) => setSkuCount(parseInt(e.target.value))}>
                  {[1, 2, 3, 4].map((n) => <option key={n} value={n}>{n} SKU{n > 1 ? 's' : ''}</option>)}
                </select>
              </div>
              <div className="form-group" style={{ margin: 0 }}>
                <label className="form-label">&nbsp;</label>
                <label style={{ display: 'flex', alignItems: 'center', gap: 8, fontSize: 13, cursor: 'pointer', height: 38 }}>
                  <input type="checkbox" checked={includeNewArt} onChange={(e) => setIncludeNewArt(e.target.checked)} />
                  New art prep (${NEW_ART_PREP_FEE})
                </label>
              </div>
            </div>
            {cartonCost.cartonQty > 0 && (
              <div style={{ display: 'grid', gridTemplateColumns: 'repeat(4, 1fr)', gap: 12, marginTop: 16 }}>
                <div style={{ padding: 12, background: '#f0fdf4', border: '1px solid #bbf7d0', borderRadius: 6, textAlign: 'center' }}>
                  <div style={{ fontSize: 11, color: '#16a34a', fontWeight: 600 }}>Cartons</div>
                  <div style={{ fontSize: 18, fontWeight: 700, color: '#065f46' }}>{cartonCost.cartonQty.toLocaleString()}</div>
                </div>
                <div style={{ padding: 12, background: '#eff6ff', border: '1px solid #bfdbfe', borderRadius: 6, textAlign: 'center' }}>
                  <div style={{ fontSize: 11, color: '#3b82f6', fontWeight: 600 }}>Price / 1,000</div>
                  <div style={{ fontSize: 18, fontWeight: 700, color: '#1e40af' }}>${cartonCost.pricePerM.toFixed(2)}</div>
                  <div style={{ fontSize: 10, color: '#6b7280' }}>{cartonCost.tierQty?.toLocaleString()}+ tier</div>
                </div>
                <div style={{ padding: 12, background: '#fefce8', border: '1px solid #fef08a', borderRadius: 6, textAlign: 'center' }}>
                  <div style={{ fontSize: 11, color: '#ca8a04', fontWeight: 600 }}>Total</div>
                  <div style={{ fontSize: 18, fontWeight: 700, color: '#92400e' }}>
                    ${cartonCost.totalCost.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}
                  </div>
                  {cartonCost.artFee > 0 && <div style={{ fontSize: 10, color: '#6b7280' }}>incl. ${cartonCost.artFee} art</div>}
                </div>
                <div style={{ padding: 12, background: '#faf5ff', border: '1px solid #e9d5ff', borderRadius: 6, textAlign: 'center' }}>
                  <div style={{ fontSize: 11, color: '#7c3aed', fontWeight: 600 }}>Per Carton</div>
                  <div style={{ fontSize: 18, fontWeight: 700, color: '#5b21b6' }}>${cartonCost.pricePerCarton.toFixed(4)}</div>
                </div>
              </div>
            )}
          </div>
        </div>
      )}

      {/* Packaging Materials */}
      <div className="section" style={{ marginBottom: 20 }}>
        <div className="section-header">
          <div className="section-title">Packaging Materials</div>
        </div>
        <div>
          <table>
            <thead>
              <tr>
                <th style={{ width: 28 }}></th>
                <th>Item</th>
                <th>Category</th>
                <th>Fee Type</th>
                <th style={{ textAlign: 'right' }}>Rate</th>
                <th style={{ textAlign: 'right' }}>Qty</th>
                <th style={{ textAlign: 'right' }}>Line Cost</th>
                <th style={{ width: 32 }}></th>
              </tr>
            </thead>
            <tbody>
              {costs.pkgRows.map((row, idx) => {
                const catStyle = categoryColors[row.category] || categoryColors.other;
                const ftColors = feeTypeColors[row.feeType] || feeTypeColors.fixed;
                const isOver = dragState.list === 'pkg' && dragState.overIdx === idx && dragState.fromIdx !== idx;
                return (
                  <tr key={row.id} onDragOver={pkgDrag.onDragOver(idx)}
                    style={{ ...(row.inactive ? { opacity: 0.35 } : {}), ...(isOver ? { borderTop: '2px solid #3b82f6' } : {}) }}>
                    <td>
                      <span draggable onDragStart={pkgDrag.onDragStart(idx)} onDragEnd={pkgDrag.onDragEnd}
                        style={dragHandleStyle}>&#x2261;</span>
                    </td>
                    <td>
                      <input type="text" value={row.name} placeholder="Item name" style={{ width: '100%', minWidth: 120 }}
                        onChange={(e) => updatePkg(idx, 'name', e.target.value)} />
                      {row.printType !== undefined && (
                        <select value={row.printType} style={{ marginTop: 4, fontSize: 12, width: '100%' }}
                          onChange={(e) => updatePkg(idx, 'printType', e.target.value)}>
                          {PRINT_TYPES.map((pt) => <option key={pt.value} value={pt.value}>{pt.label}</option>)}
                        </select>
                      )}
                      {row.inactive && <div style={{ fontSize: 10, color: '#9ca3af', marginTop: 2 }}>Using cartons</div>}
                    </td>
                    <td>
                      <select value={row.category} style={chipStyle(catStyle)}
                        onChange={(e) => updatePkg(idx, 'category', e.target.value)}>
                        {PACKAGING_CATEGORIES.map((c) => <option key={c.value} value={c.value}>{c.label}</option>)}
                      </select>
                    </td>
                    <td>
                      <select value={row.feeType} style={chipStyle(ftColors)}
                        onChange={(e) => updatePkg(idx, 'feeType', e.target.value)}>
                        {FEE_TYPES.map((ft) => <option key={ft.value} value={ft.value}>{ft.label}</option>)}
                      </select>
                    </td>
                    <td style={{ textAlign: 'right' }}>
                      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'flex-end', gap: 2 }}>
                        <span style={{ color: '#6b7280', fontSize: 13 }}>$</span>
                        <input type="text" inputMode="decimal" defaultValue={row.rate} style={{ width: 80, textAlign: 'right' }}
                          onBlur={(e) => updatePkg(idx, 'rate', e.target.value === '' ? 0 : +e.target.value)} />
                      </div>
                    </td>
                    <td style={{ textAlign: 'right' }}>
                      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'flex-end', gap: 4 }}>
                        <input type="number" value={row.qty} min="0" style={{ width: 80, textAlign: 'right' }}
                          onChange={(e) => updatePkg(idx, 'qty', parseInt(e.target.value) || 0)} />
                        {row.qtyManual && (
                          <button className="btn btn-small" onClick={() => resetPkgQty(idx)} title="Reset to auto"
                            style={{ padding: '2px 5px', fontSize: 10, lineHeight: 1 }}>auto</button>
                        )}
                      </div>
                    </td>
                    <td style={{ textAlign: 'right', fontWeight: 600, whiteSpace: 'nowrap' }}>
                      ${row.lineCost.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}
                    </td>
                    <td>
                      <button className="btn btn-small btn-danger" onClick={() => setPackagingItems((p) => p.filter((_, i) => i !== idx))}>x</button>
                    </td>
                  </tr>
                );
              })}
            </tbody>
            <tfoot>
              <tr>
                <td colSpan={6} style={{ textAlign: 'right', fontWeight: 700 }}>Packaging Subtotal</td>
                <td style={{ textAlign: 'right', fontWeight: 700 }}>
                  ${costs.rawPackagingCost.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}
                </td>
                <td></td>
              </tr>
              <tr>
                <td colSpan={8} style={{ padding: '8px 12px' }}>
                  <button className="btn btn-small" onClick={() => setPackagingItems((p) => [...p, { id: 'pkg-' + Date.now(), name: '', category: 'other', feeType: 'per-unit', rate: 0, qty: getFeeAutoQty('per-unit', counts), qtyManual: false }])} style={{ fontSize: 12 }}>
                    + Add Packaging Item
                  </button>
                </td>
              </tr>
            </tfoot>
          </table>
        </div>
      </div>

      {/* Tolling */}
      <div className="section" style={{ marginBottom: 20 }}>
        <div className="section-header">
          <div className="section-title">Tolling</div>
        </div>
        <div>
          {renderFeeTable(
            costs.tollRows, updateToll, resetTollQty,
            (idx) => setTollingItems((p) => p.filter((_, i) => i !== idx)),
            () => setTollingItems((p) => [...p, { id: 'toll-' + Date.now(), name: '', feeType: 'per-unit', rate: 0, qty: getFeeAutoQty('per-unit', counts), qtyManual: false }]),
            'Add Tolling Item', costs.tollingCost, tollDrag
          )}
        </div>
      </div>

      {/* Bill of Materials */}
      <div className="section" style={{ marginBottom: 20 }}>
        <div className="section-header">
          <div className="section-title">Bill of Materials</div>
        </div>
        <div>
          {renderFeeTable(
            costs.bomRows, updateBom, resetBomQty,
            (idx) => setBomItems((p) => p.filter((_, i) => i !== idx)),
            () => setBomItems((p) => [...p, { id: 'bom-' + Date.now(), name: '', feeType: 'per-unit', rate: 0, qty: getFeeAutoQty('per-unit', counts), qtyManual: false }]),
            'Add BOM Item', costs.bomCost, bomDrag
          )}
        </div>
      </div>

      {/* Taxes & Regulatory */}
      <div className="section" style={{ marginBottom: 20 }}>
        <div className="section-header">
          <div className="section-title">Taxes, Deposits & Regulatory</div>
        </div>
        <div>
          {renderFeeTable(
            costs.taxRows, updateTax, resetTaxQty,
            (idx) => setTaxItems((p) => p.filter((_, i) => i !== idx)),
            () => setTaxItems((p) => [...p, { id: 'tax-' + Date.now(), name: '', feeType: 'per-unit', rate: 0, qty: getFeeAutoQty('per-unit', counts), qtyManual: false }]),
            'Add Tax / Fee', costs.taxCost, taxDrag
          )}
        </div>
      </div>

      {/* Economic Projection + Component Matrix */}
      <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 20, marginTop: 20, marginBottom: 20 }}>
        <div className="projection-card">
          <h3>Economic Projection</h3>
          <div className="projection-total">${costs.totalCost.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}</div>
          <div className="projection-row"><span className="label">Cost Per Unit</span><span className="value">${costs.costPerUnit.toFixed(4)}</span></div>
          <div className="projection-row"><span className="label">Packaging Materials</span><span className="value">${costs.packagingCost.toFixed(2)}</span></div>
          {costs.totalIngredientCost > 0 && <div className="projection-row"><span className="label">Ingredients (per SKU)</span><span className="value">${costs.totalIngredientCost.toFixed(2)}</span></div>}
          <div className="projection-row"><span className="label">Tolling</span><span className="value">${costs.tollingCost.toFixed(2)}</span></div>
          <div className="projection-row"><span className="label">Bill of Materials</span><span className="value">${costs.bomCost.toFixed(2)}</span></div>
          {costs.totalBatchingFees > 0 && <div className="projection-row"><span className="label">Batching Fees</span><span className="value">${costs.totalBatchingFees.toFixed(2)}</span></div>}
          <div className="projection-row"><span className="label">Taxes & Regulatory</span><span className="value">${costs.taxCost.toFixed(2)}</span></div>
          {abv > 0 && <div className="projection-row"><span className="label">Proof Gallons</span><span className="value">{counts.proofGallons.toLocaleString()} PG</span></div>}
        </div>
        <div className="section" style={{ margin: 0 }}>
          <div className="section-header">
            <div className="section-title">Component Matrix</div>
          </div>
          <div>
            <table>
              <thead>
                <tr>
                  <th>Category</th>
                  <th style={{ textAlign: 'right' }}>Per Unit</th>
                  <th style={{ textAlign: 'right' }}>Total Cost</th>
                  <th style={{ textAlign: 'right' }}>% of Total</th>
                </tr>
              </thead>
              <tbody>
                {breakdown.map((row) => (
                  <tr key={row.label}>
                    <td style={{ fontWeight: 600 }}>{row.label}</td>
                    <td style={{ textAlign: 'right', color: 'var(--text-secondary)' }}>${row.perUnit.toFixed(4)}</td>
                    <td style={{ textAlign: 'right', fontWeight: 600 }}>${row.cost.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}</td>
                    <td style={{ textAlign: 'right' }}>{row.pct.toFixed(1)}%</td>
                  </tr>
                ))}
              </tbody>
              <tfoot>
                <tr>
                  <td style={{ fontWeight: 700 }}>Total</td>
                  <td style={{ textAlign: 'right', fontWeight: 700 }}>${costs.costPerUnit.toFixed(4)}</td>
                  <td style={{ textAlign: 'right', fontWeight: 700 }}>${costs.totalCost.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}</td>
                  <td style={{ textAlign: 'right', fontWeight: 700 }}>100%</td>
                </tr>
              </tfoot>
            </table>
          </div>
        </div>
      </div>

      {/* Insight Cards */}
      <div className="insight-cards">
        <div className="insight-card">
          <h4>Throughput Tip</h4>
          <p>
            {cansPerMinute > 0 && counts.totalUnits > 0
              ? `At ${cansPerMinute} cans/min, this run takes ~${(counts.totalUnits / cansPerMinute / 60).toFixed(1)} hours of line time across ${counts.totalShifts.toFixed(1)} shifts.`
              : 'Configure line speed and quantities to see throughput analysis.'}
          </p>
        </div>
        <div className="insight-card">
          <h4>Stock Alert</h4>
          <p>
            {counts.totalUnits > 10000
              ? `Large run of ${counts.totalUnits.toLocaleString()} units. Verify raw material inventory is sufficient before scheduling.`
              : 'Run size is within standard inventory thresholds.'}
          </p>
        </div>
        <div className="insight-card">
          <h4>Margin Analysis</h4>
          <p>
            {costs.costPerUnit > 0
              ? `Unit cost of $${costs.costPerUnit.toFixed(3)} — packaging is ${costs.totalCost > 0 ? ((costs.packagingCost / costs.totalCost) * 100).toFixed(0) : 0}% of total cost.`
              : 'Enter rates to see margin breakdown.'}
          </p>
        </div>
      </div>
    </div>
  );
}
