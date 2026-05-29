// Packaging plan — splits the run's produced cans into discrete pack groups
// (straight or variety) so per-SKU consumption, per-carrier pack counts, and
// case/pallet totals can be derived from how the cans are actually packed,
// not from a single run-level pack size.
//
// Pure helpers — no React, no DOM. Anything that needs to know about the plan
// (the calculator's effectiveCounts, the carton-cost calc, the Excel export)
// imports from here.

export const CARRIER_TYPES = [
  { value: 'paktech', label: 'PakTech' },
  { value: 'carton', label: 'Carton' },
  { value: 'shrink', label: 'Shrink-wrap' },
  { value: 'none', label: 'None (loose)' },
];

let _idCounter = 0;
function nextId(prefix) {
  _idCounter += 1;
  return `${prefix}-${Date.now().toString(36)}-${_idCounter}`;
}

export function createEmptyPlan() {
  return { groups: [], allocationMode: 'manual' };
}

function clampPct(v) {
  const n = Number(v);
  if (!Number.isFinite(n)) return 0;
  return Math.max(0, Math.min(100, n));
}

// Resolves the cans a single group consumes. Three input modes, ordered by
// priority within manual mode:
//   percent mode  →  totalCans × allocationPercent / 100
//   manual mode   →  casesCount × unitsPerCase  (preferred)
//   legacy manual →  packsCount × packSize       (fallback for old saved plans)
function round1(n) {
  return Math.round((n || 0) * 10) / 10;
}

// Legacy migration: older plans stored `straightPercent` on the plan and no
// per-group `allocationPercent`. Distribute evenly across the groups in each
// category so the new code path can read them. Fires whenever the resolved
// mode is percent and the legacy field is present — covers both explicit
// `allocationMode: 'percent'` and inferred-from-`straightPercent` cases.
//
// When one category has zero groups, its share is reassigned to the OTHER
// category — otherwise legacy plans that no longer have any straight (or
// any variety) groups would lose that share and stay forever <100%.
function migrateLegacyPercents(groups, plan, resolvedMode) {
  if (resolvedMode !== 'percent') return groups;
  const anyHas = groups.some((g) => Number.isFinite(g.allocationPercent) && g.allocationPercent > 0);
  if (anyHas) return groups;
  if (typeof plan?.straightPercent !== 'number') return groups;
  let sp = clampPct(plan.straightPercent);
  let vp = 100 - sp;
  const straight = groups.filter((g) => g.type === 'straight');
  const variety = groups.filter((g) => g.type === 'variety');
  if (straight.length === 0 && variety.length > 0) { vp += sp; sp = 0; }
  if (variety.length === 0 && straight.length > 0) { sp += vp; vp = 0; }
  const perStraight = straight.length > 0 ? sp / straight.length : 0;
  const perVariety = variety.length > 0 ? vp / variety.length : 0;
  return groups.map((g) => ({
    ...g,
    allocationPercent: g.type === 'straight' ? perStraight : perVariety,
  }));
}

function resolveGroupCans(group, { allocationMode, totalCans, unitsPerCase }) {
  if (allocationMode === 'percent') {
    return Math.floor((totalCans * clampPct(group.allocationPercent)) / 100);
  }
  if (typeof group.casesCount === 'number' && group.casesCount >= 0) {
    return Math.max(0, Math.floor(group.casesCount * (unitsPerCase || 0)));
  }
  if (typeof group.packsCount === 'number' && group.packsCount >= 0) {
    return Math.max(0, Math.floor(group.packsCount * (group.packSize || 0)));
  }
  return 0;
}

export function createStraightGroup({ skuId = '', packSize = 4, carrierType = 'paktech' } = {}) {
  return {
    id: nextId('pg'),
    type: 'straight',
    packSize,
    casesCount: 0,        // ruling variable in manual mode
    allocationPercent: 0, // ruling variable in percent mode
    carrierType,
    skuId,
    mix: null,
    label: '',
    unitPrice: 0,         // price per pack (user-editable)
  };
}

export function createVarietyGroup({ packSize = 12, carrierType = 'carton', skuIds = [] } = {}) {
  // Seed the mix with the given SKUs at zero cans each so the user can fill
  // in the per-SKU counts; the validator catches sum-mismatch.
  const mix = skuIds.map((skuId) => ({ skuId, cans: 0 }));
  return {
    id: nextId('pg'),
    type: 'variety',
    packSize,
    casesCount: 0,
    allocationPercent: 0,
    carrierType,
    skuId: null,
    mix,
    label: '',
    unitPrice: 0,
  };
}

