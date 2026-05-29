import React, { useState, useMemo, useEffect, useCallback } from 'react';
import { getClients, getCurrentBatch, getFormulas, getGlobalSettings, getInventory, getRuns, saveGlobalSettings, saveRun, deleteRun, getPackaging, getServices } from '../data/store';
import { getProducts, lookupPrice, findTierUpOption, getQuantityTiers, NEW_ART_PREP_FEE } from '../data/drayhorsePricing';
import { exportCoPackingToExcel, exportCoPackingToGoogleSheets } from '../utils/exportExcel';
import { getGoogleClientId } from '../utils/googleSheets';
import { exportClientQuote } from '../utils/exportClientQuote';
import { computeRunResults } from '../utils/runResults';
import { exportRunComparison } from '../utils/exportRunComparison';
import { exportRunComparisonSheet } from '../utils/exportRunComparisonSheet';
import PackagingPlanModal from './runQuoting/PackagingPlanModal';
import { createEmptyPlan, computePlanDerived } from './runQuoting/packagingPlan';
import { FEE_TYPES } from '../utils/feeTypes';

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
  'per-paktech-pack': { bg: '#fce7f3', color: '#be185d' },
  'per-paktech-case': { bg: '#fbcfe8', color: '#9d174d' },
  'per-carton-pack': { bg: '#fee2e2', color: '#b91c1c' },
  'per-variety-pack': { bg: '#fef3c7', color: '#92400e' },
  'per-variety-case': { bg: '#fde68a', color: '#78350f' },
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
  const dailyRate = legacyDailyRate === 2200 ? defaults.dailyRate : legacyDailyRate ?? defaults.dailyRate;
  const savedDailyPrice = engine.dailyPrice ?? engine.priceDailyRate;
  const dailyPrice = savedDailyPrice === undefined || savedDailyPrice === 2200 || savedDailyPrice === 2400
    ? defaults.dailyPrice
    : savedDailyPrice;
  const changeoverRate = engine.changeoverRate ?? defaults.changeoverRate;
  const savedChangeoverPrice = engine.changeoverPrice;
  return {
    enabled: engine.enabled ?? defaults.enabled,
    dailyRate,
    dailyPrice,
    casesPerDay: engine.casesPerDay ?? defaults.casesPerDay,
    changeoverRate,
    changeoverPrice: savedChangeoverPrice === undefined || savedChangeoverPrice === 350
      ? defaults.changeoverPrice
      : savedChangeoverPrice,
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
    { id: 'pkg-carriers', name: 'PakTech Carriers', category: 'carriers', feeType: 'per-paktech-pack', rate: 0.12, qty: 0, qtyManual: false },
    { id: 'pkg-wrap', name: 'Stretch Wrap', category: 'wrap', feeType: 'per-pallet', rate: 4.00, qty: 0, qtyManual: false },
  ];
}

function makeDefaultTolling() {
  return [
    { id: 'toll-price-per-can', name: 'Tolling Price / Can', feeType: 'per-unit', rate: 0.08, qty: 0, qtyManual: false },
    { id: 'toll-case-pack', name: 'Case & Carton Packing', feeType: 'per-case', rate: 0.75, qty: 0, qtyManual: false },
    { id: 'toll-variety', name: 'Variety Pack Assembly', feeType: 'per-variety-case', rate: 0.50, qty: 0, qtyManual: false },
  ];
}

// Legacy-id remap for older saved runs; previously this also re-added missing
// default tolling rows, which made deletes impossible to persist across reloads.
// Note: per-variety-pack remains a valid fee-type choice for production
// rates, so we do NOT force-migrate toll-variety here.
function ensureStandardTolling(items) {
  return (items || []).map((item) => (
    item.id === 'toll-production'
      ? { ...item, id: 'toll-price-per-can', name: 'Tolling Price / Can' }
      : item
  ));
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
    const gal = lbs / (8.345 * (sg || 1));
    return convertUnit(gal, 'gal', to);
  }
  if (fromIsVolume && toIsWeight) {
    const gal = convertUnit(value, from, 'gal');
    const lbs = gal * 8.345 * (sg || 1);
    return convertUnit(lbs, 'lbs', to);
  }
  return convertUnit(value, from, to);
}

function resolvePurchaseTier({ inventoryItem, quantity, buyUnit, specificGravity, fallbackPrice, fallbackMoq }) {
  const tiers = [...(inventoryItem?.priceTiers || [])].sort((a, b) => (a.minQty || 0) - (b.minQty || 0));
  if (tiers.length === 0) {
    return { price: fallbackPrice || 0, moq: fallbackMoq || 1 };
  }

  const tierWithConvertedBounds = tiers.map((tier) => {
    const tierUnit = tier.buyUnit || buyUnit;
    const minQty = convertWithSG(tier.minQty || 0, tierUnit, buyUnit, specificGravity);
    const maxQty = tier.maxQty === null || tier.maxQty === undefined
      ? null
      : convertWithSG(tier.maxQty, tierUnit, buyUnit, specificGravity);
    return { tier, tierUnit, minQty, maxQty };
  });

  const selected = tierWithConvertedBounds.find(({ minQty, maxQty }) => (
    quantity >= minQty && (maxQty === null || quantity <= maxQty)
  )) || tierWithConvertedBounds[tierWithConvertedBounds.length - 1];

  const oneTierUnitInBuyUnit = convertWithSG(1, selected.tierUnit, buyUnit, specificGravity) || 1;
  const moq = convertWithSG(selected.tier.moq || selected.tier.minQty || 1, selected.tierUnit, buyUnit, specificGravity);

  return {
    price: (selected.tier.price || 0) / oneTierUnitInBuyUnit,
    moq: moq || 1,
  };
}

function makeDefaultFlavor() {
  return { id: 'flv-' + Date.now(), formulaId: '', name: '', cases: 100, batchingFee: 0 };
}

function stripLegacyFlavorFields(flavor) {
  const next = { ...flavor };
  delete next.stabilizationCost;
  delete next.ingredientCostAuto;
  delete next.ingredientCostOverride;
  return next;
}

// ── Auto-qty logic ──

