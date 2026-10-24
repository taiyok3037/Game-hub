// =============================================================
//  Game Hub サーバー
//  - games/ 以下のフォルダを自動で読み込み、ゲームとして登録する
//  - ルーム（合言葉コード）・ロビー・再接続・観戦を共通で管理する
//  - ゲームの中身（ルール）は各ゲームの server.js に任せる
// =============================================================
const express = require('express');
const http = require('http');
const path = require('path');
const fs = require('fs');
const crypto = require('crypto');
const { Server } = require('socket.io');
const { viewFor, roleOf } = require('./lib/viewFor');
const { REACTIONS } = require('./lib/reactions');

const app = express();
const server = http.createServer(app);
const io = new Server(server);
const PORT = process.env.PORT || 3000;

const ROOM_CAP = 16;        // 観戦者を含めた部屋全体の上限
// 準備OKがそろってから開始までのカウントダウン（テストだけ環境変数で短縮できる）
const COUNTDOWN_MS = Number(process.env.COUNTDOWN_MS) || 3000;

// ---------- ゲームの自動読み込み ----------
const GAMES_DIR = path.join(__dirname, 'games');
const games = {};
for (const dir of fs.readdirSync(GAMES_DIR)) {
  const file = path.join(GAMES_DIR, dir, 'server.js');
  if (!fs.existsSync(file)) continue;
  const game = require(file);
  for (const key of ['id', 'name', 'minPlayers', 'maxPlayers', 'setup', 'action', 'view', 'isOver']) {
    if (game[key] === undefined) throw new Error(`games/${dir}/server.js に "${key}" がありません`);
  }
  if (game.id !== dir) throw new Error(`games/${dir}: id はフォルダ名と同じにしてください`);
  // client.js が `export const rules` を持つか（ホーム・ロビーのルール表示用）。起動時に1回だけ調べる
  const clientFile = path.join(GAMES_DIR, dir, 'client.js');
  game.hasRules = fs.existsSync(clientFile) && /export\s+const\s+rules\b/.test(fs.readFileSync(clientFile, 'utf8'));
  games[game.id] = game;
  console.log(`ゲーム登録: ${game.name} (${game.id})`);
}

// ---------- ゲーム設定（options） ----------
// ゲームが宣言する options から、表示用の定義を作る（choices が関数なら値に変換する）
function gameOptionDefs(game) {
  if (!Array.isArray(game.options)) return [];
  return game.options.map(def => {
    const out = { ...def };
    if (typeof def.choices === 'function') {
      try { out.choices = def.choices(); } catch (e) { console.error(e); out.choices = []; }
    }
    return out;
  });
}

// ゲームの default から現在値（room.options）の初期値を作る
function defaultOptions(game) {
  const opts = {};
  for (const def of gameOptionDefs(game)) opts[def.key] = def.default;
  return opts;
}

// 1項目の変更を検証する。OK なら { value: 正規化した値 }、違反なら { error }
function validateOption(game, key, value) {
  const def = gameOptionDefs(game).find(d => d.key === key);
  if (!def) return { error: 'その設定はありません' };
  if (def.type === 'int') {
    if (!Number.isInteger(value)) return { error: '整数で指定してください' };
    if (value < def.min || value > def.max) return { error: `${def.min}〜${def.max} で指定してください` };
    return { value };
  }
  if (def.type === 'select') {
    if (!def.choices.some(c => c.value === value)) return { error: '選べない値です' };
    return { value };
  }
  if (def.type === 'bool') return { value: !!value };
  return { error: '不明な設定です' };
}

// ---------- HTTP ----------
app.use(express.static(path.join(__dirname, 'public')));

// ゲーム一覧（ホーム画面用）
app.get('/api/games', (req, res) => {
  res.json(Object.values(games).map(g => ({
    id: g.id,
    name: g.name,
    description: g.description || '',
    category: g.category || 'その他',
    // ホーム画面の箱の見た目（色と、カードに描く1文字）
    cover: { color: '#6b4a2e', mark: '?', markColor: '#3a2414', ...(g.cover || {}) },
    minPlayers: g.minPlayers,
    maxPlayers: g.maxPlayers,
    hasRules: !!g.hasRules,
  })));
});

