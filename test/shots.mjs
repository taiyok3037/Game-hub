// 手順5の確認用：各幅でゲーム画面・ロビーのスクリーンショットを撮る（任意の手動ツール）
// npm test には含めない。playwright は依存に入れていないので、使う前に別途入れる：
//   npm i -D playwright && npx playwright install chromium
// 実行: node test/shots.mjs   出力: test/shots/*.png（.gitignore 済み）
import { chromium } from 'playwright';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const PORT = 3599;
process.env.PORT = String(PORT);
await import('../server.js');
const BASE = `http://localhost:${PORT}`;

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const OUT = path.join(__dirname, 'shots');
fs.mkdirSync(OUT, { recursive: true });

const WIDTHS = [1600, 1280, 1000, 900, 390];
// 仕様08：チャット入力欄が画面内に収まるか確かめる画面サイズ
const SIZES = [[1920, 1080], [1366, 768], [1280, 720], [1165, 870], [1000, 700]];
const sleep = ms => new Promise(r => setTimeout(r, ms));

const browser = await chromium.launch();

async function shot(page, name, width, height = 900) {
  await page.setViewportSize({ width, height });
  await sleep(350);
  await page.screenshot({ path: path.join(OUT, `${name}.png`), fullPage: false });
  console.log('  📸', name);
}

// チャット入力欄の下端が画面内（rect.bottom <= innerHeight）にあるか各サイズで確認
const checks = [];
async function checkInput(page, label, inputSel) {
  for (const [w, h] of SIZES) {
    await page.setViewportSize({ width: w, height: h });
    await sleep(300);
    const info = await page.$eval(inputSel, el => {
      const r = el.getBoundingClientRect();
      return { bottom: Math.round(r.bottom), inner: window.innerHeight, w: Math.round(r.width) };
    });
    const ok = info.bottom <= info.inner && info.w > 0;
    checks.push({ label, size: `${w}x${h}`, bottom: info.bottom, inner: info.inner, ok });
    console.log(`  ${ok ? '✓' : '✗'} ${label} ${w}x${h}: 入力欄 bottom=${info.bottom} / innerH=${info.inner}`);
  }
}

// --- 2人でダイス領土戦を開始する ---
const host = await browser.newContext();
const hp = await host.newPage();
await hp.goto(BASE);
await hp.fill('#name', 'ホスト');
await hp.click('.game-box[data-id="dicewar"]');
await hp.waitForSelector('#lobby-code:not(:empty)', { timeout: 10000 });
const code = (await hp.textContent('#lobby-code')).trim();
console.log('ルームコード:', code);

const guest = await browser.newContext();
const gp = await guest.newPage();
await gp.goto(BASE);
await gp.fill('#name', 'ゲスト');
await gp.fill('#join-code', code);
await gp.click('#join-btn');
await gp.waitForSelector('#lobby-code:not(:empty)', { timeout: 10000 });

// ロビーのチャット入力欄チェック（2列表示）
console.log('ロビーのチャット入力欄チェック:');
await checkInput(hp, 'ロビー', '#lobby-chat-slot .chat-input');

// ロビーのスクショ（ホスト側・900px、チャット右）
await shot(hp, 'lobby-900', 900);
await shot(hp, 'lobby-390', 390);

// 待たずに開始（確認ダイアログを受ける）
hp.on('dialog', d => d.accept());
await hp.click('#force-start');
await hp.waitForSelector('#screen-game:not([hidden])', { timeout: 10000 });
await gp.waitForSelector('#screen-game:not([hidden])', { timeout: 10000 });
await sleep(600);

// ゲーム画面のチャット入力欄チェック（既定：チャット右・開いている）
console.log('ゲーム画面のチャット入力欄チェック:');
await checkInput(hp, 'ゲーム', '#chat-col .chat-input');

// 既定（チャット右・開いている）で各幅
for (const w of WIDTHS) await shot(hp, `game-open-right-${w}`, w);

// チャットを左へ（PCの⇄）→ 1280 で確認、リロードでも残るか
await hp.setViewportSize({ width: 1280, height: 900 });
await sleep(300);
await hp.click('.chat-col .chat-swap');
await sleep(400);
await shot(hp, 'game-open-left-1280', 1280);
await hp.reload();
await hp.waitForSelector('#screen-game:not([hidden])', { timeout: 10000 });
await sleep(600);
await shot(hp, 'game-open-left-1280-reload', 1280);

// チャットを閉じる（×）→ 卓が広がる
await hp.click('.chat-col .chat-close');
await sleep(400);
await shot(hp, 'game-closed-1280', 1280);
// 右に戻しておく（次の人のため）… ここでは閉じたまま 1000 も
await shot(hp, 'game-closed-1000', 1000);

// スマホ 390：チャットシートとルールシート
await hp.setViewportSize({ width: 390, height: 780 });
await sleep(300);
await hp.click('#chat-btn');
await sleep(400);
await shot(hp, 'game-390-chat-sheet', 390, 780);
await hp.click('#chat-sheet-close');
await sleep(300);
await hp.click('#rules-btn');
await sleep(400);
await shot(hp, 'game-390-rules-sheet', 390, 780);

await browser.close();

// 入力欄チェックの集計
const ng = checks.filter(c => !c.ok);
console.log('\n--- チャット入力欄チェック結果 ---');
for (const c of checks) console.log(`  ${c.ok ? '✓' : '✗'} ${c.label} ${c.size}: bottom=${c.bottom} innerH=${c.inner}`);
if (ng.length) {
  console.log(`\n❌ ${ng.length} 件が画面外にはみ出しています`);
  console.log('完了(スクショ):', OUT);
  process.exit(1);
}
console.log(`\n✅ 入力欄は全 ${checks.length} ケースで画面内`);
console.log('完了(スクショ):', OUT);
process.exit(0);
