import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { createInterface } from 'node:readline';
import { fileURLToPath } from 'node:url';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { EvakageClient, MemoryStore } from '../../app/sdk/index.js';
import { startServer } from './helpers.js';

const cli = fileURLToPath(new URL('../../app/sdk/cli.js', import.meta.url));

test('CLI chat maintains one identity while pairing, sending and receiving messages', async t => {
  const { base } = await startServer(t, { apiOnly: true, authToken: 'cli-access' });
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'evakage-api-cli-'));
  const receiver = new EvakageClient({ url: base, token: 'cli-access', store: new MemoryStore(), autoReconnect: false });
  const self = await receiver.connect();
  const child = spawn(process.execPath, [cli, '--url', base, '--state', directory, 'chat'], {
    env: { ...process.env, EVAKAGE_TOKEN: 'cli-access' }, windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'],
  });
  const closed = once(child, 'exit');
  const lines = createInterface({ input: child.stdout! });
  let errors = '';
  child.stderr!.on('data', bytes => { errors += bytes; });
  const queue: any[] = [];
  const waiting: { predicate: (event: any) => boolean; resolve: (event: any) => void; reject: (error: Error) => void; timer: ReturnType<typeof setTimeout> }[] = [];
  lines.on('line', line => {
    const event = JSON.parse(line);
    const index = waiting.findIndex(w => w.predicate(event));
    if (index < 0) queue.push(event);
    else { const [waiter] = waiting.splice(index, 1); clearTimeout(waiter.timer); waiter.resolve(event); }
  });
  const wait = (predicate: (event: any) => boolean): Promise<any> => {
    const index = queue.findIndex(predicate);
    if (index >= 0) return Promise.resolve(queue.splice(index, 1)[0]);
    return new Promise((resolve, reject) => {
      const waiter = { predicate, resolve, reject, timer: setTimeout(() => { const i = waiting.indexOf(waiter); if (i >= 0) waiting.splice(i, 1); reject(new Error('CLI event timed out')); }, 5000) };
      waiting.push(waiter);
    });
  };
  const send = (command: object) => child.stdin!.write(JSON.stringify(command) + '\n');
  t.after(async () => {
    if (child.exitCode === null) child.kill();
    await closed;
    lines.close();
    await receiver.disconnect();
    await fs.rm(directory, { recursive: true, force: true });
  });
  const online = await wait(event => event.type === 'online');
  send({ type: 'pair', code: self.pairingCode });
  await wait(event => event.type === 'result' && event.command === 'pair');
  const received = once(receiver, 'message', { signal: AbortSignal.timeout(5000) });
  send({ type: 'send-text', to: self.id, text: 'CLI to SDK' });
  assert.equal((await received)[0].text, 'CLI to SDK');
  await receiver.sendText(online.deviceId, 'SDK to CLI');
  assert.equal((await wait(event => event.type === 'message')).text, 'SDK to CLI');
  send({ type: 'disconnect' });
  assert.equal((await closed)[0], 0);
  assert.equal(errors, '');
});
