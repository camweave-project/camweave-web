import http from 'node:http';
import https from 'node:https';
import {lookup} from 'node:dns/promises';
import {isIP} from 'node:net';
import {randomBytes, randomUUID, scryptSync, timingSafeEqual} from 'node:crypto';
import {readFile, mkdir, writeFile, rename} from 'node:fs/promises';
import {resolve, dirname} from 'node:path';
import {fileURLToPath} from 'node:url';

const root = dirname(fileURLToPath(import.meta.url));
const fail = (status, message) => Object.assign(new Error(message), {status});
export function cameraURL(value, hosts) {
  let u;
  try { u = new URL(value); } catch { throw fail(400, 'Paste the complete viewing link from CamWeave Camera.'); }
  if (!['http:', 'https:'].includes(u.protocol) || u.username || u.password || u.search || u.hash ||
      !/^\/watch\/[A-Za-z0-9_-]{5,128}\/?$/.test(u.pathname)) throw fail(400, 'Use a complete http(s) camera viewing link.');
  if (!hosts.has(u.hostname.toLowerCase())) throw fail(400, 'This camera host is not allowed. Add it to CAMERA_HOSTS on your server and restart.');
  u.pathname = u.pathname.replace(/\/?$/, '/');
  return u.href;
}
export function blockedAddress(ip) {
  // Never allow cloud instance metadata, unspecified, multicast or link-local destinations.
  if (ip.includes(':')) {
    const s = ip.toLowerCase();
    if (s.startsWith('::ffff:')) return true;
    return s === '::' || s.startsWith('fe8') || s.startsWith('fe9') || s.startsWith('fea') || s.startsWith('feb') || s.startsWith('ff');
  }
  const [a, b] = ip.split('.').map(Number);
  return a === 0 || a === 169 && b === 254 || a >= 224 || ip === '100.100.100.200';
}
async function body(req) {
  if (!(req.headers['content-type'] || '').startsWith('application/json')) throw fail(415, 'JSON required.');
  let size = 0; const chunks = [];
  for await (const chunk of req) { size += chunk.length; if (size > 8192) throw fail(413, 'Request too large.'); chunks.push(chunk); }
  try { return JSON.parse(Buffer.concat(chunks).toString()); } catch { throw fail(400, 'Invalid JSON.'); }
}
export async function createApp(options) {
  const origin = new URL(options.publicURL).origin;
  const hosts = new Set(options.cameraHosts.map(h => h.trim().toLowerCase()).filter(Boolean));
  if (!options.password || options.password.length < 16 || options.password === 'replace-with-a-new-random-password') throw Error('Set ADMIN_PASSWORD to a unique password of at least 16 characters.');
  if (!['http:', 'https:'].includes(new URL(origin).protocol)) throw Error('PUBLIC_URL must use HTTP or HTTPS.');
  const salt = randomBytes(32), passwordHash = scryptSync(options.password, salt, 32);
  const file = resolve(options.dataDir, 'cameras.json');
  await mkdir(dirname(file), {recursive: true, mode: 0o700});
  let cameras = [];
  try {
    cameras = JSON.parse(await readFile(file, 'utf8'));
    if (!Array.isArray(cameras) || cameras.length > 100 || cameras.some(c => typeof c.id !== 'string' || typeof c.name !== 'string' || typeof c.url !== 'string')) throw Error('Invalid camera storage');
  } catch (e) { if (e.code !== 'ENOENT') throw Error('Cannot read camera storage. Fix or restore it before starting.'); }
  let writes = Promise.resolve();
  const mutate = operation => {
    const next = writes.then(async () => {
      const updated = operation(cameras);
      const tmp = file + '.tmp';
      await writeFile(tmp, JSON.stringify(updated), {mode: 0o600}); await rename(tmp, file); cameras = updated;
    });
    writes = next.catch(() => {}); return next;
  };
  const sessions = new Map(), attempts = new Map();
  const json = (res, status, data) => { res.writeHead(status, {'Content-Type': 'application/json'}); res.end(JSON.stringify(data)); };
  function session(req) {
    const token = (req.headers.cookie || '').split(';').map(s => s.trim()).find(s => s.startsWith('camweave='))?.slice(9);
    const s = sessions.get(token);
    if (!s || s.expires < Date.now()) throw fail(401, 'Please sign in.');
    return [token, s];
  }
  async function upstream(camera, endpoint, query, method, signal) {
    const u = new URL(endpoint, cameraURL(camera.url, hosts));
    u.search = new URLSearchParams(query || {}).toString();
    const hostname = u.hostname.replace(/^\[|\]$/g, '');
    const addresses = isIP(hostname) ? [{address: hostname, family: isIP(hostname)}] : await lookup(hostname, {all: true});
    if (!addresses.length || addresses.some(a => blockedAddress(a.address))) throw fail(400, 'Camera address is not permitted.');
    const target = addresses[0];
    return await new Promise((resolveResponse, reject) => {
      const request = (u.protocol === 'https:' ? https : http).request(u, {
        method, signal, headers: {'X-Camera-Control': '1'},
        lookup: (_h, opts, cb) => opts.all ? cb(null, [target]) : cb(null, target.address, target.family)
      }, resolveResponse);
      request.setTimeout(12000, () => request.destroy(Error('Camera timed out')));
      request.once('error', reject); request.end();
    });
  }
  const server = http.createServer(async (req, res) => {
    res.setHeader('Cache-Control', 'no-store'); res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('Referrer-Policy', 'no-referrer'); res.setHeader('X-Frame-Options', 'DENY');
    res.setHeader('Content-Security-Policy', "default-src 'self'; img-src 'self'; style-src 'self'; script-src 'self'; connect-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'self'");
    try {
      if (req.headers.host !== new URL(origin).host) throw fail(403, 'Use the configured PUBLIC_URL.');
      const url = new URL(req.url, origin), path = url.pathname;
      if (!['GET', 'POST', 'DELETE'].includes(req.method)) throw fail(405, 'Method not allowed.');
      if (req.method !== 'GET' && (req.headers.origin !== origin || req.headers['x-camweave-control'] !== '1')) throw fail(403, 'Same-origin request required.');
      if (req.method === 'GET' && ['/', '/app.js', '/style.css'].includes(path)) {
        const asset = path === '/' ? 'index.html' : path.slice(1);
        res.setHeader('Content-Type', asset.endsWith('.html') ? 'text/html; charset=utf-8' : asset.endsWith('.js') ? 'text/javascript; charset=utf-8' : 'text/css; charset=utf-8');
        return res.end(await readFile(resolve(root, 'public', asset)));
      }
      if (path === '/api/login' && req.method === 'POST') {
        const key = req.socket.remoteAddress, now = Date.now();
        const attempt = attempts.get(key) || {count: 0, until: now + 60000};
        if (attempt.until < now) { attempt.count = 0; attempt.until = now + 60000; }
        attempt.count++; attempts.set(key, attempt);
        if (attempt.count > 5) throw fail(429, 'Too many attempts. Wait a minute.');
        const input = await body(req);
        if (typeof input.password !== 'string' || input.password.length > 1024 || !timingSafeEqual(scryptSync(input.password, salt, 32), passwordHash)) throw fail(401, 'Incorrect password.');
        const token = randomBytes(32).toString('hex');
        if (sessions.size >= 32) throw fail(429, 'Too many sessions. Try again later.');
        sessions.set(token, {expires: now + 12 * 3600000, streams: new Set()});
        res.setHeader('Set-Cookie', `camweave=${token}; HttpOnly; SameSite=Strict; Path=/; Max-Age=43200${origin.startsWith('https:') ? '; Secure' : ''}`);
        return json(res, 200, {ok: true});
      }
      const [token, auth] = session(req);
      if (path === '/api/logout' && req.method === 'POST') {
        auth.streams.forEach(c => c.abort()); sessions.delete(token);
        res.setHeader('Set-Cookie', 'camweave=; HttpOnly; SameSite=Strict; Path=/; Max-Age=0'); return json(res, 200, {ok: true});
      }
      if (path === '/api/cameras' && req.method === 'GET') return json(res, 200, cameras.map(({id, name, url}) => ({id, name, host: new URL(url).host})));
      if (path === '/api/cameras' && req.method === 'POST') {
        const input = await body(req);
        if (typeof input.name !== 'string' || !input.name.trim() || input.name.trim().length > 60) throw fail(400, 'Use a camera name of 1–60 characters.');
        const url = cameraURL(input.url, hosts), id = randomUUID();
        await mutate(current => {
          if (current.length >= 100) throw fail(400, 'Up to 100 saved cameras are supported.');
          if (current.some(c => c.url === url)) throw fail(409, 'This camera is already saved.');
          return [...current, {id, name: input.name.trim(), url}];
        }); return json(res, 201, {id});
      }
      const match = path.match(/^\/api\/cameras\/([a-f0-9-]+)(?:\/(status|stream|settings|exposure))?$/);
      if (!match) throw fail(404, 'Not found.');
      const camera = cameras.find(c => c.id === match[1]); if (!camera) throw fail(404, 'Camera not found.');
      if (!match[2] && req.method === 'DELETE') { await mutate(current => current.filter(c => c.id !== camera.id)); return json(res, 200, {ok: true}); }
      const endpoint = match[2];
      if (!(req.method === 'GET' && ['status', 'stream'].includes(endpoint) || req.method === 'POST' && ['settings', 'exposure'].includes(endpoint))) throw fail(405, 'Method not allowed.');
      let query;
      if (req.method === 'POST') {
        const input = await body(req);
        if (endpoint === 'settings') {
          if (![720, 1080].includes(input.quality) || ![5, 10, 15].includes(input.fps)) throw fail(400, 'Invalid quality or frame rate.');
          query = {quality: input.quality, fps: input.fps};
        } else {
          if (!['auto', 'manual'].includes(input.mode) || input.mode === 'manual' && (!Number.isFinite(input.iso) || input.iso <= 0 || input.iso > 10000000)) throw fail(400, 'Invalid ISO.');
          query = input.mode === 'auto' ? {mode: 'auto'} : {mode: 'manual', iso: input.iso};
        }
      }
      if (endpoint === 'stream' && auth.streams.size >= 4) throw fail(429, 'Up to four live views per session.');
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), endpoint === 'stream' ? 60000 : 12000);
      if (endpoint === 'stream') auth.streams.add(controller);
      res.once('close', () => controller.abort());
      try {
        const incoming = await upstream(camera, endpoint, query, req.method, controller.signal);
        if (incoming.statusCode !== (req.method === 'POST' ? 202 : 200)) {
          incoming.destroy(); throw fail(502, 'Camera refused the request. Check its viewing link and connection.');
        }
        if (endpoint === 'stream') {
          const type = incoming.headers['content-type'] || '';
          if (!type.toLowerCase().startsWith('multipart/x-mixed-replace')) { incoming.destroy(); throw fail(502, 'Camera did not return a video stream.'); }
          res.writeHead(200, {'Content-Type': type});
          await new Promise(done => { incoming.once('error', () => { res.destroy(); done(); }); incoming.once('end', done); res.once('close', done); incoming.pipe(res); });
        } else {
          const chunks = []; let size = 0;
          for await (const chunk of incoming) { size += chunk.length; if (size > 65536) { incoming.destroy(); throw fail(502, 'Camera response too large.'); } chunks.push(chunk); }
          const data = endpoint === 'status' ? JSON.parse(Buffer.concat(chunks).toString()) : {};
          // Forward only documented fields, never arbitrary camera response content.
          json(res, req.method === 'POST' ? 202 : 200, endpoint === 'status' ? {quality: data.quality, fps: data.fps, exposure: data.exposure} : {accepted: true});
        }
      } finally { clearTimeout(timer); auth.streams.delete(controller); controller.abort(); }
    } catch (e) {
      if (res.headersSent) res.destroy();
      else json(res, e.status || 502, {error: e.status ? e.message : 'Cannot reach the camera or save changes. Check the server network and storage.'});
    }
  });
  server.requestTimeout = 15000; server.headersTimeout = 10000;
  const cleanup = setInterval(() => {
    for (const [key, value] of sessions) if (value.expires < Date.now()) { value.streams.forEach(c => c.abort()); sessions.delete(key); }
    for (const [key, value] of attempts) if (value.until < Date.now()) attempts.delete(key);
  }, 30000); cleanup.unref();
  server.on('close', () => { clearInterval(cleanup); sessions.forEach(s => s.streams.forEach(c => c.abort())); });
  return server;
}
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const port = Number(process.env.PORT || 8080), host = process.env.HOST || '127.0.0.1';
  const publicURL = process.env.PUBLIC_URL || `http://127.0.0.1:${port}`;
  createApp({password: process.env.ADMIN_PASSWORD, publicURL, cameraHosts: (process.env.CAMERA_HOSTS || '').split(','), dataDir: process.env.DATA_DIR || './data'})
    .then(server => server.listen(port, host, () => console.log(`CamWeave Web listening at ${publicURL}. Camera links are stored only on this server.`)))
    .catch(error => { console.error(error.message); process.exitCode = 1; });
}
