// =============================================================
//  ダイス領土戦
//  - 六角マスの領土を、隣の領土へダイスで攻め込んで取り合う陣取りゲーム
//  - 攻撃元・攻撃先のダイスを全部振り、合計が大きい方が勝ち（同点は防御側の勝ち）
//  - ターン終了で「つながった最大のかたまりの数」だけダイスを補充する
//  - 領土が0で脱落。最後の1人が勝ち（100周で打ち切り）
//  ダイスの目は必ずサーバーで振る。乱数は setup で注入できる（テスト再現用）。
// =============================================================
const crypto = require('crypto');
const { generateMap } = require('./map.js');

const COLORS = ['#d9534f', '#3f7fbf', '#e8b33a', '#5aa36b', '#8e5bb5', '#e07b39'];
const MAX_DICE = 8;
const MAX_STOCK = 64;
const MAX_ROUNDS = 100;
const TIME_SCALE = Number(process.env.DICEWAR_TIME_SCALE) || 1;

const defaultRng = () => crypto.randomInt(0, 1e9) / 1e9;

// ---------- 小道具 ----------
const sum = arr => arr.reduce((a, b) => a + b, 0);
const rint = (state, n) => Math.floor(state.rng() * n);
function shuffle(arr, rng) {
  for (let i = arr.length - 1; i > 0; i--) {
    const j = Math.floor(rng() * (i + 1));
    [arr[i], arr[j]] = [arr[j], arr[i]];
  }
  return arr;
}
const pname = (state, seat) => (state.players[seat] || {}).name || '?';
const currentSeat = state => state.order[state.turnIdx];

function regionIdsOf(state, seat) {
  const ids = [];
  for (let id = 0; id < state.owner.length; id++) if (state.owner[id] === seat) ids.push(id);
  return ids;
}
const regionCountOf = (state, seat) => regionIdsOf(state, seat).length;
const totalDiceOf = (state, seat) => regionIdsOf(state, seat).reduce((s, id) => s + state.dice[id], 0);

// 自分の領土のうち、隣接でつながった最大のかたまりの領土数
function largestCluster(state, seat) {
  const own = new Set(regionIdsOf(state, seat));
  const seen = new Set();
  let best = 0;
  for (const id of own) {
    if (seen.has(id)) continue;
    let size = 0;
    const stack = [id];
    seen.add(id);
    while (stack.length) {
      const r = stack.pop();
      size++;
      for (const nb of state.map.regions[r].neighbors) if (own.has(nb) && !seen.has(nb)) { seen.add(nb); stack.push(nb); }
    }
    best = Math.max(best, size);
  }
  return best;
}

// まだ戦っている人（脱落・退席していない席）
const contenders = state => state.players.map((_, i) => i).filter(i => !state.out[i] && !state.left[i]);

// ---------- 設定 ----------
function normalizeOptions(o) {
  o = o || {};
  const mapSize = ['small', 'medium', 'large'].includes(o.mapSize) ? o.mapSize : 'medium';
  const turnTime = [30, 60, 90, 0].includes(o.turnTime) ? o.turnTime : 60;
  return { mapSize, turnTime };
}
const regionCountFor = size => (size === 'small' ? 20 : size === 'large' ? 40 : 30);

// ---------- 勝敗・ターン ----------
function checkOver(state) {
  if (state.phase === 'over') return true;
  const alive = contenders(state);
  if (alive.length <= 1) {
    state.phase = 'over';
    state.deadlineAt = null;
    state.winner = alive.length === 1 ? alive[0] : null;
    state.log.push(state.winner !== null ? `🏆 ${pname(state, state.winner)} の勝ち！` : 'ゲーム終了');
    return true;
  }
  return false;
}

// 100周の打ち切り：領土数→総ダイス数→引き分け
function endByCutoff(state) {
  state.phase = 'over';
  state.deadlineAt = null;
  const alive = contenders(state);
  if (!alive.length) { state.winner = null; return; }
  const maxR = Math.max(...alive.map(s => regionCountOf(state, s)));
  let top = alive.filter(s => regionCountOf(state, s) === maxR);
  if (top.length > 1) {
    const maxD = Math.max(...top.map(s => totalDiceOf(state, s)));
    top = top.filter(s => totalDiceOf(state, s) === maxD);
  }
  state.winner = top.length === 1 ? top[0] : null;
  state.log.push(state.winner !== null ? `打ち切り：${pname(state, state.winner)} の勝ち` : '打ち切り：引き分け');
}

function startTurn(state) {
  state.turnStartedAt = Date.now();
  state.deadlineAt = state.options.turnTime > 0 ? state.turnStartedAt + state.options.turnTime * 1000 * TIME_SCALE : null;
}

