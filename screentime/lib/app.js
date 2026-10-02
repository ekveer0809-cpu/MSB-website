// Request handling shared by the local Node server and the Vercel function.
// Every request loads the state from storage; writes run under a lock and are saved before replying.
import crypto from 'node:crypto';
import webpush from 'web-push';
import { getStore } from './store.js';

const DAY_MS = 86400000;

// ---------- credentials ----------
const hashPw = (pw, salt) => crypto.scryptSync(String(pw), salt, 32).toString('hex');
function makeCred(pw) {
  const salt = crypto.randomBytes(16).toString('hex');
  return { salt, hash: hashPw(pw, salt) };
}

function freshDb(env = process.env) {
  const accounts = [
    ['adult', 'Parent', 'adult', env.ADULT_PASSWORD],
    ['child1', 'Child 1', 'child', env.CHILD1_PASSWORD],
    ['child2', 'Child 2', 'child', env.CHILD2_PASSWORD],
  ];
  const users = {};
  for (const [id, name, role, pw] of accounts) users[id] = { name, role, ...(pw ? makeCred(pw) : { salt: null, hash: null }) };
  return { vapid: webpush.generateVAPIDKeys(), users, tokens: {}, sessions: [], alerts: [], subs: {}, limitAlerts: {}, settings: { limitMin: 90, tz: null } };
}

