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
const io = new Server(server, {
  cors: { origin: process.env.FRONTEND_URL || '*', methods: ['GET','POST'], credentials: true },
  pingTimeout: 60000,
  pingInterval: 25000,
  transports: ['websocket', 'polling'],
});

// Keep-alive: evita que o Railway adormeça (free tier dorme após inatividade)
setInterval(() => {
  const domain = process.env.RAILWAY_PUBLIC_DOMAIN;
  if (!domain) return;
  require('https').get(`https://${domain}/health`, r => {
    console.log(`💓 Keep-alive: ${r.statusCode} | salas: ${rooms.size} | conexões: ${io.sockets.sockets.size}`);
  }).on('error', e => console.warn('Keep-alive falhou:', e.message));
}, 4 * 60 * 1000); // a cada 4 minutos

app.use(cors({ origin: process.env.FRONTEND_URL || '*' }));
app.get('/health', (req, res) => res.json({ status: 'ok', rooms: rooms.size, connections: io.sockets.sockets.size, uptime: Math.floor(process.uptime()) }));
app.use(express.json());

// ── Mercado Pago Config ──────────────────────────────────────
// MODO SANDBOX ATÉ TER CNPJ/LICENÇA — troca ACCESS_TOKEN por produção depois
const MP_TOKEN = process.env.MP_ACCESS_TOKEN; // sandbox token por agora

