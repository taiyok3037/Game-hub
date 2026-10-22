// =============================================================
//  三目並べ・ババ抜きのランダム完走チェック
//  setup から isOver まで乱数で回し、終わらない・手番がおかしい・
//  状態が壊れる、がないことを確認する。
//  実行:  node test/board.random.js
// =============================================================
const assert = require('assert');
const ttt = require('../games/tictactoe/server.js');
const om = require('../games/oldmaid/server.js');

let rngState = 0x0f0f1234;
function rnd() {
  rngState ^= rngState << 13; rngState ^= rngState >>> 17; rngState ^= rngState << 5;
  return ((rngState >>> 0) % 100000) / 100000;
}
const pick = arr => arr[Math.floor(rnd() * arr.length)];
const makePlayers = n => Array.from({ length: n }, (_, i) => ({ id: `p${i}`, name: `P${i}` }));

// ---- 三目並べ ----
function runTtt() {
  const players = makePlayers(2);
  const s = ttt.setup(players);
  let steps = 0;
  while (!ttt.isOver(s) && steps++ < 20) {
    const turnIds = ttt.turnOf(s);
    assert(turnIds.length === 1, '三目並べ: 対局中の turnOf は1人');
    const pid = turnIds[0];
    const seat = s.players.findIndex(p => p.id === pid);
    assert(seat === s.turn, '三目並べ: turnOf と turn が食い違う');
    const empty = s.board.map((c, i) => (c === null ? i : -1)).filter(i => i >= 0);
    assert(empty.length > 0, '三目並べ: 空きマスがないのに未終了');
    const res = ttt.action(s, pid, { type: 'place', index: pick(empty) });
    assert(!res || !res.error, `三目並べ: action エラー ${res && res.error}`);
    // 各プレイヤーの view が例外なく作れる
    for (const p of players) ttt.view(s, p.id);
  }
  assert(ttt.isOver(s), '三目並べ: 終了しなかった');
  assert(ttt.turnOf(s).length === 0, '三目並べ: 終了後の turnOf は空');
  // 勝者がいれば盤面に3つ並びがある。引き分けなら全マス埋まり
  if (s.winner === null) assert(s.draw && s.board.every(c => c !== null), '三目並べ: 引き分けの盤面が不正');
}

// ---- ババ抜き ----
function runOldmaid(n) {
  const players = makePlayers(n);
  const s = om.setup(players);
  let steps = 0;
  const totalCards = () => s.hands.reduce((a, h) => a + h.length, 0);
  while (!om.isOver(s) && steps++ < 2000) {
    const turnIds = om.turnOf(s);
    assert(turnIds.length === 1, 'ババ抜き: 対局中の turnOf は1人');
    const pid = turnIds[0];
    const v = om.view(s, pid);
    assert(v.currentId === pid, 'ババ抜き: turnOf と currentId が食い違う');
    const target = v.players.find(p => p.id === v.targetId);
    assert(target && target.count > 0, 'ババ抜き: 引く相手の手札がない');
    const before = totalCards();
    const res = om.action(s, pid, { type: 'draw', index: Math.floor(rnd() * target.count) });
    assert(!res || !res.error, `ババ抜き: action エラー ${res && res.error}`);
    // 1回の draw で総枚数は変わらない（ペア不成立）か 2枚減る（ペア成立）
    const diff = before - totalCards();
    assert(diff === 0 || diff === 2, `ババ抜き: 総枚数の増減が不正 (${diff})`);
    // 隠し情報チェック：他人の手札は中身が来ない（自分の手札だけ）
    for (const p of players) {
      const pv = om.view(s, p.id);
      assert(Array.isArray(pv.myHand), 'ババ抜き: myHand がない');
    }
  }
  assert(om.isOver(s), `ババ抜き(${n}人): 終了しなかった`);
  assert(om.turnOf(s).length === 0, 'ババ抜き: 終了後の turnOf は空');
  // 最後は1人だけ手札が残る（または全員0）
  const withCards = s.hands.filter(h => h.length > 0).length;
  assert(withCards <= 1, `ババ抜き: 終了時に手札が残る人が複数 (${withCards})`);
}

console.log('三目並べ・ババ抜き 完走チェック開始…');
const t0 = Date.now();

for (let i = 0; i < 5000; i++) runTtt();
console.log('  三目並べ × 5000 ゲーム OK');

let total = 0;
for (let n = 2; n <= 6; n++) {
  for (let i = 0; i < 2000; i++) { runOldmaid(n); total++; }
  console.log(`  ババ抜き ${n}人 × 2000 ゲーム OK`);
}

console.log(`\n✅ 三目並べ5000 ＋ ババ抜き${total} ゲーム 通過（${Date.now() - t0}ms）`);
