const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const path = require('path');

const app = express();
const server = http.createServer(app);
const io = new Server(server);

app.use(express.static(path.join(__dirname, 'public')));

// ---------- Live chat bridge (YouTube -> games) ----------
const { startYouTubeChat } = require('./youtube-chat');
const chatStatus = { source: 'none', state: 'off', messages: 0, likes: null, videoId: null, error: null };

function broadcastChat(user, text) {
  user = String(user || '').slice(0, 40); text = String(text || '').slice(0, 200);
  if (!user || !text) return;
  chatStatus.messages++;
  io.emit('chat', { user, text });
  io.emit('orbitChat', { user, text });   // older event name used by Orbit Royale
}

if (process.env.YT_API_KEY && (process.env.YT_VIDEO_ID || process.env.YT_CHANNEL_ID)) {
  chatStatus.source = 'youtube';
  startYouTubeChat({
    apiKey: process.env.YT_API_KEY,
    videoId: process.env.YT_VIDEO_ID,
    channelId: process.env.YT_CHANNEL_ID,
    pollMs: Number(process.env.YT_POLL_MS) || 10000,
    onMessage: ({ user, text }) => broadcastChat(user, text),
    onLikes: (n) => { chatStatus.likes = n; io.emit('likes', n); },
    onStatus: (s) => {
      Object.assign(chatStatus, { state: s.state, error: s.error || null });
      if (s.videoId) chatStatus.videoId = s.videoId;
      console.log(`[youtube chat] ${s.state}${s.videoId ? ' ' + s.videoId : ''}${s.error ? ': ' + s.error : ''}`);
    }
  });
} else {
  console.log('[youtube chat] off: set YT_API_KEY and YT_VIDEO_ID or YT_CHANNEL_ID to connect (see STREAMING.md)');
}

const isLocal = (req) => ['127.0.0.1', '::1', '::ffff:127.0.0.1'].includes(req.socket.remoteAddress);
app.get('/api/chat/status', (req, res) => res.json(chatStatus));
// Send a fake chat message for testing, e.g. curl -X POST localhost:3000/api/chat -H 'content-type: application/json' -d '{"user":"me","text":"Brazil"}'
app.post('/api/chat', express.json(), (req, res) => {
  if (!isLocal(req)) return res.status(403).json({ error: 'only allowed from this computer' });
  broadcastChat(req.body && req.body.user, req.body && req.body.text);
  res.json({ ok: true });
});
app.post('/api/likes', express.json(), (req, res) => {
  if (!isLocal(req)) return res.status(403).json({ error: 'only allowed from this computer' });
  chatStatus.likes = Number(req.body && req.body.likes) || 0; io.emit('likes', chatStatus.likes);
  res.json({ ok: true });
});
io.on('connection', (socket) => { if (chatStatus.likes !== null) socket.emit('likes', chatStatus.likes); });

const rooms = {};
const matchHistory = [];
const MOVE_TIMEOUT_SECONDS = 15;

const WINNING_COMBOS = [
  [0, 1, 2], [3, 4, 5], [6, 7, 8],
  [0, 3, 6], [1, 4, 7], [2, 5, 8],
  [0, 4, 8], [2, 4, 6]
];

function checkWinner(board) {
  for (const combo of WINNING_COMBOS) {
    const [a, b, c] = combo;
    if (board[a] && board[a] === board[b] && board[a] === board[c]) {
      return { winnerSymbol: board[a], combo };
    }
  }
  if (board.every(cell => cell !== null)) {
    return { winnerSymbol: 'draw' };
  }
  return null;
}

function startMoveTimer(code) {
  const room = rooms[code];
  if (!room) return;

  if (room.timer) clearInterval(room.timer);

  room.timeLeft = MOVE_TIMEOUT_SECONDS;
  io.to(code).emit('timerTick', { timeLeft: room.timeLeft });

  room.timer = setInterval(() => {
    if (!rooms[code]) return;
    room.timeLeft--;
    io.to(code).emit('timerTick', { timeLeft: room.timeLeft });

    if (room.timeLeft <= 0) {
      clearInterval(room.timer);
      handleTimeout(code);
    }
  }, 1000);
}

