const http = require('http');
const fs = require('fs');
const path = require('path');
const { WebSocketServer } = require('ws');

const PORT = process.env.PORT || 3000;

// ========== 数据存储 ==========
const DATA_FILE = path.join(__dirname, 'data.json');

let db = {
  users: {},   // username -> { password, avatarIdx, gold, createdAt, totalGames, totalWins }
  rooms: {}    // roomId -> { roomId, password, maxPlayers, baseScore, arrangeTime, deckSize, createdBy, status, players: [...], gameData }
};

function loadData() {
  try {
    if (fs.existsSync(DATA_FILE)) {
      db = JSON.parse(fs.readFileSync(DATA_FILE, 'utf8'));
    }
  } catch (e) { console.log('Load data error:', e.message); }
}

function saveData() {
  try {
    // 排除不可序列化的字段(_timer等)
    const json = JSON.stringify(db, (key, value) => {
      if (key === '_timer') return undefined;
      return value;
    }, 2);
    fs.writeFileSync(DATA_FILE, json, 'utf8');
  } catch (e) { console.log('Save data error:', e.message); }
}

loadData();

// ========== 在线连接管理 ==========
const clients = new Map(); // ws -> { username }

// ========== 匹配系统 ==========
const matchQueue = new Map(); // username -> { ws, timestamp }

function broadcast(roomId, msg, excludeUser) {
  const room = db.rooms[roomId];
  if (!room) return;
  const data = JSON.stringify(msg);
  for (const [ws, info] of clients) {
    if (info.roomId === roomId && info.username !== excludeUser && ws.readyState === 1) {
      ws.send(data);
    }
  }
}

function sendTo(ws, msg) {
  if (ws.readyState === 1) ws.send(JSON.stringify(msg));
}

function broadcastRoomState(roomId) {
  const room = db.rooms[roomId];
  if (!room) return;
  const safeRoom = {
    roomId: room.roomId,
    password: room.password,
    maxPlayers: room.maxPlayers,
    baseScore: room.baseScore,
    arrangeTime: room.arrangeTime,
    deckSize: room.deckSize,
    createdBy: room.createdBy,
    status: room.status,
    players: room.players.map(p => ({
      username: p.username,
      avatarIdx: p.avatarIdx,
      gold: p.gold,
      ready: p.ready
    }))
  };
  const data = JSON.stringify({ type: 'room_state', room: safeRoom });
  for (const [ws, info] of clients) {
    if (info.roomId === roomId && ws.readyState === 1) {
      ws.send(data);
    }
  }
}

// ========== 牌组逻辑(服务端发牌) ==========
const SUITS = ['spade', 'heart', 'club', 'diamond'];
const RANK_NAMES = ['2','3','4','5','6','7','8','9','10','J','Q','K','A'];

function createDeck(size) {
  const deck = [];
  for (const suit of SUITS) {
    for (const rank of RANK_NAMES) {
      deck.push({ suit, rank, isJoker: false });
    }
  }
  if (size === 54) {
    deck.push({ suit: 'joker', rank: 'small', isJoker: true, jokerType: 'small' });
    deck.push({ suit: 'joker', rank: 'big', isJoker: true, jokerType: 'big' });
  }
  return deck;
}

function shuffle(arr) {
  for (let i = arr.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [arr[i], arr[j]] = [arr[j], arr[i]];
  }
  return arr;
}

const RANK_ORDER = { '2': 2, '3': 3, '4': 4, '5': 5, '6': 6, '7': 7, '8': 8, '9': 9, '10': 10, 'J': 11, 'Q': 12, 'K': 13, 'A': 14 };
const SUIT_ORDER = { spade: 4, heart: 3, club: 2, diamond: 1 };

function cardValue(card) {
  if (card.isJoker) return card.jokerType === 'big' ? 16 : 15;
  return RANK_ORDER[card.rank];
}

function cardSuitValue(card) {
  if (card.isJoker) return card.jokerType === 'big' ? 6 : 5;
  return SUIT_ORDER[card.suit];
}

