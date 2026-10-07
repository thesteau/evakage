import { setupAccounts, accountSocketTicket } from './preferences.js';
import { setTip, setupTips } from './tips.js';
import { setupScanner, pairingInvitation, roomInvitation, roomInvitationLink } from './scanner.js';
import { drawQr } from './qr.js';
import { signMessage, verifyMessage, messageScope, historyFrames, messageKey } from './messages.js';
import { parseFrame, CONTROL_KIND, FILE_CHUNK_KIND } from './frames.js';
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
  pairDevice,
  pairingRevoked,
  revokePairing,
  knownDevices,
  forgetDevice,
  flushKnownDevices,
  verifyDevice,
  blockDevice,
  hideDevice,
  verifyAdvertisedIdentity,
  bytesToBase64,
  base64ToBytes,
} from './identity.js';
import {
  buildEnvelope,
  openEnvelope,
  buildMessageEnvelope,
  openMessageEnvelope,
  generateContentKey,
  encryptBodyChunks,
  createBodyDecryptor,
  verifiedPlaintext,
  cipherLayout,
} from './relay.js';
import { saveStream, streamSaveAvailable, StreamSaveUnavailable } from './savestream.js';
import { TransferStats, bufferLimit } from './transfer-stats.js';

type AppElements = {
  '#connectDialog': HTMLDialogElement;
  '#connectForm': HTMLFormElement;
  '#connectCode': HTMLInputElement;
  '#connectFeedback': HTMLElement;
  '#connectTarget': HTMLElement;
  '#connectCancel': HTMLButtonElement;
  '#qrBtn': HTMLButtonElement;
  '#addDeviceDialog': HTMLDialogElement;
  '#addDeviceBtn': HTMLButtonElement;
  '#deviceScope': HTMLSelectElement;
  '#noRoomMatches': HTMLElement;
  '#guideBtn': HTMLButtonElement;
  '#guideDialog': HTMLDialogElement;
  '#appNameBtn': HTMLButtonElement;
  '#connectQrBtn': HTMLButtonElement;
  '#aboutDialog': HTMLDialogElement;
  '#qrPairingCode': HTMLElement;
  '#qrDialog': HTMLDialogElement;
  '#roomQrDialog': HTMLDialogElement;
  '#roomQrBtn': HTMLElementTagNameMap['button'];
  '#roomQr': HTMLCanvasElement;
  '#roomQrCode': HTMLElementTagNameMap['strong'];
  '#roomQrName': HTMLElementTagNameMap['span'];
  '#deviceQr': HTMLCanvasElement;
  '#qrInvitation': HTMLInputElement;
  '#copyInvitationBtn': HTMLButtonElement;
  '#qrCopyFeedback': HTMLElement;
  '#qrFingerprint': HTMLElement;
  '#pairingDialog': HTMLDialogElement;
  '#pairingForm': HTMLFormElement;
  '#pairingCode': HTMLElement;
  '#pairingInput': HTMLInputElement;
  '#pairingFeedback': HTMLElement;
  '#pairingCancel': HTMLButtonElement;
  '#verifiedOnlyInput': HTMLInputElement;
  '#roomApprovalInput': HTMLInputElement;
  '#peerRows': HTMLElementTagNameMap['tbody'];
  '#emptyPeers': HTMLElementTagNameMap['div'];
  '#roomRows': HTMLElementTagNameMap['tbody'];
  '#emptyRooms': HTMLElementTagNameMap['div'];
  '#serverState': HTMLElementTagNameMap['span'];
  '#sessionPanel': HTMLElementTagNameMap['aside'];
  '#sessionTitle': HTMLElementTagNameMap['h2'];
  '#sessionMeta': HTMLElementTagNameMap['div'];
  '#roomCodeLine': HTMLElementTagNameMap['div'];
  '#roomCodeText': HTMLElementTagNameMap['strong'];
  '#joinRequests': HTMLElementTagNameMap['div'];
  '#sessionKind': HTMLElementTagNameMap['div'];
  '#sessionMembers': HTMLElementTagNameMap['div'];
  '#leaveRoomBtn': HTMLElementTagNameMap['button'];
  '#secureState': HTMLElementTagNameMap['span'];
  '#timeline': HTMLElementTagNameMap['div'];
  '#messageForm': HTMLElementTagNameMap['form'];
  '#messageInput': HTMLElementTagNameMap['textarea'];
  '#fileInput': HTMLElementTagNameMap['input'];
  '#pickFileBtn': HTMLElementTagNameMap['button'];
  '#selfCode': HTMLElementTagNameMap['button'];
  '#toastRegion': HTMLElementTagNameMap['div'];
  '#codeFeedback': HTMLElementTagNameMap['span'];
  '#roomFeedback': HTMLElementTagNameMap['span'];
  '#devicesDialog': HTMLElementTagNameMap['dialog'];
  '#knownDeviceList': HTMLElementTagNameMap['div'];
  '#pickTargetDialog': HTMLElementTagNameMap['dialog'];
  '#pickTargetList': HTMLElementTagNameMap['div'];
  '#pickTargetTitle': HTMLElementTagNameMap['h2'];
  '#pickTargetHint': HTMLElementTagNameMap['p'];
  '#themeBtn': HTMLElementTagNameMap['button'];
  '#themeIcon': HTMLElementTagNameMap['span'];
  '#closeSession': HTMLElementTagNameMap['button'];
  '#messageTemplate': HTMLElementTagNameMap['template'];
  '#fileTemplate': HTMLElementTagNameMap['template'];
  '#codeForm': HTMLElementTagNameMap['form'];
  '#codeInput': HTMLElementTagNameMap['input'];
  '#createRoomForm': HTMLElementTagNameMap['form'];
  '#roomNameInput': HTMLElementTagNameMap['input'];
  '#joinRoomForm': HTMLElementTagNameMap['form'];
  '#roomCodeInput': HTMLElementTagNameMap['input'];
  '#copyCodeBtn': HTMLElementTagNameMap['button'];
  '#settingsDialog': HTMLElementTagNameMap['dialog'];
  '#settingsBtn': HTMLElementTagNameMap['button'];
  '#relayToggle': HTMLElementTagNameMap['label'];
  '#forceRelayInput': HTMLElementTagNameMap['input'];
  '#devicesBtn': HTMLElementTagNameMap['button'];
  '#refreshBtn': HTMLElementTagNameMap['button'];
  '#installBtn': HTMLElementTagNameMap['button'];
  '#installTip': HTMLElementTagNameMap['span'];
  '#updateBanner': HTMLElementTagNameMap['div'];
  '#reloadBtn': HTMLElementTagNameMap['button'];
  '#shareBanner': HTMLElementTagNameMap['div'];
  '#shareBannerText': HTMLElementTagNameMap['span'];
  '#shareSendBtn': HTMLElementTagNameMap['button'];
  '#shareDiscardBtn': HTMLElementTagNameMap['button'];
};

function $<K extends keyof AppElements>(sel: K): AppElements[K] {
  const element = document.querySelector(sel);
  if (!element) throw new Error(`Missing required app element: ${sel}`);
  return element as AppElements[K];
}
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
const devicesDialog = $('#devicesDialog');
const knownDeviceList = $('#knownDeviceList');
const pickTargetDialog = $('#pickTargetDialog');
const pickTargetList = $('#pickTargetList');
const pickTargetTitle = $('#pickTargetTitle');
const pickTargetHint = $('#pickTargetHint');
const themeBtn = $('#themeBtn');
const themeIcon = $('#themeIcon');

import type { Room, RoomAccess } from './types.js';

import type { Device } from './types.js';

import type { Message } from './types.js';

import type { FileMeta } from './types.js';

import type { FileRecord } from './types.js';

import type { Conversation } from './types.js';

import type { SecureLink } from './types.js';

import type { Link } from './types.js';

const state = {
  ws: null as WebSocket | null,
  wsBackoff: 500,
  self: null as {
    id: string;
    name: string;
    code: string;
    pairingCode?: string;
    pairingCodeExpiresAt?: number;
  } | null,
  identity: null as Awaited<ReturnType<typeof loadIdentity>> | null, // long-lived device keypair + fingerprint
  peers: new Map([] as [string, Device][]), // deviceId -> online peer record from the server
  links: new Map([] as [string, Link][]), // deviceId -> pairwise transport + crypto
  conversations: new Map([] as [string, Conversation][]), // convId -> in-memory chat/file state
  rooms: new Map([] as [string, Room][]), // roomId -> server room record
  pendingOpenRoomCode: '',
  joinedRoomIds: new Set<string>(), // rooms this browser is a member of
  activeConvId: null as string | null,
  activeSends: new Map(), // transferId -> { cancelled, fileId, name }
  /** Defaults until /config.json answers. */
  config: {
    iceServers: [],
    maxFileBytes: 512 * 1024 * 1024,
    maxRoomMembers: 20,
    roomMeshMax: 6,
  } as {
    iceServers: RTCIceServer[];
    maxFileBytes: number;
    maxRoomMembers: number;
    roomMeshMax: number;
    protocol?: number;
    relay?: {
      enabled: boolean;
      chunkSize: number;
      idleGraceMs: number;
      soloMaxMs: number;
      maxAgeMs: number;
    };
  },
  pendingCodeRequests: new Map(),
  /** Room the user asked to open, waiting on the server to confirm the seat. */
  pendingOpenRoomId: null as string | null,
  statsTimer: null as ReturnType<typeof setInterval> | null,
  wakeLockTimer: null as ReturnType<typeof setInterval> | null,
  theme: 'system',
  panelReturnFocus: null as Element | null,
  panelReturnKey: null as string | null,
  forceRelay: false,
  // Whether an incoming file needs a yes first: 'auto', 'new' (first contact
  // with a device), or 'always'. Accepting once trusts that device for the
  // rest of the session.
  incomingPolicy: 'new',
  verifiedOnly: false,
  consentedDevices: new Set<string>(),
  // Last known record for every device we know of, online or not: presence,
  // room away lists, and server lookups all feed it. An offline device seen
  // within the relay window can still be sent to through the server.
  deviceRecords: new Map([] as [string, Device][]), // deviceId -> { ...record, online, lastSeen }
  pendingRequests: new Map(), // requestId / blobId -> { resolve, reject, timer }
  relayInbound: new Set<string>(), // blob ids already being fetched, so a repeat notice is ignored
  // Set from deleting self-notes until the server confirms; notices it sent
  // before then are for items just deleted and must not bring them back.
  selfClearing: false,
  sealKeyCache: new Map(), // advertised identity -> verified seal key bytes (or null)
};
// Account approval is ephemeral; never turn it into a stored code pairing.
const accountPeerIds = new Set<string>();
let accountGeneration = 0;
let signingOut = false;
/** Serialise SDP/ICE work per peer while allowing unrelated peers to negotiate. */
const signalQueues: Map<string, Promise<void>> = new Map();

const transportStops: WeakMap<RTCPeerConnection, AbortController> = new WeakMap();
const accountEvents =
  typeof BroadcastChannel === 'undefined' ? null : new BroadcastChannel('evakage-account-session');
accountEvents?.addEventListener('message', (event) => {
  if (event.data === 'sign-out') clearSignedOutDevice(false);
});
window.addEventListener('storage', (event) => {
  if (event.key === 'evakage-account-signout' && event.newValue) clearSignedOutDevice(false);
});

function clearSignedOutDevice(broadcast: boolean = true) {
  if (signingOut) return;
  signingOut = true;
  if (broadcast) {
    accountEvents?.postMessage('sign-out');
    try {
      localStorage.setItem('evakage-account-signout', crypto.randomUUID());
    } catch {}
  }
  accountGeneration++;
  accountPeerIds.clear();
  for (const [id, record] of knownDevices()) {
    if (record.blocked || record.hidden) revokePairing(id);
    else forgetDevice(id);
  }
  try {
    localStorage.setItem('evakage-discoverable', '0');
  } catch {}
  for (const send of state.activeSends.values()) send.cancelled = true;
  for (const conv of state.conversations.values()) {
    for (const file of conv.files.values()) file.relayAbort?.abort();
    conv.messages.clear();
    conv.files.clear();
  }
  for (const link of state.links.values()) {
    clearTimeout(link.negotiationTimer ?? undefined);
    clearTimeout(link.reconnectTimer ?? undefined);
    clearTimeout(link.queueTimer ?? undefined);
    try {
      link.dc?.close();
      closePeerConnection(link.pc);
    } catch {}
  }
  state.conversations.clear();
  state.links.clear();
  state.joinedRoomIds.clear();
  state.deviceRecords.clear();
  state.consentedDevices.clear();
  messageInput.value = '';
  fileInput.value = '';
  sharedFiles = [];
  timeline.replaceChildren();
  state.ws?.close();
  // A fresh document discards pending crypto operations and transfer buffers
  // too, so let the forgotten pairings finish writing before leaving.
  flushKnownDevices().finally(() => location.replace(location.pathname));
}

async function updateAccountPeers(message: { signedIn: boolean; peers: Device[] }) {
  if (!message.signedIn && !accountPeerIds.size) return;
  const generation = ++accountGeneration;
  const previous = new Set(accountPeerIds);
  accountPeerIds.clear();
  for (const peer of message.peers || []) {
    // The verifier rejects absent/malformed fields and checks both proofs.
    // Never let advertised fields decide whether verification runs.
    const verified = await verifyAdvertisedIdentity({
      deviceId: peer.id,
      identityKey: peer.identityKey,
      sealKey: peer.sealKey,
      sealKeySignature: peer.sealKeySignature,
    });
    if (generation !== accountGeneration || signingOut) return;
    if (!verified) continue;
    accountPeerIds.add(peer.id);
    recordDevice(peer, true);
    if (deviceTrust(peer.id)?.blocked) blockDevice(peer.id, false);
    if (deviceTrust(peer.id)?.hidden) hideDevice(peer.id, peer.name, false);
    state.peers.set(peer.id, peer);
    ensureConversation(directConvId(peer.id), 'direct', peer.id);
  }
  for (const id of previous) {
    if (accountPeerIds.has(id)) continue;
    revokePairing(id);
    state.peers.delete(id);
    const record = state.deviceRecords.get(id);
    if (record) recordDevice(record, false);
  }
  releaseIdleLinks();
  for (const id of accountPeerIds) {
    ensureConversationLinks(ensureConversation(directConvId(id), 'direct', id));
  }
  renderKnownDevices();
  renderPeers();
  renderSession();
}

function deviceAllowed(id: string) {
  if (id === state.self?.id) return true;
  const trust = deviceTrust(id);
  return (
    !signingOut &&
    (accountPeerIds.has(id) ||
      (!trust?.blocked && !!trust?.pairedAt && (!state.verifiedOnly || !!trust?.verifiedAt)))
  );
}

function assertRecipientsApproved(ids: string[]) {
  if (ids.some((id) => !deviceAllowed(id)))
    {throw new Error(
      'Pair unknown devices by code first. Verify or unblock every recipient in Known devices before sending.',
    );}
}

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

function recordDevice(record: Device, online: boolean) {
  if (!record?.id || record.id === state.self?.id) return;
  const previous = state.deviceRecords.get(record.id);
  state.deviceRecords.set(record.id, {
    ...previous,
    ...record,
    online,
    lastSeen: online ? Date.now() : record.lastSeen || previous?.lastSeen || Date.now(),
  });
}

/** A device that is offline but was seen recently enough to still be sent to. */
function isRecentlySeen(deviceId: string) {
  const record = state.deviceRecords.get(deviceId);
  return (
    record !== undefined &&
    !state.peers.has(deviceId) &&
    (record.lastSeen || 0) >= Date.now() - RECENT_WINDOW_MS
  );
}

// Asks the server for the signed records of devices we know about. The records
// are verified client-side before anything is sealed to them, exactly as a
// live one would be, so the server cannot substitute a key.

function lookupDevices(deviceIds: string[]) {
  const ids = [...new Set(deviceIds)].filter((id) => id && id !== state.self?.id).slice(0, 200);
  if (!ids.length || !relayEnabled()) return Promise.resolve([]);
  const requestId = crypto.randomUUID();
  return awaitReply(
    `lookup:${requestId}`,
    () => wsSend({ type: 'lookup-devices', requestId, deviceIds: ids }),
    8000,
  )
    .then((reply) => {
      for (const device of reply.devices || [])
        {recordDevice(device, Boolean(device.online) && state.peers.has(device.id));}
      renderPeers();
      return reply.devices || [];
    })
    .catch(() => []);
}

// How long the server holds something left for a device that is not here, in
// words. Read from the server's own config so the copy cannot drift from it.
function relayWindowText() {
  const ms = state.config.relay?.soloMaxMs ?? 3 * 60 * 60 * 1000;
  const minutes = Math.round(ms / 60000);
  if (minutes < 60) return `${Math.max(1, minutes)} minutes`;
  const hours = Math.round(minutes / 60);
  return hours === 1 ? 'an hour' : `${hours} hours`;
}

// Anything inside this of its deadline is called out rather than just counted.
const EXPIRY_WARNING_MS = 15 * 60 * 1000;

