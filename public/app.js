const $ = (sel) => document.querySelector(sel);
const peerRows = $('#peerRows');
const emptyPeers = $('#emptyPeers');
const serverState = $('#serverState');
const sessionPanel = $('#sessionPanel');
const sessionTitle = $('#sessionTitle');
const sessionMeta = $('#sessionMeta');
const secureState = $('#secureState');
const timeline = $('#timeline');
const messageForm = $('#messageForm');
const messageInput = $('#messageInput');
const fileInput = $('#fileInput');
const pickFileBtn = $('#pickFileBtn');
const selfCode = $('#selfCode');
const toastRegion = $('#toastRegion');
const codeFeedback = $('#codeFeedback');

const state = {
  ws: null,
  wsBackoff: 500,
  self: null,
  peers: new Map(),
  sessions: new Map(),
  activePeerId: null,
  config: { iceServers: [], maxFileBytes: 512 * 1024 * 1024 },
  pendingCodeRequests: new Map(),
  statsTimer: null
};

const encoder = new TextEncoder();
const decoder = new TextDecoder();
const CONTROL_KIND = 1;
const FILE_CHUNK_KIND = 2;
const CHUNK_SIZE = 64 * 1024;
const HIGH_WATER = 8 * 1024 * 1024;
const LOW_WATER = 3 * 1024 * 1024;

function getIdentity() {
  let deviceId = localStorage.getItem('drop-pak-device-id');
  if (!deviceId) {
    deviceId = crypto.randomUUID();
    localStorage.setItem('drop-pak-device-id', deviceId);
  }
  let name = localStorage.getItem('drop-pak-device-name');
  if (!name) {
    const platform = detectPlatform();
    name = `${platform} browser`;
    localStorage.setItem('drop-pak-device-name', name);
  }
  return { deviceId, name };
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
    const identity = getIdentity();
    wsSend({
      type: 'register',
      deviceId: identity.deviceId,
      name: identity.name,
      platform: detectPlatform(),
      browser: detectBrowser()
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
      document.title = `${msg.self.name} · drop-pak`;
      renderPeers();
      return;
    }
    if (msg.type === 'presence') {
      const previousOnline = new Set(state.peers.keys());
      state.peers = new Map(msg.peers.filter(p => p.id !== state.self?.id).map(p => [p.id, p]));
      renderPeers();
      for (const [peerId, session] of state.sessions) {
        if (state.peers.has(peerId) && (!previousOnline.has(peerId) || !session.pc || ['closed', 'failed', 'disconnected'].includes(session.pc.connectionState))) {
          ensureConnection(peerId, !previousOnline.has(peerId));
        }
      }
      return;
    }
    if (msg.type === 'resolved-code') {
      const pending = state.pendingCodeRequests.get(msg.requestId);
      if (pending) {
        state.pendingCodeRequests.delete(msg.requestId);
        pending(msg.peer);
      }
      return;
    }
    if (msg.type === 'signal') {
      await handleSignal(msg.from, msg.data);
      return;
    }
    if (msg.type === 'error') toast(msg.message || 'Server error');
  });

  ws.addEventListener('close', () => {
    serverState.textContent = 'Signaling disconnected';
    serverState.classList.remove('online');
    state.peers.clear();
    renderPeers();
    setTimeout(connectWebSocket, state.wsBackoff);
    state.wsBackoff = Math.min(state.wsBackoff * 1.8, 10000);
  });

  ws.addEventListener('error', () => ws.close());
}

function createSession(peerId) {
  const existing = state.sessions.get(peerId);
  if (existing) return existing;
  const session = {
    peerId,
    pc: null,
    dc: null,
    candidateQueue: [],
    crypto: { keyPair: null, ownPublic: null, remotePublic: null, key: null, safety: null },
    messages: new Map(),
    files: new Map(),
    status: 'idle',
    rttMs: null,
    bytesSent: 0,
    bytesReceived: 0,
    reconnectTimer: null,
    lastActivity: Date.now()
  };
  state.sessions.set(peerId, session);
  return session;
}

