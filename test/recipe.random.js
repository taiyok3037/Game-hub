// =============================================================
//  喫茶店のレシピ帳の乱数テスト
//  2〜4人 × 各1000ゲームを、シード付き乱数で合法手の中からランダムに
//  （ときどき「作れるなら作る」優先で）最後まで回す。毎ステップ検証する。
//  実行:  npm test   または   node test/recipe.random.js
// =============================================================
const assert = require('assert');
const fs = require('fs');
const path = require('path');

const game = require('../games/recipe/server.js');
const DATA = JSON.parse(fs.readFileSync(path.join(__dirname, '../games/recipe/data/cards.json'), 'utf8'));
const INGS = DATA.ingredients.map(i => i.id);
const SPICE = DATA.wild.id;
const COLORS6 = [...INGS, SPICE];
const TOTAL_CARDS = DATA.cards.length; // 90

const GAMES_PER_SIZE = 1000;
const MAX_STEPS = 100000;

// ---- 再現用の簡易乱数（シード付き xorshift）----
let rngState = 0x9e3779b9;
function rnd() {
  rngState ^= rngState << 13; rngState ^= rngState >>> 17; rngState ^= rngState << 5;
  return ((rngState >>> 0) % 1000000) / 1000000;
}
const pick = arr => arr[Math.floor(rnd() * arr.length)];
const makePlayers = n => Array.from({ length: n }, (_, i) => ({ id: `p${i}`, name: `P${i}` }));

const cov = {
  take3: 0, take3short: 0, take2: 0, reserveMarket: 0, reserveDeck: 0, buildMarket: 0, buildReserved: 0,
  discard: 0, regular: 0, regularChoice: 0, pass: 0, reserveSpice: 0,
  errTurn: 0, errDup: 0, errTake2: 0, errAfford: 0, errPending: 0,
  overTarget: 0, overRounds: 0, overLeave: 0, tieBuilt: 0, games: 0,
};

// サーバーと同じ支払い計算（突き合わせ用）
function mirrorPay(seat, card) {
  const plan = {}; let spice = 0;
  for (const ing of INGS) { const need = Math.max(0, (card.cost[ing] || 0) - seat.bonus[ing]); const fi = Math.min(need, seat.tokens[ing]); plan[ing] = fi; spice += need - fi; }
  return { ok: spice <= seat.tokens[SPICE], plan, spice };
}
const sumTokens = t => COLORS6.reduce((a, c) => a + t[c], 0);

function bankPlusHands(state) {
  let s = sumTokens(state.bank);
  for (const seat of state.seats) s += sumTokens(seat.tokens);
  return s;
}
function cardsOnTable(state) {
  let c = 0;
  for (let t = 0; t < 3; t++) { c += state.decks[t].length; c += state.market[t].filter(x => x).length; }
  for (const seat of state.seats) c += seat.reserved.length + seat.built.length;
  return c;
}

function checkInvariants(state, players, totalTokens, discarded) {
  assert(['play', 'over'].includes(state.phase), `phase 不正: ${state.phase}`);
  // チップの総数は一定
  assert(bankPlusHands(state) === totalTokens, `チップ総数が不一定: ${bankPlusHands(state)} != ${totalTokens}`);
  // 銀行は負にならない
  for (const c of COLORS6) assert(state.bank[c] >= 0, `銀行が負: ${c}`);
  // カードの総数は 90 から、退席で捨てられた予約カードを引いた数で一定
  assert(cardsOnTable(state) === TOTAL_CARDS - discarded, `カード総数が不一定: ${cardsOnTable(state)} != ${TOTAL_CARDS - discarded}`);
  // 予約は3枚まで
  for (const seat of state.seats) assert(seat.reserved.length <= 3, '予約が3枚を超えた');
  // 番の区切り（pending なし）では、全員 10枚以下
  if (!state.pending || state.phase === 'over') {
    for (let i = 0; i < state.seats.length; i++) assert(sumTokens(state.seats[i].tokens) <= 10, `手元が10枚超: seat ${i}`);
  }
  // view が例外なく作れる
  for (const p of players) game.view(state, p.id);
  const svF = game.spectatorView(state, { seesAll: false, viewerId: 'spec' });
  const svT = game.spectatorView(state, { seesAll: true, viewerId: 'spec' });
  // 山の中身・順番は誰の view にも入らない（残り枚数だけ）
  for (const p of [...players.map(x => x.id), null]) {
    const v = p === null ? svF : game.view(state, p);
    assert(v.decks === undefined, 'view に山（decks）が漏れている');
    assert(Array.isArray(v.deckCounts) && v.deckCounts.length === 3, 'deckCounts がない');
  }
  // 隠し予約（hidden）の中身が、本人以外の view・seesAll=false の spectatorView に入らない
  for (let owner = 0; owner < state.seats.length; owner++) {
    state.seats[owner].reserved.forEach((r, k) => {
      if (!r.hidden) return;
      // 本人の view には中身がある
      const mine = game.view(state, players[owner].id).players[owner].reserved[k];
      assert(mine.card && mine.card.id === r.card.id, '本人の隠し予約の中身が見えない');
      // 他人の view / seesAll=false には中身がない（段階だけ）
      for (let other = 0; other < players.length; other++) {
        if (other === owner) continue;
        const seen = game.view(state, players[other].id).players[owner].reserved[k];
        assert(!seen.card && seen.tier === r.card.tier, '他人に隠し予約の中身が漏れている');
      }
      const sv = svF.players[owner].reserved[k];
      assert(!sv.card && sv.tier === r.card.tier, 'seesAll=false の観戦に隠し予約が漏れている');
      // seesAll=true には見せる
      assert(svT.players[owner].reserved[k].card, 'seesAll=true の観戦に隠し予約が出ていない');
    });
  }
}

