// =============================================================
//  共通の画面制御（ホーム → ロビー → ゲーム）
//  ゲームごとの画面は /games/<id>/client.js の render() に任せる
// =============================================================
import { play as soundPlay, setMuted, isMuted } from '/lib/sound.js';

const socket = io();
const $ = s => document.querySelector(s);
const SESSION_KEY = 'gamehub-session';
const NAME_KEY = 'gamehub-name';

let games = [];
let room = null;
let currentScreen = 'home';
let sideRulesGame = null; // ルールタブに今入っているゲームid
const modules = {}; // 読み込んだゲーム画面モジュールのキャッシュ

// 前回描画した view（ctx.prev 用）。room.code か gameId が変わる・ロビーに戻る・再接続で null に戻す
let lastView = null;
let lastViewKey = null;
function resetPrev() { lastView = null; lastViewKey = null; }

// ---------- 手番の演出（A-3） ----------
const BASE_TITLE = document.title;
let lastYourTurn = false;
let bannerTimer;

function showTurnBanner() {
  const b = $('#turn-banner');
  if (!b) return;
  b.hidden = false;
  b.classList.remove('show');
  void b.offsetWidth; // アニメーションを毎回やり直す
  b.classList.add('show');
  clearTimeout(bannerTimer);
  bannerTimer = setTimeout(() => { b.hidden = true; b.classList.remove('show'); }, 1250);
}

// yourTurn の変化に合わせて、バナー・音・金枠・タブタイトルを更新する
function applyTurnFx(yourTurn) {
  if (yourTurn && !lastYourTurn) {
    sound('turn');
    showTurnBanner();
    navigator.vibrate?.(60);
  }
  $('#screen-game').classList.toggle('my-turn', yourTurn);
  if (yourTurn) document.title = '● あなたの番｜ゲームハブ';
  else if (lastYourTurn) document.title = BASE_TITLE;
  lastYourTurn = yourTurn;
}

// ゲームから離れるとき演出を消す
function clearTurnFx() {
  $('#screen-game').classList.remove('my-turn');
  if (lastYourTurn) document.title = BASE_TITLE;
  lastYourTurn = false;
  const b = $('#turn-banner');
  if (b) { b.hidden = true; b.classList.remove('show'); }
}