function getPeer(peerId) {
  return state.peers.get(peerId) || { id: peerId, name: 'Peer', code: 'offline', platform: 'Unknown', browser: 'Browser' };
}

function openSession(peerId, focus = 'chat') {
  createSession(peerId);
  state.activePeerId = peerId;
  sessionPanel.classList.add('open');
  sessionPanel.setAttribute('aria-hidden', 'false');
  renderSession();
  ensureConnection(peerId);
  if (focus === 'text') setTimeout(() => messageInput.focus(), 80);
  if (focus === 'file') setTimeout(() => fileInput.click(), 80);
}

function closeSessionPanel() {
  sessionPanel.classList.remove('open');
  sessionPanel.setAttribute('aria-hidden', 'true');
  state.activePeerId = null;
}

function sendKnock(peerId) {
  signal(peerId, { type: 'knock' });
}

async function ensureConnection(peerId, force = false) {
  if (!state.self || !state.peers.has(peerId)) return;
  const session = createSession(peerId);
  if (!force && session.pc && ['new', 'connecting', 'connected'].includes(session.pc.connectionState)) return;

  if (session.pc) {
    try { session.pc.close(); } catch {}
  }
  session.pc = new RTCPeerConnection({ iceServers: state.config.iceServers || [] });
  session.status = 'connecting';
  session.candidateQueue = [];
  resetCrypto(session);
  renderPeers();
  renderSession();

  const pc = session.pc;
  pc.onicecandidate = (event) => {
    if (event.candidate) signal(peerId, { type: 'ice', candidate: event.candidate });
  };
  pc.onconnectionstatechange = () => {
    session.status = pc.connectionState;
    renderPeers();
    renderSession();
    if (['failed', 'disconnected'].includes(pc.connectionState)) scheduleReconnect(peerId);
  };
  pc.ondatachannel = (event) => setupDataChannel(session, event.channel);

  const initiator = state.self.id.localeCompare(peerId) < 0;
  if (initiator) {
    const dc = pc.createDataChannel('drop-pak-v1', { ordered: true });
    setupDataChannel(session, dc);
    const offer = await pc.createOffer();
    await pc.setLocalDescription(offer);
    signal(peerId, { type: 'offer', sdp: pc.localDescription });
  } else {
    sendKnock(peerId);
  }
}

function scheduleReconnect(peerId) {
  const session = state.sessions.get(peerId);
  if (!session || session.reconnectTimer) return;
  session.reconnectTimer = setTimeout(() => {
    session.reconnectTimer = null;
    if (state.peers.has(peerId)) ensureConnection(peerId);
  }, 1300);
}

async function handleSignal(peerId, data) {
  if (!data || typeof data !== 'object') return;
  if (data.type === 'knock') {
    createSession(peerId);
    await ensureConnection(peerId);
    return;
  }

  const session = createSession(peerId);
  if (!session.pc || session.pc.connectionState === 'closed') {
    session.pc = new RTCPeerConnection({ iceServers: state.config.iceServers || [] });
    session.status = 'connecting';
    session.candidateQueue = [];
    resetCrypto(session);
    const pc = session.pc;
    pc.onicecandidate = (event) => {
      if (event.candidate) signal(peerId, { type: 'ice', candidate: event.candidate });
    };
    pc.onconnectionstatechange = () => {
      session.status = pc.connectionState;
      renderPeers();
      renderSession();
      if (['failed', 'disconnected'].includes(pc.connectionState)) scheduleReconnect(peerId);
    };
    pc.ondatachannel = (event) => setupDataChannel(session, event.channel);
  }

  const pc = session.pc;
  if (data.type === 'offer') {
    await pc.setRemoteDescription(data.sdp);
    for (const candidate of session.candidateQueue.splice(0)) await pc.addIceCandidate(candidate).catch(() => {});
    const answer = await pc.createAnswer();
    await pc.setLocalDescription(answer);
    signal(peerId, { type: 'answer', sdp: pc.localDescription });
  } else if (data.type === 'answer') {
    await pc.setRemoteDescription(data.sdp);
    for (const candidate of session.candidateQueue.splice(0)) await pc.addIceCandidate(candidate).catch(() => {});
  } else if (data.type === 'ice' && data.candidate) {
    if (pc.remoteDescription) await pc.addIceCandidate(data.candidate).catch(() => {});
    else session.candidateQueue.push(data.candidate);
  }
}

