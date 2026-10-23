// ダイス領土戦の画面（地図・操作・攻撃/補充の演出）
import { timerHTML } from '/lib/timer.js';

// ルール（基盤がルールパネル／ボトムシートに表示する）
export const rules = `<ul>
  <li>自分の番は、となりの他人（中立も）の領土へ何回でも攻撃できる（攻撃元はダイス2個以上）</li>
  <li>攻撃元と攻撃先のダイスを全部振り、合計が大きい方が勝ち。<strong>同点は防御側の勝ち</strong></li>
  <li>勝つと占領して、攻撃元のダイスを1個残して攻撃先へ移す。負けると攻撃元は1個になる</li>
  <li>ターン終了で、<strong>つながった最大のかたまりの数</strong>だけダイスを補充（8個まで・余りは持ち越し）</li>
  <li>領土が0になると脱落。最後の1人が勝ち</li>
</ul>`;

// odd-r（奇数行を右にずらす）の隣接方向
const EVEN = [[+1, 0], [0, -1], [-1, -1], [-1, 0], [-1, +1], [0, +1]];
const ODD = [[+1, 0], [+1, -1], [0, -1], [-1, 0], [0, +1], [+1, +1]];
const S = 10;

const cx = (col, row) => S * Math.sqrt(3) * (col + 0.5 * (row & 1));
const cy = row => S * 1.5 * row;
function corners(col, row) {
  const x = cx(col, row), y = cy(row);
  const pts = [];
  for (let i = 0; i < 6; i++) { const a = Math.PI / 180 * (60 * i - 30); pts.push([x + S * Math.cos(a), y + S * Math.sin(a)]); }
  return pts;
}
const cellXY = (cell, width) => [cx(cell % width, (cell / width) | 0), cy((cell / width) | 0)];

// ダイスの目（3×3 のどこに点を置くか）
const PIPS = { 1: [4], 2: [0, 8], 3: [0, 4, 8], 4: [0, 2, 6, 8], 5: [0, 2, 4, 6, 8], 6: [0, 2, 3, 5, 6, 8] };
function dieHTML(n) {
  const set = new Set(PIPS[n] || []);
  let c = '';
  for (let i = 0; i < 9; i++) c += `<i class="${set.has(i) ? 'on' : ''}"></i>`;
  return `<span class="dw-die">${c}</span>`;
}
const rollDice = k => Array.from({ length: k }, () => dieHTML(1 + Math.floor(Math.random() * 6))).join('');

// ---- ローカル状態 ----
let last = null;
let selectedFrom = null;
let busy = false;
let infoRegion = null;
let stateKey = null;
// 攻撃演出
let animData = null, animPrev = null, animPhase = null, animSeq = null;
let animTimers = [], rollInterval = null;
// 補充演出
let reinforce = null, reinforceTimer = null;

const reduceMotion = () => typeof window !== 'undefined' && window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches;

function cancelAnim() {
  for (const t of animTimers) clearTimeout(t);
  animTimers = [];
  if (rollInterval) { clearInterval(rollInterval); rollInterval = null; }
  animData = animPrev = animPhase = animSeq = null;
}

// app.js からのサーバー更新のたびに呼ばれる（内部の再描画は paint() を直接呼ぶ）
export function render(root, v, ctx) {
  last = { root, v, ctx };
  busy = false;
  // 演出中に新しい更新が来たら、すぐ最新へ
  if (animSeq != null && !(v.lastAttack && v.lastAttack.seq === animSeq)) cancelAnim();
  const prev = ctx.prev;
  const la = v.lastAttack;
  const newAttack = la && prev && (!prev.lastAttack || prev.lastAttack.seq !== la.seq);
  if (newAttack && animSeq !== la.seq) { beginAttack(v, ctx, prev); return; }

  // 補充の +n 表示
  const lr = v.lastReinforce;
  if (lr && prev && (!prev.lastReinforce || prev.lastReinforce.seq !== lr.seq)) {
    reinforce = { seq: lr.seq, added: lr.added || {} };
    ctx.sound('ready');
    clearTimeout(reinforceTimer);
    reinforceTimer = setTimeout(() => { reinforce = null; paint(); }, 1000);
  }
  // 攻撃以外で決着（退席・打ち切り）
  if (prev && prev.phase !== 'over' && v.phase === 'over' && !newAttack) ctx.sound('win');

  paint();
}