function handleTimeout(code) {
  const room = rooms[code];
  if (!room || room.gameOver) return;

  room.gameOver = true;
  const timedOutPlayer = room.players.find(p => p.symbol === room.turn);
  const winnerPlayer = room.players.find(p => p.symbol !== room.turn);

  const timestamp = new Date().toLocaleTimeString();
  const outcomeText = `${winnerPlayer.name} (${winnerPlayer.symbol}) [Timeout]`;

  console.log('====================================');
  console.log(`[GAME OVER - TIMEOUT] Room: ${code}`);
  console.log(`${timedOutPlayer.name} ran out of time!`);
  console.log(`Winner: ${winnerPlayer.name} (${winnerPlayer.symbol})`);
  console.log(`Time: ${timestamp}`);
  console.log('====================================');

  matchHistory.unshift({
    roomCode: code,
    player1: `${room.players[0].name} (${room.players[0].symbol})`,
    player2: `${room.players[1].name} (${room.players[1].symbol})`,
    winner: `${winnerPlayer.name} (Timeout)`,
    time: timestamp
  });

  io.to(code).emit('gameOver', {
    winnerSymbol: winnerPlayer.symbol,
    winnerName: winnerPlayer.name,
    reason: 'timeout',
    timedOutName: timedOutPlayer.name
  });

  delete rooms[code];
  io.in(code).socketsLeave(code);
}

// Admin Dashboard Routes
app.get('/admin', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'admin.html'));
});

app.get('/api/matches', (req, res) => {
  res.json(matchHistory);
});

io.on('connection', (socket) => {
  socket.on('joinRoom', ({ name, roomCode }) => {
    const code = roomCode.trim().toUpperCase();
    const playerName = name.trim() || 'Player';

    if (!rooms[code]) {
      rooms[code] = {
        players: [],
        board: Array(9).fill(null),
        turn: 'X',
        gameOver: false,
        timer: null,
        timeLeft: MOVE_TIMEOUT_SECONDS
      };
    }

    const room = rooms[code];

    if (room.players.length >= 2) {
      socket.emit('errorMsg', 'Room is already full or match has completed.');
      return;
    }

    socket.join(code);
    socket.roomCode = code;

    const symbol = room.players.length === 0 ? (Math.random() < 0.5 ? 'X' : 'O') : (room.players[0].symbol === 'X' ? 'O' : 'X');
    
    room.players.push({
      id: socket.id,
      name: playerName,
      symbol: symbol
    });

    socket.emit('joined', { symbol, playerName, roomCode: code });

    if (room.players.length === 2) {
      io.to(code).emit('gameStart', {
        players: room.players,
        turn: room.turn,
        board: room.board
      });
      startMoveTimer(code);
    } else {
      socket.emit('waitingForOpponent');
    }
  });

  socket.on('makeMove', ({ index }) => {
    const code = socket.roomCode;
    const room = rooms[code];

    if (!room || room.gameOver || room.players.length < 2) return;

    const player = room.players.find(p => p.id === socket.id);
    if (!player || player.symbol !== room.turn || room.board[index] !== null) return;

    room.board[index] = player.symbol;
    const result = checkWinner(room.board);

    if (result) {
      room.gameOver = true;
      if (room.timer) clearInterval(room.timer);

      let winnerName = null;
      if (result.winnerSymbol !== 'draw') {
        const winningPlayer = room.players.find(p => p.symbol === result.winnerSymbol);
        winnerName = winningPlayer ? winningPlayer.name : result.winnerSymbol;
      }

      const p1 = room.players[0];
      const p2 = room.players[1];
      const outcomeText = result.winnerSymbol === 'draw' ? 'Draw' : `${winnerName} (${result.winnerSymbol})`;
      const timestamp = new Date().toLocaleTimeString();

      console.log('====================================');
      console.log(`[GAME OVER] Room: ${code}`);
      console.log(`Players: ${p1.name} (${p1.symbol}) vs ${p2.name} (${p2.symbol})`);
      console.log(`Result: ${outcomeText}`);
      console.log(`Time: ${timestamp}`);
      console.log('====================================');

      matchHistory.unshift({
        roomCode: code,
        player1: `${p1.name} (${p1.symbol})`,
        player2: `${p2.name} (${p2.symbol})`,
        winner: outcomeText,
        time: timestamp
      });

      io.to(code).emit('moveMade', { board: room.board, turn: room.turn });
      io.to(code).emit('gameOver', { ...result, winnerName });

      delete rooms[code];
      io.in(code).socketsLeave(code);
    } else {
      room.turn = room.turn === 'X' ? 'O' : 'X';
      io.to(code).emit('moveMade', { board: room.board, turn: room.turn });
      startMoveTimer(code);
    }
  });

  socket.on('disconnect', () => {
    const code = socket.roomCode;
    if (code && rooms[code]) {
      if (rooms[code].timer) clearInterval(rooms[code].timer);
      io.to(code).emit('opponentLeft');
      delete rooms[code];
    }
  });
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => console.log(`Server running on http://localhost:${PORT}`));