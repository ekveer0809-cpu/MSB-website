'use strict';

const $app = document.getElementById('app');
const store = {
  get: () => { try { return localStorage.getItem('st_token') || sessionStorage.getItem('st_token'); } catch { return null; } },
  set: (t, remember) => { try { localStorage.removeItem('st_token'); sessionStorage.removeItem('st_token'); (remember ? localStorage : sessionStorage).setItem('st_token', t); } catch { /* storage blocked */ } },
  clear: () => { try { localStorage.removeItem('st_token'); sessionStorage.removeItem('st_token'); } catch { /* ignore */ } },
};
let token = store.get();
let state = null;
let fetchedAt = 0;
let tab = 'overview';
let loginUser = null;

// ---------- helpers ----------
const esc = (s) => String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const pad = (n) => String(n).padStart(2, '0');
const hms = (ms) => { const s = Math.max(0, Math.floor(ms / 1000)); return `${pad(Math.floor(s / 3600))}:${pad(Math.floor(s / 60) % 60)}:${pad(s % 60)}`; };
const dur = (ms) => { const m = Math.round(ms / 60000); return m >= 60 ? `${Math.floor(m / 60)}h ${m % 60}m` : `${m}m`; };
const clock = (ms) => new Date(ms).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });
const dateLabel = (key) => {
  const [y, m, d] = key.split('-').map(Number);
  return new Date(y, m - 1, d).toLocaleDateString([], { weekday: 'short', day: 'numeric', month: 'short' });
};
const nowMs = () => state.now + (Date.now() - fetchedAt);

function toast(msg) {
  const t = document.getElementById('toast');
  t.textContent = msg;
  t.classList.add('show');
  clearTimeout(toast.t);
  toast.t = setTimeout(() => t.classList.remove('show'), 3000);
}

async function api(route, body) {
  const r = await fetch('/api/' + route, {
    method: body ? 'POST' : 'GET',
    headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: 'Bearer ' + token } : {}) },
    body: body ? JSON.stringify(body) : undefined,
  });
  const j = await r.json().catch(() => ({}));
  if (r.status === 401 && token && route !== 'login' && route !== 'setup') { signOutLocal(); throw new Error('Signed out'); }
  if (!r.ok) throw new Error(j.error || 'Something went wrong');
  return j;
}

function signOutLocal() {
  token = null; state = null;
  store.clear();
  render();
}

// ---------- push ----------
const pushSupported = 'serviceWorker' in navigator && 'PushManager' in window && 'Notification' in window;
const b64 = (s) => Uint8Array.from(atob(s.replace(/-/g, '+').replace(/_/g, '/').padEnd(Math.ceil(s.length / 4) * 4, '=')), (c) => c.charCodeAt(0));

async function enablePush() {
  try {
    if (await Notification.requestPermission() !== 'granted') return toast('Notifications were not allowed');
    const reg = await navigator.serviceWorker.ready;
    const { key } = await api('vapid');
    const sub = (await reg.pushManager.getSubscription()) ||
      (await reg.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: b64(key) }));
    await api('push-subscribe', { subscription: sub.toJSON() });
    toast('Notifications enabled on this device');
    render();
  } catch (e) { toast('Could not enable notifications: ' + e.message); }
}

async function syncPush() {
  // re-register this device's subscription for whoever is logged in
  if (!pushSupported || Notification.permission !== 'granted' || !token) return;
  try {
    const reg = await navigator.serviceWorker.ready;
    const sub = await reg.pushManager.getSubscription();
    if (sub) await api('push-subscribe', { subscription: sub.toJSON() });
  } catch { /* ignore */ }
}

function pushBanner() {
  if (!pushSupported) {
    return '<div class="banner">Notifications are not supported in this browser. On iPhone, tap Share → Add to Home Screen, then open the app from the home screen.</div>';
  }
  if (Notification.permission === 'granted') return '';
  if (Notification.permission === 'denied') return '<div class="banner">Notifications are blocked. Allow them in your browser/site settings.</div>';
  return '<div class="banner"><div class="row"><span>Turn on notifications on this device.</span><button class="small" data-act="push">Enable</button></div></div>';
}

