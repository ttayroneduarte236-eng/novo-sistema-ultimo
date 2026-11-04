const express = require('express'), fs = require('fs'), path = require('path'), crypto = require('crypto'), bcrypt = require('bcryptjs');
const app = express();
app.set('trust proxy', 1);
app.use(express.json({ limit: '5mb' }));

const DIR = process.env.DATA_DIR || path.join(__dirname, 'data');
fs.mkdirSync(DIR, { recursive: true });
const DB = path.join(DIR, 'db.json');
const SECRET = process.env.SECRET || (() => {
  const f = path.join(DIR, 'secret');
  if (!fs.existsSync(f)) fs.writeFileSync(f, crypto.randomBytes(32).toString('hex'));
  return fs.readFileSync(f, 'utf8');
})();

const load = () => fs.existsSync(DB) ? JSON.parse(fs.readFileSync(DB, 'utf8'))
  : { users: [], data: { est: [], notas: [], fin: [], seq: 1, cfg: {} } };
const store = d => { fs.writeFileSync(DB + '.tmp', JSON.stringify(d)); fs.renameSync(DB + '.tmp', DB); };

const hmac = p => crypto.createHmac('sha256', SECRET).update(p).digest('hex');
const sign = u => { const p = u + '.' + (Date.now() + 7 * 864e5); return p + '.' + hmac(p); };
function verify(t) {
  if (!t) return null;
  const a = t.split('.'); if (a.length !== 3) return null;
  const h = hmac(a[0] + '.' + a[1]);
  if (h.length !== a[2].length || !crypto.timingSafeEqual(Buffer.from(h), Buffer.from(a[2]))) return null;
  return +a[1] > Date.now() ? a[0] : null;
}
const cookie = req => ((req.headers.cookie || '').split(';').map(s => s.trim()).find(s => s.startsWith('tk=')) || '').slice(3);
const who = req => verify(cookie(req));
const setCk = (req, res, v, age) => res.setHeader('Set-Cookie',
  `tk=${v}; HttpOnly; SameSite=Strict; Path=/; Max-Age=${age}` + (req.secure ? '; Secure' : ''));
const auth = (req, res, next) => who(req) ? next() : res.status(401).json({ erro: 'Não autenticado' });

// limite simples de tentativas por IP
const tent = new Map();
function limite(req, res, next) {
  const k = req.ip, n = Date.now(), l = (tent.get(k) || []).filter(t => n - t < 15 * 60e3);
  if (l.length >= 10) return res.status(429).json({ erro: 'Muitas tentativas. Aguarde 15 minutos.' });
  l.push(n); tent.set(k, l); next();
}

app.get('/api/status', (req, res) => res.json({ hasUsers: load().users.length > 0, logged: !!who(req) }));

app.post('/api/signup', limite, (req, res) => {
  const { user = '', pass = '', code = '' } = req.body || {};
  const db = load(), u = String(user).toLowerCase().trim();
  const convite = process.env.CODIGO_CONVITE || '';
  if (db.users.length > 0 && !(convite && code === convite)) return res.status(403).json({ erro: 'Código de convite inválido' });
  if (!/^[a-z0-9_]{3,30}$/.test(u)) return res.status(400).json({ erro: 'Usuário: 3 a 30 letras minúsculas, números ou _' });
  if (String(pass).length < 8) return res.status(400).json({ erro: 'A senha precisa ter ao menos 8 caracteres' });
  if (db.users.some(x => x.user === u)) return res.status(409).json({ erro: 'Usuário já existe' });
  db.users.push({ user: u, hash: bcrypt.hashSync(String(pass), 10), admin: db.users.length === 0 });
  store(db); setCk(req, res, sign(u), 604800); res.json({ ok: true });
});

app.post('/api/login', limite, (req, res) => {
  const { user = '', pass = '' } = req.body || {};
  const u = load().users.find(x => x.user === String(user).toLowerCase().trim());
  if (!u || !bcrypt.compareSync(String(pass), u.hash)) return res.status(401).json({ erro: 'Usuário ou senha incorretos' });
  setCk(req, res, sign(u.user), 604800); res.json({ ok: true });
});

app.post('/api/logout', (req, res) => { setCk(req, res, '', 0); res.json({ ok: true }); });
app.get('/api/data', auth, (req, res) => res.json(load().data));
app.post('/api/data', auth, (req, res) => {
  const d = req.body;
  if (!d || !Array.isArray(d.est) || !Array.isArray(d.notas) || !Array.isArray(d.fin)) return res.status(400).json({ erro: 'Dados inválidos' });
  const db = load(); db.data = d; store(db); res.json({ ok: true });
});

