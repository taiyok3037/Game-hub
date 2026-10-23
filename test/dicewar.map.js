// =============================================================
//  ダイス領土戦 地図生成のテスト
//  小・中・大 × 各3000回、3章の検証条件をすべて満たすこと。
//  grid の領土番号と regions[].cells が一致し、隣接が対称であることも確かめる。
//  実行:  npm test   または   node test/dicewar.map.js
// =============================================================
const assert = require('assert');
const { generateMap, neighborCells, cellsConnected, regionsConnected } = require('../games/dicewar/map.js');

const COUNT = 3000;
const SIZES = [{ name: '小', regions: 20 }, { name: '中', regions: 30 }, { name: '大', regions: 40 }];

// 再現用の簡易乱数
function makeRng(seed) {
  let s = seed >>> 0;
  return () => { s ^= s << 13; s ^= s >>> 17; s ^= s << 5; return ((s >>> 0) % 1000000) / 1000000; };
}

function checkMap(m, regionCount) {
  assert(m && m.width > 0 && m.height > 0, '地図が空');
  assert.strictEqual(m.grid.length, m.width * m.height, 'grid の長さが width*height でない');
  assert.strictEqual(m.regions.length, regionCount, `領土数が ${regionCount} でない: ${m.regions.length}`);

  // grid の領土番号と regions[].cells が一致する
  const fromGrid = Array.from({ length: regionCount }, () => []);
  for (let i = 0; i < m.grid.length; i++) {
    const r = m.grid[i];
    assert(r === -1 || (r >= 0 && r < regionCount), `grid の値が不正: ${r}`);
    if (r >= 0) fromGrid[r].push(i);
  }
  for (const r of m.regions) {
    const a = r.cells.slice().sort((x, y) => x - y);
    const b = fromGrid[r.id].slice().sort((x, y) => x - y);
    assert.deepStrictEqual(a, b, `region ${r.id} の cells が grid と一致しない`);
  }

  // 3章の検証条件
  for (const r of m.regions) {
    assert(r.cells.length >= 4, `領土 ${r.id} が小さすぎる: ${r.cells.length}`); // ゆるめ条件（最低4）
    assert(cellsConnected(r.cells, m.width, m.height), `領土 ${r.id} のマスがつながっていない`);
    assert(r.neighbors.length >= 1, `領土 ${r.id} の隣接が0`);
    assert(r.cells.includes(r.center), `領土 ${r.id} の center が自分のマスでない`);
  }
  assert(regionsConnected(m.regions), '領土が1つにつながっていない（孤島あり）');
  const avg = m.regions.reduce((s, r) => s + r.neighbors.length, 0) / m.regions.length;
  assert(avg >= 2.2, `隣接数の平均が低い: ${avg.toFixed(2)}`);

  // 隣接が対称
  for (const r of m.regions) {
    for (const nb of r.neighbors) {
      assert(m.regions[nb].neighbors.includes(r.id), `隣接が非対称: ${r.id}-${nb}`);
    }
  }

  // grid の隣接から導いた隣接と regions[].neighbors が一致する
  for (const r of m.regions) {
    const set = new Set();
    for (const cell of r.cells) {
      for (const nb of neighborCells(cell, m.width, m.height)) {
        const rj = m.grid[nb];
        if (rj >= 0 && rj !== r.id) set.add(rj);
      }
    }
    assert.deepStrictEqual(r.neighbors.slice().sort((a, b) => a - b), [...set].sort((a, b) => a - b),
      `region ${r.id} の neighbors が grid と一致しない`);
  }
}

console.log('ダイス領土戦 地図テスト開始…');
const t0 = Date.now();
let seed = 1;
for (const size of SIZES) {
  for (let i = 0; i < COUNT; i++) {
    const m = generateMap({ regions: size.regions, players: 2 + (i % 5), rng: makeRng(seed++) });
    checkMap(m, size.regions);
  }
  console.log(`  ${size.name}（約${size.regions}）× ${COUNT} OK`);
}
console.log(`\n✅ 全 ${COUNT * SIZES.length} 地図 通過（${Date.now() - t0}ms）`);
