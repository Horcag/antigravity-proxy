import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const destination = path.join(root, 'dist', 'dashboard');
const source = path.join(root, 'web', 'dist', 'index.html');
if (!fs.statSync(source).isFile()) throw new Error('Management panel build is missing');
fs.mkdirSync(destination, { recursive: true });
fs.copyFileSync(source, path.join(destination, 'index.html'));
fs.copyFileSync(path.join(root, 'web', 'LICENSE'), path.join(destination, 'UPSTREAM-LICENSE.txt'));
fs.copyFileSync(path.join(root, 'web', 'UPSTREAM.json'), path.join(destination, 'UPSTREAM.json'));