function resetCrypto(session) {
  session.crypto = { keyPair: null, ownPublic: null, remotePublic: null, key: null, safety: null };
}

function setupDataChannel(session, dc) {
  session.dc = dc;
  dc.binaryType = 'arraybuffer';
  dc.bufferedAmountLowThreshold = LOW_WATER;
  dc.onopen = () => startCryptoHandshake(session);
  dc.onclose = () => {
    renderSession();
    renderPeers();
  };
  dc.onerror = () => toast(`Data channel error with ${getPeer(session.peerId).name}`);
  dc.onmessage = (event) => handleDataMessage(session, event.data);
}

async function startCryptoHandshake(session) {
  if (!session.crypto.keyPair) {
    session.crypto.keyPair = await crypto.subtle.generateKey({ name: 'ECDH', namedCurve: 'P-256' }, true, ['deriveKey']);
    const raw = new Uint8Array(await crypto.subtle.exportKey('raw', session.crypto.keyPair.publicKey));
    session.crypto.ownPublic = bytesToBase64(raw);
  }
  session.dc.send(JSON.stringify({ kind: 'crypto-hello', publicKey: session.crypto.ownPublic }));
  renderSession();
}

async function handleDataMessage(session, data) {
  if (typeof data === 'string') {
    let msg;
    try { msg = JSON.parse(data); } catch { return; }
    if (msg.kind === 'crypto-hello' && typeof msg.publicKey === 'string') {
      await acceptRemoteKey(session, msg.publicKey);
    }
    return;
  }
  if (!session.crypto.key) return;
  try {
    if (data instanceof Blob) data = await data.arrayBuffer();
    const packet = new Uint8Array(data);
    if (packet.byteLength < 13) return;
    const iv = packet.slice(0, 12);
    const cipher = packet.slice(12);
    const plain = new Uint8Array(await crypto.subtle.decrypt({ name: 'AES-GCM', iv }, session.crypto.key, cipher));
    await handlePlainFrame(session, plain);
  } catch {
    toast(`Could not decrypt a message from ${getPeer(session.peerId).name}`);
  }
}

async function acceptRemoteKey(session, publicKeyBase64) {
  if (!session.crypto.keyPair) await startCryptoHandshake(session);
  if (session.crypto.remotePublic === publicKeyBase64 && session.crypto.key) return;
  const remoteRaw = base64ToBytes(publicKeyBase64);
  const remoteKey = await crypto.subtle.importKey('raw', remoteRaw, { name: 'ECDH', namedCurve: 'P-256' }, false, []);
  session.crypto.remotePublic = publicKeyBase64;
  session.crypto.key = await crypto.subtle.deriveKey(
    { name: 'ECDH', public: remoteKey },
    session.crypto.keyPair.privateKey,
    { name: 'AES-GCM', length: 256 },
    false,
    ['encrypt', 'decrypt']
  );
  session.crypto.safety = await safetyCode(session.crypto.ownPublic, publicKeyBase64);
  renderSession();
  await sendSyncState(session);
}

async function safetyCode(a, b) {
  const joined = [a, b].sort().join('|');
  const digest = new Uint8Array(await crypto.subtle.digest('SHA-256', encoder.encode(joined)));
  const hex = [...digest.slice(0, 6)].map(x => x.toString(16).padStart(2, '0')).join('').toUpperCase();
  return `${hex.slice(0, 4)}-${hex.slice(4, 8)}-${hex.slice(8, 12)}`;
}

function bytesToBase64(bytes) {
  let binary = '';
  const step = 0x8000;
  for (let i = 0; i < bytes.length; i += step) binary += String.fromCharCode(...bytes.subarray(i, i + step));
  return btoa(binary);
}

function base64ToBytes(str) {
  const binary = atob(str);
  const out = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) out[i] = binary.charCodeAt(i);
  return out;
}

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

