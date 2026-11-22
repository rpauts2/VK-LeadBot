import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { gunzipSync } from 'node:zlib';
import { spawn } from 'node:child_process';

const root = path.dirname(fileURLToPath(import.meta.url));
const chunks = [];
for (let i = 1; i <= 6; i++) {
  const name = String(i).padStart(2, '0');
  chunks.push(fs.readFileSync(path.join(root, '.bundle', `part-${name}.b64`), 'utf8').trim());
}
const bundle = JSON.parse(gunzipSync(Buffer.from(chunks.join(''), 'base64')).toString('utf8'));
for (const [relative, content] of Object.entries(bundle)) {
  const target = path.resolve(root, relative);
  if (!target.startsWith(root + path.sep)) throw new Error(`Unsafe bundle path: ${relative}`);
  fs.mkdirSync(path.dirname(target), { recursive: true });
  fs.writeFileSync(target, content, 'utf8');
}
fs.mkdirSync(path.join(root, '.data'), { recursive: true });
console.log(`VK LeadBot source restored: ${Object.keys(bundle).length} files.`);
if (process.env.RESTORE_ONLY === '1') process.exit(0);
const child = spawn(process.execPath, [path.join(root, 'server.mjs')], {
  cwd: root,
  stdio: 'inherit',
  env: process.env
});
child.on('exit', code => process.exit(code ?? 0));
process.on('SIGINT', () => child.kill('SIGINT'));
process.on('SIGTERM', () => child.kill('SIGTERM'));
