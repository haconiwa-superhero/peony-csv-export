require('dotenv').config();
const express = require('express');
const crypto  = require('crypto');
const fetch   = require('node-fetch');
const iconv   = require('iconv-lite');

const app = express();
app.use(express.static('public'));

const CLIENT_ID     = process.env.SHOPIFY_CLIENT_ID;
const CLIENT_SECRET = process.env.SHOPIFY_CLIENT_SECRET;
const HOST          = process.env.HOST;
const SCOPES        = 'read_orders,write_inventory,read_inventory,read_products';

let shopDomain  = process.env.SHOPIFY_SHOP || '';
let accessToken = process.env.SHOPIFY_ACCESS_TOKEN || '';

// エクスポート履歴（最大100件、サーバー再起動でリセット）
const exportHistory = [];

// ============================================================
// 在庫連動: 商品ID定数
// ============================================================
const SET_PRODUCT_ID   = '8207210053689'; // THE MILKTEA WALTZ POUCH SET
const POUCH_PRODUCT_ID = '8213925855289'; // HEART LACE POUCH（在庫カウンター商品）
const POUCH_SKU        = 'LACE-HEARTPOUCH'; // HEART LACE POUCH SKU

let pouchInventoryItemId = null;
let pouchLocationId      = null;

// ============================================================
// SKUマップ（管理画面から編集可能・サーバー再起動でリセット）
// ============================================================
const SKU_MAP = {
  'GLOW OF LOVE HIGHLIGHTER 01': 'GOH01 card sets',
  'GLOW OF LOVE HIGHLIGHTER 02': 'GOH02 card sets',
  'GLOW OF LOVE HIGHLIGHTER 03': 'GOH03',
  'GLOW OF LOVE HIGHLIGHTER 04': 'GOH04',
  'MARSHMALLOW TOUCH CHEEK 01': 'MTC01',
  'MARSHMALLOW TOUCH CHEEK 02': 'MTC02',
  'MARSHMALLOW TOUCH CHEEK 03': 'MTC03',
  'MARSHMALLOW TOUCH CHEEK 04': 'MTC04',
  'MARSHMALLOW TOUCH CHEEK 05': 'MTC05',
  'HEART LACE POUCH': 'LACE-HEARTPOUCH',
  'HEROINE MOOD EYE PALETTE 01': 'HMEY01-01',
  'HEROINE MOOD EYE PALETTE 02': 'HMEY02-02',
  'HEROINE MOOD EYE PALETTE 03': 'HMEY03-03',
  'MELTING CREAM LIP BALM 01': 'MCL-01',
  'MELTING CREAM LIP BALM 02': 'MCL-02',
  'MELTING CREAM LIP BALM 03': 'MCL-03',
  'MELTING CREAM LIP BALM 04': 'MCL-04',
  'GLOSSY HONEY COUVERTURE LIP GLOSS 01': 'GHC-LG-01',
  'GLOSSY HONEY COUVERTURE LIP GLOSS 02': 'GHC-LG-02',
  'GLOSSY HONEY COUVERTURE LIP GLOSS 03': 'GHC-LG-03',
  'GLOSSY HONEY COUVERTURE LIP GLOSS 04': 'GHC-LG-04',
  'GLOSSY HONEY COUVERTURE LIP GLOSS 05': 'GHC-LG-05',
  'GLOSSY HONEY COUVERTURE LIP GLOSS 06': 'GHC-LG-06',
  'GLOSSY HONEY COUVERTURE LIP GLOSS 07': 'GHC-LG-07',
  'GLOSSY HONEY COUVERTURE LIP GLOSS 08': 'GHC-LG-08',
  'GLOSSY HONEY COUVERTURE LIP GLOSS 09': 'GHC-LG-09',
  'GLOSSY HONEY COUVERTURE LIP GLOSS 10': 'GHC-LG-10',
  'GLOSSY HONEY COUVERTURE LIP GLOSS 11': 'GHC-LG-11',
  'GLOSSY HONEY COUVERTURE LIP GLOSS 12': 'GHC-LG-12',
  'MUSE OF ECLAT EYESHADOW 01': 'MOEE-01',
  'MUSE OF ECLAT EYESHADOW 02': 'MOEE-02',
  'MUSE OF ECLAT EYESHADOW 03': 'MOEE-03',
  'MUSE OF ECLAT EYESHADOW 04': 'MOEE-04',
  'MUSE OF ECLAT EYESHADOW 05': 'MOEE-05',
  'MUSE OF ECLAT EYESHADOW 06': 'MOEE-06',
  'MUSE OF ECLAT EYESHADOW 07': 'MOEE-07',
  'MUSE OF ECLAT EYESHADOW 08': 'MOEE-08',
  'MUSE OF ECLAT EYESHADOW 09': 'MOEE-09',
  'MUSE OF ECLAT EYESHADOW 10': 'MOEE-10',
};

