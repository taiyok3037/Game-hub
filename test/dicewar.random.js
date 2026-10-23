// =============================================================
//  ダイス領土戦の乱数テスト
//  2〜6人 × 各500ゲームを、シード付き乱数で、攻撃・ターン終了・時間切れ・
//  切断（forceEndTurn）・退席・ホストの強制終了の乱択で最後まで回す。
//  毎ステップ、6章の不変条件を検証する。
//  実行:  npm test   または   node test/dicewar.random.js
// =============================================================
const assert = require('assert');
const game = require('../games/dicewar/server.js');

const GAMES_PER_SIZE = 500; // 2〜6人で合計 2,500 ゲーム
const MAX_STEPS = 200000;
const MAX_ROUNDS_HINT = 100; // サーバーの打ち切り周回数と同じ

// 再現用の簡易乱数
function makeRng(seed) {
  let s = seed >>> 0;
  return () => { s ^= s << 13; s ^= s >>> 17; s ^= s << 5; return ((s >>> 0) % 1000000) / 1000000; };
}
let rngGlobal = makeRng(12345);
const rnd = () => rngGlobal();
const pick = arr => arr[Math.floor(rnd() * arr.length)];
const makePlayers = n => Array.from({ length: n }, (_, i) => ({ id: `p${i}`, name: `P${i}` }));

const regionIds = (state, seat) => state.owner.map((o, i) => (o === seat ? i : -1)).filter(i => i >= 0);
const totalDice = (state, seat) => regionIds(state, seat).reduce((s, id) => s + state.dice[id], 0);
const contenders = state => state.players.map((_, i) => i).filter(i => !state.out[i] && !state.left[i]);
const currentSeat = state => state.order[state.turnIdx];

function largestCluster(state, seat) {
  const own = new Set(regionIds(state, seat));
  const seen = new Set();
  let best = 0;
  for (const id of own) {
    if (seen.has(id)) continue;
    let size = 0; const stack = [id]; seen.add(id);
    while (stack.length) { const r = stack.pop(); size++; for (const nb of state.map.regions[r].neighbors) if (own.has(nb) && !seen.has(nb)) { seen.add(nb); stack.push(nb); } }
    best = Math.max(best, size);
  }
  return best;
}

function legalAttacks(state, seat) {
  const out = [];
  for (const from of regionIds(state, seat)) {
    if (state.dice[from] < 2) continue;
    for (const to of state.map.regions[from].neighbors) if (state.owner[to] !== seat) out.push({ from, to });
  }
  return out;
}

const cov = {
  attack: 0, occupy: 0, defend: 0, tie: 0, endTurn: 0, timeout: 0, force: 0,
  leave: 0, eliminate: 0, cutoff: 0, overByLast: 0, games: 0,
  illWrongTurn: 0, illDice1: 0, illSelf: 0, illAdj: 0,
};

function checkStep(state) {
  for (let id = 0; id < state.owner.length; id++) {
    assert(state.dice[id] >= 1 && state.dice[id] <= 8, `dice 範囲外: ${state.dice[id]}`);
    assert(state.owner[id] >= -1 && state.owner[id] < state.players.length, `owner 不正: ${state.owner[id]}`);
  }
  for (const s of state.stock) assert(s >= 0 && s <= 64, `stock 範囲外: ${s}`);
  game.view(state); // 例外なく作れる
  if (state.phase === 'play') {
    const cur = currentSeat(state);
    assert(!state.out[cur] && !state.left[cur], '手番が脱落/退席者に来ている');
    assert(game.turnOf(state).length === 1, 'play の turnOf は1人');
  } else {
    assert(game.turnOf(state).length === 0, 'over の turnOf は空');
  }
}

