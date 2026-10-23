// =============================================================
//  部屋の流れのテスト（ロビー・観戦・カウントダウン・再接続）
//  実サーバーを立てて socket.io-client で接続し、仕様 6-1 の
//  シナリオ 1〜11 を確かめる。
//  実行:  node test/room.flow.js   または   npm test
// =============================================================
const assert = require('assert');

const PORT = 3599;
process.env.PORT = String(PORT);
process.env.COUNTDOWN_MS = '500'; // テストでは短くする（本番は3000ms）
const COUNTDOWN = 500;

require('../server.js'); // サーバーを同一プロセスで起動
const { io: ioc } = require('socket.io-client');

const URL = `http://localhost:${PORT}`;
const sleep = ms => new Promise(r => setTimeout(r, ms));

// 1接続ぶんのクライアント。最新の room:update を覚えておく
class Client {
  constructor(label) {
    this.label = label;
    this.last = null;
    this.socket = ioc(URL, { forceNew: true, transports: ['websocket'], reconnection: false });
    this.socket.on('room:update', u => { this.last = u; });
  }
  emit(ev, data = {}) {
    return new Promise(res => this.socket.emit(ev, data, res));
  }
  // 条件を満たす room:update まで待つ（すでに満たしていれば即返す）
  wait(pred = () => true, timeout = 3000) {
    return new Promise((resolve, reject) => {
      if (this.last && pred(this.last)) return resolve(this.last);
      const onUpd = u => { if (pred(u)) { cleanup(); resolve(u); } };
      const t = setTimeout(() => { cleanup(); reject(new Error(`${this.label}: wait timeout`)); }, timeout);
      const cleanup = () => { clearTimeout(t); this.socket.off('room:update', onUpd); };
      this.socket.on('room:update', onUpd);
    });
  }
  close() { this.socket.close(); }
}

const clients = [];
function mk(label) { const c = new Client(label); clients.push(c); return c; }
const member = (u, id) => u.members.find(m => m.id === id);

async function createRoom(gameId, name = 'Host') {
  const host = mk(name);
  const res = await host.emit('room:create', { name, gameId });
  assert(res.ok, 'room:create 失敗');
  await host.wait(u => u.code === res.code);
  return { host, code: res.code, token: res.token };
}
async function join(code, name) {
  const c = mk(name);
  const res = await c.emit('room:join', { name, code });
  return { c, res };
}

// ---- シナリオ 1：2人参加＋1人観戦 → 全員準備OK → 開始。観戦者は spectatorView ----
async function scenario1() {
  const { host, code } = await createRoom('cucumber', 'H1');
  const { c: p2 } = await join(code, 'P2');
  const { c: p3 } = await join(code, 'P3');
  await p3.emit('lobby:role', { role: 'spectator' }); // 1人は観戦を選ぶ
  await host.wait(u => member(u, p3.last.you)?.role === 'spectator');

  await host.emit('lobby:ready', { on: true });
  await p2.emit('lobby:ready', { on: true });
  await p3.emit('lobby:ready', { on: true }); // 観戦者も準備OKが要る

  const started = await host.wait(u => u.phase === 'playing', COUNTDOWN + 2000);
  assert.strictEqual(started.phase, 'playing', 's1: 開始しなかった');
  assert.strictEqual(started.gamePlayerIds.length, 2, 's1: 参加者は2人のはず');
  assert(!started.gamePlayerIds.includes(p3.last.you), 's1: 観戦者がゲームに入っている');

  const sv = await p3.wait(u => u.phase === 'playing');
  assert.strictEqual(sv.yourRole, 'spectator', 's1: 観戦者の role が spectator でない');
  assert(sv.view, 's1: 観戦者に view が届いていない');
  assert(!sv.view.myHand || sv.view.myHand.length === 0, 's1: 観戦者に手札が見えている');
  assert.strictEqual(sv.yourTurn, false, 's1: 観戦者が手番になっている');
  console.log('  ✓ 1 参加2・観戦1 → 開始、観戦者は観戦ビュー');
}

// ---- シナリオ 2：カウントダウン中に取り消す → 開始しない ----
async function scenario2() {
  const { host, code } = await createRoom('cucumber', 'H2');
  const { c: p2 } = await join(code, 'P2');
  await p2.emit('lobby:ready', { on: true });
  await host.emit('lobby:ready', { on: true });
  await host.wait(u => u.countdownEndsAt != null, 1500); // カウントダウン開始
  await host.emit('lobby:ready', { on: false });          // すぐ取り消す
  await host.wait(u => u.countdownEndsAt == null, 1500);
  await sleep(COUNTDOWN + 300);
  assert.strictEqual(host.last.phase, 'lobby', 's2: 取り消したのに開始した');
  console.log('  ✓ 2 カウントダウン中に取り消すと止まる');
}

