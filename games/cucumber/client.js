// きゅうりの画面
import { cardHTML } from '/lib/cards.js';

// ルール（基盤がルールパネル／ボトムシートに表示する）
export const rules = `<ul>
  <li>強さは A ＞ K ＞ Q ＞ J ＞ 10 … ＞ 2。マーク（♠♥♦♣）は関係なし</li>
  <li>各自7枚で、7回カードを出し合います（トリック）</li>
  <li>最初の人は何でもOK。次からは「場の一番強い札と同じか上」か「自分の一番弱い札」を出す</li>
  <li>一番強い札を出した人（同じなら後に出した人）がトリックを取り、次の最初の人になる</li>
  <li><strong>最後のトリックを取った人だけ</strong>、その札の数字ぶん失点（A=14, K=13, Q=12, J=11）</li>
  <li>そのとき同じ数字を出していた人は、同じ点数ぶん減点されます</li>
  <li>21点以上で「きゅうり」1本。他の人の最高点に戻って続行。2本目で脱落</li>
  <li>最後まで残った人の勝ち</li>
</ul>`;

const RANK_NAME = { 11: 'J', 12: 'Q', 13: 'K', 14: 'A' };
const rankName = v => RANK_NAME[v] || String(v);

// きゅうりのマーク（持っている本数ぶん表示）
const cukes = n => Array.from({ length: n }, () => '<span class="cuke" aria-hidden="true"></span>').join('');

// ---- 決まったトリックの保留表示（B-2） ----
let holdTimer = null;   // 1.5秒後に現在のトリックへ戻すタイマー
let fromTimer = false;  // そのタイマーからの再描画かどうか