async function encryptAndSend(session, plain) {
  if (!session.crypto.key || session.dc?.readyState !== 'open') throw new Error('Secure channel is not ready');
  await waitForWritable(session.dc);
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const cipher = new Uint8Array(await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, session.crypto.key, plain));
  const packet = new Uint8Array(iv.length + cipher.length);
  packet.set(iv, 0);
  packet.set(cipher, iv.length);
  session.dc.send(packet.buffer);
}

async function sendControl(session, obj) {
  const json = encoder.encode(JSON.stringify(obj));
  const frame = new Uint8Array(1 + json.length);
  frame[0] = CONTROL_KIND;
  frame.set(json, 1);
  await encryptAndSend(session, frame);
}

async function sendFileChunk(session, id, seq, total, bytes) {
  const headerBytes = encoder.encode(JSON.stringify({ id, seq, total }));
  const frame = new Uint8Array(1 + 4 + headerBytes.length + bytes.length);
  frame[0] = FILE_CHUNK_KIND;
  new DataView(frame.buffer).setUint32(1, headerBytes.length);
  frame.set(headerBytes, 5);
  frame.set(bytes, 5 + headerBytes.length);
  await encryptAndSend(session, frame);
}

async function handlePlainFrame(session, frame) {
  if (!frame.length) return;
  if (frame[0] === CONTROL_KIND) {
    let msg;
    try { msg = JSON.parse(decoder.decode(frame.slice(1))); } catch { return; }
    await handleControl(session, msg);
    return;
  }
  if (frame[0] === FILE_CHUNK_KIND) {
    const view = new DataView(frame.buffer, frame.byteOffset, frame.byteLength);
    const headerLen = view.getUint32(1);
    if (headerLen < 2 || 5 + headerLen > frame.length) return;
    let header;
    try { header = JSON.parse(decoder.decode(frame.slice(5, 5 + headerLen))); } catch { return; }
    const bytes = frame.slice(5 + headerLen);
    receiveFileChunk(session, header, bytes);
  }
}

async function handleControl(session, msg) {
  session.lastActivity = Date.now();
  if (msg.type === 'chat' && msg.message) {
    mergeMessage(session, msg.message);
    renderSession();
    return;
  }
  if (msg.type === 'sync-state') {
    if (Array.isArray(msg.messages)) for (const item of msg.messages) mergeMessage(session, item);
    if (Array.isArray(msg.files)) for (const meta of msg.files) mergeFileMeta(session, meta);
    renderSession();
    return;
  }
  if (msg.type === 'file-meta' && msg.file) {
    const meta = msg.file;
    session.files.set(meta.id, {
      ...meta,
      blob: null,
      chunks: new Array(meta.totalChunks || Math.ceil(meta.size / CHUNK_SIZE)),
      receivedBytes: 0,
      progress: 0,
      complete: false,
      available: false,
      direction: 'received'
    });
    renderSession();
    return;
  }
  if (msg.type === 'file-complete') {
    finalizeIncomingFile(session, msg.id);
    return;
  }
  if (msg.type === 'file-request') {
    const file = session.files.get(msg.id);
    if (file?.blob) await sendBlob(session, file.blob, file, true);
  }
}

function mergeMessage(session, message) {
  if (!message?.id || typeof message.text !== 'string') return;
  if (message.text.length > 20000) return;
  session.messages.set(message.id, {
    id: message.id,
    text: message.text,
    from: message.from,
    at: Number(message.at) || Date.now()
  });
}

function mergeFileMeta(session, meta) {
  if (!meta?.id || !meta.name || !Number.isFinite(meta.size)) return;
  const existing = session.files.get(meta.id);
  if (existing) {
    Object.assign(existing, meta);
    return;
  }
  session.files.set(meta.id, {
    ...meta,
    blob: null,
    chunks: null,
    receivedBytes: 0,
    progress: 0,
    complete: false,
    available: false,
    direction: 'history'
  });
}

