import { DatabaseSync } from 'node:sqlite';
import { createHash, randomBytes, scrypt, timingSafeEqual } from 'node:crypto';
import { createCalls } from './calls.mjs';
import { prepareEncryption } from './encryption.mjs';
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
async function readBody(request, limit) {
  ensure(request.body, 400, 'Corps manquant.');
  const reader = request.body.getReader();
  const chunks = [];
  let size = 0;
  for (;;) {
    const {done, value} = await reader.read();
    if (done) break;
    size += value.length;
    if (size > limit) {
      await reader.cancel();
      throw new HttpError(413, 'Requête trop volumineuse.');
    }
    chunks.push(value);
  }
  return Buffer.concat(chunks);
}
async function readJson(request, limit = bodyLimit) {
  ensure(request.headers.get('content-type')?.split(';')[0].trim() === 'application/json',415,'JSON requis.');
  const body = await readBody(request,limit);
  let value;
  try {
    value = JSON.parse(body.toString('utf8'));
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

export function openService({filename, origin, keyHex, backupKey, recognize, turnUrl, turnSecret, now = Date.now, maxAuthPerMinute = 24}) {
  const url = new URL(origin);
  ensure(url.origin === origin && (url.protocol === 'https:' ||
    (url.protocol === 'http:' && url.hostname === '127.0.0.1')), 500, 'Origine HTTPS ou locale requise.');
  const db = new DatabaseSync(filename);
  db.exec(`
    PRAGMA foreign_keys = ON;
    PRAGMA journal_mode = WAL;
    PRAGMA busy_timeout = 5000;
    CREATE TABLE IF NOT EXISTS encryption_meta (
      id INTEGER PRIMARY KEY CHECK(id=1), sealed TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS accounts (
      id INTEGER PRIMARY KEY, handle TEXT UNIQUE NOT NULL,
      salt TEXT NOT NULL, password TEXT NOT NULL,
      mode TEXT NOT NULL DEFAULT 'private' CHECK(mode IN ('public','private','ultra')),
      extra TEXT NOT NULL DEFAULT '[]'
    );
    CREATE TABLE IF NOT EXISTS safety (
      account INTEGER PRIMARY KEY REFERENCES accounts(id),
      age TEXT NOT NULL DEFAULT 'unknown' CHECK(age IN ('unknown','minor','adult')),
      guardian INTEGER NOT NULL DEFAULT 0 CHECK(guardian IN (0,1)),
      communications INTEGER NOT NULL DEFAULT 0 CHECK(communications IN (0,1)),
      music INTEGER NOT NULL DEFAULT 0 CHECK(music IN (0,1)),
      attested INTEGER, attestation TEXT, consent_updated INTEGER
    );
    CREATE TABLE IF NOT EXISTS sessions (
      token TEXT PRIMARY KEY, account INTEGER NOT NULL REFERENCES accounts(id), expires INTEGER NOT NULL
    );
    CREATE INDEX IF NOT EXISTS sessions_expiry ON sessions(expires);
    CREATE TABLE IF NOT EXISTS contacts (
      low INTEGER NOT NULL REFERENCES accounts(id), high INTEGER NOT NULL REFERENCES accounts(id),
      CHECK(low < high), PRIMARY KEY(low,high)
    );
    CREATE TABLE IF NOT EXISTS contact_approvals (
      low INTEGER NOT NULL, high INTEGER NOT NULL, low_attestation TEXT NOT NULL, high_attestation TEXT NOT NULL,
      PRIMARY KEY(low,high), FOREIGN KEY(low,high) REFERENCES contacts(low,high)
    );
    CREATE TABLE IF NOT EXISTS blocks (
      owner INTEGER NOT NULL REFERENCES accounts(id), peer INTEGER NOT NULL REFERENCES accounts(id),
      PRIMARY KEY(owner,peer)
    );
    CREATE TABLE IF NOT EXISTS messages (
      id INTEGER PRIMARY KEY, sender INTEGER NOT NULL REFERENCES accounts(id),
      recipient INTEGER NOT NULL REFERENCES accounts(id), text TEXT NOT NULL, created INTEGER NOT NULL
    );
    CREATE TABLE IF NOT EXISTS message_requests (
      sender INTEGER NOT NULL REFERENCES accounts(id), request TEXT NOT NULL,
      message INTEGER NOT NULL UNIQUE REFERENCES messages(id), PRIMARY KEY(sender,request)
    );
    CREATE INDEX IF NOT EXISTS messages_thread ON messages(sender,recipient,id);
    CREATE INDEX IF NOT EXISTS messages_recipient ON messages(recipient,id);
    CREATE TABLE IF NOT EXISTS social_posts (
      id INTEGER PRIMARY KEY, author INTEGER NOT NULL REFERENCES accounts(id),
      text TEXT NOT NULL, created INTEGER NOT NULL,
      audience TEXT NOT NULL CHECK(audience IN ('self','contacts')),
      withdrawn INTEGER NOT NULL DEFAULT 0 CHECK(withdrawn IN (0,1))
    );
    CREATE INDEX IF NOT EXISTS social_author ON social_posts(author,id);
    CREATE TABLE IF NOT EXISTS social_reports (
      reporter INTEGER NOT NULL REFERENCES accounts(id), post INTEGER NOT NULL REFERENCES social_posts(id),
      created INTEGER NOT NULL, PRIMARY KEY(reporter,post)
    );
    CREATE TABLE IF NOT EXISTS reports (
      reporter INTEGER NOT NULL REFERENCES accounts(id), message INTEGER NOT NULL REFERENCES messages(id),
      created INTEGER NOT NULL, PRIMARY KEY(reporter,message)
    );
  `);
  let encryption;
  try {
    encryption = prepareEncryption(db,keyHex,filename,backupKey);
  } catch (error) {
    db.close();
    throw error;
  }
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
  let musicActive = 0;
  const musicQuota = new Map();
  const musicRequests = new Map();
  function stopMusic(id, sessionHash) {
    const pending = musicRequests.get(id);
    if (pending && (!sessionHash || pending.sessionHash === sessionHash)) pending.controller.abort();
  }
  const cookie = (token, age) => `${cookieName}=${token}; Path=/; HttpOnly; SameSite=Strict; Max-Age=${age}` +
    (url.protocol === 'https:' ? '; Secure' : '');

  const findSafety = q('SELECT age,guardian,communications,music,attestation FROM safety WHERE account=?');
  const approval = q(`
    SELECT 1 FROM contact_approvals c JOIN safety a ON a.account=c.low JOIN safety b ON b.account=c.high
    WHERE c.low=? AND c.high=? AND c.low_attestation=a.attestation AND c.high_attestation=b.attestation
  `);
  function safetyFor(id) {
    const row = findSafety.get(id);
    return {
      age: row?.age ?? 'unknown',
      guardian: Boolean(row?.guardian),
      communications: Boolean(row?.communications),
      music: Boolean(row?.music),
      musicAvailable: Boolean(recognize)
    };
  }
  function permitsCommunication(a, b) {
    const first = safetyFor(a);
    const second = safetyFor(b);
    return first.age !== 'unknown' && first.age === second.age &&
      first.communications && second.communications &&
      (first.age === 'adult' || (first.guardian && second.guardian));
  }
  const callEligible = (a,b) => safetyFor(a).age === 'adult' && allowed(a,b);
  const calls = createCalls({turnUrl,turnSecret,second,eligible:callEligible});
  function attestAge(handle, age, guardian = false) {
    const account = byHandle.get(normalize(handle));
    ensure(account && ['adult','minor','unknown'].includes(age) && (!guardian || age === 'minor'),
      400, 'Attestation invalide.');
    stopMusic(account.id);
    q(`
      INSERT INTO safety(account,age,guardian,attested,attestation) VALUES(?,?,?,?,?)
      ON CONFLICT(account) DO UPDATE SET age=excluded.age,guardian=excluded.guardian,
      attested=excluded.attested,attestation=excluded.attestation,communications=0,music=0,consent_updated=NULL
    `).run(account.id,age,Number(guardian),second(),randomBytes(16).toString('hex'));
  }
  function allowContact(left, right) {
    const a = byHandle.get(normalize(left));
    const b = byHandle.get(normalize(right));
    ensure(a && b && a.id !== b.id, 400, 'Deux comptes distincts sont requis.');
    const [low,high] = pair(a.id,b.id);
    db.exec('BEGIN IMMEDIATE');
    try {
      ensure(permitsCommunication(low,high),403,'Âge ou consentement à vérifier.');
      q('INSERT OR IGNORE INTO contacts(low,high) VALUES(?,?)').run(low,high);
      q(`
        INSERT INTO contact_approvals(low,high,low_attestation,high_attestation) VALUES(?,?,?,?)
        ON CONFLICT(low,high) DO UPDATE SET low_attestation=excluded.low_attestation,high_attestation=excluded.high_attestation
      `).run(low,high,findSafety.get(low).attestation,findSafety.get(high).attestation);
      db.exec('COMMIT');
    } catch (error) {
      db.exec('ROLLBACK');
      throw error;
    }
  }
  function allowed(a, b) {
    return permitsCommunication(a,b) && approval.get(...pair(a,b)) && !blockExists.get(a,b,b,a);
  }
  function canSharePost(account) {
    const safety = safetyFor(account.id);
    return account.mode !== 'ultra' && safety.age === 'adult' && safety.communications;
  }
  function canReadPost(viewer,row) {
    if (row.withdrawn) return false;
    if (row.author === viewer.id) return true;
    return row.audience === 'contacts' && canSharePost(viewer) &&
      canSharePost({id:row.author,mode:row.mode}) && Boolean(allowed(viewer.id,row.author));
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
      return json({handle, privacy: privacy(account), safety:safetyFor(account.id)}, register ? 201 : 200, {'set-cookie': cookie(token, sessionSeconds)});
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
      const authenticatedBody = async limit => {
        const data = await readJson(request,limit);
        ensure(session.get(digest(token), second()), 401, 'Connexion requise.');
        return data;
      };
      switch (route) {
        case 'POST /api/logout':
          stopMusic(me,digest(token));
          q('DELETE FROM sessions WHERE token=?').run(digest(token));
          return json({}, 200, {'set-cookie': cookie('', 0)});
        case 'GET /api/me':
          return json({handle: account.handle, privacy: privacy(account), safety:safetyFor(me)});
        case 'PUT /api/consent': {
          const {communications,music} = await authenticatedBody();
          const current = safetyFor(me);
          ensure(typeof communications === 'boolean' && typeof music === 'boolean',400,'Consentement invalide.');
          ensure(!communications || current.age === 'adult' || (current.age === 'minor' && current.guardian),
            403,'Autorisation de communication requise.');
          ensure(!music || current.age === 'adult',403,'Reconnaissance réservée aux comptes adultes attestés.');
          q(`
            INSERT INTO safety(account,communications,music,consent_updated) VALUES(?,?,?,?)
            ON CONFLICT(account) DO UPDATE SET communications=excluded.communications,
            music=excluded.music,consent_updated=excluded.consent_updated
          `).run(me,Number(communications),Number(music),second());
          if (!music) stopMusic(me);
          return json(safetyFor(me));
        }
        case 'GET /api/social': {
          const rows = q(`
            SELECT p.*,a.handle,a.mode FROM social_posts p JOIN accounts a ON a.id=p.author
            WHERE p.withdrawn=0 AND (p.author=? OR (p.audience='contacts' AND EXISTS(
              SELECT 1 FROM contacts c WHERE (c.low=? AND c.high=p.author) OR (c.high=? AND c.low=p.author)
            )))
            ORDER BY p.id DESC LIMIT 300
          `).all(me,me,me);
          const posts = rows.filter(row => canReadPost(account,row)).slice(0,50).map(row => ({
            id:row.id,handle:row.handle,mine:row.author === me,text:encryption.readPost(row),
            audience:row.author === me ? row.audience : undefined
          }));
          return json({posts,sharingAvailable:canSharePost(account)});
        }
        case 'POST /api/social': {
          const {text,audience} = await authenticatedBody();
          ensure(typeof text === 'string' && text.trim() && text.length <= 1000 &&
            ['self','contacts'].includes(audience),400,'Publication invalide.');
          const created = second();
          db.exec('BEGIN IMMEDIATE');
          try {
            const viewer = session.get(digest(token),second());
            ensure(viewer && (audience === 'self' || canSharePost(viewer)),403,'Partage non autorisé.');
            const total = q('SELECT COUNT(*) AS total FROM social_posts WHERE author=? AND created>?').get(me,created-3600).total;
            ensure(total < 10,429,'Trop de publications.');
            const {lastInsertRowid:id} = q('INSERT INTO social_posts(author,text,created,audience) VALUES(?,?,?,?)')
              .run(me,'',created,audience);
            q('UPDATE social_posts SET text=? WHERE id=?').run(encryption.sealPost(id,me,created,text.trim()),id);
            db.exec('COMMIT');
            return json({id},201);
          } catch (error) {
            db.exec('ROLLBACK');
            throw error;
          }
        }
        case 'POST /api/social/withdraw': {
          const {id} = await authenticatedBody();
          ensure(Number.isSafeInteger(id) &&
            q('UPDATE social_posts SET withdrawn=1 WHERE id=? AND author=?').run(id,me).changes,404,'Publication indisponible.');
          return json({});
        }
        case 'POST /api/social/report': {
          const {id} = await authenticatedBody();
          const row = Number.isSafeInteger(id) && q(`
            SELECT p.*,a.mode FROM social_posts p JOIN accounts a ON a.id=p.author WHERE p.id=?
          `).get(id);
          const viewer = session.get(digest(token),second());
          ensure(row && row.author !== me && viewer && canReadPost(viewer,row),404,'Publication indisponible.');
          q('INSERT OR IGNORE INTO social_reports(reporter,post,created) VALUES(?,?,?)').run(me,id,second());
          return json({},201);
        }
        case 'GET /api/notifications': {
          const after = Number(searchParams.get('after') ?? 0);
          ensure(Number.isSafeInteger(after) && after >= 0,400,'Curseur invalide.');
          const latest = q('SELECT COALESCE(MAX(id),0) AS id FROM messages WHERE recipient=?').get(me).id;
          const rows = q(`
            SELECT sender,COUNT(*) AS total FROM messages WHERE recipient=? AND id>?
            GROUP BY sender
          `).all(me,after);
          const count = rows.filter(row => allowed(me,row.sender)).reduce((sum,row) => sum + row.total,0);
          return json({latest,count});
        }
        case 'GET /api/calls': {
          const {body} = calls.process('status',account);
          return json(body);
        }
        case 'GET /api/calls/ice': {
          ensure(safetyFor(me).age === 'adult' && safetyFor(me).communications,403,'Appels réservés aux comptes adultes ayant consenti.');
          const result = calls.process('ice',account);
          return json(result.body,result.status);
        }
        case 'POST /api/calls': {
          const {action,id,kind,sdp,peer} = await authenticatedBody(32_768);
          ensure(['offer','answer','end'].includes(action),400,'Action invalide.');
          const target = action === 'offer' ? peerFor(account,peer) : null;
          const result = calls.process(action,account,{id,kind,sdp},target);
          return json(result.body,result.status);
        }
        case 'POST /api/music/identify': {
          ensure(recognize,503,'Reconnaissance musicale non configurée.');
          const eligibility = safetyFor(me);
          ensure(eligibility.age === 'adult' && eligibility.music,403,'Consentement musical requis.');
          const mime = request.headers.get('content-type')?.split(';')[0].trim();
          ensure(['audio/webm','audio/mp4','audio/ogg','audio/wav','audio/mpeg'].includes(mime),415,'Format audio non pris en charge.');
          const clip = await readBody(request,2*1024*1024);
          ensure(clip.length > 0,400,'Extrait audio manquant.');
          const current = safetyFor(me);
          ensure(session.get(digest(token),second()) && current.age === 'adult' && current.music,403,'Consentement musical requis.');
          const stamp = second();
          for (const [id, time] of musicQuota) if (time <= stamp-60) musicQuota.delete(id);
          ensure(!musicQuota.has(me) && !musicRequests.has(me) && musicActive < 2,429,'Réessayez dans un instant.');
          musicQuota.set(me,stamp);
          musicActive++;
          const controller = new AbortController();
          const sessionHash = digest(token);
          musicRequests.set(me,{controller,sessionHash});
          const isAllowed = () => {
            const latest = safetyFor(me);
            return session.get(sessionHash,second()) && latest.age === 'adult' && latest.music;
          };
          try {
            if (!isAllowed() || request.signal.aborted) return json({error:'Reconnaissance interrompue.'},403);
            const answer = await recognize(clip,mime,AbortSignal.any([request.signal,controller.signal]));
            if (!isAllowed() || controller.signal.aborted || request.signal.aborted) {
              return json({error:'Reconnaissance interrompue.'},403);
            }
            return json(answer);
          } catch {
            if (controller.signal.aborted || request.signal.aborted || !isAllowed()) {
              return json({error:'Reconnaissance interrompue.'},403);
            }
            throw new HttpError(502,'Service de reconnaissance indisponible.');
          } finally {
            musicRequests.delete(me);
            musicActive--;
          }
        }
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
            SELECT a.id,a.handle FROM contacts c JOIN accounts a
            ON a.id=CASE WHEN c.low=? THEN c.high ELSE c.low END
            WHERE (c.low=? OR c.high=?) AND NOT EXISTS(
              SELECT 1 FROM blocks b WHERE (b.owner=? AND b.peer=a.id) OR (b.owner=a.id AND b.peer=?)
            ) ORDER BY a.handle LIMIT 100
          `).all(me,me,me,me,me);
          return json(rows.filter(row => allowed(me,row.id)).map(row => row.handle));
        }
        case 'GET /api/messages': {
          const peer = peerFor(account, searchParams.get('peer'));
          const before = Number(searchParams.get('before') ?? Number.MAX_SAFE_INTEGER);
          ensure(Number.isSafeInteger(before) && before > 0, 400, 'Curseur invalide.');
          const rows = q(`
            SELECT id,sender,recipient,sender=? AS mine,text,created FROM messages
            WHERE ((sender=? AND recipient=?) OR (sender=? AND recipient=?)) AND id<?
            ORDER BY id DESC LIMIT 51
          `).all(me,me,peer.id,peer.id,me,before);
          return json({messages: rows.slice(0,50).reverse().map(row => ({id:row.id,mine:row.mine,text:encryption.readMessage(row),created:row.created})), next: rows.length === 51 ? rows[49].id : null});
        }
        case 'POST /api/messages': {
          const {peer: handle, text, requestId} = await authenticatedBody();
          const peer = peerFor(account, handle);
          ensure(typeof text === 'string' && text.trim() && text.length <= 2000 &&
            !/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/u.test(text), 400, 'Message invalide.');
          ensure(requestId === undefined || (typeof requestId === 'string' &&
            /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(requestId)),
            400,'Identifiant d’envoi invalide.');
          const created = second();
          db.exec('BEGIN IMMEDIATE');
          try {
            ensure(allowed(me,peer.id),404,'Contact indisponible.');
            if (requestId) {
              const prior = q(`
                SELECT m.* FROM message_requests r JOIN messages m ON m.id=r.message
                WHERE r.sender=? AND r.request=?
              `).get(me,requestId);
              if (prior) {
                ensure(prior.recipient === peer.id && encryption.readMessage(prior) === text.trim(),
                  409,'Cet identifiant correspond déjà à un autre envoi.');
                db.exec('COMMIT');
                return json({id:prior.id},200);
              }
            }
            const recent = q('SELECT COUNT(*) AS total FROM messages WHERE sender=? AND created>?').get(me,created-60);
            ensure(recent.total < 20,429,'Trop de messages.');
            const {lastInsertRowid:id} = q('INSERT INTO messages(sender,recipient,text,created) VALUES(?,?,?,?)')
              .run(me,peer.id,'',created);
            const sealed = encryption.sealMessage(id,me,peer.id,created,text.trim());
            q('UPDATE messages SET text=? WHERE id=?').run(sealed,id);
            if (requestId) q('INSERT INTO message_requests(sender,request,message) VALUES(?,?,?)').run(me,requestId,id);
            db.exec('COMMIT');
            return json({id},201);
          } catch (error) {
            db.exec('ROLLBACK');
            throw error;
          }
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
      SELECT r.message AS id,a.handle AS reporter,b.handle AS senderHandle,m.sender,m.recipient,m.text,m.created,r.created AS reported
      FROM reports r JOIN accounts a ON a.id=r.reporter
      JOIN messages m ON m.id=r.message JOIN accounts b ON b.id=m.sender
      ORDER BY r.created DESC LIMIT 100
    `).all().map(row => ({id:row.id,reporter:row.reporter,sender:row.senderHandle,text:encryption.readMessage(row),created:row.reported}));
  }
  function listSocialReports() {
    return q(`
      SELECT p.id,p.author,p.text,p.created,r.created AS reported,a.handle AS reporter,b.handle AS authorHandle
      FROM social_reports r JOIN social_posts p ON p.id=r.post
      JOIN accounts a ON a.id=r.reporter JOIN accounts b ON b.id=p.author ORDER BY r.created DESC LIMIT 100
    `).all().map(row => ({id:row.id,reporter:row.reporter,author:row.authorHandle,text:encryption.readPost(row),created:row.reported}));
  }
  return {handle, allowContact, attestAge, listReports, listSocialReports, close: () => db.close()};
}