const esc = s => String(s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const call = (event, data = {}) => new Promise(res => socket.emit(event, data, res));

// 効果音。ctx.sound(name) から呼ぶ
const sound = name => soundPlay(name);

// ---------- チャット（ロビー・ゲーム共通で1つ） ----------
// チャットは遅延読み込みする。万一読み込みに失敗しても、ホーム・ロビー・ゲームが
// 止まらないよう、最初は何もしないダミーを入れておき、読み込めたら差し替える。
function stubChat() {
  const el = document.createElement('div');
  return {
    el,
    setSelf() {}, setHistory() {}, addMessage() {}, setVisible() {},
    setComposeChannel() {}, setOnUnread() {}, get unread() { return 0; },
  };
}
let chat = stubChat();
socket.on('chat:history', list => chat.setHistory(list));
socket.on('chat:message', m => {
  chat.addMessage(m);
  if (m.kind === 'reaction') showReaction(m);
});

import('/chat.js').then(mod => {
  chat = mod.createChat({ socket, sound, toast });
  chat.setOnUnread(n => {
    for (const id of ['#chat-badge', '#tab-chat-badge']) {
      const b = $(id);
      if (!b) continue;
      b.textContent = n > 99 ? '99+' : String(n);
      b.hidden = n === 0;
    }
  });
  // すでに部屋にいるなら、今の画面を描き直してチャットを差し込む
  if (room) { if (room.phase === 'lobby') renderLobby(room); else renderGame(room); }
}).catch(e => console.error('チャットの読み込みに失敗しました（チャット以外は動作します）', e));

// いまチャットを送ると届くチャンネル（観戦席かどうか）を入力欄に反映する
function chatComposeChannel(r) {
  return (r.phase === 'playing' && r.settings && r.settings.spectatorSeesAll && r.yourRole !== 'player')
    ? 'spectators' : 'all';
}
// リアクションを、送った人の席の上に吹き出しで2秒出す。
// 席（[data-member-id]）が見つからない（ロビー・席を描かないゲーム）ときは上部トースト。
function showReaction(m) {
  const seat = (currentScreen === 'game' && m.fromId)
    ? $(`#game-root [data-member-id="${m.fromId}"]`)
    : null;
  if (!seat) {
    toast(`${m.fromName || '観戦者'}：${m.text}`);
    return;
  }
  const bubble = document.createElement('div');
  bubble.className = 'reaction-bubble';
  bubble.textContent = m.text;
  document.body.appendChild(bubble);
  const rect = seat.getBoundingClientRect();
  bubble.style.left = `${rect.left + rect.width / 2 - bubble.offsetWidth / 2}px`;
  bubble.style.top = `${rect.top - bubble.offsetHeight - 6}px`;
  setTimeout(() => bubble.remove(), 2000);
}

// ---------- チャット／ルールのタブとボトムシート ----------
const mqMobile = window.matchMedia('(max-width: 767px)');
const isMobile = () => mqMobile.matches;
let activeTab = 'chat';   // 'chat' | 'rules'（右列・シート共通）
let sheetOpen = false;

// ゲーム画面でチャットをどこに置くか（スマホでシートが開いていればシートへ）
function mountChatForGame() {
  const target = (isMobile() && sheetOpen) ? $('#sheet-chat') : $('#side-chat');
  if (chat.el.parentElement !== target) target.appendChild(chat.el);
}

// チャットが「見えている」か（未読カウント用）
function updateChatVisible() {
  let vis;
  if (currentScreen === 'lobby') vis = true;
  else if (currentScreen === 'game') vis = isMobile() ? (sheetOpen && activeTab === 'chat') : (activeTab === 'chat');
  else vis = false;
  chat.setVisible(vis && !document.hidden);
}

function setTab(tab) {
  activeTab = tab;
  for (const [btn, panel, t] of [
    ['#tab-chat', '#side-chat', 'chat'], ['#tab-rules', '#side-rules', 'rules'],
    ['#sheet-tab-chat', '#sheet-chat', 'chat'], ['#sheet-tab-rules', '#sheet-rules', 'rules'],
  ]) {
    const b = $(btn), p = $(panel);
    if (b) { b.classList.toggle('on', t === tab); b.setAttribute('aria-selected', String(t === tab)); }
    if (p) p.hidden = t !== tab;
  }
  mountChatForGame();
  updateChatVisible();
}
$('#tab-chat').onclick = () => setTab('chat');
$('#tab-rules').onclick = () => setTab('rules');
$('#sheet-tab-chat').onclick = () => setTab('chat');
$('#sheet-tab-rules').onclick = () => setTab('rules');

function openSheet() {
  sheetOpen = true;
  mountChatForGame();
  $('#sheet').showModal();
  updateChatVisible();
}
function closeSheet() {
  if (!sheetOpen) return;
  sheetOpen = false;
  $('#sheet').close();
  mountChatForGame(); // チャットを右列（非表示列）に戻す
  updateChatVisible();
}
$('#chat-btn').addEventListener('click', openSheet);
$('#sheet-close').addEventListener('click', closeSheet);
$('#sheet').addEventListener('click', e => { if (e.target === $('#sheet')) closeSheet(); }); // 背景タップ
$('#sheet').addEventListener('close', () => { sheetOpen = false; mountChatForGame(); updateChatVisible(); });

document.addEventListener('visibilitychange', updateChatVisible);
mqMobile.addEventListener('change', () => { if (currentScreen === 'game') { mountChatForGame(); updateChatVisible(); } });

// ---------- ミュート切替ボタン ----------
const SVG_ON = '<svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><polygon points="11 5 6 9 2 9 2 15 6 15 11 19 11 5"></polygon><path d="M15.54 8.46a5 5 0 0 1 0 7.07"></path><path d="M19.07 4.93a10 10 0 0 1 0 14.14"></path></svg>';
const SVG_OFF = '<svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><polygon points="11 5 6 9 2 9 2 15 6 15 11 19 11 5"></polygon><line x1="23" y1="9" x2="17" y2="15"></line><line x1="17" y1="9" x2="23" y2="15"></line></svg>';
function refreshMuteBtn() {
  const btn = $('#mute-btn');
  if (!btn) return;
  const muted = isMuted();
  btn.innerHTML = muted ? SVG_OFF : SVG_ON;
  btn.setAttribute('aria-label', muted ? '効果音オフ' : '効果音オン');
  btn.setAttribute('aria-pressed', String(!muted));
}
$('#mute-btn').addEventListener('click', () => {
  setMuted(!isMuted());
  refreshMuteBtn();
  if (!isMuted()) sound('ready'); // オンにしたら確認音
});
refreshMuteBtn();

function show(name) {
  currentScreen = name;
  for (const s of document.querySelectorAll('.screen')) s.hidden = s.id !== `screen-${name}`;
}

let toastTimer;
function toast(msg) {
  const t = $('#toast');
  t.textContent = msg;
  t.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => (t.hidden = true), 2600);
}

