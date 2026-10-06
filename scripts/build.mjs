import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';

const root = fileURLToPath(new URL('../', import.meta.url));
const outputDir = path.resolve(root, 'dist');
const stagingDir = path.resolve(root, '.local/build');
if (path.dirname(outputDir) !== path.resolve(root) || path.relative(root, stagingDir).startsWith('..')) {
  throw new Error('Build output must stay inside the repository.');
}
await fs.rm(stagingDir, { recursive: true, force: true });
const result = spawnSync(process.execPath, [path.join(root, 'node_modules/typescript/bin/tsc'), '-p', 'app/tsconfig.json', '--outDir', stagingDir], { cwd: root, stdio: 'inherit' });
if (result.status !== 0) process.exit(result.status || 1);
const publicDir = path.join(stagingDir, 'app/public');
for (const dir of ['html', 'css', 'assets']) {
  await fs.cp(path.join(root, 'app/client', dir), publicDir, { recursive: true, filter: source => !source.endsWith('.ts') && !source.endsWith('.mts') });
}
await fs.cp(path.join(stagingDir, 'app/client/ts'), publicDir, { recursive: true });
const qrPath = path.join(publicDir, 'qr.js');
await fs.writeFile(qrPath, (await fs.readFile(qrPath, 'utf8')).replace('../assets/vendor/qrcode.mjs', './vendor/qrcode.mjs'));
// Node tests import the compiled client modules using their source-relative paths.
await fs.cp(path.join(root, 'app/client/assets'), path.join(stagingDir, 'app/client/assets'), { recursive: true });
// Keep the last successful build available if compilation or asset assembly fails.
await fs.rm(outputDir, { recursive: true, force: true });
await fs.rename(stagingDir, outputDir);
