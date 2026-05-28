// Run with: node src/pages/runQuoting/packagingPlan.test.mjs
//
// No test runner is installed in the repo; this file is a self-contained
// smoke check for the pure helpers. Exits with non-zero on failure so it
// composes with CI later.

import {
  createEmptyPlan,
  createStraightGroup,
  createVarietyGroup,
  computeGroupConsumption,
  computePlanDerived,
  validateGroup,
} from './packagingPlan.js';

let passed = 0;
let failed = 0;
function assert(label, cond, detail) {
  if (cond) { passed += 1; return; }
  failed += 1;
  console.error(`FAIL: ${label}${detail ? `\n   → ${detail}` : ''}`);
}
function eq(a, b) {
  return JSON.stringify(a) === JSON.stringify(b);
}

const flavors = [
  { id: 'flv-mango', name: 'Mango', cans: 6000 },
  { id: 'flv-lime', name: 'Lime', cans: 6000 },
  { id: 'flv-guava', name: 'Guava', cans: 6000 },
  { id: 'flv-passion', name: 'Passion', cans: 6000 },
];
const ctxMan = { allocationMode: 'manual', totalCans: 24000, unitsPerCase: 24 };

// 1. Empty plan
{
  const d = computePlanDerived(createEmptyPlan(), flavors, { unitsPerCase: 24, casesPerPallet: 80 });
  assert('empty plan: not active', d.active === false);
  assert('empty plan: zero allocated', d.totalCansAllocated === 0);
  assert('empty plan: remaining == produced', d.totalCansRemaining === 24000);
  assert('empty plan: no errors', d.errors.length === 0);
}

// 2. Single straight group, manual mode, cases-driven
{
  const plan = {
    allocationMode: 'manual',
    groups: [
      { ...createStraightGroup({ skuId: 'flv-mango', packSize: 4, carrierType: 'paktech' }), casesCount: 250 },
    ],
  };
  const d = computePlanDerived(plan, flavors, { unitsPerCase: 24, casesPerPallet: 80 });
  assert('straight: active', d.active === true);
  assert('straight: cans allocated to mango (250×24)', d.cansAllocatedPerSku['flv-mango'] === 6000);
  assert('straight: packsCount derived (6000/4)', d.groups[0].packsCount === 1500);
  assert('straight: totalPaktechPacks', d.totalPaktechPacks === 1500);
  assert('straight: totalCases', d.totalCases === 250, `got ${d.totalCases}`);
  assert('straight: no errors', d.errors.length === 0, d.errors.join(' | '));
}

// 3. Variety group, cases-driven
{
  const variety = {
    ...createVarietyGroup({ packSize: 12, carrierType: 'carton', skuIds: ['flv-mango', 'flv-lime', 'flv-guava'] }),
    casesCount: 250,
    mix: [
      { skuId: 'flv-mango', cans: 4 },
      { skuId: 'flv-lime', cans: 4 },
      { skuId: 'flv-guava', cans: 4 },
    ],
  };
  const d = computePlanDerived(
    { allocationMode: 'manual', groups: [variety] },
    flavors, { unitsPerCase: 24, casesPerPallet: 80 },
  );
  // 250 cases × 24 = 6000 cans → 500 12-packs → 2000 cans per SKU
  assert('variety: 6000 total cans', d.totalCansAllocated === 6000);
  assert('variety: packsCount derived (500)', d.groups[0].packsCount === 500);
  assert('variety: per-SKU 2000 mango', d.cansAllocatedPerSku['flv-mango'] === 2000);
  assert('variety: totalVarietyPacks', d.totalVarietyPacks === 500);
  assert('variety: no errors', d.errors.length === 0, d.errors.join(' | '));
}

