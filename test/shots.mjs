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

// ルール欄を閉じたとき、本文が帯の下に覗いていないか確認する
const rulesChecks = [];
async function checkRulesClosed(page, label) {
  // 開いていれば閉じる
  if (await page.getAttribute('#rules-toggle', 'aria-expanded') === 'true') await page.click('#rules-toggle');
  await sleep(350); // 畳みアニメ＋hidden 付与を待つ
  const info = await page.evaluate(() => {
    const box = document.querySelector('#rules-box');
    const body = document.querySelector('#rules-body');
    const barBottom = box.getBoundingClientRect().bottom;
    const bodyHidden = body.hidden || body.offsetHeight === 0;
    let textBelow = false; // 帯の下端より下に本文テキストが描画されていないか
    for (const el of body.querySelectorAll('li, p')) {
      const r = el.getBoundingClientRect();
      if (r.height > 0 && r.bottom > barBottom + 0.5) textBelow = true;
    }
    return { bodyHidden, textBelow, barBottom: Math.round(barBottom), bodyH: body.offsetHeight };
  });
  const ok = info.bodyHidden && !info.textBelow;
  rulesChecks.push({ label, ok, ...info });
  console.log(`  ${ok ? '✓' : '✗'} ${label}: 本文非表示=${info.bodyHidden} 帯下に本文=${info.textBelow} (body offsetHeight=${info.bodyH})`);
}

// メッセージを50件入れても、リアクション列の高さが空のときと変わらない（潰れない）か
const reactionChecks = [];
async function checkReactions(page, label, logSel, reactSel) {
  const empty = await page.$eval(reactSel, el => el.offsetHeight);
  await page.evaluate(sel => {
    const log = document.querySelector(sel);
    for (let i = 0; i < 50; i++) {
      const d = document.createElement('div');
      d.className = 'chat-msg other';
      d.dataset.shotsTest = '1';
      d.innerHTML = `<div class="chat-bubble">テストメッセージ ${i}</div>`;
      log.appendChild(d);
    }
  }, logSel);
  await sleep(200);
  const full = await page.$eval(reactSel, el => el.offsetHeight);
  const ok = empty > 0 && full === empty;
  reactionChecks.push({ label, empty, full, ok });
  console.log(`  ${ok ? '✓' : '✗'} ${label}: リアクション列の高さ 空=${empty}px / 50件=${full}px`);
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

// リアクション列が、メッセージが50件に増えても潰れない（空と同じ高さ）か
console.log('リアクション列の高さチェック:');
await hp.setViewportSize({ width: 1280, height: 720 });
await sleep(200);
await checkReactions(hp, 'ゲーム列', '#chat-col .chat-log', '#chat-col .chat-reactions');
// 差し込んだテスト用メッセージは消す（以降のスクショを汚さない）
await hp.evaluate(() => document.querySelectorAll('#chat-col .chat-log [data-shots-test]').forEach(n => n.remove()));

// ルール欄を閉じたときの確認（1920×1080）＋スクショ。390px は PC のルール帯が
// 出ない（スマホはシート）ので、閉じた状態のゲーム画面をそのまま撮る。
console.log('ルール欄を閉じたときの確認:');
await hp.setViewportSize({ width: 1920, height: 1080 });
await sleep(300);
await checkRulesClosed(hp, '1920x1080');
await hp.screenshot({ path: path.join(OUT, 'rules-closed-1920.png') });
console.log('  📸 rules-closed-1920');
await hp.setViewportSize({ width: 390, height: 780 });
await sleep(300);
await hp.screenshot({ path: path.join(OUT, 'rules-closed-390.png') });
console.log('  📸 rules-closed-390');
// 以降のスクショは開いた状態に戻す
await hp.setViewportSize({ width: 1280, height: 860 });
await sleep(200);
await hp.click('#rules-toggle');
await sleep(300);

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

// 集計
const ng = checks.filter(c => !c.ok);
const rulesNg = rulesChecks.filter(c => !c.ok);
const reactNg = reactionChecks.filter(c => !c.ok);
console.log('\n--- チャット入力欄チェック結果 ---');
for (const c of checks) console.log(`  ${c.ok ? '✓' : '✗'} ${c.label} ${c.size}: bottom=${c.bottom} innerH=${c.inner}`);
console.log('--- ルール欄を閉じたときのチェック結果 ---');
for (const c of rulesChecks) console.log(`  ${c.ok ? '✓' : '✗'} ${c.label}: 本文非表示=${c.bodyHidden} 帯下に本文=${c.textBelow}`);
console.log('--- リアクション列の高さチェック結果 ---');
for (const c of reactionChecks) console.log(`  ${c.ok ? '✓' : '✗'} ${c.label}: 空=${c.empty}px / 50件=${c.full}px`);
if (ng.length || rulesNg.length || reactNg.length) {
  if (ng.length) console.log(`\n❌ 入力欄 ${ng.length} 件が画面外`);
  if (rulesNg.length) console.log(`❌ ルール欄 ${rulesNg.length} 件で本文が覗いている`);
  if (reactNg.length) console.log(`❌ リアクション列 ${reactNg.length} 件が潰れている`);
  console.log('完了(スクショ):', OUT);
  process.exit(1);
}
console.log(`\n✅ 入力欄は画面内／ルール欄は閉じると隠れる／リアクション列は50件でも潰れない`);
console.log('完了(スクショ):', OUT);
process.exit(0);
