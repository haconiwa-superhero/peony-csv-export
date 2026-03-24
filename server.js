require('dotenv').config();
const express = require('express');
const crypto = require('crypto');
const fetch = require('node-fetch');
const iconv = require('iconv-lite');

const app = express();
app.use(express.static('public'));

const CLIENT_ID = process.env.SHOPIFY_CLIENT_ID;
const CLIENT_SECRET = process.env.SHOPIFY_CLIENT_SECRET;
const HOST = process.env.HOST; // e.g., https://your-app.onrender.com
const SCOPES = 'read_orders';

let shopDomain = process.env.SHOPIFY_SHOP || '';
let accessToken = process.env.SHOPIFY_ACCESS_TOKEN || '';

// ============================================================
// OAuth: Step 1 - Shopify認証ページへリダイレクト
// ============================================================
app.get('/auth', (req, res) => {
  const shop = req.query.shop || shopDomain;
  if (!shop) return res.send('shopパラメータが必要です');
  const state = crypto.randomBytes(16).toString('hex');
  const redirectUri = encodeURIComponent(`${HOST}/auth/callback`);
  res.redirect(
    `https://${shop}/admin/oauth/authorize?client_id=${CLIENT_ID}&scope=${SCOPES}&redirect_uri=${redirectUri}&state=${state}`
  );
});

// ============================================================
// OAuth: Step 2 - コールバック処理・アクセストークン取得
// ============================================================
app.get('/auth/callback', async (req, res) => {
  const { code, shop, hmac } = req.query;

  // HMAC検証
  const params = Object.entries(req.query)
    .filter(([k]) => k !== 'hmac' && k !== 'signature')
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([k, v]) => `${k}=${v}`)
    .join('&');
  const digest = crypto.createHmac('sha256', CLIENT_SECRET).update(params).digest('hex');
  if (digest !== hmac) return res.status(400).send('認証エラー: HMAC verification failed');

  const resp = await fetch(`https://${shop}/admin/oauth/access_token`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ client_id: CLIENT_ID, client_secret: CLIENT_SECRET, code }),
  });
  const data = await resp.json();
  accessToken = data.access_token;
  shopDomain = shop;

  // 初回インストール時にトークンをコンソール表示（Renderの環境変数に設定するため）
  console.log('\n========================================');
  console.log('✅ アクセストークン取得成功!');
  console.log(`SHOPIFY_ACCESS_TOKEN=${accessToken}`);
  console.log(`SHOPIFY_SHOP=${shop}`);
  console.log('上記をRenderの環境変数に設定してください');
  console.log('========================================\n');

  res.redirect('/');
});

// ============================================================
// トップページ
// ============================================================
app.get('/', (req, res) => {
  if (!accessToken) return res.redirect('/auth');
  res.sendFile(__dirname + '/public/index.html');
});

// ============================================================
// CSVエクスポート
// ============================================================
app.get('/export', async (req, res) => {
  if (!accessToken) return res.redirect('/auth');

  const { start, end } = req.query;
  if (!start || !end) return res.status(400).send('start/endパラメータが必要です');

  try {
    const orders = await fetchAllOrders(start, end);
    const csv = generateCSV(orders);
    const encoded = iconv.encode(csv, 'Shift_JIS');

    res.setHeader('Content-Type', 'application/octet-stream');
    res.setHeader(
      'Content-Disposition',
      `attachment; filename="orders_${start}_${end}.csv"`
    );
    res.end(encoded);
  } catch (err) {
    console.error(err);
    res.status(500).send('エクスポートに失敗しました: ' + err.message);
  }
});

