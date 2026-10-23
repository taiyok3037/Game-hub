// ダイス領土戦の画面（地図の描画と操作）
import { timerHTML } from '/lib/timer.js';

// odd-r（奇数行を右にずらす）の隣接方向
const EVEN = [[+1, 0], [0, -1], [-1, -1], [-1, 0], [-1, +1], [0, +1]];
const ODD = [[+1, 0], [+1, -1], [0, -1], [-1, 0], [0, +1], [+1, +1]];
const S = 10; // 六角形の大きさ（SVG 単位）

const cx = (col, row) => S * Math.sqrt(3) * (col + 0.5 * (row & 1));
const cy = row => S * 1.5 * row;
function corners(col, row) {
  const x = cx(col, row), y = cy(row);
  const pts = [];
  for (let i = 0; i < 6; i++) {
    const a = Math.PI / 180 * (60 * i - 30);
    pts.push([x + S * Math.cos(a), y + S * Math.sin(a)]);
  }
  return pts;
}

// ---- 操作のローカル状態 ----
let last = null;
let selectedFrom = null;
let busy = false;       // 攻撃の結果待ち（二重送信の防止）
let infoRegion = null;  // タップで情報を見ている領土
let stateKey = null;

function rerender() { if (last) render(last.root, last.v, last.ctx); }

export function render(root, v, ctx) {
  last = { root, v, ctx };
  busy = false; // サーバー更新が来たので結果待ちを解除
  const { esc } = ctx;
  const mySeat = v.players.findIndex(p => p.id === ctx.me);
  const isPlayer = ctx.role === 'player';
  const myTurn = isPlayer && v.phase === 'play' && v.currentId === ctx.me;
  const name = id => esc((v.players.find(p => p.id === id) || {}).name || '?');

  // 手番・ラウンドが変わったら選択を解除
  const key = `${v.round}|${v.currentId}|${v.phase}`;
  if (stateKey !== key) { selectedFrom = null; stateKey = key; }
  if (!myTurn) selectedFrom = null;

  const seatColor = v.players.map(p => p.color);
  const ownerColor = oid => (oid < 0 ? null : seatColor[oid]);

  // 攻撃できる自分の領土（ダイス2個以上で、攻撃できる隣がある）
  const canAttackFrom = rid => v.owner[rid] === mySeat && v.dice[rid] >= 2
    && v.map.regions[rid].neighbors.some(nb => v.owner[nb] !== mySeat);
  const isTarget = rid => selectedFrom != null
    && v.map.regions[selectedFrom].neighbors.includes(rid) && v.owner[rid] !== mySeat;

  const svg = buildMap(v, { mySeat, myTurn, selectedFrom, canAttackFrom, isTarget, ownerColor });

  // 卓のメモ
  let small, big;
  if (v.phase === 'over') {
    small = '決着';
    big = v.winnerId == null ? '引き分け' : (v.winnerId === ctx.me ? 'あなたの勝ち！' : `${name(v.winnerId)} さんの勝ち！`);
  } else if (myTurn) {
    small = `あなたの番（${v.round}周目）`;
    big = selectedFrom == null ? '攻撃元を選ぶか、ターン終了' : '攻撃先を選ぶ（もう一度タップで解除）';
  } else {
    small = `${v.round}周目`;
    big = `${name(v.currentId)} さんの番`;
  }

  // 情報表示
  let info = '';
  if (infoRegion != null && v.owner[infoRegion] !== undefined) {
    const oid = v.owner[infoRegion];
    const who = oid < 0 ? '中立' : name(v.players[oid].id);
    info = `領土 ${infoRegion}：${who}・ダイス ${v.dice[infoRegion]}個`;
  }

  const showTimer = v.phase === 'play' && v.deadline != null;
  const controls = (myTurn || showTimer) ? `
    <div class="dw-controls">
      ${myTurn ? '<button class="btn primary dw-end">ターン終了</button>' : ''}
      ${showTimer ? timerHTML(v.deadline, ctx) : ''}
    </div>` : '';

  root.innerHTML = `
    <div class="g-layout">
      <div class="g-main">
        <div class="felt">
          <div class="note ${myTurn ? '' : 'plain'}"><small>${small}</small><strong>${big}</strong></div>
          <div class="dw-map-wrap">${svg}</div>
          <div class="dw-info">${esc(info)}</div>
          ${controls}
        </div>
      </div>
      <div class="g-side">${sideHTML(v, ctx)}</div>
    </div>`;

  wire(root, v, ctx, { mySeat, myTurn, canAttackFrom, isTarget });
}

