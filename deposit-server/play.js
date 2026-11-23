// CrystalDrop wallet + games API. The server owns every balance, every skin and every roll:
// the browser only sends choices (a stake, a target, a tile) and shows what comes back.
'use strict';
const crypto = require('crypto');
const GM = require('./games');
const { UPCAT, cents, err, MAXPAY } = GM;
const MAXPAY_C = MAXPAY * 100;

module.exports = function init({ db, send, readBody, authUser, cfg }) {
  // ---------- schema ----------
  db.exec(`CREATE TABLE IF NOT EXISTS skins (uid TEXT PRIMARY KEY, user_id TEXT NOT NULL, item INTEGER NOT NULL, price_c INTEGER NOT NULL, ts INTEGER);
CREATE INDEX IF NOT EXISTS skins_u ON skins(user_id);
CREATE TABLE IF NOT EXISTS fair (user_id TEXT PRIMARY KEY, ss TEXT NOT NULL, cs TEXT NOT NULL, n INTEGER NOT NULL DEFAULT 0, hist TEXT NOT NULL DEFAULT '[]');
CREATE TABLE IF NOT EXISTS rounds (id INTEGER PRIMARY KEY AUTOINCREMENT, user_id TEXT NOT NULL, name TEXT, game TEXT, stake_c INTEGER, payout_c INTEGER, mult REAL, n INTEGER, cs TEXT, sh TEXT, label TEXT, ts INTEGER);
CREATE INDEX IF NOT EXISTS rounds_u ON rounds(user_id, id);
CREATE TABLE IF NOT EXISTS sess (id TEXT PRIMARY KEY, user_id TEXT NOT NULL, game TEXT NOT NULL, st TEXT NOT NULL, stake_c INTEGER NOT NULL, paid_c INTEGER NOT NULL DEFAULT 0, n INTEGER, c INTEGER, ts INTEGER);`);

  const tx = fn => { db.exec('BEGIN IMMEDIATE'); try { const r = fn(); db.exec('COMMIT'); return r; } catch (e) { try { db.exec('ROLLBACK'); } catch (x) {} throw e; } };
  const rnd32 = n => crypto.randomBytes(n).toString('hex');
  const sha = s => crypto.createHash('sha256').update(s).digest('hex');
  const fairNum = (ss, cs, n, c) => { const h = crypto.createHmac('sha256', ss).update(cs + ':' + n + ':' + c).digest(); return ((h[0] * 16777216) + (h[1] << 16) + (h[2] << 8) + h[3]) / 4294967296; };
  const toCR = c => Math.round(c) / 100;
  const toC = x => Math.round(+x * 100);

  // ---------- wallet ----------
  try { db.exec('ALTER TABLE users ADD COLUMN rb_acc REAL NOT NULL DEFAULT 0'); } catch (e) {}
  try { db.exec('ALTER TABLE users ADD COLUMN wag_c INTEGER NOT NULL DEFAULT 0'); db.exec('ALTER TABLE users ADD COLUMN nb INTEGER NOT NULL DEFAULT 0'); db.exec('UPDATE users SET wag_c=COALESCE((SELECT SUM(stake_c) FROM rounds WHERE user_id=users.id),0), nb=(SELECT COUNT(*) FROM rounds WHERE user_id=users.id)'); } catch (e) {}
  try { db.exec('ALTER TABLE users ADD COLUMN rb_paid_c INTEGER NOT NULL DEFAULT 0'); } catch (e) {}
  const RB_SHARE = 0.04;   // rakeback: 4% of the house edge on every wager
  const W = uid => db.prepare('SELECT bal_c, pool_c, vault_c, lock_c FROM users WHERE id=?').get(uid);
  const statsOf = uid => { const r = db.prepare('SELECT wag_c, nb FROM users WHERE id=?').get(uid) || { wag_c: 0, nb: 0 }; return { wagered: toCR(r.wag_c), bets: r.nb }; };
  const rbOf = uid => { const r = db.prepare('SELECT rb_acc, rb_paid_c FROM users WHERE id=?').get(uid) || { rb_acc: 0, rb_paid_c: 0 }; return { pending: toCR(Math.floor(r.rb_acc + 1e-9)), total: toCR(r.rb_paid_c), share: RB_SHARE }; };
  const wout = uid => { const w = W(uid); return { bal: toCR(w.bal_c), pool: toCR(w.pool_c), vault: toCR(w.vault_c), lock: toCR(w.lock_c) }; };
  const skinsOf = uid => db.prepare('SELECT uid, item, price_c FROM skins WHERE user_id=? ORDER BY ts DESC, uid').all(uid).map(s => ({ uid: s.uid, id: s.item, price: toCR(s.price_c) }));
  const newUid = () => rnd32(8);
  const giveSkin = (uid, item) => { const it = UPCAT[item], u = newUid(); db.prepare('INSERT INTO skins (uid,user_id,item,price_c,ts) VALUES (?,?,?,?,?)').run(u, uid, item, toC(it.price), Date.now()); return u; };

  // ---------- fair ----------
  const fairGet = uid => { let f = db.prepare('SELECT * FROM fair WHERE user_id=?').get(uid);
    if (!f) { db.prepare('INSERT INTO fair (user_id, ss, cs, n, hist) VALUES (?,?,?,?,?)').run(uid, rnd32(32), rnd32(8), 0, '[]'); f = db.prepare('SELECT * FROM fair WHERE user_id=?').get(uid); } return f; };
  const fairPub = uid => { const f = fairGet(uid); return { hash: sha(f.ss), cs: f.cs, n: f.n, hist: JSON.parse(f.hist) }; };
  const openCount = uid => db.prepare('SELECT COUNT(*) c FROM sess WHERE user_id=?').get(uid).c;
  const mkDraw = (ss, cs, n, c0) => { let c = c0 || 0; const d = () => fairNum(ss, cs, n, c++); d.cursor = () => c; return d; };
  const demoDraw = () => { const d = () => crypto.randomInt(0, 4294967296) / 4294967296; d.cursor = () => 0; return d; };

  // ---------- rate limit ----------
  const buckets = new Map();
  const allow = (key, rate = 60, burst = 200) => { const now = Date.now(); let b = buckets.get(key); if (!b) { b = { t: now, v: burst }; buckets.set(key, b); } b.v = Math.min(burst, b.v + (now - b.t) / 1000 * rate); b.t = now; if (b.v < 1) return false; b.v -= 1; return true; };

  // ---- live skin prices: the server is the only price authority ----
  db.exec(`CREATE TABLE IF NOT EXISTS prices (item INTEGER PRIMARY KEY, price REAL NOT NULL, ts INTEGER)`);
  for (const r of db.prepare('SELECT item, price FROM prices').all()) if (UPCAT[r.item] && r.price > 0) UPCAT[r.item].price = r.price;
  const PRICE = { updated: 0, live: 0, err: '' }, FEED_MS = 30 * 60 * 1000, MAXSTEP = 0.10, BAND = [0.5, 2];
  async function refreshPrices() {
    try {
      const ac = new AbortController(), to = setTimeout(() => ac.abort(), 20000);
      const r = await fetch('https://api.skinport.com/v1/items?app_id=730&currency=USD&tradable=0', { headers: { 'Accept-Encoding': 'br, gzip', 'User-Agent': 'CrystalDrop/1.0' }, signal: ac.signal }); clearTimeout(to);
      if (!r.ok) throw new Error('Skinport HTTP ' + r.status);
      const rows = await r.json(); if (!Array.isArray(rows) || rows.length < 500) throw new Error('unexpected Skinport reply');
      const M = new Map(); for (const x of rows) if (x && x.market_hash_name) M.set(x.market_hash_name, x);
      const grp = new Map(); for (const it of UPCAT) (grp.get(it.mhn) || grp.set(it.mhn, []).get(it.mhn)).push(it);
      let live = 0; const up = db.prepare('INSERT INTO prices (item, price, ts) VALUES (?,?,?) ON CONFLICT(item) DO UPDATE SET price=excluded.price, ts=excluded.ts');
      for (const [m, items] of grp) { const q = M.get(m); if (!q) continue;
        // median is robust to a single cheap or fake listing; fall back to min only when no median exists
        const mk = +(q.median_price || q.min_price); if (!(mk > 0) || !(q.quantity >= 3)) continue;
        const ref = Math.min(...items.map(y => y.base));
        for (const it of items) { const target = mk * (it.base / ref);                        // keep phase / gem premiums between variants of one market name
          if (target < it.base * BAND[0] || target > it.base * BAND[1]) continue;              // far from our reference price: ignore as bad data
          const lo = it.price * (1 - MAXSTEP), hi = it.price * (1 + MAXSTEP);
          const np = Math.max(0.05, Math.min(GM.MAXPAY, +Math.min(hi, Math.max(lo, target)).toFixed(2)));
          if (np !== it.price) { it.price = np; up.run(it.id, np, Date.now()); } live++; } }
      PRICE.updated = Date.now(); PRICE.live = live; PRICE.err = '';
    } catch (e) { PRICE.err = String(e.message || e).slice(0, 120); console.warn('price feed:', PRICE.err); }
  }
  if (process.env.PRICE_FEED !== 'off') { setTimeout(refreshPrices, 5000).unref(); setInterval(refreshPrices, FEED_MS).unref(); }
  setInterval(() => { const cut = Date.now() - 6e5; for (const [k, b] of buckets) if (b.t < cut) buckets.delete(k); for (const [k, s] of demoSess) if (s.ts < cut) demoSess.delete(k); }, 6e4).unref();
  const demoSess = new Map();

  // ---------- round logging ----------
  const logRound = (u, game, stake_c, payout_c, fair, label) => {
    const mult = stake_c ? Math.round(payout_c / stake_c * 100) / 100 : 0;
    db.prepare('INSERT INTO rounds (user_id,name,game,stake_c,payout_c,mult,n,cs,sh,label,ts) VALUES (?,?,?,?,?,?,?,?,?,?,?)').run(u.id, u.name, game, stake_c, payout_c, mult, fair.n, fair.cs, fair.sh, label || '', Date.now());
    db.prepare('UPDATE users SET wag_c = wag_c + ?, nb = nb + 1 WHERE id=?').run(stake_c, u.id);
    if (stake_c > 0) db.prepare('UPDATE users SET rb_acc = rb_acc + ? WHERE id=?').run(stake_c * (GM.EDGE[game] == null ? 0.03 : GM.EDGE[game]) * RB_SHARE, u.id);
    const last = db.prepare('SELECT id FROM rounds ORDER BY id DESC LIMIT 1').get(); if (last && last.id % 200 === 0) db.prepare('DELETE FROM rounds WHERE id < ?').run(last.id - 50000);
    return mult;
  };
  const spend = (uid, c) => { const w = W(uid); if (c > w.pool_c) throw err('Insufficient balance'); db.prepare('UPDATE users SET pool_c = pool_c - ?, lock_c = MAX(0, lock_c - ?) WHERE id=?').run(c, c, uid); };
  const earn = (uid, c) => { if (c) db.prepare('UPDATE users SET pool_c = pool_c + ? WHERE id=?').run(c, uid); };
  const payC = (stake_c, mult) => Math.min(MAXPAY_C, Math.max(0, Math.round(stake_c * mult + 1e-9)));

  const stakeCheck = (g, stake) => { const c = toC(stake); if (!(stake >= 0.01 - 1e-9) || !isFinite(stake) || stake > g.lim[1] + 1e-9) throw err(stake > g.lim[1] ? 'Maximum upgrade is ' + g.lim[1].toLocaleString('en-US', { minimumFractionDigits: 2 }) : 'Minimum upgrade is 0.01'); return c; };
  const stakeOf = (g, p, raw) => g.total ? g.total(p) : +raw;
  const pubFair = (f, n) => ({ n, cs: f.cs, sh: sha(f.ss) });

  // ---------- single-shot ----------
  function playOnce(u, gname, p, rawStake, demo, auto) {
    const g = GM.GAMES[gname]; if (!g) throw err('unknown game'); const run = auto ? g.auto : g.bet; if (!run) throw err('not available');
    p = p || {}; const stake = auto ? +rawStake : stakeOf(g, p, rawStake); const stake_c = stakeCheck(g, stake);
    if (demo) { const r = run(demoDraw(), p, stake); return out(r, stake_c, null); }
    return tx(() => { const f = fairGet(u.id), n = f.n + 1; spend(u.id, stake_c);
      const d = mkDraw(f.ss, f.cs, n, 0), r = run(d, p, stake), pay = payC(stake_c, r.mult);
      db.prepare('UPDATE fair SET n=? WHERE user_id=?').run(n, u.id); earn(u.id, pay);
      const fp = pubFair(f, n); logRound(u, gname, stake_c, pay, fp, r.label); return out(r, stake_c, fp, pay, u.id); });
  }
  const out = (r, stake_c, fp, pay, uid) => { const o = { ok: true, view: r.view, label: r.label, stake: toCR(stake_c), mult: stake_c ? Math.round((pay != null ? pay : payC(stake_c, r.mult)) / stake_c * 100) / 100 : 0, payout: toCR(pay != null ? pay : payC(stake_c, r.mult)) }; if (fp) o.fair = fp; if (uid) Object.assign(o, wout(uid)); return o; };

  // ---------- stateful ----------
  // what a finished round pays, in cents: blackjack pays its own totals, war adds its side bet win, the rest pay stake x multiplier
  const payFor = (r, st, main_c) => { if (r.payTotal != null) return toC(r.payTotal) + toC(r.payoutExtra || 0);
    return payC(r.bf ? main_c * r.bf : main_c, r.mult) + toC((st && st.side) || 0); };
  const finish = (u, gname, sid, sr, st, r, stake_c, fp) => { const pay = payFor(r, st, st._m); earn(u.id, pay); db.prepare('DELETE FROM sess WHERE id=?').run(sid); logRound(u, gname, stake_c, pay, fp, r.label); return pay; };
  function startSess(u, gname, p, rawStake, demo) {
    const g = GM.GAMES[gname]; if (!g || !g.start) throw err('unknown game'); p = p || {}; const stake = +rawStake, stake_c = stakeCheck(g, stake);
    if (demo) { const d = demoDraw(), r = g.start(d, p, stake), extra_c = toC(r.extra || 0), total = stake_c + extra_c;
      if (r.done) return { ...out(r, total, null, payFor(r, r.st, stake_c)), done: true };
      r.st._m = stake_c; const id = rnd32(12); demoSess.set(id, { game: gname, st: r.st, stake_c: total, ts: Date.now() }); return { ok: true, sid: id, view: r.view, stake: toCR(total) }; }
    // a round the player left is kept (stake included) until they come back to it; they cannot start another of the same game meanwhile
    if (db.prepare('SELECT 1 FROM sess WHERE user_id=? AND game=?').get(u.id, gname)) throw err('You have a round in progress. Reopen this game to continue it.');
    return tx(() => { const f = fairGet(u.id), n = f.n + 1, d = mkDraw(f.ss, f.cs, n, 0), r = g.start(d, p, stake), extra_c = toC(r.extra || 0), total = stake_c + extra_c;
      spend(u.id, total); db.prepare('UPDATE fair SET n=? WHERE user_id=?').run(n, u.id); const fp = pubFair(f, n);
      if (r.done) { const pay = payFor(r, r.st, stake_c); earn(u.id, pay); logRound(u, gname, total, pay, fp, r.label); return { ...out(r, total, fp, pay, u.id), done: true }; }
      r.st._m = stake_c; const id = rnd32(12);
      db.prepare('INSERT INTO sess (id,user_id,game,st,stake_c,paid_c,n,c,ts) VALUES (?,?,?,?,?,?,?,?,?)').run(id, u.id, gname, JSON.stringify(r.st), total, 0, n, d.cursor(), Date.now());
      return { ok: true, sid: id, view: r.view, stake: toCR(total), fair: fp, ...wout(u.id) }; });
  }
  function settleOpen(u, sid) { const sr = db.prepare('SELECT * FROM sess WHERE id=? AND user_id=?').get(sid, u.id); if (!sr) return null; const g = GM.GAMES[sr.game];
    return tx(() => { const f = fairGet(u.id), st = JSON.parse(sr.st), d = mkDraw(f.ss, f.cs, sr.n, sr.c), r = g.abandon(d, st, st._m / 100), fp = { n: sr.n, cs: f.cs, sh: sha(f.ss) };
      const pay = finish(u, sr.game, sid, sr, st, r, sr.stake_c, fp); return { game: sr.game, payout: toCR(pay), label: r.label }; }); }
  function actSess(u, sid, gname, a, kind, demo) {
    a = a || {}; const g = GM.GAMES[gname]; if (!g || !g.start) throw err('unknown game');
    if (demo) { const s = demoSess.get(sid); if (!s || s.game !== gname) throw err('That round has ended'); const d = demoDraw(); s.ts = Date.now(); const main = s.st._m;
      const cost = g.cost ? toC(g.cost(s.st, a)) : 0, r = kind === 'cash' ? g.cash(d, s.st, main / 100) : g.act(d, s.st, a, main / 100); s.stake_c += cost;
      if (r.done) { demoSess.delete(sid); return { ...out(r, s.stake_c, null, payFor(r, s.st, main)), done: true }; } return { ok: true, done: false, view: r.view, stake: toCR(s.stake_c) }; }
    const sr = db.prepare('SELECT * FROM sess WHERE id=? AND user_id=? AND game=?').get(sid, u.id, gname); if (!sr) throw err('That round has ended');
    return tx(() => { const f = fairGet(u.id), st = JSON.parse(sr.st), d = mkDraw(f.ss, f.cs, sr.n, sr.c), fp = { n: sr.n, cs: f.cs, sh: sha(f.ss) };
      const cost = kind === 'act' && g.cost ? toC(g.cost(st, a)) : 0; if (cost) spend(u.id, cost); const stake_c = sr.stake_c + cost;
      const r = kind === 'cash' ? g.cash(d, st, st._m / 100) : g.act(d, st, a, st._m / 100);
      if (r.done) { const pay = finish(u, gname, sid, sr, st, r, stake_c, fp); return { ...out(r, stake_c, fp, pay, u.id), done: true }; }
      db.prepare('UPDATE sess SET st=?, c=?, stake_c=?, ts=? WHERE id=?').run(JSON.stringify(st), d.cursor(), stake_c, Date.now(), sid);
      return { ok: true, done: false, view: r.view, stake: toCR(stake_c), fair: fp, ...wout(u.id) }; });
  }

  // ---------- shop / pool ----------
  function buy(u, ids) { if (!Array.isArray(ids) || !ids.length || ids.length > 50) throw err('bad request'); let tot = 0; for (const i of ids) { if (!Number.isInteger(i) || !UPCAT[i]) throw err('unknown skin'); tot += toC(UPCAT[i].price); }
    return tx(() => { const w = W(u.id); if (tot > w.bal_c) throw err('Insufficient CR balance'); db.prepare('UPDATE users SET bal_c = bal_c - ? WHERE id=?').run(tot, u.id); ids.forEach(i => giveSkin(u.id, i)); return { ok: true, ...wout(u.id), inv: skinsOf(u.id) }; }); }
  const pickSkins = (uid, uids) => { if (!Array.isArray(uids) || !uids.length || uids.length > 200) throw err('Select skins first'); const rows = uids.map(x => db.prepare('SELECT uid, item, price_c FROM skins WHERE uid=? AND user_id=?').get(String(x), uid)); if (rows.some(r => !r) || new Set(uids).size !== uids.length) throw err('Those skins are no longer in your inventory'); return rows; };
  function sell(u, uids) { return tx(() => { const rows = pickSkins(u.id, uids), tot = rows.reduce((a, r) => a + r.price_c, 0); rows.forEach(r => db.prepare('DELETE FROM skins WHERE uid=?').run(r.uid)); db.prepare('UPDATE users SET bal_c = bal_c + ? WHERE id=?').run(tot, u.id); return { ok: true, sold: toCR(tot), ...wout(u.id), inv: skinsOf(u.id) }; }); }
  function load(u, uids) { return tx(() => { const rows = pickSkins(u.id, uids), tot = rows.reduce((a, r) => a + r.price_c, 0); rows.forEach(r => db.prepare('DELETE FROM skins WHERE uid=?').run(r.uid)); db.prepare('UPDATE users SET pool_c = pool_c + ? WHERE id=?').run(tot, u.id); return { ok: true, ...wout(u.id), inv: skinsOf(u.id) }; }); }
  function unload(u) { return tx(() => { let r = W(u.id).pool_c; const SRT = UPCAT.slice().sort((a, b) => a.price - b.price), all = r, out = []; while (r >= 5 && out.length < 60) { let it = null; for (let k = SRT.length - 1; k >= 0; k--) if (toC(SRT[k].price) <= r) { it = SRT[k]; break; } if (!it) break; out.push(it.id); r -= toC(it.price); }
    out.forEach(i => giveSkin(u.id, i)); db.prepare('UPDATE users SET pool_c = 0, bal_c = bal_c + ? WHERE id=?').run(r >= 1 ? r : 0, u.id); if (r > 0 && r < 1) db.prepare('UPDATE users SET pool_c = pool_c + ? WHERE id=?').run(r, u.id);
    return { ok: true, returned: out.length, ...wout(u.id), inv: skinsOf(u.id) }; }); }

  // ---------- upgrader ----------
  function upgrade(u, p, demo) { p = p || {}; const T = UPCAT[p.target]; if (!T) throw err('Pick a target skin');
    if (demo) { const S = Math.max(0.01, Math.min(10000, +p.stake || 10)); if (T.price <= S) throw err('Target must be worth more than your skins'); const r = GM.Upgrader.roll(demoDraw(), S, T.price); return { ok: true, ...r, stake: S, target: T.id }; }
    return tx(() => { const rows = pickSkins(u.id, p.uids), S_c = rows.reduce((a, r) => a + r.price_c, 0), S = S_c / 100; if (toC(T.price) <= S_c) throw err('Target must be worth more than your skins');
      const f = fairGet(u.id), n = f.n + 1, d = mkDraw(f.ss, f.cs, n, 0), r = GM.Upgrader.roll(d, S, T.price);
      rows.forEach(x => db.prepare('DELETE FROM skins WHERE uid=?').run(x.uid)); db.prepare('UPDATE users SET lock_c = MAX(0, lock_c - ?) WHERE id=?').run(S_c, u.id); db.prepare('UPDATE fair SET n=? WHERE user_id=?').run(n, u.id);
      let got = null; if (r.win) { const uid = giveSkin(u.id, T.id); got = { uid, id: T.id, price: T.price }; }
      const fp = pubFair(f, n); logRound(u, 'Upgrader', S_c, r.win ? toC(T.price) : 0, fp, r.win ? 'Upgraded' : 'Lost'); return { ok: true, ch: r.ch, u: r.u, win: r.win, stake: S, got, fair: fp, ...wout(u.id), inv: skinsOf(u.id) }; }); }

  // close every open round of a player (pays out like a cash-out) before things that need a clean slate
  const needNoOpen = u => { if (openCount(u.id) > 0) throw err('Finish your round in progress first.'); };   // rounds are never closed behind the player's back
  // ---------- janitor: close rounds left open ----------
  const OPEN_DAYS = +process.env.OPEN_ROUND_DAYS || 7;   // a round left open is kept this long, then cashed out for the player
  const sweep = uid => { const out = []; db.prepare('SELECT id FROM sess WHERE user_id=? AND ts < ?').all(uid, Date.now() - OPEN_DAYS * 86400000).forEach(x => { const r = settleOpen({ id: uid, name: (db.prepare('SELECT name FROM users WHERE id=?').get(uid) || {}).name }, x.id); if (r) out.push(r); }); return out; };

  // ---------- routes ----------
  const body = async req => { try { return JSON.parse(await readBody(req) || '{}'); } catch (e) { throw err('bad json'); } };
  const ip = req => (req.headers['x-forwarded-for'] || req.socket.remoteAddress || '').split(',')[0].trim();
  async function route(req, res, url) {
    const P = url.pathname, GET = req.method === 'GET', POST = req.method === 'POST';
    if (GET && P === '/feed') return send(res, 200, { rounds: db.prepare('SELECT id, name, game, stake_c, mult, payout_c, ts FROM rounds ORDER BY id DESC LIMIT 40').all().map(r => ({ id: r.id, name: r.name, game: r.game, stake: toCR(r.stake_c), mult: r.mult, payout: toCR(r.payout_c), ts: r.ts })) }), true;
    if (!(P === '/wallet' || P === '/rakeback/claim' || P === '/my/rounds' || P === '/fair' || P === '/fair/seed' || P === '/shop/buy' || P === '/shop/sell' || P === '/pool/load' || P === '/pool/unload' || P.startsWith('/g/') || P === '/upgrader' || P === '/demo/upgrader' || P === '/catalog')) return false;
    try {
      if (GET && P === '/catalog') return send(res, 200, { items: UPCAT.map(x => ({ id: x.id, price: x.price })), updated: PRICE.updated, live: PRICE.live }), true;
      const demo = P.startsWith('/g/demo/') || P === '/demo/upgrader';
      if (demo) { if (!allow('d:' + ip(req), 30, 80)) return send(res, 429, { error: 'slow down' }), true; }
      const u = demo ? null : authUser(req); if (!demo && !u) return send(res, 401, { error: 'sign in to play' }), true;
      if (u && !allow('u:' + u.id)) return send(res, 429, { error: 'slow down' }), true;
      if (GET && P === '/wallet') { const settled = sweep(u.id); return send(res, 200, { ok: true, ...wout(u.id), inv: skinsOf(u.id), fair: { hash: fairPub(u.id).hash, cs: fairGet(u.id).cs, n: fairGet(u.id).n }, open: db.prepare('SELECT game FROM sess WHERE user_id=?').all(u.id).map(x => x.game), rakeback: rbOf(u.id), stats: statsOf(u.id), settled }), true; }
      if (GET && P === '/my/rounds') { const rows = db.prepare('SELECT id, game, stake_c, mult, payout_c, n, cs, sh, label, ts FROM rounds WHERE user_id=? ORDER BY id DESC LIMIT 300').all(u.id);
        return send(res, 200, { rounds: rows.map(r => ({ id: 'r' + r.id, game: r.game, stake: toCR(r.stake_c), mult: r.mult, payout: toCR(r.payout_c), t: r.ts, label: r.label, fair: { n: r.n, cs: r.cs, sh: r.sh } })) }), true; }
      if (POST && P === '/rakeback/claim') return send(res, 200, tx(() => {
        const r = db.prepare('SELECT rb_acc FROM users WHERE id=?').get(u.id), c = Math.floor((r ? r.rb_acc : 0) + 1e-9);
        if (c < 1) throw err('No rakeback to claim yet.');
        db.prepare('UPDATE users SET bal_c = bal_c + ?, rb_acc = rb_acc - ?, rb_paid_c = rb_paid_c + ? WHERE id=?').run(c, c, c, u.id);
        db.prepare('INSERT INTO ledger (user_id,amount,reason,ref,created_at) VALUES (?,?,?,?,?)').run(u.id, toCR(c), 'rakeback', 'rb:' + u.id + ':' + Date.now(), Date.now());
        return { ok: true, claimed: toCR(c), ...wout(u.id), rakeback: rbOf(u.id) }; })), true;
      if (GET && P === '/fair') return send(res, 200, { ok: true, ...fairPub(u.id) }), true;
      if (POST && P === '/fair/seed') { const b = await body(req); needNoOpen(u);
        return send(res, 200, { ok: true, ...tx(() => { const f = fairGet(u.id), hist = JSON.parse(f.hist); hist.unshift({ ss: f.ss, sh: sha(f.ss), cs: f.cs, n: f.n, t: Date.now() }); const cs = typeof b.cs === 'string' && /^[\w-]{1,40}$/.test(b.cs) ? b.cs : rnd32(8);
          db.prepare('UPDATE fair SET ss=?, cs=?, n=0, hist=? WHERE user_id=?').run(rnd32(32), cs, JSON.stringify(hist.slice(0, 20)), u.id); return fairPub(u.id); }) }), true; }
      const b = POST ? await body(req) : {};
      if (POST && P === '/shop/buy') return send(res, 200, buy(u, b.ids)), true;
      if (POST && P === '/shop/sell') return send(res, 200, sell(u, b.uids)), true;
      if (POST && P === '/pool/load') return send(res, 200, load(u, b.uids)), true;
      if (POST && P === '/pool/unload') { needNoOpen(u); return send(res, 200, unload(u)), true; }
      if (POST && P === '/upgrader') return send(res, 200, upgrade(u, b, false)), true;
      if (POST && P === '/demo/upgrader') return send(res, 200, upgrade(null, b, true)), true;
      if (GET && P === '/g/resume') {   // the round this player left open in a game, so the page can carry on with it
        const gname = String(new URL(req.url, 'http://x').searchParams.get('game') || ''), g = GM.GAMES[gname], sr = db.prepare('SELECT * FROM sess WHERE user_id=? AND game=? ORDER BY ts DESC').get(u.id, gname);
        if (!g || !g.resume || !sr) return send(res, 200, { ok: true, none: true }), true;
        const st = JSON.parse(sr.st), rs = g.resume(st); return send(res, 200, { ok: true, sid: sr.id, stake: toCR(sr.stake_c), main: toCR(st._m || sr.stake_c), ...rs }), true; }
      let m;
      if (POST && (m = /^\/g\/(demo\/)?(play|auto|start|act|cash)$/.exec(P))) { const kind = m[2], gname = String(b.game || ''); if (gname === 'War' && kind !== 'act' && kind !== 'cash') return send(res, 400, { error: 'This game is not available' }), true;   // War is switched off
        if (kind === 'play') return send(res, 200, playOnce(u, gname, b.p, b.stake, demo, false)), true;
        if (kind === 'auto') return send(res, 200, playOnce(u, gname, b.p, b.stake, demo, true)), true;
        if (kind === 'start') return send(res, 200, startSess(u, gname, b.p, b.stake, demo)), true;
        return send(res, 200, actSess(u, String(b.sid || ''), gname, b.a, kind, demo)), true; }
      return send(res, 404, { error: 'not found' }), true;
    } catch (e) { if (e.user) return send(res, 400, { error: e.message }), true; console.error('play error', e); return send(res, 500, { error: 'server error' }), true; }
  }
  return { kit: { tx, W, wout, spend, earn, toC, toCR, MAXPAY_C }, route, wout, W, tx, fairGet, refreshPrices, priceStatus: () => ({ updated: PRICE.updated, live: PRICE.live, err: PRICE.err }), catalog: () => UPCAT.map(x => ({ id: x.id, name: x.name, base: x.base, price: x.price })) };
};
