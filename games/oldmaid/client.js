// ババ抜きの画面。自分の手札だけ表を向けて表示し、他の人は枚数（裏向き）だけ表示する
import { cardHTML, backHTML } from '/lib/cards.js';

// ルール（基盤がルールパネル／ボトムシートに表示する）
export const rules = `<ul>
  <li>配ったら、同じ数字のペアは自動で捨てられます</li>
  <li>自分の番に、となりの人の手札から1枚引きます</li>
  <li>引いたカードで数字がそろったら、そのペアを捨てます</li>
  <li>手札が早くなくなった人から上がり</li>
  <li>最後にジョーカーを持っていた人の負け</li>
</ul>`;

// 扇形に広げるための角度
const fanStyle = (i, n, step) => {
  const mid = (n - 1) / 2;
  return `style="transform: translateY(${Math.abs(i - mid) * 3}px) rotate(${(i - mid) * step}deg)"`;
};

// 手札が多いほど重ねて、1列に収める（カード幅58px・使える幅は約330px）
const overlap = n => (n > 1 ? Math.min(-8, Math.floor((330 - 58 * n) / (n - 1))) : 0);

export function render(root, v, ctx) {
  const { esc } = ctx;
  const me = v.players.find(p => p.id === ctx.me);
  const current = v.players.find(p => p.id === v.currentId);
  const target = v.players.find(p => p.id === v.targetId);
  const myTurn = !v.over && v.currentId === ctx.me;
  const loser = v.players.find(p => p.id === v.loserId);

  let small, big;
  if (v.over) {
    small = '決着';
    big = loser ? (loser.id === ctx.me ? 'あなたの負け…' : `${esc(loser.name)} さんの負け！`) : 'ゲーム終了';
  } else if (me && me.rank) {
    small = `${me.rank}位で上がり`;
    big = 'みんなを見守ろう';
  } else if (myTurn) {
    small = 'あなたの番';
    big = `${esc(target.name)} さんから1枚ひいてね`;
  } else {
    small = `${esc(current.name)} さんの番`;
    big = `${esc(target.name)} さんから引いています`;
  }

  const others = v.players.filter(p => p.id !== ctx.me);
  const last = v.myLastDraw;

  root.innerHTML = `
    <div class="g-layout">
      <div class="g-main">
        <div class="felt">
          <div class="seats">
            ${others.map(p => `
              <div class="seat ${p.id === v.currentId ? 'turn' : ''} ${p.id === v.targetId ? 'target' : ''} ${p.rank ? 'done' : ''}">
                <div class="om-mini-fan">
                  ${(n => Array.from({ length: n }, (_, i) => backHTML({ cls: 'mini', attrs: fanStyle(i, n, 10) })).join(''))(Math.min(p.count, 5))}
                </div>
                <span class="seat-chip">${esc(p.name)}</span>
                <span class="seat-info">${p.id === v.loserId ? '負け' : p.rank ? `${p.rank}位 上がり` : `${p.count}枚`}</span>
              </div>`).join('')}
          </div>

          <div class="note ${myTurn ? '' : 'plain'}"><small>${small}</small><strong>${big}</strong></div>

          ${myTurn ? `
            <div class="om-pick ${target.count > 6 ? 'many' : ''}">
              ${Array.from({ length: target.count }, (_, i) =>
                backHTML({ button: true, cls: 'playable', attrs: `data-i="${i}" ${target.count > 6 ? '' : fanStyle(i, target.count, 4)}` })).join('')}
            </div>
            <p class="om-tip">タップして引く</p>` : ''}

          ${last ? `<div class="om-last">引いたカード ${cardHTML(last.card, { cls: 'sm' })} ${last.paired ? 'ペアで捨てた！' : ''}</div>` : ''}
        </div>

        <div class="hand-head">
          <span>あなたの手札（${v.myHand.length}枚）</span>
          ${v.myHand.length > 1 && !v.over ? '<button class="btn small om-shuffle">シャッフル</button>' : ''}
        </div>
        <div class="hand om-hand" style="--ov:${overlap(v.myHand.length)}px">
          ${v.myHand.map((c, i, a) => cardHTML(c, { attrs: fanStyle(i, a.length, a.length > 6 ? 2 : 5) })).join('') || '<span class="muted" style="color:var(--paper)">手札なし</span>'}
        </div>
      </div>
      <div class="g-side">
        <ul class="log">${v.log.slice().reverse().slice(0, 10).map(l => `<li>${esc(l)}</li>`).join('')}</ul>
      </div>
    </div>`;

  const pick = root.querySelector('.om-pick');
  if (pick) {
    pick.onclick = e => {
      const b = e.target.closest('button');
      if (!b) return;
      pick.querySelectorAll('button').forEach(x => (x.disabled = true));
      b.classList.add('picked');
      ctx.send({ type: 'draw', index: Number(b.dataset.i) });
    };
  }
  const sh = root.querySelector('.om-shuffle');
  if (sh) sh.onclick = () => ctx.send({ type: 'shuffle' });
}
