// =============================================================
//  ダイス領土戦の地図生成（純粋関数）
//  六角形マス（pointy-top、奇数行を右にずらす odd-r 配置）を集めて領土を作る。
//    generateMap({ regions, players, rng }) → { width, height, grid, regions }
//  rng は 0以上1未満を返す関数（テストで再現できるよう注入する）。
//  grid は長さ width*height の配列（値は領土番号、海は -1）。
//  region = { id, cells, neighbors, center }
// =============================================================

// odd-r（奇数行を右にずらす）での隣接方向の差分 [dcol, drow]
const EVEN = [[+1, 0], [0, -1], [-1, -1], [-1, 0], [-1, +1], [0, +1]];
const ODD = [[+1, 0], [+1, -1], [0, -1], [-1, 0], [0, +1], [+1, +1]];

function neighborCells(cell, width, height) {
  const col = cell % width;
  const row = (cell / width) | 0;
  const diffs = (row & 1) ? ODD : EVEN;
  const out = [];
  for (const [dc, dr] of diffs) {
    const c = col + dc, r = row + dr;
    if (c >= 0 && c < width && r >= 0 && r < height) out.push(r * width + c);
  }
  return out;
}

// odd-r オフセット → キューブ座標（距離計算用）
function cube(cell, width) {
  const col = cell % width, row = (cell / width) | 0;
  const x = col - ((row - (row & 1)) / 2);
  const z = row;
  return [x, -x - z, z];
}
function hexDist(a, b, width) {
  const ca = cube(a, width), cb = cube(b, width);
  return (Math.abs(ca[0] - cb[0]) + Math.abs(ca[1] - cb[1]) + Math.abs(ca[2] - cb[2])) / 2;
}

// ラベルを置くマス（領土の重心にいちばん近いマス）。pointy-top のピクセル座標で計算
function pixel(cell, width) {
  const col = cell % width, row = (cell / width) | 0;
  return [Math.sqrt(3) * (col + 0.5 * (row & 1)), 1.5 * row];
}
function centerOf(cells, width) {
  let sx = 0, sy = 0;
  for (const c of cells) { const [x, y] = pixel(c, width); sx += x; sy += y; }
  const cx = sx / cells.length, cy = sy / cells.length;
  let best = cells[0], bd = Infinity;
  for (const c of cells) {
    const [x, y] = pixel(c, width);
    const d = (x - cx) ** 2 + (y - cy) ** 2;
    if (d < bd) { bd = d; best = c; }
  }
  return best;
}

function shuffleArr(arr, rand) {
  for (let i = arr.length - 1; i > 0; i--) {
    const j = Math.floor(rand() * (i + 1));
    [arr[i], arr[j]] = [arr[j], arr[i]];
  }
  return arr;
}

function pickDims(regionCount) {
  if (regionCount <= 20) return { width: 18, height: 14 };
  if (regionCount <= 30) return { width: 22, height: 17 };
  return { width: 26, height: 20 };
}

// 種マスを配る（互いに minD 以上離す。足りなければ距離をゆるめる）
function placeSeeds(width, height, count, rand) {
  const all = Array.from({ length: width * height }, (_, i) => i);
  for (const minD of [3, 2, 1]) {
    const seeds = [];
    for (const cell of shuffleArr(all.slice(), rand)) {
      if (seeds.every(s => hexDist(s, cell, width) >= minD)) {
        seeds.push(cell);
        if (seeds.length === count) return seeds;
      }
    }
  }
  return [];
}

function buildRegions(grid, width, height, regionCount) {
  const cells = Array.from({ length: regionCount }, () => []);
  for (let i = 0; i < grid.length; i++) if (grid[i] >= 0) cells[grid[i]].push(i);
  const neighbors = Array.from({ length: regionCount }, () => new Set());
  for (let i = 0; i < grid.length; i++) {
    const ri = grid[i];
    if (ri < 0) continue;
    for (const nb of neighborCells(i, width, height)) {
      const rj = grid[nb];
      if (rj >= 0 && rj !== ri) neighbors[ri].add(rj);
    }
  }
  return cells.map((cs, id) => ({
    id,
    cells: cs,
    neighbors: [...neighbors[id]].sort((a, b) => a - b),
    center: cs.length ? centerOf(cs, width) : -1,
  }));
}

