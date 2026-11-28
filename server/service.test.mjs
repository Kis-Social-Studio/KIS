import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { DatabaseSync } from 'node:sqlite';
import { openService } from './service.mjs';

const origin = 'https://kis.example';
const password = 'mot de passe de prétest';

test('comptes, confidentialité, contacts approuvés et messages persistants', async t => {
  const dir = mkdtempSync(join(tmpdir(), 'kis-test-'));
  const file = join(dir, 'db.sqlite');
  let now = 1_800_000_000_000;
  let service = openService({filename:file, origin, now: () => now});
  t.after(() => { service.close(); rmSync(dir, {recursive:true}); });

  async function call(path, {method = 'GET', data, cookie, from = origin, status = 200} = {}) {
    const headers = {origin:from};
    if (cookie) headers.cookie = cookie;
    if (data !== undefined) headers['content-type'] = 'application/json';
    const response = await service.handle(new Request(origin + '/api/' + path, {
      method, headers, body:data === undefined ? undefined : JSON.stringify(data)
    }));
    const result = await response.json();
    assert.equal(response.status, status, path + ' ' + JSON.stringify(result));
    assert.equal(response.headers.get('cache-control'), 'no-store');
    return {result, cookie:response.headers.get('set-cookie')};
  }
  async function register(handle) {
    const result = await call('register', {method:'POST', data:{handle, password}, status:201});
    assert.match(result.cookie, /HttpOnly; SameSite=Strict; Max-Age=28800; Secure$/);
    return result.cookie.split(';')[0];
  }
  const alice = await register('alice');
  const bob = await register('bob');
  const other = await register('autre');
  await call('register', {method:'POST', data:{handle:'Alice',password}, status:409});
  await call('login', {method:'POST', data:{handle:'alice',password:'mot de passe incorrect'}, status:401});
  await call('login', {method:'POST', data:{handle:'inexistant',password}, status:401});
  await call('me', {status:401});
  const {result: initial} = await call('me', {cookie:alice});
  assert.equal(initial.privacy.mode, 'private');
  assert.equal(initial.privacy.protection, 'protected');
  assert.equal(initial.privacy.effective.length, 9);
  const baseline = ['profile','location','invites','contacts','recommendations','sharing'];
  for (const [mode,count] of [['public',6],['private',9],['ultra',12]]) {
    const {result} = await call('privacy', {method:'PUT', cookie:alice, data:{mode, requested:[]}});
    assert.equal(result.effective.length, count);
    for (const option of baseline) assert.ok(result.effective.includes(option));
  }
  await call('privacy', {method:'PUT', cookie:alice, data:{mode:'constructor',requested:[]}, status:400});
  await call('privacy', {method:'PUT', cookie:alice, data:{mode:'public',requested:['unknown']}, status:400});
  await call('privacy', {method:'PUT', cookie:alice, data:{mode:'public',requested:['online']}, from:'https://elsewhere.example', status:403});
  await call('messages', {method:'POST', cookie:alice, data:{peer:'bob',text:'Avant approbation'}, status:404});
  assert.deepEqual((await call('contacts', {cookie:alice})).result, []);
  service.allowContact('alice','bob');
  assert.deepEqual((await call('contacts', {cookie:alice})).result, ['bob']);
  await call('messages', {method:'POST', cookie:alice, data:{peer:'bob',text:'x'.repeat(9000)}, status:413});
  const sent = await call('messages', {method:'POST', cookie:alice, data:{peer:'bob',text:'<b>Texte littéral</b>'}, status:201});
  const id = sent.result.id;
  await call('messages?peer=alice', {cookie:other, status:404});
  await call('report', {method:'POST', cookie:other, data:{message:id}, status:404});
  await call('report', {method:'POST', cookie:alice, data:{message:id}, status:404});
  for (let i = 0; i < 2; i++) await call('report', {method:'POST', cookie:bob, data:{message:id}, status:201});
  assert.equal(service.listReports().length, 1);
  const thread = (await call('messages?peer=alice', {cookie:bob})).result;
  assert.equal(thread.messages[0].text, '<b>Texte littéral</b>');
  assert.equal(thread.messages[0].mine, 0);
  for (let i = 0; i < 50; i++) {
    if (i % 18 === 0) now += 61_000;
    await call('messages', {method:'POST', cookie:alice, data:{peer:'bob',text:'Message ' + i}, status:201});
  }
  const recent = (await call('messages?peer=alice', {cookie:bob})).result;
  assert.equal(recent.messages.length, 50);
  assert.ok(recent.next);
  const older = (await call('messages?peer=alice&before=' + recent.next, {cookie:bob})).result;
  assert.equal(older.messages[0].id, id);
  await call('block', {method:'POST', cookie:bob, data:{peer:'alice'}});
  await call('messages?peer=bob', {cookie:alice, status:404});
  await call('messages', {method:'POST', cookie:bob, data:{peer:'alice',text:'Bloqué'}, status:404});
  assert.deepEqual((await call('contacts', {cookie:alice})).result, []);
  service.close();
  service = openService({filename:file, origin, now: () => now});
  assert.equal((await call('me', {cookie:alice})).result.privacy.mode, 'ultra');
  assert.equal(service.listReports().length, 1);
  await call('logout', {method:'POST',cookie:alice});
  await call('me', {cookie:alice,status:401});
  now += 8 * 3600_000;
  await call('me', {cookie:other,status:401});
  const disk = new DatabaseSync(file);
  const account = disk.prepare('SELECT password,salt FROM accounts LIMIT 1').get();
  assert.equal(account.password.length, 128);
  assert.notEqual(account.password,password);
  const saved = disk.prepare('SELECT token FROM sessions LIMIT 1').get();
  assert.notEqual(saved.token,bob.split('=')[1]);
  disk.close();
});

test('quota authentification et paramètres renforcés', async t => {
  const service = openService({filename:':memory:', origin, maxAuthPerMinute:1});
  t.after(() => service.close());
  const req = () => new Request(origin + '/api/login', {method:'POST', headers:{origin, 'content-type':'application/json'},
    body: JSON.stringify({handle:'alice', password})});
  assert.equal((await service.handle(req())).status,401);
  assert.equal((await service.handle(req())).status,429);
});