// ---- 地図（SVG） ----
function buildMap(v, o) {
  const { width, height, grid } = v.map;
  const cells = [];
  const borders = [];
  const overlays = [];
  const labels = [];
  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;

  for (let i = 0; i < grid.length; i++) {
    const rid = grid[i];
    if (rid < 0) continue; // 海は描かない
    const col = i % width, row = (i / width) | 0;
    const cs = corners(col, row);
    for (const [x, y] of cs) {
      if (x < minX) minX = x; if (x > maxX) maxX = x;
      if (y < minY) minY = y; if (y > maxY) maxY = y;
    }
    const pts = cs.map(p => `${p[0].toFixed(1)},${p[1].toFixed(1)}`).join(' ');
    const oid = v.owner[rid];
    const fill = oid < 0 ? 'url(#dw-neutral)' : o.ownerColor(oid);
    cells.push(`<polygon points="${pts}" fill="${fill}" class="dw-cell" data-region="${rid}"/>`);

    // 強調オーバーレイ（タップを邪魔しないよう pointer-events:none）
    let cls = null;
    if (o.selectedFrom === rid) cls = 'dw-sel';
    else if (o.isTarget(rid)) cls = 'dw-target';
    else if (o.selectedFrom == null && o.myTurn && o.canAttackFrom(rid)) cls = 'dw-can';
    if (cls) overlays.push(`<polygon points="${pts}" class="dw-ov ${cls}"/>`);

    // 領土の境目（隣が違う領土 or 海 or 盤外の辺に太線）
    const diffs = (row & 1) ? ODD : EVEN;
    for (const [dc, dr] of diffs) {
      const nc = col + dc, nr = row + dr;
      const inside = nc >= 0 && nc < width && nr >= 0 && nr < height;
      const rNb = inside ? grid[nr * width + nc] : -1;
      if (rNb === rid) continue;
      const bx = cx(nc, nr), by = cy(nr);
      const sorted = cs.slice().sort((a, b) => ((a[0] - bx) ** 2 + (a[1] - by) ** 2) - ((b[0] - bx) ** 2 + (b[1] - by) ** 2));
      const [p1, p2] = sorted;
      borders.push(`<line x1="${p1[0].toFixed(1)}" y1="${p1[1].toFixed(1)}" x2="${p2[0].toFixed(1)}" y2="${p2[1].toFixed(1)}" class="dw-border"/>`);
    }
  }

  // ラベル（ダイス数）
  for (const r of v.map.regions) {
    if (r.center < 0) continue;
    const col = r.center % width, row = (r.center / width) | 0;
    const x = cx(col, row), y = cy(row);
    const oid = v.owner[r.id];
    const dice = v.dice[r.id];
    const ring = dice >= 8 ? ' dw-max' : '';
    labels.push(`<g class="dw-label${ring}" transform="translate(${x.toFixed(1)},${y.toFixed(1)})">
      <circle r="${S * 0.72}" class="dw-label-bg"/>
      <text class="dw-label-num" dy="0.34em">${dice}</text>
      ${oid >= 0 ? `<text class="dw-label-owner" x="${-S * 0.7}" y="${-S * 0.55}">${oid + 1}</text>` : ''}
    </g>`);
  }

  const pad = S * 0.8;
  const vb = `${(minX - pad).toFixed(1)} ${(minY - pad).toFixed(1)} ${(maxX - minX + pad * 2).toFixed(1)} ${(maxY - minY + pad * 2).toFixed(1)}`;
  return `<svg class="dw-map" viewBox="${vb}" preserveAspectRatio="xMidYMid meet" role="img" aria-label="領土の地図">
    <defs>
      <pattern id="dw-neutral" width="6" height="6" patternUnits="userSpaceOnUse" patternTransform="rotate(45)">
        <rect width="6" height="6" fill="#e9dcc0"/>
        <line x1="0" y1="0" x2="0" y2="6" stroke="#cbb68c" stroke-width="2"/>
      </pattern>
    </defs>
    <g class="dw-cells">${cells.join('')}</g>
    <g class="dw-borders">${borders.join('')}</g>
    <g class="dw-overlays">${overlays.join('')}</g>
    <g class="dw-labels">${labels.join('')}</g>
  </svg>`;
}

// ---- 右側（プレイヤー一覧・記録） ----
function sideHTML(v, ctx) {
  const { esc } = ctx;
  const rows = v.players.slice().sort((a, b) => (a.left + a.out) - (b.left + b.out) || b.regions - a.regions);
  const list = rows.map(p => `
    <div class="dw-pl ${p.id === v.currentId ? 'current' : ''} ${(p.out || p.left) ? 'out' : ''} ${p.id === ctx.me ? 'me' : ''}">
      <span class="dw-pl-chip" style="background:${esc(p.color)}"></span>
      <span class="dw-pl-name">${esc(p.name)}${p.left ? '（退席）' : p.out ? '（脱落）' : ''}</span>
      <span class="dw-pl-stat">${p.regions}領土・${p.totalDice}<span class="dw-pl-sub"> 次+${p.largest}${p.stock ? `・持${p.stock}` : ''}</span></span>
    </div>`).join('');
  return `
    <div class="dw-players">
      <h3>プレイヤー</h3>
      ${list}
    </div>
    <ul class="log">${v.log.slice().reverse().slice(0, 10).map(l => `<li>${esc(l)}</li>`).join('')}</ul>`;
}

// ---- 操作 ----
function wire(root, v, ctx, { mySeat, myTurn, canAttackFrom, isTarget }) {
  const end = root.querySelector('.dw-end');
  if (end) end.onclick = () => { end.disabled = true; ctx.send({ type: 'endTurn' }); };

  const svg = root.querySelector('.dw-map');
  const wrap = root.querySelector('.dw-map-wrap');
  if (!svg) return;

  const tapRegion = rid => {
    infoRegion = rid;
    if (!myTurn || busy) { rerender(); return; }
    if (selectedFrom == null) {
      if (canAttackFrom(rid)) selectedFrom = rid;
      rerender();
      return;
    }
    if (rid === selectedFrom) { selectedFrom = null; rerender(); return; }
    if (v.map.regions[selectedFrom].neighbors.includes(rid) && v.owner[rid] !== mySeat) {
      busy = true;
      const from = selectedFrom;
      selectedFrom = null;
      rerender();
      ctx.send({ type: 'attack', from, to: rid });
      return;
    }
    // 別の攻撃元に乗り換え／解除
    selectedFrom = canAttackFrom(rid) ? rid : null;
    rerender();
  };

  svg.addEventListener('click', e => {
    const poly = e.target.closest('[data-region]');
    if (poly) { tapRegion(Number(poly.dataset.region)); e.stopPropagation(); }
  });
  // 地図の外をタップすると選択解除
  if (wrap) wrap.addEventListener('click', e => {
    if (e.target.closest('[data-region]')) return;
    if (selectedFrom != null) { selectedFrom = null; rerender(); }
  });
}