// 1回の地図生成（検証はしない）
function tryBuild(dims, regionCount, rand) {
  const { width, height } = dims;
  const N = width * height;
  const grid = new Array(N).fill(-1);
  const seeds = placeSeeds(width, height, regionCount, rand);
  if (seeds.length < regionCount) return null;

  const cells = seeds.map(s => [s]);
  const targets = seeds.map(() => 10 + Math.floor(rand() * 7)); // 10〜16
  const frontier = seeds.map(() => []);
  for (let i = 0; i < regionCount; i++) {
    grid[seeds[i]] = i;
    for (const nb of neighborCells(seeds[i], width, height)) if (grid[nb] === -1) frontier[i].push(nb);
  }

  // 種から1マスずつ、空きマスへ順番に広げる
  let growing = true;
  while (growing) {
    growing = false;
    for (const ri of shuffleArr(Array.from({ length: regionCount }, (_, i) => i), rand)) {
      if (cells[ri].length >= targets[ri]) continue;
      const f = frontier[ri];
      let placed = false;
      while (f.length && !placed) {
        const idx = Math.floor(rand() * f.length);
        const cell = f[idx];
        f[idx] = f[f.length - 1]; f.pop();
        if (grid[cell] !== -1) continue;
        grid[cell] = ri;
        cells[ri].push(cell);
        for (const nb of neighborCells(cell, width, height)) if (grid[nb] === -1) f.push(nb);
        placed = true;
      }
      if (placed) growing = true;
    }
  }

  return { width, height, grid, regions: buildRegions(grid, width, height, regionCount) };
}

// 領土のマスが（マス隣接で）1つにつながっているか
function cellsConnected(cells, width, height) {
  if (cells.length <= 1) return true;
  const set = new Set(cells);
  const seen = new Set([cells[0]]);
  const stack = [cells[0]];
  while (stack.length) {
    const c = stack.pop();
    for (const nb of neighborCells(c, width, height)) {
      if (set.has(nb) && !seen.has(nb)) { seen.add(nb); stack.push(nb); }
    }
  }
  return seen.size === cells.length;
}

// 領土グラフ（neighbors）が1つにつながっているか（海を挟んだ孤島を作らない）
function regionsConnected(regions) {
  if (regions.length <= 1) return true;
  const seen = new Set([0]);
  const stack = [0];
  while (stack.length) {
    const r = stack.pop();
    for (const nb of regions[r].neighbors) if (!seen.has(nb)) { seen.add(nb); stack.push(nb); }
  }
  return seen.size === regions.length;
}

function validate(m, loose) {
  const minCells = loose ? 4 : 5;
  const minAvg = loose ? 2.2 : 2.5;
  for (const r of m.regions) {
    if (r.cells.length < minCells) return false;
    if (!cellsConnected(r.cells, m.width, m.height)) return false;
    if (r.neighbors.length < 1) return false;
  }
  if (!regionsConnected(m.regions)) return false;
  const avg = m.regions.reduce((s, r) => s + r.neighbors.length, 0) / m.regions.length;
  if (avg < minAvg) return false;
  return true;
}

function generateMap({ regions, players, rng } = {}) {
  const regionCount = regions;
  const rand = typeof rng === 'function' ? rng : Math.random;
  const dims = pickDims(regionCount);

  // まずは厳しい条件で（最大200回）、だめなら条件を少しゆるめてさらに200回
  for (const loose of [false, true]) {
    for (let attempt = 0; attempt < 200; attempt++) {
      const m = tryBuild(dims, regionCount, rand);
      if (m && validate(m, loose)) return m;
    }
  }
  // 最後の手段（ここに来ることはほぼない）
  let m = tryBuild(dims, regionCount, rand);
  while (!m) m = tryBuild(dims, regionCount, rand);
  return m;
}

module.exports = { generateMap, neighborCells, cellsConnected, regionsConnected, validate };
