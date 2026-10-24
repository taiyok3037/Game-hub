// =============================================================
//  喫茶店のレシピ帳（材料チップを集めてレシピカードを作るボードゲーム）
//  - 自分の番に「材料を取る／予約する／作る」のどれか1つ。作ると割引(bonus)が永久に増える
//  - 割引の組み合わせがそろうと常連さんが来店して +3点。先に目標点でその周の最後まで回して決着
//  ルール判定はすべてここ（action）で行う。隠し情報は view/spectatorView で外す。
//  カードは games/recipe/data/cards.json（バランス確認済み・中身は変えない）だけを使う。
//  乱数は setup で注入できる（テスト再現用）。
// =============================================================
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

// ---------- データの読み込みと検証（起動時に1回） ----------
const DATA = JSON.parse(fs.readFileSync(path.join(__dirname, 'data', 'cards.json'), 'utf8'));
const INGREDIENTS_META = DATA.ingredients;             // [{id,name,color} x5]
const INGREDIENTS = INGREDIENTS_META.map(i => i.id);   // ['coffee','milk','matcha','berry','honey']
const WILD = DATA.wild;                                // {id:'spice',...}
const TIER_NAMES = DATA.tierNames;                     // {1,2,3}
const CARDS = DATA.cards;
const REGULARS = DATA.regulars;
const TOKEN_COLORS = [...INGREDIENTS, WILD.id];        // 6種（材料5＋スパイス）
(function validateData() {
  if (INGREDIENTS.length !== 5) throw new Error('recipe: 材料が5種類ではありません');
  const byTier = { 1: 0, 2: 0, 3: 0 };
  for (const c of CARDS) byTier[c.tier] = (byTier[c.tier] || 0) + 1;
  if (byTier[1] !== 40 || byTier[2] !== 30 || byTier[3] !== 20) throw new Error(`recipe: 段階ごとの枚数が 40/30/20 ではありません (${byTier[1]}/${byTier[2]}/${byTier[3]})`);
  if (REGULARS.length !== 10) throw new Error('recipe: 常連さんが10人ではありません');
})();

const MARKET_SIZE = 4;   // 各段階で表向きに並べる枚数
const RESERVE_MAX = 3;   // 予約の上限
const HAND_MAX = 10;     // 手元のチップ（スパイス込み）の上限
const MAX_ROUNDS = 100;  // 念のための打ち切り
const TIME_SCALE = Number(process.env.RECIPE_TIME_SCALE) || 1;

const defaultRng = () => crypto.randomInt(0, 1e9) / 1e9;

// ---------- 小道具 ----------
function shuffle(arr, rng) {
  for (let i = arr.length - 1; i > 0; i--) {
    const j = Math.floor(rng() * (i + 1));
    [arr[i], arr[j]] = [arr[j], arr[i]];
  }
  return arr;
}
const pname = (state, seat) => (state.players[seat] || {}).name || '?';
const zero5 = () => INGREDIENTS.reduce((o, c) => (o[c] = 0, o), {});
const zero6 = () => TOKEN_COLORS.reduce((o, c) => (o[c] = 0, o), {});
const tokenCount = s => TOKEN_COLORS.reduce((a, c) => a + s.tokens[c], 0);
const activeSeats = state => state.seats.map((_, i) => i).filter(i => !state.left[i]);
const ingName = id => (INGREDIENTS_META.find(i => i.id === id) || {}).name || id;

// ---------- 設定 ----------
function normalizeOptions(o) {
  o = o || {};
  const target = Number.isInteger(o.target) ? Math.min(21, Math.max(10, o.target)) : 15;
  const turnTime = [30, 60, 90, 0].includes(o.turnTime) ? o.turnTime : 60;
  return { target, turnTime };
}
function turnDeadline(state) {
  const t = state.options.turnTime;
  return (state.phase === 'play' && t > 0) ? Date.now() + t * 1000 * TIME_SCALE : null;
}

// ---------- カード・山 ----------
function drawToMarket(state, tierIdx, slot) {
  const deck = state.decks[tierIdx];
  state.market[tierIdx][slot] = deck.length ? deck.pop() : null;
}
const anyMarketCard = state => state.market.some(row => row.some(c => c));

