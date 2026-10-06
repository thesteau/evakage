// Isolated local TURN-only room measurement. No publishing or external service.
// node scripts/benchmarks/room-turn.mjs [--mobile] [--repeat=3]
import { execFileSync, spawn } from 'node:child_process';
import { randomUUID, randomBytes } from 'node:crypto';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const mobile = process.argv.includes('--mobile');
const repeat = Number(process.argv.find(value => value.startsWith('--repeat='))?.split('=')[1] || 1);
if (!Number.isInteger(repeat) || repeat < 1 || repeat > 10 ||
    process.argv.slice(2).some(value => value !== '--mobile' && !value.startsWith('--repeat='))) {
  throw new Error('Usage: node scripts/benchmarks/room-turn.mjs [--mobile] [--repeat=1..10]');
}
const root = fileURLToPath(new URL('../../', import.meta.url));
const name = `evakage-turn-${randomUUID()}`;
const credential = randomBytes(24).toString('hex');
const image = 'coturn/coturn@sha256:bbefd3e1fdfdc0d58770fe01b581fd8b00d9f3a5580d00acb77cf719a6bc78e3';
const output = path.join(os.tmpdir(), name);
try {
  execFileSync('docker', ['run', '-d', '--name', name, '-p', '127.0.0.1::3478/tcp', image,
    '--no-tls', '--fingerprint', '--lt-cred-mech', '--realm=evakage-local-test',
    `--user=aria-test:${credential}`, '--listening-ip=0.0.0.0', '--relay-ip=127.0.0.1',
    '--min-port=50000', '--max-port=50079', '--allow-loopback-peers',
    '--log-file=stdout', '--simple-log'], { cwd: root, timeout: 120000, stdio: ['ignore', 'pipe', 'pipe'] });
  const port = execFileSync('docker', ['port', name, '3478/tcp'], { encoding: 'utf8' }).trim().split(':').pop();
  const code = await new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [path.join(root, 'node_modules/@playwright/test/cli.js'),
      'test', '--config', 'app/playwright.config.js', 'app/e2e/room-churn.spec.js', '--grep', 'file transfers', '--workers=1',
      `--repeat-each=${repeat}`, '--output', output], {
      cwd: root, stdio: 'inherit', env: { ...process.env,
        ARIA_CHURN_TURN_URL: `turn:127.0.0.1:${port}?transport=tcp`,
        ARIA_CHURN_TURN_USER: 'aria-test', ARIA_CHURN_TURN_PASSWORD: credential,
        ARIA_CHURN_MOBILE: mobile ? '1' : '0' }
    });
    child.once('error', reject);
    child.once('exit', value => resolve(value ?? 1));
  });
  console.log(`Measurement artifacts: ${output}`);
  process.exitCode = Number(code);
} finally {
  // This exact random name belongs to this script; other containers are untouched.
  execFileSync('docker', ['rm', '-f', name], { stdio: 'ignore' });
}
