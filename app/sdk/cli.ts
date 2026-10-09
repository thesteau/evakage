#!/usr/bin/env node
import { parseArgs } from 'node:util';
import { createInterface } from 'node:readline';
import fs from 'node:fs/promises';
import path from 'node:path';
import { EvakageClient, FileStore, type IncomingFile } from './index.js';

const help = `Evakage encrypted client (Node 24+)
Usage: evakage-client [options] <command> [arguments]
  listen                           Stay online; print incoming messages and files
  chat                             Listen and accept JSON commands on stdin
  pair CODE [EXPECTED_FINGERPRINT]  Pair and remember a device
  peers                            List paired devices
  send-text TO TEXT                 Send an encrypted message
  send-file TO PATH                 Send an encrypted file
Options:
  --url URL        Server origin (or EVAKAGE_URL; default http://localhost:3000)
  --state DIR      Identity and paired-device storage
  --output DIR     Explicitly download incoming files into this directory
  --help           Show this help
Use EVAKAGE_TOKEN for server access. One live process per state directory.
TO is a full device fingerprint or room:ROOM_ID.
chat stdin: {"type":"send-text","to":"FINGERPRINT","text":"Hello"}
Other chat commands: pair, send-file, login, create-room, join-room, leave-room, disconnect.
`;

async function main() {
  const { values, positionals } = parseArgs({ allowPositionals: true, options: {
    url: { type: 'string' }, state: { type: 'string' }, output: { type: 'string' }, help: { type: 'boolean', short: 'h' },
  } });
  if (values.help || !positionals.length) { process.stdout.write(help); return; }
  const [command, ...args] = positionals;
  if (!['listen', 'chat', 'pair', 'peers', 'send-text', 'send-file'].includes(command)) throw new Error('Unknown command; use --help');
  const print = (value: object) => process.stdout.write(JSON.stringify(value) + '\n');
  const client = new EvakageClient({ url: values.url ?? process.env.EVAKAGE_URL ?? 'http://localhost:3000', token: process.env.EVAKAGE_TOKEN, store: new FileStore(values.state), autoReconnect: command === 'listen' || command === 'chat' });
  let stopped = false;
  const stop = async () => { if (stopped) return; stopped = true; await client.disconnect(); };
  process.once('SIGINT', () => void stop());
  process.once('SIGTERM', () => void stop());
  client.on('online', self => print({ type: 'online', deviceId: self.id, pairingCode: self.pairingCode, pairingCodeExpiresAt: self.pairingCodeExpiresAt }));
  client.on('offline', value => print({ type: 'offline', ...value }));
  client.on('message', message => print({ type: 'message', ...message }));
  client.on('client-error', error => process.stderr.write(`${error.message}\n`));
  client.on('warning', message => print({ type: 'warning', message }));
  const receiving = new Set<Promise<void>>();
  client.on('file', (file: IncomingFile) => {
    print({ type: 'file', blobId: file.blobId, from: file.from, conv: file.conv, meta: file.meta, expiresAt: file.expiresAt });
    if (!values.output) return;
    const name = file.meta.name.replace(/[\\/:*?"<>|\x00-\x1f]/g, '_').replace(/[. ]+$/g, '').slice(0, 100) || 'file';
    const destination = path.resolve(values.output, `${crypto.randomUUID()}-${name}`);
    const save = file.save(destination).then(() => { print({ type: 'saved', blobId: file.blobId, path: destination }); }).catch(error => { process.stderr.write(`File download failed: ${error.message}\n`); }).finally(() => receiving.delete(save));
    receiving.add(save);
  });
  try {
    if (values.output) await fs.mkdir(values.output, { recursive: true, mode: 0o700 });
    await client.connect();
    if (command === 'listen' || command === 'chat') {
      let lines: ReturnType<typeof createInterface> | undefined;
      let commands = Promise.resolve();
      if (command === 'chat') {
        lines = createInterface({ input: process.stdin });
        lines.on('line', line => {
          commands = commands.then(async () => {
            const input = JSON.parse(line);
            let result;
            switch (input.type) {
              case 'pair': result = await client.pair(input.code, input.expectedId); break;
              case 'send-text': result = await client.sendText(input.to, input.text); break;
              case 'send-file': result = await client.sendFile(input.to, input.path); break;
              case 'login': result = await client.login(input.username, input.password, input.register === true); break;
              case 'create-room': result = await client.createRoom(input.name, input.access); break;
              case 'join-room': result = await client.joinRoom(input.code); break;
              case 'leave-room': client.leaveRoom(input.roomId); result = {}; break;
              case 'disconnect': await stop(); result = {}; break;
              default: throw new Error('Unknown chat command');
            }
            print({ type: 'result', command: input.type, result });
          }).catch(error => { print({ type: 'command-error', message: error.message }); });
        });
      }
      await new Promise<void>(resolve => {
        const exit = () => resolve();
        process.once('SIGINT', exit); process.once('SIGTERM', exit);
        client.on('offline', ({ code }) => { if (stopped || code === 1008 || code === 4001) resolve(); });
      });
      lines?.close();
      await commands;
    } else if (command === 'pair') {
      if (!args[0]) throw new Error('Provide a pairing code');
      print({ type: 'paired', peer: await client.pair(args[0], args[1]) });
    } else if (command === 'peers') print({ type: 'peers', peers: client.peers() });
    else if (command === 'send-text') {
      if (args.length < 2) throw new Error('Provide a recipient and message');
      print({ type: 'accepted', ...await client.sendText(args[0], args.slice(1).join(' ')) });
    } else if (command === 'send-file') {
      if (args.length !== 2) throw new Error('Provide a recipient and file path');
      print({ type: 'accepted', ...await client.sendFile(args[0], args[1]) });
    }
  } finally { await stop(); await Promise.allSettled(receiving); }
}

main().catch(error => { process.stderr.write(`${error.message}\n`); process.exitCode = 1; });