async function sendSyncState(session) {
  if (!session.crypto.key) return;
  const messages = [...session.messages.values()].sort((a, b) => a.at - b.at);
  const files = [...session.files.values()].map(file => ({
    id: file.id,
    name: file.name,
    size: file.size,
    type: file.type || 'application/octet-stream',
    addedAt: file.addedAt,
    from: file.from,
    totalChunks: file.totalChunks || Math.ceil(file.size / CHUNK_SIZE)
  }));
  await sendControl(session, { type: 'sync-state', messages, files }).catch(() => {});
}

async function sendChat(peerId, text) {
  const session = createSession(peerId);
  const clean = text.trim();
  if (!clean) return;
  const message = { id: crypto.randomUUID(), text: clean, from: state.self.id, at: Date.now() };
  mergeMessage(session, message);
  renderSession();
  await waitForSecure(session);
  await sendControl(session, { type: 'chat', message });
}

async function waitForSecure(session, timeoutMs = 12000) {
  if (session.crypto.key && session.dc?.readyState === 'open') return;
  await ensureConnection(session.peerId);
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    if (session.crypto.key && session.dc?.readyState === 'open') return;
    await new Promise(r => setTimeout(r, 80));
  }
  throw new Error('Secure peer connection timed out');
}

async function sendFiles(peerId, fileList) {
  const session = createSession(peerId);
  await waitForSecure(session);
  for (const file of fileList) {
    if (file.size > state.config.maxFileBytes) {
      toast(`${file.name} exceeds this server's configured browser-memory limit.`);
      continue;
    }
    const meta = {
      id: crypto.randomUUID(),
      name: file.name,
      size: file.size,
      type: file.type || 'application/octet-stream',
      addedAt: Date.now(),
      from: state.self.id,
      totalChunks: Math.ceil(file.size / CHUNK_SIZE)
    };
    session.files.set(meta.id, {
      ...meta,
      blob: file,
      progress: 0,
      complete: true,
      available: true,
      direction: 'sent'
    });
    renderSession();
    await sendBlob(session, file, meta, false);
  }
}

async function sendBlob(session, blob, meta, retransmit) {
  const totalChunks = Math.ceil(blob.size / CHUNK_SIZE);
  await sendControl(session, { type: 'file-meta', file: { ...meta, totalChunks } });
  const local = session.files.get(meta.id);
  for (let seq = 0; seq < totalChunks; seq++) {
    const start = seq * CHUNK_SIZE;
    const bytes = new Uint8Array(await blob.slice(start, Math.min(blob.size, start + CHUNK_SIZE)).arrayBuffer());
    await sendFileChunk(session, meta.id, seq, totalChunks, bytes);
    if (local) {
      local.progress = (seq + 1) / totalChunks;
      if (!retransmit) renderSession();
    }
  }
  await sendControl(session, { type: 'file-complete', id: meta.id });
  if (local) local.progress = 1;
  renderSession();
}

function receiveFileChunk(session, header, bytes) {
  const file = session.files.get(header.id);
  if (!file) return;
  if (!file.chunks || file.chunks.length !== header.total) file.chunks = new Array(header.total);
  if (!file.chunks[header.seq]) {
    file.chunks[header.seq] = bytes;
    file.receivedBytes = (file.receivedBytes || 0) + bytes.byteLength;
    file.progress = Math.min(1, file.receivedBytes / Math.max(1, file.size));
    renderSession();
  }
}

function finalizeIncomingFile(session, fileId) {
  const file = session.files.get(fileId);
  if (!file?.chunks || file.chunks.some(chunk => !chunk)) {
    toast(`Transfer incomplete: ${file?.name || 'file'}`);
    return;
  }
  file.blob = new Blob(file.chunks, { type: file.type || 'application/octet-stream' });
  file.chunks = null;
  file.progress = 1;
  file.complete = true;
  file.available = true;
  renderSession();
  toast(`Received ${file.name}`);
}

