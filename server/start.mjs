import { createServer } from 'node:http';
import { createServer as createTlsServer } from 'node:https';
import { Readable } from 'node:stream';
import { createHash, timingSafeEqual } from 'node:crypto';
import { mkdirSync, readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join, resolve } from 'node:path';
import { createRecognizer } from './music.mjs';
import { openService } from './service.mjs';

function sameSecret(left,right) {
  const digest = value => createHash('sha256').update(value).digest();
  return timingSafeEqual(digest(left),digest(right));
}

process.umask(0o077);
const port = Number(process.env.KIS_PORT ?? 8787);
if (!Number.isInteger(port) || port < 1024 || port > 65535) throw Error('KIS_PORT invalide.');
const origin = process.env.KIS_ORIGIN ?? `http://127.0.0.1:${port}`;
const {host} = new URL(origin);
const data = resolve(process.env.KIS_DATA ?? join(homedir(), '.kis-data'));
mkdirSync(data, {recursive: true, mode: 0o700});
const service = openService({
  filename:join(data,'kis.sqlite'),origin,keyHex:process.env.KIS_DATA_KEY,backupKey:process.env.KIS_BACKUP_KEY,
  recognize:createRecognizer(process.env.KIS_MUSIC_TOKEN),
  turnUrl:process.env.KIS_TURN_URL,turnSecret:process.env.KIS_TURN_SECRET
});
const [command, left, right, guardian] = process.argv.slice(2);

if (command) {
  try {
    if (command === 'approve-contact' && left && right) {
      service.allowContact(left, right);
      console.log('Contact autorisé.');
    } else if (command === 'attest-age' && left && right && (!guardian || guardian === 'guardian-approved')) {
      service.attestAge(left,right,Boolean(guardian));
      console.log('Attestation enregistrée. Le compte doit confirmer ses consentements.');
    } else if (command === 'list-social-reports' && !left) {
      console.log(JSON.stringify(service.listSocialReports(),null,2));
    } else if (command === 'list-reports' && !left) {
      console.log(JSON.stringify(service.listReports(), null, 2));
    } else {
      throw Error('Commandes : approve-contact A B, attest-age compte adult|minor|unknown [guardian-approved], list-reports, list-social-reports');
    }
  } finally {
    service.close();
  }
} else {
  const page = readFileSync(new URL('../index.html', import.meta.url), 'utf8');
  const hashes = tag => [...page.matchAll(new RegExp('<' + tag + '>([\\s\\S]*?)</' + tag + '>', 'g'))]
    .map(([, code]) => "'sha256-" + createHash('sha256').update(code).digest('base64') + "'")
    .join(' ');
  const csp = "default-src 'none'; connect-src 'self'; media-src 'self' blob:; img-src blob:; form-action 'self'; frame-ancestors 'none'; base-uri 'none'; " +
    'script-src ' + hashes('script') + '; style-src ' + hashes('style');
  const {KIS_TLS_KEY, KIS_TLS_CERT, KIS_STAGE_USER, KIS_STAGE_PASSWORD} = process.env;
  if (Boolean(KIS_TLS_KEY) !== Boolean(KIS_TLS_CERT)) throw Error('Configurer la clé et le certificat TLS ensemble.');
  const privateStage = Boolean(KIS_TLS_KEY) || process.env.KIS_TLS_TERMINATED_PROXY === '1';
  if (privateStage && (!origin.startsWith('https:') || !KIS_STAGE_USER || !KIS_STAGE_PASSWORD || KIS_STAGE_PASSWORD.length < 20)) {
    throw Error('Origine HTTPS et accès de préproduction requis.');
  }
  const credentials = privateStage && 'Basic ' + Buffer.from(KIS_STAGE_USER + ':' + KIS_STAGE_PASSWORD).toString('base64');
  const options = {requestTimeout:15_000,headersTimeout:10_000};
  const serve = async (req,res) => {
    res.setHeader('content-security-policy', csp);
    res.setHeader('referrer-policy', 'no-referrer');
    res.setHeader('permissions-policy','camera=(self), microphone=(self), geolocation=()');
    res.setHeader('x-content-type-options', 'nosniff');
    res.setHeader('cache-control', 'no-store');
    if (req.headers.host !== host || !req.url?.startsWith('/') || req.url.startsWith('//')) {
      res.writeHead(400).end();
      return;
    }
    if (credentials && !sameSecret(credentials,req.headers.authorization ?? '')) {
      res.writeHead(401,{'www-authenticate':'Basic realm="KIS préproduction"'}).end();
      return;
    }
    if (req.method === 'GET' && ['/', '/index.html'].includes(req.url)) {
      res.writeHead(200, {'content-type': 'text/html; charset=utf-8'}).end(page);
      return;
    }
    if (!req.url.startsWith('/api/')) {
      res.writeHead(404).end();
      return;
    }
    const limit = req.url === '/api/music/identify' ? 2*1024*1024 : req.url === '/api/calls' ? 32_768 : 8192;
    if (Number(req.headers['content-length']) > limit) {
      res.writeHead(413, {'connection': 'close'}).end();
      return;
    }
    const connection = new AbortController();
    res.once('close',() => { if (!res.writableEnded) connection.abort(); });
    try {
      const hasBody = !['GET', 'HEAD'].includes(req.method);
      const address = new URL(req.url, origin);
      const request = new Request(address, {
        method: req.method, headers: req.headers, signal:connection.signal,
        ...(hasBody ? {body: Readable.toWeb(req), duplex: 'half'} : {})
      });
      const response = await service.handle(request);
      if (res.destroyed) return;
      res.writeHead(response.status, Object.fromEntries(response.headers));
      res.end(await response.text());
    } catch (error) {
      console.error('Adaptateur KIS', error.code ?? error.name);
      if (!res.headersSent) res.writeHead(500);
      res.end();
    }
  };
  const server = KIS_TLS_KEY
    ? createTlsServer({...options,key:readFileSync(KIS_TLS_KEY),cert:readFileSync(KIS_TLS_CERT),minVersion:'TLSv1.2'},serve)
    : createServer(options,serve);
  server.listen(port,'127.0.0.1', () => console.log('KIS prêt sur ' + origin));
}
