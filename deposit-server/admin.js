'use strict';
// Admin panel: GET /admin serves the page, POST /admin/api/* is the JSON API. Everything needs ADMIN_TOKEN (Bearer).
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

module.exports = function init({ db, cfg, send, readBody, PLAY, SPORTS, killSessions, reverseSkin }) {
  db.exec(`CREATE TABLE IF NOT EXISTS admin_log (id INTEGER PRIMARY KEY AUTOINCREMENT, ts INTEGER, action TEXT, target TEXT, detail TEXT, ip TEXT);`);
  try { db.exec('ALTER TABLE users ADD COLUMN banned INTEGER NOT NULL DEFAULT 0'); } catch (e) {}
  try { db.exec('ALTER TABLE users ADD COLUMN ban_reason TEXT'); } catch (e) {}

  // ---- backups: a consistent copy of the whole database, daily, plus on demand; download them so a wiped disk is never the end ----
  const BK_DIR = process.env.BACKUP_DIR || path.join(path.dirname(cfg.db), 'backups'), BK_KEEP = Math.max(2, +process.env.BACKUP_KEEP || 14), BK_HOURS = Math.max(1, +process.env.BACKUP_HOURS || 24);
  const bkList = () => { try { return fs.readdirSync(BK_DIR).filter(n => /^crystaldrop-[\w.-]+\.db$/.test(n)).sort().reverse().map(n => { const st = fs.statSync(path.join(BK_DIR, n)); return { name: n, size: st.size, ts: st.mtimeMs }; }); } catch (e) { return []; } };
  function makeBackup() {
    fs.mkdirSync(BK_DIR, { recursive: true });
    const name = 'crystaldrop-' + new Date().toISOString().replace(/[:.]/g, '-') + '.db', file = path.join(BK_DIR, name);
    db.exec("VACUUM INTO '" + file.replace(/'/g, "''") + "'");
    bkList().slice(BK_KEEP).forEach(x => { try { fs.unlinkSync(path.join(BK_DIR, x.name)); } catch (e) {} });
    return name;
  }
  const bkTick = () => { try { const l = bkList()[0]; if (!l || Date.now() - l.ts > BK_HOURS * 3600e3) { const n = makeBackup(); console.log('backup written', n); } } catch (e) { console.error('backup failed', e.message); } };
  setTimeout(bkTick, 60e3).unref(); setInterval(bkTick, 15 * 60e3).unref();
  if (!process.env.DB_FILE) console.warn('WARNING: DB_FILE is not set, so the database sits in the app folder and may be erased on every deploy. Attach a persistent disk and set DB_FILE (see README).');

  const fails = new Map();                                    // wrong-token attempts per IP: 10 per 15 min
  const ipOf = req => String(req.headers['x-forwarded-for'] || req.socket.remoteAddress || '').split(',').pop().trim();
  const tokOk = req => { const a = Buffer.from(String((req.headers.authorization || '').replace(/^Bearer /, ''))), b = Buffer.from(cfg.adminToken || '');
    return !!cfg.adminToken && a.length === b.length && crypto.timingSafeEqual(a, b); };
  function gate(req, res) {
    const ip = ipOf(req), now = Date.now(), a = (fails.get(ip) || []).filter(t => now - t < 9e5);
    if (a.length >= 10) { send(res, 429, { error: 'too many wrong tokens, wait 15 minutes' }); return false; }
    if (!tokOk(req)) { a.push(now); fails.set(ip, a); send(res, 401, { error: cfg.adminToken ? 'wrong token' : 'ADMIN_TOKEN is not set on the server' }); return false; }
    return true;
  }
  const audit = (req, action, target, detail) => db.prepare('INSERT INTO admin_log (ts,action,target,detail,ip) VALUES (?,?,?,?,?)').run(Date.now(), action, String(target || ''), String(detail || '').slice(0, 300), ipOf(req));
  const cr = c => Math.round(c || 0) / 100;
  const one = (sql, ...a) => db.prepare(sql).get(...a);
  const all = (sql, ...a) => db.prepare(sql).all(...a);
  const lim = (n, d, m) => Math.max(1, Math.min(m, Math.floor(+n) || d));

  const API = {
    overview() {
      const D = Date.now() - 864e5, r = one('SELECT COUNT(*) n, COALESCE(SUM(bal_c),0) bal, COALESCE(SUM(pool_c),0) pool, COALESCE(SUM(vault_c),0) vault FROM users');
      const sk = one('SELECT COUNT(*) n, COALESCE(SUM(price_c),0) v FROM skins');
      const t = one('SELECT COUNT(*) n, COALESCE(SUM(stake_c),0) st, COALESCE(SUM(payout_c),0) po FROM rounds');
      const d = one('SELECT COUNT(*) n, COALESCE(SUM(stake_c),0) st, COALESCE(SUM(payout_c),0) po, COUNT(DISTINCT user_id) pl FROM rounds WHERE ts > ?', D);
      const dep = one("SELECT COUNT(*) n, COALESCE(SUM(amount_cr),0) s FROM deposits WHERE credited_at IS NOT NULL");
      const dep24 = one("SELECT COALESCE(SUM(amount_cr),0) s FROM deposits WHERE credited_at > ?", D);
      const big = all('SELECT id, name, game, stake_c, payout_c, mult, ts FROM rounds WHERE ts > ? ORDER BY payout_c DESC LIMIT 5', D).map(x => ({ ...x, stake: cr(x.stake_c), payout: cr(x.payout_c) }));
      return { users: r.n, new24: one('SELECT COUNT(*) n FROM users WHERE created_at > ?', D).n, banned: one('SELECT COUNT(*) n FROM users WHERE banned=1').n,
        owed: { balances: cr(r.bal), staked: cr(r.pool), vault: cr(r.vault), total: cr(r.bal + r.pool + r.vault), skins: cr(sk.v), skinCount: sk.n },
        all: { rounds: t.n, wagered: cr(t.st), paid: cr(t.po), house: cr(t.st - t.po) }, day: { rounds: d.n, players: d.pl, wagered: cr(d.st), paid: cr(d.po), house: cr(d.st - d.po) },
        deposits: { count: dep.n, total: +dep.s.toFixed(2), day: +dep24.s.toFixed(2) }, openRounds: one('SELECT COUNT(*) n FROM sess').n, big, provider: cfg.provider, turnstile: !!process.env.TURNSTILE_SECRET, now: Date.now() };
    },
    users(b) {
      const q = String(b.q || '').trim(), off = Math.max(0, +b.offset || 0), L = lim(b.limit, 30, 100), like = '%' + q.replace(/[%_\\]/g, '') + '%';
      const sort = { new: 'created_at DESC', bal: '(bal_c+pool_c+vault_c) DESC', name: 'name COLLATE NOCASE' }[b.sort] || 'created_at DESC';
      const rows = q ? all(`SELECT * FROM users WHERE name LIKE ? OR email LIKE ? OR id = ? OR steam_id = ? ORDER BY ${sort} LIMIT ? OFFSET ?`, like, like, q, q, L, off) : all(`SELECT * FROM users ORDER BY ${sort} LIMIT ? OFFSET ?`, L, off);
      return { users: rows.map(u => ({ id: u.id, name: u.name, email: u.email, steam: !!u.steam_id, verified: !!u.email_verified, banned: !!u.banned, created: u.created_at, bal: cr(u.bal_c), pool: cr(u.pool_c), vault: cr(u.vault_c), lock: cr(u.lock_c) })) };
    },
    user(b) {
      const u = one('SELECT * FROM users WHERE id=?', String(b.id || '')); if (!u) throw Object.assign(new Error('no such user'), { code: 404 });
      const w = one('SELECT COUNT(*) n, COALESCE(SUM(stake_c),0) st, COALESCE(SUM(payout_c),0) po FROM rounds WHERE user_id=?', u.id);
      const dep = one('SELECT COALESCE(SUM(amount_cr),0) s, COUNT(*) n FROM deposits WHERE user_id=? AND credited_at IS NOT NULL', u.id);
      const mute = one('SELECT until FROM mutes WHERE user_id=?', u.id);
      return { user: { id: u.id, name: u.name, email: u.email, steam: u.steam_id, verified: !!u.email_verified, banned: !!u.banned, banReason: u.ban_reason, created: u.created_at, bal: cr(u.bal_c), pool: cr(u.pool_c), vault: cr(u.vault_c), lock: cr(u.lock_c), muted: mute && mute.until > Date.now() ? mute.until : 0 },
        stats: { rounds: w.n, wagered: cr(w.st), paid: cr(w.po), net: cr(w.po - w.st), deposited: +dep.s.toFixed(2), deposits: dep.n },
        skins: all('SELECT uid, item, price_c FROM skins WHERE user_id=? ORDER BY price_c DESC LIMIT 100', u.id).map(s => ({ uid: s.uid, price: cr(s.price_c) })),
        rounds: all('SELECT id, game, stake_c, payout_c, mult, label, ts FROM rounds WHERE user_id=? ORDER BY id DESC LIMIT 30', u.id).map(x => ({ id: x.id, game: x.game, stake: cr(x.stake_c), payout: cr(x.payout_c), mult: x.mult, label: x.label, ts: x.ts })),
        ledger: all('SELECT amount, reason, created_at FROM ledger WHERE user_id=? ORDER BY id DESC LIMIT 20', u.id) };
    },
    ban(b, req) {
      const u = one('SELECT id, name FROM users WHERE id=?', String(b.id || '')); if (!u) throw Object.assign(new Error('no such user'), { code: 404 });
      const on = b.banned ? 1 : 0, why = String(b.reason || '').slice(0, 200);
      db.prepare('UPDATE users SET banned=?, ban_reason=? WHERE id=?').run(on, on ? why : null, u.id); if (on) killSessions(u.id);
      audit(req, on ? 'ban' : 'unban', u.id + ' ' + u.name, why); return { ok: true };
    },
    deleteUser(b, req) {       // permanent: removes the account and its personal data; money records (ledger, deposits, rounds, bets) stay for your books
      const u = one('SELECT * FROM users WHERE id=?', String(b.id || '')); if (!u) throw Object.assign(new Error('no such user'), { code: 404 });
      if (String(b.confirm || '') !== u.name) throw new Error('type the exact player name to confirm');
      const money = u.bal_c + u.pool_c + u.vault_c;
      if (money > 0 && !b.force) throw new Error('this player still holds ' + cr(money) + ' CR (cash, skins or vault). Take it out first, or tick "delete anyway"');
      if (one("SELECT COUNT(*) n FROM deposits WHERE user_id=? AND provider='skins' AND (status='held' OR (status='pending' AND expires_at > ?))", u.id, Date.now()).n) throw new Error('this player has a skin trade on hold or open. Reverse it first (Deposits > Reverse) or wait');
      let bets = 0; try { bets = one("SELECT COUNT(*) n FROM sp_bets WHERE user_id=? AND status='open'", u.id).n; } catch (e) {}
      if (bets) throw new Error('this player has ' + bets + ' open sports bet(s). Let them settle first');
      return PLAY.tx(() => {
        for (const t of ['sessions', 'email_tokens', 'login_codes', 'mutes', 'chat', 'feed', 'fair', 'sess', 'skins', 'bot_jobs']) { try { db.prepare('DELETE FROM ' + t + ' WHERE user_id=?').run(u.id); } catch (e) {} }
        try { db.prepare('DELETE FROM tips WHERE from_id=? OR to_id=?').run(u.id, u.id); } catch (e) {}
        try { db.prepare("UPDATE rounds SET name='deleted' WHERE user_id=?").run(u.id); } catch (e) {}
        try { db.prepare('UPDATE users SET referred_by=NULL WHERE referred_by=?').run(u.id); } catch (e) {}
        db.prepare('DELETE FROM users WHERE id=?').run(u.id);
        audit(req, 'delete-user', u.id + ' ' + u.name, (u.email || 'steam ' + u.steam_id) + ', held ' + cr(money) + ' CR' + (b.force ? ' (forced)' : '')); return { ok: true };
      });
    },
    mute(b, req) {
      const u = one('SELECT id, name FROM users WHERE id=?', String(b.id || '')); if (!u) throw Object.assign(new Error('no such user'), { code: 404 });
      const m = Math.max(0, Math.min(525600, Math.floor(+b.minutes) || 0));
      if (!m) db.prepare('DELETE FROM mutes WHERE user_id=?').run(u.id); else db.prepare('INSERT OR REPLACE INTO mutes (user_id, until) VALUES (?,?)').run(u.id, Date.now() + m * 60000);
      audit(req, m ? 'mute' : 'unmute', u.id + ' ' + u.name, m + ' min'); return { ok: true };
    },
    adjust(b, req) {        // credit or debit CR with a mandatory reason; goes through the same ledger as deposits
      const amt = Math.round((+b.amount || 0) * 100), why = String(b.reason || '').trim().slice(0, 200);
      if (!amt || Math.abs(amt) > 100000000) throw new Error('amount must be a non-zero number'); if (why.length < 4) throw new Error('write a reason (4+ characters)');
      return PLAY.tx(() => { const u = one('SELECT id, name, bal_c FROM users WHERE id=?', String(b.id || '')); if (!u) throw Object.assign(new Error('no such user'), { code: 404 });
        if (u.bal_c + amt < 0) throw new Error('that would take the balance below zero (' + cr(u.bal_c) + ' CR available)');
        db.prepare('UPDATE users SET bal_c = bal_c + ? WHERE id=?').run(amt, u.id);
        db.prepare('INSERT INTO ledger (user_id, amount, reason, ref, created_at) VALUES (?,?,?,?,?)').run(u.id, amt / 100, 'admin: ' + why, 'adm:' + crypto.randomBytes(8).toString('hex'), Date.now());
        audit(req, amt > 0 ? 'credit' : 'debit', u.id + ' ' + u.name, (amt / 100) + ' CR: ' + why); return { ok: true, bal: cr(u.bal_c + amt) }; });
    },
    skinReverse(b, req) {      // Steam rolled a skin trade back (or you found a fraud): take the credit out again / cancel the hold
      const d = one("SELECT * FROM deposits WHERE id=? AND provider='skins'", String(b.id || '')); if (!d) throw Object.assign(new Error('no such skin deposit'), { code: 404 });
      if (!['held', 'credited'].includes(d.status)) throw new Error('only held or credited skin deposits can be reversed (this one is ' + d.status + ')');
      const st = reverseSkin(d, 'admin'); audit(req, 'skin-reverse', d.id, d.amount_cr + ' CR, user ' + d.user_id); return { ok: true, status: st };
    },
    rounds(b) {
      const L = lim(b.limit, 50, 200), w = [], a = [];
      if (b.user) { w.push('user_id = ?'); a.push(String(b.user)); } if (b.game) { w.push('game = ?'); a.push(String(b.game)); }
      if (+b.minPayout > 0) { w.push('payout_c >= ?'); a.push(Math.round(+b.minPayout * 100)); }
      return { rounds: all(`SELECT id, user_id, name, game, stake_c, payout_c, mult, label, n, ts FROM rounds ${w.length ? 'WHERE ' + w.join(' AND ') : ''} ORDER BY id DESC LIMIT ?`, ...a, L).map(x => ({ id: x.id, uid: x.user_id, name: x.name, game: x.game, stake: cr(x.stake_c), payout: cr(x.payout_c), mult: x.mult, label: x.label, n: x.n, ts: x.ts })),
        games: all('SELECT game, COUNT(*) n, SUM(stake_c) st, SUM(payout_c) po FROM rounds GROUP BY game ORDER BY n DESC').map(g => ({ game: g.game, rounds: g.n, wagered: cr(g.st), paid: cr(g.po), rtp: g.st ? +(g.po / g.st * 100).toFixed(2) : 0 })) };
    },
    deposits(b) {
      const L = lim(b.limit, 50, 200), st = String(b.status || '');
      return { deposits: all(`SELECT d.id, d.user_id, u.name, d.coin, d.network, d.amount_cr, d.status, d.txid, d.created_at, d.credited_at, d.hold_until, d.provider FROM deposits d LEFT JOIN users u ON u.id = d.user_id ${st === 'all' ? '' : st ? 'WHERE d.status = ?' : "WHERE d.status IN ('credited','confirming','partial','held')"} ORDER BY d.created_at DESC LIMIT ?`, ...(st && st !== 'all' ? [st] : []), L) };
    },
    chat(b) { return { chat: all('SELECT id, user_id, name, text, ts FROM chat ORDER BY id DESC LIMIT ?', lim(b.limit, 60, 200)) }; },
    chatDelete(b, req) { const n = db.prepare('DELETE FROM chat WHERE id=?').run(+b.id).changes; audit(req, 'chat delete', b.id, ''); return { deleted: n }; },
    prices(b) {
      const items = PLAY.catalog(), moved = items.filter(x => x.price !== x.base).length, q = String(b.q || '').toLowerCase();
      return { status: PLAY.priceStatus(), total: items.length, moved, items: items.filter(x => !q || x.name.toLowerCase().includes(q)).slice(0, 60) };
    },
    async pricesRefresh(b, req) { await PLAY.refreshPrices(); audit(req, 'price refresh', '', ''); return { status: PLAY.priceStatus() }; },
    sports(b) { return { status: SPORTS.admin.status(), summary: SPORTS.admin.summary(), events: SPORTS.admin.events(b.filter) }; },
    async sportsSync(b, req) { await SPORTS.admin.sync(); audit(req, 'sports sync', '', ''); return { status: SPORTS.admin.status() }; },
    sportsSettle(b, req) { const hs = Math.floor(+b.hs), as = Math.floor(+b.as); if (!(hs >= 0 && as >= 0 && hs < 100 && as < 100)) throw new Error('enter both scores'); const id = String(b.id || '');
      return PLAY.tx(() => { SPORTS.admin.manual(id, 'settled', hs, as); const r = SPORTS.admin.resolve(id, 'settled', hs, as); audit(req, 'sports settle', id, hs + '-' + as + ' (' + r.bets + ' bets)'); return { ok: true, ...r }; }); },
    sportsVoid(b, req) { const id = String(b.id || ''); return PLAY.tx(() => { SPORTS.admin.manual(id, 'cancelled', null, null); const r = SPORTS.admin.resolve(id, 'cancelled'); audit(req, 'sports void', id, r.bets + ' bets refunded'); return { ok: true, ...r }; }); },
    withdrawals(b) {
      const st = String(b.status || 'pending'), W = process.env.WITHDRAWALS === 'on';
      const rows = all(`SELECT w.*, u.name, u.email, u.created_at AS joined FROM withdrawals w LEFT JOIN users u ON u.id = w.user_id ${st === 'all' ? '' : 'WHERE w.status = ?'} ORDER BY w.created_at DESC LIMIT 200`, ...(st === 'all' ? [] : [st]));
      const dep = id => one('SELECT COALESCE(SUM(amount_cr),0) s FROM deposits WHERE user_id=? AND credited_at IS NOT NULL', id).s, wd = id => one("SELECT COALESCE(SUM(amount_c),0) s FROM withdrawals WHERE user_id=? AND status='paid'", id).s;
      const sum = one("SELECT COUNT(*) n, COALESCE(SUM(amount_c),0) s FROM withdrawals WHERE status='pending'");
      return { enabled: W, pending: { n: sum.n, amount: cr(sum.s) }, items: rows.map(w => ({ id: w.id, uid: w.user_id, name: w.name || w.user_id, joined: w.joined, amount: cr(w.amount_c), address: w.address, status: w.status, txid: w.txid, note: w.note, created: w.created_at, done: w.done_at, deposited: +dep(w.user_id).toFixed(2), withdrawn: cr(wd(w.user_id)) })) };
    },
    withdrawPaid(b, req) { const id = String(b.id || ''), tx = String(b.txid || '').trim().slice(0, 120); if (tx.length < 6) throw new Error('paste the transaction id or link (6+ characters)');
      return PLAY.tx(() => { const w = one('SELECT * FROM withdrawals WHERE id=?', id); if (!w) throw Object.assign(new Error('no such withdrawal'), { code: 404 }); if (w.status !== 'pending') throw new Error('already ' + w.status);
        db.prepare("UPDATE withdrawals SET status='paid', txid=?, done_at=? WHERE id=?").run(tx, Date.now(), id); audit(req, 'withdrawal paid', w.user_id + ' ' + id, cr(w.amount_c) + ' CR to ' + w.address + ' tx ' + tx); return { ok: true }; }); },
    withdrawReject(b, req) { const id = String(b.id || ''), why = String(b.reason || '').trim().slice(0, 200); if (why.length < 4) throw new Error('write a reason (4+ characters), the player sees it');
      return PLAY.tx(() => { const w = one('SELECT * FROM withdrawals WHERE id=?', id); if (!w) throw Object.assign(new Error('no such withdrawal'), { code: 404 }); if (w.status !== 'pending') throw new Error('already ' + w.status);
        db.prepare("UPDATE withdrawals SET status='rejected', note=?, done_at=? WHERE id=?").run(why, Date.now(), id); db.prepare('UPDATE users SET bal_c = bal_c + ? WHERE id=?').run(w.amount_c, w.user_id);
        db.prepare('INSERT INTO ledger (user_id,amount,reason,ref,created_at) VALUES (?,?,?,?,?)').run(w.user_id, w.amount_c / 100, 'withdrawal rejected: ' + why, 'wdr:' + id, Date.now());
        audit(req, 'withdrawal rejected', w.user_id + ' ' + id, cr(w.amount_c) + ' CR returned: ' + why); return { ok: true }; }); },
    backups() { const f = (() => { try { return db.prepare('PRAGMA page_count').get().page_count * db.prepare('PRAGMA page_size').get().page_size; } catch (e) { return 0; } })(); return { db: cfg.db, size: f, persistent: !!process.env.DB_FILE, dir: BK_DIR, keep: BK_KEEP, hours: BK_HOURS, files: bkList() }; },
    backupNow(b, req) { const name = makeBackup(); audit(req, 'backup', name, ''); return { ok: true, name }; },
    log(b) { return { log: all('SELECT ts, action, target, detail, ip FROM admin_log ORDER BY id DESC LIMIT ?', lim(b.limit, 100, 300)) }; },
  };
  const ROUTES = { deleteUser: API.deleteUser, skinReverse: API.skinReverse, overview: API.overview, backups: API.backups, 'backups/now': API.backupNow, users: API.users, user: API.user, ban: API.ban, mute: API.mute, adjust: API.adjust, rounds: API.rounds, deposits: API.deposits, withdrawals: API.withdrawals, 'withdrawals/paid': API.withdrawPaid, 'withdrawals/reject': API.withdrawReject, chat: API.chat, 'chat/delete': API.chatDelete, prices: API.prices, sports: API.sports, 'sports/sync': API.sportsSync, 'sports/settle': API.sportsSettle, 'sports/void': API.sportsVoid, 'prices/refresh': API.pricesRefresh, log: API.log };

  async function route(req, res, url) {
    const P = url.pathname;
    if (req.method === 'GET' && (P === '/admin' || P === '/admin/')) {
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store', 'X-Frame-Options': 'DENY', 'Referrer-Policy': 'no-referrer', 'X-Robots-Tag': 'noindex, nofollow',
        'Content-Security-Policy': "default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; connect-src 'self'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'" });
      res.end(PAGE); return true;
    }
    if (req.method === 'GET' && P === '/admin/backup') {   // download a backup file (Bearer token, like everything else here)
      if (!gate(req, res)) return true;
      const n = String(url.searchParams.get('name') || ''), f = bkList().find(x => x.name === n);
      if (!f) { send(res, 404, { error: 'no such backup' }); return true; }
      res.writeHead(200, { 'Content-Type': 'application/octet-stream', 'Content-Length': f.size, 'Content-Disposition': 'attachment; filename="' + f.name + '"', 'Cache-Control': 'no-store' });
      fs.createReadStream(path.join(BK_DIR, f.name)).pipe(res); return true;
    }
    const m = /^\/admin\/api\/([\w/]+)$/.exec(P); if (!m || req.method !== 'POST' || !ROUTES[m[1]]) return false;
    if (!gate(req, res)) return true;
    let b = {}; try { const t = await readBody(req); if (t) b = JSON.parse(t); } catch (e) { send(res, 400, { error: 'bad json' }); return true; }
    try { send(res, 200, await ROUTES[m[1]](b, req)); } catch (e) { send(res, e.code === 404 ? 404 : 400, { error: e.message || 'error' }); }
    return true;
  }
  return { route };
};