/** Coarse at a distance, precise when it matters. */
function formatRemaining(ms: number) {
  if (ms <= 0) return 'expired';
  const seconds = Math.round(ms / 1000);
  if (seconds < 60) return `${seconds}s left`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m left`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return minutes % 60 ? `${hours}h ${minutes % 60}m left` : `${hours}h left`;
  const days = Math.floor(hours / 24);
  return hours % 24 ? `${days}d ${hours % 24}h left` : `${days}d left`;
}

/** * The countdown for one deadline, and whether it is close enough to warn about.
 * `cap` marks a deadline that is the absolute session cap, where the answer is
 * to start a fresh session rather than to hurry. */
function expiryState(expiresAt: number | undefined) {
  if (!expiresAt) return null;
  const remaining = expiresAt - Date.now();
  const capMs = state.config.relay?.maxAgeMs;
  const cap = Boolean(capMs && Math.abs(expiresAt - (Date.now() + capMs)) < 60_000);
  return { remaining, text: formatRemaining(remaining), warn: remaining <= EXPIRY_WARNING_MS, cap };
}

function formatAgo(timestamp: number | undefined) {
  const seconds = Math.max(0, Math.round((Date.now() - (timestamp || 0)) / 1000));
  if (seconds < 60) return 'just now';
  const minutes = Math.round(seconds / 60);
  if (minutes < 60) return `${minutes}m ago`;
  return `${Math.round(minutes / 60)}h ago`;
}

const encoder = new TextEncoder();
const CHUNK_SIZE = 64 * 1024;
// Used only if /config.json did not answer; the server publishes the real value.
const RELAY_CHUNK_FALLBACK = 256 * 1024;
const LOW_WATER = 256 * 1024;
const channelRates = new WeakMap();
const fileStats = new WeakMap();

// Peer application protocol. Bump PROTOCOL_VERSION for any wire change; widen
// [MIN_PROTOCOL, PROTOCOL_VERSION] only for versions this build can actually
// speak. A peer outside that window is refused with an explanation instead of
// being left to fail somewhere deeper in the exchange.
// v2 added signed long-lived device identities, so a v1 peer cannot prove who it
// is and is refused rather than silently downgraded.
// v3 requires portable message proofs; unsigned v2 chat/history is not accepted.
const PROTOCOL_VERSION = 3;
const MIN_PROTOCOL = 3;

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
  reconnectAttempts: 8,
};

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

function wsSend(payload: object) {
  if (signingOut) return;
  if (state.ws?.readyState === WebSocket.OPEN) state.ws.send(JSON.stringify(payload));
}

function signal(to: string, data: object) {
  wsSend({ type: 'signal', to, data });
}

// At most one reconnect may be pending. A foreground or online event can connect
// before the backoff timer fires; letting the timer fire too would open a second
// socket for this device, and the server closes the older one with 4001.

let wsReconnectTimer: ReturnType<typeof setTimeout> | undefined;

function connectWebSocket() {
  const identity = state.identity;
  if (!identity) throw new Error('Device identity is not ready. Reload and try again.');
  clearTimeout(wsReconnectTimer);
  wsReconnectTimer = undefined;
  const protocol = location.protocol === 'https:' ? 'wss:' : 'ws:';
  const ws = new WebSocket(`${protocol}//${location.host}`);
  state.ws = ws;
  serverState.textContent = 'Connecting';
  serverState.title = 'Connecting to the server';
  serverState.classList.remove('online', 'offline');

  ws.addEventListener('open', () => {
    if (state.ws !== ws) return;
    state.wsBackoff = 500;
    serverState.textContent = 'Ready';
    serverState.title = 'Connected to the server';
    serverState.classList.add('online');
  });

  ws.addEventListener('message', async (event) => {
    if (signingOut || state.ws !== ws) return;
    let msg;
    try {
      msg = JSON.parse(event.data);
    } catch {
      return;
    }

    if (msg.type === 'registration-challenge') {
      if (typeof msg.challenge !== 'string' || msg.challenge.length > 128) return;
      wsSend({
        type: 'register',
        deviceId: identity.deviceId,
        registrationProof: await signTranscript(
          identity.privateKey,
          JSON.stringify(['evakage/register/1', msg.challenge, identity.deviceId]),
        ),
        platform: detectPlatform(),
        browser: detectBrowser(),
        discoverable: localStorage.getItem('evakage-discoverable') === '1',
        // Published so others can seal a relayed file to this device. The server
        // passes these through untouched; receivers verify them, not the server.
        identityKey: identity.identityKey,
        sealKey: identity.sealKey,
        sealKeySignature: identity.sealKeySignature,
      });
      return;
    }

    if (msg.type === 'registered') {
      state.self = msg.self;
      accountUI.refresh();
      selfCode.textContent = msg.self.pairingCode || '----';
      selfCode.dataset.deviceName = msg.self.name;
      selfCode.dataset.deviceId = msg.self.id;
      for (const id of msg.revoked || []) {
        revokePairing(id);
        const conv = state.conversations.get(directConvId(id));
        if (conv) conv.syncAfter = Date.now();
      }
      for (const peer of msg.paired || []) {
        if (pairingRevoked(peer.id)) wsSend({ type: 'unpair-device', deviceId: peer.id });
        else await acceptPairing(peer);
      }
      document.title = `${msg.self.name} · Evakage`;
      renderPeers();
      rejoinRooms();
      // Recover records for devices we have talked to, so ones that are offline
      // right now can still be listed and sent to.
      lookupDevices([...knownDevices().map(([id]) => id), ...state.deviceRecords.keys()]);
      await handlePairingLink();
      return;
    }

    if (msg.type === 'account-reset') {
      clearSignedOutDevice();
      return;
    }
    if (msg.type === 'account-peers') {
      await updateAccountPeers(msg);
      return;
    }

    if (msg.type === 'devices-found') {
      settleRequest(`lookup:${msg.requestId}`, msg);
      return;
    }

    if (msg.type === 'presence') {
      const previousOnline = new Set(state.peers.keys());
      state.peers = new Map(
        msg.peers.filter((p: Device) => p.id !== state.self?.id).map((p: Device) => [p.id, p]),
      );
      for (const peer of state.peers.values()) recordDevice(peer, true);
      // Anyone who just dropped off stays addressable through the relay.
      for (const id of previousOnline) {
        const previous = state.deviceRecords.get(id);
        if (!state.peers.has(id) && previous) {
          recordDevice({ ...previous, lastSeen: Date.now() }, false);
        }
      }
      renderPeers();
      renderRooms();
      reconcileLinks(previousOnline);
      renderSession();
      return;
    }

    if (msg.type === 'rooms') {
      state.rooms = new Map(msg.rooms.map((room: Room) => [room.id, room]));
      announceJoinRequests();
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
        const stillSeated =
          room &&
          (room.members.some((m) => m.id === self) || (room.away || []).some((m) => m.id === self));
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
      roomFeedback.textContent = msg.created ? '' : `Joined ${msg.room.name}`;
      if (msg.created) {
        $('#roomNameInput').value = '';
        toast(
          msg.replacedRoomName
            ? `Created ${msg.room.name}. Your oldest room, ${msg.replacedRoomName}, was destroyed. You can have two rooms per account.`
            : `Created ${msg.room.name}. You can have two rooms per account; creating another replaces the oldest.`,
        );
      }
      renderRooms();
      ensureConversationLinks(conv);
      renderSession();
      if (state.pendingOpenRoomId === msg.room.id || state.pendingOpenRoomCode === msg.room.code) {
        state.pendingOpenRoomId = null;
        state.pendingOpenRoomCode = '';
        openRoom(msg.room.id);
      }
      // Anything left for this device in the room while it was away, including
      // items set aside because they arrived before this rejoin landed.
      wsSend({ type: 'blobs-request' });
      requestRoomHistory(msg.room.id);
      return;
    }

    if (msg.type === 'room-pending') {
      state.pendingOpenRoomId = msg.roomId;
      roomFeedback.textContent = `Waiting for approval to join ${msg.name}`;
      toast(`Asked to join ${msg.name}. The room's creator must approve.`);
      return;
    }

    if (msg.type === 'room-destroyed') {
      state.rooms.delete(msg.roomId);
      state.joinedRoomIds.delete(msg.roomId);
      forgetConversation(roomConvId(msg.roomId));
      toast(`${msg.name} was destroyed because its owner created a newer room.`);
      renderRooms();
      return;
    }

    if (msg.type === 'room-left') {
      state.joinedRoomIds.delete(msg.roomId);
      forgetConversation(roomConvId(msg.roomId));
      renderRooms();
      return;
    }

    if (msg.type === 'pairing-code') {
      if (state.self) {
        state.self.pairingCode = msg.code;
        state.self.pairingCodeExpiresAt = msg.expiresAt;
        selfCode.textContent = msg.code;
        if ($('#qrDialog').open) renderQrCodes();
      }
      return;
    }

    if (msg.type === 'pairing-revoked') {
      accountPeerIds.delete(msg.deviceId);
      revokePairing(msg.deviceId);
      const conv = state.conversations.get(directConvId(msg.deviceId));
      if (conv) conv.syncAfter = Date.now();
      releaseIdleLinks();
      renderKnownDevices();
      renderPeers();
      renderSession();
      return;
    }

    if (msg.type === 'paired-device') {
      const peer = msg.peer && (await acceptPairing(msg.peer)) ? msg.peer : null;
      const pending = state.pendingCodeRequests.get(msg.requestId);
      if (typeof pending === 'function') {
        state.pendingCodeRequests.delete(msg.requestId);
        pending(peer);
      }
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
      await queueSignal(msg.from, msg.data, msg.fromConnectedAt);
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
      if (state.selfClearing && msg.from === state.self?.id) return;
      handleBlobAvailable(msg);
      return;
    }

    if (msg.type === 'self-cleared') {
      state.selfClearing = false;
      return;
    }

    if (msg.type === 'relay-notice') {
      toast(msg.message);
      return;
    }

    if (msg.type === 'error') {
      // Relay errors belong to a specific pending request; hand them to it
      // rather than toasting, so the caller can decide what to tell the user.
      if (
        msg.context === 'blob-offer' &&
        msg.requestId &&
        state.pendingRequests.has(msg.requestId)
      ) {
        settleRequest(msg.requestId, null, new Error(msg.message));
        return;
      }
      if (
        msg.context === 'blob-claim' &&
        msg.blobId &&
        state.pendingRequests.has(`claim:${msg.blobId}`)
      ) {
        settleRequest(`claim:${msg.blobId}`, null, new Error(msg.message));
        return;
      }
      if (msg.context === 'join-room' && msg.roomId) {
        state.rooms.delete(msg.roomId);
        state.joinedRoomIds.delete(msg.roomId);
        forgetConversation(roomConvId(msg.roomId));
        renderRooms();
      }
      if (msg.context === 'join-room') roomFeedback.textContent = msg.message;
      if (msg.context === 'create-room') roomFeedback.textContent = '';
      toast(msg.message || 'Server error');
    }
  });

  ws.addEventListener('close', (event) => {
    // A superseded socket closing must not tear down or re-dial for its replacement.
    if (signingOut || state.ws !== ws) return;
    // No confirmation can arrive on a closed socket; a new one starts clean.
    state.selfClearing = false;
    accountGeneration++;
    accountPeerIds.clear();
    releaseIdleLinks();
    serverState.textContent = event.code === 1008 ? 'Access denied' : 'Not Ready';
    serverState.title =
      event.code === 1008
        ? 'Access denied — reload after access is restored'
        : 'Connection lost — reconnecting';
    serverState.classList.remove('online');
    serverState.classList.add('offline');
    state.peers.clear();
    state.rooms.clear();
    renderPeers();
    renderRooms();
    renderSession();
    if (event.code === 4001) {
      serverState.textContent = 'Not Ready (another tab)';
      serverState.title =
        'This device is active in another tab. Close that tab and reload here to reconnect.';
      return;
    }
    if (event.code === 1008) return;
    wsReconnectTimer = setTimeout(connectWebSocket, state.wsBackoff);
    state.wsBackoff = Math.min(state.wsBackoff * 1.8, 10000);
  });

  ws.addEventListener('error', () => ws.close());
}

// Reclaim held seats after a signaling blip. Ended rooms cannot be recreated.
function rejoinRooms() {
  for (const roomId of state.joinedRoomIds) {
    const conv = state.conversations.get(roomConvId(roomId));
    wsSend({
      type: 'join-room',
      roomId,
      recreate: true,
      name: conv?.lastKnownName,
      code: conv?.lastKnownCode,
    });
  }
}

/* ---------- conversations ---------- */

const isSelfConversation = (conv: Conversation) =>
  conv.kind === 'direct' && conv.peerId === state.self?.id;

const directConvId = (peerId: string) => `d:${peerId}`;
const roomConvId = (roomId: string) => `r:${roomId}`;

function ensureConversation(convId: string, kind: 'direct' | 'room', ref: string) {
  const existing = state.conversations.get(convId);
  if (existing) return existing;

  const conv: Conversation = {
    id: convId,
    ...(kind === 'direct'
      ? { kind, peerId: ref, roomId: null }
      : { kind, peerId: null, roomId: ref }),
    lastKnownName: null,
    lastKnownCode: null,
    messages: new Map(),
    files: new Map(),
  };
  state.conversations.set(convId, conv);
  return conv;
}

function forgetConversation(convId: string) {
  // Self-notes live on the server so they survive a reload; deleting the
  // conversation must remove them there as well, or they come straight back.
  if (
    state.self &&
    convId === directConvId(state.self.id) &&
    state.ws?.readyState === WebSocket.OPEN
  ) {
    state.selfClearing = true;
    wsSend({ type: 'self-clear' });
  }
  if (!state.conversations.delete(convId)) return;
  if (state.activeConvId === convId) closeSessionPanel();
  releaseIdleLinks();
}

// Wire-level scope. "direct" is resolved relative to the sender, so each side
// maps it onto its own conversation id for the other device.

function convScope(conv: Conversation) {
  return conv.kind === 'room' ? `room:${conv.roomId}` : 'direct';
}

function signedScope(conv: Conversation) {
  return messageScope(convScope(conv), [state.self?.id || '', conv.peerId || state.self?.id || '']);
}

function resolveScope(scope: string | undefined, fromPeerId: string) {
  if (!deviceAllowed(fromPeerId)) return null;
  if (!scope || scope === 'direct')
    {return ensureConversation(directConvId(fromPeerId), 'direct', fromPeerId);}
  if (!scope.startsWith('room:')) return null;
  const roomId = scope.slice(5);
  // Only accept room traffic for rooms this browser actually joined.
  if (!state.joinedRoomIds.has(roomId)) return null;
  return state.conversations.get(roomConvId(roomId)) || null;
}

// Everyone party to a conversation, including room members who are away: they
// keep their seat and are still sent to, through the relay.

function conversationMembers(conv: Conversation) {
  if (conv.kind === 'direct') return [conv.peerId];
  const room = state.rooms.get(conv.roomId);
  if (!room) return [];
  return [...room.members, ...(room.away || [])]
    .map((m) => m.id)
    .filter((id) => id !== state.self?.id);
}

function onlineMembers(conv: Conversation) {
  return conversationMembers(conv).filter((id) => state.peers.has(id));
}

/** Members who are offline but recent enough that a relayed item can wait for them. */
function relayOnlyMembers(conv: Conversation) {
  if (!relayEnabled()) return [];
  return conversationMembers(conv).filter(isRecentlySeen);
}

function conversationTitle(conv: Conversation) {
  if (isSelfConversation(conv)) return 'Message yourself';
  if (conv.kind === 'room')
    {return state.rooms.get(conv.roomId)?.name || conv.lastKnownName || 'Room';}
  return getPeer(conv.peerId).name;
}

// Falls back to the name remembered for a known device, so a relayed message
// from a device that has since gone offline still shows who sent it.

function displayName(deviceId: string | null | undefined) {
  if (!deviceId) return 'Unknown device';
  if (state.self && deviceId === state.self.id) return state.self.name;
  return (
    state.peers.get(deviceId)?.name ||
    state.deviceRecords.get(deviceId)?.name ||
    deviceTrust(deviceId)?.name ||
    `Device ${deviceId.slice(0, 10)}…`
  );
}

/* ---------- links ---------- */

function createLink(peerId: string) {
  const existing = state.links.get(peerId);
  if (existing) return existing;

  const link: Link = {
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
    trust: null,
  };
  state.links.set(peerId, link);
  return link;
}

// A derived key is not enough: the peer must also have proved ownership of the
// device key its ID is derived from, or the link stays unusable.

function isSecure(link: Link | null | undefined): link is SecureLink {
  return Boolean(
    link?.crypto.key && link.crypto.identityVerified && link.dc?.readyState === 'open',
  );
}

// Every open conversation decides which pairwise links stay alive. One link can
// carry a direct session and several rooms at once.
function neededPeerIds() {
  const needed = new Set<string>();
  for (const conv of state.conversations.values()) {
    // A large room runs entirely through the relay, so it needs no links.
    if (isRelayRoom(conv)) continue;
    for (const id of onlineMembers(conv)) if (deviceAllowed(id)) needed.add(id);
  }
  return needed;
}

// Rooms past the mesh size are relay-only: the server says which when it lists
// the room, so every member makes the same choice.

function isRelayRoom(conv: Conversation) {
  return conv.kind === 'room' && state.rooms.get(conv.roomId)?.transport === 'relay';
}

function releaseIdleLinks() {
  for (const conv of state.conversations.values()) {
    for (const file of conv.files.values()) {
      if (file.from && !deviceAllowed(file.from)) {
        file.relayAbort?.abort(new Error('Sender authorization was revoked.'));
      }
    }
  }
  const needed = neededPeerIds();
  for (const [peerId, link] of state.links) {
    if (needed.has(peerId)) continue;
    clearTimeout(link.negotiationTimer ?? undefined);
    clearTimeout(link.reconnectTimer ?? undefined);
    clearTimeout(link.queueTimer ?? undefined);
    try {
      link.dc?.close();
    } catch {}
    try {
      closePeerConnection(link.pc);
    } catch {}
    state.links.delete(peerId);
  }
}

function reconcileLinks(previousOnline: Set<string>) {
  for (const peerId of neededPeerIds()) {
    const link = state.links.get(peerId);
    // A device that just came back online earns a fresh retry budget.
    const connectedAt = state.peers.get(peerId)?.connectedAt;
    if (
      (!previousOnline.has(peerId) && (!link?.pc || link.peerConnectedAt !== connectedAt)) ||
      (link?.peerConnectedAt != null && connectedAt != null && link.peerConnectedAt !== connectedAt)
    ) {
      retryLink(peerId);
      continue;
    }
    if (link?.incompatible || link?.gaveUp) continue;
    if (!link?.pc || ['closed', 'failed', 'disconnected'].includes(link.pc.connectionState))
      {ensureLink(peerId);}
  }
  releaseIdleLinks();
}

function ensureConversationLinks(conv: Conversation) {
  if (isRelayRoom(conv)) return;
  for (const peerId of onlineMembers(conv)) ensureLink(peerId);
}

function attachPeerConnection(link: Link) {
  const peerId = link.peerId;
  const pc = link.pc;
  if (!pc) return;
  transportStops.set(pc, new AbortController());
  pc.onicecandidate = (event) => {
    if (state.links.get(peerId) !== link || link.pc !== pc) return;
    if (event.candidate) signal(peerId, { type: 'ice', candidate: event.candidate });
  };
  pc.onconnectionstatechange = () => {
    if (state.links.get(peerId) !== link || link.pc !== pc) return;
    if (link.incompatible) return;
    link.status = pc.connectionState;
    // Keep the retry budget until the peer has proved its identity; an ICE
    // connection alone must not reset stalled-handshake retries indefinitely.
    renderPeers();
    renderRooms();
    renderSession();
    if (['failed', 'disconnected'].includes(pc.connectionState)) scheduleReconnect(peerId);
  };
  pc.ondatachannel = (event) => {
    if (state.links.get(peerId) !== link || link.pc !== pc) {
      event.channel.close();
      return;
    }
    setupDataChannel(link, event.channel);
  };
}

/** Closing a PC does not reliably settle its pending SDP promises in Chromium.
 * Cancel our wait as well, so an abandoned operation cannot block signaling. */
function transportTask<T>(pc: RTCPeerConnection, task: Promise<T>): Promise<T> {
  const signal = transportStops.get(pc)?.signal;
  if (!signal) return task;
  return new Promise((resolve, reject) => {
    const cancelled = () => reject(new DOMException('Transport was replaced.', 'AbortError'));
    if (signal.aborted) cancelled();
    else signal.addEventListener('abort', cancelled, { once: true });
    task.then(
      (value) => {
        signal.removeEventListener('abort', cancelled);
        resolve(value);
      },
      (error) => {
        signal.removeEventListener('abort', cancelled);
        reject(error);
      },
    );
  });
}

function closePeerConnection(pc: RTCPeerConnection | null) {
  if (!pc) return;
  transportStops.get(pc)?.abort();
  pc.close();
}

/** ICE can remain "new"/"connecting" after an answer is lost or a reload
 * abandons the negotiation. Bound the complete transport and identity handshake. */
function watchNegotiation(link: Link) {
  clearTimeout(link.negotiationTimer ?? undefined);
  const pc = link.pc;
  link.negotiationTimer = setTimeout(() => {
    link.negotiationTimer = null;
    if (
      state.links.get(link.peerId) !== link ||
      link.pc !== pc ||
      isSecure(link) ||
      link.incompatible
    )
      {return;}
    link.dc = null;
    link.pc = null;
    try {
      closePeerConnection(pc);
    } catch {}
    if (state.peers.has(link.peerId) && neededPeerIds().has(link.peerId))
      {scheduleReconnect(link.peerId);}
  }, 5000);
}

// Joining a full room otherwise starts five negotiations at once, each with its
// own ICE gathering and key exchange. Admit a few at a time and let the rest wait.
function negotiatingCount() {
  let count = 0;
  for (const link of state.links.values()) {
    if (
      link.pc &&
      ['new', 'connecting'].includes(link.pc.connectionState) &&
      !link.crypto.identityVerified
    )
      {count++;}
  }
  return count;
}

async function ensureLink(peerId: string, force = false) {
  if (!deviceAllowed(peerId)) return;
  if (deviceTrust(peerId)?.blocked) return;
  if (typeof RTCPeerConnection === 'undefined') return;
  if (!state.self || !state.peers.has(peerId)) return;
  const link = createLink(peerId);
  if (!force && (link.incompatible || link.gaveUp)) return;
  if (
    !force &&
    link.pc &&
    ['new', 'connecting', 'connected'].includes(link.pc.connectionState) &&
    link.dc?.readyState !== 'closed'
  )
    {return;}

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

  link.dc = null;
  if (link.pc) {
    try {
      closePeerConnection(link.pc);
    } catch {}
  }
  link.pc = new RTCPeerConnection({ iceServers: state.config.iceServers || [] });
  link.peerConnectedAt = state.peers.get(peerId)?.connectedAt;
  link.status = 'connecting';
  link.candidateQueue = [];
  resetCrypto(link);
  attachPeerConnection(link);
  watchNegotiation(link);
  renderPeers();
  renderSession();

  // Lexicographically smaller id offers; the other side knocks to ask for one.
  const initiator = state.self.id.localeCompare(peerId) < 0;
  if (initiator) {
    const pc = link.pc;
    const dc = pc.createDataChannel('evakage-v1', { ordered: true });
    setupDataChannel(link, dc);
    try {
      const offer = await transportTask(pc, pc.createOffer());
      if (link.pc !== pc) return;
      await transportTask(pc, pc.setLocalDescription(offer));
      if (link.pc !== pc) return;
      signal(peerId, { type: 'offer', sdp: pc.localDescription });
    } catch {
      if (link.pc === pc) scheduleReconnect(peerId);
    }
  } else {
    signal(peerId, { type: 'knock' });
  }
}

// Bounded retry: exponential backoff with jitter, then stop and offer a manual
// retry instead of reconnecting forever against a peer that will not answer.

function scheduleReconnect(peerId: string) {
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

function retryLink(peerId: string) {
  const link = createLink(peerId);
  clearTimeout(link.reconnectTimer ?? undefined);
  link.reconnectTimer = null;
  link.reconnectAttempts = 0;
  link.gaveUp = false;
  link.incompatible = false;
  ensureLink(peerId, true);
}

function queueSignal(peerId: string, data: any, connectedAt?: number) {
  if (!deviceAllowed(peerId)) return;
  const previous = signalQueues.get(peerId) || Promise.resolve();
  const pending = previous
    .then(() => handleSignal(peerId, data, connectedAt))
    .catch(() => {
      // The transport may have been replaced while an SDP operation was pending.
      if (state.peers.has(peerId) && neededPeerIds().has(peerId)) scheduleReconnect(peerId);
    })
    .finally(() => {
      if (signalQueues.get(peerId) === pending) signalQueues.delete(peerId);
    });
  signalQueues.set(peerId, pending);
  return pending;
}

async function handleSignal(peerId: string, data: any, connectedAt?: number) {
  if (!deviceAllowed(peerId)) return;
  if (deviceTrust(peerId)?.blocked) return;
  if (typeof RTCPeerConnection === 'undefined') return;
  if (!data || typeof data !== 'object') return;
  const known = state.links.get(peerId);
  // Signaling may arrive before replacement presence. The server stamps the
  // sender's registration so neither a knock nor an offer can reuse a previous
  // browser session's transport and ownership proof.
  if (typeof connectedAt === 'number' && Number.isSafeInteger(connectedAt)) {
    const last = Math.max(known?.peerConnectedAt || 0, state.peers.get(peerId)?.connectedAt || 0);
    if (connectedAt < last) return;
    const peer = state.peers.get(peerId);
    if (peer) peer.connectedAt = connectedAt;
    if (known && known.peerConnectedAt !== connectedAt) {
      clearTimeout(known.negotiationTimer ?? undefined);
      clearTimeout(known.reconnectTimer ?? undefined);
      known.reconnectTimer = null;
      const oldPC = known.pc;
      const oldDC = known.dc;
      known.pc = null;
      known.dc = null;
      known.peerConnectedAt = connectedAt;
      known.reconnectAttempts = 0;
      known.gaveUp = false;
      known.incompatible = false;
      resetCrypto(known);
      try {
        oldDC?.close();
      } catch {}
      try {
        closePeerConnection(oldPC);
      } catch {}
    }
  }
  if (known?.incompatible) return;
  if (data.type === 'knock') {
    await ensureLink(peerId);
    return;
  }

  const link = createLink(peerId);
  // Every offer starts a fresh connection, not SDP renegotiation on the old
  // channel. Preserve only ICE queued before the first offer on an empty PC.
  if (data.type === 'offer' && link.pc?.remoteDescription) {
    const oldPC = link.pc;
    const oldDC = link.dc;
    link.pc = null;
    link.dc = null;
    try {
      oldDC?.close();
    } catch {}
    try {
      closePeerConnection(oldPC);
    } catch {}
  }
  if (!link.pc || link.pc.connectionState === 'closed') {
    link.dc = null;
    link.pc = new RTCPeerConnection({ iceServers: state.config.iceServers || [] });
    link.peerConnectedAt = connectedAt ?? state.peers.get(peerId)?.connectedAt;
    link.status = 'connecting';
    link.candidateQueue = [];
    resetCrypto(link);
    attachPeerConnection(link);
    watchNegotiation(link);
  }

  const pc = link.pc;
  const current = () => state.links.get(peerId) === link && link.pc === pc;
  if (data.type === 'offer') {
    await transportTask(pc, pc.setRemoteDescription(data.sdp));
    if (!current()) return;
    for (const candidate of link.candidateQueue.splice(0))
      {await transportTask(pc, pc.addIceCandidate(candidate)).catch(() => {});}
    if (!current()) return;
    const answer = await transportTask(pc, pc.createAnswer());
    if (!current()) return;
    await transportTask(pc, pc.setLocalDescription(answer));
    if (!current()) return;
    signal(peerId, { type: 'answer', sdp: pc.localDescription });
  } else if (data.type === 'answer') {
    // An answer to an offer this link has since abandoned (a reset crossed it in
    // flight) would throw "wrong state: stable". The live negotiation continues.
    if (pc.signalingState !== 'have-local-offer') return;
    await transportTask(pc, pc.setRemoteDescription(data.sdp));
    if (!current()) return;
    for (const candidate of link.candidateQueue.splice(0))
      {await transportTask(pc, pc.addIceCandidate(candidate)).catch(() => {});}
  } else if (data.type === 'ice' && data.candidate) {
    if (pc.remoteDescription)
      {await transportTask(pc, pc.addIceCandidate(data.candidate)).catch(() => {});}
    // Bounded queue: a peer that floods candidates before answering cannot make
    // this tab buffer them without limit.
    else if (link.candidateQueue.length < CAPS.queuedIceCandidates)
      {link.candidateQueue.push(data.candidate);}
  }
}

/* ---------- per-link crypto ---------- */

function resetCrypto(link: Link) {
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
    proofSent: false,
  };
  link.trust = null;
}

