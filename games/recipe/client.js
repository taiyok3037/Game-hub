// 喫茶店のレシピ帳の画面
//  - 毎回まるごと描き直す。操作はすべて ctx.send、ルール判定はサーバー
//  - プレイヤー欄の充実は項目4、演出は項目5
import { timerHTML } from '/lib/timer.js';

// ルール（基盤がルールパネル／ボトムシートに表示する）
export const rules = `<ul>
  <li>自分の番に1つだけ：材料を取る／レシピを予約する／レシピを作る のどれか</li>
  <li>材料を取る…違う材料を3つ、または<strong>同じ材料2つは場に4枚以上あるときだけ</strong></li>
  <li>予約…場か山の1枚を手元へ（3枚まで）。山から取ると秘伝のスパイス（万能）を1枚もらえる</li>
  <li>作る…コストを材料で払う（足りない分はスパイス）。作ると割引が永久に1つ増え、次から安くなる</li>
  <li>割引の組み合わせがそろうと常連さんが来店して +3点（1回の番で1人まで）</li>
  <li>番の終わりに、<strong>手元のチップは10枚まで</strong>。超えたぶんは戻す</li>
  <li><strong>だれかが15点になったらその周で最終周</strong>。点数が一番多い人の勝ち（同点は作ったレシピが少ない人）</li>
</ul>`;

// ===== ローカルUI状態（サーバー更新・自分の番の間だけ保つ）=====
let store = null;          // { root, v, ctx }
let sel = {};              // 取る選択 { color: 1|2 }
let openCard = null;       // 開いているカードパネル { from:'market'|'reserved'|'deck', tier, index }
let discardSel = {};       // 戻すチップの選択 { color: n }
let uiKey = null;          // 手番が変わったら選択を捨てる
let paintLocal = false;    // ローカル再描画か（効果音・演出を出さない）
function rerender() { if (store) { paintLocal = true; render(store.root, store.v, store.ctx); } }

// サーバー更新のときだけ、last（何が起きたか）に応じて効果音を鳴らす
const SND = { take: 'ready', build: 'trick', reserve: 'card', regular: 'win', over: 'win' };
function effects(v, ctx) {
  const p = ctx.prev;
  const last = v.last;
  if (last && (!p || !p.last || p.last.seq !== last.seq) && SND[last.type]) ctx.sound(SND[last.type]);
  if (v.finalRound && !v.over && (!p || !p.finalRound)) ctx.sound('turn'); // 最終周に入った
}

// ===== 材料アイコン =====
const SHAPES = {
  coffee: '<ellipse cx="12" cy="12" rx="6.5" ry="8.5"/><path d="M12 4.5 C9 9 15 15 12 19.5" fill="none" stroke-width="1.6"/>',
  milk: '<path d="M12 3 C7.5 11 7.5 15.5 12 20.5 C16.5 15.5 16.5 11 12 3 Z"/>',
  matcha: '<path d="M5 19 C5 9.5 11.5 4.5 19.5 4.5 C19.5 14 13 19.5 5 19 Z"/><path d="M8 17 L17 7.5" fill="none" stroke-width="1.4"/>',
  berry: '<path d="M5 8 L19 8 L12 21 Z"/><path d="M9.2 8 L12 3.6 L14.8 8" fill="none" stroke-width="1.6"/>',
  honey: '<polygon points="12,3 20,7.5 20,16.5 12,21 4,16.5 4,7.5"/>',
  spice: '<polygon points="12,2.2 14.6,8.9 21.8,9.2 16.1,13.7 18,20.7 12,16.6 6,20.7 7.9,13.7 2.2,9.2 9.4,8.9"/>',
};
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
function isLight(hex) {
  const m = /^#?([0-9a-f]{6})$/i.exec(hex || '');
  if (!m) return false;
  const n = parseInt(m[1], 16);
  return (0.299 * ((n >> 16) & 255) + 0.587 * ((n >> 8) & 255) + 0.114 * (n & 255)) > 180;
}
function ingIcon(v, id, cls = '') {
  const color = colorOf(v, id);
  const stroke = isLight(color) ? '#8a7a66' : 'rgba(0,0,0,.35)';
  return `<svg class="rc-ico ${cls}" viewBox="0 0 24 24" aria-hidden="true" style="--ic:${color};--is:${stroke}">${SHAPES[id] || ''}</svg>`;
}