// ========== WebSocket 消息处理 ==========
function handleMessage(ws, msg) {
  let data;
  try { data = JSON.parse(msg); } catch (e) { return; }

  switch (data.type) {
    case 'register': handleRegister(ws, data); break;
    case 'login': handleLogin(ws, data); break;
    case 'create_room': handleCreateRoom(ws, data); break;
    case 'join_room': handleJoinRoom(ws, data); break;
    case 'leave_room': handleLeaveRoom(ws, data); break;
    case 'toggle_ready': handleToggleReady(ws, data); break;
    case 'submit_arrange': handleSubmitArrange(ws, data); break;
    case 'start_next_round': handleStartNextRound(ws, data); break;
    case 'start_match': handleStartMatch(ws, data); break;
    case 'cancel_match': handleCancelMatch(ws, data); break;
  }
}

function handleRegister(ws, data) {
  const { username, password } = data;
  if (!username || !password) return sendTo(ws, { type: 'error', msg: '请输入用户名和密码' });
  if (username.length < 2) return sendTo(ws, { type: 'error', msg: '用户名至少2个字符' });
  if (password.length < 3) return sendTo(ws, { type: 'error', msg: '密码至少3个字符' });
  if (db.users[username]) return sendTo(ws, { type: 'error', msg: '用户名已存在' });

  const avatarIdx = Math.floor(Math.random() * 6);
  db.users[username] = {
    password, avatarIdx, gold: 5000,
    createdAt: Date.now(), totalGames: 0, totalWins: 0
  };
  saveData();

  clients.set(ws, { username, roomId: null });
  sendTo(ws, {
    type: 'login_ok',
    username,
    avatarIdx,
    gold: 5000,
    isNew: true
  });
}

function handleLogin(ws, data) {
  const { username, password } = data;
  if (!username || !password) return sendTo(ws, { type: 'error', msg: '请输入用户名和密码' });
  const user = db.users[username];
  if (!user) return sendTo(ws, { type: 'error', msg: '用户不存在' });
  if (user.password !== password) return sendTo(ws, { type: 'error', msg: '密码错误' });

  clients.set(ws, { username, roomId: null });
  sendTo(ws, {
    type: 'login_ok',
    username,
    avatarIdx: user.avatarIdx,
    gold: user.gold,
    isNew: false
  });
}

function handleCreateRoom(ws, data) {
  const info = clients.get(ws);
  if (!info || !info.username) return sendTo(ws, { type: 'error', msg: '请先登录' });

  const { maxPlayers, password, baseScore, arrangeTime } = data;
  if (!password) return sendTo(ws, { type: 'error', msg: '请设置房间密码' });

  const roomId = String(100000 + Math.floor(Math.random() * 900000));
  const user = db.users[info.username];
  const deckSize = maxPlayers * 9 > 52 ? 54 : 52;

  db.rooms[roomId] = {
    roomId, password,
    maxPlayers: maxPlayers || 2,
    baseScore: baseScore || 5,
    arrangeTime: arrangeTime || 60,
    deckSize,
    createdBy: info.username,
    status: 'waiting',
    players: [{
      username: info.username,
      avatarIdx: user.avatarIdx,
      gold: user.gold,
      ready: false
    }],
    gameData: null
  };
  saveData();

  info.roomId = roomId;
  sendTo(ws, { type: 'room_created', roomId });
  broadcastRoomState(roomId);
}

function handleJoinRoom(ws, data) {
  const info = clients.get(ws);
  if (!info || !info.username) return sendTo(ws, { type: 'error', msg: '请先登录' });

  const { roomId, password } = data;
  const room = db.rooms[roomId];
  if (!room) return sendTo(ws, { type: 'error', msg: '房间不存在' });
  if (room.password !== password) return sendTo(ws, { type: 'error', msg: '密码错误' });
  if (room.status !== 'waiting') return sendTo(ws, { type: 'error', msg: '游戏已开始，无法加入' });

  // 检查是否已在房间
  const existing = room.players.find(p => p.username === info.username);
  if (existing) {
    info.roomId = roomId;
    sendTo(ws, { type: 'room_joined', roomId });
    broadcastRoomState(roomId);
    return;
  }

  if (room.players.length >= room.maxPlayers) {
    return sendTo(ws, { type: 'error', msg: '玩家已满，无法加入' });
  }

  const user = db.users[info.username];
  room.players.push({
    username: info.username,
    avatarIdx: user.avatarIdx,
    gold: user.gold,
    ready: false
  });
  saveData();

  info.roomId = roomId;
  sendTo(ws, { type: 'room_joined', roomId });
  broadcastRoomState(roomId);
}

