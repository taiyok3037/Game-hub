// =============================================================
//  共通の画面制御（ホーム → ロビー → ゲーム）
//  ゲームごとの画面は /games/<id>/client.js の render() に任せる
// =============================================================
const socket = io();
const $ = s => document.querySelector(s);
const SESSION_KEY = 'gamehub-session';
const NAME_KEY = 'gamehub-name';

let games = [];
let room = null;
const modules = {}; // 読み込んだゲーム画面モジュールのキャッシュ

const esc = s => String(s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const call = (event, data = {}) => new Promise(res => socket.emit(event, data, res));

function show(name) {
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
function renderLobby(r) {
  show('lobby');
  const isHost = r.hostId === r.you;
  $('#lobby-game').textContent = r.gameName;
  $('#lobby-code').textContent = r.code;
  $('#lobby-count').textContent = `${r.players.length} / ${r.maxPlayers}`;
  $('#lobby-players').innerHTML = r.players.map(p => `
    <li class="${p.connected ? '' : 'offline'}">
      ${esc(p.name)}
      ${p.id === r.hostId ? '<span class="crown">ホスト</span>' : ''}
      ${p.id === r.you ? '<span class="you">あなた</span>' : ''}
      ${p.connected ? '' : '<span class="muted">（接続待ち）</span>'}
    </li>`).join('');

  const enough = r.players.length >= r.minPlayers;
  $('#start-btn').hidden = !isHost;
  $('#start-btn').disabled = !enough;
  $('#lobby-wait').textContent = isHost
    ? (enough ? '' : `あと${r.minPlayers - r.players.length}人集まると開始できます`)
    : 'ホストが開始するのを待っています…';
  $('#lobby-wait').hidden = !$('#lobby-wait').textContent;
}

$('#start-btn').addEventListener('click', async () => {
  const res = await call('game:start');
  if (res.error) toast(res.error);
});

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
    room = null;
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
  const offline = r.players.filter(p => !p.connected);
  $('#game-offline').textContent = offline.length ? `📡 接続待ち: ${offline.map(p => p.name).join('、')}` : '';

  const finished = r.phase === 'finished';
  const isHost = r.hostId === r.you;
  $('#game-end').hidden = !finished;
  $('#back-lobby').hidden = !isHost;
  $('#end-wait').hidden = isHost;

  const mod = await loadModule(r.gameId);
  if (room !== r) return; // 読み込み中に次の更新が来たら古い描画はしない
  mod.render($('#game-root'), r.view, {
    me: r.you,
    players: r.players,
    finished,
    esc,
    toast,
    send: async action => {
      const res = await call('game:action', action);
      if (res.error) toast(res.error);
      return res;
    },
  });
}

$('#back-lobby').addEventListener('click', async () => {
  const res = await call('game:lobby');
  if (res.error) toast(res.error);
});

// ---------- 通信 ----------
socket.on('room:update', r => {
  room = r;
  if (r.notice) toast(r.notice);
  if (r.phase === 'lobby') renderLobby(r);
  else renderGame(r);
});

socket.on('connect', async () => {
  $('#conn').hidden = true;
  const s = loadSession();
  if (!s) return;
  const res = await call('room:rejoin', s);
  if (res.error) {
    clearSession();
    show('home');
    if (room) toast('ルームが終了していました');
    room = null;
  }
});

socket.on('disconnect', () => {
  $('#conn').hidden = false;
});

initHome();
