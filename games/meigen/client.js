// 迷言メーカーの画面
import { timerHTML } from '/lib/timer.js';

// ルール（基盤がルールパネル／ボトムシートに表示する）
export const rules = `<ul>
  <li>毎ラウンド1人が「親」。親以外は手札の単語カードを並べて、お題に合うフレーズを作ります</li>
  <li>「の」「が」などの<strong>つなぎ言葉チップは何回でも使えます</strong>（手札ではありません）</li>
  <li>フレーズはカードを1枚以上・全部で10個まで。先頭の「〜」は表示で消えます</li>
  <li><strong>親は誰が作ったか分からない</strong>状態で、一番気に入ったフレーズを1つ選びます</li>
  <li>選ばれた人に +1点。先に目標点に達した人の勝ちです</li>
  <li>共通カードはラウンドをまたいで持ち越し、使うと補充されます</li>
</ul>`;

// テーマ単語の先頭の「〜」は表示のとき取り除く
const stripTilde = s => String(s == null ? '' : s).replace(/^〜/, '');

// ---- 作成中のローカル状態（サーバー更新をまたいで保持する） ----
let last = null;         // { root, v, ctx }
let composer = null;     // 作成中のトークン配列（token[]）
let composerKey = null;  // round|phase（変わったら作り直す）
let judgePick = null;    // 親が仮選択した pos
let judgeKey = null;
let draftTimer = null;
let localPaint = false;  // ローカル再描画か（効果音を鳴らさない）

function rerender() { if (last) { localPaint = true; render(last.root, last.v, last.ctx); } }

function scheduleDraft(ctx) {
  clearTimeout(draftTimer);
  draftTimer = setTimeout(() => { if (composer) ctx.send({ type: 'draft', tokens: composer }); }, 500);
}

