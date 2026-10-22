// =============================================================
//  きゅうり（デンマークの Agurk）
//  - 52枚、A が最強（A=14, K=13, Q=12, J=11, 他は数字どおり）。スートは無関係
//  - 1回の配りで各自7枚、7トリック行う
//  - リード（最初の人）は何を出してもよい
//  - 他の人は「場の最高札と同じか、それより強い札」か「自分の手札で一番弱い札」を出す
//  - トリックは一番強い札を出した人の勝ち（同じ強さなら後に出した人）。勝った人が次のリード
//  - 最後（7回目）のトリックを取った人が、その札の数字ぶん失点
//    同じトリックで同じ数字を出していた人は、その点数ぶん減点される（0未満にはならない）
//  - 21点以上になると「きゅうり」1本（ライフを1つ失う）→ 他の人の最高点に戻って続行
//    2本目で脱落。最後の1人が勝ち
// =============================================================
const readyCheck = require('../../lib/readyCheck');

const SUITS = ['♠', '♥', '♦', '♣'];
const RANKS = ['2', '3', '4', '5', '6', '7', '8', '9', '10', 'J', 'Q', 'K', 'A'];
const HAND_SIZE = 7;
const LIMIT = 21;

function shuffle(arr) {
  for (let i = arr.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [arr[i], arr[j]] = [arr[j], arr[i]];
  }
  return arr;
}

function newDeck() {
  const deck = [];
  for (const s of SUITS) RANKS.forEach((r, i) => deck.push({ r, s, v: i + 2 }));
  return shuffle(deck);
}

const alive = state => state.players.map((_, i) => i).filter(i => !state.out[i]);

function nextAlive(state, seat) {
  const n = state.players.length;
  for (let k = 1; k <= n; k++) {
    const i = (seat + k) % n;
    if (!state.out[i]) return i;
  }
  return -1;
}

// 出せるカードの判定
function legalIndexes(state, seat) {
  const hand = state.hands[seat];
  const plays = state.trick.plays;
  if (plays.length === 0) return hand.map((_, i) => i); // リードは自由
  const highest = Math.max(...plays.map(p => p.card.v));
  const lowest = Math.min(...hand.map(c => c.v));
  return hand.map((c, i) => i).filter(i => hand[i].v >= highest || hand[i].v === lowest);
}

function deal(state) {
  const deck = newDeck();
  state.hands = state.players.map(() => []);
  for (const seat of alive(state)) {
    state.hands[seat] = deck.splice(0, HAND_SIZE).sort((a, b) => a.v - b.v);
  }
  state.trickNo = 1;
  const leader = nextAlive(state, state.dealer);
  state.trick = { leader, plays: [] };
  state.lastTrick = null;
  state.turn = leader;
  state.phase = 'play';
  state.result = null;
  state.ready = [];
  state.log.push(`${state.players[state.dealer].name} が配りました（第${++state.handNo}回）`);
}

// 準備OK（次の配りに「準備OK」が必要な人＝脱落しておらず、かつ接続中）
const ready = readyCheck(state => {
  const conn = state.connectedIds || state.players.map(p => p.id);
  return state.players.map((_, i) => i).filter(i => !state.out[i] && conn.includes(state.players[i].id));
});

// result 中で全員そろっていれば次の配りへ。配ったら true
function maybeDeal(state) {
  if (state.phase === 'result' && ready.isAllReady(state)) {
    deal(state);
    state.log = state.log.slice(-10);
    return true;
  }
  return false;
}

