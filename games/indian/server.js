// =============================================================
//  インディアンポーカー（チップなし・パーティー版）
//  - 2〜6人、ライフ各3
//  - 52枚（ジョーカーなし）。強さは数字だけ（A=14 > K=13 > … > 2）。マークは無関係
//  - 毎ラウンド全員に1枚配る。自分のカードだけ見えない
//  - 最初の人から時計回りに「勝負(fight)」か「降りる(fold)」を宣言
//  - 全員宣言したら公開して判定（judge）。ライフ0で脱落、最後の1人が勝ち
//  - 全員同時脱落はノーカウント（voided）
// =============================================================
const readyCheck = require('../../lib/readyCheck');

const SUITS = ['♠', '♥', '♦', '♣'];
const RANKS = ['2', '3', '4', '5', '6', '7', '8', '9', '10', 'J', 'Q', 'K', 'A'];
const LIVES = 3;

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

const aliveSeatsOf = state => state.players.map((_, i) => i).filter(i => !state.out[i]);

function nextAlive(state, seat) {
  const n = state.players.length;
  for (let k = 1; k <= n; k++) {
    const i = (seat + k) % n;
    if (!state.out[i]) return i;
  }
  return seat;
}

// ---- 判定（純粋関数。テストで表と突き合わせる） ----
// cards: 席ごとのカード（{v}）, decl: 'fight'|'fold', aliveSeats: 参加している席
// 戻り値: { losers: 席[], reasons: { [席]: 'lost-fight'|'wasted-fold' } }
function judge(cards, decl, aliveSeats) {
  const losers = [];
  const reasons = {};
  const val = s => cards[s].v;
  const fighters = aliveSeats.filter(s => decl[s] === 'fight');
  const maxAll = Math.max(...aliveSeats.map(val));
  const maxFight = fighters.length ? Math.max(...fighters.map(val)) : null;
  for (const s of aliveSeats) {
    if (decl[s] === 'fight') {
      // 勝負した人の中で自分が最大でない（最大と同値はセーフ）
      if (val(s) < maxFight) { losers.push(s); reasons[s] = 'lost-fight'; }
    } else {
      // 降りたが全員の中で最大（最大と同値も含む）＝もったいない降り
      if (val(s) === maxAll) { losers.push(s); reasons[s] = 'wasted-fold'; }
    }
  }
  return { losers, reasons };
}

// 準備OK（reveal 中に次へ進むための共通ロジック）：生存かつ接続中の席
const ready = readyCheck(state => {
  const conn = state.connectedIds || state.players.map(p => p.id);
  return aliveSeatsOf(state).filter(s => conn.includes(state.players[s].id));
});

function dealRound(state) {
  const deck = newDeck();
  state.cards = state.players.map((_, i) => (state.out[i] ? null : deck.pop()));
  state.decl = state.players.map(() => null);
  state.turn = state.starter;
  state.phase = 'declare';
  state.result = null;
  ready.reset(state);
  state.log.push(`第${state.round}ラウンド開始（最初は ${state.players[state.starter].name} さん）`);
  state.log = state.log.slice(-10);
}

function advanceRound(state) {
  state.starter = nextAlive(state, state.starter);
  state.round++;
  dealRound(state);
}

// 公開して判定する
function doReveal(state) {
  const seats = aliveSeatsOf(state);
  const { losers, reasons } = judge(state.cards, state.decl, seats);

  // 全員同時脱落ならノーカウント（voided）
  const livesAfter = state.lives.slice();
  for (const s of losers) livesAfter[s] = Math.max(0, livesAfter[s] - 1);
  const survivors = seats.filter(s => livesAfter[s] > 0);
  const voided = survivors.length === 0;

  const eliminated = [];
  if (voided) {
    state.log.push(`第${state.round}ラウンド：全員アウトなのでノーカウント`);
  } else {
    for (const s of losers) {
      state.lives[s] = Math.max(0, state.lives[s] - 1);
      const why = reasons[s] === 'lost-fight' ? '勝負で負け' : '降りたけど最強';
      state.log.push(`第${state.round}ラウンド：${state.players[s].name} さん −1（${why}）`);
    }
    for (const s of seats) {
      if (state.lives[s] === 0 && !state.out[s]) { state.out[s] = true; eliminated.push(s); }
    }
    for (const s of eliminated) state.log.push(`💀 ${state.players[s].name} さんが脱落`);
  }
  state.log = state.log.slice(-10);

  state.result = {
    losers: voided ? [] : losers,
    reasons: voided ? {} : reasons,
    eliminated,
    voided,
  };
  state.phase = 'reveal';
  ready.reset(state);

  const rest = aliveSeatsOf(state);
  if (rest.length <= 1) {
    state.phase = 'over';
    state.winner = rest.length === 1 ? rest[0] : null;
    if (state.winner !== null) state.log.push(`🏆 ${state.players[state.winner].name} さんの勝ち！`);
  }
}

function maybeNext(state) {
  if (state.phase === 'reveal' && ready.isAllReady(state)) {
    advanceRound(state);
    return true;
  }
  return false;
}

