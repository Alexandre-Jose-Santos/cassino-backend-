// ============================================================
// CASSIANO CASINO — BACKEND COMPLETO
// Node.js + Express + Socket.io + Firebase Admin + Mercado Pago
// ============================================================
const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const admin = require('firebase-admin');
const cors = require('cors');
const crypto = require('crypto');
require('dotenv').config();

// â”€ â”€ Inicialização do administrador do Firebase -”€-”€-”€-”€-”€-”€-”€-”€-”€-”€-”€-”€-”€-”€-”€-”€-”€-
admin.initializeApp({
  credencial: admin.credential.cert({
    projectId: process.env.FIREBASE_PROJECT_ID,
    clientEmail: process.env.FIREBASE_CLIENT_EMAIL,
    privateKey: process.env.FIREBASE_PRIVATE_KEY?.replace(/\\n/g, '\n'),
  }),
});
const db = admin.firestore();

// â”€â”€ Expresso + CORS â”€-”€-”€-”€-”€-”€-”€-”- ”€-”€-”€-”€-”€-”€-”€-”€-”€-”€-”€-”€-”€-”€-”€-”€-”€-”€-”
const app = express();
const server = http.createServer(app);
const io = novo Servidor(servidor, {
  cors: { origin: process.env.FRONTEND_URL || '*', methods: ['GET','POST'], credentials: true },
  pingTimeout: 60000,
  pingInterval: 25000,
  transportes: ['websocket', 'polling'],
});

// Keep-alive: evita que o Railway adormeça (free tier dorme após inatividade)
setInterval(() => {
  const domain = process.env.RAILWAY_PUBLIC_DOMAIN;
  se (!domínio) retornar;
  require('https').get(`https://${domain}/health`, r => {
    console.log(`ðŸ'“ Keep-alive: ${r.statusCode} | salas: ${rooms.size} | conexões: ${io.sockets.sockets.size}`);
  }).on('error', e => console.warn('Keep-alive falhou:', e.message));
}, 4*60*1000); // a cada 4 minutos

app.use(cors({ origin: process.env.FRONTEND_URL || '*' }));
app.get('/health', (req, res) => res.json({ status: 'ok', rooms: rooms.size, connections: io.sockets.sockets.size, uptime: Math.floor(process.uptime()) }));
app.use(express.json());

// -”€”€ Configuração do Mercado Pago -”€-”€-”€-”€-”€-”€-”€-”€-”€-”€-”€-”€-”€-”€-”€-”€-”€-
// MODO SANDBOX ATÉ TER CNPJ/LICENÇA — troca ACCESS_TOKEN por produção depois
const MP_TOKEN = process.env.MP_ACCESS_TOKEN; // token de sandbox por agora

// â”€â”€ Pacotes de Fichas â”€-”€-”€-”€-”€-”€-”€-”€-”€ -” ”€-”€-”€-”€-”€-”€-”€-”€-”€-”€-”€
const PACOTES = [
  { id: 'pkg_5', label: 'Inicial', price: 5, chips: 500, bonus: 0 },
  { id: 'pkg_10', label: 'Popular', price: 10, chips: 1000, bonus: 100 },
  { id: 'pkg_25', label: 'Pro', price: 25, chips: 2700, bonus: 300 },
  { id: 'pkg_50', label: 'VIP', price: 50, chips: 6000, bonus: 1000 },
];

const SAQUE_TAXA = 0,10; // 10% de impostos sobre saques

// â• â• â• â• â• â• â• â• â• â• â• â• â• â• â• â• â• â• â• â• â• â• â• â• â• â• â• â• â• â• â• â• â• â• â• â• â• â• â• â• â• â• â• â• â• â• â• â• â• â• â• â• â• â• â• â• â• â• â•
// ROTAS DE AUTENTICAÇAO
// â• â• â• â• â• â• â• â• â• â• â• â• â• â• â• â• â• â• â• â• â• â• â• â• â• â• â• â• â• â• â• â• â• â• â• â• â• â• â• â• â• â• â• â• â• â• â• â• â• â• â• â• â• â• â• â• â• â• â•

// Middleware: token do Firebase verifica
função assíncrona authMiddleware(req, res, next) {
  const token = req.headers.authorization?.split('Bearer ')[1];
  if (!token) return res.status(401).json({ error: 'Token ausente' });
  tentar {
    req.user = await admin.auth().verifyIdToken(token);
    próximo();
  } pegar {
    res.status(401).json({ error: 'Token inválido' });
  }
}

// Cria/atualiza perfil ao fazer login
app.post('/api/auth/profile', authMiddleware, async (req, res) => {
  const { uid, email, name, picture } = req.user;
  const userRef = db.collection('users').doc(uid);
  const snap = await userRef.get();

  se (!snap.exists) {
    aguarde userRef.set({
      uid, e-mail,
      nome: nome || email.split('@')[0],
      avatar: imagem || '',
      fichas: 150, // bônus de boas-vindas
      totalDepositado: 0,
      totalDetirados: 0,
      criadoEm: admin.firestore.FieldValue.serverTimestamp(),
      status: 'ativo',
    });
    // Log transação de bônus
    await logTransaction(uid, 'bonus', 150, 'Bônus de boas-vindas');
  }

  const data = (await userRef.get()).data();
  res.json({ sucesso: true, usuário: dados });
});

// â• â• â• â• â• â• â• â• â• â• â• â• â• â• â• â• â• â• â• â• â• â• â• â• â• â• â• â• â• â• â• â• â• â• â• â• â• â• â• â• â• â• â• â• â• â• â• â• â• â• â• â• â• â• â• â• â• â• â•
// ROTAS DE PAGAMENTO — MERCADO PAGO PIX
// â• â• â• â• â• â• â• â• â• â• â• â• â• â• â• â• â• â• â• â• â• â• â• â• â• â• â• â• â• â• â• â• â• â• â• â• â• â• â• â• â• â• â• â• â• â• â• â• â• â• â• â• â• â• â• â• â• â• â•