// ============================================================
// Webhook: 注文確定 → POUCH在庫を減らす
// ============================================================
app.post('/webhook/orders/paid', express.raw({ type: 'application/json' }), async (req, res) => {
  res.status(200).send('OK');
  try {
    const hmac = req.headers['x-shopify-hmac-sha256'];
    const hash = crypto.createHmac('sha256', CLIENT_SECRET).update(req.body).digest('base64');
    if (hmac !== hash) return console.error('Webhook HMAC不一致 (orders/paid)');

    const order = JSON.parse(req.body);
    const setQty = order.line_items
      .filter(i => String(i.product_id) === SET_PRODUCT_ID)
      .reduce((sum, i) => sum + i.quantity, 0);
    if (setQty === 0) return;

    if (!pouchInventoryItemId) await initPouchInventory();
    const newLevel = await adjustPouchInventory(-setQty);
    console.log(`注文 ${order.name}: POUCH在庫 -${setQty} → 残${newLevel}`);
    if (newLevel <= 0) {
      await updateSetInventory(0);
      console.log('⚠️ POUCH在庫0: セット商品を売り切れに設定');
    }
  } catch (e) { console.error('Webhook(paid)エラー:', e); }
});

// Webhook: 注文キャンセル → POUCH在庫を戻す
app.post('/webhook/orders/cancelled', express.raw({ type: 'application/json' }), async (req, res) => {
  res.status(200).send('OK');
  try {
    const hmac = req.headers['x-shopify-hmac-sha256'];
    const hash = crypto.createHmac('sha256', CLIENT_SECRET).update(req.body).digest('base64');
    if (hmac !== hash) return console.error('Webhook HMAC不一致 (orders/cancelled)');

    const order = JSON.parse(req.body);
    const setQty = order.line_items
      .filter(i => String(i.product_id) === SET_PRODUCT_ID)
      .reduce((sum, i) => sum + i.quantity, 0);
    if (setQty === 0) return;

    if (!pouchInventoryItemId) await initPouchInventory();
    const newLevel = await adjustPouchInventory(setQty);
    console.log(`キャンセル ${order.name}: POUCH在庫 +${setQty} → 残${newLevel}`);
    if (newLevel > 0) {
      await updateSetInventory(999);
      console.log('✅ キャンセル: セット商品の在庫を復元');
    }
  } catch (e) { console.error('Webhook(cancelled)エラー:', e); }
});

app.use(express.json());

// ============================================================
// ① 件数プレビュー
// ============================================================
app.get('/preview', async (req, res) => {
  if (!accessToken) return res.status(401).json({ error: '未認証' });
  const { start, end, fulfillment = 'any' } = req.query;
  if (!start || !end) return res.status(400).json({ error: 'パラメータ不足' });
  try {
    const orders = await fetchAllOrders(start, end, fulfillment);
    res.json({ count: orders.length });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ============================================================
// ⑤ エクスポート履歴
// ============================================================
app.get('/api/history', (_req, res) => res.json(exportHistory));

// ============================================================
// OAuth: Step1 - Shopify認証ページへリダイレクト
// ============================================================
app.get('/auth', (req, res) => {
  const shop = req.query.shop || shopDomain;
  if (!shop) return res.send('shopパラメータが必要です');
  const state       = crypto.randomBytes(16).toString('hex');
  const redirectUri = encodeURIComponent(`${HOST}/auth/callback`);
  res.redirect(
    `https://${shop}/admin/oauth/authorize?client_id=${CLIENT_ID}&scope=${SCOPES}&redirect_uri=${redirectUri}&state=${state}`
  );
});

// ============================================================
// OAuth: Step2 - アクセストークン取得
// ============================================================
app.get('/auth/callback', async (req, res) => {
  const { code, shop, hmac } = req.query;
  const params = Object.entries(req.query)
    .filter(([k]) => k !== 'hmac' && k !== 'signature')
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([k, v]) => `${k}=${v}`)
    .join('&');
  const digest = crypto.createHmac('sha256', CLIENT_SECRET).update(params).digest('hex');
  if (digest !== hmac) return res.status(400).send('認証エラー');

  const resp = await fetch(`https://${shop}/admin/oauth/access_token`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ client_id: CLIENT_ID, client_secret: CLIENT_SECRET, code }),
  });
  const data  = await resp.json();
  accessToken = data.access_token;
  shopDomain  = shop;

  console.log('\n========================================');
  console.log('✅ アクセストークン取得成功!');
  console.log(`SHOPIFY_ACCESS_TOKEN=${accessToken}`);
  console.log(`SHOPIFY_SHOP=${shop}`);
  console.log('RenderのEnvironmentに上記を設定してください');
  console.log('========================================\n');

  res.redirect('/');
});

