// Supplier Order Aggregation
// Pulls unfulfilled orders from the last 7 days, cross-references bins,
// determines correct supplier per item via the decision tree, writes to Google Sheet.

import jwt from 'jsonwebtoken';

const SHOP = process.env.SHOPIFY_SHOP;
const CLIENT_ID = process.env.SHOPIFY_CLIENT_ID;
const CLIENT_SECRET = process.env.SHOPIFY_CLIENT_SECRET;
const API_VERSION = '2025-01';
const BIN_TRACKER_URL = 'https://dhg-bin-tracker-app.vercel.app';

const SKUS_SHEET_ID = '1yC-oZ-0hD5ReTcOA9iTjTGC6mONbDUCpfbZZA9GrQtI';
const AGG_SHEET_ID = '1rsUU7qZJZGhivsofBiFPa7FK6qnHosrxps10NYzLxAE';

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

// Sheet IDs (numeric, not titles) needed for the batchUpdate formatting API.
// These are stable as long as the tabs aren't deleted/recreated.
const TAB_SHEET_IDS = {
  'Asmodee Order': 485680112,
  'Universal Dist Order': 1904437783,
  'ACDD Order': 1604429882,
  'Asmodee - Checkout': 1415624207,
};

const BIN_HIGHLIGHT_COLOR = { red: 0.85, green: 0.95, blue: 0.85 }; // light green

