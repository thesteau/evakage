import { hashBlob, hashChunks } from './sha256.js';
import {
  loadIdentity,
  fingerprintOf,
  transcriptFor,
  signTranscript,
  verifyTranscript,
  safetyCode,
  deviceTrust,
  rememberDevice,
  knownDevices,
  forgetDevice,
  verifyAdvertisedIdentity,
  bytesToBase64,
  base64ToBytes
} from './identity.js';
import {
  buildEnvelope,
  openEnvelope,
  buildMessageEnvelope,
  openMessageEnvelope,
  generateContentKey,
  encryptBody,
  createBodyDecryptor,
  cipherLayout
} from './relay.js';

const $ = (sel) => document.querySelector(sel);
const peerRows = $('#peerRows');
const emptyPeers = $('#emptyPeers');
const roomRows = $('#roomRows');
const emptyRooms = $('#emptyRooms');
const serverState = $('#serverState');
const sessionPanel = $('#sessionPanel');
const sessionTitle = $('#sessionTitle');
const sessionMeta = $('#sessionMeta');
const sessionKind = $('#sessionKind');
const sessionMembers = $('#sessionMembers');
const leaveRoomBtn = $('#leaveRoomBtn');
const secureState = $('#secureState');
const timeline = $('#timeline');
const messageForm = $('#messageForm');
const messageInput = $('#messageInput');
const fileInput = $('#fileInput');
const pickFileBtn = $('#pickFileBtn');
const selfCode = $('#selfCode');
const toastRegion = $('#toastRegion');
const codeFeedback = $('#codeFeedback');
const roomFeedback = $('#roomFeedback');
const renameDialog = $('#renameDialog');
const renameInput = $('#renameInput');
const devicesDialog = $('#devicesDialog');
const knownDeviceList = $('#knownDeviceList');
const pickTargetDialog = $('#pickTargetDialog');
const pickTargetList = $('#pickTargetList');
const pickTargetTitle = $('#pickTargetTitle');
const pickTargetHint = $('#pickTargetHint');
const themeBtn = $('#themeBtn');
const themeIcon = $('#themeIcon');

const state = {
  ws: null,
  wsBackoff: 500,
  self: null,
  identity: null,            // long-lived device keypair + fingerprint
  peers: new Map(),          // deviceId -> online peer record from the server
  links: new Map(),          // deviceId -> pairwise transport + crypto
  conversations: new Map(),  // convId -> in-memory chat/file state
  rooms: new Map(),          // roomId -> server room record
  joinedRoomIds: new Set(),  // rooms this browser is a member of
  activeConvId: null,
  activeSends: new Map(),    // transferId -> { cancelled, fileId, name }
  config: { iceServers: [], maxFileBytes: 512 * 1024 * 1024, maxRoomMembers: 20, roomMeshMax: 6 },
  pendingCodeRequests: new Map(),
  statsTimer: null,
  wakeLockTimer: null,
  theme: 'system',
  panelReturnFocus: null,
  panelReturnKey: null,
  forceRelay: false,
  // Whether an incoming file needs a yes first: 'auto', 'new' (first contact
  // with a device), or 'always'. Accepting once trusts that device for the
  // rest of the session.
  incomingPolicy: 'new',
  consentedDevices: new Set(),
  // Last known record for every device we know of, online or not: presence,
  // room away lists, and server lookups all feed it. Offline devices seen in the
  // last 24h can still be sent to through the relay.
  deviceRecords: new Map(),    // deviceId -> { ...record, online, lastSeen }
  pendingRequests: new Map(),  // requestId / blobId -> { resolve, reject, timer }
  relayInbound: new Set(),     // blob ids already being fetched, so a repeat notice is ignored
  sealKeyCache: new Map()      // advertised identity -> verified seal key bytes (or null)
};

// How long to wait for a direct link before handing a file to the relay. Short,
// because on a network where ICE never succeeds this is pure dead time.
const P2P_WAIT_WITH_RELAY_MS = 5000;
// Chat is interactive, so it waits even less for a link that is still coming up.
const CHAT_P2P_WAIT_MS = 2500;
// Once a direct link has failed to come up for a message, the following ones to
// that device go straight to the relay for this long rather than each paying
// the wait again. The link keeps retrying in the background meanwhile.
const RELAY_STICKY_MS = 30000;
// The signaling server refuses WebSocket frames above 256 KiB.
const MAX_RELAY_FRAME_CHARS = 250 * 1024;
// Matches the relay's maximum age: a device last seen longer ago than this can
// no longer be sent to, because anything left for it would age out first.
const RECENT_WINDOW_MS = 24 * 60 * 60 * 1000;

function recordDevice(record, online) {
  if (!record?.id || record.id === state.self?.id) return;
  const previous = state.deviceRecords.get(record.id);
  state.deviceRecords.set(record.id, {
    ...previous,
    ...record,
    online,
    lastSeen: online ? Date.now() : (record.lastSeen || previous?.lastSeen || Date.now())
  });
}

/** A device that is offline but was seen recently enough to still be sent to. */
function isRecentlySeen(deviceId) {
  const record = state.deviceRecords.get(deviceId);
  return Boolean(record) && !state.peers.has(deviceId) && record.lastSeen >= Date.now() - RECENT_WINDOW_MS;
}

// Asks the server for the signed records of devices we know about. The records
// are verified client-side before anything is sealed to them, exactly as a
// live one would be, so the server cannot substitute a key.
function lookupDevices(deviceIds) {
  const ids = [...new Set(deviceIds)].filter(id => id && id !== state.self?.id).slice(0, 200);
  if (!ids.length || !relayEnabled()) return Promise.resolve([]);
  const requestId = crypto.randomUUID();
  return awaitReply(`lookup:${requestId}`, () => wsSend({ type: 'lookup-devices', requestId, deviceIds: ids }), 8000)
    .then(reply => {
      for (const device of reply.devices || []) recordDevice(device, Boolean(device.online) && state.peers.has(device.id));
      renderPeers();
      return reply.devices || [];
    })
    .catch(() => []);
}

function formatAgo(timestamp) {
  const seconds = Math.max(0, Math.round((Date.now() - timestamp) / 1000));
  if (seconds < 60) return 'just now';
  const minutes = Math.round(seconds / 60);
  if (minutes < 60) return `${minutes}m ago`;
  return `${Math.round(minutes / 60)}h ago`;
}

const encoder = new TextEncoder();
const decoder = new TextDecoder();
const CONTROL_KIND = 1;
const FILE_CHUNK_KIND = 2;
const CHUNK_SIZE = 64 * 1024;
const HIGH_WATER = 8 * 1024 * 1024;
const LOW_WATER = 3 * 1024 * 1024;

// Peer application protocol. Bump PROTOCOL_VERSION for any wire change; widen
// [MIN_PROTOCOL, PROTOCOL_VERSION] only for versions this build can actually
// speak. A peer outside that window is refused with an explanation instead of
// being left to fail somewhere deeper in the exchange.
// v2 added signed long-lived device identities, so a v1 peer cannot prove who it
// is and is refused rather than silently downgraded.
const PROTOCOL_VERSION = 2;
const MIN_PROTOCOL = 2;

// Defensive caps. A cooperating peer stays well under all of them; they bound
// what a hostile or broken one can make this tab allocate.
const CAPS = {
  messagesPerConversation: 2000,
  filesPerConversation: 200,
  syncMessages: 2000,
  syncFiles: 200,
  messageChars: 20000,
  controlBytes: 512 * 1024,
  chunkBytes: 128 * 1024,
  fileChunks: 1_000_000,
  queuedIceCandidates: 64,
  concurrentSends: 4,
  concurrentNegotiations: 3,
  reconnectAttempts: 8
};

function deviceName() {
  let name = localStorage.getItem('aria-drop-device-name');
  if (!name) {
    name = `${detectPlatform()} browser`;
    localStorage.setItem('aria-drop-device-name', name);
  }
  return name;
}

function detectPlatform() {
  const ua = navigator.userAgent;
  if (/iPhone|iPad|iPod/i.test(ua)) return 'iOS';
  if (/Android/i.test(ua)) return 'Android';
  if (/Windows/i.test(ua)) return 'Windows';
  if (/Macintosh|Mac OS X/i.test(ua)) return 'macOS';
  if (/Linux/i.test(ua)) return 'Linux';
  return 'Browser';
}