// ============================================================
// トップページ
// ============================================================
app.get('/', (_req, res) => {
  if (!accessToken) return res.redirect(`/auth?shop=${shopDomain}`);
  res.sendFile(__dirname + '/public/index.html');
});

// ============================================================
// CSVエクスポート
// ============================================================
app.get('/export', async (req, res) => {
  if (!accessToken) return res.redirect(`/auth?shop=${shopDomain}`);
  const { start, end, fulfillment = 'any' } = req.query;
  if (!start || !end) return res.status(400).send('start/endパラメータが必要です');

  try {
    const orders = await fetchAllOrders(start, end, fulfillment);
    const csv    = generateCSV(orders);
    const encoded = iconv.encode(csv, 'CP932');

    // 履歴を記録
    exportHistory.unshift({ timestamp: new Date().toISOString(), start, end, fulfillment, count: orders.length });
    if (exportHistory.length > 100) exportHistory.pop();

    res.setHeader('Content-Type', 'application/octet-stream');
    res.setHeader('Content-Disposition', `attachment; filename="orders_${start}_${end}.csv"`);
    res.end(encoded);
  } catch (err) {
    console.error(err);
    res.status(500).send('エクスポートに失敗しました: ' + err.message);
  }
});

// ============================================================
// 全注文取得（ページネーション対応）
// ============================================================
async function fetchAllOrders(start, end, fulfillment = 'any') {
  const orders = [];
  let url =
    `https://${shopDomain}/admin/api/2024-01/orders.json` +
    `?status=any` +
    `&fulfillment_status=${fulfillment}` +
    `&created_at_min=${start}T00:00:00%2B09:00` +
    `&created_at_max=${end}T23:59:59%2B09:00` +
    `&limit=250` +
    `&fields=id,name,email,financial_status,fulfillment_status,created_at,processed_at,` +
    `line_items,billing_address,shipping_address,note,subtotal_price,shipping_lines,` +
    `total_tax,total_price,discount_codes,payment_gateway,cancelled_at,tags,` +
    `note_attributes,customer,fulfillments,source_name,currency,total_shipping_price_set,` +
    `tax_lines,phone,payment_details,transactions,refunds`;

  while (url) {
    const resp = await fetch(url, { headers: { 'X-Shopify-Access-Token': accessToken } });
    if (!resp.ok) throw new Error(`Shopify API error: ${resp.status}`);
    const data = await resp.json();
    orders.push(...(data.orders || []));
    const link = resp.headers.get('link');
    const next = link && link.match(/<([^>]+)>;\s*rel="next"/);
    url = next ? next[1] : null;
  }
  // 返金済み・一部返金済み・返金保留中（refundsあり）を除外
  return orders.filter(o =>
    o.financial_status !== 'refunded' &&
    o.financial_status !== 'partially_refunded' &&
    !(o.refunds && o.refunds.length > 0)
  );
}

// 電話番号: +81 → 0 に変換
function fmtPhone(p) {
  if (!p) return '';
  return String(p).replace(/^\+81/, '0').replace(/\s/g, '');
}

// 日付形式変換: ISO 8601 → Shopify標準形式
function fmtDate(d) {
  if (!d) return '';
  return d.replace('T', ' ').replace(/([+-]\d{2}):(\d{2})$/, ' $1$2');
}