// ---------- per-request logic bound to a loaded db ----------
function logic(db) {
  const pending = []; // push deliveries, awaited before the request ends (serverless functions freeze after replying)

  const tz = () => db.settings.tz || 'UTC';
  const parts = (ms) => Object.fromEntries(new Intl.DateTimeFormat('en-CA', {
    timeZone: tz(), hourCycle: 'h23', year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', second: '2-digit',
  }).formatToParts(ms).map((p) => [p.type, p.value]));
  const dayKey = (ms) => { const p = parts(ms); return `${p.year}-${p.month}-${p.day}`; };
  const dayStart = (ms) => {
    const p = parts(ms);
    return ms - ((Number(p.hour) * 60 + Number(p.minute)) * 60 + Number(p.second)) * 1000 - (ms % 1000);
  };
  const fmtTime = (ms) => new Intl.DateTimeFormat('en-US', { timeZone: tz(), hour: 'numeric', minute: '2-digit' }).format(ms);
  const fmtDur = (ms) => {
    if (ms < 60000) return 'under 1m';
    const m = Math.round(ms / 60000);
    return m >= 60 ? `${Math.floor(m / 60)}h ${m % 60}m` : `${m}m`;
  };

  const limitMs = () => db.settings.limitMin * 60000;
  const activeSession = (child) => db.sessions.find((s) => s.child === child && !s.end);
  const children = () => Object.entries(db.users).filter(([, u]) => u.role === 'child').map(([id, u]) => ({ id, name: u.name }));

  function usedMs(child, now) {
    const from = dayStart(now);
    let total = 0;
    for (const s of db.sessions) {
      if (s.child !== child) continue;
      const a = Math.max(s.start, from);
      const b = Math.min(s.end ?? now, now);
      if (b > a) total += b - a;
    }
    return total;
  }

  function notify(userId, title, body, { type = 'info', child = null } = {}) {
    if (userId === 'adult') {
      db.alerts.unshift({ id: crypto.randomUUID(), ts: Date.now(), type, child, title, body });
      db.alerts.length = Math.min(db.alerts.length, 200);
    }
    const payload = JSON.stringify({ title, body, tag: `${type}-${child || userId}` });
    const opts = { TTL: 3600, timeout: 5000, vapidDetails: { subject: process.env.VAPID_SUBJECT || 'https://example.com', ...{ publicKey: db.vapid.publicKey, privateKey: db.vapid.privateKey } } };
    for (const sub of db.subs[userId] || []) {
      pending.push(webpush.sendNotification(sub, payload, opts).catch((e) => {
        if (e.statusCode === 404 || e.statusCode === 410) db.subs[userId] = (db.subs[userId] || []).filter((s) => s.endpoint !== sub.endpoint);
      }));
    }
  }
  const flush = () => Promise.allSettled(pending.splice(0));

  const limitKey = (child, now) => `${child}:${dayKey(now)}`;
  function needsCheck() {
    const now = Date.now();
    return db.sessions.some((s) => !s.end && usedMs(s.child, now) >= limitMs() && !db.limitAlerts[limitKey(s.child, now)]);
  }
  function checkLimits() {
    const now = Date.now();
    for (const s of db.sessions) {
      if (s.end || usedMs(s.child, now) < limitMs()) continue;
      const key = limitKey(s.child, now);
      if (db.limitAlerts[key]) continue;
      db.limitAlerts[key] = now;
      const name = db.users[s.child].name;
      notify('adult', `${name} hit the ${db.settings.limitMin} min limit`,
        `${name} has used all ${db.settings.limitMin} minutes today and is still logged in (since ${fmtTime(s.start)}).`,
        { type: 'limit', child: s.child });
      notify(s.child, 'Time is up', `You have used your ${db.settings.limitMin} minutes for today. Please log out.`, { type: 'limit' });
    }
    const keys = Object.keys(db.limitAlerts);
    if (keys.length > 60) for (const k of keys.slice(0, keys.length - 60)) delete db.limitAlerts[k];
  }

  function endSession(s, byAdult) {
    const now = Date.now();
    s.end = now;
    const used = usedMs(s.child, now);
    const name = db.users[s.child].name;
    let msg = `${name} ended at ${fmtTime(now)}${byAdult ? ' (ended by parent)' : ''}. Session: ${fmtDur(now - s.start)}. Today: ${fmtDur(used)} of ${db.settings.limitMin}m.`;
    if (used > limitMs()) {
      msg += ` Over the limit by ${fmtDur(used - limitMs())}.`;
      const key = limitKey(s.child, now);
      if (!db.limitAlerts[key]) {
        db.limitAlerts[key] = now;
        notify('adult', `${name} went over the limit`, `${name} used ${fmtDur(used)} today, over the ${db.settings.limitMin}m allowance.`, { type: 'limit', child: s.child });
      }
    }
    notify('adult', `${name} finished`, msg, { type: 'end', child: s.child });
  }

  function daysFor(child, now) {
    const byDay = new Map();
    for (const s of [...db.sessions].reverse()) {
      if (s.child !== child) continue;
      const k = dayKey(s.start);
      if (!byDay.has(k)) byDay.set(k, { date: k, total: 0, sessions: [] });
      const d = byDay.get(k);
      d.sessions.push({ start: s.start, end: s.end });
      d.total += (s.end ?? now) - s.start;
    }
    const today = dayKey(now);
    const out = [...byDay.values()].slice(0, 30);
    for (const d of out) if (d.date === today) d.total = usedMs(child, now);
    return out;
  }

  function stateFor(id) {
    const user = db.users[id];
    const now = Date.now();
    const base = { now, limitMin: db.settings.limitMin, me: { id, name: user.name, role: user.role } };
    if (user.role === 'child') {
      const a = activeSession(id);
      return { ...base, active: a ? { start: a.start } : null, used: usedMs(id, now), days: daysFor(id, now) };
    }
    const kids = children().map((c) => {
      const a = activeSession(c.id);
      return { ...c, active: a ? { start: a.start } : null, used: usedMs(c.id, now), days: daysFor(c.id, now) };
    });
    return { ...base, children: kids, combined: kids.reduce((n, k) => n + k.used, 0), alerts: db.alerts.slice(0, 60), tzUnset: !db.settings.tz, tz: tz() };
  }

  return { db, pending, flush, usedMs, activeSession, limitMs, notify, needsCheck, checkLimits, endSession, stateFor, fmtTime, fmtDur };
}

// ---------- storage plumbing ----------
async function loadDb(store) {
  let db = await store.load();
  if (!db) { await store.init(freshDb()); db = await store.load(); }
  return db;
}