function handleLeaveRoom(ws, data) {
  const info = clients.get(ws);
  if (!info || !info.roomId) return;

  const room = db.rooms[info.roomId];
  if (!room) { info.roomId = null; return; }

  room.players = room.players.filter(p => p.username !== info.username);

  if (room.players.length === 0) {
    delete db.rooms[info.roomId];
  } else if (room.createdBy === info.username) {
    room.createdBy = room.players[0].username;
  }
  saveData();

  const oldRoomId = info.roomId;
  info.roomId = null;
  sendTo(ws, { type: 'left_room' });
  broadcastRoomState(oldRoomId);
}

function handleToggleReady(ws, data) {
  const info = clients.get(ws);
  if (!info || !info.roomId) return;

  const room = db.rooms[info.roomId];
  if (!room || room.status !== 'waiting') return;

  const me = room.players.find(p => p.username === info.username);
  if (!me) return;
  me.ready = !me.ready;
  saveData();

  broadcastRoomState(info.roomId);

  // 检查是否所有人准备好
  if (room.players.length >= 2 && room.players.every(p => p.ready)) {
    setTimeout(() => startGame(info.roomId), 1500);
  }
}

function startGame(roomId) {
  const room = db.rooms[roomId];
  if (!room || room.status !== 'waiting') return;
  if (!room.players.every(p => p.ready)) return;

  const playerCount = room.players.length;
  const deckSize = playerCount * 9 > 52 ? 54 : room.deckSize;
  const deck = shuffle(createDeck(deckSize));

  const hands = {};
  for (let i = 0; i < playerCount; i++) {
    const hand = deck.splice(0, 9);
    hand.sort((a, b) => cardValue(b) - cardValue(a) || cardSuitValue(b) - cardSuitValue(a));
    hands[room.players[i].username] = hand;
  }

  room.status = 'playing';
  room.gameData = {
    roundNum: (room.gameData ? (room.gameData.roundNum || 0) : 0) + 1,
    baseScore: room.baseScore,
    arrangeTime: room.arrangeTime,
    deckSize,
    hands,
    arranged: {},
    phase: 'arrange',
    startTime: Date.now()
  };
  saveData();

  // 给每个玩家发送自己的手牌
  for (const [ws, info] of clients) {
    if (info.roomId === roomId && ws.readyState === 1) {
      const hand = hands[info.username] || [];
      sendTo(ws, {
        type: 'game_start',
        hand,
        players: room.players.map(p => ({
          username: p.username,
          avatarIdx: p.avatarIdx,
          gold: p.gold
        })),
        roundNum: room.gameData.roundNum,
        baseScore: room.baseScore,
        arrangeTime: room.arrangeTime
      });
    }
  }

  // 摆牌超时计时器
  room.gameData._timer = setTimeout(() => {
    forceFinishArrange(roomId);
  }, (room.arrangeTime + 5) * 1000);
}

function handleSubmitArrange(ws, data) {
  const info = clients.get(ws);
  if (!info || !info.roomId) return;

  const room = db.rooms[info.roomId];
  if (!room || !room.gameData || room.gameData.phase !== 'arrange') return;

  const { head, mid, tail } = data;
  if (!head || !mid || !tail) return;
  if (head.length !== 3 || mid.length !== 3 || tail.length !== 3) return;

  room.gameData.arranged[info.username] = { head, mid, tail };
  saveData();

  // 通知其他人该玩家已摆牌
  broadcast(info.roomId, {
    type: 'player_arranged',
    username: info.username
  });

  sendTo(ws, { type: 'arrange_ok' });

  // 检查所有人是否都摆好了
  const allArranged = room.players.every(p => room.gameData.arranged[p.username]);
  if (allArranged) {
    finishArrange(info.roomId);
  }
}

