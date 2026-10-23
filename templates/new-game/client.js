// 新しいゲームのひな形（画面側）
// サーバーから状態が届くたびに render() が呼ばれるので、毎回まるごと描き直せばOK
//
// root : 描画先の要素
// v    : server.js の view()（観戦者・脱落者には spectatorView()）が返したもの
// ctx  : { me: 自分のid, players, finished, isHost,
//          role: 'player'|'spectator'|'out', seesAll: 観戦者に手札を見せる設定,
//          esc(文字列エスケープ), toast(msg), sound(name), send(action) }
//
// 観戦者・脱落者（ctx.role !== 'player'）のときは、操作ボタンや手札の選択を出さず、
// 「あなたの番」系の文言は「○○さんの番」に置き換える。seesAll のときは
// 各席の下に cardHTML(c, { cls: 'sm' }) で全員の手札を並べる（view に入っていれば）。
// 「観戦（N人）」の一覧は基盤が描くので、各ゲームでの対応は不要。
//
// 共通部品（style.css）: .felt 卓 / .note メモ / .seats .seat .seat-chip 席 / .pcard トランプ / .hand 手札 / .log 記録
// トランプを描くなら: import { cardHTML, backHTML } from '/lib/cards.js';

export function render(root, v, ctx) {
  const isPlayer = ctx.role === 'player';
  const myTurn = isPlayer && !ctx.finished && v.currentId === ctx.me;

  root.innerHTML = `
    <div class="felt">
      <div class="note ${myTurn ? '' : 'plain'}">
        <small>${myTurn ? 'あなたの番' : '相手の番'}</small>
        <strong>${myTurn ? '操作してください' : '待っています…'}</strong>
      </div>
      <div style="text-align:center">
        <button class="btn primary" id="act" ${myTurn ? '' : 'disabled'}>ターン終了</button>
      </div>
    </div>`;

  root.querySelector('#act').onclick = () => ctx.send({ type: 'end' });
}
