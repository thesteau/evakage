// Test-only adapter. Every server operation executes in the Go test binary;
// production has neither this adapter nor the testbridge control listener.
import { spawn } from 'node:child_process';
import { Worker } from 'node:worker_threads';
import { EventEmitter } from 'node:events';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import type { Readable } from 'node:stream';

const root = path.resolve(fileURLToPath(new URL('.', import.meta.url)), '../../..');
const executable = path.join(root, 'dist', process.platform === 'win32' ? 'evakage-test.exe' : 'evakage-test');
export const PAIRING_CODE_MAX_AGE_MS = 3 * 24 * 60 * 60 * 1000;
type Options = Record<string, any>;
type Rpc = (action: string, input?: Options) => any;

// A worker performs synchronous HTTP so existing assertions and
// Map getters can remain synchronous while the Go server runs independently.
const rpcScript = `const {parentPort}=require('node:worker_threads'); parentPort.on('message',async input=>{const state=new Int32Array(input.shared,0,2);try{const r=await fetch(input.url,{method:'POST',headers:{authorization:input.secret,'content-type':'application/json'},body:JSON.stringify(input.body)});const text=await r.text();const bytes=Buffer.from(r.ok?text:JSON.stringify({failure:text}));new Uint8Array(input.shared,8).set(bytes);Atomics.store(state,1,bytes.length);}catch(e){const bytes=Buffer.from(JSON.stringify({failure:String(e)}));new Uint8Array(input.shared,8).set(bytes);Atomics.store(state,1,bytes.length);}Atomics.store(state,0,1);Atomics.notify(state,0);});`;

