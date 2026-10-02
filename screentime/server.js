import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import webpush from 'web-push';

const PORT = Number(process.env.PORT) || 3000;
const DATA_DIR = process.env.DATA_DIR || path.join(import.meta.dirname, 'data');
const DATA_FILE = path.join(DATA_DIR, 'data.json');
const PUBLIC_DIR = path.join(import.meta.dirname, 'public');
const DAY_MS = 86400000;

// ---------- persistence ----------
fs.mkdirSync(DATA_DIR, { recursive: true });

function hashPw(pw, salt) {
  return crypto.scryptSync(String(pw), salt, 32).toString('hex');
}
function makeCred(pw) {
  const salt = crypto.randomBytes(16).toString('hex');
  return { salt, hash: hashPw(pw, salt) };
}
function randomPw() {
  return crypto.randomBytes(5).toString('hex');
}

let db;
if (fs.existsSync(DATA_FILE)) {
  db = JSON.parse(fs.readFileSync(DATA_FILE, 'utf8'));
} else {
  const vapid = webpush.generateVAPIDKeys();
  const accounts = [
    ['adult', 'Parent', 'adult', process.env.ADULT_PASSWORD],
    ['child1', 'Child 1', 'child', process.env.CHILD1_PASSWORD],
    ['child2', 'Child 2', 'child', process.env.CHILD2_PASSWORD],
  ];
  db = { vapid, users: {}, tokens: {}, sessions: [], alerts: [], subs: {}, limitAlerts: {}, settings: { limitMin: 90, tz: null } };
  console.log('\nFirst run: created accounts. Passwords (change them in Settings):');
  for (const [id, name, role, pw] of accounts) {
    const password = pw || randomPw();
    db.users[id] = { name, role, ...makeCred(password) };
    console.log(`  ${id.padEnd(7)} ${password}${pw ? '  (from env)' : ''}`);
  }
  console.log('');
  save();
}

function save() {
  const tmp = DATA_FILE + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(db));
  fs.renameSync(tmp, DATA_FILE);
}

webpush.setVapidDetails(process.env.VAPID_SUBJECT || 'https://example.com', db.vapid.publicKey, db.vapid.privateKey);

// ---------- time helpers (day boundaries use the configured timezone) ----------
const tz = () => db.settings.tz || 'UTC';

function parts(ms) {
  const f = new Intl.DateTimeFormat('en-CA', {
    timeZone: tz(), hourCycle: 'h23', year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', second: '2-digit',
  });
  return Object.fromEntries(f.formatToParts(ms).map((p) => [p.type, p.value]));
}
const dayKey = (ms) => { const p = parts(ms); return `${p.year}-${p.month}-${p.day}`; };
function dayStart(ms) {
  const p = parts(ms);
  return ms - ((Number(p.hour) * 60 + Number(p.minute)) * 60 + Number(p.second)) * 1000 - (ms % 1000);
}
const fmtTime = (ms) => new Intl.DateTimeFormat('en-US', { timeZone: tz(), hour: 'numeric', minute: '2-digit' }).format(ms);
function fmtDur(ms) {
  if (ms < 60000) return 'under 1m';
  const m = Math.round(ms / 60000);
  return m >= 60 ? `${Math.floor(m / 60)}h ${m % 60}m` : `${m}m`;
}

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
const activeSession = (child) => db.sessions.find((s) => s.child === child && !s.end);
const limitMs = () => db.settings.limitMin * 60000;
const children = () => Object.entries(db.users).filter(([, u]) => u.role === 'child').map(([id, u]) => ({ id, name: u.name }));

// ---------- notifications ----------
function notify(userId, title, body, { type = 'info', child = null } = {}) {
  if (userId === 'adult') {
    db.alerts.unshift({ id: crypto.randomUUID(), ts: Date.now(), type, child, title, body });
    db.alerts.length = Math.min(db.alerts.length, 200);
  }
  const payload = JSON.stringify({ title, body, tag: `${type}-${child || userId}` });
  for (const sub of db.subs[userId] || []) {
    webpush.sendNotification(sub, payload).catch((e) => {
      if (e.statusCode === 404 || e.statusCode === 410) {
        db.subs[userId] = (db.subs[userId] || []).filter((s) => s.endpoint !== sub.endpoint);
        save();
      }
    });
  }
}