function detectBrowser() {
  const ua = navigator.userAgent;
  if (/Edg\//.test(ua)) return 'Edge';
  if (/Firefox\//.test(ua)) return 'Firefox';
  if (/CriOS|Chrome\//.test(ua)) return 'Chrome';
  if (/Safari\//.test(ua)) return 'Safari';
  return 'Browser';
}

function wsSend(payload) {
  if (state.ws?.readyState === WebSocket.OPEN) state.ws.send(JSON.stringify(payload));
}

function signal(to, data) {
  wsSend({ type: 'signal', to, data });
}

function connectWebSocket() {
  const protocol = location.protocol === 'https:' ? 'wss:' : 'ws:';
  const ws = new WebSocket(`${protocol}//${location.host}`);
  state.ws = ws;
  serverState.textContent = 'Connecting…';
  serverState.classList.remove('online');

  ws.addEventListener('open', () => {
    state.wsBackoff = 500;
    wsSend({
      type: 'register',
      deviceId: state.identity.deviceId,
      name: deviceName(),
      platform: detectPlatform(),
      browser: detectBrowser(),
      // Published so others can seal a relayed file to this device. The server
      // passes these through untouched; receivers verify them, not the server.
      identityKey: state.identity.identityKey,
      sealKey: state.identity.sealKey,
      sealKeySignature: state.identity.sealKeySignature
    });
    serverState.textContent = 'Signaling connected';
    serverState.classList.add('online');
  });

  ws.addEventListener('message', async (event) => {
    let msg;
    try { msg = JSON.parse(event.data); } catch { return; }

    if (msg.type === 'registered') {
      state.self = msg.self;
      selfCode.textContent = msg.self.code;
      document.title = `${msg.self.name} · aria-drop`;
      renderPeers();
      rejoinRooms();
      // Recover records for devices we have talked to, so ones that are offline
      // right now can still be listed and sent to.
      lookupDevices([...knownDevices().map(([id]) => id), ...state.deviceRecords.keys()]);
      return;
    }

    if (msg.type === 'devices-found') {
      settleRequest(`lookup:${msg.requestId}`, msg);
      return;
    }

    if (msg.type === 'presence') {
      const previousOnline = new Set(state.peers.keys());
      state.peers = new Map(msg.peers.filter(p => p.id !== state.self?.id).map(p => [p.id, p]));
      for (const peer of state.peers.values()) recordDevice(peer, true);
      // Anyone who just dropped off stays addressable through the relay.
      for (const id of previousOnline) {
        if (!state.peers.has(id) && state.deviceRecords.has(id)) {
          recordDevice({ ...state.deviceRecords.get(id), lastSeen: Date.now() }, false);
        }
      }
      renderPeers();
      renderRooms();
      reconcileLinks(previousOnline);
      renderSession();
      return;
    }

    if (msg.type === 'rooms') {
      state.rooms = new Map(msg.rooms.map(room => [room.id, room]));
      for (const room of state.rooms.values()) {
        for (const member of room.away || []) {
          if (!state.peers.has(member.id)) recordDevice(member, false);
        }
      }
      for (const roomId of [...state.joinedRoomIds]) {
        const room = state.rooms.get(roomId);
        // Right after a reconnect the server lists this device as away until
        // its rejoin lands. That still counts as being in the room; treating it
        // as a leave would drop room messages that arrive in that gap.
        const self = state.self?.id;
        const stillSeated = room && (room.members.some(m => m.id === self) || (room.away || []).some(m => m.id === self));
        if (room && !stillSeated) state.joinedRoomIds.delete(roomId);
      }
      renderRooms();
      for (const roomId of state.joinedRoomIds) {
        const conv = state.conversations.get(roomConvId(roomId));
        if (conv) ensureConversationLinks(conv);
      }
      // A room that just grew past the mesh size no longer needs the direct
      // links it opened while small; close any nothing else is using.
      releaseIdleLinks();
      renderSession();
      return;
    }

    if (msg.type === 'room-joined') {
      state.rooms.set(msg.room.id, msg.room);
      state.joinedRoomIds.add(msg.room.id);
      const conv = ensureConversation(roomConvId(msg.room.id), 'room', msg.room.id);
      conv.lastKnownName = msg.room.name;
      conv.lastKnownCode = msg.room.code;
      roomFeedback.textContent = `Joined ${msg.room.name} · ${msg.room.code}`;
      renderRooms();
      ensureConversationLinks(conv);
      renderSession();
      // Anything left for this device in the room while it was away, including
      // items set aside because they arrived before this rejoin landed.
      wsSend({ type: 'blobs-request' });
      requestRoomHistory(msg.room.id);
      return;
    }

    if (msg.type === 'room-left') {
      state.joinedRoomIds.delete(msg.roomId);
      forgetConversation(roomConvId(msg.roomId));
      renderRooms();
      return;
    }

    if (msg.type === 'resolved-code') {
      const pending = state.pendingCodeRequests.get(msg.requestId);
      if (typeof pending === 'function') {
        state.pendingCodeRequests.delete(msg.requestId);
        pending(msg.peer);
      }
      return;
    }

    if (msg.type === 'signal') {
      await handleSignal(msg.from, msg.data);
      return;
    }

    if (msg.type === 'blob-offered') {
      settleRequest(msg.requestId, msg);
      return;
    }

    if (msg.type === 'blob-claimed') {
      settleRequest(`claim:${msg.blobId}`, msg);
      return;
    }

    if (msg.type === 'blob-available') {
      handleBlobAvailable(msg);
      return;
    }

    if (msg.type === 'error') {
      // Relay errors belong to a specific pending request; hand them to it
      // rather than toasting, so the caller can decide what to tell the user.
      if (msg.context === 'blob-offer' && msg.requestId && state.pendingRequests.has(msg.requestId)) {
        settleRequest(msg.requestId, null, new Error(msg.message));
        return;
      }
      if (msg.context === 'blob-claim' && msg.blobId && state.pendingRequests.has(`claim:${msg.blobId}`)) {
        settleRequest(`claim:${msg.blobId}`, null, new Error(msg.message));
        return;
      }
      if (msg.context === 'join-room' || msg.context === 'create-room') roomFeedback.textContent = msg.message;
      toast(msg.message || 'Server error');
    }
  });

  ws.addEventListener('close', () => {
    serverState.textContent = 'Signaling disconnected';
    serverState.classList.remove('online');
    state.peers.clear();
    state.rooms.clear();
    renderPeers();
    renderRooms();
    setTimeout(connectWebSocket, state.wsBackoff);
    state.wsBackoff = Math.min(state.wsBackoff * 1.8, 10000);
  });

  ws.addEventListener('error', () => ws.close());
}

// A signaling blip must not destroy a room this browser still holds state for,
// so rejoin asks the server to restore the same room id/code if it dropped it.
function rejoinRooms() {
  for (const roomId of state.joinedRoomIds) {
    const conv = state.conversations.get(roomConvId(roomId));
    wsSend({
      type: 'join-room',
      roomId,
      recreate: true,
      name: conv?.lastKnownName,
      code: conv?.lastKnownCode
    });
  }
}

/* ---------- conversations ---------- */

const directConvId = (peerId) => `d:${peerId}`;
const roomConvId = (roomId) => `r:${roomId}`;

function ensureConversation(convId, kind, ref) {
  const existing = state.conversations.get(convId);
  if (existing) return existing;
  const conv = {
    id: convId,
    kind,
    peerId: kind === 'direct' ? ref : null,
    roomId: kind === 'room' ? ref : null,
    lastKnownName: null,
    lastKnownCode: null,
    messages: new Map(),
    files: new Map()
  };
  state.conversations.set(convId, conv);
  return conv;
}

function forgetConversation(convId) {
  state.conversations.delete(convId);
  if (state.activeConvId === convId) closeSessionPanel();
  releaseIdleLinks();
}

// Wire-level scope. "direct" is resolved relative to the sender, so each side
// maps it onto its own conversation id for the other device.
function convScope(conv) {
  return conv.kind === 'room' ? `room:${conv.roomId}` : 'direct';
}

function resolveScope(scope, fromPeerId) {
  if (!scope || scope === 'direct') return ensureConversation(directConvId(fromPeerId), 'direct', fromPeerId);
  if (!scope.startsWith('room:')) return null;
  const roomId = scope.slice(5);
  // Only accept room traffic for rooms this browser actually joined.
  if (!state.joinedRoomIds.has(roomId)) return null;
  return state.conversations.get(roomConvId(roomId)) || null;
}

// Everyone party to a conversation, including room members who are away: they
// keep their seat and are still sent to, through the relay.
function conversationMembers(conv) {
  if (conv.kind === 'direct') return [conv.peerId];
  const room = state.rooms.get(conv.roomId);
  if (!room) return [];
  return [...room.members, ...(room.away || [])].map(m => m.id).filter(id => id !== state.self?.id);
}

function onlineMembers(conv) {
  return conversationMembers(conv).filter(id => state.peers.has(id));
}

/** Members who are offline but recent enough that a relayed item can wait for them. */
function relayOnlyMembers(conv) {
  if (!relayEnabled()) return [];
  return conversationMembers(conv).filter(isRecentlySeen);
}

function conversationTitle(conv) {
  if (conv.kind === 'room') return state.rooms.get(conv.roomId)?.name || conv.lastKnownName || 'Room';
  return getPeer(conv.peerId).name;
}

// Falls back to the name remembered for a known device, so a relayed message
// from a device that has since gone offline still shows who sent it.
function displayName(deviceId) {
  if (deviceId === state.self?.id) return state.self.name;
  return state.peers.get(deviceId)?.name
    || state.deviceRecords.get(deviceId)?.name
    || deviceTrust(deviceId)?.name
    || 'Offline device';
}

/* ---------- links ---------- */

function createLink(peerId) {
  const existing = state.links.get(peerId);
  if (existing) return existing;
  const link = {
    peerId,
    pc: null,
    dc: null,
    candidateQueue: [],
    crypto: { keyPair: null, ownPublic: null, remotePublic: null, key: null, safety: null },
    status: 'idle',
    protocol: null,
    incompatible: false,
    rttMs: null,
    bytesSent: 0,
    bytesReceived: 0,
    sendRate: 0,
    receiveRate: 0,
    statsAt: 0,
    path: null,
    pathDetail: null,
    reconnectTimer: null,
    queueTimer: null,
    reconnectAttempts: 0,
    gaveUp: false,
    trust: null
  };
  state.links.set(peerId, link);
  return link;
}

// A derived key is not enough: the peer must also have proved ownership of the
// device key its ID is derived from, or the link stays unusable.
function isSecure(link) {
  return Boolean(link?.crypto.key && link.crypto.identityVerified && link.dc?.readyState === 'open');
}

// Every open conversation decides which pairwise links stay alive. One link can
// carry a direct session and several rooms at once.
function neededPeerIds() {
  const needed = new Set();
  for (const conv of state.conversations.values()) {
    // A large room runs entirely through the relay, so it needs no links.
    if (isRelayRoom(conv)) continue;
    for (const id of onlineMembers(conv)) needed.add(id);
  }
  return needed;
}

// Rooms past the mesh size are relay-only: the server says which when it lists
// the room, so every member makes the same choice.
function isRelayRoom(conv) {
  return conv.kind === 'room' && state.rooms.get(conv.roomId)?.transport === 'relay';
}

function releaseIdleLinks() {
  const needed = neededPeerIds();
  for (const [peerId, link] of state.links) {
    if (needed.has(peerId)) continue;
    clearTimeout(link.reconnectTimer);
    clearTimeout(link.queueTimer);
    try { link.dc?.close(); } catch {}
    try { link.pc?.close(); } catch {}
    state.links.delete(peerId);
  }
}

function reconcileLinks(previousOnline) {
  for (const peerId of neededPeerIds()) {
    const link = state.links.get(peerId);
    // A device that just came back online earns a fresh retry budget.
    if (!previousOnline.has(peerId)) {
      retryLink(peerId);
      continue;
    }
    if (link?.incompatible || link?.gaveUp) continue;
    if (!link?.pc || ['closed', 'failed', 'disconnected'].includes(link.pc.connectionState)) ensureLink(peerId);
  }
  releaseIdleLinks();
}

function ensureConversationLinks(conv) {
  if (isRelayRoom(conv)) return;
  for (const peerId of onlineMembers(conv)) ensureLink(peerId);
}

function attachPeerConnection(link) {
  const peerId = link.peerId;
  const pc = link.pc;
  pc.onicecandidate = (event) => {
    if (event.candidate) signal(peerId, { type: 'ice', candidate: event.candidate });
  };
  pc.onconnectionstatechange = () => {
    if (link.incompatible) return;
    link.status = pc.connectionState;
    // A connection that actually came up clears the retry budget.
    if (pc.connectionState === 'connected') {
      link.reconnectAttempts = 0;
      link.gaveUp = false;
    }
    renderPeers();
    renderRooms();
    renderSession();
    if (['failed', 'disconnected'].includes(pc.connectionState)) scheduleReconnect(peerId);
  };
  pc.ondatachannel = (event) => setupDataChannel(link, event.channel);
}

// Joining a full room otherwise starts five negotiations at once, each with its
// own ICE gathering and key exchange. Admit a few at a time and let the rest wait.
function negotiatingCount() {
  let count = 0;
  for (const link of state.links.values()) {
    if (link.pc && ['new', 'connecting'].includes(link.pc.connectionState) && !link.crypto.identityVerified) count++;
  }
  return count;
}

async function ensureLink(peerId, force = false) {
  if (!state.self || !state.peers.has(peerId)) return;
  const link = createLink(peerId);
  if (!force && (link.incompatible || link.gaveUp)) return;
  if (!force && link.pc && ['new', 'connecting', 'connected'].includes(link.pc.connectionState)) return;

  if (negotiatingCount() >= CAPS.concurrentNegotiations) {
    if (!link.queueTimer) {
      link.status = 'queued';
      link.queueTimer = setTimeout(() => {
        link.queueTimer = null;
        if (state.peers.has(peerId) && neededPeerIds().has(peerId)) ensureLink(peerId, force);
      }, 400);
      renderPeers();
      renderRooms();
    }
    return;
  }

  if (link.pc) {
    try { link.pc.close(); } catch {}
  }
  link.pc = new RTCPeerConnection({ iceServers: state.config.iceServers || [] });
  link.status = 'connecting';
  link.candidateQueue = [];
  resetCrypto(link);
  attachPeerConnection(link);
  renderPeers();
  renderSession();

  // Lexicographically smaller id offers; the other side knocks to ask for one.
  const initiator = state.self.id.localeCompare(peerId) < 0;
  if (initiator) {
    const dc = link.pc.createDataChannel('aria-drop-v1', { ordered: true });
    setupDataChannel(link, dc);
    const offer = await link.pc.createOffer();
    await link.pc.setLocalDescription(offer);
    signal(peerId, { type: 'offer', sdp: link.pc.localDescription });
  } else {
    signal(peerId, { type: 'knock' });
  }
}

// Bounded retry: exponential backoff with jitter, then stop and offer a manual
// retry instead of reconnecting forever against a peer that will not answer.
function scheduleReconnect(peerId) {
  const link = state.links.get(peerId);
  if (!link || link.reconnectTimer || link.incompatible || link.gaveUp) return;
  if (link.reconnectAttempts >= CAPS.reconnectAttempts) {
    link.gaveUp = true;
    link.status = 'unreachable';
    renderPeers();
    renderRooms();
    renderSession();
    return;
  }
  const attempt = link.reconnectAttempts++;
  const delay = Math.min(1300 * Math.pow(1.7, attempt), 20000) * (0.8 + Math.random() * 0.4);
  link.reconnectTimer = setTimeout(() => {
    link.reconnectTimer = null;
    if (state.peers.has(peerId) && neededPeerIds().has(peerId)) ensureLink(peerId);
  }, delay);
}

function retryLink(peerId) {
  const link = createLink(peerId);
  clearTimeout(link.reconnectTimer);
  link.reconnectTimer = null;
  link.reconnectAttempts = 0;
  link.gaveUp = false;
  link.incompatible = false;
  ensureLink(peerId, true);
}

async function handleSignal(peerId, data) {
  if (!data || typeof data !== 'object') return;
  const known = state.links.get(peerId);
  if (known?.incompatible) return;
  if (data.type === 'knock') {
    await ensureLink(peerId);
    return;
  }

  const link = createLink(peerId);
  if (!link.pc || link.pc.connectionState === 'closed') {
    link.pc = new RTCPeerConnection({ iceServers: state.config.iceServers || [] });
    link.status = 'connecting';
    link.candidateQueue = [];
    resetCrypto(link);
    attachPeerConnection(link);
  }

  const pc = link.pc;
  if (data.type === 'offer') {
    await pc.setRemoteDescription(data.sdp);
    for (const candidate of link.candidateQueue.splice(0)) await pc.addIceCandidate(candidate).catch(() => {});
    const answer = await pc.createAnswer();
    await pc.setLocalDescription(answer);
    signal(peerId, { type: 'answer', sdp: pc.localDescription });
  } else if (data.type === 'answer') {
    // An answer to an offer this link has since abandoned (a reset crossed it in
    // flight) would throw "wrong state: stable". The live negotiation continues.
    if (pc.signalingState !== 'have-local-offer') return;
    await pc.setRemoteDescription(data.sdp);
    for (const candidate of link.candidateQueue.splice(0)) await pc.addIceCandidate(candidate).catch(() => {});
  } else if (data.type === 'ice' && data.candidate) {
    if (pc.remoteDescription) await pc.addIceCandidate(data.candidate).catch(() => {});
    // Bounded queue: a peer that floods candidates before answering cannot make
    // this tab buffer them without limit.
    else if (link.candidateQueue.length < CAPS.queuedIceCandidates) link.candidateQueue.push(data.candidate);
  }
}

/* ---------- per-link crypto ---------- */

function resetCrypto(link) {
  link.crypto = {
    keyPair: null,
    ownPublic: null,
    ownNonce: null,
    remotePublic: null,
    remoteNonce: null,
    remoteIdentity: null,
    key: null,
    safety: null,
    identityVerified: false,
    proofSent: false
  };
  link.trust = null;
}

function setupDataChannel(link, dc) {
  link.dc = dc;
  dc.binaryType = 'arraybuffer';
  dc.bufferedAmountLowThreshold = LOW_WATER;
  dc.onopen = () => startCryptoHandshake(link);
  dc.onclose = () => {
    renderSession();
    renderPeers();
    renderRooms();
  };
  dc.onerror = () => toast(`Data channel error with ${displayName(link.peerId)}`);
  dc.onmessage = (event) => handleDataMessage(link, event.data);
}

async function startCryptoHandshake(link) {
  if (link.incompatible || link.crypto.helloSent) return;
  if (!link.crypto.keyPair) {
    link.crypto.keyPair = await crypto.subtle.generateKey({ name: 'ECDH', namedCurve: 'P-256' }, true, ['deriveKey']);
    const raw = new Uint8Array(await crypto.subtle.exportKey('raw', link.crypto.keyPair.publicKey));
    link.crypto.ownPublic = bytesToBase64(raw);
    link.crypto.ownNonce = bytesToBase64(crypto.getRandomValues(new Uint8Array(16)));
  }
  link.crypto.helloSent = true;
  link.dc.send(JSON.stringify({
    kind: 'crypto-hello',
    publicKey: link.crypto.ownPublic,
    identityKey: state.identity.identityKey,
    nonce: link.crypto.ownNonce,
    protocol: PROTOCOL_VERSION,
    min: MIN_PROTOCOL,
    max: PROTOCOL_VERSION
  }));
  renderSession();
}

function abortLink(link, message) {
  link.incompatible = true;
  link.status = 'untrusted';
  try { link.dc?.close(); } catch {}
  try { link.pc?.close(); } catch {}
  toast(message);
  renderPeers();
  renderRooms();
  renderSession();
}

// Refuse a peer whose supported range does not overlap ours, and say so, rather
// than deriving a key and failing later on a frame we cannot parse.
function negotiateProtocol(link, hello) {
  const theirMin = Number.isInteger(hello.min) ? hello.min : Number(hello.protocol) || 0;
  const theirMax = Number.isInteger(hello.max) ? hello.max : Number(hello.protocol) || 0;
  const agreed = Math.min(PROTOCOL_VERSION, theirMax);
  if (!theirMax || theirMax < MIN_PROTOCOL || theirMin > PROTOCOL_VERSION) {
    link.incompatible = true;
    link.status = 'incompatible';
    link.protocol = null;
    const who = displayName(link.peerId);
    toast(theirMax
      ? `${who} speaks aria-drop protocol ${theirMin}–${theirMax}; this build speaks ${MIN_PROTOCOL}–${PROTOCOL_VERSION}.`
      : `${who} is running an older aria-drop that cannot negotiate a protocol version. Both sides need a reload.`);
    try { link.dc?.close(); } catch {}
    try { link.pc?.close(); } catch {}
    renderPeers();
    renderRooms();
    renderSession();
    return false;
  }
  link.protocol = agreed;
  return true;
}

async function handleCryptoHello(link, hello) {
  if (link.incompatible) return;
  if (!negotiateProtocol(link, hello)) return;
  if (typeof hello.identityKey !== 'string' || hello.identityKey.length > 256) return;
  if (typeof hello.nonce !== 'string' || hello.nonce.length > 64) return;
  if (link.crypto.remotePublic === hello.publicKey && link.crypto.key) return;

  // The peer's device ID is the fingerprint of its identity key. If the key the
  // peer presents does not hash to the ID the server routed us to, the server is
  // misrepresenting who this is — refuse before deriving anything.
  const remoteIdentityRaw = base64ToBytes(hello.identityKey);
  const fingerprint = await fingerprintOf(remoteIdentityRaw);
  if (fingerprint !== link.peerId) {
    abortLink(link, `${displayName(link.peerId)} presented an identity key that does not match its device ID. Refused.`);
    return;
  }

  if (!link.crypto.keyPair) await startCryptoHandshake(link);

  const remoteKey = await crypto.subtle.importKey(
    'raw', base64ToBytes(hello.publicKey), { name: 'ECDH', namedCurve: 'P-256' }, false, []
  );
  link.crypto.remotePublic = hello.publicKey;
  link.crypto.remoteNonce = hello.nonce;
  link.crypto.remoteIdentity = remoteIdentityRaw;
  link.crypto.key = await crypto.subtle.deriveKey(
    { name: 'ECDH', public: remoteKey },
    link.crypto.keyPair.privateKey,
    { name: 'AES-GCM', length: 256 },
    false,
    ['encrypt', 'decrypt']
  );
  // Derived from the long-lived fingerprints, so it is stable across sessions.
  link.crypto.safety = await safetyCode(state.identity.fingerprint, fingerprint);

  await sendProof(link);
  renderSession();
}

async function sendProof(link) {
  if (link.crypto.proofSent || !link.crypto.remoteNonce) return;
  link.crypto.proofSent = true;
  const signature = await signTranscript(state.identity.privateKey, transcriptFor({
    signerEcdh: link.crypto.ownPublic,
    peerEcdh: link.crypto.remotePublic,
    signerNonce: link.crypto.ownNonce,
    peerNonce: link.crypto.remoteNonce
  }));
  link.dc.send(JSON.stringify({ kind: 'crypto-proof', signature }));
}

async function handleCryptoProof(link, message) {
  if (link.incompatible || link.crypto.identityVerified) return;
  if (!link.crypto.key || !link.crypto.remoteIdentity) return;
  if (typeof message.signature !== 'string' || message.signature.length > 256) return;

  // Swap the roles: the peer signed its own ephemeral key and nonce first.
  const ok = await verifyTranscript(link.crypto.remoteIdentity, message.signature, transcriptFor({
    signerEcdh: link.crypto.remotePublic,
    peerEcdh: link.crypto.ownPublic,
    signerNonce: link.crypto.remoteNonce,
    peerNonce: link.crypto.ownNonce
  }));
  if (!ok) {
    abortLink(link, `${displayName(link.peerId)} failed to prove ownership of its device key. Refused.`);
    return;
  }

  link.crypto.identityVerified = true;
  const previous = deviceTrust(link.peerId);
  link.trust = {
    known: Boolean(previous),
    firstSeen: previous?.firstSeen || Date.now(),
    previousName: previous?.name || ''
  };
  rememberDevice(link.peerId, displayName(link.peerId));

  renderSession();
  renderPeers();
  renderRooms();
  await syncEverythingWith(link);
}

/* ---------- framing ---------- */

async function waitForWritable(dc) {
  if (dc.readyState !== 'open') throw new Error('Data channel is not open');
  if (dc.bufferedAmount <= HIGH_WATER) return;
  await new Promise((resolve, reject) => {
    const onLow = () => { cleanup(); resolve(); };
    const onClose = () => { cleanup(); reject(new Error('Data channel closed')); };
    const cleanup = () => {
      dc.removeEventListener('bufferedamountlow', onLow);
      dc.removeEventListener('close', onClose);
    };
    dc.addEventListener('bufferedamountlow', onLow, { once: true });
    dc.addEventListener('close', onClose, { once: true });
  });
}

async function encryptAndSend(link, plain) {
  if (!isSecure(link)) throw new Error('Secure channel is not ready');
  await waitForWritable(link.dc);
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const cipher = new Uint8Array(await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, link.crypto.key, plain));
  const packet = new Uint8Array(iv.length + cipher.length);
  packet.set(iv, 0);
  packet.set(cipher, iv.length);
  link.dc.send(packet.buffer);
}

async function sendControl(link, obj) {
  const json = encoder.encode(JSON.stringify(obj));
  const frame = new Uint8Array(1 + json.length);
  frame[0] = CONTROL_KIND;
  frame.set(json, 1);
  await encryptAndSend(link, frame);
}

async function sendFileChunk(link, conv, id, transferId, seq, total, bytes) {
  const headerBytes = encoder.encode(JSON.stringify({ conv: convScope(conv), id, t: transferId, seq, total }));
  const frame = new Uint8Array(1 + 4 + headerBytes.length + bytes.length);
  frame[0] = FILE_CHUNK_KIND;
  new DataView(frame.buffer).setUint32(1, headerBytes.length);
  frame.set(headerBytes, 5);
  frame.set(bytes, 5 + headerBytes.length);
  await encryptAndSend(link, frame);
}

async function handleDataMessage(link, data) {
  if (typeof data === 'string') {
    let msg;
    try { msg = JSON.parse(data); } catch { return; }
    if (msg.kind === 'crypto-hello' && typeof msg.publicKey === 'string' && msg.publicKey.length <= 256) {
      await handleCryptoHello(link, msg);
    } else if (msg.kind === 'crypto-proof') {
      await handleCryptoProof(link, msg);
    }
    return;
  }
  if (!link.crypto.key) return;
  try {
    if (data instanceof Blob) data = await data.arrayBuffer();
    const packet = new Uint8Array(data);
    if (packet.byteLength < 13) return;
    const iv = packet.slice(0, 12);
    const cipher = packet.slice(12);
    const plain = new Uint8Array(await crypto.subtle.decrypt({ name: 'AES-GCM', iv }, link.crypto.key, cipher));
    await handlePlainFrame(link, plain);
  } catch {
    toast(`Could not decrypt a message from ${displayName(link.peerId)}`);
  }
}

async function handlePlainFrame(link, frame) {
  if (!frame.length) return;
  if (frame[0] === CONTROL_KIND) {
    if (frame.length > CAPS.controlBytes) return;
    let msg;
    try { msg = JSON.parse(decoder.decode(frame.slice(1))); } catch { return; }
    if (!msg || typeof msg !== 'object') return;
    const conv = resolveScope(msg.conv, link.peerId);
    if (!conv) return;
    await handleControl(link, conv, msg);
    return;
  }
  if (frame[0] === FILE_CHUNK_KIND) {
    const view = new DataView(frame.buffer, frame.byteOffset, frame.byteLength);
    const headerLen = view.getUint32(1);
    if (headerLen < 2 || 5 + headerLen > frame.length) return;
    let header;
    try { header = JSON.parse(decoder.decode(frame.slice(5, 5 + headerLen))); } catch { return; }
    const conv = resolveScope(header.conv, link.peerId);
    if (!conv) return;
    const bytes = frame.slice(5 + headerLen);
    if (bytes.byteLength > CAPS.chunkBytes) return;
    receiveFileChunk(link, conv, header, bytes);
  }
}

async function handleControl(link, conv, msg) {
  if (msg.type === 'chat' && msg.message) {
    // A live chat frame must be authored by the peer that sent it. Without this
    // one room member could post as another, since the link authenticates the
    // sender but the envelope's `from` is just data.
    if (msg.message.from !== link.peerId) return;
    const isNew = !conv.messages.has(msg.message.id);
    mergeMessage(conv, msg.message, { verifiedAuthor: true });
    renderSession();
    if (isNew) notifyIncoming(conv, msg.message);
    return;
  }

  if (msg.type === 'sync-request') {
    // resolveScope already refused a room this device is not in.
    if (conversationMembers(conv).includes(link.peerId)) await syncConversationWith(link, conv);
    return;
  }

  if (msg.type === 'sync-state') {
    // Bound what one peer can make this tab allocate in a single sync.
    const messages = Array.isArray(msg.messages) ? msg.messages.slice(0, CAPS.syncMessages) : [];
    const files = Array.isArray(msg.files) ? msg.files.slice(0, CAPS.syncFiles) : [];
    // Relayed history is how a rejoining peer recovers what it missed, so a
    // third-party author is legitimate here — but it is only as trustworthy as
    // the peer relaying it, and the UI says so.
    for (const item of messages) {
      mergeMessage(conv, item, { verifiedAuthor: item?.from === link.peerId, relayedBy: link.peerId });
    }
    for (const meta of files) mergeFileMeta(conv, meta);
    renderSession();
    return;
  }

  if (msg.type === 'file-meta' && msg.file) {
    const meta = msg.file;
    if (!validFileMeta(meta)) return;
    if (!conv.files.has(meta.id) && conv.files.size >= CAPS.filesPerConversation) return;
    const totalChunks = Number.isFinite(meta.totalChunks) ? meta.totalChunks : Math.ceil(meta.size / CHUNK_SIZE);
    const existing = conv.files.get(meta.id);

    // Keep whatever chunks a cancelled or interrupted attempt already delivered
    // so the new transfer can resume rather than start over.
    let chunks = existing?.chunks;
    if (!Array.isArray(chunks) || chunks.length !== totalChunks) chunks = new Array(totalChunks);

    // An accepted file resuming, or one already decided, is not asked again.
    const alreadyDecided = existing?.offer === 'accepted' || existing?.offer === 'declined';
    const ask = !alreadyDecided && needsConsent(link.peerId, link);

    const record = {
      ...(existing || {}),
      ...meta,
      totalChunks,
      holders: mergeHolders(existing?.holders, meta.holders, link.peerId),
      blob: existing?.blob || null,
      chunks,
      receivedBytes: countReceivedBytes(chunks),
      progress: chunks.length ? countReceived(chunks) / chunks.length : 0,
      complete: false,
      corrupt: false,
      available: Boolean(existing?.blob),
      direction: 'received',
      transferId: typeof msg.transferId === 'string' ? msg.transferId : null,
      sourceId: link.peerId,
      offer: ask ? 'pending' : (existing?.offer || null)
    };
    conv.files.set(meta.id, record);

    if (ask) {
      // Stop the sender before the bytes arrive rather than buffering a file
      // nobody has agreed to. Accepting later resumes it through file-request.
      record.transferId = null;
      sendControl(link, {
        conv: convScope(conv),
        type: 'transfer-cancel',
        id: meta.id,
        transferId: msg.transferId,
        reason: 'awaiting-consent'
      }).catch(() => {});
      notifyOffer(conv, record);
    }
    renderSession();
    return;
  }

  if (msg.type === 'file-complete') {
    await finalizeIncomingFile(conv, msg.id, msg.sha256);
    return;
  }

  if (msg.type === 'transfer-cancel') {
    const file = conv.files.get(msg.id);
    if (!file) return;
    const send = state.activeSends.get(msg.transferId);
    if (send) {
      // A recipient stopping our upload stops it for that recipient only. In a
      // room, one member declining or asking first must not cut off the others.
      send.cancelledPeers.add(link.peerId);
      if (file.direction === 'sent') {
        if (msg.reason === 'awaiting-consent') {
          file.awaitingConsent = mergeHolders(file.awaitingConsent, link.peerId);
        } else if (msg.reason === 'declined') {
          file.awaitingConsent = mergeHolders(file.awaitingConsent).filter(id => id !== link.peerId);
          toast(`${displayName(link.peerId)} declined ${file.name}`);
        }
        renderSession();
      }
    } else if (file.direction === 'sent' && msg.reason === 'declined') {
      // Declined after the transfer had already paused for consent.
      file.awaitingConsent = mergeHolders(file.awaitingConsent).filter(id => id !== link.peerId);
      toast(`${displayName(link.peerId)} declined ${file.name}`);
      renderSession();
    }
    if (file.direction === 'received' && file.transferId === msg.transferId) {
      // The sender stopped its upload to us.
      file.transferId = null;
      renderSession();
      toast(`${displayName(link.peerId)} stopped sending ${file.name}`);
    }
    return;
  }

  if (msg.type === 'file-request') {
    const file = conv.files.get(msg.id);
    // Rejoining peers pull bytes on demand; nothing is retransmitted automatically.
    if (!file?.blob) return;
    if (state.activeSends.size >= CAPS.concurrentSends) {
      await sendControl(link, { conv: convScope(conv), type: 'transfer-cancel', id: msg.id, transferId: msg.transferId, reason: 'busy' }).catch(() => {});
      return;
    }
    // A request from a recipient we were waiting on means it said yes.
    if (file.direction === 'sent' && file.awaitingConsent?.length) {
      file.awaitingConsent = file.awaitingConsent.filter(id => id !== link.peerId);
      renderSession();
    }
    const have = Array.isArray(msg.have) ? msg.have : [];
    await sendBlobTo([link], conv, file.blob, file, have).catch(() => {});
  }
}

const INCOMING_POLICIES = ['auto', 'new', 'always'];

/**
 * Whether a file from this device needs the user's yes before any bytes are
 * accepted. "New" means first contact: a device this browser had never
 * completed a handshake with before this session, or, for a relayed file from
 * a device never met directly, one with no remembered identity at all.
 */
function needsConsent(deviceId, link) {
  if (state.incomingPolicy === 'auto') return false;
  // "Always ask" means every file, even from a device accepted a moment ago.
  if (state.incomingPolicy === 'always') return true;
  if (state.consentedDevices.has(deviceId)) return false;
  if (link?.trust) return link.trust.known === false;
  return !deviceTrust(deviceId);
}

function validFileMeta(meta) {
  if (!meta || typeof meta !== 'object') return false;
  if (typeof meta.id !== 'string' || meta.id.length > 64) return false;
  if (typeof meta.name !== 'string' || !meta.name.length || meta.name.length > 512) return false;
  if (!Number.isFinite(meta.size) || meta.size < 0) return false;
  // The admission limit has to hold on receive too, or a peer can declare any
  // size it likes and make this tab allocate against it.
  if (meta.size > state.config.maxFileBytes) return false;
  const totalChunks = meta.totalChunks;
  if (totalChunks != null) {
    if (!Number.isInteger(totalChunks) || totalChunks < 0 || totalChunks > CAPS.fileChunks) return false;
    // Chunk count and size must agree, so neither can be inflated on its own.
    if (totalChunks !== Math.ceil(meta.size / CHUNK_SIZE)) return false;
  }
  if (meta.sha256 != null && !/^[0-9a-f]{64}$/.test(meta.sha256)) return false;
  return true;
}

const countReceived = (chunks) => chunks.reduce((n, chunk) => n + (chunk ? 1 : 0), 0);
const countReceivedBytes = (chunks) => chunks.reduce((n, chunk) => n + (chunk?.byteLength || 0), 0);

// Compact the chunk indices we already hold into [start, end] runs, so a resume
// request stays small even for a file with a million chunks.
function heldRanges(chunks) {
  const ranges = [];
  let start = -1;
  for (let i = 0; i <= chunks.length; i++) {
    const present = i < chunks.length && Boolean(chunks[i]);
    if (present && start < 0) start = i;
    else if (!present && start >= 0) {
      ranges.push([start, i - 1]);
      start = -1;
    }
  }
  return ranges;
}

const inRanges = (ranges, seq) => ranges.some(([start, end]) => seq >= start && seq <= end);

function mergeHolders(...sources) {
  const out = new Set();
  for (const source of sources) {
    if (typeof source === 'string') out.add(source);
    else if (Array.isArray(source)) for (const id of source) if (typeof id === 'string') out.add(id);
  }
  return [...out];
}

/* ---------- conversation state (merge by immutable id) ---------- */

function mergeMessage(conv, message, { verifiedAuthor = true, relayedBy = null } = {}) {
  if (!message?.id || typeof message.id !== 'string' || message.id.length > 64) return;
  if (typeof message.from !== 'string' || message.from.length > 128) return;
  if (typeof message.text !== 'string' || message.text.length > CAPS.messageChars) return;
  if (conv.messages.has(message.id)) return;
  if (conv.messages.size >= CAPS.messagesPerConversation) return;
  conv.messages.set(message.id, {
    id: message.id,
    text: message.text,
    from: message.from,
    fromName: typeof message.fromName === 'string' ? message.fromName.slice(0, 64) : '',
    at: Number(message.at) || Date.now(),
    verifiedAuthor,
    relayedBy
  });
}

function mergeFileMeta(conv, meta) {
  if (!validFileMeta(meta)) return;
  const existing = conv.files.get(meta.id);
  if (existing) {
    existing.holders = mergeHolders(existing.holders, meta.holders);
    if (!existing.sha256 && meta.sha256) existing.sha256 = meta.sha256;
    return;
  }
  if (conv.files.size >= CAPS.filesPerConversation) return;
  conv.files.set(meta.id, {
    ...meta,
    holders: mergeHolders(meta.holders),
    blob: null,
    chunks: null,
    receivedBytes: 0,
    progress: 0,
    complete: false,
    corrupt: false,
    available: false,
    transferId: null,
    sourceId: null,
    direction: 'history'
  });
}

function fileManifest(conv) {
  return [...conv.files.values()].map(file => ({
    id: file.id,
    name: file.name,
    size: file.size,
    type: file.type || 'application/octet-stream',
    addedAt: file.addedAt,
    from: file.from,
    fromName: file.fromName || '',
    totalChunks: Number.isFinite(file.totalChunks) ? file.totalChunks : Math.ceil(file.size / CHUNK_SIZE),
    sha256: file.sha256 || null,
    holders: mergeHolders(file.holders, file.blob ? state.self?.id : null)
  }));
}

// Everyone syncs the full manifest with every peer they link to, so a gap one
// peer missed is healed by another. Merging by immutable id makes it idempotent,
// which is why no surviving peer has to be elected as the authority.
async function syncEverythingWith(link) {
  for (const conv of state.conversations.values()) {
    if (!conversationMembers(conv).includes(link.peerId)) continue;
    await syncConversationWith(link, conv);
  }
}

function syncConversationWith(link, conv) {
  const messages = [...conv.messages.values()].sort((a, b) => a.at - b.at);
  return sendControl(link, {
    conv: convScope(conv),
    type: 'sync-state',
    messages,
    files: fileManifest(conv)
  }).catch(() => {});
}

// A device that rejoins a room may already hold secure links to its members:
// they reconnect to an away member as soon as it is back online, and send their
// history then — before the rejoin lands, when it is discarded as belonging to
// a room this device is not in. So on joining, ask each connected member for
// the room's history instead of relying on which side got there first.
function requestRoomHistory(roomId) {
  const conv = state.conversations.get(roomConvId(roomId));
  if (!conv) return;
  for (const peerId of onlineMembers(conv)) {
    const link = state.links.get(peerId);
    if (isSecure(link)) sendControl(link, { conv: convScope(conv), type: 'sync-request' }).catch(() => {});
  }
}

/* ---------- sending ---------- */

async function waitForSecure(peerId, timeoutMs = 12000) {
  if (isSecure(state.links.get(peerId))) return state.links.get(peerId);
  await ensureLink(peerId);
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    if (isSecure(state.links.get(peerId))) return state.links.get(peerId);
    await new Promise(r => setTimeout(r, 80));
  }
  throw new Error(`Secure connection to ${displayName(peerId)} timed out`);
}

async function sendChat(conv, text) {
  const clean = text.trim();
  if (!clean) return;
  const message = {
    id: crypto.randomUUID(),
    text: clean,
    from: state.self.id,
    fromName: state.self.name,
    at: Date.now()
  };
  mergeMessage(conv, message);
  renderSession();

  const recipients = onlineMembers(conv);
  const offline = await offlineTargetsFor(conv);
  if (!recipients.length && !offline.length) throw unreachableError(conv);

  // Same rule as files: direct where a secure link is available, the relay for
  // every recipient it is not. Each recipient gets the message once. Offline
  // recipients go straight to the relay; there is no link to wait for.
  const canRelay = relayEnabled();
  /** @type {any[]} */
  const direct = [];
  /** @type {string[]} */
  const viaRelay = [...offline];
  const relayOnly = canRelay && (state.forceRelay || isRelayRoom(conv));
  await Promise.all(recipients.map(async peerId => {
    const link = state.links.get(peerId);
    if (relayOnly) {
      viaRelay.push(peerId);
      return;
    }
    if (isSecure(link)) {
      direct.push(link);
      return;
    }
    if (canRelay && (link?.relayPreferredUntil || 0) > Date.now()) {
      viaRelay.push(peerId);
      return;
    }
    const ready = await waitForSecure(peerId, canRelay ? CHAT_P2P_WAIT_MS : 12000).catch(() => null);
    if (ready) {
      direct.push(ready);
    } else {
      viaRelay.push(peerId);
      const stuck = state.links.get(peerId);
      if (stuck) stuck.relayPreferredUntil = Date.now() + RELAY_STICKY_MS;
    }
  }));

  const results = await Promise.allSettled(
    direct.map(link => sendControl(link, { conv: convScope(conv), type: 'chat', message }))
  );
  results.forEach((result, index) => {
    if (result.status === 'rejected') viaRelay.push(direct[index].peerId);
  });

  if (!viaRelay.length) return;
  if (!canRelay) {
    toast(`Message not delivered to ${viaRelay.length} of ${recipients.length} device${recipients.length === 1 ? '' : 's'}`);
    return;
  }
  const relayed = await sendMessageViaRelay(conv, message, viaRelay);
  const stored = conv.messages.get(message.id);
  if (stored && relayed) {
    stored.via = 'relay';
    renderSession();
  }
}

/** Seals a chat message to each recipient and leaves it with the server. */
async function sendMessageViaRelay(conv, message, recipientIds) {
  const targets = [];
  for (const id of recipientIds) {
    const sealRaw = await verifiedSealKey(id);
    if (sealRaw) targets.push({ id, sealRaw });
    else toast(`${displayName(id)} cannot receive messages via the server (its key is missing or unverified).`);
  }
  if (!targets.length) return 0;

  // Keyed by recipient device ID, which is peer-supplied: a Map, not an object.
  /** @type {Map<string, any>} */
  const envelopes = new Map();
  for (const target of targets) {
    envelopes.set(target.id, await buildMessageEnvelope({
      identity: state.identity,
      recipientId: target.id,
      recipientSealRaw: target.sealRaw,
      conv: convScope(conv),
      message
    }));
  }

  // One sealed copy per recipient, so a long message to a large room can exceed
  // what the server accepts in one frame. Pack recipients into as few frames as
  // fit; each frame becomes its own item on the server.
  const makeFrame = (subset) => ({
    type: 'blob-offer',
    requestId: crypto.randomUUID(),
    kind: 'message',
    conv: convScope(conv),
    bytes: 0,
    chunkSize: 1,
    totalChunks: 0,
    envelopes: Object.fromEntries(subset)
  });
  /** @type {Array<Array<[string, any]>>} */
  const batches = [];
  /** @type {Array<[string, any]>} */
  let batch = [];
  for (const entry of envelopes) {
    const candidate = [...batch, entry];
    if (batch.length && JSON.stringify(makeFrame(candidate)).length > MAX_RELAY_FRAME_CHARS) {
      batches.push(batch);
      batch = [entry];
    } else {
      batch = candidate;
    }
  }
  if (batch.length) batches.push(batch);

  let delivered = 0;
  for (const subset of batches) {
    const frame = makeFrame(subset);
    if (JSON.stringify(frame).length > MAX_RELAY_FRAME_CHARS) {
      // Even a single recipient's copy does not fit: the message itself is too big.
      toast('That message is too long to send via the server. Try a shorter one.');
      continue;
    }
    try {
      await awaitReply(frame.requestId, () => wsSend(frame));
      delivered += subset.length;
    } catch (err) {
      toast(`Message not delivered via the server: ${err.message}`);
    }
  }
  return delivered;
}

const relayEnabled = () => Boolean(state.config.relay?.enabled);

/**
 * Recipients who are offline but can still be reached by leaving the item on
 * the server. For a direct conversation with a device we have no record of yet
 * (say, after a reload), ask the server for it first.
 */
async function offlineTargetsFor(conv) {
  if (!relayEnabled()) return [];
  if (conv.kind === 'direct' && !state.peers.has(conv.peerId) && !isRecentlySeen(conv.peerId)) {
    await lookupDevices([conv.peerId]);
  }
  return relayOnlyMembers(conv);
}

function unreachableError(conv) {
  if (conv.kind === 'room') return new Error('Nobody else in this room is online or reachable through the server.');
  return new Error(relayEnabled()
    ? 'That device has not been online in the last 24 hours, so there is nowhere to leave this for it.'
    : 'That device is offline.');
}

// Direct first; the relay takes whichever recipients a direct link could not
// reach, either because ICE never connected or because the link died part-way.
// A recipient therefore gets each file exactly once, by one path or the other.
async function sendFiles(conv, fileList) {
  const recipients = onlineMembers(conv);
  const offline = await offlineTargetsFor(conv);
  if (!recipients.length && !offline.length) throw unreachableError(conv);

  const canRelay = relayEnabled();
  // A large room is relay-only: one upload serves every member.
  const skipDirect = canRelay && (state.forceRelay || isRelayRoom(conv));
  /** @type {any[]} */
  let links = [];
  if (!skipDirect && recipients.length) {
    const wait = canRelay ? P2P_WAIT_WITH_RELAY_MS : 12000;
    await Promise.all(recipients.map(id => waitForSecure(id, wait).catch(() => null)));
    links = recipients.map(id => state.links.get(id)).filter(isSecure);
  }
  if (!links.length && !canRelay) throw new Error('Secure peer connection timed out');

  for (const file of fileList) {
    if (file.size > state.config.maxFileBytes) {
      toast(`${file.name} exceeds this server's configured browser-memory limit.`);
      continue;
    }
    if (conv.files.size >= CAPS.filesPerConversation) {
      toast(`This conversation already holds ${CAPS.filesPerConversation} files.`);
      break;
    }

    const meta = {
      id: crypto.randomUUID(),
      name: file.name,
      size: file.size,
      type: file.type || 'application/octet-stream',
      addedAt: Date.now(),
      from: state.self.id,
      fromName: state.self.name,
      totalChunks: Math.ceil(file.size / CHUNK_SIZE),
      sha256: null
    };
    /** @type {any} */
    const record = {
      ...meta,
      holders: [state.self.id],
      blob: file,
      chunks: null,
      progress: 0,
      hashing: true,
      complete: true,
      available: true,
      direction: 'sent'
    };
    conv.files.set(meta.id, record);
    renderSession();

    // Hash before the first byte goes out so the digest can ride in the metadata
    // and stay correct even if a later resume only re-sends part of the file.
    meta.sha256 = await hashBlob(file, CHUNK_SIZE, fraction => {
      record.progress = fraction;
      updateFileProgress(conv, record);
    });
    record.sha256 = meta.sha256;
    record.hashing = false;
    record.progress = 0;
    renderSession();

    const direct = links.filter(isSecure);
    const needRelay = [...recipients.filter(id => !direct.some(link => link.peerId === id)), ...offline];
    if (direct.length) {
      let outcome;
      try {
        outcome = await sendBlobTo(direct, conv, file, meta);
      } catch {
        outcome = { failed: direct.map(link => link.peerId), cancelled: false };
      }
      if (outcome?.cancelled) continue;
      needRelay.push(...(outcome?.failed || []));
    }

    if (!needRelay.length) continue;
    if (!canRelay) {
      toast(`${file.name} did not reach ${needRelay.length} device${needRelay.length === 1 ? '' : 's'}.`);
      continue;
    }
    try {
      await sendViaRelay(conv, file, meta, record, needRelay);
    } catch (err) {
      record.relayStage = 'failed';
      renderSession();
      toast(`Could not send ${file.name} via the server: ${err.message}`);
    }
  }
}

// Full mesh means the sender uploads the file once per recipient. Chunks go out
// to every live link in step so the blob is only read once.
//
// `alreadyHeld` carries the chunk ranges a resuming receiver still has, so an
// interrupted transfer picks up where it stopped instead of restarting.
async function sendBlobTo(links, conv, blob, meta, alreadyHeld = []) {
  const totalChunks = Math.ceil(blob.size / CHUNK_SIZE);
  const transferId = crypto.randomUUID();
  // `cancelled` is the sender stopping the whole upload; `cancelledPeers` is
  // individual recipients stopping it for themselves (declining, or pausing to
  // ask first) while it carries on to everyone else.
  const transfer = { transferId, cancelled: false, cancelledPeers: new Set(), fileId: meta.id, name: meta.name };
  state.activeSends.set(transferId, transfer);

  const wire = {
    id: meta.id,
    name: meta.name,
    size: meta.size,
    type: meta.type || 'application/octet-stream',
    addedAt: meta.addedAt,
    from: meta.from,
    fromName: meta.fromName || '',
    totalChunks,
    sha256: meta.sha256 || null,
    holders: mergeHolders(meta.holders, state.self?.id)
  };

  const local = conv.files.get(meta.id);
  const trackProgress = local?.direction === 'sent';
  if (trackProgress) local.transferId = transferId;

  try {
    await Promise.all(links.map(link =>
      sendControl(link, { conv: convScope(conv), type: 'file-meta', file: wire, transferId }).catch(() => {})));

    let alive = links.slice();
    // Links that die mid-transfer are remembered rather than dropped silently,
    // so the caller can finish those recipients over the relay.
    /** @type {string[]} */
    const failed = [];
    let sent = 0;
    for (let seq = 0; seq < totalChunks; seq++) {
      if (transfer.cancelled) {
        await Promise.all(alive.map(link =>
          sendControl(link, { conv: convScope(conv), type: 'transfer-cancel', id: meta.id, transferId, reason: 'cancelled' }).catch(() => {})));
        if (trackProgress) local.transferId = null;
        renderSession();
        return { sent, failed: [], cancelled: true };
      }
      // Recipients that stopped the transfer for themselves drop out quietly:
      // they are neither sent to nor counted as failed (and so not relayed to).
      alive = alive.filter(link => !transfer.cancelledPeers.has(link.peerId));
      if (!alive.length) return { sent, failed, cancelled: false };
      if (inRanges(alreadyHeld, seq)) continue;

      const start = seq * CHUNK_SIZE;
      const bytes = new Uint8Array(await blob.slice(start, Math.min(blob.size, start + CHUNK_SIZE)).arrayBuffer());
      const settled = await Promise.all(alive.map(async link => {
        try { await sendFileChunk(link, conv, meta.id, transferId, seq, totalChunks, bytes); return link; }
        catch { return null; }
      }));
      for (const [index, result] of settled.entries()) {
        if (!result) failed.push(alive[index].peerId);
      }
      alive = settled.filter(Boolean);
      if (!alive.length) return { sent, failed, cancelled: false };
      sent++;
      if (trackProgress) {
        local.progress = (seq + 1) / totalChunks;
        updateFileProgress(conv, local);
      }
    }

    alive = alive.filter(link => !transfer.cancelledPeers.has(link.peerId));
    await Promise.all(alive.map(link =>
      sendControl(link, { conv: convScope(conv), type: 'file-complete', id: meta.id, transferId, sha256: wire.sha256 }).catch(() => {})));
    if (trackProgress) {
      local.progress = 1;
      local.transferId = null;
    }
    renderSession();
    return { sent, failed, cancelled: false };
  } finally {
    state.activeSends.delete(transferId);
    if (trackProgress && local.transferId === transferId) local.transferId = null;
  }
}

/* ---------- server relay ---------- */

// WebSocket request/response pairing for the relay: the server echoes a
// request id (offers) or the blob id (claims) back on the reply.
function awaitReply(key, send, timeoutMs = 20000) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      state.pendingRequests.delete(key);
      reject(new Error('The server did not answer in time.'));
    }, timeoutMs);
    state.pendingRequests.set(key, { resolve, reject, timer });
    send();
  });
}