function getName() {
  const n = $('#name').value.trim();
  if (!n) {
    toast('先に名前を入れてください');
    $('#name').focus();
    return null;
  }
  localStorage.setItem(NAME_KEY, n);
  return n;
}

function saveSession(code, token) {
  try { localStorage.setItem(SESSION_KEY, JSON.stringify({ code, token })); } catch {}
}
function loadSession() {
  try { return JSON.parse(localStorage.getItem(SESSION_KEY)); } catch { return null; }
}
function clearSession() {
  try { localStorage.removeItem(SESSION_KEY); } catch {}
}

// ---------- ホーム ----------
async function initHome() {
  $('#name').value = localStorage.getItem(NAME_KEY) || '';
  const code = new URLSearchParams(location.search).get('room');
  if (code) $('#join-code').value = code.toUpperCase();

  games = await (await fetch('/api/games')).json();
  $('#game-list').innerHTML = games.map(g => `
    <button class="game-box" data-id="${esc(g.id)}">
      <span class="game-cover" style="background:${esc(g.cover.color)}">
        <span class="game-cover-card" style="color:${esc(g.cover.markColor)}">${esc(g.cover.mark)}</span>
      </span>
      <span class="game-body">
        <span class="game-name">${esc(g.name)}</span>
        <span class="game-meta">${esc(g.category)}・${g.minPlayers === g.maxPlayers ? g.minPlayers : `${g.minPlayers}〜${g.maxPlayers}`}人</span>
        <span class="game-desc">${esc(g.description)}</span>
      </span>
    </button>`).join('');

  $('#game-list').addEventListener('click', async e => {
    const card = e.target.closest('.game-box');
    if (!card) return;
    const name = getName();
    if (!name) return;
    const res = await call('room:create', { name, gameId: card.dataset.id });
    if (res.error) return toast(res.error);
    saveSession(res.code, res.token);
  });

  $('#join-btn').addEventListener('click', join);
  $('#join-code').addEventListener('keydown', e => e.key === 'Enter' && join());
}

async function join() {
  const name = getName();
  if (!name) return;
  const code = $('#join-code').value.trim().toUpperCase();
  if (code.length !== 4) return toast('4文字のコードを入れてください');
  const res = await call('room:join', { name, code });
  if (res.error) return toast(res.error);
  saveSession(res.code, res.token);
}

// ---------- ロビー ----------
let lastLobby = null;    // 前回のロビー状態（音を鳴らすため）
let lobbyCdTimer = null; // カウントダウン表示の更新タイマー

function stopLobbyCountdown() {
  clearInterval(lobbyCdTimer);
  lobbyCdTimer = null;
}

// ゲーム設定の表示が必要な定義だけ（showIf を考慮）
function visibleOptionDefs(r) {
  const defs = r.optionDefs || [];
  const opts = r.options || {};
  return defs.filter(d => !d.showIf || opts[d.showIf.key] === d.showIf.equals);
}

