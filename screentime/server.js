// Local / VPS server: static files + the same API handler the Vercel function uses.
// Because there is no always-on timer on serverless, limit checks also run here every 10s.
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { handleApi } from './lib/app.js';

const PORT = Number(process.env.PORT) || 3000;
const PUBLIC_DIR = path.join(import.meta.dirname, 'public');
const MIME = {
  '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8',
  '.json': 'application/json', '.webmanifest': 'application/manifest+json', '.png': 'image/png', '.svg': 'image/svg+xml',
};

http.createServer((req, res) => {
  const { pathname } = new URL(req.url, 'http://x');
  if (pathname.startsWith('/api/')) return handleApi(req, res);
  let file = path.normalize(path.join(PUBLIC_DIR, pathname === '/' ? 'index.html' : pathname));
  if (!file.startsWith(PUBLIC_DIR) || !fs.existsSync(file) || fs.statSync(file).isDirectory()) file = path.join(PUBLIC_DIR, 'index.html');
  res.writeHead(200, { 'Content-Type': MIME[path.extname(file)] || 'application/octet-stream', 'Cache-Control': 'no-cache', 'X-Content-Type-Options': 'nosniff' });
  fs.createReadStream(file).pipe(res);
}).listen(PORT, () => console.log(`Screen-time app on http://localhost:${PORT}`));

if (process.env.CRON_SECRET) {
  setInterval(() => fetch(`http://localhost:${PORT}/api/cron`, { headers: { Authorization: `Bearer ${process.env.CRON_SECRET}` } }).catch(() => {}), 10000);
} else {
  console.log('Tip: set CRON_SECRET so the 90-minute limit check runs on a timer (it also runs whenever an app is open).');
}
