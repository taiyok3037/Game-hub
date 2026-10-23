// =============================================================
//  迷言メーカーの乱数テスト
//  3〜8人 × 各1000ゲームを、テーマ選択・下書き・提出・取り消し・時間切れ・
//  選考・準備OK・切断・退席の乱択で最後まで回す。
//  毎ステップ、匿名性・手札の秘匿・カード枚数・お題の重複などを検証する。
//  実行:  npm test   または   node test/meigen.random.js
// =============================================================
const assert = require('assert');
const fs = require('fs');
const path = require('path');

const game = require('../games/meigen/server.js');

const GAMES_PER_SIZE = 1000; // 3〜8人で合計 6,000 ゲーム
const MAX_STEPS = 200000;
const MAX_TOKENS = 10;

// ---- データ（枚数・お題数の期待値のため、テストでも読む） ----
const DATA = path.join(__dirname, '../games/meigen/data');
const COMMON = JSON.parse(fs.readFileSync(path.join(DATA, 'common.json'), 'utf8'));
// 共通カードの山は words（ふつう）＋ chaos（カオス）。総数はゲーム中ずっと一定
const COMMON_TOTAL = COMMON.words.length + (COMMON.chaos || []).length;
const THEMES = fs.readdirSync(path.join(DATA, 'themes'))
  .filter(f => f.endsWith('.json'))
  .map(f => JSON.parse(fs.readFileSync(path.join(DATA, 'themes', f), 'utf8')));
const themeSize = id => (THEMES.find(t => t.id === id) || { prompts: [] }).prompts.length;

// ---- 再現用の簡易乱数 ----
let rngState = 0x2545f491;
function rnd() {
  rngState ^= rngState << 13; rngState ^= rngState >>> 17; rngState ^= rngState << 5;
  return ((rngState >>> 0) % 100000) / 100000;
}
const pick = arr => arr[Math.floor(rnd() * arr.length)];
const makePlayers = n => Array.from({ length: n }, (_, i) => ({ id: `p${i}`, name: `P${i}` }));

const cov = {
  modeRandom: 0, modeParent: 0, modeFixed: 0,
  chooseTheme: 0, timeoutTheme: 0, timeoutCompose: 0,
  draft: 0, submit: 0, unsubmit: 0, pick: 0, forcePick: 0,
  ready: 0, disconnect: 0, reconnect: 0, leave: 0,
  games: 0, flows: 0, overByTarget: 0, overByFew: 0,
};

// 共通カード（ふつう＝common・カオス＝chaos）の総数（手札＋山＋捨て札＋提出中）
function countCommon(state) {
  const isCommon = c => c.kind === 'common' || c.kind === 'chaos';
  let c = 0;
  for (const h of state.hands) c += h.filter(isCommon).length;
  c += state.commonDeck.length + state.commonDiscard.length; // 山・捨て札は common/chaos のみ
  for (const sub of state.submissions) c += sub.cards.filter(isCommon).length;
  return c;
}

// オブジェクトのキー集合が許したものだけか
const keysSubsetOf = (obj, allowed) => Object.keys(obj).every(k => allowed.includes(k));