function advanceTurn(state) {
  if (checkOver(state)) return;
  const n = state.order.length;
  const old = state.turnIdx;
  let found = -1;
  for (let k = 1; k <= n; k++) {
    const idx = (old + k) % n;
    const s = state.order[idx];
    if (!state.out[s] && !state.left[s]) { found = idx; break; }
  }
  if (found === -1) { state.phase = 'over'; state.winner = null; state.deadlineAt = null; return; }
  state.turnIdx = found;
  if (found <= old) state.round++; // 一周した
  if (state.round > MAX_ROUNDS) { endByCutoff(state); return; }
  startTurn(state);
}

// ターン終了時の補充
function reinforce(state, seat) {
  const largest = largestCluster(state, seat);
  let pool = largest + state.stock[seat];
  const mine = regionIdsOf(state, seat);
  const added = {};
  while (pool > 0) {
    const avail = mine.filter(id => state.dice[id] < MAX_DICE);
    if (!avail.length) break;
    const id = avail[rint(state, avail.length)];
    state.dice[id]++;
    added[id] = (added[id] || 0) + 1;
    pool--;
  }
  state.stock[seat] = Math.min(MAX_STOCK, pool); // 置ききれない分は持ち越し（上限64・超過は捨てる）
  state.lastReinforce = { seq: ++state.seqR, seat, added, stock: state.stock[seat], reinforce: largest };
  state.log.push(`${pname(state, seat)}：+${largest} 補充`);
}

function doEndTurn(state) {
  reinforce(state, currentSeat(state));
  state.log = state.log.slice(-12);
  advanceTurn(state);
}