function checkLimits() {
  const now = Date.now();
  let changed = false;
  for (const s of db.sessions) {
    if (s.end) continue;
    if (usedMs(s.child, now) < limitMs()) continue;
    const key = `${s.child}:${dayKey(now)}`;
    if (db.limitAlerts[key]) continue;
    db.limitAlerts[key] = now;
    changed = true;
    const name = db.users[s.child].name;
    notify('adult', `${name} hit the ${db.settings.limitMin} min limit`,
      `${name} has used all ${db.settings.limitMin} minutes today and is still logged in (since ${fmtTime(s.start)}).`,
      { type: 'limit', child: s.child });
    notify(s.child, 'Time is up', `You have used your ${db.settings.limitMin} minutes for today. Please log out.`, { type: 'limit' });
  }
  const keys = Object.keys(db.limitAlerts);
  if (keys.length > 60) for (const k of keys.slice(0, keys.length - 60)) delete db.limitAlerts[k];
  if (changed) save();
}
setInterval(checkLimits, 5000);

// ---------- auth ----------
const failures = new Map();
function clientIp(req) {
  return (req.headers['x-forwarded-for'] || req.socket.remoteAddress || '').split(',')[0].trim();
}
function authUser(req) {
  const m = /^Bearer (.+)$/.exec(req.headers.authorization || '');
  const t = m && db.tokens[m[1]];
  return t && db.users[t.user] ? { id: t.user, token: m[1], ...db.users[t.user] } : null;
}

// ---------- state views ----------
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

function stateFor(user) {
  const now = Date.now();
  const base = { now, limitMin: db.settings.limitMin, me: { id: user.id, name: user.name, role: user.role } };
  if (user.role === 'child') {
    const a = activeSession(user.id);
    return { ...base, active: a ? { start: a.start } : null, used: usedMs(user.id, now), days: daysFor(user.id, now) };
  }
  const kids = children().map((c) => {
    const a = activeSession(c.id);
    return { ...c, active: a ? { start: a.start } : null, used: usedMs(c.id, now), days: daysFor(c.id, now) };
  });
  return {
    ...base, children: kids, combined: kids.reduce((n, k) => n + k.used, 0),
    alerts: db.alerts.slice(0, 60), tzUnset: !db.settings.tz, tz: tz(),
  };
}

