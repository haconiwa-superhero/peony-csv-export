'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { evaluateInventoryChange, normalizeThresholds } = require('../lib/inventory-alerts');
const { buildInventoryAlertEmail } = require('../lib/inventory-email');

const thresholds = [500, 300, 100, 50, 0];

test('初回観測時は通知しない', () => {
  assert.equal(evaluateInventoryChange({ previousQuantity: null, currentQuantity: 40, thresholds }).action, 'initialize');
});

test('600から499で500以下を通知する', () => {
  assert.deepEqual(evaluateInventoryChange({ previousQuantity: 600, currentQuantity: 499, thresholds }), {
    action: 'notify', previousQuantity: 600, currentQuantity: 499, threshold: 500,
  });
});

test('600から40へ急減した場合は最も低い50以下のみ通知する', () => {
  assert.equal(evaluateInventoryChange({ previousQuantity: 600, currentQuantity: 40, thresholds }).threshold, 50);
});

test('600から0へ急減した場合は0のみ通知する', () => {
  assert.equal(evaluateInventoryChange({ previousQuantity: 600, currentQuantity: 0, thresholds }).threshold, 0);
});

test('同じ数量の再送Webhookでは通知しない', () => {
  assert.equal(evaluateInventoryChange({ previousQuantity: 50, currentQuantity: 50, thresholds }).action, 'ignore');
});

test('補充時は通知せず、その後の再減少で再通知できる', () => {
  assert.equal(evaluateInventoryChange({ previousQuantity: 40, currentQuantity: 600, thresholds }).action, 'restocked');
  assert.equal(evaluateInventoryChange({ previousQuantity: 600, currentQuantity: 490, thresholds }).threshold, 500);
});

test('基準値は重複除去して降順に正規化する', () => {
  assert.deepEqual(normalizeThresholds('50,500,100,50,0,300'), thresholds);
});

test('通知メールに商品・種類・SKU・現在数・基準値を含める', () => {
  const email = buildInventoryAlertEmail({
    item: { productTitle: '商品A', variantTitle: 'PINK', sku: 'A-PINK', adminUrl: 'https://example.com/admin' },
    threshold: 50,
    currentQuantity: 40,
    shop: 'example.myshopify.com',
  });
  assert.match(email.text, /商品Aの在庫が通知基準を下回りました。\nカラー・種類: PINK\nSKU: A-PINK\n現在の在庫数: 40\n通知基準: 50以下/);
});