function beginAttack(v, ctx, prev) {
  cancelAnim();
  animSeq = v.lastAttack.seq; animData = v.lastAttack; animPrev = prev; animPhase = 'roll';
  selectedFrom = null;
  ctx.sound('dice');
  paint();

  const reveal = () => {
    if (rollInterval) { clearInterval(rollInterval); rollInterval = null; }
    animPhase = 'reveal';
    ctx.sound(animData.success ? 'trick' : 'penalty');
    if (v.players.some((p, i) => p.out && prev.players[i] && !prev.players[i].out)) setTimeout(() => ctx.sound('cucumber'), 140);
    if (prev.phase !== 'over' && v.phase === 'over') setTimeout(() => ctx.sound('win'), 220);
    paint(); // ここで地図を新しい状態に更新
    animTimers.push(setTimeout(() => { cancelAnim(); paint(); }, 1500));
  };

  if (reduceMotion()) { reveal(); return; }
  rollInterval = setInterval(() => {
    const a = last.root.querySelector('.dw-aroll'), d = last.root.querySelector('.dw-droll');
    if (a) a.innerHTML = rollDice(animData.aRolls.length);
    if (d) d.innerHTML = rollDice(animData.dRolls.length);
  }, 90);
  animTimers.push(setTimeout(reveal, 600));
}