function forceFinishArrange(roomId) {
  const room = db.rooms[roomId];
  if (!room || !room.gameData || room.gameData.phase !== 'arrange') return;

  // 未摆牌的玩家自动随机摆牌
  for (const p of room.players) {
    if (!room.gameData.arranged[p.username]) {
      const hand = room.gameData.hands[p.username];
      if (hand) {
        room.gameData.arranged[p.username] = {
          head: hand.slice(0, 3),
          mid: hand.slice(3, 6),
          tail: hand.slice(6, 9)
        };
      }
    }
  }
  saveData();
  finishArrange(roomId);
}

function finishArrange(roomId) {
  const room = db.rooms[roomId];
  if (!room || !room.gameData) return;

  if (room.gameData._timer) {
    clearTimeout(room.gameData._timer);
    room.gameData._timer = null;
  }

  room.gameData.phase = 'reveal';

  // 发送所有玩家的摆牌结果给所有人
  const allArranged = {};
  const allHands = {};
  for (const p of room.players) {
    allArranged[p.username] = room.gameData.arranged[p.username];
    allHands[p.username] = room.gameData.hands[p.username];
  }

  const msg = {
    type: 'all_arranged',
    arranged: allArranged,
    hands: allHands,
    players: room.players.map(p => ({
      username: p.username,
      avatarIdx: p.avatarIdx,
      gold: p.gold
    }))
  };

  for (const [ws, info] of clients) {
    if (info.roomId === roomId && ws.readyState === 1) {
      sendTo(ws, msg);
    }
  }
  saveData();
}

function handleStartNextRound(ws, data) {
  const info = clients.get(ws);
  if (!info || !info.roomId) return;

  const room = db.rooms[info.roomId];
  if (!room) return;

  // 更新金币
  if (data.goldUpdate !== undefined) {
    const user = db.users[info.username];
    if (user) {
      user.gold = data.goldUpdate;
      const rp = room.players.find(p => p.username === info.username);
      if (rp) rp.gold = data.goldUpdate;
    }
  }

  // 只在第一个人返回时重置房间状态
  if (room.status === 'playing') {
    const roundNum = room.gameData ? room.gameData.roundNum : 0;
    room.status = 'waiting';
    room.gameData = { roundNum };
    room.players.forEach(p => p.ready = false);
  }
  saveData();

  broadcastRoomState(info.roomId);
}

// ========== 匹配系统处理函数 ==========
function handleStartMatch(ws, data) {
  const info = clients.get(ws);
  if (!info || !info.username) return sendTo(ws, { type: 'error', msg: '请先登录' });

  const username = info.username;

  // 检查用户是否已经在匹配队列中
  if (matchQueue.has(username)) {
    return sendTo(ws, { type: 'error', msg: '您已经在匹配队列中' });
  }

  // 检查用户是否已经在房间中
  if (info.roomId) {
    return sendTo(ws, { type: 'error', msg: '您已经在房间中，无法匹配' });
  }

  // 加入匹配队列
  matchQueue.set(username, { ws, timestamp: Date.now() });
  sendTo(ws, { type: 'match_started' });
  console.log(`用户 ${username} 开始匹配`);

  // 尝试匹配
  tryMatch();
}

function handleCancelMatch(ws, data) {
  const info = clients.get(ws);
  if (!info || !info.username) return;

  const username = info.username;
  if (matchQueue.has(username)) {
    matchQueue.delete(username);
    sendTo(ws, { type: 'match_cancelled' });
    console.log(`用户 ${username} 取消匹配`);
  }
}