// ---- Mercado Pago (cobrança Pix e link de cartão) ----
const mpTok = () => process.env.MP_ACCESS_TOKEN || '';
async function mp(p, opts = {}) {
  const r = await fetch('https://api.mercadopago.com' + p, {
    ...opts, headers: { Authorization: 'Bearer ' + mpTok(), 'Content-Type': 'application/json', ...(opts.headers || {}) }
  });
  const j = await r.json().catch(() => ({}));
  if (!r.ok) {
    console.error('Mercado Pago', r.status, JSON.stringify(j).slice(0, 500));
    throw new Error(j.message || ('Erro no Mercado Pago (' + r.status + ')'));
  }
  return j;
}
const mpGuard = (req, res, next) => mpTok() ? next()
  : res.status(503).json({ erro: 'Mercado Pago não configurado no servidor (variável MP_ACCESS_TOKEN).' });
const notaRef = n => 'duarte-' + n.num + '-' + (n.ts || 0);
const getNota = num => /^\d+$/.test(String(num)) ? load().data.notas.find(n => n.num === +num) : null;
const valor = n => Number(Number(n.total).toFixed(2));

app.post('/api/mp/pix', auth, mpGuard, async (req, res) => {
  try {
    const n = getNota(req.body && req.body.num);
    if (!n) return res.status(404).json({ erro: 'Nota não encontrada no servidor' });
    const j = await mp('/v1/payments', {
      method: 'POST', headers: { 'X-Idempotency-Key': crypto.randomUUID() },
      body: JSON.stringify({
        transaction_amount: valor(n), description: 'Nota nº ' + n.num + ' - DUARTE MOTOS',
        payment_method_id: 'pix', external_reference: notaRef(n),
        payer: { email: process.env.MP_PAYER_EMAIL || 'pagador@duartemotos.com.br' }
      })
    });
    const t = j.point_of_interaction && j.point_of_interaction.transaction_data;
    if (!t || !t.qr_code) throw new Error('O Mercado Pago não retornou o código Pix');
    res.json({ id: j.id, qr: t.qr_code });
  } catch (e) { res.status(502).json({ erro: e.message }); }
});

app.post('/api/mp/openfinance', auth, mpGuard, async (req, res) => {
  try {
    const n = getNota(req.body && req.body.num);
    if (!n) return res.status(404).json({ erro: 'Nota não encontrada no servidor' });
    const origem = process.env.PUBLIC_URL || (req.protocol + '://' + req.get('host'));
    const j = await mp('/v1/payments', {
      method: 'POST', headers: { 'X-Idempotency-Key': crypto.randomUUID() },
      body: JSON.stringify({
        transaction_amount: valor(n), description: 'Nota nº ' + n.num + ' - DUARTE MOTOS',
        payment_method_id: 'pix', external_reference: notaRef(n),
        payer: { email: process.env.MP_PAYER_EMAIL || 'pagador@duartemotos.com.br' },
        point_of_interaction: { linked_to: 'openfinance' }, callback_url: origem
      })
    });
    const t = j.point_of_interaction && j.point_of_interaction.transaction_data;
    if (!t || !t.ticket_url) throw new Error('O Mercado Pago não retornou o link do Open Finance');
    res.json({ id: j.id, url: t.ticket_url });
  } catch (e) { res.status(502).json({ erro: e.message }); }
});

app.post('/api/mp/link', auth, mpGuard, async (req, res) => {
  try {
    const n = getNota(req.body && req.body.num);
    if (!n) return res.status(404).json({ erro: 'Nota não encontrada no servidor' });
    const j = await mp('/checkout/preferences', {
      method: 'POST',
      body: JSON.stringify({
        items: [{ title: 'Nota nº ' + n.num + ' - DUARTE MOTOS', quantity: 1, unit_price: valor(n), currency_id: 'BRL' }],
        external_reference: notaRef(n)
      })
    });
    if (!j.init_point) throw new Error('O Mercado Pago não retornou o link');
    res.json({ url: j.init_point });
  } catch (e) { res.status(502).json({ erro: e.message }); }
});

app.get('/api/mp/status/:num', auth, mpGuard, async (req, res) => {
  try {
    const n = getNota(req.params.num);
    if (!n) return res.status(404).json({ erro: 'Nota não encontrada no servidor' });
    const j = await mp('/v1/payments/search?sort=date_created&criteria=desc&external_reference=' + encodeURIComponent(notaRef(n)));
    const ok = (j.results || []).some(p => p.status === 'approved' && Number(p.transaction_amount) >= valor(n) - 0.01);
    res.json({ approved: ok });
  } catch (e) { res.status(502).json({ erro: e.message }); }
});