let esc0 = s => String(s == null ? '' : s);
const ingOrder = v => v.ingredientOrder || [];
const spiceId = v => (v.wild || {}).id;

// ===== 支払いの計算（クライアント側・サーバーと同じ式）=====
function payPlan(v, me, card) {
  const plan = {}; let spice = 0; const needs = {};
  for (const id of ingOrder(v)) {
    const need = Math.max(0, (card.cost[id] || 0) - (me.bonus[id] || 0));
    needs[id] = need;
    const fromIng = Math.min(need, me.tokens[id] || 0);
    plan[id] = fromIng; spice += need - fromIng;
  }
  return { ok: spice <= (me.tokens[spiceId(v)] || 0), plan, spice, needs };
}

// ===== カード・チップの部品 =====
const TIER_CLASS = { 1: 'tier1', 2: 'tier2', 3: 'tier3' };
// コスト欄。me があれば各材料の丸に「使える数（割引＋チップ）で足りているか」を記号で出す
//  足りている→✓、足りない→不足数を赤で（色だけに頼らず、✓と数字の形で区別できる）
function costHTML(v, card, me) {
  const cost = card.cost || {};
  return `<div class="rc-cost">${ingOrder(v).filter(id => cost[id] > 0).map(id => {
    let mark = '';
    if (me) {
      const use = (me.bonus[id] || 0) + (me.tokens[id] || 0);
      mark = use >= cost[id]
        ? '<span class="rc-cmark ok" aria-label="足りている">✓</span>'
        : `<span class="rc-cmark short" aria-label="あと${cost[id] - use}">${cost[id] - use}</span>`;
    }
    return `<span class="rc-cost-one">${ingIcon(v, id, 'sm')}<span class="rc-cost-n">${cost[id]}</span>${mark}</span>`;
  }).join('')}</div>`;
}
// 作れるか・足りないか（右下の小さな印）。作れないカードを薄くせず、不足数「あとN」を出す
function affordFoot(v, me, card) {
  const pp = payPlan(v, me, card);
  const lack = pp.spice - (me.tokens[spiceId(v)] || 0); // スパイスを使っても足りない数
  return lack <= 0
    ? '<div class="rc-card-foot ok">✓作れる</div>'
    : `<div class="rc-card-foot short">あと${lack}</div>`;
}
function cardHTML(v, card, { buildable = false, tap = '', me = null } = {}) {
  if (!card) return `<div class="rc-card empty" aria-hidden="true"></div>`;
  const afford = me ? payPlan(v, me, card).ok : false;
  return `<div class="rc-card ${TIER_CLASS[card.tier]} ${(buildable || afford) ? 'buildable' : ''}" ${tap}>
    <div class="rc-card-band">
      ${card.points ? `<span class="rc-pts">${card.points}</span>` : '<span></span>'}
      <span class="rc-card-bonus">${ingIcon(v, card.bonus)}</span>
    </div>
    <div class="rc-card-name">${esc0(card.name)}</div>
    ${costHTML(v, card, me)}
    ${me ? affordFoot(v, me, card) : ''}
  </div>`;
}
function deckPile(v, tier, count, tap = '') {
  return `<div class="rc-card back ${TIER_CLASS[tier]} ${count <= 0 ? 'empty' : ''}" ${tap}>
    <div class="rc-back-name">${esc0((v.tierNames || {})[tier] || '')}</div>
    <div class="rc-back-count">残り ${count}</div>
  </div>`;
}
function bankChip(v, id, count, tap = '') {
  const picked = sel[id] || 0;
  return `<div class="rc-chip ${id === spiceId(v) ? 'spice' : ''} ${count <= 0 ? 'empty' : ''} ${picked ? 'picked' : ''}" ${tap}>
    ${ingIcon(v, id)}<span class="rc-chip-n">${count}</span>${picked ? `<span class="rc-chip-badge">${picked}</span>` : ''}
  </div>`;
}
function regularHTML(v, r, cls = '', tap = '') {
  const needs = Object.entries(r.needs || {}).map(([id, n]) =>
    `<span class="rc-need">${ingIcon(v, id, 'sm')}<span class="rc-need-n">${n}</span></span>`).join('');
  return `<div class="rc-regular ${cls}" ${tap} title="${esc0(r.name)}">
    <div class="rc-reg-pts">+${r.points}</div>
    <div class="rc-reg-name">${esc0(r.name)}</div>
    <div class="rc-reg-needs">${needs}</div>
  </div>`;
}

