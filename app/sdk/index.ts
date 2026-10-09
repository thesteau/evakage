import { EventEmitter } from 'node:events';
import fs from 'node:fs/promises';
import { openAsBlob } from 'node:fs';
import path from 'node:path';
import WebSocket from 'ws';
import { signTranscript, verifyAdvertisedIdentity } from '../core/identity.js';
import { buildEnvelope, buildMessageEnvelope, cipherLayout, createBodyDecryptor, encryptBodyChunks, generateContentKey, openEnvelope, openMessageEnvelope, verifiedPlaintext } from '../core/relay.js';
import { messageKey, messageScope, signMessage, verifyMessage } from '../core/messages.js';
import { hashBlob } from '../core/sha256.js';
import { FileStore, type ClientStore } from './store.js';
import type { Device, Identity, Message, FileMeta } from '../core/types.js';

export { FileStore, MemoryStore } from './store.js';
export type { ClientStore } from './store.js';
export type { Device, Message } from '../core/types.js';
export const PROTOCOL_VERSION = 3;
const FRAME_LIMIT = 256 * 1024;
type Wire = Record<string, any>;
export type Room = { id: string; code?: string; name: string; access: 'private' | 'protected' | 'public'; members: Device[]; away: Device[]; owned?: boolean; awaiting?: boolean; requests?: Device[] };
export type ReceivedMessage = Message & { conv: string; blobId: string };
export type IncomingFile = { blobId: string; from: string; conv: string; expiresAt: number; meta: FileMeta; save(destination: string): Promise<void>; discard(): void };
export type ClientEvents = {
  online: [Device]; offline: [{ code: number; reason: string }]; message: [ReceivedMessage];
  file: [IncomingFile]; presence: [Device[]]; paired: [Device]; room: [Room]; rooms: [Room[]];
  warning: [string]; 'client-error': [Error];
};
export interface ClientOptions {
  url: string;
  token?: string;
  store?: ClientStore;
  discoverable?: boolean;
  autoReconnect?: boolean;
  timeoutMs?: number;
}
type Waiter = { match: (m: Wire) => boolean; context: string; requestId?: string; blobId?: string; resolve: (m: Wire) => void; reject: (e: Error) => void; timer: ReturnType<typeof setTimeout> };