export function render(root, v, ctx) {
  const { esc } = ctx;
  const name = id => esc((v.players.find(p => p.id === id) || {}).name || '?');
  const me = v.players.find(p => p.id === ctx.me);
  const myTurn = v.phase === 'play' && v.currentId === ctx.me;
  const lastTrick = v.trickNo === v.handSize;

  // ---- 効果音（B-4：prev との差分で、1回につき最大1つ） ----
  const timerRender = fromTimer;
  fromTimer = false;
  if (!timerRender) playSound(v, ctx);

  // ---- 決まったトリックを 1.5 秒見せる（B-2） ----
  let showHold = false;
  if (!timerRender) {
    clearTimeout(holdTimer); // 新しいサーバー更新が来たら保留は解除
    holdTimer = null;
    if (ctx.prev && ctx.prev.trickNo !== v.trickNo && v.lastTrick && v.phase === 'play') {
      showHold = true;
      holdTimer = setTimeout(() => { fromTimer = true; render(root, v, ctx); }, 1500);
    }
  }

  // ---- 卓の上のメモ ----
  const aliveCount = v.players.filter(p => !p.out).length;
  const remain = aliveCount - (v.trick ? v.trick.length : 0);
  let small, big;
  if (v.phase === 'over') {
    small = '決着';
    big = v.winnerId === ctx.me ? 'あなたの勝ち！' : `${name(v.winnerId)} さんの勝ち！`;
  } else if (v.phase === 'result') {
    small = `第${v.handSize}トリック終了`;
    big = v.result.loserId === ctx.me ? 'あなたが取ってしまった…' : `${name(v.result.loserId)} さんが取った！`;
  } else if (showHold) {
    small = `第${v.lastTrick.no}トリック`;
    big = `${name(v.lastTrick.winnerId)} さんが取った`;
  } else if (me && me.out) {
    small = me.left ? '退席' : '脱落';
    big = 'みんなを見守ろう';
  } else if (myTurn) {
    small = lastTrick ? '最後のトリック・あなたの番' : 'あなたの番';
    big = v.highest === null
      ? '好きなカードを出してね'
      : `${rankName(v.highest)} 以上か、一番弱いカード`;
  } else {
    small = `このトリックは あと${remain}人`;
    big = `${name(v.currentId)} さんの番`;
  }

  // ---- 席（手番の分かりやすさ・B-1） ----
  const played = id => v.phase === 'play' && v.trick && v.trick.some(t => t.id === id);
  const seats = v.players.map(p => {
    let cls = '';
    let badge = '';
    if (v.phase === 'play' && p.id === v.currentId) {
      cls = 'turn';
      badge = '<span class="cu-badge turn">番</span>';
    } else if (v.phase === 'play' && played(p.id)) {
      cls = 'cu-played';
      badge = '<span class="cu-badge played">出した</span>';
    } else if (v.phase === 'play' && p.id === v.nextId) {
      cls = 'target';
      badge = '<span class="cu-badge next">次</span>';
    }
    if (p.out) cls += ' done';
    return `
      <div class="seat cu-seat ${cls}">
        <span class="seat-chip">${esc(p.name)}</span>
        ${badge || `<span class="seat-info">${p.left ? '退席' : p.out ? '脱落' : ''}</span>`}
      </div>`;
  }).join('');

  // ---- 場（今のトリック or 決まったトリックの保留表示） ----
  let trickArea = '';
  if (v.phase === 'play' && showHold) {
    trickArea = `
      <div class="cu-trick-label">第${v.lastTrick.no}トリック終了</div>
      <div class="cu-trick">
        ${v.lastTrick.plays.map(t => `
          <div class="cu-play ${t.id === v.lastTrick.winnerId ? 'top' : ''}">
            ${cardHTML(t.card)}
            <span>${name(t.id)}</span>
          </div>`).join('')}
      </div>
      <div class="cu-took">${name(v.lastTrick.winnerId)} さんが取った</div>`;
  } else if (v.phase === 'play') {
    trickArea = `
      <div class="cu-trick-label">
        第${v.trickNo}トリック / ${v.handSize}
        ${lastTrick ? '<span class="cu-danger">取ったら失点！</span>' : ''}
      </div>
      <div class="cu-trick">
        ${v.trick.length === 0 ? '<span class="cu-empty">まだ誰も出していません</span>' : v.trick.map(t => `
          <div class="cu-play ${t.card.v === v.highest ? 'top' : ''}">
            ${cardHTML(t.card)}
            <span>${name(t.id)}</span>
          </div>`).join('')}
      </div>`;
  }

  // 1つ前のトリック（小さく）。保留表示中は出さない
  const prev = v.phase === 'play' && v.lastTrick && !showHold ? `
    <div class="cu-prev">
      <span>第${v.lastTrick.no}トリック → ${name(v.lastTrick.winnerId)}</span>
      <span class="cu-prev-cards">${v.lastTrick.plays.map(t => cardHTML(t.card, { cls: 'sm' })).join('')}</span>
    </div>` : '';

  // ---- 結果（B-3：全員の準備OKで次の配りへ） ----
  let result = '';
  if (v.result && v.phase !== 'play') {
    const r = v.result;
    result = `
      <div class="cu-result">
        <div class="cu-result-main">
          ${cardHTML(r.card)}
          <div>
            <strong>${name(r.loserId)} さん +${r.penalty}点</strong>
            ${r.bonusIds.length ? `<p>同じ数字を出した ${r.bonusIds.map(name).join('、')} さんは −${r.penalty}点</p>` : ''}
            ${r.lifeLost ? `<p class="cu-hit">${cukes(1)} きゅうり1本目！ ${r.resetTo}点からやり直し</p>` : ''}
            ${r.eliminated ? `<p class="cu-hit">${cukes(2)} きゅうり2本目で脱落…</p>` : ''}
          </div>
        </div>
        <div class="cu-lasttrick">
          ${v.lastTrick.plays.map(t => `<div class="cu-play ${t.id === r.loserId ? 'top' : ''}">${cardHTML(t.card, { cls: 'sm' })}<span>${name(t.id)}</span></div>`).join('')}
        </div>
        ${v.phase === 'result' ? readyPanel(v, ctx, name) : ''}
      </div>`;
  }

  // ---- 手札 ----
  const hand = v.myHand.map((c, i) =>
    cardHTML(c, { button: true, cls: myTurn && c.legal ? 'playable' : '', attrs: `data-i="${i}"`, disabled: !(myTurn && c.legal) })
  ).join('');

  root.innerHTML = `
    <div class="g-layout">
      <div class="g-main">
        <div class="felt">
          <div class="seats cu-seats">${seats}</div>
          <div class="note ${myTurn ? '' : 'plain'}"><small>${small}</small><strong>${big}</strong></div>
          ${trickArea}
          ${result}
          ${prev}
        </div>
        ${v.myHand.length ? `
          <div class="cu-handwrap ${myTurn ? 'cu-myturn' : ''}">
            <div class="hand-head">
              <span>${myTurn ? 'あなたの番です｜明るいカードを選んでください' : `あなたの手札（${v.myHand.length}枚）`}</span>
            </div>
            <div class="hand cu-hand ${myTurn ? '' : 'idle'}">${hand}</div>
          </div>` : ''}
      </div>
      <div class="g-side">
        ${scoreTable(v, ctx, esc)}
        <ul class="log">${v.log.slice().reverse().slice(0, 10).map(l => `<li>${esc(l)}</li>`).join('')}</ul>
      </div>
    </div>`;

  const handEl = root.querySelector('.cu-hand');
  if (handEl) {
    handEl.onclick = e => {
      const b = e.target.closest('button.pcard');
      if (!b || b.disabled) return;
      handEl.querySelectorAll('button').forEach(x => (x.disabled = true));
      b.classList.add('picked');
      ctx.send({ type: 'play', index: Number(b.dataset.i) });
    };
  }
  const readyBtn = root.querySelector('.cu-ready-btn');
  if (readyBtn) readyBtn.onclick = () => {
    readyBtn.disabled = true;
    ctx.send({ type: 'ready', on: !v.readyIds.includes(ctx.me) });
  };
  const forceBtn = root.querySelector('.cu-force');
  if (forceBtn) forceBtn.onclick = () => { forceBtn.disabled = true; ctx.send({ type: 'forceNext' }); };
}

