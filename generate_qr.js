/**
 * PayPay QRコード生成スクリプト（単一QR版）
 *
 * 金額に関係なく、常に同じPayPay受け取りURLのQRコードを1枚生成します。
 * 客はQRを読み取った後、PayPayアプリ側で金額を自分で入力して送金します。
 *
 * 使い方:
 *   node generate_qr.js "https://qr.paypay.ne.jp/あなたの受け取りURL"
 *
 * 引数を省略した場合、data/stores.json に保存済みのPayPay URL（最初の出店のもの）を使用します。
 */

const QRCode = require('qrcode');
const fs = require('fs');
const path = require('path');

const QR_DIR = path.join(__dirname, 'data', 'qr');
const OUTPUT_FILE = path.join(QR_DIR, 'fixed.png');

let paypayUrl = process.argv[2];

// 引数がなければ stores.json から読む
if (!paypayUrl) {
  try {
    const data = JSON.parse(fs.readFileSync(path.join(__dirname, 'data', 'stores.json'), 'utf8'));
    const firstStore = Object.values(data)[0];
    if (firstStore && firstStore.paypayUrl) {
      paypayUrl = firstStore.paypayUrl;
      console.log('stores.json から PayPay URL を取得しました:');
      console.log('  ' + paypayUrl);
    }
  } catch (e) {}
}

if (!paypayUrl) {
  console.error('\nPayPay URL が指定されていません。\n');
  console.error('使い方:');
  console.error('  node generate_qr.js "https://qr.paypay.ne.jp/あなたの受け取りURL"\n');
  console.error('または管理画面の「PayPay設定」でURLを保存してから実行してください。\n');
  process.exit(1);
}

if (!paypayUrl.startsWith('http')) {
  console.error('\nURLの形式が正しくありません: ' + paypayUrl + '\n');
  process.exit(1);
}

if (!fs.existsSync(path.join(__dirname, 'data'))) fs.mkdirSync(path.join(__dirname, 'data'));
if (!fs.existsSync(QR_DIR)) fs.mkdirSync(QR_DIR);

const QR_OPTIONS = {
  width: 300,
  margin: 2,
  color: { dark: '#000000', light: '#FFFFFF' },
  errorCorrectionLevel: 'M',
};

console.log('\nPayPay QRコード生成');
console.log('━'.repeat(44));
console.log('URL : ' + paypayUrl);
console.log('出力: ' + OUTPUT_FILE);
console.log('━'.repeat(44) + '\n');

QRCode.toFile(OUTPUT_FILE, paypayUrl, QR_OPTIONS)
  .then(() => {
    console.log('完了！ QRコードを生成しました。');
    console.log('客画面でPayPayを選択すると、このQRが表示されます。\n');
  })
  .catch(e => {
    console.error('生成失敗: ' + e.message);
    process.exit(1);
  });