// ---- Open Finance (Pluggy): movimentações da conta bancária ----
let pkey = { k: '', exp: 0 };
const pgOn = () => !!(process.env.PLUGGY_CLIENT_ID && process.env.PLUGGY_CLIENT_SECRET);
async function pluggyKey() {
  if (pkey.k && Date.now() < pkey.exp) return pkey.k;
  const r = await fetch('https://api.pluggy.ai/auth', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ clientId: process.env.PLUGGY_CLIENT_ID, clientSecret: process.env.PLUGGY_CLIENT_SECRET })
  });
  const j = await r.json().catch(() => ({}));
  if (!r.ok || !j.apiKey) throw new Error('Credenciais da Pluggy inválidas');
  pkey = { k: j.apiKey, exp: Date.now() + 100 * 60e3 };
  return pkey.k;
}
async function pluggy(p, opts = {}) {
  const key = await pluggyKey();
  const r = await fetch('https://api.pluggy.ai' + p, { ...opts, headers: { 'X-API-KEY': key, 'Content-Type': 'application/json', ...(opts.headers || {}) } });
  const j = await r.json().catch(() => ({}));
  if (!r.ok) { console.error('Pluggy', r.status, JSON.stringify(j).slice(0, 400)); throw new Error(j.message || ('Erro na Pluggy (' + r.status + ')')); }
  return j;
}
const pgGuard = (req, res, next) => pgOn() ? next()
  : res.status(503).json({ erro: 'Open Finance não configurado no servidor (variáveis PLUGGY_CLIENT_ID e PLUGGY_CLIENT_SECRET).' });

app.get('/api/banco/config', auth, (req, res) => {
  const db = load(); res.json({ pluggy: pgOn(), items: ((db.banco && db.banco.items) || []).length });
});
app.post('/api/banco/connect-token', auth, pgGuard, async (req, res) => {
  try {
    const j = await pluggy('/connect_token', { method: 'POST', body: JSON.stringify({ options: { clientUserId: 'duarte-motos' } }) });
    res.json({ accessToken: j.accessToken });
  } catch (e) { res.status(502).json({ erro: e.message }); }
});
app.post('/api/banco/item', auth, pgGuard, (req, res) => {
  const id = String((req.body || {}).itemId || '');
  if (!/^[0-9a-f-]{36}$/i.test(id)) return res.status(400).json({ erro: 'Item inválido' });
  const db = load(); db.banco = db.banco || { items: [] };
  if (!db.banco.items.includes(id)) db.banco.items.push(id);
  store(db); res.json({ ok: true });
});
app.post('/api/banco/sync', auth, pgGuard, async (req, res) => {
  try {
    const db = load(), items = (db.banco && db.banco.items) || [];
    if (!items.length) return res.status(400).json({ erro: 'Nenhum banco conectado. Clique em Conectar banco.' });
    const from = new Date(Date.now() - 90 * 864e5).toISOString(), txs = [], contas = [];
    for (const it of items) {
      const ac = await pluggy('/accounts?itemId=' + encodeURIComponent(it));
      for (const a of (ac.results || []).filter(x => x.type === 'BANK')) {
        const nome = a.name || a.marketingName || 'Conta';
        contas.push({ nome, saldo: a.balance });
        for (let pg = 1; pg <= 10; pg++) {
          // GET /transactions está marcado como legado pela Pluggy; se deixar de funcionar, trocar por /v2/transactions
          const t = await pluggy('/transactions?accountId=' + encodeURIComponent(a.id) + '&from=' + encodeURIComponent(from) + '&pageSize=500&page=' + pg);
          (t.results || []).forEach(x => {
            if (x.status === 'PENDING') return;
            const v = Math.abs(Number(x.amount)); if (!isFinite(v)) return;
            txs.push({ id: 'p-' + x.id, ts: Date.parse(x.date), d: x.description || x.descriptionRaw || 'Movimentação', v: x.type === 'CREDIT' ? v : -v, conta: nome });
          });
          if (pg >= (t.totalPages || 1)) break;
        }
      }
    }
    res.json({ txs, contas });
  } catch (e) { res.status(502).json({ erro: e.message }); }
});
app.post('/api/banco/desconectar', auth, (req, res) => { const db = load(); db.banco = { items: [] }; store(db); res.json({ ok: true }); });

app.use(express.static(path.join(__dirname, 'public')));
app.listen(process.env.PORT || 3000, () => console.log('DUARTE MOTOS rodando'));
