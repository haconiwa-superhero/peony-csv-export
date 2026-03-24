require('dotenv').config();
const express = require('express');
const multer = require('multer');
const iconv = require('iconv-lite');

const app = express();
const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 10 * 1024 * 1024 } });

app.use(express.static('public'));

// ============================================================
// SKUマップ（商品オプション値 → SKUコード）
// ============================================================
const SKU_MAP = {
  "GLOW OF LOVE HIGHLIGHTER 01": "GOH01 card sets",
  "GLOW OF LOVE HIGHLIGHTER 02": "GOH02-02",
  "GLOW OF LOVE HIGHLIGHTER 03": "GOH03",
  "GLOW OF LOVE HIGHLIGHTER 04": "GOH04",
  "MARSHMALLOW TOUCH CHEEK 01": "MTC01",
  "MARSHMALLOW TOUCH CHEEK 02": "MTC02",
  "MARSHMALLOW TOUCH CHEEK 03": "MTC03",
  "MARSHMALLOW TOUCH CHEEK 04": "MTC04",
  "MARSHMALLOW TOUCH CHEEK 05": "MTC05",
  "HEART LACE POUCH": "LACE-HEARTPOUCH",
  "HEROINE MOOD EYE PALETTE 01": "HMEY01-01",
  "HEROINE MOOD EYE PALETTE 02": "HMEY02-02",
  "HEROINE MOOD EYE PALETTE 03": "HMEY03-03",
  "MELTING CREAM LIP BALM 01": "MCL-01",
  "MELTING CREAM LIP BALM 02": "MCL-02",
  "MELTING CREAM LIP BALM 03": "MCL-03",
  "MELTING CREAM LIP BALM 04": "MCL-04",
  "GLOSSY HONEY COUVERTURE LIP GLOSS 01": "GHC-LG-01",
  "GLOSSY HONEY COUVERTURE LIP GLOSS 02": "GHC-LG-02",
  "GLOSSY HONEY COUVERTURE LIP GLOSS 03": "GHC-LG-03",
  "GLOSSY HONEY COUVERTURE LIP GLOSS 04": "GHC-LG-04",
  "GLOSSY HONEY COUVERTURE LIP GLOSS 05": "GHC-LG-05",
  "GLOSSY HONEY COUVERTURE LIP GLOSS 06": "GHC-LG-06",
  "GLOSSY HONEY COUVERTURE LIP GLOSS 07": "GHC-LG-07",
  "GLOSSY HONEY COUVERTURE LIP GLOSS 08": "GHC-LG-08",
  "GLOSSY HONEY COUVERTURE LIP GLOSS 09": "GHC-LG-09",
  "GLOSSY HONEY COUVERTURE LIP GLOSS 10": "GHC-LG-10",
  "GLOSSY HONEY COUVERTURE LIP GLOSS 11": "GHC-LG-11",
  "GLOSSY HONEY COUVERTURE LIP GLOSS 12": "GHC-LG-12",
  "MUSE OF ECLAT EYESHADOW 01": "MOEE-01",
  "MUSE OF ECLAT EYESHADOW 02": "MOEE-02",
  "MUSE OF ECLAT EYESHADOW 03": "MOEE-03",
  "MUSE OF ECLAT EYESHADOW 04": "MOEE-04",
  "MUSE OF ECLAT EYESHADOW 05": "MOEE-05",
  "MUSE OF ECLAT EYESHADOW 06": "MOEE-06",
  "MUSE OF ECLAT EYESHADOW 07": "MOEE-07",
  "MUSE OF ECLAT EYESHADOW 08": "MOEE-08",
  "MUSE OF ECLAT EYESHADOW 09": "MOEE-09",
  "MUSE OF ECLAT EYESHADOW 10": "MOEE-10",
};

// ============================================================
// CSV変換エンドポイント
// ============================================================
app.post('/transform', upload.single('csv'), (req, res) => {
  if (!req.file) return res.status(400).json({ error: 'CSVファイルが見つかりません' });

  try {
    // アップロードされたCSVをUTF-8またはShift-JISとしてデコード
    let text;
    try {
      text = iconv.decode(req.file.buffer, 'UTF-8');
    } catch {
      text = iconv.decode(req.file.buffer, 'Shift_JIS');
    }

    const rows = parseCSV(text);
    if (rows.length < 2) return res.status(400).json({ error: 'CSVデータが空です' });

    const transformed = transformRows(rows);
    const csvText = rowsToCSV(transformed);
    const encoded = iconv.encode(csvText, 'Shift_JIS');

    res.setHeader('Content-Type', 'application/octet-stream');
    res.setHeader('Content-Disposition', 'attachment; filename="orders_converted.csv"');
    res.end(encoded);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: '変換に失敗しました: ' + err.message });
  }
});

