// CrystalDrop deposit server — zero dependencies (Node 22+). Creates crypto payments through NOWPayments,
// receives their signed webhooks, and records every credit exactly once in SQLite.
//   node --no-warnings server.js          (reads .env or environment variables, see .env.example)
const http = require('http'), crypto = require('crypto'), fs = require('fs'), path = require('path');
const { DatabaseSync } = require('node:sqlite');

// ---- config (.env file is optional) ----
try { for (const l of fs.readFileSync(path.join(__dirname, '.env'), 'utf8').split('\n')) { const m = l.match(/^\s*([A-Z_]+)\s*=\s*(.*?)\s*$/); if (m && !(m[1] in process.env)) process.env[m[1]] = m[2].replace(/^["']|["']$/g, ''); } } catch (e) {}
const E = process.env;
const cfg = {
  port: +E.PORT || 8788,
  provider: E.PROVIDER || (E.NOWPAYMENTS_API_KEY ? 'nowpayments' : 'mock'),     // 'nowpayments' | 'mock'
  apiKey: E.NOWPAYMENTS_API_KEY || '', ipnSecret: E.NOWPAYMENTS_IPN_SECRET || '',
  publicUrl: (E.PUBLIC_URL || '').replace(/\/$/, ''),                            // https://api.yoursite.com  (where NOWPayments can reach /webhook)
  allowOrigin: E.ALLOWED_ORIGIN || '*',                                          // set to your site, e.g. https://crystaldrop.gg
  adminToken: E.ADMIN_TOKEN || '',
  min: +E.DEPOSIT_MIN || 2, max: +E.DEPOSIT_MAX || 10000,                      // CR (1 CR = 1 USD)
  ttlMin: +E.DEPOSIT_TTL_MIN || 30,
  db: E.DB_FILE || path.join(__dirname, 'deposits.db'),
  sandbox: E.NOWPAYMENTS_SANDBOX === '1',
  siteUrl: (E.SITE_URL || '').replace(/\/$/, ''),                                 // where players land after Steam login, e.g. https://crystaldrop.gg
  steamKey: E.STEAM_API_KEY || '',                                              // optional: lets us show the Steam profile name
  sessionDays: +E.SESSION_DAYS || 30,
  skins: E.SKIN_PROVIDER || ((E.PROVIDER || (E.NOWPAYMENTS_API_KEY ? 'nowpayments' : 'mock')) === 'mock' ? 'mock' : 'off'),   // CS2 skin deposits: 'mock' (demo trades) | 'off' (until real trade bots are connected)
  skinRate: Math.min(1, Math.max(0.5, +E.SKIN_RATE || 0.9)),                    // CR credited per $1 of skin market value
  skinTtlMin: +E.SKIN_TTL_MIN || 15, skinMaxItems: +E.SKIN_MAX_ITEMS || 30, skinBot: E.SKIN_BOT_NAME || 'CrystalDropBot',
  email: { provider: E.EMAIL_PROVIDER || (E.RESEND_API_KEY ? 'resend' : 'console'), resendKey: E.RESEND_API_KEY || '', from: E.EMAIL_FROM || 'CrystalDrop <no-reply@example.com>' },
};
// coin + network (as the page sends them) -> NOWPayments pay_currency code. Verify against GET /v1/currencies for your account.
const COINS = {   // deposits: Solana only
  'SOL|Solana': { code: 'sol', conf: 32 },
};
if (cfg.provider === 'nowpayments' && (!cfg.apiKey || !cfg.ipnSecret || !cfg.publicUrl)) { console.error('NOWPAYMENTS_API_KEY, NOWPAYMENTS_IPN_SECRET and PUBLIC_URL are required for the nowpayments provider.'); process.exit(1); }

// ---- database ----
const db = new DatabaseSync(cfg.db);
db.exec(`PRAGMA journal_mode=WAL;
CREATE TABLE IF NOT EXISTS deposits (id TEXT PRIMARY KEY, user_id TEXT NOT NULL, coin TEXT, network TEXT, amount_cr REAL NOT NULL, crypto_amount REAL, rate REAL,
  address TEXT, memo TEXT, provider TEXT, provider_id TEXT UNIQUE, status TEXT NOT NULL, confirmations INTEGER DEFAULT 0, required INTEGER, txid TEXT,
  created_at INTEGER, expires_at INTEGER, credited_at INTEGER, raw_status TEXT);
CREATE TABLE IF NOT EXISTS ledger (id INTEGER PRIMARY KEY AUTOINCREMENT, user_id TEXT NOT NULL, amount REAL NOT NULL, reason TEXT, ref TEXT UNIQUE, created_at INTEGER);
CREATE TABLE IF NOT EXISTS users (id TEXT PRIMARY KEY, email TEXT UNIQUE, pass_salt TEXT, pass_hash TEXT, steam_id TEXT UNIQUE, name TEXT, created_at INTEGER, email_verified INTEGER DEFAULT 0);
CREATE TABLE IF NOT EXISTS email_tokens (token_hash TEXT PRIMARY KEY, user_id TEXT NOT NULL, kind TEXT NOT NULL, expires_at INTEGER);
CREATE TABLE IF NOT EXISTS sessions (token_hash TEXT PRIMARY KEY, user_id TEXT NOT NULL, expires_at INTEGER);
CREATE TABLE IF NOT EXISTS login_codes (code_hash TEXT PRIMARY KEY, user_id TEXT NOT NULL, expires_at INTEGER);
CREATE TABLE IF NOT EXISTS events (id INTEGER PRIMARY KEY AUTOINCREMENT, at INTEGER, deposit_id TEXT, note TEXT);
CREATE TABLE IF NOT EXISTS chat (id INTEGER PRIMARY KEY AUTOINCREMENT, user_id TEXT NOT NULL, name TEXT, text TEXT NOT NULL, ts INTEGER);
CREATE TABLE IF NOT EXISTS mutes (user_id TEXT PRIMARY KEY, until INTEGER);
CREATE TABLE IF NOT EXISTS feed (id INTEGER PRIMARY KEY AUTOINCREMENT, user_id TEXT NOT NULL, name TEXT, game TEXT, stake REAL, mult REAL, payout REAL, ts INTEGER);
CREATE TABLE IF NOT EXISTS tips (id INTEGER PRIMARY KEY AUTOINCREMENT, from_id TEXT NOT NULL, to_id TEXT NOT NULL, from_name TEXT, amount REAL NOT NULL, ts INTEGER, claimed INTEGER DEFAULT 0);`);
const q = {
  ins: db.prepare('INSERT INTO deposits (id,user_id,coin,network,amount_cr,crypto_amount,rate,address,memo,provider,provider_id,status,required,created_at,expires_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)'),
  get: db.prepare('SELECT * FROM deposits WHERE id=?'), byProv: db.prepare('SELECT * FROM deposits WHERE provider_id=?'),
  upd: db.prepare('UPDATE deposits SET status=?, confirmations=?, txid=COALESCE(?,txid), raw_status=? WHERE id=?'),
  credit: db.prepare('INSERT OR IGNORE INTO ledger (user_id,amount,reason,ref,created_at) VALUES (?,?,?,?,?)'),
  mark: db.prepare("UPDATE deposits SET status='credited', credited_at=? WHERE id=?"),
  bal: db.prepare('SELECT COALESCE(SUM(amount),0) AS b FROM ledger WHERE user_id=?'),
  ev: db.prepare('INSERT INTO events (at,deposit_id,note) VALUES (?,?,?)'),
};
try { db.exec('ALTER TABLE users ADD COLUMN referred_by TEXT'); } catch (e) {}
// balances now live here, in whole cents: bal_c (CR), pool_c (skins staked to play), vault_c, lock_c (CR bought but not yet wagered)
let _fresh = false; for (const c of ['bal_c', 'pool_c', 'vault_c', 'lock_c']) { try { db.exec('ALTER TABLE users ADD COLUMN ' + c + ' INTEGER NOT NULL DEFAULT 0'); if (c === 'bal_c') _fresh = true; } catch (e) {} }
if (_fresh) db.exec('UPDATE users SET bal_c = CAST(ROUND((SELECT COALESCE(SUM(amount),0) FROM ledger WHERE ledger.user_id = users.id) * 100) AS INTEGER)');
try { db.exec('ALTER TABLE users ADD COLUMN email_verified INTEGER DEFAULT 0'); } catch (e) {}
try { db.exec('ALTER TABLE deposits ADD COLUMN items TEXT'); } catch (e) {}
try { db.exec('ALTER TABLE deposits ADD COLUMN open INTEGER DEFAULT 0'); } catch (e) {}      // 1 = open-amount deposit: credited for whatever is actually sent
try { db.exec('ALTER TABLE deposits ADD COLUMN trade_url TEXT'); } catch (e) {}
try { db.exec('ALTER TABLE users ADD COLUMN name_set INTEGER DEFAULT 1'); } catch (e) {}      // 0 = Steam player still has to choose a name
const NAME_RE = /^[A-Za-z0-9]{3,15}$/;                                                          // display names: 3 to 15 letters and numbers only
const TRADE_URL = /^https:\/\/steamcommunity\.com\/tradeoffer\/new\/\?partner=\d{1,10}&token=[A-Za-z0-9_-]{8}$/;
const NAME_MSG = 'username must be 3 to 15 letters or numbers (no spaces, symbols or emojis)';
const nameBad = (() => { const sq = s => s.replace(/(.)\1+/g, '$1');
  const SUB = 'fuck shit bitch cunt pussy whore slut bastard nigger nigga faggot retard rapist hitler nazi penis vagina asshole wank twat porn molest pedophil paedophil jizz blowjob handjob dildo cumshot chink tranny dick boob killyourself motherfuck bukkake anus'.split(' ').map(sq);
  const EXACT = 'cock ass arse anal tit tits sex rape coon kkk cum spic gook dyke fag fags nig kike pedo kys hoe'.split(' ').map(sq);
  const RES_SUB = 'crystaldrop admin moderator official'.split(' ').map(sq), RES_EXACT = 'support staff owner system mod security helpdesk dev'.split(' ').map(sq);
  return n => { const low = n.toLowerCase(), outs = new Set();
    for (const one of ['i', 'l']) { const t = low.replace(/0/g, 'o').replace(/1/g, one).replace(/3/g, 'e').replace(/4/g, 'a').replace(/5/g, 's').replace(/7/g, 't').replace(/8/g, 'b').replace(/9/g, 'g'); outs.add(sq(t)); }
    for (const t of outs) { const bare = t.replace(/[0-9]/g, '');
      if (SUB.some(w => t.includes(w)) || RES_SUB.some(w => t.includes(w))) return true;
      if (EXACT.some(w => bare === w) || RES_EXACT.some(w => bare === w)) return true; }
    return false; }; })();
const NAME_BAD_MSG = 'that username is not allowed, please choose another';      // older databases
const log = (id, note) => { q.ev.run(Date.now(), id, String(note).slice(0, 300)); };

// Credit exactly once: ledger.ref is UNIQUE, so a replayed webhook can't double-pay. Both statements run in one transaction.
function creditDeposit(d) {
  db.exec('BEGIN IMMEDIATE');
  try { const r = q.credit.run(d.user_id, d.amount_cr, 'crypto deposit ' + d.coin, 'dep:' + d.id, Date.now()); if (r.changes) { q.mark.run(Date.now(), d.id); const c = Math.round(d.amount_cr * 100); db.prepare('UPDATE users SET bal_c = bal_c + ?, lock_c = lock_c + ? WHERE id=?').run(c, c, d.user_id); } db.exec('COMMIT'); return !!r.changes; }
  catch (e) { db.exec('ROLLBACK'); throw e; }
}
const MAP = { waiting: 'pending', confirming: 'confirming', confirmed: 'confirming', sending: 'confirming', partially_paid: 'partial', finished: 'credited', expired: 'expired', failed: 'expired', refunded: 'expired' };
function applyStatus(d, raw, txid, paidCR) {
  const st = MAP[raw] || 'pending';
  if (d.status === 'credited') return d.status;                                // final
  if (st === 'credited' && d.open && paidCR > 0) {                              // open deposit: credit what was really received (rounded down to the cent, capped)
    const amt = Math.min(cfg.max, Math.floor(paidCR * 100) / 100);
    if (!(amt >= cfg.min)) { q.upd.run('partial', d.confirmations, txid || null, raw, d.id); log(d.id, 'PAYMENT BELOW MINIMUM (' + paidCR + ' CR) — needs manual review'); return 'partial'; }
    db.prepare('UPDATE deposits SET amount_cr=? WHERE id=?').run(amt, d.id); d = { ...d, amount_cr: amt };
  }
  if (st === 'credited') { q.upd.run('credited', d.required, txid || null, raw, d.id); creditDeposit({ ...d }); log(d.id, 'credited ' + d.amount_cr + ' CR'); return 'credited'; }
  q.upd.run(st, st === 'confirming' ? Math.max(d.confirmations, 1) : d.confirmations, txid || null, raw, d.id); if (st === 'partial') log(d.id, 'PARTIAL PAYMENT — needs manual review'); return st;
}


// ---- accounts: email + password (scrypt), Steam OpenID, bearer sessions ----
const sha = x => crypto.createHash('sha256').update(x).digest('hex');
const scrypt = (pw, salt) => new Promise((ok, no) => crypto.scrypt(pw, salt, 64, { N: 16384, r: 8, p: 1 }, (e, k) => e ? no(e) : ok(k.toString('hex'))));
const U = {
  byEmail: db.prepare('SELECT * FROM users WHERE email=?'), bySteam: db.prepare('SELECT * FROM users WHERE steam_id=?'), byId: db.prepare('SELECT * FROM users WHERE id=?'),
  ins: db.prepare('INSERT INTO users (id,email,pass_salt,pass_hash,steam_id,name,created_at) VALUES (?,?,?,?,?,?,?)'),
  sess: db.prepare('INSERT INTO sessions (token_hash,user_id,expires_at) VALUES (?,?,?)'), getSess: db.prepare('SELECT * FROM sessions WHERE token_hash=?'), delSess: db.prepare('DELETE FROM sessions WHERE token_hash=?'),
  code: db.prepare('INSERT INTO login_codes (code_hash,user_id,expires_at) VALUES (?,?,?)'), getCode: db.prepare('SELECT * FROM login_codes WHERE code_hash=?'), delCode: db.prepare('DELETE FROM login_codes WHERE code_hash=?'),
  clean: db.prepare('DELETE FROM sessions WHERE expires_at<?'),
};
const newUserId = () => 'CR-' + crypto.randomBytes(5).toString('hex').toUpperCase();
const pubUser = u => ({ id: u.id, name: u.name, email: u.email || null, steam: !!u.steam_id, verified: !!(u.email_verified || u.steam_id), needsName: u.name_set === 0 || !NAME_RE.test(u.name || '') || nameBad(u.name || '') });
// ---- email (verification + password reset) ----
const outbox = [];                                                                 // 'console' provider keeps the last messages here (used by tests / local dev)
async function sendMail(to, subject, text) {
  if (cfg.email.provider === 'resend') {
    const r = await fetch('https://api.resend.com/emails', { method: 'POST', headers: { Authorization: 'Bearer ' + cfg.email.resendKey, 'Content-Type': 'application/json' }, body: JSON.stringify({ from: cfg.email.from, to: [to], subject, text }) });
    if (!r.ok) throw new Error('email provider ' + r.status); return;
  }
  outbox.push({ to, subject, text, at: Date.now() }); if (outbox.length > 50) outbox.shift(); console.log('[email:console] to=' + to + ' subject=' + subject + '\n' + text);
}
const ET = { ins: db.prepare('INSERT INTO email_tokens (token_hash,user_id,kind,expires_at) VALUES (?,?,?,?)'), get: db.prepare('SELECT * FROM email_tokens WHERE token_hash=?'), del: db.prepare('DELETE FROM email_tokens WHERE token_hash=?'), delKind: db.prepare('DELETE FROM email_tokens WHERE user_id=? AND kind=?'),
  verify: db.prepare('UPDATE users SET email_verified=1 WHERE id=?'), setPw: db.prepare('UPDATE users SET pass_salt=?, pass_hash=? WHERE id=?'), killSess: db.prepare('DELETE FROM sessions WHERE user_id=?') };
const issueToken = (uid, kind, ttlMs) => { ET.delKind.run(uid, kind); const t = crypto.randomBytes(32).toString('hex'); ET.ins.run(sha(t), uid, kind, Date.now() + ttlMs); return t; };
const sendVerify = async u => { const t = issueToken(u.id, 'verify', 48 * 36e5); await sendMail(u.email, 'Confirm your email for CrystalDrop', `Hi ${u.name},\n\nConfirm your email address to unlock deposits:\n${cfg.siteUrl}/#verify=${t}\n\nThe link works once and expires in 48 hours. If you didn't create an account, ignore this email.`); };
const mailGap = new Map();                                                         // at most one email per address per minute
const mailOk = key => { const now = Date.now(); if (now - (mailGap.get(key) || 0) < 60000) return false; mailGap.set(key, now); return true; };
const startSession = uid => { const t = crypto.randomBytes(32).toString('hex'); U.sess.run(sha(t), uid, Date.now() + cfg.sessionDays * 864e5); return t; };
const authUser = req => { const m = /^Bearer (\w{64})$/.exec(req.headers.authorization || ''); if (!m) return null; const s = U.getSess.get(sha(m[1])); if (!s || s.expires_at < Date.now()) return null; const u = U.byId.get(s.user_id) || null; return u && u.banned ? null : u; };
const tries = new Map();                                                         // login/signup attempts per IP: 12 per 15 min
const tooMany = ip => { const now = Date.now(), a = (tries.get(ip) || []).filter(t => now - t < 9e5); a.push(now); tries.set(ip, a); return a.length > (+E.AUTH_RATE || 12); };
const EMAIL = /^[^\s@]{1,64}@[^\s@]{1,190}\.[^\s@]{2,}$/;
async function steamVerify(params) {                                              // ask Steam to confirm the signed OpenID response
  const p = new URLSearchParams(params); p.set('openid.mode', 'check_authentication');
  const r = await fetch('https://steamcommunity.com/openid/login', { method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, body: p.toString() });
  return /is_valid\s*:\s*true/.test(await r.text());
}

// ---- providers ----
const MINC = {};
async function minCR(coin) {   // provider minimum in CR (1 CR = $1), exactly as NOWPayments reports it, cached 10 min
  if (cfg.provider !== 'nowpayments') return cfg.min;
  const c = MINC[coin.code]; if (c && Date.now() - c.at < 600000) return c.v;
  let v = cfg.min;
  try {
    const r = await fetch((cfg.sandbox ? 'https://api-sandbox.nowpayments.io' : 'https://api.nowpayments.io') + '/v1/min-amount?currency_from=' + coin.code + '&currency_to=' + coin.code + '&fiat_equivalent=usd&is_fixed_rate=True', { headers: { 'x-api-key': cfg.apiKey }, signal: AbortSignal.timeout(15000) });
    const j = await r.json().catch(() => ({})); const m = +j.fiat_equivalent; if (r.ok && m > 0) v = Math.max(cfg.min, Math.ceil(m * 100) / 100);
  } catch (e) { if (c) return c.v; }
  MINC[coin.code] = { v, at: Date.now() }; return v;
}
const providers = {
  async nowpayments(d, coin) {
    const r = await fetch((cfg.sandbox ? 'https://api-sandbox.nowpayments.io' : 'https://api.nowpayments.io') + '/v1/payment', { method: 'POST', signal: AbortSignal.timeout(35000), headers: { 'x-api-key': cfg.apiKey, 'Content-Type': 'application/json' },
      body: JSON.stringify({ price_amount: d.amount_cr, price_currency: 'usd', pay_currency: coin.code, order_id: d.id, order_description: 'CrystalDrop deposit', ipn_callback_url: cfg.publicUrl + '/webhook/nowpayments', is_fixed_rate: true }) });
    const j = await r.json().catch(() => ({})); if (!r.ok) throw new Error('provider: ' + (j.message || r.status));
    return { providerId: String(j.payment_id), address: j.pay_address, memo: j.payin_extra_id || '', cryptoAmount: +j.pay_amount, rate: d.amount_cr / +j.pay_amount };
  },
  async mock(d, coin) { return { providerId: 'mock_' + crypto.randomBytes(6).toString('hex'), address: 'MOCK-' + coin.code.toUpperCase() + '-' + crypto.randomBytes(8).toString('hex'), memo: '', cryptoAmount: +(d.amount_cr / 100).toFixed(6), rate: 100 }; },
};

// ---- http ----
const hits = new Map();                                                         // tiny per-IP rate limit for payment creation
const limited = ip => { const now = Date.now(), a = (hits.get(ip) || []).filter(t => now - t < 3600e3); a.push(now); hits.set(ip, a); return a.length > 20; };
// Anti-bot: after a Turnstile check the page gets a 24 h signed pass; sign up, log in and deposits then require it (only when TURNSTILE_SECRET is set).
const humanKey = () => 'human:' + (E.TURNSTILE_SECRET || '');
const humanPass = () => { const t = String(Date.now()); return t + '.' + crypto.createHmac('sha256', humanKey()).update(t).digest('hex'); };
const humanOk = req => { if (!E.TURNSTILE_SECRET) return true; const m = /^(\d{10,15})\.([0-9a-f]{64})$/.exec(req.headers['x-human'] || ''); if (!m || Date.now() - +m[1] > 864e5 || +m[1] > Date.now() + 6e4) return false;
  const want = crypto.createHmac('sha256', humanKey()).update(m[1]).digest(); return crypto.timingSafeEqual(want, Buffer.from(m[2], 'hex')); };
const send = (res, code, obj) => { const b = JSON.stringify(obj); res.writeHead(code, { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': cfg.allowOrigin, 'Access-Control-Allow-Headers': 'Content-Type, Authorization, X-Human', 'Access-Control-Allow-Methods': 'GET,POST,OPTIONS' }); res.end(b); };
const readBody = req => new Promise((ok, no) => { let b = ''; req.on('data', c => { b += c; if (b.length > 1e5) { no(new Error('too large')); req.destroy(); } }); req.on('end', () => ok(b)); req.on('error', no); });
const sortKeys = o => Array.isArray(o) ? o.map(sortKeys) : o && typeof o === 'object' ? Object.fromEntries(Object.keys(o).sort().map(k => [k, sortKeys(o[k])])) : o;
const pub = d => ({ open: !!d.open, id: d.id, status: d.status, confirmations: d.confirmations, required: d.required, txid: d.txid || undefined, address: d.address, amountCR: d.amount_cr });

const PLAY = require('./play.js')({ db, send, readBody, authUser, cfg });
const SPORTS = require('./sports.js')({ db, send, readBody, authUser, cfg, PLAY });
const ADMIN = require('./admin.js')({ db, cfg, send, readBody, PLAY, SPORTS, killSessions: uid => ET.killSess.run(uid) });
const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, 'http://x'), ip = req.socket.remoteAddress;
  try {
    if (req.method === 'OPTIONS') return send(res, 204, {});
    if (await ADMIN.route(req, res, url)) return;
    if (await SPORTS.route(req, res, url)) return;
    if (await PLAY.route(req, res, url)) return;
    if (req.method === 'POST' && url.pathname === '/captcha/verify') {      // Cloudflare Turnstile check (set TURNSTILE_SECRET)
      let b; try { b = JSON.parse(await readBody(req)); } catch (e) { return send(res, 400, { error: 'bad json' }); }
      if (!E.TURNSTILE_SECRET) return send(res, 200, { ok: true, skipped: true });
      try { const r = await fetch('https://challenges.cloudflare.com/turnstile/v0/siteverify', { method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams({ secret: E.TURNSTILE_SECRET, response: String(b.token || '') }) });
        const okc = !!(await r.json()).success; return send(res, 200, okc ? { ok: true, pass: humanPass() } : { ok: false }); } catch (e) { return send(res, 502, { ok: false, error: 'captcha service unreachable' }); }
    }
    // ---- live chat and tips ----  Chat: 5 second gap per user, 200 characters, no links, muted users blocked. Tips: whole accounts by display name, claimed by the receiver's page.
    const lastMsg = (globalThis.__lastMsg = globalThis.__lastMsg || new Map()), lastTip = (globalThis.__lastTip = globalThis.__lastTip || new Map());
    const CHAT_GAP = +E.CHAT_GAP_MS || 5000, TIP_MIN = 1, TIP_MAX = +E.TIP_MAX || 1000, TIP_DAY = +E.TIP_DAY || 5000;
    const needVerified = (u, res) => { if (!pubUser(u).verified) { send(res, 403, { error: 'confirm your email address first' }); return false; } return true; };
    if (req.method === 'GET' && url.pathname === '/chat') {
      const after = Math.max(0, +url.searchParams.get('after') || 0);
      const rows = after ? db.prepare('SELECT id, name, text, ts FROM chat WHERE id > ? ORDER BY id LIMIT 100').all(after) : db.prepare('SELECT id, name, text, ts FROM (SELECT * FROM chat ORDER BY id DESC LIMIT 60) ORDER BY id').all();
      return send(res, 200, { messages: rows, gapMs: CHAT_GAP });
    }
    if (req.method === 'POST' && url.pathname === '/chat') {
      const u = authUser(req); if (!u) return send(res, 401, { error: 'sign in to chat' }); if (!humanOk(req)) return send(res, 403, { error: 'verification required, reload the page' }); if (!needVerified(u, res)) return;
      let b; try { b = JSON.parse(await readBody(req)); } catch (e) { return send(res, 400, { error: 'bad json' }); }
      const mu = db.prepare('SELECT until FROM mutes WHERE user_id=?').get(u.id); if (mu && mu.until > Date.now()) return send(res, 403, { error: 'you are muted for ' + Math.ceil((mu.until - Date.now()) / 60000) + ' more minute(s)' });
      const now = Date.now(), last = lastMsg.get(u.id) || { t: 0, text: '' }; if (now - last.t < CHAT_GAP) return send(res, 429, { error: 'wait ' + Math.ceil((CHAT_GAP - (now - last.t)) / 1000) + ' seconds between messages', retryMs: CHAT_GAP - (now - last.t) });
      const text = String(b.text || '').replace(/[\u0000-\u001f\u007f​-‏‪-‮]/g, ' ').replace(/\s+/g, ' ').trim();
      if (!text) return send(res, 400, { error: 'type a message first' }); if (text.length > 200) return send(res, 400, { error: 'messages are 200 characters at most' });
      if (/(https?:|www\.|\b[a-z0-9-]+\.(com|net|org|io|gg|me|ru|xyz|co|to|ly)\b)/i.test(text)) return send(res, 400, { error: 'links are not allowed in chat' });
      if (text.toLowerCase() === last.text && now - last.t < 60000) return send(res, 400, { error: 'do not repeat the same message' });
      lastMsg.set(u.id, { t: now, text: text.toLowerCase() }); const r = db.prepare('INSERT INTO chat (user_id, name, text, ts) VALUES (?,?,?,?)').run(u.id, u.name, text, now);
      db.prepare('DELETE FROM chat WHERE id <= ?').run(Number(r.lastInsertRowid) - 500); return send(res, 200, { ok: true, id: Number(r.lastInsertRowid), gapMs: CHAT_GAP });
    }
    if (req.method === 'POST' && url.pathname === '/tips') {
      const u = authUser(req); if (!u) return send(res, 401, { error: 'sign in to tip' }); if (!humanOk(req)) return send(res, 403, { error: 'verification required, reload the page' }); if (!needVerified(u, res)) return;
      let b; try { b = JSON.parse(await readBody(req)); } catch (e) { return send(res, 400, { error: 'bad json' }); }
      const amt = +(+b.amount).toFixed(2), to = db.prepare('SELECT id, name FROM users WHERE name = ? COLLATE NOCASE').get(String(b.to || '').trim());
      if (!to) return send(res, 404, { error: 'no player with that display name' }); if (to.id === u.id) return send(res, 400, { error: 'you cannot tip yourself' });
      if (!(amt >= TIP_MIN) || amt > TIP_MAX) return send(res, 400, { error: 'tips are ' + TIP_MIN + ' to ' + TIP_MAX + ' CR' });
      const now = Date.now(); if (now - (lastTip.get(u.id) || 0) < 5000) return send(res, 429, { error: 'wait a few seconds between tips' });
      const day = db.prepare('SELECT COALESCE(SUM(amount),0) s FROM tips WHERE from_id=? AND ts > ?').get(u.id, now - 864e5).s; if (day + amt > TIP_DAY) return send(res, 400, { error: 'daily tip limit is ' + TIP_DAY + ' CR' });
      const c = Math.round(amt * 100); let fail = null; db.exec('BEGIN IMMEDIATE');
      try { const w = db.prepare('SELECT bal_c, lock_c FROM users WHERE id=?').get(u.id); if (w.lock_c > 0) fail = 'Tipping unlocks after you play ' + (w.lock_c / 100).toFixed(2) + ' more CR.'; else if (w.bal_c < c) fail = 'Not enough CR.';
        else { db.prepare('UPDATE users SET bal_c = bal_c - ? WHERE id=?').run(c, u.id); db.prepare('UPDATE users SET bal_c = bal_c + ? WHERE id=?').run(c, to.id); db.prepare('INSERT INTO tips (from_id, to_id, from_name, amount, ts, claimed) VALUES (?,?,?,?,?,1)').run(u.id, to.id, u.name, amt, now); } db.exec('COMMIT'); } catch (e) { db.exec('ROLLBACK'); throw e; }
      if (fail) return send(res, 400, { error: fail }); lastTip.set(u.id, now); return send(res, 200, { ok: true, to: to.name, amount: amt });
    }
    if (req.method === 'GET' && url.pathname === '/tips/incoming') {
      const u = authUser(req); if (!u) return send(res, 401, { error: 'not signed in' });
      return send(res, 200, { tips: db.prepare('SELECT id, from_name, amount, ts FROM tips WHERE to_id=? AND claimed=0 ORDER BY id LIMIT 50').all(u.id) });
    }
    if (req.method === 'POST' && url.pathname === '/tips/claim') {                                    // each tip is claimed once, so a page cannot credit it twice
      const u = authUser(req); if (!u) return send(res, 401, { error: 'not signed in' }); let b; try { b = JSON.parse(await readBody(req)); } catch (e) { return send(res, 400, { error: 'bad json' }); }
      const got = []; for (const id of (Array.isArray(b.ids) ? b.ids : []).slice(0, 50)) { const r = db.prepare('UPDATE tips SET claimed=1 WHERE id=? AND to_id=? AND claimed=0').run(+id, u.id); if (r.changes) { const t = db.prepare('SELECT id, from_name, amount FROM tips WHERE id=?').get(+id); got.push(t); } }
      return send(res, 200, { claimed: got });
    }
    if (req.method === 'POST' && url.pathname === '/admin/chat/delete') {
      if (!cfg.adminToken || req.headers.authorization !== 'Bearer ' + cfg.adminToken) return send(res, 401, { error: 'unauthorized' }); let b; try { b = JSON.parse(await readBody(req)); } catch (e) { return send(res, 400, { error: 'bad json' }); }
      return send(res, 200, { deleted: db.prepare('DELETE FROM chat WHERE id=?').run(+b.id).changes });
    }
    if (req.method === 'POST' && url.pathname === '/admin/mute') {
      if (!cfg.adminToken || req.headers.authorization !== 'Bearer ' + cfg.adminToken) return send(res, 401, { error: 'unauthorized' }); let b; try { b = JSON.parse(await readBody(req)); } catch (e) { return send(res, 400, { error: 'bad json' }); }
      const t = db.prepare('SELECT id FROM users WHERE name = ? COLLATE NOCASE').get(String(b.name || '')); if (!t) return send(res, 404, { error: 'no such player' });
      db.prepare('INSERT OR REPLACE INTO mutes (user_id, until) VALUES (?,?)').run(t.id, Date.now() + Math.max(1, +b.minutes || 60) * 60000); return send(res, 200, { ok: true });
    }
    if (req.method === 'GET' && url.pathname === '/health') return send(res, 200, { ok: true, provider: cfg.provider });
    if (req.method === 'POST' && url.pathname === '/auth/signup') {
      if (!humanOk(req)) return send(res, 403, { error: 'verification required, reload the page' });
      if (tooMany(ip)) return send(res, 429, { error: 'too many attempts, try again later' });
      let b; try { b = JSON.parse(await readBody(req)); } catch (e) { return send(res, 400, { error: 'bad json' }); }
      const email = String(b.email || '').trim().toLowerCase(), pw = String(b.password || '');
      if (!EMAIL.test(email)) return send(res, 400, { error: 'enter a valid email address' });
      if (pw.length < 8 || pw.length > 200) return send(res, 400, { error: 'password must be at least 8 characters' });
      const name = String(b.name || '').trim(); if (!NAME_RE.test(name)) return send(res, 400, { error: NAME_MSG });
      if (nameBad(name)) return send(res, 400, { error: NAME_BAD_MSG });
      if (db.prepare('SELECT 1 FROM users WHERE name = ? COLLATE NOCASE').get(name)) return send(res, 409, { error: 'that display name is taken' });
      if (b.adult !== true) return send(res, 400, { error: 'you must confirm you are 18 or older' });
      if (U.byEmail.get(email)) return send(res, 409, { error: 'that email is already registered' });
      const salt = crypto.randomBytes(16).toString('hex'), hash = await scrypt(pw, salt), id = newUserId();
      U.ins.run(id, email, salt, hash, null, name, Date.now()); U.clean.run(Date.now());
      const rc = String(b.ref || '').trim(); if (/^[A-Za-z0-9_-]{3,20}$/.test(rc)) db.prepare('UPDATE users SET referred_by=? WHERE id=?').run(rc, id);
      try { await sendVerify(U.byId.get(id)); mailGap.set('v:' + id, Date.now()); } catch (e) { log(null, 'verification email failed: ' + e.message); }
      return send(res, 200, { token: startSession(id), user: pubUser(U.byId.get(id)) });
    }
    if (req.method === 'POST' && url.pathname === '/auth/login') {
      if (!humanOk(req)) return send(res, 403, { error: 'verification required, reload the page' });
      if (tooMany(ip)) return send(res, 429, { error: 'too many attempts, try again later' });
      let b; try { b = JSON.parse(await readBody(req)); } catch (e) { return send(res, 400, { error: 'bad json' }); }
      const u = U.byEmail.get(String(b.email || '').trim().toLowerCase()), salt = u ? u.pass_salt : 'x'.repeat(32), hash = await scrypt(String(b.password || ''), salt);   // always hash: same timing for unknown emails
      if (!u || !u.pass_hash || hash.length !== u.pass_hash.length || !crypto.timingSafeEqual(Buffer.from(hash), Buffer.from(u.pass_hash))) return send(res, 401, { error: 'wrong email or password' });
      if (u.banned) return send(res, 403, { error: 'this account has been suspended' });
      return send(res, 200, { token: startSession(u.id), user: pubUser(u) });
    }
    if (req.method === 'POST' && url.pathname === '/auth/verify') {
      let b; try { b = JSON.parse(await readBody(req)); } catch (e) { return send(res, 400, { error: 'bad json' }); }
      const row = ET.get.get(sha(String(b.token || ''))); if (!row || row.kind !== 'verify' || row.expires_at < Date.now()) return send(res, 400, { error: 'this link is invalid or has expired' });
      ET.verify.run(row.user_id); ET.del.run(row.token_hash); return send(res, 200, { ok: true, user: pubUser(U.byId.get(row.user_id)) });
    }
    if (req.method === 'POST' && url.pathname === '/auth/resend-verification') {
      const u = authUser(req); if (!u) return send(res, 401, { error: 'not signed in' }); if (!u.email) return send(res, 400, { error: 'no email on this account' });
      if (u.email_verified) return send(res, 200, { ok: true, already: true }); if (!mailOk('v:' + u.id)) return send(res, 429, { error: 'wait a minute before asking again' });
      try { await sendVerify(u); } catch (e) { return send(res, 502, { error: 'could not send the email' }); } return send(res, 200, { ok: true });
    }
    if (req.method === 'POST' && url.pathname === '/auth/forgot') {                                    // always answers the same, so it can't be used to find out who has an account
      if (tooMany(ip)) return send(res, 429, { error: 'too many attempts, try again later' });
      let b; try { b = JSON.parse(await readBody(req)); } catch (e) { return send(res, 400, { error: 'bad json' }); }
      const email = String(b.email || '').trim().toLowerCase(), u = EMAIL.test(email) ? U.byEmail.get(email) : null;
      if (u && u.pass_hash && mailOk('r:' + u.id)) { try { const t = issueToken(u.id, 'reset', 36e5); await sendMail(u.email, 'Reset your CrystalDrop password', `Hi ${u.name},\n\nSomeone asked to reset your password. To choose a new one, open:\n${cfg.siteUrl}/#reset=${t}\n\nThe link works once and expires in 1 hour. If this wasn't you, ignore this email; your password stays the same.`); } catch (e) { log(null, 'reset email failed: ' + e.message); } }
      return send(res, 200, { ok: true });
    }
    if (req.method === 'POST' && url.pathname === '/auth/reset') {
      if (tooMany(ip)) return send(res, 429, { error: 'too many attempts, try again later' });
      let b; try { b = JSON.parse(await readBody(req)); } catch (e) { return send(res, 400, { error: 'bad json' }); }
      const pw = String(b.password || ''); if (pw.length < 8 || pw.length > 200) return send(res, 400, { error: 'password must be at least 8 characters' });
      const row = ET.get.get(sha(String(b.token || ''))); if (!row || row.kind !== 'reset' || row.expires_at < Date.now()) return send(res, 400, { error: 'this link is invalid or has expired' });
      const salt = crypto.randomBytes(16).toString('hex'); ET.setPw.run(salt, await scrypt(pw, salt), row.user_id); ET.del.run(row.token_hash); ET.verify.run(row.user_id);   // clicking the emailed link also proves the address
      ET.killSess.run(row.user_id);                                                                       // sign out everywhere
      return send(res, 200, { ok: true });
    }
    if (req.method === 'POST' && url.pathname === '/auth/change-password') {
      const u = authUser(req); if (!u) return send(res, 401, { error: 'not signed in' }); if (!u.pass_hash) return send(res, 400, { error: 'this account has no password' });
      if (tooMany(ip)) return send(res, 429, { error: 'too many attempts, try again later' });
      let b; try { b = JSON.parse(await readBody(req)); } catch (e) { return send(res, 400, { error: 'bad json' }); }
      const nw = String(b.password || ''); if (nw.length < 8 || nw.length > 200) return send(res, 400, { error: 'password must be at least 8 characters' });
      const h = await scrypt(String(b.current || ''), u.pass_salt); if (h.length !== u.pass_hash.length || !crypto.timingSafeEqual(Buffer.from(h), Buffer.from(u.pass_hash))) return send(res, 401, { error: 'current password is wrong' });
      const salt = crypto.randomBytes(16).toString('hex'); ET.setPw.run(salt, await scrypt(nw, salt), u.id);
      const keep = /^Bearer (\w{64})$/.exec(req.headers.authorization)[1]; db.prepare('DELETE FROM sessions WHERE user_id=? AND token_hash<>?').run(u.id, sha(keep));      // other devices are signed out, this one stays
      return send(res, 200, { ok: true });
    }
    if (req.method === 'POST' && url.pathname === '/auth/logout-others') {
      const u = authUser(req); if (!u) return send(res, 401, { error: 'not signed in' }); const keep = /^Bearer (\w{64})$/.exec(req.headers.authorization)[1];
      db.prepare('DELETE FROM sessions WHERE user_id=? AND token_hash<>?').run(u.id, sha(keep)); return send(res, 200, { ok: true });
    }
    if (req.method === 'POST' && url.pathname === '/auth/profile') {
      const u = authUser(req); if (!u) return send(res, 401, { error: 'not signed in' }); let b; try { b = JSON.parse(await readBody(req)); } catch (e) { return send(res, 400, { error: 'bad json' }); }
      const name = String(b.name || '').trim(); if (!NAME_RE.test(name)) return send(res, 400, { error: NAME_MSG });
      if (nameBad(name)) return send(res, 400, { error: NAME_BAD_MSG });
      if (db.prepare('SELECT 1 FROM users WHERE name = ? COLLATE NOCASE AND id != ?').get(name, u.id)) return send(res, 409, { error: 'that display name is taken' });
      db.prepare('UPDATE users SET name=?, name_set=1 WHERE id=?').run(name, u.id); return send(res, 200, { user: pubUser(U.byId.get(u.id)) });
    }
    if (req.method === 'GET' && url.pathname === '/auth/me') { const u = authUser(req); return u ? send(res, 200, { user: pubUser(u) }) : send(res, 401, { error: 'not signed in' }); }
    if (req.method === 'POST' && url.pathname === '/auth/logout') { const m = /^Bearer (\w{64})$/.exec(req.headers.authorization || ''); if (m) U.delSess.run(sha(m[1])); return send(res, 200, { ok: true }); }
    if (req.method === 'POST' && url.pathname === '/auth/exchange') {                                   // one-time code from the Steam redirect -> session token
      let b; try { b = JSON.parse(await readBody(req)); } catch (e) { return send(res, 400, { error: 'bad json' }); }
      const row = U.getCode.get(sha(String(b.code || ''))); if (row) U.delCode.run(row.code_hash);
      if (!row || row.expires_at < Date.now()) return send(res, 400, { error: 'login link expired, try again' });
      return send(res, 200, { token: startSession(row.user_id), user: pubUser(U.byId.get(row.user_id)) });
    }
    if (req.method === 'GET' && url.pathname === '/auth/steam') {
      if (!cfg.publicUrl && cfg.provider !== 'mock') return send(res, 500, { error: 'PUBLIC_URL not set' });
      const base = cfg.publicUrl || ('http://' + req.headers.host), back = cfg.siteUrl || '';
      if (!back) return send(res, 500, { error: 'SITE_URL not set' });
      const q2 = new URLSearchParams({ 'openid.ns': 'http://specs.openid.net/auth/2.0', 'openid.mode': 'checkid_setup', 'openid.return_to': base + '/auth/steam/callback', 'openid.realm': base,
        'openid.identity': 'http://specs.openid.net/auth/2.0/identifier_select', 'openid.claimed_id': 'http://specs.openid.net/auth/2.0/identifier_select' });
      res.writeHead(302, { Location: 'https://steamcommunity.com/openid/login?' + q2 }); return res.end();
    }
    if (req.method === 'GET' && url.pathname === '/auth/steam/callback') {
      const base = cfg.publicUrl || ('http://' + req.headers.host), params = Object.fromEntries(url.searchParams), back = cfg.siteUrl;
      const fail = msg => { res.writeHead(302, { Location: back + '/#steamerror=' + encodeURIComponent(msg) }); res.end(); };
      const m2 = /^https:\/\/steamcommunity\.com\/openid\/id\/(\d{17})$/.exec(params['openid.claimed_id'] || '');
      if (!m2 || params['openid.return_to'] !== base + '/auth/steam/callback' || params['openid.mode'] !== 'id_res') return fail('invalid Steam response');
      let valid = false; try { valid = await steamVerify(params); } catch (e) {}
      if (!valid) return fail('Steam could not verify the login');
      let u = U.bySteam.get(m2[1]);
      if (!u) { let name = 'Player' + m2[1].slice(-4);
        if (cfg.steamKey) { try { const j = await (await fetch('https://api.steampowered.com/ISteamUser/GetPlayerSummaries/v2/?key=' + cfg.steamKey + '&steamids=' + m2[1])).json(); const pn = String(j.response.players[0].personaname || '').replace(/[^A-Za-z0-9]/g, '').slice(0, 15); if (pn.length >= 3 && !nameBad(pn) && !db.prepare('SELECT 1 FROM users WHERE name = ? COLLATE NOCASE').get(pn)) name = pn; } catch (e) {} }
        if (db.prepare('SELECT 1 FROM users WHERE name = ? COLLATE NOCASE').get(name)) name = 'Player' + crypto.randomBytes(4).toString('hex');
        const id = newUserId(); U.ins.run(id, null, null, null, m2[1], name, Date.now()); db.prepare('UPDATE users SET name_set=0 WHERE id=?').run(id); u = U.byId.get(id); }
      const code = crypto.randomBytes(24).toString('hex'); U.code.run(sha(code), u.id, Date.now() + 60000);
      res.writeHead(302, { Location: back + '/#steam=' + code }); return res.end();
    }
    if (req.method === 'GET' && url.pathname === '/deposits/min') {       // smallest deposit the payment provider accepts for a coin
      const coin = COINS[(url.searchParams.get('coin') || '') + '|' + (url.searchParams.get('network') || '')]; if (!coin) return send(res, 400, { error: 'unsupported coin/network' });
      return send(res, 200, { minCR: await minCR(coin) });
    }
    if (req.method === 'POST' && url.pathname === '/deposits') {
      if (!humanOk(req)) return send(res, 403, { error: 'verification required, reload the page' });
      const au = authUser(req); if (!au) return send(res, 401, { error: 'sign in to deposit' });
      if (!pubUser(au).verified) return send(res, 403, { error: 'confirm your email address first (check your inbox)' });
      if (limited(ip)) return send(res, 429, { error: 'too many requests' });
      let b; try { b = JSON.parse(await readBody(req)); } catch (e) { return send(res, 400, { error: 'bad json' }); }
      const coin = COINS[b.coin + '|' + b.network], userId = au.id, open = !(+b.amountCR > 0);                                           // always the signed-in account, never what the page claims
      if (!coin) return send(res, 400, { error: 'unsupported coin/network' });
      if (open) {                                                                   // no amount asked for: hand out an address that is credited for whatever is sent (at least the minimum)
        const old = db.prepare("SELECT * FROM deposits WHERE user_id=? AND coin=? AND network=? AND open=1 AND status IN ('pending','confirming') AND expires_at>? ORDER BY created_at DESC LIMIT 1").get(userId, b.coin, b.network, Date.now());
        if (old) return send(res, 200, { id: old.id, address: old.address, memo: old.memo, cryptoAmount: old.crypto_amount, cryptoAmt: old.crypto_amount, rate: old.rate, expiresAt: new Date(old.expires_at).toISOString(), confirmationsRequired: old.required, open: true, minCR: old.amount_cr });
      }
      const amount = open ? await minCR(coin) : +b.amountCR;
      if (!(amount >= cfg.min && amount <= cfg.max)) return send(res, 400, { error: `amount must be between ${cfg.min} and ${cfg.max} CR` });
      const d = { id: 'dep_' + crypto.randomBytes(8).toString('hex'), user_id: userId, coin: b.coin, network: b.network, amount_cr: +amount.toFixed(2), required: coin.conf, open };
      let p; try { p = await providers[cfg.provider](d, coin); } catch (e) { if (open && /too small/i.test(e.message)) { d.amount_cr = +(d.amount_cr * 1.15).toFixed(2); p = await providers[cfg.provider](d, coin); } else throw e; }   // rate moved since the minimum was read: retry just above it
      const exp = Date.now() + (open ? Math.max(cfg.ttlMin, 360) : cfg.ttlMin) * 60000;
      q.ins.run(d.id, userId, b.coin, b.network, d.amount_cr, p.cryptoAmount, p.rate, p.address, p.memo, cfg.provider, p.providerId, 'pending', coin.conf, Date.now(), exp);
      if (open) db.prepare('UPDATE deposits SET open=1 WHERE id=?').run(d.id);
      log(d.id, 'created ' + b.coin + ' ' + p.cryptoAmount);
      return send(res, 200, { id: d.id, address: p.address, memo: p.memo, cryptoAmount: p.cryptoAmount, cryptoAmt: p.cryptoAmount, rate: p.rate, expiresAt: new Date(exp).toISOString(), confirmationsRequired: coin.conf, open, minCR: open ? d.amount_cr : undefined });
    }
    let m;
    if (req.method === 'GET' && url.pathname === '/skin-deposits/config') return send(res, 200, { enabled: cfg.skins !== 'off', demo: cfg.skins === 'mock', rate: cfg.skinRate, maxItems: cfg.skinMaxItems, min: cfg.min, max: cfg.max, ttlMin: cfg.skinTtlMin, bot: cfg.skinBot });
    if (req.method === 'POST' && url.pathname === '/skin-deposits') {                                       // CS2 skins -> CR. 'mock' = demo trades; real trade bots plug in behind this same route
      if (!humanOk(req)) return send(res, 403, { error: 'verification required, reload the page' });
      const au = authUser(req); if (!au) return send(res, 401, { error: 'sign in to deposit' });
      if (!pubUser(au).verified) return send(res, 403, { error: 'confirm your email address first (check your inbox)' });
      if (cfg.skins === 'off') return send(res, 503, { error: 'skin deposits are not available yet' });
      if (limited(ip)) return send(res, 429, { error: 'too many requests' });
      let b; try { b = JSON.parse(await readBody(req)); } catch (e) { return send(res, 400, { error: 'bad json' }); }
      const tu = String(b.tradeUrl || '').trim(); if (!TRADE_URL.test(tu)) return send(res, 400, { error: 'enter your Steam trade URL (https://steamcommunity.com/tradeoffer/new/?partner=...&token=...)' });
      const its = Array.isArray(b.items) ? b.items : []; if (!its.length || its.length > cfg.skinMaxItems) return send(res, 400, { error: `choose 1 to ${cfg.skinMaxItems} skins` });
      const items = []; let value = 0;
      for (const it of its) { const name = String(it && it.name || '').replace(/[\u0000-\u001f<>]/g, '').trim().slice(0, 120), price = +(it && it.price); if (name.length < 3 || !(price >= 0.03 && price <= cfg.max)) return send(res, 400, { error: 'invalid skin in the offer' }); items.push({ name, price: +price.toFixed(2), wear: String(it.wear || '').slice(0, 20) }); value += price; }
      value = +value.toFixed(2); const credit = Math.floor(value * cfg.skinRate * 100) / 100;
      if (!(credit >= cfg.min && credit <= cfg.max)) return send(res, 400, { error: `the offer must be worth between ${cfg.min} and ${cfg.max} CR after the ${Math.round(cfg.skinRate * 100)}% rate` });
      const id = 'dep_' + crypto.randomBytes(8).toString('hex'), code = 'CD-' + Array.from(crypto.randomBytes(4), x => 'ABCDEFGHJKMNPQRSTUVWXYZ23456789'[x % 31]).join(''), exp = Date.now() + cfg.skinTtlMin * 60000;
      q.ins.run(id, au.id, 'CS2', 'Steam trade', credit, items.length, cfg.skinRate, code, '', 'skins', 'skin_' + crypto.randomBytes(6).toString('hex'), 'pending', 1, Date.now(), exp);
      db.prepare('UPDATE deposits SET items=?, trade_url=? WHERE id=?').run(JSON.stringify(items), tu, id); log(id, 'skin offer ' + items.length + ' items, value ' + value + ', credit ' + credit);
      return send(res, 200, { id, code, bot: cfg.skinBot, value, credit, rate: cfg.skinRate, count: items.length, expiresAt: new Date(exp).toISOString(), demo: cfg.skins === 'mock' });
    }
    if (cfg.skins === 'mock' && req.method === 'POST' && (m = url.pathname.match(/^\/skin-deposits\/([\w-]+)\/simulate$/))) {   // demo only: pretend the player accepted the trade
      const au = authUser(req), d = q.get.get(m[1]); if (!au || !d || d.user_id !== au.id || d.coin !== 'CS2') return send(res, 404, { error: 'not found' });
      if (d.status === 'pending' && d.expires_at < Date.now()) return send(res, 400, { error: 'this trade offer has expired' });
      return send(res, 200, { status: applyStatus(d, 'finished', 'demotrade_' + crypto.randomBytes(4).toString('hex')) });
    }
    if (req.method === 'GET' && (m = url.pathname.match(/^\/deposits\/([\w-]+)$/))) {
      const au = authUser(req), d = q.get.get(m[1]); if (!au || !d || d.user_id !== au.id) return send(res, 404, { error: 'not found' });
      if (d.status === 'pending' && d.expires_at < Date.now() - 6 * 3600e3) { q.upd.run('expired', d.confirmations, null, d.raw_status, d.id); d.status = 'expired'; }   // keep a grace period: late payments can still arrive
      return send(res, 200, pub(d));
    }
    if (req.method === 'POST' && url.pathname === '/webhook/nowpayments') {
      const raw = await readBody(req), sig = String(req.headers['x-nowpayments-sig'] || '');
      let body; try { body = JSON.parse(raw); } catch (e) { return send(res, 400, { error: 'bad json' }); }
      const want = crypto.createHmac('sha512', cfg.ipnSecret).update(JSON.stringify(sortKeys(body))).digest('hex');
      const ok = sig.length === want.length && crypto.timingSafeEqual(Buffer.from(sig), Buffer.from(want));
      if (!ok) { log(null, 'webhook with bad signature from ' + ip); return send(res, 401, { error: 'bad signature' }); }
      const d = q.byProv.get(String(body.payment_id)); if (!d) return send(res, 200, { ok: true, ignored: true });
      const paid = +body.actually_paid_at_fiat > 0 ? +body.actually_paid_at_fiat : (+body.actually_paid > 0 ? +body.actually_paid * (d.rate || 0) : 0);
      const st = applyStatus(d, body.payment_status, body.payin_hash || body.payout_hash, paid);
      return send(res, 200, { ok: true, status: st });
    }
    if (cfg.provider === 'mock' && req.method === 'POST' && (m = url.pathname.match(/^\/dev\/pay\/([\w-]+)$/))) {   // test helper, mock mode only
      const d = q.get.get(m[1]); if (!d) return send(res, 404, { error: 'not found' });
      const sp = new URL(req.url, 'http://x').searchParams, st = applyStatus(d, sp.get('status') || 'finished', 'mocktx_' + crypto.randomBytes(4).toString('hex'), +sp.get('paid') || 0); return send(res, 200, { status: st });
    }
    if (req.method === 'GET' && (m = url.pathname.match(/^\/balance\/([^/]+)$/))) {                                     // credited-by-deposit total for a user (admin only)
      if (!cfg.adminToken || req.headers.authorization !== 'Bearer ' + cfg.adminToken) return send(res, 401, { error: 'unauthorized' });
      return send(res, 200, { userId: decodeURIComponent(m[1]), deposited: q.bal.get(decodeURIComponent(m[1])).b });
    }
    send(res, 404, { error: 'not found' });
  } catch (e) { console.error(e); send(res, 500, { error: e.message || 'server error' }); }
});
if (require.main === module) server.listen(cfg.port, () => console.log(`deposit server on :${cfg.port} · provider=${cfg.provider} · min ${cfg.min} max ${cfg.max} CR` + (cfg.allowOrigin === '*' ? ' · WARNING: ALLOWED_ORIGIN not set' : '')));
module.exports = { server, cfg, db, outbox };