// ===== 取れるか・できることがあるか（パスの判定）=====
function availColors(v) { return ingOrder(v).filter(c => v.bank[c] > 0); }
function canReserve(v, me) { return me.reservedCount < v.maxReserve && (v.market.some(row => row.some(c => c)) || v.deckCounts.some(n => n > 0)); }
function canBuildAny(v, me) {
  for (const row of v.market) for (const c of row) if (c && payPlan(v, me, c).ok) return true;
  for (const r of me.reserved) if (r.card && payPlan(v, me, r.card).ok) return true;
  return false;
}
function canActAtAll(v, me) { return availColors(v).length > 0 || canReserve(v, me) || canBuildAny(v, me); }

// 取る選択から合法な action を作る（不可なら null）
function takeMove(v) {
  const colors = Object.keys(sel);
  if (!colors.length) return null;
  if (colors.length === 1 && sel[colors[0]] === 2) return v.bank[colors[0]] >= 4 ? { type: 'take2', color: colors[0] } : null;
  if (colors.every(c => sel[c] === 1)) {
    if (colors.length === Math.min(3, availColors(v).length)) return { type: 'take3', colors };
  }
  return null;
}

export function render(root, v, ctx) {
  store = { root, v, ctx };
  const fromLocal = paintLocal; paintLocal = false;
  if (!fromLocal) effects(v, ctx);
  esc0 = ctx.esc;
  const me = v.you >= 0 ? v.players[v.you] : null;
  const myTurn = !!ctx.yourTurn && !!me && !v.over;
  const pending = v.pending || null;

  // 演出：直前のサーバー更新で動いた人の欄を光らせ、点が入ったら「+N」を出す
  const anim = (!fromLocal && v.last && ['take', 'build', 'reserve', 'regular'].includes(v.last.type)) ? v.last : null;
  const flashId = anim ? (v.players[anim.seat] || {}).id : null;
  const floatPts = anim && (anim.type === 'build' || anim.type === 'regular') && anim.points > 0 ? anim.points : 0;

  // 手番が変わったら選択を捨てる
  const key = `${v.turnSeat}:${v.round}:${v.phase}`;
  if (!myTurn || key !== uiKey) { if (key !== uiKey) { sel = {}; openCard = null; discardSel = {}; } uiKey = key; }
  if (!myTurn) { sel = {}; openCard = null; }

  // ---- 場 ----
  const regulars = `<div class="rc-regulars">${(v.regulars || []).map(r => regularHTML(v, r)).join('') || '<span class="muted">なし</span>'}</div>`;
  const tierRow = tier => {
    const idx = tier - 1;
    const face = (v.market[idx] || []).map((c, i) => {
      const buildable = myTurn && !pending && c && payPlan(v, me, c).ok;
      const tap = (myTurn && !pending && c) ? `data-card="market" data-tier="${tier}" data-index="${i}"` : '';
      return cardHTML(v, c, { buildable, tap, me });
    }).join('');
    const deckTap = (myTurn && !pending && v.deckCounts[idx] > 0 && me.reservedCount < v.maxReserve) ? `data-card="deck" data-tier="${tier}"` : '';
    return `<div class="rc-row">
      <div class="rc-deck">${deckPile(v, tier, v.deckCounts[idx], deckTap)}</div>
      <div class="rc-face">${face}</div>
    </div>`;
  };
  const bankTap = (myTurn && !pending) ? id => `data-chip="${id}"` : () => '';
  const bank = `<div class="rc-bank">${[...ingOrder(v), spiceId(v)].map(id => bankChip(v, id, v.bank[id], bankTap(id))).join('')}</div>`;

  const felt = `
    <div class="felt rc-felt">
      ${v.finalRound && !v.over ? '<div class="rc-final-band">最終周です！</div>' : ''}
      <div class="rc-top">
        <div class="rc-regulars-wrap"><div class="rc-label">常連さん</div>${regulars}</div>
        ${ctx.deadline != null && !v.over ? `<div class="rc-timer">${timerHTML(ctx.deadline, ctx)}</div>` : ''}
      </div>
      <div class="rc-board">${tierRow(3)}${tierRow(2)}${tierRow(1)}</div>
      <div class="rc-label">材料の銀行</div>
      ${bank}
      ${v.over ? overPanel(v, ctx) : actionBar(v, ctx, me, myTurn, pending)}
    </div>`;

  // プレイヤー欄（自分を先頭・少し大きく）＋記録
  const ps = v.players || [];
  const ordered = v.you >= 0 ? [ps[v.you], ...ps.filter((_, i) => i !== v.you)] : ps;
  const side = `<div class="g-side"><div class="rc-side">
    ${ordered.map(p => playerPanel(v, ctx, p, me, myTurn, pending, flashId, floatPts)).join('')}
    <ul class="log rc-log">${(v.log || []).slice().reverse().slice(0, 12).map(l => `<li>${esc0(l)}</li>`).join('')}</ul>
  </div></div>`;

  root.innerHTML = `
    <div class="g-layout rc">
      <div class="g-main">${felt}${handPanel(v, ctx, me, myTurn, pending)}</div>
      ${side}
    </div>
    ${modalHTML(v, ctx, me, myTurn, pending)}`;

  wire(root, v, ctx, me, myTurn, pending);
}