module.exports = {
  id: 'indian',
  name: 'インディアンポーカー',
  description: '自分のカードだけ見えない！ みんなの反応を読んで、勝負か降りるかを決めよう',
  category: 'トランプ',
  cover: { color: '#7a3b5c', mark: '?', markColor: '#2a1a10' },
  minPlayers: 2,
  maxPlayers: 6,

  judge, // テスト用に公開

  setup(players) {
    const state = {
      players,
      lives: players.map(() => LIVES),
      out: players.map(() => false),
      left: players.map(() => false),
      starter: Math.floor(Math.random() * players.length),
      round: 1,
      cards: [],
      decl: [],
      turn: 0,
      phase: 'declare',
      result: null,
      ready: [],
      winner: null,
      connectedIds: players.map(p => p.id),
      log: [],
    };
    dealRound(state);
    return state;
  },

  action(state, playerId, action, room) {
    const seat = state.players.findIndex(p => p.id === playerId);
    if (seat === -1) return { error: 'このゲームの参加者ではありません' };
    ready.syncConn(state, room);

    // 宣言
    if (action.type === 'declare') {
      if (state.phase !== 'declare') return { error: '今は宣言できません' };
      if (seat !== state.turn) return { error: 'あなたの番ではありません' };
      if (action.choice !== 'fight' && action.choice !== 'fold') return { error: '勝負か降りるを選んでください' };
      state.decl[seat] = action.choice;
      state.log.push(`${state.players[seat].name} さん：${action.choice === 'fight' ? '勝負' : '降り'}`);
      state.log = state.log.slice(-10);
      if (aliveSeatsOf(state).every(s => state.decl[s] !== null)) doReveal(state);
      else state.turn = nextAlive(state, seat);
      return;
    }

    // 準備OK（reveal 中）
    if (action.type === 'ready') {
      if (state.phase !== 'reveal') return { error: '今は準備OKを押せません' };
      ready.toggle(state, seat, action.on);
      maybeNext(state);
      return;
    }

    // ホストが待たずに次のラウンドへ
    if (action.type === 'forceNext') {
      if (state.phase !== 'reveal') return { error: '今は次に進めません' };
      if (!room || playerId !== room.hostId) return { error: 'ホストだけが操作できます' };
      advanceRound(state);
      return;
    }

    // ホストが、切断中の手番の人を「降りる」扱いにして進める
    if (action.type === 'forceFold') {
      if (state.phase !== 'declare') return { error: '今は使えません' };
      if (!room || playerId !== room.hostId) return { error: 'ホストだけが操作できます' };
      const curId = state.players[state.turn].id;
      if (room.connectedIds && room.connectedIds.includes(curId)) return { error: '手番の人は接続中です' };
      state.decl[state.turn] = 'fold';
      state.log.push(`${state.players[state.turn].name} さん：降り（切断のため）`);
      state.log = state.log.slice(-10);
      if (aliveSeatsOf(state).every(s => state.decl[s] !== null)) doReveal(state);
      else state.turn = nextAlive(state, state.turn);
      return;
    }

    return { error: '不明な操作です' };
  },

  view(state, playerId) {
    const seat = state.players.findIndex(p => p.id === playerId);
    const id = s => state.players[s].id;
    const r = state.result;
    return {
      myId: playerId,
      phase: state.phase,
      round: state.round,
      currentId: state.phase === 'declare' ? id(state.turn) : null,
      readyIds: ready.readyIds(state),
      needIds: ready.needIds(state),
      winnerId: state.winner === null ? null : id(state.winner),
      result: r && {
        loserIds: r.losers.map(id),
        reasons: Object.fromEntries(r.losers.map(s => [id(s), r.reasons[s]])),
        eliminatedIds: r.eliminated.map(id),
        voided: r.voided,
      },
      players: state.players.map((p, i) => ({
        id: p.id,
        name: p.name,
        lives: state.lives[i],
        out: state.out[i],
        left: state.left[i],
        decl: state.decl[i],
        isStarter: i === state.starter,
        // ★自分のカードは declare 中は必ず null。
        //   reveal/over は、その回に配られたカードをそのまま見せる（このラウンドで脱落した人も見える。
        //   以前から脱落している人は cards[i] が null）。
        card: state.phase === 'declare'
          ? (state.out[i] ? null : (i === seat ? null : state.cards[i]))
          : state.cards[i],
      })),
      log: state.log,
    };
  },

  isOver(state) {
    return state.phase === 'over';
  },

  // declare のときだけ手番の人。それ以外は []
  turnOf(state) {
    if (state.phase !== 'declare') return [];
    return [state.players[state.turn].id];
  },

  // reveal 中、必要な人が減って全員そろえば次のラウンドへ
  onConnectionChange(state, room) {
    ready.syncConn(state, room);
    return maybeNext(state);
  },

  // 退席：その席を脱落扱い。declare 中は配り直し、reveal 中は準備判定をやり直す
  onLeave(state, playerId) {
    const seat = state.players.findIndex(p => p.id === playerId);
    if (seat === -1 || state.phase === 'over') return;
    state.out[seat] = true;
    state.left[seat] = true;
    state.log.push(`${state.players[seat].name} さんが退席しました`);
    state.log = state.log.slice(-10);

    const rest = aliveSeatsOf(state);
    if (rest.length <= 1) {
      state.phase = 'over';
      state.winner = rest.length === 1 ? rest[0] : null;
      return;
    }
    if (state.out[state.starter]) state.starter = nextAlive(state, state.starter);

    if (state.phase === 'declare') {
      dealRound(state); // そのラウンドは配り直す
      state.log.push('配り直します');
      state.log = state.log.slice(-10);
    } else if (state.phase === 'reveal') {
      state.ready = state.ready.filter(s => s !== seat);
      maybeNext(state);
    }
  },
};