// ---------- 支払いの計算（割引→材料→スパイスの順） ----------
function payPlan(seat, card) {
  const s = card;
  const plan = zero5();
  let spice = 0;
  for (const ing of INGREDIENTS) {
    const need = Math.max(0, (s.cost[ing] || 0) - seat.bonus[ing]); // 割引後に要る数
    const fromIng = Math.min(need, seat.tokens[ing]);               // まず材料で払う
    plan[ing] = fromIng;
    spice += need - fromIng;                                        // 足りない分はスパイス
  }
  return { ok: spice <= seat.tokens[WILD.id], plan, spice };
}
function canBuildAny(state, seat) {
  const s = state.seats[seat];
  for (const row of state.market) for (const c of row) if (c && payPlan(s, c).ok) return true;
  for (const r of s.reserved) if (payPlan(s, r.card).ok) return true;
  return false;
}
function hasLegalMove(state, seat) {
  const s = state.seats[seat];
  if (INGREDIENTS.some(c => state.bank[c] > 0)) return true;                 // 材料を取れる（3種）
  if (s.reserved.length < RESERVE_MAX && (anyMarketCard(state) || state.decks.some(d => d.length))) return true; // 予約できる
  return canBuildAny(state, seat);                                          // 作れる
}

// ---------- 常連さん ----------
function satisfiedRegulars(state, seat) {
  const s = state.seats[seat];
  return state.regulars.filter(r => Object.entries(r.needs).every(([ing, n]) => (s.bonus[ing] || 0) >= n)).map(r => r.id);
}
function awardRegular(state, seat, id) {
  const idx = state.regulars.findIndex(r => r.id === id);
  if (idx === -1) return;
  const r = state.regulars.splice(idx, 1)[0];
  state.seats[seat].regulars.push(r);
  state.seats[seat].points += r.points;
  state.last = { seq: ++state.seq, seat, type: 'regular', name: r.name, points: r.points };
  state.log.push(`${pname(state, seat)}：常連の「${r.name}」が来店（+${r.points}点）`);
  checkFinal(state, seat);
}

// ---------- 番の進行 ----------
function checkFinal(state, seat) {
  if (state.seats[seat].points >= state.options.target) state.finalRound = true;
}
// メイン操作のあと：10枚超なら戻す → 常連さん → 次へ
function afterMainAction(state, seat) {
  const over = tokenCount(state.seats[seat]) - HAND_MAX;
  if (over > 0) { state.pending = { type: 'discard', over }; state.deadlineAt = turnDeadline(state); return; }
  afterDiscard(state, seat);
}
function afterDiscard(state, seat) {
  const choices = satisfiedRegulars(state, seat);
  if (choices.length > 1) { state.pending = { type: 'regular', choices }; state.deadlineAt = turnDeadline(state); return; }
  if (choices.length === 1) awardRegular(state, seat, choices[0]);
  advanceTurn(state);
}
function advanceTurn(state) {
  state.pending = null;
  const n = state.order.length;
  for (let guard = 0; guard <= n; guard++) {
    state.turnIdx++;
    if (state.turnIdx >= n) {
      state.turnIdx = 0;
      state.round++;
      if (state.finalRound || state.round > MAX_ROUNDS) { endGame(state); return; }
    }
    if (!state.left[state.order[state.turnIdx]]) break;
  }
  state.deadlineAt = turnDeadline(state);
}
function endGame(state) {
  state.phase = 'over';
  state.pending = null;
  state.deadlineAt = null;
  const active = activeSeats(state);
  if (!active.length) { state.winners = []; return; }
  const maxPts = Math.max(...active.map(i => state.seats[i].points));
  const top = active.filter(i => state.seats[i].points === maxPts);
  const minBuilt = Math.min(...top.map(i => state.seats[i].built.length)); // 同点は作ったレシピが少ない方
  state.winners = top.filter(i => state.seats[i].built.length === minBuilt);
  const names = state.winners.map(i => pname(state, i)).join('・');
  state.log.push(`🏆 ${names} の勝ち！`);
  state.last = { seq: ++state.seq, type: 'over' };
}
function autoDiscard(state, seat, over) {
  const s = state.seats[seat];
  let remain = over;
  while (remain > 0) {
    let best = null;
    for (const c of TOKEN_COLORS) if (s.tokens[c] > 0 && (best === null || s.tokens[c] > s.tokens[best])) best = c;
    if (best === null) break;
    s.tokens[best]--; state.bank[best]++; remain--;
  }
}