// クイックリアクション一覧を ESM としてブラウザへ配信（public/lib には置かない）
app.get('/lib/reactions.js', (req, res) => {
  const { REACTIONS: R, REACTION_ORDER } = require('./lib/reactions');
  res.type('application/javascript').send(
    `export const REACTIONS = ${JSON.stringify(R)};\n` +
    `export const REACTION_ORDER = ${JSON.stringify(REACTION_ORDER)};\n`
  );
});

// 各ゲームの画面側コード（games/<id>/client.js と client.css だけを公開）
app.get('/games/:id/:file', (req, res) => {
  const { id, file } = req.params;
  if (!games[id] || !['client.js', 'client.css'].includes(file)) return res.sendStatus(404);
  const p = path.join(GAMES_DIR, id, file);
  if (!fs.existsSync(p)) return res.sendStatus(404);
  res.sendFile(p);
});

// ---------- ルーム管理 ----------
/** @type {Map<string, Room>} */
const rooms = new Map();

function newRoomCode() {
  const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'; // 紛らわしい文字(I,O,0,1)は除外
  let code;
  do {
    code = Array.from({ length: 4 }, () => chars[crypto.randomInt(chars.length)]).join('');
  } while (rooms.has(code));
  return code;
}

function cleanName(name) {
  const n = String(name || '').trim().slice(0, 12);
  return n || 'ななし';
}

// 新しいメンバーを作る。autoSpectator は「本人の希望ではなく自動で観戦にした」印
function newMember(name, role, autoSpectator = false) {
  return {
    id: crypto.randomUUID(),
    token: crypto.randomUUID(),
    name: cleanName(name),
    socketId: null,
    connected: false,
    role,                 // 'player' | 'spectator'（ロビーでの選択）
    ready: false,         // ロビーでの準備OK
    autoSpectator,
    chatTimes: [],        // 連投制限用（直近の送信時刻）
  };
}

function publicMembers(room) {
  return room.members.map(m => ({
    id: m.id, name: m.name, connected: m.connected, role: m.role, ready: m.ready,
  }));
}

// ゲームの action / onConnectionChange に渡すルーム情報
function roomInfo(room) {
  return {
    hostId: room.hostId,
    connectedIds: room.members.filter(m => m.connected).map(m => m.id),
  };
}

// その局面で「参加者」とみなすメンバー（ロビー＝role, ゲーム中＝gamePlayerIds）
function isParticipant(room, member) {
  return room.phase === 'lobby'
    ? member.role === 'player'
    : room.gamePlayerIds.includes(member.id);
}

// ホストが抜けたときの次ホスト：接続中の参加者 → 接続中の観戦者 → その他
function pickHost(room) {
  const m = room.members.find(x => x.connected && isParticipant(room, x))
         || room.members.find(x => x.connected && !isParticipant(room, x))
         || room.members.find(x => x.connected)
         || room.members[0];
  return m ? m.id : null;
}

// ---------- チャット（仕様04） ----------
let chatSeq = 0; // メッセージ id の連番

// チャンネルの決め方：手札が見える設定のゲーム中は、観戦者・脱落者の発言は観戦席だけ
function channelFor(room, member) {
  const role = roleOf(games[room.gameId], room, member.id);
  if (room.phase === 'playing' && room.settings.spectatorSeesAll && role !== 'player') return 'spectators';
  return 'all';
}

// そのメンバーがそのメッセージを読めるか
function canRead(room, member, entry) {
  if (entry.channel === 'all') return true;
  const role = roleOf(games[room.gameId], room, member.id);
  return role === 'spectator' || role === 'out'; // 観戦席は観戦者・脱落者だけ
}

// 連投制限：3秒で5件まで。超えたら true（制限中）
function chatRateLimited(member) {
  const now = Date.now();
  member.chatTimes = (member.chatTimes || []).filter(t => now - t < 3000);
  if (member.chatTimes.length >= 5) return true;
  member.chatTimes.push(now);
  return false;
}

