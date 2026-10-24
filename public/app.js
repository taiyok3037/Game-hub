// =============================================================
//  共通の画面制御（ホーム → ロビー → ゲーム）
//  ゲームごとの画面は /games/<id>/client.js の render() に任せる
// =============================================================
import { play as soundPlay, setMuted, isMuted } from '/lib/sound.js';
import * as speech from '/lib/speech.js';

const socket = io();
const $ = s => document.querySelector(s);
const SESSION_KEY = 'gamehub-session';
const NAME_KEY = 'gamehub-name';

let games = [];
let room = null;
let currentScreen = 'home';
let sideRulesGame = null; // ルール欄・シートに今入っているゲームid
let currentRulesHtml = ''; // 今のゲームのルールHTML（.g-side の折りたたみ欄に使う）
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
    setComposeChannel() {}, setOnUnread() {}, setOnSwapSide() {}, setOnClose() {},
    setSide() {}, get unread() { return 0; },
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
  // 未読バッジ（閉じているときだけ増える＝open のときは 0 のまま）
  chat.setOnUnread(n => {
    const b = $('#chat-badge');
    if (!b) return;
    b.textContent = n > 99 ? '99+' : String(n);
    b.hidden = n === 0;
  });
  chat.setOnSwapSide(() => setChatSide(chatSide === 'left' ? 'right' : 'left'));
  chat.setOnClose(() => setChatOpen(false));
  applyChatLayout();
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

// ---------- チャットとルールの配置（PC列・スマホのシート・ロビー欄） ----------
// 開閉・左右・ルールの開閉は、見ている人ごとに localStorage へ保存する。
// 読み書きは必ず try/catch で囲み、使えない（シークレット等）ときは初期値で動く。
const CHAT_OPEN_KEY = 'gamehub-chat-open';
const CHAT_SIDE_KEY = 'gamehub-chat-side';
const RULES_OPEN_KEY = 'gamehub-rules-open';
function lsGet(key) { try { return localStorage.getItem(key); } catch { return null; } }
function lsSet(key, val) { try { localStorage.setItem(key, val); } catch {} }

const LOBBY_RULES_OPEN_KEY = 'gamehub-lobby-rules-open';
let chatOpen = lsGet(CHAT_OPEN_KEY) !== '0';            // 既定：開く
let chatSide = lsGet(CHAT_SIDE_KEY) === 'left' ? 'left' : 'right'; // 既定：右
let rulesOpen = lsGet(RULES_OPEN_KEY) !== '0';          // 既定：開く（ゲーム中）
let lobbyRulesOpen = lsGet(LOBBY_RULES_OPEN_KEY) !== '0'; // 既定：開く（ロビー。ゲーム中と別キー）
let lobbyRulesHtml = '';   // 今のロビーのゲームのルールHTML（import 済みなら持っておく）
let lobbyRulesGame = null; // lobbyRulesHtml がどのゲームのものか

// 907px 以下では、チャットを列ではなくボトムシートで見せる（狭い幅で卓にカードが
// 重ならないように。CSS のチャット列も 908px 以上でだけ出す）。ルール欄は 768px から
// 卓の下に出すので、ここの判定はチャットのシート化だけに関わる。
const mqMobile = window.matchMedia('(max-width: 907px)');
const isMobile = () => mqMobile.matches;
let chatSheetOpen = false;  // スマホのチャットシートが開いているか
let rulesSheetOpen = false; // スマホのルールシートが開いているか

// いまチャットの el を置くべき場所（1つの部品を付け替えて使い回す）
function chatTarget() {
  if (currentScreen === 'lobby') return $('#lobby-chat-slot');
  if (isMobile() && chatSheetOpen) return $('#chat-sheet-slot');
  return $('#chat-col'); // PCの列（スマホでシートを閉じているときは CSS で隠れている）
}
function mountChat() {
  const target = chatTarget();
  if (target && chat.el.parentElement !== target) target.appendChild(chat.el);
}

// チャットが「見えている」か（未読カウント用）
function updateChatVisible() {
  let vis;
  if (currentScreen === 'lobby') vis = true;
  else if (currentScreen === 'game') vis = isMobile() ? chatSheetOpen : chatOpen;
  else vis = false;
  chat.setVisible(vis && !document.hidden);
}