function finishHand(state, winnerSeat, plays) {
  const card = plays.find(p => p.seat === winnerSeat && p.card.v === Math.max(...plays.map(q => q.card.v))).card;
  const penalty = card.v;
  const loserName = state.players[winnerSeat].name;
  state.scores[winnerSeat] += penalty;
  state.log.push(`${loserName} が最後のトリックを取って +${penalty}点`);

  // 同じ数字を出していた人はボーナス（減点）
  const bonusSeats = plays.filter(p => p.seat !== winnerSeat && p.card.v === card.v).map(p => p.seat);
  for (const s of bonusSeats) {
    state.scores[s] = Math.max(0, state.scores[s] - penalty);
    state.log.push(`${state.players[s].name} は同じ数字なので -${penalty}点`);
  }

  // 21点以上：きゅうり1本目なら他の人の最高点に戻る、2本目なら脱落
  let lifeLost = false;
  let eliminated = false;
  let resetTo = null;
  if (state.scores[winnerSeat] >= LIMIT) {
    if (state.cucumbers[winnerSeat] === 0) {
      state.cucumbers[winnerSeat] = 1;
      const others = alive(state).filter(i => i !== winnerSeat).map(i => state.scores[i]);
      resetTo = others.length ? Math.max(...others) : 0;
      state.scores[winnerSeat] = resetTo;
      lifeLost = true;
      state.log.push(`🥒 ${loserName} がきゅうり1本目！ ${resetTo}点からやり直し`);
    } else {
      state.cucumbers[winnerSeat] = 2;
      state.out[winnerSeat] = true;
      eliminated = true;
      state.log.push(`🥒🥒 ${loserName} は2本目のきゅうりで脱落…`);
    }
  }

  state.result = { loser: winnerSeat, card, penalty, bonusSeats, lifeLost, eliminated, resetTo };

  const rest = alive(state);
  if (rest.length <= 1) {
    state.phase = 'over';
    state.winner = rest.length === 1 ? rest[0] : null;
    if (state.winner !== null) state.log.push(`🏆 ${state.players[state.winner].name} の勝ち！`);
  } else {
    state.phase = 'result';
    state.ready = []; // 次の配りに向けて準備OKをリセット
    state.dealer = nextAlive(state, state.dealer);
  }
}

