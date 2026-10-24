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
  revealOne: 0, revealAllMode: 0,
  chooseTheme: 0, timeoutTheme: 0, timeoutCompose: 0,
  draft: 0, submit: 0, unsubmit: 0, pick: 0, forcePick: 0,
  reveal: 0, revealAll: 0, pickTooEarly: 0,
  ready: 0, disconnect: 0, reconnect: 0, leave: 0,
  like: 0, likeSpectator: 0,
  awardOshi: 0, awardMeisaku: 0, awardChaos: 0, awardBlank: 0, awardTaisaku: 0, awardHitokoto: 0, awardWin: 0,
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
        assert(keysSubsetOf(ph, ['pos', 'text', 'mine', 'likes', 'liked']), `judge: phrase に余計なキー（作者漏れの恐れ）: ${Object.keys(ph)}`);
        // 1枚ずつ発表：めくった分（pos < revealed）だけ本文・いいねがある。めくる前は何もなし
        if (ph.pos >= state.revealed) assert(!('text' in ph) && !('likes' in ph), 'judge: めくる前の本文/いいねが view に漏れている');
        else { assert('text' in ph, 'judge: めくった短冊に本文がない'); assert(Number.isInteger(ph.likes) && typeof ph.liked === 'boolean', 'judge: めくった短冊のいいね情報が不正'); }
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
  // ときどき白紙カードも入れる（残りがある分だけ・表彰式「白紙の魔術師」や消費テストのため）
  if ((v.myBlanksLeft || 0) > 0 && rnd() < 0.3) tokens.push({ t: 'blank', text: pick(['あ', '推し', '神', '卍', 'ｗ']) });
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

// いいねを乱択で付け外しする（親以外の参加者か観戦者が、めくった短冊に）。view が壊れないことも兼ねる
function maybeLike(state, players, room) {
  if (rnd() > 0.3) return;
  const order = state.order || [];
  const maxPos = state.phase === 'judge' ? state.revealed : order.length;
  if (maxPos <= 0) return;
  const pos = Math.floor(rnd() * maxPos);
  const isSpec = rnd() < 0.35;
  let likerId;
  if (isSpec) likerId = 'spec-' + Math.floor(rnd() * 3);
  else {
    const pool = players.map((_, i) => i).filter(i => i !== state.parent && !state.left[i]);
    if (!pool.length) return;
    likerId = players[pick(pool)].id;
  }
  const r = game.action(state, likerId, { type: 'like', pos }, room());
  if (!r || !r.error) { cov.like++; if (isSpec) cov.likeSpectator++; } // 自作などは error（想定内）
}

// 決め打ちで judge まで進める（いいねの決定的テスト用）
function setupToJudge(n, revealMode) {
  const players = makePlayers(n);
  const room = () => ({ hostId: players[0].id, connectedIds: players.map(p => p.id) });
  const state = game.setup(players, { target: 10, timeLimit: 0, themeMode: 'random', revealMode, blankCards: 1 });
  assert(state.phase === 'compose', 'setupToJudge: compose で始まらない');
  for (let i = 0; i < n; i++) {
    if (i === state.parent) continue;
    const tokens = randomPhrase(state, i);
    const r = game.action(state, players[i].id, { type: 'submit', tokens }, room());
    assert(!r || !r.error, 'setupToJudge submit: ' + (r && r.error));
  }
  assert(state.phase === 'judge', 'setupToJudge: judge に入らない');
  return { players, room, state };
}

