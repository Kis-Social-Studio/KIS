import {createCipheriv, createDecipheriv, randomBytes, randomUUID} from 'node:crypto';
import {mkdtempSync,rmSync} from 'node:fs';
import {dirname,join,resolve} from 'node:path';
import {sealBackup} from './backup.mjs';

export function prepareEncryption(db, keyHex, filename, backupKey) {
  if (typeof keyHex !== 'string' || !/^[0-9a-f]{64}$/i.test(keyHex)) {
    throw Error('KIS_DATA_KEY doit contenir 32 octets aléatoires en hexadécimal.');
  }
  const key = Buffer.from(keyHex, 'hex');
  function seal(text, aad) {
    const iv = randomBytes(12);
    const cipher = createCipheriv('aes-256-gcm', key, iv);
    cipher.setAAD(Buffer.from(aad));
    const data = Buffer.concat([cipher.update(text, 'utf8'), cipher.final()]);
    return Buffer.concat([iv, cipher.getAuthTag(), data]).toString('base64');
  }
  function unseal(text, aad) {
    const data = Buffer.from(text, 'base64');
    const cipher = createDecipheriv('aes-256-gcm', key, data.subarray(0,12));
    cipher.setAAD(Buffer.from(aad));
    cipher.setAuthTag(data.subarray(12,28));
    return Buffer.concat([cipher.update(data.subarray(28)), cipher.final()]).toString('utf8');
  }
  const aad = (id, sender, recipient, created) => `kis:message:v1:${id}:${sender}:${recipient}:${created}`;
  const q = sql => db.prepare(sql);
  const verify = q('SELECT sealed FROM encryption_meta WHERE id=1');
  function verifyKey(row) {
    try {
      if (unseal(row.sealed, 'kis:key-check:v1') === 'kis-v1') return;
    } catch {
      // Fail closed on a missing or mismatched key.
    }
    throw Error('Clé KIS incorrecte ou base endommagée.');
  }
  db.exec('PRAGMA secure_delete=ON');
  if (!verify.get() && filename !== ':memory:' && q('SELECT 1 FROM messages LIMIT 1').get()) {
    if (typeof backupKey !== 'string' || !/^[0-9a-f]{64}$/i.test(backupKey) || backupKey.toLowerCase() === keyHex.toLowerCase()) {
      throw Error('Une clé KIS_BACKUP_KEY valide et distincte est requise avant la migration.');
    }
    const backup = filename + '.avant-chiffrement-' + randomUUID() + '.kisb';
    const directory = mkdtempSync(join(dirname(resolve(filename)),'.kis-migration-'));
    try {
      const temporary = join(directory,'snapshot.sqlite');
      q('VACUUM INTO ?').run(temporary);
      sealBackup(temporary,backup,backupKey);
    } finally {
      rmSync(directory,{recursive:true});
    }
  }
  db.exec('BEGIN IMMEDIATE');
  try {
    const existing = verify.get();
    if (existing) {
      verifyKey(existing);
    } else {
      const update = q('UPDATE messages SET text=? WHERE id=?');
      const batch = q('SELECT id,sender,recipient,created,text FROM messages WHERE id>? ORDER BY id LIMIT 500');
      let last = Number.MIN_SAFE_INTEGER;
      for (;;) {
        const rows = batch.all(last);
        if (!rows.length) break;
        for (const row of rows) update.run(seal(row.text,aad(row.id,row.sender,row.recipient,row.created)),row.id);
        last = rows.at(-1).id;
      }
      q('INSERT INTO encryption_meta(id,sealed) VALUES(1,?)').run(seal('kis-v1','kis:key-check:v1'));
    }
    db.exec('COMMIT');
  } catch (error) {
    db.exec('ROLLBACK');
    throw error;
  }
  db.exec('PRAGMA wal_checkpoint(TRUNCATE)');
  return {
    sealMessage: (id,sender,recipient,created,text) => seal(text,aad(id,sender,recipient,created)),
    readMessage: row => unseal(row.text,aad(row.id,row.sender,row.recipient,row.created)),
    sealPost: (id,author,created,text) => seal(text,`kis:post:v1:${id}:${author}:${created}`),
    readPost: row => unseal(row.text,`kis:post:v1:${row.id}:${row.author}:${row.created}`)
  };
}