module.exports = {
  id: 'cucumber',
  name: 'きゅうり',
  description: '最後のトリックだけは取りたくない！ 21点を2回超えたら脱落する、デンマークのトランプゲーム',
  category: 'トランプ',
  cover: { color: '#4f7d2f', mark: 'A', markColor: '#2a1a10' },
  minPlayers: 2,
  maxPlayers: 7,

  setup(players) {
    const state = {
      players,
      scores: players.map(() => 0),
      cucumbers: players.map(() => 0), // 0, 1, 2(脱落)
      out: players.map(() => false),
      left: players.map(() => false),
      dealer: Math.floor(Math.random() * players.length),
      handNo: 0,
      hands: [],
      trick: null,
      trickNo: 0,
      lastTrick: null,
      turn: 0,
      phase: 'play', // 'play' | 'result' | 'over'
      result: null,
      winner: null,
      ready: [],                           // 準備OKを押した席番号
      connectedIds: players.map(p => p.id), // 接続中の人（needIds 用）
      log: [],
    };
    deal(state);
    return state;
  },

  action(state, playerId, action, room) {
    const seat = state.players.findIndex(p => p.id === playerId);
    if (seat === -1) return { error: 'このゲームの参加者ではありません' };
    ready.syncConn(state, room);

    // 準備OKの付け外し（脱落した人も押せるが、数には入れない）
    if (action.type === 'ready') {
      if (state.phase !== 'result') return { error: '今は準備OKを押せません' };
      ready.toggle(state, seat, action.on);
      maybeDeal(state);
      return;
    }

    // ホストが全員を待たずに次の配りへ
    if (action.type === 'forceNext') {
      if (state.phase !== 'result') return { error: '今は次の配りに進めません' };
      if (!room || playerId !== room.hostId) return { error: 'ホストだけが操作できます' };
      deal(state);
      state.log = state.log.slice(-10);
      return;
    }

    if (action.type !== 'play') return { error: '不明な操作です' };
    if (state.phase !== 'play') return { error: '今はカードを出せません' };
    if (seat !== state.turn) return { error: 'あなたの番ではありません' };
    const i = action.index;
    if (!Number.isInteger(i) || !legalIndexes(state, seat).includes(i)) {
      return { error: '場の一番強い札と同じか上、または手札で一番弱い札しか出せません' };
    }

    const [card] = state.hands[seat].splice(i, 1);
    const plays = state.trick.plays;
    plays.push({ seat, card });

    if (plays.length < alive(state).length) {
      state.turn = nextAlive(state, seat);
      return;
    }

    // トリック終了：一番強い札（同じなら後に出した人）
    let winner = plays[0];
    for (const p of plays) if (p.card.v >= winner.card.v) winner = p;
    state.lastTrick = { plays: plays.slice(), winner: winner.seat, no: state.trickNo };

    if (state.trickNo === HAND_SIZE) {
      finishHand(state, winner.seat, plays);
    } else {
      state.log.push(`第${state.trickNo}トリックは ${state.players[winner.seat].name}（${winner.card.r}）`);
      state.trickNo++;
      state.trick = { leader: winner.seat, plays: [] };
      state.turn = winner.seat;
    }
    state.log = state.log.slice(-10);
  },

  view(state, playerId) {
    const seat = state.players.findIndex(p => p.id === playerId);
    const id = s => state.players[s].id;
    const legal = state.phase === 'play' && seat === state.turn ? legalIndexes(state, seat) : [];
    const plays = state.trick ? state.trick.plays : [];
    const r = state.result;
    const nextSeat = state.phase === 'play' ? nextAlive(state, state.turn) : -1;
    return {
      limit: LIMIT,
      handSize: HAND_SIZE,
      phase: state.phase,
      trickNo: state.trickNo,
      readyIds: ready.readyIds(state),
      needIds: ready.needIds(state),
      nextId: nextSeat === -1 ? null : id(nextSeat),
      players: state.players.map((p, i) => ({
        id: p.id,
        name: p.name,
        score: state.scores[i],
        cucumbers: state.cucumbers[i],
        out: state.out[i],
        left: state.left[i],
        count: (state.hands[i] || []).length, // 他人は枚数だけ
        dealer: i === state.dealer,
      })),
      myHand: seat === -1 ? [] : (state.hands[seat] || []).map((c, i) => ({ ...c, legal: legal.includes(i) })),
      currentId: state.phase === 'play' ? id(state.turn) : null,
      trick: plays.map(p => ({ id: id(p.seat), card: p.card })),
      highest: plays.length ? Math.max(...plays.map(p => p.card.v)) : null,
      lastTrick: state.lastTrick && {
        no: state.lastTrick.no,
        winnerId: id(state.lastTrick.winner),
        plays: state.lastTrick.plays.map(p => ({ id: id(p.seat), card: p.card })),
      },
      result: r && {
        loserId: id(r.loser),
        card: r.card,
        penalty: r.penalty,
        bonusIds: r.bonusSeats.map(id),
        lifeLost: r.lifeLost,
        eliminated: r.eliminated,
        resetTo: r.resetTo,
      },
      winnerId: state.winner === null ? null : id(state.winner),
      log: state.log,
    };
  },

  isOver(state) {
    return state.phase === 'over';
  },

  // いま操作を待っている人（手番）。カードを出す局面だけ。result/over では []
  turnOf(state) {
    if (state.phase !== 'play') return [];
    return [state.players[state.turn].id];
  },

  // 誰かが切断・再接続したとき。必要な人が減って全員そろえば次の配りへ進む
  onConnectionChange(state, room) {
    ready.syncConn(state, room);
    return maybeDeal(state);
  },

  // 途中で抜けた人は脱落扱いにして、その回は配り直す
  onLeave(state, playerId) {
    const seat = state.players.findIndex(p => p.id === playerId);
    if (seat === -1 || state.phase === 'over') return;
    state.out[seat] = true;
    state.left[seat] = true;
    state.log.push(`${state.players[seat].name} が退席しました`);
    const rest = alive(state);
    if (rest.length <= 1) {
      state.phase = 'over';
      state.winner = rest.length === 1 ? rest[0] : null;
      return;
    }
    if (state.out[state.dealer]) state.dealer = nextAlive(state, state.dealer);
    if (state.phase === 'play') {
      state.handNo--;
      deal(state);
      state.log.push('配り直します');
    } else if (state.phase === 'result') {
      state.ready = state.ready.filter(s => s !== seat); // 抜けた人は準備リストから外す
      maybeDeal(state); // 残りの必要な人が全員そろっていれば次へ
    }
  },
};
