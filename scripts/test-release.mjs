import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('../', import.meta.url));
const result = spawnSync(process.execPath, ['--test', 'tests/release/*.test.cts'], { cwd: root, stdio: 'inherit' });
process.exit(result.status ?? 1);
