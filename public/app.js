// TogetherTime client. All playback is driven by the server's shared state:
// controls only SEND actions; every device (including the sender) applies the broadcast state.
// That removes echo/feedback loops by design.
const $ = s => document.querySelector(s);
const cid = localStorage.ttId || (localStorage.ttId = crypto.randomUUID());
let ws, code = null, me = null, people = [], state = null, player = null;
let offset = 0, bestRtt = Infinity, retry = 0, leaving = false, connected = false, mountId = 0, dragging = false, pt;

const serverNow = () => Date.now() + offset;
const target = () => !state ? 0 : state.position + (state.playing ? (serverNow() - state.updatedAt) / 1000 * state.rate : 0);
const fmt = t => { t = Math.max(0, t | 0); const h = t / 3600 | 0, m = (t % 3600) / 60 | 0, s = t % 60; return (h ? h + ':' + String(m).padStart(2, '0') : m) + ':' + String(s).padStart(2, '0'); };
const send = o => ws && ws.readyState === 1 && ws.send(JSON.stringify(o));
const act = (action, extra = {}) => send({ type: 'action', action, ...extra });
function toast(t) { const e = $('#toast'); e.textContent = t; e.classList.add('show'); clearTimeout(toast.t); toast.t = setTimeout(() => e.classList.remove('show'), 3500); }
const loadScript = src => new Promise((res, rej) => { const s = document.createElement('script'); s.src = src; s.onload = res; s.onerror = () => rej(new Error('Could not load a required library. Check your connection.')); document.head.appendChild(s); });

/* ---------- connection ---------- */
function connect(first) {
  ws = new WebSocket((location.protocol === 'https:' ? 'wss://' : 'ws://') + location.host + '/ws');
  ws.onopen = () => { retry = 0; bestRtt = Infinity; send(first || { type: 'join', room: code, name: localStorage.ttName, clientId: cid }); ping(); };
  ws.onmessage = e => handle(JSON.parse(e.data));
  ws.onclose = () => { connected = false; if (leaving) return; if (code) setTimeout(() => connect(), Math.min(5000, 500 * 2 ** retry++)); else $('#home-msg').textContent = 'Could not reach the server. Try again.'; };
}
const ping = () => send({ type: 'ping', t0: Date.now() });
setInterval(ping, 5000);

function handle(m) {
  if (m.type === 'pong') { const rtt = Date.now() - m.t0; if (rtt <= bestRtt * 1.2 + 5) { bestRtt = Math.min(bestRtt, rtt); offset = m.now + rtt / 2 - Date.now(); } }
  else if (m.type === 'joined') {
    code = m.room; me = m.you; people = m.people; connected = true; leaving = false;
    history.replaceState(null, '', '/r/' + code); showRoom(); renderPeople(); applyState(m.state); nudgePeer();
  } else if (m.type === 'presence') { const was = !!peer(); people = m.people; renderPeople(); if (!was && peer()) nudgePeer(); }
  else if (m.type === 'state') applyState(m.state);
  else if (m.type === 'chat') addChat(m);
  else if (m.type === 'react') floatEmoji(m.emoji);
  else if (m.type === 'signal') onSignal(m);
  else if (m.type === 'error') {
    if (m.code === 'bad-url') toast('That doesn’t look like a valid web link (http or https).');
    else { code = null; leaving = true; ws.close(); goHome(m.code === 'room-full' ? 'That room is full.' : 'That room doesn’t exist or has expired.'); }
  }
}

/* ---------- shared state -> local player ---------- */
async function applyState(s) {
  if (state && s.version < state.version) return;
  const changed = !state || s.url !== state.url; state = s;
  if (changed) await mount(s.url);
  reconcile();
}
function reconcile() {
  if (!player || !state) return;
  if (player.rate() !== state.rate) player.setRate(state.rate);
  const t = target(), cur = player.time();
  if (state.playing) { if (!player.playing()) tryPlay(); if (Math.abs(cur - t) > 0.5) player.seek(t); }
  else { if (player.playing()) player.pause(); if (Math.abs(cur - state.position) > 0.3) player.seek(state.position); }
}
function tryPlay() {
  player.play(); clearTimeout(pt);
  pt = setTimeout(() => { if (player && state.playing && !player.playing() && !player.buffering()) $('#join').hidden = false; }, 1800);
}
setInterval(() => {                               // drift correction
  if (!player || !state || !state.playing || player.buffering()) return;
  const t = target(), d = player.time() - t, dur = player.dur();
  if (dur && t >= dur) return;
  if (!player.playing()) return tryPlay();
  const a = Math.abs(d);
  if (a > 1.2) player.seek(t);                     // large: hard resync
  else if (player.nudge) player.nudge(a > 0.25 ? (d > 0 ? 0.95 : 1.05) : 1); // small: gentle speed change
}, 1500);