async function applyRowFormatting(spreadsheetId, requests) {
  if (!requests.length) return;
  const token = await getGoogleToken(false);
  const res = await fetch(
    `https://sheets.googleapis.com/v4/spreadsheets/${spreadsheetId}:batchUpdate`,
    {
      method: 'POST',
      headers: { 'Authorization': `Bearer ${token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ requests }),
    }
  );
  if (!res.ok) throw new Error(`Sheets batchUpdate (formatting) failed: ${res.status} ${await res.text()}`);
}

function buildHighlightRequests(tabName, rowIndices, numColumns) {
  const sheetId = TAB_SHEET_IDS[tabName];
  if (!sheetId) return [];

  // First, clear formatting for the whole data range (rows 2 through 1000) so
  // last week's highlights don't linger on rows that no longer qualify.
  const requests = [{
    repeatCell: {
      range: { sheetId, startRowIndex: 1, endRowIndex: 1000, startColumnIndex: 0, endColumnIndex: numColumns },
      cell: { userEnteredFormat: { backgroundColor: { red: 1, green: 1, blue: 1 } } },
      fields: 'userEnteredFormat.backgroundColor',
    }
  }];

  // rowIndices are 0-based within the data rows (row 2 in the sheet = index 0)
  for (const idx of rowIndices) {
    const sheetRow = idx + 1; // +1 because row 0 is the header row
    requests.push({
      repeatCell: {
        range: { sheetId, startRowIndex: sheetRow, endRowIndex: sheetRow + 1, startColumnIndex: 0, endColumnIndex: numColumns },
        cell: { userEnteredFormat: { backgroundColor: BIN_HIGHLIGHT_COLOR } },
        fields: 'userEnteredFormat.backgroundColor',
      }
    });
  }
  return requests;
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

  // Asmodee: single header row, Code = Shopify SKU
  const asmodeeRows = await sheetsGet(SKUS_SHEET_ID, "Asmodee!A1:G");
  const asmodeeData = rowsToObjects(asmodeeRows);
  const asmodeeByCode = new Map();
  for (const row of asmodeeData) {
    const code = row['Code']?.trim();
    if (code) asmodeeByCode.set(code, row);
  }

  // Alliance (Universal Dist): single header row, Vendor Item No. = Shopify SKU
  const allianceRows = await sheetsGet(SKUS_SHEET_ID, "Alliance!A1:J");
  const allianceData = rowsToObjects(allianceRows);
  const universalByVendorItem = new Map();
  for (const row of allianceData) {
    const vendorItem = row['Vendor Item No.']?.trim();
    if (vendorItem) universalByVendorItem.set(vendorItem, row);
  }

  // Garland (ACDD): single header row, ItemID = ACDD SKU
  const garlandRows = await sheetsGet(SKUS_SHEET_ID, 'Garland!A1:H');
  const garlandData = rowsToObjects(garlandRows);
  const garlandByItemId = new Map();
  for (const row of garlandData) {
    const itemId = row['ItemID']?.trim();
    if (itemId) garlandByItemId.set(itemId, row);
  }

  return { bySku, asmodeeByCode, universalByVendorItem, garlandByItemId };
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

// ── Pull unfulfilled orders from last 7 days ────────────────────────────────
async function getRecentUnfulfilledOrders() {
  const sevenDaysAgo = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000).toISOString();
  const allOrders = [];
  let cursor = null;
  let hasNextPage = true;

  while (hasNextPage) {
    const data = await shopifyGraphql(`
      query getOrders($cursor: String) {
        orders(first: 50, after: $cursor, query: "fulfillment_status:unfulfilled created_at:>=${sevenDaysAgo}") {
          pageInfo { hasNextPage endCursor }
          edges {
            node {
              id
              name
              tags
              lineItems(first: 50) {
                edges {
                  node {
                    title
                    quantity
                    sku
                    product { id }
                  }
                }
              }
            }
          }
        }
      }
    `, { cursor });

    for (const edge of data.orders.edges) {
      allOrders.push(edge.node);
    }
    hasNextPage = data.orders.pageInfo.hasNextPage;
    cursor = data.orders.pageInfo.endCursor;
  }

  return allOrders;
}

// ── Bin tracker check ────────────────────────────────────────────────────────
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

// ── Main handler ─────────────────────────────────────────────────────────────
export default async function handler(req, res) {
  const auth = req.headers['authorization'];
  if (auth !== `Bearer ${process.env.CRON_SECRET}`) {
    return res.status(401).json({ error: 'Unauthorized' });
  }

  try {
    const [orders, sheetData, bins] = await Promise.all([
      getRecentUnfulfilledOrders(),
      loadSupplierData(),
      getBinData(),
    ]);

    const binLookup = buildBinLookup(bins);

    // Aggregate line items by SKU across all matching orders
    const aggregated = new Map(); // sku -> { title, totalQty, productId, orderNames: [] }

    for (const order of orders) {
      for (const edge of order.lineItems.edges) {
        const item = edge.node;
        const sku = item.sku?.trim();
        if (!sku) continue;

        if (!aggregated.has(sku)) {
          aggregated.set(sku, {
            title: item.title,
            productId: item.product?.id,
            totalQty: 0,
            orderNames: [],
          });
        }
        const entry = aggregated.get(sku);
        entry.totalQty += item.quantity;
        entry.orderNames.push(order.name);
      }
    }

    const alreadyInBins = [];
    const asmodeeOrders = [];
    const checkoutRows = []; // stripped-down mirror of asmodeeOrders: just the 4 columns Asmodee's checkout upload tool accepts
    const universalOrders = [];
    const acddOrders = [];
    const manualReview = [];

    // Track which suppliers each order needs, so we can build the Shipment Tracking tab.
    // Only Asmodee/Universal Dist/ACDD count here - "Needs Manual Review" items aren't
    // tied to a real supplier shipment, so they're intentionally excluded from this map.
    const orderSupplierNeeds = new Map(); // orderName -> Set of supplier labels

    function recordSupplierNeed(orderNamesStr, supplierLabel) {
      const names = orderNamesStr.split(', ').filter(Boolean);
      for (const name of names) {
        if (!orderSupplierNeeds.has(name)) orderSupplierNeeds.set(name, new Set());
        orderSupplierNeeds.get(name).add(supplierLabel);
      }
    }

    // Track which row indices (0-based, within each tab's own data rows) need the
    // "also in bins" green highlight, so we can apply formatting after writing values.
    const binHighlightRows = { asmodee: [], universal: [], acdd: [], checkout: [] };

    for (const [sku, entry] of aggregated.entries()) {
      const orderNamesStr = [...new Set(entry.orderNames)].join(', ');

      // Check bins first - advisory only, doesn't stop supplier evaluation
      const binMatches = entry.productId ? binLookup.get(entry.productId) : null;
      let binNoteStr = '';
      if (binMatches && binMatches.length > 0) {
        const binLocStr = binMatches.map(b => `${b.binKey}(${b.quantity})`).join(', ');
        alreadyInBins.push([sku, entry.title, entry.totalQty, binLocStr, orderNamesStr, '']);
        binNoteStr = `Also in bins: ${binLocStr}`;
      }

      const decision = decideSupplier(sku, entry.title, sheetData);

      if (decision.supplier === 'asmodee') {
        if (binNoteStr) {
          binHighlightRows.asmodee.push(asmodeeOrders.length);
          binHighlightRows.checkout.push(checkoutRows.length);
        }
        asmodeeOrders.push([sku, entry.totalQty, 'Each', '', entry.title, decision.stockStatus, orderNamesStr, binNoteStr]);
        checkoutRows.push([sku, entry.totalQty, 'Each', '']);
        recordSupplierNeed(orderNamesStr, 'Asmodee');
      } else if (decision.supplier === 'universal_dist') {
        if (binNoteStr) binHighlightRows.universal.push(universalOrders.length);
        universalOrders.push([sku, entry.totalQty, entry.title, decision.warehouse, orderNamesStr, binNoteStr, '']);
        recordSupplierNeed(orderNamesStr, 'Universal Dist');
      } else if (decision.supplier === 'acdd') {
        if (binNoteStr) binHighlightRows.acdd.push(acddOrders.length);
        acddOrders.push([decision.acddSku, sku, entry.totalQty, entry.title, orderNamesStr, binNoteStr]);
        recordSupplierNeed(orderNamesStr, 'ACDD');
      } else {
        manualReview.push([sku, entry.title, entry.totalQty, orderNamesStr, decision.reason, '']);
      }
    }

    // Build Shipment Tracking rows: one per order that needs at least one real supplier shipment
    const shipmentTrackingRows = [];
    for (const [orderName, suppliers] of orderSupplierNeeds.entries()) {
      const suppliersNeeded = [...suppliers].sort().join(', ');
      shipmentTrackingRows.push([orderName, suppliersNeeded, '', 'Pending']);
    }


    // Clear and write each tab
    await sheetsClear(AGG_SHEET_ID, 'Already In Bins!A2:F1000');
    await sheetsClear(AGG_SHEET_ID, 'Asmodee Order!A2:H1000');
    await sheetsClear(AGG_SHEET_ID, 'Universal Dist Order!A2:G1000');
    await sheetsClear(AGG_SHEET_ID, 'ACDD Order!A2:F1000');
    await sheetsClear(AGG_SHEET_ID, 'Needs Manual Review!A2:F1000');
    await sheetsClear(AGG_SHEET_ID, "'Shipment Tracking'!A2:D1000");

    if (alreadyInBins.length) await sheetsPut(AGG_SHEET_ID, `Already In Bins!A2:F${alreadyInBins.length + 1}`, alreadyInBins);
    if (asmodeeOrders.length) await sheetsPut(AGG_SHEET_ID, `Asmodee Order!A2:H${asmodeeOrders.length + 1}`, asmodeeOrders);
    if (universalOrders.length) await sheetsPut(AGG_SHEET_ID, `Universal Dist Order!A2:G${universalOrders.length + 1}`, universalOrders);
    if (acddOrders.length) await sheetsPut(AGG_SHEET_ID, `ACDD Order!A2:F${acddOrders.length + 1}`, acddOrders);
    if (manualReview.length) await sheetsPut(AGG_SHEET_ID, `Needs Manual Review!A2:F${manualReview.length + 1}`, manualReview);
    if (shipmentTrackingRows.length) await sheetsPut(AGG_SHEET_ID, `'Shipment Tracking'!A2:D${shipmentTrackingRows.length + 1}`, shipmentTrackingRows);

    // Asmodee - Checkout: stripped-down mirror with ONLY the 4 columns their
    // checkout CSV upload tool accepts, with header row matching their sample format
    await sheetsClear(AGG_SHEET_ID, "'Asmodee - Checkout'!A1:D1000");
    const checkoutHeader = [['ProductId', 'Quantity', 'UnitOfMeasureId', 'VariantId']];
    await sheetsPut(AGG_SHEET_ID, `'Asmodee - Checkout'!A1:D1`, checkoutHeader);
    if (checkoutRows.length) await sheetsPut(AGG_SHEET_ID, `'Asmodee - Checkout'!A2:D${checkoutRows.length + 1}`, checkoutRows);

    // Highlight rows on the supplier tabs that also have bin stock available
    const formattingRequests = [
      ...buildHighlightRequests('Asmodee Order', binHighlightRows.asmodee, 8),
      ...buildHighlightRequests('Universal Dist Order', binHighlightRows.universal, 7),
      ...buildHighlightRequests('ACDD Order', binHighlightRows.acdd, 6),
      ...buildHighlightRequests('Asmodee - Checkout', binHighlightRows.checkout, 4),
    ];
    await applyRowFormatting(AGG_SHEET_ID, formattingRequests);

    return res.status(200).json({
      success: true,
      ordersScanned: orders.length,
      uniqueSkus: aggregated.size,
      alreadyInBins: alreadyInBins.length,
      asmodee: asmodeeOrders.length,
      universalDist: universalOrders.length,
      acdd: acddOrders.length,
      needsManualReview: manualReview.length,
      asmodeeCheckoutRows: checkoutRows.length,
      shipmentTrackingRows: shipmentTrackingRows.length,
    });

  } catch (err) {
    console.error('Supplier aggregation error:', err);
    return res.status(500).json({ error: err.message, stack: err.stack });
  }
}