// ============================================================
// 全注文取得（ページネーション対応）
// ============================================================
async function fetchAllOrders(start, end) {
  const orders = [];
  let url =
    `https://${shopDomain}/admin/api/2024-01/orders.json` +
    `?status=any` +
    `&created_at_min=${start}T00:00:00+09:00` +
    `&created_at_max=${end}T23:59:59+09:00` +
    `&limit=250` +
    `&fields=id,name,email,financial_status,fulfillment_status,created_at,processed_at,` +
    `line_items,billing_address,shipping_address,note,subtotal_price,shipping_lines,` +
    `total_tax,total_price,discount_codes,payment_gateway,cancelled_at,tags,` +
    `note_attributes,customer,fulfillments,source_name,currency,` +
    `total_shipping_price_set`;

  while (url) {
    const resp = await fetch(url, {
      headers: { 'X-Shopify-Access-Token': accessToken },
    });
    if (!resp.ok) throw new Error(`Shopify API error: ${resp.status}`);
    const data = await resp.json();
    orders.push(...(data.orders || []));

    // ページネーション
    const linkHeader = resp.headers.get('link');
    const nextMatch = linkHeader && linkHeader.match(/<([^>]+)>;\s*rel="next"/);
    url = nextMatch ? nextMatch[1] : null;
  }

  return orders;
}

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
  ];

  const rows = [headers];

  for (const order of orders) {
    const lineItems = expandLineItems(order);

    lineItems.forEach((item, index) => {
      const isFirst = index === 0;
      const row = [
        // 注文レベルの情報（最初の行のみ）
        isFirst ? (order.name || '') : '',
        isFirst ? (order.email || '') : '',
        isFirst ? (order.financial_status || '') : '',
        isFirst ? formatDate(order.processed_at) : '',
        isFirst ? (order.fulfillment_status || '') : '',
        isFirst ? formatDate(order.fulfillments?.[0]?.updated_at) : '',
        isFirst ? (order.customer?.accepts_marketing ? 'yes' : 'no') : '',
        isFirst ? (order.currency || '') : '',
        isFirst ? (order.subtotal_price || '') : '',
        isFirst ? (order.total_shipping_price_set?.shop_money?.amount || '0') : '',
        isFirst ? (order.total_tax || '') : '',
        isFirst ? (order.total_price || '') : '',
        isFirst ? (order.discount_codes?.[0]?.code || '') : '',
        isFirst ? (order.discount_codes?.[0]?.amount || '0') : '',
        isFirst ? (order.shipping_lines?.[0]?.title || '') : '',
        isFirst ? formatDate(order.created_at) : '',
        // ラインアイテムの情報
        item.quantity,
        item.name,
        item.price,
        item.compare_at_price || '',
        item.sku || '',
        item.requires_shipping ? 'true' : 'false',
        item.taxable ? 'true' : 'false',
        item.fulfillment_status || '',
        // 請求先住所
        isFirst ? (order.billing_address?.name || '') : '',
        isFirst ? joinAddress(order.billing_address) : '',
        isFirst ? (order.billing_address?.address1 || '') : '',
        isFirst ? (order.billing_address?.address2 || '') : '',
        isFirst ? (order.billing_address?.company || '') : '',
        isFirst ? (order.billing_address?.city || '') : '',
        isFirst ? (order.billing_address?.zip || '') : '',
        isFirst ? (order.billing_address?.province_code || '') : '',
        isFirst ? (order.billing_address?.country_code || '') : '',
        isFirst ? (order.billing_address?.phone || '') : '',
        // 配送先住所
        isFirst ? (order.shipping_address?.name || '') : '',
        isFirst ? joinAddress(order.shipping_address) : '',
        isFirst ? (order.shipping_address?.address1 || '') : '',
        isFirst ? (order.shipping_address?.address2 || '') : '',
        isFirst ? (order.shipping_address?.company || '') : '',
        isFirst ? (order.shipping_address?.city || '') : '',
        isFirst ? (order.shipping_address?.zip || '') : '',
        isFirst ? (order.shipping_address?.province_code || '') : '',
        isFirst ? (order.shipping_address?.country_code || '') : '',
        isFirst ? (order.shipping_address?.phone || '') : '',
        // その他
        isFirst ? (order.note || '') : '',
        isFirst ? formatNoteAttributes(order.note_attributes) : '',
        isFirst ? (order.cancelled_at ? formatDate(order.cancelled_at) : '') : '',
        isFirst ? (order.payment_gateway || '') : '',
        '', // Payment Reference
        '0', // Refunded Amount
        item.vendor || '',
        '0', // Outstanding Balance
        '', '', '', // Employee, Location, Device ID
        isFirst ? String(order.id) : '',
        isFirst ? (order.tags || '') : '',
        '', // Risk Level
        isFirst ? (order.source_name || 'web') : '',
        '0', // Lineitem discount
      ];
      rows.push(row);
    });
  }

  return rows.map(row => row.map(v => csvEscape(String(v ?? ''))).join(',')).join('\r\n');
}

// ============================================================
// バンドル商品のSKU展開
// ============================================================
function expandLineItems(order) {
  const result = [];
  for (const item of order.line_items) {
    // プロパティに「XXX SKU」が含まれる場合はバンドル商品として展開
    const skuProps = (item.properties || []).filter(
      p => p.name.endsWith(' SKU') && p.value
    );

    if (skuProps.length > 0) {
      skuProps.forEach(prop => {
        result.push({ ...item, sku: prop.value });
      });
    } else {
      result.push(item);
    }
  }
  return result;
}

// ============================================================
// ユーティリティ
// ============================================================
function formatDate(dateStr) {
  if (!dateStr) return '';
  return dateStr;
}

function joinAddress(addr) {
  if (!addr) return '';
  return [addr.address1, addr.address2].filter(Boolean).join(', ');
}

function formatNoteAttributes(attrs) {
  if (!attrs || attrs.length === 0) return '""';
  return attrs.map(a => `${a.name}: ${a.value}`).join(', ');
}

function csvEscape(value) {
  if (value.includes(',') || value.includes('"') || value.includes('\n') || value.includes('\r')) {
    return `"${value.replace(/"/g, '""')}"`;
  }
  return value;
}

// ============================================================
// サーバー起動
// ============================================================
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`✅ サーバー起動: http://localhost:${PORT}`);
});
