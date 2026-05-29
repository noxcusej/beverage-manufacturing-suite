import { getProducts, lookupPrice, NEW_ART_PREP_FEE } from '../data/drayhorsePricing';
import { computePlanDerived } from '../pages/runQuoting/packagingPlan';

// Recomputes a saved run's counts / costs / breakdown from its stored state, so any
// two saved runs can be compared (or exported) without the live calculator component.
//
// Mirrors the calculations in pages/CoPackingCalculator.jsx, including the
// packaging-plan-driven pack/case/pallet/carton math when a plan is present.
// Ingredient cost is read from each flavor's stored per-can `ingredientCost`
// (captured when the run was saved) rather than recomputed from the live
// formula/inventory data, so a comparison reflects the numbers as quoted.

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

function resolveQty(item, counts) {
  if (item.qtyManual) return item.qty || 0;
  if (item.id === 'bom-freight-in') return Math.max(1, Math.ceil(counts.totalPallets * 0.75));
  return getFeeAutoQty(item.feeType, counts);
}

function computeCounts(config, flavors) {
  const {
    fillVolume = 12,
    fillVolumeUnit = 'oz',
    packSize = 4,
    abv = 0,
    unitsPerCase = 24,
    casesPerPallet = 80,
    palletsPerTruck = 20,
    cansPerMinute = 400,
  } = config;

  let fillOz = fillVolume;
  if (fillVolumeUnit === 'mL') fillOz = fillVolume / 29.5735;
  else if (fillVolumeUnit === 'L') fillOz = fillVolume * 33.814;

  let totalGallons = 0;
  const flavorRows = (flavors || []).map((f) => {
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
  const flavorCount = flavorRows.length;

  return { flavorRows, flavorCount, totalGallons, totalUnits, totalPacks, totalCases, totalPallets, totalTrucks, totalShifts, proofGallons };
}

function deriveEffectiveCounts(counts, planDerived, carrierType, palletsPerTruck) {
  if (!planDerived.active) {
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
}

function computeCartonCost(carton, carrierType, packSize, totalUnits, planDerived) {
  const cartonProduct = carton?.cartonProduct || 'sleek-4pk';
  const storedSkuCount = carton?.skuCount || 1;
  const skuCountManual = !!carton?.skuCountManual;
  // Effective SKU count parallels CoPackingCalculator.jsx: in plan mode
  // default to # of carton groups, unless the user manually overrode it.
  let effectiveSkuCount = storedSkuCount;
  if (!skuCountManual && planDerived?.active) {
    const cartonGroupCount = (planDerived.cartonGroups || []).length;
    if (cartonGroupCount > 0) effectiveSkuCount = cartonGroupCount;
  }
  const artFee = carton?.includeNewArt ? NEW_ART_PREP_FEE : 0;
  const empty = { totalCost: 0, groupBreakdown: [] };

  if (planDerived.active) {
    const cartonGroups = planDerived.cartonGroups;
    if (cartonGroups.length === 0) return empty;
    const groupBreakdown = [];
    let totalCost = 0;
    cartonGroups.forEach((g) => {
      const cartonQty = g.packsCount || 0;
      if (cartonQty <= 0) return;
      const tier = lookupPrice(cartonProduct, cartonQty, effectiveSkuCount);
      const autoRate = tier?.pricePerCarton || 0;
      const groupTotal = autoRate * cartonQty;
      totalCost += groupTotal;
      groupBreakdown.push({
        groupId: g.id,
        groupLabel: g.label || `${g.type === 'variety' ? 'Variety' : 'Straight'} ${g.packSize}-pk`,
        cartonQty,
        pricePerCarton: autoRate,
        autoRate,
        totalCost: groupTotal,
        belowTier: !!tier?.belowTier,
        aboveMaxTier: !!tier?.aboveMaxTier,
        skuExtrapolated: !!tier?.skuExtrapolated,
        tierQty: tier?.tierQty,
      });
    });
    if (groupBreakdown.length === 0) return empty;
    return { totalCost: totalCost + artFee, groupBreakdown, artFee };
  }

  if (carrierType !== 'carton') return empty;
  const product = getProducts().find((p) => p.id === cartonProduct);
  const ps = product?.packSize || packSize;
  const cartonQty = ps > 0 ? Math.ceil(totalUnits / ps) : 0;
  const result = lookupPrice(cartonProduct, cartonQty, effectiveSkuCount);
  if (!result) return empty;
  return {
    totalCost: result.totalCost + artFee,
    pricePerCarton: result.pricePerCarton,
    cartonQty,
    groupBreakdown: [],
    artFee,
  };
}

export function computeRunResults(run) {
  const config = run.config || {};
  const carrierType = config.carrierType || 'paktech';
  const packSize = config.packSize || 4;
  const unitsPerCase = config.unitsPerCase || 24;
  const casesPerPallet = config.casesPerPallet || 80;
  const palletsPerTruck = config.palletsPerTruck || 20;

  const counts = computeCounts(config, run.flavors);
  const planDerived = computePlanDerived(
    run.packagingPlan || { groups: [] },
    counts.flavorRows,
    { unitsPerCase, casesPerPallet },
  );
  const effectiveCounts = deriveEffectiveCounts(counts, planDerived, carrierType, palletsPerTruck);
  const cartonCost = computeCartonCost(run.carton, carrierType, packSize, counts.totalUnits, planDerived);

  const sumLines = (items) => (items || []).map((item) => {
    // Legacy suppression: only when no plan exists and the run is single-carrier carton.
    if (!planDerived.active && item.category === 'carriers' && carrierType === 'carton') {
      return { ...item, qty: 0, lineCost: 0, inactive: true };
    }
    // Plan mode: default PakTech Carriers row is replaced by per-pack-group
    // unitPrice — suppress to avoid double-billing.
    if (planDerived.active && item.id === 'pkg-carriers') {
      return { ...item, qty: 0, lineCost: 0, inactive: true };
    }
    const qty = resolveQty(item, effectiveCounts);
    return { ...item, qty, lineCost: (item.rate || 0) * qty, inactive: false };
  });

  const pkgRowsFromItems = sumLines(run.packagingItems);
  const tollRows = sumLines(run.tollingItems);
  const bomRows = sumLines(run.bomItems);
  const taxRows = sumLines(run.taxItems);

  // Pack-group rows — parity with the live calculator. Honors per-group
  // overrides (label, category, feeType, qtyOverride/qtyManual, unitPrice,
  // unitPriceManual). Carton groups auto-seed from the Drayhorse tier when
  // not manually overridden.
  const packGroupRows = [];
  // pricePerCarton already reflects any legacy cartonRateManual/Override —
  // see CoPackingCalculator.jsx for the same rule.
  const cartonAutoByGroup = Object.fromEntries(
    (cartonCost.groupBreakdown || []).map((gb) => [gb.groupId, gb.pricePerCarton || 0])
  );
  if (planDerived.active) {
    const flavorByIdLocal = Object.fromEntries(counts.flavorRows.map((f) => [f.id, f]));
    planDerived.groups.forEach((g) => {
      const description = g.label || (g.type === 'straight'
        ? `${flavorByIdLocal[g.skuId]?.name || 'Straight'} ${g.packSize}-pk`
        : (() => {
          const names = (g.mix || []).filter((m) => (m.cans || 0) > 0).map((m) => flavorByIdLocal[m.skuId]?.name || m.skuId).join(' / ');
          return names ? `Variety ${g.packSize}-pk (${names})` : `Variety ${g.packSize}-pk`;
        })());
      const cartonAuto = cartonAutoByGroup[g.id] || 0;
      const rate = g.unitPriceManual
        ? (Number(g.unitPrice) || 0)
        : (g.carrierType === 'carton' ? cartonAuto : (Number(g.unitPrice) || 0));
      const category = g.category || (g.type === 'variety' ? 'carriers' : 'cases');
      const feeType = g.feeType || 'per-pack';
      const isPaktech = g.carrierType === 'paktech';
      const isCarton = g.carrierType === 'carton';
      const isVariety = g.type === 'variety';
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
      });
    });
  }

  // Plan mode: pack-group rows already carry the per-pack price (which
  // includes cartons when applicable). Legacy mode (no plan): keep the
  // Drayhorse synthetic row so cartons still appear in the BOM.
  const cartonRows = [];
  if (!planDerived.active && cartonCost.totalCost > 0) {
    cartonRows.push({
      id: 'carton-legacy', name: 'Cartons (Drayhorse)',
      category: 'cases', feeType: 'per-carton-pack',
      rate: cartonCost.pricePerCarton || 0,
      qty: cartonCost.cartonQty || 0,
      lineCost: cartonCost.totalCost,
      inactive: false, synthetic: true,
    });
  }
  const pkgRows = [...packGroupRows, ...cartonRows, ...pkgRowsFromItems];

  const rawPackagingCost = pkgRows.reduce((s, r) => s + r.lineCost, 0);
  const tollingCost = tollRows.reduce((s, r) => s + r.lineCost, 0);
  const bomCost = bomRows.reduce((s, r) => s + r.lineCost, 0);
  const taxCost = taxRows.reduce((s, r) => s + r.lineCost, 0);

  const totalBatchingFees = (run.flavors || []).reduce((s, f) => s + (f.batchingFee || 0), 0);

  let totalIngredientCost = 0;
  counts.flavorRows.forEach((fr) => {
    const flv = (run.flavors || []).find((f) => f.id === fr.id);
    const perCan = flv?.ingredientCost || 0;
    totalIngredientCost += perCan * fr.cans;
  });

  // Cartons are inside rawPackagingCost; don't add cartonCost again.
  const packagingCost = rawPackagingCost;
  const totalCost = packagingCost + totalIngredientCost + tollingCost + bomCost + totalBatchingFees + taxCost;
  const costPerUnit = counts.totalUnits > 0 ? totalCost / counts.totalUnits : 0;
  const costPerCase = costPerUnit * unitsPerCase;

  const costs = {
    pkgRows, tollRows, bomRows, taxRows,
    packagingCost, rawPackagingCost, cartonCost: cartonCost.totalCost,
    totalIngredientCost, tollingCost, bomCost, totalBatchingFees, taxCost,
    totalCost, costPerUnit, costPerCase,
  };

  const total = totalCost;
  // Every breakdown row carries a stable `key` so consumers (Summary,
  // exports, comparisons) switch on key instead of pattern-matching the
  // label string — labels can drift; keys can't.
  const breakdownRows = [{ key: 'packaging', label: 'Packaging Materials', cost: rawPackagingCost }];
  if (totalIngredientCost > 0) breakdownRows.push({ key: 'ingredients', label: 'Ingredients (optimized PO)', cost: totalIngredientCost });
  breakdownRows.push({ key: 'tolling', label: 'Tolling', cost: tollingCost });
  breakdownRows.push({ key: 'bom', label: 'Freight & Other', cost: bomCost });
  if (totalBatchingFees > 0) breakdownRows.push({ key: 'batching', label: 'Batching Fees', cost: totalBatchingFees });
  breakdownRows.push({ key: 'taxes', label: 'Taxes & Regulatory', cost: taxCost });
  const breakdown = breakdownRows.map((r) => ({
    ...r,
    perUnit: counts.totalUnits > 0 ? r.cost / counts.totalUnits : 0,
    pct: total > 0 ? (r.cost / total) * 100 : 0,
  }));

  return { config, counts: effectiveCounts, baseCounts: counts, planDerived, cartonCostDetail: cartonCost, costs, breakdown };
}