// いまの手番の合法なメイン手を集める
function legalMoves(state, seat) {
  const s = state.seats[seat];
  const moves = [];
  // build
  for (let t = 0; t < 3; t++) state.market[t].forEach((c, i) => { if (c && mirrorPay(s, c).ok) moves.push({ type: 'build', from: 'market', tier: t + 1, index: i }); });
  s.reserved.forEach((r, i) => { if (mirrorPay(s, r.card).ok) moves.push({ type: 'build', from: 'reserved', index: i }); });
  // reserve
  if (s.reserved.length < 3) {
    for (let t = 0; t < 3; t++) {
      state.market[t].forEach((c, i) => { if (c) moves.push({ type: 'reserve', tier: t + 1, index: i }); });
      if (state.decks[t].length) moves.push({ type: 'reserve', tier: t + 1, index: 'deck' });
    }
  }
  // take3
  const avail = INGS.filter(c => state.bank[c] > 0);
  if (avail.length) {
    const k = Math.min(3, avail.length);
    const shuffled = avail.slice();
    for (let i = shuffled.length - 1; i > 0; i--) { const j = Math.floor(rnd() * (i + 1)); [shuffled[i], shuffled[j]] = [shuffled[j], shuffled[i]]; }
    moves.push({ type: 'take3', colors: shuffled.slice(0, k) });
  }
  // take2
  for (const c of INGS) if (state.bank[c] >= 4) moves.push({ type: 'take2', color: c });
  return moves;
}

function resolvePending(state, seat, players, room) {
  const s = state.seats[seat];
  if (state.pending.type === 'discard') {
    let over = state.pending.over; const tokens = {};
    const colors = COLORS6.filter(c => s.tokens[c] > 0);
    // ランダムに over 枚ぶん選ぶ
    let budget = over;
    for (const c of colors) {
      if (budget <= 0) break;
      const take = Math.min(s.tokens[c], 1 + Math.floor(rnd() * budget));
      if (take > 0) { tokens[c] = (tokens[c] || 0) + Math.min(take, budget); budget -= Math.min(take, budget); }
    }
    // 端数が残ったら埋める
    for (const c of colors) { while (budget > 0 && (tokens[c] || 0) < s.tokens[c]) { tokens[c] = (tokens[c] || 0) + 1; budget--; } }
    const before = sumTokens(s.tokens);
    const r = game.action(state, players[seat].id, { type: 'discard', tokens }, room());
    assert(!r || !r.error, `discard エラー: ${r && r.error}`);
    assert(sumTokens(s.tokens) === before - over, 'discard 後の枚数が合わない');
    cov.discard++;
  } else if (state.pending.type === 'regular') {
    const choices = state.pending.choices.slice();
    assert(choices.length >= 2, 'regular 選択は2つ以上のはず');
    const id = pick(choices);
    const ptsBefore = s.points;
    const reg = state.regulars.find(x => x.id === id);
    const r = game.action(state, players[seat].id, { type: 'chooseRegular', id }, room());
    assert(!r || !r.error, `chooseRegular エラー: ${r && r.error}`);
    assert(s.points === ptsBefore + reg.points, '常連さんの点が入っていない');
    cov.regularChoice++;
  }
}

