// Shared device types for browser and Node clients. Type-only.
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
  recipientSealRaw: ArrayBuffer | ArrayBufferView<ArrayBuffer>;
  conv: string;
}
export interface OpenOptions {
  sealPrivateKey: CryptoKey;
  box: SealedBox;
  selfId: string;
  expectedFrom: string;
}
export interface Device {
  relayOnly?: boolean;
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