// ---------- view ----------
function viewPlayer(state, i, viewerSeat, seesAll) {
  const s = state.seats[i];
  const p = state.players[i];
  const reserved = s.reserved.map(r => {
    const reveal = !r.hidden || i === viewerSeat || seesAll;
    return reveal ? { hidden: r.hidden, card: r.card } : { hidden: true, tier: r.card.tier };
  });
  return {
    id: p.id, name: p.name,
    points: s.points,
    bonus: { ...s.bonus },
    tokens: { ...s.tokens },
    tokenCount: tokenCount(s),
    builtCount: s.built.length,
    reserved, reservedCount: s.reserved.length,
    regulars: s.regulars.map(r => ({ ...r })),
    isTurn: state.phase === 'play' && state.order[state.turnIdx] === i,
    left: !!state.left[i],
  };
}
function buildView(state, viewerSeat, seesAll) {
  const cur = state.order[state.turnIdx];
  const v = {
    phase: state.phase,
    over: state.phase === 'over',
    round: state.round,
    finalRound: !!state.finalRound,
    target: state.options.target,
    turnTime: state.options.turnTime,
    handMax: HAND_MAX, maxReserve: RESERVE_MAX,
    ingredients: INGREDIENTS_META, ingredientOrder: INGREDIENTS, wild: WILD, tierNames: TIER_NAMES,
    bank: { ...state.bank },
    market: state.market.map(row => row.map(c => (c ? { ...c } : null))),
    deckCounts: state.decks.map(d => d.length),
    regulars: state.regulars.map(r => ({ ...r })),
    turnId: state.phase === 'play' ? (state.players[cur] || {}).id || null : null,
    turnSeat: cur,
    deadline: state.deadlineAt,
    last: state.last,
    log: state.log.slice(-14),
    you: viewerSeat,
    players: state.seats.map((_, i) => viewPlayer(state, i, viewerSeat, seesAll)),
  };
  if (state.phase === 'over') v.winners = state.winners.map(seat => (state.players[seat] || {}).id);
  // pending は、解消すべき本人（手番の人）だけに送る
  if (state.phase === 'play' && viewerSeat === cur && state.pending) v.pending = state.pending;
  return v;
}