function settleRequest(key, value, error) {
  const pending = key && state.pendingRequests.get(key);
  if (!pending) return;
  state.pendingRequests.delete(key);
  clearTimeout(pending.timer);
  if (error) pending.reject(error);
  else pending.resolve(value);
}

/**
 * A peer's seal key, but only if it is bound to the device id we are talking to:
 * the advertised identity key must hash to that id and must have signed the
 * seal key. Presence comes from the server, so this is what stops a hostile
 * server from substituting its own key and reading the file.
 */
async function verifiedSealKey(peerId) {
  // A live presence record, or the last one we have for a device now offline.
  // Either way it is checked below; where it came from does not matter.
  const peer = state.peers.get(peerId) || state.deviceRecords.get(peerId);
  if (!peer?.sealKey) return null;
  const cacheKey = [peerId, peer.identityKey, peer.sealKey, peer.sealKeySignature].join('|');
  if (state.sealKeyCache.has(cacheKey)) return state.sealKeyCache.get(cacheKey);
  const verified = await verifyAdvertisedIdentity({
    deviceId: peerId,
    identityKey: peer.identityKey,
    sealKey: peer.sealKey,
    sealKeySignature: peer.sealKeySignature
  });
  const result = verified ? verified.sealRaw : null;
  state.sealKeyCache.set(cacheKey, result);
  return result;
}