// 1件保存して、読める人に配信する
function pushChat(room, { kind, channel, fromId, fromName, text }) {
  const entry = { id: ++chatSeq, at: Date.now(), kind, channel, fromId, fromName, text };
  room.chat.push(entry);
  if (room.chat.length > 100) room.chat.splice(0, room.chat.length - 100); // 最新100件
  for (const m of room.members) {
    if (m.socketId && canRead(room, m, entry)) io.to(m.socketId).emit('chat:message', entry);
  }
  return entry;
}

// システムメッセージ（灰色・全員向け）
function pushSystem(room, text) {
  if (!room.chat) return;
  pushChat(room, { kind: 'system', channel: 'all', fromId: null, fromName: null, text });
}

// 入室・再接続のときに、その人が読める履歴だけ送る
function sendHistory(socket, room, member) {
  socket.emit('chat:history', room.chat.filter(e => canRead(room, member, e)));
}

// ゲーム終了の確定（二重に「ゲーム終了」を流さない）
function finishGame(room) {
  if (room.phase === 'finished') return;
  room.phase = 'finished';
  pushSystem(room, 'ゲーム終了');
}

// ---------- カウントダウン・自動開始（3-3 / 3-4） ----------
function clearCountdown(room) {
  if (room.countdown) {
    clearTimeout(room.countdown.timer);
    room.countdown = null;
  }
}

// role / ready / settings の変更、入退室、切断、再接続のたびに呼ぶ。
// 条件がそろえばカウントダウンを始め、崩れれば止める（broadcast は呼び出し側が行う）
function checkLobby(room) {
  if (room.phase !== 'lobby') { clearCountdown(room); return; }
  const game = games[room.gameId];
  const connected = room.members.filter(m => m.connected);
  const players = connected.filter(m => m.role === 'player');
  const allReady = connected.length > 0 && connected.every(m => m.ready);
  const countOk = players.length >= game.minPlayers && players.length <= game.maxPlayers;
  const ok = allReady && countOk;

  if (ok && !room.countdown) {
    room.countdown = {
      endsAt: Date.now() + COUNTDOWN_MS,
      timer: setTimeout(() => startGame(room), COUNTDOWN_MS),
    };
  } else if (!ok && room.countdown) {
    clearCountdown(room);
  }
}

// 開始処理（カウントダウンが切れた / ホストが強制開始）
function startGame(room) {
  if (room.phase !== 'lobby') return;
  const game = games[room.gameId];
  clearCountdown(room);
  const players = room.members.filter(m => m.role === 'player' && m.connected);
  if (players.length < game.minPlayers || players.length > game.maxPlayers) {
    broadcast(room); // 条件が崩れていたら開始しない
    return;
  }
  room.gamePlayerIds = players.map(m => m.id);
  room.state = game.setup(players.map(m => ({ id: m.id, name: m.name })), room.options);
  room.phase = 'playing';
  room.gameNo = (room.gameNo || 0) + 1;
  pushSystem(room, `第${room.gameNo}戦 開始`);
  if (game.isOver(room.state)) finishGame(room);
  broadcast(room);
}

// ゲームが終わってロビーに戻す（3-7）
function returnToLobby(room) {
  const game = games[room.gameId];
  clearCountdown(room);
  clearTimer(room);
  room.phase = 'lobby';
  room.state = null;
  room.gamePlayerIds = [];
  for (const m of room.members) m.ready = false;
  // 自動で観戦になっていた人（満員・ゲーム中参加）は、空きがあれば参加者に戻す
  const playerCount = () => room.members.filter(m => m.role === 'player').length;
  for (const m of room.members) {
    if (m.autoSpectator && m.role === 'spectator' && playerCount() < game.maxPlayers) {
      m.role = 'player';
      m.autoSpectator = false;
    }
  }
}

// ---------- タイマー（締め切り・3-2） ----------
// ゲームの deadline(state) を見て、ルームごとにタイマーを1つだけ張り直す
function armTimer(room, deadlineAt) {
  if (room.timer) { clearTimeout(room.timer); room.timer = null; }
  if (deadlineAt == null) return;
  const delay = Math.max(0, deadlineAt - Date.now());
  room.timer = setTimeout(() => fireTimeout(room), delay);
}

function clearTimer(room) {
  if (room.timer) { clearTimeout(room.timer); room.timer = null; }
}