function getFeeAutoQty(feeType, counts) {
  if (feeType === 'per-unit') return counts.totalUnits;
  if (feeType === 'per-pack') return counts.totalPacks;
  if (feeType === 'per-paktech-pack') return counts.totalPaktechPacks || 0;
  if (feeType === 'per-paktech-case') return counts.totalPaktechCases || 0;
  if (feeType === 'per-carton-pack') return counts.totalCartonPacks || 0;
  if (feeType === 'per-variety-pack') return counts.totalVarietyPacks || 0;
  if (feeType === 'per-variety-case') return counts.totalVarietyCases || 0;
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
  const [skuCountManual, setSkuCountManual] = useState(false);
  const [includeNewArt, setIncludeNewArt] = useState(false);

  // Line items
  const [packagingItems, setPackagingItems] = useState(makeDefaultPackaging);
  const [tollingItems, setTollingItems] = useState(() => ensureStandardTolling(makeDefaultTolling()));
  const [tollingEngine, setTollingEngine] = useState(normalizeTollingEngine);
  const [tollingCalculatorOpen, setTollingCalculatorOpen] = useState(false);

  const [bomItems, setBomItems] = useState(makeDefaultBOM);
  const [taxItems, setTaxItems] = useState(makeDefaultTaxes);

  // Packaging plan — how produced cans are split into straight/variety pack groups.
  // Empty plan == legacy single-pack-size math (backward compat).
  const [packagingPlan, setPackagingPlan] = useState(createEmptyPlan);
  const [packagingPlanOpen, setPackagingPlanOpen] = useState(false);

  function updatePackGroupPrice(groupId, rate) {
    const safeRate = Math.max(0, Number(rate) || 0);
    setPackagingPlan((prev) => ({
      ...prev,
      groups: (prev.groups || []).map((g) => (g.id === groupId
        ? { ...g, unitPrice: safeRate, unitPriceManual: true }
        : g)),
    }));
  }

  // Generic per-pack-group field update for label, category, feeType, qty
  // overrides, etc. Used by the editable rows inside Packaging Materials.
  function updatePackGroupField(groupId, field, value) {
    setPackagingPlan((prev) => ({
      ...prev,
      groups: (prev.groups || []).map((g) => (g.id === groupId ? { ...g, [field]: value } : g)),
    }));
  }

  function removePackGroup(groupId) {
    setPackagingPlan((prev) => ({
      ...prev,
      groups: (prev.groups || []).filter((g) => g.id !== groupId),
    }));
  }

  // Carrier switch. Only the auto-seeded carton tier price is cleared on
  // transition OUT of carton — a manually-typed unitPrice survives so the
  // user doesn't silently lose a rate they explicitly entered. They can
  // click the rate's "auto" pill to reset if they want.
  function updatePackGroupCarrier(groupId, nextCarrier) {
    setPackagingPlan((prev) => ({
      ...prev,
      groups: (prev.groups || []).map((g) => {
        if (g.id !== groupId) return g;
        const patch = { carrierType: nextCarrier };
        if (nextCarrier !== 'carton' && g.carrierType === 'carton') {
          // Auto-seeded unitPrice (no manual flag) is a stale carton tier
          // number; drop it. Manual unitPrice stays.
          if (!g.unitPriceManual) {
            patch.unitPrice = 0;
          }
        }
        return { ...g, ...patch };
      }),
    }));
  }

  // Run management
  const [savedRuns, setSavedRuns] = useState([]);
  const [currentRunId, setCurrentRunId] = useState(null);
  const [runName, setRunName] = useState('');
  const [runClient, setRunClient] = useState('');
  const [clientPickerOpen, setClientPickerOpen] = useState(false);
  // Bumped on every external state apply (load/new) so uncontrolled inputs remount with fresh defaultValue.
  const [stateVersion, setStateVersion] = useState(0);
  const [savedFlash, setSavedFlash] = useState(false);
  const [sheetsHint, setSheetsHint] = useState(false);
  const [sheetsResultUrl, setSheetsResultUrl] = useState(null);

  // Run comparison
  const [compareOpen, setCompareOpen] = useState(false);
  const [compareAId, setCompareAId] = useState('');
  const [compareBId, setCompareBId] = useState('');
  // 'total' = dollar comparison, 'perCase' = case unit-price comparison
  const [compareBasis, setCompareBasis] = useState('total');
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

  // Effective Drayhorse SKU count: in plan mode, defaults to the count of
  // distinct carton groups (each pack group = one carton artwork SKU)
  // unless the user manually overrides via `skuCountManual`.
  const effectiveSkuCount = useMemo(() => {
    if (skuCountManual) return skuCount;
    const cartonGroups = (packagingPlan?.groups || []).filter((g) => g.carrierType === 'carton');
    if (cartonGroups.length > 0) return cartonGroups.length;
    return skuCount;
  }, [skuCountManual, skuCount, packagingPlan]);

  // Derive everything packaging-related from the plan when one exists; fall
  // back to the legacy single-pack-size totals so old saved runs are unchanged.
  // effectiveCounts is what every downstream auto-quantity / carton cost / fee
  // calculation reads — `counts` stays the unaltered production-side numbers.
  const planDerived = useMemo(
    () => computePlanDerived(packagingPlan, counts.flavorRows, { unitsPerCase, casesPerPallet }),
    [packagingPlan, counts.flavorRows, unitsPerCase, casesPerPallet],
  );

  const effectiveCounts = useMemo(() => {
    if (!planDerived.active) {
      // Legacy: pack-specific counts derive from the single packSize.
      return {
        ...counts,
        totalPaktechPacks: carrierType === 'paktech' ? counts.totalPacks : 0,
        totalPaktechCases: carrierType === 'paktech' ? counts.totalCases : 0,
        totalCartonPacks: carrierType === 'carton' ? counts.totalPacks : 0,
        totalVarietyPacks: 0,
        totalVarietyCases: 0,
        totalStraightPacks: counts.totalPacks,
      };
    }
    // Plan-driven: pack/case/pallet totals come from the plan.
    const totalTrucks = palletsPerTruck > 0 ? Math.ceil(planDerived.totalPallets / palletsPerTruck) : 0;
    return {
      ...counts,
      totalPacks: planDerived.totalPacks,
      totalCases: planDerived.totalCases,
      totalPallets: planDerived.totalPallets,
      totalTrucks,
      totalPaktechPacks: planDerived.totalPaktechPacks,
      totalPaktechCases: planDerived.totalPaktechCases || 0,
      totalCartonPacks: planDerived.totalCartonPacks,
      totalVarietyPacks: planDerived.totalVarietyPacks,
      totalVarietyCases: planDerived.totalVarietyCases || 0,
      totalStraightPacks: planDerived.totalStraightPacks,
    };
  }, [counts, planDerived, carrierType, palletsPerTruck]);

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

  // Auto-populate packaging quantities — read effective (plan-aware) counts.
  useEffect(() => {
    setPackagingItems((prev) => prev.map((item) =>
      item.qtyManual ? item : { ...item, qty: getFeeAutoQty(item.feeType, effectiveCounts) }
    ));
  }, [effectiveCounts]);

  // Auto-populate tolling quantities
  useEffect(() => {
    setTollingItems((prev) => prev.map((item) =>
      item.qtyManual ? item : { ...item, qty: getFeeAutoQty(item.feeType, effectiveCounts) }
    ));
  }, [effectiveCounts]);

  // Auto-populate BOM quantities (with inbound freight estimate)
  useEffect(() => {
    setBomItems((prev) => prev.map((item) => {
      if (item.qtyManual) return item;
      const qty = item.id === 'bom-freight-in'
        ? Math.max(1, Math.ceil(effectiveCounts.totalPallets * 0.75))
        : getFeeAutoQty(item.feeType, effectiveCounts);
      return { ...item, qty };
    }));
  }, [effectiveCounts]);

  // Auto-populate tax quantities
  useEffect(() => {
    setTaxItems((prev) => prev.map((item) =>
      item.qtyManual ? item : { ...item, qty: getFeeAutoQty(item.feeType, effectiveCounts) }
    ));
  }, [effectiveCounts]);

  // ── Drayhorse carton cost ──
  // Plan-aware: when carton groups exist in the plan, price each group's
  // packsCount as cartons (carton qty == pack count), look up tiered price for
  // each, and sum. Falls back to the legacy single-carrier behavior otherwise.

  const cartonCost = useMemo(() => {
    const empty = { totalCost: 0, pricePerM: 0, pricePerCarton: 0, cartonQty: 0, groupBreakdown: [] };
    const artFee = includeNewArt ? NEW_ART_PREP_FEE : 0;

    if (planDerived.active) {
      const cartonGroups = planDerived.cartonGroups;
      if (cartonGroups.length === 0) return empty;
      const groupBreakdown = [];
      let totalCost = 0;
      let totalCartonQty = 0;
      cartonGroups.forEach((g) => {
        const cartonQty = g.packsCount || 0;
        if (cartonQty <= 0) return;
        const tier = lookupPrice(cartonProduct, cartonQty, effectiveSkuCount);
        const autoRate = tier?.pricePerCarton || 0;
        const groupTotal = autoRate * cartonQty;
        totalCost += groupTotal;
        totalCartonQty += cartonQty;
        groupBreakdown.push({
          groupId: g.id,
          groupLabel: g.label || `${g.type === 'variety' ? 'Variety' : 'Straight'} ${g.packSize}-pk`,
          cartonQty,
          pricePerCarton: autoRate,
          autoRate,
          totalCost: groupTotal,
          // Surfaced for the Carton Pricing block's warnings + tier-up UX.
          belowTier: !!tier?.belowTier,
          aboveMaxTier: !!tier?.aboveMaxTier,
          skuExtrapolated: !!tier?.skuExtrapolated,
          tierQty: tier?.tierQty,
        });
      });
      if (groupBreakdown.length === 0) return empty;
      const pricePerCarton = totalCartonQty > 0 ? totalCost / totalCartonQty : 0;
      return {
        totalCost: totalCost + artFee,
        pricePerM: pricePerCarton * 1000,
        pricePerCarton,
        cartonQty: totalCartonQty,
        groupBreakdown,
        artFee,
      };
    }

    // Legacy single-carrier behavior
    if (carrierType !== 'carton') return empty;
    const product = getProducts().find((p) => p.id === cartonProduct);
    const ps = product?.packSize || packSize;
    const cartonQty = ps > 0 ? Math.ceil(counts.totalUnits / ps) : 0;
    // effectiveSkuCount matches runResults.js so live and replay agree.
    // In legacy mode effectiveSkuCount falls through to skuCount anyway.
    const result = lookupPrice(cartonProduct, cartonQty, effectiveSkuCount);
    if (!result) return empty;
    return {
      totalCost: result.totalCost + artFee, pricePerM: result.pricePerM,
      pricePerCarton: result.pricePerCarton, cartonQty,
      tierQty: result.tierQty, artFee, groupBreakdown: [],
    };
  }, [carrierType, cartonProduct, effectiveSkuCount, counts.totalUnits, packSize, includeNewArt, planDerived]);

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

    // Use the run's pack/fill configuration to compute liquid volume — the run's
    // unitsPerCase + fillVolume are the source of truth for "what we're producing now,"
    // not the formula's stored format (which may be a different SKU size).
    const runUnitsPerCase = unitsPerCase || 24;
    let runUnitOz = fillVolume || 12;
    if (fillVolumeUnit === 'mL' || fillVolumeUnit === 'ml') runUnitOz = runUnitOz / 29.5735;
    else if (fillVolumeUnit === 'L') runUnitOz = runUnitOz * 33.814;

    const rowsByKey = {};
    Object.entries(caseCounts).forEach(([formulaId, cases]) => {
      const formula = formulaById[formulaId];
      if (!formula?.ingredients?.length || cases <= 0) return;
      const units = cases * runUnitsPerCase;
      const batchGal = (units * runUnitOz) / 128;
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
            inventoryItem,
            specificGravity: ingredient.specificGravity || inventoryItem?.specificGravity || 1,
            required: 0,
            onHand: Math.max(0, onHand),
            moq: ingredient.moq || 1,
            price: ingredient.pricePerBuyUnit || 0,
            formulas: new Set(),
            formulaDemands: {},
          };
        }
        rowsByKey[key].required += required;
        rowsByKey[key].formulas.add(formula.name);
        rowsByKey[key].formulaDemands[formulaId] = (rowsByKey[key].formulaDemands[formulaId] || 0) + required;
        if ((ingredient.pricePerBuyUnit || 0) > 0) rowsByKey[key].price = ingredient.pricePerBuyUnit;
        if ((ingredient.moq || 1) > rowsByKey[key].moq) rowsByKey[key].moq = ingredient.moq;
      });
    });

    const rows = Object.values(rowsByKey).map((row) => {
      const netNeeded = Math.max(0, row.required - row.onHand);
      const initialPurchaseInfo = resolvePurchaseTier({
        inventoryItem: row.inventoryItem,
        quantity: netNeeded > 0 ? netNeeded : row.required,
        buyUnit: row.buyUnit,
        specificGravity: row.specificGravity,
        fallbackPrice: row.price,
        fallbackMoq: row.moq,
      });
      let orderQty = netNeeded <= 0 ? 0 : Math.ceil(netNeeded / (initialPurchaseInfo.moq || 1)) * (initialPurchaseInfo.moq || 1);
      const finalPurchaseInfo = orderQty > 0
        ? resolvePurchaseTier({
          inventoryItem: row.inventoryItem,
          quantity: orderQty,
          buyUnit: row.buyUnit,
          specificGravity: row.specificGravity,
          fallbackPrice: initialPurchaseInfo.price,
          fallbackMoq: initialPurchaseInfo.moq,
        })
        : initialPurchaseInfo;
      orderQty = netNeeded <= 0 ? 0 : Math.ceil(netNeeded / (finalPurchaseInfo.moq || 1)) * (finalPurchaseInfo.moq || 1);
      const lineCost = orderQty * (finalPurchaseInfo.price || 0);
      const allocatedCosts = {};
      Object.entries(row.formulaDemands).forEach(([formulaId, formulaDemand]) => {
        allocatedCosts[formulaId] = row.required > 0 ? lineCost * (formulaDemand / row.required) : 0;
      });
      return {
        ...row,
        inventoryItem: undefined,
        netNeeded,
        moq: finalPurchaseInfo.moq || 1,
        price: finalPurchaseInfo.price || 0,
        orderQty,
        lineCost,
        allocatedCosts,
        formulaCount: row.formulas.size,
      };
    }).sort((a, b) => a.vendor.localeCompare(b.vendor) || a.name.localeCompare(b.name));

    const byVendor = {};
    rows.forEach((row) => {
      if (!byVendor[row.vendor]) byVendor[row.vendor] = { rows: [], subtotal: 0 };
      byVendor[row.vendor].rows.push(row);
      byVendor[row.vendor].subtotal += row.lineCost;
    });
    const allocatedCostByFormulaId = {};
    rows.forEach((row) => {
      Object.entries(row.allocatedCosts || {}).forEach(([formulaId, cost]) => {
        allocatedCostByFormulaId[formulaId] = (allocatedCostByFormulaId[formulaId] || 0) + cost;
      });
    });
    const costPerCanByFormulaId = {};
    Object.entries(allocatedCostByFormulaId).forEach(([formulaId, cost]) => {
      // Match the unitsPerCase used for batch sizing above so the per-can cost,
      // when multiplied back by run-level cans, recovers the same total.
      const totalUnits = (caseCounts[formulaId] || 0) * runUnitsPerCase;
      costPerCanByFormulaId[formulaId] = totalUnits > 0 ? cost / totalUnits : 0;
    });

    return {
      caseCounts,
      selectedFormulas: Object.keys(caseCounts).map((id) => formulaById[id]).filter(Boolean),
      rows,
      byVendor,
      allocatedCostByFormulaId,
      costPerCanByFormulaId,
      totalCost: rows.reduce((sum, row) => sum + row.lineCost, 0),
      missingPriceCount: rows.filter((row) => row.price <= 0 && row.orderQty > 0).length,
    };
  }, [allFormulas, counts.flavorRows, fillVolume, fillVolumeUnit, inventoryMap, unitsPerCase]);

  const getCalculatedIngredientCostPerCan = useCallback((flavor) => {
    return rawMaterialPO.costPerCanByFormulaId[flavor.formulaId] || 0;
  }, [rawMaterialPO.costPerCanByFormulaId]);

  const getEffectiveIngredientCostPerCan = useCallback((flavor) => getCalculatedIngredientCostPerCan(flavor), [getCalculatedIngredientCostPerCan]);

  // ── Cost calculations ──

  const costs = useMemo(() => {
    const totalBatchingFees = flavors.reduce((s, f) => s + (f.batchingFee || 0), 0);

    // Legacy zero-out rule: when no packaging plan exists and the run is
    // single-carrier carton, suppress carrier line items. With a plan in play
    // carrier line items use carrier-specific fee types (per-paktech-pack /
    // per-carton-pack), so they self-zero when their carrier has no packs.
    let packagingCost = 0;
    const pkgRowsFromItems = packagingItems.map((item) => {
      const legacySuppress = !planDerived.active && item.category === 'carriers' && carrierType === 'carton';
      // In plan mode, the default PakTech Carriers row is replaced by
      // per-pack-group unitPrice — suppress it so the user isn't double-
      // billed when the pack-group rate is non-zero. (Custom carrier rows
      // with other ids stay active.)
      const planSuppressDefaultCarriers = planDerived.active && item.id === 'pkg-carriers';
      if (legacySuppress || planSuppressDefaultCarriers) {
        return { ...item, lineCost: 0, inactive: true };
      }
      const lineCost = (item.rate || 0) * (item.qty || 0);
      packagingCost += lineCost;
      return { ...item, lineCost, inactive: false };
    });

    // Pack-group rows — one per pack group in the active plan. Each row is
    // an editable Packaging Materials line item: name, category, feeType,
    // rate, qty (with manual override). Pre-filled from the plan but fully
    // editable; edits write back to packagingPlan.groups[*].
    const packGroupRows = [];
    // pricePerCarton already reflects any legacy cartonRateManual/Override
    // on the group, so reading from it keeps legacy saved runs consistent
    // between the Drayhorse block and the pack-group row.
    const cartonAutoByGroup = Object.fromEntries(
      (cartonCost.groupBreakdown || []).map((gb) => [gb.groupId, gb.pricePerCarton || 0])
    );
    if (planDerived.active) {
      const flavorById = Object.fromEntries(counts.flavorRows.map((f) => [f.id, f]));
      planDerived.groups.forEach((g) => {
        const description = g.label || (g.type === 'straight'
          ? `${flavorById[g.skuId]?.name || 'Straight'} ${g.packSize}-pk`
          : (() => {
            const names = (g.mix || []).filter((m) => (m.cans || 0) > 0).map((m) => flavorById[m.skuId]?.name || m.skuId).join(' / ');
            return names ? `Variety ${g.packSize}-pk (${names})` : `Variety ${g.packSize}-pk`;
          })());
        // Auto-seed: carton pack groups default to the Drayhorse tier price
        // when the user hasn't manually overridden. Any non-carton group
        // (or carton group with a manual rate) reads g.unitPrice directly.
        const cartonAuto = cartonAutoByGroup[g.id] || 0;
        const rate = g.unitPriceManual
          ? (Number(g.unitPrice) || 0)
          : (g.carrierType === 'carton' ? cartonAuto : (Number(g.unitPrice) || 0));
        const category = g.category || (g.type === 'variety' ? 'carriers' : 'cases');
        const feeType = g.feeType || 'per-pack';
        // Group-scoped count basis — every relevant fee type maps to THIS
        // group's totals (not the run-wide aggregates that would leak in
        // via the spread).
        const isPaktech = g.carrierType === 'paktech';
        const isCarton = g.carrierType === 'carton';
        const isVariety = g.type === 'variety';
        // Every count scoped to THIS group. Pallets pro-rate from the group's
        // cases; proof gallons pro-rate by the group's cans share; per-batch
        // is 1 (the group itself).
        // Derive from raw cans → single Math.ceil. Reading from g.casesConsumed
        // double-rounds (cases already ceil'd) so two groups of 1 case each
        // would otherwise read as 2 pallets when the truth is 1.
        const groupPallets = (casesPerPallet > 0 && unitsPerCase > 0)
          ? Math.ceil((g.cansConsumed || 0) / (unitsPerCase * casesPerPallet))
          : 0;
        const groupProofGallons = counts.totalUnits > 0
          ? Math.round(((g.cansConsumed || 0) / counts.totalUnits) * (counts.proofGallons || 0) * 100) / 100
          : 0;
        const groupCounts = {
          ...effectiveCounts,
          totalPacks: g.packsCount || 0,
          totalCases: g.casesConsumed || 0,
          totalUnits: g.cansConsumed || 0,
          totalPallets: groupPallets,
          proofGallons: groupProofGallons,
          flavorCount: 1,
          totalPaktechPacks: isPaktech ? (g.packsCount || 0) : 0,
          totalPaktechCases: isPaktech ? (g.casesConsumed || 0) : 0,
          totalCartonPacks: isCarton ? (g.packsCount || 0) : 0,
          totalVarietyPacks: isVariety ? (g.packsCount || 0) : 0,
          totalVarietyCases: isVariety ? (g.casesConsumed || 0) : 0,
          totalStraightPacks: !isVariety ? (g.packsCount || 0) : 0,
        };
        const autoQty = getFeeAutoQty(feeType, groupCounts);
        const qty = g.qtyManual ? (g.qtyOverride ?? autoQty) : autoQty;
        packGroupRows.push({
          id: `pack-${g.id}`, name: g.label || description,
          category, feeType,
          rate, qty,
          lineCost: rate * qty,
          inactive: false, synthetic: true, packGroup: true, packGroupId: g.id,
          qtyManual: !!g.qtyManual,
          unitPriceManual: !!g.unitPriceManual,
          autoRate: cartonAuto,
          // Description for screen-reader / fallback when label is empty
          autoDescription: description,
        });
      });
    }
    packGroupRows.forEach((r) => { packagingCost += r.lineCost; });

    // In plan mode the pack-group row's $/pack is the single source of
    // truth for carton pricing — the Drayhorse Carton Pricing block on the
    // page still shows what the tier lookup would charge as a reference,
    // but it does NOT add a separate line item to the BOM.
    //
    // Legacy single-carrier-carton mode (no plan) still gets a synthetic
    // row so cartons aren't lost in pre-plan runs.
    const cartonRows = [];
    if (!planDerived.active && cartonCost.totalCost > 0) {
      cartonRows.push({
        id: 'carton-legacy', name: 'Cartons (Drayhorse)',
        category: 'cases', feeType: 'per-carton-pack',
        rate: cartonCost.pricePerCarton || 0, qty: cartonCost.cartonQty || 0,
        lineCost: cartonCost.totalCost, inactive: false, synthetic: true,
      });
    }
    cartonRows.forEach((r) => { packagingCost += r.lineCost; });
    const pkgRows = [...packGroupRows, ...cartonRows, ...pkgRowsFromItems];

    // Ingredient costs come from the consolidated raw-material PO allocation.
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

    // Cartons are now included in packagingCost via the synthetic rows above
    // — do NOT add cartonCost.totalCost again or we double-count.
    const totalPackaging = packagingCost;
    const totalCost = totalPackaging + totalIngredientCost + tollingCost + bomCost + totalBatchingFees + taxCost;
    const costPerUnit = counts.totalUnits > 0 ? totalCost / counts.totalUnits : 0;
    const costPerCase = costPerUnit * unitsPerCase;

    return { pkgRows, tollRows, bomRows, taxRows, packagingCost: totalPackaging, rawPackagingCost: packagingCost, totalIngredientCost, tollingCost, tollingEngineCost: tollingEstimate.totalCost, tollingEnginePrice: tollingEstimate.totalPrice, bomCost, totalBatchingFees, taxCost, totalCost, costPerUnit, costPerCase };
  }, [packagingItems, tollingItems, bomItems, taxItems, flavors, counts, unitsPerCase, casesPerPallet, cartonCost, carrierType, planDerived, effectiveCounts, getEffectiveIngredientCostPerCan, tollingEstimate.totalCost, tollingEstimate.totalPrice]);

  const breakdown = useMemo(() => {
    const total = costs.totalCost;
    // Packaging Materials now includes cartons as synthetic line items, so
    // there's no separate "Cartons (Drayhorse)" line in the breakdown.
    const rows = [{ key: 'packaging', label: 'Packaging Materials', cost: costs.rawPackagingCost }];
    if (costs.totalIngredientCost > 0) rows.push({ key: 'ingredients', label: 'Ingredients (optimized PO)', cost: costs.totalIngredientCost });
    rows.push({ key: 'tolling', label: 'Tolling', cost: costs.tollingCost });
    rows.push({ key: 'bom', label: 'Freight & Other', cost: costs.bomCost });
    if (costs.totalBatchingFees > 0) rows.push({ key: 'batching', label: 'Batching Fees', cost: costs.totalBatchingFees });
    rows.push({ key: 'taxes', label: 'Taxes & Regulatory', cost: costs.taxCost });
    return rows.map((r) => ({
      ...r,
      perUnit: counts.totalUnits > 0 ? r.cost / counts.totalUnits : 0,
      pct: total > 0 ? (r.cost / total) * 100 : 0,
    }));
  }, [costs, counts]);

  // ── Handlers ──

  function updateFeeItem(setter) {
    return (idx, field, value) => {
      setter((prev) => prev.map((item, i) => {
        if (i !== idx) return item;
        const u = { ...item, [field]: value };
        if (field === 'feeType' && !item.qtyManual) u.qty = getFeeAutoQty(value, effectiveCounts);
        if (field === 'qty') u.qtyManual = true;
        return u;
      }));
    };
  }

  function resetItemQty(setter) {
    return (idx) => setter((prev) => prev.map((item, i) => {
      if (i !== idx) return item;
      return { ...item, qty: getFeeAutoQty(item.feeType, effectiveCounts), qtyManual: false };
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

  // Catalog pickers — sourced from the Packaging and Services catalog pages.
  // Empty until the user populates those catalogs; the "+ From catalog…"
  // dropdown self-hides when its catalog is empty.
  const packagingCatalog = useMemo(() => (getPackaging() || []).filter((p) => p.name), []);
  const servicesCatalog = useMemo(() => (getServices() || []).filter((s) => s.name), []);
  function addFromCatalog(setter, idPrefix) {
    return (catItem) => {
      setter((p) => [
        ...p,
        {
          id: `${idPrefix}-${Date.now()}`,
          name: catItem.name,
          category: catItem.category || 'other',
          feeType: catItem.feeType || 'per-unit',
          rate: catItem.rate || 0,
          qty: getFeeAutoQty(catItem.feeType || 'per-unit', effectiveCounts),
          qtyManual: false,
        },
      ]);
    };
  }

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
      carton: { cartonProduct, skuCount, skuCountManual, includeNewArt },
      packagingItems,
      tollingEngine,
      tollingItems,
      bomItems,
      taxItems,
      packagingPlan,
    };
  }

  function handleExportClientQuote() {
    exportClientQuote({
      client: runClient.trim(),
      runName: runName.trim() || 'Production Quote',
      config: { fillVolume, fillVolumeUnit, packSize, carrierType, abv, unitsPerCase, casesPerPallet, palletsPerTruck, cansPerMinute },
      counts: effectiveCounts,
      costs,
      breakdown,
      flavors: counts.flavorRows,
      planDerived,
    });
  }

  function getCompareRun(id) {
    if (!id) return null;
    if (id === '__current__') {
      return { id: '__current__', name: runName.trim() || 'Current working run', client: runClient.trim(), ...collectRunState() };
    }
    return savedRuns.find((r) => r.id === id) || null;
  }

  function handleOpenCompare() {
    setCompareAId(currentRunId || '__current__');
    const other = savedRuns.find((r) => r.id !== currentRunId);
    setCompareBId(other ? other.id : '');
    setCompareOpen(true);
  }

  function handleExportComparison() {
    const runA = getCompareRun(compareAId);
    const runB = getCompareRun(compareBId);
    if (!runA || !runB) return;
    exportRunComparison(runA, runB, compareBasis);
  }

  function handleExportComparisonSheet() {
    const runA = getCompareRun(compareAId);
    const runB = getCompareRun(compareBId);
    if (!runA || !runB) return;
    exportRunComparisonSheet(runA, runB, compareBasis);
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
      setSkuCount(typeof run.carton.skuCount === 'number' && run.carton.skuCount > 0 ? run.carton.skuCount : 1);
      setSkuCountManual(!!run.carton.skuCountManual);
      setIncludeNewArt(run.carton.includeNewArt || false);
    }
    if (run.packagingItems) setPackagingItems(run.packagingItems);
    if (run.tollingEngine) setTollingEngine(normalizeTollingEngine(run.tollingEngine));
    if (run.tollingItems) {
      // One-shot migration: the toll-variety default changed from
      // per-variety-pack @ $0.15 to per-variety-case @ $0.50. If the row
      // still matches the OLD default profile (rate 0 or 0.15), migrate
      // to the new default. A customized rate is preserved as-is so
      // explicit user choices of per-variety-pack survive.
      const migratedTolling = run.tollingItems.map((item) => {
        if (item.id !== 'toll-variety' || item.feeType !== 'per-variety-pack') return item;
        const looksUnedited = item.rate === 0 || item.rate === 0.15;
        return looksUnedited ? { ...item, feeType: 'per-variety-case', rate: 0.50 } : item;
      });
      setTollingItems(ensureStandardTolling(migratedTolling));
    }
    if (run.bomItems) setBomItems(run.bomItems);
    if (run.taxItems) setTaxItems(run.taxItems);
    // Plan may legitimately be {groups: []} after a user clears it, so only
    // skip when the field is entirely absent (legacy run never had it).
    // One-shot migrations:
    //   - legacy cartonRateManual/Override → unitPrice/Manual (per group)
    //   - legacy plan-level straightPercent → per-group allocationPercent,
    //     then strip straightPercent so subsequent loads can't re-migrate
    //     over deliberate user edits.
    if (run.packagingPlan) {
      const plan = run.packagingPlan;
      const planAllocationMode = plan.allocationMode
        || (typeof plan.straightPercent === 'number' ? 'percent' : 'manual');
      const groupsHavePct = (plan.groups || []).some((g) => Number.isFinite(g.allocationPercent) && g.allocationPercent > 0);
      const sp = typeof plan.straightPercent === 'number'
        ? Math.max(0, Math.min(100, plan.straightPercent))
        : null;
      const migratedGroups = (plan.groups || []).map((g) => {
        let next = g;
        // Carton-rate migration
        if (g.cartonRateManual) {
          next = { ...next };
          if (!g.unitPriceManual) {
            next.unitPrice = Number(g.cartonRateOverride) || 0;
            next.unitPriceManual = true;
          }
          delete next.cartonRateManual;
          delete next.cartonRateOverride;
        }
        // Legacy straightPercent → per-group allocationPercent (only when
        // no group has explicit %s yet)
        if (sp !== null && !groupsHavePct && planAllocationMode === 'percent') {
          const straight = (plan.groups || []).filter((x) => x.type === 'straight');
          const variety = (plan.groups || []).filter((x) => x.type === 'variety');
          let spLocal = sp;
          let vpLocal = 100 - sp;
          if (straight.length === 0 && variety.length > 0) { vpLocal += spLocal; spLocal = 0; }
          if (variety.length === 0 && straight.length > 0) { spLocal += vpLocal; vpLocal = 0; }
          const perStraight = straight.length > 0 ? spLocal / straight.length : 0;
          const perVariety = variety.length > 0 ? vpLocal / variety.length : 0;
          next = { ...next, allocationPercent: g.type === 'straight' ? perStraight : perVariety };
        }
        return next;
      });
      const migrated = { ...plan, groups: migratedGroups, allocationMode: planAllocationMode };
      delete migrated.straightPercent; // stripped after migration
      setPackagingPlan(migrated);
    } else setPackagingPlan(createEmptyPlan());
    setStateVersion((v) => v + 1);
  }

  function handleSaveRun() {
    if (document.activeElement && typeof document.activeElement.blur === 'function') {
      document.activeElement.blur();
    }
    const name = runName.trim() || ('Run ' + new Date().toLocaleDateString());
    const run = saveRun({ id: currentRunId, name, client: runClient.trim(), ...collectRunState() });
    setCurrentRunId(run.id);
    setRunName(run.name);
    setSavedRuns(getRuns());
    setSavedFlash(true);
    setTimeout(() => setSavedFlash(false), 1400);
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
    setCartonProduct('sleek-4pk'); setSkuCount(1); setSkuCountManual(false); setIncludeNewArt(false);
    setPackagingItems(makeDefaultPackaging());
    setTollingEngine(normalizeTollingEngine());
    setTollingItems(ensureStandardTolling(makeDefaultTolling()));
    setBomItems(makeDefaultBOM());
    setTaxItems(makeDefaultTaxes());
    setPackagingPlan(createEmptyPlan());
    setStateVersion((v) => v + 1);
  }

  function handleDeleteRun(runId) {
    const run = savedRuns.find((r) => r.id === runId);
    if (!confirm(`Delete "${run?.name || 'this run'}"? This cannot be undone.`)) return;
    deleteRun(runId);
    setSavedRuns(getRuns());
    if (currentRunId === runId) { setCurrentRunId(null); setRunName(''); setRunClient(''); }
  }

  function handleDuplicateRun() {
    const baseName = (runName.trim() || 'Run').replace(/\s*\(Copy(?:\s+\d+)?\)\s*$/i, '');
    const existingNames = new Set(savedRuns.map((r) => r.name));
    let candidate = `${baseName} (Copy)`;
    let n = 2;
    while (existingNames.has(candidate)) { candidate = `${baseName} (Copy ${n})`; n += 1; }
    const run = saveRun({ id: null, name: candidate, client: runClient.trim(), ...collectRunState() });
    setCurrentRunId(run.id);
    setRunName(run.name);
    setSavedRuns(getRuns());
  }

  // Bundle the run state + (optional) raw-material PO inputs in the shape the
  // unified workbook export expects.
  function buildExportArgs() {
    return {
      run: { name: runName.trim() || 'Run Quote', client: runClient.trim(), ...collectRunState() },
      rawPO: rawMaterialPO.selectedFormulas.length > 0 ? {
        selectedFormulas: rawMaterialPO.selectedFormulas,
        inventoryMap,
        caseCounts: rawMaterialPO.caseCounts,
      } : null,
    };
  }

  // ── Render helper: fee table (shared by services, taxes) ──

  function renderFeeTable(rows, updateFn, resetFn, removeFn, addFn, addLabel, subtotal, drag, catalog, addFromCatalog) {
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
                    <input key={`rate-${row.id}-${stateVersion}`} type="text" inputMode="decimal" defaultValue={row.rate} style={{ width: 80, textAlign: 'right' }}
                      onChange={(e) => updateFn(idx, 'rate', e.target.value === '' ? 0 : +e.target.value || 0)}
                      onBlur={(e) => updateFn(idx, 'rate', e.target.value === '' ? 0 : +e.target.value || 0)} />
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
                  <button className="btn btn-small btn-danger" onClick={() => removeFn(idx)} aria-label="Remove row" title="Remove">x</button>
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
            <td colSpan={7} style={{ padding: '8px 12px', display: 'flex', gap: 8, alignItems: 'center' }}>
              <button className="btn btn-small" onClick={addFn} style={{ fontSize: 12 }}>+ {addLabel}</button>
              {catalog && catalog.length > 0 && addFromCatalog && (
                <select
                  value=""
                  onChange={(e) => {
                    const picked = catalog.find((c) => c.id === e.target.value);
                    if (picked) addFromCatalog(picked);
                    e.target.value = '';
                  }}
                  style={{ fontSize: 12 }}
                  aria-label="Import from catalog"
                >
                  <option value="">+ From catalog…</option>
                  {catalog.map((c) => (
                    <option key={c.id} value={c.id}>
                      {c.name} ({c.feeType} @ ${(c.rate || 0).toFixed(2)})
                    </option>
                  ))}
                </select>
              )}
            </td>
          </tr>
        </tfoot>
      </table>
      </div>
    );
  }

  // ── Comparison view ──

  const compareOptions = [
    { id: '__current__', label: `${runName.trim() || 'Current working run'} (working)` },
    ...savedRuns.map((r) => ({ id: r.id, label: r.name + (r.client ? ` — ${r.client}` : '') })),
  ];
  const cmpRunA = compareOpen ? getCompareRun(compareAId) : null;
  const cmpRunB = compareOpen ? getCompareRun(compareBId) : null;
  const cmpA = cmpRunA ? computeRunResults(cmpRunA) : null;
  const cmpB = cmpRunB ? computeRunResults(cmpRunB) : null;

  const fmtMoney = (v, d = 2) => (v || 0).toLocaleString(undefined, { style: 'currency', currency: 'USD', minimumFractionDigits: d, maximumFractionDigits: d });
  const fmtNum = (v, d = 0) => (v || 0).toLocaleString(undefined, { minimumFractionDigits: d, maximumFractionDigits: d });
  const deltaColor = (v) => (v > 0.005 ? '#b91c1c' : v < -0.005 ? '#15803d' : 'var(--text-muted)');
  const signedMoney = (v, d = 2) => `${v > 0 ? '+' : v < 0 ? '-' : ''}${fmtMoney(Math.abs(v), d)}`;
  const signedNum = (v) => `${v > 0 ? '+' : v < 0 ? '-' : ''}${fmtNum(Math.abs(v))}`;
  const perCase = compareBasis === 'perCase';
  const basisCost = (res, cost) => (perCase ? (res.counts.totalCases > 0 ? cost / res.counts.totalCases : 0) : cost);
  const moneyDigits = perCase ? 4 : 2;

  function buildMetricRows() {
    if (!cmpA || !cmpB) return [];
    const m = (label, av, bv, fmt, signed, bold) => {
      const d = bv - av;
      return { label, a: fmt(av), b: fmt(bv), deltaStr: signed(d), deltaColor: deltaColor(d), bold };
    };
    return [
      m('Total Production Cost', cmpA.costs.totalCost, cmpB.costs.totalCost, (v) => fmtMoney(v), signedMoney, true),
      m('Cost per Can', cmpA.costs.costPerUnit, cmpB.costs.costPerUnit, (v) => fmtMoney(v, 4), signedMoney),
      m('Cost per Case', cmpA.costs.costPerCase, cmpB.costs.costPerCase, (v) => fmtMoney(v), signedMoney),
      m('Total Cans', cmpA.counts.totalUnits, cmpB.counts.totalUnits, (v) => fmtNum(v), signedNum),
      m('Total Cases', cmpA.counts.totalCases, cmpB.counts.totalCases, (v) => fmtNum(v), signedNum),
      m('Total Pallets', cmpA.counts.totalPallets, cmpB.counts.totalPallets, (v) => fmtNum(v), signedNum),
    ];
  }

  function buildBreakdownRows() {
    if (!cmpA || !cmpB) return [];
    const labels = [];
    [...cmpA.breakdown, ...cmpB.breakdown].forEach((r) => { if (!labels.includes(r.label)) labels.push(r.label); });
    const findCost = (bd, label) => (bd.find((r) => r.label === label)?.cost || 0);
    return labels.map((label) => {
      const av = basisCost(cmpA, findCost(cmpA.breakdown, label));
      const bv = basisCost(cmpB, findCost(cmpB.breakdown, label));
      const d = bv - av;
      return { label, a: fmtMoney(av, moneyDigits), b: fmtMoney(bv, moneyDigits), deltaStr: signedMoney(d, moneyDigits), deltaColor: deltaColor(d) };
    });
  }

  const cmpTh = { textAlign: 'left', padding: '8px 10px', fontSize: 11, fontWeight: 700, color: 'var(--text-muted)', textTransform: 'uppercase', letterSpacing: 0.4 };
  const cmpTd = { padding: '8px 10px', fontSize: 13, color: 'var(--text-primary)' };
  const renderCmpTable = (rows) => (
    <table style={{ width: '100%', borderCollapse: 'collapse' }}>
      <thead>
        <tr style={{ background: 'var(--surface)' }}>
          <th style={cmpTh}>Metric</th>
          <th style={{ ...cmpTh, textAlign: 'right' }}>Run A</th>
          <th style={{ ...cmpTh, textAlign: 'right' }}>Run B</th>
          <th style={{ ...cmpTh, textAlign: 'right' }}>Difference</th>
        </tr>
      </thead>
      <tbody>
        {rows.map((r, i) => (
          <tr key={i} style={{ borderTop: '1px solid var(--border-light)' }}>
            <td style={{ ...cmpTd, fontWeight: r.bold ? 700 : 500 }}>{r.label}</td>
            <td style={{ ...cmpTd, textAlign: 'right', fontWeight: r.bold ? 700 : 400 }}>{r.a}</td>
            <td style={{ ...cmpTd, textAlign: 'right', fontWeight: r.bold ? 700 : 400 }}>{r.b}</td>
            <td style={{ ...cmpTd, textAlign: 'right', fontWeight: 700, color: r.deltaColor }}>{r.deltaStr}</td>
          </tr>
        ))}
      </tbody>
    </table>
  );

  // ── JSX ──

  return (
    <div className="container">
      {/* Run Comparison Modal */}
      {sheetsResultUrl && (
        <div style={{
          position: 'fixed', bottom: 24, left: '50%', transform: 'translateX(-50%)',
          zIndex: 9100, background: '#0f172a', color: 'white',
          padding: '12px 18px', borderRadius: 8, boxShadow: '0 10px 25px -5px rgba(0,0,0,0.3)',
          display: 'flex', alignItems: 'center', gap: 12, fontSize: 13, maxWidth: 540,
        }}>
          <svg width="18" height="18" viewBox="0 0 48 48" aria-hidden="true" style={{ flexShrink: 0 }}>
            <path fill="#0F9D58" d="M37 6H11a3 3 0 0 0-3 3v30a3 3 0 0 0 3 3h26a3 3 0 0 0 3-3V9a3 3 0 0 0-3-3z"/>
            <path fill="#fff" d="M35 18H13v2.4h22zm0 5H13v2.4h22zm0 5H13v2.4h22z"/>
            <path fill="#fff" d="M18.5 18h2.5v15h-2.5z"/>
          </svg>
          <div>
            Your Google Sheet is ready.{' '}
            <a
              href={sheetsResultUrl} target="_blank" rel="noopener noreferrer"
              onClick={() => setSheetsResultUrl(null)}
              style={{ color: '#7dd3fc', textDecoration: 'underline', fontWeight: 600 }}
            >Open it →</a>
            <div style={{ fontSize: 11, color: '#94a3b8', marginTop: 2 }}>
              The browser blocked the auto-open popup; click the link.
            </div>
          </div>
          <button
            onClick={() => setSheetsResultUrl(null)}
            style={{
              background: 'transparent', border: 'none', color: '#cbd5e1',
              cursor: 'pointer', fontSize: 18, padding: 0, lineHeight: 1,
            }}
            aria-label="Dismiss"
          >×</button>
        </div>
      )}

      {sheetsHint && (
        <div style={{
          position: 'fixed', bottom: 24, left: '50%', transform: 'translateX(-50%)',
          zIndex: 9100, background: '#0f172a', color: 'white',
          padding: '12px 18px', borderRadius: 8, boxShadow: '0 10px 25px -5px rgba(0,0,0,0.3)',
          display: 'flex', alignItems: 'center', gap: 12, fontSize: 13, maxWidth: 540,
        }}>
          <svg width="18" height="18" viewBox="0 0 48 48" aria-hidden="true" style={{ flexShrink: 0 }}>
            <path fill="#0F9D58" d="M37 6H11a3 3 0 0 0-3 3v30a3 3 0 0 0 3 3h26a3 3 0 0 0 3-3V9a3 3 0 0 0-3-3z"/>
            <path fill="#fff" d="M35 18H13v2.4h22zm0 5H13v2.4h22zm0 5H13v2.4h22z"/>
            <path fill="#fff" d="M18.5 18h2.5v15h-2.5z"/>
          </svg>
          <div>
            Excel file downloaded. In the new Sheets tab: <strong>File → Import → Upload</strong>,
            drop the file, choose <strong>Replace spreadsheet</strong>.
          </div>
          <button
            onClick={() => setSheetsHint(false)}
            style={{
              background: 'transparent', border: 'none', color: '#cbd5e1',
              cursor: 'pointer', fontSize: 18, padding: 0, lineHeight: 1,
            }}
            aria-label="Dismiss"
          >×</button>
        </div>
      )}

      {packagingPlanOpen && (
        <PackagingPlanModal
          onClose={() => setPackagingPlanOpen(false)}
          onApply={(nextPlan) => setPackagingPlan(nextPlan)}
          initialPlan={packagingPlan}
          flavorRows={counts.flavorRows}
          unitsPerCase={unitsPerCase}
          casesPerPallet={casesPerPallet}
          defaultPackSize={packSize}
          escSuppressed={compareOpen}
        />
      )}

      {compareOpen && (
        <div className="command-palette-overlay" onClick={() => setCompareOpen(false)}>
          <div
            onClick={(e) => e.stopPropagation()}
            style={{ position: 'fixed', top: '4%', left: '50%', transform: 'translateX(-50%)', width: 940, maxWidth: '95vw', maxHeight: '92vh', overflowY: 'auto', background: 'white', borderRadius: 12, boxShadow: '0 25px 50px -12px rgba(0,0,0,0.25)', zIndex: 9001, padding: 24 }}
          >
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 16 }}>
              <h2 style={{ fontSize: 20, fontWeight: 800, margin: 0, color: 'var(--text-primary)' }}>Compare Runs</h2>
              <button className="btn btn-small" onClick={() => setCompareOpen(false)}>Close</button>
            </div>

            <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 16, marginBottom: 20 }}>
              {[['Run A', compareAId, setCompareAId, '#0f766e'], ['Run B', compareBId, setCompareBId, '#6d28d9']].map(([label, value, setter, color]) => (
                <div key={label}>
                  <div style={{ fontSize: 11, fontWeight: 700, color, textTransform: 'uppercase', letterSpacing: 0.5, marginBottom: 6 }}>{label}</div>
                  <select
                    value={value}
                    onChange={(e) => setter(e.target.value)}
                    style={{ width: '100%', padding: '9px 10px', border: '1px solid var(--border)', borderRadius: 6, fontSize: 14, fontFamily: 'inherit' }}
                  >
                    <option value="">Select a run...</option>
                    {compareOptions.map((o) => <option key={o.id} value={o.id}>{o.label}</option>)}
                  </select>
                </div>
              ))}
            </div>

            {(!cmpA || !cmpB) ? (
              <div style={{ padding: '40px 0', textAlign: 'center', color: 'var(--text-muted)', fontSize: 14 }}>
                {compareOptions.length < 2
                  ? 'Save at least one run to compare against the current working run.'
                  : 'Select two runs above to see them side by side.'}
              </div>
            ) : (
              <>
                <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 16, marginBottom: 20 }}>
                  {[[cmpRunA, cmpA, '#0f766e'], [cmpRunB, cmpB, '#6d28d9']].map(([run, res, color], i) => (
                    <div key={i} style={{ position: 'relative', border: '1px solid var(--border-light)', borderRadius: 'var(--radius)', padding: '16px 16px 16px 20px', background: 'var(--surface)' }}>
                      <div style={{ position: 'absolute', left: 0, top: 0, bottom: 0, width: 5, background: color, borderTopLeftRadius: 'var(--radius)', borderBottomLeftRadius: 'var(--radius)' }} />
                      <div style={{ fontSize: 11, fontWeight: 700, color: 'var(--text-muted)', textTransform: 'uppercase', letterSpacing: 0.5 }}>{i === 0 ? 'Run A' : 'Run B'}</div>
                      <div style={{ fontSize: 17, fontWeight: 800, color: 'var(--text-primary)', marginTop: 2 }}>{run.name}</div>
                      {run.client && <div style={{ fontSize: 12, color: 'var(--text-secondary)', marginTop: 2 }}>{run.client}</div>}
                      <div style={{ fontSize: 24, fontWeight: 800, color: 'var(--text-primary)', marginTop: 10 }}>{fmtMoney(res.costs.totalCost)}</div>
                      <div style={{ fontSize: 12, color: 'var(--text-muted)' }}>{fmtMoney(res.costs.costPerUnit, 4)} / can · {fmtNum(res.counts.totalUnits)} cans</div>
                    </div>
                  ))}
                </div>

                <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginBottom: 18 }}>
                  <span style={{ fontSize: 12, fontWeight: 700, color: 'var(--text-muted)', textTransform: 'uppercase', letterSpacing: 0.5 }}>Compare by</span>
                  <div style={{ display: 'inline-flex', border: '1px solid var(--border)', borderRadius: 8, overflow: 'hidden' }}>
                    {[['total', 'Dollar Total'], ['perCase', 'Per-Case Price']].map(([val, label]) => (
                      <button
                        key={val}
                        onClick={() => setCompareBasis(val)}
                        style={{
                          padding: '7px 14px', fontSize: 13, fontWeight: 600, border: 'none', cursor: 'pointer',
                          background: compareBasis === val ? 'var(--brand)' : 'transparent',
                          color: compareBasis === val ? '#fff' : 'var(--text-secondary)',
                        }}
                      >{label}</button>
                    ))}
                  </div>
                </div>

                <div style={{ marginBottom: 20 }}>
                  <div style={{ fontSize: 13, fontWeight: 700, color: 'var(--text-secondary)', marginBottom: 8 }}>Headline Metrics</div>
                  {renderCmpTable(buildMetricRows())}
                </div>

                <div style={{ marginBottom: 20 }}>
                  <div style={{ fontSize: 13, fontWeight: 700, color: 'var(--text-secondary)', marginBottom: 8 }}>
                    Cost Breakdown {compareBasis === 'perCase' ? '(per case)' : '(total $)'}
                  </div>
                  {renderCmpTable(buildBreakdownRows())}
                </div>

                <div style={{ display: 'flex', justifyContent: 'flex-end', gap: 8 }}>
                  <button className="btn" onClick={handleExportComparisonSheet}>Export Sheet</button>
                  <button className="btn btn-primary" onClick={handleExportComparison}>Export PDF</button>
                </div>
              </>
            )}
          </div>
        </div>
      )}

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
            <button className="btn" onClick={handleDuplicateRun} style={{ fontSize: 12 }}>Duplicate</button>
          )}
          {currentRunId && (
            <button className="btn btn-danger" onClick={() => handleDeleteRun(currentRunId)} style={{ fontSize: 12 }}>Delete</button>
          )}
          {(savedRuns.length > 0 || currentRunId) && (
            <button className="btn" onClick={handleOpenCompare}>Compare</button>
          )}
          <button className="btn" onClick={handleExportClientQuote}>Export Quote</button>
          <button className="btn" onClick={() => exportCoPackingToExcel(buildExportArgs())}>Export Excel</button>
          <button
            className="btn"
            onClick={() => {
              // OAuth path: do NOT pre-open a window. GIS needs the user-
              // gesture activation to open its OAuth popup; pre-opening
              // burns the activation and the popup gets blocked.
              // Fallback path: there's no OAuth popup, so we pre-open
              // the placeholder tab synchronously and later redirect it.
              const clientId = getGoogleClientId();
              const placeholderWin = !clientId && typeof window !== 'undefined'
                ? window.open('about:blank', '_blank')
                : null;
              exportCoPackingToGoogleSheets(buildExportArgs())
                .then((result) => {
                  if (result.mode === 'fallback') {
                    if (placeholderWin) {
                      try { placeholderWin.location.href = 'https://sheets.new'; } catch { /* ignore */ }
                    }
                    setSheetsHint(true);
                    setTimeout(() => setSheetsHint(false), 8000);
                    return;
                  }
                  // OAuth success — try to open the new Sheet. If the
                  // browser blocks the post-OAuth window, surface a
                  // click-to-open banner instead.
                  const win = typeof window !== 'undefined'
                    ? window.open(result.url, '_blank', 'noopener,noreferrer')
                    : null;
                  if (!win) setSheetsResultUrl(result.url);
                })
                .catch((err) => {
                  console.error('[Sheets export]', err);
                  if (placeholderWin) try { placeholderWin.close(); } catch { /* ignore */ }
                  alert(`Couldn't open in Sheets: ${err.message || err}`);
                });
            }}
            title="Open in Google Sheets"
            style={{ padding: '6px 10px', display: 'inline-flex', alignItems: 'center', justifyContent: 'center' }}
            aria-label="Open in Google Sheets"
          >
            <svg width="18" height="18" viewBox="0 0 48 48" aria-hidden="true">
              <path fill="#0F9D58" d="M37 6H11a3 3 0 0 0-3 3v30a3 3 0 0 0 3 3h26a3 3 0 0 0 3-3V9a3 3 0 0 0-3-3z"/>
              <path fill="#fff" d="M35 18H13v2.4h22zm0 5H13v2.4h22zm0 5H13v2.4h22z"/>
              <path fill="#fff" d="M18.5 18h2.5v15h-2.5z"/>
            </svg>
          </button>
          <button className="btn btn-primary" onClick={handleSaveRun}>
            {savedFlash ? 'Saved ✓' : (currentRunId ? 'Save' : 'Save Configuration')}
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
          <div className="cost-card-subtitle">Based on {effectiveCounts.totalPallets} pallets, {counts.totalShifts.toFixed(1)} shifts</div>
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

          {/* Packaging plan bar — modal entry point + compact summary. */}
          <div style={{
            display: 'flex', alignItems: 'center', justifyContent: 'space-between',
            gap: 12, padding: '8px 16px',
            background: planDerived.active && !planDerived.valid ? '#fef2f2' : 'var(--surface)',
            border: `1px solid ${planDerived.active && !planDerived.valid ? '#fecaca' : 'var(--border-light)'}`,
            borderRadius: 'var(--radius)', marginBottom: 20, fontSize: 13,
          }}>
            <div style={{ display: 'flex', alignItems: 'center', gap: 10, flexWrap: 'wrap' }}>
              <span style={{ color: 'var(--text-muted)', fontWeight: 700, fontSize: 11, textTransform: 'uppercase', letterSpacing: 0.5 }}>Packaging plan</span>
              {planDerived.active ? (
                <>
                  <span><strong>{planDerived.totalPacks.toLocaleString()}</strong> packs</span>
                  <span style={{ color: 'var(--border)' }}>·</span>
                  <span><strong>{planDerived.totalCases.toLocaleString()}</strong> cases</span>
                  <span style={{ color: 'var(--border)' }}>·</span>
                  <span><strong>{planDerived.totalVarietyPacks.toLocaleString()}</strong> variety</span>
                  <span style={{ color: 'var(--border)' }}>·</span>
                  <span style={{
                    color: planDerived.totalCansRemaining < 0 ? '#b91c1c'
                      : (planDerived.totalCansRemaining === 0 ? '#15803d' : 'var(--text-secondary)'),
                    fontWeight: 600,
                  }}>
                    {planDerived.totalCansRemaining.toLocaleString()} cans unallocated
                    {!planDerived.valid ? ' ⚠' : (planDerived.totalCansRemaining === 0 ? ' ✓' : '')}
                  </span>
                </>
              ) : (
                <span style={{ color: 'var(--text-muted)' }}>
                  Not configured — using the {packSize}-pk single pack size for all {counts.totalUnits.toLocaleString()} cans.
                </span>
              )}
            </div>
            <button className="btn btn-small" onClick={() => setPackagingPlanOpen(true)}>
              {planDerived.active ? 'Edit packaging…' : 'Configure packaging…'}
            </button>
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
                <th style={{ textAlign: 'right' }}>PO Blend $/can</th>
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
                          // Adopt the formula's unit (fill) size so the run, its quantities,
                          // and exports reflect the actual product (e.g. a 250 mL can, not the
                          // 12 oz default). Normalize the unit to this page's vocabulary ('mL').
                          let runFill = fillVolume;
                          let runUnit = fillVolumeUnit;
                          if (formula.unitSizeVal) {
                            runFill = formula.unitSizeVal;
                            const rawUnit = formula.unitSizeUnit || 'oz';
                            runUnit = rawUnit === 'ml' ? 'mL' : rawUnit;
                            setFillVolume(runFill);
                            setFillVolumeUnit(runUnit);
                          }
                          let fillOz = runFill;
                          if (runUnit === 'mL') fillOz = runFill / 29.5735;
                          else if (runUnit === 'L') fillOz = runFill * 33.814;
                          setFlavors((p) => p.map((f, i) => i === idx ? {
                            ...f,
                            formulaId: formula.id,
                            name: formula.name,
                            cases: formula.batchSize && unitsPerCase > 0 && fillOz > 0
                              ? Math.ceil((formula.batchSize * (formula.batchSizeUnit === 'L' ? 33.814 / fillOz : 128 / fillOz)) / unitsPerCase)
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
                    <div
                      title={row.formulaId ? 'Calculated from the consolidated raw-material PO after shared MOQ and on-hand inventory.' : 'Select a formula to calculate ingredient cost.'}
                      style={{ fontFamily: 'monospace', fontWeight: 800 }}
                    >
                      ${row.formulaId ? getCalculatedIngredientCostPerCan(row).toFixed(4) : '0.0000'}
                    </div>
                    <div style={{ fontSize: 10, color: 'var(--text-muted)', marginTop: 3 }}>
                      optimized PO blend
                    </div>
                  </td>
                  <td style={{ textAlign: 'right' }}>
                    <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'flex-end', gap: 2 }}>
                      <span style={{ color: 'var(--text-muted)', fontSize: 13 }}>$</span>
                      <input key={`bf-${row.id}-${stateVersion}`} type="text" inputMode="decimal" defaultValue={row.batchingFee} style={{ width: 70, textAlign: 'right' }}
                        onChange={(e) => setFlavors((p) => p.map((f, i) => i === idx ? { ...f, batchingFee: e.target.value === '' ? 0 : +e.target.value || 0 } : f))}
                        onBlur={(e) => setFlavors((p) => p.map((f, i) => i === idx ? { ...f, batchingFee: e.target.value === '' ? 0 : +e.target.value || 0 } : f))} />
                    </div>
                  </td>
                  <td style={{ textAlign: 'right', fontWeight: 600 }}>{row.cans.toLocaleString()}</td>
                  <td style={{ textAlign: 'right' }}>{row.cases.toLocaleString()}</td>
                  <td style={{ textAlign: 'right' }}>{row.pallets.toLocaleString()}</td>
                  <td>
                    {flavors.length > 1 && (
                      <button className="btn btn-small btn-danger" onClick={() => setFlavors((p) => p.filter((_, i) => i !== idx))} aria-label="Remove flavor" title="Remove flavor">x</button>
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
          <button className="btn btn-small" onClick={() => exportCoPackingToExcel(buildExportArgs())} disabled={rawMaterialPO.rows.length === 0}>
            Export Excel
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

      {/* Carton Pricing — shown when the run uses cartons (legacy single
          carrier) OR whenever a plan is active (so the user can flip any
          pack group back to Carton via the inline dropdown without
          unmounting the block). */}
      {(carrierType === 'carton' || (planDerived.active && planDerived.groups.length > 0)) && (
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
                <label className="form-label">
                  # of SKUs
                  {effectiveSkuCount !== skuCount && !skuCountManual && (
                    <span style={{ color: 'var(--text-muted)', fontWeight: 400, fontSize: 11, marginLeft: 6 }}>
                      (auto: {effectiveSkuCount})
                    </span>
                  )}
                </label>
                <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
                  <select
                    value={effectiveSkuCount}
                    onChange={(e) => {
                      setSkuCountManual(true);
                      setSkuCount(parseInt(e.target.value));
                    }}
                  >
                    {[1, 2, 3, 4, 5, 6, 8, 10, 12].map((n) => <option key={n} value={n}>{n} SKU{n > 1 ? 's' : ''}</option>)}
                  </select>
                  {skuCountManual && (
                    <button
                      type="button" className="btn btn-small"
                      onClick={() => setSkuCountManual(false)}
                      style={{ fontSize: 10, padding: '2px 6px' }}
                      title="Reset to auto (one per carton pack group)"
                    >
                      auto
                    </button>
                  )}
                </div>
              </div>
              <div className="form-group" style={{ margin: 0 }}>
                <label className="form-label">&nbsp;</label>
                <label style={{ display: 'flex', alignItems: 'center', gap: 8, fontSize: 13, cursor: 'pointer', height: 38 }}>
                  <input type="checkbox" checked={includeNewArt} onChange={(e) => setIncludeNewArt(e.target.checked)} />
                  New art prep (${NEW_ART_PREP_FEE})
                </label>
              </div>
            </div>
            {/* Per-group Drayhorse breakdown — only when plan-driven. Each
                row shows the group's tier lookup so the user can see why
                the pricing landed where it did. */}
            {planDerived.active && planDerived.groups.length > 0 && (
              <div style={{ marginTop: 16 }}>
                <div style={{ fontSize: 11, fontWeight: 700, color: 'var(--text-muted)', textTransform: 'uppercase', letterSpacing: 0.5, marginBottom: 6 }}>
                  Per-group tier lookup ({effectiveSkuCount} SKU{effectiveSkuCount > 1 ? 's' : ''})
                </div>
                <table style={{ width: '100%', fontSize: 12 }}>
                  <thead>
                    <tr style={{ color: 'var(--text-muted)' }}>
                      <th style={{ textAlign: 'left', padding: '4px 6px', fontWeight: 600 }}>Pack Group</th>
                      <th style={{ textAlign: 'left', padding: '4px 6px', fontWeight: 600 }}>Carrier</th>
                      <th style={{ textAlign: 'right', padding: '4px 6px', fontWeight: 600 }}>Cartons</th>
                      <th style={{ textAlign: 'right', padding: '4px 6px', fontWeight: 600 }}>$/Carton</th>
                      <th style={{ textAlign: 'right', padding: '4px 6px', fontWeight: 600 }}>Total</th>
                    </tr>
                  </thead>
                  <tbody>
                    {planDerived.groups.map((g) => {
                      const flavorById = Object.fromEntries(counts.flavorRows.map((f) => [f.id, f]));
                      const label = g.label || (g.type === 'straight'
                        ? `${flavorById[g.skuId]?.name || 'Straight'} ${g.packSize}-pk`
                        : `Variety ${g.packSize}-pk`);
                      const gb = (cartonCost.groupBreakdown || []).find((b) => b.groupId === g.id);
                      const isCarton = g.carrierType === 'carton';
                      const tierUp = (isCarton && gb)
                        ? findTierUpOption(cartonProduct, gb.cartonQty, effectiveSkuCount)
                        : null;
                      return (
                        <React.Fragment key={g.id}>
                          <tr style={{ borderTop: '1px solid var(--border-light)', opacity: isCarton ? 1 : 0.55 }}>
                            <td style={{ padding: '4px 6px' }}>
                              {label}
                              {isCarton && gb?.belowTier && (
                                <span style={{ marginLeft: 6, padding: '1px 6px', background: '#fef3c7', color: '#92400e', borderRadius: 4, fontSize: 10, fontWeight: 700 }}
                                  title={`Below smallest tier (${(getQuantityTiers()[0] || 10000).toLocaleString()}). Using tier-0 (cheapest-volume = highest $/M).`}>
                                  Below tier
                                </span>
                              )}
                              {isCarton && gb?.skuExtrapolated && (
                                <span style={{ marginLeft: 6, padding: '1px 6px', background: '#fee2e2', color: '#b91c1c', borderRadius: 4, fontSize: 10, fontWeight: 700 }}
                                  title="Drayhorse publishes 1-4 SKU pricing; 5+ SKUs are linearly extrapolated. Verify with Drayhorse for a binding quote.">
                                  5+ SKU est'd
                                </span>
                              )}
                            </td>
                            <td style={{ padding: '4px 6px' }}>
                              <select
                                value={g.carrierType || 'paktech'}
                                onChange={(e) => updatePackGroupCarrier(g.id, e.target.value)}
                                style={{ fontSize: 11, padding: '1px 4px' }}
                                title="Change a group's carrier to add or remove it from carton tier pricing"
                              >
                                <option value="paktech">PakTech</option>
                                <option value="carton">Carton</option>
                                <option value="shrink">Shrink-wrap</option>
                                <option value="none">None</option>
                              </select>
                            </td>
                            <td style={{ padding: '4px 6px', textAlign: 'right' }}>
                              {isCarton ? (g.packsCount || 0).toLocaleString() : '—'}
                            </td>
                            <td style={{ padding: '4px 6px', textAlign: 'right' }}>
                              {isCarton && gb ? `$${gb.pricePerCarton.toFixed(4)}` : '—'}
                            </td>
                            <td style={{ padding: '4px 6px', textAlign: 'right', fontWeight: 700 }}>
                              {isCarton && gb ? `$${gb.totalCost.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}` : '—'}
                            </td>
                          </tr>
                          {isCarton && tierUp && tierUp.savings > 0 && (
                            <tr style={{ background: '#ecfdf5' }}>
                              <td colSpan={5} style={{ padding: '4px 8px 6px 8px', fontSize: 11, color: '#065f46' }}>
                                💡 Stock up to <strong>{tierUp.nextTierQty.toLocaleString()}</strong> cartons
                                (<strong>+{tierUp.extraCartons.toLocaleString()}</strong>) and pay <strong>${tierUp.nextTierTotal.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}</strong>
                                instead of <strong>${tierUp.currentTotal.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}</strong>
                                — <strong style={{ color: '#16a34a' }}>save ${tierUp.savings.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}</strong>
                                {' '}(${tierUp.nextPricePerM.toFixed(2)}/M at the next tier). Extra cartons go to inventory.
                              </td>
                            </tr>
                          )}
                        </React.Fragment>
                      );
                    })}
                  </tbody>
                </table>
                <div style={{ marginTop: 6, fontSize: 11, color: 'var(--text-muted)' }}>
                  Only Carton-carrier groups are tier-priced. Switch a row's carrier above to include it.
                </div>
              </div>
            )}
            {cartonCost.cartonQty > 0 && (
              <div style={{ display: 'grid', gridTemplateColumns: 'repeat(4, 1fr)', gap: 12, marginTop: 16 }}>
                <div style={{ padding: 12, background: '#f0fdf4', border: '1px solid #bbf7d0', borderRadius: 6, textAlign: 'center' }}>
                  <div style={{ fontSize: 11, color: '#16a34a', fontWeight: 600 }}>Cartons</div>
                  <div style={{ fontSize: 18, fontWeight: 700, color: '#065f46' }}>{cartonCost.cartonQty.toLocaleString()}</div>
                </div>
                <div style={{ padding: 12, background: '#eff6ff', border: '1px solid #bfdbfe', borderRadius: 6, textAlign: 'center' }}>
                  <div style={{ fontSize: 11, color: '#3b82f6', fontWeight: 600 }}>Price / 1,000</div>
                  <div style={{ fontSize: 18, fontWeight: 700, color: '#1e40af' }}>${cartonCost.pricePerM.toFixed(2)}</div>
                  {cartonCost.tierQty != null && (
                    <div style={{ fontSize: 10, color: '#6b7280' }}>{cartonCost.tierQty.toLocaleString()}+ tier</div>
                  )}
                </div>
                <div style={{ padding: 12, background: '#fefce8', border: '1px solid #fef08a', borderRadius: 6, textAlign: 'center' }}>
                  <div style={{ fontSize: 11, color: '#ca8a04', fontWeight: 600 }}>Total</div>
                  <div style={{ fontSize: 18, fontWeight: 700, color: '#92400e' }}>
                    ${cartonCost.totalCost.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}
                  </div>
                  {cartonCost.artFee > 0 && <div style={{ fontSize: 10, color: '#6b7280' }}>incl. ${cartonCost.artFee} art</div>}
                </div>
                <div style={{ padding: 12, background: '#faf5ff', border: '1px solid #e9d5ff', borderRadius: 6, textAlign: 'center' }}>
                  <div style={{ fontSize: 11, color: '#7c3aed', fontWeight: 600 }}>
                    {planDerived.active && planDerived.cartonGroups.length > 1 ? 'Avg / Carton' : 'Per Carton'}
                  </div>
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
              {/* Editable rows are real `packagingItems` only. Synthetic
                  pack-group and carton rows are surfaced read-only in the
                  Pack Groups block above, so editing here can't accidentally
                  hit a synthetic row by index. */}
              {costs.pkgRows.filter((r) => !r.synthetic).map((row) => {
                const realIdx = packagingItems.findIndex((p) => p.id === row.id);
                const idx = realIdx;
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
                        <input key={`pkg-rate-${row.id}-${stateVersion}`} type="text" inputMode="decimal" defaultValue={row.rate} style={{ width: 80, textAlign: 'right' }}
                          onChange={(e) => updatePkg(idx, 'rate', e.target.value === '' ? 0 : +e.target.value || 0)}
                          onBlur={(e) => updatePkg(idx, 'rate', e.target.value === '' ? 0 : +e.target.value || 0)} />
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
                      <button className="btn btn-small btn-danger" onClick={() => setPackagingItems((p) => p.filter((_, i) => i !== idx))} aria-label="Remove packaging item" title="Remove packaging item">x</button>
                    </td>
                  </tr>
                );
              })}
              {/* Pack-group rows — pre-filled from the plan, fully editable
                  inline. Edits write back to packagingPlan.groups[*]. */}
              {costs.pkgRows.filter((r) => r.synthetic && r.packGroup).map((row) => {
                const catStyle = categoryColors[row.category] || categoryColors.other;
                const ftColors = feeTypeColors[row.feeType] || feeTypeColors.fixed;
                return (
                  <tr key={row.id}>
                    <td><span style={{ ...dragHandleStyle, opacity: 0.3, cursor: 'not-allowed' }} title="Pack groups are ordered by the plan">≡</span></td>
                    <td>
                      <input
                        type="text"
                        value={row.name}
                        placeholder={row.autoDescription || 'Pack group'}
                        style={{ width: '100%', minWidth: 120 }}
                        onChange={(e) => updatePackGroupField(row.packGroupId, 'label', e.target.value)}
                      />
                      <div style={{ fontSize: 10, color: 'var(--text-muted)', marginTop: 2 }}>From plan</div>
                    </td>
                    <td>
                      <select
                        value={row.category}
                        style={chipStyle(catStyle)}
                        onChange={(e) => updatePackGroupField(row.packGroupId, 'category', e.target.value)}
                      >
                        {PACKAGING_CATEGORIES.map((c) => <option key={c.value} value={c.value}>{c.label}</option>)}
                      </select>
                    </td>
                    <td>
                      <select
                        value={row.feeType}
                        style={chipStyle(ftColors)}
                        onChange={(e) => {
                          // Clear manual qty override AND clear qtyOverride
                          // so a stale value can't reappear if the user
                          // re-enables manual later. Single setter to avoid
                          // two-call race on draft state.
                          const nextFeeType = e.target.value;
                          setPackagingPlan((prev) => ({
                            ...prev,
                            groups: (prev.groups || []).map((g) => (g.id === row.packGroupId
                              ? { ...g, feeType: nextFeeType, qtyManual: false, qtyOverride: undefined }
                              : g)),
                          }));
                        }}
                      >
                        {FEE_TYPES.map((ft) => <option key={ft.value} value={ft.value}>{ft.label}</option>)}
                      </select>
                    </td>
                    <td style={{ textAlign: 'right' }}>
                      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'flex-end', gap: 4 }}>
                        <span style={{ color: '#6b7280', fontSize: 13 }}>$</span>
                        <input
                          key={`pack-rate-${row.id}-${row.rate}-${row.unitPriceManual}`}
                          type="text" inputMode="decimal" defaultValue={Number(row.rate || 0)}
                          style={{
                            width: 80, textAlign: 'right',
                            background: row.rate === 0 ? '#fef9c3' : undefined,
                          }}
                          onBlur={(e) => updatePackGroupPrice(row.packGroupId, e.target.value === '' ? 0 : +e.target.value || 0)}
                          title={
                            row.unitPriceManual
                              ? `Manual override. Click "auto" to revert to Drayhorse tier ($${(row.autoRate || 0).toFixed(4)}).`
                              : (row.autoRate > 0 ? `Auto-seeded from Drayhorse tier ($${row.autoRate.toFixed(4)}). Type to override.` : 'Pack rate')
                          }
                        />
                        {row.unitPriceManual && row.autoRate > 0 && (
                          <button
                            className="btn btn-small"
                            onClick={() => updatePackGroupField(row.packGroupId, 'unitPriceManual', false)}
                            title={`Reset to Drayhorse tier ($${(row.autoRate || 0).toFixed(4)})`}
                            style={{ padding: '2px 5px', fontSize: 10, lineHeight: 1 }}
                          >auto</button>
                        )}
                      </div>
                    </td>
                    <td style={{ textAlign: 'right' }}>
                      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'flex-end', gap: 4 }}>
                        <input
                          type="number" value={row.qty} min="0"
                          style={{ width: 80, textAlign: 'right' }}
                          onChange={(e) => {
                            const v = parseInt(e.target.value) || 0;
                            updatePackGroupField(row.packGroupId, 'qtyOverride', v);
                            updatePackGroupField(row.packGroupId, 'qtyManual', true);
                          }}
                        />
                        {row.qtyManual && (
                          <button className="btn btn-small"
                            onClick={() => {
                              // Clear both qtyManual and qtyOverride so the
                              // stale override can't reappear later.
                              setPackagingPlan((prev) => ({
                                ...prev,
                                groups: (prev.groups || []).map((g) => (g.id === row.packGroupId
                                  ? { ...g, qtyManual: false, qtyOverride: undefined }
                                  : g)),
                              }));
                            }}
                            title="Reset to auto (derived from plan)"
                            style={{ padding: '2px 5px', fontSize: 10, lineHeight: 1 }}>auto</button>
                        )}
                      </div>
                    </td>
                    <td style={{ textAlign: 'right', fontWeight: 600, whiteSpace: 'nowrap' }}>
                      ${row.lineCost.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}
                    </td>
                    <td>
                      <button
                        className="btn btn-small btn-danger"
                        onClick={() => removePackGroup(row.packGroupId)}
                        title="Remove pack group from the plan"
                        aria-label="Remove pack group"
                      >x</button>
                    </td>
                  </tr>
                );
              })}
              {/* Legacy carton synthetic row (no plan, single-carrier=carton).
                  Read-only — the rate is the Drayhorse tier lookup. Plan-mode
                  carton pricing is set per pack-group via the rows above. */}
              {costs.pkgRows.filter((r) => r.synthetic && !r.packGroup).map((row) => (
                <tr key={row.id} style={{ background: '#fafafa', color: 'var(--text-secondary)' }}>
                  <td></td>
                  <td style={{ fontWeight: 600 }}>
                    {row.name}
                    <div style={{ fontSize: 10, color: 'var(--text-muted)', marginTop: 2 }}>Drayhorse tier lookup</div>
                  </td>
                  <td><span style={{ ...chipStyle(categoryColors[row.category] || categoryColors.other), opacity: 0.8 }}>{row.category}</span></td>
                  <td><span style={{ ...chipStyle(feeTypeColors[row.feeType] || feeTypeColors.fixed), opacity: 0.8 }}>{row.feeType}</span></td>
                  <td style={{ textAlign: 'right' }}>${Number(row.rate || 0).toFixed(4)}</td>
                  <td style={{ textAlign: 'right' }}>{(row.qty || 0).toLocaleString()}</td>
                  <td style={{ textAlign: 'right', fontWeight: 600, whiteSpace: 'nowrap' }}>
                    ${row.lineCost.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}
                  </td>
                  <td></td>
                </tr>
              ))}
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
                <td colSpan={8} style={{ padding: '8px 12px', display: 'flex', gap: 8, alignItems: 'center' }}>
                  <button className="btn btn-small" onClick={() => setPackagingItems((p) => [...p, { id: 'pkg-' + Date.now(), name: '', category: 'other', feeType: 'per-unit', rate: 0, qty: getFeeAutoQty('per-unit', effectiveCounts), qtyManual: false }])} style={{ fontSize: 12 }}>
                    + Add Packaging Item
                  </button>
                  {packagingCatalog.length > 0 && (
                    <select
                      value=""
                      onChange={(e) => {
                        const picked = packagingCatalog.find((c) => c.id === e.target.value);
                        if (picked) addFromCatalog(setPackagingItems, 'pkg')(picked);
                        e.target.value = '';
                      }}
                      style={{ fontSize: 12 }}
                      aria-label="Import from packaging catalog"
                    >
                      <option value="">+ From catalog…</option>
                      {packagingCatalog.map((c) => (
                        <option key={c.id} value={c.id}>
                          {c.name} ({c.feeType} @ ${(c.rate || 0).toFixed(2)})
                        </option>
                      ))}
                    </select>
                  )}
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
            <div style={{ fontSize: 12, color: 'var(--text-secondary)', fontWeight: 700 }}>
              Reference only. Quote totals come from the Tolling line items below.
            </div>
            <div style={{ textAlign: 'right' }}>
              <div style={{ fontSize: 22, fontWeight: 900, color: 'var(--brand)', fontFamily: 'monospace' }}>
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
            () => setTollingItems((p) => [...p, { id: 'toll-' + Date.now(), name: '', feeType: 'per-unit', rate: 0, qty: getFeeAutoQty('per-unit', effectiveCounts), qtyManual: false }]),
            'Add Tolling Item', costs.tollingCost, tollDrag,
            servicesCatalog, addFromCatalog(setTollingItems, 'toll')
          )}
        </div>
      </div>

      {/* Freight & Other */}
      <div className="section" style={{ marginBottom: 20 }}>
        <div className="section-header">
          <div className="section-title">Freight & Other</div>
        </div>
        <div>
          {renderFeeTable(
            costs.bomRows, updateBom, resetBomQty,
            (idx) => setBomItems((p) => p.filter((_, i) => i !== idx)),
            () => setBomItems((p) => [...p, { id: 'bom-' + Date.now(), name: '', feeType: 'per-unit', rate: 0, qty: getFeeAutoQty('per-unit', effectiveCounts), qtyManual: false }]),
            'Add BOM Item', costs.bomCost, bomDrag,
            servicesCatalog, addFromCatalog(setBomItems, 'bom')
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
            () => setTaxItems((p) => [...p, { id: 'tax-' + Date.now(), name: '', feeType: 'per-unit', rate: 0, qty: getFeeAutoQty('per-unit', effectiveCounts), qtyManual: false }]),
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
          {costs.totalIngredientCost > 0 && <div className="projection-row"><span className="label">Ingredients (optimized PO)</span><span className="value">${costs.totalIngredientCost.toFixed(2)}</span></div>}
          <div className="projection-row"><span className="label">Tolling</span><span className="value">${costs.tollingCost.toFixed(2)}</span></div>
          <div className="projection-row"><span className="label">Freight & Other</span><span className="value">${costs.bomCost.toFixed(2)}</span></div>
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
