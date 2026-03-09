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
// const matchQueue = new Map(); // username -> { ws, timestamp } (不再使用)

// 匹配场次配置
const MATCH_MODES = {
  'novice': { name: '新手场', minScore: 500, baseScore: 5 },
  'normal': { name: '普通场', minScore: 2000, baseScore: 20 },
  'master': { name: '大师场', minScore: 3000, baseScore: 30 }
};

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
    case 'watch_ad_complete': handleWatchAdComplete(ws, data); break;
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
    password, avatarIdx, gold: 500,
    createdAt: Date.now(), totalGames: 0, totalWins: 0
  };
  saveData();

  clients.set(ws, { username, roomId: null });
  sendTo(ws, {
    type: 'login_ok',
    username,
    avatarIdx,
    gold: 500,
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

  const { maxPlayers, password, baseScore, arrangeTime, isMatchRoom } = data;
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
    gameData: null,
    isMatchRoom: isMatchRoom || false
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

  const isMatchRoom = room.isMatchRoom;

  room.players = room.players.filter(p => p.username !== info.username);

  if (room.players.length === 0) {
    delete db.rooms[info.roomId];
  } else if (room.createdBy === info.username) {
    room.createdBy = room.players[0].username;
  }

  // 如果是匹配房间，清理确认状态
  if (isMatchRoom && room.gameData && room.gameData.confirmedPlayers) {
    console.log(`匹配房间 ${room.roomId}: 玩家 ${info.username} 退出，清理确认状态`);

    // 从确认列表中移除离开的玩家
    room.gameData.confirmedPlayers = room.gameData.confirmedPlayers.filter(name => name !== info.username);

    // 如果确认列表为空，删除它
    if (room.gameData.confirmedPlayers.length === 0) {
      delete room.gameData.confirmedPlayers;
    }

    // 广播更新后的确认状态给剩余玩家
    if (room.players.length > 0) {
      const confirmMsg = {
        type: 'next_round_confirmed',
        confirmed: room.gameData.confirmedPlayers || [],
        total: room.players.length,
        playerLeft: info.username
      };
      for (const [clientWs, clientInfo] of clients) {
        if (clientInfo.roomId === room.roomId && clientWs.readyState === 1) {
          sendTo(clientWs, confirmMsg);
        }
      }
    }
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
  const deckSize = playerCount * 9 > 52 ? 54 : 52;
  const deck = shuffle(createDeck(deckSize));

  const hands = {};
  for (let i = 0; i < playerCount; i++) {
    const hand = deck.splice(0, 9);
    hand.sort((a, b) => cardValue(b) - cardValue(a) || cardSuitValue(b) - cardSuitValue(a));
    hands[room.players[i].username] = hand;
  }

  room.status = 'playing';
  room.deckSize = deckSize;
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
        arrangeTime: room.arrangeTime,
        isMatchRoom: room.isMatchRoom || false
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

  console.log(`handleStartNextRound: 玩家 ${info.username} 在房间 ${room.roomId}, 状态: ${room.status}, 是否匹配房间: ${room.isMatchRoom}, 金币更新: ${data.goldUpdate}`);

  // 更新金币
  if (data.goldUpdate !== undefined) {
    const user = db.users[info.username];
    if (user) {
      user.gold = data.goldUpdate;
      const rp = room.players.find(p => p.username === info.username);
      if (rp) rp.gold = data.goldUpdate;
    }
  }

  // 游戏结束后需要所有玩家确认才能开始下一局
  if (room.status === 'playing') {
    console.log(`房间 ${room.roomId}: 玩家 ${info.username} 确认下一局`);

    // 初始化确认玩家集合（使用数组以便序列化）
    if (!room.gameData.confirmedPlayers) {
      room.gameData.confirmedPlayers = [];
    }

    // 将当前玩家加入确认集合（如果尚未加入）
    if (!room.gameData.confirmedPlayers.includes(info.username)) {
      room.gameData.confirmedPlayers.push(info.username);
    }

    // 检查是否所有玩家都已确认
    const allConfirmed = room.players.every(p => room.gameData.confirmedPlayers.includes(p.username));

    // 向房间内所有玩家广播当前确认状态
    const confirmMsg = {
      type: 'next_round_confirmed',
      confirmed: room.gameData.confirmedPlayers,
      total: room.players.length
    };
    // 向房间内所有玩家发送确认状态
    for (const [clientWs, clientInfo] of clients) {
      if (clientInfo.roomId === room.roomId && clientWs.readyState === 1) {
        sendTo(clientWs, confirmMsg);
      }
    }

    if (allConfirmed) {
      console.log(`房间 ${room.roomId}: 所有玩家已确认，等待手动准备`);
      // 所有玩家都已确认，重置房间状态，但不自动准备，等待玩家手动准备
      const roundNum = room.gameData ? room.gameData.roundNum : 0;
      room.status = 'waiting';
      room.gameData = { roundNum };
      // 不自动设置玩家准备状态，等待玩家手动准备
      room.players.forEach(p => p.ready = false);

      // 清除确认集合
      delete room.gameData.confirmedPlayers;

      saveData();
      broadcastRoomState(info.roomId);

      // 发送最终确认消息，显示所有玩家已确认，但需要手动准备
      const finalConfirmMsg = {
        type: 'next_round_confirmed',
        confirmed: room.players.map(p => p.username),
        total: room.players.length,
        allConfirmed: true,
        needManualReady: true
      };
      for (const [clientWs, clientInfo] of clients) {
        if (clientInfo.roomId === room.roomId && clientWs.readyState === 1) {
          sendTo(clientWs, finalConfirmMsg);
        }
      }
      // 不再自动开始游戏，等待玩家手动准备
      console.log(`房间 ${room.roomId}: 所有玩家已确认，等待玩家手动准备`);
    } else {
      // 不是所有玩家都确认了，保存状态
      saveData();
      console.log(`房间 ${room.roomId}: 已确认玩家: ${room.gameData.confirmedPlayers.join(', ')} (${room.gameData.confirmedPlayers.length}/${room.players.length})`);
    }
    return;
  }

  // 如果房间状态不是playing（例如已经重置），仍然广播房间状态
  saveData();
  broadcastRoomState(info.roomId);
}

// ========== 匹配系统处理函数 ==========
function handleStartMatch(ws, data) {
  const info = clients.get(ws);
  if (!info || !info.username) return sendTo(ws, { type: 'error', msg: '请先登录' });

  // 检查用户是否已经在房间中
  if (info.roomId) {
    return sendTo(ws, { type: 'error', msg: '您已经在房间中，无法匹配' });
  }

  const username = info.username;
  const playerCount = data.playerCount || 2;
  const requestedMode = data.mode || 'novice'; // 默认新手场

  if (playerCount < 2 || playerCount > 6) {
    return sendTo(ws, { type: 'error', msg: '玩家人数必须在2-6人之间' });
  }

  // 获取用户分数（gold字段）
  const user = db.users[username];
  if (!user) return sendTo(ws, { type: 'error', msg: '用户数据错误' });

  const userScore = user.gold;

  // 检查分数是否足够，如果不够自动降级
  let actualMode = requestedMode;

  // 检查分数是否达到要求，如果不够则自动降级
  if (requestedMode === 'master' && userScore < MATCH_MODES.master.minScore) {
    actualMode = 'normal';
  }
  if (actualMode === 'normal' && userScore < MATCH_MODES.normal.minScore) {
    actualMode = 'novice';
  }
  if (actualMode === 'novice' && userScore < MATCH_MODES.novice.minScore) {
    // 分数连新手场都不够，提示看广告
    return sendTo(ws, {
      type: 'error',
      msg: '您的分数不足500分，无法进入新手场。请观看广告30秒获得500分',
      requiresAd: true
    });
  }

  const modeConfig = MATCH_MODES[actualMode];
  const baseScore = modeConfig.baseScore;

  // 查找合适的房间：状态为waiting，最大玩家人数匹配，场次匹配，且未满的房间
  let targetRoom = null;
  let maxPlayersInRoom = -1;

  for (const roomId in db.rooms) {
    const room = db.rooms[roomId];
    if (room.status === 'waiting' && room.maxPlayers === playerCount &&
        room.players.length < playerCount && room.isMatchRoom === true &&
        room.baseScore === baseScore) { // 通过baseScore来区分场次
      // 优先选择玩家人数最多的房间
      if (room.players.length > maxPlayersInRoom) {
        maxPlayersInRoom = room.players.length;
        targetRoom = room;
      }
    }
  }

  if (targetRoom) {
    // 加入现有房间
    targetRoom.players.push({
      username: username,
      avatarIdx: user.avatarIdx,
      gold: user.gold,
      ready: false
    });
    saveData();

    info.roomId = targetRoom.roomId;
    sendTo(ws, { type: 'match_started' });
    console.log(`用户 ${username} 加入${modeConfig.name}房间 ${targetRoom.roomId} (${targetRoom.players.length}/${playerCount})`);

    // 发送匹配成功消息
    sendTo(ws, {
      type: 'match_found',
      roomId: targetRoom.roomId,
      password: targetRoom.password,
      mode: actualMode,
      modeName: modeConfig.name,
      baseScore: baseScore,
      opponent: null // 多人房间，不单独指定对手
    });

    // 广播房间状态更新
    broadcastRoomState(targetRoom.roomId);

    // 检查房间是否已满，如果满员则不需要进一步处理，等待玩家准备
    if (targetRoom.players.length === playerCount) {
      console.log(`${modeConfig.name}房间 ${targetRoom.roomId} 已满员，等待玩家准备...`);
    }
  } else {
    // 创建新房间
    const roomId = String(100000 + Math.floor(Math.random() * 900000));
    const password = String(Math.floor(100000 + Math.random() * 900000)); // 6位数字密码
    const maxPlayers = playerCount;
    const arrangeTime = 60;
    const deckSize = maxPlayers * 9 > 52 ? 54 : 52;

    db.rooms[roomId] = {
      roomId, password,
      maxPlayers,
      baseScore,
      arrangeTime,
      deckSize,
      createdBy: username,
      status: 'waiting',
      players: [{
        username: username,
        avatarIdx: user.avatarIdx,
        gold: user.gold,
        ready: false
      }],
      gameData: null,
      isMatchRoom: true, // 标记为匹配房间
      matchMode: actualMode // 存储匹配场次
    };
    saveData();

    info.roomId = roomId;
    sendTo(ws, { type: 'match_started' });
    console.log(`用户 ${username} 创建${modeConfig.name}房间 ${roomId} (1/${playerCount})`);

    // 发送匹配成功消息
    sendTo(ws, {
      type: 'match_found',
      roomId,
      password,
      mode: actualMode,
      modeName: modeConfig.name,
      baseScore: baseScore,
      opponent: null
    });

    // 广播房间状态
    broadcastRoomState(roomId);
  }
}

function handleCancelMatch(ws, data) {
  const info = clients.get(ws);
  if (!info || !info.username) return;

  // 如果用户在房间中，离开房间
  if (info.roomId) {
    const room = db.rooms[info.roomId];
    if (room) {
      // 从房间中移除玩家
      room.players = room.players.filter(p => p.username !== info.username);

      if (room.players.length === 0) {
        // 房间为空，删除房间
        delete db.rooms[info.roomId];
        console.log(`匹配房间 ${info.roomId} 已被取消`);
      } else if (room.createdBy === info.username) {
        // 房主离开，转移房主
        room.createdBy = room.players[0].username;
      }
      saveData();

      // 广播房间状态更新
      broadcastRoomState(info.roomId);
    }

    // 清除用户的房间信息
    info.roomId = null;
  }

  sendTo(ws, { type: 'match_cancelled' });
  console.log(`用户 ${info.username} 取消匹配`);
}

function handleWatchAdComplete(ws, data) {
  const info = clients.get(ws);
  if (!info || !info.username) return sendTo(ws, { type: 'error', msg: '请先登录' });

  const username = info.username;
  const user = db.users[username];
  if (!user) return sendTo(ws, { type: 'error', msg: '用户数据错误' });

  // 增加500分
  user.gold += 500;
  saveData();

  sendTo(ws, {
    type: 'ad_reward',
    gold: user.gold,
    added: 500,
    msg: '观看广告完成，获得500分'
  });

  console.log(`用户 ${username} 观看广告完成，获得500分，当前分数: ${user.gold}`);
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
        const isMatchRoom = room.isMatchRoom;

        room.players = room.players.filter(p => p.username !== info.username);

        if (room.players.length === 0) {
          delete db.rooms[info.roomId];
        } else if (room.createdBy === info.username) {
          room.createdBy = room.players[0].username;
        }

        // 如果是匹配房间，清理确认状态
        if (isMatchRoom && room.gameData && room.gameData.confirmedPlayers) {
          // 从确认列表中移除断线的玩家
          room.gameData.confirmedPlayers = room.gameData.confirmedPlayers.filter(name => name !== info.username);

          // 如果还有玩家，检查是否可以开始游戏
          if (room.players.length >= 2) {
            const allConfirmed = room.players.every(p => room.gameData.confirmedPlayers.includes(p.username));
            if (allConfirmed) {
              // 所有剩余玩家都已确认，开始下一局
              const roundNum = room.gameData ? room.gameData.roundNum : 0;
              room.status = 'waiting';
              room.gameData = { roundNum };
              room.players.forEach(p => p.ready = true);
              delete room.gameData.confirmedPlayers;
            }
          }
        }

        saveData();
        broadcastRoomState(info.roomId);
      }
    }

    // 注意：matchQueue已不再使用，新的匹配系统基于房间状态

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