export function render(root, v, ctx) {
  last = { root, v, ctx };
  const fromLocal = localPaint; localPaint = false;
  if (!fromLocal) playSound(v, ctx);

  const { esc } = ctx;
  const isPlayer = ctx.role === 'player';
  const me = v.players.find(p => p.id === ctx.me) || null;
  const isParent = isPlayer && v.parentId === ctx.me;
  const name = id => esc((v.players.find(p => p.id === id) || {}).name || '?');

  // ---- 作成中トークンの準備 ----
  const amComposing = isPlayer && !isParent && v.phase === 'compose' && me && !me.submitted;
  const key = `${v.round}|${v.phase}`;
  if (amComposing) {
    if (composerKey !== key) { composer = (v.myDraft || []).slice(); composerKey = key; }
  } else {
    composer = null; composerKey = null;
  }
  // 親の仮選択の準備
  if (!(isParent && v.phase === 'judge')) { judgePick = null; judgeKey = null; }
  else if (judgeKey !== key) { judgePick = null; judgeKey = key; }

  // カード id → 文字列（プレビュー・トークン表示用）
  const cardText = new Map([...(v.myHand || []), ...(v.myThemeHand || [])].map(c => [c.id, c.text]));
  const tokenText = tk => tk.t === 'chip' ? tk.text : (cardText.get(tk.id) || '');
  const previewOf = toks => toks.map(tk => stripTilde(tokenText(tk))).join('');

  // ---- お題カード ----
  const children = v.players.filter(p => !p.parent && !p.left).length;
  const submitted = v.players.filter(p => p.submitted).length;
  let promptCard;
  if (v.phase === 'theme') {
    promptCard = `
      <div class="mg-prompt-card paper">
        <div class="mg-prompt-theme">テーマを選んでいます</div>
        <div class="mg-prompt-text">？？？</div>
      </div>`;
  } else {
    promptCard = `
      <div class="mg-prompt-card paper">
        <div class="mg-prompt-theme">${esc((v.theme || {}).name || '')}</div>
        <div class="mg-prompt-text">${esc(v.prompt || '')}</div>
        <div class="mg-prompt-inst">${esc((v.theme || {}).instruction || '')}</div>
      </div>`;
  }

  // ---- 席 ----
  const seats = v.players.map(p => {
    const cls = [p.parent ? 'mg-seat-parent' : '', p.left ? 'done' : '', p.id === ctx.me ? 'me' : ''].join(' ');
    let badge = '';
    if (p.parent) badge = '<span class="mg-badge parent">親</span>';
    else if (v.phase === 'compose' && p.submitted) badge = '<span class="mg-badge ok">✓</span>';
    const peek = (p.hand || p.themeHand)
      ? `<div class="mg-peek">${(p.themeHand || []).map(c => `<span class="mg-word mg-theme sm">${esc(c.text)}</span>`).join('')}${(p.hand || []).map(c => `<span class="mg-word mg-common sm">${esc(c.text)}</span>`).join('')}</div>`
      : '';
    return `
      <div class="seat mg-seat ${cls}" data-member-id="${p.id}">
        <span class="seat-chip">${esc(p.name)}</span>
        <span class="mg-seat-score">${p.left ? '退席' : `${p.score}点`}</span>
        ${badge}
        ${peek}
      </div>`;
  }).join('');

  // ---- 卓のメモ ----
  let small, big;
  if (v.phase === 'over') {
    small = '決着';
    big = v.winnerId === ctx.me ? 'あなたの勝ち！' : `${name(v.winnerId)} さんの勝ち！`;
  } else if (v.phase === 'theme') {
    small = `第${v.round}ラウンド`;
    big = isParent ? 'テーマを選んでください' : `${name(v.parentId)} さんがテーマを選んでいます`;
  } else if (v.phase === 'compose') {
    small = `第${v.round}ラウンド・提出 ${submitted}/${children}`;
    big = isParent ? 'みんなが考えています' : (me && me.submitted ? 'みんなを待っています' : 'フレーズを作ろう');
  } else if (v.phase === 'judge') {
    small = '選考中';
    big = isParent ? '一番の迷言を選んで！' : `${name(v.parentId)} さんが選んでいます…`;
  } else { // result
    if (v.flow) { small = `第${v.round}ラウンド`; big = 'このラウンドは流れました'; }
    else { small = '発表'; big = v.pickId === ctx.me ? 'あなたの迷言が選ばれた！' : `${name(v.pickId)} さんの迷言が選ばれた！`; }
  }

  // ---- フェーズごとの中身 ----
  let center = '';
  if (v.phase === 'theme' && isParent) {
    center = `<div class="mg-theme-choices">${(v.themeChoices || []).map(t => `
      <button class="btn primary mg-theme-btn" data-theme="${esc(t.id)}">
        <span class="mg-theme-btn-name">${esc(t.name)}</span>
        <span class="mg-theme-btn-inst">${esc(t.instruction)}</span>
      </button>`).join('')}</div>`;
  } else if (v.phase === 'compose' && amComposing) {
    center = composeUI(v, ctx, { composer, previewOf, tokenText });
  } else if (v.phase === 'compose' && isPlayer && !isParent && me && me.submitted) {
    center = `
      <div class="mg-waiting paper">
        <p>提出しました（みんなを待っています ${submitted}/${children}）</p>
        <button class="btn ghost mg-unsubmit">取り消す</button>
      </div>`;
  } else if (v.phase === 'judge') {
    center = judgeUI(v, ctx, { isParent });
  } else if (v.phase === 'result' || v.phase === 'over') {
    center = resultUI(v, ctx, { name, isPlayer });
  }

  // ---- 右側（得点・履歴・記録） ----
  const side = `
    <div class="g-side">
      ${scoreTable(v, ctx, esc)}
      ${picksHistory(v, esc)}
      <ul class="log">${v.log.slice().reverse().slice(0, 10).map(l => `<li>${esc(l)}</li>`).join('')}</ul>
    </div>`;

  root.innerHTML = `
    <div class="g-layout">
      <div class="g-main">
        <div class="felt">
          <div class="mg-top">
            ${promptCard}
            ${ctx.deadline != null ? `<div class="mg-timer">${timerHTML(ctx.deadline, ctx)}</div>` : ''}
          </div>
          <div class="seats mg-seats">${seats}</div>
          <div class="note ${(isParent && v.phase === 'theme') || amComposing || (isParent && v.phase === 'judge') ? '' : 'plain'}">
            <small>${small}</small><strong>${big}</strong>
          </div>
          ${center}
        </div>
      </div>
      ${side}
    </div>`;

  wireEvents(root, v, ctx, { composer, previewOf, tokenText });
}

