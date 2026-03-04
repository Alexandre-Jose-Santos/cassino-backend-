// ============================================================
//  CASSIANO CASINO — BACKEND COMPLETO
//  Node.js + Express + Socket.io + Firebase Admin + Mercado Pago
// ============================================================
const express    = require('express');
const http       = require('http');
const { Server } = require('socket.io');
const admin      = require('firebase-admin');
const cors       = require('cors');
const crypto     = require('crypto');
require('dotenv').config();

// ── Firebase Admin Init ──────────────────────────────────────
admin.initializeApp({
  credential: admin.credential.cert({
    projectId:     process.env.FIREBASE_PROJECT_ID,
    clientEmail:   process.env.FIREBASE_CLIENT_EMAIL,
    privateKey:    process.env.FIREBASE_PRIVATE_KEY?.replace(/\\n/g, '\n'),
  }),
});
const db = admin.firestore();

// ── Express + CORS ───────────────────────────────────────────
const app    = express();
const server = http.createServer(app);
const io     = new Server(server, {
  cors: { origin: process.env.FRONTEND_URL || '*', methods: ['GET','POST'] }
});

app.use(cors({ origin: process.env.FRONTEND_URL || '*' }));
app.use(express.json());

// ── Mercado Pago Config ──────────────────────────────────────
// MODO SANDBOX ATÉ TER CNPJ/LICENÇA — troca ACCESS_TOKEN por produção depois
const MP_TOKEN = process.env.MP_ACCESS_TOKEN; // sandbox token por agora

// ── Pacotes de Fichas ─────────────────────────────────────────
const PACKAGES = [
  { id: 'pkg_5',   label: 'Starter',  price: 5,   chips: 500,   bonus: 0    },
  { id: 'pkg_10',  label: 'Popular',  price: 10,  chips: 1000,  bonus: 100  },
  { id: 'pkg_25',  label: 'Pro',      price: 25,  chips: 2700,  bonus: 300  },
  { id: 'pkg_50',  label: 'VIP',      price: 50,  chips: 6000,  bonus: 1000 },
];

const SAQUE_TAXA = 0.10; // 10% de taxa sobre saques

// ════════════════════════════════════════════════════════════
//  ROTAS DE AUTENTICAÇÃO
// ════════════════════════════════════════════════════════════

// Middleware: verifica Firebase token
async function authMiddleware(req, res, next) {
  const token = req.headers.authorization?.split('Bearer ')[1];
  if (!token) return res.status(401).json({ error: 'Token ausente' });
  try {
    req.user = await admin.auth().verifyIdToken(token);
    next();
  } catch {
    res.status(401).json({ error: 'Token inválido' });
  }
}

// Cria/atualiza perfil ao fazer login
app.post('/api/auth/profile', authMiddleware, async (req, res) => {
  const { uid, email, name, picture } = req.user;
  const userRef = db.collection('users').doc(uid);
  const snap = await userRef.get();

  if (!snap.exists) {
    await userRef.set({
      uid, email,
      name: name || email.split('@')[0],
      avatar: picture || '',
      chips: 150,          // bônus de boas-vindas
      totalDeposited: 0,
      totalWithdrawn: 0,
      createdAt: admin.firestore.FieldValue.serverTimestamp(),
      status: 'active',
    });
    // Log transação de bônus
    await logTransaction(uid, 'bonus', 150, 'Bônus de boas-vindas');
  }

  const data = (await userRef.get()).data();
  res.json({ success: true, user: data });
});

// ════════════════════════════════════════════════════════════
//  ROTAS DE PAGAMENTO — MERCADO PAGO PIX
// ════════════════════════════════════════════════════════════

