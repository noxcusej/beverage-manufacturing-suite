// Drayhorse Pricing Grid - September 2025
// Prices are per thousand cartons (Price Per/M)
// Lookup: quantity tiers (Y-axis) x number of SKUs (X-axis)

const quantityTiers = [10000, 15000, 20000, 25000, 30000, 40000, 50000, 75000, 100000];

// Each product has a grid: rows = quantity tiers, columns = 1-4 SKUs
const products = [
  {
    id: 'sleek-4pk',
    name: '12oz Sleek 4pk',
    sku: '25-12326',
    structure: 'Sleek',
    packSize: 4,
    design: 'D2950',
    die: '25034',
    grid: [
      [378.95, 474.04, 568.51, 663.59],
      [301.16, 364.55, 427.55, 491.21],
      [266.84, 314.57, 362.00, 409.74],
      [246.58, 284.77, 322.72, 360.91],
      [230.87, 262.70, 294.32, 326.14],
      [214.79, 238.66, 262.38, 286.25],
      [204.17, 223.27, 242.24, 261.33],
      [189.01, 201.74, 214.39, 227.12],
      [177.50, 186.98, 196.39, 205.87],
    ],
  },
  {
    id: 'sleek-6pk',
    name: '12oz Sleek 6pk',
    sku: '25-12327',
    structure: 'Sleek',
    packSize: 6,
    design: 'D2951_A',
    die: '25035',
    grid: [
      [400.87, 494.57, 587.64, 681.34],
      [335.81, 398.36, 460.66, 523.37],
      [298.05, 345.08, 391.80, 438.84],
      [278.44, 316.06, 353.44, 391.07],
      [266.86, 298.22, 329.36, 360.72],
      [250.05, 273.57, 296.93, 320.45],
      [240.99, 259.81, 278.50, 297.31],
      [220.23, 232.68, 245.05, 257.50],
      [212.15, 221.49, 230.76, 240.10],
    ],
  },
  {
    id: 'sleek-8pk',
    name: '12oz Sleek 8pk',
    sku: '25-12328',
    structure: 'Sleek',
    packSize: 8,
    design: 'D2952_A',
    die: '25169',
    grid: [
      [453.79, 543.08, 631.75, 721.27],
      [386.71, 446.45, 505.76, 565.50],
      [354.47, 399.27, 443.76, 488.56],
      [336.14, 371.98, 407.57, 443.41],
      [322.97, 352.84, 382.50, 412.37],
      [304.47, 326.87, 349.12, 371.52],
      [293.10, 311.02, 328.82, 346.74],
      [272.42, 284.29, 296.08, 307.95],
      [264.28, 273.18, 282.02, 290.92],
    ],
  },
  {
    id: 'sleek-12pk',
    name: '12oz Sleek 12pk',
    sku: '25-12329',
    structure: 'Sleek',
    packSize: 12,
    design: 'D3409_A',
    die: null,
    grid: [
      [622.07, 721.59, 820.49, 910.02],
      [535.50, 601.85, 667.78, 727.47],
      [494.82, 544.59, 594.04, 638.80],
      [469.53, 509.34, 548.91, 584.72],
      [448.50, 481.68, 514.65, 544.49],
      [425.01, 443.26, 467.78, 489.95],
      [403.41, 423.15, 442.77, 460.50],
      [380.90, 394.06, 407.14, 418.96],
      [374.65, 384.51, 394.32, 403.19],
    ],
  },
  {
    id: 'standard-4pk',
    name: '12oz Standard 4pk',
    sku: '25-12330',
    structure: 'Standard',
    packSize: 4,
    design: 'D2824',
    die: '24995',
    grid: [
      [383.41, 473.11, 562.18, 651.88],
      [312.24, 372.03, 431.42, 491.40],
      [278.92, 323.92, 368.62, 413.62],
      [259.20, 295.21, 330.96, 366.97],
      [244.20, 274.20, 304.00, 334.00],
      [228.25, 250.75, 273.10, 295.60],
      [217.89, 235.89, 253.77, 271.77],
      [203.09, 215.09, 227.01, 239.01],
      [191.60, 200.54, 209.42, 218.36],
    ],
  },
  {
    id: 'standard-6pk',
    name: '12oz Standard 6pk',
    sku: '25-12331',
    structure: 'Standard',
    packSize: 6,
    design: 'D2018_A',
    die: '25212',
    grid: [
      [448.40, 534.56, 620.33, 706.83],
      [376.62, 434.29, 491.54, 549.21],
      [336.88, 380.13, 423.06, 466.31],
      [315.54, 350.14, 384.49, 419.09],
      [301.88, 330.72, 359.34, 388.18],
      [283.81, 305.44, 326.91, 348.53],
      [272.21, 289.51, 306.69, 323.99],
      [252.23, 263.70, 275.08, 286.55],
      [243.56, 252.16, 260.70, 269.30],
    ],
  },
  {
    id: 'standard-8pk',
    name: '12oz Standard 8pk',
    sku: '25-12332',
    structure: 'Standard',
    packSize: 8,
    design: 'D3569',
    die: 'TBD',
    grid: [
      [469.95, 559.57, 648.56, 738.46],
      [399.17, 459.13, 518.67, 578.62],
      [366.47, 411.43, 456.09, 501.06],
      [345.40, 381.38, 417.10, 453.08],
      [329.28, 359.25, 389.02, 419.00],
      [312.62, 335.10, 357.43, 379.91],
      [300.22, 318.21, 336.07, 354.06],
      [278.62, 290.53, 302.36, 314.28],
      [270.04, 278.98, 287.85, 296.78],
    ],
  },
  {
    id: 'standard-12pk',
    name: '12oz Standard 12pk',
    sku: '25-12333',
    structure: 'Standard',
    packSize: 12,
    design: 'D3629',
    die: null,
    grid: [
      [569.53, 668.01, 765.96, 864.55],
      [494.52, 560.24, 625.54, 691.26],
      [457.43, 506.72, 555.70, 604.99],
      [433.76, 473.19, 512.37, 551.81],
      [415.90, 448.76, 481.41, 514.27],
      [393.57, 418.22, 436.07, 460.51],
      [373.99, 393.54, 412.97, 432.53],
      [356.19, 369.23, 382.18, 395.21],
      [351.78, 361.56, 371.27, 381.05],
    ],
  },
];

