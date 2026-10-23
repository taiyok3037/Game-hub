// =============================================================
//  観戦者・脱落者を含む「その人に見せる view」を決める共通ロジック。
//  server.js の broadcast から使う。テスト（漏洩テスト）からも直接呼べるように
//  独立したモジュールに切り出している。
//
//    viewFor(game, room, memberId) → その人の view（ロビー中は null）
//    roleOf (game, room, memberId) → 'player' | 'spectator' | 'out'
// =============================================================

// その人がゲームに参加していて、かつ脱落・上がり・退席しているか
function isOutMember(game, room, memberId) {
  return room.gamePlayerIds.includes(memberId)
    && typeof game.isOut === 'function'
    && game.isOut(room.state, memberId) === true;
}

function viewFor(game, room, memberId) {
  if (!room.state) return null; // ロビー中は view なし
  const inGame = room.gamePlayerIds.includes(memberId);
  // 参加者で、まだ脱落していない → 今までどおり本人視点
  if (inGame && !isOutMember(game, room, memberId)) {
    return game.view(room.state, memberId);
  }
  // 観戦者・脱落者 → spectatorView（なければ view(state, null) で代用）
  if (typeof game.spectatorView === 'function') {
    return game.spectatorView(room.state, {
      seesAll: !!(room.settings && room.settings.spectatorSeesAll),
      viewerId: memberId,
    });
  }
  return game.view(room.state, null);
}

function roleOf(game, room, memberId) {
  const member = room.members.find(m => m.id === memberId);
  if (!member) return 'spectator';
  if (room.phase === 'lobby') return member.role;           // ロビー中は本人の選択
  if (!room.gamePlayerIds.includes(memberId)) return 'spectator';
  return isOutMember(game, room, memberId) ? 'out' : 'player';
}

module.exports = { viewFor, roleOf, isOutMember };
