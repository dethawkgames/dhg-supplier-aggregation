// Order Needs Aggregation (v2 — per-unit tracking)
//
// Replaces aggregate-supplier-orders.js's Shipment Tracking role. Instead of
// one row per (order, supplier) with quantity discarded, this writes one row
// per physical UNIT still owed to a supplier, to the 'Order Needs' tab. Each
// row's Supplier Order ID is blank until a real "Lock & Order" action (a
// separate endpoint, not this cron) stamps it — so a unit that's part of an
// old, not-yet-locked need can never be silently swept up by a stage-advance
// action the way #5467 was under the old schema.
//
// This script is intentionally conservative: it only ADDS rows for units
// that don't already have one. It never deletes or reassigns a row that
// already carries a Supplier Order ID (locked = frozen, only stage-advance
// actions touch it going forward). If Shopify's currentQuantity for an
// order+SKU drops below the number of existing UNLOCKED rows (a partial
// refund/edit), it removes just enough unlocked rows to match — and if there
// aren't enough unlocked rows to safely absorb the drop (i.e. the reduction
// eats into locked/committed units), it does NOT touch anything and instead
// logs the order+SKU to 'Needs Manual Review' for a human decision, since a
// unit already committed to a real supplier order shouldn't be silently
// uncommitted by an automated script.

import jwt from 'jsonwebtoken';

const SHOP = process.env.SHOPIFY_SHOP;
const CLIENT_ID = process.env.SHOPIFY_CLIENT_ID;
const CLIENT_SECRET = process.env.SHOPIFY_CLIENT_SECRET;
const API_VERSION = '2025-01';
const BIN_TRACKER_URL = 'https://dhg-bin-tracker-app.vercel.app';

const SKUS_SHEET_ID = '1yC-oZ-0hD5ReTcOA9iTjTGC6mONbDUCpfbZZA9GrQtI';
const AGG_SHEET_ID = '1rsUU7qZJZGhivsofBiFPa7FK6qnHosrxps10NYzLxAE';

const ORDER_NEEDS_TAB = 'Order Needs';
const ORDER_NEEDS_RANGE = `'${ORDER_NEEDS_TAB}'!A2:H50000`;
const ORDER_NEEDS_HEADER = ['Order Name', 'SKU', 'Title', 'Supplier', 'Unit #', 'Supplier Order ID', 'Stage', 'Last Updated'];

const CONFIG_TAB = 'Cron Config';
const CONFIG_CHECKPOINT_CELL = `'${CONFIG_TAB}'!B2`;