// ---- シナリオ 3：カウントダウン中に入室 → 止まる ----
async function scenario3() {
  const { host, code } = await createRoom('cucumber', 'H3');
  const { c: p2 } = await join(code, 'P2');
  await p2.emit('lobby:ready', { on: true });
  await host.emit('lobby:ready', { on: true });
  await host.wait(u => u.countdownEndsAt != null, 1500);
  await join(code, 'P3'); // 準備OKでない人が入る
  await host.wait(u => u.countdownEndsAt == null, 1500);
  await sleep(COUNTDOWN + 300);
  assert.strictEqual(host.last.phase, 'lobby', 's3: 入室後も開始してしまった');
  console.log('  ✓ 3 カウントダウン中の入室で止まる');
}

// ---- シナリオ 4：参加者が満員で lobby:role player → エラー ----
async function scenario4() {
  const { host, code } = await createRoom('tictactoe', 'H4'); // 最大2人
  await join(code, 'P2'); // ここで参加者が満員(2/2)
  const { c: p3, res } = await join(code, 'P3'); // 自動で観戦
  await p3.wait(u => u.code === code);
  assert.strictEqual(member(p3.last, p3.last.you).role, 'spectator', 's4: 満員なのに観戦でない');
  const r = await p3.emit('lobby:role', { role: 'player' });
  assert(r.error && /満員/.test(r.error), `s4: 満員エラーが返らない (${JSON.stringify(r)})`);
  console.log('  ✓ 4 満員で参加に変えるとエラー');
}

// ゲームを1つ始めて host+p2 が参加する状態を作る
async function startGame(code, host, p2) {
  await p2.emit('lobby:ready', { on: true });
  await host.emit('lobby:ready', { on: true });
  await host.wait(u => u.phase === 'playing', COUNTDOWN + 2000);
}

// ---- シナリオ 5：ゲーム中に入室 → 観戦者。game:action はエラー ----
async function scenario5() {
  const { host, code } = await createRoom('cucumber', 'H5');
  const { c: p2 } = await join(code, 'P2');
  await startGame(code, host, p2);
  const { c: p3 } = await join(code, 'P3'); // ゲーム中に入室
  const u = await p3.wait(u => u.phase === 'playing');
  assert.strictEqual(u.yourRole, 'spectator', 's5: ゲーム中入室が観戦者でない');
  const r = await p3.emit('game:action', { type: 'play', index: 0 });
  assert(r.error && /観戦/.test(r.error), `s5: 観戦中エラーが返らない (${JSON.stringify(r)})`);
  console.log('  ✓ 5 ゲーム中入室は観戦者・操作はエラー');
}

// ---- シナリオ 6：観戦者がゲーム中に退室 → ゲームは続く ----
async function scenario6() {
  const { host, code } = await createRoom('cucumber', 'H6');
  const { c: p2 } = await join(code, 'P2');
  await startGame(code, host, p2);
  const { c: p3 } = await join(code, 'P3');
  await p3.wait(u => u.phase === 'playing');
  const idsBefore = host.last.gamePlayerIds.slice();
  await p3.emit('room:leave');
  await host.wait(u => !u.members.some(m => m.name === 'P3'), 1500);
  assert.strictEqual(host.last.phase, 'playing', 's6: 観戦者退室でゲームが止まった');
  assert.deepStrictEqual(host.last.gamePlayerIds, idsBefore, 's6: 参加者が変わった');
  console.log('  ✓ 6 観戦者が抜けてもゲームは続く');
}

// ---- シナリオ 7：終了→ロビー。全員 ready=false、role 維持、途中観戦は player に ----
async function scenario7() {
  const { host, code } = await createRoom('cucumber', 'H7');
  const { c: p2 } = await join(code, 'P2');
  const { c: p4 } = await join(code, 'P4');
  await p4.emit('lobby:role', { role: 'spectator' }); // 自分で観戦を選ぶ（維持されるはず）
  await host.wait(u => member(u, p4.last.you)?.role === 'spectator');
  await p4.emit('lobby:ready', { on: true });
  await startGame(code, host, p2);

  const { c: p3 } = await join(code, 'P3'); // ゲーム中に観戦で入る（空きがあれば player に戻る）
  await p3.wait(u => u.phase === 'playing');

  await host.emit('game:lobby'); // ホストがロビーに戻す
  const u = await host.wait(u => u.phase === 'lobby', 1500);
  assert(u.members.every(m => m.ready === false), 's7: ロビーで ready が残っている');
  assert.strictEqual(member(u, host.last.you).role, 'player', 's7: ホストの role が変わった');
  assert.strictEqual(member(u, p4.last.you).role, 'spectator', 's7: 自分で選んだ観戦が維持されていない');
  assert.strictEqual(member(u, p3.last.you).role, 'player', 's7: 途中観戦者が player に戻っていない');
  console.log('  ✓ 7 終了→ロビーで ready 解除・role 整理');
}