// JP都道府県コード → 日本語名
const JP_PROVINCE_NAMES = {
  'JP-01':'北海道','JP-02':'青森県','JP-03':'岩手県','JP-04':'宮城県','JP-05':'秋田県',
  'JP-06':'山形県','JP-07':'福島県','JP-08':'茨城県','JP-09':'栃木県','JP-10':'群馬県',
  'JP-11':'埼玉県','JP-12':'千葉県','JP-13':'東京都','JP-14':'神奈川県','JP-15':'新潟県',
  'JP-16':'富山県','JP-17':'石川県','JP-18':'福井県','JP-19':'山梨県','JP-20':'長野県',
  'JP-21':'岐阜県','JP-22':'静岡県','JP-23':'愛知県','JP-24':'三重県','JP-25':'滋賀県',
  'JP-26':'京都府','JP-27':'大阪府','JP-28':'兵庫県','JP-29':'奈良県','JP-30':'和歌山県',
  'JP-31':'鳥取県','JP-32':'島根県','JP-33':'岡山県','JP-34':'広島県','JP-35':'山口県',
  'JP-36':'徳島県','JP-37':'香川県','JP-38':'愛媛県','JP-39':'高知県','JP-40':'福岡県',
  'JP-41':'佐賀県','JP-42':'長崎県','JP-43':'熊本県','JP-44':'大分県','JP-45':'宮崎県',
  'JP-46':'鹿児島県','JP-47':'沖縄県',
};

// ============================================================
// CSV生成（Shopify標準形式 + バンドルSKU展開）
// ============================================================
function generateCSV(orders) {
  const headers = [
    'Name', 'Email', 'Financial Status', 'Paid at', 'Fulfillment Status', 'Fulfilled at',
    'Accepts Marketing', 'Currency', 'Subtotal', 'Shipping', 'Taxes', 'Total',
    'Discount Code', 'Discount Amount', 'Shipping Method', 'Created at',
    'Lineitem quantity', 'Lineitem name', 'Lineitem price', 'Lineitem compare at price',
    'Lineitem sku', 'Lineitem requires shipping', 'Lineitem taxable', 'Lineitem fulfillment status',
    'Billing Name', 'Billing Street', 'Billing Address1', 'Billing Address2', 'Billing Company',
    'Billing City', 'Billing Zip', 'Billing Province', 'Billing Country', 'Billing Phone',
    'Shipping Name', 'Shipping Street', 'Shipping Address1', 'Shipping Address2', 'Shipping Company',
    'Shipping City', 'Shipping Zip', 'Shipping Province', 'Shipping Country', 'Shipping Phone',
    'Notes', 'Note Attributes', 'Cancelled at', 'Payment Method', 'Payment Reference',
    'Refunded Amount', 'Vendor', 'Outstanding Balance', 'Employee', 'Location', 'Device ID',
    'Id', 'Tags', 'Risk Level', 'Source', 'Lineitem discount',
    'Tax 1 Name', 'Tax 1 Value', 'Tax 2 Name', 'Tax 2 Value', 'Tax 3 Name', 'Tax 3 Value',
    'Tax 4 Name', 'Tax 4 Value', 'Tax 5 Name', 'Tax 5 Value',
    'Phone', 'Receipt Number', 'Duties',
    'Billing Province Name', 'Shipping Province Name',
    'Payment ID', 'Payment Terms Name', 'Next Payment Due At', 'Payment References',
  ];

  const rows = [headers];

  for (const order of orders) {
    const lineItems = expandLineItems(order);
    lineItems.forEach((item, index) => {
      const isFirst = index === 0;
      rows.push([
        order.name || '',
        order.email || '',
        isFirst ? (order.financial_status || '')                            : '',
        isFirst ? fmtDate(order.processed_at)                              : '',
        isFirst ? (order.fulfillment_status || '')                          : '',
        isFirst ? fmtDate(order.fulfillments?.[0]?.updated_at)             : '',
        isFirst ? (order.customer?.accepts_marketing ? 'yes' : 'no')       : '',
        isFirst ? (order.currency || '')                                    : '',
        isFirst ? (order.subtotal_price || '')                              : '',
        isFirst ? (order.total_shipping_price_set?.shop_money?.amount || '0') : '',
        isFirst ? (order.total_tax || '')                                   : '',
        isFirst ? (order.total_price || '')                                 : '',
        isFirst ? (order.discount_codes?.[0]?.code || '')                  : '',
        isFirst ? (order.discount_codes?.[0]?.amount || '0')               : '',
        isFirst ? (order.shipping_lines?.[0]?.title || '')                 : '',
        fmtDate(order.created_at),
        item.quantity,
        item.name,
        item.price,
        item.compare_at_price || '',
        item.sku || '',
        item.requires_shipping ? 'true' : 'false',
        item.taxable ? 'true' : 'false',
        item.fulfillment_status || '',
        isFirst ? (order.billing_address?.name || '')                      : '',
        isFirst ? joinAddr(order.billing_address)                          : '',
        isFirst ? (order.billing_address?.address1 || '')                  : '',
        isFirst ? (order.billing_address?.address2 || '')                  : '',
        isFirst ? (order.billing_address?.company || '')                   : '',
        isFirst ? (order.billing_address?.city || '')                      : '',
        isFirst ? (order.billing_address?.zip || '')                       : '',
        isFirst ? (order.billing_address?.province_code || '')             : '',
        isFirst ? (order.billing_address?.country_code || '')              : '',
        isFirst ? fmtPhone(order.billing_address?.phone)                   : '',
        isFirst ? (order.shipping_address?.name || '')                     : '',
        isFirst ? joinAddr(order.shipping_address)                         : '',
        isFirst ? (order.shipping_address?.address1 || '')                 : '',
        isFirst ? (order.shipping_address?.address2 || '')                 : '',
        isFirst ? (order.shipping_address?.company || '')                  : '',
        isFirst ? (order.shipping_address?.city || '')                     : '',
        isFirst ? (order.shipping_address?.zip || '')                      : '',
        isFirst ? (order.shipping_address?.province_code || '')            : '',
        isFirst ? (order.shipping_address?.country_code || '')             : '',
        isFirst ? fmtPhone(order.shipping_address?.phone)                  : '',
        isFirst ? (order.note || '')                                        : '',
        isFirst ? fmtNoteAttrs(order.note_attributes)                      : '',
        isFirst ? (order.cancelled_at || '')                                : '',
        isFirst ? (order.payment_gateway || '')                             : '',
        isFirst ? (order.transactions?.[0]?.authorization || '')           : '',
        '0',
        item.vendor || '',
        '0', '', '', '',
        isFirst ? String(order.id) : '',
        isFirst ? (order.tags || '')  : '',
        isFirst ? 'Low' : '',
        isFirst ? (order.source_name || 'web') : '',
        '0',
        // Tax columns（最大5件）
        ...getTaxColumns(isFirst ? order.tax_lines : []),
        // 追加列
        isFirst ? fmtPhone(order.phone) : '',
        '',
        '',
        isFirst ? (JP_PROVINCE_NAMES[order.billing_address?.province_code] || order.billing_address?.province || '')  : '',
        isFirst ? (JP_PROVINCE_NAMES[order.shipping_address?.province_code] || order.shipping_address?.province || '') : '',
        isFirst ? (order.transactions?.[0]?.authorization || '') : '',
        '',
        '',
        isFirst ? (order.transactions?.[0]?.authorization || '') : '',
      ]);
    });
  }

  return rows.map(row => row.map(v => csvEscape(String(v ?? ''))).join(',')).join('\r\n');
}

