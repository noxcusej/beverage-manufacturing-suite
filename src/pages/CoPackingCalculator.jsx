import { useState, useMemo, useEffect, useCallback } from 'react';
import { getClients, getCurrentBatch, getFormulas, getGlobalSettings, getInventory, getRuns, saveGlobalSettings, saveRun, deleteRun } from '../data/store';
import { getProducts, lookupPrice, NEW_ART_PREP_FEE } from '../data/drayhorsePricing';
import { exportCoPackingToExcel } from '../utils/exportExcel';
import { exportConsolidatedPOToExcel } from '../utils/exportConsolidatedPO';

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

const COMPLEXITY_LEVELS = {
  simple: { label: 'Simple', multiplier: 0.9 },
  standard: { label: 'Standard', multiplier: 1 },
  complex: { label: 'Complex', multiplier: 1.25 },
  specialty: { label: 'Specialty', multiplier: 1.5 },
};

function makeDefaultTollingEngine() {
  return {
    enabled: false,
    dailyRate: 2400,
    dailyPrice: 8000,
    casesPerDay: 750,
    changeoverRate: 500,
    changeoverPrice: 500,
    multidayDiscountPct: 10,
    complexity: 'standard',
  };
}

function normalizeTollingEngine(engine = {}) {
  const defaults = makeDefaultTollingEngine();
  const legacyDailyRate = engine.dailyRate ?? ((engine.hourlyRate ?? 0) > 0 ? engine.hourlyRate * 8 : undefined);
  const dailyRate = legacyDailyRate ?? defaults.dailyRate;
  const dailyPrice = engine.dailyPrice ?? engine.priceDailyRate ?? dailyRate;
  const changeoverRate = engine.changeoverRate ?? defaults.changeoverRate;
  return {
    enabled: engine.enabled ?? defaults.enabled,
    dailyRate,
    dailyPrice,
    casesPerDay: engine.casesPerDay ?? defaults.casesPerDay,
    changeoverRate,
    changeoverPrice: engine.changeoverPrice ?? changeoverRate,
    multidayDiscountPct: engine.multidayDiscountPct ?? defaults.multidayDiscountPct,
    complexity: COMPLEXITY_LEVELS[engine.complexity] ? engine.complexity : defaults.complexity,
  };
}

function calcDiscountedDailyTotal(baseRate, days, discountPct) {
  if (days <= 0 || baseRate <= 0) return { total: 0, effectiveRate: 0 };
  const discount = Math.min(95, Math.max(0, discountPct || 0)) / 100;
  let remainingDays = days;
  let dayIndex = 0;
  let total = 0;
  while (remainingDays > 0) {
    const dayWeight = Math.min(1, remainingDays);
    total += baseRate * (1 - discount) ** dayIndex * dayWeight;
    remainingDays -= dayWeight;
    dayIndex += 1;
  }
  return { total, effectiveRate: total / days };
}

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
    { id: 'toll-price-per-can', name: 'Tolling Price / Can', feeType: 'per-unit', rate: 0.08, qty: 0, qtyManual: false },
    { id: 'toll-case-pack', name: 'Case & Carton Packing', feeType: 'per-case', rate: 0.75, qty: 0, qtyManual: false },
    { id: 'toll-variety', name: 'Variety Pack Assembly', feeType: 'per-case', rate: 0.35, qty: 0, qtyManual: false },
  ];
}

function ensureStandardTolling(items) {
  const existing = (items || []).map((item) => (
    item.id === 'toll-production'
      ? { ...item, id: 'toll-price-per-can', name: 'Tolling Price / Can' }
      : item
  ));
  const byId = new Map(existing.map((item) => [item.id, item]));
  makeDefaultTolling().forEach((item) => {
    if (!byId.has(item.id)) byId.set(item.id, item);
  });
  return Array.from(byId.values());
}