// ---- シナリオ 8：設定変更で全員の ready が外れる ----
async function scenario8() {
  const { host, code } = await createRoom('cucumber', 'H8');
  const { c: p2 } = await join(code, 'P2');
  await p2.emit('lobby:ready', { on: true });
  await host.emit('lobby:ready', { on: true });
  await host.wait(u => u.countdownEndsAt != null, 1500);
  await host.emit('lobby:settings', { spectatorSeesAll: true });
  const u = await host.wait(u => u.settings.spectatorSeesAll === true);
  assert(u.members.every(m => m.ready === false), 's8: 設定変更で ready が外れていない');
  assert.strictEqual(u.countdownEndsAt, null, 's8: 設定変更でカウントダウンが止まらない');
  console.log('  ✓ 8 設定変更で全員の ready が外れる');
}

// ---- シナリオ 9：切断中は準備OKを待たれない。再接続で待ちに戻る ----
async function scenario9() {
  const { host, code } = await createRoom('cucumber', 'H9');
  const { c: p2 } = await join(code, 'P2');
  const { c: p3, res: r3 } = await join(code, 'P3');
  await host.emit('lobby:ready', { on: true });
  await p2.emit('lobby:ready', { on: true });
  // p3 は準備OKしない。切断すると「待たれない」ので開始条件がそろう
  await host.wait(u => u.countdownEndsAt == null); // まだそろっていない
  p3.close();
  await host.wait(u => u.countdownEndsAt != null, 2000);
  assert(host.last.countdownEndsAt != null, 's9: 切断中の人を待ってしまっている');
  // 再接続すると、準備OKでない人が戻るのでカウントダウンは止まる
  const p3b = mk('P3b');
  await p3b.emit('room:rejoin', { code, token: r3.token });
  await host.wait(u => u.countdownEndsAt == null, 2000);
  assert.strictEqual(host.last.countdownEndsAt, null, 's9: 再接続で待ちに戻らない');
  console.log('  ✓ 9 切断中は待たれない・再接続で待ちに戻る');
}

// ---- シナリオ 10：ホストの forceStart（人数が条件外ならエラー） ----
async function scenario10() {
  // 条件外（1人）→ エラー
  const { host: solo } = await createRoom('cucumber', 'Solo');
  const bad = await solo.emit('lobby:forceStart');
  assert(bad.error, 's10: 1人で forceStart がエラーにならない');
  // 条件内 → 準備OKを待たずに開始
  const { host, code } = await createRoom('tictactoe', 'H10');
  await join(code, 'P2');
  const ok = await host.emit('lobby:forceStart');
  assert(ok.ok, `s10: forceStart が失敗 (${JSON.stringify(ok)})`);
  await host.wait(u => u.phase === 'playing', 1500);
  console.log('  ✓ 10 forceStart（条件外はエラー・条件内は即開始）');
}

// ---- シナリオ 11：ホストが抜けると接続中の参加者にホストが移る ----
async function scenario11() {
  const { host, code } = await createRoom('cucumber', 'H11');
  const { c: p2 } = await join(code, 'P2');
  await p2.wait(u => u.code === code);
  const p2Id = p2.last.you;
  await host.emit('room:leave');
  await p2.wait(u => u.hostId === p2Id, 1500);
  assert.strictEqual(p2.last.hostId, p2Id, 's11: ホストが移らなかった');
  console.log('  ✓ 11 ホスト離脱で参加者にホストが移る');
}

async function main() {
  console.log('部屋の流れテスト開始…');
  const t0 = Date.now();
  await scenario1();
  await scenario2();
  await scenario3();
  await scenario4();
  await scenario5();
  await scenario6();
  await scenario7();
  await scenario8();
  await scenario9();
  await scenario10();
  await scenario11();
  console.log(`\n✅ 部屋の流れ 11 シナリオ 通過（${Date.now() - t0}ms）`);
}

main()
  .then(() => { for (const c of clients) c.close(); process.exit(0); })
  .catch(err => { console.error('\n❌ 失敗:', err.message); console.error(err); process.exit(1); });