// ── Pacotes de Fichas ─────────────────────────────────────────
// 1 ficha = R$0,10 (10 fichas = R$1,00)
const CHIP_RATE = 0.10;
const PACKAGES = [
  { id: 'pkg_1',  label: 'Iniciante', price: 1.00,  chips: 10,   bonus: 0 },
  { id: 'pkg_2',  label: 'Bronze',    price: 2.00,  chips: 20,   bonus: 0 },
  { id: 'pkg_3',  label: 'Prata',     price: 5.00,  chips: 50,   bonus: 0 },
  { id: 'pkg_4',  label: 'Ouro',      price: 10.00, chips: 100,  bonus: 0 },
  { id: 'pkg_5',  label: 'Platina',   price: 20.00, chips: 200,  bonus: 0 },
  { id: 'pkg_6',  label: 'Diamante',  price: 50.00, chips: 500,  bonus: 0 },
  { id: 'pkg_7',  label: 'Elite',     price: 100.00,chips: 1000, bonus: 0 },
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
        description: `Cassino AR — ${pkg.label} (${pkg.chips + pkg.bonus} fichas)`,
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
    await logTransaction(pay.userId, 'deposit', pay.chips, `Compra via PIX — R$${pay.price} (${pay.chips} fichas)`);

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
  if (!chips || chips < 100) return res.status(400).json({ error: 'Mínimo de 100 fichas (R$10,00) para saque' });
  if (!pixKey) return res.status(400).json({ error: 'Chave PIX obrigatória' });

  const { uid } = req.user;
  const userRef = db.collection('users').doc(uid);
  const userSnap = await userRef.get();
  const user = userSnap.data();

  if (user.chips < chips) return res.status(400).json({ error: 'Saldo insuficiente' });

  const grossValue = parseFloat((chips * 0.10).toFixed(2)); // 1 ficha = R$0,10
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

// Reset automático da sala 10s após fim do jogo
function scheduleReset(room, roomId) {
  if(room.resetTimeout) clearTimeout(room.resetTimeout);
  room.resetTimeout = setTimeout(()=>{
    room.resetTimeout = null;
    if(!rooms.has(roomId)) return;
    room.status = 'waiting';
    room.pifeState = null;
    room.dominoState = null;
    room.matchId = null;
    room.players.forEach(p => { p.ready = false; });
    io.to(roomId).emit('room_update', room);
    io.to('lobby').emit('rooms_update', getRoomsList());
    console.log('🔄 Sala ' + roomId + ' resetada');
  }, 10500);
}


function advancePokerStage(room, roomId, io) {
  const ps = room.pokerState;
  if(!ps) return;
  const BB = room.betAmount || 10;
  // Reset bets for new street
  ps.bets = {};
  ps.curBet = 0;
  // Dealer (players[0]) acts first post-flop
  ps.currentTurn = room.players[0].uid;

  let newComm = [...ps.community];
  let stage = ps.stage;

  if(stage === 'pre') {
    newComm = [ps.deck.pop(), ps.deck.pop(), ps.deck.pop()];
    ps.stage = 'flop';
  } else if(stage === 'flop') {
    newComm = [...ps.community, ps.deck.pop()];
    ps.stage = 'turn';
  } else if(stage === 'turn') {
    newComm = [...ps.community, ps.deck.pop()];
    ps.stage = 'river';
  } else {
    // Showdown
    doPokerShowdown(room, roomId, io);
    return;
  }
  ps.community = newComm;

  for(const p of room.players) {
    const pSock = [...io.sockets.sockets.values()].find(sk=>sk.data.uid===p.uid);
    if(pSock) {
      const oppUid = room.players.find(op=>op.uid!==p.uid)?.uid;
      pSock.emit('game_action',{uid:'server',action:'poker_community',data:{
        community: newComm,
        stage: ps.stage,
        myTurn: ps.currentTurn === p.uid,
        chips: ps.chips[p.uid]||0,
        oppChips: ps.chips[oppUid]||0,
        pot: ps.pot,
      }});
    }
  }
}

function doPokerShowdown(room, roomId, io) {
  const ps = room.pokerState;
  if(!ps) return;
  const p0 = room.players[0].uid;
  const p1 = room.players[1].uid;

  // Evaluate hands
  function pkEvalServer(cards) {
    if(!cards||cards.length<5) return [0,0,0,0,0,0];
    const RV={'2':2,'3':3,'4':4,'5':5,'6':6,'7':7,'8':8,'9':9,'10':10,'J':11,'Q':12,'K':13,'A':14};
    function combos5(arr) {
      const res=[];
      function go(s,cur){if(cur.length===5){res.push(cur.slice());return;}for(let i=s;i<arr.length;i++){cur.push(arr[i]);go(i+1,cur);cur.pop();}}
      go(0,[]);return res;
    }
    function score(h) {
      const vals=h.map(c=>RV[c.rank]).sort((a,b)=>b-a);
      const suits=h.map(c=>c.suit);
      const fl=suits.every(s=>s===suits[0]);
      const uv=[...new Set(vals)].sort((a,b)=>b-a);
      let st=0;
      if(uv.length===5&&uv[0]-uv[4]===4) st=uv[0];
      else if(uv.length===5&&uv[0]===14&&uv[1]===5) st=5;
      const cnt={};vals.forEach(v=>{cnt[v]=(cnt[v]||0)+1;});
      const g=Object.keys(cnt).map(v=>({v:+v,c:cnt[v]})).sort((a,b)=>b.c-a.c||b.v-a.v);
      if(fl&&st) return st===14?[9,...vals]:[8,st,...vals];
      if(g[0].c===4) return [7,g[0].v,g[1]?.v||0,...vals];
      if(g[0].c===3&&g[1]?.c===2) return [6,g[0].v,g[1].v,...vals];
      if(fl) return [5,...vals];
      if(st) return [4,st,...vals];
      if(g[0].c===3) return [3,g[0].v,...vals];
      if(g[0].c===2&&g[1]?.c===2) return [2,Math.max(g[0].v,g[1].v),Math.min(g[0].v,g[1].v),g[2]?.v||0,...vals];
      if(g[0].c===2) return [1,g[0].v,...vals];
      return [0,...vals];
    }
    const names=['Carta Alta','Par','Dois Pares','Trinca','Sequencia','Flush','Full House','Quadra','Straight Flush','Royal Flush'];
    let best=null,bestScore=null;
    for(const h of combos5(cards)){
      const s=score(h);
      if(!bestScore){best=h;bestScore=s;continue;}
      for(let i=0;i<s.length;i++){if(s[i]>bestScore[i]){best=h;bestScore=s;break;}if(s[i]<bestScore[i])break;}
    }
    return {score:bestScore||[0,...Array(5).fill(0)],name:names[bestScore?bestScore[0]:0]||''};
  }

  const h0 = pkEvalServer([...ps.hands[p0], ...ps.community]);
  const h1 = pkEvalServer([...ps.hands[p1], ...ps.community]);
  let cmp = 0;
  for(let i=0;i<h0.score.length;i++){cmp=h0.score[i]-h1.score[i];if(cmp!==0)break;}

  let winnerId, loserId, tie=false;
  const bet = room.betAmount||10;
  if(cmp>0){winnerId=p0;loserId=p1;}
  else if(cmp<0){winnerId=p1;loserId=p0;}
  else{tie=true;winnerId=p0;loserId=p1;}

  if(!tie){
    ps.chips[winnerId] = (ps.chips[winnerId]||0) + ps.pot;
  } else {
    const half = Math.floor(ps.pot/2);
    ps.chips[p0] += half;
    ps.chips[p1] += ps.pot - half;
  }

  // Emit to both players
  for(const p of room.players) {
    const pSock = [...io.sockets.sockets.values()].find(sk=>sk.data.uid===p.uid);
    const oppUid = room.players.find(op=>op.uid!==p.uid)?.uid;
    if(pSock) pSock.emit('game_action',{uid:'server',action:'poker_win',data:{
      winnerId: tie?null:winnerId,
      tie,
      myChips: ps.chips[p.uid]||0,
      oppChips: ps.chips[oppUid]||0,
      oppHand: ps.hands[oppUid],
      myHand: {score:p.uid===p0?h0.score:h1.score},
      reason: tie?'Empate!':(p.uid===winnerId?`${p.uid===p0?h0.name:h1.name} bate ${p.uid===p0?h1.name:h0.name}`:
        `${p.uid===p0?h1.name:h0.name} bate ${p.uid===p0?h0.name:h1.name}`)
    }});
  }

  io.to(roomId).emit('game_result',{
    winnerId: tie?null:winnerId, loserId: tie?null:loserId,
    prize: bet, winnerChips: tie?null:ps.chips[winnerId], loserChips: tie?null:ps.chips[loserId]
  });
  room.pokerState = null;
}

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

    // ── Reconexão: jogador já estava na sala (durante partida ou na espera) ──
    const jaEstaNaSala = room.players.find(p => p.uid === uid);
    if (jaEstaNaSala) {
      jaEstaNaSala.online = true;
      jaEstaNaSala.disconnectedAt = null;
      jaEstaNaSala.socketId = socket.id;
      socket.join(roomId);
      // Envia estado completo da sala + estado do jogo atual
      socket.emit('room_joined', { room });
      socket.emit('room_update', room);
      // Reenvía estado do jogo em andamento se houver
      if (room.status === 'playing') {
        // Dama: reenvia board atual
        if (room.game === 'dama' && room.damaBoard) {
          socket.emit('game_action', {
            action: 'dama_update',
            data: { board: room.damaBoard, turn: room.damaTurn || 'w' }
          });
          // Reenvia as cores
          const colorMap = {};
          room.players.forEach(p => { if(p.damaColor) colorMap[p.uid] = p.damaColor; });
          socket.emit('game_action', { action: 'dama_init', data: { colorMap } });
        }
        // Dominó, Xadrez, etc: reenvia room_update que inclui game state
        socket.emit('game_action', { action: 'reconnected', data: { game: room.game } });
      }
      io.to(roomId).emit('room_update', room);
      io.to(roomId).emit('player_online', { uid, name: jaEstaNaSala.name });
      io.to('lobby').emit('rooms_update', getRoomsList());
      console.log(`🔄 ${jaEstaNaSala.name} reconectou à sala ${roomId}`);
      return;
    }

    // Bloqueia entrada de NOVO jogador se jogo já iniciado
    if (room.status !== 'waiting') { socket.emit('error', { message: 'Jogo já iniciado' }); return; }

    if (room.players.length >= (room.maxPlayers||4)) { socket.emit('error', { message: 'Sala cheia' }); return; }

    // Verifica saldo antes de entrar
    const joinSnap = await db.collection('users').doc(uid).get();
    const joinBalance = joinSnap.exists ? (joinSnap.data().chips || 0) : 0;
    if (joinBalance < room.betAmount) {
      socket.emit('error', { message: `Saldo insuficiente! Você tem ${joinBalance} fichas e a aposta é ${room.betAmount}.` });
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
  // ── Player pronto ─────────────────────────────────────────
  socket.on('player_ready', ({ roomId }) => {
    const room = rooms.get(roomId);
    if (!room || room.status !== 'waiting') return;
    const player = room.players.find(p => p.uid === uid);
    if (!player || player.ready) return;
    player.ready = true;
    io.to(roomId).emit('room_update', room);
  });

  socket.on('player_unready', ({ roomId }) => {
    const room = rooms.get(roomId);
    if (!room || room.status !== 'waiting') return;
    const player = room.players.find(p => p.uid === uid);
    if (!player) return;
    player.ready = false;
    io.to(roomId).emit('room_update', room);
  });

  // ── Iniciar jogo (criador, todos prontos) — SEM debitar fichas ──
  socket.on('start_game', async ({ roomId }) => {
    const room = rooms.get(roomId);
    if (!room || room.status !== 'waiting') return;
    if (room.players[0].uid !== uid) {
      socket.emit('error', { message: 'Só quem criou a sala pode iniciar.' });
      return;
    }
    if (room.players.length < 2) {
      socket.emit('error', { message: 'Precisa de pelo menos 2 jogadores.' });
      return;
    }
    if (!room.players.every(p => p.ready)) {
      socket.emit('error', { message: 'Nem todos estão prontos.' });
      return;
    }
    // Verifica saldo de todos
    if(room.betAmount > 0) {
      for(const p of room.players) {
        const snap = await db.collection('users').doc(p.uid).get();
        const chips = snap.exists ? (snap.data().chips||0) : 0;
        if(chips < room.betAmount) {
          io.to(room.id||roomId).emit('error', { message: `${p.name} tem apenas ${chips} fichas. Aposta mínima: ${room.betAmount}.` });
          // Reduz aposta automaticamente para o mínimo possível
          return;
        }
      }
    }
    room.status = 'playing';
    const matchRef = await db.collection('matches').add({
      roomId, game: room.game,
      betAmount: room.betAmount,
      players: room.players.map(p => p.uid),
      status: 'playing',
      createdAt: admin.firestore.FieldValue.serverTimestamp(),
    });
    room.matchId = matchRef.id;
    io.to(roomId).emit('game_start', { room, matchId: matchRef.id });
    console.log(`🎮 Jogo: ${room.game} sala ${roomId}`);
  });

  // ── Proposta de mudança de aposta (durante o jogo) ────────
  socket.on('propose_bet', ({ roomId, newBet }) => {
    const room = rooms.get(roomId);
    if (!room || room.status !== 'playing') return;
    const proposer = room.players.find(p => p.uid === uid);
    if (!proposer) return;
    // Qualquer jogador pode propor
    room.pendingBet = { value: newBet, proposedBy: uid, proposerName: proposer.name, votes: {[uid]: true}, proposedAt: Date.now() };
    // Avisa TODOS os outros
    socket.to(roomId).emit('bet_proposal', { newBet, proposedBy: proposer.name });
  });

  socket.on('vote_bet', ({ roomId, accept }) => {
    const room = rooms.get(roomId);
    if (!room || !room.pendingBet) return;
    room.pendingBet.votes[uid] = accept;
    const others = room.players.filter(p => p.uid !== room.players[0].uid);
    const allVoted = others.every(p => room.pendingBet.votes[p.uid] !== undefined);
    if (allVoted) {
      const allAccepted = others.every(p => room.pendingBet.votes[p.uid] === true);
      if (allAccepted) {
        room.betAmount = room.pendingBet.value;
        io.to(roomId).emit('bet_changed', { newBet: room.betAmount });
      } else {
        io.to(roomId).emit('bet_rejected', { newBet: room.pendingBet.value });
      }
      room.pendingBet = null;
    } else {
      io.to(roomId).emit('room_update', room);
    }
  });

  // ── Ação de jogo ──────────────────────────────────────
  socket.on('game_action', ({ roomId, action, data }) => {
    const room = rooms.get(roomId);

    // ── Pife Online: inicializa ──

    // ══════════════════════════════════════════
    // POKER ONLINE HANDLERS
    // ══════════════════════════════════════════

    if(action === 'poker_init') {
      if(!room) return;
      const BB = room.betAmount || 10;
      const SB = Math.max(5, Math.floor(BB/2));
      const suits=['spade','heart','diam','club'];
      const ranks=['2','3','4','5','6','7','8','9','10','J','Q','K','A'];
      let deck=[];
      for(const s of suits) for(const r of ranks)
        deck.push({rank:r,suit:s,id:`${r}${s}_${Math.random().toString(36).slice(2)}`});
      for(let i=deck.length-1;i>0;i--){const j=Math.floor(Math.random()*(i+1));[deck[i],deck[j]]=[deck[j],deck[i]];}

      const startChips = BB * 10;
      const hands = {};
      const chips = {};
      room.players.forEach(p => {
        hands[p.uid] = [deck.pop(), deck.pop()];
        chips[p.uid] = startChips;
      });

      // players[0] = dealer (paga SB), players[1] = big blind (paga BB)
      const dealerUid = room.players[0].uid;
      const bbUid = room.players[1].uid;
      chips[dealerUid] -= SB;
      chips[bbUid] -= BB;
      const pot = SB + BB;
      const bets = {};
      bets[dealerUid] = SB;
      bets[bbUid] = BB;

      room.pokerState = {
        deck, hands, chips, bets, pot,
        community: [],
        stage: 'pre',
        curBet: BB,
        currentTurn: dealerUid, // dealer acts first pre-flop
        foldedUid: null,
      };

      // Debit chips from Firestore when game starts
      // (handled by game_result at end)

      // Send to each player
      for(const p of room.players) {
        const pSock = [...io.sockets.sockets.values()].find(sk=>sk.data.uid===p.uid);
        if(pSock) {
          const oppUid = room.players.find(op=>op.uid!==p.uid)?.uid;
          pSock.emit('game_action',{uid:'server',action:'poker_deal',data:{
            hand: room.pokerState.hands[p.uid],
            chips: room.pokerState.chips[p.uid],
            oppChips: room.pokerState.chips[oppUid]||0,
            pot, myBet: bets[p.uid]||0, oppBet: bets[oppUid]||0,
            curBet: BB,
            myTurn: room.pokerState.currentTurn === p.uid,
          }});
        }
      }
      return;
    }

    if(action === 'poker_action' && room?.pokerState) {
      const ps = room.pokerState;
      const BB = room.betAmount || 10;
      const SB = Math.max(5, Math.floor(BB/2));
      const oppUid = room.players.find(p=>p.uid!==uid)?.uid;
      if(ps.currentTurn !== uid) return;

      const playerAction = data.action;

      if(playerAction === 'fold') {
        ps.foldedUid = uid;
        const winnerId = oppUid;
        const winnerChips = (ps.chips[winnerId]||0) + ps.pot;
        ps.chips[winnerId] = winnerChips;
        // Emit result
        io.to(roomId).emit('game_action',{uid:'server',action:'poker_fold',data:{
          winnerId,
          myChips: ps.chips[uid]||0,
          oppChips: winnerChips,
          pot: 0,
        }});
        // Chip transaction
        const bet = room.betAmount||10;
        io.to(roomId).emit('game_result',{winnerId,loserId:uid,prize:bet,
          winnerChips: ps.chips[winnerId], loserChips: ps.chips[uid]});
        room.pokerState = null;
        return;
      }

      const myBet = ps.bets[uid]||0;
      const oppBet = ps.bets[oppUid]||0;
      let nextTurn = oppUid;

      if(playerAction === 'check') {
        // Both checked — advance stage
        const bothChecked = myBet >= ps.curBet && oppBet >= ps.curBet;
        if(bothChecked || ps.curBet === 0) {
          advancePokerStage(room, roomId, io);
          return;
        }
      } else if(playerAction === 'call') {
        const toCall = Math.min(ps.curBet - myBet, ps.chips[uid]);
        ps.chips[uid] -= toCall;
        ps.bets[uid] = (ps.bets[uid]||0) + toCall;
        ps.pot += toCall;
        // After call, advance stage
        io.to(roomId).emit('game_action',{uid:'server',action:'poker_action',data:{
          action:'call', uid,
          pot: ps.pot, oppChips: ps.chips[uid],
          oppBet: ps.bets[uid], curBet: ps.curBet,
          myTurn: false,
        }});
        // Send to caller too
        const callerSock = [...io.sockets.sockets.values()].find(sk=>sk.data.uid===uid);
        if(callerSock) callerSock.emit('game_action',{uid:'server',action:'poker_action',data:{
          action:'called', uid, pot:ps.pot, myTurn:false,
        }});
        setTimeout(()=>advancePokerStage(room, roomId, io), 600);
        return;
      } else if(playerAction === 'raise') {
        const amount = data.amount || ps.curBet*2;
        const toAdd = Math.min(amount - myBet, ps.chips[uid]);
        ps.chips[uid] -= toAdd;
        ps.bets[uid] = (ps.bets[uid]||0) + toAdd;
        ps.pot += toAdd;
        ps.curBet = ps.bets[uid];
        // Emit to opponent
        const oppSock = [...io.sockets.sockets.values()].find(sk=>sk.data.uid===oppUid);
        if(oppSock) oppSock.emit('game_action',{uid:'server',action:'poker_action',data:{
          action:'raise', uid,
          pot: ps.pot, oppChips: ps.chips[uid],
          oppBet: ps.bets[uid], curBet: ps.curBet,
          myTurn: true, raiseAmt: ps.curBet,
        }});
        const raiseSock = [...io.sockets.sockets.values()].find(sk=>sk.data.uid===uid);
        if(raiseSock) raiseSock.emit('game_action',{uid:'server',action:'poker_action',data:{
          action:'raised', uid, pot:ps.pot, myTurn:false,
        }});
        ps.currentTurn = oppUid;
        return;
      }

      // Check — just pass turn
      ps.currentTurn = nextTurn;
      const oppSock2 = [...io.sockets.sockets.values()].find(sk=>sk.data.uid===oppUid);
      if(oppSock2) oppSock2.emit('game_action',{uid:'server',action:'poker_action',data:{
        action:'check', uid, pot:ps.pot, myTurn:true, curBet:0,
      }});
      return;
    }



    // ══════════════════════════════════════════════════════════════
    // GO ONLINE HANDLERS
    // ══════════════════════════════════════════════════════════════

    if(action === 'go_rules_chosen') {
      if(!room) return;
      room.goRules = data.rules || {countMethod:'territory',komi:6.5};
      socket.to(roomId).emit('game_action',{uid:'server',action:'go_rules_chosen',data:{rules:room.goRules}});
      return;
    }

    if(action === 'go_init') {
      if(!room) return;
      const rules = data.rules || room.goRules || {countMethod:'territory',komi:6.5};
      room.goRules = rules;
      if(!room.goState) {
        // Assign colors: first player = Black, second = White
        const colors = {};
        colors[room.players[0].uid] = 'B';
        colors[room.players[1].uid] = 'W';
        room.goState = {
          board: Array.from({length:19},()=>new Array(19).fill(null)),
          prevBoard: null,
          turn: 'B',
          passCount: 0,
          caps: {B:0,W:0},
          colors,
          phase: 'play',
          confirmations: {},
        };
        io.to(roomId).emit('game_action',{uid:'server',action:'go_start',data:{
          colors,
          countMethod: rules.countMethod,
          komi: rules.komi,
        }});
      }
      return;
    }

    if(action === 'go_move' && room?.goState) {
      const gs = room.goState;
      const {r, c, color} = data;
      if(gs.turn !== color) return;
      if(gs.colors[uid] !== color) return;
      // Validate and place
      if(gs.board[r][c]) return;
      const newBoard = gs.board.map(row=>row.slice());
      newBoard[r][c] = color;
      // Capture
      const opp = color==='B'?'W':'B';
      let captured = 0;
      const nb = (r2,c2) => [[r2-1,c2],[r2+1,c2],[r2,c2-1],[r2,c2+1]].filter(([a,b])=>a>=0&&a<19&&b>=0&&b<19);
      const group = (b,r2,c2) => {
        const col=b[r2][c2]; if(!col) return{stones:[],libs:[]};
        const vis=new Set(); const stones=[]; const libs=new Set();
        const q=[[r2,c2]];
        while(q.length){const[cr,cc]=q.pop();const k=cr+','+cc;if(vis.has(k))continue;vis.add(k);stones.push([cr,cc]);
          nb(cr,cc).forEach(([nr,nc])=>{const nk=nr+','+nc;if(!vis.has(nk)){if(!b[nr][nc])libs.add(nk);else if(b[nr][nc]===col)q.push([nr,nc]);}});}
        return{stones,libs:Array.from(libs)};
      };
      nb(r,c).forEach(([nr,nc])=>{
        if(newBoard[nr][nc]===opp){
          const g=group(newBoard,nr,nc);
          if(g.libs.length===0){captured+=g.stones.length;g.stones.forEach(([sr,sc])=>newBoard[sr][sc]=null);}
        }
      });
      // Check suicide
      const myG=group(newBoard,r,c);
      if(myG.libs.length===0&&captured===0) return; // illegal
      // Ko check
      if(gs.prevBoard){
        let same=true;
        outer:for(let i=0;i<19;i++)for(let j=0;j<19;j++)if(newBoard[i][j]!==gs.prevBoard[i][j]){same=false;break outer;}
        if(same) return;
      }
      gs.prevBoard = gs.board.map(r=>r.slice());
      gs.board = newBoard;
      gs.caps[opp] = (gs.caps[opp]||0) + captured;
      gs.turn = opp;
      gs.passCount = 0;
      io.to(roomId).emit('game_action',{uid,action:'go_move',data:{r,c,color,captured}});
      return;
    }

    if(action === 'go_pass' && room?.goState) {
      const gs = room.goState;
      const color = gs.colors[uid];
      if(gs.turn !== color) return;
      gs.passCount = (gs.passCount||0) + 1;
      gs.turn = color==='B'?'W':'B';
      io.to(roomId).emit('game_action',{uid,action:'go_pass',data:{color}});
      if(gs.passCount >= 2) {
        gs.phase = 'scoring';
        io.to(roomId).emit('game_action',{uid:'server',action:'go_scoring',data:{}});
      }
      return;
    }

    if(action === 'go_resign' && room?.goState) {
      const gs = room.goState;
      const winnerId = room.players.find(p=>p.uid!==uid)?.uid;
      const loserId = uid;
      io.to(roomId).emit('game_action',{uid:'server',action:'go_win',data:{winnerId,loserId,resigned:true,black:0,white:0,diff:0}});
      const bet = room.betAmount||0;
      if(bet>0&&winnerId){
        (async()=>{
          try{
            const lSnap=await db.collection('users').doc(loserId).get();
            const lChips=lSnap.exists?(lSnap.data().chips||0):0;
            const debit=Math.min(bet,Math.max(0,lChips));
            if(debit>0){
              // Sem transferência de fichas — jogo gratuito
            }
            const [wS,lS]=await Promise.all([db.collection('users').doc(winnerId).get(),db.collection('users').doc(loserId).get()]);
            io.to(roomId).emit('game_result',{winnerId,loserId,prize:bet,winnerChips:wS.data()?.chips||0,loserChips:lS.data()?.chips||0});
          }catch(e){console.error('Go resign error:',e);}
        })();
      }
      room.goState = null;
      return;
    }

    if(action === 'go_confirm_score' && room?.goState) {
      const gs = room.goState;
      gs.confirmations = gs.confirmations||{};
      gs.confirmations[uid] = data.deadStones||[];
      // Wait for both players to confirm
      if(Object.keys(gs.confirmations).length < 2) return;
      // Merge dead stones (union of both players' selections)
      const deadSet = new Set([...gs.confirmations[room.players[0].uid],...gs.confirmations[room.players[1].uid]]);
      const finalBoard = gs.board.map(r=>r.slice());
      deadSet.forEach(k=>{const[r,c]=k.split(',').map(Number);if(finalBoard[r]&&finalBoard[r][c])finalBoard[r][c]=null;});
      const rules = room.goRules||{countMethod:'territory',komi:6.5};
      // Score
      function scoreBoard(board,N,komi,method){
        let bS=0,wS=komi;
        const vis=Array.from({length:N},()=>new Array(N).fill(false));
        for(let i=0;i<N;i++)for(let j=0;j<N;j++){
          if(board[i][j]==='B')bS+=(method==='area'?1:0);
          else if(board[i][j]==='W')wS+=(method==='area'?1:0);
          else if(!vis[i][j]){
            const region=[],borders=new Set(),q=[[i,j]];
            while(q.length){const[cr,cc]=q.pop();if(vis[cr][cc])continue;vis[cr][cc]=true;region.push([cr,cc]);
              [[cr-1,cc],[cr+1,cc],[cr,cc-1],[cr,cc+1]].filter(([a,b])=>a>=0&&a<N&&b>=0&&b<N).forEach(([nr,nc])=>{
                if(board[nr][nc])borders.add(board[nr][nc]);else if(!vis[nr][nc])q.push([nr,nc]);});}
            if(borders.size===1){if(borders.has('B'))bS+=region.length;else wS+=region.length;}
          }
        }
        return{black:Math.round(bS*10)/10,white:Math.round(wS*10)/10};
      }
      const sc = scoreBoard(finalBoard,19,rules.komi,rules.countMethod);
      const blackWins = sc.black > sc.white;
      const blackUid = Object.entries(gs.colors).find(([k,v])=>v==='B')?.[0];
      const whiteUid = Object.entries(gs.colors).find(([k,v])=>v==='W')?.[0];
      const winnerId = blackWins ? blackUid : whiteUid;
      const loserId = blackWins ? whiteUid : blackUid;
      const diff = Math.abs(sc.black - sc.white);
      io.to(roomId).emit('game_action',{uid:'server',action:'go_win',data:{winnerId,loserId,black:sc.black,white:sc.white,diff,resigned:false}});
      const bet = room.betAmount||0;
      if(bet>0){
        (async()=>{
          try{
            const lSnap=await db.collection('users').doc(loserId).get();
            const lChips=lSnap.exists?(lSnap.data().chips||0):0;
            const debit=Math.min(bet,Math.max(0,lChips));
            if(debit>0){
              // Sem transferência de fichas — jogo gratuito
              const [wS,lS]=await Promise.all([db.collection('users').doc(winnerId).get(),db.collection('users').doc(loserId).get()]);
              io.to(roomId).emit('game_result',{winnerId,loserId,prize:bet,winnerChips:wS.data()?.chips||0,loserChips:lS.data()?.chips||0});
            }
          }catch(e){console.error('Go score error:',e);}
        })();
      }
      room.goState = null;
      return;
    }


    if(action === 'pife_decks_chosen') {
      if(!room) return;
      // Criador escolheu baralhos — broadcast para o outro jogador
      socket.to(roomId).emit('game_action', { uid, action: 'pife_decks_chosen', data });
      return;
    }

    if(action === 'pife_init') {
      if(!room) return;
      if(!room.pifeState) {
        // Cria e embaralha baralho com ids únicos (1 ou 2 baralhos)
        const nDecks = data.numDecks===2 ? 2 : 1;
        room.pifeNumDecks = nDecks;
        const suits=['♠','♥','♦','♣'], ranks=['A','2','3','4','5','6','7','8','9','10','J','Q','K'];
        let deck=[];
        for(let d=0;d<nDecks;d++)
          for(const su of suits) for(const r of ranks)
            deck.push({rank:r,suit:su,id:`${r}${su}_${d}_${Math.random().toString(36).slice(2)}`});
        for(let i=deck.length-1;i>0;i--){const j=Math.floor(Math.random()*(i+1));[deck[i],deck[j]]=[deck[j],deck[i]];}
        const hands={};
        for(const p of room.players) hands[p.uid]=deck.splice(0,9);
        const discardPile=[deck.splice(0,1)[0]];
        room.pifeState={deck,hands,discardPile,currentTurn:room.players[0].uid};
      }
      // Envia estado individual para cada jogador conectado
      for(const p of room.players){
        const pSock=[...io.sockets.sockets.values()].find(sk=>sk.data.uid===p.uid);
        if(pSock){
          const others=Object.entries(room.pifeState.hands).find(([k])=>k!==p.uid);
          pSock.emit('game_action',{uid:'server',action:'pife_state',data:{
            hand: room.pifeState.hands[p.uid],
            discard: room.pifeState.discardPile,
            deckCount: room.pifeState.deck.length,
            myTurn: room.pifeState.currentTurn===p.uid,
            oppHandSize: others?.[1]?.length||9,
          }});
        }
      }
      return;
    }

    // ── Pife: comprar carta ──
    if(action === 'pife_draw' && room?.pifeState) {
      const ps=room.pifeState;
      if(ps.currentTurn!==uid) return;
      let card;
      if(data.source==='discard'&&ps.discardPile.length>0){
        card=ps.discardPile.shift();
        ps.hands[uid].push(card);
        // Avisa quem comprou com a carta
        socket.emit('game_action',{uid:'server',action:'pife_drew',data:{card}});
        // Avisa adversário que comprou do descarte (sem revelar)
        socket.to(roomId).emit('game_action',{uid,action:'pife_draw_discard',data:{}});
      } else {
        if(ps.deck.length===0) return;
        card=ps.deck.shift();
        ps.hands[uid].push(card);
        socket.emit('game_action',{uid:'server',action:'pife_drew',data:{card}});
        socket.to(roomId).emit('game_action',{uid,action:'pife_draw',data:{}});
      }
      return;
    }

    // ── Pife: descartar ──
    if(action === 'pife_discard' && room?.pifeState) {
      const ps=room.pifeState;
      if(ps.currentTurn!==uid) return;
      const hand=ps.hands[uid];
      const card=data.card||hand.splice(data.idx,1)[0];
      // Remove da mão se ainda estiver lá
      if(!data.card) {} else {
        const idx=hand.findIndex(c=>c.rank===card.rank&&c.suit===card.suit);
        if(idx>=0) hand.splice(idx,1);
      }
      ps.discardPile.unshift(card);
      // Próximo turno
      const pidx=room.players.findIndex(p=>p.uid===uid);
      ps.currentTurn=room.players[(pidx+1)%room.players.length].uid;
      io.to(roomId).emit('game_action',{uid,action:'pife_discard',data:{card,idx:data.idx}});
      return;
    }

    // ── Pife: declarar pife (valida no servidor) ──
    if(action === 'pife_declare') {
      const hand = data.hand || [];
      if(hand.length !== 9){ socket.emit('game_action',{uid:'server',action:'pife_invalid',data:{}}); return; }
      // Valida que as cartas declaradas estão na mão real do jogador
      const realHand = room.pifeState?.hands[uid] || [];
      const declaredIds = hand.map(c=>c.id).filter(Boolean);
      const realIds = realHand.map(c=>c.id).filter(Boolean);
      if(declaredIds.length===9 && realIds.length>0){
        const valid = declaredIds.every(id=>realIds.includes(id)) && new Set(declaredIds).size===9;
        if(!valid){ socket.emit('game_action',{uid:'server',action:'pife_invalid',data:{}}); return; }
      }
      // Valida grupos
      const vals={'A':1,'2':2,'3':3,'4':4,'5':5,'6':6,'7':7,'8':8,'9':9,'10':10,'J':11,'Q':12,'K':13};
      const isGroup=(g)=>{
        if(g.length!==3)return false;
        if(g[0].rank===g[1].rank&&g[1].rank===g[2].rank)return true;
        if(g[0].suit===g[1].suit&&g[1].suit===g[2].suit){
          const v=g.map(c=>vals[c.rank]).sort((a,b)=>a-b);
          if(v[1]===v[0]+1&&v[2]===v[1]+1)return true;
          if(JSON.stringify(v)==='[1,12,13]')return true;
        }
        return false;
      };
      const check=(rem,groups)=>{
        if(groups===3)return rem.length===0;
        if(rem.length<3)return false;
        for(let i=1;i<rem.length;i++){
          for(let j=i+1;j<rem.length;j++){
            const g=[rem[0],rem[i],rem[j]];
            if(isGroup(g)){
              const rest=rem.filter((_,idx)=>idx!==0&&idx!==i&&idx!==j);
              if(check(rest,groups+1))return true;
            }
          }
        }
        return false;
      };
      if(!check(hand,0)){ socket.emit('game_action',{uid:'server',action:'pife_invalid',data:{}}); return; }
      const winnerId=uid;
      const loserId=room?.players.find(p=>p.uid!==uid)?.uid;
      // Envia mãos de todos para revelação final
      const allHands={};
      for(const p of room.players) allHands[p.uid]={hand:room.pifeState?.hands[p.uid]||[],name:p.name};
      io.to(roomId).emit('game_action',{uid:'server',action:'pife_win',data:{winnerId,loserId,allHands}});
      // Processa débito/crédito via game_over
      const bet=room.betAmount||0;
      if(bet>0&&winnerId&&loserId){
        (async()=>{
          try{
            const loserSnap=await db.collection('users').doc(loserId).get();
            const loserChips=loserSnap.exists?(loserSnap.data().chips||0):0;
            const debit=Math.min(bet,Math.max(0,loserChips));
            if(debit>0){
              // Sem transferência de fichas — jogo gratuito
              await logTransaction(winnerId,'win',debit,`Pife — ganhou de ${room.players.find(p=>p.uid===loserId)?.name}`);
              await logTransaction(loserId,'loss',-debit,`Pife — perdeu para ${room.players.find(p=>p.uid===winnerId)?.name}`);
              // Notifica saldos atualizados
              const [wSnap,lSnap]=await Promise.all([
                db.collection('users').doc(winnerId).get(),
                db.collection('users').doc(loserId).get(),
              ]);
              io.to(roomId).emit('game_result',{
                winnerId,loserId,prize:debit,
                winnerChips:wSnap.data()?.chips||0,
                loserChips:lSnap.data()?.chips||0,
              });
              const wpife = room.players.find(p=>p.uid===winnerId);
              if(wpife) wpife.score = (wpife.score||0)+1;;
            }
          }catch(e){console.error('Erro ao processar pife:',e);}
        })();
      }
      return;
    }

        // ── Dominó Online ─────────────────────────────────────────
    if(action === 'domino_rules_chosen') {
      if(!room) return;
      // Criador escolheu regras — salva e broadcast pro adversário
      room.dominoRules = data.rules || {duasPontas:1,bateDe4:1};
      socket.to(roomId).emit('game_action',{uid:'server',action:'domino_rules_chosen',data:{rules:room.dominoRules}});
      return;
    }

    if(action === 'domino_init') {
      if(!room) return;
      if(!room.dominoState) {
        // Gera 28 peças de dominó [0-0 até 6-6]
        let pieces=[];
        for(let a=0;a<=6;a++) for(let b=a;b<=6;b++) pieces.push({a,b});
        // Embaralha
        for(let i=pieces.length-1;i>0;i--){const j=Math.floor(Math.random()*(i+1));[pieces[i],pieces[j]]=[pieces[j],pieces[i]];}
        const hands={};
        for(const p of room.players) hands[p.uid]=pieces.splice(0,7);
        const dominoRules=data.rules||room.dominoRules||{duasPontas:1,bateDe4:1};
        room.dominoState={hands,board:[],boardEnds:{left:null,right:null},stock:pieces,currentTurn:room.players[0].uid,passCount:0,rules:dominoRules};
      }
      for(const p of room.players){
        const pSock=[...io.sockets.sockets.values()].find(sk=>sk.data.uid===p.uid);
        if(pSock){
          const opp=Object.entries(room.dominoState.hands).find(([k])=>k!==p.uid);
          pSock.emit('game_action',{uid:'server',action:'domino_state',data:{
            hand:room.dominoState.hands[p.uid],
            board:room.dominoState.board,
            boardEnds:room.dominoState.boardEnds,
            oppCount:opp?.[1]?.length||7,
            stockCount:room.dominoState.stock.length,
            myTurn:room.dominoState.currentTurn===p.uid,
          }});
        }
      }
      return;
    }

    if(action === 'domino_play' && room?.dominoState) {
      const ds=room.dominoState;
      if(ds.currentTurn!==uid) return;
      const {piece,handIdx,side}=data;
      // Coloca na mesa
      let newPiece={...piece};
      if(ds.board.length===0){
        ds.board.push(newPiece);
        ds.boardEnds={left:newPiece.a,right:newPiece.b};
      } else if(side==='left'){
        if(newPiece.b!==ds.boardEnds.left) newPiece={a:newPiece.b,b:newPiece.a};
        ds.board.unshift(newPiece);
        ds.boardEnds.left=newPiece.a;
      } else {
        if(newPiece.a!==ds.boardEnds.right) newPiece={a:newPiece.b,b:newPiece.a};
        ds.board.push(newPiece);
        ds.boardEnds.right=newPiece.b;
      }
      // Remove da mão
      ds.hands[uid].splice(handIdx,1);
      ds.passCount=0;
      // Próximo turno
      const pidx=room.players.findIndex(p=>p.uid===uid);
      ds.currentTurn=room.players[(pidx+1)%room.players.length].uid;
      io.to(roomId).emit('game_action',{uid,action:'domino_played',data:{board:ds.board,boardEnds:ds.boardEnds,handIdx,stockCount:ds.stock?.length||0}});
      // Verifica vitória (mão vazia)
      if(ds.hands[uid].length===0){
        const loserId=room.players.find(p=>p.uid!==uid)?.uid;
        // Detecta nojada
        const r=ds.rules||{duasPontas:1,bateDe4:1};
        const l=ds.boardEnds.left, rv=ds.boardEnds.right;
        let nojada=null;
        if(l!==null&&l===rv){
          if(piece.a===piece.b&&piece.a===l&&r.bateDe4>0)
            nojada={type:'bateDe4',label:'🔥 BATE DE 4!',mult:r.bateDe4||1};
          else if(((piece.a===l&&piece.b===l)||(piece.b===l&&piece.a===l))&&r.duasPontas>0&&!nojada)
            nojada={type:'duasPontas',label:'⚡ BATEU NAS 2 PONTAS!',mult:r.duasPontas||1};
        }
        const mult=nojada?nojada.mult:1;
        io.to(roomId).emit('game_action',{uid:'server',action:'domino_win',data:{winnerId:uid,loserId,nojada,mult}});
        // Debita/credita
        const bet=room.betAmount||0;
        if(bet>0&&loserId){
          (async()=>{
            try{
              const lSnap=await db.collection('users').doc(loserId).get();
              const lChips=lSnap.exists?(lSnap.data().chips||0):0;
              const debit=Math.min(bet*mult,Math.max(0,lChips));
              if(debit>0){
                const batch=db.batch();
                batch.update(db.collection('users').doc(loserId),{chips:admin.firestore.FieldValue.increment(-debit)});
                batch.update(db.collection('users').doc(uid),{chips:admin.firestore.FieldValue.increment(debit)});
                await batch.commit();
                await logTransaction(uid,'win',debit,`Dominó — vitória`);
                await logTransaction(loserId,'loss',-debit,`Dominó — derrota`);
                const [wS,lS]=await Promise.all([db.collection('users').doc(uid).get(),db.collection('users').doc(loserId).get()]);
                io.to(roomId).emit('game_result',{winnerId:uid,loserId,prize:debit,winnerChips:wS.data()?.chips||0,loserChips:lS.data()?.chips||0});
              const wdom = room.players.find(p=>p.uid===uid); if(wdom) wdom.score=(wdom.score||0)+1;
              }
            }catch(e){console.error('Erro dominó:',e);}
          })();
        }
      }
      return;
    }

    if(action === 'domino_draw' && room?.dominoState) {
      const ds=room.dominoState;
      if(ds.currentTurn!==uid) return;
      if(!ds.stock||ds.stock.length===0){
        socket.emit('game_action',{uid:'server',action:'domino_pass',data:{name:'Monte vazio'}});
        return;
      }
      const piece=ds.stock.shift();
      ds.hands[uid].push(piece);
      // Avisa quem comprou com a peça
      socket.emit('game_action',{uid:'server',action:'domino_drew',data:{piece,stockCount:ds.stock.length}});
      // Avisa adversário
      socket.to(roomId).emit('game_action',{uid,action:'domino_draw',data:{stockCount:ds.stock.length}});
      // Se peça não encaixa, passa a vez automaticamente
      const {left,right}=ds.boardEnds;
      const fits=ds.board.length===0||piece.a===left||piece.b===left||piece.a===right||piece.b===right;
      if(!fits){
        ds.passCount=(ds.passCount||0)+1;
        const pidx=room.players.findIndex(p=>p.uid===uid);
        ds.currentTurn=room.players[(pidx+1)%room.players.length].uid;
        const passer=room.players.find(p=>p.uid===uid);
        io.to(roomId).emit('game_action',{uid,action:'domino_pass',data:{name:passer?.name,auto:true}});
      } else {
        ds.passCount=0; // peça encaixa, zera o contador
      }
      return;
    }

        if(action === 'domino_pass' && room?.dominoState) {
      const ds=room.dominoState;
      if(ds.currentTurn!==uid) return;
      ds.passCount=(ds.passCount||0)+1;
      const pidx=room.players.findIndex(p=>p.uid===uid);
      ds.currentTurn=room.players[(pidx+1)%room.players.length].uid;
      // Notifica todos com nome de quem bateu
      const passer=room.players.find(p=>p.uid===uid);
      io.to(roomId).emit('game_action',{uid,action:'domino_pass',data:{name:passer?.name||'Jogador'}});
      // Todos passaram = jogo fechado → menor pontuação vence
      if(ds.passCount>=room.players.length){
        let winner=null,loser=null,minPts=Infinity;
        for(const p of room.players){
          const pts=(ds.hands[p.uid]||[]).reduce((acc,pc)=>acc+pc.a+pc.b,0);
          if(pts<minPts){minPts=pts;winner=p.uid;}
        }
        loser=room.players.find(p=>p.uid!==winner)?.uid;
        // Calcula pontos de cada um para exibição
        const scores={};
        for(const p of room.players) scores[p.uid]=(ds.hands[p.uid]||[]).reduce((acc,pc)=>acc+pc.a+pc.b,0);
        io.to(roomId).emit('game_action',{uid:'server',action:'domino_win',data:{winnerId:winner,loserId:loser,scores,reason:'bateu'}});
        // Debita/credita fichas
        const bet=room.betAmount||0;
        if(bet>0&&winner&&loser){
          (async()=>{
            try{
              const lSnap=await db.collection('users').doc(loser).get();
              const lChips=lSnap.exists?(lSnap.data().chips||0):0;
              const debit=Math.min(bet,Math.max(0,lChips));
              if(debit>0){
                const batch=db.batch();
                batch.update(db.collection('users').doc(loser),{chips:admin.firestore.FieldValue.increment(-debit)});
                batch.update(db.collection('users').doc(winner),{chips:admin.firestore.FieldValue.increment(debit)});
                await batch.commit();
                await logTransaction(winner,'win',debit,'Dominó — bateu');
                await logTransaction(loser,'loss',-debit,'Dominó — perdeu no bate');
                const [wS,lS]=await Promise.all([db.collection('users').doc(winner).get(),db.collection('users').doc(loser).get()]);
                io.to(roomId).emit('game_result',{winnerId:winner,loserId:loser,prize:debit,winnerChips:wS.data()?.chips||0,loserChips:lS.data()?.chips||0});
              const wdom = room.players.find(p=>p.uid===winner); if(wdom) wdom.score=(wdom.score||0)+1;
              }
            }catch(e){console.error('Erro bate dominó:',e);}
          })();
        }
      }
      return;
    }

    // Outros jogos: repassa direto (exceto dama e xadrez que têm handlers próprios)
    if (!['dama_init','dama_move','xadrez_init','xadrez_move','xadrez_win'].includes(action)) {
      socket.to(roomId).emit('game_action', { uid, action, data });
      return;
    }

  // ── Dama Online ────────────────────────────────────
    if (action === 'dama_init') {
      // Atribui cores: players[0]=brancas, players[1]=pretas
      room.players.forEach((p, i) => { p.damaColor = i === 0 ? 'w' : 'b'; });
      // Envia para a sala inteira — cada cliente filtra a sua cor pelo uid
      const colorMap = {};
      room.players.forEach(p => { colorMap[p.uid] = p.damaColor; });
      io.to(roomId).emit('game_action', {
        action: 'dama_init', data: { colorMap }
      });
    }

    if (action === 'dama_move') {
      const myPlayer = room.players.find(p => p.uid === uid);
      const myColor = myPlayer?.damaColor;
      const nextTurn = data.nextTurn || (myColor === 'w' ? 'b' : 'w');
      room.damaBoard = data.board;
      room.damaTurn = nextTurn;
      io.to(roomId).emit('game_action', {
        action: 'dama_update',
        data: { board: data.board, turn: nextTurn }
      });
      const oColor = myColor === 'w' ? 'b' : 'w';
      const hasPieces = data.board.some(row => row.some(c => c && c.color === oColor));
      if (!hasPieces) {
        const opp = room.players.find(p => p.uid !== uid);
        io.to(roomId).emit('game_action', { action: 'dama_win', data: { winnerId: uid, loserId: opp?.uid } });
        io.to(roomId).emit('game_result', { winnerId: uid, loserId: opp?.uid, prize: room.betAmount });
        scheduleReset(room, roomId);
      }
    }

    // Proposta de empate
    if (action === 'dama_draw_offer') {
      if(!room) return;
      socket.to(roomId).emit('game_action', { action: 'dama_draw_offer', data: { fromUid: uid } });
      return;
    }

    if (action === 'dama_draw_accept') {
      if(!room) return;
      // Empate — devolve fichas para ambos (sem transferência)
      io.to(roomId).emit('game_action', { action: 'dama_win', data: { draw: true, winnerId: null, loserId: null } });
      // Devolve aposta a ambos (ninguém perde fichas)
      io.to(roomId).emit('game_result', { draw: true, winnerId: null, loserId: null, prize: 0 });
      scheduleReset(room, roomId);
      return;
    }

    if (action === 'dama_draw_decline') {
      if(!room) return;
      socket.to(roomId).emit('game_action', { action: 'dama_draw_declined', data: {} });
      return;
    }

    // Passar a vez (bloqueio/trancado)
    if (action === 'dama_pass') {
      if(!room) return;
      room.damaBoard = data.board;
      const nextTurn = data.nextTurn;
      io.to(roomId).emit('game_action', {
        action: 'dama_pass',
        data: { board: data.board, turn: nextTurn }
      });
    }

    // Declarar derrota voluntária (bloqueio)
    if (action === 'dama_forfeit') {
      if(!room) return;
      const winnerId = room.players.find(p => p.uid !== uid)?.uid;
      const loserId = uid;
      io.to(roomId).emit('game_action', { action: 'dama_win', data: { winnerId, loserId } });
      const bet = room.betAmount || 0;
      if (bet > 0 && winnerId) {
        (async () => {
          try {
            const lSnap = await db.collection('users').doc(loserId).get();
            const lChips = lSnap.exists ? (lSnap.data().chips || 0) : 0;
            const debit = Math.min(bet, Math.max(0, lChips));
            if (debit > 0) {
              const batch = db.batch();
              batch.update(db.collection('users').doc(loserId), { chips: admin.firestore.FieldValue.increment(-debit) });
              batch.update(db.collection('users').doc(winnerId), { chips: admin.firestore.FieldValue.increment(debit) });
              await batch.commit();
            }
            const [wS, lS] = await Promise.all([
              db.collection('users').doc(winnerId).get(),
              db.collection('users').doc(loserId).get()
            ]);
            io.to(roomId).emit('game_result', { winnerId, loserId, prize: bet, winnerChips: wS.data()?.chips || 0, loserChips: lS.data()?.chips || 0 });
          } catch(e) { console.error('dama_forfeit error:', e); }
        })();
      }
      scheduleReset(room, roomId);
    }

  // ── Xadrez Online ──────────────────────────────────
    if (action === 'xadrez_init') {
      room.players.forEach((p, i) => { p.xadrezColor = i === 0 ? 'w' : 'b'; });
      const colorMap = {};
      room.players.forEach(p => { colorMap[p.uid] = p.xadrezColor; });
      io.to(roomId).emit('game_action', { action: 'xadrez_init', data: { colorMap } });
    }

    if (action === 'xadrez_move') {
      const nextTurn = uid === room.players[0].uid ? 'b' : 'w';
      // Broadcast estado para todos
      io.to(roomId).emit('game_action', {
        action: 'xadrez_update',
        data: { board: data.board, turn: nextTurn, enPassant: data.enPassant, castling: data.castling, lastMove: { from: data.from, to: data.to } }
      });
    }

    if (action === 'xadrez_win') {
      const loserId = room.players.find(p => p.uid !== data.winnerId)?.uid;
      io.to(roomId).emit('game_action', { action: 'xadrez_win', data: { winnerId: data.winnerId, loserId, reason: data.reason } });
      io.to(roomId).emit('game_result', { winnerId: data.winnerId, loserId, prize: room.betAmount });
      scheduleReset(room, roomId);
    }
  });

  // ── Fim de jogo ─────────────────────────────────────────
  socket.on('game_over', async ({ roomId, winnerId, loserId }) => {
    const room = rooms.get(roomId);
    if (!room || room.status !== 'playing') return;
    room.status = 'finished';

    const bet = room.betAmount || 0;

    // Debita do perdedor e credita no vencedor
    if (bet > 0 && winnerId && loserId && winnerId !== loserId) {
      try {
        const batch = db.batch();
        // Verifica saldo do perdedor
        const loserSnap = await db.collection('users').doc(loserId).get();
        const loserChips = loserSnap.exists ? (loserSnap.data().chips || 0) : 0;
        const debit = Math.min(bet, loserChips); // nunca vai negativo

        if (debit > 0) {
          batch.update(db.collection('users').doc(loserId), {
            chips: admin.firestore.FieldValue.increment(-debit),
          });
          batch.update(db.collection('users').doc(winnerId), {
            chips: admin.firestore.FieldValue.increment(debit),
          });
          await batch.commit();
          await logTransaction(winnerId, 'win',  debit, `Vitória em ${room.game}`);
          await logTransaction(loserId,  'loss', -debit, `Derrota em ${room.game}`);
        }

        // Notifica resultado com saldos atualizados
        const [wSnap, lSnap] = await Promise.all([
          db.collection('users').doc(winnerId).get(),
          db.collection('users').doc(loserId).get(),
        ]);
        io.to(roomId).emit('game_result', {
          winnerId, loserId, prize: debit,
          winnerChips: wSnap.data()?.chips || 0,
          loserChips:  lSnap.data()?.chips || 0,
        });
      } catch(e) {
        console.error('Erro ao processar resultado:', e);
        io.to(roomId).emit('game_result', { winnerId, loserId, prize: 0 });
      }
    } else {
      io.to(roomId).emit('game_result', { winnerId, loserId, prize: 0 });
    }

    // Incrementa vitórias do vencedor na sala
    if(winnerId) {
      const wp = room.players.find(p=>p.uid===winnerId);
      if(wp) { wp.score = (wp.score||0)+1; }
    }
    if (room.matchId) {
      await db.collection('matches').doc(room.matchId).update({
        status: 'finished', winnerId, loserId,
        finishedAt: admin.firestore.FieldValue.serverTimestamp(),
      }).catch(()=>{});
    }

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

  socket.on('chat_audio', ({ roomId, audio, mimeType }) => {
    if (!audio || typeof audio !== 'string' || audio.length > 700000) return;
    if (!audio.startsWith('data:audio/')) return;
    io.to(roomId).emit('chat_audio', {
      uid, name: user.name, audio, mimeType, time: Date.now()
    });
  });


  // ── WebRTC Sinalização (chamada de voz) ──────────────────
  socket.on('webrtc_call_request', ({ roomId, offer, uid: callerUid }) => {
    // Encaminha offer para o outro jogador da sala
    socket.to(roomId).emit('webrtc_call_request', { offer, uid: callerUid });
  });

  socket.on('webrtc_call_accept', ({ roomId, answer, uid: acceptUid }) => {
    socket.to(roomId).emit('webrtc_call_accept', { answer, uid: acceptUid });
  });

  socket.on('webrtc_call_reject', ({ roomId, uid: rejectUid }) => {
    socket.to(roomId).emit('webrtc_call_reject', { uid: rejectUid });
  });

  socket.on('webrtc_call_end', ({ roomId }) => {
    socket.to(roomId).emit('webrtc_call_end', { uid });
  });

  socket.on('webrtc_ice', ({ roomId, candidate }) => {
    socket.to(roomId).emit('webrtc_ice', { candidate, uid });
  });

  socket.on('webrtc_speaking', ({ roomId, speaking }) => {
    socket.to(roomId).emit('webrtc_speaking', { uid, speaking });
  });

  // ── Rematch simplificado ─────────────────────────────────
  socket.on('rematch_join', ({ roomId }) => {
    const room = rooms.get(roomId);
    if(!room) return;
    if(!room.rematchPlayers) room.rematchPlayers = new Set();
    room.rematchPlayers.add(uid);
    const player = room.players.find(p => p.uid === uid);
    const total = room.players.length;
    const count = room.rematchPlayers.size;
    io.to(roomId).emit('rematch_player', { name: player?.name || 'Jogador', count, total });
    if(count >= total) { startRematch(room, roomId); return; }
    if(count === 1) {
      // Inicia countdown de 10s no backend
      let remaining = 10;
      room.rematchCountdown = setInterval(() => {
        remaining--;
        io.to(roomId).emit('rematch_countdown', { remaining });
        if(remaining <= 0) {
          clearInterval(room.rematchCountdown);
          room.rematchCountdown = null;
          startRematch(room, roomId);
        }
      }, 1000);
    }
  });

  socket.on('leave_room', ({ roomId }) => {
    const room = rooms.get(roomId);
    if (room) {
      // Primeiro marca offline e avisa — para o outro jogador ver "📴 Offline"
      const player = room.players.find(p => p.uid === uid);
      if (player) {
        player.online = false;
        player.ready = false;
        player.disconnectedAt = Date.now();
        io.to(roomId).emit('room_update', room);
        io.to(roomId).emit('player_offline', { uid, room });
        console.log(`🚪 ${user?.name} saiu da sala ${roomId}`);
      }
      // Depois remove
      room.players = room.players.filter(p => p.uid !== uid);
      if (room.players.length === 0) {
        if (room.rematchCountdown) clearInterval(room.rematchCountdown);
        if (room.rematchTimeout) clearTimeout(room.rematchTimeout);
        rooms.delete(roomId);
        console.log(`🗑️ Sala ${roomId} removida (todos saíram)`);
      }
      io.to('lobby').emit('rooms_update', getRoomsList());
    }
    socket.leave(roomId);
  });

  socket.on('rematch_leave', ({ roomId }) => {
    // Jogador clicou sair após partida
    const room = rooms.get(roomId);
    if(room) {
      room.players = room.players.filter(p => p.uid !== uid);
      if(room.players.length === 0) {
        if(room.rematchCountdown) clearInterval(room.rematchCountdown);
        if(room.rematchTimeout) clearTimeout(room.rematchTimeout);
        rooms.delete(roomId);
      } else {
        io.to(roomId).emit('room_update', room);
      }
      io.to('lobby').emit('rooms_update', getRoomsList());
    }
    socket.leave(roomId);
    socket.emit('room_left', {});
  });

  async function startRematch(room, roomId) {
    if(room.rematchTimeout) { clearTimeout(room.rematchTimeout); room.rematchTimeout = null; }
    if(room.rematchCountdown) { clearInterval(room.rematchCountdown); room.rematchCountdown = null; }
    room.rematchPlayers = null;
    room.pifeState = null;
    room.dominoState = null;
    room.matchId = null;
    room.status = 'playing';
    room.players.forEach(p => p.ready = true);
    try {
      const matchRef = await db.collection('matches').add({
        roomId, game: room.game, betAmount: room.betAmount,
        players: room.players.map(p => p.uid),
        status: 'playing',
        createdAt: admin.firestore.FieldValue.serverTimestamp(),
      });
      room.matchId = matchRef.id;
    } catch(e) { console.error('Erro match rematch:', e); }
    io.to(roomId).emit('game_start', { room, matchId: room.matchId });
    io.to('lobby').emit('rooms_update', getRoomsList());
    console.log(`🔄 Rematch: ${room.game} sala ${roomId}`);
  }

  // ── Desconexão ───────────────────────────────────────────
  socket.on('reset_room', ({ roomId }) => {
    const room = rooms.get(roomId);
    if(!room) return;
    room.status = 'waiting';
    room.pifeState = null;
    room.dominoState = null;
    room.matchId = null;
    room.players.forEach(p => { p.ready = false; });
    io.to(roomId).emit('room_update', room);
    io.to('lobby').emit('rooms_update', getRoomsList());
  });

  socket.on('schedule_reset', ({ roomId }) => {
    const room = rooms.get(roomId);
    if(!room || room.resetTimeout) return;
    // Só o criador (players[0]) pode reiniciar
    if(room.players[0]?.uid !== uid) return;
    io.to(roomId).emit('rematch_countdown_start', {});
    scheduleReset(room, roomId);
  });

  socket.on('disconnect', () => {
    console.log(`❌ Desconectado: ${user?.name}`);
    for (const [roomId, room] of rooms.entries()) {
      const player = room.players.find(p => p.uid === uid);
      if (player) {
        player.online = false;
        player.ready = false;  // reset pronto ao desconectar
        player.disconnectedAt = Date.now();
        // Avisa outros na sala
        io.to(roomId).emit('player_offline', { uid, room });
        io.to(roomId).emit('room_update', room); // força atualização visual
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
server.listen(PORT, () => console.log(`🎰 Cassino Backend rodando na porta ${PORT}`));