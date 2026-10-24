// 喫茶店のレシピ帳の確認用スクショ（手動ツール・npm test には含めない）
//   npm i -D playwright && npx playwright install chromium
//   node test/shots-recipe.mjs   出力: test/shots/recipe-*.png
// 2人をボットで自動対戦させ、途中と決着のスクショを撮る。JSエラー・横スクロールも確認。
import { chromium } from 'playwright';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const PORT = 3597;
process.env.PORT = String(PORT);
process.env.RECIPE_TIME_SCALE = '20'; // 時間切れを避けるためタイマーを延ばす
await import('../server.js');
const BASE = `http://localhost:${PORT}`;
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const OUT = path.join(__dirname, 'shots');
fs.mkdirSync(OUT, { recursive: true });
const sleep = ms => new Promise(r => setTimeout(r, ms));

const errors = [];
const browser = await chromium.launch();
async function newPlayer(name) {
  const ctx = await browser.newContext();
  const p = await ctx.newPage();
  p.on('pageerror', e => errors.push(`${name}: ${e.message}`));
  p.on('console', m => { if (m.type() === 'error') errors.push(`${name} console: ${m.text()}`); });
  await p.goto(BASE);
  await p.fill('#name', name);
  return p;
}

const hp = await newPlayer('あき');
await hp.click('.game-box[data-id="recipe"]');
await hp.waitForSelector('#lobby-code:not(:empty)', { timeout: 10000 });
const code = (await hp.textContent('#lobby-code')).trim();
const gp = await newPlayer('べん');
await gp.fill('#join-code', code);
await gp.click('#join-btn');
await gp.waitForSelector('#lobby-code:not(:empty)', { timeout: 10000 });

hp.on('dialog', d => d.accept());
await hp.click('#force-start');
await hp.waitForSelector('#screen-game:not([hidden])', { timeout: 10000 });
await gp.waitForSelector('#screen-game:not([hidden])', { timeout: 10000 });
await sleep(700);

// --- ボット：手番のページで1手すすめる ---
async function act(page) {
  // 戻す（discard）
  if (await page.$('.rc-disc-ok')) {
    for (let i = 0; i < 12; i++) {
      if (await page.$('.rc-disc-ok:not([disabled])')) break;
      const plus = await page.$('.rc-disc-plus:not([disabled])');
      if (!plus) break;
      await plus.click(); await sleep(40);
    }
    const ok = await page.$('.rc-disc-ok:not([disabled])');
    if (ok) { await ok.click(); return true; }
  }
  // 常連さんを選ぶ
  const reg = await page.$('.rc-reg-choices [data-regular]');
  if (reg) { await reg.click(); return true; }
  // カードのモーダルが開いていたら作る or 閉じる
  if (await page.$('.rc-modal-bg')) {
    const build = await page.$('.rc-build');
    if (build) { await build.click(); return true; }
    const close = await page.$('.rc-close'); if (close) await close.click();
    await sleep(60);
  }
  // 作れるカードがあれば作る
  const buildable = await page.$('.rc-face .rc-card.buildable[data-card], .rc-preserved .rc-card.buildable[data-card]');
  if (buildable) {
    await buildable.click(); await sleep(120);
    const build = await page.$('.rc-build');
    if (build) { await build.click(); return true; }
    const close = await page.$('.rc-close'); if (close) await close.click();
  }
  // 材料を取る（違う3種を選んで取る）。クリックで再描画されるので毎回セレクタで取り直す
  let picked = 0;
  for (const color of ['coffee', 'milk', 'matcha', 'berry', 'honey']) {
    if (picked >= 3) break;
    const sel = `.rc-chip[data-chip="${color}"]`;
    const el = await page.$(sel);
    if (!el) continue;
    if ((await el.getAttribute('class')).includes('empty')) continue;
    try { await page.click(sel, { timeout: 2000 }); picked++; await sleep(60); } catch {}
  }
  if (await page.$('.rc-take:not([disabled])')) { await page.click('.rc-take'); return true; }
  if (await page.$('.rc-clear:not([disabled])')) { await page.click('.rc-clear'); }
  if (await page.$('.rc-pass')) { await page.click('.rc-pass'); return true; }
  return false;
}

let shotMid = false;
let turns = 0;
for (; turns < 400; turns++) {
  if (await hp.$('.rc-over')) break;
  // 手番のページ（操作UIがある方）を選ぶ
  const page = (await hp.$('.rc-actionbar, .rc-modal-bg')) ? hp : (await gp.$('.rc-actionbar, .rc-modal-bg')) ? gp : null;
  if (!page) { await sleep(120); continue; }
  if (!shotMid && turns > 10) { // 途中の見た目（手元・割引が貯まった頃）
    await page.setViewportSize({ width: 1000, height: 900 }); await sleep(250);
    await page.screenshot({ path: path.join(OUT, 'recipe-mid-1000.png') }); shotMid = true;
    console.log('  📸 recipe-mid-1000');
    await page.setViewportSize({ width: 1280, height: 860 }); await sleep(150);
  }
  try { await act(page); } catch (e) { /* 再描画との競合は無視して次へ */ }
  await sleep(150);
}
console.log('ターン数:', turns, '/ over:', !!(await hp.$('.rc-over')));

async function shot(page, name, w, h = 900) { await page.setViewportSize({ width: w, height: h }); await sleep(350); await page.screenshot({ path: path.join(OUT, `${name}.png`) }); console.log('  📸', name); }
for (const w of [1280, 1000, 390]) await shot(hp, `recipe-${w}`, w, w === 390 ? 820 : 900);

await hp.setViewportSize({ width: 390, height: 820 }); await sleep(250);
const ov = await hp.evaluate(() => ({ sw: document.documentElement.scrollWidth, cw: document.documentElement.clientWidth }));
console.log('390px:', ov, ov.sw <= ov.cw + 1 ? 'OK（横スクロールなし）' : '❌ 横スクロールあり');

await browser.close();
console.log('\nJSエラー:', errors.length ? errors : 'なし');
process.exit(errors.length ? 1 : 0);
