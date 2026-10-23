// =============================================================
//  観戦ビューの漏洩チェック（仕様 6-2）。各ゲームのランダムテストから使う。
//   - seesAll=false の spectatorView に含まれるカードは、全（生存）プレイヤーの
//     view に共通して含まれるカードだけであること
//   - seesAll=true の spectatorView には、生存している全員の手札が含まれること
//   - 脱落者（isOut=true）には、基盤が view ではなく spectatorView を使うこと
// =============================================================
const assert = require('assert');
const { viewFor } = require('../lib/viewFor');

// 任意の view 構造から、含まれるカードの集合（'r|s'）を集める
function collectCards(node, set = new Set()) {
  if (!node || typeof node !== 'object') return set;
  if (typeof node.r === 'string' && typeof node.s === 'string') set.add(node.r + '|' + node.s);
  if (Array.isArray(node)) {
    for (const x of node) collectCards(x, set);
  } else {
    for (const k of Object.keys(node)) collectCards(node[k], set);
  }
  return set;
}

// 生存プレイヤー全員の view に共通して含まれるカード（＝誰にも隠れていないカード）
function commonCards(game, state, aliveIds) {
  let common = null;
  for (const id of aliveIds) {
    const cards = collectCards(game.view(state, id));
    common = common === null ? cards : new Set([...common].filter(c => cards.has(c)));
  }
  return common || new Set();
}

// state のその瞬間について漏洩チェックする。
//   aliveIds : 生存しているプレイヤーの id
//   allHands : 生存プレイヤーの手札カードの集合（'r|s'）
function checkSpectatorLeak(game, state, aliveIds, allHands) {
  // seesAll=false：共通でないカードが混ざっていないこと
  const svCards = collectCards(game.spectatorView(state, { seesAll: false, viewerId: 'spec' }));
  const common = commonCards(game, state, aliveIds);
  for (const c of svCards) {
    assert(common.has(c), `漏洩: seesAll=false の観戦ビューに共通でないカード ${c}`);
  }
  // seesAll=true：生存者の手札が全部見えること
  const sv2Cards = collectCards(game.spectatorView(state, { seesAll: true, viewerId: 'spec' }));
  for (const c of allHands) {
    assert(sv2Cards.has(c), `seesAll=true の観戦ビューに手札 ${c} が含まれない`);
  }
}

// 脱落者には spectatorView、生存者には view が使われることを viewFor で確かめる
function checkViewForUsesSpectator(game, state, gamePlayerIds) {
  const room = {
    state,
    gamePlayerIds,
    phase: 'playing',
    settings: { spectatorSeesAll: false },
    members: gamePlayerIds.map(id => ({ id, role: 'player' })),
  };
  for (const id of gamePlayerIds) {
    const v = viewFor(game, room, id);
    if (game.isOut(state, id)) {
      assert(v && v.spectator === true, `脱落者 ${id} に view が使われている（spectatorView でない）`);
    } else {
      assert(!v || v.spectator !== true, `生存者 ${id} に spectatorView が使われている`);
    }
  }
}

module.exports = { collectCards, commonCards, checkSpectatorLeak, checkViewForUsesSpectator };
