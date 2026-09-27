// User accounts: SQLite storage (data/app.db, via the built-in node:sqlite — no npm
// dependency needed) plus in-memory sessions. A server restart clears all sessions
// (everyone has to log back in) — acceptable for this project's scope, keeps things simple.
const fs = require("fs");
const path = require("path");
const crypto = require("crypto");
const { DatabaseSync } = require("node:sqlite");

const DATA_DIR = path.join(__dirname, "data");
const DB_FILE = path.join(DATA_DIR, "app.db");
if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });

const db = new DatabaseSync(DB_FILE);
db.exec(`CREATE TABLE IF NOT EXISTS users (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  username TEXT UNIQUE NOT NULL,
  password_hash TEXT NOT NULL,
  password_salt TEXT NOT NULL,
  created_at INTEGER NOT NULL
)`);

const USERNAME_RE = /^[a-zA-Z0-9_]{3,20}$/;
const SESSION_COOKIE = "bomber_session";
const SESSION_MAX_AGE_MS = 30 * 24 * 3600 * 1000;

function hashPassword(password) {
  const salt = crypto.randomBytes(16).toString("hex");
  const hash = crypto.scryptSync(password, salt, 64).toString("hex");
  return { hash, salt };
}

function verifyPassword(password, hash, salt) {
  const candidate = crypto.scryptSync(password, salt, 64);
  const stored = Buffer.from(hash, "hex");
  if (candidate.length !== stored.length) return false;
  return crypto.timingSafeEqual(candidate, stored);
}

function toPublicUser(row) {
  return row ? { id: row.id, username: row.username } : null;
}

const PASSWORD_MAX_LEN = 200; // scrypt cost grows with input size; cap it so a giant payload can't be used as a CPU-exhaustion DoS

function createUser(username, password) {
  username = String(username || "").trim();
  password = String(password || "");
  if (!USERNAME_RE.test(username)) throw { code: "invalid-username" };
  if (password.length < 6 || password.length > PASSWORD_MAX_LEN) throw { code: "invalid-password" };
  const { hash, salt } = hashPassword(password);
  try {
    db.prepare(
      "INSERT INTO users (username, password_hash, password_salt, created_at) VALUES (?, ?, ?, ?)"
    ).run(username, hash, salt, Date.now());
  } catch (e) {
    if (String(e.message || "").includes("UNIQUE")) throw { code: "username-taken" };
    throw e;
  }
  return toPublicUser(findUserByUsername(username));
}

function findUserByUsername(username) {
  return db.prepare("SELECT * FROM users WHERE username = ?").get(String(username || "").trim());
}

function verifyLogin(username, password) {
  password = String(password || "");
  if (password.length > PASSWORD_MAX_LEN) return null;
  const row = findUserByUsername(username);
  if (!row) return null;
  if (!verifyPassword(password, row.password_hash, row.password_salt)) return null;
  return toPublicUser(row);
}

// token -> {id, username, createdAt}
const sessions = new Map();

function createSession(user) {
  const token = crypto.randomBytes(24).toString("hex");
  sessions.set(token, { id: user.id, username: user.username, createdAt: Date.now() });
  return token;
}

function getSession(token) {
  if (!token) return null;
  const entry = sessions.get(token);
  if (!entry) return null;
  if (Date.now() - entry.createdAt > SESSION_MAX_AGE_MS) {
    sessions.delete(token);
    return null;
  }
  return { id: entry.id, username: entry.username };
}

function destroySession(token) {
  if (token) sessions.delete(token);
}

function parseCookies(header) {
  const out = {};
  if (!header) return out;
  for (const part of header.split(";")) {
    const idx = part.indexOf("=");
    if (idx === -1) continue;
    const name = part.slice(0, idx).trim();
    const value = part.slice(idx + 1).trim();
    if (name) out[name] = decodeURIComponent(value);
  }
  return out;
}

function serializeSessionCookie(token, maxAgeSec) {
  return `${SESSION_COOKIE}=${encodeURIComponent(token)}; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=${maxAgeSec}`;
}

function clearSessionCookie() {
  return `${SESSION_COOKIE}=; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=0`;
}

module.exports = {
  SESSION_COOKIE,
  createUser,
  findUserByUsername,
  verifyLogin,
  createSession,
  getSession,
  destroySession,
  parseCookies,
  serializeSessionCookie,
  clearSessionCookie,
};