function makeDefaultBOM() {
  return [
    { id: 'bom-stabilization', name: 'Stabilization', feeType: 'per-unit', rate: 0.02, qty: 0, qtyManual: false },
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
  lbs_g: 453.592, g_lbs: 0.00220462, oz_lbs: 0.0625, lbs_oz: 16,
  gal_ml: 3785.41, ml_gal: 0.000264172, ml_L: 0.001, L_ml: 1000,
};
const weightUnits = new Set(['lbs', 'lb', 'kg', 'g', 'oz']);
const volumeUnits = new Set(['gal', 'L', 'ml', 'fl oz']);

function convertUnit(value, from, to) {
  if (from === to) return value;
  const normalizedFrom = from === 'fl oz' ? 'oz' : from;
  const normalizedTo = to === 'fl oz' ? 'oz' : to;
  if (normalizedFrom !== from || normalizedTo !== to) return convertUnit(value, normalizedFrom, normalizedTo);
  const key = `${from}_${to}`;
  if (conversions[key]) return value * conversions[key];
  const rev = `${to}_${from}`;
  if (conversions[rev]) return value / conversions[rev];
  return value;
}

function convertWithSG(value, from, to, sg) {
  if (from === to) return value;
  const fromIsWeight = weightUnits.has(from);
  const toIsWeight = weightUnits.has(to);
  const fromIsVolume = volumeUnits.has(from);
  const toIsVolume = volumeUnits.has(to);
  if (fromIsWeight && toIsVolume) {
    const lbs = convertUnit(value, from, 'lbs');
    const gal = (lbs / 8.345) * (sg || 1);
    return convertUnit(gal, 'gal', to);
  }
  if (fromIsVolume && toIsWeight) {
    const gal = convertUnit(value, from, 'gal');
    const lbs = (gal * 8.345) / (sg || 1);
    return convertUnit(lbs, 'lbs', to);
  }
  return convertUnit(value, from, to);
}

function calcFormulaIngredientCostPerCan(formula, batchSizeGal, fillOz) {
  if (!formula?.ingredients?.length || !fillOz || !batchSizeGal) return null;
  let baseYield = formula.baseYield || 100;
  if (formula.baseYieldUnit === 'L') baseYield = baseYield / 3.78541;
  const scaleFactor = batchSizeGal / baseYield;

  let totalCost = 0;
  for (const ing of formula.ingredients) {
    const scaledRecipe = (ing.recipeAmount || 0) * scaleFactor;
    let buyAmt = scaledRecipe;
    if (ing.recipeUnit && ing.buyUnit && ing.recipeUnit !== ing.buyUnit) {
      buyAmt = convertWithSG(scaledRecipe, ing.recipeUnit, ing.buyUnit, ing.specificGravity);
    }
    const orderQty = Math.ceil(buyAmt / (ing.moq || 1)) * (ing.moq || 1);
    totalCost += orderQty * (ing.pricePerBuyUnit || 0);
  }

  const cans = Math.floor((batchSizeGal * 128) / fillOz);
  return cans > 0 ? totalCost / cans : null;
}

function makeDefaultFlavor() {
  return { id: 'flv-' + Date.now(), formulaId: '', name: '', cases: 100, batchingFee: 0, ingredientCostOverride: '' };
}

function ensureStandardBOM(items) {
  const defaults = makeDefaultBOM();
  const byId = new Map((items || []).map((item) => [item.id, item]));
  defaults.forEach((item) => {
    if (!byId.has(item.id)) byId.set(item.id, item);
  });
  return Array.from(byId.values());
}

function stripLegacyFlavorFields(flavor) {
  const next = { ...flavor };
  delete next.stabilizationCost;
  delete next.ingredientCostAuto;
  if (next.ingredientCostOverride === undefined) next.ingredientCostOverride = '';
  return next;
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
  const [inventoryArr, setInventoryArr] = useState([]);
  const [clients, setClients] = useState([]);
  const [globalSettings, setGlobalSettings] = useState(getGlobalSettings);
  useEffect(() => {
    const refresh = () => {
      setAllFormulas(getFormulas());
      setInventoryArr(getInventory());
      setClients(getClients());
      setGlobalSettings(getGlobalSettings());
    };
    refresh();
    window.addEventListener('comanufacturing:datachange', refresh);
    return () => window.removeEventListener('comanufacturing:datachange', refresh);
  }, []);

  // Flavors in this run (each SKU has its own ingredient + stabilization cost)
  // cases = number of cases to produce for this SKU
  const [flavors, setFlavors] = useState([makeDefaultFlavor()]);

  // Drayhorse carton pricing
  const [cartonProduct, setCartonProduct] = useState('sleek-4pk');
  const [skuCount, setSkuCount] = useState(1);
  const [includeNewArt, setIncludeNewArt] = useState(false);

  // Line items
  const [packagingItems, setPackagingItems] = useState(makeDefaultPackaging);
  const [tollingItems, setTollingItems] = useState(() => ensureStandardTolling(makeDefaultTolling()));
  const [tollingEngine, setTollingEngine] = useState(normalizeTollingEngine);
  const [tollingCalculatorOpen, setTollingCalculatorOpen] = useState(false);
  const [bomItems, setBomItems] = useState(makeDefaultBOM);
  const [taxItems, setTaxItems] = useState(makeDefaultTaxes);

  // Run management
  const [savedRuns, setSavedRuns] = useState([]);
  const [currentRunId, setCurrentRunId] = useState(null);
  const [runName, setRunName] = useState('');
  const [runClient, setRunClient] = useState('');
  const [clientPickerOpen, setClientPickerOpen] = useState(false);
  useEffect(() => {
    const refresh = () => setSavedRuns(getRuns());
    refresh();
    window.addEventListener('comanufacturing:datachange', refresh);
    return () => window.removeEventListener('comanufacturing:datachange', refresh);
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

  const clientOptions = useMemo(() => {
    const names = new Set();
    clients.forEach((client) => { if (client.name) names.add(client.name); });
    allFormulas.forEach((formula) => { if (formula.client) names.add(formula.client); });
    savedRuns.forEach((run) => { if (run.client) names.add(run.client); });
    return Array.from(names).sort((a, b) => a.localeCompare(b));
  }, [clients, allFormulas, savedRuns]);

  const filteredClientOptions = useMemo(() => {
    const q = runClient.trim().toLowerCase();
    if (!q) return clientOptions.slice(0, 8);
    return clientOptions
      .filter((name) => name.toLowerCase().includes(q))
      .slice(0, 8);
  }, [clientOptions, runClient]);

  const tollingEstimate = useMemo(() => {
    const activeFlavors = counts.flavorRows.filter((row) => row.cases > 0);
    const tankCapacityLiters = Math.max(1, globalSettings.tollingTankCapacityLiters || 7500);
    const flavorTankRows = activeFlavors.map((row) => {
      const liters = row.gallons * 3.78541;
      return {
        id: row.id,
        name: row.name || 'Flavor',
        liters,
        tanks: Math.max(1, Math.ceil(liters / tankCapacityLiters)),
      };
    });
    const totalTanks = flavorTankRows.reduce((sum, row) => sum + row.tanks, 0);
    const changeovers = activeFlavors.length;
    const lineHours = cansPerMinute > 0 ? counts.totalUnits / cansPerMinute / 60 : 0;
    const totalLiters = counts.totalGallons * 3.78541;
    const productionDays = tollingEngine.casesPerDay > 0
      ? counts.totalCases / tollingEngine.casesPerDay
      : 0;
    const complexity = COMPLEXITY_LEVELS[tollingEngine.complexity] || COMPLEXITY_LEVELS.standard;
    const productionCost = productionDays * (tollingEngine.dailyRate || 0) * complexity.multiplier;
    const changeoverCost = changeovers * (tollingEngine.changeoverRate || 0);
    const totalCost = productionCost + changeoverCost;
    const discountedPrice = calcDiscountedDailyTotal(tollingEngine.dailyPrice || 0, productionDays, tollingEngine.multidayDiscountPct || 0);
    const productionPrice = discountedPrice.total * complexity.multiplier;
    const changeoverPrice = changeovers * (tollingEngine.changeoverPrice || 0);
    const calculatedPrice = productionPrice + changeoverPrice;
    const totalPrice = calculatedPrice;
    const margin = totalPrice - totalCost;
    const marginPct = totalPrice > 0 ? (margin / totalPrice) * 100 : 0;
    const costCentsPerCan = counts.totalUnits > 0 ? (totalCost / counts.totalUnits) * 100 : 0;
    const priceCentsPerCan = counts.totalUnits > 0 ? (totalPrice / counts.totalUnits) * 100 : 0;
    return {
      activeFlavorCount: activeFlavors.length,
      flavorTankRows,
      tankCapacityLiters,
      totalLiters,
      totalCases: counts.totalCases,
      totalTanks,
      changeovers,
      lineHours,
      productionDays,
      complexity,
      productionCost,
      changeoverCost,
      totalCost,
      discountedDailyPrice: discountedPrice.effectiveRate,
      productionPrice,
      changeoverPrice,
      calculatedPrice,
      totalPrice,
      margin,
      marginPct,
      costCentsPerCan,
      priceCentsPerCan,
    };
  }, [counts, cansPerMinute, tollingEngine, globalSettings.tollingTankCapacityLiters]);

  const formulaById = useMemo(() => Object.fromEntries(allFormulas.map((formula) => [formula.id, formula])), [allFormulas]);
  const fillOz = useMemo(() => {
    if (fillVolumeUnit === 'mL') return fillVolume / 29.5735;
    if (fillVolumeUnit === 'L') return fillVolume * 33.814;
    return fillVolume;
  }, [fillVolume, fillVolumeUnit]);

  const getCalculatedIngredientCostPerCan = useCallback((flavor) => {
    const formula = formulaById[flavor.formulaId];
    if (!formula) return 0;
    let batchGal = formula.batchSize || 500;
    if (formula.batchSizeUnit === 'L') batchGal = batchGal / 3.78541;
    return calcFormulaIngredientCostPerCan(formula, batchGal, fillOz) || 0;
  }, [formulaById, fillOz]);

  const getEffectiveIngredientCostPerCan = useCallback((flavor) => {
    if (flavor.ingredientCostOverride !== '' && flavor.ingredientCostOverride !== null && flavor.ingredientCostOverride !== undefined) {
      return Number(flavor.ingredientCostOverride) || 0;
    }
    return getCalculatedIngredientCostPerCan(flavor);
  }, [getCalculatedIngredientCostPerCan]);

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

    // Per-SKU ingredient costs are calculated from the selected formula.
    // Stabilization is handled as a standard BOM line item.
    let totalIngredientCost = 0;
    counts.flavorRows.forEach((fr) => {
      const flv = flavors.find((f) => f.id === fr.id);
      if (flv) {
        totalIngredientCost += getEffectiveIngredientCostPerCan(flv) * fr.cans;
      }
    });

    let tollingCost = 0;
    const tollRows = tollingItems.map((item) => {
      const lineCost = (item.rate || 0) * (item.qty || 0);
      tollingCost += lineCost;
      return { ...item, lineCost };
    });
    if (tollingEngine.enabled) tollingCost += tollingEstimate.totalPrice;

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

    return { pkgRows, tollRows, bomRows, taxRows, packagingCost: totalPackaging, rawPackagingCost: packagingCost, totalIngredientCost, tollingCost, tollingEngineCost: tollingEngine.enabled ? tollingEstimate.totalCost : 0, tollingEnginePrice: tollingEngine.enabled ? tollingEstimate.totalPrice : 0, bomCost, totalBatchingFees, taxCost, totalCost, costPerUnit, costPerCase };
  }, [packagingItems, tollingItems, bomItems, taxItems, flavors, counts, unitsPerCase, cartonCost, carrierType, getEffectiveIngredientCostPerCan, tollingEngine.enabled, tollingEstimate.totalCost, tollingEstimate.totalPrice]);

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

  const inventoryMap = useMemo(() => {
    const map = {};
    inventoryArr.forEach((item) => { map[item.id] = item; });
    return map;
  }, [inventoryArr]);

  const rawMaterialPO = useMemo(() => {
    const formulaById = Object.fromEntries(allFormulas.map((formula) => [formula.id, formula]));
    const caseCounts = {};
    counts.flavorRows.forEach((flavor) => {
      if (!flavor.formulaId || !flavor.cases) return;
      caseCounts[flavor.formulaId] = (caseCounts[flavor.formulaId] || 0) + flavor.cases;
    });

    const rowsByKey = {};
    Object.entries(caseCounts).forEach(([formulaId, cases]) => {
      const formula = formulaById[formulaId];
      if (!formula?.ingredients?.length || cases <= 0) return;
      const formulaUnitsPerCase = formula.unitsPerCase || unitsPerCase || 24;
      const units = cases * formulaUnitsPerCase;
      let unitOz = formula.unitSizeVal || fillVolume || 12;
      const unitSizeUnit = formula.unitSizeUnit || fillVolumeUnit || 'oz';
      if (unitSizeUnit === 'ml' || unitSizeUnit === 'mL') unitOz = unitOz / 29.5735;
      else if (unitSizeUnit === 'L') unitOz = unitOz * 33.814;
      const batchGal = (units * unitOz) / 128;
      let baseYieldGal = formula.baseYield || 100;
      if (formula.baseYieldUnit === 'L') baseYieldGal = baseYieldGal / 3.78541;
      const scaleFactor = baseYieldGal > 0 ? batchGal / baseYieldGal : 1;

      formula.ingredients.forEach((ingredient) => {
        const inventoryItem = inventoryMap[ingredient.inventoryId];
        const recipeAmount = (ingredient.recipeAmount || 0) * scaleFactor;
        const buyUnit = ingredient.buyUnit || ingredient.recipeUnit || 'gal';
        const required = ingredient.recipeUnit && ingredient.recipeUnit !== buyUnit
          ? convertWithSG(recipeAmount, ingredient.recipeUnit, buyUnit, ingredient.specificGravity)
          : recipeAmount;
        const key = ingredient.inventoryId || `draft:${ingredient.draftName || ingredient.name || 'unknown'}`;
        if (!rowsByKey[key]) {
          let onHand = ingredient.currentInventory || 0;
          const invUnit = ingredient.inventoryUnit || buyUnit;
          if (onHand > 0 && invUnit !== buyUnit) {
            onHand = convertWithSG(onHand, invUnit, buyUnit, ingredient.specificGravity);
          }
          rowsByKey[key] = {
            key,
            name: inventoryItem?.name || ingredient.draftName || ingredient.name || 'Unknown',
            sku: inventoryItem?.sku || '',
            vendor: inventoryItem?.vendor || 'No Vendor',
            buyUnit,
            required: 0,
            onHand: Math.max(0, onHand),
            moq: ingredient.moq || 1,
            price: ingredient.pricePerBuyUnit || 0,
            formulas: new Set(),
          };
        }
        rowsByKey[key].required += required;
        rowsByKey[key].formulas.add(formula.name);
        if ((ingredient.pricePerBuyUnit || 0) > 0) rowsByKey[key].price = ingredient.pricePerBuyUnit;
        if ((ingredient.moq || 1) > rowsByKey[key].moq) rowsByKey[key].moq = ingredient.moq;
      });
    });

    const rows = Object.values(rowsByKey).map((row) => {
      const netNeeded = Math.max(0, row.required - row.onHand);
      const orderQty = netNeeded <= 0 ? 0 : Math.ceil(netNeeded / (row.moq || 1)) * (row.moq || 1);
      return {
        ...row,
        netNeeded,
        orderQty,
        lineCost: orderQty * row.price,
        formulaCount: row.formulas.size,
      };
    }).sort((a, b) => a.vendor.localeCompare(b.vendor) || a.name.localeCompare(b.name));

    const byVendor = {};
    rows.forEach((row) => {
      if (!byVendor[row.vendor]) byVendor[row.vendor] = { rows: [], subtotal: 0 };
      byVendor[row.vendor].rows.push(row);
      byVendor[row.vendor].subtotal += row.lineCost;
    });

    return {
      caseCounts,
      selectedFormulas: Object.keys(caseCounts).map((id) => formulaById[id]).filter(Boolean),
      rows,
      byVendor,
      totalCost: rows.reduce((sum, row) => sum + row.lineCost, 0),
      missingPriceCount: rows.filter((row) => row.price <= 0 && row.orderQty > 0).length,
    };
  }, [allFormulas, counts.flavorRows, fillVolume, fillVolumeUnit, inventoryMap, unitsPerCase]);

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
      flavors: flavors.map((flavor) => ({
        ...flavor,
        ingredientCost: getEffectiveIngredientCostPerCan(flavor),
        calculatedIngredientCost: getCalculatedIngredientCostPerCan(flavor),
      })),
      carton: { cartonProduct, skuCount, includeNewArt },
      packagingItems,
      tollingEngine,
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
    if (run.flavors) setFlavors(run.flavors.map(stripLegacyFlavorFields));
    if (run.carton) {
      setCartonProduct(run.carton.cartonProduct || 'sleek-4pk');
      setSkuCount(run.carton.skuCount || 1);
      setIncludeNewArt(run.carton.includeNewArt || false);
    }
    if (run.packagingItems) setPackagingItems(run.packagingItems);
    if (run.tollingEngine) setTollingEngine(normalizeTollingEngine(run.tollingEngine));
    if (run.tollingItems) setTollingItems(ensureStandardTolling(run.tollingItems));
    if (run.bomItems) setBomItems(ensureStandardBOM(run.bomItems));
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

  // Load run from URL query param or batch on mount.
  useEffect(() => {
    const params = new URLSearchParams(window.location.search);
    const runId = params.get('run');
    if (runId) {
      const run = getRuns().find((r) => r.id === runId);
      if (run) {
        setCurrentRunId(run.id);
        setRunName(run.name);
        setRunClient(run.client || '');
        applyRunState(run);
        return;
      }
    }

    const batch = getCurrentBatch();
    if (batch) {
      setFlavors((p) => p.map((f, i) => {
        if (i !== 0) return f;
        return { ...f, formulaId: batch.formulaId || '', name: batch.formulaName || f.name, cases: batch.totalUnits ? Math.ceil(batch.totalUnits / unitsPerCase) : f.cases };
      }));
    }
    // This is an initial load from URL/current batch; later changes are user-driven.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  function handleNewRun() {
    setCurrentRunId(null);
    setRunName('');
    setRunClient('');
    setFillVolume(12); setFillVolumeUnit('oz'); setPackSize(4); setCarrierType('paktech');
    setAbv(0); setUnitsPerCase(24); setCasesPerPallet(80); setPalletsPerTruck(20); setCansPerMinute(400);
    setFlavors([makeDefaultFlavor()]);
    setCartonProduct('sleek-4pk'); setSkuCount(1); setIncludeNewArt(false);
    setPackagingItems(makeDefaultPackaging());
    setTollingEngine(normalizeTollingEngine());
    setTollingItems(ensureStandardTolling(makeDefaultTolling()));
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

  function exportRawMaterialsPO() {
    if (rawMaterialPO.selectedFormulas.length === 0) {
      alert('Select at least one formula flavor with cases before exporting raw materials.');
      return;
    }
    const ok = exportConsolidatedPOToExcel({
      selectedFormulas: rawMaterialPO.selectedFormulas,
      inventoryMap,
      caseCounts: rawMaterialPO.caseCounts,
      fgCosts: counts.flavorRows
        .filter((row) => row.formulaId && row.cases > 0)
        .map((row) => {
          const ingredientCost = getEffectiveIngredientCostPerCan(row);
          return {
            fgId: row.id,
            name: row.name || allFormulas.find((f) => f.id === row.formulaId)?.name || 'Flavor',
            totalUnits: row.cans,
            totalPacks: packSize > 0 ? Math.ceil(row.cans / packSize) : 0,
            totalCases: row.cases,
            totalPallets: row.pallets,
            nonMoqCost: ingredientCost * row.cans,
            grossCost: ingredientCost * row.cans,
            nonMoqPerUnit: ingredientCost,
            nonMoqPerPack: packSize > 0 ? ingredientCost * packSize : 0,
            nonMoqPerCase: ingredientCost * unitsPerCase,
            nonMoqPerPallet: row.cases > 0 ? (ingredientCost * row.cans / row.cases) * casesPerPallet : 0,
          };
        }),
    });
    if (!ok) alert('No valid formula ingredient requirements were found to export.');
  }

  // ── Render helper: fee table (shared by services, taxes) ──

  function renderFeeTable(rows, updateFn, resetFn, removeFn, addFn, addLabel, subtotal, drag) {
    return (
      <div style={{ overflowX: 'auto' }}>
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
      </div>
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
          <button className="btn" onClick={exportRawMaterialsPO}>Export Raw PO</button>
          <button className="btn btn-primary" onClick={handleSaveRun}>
            {currentRunId ? 'Save' : 'Save Configuration'}
          </button>
        </div>
      </div>

      {/* Run Name + Client */}
      <div style={{ display: 'flex', gap: 12, marginBottom: 16 }}>
        <div style={{ position: 'relative', width: 220 }}>
          <input
            type="text"
            value={runClient}
            placeholder="Client name..."
            style={{ width: '100%', padding: '10px 14px', border: '1px solid var(--border)', borderRadius: 'var(--radius)', fontSize: 14, fontFamily: 'inherit' }}
            onFocus={() => setClientPickerOpen(true)}
            onBlur={() => setTimeout(() => setClientPickerOpen(false), 150)}
            onChange={(e) => {
              setRunClient(e.target.value);
              setClientPickerOpen(true);
            }}
          />
          {clientPickerOpen && filteredClientOptions.length > 0 && (
            <div className="typeahead-dropdown" style={{ zIndex: 80 }}>
              {filteredClientOptions.map((name) => (
                <div
                  key={name}
                  className="typeahead-item"
                  onMouseDown={(e) => {
                    e.preventDefault();
                    setRunClient(name);
                    setClientPickerOpen(false);
                  }}
                >
                  <div className="typeahead-item-primary">{name}</div>
                </div>
              ))}
            </div>
          )}
        </div>
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
          <button className="btn btn-primary btn-small" onClick={() => setFlavors((p) => [...p, makeDefaultFlavor()])}>
            + Add Flavor
          </button>
        </div>
        <div style={{ overflowX: 'auto' }}>
          <table>
            <thead>
              <tr>
                <th style={{ width: 28 }}></th>
                <th>Formula</th>
                <th style={{ textAlign: 'right' }}>Cases</th>
                <th style={{ textAlign: 'right' }}>Ingr. $/can</th>
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
                          setFlavors((p) => p.map((f, i) => i === idx ? {
                            ...f,
                            formulaId: formula.id,
                            name: formula.name,
                            cases: formula.batchSize && unitsPerCase > 0
                              ? Math.ceil((formula.batchSize * (formula.batchSizeUnit === 'L' ? 33.814 / fillVolume : 128 / fillVolume)) / unitsPerCase)
                              : f.cases,
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
                  <td style={{ textAlign: 'right', minWidth: 150 }}>
                    <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'flex-end', gap: 4 }}>
                      <span style={{ color: 'var(--text-muted)', fontSize: 13 }}>$</span>
                      <input
                        type="number"
                        step="0.0001"
                        min="0"
                        value={row.ingredientCostOverride ?? ''}
                        placeholder={row.formulaId ? getCalculatedIngredientCostPerCan(row).toFixed(4) : '0.0000'}
                        title={row.formulaId ? `Calculated: $${getCalculatedIngredientCostPerCan(row).toFixed(4)}` : 'Manual ingredient cost per can'}
                        style={{ width: 88, textAlign: 'right', fontFamily: 'monospace', fontWeight: 700 }}
                        onChange={(e) => {
                          const next = e.target.value;
                          setFlavors((p) => p.map((f, i) => i === idx ? {
                            ...f,
                            ingredientCostOverride: next === '' ? '' : parseFloat(next) || 0,
                          } : f));
                        }}
                      />
                      {row.ingredientCostOverride !== '' && row.ingredientCostOverride !== undefined && (
                        <button
                          className="btn btn-small"
                          style={{ padding: '4px 6px', fontSize: 10 }}
                          title="Clear override and use calculated formula cost"
                          onClick={() => setFlavors((p) => p.map((f, i) => i === idx ? { ...f, ingredientCostOverride: '' } : f))}
                        >
                          Auto
                        </button>
                      )}
                    </div>
                    <div style={{ fontSize: 10, color: 'var(--text-muted)', marginTop: 3 }}>
                      {row.formulaId ? `calc $${getCalculatedIngredientCostPerCan(row).toFixed(4)}` : 'manual'}
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
                  <td style={{ textAlign: 'right', fontWeight: 600, fontSize: 12, color: 'var(--text-secondary)' }}>
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

      {/* Consolidated raw materials */}
      <div className="section" style={{ marginBottom: 20 }}>
        <div className="section-header">
          <div>
            <div className="section-title">Consolidated Raw Materials</div>
            <div style={{ fontSize: 12, color: 'var(--text-secondary)', marginTop: 2 }}>
              Aggregates all selected formula flavors, then applies on-hand and MOQ once per ingredient.
            </div>
          </div>
          <button className="btn btn-small" onClick={exportRawMaterialsPO} disabled={rawMaterialPO.rows.length === 0}>
            Export Raw PO
          </button>
        </div>
        {rawMaterialPO.rows.length === 0 ? (
          <div style={{ padding: 14, fontSize: 13, color: 'var(--text-secondary)' }}>
            Select formulas in the flavor lineup to see consolidated ingredient ordering.
          </div>
        ) : (
          <>
            <div className="cost-summary" style={{ gridTemplateColumns: 'repeat(3, 1fr)', marginBottom: 12 }}>
              <div className="cost-card">
                <div className="cost-card-label">Raw Material PO</div>
                <div className="cost-card-value">${rawMaterialPO.totalCost.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}</div>
                <div className="cost-card-subtitle">{rawMaterialPO.rows.length} consolidated ingredient{rawMaterialPO.rows.length !== 1 ? 's' : ''}</div>
              </div>
              <div className="cost-card">
                <div className="cost-card-label">Formula Coverage</div>
                <div className="cost-card-value">{rawMaterialPO.selectedFormulas.length}</div>
                <div className="cost-card-subtitle">formula{rawMaterialPO.selectedFormulas.length !== 1 ? 's' : ''} included</div>
              </div>
              <div className="cost-card">
                <div className="cost-card-label">Missing Prices</div>
                <div className="cost-card-value">{rawMaterialPO.missingPriceCount}</div>
                <div className="cost-card-subtitle">ordered items with $0 price</div>
              </div>
            </div>
            {Object.entries(rawMaterialPO.byVendor).map(([vendor, group]) => (
              <div key={vendor} style={{ marginBottom: 12, border: '1px solid var(--border-light)', borderRadius: 'var(--radius)', overflow: 'hidden' }}>
                <div style={{ padding: '9px 12px', background: 'var(--surface-alt)', display: 'flex', justifyContent: 'space-between', alignItems: 'center', fontSize: 13, fontWeight: 700 }}>
                  <span>{vendor}</span>
                  <span>${group.subtotal.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}</span>
                </div>
                <div style={{ overflowX: 'auto' }}>
                  <table>
                    <thead>
                      <tr>
                        <th>Ingredient</th>
                        <th>SKU</th>
                        <th style={{ textAlign: 'right' }}>Needed</th>
                        <th style={{ textAlign: 'right' }}>On Hand</th>
                        <th style={{ textAlign: 'right' }}>Net</th>
                        <th style={{ textAlign: 'right' }}>MOQ</th>
                        <th style={{ textAlign: 'right' }}>Order Qty</th>
                        <th>Unit</th>
                        <th style={{ textAlign: 'right' }}>Price</th>
                        <th style={{ textAlign: 'right' }}>Line Cost</th>
                      </tr>
                    </thead>
                    <tbody>
                      {group.rows.map((row) => {
                        const moqAdjusted = row.orderQty > row.netNeeded && row.netNeeded > 0;
                        return (
                          <tr key={row.key}>
                            <td>
                              <strong>{row.name}</strong>
                              <div style={{ fontSize: 11, color: 'var(--text-muted)' }}>{row.formulaCount} formula{row.formulaCount !== 1 ? 's' : ''}</div>
                            </td>
                            <td>{row.sku || '—'}</td>
                            <td style={{ textAlign: 'right', fontFamily: 'monospace' }}>{row.required.toFixed(2)}</td>
                            <td style={{ textAlign: 'right', fontFamily: 'monospace', color: row.onHand > 0 ? '#15803d' : 'var(--text-muted)' }}>
                              {row.onHand > 0 ? row.onHand.toFixed(2) : '—'}
                            </td>
                            <td style={{ textAlign: 'right', fontFamily: 'monospace', color: row.netNeeded <= 0 ? '#15803d' : undefined }}>
                              {row.netNeeded <= 0 ? 'Covered' : row.netNeeded.toFixed(2)}
                            </td>
                            <td style={{ textAlign: 'right', fontFamily: 'monospace' }}>{row.moq}</td>
                            <td style={{ textAlign: 'right', fontFamily: 'monospace', fontWeight: 700, color: moqAdjusted ? '#b45309' : undefined }}>
                              {row.orderQty.toFixed(2)}
                              {moqAdjusted && <span style={{ fontSize: 10, marginLeft: 4 }}>MOQ</span>}
                            </td>
                            <td>{row.buyUnit}</td>
                            <td style={{ textAlign: 'right', fontFamily: 'monospace' }}>{row.price > 0 ? '$' + row.price.toFixed(4) : '—'}</td>
                            <td style={{ textAlign: 'right', fontFamily: 'monospace', fontWeight: 700 }}>
                              {row.lineCost > 0 ? '$' + row.lineCost.toFixed(2) : '—'}
                            </td>
                          </tr>
                        );
                      })}
                    </tbody>
                  </table>
                </div>
              </div>
            ))}
          </>
        )}
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
        <div style={{ overflowX: 'auto' }}>
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
          <div>
            <div className="section-title">Tolling</div>
            <div style={{ fontSize: 12, color: 'var(--text-secondary)', marginTop: 2 }}>
              Standard tolling price lives in the line items. Use the calculator when you want a modeled reference price.
            </div>
          </div>
          <button
            className="btn btn-small"
            style={{
              background: tollingCalculatorOpen ? 'linear-gradient(135deg, #f97316, #ef4444)' : 'linear-gradient(135deg, #22c55e, #06b6d4)',
              color: 'white',
              border: 'none',
              boxShadow: '0 8px 18px rgba(6, 182, 212, 0.25)',
              fontWeight: 800,
            }}
            onClick={() => setTollingCalculatorOpen((open) => !open)}
          >
            {tollingCalculatorOpen ? 'Hide Calculator' : 'Tolling Calculator'}
          </button>
        </div>
        {tollingCalculatorOpen && (
        <div style={{ border: '1px solid var(--border-light)', borderRadius: 'var(--radius)', padding: 14, marginBottom: 14, background: 'var(--surface-alt)' }}>
          <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 12, marginBottom: 12 }}>
            <label style={{ display: 'flex', alignItems: 'center', gap: 8, fontSize: 13, fontWeight: 700 }}>
              <input
                type="checkbox"
                checked={tollingEngine.enabled}
                onChange={(e) => setTollingEngine((current) => ({ ...current, enabled: e.target.checked }))}
              />
              Use tolling engine in quote total
            </label>
            <div style={{ textAlign: 'right' }}>
              <div style={{ fontSize: 22, fontWeight: 900, color: tollingEngine.enabled ? 'var(--brand)' : 'var(--text-secondary)', fontFamily: 'monospace' }}>
                {tollingEstimate.priceCentsPerCan.toFixed(2)}¢/can
              </div>
              <div style={{ fontSize: 11, color: 'var(--text-muted)', fontFamily: 'monospace' }}>
                ${tollingEstimate.totalPrice.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })} price
              </div>
            </div>
          </div>

          <div style={{ fontSize: 12, color: 'var(--text-secondary)', marginBottom: 12, lineHeight: 1.45 }}>
            Price basis: calculated engine price. If you need to override price per can, add it as a Tolling line item below.
          </div>

          <div className="form-grid-3" style={{ marginBottom: 12 }}>
            <div className="form-group" style={{ margin: 0 }}>
              <label className="form-label">Daily Tolling Cost</label>
              <input
                type="number"
                value={tollingEngine.dailyRate}
                onChange={(e) => setTollingEngine((current) => ({ ...current, dailyRate: parseFloat(e.target.value) || 0 }))}
              />
            </div>
            <div className="form-group" style={{ margin: 0 }}>
              <label className="form-label">Daily Tolling Price</label>
              <input
                type="number"
                value={tollingEngine.dailyPrice}
                onChange={(e) => setTollingEngine((current) => ({ ...current, dailyPrice: parseFloat(e.target.value) || 0 }))}
              />
            </div>
            <div className="form-group" style={{ margin: 0 }}>
              <label className="form-label">Cases Per Day Output</label>
              <input
                type="number"
                value={tollingEngine.casesPerDay}
                onChange={(e) => setTollingEngine((current) => ({ ...current, casesPerDay: parseFloat(e.target.value) || 0 }))}
              />
            </div>
            <div className="form-group" style={{ margin: 0 }}>
              <label className="form-label">Complexity</label>
              <select
                value={tollingEngine.complexity}
                onChange={(e) => setTollingEngine((current) => ({ ...current, complexity: e.target.value }))}
              >
                {Object.entries(COMPLEXITY_LEVELS).map(([value, level]) => (
                  <option key={value} value={value}>{level.label} ({level.multiplier}x)</option>
                ))}
              </select>
            </div>
            <div className="form-group" style={{ margin: 0 }}>
              <label className="form-label">Changeover Cost</label>
              <input
                type="number"
                value={tollingEngine.changeoverRate}
                onChange={(e) => setTollingEngine((current) => ({ ...current, changeoverRate: parseFloat(e.target.value) || 0 }))}
              />
            </div>
            <div className="form-group" style={{ margin: 0 }}>
              <label className="form-label">Changeover Price</label>
              <input
                type="number"
                value={tollingEngine.changeoverPrice}
                onChange={(e) => setTollingEngine((current) => ({ ...current, changeoverPrice: parseFloat(e.target.value) || 0 }))}
              />
            </div>
            <div className="form-group" style={{ margin: 0 }}>
              <label className="form-label">Multi-Day Discount / Day (%)</label>
              <input
                type="number"
                min="0"
                max="95"
                step="0.25"
                value={tollingEngine.multidayDiscountPct}
                onChange={(e) => setTollingEngine((current) => ({ ...current, multidayDiscountPct: parseFloat(e.target.value) || 0 }))}
              />
            </div>
            <div className="form-group" style={{ margin: 0 }}>
              <label className="form-label">Global Tank Capacity (L)</label>
              <input
                type="number"
                value={globalSettings.tollingTankCapacityLiters || 7500}
                onChange={(e) => {
                  const next = parseFloat(e.target.value) || 1;
                  setGlobalSettings((current) => ({ ...current, tollingTankCapacityLiters: next }));
                  saveGlobalSettings({ tollingTankCapacityLiters: next });
                }}
              />
            </div>
          </div>

          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(140px, 1fr))', gap: 8 }}>
            {[
              ['Total Cases', tollingEstimate.totalCases.toLocaleString(undefined, { maximumFractionDigits: 1 })],
              ['Production Days', tollingEstimate.productionDays.toFixed(2)],
              ['Total Liquid', tollingEstimate.totalLiters.toLocaleString(undefined, { maximumFractionDigits: 0 }) + ' L'],
              ['Line Hours (Ref)', tollingEstimate.lineHours.toFixed(2)],
              ['Tanks Required', tollingEstimate.totalTanks.toLocaleString()],
              ['Changeovers', tollingEstimate.changeovers.toLocaleString()],
              ['Complexity', tollingEstimate.complexity.label],
              ['Avg Daily Price', '$' + tollingEstimate.discountedDailyPrice.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })],
              ['Cost Rate', tollingEstimate.costCentsPerCan.toFixed(2) + '¢/can'],
              ['Price Rate', tollingEstimate.priceCentsPerCan.toFixed(2) + '¢/can'],
              ['Engine Cost', '$' + tollingEstimate.totalCost.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })],
              ['Calculated Price', '$' + tollingEstimate.calculatedPrice.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })],
              ['Engine Price', '$' + tollingEstimate.totalPrice.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })],
              ['Gross Margin', tollingEstimate.marginPct.toFixed(1) + '%'],
            ].map(([label, value]) => (
              <div key={label} style={{ padding: 10, background: 'var(--surface)', border: '1px solid var(--border-light)', borderRadius: 6 }}>
                <div style={{ fontSize: 10, color: 'var(--text-muted)', fontWeight: 700, textTransform: 'uppercase', letterSpacing: 0.4 }}>{label}</div>
                <div style={{ fontSize: 15, fontWeight: 800, marginTop: 2 }}>{value}</div>
              </div>
            ))}
          </div>
          {tollingEstimate.flavorTankRows.length > 0 && (
            <div style={{ marginTop: 10, border: '1px solid var(--border-light)', borderRadius: 6, overflow: 'hidden', background: 'var(--surface)' }}>
              <div style={{ padding: '7px 10px', fontSize: 11, fontWeight: 800, color: 'var(--text-secondary)', textTransform: 'uppercase', letterSpacing: 0.4, background: 'var(--surface-alt)' }}>
                Tank Allocation by Flavor
              </div>
              {tollingEstimate.flavorTankRows.map((row) => (
                <div key={row.id} style={{ display: 'grid', gridTemplateColumns: '1fr 110px 80px', gap: 8, padding: '7px 10px', borderTop: '1px solid var(--border-light)', fontSize: 12 }}>
                  <span style={{ fontWeight: 700 }}>{row.name}</span>
                  <span style={{ textAlign: 'right', fontFamily: 'monospace' }}>{row.liters.toLocaleString(undefined, { maximumFractionDigits: 0 })} L</span>
                  <span style={{ textAlign: 'right', fontFamily: 'monospace', fontWeight: 800 }}>{row.tanks} tank{row.tanks !== 1 ? 's' : ''}</span>
                </div>
              ))}
            </div>
          )}
        </div>
        )}
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
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(320px, 1fr))', gap: 20, marginTop: 20, marginBottom: 20 }}>
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
          <div style={{ overflowX: 'auto' }}>
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
