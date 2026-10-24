// 喫茶店のレシピ帳の画面
//  - 毎回まるごと描き直す。操作は項目3、プレイヤー欄の充実は項目4で足す
import { timerHTML } from '/lib/timer.js';

// ---- 材料アイコン（インラインSVG・画像は使わない。形でも区別できるように）----
const SHAPES = {
  coffee: '<ellipse cx="12" cy="12" rx="6.5" ry="8.5"/><path d="M12 4.5 C9 9 15 15 12 19.5" fill="none" stroke-width="1.6"/>',
  milk: '<path d="M12 3 C7.5 11 7.5 15.5 12 20.5 C16.5 15.5 16.5 11 12 3 Z"/>',
  matcha: '<path d="M5 19 C5 9.5 11.5 4.5 19.5 4.5 C19.5 14 13 19.5 5 19 Z"/><path d="M8 17 L17 7.5" fill="none" stroke-width="1.4"/>',
  berry: '<path d="M5 8 L19 8 L12 21 Z"/><path d="M9.2 8 L12 3.6 L14.8 8" fill="none" stroke-width="1.6"/>',
  honey: '<polygon points="12,3 20,7.5 20,16.5 12,21 4,16.5 4,7.5"/>',
  spice: '<polygon points="12,2.2 14.6,8.9 21.8,9.2 16.1,13.7 18,20.7 12,16.6 6,20.7 7.9,13.7 2.2,9.2 9.4,8.9"/>',
};
// その材料の色（ミルクなど薄い色は濃い枠を付ける）
function ingIcon(v, id, cls = '') {
  const color = colorOf(v, id);
  const light = isLight(color);
  const stroke = light ? '#8a7a66' : 'rgba(0,0,0,.35)';
  return `<svg class="rc-ico ${cls}" viewBox="0 0 24 24" aria-hidden="true" style="--ic:${color};--is:${stroke}">${SHAPES[id] || ''}</svg>`;
}
function colorOf(v, id) {
  if (v.wild && id === v.wild.id) return v.wild.color;
  const m = (v.ingredients || []).find(i => i.id === id);
  return m ? m.color : '#999';
}
function nameOf(v, id) {
  if (v.wild && id === v.wild.id) return v.wild.name;
  const m = (v.ingredients || []).find(i => i.id === id);
  return m ? m.name : id;
}
// 明るい色か（枠を付けるか）の簡易判定
function isLight(hex) {
  const m = /^#?([0-9a-f]{6})$/i.exec(hex || '');
  if (!m) return false;
  const n = parseInt(m[1], 16);
  const r = (n >> 16) & 255, g = (n >> 8) & 255, b = n & 255;
  return (0.299 * r + 0.587 * g + 0.114 * b) > 180;
}

// ---- 銀行のチップ ----
function bankChip(v, id, count, extra = '') {
  return `<div class="rc-chip ${id === (v.wild || {}).id ? 'spice' : ''} ${count <= 0 ? 'empty' : ''}" data-color="${id}" ${extra}>
    ${ingIcon(v, id)}<span class="rc-chip-n">${count}</span>
  </div>`;
}
function bankRow(v) {
  const order = [...(v.ingredientOrder || []), (v.wild || {}).id].filter(Boolean);
  return `<div class="rc-bank">${order.map(id => bankChip(v, id, v.bank[id])).join('')}</div>`;
}

// ---- カード ----
const TIER_CLASS = { 1: 'tier1', 2: 'tier2', 3: 'tier3' };
function costHTML(v, card) {
  const cost = card.cost || {};
  const parts = (v.ingredientOrder || []).filter(id => cost[id] > 0).map(id =>
    `<span class="rc-cost-one">${ingIcon(v, id, 'sm')}<span class="rc-cost-n">${cost[id]}</span></span>`);
  return `<div class="rc-cost">${parts.join('')}</div>`;
}
function cardHTML(v, card, { buildable = false, tapData = '' } = {}) {
  if (!card) return `<div class="rc-card empty" aria-hidden="true"></div>`;
  return `<div class="rc-card ${TIER_CLASS[card.tier]} ${buildable ? 'buildable' : ''}" ${tapData}>
    <div class="rc-card-band">
      ${card.points ? `<span class="rc-pts">${card.points}</span>` : '<span></span>'}
      <span class="rc-card-bonus">${ingIcon(v, card.bonus)}</span>
    </div>
    <div class="rc-card-name">${esc0(card.name)}</div>
    ${costHTML(v, card)}
  </div>`;
}
// 山（裏向きのカード・段階名と残り枚数）
function deckPile(v, tier, count, tapData = '') {
  return `<div class="rc-card back ${TIER_CLASS[tier]} ${count <= 0 ? 'empty' : ''}" ${tapData}>
    <div class="rc-back-name">${esc0((v.tierNames || {})[tier] || '')}</div>
    <div class="rc-back-count">残り ${count}</div>
  </div>`;
}

// ---- 常連さん ----
function regularHTML(v, r) {
  const needs = Object.entries(r.needs || {}).map(([id, n]) =>
    `<span class="rc-need">${ingIcon(v, id, 'sm')}<span class="rc-need-n">${n}</span></span>`).join('');
  return `<div class="rc-regular" title="${esc0(r.name)}">
    <div class="rc-reg-pts">+${r.points}</div>
    <div class="rc-reg-name">${esc0(r.name)}</div>
    <div class="rc-reg-needs">${needs}</div>
  </div>`;
}

// esc は ctx.esc を使うが、部品関数では簡易に閉じ込める
let esc0 = s => String(s == null ? '' : s);

export function render(root, v, ctx) {
  esc0 = ctx.esc;

  // 場：常連さん → 看板(3) → 定番(2) → まかない(1) の順
  const regulars = `<div class="rc-regulars">${(v.regulars || []).map(r => regularHTML(v, r)).join('') || '<span class="muted">なし</span>'}</div>`;
  const tierRow = tier => {
    const idx = tier - 1;
    const face = (v.market[idx] || []).map((c, i) => cardHTML(v, c)).join('');
    return `<div class="rc-row">
      <div class="rc-deck">${deckPile(v, tier, v.deckCounts[idx])}</div>
      <div class="rc-face">${face}</div>
    </div>`;
  };

  const felt = `
    <div class="felt rc-felt">
      <div class="rc-top">
        <div class="rc-regulars-wrap"><div class="rc-label">常連さん</div>${regulars}</div>
        ${ctx.deadline != null ? `<div class="rc-timer">${timerHTML(ctx.deadline, ctx)}</div>` : ''}
      </div>
      <div class="rc-board">
        ${tierRow(3)}
        ${tierRow(2)}
        ${tierRow(1)}
      </div>
      <div class="rc-label">材料の銀行</div>
      ${bankRow(v)}
    </div>`;

  // プレイヤー欄は項目4で作る。ここでは最小限（名前・点数）だけ
  const side = `<div class="g-side"><div class="rc-side">
    ${(v.players || []).map(p => `
      <div class="rc-pcard ${p.isTurn ? 'turn' : ''} ${p.id === ctx.me ? 'me' : ''}" data-member-id="${p.id}">
        <span class="rc-pname">${esc0(p.name)}</span>
        <span class="rc-ppts">${p.points}点</span>
      </div>`).join('')}
  </div></div>`;

  root.innerHTML = `
    <div class="g-layout rc">
      <div class="g-main">${felt}</div>
      ${side}
    </div>`;
}
