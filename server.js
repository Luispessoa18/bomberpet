// Small local server for Bomber Animals: serves the static game files and hosts real-time
// online multiplayer over WebSocket — the server runs the authoritative simulation
// (server_sim.js, including the hand-designed bot AI) and every connected client just sends
// input and renders whatever state it broadcasts.
// Run with: node server.js  (then open http://localhost:8934)
const http = require("http");
const fs = require("fs");
const path = require("path");
const WebSocket = require("ws");
const sim = require("./server_sim.js");
const auth = require("./auth.js");

const ROOT = __dirname;

const TYPES = { ".html": "text/html", ".js": "application/javascript", ".css": "text/css", ".png": "image/png", ".json": "application/json" };

const MAX_BODY_BYTES = 10 * 1024; // auth payloads are tiny; reject anything else outright instead of buffering it

function readJsonBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    let settled = false;
    req.on("data", (c) => {
      size += c.length;
      // Stop accumulating once over the limit (caps memory use) but keep draining the socket
      // instead of destroying it, so the response we send below actually reaches the client.
      if (size > MAX_BODY_BYTES) {
        if (!settled) { settled = true; reject(new Error("payload-too-large")); }
        return;
      }
      chunks.push(c);
    });
    req.on("end", () => {
      if (settled) return;
      settled = true;
      try { resolve(JSON.parse(Buffer.concat(chunks).toString("utf8") || "{}")); }
      catch (e) { reject(e); }
    });
  });
}

// Only cloudflared can reach this server (it's bound to loopback below), and cloudflared always
// sets Cf-Connecting-Ip to the real visitor IP — so it's safe to trust for rate-limit bucketing.
function clientIp(req) {
  return req.headers["cf-connecting-ip"] || req.socket.remoteAddress || "unknown";
}

// Small fixed-window limiter for the auth endpoints — the interesting attack here is credential
// stuffing / brute force, not raw traffic volume, so a per-IP+route window is enough.
const RATE_LIMIT_WINDOW_MS = 60_000;
const RATE_LIMIT_MAX = 8;
const rateLimitHits = new Map(); // "route:ip" -> {count, windowStart}
function rateLimited(route, req) {
  const key = `${route}:${clientIp(req)}`;
  const now = Date.now();
  const entry = rateLimitHits.get(key);
  if (!entry || now - entry.windowStart > RATE_LIMIT_WINDOW_MS) {
    rateLimitHits.set(key, { count: 1, windowStart: now });
    return false;
  }
  entry.count += 1;
  return entry.count > RATE_LIMIT_MAX;
}
// Sweep stale entries periodically so the map doesn't grow forever.
setInterval(() => {
  const now = Date.now();
  for (const [key, entry] of rateLimitHits) {
    if (now - entry.windowStart > RATE_LIMIT_WINDOW_MS) rateLimitHits.delete(key);
  }
}, RATE_LIMIT_WINDOW_MS).unref();

function withSecurityHeaders(headers) {
  return {
    ...headers,
    "X-Content-Type-Options": "nosniff",
    "X-Frame-Options": "DENY",
    "Referrer-Policy": "same-origin",
    "Content-Security-Policy": "default-src 'self'; img-src 'self' data:; style-src 'self' 'unsafe-inline'; connect-src 'self'",
  };
}

const SESSION_MAX_AGE_SEC = 30 * 24 * 3600;

