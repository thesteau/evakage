import { bytesToBase64, base64ToBytes, fingerprintOf, signTranscript, safetyCode } from '../../core/identity.js';
export * from '../../core/identity.js';

// Long-lived device identity.
//
// The signaling server used to be trusted for "who is this peer": it handed out
// device IDs and could have substituted its own device for one you meant to talk
// to. Here the device ID *is* the fingerprint of a long-lived ECDSA P-256 public
// key, and every peer proves possession of that key over the DataChannel. A
// server that lies about identity now has to forge a signature.
//
// The private key is generated non-extractable and lives in IndexedDB, which is
// the only place a CryptoKey can be persisted. No message or file payload is
// ever stored — only this key, the display name, and the fingerprints of devices
// already seen (encrypted at rest; see the trust store below).

// Compatibility identifiers: the Evakage rename must preserve device keys,
// pairing records and the existing cryptographic protocol.
const DB_NAME = 'evakage-identity';
const DB_VERSION = 1;
const STORE = 'identity';
const RECORD = 'device';
const KNOWN_DEVICES_KEY = 'evakage-known-devices';
const SEAL_KEY_CONTEXT = 'evakage/sealkey/1';
const encoder = new TextEncoder();



function openDb(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(DB_NAME, DB_VERSION);
    request.onupgradeneeded = () => {
      if (!request.result.objectStoreNames.contains(STORE)) request.result.createObjectStore(STORE);
    };
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
}

function withStore<T>(
  db: IDBDatabase,
  mode: IDBTransactionMode,
  run: (store: IDBObjectStore) => IDBRequest<T>,
): Promise<T> {
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE, mode);
    const request = run(tx.objectStore(STORE));
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
}

export async function loadIdentity(): Promise<import('./types.js').Identity> {
  // Serialize first-use key creation across tabs of the same browser profile.
  if (navigator.locks) return navigator.locks.request('evakage-identity', loadIdentityRecord);
  return loadIdentityRecord();
}
async function loadIdentityRecord() {
  const db = await openDb();
  let record = await withStore(db, 'readonly', (store) => store.get(RECORD));
  let dirty = false;

  if (!record?.privateKey || !record?.publicKey) {
    // extractable:false applies to the private key; the public half stays
    // exportable, which is what we need to publish the fingerprint.
    const pair = await crypto.subtle.generateKey({ name: 'ECDSA', namedCurve: 'P-256' }, false, [
      'sign',
      'verify',
    ]);
    record = { privateKey: pair.privateKey, publicKey: pair.publicKey, createdAt: Date.now() };
    dirty = true;
  }

  // A second, ECDH key so a sender can seal a file to this device while it is
  // offline. The signing key cannot do key agreement, so it has to be separate;
  // it is bound to the identity by a signature rather than trusted on its own.
  if (!record.sealPrivateKey || !record.sealPublicKey) {
    const pair = await crypto.subtle.generateKey({ name: 'ECDH', namedCurve: 'P-256' }, false, [
      'deriveBits',
    ]);
    record.sealPrivateKey = pair.privateKey;
    record.sealPublicKey = pair.publicKey;
    dirty = true;
  }

  if (dirty) {
    // Compare-and-store in one transaction also covers browsers without Web Locks.
    // A concurrent tab's complete identity wins over a newly generated candidate.
    const candidate = record;
    record = await new Promise((resolve, reject) => {
      const tx = db.transaction(STORE, 'readwrite');
      const store = tx.objectStore(STORE);
      const request = store.get(RECORD);
      let winner = candidate;
      request.onsuccess = () => {
        const existing = request.result;
        if (
          existing?.privateKey &&
          existing?.publicKey &&
          existing?.sealPrivateKey &&
          existing?.sealPublicKey
        )
          {winner = existing;}
        else store.put(candidate, RECORD);
      };
      tx.oncomplete = () => resolve(winner);
      tx.onabort = () => reject(tx.error);
      tx.onerror = () => reject(tx.error);
    });
  }

  // Before the app reads any trust record, so lookups never see an empty list.
  await loadTrustStore(db);

  const raw = new Uint8Array(await crypto.subtle.exportKey('raw', record.publicKey));
  const sealRaw = new Uint8Array(await crypto.subtle.exportKey('raw', record.sealPublicKey));
  const fingerprint = await fingerprintOf(raw);
  const sealKey = bytesToBase64(sealRaw);
  const sealKeySignature = await signTranscript(
    record.privateKey,
    `${SEAL_KEY_CONTEXT}|${sealKey}`,
  );
  db.close();

  return {
    privateKey: record.privateKey,
    publicKey: record.publicKey,
    sealPrivateKey: record.sealPrivateKey,
    rawPublicKey: raw,
    identityKey: bytesToBase64(raw),
    sealKey,
    sealKeySignature,
    fingerprint,
    deviceId: fingerprint,
    createdAt: record.createdAt,
  };
}