// 締め切りが来たとき。onTimeout → isOver の確認 → broadcast
function fireTimeout(room) {
  room.timer = null;
  if (room.phase !== 'playing' || !room.state) return;
  const game = games[room.gameId];
  if (typeof game.onTimeout !== 'function') return;
  // 発火時に deadline がまだ未来なら（状態が変わっていたら）何もしない
  let dl = null;
  try { dl = typeof game.deadline === 'function' ? game.deadline(room.state) : null; } catch (e) { console.error(e); }
  if (dl == null || dl > Date.now() + 50) return;
  try { game.onTimeout(room.state, roomInfo(room)); } catch (e) { console.error(e); }
  if (game.isOver(room.state)) finishGame(room);
  broadcast(room);
}

// ---------- 画面に送る（broadcast） ----------
function broadcast(room) {
  room.lastActive = Date.now();
  const game = games[room.gameId];
  // 締め切り（ゲームが deadline を持っていれば）。タイマーを張り直す
  let deadlineAt = null;
  if (room.phase === 'playing' && room.state && typeof game.deadline === 'function') {
    try { deadlineAt = game.deadline(room.state); } catch (e) { console.error(e); }
  }
  armTimer(room, deadlineAt);
  // いま操作を待っている人（手番）。ゲームが turnOf を持っていれば使う
  let turnIds = [];
  if (room.state && typeof game.turnOf === 'function') {
    try {
      turnIds = game.turnOf(room.state) || [];
    } catch (e) {
      console.error(e);
    }
  }
  const members = publicMembers(room);
  for (const m of room.members) {
    if (!m.socketId) continue;
    let view = null;
    try {
      view = viewFor(game, room, m.id);
    } catch (e) {
      console.error(e);
    }
    io.to(m.socketId).emit('room:update', {
      code: room.code,
      gameId: room.gameId,
      gameName: game.name,
      minPlayers: game.minPlayers,
      maxPlayers: game.maxPlayers,
      roomCap: ROOM_CAP,
      hostId: room.hostId,
      phase: room.phase, // 'lobby' | 'playing' | 'finished'
      members,
      gamePlayerIds: room.gamePlayerIds,
      settings: room.settings,
      options: room.options,
      optionDefs: gameOptionDefs(game),
      deadline: deadlineAt,
      serverNow: Date.now(), // クライアントが時計のずれを補正するため
      countdownEndsAt: room.countdown ? room.countdown.endsAt : null,
      you: m.id,
      yourRole: roleOf(game, room, m.id),
      notice: room.notice || null,
      view,
      turnIds,
      yourTurn: room.phase === 'playing'
        && room.gamePlayerIds.includes(m.id)
        && turnIds.includes(m.id),
    });
  }
  room.notice = null;
}

// 接続状況が変わったとき（切断・再接続）にゲームへ知らせる。
// state を変えたら true が返るので、終了判定をしてから broadcast する
function notifyConnectionChange(room) {
  if (room.phase !== 'playing' || !room.state) return;
  const game = games[room.gameId];
  if (typeof game.onConnectionChange !== 'function') return;
  let changed = false;
  try {
    changed = game.onConnectionChange(room.state, roomInfo(room)) === true;
  } catch (e) {
    console.error(e);
  }
  if (changed) {
    if (game.isOver(room.state)) finishGame(room);
    broadcast(room);
  }
}

function findBySocket(socket) {
  const code = socket.data.roomCode;
  if (!code) return {};
  const room = rooms.get(code);
  if (!room) return {};
  const member = room.members.find(m => m.id === socket.data.playerId);
  return { room, member };
}

function attach(socket, room, member) {
  member.socketId = socket.id;
  member.connected = true;
  socket.data.roomCode = room.code;
  socket.data.playerId = member.id;
  socket.join(room.code);
}