// ---------- 作成UI（子） ----------
function composeUI(v, ctx, { composer, previewOf, tokenText }) {
  const { esc } = ctx;
  const usedIds = new Set(composer.filter(t => t.t === 'card').map(t => t.id));
  const strip = composer.length
    ? composer.map((tk, i) => `
        <span class="mg-token ${tk.t}">
          <button class="mg-move" data-move="${i}" data-dir="-1" ${i === 0 ? 'disabled' : ''} aria-label="左へ">‹</button>
          <button class="mg-token-body" data-remove="${i}" aria-label="外す">${esc(stripTilde(tokenText(tk)))}</button>
          <button class="mg-move" data-move="${i}" data-dir="1" ${i === composer.length - 1 ? 'disabled' : ''} aria-label="右へ">›</button>
        </span>`).join('')
    : '<span class="mg-strip-empty">カードやチップをタップして並べよう</span>';
  const valid = composer.length >= 1 && composer.length <= 10 && composer.some(t => t.t === 'card');
  const preview = previewOf(composer);

  const themeCards = (v.myThemeHand || []).map(c =>
    `<button class="mg-word mg-theme ${usedIds.has(c.id) ? 'used' : ''}" data-add-card="${c.id}">${esc(c.text)}</button>`).join('');
  const commonCards = (v.myHand || []).map(c =>
    `<button class="mg-word mg-common ${usedIds.has(c.id) ? 'used' : ''}" data-add-card="${c.id}">${esc(c.text)}</button>`).join('');
  const chips = (v.connectors || []).map(t =>
    `<button class="mg-chip" data-add-chip="${esc(t)}">${esc(t)}</button>`).join('');

  return `
    <div class="mg-compose">
      <div class="mg-strip-wrap paper">
        <div class="mg-strip">${strip}</div>
        <div class="mg-preview">${preview ? esc(preview) : '<span class="mg-preview-ph">プレビュー</span>'}</div>
        <div class="mg-compose-btns">
          <button class="btn primary mg-submit" ${valid ? '' : 'disabled'}>提出する</button>
          <button class="btn ghost small mg-clear" ${composer.length ? '' : 'disabled'}>全部外す</button>
        </div>
      </div>
      <div class="mg-cards">
        <div class="mg-cards-head">お題のカード</div>
        <div class="mg-word-grid">${themeCards || '<span class="muted">なし</span>'}</div>
        <div class="mg-cards-head">手札</div>
        <div class="mg-word-grid">${commonCards}</div>
        <div class="mg-cards-head">つなぎ言葉（何回でも使える）</div>
        <div class="mg-chips">${chips}</div>
      </div>
    </div>`;
}

// ---------- 選考UI ----------
function judgeUI(v, ctx, { isParent }) {
  const { esc } = ctx;
  const items = (v.phrases || []).map(ph => `
    <li class="mg-phrase ${isParent && judgePick === ph.pos ? 'picked' : ''} ${ph.mine ? 'mine' : ''}"
        ${isParent ? `data-pick="${ph.pos}"` : ''}>
      <span class="mg-phrase-text">${esc(ph.text)}</span>
      ${ph.mine ? '<span class="mg-phrase-you">あなた</span>' : ''}
    </li>`).join('');
  const canConfirm = isParent && judgePick != null;
  return `
    <div class="mg-judge">
      <ul class="mg-phrases">${items}</ul>
      ${isParent ? `<button class="btn primary big mg-confirm" ${canConfirm ? '' : 'disabled'}>これに決めた！</button>` : ''}
      ${!isParent && ctx.isHost ? forcePickBtn(v, ctx) : ''}
    </div>`;
}

