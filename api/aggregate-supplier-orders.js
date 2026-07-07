// Supplier Order Aggregation
// Pulls unfulfilled orders since the last confirmed checkpoint (falling back
// to a rolling 7-day window if no checkpoint is set), PLUS any order already
// in Shipment Tracking that still needs a supplier but hasn't shipped yet
// regardless of age (so nothing silently ages out of the pipeline),
// cross-references bins, determines correct supplier per item via the
// decision tree, writes to Google Sheet.

import jwt from 'jsonwebtoken';

const SHOP = process.env.SHOPIFY_SHOP;
const CLIENT_ID = process.env.SHOPIFY_CLIENT_ID;
const CLIENT_SECRET = process.env.SHOPIFY_CLIENT_SECRET;
const API_VERSION = '2025-01';
const BIN_TRACKER_URL = 'https://dhg-bin-tracker-app.vercel.app';

const SKUS_SHEET_ID = '1yC-oZ-0hD5ReTcOA9iTjTGC6mONbDUCpfbZZA9GrQtI';
const AGG_SHEET_ID = '1rsUU7qZJZGhivsofBiFPa7FK6qnHosrxps10NYzLxAE';

// ── Cron Config tab ──────────────────────────────────────────────────────────
// A2 = "Last Order Included" (label, informational)      B2 = order name, e.g. "#5401"
// This is a MANUAL checkpoint - Iain updates B2 himself after actually placing
// an order with a supplier each week. The cron never writes this cell itself;
// it only reads it, so there's no risk of the cron silently advancing past an
// order that didn't actually get placed. If B2 is empty (first run, or after
// a reset), the scan falls back to the legacy rolling 7-day window.
const CONFIG_TAB = 'Cron Config';
const CONFIG_CHECKPOINT_CELL = `'${CONFIG_TAB}'!B2`;

const GOOGLE_SA_EMAIL_VAR = () => process.env.GOOGLE_SA_EMAIL;
const GOOGLE_SA_PRIVATE_KEY_VAR = () => (process.env.GOOGLE_SA_PRIVATE_KEY || '').replace(/\\n/g, '\n');

// ── Shopify Auth ─────────────────────────────────────────────────────────────
let _token = null;
let _tokenExpiresAt = 0;

async function getShopifyToken() {
  if (_token && Date.now() < _tokenExpiresAt - 60_000) return _token;
  const res = await fetch(`https://${SHOP}/admin/oauth/access_token`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      grant_type: 'client_credentials',
      client_id: CLIENT_ID,
      client_secret: CLIENT_SECRET,
    }),
  });
  if (!res.ok) throw new Error(`Shopify token request failed: ${res.status}`);
  const { access_token, expires_in } = await res.json();
  _token = access_token;
  _tokenExpiresAt = Date.now() + expires_in * 1000;
  return _token;
}

async function shopifyGraphql(query, variables = {}) {
  const token = await getShopifyToken();
  const res = await fetch(`https://${SHOP}/admin/api/${API_VERSION}/graphql.json`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'X-Shopify-Access-Token': token },
    body: JSON.stringify({ query, variables }),
  });
  if (!res.ok) throw new Error(`Shopify GraphQL failed: ${res.status}`);
  const { data, errors } = await res.json();
  if (errors?.length) throw new Error(`Shopify GraphQL errors: ${JSON.stringify(errors)}`);
  return data;
}

// ── Google Sheets Auth ──────────────────────────────────────────────────────
async function getGoogleToken(readOnly = false) {
  const scope = readOnly
    ? 'https://www.googleapis.com/auth/spreadsheets.readonly'
    : 'https://www.googleapis.com/auth/spreadsheets';

  const token = jwt.sign(
    { scope },
    GOOGLE_SA_PRIVATE_KEY_VAR(),
    {
      algorithm: 'RS256',
      issuer: GOOGLE_SA_EMAIL_VAR(),
      audience: 'https://oauth2.googleapis.com/token',
      expiresIn: '1h',
    }
  );

  const res = await fetch('https://oauth2.googleapis.com/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      grant_type: 'urn:ietf:params:oauth:grant-type:jwt-bearer',
      assertion: token,
    }),
  });
  if (!res.ok) throw new Error(`Google token request failed: ${res.status} ${await res.text()}`);
  const { access_token } = await res.json();
  return access_token;
}

