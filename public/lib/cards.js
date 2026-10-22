// トランプ描画の共通部品。各ゲームの client.js から
//   import { cardHTML, backHTML } from '/lib/cards.js';
// のように使う。見た目は style.css の .pcard で決まる。

const RED_SUITS = ['♥', '♦'];

/**
 * 表向きのカード
 * @param {{r:string, s:string}} c  r: 'A','2'..'K','JOKER'  s: '♠♥♦♣'
 * @param {object} [o]
 * @param {boolean} [o.button]  押せるカードにする（<button>）
 * @param {string}  [o.cls]     追加クラス（'sm' で小さく、'playable' で浮く）
 * @param {string}  [o.attrs]   追加属性（data-i="3" など）
 * @param {boolean} [o.disabled]
 */
export function cardHTML(c, o = {}) {
  const joker = c.r === 'JOKER';
  const cls = ['pcard', joker ? 'joker' : '', RED_SUITS.includes(c.s) ? 'red' : '', o.cls || ''].join(' ');
  const inner = joker
    ? `<span class="r">JOKER</span><span class="s">★</span>`
    : `<span class="r">${c.r}</span><span class="s">${c.s}</span>`;
  const label = joker ? 'ジョーカー' : `${c.s}${c.r}`;
  if (o.button) {
    return `<button class="${cls}" aria-label="${label}" ${o.attrs || ''} ${o.disabled ? 'disabled' : ''}>${inner}</button>`;
  }
  return `<div class="${cls}" role="img" aria-label="${label}" ${o.attrs || ''}>${inner}</div>`;
}

/** 裏向きのカード（o は cardHTML と同じ） */
export function backHTML(o = {}) {
  const cls = `pcard back ${o.cls || ''}`;
  if (o.button) {
    return `<button class="${cls}" aria-label="伏せたカード" ${o.attrs || ''} ${o.disabled ? 'disabled' : ''}></button>`;
  }
  return `<div class="${cls}" aria-hidden="true" ${o.attrs || ''}></div>`;
}
