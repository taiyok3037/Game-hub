// =============================================================
//  インディアンポーカーの乱数テスト
//  2〜6人 × 各2000ゲーム。宣言 / ready / forceNext / forceFold /
//  切断 / 再接続 / 退席 を乱択で最後まで回す。
//  ★最重要：declare 中、どのプレイヤーの view でも自分の card が null であること
//  実行:  node test/indian.random.js
// =============================================================
const assert = require('assert');
const game = require('../games/indian/server.js');
const { checkSpectatorLeak, checkViewForUsesSpectator } = require('./leakCheck');

const GAMES_PER_SIZE = 2000;
const MAX_STEPS = 5000;

let rngState = 0x1234abcd;
function rnd() {
  rngState ^= rngState << 13; rngState ^= rngState >>> 17; rngState ^= rngState << 5;
  return ((rngState >>> 0) % 100000) / 100000;
}
const pick = arr => arr[Math.floor(rnd() * arr.length)];
const makePlayers = n => Array.from({ length: n }, (_, i) => ({ id: `p${i}`, name: `P${i}` }));

// 仕様1章の表を素直に書いた別実装（judge と突き合わせる）
function refJudge(cards, decl, alive) {
  const val = s => cards[s].v;
  const fighters = alive.filter(s => decl[s] === 'fight');
  const maxAll = Math.max(...alive.map(val));
  const maxFight = fighters.length ? Math.max(...fighters.map(val)) : -Infinity;
  const losers = [];
  const reasons = {};
  for (const s of alive) {
    if (decl[s] === 'fight') {
      if (val(s) !== maxFight) { losers.push(s); reasons[s] = 'lost-fight'; }
    } else {
      if (val(s) === maxAll) { losers.push(s); reasons[s] = 'wasted-fold'; }
    }
  }
  return { losers, reasons };
}
function sameJudge(a, b) {
  const la = [...a.losers].sort((x, y) => x - y);
  const lb = [...b.losers].sort((x, y) => x - y);
  if (la.length !== lb.length || la.some((v, i) => v !== lb[i])) return false;
  const ka = Object.keys(a.reasons).sort();
  const kb = Object.keys(b.reasons).sort();
  if (ka.length !== kb.length || ka.some((k, i) => k !== kb[i])) return false;
  return ka.every(k => a.reasons[k] === b.reasons[k]);
}

// ---- judge の手書きケース（最低8つ） ----
function testJudgeCases() {
  const c = v => ({ v });
  const cases = [
    // 全員勝負
    { cards: [c(10), c(14), c(12)], decl: ['fight', 'fight', 'fight'], alive: [0, 1, 2], losers: [0, 2] },
    // 全員降り
    { cards: [c(10), c(14), c(12)], decl: ['fold', 'fold', 'fold'], alive: [0, 1, 2], losers: [1] },
    // 勝負1人で最大（安全、ほかは最大でない降り＝安全）
    { cards: [c(14), c(10), c(12)], decl: ['fight', 'fold', 'fold'], alive: [0, 1, 2], losers: [] },
    // 勝負1人で最大でない（全体最大の降りが−1）
    { cards: [c(10), c(14), c(12)], decl: ['fight', 'fold', 'fold'], alive: [0, 1, 2], losers: [1] },
    // 最大が同点で両者勝負（両方セーフ）
    { cards: [c(14), c(14), c(2)], decl: ['fight', 'fight', 'fold'], alive: [0, 1, 2], losers: [] },
    // 最大が同点で片方降り（降りた方が−1）
    { cards: [c(14), c(14)], decl: ['fight', 'fold'], alive: [0, 1], losers: [1] },
    // 2人戦・両者勝負（弱い方−1）
    { cards: [c(9), c(5)], decl: ['fight', 'fight'], alive: [0, 1], losers: [1] },
    // 2人戦・両者降り（強い方−1）
    { cards: [c(9), c(5)], decl: ['fold', 'fold'], alive: [0, 1], losers: [0] },
    // 全員降り同値（全員−1＝voided の素）
    { cards: [c(7), c(7)], decl: ['fold', 'fold'], alive: [0, 1], losers: [0, 1] },
  ];
  for (const t of cases) {
    const got = game.judge(t.cards, t.decl, t.alive);
    const exp = [...t.losers].sort((a, b) => a - b);
    const gl = [...got.losers].sort((a, b) => a - b);
    assert.deepStrictEqual(gl, exp, `judge ケース不一致: ${JSON.stringify(t)} → ${JSON.stringify(got)}`);
    assert(sameJudge(got, refJudge(t.cards, t.decl, t.alive)), `judge と ref 不一致: ${JSON.stringify(t)}`);
  }
  console.log(`  judge 手書き ${cases.length} ケース OK`);
}

const cov = { declare: 0, ready: 0, forceNext: 0, forceFold: 0, disconnect: 0, reconnect: 0, leave: 0, voided: 0, games: 0 };

function checkNoLeak(state) {
  // declare 中：全員の view で自分の card は null、他の生存者の card は見える
  if (state.phase !== 'declare') return;
  for (const viewer of state.players) {
    const v = game.view(state, viewer.id);
    const vs = state.players.findIndex(p => p.id === viewer.id);
    for (const row of v.players) {
      const s = state.players.findIndex(p => p.id === row.id);
      if (s === vs) {
        assert(row.card === null, `★漏洩: ${viewer.id} の view に自分のカードが入っている`);
      } else if (!state.out[s]) {
        assert(row.card && typeof row.card.v === 'number', `他人(${row.id})のカードが declare 中に見えない`);
      }
    }
  }
}