// ---------- views ----------
async function renderLogin() {
  if (!loginUser) {
    $app.innerHTML = `<div class="home"><img src="/icons/icon-192.png" alt="" width="88" height="88">
      <h1>Screen Time</h1><p class="muted">Who are you?</p><div class="accts" id="accts"></div></div>`;
    try {
      const { accounts } = await api('accounts');
      document.getElementById('accts').innerHTML = accounts.map((a) =>
        `<button class="acct" data-act="pick" data-id="${a.id}" data-name="${esc(a.name)}" data-has="${a.hasPassword ? 1 : 0}">
          <span class="avatar ${a.role}">${esc(a.name.trim()[0] || '?').toUpperCase()}</span>
          <span>${esc(a.name)}<small>${a.role === 'adult' ? 'Adult' : 'Child'}${a.hasPassword ? '' : ' · tap to set up'}</small></span></button>`).join('');
    } catch (e) { document.getElementById('accts').textContent = e.message; }
    return;
  }
  const first = !loginUser.hasPassword;
  $app.innerHTML = `<div class="home"><h1>${first ? 'Welcome, ' : ''}${esc(loginUser.name)}</h1>
    <p class="muted">${first ? 'Choose a password for your account.' : 'Enter your password.'}</p></div>
    <form id="${first ? 'setup' : 'login'}" class="card">
    <label for="pw">${first ? 'New password' : 'Password'}</label>
    <input id="pw" type="password" autocomplete="${first ? 'new-password' : 'current-password'}" ${first ? 'minlength="4"' : ''} required>
    ${first ? '<label for="pw2">Confirm password</label><input id="pw2" type="password" autocomplete="new-password" required>' : ''}
    <label class="check"><input id="remember" type="checkbox" checked> Remember me on this device</label>
    <p class="err" id="err"></p>
    <div class="row"><button type="button" class="ghost" data-act="back">Back</button><button type="submit">${first ? 'Save and continue' : 'Log in'}</button></div></form>`;
  document.getElementById('pw').focus();
}

function limitBar(used) {
  const lim = state.limitMin * 60000;
  const pct = Math.min(100, (used / lim) * 100);
  const cls = used >= lim ? 'over' : pct >= 80 ? 'warn' : '';
  return { pct, cls };
}

function renderChild() {
  const a = state.active;
  $app.innerHTML = `
    <div class="top"><div><h1 style="margin:0">Hi ${esc(state.me.name)}</h1><div class="muted">Allowance today: ${state.limitMin} min</div></div>
    <button class="ghost small" data-act="logout">Log out</button></div>
    ${pushBanner()}
    <div class="card">
      <div class="muted" style="text-align:center">${a ? 'Time left today' : 'Time left today'}</div>
      <div class="timer live" data-f="remain">--:--:--</div>
      <div class="bar"><i class="live" data-f="bar"></i></div>
      <div class="row muted"><span>Used: <b class="live" data-f="used"></b></span><span>${a ? 'Started ' + clock(a.start) : 'Not running'}</span></div>
    </div>
    <button class="big ${a ? 'stop' : 'go'}" data-act="${a ? 'stop' : 'start'}">${a ? 'End' : 'Start'}</button>
    <div class="card"><h2>My log</h2>${daysHtml(state.days)}</div>`;
}

function daysHtml(days) {
  if (!days.length) return '<p class="muted">Nothing logged yet.</p>';
  return days.map((d) => `<div class="day"><div class="row"><b>${dateLabel(d.date)}</b><b>${dur(d.total)}</b></div>
    ${d.sessions.map((s) => `<div class="sess"><span>${clock(s.start)} → ${s.end ? clock(s.end) : '<i>running</i>'}</span><span>${s.end ? dur(s.end - s.start) : ''}</span></div>`).join('')}</div>`).join('');
}