async function sheetsGet(spreadsheetId, range, readOnly = true) {
  const token = await getGoogleToken(readOnly);
  const res = await fetch(
    `https://sheets.googleapis.com/v4/spreadsheets/${spreadsheetId}/values/${encodeURIComponent(range)}`,
    { headers: { 'Authorization': `Bearer ${token}` } }
  );
  if (!res.ok) throw new Error(`Sheets GET failed: ${res.status} ${await res.text()}`);
  const data = await res.json();
  return data.values || [];
}

async function sheetsPut(spreadsheetId, range, values) {
  const token = await getGoogleToken(false);
  const res = await fetch(
    `https://sheets.googleapis.com/v4/spreadsheets/${spreadsheetId}/values/${encodeURIComponent(range)}?valueInputOption=RAW`,
    {
      method: 'PUT',
      headers: { 'Authorization': `Bearer ${token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ values }),
    }
  );
  if (!res.ok) throw new Error(`Sheets PUT failed: ${res.status} ${await res.text()}`);
  return await res.json();
}

async function sheetsClear(spreadsheetId, range) {
  const token = await getGoogleToken(false);
  const res = await fetch(
    `https://sheets.googleapis.com/v4/spreadsheets/${spreadsheetId}/values/${encodeURIComponent(range)}:clear`,
    { method: 'POST', headers: { 'Authorization': `Bearer ${token}` } }
  );
  if (!res.ok) throw new Error(`Sheets clear failed: ${res.status} ${await res.text()}`);
}

async function ensureConfigTabExists() {
  const token = await getGoogleToken(false);
  const metaRes = await fetch(
    `https://sheets.googleapis.com/v4/spreadsheets/${AGG_SHEET_ID}?fields=sheets.properties.title`,
    { headers: { 'Authorization': `Bearer ${token}` } }
  );
  const meta = await metaRes.json();
  const titles = meta.sheets.map(s => s.properties.title);
  if (titles.includes(CONFIG_TAB)) return;
  await fetch(
    `https://sheets.googleapis.com/v4/spreadsheets/${AGG_SHEET_ID}:batchUpdate`,
    {
      method: 'POST',
      headers: { 'Authorization': `Bearer ${token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ requests: [{ addSheet: { properties: { title: CONFIG_TAB } } }] }),
    }
  );
  await sheetsPut(AGG_SHEET_ID, `'${CONFIG_TAB}'!A1:B2`, [
    ['Setting', 'Value'],
    ['Last Order Included', ''],
  ]);
}

// ── Build lookup maps from Sheet1, APS - US Only, Universal Dist export, Garland ──
function rowsToObjects(rows) {
  const [header, ...rest] = rows;
  return rest.map(row => {
    const obj = {};
    header.forEach((h, i) => { obj[h] = row[i] ?? ''; });
    return obj;
  });
}

async function loadSupplierData() {
  // Sheet1: Handle, Title, Tags, Variant SKU, ACDD SKU, Variant Inventory Policy
  const sheet1Rows = await sheetsGet(SKUS_SHEET_ID, 'Sheet1!A1:F');
  const sheet1 = rowsToObjects(sheet1Rows);
  const bySku = new Map();
  for (const row of sheet1) {
    const sku = row['Variant SKU']?.trim();
    if (sku) bySku.set(sku, row);
  }

  // Asmodee stock export. Cowork migrated this from "APS - US Only" (2-row
  // preamble before the header) to a plain "Asmodee" tab at some point -
  // detect the header row dynamically rather than assuming either layout,
  // since this has already silently drifted once.
  const asmodeeRaw = await sheetsGet(SKUS_SHEET_ID, "'Asmodee'!A1:J20");
  const asmodeeHeaderRowIdx = asmodeeRaw.findIndex(row => row[0] === 'Code');
  if (asmodeeHeaderRowIdx === -1) {
    throw new Error('Could not find Asmodee tab header row (looked for "Code" in column A within the first 20 rows)');
  }
  const asmodeeAllRows = await sheetsGet(SKUS_SHEET_ID, `'Asmodee'!A${asmodeeHeaderRowIdx + 1}:J`);
  const asmodeeHeader = asmodeeAllRows[0];
  const asmodeeData = rowsToObjects([asmodeeHeader, ...asmodeeAllRows.slice(1)]);
  const asmodeeByCode = new Map();
  for (const row of asmodeeData) {
    const code = row['Code']?.trim();
    if (code) asmodeeByCode.set(code, row);
  }

  // Universal Dist stock export. Cowork migrated this from dated
  // "Inventory_Export_YYYY-MM-DD" tabs to a plain "Alliance" tab - the most
  // recent dated tab (2026-04-15) is now permanently stale since no new ones
  // get created. Read "Alliance" directly instead.
  const udRaw = await sheetsGet(SKUS_SHEET_ID, "'Alliance'!A1:N20");
  const udHeaderRowIdx = udRaw.findIndex(row => row[0] === 'Category Name');
  if (udHeaderRowIdx === -1) {
    throw new Error('Could not find Alliance tab header row (looked for "Category Name" in column A within the first 20 rows)');
  }
  const udAllRows = await sheetsGet(SKUS_SHEET_ID, `'Alliance'!A${udHeaderRowIdx + 1}:N`);
  const udHeader = udAllRows[0];
  const udData = rowsToObjects([udHeader, ...udAllRows.slice(1)]);
  let universalByVendorItem = new Map();
  for (const row of udData) {
    const vendorItem = row['Vendor Item No.']?.trim();
    if (vendorItem) universalByVendorItem.set(vendorItem, row);
  }

  // Universal Dist catalog tab (Variant SKU -> Barcode) - used to backfill the
  // Barcode column on the Universal Dist Order tab, since UD's own systems
  // match by barcode rather than by SKU/Vendor Item No.
  const udCatalogRows = await sheetsGet(SKUS_SHEET_ID, "'Universal Dist'!A1:L");
  const udCatalogData = rowsToObjects(udCatalogRows);
  const udBarcodeBySku = new Map();
  for (const row of udCatalogData) {
    const variantSku = row['Variant SKU']?.trim();
    const barcode = row['Barcode']?.trim();
    if (variantSku && barcode) udBarcodeBySku.set(variantSku, barcode);
  }

  // Garland (ACDD): header row position isn't stable - Cowork's automated
  // rewrites put it at row 3 (timestamp + blank row preamble), but manual
  // edits have left it at row 1 before. Detect the actual header row instead
  // of hardcoding either, so this doesn't silently break again.
  const garlandRaw = await sheetsGet(SKUS_SHEET_ID, 'Garland!A1:H20');
  const garlandHeaderRowIdx = garlandRaw.findIndex(row => row[0] === 'ItemID');
  if (garlandHeaderRowIdx === -1) {
    throw new Error('Could not find Garland tab header row (looked for "ItemID" in column A within the first 20 rows)');
  }
  const garlandAllRows = await sheetsGet(SKUS_SHEET_ID, `Garland!A${garlandHeaderRowIdx + 1}:H`);
  const garlandHeader = garlandAllRows[0];
  const garlandData = rowsToObjects([garlandHeader, ...garlandAllRows.slice(1)]);
  const garlandByItemId = new Map();
  for (const row of garlandData) {
    const itemId = row['ItemID']?.trim();
    if (itemId) garlandByItemId.set(itemId, row);
  }

  return { bySku, asmodeeByCode, universalByVendorItem, garlandByItemId, udBarcodeBySku };
}

// ── Supplier decision tree ──────────────────────────────────────────────────
const ASMODEE_UNAVAILABLE = new Set(['Out of Stock']);

function decideSupplier(sku, title, sheetData) {
  const skuRow = sheetData.bySku.get(sku);
  const tags = (skuRow?.['Tags'] || '').toLowerCase();
  const acddSku = skuRow?.['ACDD SKU']?.trim();

  const hasAsmodee = tags.includes('asmodee');
  const hasAlliance = tags.includes('alliance');

  function tryAcdd(reason) {
    if (!acddSku || acddSku === '#N/A') {
      return { supplier: 'manual_review', reason: `${reason}; no ACDD SKU mapped` };
    }
    const garlandRow = sheetData.garlandByItemId.get(acddSku);
    if (garlandRow) {
      return { supplier: 'acdd', acddSku, reason };
    }
    return { supplier: 'manual_review', reason: `${reason}; not found at ACDD either` };
  }

  if (hasAsmodee) {
    const asmodeeRow = sheetData.asmodeeByCode.get(sku);
    if (!asmodeeRow) {
      return tryAcdd('Not found in Asmodee catalog');
    }
    const status = asmodeeRow['Stock Status'];
    if (ASMODEE_UNAVAILABLE.has(status)) {
      return tryAcdd(`Asmodee: ${status}`);
    }
    return { supplier: 'asmodee', stockStatus: status };
  }

  if (hasAlliance) {
    const udRow = sheetData.universalByVendorItem.get(sku);
    if (!udRow) {
      return tryAcdd('Not found at any Universal Dist warehouse');
    }
    const warehouses = ['RDL', 'FWA', 'AUS', 'VIS'];
    for (const wh of warehouses) {
      if (udRow[wh]?.trim().toLowerCase() === 'yes') {
        return { supplier: 'universal_dist', warehouse: wh };
      }
    }
    return tryAcdd('Out of stock at all Universal Dist warehouses');
  }

  // No recognized supplier tag at all
  return { supplier: 'manual_review', reason: 'No Asmodee or Alliance tag found' };
}

// ── Determine the scan window: checkpoint order (preferred) or rolling 7-day ──

async function getOrderCreatedAt(orderName) {
  const cleanName = orderName.trim().replace(/^#/, '');
  const data = await shopifyGraphql(`
    query getOrder($q: String!) {
      orders(first: 1, query: $q) { edges { node { name createdAt } } }
    }
  `, { q: `name:${cleanName}` });
  const edge = data.orders.edges[0];
  return edge ? edge.node.createdAt : null;
}

async function getScanWindow() {
  await ensureConfigTabExists();
  const rows = await sheetsGet(AGG_SHEET_ID, CONFIG_CHECKPOINT_CELL).catch(() => []);
  const checkpointOrder = rows?.[0]?.[0]?.trim();

  if (checkpointOrder) {
    const createdAt = await getOrderCreatedAt(checkpointOrder);
    if (createdAt) {
      return {
        mode: 'checkpoint',
        checkpointOrder,
        // Strictly after the checkpoint order's own timestamp, so it isn't
        // re-included alongside whatever's genuinely new since then.
        query: `fulfillment_status:unfulfilled -status:cancelled created_at:>${createdAt}`,
      };
    }
    // Checkpoint order couldn't be found (typo, or the order was deleted) -
    // fall back rather than silently scanning nothing or erroring the whole run.
    console.warn(`Checkpoint order "${checkpointOrder}" not found in Shopify - falling back to rolling 7-day window.`);
  }

  const sevenDaysAgo = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000).toISOString();
  return {
    mode: 'rolling-7-day',
    checkpointOrder: null,
    query: `fulfillment_status:unfulfilled -status:cancelled created_at:>=${sevenDaysAgo}`,
  };
}

// ── Pull unfulfilled orders since the scan window's cutoff ──────────────────
async function getRecentUnfulfilledOrders(scanWindow) {
  const allOrders = [];
  let cursor = null;
  let hasNextPage = true;

  while (hasNextPage) {
    const data = await shopifyGraphql(`
      query getOrders($cursor: String, $query: String!) {
        orders(first: 50, after: $cursor, query: $query) {
          pageInfo { hasNextPage endCursor }
          edges {
            node {
              id
              name
              createdAt
              tags
              lineItems(first: 50) {
                edges {
                  node {
                    title
                    quantity
                    currentQuantity
                    sku
                    product { id }
                  }
                }
              }
            }
          }
        }
      }
    `, { cursor, query: scanWindow.query });

    for (const edge of data.orders.edges) {
      allOrders.push(edge.node);
    }
    hasNextPage = data.orders.pageInfo.hasNextPage;
    cursor = data.orders.pageInfo.endCursor;
  }

  return allOrders;
}

// ── Stragglers: orders already in Shipment Tracking that still need a
// supplier but haven't been marked Shipped yet ──────────────────────────────
// The checkpoint/date-based scan above only catches orders created since the
// last confirmed checkpoint - that's correct for catching new orders, but it
// means an order that entered the pipeline and then didn't get fully shipped
// within roughly a week silently ages out of every future run and never gets
// re-submitted for reconciliation. This pulls those orders back in by name,
// bypassing the date filter entirely, so nothing can get permanently stuck.
async function getStragglerOrders() {
  const rows = await sheetsGet(AGG_SHEET_ID, "'Shipment Tracking'!A2:F1000");
  const stragglerNames = [];
  for (const row of rows) {
    if (!row.length || !row[0]) continue;
    const needed = new Set((row[1] || '').split(',').map(s => s.trim()).filter(Boolean));
    const shipped = new Set((row[3] || '').split(',').map(s => s.trim()).filter(Boolean));
    const stillNeeded = [...needed].some(s => !shipped.has(s));
    if (stillNeeded) stragglerNames.push(row[0]);
  }
  if (!stragglerNames.length) return [];

  const cleanNames = stragglerNames.map(n => n.trim().replace(/^#/, ''));
  const nameQuery = cleanNames.map(n => `name:${n}`).join(' OR ');
  const data = await shopifyGraphql(`
    query getStragglers($q: String!) {
      orders(first: 250, query: $q) {
        edges {
          node {
            id
            name
            createdAt
            tags
            lineItems(first: 50) {
              edges {
                node {
                  title
                  quantity
                  currentQuantity
                  sku
                  product { id }
                }
              }
            }
          }
        }
      }
    }
  `, { q: nameQuery });
  return data.orders.edges.map(e => e.node);
}


  const res = await fetch(`${BIN_TRACKER_URL}/api/bins`);
  if (!res.ok) throw new Error(`Bin tracker fetch failed: ${res.status}`);
  const data = await res.json();
  return data.bins || data;
}

function buildBinLookup(bins) {
  const byProductId = new Map();
  for (const [binKey, items] of Object.entries(bins)) {
    for (const item of items) {
      if (!byProductId.has(item.productId)) byProductId.set(item.productId, []);
      byProductId.get(item.productId).push({ binKey, quantity: item.quantity });
    }
  }
  return byProductId;
}

// ── Newly Available Backorders (written by the Sunday night Backorder Sweep) ─
// These orders are often well past the scan window above, so they need to be
// folded in separately rather than relying on the normal order scan to catch
// them. Cleared after being read so the same row isn't picked up again next
// Monday.
const BACKORDER_TAB = 'Newly Available Backorders';

async function getAndClearNewlyAvailableBackorders() {
  const rows = await sheetsGet(AGG_SHEET_ID, `'${BACKORDER_TAB}'!A2:E1000`).catch(() => []);
  const filtered = rows.filter(r => r.length && r[0]);
  if (filtered.length) {
    await sheetsClear(AGG_SHEET_ID, `'${BACKORDER_TAB}'!A2:E1000`);
  }
  // Columns: Order, SKU, Quantity, Title, Supplier (Supplier is informational
  // only - this script re-runs decideSupplier itself below so routing stays
  // consistent with current data rather than trusting a day-old snapshot).
  return filtered.map(r => ({
    orderName: r[0],
    sku: r[1]?.trim(),
    quantity: parseInt(r[2], 10) || 0,
    title: r[3] || '',
  }));
}

// ── Main handler ─────────────────────────────────────────────────────────────
export default async function handler(req, res) {
  const auth = req.headers['authorization'];
  if (auth !== `Bearer ${process.env.CRON_SECRET}`) {
    return res.status(401).json({ error: 'Unauthorized' });
  }

  try {
    const scanWindow = await getScanWindow();

    const [scannedOrders, sheetData, bins, backorderRows, stragglerOrders] = await Promise.all([
      getRecentUnfulfilledOrders(scanWindow),
      loadSupplierData(),
      getBinData(),
      getAndClearNewlyAvailableBackorders(),
      getStragglerOrders(),
    ]);

    // Merge stragglers in, deduping by name in case an order is somehow
    // caught by both (e.g. the checkpoint window happens to include it too).
    const seenOrderNames = new Set(scannedOrders.map(o => o.name));
    const newStragglers = stragglerOrders.filter(o => !seenOrderNames.has(o.name));
    const orders = [...scannedOrders, ...newStragglers];

    const binLookup = buildBinLookup(bins);

    // Aggregate line items by SKU across all matching orders
    const aggregated = new Map(); // sku -> { title, totalQty, productId, orderNames: [] }

    for (const order of orders) {
      for (const edge of order.lineItems.edges) {
        const item = edge.node;
        const sku = item.sku?.trim();
        if (!sku) continue;

        // currentQuantity reflects the amount still actually owed after any
        // refunds/edits - quantity is the original order amount and never
        // changes. A partially-refunded order (e.g. one item refunded, rest
        // still active) would otherwise keep aggregating demand for an item
        // that's genuinely gone, blocking that order from ever reconciling.
        const qty = item.currentQuantity;
        if (!qty || qty <= 0) continue;

        if (!aggregated.has(sku)) {
          aggregated.set(sku, {
            title: item.title,
            productId: item.product?.id,
            totalQty: 0,
            orderNames: [],
          });
        }
        const entry = aggregated.get(sku);
        entry.totalQty += qty;
        entry.orderNames.push(order.name);
      }
    }

    // Merge in newly-available backorders from the Sunday sweep. No
    // productId is available here, so these items won't show up in the
    // "Already In Bins" advisory list, but routing still runs through the
    // same decision tree below.
    for (const b of backorderRows) {
      if (!b.sku) continue;
      if (!aggregated.has(b.sku)) {
        aggregated.set(b.sku, { title: b.title, productId: null, totalQty: 0, orderNames: [] });
      }
      const entry = aggregated.get(b.sku);
      entry.totalQty += b.quantity;
      entry.orderNames.push(b.orderName);
    }


    const alreadyInBins = [];
    const asmodeeOrders = [];
    const universalOrders = [];
    const acddOrders = [];
    const manualReview = [];

    // Tracks which suppliers each ORDER (not SKU) actually needs, so we can
    // create its Shipment Tracking row below. Built from resolved decisions
    // only - "Already In Bins" items need no supplier at all, and
    // "manual_review" items have no resolved supplier yet, so neither
    // contributes to an order's needed-supplier set until resolved.
    const orderSuppliersNeeded = new Map(); // orderName -> Set of 'Asmodee'|'Universal Dist'|'ACDD'
    const SUPPLIER_LABELS = { asmodee: 'Asmodee', universal_dist: 'Universal Dist', acdd: 'ACDD' };

    for (const [sku, entry] of aggregated.entries()) {
      const orderNamesStr = [...new Set(entry.orderNames)].join(', ');

      // Check bins first - advisory only, doesn't stop supplier evaluation
      const binMatches = entry.productId ? binLookup.get(entry.productId) : null;
      if (binMatches && binMatches.length > 0) {
        const binLocStr = binMatches.map(b => `${b.binKey}(${b.quantity})`).join(', ');
        alreadyInBins.push([sku, entry.title, entry.totalQty, binLocStr, orderNamesStr, '']);
      }

      const decision = decideSupplier(sku, entry.title, sheetData);
      const label = SUPPLIER_LABELS[decision.supplier];
      if (label) {
        for (const orderName of new Set(entry.orderNames)) {
          if (!orderSuppliersNeeded.has(orderName)) orderSuppliersNeeded.set(orderName, new Set());
          orderSuppliersNeeded.get(orderName).add(label);
        }
      }

      if (decision.supplier === 'asmodee') {
        asmodeeOrders.push([sku, entry.totalQty, 'Each', '', entry.title, decision.stockStatus, orderNamesStr, '']);
      } else if (decision.supplier === 'universal_dist') {
        const barcode = sheetData.udBarcodeBySku.get(sku) || '';
        universalOrders.push([sku, barcode, entry.totalQty, entry.title, decision.warehouse, orderNamesStr, '']);
      } else if (decision.supplier === 'acdd') {
        acddOrders.push([decision.acddSku, sku, entry.totalQty, entry.title, orderNamesStr, decision.reason || '']);
      } else {
        manualReview.push([sku, entry.title, entry.totalQty, orderNamesStr, decision.reason, '']);
      }
    }

    // ── Create Shipment Tracking rows for any order that needs a supplier
    // and doesn't already have one. This is the step that was missing
    // entirely before - without it, orders aggregated here never show up for
    // the Ordered/Shipped/Arrived buttons to act on, no matter how many
    // times those buttons get clicked.
    const existingTrackingRows = await sheetsGet(AGG_SHEET_ID, "'Shipment Tracking'!A2:F1000");
    const existingTrackingOrders = new Set(existingTrackingRows.filter(r => r.length && r[0]).map(r => r[0]));

    const newTrackingRows = [];
    for (const [orderName, suppliers] of orderSuppliersNeeded.entries()) {
      if (existingTrackingOrders.has(orderName)) continue; // already tracked, don't duplicate or reset progress
      if (suppliers.size === 0) continue; // shouldn't happen given the loop above, but guard anyway
      const neededStr = [...suppliers].sort().join(', ');
      newTrackingRows.push([orderName, neededStr, '', '', '', 'Pending Order']);
    }
    if (newTrackingRows.length) {
      await sheetsPut(
        AGG_SHEET_ID,
        `'Shipment Tracking'!A${existingTrackingRows.length + 2}:F${existingTrackingRows.length + 1 + newTrackingRows.length}`,
        newTrackingRows
      );
    }


    // Clear and write each tab
    await sheetsClear(AGG_SHEET_ID, 'Already In Bins!A2:F1000');
    await sheetsClear(AGG_SHEET_ID, 'Asmodee Order!A2:H1000');
    await sheetsClear(AGG_SHEET_ID, 'Universal Dist Order!A2:H1000');
    await sheetsClear(AGG_SHEET_ID, 'ACDD Order!A2:G1000');
    await sheetsClear(AGG_SHEET_ID, 'Needs Manual Review!A2:F1000');

    if (alreadyInBins.length) await sheetsPut(AGG_SHEET_ID, `Already In Bins!A2:F${alreadyInBins.length + 1}`, alreadyInBins);
    if (asmodeeOrders.length) await sheetsPut(AGG_SHEET_ID, `Asmodee Order!A2:H${asmodeeOrders.length + 1}`, asmodeeOrders);
    if (universalOrders.length) await sheetsPut(AGG_SHEET_ID, `Universal Dist Order!A2:G${universalOrders.length + 1}`, universalOrders);
    if (acddOrders.length) await sheetsPut(AGG_SHEET_ID, `ACDD Order!A2:F${acddOrders.length + 1}`, acddOrders);
    if (manualReview.length) await sheetsPut(AGG_SHEET_ID, `Needs Manual Review!A2:F${manualReview.length + 1}`, manualReview);

    // Newest order actually scanned this run - NOT written anywhere
    // automatically. Surfaced here so it's easy to copy into the Cron Config
    // tab's checkpoint cell after confirming what actually got ordered.
    const newestOrderThisRun = orders.length
      ? orders.reduce((latest, o) => (new Date(o.createdAt) > new Date(latest.createdAt) ? o : latest)).name
      : null;

    return res.status(200).json({
      success: true,
      scanMode: scanWindow.mode,
      scanCheckpointUsed: scanWindow.checkpointOrder,
      ordersScanned: orders.length,
      ordersFromDateScan: scannedOrders.length,
      stragglersReincluded: newStragglers.length,
      stragglersReincludedFor: newStragglers.map(o => o.name),
      backordersMerged: backorderRows.length,
      uniqueSkus: aggregated.size,
      alreadyInBins: alreadyInBins.length,
      asmodee: asmodeeOrders.length,
      universalDist: universalOrders.length,
      acdd: acddOrders.length,
      needsManualReview: manualReview.length,
      universalDistTabUsed: 'Alliance',
      shipmentTrackingRowsCreated: newTrackingRows.length,
      shipmentTrackingRowsCreatedFor: newTrackingRows.map(r => r[0]),
      suggestedNextCheckpoint: newestOrderThisRun,
      note: `After you actually place this week's supplier order(s), set '${CONFIG_TAB}'!B2 to the last order number you included (e.g. "${newestOrderThisRun || '#5401'}") so next week's scan starts right after it.`,
    });

  } catch (err) {
    console.error('Supplier aggregation error:', err);
    return res.status(500).json({ error: err.message, stack: err.stack });
  }
}