function uploadBlob(blobId, token, body, onProgress) {
  // XHR rather than fetch: fetch still has no upload progress.
  return new Promise((resolve, reject) => {
    const xhr = new XMLHttpRequest();
    xhr.open('PUT', `/blob/${encodeURIComponent(blobId)}?token=${encodeURIComponent(token)}`);
    xhr.upload.onprogress = event => {
      if (event.lengthComputable) onProgress(event.loaded / event.total);
    };
    xhr.onload = () => (xhr.status === 204
      ? resolve(undefined)
      : reject(new Error(xhr.responseText || `upload failed (${xhr.status})`)));
    xhr.onerror = () => reject(new Error('upload failed'));
    xhr.send(body);
  });
}

async function sendViaRelay(conv, blob, meta, record, recipientIds) {
  const chunkSize = state.config.relay.chunkSize;
  const { totalChunks, bytes } = cipherLayout(blob.size, chunkSize);

  const targets = [];
  for (const id of recipientIds) {
    const sealRaw = await verifiedSealKey(id);
    if (sealRaw) targets.push({ id, sealRaw });
    else toast(`${displayName(id)} cannot receive files via the server (its key is missing or unverified).`);
  }
  if (!targets.length) throw new Error('no recipient could be verified');

  record.via = 'relay';
  record.relayStage = 'encrypting';
  record.progress = 0;
  renderSession();

  const { raw, key } = await generateContentKey();
  /** @type {Map<string, any>} */
  const envelopes = new Map();
  for (const target of targets) {
    envelopes.set(target.id, await buildEnvelope({
      identity: state.identity,
      recipientId: target.id,
      recipientSealRaw: target.sealRaw,
      meta: { ...meta, chunkSize, totalChunks },
      contentKeyRaw: raw,
      conv: convScope(conv)
    }));
  }

  const body = await encryptBody(blob, key, meta.id, chunkSize, fraction => {
    record.progress = fraction;
    updateFileProgress(conv, record);
  });

  const requestId = crypto.randomUUID();
  const offered = await awaitReply(requestId, () => wsSend({
    type: 'blob-offer',
    requestId,
    conv: convScope(conv),
    bytes,
    chunkSize,
    totalChunks,
    envelopes: Object.fromEntries(envelopes)
  }));

  record.relayStage = 'uploading';
  record.relayBlobId = offered.blobId;
  record.progress = 0;
  renderSession();

  await uploadBlob(offered.blobId, offered.uploadToken, body, fraction => {
    record.progress = fraction;
    updateFileProgress(conv, record);
  });

  record.relayStage = 'uploaded';
  record.progress = 1;
  renderSession();
  toast(`${meta.name} is on the server for ${targets.length} device${targets.length === 1 ? '' : 's'}.`);
}

function findRelayedFile(blobId) {
  for (const conv of state.conversations.values()) {
    for (const file of conv.files.values()) {
      if (file.relayBlobId === blobId) return { conv, file };
    }
  }
  return null;
}