// ============================================================
// バンドル商品SKU展開処理
// ============================================================
function transformRows(rows) {
  const headers = rows[0];
  const col = (name) => headers.indexOf(name);

  const nameIdx        = col('Name');
  const emailIdx       = col('Email');
  const createdAtIdx   = col('Created at');
  const itemNameIdx    = col('Lineitem name');
  const itemSkuIdx     = col('Lineitem sku');

  const lineitemCols = [
    'Lineitem quantity', 'Lineitem price', 'Lineitem compare at price',
    'Lineitem requires shipping', 'Lineitem taxable', 'Lineitem fulfillment status',
    'Vendor', 'Lineitem discount',
  ].map(n => ({ name: n, idx: col(n) })).filter(c => c.idx >= 0);

  const result = [headers];

  for (let i = 1; i < rows.length; i++) {
    const row = rows[i];
    const itemName = row[itemNameIdx] || '';
    const itemSku  = row[itemSkuIdx]  || '';

    // バンドル商品の判定: SKU空 + "商品名 - 選択肢1 / 選択肢2" 形式
    if (!itemSku && itemName.includes(' - ') && itemName.includes(' / ')) {
      const dashIdx   = itemName.indexOf(' - ');
      const optPart   = itemName.slice(dashIdx + 3);
      const options   = optPart.split(' / ').map(o => o.trim());
      const skuValues = options.map(o => SKU_MAP[o] || SKU_MAP[o.toUpperCase()] || null).filter(Boolean);

      if (skuValues.length > 0) {
        skuValues.forEach((sku, idx) => {
          if (idx === 0) {
            // 最初の行: 元データをそのまま使いSKUだけ上書き
            const newRow = [...row];
            newRow[itemSkuIdx] = sku;
            result.push(newRow);
          } else {
            // 追加行: 注文識別情報＋ラインアイテム情報のみ
            const emptyRow = new Array(headers.length).fill('');
            emptyRow[nameIdx]      = row[nameIdx];
            emptyRow[emailIdx]     = row[emailIdx];
            if (createdAtIdx >= 0) emptyRow[createdAtIdx] = row[createdAtIdx];
            emptyRow[itemNameIdx]  = row[itemNameIdx];
            emptyRow[itemSkuIdx]   = sku;
            lineitemCols.forEach(c => { emptyRow[c.idx] = row[c.idx]; });
            result.push(emptyRow);
          }
        });
        continue;
      }
    }

    result.push(row);
  }

  return result;
}

// ============================================================
// CSVパーサー（クォート・改行対応）
// ============================================================
function parseCSV(text) {
  // BOM除去
  if (text.charCodeAt(0) === 0xFEFF) text = text.slice(1);

  const rows = [];
  let row = [];
  let field = '';
  let inQuotes = false;

  for (let i = 0; i < text.length; i++) {
    const ch   = text[i];
    const next = text[i + 1];

    if (inQuotes) {
      if (ch === '"' && next === '"') { field += '"'; i++; }
      else if (ch === '"') { inQuotes = false; }
      else { field += ch; }
    } else {
      if      (ch === '"')                     { inQuotes = true; }
      else if (ch === ',')                     { row.push(field); field = ''; }
      else if (ch === '\r' && next === '\n')   { row.push(field); field = ''; rows.push(row); row = []; i++; }
      else if (ch === '\n' || ch === '\r')     { row.push(field); field = ''; rows.push(row); row = []; }
      else                                     { field += ch; }
    }
  }

  if (row.length > 0 || field) { row.push(field); rows.push(row); }

  // 末尾の空行を除去
  while (rows.length > 0 && rows[rows.length - 1].every(f => f === '')) rows.pop();

  return rows;
}

// ============================================================
// CSV生成
// ============================================================
function rowsToCSV(rows) {
  return rows.map(row =>
    row.map(v => {
      const s = String(v ?? '');
      return (s.includes(',') || s.includes('"') || s.includes('\n') || s.includes('\r'))
        ? `"${s.replace(/"/g, '""')}"`
        : s;
    }).join(',')
  ).join('\r\n');
}

// ============================================================
// サーバー起動
// ============================================================
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`✅ サーバー起動: http://localhost:${PORT}`));