// いいねの決定的テスト（親・自作は拒否／付け外し／観戦者可／他の操作は観戦者拒否／連打制限）
function likeTests() {
  const { players, room, state } = setupToJudge(4, 'all'); // all なら最初から全部めくれている
  const parentId = players[state.parent].id;
  const order = state.order;
  const child = players.findIndex((_, i) => i !== state.parent);
  const childId = players[child].id;

  // 親は不可
  assert(game.action(state, parentId, { type: 'like', pos: 0 }, room()).error, '親の like は拒否されるべき');
  // 自分の作品は不可
  const myPos = order.findIndex(subIdx => state.submissions[subIdx].seat === child);
  assert(game.action(state, childId, { type: 'like', pos: myPos }, room()).error, '自作への like は拒否されるべき');
  // 他人の作品に付ける → 1、もう一度 → 0（付け外し）
  const otherPos = order.findIndex(subIdx => state.submissions[subIdx].seat !== child);
  let r = game.action(state, childId, { type: 'like', pos: otherPos }, room());
  assert(!r || !r.error, 'like: ' + (r && r.error));
  let v = game.view(state, childId);
  assert(v.phrases[otherPos].likes === 1 && v.phrases[otherPos].liked === true, '付けた後のカウント/liked が不正');
  game.action(state, childId, { type: 'like', pos: otherPos }, room());
  v = game.view(state, childId);
  assert(v.phrases[otherPos].likes === 0 && v.phrases[otherPos].liked === false, '外した後のカウント/liked が不正');
  // 観戦者（seat=-1）からの like は受け付ける
  r = game.action(state, 'spec-x', { type: 'like', pos: otherPos }, room());
  assert(!r || !r.error, '観戦者の like が拒否された: ' + (r && r.error));
  assert(game.view(state, childId).phrases[otherPos].likes === 1, '観戦者の like が数えられていない');
  // 観戦者から like 以外の操作は拒否
  assert(game.action(state, 'spec-x', { type: 'reveal' }, room()).error, '観戦者の reveal は拒否されるべき');
  assert(game.action(state, 'spec-x', { type: 'pick', index: 0 }, room()).error, '観戦者の pick は拒否されるべき');
  // 連打制限：1秒5回まで（6回目以降は silent＝無視）
  let silent = 0;
  for (let k = 0; k < 8; k++) { const rr = game.action(state, 'spec-burst', { type: 'like', pos: otherPos }, room()); if (rr && rr.silent) silent++; }
  assert(silent >= 1, '連打制限（1秒5回）が効いていない');
  console.log('  いいねの決定的テスト OK');
}

// 表彰式の賞を、サーバーとは別に素直に計算する（突き合わせ用）。各賞 → 受賞 seat の集合
function expectedAwards(state) {
  const subs = state.allSubs;
  const sumBy = fn => { const m = {}; for (const s of subs) m[s.seat] = (m[s.seat] || 0) + fn(s); return m; };
  const topSeats = m => { const vals = Object.values(m); const max = vals.length ? Math.max(...vals) : 0; return max > 0 ? Object.keys(m).filter(k => m[k] === max).map(Number) : []; };
  const maxOf = fn => subs.length ? Math.max(...subs.map(fn)) : 0;
  const out = {};
  out.oshi = topSeats(sumBy(s => s.likes));
  const maxLikes = maxOf(s => s.likes);
  out.meisaku = maxLikes > 0 ? [...new Set(subs.filter(s => s.likes === maxLikes).map(s => s.seat))] : [];
  out.chaos = topSeats(sumBy(s => s.chaos));
  out.blank = topSeats(sumBy(s => (s.picked && s.blanks > 0) ? 1 : 0));
  const maxLen = maxOf(s => s.length);
  out.taisaku = maxLen > 0 ? [...new Set(subs.filter(s => s.length === maxLen).map(s => s.seat))] : [];
  const picked = subs.filter(s => s.picked);
  const minLen = picked.length ? Math.min(...picked.map(s => s.length)) : 0;
  out.hitokoto = picked.length ? [...new Set(picked.filter(s => s.length === minLen).map(s => s.seat))] : [];
  out.win = state.winner != null ? [state.winner] : [];
  return out;
}

// over の view.awards と、素直な計算を突き合わせる
function verifyAwards(state, players) {
  const exp = expectedAwards(state);
  const v = game.view(state, players[0].id);
  const awards = v.awards || [];
  const bySeat = id => players.findIndex(p => p.id === id);
  const sorted = a => a.slice().sort((x, y) => x - y);
  const byKey = {};
  for (const a of awards) byKey[a.key] = sorted(a.winners.map(w => bySeat(w.id)));
  for (const key of Object.keys(exp)) {
    const want = sorted(exp[key]);
    const got = byKey[key] || [];
    assert(JSON.stringify(want) === JSON.stringify(got), `表彰式 ${key} 不一致: want ${JSON.stringify(want)} got ${JSON.stringify(got)}`);
    if (want.length) cov['award' + key[0].toUpperCase() + key.slice(1)]++;
  }
  // 賞のキーは想定内だけ
  for (const a of awards) assert(['oshi','meisaku','chaos','blank','taisaku','hitokoto','win'].includes(a.key), `未知の賞: ${a.key}`);
  // 「今日の選ばれた迷言」一覧は picks と同数
  assert((v.pickedList || []).length === state.picks.length, `pickedList の数が picks と不一致: ${(v.pickedList||[]).length} != ${state.picks.length}`);
}

