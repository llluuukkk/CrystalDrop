'use strict';
// Poker: no-limit Texas Hold'em cash tables (6 seats) between real players.
// Money rules: chips come out of the player's playing balance (pool) when they sit down and go back when they leave.
// What is on a table is mirrored in the poker_seats table, so a restart or crash never destroys anyone's chips:
// on boot every seat is paid back what its player had when the last hand finished.
const crypto = require('crypto');
const { Table, err } = require('./poker_engine');

const STAKES = [{ id: 's1', name: '0.10 / 0.20', sb: 10, bb: 20 }, { id: 's2', name: '1 / 2', sb: 100, bb: 200 }, { id: 's3', name: '5 / 10', sb: 500, bb: 1000 }];   // cents
const MIN_BB = 40, MAX_BB = 100, SEATS = 6, MAX_TABLES = 12, IDLE_KICK_MS = 3 * 60000;

module.exports = function init({ db, send, readBody, authUser, cfg, PLAY }) {
  const E = process.env, ON = E.POKER !== 'off', RAKE = Math.min(0.1, Math.max(0, E.POKER_RAKE === undefined || E.POKER_RAKE === '' ? 0.05 : +E.POKER_RAKE)), CAP_BB = +E.POKER_RAKE_CAP_BB || 3;
  const { tx, W, toCR } = PLAY.kit;
  db.exec(`CREATE TABLE IF NOT EXISTS poker_seats (uid TEXT PRIMARY KEY, tbl TEXT NOT NULL, seat INTEGER NOT NULL, stack_c INTEGER NOT NULL, since INTEGER);
CREATE TABLE IF NOT EXISTS poker_hands (id INTEGER PRIMARY KEY AUTOINCREMENT, tbl TEXT, no INTEGER, pot_c INTEGER, rake_c INTEGER, players INTEGER, ts INTEGER);
CREATE TABLE IF NOT EXISTS poker_log (id INTEGER PRIMARY KEY AUTOINCREMENT, uid TEXT, kind TEXT, amount_c INTEGER, tbl TEXT, ts INTEGER);`);
  const plog = (uid, kind, c, tb) => db.prepare('INSERT INTO poker_log (uid,kind,amount_c,tbl,ts) VALUES (?,?,?,?,?)').run(uid, kind, c, tb, Date.now());
  const pay = (uid, c) => { if (c > 0) db.prepare('UPDATE users SET pool_c = pool_c + ? WHERE id=?').run(c, uid); };

  // after a restart no table survives: give every seat its chips back
  const boot = db.prepare('SELECT * FROM poker_seats').all();
  if (boot.length) tx(() => { boot.forEach(r => { pay(r.uid, r.stack_c); plog(r.uid, 'restart refund', r.stack_c, r.tbl); }); db.exec('DELETE FROM poker_seats'); });

  // ---------- tables ----------
  const tables = new Map(), ipOf = new Map(), idleSince = new Map();   // ipOf: uid -> ip hash while seated
  const mkTable = st => { const n = [...tables.values()].filter(t => t.stake === st.id).length + 1, id = st.id + '-' + n;
    const t = new Table({ sb: st.sb, bb: st.bb, seats: SEATS, rakePct: RAKE, rakeCap: st.bb * CAP_BB, gapMs: E.POKER_GAP_MS === undefined ? 4000 : +E.POKER_GAP_MS, turnMs: +E.POKER_TURN_MS || 25000 }); t.id = id; t.stake = st.id; t.wasLive = false; tables.set(id, t); return t; };
  const ensure = () => { STAKES.forEach(st => { const mine = [...tables.values()].filter(t => t.stake === st.id); if (!mine.length) mkTable(st); else if (mine.every(t => t.seats.filter(Boolean).length >= SEATS - 1) && mine.length < MAX_TABLES) mkTable(st); }); };
  ensure();
  const stakeOf = id => STAKES.find(s => s.id === id);
  const seatedAt = uid => db.prepare('SELECT * FROM poker_seats WHERE uid=?').get(uid);
  const count = t => t.seats.filter(Boolean).length;
  const buyRange = st => ({ min: st.bb * MIN_BB, max: st.bb * MAX_BB });

  const persist = t => { t.seats.forEach(s => { if (s) db.prepare('UPDATE poker_seats SET stack_c=? WHERE uid=?').run(s.stack, s.uid); }); };
  const afterHand = t => {                                                                     // a hand just finished: save stacks, record the rake, clear out idle or broke players
    persist(t); const l = t.last; if (l) db.prepare('INSERT INTO poker_hands (tbl,no,pot_c,rake_c,players,ts) VALUES (?,?,?,?,?,?)').run(t.id, l.no, l.pot, l.rake, Object.keys(t.startStacks || {}).length, Date.now());
  };
  const cashOut = (t, uid, why) => { const cash = t.leave(uid, Date.now()); tx(() => { pay(uid, cash); db.prepare('DELETE FROM poker_seats WHERE uid=?').run(uid); plog(uid, why || 'cash out', cash, t.id); }); ipOf.delete(uid); idleSince.delete(uid); ensure(); return cash; };

  const step = () => {                                                                         // runs twice a second
    const now = Date.now();
    tables.forEach(t => {
      try {
        const was = t.live; t.tick(now);
        if (was && !t.live) afterHand(t);
        if (!t.live) t.seats.forEach(s => {                                                    // between hands: remove players who left the game
          if (!s) return; const k = s.uid; if (s.sitOut || s.stack <= 0) { if (!idleSince.has(k)) idleSince.set(k, now); if (now - idleSince.get(k) > IDLE_KICK_MS) cashOut(t, k, 'idle cash out'); } else idleSince.delete(k); });
      } catch (e) { console.error('poker tick', t.id, e); }
    });
  };
  const timer = setInterval(step, 500); if (timer.unref) timer.unref();

  // ---------- actions ----------
  const sit = (u, ip, b) => {
    const t = tables.get(String(b.table || '')); if (!t) throw err('That table does not exist.'); const st = stakeOf(t.stake), r = buyRange(st), buy = Math.round(+b.buyin * 100), seat = Math.floor(+b.seat);
    if (!(buy >= r.min && buy <= r.max)) throw err('Buy in between ' + toCR(r.min) + ' and ' + toCR(r.max) + ' CR.');
    if (seatedAt(u.id)) throw err('You are already seated at a poker table. Leave it first.');
    const h = crypto.createHash('sha256').update(String(ip)).digest('hex').slice(0, 16); if (t.seats.some(s => s && ipOf.get(s.uid) === h)) throw err('Another player on your connection is already at this table.');
    tx(() => { const w = W(u.id); if (w.lock_c > 0) throw err('CR you bought has to be played through once before you can use it at a poker table. Play a few other games first.');
      if (w.pool_c < buy) throw err('You need ' + toCR(buy) + ' CR in play. Load skins or CR into play first.');
      db.prepare('UPDATE users SET pool_c = pool_c - ? WHERE id=?').run(buy, u.id);
      db.prepare('INSERT INTO poker_seats (uid,tbl,seat,stack_c,since) VALUES (?,?,?,?,?)').run(u.id, t.id, seat, buy, Date.now()); plog(u.id, 'buy in', buy, t.id); t.sit(seat, u.id, u.name || 'Player', buy); });
    ipOf.set(u.id, h); ensure(); step(); return { ok: true, table: t.id };
  };
  const mine = u => { const r = seatedAt(u.id); if (!r) throw err('You are not seated at a poker table.'); const t = tables.get(r.tbl); if (!t) throw err('That table is closed.'); return t; };
  const topUp = (u, b) => { const t = mine(u), st = stakeOf(t.stake), r = buyRange(st), add = Math.round(+b.amount * 100), s = t.seats[t.idx(u.id)];
    if (!(add > 0)) throw err('Enter an amount.'); if (s.stack + add > r.max) throw err('The most you can have at this table is ' + toCR(r.max) + ' CR.');
    tx(() => { const w = W(u.id); if (w.lock_c > 0) throw err('CR you bought has to be played through once first.'); if (w.pool_c < add) throw err('Not enough CR in play.'); t.topUp(u.id, add); db.prepare('UPDATE users SET pool_c = pool_c - ? WHERE id=?').run(add, u.id); db.prepare('UPDATE poker_seats SET stack_c = stack_c + ? WHERE uid=?').run(add, u.id); plog(u.id, 'top up', add, t.id); });
    return { ok: true }; };
  const act = (u, b) => { const t = mine(u); const was = t.live; t.act(u.id, String(b.a || ''), Math.round(+b.amt * 100) || 0, Date.now()); if (was && !t.live) afterHand(t); return { ok: true }; };

  // ---------- views ----------
  const wal = u => { const w = W(u.id); return { pool: w.pool_c, lock: w.lock_c, bal: w.bal_c }; };
  const lobby = u => { const me = seatedAt(u.id); return { ok: true, on: ON, me: me ? { table: me.tbl, seat: me.seat } : null, wallet: wal(u), minBb: MIN_BB, maxBb: MAX_BB,
    stakes: STAKES.map(st => ({ id: st.id, name: st.name, sb: st.sb, bb: st.bb, ...buyRange(st), tables: [...tables.values()].filter(t => t.stake === st.id).map(t => ({ id: t.id, seated: count(t), seats: SEATS, playing: t.live, names: t.seats.filter(Boolean).map(s => s.name) })) })) }; };
  const state = (u, id, ver) => { const t = tables.get(id); if (!t) throw err('That table is closed.'); const me = t.idx(u.id) >= 0;
    if (+ver === t.ver && !(t.live && Date.now() >= t.deadline - 1000)) return { ok: true, same: true, now: Date.now(), wallet: wal(u) };
    const v = t.view(u.id, Date.now()); return { ok: true, table: { id: t.id, stake: t.stake, name: stakeOf(t.stake).name, ...buyRange(stakeOf(t.stake)) }, ...v, seated: me, wallet: wal(u) }; };

  const buckets = new Map(), RATE = +E.POKER_RATE || 8, BURST = RATE * 5; const allow = k => { const now = Date.now(); let b = buckets.get(k); if (!b) { b = { t: now, v: BURST }; buckets.set(k, b); } b.v = Math.min(BURST, b.v + (now - b.t) / 1000 * RATE); b.t = now; if (b.v < 1) return false; b.v--; return true; };
  const ip = req => (req.headers['x-forwarded-for'] || req.socket.remoteAddress || '').split(',')[0].trim();

  async function route(req, res, url) {
    const P = url.pathname; if (!P.startsWith('/poker/')) return false;
    try {
      if (!ON) return send(res, 200, { ok: true, on: false, stakes: [] }), true;
      const u = authUser(req); if (!u) return send(res, 401, { error: 'sign in to play poker' }), true; if (!allow('p:' + u.id)) return send(res, 429, { error: 'slow down' }), true;
      const GET = req.method === 'GET', POST = req.method === 'POST';
      if (GET && P === '/poker/lobby') return send(res, 200, lobby(u)), true;
      if (GET && P === '/poker/state') return send(res, 200, state(u, String(url.searchParams.get('table') || ''), url.searchParams.get('ver'))), true;
      if (!POST) return send(res, 405, { error: 'POST only' }), true;
      let b; try { b = JSON.parse(await readBody(req) || '{}'); } catch (e) { return send(res, 400, { error: 'bad json' }), true; }
      if (P === '/poker/sit') return send(res, 200, sit(u, ip(req), b)), true;
      if (P === '/poker/act') return send(res, 200, act(u, b)), true;
      if (P === '/poker/topup') return send(res, 200, topUp(u, b)), true;
      if (P === '/poker/sitout') { const t = mine(u); t.setSitOut(u.id, !!b.v); if (!b.v) idleSince.delete(u.id); return send(res, 200, { ok: true }), true; }
      if (P === '/poker/leave') { const t = mine(u); const cash = cashOut(t, u.id, 'cash out'); return send(res, 200, { ok: true, cash, wallet: wal(u) }), true; }
      return send(res, 404, { error: 'not found' }), true;
    } catch (e) { if (e.user) { send(res, 400, { error: e.message }); return true; } console.error('poker error', e); send(res, 500, { error: 'server error' }); return true; }
  }

  const admin = { overview() { const rows = db.prepare('SELECT COUNT(*) n, COALESCE(SUM(rake_c),0) r, COALESCE(SUM(pot_c),0) p FROM poker_hands').get(), day = db.prepare('SELECT COALESCE(SUM(rake_c),0) r, COUNT(*) n FROM poker_hands WHERE ts > ?').get(Date.now() - 864e5);
    return { on: ON, rakePct: RAKE, hands: rows.n, rake: toCR(rows.r), potTotal: toCR(rows.p), rake24h: toCR(day.r), hands24h: day.n,
      tables: [...tables.values()].map(t => ({ id: t.id, stake: stakeOf(t.stake).name, seated: count(t), live: t.live, hand: t.handNo, players: t.seats.filter(Boolean).map(s => ({ name: s.name, uid: s.uid, stack: toCR(s.stack), sitOut: s.sitOut })) })) }; } };
  const shutdown = () => clearInterval(timer);
  return { route, admin, shutdown, step, tables, STAKES };
};