// ============================================================
// バンドル商品のSKU展開
// ① 注文プロパティに「XXX SKU」があればそれを使用
// ② なければ商品名からSKUマップで解決
// ============================================================
function expandLineItems(order) {
  const result = [];
  for (const item of order.line_items) {
    // ① プロパティからSKUを取得
    const skuProps = (item.properties || []).filter(p => p.name.endsWith(' SKU') && p.value);
    if (skuProps.length > 0) {
      skuProps.forEach(prop => result.push({ ...item, sku: prop.value }));
      continue;
    }

    // ② 商品名からSKUマップで解決（フォールバック）
    const name = item.name || '';
    if (!item.sku && name.includes(' - ') && name.includes(' / ')) {
      const optPart   = name.slice(name.indexOf(' - ') + 3);
      const options   = optPart.split(' / ').map(o => o.trim());
      const skuValues = options.map(o => SKU_MAP[o] || SKU_MAP[o.toUpperCase()] || null).filter(Boolean);
      if (skuValues.length > 0) {
        skuValues.forEach(sku => result.push({ ...item, sku }));
        continue;
      }
    }

    result.push(item);
  }
  return result;
}

// ============================================================
// ユーティリティ
// ============================================================
function getTaxColumns(taxLines) {
  const result = [];
  for (let i = 0; i < 5; i++) {
    const t = taxLines?.[i];
    result.push(t ? `${t.title} ${Math.round((t.rate || 0) * 100)}%` : '');
    result.push(t?.price || '');
  }
  return result;
}

function joinAddr(addr) {
  if (!addr) return '';
  return [addr.address1, addr.address2].filter(Boolean).join(', ');
}

function fmtNoteAttrs(attrs) {
  if (!attrs || attrs.length === 0) return '';
  return attrs.map(a => `${a.name}: ${a.value}`).join(', ');
}

function csvEscape(value) {
  if (value.includes(',') || value.includes('"') || value.includes('\n') || value.includes('\r')) {
    return `"${value.replace(/"/g, '""')}"`;
  }
  return value;
}