/* ---------- trust-on-first-use store ---------- */

// Held as a Map, never as an object indexed by fingerprint: device IDs come from
// other devices, and one named `__proto__` must not reach an object's prototype
// (which would also make deviceTrust() report a stranger as known).

//
// The list names every device this browser has paired with, so it is kept
// encrypted at rest: AES-GCM under a non-extractable key stored beside the
// identity keys. It is decrypted once, when the identity loads, and read from
// memory after that, so lookups stay synchronous. Each change writes a fresh
// encrypted snapshot, in order. Revoked pairings are fingerprints too and
// travel in the same snapshot.

type TrustRecord = {
  name: string;
  firstSeen: number;
  lastSeen: number;
  verifiedAt?: number;
  pairedAt?: number;
  blocked?: boolean;
  hidden?: boolean;
};

const REVOKED_PAIRINGS_KEY = 'evakage-revoked-pairings';
const TRUST_KEY_RECORD = 'trust-key';
const SEALED_PREFIX = 'enc1:';

let trustKey: CryptoKey | null = null;
let knownDeviceCache = new Map<string, TrustRecord>();
let revokedCache = new Set<string>();
let trustWrites: Promise<void> = Promise.resolve();

function parseDevices(value: unknown) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return new Map();
  return new Map<string, TrustRecord>(
    Object.entries(value as Record<string, TrustRecord>).filter(
      ([, record]) => record && typeof record === 'object',
    ),
  );
}

function parseRevoked(value: unknown) {
  return new Set<string>(
    Array.isArray(value) ? value.filter((id): id is string => typeof id === 'string') : [],
  );
}

async function sealTrust(key: CryptoKey) {
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const plain = encoder.encode(
    JSON.stringify({
      devices: Object.fromEntries(knownDeviceCache),
      revoked: [...revokedCache],
    }),
  );
  const cipher = new Uint8Array(await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, key, plain));
  return `${SEALED_PREFIX}${bytesToBase64(iv)}:${bytesToBase64(cipher)}`;
}

async function openTrust(key: CryptoKey, stored: string) {
  const [iv, cipher] = stored.slice(SEALED_PREFIX.length).split(':');
  const plain = await crypto.subtle.decrypt(
    { name: 'AES-GCM', iv: base64ToBytes(iv) },
    key,
    base64ToBytes(cipher),
  );
  const parsed = JSON.parse(new TextDecoder().decode(plain));
  return { devices: parseDevices(parsed?.devices), revoked: parseRevoked(parsed?.revoked) };
}

/** Load (creating on first use) the trust key and decrypt the list into memory. */
async function loadTrustStore(db: IDBDatabase) {
  let key: CryptoKey | undefined = await withStore(db, 'readonly', (store) =>
    store.get(TRUST_KEY_RECORD),
  );
  if (!key) {
    const candidate = await crypto.subtle.generateKey({ name: 'AES-GCM', length: 256 }, false, [
      'encrypt',
      'decrypt',
    ]);
    // Compare-and-store, as for the identity: a concurrent tab's key wins.
    key = await new Promise<CryptoKey>((resolve, reject) => {
      const tx = db.transaction(STORE, 'readwrite');
      const store = tx.objectStore(STORE);
      const request = store.get(TRUST_KEY_RECORD);
      let winner = candidate;
      request.onsuccess = () => {
        if (request.result) winner = request.result;
        else store.put(candidate, TRUST_KEY_RECORD);
      };
      tx.oncomplete = () => resolve(winner);
      tx.onabort = () => reject(tx.error);
      tx.onerror = () => reject(tx.error);
    });
  }
  trustKey = key;

  let stored: string | null = null;
  let legacyRevoked: string | null = null;
  try {
    stored = localStorage.getItem(KNOWN_DEVICES_KEY);
    legacyRevoked = localStorage.getItem(REVOKED_PAIRINGS_KEY);
  } catch {}

  if (stored?.startsWith(SEALED_PREFIX)) {
    try {
      const opened = await openTrust(key, stored);
      knownDeviceCache = opened.devices;
      revokedCache = opened.revoked;
    } catch {
      // Sealed under a key this browser no longer has (its identity storage
      // was cleared): unreadable, so start empty, as a new device would.
      knownDeviceCache = new Map();
      revokedCache = new Set();
    }
  } else {
    // Plaintext from before encryption: read it once, then re-save sealed.
    try {
      knownDeviceCache = parseDevices(JSON.parse(stored || '{}'));
    } catch {
      knownDeviceCache = new Map();
    }
    try {
      revokedCache = parseRevoked(JSON.parse(legacyRevoked || '[]'));
    } catch {
      revokedCache = new Set();
    }
    if (stored != null || legacyRevoked != null) {
      saveKnownDevices();
      await flushKnownDevices();
    }
  }
  try {
    localStorage.removeItem(REVOKED_PAIRINGS_KEY);
  } catch {}
}

