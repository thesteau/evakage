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
// already seen.

// Compatibility identifiers: the Evakage rename must preserve device keys,
// pairing records and the existing cryptographic protocol.
const DB_NAME = 'evakage-identity';
const DB_VERSION = 1;
const STORE = 'identity';
const RECORD = 'device';
const KNOWN_DEVICES_KEY = 'evakage-known-devices';
const TRANSCRIPT_PREFIX = 'evakage/2';
const SEAL_KEY_CONTEXT = 'evakage/sealkey/1';
const SEAL_INFO = 'evakage/seal/1';

const encoder = new TextEncoder();

/** @returns {Promise<IDBDatabase>} */
function openDb() {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(DB_NAME, DB_VERSION);
    request.onupgradeneeded = () => {
      if (!request.result.objectStoreNames.contains(STORE)) request.result.createObjectStore(STORE);
    };
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
}

/** @template T @param {IDBDatabase} db @param {IDBTransactionMode} mode @param {(store: IDBObjectStore) => IDBRequest<T>} run @returns {Promise<T>} */
function withStore(db, mode, run) {
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE, mode);
    const request = run(tx.objectStore(STORE));
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
}

/** @param {Uint8Array} bytes */
export function bytesToBase64(bytes) {
  let binary = '';
  const step = 0x8000;
  for (let i = 0; i < bytes.length; i += step) binary += String.fromCharCode(...bytes.subarray(i, i + step));
  return btoa(binary);
}

/** @param {string} value */
export function base64ToBytes(value) {
  const binary = atob(value);
  const out = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) out[i] = binary.charCodeAt(i);
  return out;
}

const toBase64Url = (/** @type {Uint8Array} */ bytes) => bytesToBase64(bytes).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');

// The device ID other browsers see: a base64url SHA-256 of the raw public key.
// It satisfies the server's [A-Za-z0-9_-]{8,128} device-id rule as-is.
/** @param {BufferSource} rawPublicKey */
export async function fingerprintOf(rawPublicKey) {
  const digest = new Uint8Array(await crypto.subtle.digest('SHA-256', rawPublicKey));
  return toBase64Url(digest);
}

/** @returns {Promise<import('./types.js').Identity>} */
export async function loadIdentity() {
  // Serialize first-use key creation across tabs of the same browser profile.
  if (navigator.locks) return navigator.locks.request('evakage-identity', loadIdentityRecord);
  return loadIdentityRecord();
}
async function loadIdentityRecord() {
  const db = await openDb();
  let record = await withStore(db, 'readonly', store => store.get(RECORD));
  let dirty = false;

  if (!record?.privateKey || !record?.publicKey) {
    // extractable:false applies to the private key; the public half stays
    // exportable, which is what we need to publish the fingerprint.
    const pair = await crypto.subtle.generateKey({ name: 'ECDSA', namedCurve: 'P-256' }, false, ['sign', 'verify']);
    record = { privateKey: pair.privateKey, publicKey: pair.publicKey, createdAt: Date.now() };
    dirty = true;
  }

  // A second, ECDH key so a sender can seal a file to this device while it is
  // offline. The signing key cannot do key agreement, so it has to be separate;
  // it is bound to the identity by a signature rather than trusted on its own.
  if (!record.sealPrivateKey || !record.sealPublicKey) {
    const pair = await crypto.subtle.generateKey({ name: 'ECDH', namedCurve: 'P-256' }, false, ['deriveBits']);
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
        if (existing?.privateKey && existing?.publicKey && existing?.sealPrivateKey && existing?.sealPublicKey) winner = existing;
        else store.put(candidate, RECORD);
      };
      tx.oncomplete = () => resolve(winner);
      tx.onabort = () => reject(tx.error);
      tx.onerror = () => reject(tx.error);
    });
  }

  const raw = new Uint8Array(await crypto.subtle.exportKey('raw', record.publicKey));
  const sealRaw = new Uint8Array(await crypto.subtle.exportKey('raw', record.sealPublicKey));
  const fingerprint = await fingerprintOf(raw);
  const sealKey = bytesToBase64(sealRaw);
  const sealKeySignature = await signTranscript(record.privateKey, `${SEAL_KEY_CONTEXT}|${sealKey}`);
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
    createdAt: record.createdAt
  };
}

