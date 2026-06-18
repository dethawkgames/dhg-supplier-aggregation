# DHG Supplier Order Aggregation

Pulls unfulfilled orders from the last 7 days, determines which supplier each item should be ordered from (Asmodee / Universal Dist / ACDD), cross-references the bin tracker for items you might already have on hand, and writes everything to a Google Sheet for Monday review.

## How the supplier decision works

For each unique SKU across all qualifying orders:

1. **Tagged `asmodee`** → check `APS - US Only` tab by `Code`.
   - Anything except "Out of Stock" → order from **Asmodee**.
   - "Out of Stock" or not found → fall through to ACDD check.
2. **Tagged `Alliance`** → check the current `Inventory_Export_*` tab by `Vendor Item No.`.
   - `RDL` = Yes → order from **Universal Dist (RDL)**.
   - `RDL` = No, check `FWA` → `AUS` → `VIS` in order → order from first warehouse with Yes.
   - Not found, or all four warehouses = No → fall through to ACDD check.
3. **ACDD fallback** → look up the SKU's `ACDD SKU` from `Sheet1`.
   - If `#N/A` or missing → flag in **Needs Manual Review** ("no ACDD SKU mapped").
   - Else check `Garland` tab by `ItemID`. Presence in that sheet = in stock at ACDD.
   - Found → order from **ACDD**. Not found → flag in **Needs Manual Review**.
4. **No Asmodee or Alliance tag at all** → flag in **Needs Manual Review**.

Separately, every aggregated SKU is checked against the live Bin Tracker. If any quantity exists in a bin (or on the shelf), it's listed in **Already In Bins** — this is purely advisory and doesn't change which supplier tab the item lands on. You decide whether to skip ordering it.

## Output: Google Sheet tabs

Sheet ID: `1rsUU7qZJZGhivsofBiFPa7FK6qnHosrxps10NYzLxAE`

| Tab | Purpose |
|---|---|
| **Already In Bins** | Advisory — items needed that already have stock somewhere in the bin tracker |
| **Asmodee Order** | First 4 columns (`ProductId`, `Quantity`, `UnitOfMeasureId`, `VariantId`) match Asmodee's checkout CSV upload format exactly — copy those into their upload tool. `UnitOfMeasureId` defaults to `Each`; change to `Case` yourself if the per-supplier math favors it for a high-quantity item. |
| **Universal Dist Order** | Manual entry reference — SKU, quantity, which warehouse to request |
| **ACDD Order** | Manual entry reference — includes both the ACDD SKU and your Shopify SKU for cross-checking |
| **Needs Manual Review** | Items that couldn't be resolved to any supplier automatically — out of stock everywhere checked, or missing a tag/mapping |

Each tab is fully cleared and rewritten on every run — it reflects only the most recent aggregation, not a running history.

## Source data dependencies

This tool reads three "raw" supplier sheets that need to stay fresh (currently maintained via a separate Cowork process that imports each supplier's weekly CSV directly into this same spreadsheet):

- **`Asmodee`** — Asmodee's stock export (`Code`, `Stock Status`, etc.)
- **`Alliance`** — Universal Dist's stock export (`Vendor Item No.`, `RDL`/`FWA`/`AUS`/`VIS` warehouse columns)
- **`Garland`** — ACDD's stock export (`ItemID`)

And one stable reference sheet:

- **`Sheet1`** — the master Product SKUs sheet, used for `Tags` (supplier assignment) and `ACDD SKU` (cross-reference mapping)

All four live in the existing Product SKUs spreadsheet: `1yC-oZ-0hD5ReTcOA9iTjTGC6mONbDUCpfbZZA9GrQtI`

There's also an `In Stock` tab in that spreadsheet — not used by this tool.

**Known limitation:** not every SKU has an `ACDD SKU` mapped in `Sheet1` yet (this mapping is built via manual VLookup matching by product name, ongoing work). Items missing this mapping that also fail at their primary supplier land in Needs Manual Review rather than guessing.

## Deployment

### 1. Push to GitHub, then import to Vercel (same pattern as other DHG projects)

```bash
git init
git add .
git commit -m "Initial supplier order aggregation tool"
git remote add origin https://github.com/dethawkgames/dhg-supplier-aggregation.git
git push -u origin main
```

### 2. Environment variables

| Variable | Value |
|---|---|
| `SHOPIFY_SHOP` | `detective-hawk-games.myshopify.com` |
| `SHOPIFY_CLIENT_ID` | (same as other DHG Vercel projects) |
| `SHOPIFY_CLIENT_SECRET` | (same as other DHG Vercel projects) |
| `GOOGLE_SA_EMAIL` | `dhg-sheets-bot@dhg-automation.iam.gserviceaccount.com` |
| `GOOGLE_SA_PRIVATE_KEY` | The full private key from the service account JSON, **including** the `-----BEGIN PRIVATE KEY-----` / `-----END PRIVATE KEY-----` lines. Paste literal `\n` for line breaks if Vercel's UI collapses them to one line, since the code converts `\n` back to real newlines automatically. |
| `CRON_SECRET` | Any random string, e.g. `dhgagg2026xz41` |

### 3. Deploy

```bash
vercel --prod
```

### 4. Test on demand

```bash
curl -X GET "https://YOUR-DEPLOYMENT-URL.vercel.app/api/aggregate-supplier-orders" \
  -H "Authorization: Bearer YOUR_CRON_SECRET"
```

Response includes counts per tab so you can sanity-check before opening the sheet.

### Cron schedule

Runs automatically every **Monday at 7am ET** (`vercel.json` → `0 12 * * 1` UTC).
