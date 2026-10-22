// インディアンポーカーの画面
// 自分のカードだけ裏向き（？）で、他の人のカードは表で見える。
import { cardHTML, backHTML } from '/lib/cards.js';

const LIVES = 3;

// ルール（基盤がルールパネル／ボトムシートに表示する）
export const rules = `<ul>
  <li>2〜6人・ライフ各3。強さは数字だけ（A＞K＞Q＞J＞10…＞2）、マークは無関係</li>
  <li>自分のカードだけ見えません（おでこに貼るイメージ）。他の人のは全部見えます</li>
  <li>最初の人から時計回りに「勝負」か「降りる」を宣言します</li>
  <li><strong>勝負した人は、勝負仲間の中で最大でないと −1</strong>（最大と同値はセーフ）</li>
  <li><strong>降りた人は、全員の中で最大だと −1</strong>（最大と同値も含む＝もったいない降り）</li>
  <li>ライフ0で脱落。最後の1人が勝ち（全員同時脱落はノーカウント）</li>
</ul>`;

const lifeDots = lives =>
  Array.from({ length: LIVES }, (_, i) => `<span class="ip-life ${i < lives ? 'on' : ''}"></span>`).join('');

function declBadge(p, isCurrent, phase) {
  if (p.decl === 'fight') return '<span class="ip-badge fight">勝負</span>';
  if (p.decl === 'fold') return '<span class="ip-badge fold">降り</span>';
  if (phase === 'declare' && isCurrent) return '<span class="ip-badge think">考え中…</span>';
  return '<span class="ip-badge empty"></span>';
}