/**
 * Checks that an advertised identity really belongs to the device id the server
 * routed us to, and that its seal key was signed by that identity. Everything
 * here comes from the signaling server, so none of it is trusted until both
 * checks pass.

 * @param {{deviceId: string, identityKey?: string, sealKey?: string, sealKeySignature?: string}} record */
export async function verifyAdvertisedIdentity({ deviceId, identityKey, sealKey, sealKeySignature }) {
  if (typeof identityKey !== 'string' || typeof sealKey !== 'string' || typeof sealKeySignature !== 'string') return null;
  let identityRaw;
  let sealRaw;
  try {
    identityRaw = base64ToBytes(identityKey);
    sealRaw = base64ToBytes(sealKey);
  } catch {
    return null;
  }
  if (await fingerprintOf(identityRaw) !== deviceId) return null;
  const ok = await verifyTranscript(identityRaw, sealKeySignature, `${SEAL_KEY_CONTEXT}|${sealKey}`);
  return ok ? { identityRaw, sealRaw } : null;
}

/* ---------- sealed boxes (ECIES over P-256 + HKDF + AES-GCM) ---------- */

/** @param {BufferSource} sharedBits @param {BufferSource} salt @param {string} info */
async function sealKeyFrom(sharedBits, salt, info) {
  const base = await crypto.subtle.importKey('raw', sharedBits, 'HKDF', false, ['deriveKey']);
  return crypto.subtle.deriveKey(
    { name: 'HKDF', hash: 'SHA-256', salt, info: new TextEncoder().encode(info) },
    base,
    { name: 'AES-GCM', length: 256 },
    false,
    ['encrypt', 'decrypt']
  );
}

/**
 * Encrypts to a recipient's long-lived seal key. Unlike the DataChannel's
 * ephemeral exchange this needs no live peer, which is what makes a server-held
 * blob possible without the server being able to read it.

 * @param {BufferSource} recipientSealRaw @param {BufferSource} plaintext */
export async function seal(recipientSealRaw, plaintext, info = SEAL_INFO) {
  const ephemeral = await crypto.subtle.generateKey({ name: 'ECDH', namedCurve: 'P-256' }, true, ['deriveBits']);
  const recipient = await crypto.subtle.importKey('raw', recipientSealRaw, { name: 'ECDH', namedCurve: 'P-256' }, false, []);
  const shared = await crypto.subtle.deriveBits({ name: 'ECDH', public: recipient }, ephemeral.privateKey, 256);
  const ephemeralRaw = new Uint8Array(await crypto.subtle.exportKey('raw', ephemeral.publicKey));
  // The ephemeral public key is the HKDF salt, so each sealing is distinct.
  const key = await sealKeyFrom(shared, ephemeralRaw, info);
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const ciphertext = new Uint8Array(await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, key, plaintext));
  return {
    v: 1,
    ephemeral: bytesToBase64(ephemeralRaw),
    iv: bytesToBase64(iv),
    ciphertext: bytesToBase64(ciphertext)
  };
}

/** @param {CryptoKey} sealPrivateKey @param {import('./types.js').SealedBox} box */
export async function unseal(sealPrivateKey, box, info = SEAL_INFO) {
  if (!box || box.v !== 1) throw new Error('Unsupported sealed box');
  const ephemeralRaw = base64ToBytes(box.ephemeral);
  const ephemeral = await crypto.subtle.importKey('raw', ephemeralRaw, { name: 'ECDH', namedCurve: 'P-256' }, false, []);
  const shared = await crypto.subtle.deriveBits({ name: 'ECDH', public: ephemeral }, sealPrivateKey, 256);
  const key = await sealKeyFrom(shared, ephemeralRaw, info);
  const plain = await crypto.subtle.decrypt(
    { name: 'AES-GCM', iv: base64ToBytes(box.iv) },
    key,
    base64ToBytes(box.ciphertext)
  );
  return new Uint8Array(plain);
}

