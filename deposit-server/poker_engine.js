'use strict';
// No-limit Texas Hold'em rules engine. Pure logic: no database, no network, no clock of its own.
// All money is whole cents. A Table is one cash-game table; the server (poker.js) moves real money in and out around it.
const crypto = require('crypto');

const RANKS = '23456789TJQKA', SUITS = 'cdhs';
const cardStr = i => RANKS[i % 13] + SUITS[(i / 13) | 0];
const CAT = ['High card', 'Pair', 'Two pair', 'Three of a kind', 'Straight', 'Flush', 'Full house', 'Four of a kind', 'Straight flush'];

// ---- hand evaluation: best five of seven cards, one comparable number per hand ----
function score5(c) {                                  // c: five card indexes
  const r = c.map(x => (x % 13) + 2).sort((a, b) => b - a), flush = c.every(x => ((x / 13) | 0) === ((c[0] / 13) | 0));
  const cnt = {}; r.forEach(x => { cnt[x] = (cnt[x] || 0) + 1; });
  let st = 0; { const u = [...new Set(r)]; if (u.length === 5) { if (u[0] - u[4] === 4) st = u[0]; else if (u[0] === 14 && u[1] === 5 && u[4] === 2) st = 5; } }
  const g = Object.keys(cnt).map(Number).sort((a, b) => cnt[b] - cnt[a] || b - a), pat = g.map(x => cnt[x]).join('');
  let cat, tb;
  if (st && flush) { cat = 8; tb = [st]; } else if (pat === '41') { cat = 7; tb = g; } else if (pat === '32') { cat = 6; tb = g; } else if (flush) { cat = 5; tb = r; }
  else if (st) { cat = 4; tb = [st]; } else if (pat === '311') { cat = 3; tb = g; } else if (pat === '221') { cat = 2; tb = g; } else if (pat === '2111') { cat = 1; tb = g; } else { cat = 0; tb = r; }
  let s = cat; for (let i = 0; i < 5; i++) s = s * 15 + (tb[i] || 0); return s;
}
function best7(cards) {
  let b = -1; const n = cards.length;
  for (let a = 0; a < n - 4; a++) for (let c = a + 1; c < n - 3; c++) for (let d = c + 1; d < n - 2; d++) for (let e = d + 1; e < n - 1; e++) for (let f = e + 1; f < n; f++) {
    const s = score5([cards[a], cards[c], cards[d], cards[e], cards[f]]); if (s > b) b = s; }
  return b;
}
const catOf = s => Math.floor(s / Math.pow(15, 5));

const err = m => { const e = new Error(m); e.user = true; return e; };

class Table {
  constructor(o) {
    this.sb = o.sb; this.bb = o.bb; this.n = o.seats || 6; this.rakePct = o.rakePct == null ? 0.05 : o.rakePct; this.rakeCap = o.rakeCap == null ? this.bb * 3 : o.rakeCap;
    this.turnMs = o.turnMs || 25000; this.gapMs = o.gapMs == null ? 4000 : o.gapMs; this.rng = o.rng || (n => crypto.randomInt(n));
    this.seats = Array.from({ length: this.n }, () => null); this.button = -1; this.live = false; this.street = 0; this.board = []; this.deck = [];
    this.curBet = 0; this.lastRaise = this.bb; this.actor = -1; this.deadline = 0; this.nextAt = 0; this.handNo = 0; this.last = null; this.ver = 1; this.rakeTotal = 0;
  }
  bump() { this.ver++; }
  idx(uid) { return this.seats.findIndex(s => s && s.uid === uid); }
  active() { return this.seats.map((s, i) => (s && s.inHand && !s.folded ? i : -1)).filter(i => i >= 0); }
  canAct(i) { const s = this.seats[i]; return !!(s && s.inHand && !s.folded && !s.allin); }
  nextFrom(i, pred) { for (let k = 1; k <= this.n; k++) { const j = (i + k) % this.n; if (pred(j)) return j; } return -1; }