// ============================================================
// 在庫連動: ヘルパー関数
// ============================================================
async function initPouchInventory() {
  try {
    // 環境変数で直接指定されている場合はそちらを優先
    if (process.env.POUCH_INVENTORY_ITEM_ID) {
      pouchInventoryItemId = Number(process.env.POUCH_INVENTORY_ITEM_ID);
      console.log(`✅ POUCH inventory_item_id を環境変数から取得: ${pouchInventoryItemId}`);
    } else {
      // POUCH商品のvariantsからinventory_item_idを取得
      const r = await fetch(
        `https://${shopDomain}/admin/api/2024-01/products/${POUCH_PRODUCT_ID}/variants.json`,
        { headers: { 'X-Shopify-Access-Token': accessToken } }
      );
      const d = await r.json();
      const variants = d.variants || [];
      console.log('POUCHバリアントSKU一覧:', variants.map(v => `${v.id}:${v.sku}`).join(', '));
      const found = variants.find(v => v.sku === POUCH_SKU);
      if (!found) throw new Error(`SKU "${POUCH_SKU}" が見つかりません`);
      pouchInventoryItemId = found.inventory_item_id;
    }

    if (process.env.POUCH_LOCATION_ID) {
      pouchLocationId = Number(process.env.POUCH_LOCATION_ID);
    } else {
      const r2 = await fetch(`https://${shopDomain}/admin/api/2024-01/inventory_levels.json?inventory_item_ids=${pouchInventoryItemId}`, {
        headers: { 'X-Shopify-Access-Token': accessToken }
      });
      const d2 = await r2.json();
      pouchLocationId = d2.inventory_levels[0].location_id;
    }
    console.log(`✅ POUCH在庫初期化: item=${pouchInventoryItemId}, location=${pouchLocationId}`);
  } catch (e) { console.error('POUCH初期化エラー:', e); }
}

async function adjustPouchInventory(delta) {
  const resp = await fetch(`https://${shopDomain}/admin/api/2024-01/inventory_levels/adjust.json`, {
    method: 'POST',
    headers: { 'X-Shopify-Access-Token': accessToken, 'Content-Type': 'application/json' },
    body: JSON.stringify({ location_id: pouchLocationId, inventory_item_id: pouchInventoryItemId, available_adjustment: delta })
  });
  const data = await resp.json();
  return data.inventory_level.available;
}

async function updateSetInventory(available) {
  let url = `https://${shopDomain}/admin/api/2024-01/products/${SET_PRODUCT_ID}/variants.json?limit=250`;
  while (url) {
    const resp = await fetch(url, { headers: { 'X-Shopify-Access-Token': accessToken } });
    const data = await resp.json();
    for (const v of data.variants) {
      await fetch(`https://${shopDomain}/admin/api/2024-01/inventory_levels/set.json`, {
        method: 'POST',
        headers: { 'X-Shopify-Access-Token': accessToken, 'Content-Type': 'application/json' },
        body: JSON.stringify({ location_id: pouchLocationId, inventory_item_id: v.inventory_item_id, available })
      });
    }
    const link = resp.headers.get('link');
    const next = link && link.match(/<([^>]+)>;\s*rel="next"/);
    url = next ? next[1] : null;
  }
}

async function registerWebhooks() {
  const webhooks = [
    { topic: 'orders/paid',      address: `${HOST}/webhook/orders/paid` },
    { topic: 'orders/cancelled', address: `${HOST}/webhook/orders/cancelled` },
  ];
  for (const wh of webhooks) {
    const resp = await fetch(`https://${shopDomain}/admin/api/2024-01/webhooks.json`, {
      method: 'POST',
      headers: { 'X-Shopify-Access-Token': accessToken, 'Content-Type': 'application/json' },
      body: JSON.stringify({ webhook: { topic: wh.topic, address: wh.address, format: 'json' } })
    });
    const data = await resp.json();
    if (data.webhook) console.log(`✅ Webhook登録: ${wh.topic}`);
    else console.log(`ℹ️ Webhook登録スキップ(既存): ${wh.topic}`, data.errors);
  }
}

// ============================================================
// サーバー起動
// ============================================================
const PORT = process.env.PORT || 3000;
app.listen(PORT, async () => {
  console.log(`✅ サーバー起動: http://localhost:${PORT}`);
  if (accessToken && shopDomain) {
    await initPouchInventory();
    await registerWebhooks();
  }
});