function runOne(n) {
  const players = makePlayers(n);
  const hostId = players[0].id;
  const connected = new Set(players.map(p => p.id));
  const room = () => ({ hostId, connectedIds: [...connected] });

  const mode = pick(['random', 'parent', 'fixed']);
  cov['mode' + mode[0].toUpperCase() + mode.slice(1)]++;
  const revealMode = pick(['one', 'all']);
  cov[revealMode === 'one' ? 'revealOne' : 'revealAllMode']++;
  const options = {
    target: 3 + Math.floor(rnd() * 8),      // 3..10
    timeLimit: pick([30, 60, 90, 0]),
    themeMode: mode,
    fixedTheme: pick(THEMES).id,
    revealMode,
    blankCards: Math.floor(rnd() * 4),       // 0..3
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

      // 親切断 → ホストが（必要なら全部めくって）forcePick
      if (parentId !== hostId && rnd() < 0.12) {
        connected.delete(parentId);
        if (rnd() < 0.5 && state.revealed < state.order.length) {
          const r = game.action(state, hostId, { type: 'revealAll' }, room());
          assert(!r || !r.error, `host revealAll エラー: ${r && r.error}`);
          cov.revealAll++;
        }
        const res = game.action(state, hostId, { type: 'forcePick' }, room());
        assert(!res || !res.error, `forcePick エラー: ${res && res.error}`);
        connected.add(parentId);
        cov.forcePick++;
        checkInvariants(state, players);
        continue;
      }

      maybeLike(state, players, room); // めくった短冊にいいね（親以外・観戦者）

      // まだ全部めくっていない（1枚ずつ発表）→ めくる。たまに「めくる前の pick は拒否」を確認
      if (state.revealed < state.order.length) {
        if (rnd() < 0.1) {
          const r = game.action(state, parentId, { type: 'pick', index: 0 }, room());
          assert(r && r.error, 'めくり終わる前の pick は拒否されるべき');
          cov.pickTooEarly++;
        }
        if (rnd() < 0.5) {
          const r = game.action(state, parentId, { type: 'reveal' }, room());
          assert(!r || !r.error, `reveal エラー: ${r && r.error}`);
          cov.reveal++;
        } else {
          const r = game.action(state, parentId, { type: 'revealAll' }, room());
          assert(!r || !r.error, `revealAll エラー: ${r && r.error}`);
          cov.revealAll++;
        }
        checkInvariants(state, players);
        continue;
      }

      // 全部めくれた → 選ぶ
      const pos = Math.floor(rnd() * state.order.length);
      const res = game.action(state, parentId, { type: 'pick', index: pos }, room());
      assert(!res || !res.error, `pick エラー: ${res && res.error}`);
      cov.pick++;
      checkInvariants(state, players);
      continue;
    }

    if (state.phase === 'result') {
      if (state.flow && state.round !== lastFlowRound) { cov.flows++; lastFlowRound = state.round; }
      if (!state.flow) maybeLike(state, players, room); // 発表中もいいねできる
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
  verifyAwards(state, players); // 表彰式の賞を突き合わせる
  cov.games++;
}

console.log('迷言メーカー乱数テスト開始…');
likeTests();
const t0 = Date.now();
for (let n = 3; n <= 8; n++) {
  for (let i = 0; i < GAMES_PER_SIZE; i++) runOne(n);
  console.log(`  ${n}人 × ${GAMES_PER_SIZE} ゲーム OK`);
}
const ms = Date.now() - t0;
console.log('--- カバレッジ ---');
console.log(cov);
assert(cov.modeRandom && cov.modeParent && cov.modeFixed, 'テーマ3モードの網羅不足');
assert(cov.revealOne && cov.revealAllMode, '発表モードの網羅不足');
assert(cov.reveal && cov.revealAll && cov.pickTooEarly, '1枚ずつ発表の網羅不足');
assert(cov.chooseTheme && cov.timeoutTheme && cov.timeoutCompose, 'テーマ選択/時間切れの網羅不足');
assert(cov.draft && cov.submit && cov.unsubmit && cov.pick && cov.forcePick, '作成系の網羅不足');
assert(cov.ready && cov.disconnect && cov.reconnect && cov.leave, '準備OK/切断/退席の網羅不足');
assert(cov.like && cov.likeSpectator, 'いいね（参加者・観戦者）の網羅不足');
assert(cov.awardWin && cov.awardMeisaku && cov.awardChaos && cov.awardTaisaku && cov.awardOshi, '表彰式（主要な賞）の網羅不足');
assert(cov.awardBlank && cov.awardHitokoto, '表彰式（白紙の魔術師・ひとことで勝負賞）の網羅不足');
assert(cov.flows > 0, '流れたラウンドが一度もない');
console.log(`\n✅ 全 ${cov.games} ゲーム 通過（${ms}ms）`);