// select の値を表示用の文字列にする（choices の label・bool・int）
function optionValueLabel(def, value) {
  if (def.type === 'select') {
    const c = (def.choices || []).find(c => c.value === value);
    return c ? c.label : String(value);
  }
  if (def.type === 'bool') return value ? 'オン' : 'オフ';
  return String(value);
}

// ロビーの「ゲーム設定」パネル。ホストは入力UI、ほかの人は読み取り専用
function optionsPanel(r, isHost) {
  const defs = visibleOptionDefs(r);
  if (!defs.length) return '';
  const opts = r.options || {};
  if (!isHost) {
    const summary = defs.map(d => `${esc(d.label)} ${esc(optionValueLabel(d, opts[d.key]))}`).join(' ／ ');
    return `
      <div class="lobby-settings paper">
        <div class="lobby-settings-head">ゲーム設定</div>
        <p class="lobby-settings-read">${summary}</p>
      </div>`;
  }
  const rows = defs.map(d => {
    const val = opts[d.key];
    let control = '';
    if (d.type === 'int') {
      control = `
        <div class="opt-int">
          <button class="opt-step" data-opt="${esc(d.key)}" data-delta="-1" aria-label="減らす" ${val <= d.min ? 'disabled' : ''}>−</button>
          <span class="opt-int-val" id="opt-val-${esc(d.key)}">${esc(String(val))}</span>
          <button class="opt-step" data-opt="${esc(d.key)}" data-delta="1" aria-label="増やす" ${val >= d.max ? 'disabled' : ''}>＋</button>
        </div>`;
    } else if (d.type === 'select') {
      const options = (d.choices || []).map((c, i) =>
        `<option value="${i}" ${c.value === val ? 'selected' : ''}>${esc(c.label)}</option>`).join('');
      control = `<select class="opt-select" data-opt="${esc(d.key)}">${options}</select>`;
    } else if (d.type === 'bool') {
      control = `
        <button class="lobby-switch opt-bool" data-opt="${esc(d.key)}" role="switch" aria-checked="${!!val}">
          <span class="lobby-switch-track"><span class="lobby-switch-thumb"></span></span>
        </button>`;
    }
    return `<div class="opt-row"><span class="opt-label">${esc(d.label)}</span>${control}</div>`;
  }).join('');
  return `
    <div class="lobby-settings paper">
      <div class="lobby-settings-head">ゲーム設定</div>
      ${rows}
    </div>`;
}

// ゲーム設定の操作を配線する（ホストのみ要素が存在する）
function wireOptions(r) {
  const defs = visibleOptionDefs(r);
  const opts = r.options || {};
  const send = async (key, value) => {
    const res = await call('lobby:option', { key, value });
    if (res.error) toast(res.error);
  };
  for (const b of document.querySelectorAll('.opt-step')) {
    b.onclick = () => {
      const def = defs.find(d => d.key === b.dataset.opt);
      if (!def) return;
      const next = Number(opts[def.key]) + Number(b.dataset.delta);
      send(def.key, Math.min(def.max, Math.max(def.min, next)));
    };
  }
  for (const s of document.querySelectorAll('.opt-select')) {
    s.onchange = () => {
      const def = defs.find(d => d.key === s.dataset.opt);
      if (!def) return;
      const choice = def.choices[Number(s.value)];
      if (choice) send(def.key, choice.value);
    };
  }
  for (const b of document.querySelectorAll('.opt-bool')) {
    b.onclick = () => send(b.dataset.opt, b.getAttribute('aria-checked') !== 'true');
  }
}