function paint() {
  const { root, v, ctx } = last;
  const { esc } = ctx;
  const animating = animData != null;
  const dv = (animPhase === 'roll' && animPrev) ? animPrev : v; // roll 中は前の地図

  const mySeat = v.players.findIndex(p => p.id === ctx.me);
  const isPlayer = ctx.role === 'player';
  const myTurn = isPlayer && v.phase === 'play' && v.currentId === ctx.me && !animating;
  const name = id => esc((v.players.find(p => p.id === id) || {}).name || '?');

  const key = `${v.round}|${v.currentId}|${v.phase}`;
  if (stateKey !== key) { selectedFrom = null; stateKey = key; }
  if (!myTurn) selectedFrom = null;

  const seatColor = dv.players.map(p => p.color);
  const ownerColor = oid => (oid < 0 ? null : seatColor[oid]);
  const canAttackFrom = rid => dv.owner[rid] === mySeat && dv.dice[rid] >= 2
    && dv.map.regions[rid].neighbors.some(nb => dv.owner[nb] !== mySeat);
  const isTarget = rid => selectedFrom != null
    && dv.map.regions[selectedFrom].neighbors.includes(rid) && dv.owner[rid] !== mySeat;

  const arrow = animating ? {
    from: dv.map.regions[animData.from].center,
    to: dv.map.regions[animData.to].center,
    color: seatColor[animData.attacker] || '#fff',
  } : null;

  const svg = buildMap(dv, { mySeat, myTurn, selectedFrom, canAttackFrom, isTarget, ownerColor, arrow, reinforce });

  let small, big;
  if (v.phase === 'over') {
    small = '決着';
    big = v.winnerId == null ? '引き分け' : (v.winnerId === ctx.me ? 'あなたの勝ち！' : `${name(v.winnerId)} さんの勝ち！`);
  } else if (animating) {
    small = '戦闘中';
    big = 'ダイス勝負！';
  } else if (myTurn) {
    small = `あなたの番（${v.round}周目）`;
    big = selectedFrom == null ? '攻撃元を選ぶか、ターン終了' : '攻撃先を選ぶ（もう一度タップで解除）';
  } else {
    small = `${v.round}周目`;
    big = `${name(v.currentId)} さんの番`;
  }

  let info = '';
  if (infoRegion != null && dv.owner[infoRegion] !== undefined) {
    const oid = dv.owner[infoRegion];
    info = `領土 ${infoRegion}：${oid < 0 ? '中立' : name(v.players[oid].id)}・ダイス ${dv.dice[infoRegion]}個`;
  }

  const showTimer = v.phase === 'play' && v.deadline != null && !animating;
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
          ${animating ? attackPanel(v, ctx) : ''}
          <div class="dw-info">${esc(info)}</div>
          ${controls}
        </div>
      </div>
      <div class="g-side">${sideHTML(v, ctx)}</div>
    </div>`;

  wire(root, v, ctx, { mySeat, myTurn, canAttackFrom, animating });
}

// ---- 地図（SVG） ----
function buildMap(v, o) {
  const { width, height, grid } = v.map;
  const cells = [], borders = [], overlays = [], labels = [];
  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;

  for (let i = 0; i < grid.length; i++) {
    const rid = grid[i];
    if (rid < 0) continue;
    const col = i % width, row = (i / width) | 0;
    const cs = corners(col, row);
    for (const [x, y] of cs) { if (x < minX) minX = x; if (x > maxX) maxX = x; if (y < minY) minY = y; if (y > maxY) maxY = y; }
    const pts = cs.map(p => `${p[0].toFixed(1)},${p[1].toFixed(1)}`).join(' ');
    const oid = v.owner[rid];
    const fill = oid < 0 ? 'url(#dw-neutral)' : o.ownerColor(oid);
    cells.push(`<polygon points="${pts}" fill="${fill}" class="dw-cell" data-region="${rid}"/>`);

    let cls = null;
    if (o.selectedFrom === rid) cls = 'dw-sel';
    else if (o.isTarget(rid)) cls = 'dw-target';
    else if (o.selectedFrom == null && o.myTurn && o.canAttackFrom(rid)) cls = 'dw-can';
    if (cls) overlays.push(`<polygon points="${pts}" class="dw-ov ${cls}"/>`);

    const diffs = (row & 1) ? ODD : EVEN;
    for (const [dc, dr] of diffs) {
      const nc = col + dc, nr = row + dr;
      const inside = nc >= 0 && nc < width && nr >= 0 && nr < height;
      const rNb = inside ? grid[nr * width + nc] : -1;
      if (rNb === rid) continue;
      const bx = cx(nc, nr), by = cy(nr);
      const srt = cs.slice().sort((a, b) => ((a[0] - bx) ** 2 + (a[1] - by) ** 2) - ((b[0] - bx) ** 2 + (b[1] - by) ** 2));
      borders.push(`<line x1="${srt[0][0].toFixed(1)}" y1="${srt[0][1].toFixed(1)}" x2="${srt[1][0].toFixed(1)}" y2="${srt[1][1].toFixed(1)}" class="dw-border"/>`);
    }
  }

  for (const r of v.map.regions) {
    if (r.center < 0) continue;
    const [x, y] = cellXY(r.center, width);
    const oid = v.owner[r.id];
    const dice = v.dice[r.id];
    const plus = o.reinforce && o.reinforce.added[r.id];
    labels.push(`<g class="dw-label${dice >= 8 ? ' dw-max' : ''}" transform="translate(${x.toFixed(1)},${y.toFixed(1)})">
      <circle r="${S * 0.72}" class="dw-label-bg"/>
      <text class="dw-label-num" dy="0.34em">${dice}</text>
      ${oid >= 0 ? `<text class="dw-label-owner" x="${-S * 0.7}" y="${-S * 0.55}">${oid + 1}</text>` : ''}
      ${plus ? `<text class="dw-plus" y="${-S * 0.95}">+${plus}</text>` : ''}
    </g>`);
  }

  let arrowSvg = '';
  if (o.arrow && o.arrow.from >= 0 && o.arrow.to >= 0) {
    const [x1, y1] = cellXY(o.arrow.from, width);
    const [x2, y2] = cellXY(o.arrow.to, width);
    arrowSvg = `<line x1="${x1.toFixed(1)}" y1="${y1.toFixed(1)}" x2="${x2.toFixed(1)}" y2="${y2.toFixed(1)}"
      class="dw-arrow" stroke="${o.arrow.color}" marker-end="url(#dw-arrowhead)"/>`;
  }

  const pad = S;
  const vb = `${(minX - pad).toFixed(1)} ${(minY - pad).toFixed(1)} ${(maxX - minX + pad * 2).toFixed(1)} ${(maxY - minY + pad * 2).toFixed(1)}`;
  return `<svg class="dw-map" viewBox="${vb}" preserveAspectRatio="xMidYMid meet" role="img" aria-label="領土の地図">
    <defs>
      <pattern id="dw-neutral" width="6" height="6" patternUnits="userSpaceOnUse" patternTransform="rotate(45)">
        <rect width="6" height="6" fill="#e9dcc0"/><line x1="0" y1="0" x2="0" y2="6" stroke="#cbb68c" stroke-width="2"/>
      </pattern>
      <marker id="dw-arrowhead" markerWidth="5" markerHeight="5" refX="3.5" refY="2.5" orient="auto">
        <path d="M0,0 L5,2.5 L0,5 Z" fill="context-stroke"/>
      </marker>
    </defs>
    <g class="dw-cells">${cells.join('')}</g>
    <g class="dw-borders">${borders.join('')}</g>
    <g class="dw-overlays">${overlays.join('')}</g>
    <g class="dw-labels">${labels.join('')}</g>
    ${arrowSvg}
  </svg>`;
}

// ---- 攻撃の結果パネル ----
function attackPanel(v, ctx) {
  const { esc } = ctx;
  const la = animData;
  const player = id => v.players.find(p => p.id === id);
  const atk = player(la.attackerId) || { name: '?', color: '#999' };
  const def = la.defenderId == null ? { name: '中立', color: '#cbb68c' } : (player(la.defenderId) || { name: '?', color: '#999' });
  const reveal = animPhase === 'reveal';
  const aDice = reveal ? la.aRolls.map(dieHTML).join('') : rollDice(la.aRolls.length);
  const dDice = reveal ? la.dRolls.map(dieHTML).join('') : rollDice(la.dRolls.length);
  const result = reveal
    ? (la.success
      ? `<div class="dw-res win" style="color:${esc(atk.color)}">占領！</div>`
      : '<div class="dw-res">防衛成功</div>')
    : '';
  return `
    <div class="dw-attack paper ${reveal ? 'reveal' : 'roll'}">
      <div class="dw-attack-row">
        <span class="dw-chip" style="background:${esc(atk.color)}"></span>
        <span class="dw-attack-name">${esc(atk.name)}</span>
        <span class="dw-dice dw-aroll">${aDice}</span>
        <span class="dw-sum">${reveal ? la.aSum : ''}</span>
      </div>
      <div class="dw-vs">VS</div>
      <div class="dw-attack-row">
        <span class="dw-chip" style="background:${esc(def.color)}"></span>
        <span class="dw-attack-name">${esc(def.name)}</span>
        <span class="dw-dice dw-droll">${dDice}</span>
        <span class="dw-sum">${reveal ? la.dSum : ''}</span>
      </div>
      ${result}
    </div>`;
}

// ---- 右側 ----
function sideHTML(v, ctx) {
  const { esc } = ctx;
  const rows = v.players.slice().sort((a, b) => ((a.left || a.out) - (b.left || b.out)) || (b.regions - a.regions));
  const list = rows.map(p => `
    <div class="dw-pl ${p.id === v.currentId ? 'current' : ''} ${(p.out || p.left) ? 'out' : ''} ${p.id === ctx.me ? 'me' : ''}">
      <span class="dw-pl-chip" style="background:${esc(p.color)}"></span>
      <span class="dw-pl-name">${esc(p.name)}${p.left ? '（退席）' : p.out ? '（脱落）' : ''}</span>
      <span class="dw-pl-stat">${p.regions}領土・🎲${p.totalDice}<span class="dw-pl-sub"> 次+${p.largest}${p.stock ? `・持${p.stock}` : ''}</span></span>
    </div>`).join('');
  return `
    <div class="dw-players">
      <h3>プレイヤー（${v.round}周目）</h3>
      ${list}
    </div>
    <ul class="log">${v.log.slice().reverse().slice(0, 10).map(l => `<li>${esc(l)}</li>`).join('')}</ul>`;
}

// ---- 操作 ----
function wire(root, v, ctx, { mySeat, myTurn, canAttackFrom, animating }) {
  const end = root.querySelector('.dw-end');
  if (end) end.onclick = () => { end.disabled = true; ctx.send({ type: 'endTurn' }); };

  const svg = root.querySelector('.dw-map');
  const wrap = root.querySelector('.dw-map-wrap');
  if (!svg) return;

  const tapRegion = rid => {
    infoRegion = rid;
    if (!myTurn || busy || animating) { paint(); return; }
    if (selectedFrom == null) { if (canAttackFrom(rid)) selectedFrom = rid; paint(); return; }
    if (rid === selectedFrom) { selectedFrom = null; paint(); return; }
    if (v.map.regions[selectedFrom].neighbors.includes(rid) && v.owner[rid] !== mySeat) {
      busy = true;
      const from = selectedFrom;
      selectedFrom = null;
      paint();
      ctx.send({ type: 'attack', from, to: rid });
      return;
    }
    selectedFrom = canAttackFrom(rid) ? rid : null;
    paint();
  };

  svg.addEventListener('click', e => {
    const poly = e.target.closest('[data-region]');
    if (poly) { tapRegion(Number(poly.dataset.region)); e.stopPropagation(); }
  });
  if (wrap) wrap.addEventListener('click', e => {
    if (e.target.closest('[data-region]')) return;
    if (selectedFrom != null) { selectedFrom = null; paint(); }
  });
}