async function handleBlobAvailable(notice) {
  if (!notice?.blobId) return;
  if (state.relayInbound.has(notice.blobId)) {
    // The server announces again whatever this device has not taken yet, each
    // time it reconnects. A download that failed earlier — typically because
    // the connection dropped mid-way — is retried then, rather than waiting
    // for someone to press Retry.
    const found = findRelayedFile(notice.blobId);
    if (found && found.file.relayStage === 'failed' && found.file.relayKey) {
      await downloadRelayed(found.conv, found.file);
    }
    return;
  }
  state.relayInbound.add(notice.blobId);
  if (notice.kind === 'message') {
    await handleRelayedMessage(notice);
    return;
  }

  let opened;
  try {
    opened = await openEnvelope({
      sealPrivateKey: state.identity.sealPrivateKey,
      box: notice.envelope,
      selfId: state.identity.deviceId,
      expectedFrom: notice.from
    });
  } catch (err) {
    // Not ours, not from who the server says, or not signed: refuse it and let
    // the server drop it rather than leave it waiting.
    wsSend({ type: 'blob-release', blobId: notice.blobId });
    toast(`Refused a relayed file: ${err.message}`);
    return;
  }

  const { meta, contentKey } = opened;
  if (meta.conv !== notice.conv) {
    wsSend({ type: 'blob-release', blobId: notice.blobId });
    return;
  }
  const conv = resolveScope(notice.conv, notice.from);
  if (!conv) {
    wsSend({ type: 'blob-release', blobId: notice.blobId });
    return;
  }

  const existing = conv.files.get(meta.id);
  if (existing?.blob) {
    // Already arrived directly; the relayed copy is redundant.
    wsSend({ type: 'blob-release', blobId: notice.blobId });
    return;
  }
  const candidate = { id: meta.id, name: meta.name, size: meta.size, sha256: meta.sha256, totalChunks: Math.ceil(meta.size / CHUNK_SIZE) };
  if (!validFileMeta(candidate) || (!existing && conv.files.size >= CAPS.filesPerConversation)) {
    wsSend({ type: 'blob-release', blobId: notice.blobId });
    return;
  }

  const record = existing || {};
  Object.assign(record, {
    ...candidate,
    type: meta.type || 'application/octet-stream',
    addedAt: Number(meta.addedAt) || Date.now(),
    from: notice.from,
    fromName: typeof meta.fromName === 'string' ? meta.fromName.slice(0, 64) : '',
    holders: mergeHolders(record.holders),
    blob: null,
    chunks: null,
    progress: 0,
    complete: false,
    corrupt: false,
    direction: 'received',
    via: 'relay',
    relayStage: 'downloading',
    relayBlobId: notice.blobId,
    relayMeta: meta,
    relayKey: contentKey,
    relayConvId: conv.id
  });
  conv.files.set(meta.id, record);

  // Same rule as a direct transfer. Nothing is fetched until the user says yes;
  // the item simply waits on the server meanwhile.
  if (record.offer !== 'accepted' && needsConsent(notice.from, state.links.get(notice.from))) {
    record.offer = 'pending';
    record.relayStage = 'offered';
    renderSession();
    notifyOffer(conv, record);
    return;
  }
  renderSession();
  await downloadRelayed(conv, record);
}

async function handleRelayedMessage(notice) {
  let opened;
  try {
    opened = await openMessageEnvelope({
      sealPrivateKey: state.identity.sealPrivateKey,
      box: notice.envelope,
      selfId: state.identity.deviceId,
      expectedFrom: notice.from,
      maxChars: CAPS.messageChars
    });
  } catch (err) {
    // Not ours, not from who the server says, or not signed: drop it for good.
    wsSend({ type: 'blob-release', blobId: notice.blobId });
    toast(`Refused a relayed message: ${err.message}`);
    return;
  }
  if (opened.conv !== notice.conv) {
    wsSend({ type: 'blob-release', blobId: notice.blobId });
    return;
  }

  const conv = resolveScope(notice.conv, notice.from);
  // A room this browser is not (or no longer) in. Leave the item alone rather
  // than release it, and forget having seen it, so that if the device rejoins
  // before it ages out, the next announcement delivers it.
  if (!conv) {
    state.relayInbound.delete(notice.blobId);
    return;
  }

  const isNew = !conv.messages.has(opened.message.id);
  // The author is the device that signed the envelope, so unlike history
  // recovered through a peer sync this is verified authorship.
  mergeMessage(conv, opened.message, { verifiedAuthor: true, relayedBy: null });
  const stored = conv.messages.get(opened.message.id);
  if (stored && isNew) stored.via = 'relay';
  wsSend({ type: 'blob-release', blobId: notice.blobId });
  renderSession();
  if (isNew) notifyIncoming(conv, opened.message);
}

// A message for a conversation that is not open gets a notice with a way into
// it. That matters most for relayed messages, whose sender may already be
// offline and so have no row in the device table to click.
function notifyIncoming(conv, message) {
  if (state.activeConvId === conv.id) return;
  const who = message.fromName || displayName(message.from);
  const where = conv.kind === 'room' ? ` in ${conversationTitle(conv)}` : '';
  toast(`New message from ${who}${where}`, {
    label: 'Open',
    run: () => openConversation(conv.id, conv.kind, conv.kind === 'room' ? conv.roomId : conv.peerId, 'text')
  });
}

async function downloadRelayed(conv, record) {
  record.relayStage = 'downloading';
  record.progress = 0;
  renderSession();
  try {
    const claim = await awaitReply(`claim:${record.relayBlobId}`, () =>
      wsSend({ type: 'blob-claim', blobId: record.relayBlobId }));

    const response = await fetch(`/blob/${encodeURIComponent(record.relayBlobId)}?token=${encodeURIComponent(claim.downloadToken)}`, {
      cache: 'no-store'
    });
    if (!response.ok || !response.body) throw new Error(`download failed (${response.status})`);

    const decryptor = createBodyDecryptor({
      key: record.relayKey,
      fileId: record.id,
      chunkSize: record.relayMeta.chunkSize,
      size: record.size
    });
    const reader = response.body.getReader();
    for (;;) {
      const { value, done } = await reader.read();
      if (done) break;
      await decryptor.push(value);
      record.progress = decryptor.progress;
      updateFileProgress(conv, record);
    }
    const { chunks, sha256 } = decryptor.finish();

    if (sha256 !== record.sha256) {
      record.corrupt = true;
      record.relayStage = 'failed';
      renderSession();
      toast(`${record.name} failed its SHA-256 check and was discarded.`);
      return;
    }

    record.blob = new Blob(/** @type {BlobPart[]} */ (chunks), { type: record.type });
    record.complete = true;
    record.available = true;
    record.verified = true;
    record.progress = 1;
    record.relayStage = 'received';
    record.holders = mergeHolders(record.holders, state.self?.id);
    // Drop the key and metadata now the bytes are safe; nothing else needs them.
    record.relayKey = null;
    wsSend({ type: 'blob-release', blobId: record.relayBlobId });
    renderSession();
    toast(`Received ${record.name} via server · SHA-256 verified`);
  } catch (err) {
    record.relayStage = 'failed';
    renderSession();
    toast(`Could not download ${record.name}: ${err.message}`);
  }
}

function cancelTransfer(conv, file) {
  // Either side can stop a transfer: cancel our own upload, or tell the sender
  // to stop pushing to us. Partial chunks are kept for a later resume.
  for (const send of state.activeSends.values()) {
    if (send.fileId === file.id) send.cancelled = true;
  }
  if (file.transferId && file.direction === 'received') {
    const holder = file.sourceId && state.links.get(file.sourceId);
    if (holder && isSecure(holder)) {
      sendControl(holder, { conv: convScope(conv), type: 'transfer-cancel', id: file.id, transferId: file.transferId, reason: 'cancelled' }).catch(() => {});
    }
    file.transferId = null;
  }
  renderSession();
}

/* ---------- receiving files ---------- */

function receiveFileChunk(link, conv, header, bytes) {
  const file = conv.files.get(header.id);
  if (!file) return;
  // Chunks already in flight before the sender heard "wait" are discarded:
  // nothing is kept for a file the user has not agreed to.
  if (file.offer === 'pending' || file.offer === 'declined') return;
  // A chunk only counts if it belongs to the transfer we agreed to and lands in
  // the range that transfer declared.
  if (file.transferId && header.t && header.t !== file.transferId) return;
  if (!Number.isInteger(header.seq) || !Number.isInteger(header.total)) return;
  if (header.total > CAPS.fileChunks || header.seq < 0 || header.seq >= header.total) return;
  if (!Array.isArray(file.chunks) || file.chunks.length !== header.total) {
    if (file.chunks?.length) return; // declared length changed mid-transfer
    file.chunks = new Array(header.total);
  }
  if (file.chunks[header.seq]) return;
  // A chunk can never exceed the protocol chunk size, and the running total can
  // never exceed what the metadata declared — otherwise a peer could send
  // oversized chunks for a file it described as small.
  if (bytes.byteLength > CHUNK_SIZE) return;
  if ((file.receivedBytes || 0) + bytes.byteLength > file.size) return;

  file.chunks[header.seq] = bytes;
  file.receivedBytes = (file.receivedBytes || 0) + bytes.byteLength;
  file.sourceId = link.peerId;
  file.progress = Math.min(1, countReceived(file.chunks) / Math.max(1, file.chunks.length));
  updateFileProgress(conv, file);
}

async function finalizeIncomingFile(conv, fileId, declaredHash) {
  const file = conv.files.get(fileId);
  // A tiny file's completion can arrive before the sender saw our "wait".
  if (file?.offer === 'pending' || file?.offer === 'declined') return;
  if (!file?.chunks || file.chunks.some(chunk => !chunk)) {
    toast(`Transfer incomplete: ${file?.name || 'file'}`);
    return;
  }

  const expected = typeof declaredHash === 'string' ? declaredHash : file.sha256;
  if (expected && /^[0-9a-f]{64}$/.test(expected)) {
    file.verifying = true;
    renderSession();
    const actual = hashChunks(file.chunks);
    file.verifying = false;
    if (actual !== expected) {
      // Refuse the bytes rather than hand the user a silently corrupt file.
      file.chunks = null;
      file.receivedBytes = 0;
      file.progress = 0;
      file.corrupt = true;
      file.transferId = null;
      renderSession();
      toast(`${file.name} failed its SHA-256 check and was discarded.`);
      return;
    }
    file.sha256 = actual;
    file.verified = true;
  }

  file.blob = new Blob(file.chunks, { type: file.type || 'application/octet-stream' });
  file.chunks = null;
  file.progress = 1;
  file.complete = true;
  file.corrupt = false;
  file.available = true;
  file.transferId = null;
  file.holders = mergeHolders(file.holders, state.self?.id);
  renderSession();
  toast(file.verified ? `Received ${file.name} · SHA-256 verified` : `Received ${file.name}`);
}

async function requestFile(conv, file) {
  const holder = mergeHolders(file.holders)
    .filter(id => id !== state.self?.id && state.peers.has(id))
    .sort((a, b) => Number(isSecure(state.links.get(b))) - Number(isSecure(state.links.get(a))))[0];
  if (!holder) throw new Error('No online device is still holding that file.');
  const link = await waitForSecure(holder);
  const transferId = crypto.randomUUID();
  file.direction = 'received';
  file.complete = false;
  file.corrupt = false;
  file.transferId = transferId;
  file.sourceId = holder;
  // Tell the sender what we already have so a resume skips those chunks.
  const have = Array.isArray(file.chunks) ? heldRanges(file.chunks) : [];
  file.progress = Array.isArray(file.chunks) && file.chunks.length
    ? countReceived(file.chunks) / file.chunks.length
    : 0;
  await sendControl(link, { conv: convScope(conv), type: 'file-request', id: file.id, transferId, have });
  renderSession();
}

/* ---------- accepting and declining incoming files ---------- */

async function acceptOffer(conv, file) {
  // Saying yes once trusts that device for the rest of the session, so a burst
  // of files from it does not become a burst of prompts.
  state.consentedDevices.add(file.from);
  file.offer = 'accepted';
  renderSession();
  try {
    if (file.via === 'relay') await downloadRelayed(conv, file);
    else await requestFile(conv, file);
  } catch (err) {
    toast(err.message || `Could not fetch ${file.name}`);
  }
}

function declineOffer(conv, file) {
  file.offer = 'declined';
  file.chunks = null;
  file.progress = 0;
  if (file.via === 'relay') {
    // Our copy is no longer wanted; the server can drop it for us now.
    wsSend({ type: 'blob-release', blobId: file.relayBlobId });
    file.relayStage = 'declined';
    file.relayKey = null;
  } else {
    const link = state.links.get(file.sourceId || file.from);
    if (isSecure(link)) {
      sendControl(link, { conv: convScope(conv), type: 'transfer-cancel', id: file.id, transferId: null, reason: 'declined' })
        .catch(() => {});
    }
  }
  renderSession();
}

function notifyOffer(conv, file) {
  const who = file.fromName || displayName(file.from);
  const text = `${who} wants to send you ${file.name} (${formatBytes(file.size)})`;
  if (state.activeConvId === conv.id) {
    toast(text);
    return;
  }
  toast(text, {
    label: 'Review',
    run: () => openConversation(conv.id, conv.kind, conv.kind === 'room' ? conv.roomId : conv.peerId)
  });
}

function downloadFile(file) {
  if (!file.blob) return;
  const url = URL.createObjectURL(file.blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = file.name;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 30000);
}

/* ---------- session panel ---------- */

function getPeer(peerId) {
  const known = state.deviceRecords.get(peerId);
  return state.peers.get(peerId) || {
    id: peerId,
    name: displayName(peerId),
    code: 'offline',
    platform: known?.platform || 'Unknown',
    browser: known?.browser || 'Browser'
  };
}

function openConversation(convId, kind, ref, focus) {
  const conv = ensureConversation(convId, kind, ref);
  const wasClosed = state.activeConvId !== convId;
  if (wasClosed) {
    // Store the key as well as the element: the row that opened the panel is
    // very likely to be re-rendered before the panel closes again.
    state.panelReturnFocus = document.activeElement;
    state.panelReturnKey = focusKeyOf(document.activeElement);
  }
  state.activeConvId = convId;

  // `hidden` keeps the panel out of the accessibility tree while closed, so it
  // has to come off before the slide-in transition can run.
  sessionPanel.hidden = false;
  requestAnimationFrame(() => sessionPanel.classList.add('open'));

  renderSession();
  ensureConversationLinks(conv);

  if (focus === 'text') setTimeout(() => messageInput.focus(), 80);
  else if (focus === 'file') setTimeout(() => fileInput.click(), 80);
  else if (wasClosed) setTimeout(() => $('#closeSession').focus(), 80);
}

const openSession = (peerId, focus = 'chat') => openConversation(directConvId(peerId), 'direct', peerId, focus);
const openRoom = (roomId, focus = 'chat') => openConversation(roomConvId(roomId), 'room', roomId, focus);

function closeSessionPanel() {
  if (!state.activeConvId) return;
  sessionPanel.classList.remove('open');
  sessionPanel.classList.remove('dragging');
  state.activeConvId = null;

  // Hide only once it has slid out, so the panel is not yanked off screen.
  const hide = () => { if (!state.activeConvId) sessionPanel.hidden = true; };
  sessionPanel.addEventListener('transitionend', hide, { once: true });
  setTimeout(hide, 400);

  const returnTo = state.panelReturnFocus;
  const returnKey = state.panelReturnKey;
  state.panelReturnFocus = null;
  state.panelReturnKey = null;
  if (returnTo instanceof HTMLElement && document.contains(returnTo)) returnTo.focus();
  else findByFocusKey(returnKey)?.focus();
}

function activeConversation() {
  return state.activeConvId ? state.conversations.get(state.activeConvId) : null;
}

function leaveRoom(roomId) {
  wsSend({ type: 'leave-room', roomId });
  state.joinedRoomIds.delete(roomId);
  forgetConversation(roomConvId(roomId));
  renderRooms();
}

/* ---------- rendering ---------- */

// The tables are rebuilt wholesale on every presence update and every stats
// tick, which detaches whatever the user had focused. Keyed controls let focus
// be put back on the logically-same button afterwards.
function focusKeyOf(element) {
  return element instanceof HTMLElement && element.dataset.focusKey ? element.dataset.focusKey : null;
}

function findByFocusKey(key) {
  if (!key) return null;
  const match = document.querySelector(`[data-focus-key="${CSS.escape(key)}"]`);
  return match instanceof HTMLElement ? match : null;
}

function withPreservedFocus(render) {
  const key = focusKeyOf(document.activeElement);
  render();
  if (!key) return;
  findByFocusKey(key)?.focus();
}

function formatStatus(status) {
  const map = {
    idle: 'Available',
    new: 'Connecting',
    connecting: 'Connecting',
    connected: 'Connected',
    disconnected: 'Reconnecting',
    failed: 'Retrying',
    closed: 'Closed',
    unreachable: 'Unreachable',
    incompatible: 'Version mismatch',
    untrusted: 'Identity refused',
    queued: 'Queued'
  };
  return map[status] || status;
}

function trustLabel(link) {
  if (!isSecure(link)) return null;
  if (!link.trust) return 'Verified';
  return link.trust.known
    ? `Known device since ${new Date(link.trust.firstSeen).toLocaleDateString()}`
    : 'New device — compare the safety code';
}

function renderPeers() {
  withPreservedFocus(renderPeersNow);
}

