// =============================================================
//  クライアント読み込みのスモークテスト
//  実サーバーを立て、/ と /app.js から import をたどって、読み込まれる
//  すべての JS ファイルが「200・Content-Type が JavaScript・ESM として
//  構文エラーなく読める」ことを確かめる。/api/games が4ゲーム以上も確認する。
//  （/lib/reactions.js の 404 などで app.js 全体が止まる事故の再発防止）
//  実行:  node test/client.smoke.js   または   npm test
// =============================================================
const assert = require('assert');
const http = require('http');
const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const { execFileSync } = require('child_process');

const PORT = 3598;
process.env.PORT = String(PORT);
require('../server.js'); // サーバーを同一プロセスで起動
const BASE = `http://localhost:${PORT}`;

function get(p) {
  return new Promise((resolve, reject) => {
    http.get(BASE + p, res => {
      let body = '';
      res.setEncoding('utf8');
      res.on('data', c => (body += c));
      res.on('end', () => resolve({ status: res.statusCode, type: res.headers['content-type'] || '', body }));
    }).on('error', reject);
  });
}

// import / export-from の指定子を抜き出す（static・bare・dynamic）
function extractImports(code) {
  const specs = new Set();
  const patterns = [
    /\bimport\b[^'"()]*?\bfrom\s*['"]([^'"]+)['"]/g, // import x from '...'
    /\bexport\b[^'"()]*?\bfrom\s*['"]([^'"]+)['"]/g, // export x from '...'
    /\bimport\s*['"]([^'"]+)['"]/g,                   // import '...'（副作用）
    /\bimport\s*\(\s*['"]([^'"]+)['"]\s*\)/g,         // import('...')（動的・文字列リテラルのみ）
  ];
  for (const re of patterns) {
    let m;
    while ((m = re.exec(code))) specs.add(m[1]);
  }
  return [...specs];
}

// 指定子を同一オリジンのパスに解決する（外部URL・テンプレート変数は追わない）
function resolveSpec(fromPath, spec) {
  if (spec.startsWith('/')) return spec;
  if (spec.startsWith('./') || spec.startsWith('../')) {
    const dir = fromPath.slice(0, fromPath.lastIndexOf('/'));
    return new URL(spec, 'http://x' + dir + '/').pathname;
  }
  return null; // http(s):// や bare 指定子は対象外
}

// ESM として構文エラーなく読めること（一時ファイルに保存して node --check）
function checkEsm(p, code) {
  const tmp = path.join(os.tmpdir(), `smoke-${crypto.randomUUID()}.mjs`);
  fs.writeFileSync(tmp, code);
  try {
    execFileSync(process.execPath, ['--check', tmp]);
  } catch (e) {
    throw new Error(`${p} が ESM として構文エラー: ${e.stderr ? e.stderr.toString() : e.message}`);
  } finally {
    fs.unlinkSync(tmp);
  }
}

async function main() {
  console.log('クライアント読み込みスモークテスト開始…');

  // エントリ：index.html の <script type="module"> を集める
  const index = await get('/');
  assert.strictEqual(index.status, 200, '/ が 200 を返さない');
  const entries = [...index.body.matchAll(/<script[^>]*\btype=["']module["'][^>]*\bsrc=["']([^"']+)["']/g)].map(m => m[1]);
  assert(entries.includes('/app.js'), 'index.html に /app.js の module script がない');

  // import グラフを BFS でたどる
  const seen = new Set();
  const queue = [...entries];
  while (queue.length) {
    const p = queue.shift();
    if (seen.has(p)) continue;
    seen.add(p);
    const r = await get(p);
    assert.strictEqual(r.status, 200, `${p} が 200 を返さない（${r.status}）`);
    assert(/javascript/i.test(r.type), `${p} の Content-Type が JavaScript でない（${r.type}）`);
    checkEsm(p, r.body);
    for (const spec of extractImports(r.body)) {
      const resolved = resolveSpec(p, spec);
      if (resolved && !seen.has(resolved)) queue.push(resolved);
    }
    console.log(`  ✓ ${p}  [${r.type.split(';')[0]}]`);
  }

  // 主要モジュールが import グラフから外れていないこと（reactions の 404 事故の再発防止）
  for (const must of ['/app.js', '/chat.js', '/lib/reactions.js', '/lib/sound.js']) {
    assert(seen.has(must), `${must} が import グラフからたどれていない`);
  }

  // /api/games が4ゲーム以上
  const api = await get('/api/games');
  assert.strictEqual(api.status, 200, '/api/games が 200 を返さない');
  const games = JSON.parse(api.body);
  assert(Array.isArray(games) && games.length >= 4, `ゲーム数が4未満（${games.length}）`);

  console.log(`\n✅ クライアント ${seen.size} ファイル・/api/games ${games.length}件 OK`);
}

main()
  .then(() => process.exit(0))
  .catch(err => { console.error('\n❌ 失敗:', err.message); process.exit(1); });