// Gera cobrança PIX
app.post('/api/payment/create', authMiddleware, async (req, res) => {
  const { packageId } = req.body;
  const pkg = PACKAGES.find(p => p.id === packageId);
  if (!pkg) return res.status(400).json({ error: 'Pacote inválido' });

  const { uid, email, name } = req.user;
  const idempotencyKey = crypto.randomUUID();

  tentar {
    const response = await fetch('https://api.mercadopago.com/v1/payments', {
      método: 'POST',
      cabeçalhos: {
        'Content-Type': 'application/json',
        'Autorização': `Portador ${MP_TOKEN}`,
        'X-Idempotency-Key': idempotencyKey,
      },
      corpo: JSON.stringify({
        valor_da_transação: preço_do_pacote,
        descrição: `Cassiano Casino â— ${pkg.label} (${pkg.chips + pkg.bonus} fichas)`,
        id_método_de_pagamento: 'pix',
        pagador: { email, nome: nome || 'Jogador' },
        notification_url: `${process.env.BACKEND_URL}/api/payment/webhook`,
        metadados: {
          user_id: uid,
          id_do_pacote: id_do_pacote,
          chips: pkg.chips + pkg.bonus,
        },
      }),
    });

    const data = await response.json();
    if (!response.ok) throw new Error(data.message || 'Erro Mercado Pago');

    // Salva pagamento pendente no Firestore
    await db.collection('payments').doc(String(data.id)).set({
      paymentId: data.id,
      ID do usuário: uid,
      id do pacote,
      preço: preço do pacote,
      chips: pkg.chips + pkg.bonus,
      status: 'pendente',
      criadoEm: admin.firestore.FieldValue.serverTimestamp(),
    });

    res.json({
      sucesso: verdadeiro,
      paymentId: data.id,
      Código QR: data.point_of_interaction?.transaction_data?.qr_code,
      qrCodeB64: data.point_of_interaction?.transaction_data?.qr_code_base64,
      pixKey: data.point_of_interaction?.transaction_data?.qr_code,
    });

  } catch (erro) {
    console.error('Erro ao criar pagamento:', err);
    res.status(500).json({ error: err.message });
  }
});

// Webhook Mercado Pago — confirma pagamento
app.post('/api/payment/webhook', async (req, res) => {
  res.sendStatus(200); // responde rápido pro MP

  const { ação, dados } = req.body;
  se (ação !== 'pagamento.atualizado') retornar;

  tentar {
    const response = await fetch(`https://api.mercadopago.com/v1/payments/${data.id}`, {
      cabeçalhos: { 'Authorization': `Bearer ${MP_TOKEN}` }
    });
    const pagamento = aguardar resposta.json();
    se (pagamento.status !== 'aprovado') retorne;

    const payRef = db.collection('payments').doc(String(data.id));
    const paySnap = await payRef.get();
    Se (!paySnap.exists) retorne;

    const pay = paySnap.data();
    if (pay.status === 'approved') return; // já processei

    // Crédito fichas
    await db.collection('users').doc(pay.userId).update({
      chips: admin.firestore.FieldValue.increment(pay.chips),
      totalDepositado: admin.firestore.FieldValue.increment(pay.price),
    });

    await payRef.update({ status: 'approved', approvedAt: admin.firestore.FieldValue.serverTimestamp() });
    await logTransaction(pay.userId, 'deposit', pay.chips, `Compra via PIX â— R$${pay.price}`);

    // Notifica cliente em tempo real via Socket.io
    const userSockets = [...io.sockets.sockets.values()]
      .filter(s => s.data.uid === pay.userId);
    userSockets.forEach(s => s.emit('chips_credited', {
      fichas: pagar.fichas,
      mensagem: `âœ… PIX confirmado! +${pay.chips.toLocaleString()} fichas creditadas!`,
    }));

  } catch (erro) {
    console.error('Erro no webhook:', err);
  }
});

// â• â• â• â• â• â• â• â• â• â• â• â• â• â• â• â• â• â• â• â• â• â• â• â• â• â• â• â• â• â• â• â• â• â• â• â• â• â• â• â• â• â• â• â• â• â• â• â• â• â• â• â• â• â• â• â• â• â• â•
// ROTAS DE SAQUE
// ðŸ”' BLOQUEADO ATÉ OBTER LICENÇA — código pronto para ativar
// â• â• â• â• â• â• â• â• â• â• â• â• â• â• â• â• â• â• â• â• â• â• â• â• â• â• â• â• â• â• â• â• â• â• â• â• â• â• â• â• â• â• â• â• â• â• â• â• â• â• â• â• â• â• â• â• â• â• â•

