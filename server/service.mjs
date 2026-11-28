import { DatabaseSync } from 'node:sqlite';
import { createHash, randomBytes, scrypt, timingSafeEqual } from 'node:crypto';
import { promisify } from 'node:util';

const derive = promisify(scrypt);
const bodyLimit = 8192;
const sessionSeconds = 8 * 3600;
const protectedOptions = ['profile', 'location', 'invites', 'contacts', 'recommendations', 'sharing'];
const options = [...protectedOptions, 'online', 'lastSeen', 'receipts', 'notifications', 'deviceLock', 'musicHistory'];
const modes = {public: [], private: ['online', 'lastSeen', 'notifications'], ultra: options};
const handlePattern = /^[a-z0-9_]{3,24}$/;
const cookieName = 'kis_session';
const digest = value => createHash('sha256').update(value).digest('hex');
const normalize = value => typeof value === 'string' ? value.trim().toLowerCase() : '';
const pair = (a, b) => a < b ? [a, b] : [b, a];

class HttpError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}
function ensure(condition, status, message) {
  if (!condition) throw new HttpError(status, message);
}
async function passwordKey(password, salt) {
  return derive(password, salt, 64, {N: 32768, r: 8, p: 1, maxmem: 64 * 1024 * 1024});
}
async function readJson(request) {
  ensure(request.headers.get('content-type')?.split(';')[0].trim() === 'application/json', 415, 'JSON requis.');
  ensure(request.body, 400, 'Corps manquant.');
  const reader = request.body.getReader();
  const chunks = [];
  let size = 0;
  for (;;) {
    const {done, value} = await reader.read();
    if (done) break;
    size += value.length;
    if (size > bodyLimit) {
      await reader.cancel();
      throw new HttpError(413, 'Requête trop volumineuse.');
    }
    chunks.push(value);
  }
  let value;
  try {
    value = JSON.parse(Buffer.concat(chunks).toString('utf8'));
  } catch {
    throw new HttpError(400, 'JSON invalide.');
  }
  ensure(value && typeof value === 'object' && !Array.isArray(value), 400, 'Objet requis.');
  return value;
}
function privacy(row) {
  const requested = JSON.parse(row.extra);
  const effective = [...new Set([...protectedOptions, ...modes[row.mode], ...requested])];
  return {mode: row.mode, requested, effective, protection: 'protected'};
}
function json(value, status = 200, headers = {}) {
  return Response.json(value, {
    status,
    headers: {'cache-control': 'no-store', 'x-content-type-options': 'nosniff', ...headers}
  });
}