function removeMember(room, memberId) {
  const member = room.members.find(m => m.id === memberId);
  if (!member) return;
  const game = games[room.gameId];
  const inGame = room.gamePlayerIds.includes(memberId);

  if (room.phase === 'playing' && inGame) {
    // 参加者の離脱：ゲームが「途中離脱」に対応していればそれを使う。なければロビーへ
    if (typeof game.onLeave === 'function' && game.onLeave(room.state, memberId) !== false) {
      room.notice = `${member.name} さんが抜けました`;
    } else {
      clearTimer(room);
      room.phase = 'lobby';
      room.state = null;
      room.gamePlayerIds = [];
      room.notice = `${member.name} さんが抜けたため、ゲームを終了しました`;
    }
  } else {
    // 観戦者・ロビーのメンバー：ゲームには何もしない（onLeave を呼ばない）
    room.notice = `${member.name} さんが退出しました`;
  }

  room.members = room.members.filter(m => m.id !== memberId);
  room.gamePlayerIds = room.gamePlayerIds.filter(id => id !== memberId);
  if (room.members.length === 0) {
    clearCountdown(room);
    clearTimer(room);
    rooms.delete(room.code);
    return;
  }
  pushSystem(room, `${member.name} さんが退出しました`);
  if (room.hostId === memberId) {
    room.hostId = pickHost(room);
    const host = room.members.find(m => m.id === room.hostId);
    if (host) pushSystem(room, `${host.name} さんがホストになりました`);
  }
  if (room.phase === 'playing' && games[room.gameId].isOver(room.state)) finishGame(room);
  checkLobby(room);
  broadcast(room);
}