function renderLobby(r) {
  resetPrev(); // ロビーに戻ったら前回の view を忘れる
  clearTurnFx();
  show('lobby');
  const isHost = r.hostId === r.you;
  const me = r.members.find(m => m.id === r.you);
  $('#lobby-game').textContent = r.gameName;
  $('#lobby-code').textContent = r.code;

  // チャットをロビー欄に置く（ロビーは常に「全員」チャンネル・常に見えている）
  chat.setSelf(r.you);
  chat.setComposeChannel('all');
  $('#lobby-chat-slot').appendChild(chat.el);
  chat.setVisible(true);

  const players = r.members.filter(m => m.role === 'player');
  const spectators = r.members.filter(m => m.role === 'spectator');
  const connPlayers = players.filter(m => m.connected);
  const playersFull = players.length >= r.maxPlayers;
  const iAmPlayer = me && me.role === 'player';
  const iPressed = !!(me && me.ready);
  const counting = r.countdownEndsAt != null;

  // 状態メッセージ（1行）
  const connReady = r.members.filter(m => m.connected && m.ready).length;
  const connTotal = r.members.filter(m => m.connected).length;
  let status = '';
  if (!counting) {
    if (connPlayers.length < r.minPlayers) status = `あと${r.minPlayers - connPlayers.length}人、参加者が必要です`;
    else if (connPlayers.length > r.maxPlayers) status = `参加者が多すぎます（最大${r.maxPlayers}人）。だれか観戦に回ってください`;
    else status = `準備OK ${connReady} / ${connTotal}`;
  }

  const memberLi = m => `
    <li class="${m.connected ? '' : 'offline'} ${m.ready ? 'ready' : ''}">
      <span class="lobby-ready-mark">${m.ready ? '✓' : '…'}</span>
      <span class="lobby-name">${esc(m.name)}</span>
      ${m.id === r.hostId ? '<span class="crown">ホスト</span>' : ''}
      ${m.id === r.you ? '<span class="you">あなた</span>' : ''}
      ${m.connected ? '' : '<span class="muted">（接続待ち）</span>'}
    </li>`;

  $('#lobby-body').innerHTML = `
    <div class="lobby-choice" role="radiogroup" aria-label="参加するか観戦するか">
      <button class="lobby-opt ${iAmPlayer ? 'on' : ''}" role="radio" aria-checked="${iAmPlayer}"
        data-role="player" ${(!iAmPlayer && playersFull) ? 'disabled' : ''}>参加する</button>
      <button class="lobby-opt ${!iAmPlayer ? 'on' : ''}" role="radio" aria-checked="${!iAmPlayer}"
        data-role="spectator">観戦する</button>
    </div>
    ${(!iAmPlayer && playersFull) ? '<p class="lobby-note muted center">参加者が満員です</p>' : ''}

    <button id="ready-btn" class="btn ${iPressed ? '' : 'primary'} big ${iPressed ? '' : 'pulse'}">
      ${iPressed ? '準備OKを取り消す' : '準備OK'}</button>

    ${counting ? `
      <div class="lobby-countdown"><span class="lobby-cd-num" id="lobby-cd-num"></span> で開始します</div>
      <p class="muted center small-note">準備OKを取り消すと止まります</p>` : ''}
    ${status ? `<p class="lobby-status center">${esc(status)}</p>` : ''}

    <div class="lobby-lists">
      <div class="lobby-group">
        <div class="lobby-group-head">参加（${players.length} / ${r.maxPlayers}）</div>
        <ul class="player-list">${players.map(memberLi).join('') || '<li class="muted">なし</li>'}</ul>
      </div>
      <div class="lobby-group">
        <div class="lobby-group-head">観戦（${spectators.length}）</div>
        <ul class="player-list">${spectators.map(memberLi).join('') || '<li class="muted">なし</li>'}</ul>
      </div>
    </div>

    ${optionsPanel(r, isHost)}

    ${isHost ? `
      <div class="lobby-host paper">
        <button class="lobby-switch" id="sees-all" role="switch" aria-checked="${r.settings.spectatorSeesAll}">
          <span class="lobby-switch-track"><span class="lobby-switch-thumb"></span></span>
          <span>観戦者に全員の手札を見せる</span>
        </button>
        <p class="muted lobby-switch-desc">オフのときは、プレイヤー全員に見えている情報だけを見せます</p>
        <button class="btn ghost small" id="force-start">待たずに開始</button>
      </div>` : ''}
  `;

  // ---- 操作 ----
  $('#lobby-body').querySelectorAll('.lobby-opt').forEach(b => {
    b.onclick = async () => {
      if (b.disabled) return;
      const res = await call('lobby:role', { role: b.dataset.role });
      if (res.error) toast(res.error);
    };
  });
  const readyBtn = $('#ready-btn');
  readyBtn.onclick = async () => {
    readyBtn.disabled = true;
    const res = await call('lobby:ready', { on: !iPressed });
    if (res.error) toast(res.error);
  };
  wireOptions(r);
  const sees = $('#sees-all');
  if (sees) sees.onclick = async () => {
    const res = await call('lobby:settings', { spectatorSeesAll: sees.getAttribute('aria-checked') !== 'true' });
    if (res.error) toast(res.error);
  };
  const force = $('#force-start');
  if (force) force.onclick = async () => {
    if (!confirm('準備OKを待たずに開始しますか？')) return;
    const res = await call('lobby:forceStart');
    if (res.error) toast(res.error);
  };

  // ---- カウントダウン表示（0.2秒ごと更新） ----
  stopLobbyCountdown();
  if (counting) {
    const tick = () => {
      const el = $('#lobby-cd-num');
      if (!el) return stopLobbyCountdown();
      el.textContent = Math.max(0, Math.ceil((r.countdownEndsAt - Date.now()) / 1000));
    };
    tick();
    lobbyCdTimer = setInterval(tick, 200);
  }

  // ---- 効果音：カウントダウン開始で turn、準備OKがそろうたびに ready ----
  if (lastLobby && lastLobby.code === r.code) {
    if (counting && !lastLobby.counting) sound('turn');
    else if (!counting && connReady > lastLobby.connReady) sound('ready');
  }
  lastLobby = { code: r.code, counting, connReady };
}