// 準備OKパネル（結果のなか）
function readyPanel(v, ctx, name) {
  const need = v.needIds || [];
  const ready = v.readyIds || [];
  const readyCount = need.filter(id => ready.includes(id)).length;
  const iPressed = ready.includes(ctx.me);
  const list = need.map(id =>
    `<li class="${ready.includes(id) ? 'ok' : ''}">${ready.includes(id) ? '✓' : '待ち'} ${name(id)}</li>`).join('');
  return `
    <div class="cu-ready">
      <div class="cu-ready-head">準備OK ${readyCount} / ${need.length}</div>
      <ul class="cu-ready-list">${list}</ul>
      <button class="btn ${iPressed ? '' : 'primary'} cu-ready-btn ${iPressed ? '' : 'cu-pulse'}">${iPressed ? '取り消す' : '準備OK'}</button>
      ${ctx.isHost ? '<button class="btn ghost small cu-force">待たずに次へ</button>' : ''}
    </div>`;
}

// 得点表（g-side）。点数の少ない順、脱落者は薄く
function scoreTable(v, ctx, esc) {
  const rows = v.players.slice().sort((a, b) => (a.out - b.out) || (a.score - b.score));
  return `
    <div class="cu-scores">
      <h3>得点表</h3>
      ${rows.map(p => `
        <div class="cu-score-row ${p.out ? 'out' : ''} ${p.id === ctx.me ? 'me' : ''}">
          <span class="cu-score-name">${esc(p.name)}${p.dealer ? '<span class="cu-dealer">親</span>' : ''}</span>
          <span class="cu-score-bar" aria-hidden="true"><span style="width:${Math.min(100, (p.score / v.limit) * 100)}%"></span></span>
          <span class="cu-score-num">${p.out ? (p.left ? '退席' : '脱落') : `${p.score}点`}</span>
          <span class="cu-score-meta">${cukes(p.cucumbers)}${p.out ? '' : ` ${p.count}枚`}</span>
        </div>`).join('')}
    </div>`;
}

// 効果音（B-4）。prev と比べて最大1つ鳴らす
function playSound(v, ctx) {
  const p = ctx.prev;
  if (!p) return; // 初回・再接続直後などは鳴らさない
  const prevTrickLen = p.trick ? p.trick.length : 0;
  let snd = null;
  if (p.phase !== 'over' && v.phase === 'over') snd = 'win';
  else if (v.result && !p.result && (v.result.lifeLost || v.result.eliminated)) snd = 'cucumber';
  else if (p.phase !== 'result' && v.phase === 'result') snd = 'penalty';
  else if (v.lastTrick && (!p.lastTrick || p.lastTrick.no !== v.lastTrick.no) && v.lastTrick.no !== v.handSize) snd = 'trick';
  else if (v.trick && v.trick.length > prevTrickLen) snd = 'card';
  else if ((v.readyIds || []).length > (p.readyIds || []).length) snd = 'ready';
  if (snd) ctx.sound(snd);
}