const server = http.createServer((req, res) => {
  const url = req.url.split("?")[0];

  if ((url === "/api/register" || url === "/api/login") && req.method === "POST" && rateLimited(url, req)) {
    res.writeHead(429, withSecurityHeaders({ "Content-Type": "application/json", "Retry-After": "60" }));
    res.end(JSON.stringify({ ok: false, error: "too-many-requests" }));
    return;
  }

  if (url === "/api/register" && req.method === "POST") {
    readJsonBody(req).then((body) => {
      try {
        const user = auth.createUser(body.username, body.password);
        const token = auth.createSession(user);
        res.writeHead(200, withSecurityHeaders({ "Content-Type": "application/json", "Set-Cookie": auth.serializeSessionCookie(token, SESSION_MAX_AGE_SEC) }));
        res.end(JSON.stringify({ ok: true, username: user.username }));
      } catch (e) {
        const code = e && e.code;
        res.writeHead(code === "username-taken" ? 409 : 400, withSecurityHeaders({ "Content-Type": "application/json" }));
        res.end(JSON.stringify({ ok: false, error: code || "invalid-request" }));
      }
    }, (e) => {
      res.writeHead(e && e.message === "payload-too-large" ? 413 : 400, withSecurityHeaders({ "Content-Type": "application/json" }));
      res.end(JSON.stringify({ ok: false, error: e && e.message === "payload-too-large" ? "payload-too-large" : "invalid-json" }));
    });
    return;
  }

  if (url === "/api/login" && req.method === "POST") {
    readJsonBody(req).then((body) => {
      const user = auth.verifyLogin(body.username, body.password);
      if (!user) {
        res.writeHead(401, withSecurityHeaders({ "Content-Type": "application/json" }));
        res.end(JSON.stringify({ ok: false, error: "invalid-credentials" }));
        return;
      }
      const token = auth.createSession(user);
      res.writeHead(200, withSecurityHeaders({ "Content-Type": "application/json", "Set-Cookie": auth.serializeSessionCookie(token, SESSION_MAX_AGE_SEC) }));
      res.end(JSON.stringify({ ok: true, username: user.username }));
    }, (e) => {
      res.writeHead(e && e.message === "payload-too-large" ? 413 : 400, withSecurityHeaders({ "Content-Type": "application/json" }));
      res.end(JSON.stringify({ ok: false, error: e && e.message === "payload-too-large" ? "payload-too-large" : "invalid-json" }));
    });
    return;
  }

  if (url === "/api/logout" && req.method === "POST") {
    const token = auth.parseCookies(req.headers.cookie)[auth.SESSION_COOKIE];
    auth.destroySession(token);
    res.writeHead(200, withSecurityHeaders({ "Content-Type": "application/json", "Set-Cookie": auth.clearSessionCookie() }));
    res.end(JSON.stringify({ ok: true }));
    return;
  }

  if (url === "/api/me" && req.method === "GET") {
    const token = auth.parseCookies(req.headers.cookie)[auth.SESSION_COOKIE];
    const user = auth.getSession(token);
    res.writeHead(200, withSecurityHeaders({ "Content-Type": "application/json" }));
    res.end(JSON.stringify({ ok: true, user: user ? { username: user.username } : null }));
    return;
  }

  let reqPath = decodeURIComponent(url);
  if (reqPath === "/") reqPath = "/index.html";
  const filePath = path.join(ROOT, reqPath);
  if (!filePath.startsWith(ROOT) || reqPath.includes("/data/")) {
    res.writeHead(403);
    res.end("forbidden");
    return;
  }
  fs.readFile(filePath, (err, data) => {
    if (err) {
      res.writeHead(404, withSecurityHeaders({}));
      res.end("not found");
      return;
    }
    const ext = path.extname(filePath);
    // Sprites rarely change and can sit on Cloudflare's edge; html/css/js must not, or an edit
    // here can be served stale to players for hours (bit us during development).
    const cacheControl = ext === ".png" ? "public, max-age=86400" : "no-cache";
    res.writeHead(200, withSecurityHeaders({ "Content-Type": TYPES[ext] || "application/octet-stream", "Cache-Control": cacheControl }));
    res.end(data);
  });
});

// ---- online multiplayer: multiple independent rooms, each with its own short code so
// players can create one and invite friends by sharing it, instead of everyone landing in
// one global match. Joining a room subscribes you to its live state (who's picked what)
// before you've even claimed a species, so the character-select screen can show real-time
// "taken by so-and-so" badges. ----
const rooms = new Map(); // code -> { sim: simRoom, watchers: Set<ws>, started, hostUsername }
// ws -> {code, species} — species rather than a direct player-object reference, since a round
// restart (sim.initRound) replaces every player object; looking the current one up by species
// each time means control never silently breaks across a restart.
const wsToPlayer = new Map();
const lobbyWatchers = new Set(); // ws -> subscribed to live roomList broadcasts

// Every game connection requires a logged-in session, read from the cookie sent with the WS
// upgrade request.
const wss = new WebSocket.Server({
  server,
  verifyClient(info, cb) {
    const token = auth.parseCookies(info.req.headers.cookie)[auth.SESSION_COOKIE];
    const user = auth.getSession(token);
    if (!user) { cb(false, 401, "Unauthorized"); return; }
    info.req.user = user;
    cb(true);
  },
});

const CODE_CHARS = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789"; // no ambiguous 0/O/1/I
function makeRoomCode() {
  let code;
  do {
    code = Array.from({ length: 4 }, () => CODE_CHARS[Math.floor(Math.random() * CODE_CHARS.length)]).join("");
  } while (rooms.has(code));
  return code;
}
function getRoomEntry(code, createIfMissing) {
  if (!rooms.has(code)) {
    if (!createIfMissing) return null;
    // New rooms start paused (started:false) so everyone can pick a character and see the
    // code/link before anything moves — someone in the room has to press "Iniciar sala".
    rooms.set(code, { sim: sim.createRoom(), watchers: new Set(), started: false, hostUsername: null });
  }
  return rooms.get(code);
}

function buildRoomList() {
  return Array.from(rooms, ([code, entry]) => ({
    code,
    players: entry.sim.players.filter((p) => p.socket).length,
    max: 4,
    started: entry.started,
    host: entry.hostUsername || null,
  }));
}
function broadcastRoomList() {
  if (lobbyWatchers.size === 0) return;
  const payload = JSON.stringify({ type: "roomList", rooms: buildRoomList() });
  for (const client of lobbyWatchers) if (client.readyState === WebSocket.OPEN) client.send(payload);
}