async function requestFile(session, file) {
  await waitForSecure(session);
  file.direction = 'received';
  file.progress = 0;
  file.complete = false;
  await sendControl(session, { type: 'file-request', id: file.id });
  renderSession();
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

function renderPeers() {
  peerRows.textContent = '';
  const peers = [...state.peers.values()].sort((a, b) => a.name.localeCompare(b.name));
  emptyPeers.classList.toggle('hidden', peers.length > 0);
  for (const peer of peers) {
    const session = state.sessions.get(peer.id);
    const tr = document.createElement('tr');

    const nameTd = document.createElement('td');
    const nameWrap = document.createElement('div');
    nameWrap.className = 'device-name';
    const pip = document.createElement('span');
    pip.className = 'presence-pip';
    const name = document.createElement('span');
    name.textContent = peer.name;
    nameWrap.append(pip, name);
    nameTd.append(nameWrap);

    const codeTd = document.createElement('td');
    codeTd.className = 'peer-code';
    codeTd.textContent = peer.code;

    const platformTd = document.createElement('td');
    platformTd.textContent = `${peer.platform} · ${peer.browser}`;

    const statusTd = document.createElement('td');
    statusTd.textContent = formatStatus(session?.status || 'idle');

    const rttTd = document.createElement('td');
    rttTd.textContent = session?.rttMs != null ? `${Math.round(session.rttMs)} ms` : '—';

    const bytesTd = document.createElement('td');
    bytesTd.textContent = session ? `${formatBytes(session.bytesSent)} ↑ / ${formatBytes(session.bytesReceived)} ↓` : '—';

    const actionsTd = document.createElement('td');
    actionsTd.className = 'actions-col';
    const actions = document.createElement('div');
    actions.className = 'row-actions';
    for (const [label, mode] of [['Chat', 'chat'], ['Text', 'text'], ['File', 'file']]) {
      const btn = document.createElement('button');
      btn.type = 'button';
      btn.textContent = label;
      if (mode !== 'chat') btn.className = 'ghost';
      btn.addEventListener('click', () => openSession(peer.id, mode));
      actions.append(btn);
    }
    actionsTd.append(actions);
    tr.append(nameTd, codeTd, platformTd, statusTd, rttTd, bytesTd, actionsTd);
    peerRows.append(tr);
  }
}

function formatStatus(status) {
  const map = { idle: 'Available', new: 'Connecting', connecting: 'Connecting', connected: 'Connected', disconnected: 'Reconnecting', failed: 'Retrying', closed: 'Closed' };
  return map[status] || status;
}

function renderSession() {
  const peerId = state.activePeerId;
  if (!peerId) return;
  const session = createSession(peerId);
  const peer = getPeer(peerId);
  sessionTitle.textContent = peer.name;
  sessionMeta.textContent = `${peer.platform} · ${peer.browser} · ${peer.code}`;

  if (session.crypto.key) {
    secureState.textContent = `Encrypted · ${session.crypto.safety}`;
    secureState.classList.add('ready');
  } else {
    secureState.textContent = session.dc?.readyState === 'open' ? 'Establishing encryption…' : 'Connecting…';
    secureState.classList.remove('ready');
  }

  timeline.textContent = '';
  const items = [];
  for (const message of session.messages.values()) items.push({ kind: 'message', at: message.at, value: message });
  for (const file of session.files.values()) items.push({ kind: 'file', at: file.addedAt || 0, value: file });
  items.sort((a, b) => a.at - b.at);

  if (!items.length) {
    const empty = document.createElement('div');
    empty.className = 'timeline-empty';
    empty.textContent = 'Nothing here yet. Messages and files live only in participant browser memory.';
    timeline.append(empty);
  }

  for (const item of items) {
    if (item.kind === 'message') renderMessage(item.value);
    else renderFile(session, item.value);
  }
  timeline.scrollTop = timeline.scrollHeight;
}

function renderMessage(message) {
  const node = $('#messageTemplate').content.firstElementChild.cloneNode(true);
  if (message.from === state.self?.id) node.classList.add('self');
  const bubble = node.querySelector('.message-bubble');
  appendLinkifiedText(bubble, message.text);
  node.querySelector('.message-time').textContent = new Date(message.at).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });
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