// PCの開閉・左右をゲーム画面・ロビーに反映する（CSSクラスで切り替え）
function applyChatLayout() {
  for (const sel of ['#screen-game', '#screen-lobby']) {
    const s = $(sel);
    if (!s) continue;
    s.classList.toggle('chat-open', chatOpen);
    s.classList.toggle('chat-closed', !chatOpen);
    s.classList.toggle('chat-left', chatSide === 'left');
    s.classList.toggle('chat-right', chatSide === 'right');
  }
  const btn = $('#chat-btn');
  if (btn) btn.setAttribute('aria-expanded', String(chatOpen));
  chat.setSide(chatSide);
  updateChatColHeight();
}

// チャット列の高さを「画面の高さ − 列の上端 − 16px」にする（360〜640px に収める）。
// 列はゲームバーの下から始まるので、CSS だけでは合わせにくく JS で測って入れる。
// resize・scroll でまとめて更新（rAF）。スマホ・1列のときは CSS が var を使わない。
let chatHRaf = null;
function updateChatColHeight() {
  if (chatHRaf) return;
  chatHRaf = requestAnimationFrame(() => {
    chatHRaf = null;
    const el = currentScreen === 'game' ? $('#chat-col')
             : currentScreen === 'lobby' ? $('#lobby-chat-slot')
             : null;
    if (!el) return;
    const top = el.getBoundingClientRect().top;
    const h = Math.max(360, Math.min(640, window.innerHeight - Math.max(top, 16) - 16));
    el.style.setProperty('--chat-h', `${Math.round(h)}px`);
  });
}
window.addEventListener('resize', updateChatColHeight);
window.addEventListener('scroll', updateChatColHeight, { passive: true });

// 開閉・左右が変わったら、卓（SVGの地図など）を新しい幅に合わせて描き直させる。
// 各ゲームは幅100%で描いているので、resize を1回出せばよい。
function reflowGame() {
  requestAnimationFrame(() => window.dispatchEvent(new Event('resize')));
}
function setChatOpen(open) {
  chatOpen = open;
  lsSet(CHAT_OPEN_KEY, open ? '1' : '0');
  applyChatLayout();
  mountChat();
  updateChatVisible();
  reflowGame();
}
function setChatSide(side) {
  chatSide = side;
  lsSet(CHAT_SIDE_KEY, side);
  applyChatLayout();
  reflowGame();
}

// ---- スマホのボトムシート（チャット・ルールは別々） ----
function openChatSheet() {
  chatSheetOpen = true;
  mountChat();
  $('#chat-sheet').showModal();
  updateChatVisible();
}
function closeChatSheet() {
  if (!chatSheetOpen) return;
  chatSheetOpen = false;
  $('#chat-sheet').close();
  mountChat();
  updateChatVisible();
}
function openRulesSheet() { rulesSheetOpen = true; $('#rules-sheet').showModal(); }
function closeRulesSheet() {
  if (!rulesSheetOpen) return;
  rulesSheetOpen = false;
  $('#rules-sheet').close();
}

// チャットボタン：スマホはシートを開く／PCは列を開閉する
$('#chat-btn').addEventListener('click', () => {
  if (isMobile()) openChatSheet();
  else setChatOpen(!chatOpen);
});
// ルールボタン（スマホのみ表示）：ルール専用シートを開く
$('#rules-btn').addEventListener('click', openRulesSheet);

$('#chat-sheet-close').addEventListener('click', closeChatSheet);
$('#chat-sheet').addEventListener('click', e => { if (e.target === $('#chat-sheet')) closeChatSheet(); });
$('#chat-sheet').addEventListener('close', () => { chatSheetOpen = false; mountChat(); updateChatVisible(); });
$('#rules-sheet-close').addEventListener('click', closeRulesSheet);
$('#rules-sheet').addEventListener('click', e => { if (e.target === $('#rules-sheet')) closeRulesSheet(); });
$('#rules-sheet').addEventListener('close', () => { rulesSheetOpen = false; });

// ---- ホームのルールダイアログ ----
// ゲームの箱の「ルール」ボタンから開く。本文は必要になったときに client.js を import() して
// export const rules を取り出す（ホームの読み込みを重くしないため）。背景タップ・Esc で閉じる。
async function openHomeRules(id) {
  const g = games.find(x => x.id === id);
  $('#home-rules-title').textContent = g ? `${g.name} のルール` : 'ルール';
  $('#home-rules-body').innerHTML = '<p class="muted">読み込み中…</p>';
  $('#home-rules').showModal();
  try {
    const mod = await loadModule(id);
    if ($('#home-rules').open) $('#home-rules-body').innerHTML = mod.rules || '<p class="muted">このゲームのルール説明はありません</p>';
  } catch {
    $('#home-rules-body').innerHTML = '<p class="muted">ルールを読み込めませんでした</p>';
  }
}
$('#home-rules-close').addEventListener('click', () => $('#home-rules').close());
$('#home-rules').addEventListener('click', e => { if (e.target === $('#home-rules')) $('#home-rules').close(); });