// Cans / packs / cases / per-SKU consumed by a single group given the run
// context (allocation mode, total produced cans, unitsPerCase). Cases is the
// ruling variable in manual mode; packs derive. In percent mode the group's
// `allocationPercent` slice of total cans is the input. Per-pack-size rounding
// loss (when cans don't divide cleanly by pack size) shows as fewer packs and
// a smaller `total` than the raw input asked for.
export function computeGroupConsumption(group, context = {}) {
  const incomingCans = resolveGroupCans(group, context);
  const packSize = group.packSize || 0;
  const packs = packSize > 0 ? Math.floor(incomingCans / packSize) : 0;
  const usedCans = packs * packSize;
  const unitsPerCase = context.unitsPerCase || 0;
  const cases = unitsPerCase > 0 ? usedCans / unitsPerCase : 0;
  const out = { perSku: {}, total: usedCans, packsCount: packs, cases };
  if (usedCans <= 0) return out;
  if (group.type === 'straight') {
    if (!group.skuId) return out;
    out.perSku[group.skuId] = usedCans;
    return out;
  }
  if (group.type === 'variety' && Array.isArray(group.mix)) {
    group.mix.forEach(({ skuId, cans }) => {
      if (!skuId) return;
      out.perSku[skuId] = (out.perSku[skuId] || 0) + packs * (cans || 0);
    });
  }
  return out;
}

// Returns an array of human-readable error strings. Empty array == valid.
// allocationMode is needed so we don't yell at users for `casesCount === 0`
// when they're actually driving the group from `allocationPercent`.
export function validateGroup(group, flavorById, allocationMode = 'manual') {
  const errs = [];
  if (!group) return ['Missing group'];
  if (!['straight', 'variety'].includes(group.type)) errs.push(`Unknown group type "${group.type}"`);
  if (!(group.packSize > 0)) errs.push('Pack size must be > 0');
  if (allocationMode === 'manual') {
    const hasCases = typeof group.casesCount === 'number' && group.casesCount >= 0;
    const hasLegacyPacks = typeof group.packsCount === 'number' && group.packsCount >= 0;
    if (!hasCases && !hasLegacyPacks) errs.push('Case count must be ≥ 0');
  }
  if (allocationMode === 'percent') {
    const pct = Number(group.allocationPercent);
    if (!Number.isFinite(pct) || pct < 0 || pct > 100) errs.push('Allocation % must be 0–100');
  }
  if (group.type === 'straight') {
    if (!group.skuId) errs.push('Straight pack needs a SKU');
    else if (flavorById && !flavorById[group.skuId]) errs.push('Straight pack SKU is not in the flavor lineup');
  }
  if (group.type === 'variety') {
    if (!Array.isArray(group.mix) || group.mix.length === 0) errs.push('Variety pack needs a SKU mix');
    else {
      const sum = group.mix.reduce((s, m) => s + (m.cans || 0), 0);
      if (sum !== group.packSize) {
        errs.push(`Variety mix sums to ${sum}, must equal pack size ${group.packSize}`);
      }
      group.mix.forEach((m) => {
        if (m.skuId && flavorById && !flavorById[m.skuId]) {
          errs.push(`Mix SKU "${m.skuId}" not in the flavor lineup`);
        }
        if ((m.cans || 0) < 0) errs.push('Mix can counts must be ≥ 0');
      });
    }
  }
  return errs;
}