const NEW_ART_PREP_FEE = 296;

// Maximum SKU columns we'll surface in the UI (1–12). Drayhorse's published
// pricing covers 1–4 SKUs directly; 5+ SKUs are LINEARLY EXTRAPOLATED from
// the visible 1→4 deltas (deltas are tightly clustered, so extrapolation
// is reasonable for estimating purposes). lookupPrice() returns a
// `skuExtrapolated: true` flag whenever skuCount > 4 so callers can warn
// the user to verify with Drayhorse for a binding quote.
const MAX_SKU_COLS = 12;

function extendRowToMaxSkus(row) {
  // row is the published 4-column row [1sku, 2sku, 3sku, 4sku].
  // Linear extrapolate: deltaPerSku = (row[3] - row[0]) / 3.
  if (!row || row.length < 4) return row;
  const delta = (row[3] - row[0]) / 3;
  const extended = [...row];
  for (let n = 4; n < MAX_SKU_COLS; n += 1) {
    extended.push(row[3] + delta * (n - 3));
  }
  return extended;
}

// Lazily cache extended grids so we extrapolate once per product.
const extendedGridCache = new Map();
function getExtendedGrid(product) {
  const cached = extendedGridCache.get(product.id);
  if (cached) return cached;
  const extended = product.grid.map(extendRowToMaxSkus);
  extendedGridCache.set(product.id, extended);
  return extended;
}