/** A registered device speaking the same encrypted relay protocol as the browser. */
export class EvakageClient extends EventEmitter<ClientEvents> {
  readonly url: URL;
  readonly store: ClientStore;
  self?: Device;
  config?: Wire;
  online = false;
  private identity?: Identity;
  private socket?: WebSocket;
  private connecting?: Promise<Device>;
  private stopped = true;
  private retry?: ReturnType<typeof setTimeout>;
  private backoff = 500;
  private readonly cookies = new Map<string, string>();
  private readonly paired = new Map<string, Device>();
  private readonly records = new Map<string, Device>();
  private readonly accountPeers = new Set<string>();
  private readonly joined = new Set<string>();
  private readonly roomRecords = new Map<string, Room>();
  private readonly pending = new Set<Waiter>();
  private readonly inbound = new Set<string>();
  private readonly seenMessages = new Set<string>();
  private roomsQueue: Promise<unknown> = Promise.resolve();
  private processing: Promise<void> = Promise.resolve();
  private readonly downloads = new Set<AbortController>();
  constructor(private readonly options: ClientOptions) {
    super();
    this.url = new URL(options.url);
    if (!['http:', 'https:'].includes(this.url.protocol) || this.url.username || this.url.password || this.url.pathname !== '/' || this.url.search || this.url.hash)
      {throw new Error('Use an HTTP(S) server origin without a path, query or credentials');}
    this.store = options.store ?? new FileStore();
  }
  private get timeout() { return this.options.timeoutMs ?? 20000; }
  private notify(error: unknown) { this.emit('client-error', error instanceof Error ? error : new Error(String(error))); }
  private cookieHeader(account = false) {
    return [...this.cookies].filter(([name]) => name === 'evakage_auth' || account && name === 'evakage_account').map(([name, value]) => `${name}=${value}`).join('; ');
  }
  private async http(route: string, init: RequestInit = {}) {
    const headers = new Headers(init.headers);
    const cookie = this.cookieHeader(route.startsWith('/account/'));
    if (cookie) headers.set('Cookie', cookie);
    const response = await fetch(new URL(route, this.url), { ...init, headers, redirect: 'manual', signal: init.signal ?? AbortSignal.timeout(this.timeout) });
    for (const cookie of response.headers.getSetCookie()) {
      const pair = cookie.split(';', 1)[0], i = pair.indexOf('=');
      const name = pair.slice(0, i);
      if (['evakage_auth', 'evakage_account'].includes(name)) this.cookies.set(name, pair.slice(i + 1));
    }
    return response;
  }
  private async json(route: string, body?: object, method = 'POST') {
    const response = await this.http(route, body ? { method, headers: { Origin: this.url.origin, 'Content-Type': 'application/json' }, body: JSON.stringify(body) } : {});
    const value = await response.json().catch(() => null);
    if (!response.ok) throw Object.assign(new Error(value?.error ?? `HTTP request failed (${response.status})`), { status: response.status });
    return value;
  }
  connect(): Promise<Device> {
    if (this.online && this.self) return Promise.resolve(this.self);
    if (this.connecting) return this.connecting;
    this.stopped = false;
    clearTimeout(this.retry);
    const run = this.open();
    this.connecting = run;
    void run.finally(() => { if (this.connecting === run) this.connecting = undefined; }).catch(() => {});
    return run;
  }
  private async open(): Promise<Device> {
    this.identity = await this.store.identity();
    for (const peer of await this.store.peers()) await this.remember(peer, true, false);
    if (this.options.token) {
      const response = await this.http(`/?token=${encodeURIComponent(this.options.token)}`);
      if (response.status !== 302) throw new Error('Server access token was rejected');
      await response.body?.cancel();
    }
    this.config = await this.json('/config.json');
    if (this.config?.protocol !== PROTOCOL_VERSION || !this.config?.relay?.enabled) throw new Error('Unsupported Evakage protocol or disabled relay');
    if (this.stopped) throw new Error('Client disconnected');
    const endpoint = new URL(this.url); endpoint.protocol = endpoint.protocol === 'https:' ? 'wss:' : 'ws:';
    const ws = new WebSocket(endpoint, { headers: { Cookie: this.cookieHeader(), Origin: this.url.origin }, handshakeTimeout: this.timeout, maxPayload: FRAME_LIMIT, perMessageDeflate: false });
    this.socket = ws;
    let queue: Promise<void> = Promise.resolve();
    const registration = this.wait(m => m.type === 'registered', 'register');
    ws.on('message', (bytes, binary) => {
      if (binary || this.socket !== ws) return;
      queue = queue.then(async () => {
        if (this.socket !== ws) return;
        const value = JSON.parse(bytes.toString());
        if (!value || typeof value.type !== 'string') throw new Error('Invalid server frame');
        await this.handle(value);
      }).catch(error => this.notify(error));
      this.processing = queue;
    });
    ws.on('error', error => { this.rejectPending(error); this.notify(error); });
    ws.on('close', (code, reason) => {
      if (this.socket !== ws) return;
      this.socket = undefined;
      this.online = false;
      this.accountPeers.clear();
      this.inbound.clear();
      this.rejectPending(new Error(`Connection closed (${code}): ${reason.toString()}`));
      for (const controller of this.downloads) controller.abort();
      this.emit('offline', { code, reason: reason.toString() });
      if (!this.stopped && this.options.autoReconnect !== false && code !== 1008 && code !== 4001) this.scheduleReconnect();
    });
    try {
      const reply = await registration;
      if (!this.online) throw new Error('Connection lost during registration');
      return reply.self;
    } catch (error) {
      ws.terminate();
      throw error;
    }
  }
  private scheduleReconnect() {
    clearTimeout(this.retry);
    this.retry = setTimeout(() => {
      this.connect().catch(error => { this.notify(error); if (!this.stopped) this.scheduleReconnect(); });
    }, this.backoff);
    this.backoff = Math.min(this.backoff * 2, 30000);
  }
  async disconnect() {
    this.stopped = true;
    clearTimeout(this.retry);
    for (const controller of this.downloads) controller.abort();
    const ws = this.socket;
    if (!ws) { await this.processing; return; }
    await new Promise<void>(resolve => {
      if (ws.readyState === WebSocket.CLOSED) { resolve(); return; }
      const timer = setTimeout(() => ws.terminate(), 1000);
      ws.once('close', () => { clearTimeout(timer); resolve(); });
      if (ws.readyState === WebSocket.OPEN) ws.close(); else ws.terminate();
    });
    await this.processing;
  }
  private send(frame: Wire) {
    if (!this.socket || this.socket.readyState !== WebSocket.OPEN) throw new Error('Client is offline');
    const text = JSON.stringify(frame);
    if (Buffer.byteLength(text) > FRAME_LIMIT) throw new Error('Message exceeds the protocol frame limit');
    this.socket.send(text);
  }
  private wait(match: Waiter['match'], context: string, send?: () => void, requestId?: string, blobId?: string): Promise<Wire> {
    return new Promise((resolve, reject) => {
      const waiter: Waiter = { match, context, requestId, blobId, resolve, reject, timer: setTimeout(() => {
        this.pending.delete(waiter); reject(new Error(`Timed out waiting for ${context}`));
      }, this.timeout) };
      this.pending.add(waiter);
      try { send?.(); }
      catch (error) { clearTimeout(waiter.timer); this.pending.delete(waiter); reject(error); }
    });
  }
  private rejectPending(error: Error) {
    for (const waiter of this.pending) { clearTimeout(waiter.timer); waiter.reject(error); }
    this.pending.clear();
  }
  private request(frame: Wire) {
    const requestId = crypto.randomUUID();
    return this.wait(m => m.requestId === requestId, frame.type, () => this.send({ ...frame, requestId }), requestId);
  }
  private async remember(peer: Device, paired = false, persist = true) {
    const verified = await verifyAdvertisedIdentity({ ...peer, deviceId: peer.id });
    if (!verified) throw new Error('Peer identity or seal key did not verify');
    this.records.set(peer.id, peer);
    if (paired) this.paired.set(peer.id, peer);
    else if (this.paired.has(peer.id)) this.paired.set(peer.id, peer);
    if (persist && this.paired.has(peer.id)) await this.store.savePeers([...this.paired.values()]);
    return verified.sealRaw;
  }
  private async handle(m: Wire) {
    const identity = this.identity!;
    if (m.type === 'registration-challenge') {
      if (typeof m.challenge !== 'string' || m.challenge.length > 128) throw new Error('Invalid registration challenge');
      this.send({ type: 'register', deviceId: identity.deviceId, platform: 'Node', browser: 'API', relayOnly: true, discoverable: this.options.discoverable ?? false, identityKey: identity.identityKey, sealKey: identity.sealKey, sealKeySignature: identity.sealKeySignature, registrationProof: await signTranscript(identity.privateKey, JSON.stringify(['evakage/register/1', m.challenge, identity.deviceId])) });
      return;
    }
    if (m.type === 'registered') {
      for (const id of m.revoked ?? []) { this.paired.delete(id); this.records.delete(id); }
      for (const peer of m.paired ?? []) await this.remember(peer, true, false);
      await this.store.savePeers([...this.paired.values()]);
      if (this.socket?.readyState !== WebSocket.OPEN) return;
      if (m.self?.id !== identity.deviceId) throw new Error('Registration identity mismatch');
      const self: Device = m.self;
      this.self = self;
      this.online = true;
      this.backoff = 500;
      this.emit('online', self);
      if (this.paired.size) this.send({ type: 'lookup-devices', requestId: crypto.randomUUID(), deviceIds: [...this.paired.keys()].slice(0, 200) });
      for (const id of this.joined) this.send({ type: 'join-room', roomId: id, recreate: true });
      if (this.cookies.get('evakage_account')) void this.attachAccount().catch(error => this.notify(error));
    } else if (m.type === 'presence' || m.type === 'devices-found' || m.type === 'account-peers') {
      const peers = m.peers ?? m.devices ?? [];
      if (m.type === 'account-peers') this.accountPeers.clear();
      for (const peer of peers) {
        if (peer.id === identity.deviceId) continue;
        await this.remember(peer);
        if (m.type === 'account-peers') this.accountPeers.add(peer.id);
      }
      if (m.type === 'presence') this.emit('presence', peers);
    } else if (m.type === 'paired-device' && m.peer) {
      await this.remember(m.peer, true);
      this.emit('paired', m.peer);
    } else if (m.type === 'pairing-code') {
      if (this.self) Object.assign(this.self, { pairingCode: m.code, pairingCodeExpiresAt: m.expiresAt });
    } else if (m.type === 'pairing-revoked') {
      this.paired.delete(m.deviceId); this.records.delete(m.deviceId);
      await this.store.savePeers([...this.paired.values()]);
    } else if (m.type === 'room-joined') {
      this.joined.add(m.room.id); await this.adoptRoom(m.room); this.emit('room', m.room);
    } else if (m.type === 'rooms') {
      const listed = new Set<string>(m.rooms.map((room: Room) => room.id));
      for (const id of this.roomRecords.keys()) if (!listed.has(id)) this.roomRecords.delete(id);
      for (const room of m.rooms) await this.adoptRoom(room);
      this.emit('rooms', m.rooms);
    } else if (m.type === 'room-left' || m.type === 'room-destroyed') {
      this.joined.delete(m.roomId); this.roomRecords.delete(m.roomId);
    } else if (m.type === 'account-reset') {
      this.accountPeers.clear(); this.joined.clear(); this.roomRecords.clear(); this.cookies.delete('evakage_account');
    } else if (m.type === 'blob-available') {
      await this.receive(m);
    } else if (m.type === 'relay-notice') this.emit('warning', m.message);
    if (m.type === 'error' && m.context === 'join-room' && m.roomId) {
      this.joined.delete(m.roomId); this.roomRecords.delete(m.roomId);
    }
    let matched = false;
    for (const waiter of this.pending) {
      const failed = m.type === 'error' && m.context === waiter.context && (!waiter.requestId || m.requestId === waiter.requestId) && (!waiter.blobId || m.blobId === waiter.blobId);
      if (failed || waiter.match(m)) {
        clearTimeout(waiter.timer); this.pending.delete(waiter); matched = true;
        if (failed) waiter.reject(new Error(m.message)); else waiter.resolve(m);
      }
    }
    if (m.type === 'error' && !matched) this.notify(new Error(m.message));
  }
  private async adoptRoom(room: Room) {
    this.roomRecords.set(room.id, room);
    for (const peer of [...room.members, ...room.away]) if (peer.id !== this.identity?.deviceId) await this.remember(peer);
  }
  async pair(code: string, expectedId?: string): Promise<Device> {
    const reply = await this.request({ type: 'pair-device', code, ...(expectedId ? { targetId: expectedId } : {}) });
    if (!reply.peer) throw new Error('Pairing invitation is invalid, expired or belongs to another device');
    return reply.peer;
  }
  async unpair(deviceId: string) {
    this.send({ type: 'unpair-device', deviceId });
    this.paired.delete(deviceId); this.records.delete(deviceId);
    await this.store.savePeers([...this.paired.values()]);
  }
  peers() { return [...this.paired.values()]; }
  rooms() { return [...this.roomRecords.values()]; }
  async login(username: string, password: string, register = false) {
    const reply = await this.json(register ? '/account/register' : '/account/login', { username, password });
    await this.attachAccount();
    return reply;
  }
  private async attachAccount() {
    const reply = await this.json('/account/connect', { deviceId: this.identity!.deviceId });
    await this.wait(m => m.type === 'account-peers' && m.signedIn === true, 'account-connect', () => this.send({ type: 'account-connect', token: reply.token }));
  }
  async logout() { await this.json('/account/logout', {}); }
  private roomAction(frame: Wire, match: (m: Wire) => boolean) {
    const run = this.roomsQueue.catch(() => {}).then(() => this.wait(match, frame.type, () => this.send(frame)));
    this.roomsQueue = run;
    return run;
  }
  async createRoom(name: string, access: Room['access'] = 'private'): Promise<Room> {
    const reply = await this.roomAction({ type: 'create-room', name, access }, m => m.type === 'room-joined' && m.created === true);
    return reply.room;
  }
  async joinRoom(code: string): Promise<Room | { pending: true; id: string; name: string }> {
    const reply = await this.roomAction({ type: 'join-room', code }, m => m.type === 'room-joined' || m.type === 'room-pending');
    return reply.type === 'room-pending' ? { pending: true, id: reply.roomId, name: reply.name } : reply.room;
  }
  leaveRoom(roomId: string) { this.send({ type: 'leave-room', roomId }); this.joined.delete(roomId); this.roomRecords.delete(roomId); }
  approveRoom(roomId: string, deviceId: string, approve = true) { this.send({ type: 'room-approve', roomId, deviceId, approve }); }
  setRoomAccess(roomId: string, access: Room['access']) { this.send({ type: 'room-access', roomId, access }); }
  private async targets(destination: string) {
    if (!this.online || !this.identity) throw new Error('Connect the client first');
    const room = destination.startsWith('room:') ? this.roomRecords.get(destination.slice(5)) : undefined;
    const ids = destination.startsWith('room:')
      ? this.joined.has(destination.slice(5)) && room ? [...room.members, ...room.away].map(p => p.id).filter(id => id !== this.identity!.deviceId) : []
      : [destination];
    if (!ids.length) throw new Error('No recipients in this conversation');
    const targets = [];
    for (const id of [...new Set(ids)]) {
      if (!destination.startsWith('room:') && id !== this.identity.deviceId && !this.paired.has(id) && !this.accountPeers.has(id)) throw new Error('Pair with the recipient first');
      const peer = id === this.identity.deviceId ? { ...this.identity, id } : this.records.get(id) ?? [...room?.members ?? [], ...room?.away ?? []].find(peer => peer.id === id);
      if (!peer) throw new Error('Recipient device record is unavailable');
      const verified = await verifyAdvertisedIdentity({ ...peer, deviceId: id });
      if (!verified) throw new Error('Recipient key did not verify');
      targets.push({ id, sealRaw: verified.sealRaw });
    }
    return { targets, conv: room ? destination : 'direct' };
  }
  async sendText(destination: string, text: string) {
    if (!text.trim() || text.length > 20000) throw new Error('Messages must contain 1–20000 characters');
    const { targets, conv } = await this.targets(destination);
    const identity = this.identity!;
    const message = await signMessage(identity, messageScope(conv, [identity.deviceId, ...targets.map(t => t.id)]), { id: crypto.randomUUID(), text, from: identity.deviceId, fromName: this.self!.name, at: Date.now() });
    const base = { type: 'blob-offer', kind: 'message', conv, bytes: 0, chunkSize: 1, totalChunks: 0 };
    let envelopes: Wire = {};
    const offered: string[] = [];
    for (const target of targets) {
      const box = await buildMessageEnvelope({ identity, recipientId: target.id, recipientSealRaw: target.sealRaw, conv, message });
      const next = { ...envelopes, [target.id]: box };
      if (Buffer.byteLength(JSON.stringify({ ...base, requestId: crypto.randomUUID(), envelopes: next })) > FRAME_LIMIT) {
        if (!Object.keys(envelopes).length) throw new Error('Message exceeds the protocol frame limit');
        offered.push((await this.request({ ...base, envelopes })).blobId); envelopes = {};
      }
      envelopes[target.id] = box;
    }
    offered.push((await this.request({ ...base, envelopes })).blobId);
    return { messageId: message.id, blobIds: offered };
  }
  async sendFile(destination: string, source: string | Blob, options: { name?: string; type?: string } = {}) {
    const { targets, conv } = await this.targets(destination);
    const blob = typeof source === 'string' ? await openAsBlob(source) : source;
    if (blob.size > this.config!.maxFileBytes) throw new Error('File exceeds the server size limit');
    const chunkSize = this.config!.relay.chunkSize;
    const layout = cipherLayout(blob.size, chunkSize);
    const key = await generateContentKey();
    const meta = { id: crypto.randomUUID(), name: options.name ?? (typeof source === 'string' ? path.basename(source) : 'file.bin'), type: options.type ?? (blob.type || 'application/octet-stream'), size: blob.size, sha256: await hashBlob(blob), chunkSize, totalChunks: layout.totalChunks, addedAt: Date.now(), fromName: this.self!.name };
    if (!meta.name || meta.name.length > 512) throw new Error('Invalid file name');
    const envelopes: Wire = {};
    for (const target of targets) envelopes[target.id] = await buildEnvelope({ identity: this.identity!, recipientId: target.id, recipientSealRaw: target.sealRaw, conv, meta, contentKeyRaw: key.raw });
    const offered = await this.request({ type: 'blob-offer', kind: 'file', conv, ...layout, chunkSize, envelopes });
    const route = `/blob/${encodeURIComponent(offered.blobId)}?token=${encodeURIComponent(offered.uploadToken)}`;
    try {
      let offset = 0;
      const upload = async (part: Blob) => {
        const response = await this.http(`${route}&offset=${offset}`, { method: 'PUT', body: part });
        if (response.status !== 204) throw new Error(`Upload failed (${response.status}); resend the file`);
        offset += part.size;
      };
      for await (const part of encryptBodyChunks(blob, key.key, meta.id, chunkSize)) await upload(part);
      if (!blob.size) await upload(new Blob());
      return { blobId: offered.blobId, fileId: meta.id, expiresAt: offered.expiresAt };
    } catch (error) { if (this.online) this.send({ type: 'blob-cancel', blobId: offered.blobId }); throw error; }
  }
  private allowed(notice: Wire) {
    if (notice.conv === 'direct') return notice.from === this.identity?.deviceId || this.paired.has(notice.from) || this.accountPeers.has(notice.from);
    const id = typeof notice.conv === 'string' && notice.conv.startsWith('room:') ? notice.conv.slice(5) : '';
    const room = this.roomRecords.get(id);
    return this.joined.has(id) && [...room?.members ?? [], ...room?.away ?? []].some(peer => peer.id === notice.from);
  }
  private async receive(notice: Wire) {
    if (!this.allowed(notice) || this.inbound.has(notice.blobId)) return;
    this.inbound.add(notice.blobId);
    const identity = this.identity!;
    const options = { sealPrivateKey: identity.sealPrivateKey, box: notice.envelope, selfId: identity.deviceId, expectedFrom: notice.from };
    try {
      if (notice.kind === 'message') {
        const opened = await openMessageEnvelope(options);
        if (opened.conv !== notice.conv) throw new Error('Conversation mismatch');
        const message = await verifyMessage(opened.message, messageScope(notice.conv, [identity.deviceId, notice.from]));
        if (!message) throw new Error('Message signature did not verify');
        const key = messageKey(message);
        if (!this.seenMessages.has(key)) {
          this.seenMessages.add(key);
          if (this.seenMessages.size > 2000) this.seenMessages.delete(this.seenMessages.values().next().value!);
          this.emit('message', { ...message, conv: notice.conv, blobId: notice.blobId } satisfies ReceivedMessage);
        }
        this.send({ type: 'blob-release', blobId: notice.blobId });
        this.inbound.delete(notice.blobId);
      } else if (notice.kind === 'file') {
        const opened = await openEnvelope(options);
        if (opened.meta.conv !== notice.conv || opened.meta.size > this.config!.maxFileBytes) throw new Error('Invalid file scope or size');
        if (typeof opened.meta.name !== 'string' || !opened.meta.name || opened.meta.name.length > 512 || !Number.isSafeInteger(opened.meta.size) || opened.meta.chunkSize > 1024 * 1024 || notice.chunkSize !== opened.meta.chunkSize)
          {throw new Error('Invalid file metadata');}
        const expected = cipherLayout(opened.meta.size, opened.meta.chunkSize);
        if (expected.bytes !== notice.bytes || expected.totalChunks !== notice.totalChunks) throw new Error('File layout mismatch');
        let saving: Promise<void> | undefined;
        const incoming: IncomingFile = { blobId: notice.blobId, from: notice.from, conv: notice.conv, expiresAt: notice.expiresAt, meta: opened.meta,
          save: destination => saving ??= this.save(notice, opened, destination).finally(() => { saving = undefined; }),
          discard: () => { this.send({ type: 'blob-release', blobId: notice.blobId }); this.inbound.delete(notice.blobId); } };
        this.emit('file', incoming);
      }
    } catch (error) {
      if (this.online) this.send({ type: 'blob-release', blobId: notice.blobId });
      this.inbound.delete(notice.blobId);
      this.notify(error);
    }
  }
  private async body(blobId: string, signal: AbortSignal) {
    const claim = await this.wait(m => m.type === 'blob-claimed' && m.blobId === blobId, 'blob-claim', () => this.send({ type: 'blob-claim', blobId }), undefined, blobId);
    const response = await this.http(`/blob/${encodeURIComponent(blobId)}?token=${encodeURIComponent(claim.downloadToken)}`, { signal });
    if (!response.ok || !response.body) throw new Error(`Download failed (${response.status})`);
    return response.body;
  }
  private async save(notice: Wire, opened: Awaited<ReturnType<typeof openEnvelope>>, destination: string) {
    const controller = new AbortController(); this.downloads.add(controller);
    const timeout = setTimeout(() => controller.abort(new Error('Download timed out')), this.timeout * 10);
    const file = path.resolve(destination);
    const temporary = path.join(path.dirname(file), `.evakage-${crypto.randomUUID()}.tmp`);
    const check = () => { controller.signal.throwIfAborted(); if (!this.allowed(notice)) throw new Error('Sender authorization was revoked'); };
    let handle: Awaited<ReturnType<typeof fs.open>> | undefined;
    try {
      const meta = opened.meta;
      const layout = { key: opened.contentKey, fileId: meta.id, chunkSize: meta.chunkSize, size: meta.size };
      const verify = createBodyDecryptor({ ...layout, retain: false });
      for await (const bytes of await this.body(notice.blobId, controller.signal)) { check(); await verify.push(bytes); }
      const verified = verify.finish();
      if (verified.sha256 !== meta.sha256) throw new Error('File SHA-256 did not verify');
      check();
      handle = await fs.open(temporary, 'wx', 0o600);
      const stream = await this.body(notice.blobId, controller.signal);
      for await (const bytes of verifiedPlaintext(stream, { ...layout, sha256: meta.sha256, digests: verified.digests })) { check(); await handle.writeFile(bytes); }
      check(); await handle.close(); handle = undefined;
      // A hard link publishes atomically and refuses to overwrite an existing file.
      await fs.link(temporary, file);
      if (this.online) this.send({ type: 'blob-release', blobId: notice.blobId });
      this.inbound.delete(notice.blobId);
    } finally {
      clearTimeout(timeout); this.downloads.delete(controller); await handle?.close(); await fs.rm(temporary, { force: true });
    }
  }
}
