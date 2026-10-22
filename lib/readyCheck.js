// =============================================================
//  準備OK（全員がそろったら次へ）の共通ロジック
//  きゅうり・インディアンポーカーなど「result/reveal で全員の準備を待つ」
//  ゲームで共有する。席番号ベースで、state に次の2つがある前提：
//    state.ready        : number[]  準備OKを押した席番号
//    state.connectedIds : string[]  接続中のプレイヤーID（needFn が使う）
//
//  使い方:
//    const readyCheck = require('../../lib/readyCheck');
//    const ready = readyCheck(state => 準備OKが必要な席番号の配列);
//    ready.toggle(state, seat, on);  ready.isAllReady(state);  ...
// =============================================================
module.exports = function readyCheck(needFn) {
  return {
    // 接続状況を state に取り込む（view で needIds を出すために保持する）
    syncConn(state, room) {
      if (room && Array.isArray(room.connectedIds)) state.connectedIds = room.connectedIds.slice();
    },
    // 準備OKが必要な席番号
    need(state) {
      return needFn(state);
    },
    // view 用：必要な人のID
    needIds(state) {
      return needFn(state).map(s => state.players[s].id);
    },
    // view 用：準備OKを押した人のID
    readyIds(state) {
      return (state.ready || []).map(s => state.players[s].id);
    },
    // 準備OKの付け外し（脱落者が押しても害はない。数には needFn 側で入らない）
    toggle(state, seat, on) {
      if (!Array.isArray(state.ready)) state.ready = [];
      if (on !== false) {
        if (!state.ready.includes(seat)) state.ready.push(seat);
      } else {
        state.ready = state.ready.filter(s => s !== seat);
      }
    },
    // 必要な人が全員そろったか
    isAllReady(state) {
      const need = needFn(state);
      return need.length > 0 && need.every(s => (state.ready || []).includes(s));
    },
    // リセット
    reset(state) {
      state.ready = [];
    },
  };
};
