'use strict';
// CrystalDrop Steam trade bot — runs as its OWN process (Render "Background Worker"), separate from server.js.
//   node bot.js
// It logs in to the bot's Steam account, then polls the website server (GET /bot/jobs):
//   inventory job -> reads a player's public CS2 inventory      trade job -> sends the player a trade offer asking for their skins
// and reports every offer change (accepted / declined / cancelled / rolled back) to POST /bot/offer-event. The server does ALL pricing and crediting;
// this process never decides how much a skin is worth and never holds any player balance.
//
// Environment:  API_URL (https://crystaldrop.onrender.com)  BOT_TOKEN (same value as on the web server)
//               STEAM_BOT_USER  STEAM_BOT_PASS  STEAM_SHARED_SECRET  STEAM_IDENTITY_SECRET   <- secrets of the bot's own Steam account
//               OFFER_TTL_MIN (default 20)
// Packages (npm install in this folder): steam-user, steam-tradeoffer-manager, steam-totp   (declared as optionalDependencies)

const FRIENDLY = [
  [/private|not public|403|forbidden/i, 'Your Steam inventory is private. Set it to Public in Steam > Privacy settings, then try again.'],
  [/trade ?url|token|invalid.*partner|not.*friend/i, 'Steam rejected that trade URL. Copy it again from Steam > Inventory > Trade offers > "Who can send me trade offers?"'],
  [/ban|probation|not allowed to trade|trade.*restrict/i, 'This Steam account cannot trade right now (trade ban or restriction).'],
  [/rate|429|too many/i, 'Steam is busy right now, try again in a minute.'],
];
const friendly = e => { const m = String(e && e.message || e || 'failed'); for (const [re, t] of FRIENDLY) if (re.test(m)) return t; return ('Steam error: ' + m).slice(0, 180); };

function createBot({ api, token, adapter, pollMs = 3000, watchMs = 10 * 60e3, log = console.log, fetchFn = (...a) => fetch(...a) }) {
  const outbox = [], reported = new Set(); let watch = [], lastWatch = 0, busy = false, stopped = false;
  const call = async (method, path, body) => {
    const r = await fetchFn(api.replace(/\/$/, '') + path, { method, headers: { Authorization: 'Bearer ' + token, 'Content-Type': 'application/json' }, body: body ? JSON.stringify(body) : undefined, signal: AbortSignal.timeout(20000) });
    const t = await r.text(); let j; try { j = JSON.parse(t); } catch (e) { j = {}; } return { status: r.status, json: j };
  };
  adapter.onOffer(ev => outbox.push({ ...ev, tries: 0 }));
  async function flush() {                                                       // events are retried until the server has them: an acceptance must never be lost
    for (const ev of outbox.splice(0)) {
      try { const { tries, ...body } = ev; const r = await call('POST', '/bot/offer-event', body);
        if (r.status >= 500 || r.status === 429 || r.status === 503) throw new Error('HTTP ' + r.status);
        if (r.status >= 400) log('server refused event', body.state, body.code, r.status, JSON.stringify(r.json)); else if (ev.state === 'accepted') log('accepted', body.code, '->', r.json.status);
      } catch (e) { ev.tries++; if (ev.tries < 200) outbox.push(ev); else log('dropping event after 200 tries', ev.code, ev.state); }
    }
  }
  async function runJob(j) {
    try {
      if (j.type === 'inventory') { const items = await adapter.inventory(j.payload.steamid, j.payload.appid || 730); await call('POST', '/bot/jobs/' + j.id, { ok: true, result: { items } }); log('inventory', j.payload.steamid, items.length, 'items'); }
      else if (j.type === 'trade') { const p = j.payload, r = await adapter.sendOffer({ appid: p.appid || 730, steamid: p.steamid, tradeUrl: p.tradeUrl, assetids: p.assetids, message: p.message, code: p.code }); await call('POST', '/bot/jobs/' + j.id, { ok: true, result: { offerId: String(r.offerId) } }); log('offer', r.offerId, p.code, p.assetids.length, 'items'); }
      else await call('POST', '/bot/jobs/' + j.id, { ok: false, error: 'unknown job type' });
    } catch (e) { log('job failed', j.type, e && e.message); try { await call('POST', '/bot/jobs/' + j.id, { ok: false, error: friendly(e) }); } catch (_) {} }
  }
  async function checkWatch() {                                                  // Steam can roll back a trade for a while after it was accepted: ask it again for every offer we are still exposed on
    for (const w of watch) {
      if (reported.has(w.code)) continue;
      try { const s = await adapter.offerState(w.offerId); if (s && s.state && s.state !== 'accepted' && s.state !== 'unknown') { reported.add(w.code); log('REVERSED?', w.code, w.offerId, s.state, s.raw === undefined ? '' : 'raw=' + s.raw); outbox.push({ code: w.code, offerId: w.offerId, state: 'reversed', tries: 0 }); } } catch (e) { log('watch check failed', w.offerId, e && e.message); }
    }
  }
  async function tick() {
    if (busy || stopped) return; busy = true;
    try {
      if (adapter.ready()) {                                                       // only poll while logged in: polling is what tells the site the bot is online
        const r = await call('GET', '/bot/jobs'); if (r.status === 200) { watch = r.json.watch || []; await Promise.all((r.json.jobs || []).map(runJob)); } else log('jobs poll HTTP', r.status);
      }
      await flush();
      if (Date.now() - lastWatch > watchMs && adapter.ready()) { lastWatch = Date.now(); await checkWatch(); await flush(); }
    } catch (e) { log('tick error', e && e.message); } finally { busy = false; }
  }
  let timer = null;
  return { tick, flush, outbox, start() { timer = setInterval(tick, pollMs); tick(); }, stop() { stopped = true; clearInterval(timer); } };
}

