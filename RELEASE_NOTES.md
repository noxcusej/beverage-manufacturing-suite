# Release Notes

## 2026-04-28 Production Deploy

Deployment: https://beverage-manufacturing-suite.vercel.app

Commit: `e3eb585` - `Consolidate raw PO into run quoting`

### Changed

- Moved raw-material PO consolidation into Run Quoting.
- Removed the standalone Consolidated PO page and sidebar navigation item.
- Added a vendor-grouped Consolidated Raw Materials section to Run Quoting.
- Added raw PO export from Run Quoting using the existing live workbook export.
- Made ingredient cost per can calculated from selected formula data instead of manually entered.
- Moved stabilization into Bill of Materials as a standard per-unit item.
- Kept flavor case counts editable as the main production planning input.
- Added route-level code splitting and cleaned up lint/build issues across the app.

### Validation

- `npm run lint` passed.
- `npm run build` passed.
- Vercel production deployment completed successfully.