// PCのルール欄（#rules-box）の開閉。見出し行のボタンで開閉し、状態を保存する（初期値は開く）。
// 閉じたときは本文を高さで縮めるのではなく hidden（display:none）にして、帯の下に覗かせない。
// アニメーションは grid-template-rows(0fr↔1fr) で見せ、閉じ終わってから hidden を付ける。
let rulesAnimTimer = null;
function setRulesOpen(open, animate = true) {
  rulesOpen = open;
  lsSet(RULES_OPEN_KEY, open ? '1' : '0');
  const box = $('#rules-box'), body = $('#rules-body');
  $('#rules-toggle').setAttribute('aria-expanded', String(open));
  $('#rules-toggle .rules-head-label').textContent = open ? '隠す' : '表示';
  $('#rules-toggle .rules-head-caret').textContent = open ? '▲' : '▼';
  clearTimeout(rulesAnimTimer);
  const reduce = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
  if (open) {
    body.hidden = false; // 先に表示してから開くアニメ（hidden のままだと transition が走らない）
    if (animate && !reduce) {
      box.classList.add('rules-closed');    // 0fr の状態から
      void body.offsetHeight;               // 反映させてから
      box.classList.remove('rules-closed');  // 1fr へ開く
    } else {
      box.classList.remove('rules-closed');
    }
  } else {
    box.classList.add('rules-closed');       // 1fr→0fr に畳む
    if (animate && !reduce) {
      rulesAnimTimer = setTimeout(() => { body.hidden = true; }, 180); // 畳み終わってから隠す
    } else {
      body.hidden = true;                    // 高さではなく display:none で隠す
    }
  }
}
$('#rules-toggle').addEventListener('click', () => setRulesOpen(!rulesOpen));
setRulesOpen(rulesOpen, false); // 初期は即反映（アニメなし）

// ロビーのルール欄。ゲーム中の #rules-box と同じ見た目・開閉だが、別インスタンス・別の保存キー。
// ロビーは描き直しのたびに lobby-body を作り直すので、ルールHTMLを持っておいて即描けるようにする。
let lobbyRulesAnimTimer = null;
function lobbyRulesBoxHTML() {
  if (!lobbyRulesHtml) return '';
  const open = lobbyRulesOpen;
  return `
    <div id="lobby-rules-box" class="rules-box paper ${open ? '' : 'rules-closed'}">
      <button type="button" id="lobby-rules-toggle" class="rules-head" aria-expanded="${open}" aria-controls="lobby-rules-body">
        <span class="rules-head-title">ルール</span>
        <span class="rules-head-btn"><span class="rules-head-label">${open ? '隠す' : '表示'}</span> <span class="rules-head-caret" aria-hidden="true">${open ? '▲' : '▼'}</span></span>
      </button>
      <div id="lobby-rules-body" class="rules-box-body"${open ? '' : ' hidden'}><div class="rules-body-inner">${lobbyRulesHtml}</div></div>
    </div>`;
}
function setLobbyRulesOpen(open, animate = true) {
  lobbyRulesOpen = open;
  lsSet(LOBBY_RULES_OPEN_KEY, open ? '1' : '0');
  const box = $('#lobby-rules-box'), body = $('#lobby-rules-body'), toggle = $('#lobby-rules-toggle');
  if (!box || !body || !toggle) return;
  toggle.setAttribute('aria-expanded', String(open));
  $('#lobby-rules-toggle .rules-head-label').textContent = open ? '隠す' : '表示';
  $('#lobby-rules-toggle .rules-head-caret').textContent = open ? '▲' : '▼';
  clearTimeout(lobbyRulesAnimTimer);
  const reduce = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
  if (open) {
    body.hidden = false;
    if (animate && !reduce) { box.classList.add('rules-closed'); void body.offsetHeight; box.classList.remove('rules-closed'); }
    else box.classList.remove('rules-closed');
  } else {
    box.classList.add('rules-closed');
    if (animate && !reduce) lobbyRulesAnimTimer = setTimeout(() => { if (body) body.hidden = true; }, 180);
    else body.hidden = true;
  }
}
// ロビーのルール欄を配線し、まだHTMLが無ければ import() で取り出して描き直す
function setupLobbyRules(gameId) {
  const toggle = $('#lobby-rules-toggle');
  if (toggle) toggle.onclick = () => setLobbyRulesOpen(!lobbyRulesOpen);
  if (lobbyRulesGame === gameId) return; // 読み込み済み
  loadModule(gameId).then(mod => {
    lobbyRulesGame = gameId;
    lobbyRulesHtml = mod.rules || '';
    if (currentScreen === 'lobby' && room && room.gameId === gameId) renderLobby(room); // 取れたら描き直して差し込む
  }).catch(() => {});
}