// Read-modify-write under a lock; pushes are delivered and the result saved before returning.
async function write(store, fn) {
  return store.lock(async () => {
    const L = logic(await loadDb(store));
    const result = await fn(L);
    await L.flush();
    const cutoff = Date.now() - 90 * DAY_MS;
    L.db.sessions = L.db.sessions.filter((s) => !s.end || s.end > cutoff);
    await store.save(L.db);
    return result;
  });
}

const validTz = (z) => { try { new Intl.DateTimeFormat('en', { timeZone: z }); return true; } catch { return false; } };
const clientIp = (req) => (req.headers['x-forwarded-for'] || req.socket?.remoteAddress || 'unknown').split(',')[0].trim();
const readBody = async (req) => {
  if (req.body !== undefined && req.body !== null && typeof req.body === 'object' && !Buffer.isBuffer(req.body)) return req.body; // already parsed (Vercel)
  let s = typeof req.body === 'string' ? req.body : '';
  if (req.body === undefined) {
    for await (const c of req) { s += c; if (s.length > 20000) throw new Error('Request too large'); }
  }
  try { return s ? JSON.parse(s) : {}; } catch { throw new Error('Bad JSON'); }
};

// ---------- the API ----------
// Returns [statusCode, jsonBody].
async function route(req, name, body, url) {
  const store = await getStore();
  const send = (code, obj) => [code, obj];

  if (name === 'cron') {
    const secret = process.env.CRON_SECRET;
    const given = (req.headers.authorization || '').replace(/^Bearer /, '') || url.searchParams.get('key');
    if (!secret) return send(503, { error: 'CRON_SECRET is not set' });
    if (given !== secret) return send(401, { error: 'Bad key' });
    if (logic(await loadDb(store)).needsCheck()) await write(store, (L) => L.checkLimits());
    return send(200, { ok: true });
  }

  if (name === 'vapid') return send(200, { key: (await loadDb(store)).vapid.publicKey });

  if (name === 'accounts') {
    const db = await loadDb(store);
    return send(200, { accounts: Object.entries(db.users).map(([id, u]) => ({ id, name: u.name, role: u.role, hasPassword: !!u.hash })) });
  }

  if ((name === 'login' || name === 'setup') && req.method === 'POST') {
    const ip = clientIp(req);
    if ((await store.failCount(ip)) >= 8) return send(429, { error: 'Too many attempts. Try again in a few minutes.' });
    const out = await write(store, async (L) => {
      const u = L.db.users[body.user];
      if (!u) return { fail: 'Unknown account' };
      if (name === 'setup') {
        if (u.hash) return { code: 409, error: 'This account already has a password' };
        if (typeof body.password !== 'string' || body.password.length < 4) return { code: 400, error: 'Password needs at least 4 characters' };
        Object.assign(u, makeCred(body.password));
      } else {
        if (!u.hash) return { code: 409, error: 'Password not set yet' };
        const ok = typeof body.password === 'string' &&
          crypto.timingSafeEqual(Buffer.from(hashPw(body.password, u.salt), 'hex'), Buffer.from(u.hash, 'hex'));
        if (!ok) return { fail: 'Wrong password' };
      }
      const now = Date.now();
      for (const [t, v] of Object.entries(L.db.tokens)) if (v.expires < now) delete L.db.tokens[t];
      const token = crypto.randomBytes(32).toString('hex');
      L.db.tokens[token] = { user: body.user, created: now, expires: now + (body.remember ? 30 * DAY_MS : DAY_MS / 2) };
      return { token };
    });
    if (out.fail) { await store.failAdd(ip, 300); return send(401, { error: out.fail }); }
    if (out.error) return send(out.code, { error: out.error });
    await store.failClear(ip);
    return send(200, { token: out.token });
  }

  // ----- authenticated routes -----
  const m = /^Bearer (.+)$/.exec(req.headers.authorization || '');
  const peek = logic(await loadDb(store));
  const tok = m && peek.db.tokens[m[1]];
  if (!tok || tok.expires < Date.now() || !peek.db.users[tok.user]) return send(401, { error: 'Not logged in' });
  const me = tok.user;
  const isAdult = peek.db.users[me].role === 'adult';

  if (name === 'state') {
    if (peek.needsCheck()) await write(store, (L) => L.checkLimits());
    return send(200, logic(await loadDb(store)).stateFor(me));
  }

  switch (name) {
    case 'logout':
      await write(store, (L) => { delete L.db.tokens[m[1]]; });
      return send(200, {});

    case 'start':
      if (isAdult) return send(403, { error: 'Only children can start' });
      return write(store, (L) => {
        if (L.activeSession(me)) return send(409, { error: 'Already started' });
        const now = Date.now();
        L.db.sessions.push({ id: crypto.randomUUID(), child: me, start: now, end: null });
        const used = L.usedMs(me, now);
        const n = L.db.users[me].name;
        L.notify('adult', `${n} started`,
          `${n} started at ${L.fmtTime(now)}. Used today so far: ${L.fmtDur(used)} of ${L.db.settings.limitMin}m.` +
          (used >= L.limitMs() ? ' Daily limit was already reached.' : ''), { type: 'start', child: me });
        return send(200, L.stateFor(me));
      });

    case 'stop':
      if (isAdult) return send(403, { error: 'Only children can end' });
      return write(store, (L) => {
        const s = L.activeSession(me);
        if (!s) return send(409, { error: 'Not started' });
        L.endSession(s, false);
        return send(200, L.stateFor(me));
      });

    case 'adult-stop':
      if (!isAdult) return send(403, { error: 'Adult only' });
      return write(store, (L) => {
        const s = L.activeSession(body.child);
        if (!s) return send(409, { error: 'Not running' });
        L.endSession(s, true);
        return send(200, L.stateFor(me));
      });

    case 'push-subscribe':
      if (!body.subscription?.endpoint) return send(400, { error: 'Bad subscription' });
      return write(store, (L) => {
        L.db.subs[me] = (L.db.subs[me] || []).filter((s) => s.endpoint !== body.subscription.endpoint);
        L.db.subs[me].push(body.subscription);
        return send(200, {});
      });

    case 'push-unsubscribe':
      return write(store, (L) => {
        L.db.subs[me] = (L.db.subs[me] || []).filter((s) => s.endpoint !== body.endpoint);
        return send(200, {});
      });

    case 'settings':
      if (!isAdult) return send(403, { error: 'Adult only' });
      return write(store, (L) => {
        const { db } = L;
        if (body.limitMin !== undefined) {
          const n = Math.round(Number(body.limitMin));
          if (!(n >= 1 && n <= 1440)) return send(400, { error: 'Limit must be 1-1440 minutes' });
          db.settings.limitMin = n;
        }
        if (body.tz !== undefined) {
          if (!validTz(body.tz)) return send(400, { error: 'Unknown timezone' });
          db.settings.tz = body.tz;
        }
        for (const [id, nm] of Object.entries(body.names || {})) {
          if (db.users[id] && String(nm).trim()) db.users[id].name = String(nm).trim().slice(0, 30);
        }
        for (const [id, pw] of Object.entries(body.passwords || {})) {
          if (!db.users[id] || !pw) continue;
          if (String(pw).length < 4) return send(400, { error: 'Passwords need at least 4 characters' });
          Object.assign(db.users[id], makeCred(pw));
          for (const [t, v] of Object.entries(db.tokens)) if (v.user === id && t !== m[1]) delete db.tokens[t];
        }
        return send(200, L.stateFor(me));
      });
  }
  return send(404, { error: 'Not found' });
}

export async function handleApi(req, res) {
  let out;
  try {
    const url = new URL(req.url, 'http://x');
    const body = req.method === 'POST' ? await readBody(req) : {};
    out = await route(req, url.pathname.replace(/^\/api\//, '').replace(/\/$/, ''), body, url);
  } catch (e) {
    console.error(e);
    out = [e.message?.startsWith('Storage is not configured') ? 503 : 500, { error: e.message || 'Server error' }];
  }
  res.writeHead(out[0], { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' });
  res.end(JSON.stringify(out[1]));
}