function setupDataChannel(link: Link, dc: RTCDataChannel) {
  link.dc = dc;
  dc.binaryType = 'arraybuffer';
  dc.bufferedAmountLowThreshold = LOW_WATER;
  const current = () => state.links.get(link.peerId) === link && link.dc === dc;
  dc.onopen = () => {
    if (current()) {
      startCryptoHandshake(link).catch(() => {
        if (current())
          {abortLink(link, `Could not start the secure exchange with ${displayName(link.peerId)}.`);}
      });
    }
  };
  dc.onclose = () => {
    if (!current()) return;
    if (state.peers.has(link.peerId) && neededPeerIds().has(link.peerId))
      {scheduleReconnect(link.peerId);}
    renderSession();
    renderPeers();
    renderRooms();
  };
  dc.onerror = () => {
    if (current()) toast(`Data channel error with ${displayName(link.peerId)}`);
  };
  // WebRTC delivers frames in order, but asynchronous verification/decryption
  // must finish before the next frame (especially hello -> ownership proof).
  let incoming = Promise.resolve();
  dc.onmessage = (event) => {
    incoming = incoming
      .then(async () => {
        if (current()) await handleDataMessage(link, event.data);
      })
      .catch(() => {
        if (current())
          {abortLink(
            link,
            `Could not complete the secure exchange with ${displayName(link.peerId)}.`,
          );}
      });
  };
}

async function startCryptoHandshake(link: Link) {
  const dc = link.dc;
  if (!dc) return;
  const identity = state.identity;
  if (!identity) throw new Error('Device identity is not ready. Reload and try again.');
  const exchange = link.crypto;
  if (exchange.helloPromise) return exchange.helloPromise;
  if (link.incompatible || exchange.helloSent) return;
  // onopen and an incoming hello may both arrive before generateKey resolves.
  // Both must await the same keypair/hello, rather than publish different keys.
  exchange.helloPromise = (async () => {
    const keyPair = await crypto.subtle.generateKey({ name: 'ECDH', namedCurve: 'P-256' }, true, [
      'deriveKey',
    ]);
    const raw = new Uint8Array(await crypto.subtle.exportKey('raw', keyPair.publicKey));
    if (
      state.links.get(link.peerId) !== link ||
      link.crypto !== exchange ||
      link.dc !== dc ||
      dc.readyState !== 'open'
    )
      {return;}
    exchange.keyPair = keyPair;
    exchange.ownPublic = bytesToBase64(raw);
    exchange.ownNonce = bytesToBase64(crypto.getRandomValues(new Uint8Array(16)));
    exchange.helloSent = true;
    dc.send(
      JSON.stringify({
        kind: 'crypto-hello',
        publicKey: exchange.ownPublic,
        identityKey: identity.identityKey,
        nonce: exchange.ownNonce,
        protocol: PROTOCOL_VERSION,
        min: MIN_PROTOCOL,
        max: PROTOCOL_VERSION,
      }),
    );
    renderSession();
  })();
  return exchange.helloPromise;
}

function abortLink(link: Link, message: string) {
  clearTimeout(link.negotiationTimer ?? undefined);
  link.incompatible = true;
  link.status = 'untrusted';
  try {
    link.dc?.close();
  } catch {}
  try {
    closePeerConnection(link.pc);
  } catch {}
  toast(message);
  renderPeers();
  renderRooms();
  renderSession();
}

// Refuse a peer whose supported range does not overlap ours, and say so, rather
// than deriving a key and failing later on a frame we cannot parse.

function negotiateProtocol(link: Link, hello: any) {
  const theirMin = Number.isInteger(hello.min) ? hello.min : Number(hello.protocol) || 0;
  const theirMax = Number.isInteger(hello.max) ? hello.max : Number(hello.protocol) || 0;
  const agreed = Math.min(PROTOCOL_VERSION, theirMax);
  if (!theirMax || theirMax < MIN_PROTOCOL || theirMin > PROTOCOL_VERSION) {
    // The peer learns of the mismatch only from our hello, which carries our
    // range. Their hello can arrive before ours has started, so start it now,
    // before marking the link incompatible stops startCryptoHandshake.
    const exchange = link.crypto;
    const pendingHello = exchange.helloSent
      ? null
      : exchange.helloPromise ?? startCryptoHandshake(link);
    clearTimeout(link.negotiationTimer ?? undefined);
    link.incompatible = true;
    link.status = 'incompatible';
    link.protocol = null;
    exchange.key = null;
    exchange.identityVerified = false;
    const who = displayName(link.peerId);
    toast(
      theirMax
        ? `${who} speaks Evakage protocol ${theirMin}–${theirMax}; this build speaks ${MIN_PROTOCOL}–${PROTOCOL_VERSION}.`
        : `${who} is running an older Evakage that cannot negotiate a protocol version. Both sides need a reload.`,
    );
    const dc = link.dc;
    const pc = link.pc;
    // Sending/draining a hello does not prove the peer has read it. Its browser
    // may still be opening the channel or processing the incoming frame.
    if (dc?.readyState === 'open' && typeof hello.nonce === 'string' && hello.nonce.length <= 64) {
      dc.send(JSON.stringify({ kind: 'crypto-hello-ack', nonce: hello.nonce }));
    }
    let acknowledgmentTimer: ReturnType<typeof setTimeout> | null = null;
    let closing = false;
    const close = () => {
      if (closing) return;
      closing = true;
      clearTimeout(acknowledgmentTimer ?? undefined);
      exchange.onHelloAcknowledged = undefined;
      dc?.removeEventListener('close', close);
      // DataChannel.close() drains queued messages before completing. Closing
      // the peer connection immediately can discard our version hello instead.
      // Capture this transport so a later replacement cannot be closed here.
      let timer: ReturnType<typeof setTimeout> | null = null;
      const finish = () => {
        clearTimeout(timer ?? undefined);
        dc?.removeEventListener('close', finish);
        try {
          closePeerConnection(pc);
        } catch {}
      };
      if (!dc || dc.readyState === 'closed') {
        finish();
        return;
      }
      dc.addEventListener('close', finish, { once: true });
      // Bound cleanup if the remote transport never completes its close.
      timer = setTimeout(finish, 1000);
      try {
        dc.close();
      } catch {
        finish();
      }
    };
    // Let a hello still being prepared go out before closing, or the peer is
    // left with nothing to report. Then wait for its receipt, with bounded
    // cleanup for older peers that do not acknowledge hellos.
    const waitForAcknowledgment = () => {
      if (exchange.helloAcknowledged || !dc || dc.readyState !== 'open') {
        close();
        return;
      }
      exchange.onHelloAcknowledged = close;
      dc.addEventListener('close', close, { once: true });
      acknowledgmentTimer = setTimeout(close, 5000);
    };
    if (pendingHello) pendingHello.catch(() => {}).finally(waitForAcknowledgment);
    else waitForAcknowledgment();
    renderPeers();
    renderRooms();
    renderSession();
    return false;
  }
  link.protocol = agreed;
  return true;
}

async function handleCryptoHello(link: Link, hello: any) {
  const exchange = link.crypto;
  const dc = link.dc;
  const current = () =>
    state.links.get(link.peerId) === link && link.crypto === exchange && link.dc === dc;
  const identity = state.identity;
  if (!identity) throw new Error('Device identity is not ready. Reload and try again.');
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
  if (!current()) return;
  if (fingerprint !== link.peerId) {
    abortLink(
      link,
      `${displayName(link.peerId)} presented an identity key that does not match its device ID. Refused.`,
    );
    return;
  }

  if (!link.crypto.keyPair) await startCryptoHandshake(link);
  if (!current() || !link.crypto.keyPair) return;

  const remoteKey = await crypto.subtle.importKey(
    'raw',
    base64ToBytes(hello.publicKey),
    { name: 'ECDH', namedCurve: 'P-256' },
    false,
    [],
  );
  if (!current()) return;
  link.crypto.remotePublic = hello.publicKey;
  link.crypto.remoteNonce = hello.nonce;
  link.crypto.remoteIdentity = remoteIdentityRaw;
  const key = await crypto.subtle.deriveKey(
    { name: 'ECDH', public: remoteKey },
    link.crypto.keyPair.privateKey,
    { name: 'AES-GCM', length: 256 },
    false,
    ['encrypt', 'decrypt'],
  );
  if (!current()) return;
  exchange.key = key;
  // Derived from the long-lived fingerprints, so it is stable across sessions.
  const code = await safetyCode(identity.fingerprint, fingerprint);
  if (!current()) return;
  exchange.safety = code;

  await sendProof(link);
  renderSession();
}

async function sendProof(link: Link) {
  if (!link.dc) return;
  if (!link.crypto.ownPublic || !link.crypto.remotePublic || !link.crypto.ownNonce) return;
  const identity = state.identity;
  if (!identity) throw new Error('Device identity is not ready. Reload and try again.');
  if (link.crypto.proofSent || !link.crypto.remoteNonce) return;
  link.crypto.proofSent = true;
  const exchange = link.crypto;
  const dc = link.dc;
  const signature = await signTranscript(
    identity.privateKey,
    transcriptFor({
      signerEcdh: link.crypto.ownPublic,
      peerEcdh: link.crypto.remotePublic,
      signerNonce: link.crypto.ownNonce,
      peerNonce: link.crypto.remoteNonce,
    }),
  );
  if (link.crypto !== exchange || link.dc !== dc || dc.readyState !== 'open') return;
  dc.send(JSON.stringify({ kind: 'crypto-proof', signature }));
}

async function handleCryptoProof(link: Link, message: any) {
  const exchange = link.crypto;
  const dc = link.dc;
  if (
    !link.crypto.ownPublic ||
    !link.crypto.remotePublic ||
    !link.crypto.ownNonce ||
    !link.crypto.remoteNonce
  )
    {return;}
  if (link.incompatible || link.crypto.identityVerified) return;
  if (!link.crypto.key || !link.crypto.remoteIdentity) return;
  if (typeof message.signature !== 'string' || message.signature.length > 256) return;

  // Swap the roles: the peer signed its own ephemeral key and nonce first.
  const ok = await verifyTranscript(
    link.crypto.remoteIdentity,
    message.signature,
    transcriptFor({
      signerEcdh: link.crypto.remotePublic,
      peerEcdh: link.crypto.ownPublic,
      signerNonce: link.crypto.remoteNonce,
      peerNonce: link.crypto.ownNonce,
    }),
  );
  if (state.links.get(link.peerId) !== link || link.crypto !== exchange || link.dc !== dc) return;
  if (!ok) {
    abortLink(
      link,
      `${displayName(link.peerId)} failed to prove ownership of its device key. Refused.`,
    );
    return;
  }

  link.crypto.identityVerified = true;
  link.reconnectAttempts = 0;
  link.gaveUp = false;
  clearTimeout(link.negotiationTimer ?? undefined);
  const previous = deviceTrust(link.peerId);
  link.trust = {
    known: Boolean(previous),
    firstSeen: previous?.firstSeen || Date.now(),
    previousName: previous?.name || '',
  };
  rememberDevice(link.peerId, displayName(link.peerId));

  renderSession();
  renderPeers();
  renderRooms();
  await syncEverythingWith(link);
}

/* ---------- framing ---------- */

async function waitForWritable(dc: RTCDataChannel) {
  if (dc.readyState !== 'open') throw new Error('Data channel is not open');
  if (dc.bufferedAmount <= bufferLimit(channelRates.get(dc) || 0)) return;
  const queued = dc.bufferedAmount;
  const started = performance.now();
  dc.bufferedAmountLowThreshold = Math.floor(bufferLimit(channelRates.get(dc) || 0) / 4);
  await new Promise((resolve, reject) => {
    const onLow = () => {
      const rate =
        (Math.max(0, queued - dc.bufferedAmount) * 1000) / Math.max(1, performance.now() - started);
      const previous = channelRates.get(dc);
      channelRates.set(dc, previous ? 0.3 * rate + 0.7 * previous : rate);
      cleanup();
      resolve(undefined);
    };
    const onClose = () => {
      cleanup();
      reject(new Error('Data channel closed'));
    };
    const timer = setTimeout(() => {
      cleanup();
      reject(new Error('Direct transfer stalled'));
    }, 15000);
    const cleanup = () => {
      clearTimeout(timer);
      dc.removeEventListener('bufferedamountlow', onLow);
      dc.removeEventListener('close', onClose);
    };
    dc.addEventListener('bufferedamountlow', onLow, { once: true });
    dc.addEventListener('close', onClose, { once: true });
  });
}

async function encryptAndSend(link: Link, plain: Uint8Array<ArrayBuffer>) {
  if (!isSecure(link)) throw new Error('Secure channel is not ready');
  await waitForWritable(link.dc);
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const cipher = new Uint8Array(
    await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, link.crypto.key, plain),
  );
  const packet = new Uint8Array(iv.length + cipher.length);
  packet.set(iv, 0);
  packet.set(cipher, iv.length);
  link.dc.send(packet.buffer);
}

async function sendControl(link: Link, obj: object) {
  const json = encoder.encode(JSON.stringify(obj));
  const frame = new Uint8Array(1 + json.length);
  frame[0] = CONTROL_KIND;
  frame.set(json, 1);
  await encryptAndSend(link, frame);
}

async function sendFileChunk(
  link: Link,
  conv: Conversation,
  id: string,
  transferId: string,
  seq: number,
  total: number,
  bytes: Uint8Array,
) {
  const headerBytes = encoder.encode(
    JSON.stringify({ conv: convScope(conv), id, t: transferId, seq, total }),
  );
  const frame = new Uint8Array(1 + 4 + headerBytes.length + bytes.length);
  frame[0] = FILE_CHUNK_KIND;
  new DataView(frame.buffer).setUint32(1, headerBytes.length);
  frame.set(headerBytes, 5);
  frame.set(bytes, 5 + headerBytes.length);
  await encryptAndSend(link, frame);
}

async function handleDataMessage(link: Link, data: string | Blob | ArrayBuffer) {
  if (typeof data === 'string') {
    let msg;
    try {
      msg = JSON.parse(data);
    } catch {
      return;
    }
    if (
      msg.kind === 'crypto-hello' &&
      typeof msg.publicKey === 'string' &&
      msg.publicKey.length <= 256
    ) {
      await handleCryptoHello(link, msg);
    } else if (
      msg.kind === 'crypto-hello-ack' &&
      link.crypto.helloSent &&
      typeof msg.nonce === 'string' &&
      msg.nonce === link.crypto.ownNonce
    ) {
      link.crypto.helloAcknowledged = true;
      link.crypto.onHelloAcknowledged?.();
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
    const plain = new Uint8Array(
      await crypto.subtle.decrypt({ name: 'AES-GCM', iv }, link.crypto.key, cipher),
    );
    await handlePlainFrame(link, plain);
  } catch {
    toast(`Could not decrypt a message from ${displayName(link.peerId)}`);
  }
}

async function handlePlainFrame(link: Link, frame: Uint8Array<ArrayBuffer>) {
  const parsed = parseFrame(frame, CAPS);
  if (!parsed) return;
  const payload = parsed.kind === 'control' ? parsed.message : parsed.header;
  const conv = resolveScope(payload.conv, link.peerId);
  if (!conv) return;
  if (parsed.kind === 'control') await handleControl(link, conv, parsed.message);
  else if (parsed.bytes) receiveFileChunk(link, conv, parsed.header, parsed.bytes);
}

async function handleControl(link: Link, conv: Conversation, msg: any) {
  if (msg.type === 'chat' && msg.message) {
    // A live chat frame must be authored by the peer that sent it. Without this
    // one room member could post as another, since the link authenticates the
    // sender but the envelope's `from` is just data.
    if (msg.message.from !== link.peerId) return;
    const verified = await verifyMessage(msg.message, signedScope(conv));
    if (!verified || !deviceAllowed(link.peerId)) return;
    msg.message = verified;
    const isNew = !conv.messages.has(messageKey(msg.message));
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
    if (conv.kind === 'direct' && accountPeerIds.has(link.peerId)) return;
    if (!conversationMembers(conv).includes(link.peerId)) return;
    let rejected = 0;
    // Bound what one peer can make this tab allocate in a single sync.
    const messages = Array.isArray(msg.messages) ? msg.messages.slice(0, CAPS.syncMessages) : [];
    const files = Array.isArray(msg.files) ? msg.files.slice(0, CAPS.syncFiles) : [];
    // Verify sequentially and yield between batches to bound crypto/UI work.
    for (let i = 0; i < messages.length; i++) {
      const item = messages[i];
      if (
        typeof item?.id === 'string' &&
        typeof item?.from === 'string' &&
        conv.messages.has(messageKey(item))
      )
        {continue;}
      const verified = await verifyMessage(item, signedScope(conv));
      if (verified && deviceAllowed(verified.from)) mergeMessage(conv, verified);
      else rejected++;
      if (i % 16 === 15) await new Promise((resolve) => setTimeout(resolve, 0));
    }
    for (const meta of files) mergeFileMeta(conv, meta);
    if (rejected)
      {toast(
        `Ignored ${rejected} history message${rejected === 1 ? '' : 's'} with invalid or missing author signatures.`,
      );}
    renderSession();
    return;
  }

  if (msg.type === 'file-meta' && msg.file) {
    const meta = msg.file;
    if (!validFileMeta(meta)) return;
    if (!conv.files.has(meta.id) && conv.files.size >= CAPS.filesPerConversation) return;
    const totalChunks = Number.isFinite(meta.totalChunks)
      ? meta.totalChunks
      : Math.ceil(meta.size / CHUNK_SIZE);
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
      offer: ask ? 'pending' : existing?.offer || null,
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
        reason: 'awaiting-consent',
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
          file.awaitingConsent = mergeHolders(file.awaitingConsent).filter(
            (id) => id !== link.peerId,
          );
          toast(`${displayName(link.peerId)} declined ${file.name}`);
        }
        renderSession();
      }
    } else if (file.direction === 'sent' && msg.reason === 'declined') {
      // Declined after the transfer had already paused for consent.
      file.awaitingConsent = mergeHolders(file.awaitingConsent).filter((id) => id !== link.peerId);
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
    if (!isSecure(link)) return;
    const file = conv.files.get(msg.id);
    // Rejoining peers pull bytes on demand; nothing is retransmitted automatically.
    if (!file?.blob) return;
    if (state.activeSends.size >= CAPS.concurrentSends) {
      await sendControl(link, {
        conv: convScope(conv),
        type: 'transfer-cancel',
        id: msg.id,
        transferId: msg.transferId,
        reason: 'busy',
      }).catch(() => {});
      return;
    }
    // A request from a recipient we were waiting on means it said yes.
    if (file.direction === 'sent' && file.awaitingConsent?.length) {
      file.awaitingConsent = file.awaitingConsent.filter((id) => id !== link.peerId);
      renderSession();
    }
    const have = Array.isArray(msg.have) ? msg.have : [];
    await sendBlobTo([link], conv, file.blob, file, have).catch(() => {});
  }
}

const INCOMING_POLICIES = ['auto', 'new', 'always'];

/** * Whether a file from this device needs the user's yes before any bytes are
 * accepted. "New" means first contact: a device this browser had never
 * completed a handshake with before this session, or, for a relayed file from
 * a device never met directly, one with no remembered identity at all. */
function needsConsent(deviceId: string, link?: Link | undefined) {
  if (state.incomingPolicy === 'auto') return false;
  // "Always ask" means every file, even from a device accepted a moment ago.
  if (state.incomingPolicy === 'always') return true;
  if (state.consentedDevices.has(deviceId)) return false;
  if (link?.trust) return link.trust.known === false;
  return !deviceTrust(deviceId);
}

function validFileMeta(meta: any) {
  if (!meta || typeof meta !== 'object') return false;
  if (typeof meta.id !== 'string' || meta.id.length > 64) return false;
  if (typeof meta.name !== 'string' || !meta.name.length || meta.name.length > 512) return false;
  if (!Number.isFinite(meta.size) || meta.size < 0) return false;
  // The admission limit has to hold on receive too, or a peer can declare any
  // size it likes and make this tab allocate against it.
  if (meta.size > state.config.maxFileBytes) return false;
  const totalChunks = meta.totalChunks;
  if (totalChunks != null) {
    if (!Number.isInteger(totalChunks) || totalChunks < 0 || totalChunks > CAPS.fileChunks)
      {return false;}
    // Chunk count and size must agree, so neither can be inflated on its own.
    if (totalChunks !== Math.ceil(meta.size / CHUNK_SIZE)) return false;
  }
  if (meta.sha256 != null && !/^[0-9a-f]{64}$/.test(meta.sha256)) return false;
  return true;
}

const countReceived = (chunks: (Uint8Array | undefined)[]) =>
  chunks.reduce((n, chunk) => n + (chunk ? 1 : 0), 0);
const countReceivedBytes = (chunks: (Uint8Array | undefined)[]) =>
  chunks.reduce((n, chunk) => n + (chunk?.byteLength || 0), 0);

// Compact the chunk indices we already hold into [start, end] runs, so a resume
// request stays small even for a file with a million chunks.

function heldRanges(chunks: (Uint8Array | undefined)[]) {
  const ranges: any[] = [];
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

const inRanges = (ranges: number[][], seq: number) =>
  ranges.some(([start, end]) => seq >= start && seq <= end);

function mergeHolders(...sources: unknown[]): string[] {
  const out = new Set<string>();
  for (const source of sources) {
    if (typeof source === 'string') out.add(source);
    else if (Array.isArray(source))
      {for (const id of source) if (typeof id === 'string') out.add(id);}
  }
  return [...out];
}

/* ---------- conversation state (merge by immutable id) ---------- */

function mergeMessage(
  conv: Conversation,
  message: Message,
  options: { verifiedAuthor?: boolean; relayedBy?: string | null } = {},
) {
  const { verifiedAuthor = true, relayedBy = null } = options;
  if (!message?.id || typeof message.id !== 'string' || message.id.length > 64) return;
  if (typeof message.from !== 'string' || message.from.length > 128) return;
  if (typeof message.text !== 'string' || message.text.length > CAPS.messageChars) return;
  if (conv.messages.has(messageKey(message))) return;
  if (conv.messages.size >= CAPS.messagesPerConversation) return;
  conv.messages.set(messageKey(message), {
    id: message.id,
    text: message.text,
    from: message.from,
    fromName: typeof message.fromName === 'string' ? message.fromName.slice(0, 64) : '',
    at: message.at,
    proof: message.proof,
    verifiedAuthor,
    relayedBy,
  });
}

function mergeFileMeta(conv: Conversation, meta: FileMeta) {
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
    direction: 'history',
  });
}

