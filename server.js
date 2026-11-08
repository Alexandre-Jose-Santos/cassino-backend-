// ============================================================
//  CASSIANO CASINO — BACKEND COMPLETO
//  Node.js + Express + Socket.io + Firebase Admin
//  Versão gratuita: fichas virtuais, sem valor real, sem compra e sem saque
// ============================================================
const express    = require('express');
const http       = require('http');
const { Server } = require('socket.io');
const admin      = require('firebase-admin');
const cors       = require('cors');
const crypto     = require('crypto');
require('dotenv').config();

// ── Firebase Admin Init ──────────────────────────────────────
// Opção simples: FIREBASE_SERVICE_ACCOUNT = conteúdo inteiro do arquivo .json da chave.
// Opção antiga (ainda aceita): FIREBASE_PROJECT_ID + FIREBASE_CLIENT_EMAIL + FIREBASE_PRIVATE_KEY.
let fbCred;
if (process.env.FIREBASE_SERVICE_ACCOUNT) {
  const sa = JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT);
  fbCred = { projectId: sa.project_id, clientEmail: sa.client_email, privateKey: sa.private_key };
} else {
  fbCred = {
    projectId:   process.env.FIREBASE_PROJECT_ID,
    clientEmail: process.env.FIREBASE_CLIENT_EMAIL,
    privateKey:  process.env.FIREBASE_PRIVATE_KEY?.replace(/\\n/g, '\n'),
  };
}
admin.initializeApp({ credential: admin.credential.cert(fbCred) });
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

// Keep-alive para o Render (plano grátis dorme após ~15 min sem acesso).
// O Render define RENDER_EXTERNAL_URL automaticamente. Para ficar 100% sempre ligado,
// use também um pinger externo (ex.: UptimeRobot) apontando para /health.
setInterval(() => {
  const url = process.env.RENDER_EXTERNAL_URL;
  if (!url) return;
  require('https').get(`${url}/health`, r => {
    console.log(`💓 Keep-alive: ${r.statusCode} | salas: ${rooms.size} | conexões: ${io.sockets.sockets.size}`);
  }).on('error', e => console.warn('Keep-alive falhou:', e.message));
}, 3 * 60 * 1000); // a cada 3 minutos

app.use(cors({ origin: process.env.FRONTEND_URL || '*' }));
app.get('/health', (req, res) => res.json({ status: 'ok', rooms: rooms.size, connections: io.sockets.sockets.size, uptime: Math.floor(process.uptime()) }));
app.get('/wake', (req, res) => {
  const now=Date.now();let cleaned=0;
  rooms.forEach((r,id)=>{if(r.status==='waiting'&&(now-(r.createdAt||now))>30*60*1000){rooms.delete(id);cleaned++;}});
  res.json({status:'awake',rooms:rooms.size,cleaned});
});
app.use(express.json());

// ── Fichas virtuais ──────────────────────────────────────────
// Fichas NÃO têm valor em dinheiro: não podem ser compradas nem sacadas.
const BONUS_FICHAS = 50;                    // fichas grátis por resgate
const BONUS_COOLDOWN_MS = 12*60*60*1000;    // a cada 12 horas

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
//  ROTAS DO USUÁRIO
// ════════════════════════════════════════════════════════════

app.get('/api/user/balance', authMiddleware, async (req, res) => {
  const snap = await db.collection('users').doc(req.user.uid).get();
  if (!snap.exists) return res.status(404).json({ error: 'Usuário não encontrado' });
  const { chips, lastBonusAt } = snap.data();
  res.json({ chips, lastBonusAt: lastBonusAt?.toMillis?.() || 0 });
});

app.get('/api/user/transactions', authMiddleware, async (req, res) => {
  const snap = await db.collection('transactions')
    .where('userId', '==', req.user.uid)
    .orderBy('createdAt', 'desc')
    .limit(50)
    .get();
  res.json(snap.docs.map(d => ({ id: d.id, ...d.data() })));
});