function renderPeersNow() {
  peerRows.textContent = '';
  const peers = [...state.peers.values()].sort((a, b) => a.name.localeCompare(b.name));
  for (const peer of peers) {
    const link = state.links.get(peer.id);
    const tr = document.createElement('tr');
    tr.dataset.dropTarget = peer.id;
    tr.dataset.dropKind = 'direct';
    tr.title = 'Drop a file here to send it to this device';

    const nameTd = document.createElement('td');
    nameTd.dataset.label = 'Device';
    const nameWrap = document.createElement('div');
    nameWrap.className = 'device-name';
    const pip = document.createElement('span');
    pip.className = 'presence-pip';
    const name = document.createElement('span');
    name.textContent = peer.name;
    nameWrap.append(pip, name);
    // Trust state belongs next to the name, not buried in a tooltip.
    const trust = trustLabel(link);
    if (trust) {
      const badge = document.createElement('span');
      badge.className = link.trust?.known === false ? 'trust-badge new' : 'trust-badge';
      badge.textContent = link.trust?.known === false ? 'new' : 'known';
      badge.title = `${trust} · safety code ${link.crypto.safety}`;
      nameWrap.append(badge);
    }
    nameTd.append(nameWrap);

    const codeTd = document.createElement('td');
    codeTd.className = 'peer-code';
    codeTd.dataset.label = 'Code';
    codeTd.textContent = peer.code;

    const platformTd = document.createElement('td');
    platformTd.dataset.label = 'Platform';
    platformTd.textContent = `${peer.platform} · ${peer.browser}`;

    const statusTd = document.createElement('td');
    statusTd.dataset.label = 'Status';
    statusTd.textContent = formatStatus(link?.status || 'idle');
    if (link?.gaveUp || link?.incompatible) statusTd.classList.add('danger');
    if (link?.protocol) statusTd.title = `aria-drop protocol v${link.protocol}`;

    // Candidate path answers "is this actually peer-to-peer, or going through a
    // TURN relay?", which is the first thing you want when a transfer is slow.
    const pathTd = document.createElement('td');
    pathTd.dataset.label = 'Path';
    pathTd.textContent = link?.path || '—';
    if (link?.rttMs != null) pathTd.textContent += ` · ${Math.round(link.rttMs)} ms`;
    if (link?.path === 'relay') {
      pathTd.classList.add('danger');
      pathTd.title = 'Relayed through TURN: slower, and the relay sees traffic metadata.';
    } else if (link?.path) {
      pathTd.title = link.pathDetail || '';
    }

    const rateTd = document.createElement('td');
    rateTd.dataset.label = 'Rate';
    rateTd.textContent = formatRate(link);

    const bytesTd = document.createElement('td');
    bytesTd.dataset.label = 'Transferred';
    bytesTd.textContent = link ? `${formatBytes(link.bytesSent)} ↑ / ${formatBytes(link.bytesReceived)} ↓` : '—';

    const actionsTd = document.createElement('td');
    actionsTd.className = 'actions-col';
    const actions = document.createElement('div');
    actions.className = 'row-actions';
    for (const [label, mode] of [['Chat', 'chat'], ['Text', 'text'], ['File', 'file']]) {
      const btn = document.createElement('button');
      btn.type = 'button';
      btn.textContent = label;
      btn.dataset.focusKey = `peer:${peer.id}:${mode}`;
      btn.setAttribute('aria-label', `${label} with ${peer.name}`);
      if (mode !== 'chat') btn.className = 'ghost';
      btn.addEventListener('click', () => openSession(peer.id, mode));
      actions.append(btn);
    }
    // Retry is the manual escape hatch once the bounded backoff has given up.
    if (link?.gaveUp || link?.incompatible) {
      const retry = document.createElement('button');
      retry.type = 'button';
      retry.className = 'ghost';
      retry.textContent = 'Retry';
      retry.dataset.focusKey = `peer:${peer.id}:retry`;
      retry.setAttribute('aria-label', `Retry connecting to ${peer.name}`);
      retry.addEventListener('click', () => retryLink(peer.id));
      actions.append(retry);
    }
    actionsTd.append(actions);
    tr.append(nameTd, codeTd, platformTd, statusTd, pathTd, rateTd, bytesTd, actionsTd);
    peerRows.append(tr);
  }

  const offline = offlineDevicesToList();
  for (const record of offline) peerRows.append(renderOfflineRow(record));
  emptyPeers.classList.toggle('hidden', peers.length + offline.length > 0);
}

// Offline devices worth listing: seen within the window, and ones this browser
// has actually dealt with — a remembered device or an open conversation. Not
// every stranger who was ever online on the server.
function offlineDevicesToList() {
  if (!relayEnabled()) return [];
  return [...state.deviceRecords.values()]
    .filter(record => isRecentlySeen(record.id))
    .filter(record => deviceTrust(record.id) || state.conversations.has(directConvId(record.id)))
    .sort((a, b) => b.lastSeen - a.lastSeen);
}

function renderOfflineRow(record) {
  const tr = document.createElement('tr');
  tr.className = 'offline';
  tr.dataset.dropTarget = record.id;
  tr.dataset.dropKind = 'direct';
  tr.title = 'Offline. Anything you send waits on the server for up to 24 hours.';

  const cell = (label, text) => {
    const td = document.createElement('td');
    td.dataset.label = label;
    td.textContent = text;
    return td;
  };

  const nameTd = document.createElement('td');
  nameTd.dataset.label = 'Device';
  const nameWrap = document.createElement('div');
  nameWrap.className = 'device-name';
  const pip = document.createElement('span');
  pip.className = 'presence-pip offline';
  const name = document.createElement('span');
  name.textContent = record.name || displayName(record.id);
  nameWrap.append(pip, name);
  nameTd.append(nameWrap);

  const statusTd = cell('Status', `Offline · seen ${formatAgo(record.lastSeen)}`);
  statusTd.classList.add('muted');

  const actionsTd = document.createElement('td');
  actionsTd.className = 'actions-col';
  const actions = document.createElement('div');
  actions.className = 'row-actions';
  for (const [label, mode] of [['Chat', 'chat'], ['Text', 'text'], ['File', 'file']]) {
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.textContent = label;
    btn.dataset.focusKey = `peer:${record.id}:${mode}`;
    btn.setAttribute('aria-label', `${label} with ${record.name || 'offline device'} (offline, via server)`);
    if (mode !== 'chat') btn.className = 'ghost';
    btn.addEventListener('click', () => openSession(record.id, mode));
    actions.append(btn);
  }
  actionsTd.append(actions);

  tr.append(
    nameTd,
    cell('Code', '—'),
    cell('Platform', `${record.platform || 'Unknown'} · ${record.browser || 'Browser'}`),
    statusTd,
    cell('Path', 'via server'),
    cell('Rate', '—'),
    cell('Transferred', '—'),
    actionsTd
  );
  return tr;
}

function renderRooms() {
  withPreservedFocus(renderRoomsNow);
}

function renderRoomsNow() {
  roomRows.textContent = '';
  const rooms = [...state.rooms.values()].sort((a, b) => a.createdAt - b.createdAt);
  emptyRooms.classList.toggle('hidden', rooms.length > 0);
  for (const room of rooms) {
    const joined = state.joinedRoomIds.has(room.id);
    const conv = state.conversations.get(roomConvId(room.id));
    if (conv) {
      conv.lastKnownName = room.name;
      conv.lastKnownCode = room.code;
    }
    const tr = document.createElement('tr');
    if (joined) {
      tr.dataset.dropTarget = room.id;
      tr.dataset.dropKind = 'room';
      tr.title = 'Drop a file here to send it to everyone in the room';
    }

    const nameTd = document.createElement('td');
    nameTd.dataset.label = 'Room';
    const nameWrap = document.createElement('div');
    nameWrap.className = 'device-name';
    const pip = document.createElement('span');
    pip.className = 'presence-pip';
    const name = document.createElement('span');
    name.textContent = room.name;
    nameWrap.append(pip, name);
    nameTd.append(nameWrap);

    const codeTd = document.createElement('td');
    codeTd.className = 'peer-code';
    codeTd.dataset.label = 'Code';
    codeTd.textContent = room.code;

    const membersTd = document.createElement('td');
    membersTd.dataset.label = 'Members';
    const away = room.away || [];
    membersTd.textContent = [
      ...room.members.map(m => m.name),
      ...away.map(m => `${m.name} (away)`)
    ].join(', ') || '—';

    // Away members keep their seat, so they count toward the size.
    const seats = room.members.length + away.length;
    const countTd = document.createElement('td');
    countTd.dataset.label = 'Size';
    countTd.textContent = `${seats} / ${room.maxMembers}`;

    const statusTd = document.createElement('td');
    statusTd.dataset.label = 'Links';
    if (!joined) {
      statusTd.textContent = 'Not joined';
    } else {
      const others = conv ? onlineMembers(conv) : [];
      const secured = others.filter(id => isSecure(state.links.get(id))).length;
      const base = room.transport === 'relay'
        ? 'Via server · large room'
        : others.length ? `${secured} / ${others.length} encrypted` : 'Waiting for members';
      const awayOthers = away.filter(m => m.id !== state.self?.id).length;
      statusTd.textContent = awayOthers ? `${base} · ${awayOthers} away` : base;
    }

    const actionsTd = document.createElement('td');
    actionsTd.className = 'actions-col';
    const actions = document.createElement('div');
    actions.className = 'row-actions';
    if (joined) {
      const open = document.createElement('button');
      open.type = 'button';
      open.textContent = 'Open';
      open.dataset.focusKey = `room:${room.id}:open`;
      open.setAttribute('aria-label', `Open room ${room.name}`);
      open.addEventListener('click', () => openRoom(room.id));
      const leave = document.createElement('button');
      leave.type = 'button';
      leave.className = 'ghost';
      leave.textContent = 'Leave';
      leave.dataset.focusKey = `room:${room.id}:leave`;
      leave.setAttribute('aria-label', `Leave room ${room.name}`);
      leave.addEventListener('click', () => leaveRoom(room.id));
      actions.append(open, leave);
    } else {
      const join = document.createElement('button');
      join.type = 'button';
      join.textContent = 'Join';
      join.dataset.focusKey = `room:${room.id}:join`;
      join.setAttribute('aria-label', `Join room ${room.name}`);
      join.disabled = room.members.length + (room.away || []).length >= room.maxMembers;
      join.addEventListener('click', () => wsSend({ type: 'join-room', roomId: room.id }));
      actions.append(join);
    }
    actionsTd.append(actions);
    tr.append(nameTd, codeTd, membersTd, countTd, statusTd, actionsTd);
    roomRows.append(tr);
  }
}

// Rebuilding the timeline is O(messages + files). Chunk progress arrives many
// times a second, so coalesce renders into one per frame — otherwise buttons
// inside an active transfer are destroyed faster than they can be clicked.
let sessionRenderQueued = false;
function renderSession() {
  if (sessionRenderQueued) return;
  sessionRenderQueued = true;
  setTimeout(() => {
    sessionRenderQueued = false;
    renderSessionNow();
  }, 16);
}

// Progress ticks touch only the bar, leaving the surrounding controls in place.
function updateFileProgress(conv, file) {
  if (state.activeConvId !== conv.id) return;
  const bar = timeline.querySelector(`.file-item[data-file-id="${CSS.escape(file.id)}"] .file-progress`);
  if (bar) bar.value = Number.isFinite(file.progress) ? file.progress : 0;
  else renderSession();
}

function renderSessionNow() {
  const conv = activeConversation();
  if (!conv) return;

  sessionTitle.textContent = conversationTitle(conv);
  sessionKind.textContent = conv.kind === 'room' ? 'ephemeral room' : 'ephemeral session';
  leaveRoomBtn.classList.toggle('hidden', conv.kind !== 'room');

  if (conv.kind === 'direct') {
    const peer = getPeer(conv.peerId);
    const offlineRecord = !state.peers.has(conv.peerId) ? state.deviceRecords.get(conv.peerId) : null;
    sessionMeta.textContent = offlineRecord
      ? `${peer.platform} · ${peer.browser} · offline, seen ${formatAgo(offlineRecord.lastSeen)}`
      : `${peer.platform} · ${peer.browser} · ${peer.code}`;
  } else {
    const room = state.rooms.get(conv.roomId);
    const away = room?.away?.length || 0;
    sessionMeta.textContent = room
      ? `${room.code} · ${room.members.length + away} of ${room.maxMembers} devices${away ? ` · ${away} away` : ''}`
      : 'This room is no longer advertised';
  }

  renderMembers(conv);

  const others = onlineMembers(conv);
  if (conv.kind === 'direct') {
    const link = state.links.get(conv.peerId);
    if (isSecure(link)) {
      secureState.textContent = `Encrypted · ${link.crypto.safety}`;
      secureState.title = `${trustLabel(link)}. This safety code is derived from both devices' long-lived keys and will not change.`;
      secureState.classList.add('ready');
      secureState.classList.toggle('unverified', link.trust?.known === false);
    } else if (link?.status === 'untrusted') {
      secureState.textContent = 'Identity refused';
      secureState.classList.remove('ready');
    } else if (!state.peers.has(conv.peerId)) {
      // Nothing to connect to; say what will actually happen to a message.
      secureState.textContent = isRecentlySeen(conv.peerId)
        ? 'Offline · messages wait on the server'
        : 'Offline';
      secureState.title = 'Sealed to this device and left on the server for up to 24 hours.';
      secureState.classList.remove('ready');
    } else {
      secureState.textContent = link?.dc?.readyState === 'open' ? 'Verifying device identity…' : 'Connecting…';
      secureState.classList.remove('ready');
    }
  } else if (isRelayRoom(conv)) {
    // No links at all in a large room: everything is sealed to each member and
    // signed by the sender, then goes through the server.
    secureState.textContent = 'Large room · sealed to each member via server';
    secureState.title = `Past ${state.config.roomMeshMax || 6} devices a room stops opening direct connections between every pair and uses the server relay instead.`;
    secureState.classList.add('ready');
  } else {
    const secured = others.filter(id => isSecure(state.links.get(id))).length;
    secureState.textContent = others.length
      ? `${secured} of ${others.length} links encrypted`
      : 'Waiting for other members';
    secureState.classList.toggle('ready', others.length > 0 && secured === others.length);
  }

  timeline.textContent = '';
  const items = [];
  for (const message of conv.messages.values()) items.push({ kind: 'message', at: message.at, value: message });
  for (const file of conv.files.values()) items.push({ kind: 'file', at: file.addedAt || 0, value: file });
  items.sort((a, b) => a.at - b.at);

  if (!items.length) {
    const empty = document.createElement('div');
    empty.className = 'timeline-empty';
    empty.textContent = 'Nothing here yet. Messages and files live only in participant browser memory.';
    timeline.append(empty);
  }

  for (const item of items) {
    if (item.kind === 'message') renderMessage(conv, item.value);
    else renderFile(conv, item.value);
  }
  timeline.scrollTop = timeline.scrollHeight;
}

function renderMembers(conv) {
  sessionMembers.textContent = '';
  if (conv.kind !== 'room') {
    sessionMembers.classList.add('hidden');
    return;
  }
  sessionMembers.classList.remove('hidden');
  const room = state.rooms.get(conv.roomId);
  for (const member of room?.members || []) {
    const chip = document.createElement('span');
    chip.className = 'member-chip';
    if (member.id === state.self?.id) {
      chip.classList.add('self');
      chip.textContent = `${member.name} (you)`;
    } else if (isRelayRoom(conv)) {
      chip.textContent = member.name;
      chip.classList.add('secure');
      chip.title = 'Large room: messages to this member are sealed to its key and sent via the server.';
    } else {
      const link = state.links.get(member.id);
      chip.textContent = member.name;
      if (isSecure(link)) {
        chip.classList.add('secure');
        if (link.trust?.known === false) chip.classList.add('unverified');
        chip.title = `${trustLabel(link)} · safety code ${link.crypto.safety} · protocol v${link.protocol}`;
      } else if (link?.gaveUp || link?.incompatible) {
        chip.classList.add('broken');
        chip.title = `${formatStatus(link.status)} — use Retry in the device table`;
      } else {
        chip.title = formatStatus(link?.status || 'idle');
      }
    }
    sessionMembers.append(chip);
  }
  for (const member of room?.away || []) {
    if (member.id === state.self?.id) continue;
    const chip = document.createElement('span');
    chip.className = 'member-chip away';
    chip.textContent = `${member.name} · away`;
    chip.title = `Dropped off ${formatAgo(member.awaySince)}. Messages and files are left on the server for it until it rejoins, for up to 24 hours.`;
    sessionMembers.append(chip);
  }
}

function renderMessage(conv, message) {
  const node = $('#messageTemplate').content.firstElementChild.cloneNode(true);
  const mine = message.from === state.self?.id;
  if (mine) node.classList.add('self');
  const author = node.querySelector('.message-author');
  if (conv.kind === 'room' && !mine) {
    author.textContent = message.fromName || displayName(message.from);
    // History relayed by a third peer is not proof of who wrote it, so mark it
    // rather than presenting it with the same confidence as a live message.
    if (!message.verifiedAuthor) {
      author.classList.add('unverified');
      author.textContent += ' · relayed';
      author.title = `Recovered from ${displayName(message.relayedBy)}; authorship is not verified.`;
    }
  } else {
    author.remove();
  }
  appendLinkifiedText(node.querySelector('.message-bubble'), message.text);
  const time = new Date(message.at).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });
  // As with files, say when a message took the server path.
  node.querySelector('.message-time').textContent = message.via === 'relay' ? `${time} · via server` : time;
  timeline.append(node);
}

