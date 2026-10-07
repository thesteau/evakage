import { existsSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const root = fileURLToPath(new URL('../', import.meta.url));
const local = path.join(root, '.local', 'toolchains', 'go', 'bin', process.platform === 'win32' ? 'go.exe' : 'go');
const result = spawnSync(existsSync(local) ? local : 'go', process.argv.slice(2), { cwd: path.join(root, 'app'), stdio: 'inherit' });
if (result.error) { console.error(`Go is required to build and test the backend: ${result.error.message}`); }
process.exit(result.status ?? 1);