const PAGE = String.raw`<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta name="robots" content="noindex"><title>CrystalDrop Admin</title>
<style>
:root{--bg:#0b0d12;--p:#141822;--p2:#1b2030;--b:#262d40;--t:#e7eaf2;--m:#8a93a8;--a:#7c5cff;--g:#34d399;--r:#f87171;--y:#fbbf24}
*{box-sizing:border-box}body{margin:0;background:var(--bg);color:var(--t);font:14px/1.45 system-ui,sans-serif}
header{display:flex;gap:12px;align-items:center;padding:12px 16px;border-bottom:1px solid var(--b);position:sticky;top:0;background:var(--bg);z-index:5;flex-wrap:wrap}
header b{font-size:16px}nav{display:flex;gap:4px;flex-wrap:wrap;flex:1}nav button{background:none;border:0;color:var(--m);padding:7px 11px;border-radius:8px;cursor:pointer;font:inherit}
nav button.on{background:var(--p2);color:var(--t)}main{padding:16px;max-width:1200px;margin:0 auto}
.card{background:var(--p);border:1px solid var(--b);border-radius:12px;padding:14px;margin-bottom:14px}
.grid{display:grid;grid-template-columns:repeat(auto-fill,minmax(190px,1fr));gap:12px;margin-bottom:14px}
.k{background:var(--p);border:1px solid var(--b);border-radius:12px;padding:12px}.k small{color:var(--m);display:block;font-size:12px}.k b{font-size:20px}
table{width:100%;border-collapse:collapse}th,td{text-align:left;padding:7px 8px;border-bottom:1px solid var(--b);vertical-align:top}th{color:var(--m);font-weight:500;font-size:12px}
td.n,th.n{text-align:right;font-variant-numeric:tabular-nums}.wrap{overflow-x:auto}tr.click{cursor:pointer}tr.click:hover{background:var(--p2)}
input,select,button.b{background:var(--p2);border:1px solid var(--b);color:var(--t);border-radius:8px;padding:8px 10px;font:inherit}
button.b{cursor:pointer}button.b:hover{border-color:var(--a)}button.pri{background:var(--a);border-color:var(--a)}button.red{border-color:var(--r);color:var(--r)}
.row{display:flex;gap:8px;flex-wrap:wrap;align-items:center;margin-bottom:12px}.g{color:var(--g)}.r{color:var(--r)}.y{color:var(--y)}.m{color:var(--m)}
.tag{display:inline-block;padding:1px 7px;border-radius:99px;font-size:11px;background:var(--p2);border:1px solid var(--b)}
#login{max-width:360px;margin:12vh auto;text-align:center}#login input{width:100%;margin:12px 0}h3{margin:0 0 10px}#msg{position:fixed;bottom:14px;right:14px;background:var(--p2);border:1px solid var(--b);padding:10px 14px;border-radius:10px;max-width:80vw}
</style></head><body>
<div id="login" class="card"><h3>CrystalDrop admin</h3><div class="m">Enter the ADMIN_TOKEN from your server settings.</div><input id="tok" type="password" autocomplete="off" placeholder="admin token"><button class="b pri" id="go">Sign in</button><div id="lerr" class="r" style="margin-top:10px"></div></div>
<div id="app" hidden><header><b>CrystalDrop admin</b><nav id="nav"></nav><button class="b" id="out">Sign out</button></header><main id="main"></main></div><div id="msg" hidden></div>
<script>
const $=s=>document.querySelector(s);let TOKEN='';try{TOKEN=sessionStorage.getItem('cd_admin')||''}catch(e){}
const E=(t,a,...k)=>{const e=document.createElement(t);if(a)for(const x in a){if(x==='on')for(const y in a.on)e.addEventListener(y,a.on[y]);else if(x==='cls')e.className=a[x];else e.setAttribute(x,a[x])}for(const c of k.flat())if(c!=null)e.append(c.nodeType?c:String(c));return e};
const fmt=n=>(+n).toLocaleString('en-US',{minimumFractionDigits:2,maximumFractionDigits:2}),dt=t=>t?new Date(t).toLocaleString():'-';
let T;function toast(s,bad){const m=$('#msg');m.textContent=s;m.style.borderColor=bad?'var(--r)':'var(--g)';m.hidden=false;clearTimeout(T);T=setTimeout(()=>m.hidden=true,3500)}
async function api(p,b){const r=await fetch('/admin/api/'+p,{method:'POST',headers:{Authorization:'Bearer '+TOKEN,'Content-Type':'application/json'},body:JSON.stringify(b||{})});const j=await r.json().catch(()=>({}));if(!r.ok){if(r.status===401){signout()}throw new Error(j.error||('HTTP '+r.status))}return j}
function signout(){TOKEN='';try{sessionStorage.removeItem('cd_admin')}catch(e){}$('#app').hidden=true;$('#login').hidden=false}
$('#out').onclick=signout;
$('#go').onclick=async()=>{TOKEN=$('#tok').value.trim();$('#lerr').textContent='';try{await api('overview');try{sessionStorage.setItem('cd_admin',TOKEN)}catch(e){}start()}catch(e){$('#lerr').textContent=e.message}};
$('#tok').addEventListener('keydown',e=>{if(e.key==='Enter')$('#go').click()});
const TABS=['Overview','Players','Rounds','Deposits','Withdrawals','Sports','Chat','Prices','Backups','Log'];let tab='Overview';
function start(){$('#login').hidden=true;$('#app').hidden=false;const nav=$('#nav');nav.replaceChildren(...TABS.map(t=>E('button',{cls:t===tab?'on':'',on:{click:()=>{tab=t;start()}}},t)));VIEW[tab]().catch(e=>toast(e.message,1))}
const tbl=(heads,rows,onrow)=>E('div',{cls:'wrap'},E('table',null,E('thead',null,E('tr',null,heads.map(h=>E('th',{cls:h.n?'n':''},h.t||h)))),E('tbody',null,rows.map(r=>{const tr=E('tr',onrow?{cls:'click',on:{click:()=>onrow(r)}}:null,r.cells.map((c,i)=>E('td',{cls:heads[i]&&heads[i].n?'n':''},c)));return tr}))));
const K=(l,v,c)=>E('div',{cls:'k'},E('small',null,l),E('b',{cls:c||''},v));
const show=(...n)=>$('#main').replaceChildren(...n);
const VIEW={
async Overview(){const o=await api('overview');const pc=n=>n>=0?'g':'r';
 show(E('div',{cls:'grid'},K('Players',o.users),K('New (24h)',o.new24),K('Banned',o.banned,o.banned?'y':''),K('Open rounds',o.openRounds)),
 E('h3',null,'What you owe players (CR)'),E('div',{cls:'grid'},K('Total owed',fmt(o.owed.total)),K('Cash balances',fmt(o.owed.balances)),K('Skins staked',fmt(o.owed.staked)),K('Vault',fmt(o.owed.vault)),K('Skins in inventories',fmt(o.owed.skins)+' ('+o.owed.skinCount+')')),
 E('h3',null,'House result (CR wagered minus paid)'),E('div',{cls:'grid'},K('Last 24h',fmt(o.day.house),pc(o.day.house)),K('24h wagered',fmt(o.day.wagered)),K('24h rounds / players',o.day.rounds+' / '+o.day.players),K('All time',fmt(o.all.house),pc(o.all.house)),K('All time wagered',fmt(o.all.wagered)),K('All time rounds',o.all.rounds)),
 E('h3',null,'Deposits'),E('div',{cls:'grid'},K('Credited (all)',fmt(o.deposits.total)+' CR'),K('Credited (24h)',fmt(o.deposits.day)+' CR'),K('Payment provider',o.provider,o.provider==='mock'?'y':'g'),K('Bot check (Turnstile)',o.turnstile?'on':'OFF',o.turnstile?'g':'y')),
 E('h3',null,'Biggest payouts (24h)'),tbl(['Player','Game',{t:'Stake',n:1},{t:'Payout',n:1},{t:'x',n:1},'When'],o.big.map(x=>({cells:[x.name,x.game,fmt(x.stake),fmt(x.payout),x.mult,dt(x.ts)]}))))},
async Players(){const q=E('input',{placeholder:'name, email, id or steam id',value:VIEW._q||''}),s=E('select',null,E('option',{value:'new'},'Newest'),E('option',{value:'bal'},'Highest balance'),E('option',{value:'name'},'Name'));s.value=VIEW._s||'new';
 const out=E('div'),run=async()=>{VIEW._q=q.value;VIEW._s=s.value;const r=await api('users',{q:q.value,sort:s.value,limit:50});out.replaceChildren(tbl(['Name','Email',{t:'Cash',n:1},{t:'Staked',n:1},'Status','Joined'],r.users.map(u=>({id:u.id,cells:[u.name,u.email||(u.steam?'Steam':''),fmt(u.bal),fmt(u.pool),[u.banned?E('span',{cls:'tag r'},'banned '):null,u.verified?null:E('span',{cls:'tag y'},'unverified')],dt(u.created)]})),r=>PLAYER(r.id)))};
 q.addEventListener('keydown',e=>{if(e.key==='Enter')run()});s.onchange=run;show(E('div',{cls:'row'},q,s,E('button',{cls:'b pri',on:{click:run}},'Search')),out);await run()},
async Rounds(){const u=E('input',{placeholder:'user id (optional)'}),g=E('input',{placeholder:'game (optional)'}),mp=E('input',{placeholder:'min payout CR',size:12}),out=E('div'),
 run=async()=>{const r=await api('rounds',{user:u.value.trim(),game:g.value.trim(),minPayout:mp.value,limit:100});out.replaceChildren(E('h3',null,'Per game (all time)'),tbl(['Game',{t:'Rounds',n:1},{t:'Wagered',n:1},{t:'Paid',n:1},{t:'RTP %',n:1}],r.games.map(x=>({cells:[x.game,x.rounds,fmt(x.wagered),fmt(x.paid),x.rtp]}))),E('h3',{style:'margin-top:16px'},'Latest rounds'),tbl([{t:'#',n:1},'Player','Game',{t:'Stake',n:1},{t:'Payout',n:1},{t:'x',n:1},'Result','When'],r.rounds.map(x=>({id:x.uid,cells:[x.id,x.name,x.game,fmt(x.stake),fmt(x.payout),x.mult,x.label,dt(x.ts)]})),r=>PLAYER(r.id)))};
 show(E('div',{cls:'row'},u,g,mp,E('button',{cls:'b pri',on:{click:run}},'Filter')),out);await run()},
async Deposits(){const s=E('select',null,[['','paid, confirming and held'],['held','skins on hold'],['partial','needs review'],['pending','unpaid'],['expired','expired'],['all','everything']].map(x=>E('option',{value:x[0]},x[1]))),out=E('div'),run=async()=>{const r=await api('deposits',{status:s.value,limit:100});out.replaceChildren(tbl(['Player','Coin',{t:'CR',n:1},'Status','Created','Credited'],r.deposits.map(d=>({id:d.user_id,cells:[d.name||d.user_id,d.coin+(d.network?' / '+d.network:''),fmt(d.amount_cr),d.status+(d.status==='held'?' until '+dt(d.hold_until):''),dt(d.created_at),dt(d.credited_at),d.provider==='skins'&&(d.status==='held'||d.status==='credited')?E('button',{cls:'b red',on:{click:async e=>{e.stopPropagation();if(!confirm('Reverse this skin deposit? The CR is taken back out of the balance.'))return;try{await api('skinReverse',{id:d.id});run()}catch(x){alert(x.message)}}}},'Reverse'):''] })),r=>PLAYER(r.id)))};s.onchange=run;show(E('div',{cls:'row'},s),out);await run()},
async Withdrawals(){const filt=E('select',null,[['pending','waiting to be paid'],['paid','paid'],['rejected','rejected'],['all','everything']].map(x=>E('option',{value:x[0]},x[1]))),out=E('div'),run=async()=>{const r=await api('withdrawals',{status:filt.value});
 out.replaceChildren(E('div',{cls:'grid'},K('Withdrawals',r.enabled?'ON':'off (set WITHDRAWALS=on)',r.enabled?'g':'y'),K('Waiting to be paid',r.pending.n,r.pending.n?'y':'g'),K('Waiting amount (CR)',fmt(r.pending.amount))),
 tbl(['Player',{t:'CR',n:1},'SOL address','Asked','Status',{t:'Deposited',n:1},{t:'Withdrawn',n:1},'Action'],r.items.map(w=>{const f=E('input',{placeholder:w.status==='pending'?'tx link, or reason to reject':'',size:22,value:w.txid||w.note||''});if(w.status!=='pending')f.disabled=true;
  return {id:w.uid,cells:[w.name,fmt(w.amount),E('code',{style:'user-select:all;word-break:break-all'},w.address),dt(w.created),w.status,fmt(w.deposited),fmt(w.withdrawn),w.status!=='pending'?E('span',{cls:'m'},w.done?dt(w.done):''):E('span',{cls:'row',style:'margin:0'},f,
   E('button',{cls:'b pri',on:{click:async e=>{e.stopPropagation();try{await api('withdrawals/paid',{id:w.id,txid:f.value});toast('Marked paid');run()}catch(z){toast(z.message,1)}}}},'Mark paid'),
   E('button',{cls:'b red',on:{click:async e=>{e.stopPropagation();try{await api('withdrawals/reject',{id:w.id,reason:f.value});toast('Rejected, CR returned');run()}catch(z){toast(z.message,1)}}}},'Reject'))]}}),r=>PLAYER(r.id)))};
 filt.onchange=run;show(E('div',{cls:'row'},filt,E('span',{cls:'m'},'Send the SOL yourself from your wallet, paste the transaction link, press Mark paid. Reject needs a reason in the same box and gives the CR back.')),out);await run()},
async Sports(){const filt=E('select',null,E('option',{value:''},'All matches'),E('option',{value:'open'},'With open bets'));filt.value=VIEW._sf||'';const out=E('div'),run=async()=>{VIEW._sf=filt.value;const r=await api('sports',{filter:filt.value}),s=r.status,m=r.summary;
 out.replaceChildren(E('div',{cls:'grid'},K('Feed',s.mode,s.mode==='live'?'g':'y'),K('Last sync',s.last?dt(s.last):'never',s.last?'g':'y'),K('Matches stored',s.events),K('Last error',s.err||'none',s.err?'r':'g'),K('Odds-API key',s.keySet?'set':'NOT set',s.keySet?'g':'y'),K('Price cut',(s.cut*100).toFixed(1)+'%'),K('Live betting',s.liveBets?'ON':'off')),
 E('div',{cls:'grid'},K('Open bets',m.openBets),K('Open stake (CR)',fmt(m.openStake)),K('Most you could pay',fmt(m.openPotential),'y'),K('Settled wagered',fmt(m.settledStake)),K('House result',fmt(m.house),m.house>=0?'g':'r')),
 tbl(['Match','Sport','Start','Status',{t:'Open bets',n:1},{t:'Exposure',n:1},'Settle manually'],r.events.map(e=>{const h=E('input',{size:2,placeholder:'H',value:e.hs==null?'':e.hs}),a=E('input',{size:2,placeholder:'A',value:e.as==null?'':e.as});
  return {cells:[e.home+' v '+e.away+(e.league?' ('+e.league+')':''),e.sport,dt(e.start),e.status+(e.manual?' (manual)':''),e.openLegs,fmt(e.exposure),E('span',{cls:'row',style:'margin:0'},h,a,E('button',{cls:'b pri',on:{click:async()=>{try{const x=await api('sports/settle',{id:e.id,hs:h.value,as:a.value});toast('Settled, '+x.bets+' bets resolved');run()}catch(z){toast(z.message,1)}}}},'Settle'),E('button',{cls:'b red',on:{click:async()=>{try{const x=await api('sports/void',{id:e.id});toast('Voided, '+x.bets+' bets refunded');run()}catch(z){toast(z.message,1)}}}},'Void'))]}})))};
 filt.onchange=run;show(E('div',{cls:'row'},filt,E('button',{cls:'b pri',on:{click:async e=>{e.target.disabled=true;try{await api('sports/sync');toast('Synced')}catch(x){toast(x.message,1)}e.target.disabled=false;run()}}},'Sync now'),E('span',{cls:'m'},'Settle uses the final score (90 minutes for soccer, maps won for CS2). Void refunds every open bet on the match.')),out);await run()},
async Chat(){const r=await api('chat',{limit:100});show(tbl(['Player','Message','When',''],r.chat.map(m=>({cells:[m.name,m.text,dt(m.ts),E('button',{cls:'b red',on:{click:async e=>{e.stopPropagation();await api('chat/delete',{id:m.id});toast('Deleted');VIEW.Chat()}}},'Delete')]}))))},
async Prices(){const q=E('input',{placeholder:'search skin'}),out=E('div'),run=async()=>{const r=await api('prices',{q:q.value});const s=r.status;out.replaceChildren(E('div',{cls:'grid'},K('Last refresh',s.updated?dt(s.updated):'never',s.updated?'g':'y'),K('Skins priced live',s.live+' / '+r.total),K('Prices moved from base',r.moved),K('Last error',s.err||'none',s.err?'r':'g')),
  tbl(['Skin',{t:'Base',n:1},{t:'Now',n:1},{t:'Change',n:1}],r.items.map(x=>({cells:[x.name,fmt(x.base),fmt(x.price),((x.price/x.base-1)*100).toFixed(1)+'%']}))))};
 q.addEventListener('keydown',e=>{if(e.key==='Enter')run()});show(E('div',{cls:'row'},q,E('button',{cls:'b',on:{click:run}},'Search'),E('button',{cls:'b pri',on:{click:async e=>{e.target.disabled=true;try{await api('prices/refresh');toast('Prices refreshed')}catch(x){toast(x.message,1)}e.target.disabled=false;run()}}},'Refresh prices now')),out);await run()},
async Backups(){const r=await api('backups');const mb=n=>(n/1048576).toFixed(2)+' MB';
 const dl=async n=>{const x=await fetch('/admin/backup?name='+encodeURIComponent(n),{headers:{Authorization:'Bearer '+TOKEN}});if(!x.ok){alert('download failed');return}const a=E('a',{href:URL.createObjectURL(await x.blob()),download:n});document.body.append(a);a.click();a.remove()};
 const now=E('button',{cls:'b pri',on:{click:async()=>{now.disabled=true;try{await api('backups/now')}catch(e){alert(e.message)}VIEW.Backups()}}},'Back up now');
 show(E('div',{cls:'grid'},K('Database file',r.db),K('Size',mb(r.size)),K('Saved on a persistent disk',r.persistent?'yes':'NO - set DB_FILE',r.persistent?'g':'r'),K('Automatic backup',' every '+r.hours+' h, keep '+r.keep)),
 r.persistent?E('span'):E('p',{style:'color:#fbbf24'},'The database is not on a persistent disk, so a deploy or restart can erase every balance. Attach a disk in Render and set DB_FILE (see the README), and download backups here regularly.'),
 E('div',{cls:'row',style:'margin:12px 0'},now),E('p',{style:'opacity:.7'},'Backups stay on the same server disk. Download one now and then and keep it somewhere else.'),
 tbl(['File',{t:'Size',n:1},'When',''],r.files.map(x=>({cells:[x.name,mb(x.size),dt(x.ts),E('button',{cls:'b',on:{click:e=>{e.stopPropagation();dl(x.name)}}},'Download')]}))))},
async Log(){const r=await api('log',{limit:200});show(tbl(['When','Action','Target','Detail','IP'],r.log.map(x=>({cells:[dt(x.ts),x.action,x.target,x.detail,x.ip]}))))},
};
async function PLAYER(id){const r=await api('user',{id}),u=r.user,s=r.stats,amt=E('input',{placeholder:'+50 or -20',size:10}),why=E('input',{placeholder:'reason (required)',size:28}),mins=E('input',{placeholder:'minutes',size:7,value:'60'}),bwhy=E('input',{placeholder:'ban reason',size:24}),dname=E('input',{placeholder:'type the player name',size:24}),dforce=E('input',{type:'checkbox'});
 const act=(fn,ok)=>async()=>{try{await fn();toast(ok);PLAYER(id)}catch(e){toast(e.message,1)}};
 show(E('button',{cls:'b',on:{click:()=>start()}},'< Back'),E('div',{cls:'card',style:'margin-top:12px'},E('h3',null,u.name+' ',u.banned?E('span',{cls:'tag r'},'banned'):null,u.muted?E('span',{cls:'tag y'},' muted until '+dt(u.muted)):null),
  E('div',{cls:'m'},'id '+u.id+' · '+(u.email||'steam '+u.steam)+' · '+(u.verified?'email verified':'email NOT verified')+' · joined '+dt(u.created)+(u.banned&&u.banReason?' · ban reason: '+u.banReason:''))),
 E('div',{cls:'grid'},K('Cash',fmt(u.bal)),K('Skins staked',fmt(u.pool)),K('Vault',fmt(u.vault)),K('Locked (unwagered)',fmt(u.lock)),K('Wagered',fmt(s.wagered)),K('Net result for player',fmt(s.net),s.net>=0?'g':'r'),K('Rounds',s.rounds),K('Deposited',fmt(s.deposited)+' CR')),
 E('div',{cls:'card'},E('h3',null,'Delete account'),E('div',{cls:'row'},dname,E('label',{cls:'m',style:'display:flex;gap:6px;align-items:center'},dforce,'delete even if it still holds CR'),E('button',{cls:'b red',on:{click:async()=>{try{await api('deleteUser',{id,confirm:dname.value,force:dforce.checked});toast('Account deleted');tab='Players';start()}catch(e){toast(e.message,1)}}}},'Delete forever')),E('div',{cls:'m'},'Type the exact player name ('+u.name+') to confirm. This cannot be undone. Chat, sessions, skins and login are removed; deposit, ledger and round records stay for your books.')),
 E('div',{cls:'card'},E('h3',null,'Adjust balance'),E('div',{cls:'row'},amt,why,E('button',{cls:'b pri',on:{click:act(()=>api('adjust',{id,amount:amt.value,reason:why.value}),'Balance updated')}},'Apply')),E('div',{cls:'m'},'Use a plus to credit, a minus to debit. Every change is written to the ledger and the log.')),
 E('div',{cls:'card'},E('h3',null,'Moderation'),E('div',{cls:'row'},mins,E('button',{cls:'b',on:{click:act(()=>api('mute',{id,minutes:mins.value}),'Muted')}},'Mute chat'),E('button',{cls:'b',on:{click:act(()=>api('mute',{id,minutes:0}),'Unmuted')}},'Unmute')),
  E('div',{cls:'row'},u.banned?E('button',{cls:'b pri',on:{click:act(()=>api('ban',{id,banned:false}),'Unbanned')}},'Unban'):[bwhy,E('button',{cls:'b red',on:{click:act(()=>api('ban',{id,banned:true,reason:bwhy.value}),'Banned, sessions ended')}},'Ban player')])),
 E('h3',null,'Latest rounds'),tbl(['Game',{t:'Stake',n:1},{t:'Payout',n:1},{t:'x',n:1},'Result','When'],r.rounds.map(x=>({cells:[x.game,fmt(x.stake),fmt(x.payout),x.mult,x.label,dt(x.ts)]}))),
 E('h3',{style:'margin-top:16px'},'Ledger'),tbl([{t:'CR',n:1},'Reason','When'],r.ledger.map(x=>({cells:[fmt(x.amount),x.reason,dt(x.created_at)]}))),
 E('h3',{style:'margin-top:16px'},'Skins ('+r.skins.length+')'),E('div',{cls:'m'},r.skins.map(x=>fmt(x.price)).join(' · ')||'none'))}
if(TOKEN){api('overview').then(start).catch(()=>signout())}
</script></body></html>`;