  sit(i, uid, name, stack) {
    if (!(i >= 0 && i < this.n)) throw err('No such seat.'); if (this.seats[i]) throw err('That seat is taken.'); if (this.idx(uid) >= 0) throw err('You are already at this table.');
    this.seats[i] = { uid, name, stack, bet: 0, total: 0, hole: [], folded: false, allin: false, acted: false, canRaise: true, inHand: false, sitOut: false, timeouts: 0, since: 0, gone: false };
    this.bump(); return i;
  }
  inLiveHand(s) { return this.live && s.inHand; }
  topUp(uid, amt) { const i = this.idx(uid); if (i < 0) throw err('You are not at this table.'); const s = this.seats[i]; if (this.inLiveHand(s) && !s.folded) throw err('Add chips between hands.'); s.stack += amt; this.bump(); }
  // a player leaves: returns the chips that go back to their balance. Chips already bet this hand stay in the pot.
  leave(uid, now) {
    const i = this.idx(uid); if (i < 0) return 0; const s = this.seats[i], cash = s.stack; s.stack = 0;
    if (this.inLiveHand(s)) { s.gone = true; if (!s.folded) { s.folded = true; this.bump(); this.settle(now || Date.now(), this.actor >= 0 && i !== this.actor ? (this.actor + this.n - 1) % this.n : i); } else this.bump(); }
    else { this.seats[i] = null; this.bump(); }
    return cash;
  }
  setSitOut(uid, v) { const i = this.idx(uid); if (i < 0) throw err('You are not at this table.'); const s = this.seats[i]; s.sitOut = !!v; if (!v) { s.timeouts = 0; } this.bump(); }

  // ---- hand flow ----
  startHand(now) {
    const el = this.seats.map((s, i) => (s && !s.sitOut && !s.gone && s.stack > 0 ? i : -1)).filter(i => i >= 0);
    if (el.length < 2) return false;
    this.seats.forEach(s => { if (s) { s.hole = []; s.bet = 0; s.total = 0; s.folded = false; s.allin = false; s.acted = false; s.canRaise = true; s.inHand = false; } });
    el.forEach(i => { this.seats[i].inHand = true; });
    const isEl = i => el.includes(i); this.button = this.nextFrom(this.button < 0 ? this.n - 1 : this.button, isEl);
    this.deck = Array.from({ length: 52 }, (_, i) => i); for (let i = 51; i > 0; i--) { const j = this.rng(i + 1); [this.deck[i], this.deck[j]] = [this.deck[j], this.deck[i]]; }
    this.board = []; this.street = 0; this.live = true; this.handNo++; this.last = null; this.startStacks = {}; el.forEach(i => { this.startStacks[this.seats[i].uid] = this.seats[i].stack; });
    for (let r = 0; r < 2; r++) { let i = this.button; for (let k = 0; k < el.length; k++) { i = this.nextFrom(i, isEl); this.seats[i].hole.push(this.deck.pop()); } }
    const headsUp = el.length === 2, sbI = headsUp ? this.button : this.nextFrom(this.button, isEl), bbI = this.nextFrom(sbI, isEl);
    this.post(sbI, this.sb); this.post(bbI, this.bb); this.curBet = Math.max(this.seats[sbI].bet, this.seats[bbI].bet); this.lastRaise = this.bb;
    this.sbI = sbI; this.bbI = bbI; this.actor = -1; this.bump(); this.settle(now, bbI, true); return true;
  }
  post(i, amt) { const s = this.seats[i], a = Math.min(s.stack, amt); s.stack -= a; s.bet += a; s.total += a; if (s.stack === 0) s.allin = true; }
  needs(i) { const s = this.seats[i]; if (!this.canAct(i)) return false; if (s.bet < this.curBet) return true; return !s.acted && this.active().filter(j => this.canAct(j)).length >= 2; }
  // decides what happens next: who acts, or deal the next street, or finish the hand
  settle(now, from, first) {
    for (let guard = 0; guard < 20; guard++) {
      const act = this.active();
      if (act.length === 1) return this.endByFold(now, act[0]);
      const need = this.seats.map((s, i) => i).filter(i => this.needs(i));
      if (need.length) { const nx = this.nextFrom(from, i => this.needs(i)); if (nx !== this.actor) { this.actor = nx; this.deadline = now + this.turnMs; } this.bump(); return; }
      if (this.street === 3) return this.showdown(now);
      this.nextStreet(); from = this.button;
    }
  }
  nextStreet() {
    this.seats.forEach(s => { if (s && s.inHand) { s.bet = 0; s.acted = false; s.canRaise = true; } });
    this.curBet = 0; this.lastRaise = this.bb; this.street++; this.deck.pop();            // burn
    const k = this.street === 1 ? 3 : 1; for (let i = 0; i < k; i++) this.board.push(this.deck.pop());
    this.actor = -1; this.bump();
  }
  toCall(i) { const s = this.seats[i]; return Math.max(0, Math.min(s.stack, this.curBet - s.bet)); }
  minRaiseTo() { return this.curBet + this.lastRaise; }
  commit(i, amt) { const s = this.seats[i]; s.stack -= amt; s.bet += amt; s.total += amt; if (s.stack === 0) s.allin = true; }

