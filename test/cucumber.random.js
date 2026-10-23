// =============================================================
//  きゅうりの乱数テスト
//  setup から isOver まで、2〜7人 × 数千回。
//  ready / forceNext / 切断（onConnectionChange）/ 退席（onLeave）の分岐を含めて
//  必ず終了し、不変条件を満たすことを確認する。
//  実行:  npm test   または   node test/cucumber.random.js
// =============================================================
const assert = require('assert');
const game = require('../games/cucumber/server.js');
const { checkSpectatorLeak, checkViewForUsesSpectator } = require('./leakCheck');

const GAMES_PER_SIZE = 2000; // 2〜7人で合計 12,000 ゲーム
const MAX_STEPS = 20000;

let rngState = 0x12345678;
function rnd() { // 再現用の簡易乱数（0..1）
  rngState ^= rngState << 13; rngState ^= rngState >>> 17; rngState ^= rngState << 5;
  return ((rngState >>> 0) % 100000) / 100000;
}
const pick = arr => arr[Math.floor(rnd() * arr.length)];

function makePlayers(n) {
  return Array.from({ length: n }, (_, i) => ({ id: `p${i}`, name: `P${i}` }));
}

// その人の手札から出せるカードの index を1つ返す（view 経由＝本番と同じ経路）
function chooseLegal(state, playerId) {
  const v = game.view(state, playerId);
  const legal = v.myHand.map((c, i) => (c.legal ? i : -1)).filter(i => i >= 0);
  return legal.length ? pick(legal) : -1;
}

function checkInvariants(state) {
  assert(['play', 'result', 'over'].includes(state.phase), `phase 不正: ${state.phase}`);
  for (const s of state.scores) {
    assert(Number.isFinite(s) && s >= 0, `score 不正: ${s}`);
  }
  for (const c of state.cucumbers) assert(c >= 0 && c <= 2, `cucumbers 不正: ${c}`);
  assert(Array.isArray(state.ready), 'ready が配列でない');
  // 各プレイヤーの view が例外なく作れること
  for (const p of state.players) game.view(state, p.id);
  // 観戦ビューの漏洩チェック（仕様 6-2）
  const aliveSeats = state.players.map((_, i) => i).filter(i => !state.out[i]);
  const aliveIds = aliveSeats.map(i => state.players[i].id);
  const allHands = new Set();
  for (const i of aliveSeats) for (const c of state.hands[i] || []) allHands.add(c.r + '|' + c.s);
  checkSpectatorLeak(game, state, aliveIds, allHands);
  checkViewForUsesSpectator(game, state, state.players.map(p => p.id));
  if (state.phase === 'play') {
    const t = game.turnOf(state);
    assert(t.length === 1, `play 中の turnOf は1人: ${JSON.stringify(t)}`);
  } else {
    assert(game.turnOf(state).length === 0, 'result/over では turnOf は空');
  }
}

const cov = { ready: 0, forceNext: 0, disconnect: 0, reconnect: 0, leave: 0, games: 0, resultHits: 0 };

function aliveIds(state) {
  return state.players.filter((_, i) => !state.out[i]).map(p => p.id);
}

function runOne(n) {
  const players = makePlayers(n);
  const hostId = players[0].id;
  let connected = new Set(players.map(p => p.id));
  const room = () => ({ hostId, connectedIds: [...connected] });

  const state = game.setup(players);
  checkInvariants(state);

  let steps = 0;
  while (!game.isOver(state) && steps++ < MAX_STEPS) {
    if (state.phase === 'play') {
      const pid = game.turnOf(state)[0];
      const idx = chooseLegal(state, pid);
      assert(idx >= 0, '手番の人に出せる札がない');
      const res = game.action(state, pid, { type: 'play', index: idx }, room());
      assert(!res || !res.error, `play でエラー: ${res && res.error}`);
      checkInvariants(state);
      continue;
    }

    if (state.phase === 'result') {
      cov.resultHits++;
      const alive = aliveIds(state);
      const strategy = rnd();

      // ときどき切断・再接続・退席をはさむ
      if (rnd() < 0.3 && connected.size > 1) {
        const victim = pick([...connected]);
        connected.delete(victim);
        cov.disconnect++;
        const changed = game.onConnectionChange(state, room());
        checkInvariants(state);
        if (changed) continue; // 配りに進んだ
      }
      if (rnd() < 0.15) { // 再接続
        const off = players.map(p => p.id).filter(id => !connected.has(id));
        if (off.length) { connected.add(pick(off)); cov.reconnect++; game.onConnectionChange(state, room()); checkInvariants(state); }
      }
      if (rnd() < 0.05 && alive.length > 2) { // まれに退席（onLeave）
        const leaver = pick(alive);
        connected.delete(leaver);
        game.onLeave(state, leaver);
        cov.leave++;
        checkInvariants(state);
        continue;
      }

      if (strategy < 0.35) {
        // ホストが待たずに次へ
        const res = game.action(state, hostId, { type: 'forceNext' }, room());
        assert(!res || !res.error, `forceNext でエラー: ${res && res.error}`);
        cov.forceNext++;
      } else {
        // 必要な人が順に準備OK（最後の1人で自動的に配られる）
        const need = game.view(state, players[0].id).needIds;
        for (const id of need) {
          if (game.isOver(state) || state.phase !== 'result') break;
          const res = game.action(state, id, { type: 'ready', on: true }, room());
          assert(!res || !res.error, `ready でエラー: ${res && res.error}`);
          cov.ready++;
        }
        // 必要な人が誰もいない（全員切断）なら forceNext で進める
        if (state.phase === 'result') game.action(state, hostId, { type: 'forceNext' }, room());
      }
      checkInvariants(state);
      continue;
    }
  }

  assert(game.isOver(state), `${n}人: 終了しなかった（${steps} ステップ）`);
  // 終了時の勝者チェック
  const aliveCount = state.out.filter(o => !o).length;
  assert(aliveCount <= 1, `終了時に生存者が複数: ${aliveCount}`);
  if (state.winner !== null) {
    assert(state.winner >= 0 && state.winner < n && !state.out[state.winner], '勝者が不正');
  }
  cov.games++;
}

console.log('きゅうり乱数テスト開始…');
const t0 = Date.now();
for (let n = 2; n <= 7; n++) {
  for (let i = 0; i < GAMES_PER_SIZE; i++) runOne(n);
  console.log(`  ${n}人 × ${GAMES_PER_SIZE} ゲーム OK`);
}
const ms = Date.now() - t0;
console.log('--- カバレッジ ---');
console.log(cov);
assert(cov.ready > 0 && cov.forceNext > 0 && cov.disconnect > 0 && cov.leave > 0, '分岐の網羅が不足');
console.log(`\n✅ 全 ${cov.games} ゲーム 通過（${ms}ms）`);
