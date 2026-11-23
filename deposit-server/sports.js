'use strict';
// Sportsbook (soccer + CS2). Pre-match betting only. Odds, scores and results come from odds-api.io when ODDS_API_KEY is set;
// without a key a clearly labelled demo feed runs, and only while payments are also in mock mode.
const crypto = require('crypto');

module.exports = function init({ db, send, readBody, authUser, cfg, PLAY }) {
  const E = process.env, KEY = E.ODDS_API_KEY || '', BOOK = E.SPORTS_BOOK || 'Bet365', BOOK_CS = E.SPORTS_BOOK_CS || 'Thunderpick,GG.bet,Bet365', API = 'https://api.odds-api.io/v3';
  const CUT = Math.min(0.3, Math.max(0, +(E.SPORTS_CUT || 0.04)));            // we shave this share off every price above 1.00
  const MIN_STAKE_C = 50, MAX_STAKE_C = 200000, MAX_LEGS = 8, CLOSE_MS = 60000, STALE_MS = (E.ODDS_PROVIDER === 'odds-api.io' ? 25 : Math.max(25, (+(E.SPORTS_SYNC_MIN || 360)) * 2)) * 60000, EXPOSURE_C = Math.round(+(E.SPORTS_EXPOSURE || 20000) * 100);
  const LIVE_BETS = E.SPORTS_LIVE === 'on';
  const MAX_ODDS = Math.max(2, +(E.SPORTS_MAX_ODDS || 2700));                    // highest combined odds a single bet may have
  const PROV = E.ODDS_PROVIDER === 'odds-api.io' ? 'oa' : 'toa';                   // default: The Odds API (the-odds-api.com); set ODDS_PROVIDER=odds-api.io for the other service
  const mode = KEY ? 'live' : (cfg.provider === 'mock' || E.SPORTS_MOCK === 'on') ? 'demo' : 'off';
  const { tx, W, wout, spend, earn, toC, toCR, MAXPAY_C } = PLAY.kit;

  db.exec(`CREATE TABLE IF NOT EXISTS sp_events (id TEXT PRIMARY KEY, sport TEXT NOT NULL, league TEXT, home TEXT, away TEXT, start INTEGER NOT NULL, status TEXT NOT NULL, hs INTEGER, aws INTEGER, odds TEXT, updated INTEGER, manual INTEGER NOT NULL DEFAULT 0);
CREATE INDEX IF NOT EXISTS sp_ev_s ON sp_events(sport, start);
CREATE TABLE IF NOT EXISTS sp_bets (id INTEGER PRIMARY KEY AUTOINCREMENT, user_id TEXT NOT NULL, kind TEXT NOT NULL, stake_c INTEGER NOT NULL, odds REAL NOT NULL, pot_c INTEGER NOT NULL, status TEXT NOT NULL DEFAULT 'open', payout_c INTEGER NOT NULL DEFAULT 0, ts INTEGER, settled INTEGER);
CREATE INDEX IF NOT EXISTS sp_b_u ON sp_bets(user_id, id);
CREATE TABLE IF NOT EXISTS sp_legs (id INTEGER PRIMARY KEY AUTOINCREMENT, bet_id INTEGER NOT NULL, event_id TEXT NOT NULL, sel TEXT NOT NULL, odds REAL NOT NULL, result TEXT NOT NULL DEFAULT 'open');
CREATE INDEX IF NOT EXISTS sp_l_b ON sp_legs(bet_id); CREATE INDEX IF NOT EXISTS sp_l_e ON sp_legs(event_id);`);

  const STATE = { mode, provider: PROV, credits: null, last: 0, err: '', events: 0, settledAt: 0, books: null };
  const shave = o => { o = +o; return o > 1.02 ? Math.max(1.01, +(1 + (o - 1) * (1 - CUT)).toFixed(2)) : 0; };

  // ---------- markets ----------
  // stored odds: { ML:{home,draw,away}, T:{ '2.5':{over,under} }, BTTS:{yes,no} }  selection keys: ML:home  T:2.5:over  BTTS:yes
  const priceOf = (odds, sel) => { const p = String(sel).split(':'); let v;
    if (p[0] === 'ML' && p.length === 2) v = odds.ML && odds.ML[p[1]]; else if (p[0] === 'T' && p.length === 3) v = odds.T && odds.T[p[1]] && odds.T[p[1]][p[2]]; else if (p[0] === 'BTTS' && p.length === 2) v = odds.BTTS && odds.BTTS[p[1]];
    return +v > 1 ? +v : 0; };
  const legResult = (sel, hs, as) => { const p = sel.split(':'), tot = hs + as;
    if (p[0] === 'ML') return (p[1] === 'home' ? hs > as : p[1] === 'away' ? as > hs : hs === as) ? 'won' : 'lost';
    if (p[0] === 'T') { const L = +p[1]; if (tot === L) return 'void'; return (p[2] === 'over' ? tot > L : tot < L) ? 'won' : 'lost'; }
    if (p[0] === 'BTTS') return ((hs > 0 && as > 0) === (p[1] === 'yes')) ? 'won' : 'lost';
    return 'void'; };
  const selName = (e, sel) => { const p = sel.split(':'); if (p[0] === 'ML') return p[1] === 'home' ? e.home : p[1] === 'away' ? e.away : 'Draw';
    if (p[0] === 'T') return (p[2] === 'over' ? 'Over ' : 'Under ') + p[1] + ' goals'; if (p[0] === 'BTTS') return 'Both teams to score: ' + (p[1] === 'yes' ? 'Yes' : 'No'); return sel; };

  // ---------- storing events ----------
  const upsert = db.prepare(`INSERT INTO sp_events (id,sport,league,home,away,start,status,hs,aws,odds,updated) VALUES (?,?,?,?,?,?,?,?,?,?,?)
    ON CONFLICT(id) DO UPDATE SET league=excluded.league, home=excluded.home, away=excluded.away, start=excluded.start,
      status=CASE WHEN sp_events.manual=1 THEN sp_events.status ELSE excluded.status END, hs=CASE WHEN sp_events.manual=1 THEN sp_events.hs ELSE excluded.hs END, aws=CASE WHEN sp_events.manual=1 THEN sp_events.aws ELSE excluded.aws END,
      odds=COALESCE(excluded.odds, sp_events.odds), updated=CASE WHEN excluded.odds IS NULL THEN sp_events.updated ELSE excluded.updated END`);
  const save = e => upsert.run(e.id, e.sport, e.league || '', e.home, e.away, e.start, e.status, e.hs == null ? null : e.hs, e.as == null ? null : e.as, e.odds ? JSON.stringify(e.odds) : null, e.odds ? Date.now() : null);

  // ---------- odds-api.io ----------
  async function api(path, q) { const u = new URL(API + path); for (const k in q) if (q[k] != null) u.searchParams.set(k, q[k]); u.searchParams.set('apiKey', KEY);
    const ac = new AbortController(), t = setTimeout(() => ac.abort(), 20000); try { const r = await fetch(u, { signal: ac.signal, headers: { 'User-Agent': 'CrystalDrop/1.0' } }); if (!r.ok) throw new Error('odds-api HTTP ' + r.status); return await r.json(); } finally { clearTimeout(t); } }
  const arr = j => Array.isArray(j) ? j : Array.isArray(j && j.events) ? j.events : Array.isArray(j && j.data) ? j.data : [];
  const isCS = ev => /counter|cs2|csgo|cs:go/i.test([ev.game && ev.game.slug, ev.game && ev.game.name, ev.league && ev.league.name, ev.league && ev.league.slug].join(' '));
  const scoreOf = ev => { const s = ev.scores || {}, ft = s.periods && s.periods.ft; const h = ft && ft.home != null ? ft.home : s.home, a = ft && ft.away != null ? ft.away : s.away; return { hs: Number.isFinite(+h) && h != null ? +h : null, as: Number.isFinite(+a) && a != null ? +a : null }; };
  const mapStatus = s => s === 'settled' ? 'settled' : s === 'cancelled' ? 'cancelled' : s === 'live' ? 'live' : 'pending';
  function parseOdds(book, sport) { const out = {}; for (const m of book || []) { const nm = String(m.name || ''), rows = Array.isArray(m.odds) ? m.odds : [];
      if (/^(ml|match result|1x2)$/i.test(nm) && rows[0]) { const o = rows[0]; const ml = {}; if (shave(o.home)) ml.home = shave(o.home); if (shave(o.away)) ml.away = shave(o.away); if (sport === 'football' && shave(o.draw)) ml.draw = shave(o.draw);
        if (ml.home && ml.away && (sport !== 'football' || ml.draw)) out.ML = ml; }
      else if (sport === 'football' && /^totals?$/i.test(nm)) { out.T = out.T || {}; for (const o of rows) { const L = +o.hdp; if (!(L > 0) || (L * 2) % 1 !== 0) continue; if (shave(o.over) && shave(o.under)) out.T[String(L)] = { over: shave(o.over), under: shave(o.under) }; } if (!Object.keys(out.T).length) delete out.T; }
      else if (sport === 'football' && /both teams to score/i.test(nm) && rows[0]) { const o = rows[0]; if (shave(o.yes) && shave(o.no)) out.BTTS = { yes: shave(o.yes), no: shave(o.no) }; } }
    return out; }
  async function syncLive() {
    const from = new Date(Date.now() - 3 * 3600e3).toISOString(), to = new Date(Date.now() + 3 * 864e5).toISOString(), evs = [];
    for (const [sport, slug, cap] of [['football', 'football', 150], ['cs2', 'esports', 80]]) {
      const list = arr(await api('/events', { sport: slug, status: 'pending,live', from, to, limit: 1000 })).filter(ev => sport === 'cs2' ? isCS(ev) : true).sort((a, b) => new Date(a.date) - new Date(b.date)).slice(0, cap);
      for (const ev of list) { const sc = scoreOf(ev); evs.push({ id: 'oa:' + ev.id, raw: ev.id, sport, league: ev.league && ev.league.name, home: ev.home, away: ev.away, start: new Date(ev.date).getTime(), status: mapStatus(ev.status), hs: sc.hs, as: sc.as }); } }
    // bookmakers: prefer the lists below, but only ones that are selected on the account; if none match, use whatever the account has selected
    let sel = []; try { const r = await api('/bookmakers/selected', {}); sel = (Array.isArray(r) ? r : arr(r && (r.bookmakers || r.selected))).map(x => typeof x === 'string' ? x : x && x.name).filter(Boolean); } catch (e) {}
    const pick = pref => { const want = String(pref).split(',').map(x => x.trim()).filter(Boolean), have = sel.length ? want.filter(w => sel.some(x => x.toLowerCase() === w.toLowerCase())) : want; return (have.length ? have : sel.length ? sel : want).slice(0, 30); };
    STATE.books = { football: pick(BOOK), cs2: pick(BOOK_CS) };
    for (const sport of ['football', 'cs2']) { const mine = evs.filter(e => e.sport === sport), books = STATE.books[sport];
      for (let i = 0; i < mine.length; i += 10) { const chunk = mine.slice(i, i + 10); let got = [];
        try { got = arr(await api('/odds/multi', { eventIds: chunk.map(e => e.raw).join(','), bookmakers: books.join(',') })); } catch (e) { STATE.err = String(e.message).slice(0, 120); }
        const by = new Map(got.map(o => [String(o.id), o]));
        for (const e of chunk) { const o = by.get(String(e.raw)); let odds = null;
          if (o && o.bookmakers) for (const b of books.concat(Object.keys(o.bookmakers))) { const bk = o.bookmakers[b]; if (!bk) continue; const p = parseOdds(bk, e.sport); if (p.ML) { odds = p; break; } }
          e.odds = odds; } } }
    db.exec('BEGIN'); try { for (const e of evs) save(e); db.exec('COMMIT'); } catch (e) { try { db.exec('ROLLBACK'); } catch (x) {} throw e; }
    STATE.events = evs.length; }


  // ---------- The Odds API (the-odds-api.com, v4): football only, 1X2 + totals. Free plan = 500 credits/month, so refreshes are infrequent and configurable ----------
  const TOA = 'https://api.the-odds-api.com/v4', MARKETS = E.SPORTS_MARKETS || 'h2h,totals', REGION = E.SPORTS_REGION || 'eu', SYNC_MIN = Math.max(10, +(E.SPORTS_SYNC_MIN || 360)), SCORES_MIN = Math.max(10, +(E.SPORTS_SCORES_MIN || 180));
  const LEAGUES = (E.SPORTS_LEAGUES || 'soccer_epl,soccer_spain_la_liga,soccer_uefa_champs_league').split(',').map(x => x.trim()).filter(Boolean);
  const PREF = (E.SPORTS_BOOKS_TOA || 'pinnacle,williamhill,unibet_eu,betsson,marathonbet').split(',').map(x => x.trim());
  async function toa(path, q) { const u = new URL(TOA + path); for (const k in q) if (q[k] != null) u.searchParams.set(k, q[k]); u.searchParams.set('apiKey', KEY);
    const ac = new AbortController(), t = setTimeout(() => ac.abort(), 20000);
    try { const r = await fetch(u, { signal: ac.signal, headers: { 'User-Agent': 'CrystalDrop/1.0' } }); const rem = r.headers && r.headers.get && r.headers.get('x-requests-remaining'); if (rem != null) STATE.credits = +rem;
      if (!r.ok) throw new Error('the-odds-api HTTP ' + r.status); return await r.json(); } finally { clearTimeout(t); } }
  function parseToa(ev) { const out = {}, books = ev.bookmakers || [], ord = PREF.map(k => books.find(b => b.key === k)).filter(Boolean).concat(books);
    for (const b of ord) { for (const m of b.markets || []) {
        if (m.key === 'h2h' && !out.ML) { const o = {}; for (const x of m.outcomes || []) { if (x.name === ev.home_team) o.home = shave(x.price); else if (x.name === ev.away_team) o.away = shave(x.price); else if (/draw/i.test(x.name)) o.draw = shave(x.price); } if (o.home && o.away && o.draw) out.ML = o; }
        else if (m.key === 'totals') { const by = {}; for (const x of m.outcomes || []) { const L = +x.point; if (!(L > 0) || (L * 2) % 1 !== 0) continue; by[L] = by[L] || {}; by[L][/over/i.test(x.name) ? 'over' : 'under'] = shave(x.price); }
          out.T = out.T || {}; for (const L in by) if (by[L].over && by[L].under && !out.T[L]) out.T[L] = by[L]; } }
      if (out.ML) break; }
    if (out.T && !Object.keys(out.T).length) delete out.T; return out.ML ? out : null; }
  async function syncToa() { const evs = [], now = Date.now(); let bad = '';
    for (const lg of LEAGUES) { let j; try { j = await toa('/sports/' + lg + '/odds', { regions: REGION, markets: MARKETS, oddsFormat: 'decimal', dateFormat: 'unix' }); } catch (e) { bad = String(e.message).slice(0, 120); continue; }
      for (const ev of Array.isArray(j) ? j : []) { const start = +ev.commence_time * 1000; if (!(start > now) || start > now + 5 * 864e5) continue;
        evs.push({ id: 'ta:' + lg + ':' + ev.id, sport: 'football', league: ev.sport_title || lg, home: ev.home_team, away: ev.away_team, start, status: 'pending', odds: parseToa(ev) }); } }
    if (bad && !evs.length) throw new Error(bad);
    db.exec('BEGIN'); try { for (const e of evs) save(e); db.exec("UPDATE sp_events SET status='live' WHERE id LIKE 'ta:%' AND status='pending' AND start < " + now); db.exec('COMMIT'); } catch (e) { try { db.exec('ROLLBACK'); } catch (x) {} throw e; }
    STATE.events = evs.length; if (bad) STATE.err = bad; }
  const SC = new Map();      // league -> { at, list }   (a scores call costs 2 credits, so it is cached)
  async function toaScoreOf(e) { const [, lg, id] = e.id.split(':'); let c = SC.get(lg);
    if (!c || Date.now() - c.at > SCORES_MIN * 60000) { c = { at: Date.now(), list: await toa('/sports/' + lg + '/scores', { daysFrom: 3, dateFormat: 'unix' }) }; SC.set(lg, c); }
    const ev = (Array.isArray(c.list) ? c.list : []).find(x => x.id === id); if (!ev || !ev.completed || !Array.isArray(ev.scores)) return { status: 'open' };
    const h = ev.scores.find(x => x.name === ev.home_team), a = ev.scores.find(x => x.name === ev.away_team); if (!h || !a || !Number.isFinite(+h.score) || !Number.isFinite(+a.score)) return { status: 'open' };
    return { hs: +h.score, as: +a.score, status: 'settled' }; }

  // ---------- demo feed (clearly fake teams, results from a seeded generator) ----------
  const DEMO_FB = [['Northgate', 78], ['Harbor Town', 70], ['Redstone', 66], ['Valley Rovers', 62], ['Ironbridge', 60], ['Lakeside', 57], ['Highfield', 55], ['Marlow Athletic', 52], ['Stonebury', 50], ['Crown City', 48], ['Eastvale', 45], ['Westmoor', 42]];
  const DEMO_CS = [['Nova Five', 80], ['Static Wolves', 74], ['Iron Pact', 68], ['Cold Signal', 64], ['Red Harbor', 58], ['Pixel Lords', 52]];
  const seeded = s => { let h = crypto.createHash('sha256').update(String(s)).digest(); let i = 0; return () => { if (i > 28) { h = crypto.createHash('sha256').update(h).digest(); i = 0; } const v = (h[i] * 16777216 + h[i + 1] * 65536 + h[i + 2] * 256 + h[i + 3]) / 4294967296; i += 4; return v; }; };
  const pois = (r, l) => { let k = 0, p = 1, L = Math.exp(-l); do { k++; p *= r(); } while (p > L); return k - 1; };
  function syncDemo() { const now = Date.now(), day = Math.floor(now / 864e5), evs = [];
    for (let d = -1; d <= 3; d++) for (let n = 0; n < 12; n++) { const r = seeded('fb' + (day + d) + ':' + n), a = Math.floor(r() * DEMO_FB.length); let b = Math.floor(r() * DEMO_FB.length); if (b === a) b = (b + 1) % DEMO_FB.length;
      const start = (day + d) * 864e5 + (11 + n) * 36e5 + Math.floor(r() * 4) * 9e5, H = DEMO_FB[a], A = DEMO_FB[b];
      const lh = 0.9 + (H[1] - A[1]) / 80 + 0.25, la = 0.9 - (H[1] - A[1]) / 80, rr = seeded('res' + start + n), fh = pois(rr, Math.max(.3, lh)), fa = pois(rr, Math.max(.3, la));
      evs.push({ id: 'demo:fb:' + start + ':' + n, sport: 'football', league: n % 2 ? 'Demo League One' : 'Demo Premier Division', home: H[0] + ' FC', away: A[0] + ' United', start, ...demoState(now, start, 110 * 6e4, fh, fa), odds: demoOdds(lh, la) }); }
    for (let d = -1; d <= 3; d++) for (let n = 0; n < 4; n++) { const r = seeded('cs' + (day + d) + ':' + n), a = Math.floor(r() * DEMO_CS.length); let b = Math.floor(r() * DEMO_CS.length); if (b === a) b = (b + 1) % DEMO_CS.length;
      const start = (day + d) * 864e5 + (13 + n * 2) * 36e5, H = DEMO_CS[a], A = DEMO_CS[b], p = 1 / (1 + Math.pow(10, (A[1] - H[1]) / 40)), rr = seeded('csres' + start + n); let mh = 0, ma = 0; while (mh < 2 && ma < 2) { if (rr() < p) mh++; else ma++; }
      const o = { ML: { home: shave(1 / (p * 1.06)) || 1.01, away: shave(1 / ((1 - p) * 1.06)) || 1.01 } };
      evs.push({ id: 'demo:cs:' + start + ':' + n, sport: 'cs2', league: 'Demo Major Qualifier', home: H[0], away: A[0], start, ...demoState(now, start, 100 * 6e4, mh, ma), odds: o }); }
    db.exec('BEGIN'); try { for (const e of evs) save(e); db.exec('COMMIT'); } catch (e) { try { db.exec('ROLLBACK'); } catch (x) {} throw e; } STATE.events = evs.length; }
  const demoState = (now, start, len, fh, fa) => now < start ? { status: 'pending', hs: null, as: null } : now < start + len ? { status: 'live', hs: Math.floor(fh * (now - start) / len), as: Math.floor(fa * (now - start) / len) } : { status: 'settled', hs: fh, as: fa };
  function demoOdds(lh, la) { let ph = 0, pd = 0, pa = 0, pb = 0; const P = (k, l) => Math.exp(-l) * Math.pow(l, k) / [1, 1, 2, 6, 24, 120, 720, 5040, 40320, 362880, 3628800][k], T = {};
    for (let i = 0; i <= 10; i++) for (let j = 0; j <= 10; j++) { const p = P(i, lh) * P(j, la); if (i > j) ph += p; else if (i === j) pd += p; else pa += p; if (i > 0 && j > 0) pb += p; }
    const mg = 1.06, o = { ML: { home: shave(1 / (ph * mg)), draw: shave(1 / (pd * mg)), away: shave(1 / (pa * mg)) }, BTTS: { yes: shave(1 / (pb * mg)), no: shave(1 / ((1 - pb) * mg)) }, T: {} };
    for (const L of [1.5, 2.5, 3.5]) { let po = 0; for (let i = 0; i <= 10; i++) for (let j = 0; j <= 10; j++) if (i + j > L) po += P(i, lh) * P(j, la); o.T[String(L)] = { over: shave(1 / (po * mg)), under: shave(1 / ((1 - po) * mg)) }; }
    return o; }

  // ---------- results ----------
  const finalScore = async e => { if (e.id.startsWith('ta:')) return toaScoreOf(e); if (e.id.startsWith('demo:')) return e.status === 'settled' ? { hs: e.hs, as: e.aws, status: 'settled' } : { status: e.status === 'cancelled' ? 'cancelled' : 'open' };
    const j = await api('/events/' + encodeURIComponent(e.id.slice(3)), {}), ev = Array.isArray(j) ? j[0] : j, sc = scoreOf(ev || {}), st = mapStatus(ev && ev.status);
    return st === 'settled' && sc.hs != null && sc.as != null ? { hs: sc.hs, as: sc.as, status: 'settled' } : { status: st === 'cancelled' ? 'cancelled' : 'open' }; };

  function settleBet(betId) { const b = db.prepare('SELECT * FROM sp_bets WHERE id=?').get(betId); if (!b || b.status !== 'open') return;
    const legs = db.prepare('SELECT * FROM sp_legs WHERE bet_id=?').all(betId); let status = null, pay = 0;
    if (legs.some(l => l.result === 'lost')) { status = 'lost'; }
    else if (legs.every(l => l.result !== 'open')) { const live = legs.filter(l => l.result === 'won'); if (!live.length) { status = 'void'; pay = b.stake_c; } else { status = 'won'; pay = Math.min(MAXPAY_C, Math.round(b.stake_c * live.reduce((a, l) => a * l.odds, 1) + 1e-9)); } }
    if (!status) return; db.prepare('UPDATE sp_bets SET status=?, payout_c=?, settled=? WHERE id=?').run(status, pay, Date.now(), betId); if (pay) earn(b.user_id, pay);
    if (status !== 'void') { const u = db.prepare('SELECT name FROM users WHERE id=?').get(b.user_id); try { db.prepare('INSERT INTO rounds (user_id,name,game,stake_c,payout_c,mult,n,cs,sh,label,ts) VALUES (?,?,?,?,?,?,?,?,?,?,?)').run(b.user_id, (u && u.name) || '', 'Sports', b.stake_c, pay, b.stake_c ? Math.round(pay / b.stake_c * 100) / 100 : 0, 0, '', '', status === 'won' ? 'Upgrade won' : 'Upgrade lost', Date.now()); } catch (e) {} } }
  const resolveRaw = (id, status, hs, as) => { const e = db.prepare('SELECT id FROM sp_events WHERE id=?').get(id); if (!e) throw Object.assign(new Error('no such match'), { code: 404 });
    const legs = db.prepare("SELECT * FROM sp_legs WHERE event_id=? AND result='open'").all(id), bets = new Set();
    for (const l of legs) { const r = status === 'settled' ? legResult(l.sel, hs, as) : 'void'; db.prepare('UPDATE sp_legs SET result=? WHERE id=?').run(r, l.id); bets.add(l.bet_id); }
    for (const b of bets) settleBet(b); return { legs: legs.length, bets: bets.size }; };
  const resolveEvent = (id, status, hs, as) => tx(() => resolveRaw(id, status, hs, as));

  async function settleDue() { const now = Date.now(), due = db.prepare("SELECT DISTINCT e.* FROM sp_events e JOIN sp_legs l ON l.event_id = e.id WHERE l.result='open' AND e.start < ?").all(now - 5 * 6e4);
    for (const e of due) { try { const r = await finalScore(e); if (r.status === 'settled') { db.prepare("UPDATE sp_events SET status='settled', hs=?, aws=? WHERE id=?").run(r.hs, r.as, e.id); resolveEvent(e.id, 'settled', r.hs, r.as); }
        else if (r.status === 'cancelled') { db.prepare("UPDATE sp_events SET status='cancelled' WHERE id=?").run(e.id); resolveEvent(e.id, 'cancelled'); }
        else if (now - e.start > 3 * 864e5) { resolveEvent(e.id, 'cancelled'); db.prepare("UPDATE sp_events SET status='cancelled' WHERE id=?").run(e.id); } } catch (x) { STATE.err = String(x.message || x).slice(0, 120); } }
    STATE.settledAt = Date.now(); }
  async function sync() { if (mode === 'off') return; try { if (mode === 'live') await (PROV === 'toa' ? syncToa() : syncLive()); else syncDemo(); STATE.last = Date.now(); STATE.err = ''; } catch (e) { STATE.err = String(e.message || e).slice(0, 120); console.warn('sports sync:', STATE.err); } await settleDue(); }
  if (mode !== 'off' && E.SPORTS_SYNC !== 'off') { setTimeout(sync, 3000).unref(); setInterval(sync, mode === 'live' ? (PROV === 'toa' ? SYNC_MIN : 10) * 60000 : 60000).unref(); if (mode === 'live' && PROV === 'toa') setInterval(() => settleDue().catch(() => {}), 15 * 60000).unref(); }
  db.prepare("DELETE FROM sp_events WHERE start < ? AND id NOT IN (SELECT event_id FROM sp_legs)").run(Date.now() - 3 * 864e5);
  if (mode !== 'demo') db.prepare("DELETE FROM sp_events WHERE id LIKE 'demo:%' AND id NOT IN (SELECT event_id FROM sp_legs)").run();      // fake demo fixtures never show next to real matches

  // ---------- public views ----------
  const pubEv = e => ({ id: e.id, sport: e.sport, league: e.league, home: e.home, away: e.away, start: e.start, status: e.status, hs: e.hs, as: e.aws, odds: e.odds ? JSON.parse(e.odds) : null, bettable: canBet(e) });
  const canBet = e => e.status === 'pending' && !!e.odds && e.start - Date.now() > CLOSE_MS && Date.now() - e.updated < (mode === 'demo' ? 10 * 6e4 : STALE_MS);

  // ---------- placing bets ----------
  function placeBet(u, b) {
    if (mode === 'off') throw uerr('Sports is not available right now');
    const legsIn = Array.isArray(b.legs) ? b.legs : []; if (!legsIn.length || legsIn.length > MAX_LEGS) throw uerr('Pick 1 to ' + MAX_LEGS + ' selections');
    const kind = b.type === 'combo' && legsIn.length > 1 ? 'combo' : 'single', stake = Math.round((+b.stake || 0) * 100);
    if (!(stake >= MIN_STAKE_C) || stake > MAX_STAKE_C) throw uerr('Amount must be between ' + MIN_STAKE_C / 100 + ' and ' + MAX_STAKE_C / 100 + ' CR');
    const ids = legsIn.map(l => String(l.event || '')); if (kind === 'combo' && new Set(ids).size !== ids.length) throw uerr('A combo can have only one selection per match');
    if (kind === 'single' && new Set(legsIn.map(l => l.event + '|' + l.sel)).size !== legsIn.length) throw uerr('Duplicate selection');
    return tx(() => { const rows = [], changed = [];
      for (const l of legsIn) { const e = db.prepare('SELECT * FROM sp_events WHERE id=?').get(String(l.event || '')); if (!e) throw uerr('That match is no longer available'); if (!canBet(e)) throw uerr(e.home + ' vs ' + e.away + ' is closed');
        const px = priceOf(JSON.parse(e.odds), String(l.sel || '')); if (!px) throw uerr('That market is no longer available for ' + e.home + ' vs ' + e.away);
        if (Math.abs(px - +l.odds) > 1e-9) changed.push({ event: e.id, sel: l.sel, odds: px }); rows.push({ e, sel: String(l.sel), odds: px }); }
      if (changed.length && !b.accept) { const er = uerr('Multipliers changed'); er.odds = changed; er.status = 409; throw er; }
      const total = kind === 'combo' ? stake : stake * rows.length; const need = kind === 'combo' ? 1 : rows.length;
      const w = W(u.id); if (total > w.pool_c) throw uerr('Insufficient balance. Load skins first.');
      const made = [];
      const groups = kind === 'combo' ? [rows] : rows.map(r => [r]);
      for (const g of groups) { const odds = +g.reduce((a, r) => a * r.odds, 1).toFixed(2); if (odds > MAX_ODDS) throw uerr('Combined multiplier is capped at ' + MAX_ODDS + '. Remove a selection.'); const pot = Math.min(MAXPAY_C, Math.round(stake * odds + 1e-9));
        for (const r of g) { const ex = db.prepare("SELECT COALESCE(SUM(b.pot_c),0) s FROM sp_bets b JOIN sp_legs l ON l.bet_id=b.id WHERE b.status='open' AND l.event_id=?").get(r.e.id).s; if (ex + pot > EXPOSURE_C) throw uerr('The limit on this match has been reached, try a smaller amount'); }
        const id = db.prepare('INSERT INTO sp_bets (user_id,kind,stake_c,odds,pot_c,ts) VALUES (?,?,?,?,?,?)').run(u.id, kind, stake, odds, pot, Date.now()).lastInsertRowid;
        for (const r of g) db.prepare('INSERT INTO sp_legs (bet_id,event_id,sel,odds) VALUES (?,?,?,?)').run(id, r.e.id, r.sel, r.odds); made.push({ id: Number(id), odds, stake: toCR(stake), pot: toCR(pot) }); }
      spend(u.id, total); return { ok: true, bets: made, ...wout(u.id) }; }); }
  const uerr = m => { const e = new Error(m); e.user = true; return e; };

  function myBets(u, status) { const rows = db.prepare(`SELECT * FROM sp_bets WHERE user_id=? ${status && status !== 'all' ? 'AND status=?' : ''} ORDER BY id DESC LIMIT 100`).all(...[u.id].concat(status && status !== 'all' ? [status] : []));
    return rows.map(b => ({ id: b.id, kind: b.kind, stake: toCR(b.stake_c), odds: b.odds, pot: toCR(b.pot_c), status: b.status, payout: toCR(b.payout_c), ts: b.ts,
      legs: db.prepare('SELECT l.sel, l.odds, l.result, e.home, e.away, e.league, e.start, e.sport, e.status es, e.hs, e.aws FROM sp_legs l LEFT JOIN sp_events e ON e.id=l.event_id WHERE l.bet_id=?').all(b.id).map(l => ({ sel: l.sel, name: selName(l, l.sel), odds: l.odds, result: l.result, home: l.home, away: l.away, league: l.league, start: l.start, sport: l.sport, es: l.es, hs: l.hs, as: l.aws })) })); }

  // ---------- admin ----------
  const admin = { status: () => ({ ...STATE, book: BOOK, bookCs: BOOK_CS, cut: CUT, liveBets: LIVE_BETS, keySet: !!KEY }),
    sync, resolve: resolveRaw,
    events(q) { const rows = db.prepare(`SELECT e.*, (SELECT COUNT(*) FROM sp_legs l WHERE l.event_id=e.id AND l.result='open') open_legs, (SELECT COALESCE(SUM(b.pot_c),0) FROM sp_bets b JOIN sp_legs l ON l.bet_id=b.id WHERE b.status='open' AND l.event_id=e.id) exposure
      FROM sp_events e ${q === 'open' ? "WHERE EXISTS (SELECT 1 FROM sp_legs l WHERE l.event_id=e.id AND l.result='open')" : ''} ORDER BY e.start DESC LIMIT 150`).all(); return rows.map(e => ({ id: e.id, sport: e.sport, league: e.league, home: e.home, away: e.away, start: e.start, status: e.status, hs: e.hs, as: e.aws, openLegs: e.open_legs, exposure: toCR(e.exposure), manual: !!e.manual })); },
    summary() { const o = db.prepare("SELECT COUNT(*) n, COALESCE(SUM(stake_c),0) st, COALESCE(SUM(pot_c),0) pot FROM sp_bets WHERE status='open'").get(), t = db.prepare("SELECT COALESCE(SUM(stake_c),0) st, COALESCE(SUM(payout_c),0) po FROM sp_bets WHERE status IN ('won','lost')").get();
      return { openBets: o.n, openStake: toCR(o.st), openPotential: toCR(o.pot), settledStake: toCR(t.st), settledPaid: toCR(t.po), house: toCR(t.st - t.po) }; },
    manual(id, status, hs, as) { db.prepare('UPDATE sp_events SET manual=1, status=?, hs=?, aws=? WHERE id=?').run(status, hs, as, id); } };

  // ---------- http ----------
  async function route(req, res, url) { const P = url.pathname; if (!P.startsWith('/sports/')) return false;
    try {
      if (req.method === 'GET' && P === '/sports/status') return send(res, 200, { mode, liveBets: LIVE_BETS, updated: STATE.last, min: MIN_STAKE_C / 100, max: MAX_STAKE_C / 100, maxLegs: MAX_LEGS, maxOdds: MAX_ODDS }), true;
      if (req.method === 'GET' && P === '/sports/events') { if (mode === 'off') return send(res, 200, { mode, events: [] }), true;
        const sport = url.searchParams.get('sport') === 'cs2' ? 'cs2' : 'football', st = url.searchParams.get('status') === 'live' ? 'live' : 'pending', now = Date.now();
        const rows = db.prepare('SELECT * FROM sp_events WHERE sport=? AND status=? AND start < ? ' + (mode === 'demo' ? '' : "AND id NOT LIKE 'demo:%' ") + (st === 'pending' ? 'AND start > ?' : 'AND start > ?') + ' ORDER BY start LIMIT 200').all(sport, st, now + 4 * 864e5, st === 'pending' ? now - 6e4 : now - 6 * 36e5).filter(e => e.odds || st === 'live');
        return send(res, 200, { mode, events: rows.map(pubEv) }), true; }
      if (req.method === 'GET' && P === '/sports/event') { const e = db.prepare('SELECT * FROM sp_events WHERE id=?').get(String(url.searchParams.get('id') || '')); return e ? send(res, 200, { mode, event: pubEv(e) }) : send(res, 404, { error: 'not found' }), true; }
      if (P === '/sports/bet' || P === '/sports/my') { const u = authUser(req); if (!u) return send(res, 401, { error: 'not signed in' }), true;
        if (P === '/sports/my') return send(res, 200, { bets: myBets(u, url.searchParams.get('status')) }), true;
        if (req.method !== 'POST') return send(res, 405, { error: 'POST only' }), true; let b; try { b = JSON.parse(await readBody(req)); } catch (e) { return send(res, 400, { error: 'bad json' }), true; }
        return send(res, 200, placeBet(u, b || {})), true; }
      return false;
    } catch (e) { if (e.status === 409) { send(res, 409, { error: e.message, odds: e.odds }); return true; } if (e.user) { send(res, 400, { error: e.message }); return true; } console.error(e); send(res, 500, { error: 'server error' }); return true; } }
  return { route, admin, mode: () => mode, legResult, parseOdds, settleDue, sync };
};
