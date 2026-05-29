// Canonical fee-type list. Shared by CoPackingCalculator (cost-side) and
// Services (catalog-side). Adding here means it works in both places —
// any divergence between the two lists silently corrupts data when the
// other side opens a row whose `feeType` it doesn't render.

export const FEE_TYPES = [
  { value: 'per-unit', label: 'Per Unit' },
  { value: 'per-pack', label: 'Per Pack' },
  { value: 'per-paktech-pack', label: 'Per PakTech Pack' },
  { value: 'per-paktech-case', label: 'Per PakTech Case' },
  { value: 'per-carton-pack', label: 'Per Carton Pack' },
  { value: 'per-variety-pack', label: 'Per Variety Pack' },
  { value: 'per-variety-case', label: 'Per Variety Case' },
  { value: 'per-case', label: 'Per Case' },
  { value: 'per-pallet', label: 'Per Pallet' },
  { value: 'per-batch', label: 'Per Batch' },
  { value: 'per-proof-gallon', label: 'Per Proof Gal' },
  { value: 'fixed', label: 'Fixed' },
];