io.on('connection', socket => {
  // ルーム作成
  socket.on('room:create', ({ name, gameId } = {}, cb = () => {}) => {
    const game = games[gameId];
    if (!game) return cb({ error: 'そのゲームはありません' });
    leaveCurrent(socket);
    const member = newMember(name, 'player');
    const room = {
      code: newRoomCode(),
      gameId,
      hostId: member.id,
      members: [member],
      phase: 'lobby',
      state: null,
      gamePlayerIds: [],
      settings: { spectatorSeesAll: false },
      options: defaultOptions(game),
      countdown: null,
      timer: null,
      chat: [],
      gameNo: 0,
      lastActive: Date.now(),
    };
    rooms.set(room.code, room);
    attach(socket, room, member);
    cb({ ok: true, code: room.code, token: member.token });
    sendHistory(socket, room, member);
    pushSystem(room, `${member.name} さんが入室しました`);
    checkLobby(room);
    broadcast(room);
  });

  // ルーム参加（ゲーム中でも観戦として入れる。断るのは部屋が16人のときだけ）
  socket.on('room:join', ({ name, code } = {}, cb = () => {}) => {
    const room = rooms.get(String(code || '').trim().toUpperCase());
    if (!room) return cb({ error: 'ルームが見つかりません。コードを確認してください' });
    const game = games[room.gameId];
    if (room.members.length >= ROOM_CAP) return cb({ error: `満員です（最大${ROOM_CAP}人）` });
    leaveCurrent(socket);
    // 入室時の role：ロビー中で参加者に空きがあれば player、そうでなければ spectator
    let role = 'spectator';
    let auto = true;
    if (room.phase === 'lobby' && room.members.filter(m => m.role === 'player').length < game.maxPlayers) {
      role = 'player';
      auto = false;
    }
    const member = newMember(name, role, auto);
    room.members.push(member);
    attach(socket, room, member);
    room.notice = `${member.name} さんが${role === 'spectator' ? '観戦で' : ''}参加しました`;
    cb({ ok: true, code: room.code, token: member.token });
    sendHistory(socket, room, member); // 入室より前の履歴（入室メッセージは下で chat:message で届く）
    pushSystem(room, role === 'spectator' ? `${member.name} さんが観戦に来ました` : `${member.name} さんが入室しました`);
    checkLobby(room);
    broadcast(room);
  });

  // 再接続（リロード・スマホのスリープ復帰など）
  socket.on('room:rejoin', ({ code, token } = {}, cb = () => {}) => {
    const room = rooms.get(code);
    const member = room && room.members.find(m => m.token === token);
    if (!member) return cb({ error: 'expired' });
    if (member.socketId && member.socketId !== socket.id) {
      io.sockets.sockets.get(member.socketId)?.disconnect(true); // 古いタブは切断
    }
    attach(socket, room, member);
    cb({ ok: true, code: room.code, token: member.token });
    sendHistory(socket, room, member); // 再接続した人には読める履歴を送り直す（切断・再接続はシステム通知しない）
    checkLobby(room);
    broadcast(room);
    notifyConnectionChange(room); // 再接続をゲームに知らせる
  });

  socket.on('room:leave', (_ = {}, cb = () => {}) => {
    leaveCurrent(socket);
    cb({ ok: true });
  });

  // ロビー：参加／観戦を選ぶ（本人・ロビー中だけ）
  socket.on('lobby:role', ({ role } = {}, cb = () => {}) => {
    const { room, member } = findBySocket(socket);
    if (!room || !member) return cb({ error: 'ルームにいません' });
    if (room.phase !== 'lobby') return cb({ error: 'ロビーでのみ変更できます' });
    if (role !== 'player' && role !== 'spectator') return cb({ error: '不明な選択です' });
    const game = games[room.gameId];
    if (role === 'player' && member.role !== 'player') {
      const players = room.members.filter(m => m.role === 'player').length;
      if (players >= game.maxPlayers) return cb({ error: `参加者が満員です（最大${game.maxPlayers}人）` });
    }
    member.role = role;
    member.autoSpectator = false; // 本人が選んだので自動印は外す
    member.ready = false;         // 選び直したら準備OKはやり直し
    cb({ ok: true });
    checkLobby(room);
    broadcast(room);
  });

  // ロビー：準備OKの付け外し
  socket.on('lobby:ready', ({ on } = {}, cb = () => {}) => {
    const { room, member } = findBySocket(socket);
    if (!room || !member) return cb({ error: 'ルームにいません' });
    if (room.phase !== 'lobby') return cb({ error: 'ロビーではありません' });
    member.ready = on !== false;
    cb({ ok: true });
    checkLobby(room);
    broadcast(room);
  });

  // ロビー：観戦者の見え方を切り替える（ホストだけ）
  socket.on('lobby:settings', ({ spectatorSeesAll } = {}, cb = () => {}) => {
    const { room, member } = findBySocket(socket);
    if (!room || !member) return cb({ error: 'ルームにいません' });
    if (room.hostId !== member.id) return cb({ error: 'ホストだけが設定できます' });
    if (room.phase !== 'lobby') return cb({ error: 'ロビーでのみ変更できます' });
    room.settings.spectatorSeesAll = !!spectatorSeesAll;
    for (const m of room.members) m.ready = false; // 条件が変わったので確認し直す
    cb({ ok: true });
    checkLobby(room);
    broadcast(room);
  });

  // ロビー：ゲーム設定を変える（ホストだけ）。変えると全員の ready を外す
  socket.on('lobby:option', ({ key, value } = {}, cb = () => {}) => {
    const { room, member } = findBySocket(socket);
    if (!room || !member) return cb({ error: 'ルームにいません' });
    if (room.hostId !== member.id) return cb({ error: 'ホストだけが設定できます' });
    if (room.phase !== 'lobby') return cb({ error: 'ロビーでのみ変更できます' });
    const res = validateOption(games[room.gameId], key, value);
    if (res.error) return cb({ error: res.error });
    room.options[key] = res.value;
    for (const m of room.members) m.ready = false; // 条件が変わったので確認し直す
    cb({ ok: true });
    checkLobby(room);
    broadcast(room);
  });

  // ホストが準備OKを待たずに開始（人数が条件内のときだけ）
  socket.on('lobby:forceStart', (_ = {}, cb = () => {}) => {
    const { room, member } = findBySocket(socket);
    if (!room || !member) return cb({ error: 'ルームにいません' });
    if (room.hostId !== member.id) return cb({ error: 'ホストだけが開始できます' });
    if (room.phase !== 'lobby') return cb({ error: 'すでに始まっています' });
    const game = games[room.gameId];
    const players = room.members.filter(m => m.role === 'player' && m.connected).length;
    if (players < game.minPlayers || players > game.maxPlayers) {
      return cb({ error: `参加者は${game.minPlayers}〜${game.maxPlayers}人にしてください` });
    }
    cb({ ok: true });
    startGame(room);
  });

  // ゲーム中の操作。中身の判定はすべて各ゲームの action() に任せる
  socket.on('game:action', (action = {}, cb = () => {}) => {
    const { room, member } = findBySocket(socket);
    if (!room || !member || room.phase !== 'playing') return cb({ error: 'ゲーム中ではありません' });
    const game = games[room.gameId];
    // 操作できるのは今のゲームの参加者だけ（脱落者も gamePlayerIds に残るので準備OKは押せる）。
    // ただしゲームが spectatorActions で宣言した種類の操作は、観戦者からも受け付ける（例：いいね）
    const specOk = Array.isArray(game.spectatorActions) && game.spectatorActions.includes(action.type);
    if (!room.gamePlayerIds.includes(member.id) && !specOk) return cb({ error: '観戦中は操作できません' });
    let result;
    try {
      result = game.action(room.state, member.id, action, roomInfo(room));
    } catch (e) {
      console.error(e);
      return cb({ error: 'エラーが起きました' });
    }
    if (result && result.error) return cb({ error: result.error });
    cb({ ok: true });
    // ゲームが「broadcast 不要」と返したら、状態の配信をしない（下書きの保存など）
    if (result && result.silent) return;
    if (game.isOver(room.state)) finishGame(room);
    broadcast(room);
  });

  // ホストがロビーに戻す（もう一度遊ぶ）
  socket.on('game:lobby', (_ = {}, cb = () => {}) => {
    const { room, member } = findBySocket(socket);
    if (!room || !member) return cb({ error: 'ルームにいません' });
    if (room.hostId !== member.id) return cb({ error: 'ホストだけが操作できます' });
    returnToLobby(room);
    cb({ ok: true });
    broadcast(room);
  });

  // チャット：文字メッセージ
  socket.on('chat:send', ({ text } = {}, cb = () => {}) => {
    const { room, member } = findBySocket(socket);
    if (!room || !member) return cb({ error: 'ルームにいません' });
    const t = String(text == null ? '' : text).replace(/[\r\n]+/g, ' ').trim();
    if (!t) return cb({ error: '空のメッセージは送れません' });
    if (t.length > 140) return cb({ error: '140文字までにしてください' });
    if (chatRateLimited(member)) return cb({ error: '少し待ってから送ってください' });
    const channel = channelFor(room, member);
    pushChat(room, { kind: 'user', channel, fromId: member.id, fromName: member.name, text: t });
    cb({ ok: true });
  });

  // チャット：クイックリアクション
  socket.on('chat:react', ({ key } = {}, cb = () => {}) => {
    const { room, member } = findBySocket(socket);
    if (!room || !member) return cb({ error: 'ルームにいません' });
    const text = REACTIONS[key];
    if (!text) return cb({ error: '不明なリアクションです' });
    if (chatRateLimited(member)) return cb({ error: '少し待ってから送ってください' });
    const channel = channelFor(room, member);
    pushChat(room, { kind: 'reaction', channel, fromId: member.id, fromName: member.name, text });
    cb({ ok: true });
  });

  socket.on('disconnect', () => {
    const { room, member } = findBySocket(socket);
    if (!room || !member || member.socketId !== socket.id) return;
    member.connected = false;
    member.socketId = null;
    // ロビー中なら少し待って戻ってこなければ退出扱い
    if (room.phase === 'lobby') {
      setTimeout(() => {
        if (rooms.get(room.code) === room && !member.connected && room.phase === 'lobby') {
          removeMember(room, member.id);
        }
      }, 60_000);
    }
    checkLobby(room);
    broadcast(room);
    notifyConnectionChange(room); // 切断をゲームに知らせる
  });

  function leaveCurrent(sock) {
    const { room, member } = findBySocket(sock);
    if (room && member) {
      sock.leave(room.code);
      removeMember(room, member.id);
    }
    sock.data.roomCode = null;
    sock.data.playerId = null;
  }
});

// 誰もいない部屋を定期的に掃除（30分放置で削除）
setInterval(() => {
  const now = Date.now();
  for (const room of rooms.values()) {
    const anyone = room.members.some(m => m.connected);
    if (!anyone && now - room.lastActive > 30 * 60_000) {
      clearCountdown(room);
      clearTimer(room);
      rooms.delete(room.code);
    }
  }
}, 5 * 60_000);

server.listen(PORT, () => console.log(`Game Hub 起動: http://localhost:${PORT}`));

// テスト用に内部を公開する（通常の起動には影響しない）
module.exports = { rooms, games, viewFor, roleOf, pushChat, pushSystem };