document.addEventListener('visibilitychange', updateChatVisible);
mqMobile.addEventListener('change', () => {
  if (!isMobile()) { closeChatSheet(); closeRulesSheet(); } // PC幅に戻ったらシートは閉じる
  if (currentScreen === 'game' || currentScreen === 'lobby') { mountChat(); updateChatVisible(); updateChatColHeight(); }
});

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

// ---------- 読み上げ切替ボタン（迷言などの発表を声で読む） ----------
// 日本語の声が使えないブラウザではボタン自体を出さない。既定はオフ。
// スピーカーではなく「吹き出し＋声の線」のアイコン（ミュート用スピーカーと区別するため）
const TTS_BUBBLE = '<path d="M20 4H4a2 2 0 0 0-2 2v9a2 2 0 0 0 2 2h3v4l5-4h8a2 2 0 0 0 2-2V6a2 2 0 0 0-2-2z"></path>';
const TTS_ON = `<svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${TTS_BUBBLE}<line x1="8" y1="8.5" x2="8" y2="12.5"></line><line x1="12" y1="7.5" x2="12" y2="13.5"></line><line x1="16" y1="8.5" x2="16" y2="12.5"></line></svg>`;
const TTS_OFF = `<svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${TTS_BUBBLE}<line x1="4" y1="3.5" x2="20" y2="19.5"></line></svg>`;
function refreshTtsBtn() {
  const btn = $('#tts-btn');
  if (!btn) return;
  const on = speech.isEnabled();
  btn.innerHTML = on ? TTS_ON : TTS_OFF;
  btn.setAttribute('aria-label', on ? '読み上げオン' : '読み上げオフ');
  btn.setAttribute('aria-pressed', String(on));
}
{
  const btn = $('#tts-btn');
  if (btn && speech.isAvailable()) {
    btn.hidden = false;
    btn.addEventListener('click', () => {
      speech.setEnabled(!speech.isEnabled());
      refreshTtsBtn();
    });
    refreshTtsBtn();
  }
}

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
    <div class="game-box-wrap">
      <button class="game-box" data-id="${esc(g.id)}">
        <span class="game-cover" style="background:${esc(g.cover.color)}">
          <span class="game-cover-card" style="color:${esc(g.cover.markColor)}">${esc(g.cover.mark)}</span>
        </span>
        <span class="game-body">
          <span class="game-name">${esc(g.name)}</span>
          <span class="game-meta">${esc(g.category)}・${g.minPlayers === g.maxPlayers ? g.minPlayers : `${g.minPlayers}〜${g.maxPlayers}`}人</span>
          <span class="game-desc">${esc(g.description)}</span>
        </span>
      </button>
      ${g.hasRules ? `<button type="button" class="game-rules-btn" data-rules="${esc(g.id)}" aria-label="${esc(g.name)}のルール">ルール</button>` : ''}
    </div>`).join('');

  $('#game-list').addEventListener('click', async e => {
    // ルールボタン：ルームは作らず、そのゲームのルールをダイアログで出す
    const rulesBtn = e.target.closest('.game-rules-btn');
    if (rulesBtn) {
      e.stopPropagation();
      openHomeRules(rulesBtn.dataset.rules);
      return;
    }
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
  $('#lobby-code-text').textContent = r.code;
  $('#lobby-code').setAttribute('aria-label', `ルームコード ${r.code} をコピー`);

  // チャットをロビー欄に置く（ロビーは常に「全員」チャンネル・常に見えている）
  chat.setSelf(r.you);
  chat.setComposeChannel('all');
  applyChatLayout();
  mountChat();
  updateChatVisible();

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
    ${lobbyRulesBoxHTML()}
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
  setupLobbyRules(r.gameId); // ルール欄の配線＋（未読込なら）ルールHTMLの取り込み
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

// ルームコード（4文字）をコピーする。clipboard が無い・失敗したら textarea で、
// それも駄目ならトーストで手入力を促す。
async function copyRoomCode(code) {
  if (!code) return;
  const done = `ルームコード ${code} をコピーしました`;
  try {
    if (navigator.clipboard && navigator.clipboard.writeText) {
      await navigator.clipboard.writeText(code);
      return toast(done);
    }
  } catch {}
  try {
    const ta = document.createElement('textarea');
    ta.value = code;
    ta.setAttribute('readonly', '');
    ta.style.position = 'fixed';
    ta.style.top = '-1000px';
    document.body.appendChild(ta);
    ta.select();
    const ok = document.execCommand('copy');
    ta.remove();
    if (ok) return toast(done);
  } catch {}
  toast(`コピーできませんでした。${code} を手で入力してください`);
}
$('#game-code-btn').addEventListener('click', () => room && copyRoomCode(room.code));
$('#lobby-code').addEventListener('click', () => room && copyRoomCode(room.code));

for (const b of document.querySelectorAll('.leave-btn')) {
  b.addEventListener('click', async () => {
    if (room && room.phase === 'playing' && !confirm('ゲーム中です。本当に退出しますか？')) return;
    await call('room:leave');
    clearSession();
    closeChatSheet();
    closeRulesSheet();
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
  $('#game-code-btn').setAttribute('aria-label', `ルームコード ${r.code} をコピー`);
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

  // チャットをゲームのチャット列（スマホはシート）に置く
  chat.setSelf(r.you);
  chat.setComposeChannel(chatComposeChannel(r));
  applyChatLayout();
  mountChat();
  updateChatVisible();

  const mod = await loadModule(r.gameId);
  if (room !== r) return; // 読み込み中に次の更新が来たら古い描画はしない

  // ルールは基盤が持つ #rules-box（PC・描き直されない）と #rules-sheet（スマホ）へ。
  // ゲームの種類が決まったときに1回だけ入れ、以降の更新では触らない。
  currentRulesHtml = mod.rules || '<p class="muted">このゲームのルール説明はありません</p>';
  if (sideRulesGame !== r.gameId) {
    $('#rules-body .rules-body-inner').innerHTML = currentRulesHtml;
    $('#rules-sheet-body').innerHTML = currentRulesHtml;
    $('#side-slot').replaceChildren(); // 前のゲームのサイドが残らないよう空にする
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
    speak: (text, opts) => { if (!isMuted()) speech.speak(text, opts); }, // 読み上げ（オフ・非対応・全体ミュート中は何もしない）
    send: async action => {
      const res = await call('game:action', action);
      if (res.error) toast(res.error);
      return res;
    },
  });

  moveSideOut();       // ゲームが出した .g-side を、描き直されない #side-slot へ移す
  renderSpectators(r); // 観戦者一覧は基盤側で描く（各ゲームの対応は不要）

  lastView = r.view;
  lastViewKey = key;
}

// ゲームの render は毎回まるごと描き直す（しかも dicewar/cucumber/meigen は
// 自前のタイマーでも描き直す）ので、その中に現れた .g-side を、描き直されない
// 基盤側の #side-slot へ移す。これでルール欄（#rules-box）や観戦一覧が巻き添えで
// 消えたり点滅したりしない。見つからないときは触らない（移動後の空振りを無視）。
function moveSideOut() {
  const gside = $('#game-root').querySelector('.g-side');
  if (gside) $('#side-slot').replaceChildren(gside);
}
// #game-root に .g-side が現れるたびに（基盤経由でない自前の再描画でも）移す
new MutationObserver(moveSideOut).observe($('#game-root'), { childList: true, subtree: true });

// 「観戦（N人）」の一覧。基盤が持つ #spectators-slot に描く（ゲームの再描画と無関係）
function renderSpectators(r) {
  const slot = $('#spectators-slot');
  const specs = r.members.filter(m => !r.gamePlayerIds.includes(m.id));
  if (!specs.length) { slot.replaceChildren(); return; }
  slot.innerHTML = `
    <div class="g-spectators">
      <h3>観戦（${specs.length}）</h3>
      <ul>${specs.map(m => `<li class="${m.connected ? '' : 'offline'}">${esc(m.name)}${m.id === r.you ? '<span class="you">あなた</span>' : ''}</li>`).join('')}</ul>
    </div>`;
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
