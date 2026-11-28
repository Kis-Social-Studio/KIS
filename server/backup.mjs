import {createCipheriv, createDecipheriv, randomBytes} from 'node:crypto';
import {closeSync, constants, fchmodSync, fstatSync, fsyncSync, linkSync, mkdtempSync,
  openSync, readSync, rmSync, writeFileSync} from 'node:fs';
import {dirname, join, resolve} from 'node:path';
import {pathToFileURL} from 'node:url';

const magic = Buffer.from('KIS-ARCHIVE-1\n','ascii');
const ivSize = 12;
const tagSize = 16;
const headerSize = magic.length + ivSize;
const chunkSize = 256 * 1024;

function makeKey(hex) {
  if (typeof hex !== 'string' || !/^[a-f\d]{64}$/i.test(hex)) {
    throw Error('KIS_BACKUP_KEY doit contenir 32 octets aléatoires en hexadécimal.');
  }
  return Buffer.from(hex,'hex');
}

function withInput(path, operation) {
  const input = openSync(path,constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const stats = fstatSync(input);
    if (!stats.isFile()) throw Error('Un fichier normal est requis.');
    return operation(input,stats);
  } finally {
    closeSync(input);
  }
}

function publish(path, operation) {
  const destination = resolve(path);
  const dir = mkdtempSync(join(dirname(destination),'.kis-archive-'));
  const temporary = join(dir,'result');
  try {
    const output = openSync(temporary,'wx',0o600);
    try {
      operation(output);
      fsyncSync(output);
    } finally {
      closeSync(output);
    }
    // Atomic publication. An existing file is never overwritten.
    linkSync(temporary,destination);
    const parent = openSync(dirname(destination),'r');
    try { fsyncSync(parent); } finally { closeSync(parent); }
  } finally {
    rmSync(dir,{recursive:true});
  }
}

function stream(input, offset, length, transform, consume) {
  const chunk = Buffer.allocUnsafe(chunkSize);
  while (length > 0) {
    const count = readSync(input,chunk,0,Math.min(chunk.length,length),offset);
    if (!count) throw Error('Fichier incomplet.');
    consume(transform.update(chunk.subarray(0,count)));
    offset += count;
    length -= count;
  }
  consume(transform.final());
}

function readArchive(input, size, key, consume) {
  if (size < headerSize + tagSize) throw Error('Archive invalide ou incomplète.');
  const header = Buffer.alloc(headerSize);
  const tag = Buffer.alloc(tagSize);
  if (readSync(input,header,0,headerSize,0) !== headerSize ||
    !header.subarray(0,magic.length).equals(magic) ||
    readSync(input,tag,0,tagSize,size-tagSize) !== tagSize) {
    throw Error('Format de sauvegarde inconnu.');
  }
  const decipher = createDecipheriv('aes-256-gcm',key,header.subarray(magic.length));
  decipher.setAAD(header);
  decipher.setAuthTag(tag);
  stream(input,headerSize,size-headerSize-tagSize,decipher,consume);
}

export function sealBackup(source, destination, keyHex, {restrictSource = false} = {}) {
  const key = makeKey(keyHex);
  withInput(source,(input,before) => {
    publish(destination,output => {
      const header = Buffer.concat([magic,randomBytes(ivSize)]);
      const cipher = createCipheriv('aes-256-gcm',key,header.subarray(magic.length));
      cipher.setAAD(header);
      writeFileSync(output,header);
      stream(input,0,before.size,cipher,data => writeFileSync(output,data));
      writeFileSync(output,cipher.getAuthTag());
      const after = fstatSync(input);
      if (before.size !== after.size || before.mtimeMs !== after.mtimeMs || before.ctimeMs !== after.ctimeMs) {
        throw Error('La sauvegarde source a été modifiée pendant la lecture.');
      }
    });
    verifyBackup(destination,keyHex);
    if (restrictSource) fchmodSync(input,0o600);
  });
}

export function verifyBackup(source,keyHex) {
  const key = makeKey(keyHex);
  withInput(source,(input,stats) => readArchive(input,stats.size,key,() => {}));
}

export function restoreBackup(source,destination,keyHex) {
  const key = makeKey(keyHex);
  withInput(source,(input,stats) => {
    // Unauthenticated bytes are confined to a private temporary file until GCM verification.
    publish(destination,output => readArchive(input,stats.size,key,data => writeFileSync(output,data)));
  });
}

if (process.argv[1] && pathToFileURL(resolve(process.argv[1])).href === import.meta.url) {
  process.umask(0o077);
  const [command,source,destination] = process.argv.slice(2);
  try {
    const key = process.env.KIS_BACKUP_KEY;
    if (command === 'protect' && source && destination) sealBackup(source,destination,key,{restrictSource:true});
    else if (command === 'verify' && source && !destination) verifyBackup(source,key);
    else if (command === 'restore' && source && destination) restoreBackup(source,destination,key);
    else throw Error('Commandes : protect source.sqlite archive.kisb, verify archive.kisb, restore archive.kisb copie.sqlite.');
    console.log('Opération de sauvegarde vérifiée.');
  } catch (error) {
    console.error(error.message);
    process.exitCode = 1;
  }
}
