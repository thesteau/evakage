import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';

const root = fileURLToPath(new URL('../', import.meta.url));
const outputDir = path.resolve(root, 'app/dist');
const stagingDir = path.resolve(root, '.local/build');
// Local builds stay local even in a Git checkout; image workflows pass metadata.
const version = process.env.VERSION || 'dev';
const revision = process.env.REVISION || 'unknown';
const buildLabel = /^v\d+\.\d+\.\d+$/.test(version)
  ? version
  : /^[a-f0-9]{7,40}$/i.test(revision) ? revision.slice(0, 7).toLowerCase() : 'local';
if (path.dirname(outputDir) !== path.resolve(root, 'app') || path.relative(root, stagingDir).startsWith('..')) {
  throw new Error('Build output must stay inside the repository.');
}
await fs.rm(stagingDir, { recursive: true, force: true });
// The typescript alias supplies ESLint's v6 API; builds use the native v7 compiler.
const result = spawnSync(process.execPath, [path.join(root, 'app/node_modules/@typescript/native/bin/tsc'), '-p', 'app/tsconfig.json', '--outDir', stagingDir], { cwd: root, stdio: 'inherit' });
if (result.status !== 0) process.exit(result.status || 1);
const publicDir = path.join(stagingDir, 'app/public');
for (const dir of ['html', 'css', 'assets']) {
  await fs.cp(path.join(root, 'app/client', dir), publicDir, { recursive: true, filter: source => !source.endsWith('.ts') && !source.endsWith('.mts') });
}
await fs.cp(path.join(stagingDir, 'app/client/ts'), publicDir, { recursive: true });
const indexPath = path.join(publicDir, 'index.html');
await fs.writeFile(indexPath, (await fs.readFile(indexPath, 'utf8')).replace(
  '<span id="buildLabel" class="build-label">build local</span>',
  `<span id="buildLabel" class="build-label">build ${buildLabel}</span>`,
));
// A different image must install a new shell cache, including its own label.
const workerPath = path.join(publicDir, 'sw.js');
await fs.writeFile(workerPath, (await fs.readFile(workerPath, 'utf8')).replace(
  /const CACHE = '(evakage-v\d+)';/,
  (_, cache) => `const CACHE = '${cache}-${buildLabel}';`,
));
const qrPath = path.join(publicDir, 'qr.js');
await fs.writeFile(qrPath, (await fs.readFile(qrPath, 'utf8')).replace('../assets/vendor/qrcode.mjs', './vendor/qrcode.mjs'));
// Node tests import the compiled client modules using their source-relative paths.
await fs.cp(path.join(root, 'app/client/assets'), path.join(stagingDir, 'app/client/assets'), { recursive: true });
if (!process.argv.includes('--client-only')) {
  for (const [name, args] of [
    ['evakage', ['build', '-trimpath', '-o', path.join(stagingDir, process.platform === 'win32' ? 'evakage.exe' : 'evakage'), './cmd/evakage']],
    ['evakage-test', ['-C', '../tests/go', 'build', '-tags', 'testbridge', '-o', path.join(stagingDir, process.platform === 'win32' ? 'evakage-test.exe' : 'evakage-test'), './cmd/evakage-test']],
  ]) {
    const built = spawnSync(process.execPath, [path.join(root, 'scripts/go.mjs'), ...args], { cwd: root, stdio: 'inherit' });
    if (built.status !== 0) { console.error(`Could not build ${name}`); process.exit(built.status || 1); }
  }
}
// Keep the last successful build available if compilation or asset assembly fails.
await fs.rm(outputDir, { recursive: true, force: true });
await fs.rename(stagingDir, outputDir);