$('#copy-link').addEventListener('click', async () => {
  const url = `${location.origin}/?room=${room.code}`;
  try {
    await navigator.clipboard.writeText(url);
    toast('招待リンクをコピーしました');
  } catch {
    prompt('このリンクを友だちに送ってください', url);
  }
});

for (const b of document.querySelectorAll('.leave-btn')) {
  b.addEventListener('click', async () => {
    if (room && room.phase === 'playing' && !confirm('ゲーム中です。本当に退出しますか？')) return;
    await call('room:leave');
    clearSession();
    closeSheet();
    room = null;
    lastLobby = null;
    stopLobbyCountdown();
    resetPrev();
    clearTurnFx();
    history.replaceState(null, '', '/');
    show('home');
  });
}

// ---------- ゲーム ----------
async function loadModule(id) {
  if (!modules[id]) {
    const link = document.createElement('link');
    link.rel = 'stylesheet';
    link.href = `/games/${id}/client.css`;
    document.head.appendChild(link);
    modules[id] = import(`/games/${id}/client.js`);
  }
  return modules[id];
}

async function renderGame(r) {
  show('game');
  $('#game-title').textContent = r.gameName;
  $('#game-code').textContent = r.code;
  const offline = r.members.filter(m => !m.connected);
  $('#game-offline').textContent = offline.length ? `📡 接続待ち: ${offline.map(m => m.name).join('、')}` : '';

  // 自分の立場タグ（観戦者・脱落者）
  const youTag = $('#game-you-tag');
  let tag = '';
  if (r.yourRole === 'spectator') tag = '観戦中';
  else if (r.yourRole === 'out') tag = r.gameId === 'oldmaid' ? '上がり — 観戦中' : '脱落 — 観戦中';
  youTag.textContent = tag;
  youTag.hidden = !tag;
  // 設定がオンのときは全員に知らせる
  $('#game-spectate-note').textContent = r.settings && r.settings.spectatorSeesAll ? '観戦者には手札が見えています' : '';

  const finished = r.phase === 'finished';
  const isHost = r.hostId === r.you;
  $('#game-end').hidden = !finished;
  $('#back-lobby').hidden = !isHost;
  $('#end-wait').hidden = isHost;

  applyTurnFx(!!r.yourTurn); // 手番の演出（バナー・金枠・タブタイトル）

  // チャットをゲームの右列（スマホはシート）に置く
  chat.setSelf(r.you);
  chat.setComposeChannel(chatComposeChannel(r));
  mountChatForGame();
  updateChatVisible();

  const mod = await loadModule(r.gameId);
  if (room !== r) return; // 読み込み中に次の更新が来たら古い描画はしない

  // ルール（チャット／ルールのタブに表示。右列とボトムシートの両方へ）
  if (sideRulesGame !== r.gameId) {
    const html = mod.rules ? `<h3>ルール</h3>${mod.rules}` : '<p class="muted">このゲームのルール説明はありません</p>';
    $('#side-rules').innerHTML = html;
    $('#sheet-rules').innerHTML = html;
    sideRulesGame = r.gameId;
  }

  // 前回描画した view（同じルーム・同じゲームのときだけ）
  const key = `${r.code}|${r.gameId}`;
  const prev = key === lastViewKey ? lastView : null;

  mod.render($('#game-root'), r.view, {
    me: r.you,
    players: r.members,
    finished,
    isHost,
    prev,
    yourTurn: !!r.yourTurn,
    turnIds: r.turnIds || [],
    role: r.yourRole,                                   // 'player' | 'spectator' | 'out'
    seesAll: !!(r.settings && r.settings.spectatorSeesAll),
    deadline: r.deadline != null ? r.deadline : null,   // 締め切りの時刻（ms・サーバー時計）
    clockOffset: r.clockOffset || 0,                    // サーバーとの時計のずれ
    esc,
    toast,
    sound,
    send: async action => {
      const res = await call('game:action', action);
      if (res.error) toast(res.error);
      return res;
    },
  });

  renderSpectators(r); // 観戦者一覧は基盤側で描く（各ゲームの対応は不要）

  lastView = r.view;
  lastViewKey = key;
}

