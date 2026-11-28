import assert from 'node:assert/strict';
import { mkdtempSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { DatabaseSync } from 'node:sqlite';
import { openService } from './service.mjs';
import {restoreBackup} from './backup.mjs';
import {createRecognizer} from './music.mjs';

const origin = 'https://kis.example';
const keyHex = '1'.repeat(64);
const password = 'mot de passe de prétest';

test('comptes, confidentialité, contacts approuvés et messages persistants', async t => {
  const dir = mkdtempSync(join(tmpdir(), 'kis-test-'));
  const file = join(dir, 'db.sqlite');
  let now = 1_800_000_000_000;
  let service = openService({filename:file, keyHex, origin, now: () => now});
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
  assert.throws(() => service.allowContact('alice','bob'));
  await call('consent', {method:'PUT',cookie:alice,data:{communications:true,music:false},status:403});
  service.attestAge('alice','adult');
  service.attestAge('bob','minor');
  await call('consent', {method:'PUT',cookie:bob,data:{communications:true,music:false},status:403});
  service.attestAge('bob','minor',true);
  await call('consent', {method:'PUT',cookie:bob,data:{communications:true,music:false}});
  await call('consent', {method:'PUT',cookie:alice,data:{communications:true,music:false}});
  assert.throws(() => service.allowContact('alice','bob'));
  service.attestAge('bob','adult');
  await call('consent', {method:'PUT',cookie:bob,data:{communications:true,music:false}});
  service.allowContact('alice','bob');
  assert.deepEqual((await call('contacts', {cookie:alice})).result, ['bob']);
  await call('messages', {method:'POST', cookie:alice, data:{peer:'bob',text:'x'.repeat(9000)}, status:413});
  const message = {peer:'bob',text:'<b>Texte littéral</b>',requestId:'5078ae1a-838a-4106-8f22-89a04f291ee0'};
  const sent = await call('messages',{method:'POST',cookie:alice,data:message,status:201});
  const replay = await call('messages',{method:'POST',cookie:alice,data:message});
  assert.deepEqual(replay.result,sent.result);
  await call('messages',{method:'POST',cookie:alice,data:{...message,text:'Un autre texte'},status:409});
  await call('messages',{method:'POST',cookie:alice,data:{...message,requestId:'invalide'},status:400});
  const id = sent.result.id;
  await call('messages?peer=alice', {cookie:other, status:404});
  await call('report', {method:'POST', cookie:other, data:{message:id}, status:404});
  await call('report', {method:'POST', cookie:alice, data:{message:id}, status:404});
  for (let i = 0; i < 2; i++) await call('report', {method:'POST', cookie:bob, data:{message:id}, status:201});
  assert.equal(service.listReports().length, 1);
  const thread = (await call('messages?peer=alice', {cookie:bob})).result;
  assert.equal(thread.messages[0].text, '<b>Texte littéral</b>');
  assert.equal(thread.messages[0].mine, 0);
  assert.deepEqual((await call('notifications?after=0',{cookie:bob})).result,{latest:id,count:1});
  assert.deepEqual((await call('notifications?after='+id,{cookie:bob})).result,{latest:id,count:0});
  service.attestAge('bob','adult');
  await call('consent',{method:'PUT',cookie:bob,data:{communications:true,music:false}});
  await call('messages?peer=bob',{cookie:alice,status:404});
  service.allowContact('alice','bob');
  for (let i = 0; i < 50; i++) {
    if (i % 18 === 0) now += 61_000;
    await call('messages', {method:'POST', cookie:alice, data:{peer:'bob',text:'Message ' + i}, status:201});
  }
  await call('consent', {method:'PUT',cookie:bob,data:{communications:false,music:false}});
  await call('messages?peer=bob', {cookie:alice,status:404});
  await call('consent', {method:'PUT',cookie:bob,data:{communications:true,music:false}});
  const recent = (await call('messages?peer=alice', {cookie:bob})).result;
  assert.equal(recent.messages.length, 50);
  assert.ok(recent.next);
  const older = (await call('messages?peer=alice&before=' + recent.next, {cookie:bob})).result;
  assert.equal(older.messages[0].id, id);
  await call('block', {method:'POST', cookie:bob, data:{peer:'alice'}});
  await call('messages?peer=bob', {cookie:alice, status:404});
  assert.equal((await call('notifications?after=0',{cookie:bob})).result.count,0);
  await call('messages', {method:'POST', cookie:bob, data:{peer:'alice',text:'Bloqué'}, status:404});
  assert.deepEqual((await call('contacts', {cookie:alice})).result, []);
  service.close();
  assert.throws(() => openService({filename:file,keyHex:'2'.repeat(64),origin}),/incorrecte/);
  service = openService({filename:file, keyHex, origin, now: () => now});
  assert.equal((await call('me', {cookie:alice})).result.privacy.mode, 'ultra');
  assert.equal(service.listReports().length, 1);
  await call('logout', {method:'POST',cookie:alice});
  await call('me', {cookie:alice,status:401});
  now += 8 * 3600_000;
  await call('me', {cookie:other,status:401});
  const disk = new DatabaseSync(file);
  const sealed = disk.prepare('SELECT text FROM messages WHERE id=?').get(id);
  assert.notEqual(sealed.text,'<b>Texte littéral</b>');
  assert.ok(Buffer.from(sealed.text,'base64').length > 28);
  const account = disk.prepare('SELECT password,salt FROM accounts LIMIT 1').get();
  assert.equal(account.password.length, 128);
  assert.notEqual(account.password,password);
  const saved = disk.prepare('SELECT token FROM sessions LIMIT 1').get();
  assert.notEqual(saved.token,bob.split('=')[1]);
  disk.close();
});

test('quota authentification et paramètres renforcés', async t => {
  const service = openService({filename:':memory:', keyHex, origin, maxAuthPerMinute:1});
  t.after(() => service.close());
  const req = () => new Request(origin + '/api/login', {method:'POST', headers:{origin, 'content-type':'application/json'},
    body: JSON.stringify({handle:'alice', password})});
  assert.equal((await service.handle(req())).status,401);
  assert.equal((await service.handle(req())).status,429);
});

test('sauvegarde de la base existante et chiffrement des anciens messages',t => {
  const dir = mkdtempSync(join(tmpdir(),'kis-migration-'));
  t.after(() => rmSync(dir,{recursive:true}));
  const file = join(dir,'legacy.sqlite');
  const db = new DatabaseSync(file);
  db.exec(`
    CREATE TABLE accounts(id INTEGER PRIMARY KEY,handle TEXT UNIQUE,salt TEXT,password TEXT,mode TEXT,extra TEXT);
    INSERT INTO accounts VALUES(1,'alice','','','private','[]'),(2,'bob','','','private','[]');
    CREATE TABLE messages(id INTEGER PRIMARY KEY,sender INTEGER,recipient INTEGER,text TEXT,created INTEGER);
    INSERT INTO messages VALUES(1,1,2,'contenu ancien de prétest',10);
  `);
  db.close();
  assert.throws(() => openService({filename:file,origin,keyHex}),/KIS_BACKUP_KEY/);
  const backupKey = 'a'.repeat(64);
  const service = openService({filename:file,origin,keyHex,backupKey});
  service.close();
  const backups = readdirSync(dir).filter(name => name.includes('.avant-chiffrement-'));
  assert.equal(backups.length,1);
  assert.match(backups[0],/\.kisb$/);
  const restored = join(dir,'restored.sqlite');
  restoreBackup(join(dir,backups[0]),restored,backupKey);
  const before = new DatabaseSync(restored,{readOnly:true});
  assert.equal(before.prepare('SELECT text FROM messages').get().text,'contenu ancien de prétest');
  before.close();
  const after = new DatabaseSync(file,{readOnly:true});
  assert.notEqual(after.prepare('SELECT text FROM messages').get().text,'contenu ancien de prétest');
  after.close();
});

test('Kis York et appels relayés, éligibilité et retraits de consentement', async t => {
  let forwarded = 0;
  const recognizer = createRecognizer('synthetic-token',async (url,options) => {
    forwarded++;
    assert.equal(url,'https://kisyork.dethierhelene.workers.dev/');
    assert.equal(options.headers.Authorization,'Bearer synthetic-token');
    assert.equal(options.redirect,'error');
    assert.equal(await options.body.get('file').text(),'audio-factice');
    return Response.json({match:true,title:'Titre fictif',artist:'Artiste fictif',secret:'ignored'});
  });
  const service = openService({filename:':memory:',origin,keyHex,recognize:recognizer,
    turnUrl:'turns:turn.example:5349?transport=tcp',turnSecret:'f'.repeat(40)});
  t.after(() => service.close());
  const call = async (path,{method='GET',cookie,data,clip,status=200} = {}) => {
    const headers = {origin};
    if (cookie) headers.cookie = cookie;
    if (data || clip) headers['content-type'] = clip ? 'audio/webm' : 'application/json';
    const response = await service.handle(new Request(origin+'/api/'+path,{
      method,headers,body:clip ?? (data ? JSON.stringify(data) : undefined)
    }));
    assert.equal(response.status,status,path);
    return {result:await response.json(), cookie:response.headers.get('set-cookie')?.split(';')[0]};
  };
  async function account(handle,age) {
    const {cookie} = await call('register',{method:'POST',data:{handle,password},status:201});
    service.attestAge(handle,age,age === 'minor');
    await call('consent',{method:'PUT',cookie,data:{communications:true,music:age === 'adult'}});
    return cookie;
  }
  const a = await account('alice','adult');
  const b = await account('bob','adult');
  const c = await account('zoe','minor');
  await call('music/identify',{method:'POST',cookie:c,clip:'audio-factice',status:403});
  assert.equal(forwarded,0);
  assert.deepEqual((await call('music/identify',{method:'POST',cookie:a,clip:'audio-factice'})).result,
    {match:true,title:'Titre fictif',artist:'Artiste fictif'});
  await call('music/identify',{method:'POST',cookie:a,clip:'audio-factice',status:429});
  await call('consent',{method:'PUT',cookie:a,data:{communications:true,music:false}});
  await call('music/identify',{method:'POST',cookie:a,clip:'audio-factice',status:403});
  assert.equal(forwarded,1);
  service.allowContact('alice','bob');
  const own = await call('social',{method:'POST',cookie:a,data:{text:'Brouillon <privé>',audience:'self'},status:201});
  const shared = await call('social',{method:'POST',cookie:a,data:{text:'Publication <proche>',audience:'contacts'},status:201});
  assert.deepEqual((await call('social',{cookie:b})).result.posts.map(post=>post.id),[shared.result.id]);
  assert.deepEqual((await call('social',{cookie:c})).result.posts,[]);
  await call('social',{method:'POST',cookie:c,data:{text:'Partage mineur',audience:'contacts'},status:403});
  await call('social/report',{method:'POST',cookie:b,data:{id:own.result.id},status:404});
  await call('social/report',{method:'POST',cookie:b,data:{id:shared.result.id},status:201});
  assert.equal(service.listSocialReports()[0].text,'Publication <proche>');
  await call('privacy',{method:'PUT',cookie:a,data:{mode:'ultra',requested:[]}});
  assert.deepEqual((await call('social',{cookie:b})).result.posts,[]);
  await call('social',{method:'POST',cookie:a,data:{text:'Ultra privé',audience:'contacts'},status:403});
  await call('privacy',{method:'PUT',cookie:a,data:{mode:'private',requested:[]}});
  await call('social/withdraw',{method:'POST',cookie:b,data:{id:shared.result.id},status:404});
  await call('social/withdraw',{method:'POST',cookie:a,data:{id:shared.result.id}});
  assert.deepEqual((await call('social',{cookie:b})).result.posts,[]);
  assert.deepEqual((await call('social',{cookie:a})).result.posts.map(post=>post.id),[own.result.id]);
  await call('calls/ice',{cookie:c,status:403});
  assert.equal((await call('calls/ice',{cookie:a})).result.iceTransportPolicy,'relay');
  const host = 'v=0\r\na=candidate:test 1 udp 123 10.0.0.2 5000 typ host';
  const relay = 'v=0\r\na=candidate:test 1 udp 123 203.0.113.1 5000 typ relay';
  await call('calls',{method:'POST',cookie:a,data:{action:'offer',peer:'bob',kind:'video',sdp:host},status:400});
  const {result:{id}} = await call('calls',{method:'POST',cookie:a,data:{action:'offer',peer:'bob',kind:'video',sdp:relay},status:201});
  assert.equal((await call('calls',{cookie:b})).result.call.direction,'incoming');
  assert.equal((await call('calls',{cookie:c})).result.call,null);
  await call('calls',{method:'POST',cookie:c,data:{action:'answer',id,sdp:relay},status:404});
  await call('calls',{method:'POST',cookie:b,data:{action:'answer',id,sdp:relay}});
  assert.equal((await call('calls',{cookie:a})).result.call.answer,relay);
  await call('block',{method:'POST',cookie:b,data:{peer:'alice'}});
  assert.equal((await call('calls',{cookie:a})).result.call,null);
});

test('retirer le consentement interrompt la reconnaissance en cours',async t => {
  let started;
  const begin = new Promise(resolve => { started=resolve; });
  const service = openService({filename:':memory:',keyHex,origin,recognize:(_clip,_mime,signal)=>{
    return new Promise((resolve,reject)=>{
      signal.addEventListener('abort',()=>reject(signal.reason),{once:true});
      started(signal);
    });
  }});
  t.after(()=>service.close());
  const call = (path,method,data,cookie,type='application/json') => service.handle(new Request(origin+'/api/'+path,{
    method,headers:{origin,'content-type':type,...(cookie?{cookie}:{})},
    body:data === undefined ? undefined : type === 'application/json' ? JSON.stringify(data) : data
  }));
  const register = await call('register','POST',{handle:'pretest',password});
  assert.equal(register.status,201);
  const cookie = register.headers.get('set-cookie').split(';')[0];
  service.attestAge('pretest','adult');
  assert.equal((await call('consent','PUT',{communications:false,music:true},cookie)).status,200);
  const safety = (await (await call('me','GET',undefined,cookie)).json()).safety;
  assert.equal(safety.musicAvailable,true);
  const pending = call('music/identify','POST','extrait-fictif',cookie,'audio/webm');
  const signal = await begin;
  assert.equal((await call('consent','PUT',{communications:false,music:false},cookie)).status,200);
  assert.equal(signal.aborted,true);
  assert.equal((await pending).status,403);
  assert.equal((await call('music/identify','POST','extrait-fictif',cookie,'audio/webm')).status,403);
});
