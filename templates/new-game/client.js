// 新しいゲームのひな形（画面側）
// サーバーから状態が届くたびに render() が呼ばれるので、毎回まるごと描き直せばOK
//
// root : 描画先の要素
// v    : server.js の view() が返したもの
// ctx  : { me: 自分のid, players, finished, esc(文字列エスケープ), toast(msg), send(action) }
//
// 共通部品（style.css）: .felt 卓 / .note メモ / .seats .seat .seat-chip 席 / .pcard トランプ / .hand 手札 / .log 記録
// トランプを描くなら: import { cardHTML, backHTML } from '/lib/cards.js';

export function render(root, v, ctx) {
  const myTurn = !ctx.finished && v.currentId === ctx.me;

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
