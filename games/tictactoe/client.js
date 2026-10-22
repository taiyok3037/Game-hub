// 三目並べの画面。サーバーから届いた view を描画し、操作は ctx.send() で送るだけ

// ルール（基盤がルールパネル／ボトムシートに表示する）
export const rules = `<ul>
  <li>先手が ○、後手が × です</li>
  <li>自分の番に、空いているマスを1つ選んで印を置きます</li>
  <li>縦・横・斜めのどこかに同じ印を3つ並べたら勝ち</li>
  <li>すべて埋まっても並ばなければ引き分け</li>
</ul>`;

export function render(root, v, ctx) {
  const { esc } = ctx;
  const winner = v.players.find(p => p.id === v.winner);
  const current = v.players.find(p => p.id === v.currentId);
  const myTurn = !ctx.finished && v.currentId === ctx.me;

  let small, big;
  if (winner) {
    small = '決着';
    big = winner.id === ctx.me ? 'あなたの勝ち！' : `${esc(winner.name)} さんの勝ち`;
  } else if (v.draw) {
    small = '決着';
    big = '引き分け';
  } else {
    small = myTurn ? 'あなたの番' : '相手の番';
    big = myTurn ? '置く場所を選んでね' : `${esc(current.name)} さんが考え中…`;
  }

  root.innerHTML = `
    <div class="g-layout">
      <div class="g-main">
        <div class="felt">
          <div class="seats">
            ${v.players.map(p => `
              <div class="seat ${p.id === v.currentId && !ctx.finished ? 'turn' : ''}">
                <span class="seat-chip">${p.mark} ${esc(p.name)}</span>
                <span class="seat-info">${p.id === ctx.me ? 'あなた' : ''}</span>
              </div>`).join('')}
          </div>
          <div class="note ${myTurn ? '' : 'plain'}"><small>${small}</small><strong>${big}</strong></div>
          <div class="ttt-board">
            ${v.board.map((c, i) => `
              <button class="ttt-cell ${v.line && v.line.includes(i) ? 'win' : ''} ${c === 1 ? 'x' : ''}"
                data-i="${i}" aria-label="${i + 1}番のマス" ${c !== null || !myTurn ? 'disabled' : ''}>
                ${c === null ? '' : v.players[c].mark}
              </button>`).join('')}
          </div>
        </div>
      </div>
    </div>`;

  root.querySelector('.ttt-board').onclick = e => {
    const cell = e.target.closest('.ttt-cell');
    if (cell && !cell.disabled) ctx.send({ type: 'place', index: Number(cell.dataset.i) });
  };
}