function checkInvariants(state, players) {
  assert(['theme', 'compose', 'judge', 'result', 'over'].includes(state.phase), `phase 不正: ${state.phase}`);

  // 点数は選ばれた回数と一致する
  const counts = players.map(() => 0);
  for (const pk of state.picks) counts[pk.seat]++;
  for (let i = 0; i < players.length; i++) {
    assert(state.scores[i] === counts[i], `score が選ばれた回数と不一致 (seat ${i}: ${state.scores[i]} != ${counts[i]})`);
    assert(Number.isInteger(state.scores[i]) && state.scores[i] >= 0, 'score 不正');
  }
  // 目標点に達した人がいれば over
  const maxScore = Math.max(...state.scores);
  if (maxScore >= state.options.target) assert(state.phase === 'over', '目標点に達したのに over でない');

  // 共通カードの総数は一定
  assert(countCommon(state) === COMMON_TOTAL, `共通カード総数が不一定: ${countCommon(state)} != ${COMMON_TOTAL}`);

  // 全員の view・観戦ビューが例外なく作れる
  for (const p of players) game.view(state, p.id);
  game.view(state, null);
  const svF = game.spectatorView(state, { seesAll: false, viewerId: 'spec' });
  const svT = game.spectatorView(state, { seesAll: true, viewerId: 'spec' });

  // 子同士でテーマカードが重複しない（配られているラウンド）
  if (state.theme && ['compose', 'judge', 'result'].includes(state.phase)) {
    const seen = new Set();
    const childSeats = players.map((_, i) => i).filter(i => !state.left[i] && i !== state.parent);
    for (const seat of childSeats) {
      // 本来配られた4枚＝手札に残る分＋このラウンドの提出で使った分
      const texts = (state.themeHands[seat] || []).map(c => c.text);
      for (const sub of state.submissions) if (sub.seat === seat) for (const c of sub.cards) if (c.kind === 'theme') texts.push(c.text);
      for (const tx of texts) {
        assert(!seen.has(tx), `子同士でテーマカードが重複: ${tx}`);
        seen.add(tx);
      }
    }
  }

  // compose：他人の view に自分の下書き・提出内容・手札の中身が入っていない
  if (state.phase === 'compose') {
    for (const p of players) {
      const v = game.view(state, p.id);
      for (const pl of v.players) {
        assert(!('hand' in pl) && !('themeHand' in pl) && !('draft' in pl), 'compose: 他人の手札/下書きが view に漏れている');
      }
    }
    // seesAll=false の観戦ビューにも手札は出さない
    for (const pl of svF.players) assert(!('hand' in pl), 'compose: seesAll=false の観戦ビューに手札が漏れている');
  }

  // judge：全員の view と spectatorView（seesAll 両方）に作者を特定できる情報がない
  if (state.phase === 'judge') {
    const viewsToCheck = [...players.map(p => game.view(state, p.id)), svF, svT];
    for (const v of viewsToCheck) {
      assert(Array.isArray(v.phrases), 'judge: phrases がない');
      assert(v.phrases.length === state.submissions.length, 'judge: phrases の数が提出数と違う');
      assert(v.results === undefined && v.pickId === undefined, 'judge: 作者つきの results/pickId が漏れている');
      for (const ph of v.phrases) {
        assert(keysSubsetOf(ph, ['pos', 'text', 'mine']), `judge: phrase に余計なキー（作者漏れの恐れ）: ${Object.keys(ph)}`);
      }
    }
    // 本人視点では自分の作品にだけ mine が付く
    for (const p of players) {
      const seat = players.findIndex(x => x.id === p.id);
      const v = game.view(state, p.id);
      const mineCount = v.phrases.filter(ph => ph.mine).length;
      const submitted = state.submissions.some(s => s.seat === seat);
      assert(mineCount === (submitted ? 1 : 0), `judge: mine の数が不正 (seat ${seat})`);
    }
    // 観戦ビューには mine も付かない
    for (const ph of svT.phrases) assert(!ph.mine, 'judge: 観戦ビューに mine が付いている');
  }

  // turnOf の整合
  const t = game.turnOf(state);
  if (state.phase === 'theme') assert(t.length === 1, 'theme の turnOf は親1人');
  else if (state.phase === 'compose') assert(t.length >= 1, 'compose の turnOf は未提出の子');
  else if (state.phase === 'judge') assert(t.length === 1, 'judge の turnOf は親1人');
  else assert(t.length === 0, 'result/over の turnOf は空');
}

// 子の有効なフレーズをランダムに作る（カードを最低1枚・最大10トークン）
function randomPhrase(state, seat) {
  const v = game.view(state, state.players[seat].id);
  const cards = [
    ...v.myHand.map(c => ({ t: 'card', id: c.id })),
    ...v.myThemeHand.map(c => ({ t: 'card', id: c.id })),
  ];
  if (!cards.length) return null;
  const tokens = [pick(cards)];
  const extra = Math.floor(rnd() * 4);
  for (let i = 0; i < extra; i++) {
    if (rnd() < 0.5) tokens.push(pick(cards));
    else tokens.push({ t: 'chip', text: pick(v.connectors) });
  }
  // カード id の重複を除く（submit は重複カードを弾くため）
  const seen = new Set();
  const out = [];
  for (const tk of tokens) {
    if (tk.t === 'card') { if (seen.has(tk.id)) continue; seen.add(tk.id); }
    out.push(tk);
    if (out.length >= MAX_TOKENS) break;
  }
  return out;
}