// Gera cobrança PIX
app.post('/api/payment/create', authMiddleware, async (req, res) => {
  const { packageId } = req.body;
  const pkg = PACKAGES.find(p => p.id === packageId);
  if (!pkg) return res.status(400).json({ error: 'Pacote inválido' });

  const { uid, email, name } = req.user;
  const idempotencyKey = crypto.randomUUID();

  try {
    const response = await fetch('https://api.mercadopago.com/v1/payments', {
      method: 'POST',
      headers: {
        'Content-Type':       'application/json',
        'Authorization':      `Bearer ${MP_TOKEN}`,
        'X-Idempotency-Key':  idempotencyKey,
      },
      body: JSON.stringify({
        transaction_amount: pkg.price,
        description: `Cassiano Casino — ${pkg.label} (${pkg.chips + pkg.bonus} fichas)`,
        payment_method_id: 'pix',
        payer: { email, first_name: name || 'Jogador' },
        notification_url: `${process.env.BACKEND_URL}/api/payment/webhook`,
        metadata: {
          user_id:    uid,
          package_id: packageId,
          chips:      pkg.chips + pkg.bonus,
        },
      }),
    });

    const data = await response.json();
    if (!response.ok) throw new Error(data.message || 'Erro Mercado Pago');

    // Salva pagamento pendente no Firestore
    await db.collection('payments').doc(String(data.id)).set({
      paymentId:  data.id,
      userId:     uid,
      packageId,
      price:      pkg.price,
      chips:      pkg.chips + pkg.bonus,
      status:     'pending',
      createdAt:  admin.firestore.FieldValue.serverTimestamp(),
    });

    res.json({
      success: true,
      paymentId: data.id,
      qrCode:    data.point_of_interaction?.transaction_data?.qr_code,
      qrCodeB64: data.point_of_interaction?.transaction_data?.qr_code_base64,
      pixKey:    data.point_of_interaction?.transaction_data?.qr_code,
    });

  } catch (err) {
    console.error('Erro ao criar pagamento:', err);
    res.status(500).json({ error: err.message });
  }
});

// Webhook Mercado Pago — confirma pagamento
app.post('/api/payment/webhook', async (req, res) => {
  res.sendStatus(200); // responde rápido pro MP

  const { action, data } = req.body;
  if (action !== 'payment.updated') return;

  try {
    const response = await fetch(`https://api.mercadopago.com/v1/payments/${data.id}`, {
      headers: { 'Authorization': `Bearer ${MP_TOKEN}` }
    });
    const payment = await response.json();
    if (payment.status !== 'approved') return;

    const payRef = db.collection('payments').doc(String(data.id));
    const paySnap = await payRef.get();
    if (!paySnap.exists) return;

    const pay = paySnap.data();
    if (pay.status === 'approved') return; // já processado

    // Credita fichas
    await db.collection('users').doc(pay.userId).update({
      chips:          admin.firestore.FieldValue.increment(pay.chips),
      totalDeposited: admin.firestore.FieldValue.increment(pay.price),
    });

    await payRef.update({ status: 'approved', approvedAt: admin.firestore.FieldValue.serverTimestamp() });
    await logTransaction(pay.userId, 'deposit', pay.chips, `Compra via PIX — R$${pay.price}`);

    // Notifica cliente em tempo real via Socket.io
    const userSockets = [...io.sockets.sockets.values()]
      .filter(s => s.data.uid === pay.userId);
    userSockets.forEach(s => s.emit('chips_credited', {
      chips:   pay.chips,
      message: `✅ PIX confirmado! +${pay.chips.toLocaleString()} fichas creditadas!`,
    }));

  } catch (err) {
    console.error('Erro no webhook:', err);
  }
});

// ════════════════════════════════════════════════════════════
//  ROTAS DE SAQUE
//  🔒 BLOQUEADO ATÉ OBTER LICENÇA — código pronto para ativar
// ════════════════════════════════════════════════════════════