/**
 * Look up the price per thousand cartons.
 * @param {string} productId - e.g. 'sleek-4pk'
 * @param {number} quantity - number of cartons ordered
 * @param {number} skuCount - number of SKUs (1–MAX_SKU_COLS)
 * @returns {{
 *   pricePerM: number, tierQty: number, totalCost: number,
 *   pricePerCarton: number,
 *   belowTier: boolean,           // qty < smallest tier (10k) — used cheapest tier anyway
 *   aboveMaxTier: boolean,        // qty > largest tier (100k) — used most-discounted tier
 *   skuExtrapolated: boolean,     // skuCount > 4 — used linear extrapolation
 * } | null}
 */
export function lookupPrice(productId, quantity, skuCount) {
  const product = products.find((p) => p.id === productId);
  if (!product) return null;

  const requestedSkus = Math.max(1, Math.min(MAX_SKU_COLS, Math.floor(skuCount || 1)));
  const skuIdx = requestedSkus - 1;
  const skuExtrapolated = requestedSkus > 4;
  const grid = getExtendedGrid(product);

  // Find the matching quantity tier (use the highest tier that doesn't exceed quantity).
  let tierIdx = 0;
  for (let i = 0; i < quantityTiers.length; i += 1) {
    if (quantity >= quantityTiers[i]) tierIdx = i;
  }
  const belowTier = quantity < quantityTiers[0];
  const aboveMaxTier = quantity > quantityTiers[quantityTiers.length - 1];

  const pricePerM = grid[tierIdx][skuIdx];
  const tierQty = quantityTiers[tierIdx];
  const totalCost = (quantity / 1000) * pricePerM;
  const pricePerCarton = pricePerM / 1000;

  return {
    pricePerM, tierQty, totalCost, pricePerCarton,
    belowTier, aboveMaxTier, skuExtrapolated,
  };
}

/**
 * Tier-up suggestion: would the user save money by ordering MORE cartons
 * to hit the next quantity tier? Returns the option, or null if already
 * at the top tier or no savings.
 *
 * @returns {{
 *   nextTierQty: number,
 *   extraCartons: number,
 *   currentTotal: number,
 *   nextTierTotal: number,
 *   savings: number,          // negative = no savings; positive = save by ordering extra
 *   nextPricePerM: number,
 * } | null}
 */
export function findTierUpOption(productId, quantity, skuCount) {
  const product = products.find((p) => p.id === productId);
  if (!product) return null;
  const requestedSkus = Math.max(1, Math.min(MAX_SKU_COLS, Math.floor(skuCount || 1)));
  const skuIdx = requestedSkus - 1;
  const grid = getExtendedGrid(product);

  // Determine current tier idx by the same rule as lookupPrice.
  let currentTierIdx = 0;
  for (let i = 0; i < quantityTiers.length; i += 1) {
    if (quantity >= quantityTiers[i]) currentTierIdx = i;
  }
  // If already at the top tier, no tier-up option.
  if (currentTierIdx >= quantityTiers.length - 1) return null;

  const nextTierIdx = currentTierIdx + 1;
  const nextTierQty = quantityTiers[nextTierIdx];
  // If the current quantity is already >= the next tier (shouldn't happen
  // given how we picked currentTierIdx, but defensive), no option.
  if (quantity >= nextTierQty) return null;

  const currentPricePerM = grid[currentTierIdx][skuIdx];
  const nextPricePerM = grid[nextTierIdx][skuIdx];
  const currentTotal = (quantity / 1000) * currentPricePerM;
  const nextTierTotal = (nextTierQty / 1000) * nextPricePerM;
  const extraCartons = nextTierQty - quantity;
  const savings = currentTotal - nextTierTotal;

  return {
    nextTierQty, extraCartons,
    currentTotal, nextTierTotal,
    savings, nextPricePerM,
  };
}

/**
 * Get all products for display.
 */
export function getProducts() {
  return products;
}

/**
 * Get the quantity tiers.
 */
export function getQuantityTiers() {
  return quantityTiers;
}

/**
 * Maximum SKU columns supported (1–N). Beyond column 4 is extrapolated.
 */
export function getMaxSkuCols() {
  return MAX_SKU_COLS;
}

export { NEW_ART_PREP_FEE };