function tryIllegal(state, cur, room) {
  const myRegions = regionIds(state, cur);
  // 他人の番の攻撃
  const other = contenders(state).find(s => s !== cur);
  if (other !== undefined) {
    const oreg = regionIds(state, other).find(id => state.map.regions[id].neighbors.length);
    if (oreg !== undefined) {
      const to = state.map.regions[oreg].neighbors[0];
      const r = game.action(state, state.players[other].id, { type: 'attack', from: oreg, to }, room);
      assert(r && r.error, '他人の番の攻撃がエラーにならない'); cov.illWrongTurn++;
    }
  }
  // ダイス1個からの攻撃
  const one = myRegions.find(id => state.dice[id] === 1 && state.map.regions[id].neighbors.some(nb => state.owner[nb] !== cur));
  if (one !== undefined) {
    const to = state.map.regions[one].neighbors.find(nb => state.owner[nb] !== cur);
    const r = game.action(state, state.players[cur].id, { type: 'attack', from: one, to }, room);
    assert(r && r.error, 'ダイス1からの攻撃がエラーにならない'); cov.illDice1++;
  }
  // 自分の領土への攻撃
  for (const from of myRegions) {
    if (state.dice[from] < 2) continue;
    const to = state.map.regions[from].neighbors.find(nb => state.owner[nb] === cur);
    if (to !== undefined) {
      const r = game.action(state, state.players[cur].id, { type: 'attack', from, to }, room);
      assert(r && r.error, '自分への攻撃がエラーにならない'); cov.illSelf++;
      break;
    }
  }
  // 隣接していない攻撃
  const from2 = myRegions.find(id => state.dice[id] >= 2);
  if (from2 !== undefined) {
    const nb = new Set(state.map.regions[from2].neighbors);
    let to = -1;
    for (let id = 0; id < state.owner.length; id++) if (id !== from2 && !nb.has(id)) { to = id; break; }
    if (to >= 0) {
      const r = game.action(state, state.players[cur].id, { type: 'attack', from: from2, to }, room);
      assert(r && r.error, '非隣接の攻撃がエラーにならない'); cov.illAdj++;
    }
  }
}

