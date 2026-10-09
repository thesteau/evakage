// Shared device cryptography. Browser and Node clients use the same wire format.
const TRANSCRIPT_PREFIX = 'evakage/2';
const SEAL_KEY_CONTEXT = 'evakage/sealkey/1';
const SEAL_INFO = 'evakage/seal/1';
const encoder = new TextEncoder();

export function bytesToBase64(bytes: Uint8Array) {
  let binary = '';
  const step = 0x8000;
  for (let i = 0; i < bytes.length; i += step)
    {binary += String.fromCharCode(...bytes.subarray(i, i + step));}
  return btoa(binary);
}

export function base64ToBytes(value: string) {
  const binary = atob(value);
  const out = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) out[i] = binary.charCodeAt(i);
  return out;
}

const toBase64Url = (bytes: Uint8Array) =>
  bytesToBase64(bytes).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');

// The device ID other browsers see: a base64url SHA-256 of the raw public key.
// It satisfies the server's [A-Za-z0-9_-]{8,128} device-id rule as-is.

export async function fingerprintOf(rawPublicKey: BufferSource) {
  const digest = new Uint8Array(await crypto.subtle.digest('SHA-256', rawPublicKey));
  return toBase64Url(digest);
}

/** * Checks that an advertised identity really belongs to the device id the server
 * routed us to, and that its seal key was signed by that identity. Everything
 * here comes from the signaling server, so none of it is trusted until both
 * checks pass. */
export async function verifyAdvertisedIdentity({
  deviceId,
  identityKey,
  sealKey,
  sealKeySignature,
}: {
  deviceId: string;
  identityKey?: string;
  sealKey?: string;
  sealKeySignature?: string;
}) {
  if (
    typeof identityKey !== 'string' ||
    typeof sealKey !== 'string' ||
    typeof sealKeySignature !== 'string'
  )
    {return null;}
  let identityRaw;
  let sealRaw;
  try {
    identityRaw = base64ToBytes(identityKey);
    sealRaw = base64ToBytes(sealKey);
  } catch {
    return null;
  }
  if ((await fingerprintOf(identityRaw)) !== deviceId) return null;
  const ok = await verifyTranscript(
    identityRaw,
    sealKeySignature,
    `${SEAL_KEY_CONTEXT}|${sealKey}`,
  );
  return ok ? { identityRaw, sealRaw } : null;
}

/* ---------- sealed boxes (ECIES over P-256 + HKDF + AES-GCM) ---------- */

async function sealKeyFrom(sharedBits: BufferSource, salt: BufferSource, info: string) {
  const base = await crypto.subtle.importKey('raw', sharedBits, 'HKDF', false, ['deriveKey']);
  return crypto.subtle.deriveKey(
    { name: 'HKDF', hash: 'SHA-256', salt, info: new TextEncoder().encode(info) },
    base,
    { name: 'AES-GCM', length: 256 },
    false,
    ['encrypt', 'decrypt'],
  );
}

/** * Encrypts to a recipient's long-lived seal key. Unlike the DataChannel's
 * ephemeral exchange this needs no live peer, which is what makes a server-held
 * blob possible without the server being able to read it. */
export async function seal(
  recipientSealRaw: BufferSource,
  plaintext: BufferSource,
  info = SEAL_INFO,
) {
  const ephemeral = await crypto.subtle.generateKey({ name: 'ECDH', namedCurve: 'P-256' }, true, [
    'deriveBits',
  ]);
  const recipient = await crypto.subtle.importKey(
    'raw',
    recipientSealRaw,
    { name: 'ECDH', namedCurve: 'P-256' },
    false,
    [],
  );
  const shared = await crypto.subtle.deriveBits(
    { name: 'ECDH', public: recipient },
    ephemeral.privateKey,
    256,
  );
  const ephemeralRaw = new Uint8Array(await crypto.subtle.exportKey('raw', ephemeral.publicKey));
  // The ephemeral public key is the HKDF salt, so each sealing is distinct.
  const key = await sealKeyFrom(shared, ephemeralRaw, info);
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const ciphertext = new Uint8Array(
    await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, key, plaintext),
  );
  return {
    v: 1,
    ephemeral: bytesToBase64(ephemeralRaw),
    iv: bytesToBase64(iv),
    ciphertext: bytesToBase64(ciphertext),
  };
}

export async function unseal(
  sealPrivateKey: CryptoKey,
  box: import('./types.js').SealedBox,
  info = SEAL_INFO,
) {
  if (!box || box.v !== 1) throw new Error('Unsupported sealed box');
  const ephemeralRaw = base64ToBytes(box.ephemeral);
  const ephemeral = await crypto.subtle.importKey(
    'raw',
    ephemeralRaw,
    { name: 'ECDH', namedCurve: 'P-256' },
    false,
    [],
  );
  const shared = await crypto.subtle.deriveBits(
    { name: 'ECDH', public: ephemeral },
    sealPrivateKey,
    256,
  );
  const key = await sealKeyFrom(shared, ephemeralRaw, info);
  const plain = await crypto.subtle.decrypt(
    { name: 'AES-GCM', iv: base64ToBytes(box.iv) },
    key,
    base64ToBytes(box.ciphertext),
  );
  return new Uint8Array(plain);
}

/** Random AES-256-GCM key used for a single file body. */
export async function generateContentKey() {
  const raw = crypto.getRandomValues(new Uint8Array(32));
  return { raw, key: await importContentKey(raw) };
}

export function importContentKey(raw: BufferSource) {
  return crypto.subtle.importKey('raw', raw, { name: 'AES-GCM' }, false, ['encrypt', 'decrypt']);
}

// Direction-specific so a signature can never be replayed back at its signer,
// and nonce-bound so it cannot be replayed into a later session.

export function transcriptFor({
  signerEcdh,
  peerEcdh,
  signerNonce,
  peerNonce,
}: {
  signerEcdh: string;
  peerEcdh: string;
  signerNonce: string;
  peerNonce: string;
}) {
  return [TRANSCRIPT_PREFIX, signerEcdh, peerEcdh, signerNonce, peerNonce].join('|');
}

export async function signTranscript(privateKey: CryptoKey, transcript: string) {
  const signature = await crypto.subtle.sign(
    { name: 'ECDSA', hash: 'SHA-256' },
    privateKey,
    encoder.encode(transcript),
  );
  return bytesToBase64(new Uint8Array(signature));
}

export async function verifyTranscript(
  rawPublicKey: BufferSource,
  signatureBase64: string,
  transcript: string,
) {
  try {
    const key = await crypto.subtle.importKey(
      'raw',
      rawPublicKey,
      { name: 'ECDSA', namedCurve: 'P-256' },
      false,
      ['verify'],
    );
    return await crypto.subtle.verify(
      { name: 'ECDSA', hash: 'SHA-256' },
      key,
      base64ToBytes(signatureBase64),
      encoder.encode(transcript),
    );
  } catch {
    return false;
  }
}

// Derived from the two long-lived fingerprints, so unlike an ephemeral-key code
// this stays the same for the life of both devices and is worth comparing once.

export async function safetyCode(fingerprintA: string, fingerprintB: string) {
  const joined = [fingerprintA, fingerprintB].sort().join('|');
  const digest = new Uint8Array(await crypto.subtle.digest('SHA-256', encoder.encode(joined)));
  const groups: any[] = [];
  for (let i = 0; i < 5; i++) {
    groups.push((((digest[i * 2] << 8) | digest[i * 2 + 1]) % 100000).toString().padStart(5, '0'));
  }
  return groups.join(' ');
}