wss.on("connection", (ws, req) => {
  ws.user = req.user;

  ws.on("message", (raw) => {
    let msg;
    try { msg = JSON.parse(raw); } catch (e) { return; }

    if (msg.type === "watchLobby") {
      lobbyWatchers.add(ws);
      ws.send(JSON.stringify({ type: "roomList", rooms: buildRoomList() }));
      return;
    }

    if (msg.type === "createRoom") {
      const code = makeRoomCode();
      const entry = getRoomEntry(code, true);
      entry.hostUsername = ws.user.username;
      entry.watchers.add(ws);
      ws.roomCode = code;
      ws.send(JSON.stringify({ type: "roomJoined", code }));
      broadcastRoomList();
      return;
    }

    if (msg.type === "joinRoom") {
      const code = String(msg.code || "").toUpperCase().trim();
      const entry = getRoomEntry(code, false);
      if (!entry) {
        ws.send(JSON.stringify({ type: "error", reason: "room-not-found" }));
        return;
      }
      entry.watchers.add(ws);
      ws.roomCode = code;
      ws.send(JSON.stringify({ type: "roomJoined", code }));
      return;
    }

    if (msg.type === "startRoom") {
      const entry = ws.roomCode && getRoomEntry(ws.roomCode, false);
      if (entry) entry.started = true;
      broadcastRoomList();
      return;
    }

    if (msg.type === "pickSpecies") {
      const entry = ws.roomCode && getRoomEntry(ws.roomCode, false);
      if (!entry) { ws.send(JSON.stringify({ type: "error", reason: "no-room" })); return; }
      const species = sim.SPECIES_ORDER.includes(msg.species) ? msg.species : sim.SPECIES_ORDER[0];
      const p = entry.sim.players.find((pl) => pl.species === species);
      if (p.socket && p.socket !== ws && p.socket.readyState === WebSocket.OPEN) {
        ws.send(JSON.stringify({ type: "error", reason: "species-taken" }));
        return;
      }
      p.socket = ws;
      p.input = { x: 0, y: 0 };
      p.nickname = ws.user.username; // accounts exist now, so the name is never client-trusted free text
      wsToPlayer.set(ws, { code: ws.roomCode, species });
      ws.send(JSON.stringify({ type: "joined", index: p.index, species }));
      broadcastRoomList();
      return;
    }

    if (msg.type === "restartRound") {
      const entry = ws.roomCode && getRoomEntry(ws.roomCode, false);
      if (entry) { sim.initRound(entry.sim); entry.started = true; }
      broadcastRoomList();
      return;
    }

    const entry = wsToPlayer.get(ws);
    if (!entry) return; // must pick a species before controlling a player
    const roomEntry = getRoomEntry(entry.code, false);
    const p = roomEntry && roomEntry.sim.players.find((pl) => pl.species === entry.species);
    if (!p) return;

    if (msg.type === "input") {
      const x = Math.max(-1, Math.min(1, Number(msg.x) || 0));
      const y = Math.max(-1, Math.min(1, Number(msg.y) || 0));
      p.input = { x, y };
    } else if (msg.type === "action") {
      sim.handleAction(roomEntry.sim, p);
    }
  });

  ws.on("close", () => {
    const entry = wsToPlayer.get(ws);
    if (entry) {
      const roomEntry = rooms.get(entry.code);
      const p = roomEntry && roomEntry.sim.players.find((pl) => pl.species === entry.species);
      if (p && p.socket === ws) { p.socket = null; p.input = { x: 0, y: 0 }; p.nickname = null; }
    }
    wsToPlayer.delete(ws);
    lobbyWatchers.delete(ws);
    const roomEntry = ws.roomCode && rooms.get(ws.roomCode);
    if (roomEntry) {
      roomEntry.watchers.delete(ws);
      const stillClaimed = roomEntry.sim.players.some((p) => p.socket);
      if (roomEntry.watchers.size === 0 && !stillClaimed) rooms.delete(ws.roomCode);
    }
    broadcastRoomList();
  });
});

const TICK_MS = 50; // 20Hz authoritative simulation tick per room
setInterval(() => {
  for (const [code, entry] of rooms) {
    if (entry.started) sim.tick(entry.sim, TICK_MS / 1000);
    // The sim paused itself because no human is left alive to keep playing this round out —
    // drop back to the room's "not started" state so a rejoining/refreshing client sees the
    // picker, not a stuck "in progress" room.
    if (entry.started && entry.sim.awaitingRestart) { entry.started = false; broadcastRoomList(); }
    if (entry.watchers.size === 0) continue;
    const payload = JSON.stringify({ type: "state", code, started: entry.started, ...sim.serializeRoom(entry.sim) });
    for (const client of entry.watchers) {
      if (client.readyState === WebSocket.OPEN) client.send(payload);
    }
  }
}, TICK_MS);

const PORT = process.env.PORT || 8934;
// Bind to loopback only: the public path is exclusively through the Cloudflare tunnel
// (cloudflared connects to localhost), so nothing on the LAN can reach this port directly.
server.listen(PORT, "127.0.0.1", () => console.log(`Bomber Animals rodando em http://localhost:${PORT}`));