// ---------- the real Steam adapter (needs the three npm packages and a bot account; not used by the tests) ----------
function steamAdapter(env = process.env) {
  const SteamUser = require('steam-user'), SteamCommunity = require('steamcommunity'), TradeOfferManager = require('steam-tradeoffer-manager'), SteamTotp = require('steam-totp');
  const client = new SteamUser(), community = new SteamCommunity(), ttl = (+env.OFFER_TTL_MIN || 20) * 60e3;
  const manager = new TradeOfferManager({ steam: client, community, language: 'en', pollInterval: 5000, cancelTime: ttl, useAccessToken: true });
  const S = TradeOfferManager.EOfferState; let ready = false; const subs = [];
  const name = { [S.Accepted]: 'accepted', [S.Declined]: 'declined', [S.Canceled]: 'canceled', [S.Expired]: 'expired', [S.Invalid]: 'invalid', [S.InvalidItems]: 'invalid', [S.CanceledBySecondFactor]: 'canceled', [S.Countered]: 'declined', [S.Active]: 'unknown', [S.CreatedNeedsConfirmation]: 'unknown', [S.InEscrow]: 'unknown' };
  const emit = ev => subs.forEach(f => f(ev));
  const login = () => client.logOn({ accountName: env.STEAM_BOT_USER, password: env.STEAM_BOT_PASS, twoFactorCode: SteamTotp.generateAuthCode(env.STEAM_SHARED_SECRET) });
  client.on('loggedOn', () => console.log('steam: logged in as', client.steamID && client.steamID.getSteamID64()));
  client.on('webSession', (sid, cookies) => { manager.setCookies(cookies, e => { if (e) { console.error('steam: manager cookies', e.message); return; } ready = true; console.log('steam: trade manager ready'); }); community.setCookies(cookies); community.startConfirmationChecker(10000, env.STEAM_IDENTITY_SECRET); });
  client.on('error', e => { ready = false; console.error('steam: login error', e.message); setTimeout(() => process.exit(1), 60000); });                  // Render restarts the worker; the wait avoids hammering Steam's login limits
  client.on('disconnected', () => { ready = false; });
  client.on('steamGuard', (domain, cb) => { console.error('steam: asked for a Steam Guard code by email — this bot must use the mobile authenticator (shared_secret)'); cb(SteamTotp.generateAuthCode(env.STEAM_SHARED_SECRET)); });
  setInterval(() => { if (client.steamID && !ready) client.webLogOn(); }, 5 * 60e3).unref();
  manager.on('sentOfferChanged', (offer, old) => {
    const st = name[offer.state] || 'unknown', m = /CD-[A-Z0-9]{4}/.exec(offer.message || ''); if (!m || st === 'unknown') { if (m) console.log('offer', offer.id, 'state', offer.state, 'ignored'); return; }
    if (st !== 'accepted') return emit({ code: m[0], offerId: offer.id, state: st });
    offer.getReceivedItems((err, items) => { if (err) { console.error('getReceivedItems', offer.id, err.message); return; } emit({ code: m[0], offerId: offer.id, state: 'accepted', items: items.map(i => ({ assetid: String(i.assetid || i.id), name: i.market_hash_name })) }); });
  });
  if (env.STEAM_BOT_USER) login();
  const wear = it => { const t = (it.tags || []).find(x => x.category === 'Exterior'); return t ? (t.localized_tag_name || t.name || '') : ''; };
  return {
    ready: () => ready, onOffer: f => subs.push(f),
    inventory: (steamid, appid = 730) => new Promise((res, rej) => manager.getUserInventoryContents(steamid, appid, 2, true, (e, inv) => e ? rej(e) : res(inv.filter(i => i.tradable && i.marketable).map(i => ({ assetid: String(i.assetid || i.id), name: i.market_hash_name, wear: wear(i), icon: i.icon_url || '' }))))),
    sendOffer: ({ tradeUrl, assetids, message, appid = 730 }) => new Promise((res, rej) => {
      const offer = manager.createOffer(tradeUrl); offer.addTheirItems(assetids.map(a => ({ appid, contextid: '2', assetid: String(a) }))); offer.setMessage(message);
      offer.send((e, status) => e ? rej(e) : res({ offerId: offer.id, status }));
    }),
    offerState: id => new Promise((res, rej) => manager.getOffer(id, (e, offer) => e ? rej(e) : res({ state: name[offer.state] || 'unknown', raw: offer.state }))),
  };
}

if (require.main === module) {
  const need = ['API_URL', 'BOT_TOKEN', 'STEAM_BOT_USER', 'STEAM_BOT_PASS', 'STEAM_SHARED_SECRET', 'STEAM_IDENTITY_SECRET'].filter(k => !process.env[k]);
  if (need.length) { console.error('missing environment variables: ' + need.join(', ')); process.exit(1); }
  createBot({ api: process.env.API_URL, token: process.env.BOT_TOKEN, adapter: steamAdapter() }).start(); console.log('CrystalDrop bot started');
}
module.exports = { createBot, steamAdapter, friendly };
