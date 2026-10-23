// =============================================================
//  ルームチャットの部品（ロビー・ゲーム共通で1つだけ作る）
//  - メッセージ一覧・クイックリアクション・入力欄をまとめた1要素を返す
//  - app.js が socket からの chat:message / chat:history を流し込む
//  - 置き場所（ロビー欄／ゲームの右列タブ／ボトムシート）は app.js が el を付け替える
//  安全：ユーザーの入力は必ず textContent で入れる（HTMLとして解釈しない）
// =============================================================
import { REACTIONS, REACTION_ORDER } from '/lib/reactions.js';

export function createChat({ socket, sound, toast }) {
  let self = null;              // 自分の member id
  let composeChannel = 'all';   // いま送ると届くチャンネル（観戦席なら placeholder を変える）
  let visible = false;          // チャットが見えているか（未読カウント用）
  let stick = true;             // 一番下に貼り付いているか
  let unread = 0;
  let onUnread = () => {};

  // ---- DOM 組み立て ----
  const el = document.createElement('div');
  el.className = 'chat';
  el.innerHTML = `
    <div class="chat-log" role="log" aria-live="polite" aria-label="チャット"></div>
    <button type="button" class="chat-new" hidden>新着メッセージ ↓</button>
    <div class="chat-reactions" role="group" aria-label="クイックリアクション">
      ${REACTION_ORDER.map(k => `<button type="button" class="chat-chip" data-key="${k}"></button>`).join('')}
    </div>
    <form class="chat-form">
      <label class="chat-label" for="chat-input">メッセージ</label>
      <input id="chat-input" class="chat-input" maxlength="140" autocomplete="off"
             enterkeyhint="send" placeholder="メッセージを送る">
      <button type="submit" class="btn primary small chat-send">送信</button>
    </form>`;

  const logEl = el.querySelector('.chat-log');
  const newBtn = el.querySelector('.chat-new');
  const form = el.querySelector('.chat-form');
  const input = el.querySelector('.chat-input');

  // リアクションチップの文言（定型文）を入れる
  for (const chip of el.querySelectorAll('.chat-chip')) {
    chip.textContent = REACTIONS[chip.dataset.key];
    chip.onclick = () => socket.emit('chat:react', { key: chip.dataset.key }, res => {
      if (res && res.error) toast(res.error);
    });
  }

  // ---- 1件を要素にする（textContent で安全に） ----
  function msgEl(m) {
    const wrap = document.createElement('div');
    wrap.className = 'chat-msg';
    if (m.kind === 'system') {
      wrap.classList.add('sys');
      wrap.textContent = m.text;
      return wrap;
    }
    const mine = m.fromId === self;
    wrap.classList.add(mine ? 'me' : 'other');
    if (m.channel === 'spectators') wrap.classList.add('spec');
    if (!mine) {
      const name = document.createElement('div');
      name.className = 'chat-name';
      name.textContent = m.fromName || '';
      wrap.appendChild(name);
    }
    const bubble = document.createElement('div');
    bubble.className = 'chat-bubble' + (m.kind === 'reaction' ? ' reaction' : '');
    bubble.textContent = m.text;
    if (m.channel === 'spectators') {
      const tag = document.createElement('span');
      tag.className = 'chat-spec-tag';
      tag.textContent = '観戦席';
      bubble.appendChild(tag);
    }
    wrap.appendChild(bubble);
    return wrap;
  }

  function atBottom() {
    return logEl.scrollHeight - logEl.scrollTop - logEl.clientHeight < 24;
  }
  function scrollToBottom() {
    logEl.scrollTop = logEl.scrollHeight;
    stick = true;
    newBtn.hidden = true;
  }

  logEl.addEventListener('scroll', () => {
    stick = atBottom();
    if (stick) newBtn.hidden = true;
  });
  newBtn.onclick = scrollToBottom;

  // ---- 外から使う API ----
  function setHistory(list) {
    logEl.innerHTML = '';
    for (const m of list) logEl.appendChild(msgEl(m));
    scrollToBottom();
  }

  function addMessage(m) {
    const wasBottom = stick;
    logEl.appendChild(msgEl(m));
    // 他人のメッセージ・リアクションで音（自分・システムは鳴らさない）
    if (m.fromId !== self && m.kind !== 'system') sound('chat');
    // 未読（見えていない・システム以外）
    if (!visible && m.kind !== 'system') { unread++; onUnread(unread); }
    // スクロール追従
    if (wasBottom) scrollToBottom();
    else if (m.kind !== 'system') newBtn.hidden = false;
  }

  function setVisible(v) {
    visible = v;
    if (v) {
      unread = 0;
      onUnread(0);
      scrollToBottom();
    }
  }

  function setComposeChannel(ch) {
    composeChannel = ch;
    input.placeholder = ch === 'spectators'
      ? '観戦席に送信（プレイヤーには見えません）'
      : 'メッセージを送る';
    el.classList.toggle('chat-spec-mode', ch === 'spectators');
  }

  function send() {
    const text = input.value.trim();
    if (!text) { input.value = ''; return; }
    socket.emit('chat:send', { text }, res => {
      if (res && res.error) toast(res.error);
      else input.value = '';
    });
  }

  // IME変換中のEnterで送信しない
  input.addEventListener('keydown', e => {
    if (e.key === 'Enter' && !e.isComposing) { e.preventDefault(); send(); }
  });
  form.addEventListener('submit', e => { e.preventDefault(); send(); });

  return {
    el,
    setSelf(id) { self = id; },
    setHistory,
    addMessage,
    setVisible,
    setComposeChannel,
    setOnUnread(cb) { onUnread = cb; },
    get unread() { return unread; },
  };
}
