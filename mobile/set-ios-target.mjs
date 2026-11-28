import { readFile, writeFile } from 'node:fs/promises';

const project = new URL('./ios/App/App.xcodeproj/project.pbxproj', import.meta.url);
const contents = await readFile(project, 'utf8');
const target = /IPHONEOS_DEPLOYMENT_TARGET = \d+(?:\.\d+)*;/g;
if (!contents.match(target)) throw Error('Cible Xcode introuvable.');
await writeFile(project, contents.replace(target, 'IPHONEOS_DEPLOYMENT_TARGET = 17.0;'));