app.post('/api/withdrawal/request', authMiddleware, async (req, res) => {
  // REMOVA ESTE BLOCO QUANDO TIVER LICENÇA:
  if (process.env.WITHDRAWALS_ENABLED !== 'true') {
    return res.status(403).json({
      error: 'Saques temporariamente indisponíveis. Em breve!',
      locked: true,
    });
  }

  const { chips, pixKey } = req.body;
  if (!chips || chips < 100) return res.status(400).json({ error: 'Mínimo de 100 fichas para saque' });
  if (!pixKey) return res.status(400).json({ error: 'Chave PIX obrigatória' });

  const { uid } = req.user;
  const userRef = db.collection('users').doc(uid);
  const userSnap = await userRef.get();
  const user = userSnap.data();

  if (user.chips < chips) return res.status(400).json({ error: 'Saldo insuficiente' });

  const grossValue = chips / 100;           // 1 ficha = R$0,01? defina a taxa aqui
  const fee        = grossValue * SAQUE_TAXA;
  const netValue   = parseFloat((grossValue - fee).toFixed(2));

  // Deduz fichas e cria pedido de saque
  await userRef.update({
    chips: admin.firestore.FieldValue.increment(-chips),
  });

  const withdrawalRef = await db.collection('withdrawals').add({
    userId:     uid,
    userName:   user.name,
    userEmail:  user.email,
    chips,
    grossValue,
    fee,
    netValue,
    pixKey,
    status:     'pending',   // admin aprova manualmente
    createdAt:  admin.firestore.FieldValue.serverTimestamp(),
  });

  await logTransaction(uid, 'withdrawal_request', -chips, `Pedido de saque R$${netValue} (taxa 10%)`);

  res.json({
    success: true,
    withdrawalId: withdrawalRef.id,
    netValue,
    fee,
    message: `Pedido registrado! Você receberá R$${netValue} em até 24h.`,
  });
});

// ════════════════════════════════════════════════════════════
//  ROTAS DO USUÁRIO
// ════════════════════════════════════════════════════════════

app.get('/api/user/balance', authMiddleware, async (req, res) => {
  const snap = await db.collection('users').doc(req.user.uid).get();
  if (!snap.exists) return res.status(404).json({ error: 'Usuário não encontrado' });
  const { chips, totalDeposited, totalWithdrawn } = snap.data();
  res.json({ chips, totalDeposited, totalWithdrawn });
});

app.get('/api/user/transactions', authMiddleware, async (req, res) => {
  const snap = await db.collection('transactions')
    .where('userId', '==', req.user.uid)
    .orderBy('createdAt', 'desc')
    .limit(50)
    .get();
  res.json(snap.docs.map(d => ({ id: d.id, ...d.data() })));
});

// ════════════════════════════════════════════════════════════
//  ROTAS DE ADMIN
//  🔒 Protegido por ADMIN_SECRET no header
// ════════════════════════════════════════════════════════════

function adminAuth(req, res, next) {
  if (req.headers['x-admin-secret'] !== process.env.ADMIN_SECRET)
    return res.status(403).json({ error: 'Acesso negado' });
  next();
}

// Lista todos usuários
app.get('/api/admin/users', adminAuth, async (req, res) => {
  const snap = await db.collection('users').orderBy('createdAt','desc').limit(100).get();
  res.json(snap.docs.map(d => d.data()));
});

// Lista saques pendentes
app.get('/api/admin/withdrawals', adminAuth, async (req, res) => {
  const snap = await db.collection('withdrawals')
    .where('status', '==', 'pending')
    .orderBy('createdAt', 'asc')
    .get();
  res.json(snap.docs.map(d => ({ id: d.id, ...d.data() })));
});

// Aprova saque
app.post('/api/admin/withdrawals/:id/approve', adminAuth, async (req, res) => {
  const ref = db.collection('withdrawals').doc(req.params.id);
  const snap = await ref.get();
  if (!snap.exists) return res.status(404).json({ error: 'Não encontrado' });

  await ref.update({ status: 'approved', approvedAt: admin.firestore.FieldValue.serverTimestamp() });
  const w = snap.data();
  await db.collection('users').doc(w.userId).update({
    totalWithdrawn: admin.firestore.FieldValue.increment(w.netValue),
  });
  await logTransaction(w.userId, 'withdrawal_approved', 0, `Saque aprovado R$${w.netValue}`);

  res.json({ success: true });
});