  act(uid, a, amt, now) {
    if (!this.live) throw err('No hand in progress.'); const i = this.idx(uid); if (i < 0 || i !== this.actor) throw err('It is not your turn.');
    const s = this.seats[i], owe = this.curBet - s.bet;
    if (a === 'fold') { s.folded = true; }
    else if (a === 'check') { if (owe > 0) throw err('You must call or fold.'); s.acted = true; }
    else if (a === 'call') { if (owe <= 0) throw err('There is nothing to call.'); this.commit(i, Math.min(s.stack, owe)); s.acted = true; }
    else if (a === 'raise' || a === 'allin') {
      let to = a === 'allin' ? s.bet + s.stack : Math.floor(+amt); const max = s.bet + s.stack;
      if (!(to > 0)) throw err('Enter an amount.'); if (to > max) throw err('You do not have that many chips.');
      if (to <= this.curBet) { if (a === 'allin' && to > s.bet) { this.commit(i, to - s.bet); s.acted = true; return this.after(now, i); } throw err('A raise must be bigger than the current bet.'); }
      const others = this.active().filter(j => j !== i && this.canAct(j));
      if (!others.length) { if (a === 'allin') { this.commit(i, Math.min(s.stack, Math.max(0, owe))); s.acted = true; return this.after(now, i); } throw err('Everyone else is all-in. You can only call or fold.'); }
      if (!s.canRaise && to < max) throw err('You cannot raise again after a short all-in.'); if (!s.canRaise) throw err('You cannot raise again after a short all-in.');
      if (to < this.minRaiseTo() && to < max) throw err('The smallest raise is to ' + this.minRaiseTo() + '.');
      const inc = to - this.curBet; this.commit(i, to - s.bet); s.acted = true;
      if (inc >= this.lastRaise) { this.lastRaise = inc; this.seats.forEach((o, j) => { if (j !== i && o && o.inHand && !o.folded && !o.allin) { o.acted = false; o.canRaise = true; } }); }
      else { this.seats.forEach((o, j) => { if (j !== i && o && o.inHand && !o.folded && !o.allin && o.acted) o.canRaise = false; }); }
      this.curBet = to;
    } else throw err('Unknown action.');
    this.after(now, i);
  }
  after(now, i) { this.seats[i].timeouts = 0; this.bump(); this.settle(now, i); }

  // time passes: a slow player is folded (or checked), and the next hand starts after a short pause
  tick(now) {
    if (this.live) {
      if (this.actor >= 0 && now >= this.deadline) { const s = this.seats[this.actor], i = this.actor; s.timeouts++; s.sitOut = true; const owe = this.curBet - s.bet; if (owe <= 0) { s.acted = true; } else s.folded = true; this.bump(); this.settle(now, i); return true; }
      return false;
    }
    if (now >= this.nextAt) return this.startHand(now);
    return false;
  }