// 4. Variety mix that does NOT sum to packSize
{
  const bad = {
    ...createVarietyGroup({ packSize: 12, skuIds: ['flv-mango', 'flv-lime'] }),
    casesCount: 100,
    mix: [
      { skuId: 'flv-mango', cans: 5 },
      { skuId: 'flv-lime', cans: 5 },
    ],
  };
  const d = computePlanDerived(
    { allocationMode: 'manual', groups: [bad] },
    flavors, { unitsPerCase: 24, casesPerPallet: 80 },
  );
  assert('mix-mismatch: invalid', d.valid === false);
  assert('mix-mismatch: error mentions mix sum', d.errors.some((e) => /sums to 10/.test(e)), d.errors.join(' | '));
}

// 5. Over-allocation across SKUs
{
  const overA = {
    ...createStraightGroup({ skuId: 'flv-mango', packSize: 4, carrierType: 'paktech' }),
    casesCount: 400, // 9600 cans of Mango — only 6000 produced
  };
  const d = computePlanDerived(
    { allocationMode: 'manual', groups: [overA] },
    flavors, { unitsPerCase: 24, casesPerPallet: 80 },
  );
  assert('over: mango remaining negative', d.cansRemainingPerSku['flv-mango'] === -3600);
  assert('over: invalid', d.valid === false);
}

// 6. Per-group percent allocation summing to 100%, no over-allocation.
// Realistic split: each SKU produced 6000, plan allocates them all exactly.
//   25% Mango straight 4-pk      → 6000 mango
//   25% Lime straight 4-pk       → 6000 lime
//   50% Variety 12-pk (Guava+Passion 6+6) → 1000 packs × 6 each = 6000 guava + 6000 passion
{
  const plan = {
    allocationMode: 'percent',
    groups: [
      { ...createStraightGroup({ skuId: 'flv-mango', packSize: 4, carrierType: 'paktech' }), allocationPercent: 25 },
      { ...createStraightGroup({ skuId: 'flv-lime', packSize: 4, carrierType: 'paktech' }), allocationPercent: 25 },
      {
        ...createVarietyGroup({ packSize: 12, carrierType: 'carton', skuIds: ['flv-guava', 'flv-passion'] }),
        allocationPercent: 50,
        mix: [
          { skuId: 'flv-guava', cans: 6 },
          { skuId: 'flv-passion', cans: 6 },
        ],
      },
    ],
  };
  const d = computePlanDerived(plan, flavors, { unitsPerCase: 24, casesPerPallet: 80 });
  assert('per-pct: total allocation 100%', d.totalPercent === 100);
  assert('per-pct: straight sum 50%', d.straightPercent === 50);
  assert('per-pct: variety sum 50%', d.varietyPercent === 50);
  assert('per-pct: mango straight 1500 packs', d.groups[0].packsCount === 1500);
  assert('per-pct: lime straight 1500 packs', d.groups[1].packsCount === 1500);
  assert('per-pct: variety packs (12000/12)', d.groups[2].packsCount === 1000);
  assert('per-pct: no errors', d.valid, d.errors.join(' | '));
}

// 7. Per-group percent NOT summing to 100 → error
{
  const plan = {
    allocationMode: 'percent',
    groups: [
      { ...createStraightGroup({ skuId: 'flv-mango', packSize: 4 }), allocationPercent: 30 },
      { ...createStraightGroup({ skuId: 'flv-lime', packSize: 4 }), allocationPercent: 30 },
    ],
  };
  const d = computePlanDerived(plan, flavors, { unitsPerCase: 24, casesPerPallet: 80 });
  assert('pct under 100: invalid', d.valid === false);
  assert('pct under 100: error mentions unallocated', d.errors.some((e) => /unallocated/.test(e)), d.errors.join(' | '));
}

// 8. Legacy migration: plan with straightPercent and no group percents
{
  const plan = {
    allocationMode: 'percent',
    straightPercent: 70, // legacy field
    groups: [
      createStraightGroup({ skuId: 'flv-mango', packSize: 4, carrierType: 'paktech' }),
      createVarietyGroup({ packSize: 12, carrierType: 'carton', skuIds: ['flv-lime', 'flv-guava'] }),
    ],
  };
  // Patch variety mix
  plan.groups[1].mix = [{ skuId: 'flv-lime', cans: 6 }, { skuId: 'flv-guava', cans: 6 }];
  const d = computePlanDerived(plan, flavors, { unitsPerCase: 24, casesPerPallet: 80 });
  // After migration, straight group should have 70%, variety 30%
  assert('legacy: straightPercent 70', d.straightPercent === 70);
  assert('legacy: varietyPercent 30', d.varietyPercent === 30);
  assert('legacy: mango packs (16800/4)', d.groups[0].packsCount === 4200);
}