function fileManifest(conv: Conversation) {
  return [...conv.files.values()].map((file) => ({
    id: file.id,
    name: file.name,
    size: file.size,
    type: file.type || 'application/octet-stream',
    addedAt: file.addedAt,
    from: file.from,
    fromName: file.fromName || '',
    totalChunks: Number.isFinite(file.totalChunks)
      ? file.totalChunks
      : Math.ceil(file.size / CHUNK_SIZE),
    sha256: file.sha256 || null,
    holders: mergeHolders(file.holders, file.blob ? state.self?.id : null),
  }));
}

// Everyone syncs the full manifest with every peer they link to, so a gap one
// peer missed is healed by another. Merging by immutable id makes it idempotent,
// which is why no surviving peer has to be elected as the authority.

async function syncEverythingWith(link: Link) {
  for (const conv of state.conversations.values()) {
    if (!conversationMembers(conv).includes(link.peerId)) continue;
    await syncConversationWith(link, conv);
  }
}

async function syncConversationWith(link: Link, conv: Conversation) {
  if (conv.kind === 'direct' && accountPeerIds.has(link.peerId)) return;
  if (!deviceAllowed(link.peerId)) return;
  const messages = [...conv.messages.values()]
    .filter((message) => !conv.syncAfter || message.at > conv.syncAfter)
    .sort((a, b) => a.at - b.at);
  const channelLimit = link.pc?.sctp?.maxMessageSize || CAPS.controlBytes;
  const maxFrameBytes = Math.min(CAPS.controlBytes, channelLimit - 28);
  try {
    const files = fileManifest(conv).filter(
      (file) => !conv.syncAfter || (file.addedAt || 0) > conv.syncAfter,
    );
    for (const frame of historyFrames(convScope(conv), messages, files, maxFrameBytes)) {
      await sendControl(link, frame);
    }
  } catch {
    /* Link teardown stops sync; the next connection requests it again. */
  }
}

// A device that rejoins a room may already hold secure links to its members:
// they reconnect to an away member as soon as it is back online, and send their
// history then — before the rejoin lands, when it is discarded as belonging to
// a room this device is not in. So on joining, ask each connected member for
// the room's history instead of relying on which side got there first.

function requestRoomHistory(roomId: string) {
  const conv = state.conversations.get(roomConvId(roomId));
  if (!conv) return;
  for (const peerId of onlineMembers(conv)) {
    const link = state.links.get(peerId);
    if (isSecure(link))
      {sendControl(link, { conv: convScope(conv), type: 'sync-request' }).catch(() => {});}
  }
}

/* ---------- sending ---------- */

async function waitForSecure(peerId: string, timeoutMs = 12000) {
  if (typeof RTCPeerConnection === 'undefined')
    {throw new Error('Direct connections are unavailable in this browser.');}
  const link = state.links.get(peerId);
  if (isSecure(link)) return link;
  await ensureLink(peerId);
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    const current = state.links.get(peerId);
    if (isSecure(current)) return current;
    if (current?.gaveUp || current?.incompatible)
      {throw new Error('Direct connection is unavailable');}
    await new Promise((r) => setTimeout(r, 80));
  }
  throw new Error(`Secure connection to ${displayName(peerId)} timed out`);
}

async function sendChat(conv: Conversation, text: string) {
  if (isSelfConversation(conv) && state.ws?.readyState !== WebSocket.OPEN)
    {throw new Error('Reconnect to the server before saving self notes.');}
  const self = state.self;
  if (!self) throw new Error('Waiting for device registration. Try again shortly.');
  assertRecipientsApproved([...onlineMembers(conv), ...(await offlineTargetsFor(conv))]);
  const clean = text.trim();
  if (!clean) return;
  if (!state.identity) throw new Error('Device identity is not ready.');
  const message = await signMessage(state.identity, signedScope(conv), {
    id: crypto.randomUUID(),
    text: clean,
    from: self.id,
    fromName: self.name,
    at: Date.now(),
  });
  mergeMessage(conv, message);
  renderSession();

  const recipients = onlineMembers(conv);
  const offline = await offlineTargetsFor(conv);
  assertRecipientsApproved([...recipients, ...offline]);
  if (!recipients.length && !offline.length) throw unreachableError(conv);

  // Same rule as files: direct where a secure link is available, the relay for
  // every recipient it is not. Each recipient gets the message once. Offline
  // recipients go straight to the relay; there is no link to wait for.
  const canRelay = relayEnabled();

  const direct: any[] = [];

  const viaRelay: string[] = [...offline];
  const relayOnly = canRelay && (viaServerChosen(conv) || isRelayRoom(conv));
  await Promise.all(
    recipients.map(async (peerId) => {
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
      const ready = await waitForSecure(peerId, canRelay ? CHAT_P2P_WAIT_MS : 12000).catch(
        () => null,
      );
      if (ready) {
        direct.push(ready);
      } else {
        viaRelay.push(peerId);
        const stuck = state.links.get(peerId);
        if (stuck) stuck.relayPreferredUntil = Date.now() + RELAY_STICKY_MS;
      }
    }),
  );

  const results = await Promise.allSettled(
    direct.map((link) => sendControl(link, { conv: convScope(conv), type: 'chat', message })),
  );
  results.forEach((result, index) => {
    if (result.status === 'rejected') viaRelay.push(direct[index].peerId);
  });

  if (!viaRelay.length) return;
  if (!canRelay) {
    toast(
      `Message not delivered to ${viaRelay.length} of ${recipients.length} device${recipients.length === 1 ? '' : 's'}`,
    );
    return;
  }
  const relayed = await sendMessageViaRelay(conv, message, viaRelay);
  const stored = conv.messages.get(messageKey(message));
  if (stored && relayed) {
    stored.via = 'relay';
    renderSession();
  }
}

