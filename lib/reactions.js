// =============================================================
//  クイックリアクション（定型文）の一覧。
//  サーバー（chat:react の検証）とクライアント（チップの表示）で同じものを使う。
//  サーバーは require でそのまま読み、ブラウザへは server.js が /lib/reactions.js を
//  ESM として配信する（public/lib には置かない）。
// =============================================================
const REACTIONS = {
  nice: 'ナイス！',
  hurry: 'はやく〜',
  think: 'うーん…',
  wow: 'すごい',
  sorry: 'ごめん',
  lol: 'ｗｗｗ',
  gg: 'おつかれ！',
  again: 'もう1回！',
};

// チップに並べる順番
const REACTION_ORDER = ['nice', 'hurry', 'think', 'wow', 'sorry', 'lol', 'gg', 'again'];

module.exports = { REACTIONS, REACTION_ORDER };
