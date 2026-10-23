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

  // ⑤（任意）脱落・上がり・退席した人なら true。基盤はこの人を観戦者と同じ扱いにする
  // isOut(state, playerId) {
  //   const seat = state.players.findIndex(p => p.id === playerId);
  //   if (seat === -1) return true;        // 退席して席がなくなった
  //   return !!state.out[seat];            // 脱落・上がり
  // },

  // ⑥（隠し情報があるゲームでは必須）観戦者・脱落者に見せる view。
  //    seesAll=false（既定）：プレイヤー全員に見えている情報だけを返す（手札などは外す）
  //    seesAll=true       ：全員の手札の中身まで見せる
  //    viewerId           ：脱落者なら本人の id（自分の席の強調用）、観戦者なら観戦者の id
  // spectatorView(state, { seesAll, viewerId }) {
  //   const v = this.view(state, null); // null 視点＝自分の手札が付かない公開ビュー
  //   if (seesAll) {
  //     v.players = v.players.map((p, i) => ({ ...p, hand: state.hands[i] }));
  //   }
  //   return v;
  // },

  // ⑦（任意）ゲーム中に誰かが抜けたとき。書かなければロビーに戻る
  // onLeave(state, playerId) {},
};
