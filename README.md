# Beverage Manufacturing Calculator Suite

Web-based calculators for beverage manufacturing and co-packing operations.

## Features

- **Batch Calculator** - Recipe scaling and ingredient calculations
- **Co-Packing Calculator** - Manufacturing cost estimation
- **Inventory Management** - Track ingredients and packaging
- **Price Sheets** - Manage services and packaging pricing
- **Mission Control** - Task board and team dashboard
- **Procurement** - Ramp-sourced purchase orders, bills, invoice attachments and client subtotals ([setup](docs/PROCUREMENT.md))
- **Client Portal** - a unique link per client showing only their POs, bills and files, with comments ([setup](docs/CLIENT_PORTAL.md))
- **Review deadlines** - a review window per bill or PO that locks when it closes; only an admin can move or reopen one ([setup](docs/REVIEW_DEADLINES.md))

## Usage

Open `index.html` in a web browser or serve with any HTTP server:

```bash
python3 -m http.server 8000
```

Then navigate to http://localhost:8000

## Tests

```bash
npm test                 # pure logic: procurement, review locks, portal isolation
npm run check:supabase   # verify the database is set up and RLS holds
```

## Tech Stack

- Pure HTML/CSS/JavaScript
- localStorage for data persistence
- No build process required