function runOne(n) {
  const players = makePlayers(n);
  const hostId = players[0].id;
  const connected = new Set(players.map(p => p.id));
  const room = () => ({ hostId, connectedIds: [...connected] });

  const mode = pick(['random', 'parent', 'fixed']);
  cov['mode' + mode[0].toUpperCase() + mode.slice(1)]++;
  const options = {
    target: 3 + Math.floor(rnd() * 8),      // 3..10
    timeLimit: pick([30, 60, 90, 0]),
    themeMode: mode,
    fixedTheme: pick(THEMES).id,
  };

  const state = game.setup(players, options);
  checkInvariants(state, players);

  // お題の重複チェック用（テーマごとに、尽きるまで重複しない）
  const perTheme = {};
  let recordedRound = -1;
  function recordPrompt() {
    if (!state.prompt || state.round === recordedRound) return;
    recordedRound = state.round;
    const s = perTheme[state.theme] || (perTheme[state.theme] = new Set());
    assert(!s.has(state.prompt), `同じゲームで同じお題が出た: ${state.prompt}`);
    s.add(state.prompt);
    if (s.size >= themeSize(state.theme)) perTheme[state.theme] = new Set(); // 尽きたらサーバーと同じくリセット
  }
  recordPrompt();

  let composeTurns = 0;
  let roundMark = state.round;
  let lastFlowRound = -1;
  let steps = 0;

  while (!game.isOver(state) && steps++ < MAX_STEPS) {
    if (state.round !== roundMark) { roundMark = state.round; composeTurns = 0; }

    if (state.phase === 'theme') {
      const parentId = state.players[state.parent].id;
      if (rnd() < 0.3) {
        state.deadlineAt = Date.now() - 1; // 締め切りを過去に
        game.onTimeout(state, room());
        cov.timeoutTheme++;
      } else {
        const v = game.view(state, parentId);
        const choice = pick(v.themeChoices);
        const res = game.action(state, parentId, { type: 'chooseTheme', themeId: choice.id }, room());
        assert(!res || !res.error, `chooseTheme エラー: ${res && res.error}`);
        cov.chooseTheme++;
      }
      recordPrompt();
      checkInvariants(state, players);
      continue;
    }

    if (state.phase === 'compose') {
      composeTurns++;
      const unsubmitted = state.players.map((_, i) => i)
        .filter(i => !state.left[i] && i !== state.parent && !state.submissions.some(s => s.seat === i));
      const submitted = state.players.map((_, i) => i)
        .filter(i => !state.left[i] && i !== state.parent && state.submissions.some(s => s.seat === i));

      if (composeTurns > 40 || rnd() < 0.18 || unsubmitted.length === 0) {
        state.deadlineAt = Date.now() - 1;
        game.onTimeout(state, room());
        cov.timeoutCompose++;
      } else {
        const r = rnd();
        if (r < 0.55) {
          const seat = pick(unsubmitted);
          const tokens = randomPhrase(state, seat);
          const res = game.action(state, state.players[seat].id, { type: 'submit', tokens }, room());
          assert(!res || !res.error, `submit エラー: ${res && res.error}`);
          cov.submit++;
        } else if (r < 0.8) {
          const seat = pick(unsubmitted);
          const tokens = rnd() < 0.5 ? randomPhrase(state, seat) : []; // ときどき空の下書き（不参加になる）
          const res = game.action(state, state.players[seat].id, { type: 'draft', tokens }, room());
          assert(res && res.silent === true, 'draft は silent を返すべき');
          cov.draft++;
        } else if (submitted.length) {
          const seat = pick(submitted);
          const res = game.action(state, state.players[seat].id, { type: 'unsubmit' }, room());
          assert(!res || !res.error, `unsubmit エラー: ${res && res.error}`);
          cov.unsubmit++;
        }
      }
      recordPrompt();
      checkInvariants(state, players);
      continue;
    }

    if (state.phase === 'judge') {
      const parentSeat = state.parent;
      const parentId = state.players[parentSeat].id;
      if (parentId !== hostId && rnd() < 0.15) {
        // 親が切断 → ホストが forcePick
        connected.delete(parentId);
        const res = game.action(state, hostId, { type: 'forcePick' }, room());
        assert(!res || !res.error, `forcePick エラー: ${res && res.error}`);
        connected.add(parentId);
        cov.forcePick++;
      } else {
        const pos = Math.floor(rnd() * state.order.length);
        const res = game.action(state, parentId, { type: 'pick', index: pos }, room());
        assert(!res || !res.error, `pick エラー: ${res && res.error}`);
        cov.pick++;
      }
      checkInvariants(state, players);
      continue;
    }

    if (state.phase === 'result') {
      if (state.flow && state.round !== lastFlowRound) { cov.flows++; lastFlowRound = state.round; }
      // 1イテレーションにつき1操作だけ行う（ラウンドの二重進行で recordPrompt が漏れないように）
      const activeNonHost = state.players.map((_, i) => i)
        .filter(i => !state.left[i] && state.players[i].id !== hostId);
      const off = state.players.map(p => p.id).filter(id => !connected.has(id));
      const r = rnd();

      if (r < 0.12 && activeNonHost.some(i => connected.has(state.players[i].id))) {
        const victim = state.players[pick(activeNonHost.filter(i => connected.has(state.players[i].id)))].id;
        connected.delete(victim);
        cov.disconnect++;
        game.onConnectionChange(state, room());
      } else if (r < 0.22 && off.length) {
        connected.add(pick(off));
        cov.reconnect++;
        game.onConnectionChange(state, room());
      } else if (r < 0.28 && activeNonHost.length) {
        const seat = pick(activeNonHost);
        connected.delete(state.players[seat].id);
        game.onLeave(state, state.players[seat].id);
        cov.leave++;
      } else {
        // 準備OKを押していない「必要な人」を1人だけ押す（最後の1人で次のラウンドへ）
        const view = game.view(state, hostId);
        const todo = view.needIds.filter(id => connected.has(id) && !view.readyIds.includes(id));
        if (todo.length) {
          const res = game.action(state, todo[0], { type: 'next', on: true }, room());
          assert(!res || !res.error, `next エラー: ${res && res.error}`);
          cov.ready++;
        }
      }
      recordPrompt();
      checkInvariants(state, players);
      continue;
    }
  }

  assert(game.isOver(state), `${n}人: 終了しなかった（${steps} ステップ, mode=${mode}）`);
  const activeCount = state.left.filter(l => !l).length;
  if (activeCount <= 2) cov.overByFew++;
  else cov.overByTarget++;
  if (state.winner !== null) {
    assert(!state.left[state.winner], '勝者が退席者');
  }
  cov.games++;
}

console.log('迷言メーカー乱数テスト開始…');
const t0 = Date.now();
for (let n = 3; n <= 8; n++) {
  for (let i = 0; i < GAMES_PER_SIZE; i++) runOne(n);
  console.log(`  ${n}人 × ${GAMES_PER_SIZE} ゲーム OK`);
}
const ms = Date.now() - t0;
console.log('--- カバレッジ ---');
console.log(cov);
assert(cov.modeRandom && cov.modeParent && cov.modeFixed, 'テーマ3モードの網羅不足');
assert(cov.chooseTheme && cov.timeoutTheme && cov.timeoutCompose, 'テーマ選択/時間切れの網羅不足');
assert(cov.draft && cov.submit && cov.unsubmit && cov.pick && cov.forcePick, '作成系の網羅不足');
assert(cov.ready && cov.disconnect && cov.reconnect && cov.leave, '準備OK/切断/退席の網羅不足');
assert(cov.flows > 0, '流れたラウンドが一度もない');
console.log(`\n✅ 全 ${cov.games} ゲーム 通過（${ms}ms）`);
