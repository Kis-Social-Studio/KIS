import { createServer } from 'node:http';
import { Readable } from 'node:stream';
import { createHash } from 'node:crypto';
import { mkdirSync, readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join, resolve } from 'node:path';
import { openService } from './service.mjs';

process.umask(0o077);
const port = Number(process.env.KIS_PORT ?? 8787);
if (!Number.isInteger(port) || port < 1024 || port > 65535) throw Error('KIS_PORT invalide.');
const origin = process.env.KIS_ORIGIN ?? `http://127.0.0.1:${port}`;
const {host} = new URL(origin);
const data = resolve(process.env.KIS_DATA ?? join(homedir(), '.kis-data'));
mkdirSync(data, {recursive: true, mode: 0o700});
const service = openService({filename: join(data, 'kis.sqlite'), origin});
const [command, left, right] = process.argv.slice(2);

if (command) {
  try {
    if (command === 'approve-contact' && left && right) {
      service.allowContact(left, right);
      console.log('Contact autorisé.');
    } else if (command === 'list-reports' && !left) {
      console.log(JSON.stringify(service.listReports(), null, 2));
    } else {
      throw Error('Commandes : approve-contact utilisateur utilisateur ou list-reports');
    }
  } finally {
    service.close();
  }
} else {
  const page = readFileSync(new URL('../index.html', import.meta.url), 'utf8');
  const hashes = tag => [...page.matchAll(new RegExp('<' + tag + '>([\\s\\S]*?)</' + tag + '>', 'g'))]
    .map(([, code]) => "'sha256-" + createHash('sha256').update(code).digest('base64') + "'")
    .join(' ');
  const csp = "default-src 'none'; connect-src 'self'; form-action 'self'; frame-ancestors 'none'; base-uri 'none'; " +
    'script-src ' + hashes('script') + '; style-src ' + hashes('style');
  const server = createServer({requestTimeout: 15_000, headersTimeout: 10_000}, async (req, res) => {
    res.setHeader('content-security-policy', csp);
    res.setHeader('referrer-policy', 'no-referrer');
    res.setHeader('x-content-type-options', 'nosniff');
    res.setHeader('cache-control', 'no-store');
    if (req.headers.host !== host || !req.url?.startsWith('/') || req.url.startsWith('//')) {
      res.writeHead(400).end();
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
    if (Number(req.headers['content-length']) > 8192) {
      res.writeHead(413, {'connection': 'close'}).end();
      return;
    }
    try {
      const hasBody = !['GET', 'HEAD'].includes(req.method);
      const address = new URL(req.url, origin);
      const request = new Request(address, {
        method: req.method, headers: req.headers,
        ...(hasBody ? {body: Readable.toWeb(req), duplex: 'half'} : {})
      });
      const response = await service.handle(request);
      res.writeHead(response.status, Object.fromEntries(response.headers));
      res.end(await response.text());
    } catch (error) {
      console.error('Adaptateur KIS', error.code ?? error.name);
      if (!res.headersSent) res.writeHead(500);
      res.end();
    }
  });
  server.listen(port, '127.0.0.1', () => console.log('KIS prêt sur ' + origin));
}