function appendLinkifiedText(container, text) {
  const regex = /https?:\/\/[^\s]+/gi;
  let last = 0;
  for (const match of text.matchAll(regex)) {
    const index = match.index ?? 0;
    if (index > last) container.append(document.createTextNode(text.slice(last, index)));
    const a = document.createElement('a');
    a.href = match[0];
    a.textContent = match[0];
    a.target = '_blank';
    a.rel = 'noopener noreferrer';
    container.append(a);
    last = index + match[0].length;
  }
  if (last < text.length) container.append(document.createTextNode(text.slice(last)));
}

function renderFile(conv, file) {
  const node = $('#fileTemplate').content.firstElementChild.cloneNode(true);
  node.dataset.fileId = file.id;
  node.querySelector('.file-name').textContent = file.name;
  const owner = file.from === state.self?.id ? 'sent by you' : `from ${file.fromName || displayName(file.from)}`;

  const details = [formatBytes(file.size), owner];
  // Say which path a file took: it is the first thing to check when one path
  // works on a network and the other does not.
  if (file.via === 'relay') details.push('via server');
  if (file.direction === 'received' && file.offer === 'pending') details.push('wants to send you this');
  if (file.direction === 'received' && file.offer === 'declined') details.push('declined');
  const waitingOn = file.direction === 'sent' ? (file.awaitingConsent || []).length : 0;
  if (waitingOn) details.push(`waiting for ${waitingOn === 1 ? displayName(file.awaitingConsent[0]) : `${waitingOn} devices`} to accept`);
  if (file.hashing) details.push('hashing…');
  else if (file.verifying) details.push('verifying…');
  else if (file.corrupt) details.push('SHA-256 mismatch');
  else if (file.verified) details.push(`SHA-256 ✓ ${file.sha256.slice(0, 12)}`);
  else if (file.sha256) details.push(`SHA-256 ${file.sha256.slice(0, 12)}`);
  const metaLine = node.querySelector('.file-meta');
  metaLine.textContent = details.join(' · ');
  metaLine.classList.toggle('danger', Boolean(file.corrupt));
  if (file.sha256) metaLine.title = `SHA-256 ${file.sha256}`;

  const progress = node.querySelector('.file-progress');
  progress.value = Number.isFinite(file.progress) ? file.progress : (file.blob ? 1 : 0);

  const actions = node.querySelector('.file-actions');
  const btn = node.querySelector('.file-download');
  const holders = mergeHolders(file.holders).filter(id => id !== state.self?.id && state.peers.has(id));
  const partial = Array.isArray(file.chunks) && countReceived(file.chunks) > 0;
  const relayBusy = ['encrypting', 'uploading', 'downloading'].includes(file.relayStage);
  const inFlight = Boolean(file.transferId) || file.hashing || file.verifying || relayBusy;

  // An offer waiting on the user comes first: nothing has been received yet.
  if (file.direction === 'received' && file.offer === 'pending') {
    btn.textContent = 'Accept';
    btn.classList.remove('ghost');
    btn.setAttribute('aria-label', `Accept ${file.name}`);
    btn.addEventListener('click', () => acceptOffer(conv, file));
    const decline = document.createElement('button');
    decline.type = 'button';
    decline.className = 'ghost file-decline';
    decline.textContent = 'Decline';
    decline.setAttribute('aria-label', `Decline ${file.name}`);
    decline.addEventListener('click', () => declineOffer(conv, file));
    actions.append(decline);
  } else if (file.direction === 'received' && file.offer === 'declined') {
    btn.textContent = 'Declined';
    btn.disabled = true;
  } else if (inFlight) {
    // An in-flight transfer takes precedence over the Save button, so a sender
    // can cancel its own upload while the blob it is reading is already local.
    btn.textContent = file.hashing ? 'Hashing…'
      : file.verifying ? 'Verifying…'
        : file.relayStage === 'encrypting' ? 'Encrypting…'
          : file.relayStage === 'uploading' ? 'Uploading…'
            : file.relayStage === 'downloading' ? 'Downloading…'
              : file.direction === 'sent' ? 'Sending…' : 'Receiving…';
    btn.disabled = true;
    if (file.transferId) {
      const cancel = document.createElement('button');
      cancel.type = 'button';
      cancel.className = 'ghost file-cancel';
      cancel.textContent = 'Cancel';
      cancel.addEventListener('click', () => cancelTransfer(conv, file));
      actions.append(cancel);
    }
  } else if (file.blob) {
    btn.textContent = 'Save';
    btn.addEventListener('click', () => downloadFile(file));
  } else if (file.via === 'relay' && file.relayStage === 'failed' && file.relayKey) {
    // The server keeps it until it is taken or 24h pass, so it can be retried.
    btn.textContent = 'Retry download';
    btn.addEventListener('click', () => downloadRelayed(conv, file));
  } else if (holders.length) {
    btn.textContent = file.corrupt ? 'Retry' : partial ? 'Resume' : 'Request';
    btn.title = partial && !file.corrupt
      ? `${countReceived(file.chunks)} of ${file.chunks.length} chunks already held`
      : '';
    btn.addEventListener('click', () => requestFile(conv, file).catch(err => toast(err.message)));
  } else {
    btn.textContent = 'Gone';
    btn.disabled = true;
    btn.title = 'No online device is still holding these bytes.';
  }
  timeline.append(node);
}

function formatBytes(value) {
  const bytes = Number(value) || 0;
  if (bytes < 1024) return `${bytes} B`;
  const units = ['KB', 'MB', 'GB', 'TB'];
  let size = bytes / 1024;
  let i = 0;
  while (size >= 1024 && i < units.length - 1) { size /= 1024; i++; }
  return `${size >= 10 ? size.toFixed(1) : size.toFixed(2)} ${units[i]}`;
}

/**
 * @param {string} message
 * @param {{ label: string, run: () => void }} [action] optional button, e.g. "Open"
 */
function toast(message, action) {
  const el = document.createElement('div');
  el.className = 'toast';
  const text = document.createElement('span');
  text.textContent = message;
  el.append(text);
  if (action) {
    const button = document.createElement('button');
    button.type = 'button';
    button.className = 'ghost toast-action';
    button.textContent = action.label;
    button.addEventListener('click', () => {
      el.remove();
      action.run();
    });
    el.append(button);
  }
  toastRegion.append(el);
  // Longer when there is something to click, so it can actually be reached.
  setTimeout(() => el.remove(), action ? 9000 : 3500);
}

// srflx/prflx both mean a NAT-reflexive address; relay means TURN is carrying
// the traffic, which is the case worth surfacing loudly.
const CANDIDATE_LABEL = { host: 'host', srflx: 'srflx', prflx: 'prflx', relay: 'relay' };

async function refreshStats() {
  for (const link of state.links.values()) {
    if (!link.pc || link.pc.connectionState !== 'connected') continue;
    try {
      const stats = await link.pc.getStats();
      let sent = 0;
      let received = 0;
      let rtt = null;
      /** @type {any} */
      let pair = null;
      /** @type {Map<string, any>} */
      const byId = new Map();

      stats.forEach(report => {
        byId.set(report.id, report);
        if (report.type === 'data-channel') {
          sent += report.bytesSent || 0;
          received += report.bytesReceived || 0;
        }
        if (report.type === 'candidate-pair' && report.state === 'succeeded' && (report.nominated || report.selected)) {
          pair = report;
          if (Number.isFinite(report.currentRoundTripTime)) rtt = report.currentRoundTripTime * 1000;
        }
      });

      if (pair) {
        const local = byId.get(pair.localCandidateId);
        const remote = byId.get(pair.remoteCandidateId);
        const localType = CANDIDATE_LABEL[local?.candidateType] || '?';
        const remoteType = CANDIDATE_LABEL[remote?.candidateType] || '?';
        link.path = localType === 'relay' || remoteType === 'relay' ? 'relay' : `${localType}↔${remoteType}`;
        link.pathDetail = `local ${localType} (${local?.protocol || '?'}) ↔ remote ${remoteType} (${remote?.protocol || '?'})`;
      }

      // Throughput from the delta since the previous sample, not a lifetime
      // average, so it reflects what a transfer is doing right now.
      const now = performance.now();
      if (link.statsAt) {
        const seconds = (now - link.statsAt) / 1000;
        if (seconds > 0.2) {
          link.sendRate = Math.max(0, (sent - link.bytesSent) / seconds);
          link.receiveRate = Math.max(0, (received - link.bytesReceived) / seconds);
        }
      }
      link.statsAt = now;
      link.bytesSent = sent;
      link.bytesReceived = received;
      link.rttMs = rtt;
    } catch {}
  }
  renderPeers();
  renderRooms();
}

function formatRate(link) {
  if (!link) return '—';
  const up = link.sendRate || 0;
  const down = link.receiveRate || 0;
  // Below a kilobyte a second is idle chatter, not a transfer.
  if (up < 1024 && down < 1024) return 'idle';
  const parts = [];
  if (up >= 1024) parts.push(`${formatBytes(up)}/s ↑`);
  if (down >= 1024) parts.push(`${formatBytes(down)}/s ↓`);
  return parts.join(' / ');
}

function resolveCode(code) {
  const requestId = crypto.randomUUID();
  return new Promise((resolve) => {
    const timer = setTimeout(() => {
      state.pendingCodeRequests.delete(requestId);
      resolve(null);
    }, 4000);
    state.pendingCodeRequests.set(requestId, peer => {
      clearTimeout(timer);
      resolve(peer);
    });
    wsSend({ type: 'resolve-code', requestId, code });
  });
}

/* ---------- events ---------- */

$('#codeForm').addEventListener('submit', async (event) => {
  event.preventDefault();
  const code = $('#codeInput').value.trim().toUpperCase();
  if (!code) return;
  codeFeedback.textContent = 'Looking up device…';
  const peer = await resolveCode(code);
  if (!peer || peer.id === state.self?.id) {
    codeFeedback.textContent = 'No other active device found with that code.';
    return;
  }
  state.peers.set(peer.id, peer);
  codeFeedback.textContent = `Found ${peer.name}`;
  renderPeers();
  openSession(peer.id);
});

$('#createRoomForm').addEventListener('submit', (event) => {
  event.preventDefault();
  const input = $('#roomNameInput');
  const name = input.value.trim() || `${state.self?.name || 'New'} room`;
  roomFeedback.textContent = 'Creating room…';
  wsSend({ type: 'create-room', name });
  input.value = '';
});

$('#joinRoomForm').addEventListener('submit', (event) => {
  event.preventDefault();
  const input = $('#roomCodeInput');
  const code = input.value.trim().toUpperCase();
  if (!code) return;
  roomFeedback.textContent = 'Joining room…';
  wsSend({ type: 'join-room', code });
  input.value = '';
});

messageForm.addEventListener('submit', async (event) => {
  event.preventDefault();
  const conv = activeConversation();
  const text = messageInput.value;
  if (!conv || !text.trim()) return;
  messageInput.value = '';
  try { await sendChat(conv, text); }
  catch (err) { toast(err.message || 'Could not send message'); }
});

messageInput.addEventListener('keydown', (event) => {
  if (event.key === 'Enter' && !event.shiftKey) {
    event.preventDefault();
    messageForm.requestSubmit();
  }
});

pickFileBtn.addEventListener('click', () => fileInput.click());
fileInput.addEventListener('change', async () => {
  const conv = activeConversation();
  if (!conv || !fileInput.files?.length) return;
  try { await sendFiles(conv, [...fileInput.files]); }
  catch (err) { toast(err.message || 'File transfer failed'); }
  finally { fileInput.value = ''; }
});

$('#closeSession').addEventListener('click', closeSessionPanel);

leaveRoomBtn.addEventListener('click', () => {
  const conv = activeConversation();
  if (conv?.kind === 'room') leaveRoom(conv.roomId);
});

$('#copyCodeBtn').addEventListener('click', async () => {
  const conv = activeConversation();
  if (!conv) return;
  const code = conv.kind === 'room' ? state.rooms.get(conv.roomId)?.code : getPeer(conv.peerId).code;
  if (!code) return;
  await navigator.clipboard.writeText(code).catch(() => {});
  toast(conv.kind === 'room' ? 'Room code copied' : 'Peer code copied');
});

selfCode.addEventListener('click', async () => {
  if (!state.self?.code) return;
  await navigator.clipboard.writeText(state.self.code).catch(() => {});
  toast('Your device code copied');
});

$('#renameBtn').addEventListener('click', openRenameDialog);

function setupSettings() {
  const dialog = $('#settingsDialog');
  const radios = [...dialog.querySelectorAll('input[name="incomingPolicy"]')];
  try {
    const stored = localStorage.getItem('aria-drop-incoming');
    if (INCOMING_POLICIES.includes(stored)) state.incomingPolicy = stored;
  } catch {}
  for (const radio of radios) {
    radio.checked = radio.value === state.incomingPolicy;
    radio.addEventListener('change', () => {
      if (!radio.checked) return;
      state.incomingPolicy = radio.value;
      try { localStorage.setItem('aria-drop-incoming', radio.value); } catch {}
    });
  }
  $('#settingsBtn').addEventListener('click', () => {
    openDialog(dialog, radios.find(radio => radio.checked) || radios[0]);
  });
}

function setupRelayToggle() {
  const toggle = $('#relayToggle');
  const input = $('#forceRelayInput');
  // Only offered when the server actually runs the relay.
  toggle.classList.toggle('hidden', !relayEnabled());
  try { state.forceRelay = localStorage.getItem('aria-drop-force-relay') === '1'; } catch {}
  input.checked = state.forceRelay;
  input.addEventListener('change', () => {
    state.forceRelay = input.checked;
    try { localStorage.setItem('aria-drop-force-relay', input.checked ? '1' : '0'); } catch {}
  });
}

$('#devicesBtn').addEventListener('click', () => {
  renderKnownDevices();
  openDialog(devicesDialog, devicesDialog.querySelector('button'));
});

// Escape closes the session panel, matching the dialogs.
document.addEventListener('keydown', event => {
  if (event.key !== 'Escape') return;
  if (document.querySelector('dialog[open]')) return; // the dialog handles its own
  if (state.activeConvId) {
    event.preventDefault();
    closeSessionPanel();
  }
});

$('#refreshBtn').addEventListener('click', () => {
  wsSend({ type: 'presence-request' });
  wsSend({ type: 'rooms-request' });
});

window.addEventListener('beforeunload', () => {
  for (const link of state.links.values()) {
    try { link.dc?.close(); } catch {}
    try { link.pc?.close(); } catch {}
  }
});

/* ---------- theme ---------- */

const THEMES = ['system', 'light', 'dark'];
const THEME_GLYPH = { system: '◐', light: '☀', dark: '☾' };
const THEME_LABEL = {
  system: 'Theme: follow system',
  light: 'Theme: light',
  dark: 'Theme: dark'
};

function applyTheme(theme) {
  const chosen = THEMES.includes(theme) ? theme : 'system';
  if (chosen === 'system') document.documentElement.removeAttribute('data-theme');
  else document.documentElement.setAttribute('data-theme', chosen);
  themeIcon.textContent = THEME_GLYPH[chosen];
  themeBtn.setAttribute('aria-label', THEME_LABEL[chosen]);
  themeBtn.title = `${THEME_LABEL[chosen]} (click to change)`;
  try { localStorage.setItem('aria-drop-theme', chosen); } catch {}
  state.theme = chosen;
}

function setupTheme() {
  let stored = 'system';
  try { stored = localStorage.getItem('aria-drop-theme') || 'system'; } catch {}
  applyTheme(stored);
  themeBtn.addEventListener('click', () => {
    applyTheme(THEMES[(THEMES.indexOf(state.theme) + 1) % THEMES.length]);
  });
}

/* ---------- dialogs ---------- */

// <dialog> gives a real modal with focus trapping and Escape for free; this only
// has to remember where focus came from and put it back.
function openDialog(dialog, focusTarget) {
  const returnTo = document.activeElement;
  dialog.addEventListener('close', () => {
    if (returnTo instanceof HTMLElement && document.contains(returnTo)) returnTo.focus();
  }, { once: true });
  dialog.showModal();
  if (focusTarget instanceof HTMLElement) focusTarget.focus();
}

function openRenameDialog() {
  renameInput.value = deviceName();
  openDialog(renameDialog, renameInput);
  renameInput.select();
}

renameDialog.addEventListener('close', () => {
  if (renameDialog.returnValue !== 'save') return;
  const name = renameInput.value.trim().slice(0, 64);
  if (!name) return;
  localStorage.setItem('aria-drop-device-name', name);
  if (state.self) state.self.name = name;
  document.title = `${name} · aria-drop`;
  wsSend({ type: 'rename', name });
  toast(`This device is now "${name}"`);
});