/** Random AES-256-GCM key used for a single file body. */
export async function generateContentKey() {
  const raw = crypto.getRandomValues(new Uint8Array(32));
  return { raw, key: await importContentKey(raw) };
}

/** @param {BufferSource} raw */
export function importContentKey(raw) {
  return crypto.subtle.importKey('raw', raw, { name: 'AES-GCM' }, false, ['encrypt', 'decrypt']);
}

// Direction-specific so a signature can never be replayed back at its signer,
// and nonce-bound so it cannot be replayed into a later session.
/** @param {{signerEcdh: string, peerEcdh: string, signerNonce: string, peerNonce: string}} parts */
export function transcriptFor({ signerEcdh, peerEcdh, signerNonce, peerNonce }) {
  return [TRANSCRIPT_PREFIX, signerEcdh, peerEcdh, signerNonce, peerNonce].join('|');
}

/** @param {CryptoKey} privateKey @param {string} transcript */
export async function signTranscript(privateKey, transcript) {
  const signature = await crypto.subtle.sign(
    { name: 'ECDSA', hash: 'SHA-256' },
    privateKey,
    encoder.encode(transcript)
  );
  return bytesToBase64(new Uint8Array(signature));
}

/** @param {BufferSource} rawPublicKey @param {string} signatureBase64 @param {string} transcript */
export async function verifyTranscript(rawPublicKey, signatureBase64, transcript) {
  try {
    const key = await crypto.subtle.importKey(
      'raw',
      rawPublicKey,
      { name: 'ECDSA', namedCurve: 'P-256' },
      false,
      ['verify']
    );
    return await crypto.subtle.verify(
      { name: 'ECDSA', hash: 'SHA-256' },
      key,
      base64ToBytes(signatureBase64),
      encoder.encode(transcript)
    );
  } catch {
    return false;
  }
}

// Derived from the two long-lived fingerprints, so unlike an ephemeral-key code
// this stays the same for the life of both devices and is worth comparing once.
/** @param {string} fingerprintA @param {string} fingerprintB */
export async function safetyCode(fingerprintA, fingerprintB) {
  const joined = [fingerprintA, fingerprintB].sort().join('|');
  const digest = new Uint8Array(await crypto.subtle.digest('SHA-256', encoder.encode(joined)));
  const groups = [];
  for (let i = 0; i < 5; i++) {
    groups.push(((digest[i * 2] << 8 | digest[i * 2 + 1]) % 100000).toString().padStart(5, '0'));
  }
  return groups.join(' ');
}

/* ---------- trust-on-first-use store ---------- */

// Held as a Map, never as an object indexed by fingerprint: device IDs come from
// other devices, and one named `__proto__` must not reach an object's prototype
// (which would also make deviceTrust() report a stranger as known).
/** @returns {Map<string, {name: string, firstSeen: number, lastSeen: number, verifiedAt?: number, pairedAt?: number, blocked?: boolean, hidden?: boolean}>} */
function loadKnownDevices() {
  try {
    const parsed = JSON.parse(localStorage.getItem(KNOWN_DEVICES_KEY) || '{}');
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return new Map();
    return new Map(Object.entries(parsed).filter(([, record]) => record && typeof record === 'object'));
  } catch {
    return new Map();
  }
}

/** @param {Map<string, any>} devices */
function saveKnownDevices(devices) {
  try { localStorage.setItem(KNOWN_DEVICES_KEY, JSON.stringify(Object.fromEntries(devices))); } catch {}
}

// A snapshot for listing. Look a single device up with deviceTrust().
export function knownDevices() {
  return [...loadKnownDevices()];
}

/** @param {string} fingerprint */
export function deviceTrust(fingerprint) {
  return loadKnownDevices().get(fingerprint) || null;
}

