// =============================================================
//  共通タイマー表示（締め切りまでの残り秒数）
//   import { timerHTML } from '/lib/timer.js';
//   root.innerHTML = `... ${timerHTML(deadline, ctx)} ...`;
//  - deadline : 締め切りの時刻（ms・サーバー時計）。null なら何も出さない
//  - ctx      : { clockOffset } サーバーとの時計のずれ
//  表示は 0.25 秒ごとに自動更新する（この中の setInterval が DOM を走査する）。
//  残り10秒で赤く、残り5秒から毎秒 tick 音を鳴らす。
// =============================================================
import { play } from '/lib/sound.js';

// deadline 値 → 最後に表示した秒数（tick を1秒に1回だけ鳴らすため）
const lastSec = new Map();

function tickAll() {
  const els = document.querySelectorAll('.timer[data-deadline]');
  const alive = new Set();
  for (const el of els) {
    const deadline = Number(el.dataset.deadline);
    const offset = Number(el.dataset.offset) || 0;
    alive.add(deadline);
    const remain = Math.max(0, deadline - (Date.now() + offset));
    const secs = Math.ceil(remain / 1000);
    const numEl = el.querySelector('.timer-num');
    if (numEl) numEl.textContent = secs;
    el.classList.toggle('danger', remain <= 10000);
    const prev = lastSec.get(deadline);
    if (prev == null) lastSec.set(deadline, secs);
    else if (secs < prev) {
      lastSec.set(deadline, secs);
      if (secs >= 1 && secs <= 5) play('tick'); // 残り5秒から毎秒
    }
  }
  for (const k of [...lastSec.keys()]) if (!alive.has(k)) lastSec.delete(k); // 消えたタイマーは忘れる
}

if (typeof window !== 'undefined') setInterval(tickAll, 250);

export function timerHTML(deadline, ctx) {
  if (deadline == null) return '';
  const offset = ctx && typeof ctx.clockOffset === 'number' ? ctx.clockOffset : 0;
  const remain = Math.max(0, deadline - (Date.now() + offset));
  const secs = Math.ceil(remain / 1000);
  const danger = remain <= 10000;
  return `<div class="timer ${danger ? 'danger' : ''}" data-deadline="${deadline}" data-offset="${offset}" role="timer" aria-label="残り時間">
    <span class="timer-num">${secs}</span><span class="timer-unit">秒</span>
  </div>`;
}