/* ---------- providers ---------- */
const YT_RE = /(?:youtu\.be\/|youtube\.com\/(?:watch\?(?:.*&)?v=|embed\/|shorts\/|live\/))([\w-]{11})/;
const providers = [
  { test: u => YT_RE.test(u), level: 'full', label: 'YouTube: fully synchronized.', make: makeYT },
  { test: u => /\.m3u8(\?|#|$)/i.test(u), level: 'full', label: 'HLS stream: synchronized, if the source allows other sites to play it.', make: makeVideo },
  { test: u => /\.(mp4|webm|ogv|m4v|mov)(\?|#|$)/i.test(u), level: 'full', label: 'Video file: synchronized, if the source allows other sites to play it.', make: makeVideo },
  { test: () => true, level: 'manual', label: 'Web page: this site can’t be embedded or controlled, so only a shared clock is available (manual sync).', make: makeManual },
];

function loadYT() { return window.YT && YT.Player ? Promise.resolve() : new Promise((res, rej) => { window.onYouTubeIframeAPIReady = res; loadScript('https://www.youtube.com/iframe_api').catch(rej); }); }
const YT_ERR = { 2: 'This YouTube link is invalid.', 5: 'YouTube couldn’t play this video in the browser.', 100: 'This video is private, deleted or unavailable.', 101: 'The owner doesn’t allow this video to be embedded. Try another video.', 150: 'The owner doesn’t allow this video to be embedded. Try another video.' };
async function makeYT(el, url, onErr) {
  await loadYT();
  const holder = document.createElement('div'); el.append(holder);
  const p = await new Promise((res, rej) => {
    const y = new YT.Player(holder, { videoId: url.match(YT_RE)[1], playerVars: { controls: 0, disablekb: 1, rel: 0, fs: 0, playsinline: 1, modestbranding: 1 },
      events: { onReady: () => res(y), onError: e => { const msg = YT_ERR[e.data] || 'YouTube reported an error.'; rej(new Error(msg)); onErr(msg); } } });
  });
  return { time: () => p.getCurrentTime() || 0, dur: () => p.getDuration() || 0, playing: () => p.getPlayerState() === 1, buffering: () => p.getPlayerState() === 3,
    rate: () => p.getPlaybackRate(), setRate: r => p.setPlaybackRate(r), seek: t => p.seekTo(t, true), play: () => p.playVideo(), pause: () => p.pauseVideo(),
    vol: v => p.setVolume(v * 100), destroy: () => p.destroy() };
}
async function makeVideo(el, url, onErr) {
  const v = document.createElement('video'); v.playsInline = true; v.preload = 'auto'; el.append(v);
  let waiting = false, hls, rate = 1; const bad = 'This video couldn’t be played. The link may have expired, use an unsupported format, or block other websites from playing it.';
  v.onwaiting = () => (waiting = true); v.onplaying = v.oncanplay = () => (waiting = false); v.onerror = () => onErr(bad);
  if (location.protocol === 'https:' && url.startsWith('http:')) throw new Error('This link is not secure (http), so your browser blocks it here. Use an https link.');
  if (/\.m3u8/i.test(url) && !v.canPlayType('application/vnd.apple.mpegurl')) {
    await loadScript('https://cdn.jsdelivr.net/npm/hls.js@1.5.17/dist/hls.min.js');
    if (!Hls.isSupported()) throw new Error('This browser can’t play HLS streams.');
    hls = new Hls(); hls.on(Hls.Events.ERROR, (_, d) => d.fatal && onErr(bad)); hls.loadSource(url); hls.attachMedia(v);
  } else v.src = url;
  return { time: () => v.currentTime, dur: () => (isFinite(v.duration) ? v.duration : 0), playing: () => !v.paused && !v.ended && v.readyState > 2, buffering: () => waiting && !v.paused,
    rate: () => rate, setRate: r => { rate = r; v.playbackRate = r; }, nudge: f => (v.playbackRate = rate * f), seek: t => (v.currentTime = t),
    play: () => v.play().catch(() => {}), pause: () => v.pause(), vol: x => (v.volume = x), destroy: () => { hls && hls.destroy(); v.removeAttribute('src'); v.load(); v.remove(); } };
}
function makeManual(el, url) {
  let host = ''; try { host = new URL(url).hostname; } catch {}
  const card = document.createElement('div'); card.className = 'manual-card';
  const a = document.createElement('a'); a.href = url; a.target = '_blank'; a.rel = 'noopener noreferrer'; a.textContent = 'Open ' + host + ' in a new tab';
  const p = document.createElement('p'); p.textContent = 'TogetherTime can’t control this site. Each of you opens it in your own tab. When either of you presses play here, the shared clock starts, so press play in your tab at that moment. Pausing and seeking work the same way.';
  const c = document.createElement('div'); c.className = 'clock'; c.id = 'clock'; const s = document.createElement('div'); s.className = 'clock-state'; s.id = 'clock-state';
  card.append(c, s, p, a); el.append(card); $('#shield').hidden = true;
  return { manual: true, time: target, dur: () => 0, playing: () => state.playing, buffering: () => false, rate: () => state.rate, setRate() {}, seek() {}, play() {}, pause() {}, vol() {}, destroy: () => { $('#shield').hidden = false; } };
}

async function mount(url) {
  const id = ++mountId; clearTimeout(pt);
  if (player) { player.destroy(); player = null; }
  $('#player').innerHTML = ''; $('#stage-msg').hidden = true; $('#join').hidden = true; $('#empty').hidden = !!url; $('#shield').hidden = false;
  $('#support').textContent = ''; $('#support').className = 'support';
  if (!url) return;
  const d = providers.find(p => p.test(url));
  $('#support').textContent = d.label; $('#support').classList.toggle('manual', d.level === 'manual');
  try {
    const p = await d.make($('#player'), url, msg => id === mountId && showError(msg));
    if (id !== mountId) return p.destroy();
    player = p; p.vol(+$('#vol').value);
  } catch (e) { if (id === mountId) showError(e.message); }
}
function showError(msg) {
  const e = $('#stage-msg'); e.innerHTML = ''; const p = document.createElement('p'); p.textContent = msg; e.append(p); e.hidden = false;
}

/* ---------- UI ---------- */
function showRoom() { $('#home').hidden = true; $('#join-dialog').hidden = true; $('#room').hidden = false; }
function goHome(msg) {
  stopCams(); leaving = true; code = null; state = null; if (player) { player.destroy(); player = null; } $('#player').innerHTML = '';
  history.pushState(null, '', '/'); $('#room').hidden = true; $('#join-dialog').hidden = true; $('#home').hidden = false; $('#home-msg').textContent = msg || '';
}
function renderPeople() {
  const box = $('#people'); box.innerHTML = '';
  for (const p of people.filter(p => p.role !== 'ext')) { const c = document.createElement('span'); c.className = 'chip' + (p.online ? ' on' : ''); c.append(document.createElement('i'), p.name + (p.id === me ? ' (you)' : '') + (p.online ? '' : ' · away')); box.append(c); }
}
function addChat(m) {
  const d = document.createElement('div'); d.className = 'msg' + (m.id === me ? ' me' : ''); const b = document.createElement('b'); b.textContent = m.from + ' ';
  d.append(b, document.createTextNode(m.text)); const l = $('#log'); l.append(d); l.scrollTop = l.scrollHeight;
}
function floatEmoji(e) {
  const s = document.createElement('span'); s.className = 'float'; s.textContent = e; s.style.left = 10 + Math.random() * 80 + '%'; $('#reactions').append(s); setTimeout(() => s.remove(), 2500);
}
function setBadge(cls, text) { const b = $('#badge'); b.className = 'badge ' + cls; b.lastElementChild.textContent = text; }

setInterval(() => {                               // 4x/second UI refresh
  if (!state || $('#room').hidden) return;
  const others = people.filter(p => p.id !== me && p.online && p.role !== 'ext').length;
  const cur = player ? player.time() : target(), t = target(), dur = player ? player.dur() : 0;
  $('#pp').textContent = state.playing ? '❚❚' : '▶';
  if (!dragging) { $('#seek').max = dur || Math.max(t, 1); $('#seek').value = cur; $('#cur').textContent = fmt(cur); }
  $('#dur').textContent = dur ? fmt(dur) : '–:––'; $('#seek').disabled = !dur;
  if ($('#rate').value != state.rate) $('#rate').value = state.rate;
  if (player && player.playing()) $('#join').hidden = true;
  const clock = $('#clock'); if (clock) { clock.textContent = fmt(t); $('#clock-state').textContent = state.playing ? 'Playing: press play in your tab now' : 'Paused'; }
  if (!connected) setBadge('bad', 'Reconnecting…');
  else if (!state.url) setBadge(others ? 'ok' : 'warn', others ? 'Connected' : 'Waiting for your partner');
  else if (!player) setBadge('warn', 'Loading…');
  else if (player.manual) setBadge('warn', 'Manual sync (shared clock only)');
  else if (player.buffering()) setBadge('warn', 'Buffering…');
  else if (state.playing && Math.abs(player.time() - t) > 0.6) setBadge('warn', 'Catching up…');
  else setBadge(others ? 'ok' : 'warn', others ? 'In sync' : 'Waiting for your partner');
}, 250);
document.addEventListener('visibilitychange', () => !document.hidden && reconcile());

/* ---------- events ---------- */
function start(create, room) {
  const name = (create ? $('#name') : $('#invite-name')).value.trim(); if (!name) return;
  localStorage.ttName = name; leaving = false; code = create ? null : room;
  connect(create ? { type: 'join', create: true, name, clientId: cid } : { type: 'join', room, name, clientId: cid });
}
$('#create-form').onsubmit = e => { e.preventDefault(); start(true); };
$('#join-form').onsubmit = e => {
  e.preventDefault(); const c = $('#code').value.trim().toUpperCase().replace(/.*\/r\//i, '');
  if (!localStorage.ttName) { $('#home-msg').textContent = 'Enter your name first (top field), then join.'; return $('#name').focus(); }
  start(false, c);
};
$('#invite-form').onsubmit = e => { e.preventDefault(); start(false, $('#invite-code').textContent); };
$('#load-form').onsubmit = e => {
  e.preventDefault(); const u = $('#url').value.trim();
  try { if (!['http:', 'https:'].includes(new URL(u).protocol)) throw 0; } catch { return toast('Enter a full web link starting with http:// or https://'); }
  act('load', { url: u }); $('#url').value = '';
};
const clampT = t => Math.max(0, player && player.dur() ? Math.min(t, player.dur()) : t);
$('#pp').onclick = $('#shield').onclick = () => state && state.url && act(state.playing ? 'pause' : 'play', { position: target() });
$('#back').onclick = () => act('seek', { position: clampT(target() - 10) });
$('#fwd').onclick = () => act('seek', { position: clampT(target() + 10) });
$('#restart').onclick = () => act('seek', { position: 0 });
$('#seek').oninput = e => { dragging = true; $('#cur').textContent = fmt(+e.target.value); };
$('#seek').onchange = e => { dragging = false; act('seek', { position: +e.target.value }); };
$('#rate').onchange = e => act('rate', { rate: +e.target.value, position: target() });
$('#vol').oninput = e => { localStorage.ttVol = e.target.value; player && player.vol(+e.target.value); };
$('#vol').value = localStorage.ttVol || 1;
$('#join-btn').onclick = () => { $('#join').hidden = true; player && (player.play(), reconcile()); };
$('#fs').onclick = () => document.fullscreenElement ? document.exitFullscreen() : $('#stage').requestFullscreen().catch(() => toast('Full screen isn’t available here.'));
document.querySelectorAll('.rx button').forEach(b => (b.onclick = () => send({ type: 'react', emoji: b.dataset.e })));
$('#chat-form').onsubmit = e => { e.preventDefault(); const t = $('#msg').value.trim(); if (t) send({ type: 'chat', text: t }); $('#msg').value = ''; };
$('#chat-toggle').onclick = () => { const c = $('#chat').classList.toggle('closed'); $('#chat-toggle').setAttribute('aria-expanded', !c); };
$('#share').onclick = async () => { try { await navigator.clipboard.writeText(location.href); toast('Invite link copied. Send it to your partner.'); } catch { prompt('Copy this invite link:', location.href); } };
$('#leave').onclick = () => { send({ type: 'leave' }); goHome(); };
window.onkeydown = e => { if (/INPUT|SELECT|TEXTAREA/.test(e.target.tagName) || $('#room').hidden) return; if (e.key === ' ') { e.preventDefault(); $('#pp').click(); } if (e.key === 'ArrowLeft') $('#back').click(); if (e.key === 'ArrowRight') $('#fwd').click(); };

/* ---------- faces: WebRTC, peer to peer. The server only relays the handshake. ---------- */
const ICE = { iceServers: [{ urls: 'stun:stun.l.google.com:19302' }, { urls: 'stun:stun1.l.google.com:19302' }] };
const camsEl = $('#cams'), rEl = $('#cam-remote'), sEl = $('#cam-self'), epoch = Math.random().toString(36).slice(2);
let pc = null, local = null, making = false, ignoreOffer = false, peerEpoch = null;
const peer = () => people.find(p => p.id !== me && p.online && p.role !== 'ext');
const sig = d => send({ type: 'signal', data: { ep: epoch, ...d } });
function renderCams() {
  const st = rEl.srcObject; rEl.hidden = !(st && st.getVideoTracks().some(t => t.readyState === 'live' && !t.muted));
  sEl.hidden = !local; $('#cam').classList.toggle('on', !!local); $('#mic').disabled = !local;
  const a = local && local.getAudioTracks()[0]; $('#mic').classList.toggle('on', !!(a && a.enabled));
}
function closePC() { if (pc) { pc.onnegotiationneeded = pc.onicecandidate = pc.ontrack = null; pc.close(); pc = null; } rEl.srcObject = null; renderCams(); }
function makePC() {
  pc = new RTCPeerConnection(ICE); making = false; ignoreOffer = false;
  pc.onicecandidate = e => e.candidate && sig({ c: e.candidate });
  pc.ontrack = e => { rEl.srcObject = e.streams[0]; e.track.onmute = e.track.onunmute = e.track.onended = renderCams; renderCams(); rEl.play().catch(() => {}); };
  pc.onnegotiationneeded = async () => { try { making = true; await pc.setLocalDescription(); sig({ d: pc.localDescription }); } catch (err) { console.warn(err); } finally { making = false; } };
  if (local) local.getTracks().forEach(t => pc.addTrack(t, local));
}
async function onSignal(m) {
  const { ep, d, c } = m.data || {}; if (!ep) return;
  if (ep !== peerEpoch) { peerEpoch = ep; closePC(); makePC(); }   // partner reloaded: start a fresh connection
  if (!pc) makePC();
  const polite = me < m.from;
  try {
    if (d) {
      const collision = d.type === 'offer' && (making || pc.signalingState !== 'stable');
      ignoreOffer = !polite && collision; if (ignoreOffer) return;
      await pc.setRemoteDescription(d);
      if (d.type === 'offer') { await pc.setLocalDescription(); sig({ d: pc.localDescription }); }
    } else if (c) { try { await pc.addIceCandidate(c); } catch (err) { if (!ignoreOffer) console.warn(err); } }
  } catch (err) { console.warn(err); }
}
const nudgePeer = () => { if (pc && pc.signalingState === 'stable') pc.restartIce(); };
async function toggleCam() {
  if (local) { local.getTracks().forEach(t => t.stop()); local = null; sEl.srcObject = null; if (pc) pc.getSenders().forEach(s => s.track && pc.removeTrack(s)); return renderCams(); }
  try { local = await navigator.mediaDevices.getUserMedia({ video: { width: { ideal: 320 }, height: { ideal: 320 }, facingMode: 'user' }, audio: { echoCancellation: true, noiseSuppression: true } }); }
  catch { return toast('Camera is blocked. Allow it in the address bar (camera icon), then try again.'); }
  local.getAudioTracks().forEach(t => (t.enabled = false));   // mic starts muted
  sEl.srcObject = local; if (pc) local.getTracks().forEach(t => pc.addTrack(t, local)); else makePC();
  renderCams();
}
function stopCams() { if (local) { local.getTracks().forEach(t => t.stop()); local = null; sEl.srcObject = null; } closePC(); peerEpoch = null; }
async function popOut() {
  if (!window.documentPictureInPicture) return toast('Pop-out needs Chrome 116 or newer on a computer.');
  if (documentPictureInPicture.window) return documentPictureInPicture.window.close();
  const w = await documentPictureInPicture.requestWindow({ width: 210, height: 120 });
  for (const ss of document.styleSheets) { try { const s = w.document.createElement('style'); s.textContent = [...ss.cssRules].map(r => r.cssText).join(''); w.document.head.append(s); } catch {} }
  w.document.body.style.cssText = 'margin:0;background:#17161b;display:grid;place-items:center;height:100vh';
  camsEl.classList.add('pip'); w.document.body.append(camsEl); [rEl, sEl].forEach(v => v.play().catch(() => {}));
  w.addEventListener('pagehide', () => { camsEl.classList.remove('pip'); $('.screen-wrap').append(camsEl); [rEl, sEl].forEach(v => v.play().catch(() => {})); });
}
$('#cam').onclick = toggleCam; $('#pop').onclick = popOut;
$('#mic').onclick = () => { const a = local && local.getAudioTracks()[0]; if (a) { a.enabled = !a.enabled; renderCams(); } };

/* ---------- boot: opening an invite or refreshing /r/CODE ---------- */
const m = location.pathname.match(/^\/r\/([A-Za-z0-9]{8})$/);
if (m) {
  const room = m[1].toUpperCase(); $('#home').hidden = true; $('#invite-code').textContent = room; $('#invite-name').value = localStorage.ttName || '';
  if (localStorage.ttName) { code = room; connect(); } else { $('#join-dialog').hidden = false; $('#invite-name').focus(); }
}
