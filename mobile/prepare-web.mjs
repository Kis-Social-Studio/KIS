import {copyFile, mkdir} from 'node:fs/promises';
const www = new URL('./www/', import.meta.url);
await mkdir(www, {recursive: true});
await copyFile(new URL('../index.html', import.meta.url), new URL('index.html', www));