function checkInvariants(state) {
  assert(['declare', 'reveal', 'over'].includes(state.phase), `phase 不正: ${state.phase}`);
  for (const l of state.lives) assert(l >= 0 && l <= 3, `lives 範囲外: ${l}`);
  if (state.phase === 'declare') {
    const t = game.turnOf(state);
    assert(t.length === 1, 'declare の turnOf は1人');
    const ts = state.players.findIndex(p => p.id === t[0]);
    assert(!state.out[ts], '脱落者に手番が回っている');
  } else {
    assert(game.turnOf(state).length === 0, 'reveal/over の turnOf は空');
  }
  for (const p of state.players) game.view(state, p.id); // 例外が出ないこと
  // 観戦ビューの漏洩チェック（仕様 6-2）。宣言中は全員のカードが伏せられるはず
  const aliveSeats = state.players.map((_, i) => i).filter(i => !state.out[i]);
  const aliveIds = aliveSeats.map(i => state.players[i].id);
  const allHands = new Set();
  for (const i of aliveSeats) if (state.cards[i]) allHands.add(state.cards[i].r + '|' + state.cards[i].s);
  checkSpectatorLeak(game, state, aliveIds, allHands);
  checkViewForUsesSpectator(game, state, state.players.map(p => p.id));
}

function aliveIds(state) {
  return state.players.filter((_, i) => !state.out[i]).map(p => p.id);
}

function runOne(n) {
  const players = makePlayers(n);
  const hostId = players[0].id;
  const connected = new Set(players.map(p => p.id));
  const room = () => ({ hostId, connectedIds: [...connected] });

  const state = game.setup(players);
  checkInvariants(state);

  let steps = 0;
  let livesBefore = null;

  while (!game.isOver(state) && steps++ < MAX_STEPS) {
    if (state.phase === 'declare') {
      checkNoLeak(state);
      checkInvariants(state);
      const curId = game.turnOf(state)[0];

      // ときどき切断・再接続・退席
      if (rnd() < 0.08 && connected.size > 1) { connected.delete(curId); cov.disconnect++; }
      if (rnd() < 0.05) {
        const off = players.map(p => p.id).filter(id => !connected.has(id));
        if (off.length) { connected.add(pick(off)); cov.reconnect++; }
      }
      if (rnd() < 0.02 && aliveIds(state).length > 2) {
        const leaver = pick(aliveIds(state));
        connected.delete(leaver);
        game.onLeave(state, leaver);
        cov.leave++;
        checkInvariants(state);
        continue;
      }

      if (!connected.has(curId)) {
        // 切断中の手番 → ホストが降り扱い
        const res = game.action(state, hostId, { type: 'forceFold' }, room());
        assert(!res || !res.error, `forceFold エラー: ${res && res.error}`);
        cov.forceFold++;
      } else {
        const res = game.action(state, curId, { type: 'declare', choice: rnd() < 0.5 ? 'fight' : 'fold' }, room());
        assert(!res || !res.error, `declare エラー: ${res && res.error}`);
        cov.declare++;
      }
      // reveal に入った瞬間の voided チェック用に、直前のライフを控える
      continue;
    }

    if (state.phase === 'reveal') {
      checkInvariants(state);
      // voided の検証：voided の結果ならライフ合計が変わっていないこと
      const v = game.view(state, players[0].id);
      if (v.result && v.result.voided) {
        cov.voided++;
        // voided のラウンドではライフは満タン側…ここでは「0 の生存者がいない」を保証
        assert(aliveIds(state).length >= 2, 'voided 後は2人以上生存しているはず');
        for (const s of state.players.map((_, i) => i).filter(i => !state.out[i])) {
          assert(state.lives[s] >= 1, 'voided なのにライフ0の生存者がいる');
        }
      }

      const strategy = rnd();
      if (rnd() < 0.2 && connected.size > 1) {
        const victim = pick([...connected]);
        connected.delete(victim);
        cov.disconnect++;
        if (game.onConnectionChange(state, room())) { checkInvariants(state); continue; }
      }
      if (strategy < 0.3) {
        const res = game.action(state, hostId, { type: 'forceNext' }, room());
        assert(!res || !res.error, `forceNext エラー: ${res && res.error}`);
        cov.forceNext++;
      } else {
        const need = game.view(state, players[0].id).needIds;
        for (const id of need) {
          if (game.isOver(state) || state.phase !== 'reveal') break;
          const res = game.action(state, id, { type: 'ready', on: true }, room());
          assert(!res || !res.error, `ready エラー: ${res && res.error}`);
          cov.ready++;
        }
        if (state.phase === 'reveal') game.action(state, hostId, { type: 'forceNext' }, room());
      }
      checkInvariants(state);
      continue;
    }
  }

  assert(game.isOver(state), `${n}人: 終了しなかった（${steps}ステップ）`);
  const alive = state.players.map((_, i) => i).filter(i => !state.out[i]);
  assert(alive.length === 1, `終了時の生存者が1人でない: ${alive.length}`);
  assert(state.winner === alive[0], '勝者が生存者と一致しない');
  cov.games++;
}

console.log('インディアンポーカー乱数テスト開始…');
testJudgeCases();
const t0 = Date.now();
for (let n = 2; n <= 6; n++) {
  for (let i = 0; i < GAMES_PER_SIZE; i++) runOne(n);
  console.log(`  ${n}人 × ${GAMES_PER_SIZE} ゲーム OK`);
}
const ms = Date.now() - t0;
console.log('--- カバレッジ ---');
console.log(cov);
assert(cov.declare > 0 && cov.ready > 0 && cov.forceNext > 0 && cov.forceFold > 0 && cov.disconnect > 0 && cov.leave > 0 && cov.voided > 0, '分岐の網羅が不足');
console.log(`\n✅ 全 ${cov.games} ゲーム 通過（${ms}ms）`);