// First sighting is recorded; later sightings only refresh the name and time.
// Because the ID *is* the key fingerprint, a re-keyed device shows up as a new
// device rather than silently taking over an existing entry.
/** @param {string} fingerprint @param {string} name */
export function rememberDevice(fingerprint, name) {
  const devices = loadKnownDevices();
  const now = Date.now();
  const existing = devices.get(fingerprint);
  const record = {
    ...existing,
    name: name || existing?.name || '',
    firstSeen: existing?.firstSeen || now,
    lastSeen: now
  };
  devices.set(fingerprint, record);
  saveKnownDevices(devices);
  return record;
}

const REVOKED_PAIRINGS_KEY = 'evakage-revoked-pairings';
/** @returns {Set<string>} */
function revokedPairings() {
  try {
    const ids = JSON.parse(localStorage.getItem(REVOKED_PAIRINGS_KEY) || '[]');
    return new Set(Array.isArray(ids) ? ids.filter(id => typeof id === 'string') : []);
  } catch { return new Set(); }
}
/** @param {string} fingerprint */
export function pairingRevoked(fingerprint) { return revokedPairings().has(fingerprint); }
/** @param {string} fingerprint */
export function revokePairing(fingerprint) {
  const ids = revokedPairings();
  ids.add(fingerprint);
  try { localStorage.setItem(REVOKED_PAIRINGS_KEY, JSON.stringify([...ids])); } catch {}
  const devices = loadKnownDevices();
  const record = devices.get(fingerprint);
  if (record) { devices.set(fingerprint, { ...record, pairedAt: undefined, verifiedAt: undefined }); saveKnownDevices(devices); }
}

/** @param {string} fingerprint */
export function forgetDevice(fingerprint) {
  revokePairing(fingerprint);
  const devices = loadKnownDevices();
  devices.delete(fingerprint);
  saveKnownDevices(devices);
}

/** Remember an owner-authorized server-code pairing, independently of TOFU.
 * @param {string} fingerprint @param {string} name */
export function pairDevice(fingerprint, name) {
  const record = rememberDevice(fingerprint, name);
  if (record.blocked) return false;
  const devices = loadKnownDevices();
  devices.set(fingerprint, { ...record, pairedAt: Date.now() });
  const revoked = revokedPairings();
  revoked.delete(fingerprint);
  try { localStorage.setItem(REVOKED_PAIRINGS_KEY, JSON.stringify([...revoked])); } catch {}
  saveKnownDevices(devices);
  return true;
}

/** Locally approve a fingerprint only after comparing its pairwise code.
 * @param {string} fingerprint @param {string} selfId @param {string} comparedCode */
export async function verifyDevice(fingerprint, selfId, comparedCode) {
  const expected = await safetyCode(fingerprint, selfId);
  if (comparedCode.replace(/\s/g, '') !== expected.replace(/\s/g, '')) return false;
  const devices = loadKnownDevices();
  const record = devices.get(fingerprint);
  if (!record || record.blocked) return false;
  devices.set(fingerprint, { ...record, verifiedAt: Date.now() });
  saveKnownDevices(devices);
  return !!deviceTrust(fingerprint)?.verifiedAt;
}

/** @param {string} fingerprint @param {boolean} blocked */
export function blockDevice(fingerprint, blocked) {
  const devices = loadKnownDevices();
  const record = devices.get(fingerprint);
  if (!record) return;
  devices.set(fingerprint, { ...record, blocked, verifiedAt: blocked ? undefined : record.verifiedAt });
  saveKnownDevices(devices);
}

/** Hiding affects the device list only; blocking controls exchanges.
 * @param {string} fingerprint @param {string} name @param {boolean} hidden */
export function hideDevice(fingerprint, name, hidden) {
  rememberDevice(fingerprint, name);
  const devices = loadKnownDevices();
  const record = devices.get(fingerprint);
  if (record) { devices.set(fingerprint, { ...record, hidden }); saveKnownDevices(devices); }
}