function renderAdult() {
  const tabs = [['overview', 'Today'], ['logs', 'Logs'], ['alerts', 'Alerts'], ['settings', 'Settings']];
  let body = '';
  if (tab === 'overview') {
    body = `<div class="card stat"><span class="muted">Total today, all children</span><b class="live" data-f="combined"></b></div>` +
      state.children.map((c) => `<div class="card">
        <div class="row"><h2 style="margin:0">${esc(c.name)}</h2><span class="chip ${c.active ? 'on' : ''}">${c.active ? 'Active since ' + clock(c.active.start) : 'Not active'}</span></div>
        <div class="row" style="margin-top:8px"><span>Used today</span><b class="live" data-f="used" data-c="${c.id}"></b></div>
        <div class="bar"><i class="live" data-f="bar" data-c="${c.id}"></i></div>
        <div class="row muted"><span class="live" data-f="left" data-c="${c.id}"></span>${c.active ? `<button class="small danger" data-act="force" data-id="${c.id}">End now</button>` : ''}</div>
      </div>`).join('');
  } else if (tab === 'logs') {
    body = state.children.map((c) => `<div class="card"><h2>${esc(c.name)}</h2>${daysHtml(c.days)}</div>`).join('');
  } else if (tab === 'alerts') {
    body = `<div class="card">${state.alerts.length ? state.alerts.map((a) => `<div class="alert ${a.type}"><div class="row"><b>${esc(a.title)}</b><span class="muted">${new Date(a.ts).toLocaleString([], { day: 'numeric', month: 'short', hour: 'numeric', minute: '2-digit' })}</span></div><div class="muted">${esc(a.body)}</div></div>`).join('') : '<p class="muted">No alerts yet.</p>'}</div>`;
  } else {
    const kids = state.children;
    body = `<form id="settings" class="card"><h2>Settings</h2>
      <label>Daily limit per child (minutes)</label><input name="limit" type="number" min="1" max="1440" value="${state.limitMin}">
      <label>Timezone (days reset at midnight here)</label><input name="tz" value="${esc(state.tz)}">
      ${kids.map((c) => `<label>Name for ${esc(c.id)}</label><input name="name_${c.id}" value="${esc(c.name)}">`).join('')}
      <h2 style="margin-top:20px">Change passwords</h2><p class="muted">Leave blank to keep the current one.</p>
      <label>Adult password</label><input name="pw_adult" type="password" autocomplete="new-password">
      ${kids.map((c) => `<label>${esc(c.name)} password</label><input name="pw_${c.id}" type="password" autocomplete="new-password">`).join('')}
      <p class="err" id="err"></p><button type="submit" style="width:100%">Save</button></form>`;
  }
  $app.innerHTML = `<div class="top"><h1 style="margin:0">${esc(state.me.name)}</h1><button class="ghost small" data-act="logout">Log out</button></div>
    ${pushBanner()}
    <div class="tabs">${tabs.map(([k, l]) => `<button class="${tab === k ? 'on' : ''}" data-act="tab" data-id="${k}">${l}</button>`).join('')}</div>${body}`;
}

function render() {
  if (!token || !state) return renderLogin();
  if (state.me.role === 'child') renderChild(); else renderAdult();
  tick();
}