export function createEvakageServer(options: Options = {}) {
  let child: ReturnType<typeof spawn> | undefined;
  let control = '';
  let secret = '';
  let port = 0;
  let stopped = false;
  let worker: Worker;
  const interceptors = new Map<string, ReturnType<typeof setInterval>>();
  const shared = new SharedArrayBuffer(8 * 1024 * 1024);
  const state = new Int32Array(shared, 0, 2);
  const clocks = () => ({ pairingNow: options.pairingNow?.(), blobNow: options.blobs?.now?.() });
  const rpc: Rpc = (action, input = {}) => {
    Atomics.store(state, 0, 0);
    worker.postMessage({ shared, url: `${control}/rpc`, secret, body: JSON.parse(JSON.stringify({ action, ...clocks(), ...input })) });
    if (Atomics.wait(state, 0, 0, 15000) === 'timed-out') throw new Error('Go test control timed out');
    const response = JSON.parse(Buffer.from(shared, 8, Atomics.load(state, 1)).toString());
    if (response.failure) throw new Error(`Go test control failed: ${response.failure}`);
    for (const notice of response.notices || []) blobStore.onNotice?.(new Set(Object.keys(notice.Participants)), notice.Message);
    return response.result;
  };
  const snapshot = () => rpc('snapshot');
  const record = (target: string, id: string, value: any): any => {
    if (!value) return undefined;
    if (target === 'client') {
      const ws = new EventEmitter() as EventEmitter & { close: (code?: number, reason?: string) => void; send: (data: string) => void; terminate: () => void };
      ws.close = (code = 1000, reason = '') => { rpc('close', { id, code, reason }); };
      ws.terminate = () => ws.close();
      ws.send = data => { rpc('send', { id, message: JSON.parse(data) }); };
      let send = ws.send;
      Object.defineProperty(ws, 'send', { get: () => send, set: (fn: typeof ws.send) => {
        send = fn;
        rpc('intercept', { id });
        if (interceptors.has(id)) clearInterval(interceptors.get(id));
        const timer = setInterval(() => { for (const message of rpc('intercepted', { id })) fn(JSON.stringify(message)); }, 10);
        timer.unref(); interceptors.set(id, timer);
      } });
      const once = ws.once.bind(ws);
      ws.once = ((event: string, callback: (...args: any[]) => void) => {
        if (event === 'close') {
          const timer = setInterval(() => { if (!snapshot().clients[id]) { clearInterval(timer); callback(); } }, 20);
          timer.unref();
          return ws;
        }
        return once(event, callback);
      }) as typeof ws.once;
      value.ws = ws;
    }
    if (target === 'room') {
      value.members = new Set(value.members);
      value.away = new Proxy(new Map<string, number>(Object.entries(value.away)), {
        get(map, key) { if (key === 'set') return (device: string, at: number) => { rpc('set', { target: 'away', id, field: device, value: at }); map.set(device, at); return map; }; const v = Reflect.get(map, key); return typeof v === 'function' ? v.bind(map) : v; },
      });
    }
    if (target === 'blob') for (const key of ['recipients', 'participants', 'released']) value[key] = new Set(value[key]);
    return new Proxy(value, { set(obj, field, v) { rpc('set', { target, id, field, value: v }); obj[field] = v; return true; } });
  };
  const remoteMap = (key: string, target: string): Map<string, any> => new Proxy(new Map<string, any>(), {
    get(_map, field) {
      const values = () => { const data = snapshot(); const order: string[] = data[`${key}Order`] || Object.keys(data[key]); return new Map<string, any>(order.map(id => [id, record(target, id, data[key][id])])); };
      if (field === 'size') return Object.keys(snapshot()[key]).length;
      if (field === 'get') return (id: string) => { const values = snapshot()[key]; return Object.hasOwn(values, id) ? record(target, id, values[id]) : undefined; };
      if (field === 'has') return (id: string) => Object.hasOwn(snapshot()[key], id);
      const map = values(); const v = Reflect.get(map, field); return typeof v === 'function' ? v.bind(map) : v;
    },
  });
  const stream = async (id: string, token: string, request: Readable, offset?: number) => {
    const response = await fetch(`${control}/receive?input=${encodeURIComponent(JSON.stringify({ id, token, offset }))}`, {
      method: 'POST', headers: { authorization: secret }, body: (async function* () { for await (const chunk of request) { rpc('snapshot'); yield chunk; } })() as any, duplex: 'half',
    } as RequestInit);
    const result = await response.json();
    if (result.status === 204) { const blob = blobStore.blobs.get(id); if (blob?.complete) blobStore.onAvailable?.(blob); }
    return result;
  };
  const blobStore: {
    config: Options; blobs: Map<string, any>; onNotice?: (participants: Set<string>, message: string) => void; onAvailable?: (blob: any) => void;
    offer: (input: Options) => Promise<any>; receive: (id: string, token: string, request: Readable) => Promise<any>; receiveChunk: (id: string, token: string, offset: number, request: Readable) => Promise<any>;
    stats: () => any; claim: (id: string, device: string) => Promise<any>; release: (id: string, device: string) => Promise<any>; pendingFor: (device: string) => Promise<any[]>;
    remove: (id: string) => Promise<any>; revokeDevice: (id: string) => Promise<any>; sweepAged: () => Promise<string[]>; refreshLiveness: () => void; expiresAt: (blob: any) => number; beginDownload: (id: string) => () => void; openForDownload: (id: string, token: string) => any; uploadStatus: (id: string, token: string) => any;
  } = {
    config: new Proxy({}, { get(_t, k) { return snapshot().blobConfig[k]; }, set(_t, field, value) { rpc('set', { target: 'blobConfig', field, value }); return true; } }),
    blobs: remoteMap('blobs', 'blob'),
    async offer(input) { if (input.authorized && !input.authorized()) return { error: 'This connection is no longer authorized.' }; const result = rpc('offer', { input }); if (result.blob && result.blob.complete) blobStore.onAvailable?.(result.blob); return result; },
    receive: (id, token, request) => stream(id, token, request),
    receiveChunk: (id, token, offset, request) => stream(id, token, request, offset),
    stats: () => rpc('stats'),
    claim: async (id, device) => rpc('claim', { id, device }),
    release: async (id, device) => rpc('release', { id, device }),
    pendingFor: async device => rpc('pendingFor', { device }),
    remove: async id => rpc('remove', { id }),
    revokeDevice: async device => rpc('revokeDevice', { device }),
    sweepAged: async () => rpc('sweepAged'),
    refreshLiveness: () => { rpc('refreshLiveness'); },
    expiresAt: blob => rpc('expiresAt', { id: blob.id }),
    beginDownload: id => { rpc('beginDownload', { id }); let finished = false; return () => { if (!finished) { finished = true; rpc('finishDownload', { id }); } }; },
    openForDownload: (id, token) => rpc('openForDownload', { id, token }),
    uploadStatus: (id, token) => rpc('uploadStatus', { id, token }),
  };
  return {
    clients: remoteMap('clients', 'client'), rooms: remoteMap('rooms', 'room'), recentDevices: remoteMap('recentDevices', 'recent'), blobStore,
    get limits(): any { return snapshot().limits; },
    get downloads(): number { return rpc('downloads'); },
    syncClocks() { rpc('snapshot'); },
    rotatePairingCodes() { rpc('rotatePairingCodes'); }, expireAway() { return rpc('expireAway'); },
    pairingIssue(id: string): { code: string; expiresAt: number } { return rpc('pairingIssue', { id }); },
    pairingResolve(code: string): string | null { return rpc('pairingResolve', { code }); },
    pairingPrune() { rpc('pairingPrune'); },
    async start() {
      child = spawn(executable, [], { cwd: root, stdio: ['pipe', 'pipe', 'pipe'] });
      let errors = '';
      child.stderr?.on('data', chunk => { errors += chunk; });
      const startup = new Promise<void>((resolve, reject) => {
        let output = '';
        child!.once('error', reject);
        child!.once('exit', code => { if (!control) reject(new Error(`Go server startup failed (${code}): ${errors}`)); });
        child!.stdout?.on('data', chunk => { output += chunk; if (!control && output.includes('\n')) { try { const info = JSON.parse(output.split('\n')[0]); control = info.control; secret = info.secret; port = info.port; resolve(); } catch (error) { reject(error); } } });
      });
      child.stdin!.end(JSON.stringify(options) + '\n');
      await startup;
      worker = new Worker(rpcScript, { eval: true });
      worker.unref();
      rpc('snapshot');
      return { port, address: '127.0.0.1', family: 'IPv4' };
    },
    async stop(_options: Options = {}) { if (stopped || !child) return; stopped = true; for (const timer of interceptors.values()) clearInterval(timer); const exited = new Promise<void>(resolve => child!.once('exit', () => resolve())); rpc('stop'); await exited; await worker.terminate(); },
  };
}

// Pairing-code unit tests use the Go implementation through the same runner.
// This helper is async so its subprocess is always owned by the test lifecycle.
export async function createPairingCodes(now: () => number = Date.now) {
  const app = createEvakageServer({ host: '127.0.0.1', port: 0, pairingNow: now, blobs: { dir: path.join(root, '.local', `pairing-${process.pid}-${Math.random().toString(16).slice(2)}`) } });
  await app.start();
  return { app, issue: (id: string) => app.pairingIssue(id), resolve: (code: string) => app.pairingResolve(code), prune: () => app.pairingPrune() };
}
