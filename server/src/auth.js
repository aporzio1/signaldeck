import crypto from 'node:crypto';
import { getSettings, saveSettings } from './config.js';
import { httpError } from './util.js';

const SESSION_COOKIE = 'sd_session';
const SESSION_TTL = 1000 * 60 * 60 * 24 * 30;
const sessions = new Map();
const loginAttempts = new Map();

const hashPassword = (password, salt) => crypto.scryptSync(password, salt, 64).toString('hex');
const sha256 = (value) => crypto.createHash('sha256').update(value).digest('hex');

export function parseCookies(header = '') {
  const out = {};
  for (const part of String(header).split(';')) {
    const idx = part.indexOf('=');
    if (idx === -1) continue;
    const key = part.slice(0, idx).trim();
    if (!key) continue;
    out[key] = decodeURIComponent(part.slice(idx + 1).trim());
  }
  return out;
}

export function isConfigured() {
  return Boolean(getSettings().auth.passwordHash);
}

export function setPassword(password) {
  if (typeof password !== 'string' || password.length < 8) {
    throw httpError(400, 'Password must be at least 8 characters.');
  }
  if (password.length > 256) throw httpError(400, 'Password is too long.');
  const settings = getSettings();
  const salt = crypto.randomBytes(16).toString('hex');
  settings.auth.salt = salt;
  settings.auth.passwordHash = hashPassword(password, salt);
  sessions.clear();
  return saveSettings();
}

export function verifyPassword(password) {
  const { auth } = getSettings();
  if (!auth.passwordHash || !auth.salt) return false;
  const expected = Buffer.from(auth.passwordHash, 'hex');
  const actual = Buffer.from(hashPassword(String(password || ''), auth.salt), 'hex');
  if (expected.length !== actual.length) return false;
  return crypto.timingSafeEqual(expected, actual);
}

export function rateLimited(ip) {
  const now = Date.now();
  const entry = loginAttempts.get(ip) || { count: 0, first: now };
  if (now - entry.first > 15 * 60 * 1000) {
    entry.count = 0;
    entry.first = now;
  }
  entry.count += 1;
  loginAttempts.set(ip, entry);
  return entry.count > 12;
}

export function clearRateLimit(ip) {
  loginAttempts.delete(ip);
}

export function createSession(res, ip, secure) {
  const token = crypto.randomBytes(32).toString('base64url');
  sessions.set(token, { created: Date.now(), ip });
  res.cookie(SESSION_COOKIE, token, {
    httpOnly: true,
    sameSite: 'strict',
    secure: Boolean(secure),
    maxAge: SESSION_TTL,
    path: '/',
  });
  return token;
}

export function destroySession(req, res) {
  const cookies = parseCookies(req.headers.cookie);
  if (cookies[SESSION_COOKIE]) sessions.delete(cookies[SESSION_COOKIE]);
  res.clearCookie(SESSION_COOKIE, { path: '/' });
}

export function listTokens() {
  return (getSettings().auth.tokens || []).map((t) => ({
    id: t.id,
    name: t.name,
    created: t.created,
    lastUsed: t.lastUsed || null,
  }));
}

export function createToken(name) {
  const raw = `sdt_${crypto.randomBytes(24).toString('base64url')}`;
  const settings = getSettings();
  const token = {
    id: crypto.randomBytes(6).toString('hex'),
    name: String(name || 'API token').slice(0, 60),
    hash: sha256(raw),
    created: Date.now(),
    lastUsed: null,
  };
  settings.auth.tokens = [...(settings.auth.tokens || []), token];
  saveSettings();
  return { token: raw, id: token.id, name: token.name, created: token.created };
}

export function revokeToken(id) {
  const settings = getSettings();
  settings.auth.tokens = (settings.auth.tokens || []).filter((t) => t.id !== id);
  return saveSettings();
}

function tokenUser(req) {
  const header = req.headers.authorization || '';
  const match = /^Bearer\s+(.+)$/i.exec(header);
  if (!match) return null;
  const digest = sha256(match[1].trim());
  const settings = getSettings();
  const token = (settings.auth.tokens || []).find((t) => t.hash === digest);
  if (!token) return null;
  token.lastUsed = Date.now();
  return { via: 'token', name: token.name };
}

export function authenticate(req) {
  const fromToken = tokenUser(req);
  if (fromToken) return fromToken;
  const cookies = parseCookies(req.headers.cookie);
  const token = cookies[SESSION_COOKIE];
  if (!token) return null;
  const session = sessions.get(token);
  if (!session) return null;
  if (Date.now() - session.created > SESSION_TTL) {
    sessions.delete(token);
    return null;
  }
  return { via: 'session' };
}

export function requireAuth(req, res, next) {
  if (!isConfigured()) return next(httpError(428, 'Setup required: set a password first.'));
  const user = authenticate(req);
  if (!user) return next(httpError(401, 'Authentication required.'));
  req.user = user;
  return next();
}

/** Reject cross-site state-changing requests (defence in depth on top of SameSite). */
export function requireSameOrigin(req, res, next) {
  if (req.method === 'GET' || req.method === 'HEAD' || req.method === 'OPTIONS') return next();
  const origin = req.headers.origin;
  if (!origin) return next(); // native clients / curl with a token
  try {
    const originHost = new URL(origin).host;
    if (originHost !== req.headers.host) {
      return next(httpError(403, 'Cross-origin request rejected.'));
    }
  } catch {
    return next(httpError(403, 'Invalid Origin header.'));
  }
  return next();
}

/**
 * Long-running service hygiene: sessions and login-attempt buckets were only
 * collected on their own key's next use, so both Maps grew for the process
 * lifetime. Prune expired entries on a timer and bound both Maps by evicting
 * the oldest insertions (Map iteration order is insertion order).
 */
const SESSION_CAP = 1000;
const ATTEMPT_CAP = 1000;
function pruneAuthState() {
  const now = Date.now();
  for (const [token, session] of sessions) {
    if (now - session.created > SESSION_TTL) sessions.delete(token);
  }
  for (const [ip, entry] of loginAttempts) {
    if (now - entry.first > 15 * 60 * 1000) loginAttempts.delete(ip);
  }
  while (sessions.size > SESSION_CAP) sessions.delete(sessions.keys().next().value);
  while (loginAttempts.size > ATTEMPT_CAP) loginAttempts.delete(loginAttempts.keys().next().value);
}
const authPrune = setInterval(pruneAuthState, 60_000);
authPrune.unref?.();

export function sessionCount() {
  return sessions.size;
}