module.exports = {
  id: 'dicewar',
  name: 'ダイス領土戦',
  description: 'となりの領土にダイスで攻め込め！ つながった領土が多いほど援軍が増える陣取り合戦',
  category: 'ボード',
  cover: { color: '#9a6a2f', mark: '⚀', markColor: '#2a1a10' },
  minPlayers: 2,
  maxPlayers: 6,

  options: [
    {
      key: 'mapSize', label: '地図の広さ', type: 'select', default: 'medium',
      choices: [
        { value: 'small', label: '小（約20）' },
        { value: 'medium', label: '中（約30）' },
        { value: 'large', label: '大（約40）' },
      ],
    },
    {
      key: 'turnTime', label: '1ターンの制限時間', type: 'select', default: 60,
      choices: [
        { value: 30, label: '30秒' }, { value: 60, label: '60秒' },
        { value: 90, label: '90秒' }, { value: 0, label: 'なし' },
      ],
    },
  ],

  setup(players, options, deps = {}) {
    const rng = deps && typeof deps.rng === 'function' ? deps.rng : defaultRng;
    const opts = normalizeOptions(options);
    const n = players.length;
    const map = generateMap({ regions: regionCountFor(opts.mapSize), players: n, rng });
    const R = map.regions.length;

    const owner = new Array(R).fill(-1);
    const dice = new Array(R).fill(1);

    // プレイヤー数で割り切れる分だけ使い、余りは中立
    const per = Math.floor(R / n);
    const usable = per * n;
    const ids = shuffle([...Array(R).keys()], rng);
    const used = ids.slice(0, usable);
    used.forEach((id, k) => { owner[id] = k % n; });           // ランダムに均等配分
    for (const id of ids.slice(usable)) dice[id] = 1 + Math.floor(rng() * 3); // 中立は1〜3個

    const state = {
      players,
      options: opts,
      rng,
      order: shuffle([...Array(n).keys()], rng),
      turnIdx: 0,
      round: 1,
      map,
      owner,
      dice,
      stock: new Array(n).fill(0),
      out: new Array(n).fill(false),
      left: new Array(n).fill(false),
      lastAttack: null,
      lastReinforce: null,
      turnStartedAt: 0,
      deadlineAt: null,
      phase: 'play',
      winner: null,
      seqA: 0,
      seqR: 0,
      log: [],
    };

    // 追加ダイス：各プレイヤーに「持っている領土数×2」個をランダムに配る（1領土8個まで）
    for (let s = 0; s < n; s++) {
      let add = per * 2;
      const mine = used.filter(id => owner[id] === s);
      while (add > 0) {
        const avail = mine.filter(id => dice[id] < MAX_DICE);
        if (!avail.length) break;
        dice[avail[Math.floor(rng() * avail.length)]]++;
        add--;
      }
    }

    startTurn(state);
    return state;
  },

  action(state, playerId, action, room) {
    const seat = state.players.findIndex(p => p.id === playerId);
    if (seat === -1) return { error: 'このゲームの参加者ではありません' };
    if (state.phase !== 'play') return { error: 'ゲームは終了しています' };

    switch (action.type) {
      case 'attack': {
        if (seat !== currentSeat(state)) return { error: 'あなたの番ではありません' };
        const { from, to } = action;
        const R = state.owner.length;
        if (!Number.isInteger(from) || from < 0 || from >= R) return { error: 'その領土はありません' };
        if (!Number.isInteger(to) || to < 0 || to >= R) return { error: 'その領土はありません' };
        if (state.owner[from] !== seat) return { error: '攻撃元は自分の領土ではありません' };
        if (state.dice[from] < 2) return { error: 'ダイスが2個以上ないと攻撃できません' };
        if (!state.map.regions[from].neighbors.includes(to)) return { error: '隣接していません' };
        if (state.owner[to] === seat) return { error: '自分の領土は攻撃できません' };

        const aRolls = Array.from({ length: state.dice[from] }, () => 1 + rint(state, 6));
        const dRolls = Array.from({ length: state.dice[to] }, () => 1 + rint(state, 6));
        const aSum = sum(aRolls), dSum = sum(dRolls);
        const defender = state.owner[to];
        const success = aSum > dSum; // 同点は防御側の勝ち

        if (success) {
          const moved = state.dice[from] - 1;
          state.owner[to] = seat;
          state.dice[to] = moved;
          state.dice[from] = 1;
        } else {
          state.dice[from] = 1;
        }
        state.lastAttack = { seq: ++state.seqA, from, to, attacker: seat, defender, aRolls, dRolls, aSum, dSum, success };
        const dName = defender >= 0 ? pname(state, defender) : '中立';
        state.log.push(`${pname(state, seat)} → ${dName}：${success ? '占領' : '防衛成功'}（${aSum} 対 ${dSum}）`);
        state.log = state.log.slice(-12);

        if (success && defender >= 0 && !state.out[defender] && regionCountOf(state, defender) === 0) {
          state.out[defender] = true;
          state.log.push(`${pname(state, defender)} が脱落`);
        }
        checkOver(state);
        return;
      }
      case 'endTurn': {
        if (seat !== currentSeat(state)) return { error: 'あなたの番ではありません' };
        doEndTurn(state);
        return;
      }
      case 'forceEndTurn': {
        if (!room || playerId !== room.hostId) return { error: 'ホストだけが操作できます' };
        const curId = state.players[currentSeat(state)].id;
        if ((room.connectedIds || []).includes(curId)) return { error: '手番の人は操作できる状態です' };
        doEndTurn(state);
        return;
      }
      default:
        return { error: '不明な操作です' };
    }
  },

  // 隠し情報はないので view と spectatorView は同じ内容
  view(state) {
    const idOf = s => (s < 0 ? null : state.players[s].id);
    const la = state.lastAttack, lr = state.lastReinforce;
    return {
      map: {
        width: state.map.width, height: state.map.height, grid: state.map.grid,
        regions: state.map.regions.map(r => ({ id: r.id, neighbors: r.neighbors, center: r.center })),
      },
      owner: state.owner.slice(),
      dice: state.dice.slice(),
      stock: state.stock.slice(),
      players: state.players.map((p, i) => ({
        id: p.id, name: p.name, color: COLORS[i % COLORS.length],
        out: !!state.out[i], left: !!state.left[i],
        regions: regionCountOf(state, i),
        totalDice: totalDiceOf(state, i),
        largest: largestCluster(state, i),
        stock: state.stock[i],
      })),
      order: state.order.map(s => state.players[s].id),
      currentId: state.phase === 'play' ? idOf(currentSeat(state)) : null,
      round: state.round,
      lastAttack: la && {
        seq: la.seq, from: la.from, to: la.to,
        attackerId: idOf(la.attacker), defenderId: idOf(la.defender),
        aRolls: la.aRolls, dRolls: la.dRolls, aSum: la.aSum, dSum: la.dSum, success: la.success,
      },
      lastReinforce: lr && { seq: lr.seq, seatId: idOf(lr.seat), added: lr.added, stock: lr.stock, reinforce: lr.reinforce },
      deadline: state.deadlineAt,
      phase: state.phase,
      winnerId: state.winner == null ? null : idOf(state.winner),
      log: state.log,
    };
  },

  spectatorView(state, { viewerId } = {}) {
    const v = this.view(state);
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
    return !!(state.out[seat] || state.left[seat]);
  },

  turnOf(state) {
    if (state.phase !== 'play') return [];
    return [state.players[currentSeat(state)].id];
  },

  // turnTime が0以外なら、ターン開始から turnTime 秒
  deadline(state) {
    return state.deadlineAt;
  },

  // 時間切れ：ターン終了（補充あり）と同じ
  onTimeout(state) {
    if (state.phase === 'play') doEndTurn(state);
  },

  // 退席：その人の領土を中立にする（ダイスはそのまま）。手番中なら次へ（補充なし）
  onLeave(state, playerId) {
    const seat = state.players.findIndex(p => p.id === playerId);
    if (seat === -1 || state.phase === 'over') return;
    const wasCurrent = currentSeat(state) === seat;
    state.left[seat] = true;
    for (let id = 0; id < state.owner.length; id++) if (state.owner[id] === seat) state.owner[id] = -1;
    state.log.push(`${pname(state, seat)} が退席（領土は中立に）`);
    state.log = state.log.slice(-12);
    if (checkOver(state)) return;
    if (wasCurrent) advanceTurn(state); // 補充なしで次の人へ
  },
};