function tryMatch() {
  // 需要至少2人才能匹配
  if (matchQueue.size < 2) return;

  // 获取前两个等待的用户
  const entries = Array.from(matchQueue.entries());
  const [user1, user2] = entries.slice(0, 2);
  const [username1, data1] = user1;
  const [username2, data2] = user2;

  // 从队列中移除
  matchQueue.delete(username1);
  matchQueue.delete(username2);

  // 检查用户是否仍然在线且不在房间中
  const info1 = clients.get(data1.ws);
  const info2 = clients.get(data2.ws);

  if (!info1 || !info2 || info1.roomId || info2.roomId) {
    // 如果有用户已不在线或已在房间中，重新尝试匹配其他用户
    if (info1 && !info1.roomId) matchQueue.set(username1, data1);
    if (info2 && !info2.roomId) matchQueue.set(username2, data2);
    return;
  }

  // 创建房间
  const roomId = String(100000 + Math.floor(Math.random() * 900000));
  const password = String(Math.floor(100000 + Math.random() * 900000)); // 6位数字密码
  const maxPlayers = 2;
  const baseScore = 5;
  const arrangeTime = 60;
  const deckSize = maxPlayers * 9 > 52 ? 54 : 52;

  const userData1 = db.users[username1];
  const userData2 = db.users[username2];

  db.rooms[roomId] = {
    roomId, password,
    maxPlayers,
    baseScore,
    arrangeTime,
    deckSize,
    createdBy: username1,
    status: 'waiting',
    players: [
      {
        username: username1,
        avatarIdx: userData1.avatarIdx,
        gold: userData1.gold,
        ready: false
      },
      {
        username: username2,
        avatarIdx: userData2.avatarIdx,
        gold: userData2.gold,
        ready: false
      }
    ],
    gameData: null
  };
  saveData();

  // 更新用户房间信息
  info1.roomId = roomId;
  info2.roomId = roomId;

  // 通知用户匹配成功
  const matchSuccessMsg = {
    type: 'match_found',
    roomId,
    password,
    opponent: {
      username: username2,
      avatarIdx: userData2.avatarIdx,
      gold: userData2.gold
    }
  };
  sendTo(data1.ws, matchSuccessMsg);

  const matchSuccessMsg2 = {
    type: 'match_found',
    roomId,
    password,
    opponent: {
      username: username1,
      avatarIdx: userData1.avatarIdx,
      gold: userData1.gold
    }
  };
  sendTo(data2.ws, matchSuccessMsg2);

  console.log(`匹配成功: ${username1} 和 ${username2} 进入房间 ${roomId}`);

  // 广播房间状态
  broadcastRoomState(roomId);
}

// ========== HTTP 静态文件服务 ==========
const MIME_TYPES = {
  '.html': 'text/html',
  '.js': 'text/javascript',
  '.css': 'text/css',
  '.json': 'application/json',
  '.png': 'image/png',
  '.ico': 'image/x-icon'
};

const server = http.createServer((req, res) => {
  let filePath = req.url === '/' ? '/index.html' : req.url;
  filePath = path.join(__dirname, 'public', filePath);

  const ext = path.extname(filePath);
  const contentType = MIME_TYPES[ext] || 'application/octet-stream';

  fs.readFile(filePath, (err, data) => {
    if (err) {
      res.writeHead(404);
      res.end('Not Found');
      return;
    }
    res.writeHead(200, { 'Content-Type': contentType + '; charset=utf-8' });
    res.end(data);
  });
});

// ========== WebSocket 服务 ==========
const wss = new WebSocketServer({ server });

wss.on('connection', (ws) => {
  clients.set(ws, { username: null, roomId: null });

  ws.on('message', (msg) => handleMessage(ws, msg.toString()));

  ws.on('close', () => {
    const info = clients.get(ws);
    if (info && info.roomId) {
      // 玩家断线，从房间移除
      const room = db.rooms[info.roomId];
      if (room) {
        room.players = room.players.filter(p => p.username !== info.username);
        if (room.players.length === 0) {
          delete db.rooms[info.roomId];
        } else if (room.createdBy === info.username) {
          room.createdBy = room.players[0].username;
        }
        saveData();
        broadcastRoomState(info.roomId);
      }
    }

    // 从匹配队列中移除
    if (info && info.username && matchQueue.has(info.username)) {
      matchQueue.delete(info.username);
      console.log(`用户 ${info.username} 断开连接，已从匹配队列移除`);
    }

    clients.delete(ws);
  });
});

server.listen(PORT, '0.0.0.0', () => {
  console.log(`========================================`);
  console.log(`  比鸡服务器已启动!`);
  console.log(`  本机访问: http://localhost:${PORT}`);
  // 获取局域网IP
  const os = require('os');
  const nets = os.networkInterfaces();
  for (const name of Object.keys(nets)) {
    for (const net of nets[name]) {
      if (net.family === 'IPv4' && !net.internal) {
        console.log(`  局域网访问: http://${net.address}:${PORT}`);
      }
    }
  }
  console.log(`========================================`);
});
