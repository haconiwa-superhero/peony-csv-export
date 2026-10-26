'use strict';

function buildInventoryAlertEmail({ item, threshold, currentQuantity, shop }) {
  const subject = `【在庫通知】${item.productTitle}：在庫${threshold}以下`;
  const text = [
    `${item.productTitle}の在庫が通知基準を下回りました。`,
    item.variantTitle && item.variantTitle !== 'Default Title' ? `カラー・種類: ${item.variantTitle}` : '',
    item.sku ? `SKU: ${item.sku}` : '',
    `現在の在庫数: ${currentQuantity}`,
    `通知基準: ${threshold}以下`,
    item.adminUrl ? `商品管理画面: ${item.adminUrl}` : '',
    `ストア: ${shop}`,
  ].filter(Boolean).join('\n');
  return { subject, text };
}

async function sendInventoryEmail({ apiKey, from, to, email, dryRun = true }) {
  if (dryRun) {
    console.log('[inventory-alert][dry-run]', JSON.stringify({ to, ...email }));
    return { dryRun: true };
  }
  if (!apiKey || !from || !to) throw new Error('メール送信設定が不足しています');

  const response = await fetch('https://api.resend.com/emails', {
    method: 'POST',
    headers: { Authorization: `Bearer ${apiKey}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ from, to: [to], subject: email.subject, text: email.text }),
  });
  const body = await response.json();
  if (!response.ok) throw new Error(`メール送信失敗: ${response.status} ${JSON.stringify(body)}`);
  return body;
}

module.exports = { buildInventoryAlertEmail, sendInventoryEmail };