app.post('/api/withdrawal/request', authMiddleware, async (req, res) => {
  // REMOVA ESTE BLOCO QUANDO TIVER LICENÇA:
  se (process.env.WITHDRAWALS_ENABLED !== 'true') {
    retornar res.status(403).json({
      erro: 'Saques temporariamente indisponíveis. Em breve!',
      bloqueado: verdadeiro,
    });
  }

  const { chips, pixKey } = req.body;
  if (!chips || chips < 100) return res.status(400).json({ error: 'Mínimo de 100 fichas para saque' });
  if (!pixKey) return res.status(400).json({ erro: 'Chave PIX obrigatÃ³ria' });

  const { uid } = req.user;
  const userRef = db.collection('users').doc(uid);
  const userSnap = await userRef.get();
  const user = userSnap.data();

  if (user.chips < chips) return res.status(400).json({ error: 'Saldo insuficiente' });

  const valor bruto = fichas/100; // 1 ficha = R$0,01? definir um táxon aqui
  taxa const = valorbruto * SAQUE_TAXA;
  const netValue = parseFloat((grossValue - fee).toFixed(2));

  // Deduz fichas e cria pedido de saque
  aguarde userRef.update({
    chips: admin.firestore.FieldValue.increment(-chips),
  });

  const withdrawalRef = await db.collection('withdrawals').add({
    ID do usuário: uid,
    Nome de usuário: nome.do.usuário,
    E-mail do usuário: user.email,
    batatas fritas,
    valor bruto,
    taxa,
    valor líquido,
    pixKey,
    status: 'pendente', // admin aprova manualmente
    criadoEm: admin.firestore.FieldValue.serverTimestamp(),
  });

  await logTransaction(uid, 'withdrawal_request', -chips, `Pedido de saque R$${netValue} (taxa 10%)`);

  res.json({
    sucesso: verdadeiro,
    withdrawId: withdrawRef.id,
    valor líquido,
    taxa,
    mensagem: `Pedido registrado! Você receberá R$${netValue} em até 24h.`,
  });
});

// â• â• â• â• â• â• â• â• â• â• â• â• â• â• â• â• â• â• â• â• â• â• â• â• â• â• â• â• â• â• â• â• â• â• â• â• â• â• â• â• â• â• â• â• â• â• â• â• â• â• â• â• â• â• â• â• â• â• â•
// ROTAS DO USUÁ RIO
// â• â• â• â• â• â• â• â• â• â• â• â• â• â• â• â• â• â• â• â• â• â• â• â• â• â• â• â• â• â• â• â• â• â• â• â• â• â• â• â• â• â• â• â• â• â• â• â• â• â• â• â• â• â• â• â• â• â• â•

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
    .pegar();
  res.json(snap.docs.map(d => ({ id: d.id, ...d.data() })));
});

// â• â• â• â• â• â• â• â• â• â• â• â• â• â• â• â• â• â• â• â• â• â• â• â• â• â• â• â• â• â• â• â• â• â• â• â• â• â• â• â• â• â• â• â• â• â• â• â• â• â• â• â• â• â• â• â• â• â• â•
// ROTAS DE ADMIN
// ðŸ”' Protegido por ADMIN_SECRET sem cabeçalho
// â• â• â• â• â• â• â• â• â• â• â• â• â• â• â• â• â• â• â• â• â• â• â• â• â• â• â• â• â• â• â• â• â• â• â• â• â• â• â• â• â• â• â• â• â• â• â• â• â• â• â• â• â• â• â• â• â• â• â•

função adminAuth(req, res, next) {
  se (req.headers['x-admin-secret'] !== process.env.ADMIN_SECRET)
    return res.status(403).json({ erro: 'Acesso negado' });
  próximo();
}

// Lista todos os usuários
app.get('/api/admin/users', adminAuth, async (req, res) => {
  const snap = await db.collection('users').orderBy('createdAt','desc').limit(100).get();
  res.json(snap.docs.map(d => d.data()));
});

// Lista de saques pendentes
app.get('/api/admin/withdrawals', adminAuth, async (req, res) => {
  const snap = await db.collection('withdrawals')
    .where('status', '==', 'pending')
    .orderBy('createdAt', 'asc')
    .pegar();
  res.json(snap.docs.map(d => ({ id: d.id, ...d.data() })));
});

// Aprova saque
app.post('/api/admin/withdrawals/:id/approve', adminAuth, async (req, res) => {
  const ref = db.collection('withdrawals').doc(req.params.id);
  const snap = await ref.get();
  if (!snap.exists) return res.status(404).json({ erro: 'Não encontrado' });

  await ref.update({ status: 'aprovado', approvedAt: admin.firestore.FieldValue.serverTimestamp() });
  const w = snap.data();
  await db.collection('users').doc(w.userId).update({
    totalWithdrawn: admin.firestore.FieldValue.increment(w.netValue),
  });
  await logTransaction(w.userId, 'withdrawal_approved', 0, `Saque aprovado R$${w.netValue}`);

  res.json({ sucesso: verdadeiro });
});

// Rejeita saque (devolver fichas)
app.post('/api/admin/withdrawals/:id/reject', adminAuth, async (req, res) => {
  const ref = db.collection('withdrawals').doc(req.params.id);
  const snap = await ref.get();
  if (!snap.exists) return res.status(404).json({ erro: 'Não encontrado' });

  const w = snap.data();
  await ref.update({ status: 'rejeitado', rejectedAt: admin.firestore.FieldValue.serverTimestamp() });
  await db.collection('users').doc(w.userId).update({
    chips: admin.firestore.FieldValue.increment(w.chips),
  });
  await logTransaction(w.userId, 'withdrawal_rejected', w.chips, 'Saque rejeitado — fichas devolvidas');

  res.json({ sucesso: verdadeiro });
});

// Painel financeiro
app.get('/api/admin/dashboard', adminAuth, async (req, res) => {
  const [usersSnap, paymentsSnap, withdrawsSnap] = await Promise.all([
    db.collection('users').get(),
    db.collection('payments').where('status','==','approved').get(),
    db.collection('withdrawals').where('status','==','approved').get(),
  ]);

  const totalUsers = usersSnap.size;
  const totalDeposits = paymentsSnap.docs.reduce((s,d) => s + d.data().price, 0);
  const totalWithdrawals = withdrawsSnap.docs.reduce((s,d) => s + d.data().netValue, 0);
  const totalFees = withdrawsSnap.docs.reduce((s,d) => s + d.data().fee, 0);

  res.json({
    totalUsuários,
    totalDeposits: totalDeposits.toFixed(2),
    totalWithdrawals: totalWithdrawals.toFixed(2),
    totalFees: totalFees.toFixed(2),
    saldo: (totalDepósitos - totalSaques).toFixed(2),
  });
});