const SUPPLIER_LABELS = { asmodee: 'Asmodee', universal_dist: 'Universal Dist', acdd: 'ACDD' };

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
    (process.env.GOOGLE_SA_PRIVATE_KEY || '').replace(/\\n/g, '\n'),
    {
      algorithm: 'RS256',
      issuer: process.env.GOOGLE_SA_EMAIL,
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

async function sheetsAppend(spreadsheetId, range, values) {
  const token = await getGoogleToken(false);
  const res = await fetch(
    `https://sheets.googleapis.com/v4/spreadsheets/${spreadsheetId}/values/${encodeURIComponent(range)}:append?valueInputOption=RAW&insertDataOption=INSERT_ROWS`,
    {
      method: 'POST',
      headers: { 'Authorization': `Bearer ${token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ values }),
    }
  );
  if (!res.ok) throw new Error(`Sheets append failed: ${res.status} ${await res.text()}`);
  return await res.json();
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

async function ensureTabExists(title, header) {
  const token = await getGoogleToken(false);
  const metaRes = await fetch(
    `https://sheets.googleapis.com/v4/spreadsheets/${AGG_SHEET_ID}?fields=sheets.properties.title`,
    { headers: { 'Authorization': `Bearer ${token}` } }
  );
  const meta = await metaRes.json();
  const titles = meta.sheets.map(s => s.properties.title);
  if (titles.includes(title)) return;
  await fetch(
    `https://sheets.googleapis.com/v4/spreadsheets/${AGG_SHEET_ID}:batchUpdate`,
    {
      method: 'POST',
      headers: { 'Authorization': `Bearer ${token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ requests: [{ addSheet: { properties: { title } } }] }),
    }
  );
  await sheetsPut(AGG_SHEET_ID, `'${title}'!A1:${String.fromCharCode(64 + header.length)}1`, [header]);
}

// ── Build lookup maps (identical to v1) ──────────────────────────────────────
function rowsToObjects(rows) {
  const [header, ...rest] = rows;
  return rest.map(row => {
    const obj = {};
    header.forEach((h, i) => { obj[h] = row[i] ?? ''; });
    return obj;
  });
}

async function loadSupplierData() {
  const sheet1Rows = await sheetsGet(SKUS_SHEET_ID, 'Sheet1!A1:F');
  const sheet1 = rowsToObjects(sheet1Rows);
  const bySku = new Map();
  for (const row of sheet1) {
    const sku = row['Variant SKU']?.trim();
    if (sku) bySku.set(sku, row);
  }

  const asmodeeRaw = await sheetsGet(SKUS_SHEET_ID, "'Asmodee'!A1:J20");
  const asmodeeHeaderRowIdx = asmodeeRaw.findIndex(row => row[0] === 'Code');
  if (asmodeeHeaderRowIdx === -1) throw new Error('Could not find Asmodee tab header row');
  const asmodeeAllRows = await sheetsGet(SKUS_SHEET_ID, `'Asmodee'!A${asmodeeHeaderRowIdx + 1}:J`);
  const asmodeeData = rowsToObjects([asmodeeAllRows[0], ...asmodeeAllRows.slice(1)]);
  const asmodeeByCode = new Map();
  for (const row of asmodeeData) {
    const code = row['Code']?.trim();
    if (code) asmodeeByCode.set(code, row);
  }

  const udRaw = await sheetsGet(SKUS_SHEET_ID, "'Alliance'!A1:N20");
  const udHeaderRowIdx = udRaw.findIndex(row => row[0] === 'Category Name');
  if (udHeaderRowIdx === -1) throw new Error('Could not find Alliance tab header row');
  const udAllRows = await sheetsGet(SKUS_SHEET_ID, `'Alliance'!A${udHeaderRowIdx + 1}:N`);
  const udData = rowsToObjects([udAllRows[0], ...udAllRows.slice(1)]);
  const universalByVendorItem = new Map();
  for (const row of udData) {
    const vendorItem = row['Vendor Item No.']?.trim();
    if (vendorItem) universalByVendorItem.set(vendorItem, row);
  }

  const udCatalogRows = await sheetsGet(SKUS_SHEET_ID, "'Universal Dist'!A1:L");
  const udCatalogData = rowsToObjects(udCatalogRows);
  const udBarcodeBySku = new Map();
  for (const row of udCatalogData) {
    const variantSku = row['Variant SKU']?.trim();
    const barcode = row['Barcode']?.trim();
    if (variantSku && barcode) udBarcodeBySku.set(variantSku, barcode);
  }

  const garlandRaw = await sheetsGet(SKUS_SHEET_ID, 'Garland!A1:H20');
  const garlandHeaderRowIdx = garlandRaw.findIndex(row => row[0] === 'ItemID');
  if (garlandHeaderRowIdx === -1) throw new Error('Could not find Garland tab header row');
  const garlandAllRows = await sheetsGet(SKUS_SHEET_ID, `Garland!A${garlandHeaderRowIdx + 1}:H`);
  const garlandData = rowsToObjects([garlandAllRows[0], ...garlandAllRows.slice(1)]);
  const garlandByItemId = new Map();
  for (const row of garlandData) {
    const itemId = row['ItemID']?.trim();
    if (itemId) garlandByItemId.set(itemId, row);
  }

  return { bySku, asmodeeByCode, universalByVendorItem, garlandByItemId, udBarcodeBySku };
}

// ── Supplier decision tree (identical to v1) ─────────────────────────────────
const ASMODEE_UNAVAILABLE = new Set(['Out of Stock']);

function decideSupplier(sku, title, sheetData) {
  const skuRow = sheetData.bySku.get(sku);
  const tags = (skuRow?.['Tags'] || '').toLowerCase();
  const acddSku = skuRow?.['ACDD SKU']?.trim();

  const hasAsmodee = tags.includes('asmodee');
  const hasAlliance = tags.includes('alliance');
  const hasAcdd = tags.includes('acdd');

  function tryAcdd(reason) {
    if (!acddSku || acddSku === '#N/A') {
      return { supplier: 'manual_review', reason: `${reason}; no ACDD SKU mapped` };
    }
    const garlandRow = sheetData.garlandByItemId.get(acddSku);
    if (garlandRow) return { supplier: 'acdd', acddSku, reason };
    return { supplier: 'manual_review', reason: `${reason}; not found at ACDD either` };
  }

  if (hasAsmodee) {
    const asmodeeRow = sheetData.asmodeeByCode.get(sku);
    if (!asmodeeRow) {
      return { supplier: 'asmodee', stockStatus: 'Not in recent release feed - backlist, verify availability' };
    }
    const status = asmodeeRow['Stock Status'];
    if (ASMODEE_UNAVAILABLE.has(status)) return tryAcdd(`Asmodee: ${status}`);
    return { supplier: 'asmodee', stockStatus: status };
  }

  if (hasAlliance) {
    const udRow = sheetData.universalByVendorItem.get(sku);
    if (!udRow) return tryAcdd('Not found at any Universal Dist warehouse');
    const warehouses = ['RDL', 'FWA', 'AUS', 'VIS'];
    for (const wh of warehouses) {
      if (udRow[wh]?.trim().toLowerCase() === 'yes') return { supplier: 'universal_dist', warehouse: wh };
    }
    return tryAcdd('Out of stock at all Universal Dist warehouses');
  }

  if (hasAcdd) return tryAcdd('Tagged acdd');

  return { supplier: 'manual_review', reason: 'No Asmodee or Alliance tag found' };
}

// ── Scan window + straggler pull (identical logic to v1, but "straggler" now
// means "any order with at least one Order Needs row not at Arrived stage") ──
async function ensureConfigTabExists() {
  await ensureTabExists(CONFIG_TAB, ['Setting', 'Value']);
  const rows = await sheetsGet(AGG_SHEET_ID, `'${CONFIG_TAB}'!A2:B2`).catch(() => []);
  if (!rows.length) {
    await sheetsPut(AGG_SHEET_ID, `'${CONFIG_TAB}'!A2:B2`, [['Last Order Included', '']]);
  }
}

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
        query: `fulfillment_status:unfulfilled -status:cancelled created_at:>${createdAt}`,
      };
    }
    console.warn(`Checkpoint order "${checkpointOrder}" not found - falling back to rolling 7-day window.`);
  }

  const sevenDaysAgo = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000).toISOString();
  return {
    mode: 'rolling-7-day',
    checkpointOrder: null,
    query: `fulfillment_status:unfulfilled -status:cancelled created_at:>=${sevenDaysAgo}`,
  };
}

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
              id name createdAt tags
              lineItems(first: 50) {
                edges { node { title quantity currentQuantity sku product { id } } }
              }
            }
          }
        }
      }
    `, { cursor, query: scanWindow.query });
    for (const edge of data.orders.edges) allOrders.push(edge.node);
    hasNextPage = data.orders.pageInfo.hasNextPage;
    cursor = data.orders.pageInfo.endCursor;
  }
  return allOrders;
}

// A "straggler" is now any order name still present in Order Needs with at
// least one row not yet at 'Arrived' - re-pulled by name regardless of the
// date filter, same rationale as v1: nothing should silently age out.
async function getStragglerOrderNames(orderNeedsRows) {
  const names = new Set();
  for (const row of orderNeedsRows) {
    if (!row.length || !row[0]) continue;
    const stage = row[6] || '';
    if (stage !== 'Arrived') names.add(row[0]);
  }
  return [...names];
}

async function getOrdersByName(names) {
  if (!names.length) return [];
  const cleanNames = names.map(n => n.trim().replace(/^#/, ''));
  const nameQuery = '(' + cleanNames.map(n => `name:${n}`).join(' OR ') + ') fulfillment_status:unfulfilled -status:cancelled';
  const data = await shopifyGraphql(`
    query getByName($q: String!) {
      orders(first: 250, query: $q) {
        edges {
          node {
            id name createdAt tags
            lineItems(first: 50) {
              edges { node { title quantity currentQuantity sku product { id } } }
            }
          }
        }
      }
    }
  `, { q: nameQuery });
  return data.orders.edges.map(e => e.node);
}

// ── Bin tracker (identical to v1) ────────────────────────────────────────────
async function getBinData() {
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

// ── Newly Available Backorders (identical to v1) ─────────────────────────────
const BACKORDER_TAB = 'Newly Available Backorders';

async function getAndClearNewlyAvailableBackorders() {
  const rows = await sheetsGet(AGG_SHEET_ID, `'${BACKORDER_TAB}'!A2:E1000`).catch(() => []);
  const filtered = rows.filter(r => r.length && r[0]);
  if (filtered.length) await sheetsClear(AGG_SHEET_ID, `'${BACKORDER_TAB}'!A2:E1000`);
  return filtered.map(r => ({
    orderName: r[0], sku: r[1]?.trim(), quantity: parseInt(r[2], 10) || 0, title: r[3] || '',
  }));
}

// ── Main handler ─────────────────────────────────────────────────────────────
export default async function handler(req, res) {
  const auth = req.headers['authorization'];
  if (auth !== `Bearer ${process.env.CRON_SECRET}`) {
    return res.status(401).json({ error: 'Unauthorized' });
  }

  try {
    await ensureTabExists(ORDER_NEEDS_TAB, ORDER_NEEDS_HEADER);
    await ensureTabExists('Supplier Orders Log', ['Supplier Order ID', 'Supplier', 'Date Locked', 'SKU', 'Qty', 'Order Names Included']);

    const scanWindow = await getScanWindow();
    const orderNeedsRows = await sheetsGet(AGG_SHEET_ID, ORDER_NEEDS_RANGE);

    const [scannedOrders, sheetData, bins, backorderRows, stragglerNames] = await Promise.all([
      getRecentUnfulfilledOrders(scanWindow),
      loadSupplierData(),
      getBinData(),
      getAndClearNewlyAvailableBackorders(),
      getStragglerOrderNames(orderNeedsRows),
    ]);
    const stragglerOrders = await getOrdersByName(stragglerNames);

    // A straggler name that didn't come back from Shopify means it's no
    // longer open (fulfilled/cancelled elsewhere) - drop ALL its Order Needs
    // rows, locked or not, since the order itself is done or dead.
    const foundStragglerNames = new Set(stragglerOrders.map(o => o.name));
    const resolvedAwayNames = new Set(stragglerNames.filter(n => !foundStragglerNames.has(n)));

    const seenOrderNames = new Set(scannedOrders.map(o => o.name));
    const newStragglers = stragglerOrders.filter(o => !seenOrderNames.has(o.name));
    const orders = [...scannedOrders, ...newStragglers].filter(o => !resolvedAwayNames.has(o.name));

    const binLookup = buildBinLookup(bins);

    // Fold in backorder-sweep rows as synthetic extra line items on their order
    const ordersBySkuNeed = new Map(); // orderName -> [{sku, title, qty, productId}]
    for (const order of orders) {
      const items = [];
      for (const edge of order.lineItems.edges) {
        const item = edge.node;
        const sku = item.sku?.trim();
        const qty = item.currentQuantity;
        if (!sku || !qty || qty <= 0) continue;
        items.push({ sku, title: item.title, qty, productId: item.product?.id });
      }
      ordersBySkuNeed.set(order.name, items);
    }
    for (const b of backorderRows) {
      if (!b.sku) continue;
      if (!ordersBySkuNeed.has(b.orderName)) ordersBySkuNeed.set(b.orderName, []);
      ordersBySkuNeed.get(b.orderName).push({ sku: b.sku, title: b.title, qty: b.quantity, productId: null });
    }

    // Index existing Order Needs rows by (orderName, sku)
    const existingByOrderSku = new Map(); // "order|sku" -> [{rowIndex(0-based in sheet body), row}]
    orderNeedsRows.forEach((row, idx) => {
      if (!row.length || !row[0]) return;
      const key = `${row[0]}|${row[1]}`;
      if (!existingByOrderSku.has(key)) existingByOrderSku.set(key, []);
      existingByOrderSku.get(key).push({ idx, row });
    });

    const decisionCache = new Map(); // sku -> decision
    function getDecision(sku, title) {
      if (!decisionCache.has(sku)) decisionCache.set(sku, decideSupplier(sku, title, sheetData));
      return decisionCache.get(sku);
    }

    const today = new Date().toISOString().slice(0, 10);
    const newRows = [];          // rows to append
    const rowsToDelete = new Set(); // sheet row numbers (1-based) to blank out
    const manualReviewFlags = [];
    const alreadyInBinsAdvisory = [];

    for (const [orderName, items] of ordersBySkuNeed.entries()) {
      // Fulfilled/Cancelled handling happens via the resolvedAwayNames pass
      // above for stragglers; for freshly-scanned orders, Shopify's own
      // fulfillment_status:unfulfilled filter already excludes them, so no
      // separate check is needed here.
      for (const { sku, title, qty, productId } of items) {
        const key = `${orderName}|${sku}`;
        const existing = existingByOrderSku.get(key) || [];
        const existingCount = existing.length;

        // Advisory: flag bin stock same as v1 (doesn't block routing)
        const binMatches = productId ? binLookup.get(productId) : null;
        if (binMatches && binMatches.length > 0) {
          alreadyInBinsAdvisory.push({ orderName, sku, title, qty, bins: binMatches });
        }

        if (qty > existingCount) {
          const decision = getDecision(sku, title);
          const label = SUPPLIER_LABELS[decision.supplier];
          if (!label) continue; // manual_review - no row created until resolved
          const toAdd = qty - existingCount;
          const startUnit = existingCount + 1;
          for (let i = 0; i < toAdd; i++) {
            newRows.push([orderName, sku, title, label, startUnit + i, '', 'NotOrdered', today]);
          }
        } else if (qty < existingCount) {
          const toRemove = existingCount - qty;
          const unlocked = existing.filter(e => !e.row[5]); // blank Supplier Order ID
          if (unlocked.length >= toRemove) {
            // Remove the highest unit-numbered unlocked rows first
            const sorted = unlocked.sort((a, b) => Number(b.row[4]) - Number(a.row[4]));
            for (let i = 0; i < toRemove; i++) rowsToDelete.add(sorted[i].idx);
          } else {
            manualReviewFlags.push({
              orderName, sku, title,
              reason: `Shopify qty dropped to ${qty} but ${existingCount} Order Needs rows exist and only ${unlocked.length} are unlocked - ${toRemove - unlocked.length} committed unit(s) would need manual reconciliation`,
            });
          }
        }
      }
    }

    // Drop all rows for orders that resolved away (fulfilled/cancelled elsewhere)
    orderNeedsRows.forEach((row, idx) => {
      if (row.length && resolvedAwayNames.has(row[0])) rowsToDelete.add(idx);
    });

    // Apply deletions by rewriting the tab (simplest safe approach given the
    // Sheets API has no row-delete-by-filter primitive over a value range)
    let survivingRows = orderNeedsRows.filter((_, idx) => !rowsToDelete.has(idx));
    if (rowsToDelete.size) {
      await sheetsClear(AGG_SHEET_ID, ORDER_NEEDS_RANGE);
      if (survivingRows.length) {
        await sheetsPut(AGG_SHEET_ID, `'${ORDER_NEEDS_TAB}'!A2:H${survivingRows.length + 1}`, survivingRows);
      }
    }
    if (newRows.length) {
      await sheetsAppend(AGG_SHEET_ID, ORDER_NEEDS_RANGE, newRows);
    }

    if (manualReviewFlags.length) {
      await sheetsAppend(AGG_SHEET_ID, "'Needs Manual Review'!A2:F1000",
        manualReviewFlags.map(f => [f.orderName, f.sku, f.title, '', f.reason, today]));
    }

    // ── Rebuild the live "Asmodee/UD/ACDD Order" tabs: SKU-aggregated view of
    // only UNLOCKED Order Needs rows (Supplier Order ID blank). This is what
    // you read from before clicking Lock & Order - it never mixes in demand
    // that's already been submitted, unlike v1's Order tabs.
    const allRowsAfterUpdate = [...survivingRows, ...newRows];
    const unlockedBySupplier = { Asmodee: new Map(), 'Universal Dist': new Map(), ACDD: new Map() };
    for (const row of allRowsAfterUpdate) {
      const [orderName, sku, title, supplier, , supplierOrderId] = row;
      if (supplierOrderId) continue; // locked - not part of the live "to order" view
      if (!unlockedBySupplier[supplier]) continue;
      const map = unlockedBySupplier[supplier];
      if (!map.has(sku)) map.set(sku, { title, qty: 0, orderNames: new Set() });
      const entry = map.get(sku);
      entry.qty += 1;
      entry.orderNames.add(orderName);
    }

    const asmodeeOrder = [];
    for (const [sku, e] of unlockedBySupplier['Asmodee'].entries()) {
      const asmodeeRow = sheetData.asmodeeByCode.get(sku);
      const stockStatus = asmodeeRow ? asmodeeRow['Stock Status'] : 'Not in recent release feed - backlist, verify availability';
      asmodeeOrder.push([sku, e.qty, 'Each', '', e.title, stockStatus, [...e.orderNames].join(', '), '']);
    }
    const udOrder = [];
    for (const [sku, e] of unlockedBySupplier['Universal Dist'].entries()) {
      const barcode = sheetData.udBarcodeBySku.get(sku) || '';
      const udRow = sheetData.universalByVendorItem.get(sku);
      const warehouse = getDecision(sku, e.title).warehouse || '';
      udOrder.push([sku, barcode, e.qty, e.title, warehouse, [...e.orderNames].join(', '), '']);
    }
    const acddOrder = [];
    for (const [sku, e] of unlockedBySupplier['ACDD'].entries()) {
      const decision = getDecision(sku, e.title);
      acddOrder.push([decision.acddSku || '', sku, e.qty, e.title, [...e.orderNames].join(', '), decision.reason || '']);
    }

    await sheetsClear(AGG_SHEET_ID, 'Asmodee Order!A2:H1000');
    await sheetsClear(AGG_SHEET_ID, 'Universal Dist Order!A2:H1000');
    await sheetsClear(AGG_SHEET_ID, 'ACDD Order!A2:G1000');
    if (asmodeeOrder.length) await sheetsPut(AGG_SHEET_ID, `Asmodee Order!A2:H${asmodeeOrder.length + 1}`, asmodeeOrder);
    if (udOrder.length) await sheetsPut(AGG_SHEET_ID, `Universal Dist Order!A2:G${udOrder.length + 1}`, udOrder);
    if (acddOrder.length) await sheetsPut(AGG_SHEET_ID, `ACDD Order!A2:F${acddOrder.length + 1}`, acddOrder);

    return res.status(200).json({
      success: true,
      scanMode: scanWindow.mode,
      ordersScanned: scannedOrders.length,
      stragglersReincluded: newStragglers.length,
      stragglersResolvedAway: [...resolvedAwayNames],
      orderNeedsRowsAdded: newRows.length,
      orderNeedsRowsRemoved: rowsToDelete.size,
      manualReviewFlagsAdded: manualReviewFlags.length,
      manualReviewFlags,
      unlockedAsmodeeSkus: asmodeeOrder.length,
      unlockedUdSkus: udOrder.length,
      unlockedAcddSkus: acddOrder.length,
      alreadyInBinsAdvisory: alreadyInBinsAdvisory.length,
      note: `After placing this week's supplier order(s), use the (upcoming) Lock & Order action instead of manually editing this sheet.`,
    });

  } catch (err) {
    console.error('Order Needs aggregation error:', err);
    return res.status(500).json({ error: err.message, stack: err.stack });
  }
}