module.exports = {
  id: 'recipe',
  name: '喫茶店のレシピ帳',
  description: '材料を集めてレシピを作り、割引を増やして看板メニューへ。常連さんにも来てもらおう！',
  category: 'ボード',
  cover: { color: '#6b4226', mark: '珈', markColor: '#2a1a10' },
  minPlayers: 2,
  maxPlayers: 4,

  options: [
    { key: 'target', label: '勝利点', type: 'int', min: 10, max: 21, default: 15 },
    {
      key: 'turnTime', label: '1ターンの制限時間', type: 'select', default: 60,
      choices: [
        { value: 30, label: '30秒' }, { value: 60, label: '60秒' },
        { value: 90, label: '90秒' }, { value: 0, label: 'なし' },
      ],
    },
  ],

  setup(players, options, { rng } = {}) {
    rng = rng || defaultRng;
    const n = players.length;
    const opt = normalizeOptions(options);
    const perColor = n <= 2 ? 4 : n === 3 ? 5 : 7;
    const bank = zero6();
    for (const ing of INGREDIENTS) bank[ing] = perColor;
    bank[WILD.id] = 5;

    // 段階ごとに山を作り、各段階から MARKET_SIZE 枚を場に並べる
    const decks = [1, 2, 3].map(t => shuffle(CARDS.filter(c => c.tier === t).map(c => ({ ...c })), rng));
    const market = decks.map(deck => {
      const face = deck.splice(0, MARKET_SIZE);
      while (face.length < MARKET_SIZE) face.push(null);
      return face;
    });
    const regulars = shuffle(REGULARS.map(r => ({ ...r })), rng).slice(0, n + 1);
    const order = shuffle(players.map((_, i) => i), rng);

    return {
      players,
      options: opt,
      order,
      turnIdx: 0,
      round: 1,
      bank,
      decks,
      market,
      regulars,
      left: players.map(() => false),
      seats: players.map(() => ({ tokens: zero6(), bonus: zero5(), points: 0, built: [], reserved: [], regulars: [] })),
      pending: null,
      phase: 'play',
      finalRound: false,
      winners: [],
      last: null,
      seq: 0,
      deadlineAt: turnDeadline({ phase: 'play', options: opt }),
      log: [],
    };
  },

  action(state, playerId, action, room) {
    if (state.phase !== 'play') return { error: 'ゲーム中ではありません' };
    const seat = state.players.findIndex(p => p.id === playerId);
    if (seat === -1) return { error: 'このゲームの参加者ではありません' };
    if (state.left[seat]) return { error: '退席しています' };
    if (state.order[state.turnIdx] !== seat) return { error: 'あなたの番ではありません' };
    const s = state.seats[seat];

    if (state.pending) {
      if (state.pending.type === 'discard' && action.type !== 'discard') return { error: '先にチップを戻してください' };
      if (state.pending.type === 'regular' && action.type !== 'chooseRegular') return { error: '先に常連さんを選んでください' };
    } else if (action.type === 'discard' || action.type === 'chooseRegular') {
      return { error: '今はできません' };
    }

    switch (action.type) {
      case 'take3': {
        const colors = Array.isArray(action.colors) ? action.colors : [];
        if (colors.some(c => !INGREDIENTS.includes(c))) return { error: '材料ではありません' };
        if (new Set(colors).size !== colors.length) return { error: '違う材料を選んでください' };
        if (colors.some(c => state.bank[c] < 1)) return { error: '場にない材料は取れません' };
        const avail = INGREDIENTS.filter(c => state.bank[c] > 0).length;
        if (colors.length !== Math.min(3, avail)) return { error: `材料は${Math.min(3, avail)}種類を取ってください` };
        for (const c of colors) { state.bank[c]--; s.tokens[c]++; }
        state.last = { seq: ++state.seq, seat, type: 'take', colors };
        state.log.push(`${pname(state, seat)}：${colors.map(ingName).join('・')}を取った`);
        afterMainAction(state, seat);
        return;
      }
      case 'take2': {
        const c = action.color;
        if (!INGREDIENTS.includes(c)) return { error: '材料ではありません' };
        if (state.bank[c] < 4) return { error: 'その材料が4枚以上あるときだけ2つ取れます' };
        state.bank[c] -= 2; s.tokens[c] += 2;
        state.last = { seq: ++state.seq, seat, type: 'take', colors: [c, c] };
        state.log.push(`${pname(state, seat)}：${ingName(c)}を2つ取った`);
        afterMainAction(state, seat);
        return;
      }
      case 'reserve': {
        if (s.reserved.length >= RESERVE_MAX) return { error: `予約は${RESERVE_MAX}枚までです` };
        const tierIdx = Number(action.tier) - 1;
        if (!(tierIdx >= 0 && tierIdx <= 2)) return { error: '段階が不正です' };
        let card, hidden;
        if (action.index === 'deck') {
          const deck = state.decks[tierIdx];
          if (!deck.length) return { error: 'その山は空です' };
          card = deck.pop(); hidden = true;
        } else {
          const idx = Number(action.index);
          if (!(idx >= 0 && idx < MARKET_SIZE) || !state.market[tierIdx][idx]) return { error: 'そのカードは予約できません' };
          card = state.market[tierIdx][idx]; hidden = false;
          drawToMarket(state, tierIdx, idx);
        }
        s.reserved.push({ card, hidden });
        if (state.bank[WILD.id] > 0) { state.bank[WILD.id]--; s.tokens[WILD.id]++; } // スパイスが残っていれば1枚
        state.last = { seq: ++state.seq, seat, type: 'reserve', tier: card.tier };
        state.log.push(`${pname(state, seat)}：レシピを予約した`);
        afterMainAction(state, seat);
        return;
      }
      case 'build': {
        let card, remove;
        if (action.from === 'reserved') {
          const idx = Number(action.index);
          if (!(idx >= 0 && idx < s.reserved.length)) return { error: 'その予約はありません' };
          card = s.reserved[idx].card;
          remove = () => s.reserved.splice(idx, 1);
        } else if (action.from === 'market') {
          const tierIdx = Number(action.tier) - 1;
          const idx = Number(action.index);
          if (!(tierIdx >= 0 && tierIdx <= 2) || !(idx >= 0 && idx < MARKET_SIZE) || !state.market[tierIdx][idx]) return { error: 'そのカードはありません' };
          card = state.market[tierIdx][idx];
          remove = () => drawToMarket(state, tierIdx, idx);
        } else return { error: 'どこから作るか不明です' };
        const { ok, plan, spice } = payPlan(s, card);
        if (!ok) return { error: '材料が足りません' };
        for (const ing of INGREDIENTS) { s.tokens[ing] -= plan[ing]; state.bank[ing] += plan[ing]; }
        s.tokens[WILD.id] -= spice; state.bank[WILD.id] += spice;
        remove();
        s.built.push(card);
        s.bonus[card.bonus]++;
        s.points += card.points;
        state.last = { seq: ++state.seq, seat, type: 'build', tier: card.tier, name: card.name, points: card.points, bonus: card.bonus };
        state.log.push(`${pname(state, seat)}：「${card.name}」を作った${card.points ? `（+${card.points}点）` : ''}`);
        checkFinal(state, seat);
        afterMainAction(state, seat);
        return;
      }
      case 'discard': {
        const t = action.tokens || {};
        let sum = 0;
        for (const [c, nn] of Object.entries(t)) {
          if (!TOKEN_COLORS.includes(c)) return { error: '不正なチップです' };
          const n = Number(nn);
          if (!Number.isInteger(n) || n < 0) return { error: '不正な枚数です' };
          if (n > s.tokens[c]) return { error: '持っていない分は戻せません' };
          sum += n;
        }
        if (sum !== state.pending.over) return { error: `ちょうど${state.pending.over}枚戻してください` };
        for (const [c, nn] of Object.entries(t)) { const n = Number(nn); s.tokens[c] -= n; state.bank[c] += n; }
        state.pending = null;
        state.last = { seq: ++state.seq, seat, type: 'discard' };
        afterDiscard(state, seat);
        return;
      }
      case 'chooseRegular': {
        if (!state.pending.choices.includes(action.id)) return { error: 'その常連さんは選べません' };
        state.pending = null;
        awardRegular(state, seat, action.id);
        advanceTurn(state);
        return;
      }
      case 'pass': {
        if (hasLegalMove(state, seat)) return { error: 'まだできることがあります' };
        state.last = { seq: ++state.seq, seat, type: 'pass' };
        state.log.push(`${pname(state, seat)} はパス`);
        advanceTurn(state);
        return;
      }
      default:
        return { error: '不明な操作です' };
    }
  },

  view(state, playerId) {
    const seat = state.players.findIndex(p => p.id === playerId);
    return buildView(state, seat, false);
  },

  spectatorView(state, { seesAll, viewerId }) {
    const v = buildView(state, -1, !!seesAll);
    v.spectator = true;
    v.viewerId = viewerId;
    return v;
  },

  isOver(state) {
    return state.phase === 'over';
  },

  isOut(state, playerId) {
    const seat = state.players.findIndex(p => p.id === playerId);
    if (seat === -1) return true;
    return !!state.left[seat];
  },

  turnOf(state) {
    if (state.phase !== 'play') return [];
    return [(state.players[state.order[state.turnIdx]] || {}).id].filter(Boolean);
  },

  deadline(state) {
    return state.deadlineAt;
  },

  onTimeout(state) {
    if (state.phase !== 'play') return;
    const seat = state.order[state.turnIdx];
    if (state.pending && state.pending.type === 'discard') {
      autoDiscard(state, seat, state.pending.over);
      state.pending = null;
      state.log.push(`${pname(state, seat)}：時間切れでチップを戻した`);
      afterDiscard(state, seat);
    } else if (state.pending && state.pending.type === 'regular') {
      const id = state.pending.choices[0];
      state.pending = null;
      awardRegular(state, seat, id);
      advanceTurn(state);
    } else {
      state.log.push(`${pname(state, seat)} は時間切れでパス`);
      advanceTurn(state);
    }
  },

  onLeave(state, playerId) {
    const seat = state.players.findIndex(p => p.id === playerId);
    if (seat === -1 || state.phase === 'over') return;
    const wasTurn = state.order[state.turnIdx] === seat;
    state.left[seat] = true;
    const s = state.seats[seat];
    for (const c of TOKEN_COLORS) { state.bank[c] += s.tokens[c]; s.tokens[c] = 0; } // チップは場へ
    s.reserved = []; // 予約は捨てる（山へは戻さない）
    state.log.push(`${pname(state, seat)} が退席しました`);
    if (activeSeats(state).length <= 1) { endGame(state); return; }
    if (wasTurn) { state.pending = null; advanceTurn(state); }
  },
};