// ===== 操作バー（取る選択・パス・自分の予約）=====
function actionBar(v, ctx, me, myTurn, pending) {
  if (!myTurn) return `<div class="rc-turnnote note plain"><small>${v.over ? '決着' : '進行中'}</small><strong>${turnLabel(v, ctx)}</strong></div>`;
  if (pending) return ''; // pending はモーダルで扱う

  // 取る選択の表示
  const chips = Object.entries(sel).flatMap(([c, n]) => Array.from({ length: n }, () => `<span class="rc-selchip">${ingIcon(v, c, 'sm')}</span>`)).join('');
  const move = takeMove(v);
  const canAct = canActAtAll(v, me);

  return `
    <div class="rc-actionbar paper">
      <div class="rc-take-row">
        <span class="rc-label2">取る材料</span>
        <div class="rc-selchips">${chips || '<span class="muted">銀行のチップをタップ（カードはタップで作る/予約）</span>'}</div>
        <button class="btn primary small rc-take" ${move ? '' : 'disabled'}>取る</button>
        <button class="btn ghost small rc-clear" ${Object.keys(sel).length ? '' : 'disabled'}>選び直す</button>
      </div>
      ${!canAct ? '<div class="rc-pass-row"><span class="muted">取る・予約・作るができません</span><button class="btn primary small rc-pass">パスする</button></div>' : ''}
    </div>`;
}
// ===== 自分の手元パネル（メイン）=====
// 卓のすぐ下に出す、自分専用の大きなパネル。観戦者・脱落者のときは「今の手番の人」の手元を出す。
function handPanel(v, ctx, me, myTurn, pending) {
  const viewerPlaying = me && !me.left;
  const p = viewerPlaying ? me : (v.players[v.turnSeat] || null);
  if (!p) return '';
  const mine = viewerPlaying && p === me;
  const isMyTurnPanel = mine && myTurn && !v.over;
  const heading = mine ? 'あなたの手元' : `${esc0(p.name)} の手元`;
  const target = v.target || 15;
  const cols = [...ingOrder(v), spiceId(v)]; // 材料5＋スパイス
  const spice = spiceId(v);

  const th = cols.map(id =>
    `<th><span class="rc-ing-h">${ingIcon(v, id, 'lg')}<span class="rc-ing-hn">${esc0(nameOf(v, id))}</span></span></th>`).join('');
  const bonusRow = cols.map(id => id === spice ? '<td class="rc-dash">—</td>' : `<td>${p.bonus[id] || 0}</td>`).join('');
  const tokRow = cols.map(id => `<td>${p.tokens[id] || 0}</td>`).join('');
  const useRow = cols.map(id => {
    const use = id === spice ? (p.tokens[id] || 0) : (p.bonus[id] || 0) + (p.tokens[id] || 0);
    return `<td class="rc-use-n">${use}</td>`;
  }).join('');

  const total = p.tokenCount != null ? p.tokenCount : cols.reduce((a, id) => a + (p.tokens[id] || 0), 0);
  const totCls = total >= v.handMax ? 'full' : total >= v.handMax - 2 ? 'near' : '';

  const reserved = (p.reserved || []).map((r, i) => {
    if (r.card) {
      const canBuildIt = isMyTurnPanel && !pending && payPlan(v, p, r.card).ok;
      const tap = (isMyTurnPanel && !pending) ? `data-card="reserved" data-index="${i}"` : '';
      return cardHTML(v, r.card, { buildable: canBuildIt, tap, me: p });
    }
    return deckPile(v, r.tier, '', ''); // 伏せられた予約（山から・seesAll=false）は裏向き
  }).join('');
  const regs = (p.regulars || []).map(r =>
    `<span class="rc-hand-reg" title="${esc0(r.name)}">${esc0(r.name)} +${r.points}</span>`).join('') || '<span class="muted">なし</span>';

  return `
    <section class="rc-hand paper ${isMyTurnPanel ? 'turn' : ''}">
      <div class="rc-hand-head">
        <div class="rc-hand-id">
          <span class="rc-hand-title">${heading}</span>
          <span class="rc-hand-score"><span class="rc-hand-pts">${p.points}</span><span class="rc-hand-target">/ ${target}点</span></span>
        </div>
        <div class="rc-hand-bar" aria-hidden="true"><span style="width:${Math.min(100, (p.points / target) * 100)}%"></span></div>
        <div class="rc-hand-meta">
          <span class="rc-hand-reserve">予約 ${p.reservedCount} / ${v.maxReserve}</span>
          <span class="rc-hand-regs">常連 ${regs}</span>
        </div>
      </div>
      <div class="rc-hand-tablewrap">
        <table class="rc-ingtable">
          <thead><tr><th class="rc-rowlabel" aria-hidden="true"></th>${th}</tr></thead>
          <tbody>
            <tr><th class="rc-rowlabel">割引</th>${bonusRow}</tr>
            <tr><th class="rc-rowlabel">チップ</th>${tokRow}</tr>
            <tr class="rc-row-use"><th class="rc-rowlabel">使える数</th>${useRow}</tr>
          </tbody>
        </table>
        <div class="rc-hand-total ${totCls}">手元のチップ <strong>${total} / ${v.handMax}</strong></div>
      </div>
      ${reserved ? `<div class="rc-hand-reserved"><span class="rc-plabel">予約したカード</span><div class="rc-hand-rcards">${reserved}</div></div>` : ''}
    </section>`;
}

