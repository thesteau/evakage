// Shared browser domain types. Type-only: no runtime or build dependency.
export interface Identity {
  privateKey: CryptoKey;
  publicKey: CryptoKey;
  sealPrivateKey: CryptoKey;
  rawPublicKey: Uint8Array<ArrayBuffer>;
  identityKey: string;
  sealKey: string;
  sealKeySignature: string;
  fingerprint: string;
  deviceId: string;
  createdAt: number;
}
export interface SealedBox {
  v: number;
  ephemeral: string;
  iv: string;
  ciphertext: string;
}
export interface SealOptions {
  identity: Pick<Identity, 'privateKey' | 'identityKey' | 'deviceId'>;
  recipientId: string;
  recipientSealRaw: BufferSource;
  conv: string;
}
export interface OpenOptions {
  sealPrivateKey: CryptoKey;
  box: SealedBox;
  selfId: string;
  expectedFrom: string;
}
export interface Device {
  connectedAt?: number;
  id: string;
  name: string;
  code: string;
  pairingCode?: string;
  pairingCodeExpiresAt?: number;
  platform: string;
  browser: string;
  identityKey?: string;
  sealKey?: string;
  sealKeySignature?: string;
  online?: boolean;
  lastSeen?: number;
  awaySince?: number;
}

export interface Message {
  id: string;
  text: string;
  from: string;
  fromName: string;
  at: number;
  proof?: { inner: string; identityKey: string; signature: string };
  verifiedAuthor?: boolean;
  relayedBy?: string | null;
  via?: 'relay';
}

export interface FileMeta {
  id: string;
  name: string;
  size: number;
  type?: string;
  addedAt?: number;
  from?: string;
  fromName?: string;
  totalChunks?: number;
  sha256?: string | null;
  holders?: string[];
}

export interface FileRecord extends FileMeta {
  holders: string[];
  blob: Blob | null;
  chunks: (Uint8Array<ArrayBuffer> | undefined)[] | null;
  progress: number;
  complete: boolean;
  direction: 'sent' | 'received' | 'history';
  receivedBytes?: number;
  available?: boolean;
  corrupt?: boolean;
  verified?: boolean;
  hashing?: boolean;
  verifying?: boolean;
  transferId?: string | null;
  sourceId?: string | null;
  offer?: 'pending' | 'accepted' | 'declined' | null;
  awaitingConsent?: string[];
  via?: 'relay';
  /** 'verified' means checked and discarded, awaiting a streamed Save that fetches it again. */
  relayStage?:
    | 'encrypting'
    | 'uploading'
    | 'downloading'
    | 'offered'
    | 'failed'
    | 'uploaded'
    | 'received'
    | 'declined'
    | 'verified'
    | 'saving'
    | 'saved'
    | 'gone';
  /** Per-chunk plaintext SHA-256 from the verify pass, held until Save. */
  relayDigests?: Uint8Array[] | null;
  relayBlobId?: string;
  relayAbort?: AbortController;
  retryUpload?: () => Promise<void>;
  relayKey?: CryptoKey | null;
  relayMeta?: { id: string; size: number; chunkSize: number; totalChunks: number };
  relayConvId?: string;
  /** When the server stops holding this item, from the server's own clock. */
  relayExpiresAt?: number;
}

interface ConversationState {
  /** Content before a peer's sign-out remains local and is never re-sent as history. */
  syncAfter?: number;
  id: string;
  lastKnownName: string | null;
  lastKnownCode: string | null;
  messages: Map<string, Message>;
  files: Map<string, FileRecord>;
}
export type Conversation = ConversationState &
  (
    | { kind: 'direct'; peerId: string; roomId: null }
    | { kind: 'room'; peerId: null; roomId: string }
  );

export interface LinkCrypto {
  helloPromise?: Promise<void>;
  keyPair: CryptoKeyPair | null;
  ownPublic: string | null;
  ownNonce?: string | null;
  remotePublic: string | null;
  remoteNonce?: string | null;
  remoteIdentity?: Uint8Array<ArrayBuffer> | null;
  key: CryptoKey | null;
  safety: string | null;
  identityVerified?: boolean;
  proofSent?: boolean;
  helloSent?: boolean;
}

export interface Link {
  negotiationTimer?: ReturnType<typeof setTimeout> | null;
  /** Server registration timestamp of the peer this transport was created for. */
  peerConnectedAt?: number;
  peerId: string;
  pc: RTCPeerConnection | null;
  dc: RTCDataChannel | null;
  candidateQueue: RTCIceCandidateInit[];
  crypto: LinkCrypto;
  status: string;
  protocol: number | null;
  incompatible: boolean;
  rttMs: number | null;
  bytesSent: number;
  bytesReceived: number;
  sendRate: number;
  receiveRate: number;
  statsAt: number;
  path: string | null;
  pathDetail: string | null;
  reconnectTimer: ReturnType<typeof setTimeout> | null;
  queueTimer: ReturnType<typeof setTimeout> | null;
  reconnectAttempts: number;
  gaveUp: boolean;
  trust: { known: boolean; firstSeen: number; previousName: string } | null;
  relayPreferredUntil?: number;
}
export type SecureLink = Link & { dc: RTCDataChannel; crypto: LinkCrypto & { key: CryptoKey } };

export interface Room {
  id: string;
  name: string;
  code: string;
  createdAt: number;
  members: Device[];
  away?: Device[];
  maxMembers: number;
  transport: 'mesh' | 'relay';
}
