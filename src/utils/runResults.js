import { getProducts, lookupPrice, NEW_ART_PREP_FEE } from '../data/drayhorsePricing';

// Recomputes a saved run's counts / costs / breakdown from its stored state, so any
// two saved runs can be compared (or exported) without the live calculator component.
//
// Mirrors the calculations in pages/CoPackingCalculator.jsx. Ingredient cost is read
// from each flavor's stored per-can `ingredientCost` (captured when the run was saved)
// rather than recomputed from the live formula/inventory data, so a comparison reflects
// the numbers as quoted.

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

function computeCartonCost(carton, carrierType, packSize, totalUnits) {
  if (carrierType !== 'carton') return { totalCost: 0 };
  const cartonProduct = carton?.cartonProduct || 'sleek-4pk';
  const product = getProducts().find((p) => p.id === cartonProduct);
  const ps = product?.packSize || packSize;
  const cartonQty = ps > 0 ? Math.ceil(totalUnits / ps) : 0;
  const result = lookupPrice(cartonProduct, cartonQty, carton?.skuCount || 1);
  if (!result) return { totalCost: 0 };
  const artFee = carton?.includeNewArt ? NEW_ART_PREP_FEE : 0;
  return { totalCost: result.totalCost + artFee };
}

export function computeRunResults(run) {
  const config = run.config || {};
  const carrierType = config.carrierType || 'paktech';
  const packSize = config.packSize || 4;
  const unitsPerCase = config.unitsPerCase || 24;

  const counts = computeCounts(config, run.flavors);
  const cartonCost = computeCartonCost(run.carton, carrierType, packSize, counts.totalUnits);

  const sumLines = (items) => (items || []).map((item) => {
    if (item.category === 'carriers' && carrierType === 'carton') {
      return { ...item, qty: 0, lineCost: 0, inactive: true };
    }
    const qty = resolveQty(item, counts);
    return { ...item, qty, lineCost: (item.rate || 0) * qty, inactive: false };
  });

  const pkgRows = sumLines(run.packagingItems);
  const tollRows = sumLines(run.tollingItems);
  const bomRows = sumLines(run.bomItems);
  const taxRows = sumLines(run.taxItems);

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

  const packagingCost = rawPackagingCost + cartonCost.totalCost;
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
  const breakdownRows = [{ label: 'Packaging Materials', cost: rawPackagingCost }];
  if (carrierType === 'carton') breakdownRows.push({ label: 'Cartons (Drayhorse)', cost: cartonCost.totalCost });
  if (totalIngredientCost > 0) breakdownRows.push({ label: 'Ingredients (optimized PO)', cost: totalIngredientCost });
  breakdownRows.push({ label: 'Tolling', cost: tollingCost });
  breakdownRows.push({ label: 'Bill of Materials', cost: bomCost });
  if (totalBatchingFees > 0) breakdownRows.push({ label: 'Batching Fees', cost: totalBatchingFees });
  breakdownRows.push({ label: 'Taxes & Regulatory', cost: taxCost });
  const breakdown = breakdownRows.map((r) => ({
    ...r,
    perUnit: counts.totalUnits > 0 ? r.cost / counts.totalUnits : 0,
    pct: total > 0 ? (r.cost / total) * 100 : 0,
  }));

  return { config, counts, costs, breakdown };
}