// Computes everything downstream consumers need. `flavorRows` is the array of
// per-SKU produced totals from the calculator's counts.flavorRows
// (each has `{ id, name, cans }`).
//
// `active` is false when the plan is empty — callers should fall back to the
// legacy single-pack-size math in that case so old saved runs render unchanged.
export function computePlanDerived(plan, flavorRows, { unitsPerCase = 24, casesPerPallet = 80 } = {}) {
  const flavorById = {};
  (flavorRows || []).forEach((f) => { flavorById[f.id] = f; });

  const totalProduced = (flavorRows || []).reduce((s, f) => s + (f.cans || 0), 0);
  // Legacy plans saved before the per-group percent feature only had
  // `straightPercent`; infer percent mode so they don't silently switch to
  // manual mode (which would read undefined casesCount as 0 packs).
  const legacyPercent = typeof plan?.straightPercent === 'number' && !plan?.allocationMode;
  const allocationMode = (plan?.allocationMode === 'percent' || legacyPercent) ? 'percent' : 'manual';
  const context = { allocationMode, totalCans: totalProduced, unitsPerCase };

  // Migrate a legacy `straightPercent`-only plan transparently: distribute it
  // across straight groups evenly, same for variety. The next save writes the
  // new per-group shape back.
  const migratedGroups = migrateLegacyPercents(plan?.groups || [], plan, allocationMode);

  const groups = migratedGroups.map((g) => {
    const consumption = computeGroupConsumption(g, context);
    // casesConsumed rounded UP at the group level so the per-group display
    // and the footer Total agree (no "5+5+5 ≠ 13" optical mismatch).
    const casesConsumed = unitsPerCase > 0 ? Math.ceil(consumption.total / unitsPerCase) : 0;
    return {
      ...g,
      packsCount: consumption.packsCount,
      cansConsumed: consumption.total,
      casesConsumed,
      perSkuConsumption: consumption.perSku,
    };
  });

  const cansAllocatedPerSku = {};
  let totalCansAllocated = 0;
  groups.forEach((g) => {
    Object.entries(g.perSkuConsumption).forEach(([skuId, cans]) => {
      cansAllocatedPerSku[skuId] = (cansAllocatedPerSku[skuId] || 0) + cans;
      totalCansAllocated += cans;
    });
  });

  const cansProducedPerSku = {};
  let totalCansProduced = 0;
  (flavorRows || []).forEach((f) => {
    cansProducedPerSku[f.id] = f.cans || 0;
    totalCansProduced += f.cans || 0;
  });

  const cansRemainingPerSku = {};
  Object.keys(cansProducedPerSku).forEach((id) => {
    cansRemainingPerSku[id] = (cansProducedPerSku[id] || 0) - (cansAllocatedPerSku[id] || 0);
  });
  // Surface any SKUs in the plan that aren't in the lineup (treated as 100% over-allocated).
  Object.keys(cansAllocatedPerSku).forEach((id) => {
    if (!(id in cansRemainingPerSku)) cansRemainingPerSku[id] = -(cansAllocatedPerSku[id] || 0);
  });
  const totalCansRemaining = totalCansProduced - totalCansAllocated;

  // Pack/carrier totals
  const totalPacks = groups.reduce((s, g) => s + (g.packsCount || 0), 0);
  const totalStraightPacks = groups
    .filter((g) => g.type === 'straight')
    .reduce((s, g) => s + (g.packsCount || 0), 0);
  const totalVarietyPacks = groups
    .filter((g) => g.type === 'variety')
    .reduce((s, g) => s + (g.packsCount || 0), 0);
  const totalPaktechPacks = groups
    .filter((g) => g.carrierType === 'paktech')
    .reduce((s, g) => s + (g.packsCount || 0), 0);
  const totalCartonPacks = groups
    .filter((g) => g.carrierType === 'carton')
    .reduce((s, g) => s + (g.packsCount || 0), 0);
  // Variety cases — derived from variety can totals at the run level so
  // partial cases don't accumulate extras per group.
  const varietyCansAllocated = groups
    .filter((g) => g.type === 'variety')
    .reduce((s, g) => s + (g.cansConsumed || 0), 0);
  const totalVarietyCases = unitsPerCase > 0 ? Math.ceil(varietyCansAllocated / unitsPerCase) : 0;

  // Cases / pallets — sum of per-group rounded cases so the footer agrees
  // with the per-group rows. Pallets derive from the total.
  const totalCases = groups.reduce((s, g) => s + (g.casesConsumed || 0), 0);
  const totalPallets = casesPerPallet > 0 ? Math.ceil(totalCases / casesPerPallet) : 0;

  // For each group, compute the most cans it could consume without over-
  // running any SKU, given what the *other* groups are already taking. This
  // is the "Cap to fit" target the UI offers when a group is over-allocated.
  groups.forEach((g) => {
    const otherConsumption = {};
    groups.forEach((other) => {
      if (other.id === g.id) return;
      Object.entries(other.perSkuConsumption).forEach(([sku, cans]) => {
        otherConsumption[sku] = (otherConsumption[sku] || 0) + cans;
      });
    });
    let maxCans = 0;
    if (g.type === 'straight' && g.skuId) {
      const produced = (flavorById[g.skuId]?.cans) || 0;
      const available = Math.max(0, produced - (otherConsumption[g.skuId] || 0));
      const packSize = g.packSize || 1;
      maxCans = Math.floor(available / packSize) * packSize;
    } else if (g.type === 'variety' && Array.isArray(g.mix)) {
      let maxPacks = Infinity;
      g.mix.forEach((m) => {
        if (!m.skuId || (m.cans || 0) <= 0) return;
        const produced = (flavorById[m.skuId]?.cans) || 0;
        const available = Math.max(0, produced - (otherConsumption[m.skuId] || 0));
        maxPacks = Math.min(maxPacks, Math.floor(available / m.cans));
      });
      if (!Number.isFinite(maxPacks)) maxPacks = 0;
      maxCans = maxPacks * (g.packSize || 0);
    }
    g.maxCansAllowed = maxCans;
    // Floor (not round) so a "Cap to fit" never re-introduces an over-
    // allocation by 0.0…5%. The cap is a HARD ceiling; rebalancing of other
    // groups in the modal fills the remainder.
    g.maxPercentAllowed = totalProduced > 0
      ? Math.floor((maxCans / totalProduced) * 1000) / 10
      : 0;
    g.overByCans = Math.max(0, (g.cansConsumed || 0) - maxCans);
  });

  // Validation
  const errors = [];
  const overAllocatedGroups = [];
  groups.forEach((g, idx) => {
    const groupErrs = validateGroup(g, flavorById, allocationMode);
    groupErrs.forEach((msg) => errors.push(`Group ${idx + 1}${g.label ? ` (${g.label})` : ''}: ${msg}`));
    if (g.overByCans > 0) {
      overAllocatedGroups.push({
        groupId: g.id,
        label: describeGroup(g, flavorById) || `Group ${idx + 1}`,
        overByCans: g.overByCans,
        currentPercent: clampPct(g.allocationPercent),
        maxPercent: g.maxPercentAllowed,
        currentCans: g.cansConsumed || 0,
        maxCans: g.maxCansAllowed,
      });
    }
  });
  // Per-group percentages must total exactly 100% in percent mode.
  const totalPercent = groups.reduce((s, g) => s + clampPct(g.allocationPercent), 0);
  if (allocationMode === 'percent' && groups.length > 0 && Math.abs(totalPercent - 100) > 0.001) {
    const off = Math.round((totalPercent - 100) * 10) / 10;
    errors.push(off > 0
      ? `Allocations sum to ${round1(totalPercent)}% — over by ${round1(off)}%`
      : `Allocations sum to ${round1(totalPercent)}% — ${round1(-off)}% unallocated`);
  }
  const overAllocations = [];
  Object.entries(cansRemainingPerSku).forEach(([skuId, remaining]) => {
    if (remaining < 0) {
      const flavor = flavorById[skuId];
      overAllocations.push({ skuId, name: flavor?.name || skuId, by: -remaining });
    }
  });
  if (overAllocations.length > 0) {
    overAllocations.forEach((oa) => {
      errors.push(`${oa.name} over-allocated by ${oa.by} cans`);
    });
  }

  // Carton groups expose enough info for Drayhorse pricing to iterate them.
  const cartonGroups = groups.filter((g) => g.carrierType === 'carton');

  // Category percent sums (derived from group sums, not stored on the plan).
  const straightPercent = groups
    .filter((g) => g.type === 'straight')
    .reduce((s, g) => s + clampPct(g.allocationPercent), 0);
  const varietyPercent = groups
    .filter((g) => g.type === 'variety')
    .reduce((s, g) => s + clampPct(g.allocationPercent), 0);

  return {
    active: groups.length > 0,
    allocationMode,
    straightPercent: round1(straightPercent),
    varietyPercent: round1(varietyPercent),
    totalPercent: round1(totalPercent),
    overAllocatedGroups,
    groups,
    cansAllocatedPerSku,
    cansProducedPerSku,
    cansRemainingPerSku,
    totalCansProduced,
    totalCansAllocated,
    totalCansRemaining,
    totalPacks,
    totalStraightPacks,
    totalVarietyPacks,
    totalPaktechPacks,
    totalCartonPacks,
    totalCases,
    totalVarietyCases,
    totalPallets,
    cartonGroups,
    errors,
    overAllocations,
    valid: errors.length === 0,
  };
}

// Small convenience for UI labels — "Mango / Lime / Guava 12-pack".
export function describeGroup(group, flavorById) {
  if (!group) return '';
  if (group.label) return group.label;
  if (group.type === 'straight') {
    const name = flavorById?.[group.skuId]?.name || 'Straight';
    return `${name} ${group.packSize}-pack`;
  }
  const names = (group.mix || [])
    .filter((m) => (m.cans || 0) > 0 && m.skuId)
    .map((m) => flavorById?.[m.skuId]?.name || m.skuId);
  if (names.length === 0) return `Variety ${group.packSize}-pack`;
  return `${names.join(' / ')} ${group.packSize}-pack`;
}