// プレイヤー1人の欄
function playerPanel(v, ctx, p, me, myTurn, pending, flashId, floatPts) {
  if (!p) return '';
  const isMe = p.id === ctx.me;
  const flash = p.id === flashId ? 'rc-flash' : '';
  const float = (p.id === flashId && floatPts) ? `<span class="rc-float">+${floatPts}</span>` : '';
  const target = v.target || 15;
  const tokens = [...ingOrder(v), spiceId(v)].map(id =>
    `<span class="rc-ptok ${(p.tokens[id] || 0) === 0 ? 'zero' : ''}">${ingIcon(v, id, 'sm')}<span class="rc-ptok-n">${p.tokens[id] || 0}</span></span>`).join('');
  const bonuses = ingOrder(v).filter(id => (p.bonus[id] || 0) > 0)
    .map(id => `<span class="rc-pbonus">${ingIcon(v, id, 'sm')}<span class="rc-pbonus-n">${p.bonus[id]}</span></span>`).join('') || '<span class="muted">—</span>';
  const reserved = (p.reserved || []).map((r, i) => {
    if (r.card) {
      const canBuildIt = isMe && myTurn && !pending && payPlan(v, me, r.card).ok;
      const tap = (isMe && myTurn && !pending) ? `data-card="reserved" data-index="${i}"` : '';
      return cardHTML(v, r.card, { buildable: canBuildIt, tap, me: isMe ? me : null });
    }
    return deckPile(v, r.tier, '', ''); // 他人の山からの予約は裏向き
  }).join('');
  const regulars = (p.regulars || []).map(r =>
    `<span class="rc-preg" title="${esc0(r.name)}">${esc0(r.name)} +${r.points}</span>`).join('');

  return `
    <div class="rc-pcard ${p.isTurn ? 'turn' : ''} ${isMe ? 'me' : ''} ${flash}" data-member-id="${p.id}">
      ${float}
      <div class="rc-phead">
        <span class="rc-pname">${esc0(p.name)}${isMe ? '<span class="rc-you">あなた</span>' : ''}${p.left ? '<span class="rc-left">退席</span>' : ''}</span>
        <span class="rc-ppts">${p.points}<small>点</small></span>
      </div>
      <div class="rc-pbar" aria-hidden="true"><span style="width:${Math.min(100, (p.points / target) * 100)}%"></span></div>
      <div class="rc-prow"><span class="rc-plabel">手元</span><div class="rc-ptoks">${tokens}</div></div>
      <div class="rc-prow"><span class="rc-plabel">割引</span><div class="rc-pbonuses">${bonuses}</div></div>
      ${reserved ? `<div class="rc-prow"><span class="rc-plabel">予約</span><div class="rc-preserved">${reserved}</div></div>` : ''}
      ${regulars ? `<div class="rc-prow"><span class="rc-plabel">常連</span><div class="rc-pregs">${regulars}</div></div>` : ''}
    </div>`;
}