// live-updating numbers without re-rendering (keeps buttons/inputs stable)
function tick() {
  if (!state) return;
  const now = nowMs();
  const live = (o) => o.used + (o.active ? now - state.now : 0);
  const lim = state.limitMin * 60000;
  const setBar = (el, used) => { const b = limitBar(used); el.style.width = b.pct + '%'; el.className = 'live ' + b.cls; };
  document.querySelectorAll('.live').forEach((el) => {
    const f = el.dataset.f;
    if (state.me.role === 'child') {
      const used = live(state);
      if (f === 'remain') { el.textContent = used >= lim ? 'Time is up' : hms(lim - used); el.style.color = used >= lim ? 'var(--bad)' : ''; }
      if (f === 'used') el.textContent = dur(used);
      if (f === 'bar') setBar(el, used);
    } else if (f === 'combined') {
      el.textContent = dur(state.children.reduce((n, c) => n + live(c), 0));
    } else {
      const c = state.children.find((x) => x.id === el.dataset.c);
      if (!c) return;
      const used = live(c);
      if (f === 'used') el.textContent = `${dur(used)} / ${state.limitMin}m`;
      if (f === 'bar') setBar(el, used);
      if (f === 'left') el.textContent = used >= lim ? `Over by ${dur(used - lim)}` : `${dur(lim - used)} left`;
    }
  });
}

// ---------- data flow ----------
async function refresh() {
  if (!token) return;
  try {
    state = await api('state');
    fetchedAt = Date.now();
    if (state.me.role === 'adult' && state.tzUnset) {
      api('settings', { tz: Intl.DateTimeFormat().resolvedOptions().timeZone }).catch(() => {});
    }
    // don't rebuild the form while the adult is typing in it
    if (!(tab === 'settings' && state.me.role === 'adult' && document.getElementById('settings'))) render();
  } catch (e) { /* offline or signed out: keep what we have */ }
}

document.addEventListener('click', async (ev) => {
  const el = ev.target.closest('[data-act]');
  if (!el) return;
  const act = el.dataset.act;
  try {
    if (act === 'pick') {
      loginUser = { id: el.dataset.id, name: el.dataset.name, hasPassword: el.dataset.has === '1' };
      render();
    } else if (act === 'back') { loginUser = null; render(); }
    else if (act === 'logout') { try { await api('logout', {}); } catch { /* ignore */ } loginUser = null; signOutLocal(); }
    else if (act === 'push') enablePush();
    else if (act === 'tab') { tab = el.dataset.id; render(); }
    else if (act === 'start' || act === 'stop') {
      el.disabled = true;
      state = await api(act, {}); fetchedAt = Date.now(); render();
      toast(act === 'start' ? 'Started. Your parent was notified.' : 'Ended. Your parent was notified.');
    } else if (act === 'force') {
      if (!confirm('End this session now?')) return;
      state = await api('adult-stop', { child: el.dataset.id }); fetchedAt = Date.now(); render();
    }
  } catch (e) { toast(e.message); refresh(); }
});

document.addEventListener('submit', async (ev) => {
  ev.preventDefault();
  const f = ev.target;
  const err = document.getElementById('err');
  try {
    if (f.id === 'login' || f.id === 'setup') {
      const pw = f.querySelector('#pw').value;
      if (f.id === 'setup' && pw !== f.querySelector('#pw2').value) throw new Error('Passwords do not match');
      const remember = f.querySelector('#remember').checked;
      const { token: t } = await api(f.id, { user: loginUser.id, password: pw, remember });
      token = t; store.set(t, remember); loginUser = null;
      await refresh(); syncPush();
    } else if (f.id === 'settings') {
      const v = (n) => f.elements[n].value;
      const names = {}, passwords = {};
      for (const c of state.children) { names[c.id] = v('name_' + c.id); if (v('pw_' + c.id)) passwords[c.id] = v('pw_' + c.id); }
      if (v('pw_adult')) passwords.adult = v('pw_adult');
      state = await api('settings', { limitMin: v('limit'), tz: v('tz'), names, passwords });
      fetchedAt = Date.now();
      toast('Saved');
      tab = 'overview'; render();
    }
  } catch (e) { if (err) err.textContent = e.message; else toast(e.message); }
});

// ---------- boot ----------
if ('serviceWorker' in navigator) navigator.serviceWorker.register('/sw.js').catch(() => {});
render();
if (token) { refresh(); syncPush(); }
setInterval(tick, 1000);
setInterval(refresh, 5000);
document.addEventListener('visibilitychange', () => { if (!document.hidden) refresh(); });
