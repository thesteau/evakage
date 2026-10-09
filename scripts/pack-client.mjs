import fs from 'node:fs/promises';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('../', import.meta.url));
const build = spawnSync(process.execPath, [path.join(root, 'scripts/build.mjs')], { cwd: root, stdio: 'inherit' });
if (build.status !== 0) process.exit(build.status || 1);
const destination = path.join(root, 'app/dist/client-package');
await fs.mkdir(path.join(destination, 'dist'), { recursive: true });
for (const name of ['sdk', 'core']) await fs.cp(path.join(root, 'app/dist/app', name), path.join(destination, 'dist', name), { recursive: true });
await fs.copyFile(path.join(root, 'app/sdk/package.json'), path.join(destination, 'package.json'));
await fs.copyFile(path.join(root, 'app/sdk/README.md'), path.join(destination, 'README.md'));
await fs.copyFile(path.join(root, 'LICENSE'), path.join(destination, 'LICENSE'));
// The shell is needed only for npm.cmd on Windows; arguments and paths are fixed.
const packed = spawnSync(process.platform === 'win32' ? 'npm.cmd' : 'npm', ['pack', '--pack-destination', '..'], { cwd: destination, stdio: 'inherit', shell: process.platform === 'win32' });
process.exit(packed.status ?? 1);