// 親が切断中のとき、ホストに「代わりに選ぶ」ボタン
function forcePickBtn(v, ctx) {
  const parent = (ctx.players || []).find(m => m.id === v.parentId);
  if (parent && parent.connected) return '';
  return '<button class="btn ghost small mg-forcepick">親が不在：代わりにランダムで選ぶ</button>';
}

// ---------- 発表・決着UI ----------
function resultUI(v, ctx, { name, isPlayer }) {
  const { esc } = ctx;
  if (v.flow) {
    return `<div class="mg-result paper">
      <p class="center">提出がなかったので、このラウンドは流れました。</p>
      ${v.phase === 'result' ? readyPanel(v, ctx, name) : ''}
    </div>`;
  }
  const list = (v.results || []).map(r => `
    <li class="mg-result-row ${r.picked ? 'picked' : ''}">
      <span class="mg-result-text">${esc(r.text)}</span>
      <span class="mg-result-author">${esc(r.authorName)}${r.picked ? '　+1点' : ''}</span>
    </li>`).join('');
  const winBanner = v.phase === 'over'
    ? `<div class="mg-winner">🏆 ${v.winnerId === ctx.me ? 'あなた' : name(v.winnerId)} さんの勝ち！</div>`
    : '';
  return `
    <div class="mg-result paper">
      ${winBanner}
      <ul class="mg-result-list">${list}</ul>
      ${v.phase === 'result' ? readyPanel(v, ctx, name) : ''}
    </div>`;
}

// 準備OKパネル（きゅうりと同じ考え方）
function readyPanel(v, ctx, name) {
  const need = v.needIds || [];
  const ready = v.readyIds || [];
  const readyCount = need.filter(id => ready.includes(id)).length;
  const iPressed = ready.includes(ctx.me);
  const isPlayer = ctx.role === 'player';
  const list = need.map(id =>
    `<li class="${ready.includes(id) ? 'ok' : ''}">${ready.includes(id) ? '✓' : '待ち'} ${name(id)}</li>`).join('');
  return `
    <div class="mg-ready">
      <div class="mg-ready-head">次のラウンドへ　準備OK ${readyCount} / ${need.length}</div>
      <ul class="mg-ready-list">${list}</ul>
      ${isPlayer ? `<button class="btn ${iPressed ? '' : 'primary'} mg-next ${iPressed ? '' : 'pulse'}">${iPressed ? '取り消す' : '準備OK'}</button>` : ''}
    </div>`;
}

// ---------- 右側パーツ ----------
function scoreTable(v, ctx, esc) {
  const rows = v.players.slice().sort((a, b) => (a.left - b.left) || (b.score - a.score));
  return `
    <div class="mg-scores">
      <h3>得点（目標 ${v.target}点）</h3>
      ${rows.map(p => `
        <div class="mg-score-row ${p.left ? 'out' : ''} ${p.id === ctx.me ? 'me' : ''}">
          <span class="mg-score-name">${esc(p.name)}${p.parent ? '<span class="mg-dealer">親</span>' : ''}</span>
          <span class="mg-score-bar" aria-hidden="true"><span style="width:${Math.min(100, (p.score / v.target) * 100)}%"></span></span>
          <span class="mg-score-num">${p.left ? '退席' : `${p.score}点`}</span>
        </div>`).join('')}
    </div>`;
}

function picksHistory(v, esc) {
  if (!v.picks || !v.picks.length) return '';
  return `
    <div class="mg-picks">
      <h3>選ばれた迷言</h3>
      <ul>${v.picks.slice().reverse().slice(0, 12).map(pk => `
        <li>
          <span class="mg-pick-text">${esc(pk.text)}</span>
          <span class="mg-pick-meta">R${pk.round}・${esc(pk.prompt)}／${esc(pk.authorName)}</span>
        </li>`).join('')}</ul>
    </div>`;
}