// Another tab saved a new snapshot: adopt it, so tabs agree on who is paired.
if (typeof window !== 'undefined') {
  window.addEventListener('storage', (event) => {
    if (event.key !== KNOWN_DEVICES_KEY || !trustKey) return;
    if (!event.newValue?.startsWith(SEALED_PREFIX)) return;
    openTrust(trustKey, event.newValue)
      .then((opened) => {
        knownDeviceCache = opened.devices;
        revokedCache = opened.revoked;
      })
      .catch(() => {});
  });
}

function loadKnownDevices() {
  return new Map(knownDeviceCache);
}

function saveKnownDevices(devices: Map<string, TrustRecord> = knownDeviceCache) {
  knownDeviceCache = new Map(devices);
  const key = trustKey;
  if (!key) return;
  // Chained so snapshots land in the order they were taken; each seals the
  // state as of its own turn, so the last write always holds the latest.
  trustWrites = trustWrites
    .then(() => sealTrust(key))
    .then((sealed) => {
      try {
        localStorage.setItem(KNOWN_DEVICES_KEY, sealed);
      } catch {}
    })
    .catch(() => {});
}

/** Resolves once every pending change to the list has been written. */
export function flushKnownDevices() {
  return trustWrites;
}

// A snapshot for listing. Look a single device up with deviceTrust().
export function knownDevices() {
  return [...loadKnownDevices()];
}

export function deviceTrust(fingerprint: string) {
  return loadKnownDevices().get(fingerprint) || null;
}

// First sighting is recorded; later sightings only refresh the name and time.
// Because the ID *is* the key fingerprint, a re-keyed device shows up as a new
// device rather than silently taking over an existing entry.

export function rememberDevice(fingerprint: string, name: string) {
  const devices = loadKnownDevices();
  const now = Date.now();
  const existing = devices.get(fingerprint);
  const record = {
    ...existing,
    name: name || existing?.name || '',
    firstSeen: existing?.firstSeen || now,
    lastSeen: now,
  };
  devices.set(fingerprint, record);
  saveKnownDevices(devices);
  return record;
}

export function pairingRevoked(fingerprint: string) {
  return revokedCache.has(fingerprint);
}

export function revokePairing(fingerprint: string) {
  revokedCache.add(fingerprint);
  const devices = loadKnownDevices();
  const record = devices.get(fingerprint);
  if (record) devices.set(fingerprint, { ...record, pairedAt: undefined, verifiedAt: undefined });
  saveKnownDevices(devices);
}

export function forgetDevice(fingerprint: string) {
  revokePairing(fingerprint);
  const devices = loadKnownDevices();
  devices.delete(fingerprint);
  saveKnownDevices(devices);
}

/** Remember an owner-authorized server-code pairing, independently of TOFU. */
export function pairDevice(fingerprint: string, name: string) {
  const record = rememberDevice(fingerprint, name);
  if (record.blocked) return false;
  const devices = loadKnownDevices();
  devices.set(fingerprint, { ...record, pairedAt: Date.now() });
  revokedCache.delete(fingerprint);
  saveKnownDevices(devices);
  return true;
}

/** Locally approve a fingerprint only after comparing its pairwise code. */
export async function verifyDevice(fingerprint: string, selfId: string, comparedCode: string) {
  const expected = await safetyCode(fingerprint, selfId);
  if (comparedCode.replace(/\s/g, '') !== expected.replace(/\s/g, '')) return false;
  const devices = loadKnownDevices();
  const record = devices.get(fingerprint);
  if (!record || record.blocked) return false;
  devices.set(fingerprint, { ...record, verifiedAt: Date.now() });
  saveKnownDevices(devices);
  return !!deviceTrust(fingerprint)?.verifiedAt;
}

export function blockDevice(fingerprint: string, blocked: boolean) {
  const devices = loadKnownDevices();
  const record = devices.get(fingerprint);
  if (!record) return;
  devices.set(fingerprint, {
    ...record,
    blocked,
    verifiedAt: blocked ? undefined : record.verifiedAt,
  });
  saveKnownDevices(devices);
}

/** Hiding affects the device list only; blocking controls exchanges. */
export function hideDevice(fingerprint: string, name: string, hidden: boolean) {
  rememberDevice(fingerprint, name);
  const devices = loadKnownDevices();
  const record = devices.get(fingerprint);
  if (record) {
    devices.set(fingerprint, { ...record, hidden });
    saveKnownDevices(devices);
  }
}