// â• â• â• â• â• â• â• â• â• â• â• â• â• â• â• â• â• â• â• â• â• â• â• â• â• â• â• â• â• â• â• â• â• â• â• â• â• â• â• â• â• â• â• â• â• â• â• â• â• â• â• â• â• â• â• â• â• â• â•
// SOCKET.IO — MULTIJOGADOR
// â• â• â• â• â• â• â• â• â• â• â• â• â• â• â• â• â• â• â• â• â• â• â• â• â• â• â• â• â• â• â• â• â• â• â• â• â• â• â• â• â• â• â• â• â• â• â• â• â• â• â• â• â• â• â• â• â• â• â•

// Salas de jogos ativas
const rooms = novo Map();

io.use(async (socket, next) => {
  const token = socket.handshake.auth.token;
  se (!token) retorne next(new Error('Token nulo'));
  tentar {
    const decodificado = await admin.auth().verifyIdToken(token);
    socket.data.uid = decodificado.uid;
    socket.data.email = decoded.email;
    const snap = await db.collection('users').doc(decoded.uid).get();
    socket.data.user = snap.data();
    próximo();
  } pegar {
    próximo(novo Erro('Token inválido'));
  }
});

io.on('connection', socket => {
  const { uid, user } = socket.data;
  console.log(`âœ… Conectado: ${user?.name} (${uid})`);

  // Entrada sem saguão
  socket.join('lobby');
  io.to('lobby').emit('online_count', io.sockets.sockets.size);

  // â”€â”€ Criar sala -”€-”€-”€-”€-”€-”€-”€-”€-”€ -”€ -”€-”€-”€-”€-”€-”€-”€-”€-”€ -”€
  socket.on('create_room', async ({ game, betAmount, maxPlayers=4 }) => {
    // Valida maxPlayers
    const max = Math.min(Math.max(parseInt(maxPlayers)||2, 2), 4);
    // Verificar saldo
    const snap = await db.collection('users').doc(uid).get();
    const balance = snap.data().chips;
    se (saldo < valorAposta) {
      socket.emit('erro', { mensagem: 'Saldo insuficiente' });
      retornar;
    }

    const roomId = crypto.randomUUID().slice(0,8).toUpperCase();
    quartos.set(roomId, {
      id: roomId, jogo, valorDaAposta, númeroMáximoDeJogadores: máximo,
      jogadores: [{ uid, nome: nome.do.usuário, avatar: avatar.do.usuário, pronto: falso, online: verdadeiro }],
      status: 'aguardando',
      criadoEm: Date.now(),
    });

    socket.join(roomId);
    socket.emit('room_created', { roomId, room: rooms.get(roomId) });
    io.to('lobby').emit('rooms_update', getRoomsList());
  });

  // â”€â”€ Entrar na sala -”€-”€-”€-”€-”€-”€-”€-”€-”€-”€-”€-”€-”€-”€-”€-”€-”€-
  socket.on('join_room', async ({ roomId }) => {
    const quarto = quartos.get(roomId);
    if (!room) { socket.emit('error', { message: 'Sala não encontrada' }); retornar; }
    if (room.status !== 'waiting') { socket.emit('error', { message: 'Jogo já iniciado' }); retornar; }

    // Verifica se o jogador já está na sala (evita duplicata)
    const jaEstaNaSala = room.players.find(p => p.uid === uid);
    se (jaEstaNaSala) {
      // Reconectou — marca como online novamente
      jaEstaNaSala.online = true;
      jaEstaNaSala.desconectadoEm = nulo;
      socket.join(roomId);
      socket.emit('room_joined', { room });
      io.to(roomId).emit('atualização_da_sala', sala);
      io.to('lobby').emit('rooms_update', getRoomsList());
      retornar;
    }

    if (room.players.length >= (room.maxPlayers||4)) { socket.emit('error', { message: 'Sala cheia' }); return; }

    room.players.push({ uid, name: user.name, avatar: user.avatar, ready: false, online: true });
    socket.join(roomId);
    // Confirma entrada para quem entrou
    socket.emit('room_joined', { room });
    // Avisa todos na sala
    io.to(roomId).emit('atualização_da_sala', sala);
    io.to('lobby').emit('rooms_update', getRoomsList());
  });

  // ‐‐‐ Jogador pronto ‐ ...
  // ‐€‐€ Player pronto ‐€ ...
  socket.on('player_ready', ({ roomId }) => {
    const quarto = quartos.get(roomId);
    se (!quarto || status do quarto !== 'esperando') retorne;
    const player = room.players.find(p => p.uid === uid);
    se (!jogador || jogador.pronto) retorne;
    jogador.pronto = verdadeiro;
    io.to(roomId).emit('atualização_da_sala', sala);
  });

  socket.on('player_unready', ({ roomId }) => {
    const quarto = quartos.get(roomId);
    se (!quarto || status do quarto !== 'esperando') retorne;
    const player = room.players.find(p => p.uid === uid);
    se (!jogador) retornar;
    jogador.pronto = falso;
    io.to(roomId).emit('atualização_da_sala', sala);
  });

  // â”€â”€ Iniciar jogo (criador, todos prontos) — SEM debitar fichas -”€â”€
  socket.on('start_game', async ({ roomId }) => {
    const quarto = quartos.get(roomId);
    se (!quarto || status do quarto !== 'esperando') retorne;
    se (room.players[0].uid !== uid) {
      socket.emit('error', { message: 'Só quem criou a sala pode iniciar.' });
      retornar;
    }
    se (room.players.length < 2) {
      socket.emit('error', { message: 'Precisa de pelo menos 2 jogadores.' });
      retornar;
    }
    se (!room.players.every(p => p.ready)) {
      socket.emit('error', { message: 'Nem todos estão prontos.' });
      retornar;
    }
    status da sala = 'jogando';
    const matchRef = await db.collection('matches').add({
      idDaSala, jogo: sala.jogo,
      valorDaAposta: quarto.valorDaAposta,
      jogadores: room.players.map(p => p.uid),
      status: 'jogando',
      criadoEm: admin.firestore.FieldValue.serverTimestamp(),
    });
    room.matchId = matchRef.id;
    io.to(roomId).emit('game_start', { room, matchId: matchRef.id });
    console.log(`ðŸŽ® Jogo: ${room.game} sala ${roomId}`);
  });

  // -”€”€ Proposta de mudança de aposta (durante o jogo) -”€-”€-”€-”€-”€-”€-”€-”€
  socket.on('propose_bet', ({ roomId, newBet }) => {
    const quarto = quartos.get(roomId);
    se (!sala || sala.status !== 'jogando') retorne;
    const proponente = sala.jogadores.find(p => p.uid === uid);
    se (!proponente) retornar;
    //Qualquer jogador pode propor
    room.pendingBet = { value: newBet, proposedBy: uid, proposedrName: proposedr.name, votes: {[uid]: true}, proposedAt: Date.now() };
    // Avisa TODOS os outros
    socket.to(roomId).emit('bet_proposal', { newBet, proposedBy: proposedr.name });
  });

  socket.on('vote_bet', ({ roomId, accept }) => {
    const quarto = quartos.get(roomId);
    se (!room || !room.pendingBet) retorne;
    room.pendingBet.votes[uid] = aceitar;
    const others = room.players.filter(p => p.uid !== room.players[0].uid);
    const allVoted = others.every(p => room.pendingBet.votes[p.uid] !== undefined);
    se (todos votaram) {
      const allAccepted = others.every(p => room.pendingBet.votes[p.uid] === true);
      se (todosAceitos) {
        room.betAmount = room.pendingBet.value;
        io.to(roomId).emit('bet_changed', { newBet: room.betAmount });
      } outro {
        io.to(roomId).emit('bet_rejected', { newBet: room.pendingBet.value });
      }
      room.pendingBet = null;
    } outro {
      io.to(roomId).emit('atualização_da_sala', sala);
    }
  });

  // â”€â”€ AÃ§Ã£o de jogo -”€-”€-”€-”€-”€-”€-”€-”€-”€-”€-”€-”€-”€-”€-”€-”€-”€-
  socket.on('game_action', ({ roomId, action, data }) => {
    const quarto = quartos.get(roomId);

    // â”€â”€ Pife Online: inicializa â”€â”€
    se(ação === 'pife_init') {
      se(!quarto) retornar;
      se(!room.pifeState) {
        // Cria e embaralha baralho
        const suits=['â™ ','â™¥','â™¦','â™£'], ranks=['A','2','3','4','5','6','7','8','9','10','J','Q','K'];
        let deck=[];
        para (constante su de naipes) para (constante r de valores) deck.push({valor:r,naipe:su});
        for(let i=deck.length-1;i>0;i--){const j=Math.floor(Math.random()*(i+1));[deck[i],deck[j]]=[deck[j],deck[i]];}
        const mãos={};
        for(const p of room.players) hands[p.uid]=deck.splice(0,9);
        const discardPile=[deck.splice(0,1)[0]];
        room.pifeState={deck,hands,discardPile,currentTurn:room.players[0].uid};
      }
      // Envia estado individual para cada jogador conectado
      para(const p de room.players){
        const pSock=[...io.sockets.sockets.values()].find(sk=>sk.data.uid===p.uid);
        se(pMeia){
          const others=Object.entries(room.pifeState.hands).find(([k])=>k!==p.uid);
          pSock.emit('game_action',{uid:'server',action:'pife_state',data:{
            mão: room.pifeState.hands[p.uid],
            descartar: room.pifeState.discardPile,
            deckCount: room.pifeState.deck.length,
            meuTurno: room.pifeState.currentTurn===p.uid,
            oppHandSize: outros?.[1]?.comprimento||9,
          }});
        }
      }
      retornar;
    }

    // â”€â”€ Pife: comprar carta â”€â”€
    se(ação === 'pife_draw' && estadoDaSala?.pife) {
      const ps=room.pifeState;
      if(ps.currentTurn!==uid) return;
      deixe o cartão;
      if(data.source==='discard'&&ps.discardPile.length>0){
        cartão=ps.discardPile.shift();
        ps.hands[uid].push(card);
        // Avisa quem comprou com a carta
        socket.emit('game_action',{uid:'server',action:'pife_drew',data:{card}});
        // Avisa adversário que roubou do descarte (sem revelar)
        socket.to(roomId).emit('game_action',{uid,action:'pife_draw_discard',data:{}});
      } outro {
        if(ps.deck.length===0) return;
        carta=ps.deck.shift();
        ps.hands[uid].push(card);
        socket.emit('game_action',{uid:'server',action:'pife_drew',data:{card}});
        socket.to(roomId).emit('game_action',{uid,action:'pife_draw',data:{}});
      }
      retornar;
    }

    // â”€â”€ Pife: descartar â”€â”€
    se (ação === 'pife_discard' && room?.pifeState) {
      const ps=room.pifeState;
      if(ps.currentTurn!==uid) return;
      const hand=ps.hands[uid];
      const card=data.card||hand.splice(data.idx,1)[0];
      // Remove da mão se ainda estiver lá
      if(!data.card) {} ​​else {
        const idx=hand.findIndex(c=>c.rank===card.rank&&c.suit===card.suit);
        se(idx>=0) mão.splice(idx,1);
      }
      ps.discardPile.unshift(card);
      // Próximo turno
      const pidx=room.players.findIndex(p=>p.uid===uid);
      ps.currentTurn=room.players[(pidx+1)%room.players.length].uid;
      io.to(roomId).emit('game_action',{uid,action:'pife_discard',data:{card,idx:data.idx}});
      retornar;
    }

    // â”€â”€ Pife: declarar pife (valida no servidor) â”€â”€
    se(ação === 'pife_declare') {
      const hand = data.hand || [];
      if(hand.length !== 9){ socket.emit('game_action',{uid:'server',action:'pife_invalid',data:{}}); return; }
      // Valida grupos
      const vals={'A':1,'2':2,'3':3,'4':4,'5':5,'6':6,'7':7,'8':8,'9':9,'10':10,'J':11,'Q':12,'K':13};
      const isGroup=(g)=>{
        if(g.length!==3)retorne falso;
        if(g[0].rank===g[1].rank&&g[1].rank===g[2].rank)retorne verdadeiro;
        se(g[0].suit===g[1].suit&&g[1].suit===g[2].suit){
          const v=g.map(c=>vals[c.rank]).sort((a,b)=>ab);
          se(v[1]===v[0]+1&&v[2]===v[1]+1)retorne verdadeiro;
          if(JSON.stringify(v)==='[1,12,13]')return true;
        }
        retornar falso;
      };
      const check=(rem,groups)=>{
        if(groups===3)return rem.length===0;
        if(rem.length<3)retorne falso;
        for(let i=1;i<rem.length;i++){
          for(let j=i+1;j<rem.length;j++){
            const g=[rem[0],rem[i],rem[j]];
            se(éGrupo(g)){
              const rest=rem.filter((_,idx)=>idx!==0&&idx!==i&&idx!==j);
              se(verificar(rest,grupos+1))retornar verdadeiro;
            }
          }
        }
        retornar falso;
      };
      if(!check(hand,0)){ socket.emit('game_action',{uid:'server',action:'pife_invalid',data:{}}); return; }
      const winnerId=uid;
      const loserId=room?.players.find(p=>p.uid!==uid)?.uid;
      // Envia mãos de todos para revelação final
      const allHands={};
      for(const p of room.players) allHands[p.uid]={hand:room.pifeState?.hands[p.uid]||[],name:p.name};
      io.to(roomId).emit('game_action',{uid:'server',action:'pife_win',data:{winnerId,loserId,allHands}});
      // Processo de débito/crédito via game_over
      const bet=room.betAmount||0;
      se(aposta>0&&idVencedor&&idPerdedor){
        (async()=>{
          tentar{
            const loserSnap=await db.collection('users').doc(loserId).get();
            const loserChips=loserSnap.exists?(loserSnap.data().chips||0):0;
            const débito=Math.min(aposta,Math.max(0,fichasperdedoras));
            se(débito>0){
              const batch=db.batch();
              batch.update(db.collection('users').doc(loserId),{chips:admin.firestore.FieldValue.increment(-debit)});
              batch.update(db.collection('users').doc(winnerId),{chips:admin.firestore.FieldValue.increment(debit)});
              aguarde batch.commit();
              await logTransaction(winnerId,'win',debit,`Pife â— ganhou de ${room.players.find(p=>p.uid===loserId)?.name}`);
              await logTransaction(loserId,'loss',-debit,`Pife â— perdeu para ${room.players.find(p=>p.uid===winnerId)?.name}`);
              // Notificação de saldos atualizados
              const [wSnap,lSnap]=await Promise.all([
                db.collection('users').doc(winnerId).get(),
                db.collection('users').doc(loserId).get(),
              ]);
              io.to(roomId).emit('game_result',{
                winnerId,loserId,prize:debit,
                winnerChips:wSnap.data()?.chips||0,
                loserChips:lSnap.data()?.chips||0,
              });
            }
          }catch(e){console.error('Erro ao processar pife:',e);}
        })();
      }
      retornar;
    }

        // Dominó Online
    se(ação === 'domino_init') {
      se(!quarto) retornar;
      se(!room.dominoState) {
        // Gera 28 peças de domínio [0-0 até 6-6]
        seja peças=[];
        for(let a=0;a<=6;a++) for(let b=a;b<=6;b++) pieces.push({a,b});
        // Embaralha
        for(let i=pieces.length-1;i>0;i--){const j=Math.floor(Math.random()*(i+1));[pieces[i],pieces[j]]=[pieces[j],pieces[i]];}
        const mãos={};
        for(const p of room.players) hands[p.uid]=pieces.splice(0,7);
        room.dominoState={hands,board:[],boardEnds:{left:null,right:null},currentTurn:room.players[0].uid,passCount:0};
      }
      para(const p de room.players){
        const pSock=[...io.sockets.sockets.values()].find(sk=>sk.data.uid===p.uid);
        se(pMeia){
          const opp=Object.entries(room.dominoState.hands).find(([k])=>k!==p.uid);
          pSock.emit('game_action',{uid:'server',action:'domino_state',data:{
            mão:room.dominoState.hands[p.uid],
            tabuleiro:room.dominoState.board,
            boardEnds:room.dominoState.boardEnds,
            oppCount:opp?.[1]?.length||7,
            myTurn:room.dominoState.currentTurn===p.uid,
          }});
        }
      }
      retornar;
    }

    se (ação === 'domino_play' && sala?.dominoState) {
      const ds=room.dominoState;
      if(ds.currentTurn!==uid) return;
      const {piece,handIdx,side}=dados;
      // Coloca na mesa
      seja newPiece={...piece};
      se(ds.board.length===0){
        ds.board.push(newPiece);
        ds.boardEnds={left:newPiece.a,right:newPiece.b};
      } senão se(lado==='esquerdo'){
        if(newPiece.b!==ds.boardEnds.left) newPiece={a:newPiece.b,b:newPiece.a};
        ds.board.unshift(newPiece);
        ds.boardEnds.left=newPiece.a;
      } outro {
        if(newPiece.a!==ds.boardEnds.right) newPiece={a:newPiece.b,b:newPiece.a};
        ds.board.push(newPiece);
        ds.boardEnds.right=newPiece.b;
      }
      // Remover da mÃ£o
      ds.hands[uid].splice(handIdx,1);
      ds.passCount=0;
      // Próximo turno
      const pidx=room.players.findIndex(p=>p.uid===uid);
      ds.currentTurn=room.players[(pidx+1)%room.players.length].uid;
      io.to(roomId).emit('game_action',{uid,action:'domino_played',data:{board:ds.board,boardEnds:ds.boardEnds,handIdx}});
      // Verifica vitória (mão vazia)
      if(ds.hands[uid].length===0){
        const loserId=room.players.find(p=>p.uid!==uid)?.uid;
        io.to(roomId).emit('game_action',{uid:'server',action:'domino_win',data:{winnerId:uid,loserId}});
        // Débito/crédito
        const bet=room.betAmount||0;
        se(aposta>0&&idPerdedor){
          (async()=>{
            tentar{
              const lSnap=await db.collection('users').doc(loserId).get();
              const lChips=lSnap.exists?(lSnap.data().chips||0):0;
              const débito=Math.min(aposta,Math.max(0,lFichas));
              se(débito>0){
                const batch=db.batch();
                batch.update(db.collection('users').doc(loserId),{chips:admin.firestore.FieldValue.increment(-debit)});
                batch.update(db.collection('users').doc(uid),{chips:admin.firestore.FieldValue.increment(debit)});
                aguarde batch.commit();
                await logTransaction(uid,'win',debit,`Dominó â— vitória`);
                await logTransaction(loserId,'loss',-debit,`Dominó — derrota`);
                const [wS,lS]=await Promise.all([db.collection('users').doc(uid).get(),db.collection('users').doc(loserId).get()]);
                io.to(roomId).emit('game_result',{winnerId:uid,loserId,prize:debit,winnerChips:wS.data()?.chips||0,loserChips:lS.data()?.chips||0});
              }
            }catch(e){console.error('Erro dominado:',e);}
          })();
        }
      }
      retornar;
    }

    se (ação === 'domino_pass' && sala?.dominoState) {
      const ds=room.dominoState;
      if(ds.currentTurn!==uid) return;
      ds.passCount=(ds.passCount||0)+1;
      const pidx=room.players.findIndex(p=>p.uid===uid);
      ds.currentTurn=room.players[(pidx+1)%room.players.length].uid;
      io.to(roomId).emit('game_action',{uid,action:'domino_pass',data:{}});
      // Dois passes seguidos = fechado, quem tem menos pontos ganha
      if(ds.passCount>=room.players.length){
        seja winner=null,minPts=Infinity;
        para(const p de room.players){
          const pts=ds.hands[p.uid].reduce((s,pc)=>s+pc.a+pc.b,0);
          if(pts<minPts){minPts=pts;winner=p.uid;}
        }
        const perdedor=room.players.find(p=>p.uid!==vencedor)?.uid;
        io.to(roomId).emit('game_action',{uid:'server',action:'domino_win',data:{winnerId:winner,loserId:loser}});
      }
      retornar;
    }

    // Outros jogos: repassado direto
    socket.to(roomId).emit('game_action', { uid, action, data });
  });

  // â”€â”€ Fim do jogo â”€-”€-”€-”€-”€-”€-”€-”€-”€ -” ”€-”€-”€-”€-”€-”€-”€-”€-”€-”€-”€
  socket.on('game_over', async ({ roomId, winnerId, loserId }) => {
    const quarto = quartos.get(roomId);
    se (!sala || sala.status !== 'jogando') retorne;
    status.da.quarto = 'concluído';

    const bet = room.betAmount || 0;

    // Débito do perdedor e crédito no vencedor
    se (aposta > 0 && idVencedor && idPerdedor && idVencedor !== idPerdedor) {
      tentar {
        const batch = db.batch();
        // Verifica saldo do perdedor
        const loserSnap = await db.collection('users').doc(loserId).get();
        const loserChips = loserSnap.exists ? (loserSnap.data().chips || 0) : 0;
        débito const = Math.min (aposta, fichas perdedoras); //nunca vai negativo

        se (débito > 0) {
          batch.update(db.collection('users').doc(loserId), {
            chips: admin.firestore.FieldValue.increment(-debit),
          });
          batch.update(db.collection('users').doc(winnerId), {
            chips: admin.firestore.FieldValue.increment(débito),
          });
          aguarde batch.commit();
          await logTransaction(winnerId, 'win', debit, `Vitória em ${room.game}`);
          await logTransaction(loserId, 'loss', -debit, `Derrota em ${room.game}`);
        }

        // Notificação resultado com saldos atualizados
        const [wSnap, lSnap] = await Promise.all([
          db.collection('users').doc(winnerId).get(),
          db.collection('users').doc(loserId).get(),
        ]);
        io.to(roomId).emit('game_result', {
          winnerId, loserId, prêmio: débito,
          winnerChips: wSnap.data()?.chips || 0,
          loserChips: lSnap.data()?.chips || 0,
        });
      } catch(e) {
        console.error('Erro ao processar resultado:', e);
        io.to(roomId).emit('game_result', { winnerId, loserId, prize: 0 });
      }
    } outro {
      io.to(roomId).emit('game_result', { winnerId, loserId, prize: 0 });
    }

    se (room.matchId) {
      await db.collection('matches').doc(room.matchId).update({
        status: 'finalizado', winnerId, loserId,
        finishedAt: admin.firestore.FieldValue.serverTimestamp(),
      }).catch(()=>{});
    }

    quartos.excluir(idDoQuarto);
    io.to('lobby').emit('rooms_update', getRoomsList());
  });

  // -”€”€ Atualiza lista de salas sob demanda -”€-”€-”€-”€-”€-”€-”€-”€-”€-”€-”€
  socket.on('get_rooms', () => {
    socket.emit('rooms_update', getRoomsList());
  });

  // â”€â”€ Chat da sala â”€-”€-”€-”€-”€-”€-”€-”€-”€ -” ”€-”€-”€-”€-”€-”€-”€-”€-”€-”€-”€
  socket.on('chat_message', ({ roomId, message }) => {
    const clean = message.slice(0, 120);
    io.to(roomId).emit('chat_message', {
      uid, nome: user.name, mensagem: limpar, hora: Date.now()
    });
  });

  // Revanche
  socket.on('rematch_vote', async ({ roomId, accept }) => {
    const quarto = quartos.get(roomId);
    se(!quarto) retornar;

    // Inicializa votos se necessário
    if(!room.rematchVotes) room.rematchVotes = {};
    room.rematchVotes[uid] = aceitar;

    const total = room.players.length;
    const voter = room.players.find(p => p.uid === uid);

    // Notifica todos da sala
    io.to(roomId).emit('rematch_vote', {
      uid, nome: eleitor?.nome || 'Jogador',
      aceitar,
      votos: sala.rematchVotos,
      total,
    });

    const allVoted = Object.keys(room.rematchVotes).length === total;
    const allAccepted = allVoted && Object.values(room.rematchVotes).every(Boolean);
    const anyRejected = Object.values(room.rematchVotes).some(v => v === false);

    se(todosAceitos) {
      // Verifica o saldo de todos antes de reiniciar
      se(room.betAmount > 0) {
        seja semSaldo = nulo;
        para(const p de room.players) {
          const snap = await db.collection('users').doc(p.uid).get();
          const chips = snap.exists ? (snap.data().chips || 0) : 0;
          if(chips < room.betAmount) { semSaldo = {name: p.name, chips, needed: room.betAmount}; break; }
        }
        se(semSaldo) {
          io.to(roomId).emit('rematch_blocked', {
            mensagem: `â Œ ${semSaldo.name} tem apenas ${semSaldo.chips} fichas e a aposta é ${semSaldo.needed}. Reduza a aposta ou saia.`,
            playerName: semSaldo.name,
            chips: semSaldo.chips,
            necessário: semSaldo.necessário,
          });
          room.rematchVotes = {};
          retornar;
        }
      }
      // Reinicia sala
      status.da.sala = 'esperando';
      room.rematchVotes = {};
      room.pifeState = null;
      room.matchId = nulo;
      room.players.forEach(p => p.ready = false);
      io.to(roomId).emit('rematch_ok', {});
      io.to('lobby').emit('rooms_update', getRoomsList());
    } senão se(qualquerRejeitado) {
      // Alguém encontrado — remove sala após 3s
      setTimeout(() => {
        quartos.excluir(idDoQuarto);
        io.to('lobby').emit('rooms_update', getRoomsList());
      }, 3000);
    }
  });

  // –”€”€ Desconexão â”€-”€-”€-”€-”€-”€-”€-”- ”€-”€-”€-”€-”€-”€-”€-”€-”€-”€-”€-”€-”€-”€-”€-”€-”€-”€-”
  socket.on('disconnect', () => {
    console.log(`â Œ Desconectado: ${user?.name}`);
    // Marca jogador como offline mas NÃƒO remove a sala
    // A sala só alguns depois de 5 minutos sem ninguém reconectar
    para (constante [roomId, sala] de salas.entradas()) {
      const player = room.players.find(p => p.uid === uid);
      se (jogador) {
        jogador.online = falso;
        jogador.desconectadoEm = Date.now();
        // Avisa outros na sala
        io.to(roomId).emit('player_offline', { uid, room });
        // Agenda limpeza da sala após 5 minutos se ainda vazia/offline
        setTimeout(() => {
          const r = rooms.get(roomId);
          se (!r) retornar;
          // Remover jogadores offline há mais de 5 minutos
          r.players = r.players.filter(p => p.online || (Date.now() - (p.disconnectedAt||0)) < 300000);
          se (r.players.length === 0 && r.status === 'waiting') {
            quartos.excluir(idDoQuarto);
            console.log(`ðŸ—'ï¸ Sala ${roomId} removida por inatividade`);
          }
          io.to('lobby').emit('rooms_update', getRoomsList());
        }, 300000); // 5 minutos
      }
    }
    io.to('lobby').emit('online_count', io.sockets.sockets.size);
    io.to('lobby').emit('rooms_update', getRoomsList());
  });
});

// -”€”€ Ajudantes -”€-”€-”€-”€-”€-”€-”€-”- -”€-”€-”€-”€-”€-”€-”€-”-
função obterListaDeQuartos() {
  retornar [...rooms.values()]
    .filter(r => r.status === 'waiting')
    .map(r => ({
      id: r.id,
      jogo: r.game,
      valorDaAposta: r.valorDaAposta,
      jogadores: r.jogadores.comprimento,
      maxPlayers: r.maxPlayers||4,
      criadoEm: r.criadoEm,
      hasOffline: r.players.some(p => !p.online),
    }));
}

função assíncrona logTransaction(userId, tipo, chips, descrição) {
  await db.collection('transactions').add({
    ID do usuário, tipo, chips, descrição,
    criadoEm: admin.firestore.FieldValue.serverTimestamp(),
  });
}

// Verificação de saúde
app.get('/health', (_, res) => res.json({ status: 'ok', rooms: rooms.size }));
app.get('/api/packages', (_, res) => res.json(PACKAGES));

// Início
const PORT = process.env.PORT || 3001;
server.listen(PORT, () => console.log(`ðŸŽ° Cassiano Backend rodando na porta ${PORT}`));
