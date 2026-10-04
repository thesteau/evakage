// Portable authorship proofs for live chat and peer-synced history.
// Sign exact, versioned JSON with a separate cryptographic context.
import { signTranscript, verifyTranscript, fingerprintOf, base64ToBytes } from './identity.js';
const CONTEXT = 'aria-drop/message/1';
const DEVICE_ID = /^[A-Za-z0-9_-]{43}$/;
const encoder = new TextEncoder();

/** Namespace replay IDs by author so another signer cannot shadow history.
 * @param {Pick<import('./types.js').Message, 'id' | 'from'>} message */
export function messageKey(message) {
  return JSON.stringify([message.from, message.id]);
}

/** @param {unknown} value @returns {value is import('./types.js').Message} */
function validMessage(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const m = /** @type {import('./types.js').Message} */ (value);
  return typeof m.id === 'string' && m.id.length > 0 && m.id.length <= 64 &&
    typeof m.from === 'string' && DEVICE_ID.test(m.from) &&
    typeof m.fromName === 'string' && m.fromName.length <= 64 &&
    typeof m.text === 'string' && m.text.length <= 20000 &&
    Number.isSafeInteger(m.at) && m.at >= 0;
}

/** Direct scopes must be canonical and contain the signing author.
 * Room signatures bind to a room ID, not a server assertion about membership.
 * @param {string} scope @param {string} author */
function validScope(scope, author) {
  if (typeof scope !== 'string') return false;
  if (/^room:[A-Za-z0-9_-]{1,128}$/.test(scope)) return true;
  try {
    const pair = JSON.parse(scope);
    return Array.isArray(pair) && pair[0] === 'direct' &&
      pair.length >= 2 && pair.length <= 3 &&
      pair.slice(1).every(id => typeof id === 'string' && DEVICE_ID.test(id)) &&
      pair.slice(1).includes(author) &&
      scope === JSON.stringify(['direct', ...[...new Set(pair.slice(1))].sort()]);
  } catch { return false; }
}

/** @param {string} scope @param {string[]} participants */
export function messageScope(scope, participants) {
  return scope.startsWith('room:') ? scope : JSON.stringify(['direct', ...[...new Set(participants)].sort()]);
}

/** @param {string} scope @param {import('./types.js').Message} message */
function signedBody(scope, message) {
  return JSON.stringify({ v: 1, scope, id: message.id, from: message.from,
    fromName: message.fromName, at: message.at, text: message.text });
}

/** @param {Pick<import('./types.js').Identity, 'privateKey' | 'identityKey' | 'deviceId'>} identity
 * @param {string} scope @param {import('./types.js').Message} message */
export async function signMessage(identity, scope, message) {
  if (!validMessage(message) || message.from !== identity.deviceId || !validScope(scope, message.from)) {
    throw new Error('Invalid message author or conversation');
  }
  const inner = signedBody(scope, message);
  return { ...message, proof: { inner, identityKey: identity.identityKey,
    signature: await signTranscript(identity.privateKey, JSON.stringify([CONTEXT, inner])) } };
}

/** Reject missing/legacy proofs, altered fields, foreign conversations and keys.
 * Return only signed fields; peer-supplied verification flags are discarded.
 * @param {unknown} value @param {string} scope @returns {Promise<import('./types.js').Message | null>} */
export async function verifyMessage(value, scope) {
  if (!validMessage(value) || !validScope(scope, value.from)) return null;
  const proof = value.proof;
  if (!proof || typeof proof.inner !== 'string' || proof.inner.length > 130000 ||
      typeof proof.identityKey !== 'string' || proof.identityKey.length !== 88 ||
      typeof proof.signature !== 'string' || proof.signature.length !== 88) return null;
  // Snapshot inputs before asynchronous crypto; never return unsigned extra fields.
  const snapshot = { id: value.id, from: value.from, fromName: value.fromName,
    at: value.at, text: value.text };
  const checkedProof = { inner: proof.inner, identityKey: proof.identityKey, signature: proof.signature };
  if (checkedProof.inner !== signedBody(scope, snapshot)) return null;
  try {
    const raw = base64ToBytes(checkedProof.identityKey);
    if (raw.length !== 65 || base64ToBytes(checkedProof.signature).length !== 64 ||
        await fingerprintOf(raw) !== snapshot.from ||
        !await verifyTranscript(raw, checkedProof.signature, JSON.stringify([CONTEXT, checkedProof.inner]))) return null;
    return { ...snapshot, proof: checkedProof, verifiedAuthor: true, relayedBy: null };
  } catch { return null; }
}

/** Keep signed history within both the parser limit and the channel budget.
 * A small message count per frame also bounds each verification batch.
 * @param {string} conv @param {import('./types.js').Message[]} messages
 * @param {import('./types.js').FileMeta[]} files @param {number} maxFrameBytes */
export function* historyFrames(conv, messages, files, maxFrameBytes) {
  const empty = () => ({ conv, type: 'sync-state', messages: /** @type {import('./types.js').Message[]} */ ([]),
    files: /** @type {import('./types.js').FileMeta[]} */ ([]) });
  let frame = empty();
  for (const [kind, items] of /** @type {const} */ ([['messages', messages], ['files', files]])) {
    for (const item of items) {
      const candidate = { ...frame, [kind]: [...frame[kind], item] };
      if (frame.messages.length + frame.files.length >= 16 ||
          encoder.encode(JSON.stringify(candidate)).length + 1 > maxFrameBytes) {
        if (frame.messages.length || frame.files.length) yield frame;
        frame = empty();
      }
      if (kind === 'messages') frame.messages.push(/** @type {import('./types.js').Message} */ (item));
      else frame.files.push(/** @type {import('./types.js').FileMeta} */ (item));
      if (encoder.encode(JSON.stringify(frame)).length + 1 > maxFrameBytes) throw new Error('History item exceeds channel limit');
    }
  }
  if (frame.messages.length || frame.files.length || (!messages.length && !files.length)) yield frame;
}