// Rejeita saque (devolve fichas)
app.post('/api/admin/withdrawals/:id/reject', adminAuth, async (req, res) => {
  const ref = db.collection('withdrawals').doc(req.params.id);
  const snap = await ref.get();
  if (!snap.exists) return res.status(404).json({ error: 'Não encontrado' });

  const w = snap.data();
  await ref.update({ status: 'rejected', rejectedAt: admin.firestore.FieldValue.serverTimestamp() });
  await db.collection('users').doc(w.userId).update({
    chips: admin.firestore.FieldValue.increment(w.chips),
  });
  await logTransaction(w.userId, 'withdrawal_rejected', w.chips, 'Saque rejeitado — fichas devolvidas');

  res.json({ success: true });
});

// Dashboard financeiro
app.get('/api/admin/dashboard', adminAuth, async (req, res) => {
  const [usersSnap, paymentsSnap, withdrawalsSnap] = await Promise.all([
    db.collection('users').get(),
    db.collection('payments').where('status','==','approved').get(),
    db.collection('withdrawals').where('status','==','approved').get(),
  ]);

  const totalUsers      = usersSnap.size;
  const totalDeposits   = paymentsSnap.docs.reduce((s,d) => s + d.data().price, 0);
  const totalWithdrawals= withdrawalsSnap.docs.reduce((s,d) => s + d.data().netValue, 0);
  const totalFees       = withdrawalsSnap.docs.reduce((s,d) => s + d.data().fee, 0);

  res.json({
    totalUsers,
    totalDeposits:    totalDeposits.toFixed(2),
    totalWithdrawals: totalWithdrawals.toFixed(2),
    totalFees:        totalFees.toFixed(2),
    balance:          (totalDeposits - totalWithdrawals).toFixed(2),
  });
});

// ════════════════════════════════════════════════════════════
//  SOCKET.IO — MULTIPLAYER
// ════════════════════════════════════════════════════════════

// Salas de jogo ativas
const rooms = new Map();

io.use(async (socket, next) => {
  const token = socket.handshake.auth.token;
  if (!token) return next(new Error('Token ausente'));
  try {
    const decoded = await admin.auth().verifyIdToken(token);
    socket.data.uid   = decoded.uid;
    socket.data.email = decoded.email;
    const snap = await db.collection('users').doc(decoded.uid).get();
    socket.data.user  = snap.data();
    next();
  } catch {
    next(new Error('Token inválido'));
  }
});

