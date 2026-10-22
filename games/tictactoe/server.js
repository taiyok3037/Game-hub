// 三目並べ（ボードゲームの例：全員に同じ盤面が見える）
const LINES = [
  [0, 1, 2], [3, 4, 5], [6, 7, 8],
  [0, 3, 6], [1, 4, 7], [2, 5, 8],
  [0, 4, 8], [2, 4, 6],
];

module.exports = {
  id: 'tictactoe',
  name: '三目並べ',
  description: '縦・横・斜めに3つ並べたら勝ち',
  category: 'ボード',
  cover: { color: '#3d5a8c', mark: '○', markColor: '#3a2414' },
  minPlayers: 2,
  maxPlayers: 2,

  // ゲーム開始時の状態を作る
  setup(players) {
    const order = Math.random() < 0.5 ? players : [...players].reverse(); // 先手はランダム
    return {
      players: order,              // [先手(○), 後手(×)]
      board: Array(9).fill(null),  // null | 0 | 1（何番目のプレイヤーの石か）
      turn: 0,
      winner: null,                // 勝者のplayerId
      line: null,
      draw: false,
    };
  },

  // プレイヤーの操作。ルール違反なら { error } を返す
  action(state, playerId, action) {
    const seat = state.players.findIndex(p => p.id === playerId);
    if (seat === -1) return { error: 'このゲームの参加者ではありません' };
    if (seat !== state.turn) return { error: 'あなたの番ではありません' };
    if (action.type !== 'place') return { error: '不明な操作です' };
    const i = action.index;
    if (!Number.isInteger(i) || i < 0 || i > 8 || state.board[i] !== null) return { error: 'そこには置けません' };

    state.board[i] = seat;
    const line = LINES.find(l => l.every(c => state.board[c] === seat));
    if (line) {
      state.winner = playerId;
      state.line = line;
    } else if (state.board.every(c => c !== null)) {
      state.draw = true;
    } else {
      state.turn = 1 - seat;
    }
  },

  // 各プレイヤーに見せる情報（三目並べは隠す情報がないので全員同じ）
  view(state, playerId) {
    return {
      board: state.board,
      players: state.players.map((p, i) => ({ ...p, mark: i === 0 ? '○' : '×' })),
      currentId: state.players[state.turn].id,
      mySeat: state.players.findIndex(p => p.id === playerId),
      winner: state.winner,
      line: state.line,
      draw: state.draw,
    };
  },

  isOver(state) {
    return state.winner !== null || state.draw;
  },

  // 途中で抜けたら相手の勝ち
  onLeave(state, playerId) {
    if (this.isOver(state)) return;
    const other = state.players.find(p => p.id !== playerId);
    state.winner = other.id;
  },
};