// 9. Legacy packsCount-only group (manual mode)
{
  const legacy = {
    id: 'pg-old', type: 'straight', packSize: 4, packsCount: 1500,
    carrierType: 'paktech', skuId: 'flv-mango', mix: null, label: '',
  };
  const d = computePlanDerived(
    { allocationMode: 'manual', groups: [legacy] },
    flavors, { unitsPerCase: 24, casesPerPallet: 80 },
  );
  assert('legacy packsCount: cans (1500×4)', d.totalCansAllocated === 6000);
  assert('legacy packsCount: still 1500 packs derived', d.groups[0].packsCount === 1500);
}

// 10. computeGroupConsumption: cases-driven straight
{
  const c = computeGroupConsumption(
    { ...createStraightGroup({ skuId: 'flv-mango', packSize: 4 }), casesCount: 100 },
    ctxMan,
  );
  assert('consumption: cases→cans (100×24)', c.total === 2400);
  assert('consumption: cases→packs (2400/4)', c.packsCount === 600);
  assert('consumption: cases (100)', c.cases === 100);
  assert('consumption: perSku', eq(c.perSku, { 'flv-mango': 2400 }));
}

// 11. validateGroup catches non-lineup SKU
{
  const errs = validateGroup({
    type: 'straight', packSize: 4, casesCount: 100, skuId: 'flv-ghost', mix: null, label: '',
  }, { 'flv-mango': flavors[0] }, 'manual');
  assert('validate: catches missing SKU', errs.some((e) => /not in the flavor lineup/.test(e)), errs.join(' | '));
}

// 12. Legacy percent inference — `straightPercent` set, no `allocationMode`
{
  const plan = {
    straightPercent: 60,
    groups: [
      createStraightGroup({ skuId: 'flv-mango', packSize: 4 }),
      createVarietyGroup({ packSize: 12, skuIds: ['flv-lime', 'flv-guava'] }),
    ],
  };
  plan.groups[1].mix = [{ skuId: 'flv-lime', cans: 6 }, { skuId: 'flv-guava', cans: 6 }];
  const d = computePlanDerived(plan, flavors, { unitsPerCase: 24, casesPerPallet: 80 });
  assert('legacy-infer: detected percent mode', d.allocationMode === 'percent');
  assert('legacy-infer: straightPercent 60', d.straightPercent === 60);
  // 60% of 24000 = 14400 cans straight → 3600 4-packs
  assert('legacy-infer: straight packs computed', d.groups[0].packsCount === 3600);
}

// 13. overAllocatedGroups surfaces the right max% to cap to.
// Mango produced 6000; group asks for 60% × 24000 = 14400. Lime is fine at
// 40% × 24000 = 9600 > 6000 produced too, so both flag.
{
  const plan = {
    allocationMode: 'percent',
    groups: [
      { ...createStraightGroup({ skuId: 'flv-mango', packSize: 4, carrierType: 'paktech' }), allocationPercent: 60 },
      { ...createStraightGroup({ skuId: 'flv-lime', packSize: 4, carrierType: 'paktech' }), allocationPercent: 40 },
    ],
  };
  const d = computePlanDerived(plan, flavors, { unitsPerCase: 24, casesPerPallet: 80 });
  assert('over-group: both flagged', d.overAllocatedGroups.length === 2);
  const mango = d.overAllocatedGroups.find((o) => o.label.toLowerCase().includes('mango'));
  assert('over-group: mango max% 25', mango && mango.maxPercent <= 25 && mango.maxPercent > 24.8, `got ${mango?.maxPercent}`);
  assert('over-group: mango overByCans 8400', mango && mango.overByCans === 8400);
}

console.log(`\n${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);
