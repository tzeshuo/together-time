// TogetherTime server: static files + WebSocket room/state authority.
// Rooms live in memory (lost on restart). The server stores only playback metadata, never video.
const http = require('http'), fs = require('fs'), path = require('path'), crypto = require('crypto');
const { WebSocketServer } = require('ws');

const PORT = process.env.PORT || 3000;
const TTL = (+process.env.ROOM_TTL_HOURS || 12) * 3600e3;
const ORIGINS = (process.env.ALLOWED_ORIGINS || '').split(',').map(s => s.trim()).filter(Boolean);
const MAX_MEMBERS = 4, PUB = path.join(__dirname, 'public');
const ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
const EMOJI = new Set(['❤️', '😂', '😮', '😢', '👏']);
const MIME = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8' };
const rooms = new Map();

const server = http.createServer((req, res) => {
  let p = req.url.split('?')[0];
  if (p === '/healthz') return res.end('ok');
  if (p === '/' || p.startsWith('/r/')) p = '/index.html';
  const f = path.join(PUB, path.normalize(p));
  if (!f.startsWith(PUB)) { res.writeHead(403); return res.end(); }
  fs.readFile(f, (err, data) => {
    if (err) { res.writeHead(404); return res.end('Not found'); }
    res.writeHead(200, { 'Content-Type': MIME[path.extname(f)] || 'application/octet-stream',
      'X-Content-Type-Options': 'nosniff', 'Referrer-Policy': 'no-referrer' });
    res.end(data);
  });
});

function newRoom() {
  let code; do { code = Array.from({ length: 8 }, () => ALPHABET[crypto.randomInt(32)]).join(''); } while (rooms.has(code));
  const r = { code, created: Date.now(), emptySince: null, members: new Map(),
    state: { url: '', position: 0, playing: false, rate: 1, updatedAt: Date.now(), version: 0 } };
  rooms.set(code, r); return r;
}
const people = r => [...r.members].map(([id, m]) => ({ id, name: m.name, online: !!m.ws }));
const online = r => [...r.members.values()].some(m => m.ws);
function broadcast(r, msg) {
  const s = JSON.stringify(msg);
  for (const m of r.members.values()) if (m.ws && m.ws.readyState === 1) m.ws.send(s);
}
const presence = r => broadcast(r, { type: 'presence', people: people(r) });
function validUrl(u) {
  if (typeof u !== 'string' || u.length > 2048) return false;
  try { return ['http:', 'https:'].includes(new URL(u).protocol); } catch { return false; }
}

const wss = new WebSocketServer({ server, path: '/ws', maxPayload: 16 * 1024 });
wss.on('connection', (ws, req) => {
  const origin = req.headers.origin;
  if (origin && !origin.startsWith('chrome-extension://') && (ORIGINS.length ? !ORIGINS.includes(origin) : new URL(origin).host !== req.headers.host)) return ws.close(4003);
  ws.isAlive = true; ws.on('pong', () => (ws.isAlive = true));
  let room = null, me = null, count = 0, windowStart = Date.now();
  const send = o => ws.readyState === 1 && ws.send(JSON.stringify(o));

  ws.on('message', raw => {
    if (Date.now() - windowStart > 1000) { windowStart = Date.now(); count = 0; }
    if (++count > 30) return;
    let m; try { m = JSON.parse(raw); } catch { return; }
    if (m.type === 'ping') return send({ type: 'pong', t0: m.t0, now: Date.now() });

    if (m.type === 'join') {
      const clientId = String(m.clientId || '').slice(0, 64); if (!clientId) return;
      const name = String(m.name || '').trim().slice(0, 24) || 'Guest';
      const r = m.create ? newRoom() : rooms.get(String(m.room || '').toUpperCase());
      if (!r) return send({ type: 'error', code: 'room-not-found' });
      let mem = r.members.get(clientId);
      if (!mem && r.members.size >= MAX_MEMBERS) return send({ type: 'error', code: 'room-full' });
      if (mem && mem.ws && mem.ws !== ws) try { mem.ws.close(4000); } catch {}
      mem = mem || {}; mem.name = name; mem.ws = ws; r.members.set(clientId, mem); r.emptySince = null;
      room = r; me = clientId;
      send({ type: 'joined', room: r.code, you: clientId, state: r.state, people: people(r) });
      return presence(r);
    }
    if (!room) return;

    if (m.type === 'action') {
      const s = room.state, pos = Number.isFinite(m.position) ? Math.max(0, Math.min(m.position, 1e6)) : s.position;
      if (m.action === 'load') {
        if (!validUrl(m.url)) return send({ type: 'error', code: 'bad-url' });
        Object.assign(s, { url: m.url, position: 0, playing: false, rate: 1 });
      } else if (m.action === 'play') { if (s.playing) return; Object.assign(s, { position: pos, playing: true });
      } else if (m.action === 'pause') { if (!s.playing) return; Object.assign(s, { position: pos, playing: false });
      } else if (m.action === 'seek') { s.position = pos;
      } else if (m.action === 'rate' && [0.5, 0.75, 1, 1.25, 1.5, 2].includes(m.rate)) {
        s.rate = m.rate; s.position = pos;
      } else return;
      s.updatedAt = Date.now(); s.version++;           // server arrival order = authoritative order
      return broadcast(room, { type: 'state', state: s, by: me });
    }
    if (m.type === 'chat') {
      const text = String(m.text || '').trim().slice(0, 500); if (!text) return;
      return broadcast(room, { type: 'chat', from: room.members.get(me).name, id: me, text, at: Date.now() });
    }
    if (m.type === 'react' && EMOJI.has(m.emoji)) return broadcast(room, { type: 'react', emoji: m.emoji });
    if (m.type === 'leave') {
      room.members.delete(me);
      if (!room.members.size) rooms.delete(room.code); else presence(room);
      room = null; ws.close(1000);
    }
  });
  ws.on('close', () => {
    if (!room || !me) return;
    const mem = room.members.get(me);
    if (mem && mem.ws === ws) { mem.ws = null; if (!online(room)) room.emptySince = Date.now(); presence(room); }
  });
});

setInterval(() => {                       // heartbeat + room cleanup
  wss.clients.forEach(ws => { if (!ws.isAlive) return ws.terminate(); ws.isAlive = false; ws.ping(); });
  const now = Date.now();
  for (const [c, r] of rooms) if ((r.emptySince && now - r.emptySince > TTL) || now - r.created > 7 * 24 * 3600e3) rooms.delete(c);
}, 30000);

server.listen(PORT, () => console.log(`TogetherTime running on http://localhost:${PORT}`));