// 「観戦（N人）」の一覧。.g-side があれば一番下に、なければ卓の下に出す
function renderSpectators(r) {
  const root = $('#game-root');
  const old = root.querySelector('.g-spectators');
  if (old) old.remove();
  const specs = r.members.filter(m => !r.gamePlayerIds.includes(m.id));
  if (!specs.length) return;
  const html = `
    <div class="g-spectators">
      <h3>観戦（${specs.length}）</h3>
      <ul>${specs.map(m => `<li class="${m.connected ? '' : 'offline'}">${esc(m.name)}${m.id === r.you ? '<span class="you">あなた</span>' : ''}</li>`).join('')}</ul>
    </div>`;
  const side = root.querySelector('.g-side');
  if (side) side.insertAdjacentHTML('beforeend', html);
  else (root.querySelector('.g-main') || root).insertAdjacentHTML('beforeend', html);
}

$('#back-lobby').addEventListener('click', async () => {
  const res = await call('game:lobby');
  if (res.error) toast(res.error);
});

// ---------- 通信 ----------
socket.on('room:update', r => {
  // サーバーとの時計のずれ（サーバー時刻 ≈ 自分の時刻 + clockOffset）
  r.clockOffset = typeof r.serverNow === 'number' ? r.serverNow - Date.now() : 0;
  room = r;
  if (r.notice) toast(r.notice);
  if (r.phase === 'lobby') {
    renderLobby(r);
  } else {
    stopLobbyCountdown();
    renderGame(r);
  }
});

socket.on('connect', async () => {
  $('#conn').hidden = true;
  const s = loadSession();
  if (!s) return;
  const res = await call('room:rejoin', s);
  if (res.error) {
    clearSession();
    clearTurnFx();
    show('home');
    if (room) toast('ルームが終了していました');
    room = null;
  }
});

socket.on('disconnect', () => {
  $('#conn').hidden = false;
  resetPrev(); // 再接続直後は prev なしで描く
});

initHome();