export function render(root, v, ctx) {
  const { esc } = ctx;
  const name = id => esc((v.players.find(p => p.id === id) || {}).name || '?');
  const myTurn = v.phase === 'declare' && v.currentId === ctx.me;
  const justRevealed = ctx.prev && ctx.prev.phase === 'declare' && v.phase !== 'declare';

  // ---- 宣言の順番（最初の人から時計回り）に生存者を並べる ----
  const n = v.players.length;
  const starterIdx = Math.max(0, v.players.findIndex(p => p.isStarter));
  const order = [];
  for (let k = 0; k < n; k++) {
    const p = v.players[(starterIdx + k) % n];
    if (!p.out) order.push(p);
  }

  const seats = order.map(p => {
    const isMe = p.id === ctx.me;
    const isCurrent = p.id === v.currentId;
    const forehead = p.card
      ? cardHTML(p.card, { cls: isMe && justRevealed ? 'ip-flip' : '' })
      : `<div class="ip-back">${backHTML()}<span class="ip-q">？</span></div>`;
    return `
      <div class="seat ip-seat ${isCurrent ? 'turn' : ''}">
        <div class="ip-forehead">${forehead}</div>
        <span class="seat-chip">${esc(p.name)}${p.isStarter ? '<span class="ip-first">先</span>' : ''}</span>
        <span class="ip-lives" aria-label="ライフ${p.lives}">${lifeDots(p.lives)}</span>
        ${declBadge(p, isCurrent, v.phase)}
        ${isMe ? '<span class="ip-you">あなた</span>' : ''}
      </div>`;
  }).join('');

  // ---- メモ ----
  const aliveCount = v.players.filter(p => !p.out).length;
  const declared = v.players.filter(p => !p.out && p.decl !== null).length;
  const remain = aliveCount - declared;
  let small, big;
  if (v.phase === 'over') {
    small = '決着';
    big = v.winnerId === ctx.me ? 'あなたの勝ち！' : `${name(v.winnerId)} さんの勝ち！`;
  } else if (v.phase === 'reveal') {
    small = `第${v.round}ラウンド`;
    big = '結果発表';
  } else if (myTurn) {
    small = 'あなたの番';
    big = '勝負する？ 降りる？';
  } else {
    small = `あと${remain}人`;
    big = `${name(v.currentId)} さんが考え中…`;
  }

  // ---- 宣言ボタン（自分の番だけ） ----
  const declButtons = myTurn ? `
    <div class="ip-choices">
      <button class="btn primary big ip-fight">勝負</button>
      <button class="btn big ip-fold">降りる</button>
    </div>` : '';

  // ---- 結果パネル ----
  let result = '';
  if (v.result && v.phase !== 'declare') {
    const r = v.result;
    const parts = v.players.filter(p => p.card); // この回に配られた人
    const judged = p => {
      if (r.voided) return '—';
      if (r.eliminatedIds.includes(p.id)) return '脱落';
      const why = r.reasons[p.id];
      if (why === 'lost-fight') return '勝負で負け −1';
      if (why === 'wasted-fold') return '降りたけど一番強かった −1';
      return 'セーフ';
    };
    const rows = parts.map(p => `
      <div class="ip-rrow ${!r.voided && r.loserIds.includes(p.id) ? 'lost' : ''}">
        ${cardHTML(p.card, { cls: 'sm' })}
        <span class="ip-rname">${esc(p.name)}</span>
        <span class="ip-rdecl">${p.decl === 'fight' ? '勝負' : '降り'}</span>
        <span class="ip-rjudge">${judged(p)}</span>
      </div>`).join('');
    result = `
      <div class="ip-result">
        ${r.voided ? '<div class="ip-voided">全員アウトなのでノーカウント</div>' : ''}
        ${v.phase === 'over' ? `<div class="ip-winner">🏆 ${v.winnerId === ctx.me ? 'あなた' : name(v.winnerId)} さんの勝ち！</div>` : ''}
        <div class="ip-rrows">${rows}</div>
        ${v.phase === 'reveal' ? readyPanel(v, ctx, name) : ''}
      </div>`;
  }

  // ---- ライフ表（g-side） ----
  const sideRows = v.players.slice()
    .sort((a, b) => (a.out - b.out) || (b.lives - a.lives))
    .map(p => `
      <div class="ip-srow ${p.out ? 'out' : ''} ${p.id === ctx.me ? 'me' : ''}">
        <span class="ip-sname">${esc(p.name)}</span>
        <span class="ip-lives">${lifeDots(p.lives)}</span>
        <span class="ip-sstate">${p.out ? (p.left ? '退席' : '脱落') : ''}</span>
      </div>`).join('');

  root.innerHTML = `
    <div class="g-layout">
      <div class="g-main">
        <div class="felt">
          <div class="seats ip-seats">${seats}</div>
          <div class="note ${myTurn ? '' : 'plain'}"><small>${small}</small><strong>${big}</strong></div>
          ${declButtons}
          ${result}
        </div>
      </div>
      <div class="g-side">
        <div class="ip-lifetable">
          <h3>ライフ</h3>
          ${sideRows}
        </div>
        <ul class="log">${v.log.slice().reverse().slice(0, 10).map(l => `<li>${esc(l)}</li>`).join('')}</ul>
      </div>
    </div>`;

  const fight = root.querySelector('.ip-fight');
  const fold = root.querySelector('.ip-fold');
  if (fight && fold) {
    const choose = choice => {
      fight.disabled = true;
      fold.disabled = true;
      ctx.send({ type: 'declare', choice });
    };
    fight.onclick = () => choose('fight');
    fold.onclick = () => choose('fold');
  }
  const readyBtn = root.querySelector('.ip-ready-btn');
  if (readyBtn) readyBtn.onclick = () => {
    readyBtn.disabled = true;
    ctx.send({ type: 'ready', on: !v.readyIds.includes(ctx.me) });
  };
  const forceBtn = root.querySelector('.ip-force');
  if (forceBtn) forceBtn.onclick = () => { forceBtn.disabled = true; ctx.send({ type: 'forceNext' }); };
}

// 準備OKパネル（きゅうりと同じ見た目・挙動）
function readyPanel(v, ctx, name) {
  const need = v.needIds || [];
  const ready = v.readyIds || [];
  const readyCount = need.filter(id => ready.includes(id)).length;
  const iPressed = ready.includes(ctx.me);
  const list = need.map(id =>
    `<li class="${ready.includes(id) ? 'ok' : ''}">${ready.includes(id) ? '✓' : '待ち'} ${name(id)}</li>`).join('');
  return `
    <div class="ip-ready">
      <div class="ip-ready-head">準備OK ${readyCount} / ${need.length}</div>
      <ul class="ip-ready-list">${list}</ul>
      <button class="btn ${iPressed ? '' : 'primary'} ip-ready-btn ${iPressed ? '' : 'ip-pulse'}">${iPressed ? '取り消す' : '準備OK'}</button>
      ${ctx.isHost ? '<button class="btn ghost small ip-force">待たずに次へ</button>' : ''}
    </div>`;
}