// ---------- API ----------
const json = (res, code, obj) => {
  res.writeHead(code, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' });
  res.end(JSON.stringify(obj));
};
const readBody = (req) => new Promise((resolve, reject) => {
  let s = '';
  req.on('data', (c) => { s += c; if (s.length > 20000) { reject(new Error('too large')); req.destroy(); } });
  req.on('end', () => { try { resolve(s ? JSON.parse(s) : {}); } catch { reject(new Error('bad json')); } });
});
const validTz = (z) => { try { new Intl.DateTimeFormat('en', { timeZone: z }); return true; } catch { return false; } };

async function api(req, res, route) {
  const body = req.method === 'POST' ? await readBody(req) : {};

  if (route === 'vapid') return json(res, 200, { key: db.vapid.publicKey });

  if (route === 'login' && req.method === 'POST') {
    const ip = clientIp(req);
    const f = failures.get(ip);
    if (f && f.count >= 8 && f.until > Date.now()) return json(res, 429, { error: 'Too many attempts. Try again in a few minutes.' });
    const u = db.users[body.user];
    const ok = u && typeof body.password === 'string' &&
      crypto.timingSafeEqual(Buffer.from(hashPw(body.password, u.salt), 'hex'), Buffer.from(u.hash, 'hex'));
    if (!ok) {
      failures.set(ip, { count: (f && f.until > Date.now() ? f.count : 0) + 1, until: Date.now() + 5 * 60000 });
      return json(res, 401, { error: 'Wrong password' });
    }
    failures.delete(ip);
    const token = crypto.randomBytes(32).toString('hex');
    db.tokens[token] = { user: body.user, created: Date.now() };
    save();
    return json(res, 200, { token });
  }

  if (route === 'accounts') return json(res, 200, { accounts: Object.entries(db.users).map(([id, u]) => ({ id, name: u.name, role: u.role })) });

  const user = authUser(req);
  if (!user) return json(res, 401, { error: 'Not logged in' });
  const isAdult = user.role === 'adult';

  switch (route) {
    case 'logout':
      delete db.tokens[user.token]; save();
      return json(res, 200, {});

    case 'state':
      return json(res, 200, stateFor(user));

    case 'start': {
      if (isAdult) return json(res, 403, { error: 'Only children can start' });
      if (activeSession(user.id)) return json(res, 409, { error: 'Already started' });
      const now = Date.now();
      db.sessions.push({ id: crypto.randomUUID(), child: user.id, start: now, end: null });
      const used = usedMs(user.id, now);
      const over = used >= limitMs();
      notify('adult', `${user.name} started`,
        `${user.name} started at ${fmtTime(now)}. Used today so far: ${fmtDur(used)} of ${db.settings.limitMin}m.` +
        (over ? ' Daily limit was already reached.' : ''), { type: 'start', child: user.id });
      save();
      return json(res, 200, stateFor(user));
    }

    case 'stop': {
      if (isAdult) return json(res, 403, { error: 'Only children can end' });
      const s = activeSession(user.id);
      if (!s) return json(res, 409, { error: 'Not started' });
      endSession(s, user, false);
      return json(res, 200, stateFor(user));
    }

    case 'adult-stop': {
      if (!isAdult) return json(res, 403, { error: 'Adult only' });
      const s = activeSession(body.child);
      if (!s) return json(res, 409, { error: 'Not running' });
      endSession(s, db.users[s.child], true);
      return json(res, 200, stateFor(user));
    }

    case 'push-subscribe':
      if (!body.subscription?.endpoint) return json(res, 400, { error: 'Bad subscription' });
      db.subs[user.id] = (db.subs[user.id] || []).filter((s) => s.endpoint !== body.subscription.endpoint);
      db.subs[user.id].push(body.subscription);
      save();
      return json(res, 200, {});

    case 'push-unsubscribe':
      db.subs[user.id] = (db.subs[user.id] || []).filter((s) => s.endpoint !== body.endpoint);
      save();
      return json(res, 200, {});

    case 'settings': {
      if (!isAdult) return json(res, 403, { error: 'Adult only' });
      if (body.limitMin !== undefined) {
        const n = Math.round(Number(body.limitMin));
        if (!(n >= 1 && n <= 1440)) return json(res, 400, { error: 'Limit must be 1-1440 minutes' });
        db.settings.limitMin = n;
      }
      if (body.tz !== undefined) {
        if (!validTz(body.tz)) return json(res, 400, { error: 'Unknown timezone' });
        db.settings.tz = body.tz;
      }
      for (const [id, name] of Object.entries(body.names || {})) {
        if (db.users[id] && String(name).trim()) db.users[id].name = String(name).trim().slice(0, 30);
      }
      for (const [id, pw] of Object.entries(body.passwords || {})) {
        if (!db.users[id] || !pw) continue;
        if (String(pw).length < 4) return json(res, 400, { error: 'Passwords need at least 4 characters' });
        Object.assign(db.users[id], makeCred(pw));
        for (const [t, v] of Object.entries(db.tokens)) if (v.user === id && t !== user.token) delete db.tokens[t];
      }
      save();
      return json(res, 200, stateFor(db.users[user.id] && { id: user.id, ...db.users[user.id] }));
    }
  }
  return json(res, 404, { error: 'Not found' });
}

function endSession(s, childUser, byAdult) {
  const now = Date.now();
  s.end = now;
  const used = usedMs(s.child, now);
  const lim = limitMs();
  const name = db.users[s.child].name;
  let msg = `${name} ended at ${fmtTime(now)}${byAdult ? ' (ended by parent)' : ''}. Session: ${fmtDur(now - s.start)}. Today: ${fmtDur(used)} of ${db.settings.limitMin}m.`;
  if (used > lim) {
    msg += ` Over the limit by ${fmtDur(used - lim)}.`;
    const key = `${s.child}:${dayKey(now)}`;
    if (!db.limitAlerts[key]) {
      db.limitAlerts[key] = now;
      notify('adult', `${name} went over the limit`, `${name} used ${fmtDur(used)} today, over the ${db.settings.limitMin}m allowance.`, { type: 'limit', child: s.child });
    }
  }
  notify('adult', `${name} finished`, msg, { type: 'end', child: s.child });
  save();
}

// ---------- static files ----------
const MIME = {
  '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8',
  '.json': 'application/json', '.webmanifest': 'application/manifest+json', '.png': 'image/png', '.svg': 'image/svg+xml',
};

function serveStatic(req, res, pathname) {
  let file = path.normalize(path.join(PUBLIC_DIR, pathname === '/' ? 'index.html' : pathname));
  if (!file.startsWith(PUBLIC_DIR) || !fs.existsSync(file) || fs.statSync(file).isDirectory()) file = path.join(PUBLIC_DIR, 'index.html');
  const ext = path.extname(file);
  res.writeHead(200, {
    'Content-Type': MIME[ext] || 'application/octet-stream',
    'Cache-Control': 'no-cache',
    'X-Content-Type-Options': 'nosniff',
  });
  fs.createReadStream(file).pipe(res);
}

http.createServer(async (req, res) => {
  const { pathname } = new URL(req.url, 'http://x');
  try {
    if (pathname.startsWith('/api/')) await api(req, res, pathname.slice(5));
    else serveStatic(req, res, pathname);
  } catch (e) {
    if (!res.headersSent) json(res, 400, { error: e.message });
  }
}).listen(PORT, () => console.log(`Screen-time app on http://localhost:${PORT}`));