function renderKnownDevices() {
  knownDeviceList.textContent = '';
  const devices = knownDevices()
    .sort((a, b) => (b[1].lastSeen || 0) - (a[1].lastSeen || 0));

  if (!devices.length) {
    const empty = document.createElement('p');
    empty.className = 'device-empty';
    empty.textContent = 'No devices remembered yet. A device is remembered the first time you connect to it.';
    knownDeviceList.append(empty);
    return;
  }

  for (const [fingerprint, record] of devices) {
    const row = document.createElement('div');
    row.className = 'device-row';

    const main = document.createElement('div');
    main.className = 'device-row-main';
    const name = document.createElement('strong');
    name.textContent = record.name || 'Unnamed device';
    const meta = document.createElement('div');
    meta.className = 'muted';
    meta.style.fontSize = '.74rem';
    const online = state.peers.has(fingerprint);
    meta.textContent = `${online ? 'Online now' : 'Not connected'} · first seen ${new Date(record.firstSeen).toLocaleDateString()}`;
    const fp = document.createElement('div');
    fp.className = 'device-fingerprint';
    fp.textContent = fingerprint;
    main.append(name, meta, fp);

    const forget = document.createElement('button');
    forget.type = 'button';
    forget.className = 'ghost';
    forget.textContent = 'Forget';
    forget.addEventListener('click', () => {
      forgetDevice(fingerprint);
      const link = state.links.get(fingerprint);
      if (link) link.trust = { known: false, firstSeen: Date.now(), previousName: record.name };
      renderKnownDevices();
      renderPeers();
      renderSession();
      toast(`Forgot ${record.name || 'device'}. It will show as new next time.`);
    });

    row.append(main, forget);
    knownDeviceList.append(row);
  }
}

// Used by paste-to-send and drag-and-drop when no session is open: pick a target
// rather than guessing one.
function pickTarget({ title, hint }) {
  return new Promise(resolve => {
    pickTargetTitle.textContent = title;
    pickTargetHint.textContent = hint;
    pickTargetList.textContent = '';

    /** @type {Array<{label: string, sub: string, open: () => any}>} */
    const targets = [];
    for (const peer of [...state.peers.values()].sort((a, b) => a.name.localeCompare(b.name))) {
      targets.push({
        label: peer.name,
        sub: `${peer.platform} · ${peer.browser}`,
        open: () => ensureConversation(directConvId(peer.id), 'direct', peer.id)
      });
    }
    // Recently seen devices that have gone offline can still be sent to: the
    // server holds the sealed copy until they come back.
    for (const record of offlineDevicesToList()) {
      if (state.peers.has(record.id)) continue;
      targets.push({
        label: record.name || displayName(record.id),
        sub: `Offline · seen ${formatAgo(record.lastSeen)} · waits on the server`,
        open: () => ensureConversation(directConvId(record.id), 'direct', record.id)
      });
    }
    for (const roomId of state.joinedRoomIds) {
      const room = state.rooms.get(roomId);
      if (!room) continue;
      targets.push({
        label: room.name,
        sub: `Room · ${room.members.length} of ${room.maxMembers} devices`,
        open: () => ensureConversation(roomConvId(roomId), 'room', roomId)
      });
    }

    if (!targets.length) {
      const empty = document.createElement('p');
      empty.className = 'device-empty';
      empty.textContent = 'Nothing to send to yet — no other devices are online and you have not joined a room.';
      pickTargetList.append(empty);
    }

    let settled = false;
    for (const target of targets) {
      const button = document.createElement('button');
      button.type = 'button';
      button.className = 'device-row target';
      const main = document.createElement('div');
      main.className = 'device-row-main';
      const strong = document.createElement('strong');
      strong.textContent = target.label;
      const sub = document.createElement('div');
      sub.className = 'muted';
      sub.style.fontSize = '.74rem';
      sub.textContent = target.sub;
      main.append(strong, sub);
      button.append(main);
      button.addEventListener('click', () => {
        settled = true;
        const conv = target.open();
        pickTargetDialog.close('picked');
        resolve(conv);
      });
      pickTargetList.append(button);
    }

    pickTargetDialog.addEventListener('close', () => {
      if (!settled) resolve(null);
    }, { once: true });
    openDialog(pickTargetDialog, pickTargetList.querySelector('button'));
  });
}

/* ---------- drag and drop, paste ---------- */

async function sendFilesTo(conv, files) {
  if (!conv || !files.length) return;
  openConversation(conv.id, conv.kind, conv.kind === 'room' ? conv.roomId : conv.peerId);
  try {
    await sendFiles(conv, files);
  } catch (err) {
    toast(err.message || 'File transfer failed');
  }
}

// One document-level pair of handlers, using a counter because dragenter and
// dragleave fire for every child element the pointer crosses.
function setupDragAndDrop() {
  let depth = 0;

  const rowFor = (target) => {
    if (!(target instanceof Element)) return null;
    const row = target.closest('#peerRows tr, #roomRows tr');
    return row instanceof HTMLElement ? row : null;
  };

  const clearHighlights = () => {
    for (const row of document.querySelectorAll('tr.drop-target')) row.classList.remove('drop-target');
    sessionPanel.classList.remove('dragging');
  };

  const carriesFiles = (event) => [...(event.dataTransfer?.types || [])].includes('Files');

  document.addEventListener('dragenter', event => {
    if (!carriesFiles(event)) return;
    event.preventDefault();
    depth++;
  });

  document.addEventListener('dragover', event => {
    if (!carriesFiles(event)) return;
    event.preventDefault();
    if (event.dataTransfer) event.dataTransfer.dropEffect = 'copy';
    clearHighlights();
    const row = rowFor(event.target);
    if (row?.dataset.dropTarget) row.classList.add('drop-target');
    else if (event.target instanceof Element && sessionPanel.contains(event.target) && state.activeConvId) {
      sessionPanel.classList.add('dragging');
    }
  });

  document.addEventListener('dragleave', event => {
    if (!carriesFiles(event)) return;
    depth = Math.max(0, depth - 1);
    if (depth === 0) clearHighlights();
  });

  document.addEventListener('drop', async event => {
    if (!carriesFiles(event)) return;
    event.preventDefault();
    depth = 0;
    clearHighlights();

    const files = [...(event.dataTransfer?.files || [])];
    if (!files.length) return;

    const row = rowFor(event.target);
    if (row?.dataset.dropTarget) {
      const conv = row.dataset.dropKind === 'room'
        ? ensureConversation(roomConvId(row.dataset.dropTarget), 'room', row.dataset.dropTarget)
        : ensureConversation(directConvId(row.dataset.dropTarget), 'direct', row.dataset.dropTarget);
      await sendFilesTo(conv, files);
      return;
    }

    if (state.activeConvId && event.target instanceof Element && sessionPanel.contains(event.target)) {
      await sendFilesTo(activeConversation(), files);
      return;
    }

    const conv = await pickTarget({
      title: files.length === 1 ? `Send "${files[0].name}" to…` : `Send ${files.length} files to…`,
      hint: 'Dropped on the page, so pick where it should go.'
    });
    await sendFilesTo(conv, files);
  });

  // A drop that lands outside a handled zone must not navigate the page away.
  window.addEventListener('dragover', event => { if (carriesFiles(event)) event.preventDefault(); });
  window.addEventListener('drop', event => { if (carriesFiles(event)) event.preventDefault(); });
}

function setupPasteToSend() {
  document.addEventListener('paste', async event => {
    const target = event.target;
    // Let a paste into a text field behave normally.
    if (target instanceof HTMLInputElement || target instanceof HTMLTextAreaElement) return;
    if (!event.clipboardData) return;

    const files = [...event.clipboardData.files];
    const text = event.clipboardData.getData('text/plain').trim();
    if (!files.length && !text) return;
    event.preventDefault();

    let conv = activeConversation();
    if (!conv) {
      conv = await pickTarget({
        title: files.length ? 'Send pasted file to…' : 'Send pasted text to…',
        hint: files.length
          ? `${files.length} file${files.length === 1 ? '' : 's'} from the clipboard.`
          : text.length > 80 ? `${text.slice(0, 80)}…` : text
      });
      if (!conv) return;
    }

    if (files.length) {
      await sendFilesTo(conv, files);
      return;
    }

    openConversation(conv.id, conv.kind, conv.kind === 'room' ? conv.roomId : conv.peerId, 'text');
    messageInput.value = text.slice(0, CAPS.messageChars);
    messageInput.focus();
    toast('Pasted text is ready — press Enter to send.');
  });
}

/* ---------- installed-app and mobile behaviour ---------- */

// Phones suspend background tabs aggressively: on iOS a lock screen or app
// switch tears down the WebSocket and every RTCPeerConnection without firing
// anything useful. On return to the foreground, check and rebuild rather than
// waiting for a timer that was itself suspended.
function handleForeground() {
  if (document.visibilityState !== 'visible') return;
  if (!state.identity) return;
  if (!state.ws || state.ws.readyState === WebSocket.CLOSED || state.ws.readyState === WebSocket.CLOSING) {
    state.wsBackoff = 500;
    connectWebSocket();
    return;
  }
  for (const peerId of neededPeerIds()) {
    const link = state.links.get(peerId);
    if (link?.incompatible) continue;
    if (!link?.pc || ['closed', 'failed', 'disconnected'].includes(link.pc.connectionState)) retryLink(peerId);
  }
}

document.addEventListener('visibilitychange', handleForeground);
window.addEventListener('pageshow', handleForeground);
window.addEventListener('online', handleForeground);

// A locked screen also stops transfers. Hold a screen wake lock only while
// something is actually in flight, and release it as soon as nothing is.
let wakeLock = null;
async function updateWakeLock() {
  if (!('wakeLock' in navigator)) return;
  let busy = state.activeSends.size > 0;
  if (!busy) {
    for (const conv of state.conversations.values()) {
      for (const file of conv.files.values()) {
        if (file.transferId || file.hashing || ['encrypting', 'uploading', 'downloading'].includes(file.relayStage)) {
          busy = true;
          break;
        }
      }
      if (busy) break;
    }
  }
  try {
    if (busy && !wakeLock) {
      wakeLock = await navigator.wakeLock.request('screen');
      wakeLock.addEventListener('release', () => { wakeLock = null; });
    } else if (!busy && wakeLock) {
      await wakeLock.release();
      wakeLock = null;
    }
  } catch {
    wakeLock = null; // Denied, or the document lost visibility.
  }
}

function setupInstallPrompt() {
  const installBtn = $('#installBtn');
  let deferred = null;

  window.addEventListener('beforeinstallprompt', event => {
    // Chrome/Edge/Android: take over the prompt so it can be offered in context.
    event.preventDefault();
    deferred = event;
    installBtn.classList.remove('hidden');
  });

  installBtn.addEventListener('click', async () => {
    if (!deferred) return;
    installBtn.disabled = true;
    deferred.prompt();
    await deferred.userChoice.catch(() => {});
    deferred = null;
    installBtn.classList.add('hidden');
    installBtn.disabled = false;
  });

  window.addEventListener('appinstalled', () => {
    deferred = null;
    installBtn.classList.add('hidden');
  });

  // iOS has no install prompt API; Add to Home Screen is manual, so say so once
  // instead of showing a button that cannot work.
  // navigator.standalone is iOS-only and not in the standard Navigator type.
  const iosStandalone = /** @type {{ standalone?: boolean }} */ (navigator).standalone === true;
  const standalone = matchMedia('(display-mode: standalone)').matches || iosStandalone;
  if (!standalone && /iPhone|iPad|iPod/i.test(navigator.userAgent)) {
    installBtn.classList.remove('hidden');
    installBtn.textContent = 'Install';
    installBtn.addEventListener('click', () => {
      toast('In Safari, tap Share then "Add to Home Screen" to install aria-drop.');
    });
  }
}

async function setupServiceWorker() {
  if (!('serviceWorker' in navigator)) return;
  let registration;
  try {
    registration = await navigator.serviceWorker.register('/sw.js', { updateViaCache: 'none' });
  } catch {
    return;
  }

  const banner = $('#updateBanner');
  const offerUpdate = (worker) => {
    if (!worker) return;
    banner.classList.remove('hidden');
    $('#reloadBtn').onclick = () => {
      // Reload only when the user says so: an update mid-transfer would drop it.
      worker.postMessage('skip-waiting');
      navigator.serviceWorker.addEventListener('controllerchange', () => location.reload(), { once: true });
    };
  };

  if (registration.waiting) offerUpdate(registration.waiting);
  registration.addEventListener('updatefound', () => {
    const installing = registration.installing;
    installing?.addEventListener('statechange', () => {
      if (installing.state === 'installed' && navigator.serviceWorker.controller) offerUpdate(installing);
    });
  });
}

/* ---------- share target ---------- */

// Another app's share sheet POSTs to /share. The service worker keeps the files
// in memory and redirects here with ?shared=<id>; this collects them.
/** @returns {Promise<{title: string, text: string, url: string, files: File[]} | null>} */
async function takeSharedBundle(id) {
  if (!('serviceWorker' in navigator)) return null;
  const ready = navigator.serviceWorker.ready.then(registration =>
    navigator.serviceWorker.controller || registration.active);
  const worker = await Promise.race([ready, new Promise(r => setTimeout(() => r(null), 5000))]);
  if (!worker) return null;
  return new Promise(resolve => {
    const channel = new MessageChannel();
    const timer = setTimeout(() => resolve(null), 5000);
    channel.port1.onmessage = event => {
      clearTimeout(timer);
      resolve(event.data || null);
    };
    worker.postMessage({ type: 'take-share', id }, [channel.port2]);
  });
}

/** @type {File[]} */
let sharedFiles = [];

function renderShareBanner() {
  const banner = $('#shareBanner');
  if (!sharedFiles.length) {
    banner.classList.add('hidden');
    return;
  }
  const label = sharedFiles.length === 1
    ? `${sharedFiles[0].name} is ready to send`
    : `${sharedFiles.length} shared files are ready to send`;
  $('#shareBannerText').textContent = label;
  banner.classList.remove('hidden');
}

async function sendSharedFiles() {
  if (!sharedFiles.length) return;
  const files = sharedFiles;
  const conv = await pickTarget({
    title: files.length === 1 ? `Send ${files[0].name} to…` : `Send ${files.length} files to…`,
    hint: 'Offline devices get it through the server, sealed to them, when they next connect.'
  });
  if (!conv) return;
  sharedFiles = [];
  renderShareBanner();
  await sendFilesTo(conv, files);
}

function setupShareBanner() {
  $('#shareSendBtn').addEventListener('click', () => { sendSharedFiles(); });
  $('#shareDiscardBtn').addEventListener('click', () => {
    sharedFiles = [];
    renderShareBanner();
  });
}

// Text and links go into the composer; files wait behind a banner until a
// target is picked, since at load there is nobody listed to send them to yet.
async function consumeShareTarget() {
  const params = new URLSearchParams(location.search);
  const id = params.get('shared');
  // share_* is the older GET form of the share target; kept so an install made
  // before the manifest changed still works.
  let text = [params.get('share_title'), params.get('share_text'), params.get('share_url')]
    .filter(Boolean)
    .join('\n');
  if (!id && !text) return;
  history.replaceState(null, '', location.pathname);

  if (id === 'failed') {
    toast('That share did not reach aria-drop. Open the app once, then share again.');
    return;
  }
  if (id) {
    const bundle = await takeSharedBundle(id);
    if (!bundle) {
      toast('That share expired before it could be picked up. Please share it again.');
      return;
    }
    // Android puts a shared link in `text` and often repeats it in `url`.
    text = [bundle.title, bundle.text, bundle.url && !bundle.text?.includes(bundle.url) ? bundle.url : '']
      .filter(Boolean)
      .join('\n');
    sharedFiles = bundle.files.filter(file => file instanceof File);
    renderShareBanner();
  }

  text = text.trim();
  if (text) messageInput.value = text.slice(0, CAPS.messageChars);
  if (!sharedFiles.length && text) toast('Shared text is ready — pick a device or room to send it to.');
}

async function boot() {
  // Theme first: it must not flash the wrong palette while config loads.
  setupTheme();

  try {
    const response = await fetch('/config.json', { cache: 'no-store' });
    if (response.ok) state.config = { ...state.config, ...(await response.json()) };
  } catch {}

  try {
    state.identity = await loadIdentity();
  } catch (err) {
    serverState.textContent = 'Device identity unavailable';
    toast('This browser could not create a device identity. Private browsing with storage disabled will not work.');
    return;
  }

  setupShareBanner();
  consumeShareTarget();
  setupInstallPrompt();
  setupDragAndDrop();
  setupPasteToSend();
  setupRelayToggle();
  setupSettings();
  connectWebSocket();
  state.statsTimer = setInterval(refreshStats, 3000);
  state.wakeLockTimer = setInterval(updateWakeLock, 2000);
  setupServiceWorker();
}

boot();