// 決着パネル（勝者を大きく・点数一覧）
function overPanel(v, ctx) {
  const winnerIds = v.winners || [];
  const names = (v.players || []).filter(p => winnerIds.includes(p.id)).map(p => p.id === ctx.me ? 'あなた' : esc0(p.name));
  const rows = (v.players || []).slice().sort((a, b) => b.points - a.points || a.builtCount - b.builtCount).map(p => `
    <div class="rc-over-row ${winnerIds.includes(p.id) ? 'win' : ''}">
      <span>${esc0(p.name)}${p.id === ctx.me ? '<span class="rc-you">あなた</span>' : ''}</span>
      <span class="rc-over-pts">${p.points}点<small>（レシピ${p.builtCount}）</small></span>
    </div>`).join('');
  return `
    <div class="rc-over paper">
      <div class="rc-over-win">🏆 ${names.join('・') || '—'} の勝ち！</div>
      <div class="rc-over-list">${rows}</div>
    </div>`;
}

function turnLabel(v, ctx) {
  if (v.over) {
    const names = (v.players || []).filter(p => (v.winners || []).includes(p.id)).map(p => p.id === ctx.me ? 'あなた' : p.name);
    return names.length ? `🏆 ${names.join('・')} の勝ち！` : '決着';
  }
  const cur = (v.players || []).find(p => p.id === v.turnId);
  return cur ? `${cur.id === ctx.me ? 'あなた' : esc0(cur.name)} の番` : '';
}

