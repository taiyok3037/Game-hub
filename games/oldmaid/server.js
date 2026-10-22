// ババ抜き（トランプの例：自分の手札だけが見え、他人の手札は枚数しか見えない）
const SUITS = ['♠', '♥', '♦', '♣'];
const RANKS = ['A', '2', '3', '4', '5', '6', '7', '8', '9', '10', 'J', 'Q', 'K'];

function shuffle(arr) {
  for (let i = arr.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [arr[i], arr[j]] = [arr[j], arr[i]];
  }
  return arr;
}

// 手札からペアを全部捨てる
function discardPairs(hand) {
  const byRank = {};
  for (const c of hand) (byRank[c.r] ||= []).push(c);
  const keep = [];
  for (const cards of Object.values(byRank)) {
    if (cards.length % 2 === 1) keep.push(cards[0]);
  }
  return shuffle(keep);
}

function isActive(state, i) {
  return state.hands[i].length > 0;
}

// seat の次に手札が残っている人（いなければ -1）
function nextActive(state, seat) {
  const n = state.players.length;
  for (let k = 1; k <= n; k++) {
    const i = (seat + k) % n;
    if (isActive(state, i)) return i;
  }
  return -1;
}

function checkFinish(state, seat) {
  if (state.hands[seat].length === 0 && !state.finished.includes(seat)) state.finished.push(seat);
}

function checkGameOver(state) {
  const remaining = state.players.map((_, i) => i).filter(i => isActive(state, i));
  if (remaining.length <= 1) {
    state.loser = remaining.length === 1 ? remaining[0] : null;
    return true;
  }
  return false;
}

module.exports = {
  id: 'oldmaid',
  name: 'ババ抜き',
  description: '隣の人からカードを引いてペアを捨てる。最後にジョーカーを持っていた人の負け',
  category: 'トランプ',
  cover: { color: '#2e6b4f', mark: '♥', markColor: '#c0462c' },
  minPlayers: 2,
  maxPlayers: 6,

  setup(players) {
    const deck = [];
    for (const s of SUITS) for (const r of RANKS) deck.push({ r, s });
    deck.push({ r: 'JOKER', s: '🃏' });
    shuffle(deck);

    const order = shuffle([...players]);
    const hands = order.map(() => []);
    deck.forEach((c, i) => hands[i % order.length].push(c));

    const state = {
      players: order,
      hands: hands.map(discardPairs),
      finished: [],     // 上がった順の席番号
      turn: 0,
      loser: null,
      over: false,
      log: ['配り終えて、最初のペアを捨てました'],
      lastDraw: null,   // 直前に引いた情報（引いた本人にだけカードを見せる）
    };
    state.hands.forEach((_, i) => checkFinish(state, i));
    if (checkGameOver(state)) state.over = true;
    else if (!isActive(state, 0)) state.turn = nextActive(state, 0);
    return state;
  },

  action(state, playerId, action) {
    const seat = state.players.findIndex(p => p.id === playerId);
    if (seat === -1) return { error: 'このゲームの参加者ではありません' };

    // 自分の手札を並べ替える（いつでもOK。相手に引かれる位置が変わる）
    if (action.type === 'shuffle') {
      shuffle(state.hands[seat]);
      return;
    }

    if (action.type !== 'draw') return { error: '不明な操作です' };
    if (seat !== state.turn) return { error: 'あなたの番ではありません' };

    const target = nextActive(state, seat);
    const tHand = state.hands[target];
    const i = action.index;
    if (!Number.isInteger(i) || i < 0 || i >= tHand.length) return { error: 'そのカードは引けません' };

    const [card] = tHand.splice(i, 1);
    const me = state.hands[seat];
    const pairIdx = me.findIndex(c => c.r === card.r);
    const name = state.players[seat].name;
    const tName = state.players[target].name;

    if (pairIdx !== -1 && card.r !== 'JOKER') {
      me.splice(pairIdx, 1);
      state.log.push(`${name} が ${tName} から引いて、ペアを捨てた`);
      state.lastDraw = { by: seat, card, paired: true };
    } else {
      me.push(card);
      shuffle(me);
      state.log.push(`${name} が ${tName} から引いた`);
      state.lastDraw = { by: seat, card, paired: false };
    }

    const before = state.finished.length;
    checkFinish(state, target);
    checkFinish(state, seat);
    for (const s of state.finished.slice(before)) {
      state.log.push(`🎉 ${state.players[s].name} が上がり！（${state.finished.indexOf(s) + 1}位）`);
    }

    if (checkGameOver(state)) {
      state.over = true;
      if (state.loser !== null) state.log.push(`💀 ${state.players[state.loser].name} の負け…`);
    } else {
      state.turn = nextActive(state, seat);
    }
    state.log = state.log.slice(-8);
  },

  view(state, playerId) {
    const seat = state.players.findIndex(p => p.id === playerId);
    const target = state.over ? -1 : nextActive(state, state.turn);
    return {
      players: state.players.map((p, i) => ({
        id: p.id,
        name: p.name,
        count: state.hands[i].length,                    // 他人は枚数だけ
        rank: state.finished.includes(i) ? state.finished.indexOf(i) + 1 : null,
      })),
      myHand: seat === -1 ? [] : state.hands[seat],     // 自分の手札だけ中身を送る
      currentId: state.over ? null : state.players[state.turn].id,
      targetId: target === -1 ? null : state.players[target].id,
      loserId: state.loser === null ? null : state.players[state.loser].id,
      over: state.over,
      log: state.log,
      // 自分が直前に引いたカードだけ教える
      myLastDraw: state.lastDraw && state.lastDraw.by === seat ? state.lastDraw : null,
    };
  },

  isOver(state) {
    return state.over;
  },

  // 抜けた人の手札は次の人に渡して続行
  onLeave(state, playerId) {
    if (state.over) return;
    const seat = state.players.findIndex(p => p.id === playerId);
    if (seat === -1) return;
    const name = state.players[seat].name;
    const heir = nextActive(state, seat);
    if (heir !== -1 && heir !== seat) {
      state.hands[heir] = discardPairs([...state.hands[heir], ...state.hands[seat]]);
    }
    const turnPlayer = state.players[state.turn];
    state.players.splice(seat, 1);
    state.hands.splice(seat, 1);
    state.finished = state.finished.filter(s => s !== seat).map(s => (s > seat ? s - 1 : s));
    state.players.forEach((_, i) => checkFinish(state, i));
    state.log.push(`${name} が抜けたので、手札を次の人に渡しました`);
    if (checkGameOver(state)) {
      state.over = true;
      return;
    }
    let t = state.players.indexOf(turnPlayer);
    if (t === -1) t = seat % state.players.length;
    state.turn = isActive(state, t) ? t : nextActive(state, t);
  },
};