// Resgata fichas grátis (a cada 12h)
app.post('/api/user/bonus', authMiddleware, async (req, res) => {
  const ref = db.collection('users').doc(req.user.uid);
  try {
    const out = await db.runTransaction(async tx => {
      const snap = await tx.get(ref);
      if (!snap.exists) return { status: 404, body: { error: 'Usuário não encontrado' } };
      const last = snap.data().lastBonusAt?.toMillis?.() || 0;
      const wait = last + BONUS_COOLDOWN_MS - Date.now();
      if (wait > 0) return { status: 429, body: { error: 'Ainda não disponível', waitMs: wait } };
      tx.update(ref, {
        chips: admin.firestore.FieldValue.increment(BONUS_FICHAS),
        lastBonusAt: admin.firestore.FieldValue.serverTimestamp(),
      });
      return { status: 200, body: { success: true, chips: BONUS_FICHAS } };
    });
    if (out.status === 200) await logTransaction(req.user.uid, 'bonus', BONUS_FICHAS, 'Fichas grátis');
    res.status(out.status).json(out.body);
  } catch (e) {
    console.error('bonus erro:', e.message);
    res.status(500).json({ error: 'Erro ao resgatar fichas' });
  }
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

// Dashboard simples
app.get('/api/admin/dashboard', adminAuth, async (req, res) => {
  const usersSnap = await db.collection('users').get();
  res.json({ totalUsers: usersSnap.size, rooms: rooms.size, connections: io.sockets.sockets.size });
});

// ════════════════════════════════════════════════════════════
//  DOAÇÕES — MURAL DE APOIADORES
//  Pix gerado pelo Asaas; o webhook confirma o pagamento e o doador aparece
//  no mural automaticamente (nome opcional). Admin pode confirmar manualmente.
// ════════════════════════════════════════════════════════════
const cleanTxt = (v, max) => String(v ?? '').replace(/[<>]/g, '').replace(/\s+/g, ' ').trim().slice(0, max);
let donCache = { at: 0, data: null };

// ── Asaas (Pix) ───────────────────────────────────────────────
// Env: ASAAS_API_KEY, ASAAS_PIX_KEY (chave Pix aleatória da conta Asaas),
//      ASAAS_WEBHOOK_TOKEN (32+ caracteres), ASAAS_ENV ('production' ou sandbox por padrão)
const ASAAS_BASE = process.env.ASAAS_ENV === 'production' ? 'https://api.asaas.com/v3' : 'https://api-sandbox.asaas.com/v3';
const asaasOK = () => !!(process.env.ASAAS_API_KEY && process.env.ASAAS_PIX_KEY);
async function asaasCall(path, method = 'GET', body) {
  const r = await fetch(ASAAS_BASE + path, {
    method,
    headers: { 'Content-Type': 'application/json', 'access_token': process.env.ASAAS_API_KEY, 'User-Agent': 'AR-Cassino' },
    body: body ? JSON.stringify(body) : undefined,
  });
  const j = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error('Asaas ' + r.status + ': ' + JSON.stringify(j.errors || j).slice(0, 200));
  return j;
}

// Jogador gera o Pix da doação (QR Code estático do Asaas, valor fixo).
// Nome é opcional: em branco = aparece como "Anônimo".
app.post('/api/donations/pix', authMiddleware, async (req, res) => {
  if (!asaasOK()) return res.status(503).json({ error: 'Doação por Pix ainda não está configurada' });
  let ref = null;
  try {
    const nameIn      = cleanTxt(req.body.displayName, 30);
    const displayName = nameIn || 'Anônimo';
    const message     = nameIn ? cleanTxt(req.body.message, 80) : '';
    const amount      = Math.round(Number(req.body.amount) * 100) / 100;
    const showAmount  = !!req.body.showAmount;
    if (!(amount >= 1 && amount <= 10000)) return res.status(400).json({ error: 'Valor inválido (mínimo R$ 1)' });

    // Limite: 10 Pix gerados por dia por usuário (evita spam)
    const mine = await db.collection('donations').where('userId', '==', req.user.uid).limit(50).get();
    const dayAgo = Date.now() - 24 * 60 * 60 * 1000;
    if (mine.docs.filter(d => (d.data().createdAt?.toMillis?.() || 0) > dayAgo).length >= 10)
      return res.status(429).json({ error: 'Muitos Pix gerados hoje. Tente amanhã.' });

    const code = 'AR-' + crypto.randomInt(1000, 10000);
    ref = await db.collection('donations').add({
      userId: req.user.uid, displayName, message, amount, showAmount, code,
      status: 'pending', source: 'asaas',
      createdAt: admin.firestore.FieldValue.serverTimestamp(),
    });

    // expira em 24h (horário de Brasília)
    const exp = new Date(Date.now() - 3 * 3600 * 1000 + 24 * 3600 * 1000).toISOString().slice(0, 19).replace('T', ' ');
    const qr = await asaasCall('/pix/qrCodes/static', 'POST', {
      addressKey: process.env.ASAAS_PIX_KEY,
      description: 'Doação Cassino AR ' + code,
      value: amount, format: 'ALL', expirationDate: exp,
    });
    await ref.update({ asaasQrId: qr.id });
    res.json({ id: ref.id, code, payload: qr.payload, encodedImage: qr.encodedImage });
  } catch (e) {
    console.error('donation pix erro:', e.message);
    if (ref) ref.delete().catch(() => {});
    res.status(502).json({ error: 'Não foi possível gerar o Pix agora. Tente de novo.' });
  }
});

// Status da doação (só o próprio doador consulta) — usado para detectar o pagamento na tela
app.get('/api/donations/:id/status', authMiddleware, async (req, res) => {
  try {
    const snap = await db.collection('donations').doc(req.params.id).get();
    if (!snap.exists || snap.data().userId !== req.user.uid) return res.status(404).json({ error: 'Não encontrado' });
    res.json({ status: snap.data().status });
  } catch (e) { res.status(500).json({ error: 'Erro' }); }
});

// Confirma a doação a partir do evento de pagamento do Asaas (idempotente)
async function confirmDonationFromAsaas(pay) {
  const dup = await db.collection('donations').where('asaasPaymentId', '==', pay.id).limit(1).get();
  if (!dup.empty) return;                                   // evento repetido
  const snap = await db.collection('donations').where('asaasQrId', '==', pay.pixQrCodeId).limit(1).get();
  if (snap.empty) { console.log('Pix recebido sem doação associada:', pay.id); return; }
  const doc = snap.docs[0], d = doc.data();
  const value = Math.round(Number(pay.value) * 100) / 100;
  const now = admin.firestore.FieldValue.serverTimestamp();
  if (d.status === 'pending' || (d.status === 'confirmed' && !d.asaasPaymentId)) {
    await doc.ref.update({ status: 'confirmed', amount: value, asaasPaymentId: pay.id, confirmedAt: d.confirmedAt || now });
  } else {                                                  // mesmo QR pago de novo → nova doação confirmada
    await db.collection('donations').add({ ...d, amount: value, asaasPaymentId: pay.id, status: 'confirmed', createdAt: now, confirmedAt: now });
  }
  donCache.at = 0;
  console.log(`💖 Doação confirmada: ${d.displayName} R$ ${value}`);
}

// Webhook do Asaas (configure em Integrações > Webhooks, evento PAYMENT_RECEIVED)
app.post('/api/webhooks/asaas', async (req, res) => {
  const tok = process.env.ASAAS_WEBHOOK_TOKEN || '';
  const got = String(req.get('asaas-access-token') || '');
  const A = Buffer.from(tok), B = Buffer.from(got);
  if (!tok || A.length !== B.length || !crypto.timingSafeEqual(A, B)) return res.status(401).json({ error: 'unauthorized' });
  try {
    const ev = req.body?.event, pay = req.body?.payment;
    if ((ev === 'PAYMENT_RECEIVED' || ev === 'PAYMENT_CONFIRMED') && pay?.pixQrCodeId && pay?.id) {
      await confirmDonationFromAsaas(pay);
    }
    res.json({ received: true });
  } catch (e) {
    console.error('webhook asaas erro:', e.message);
    res.status(500).json({ error: 'erro' });
  }
});

// Mural público: só doações confirmadas, sem dados pessoais além do nome escolhido
app.get('/api/donations/public', async (req, res) => {
  if (donCache.data && Date.now() - donCache.at < 60000) return res.json(donCache.data);
  try {
    const snap = await db.collection('donations').where('status', '==', 'confirmed').limit(500).get();
    const list = snap.docs.map(d => d.data())
      .sort((a, b) => (b.confirmedAt?.toMillis?.() || 0) - (a.confirmedAt?.toMillis?.() || 0));
    const br = new Date(Date.now() - 3 * 60 * 60 * 1000);           // horário de Brasília
    const monthKey = br.getUTCFullYear() + '-' + br.getUTCMonth();
    const totalMes = list.reduce((sum, d) => {
      const t = new Date((d.confirmedAt?.toMillis?.() || 0) - 3 * 60 * 60 * 1000);
      return t.getUTCFullYear() + '-' + t.getUTCMonth() === monthKey ? sum + (d.amount || 0) : sum;
    }, 0);
    donCache = { at: Date.now(), data: {
      totalMes: Math.round(totalMes * 100) / 100,
      total: list.length,
      apoiadores: list.slice(0, 50).map(d => ({
        name: d.displayName, message: d.message || '',
        amount: d.showAmount ? d.amount : null,
      })),
    } };
    res.json(donCache.data);
  } catch (e) {
    console.error('donations public erro:', e.message);
    res.status(500).json({ error: 'Erro ao carregar mural' });
  }
});

// Admin: lista por status (pending | confirmed | rejected)
app.get('/api/admin/donations', adminAuth, async (req, res) => {
  const status = ['pending', 'confirmed', 'rejected'].includes(req.query.status) ? req.query.status : 'pending';
  const snap = await db.collection('donations').where('status', '==', status).limit(100).get();
  res.json(snap.docs.map(d => ({ id: d.id, ...d.data() })));
});

// Admin: confirma (opcionalmente corrige o valor) / rejeita
app.post('/api/admin/donations/:id/confirm', adminAuth, async (req, res) => {
  const ref = db.collection('donations').doc(req.params.id);
  if (!(await ref.get()).exists) return res.status(404).json({ error: 'Não encontrado' });
  const upd = { status: 'confirmed', confirmedAt: admin.firestore.FieldValue.serverTimestamp() };
  const v = Math.round(Number(req.body?.amount) * 100) / 100;
  if (v >= 1 && v <= 10000) upd.amount = v;
  await ref.update(upd);
  donCache.at = 0;
  res.json({ success: true });
});
app.post('/api/admin/donations/:id/reject', adminAuth, async (req, res) => {
  const ref = db.collection('donations').doc(req.params.id);
  if (!(await ref.get()).exists) return res.status(404).json({ error: 'Não encontrado' });
  await ref.update({ status: 'rejected', rejectedAt: admin.firestore.FieldValue.serverTimestamp() });
  donCache.at = 0;
  res.json({ success: true });
});

// Admin: adiciona doação já confirmada (quem doou sem preencher o formulário)
app.post('/api/admin/donations/manual', adminAuth, async (req, res) => {
  const displayName = cleanTxt(req.body.displayName, 30);
  const amount = Math.round(Number(req.body.amount) * 100) / 100;
  if (!displayName || !(amount >= 1 && amount <= 10000)) return res.status(400).json({ error: 'Nome e valor obrigatórios' });
  await db.collection('donations').add({
    userId: null, displayName, message: cleanTxt(req.body.message, 80), amount,
    showAmount: !!req.body.showAmount, code: 'MANUAL', status: 'confirmed',
    createdAt: admin.firestore.FieldValue.serverTimestamp(),
    confirmedAt: admin.firestore.FieldValue.serverTimestamp(),
  });
  donCache.at = 0;
  res.json({ success: true });
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


function startPokerHand(room, roomId, io) {
  if(!room || room.players.length < 2) return;
  const BB = room.betAmount || 10;
  const SB = Math.floor(BB / 2);

  // Build deck using {rank, suit}
  const ranks = ['2','3','4','5','6','7','8','9','10','J','Q','K','A'];
  const suits = ['s','h','d','c'];
  const deck = [];
  for(const s of suits) for(const r of ranks) deck.push({rank:r,suit:s});
  // Shuffle
  for(let i=deck.length-1;i>0;i--){const j=Math.floor(Math.random()*(i+1));[deck[i],deck[j]]=[deck[j],deck[i]];}

  if(!room.pokerDealerIdx) room.pokerDealerIdx = 0;
  const dealerIdx = room.pokerDealerIdx % 2;
  const p0 = room.players[dealerIdx].uid;   // dealer / SB
  const p1 = room.players[1-dealerIdx].uid; // BB

  const hands = {
    [p0]: [deck.pop(), deck.pop()],
    [p1]: [deck.pop(), deck.pop()],
  };

  const startChips = {};
  room.players.forEach(p => {
    startChips[p.uid] = (room.pokerState?.chips?.[p.uid]) || 100;
  });

  room.pokerState = {
    deck, hands,
    community: [],
    stage: 'pre',
    pot: SB + BB,
    curBet: BB,
    bets: { [p0]: SB, [p1]: BB },
    chips: {
      [p0]: startChips[p0] - SB,
      [p1]: startChips[p1] - BB,
    },
    currentTurn: p0, // SB acts first pre-flop
    checkedUids: new Set(),
  };

  // Send cards to each player
  for(const p of room.players) {
    const pSock = [...io.sockets.sockets.values()].find(sk=>sk.data.uid===p.uid);
    const oppUid = room.players.find(op=>op.uid!==p.uid)?.uid;
    if(pSock) pSock.emit('game_action', {uid:'server', action:'poker_deal', data:{
      hand: room.pokerState.hands[p.uid],
      chips: room.pokerState.chips[p.uid],
      oppChips: room.pokerState.chips[oppUid]||0,
      pot: room.pokerState.pot,
      curBet: room.pokerState.curBet,
      myBet: room.pokerState.bets[p.uid]||0,
      oppBet: room.pokerState.bets[oppUid]||0,
      myTurn: room.pokerState.currentTurn === p.uid,
      dealer: p.uid === p0,
      stage: 'pre',
    }});
  }
  console.log('🃏 Poker hand started in room', roomId);
}

function advancePokerStage(room, roomId, io) {
  const ps = room.pokerState;
  if(!ps) return;
  const BB = room.betAmount || 10;
  ps.bets={}; ps.curBet=0; ps.checkedUids=new Set();
  const bbIdx=1-(room.pokerDealerIdx||0);
  ps.currentTurn=room.players[bbIdx].uid;

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
        curBet: 0,
        myBet: 0,
        oppBet: 0,
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
      loserId: tie?null:loserId,
      tie,
      prize: tie ? Math.floor(ps.pot/2) : (p.uid===winnerId ? ps.pot : 0),
      myChips: ps.chips[p.uid]||0,
      oppChips: ps.chips[oppUid]||0,
      oppHand: ps.hands[oppUid],
      myHand: {score:p.uid===p0?h0.score:h1.score},
      myHandName: p.uid===p0?h0.name:h1.name,
      oppHandName: p.uid===p0?h1.name:h0.name,
      reason: tie?'Empate!':(p.uid===winnerId?`${p.uid===p0?h0.name:h1.name} bate ${p.uid===p0?h1.name:h0.name}`:
        `${p.uid===p0?h1.name:h0.name} bate ${p.uid===p0?h0.name:h1.name}`)
    }});
  }

  const prize=ps.pot;
  io.to(roomId).emit('game_result',{winnerId:tie?null:winnerId,loserId:tie?null:loserId,prize,winnerChips:tie?null:ps.chips[winnerId],loserChips:tie?null:ps.chips[loserId]});
  // Fichas do pote sao in-memory apenas — sem debito/credito no Firestore aqui
  room.pokerState=null;
}

