import crypto from 'node:crypto';
import { createAccountStore, validatePreferences } from './account-store.js';
export { validatePreferences } from './account-store.js';
import { promisify } from 'node:util';
const scrypt = promisify(crypto.scrypt);
const COOKIE = 'evakage_account';
const DAY = 86400000;
/** Optional durable accounts. Device secrets and content never enter this store.
 * @param {{file: string, secure: boolean, onRevoke?: (session: string) => void}} options */
export function createAccounts({ file, secure, onRevoke = () => {} }) {
  const accounts = file ? createAccountStore(file) : null;
  let closed = false;
  /** @type {Map<string, {name: string, salt: string, expires: number}>} */
  const sessions = new Map();
  /** One-use, short-lived socket tickets; cookies stay HttpOnly.
   * @type {Map<string, {session: string, deviceId: string, expires: number}>} */
  const tickets = new Map();
  /** @param {string} key */
  function revoke(key) {
    if (!sessions.delete(key)) return;
    for (const [token, ticket] of tickets) if (ticket.session === key) tickets.delete(token);
    onRevoke(key);
  }
  function prune() {
    const now = Date.now();
    for (const [key, session] of sessions) if (session.expires <= now || accounts?.get(session.name)?.salt !== session.salt) revoke(key);
    for (const [key, ticket] of tickets) if (ticket.expires <= now) tickets.delete(key);
  }
  /** @param {string} key */
  function sessionName(key) {
    const session = sessions.get(key);
    return session && session.expires > Date.now() ? session.name : null;
  }
  /** @type {Map<string, {count: number, until: number}>} */
  const attempts = new Map();
  let hashing = 0;
  /** @param {import('node:http').IncomingMessage} req @param {import('node:http').ServerResponse} res @param {URL} url */
  async function handle(req, res, url) {
    const reply = (/** @type {number} */ code, /** @type {object} */ value) => {
      res.writeHead(code, { 'content-type': 'application/json', 'cache-control': 'no-store', 'x-content-type-options': 'nosniff' });
      res.end(JSON.stringify(value));
    };
    if (!accounts || closed) { reply(503, { error: 'Accounts are disabled on this server.' }); return; }
    const now = Date.now();
    prune();
    for (const [key, value] of attempts) if (value.until <= now) attempts.delete(key);
    const cookie = req.headers.cookie?.split(';').map(v => v.trim()).find(v => v.startsWith(`${COOKIE}=`))?.slice(COOKIE.length + 1) || '';
    const sessionKey = crypto.createHash('sha256').update(cookie).digest('hex');
    const session = sessions.get(sessionKey);
    const account = session && accounts.get(session.name);
    if (req.method === 'GET' && url.pathname === '/account/session') {
      reply(200, account && session ? { username: session.name, preferences: account.preferences, revision: account.revision } : { username: null }); return;
    }
    // Same-origin requests prevent cross-site account/session changes.
    const origin = `${secure ? 'https' : 'http'}://${req.headers.host}`;
    if (req.headers.origin !== origin || req.headers['content-type'] !== 'application/json') {
      reply(403, { error: 'Same-origin JSON request required.' }); return;
    }
    const ip = req.socket.remoteAddress || '';
    const limit = attempts.get(ip) || { count: 0, until: now + 60000 };
    if (attempts.size >= 4096 && !attempts.has(ip)) { reply(429, { error: 'Try again later.' }); return; }
    attempts.set(ip, limit);
    if (++limit.count > 30) { reply(429, { error: 'Try again later.' }); return; }
    let body;
    try {
      let bytes = 0;
      const chunks = [];
      for await (const chunk of req) {
        bytes += chunk.length;
        if (bytes > 4096) { reply(413, { error: 'Request too large.' }); return; }
        chunks.push(chunk);
      }
      body = JSON.parse(Buffer.concat(chunks).toString());
      if (!body || typeof body !== 'object' || Array.isArray(body)) throw new Error('Invalid body');
    } catch { reply(400, { error: 'Invalid JSON request.' }); return; }
    const setCookie = (/** @type {string} */ token, /** @type {number} */ age) => res.setHeader('set-cookie', `${COOKIE}=${token}; Path=/account; HttpOnly; SameSite=Strict; Max-Age=${age}${secure ? '; Secure' : ''}`);
    if (req.method === 'POST' && url.pathname === '/account/logout') {
      revoke(sessionKey); setCookie('', 0); reply(200, { username: null }); return;
    }
    if (req.method === 'DELETE' && url.pathname === '/account/delete') {
      if (!account || !session) { reply(401, { error: 'Sign in first.' }); return; }
      if (typeof body.password !== 'string' || body.password.length < 12 || body.password.length > 128) {
        reply(400, { error: 'Enter your current password to delete your account.' }); return;
      }
      if (hashing >= 4) { reply(429, { error: 'Try again later.' }); return; }
      hashing++;
      let hash;
      try { hash = /** @type {Buffer} */ (await scrypt(body.password, account.salt, 64)); }
      finally { hashing--; }
      if (!crypto.timingSafeEqual(hash, Buffer.from(account.hash, 'hex'))) {
        reply(401, { error: 'Incorrect password. Your account was not deleted.' }); return;
      }
      if (sessions.get(sessionKey) !== session) {
        reply(401, { error: 'Account session changed. Sign in again.' }); return;
      }
      try {
        if (!accounts.delete(session.name, account.salt, account.hash)) {
          reply(401, { error: 'Account session changed. Sign in again.' }); return;
        }
      } catch { reply(503, { error: 'Could not delete account. Please try again.' }); return; }
      for (const [key, active] of sessions) if (active.name === session.name) revoke(key);
      setCookie('', 0); reply(200, { username: null }); return;
    }
    if (req.method === 'POST' && url.pathname === '/account/connect') {
      if (!account) { reply(401, { error: 'Sign in first.' }); return; }
      if (typeof body.deviceId !== 'string' || !/^[A-Za-z0-9_-]{43}$/.test(body.deviceId)) { reply(400, { error: 'Invalid device.' }); return; }
      if (tickets.size >= 4096) { reply(429, { error: 'Try again later.' }); return; }
      const token = crypto.randomBytes(32).toString('base64url');
      tickets.set(token, { session: sessionKey, deviceId: body.deviceId, expires: now + 30000 });
      reply(200, { token }); return;
    }
    if (req.method === 'PUT' && url.pathname === '/account/preferences') {
      if (!account) { reply(401, { error: 'Sign in first.' }); return; }
      const preferences = validatePreferences(body.preferences);
      if (!preferences || !Number.isSafeInteger(body.revision) || body.revision < 0) { reply(400, { error: 'Invalid preferences.' }); return; }
      try {
        const result = accounts.savePreferences(session.name, preferences, body.revision);
        if (!result.saved) { reply(409, { error: 'Preferences changed on another device. Load them before saving.', preferences: result.account?.preferences, revision: result.account?.revision }); return; }
        reply(200, { preferences, revision: result.revision });
      } catch { reply(503, { error: 'Could not save preferences.' }); }
      return;
    }
    if (req.method !== 'POST' || !['/account/login', '/account/register'].includes(url.pathname)) { reply(404, { error: 'Not found.' }); return; }
    const name = typeof body.username === 'string' ? body.username.trim().toLowerCase() : '';
    const password = typeof body.password === 'string' ? body.password : '';
    if (!/^[a-z0-9_-]{3,40}$/.test(name) || password.length < 12 || password.length > 128) { reply(400, { error: 'Use a 3–40 character username and a 12–128 character password.' }); return; }
    if (hashing >= 4 || sessions.size >= 4096 || accounts.count() >= 10000 && url.pathname === '/account/register') { reply(429, { error: 'Try again later.' }); return; }
    const existing = accounts.get(name);
    const salt = existing?.salt || crypto.randomBytes(16).toString('hex');
    hashing++;
    let hash;
    try { hash = /** @type {Buffer} */ (await scrypt(password, salt, 64)); }
    finally { hashing--; }
    if (url.pathname === '/account/register') {
      try {
        const result = accounts.create(name, salt, hash.toString('hex'));
        if (result === 'exists') { reply(409, { error: 'Choose another username.' }); return; }
        if (result === 'full') { reply(429, { error: 'Try again later.' }); return; }
      } catch { reply(503, { error: 'Could not create account.' }); return; }
    } else if (!existing || accounts.get(name)?.hash !== existing.hash || accounts.get(name)?.salt !== existing.salt || !crypto.timingSafeEqual(hash, Buffer.from(existing.hash, 'hex'))) {
      reply(401, { error: 'Invalid username or password.' }); return;
    }
    revoke(sessionKey);
    const token = crypto.randomBytes(32).toString('base64url');
    sessions.set(crypto.createHash('sha256').update(token).digest('hex'), { name, salt, expires: now + 30 * DAY });
    setCookie(token, 30 * 86400);
    const current = accounts.get(name);
    reply(200, { username: name, preferences: current?.preferences, revision: current?.revision });
  }
  return {
    handle, sessionName, prune,
    /** A recreated username is a different room owner.
     * @param {string} key */
    sessionOwner(key) {
      const name = sessionName(key);
      return name ? `${name}:${sessions.get(key)?.salt}` : null;
    },
    /** @param {string} token @param {string} deviceId */
    consumeTicket(token, deviceId) {
      prune();
      const ticket = tickets.get(token);
      tickets.delete(token);
      return ticket && ticket.deviceId === deviceId && sessions.has(ticket.session) ? ticket.session : null;
    },
    close() { closed = true; sessions.clear(); tickets.clear(); accounts?.close(); }
  };
}