/** Seals a chat message to each recipient and leaves it with the server. */
async function sendMessageViaRelay(conv: Conversation, message: Message, recipientIds: string[]) {
  const identity = state.identity;
  if (!identity) throw new Error('Device identity is not ready.');

  const targets: Array<{ id: string; sealRaw: Uint8Array<ArrayBuffer> }> = [];
  for (const id of recipientIds) {
    const sealRaw = await verifiedSealKey(id);
    if (sealRaw) targets.push({ id, sealRaw });
    else
      {toast(
        `${displayName(id)} cannot receive messages via the server (its key is missing or unverified).`,
      );}
  }
  if (!targets.length) return 0;

  // Keyed by recipient device ID, which is peer-supplied: a Map, not an object.

  const envelopes: Map<string, any> = new Map();
  for (const target of targets) {
    envelopes.set(
      target.id,
      await buildMessageEnvelope({
        identity,
        recipientId: target.id,
        recipientSealRaw: target.sealRaw,
        conv: convScope(conv),
        message,
      }),
    );
  }

  // One sealed copy per recipient, so a long message to a large room can exceed
  // what the server accepts in one frame. Pack recipients into as few frames as
  // fit; each frame becomes its own item on the server.
  const makeFrame = (subset: Array<[string, any]>) => ({
    type: 'blob-offer',
    requestId: crypto.randomUUID(),
    kind: 'message',
    conv: convScope(conv),
    bytes: 0,
    chunkSize: 1,
    totalChunks: 0,
    envelopes: Object.fromEntries(subset),
  });

  const batches: Array<Array<[string, any]>> = [];

  let batch: Array<[string, any]> = [];
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

/** * Recipients who are offline but can still be reached by leaving the item on
 * the server. For a direct conversation with a device we have no record of yet
 * (say, after a reload), ask the server for it first. */
async function offlineTargetsFor(conv: Conversation) {
  if (!relayEnabled()) return [];
  if (isSelfConversation(conv) && state.self) return [state.self.id];
  if (conv.kind === 'direct' && !state.peers.has(conv.peerId) && !isRecentlySeen(conv.peerId)) {
    await lookupDevices([conv.peerId]);
  }
  return relayOnlyMembers(conv);
}

function unreachableError(conv: Conversation) {
  if (conv.kind === 'room')
    {return new Error('Nobody else in this room is online or reachable through the server.');}
  return new Error(
    relayEnabled()
      ? `That device has not been online in the last ${relayWindowText()}, so there is nowhere to leave this for it.`
      : 'That device is offline.',
  );
}

// Direct first; the relay takes whichever recipients a direct link could not
// reach, either because ICE never connected or because the link died part-way.
// A recipient therefore gets each file exactly once, by one path or the other.

async function sendFiles(conv: Conversation, fileList: FileList | File[]) {
  if (isSelfConversation(conv) && state.ws?.readyState !== WebSocket.OPEN)
    {throw new Error('Reconnect to the server before saving files to yourself.');}
  const self = state.self;
  if (!self) throw new Error('Waiting for device registration. Try again shortly.');
  const recipients = onlineMembers(conv);
  const offline = await offlineTargetsFor(conv);
  assertRecipientsApproved([...recipients, ...offline]);
  if (!recipients.length && !offline.length) throw unreachableError(conv);

  const canRelay = relayEnabled();
  // A large room is relay-only: one upload serves every member.
  const skipDirect = canRelay && (viaServerChosen(conv) || isRelayRoom(conv));

  let links: any[] = [];
  if (!skipDirect && recipients.length) {
    const wait = canRelay ? P2P_WAIT_WITH_RELAY_MS : 12000;
    await Promise.all(
      recipients.map(async (id) => {
        const current = state.links.get(id);
        if (isSecure(current) || (canRelay && (current?.relayPreferredUntil || 0) > Date.now()))
          {return;}
        const ready = await waitForSecure(id, wait).catch(() => null);
        const stalled = state.links.get(id);
        if (!ready && canRelay && stalled)
          {stalled.relayPreferredUntil = Date.now() + RELAY_STICKY_MS;}
      }),
    );
    links = recipients.map((id) => state.links.get(id)).filter(isSecure);
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
      from: self.id,
      fromName: self.name,
      totalChunks: Math.ceil(file.size / CHUNK_SIZE),
      sha256: null as string | null,
    };

    const record: any = {
      ...meta,
      holders: [self.id],
      blob: file,
      chunks: null,
      progress: 0,
      hashing: true,
      complete: true,
      available: true,
      direction: 'sent',
    };
    conv.files.set(meta.id, record);
    renderSession();

    // Hash before the first byte goes out so the digest can ride in the metadata
    // and stay correct even if a later resume only re-sends part of the file.
    meta.sha256 = await hashBlob(file, CHUNK_SIZE, (fraction) => {
      record.progress = fraction;
      updateFileProgress(conv, record);
    });
    record.sha256 = meta.sha256;
    record.hashing = false;
    record.progress = 0;
    renderSession();

    const direct = links.filter(isSecure);
    const needRelay = [
      ...recipients.filter((id) => !direct.some((link) => link.peerId === id)),
      ...offline,
    ];
    if (direct.length) {
      let outcome;
      try {
        outcome = await sendBlobTo(direct, conv, file, meta);
      } catch {
        outcome = { failed: direct.map((link) => link.peerId), cancelled: false };
      }
      if (outcome?.cancelled) continue;
      needRelay.push(...(outcome?.failed || []));
    }

    if (!needRelay.length) continue;
    if (!canRelay) {
      toast(
        `${file.name} did not reach ${needRelay.length} device${needRelay.length === 1 ? '' : 's'}.`,
      );
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

async function sendBlobTo(
  links: SecureLink[],
  conv: Conversation,
  blob: Blob,
  meta: FileMeta,
  alreadyHeld: number[][] = [],
) {
  const totalChunks = Math.ceil(blob.size / CHUNK_SIZE);
  const transferId = crypto.randomUUID();
  // `cancelled` is the sender stopping the whole upload; `cancelledPeers` is
  // individual recipients stopping it for themselves (declining, or pausing to
  // ask first) while it carries on to everyone else.
  const transfer = {
    transferId,
    cancelled: false,
    cancelledPeers: new Set<string>(),
    fileId: meta.id,
    name: meta.name,
  };
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
    holders: mergeHolders(meta.holders, state.self?.id),
  };

  const local = conv.files.get(meta.id);
  const trackProgress = local?.direction === 'sent';
  if (trackProgress) {
    local.transferId = transferId;
    fileStats.set(local, new TransferStats(local.size));
  }

  try {
    await Promise.all(
      links.map((link) =>
        sendControl(link, {
          conv: convScope(conv),
          type: 'file-meta',
          file: wire,
          transferId,
        }).catch(() => {}),
      ),
    );

    let alive = links.slice();
    // Links that die mid-transfer are remembered rather than dropped silently,
    // so the caller can finish those recipients over the relay.

    const failed: string[] = [];
    let sent = 0;
    for (let seq = 0; seq < totalChunks; seq++) {
      if (transfer.cancelled) {
        await Promise.all(
          alive.map((link) =>
            sendControl(link, {
              conv: convScope(conv),
              type: 'transfer-cancel',
              id: meta.id,
              transferId,
              reason: 'cancelled',
            }).catch(() => {}),
          ),
        );
        if (trackProgress) local.transferId = null;
        renderSession();
        return { sent, failed: [], cancelled: true };
      }
      // Recipients that stopped the transfer for themselves drop out quietly:
      // they are neither sent to nor counted as failed (and so not relayed to).
      alive = alive.filter((link) => !transfer.cancelledPeers.has(link.peerId));
      if (!alive.length) return { sent, failed, cancelled: false };
      if (inRanges(alreadyHeld, seq)) continue;

      const start = seq * CHUNK_SIZE;
      const bytes = new Uint8Array(
        await blob.slice(start, Math.min(blob.size, start + CHUNK_SIZE)).arrayBuffer(),
      );
      const settled = await Promise.all(
        alive.map(async (link) => {
          try {
            await sendFileChunk(link, conv, meta.id, transferId, seq, totalChunks, bytes);
            return link;
          } catch {
            return null;
          }
        }),
      );
      for (const [index, result] of settled.entries()) {
        if (!result) failed.push(alive[index].peerId);
      }
      alive = settled.filter((link) => link !== null);
      if (!alive.length) return { sent, failed, cancelled: false };
      sent++;
      if (trackProgress) {
        local.progress = (seq + 1) / totalChunks;
        updateFileProgress(conv, local);
      }
    }

    alive = alive.filter((link) => !transfer.cancelledPeers.has(link.peerId));
    await Promise.all(
      alive.map((link) =>
        sendControl(link, {
          conv: convScope(conv),
          type: 'file-complete',
          id: meta.id,
          transferId,
          sha256: wire.sha256,
        }).catch(() => {}),
      ),
    );
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

async function uploadCipherChunk(url: string, offset: number, part: Blob) {
  const response = await fetch(`${url}&offset=${offset}`, { method: 'PUT', body: part });
  if (response.status !== 204) throw new Error('Upload interrupted. Restart from the beginning.');
}

/* ---------- server relay ---------- */

// WebSocket request/response pairing for the relay: the server echoes a
// request id (offers) or the blob id (claims) back on the reply.

function awaitReply(key: string, send: () => void, timeoutMs: number = 20000) {
  return new Promise<Record<string, any>>((resolve, reject) => {
    const timer = setTimeout(() => {
      state.pendingRequests.delete(key);
      reject(new Error('The server did not answer in time.'));
    }, timeoutMs);
    state.pendingRequests.set(key, { resolve, reject, timer });
    send();
  });
}

function settleRequest(key: string, value: any, error?: Error) {
  const pending = key && state.pendingRequests.get(key);
  if (!pending) return;
  state.pendingRequests.delete(key);
  clearTimeout(pending.timer);
  if (error) pending.reject(error);
  else pending.resolve(value);
}

/** * A peer's seal key, but only if it is bound to the device id we are talking to:
 * the advertised identity key must hash to that id and must have signed the
 * seal key. Presence comes from the server, so this is what stops a hostile
 * server from substituting its own key and reading the file. */
async function verifiedSealKey(peerId: string) {
  if (!deviceAllowed(peerId)) return null;
  // A live presence record, or the last one we have for a device now offline.
  // Either way it is checked below; where it came from does not matter.
  const peer =
    peerId === state.identity?.deviceId
      ? state.identity
      : state.peers.get(peerId) || state.deviceRecords.get(peerId);
  if (!peer?.sealKey || !peer.identityKey || !peer.sealKeySignature) return null;
  const cacheKey = [peerId, peer.identityKey, peer.sealKey, peer.sealKeySignature].join('|');
  if (state.sealKeyCache.has(cacheKey)) return state.sealKeyCache.get(cacheKey);
  const verified = await verifyAdvertisedIdentity({
    deviceId: peerId,
    identityKey: peer.identityKey,
    sealKey: peer.sealKey,
    sealKeySignature: peer.sealKeySignature,
  });
  const result = verified ? verified.sealRaw : null;
  state.sealKeyCache.set(cacheKey, result);
  return result;
}

async function sendViaRelay(
  conv: Conversation,
  blob: Blob,
  meta: FileMeta,
  record: FileRecord,
  recipientIds: string[],
) {
  const identity = state.identity;
  if (!identity) throw new Error('Device identity is not ready.');
  const chunkSize = state.config.relay?.chunkSize ?? RELAY_CHUNK_FALLBACK;
  const { totalChunks, bytes } = cipherLayout(blob.size, chunkSize);

  const targets: Array<{ id: string; sealRaw: Uint8Array<ArrayBuffer> }> = [];
  for (const id of recipientIds) {
    const sealRaw = await verifiedSealKey(id);
    if (sealRaw) targets.push({ id, sealRaw });
    else
      {toast(
        `${displayName(id)} cannot receive files via the server (its key is missing or unverified).`,
      );}
  }
  if (!targets.length) throw new Error('no recipient could be verified');

  record.via = 'relay';
  record.relayStage = 'encrypting';
  record.progress = 0;
  renderSession();

  const { raw, key } = await generateContentKey();

  const envelopes: Map<string, any> = new Map();
  for (const target of targets) {
    envelopes.set(
      target.id,
      await buildEnvelope({
        identity,
        recipientId: target.id,
        recipientSealRaw: target.sealRaw,
        meta: { ...meta, chunkSize, totalChunks },
        contentKeyRaw: raw,
        conv: convScope(conv),
      }),
    );
  }

  const requestId = crypto.randomUUID();
  const offered = await awaitReply(requestId, () =>
    wsSend({
      type: 'blob-offer',
      requestId,
      conv: convScope(conv),
      bytes,
      chunkSize,
      totalChunks,
      envelopes: Object.fromEntries(envelopes),
    }),
  );

  record.relayStage = 'uploading';
  record.relayBlobId = offered.blobId;
  record.relayExpiresAt = offered.expiresAt;
  record.progress = 0;
  fileStats.set(record, new TransferStats(record.size));
  renderSession();

  record.retryUpload = async () => {
    record.retryUpload = undefined;
    try {
      await sendViaRelay(conv, blob, meta, record, recipientIds);
    } catch (err) {
      record.relayStage = 'failed';
      renderSession();
      throw err;
    }
  };
  try {
    const url = `/blob/${encodeURIComponent(offered.blobId)}?token=${encodeURIComponent(offered.uploadToken)}`;
    let offset = 0;
    for await (const part of encryptBodyChunks(blob, key, meta.id, chunkSize)) {
      assertRecipientsApproved(targets.map((target) => target.id));
      await uploadCipherChunk(url, offset, part);
      offset += part.size;
      record.progress = bytes ? offset / bytes : 1;
      updateFileProgress(conv, record);
    }
    if (bytes === 0) await uploadCipherChunk(url, 0, new Blob());
    record.retryUpload = undefined;
  } catch (err) {
    wsSend({ type: 'blob-cancel', blobId: offered.blobId });
    record.relayBlobId = undefined;
    record.relayStage = 'failed';
    record.progress = 0;
    renderSession();
    throw err;
  }

  record.relayStage = 'uploaded';
  record.progress = 1;
  renderSession();
  toast(
    `${meta.name} is on the server for ${targets.length} device${targets.length === 1 ? '' : 's'}.`,
  );
}

async function handleBlobAvailable(notice: any) {
  const identity = state.identity;
  if (!identity) throw new Error('Device identity is not ready. Reload and try again.');
  if (!notice?.blobId || !deviceAllowed(notice.from)) return;
  if (state.relayInbound.has(notice.blobId)) {
    // Re-announcement after reconnect does not restart an interrupted download.
    // The user can explicitly start it again from byte zero.
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
      sealPrivateKey: identity.sealPrivateKey,
      box: notice.envelope,
      selfId: identity.deviceId,
      expectedFrom: notice.from,
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
  const candidate = {
    id: meta.id,
    name: meta.name,
    size: meta.size,
    sha256: meta.sha256,
    totalChunks: Math.ceil(meta.size / CHUNK_SIZE),
  };
  if (!validFileMeta(candidate) || (!existing && conv.files.size >= CAPS.filesPerConversation)) {
    wsSend({ type: 'blob-release', blobId: notice.blobId });
    return;
  }

  const record: FileRecord = Object.assign(existing || {}, {
    ...candidate,
    type: meta.type || 'application/octet-stream',
    addedAt: Number(meta.addedAt) || Date.now(),
    from: notice.from,
    fromName: typeof meta.fromName === 'string' ? meta.fromName.slice(0, 64) : '',
    holders: mergeHolders(existing?.holders),
    blob: null,
    chunks: null,
    progress: 0,
    complete: false,
    corrupt: false,
    direction: 'received' as const,
    via: 'relay' as const,
    transferId: null,
    sourceId: null,
    relayStage: 'downloading' as const,
    relayBlobId: notice.blobId,
    relayMeta: meta,
    relayKey: contentKey,
    relayConvId: conv.id,
    relayExpiresAt: notice.expiresAt,
  });
  conv.files.set(meta.id, record);

  // Same rule as a direct transfer. Nothing is fetched until the user says yes;
  // the item simply waits on the server meanwhile.
  if (
    !isSelfConversation(conv) &&
    record.offer !== 'accepted' &&
    needsConsent(notice.from, state.links.get(notice.from))
  ) {
    record.offer = 'pending';
    record.relayStage = 'offered';
    renderSession();
    notifyOffer(conv, record);
    return;
  }
  renderSession();
  await downloadRelayed(conv, record);
}

async function handleRelayedMessage(notice: any) {
  const identity = state.identity;
  if (!identity) throw new Error('Device identity is not ready. Reload and try again.');
  let opened;
  try {
    opened = await openMessageEnvelope({
      sealPrivateKey: identity.sealPrivateKey,
      box: notice.envelope,
      selfId: identity.deviceId,
      expectedFrom: notice.from,
      maxChars: CAPS.messageChars,
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

  const verified = await verifyMessage(opened.message, signedScope(conv));
  if (!verified) {
    wsSend({ type: 'blob-release', blobId: notice.blobId });
    toast('Refused a message without a valid author signature.');
    return;
  }
  const isNew = !conv.messages.has(messageKey(opened.message));
  // The author is the device that signed the envelope, so unlike history
  // recovered through a peer sync this is verified authorship.
  mergeMessage(conv, verified, { verifiedAuthor: true, relayedBy: null });
  const stored = conv.messages.get(messageKey(opened.message));
  if (stored && isNew) stored.via = 'relay';
  wsSend({ type: 'blob-release', blobId: notice.blobId });
  renderSession();
  if (isNew) notifyIncoming(conv, opened.message);
}

// A message for a conversation that is not open gets a notice with a way into
// it. That matters most for relayed messages, whose sender may already be
// offline and so have no row in the device table to click.

function notifyIncoming(conv: Conversation, message: Message) {
  if (state.activeConvId === conv.id) return;
  const who = displayName(message.from);
  const where = conv.kind === 'room' ? ` in ${conversationTitle(conv)}` : '';
  toast(`New message from ${who}${where}`, {
    label: 'Open',
    run: () =>
      openConversation(
        conv.id,
        conv.kind,
        conv.kind === 'room' ? conv.roomId : conv.peerId,
        'text',
      ),
  });
}

/** A guard that throws once the sender is blocked or forgotten, or the work is aborted. */
function relayGuard(record: FileRecord, controller: AbortController) {
  return () => {
    if (record.from && !deviceAllowed(record.from))
      {throw new Error('Sender authorization was revoked.');}
    controller.signal.throwIfAborted();
  };
}

/** Claims a relayed item afresh and opens its ciphertext body. */
async function fetchRelayBody(record: FileRecord, signal: AbortSignal) {
  const claim = await awaitReply(`claim:${record.relayBlobId}`, () =>
    wsSend({ type: 'blob-claim', blobId: record.relayBlobId }),
  );
  const response = await fetch(
    `/blob/${encodeURIComponent(record.relayBlobId || '')}?token=${encodeURIComponent(claim.downloadToken)}`,
    {
      cache: 'no-store',
      signal,
    },
  );
  if (!response.ok || !response.body) {
    throw Object.assign(new Error(`download failed (${response.status})`), {
      gone: response.status === 404 || response.status === 410,
    });
  }
  return response.body;
}

/** Network reads, checking authorization around each one. */
async function* guardedReads(body: ReadableStream<Uint8Array>, check: () => void) {
  const reader = body.getReader();
  try {
    for (;;) {
      check();
      const { value, done } = await reader.read();
      check();
      if (done) return;
      yield value;
    }
  } finally {
    await reader.cancel().catch(() => {});
  }
}

/** * Downloads and verifies a relayed file. Where the browser can stream a save to
 * disk, this is the verify pass of two-pass receiving: the plaintext is checked
 * and discarded, keeping a digest per chunk, and the server copy stays until
 * Save fetches it again (saveRelayed). Otherwise the verified plaintext is kept
 * in memory for Save, and the server copy is released at once. */
async function downloadRelayed(conv: Conversation, record: FileRecord) {
  if (record.from && !deviceAllowed(record.from))
    {throw new Error('This device is blocked or unverified.');}
  if (!record.relayBlobId || !record.relayKey || !record.relayMeta)
    {throw new Error('This relayed file is no longer available.');}
  if (record.relayAbort) return;
  const controller = new AbortController();
  record.relayAbort = controller;
  const assertSenderAllowed = relayGuard(record, controller);
  const twoPass = streamSaveAvailable();
  record.relayStage = 'downloading';
  record.relayDigests = null;
  record.progress = 0;
  renderSession();
  try {
    const decryptor = createBodyDecryptor({
      key: record.relayKey,
      fileId: record.id,
      chunkSize: record.relayMeta.chunkSize,
      size: record.size,
      retain: !twoPass,
    });
    const body = await fetchRelayBody(record, controller.signal);
    for await (const bytes of guardedReads(body, assertSenderAllowed)) {
      await decryptor.push(bytes);
      assertSenderAllowed();
      record.progress = decryptor.progress;
      updateFileProgress(conv, record);
    }
    assertSenderAllowed();
    const { chunks, digests, sha256 } = decryptor.finish();

    if (sha256 !== record.sha256) {
      record.corrupt = true;
      record.relayStage = 'failed';
      renderSession();
      toast(`${record.name} failed its SHA-256 check and was discarded.`);
      return;
    }

    record.complete = true;
    record.available = true;
    record.verified = true;
    record.progress = 1;
    if (twoPass) {
      // Nothing of the file is kept; the key and digests let Save fetch it again
      // and prove every chunk is the one just verified.
      record.relayDigests = digests;
      record.relayStage = 'verified';
    } else {
      record.blob = new Blob(chunks as BlobPart[], { type: record.type });
      record.relayStage = 'received';
      record.holders = mergeHolders(record.holders, state.self?.id);
      // Drop the key and metadata now the bytes are safe; nothing else needs them.
      record.relayKey = null;
      wsSend({ type: 'blob-release', blobId: record.relayBlobId });
    }
    renderSession();
    toast(`Received ${record.name} via server · SHA-256 verified`);
  } catch (err) {
    record.relayStage = 'failed';
    record.progress = 0;
    renderSession();
    toast(`Could not download ${record.name}: ${err.message}`);
  } finally {
    record.relayAbort = undefined;
  }
}

/** * The save pass of two-pass receiving: fetches the relayed file again and
 * streams it to disk, passing on only chunks identical to the verified pass.
 * Any mismatch, revocation or interruption fails the browser download instead
 * of completing it. The server copy is released once the save completes. */
async function saveRelayed(conv: Conversation, record: FileRecord) {
  if (record.relayAbort || record.relayStage !== 'verified') return;
  if (record.from && !deviceAllowed(record.from)) {
    toast(`Cannot save ${record.name}: the sender is blocked or unverified.`);
    return;
  }
  const { relayKey: key, relayMeta: meta, relayDigests: digests } = record;
  if (!record.relayBlobId || !key || !meta || !digests || !record.sha256) return;
  const controller = new AbortController();
  record.relayAbort = controller;
  record.relayStage = 'saving';
  renderSession();
  const sha256 = record.sha256;
  const options = {
    key,
    fileId: record.id,
    chunkSize: meta.chunkSize,
    size: record.size,
    sha256,
    digests,
  };
  try {
    const body = await fetchRelayBody(record, controller.signal);
    const plaintext = verifiedPlaintext(
      guardedReads(body, relayGuard(record, controller)),
      options,
    );
    try {
      await saveStream({
        name: record.name,
        size: record.size,
        source: plaintext,
        signal: controller.signal,
      });
    } catch (err) {
      if (!(err instanceof StreamSaveUnavailable)) throw err;
      // This browser would not stream the download. Nothing has been read yet,
      // so save the same verified stream from memory instead.

      const parts: BlobPart[] = [];
      for await (const chunk of plaintext) parts.push(chunk as Uint8Array<ArrayBuffer>);
      saveBlob(new Blob(parts, { type: record.type }), record.name);
    }
    record.relayStage = 'saved';
    record.relayKey = null;
    record.relayDigests = null;
    wsSend({ type: 'blob-release', blobId: record.relayBlobId });
  } catch (err) {
    if (err?.gone || /no longer available|not addressed/.test(err?.message || '')) {
      // The server dropped it between the passes; the verified copy cannot be fetched again.
      record.relayStage = 'gone';
      record.relayKey = null;
      record.relayDigests = null;
      toast(`${record.name} is no longer on the server, so it cannot be saved.`);
    } else {
      record.relayStage = 'verified';
      toast(`Could not save ${record.name}: ${err.message}`);
    }
  } finally {
    // Closes the fetch if the save stopped before reading all of it.
    controller.abort();
    record.relayAbort = undefined;
    renderSession();
  }
}

function cancelTransfer(conv: Conversation, file: FileRecord) {
  // Either side can stop a transfer: cancel our own upload, or tell the sender
  // to stop pushing to us. Partial chunks are kept for a later resume.
  for (const send of state.activeSends.values()) {
    if (send.fileId === file.id) send.cancelled = true;
  }
  if (file.transferId && file.direction === 'received') {
    const holder = file.sourceId && state.links.get(file.sourceId);
    if (holder && isSecure(holder)) {
      sendControl(holder, {
        conv: convScope(conv),
        type: 'transfer-cancel',
        id: file.id,
        transferId: file.transferId,
        reason: 'cancelled',
      }).catch(() => {});
    }
    file.transferId = null;
  }
  renderSession();
}

/* ---------- receiving files ---------- */

function receiveFileChunk(
  link: Link,
  conv: Conversation,
  header: any,
  bytes: Uint8Array<ArrayBuffer>,
) {
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

async function finalizeIncomingFile(
  conv: Conversation,
  fileId: string,
  declaredHash: string | null | undefined,
) {
  const file = conv.files.get(fileId);
  // A tiny file's completion can arrive before the sender saw our "wait".
  if (file?.offer === 'pending' || file?.offer === 'declined') return;
  if (!file?.chunks || countReceived(file.chunks) !== file.chunks.length) {
    toast(`Transfer incomplete: ${file?.name || 'file'}`);
    return;
  }

  const expected = typeof declaredHash === 'string' ? declaredHash : file.sha256;
  if (expected && /^[0-9a-f]{64}$/.test(expected)) {
    file.verifying = true;
    renderSession();
    const actual = hashChunks(file.chunks.filter((chunk) => chunk !== undefined));
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

  file.blob = new Blob(
    file.chunks.filter((chunk) => chunk !== undefined),
    { type: file.type || 'application/octet-stream' },
  );
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

async function requestFile(conv: Conversation, file: FileRecord) {
  const holder = mergeHolders(file.holders)
    .filter((id) => id !== state.self?.id && state.peers.has(id))
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
  file.progress =
    Array.isArray(file.chunks) && file.chunks.length
      ? countReceived(file.chunks) / file.chunks.length
      : 0;
  await sendControl(link, {
    conv: convScope(conv),
    type: 'file-request',
    id: file.id,
    transferId,
    have,
  });
  renderSession();
}

/* ---------- accepting and declining incoming files ---------- */

async function acceptOffer(conv: Conversation, file: FileRecord) {
  // Saying yes once trusts that device for the rest of the session, so a burst
  // of files from it does not become a burst of prompts.
  if (file.from) state.consentedDevices.add(file.from);
  file.offer = 'accepted';
  renderSession();
  try {
    if (file.via === 'relay') await downloadRelayed(conv, file);
    else await requestFile(conv, file);
  } catch (err) {
    toast(err.message || `Could not fetch ${file.name}`);
  }
}

function declineOffer(conv: Conversation, file: FileRecord) {
  file.offer = 'declined';
  file.chunks = null;
  file.progress = 0;
  if (file.via === 'relay') {
    // Our copy is no longer wanted; the server can drop it for us now.
    wsSend({ type: 'blob-release', blobId: file.relayBlobId });
    file.relayStage = 'declined';
    file.relayKey = null;
  } else {
    const link = state.links.get(file.sourceId || file.from || '');
    if (isSecure(link)) {
      sendControl(link, {
        conv: convScope(conv),
        type: 'transfer-cancel',
        id: file.id,
        transferId: null,
        reason: 'declined',
      }).catch(() => {});
    }
  }
  renderSession();
}

function notifyOffer(conv: Conversation, file: FileRecord) {
  const who = displayName(file.from);
  const text = `${who} wants to send you ${file.name} (${formatBytes(file.size)})`;
  if (state.activeConvId === conv.id) {
    toast(text);
    return;
  }
  toast(text, {
    label: 'Review',
    run: () =>
      openConversation(conv.id, conv.kind, conv.kind === 'room' ? conv.roomId : conv.peerId),
  });
}

function downloadFile(file: FileRecord) {
  if (file.blob) saveBlob(file.blob, file.name);
}

function saveBlob(blob: Blob, name: string) {
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = name;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 30000);
}

/* ---------- session panel ---------- */

function getPeer(peerId: string) {
  const known = state.deviceRecords.get(peerId);
  return (
    state.peers.get(peerId) || {
      id: peerId,
      name: displayName(peerId),
      code: 'offline',
      platform: known?.platform || 'Unknown',
      browser: known?.browser || 'Browser',
    }
  );
}

function openConversation(convId: string, kind: 'direct' | 'room', ref: string, focus = 'chat') {
  if (
    kind === 'direct' &&
    ref !== state.self?.id &&
    !accountPeerIds.has(ref) &&
    !deviceTrust(ref)?.pairedAt
  ) {
    openCodePairing(ref);
    return;
  }
  const conv = ensureConversation(convId, kind, ref);
  const wasClosed = state.activeConvId !== convId;
  if (wasClosed) {
    // Store the key as well as the element: the row that opened the panel is
    // very likely to be re-rendered before the panel closes again.
    state.panelReturnFocus = document.activeElement;
    state.panelReturnKey = focusKeyOf(document.activeElement);
    delete timeline.dataset.conversationId;
  }
  state.activeConvId = convId;

  // `hidden` keeps the panel out of the accessibility tree while closed, so it
  // has to come off before the slide-in transition can run.
  sessionPanel.hidden = false;
  requestAnimationFrame(() => sessionPanel.classList.add('open'));

  // Render now rather than on the next tick, so the panel never flashes the
  // previous conversation (or one just deleted) as it opens.
  renderSessionNow();
  ensureConversationLinks(conv);

  if (focus === 'text') setTimeout(() => messageInput.focus(), 80);
  else if (focus === 'file') setTimeout(() => fileInput.click(), 80);
  else if (wasClosed) setTimeout(() => $('#closeSession').focus(), 80);
}

const openSession = (peerId: string, focus = 'chat') =>
  openConversation(directConvId(peerId), 'direct', peerId, focus);
const openRoom = (roomId: string, focus = 'chat') =>
  openConversation(roomConvId(roomId), 'room', roomId, focus);

function closeSessionPanel() {
  if (!state.activeConvId) return;
  sessionPanel.classList.remove('open');
  sessionPanel.classList.remove('dragging');
  state.activeConvId = null;

  // Hide only once it has slid out, so the panel is not yanked off screen.
  const hide = () => {
    if (!state.activeConvId) sessionPanel.hidden = true;
  };
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

function leaveRoom(roomId: string) {
  wsSend({ type: 'leave-room', roomId });
  state.joinedRoomIds.delete(roomId);
  forgetConversation(roomConvId(roomId));
  renderRooms();
}

/* ---------- rendering ---------- */

// The tables are rebuilt wholesale on every presence update and every stats
// tick, which detaches whatever the user had focused. Keyed controls let focus
// be put back on the logically-same button afterwards.

function focusKeyOf(element: Element | null) {
  return element instanceof HTMLElement && element.dataset.focusKey
    ? element.dataset.focusKey
    : null;
}

function findByFocusKey(key: string | null) {
  if (!key) return null;
  const match = document.querySelector(`[data-focus-key="${CSS.escape(key)}"]`);
  return match instanceof HTMLElement ? match : null;
}

function withPreservedFocus(render: () => void) {
  const key = focusKeyOf(document.activeElement);
  render();
  if (!key) return;
  findByFocusKey(key)?.focus();
}

function formatStatus(status: string) {
  const map: Record<string, string> = {
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
    queued: 'Queued',
  };
  return map[status] || status;
}

function trustLabel(link: Link | undefined) {
  if (!isSecure(link)) return null;
  const trust = deviceTrust(link.peerId);
  if (trust?.blocked) return 'Blocked device';
  if (trust?.verifiedAt)
    {return `Verified by safety code on ${new Date(trust.verifiedAt).toLocaleDateString()}`;}
  if (!link.trust) return 'Identity proved';
  return link.trust.known
    ? `Known device since ${new Date(link.trust.firstSeen).toLocaleDateString()}`
    : 'New device — compare the safety code';
}

function renderPeers() {
  withPreservedFocus(renderPeersNow);
}

function renderPeersNow() {
  peerRows.textContent = '';
  const peers = [...state.peers.values()]
    .filter((peer) => !deviceTrust(peer.id)?.hidden)
    .sort((a, b) => a.name.localeCompare(b.name));
  if (state.self)
    {peers.unshift({ ...state.self, platform: detectPlatform(), browser: detectBrowser() });}
  for (const peer of peers) {
    const isSelf = peer.id === state.self?.id;
    const link = state.links.get(peer.id);
    const tr = document.createElement('tr');
    tr.dataset.dropTarget = peer.id;
    tr.dataset.dropKind = 'direct';
    tr.title = 'Drop a file here to send it to this device';

    const nameTd = document.createElement('td');
    nameTd.dataset.label = 'Device ID';
    const nameWrap = document.createElement('div');
    nameWrap.className = 'device-name';
    const pip = document.createElement('span');
    pip.className = 'presence-pip';
    const name = document.createElement('span');
    name.textContent = peer.name.replace(/^Device /, '');
    nameWrap.append(pip, name);
    // Sort by the name alone, not the badges that follow it.
    nameTd.dataset.sort = name.textContent;
    if (isSelf) {
      tr.classList.add('self-device');
      const badge = document.createElement('strong');
      badge.className = 'self-badge';
      badge.textContent = 'This is you';
      nameWrap.append(badge);
    }
    // Trust state belongs next to the name, not buried in a tooltip.
    const trust = trustLabel(link);
    if (trust && link) {
      const badge = document.createElement('span');
      badge.className = link.trust?.known === false ? 'trust-badge new' : 'trust-badge';
      const remembered = deviceTrust(peer.id);
      badge.textContent = remembered?.blocked
        ? 'blocked'
        : remembered?.verifiedAt
          ? 'verified'
          : link.trust?.known === false
            ? 'new'
            : 'known';
      badge.title = `${trust} · safety code ${link.crypto.safety}`;
      nameWrap.append(badge);
    }
    nameTd.append(nameWrap);
    if (accountPeerIds.has(peer.id)) {
      const badge = document.createElement('span');
      badge.className = 'trust-badge';
      badge.textContent = 'This is yours';
      badge.title = 'Signed into the same account as this device';
      nameWrap.append(badge);
    }

    const platformTd = document.createElement('td');
    platformTd.dataset.label = 'Platform';
    platformTd.textContent = `${peer.platform} · ${peer.browser}`;

    const statusTd = document.createElement('td');
    statusTd.dataset.label = 'Status';
    statusTd.textContent = isSelf
      ? 'Your browser'
      : deviceTrust(peer.id)?.blocked
        ? 'Blocked'
        : formatStatus(link?.status || 'idle');
    if (link?.gaveUp || link?.incompatible) statusTd.classList.add('danger');
    if (link?.protocol) statusTd.title = `Evakage protocol v${link.protocol}`;

    // The candidate path answers "is this actually peer-to-peer, or going
    // through TURN?" — worth keeping for a slow transfer, but not worth a
    // column of its own. It hangs off Status instead.
    if (link?.path) {
      const rtt = link.rttMs != null ? ` · ${Math.round(link.rttMs)} ms` : '';
      statusTd.title =
        link.path === 'relay'
          ? `Relayed through TURN${rtt}: slower, and the relay sees traffic metadata.`
          : `${link.pathDetail || link.path}${rtt}`;
      if (link.path === 'relay') statusTd.classList.add('danger');
    }

    const actionsTd = document.createElement('td');
    actionsTd.className = 'actions-col';
    // One way in and one way out. The session panel already carries text and
    // file controls, so opening it is the only thing a row needs to do.
    actionsTd.append(rowActions(peer.id, isSelf ? 'yourself' : peer.name, link));
    tr.append(nameTd, platformTd, statusTd, actionsTd);
    peerRows.append(tr);
  }

  const offline = offlineDevicesToList();
  for (const record of offline) peerRows.append(renderOfflineRow(record));
  // Status is a few fixed states rather than free text, so its column filter
  // is a select.
  const scope = $('#deviceScope').value;
  const visible = applyTableView(
    peerRows,
    (row) => {
      const id = row.dataset.dropTarget;
      const own = id === state.self?.id || accountPeerIds.has(id || '');
      const offline = row.classList.contains('offline');
      return (
        scope === 'all' ||
        (scope === 'yours' && own) ||
        (scope === 'online' && !offline) ||
        (scope === 'offline' && offline)
      );
    },
    scope !== 'all',
  );
  emptyPeers.classList.toggle('hidden', !peerRows.rows.length || visible > 0);
}

function matchesTableSearch(value: string, query: string) {
  const normalize = (text: string) => text.normalize('NFKC').toLowerCase().replace(/[-\s·]+/g, '');
  const normalized = normalize(value);
  return query.trim().split(/\s+/).every((term) => normalized.includes(normalize(term)));
}

/** Sort from the headers and filter from the section's menu. */
function applyTableView(
  tbody: HTMLTableSectionElement,
  keep: (row: HTMLTableRowElement) => boolean = () => true,
  extraActive: boolean = false,
): number {
  const table = tbody.closest('table') as HTMLTableElement;
  const section = table.closest('.peers-card') as HTMLElement;
  const filters = [...section.querySelectorAll('input[data-col]')]
    .map(
      (input) =>
        [
          Number((input as HTMLInputElement).dataset.col),
          (input as HTMLInputElement).value.trim().toLowerCase(),
        ] as const,
    )
    .filter(([, query]) => query);
  const rows = [...tbody.rows];
  const search = (section.querySelector('input[data-search]') as HTMLInputElement).value.trim();
  const sorted = table.querySelector('th[aria-sort="ascending"], th[aria-sort="descending"]');
  if (sorted instanceof HTMLTableCellElement) {
    const column = sorted.cellIndex;
    const direction = sorted.getAttribute('aria-sort') === 'descending' ? -1 : 1;
    const valueOf = (row: HTMLTableRowElement) =>
      row.cells[column]?.dataset.sort ?? row.cells[column]?.textContent ?? '';
    rows.sort(
      (a, b) =>
        valueOf(a).localeCompare(valueOf(b), undefined, { numeric: true, sensitivity: 'base' }) *
        direction,
    );
  }
  let visible = 0;
  for (const row of rows) {
    row.hidden =
      !keep(row) ||
      !matchesTableSearch([...row.cells].slice(0, -1).map((cell) => cell.textContent || '').join(' '), search) ||
      filters.some(
        ([column, query]) => !matchesTableSearch(row.cells[column]?.textContent || '', query),
      );
    if (!row.hidden) visible++;
    tbody.append(row);
  }
  const filtering = filters.length > 0 || extraActive || Boolean(search);
  const filterButton = section.querySelector('.table-filter-button') as HTMLButtonElement;
  filterButton.classList.toggle('is-active', filtering);
  filterButton.setAttribute('aria-label', filtering ? 'Filter (active)' : 'Filter');
  return visible;
}

function renderTable(table: HTMLTableElement) {
  if (table.contains(peerRows)) renderPeers();
  else renderRooms();
}

for (const table of document.querySelectorAll('.peers-card table')) {
  if (!(table instanceof HTMLTableElement)) continue;
  table.tHead?.addEventListener('click', (event) => {
    const target = event.target as Element;
    const sortButton = target.closest('.sort-button');
    if (sortButton) {
      // Ascending, descending, then back to the table's natural order.
      const th = sortButton.closest('th') as HTMLTableCellElement;
      const next =
        { none: 'ascending', ascending: 'descending', descending: 'none' }[
          th.getAttribute('aria-sort') || 'none'
        ] || 'none';
      for (const other of table.querySelectorAll('th[aria-sort]'))
        {other.setAttribute('aria-sort', 'none');}
      th.setAttribute('aria-sort', next);
      renderTable(table);
    }
  });
  const panel = table.closest('.peers-card')?.querySelector('.table-filters');
  panel?.addEventListener('input', () => renderTable(table));
  panel?.querySelector('.clear-filters')?.addEventListener('click', () => {
    for (const field of panel.querySelectorAll('input, select')) {
      if (field instanceof HTMLInputElement) field.value = '';
      if (field instanceof HTMLSelectElement) field.selectedIndex = 0;
    }
    if (table.contains(peerRows)) $('#deviceScope').value = 'all';
    renderTable(table);
    (panel.querySelector('input[data-search]') as HTMLInputElement).focus();
  });
}
$('#deviceScope').addEventListener('change', renderPeers);

// Offline devices worth listing: seen within the window, and ones this browser
// has actually dealt with — a remembered device or an open conversation. Not
// every stranger who was ever online on the server.
function offlineDevicesToList() {
  if (!relayEnabled()) return [];
  return [...state.deviceRecords.values()]
    .filter((record) => isRecentlySeen(record.id) && !deviceTrust(record.id)?.hidden)
    .filter((record) => deviceTrust(record.id) || state.conversations.has(directConvId(record.id)))
    .sort((a, b) => (b.lastSeen || 0) - (a.lastSeen || 0));
}

const ICONS = {
  gear: '<path d="M9 3h6l1 3 3 1 2 5-2 5-3 1-1 3H9l-1-3-3-1-2-5 2-5 3-1z"/><circle cx="12" cy="12" r="3"/>',
  trash:
    '<path d="M4 7h16M10 11v6M14 11v6M5 7l1 13a1 1 0 0 0 1 1h10a1 1 0 0 0 1-1l1-13M9 7V4h6v3"/>',
};

function iconButton(icon: keyof typeof ICONS, label: string) {
  const button = document.createElement('button');
  button.type = 'button';
  button.className = 'ghost row-icon';
  button.title = label;
  button.setAttribute('aria-label', label);
  button.innerHTML = `<svg viewBox="0 0 24 24" aria-hidden="true">${ICONS[icon]}</svg>`;
  return button;
}

/** Per-device adjustments, kept out of the row until asked for. */
type MenuItem = { text: string; run: () => void; checked?: boolean };

function deviceMenuItems(peerId: string, label: string) {
  const items: MenuItem[] = [];
  if (peerId === state.self?.id) return items;
  const record = deviceTrust(peerId);
  if (record && !record.blocked) {
    items.push({
      text: record.verifiedAt ? 'Compare code' : 'Verify',
      run: () => openPairing(peerId),
    });
  }
  // Your account's devices always stay listed and reachable.
  if (!accountPeerIds.has(peerId)) {
    items.push({
      text: 'Hide',
      run: () => {
        hideDevice(peerId, label, true);
        renderKnownDevices();
        renderPeers();
      },
    });
    if (record) {
      items.push({
        text: record.blocked ? 'Unblock' : 'Block',
        run: () => {
          blockDevice(peerId, !record.blocked);
          releaseIdleLinks();
          renderKnownDevices();
          renderPeers();
          renderSession();
        },
      });
    }
  }
  return items;
}

let deviceMenu: HTMLElement | null = null;

/** A small menu under a row's gear. Items with `checked` are a choice of one. */
function openRowMenu(anchor: HTMLButtonElement, menuLabel: string, entries: MenuItem[]) {
  if (!deviceMenu) {
    deviceMenu = document.createElement('div');
    deviceMenu.className = 'device-menu';
    deviceMenu.setAttribute('popover', 'auto');
    deviceMenu.setAttribute('role', 'menu');
    deviceMenu.addEventListener('keydown', (event) => {
      const items = [...deviceMenu!.querySelectorAll('button')];
      const at = items.indexOf(document.activeElement as HTMLButtonElement);
      const step = { ArrowDown: 1, ArrowUp: -1 }[event.key];
      if (!step) return;
      event.preventDefault();
      items[(at + step + items.length) % items.length]?.focus();
    });
    document.body.append(deviceMenu);
  }
  const menu = deviceMenu;
  menu.textContent = '';
  menu.setAttribute('aria-label', menuLabel);
  for (const item of entries) {
    const button = document.createElement('button');
    button.type = 'button';
    button.className = 'ghost';
    if (item.checked === undefined) button.setAttribute('role', 'menuitem');
    else {
      button.setAttribute('role', 'menuitemradio');
      button.setAttribute('aria-checked', String(item.checked));
    }
    button.textContent = item.text;
    button.addEventListener('click', () => {
      menu.hidePopover();
      item.run();
    });
    menu.append(button);
  }
  menu.showPopover();
  const rect = anchor.getBoundingClientRect();
  const gap = 6;
  menu.style.left = `${Math.max(gap, Math.min(rect.right - menu.offsetWidth, innerWidth - menu.offsetWidth - gap))}px`;
  menu.style.top = `${rect.bottom + menu.offsetHeight + gap > innerHeight ? rect.top - menu.offsetHeight - gap : rect.bottom + gap}px`;
  menu.querySelector('button')?.focus();
}

/** Every device row offers the same three things: open the conversation,
 * adjust the device, or delete the conversation. The session panel carries
 * text and file sending, so a row does not need its own buttons for them. */
function rowActions(peerId: string, label: string, link: Link | null | undefined) {
  const actions = document.createElement('div');
  actions.className = 'row-actions';

  const open = document.createElement('button');
  open.type = 'button';
  open.textContent = 'Open';
  open.dataset.focusKey = `peer:${peerId}:open`;
  open.setAttribute('aria-label', `Open conversation with ${label}`);
  open.addEventListener('click', () => {
    // Opening is also how a link that has given up gets another go, now that
    // there is no separate Retry button.
    if (link?.gaveUp || link?.incompatible) retryLink(peerId);
    openSession(peerId, 'chat');
  });
  actions.append(open);

  // Every row keeps all three controls, so rows line up and never resize.
  const settings = iconButton('gear', `Settings for ${label}`);
  settings.setAttribute('aria-haspopup', 'menu');
  settings.dataset.focusKey = `peer:${peerId}:settings`;
  settings.disabled = deviceMenuItems(peerId, label).length === 0;
  settings.addEventListener('click', () =>
    openRowMenu(settings, `Settings for ${label}`, deviceMenuItems(peerId, label)),
  );
  actions.append(settings);

  const exit = iconButton('trash', `Delete conversation with ${label}`);
  exit.title =
    'Delete local conversation history and disconnect unused links. Stored pairing remains.';
  exit.dataset.focusKey = `peer:${peerId}:exit`;
  exit.addEventListener('click', () => forgetConversation(directConvId(peerId)));
  actions.append(exit);
  return actions;
}

function renderOfflineRow(record: Device) {
  const tr = document.createElement('tr');
  tr.className = 'offline';
  tr.dataset.dropTarget = record.id;
  tr.dataset.dropKind = 'direct';
  tr.title =
    state.ws?.readyState === WebSocket.OPEN
      ? `Offline. Anything you send waits on the server for up to ${relayWindowText()}.`
      : 'Status unknown while signaling is disconnected. Reconnect before sending through the server.';

  const cell = (label: string, text: string) => {
    const td = document.createElement('td');
    td.dataset.label = label;
    td.textContent = text;
    return td;
  };

  const nameTd = document.createElement('td');
  nameTd.dataset.label = 'Device ID';
  const nameWrap = document.createElement('div');
  nameWrap.className = 'device-name';
  const pip = document.createElement('span');
  pip.className = 'presence-pip offline';
  const name = document.createElement('span');
  name.textContent = (record.name || displayName(record.id)).replace(/^Device /, '');
  nameTd.dataset.sort = name.textContent;
  nameWrap.append(pip, name);
  nameTd.append(nameWrap);

  // The same window the server uses to keep this device listed at all, so the
  // row never offers a device whose deadline has already passed.
  const windowMs = state.config.relay?.soloMaxMs ?? 3 * 60 * 60 * 1000;
  const left = expiryState((record.lastSeen || 0) + windowMs);
  const statusTd = cell(
    'Status',
    `${state.ws?.readyState === WebSocket.OPEN ? 'Offline' : 'Status unknown'} · seen ${formatAgo(record.lastSeen)}${left ? ` · ${left.text}` : ''}`,
  );
  statusTd.classList.add('muted');
  if (left?.warn) {
    statusTd.classList.add('expiring');
    statusTd.title =
      'Nearly out of time. When this passes, the device drops off the list and anything left for it is deleted.';
  }

  const actionsTd = document.createElement('td');
  actionsTd.className = 'actions-col';
  actionsTd.append(
    rowActions(record.id, `${record.name || 'offline device'} (offline, via server)`, null),
  );

  tr.append(
    nameTd,
    cell('Platform', `${record.platform || 'Unknown'} · ${record.browser || 'Browser'}`),
    statusTd,
    actionsTd,
  );
  return tr;
}

function renderRooms() {
  withPreservedFocus(renderRoomsNow);
}

/** The account-wide default for rooms this device creates. */
function newRoomAccess(): RoomAccess {
  try {
    return localStorage.getItem('evakage-room-access') === 'protected' ? 'protected' : 'private';
  } catch {
    return 'private';
  }
}

const ROOM_ACCESS: Array<{ value: RoomAccess; text: string }> = [
  { value: 'private', text: 'Private · approve who joins' },
  { value: 'protected', text: 'Protected · anyone with the code' },
  { value: 'public', text: 'Public · listed for everyone' },
];

function roomAccessItems(room: Room): MenuItem[] {
  return ROOM_ACCESS.map(({ value, text }) => ({
    text,
    checked: (room.access || 'private') === value,
    run: () => wsSend({ type: 'room-access', roomId: room.id, access: value }),
  }));
}

const announcedRequests = new Set<string>();

/** Tell the creator once about each new request; the room shows it until answered. */
function announceJoinRequests() {
  const current = new Set<string>();
  for (const room of state.rooms.values()) {
    for (const device of room.requests || []) {
      const key = `${room.id}:${device.id}`;
      current.add(key);
      if (announcedRequests.has(key)) continue;
      announcedRequests.add(key);
      const conv = activeConversation();
      if (conv?.kind !== 'room' || conv.roomId !== room.id) {
        toast(`${device.name} wants to join ${room.name}. Open the room to approve.`);
      }
    }
  }
  for (const key of announcedRequests) if (!current.has(key)) announcedRequests.delete(key);
}

function answerJoinRequest(roomId: string, deviceId: string, approve: boolean) {
  wsSend({ type: 'room-approve', roomId, deviceId, approve });
}

/** Requests to join appear at the top of the creator's room chat. */
function renderJoinRequests(conv: Conversation) {
  const box = $('#joinRequests');
  const room = conv.kind === 'room' ? state.rooms.get(conv.roomId) : undefined;
  const requests = room?.requests || [];
  box.hidden = !requests.length;
  box.textContent = '';
  for (const device of requests) {
    const row = document.createElement('div');
    row.className = 'join-request';
    const text = document.createElement('span');
    text.textContent = `${device.name} wants to join`;
    const approve = document.createElement('button');
    approve.type = 'button';
    approve.textContent = 'Approve';
    approve.setAttribute('aria-label', `Approve ${device.name}`);
    approve.addEventListener('click', () => answerJoinRequest(room!.id, device.id, true));
    const decline = document.createElement('button');
    decline.type = 'button';
    decline.className = 'ghost';
    decline.textContent = 'Decline';
    decline.setAttribute('aria-label', `Decline ${device.name}`);
    decline.addEventListener('click', () => answerJoinRequest(room!.id, device.id, false));
    row.append(text, approve, decline);
    box.append(row);
  }
}

function renderRoomsNow() {
  roomRows.textContent = '';
  // Oldest first is the natural order; the column headers sort from there.
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
    if (room.access && (joined || room.access === 'public')) {
      const badge = document.createElement('span');
      badge.className = 'trust-badge';
      badge.textContent = room.access;
      badge.title = ROOM_ACCESS.find((option) => option.value === room.access)?.text || '';
      nameWrap.append(badge);
    }
    nameTd.append(nameWrap);

    // A room code is a private invitation: it is shared from the open room,
    // not shown in the list.
    const away = room.away || [];

    // Away members keep their seat, so they count toward the size. A listing
    // for a non-member carries the count without the members.
    const seats = room.seats ?? room.members.length + away.length;
    const countTd = document.createElement('td');
    countTd.dataset.label = 'Size';
    countTd.textContent = `${seats} / ${room.maxMembers}`;

    const statusTd = document.createElement('td');
    statusTd.dataset.label = 'Links';
    if (room.awaiting) {
      statusTd.textContent = 'Waiting for approval';
    } else if (!joined) {
      statusTd.textContent = room.access === 'public' ? 'Public · not joined' : 'Not joined';
    } else {
      const others = conv ? onlineMembers(conv) : [];
      const secured = others.filter((id) => isSecure(state.links.get(id))).length;
      const base =
        room.transport === 'relay'
          ? 'Via server · large room'
          : others.length
            ? `${secured} / ${others.length} encrypted`
            : 'Waiting for members';
      const awayOthers = away.filter((m) => m.id !== state.self?.id).length;
      const waiting = room.requests?.length || 0;
      statusTd.textContent = [base, awayOthers && `${awayOthers} away`, waiting && `${waiting} waiting`]
        .filter(Boolean)
        .join(' · ');
    }

    const actionsTd = document.createElement('td');
    actionsTd.className = 'actions-col';
    const actions = document.createElement('div');
    actions.className = 'row-actions';
    const open = document.createElement('button');
    open.type = 'button';
    open.textContent = 'Open';
    open.dataset.focusKey = `room:${room.id}:open`;
    open.setAttribute('aria-label', `Open room ${room.name}`);
    if (joined) {
      open.addEventListener('click', () => openRoom(room.id));
    } else if (room.awaiting) {
      open.disabled = true;
    } else {
      // Joining and opening are one action: nobody joins a room in order not to
      // look at it. The panel opens when the server confirms the seat.
      open.disabled = seats >= room.maxMembers;
      open.addEventListener('click', () => {
        state.pendingOpenRoomId = room.id;
        wsSend({ type: 'join-room', roomId: room.id });
      });
    }
    actions.append(open);

    // Room settings belong to its creator; nobody else sees the gear.
    if (joined && room.owned) {
      const settings = iconButton('gear', `Settings for room ${room.name}`);
      settings.setAttribute('aria-haspopup', 'menu');
      settings.dataset.focusKey = `room:${room.id}:settings`;
      settings.addEventListener('click', () =>
        openRowMenu(settings, `Who can join ${room.name}`, roomAccessItems(room)),
      );
      actions.append(settings);
    }
    if (joined || room.awaiting) {
      const exit = iconButton(
        'trash',
        room.awaiting ? `Cancel request to join ${room.name}` : `Delete local room ${room.name}`,
      );
      exit.dataset.focusKey = `room:${room.id}:exit`;
      exit.addEventListener('click', () => leaveRoom(room.id));
      actions.append(exit);
    }
    actionsTd.append(actions);
    tr.append(nameTd, countTd, statusTd, actionsTd);
    roomRows.append(tr);
  }
  const visible = applyTableView(roomRows);
  $('#noRoomMatches').classList.toggle('hidden', !rooms.length || visible > 0);
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

function updateFileProgress(conv: Conversation, file: FileRecord) {
  if (!file.hashing && !file.verifying) {
    let stats = fileStats.get(file);
    if (!stats) {
      stats = new TransferStats(file.size);
      fileStats.set(file, stats);
    }
    stats.update(file.size * Math.max(0, Math.min(1, file.progress || 0)));
  }
  if (state.activeConvId !== conv.id) return;
  const bar = timeline.querySelector(
    `.file-item[data-file-id="${CSS.escape(file.id)}"] .file-progress`,
  );
  if (bar instanceof HTMLProgressElement)
    {bar.value = Number.isFinite(file.progress) ? file.progress : 0;}
  else renderSession();
  const label = timeline.querySelector(
    `.file-item[data-file-id="${CSS.escape(file.id)}"] .file-estimate`,
  );
  if (label) label.textContent = transferEstimate(file);
}

function transferEstimate(file: FileRecord) {
  if (
    file.hashing ||
    file.verifying ||
    file.progress >= 1 ||
    file.offer === 'pending' ||
    (!file.transferId && !['uploading', 'downloading'].includes(file.relayStage || ''))
  )
    {return '';}
  const estimate = fileStats.get(file)?.estimate();
  if (!estimate) return '';
  const seconds = Math.ceil(estimate.secondsRemaining);
  const remaining = seconds < 60 ? `${seconds}s` : `${Math.ceil(seconds / 60)} min`;
  return `${formatBytes(estimate.bytesPerSecond)}/s · about ${remaining} remaining`;
}

function renderSessionNow() {
  const conv = activeConversation();
  if (!conv) return;

  // Follow new entries only while reading the latest. Keep an older entry in
  // place when transfers update or recovered history is inserted above it.
  const scrollTop = timeline.scrollTop;
  const followLatest =
    timeline.dataset.conversationId !== conv.id ||
    timeline.scrollHeight - scrollTop - timeline.clientHeight <= 48;
  const timelineTop = timeline.getBoundingClientRect().top;
  const anchor = followLatest
    ? undefined
    : [...timeline.children].find((node) => node.getBoundingClientRect().bottom > timelineTop);
  const anchorKey = anchor instanceof HTMLElement ? anchor.dataset.timelineKey : undefined;
  const anchorOffset = anchor ? anchor.getBoundingClientRect().top - timelineTop : 0;

  sessionTitle.textContent = conversationTitle(conv);
  sessionKind.textContent = isSelfConversation(conv)
    ? 'temporary encrypted private notes'
    : conv.kind === 'room'
      ? 'temporary room · end-to-end encrypted'
      : 'temporary session · end-to-end encrypted';
  leaveRoomBtn.classList.toggle('hidden', conv.kind !== 'room');
  // Self-notes always go through the server, so the toggle means nothing there.
  $('#relayToggle').classList.toggle(
    'hidden',
    !relayEnabled() || isSelfConversation(conv) || (conv.kind === 'room' && !ownsRoom(conv)),
  );

  if (conv.kind === 'direct') {
    const peer = getPeer(conv.peerId);
    const offlineRecord = !state.peers.has(conv.peerId)
      ? state.deviceRecords.get(conv.peerId)
      : null;
    sessionMeta.hidden = false;
    $('#roomCodeLine').hidden = true;
    sessionMeta.textContent = isSelfConversation(conv)
      ? 'Only this browser can read these.'
      : offlineRecord
        ? `${peer.platform} · ${peer.browser} · ${state.ws?.readyState === WebSocket.OPEN ? 'offline' : 'status unknown'}, seen ${formatAgo(offlineRecord.lastSeen)}`
        : `${peer.platform} · ${peer.browser} · ${peer.code}`;
  } else {
    // Members only ever see the code here, never in the room list.
    const room = state.rooms.get(conv.roomId);
    sessionMeta.hidden = Boolean(room);
    sessionMeta.textContent = room ? '' : 'This room is unavailable';
    $('#roomCodeLine').hidden = !room;
    $('#roomCodeText').textContent = room?.code || '';
  }

  renderMembers(conv);
  renderJoinRequests(conv);

  const others = onlineMembers(conv);
  if (conv.kind === 'direct') {
    const link = state.links.get(conv.peerId);
    if (isSelfConversation(conv)) {
      secureState.textContent =
        state.ws?.readyState === WebSocket.OPEN ? 'Encrypted' : 'Encrypted · server disconnected';
      secureState.title =
        '24h reconnect window · 3-day limit. Recover with this browser’s device identity. Reconnecting refreshes the inactivity window; the 3-day limit stays fixed.';
      secureState.classList.add('ready');
      secureState.classList.remove('unverified');
    } else if (isSecure(link)) {
      secureState.textContent = `Encrypted · ${link.crypto.safety}`;
      secureState.title = `${trustLabel(link)}. This safety code is derived from both devices' long-lived keys and will not change.`;
      secureState.classList.add('ready');
      secureState.classList.toggle('unverified', link.trust?.known === false);
    } else if (link?.status === 'untrusted') {
      secureState.textContent = 'Identity refused';
      secureState.classList.remove('ready');
    } else if (typeof RTCPeerConnection === 'undefined' && relayEnabled()) {
      secureState.textContent = 'Via server · direct connections unavailable';
      secureState.classList.remove('ready');
    } else if (!deviceAllowed(conv.peerId)) {
      secureState.textContent = 'Pairing required';
      secureState.title = 'Pair by code or QR, or sign into the same account on both devices.';
      secureState.classList.remove('ready');
    } else if (!state.peers.has(conv.peerId)) {
      // Nothing to connect to; say what will actually happen to a message.
      secureState.textContent =
        state.ws?.readyState !== WebSocket.OPEN
          ? 'Status unknown · server disconnected'
          : isRecentlySeen(conv.peerId)
            ? 'Offline · messages wait on the server'
            : 'Offline';
      secureState.title = `Sealed to this device and left on the server for up to ${relayWindowText()}.`;
      secureState.classList.remove('ready');
    } else {
      secureState.textContent =
        link?.dc?.readyState === 'open' ? 'Verifying device identity…' : 'Connecting…';
      secureState.classList.remove('ready');
    }
  } else if (isRelayRoom(conv)) {
    // No links at all in a large room: everything is sealed to each member and
    // signed by the sender, then goes through the server.
    secureState.textContent = 'Large room · sealed to each member via server';
    secureState.title = `Past ${state.config.roomMeshMax || 6} devices a room stops opening direct connections between every pair and uses the server relay instead.`;
    secureState.classList.add('ready');
  } else {
    const secured = others.filter((id) => isSecure(state.links.get(id))).length;
    secureState.textContent = others.length
      ? `${secured} of ${others.length} links encrypted`
      : 'Waiting for other members';
    secureState.classList.toggle('ready', others.length > 0 && secured === others.length);
  }

  timeline.textContent = '';

  const items: (
    | { kind: 'message'; at: number; value: Message }
    | { kind: 'file'; at: number; value: FileRecord }
  )[] = [];
  for (const message of conv.messages.values())
    {items.push({ kind: 'message', at: message.at, value: message });}
  for (const file of conv.files.values())
    {items.push({ kind: 'file', at: file.addedAt || 0, value: file });}
  items.sort((a, b) => a.at - b.at);

  if (!items.length) {
    const empty = document.createElement('div');
    empty.className = 'timeline-empty';
    empty.textContent = isSelfConversation(conv)
      ? 'Send yourself a message or upload files.'
      : 'Nothing here yet. Messages and files live only in participant browser memory.';
    timeline.append(empty);
  }

  for (const item of items) {
    if (item.kind === 'message') renderMessage(conv, item.value);
    else renderFile(conv, item.value);
  }
  timeline.dataset.conversationId = conv.id;
  timeline.scrollTop = followLatest ? timeline.scrollHeight : scrollTop;
  if (!followLatest && anchorKey) {
    const nextAnchor = timeline.querySelector(`[data-timeline-key="${CSS.escape(anchorKey)}"]`);
    if (nextAnchor) {
      timeline.scrollTop += nextAnchor.getBoundingClientRect().top - timelineTop - anchorOffset;
    }
  }
}

function renderMembers(conv: Conversation) {
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
      chip.title =
        'Large room: messages to this member are sealed to its key and sent via the server.';
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
    chip.title = `Dropped off ${formatAgo(member.awaySince)}. Messages and files are left on the server for it until it rejoins, for up to ${relayWindowText()}.`;
    sessionMembers.append(chip);
  }
}

function requiredChild<K extends keyof HTMLElementTagNameMap>(
  root: Element,
  selector: string,
  tag: K,
): HTMLElementTagNameMap[K] {
  const element = root.querySelector(selector);
  if (!element || element.localName !== tag) throw new Error(`Missing ${tag}: ${selector}`);
  return element as HTMLElementTagNameMap[K];
}

function cloneTemplate(template: HTMLTemplateElement): HTMLElement {
  const root = template.content.firstElementChild;
  if (!(root instanceof HTMLElement)) throw new Error('Template needs an HTML root');
  return root.cloneNode(true) as HTMLElement;
}

function renderMessage(conv: Conversation, message: Message) {
  const node = cloneTemplate($('#messageTemplate'));
  node.dataset.timelineKey = `message:${messageKey(message)}`;
  const mine = message.from === state.self?.id;
  if (mine) node.classList.add('self');
  const author = requiredChild(node, '.message-author', 'div');
  if (conv.kind === 'room' && !mine) {
    author.textContent = displayName(message.from);
    // Only cryptographically verified authorship earns the verified UI state.
    if (!message.verifiedAuthor) {
      author.classList.add('unverified');
      author.textContent += ' · relayed';
      author.title = `Recovered from ${displayName(message.relayedBy)}; authorship is not verified.`;
    }
  } else {
    author.remove();
  }
  appendLinkifiedText(requiredChild(node, '.message-bubble', 'div'), message.text);
  const time = new Date(message.at).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });
  // As with files, say when a message took the server path.
  requiredChild(node, '.message-time', 'div').textContent =
    message.via === 'relay' ? `${time} · via server` : time;
  timeline.append(node);
}

function appendLinkifiedText(container: Element, text: string) {
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

function renderFile(conv: Conversation, file: FileRecord) {
  const node = cloneTemplate($('#fileTemplate'));
  node.dataset.fileId = file.id;
  node.dataset.timelineKey = `file:${file.id}`;
  node.classList.toggle('self', file.from === state.self?.id);
  requiredChild(node, '.message-time', 'div').textContent = file.addedAt
    ? new Date(file.addedAt).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' })
    : '';
  requiredChild(node, '.file-name', 'strong').textContent = file.name;
  const owner = file.from === state.self?.id ? 'sent by you' : `from ${displayName(file.from)}`;

  const details = [formatBytes(file.size), owner];
  // Say which path a file took: it is the first thing to check when one path
  // works on a network and the other does not.
  if (file.via === 'relay') details.push('via server');
  if (file.direction === 'received' && file.offer === 'pending')
    {details.push('wants to send you this');}
  if (file.direction === 'received' && file.offer === 'declined') details.push('declined');
  const waitingOn = file.direction === 'sent' ? (file.awaitingConsent || []).length : 0;
  if (waitingOn)
    {details.push(
      `waiting for ${waitingOn === 1 ? displayName(file.awaitingConsent?.[0]) : `${waitingOn} devices`} to accept`,
    );}
  // Only while the server is still holding it: once collected it is released,
  // and a file that arrived is the receiver's own copy with no deadline.
  // A file verified for a streamed save is still collected from the server on Save.
  const waitingOnServer =
    file.via === 'relay' &&
    (file.direction === 'sent'
      ? file.relayStage === 'uploaded'
      : !file.complete || file.relayStage === 'verified');
  const expiry = waitingOnServer ? expiryState(file.relayExpiresAt) : null;
  if (expiry) details.push(expiry.cap ? `session ends · ${expiry.text}` : expiry.text);
  if (file.hashing) details.push('hashing…');
  else if (file.verifying) details.push('verifying…');
  else if (file.corrupt) details.push('SHA-256 mismatch');
  else if (file.verified && file.sha256) details.push(`SHA-256 ✓ ${file.sha256.slice(0, 12)}`);
  else if (file.sha256) details.push(`SHA-256 ${file.sha256.slice(0, 12)}`);
  const metaLine = requiredChild(node, '.file-meta', 'div');
  metaLine.textContent = details.join(' · ');
  metaLine.classList.toggle('danger', Boolean(file.corrupt));
  metaLine.classList.toggle('expiring', Boolean(expiry?.warn));
  if (expiry?.warn) {
    metaLine.title = expiry.cap
      ? 'This session is at its three-day limit. Start a new conversation to keep sending.'
      : 'The server drops this when the countdown ends.';
  }
  if (file.sha256) metaLine.title = `SHA-256 ${file.sha256}`;

  const progress = requiredChild(node, '.file-progress', 'progress');
  progress.value = Number.isFinite(file.progress) ? file.progress : file.blob ? 1 : 0;
  requiredChild(node, '.file-estimate', 'div').textContent = transferEstimate(file);

  const actions = requiredChild(node, '.file-actions', 'div');
  const btn = requiredChild(node, '.file-download', 'button');
  const holders = mergeHolders(file.holders).filter(
    (id) => id !== state.self?.id && state.peers.has(id),
  );
  const partial = Array.isArray(file.chunks) && countReceived(file.chunks) > 0;
  const relayBusy = ['encrypting', 'uploading', 'downloading', 'saving'].includes(
    file.relayStage || '',
  );
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
    btn.textContent = file.hashing
      ? 'Hashing…'
      : file.verifying
        ? 'Verifying…'
        : file.relayStage === 'encrypting'
          ? 'Encrypting…'
          : file.relayStage === 'uploading'
            ? 'Uploading…'
            : file.relayStage === 'downloading'
              ? 'Downloading…'
              : file.relayStage === 'saving'
                ? 'Saving…'
                : file.direction === 'sent'
                  ? 'Sending…'
                  : 'Receiving…';
    btn.disabled = true;
    if (file.transferId) {
      const cancel = document.createElement('button');
      cancel.type = 'button';
      cancel.className = 'ghost file-cancel';
      cancel.textContent = 'Cancel';
      cancel.addEventListener('click', () => cancelTransfer(conv, file));
      actions.append(cancel);
    }
  } else if (file.retryUpload && file.relayStage === 'failed') {
    btn.textContent = 'Restart upload';
    btn.title = 'Start over from the beginning';
    btn.addEventListener('click', () => file.retryUpload?.().catch((err) => toast(err.message)));
  } else if (file.blob) {
    btn.textContent = 'Save';
    btn.addEventListener('click', () => downloadFile(file));
  } else if (file.via === 'relay' && file.relayStage === 'verified') {
    btn.textContent = 'Save';
    btn.title = 'Fetches the verified file again and streams it to disk';
    btn.addEventListener('click', () => saveRelayed(conv, file));
  } else if (file.via === 'relay' && file.relayStage === 'saved') {
    btn.textContent = 'Saved';
    btn.disabled = true;
    btn.title = 'Streamed to disk; the server copy has been released.';
  } else if (file.via === 'relay' && file.relayStage === 'gone') {
    btn.textContent = 'Gone';
    btn.disabled = true;
    btn.title = 'The server no longer holds this file.';
  } else if (file.via === 'relay' && file.relayStage === 'failed' && file.relayKey) {
    // The server keeps it until it is taken or it expires, so it can be retried.
    btn.textContent = 'Restart download';
    btn.title = 'Start over from the beginning';
    btn.addEventListener('click', () => downloadRelayed(conv, file));
  } else if (holders.length) {
    btn.textContent = file.corrupt ? 'Retry' : partial ? 'Resume' : 'Request';
    btn.title =
      partial && file.chunks && !file.corrupt
        ? `${countReceived(file.chunks)} of ${file.chunks.length} chunks already held`
        : '';
    btn.addEventListener('click', () => requestFile(conv, file).catch((err) => toast(err.message)));
  } else {
    btn.textContent = 'Gone';
    btn.disabled = true;
    btn.title = 'No online device is still holding these bytes.';
  }
  timeline.append(node);
}

function formatBytes(value: number | undefined) {
  const bytes = Number(value) || 0;
  if (bytes < 1024) return `${bytes} B`;
  const units = ['KB', 'MB', 'GB', 'TB'];
  let size = bytes / 1024;
  let i = 0;
  while (size >= 1024 && i < units.length - 1) {
    size /= 1024;
    i++;
  }
  return `${size >= 10 ? size.toFixed(1) : size.toFixed(2)} ${units[i]}`;
}

function toast(message: string, action?: { label: string; run: () => void }) {
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

const CANDIDATE_LABEL: Record<string, string> = {
  host: 'host',
  srflx: 'srflx',
  prflx: 'prflx',
  relay: 'relay',
};

async function refreshStats() {
  for (const link of state.links.values()) {
    if (!link.pc || link.pc.connectionState !== 'connected') continue;
    try {
      const stats = await link.pc.getStats();
      let sent = 0;
      let received = 0;
      let rtt: any = null;

      let pair: any = null;

      const byId: Map<string, any> = new Map();

      stats.forEach((report) => {
        byId.set(report.id, report);
        if (report.type === 'data-channel') {
          sent += report.bytesSent || 0;
          received += report.bytesReceived || 0;
        }
        if (
          report.type === 'candidate-pair' &&
          report.state === 'succeeded' &&
          (report.nominated || report.selected)
        ) {
          pair = report;
          if (Number.isFinite(report.currentRoundTripTime))
            {rtt = report.currentRoundTripTime * 1000;}
        }
      });

      if (pair) {
        const local = byId.get(pair.localCandidateId);
        const remote = byId.get(pair.remoteCandidateId);
        const localType = CANDIDATE_LABEL[String(local?.candidateType)] || '?';
        const remoteType = CANDIDATE_LABEL[String(remote?.candidateType)] || '?';
        link.path =
          localType === 'relay' || remoteType === 'relay' ? 'relay' : `${localType}↔${remoteType}`;
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
  // Keep a visible countdown moving. Only when something is actually counting
  // down, so an idle session is not re-rendered every three seconds.
  const conv = state.activeConvId ? state.conversations.get(state.activeConvId) : null;
  if (conv && [...conv.files.values()].some((file) => file.relayExpiresAt && !file.complete))
    {renderSession();}
}

function resolveCode(
  code: string,
  targetId: string | undefined = undefined,
): Promise<Device | null> {
  const requestId = crypto.randomUUID();
  return new Promise((resolve) => {
    const timer = setTimeout(() => {
      state.pendingCodeRequests.delete(requestId);
      resolve(null);
    }, 4000);
    state.pendingCodeRequests.set(requestId, (peer: Device | null) => {
      clearTimeout(timer);
      resolve(peer);
    });
    wsSend({ type: 'pair-device', requestId, code, targetId });
  });
}

/* ---------- events ---------- */

$('#codeForm').addEventListener('submit', async (event: Event) => {
  event.preventDefault();
  const input = $('#codeInput').value.trim();
  if (!input) return;
  let code = input.toUpperCase();
  let targetId;
  if (/^https?:/i.test(input)) {
    try {
      const invitation = pairingInvitation(input, location.origin);
      code = invitation.code.toUpperCase();
      targetId = invitation.device;
    } catch {
      codeFeedback.textContent =
        'Paste a valid device invitation from this server, or enter its pairing code.';
      return;
    }
  }
  codeFeedback.textContent = 'Looking up device…';
  const peer = await resolveCode(code, targetId);
  if (!peer || peer.id === state.self?.id) {
    codeFeedback.textContent =
      'That pairing code is invalid, expired, or belongs to an unavailable device.';
    return;
  }
  state.peers.set(peer.id, peer);
  codeFeedback.textContent = `Paired with ${peer.name}`;
  renderPeers();
  $('#addDeviceDialog').close();
  openSession(peer.id);
});

$('#createRoomForm').addEventListener('submit', (event: Event) => {
  event.preventDefault();
  const input = $('#roomNameInput');
  const name = input.value.trim() || `${state.self?.name || 'New'} room`;
  roomFeedback.textContent = '';
  wsSend({ type: 'create-room', name, access: newRoomAccess() });
});

/** One path for a typed code, a scanned room QR and an opened room link. */
function joinRoomByCode(code: string) {
  code = code.trim().toUpperCase();
  if (!code) return;
  state.pendingOpenRoomCode = code;
  roomFeedback.textContent = 'Joining room…';
  wsSend({ type: 'join-room', code });
}

$('#joinRoomForm').addEventListener('submit', (event: Event) => {
  event.preventDefault();
  const input = $('#roomCodeInput');
  joinRoomByCode(input.value);
  input.value = '';
});

$('#roomQrBtn').addEventListener('click', () => {
  const conv = activeConversation();
  const room = conv?.kind === 'room' ? state.rooms.get(conv.roomId) : undefined;
  if (!room?.code) return;
  $('#roomQrName').textContent = room.name;
  $('#roomQrCode').textContent = room.code;
  drawQr($('#roomQr'), roomInvitationLink(room.code, location.href));
  openDialog($('#roomQrDialog'));
});

// Keep the keyboard and viewport steady until Safari delivers the tap's click.
// Cancelling mousedown prevents the focus change, while the native click still
// submits or opens the file picker with the original user activation.
messageForm.addEventListener('mousedown', (event: MouseEvent) => {
  if (event.button !== 0 || document.activeElement !== messageInput) return;
  const button = event.target instanceof Element ? event.target.closest('button') : null;
  if (button?.form === messageForm && !button.disabled) event.preventDefault();
});

messageForm.addEventListener('submit', async (event: Event) => {
  event.preventDefault();
  const conv = activeConversation();
  const text = messageInput.value;
  if (!conv || !text.trim()) return;
  messageInput.value = '';
  try {
    await sendChat(conv, text);
  } catch (err) {
    if (!messageInput.value) messageInput.value = text;
    toast(err.message || 'Could not send message');
  }
});

messageInput.addEventListener('keydown', (event: KeyboardEvent) => {
  if (event.key === 'Enter' && !event.shiftKey) {
    event.preventDefault();
    messageForm.requestSubmit();
  }
});

pickFileBtn.addEventListener('click', () => fileInput.click());
fileInput.addEventListener('change', async () => {
  const conv = activeConversation();
  if (!conv || !fileInput.files?.length) return;
  try {
    await sendFiles(conv, [...fileInput.files]);
  } catch (err) {
    toast(err.message || 'File transfer failed');
  } finally {
    fileInput.value = '';
  }
});

$('#closeSession').addEventListener('click', closeSessionPanel);

leaveRoomBtn.addEventListener('click', () => {
  const conv = activeConversation();
  if (conv?.kind === 'room') leaveRoom(conv.roomId);
});

$('#copyCodeBtn').addEventListener('click', async () => {
  const conv = activeConversation();
  if (!conv) return;
  const code = conv.kind === 'room' ? state.rooms.get(conv.roomId)?.code : state.self?.pairingCode;
  if (!code) return;
  await navigator.clipboard.writeText(code).catch(() => {});
  toast(conv.kind === 'room' ? 'Room code copied' : 'Your connection code copied');
});

selfCode.addEventListener('click', async () => {
  if (!state.self?.code) return;
  await navigator.clipboard.writeText(state.self.pairingCode || '').catch(() => {});
  toast('Your connection code copied');
});

function setupSettings() {
  const discoverable = document.querySelector('#discoverableInput');
  if (discoverable instanceof HTMLInputElement) {
    discoverable.checked = localStorage.getItem('evakage-discoverable') === '1';
    discoverable.addEventListener('change', () => {
      localStorage.setItem('evakage-discoverable', discoverable.checked ? '1' : '0');
      wsSend({ type: 'set-discoverable', enabled: discoverable.checked });
    });
  }
  const verifiedOnlyInput = $('#verifiedOnlyInput');
  verifiedOnlyInput.addEventListener('change', () => {
    state.verifiedOnly = verifiedOnlyInput.checked;
    try {
      localStorage.setItem('evakage-verified-only', state.verifiedOnly ? '1' : '0');
    } catch {}
    renderSession();
    accountUI.push();
  });
  const roomApproval = $('#roomApprovalInput');
  roomApproval.addEventListener('change', () => {
    try {
      localStorage.setItem('evakage-room-access', roomApproval.checked ? 'private' : 'protected');
    } catch {}
    accountUI.push();
  });
  const dialog = $('#settingsDialog');
  const radios = incomingRadios();
  for (const radio of radios) {
    radio.addEventListener('change', () => {
      if (!radio.checked) return;
      state.incomingPolicy = radio.value;
      try {
        localStorage.setItem('evakage-incoming', radio.value);
      } catch {}
      accountUI.push();
    });
  }
  $('#settingsBtn').addEventListener('click', () => {
    openDialog(dialog, radios.find((radio) => radio.checked) || radios[0]);
    accountUI.pull();
  });
}

function incomingRadios() {
  return [
    ...$('#settingsDialog').querySelectorAll<HTMLInputElement>('input[name="incomingPolicy"]'),
  ];
}

/** (Re)applies the account-synced settings from localStorage. */
function loadSyncedPreferences() {
  const stored = (key: string) => {
    try {
      return localStorage.getItem(key);
    } catch {
      return null;
    }
  };
  applyTheme(stored('evakage-theme') || 'system');
  const incoming = stored('evakage-incoming') || '';
  if (INCOMING_POLICIES.includes(incoming)) state.incomingPolicy = incoming;
  for (const radio of incomingRadios()) radio.checked = radio.value === state.incomingPolicy;
  state.verifiedOnly = stored('evakage-verified-only') === '1';
  $('#verifiedOnlyInput').checked = state.verifiedOnly;
  $('#roomApprovalInput').checked = newRoomAccess() === 'private';
  state.forceRelay = stored('evakage-force-relay') === '1';
  $('#forceRelayInput').checked = state.forceRelay;
  renderSession();
}

/** Whether this device created the room, and so may manage it. */
function ownsRoom(conv: Conversation) {
  return conv.kind === 'room' && Boolean(state.rooms.get(conv.roomId)?.owned);
}

/** "Via server" is the creator's choice in a room; members never see it. */
function viaServerChosen(conv: Conversation) {
  return state.forceRelay && (conv.kind !== 'room' || ownsRoom(conv));
}

function setupRelayToggle() {
  const toggle = $('#relayToggle');
  const input = $('#forceRelayInput');
  // Only offered when the server actually runs the relay.
  toggle.classList.toggle('hidden', !relayEnabled());
  input.addEventListener('change', () => {
    state.forceRelay = input.checked;
    try {
      localStorage.setItem('evakage-force-relay', input.checked ? '1' : '0');
    } catch {}
    accountUI.push();
  });
}

function renderQrCodes() {
  if (!state.self?.pairingCode) return;
  // The invitation is the app URL plus a pairing fragment, so one QR both
  // opens Evakage on the other device and pairs it.
  const invitation = new URL(location.pathname, location.origin);
  invitation.hash = new URLSearchParams({
    pair: state.self.pairingCode,
    device: state.self.id,
  }).toString();
  drawQr($('#deviceQr'), invitation.href);
  $('#qrInvitation').value = invitation.href;
  $('#qrFingerprint').textContent = state.self.id;
  $('#qrPairingCode').textContent = state.self.pairingCode;
}
$('#guideBtn').addEventListener('click', () => openDialog($('#guideDialog')));
$('#appNameBtn').addEventListener('click', () => openDialog($('#aboutDialog')));
$('#addDeviceBtn').addEventListener('click', () => openDialog($('#addDeviceDialog')));
function openQrDialog() {
  try {
    renderQrCodes();
  } catch (err) {
    return toast(err.message);
  }
  $('#qrCopyFeedback').textContent = '';
  openDialog($('#qrDialog'));
}
$('#qrBtn').addEventListener('click', openQrDialog);
// Opens over Connect, so closing the QR returns to it.
$('#connectQrBtn').addEventListener('click', openQrDialog);
$('#qrInvitation').addEventListener('click', () => $('#qrInvitation').select());
$('#copyInvitationBtn').addEventListener('click', async () => {
  try {
    await navigator.clipboard.writeText($('#qrInvitation').value);
    $('#qrCopyFeedback').textContent = 'Invitation copied. Send it to your other device.';
  } catch {
    $('#qrInvitation').focus();
    $('#qrInvitation').select();
    $('#qrCopyFeedback').textContent =
      'Select and copy the invitation above using your device’s Copy command.';
  }
});

$('#devicesBtn').addEventListener('click', () => {
  renderKnownDevices();
  openDialog(devicesDialog, devicesDialog.querySelector('button'));
});

// Escape closes the session panel, matching the dialogs.
document.addEventListener('keydown', (event) => {
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
    try {
      link.dc?.close();
    } catch {}
    try {
      closePeerConnection(link.pc);
    } catch {}
  }
});

/* ---------- theme ---------- */

const THEMES = ['system', 'light', 'dark'];

const THEME_GLYPH: Record<string, string> = { system: '◐', light: '☀', dark: '☾' };

const THEME_LABEL: Record<string, string> = {
  system: 'Theme: follow system',
  light: 'Theme: light',
  dark: 'Theme: dark',
};

function applyTheme(theme: string) {
  const chosen = THEMES.includes(theme) ? theme : 'system';
  if (chosen === 'system') document.documentElement.removeAttribute('data-theme');
  else document.documentElement.setAttribute('data-theme', chosen);
  themeIcon.textContent = THEME_GLYPH[chosen];
  themeBtn.setAttribute('aria-label', THEME_LABEL[chosen]);
  themeBtn.title = `${THEME_LABEL[chosen]} (click to change)`;
  try {
    localStorage.setItem('evakage-theme', chosen);
  } catch {}
  state.theme = chosen;
}

function setupTheme() {
  let stored = 'system';
  try {
    stored = localStorage.getItem('evakage-theme') || 'system';
  } catch {}
  applyTheme(stored);
  themeBtn.addEventListener('click', () => {
    applyTheme(THEMES[(THEMES.indexOf(state.theme) + 1) % THEMES.length]);
    accountUI.push();
  });
}

/* ---------- dialogs ---------- */

document.querySelectorAll('[data-close-dialog]').forEach((button) => {
  button.addEventListener('click', () => {
    const dialog = button.closest('dialog');
    if (dialog instanceof HTMLDialogElement) dialog.close('cancel');
  });
});

// <dialog> gives a real modal with focus trapping and Escape for free; this only
// has to remember where focus came from and put it back.

function openDialog(dialog: HTMLDialogElement, focusTarget?: Element | null) {
  const returnTo = document.activeElement;
  dialog.addEventListener(
    'close',
    () => {
      if (returnTo instanceof HTMLElement && document.contains(returnTo)) returnTo.focus();
    },
    { once: true },
  );
  dialog.showModal();
  if (focusTarget instanceof HTMLElement) focusTarget.focus();
}

async function acceptPairing(peer: Device) {
  if (!peer.identityKey || !peer.sealKey || !peer.sealKeySignature) return false;
  if (!peer.identityKey || !peer.sealKey || !peer.sealKeySignature) return false;
  const checked = await verifyAdvertisedIdentity({
    deviceId: peer.id,
    identityKey: peer.identityKey,
    sealKey: peer.sealKey,
    sealKeySignature: peer.sealKeySignature,
  });
  if (!checked || !pairDevice(peer.id, peer.name)) return false;
  recordDevice(peer, peer.online !== false);
  if (peer.online !== false) state.peers.set(peer.id, peer);
  renderPeers();
  renderRooms();
  renderKnownDevices();
  renderSession();
  reconcileLinks(new Set(state.peers.keys()));
  wsSend({ type: 'blobs-request' });
  for (const link of state.links.values())
    {if (deviceAllowed(link.peerId) && isSecure(link)) syncEverythingWith(link);}
  return true;
}

let connectTargetId = undefined as string | undefined;

function openCodePairing(id: string) {
  connectTargetId = id;
  $('#connectTarget').textContent =
    `Ask the owner of ${displayName(id)} for the Connection code at the top of their screen, or scan their device QR.`;
  $('#connectCode').value = '';
  $('#connectFeedback').textContent = '';
  openDialog($('#connectDialog'), $('#connectCode'));
}
$('#connectForm').addEventListener('submit', async (event) => {
  event.preventDefault();
  const peer = await resolveCode($('#connectCode').value.trim().toUpperCase(), connectTargetId);
  if (!peer) {
    $('#connectFeedback').textContent =
      'Code invalid or expired. Ask the owner for their current Connection code.';
    return;
  }
  $('#connectDialog').close();
  openSession(peer.id);
});

window.addEventListener('hashchange', () => {
  if (state.self) handlePairingLink().catch((err) => toast(err.message || 'Pairing failed.'));
});

async function handlePairingLink() {
  const params = new URLSearchParams(location.hash.slice(1));
  const room = params.get('room');
  if (room) {
    history.replaceState(null, '', location.pathname + location.search);
    joinRoomByCode(room);
    return;
  }
  const code = params.get('pair');
  if (!code) return;
  const id = params.get('device');
  history.replaceState(null, '', location.pathname + location.search);
  const peer = await resolveCode(code, id || undefined);
  if (peer) {
    codeFeedback.textContent = `Paired with ${peer.name}`;
    openSession(peer.id);
  } else
    {codeFeedback.textContent =
      'That QR pairing code is invalid or expired. Ask for a current code.';}
}

let pairingDevice = '';

async function openPairing(fingerprint: string) {
  if (!state.self) return;
  pairingDevice = fingerprint;
  $('#pairingCode').textContent = await safetyCode(state.self.id, fingerprint);
  $('#pairingInput').value = '';
  $('#pairingFeedback').textContent = '';
  openDialog($('#pairingDialog'), $('#pairingInput'));
}
$('#pairingForm').addEventListener('submit', async (event) => {
  event.preventDefault();
  if (
    !state.self ||
    !(await verifyDevice(pairingDevice, state.self.id, $('#pairingInput').value))
  ) {
    $('#pairingFeedback').textContent = 'The codes do not match, or this device is blocked.';
    return;
  }
  $('#pairingDialog').close();
  renderKnownDevices();
  renderPeers();
  renderSession();
  wsSend({ type: 'blobs-request' });
  for (const link of state.links.values())
    {if (deviceAllowed(link.peerId) && isSecure(link)) syncEverythingWith(link);}
});

function renderKnownDevices() {
  knownDeviceList.textContent = '';
  const devices = knownDevices().sort((a, b) => (b[1].lastSeen || 0) - (a[1].lastSeen || 0));

  if (!devices.length) {
    const empty = document.createElement('p');
    empty.className = 'device-empty';
    empty.textContent =
      'No devices remembered yet. A device is remembered the first time you connect to it.';
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
    meta.textContent = `${record.blocked ? 'Blocked' : record.verifiedAt ? 'Verified' : record.pairedAt ? 'Paired' : 'Not paired'} · ${online ? 'Online now' : 'Not connected'} · first seen ${new Date(record.firstSeen).toLocaleDateString()}`;
    const fp = document.createElement('div');
    fp.className = 'device-fingerprint';
    fp.textContent = fingerprint;
    main.append(name, meta, fp);

    const forget = document.createElement('button');
    forget.type = 'button';
    forget.className = 'ghost';
    forget.textContent = 'Delete';
    forget.title = 'Delete the stored pairing and trust record. Pair again to exchange.';
    forget.disabled = !!record.blocked;
    if (record.blocked)
      {forget.title = 'Unblock this device before deleting its stored relationship.';}
    forget.addEventListener('click', () => {
      forgetDevice(fingerprint);
      wsSend({ type: 'unpair-device', deviceId: fingerprint });
      releaseIdleLinks();
      const link = state.links.get(fingerprint);
      if (link) link.trust = { known: false, firstSeen: Date.now(), previousName: record.name };
      renderKnownDevices();
      renderPeers();
      renderSession();
      toast(
        `Deleted the pairing with ${record.name || 'device'}. Pair by code again to exchange with it.`,
      );
    });

    const verify = document.createElement('button');
    verify.type = 'button';
    verify.textContent = record.verifiedAt ? 'Compare code' : 'Verify';
    verify.disabled = !!record.blocked;
    verify.setAttribute('aria-label', `Verify ${record.name}`);
    verify.addEventListener('click', () => openPairing(fingerprint));
    const block = document.createElement('button');
    block.type = 'button';
    block.className = 'ghost';
    block.textContent = record.blocked ? 'Unblock' : 'Block';
    block.setAttribute('aria-label', `${record.blocked ? 'Unblock' : 'Block'} ${record.name}`);
    block.addEventListener('click', () => {
      blockDevice(fingerprint, !record.blocked);
      releaseIdleLinks();
      renderKnownDevices();
      renderPeers();
      renderSession();
    });
    const hide = document.createElement('button');
    hide.type = 'button';
    hide.className = 'ghost';
    hide.textContent = record.hidden ? 'Show' : 'Hide';
    hide.addEventListener('click', () => {
      hideDevice(fingerprint, record.name, !record.hidden);
      renderKnownDevices();
      renderPeers();
    });
    row.append(main, verify);
    if (!accountPeerIds.has(fingerprint)) row.append(hide, block);
    row.append(forget);
    knownDeviceList.append(row);
  }
}

// Used by paste-to-send and drag-and-drop when no session is open: pick a target
// rather than guessing one.

function pickTarget({ title, hint }: { title: string; hint: string }) {
  return new Promise<Conversation | null>((resolve) => {
    pickTargetTitle.textContent = title;
    pickTargetHint.textContent = hint;
    pickTargetList.textContent = '';

    const targets: Array<{ label: string; sub: string; open: () => any }> = [];
    for (const peer of [...state.peers.values()].sort((a, b) => a.name.localeCompare(b.name))) {
      targets.push({
        label: peer.name,
        sub: `${peer.platform} · ${peer.browser}`,
        open: () => ensureConversation(directConvId(peer.id), 'direct', peer.id),
      });
    }
    // Recently seen devices that have gone offline can still be sent to: the
    // server holds the sealed copy until they come back.
    for (const record of offlineDevicesToList()) {
      if (state.peers.has(record.id)) continue;
      targets.push({
        label: record.name || displayName(record.id),
        sub: `Offline · seen ${formatAgo(record.lastSeen)} · waits on the server`,
        open: () => ensureConversation(directConvId(record.id), 'direct', record.id),
      });
    }
    for (const roomId of state.joinedRoomIds) {
      const room = state.rooms.get(roomId);
      if (!room) continue;
      targets.push({
        label: room.name,
        sub: `Room · ${room.members.length} of ${room.maxMembers} devices`,
        open: () => ensureConversation(roomConvId(roomId), 'room', roomId),
      });
    }

    if (!targets.length) {
      const empty = document.createElement('p');
      empty.className = 'device-empty';
      empty.textContent =
        'Nothing to send to yet — no other devices are online and you have not joined a room.';
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

    pickTargetDialog.addEventListener(
      'close',
      () => {
        if (!settled) resolve(null);
      },
      { once: true },
    );
    openDialog(pickTargetDialog, pickTargetList.querySelector('button'));
  });
}

/* ---------- drag and drop, paste ---------- */

async function sendFilesTo(conv: Conversation | null | undefined, files: FileList | File[]) {
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

  const rowFor = (target: EventTarget | null) => {
    if (!(target instanceof Element)) return null;
    const row = target.closest('#peerRows tr, #roomRows tr');
    return row instanceof HTMLElement ? row : null;
  };

  const clearHighlights = () => {
    for (const row of document.querySelectorAll('tr.drop-target'))
      {row.classList.remove('drop-target');}
    sessionPanel.classList.remove('dragging');
  };

  const carriesFiles = (event: DragEvent) =>
    [...(event.dataTransfer?.types || [])].includes('Files');

  document.addEventListener('dragenter', (event) => {
    if (!carriesFiles(event)) return;
    event.preventDefault();
    depth++;
  });

  document.addEventListener('dragover', (event) => {
    if (!carriesFiles(event)) return;
    event.preventDefault();
    if (event.dataTransfer) event.dataTransfer.dropEffect = 'copy';
    clearHighlights();
    const row = rowFor(event.target);
    if (row?.dataset.dropTarget) row.classList.add('drop-target');
    else if (
      event.target instanceof Element &&
      sessionPanel.contains(event.target) &&
      state.activeConvId
    ) {
      sessionPanel.classList.add('dragging');
    }
  });

  document.addEventListener('dragleave', (event) => {
    if (!carriesFiles(event)) return;
    depth = Math.max(0, depth - 1);
    if (depth === 0) clearHighlights();
  });

  document.addEventListener('drop', async (event) => {
    if (!carriesFiles(event)) return;
    event.preventDefault();
    depth = 0;
    clearHighlights();

    const files = [...(event.dataTransfer?.files || [])];
    if (!files.length) return;

    const row = rowFor(event.target);
    if (row?.dataset.dropTarget) {
      const conv =
        row.dataset.dropKind === 'room'
          ? ensureConversation(roomConvId(row.dataset.dropTarget), 'room', row.dataset.dropTarget)
          : ensureConversation(
              directConvId(row.dataset.dropTarget),
              'direct',
              row.dataset.dropTarget,
            );
      await sendFilesTo(conv, files);
      return;
    }

    if (
      state.activeConvId &&
      event.target instanceof Element &&
      sessionPanel.contains(event.target)
    ) {
      await sendFilesTo(activeConversation(), files);
      return;
    }

    const conv = await pickTarget({
      title: files.length === 1 ? `Send "${files[0].name}" to…` : `Send ${files.length} files to…`,
      hint: 'Dropped on the page, so pick where it should go.',
    });
    await sendFilesTo(conv, files);
  });

  // A drop that lands outside a handled zone must not navigate the page away.
  window.addEventListener('dragover', (event) => {
    if (carriesFiles(event)) event.preventDefault();
  });
  window.addEventListener('drop', (event) => {
    if (carriesFiles(event)) event.preventDefault();
  });
}

function setupPasteToSend() {
  document.addEventListener('paste', async (event) => {
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
          : text.length > 80
            ? `${text.slice(0, 80)}…`
            : text,
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
  if (
    !state.ws ||
    state.ws.readyState === WebSocket.CLOSED ||
    state.ws.readyState === WebSocket.CLOSING
  ) {
    state.wsBackoff = 500;
    connectWebSocket();
    return;
  }
  for (const peerId of neededPeerIds()) {
    const link = state.links.get(peerId);
    if (link?.incompatible) continue;
    if (!link?.pc || ['closed', 'failed', 'disconnected'].includes(link.pc.connectionState))
      {retryLink(peerId);}
  }
}

document.addEventListener('visibilitychange', handleForeground);
window.addEventListener('pageshow', handleForeground);
window.addEventListener('online', handleForeground);

// A locked screen also stops transfers. Hold a screen wake lock only while
// something is actually in flight, and release it as soon as nothing is.

let wakeLock: WakeLockSentinel | null = null;
async function updateWakeLock() {
  if (!('wakeLock' in navigator)) return;
  let busy = state.activeSends.size > 0;
  if (!busy) {
    for (const conv of state.conversations.values()) {
      for (const file of conv.files.values()) {
        if (
          file.transferId ||
          file.hashing ||
          ['encrypting', 'uploading', 'downloading'].includes(file.relayStage || '')
        ) {
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
      wakeLock.addEventListener('release', () => {
        wakeLock = null;
      });
    } else if (!busy && wakeLock) {
      await wakeLock.release();
      wakeLock = null;
    }
  } catch {
    wakeLock = null; // Denied, or the document lost visibility.
  }
}

/**
 * The Settings install section always says something useful: a button when the
 * browser offers a prompt, the manual steps where it never will, and why not
 * when installing is impossible here.
 */
function setupInstallPrompt() {
  const installBtn = $('#installBtn');
  const status = $('#installTip');

  let deferred: any = null;

  // navigator.standalone is iOS-only and not in the standard Navigator type.
  const iosStandalone = (navigator as { standalone?: boolean }).standalone === true;
  const ios =
    /iPhone|iPad|iPod/i.test(navigator.userAgent) ||
    (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1);

  const show = (text: string, offer: boolean = false) => {
    setTip(status, text);
    installBtn.hidden = !offer;
  };

  const fallback = () => {
    if (matchMedia('(display-mode: standalone)').matches || iosStandalone) {
      show('Evakage is installed and running as an app.');
    } else if (!window.isSecureContext) {
      // Service workers, and with them installing, need HTTPS or localhost.
      show('Installing needs a secure (HTTPS) connection to this server.');
    } else if (ios) {
      // iOS has no install prompt API; Add to Home Screen is manual.
      show('In Safari, tap Share, then “Add to Home Screen”.');
    } else {
      show(
        'Use your browser menu’s “Install app” or “Add to Home screen”. If it is missing, Evakage may already be installed on this device.',
      );
    }
  };
  fallback();

  window.addEventListener('beforeinstallprompt', (event) => {
    // Chrome/Edge/Android: take over the prompt so it can be offered in context.
    event.preventDefault();
    deferred = event;
    show('Install Evakage to open it from your home screen or app list, in its own window.', true);
  });

  installBtn.addEventListener('click', async () => {
    if (!deferred) return;
    installBtn.disabled = true;
    deferred.prompt();
    await deferred.userChoice.catch(() => {});
    deferred = null;
    installBtn.disabled = false;
    fallback();
  });

  window.addEventListener('appinstalled', () => {
    deferred = null;
    show('Installed. Open Evakage from your home screen or app list.');
  });
}

async function setupServiceWorker() {
  if (!('serviceWorker' in navigator)) return;
  let registration;
  try {
    registration = await navigator.serviceWorker.register('/sw.js', { updateViaCache: 'none' });
    if (!registration) return;
  } catch {
    return;
  }

  const banner = $('#updateBanner');
  const offerUpdate = (worker: ServiceWorker | null) => {
    if (!worker) return;
    banner.classList.remove('hidden');
    $('#reloadBtn').onclick = () => {
      // Reload only when the user says so: an update mid-transfer would drop it.
      worker.postMessage('skip-waiting');
      navigator.serviceWorker.addEventListener('controllerchange', () => location.reload(), {
        once: true,
      });
    };
  };

  if (registration.waiting) offerUpdate(registration.waiting);
  registration.addEventListener('updatefound', () => {
    const installing = registration.installing;
    installing?.addEventListener('statechange', () => {
      if (installing.state === 'installed' && navigator.serviceWorker.controller)
        {offerUpdate(installing);}
    });
  });
}

/* ---------- share target ---------- */

// Another app's share sheet POSTs to /share. The service worker keeps the files
// in memory and redirects here with ?shared=<id>; this collects them.

async function takeSharedBundle(
  id: string,
): Promise<{ title: string; text: string; url: string; files: File[] } | null> {
  if (!('serviceWorker' in navigator)) return null;
  const ready = navigator.serviceWorker.ready.then(
    (registration) => navigator.serviceWorker.controller || registration.active,
  );
  const worker = await Promise.race([
    ready,
    new Promise<null>((r) => setTimeout(() => r(null), 5000)),
  ]);
  if (!worker) return null;
  return new Promise((resolve) => {
    const channel = new MessageChannel();
    const timer = setTimeout(() => resolve(null), 5000);
    channel.port1.onmessage = (event) => {
      clearTimeout(timer);
      resolve(event.data || null);
    };
    worker.postMessage({ type: 'take-share', id }, [channel.port2]);
  });
}

let sharedFiles: File[] = [];

function renderShareBanner() {
  const banner = $('#shareBanner');
  if (!sharedFiles.length) {
    banner.classList.add('hidden');
    return;
  }
  const label =
    sharedFiles.length === 1
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
    hint: 'Offline devices get it through the server, sealed to them, when they next connect.',
  });
  if (!conv) return;
  sharedFiles = [];
  renderShareBanner();
  await sendFilesTo(conv, files);
}

function setupShareBanner() {
  $('#shareSendBtn').addEventListener('click', () => {
    sendSharedFiles();
  });
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
    toast('That share did not reach Evakage. Open the app once, then share again.');
    return;
  }
  if (id === 'too-large' || id === 'queue-full' || id === 'too-many-files') {
    const message =
      id === 'too-large'
        ? 'That share exceeds the 16 MiB share-sheet limit, including text and packaging. Open a session and use Attach File for larger files.'
        : id === 'too-many-files'
          ? 'Share at most 32 files at once. Please select fewer files and share again.'
          : 'The share queue is full (8 shares or 32 MiB). Collect waiting shares or wait up to ten minutes, then share again.';
    toast(message);
    return;
  }
  if (id) {
    const bundle = await takeSharedBundle(id);
    if (!bundle) {
      toast('That share expired before it could be picked up. Please share it again.');
      return;
    }
    // Android puts a shared link in `text` and often repeats it in `url`.
    text = [
      bundle.title,
      bundle.text,
      bundle.url && !bundle.text?.includes(bundle.url) ? bundle.url : '',
    ]
      .filter(Boolean)
      .join('\n');
    sharedFiles = bundle.files.filter((file) => file instanceof File);
    renderShareBanner();
  }

  text = text.trim();
  if (text) messageInput.value = text.slice(0, CAPS.messageChars);
  if (!sharedFiles.length && text)
    {toast('Shared text is ready — pick a device or room to send it to.');}
}

async function boot() {
  // Theme first: it must not flash the wrong palette while config loads.
  setupTheme();
  const topbar = document.querySelector('.topbar');
  if (topbar instanceof HTMLElement) {
    const updateHeaderHeight = () =>
      document.documentElement.style.setProperty(
        '--topbar-height',
        `${Math.ceil(topbar.getBoundingClientRect().height)}px`,
      );
    updateHeaderHeight();
    new ResizeObserver(updateHeaderHeight).observe(topbar);
  }

  try {
    const response = await fetch('/config.json', { cache: 'no-store' });
    if (response.ok) state.config = { ...state.config, ...(await response.json()) };
  } catch {}

  try {
    state.identity = await loadIdentity();
  } catch (err) {
    serverState.textContent = 'Not Ready';
    serverState.title = 'Device identity unavailable';
    serverState.classList.add('offline');
    toast(
      'This browser could not create a device identity. Private browsing with storage disabled will not work.',
    );
    return;
  }

  setupShareBanner();
  consumeShareTarget();
  setupInstallPrompt();
  setupDragAndDrop();
  setupPasteToSend();
  setupRelayToggle();
  setupSettings();
  loadSyncedPreferences();
  setupTips();
  connectWebSocket();
  state.statsTimer = setInterval(refreshStats, 3000);
  state.wakeLockTimer = setInterval(updateWakeLock, 2000);
  setupServiceWorker();
}

boot();

setupScanner({
  async pair(code, id) {
    const peer = await resolveCode(code, id);
    if (peer) {
      $('#addDeviceDialog').close();
      toast(`Paired with ${peer.name}`);
      openSession(peer.id);
    } else toast('Pairing code invalid, expired, or device unavailable.');
  },
  joinRoom: joinRoomByCode,
});
// focus-existing launches deliver URLs through the Launch Queue rather than
// navigating the already-open app. Handle the invitation in that app instance.
const launchWindow = window as Window & {
  launchQueue?: { setConsumer: (callback: (launch: { targetURL?: string }) => void) => void };
};
launchWindow.launchQueue?.setConsumer((launch) => {
  if (!launch.targetURL) return;
  try {
    location.hash = new URLSearchParams({
      room: roomInvitation(launch.targetURL, location.origin).code,
    }).toString();
    return;
  } catch {
    /* Not a room invitation; it may be a device one. */
  }
  try {
    const invitation = pairingInvitation(launch.targetURL, location.origin);
    location.hash = new URLSearchParams({
      pair: invitation.code,
      device: invitation.device,
    }).toString();
  } catch {
    /* Ordinary app launches have no pairing invitation. */
  }
});

const accountUI = setupAccounts({
  async onSession() {
    if (!state.self || state.ws?.readyState !== WebSocket.OPEN || signingOut) return;
    const { token } = await accountSocketTicket(state.self.id);
    wsSend({ type: 'account-connect', token });
  },
  onSignOut: clearSignedOutDevice,
  onPreferences: loadSyncedPreferences,
});