io.on('connection', socket => {
  const { uid, user } = socket.data;
  console.log(`✅ Conectado: ${user?.name} (${uid})`);

  // Entra no lobby
  socket.join('lobby');
  io.to('lobby').emit('online_count', io.sockets.sockets.size);

  // ── Criar sala ──────────────────────────────────────────
  socket.on('create_room', async ({ game, betAmount, maxPlayers=4 }) => {
    try {
    const max = Math.min(Math.max(parseInt(maxPlayers)||2, 2), 4);
    const snap = await db.collection('users').doc(uid).get();
    const balance = snap.data()?.chips || 0;
    // Minimo 5 fichas — aposta real negociada dentro do jogo
    if (balance < 5) {
      socket.emit('error', { message: 'Saldo insuficiente! Voce precisa de pelo menos 5 fichas.' });
      return;
    }
    // Cria a sala PRIMEIRO, debita fichas SÓ se tudo der certo
    const roomId = crypto.randomUUID().slice(0,8).toUpperCase();
    rooms.set(roomId, {
      id: roomId, game, betAmount, maxPlayers: max,
      players: [{ uid, name: user.name, avatar: user.avatar, ready: false, online: true }],
      status: 'waiting',
      createdAt: Date.now(),
    });

    socket.join(roomId);

    // Debita 5 fichas SOMENTE após confirmar que a sala foi criada com sucesso
    try {
      await db.collection('users').doc(uid).update({
        chips: admin.firestore.FieldValue.increment(-5)
      });
    } catch(e) {
      // Se falhar o débito, remove a sala e avisa
      rooms.delete(roomId);
      socket.leave(roomId);
      socket.emit('error', { message: 'Erro ao debitar fichas. Sala cancelada.' });
      return;
    }

    socket.emit('room_created', { roomId, room: rooms.get(roomId) });
    io.to('lobby').emit('rooms_update', getRoomsList());
    } catch(e) { console.error('create_room erro:', e.message); socket.emit('error',{message:'Erro ao criar sala.'}); }
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
    // Minimo 5 fichas para entrar — aposta real negociada dentro do jogo
    if (joinBalance < 5) {
      socket.emit('error', { message: 'Saldo insuficiente! Voce precisa de pelo menos 5 fichas.' });
      return;
    }
    // Adiciona jogador à sala PRIMEIRO
    room.players.push({ uid, name: user.name, avatar: user.avatar, ready: false, online: true });
    socket.join(roomId);

    // Debita 5 fichas SOMENTE após confirmar entrada com sucesso
    try {
      await db.collection('users').doc(uid).update({
        chips: admin.firestore.FieldValue.increment(-5)
      });
    } catch(e) {
      // Se falhar débito, remove jogador da sala
      room.players = room.players.filter(p => p.uid !== uid);
      socket.leave(roomId);
      socket.emit('error', { message: 'Erro ao debitar fichas. Entrada cancelada.' });
      return;
    }

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
    // Entrada ja foi cobrada ao criar/entrar na sala — sem deducao adicional aqui
    if(room.game==='poker') room.pokerBetVotes={};
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

    // ── POKER HANDLERS ──────────────────────────────────────
    if(action === 'poker_bet_proposal') {
      if(!room) return;
      const bet = Math.max(5, parseInt(data.bet)||5);
      if(!room.pokerBetVotes) room.pokerBetVotes = {};
      room.pokerBetVotes[uid] = bet;
      socket.to(roomId).emit('game_action',{uid, action:'poker_bet_proposal', data:{bet}});
      return;
    }

    if(action === 'poker_bet_confirm') {
      if(!room) return;
      const bet = Math.max(5, parseInt(data.bet)||5);
      if(!room.pokerBetVotes) room.pokerBetVotes = {};
      room.pokerBetVotes[uid] = { bet, confirmed: true };
      socket.to(roomId).emit('game_action',{uid, action:'poker_bet_waiting', data:{}});
      const allConfirmed = room.players.length >= 2 &&
        room.players.every(p => room.pokerBetVotes[p.uid]?.confirmed === true);
      if(allConfirmed) {
        const bets = room.players.map(p => room.pokerBetVotes[p.uid]?.bet || 5);
        room.betAmount = Math.max(...bets);
        room.pokerBetVotes = {};
        io.to(roomId).emit('game_action',{uid:'server', action:'poker_bet_agreed', data:{bet:room.betAmount}});
        setTimeout(() => startPokerHand(room, roomId, io), 400);
      }
      return;
    }

    // poker_init removido — fluxo correto: poker_bet_proposal -> poker_bet_confirm -> poker_bet_agreed -> startPokerHand

    // ── Negociação de aposta para jogos não-poker ──────────────
    if(action === 'game_bet_proposal') {
      if(!room) return;
      const bet = Math.max(5, parseInt(data.bet)||5);
      if(!room.gameBetVotes) room.gameBetVotes = {};
      room.gameBetVotes[uid] = bet;
      socket.to(roomId).emit('game_action',{uid, action:'game_bet_proposal', data:{bet}});
      return;
    }
    if(action === 'game_bet_confirm') {
      if(!room) return;
      const bet = Math.max(5, parseInt(data.bet)||5);
      if(!room.gameBetVotes) room.gameBetVotes = {};
      room.gameBetVotes[uid] = { bet, confirmed: true };
      socket.to(roomId).emit('game_action',{uid, action:'game_bet_waiting', data:{}});
      const allConfirmed = room.players.length >= 2 &&
        room.players.every(p => room.gameBetVotes[p.uid]?.confirmed === true);
      if(allConfirmed) {
        const bets = room.players.map(p => {
          const v = room.gameBetVotes[p.uid];
          return typeof v === 'object' ? (v.bet||5) : (v||5);
        });
        room.betAmount = Math.max(...bets);
        room.gameBetVotes = {};
        io.to(roomId).emit('game_action',{uid:'server', action:'game_bet_agreed', data:{bet:room.betAmount}});
      }
      return;
    }

    if(action === 'poker_action' && room?.pokerState) {
      const ps = room.pokerState;
      const oppUid = room.players.find(p => p.uid !== uid)?.uid;
      if(ps.currentTurn !== uid) return;
      const playerAction = data.action;
      const myBetNow = ps.bets[uid]||0;
      const findSock = u => [...io.sockets.sockets.values()].find(sk => sk.data.uid === u);

      if(playerAction === 'fold') {
        const winnerId = oppUid;
        const prize = ps.pot;
        ps.chips[winnerId] = (ps.chips[winnerId]||0) + ps.pot;
        io.to(roomId).emit('game_action',{uid:'server', action:'poker_fold', data:{
          winnerId, loserId: uid, prize, myChips: ps.chips[uid]||0, oppChips: ps.chips[winnerId], pot: 0
        }});
        io.to(roomId).emit('game_result',{winnerId, loserId:uid, prize,
          winnerChips: ps.chips[winnerId], loserChips: ps.chips[uid]||0});
        // Fichas do pote sao in-memory apenas — sem debito/credito no Firestore aqui
        room.pokerState = null;
        return;
      }

      if(playerAction === 'check') {
        if(ps.curBet > (ps.bets[uid]||0)) return;
        if(!ps.checkedUids) ps.checkedUids = new Set();
        ps.checkedUids.add(uid);
        if(ps.checkedUids.size >= 2) { advancePokerStage(room, roomId, io); return; }
        ps.currentTurn = oppUid;
        // Notifica ambos usando uid:'server' — frontend usa data.myTurn como fonte de verdade
        for(const p of room.players) {
          const pSockC = findSock(p.uid);
          const isMe = p.uid === uid;
          const oppU = room.players.find(op=>op.uid!==p.uid)?.uid;
          if(pSockC) pSockC.emit('game_action',{uid:'server', action:'poker_action', data:{
            action: isMe ? 'checked' : 'check',
            whoActed: uid,
            pot: ps.pot, myTurn: !isMe, curBet: 0,
            myChips: ps.chips[p.uid]||0, myBet: ps.bets[p.uid]||0,
            oppChips: ps.chips[oppU]||0, oppBet: ps.bets[oppU]||0,
          }});
        }
        return;
      }

      if(playerAction === 'call') {
        const toCall = Math.min(ps.curBet - myBetNow, ps.chips[uid]||0);
        ps.chips[uid] = (ps.chips[uid]||0) - toCall;
        ps.bets[uid] = myBetNow + toCall;
        ps.pot += toCall;
        ps.checkedUids = new Set();
        for(const p of room.players) {
          const pSockK = findSock(p.uid);
          const isMe = p.uid === uid;
          const oppU = room.players.find(op=>op.uid!==p.uid)?.uid;
          if(pSockK) pSockK.emit('game_action',{uid:'server', action:'poker_action', data:{
            action: isMe ? 'called' : 'call',
            whoActed: uid,
            pot: ps.pot, myTurn: false, curBet: ps.curBet,
            myChips: ps.chips[p.uid]||0, myBet: ps.bets[p.uid]||0,
            oppChips: ps.chips[oppU]||0, oppBet: ps.bets[oppU]||0,
          }});
        }
        setTimeout(() => advancePokerStage(room, roomId, io), 600);
        return;
      }

      // BET — primeira aposta na rua (curBet era 0)
      if(playerAction === 'bet') {
        const BB = room.betAmount || 5;
        const amount = Math.max(BB, parseInt(data.amount)||BB);
        const toAdd = Math.min(amount - myBetNow, ps.chips[uid]||0);
        if(toAdd <= 0) return;
        ps.chips[uid] = (ps.chips[uid]||0) - toAdd;
        ps.bets[uid] = myBetNow + toAdd;
        ps.pot += toAdd;
        ps.curBet = ps.bets[uid];
        ps.checkedUids = new Set();
        ps.currentTurn = oppUid;
        for(const p of room.players) {
          const pSockB = findSock(p.uid);
          const isMe = p.uid === uid;
          const oppU = room.players.find(op=>op.uid!==p.uid)?.uid;
          if(pSockB) pSockB.emit('game_action',{uid:'server', action:'poker_action', data:{
            action: isMe ? 'bet_done' : 'bet',
            whoActed: uid,
            pot: ps.pot, myTurn: !isMe, curBet: ps.curBet,
            myChips: ps.chips[p.uid]||0, myBet: ps.bets[p.uid]||0,
            oppChips: ps.chips[oppU]||0, oppBet: ps.bets[oppU]||0,
          }});
        }
        return;
      }

      if(playerAction === 'raise') {
        const BB = room.betAmount || 5;
        const amount = Math.max(ps.curBet+1, parseInt(data.amount)||ps.curBet*2||BB);
        const toAdd = Math.min(amount - myBetNow, ps.chips[uid]||0);
        if(toAdd <= 0) return;
        ps.chips[uid] = (ps.chips[uid]||0) - toAdd;
        ps.bets[uid] = myBetNow + toAdd;
        ps.pot += toAdd;
        ps.curBet = ps.bets[uid];
        ps.checkedUids = new Set();
        ps.currentTurn = oppUid;
        for(const p of room.players) {
          const pSockR = findSock(p.uid);
          const isMe = p.uid === uid;
          const oppU = room.players.find(op=>op.uid!==p.uid)?.uid;
          if(pSockR) pSockR.emit('game_action',{uid:'server', action:'poker_action', data:{
            action: isMe ? 'raised' : 'raise',
            whoActed: uid,
            pot: ps.pot, myTurn: !isMe, curBet: ps.curBet,
            myChips: ps.chips[p.uid]||0, myBet: ps.bets[p.uid]||0,
            oppChips: ps.chips[oppU]||0, oppBet: ps.bets[oppU]||0,
          }});
        }
        return;
      }
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
        io.to(roomId).emit('game_result',{winnerId:uid,loserId,prize:0});
        const wdom = room.players.find(p=>p.uid===uid); if(wdom) wdom.score=(wdom.score||0)+1;
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
        io.to(roomId).emit('game_result',{winnerId:winner,loserId:loser,prize:0});
        const wdom2 = room.players.find(p=>p.uid===winner); if(wdom2) wdom2.score=(wdom2.score||0)+1;
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
      io.to(roomId).emit('game_result', { winnerId, loserId, prize: 0 });
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
    try {
      const room = rooms.get(roomId);
      if (!room || room.status !== 'playing') return;
      room.status = 'finished';

      // Sem debito/credito aqui — as 5 fichas de entrada ja foram cobradas ao entrar na sala
      // Apenas notifica o resultado
      io.to(roomId).emit('game_result', { winnerId, loserId, prize: 0 });

      if(winnerId) {
        const wp = room.players.find(p=>p.uid===winnerId);
        if(wp) wp.score = (wp.score||0)+1;
      }
      if (room.matchId) {
        await db.collection('matches').doc(room.matchId).update({
          status: 'finished', winnerId, loserId,
          finishedAt: admin.firestore.FieldValue.serverTimestamp(),
        }).catch(()=>{});
      }
      rooms.delete(roomId);
      io.to('lobby').emit('rooms_update', getRoomsList());
    } catch(e) { console.error('game_over erro:', e.message); }
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

// ── Start ────────────────────────────────────────────────────
const PORT = process.env.PORT || 3001;
server.listen(PORT, () => console.log(`🎰 Cassino Backend rodando na porta ${PORT}`));