// ===== モーダル（カード詳細 / 戻す / 常連さん）=====
function modalHTML(v, ctx, me, myTurn, pending) {
  if (myTurn && pending && pending.type === 'discard') return discardModal(v, me, pending);
  if (myTurn && pending && pending.type === 'regular') return regularModal(v, pending);
  if (myTurn && openCard) return cardModal(v, me, openCard);
  return '';
}
function cardModal(v, me, oc) {
  let card = null, canBuild = false, canReserveThis = false, deckMode = false;
  if (oc.from === 'deck') { deckMode = true; canReserveThis = me.reservedCount < v.maxReserve; }
  else if (oc.from === 'market') { card = (v.market[oc.tier - 1] || [])[oc.index]; canReserveThis = me.reservedCount < v.maxReserve; }
  else if (oc.from === 'reserved') { const r = me.reserved[oc.index]; card = r && r.card; }
  if (!deckMode && !card) return '';

  let body;
  if (deckMode) {
    body = `<p class="rc-modal-deck">${esc0((v.tierNames || {})[oc.tier] || '')}の山から<strong>見ずに予約</strong>します。<br>中身は予約してから自分だけ見られます。</p>`;
  } else {
    const pp = payPlan(v, me, card);
    canBuild = pp.ok;
    const payParts = ingOrder(v).filter(id => pp.needs[id] > 0).map(id =>
      `<span class="rc-pay-one">${ingIcon(v, id, 'sm')}<span class="rc-pay-n">${pp.plan[id]}</span></span>`).join('');
    const spicePart = pp.spice > 0 ? `<span class="rc-pay-one spice">${ingIcon(v, spiceId(v), 'sm')}<span class="rc-pay-n">${pp.spice}</span></span>` : '';
    body = `
      <div class="rc-modal-card">${cardHTML(v, card)}</div>
      <div class="rc-modal-info">
        <div class="rc-modal-name">${esc0(card.name)}${card.points ? `（${card.points}点）` : ''}</div>
        <div class="rc-modal-row"><span>割引</span>${ingIcon(v, card.bonus, 'sm')} +1</div>
        <div class="rc-modal-row"><span>割引後に払う</span>${payParts || '<span class="muted">0</span>'}${spicePart}</div>
        ${!pp.ok ? '<div class="rc-modal-warn">材料が足りません</div>' : ''}
      </div>`;
  }
  return `<div class="rc-modal-bg" data-close-modal>
    <div class="rc-modal paper" role="dialog">
      ${body}
      <div class="rc-modal-btns">
        ${!deckMode && canBuild ? '<button class="btn primary rc-build">作る</button>' : ''}
        ${(deckMode || oc.from === 'market') && canReserveThis ? `<button class="btn ghost rc-reserve">${deckMode ? '見ずに予約する' : '予約する'}</button>` : ''}
        <button class="btn ghost small rc-close">閉じる</button>
      </div>
    </div>
  </div>`;
}
function discardModal(v, me, pending) {
  const total = Object.values(discardSel).reduce((a, n) => a + n, 0);
  const rows = [...ingOrder(v), spiceId(v)].filter(id => (me.tokens[id] || 0) > 0).map(id => {
    const picked = discardSel[id] || 0;
    return `<div class="rc-disc-row">
      ${ingIcon(v, id)}<span class="rc-disc-name">${esc0(nameOf(v, id))}</span>
      <span class="rc-disc-have">手元 ${me.tokens[id]}</span>
      <button class="btn ghost small rc-disc-minus" data-id="${id}" ${picked <= 0 ? 'disabled' : ''}>−</button>
      <span class="rc-disc-n">${picked}</span>
      <button class="btn ghost small rc-disc-plus" data-id="${id}" ${picked >= me.tokens[id] ? 'disabled' : ''}>＋</button>
    </div>`;
  }).join('');
  return `<div class="rc-modal-bg">
    <div class="rc-modal paper" role="dialog">
      <div class="rc-modal-name">チップを ${pending.over} 枚戻してください</div>
      <div class="rc-disc-list">${rows}</div>
      <div class="rc-modal-btns">
        <button class="btn primary rc-disc-ok" ${total === pending.over ? '' : 'disabled'}>戻す（${total}/${pending.over}）</button>
      </div>
    </div>
  </div>`;
}
function regularModal(v, pending) {
  const choices = pending.choices.map(id => v.regulars.find(r => r.id === id)).filter(Boolean);
  return `<div class="rc-modal-bg">
    <div class="rc-modal paper" role="dialog">
      <div class="rc-modal-name">来てもらう常連さんを選んでください</div>
      <div class="rc-reg-choices">${choices.map(r => regularHTML(v, r, 'choice', `data-regular="${r.id}"`)).join('')}</div>
    </div>
  </div>`;
}