io.on('connection', socket => {
  const { uid, user } = socket.data;
  console.log(`✅ Conectado: ${user?.name} (${uid})`);

  // Entra no lobby
  socket.join('lobby');
  io.to('lobby').emit('online_count', io.sockets.sockets.size);

  // ── Criar sala ──────────────────────────────────────────
  socket.on('create_room', async ({ game, betAmount, maxPlayers=4 }) => {
    // Valida maxPlayers
    const max = Math.min(Math.max(parseInt(maxPlayers)||2, 2), 4);
    // Verifica saldo
    const snap = await db.collection('users').doc(uid).get();
    const balance = snap.data().chips;
    if (balance < betAmount) {
      socket.emit('error', { message: 'Saldo insuficiente' });
      return;
    }

    const roomId = crypto.randomUUID().slice(0,8).toUpperCase();
    rooms.set(roomId, {
      id: roomId, game, betAmount, maxPlayers: max,
      players: [{ uid, name: user.name, avatar: user.avatar, ready: false, online: true }],
      status: 'waiting',
      createdAt: Date.now(),
    });

    socket.join(roomId);
    socket.emit('room_created', { roomId, room: rooms.get(roomId) });
    io.to('lobby').emit('rooms_update', getRoomsList());
  });

  // ── Entrar em sala ──────────────────────────────────────
  socket.on('join_room', async ({ roomId }) => {
    const room = rooms.get(roomId);
    if (!room) { socket.emit('error', { message: 'Sala não encontrada' }); return; }
    if (room.status !== 'waiting') { socket.emit('error', { message: 'Jogo já iniciado' }); return; }

    // Verifica se jogador já está na sala (evita duplicata)
    const jaEstaNaSala = room.players.find(p => p.uid === uid);
    if (jaEstaNaSala) {
      // Reconectou — marca como online novamente
      jaEstaNaSala.online = true;
      jaEstaNaSala.disconnectedAt = null;
      socket.join(roomId);
      socket.emit('room_joined', { room });
      io.to(roomId).emit('room_update', room);
      io.to('lobby').emit('rooms_update', getRoomsList());
      return;
    }

    if (room.players.length >= (room.maxPlayers||4)) { socket.emit('error', { message: 'Sala cheia' }); return; }

    const snap = await db.collection('users').doc(uid).get();
    if (!snap.exists || snap.data().chips < room.betAmount) {
      socket.emit('error', { message: 'Saldo insuficiente para essa mesa' });
      return;
    }

    room.players.push({ uid, name: user.name, avatar: user.avatar, ready: false, online: true });
    socket.join(roomId);
    // Confirma entrada para quem entrou
    socket.emit('room_joined', { room });
    // Avisa todos na sala
    io.to(roomId).emit('room_update', room);
    io.to('lobby').emit('rooms_update', getRoomsList());
  });

  // ── Player pronto ──────────────────────────────────────
  // ── Player pronto (só marca ready, NÃO debita fichas) ────
  socket.on('player_ready', ({ roomId }) => {
    const room = rooms.get(roomId);
    if (!room || room.status !== 'waiting') return;
    const player = room.players.find(p => p.uid === uid);
    if (!player || player.ready) return;
    player.ready = true;
    io.to(roomId).emit('room_update', room);
  });

  // ── Cancelar pronto ────────────────────────────────────────
  socket.on('player_unready', ({ roomId }) => {
    const room = rooms.get(roomId);
    if (!room || room.status !== 'waiting') return;
    const player = room.players.find(p => p.uid === uid);
    if (!player) return;
    player.ready = false;
    io.to(roomId).emit('room_update', room);
  });

  // ── Iniciar jogo (só o criador, quando todos prontos) ─────
  // Débito acontece AQUI, não no player_ready
  socket.on('start_game', async ({ roomId }) => {
    const room = rooms.get(roomId);
    if (!room || room.status !== 'waiting') return;

    // Só o criador (primeiro jogador) pode iniciar
    if (room.players[0].uid !== uid) {
      socket.emit('error', { message: 'Só quem criou a sala pode iniciar.' });
      return;
    }

    const totalJogadores = room.players.length;
    if (totalJogadores < 2) {
      socket.emit('error', { message: 'Precisa de pelo menos 2 jogadores.' });
      return;
    }

    const nProntos = room.players.filter(p => p.ready).length;
    if (nProntos < totalJogadores) {
      socket.emit('error', { message: 'Nem todos os jogadores estão prontos.' });
      return;
    }

    room.status = 'playing';

    // Debita fichas de todos agora
    try {
      const batch = db.batch();
      for (const p of room.players) {
        const snap = await db.collection('users').doc(p.uid).get();
        const saldo = snap.exists ? (snap.data().chips || 0) : 0;
        if (saldo < room.betAmount) {
          room.status = 'waiting';
          room.players.forEach(pl => pl.ready = false);
          io.to(roomId).emit('error', { message: `${p.name} não tem fichas suficientes (${saldo}/${room.betAmount})!` });
          io.to(roomId).emit('room_update', room);
          return;
        }
        batch.update(db.collection('users').doc(p.uid), {
          chips: admin.firestore.FieldValue.increment(-room.betAmount),
        });
      }
      await batch.commit();
    } catch(e) {
      console.error('Erro ao debitar:', e);
      room.status = 'waiting';
      room.players.forEach(pl => pl.ready = false);
      io.to(roomId).emit('room_update', room);
      return;
    }

    const matchRef = await db.collection('matches').add({
      roomId, game: room.game,
      betAmount: room.betAmount,
      pot: room.betAmount * totalJogadores,
      players: room.players.map(p => p.uid),
      status: 'playing',
      createdAt: admin.firestore.FieldValue.serverTimestamp(),
    });
    room.matchId = matchRef.id;

    io.to(roomId).emit('game_start', { room, matchId: matchRef.id });
    console.log(`🎮 Jogo iniciado: ${room.game} sala ${roomId} — ${totalJogadores} jogadores`);
  });

  // ── Ação de jogo (genérico) ────────────────────────────
  socket.on('game_action', ({ roomId, action, data }) => {
    // Repassa a ação para os outros jogadores da sala
    socket.to(roomId).emit('game_action', { uid, action, data });
  });

  // ── Fim de jogo ─────────────────────────────────────────
  socket.on('game_over', async ({ roomId, winnerId }) => {
    const room = rooms.get(roomId);
    if (!room || room.status !== 'playing') return;
    room.status = 'finished';

    const pot     = room.betAmount * room.players.length;
    const prize   = pot; // fichas virtuais — sem taxa aqui (taxa só no saque)

    // Credita vencedor
    if (winnerId) {
      await db.collection('users').doc(winnerId).update({
        chips: admin.firestore.FieldValue.increment(prize),
      });
      await logTransaction(winnerId, 'win', prize, `Vitória em ${room.game} — pote R$${pot}`);
    }

    // Atualiza partida
    if (room.matchId) {
      await db.collection('matches').doc(room.matchId).update({
        status: 'finished', winnerId, prize,
        finishedAt: admin.firestore.FieldValue.serverTimestamp(),
      });
    }

    io.to(roomId).emit('game_result', { winnerId, prize, room });
    rooms.delete(roomId);
    io.to('lobby').emit('rooms_update', getRoomsList());
  });

  // ── Atualiza lista de salas sob demanda ──────────────────
  socket.on('get_rooms', () => {
    socket.emit('rooms_update', getRoomsList());
  });

  // ── Chat da sala ─────────────────────────────────────────
  socket.on('chat_message', ({ roomId, message }) => {
    const clean = message.slice(0, 120);
    io.to(roomId).emit('chat_message', {
      uid, name: user.name, message: clean, time: Date.now()
    });
  });

  // ── Desconexão ───────────────────────────────────────────
  socket.on('disconnect', () => {
    console.log(`❌ Desconectado: ${user?.name}`);
    // Marca jogador como offline mas NÃO remove a sala
    // A sala só some depois de 5 minutos sem ninguém reconectar
    for (const [roomId, room] of rooms.entries()) {
      const player = room.players.find(p => p.uid === uid);
      if (player) {
        player.online = false;
        player.disconnectedAt = Date.now();
        // Avisa outros na sala
        io.to(roomId).emit('player_offline', { uid, room });
        // Agenda limpeza da sala após 5 minutos se ainda vazia/offline
        setTimeout(() => {
          const r = rooms.get(roomId);
          if (!r) return;
          // Remove jogadores offline há mais de 5 min
          r.players = r.players.filter(p => p.online || (Date.now() - (p.disconnectedAt||0)) < 300000);
          if (r.players.length === 0 && r.status === 'waiting') {
            rooms.delete(roomId);
            console.log(`🗑️ Sala ${roomId} removida por inatividade`);
          }
          io.to('lobby').emit('rooms_update', getRoomsList());
        }, 300000); // 5 minutos
      }
    }
    io.to('lobby').emit('online_count', io.sockets.sockets.size);
    io.to('lobby').emit('rooms_update', getRoomsList());
  });
});

// ── Helpers ──────────────────────────────────────────────────
function getRoomsList() {
  return [...rooms.values()]
    .filter(r => r.status === 'waiting')
    .map(r => ({
      id:         r.id,
      game:       r.game,
      betAmount:  r.betAmount,
      players:    r.players.length,
      maxPlayers: r.maxPlayers||4,
      createdAt:  r.createdAt,
      hasOffline: r.players.some(p => !p.online),
    }));
}

async function logTransaction(userId, type, chips, description) {
  await db.collection('transactions').add({
    userId, type, chips, description,
    createdAt: admin.firestore.FieldValue.serverTimestamp(),
  });
}

// ── Health check ─────────────────────────────────────────────
app.get('/health', (_, res) => res.json({ status: 'ok', rooms: rooms.size }));
app.get('/api/packages', (_, res) => res.json(PACKAGES));

// ── Start ────────────────────────────────────────────────────
const PORT = process.env.PORT || 3001;
server.listen(PORT, () => console.log(`🎰 Cassiano Backend rodando na porta ${PORT}`));