export function openService({filename, origin, now = Date.now, maxAuthPerMinute = 24}) {
  const url = new URL(origin);
  ensure(url.origin === origin && (url.protocol === 'https:' ||
    (url.protocol === 'http:' && url.hostname === '127.0.0.1')), 500, 'Origine HTTPS ou locale requise.');
  const db = new DatabaseSync(filename);
  db.exec(`
    PRAGMA foreign_keys = ON;
    PRAGMA journal_mode = WAL;
    PRAGMA busy_timeout = 5000;
    CREATE TABLE IF NOT EXISTS accounts (
      id INTEGER PRIMARY KEY, handle TEXT UNIQUE NOT NULL,
      salt TEXT NOT NULL, password TEXT NOT NULL,
      mode TEXT NOT NULL DEFAULT 'private' CHECK(mode IN ('public','private','ultra')),
      extra TEXT NOT NULL DEFAULT '[]'
    );
    CREATE TABLE IF NOT EXISTS sessions (
      token TEXT PRIMARY KEY, account INTEGER NOT NULL REFERENCES accounts(id), expires INTEGER NOT NULL
    );
    CREATE INDEX IF NOT EXISTS sessions_expiry ON sessions(expires);
    CREATE TABLE IF NOT EXISTS contacts (
      low INTEGER NOT NULL REFERENCES accounts(id), high INTEGER NOT NULL REFERENCES accounts(id),
      CHECK(low < high), PRIMARY KEY(low,high)
    );
    CREATE TABLE IF NOT EXISTS blocks (
      owner INTEGER NOT NULL REFERENCES accounts(id), peer INTEGER NOT NULL REFERENCES accounts(id),
      PRIMARY KEY(owner,peer)
    );
    CREATE TABLE IF NOT EXISTS messages (
      id INTEGER PRIMARY KEY, sender INTEGER NOT NULL REFERENCES accounts(id),
      recipient INTEGER NOT NULL REFERENCES accounts(id), text TEXT NOT NULL, created INTEGER NOT NULL
    );
    CREATE INDEX IF NOT EXISTS messages_thread ON messages(sender,recipient,id);
    CREATE TABLE IF NOT EXISTS reports (
      reporter INTEGER NOT NULL REFERENCES accounts(id), message INTEGER NOT NULL REFERENCES messages(id),
      created INTEGER NOT NULL, PRIMARY KEY(reporter,message)
    );
  `);
  const q = sql => db.prepare(sql);
  const second = () => Math.floor(now() / 1000);
  const byHandle = q('SELECT * FROM accounts WHERE handle=?');
  const pairExists = q('SELECT 1 FROM contacts WHERE low=? AND high=?');
  const blockExists = q('SELECT 1 FROM blocks WHERE (owner=? AND peer=?) OR (owner=? AND peer=?)');
  const session = q(`
    SELECT accounts.* FROM accounts JOIN sessions ON sessions.account=accounts.id
    WHERE token=? AND expires>?
  `);
  const dummySalt = randomBytes(16).toString('hex');
  let authWindow = -1;
  let authCount = 0;
  let authActive = 0;
  const cookie = (token, age) => `${cookieName}=${token}; Path=/; HttpOnly; SameSite=Strict; Max-Age=${age}` +
    (url.protocol === 'https:' ? '; Secure' : '');

  function allowContact(left, right) {
    const a = byHandle.get(normalize(left));
    const b = byHandle.get(normalize(right));
    ensure(a && b && a.id !== b.id, 400, 'Deux comptes distincts sont requis.');
    q('INSERT OR IGNORE INTO contacts(low,high) VALUES(?,?)').run(...pair(a.id,b.id));
  }
  function allowed(a, b) {
    return pairExists.get(...pair(a,b)) && !blockExists.get(a,b,b,a);
  }
  function peerFor(me, handle) {
    const peer = byHandle.get(normalize(handle));
    ensure(peer && allowed(me.id, peer.id), 404, 'Contact indisponible.');
    return peer;
  }
  async function authenticate(request, register) {
    const minute = Math.floor(second() / 60);
    if (minute !== authWindow) {
      authWindow = minute;
      authCount = 0;
    }
    ensure(authCount < maxAuthPerMinute && authActive < 4, 429, 'Réessayez dans un instant.');
    authCount++;
    authActive++;
    try {
      const data = await readJson(request);
      const handle = normalize(data.handle);
      const password = data.password;
      ensure(handlePattern.test(handle) && typeof password === 'string' &&
        password.length >= 12 && Buffer.byteLength(password) <= 256, 400, 'Identifiant ou mot de passe invalide.');
      const existing = byHandle.get(handle);
      const salt = register ? randomBytes(16).toString('hex') : existing?.salt ?? dummySalt;
      const key = await passwordKey(password, salt);
      if (register) {
        const created = q('INSERT OR IGNORE INTO accounts(handle,salt,password) VALUES(?,?,?)')
          .run(handle, salt, key.toString('hex'));
        ensure(created.changes === 1, 409, 'Cet identifiant ne peut pas être utilisé.');
      } else {
        const valid = timingSafeEqual(key, existing ? Buffer.from(existing.password, 'hex') : Buffer.alloc(64));
        ensure(existing && valid, 401, 'Connexion refusée.');
      }
      const account = byHandle.get(handle);
      const token = randomBytes(32).toString('hex');
      q('DELETE FROM sessions WHERE expires<=?').run(second());
      q('INSERT INTO sessions(token,account,expires) VALUES(?,?,?)')
        .run(digest(token), account.id, second() + sessionSeconds);
      const previous = request.headers.get('cookie')?.match(/(?:^|;\s*)kis_session=([a-f0-9]{64})(?:;|$)/)?.[1];
      if (previous) q('DELETE FROM sessions WHERE token=?').run(digest(previous));
      return json({handle, privacy: privacy(account)}, register ? 201 : 200, {'set-cookie': cookie(token, sessionSeconds)});
    } finally {
      authActive--;
    }
  }

  async function handle(request) {
    try {
      const {origin: incoming, pathname, searchParams} = new URL(request.url);
      ensure(incoming === origin, 403, 'Origine refusée.');
      if (request.method !== 'GET') {
        ensure(request.headers.get('origin') === origin, 403, 'Origine refusée.');
      }
      const route = request.method + ' ' + pathname;
      if (route === 'POST /api/register' || route === 'POST /api/login') {
        return await authenticate(request, route.endsWith('/register'));
      }
      const token = request.headers.get('cookie')?.match(/(?:^|;\s*)kis_session=([a-f0-9]{64})(?:;|$)/)?.[1];
      const account = token && session.get(digest(token), second());
      ensure(account, 401, 'Connexion requise.');
      const me = account.id;
      const authenticatedBody = async () => {
        const data = await readJson(request);
        ensure(session.get(digest(token), second()), 401, 'Connexion requise.');
        return data;
      };
      switch (route) {
        case 'POST /api/logout':
          q('DELETE FROM sessions WHERE token=?').run(digest(token));
          return json({}, 200, {'set-cookie': cookie('', 0)});
        case 'GET /api/me':
          return json({handle: account.handle, privacy: privacy(account)});
        case 'PUT /api/privacy': {
          const {mode, requested} = await authenticatedBody();
          ensure(typeof mode === 'string' && Object.hasOwn(modes, mode) &&
            Array.isArray(requested) && requested.length <= options.length &&
            requested.every(option => options.includes(option)), 400, 'Réglages invalides.');
          const extra = JSON.stringify([...new Set(requested)]);
          q('UPDATE accounts SET mode=?,extra=? WHERE id=?').run(mode, extra, me);
          return json(privacy({mode, extra}));
        }
        case 'GET /api/contacts': {
          const rows = q(`
            SELECT a.handle FROM contacts c JOIN accounts a
            ON a.id=CASE WHEN c.low=? THEN c.high ELSE c.low END
            WHERE (c.low=? OR c.high=?) AND NOT EXISTS(
              SELECT 1 FROM blocks b WHERE (b.owner=? AND b.peer=a.id) OR (b.owner=a.id AND b.peer=?)
            ) ORDER BY a.handle LIMIT 100
          `).all(me,me,me,me,me);
          return json(rows.map(row => row.handle));
        }
        case 'GET /api/messages': {
          const peer = peerFor(account, searchParams.get('peer'));
          const before = Number(searchParams.get('before') ?? Number.MAX_SAFE_INTEGER);
          ensure(Number.isSafeInteger(before) && before > 0, 400, 'Curseur invalide.');
          const rows = q(`
            SELECT id, sender=? AS mine, text, created FROM messages
            WHERE ((sender=? AND recipient=?) OR (sender=? AND recipient=?)) AND id<?
            ORDER BY id DESC LIMIT 51
          `).all(me,me,peer.id,peer.id,me,before);
          return json({messages: rows.slice(0,50).reverse(), next: rows.length === 51 ? rows[49].id : null});
        }
        case 'POST /api/messages': {
          const {peer: handle, text} = await authenticatedBody();
          const peer = peerFor(account, handle);
          ensure(typeof text === 'string' && text.trim() && text.length <= 2000 &&
            !/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/u.test(text), 400, 'Message invalide.');
          const recent = q('SELECT COUNT(*) AS total FROM messages WHERE sender=? AND created>?').get(me,second()-60);
          ensure(recent.total < 20, 429, 'Trop de messages.');
          const {lastInsertRowid} = q('INSERT INTO messages(sender,recipient,text,created) VALUES(?,?,?,?)')
            .run(me,peer.id,text.trim(),second());
          return json({id: lastInsertRowid}, 201);
        }
        case 'POST /api/block': {
          const {peer: handle} = await authenticatedBody();
          const peer = byHandle.get(normalize(handle));
          ensure(peer && pairExists.get(...pair(me,peer.id)), 404, 'Contact indisponible.');
          q('INSERT OR IGNORE INTO blocks(owner,peer) VALUES(?,?)').run(me,peer.id);
          return json({});
        }
        case 'POST /api/report': {
          const {message} = await authenticatedBody();
          ensure(Number.isSafeInteger(message) &&
            q('SELECT 1 FROM messages WHERE id=? AND recipient=?').get(message,me), 404, 'Message indisponible.');
          q('INSERT OR IGNORE INTO reports(reporter,message,created) VALUES(?,?,?)').run(me,message,second());
          return json({}, 201);
        }
        default:
          throw new HttpError(404, 'Route indisponible.');
      }
    } catch (error) {
      if (error instanceof HttpError) return json({error: error.message}, error.status);
      console.error('Erreur interne KIS', error.code ?? error.name);
      return json({error: 'Service indisponible.'}, 500);
    }
  }
  function listReports() {
    return q(`
      SELECT r.message AS id, a.handle AS reporter, b.handle AS sender, m.text, r.created
      FROM reports r JOIN accounts a ON a.id=r.reporter
      JOIN messages m ON m.id=r.message JOIN accounts b ON b.id=m.sender
      ORDER BY r.created DESC LIMIT 100
    `).all();
  }
  return {handle, allowContact, listReports, close: () => db.close()};
}
