// きゅうりの画面
import { cardHTML } from '/lib/cards.js';

const RANK_NAME = { 11: 'J', 12: 'Q', 13: 'K', 14: 'A' };
const rankName = v => RANK_NAME[v] || String(v);

// きゅうりのマーク（持っている本数ぶん表示）
const cukes = n => Array.from({ length: n }, () => '<span class="cuke" aria-hidden="true"></span>').join('');

export function render(root, v, ctx) {
  const { esc } = ctx;
  const name = id => esc((v.players.find(p => p.id === id) || {}).name || '?');
  const me = v.players.find(p => p.id === ctx.me);
  const myTurn = v.phase === 'play' && v.currentId === ctx.me;
  const lastTrick = v.trickNo === v.handSize;

  // ---- 卓の上のメモ ----
  let small, big;
  if (v.phase === 'over') {
    small = '決着';
    big = v.winnerId === ctx.me ? 'あなたの勝ち！' : `${name(v.winnerId)} さんの勝ち！`;
  } else if (v.phase === 'result') {
    small = `第${v.handSize}トリック終了`;
    big = v.result.loserId === ctx.me ? 'あなたが取ってしまった…' : `${name(v.result.loserId)} さんが取った！`;
  } else if (me && me.out) {
    small = me.left ? '退席' : '脱落';
    big = 'みんなを見守ろう';
  } else if (myTurn) {
    small = lastTrick ? '最後のトリック・あなたの番' : 'あなたの番';
    big = v.highest === null
      ? '好きなカードを出してね'
      : `${rankName(v.highest)} 以上か、一番弱いカード`;
  } else {
    small = lastTrick ? '最後のトリック' : `${name(v.currentId)} さんの番`;
    big = lastTrick ? `${name(v.currentId)} さんが考え中…` : '待っています…';
  }

  // ---- 席 ----
  const seats = v.players.map(p => {
    const cls = [
      p.id === v.currentId ? 'turn' : '',
      p.out ? 'done' : '',
    ].join(' ');
    const info = p.left ? '退席' : p.out ? '脱落' : `${p.score}点`;
    return `
      <div class="seat cu-seat ${cls}">
        <span class="seat-chip">${esc(p.name)}</span>
        <span class="seat-info">${info} ${cukes(p.cucumbers)}</span>
        <span class="cu-bar" aria-hidden="true"><span style="width:${Math.min(100, (p.score / v.limit) * 100)}%"></span></span>
        <span class="cu-sub">${[p.id === ctx.me ? 'あなた' : '', p.dealer ? '親' : '', p.out ? '' : `${p.count}枚`].filter(Boolean).join('・')}</span>
      </div>`;
  }).join('');

  // ---- 場（今のトリック） ----
  const trickArea = v.phase === 'play' ? `
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
    </div>` : '';

  // 1つ前のトリック（小さく）
  const prev = v.phase === 'play' && v.lastTrick ? `
    <div class="cu-prev">
      <span>第${v.lastTrick.no}トリック → ${name(v.lastTrick.winnerId)}</span>
      <span class="cu-prev-cards">${v.lastTrick.plays.map(t => cardHTML(t.card, { cls: 'sm' })).join('')}</span>
    </div>` : '';

  // ---- 結果 ----
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
        ${v.phase === 'result' ? '<button class="btn primary cu-next">次の配りへ</button>' : ''}
      </div>`;
  }

  // ---- 手札 ----
  const hand = v.myHand.map((c, i) =>
    cardHTML(c, { button: true, cls: myTurn && c.legal ? 'playable' : '', attrs: `data-i="${i}"`, disabled: !(myTurn && c.legal) })
  ).join('');

  root.innerHTML = `
    <div class="felt">
      <div class="seats cu-seats">${seats}</div>
      <div class="note ${myTurn ? '' : 'plain'}"><small>${small}</small><strong>${big}</strong></div>
      ${trickArea}
      ${result}
      ${prev}
      <ul class="log">${v.log.slice().reverse().slice(0, 4).map(l => `<li>${esc(l)}</li>`).join('')}</ul>
    </div>
    ${v.myHand.length ? `
      <div class="hand-head">
        <span>あなたの手札（${v.myHand.length}枚）</span>
        <span class="cu-rule">${myTurn ? '明るいカードが出せます' : ''}</span>
      </div>
      <div class="hand cu-hand ${myTurn ? '' : 'idle'}">${hand}</div>` : ''}
    <details class="cu-help">
      <summary>ルール</summary>
      <ul>
        <li>強さは A ＞ K ＞ Q ＞ J ＞ 10 … ＞ 2。マーク（♠♥♦♣）は関係なし</li>
        <li>各自7枚で、7回カードを出し合います（トリック）</li>
        <li>最初の人は何でもOK。次からは「場の一番強い札と同じか上」か「自分の一番弱い札」を出す</li>
        <li>一番強い札を出した人（同じなら後に出した人）がトリックを取り、次の最初の人になる</li>
        <li><strong>最後のトリックを取った人だけ</strong>、その札の数字ぶん失点（A=14, K=13, Q=12, J=11）</li>
        <li>そのとき同じ数字を出していた人は、同じ点数ぶん減点されます</li>
        <li>${v.limit}点以上で「きゅうり」1本。他の人の最高点に戻って続行。2本目で脱落</li>
        <li>最後まで残った人の勝ち</li>
      </ul>
    </details>`;

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
  const next = root.querySelector('.cu-next');
  if (next) next.onclick = () => { next.disabled = true; ctx.send({ type: 'next' }); };
}