function runOne(n) {
  const players = makePlayers(n);
  const hostId = players[0].id;
  const hostSeat = 0;
  const allIds = players.map(p => p.id);
  const room = () => ({ hostId, connectedIds: allIds });

  const options = {
    mapSize: pick(['small', 'medium', 'large']),
    turnTime: pick([30, 60, 90, 0]),
  };
  const state = game.setup(players, options, { rng: makeRng((n * 7919 + cov.games * 104729) >>> 0) });
  checkStep(state);

  // 初期：全員が領土を持っている
  for (let s = 0; s < n; s++) assert(regionIds(state, s).length > 0, '初期に領土0のプレイヤー');

  let lastCurrent = currentSeat(state);
  let attacksThisTurn = 0;
  let steps = 0;

  while (!game.isOver(state) && steps++ < MAX_STEPS) {
    const cur = currentSeat(state);
    if (cur !== lastCurrent) { lastCurrent = cur; attacksThisTurn = 0; }
    checkStep(state);

    if (rnd() < 0.08) tryIllegal(state, cur, room());

    const e = rnd();

    if (e < 0.04 && contenders(state).length >= 3) {
      const cand = contenders(state).filter(s => state.players[s].id !== hostId);
      if (cand.length) {
        const victim = pick(cand);
        game.onLeave(state, state.players[victim].id);
        cov.leave++;
        assert(regionIds(state, victim).length === 0, '退席者の領土が中立になっていない');
        checkStep(state);
        continue;
      }
    }
    if (e < 0.09 && cur !== hostSeat) {
      const before = cur;
      const r = game.action(state, hostId, { type: 'forceEndTurn' }, { hostId, connectedIds: allIds.filter(id => id !== state.players[cur].id) });
      assert(!r || !r.error, `forceEndTurn エラー: ${r && r.error}`);
      cov.force++;
      assert(game.isOver(state) || currentSeat(state) !== before, 'forceEndTurn で手番が進んでいない');
      checkStep(state);
      continue;
    }
    if (e < 0.13) {
      const before = cur;
      game.onTimeout(state);
      cov.timeout++;
      assert(game.isOver(state) || currentSeat(state) !== before, 'timeout で手番が進んでいない');
      checkStep(state);
      continue;
    }

    const legal = legalAttacks(state, cur);
    if (legal.length && attacksThisTurn < 40 && rnd() < 0.8) {
      const { from, to } = pick(legal);
      const pre = { fromDice: state.dice[from], toDice: state.dice[to], toOwner: state.owner[to] };
      const outBefore = contenders(state).length;
      const r = game.action(state, state.players[cur].id, { type: 'attack', from, to }, room());
      assert(!r || !r.error, `attack エラー: ${r && r.error}`);
      attacksThisTurn++;
      cov.attack++;
      const la = state.lastAttack;
      assert(la && la.aSum === la.aRolls.reduce((a, b) => a + b, 0), 'aSum がロール合計と一致しない');
      assert(la.aRolls.length === pre.fromDice, 'aRolls の個数が攻撃元ダイス数と違う');
      assert(la.dRolls.length === pre.toDice, 'dRolls の個数が攻撃先ダイス数と違う');
      if (la.success) {
        cov.occupy++;
        assert(la.aSum > la.dSum, '成功なのに合計が大きくない');
        assert(state.dice[from] === 1, '成功時 攻撃元が1でない');
        assert(state.dice[to] === pre.fromDice - 1, '成功時 攻撃先が 元-1 でない');
        assert(state.owner[to] === cur, '成功時 持ち主が変わっていない');
      } else {
        cov.defend++;
        assert(la.aSum <= la.dSum, '失敗なのに合計が大きい');
        assert(state.dice[from] === 1, '失敗時 攻撃元が1でない');
        assert(state.dice[to] === pre.toDice && state.owner[to] === pre.toOwner, '失敗時 攻撃先が変化した');
      }
      if (la.aSum === la.dSum) { cov.tie++; assert(!la.success, '同点が成功になった'); }
      if (contenders(state).length < outBefore) cov.eliminate++;
      checkStep(state);
      continue;
    }

    // ターン終了（補充の保存則）
    const seat = cur;
    const largest = largestCluster(state, seat);
    const oldStock = state.stock[seat];
    const diceBefore = totalDice(state, seat);
    const capacity = regionIds(state, seat).reduce((s, id) => s + (8 - state.dice[id]), 0);
    const r = game.action(state, state.players[seat].id, { type: 'endTurn' }, room());
    assert(!r || !r.error, `endTurn エラー: ${r && r.error}`);
    cov.endTurn++;
    const pool = largest + oldStock;
    const placed = totalDice(state, seat) - diceBefore;
    assert(placed === Math.min(pool, capacity), `補充の配置数が不正: ${placed} != min(${pool},${capacity})`);
    assert(state.stock[seat] === Math.min(64, pool - placed), `持ち越しが不正: ${state.stock[seat]}`);
    checkStep(state);
  }

  assert(game.isOver(state), `${n}人: 終了しなかった（${steps} ステップ）`);
  const alive = contenders(state);
  if (state.round > MAX_ROUNDS_HINT) cov.cutoff++;
  if (alive.length <= 1) cov.overByLast++;
  assert(alive.length <= 1 || state.round > MAX_ROUNDS_HINT, `終了時に生存者が複数（${alive.length}人・round ${state.round}）`);
  if (state.winner !== null) {
    assert(!state.out[state.winner] && !state.left[state.winner], '勝者が脱落/退席者');
  }
  cov.games++;
}

console.log('ダイス領土戦 乱数テスト開始…');
const t0 = Date.now();
for (let n = 2; n <= 6; n++) {
  for (let i = 0; i < GAMES_PER_SIZE; i++) runOne(n);
  console.log(`  ${n}人 × ${GAMES_PER_SIZE} ゲーム OK`);
}
console.log('--- カバレッジ ---');
console.log(cov);
assert(cov.attack && cov.occupy && cov.defend && cov.tie, '攻撃結果の網羅不足');
assert(cov.endTurn && cov.timeout && cov.force && cov.leave, 'ターン終了/時間切れ/強制/退席の網羅不足');
assert(cov.eliminate && cov.overByLast, '脱落・決着の網羅不足');
assert(cov.illWrongTurn && cov.illDice1 && cov.illSelf && cov.illAdj, 'ルール違反の網羅不足');
console.log(`\n✅ 全 ${cov.games} ゲーム 通過（${Date.now() - t0}ms）`);
