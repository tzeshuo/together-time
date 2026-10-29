# TogetherTime

Private watch rooms for two. Each person streams directly from the source in their own browser; the server only relays play / pause / seek / load events (never video).

## Run locally
```bash
npm install
cp .env.example .env   # optional; defaults work
npm start              # http://localhost:3000
```
Open the site in two different browsers (or devices on the same network), create a room in one, open the invite link in the other.

## Deploy
You need a host that supports long-lived WebSocket connections and a Node process: Render, Railway, Fly.io, or any VPS. (Vercel/Netlify serverless functions do **not** work for the WebSocket server.)
1. Push this folder to a Git repo.
2. Create a new "Web Service" (Render/Railway): build `npm install`, start `npm start`.
3. Open the HTTPS URL it gives you and share it. HTTPS is required for `wss://` and for most media.

Rooms are stored in memory: a server restart clears them (the invite link then shows "room expired"). Free hosts that sleep will also reset rooms.

## How sync works
The server holds one state per room (`url, position, playing, rate, updatedAt, version`) and applies actions in arrival order, so simultaneous clicks resolve to one consistent result (last action to arrive wins). Controls only *send* actions; every device, including the sender, applies the broadcast state, so there are no feedback loops. Each client estimates the server clock (ping/offset), computes the expected position as `position + elapsed × rate`, and every 1.5 s corrects drift: gentle speed nudge under 1.2 s (video files/HLS), hard seek above. Reconnects and refreshes re-fetch the current state. Buffering players aren't repeatedly re-seeked. Millisecond-exact sync is not guaranteed; expect roughly within a second.

## Providers
| Source | Status |
|---|---|
| YouTube links (watch, youtu.be, shorts, live, embed) | Full sync via the official IFrame API. Videos with embedding disabled show an error. |
| Direct `.mp4` / `.webm` / `.m4v` links | Full sync, if the host allows playback from other websites (hotlink/CORS rules) and the link hasn't expired. |
| HLS `.m3u8` links | Full sync via hls.js (native on Safari), same host caveats. |
| Any other web page (including most streaming sites) | **Manual sync only.** Pages can't be controlled from another website. You each open the page in your own tab and follow a shared play/pause/seek clock. |
| Netflix, Disney+, and other DRM services | Same as above. Real sync would need an official integration or a browser extension; this app doesn't attempt to bypass DRM or proxy content. |

Adding a provider: add an entry to `providers` in `public/app.js` with `test(url)` and `make(el, url, onError)` returning `{time, dur, playing, buffering, rate, setRate, seek, play, pause, vol, destroy}`.

## Security notes
Room codes are 8 random characters (~40 bits). Only `http(s)` URLs are accepted. The server never fetches or proxies URLs. WebSocket origin is checked. Messages are size- and rate-limited. Empty rooms are deleted after `ROOM_TTL_HOURS`. No accounts or secrets are used.

## Not tested yet
This was written without network access, so `npm install` and a live two-browser run haven't been done. Syntax is checked; please run the acceptance tests yourself.
