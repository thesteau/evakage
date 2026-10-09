import fs from 'node:fs/promises';
import { constants } from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { bytesToBase64, fingerprintOf, signTranscript } from '../core/identity.js';
import type { Device, Identity } from '../core/types.js';

export interface ClientStore {
  identity(): Promise<Identity>;
  peers(): Promise<Device[]>;
  savePeers(peers: Device[]): Promise<void>;
}

type Keys = { v: 1; signing: JsonWebKey; sealing: JsonWebKey; createdAt: number };

async function readKeys(file: string): Promise<Keys> {
  // Hold the descriptor through validation and reading; replacing the path
  // after validation cannot change the identity being read.
  const handle = await fs.open(file, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
  try {
    const [opened, entry] = await Promise.all([handle.stat({ bigint: true }), fs.lstat(file, { bigint: true })]);
    // Windows lacks O_NOFOLLOW. Check the entry against the already open file
    // there too, and reject symlinks, non-files and replacements during open.
    if (entry.isSymbolicLink() || !opened.isFile() || entry.dev !== opened.dev || entry.ino !== opened.ino)
      {throw new Error('Identity file must be a regular file and must not be a symbolic link');}
    return JSON.parse(await handle.readFile('utf8'));
  } finally { await handle.close(); }
}

async function createKeys(): Promise<Keys> {
  const signing = await crypto.subtle.generateKey({ name: 'ECDSA', namedCurve: 'P-256' }, true, ['sign', 'verify']);
  const sealing = await crypto.subtle.generateKey({ name: 'ECDH', namedCurve: 'P-256' }, true, ['deriveBits']);
  return { v: 1, signing: await crypto.subtle.exportKey('jwk', signing.privateKey), sealing: await crypto.subtle.exportKey('jwk', sealing.privateKey), createdAt: Date.now() };
}

async function importIdentity(keys: Keys): Promise<Identity> {
  if (keys.v !== 1 || !keys.signing?.d || !keys.sealing?.d) throw new Error('Invalid Evakage identity file');
  const privateKey = await crypto.subtle.importKey('jwk', keys.signing, { name: 'ECDSA', namedCurve: 'P-256' }, false, ['sign']);
  const sealPrivateKey = await crypto.subtle.importKey('jwk', keys.sealing, { name: 'ECDH', namedCurve: 'P-256' }, false, ['deriveBits']);
  const publicJwk = (key: JsonWebKey) => ({ kty: key.kty, crv: key.crv, x: key.x, y: key.y, ext: true });
  const publicKey = await crypto.subtle.importKey('jwk', publicJwk(keys.signing), { name: 'ECDSA', namedCurve: 'P-256' }, true, ['verify']);
  const sealPublicKey = await crypto.subtle.importKey('jwk', publicJwk(keys.sealing), { name: 'ECDH', namedCurve: 'P-256' }, true, []);
  const rawPublicKey = new Uint8Array(await crypto.subtle.exportKey('raw', publicKey));
  const deviceId = await fingerprintOf(rawPublicKey);
  const sealKey = bytesToBase64(new Uint8Array(await crypto.subtle.exportKey('raw', sealPublicKey)));
  return { deviceId, fingerprint: deviceId, privateKey, publicKey, sealPrivateKey, rawPublicKey, identityKey: bytesToBase64(rawPublicKey), sealKey, sealKeySignature: await signTranscript(privateKey, `evakage/sealkey/1|${sealKey}`), createdAt: keys.createdAt };
}

export class MemoryStore implements ClientStore {
  private readonly keys = createKeys().then(importIdentity);
  private records: Device[] = [];
  identity() { return this.keys; }
  async peers() { return structuredClone(this.records); }
  async savePeers(peers: Device[]) { this.records = structuredClone(peers); }
}

/** Private keys are stored locally. Unix modes are 0700/0600; Windows uses user ACLs. */
export class FileStore implements ClientStore {
  private loaded?: Promise<Identity>;
  private writes: Promise<void> = Promise.resolve();
  constructor(readonly directory = path.join(os.homedir(), '.config', 'evakage', 'client')) {}
  identity() { return this.loaded ??= this.load(); }
  private async load() {
    await fs.mkdir(this.directory, { recursive: true, mode: 0o700 });
    const file = path.join(this.directory, 'identity.json');
    let keys: Keys;
    try {
      keys = await readKeys(file);
    } catch (error) {
      if (error.code !== 'ENOENT') throw error;
      const temporary = path.join(this.directory, `identity-${crypto.randomUUID()}.tmp`);
      try {
        await fs.writeFile(temporary, JSON.stringify(await createKeys()), { flag: 'wx', mode: 0o600 });
        try { await fs.link(temporary, file); }
        catch (error) { if (error.code !== 'EEXIST') throw error; }
      } finally { await fs.rm(temporary, { force: true }); }
      keys = await readKeys(file);
    }
    return importIdentity(keys);
  }
  async peers(): Promise<Device[]> {
    try {
      const records = JSON.parse(await fs.readFile(path.join(this.directory, 'peers.json'), 'utf8'));
      if (!Array.isArray(records) || records.length > 10000) throw new Error('Invalid peer store');
      return records;
    } catch (error) {
      if (error.code !== 'ENOENT') throw error;
      return [];
    }
  }
  savePeers(peers: Device[]) {
    const snapshot = JSON.stringify(peers);
    const save = this.writes.catch(() => {}).then(async () => {
      await fs.mkdir(this.directory, { recursive: true, mode: 0o700 });
      const file = path.join(this.directory, `peers-${crypto.randomUUID()}.tmp`);
      try {
        await fs.writeFile(file, snapshot, { flag: 'wx', mode: 0o600 });
        await fs.rename(file, path.join(this.directory, 'peers.json'));
      } finally { await fs.rm(file, { force: true }); }
    });
    this.writes = save;
    return save;
  }
}