// ---------- イベント配線 ----------
function wireEvents(root, v, ctx, { previewOf }) {
  // テーマ選択（親）
  root.querySelectorAll('.mg-theme-btn').forEach(b => {
    b.onclick = () => { b.disabled = true; ctx.send({ type: 'chooseTheme', themeId: b.dataset.theme }); };
  });

  // 作成（子）
  const compose = root.querySelector('.mg-compose');
  if (compose && composer) {
    const change = () => { scheduleDraft(ctx); rerender(); };
    compose.querySelectorAll('[data-add-card]').forEach(b => {
      b.onclick = () => {
        const id = Number(b.dataset.addCard);
        if (composer.length >= 10) return ctx.toast('トークンは10個までです');
        if (composer.some(t => t.t === 'card' && t.id === id)) return; // 同じカードは1回だけ
        composer.push({ t: 'card', id });
        ctx.sound('card'); change();
      };
    });
    compose.querySelectorAll('[data-add-chip]').forEach(b => {
      b.onclick = () => {
        if (composer.length >= 10) return ctx.toast('トークンは10個までです');
        composer.push({ t: 'chip', text: b.dataset.addChip });
        ctx.sound('card'); change();
      };
    });
    compose.querySelectorAll('[data-remove]').forEach(b => {
      b.onclick = () => { composer.splice(Number(b.dataset.remove), 1); change(); };
    });
    compose.querySelectorAll('[data-move]').forEach(b => {
      b.onclick = () => {
        const i = Number(b.dataset.move), d = Number(b.dataset.dir), j = i + d;
        if (j < 0 || j >= composer.length) return;
        [composer[i], composer[j]] = [composer[j], composer[i]];
        change();
      };
    });
    const submit = compose.querySelector('.mg-submit');
    if (submit) submit.onclick = () => { submit.disabled = true; ctx.send({ type: 'submit', tokens: composer }); };
    const clear = compose.querySelector('.mg-clear');
    if (clear) clear.onclick = () => { composer = []; last.v.myDraft = []; scheduleDraft(ctx); rerender(); };
  }

  const unsub = root.querySelector('.mg-unsubmit');
  if (unsub) unsub.onclick = () => { unsub.disabled = true; ctx.send({ type: 'unsubmit' }); };

  // 選考（親）
  root.querySelectorAll('[data-pick]').forEach(li => {
    li.onclick = () => { judgePick = Number(li.dataset.pick); rerender(); };
  });
  const confirm = root.querySelector('.mg-confirm');
  if (confirm) confirm.onclick = () => {
    if (judgePick == null) return;
    confirm.disabled = true;
    ctx.send({ type: 'pick', index: judgePick });
  };
  const force = root.querySelector('.mg-forcepick');
  if (force) force.onclick = () => { force.disabled = true; ctx.send({ type: 'forcePick' }); };

  // 準備OK
  const next = root.querySelector('.mg-next');
  if (next) next.onclick = () => { next.disabled = true; ctx.send({ type: 'next', on: !(v.readyIds || []).includes(ctx.me) }); };
}

// ---------- 効果音 ----------
function playSound(v, ctx) {
  const p = ctx.prev;
  if (!p) return;
  let snd = null;
  const subCount = x => (x.players || []).filter(pl => pl.submitted).length;
  if (p.phase !== 'over' && v.phase === 'over') snd = 'win';
  else if (v.phase === 'result' && p.phase !== 'result' && !v.flow && v.pickId) snd = (v.pickId === ctx.me ? 'win' : 'trick');
  else if (v.phase === 'judge' && p.phase !== 'judge') snd = 'flip';
  else if (subCount(v) > subCount(p)) snd = 'ready';
  if (snd) ctx.sound(snd);
}
