// =============================================================
//  Game Hub サーバー
//  - games/ 以下のフォルダを自動で読み込み、ゲームとして登録する
//  - ルーム（合言葉コード）・ロビー・再接続を共通で管理する
//  - ゲームの中身（ルール）は各ゲームの server.js に任せる
// =============================================================
const express = require('express');
const http = require('http');
const path = require('path');
const fs = require('fs');
const crypto = require('crypto');
const { Server } = require('socket.io');

const app = express();
const server = http.createServer(app);
const io = new Server(server);
const PORT = process.env.PORT || 3000;

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
  games[game.id] = game;
  console.log(`ゲーム登録: ${game.name} (${game.id})`);
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
  })));
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

function publicPlayers(room) {
  return room.players.map(p => ({ id: p.id, name: p.name, connected: p.connected }));
}

// ゲームの action / onConnectionChange に渡すルーム情報
function roomInfo(room) {
  return {
    hostId: room.hostId,
    connectedIds: room.players.filter(p => p.connected).map(p => p.id),
  };
}

// ルーム内の全員に「その人専用の画面情報」を送る
function broadcast(room) {
  room.lastActive = Date.now();
  const game = games[room.gameId];
  // いま操作を待っている人（手番）。ゲームが turnOf を持っていれば使う
  let turnIds = [];
  if (room.state && typeof game.turnOf === 'function') {
    try {
      turnIds = game.turnOf(room.state) || [];
    } catch (e) {
      console.error(e);
    }
  }
  for (const p of room.players) {
    if (!p.socketId) continue;
    let view = null;
    if (room.state) {
      try {
        view = game.view(room.state, p.id);
      } catch (e) {
        console.error(e);
      }
    }
    io.to(p.socketId).emit('room:update', {
      code: room.code,
      gameId: room.gameId,
      gameName: game.name,
      minPlayers: game.minPlayers,
      maxPlayers: game.maxPlayers,
      hostId: room.hostId,
      phase: room.phase, // 'lobby' | 'playing' | 'finished'
      players: publicPlayers(room),
      you: p.id,
      notice: room.notice || null,
      view,
      turnIds,
      yourTurn: turnIds.includes(p.id) && room.phase === 'playing',
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
    if (game.isOver(room.state)) room.phase = 'finished';
    broadcast(room);
  }
}

function findBySocket(socket) {
  const code = socket.data.roomCode;
  if (!code) return {};
  const room = rooms.get(code);
  if (!room) return {};
  const player = room.players.find(p => p.id === socket.data.playerId);
  return { room, player };
}

function attach(socket, room, player) {
  player.socketId = socket.id;
  player.connected = true;
  socket.data.roomCode = room.code;
  socket.data.playerId = player.id;
  socket.join(room.code);
}

function removePlayer(room, playerId) {
  const player = room.players.find(p => p.id === playerId);
  if (!player) return;

  if (room.phase === 'playing') {
    // ゲームが「途中離脱」に対応していればそれを使う。なければロビーに戻す
    const game = games[room.gameId];
    if (typeof game.onLeave === 'function' && game.onLeave(room.state, playerId) !== false) {
      room.notice = `${player.name} さんが抜けました`;
    } else {
      room.phase = 'lobby';
      room.state = null;
      room.notice = `${player.name} さんが抜けたため、ゲームを終了しました`;
    }
  } else {
    room.notice = `${player.name} さんが退出しました`;
  }

  room.players = room.players.filter(p => p.id !== playerId);
  if (room.players.length === 0) {
    rooms.delete(room.code);
    return;
  }
  if (room.hostId === playerId) room.hostId = room.players[0].id;
  if (room.phase === 'playing' && games[room.gameId].isOver(room.state)) room.phase = 'finished';
  broadcast(room);
}

io.on('connection', socket => {
  // ルーム作成
  socket.on('room:create', ({ name, gameId } = {}, cb = () => {}) => {
    const game = games[gameId];
    if (!game) return cb({ error: 'そのゲームはありません' });
    leaveCurrent(socket);
    const player = { id: crypto.randomUUID(), token: crypto.randomUUID(), name: cleanName(name) };
    const room = {
      code: newRoomCode(),
      gameId,
      hostId: player.id,
      players: [player],
      phase: 'lobby',
      state: null,
      lastActive: Date.now(),
    };
    rooms.set(room.code, room);
    attach(socket, room, player);
    cb({ ok: true, code: room.code, token: player.token });
    broadcast(room);
  });

  // ルーム参加
  socket.on('room:join', ({ name, code } = {}, cb = () => {}) => {
    const room = rooms.get(String(code || '').trim().toUpperCase());
    if (!room) return cb({ error: 'ルームが見つかりません。コードを確認してください' });
    const game = games[room.gameId];
    if (room.phase !== 'lobby') return cb({ error: 'ゲームが始まっているので入れません' });
    if (room.players.length >= game.maxPlayers) return cb({ error: `満員です（最大${game.maxPlayers}人）` });
    leaveCurrent(socket);
    const player = { id: crypto.randomUUID(), token: crypto.randomUUID(), name: cleanName(name) };
    room.players.push(player);
    attach(socket, room, player);
    room.notice = `${player.name} さんが参加しました`;
    cb({ ok: true, code: room.code, token: player.token });
    broadcast(room);
  });

  // 再接続（リロード・スマホのスリープ復帰など）
  socket.on('room:rejoin', ({ code, token } = {}, cb = () => {}) => {
    const room = rooms.get(code);
    const player = room && room.players.find(p => p.token === token);
    if (!player) return cb({ error: 'expired' });
    if (player.socketId && player.socketId !== socket.id) {
      io.sockets.sockets.get(player.socketId)?.disconnect(true); // 古いタブは切断
    }
    attach(socket, room, player);
    cb({ ok: true, code: room.code, token: player.token });
    broadcast(room);
    notifyConnectionChange(room); // 再接続をゲームに知らせる
  });

  socket.on('room:leave', (_ = {}, cb = () => {}) => {
    leaveCurrent(socket);
    cb({ ok: true });
  });

  // ホストがゲーム開始
  socket.on('game:start', (_ = {}, cb = () => {}) => {
    const { room, player } = findBySocket(socket);
    if (!room) return cb({ error: 'ルームにいません' });
    if (room.hostId !== player.id) return cb({ error: 'ホストだけが開始できます' });
    if (room.phase === 'playing') return cb({ error: 'すでに始まっています' });
    const game = games[room.gameId];
    if (room.players.length < game.minPlayers) return cb({ error: `${game.minPlayers}人以上必要です` });
    room.state = game.setup(room.players.map(p => ({ id: p.id, name: p.name })));
    room.phase = game.isOver(room.state) ? 'finished' : 'playing';
    cb({ ok: true });
    broadcast(room);
  });

  // ゲーム中の操作。中身の判定はすべて各ゲームの action() に任せる
  socket.on('game:action', (action = {}, cb = () => {}) => {
    const { room, player } = findBySocket(socket);
    if (!room || room.phase !== 'playing') return cb({ error: 'ゲーム中ではありません' });
    const game = games[room.gameId];
    let result;
    try {
      result = game.action(room.state, player.id, action, roomInfo(room));
    } catch (e) {
      console.error(e);
      return cb({ error: 'エラーが起きました' });
    }
    if (result && result.error) return cb({ error: result.error });
    if (game.isOver(room.state)) room.phase = 'finished';
    cb({ ok: true });
    broadcast(room);
  });

  // ホストがロビーに戻す（もう一度遊ぶ）
  socket.on('game:lobby', (_ = {}, cb = () => {}) => {
    const { room, player } = findBySocket(socket);
    if (!room) return cb({ error: 'ルームにいません' });
    if (room.hostId !== player.id) return cb({ error: 'ホストだけが操作できます' });
    room.phase = 'lobby';
    room.state = null;
    cb({ ok: true });
    broadcast(room);
  });

  socket.on('disconnect', () => {
    const { room, player } = findBySocket(socket);
    if (!room || !player || player.socketId !== socket.id) return;
    player.connected = false;
    player.socketId = null;
    // ロビー中なら少し待って戻ってこなければ退出扱い
    if (room.phase === 'lobby') {
      setTimeout(() => {
        if (rooms.get(room.code) === room && !player.connected && room.phase === 'lobby') {
          removePlayer(room, player.id);
        }
      }, 60_000);
    }
    broadcast(room);
    notifyConnectionChange(room); // 切断をゲームに知らせる
  });

  function leaveCurrent(sock) {
    const { room, player } = findBySocket(sock);
    if (room && player) {
      sock.leave(room.code);
      removePlayer(room, player.id);
    }
    sock.data.roomCode = null;
    sock.data.playerId = null;
  }
});

// 誰もいない部屋を定期的に掃除（30分放置で削除）
setInterval(() => {
  const now = Date.now();
  for (const room of rooms.values()) {
    const anyone = room.players.some(p => p.connected);
    if (!anyone && now - room.lastActive > 30 * 60_000) rooms.delete(room.code);
  }
}, 5 * 60_000);

server.listen(PORT, () => console.log(`Game Hub 起動: http://localhost:${PORT}`));