function renderFile(session, file) {
  const node = $('#fileTemplate').content.firstElementChild.cloneNode(true);
  node.querySelector('.file-name').textContent = file.name;
  const owner = file.from === state.self?.id ? 'sent by you' : 'from peer';
  node.querySelector('.file-meta').textContent = `${formatBytes(file.size)} · ${owner}`;
  const progress = node.querySelector('.file-progress');
  progress.value = Number.isFinite(file.progress) ? file.progress : (file.blob ? 1 : 0);
  const btn = node.querySelector('.file-download');
  if (file.blob) {
    btn.textContent = 'Save';
    btn.addEventListener('click', () => downloadFile(file));
  } else if (session.crypto.key) {
    btn.textContent = file.direction === 'received' && file.progress > 0 ? 'Receiving…' : 'Request';
    btn.disabled = file.direction === 'received' && file.progress > 0 && file.progress < 1;
    btn.addEventListener('click', () => requestFile(session, file).catch(err => toast(err.message)));
  } else {
    btn.textContent = 'Offline';
    btn.disabled = true;
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

function toast(message) {
  const el = document.createElement('div');
  el.className = 'toast';
  el.textContent = message;
  toastRegion.append(el);
  setTimeout(() => el.remove(), 3500);
}

async function refreshStats() {
  for (const session of state.sessions.values()) {
    if (!session.pc || session.pc.connectionState !== 'connected') continue;
    try {
      const stats = await session.pc.getStats();
      let sent = 0;
      let received = 0;
      let rtt = null;
      stats.forEach(report => {
        if (report.type === 'data-channel') {
          sent += report.bytesSent || 0;
          received += report.bytesReceived || 0;
        }
        if (report.type === 'candidate-pair' && report.state === 'succeeded' && (report.nominated || report.selected)) {
          if (Number.isFinite(report.currentRoundTripTime)) rtt = report.currentRoundTripTime * 1000;
        }
      });
      session.bytesSent = sent;
      session.bytesReceived = received;
      session.rttMs = rtt;
    } catch {}
  }
  renderPeers();
}

async function resolveCode(code) {
  const requestId = crypto.randomUUID();
  return await new Promise((resolve) => {
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

messageForm.addEventListener('submit', async (event) => {
  event.preventDefault();
  const peerId = state.activePeerId;
  const text = messageInput.value;
  if (!peerId || !text.trim()) return;
  messageInput.value = '';
  try { await sendChat(peerId, text); }
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
  const peerId = state.activePeerId;
  if (!peerId || !fileInput.files?.length) return;
  try { await sendFiles(peerId, [...fileInput.files]); }
  catch (err) { toast(err.message || 'File transfer failed'); }
  finally { fileInput.value = ''; }
});

$('#closeSession').addEventListener('click', closeSessionPanel);
$('#copyCodeBtn').addEventListener('click', async () => {
  const peer = getPeer(state.activePeerId);
  await navigator.clipboard.writeText(peer.code).catch(() => {});
  toast('Peer code copied');
});
selfCode.addEventListener('click', async () => {
  if (!state.self?.code) return;
  await navigator.clipboard.writeText(state.self.code).catch(() => {});
  toast('Your device code copied');
});

$('#renameBtn').addEventListener('click', () => {
  const current = localStorage.getItem('drop-pak-device-name') || getIdentity().name;
  const value = prompt('Device name shown to other browsers:', current);
  if (!value?.trim()) return;
  const name = value.trim().slice(0, 64);
  localStorage.setItem('drop-pak-device-name', name);
  wsSend({ type: 'rename', name });
});

$('#refreshBtn').addEventListener('click', () => wsSend({ type: 'presence-request' }));

window.addEventListener('beforeunload', () => {
  for (const session of state.sessions.values()) {
    try { session.dc?.close(); } catch {}
    try { session.pc?.close(); } catch {}
  }
});

async function boot() {
  try {
    const response = await fetch('/config.json', { cache: 'no-store' });
    if (response.ok) state.config = { ...state.config, ...(await response.json()) };
  } catch {}
  connectWebSocket();
  state.statsTimer = setInterval(refreshStats, 3000);
  if ('serviceWorker' in navigator) navigator.serviceWorker.register('/sw.js').catch(() => {});
}

boot();