  endByFold(now, w) {
    const refund = this.refundUncalled(); const pot = this.seats.reduce((a, s) => a + (s ? s.total : 0), 0), rake = this.street >= 1 ? Math.min(Math.floor(pot * this.rakePct), this.rakeCap) : 0;
    const win = pot - rake; this.seats[w].stack += win; this.rakeTotal += rake;
    this.finish(now, { type: 'fold', pot, rake, winners: [{ uid: this.seats[w].uid, name: this.seats[w].name, amount: win }], board: this.board.map(cardStr), reveal: [] });
  }
  refundUncalled() {
    const ins = this.seats.filter(s => s && s.inHand), tot = ins.map(s => s.total).sort((a, b) => b - a); if (tot.length < 2 || tot[0] === tot[1]) return 0;
    const top = ins.find(s => s.total === tot[0]), d = tot[0] - tot[1]; top.total -= d; top.bet = Math.max(0, top.bet - d); top.stack += d; return d;
  }
  showdown(now) {
    this.refundUncalled(); const ins = this.seats.map((s, i) => i).filter(i => this.seats[i] && this.seats[i].inHand), live = ins.filter(i => !this.seats[i].folded);
    const sc = {}; live.forEach(i => { const s = this.seats[i]; sc[i] = best7(s.hole.concat(this.board)); });
    const lv = [...new Set(live.map(i => this.seats[i].total))].sort((a, b) => a - b), pots = []; let prev = 0;
    lv.forEach(L => { let amt = 0; ins.forEach(i => { amt += Math.max(0, Math.min(this.seats[i].total, L) - prev); }); pots.push({ amt, el: live.filter(i => this.seats[i].total >= L) }); prev = L; });
    const pot = pots.reduce((a, p) => a + p.amt, 0); let rake = this.street >= 1 ? Math.min(Math.floor(pot * this.rakePct), this.rakeCap) : 0; const rakeTaken = rake;
    pots.forEach(p => { const t = Math.min(rake, p.amt); p.amt -= t; rake -= t; });
    const won = {}; const order = i => (i - this.button - 1 + this.n * 2) % this.n;
    pots.forEach(p => { if (p.amt <= 0) return; const top = Math.max(...p.el.map(i => sc[i])), ws = p.el.filter(i => sc[i] === top).sort((a, b) => order(a) - order(b)), each = Math.floor(p.amt / ws.length); let rem = p.amt - each * ws.length;
      ws.forEach(i => { let g = each; if (rem > 0) { g++; rem--; } won[i] = (won[i] || 0) + g; }); });
    Object.keys(won).forEach(i => { this.seats[i].stack += won[i]; }); this.rakeTotal += rakeTaken;
    this.finish(now, { type: 'showdown', pot, rake: rakeTaken, board: this.board.map(cardStr),
      winners: Object.keys(won).map(i => ({ uid: this.seats[i].uid, name: this.seats[i].name, amount: won[i], hand: CAT[catOf(sc[i])] })),
      reveal: live.map(i => ({ uid: this.seats[i].uid, name: this.seats[i].name, hole: this.seats[i].hole.map(cardStr), hand: CAT[catOf(sc[i])] })) });
  }
  finish(now, res) {
    this.last = Object.assign({ no: this.handNo }, res); this.live = false; this.actor = -1; this.nextAt = now + this.gapMs;
    this.seats.forEach((s, i) => { if (s && s.gone) this.seats[i] = null; });
    this.bump();
  }

  // what one player is allowed to see
  view(uid, now) {
    const me = this.idx(uid), showAll = !this.live && this.last && this.last.type === 'showdown';
    const rev = {}; if (showAll) this.last.reveal.forEach(r => { rev[r.uid] = r.hole; });
    const pot = this.seats.reduce((a, s) => a + (s ? s.total : 0), 0);
    const seats = this.seats.map((s, i) => s && ({ i, name: s.name, stack: s.stack, bet: this.live ? s.bet : 0, folded: s.folded && this.live, allin: s.allin && this.live, sitOut: s.sitOut, inHand: this.live && s.inHand, dealer: i === this.button && (this.live || !!this.last), sb: this.live && i === this.sbI, bb: this.live && i === this.bbI, turn: this.live && i === this.actor,
      hole: s.uid === uid ? (s.hole.length ? s.hole.map(cardStr) : null) : (rev[s.uid] || (this.live && s.inHand && !s.folded ? ['??', '??'] : null)), me: s.uid === uid }));
    const my = me >= 0 ? this.seats[me] : null, turn = !!(my && this.live && this.actor === me);
    return { ver: this.ver, hand: this.handNo, live: this.live, street: this.street, board: this.board.map(cardStr), pot: this.live ? pot : 0, seats, button: this.button, last: this.last, rakePct: undefined,
      turn, deadline: this.live && this.actor >= 0 ? this.deadline : 0, nextAt: !this.live ? this.nextAt : 0, sb: this.sb, bb: this.bb,
      opts: turn ? { toCall: this.toCall(me), minRaiseTo: Math.min(this.minRaiseTo(), my.bet + my.stack), maxTo: my.bet + my.stack, canRaise: my.canRaise && this.active().some(j => j !== me && this.canAct(j)), curBet: this.curBet } : null, mySeat: me, now };
  }
}

module.exports = { Table, best7, score5, catOf, cardStr, CAT, err };