function runOne(n) {
  const players = makePlayers(n);
  const hostId = players[0].id;
  const connected = new Set(players.map(p => p.id));
  const room = () => ({ hostId, connectedIds: [...connected] });

  const options = { target: 10 + Math.floor(rnd() * 12), turnTime: pick([30, 60, 90, 0]) };
  const state = game.setup(players, options, { rng: rnd });

  const perColor = n <= 2 ? 4 : n === 3 ? 5 : 7;
  const totalTokens = perColor * 5 + 5;
  // 材料チップの数（4/5/7）とスパイス5の確認
  for (const c of INGS) assert(state.bank[c] === perColor, `初期の${c}が${perColor}でない`);
  assert(state.bank[SPICE] === 5, 'スパイスの初期が5でない');
  assert(state.regulars.length === n + 1, `常連さんが人数+1でない`);

  let discarded = 0; // 退席で場から捨てられた予約カードの累計
  checkInvariants(state, players, totalTokens, discarded);

  const turnsTaken = players.map(() => 0);
  let steps = 0;
  let leftHappened = false;

  while (!game.isOver(state) && steps++ < MAX_STEPS) {
    const seat = state.order[state.turnIdx];
    const sid = players[seat].id;

    // --- pending の解消 ---
    if (state.pending) {
      // pending 中に別の action を送ると拒否される
      if (rnd() < 0.2) {
        const bad = state.pending.type === 'discard' ? { type: 'pass' } : { type: 'take2', color: INGS[0] };
        const r = game.action(state, sid, bad, room());
        assert(r && r.error, 'pending 中の別 action は拒否されるべき');
        cov.errPending++;
      }
      resolvePending(state, seat, players, room);
      checkInvariants(state, players, totalTokens, discarded);
      continue;
    }

    // --- ときどき不正 action を試す（拒否されること）---
    if (rnd() < 0.08) {
      const other = (seat + 1) % n;
      const r = game.action(state, players[other].id, { type: 'take3', colors: [INGS[0]] }, room());
      assert(r && r.error, '他人の番の action は拒否されるべき');
      cov.errTurn++;
    }
    if (rnd() < 0.05) {
      const r = game.action(state, sid, { type: 'take3', colors: [INGS[0], INGS[0]] }, room());
      assert(r && r.error, 'take3 の同じ種類は拒否されるべき');
      cov.errDup++;
    }
    if (rnd() < 0.05) {
      const lacking = INGS.find(c => state.bank[c] < 4);
      if (lacking) { const r = game.action(state, sid, { type: 'take2', color: lacking }, room()); assert(r && r.error, 'take2 は4枚未満なら拒否されるべき'); cov.errTake2++; }
    }
    if (rnd() < 0.06) {
      // 払えないカードを作ろうとすると拒否される
      let bad = null;
      for (let t = 0; t < 3 && !bad; t++) state.market[t].forEach((c, i) => { if (c && !bad && !mirrorPay(state.seats[seat], c).ok) bad = { type: 'build', from: 'market', tier: t + 1, index: i }; });
      if (bad) { const r = game.action(state, sid, bad, room()); assert(r && r.error, '材料不足の build は拒否されるべき'); cov.errAfford++; }
    }

    // --- ときどき退席（残り2人以上のとき・手番でない人を）---
    if (rnd() < 0.004 && !leftHappened) {
      const others = players.map((_, i) => i).filter(i => i !== seat && !state.left[i]);
      if (others.length >= 2) { // 退席しても2人以上残る
        const victim = pick(others);
        discarded += state.seats[victim].reserved.length; // 捨てられる予約カード
        game.onLeave(state, players[victim].id);
        leftHappened = true;
        checkInvariants(state, players, totalTokens, discarded);
        continue;
      }
    }

    // --- 合法手を選ぶ（40%は作れるなら作る）---
    const moves = legalMoves(state, seat);
    if (!moves.length) {
      const r = game.action(state, sid, { type: 'pass' }, room());
      assert(!r || !r.error, `pass エラー: ${r && r.error}`);
      cov.pass++;
      turnsTaken[seat]++;
      checkInvariants(state, players, totalTokens, discarded);
      continue;
    }
    const builds = moves.filter(m => m.type === 'build');
    let move;
    if (builds.length && rnd() < 0.4) move = pick(builds);
    else move = pick(moves);

    // 期待する支払い・効果を先に控える
    const s = state.seats[seat];
    const snapTokens = { ...s.tokens };
    const snapBank = { ...state.bank };
    const snapBonus = { ...s.bonus };
    const snapPts = s.points;
    const snapRegPts = s.regulars.reduce((a, r) => a + r.points, 0);
    let plan, spice, builtCard;

    if (move.type === 'build') {
      builtCard = move.from === 'reserved' ? s.reserved[move.index].card : state.market[move.tier - 1][move.index];
      ({ plan, spice } = mirrorPay(s, builtCard));
    }
    const spiceBankBefore = state.bank[SPICE];
    const reservedBefore = s.reserved.length;

    const r = game.action(state, sid, move, room());
    assert(!r || !r.error, `${move.type} エラー: ${r && r.error}`);
    turnsTaken[seat]++;

    // --- 効果の検証 ---
    if (move.type === 'take3') { move.colors.length < 3 ? cov.take3short++ : cov.take3++; }
    else if (move.type === 'take2') cov.take2++;
    else if (move.type === 'reserve') {
      move.index === 'deck' ? cov.reserveDeck++ : cov.reserveMarket++;
      assert(s.reserved.length === reservedBefore + 1, '予約が増えていない');
      if (spiceBankBefore > 0) { assert(state.bank[SPICE] === spiceBankBefore - 1, '予約でスパイスが銀行から減っていない'); cov.reserveSpice++; }
    } else if (move.type === 'build') {
      move.from === 'market' ? cov.buildMarket++ : cov.buildReserved++;
      for (const ing of INGS) assert(s.tokens[ing] === snapTokens[ing] - plan[ing], `支払い（${ing}）が合わない`);
      assert(s.tokens[SPICE] === snapTokens[SPICE] - spice, 'スパイスの支払いが合わない');
      for (const ing of INGS) assert(state.bank[ing] === snapBank[ing] + plan[ing], `戻し（${ing}）が合わない`);
      assert(state.bank[SPICE] === snapBank[SPICE] + spice, 'スパイスの戻しが合わない');
      assert(s.bonus[builtCard.bonus] === snapBonus[builtCard.bonus] + 1, '割引が増えていない');
      // 作ると同時に常連さんが1人自動来店することがある。その分も足して突き合わせる
      const regDelta = s.regulars.reduce((a, r) => a + r.points, 0) - snapRegPts;
      assert(s.points === snapPts + builtCard.points + regDelta, '点数が合わない');
    }

    // 常連さんは条件を満たしたときだけ来店する
    for (const reg of state.seats[seat].regulars) {
      assert(Object.entries(reg.needs).every(([ing, nn]) => state.seats[seat].bonus[ing] >= nn), '条件未達の常連さんが来ている');
    }
    // 来店済みの常連さんが場から消えている（同じ人は二度来ない）
    const takenIds = new Set();
    for (const st of state.seats) for (const reg of st.regulars) { assert(!takenIds.has(reg.id), '同じ常連さんが二度来た'); takenIds.add(reg.id); }
    for (const reg of state.regulars) assert(!takenIds.has(reg.id), '来店済みの常連さんが場に残っている');

    if (state.last && state.last.type === 'regular') cov.regular++;
    checkInvariants(state, players, totalTokens, discarded);
  }

  assert(game.isOver(state), `${n}人: 終了しなかった（${steps} ステップ）`);

  // 勝者の検証：点数最大→作ったレシピ最少→同率は全員
  const active = state.seats.map((_, i) => i).filter(i => !state.left[i]);
  const maxPts = Math.max(...active.map(i => state.seats[i].points));
  const top = active.filter(i => state.seats[i].points === maxPts);
  const minBuilt = Math.min(...top.map(i => state.seats[i].built.length));
  const expect = top.filter(i => state.seats[i].built.length === minBuilt).sort((a, b) => a - b);
  assert(JSON.stringify(state.winners.slice().sort((a, b) => a - b)) === JSON.stringify(expect), '勝者の判定が違う');
  if (top.length > 1 && expect.length < top.length) cov.tieBuilt++;

  if (leftHappened && active.length <= 1) cov.overLeave++;
  else if (state.finalRound) {
    cov.overTarget++;
    // 15点到達後、その周の最後まで回る＝全員の番の数が同じ（退席がない場合）
    if (!leftHappened) {
      const mn = Math.min(...turnsTaken), mx = Math.max(...turnsTaken);
      assert(mx - mn === 0, `番の数がそろっていない: ${JSON.stringify(turnsTaken)}`);
    }
  } else cov.overRounds++;

  cov.games++;
}

console.log('喫茶店のレシピ帳 乱数テスト開始…');
const t0 = Date.now();
for (let n = 2; n <= 4; n++) {
  for (let i = 0; i < GAMES_PER_SIZE; i++) runOne(n);
  console.log(`  ${n}人 × ${GAMES_PER_SIZE} ゲーム OK`);
}
const ms = Date.now() - t0;
console.log('--- カバレッジ ---');
console.log(cov);
assert(cov.take3 && cov.take2, '材料取りの網羅不足');
assert(cov.reserveMarket && cov.reserveDeck && cov.reserveSpice, '予約の網羅不足');
assert(cov.buildMarket && cov.buildReserved, '作るの網羅不足');
assert(cov.discard, '10枚超の戻しが一度もない');
assert(cov.regular && cov.regularChoice, '常連さん来店の網羅不足');
assert(cov.errTurn && cov.errDup && cov.errTake2 && cov.errAfford && cov.errPending, '不正 action の網羅不足');
assert(cov.overTarget, '目標点での終了が一度もない');
assert(cov.tieBuilt, '同点→作ったレシピ数での決着が一度もない');
console.log(`\n✅ 全 ${cov.games} ゲーム 通過（${ms}ms）`);