// ===== 配線 =====
function wire(root, v, ctx, me, myTurn, pending) {
  if (!myTurn) return;

  // 銀行のチップ（取る選択）
  root.querySelectorAll('[data-chip]').forEach(el => {
    el.onclick = () => { clickChip(v, el.dataset.chip); };
  });
  const takeBtn = root.querySelector('.rc-take');
  if (takeBtn) takeBtn.onclick = () => { const m = takeMove(v); if (m) send(ctx, m); };
  const clearBtn = root.querySelector('.rc-clear');
  if (clearBtn) clearBtn.onclick = () => { sel = {}; rerender(); };
  const passBtn = root.querySelector('.rc-pass');
  if (passBtn) passBtn.onclick = () => send(ctx, { type: 'pass' });

  // カード・山・予約カードをタップ → モーダル
  root.querySelectorAll('[data-card]').forEach(el => {
    el.onclick = () => {
      const from = el.dataset.card;
      openCard = from === 'deck' ? { from, tier: Number(el.dataset.tier) }
        : from === 'market' ? { from, tier: Number(el.dataset.tier), index: Number(el.dataset.index) }
          : { from, index: Number(el.dataset.index) };
      rerender();
    };
  });

  // モーダルのボタン
  const bg = root.querySelector('[data-close-modal]');
  if (bg) bg.onclick = e => { if (e.target === bg) { openCard = null; rerender(); } };
  const closeBtn = root.querySelector('.rc-close');
  if (closeBtn) closeBtn.onclick = () => { openCard = null; rerender(); };
  const buildBtn = root.querySelector('.rc-build');
  if (buildBtn) buildBtn.onclick = () => {
    if (!openCard) return;
    const action = openCard.from === 'reserved'
      ? { type: 'build', from: 'reserved', index: openCard.index }
      : { type: 'build', from: 'market', tier: openCard.tier, index: openCard.index };
    send(ctx, action);
  };
  const reserveBtn = root.querySelector('.rc-reserve');
  if (reserveBtn) reserveBtn.onclick = () => {
    if (!openCard) return;
    const action = openCard.from === 'deck'
      ? { type: 'reserve', tier: openCard.tier, index: 'deck' }
      : { type: 'reserve', tier: openCard.tier, index: openCard.index };
    send(ctx, action);
  };

  // 戻す（discard）
  root.querySelectorAll('.rc-disc-plus').forEach(b => b.onclick = () => { const id = b.dataset.id; discardSel[id] = (discardSel[id] || 0) + 1; rerender(); });
  root.querySelectorAll('.rc-disc-minus').forEach(b => b.onclick = () => { const id = b.dataset.id; discardSel[id] = Math.max(0, (discardSel[id] || 0) - 1); if (!discardSel[id]) delete discardSel[id]; rerender(); });
  const discOk = root.querySelector('.rc-disc-ok');
  if (discOk) discOk.onclick = () => send(ctx, { type: 'discard', tokens: { ...discardSel } });

  // 常連さんを選ぶ
  root.querySelectorAll('[data-regular]').forEach(el => el.onclick = () => send(ctx, { type: 'chooseRegular', id: el.dataset.regular }));
}

function clickChip(v, id) {
  if (id === spiceId(v)) return;           // スパイスは取れない
  if (v.bank[id] <= 0) return;
  const colors = Object.keys(sel);
  const total = colors.reduce((a, c) => a + sel[c], 0);
  const has2 = colors.some(c => sel[c] === 2);
  const cur = sel[id] || 0;
  if (cur === 0) {
    if (has2 || total >= 3) return;        // take2中は追加不可・3枚まで
    sel[id] = 1;
  } else if (cur === 1) {
    if (colors.length === 1 && v.bank[id] >= 4) sel[id] = 2; // 同色2枚（4枚以上あるとき）
    else delete sel[id];
  } else {
    delete sel[id];
  }
  rerender();
}

async function send(ctx, action) {
  // 送ったら選択は閉じる（結果は broadcast で反映）
  sel = {}; openCard = null; discardSel = {};
  const res = await ctx.send(action);
  if (res && res.error) rerender(); // エラー時は元の画面に戻す（toast は基盤が出す）
}
