// 新しいゲームのひな形（ルール側）
// 使い方: このフォルダを games/<ゲームID>/ にコピーし、id をフォルダ名と同じにする
// サーバーを再起動すれば、ホーム画面に自動で並びます

module.exports = {
  id: 'my-game',          // ← フォルダ名と同じにする
  name: 'マイゲーム',
  description: 'ホーム画面に出る説明文',
  category: 'その他',      // 'ボード' 'トランプ' など自由
  cover: { color: '#8a5a34', mark: '?', markColor: '#3a2414' }, // ホーム画面の箱の見た目
  minPlayers: 2,
  maxPlayers: 4,

  // ① 開始時の状態を作る。players = [{ id, name }, ...]
  setup(players) {
    return {
      players,
      turn: 0,
      over: false,
    };
  },

  // ② 誰かが操作したときの処理。state を書き換える
  //    ルール違反なら { error: 'メッセージ' } を返すと、その人だけに表示される
  action(state, playerId, action) {
    const seat = state.players.findIndex(p => p.id === playerId);
    if (seat !== state.turn) return { error: 'あなたの番ではありません' };
    // if (action.type === 'xxx') { ... }
    state.turn = (state.turn + 1) % state.players.length;
  },

  // ③ その人の画面に送る情報。隠したい情報（他人の手札など）はここで外す
  view(state, playerId) {
    return {
      players: state.players,
      currentId: state.players[state.turn].id,
    };
  },

  // ④ 終わったら true
  isOver(state) {
    return state.over;
  },

  // ⑤（任意）ゲーム中に誰かが抜けたとき。書かなければロビーに戻る
  // onLeave(state, playerId) {},
};
