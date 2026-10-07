// The schema validators are hand-written, so this throws structured garbage at a
// live server and asserts two properties:
//   1. nothing crashes the server or leaks a stack trace back;
//   2. nothing invalid is ever forwarded to another peer.
import test from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import {
  startRoomServer as startServer,
  openWs,
  register as registerRoomDevice,
} from './helpers.js';

async function register(wsBase: string, deviceId: string) {
  const ws = await openWs(wsBase);
  await new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('register timed out')), 3000);
    ws.addEventListener('message', (event) => {
      const msg = JSON.parse(String(event.data));
      if (msg.type === 'registered') {
        clearTimeout(timer);
        resolve(undefined);
      }
    });
    ws.send(
      JSON.stringify({
        type: 'register',
        deviceId,
        name: 'Fuzz',
        platform: 'Linux',
        browser: 'Firefox',
      }),
    );
  });
  return ws;
}

// A deterministic PRNG so a failure can be reproduced from the printed seed.
/** Deterministic PRNG so a failing seed replays. */
function rng(seed: number) {
  let state = seed >>> 0;
  return () => {
    state = (state * 1664525 + 1013904223) >>> 0;
    return state / 0x100000000;
  };
}

function randomValue(random: () => number, depth: number = 0): any {
  const choices: Array<() => any> = [
    () => null,
    () => undefined,
    () => true,
    () => false,
    () => 0,
    () => -1,
    () => Number.MAX_SAFE_INTEGER,
    () => Number.NaN,
    () => Number.POSITIVE_INFINITY,
    () => 1.5,
    () => '',
    () => 'x'.repeat(Math.floor(random() * 300)),
    () => '../'.repeat(20),
    () => '__proto__',
    () => '\u0000\uffff\ud800',
    () => 'A'.repeat(200000),
    () => ({ type: 'offer' }),
    () => (depth > 2 ? 1 : [randomValue(random, depth + 1), randomValue(random, depth + 1)]),
    () =>
      depth > 2
        ? 1
        : { [String.fromCharCode(97 + Math.floor(random() * 26))]: randomValue(random, depth + 1) },
  ];
  return choices[Math.floor(random() * choices.length)]();
}

function validSignal(random: () => number) {
  const shape = random();
  if (shape < 0.25) return { type: 'signal', to: 'device_victim_1234', data: { type: 'knock' } };
  if (shape < 0.5) {
    return {
      type: 'signal',
      to: 'device_victim_1234',
      data: {
        type: 'ice',
        candidate: {
          candidate: 'candidate:1 1 udp 1 127.0.0.1 1 typ host',
          sdpMid: '0',
          sdpMLineIndex: 0,
        },
      },
    };
  }
  const kind = shape < 0.75 ? 'offer' : 'answer';
  return {
    type: 'signal',
    to: 'device_victim_1234',
    data: { type: kind, sdp: { type: kind, sdp: 'v=0\r\no=- 1 1 IN IP4 127.0.0.1\r\n' } },
  };
}

// Corrupt exactly one place in an otherwise valid message.

function mutate(message: any, random: () => number) {
  const targets = [
    () => {
      message.type = TYPES[Math.floor(random() * TYPES.length)];
    },
    () => {
      message.to = randomValue(random);
    },
    () => {
      message.data = randomValue(random);
    },
    () => {
      if (message.data) message.data.type = randomValue(random);
    },
    () => {
      if (message.data) message.data.sdp = randomValue(random);
    },
    () => {
      if (message.data) message.data.candidate = randomValue(random);
    },
    () => {
      if (message.data?.sdp) message.data.sdp.type = randomValue(random);
    },
    () => {
      if (message.data?.sdp) message.data.sdp.sdp = randomValue(random);
    },
    () => {
      if (message.data?.candidate) message.data.candidate.sdpMLineIndex = randomValue(random);
    },
    // Extra keys must be stripped rather than forwarded.
    () => {
      if (message.data) message.data.smuggled = 'payload';
    },
    () => {
      if (message.data?.sdp) message.data.sdp.smuggled = 'payload';
    },
    () => {
      if (message.data?.candidate) message.data.candidate.smuggled = 'payload';
    },
  ];
  targets[Math.floor(random() * targets.length)]();
}

const TYPES = [
  'register',
  'rename',
  'presence-request',
  'rooms-request',
  'resolve-code',
  'create-room',
  'join-room',
  'leave-room',
  'signal',
  'unknown-type',
  '',
  '__proto__',
  'constructor',
];
const FIELDS = [
  'deviceId',
  'name',
  'platform',
  'browser',
  'code',
  'requestId',
  'roomId',
  'recreate',
  'to',
  'data',
  'have',
  'sdp',
  'candidate',
];

test('random structured garbage is never forwarded and never takes the server down', async (t) => {
  // The limiters are covered in hardening.test.js. Raise them here so the run
  // reaches the validators instead of being throttled after the first burst.
  const { base, wsBase } = await startServer(t, {
    limits: {
      messagesPerSecond: 1e6,
      messageBurst: 1e6,
      signalsPerSecond: 1e6,
      signalBurst: 1e6,
      maxInvalidMessages: Number.MAX_SAFE_INTEGER,
      connectionsPerIp: 4096,
      registrationsPerMinute: 1e6,
    },
  });

  const seed = Number(process.env.FUZZ_SEED || 20260917);
  const random = rng(seed);
  const victim = await register(wsBase, 'device_victim_1234');

  const forwarded: any[] = [];
  victim.addEventListener('message', (event) => {
    const msg = JSON.parse(String(event.data));
    if (msg.type === 'signal') forwarded.push(msg);
  });

  // Fresh attackers throughout, because tripping a limiter closes the socket.
  let attacker = await register(wsBase, 'device_attack_0000');
  let sentOnThisSocket = 0;

  for (let i = 0; i < 1500; i++) {
    if (attacker.readyState !== WebSocket.OPEN || sentOnThisSocket > 40) {
      try {
        attacker.close();
      } catch {}
      attacker = await register(wsBase, `device_attack_${String(i).padStart(4, '0')}`);
      sentOnThisSocket = 0;
    }

    let message: Record<string, unknown>;
    if (random() < 0.5) {
      // Start from a well-formed signal and usually corrupt one part of it, so
      // some traffic legitimately gets through and the "only valid shapes are
      // forwarded" property is actually exercised rather than vacuous.
      message = validSignal(random);
      if (random() < 0.75) mutate(message, random);
    } else {
      message = { type: TYPES[Math.floor(random() * TYPES.length)] };
      const fieldCount = Math.floor(random() * 4);
      for (let f = 0; f < fieldCount; f++) {
        message[FIELDS[Math.floor(random() * FIELDS.length)]] = randomValue(random);
      }
      if (random() < 0.5) {
        message.type = 'signal';
        message.to = 'device_victim_1234';
      }
    }

    try {
      attacker.send(JSON.stringify(message));
    } catch {
      // Unserialisable payload (e.g. a cycle); raw bytes are covered below.
    }
    sentOnThisSocket++;
  }

  // Raw non-JSON and binary frames.
  for (let i = 0; i < 40; i++) {
    if (attacker.readyState !== WebSocket.OPEN)
      {attacker = await register(wsBase, `device_raw_${String(i).padStart(4, '0')}`);}
    attacker.send(crypto.randomBytes(64));
    attacker.send('}{not json');
    attacker.send('[]');
    attacker.send('null');
  }

  await new Promise((r) => setTimeout(r, 300));

  // Property 1: the server is still healthy and serving.
  const health = await fetch(`${base}/healthz`).then((res) => res.json());
  assert.equal(health.ok, true, `server unhealthy after fuzzing (seed ${seed})`);

  // Property 2: every signal the victim received is a shape we intended to allow.
  for (const signal of forwarded) {
    const data = signal.data;
    assert.ok(
      data && typeof data === 'object',
      `forwarded non-object data (seed ${seed}): ${JSON.stringify(signal)}`,
    );
    assert.ok(
      ['knock', 'offer', 'answer', 'ice'].includes(data.type),
      `forwarded unknown signal type (seed ${seed}): ${JSON.stringify(data)}`,
    );
    if (data.type === 'offer' || data.type === 'answer') {
      assert.deepEqual(
        Object.keys(data).sort(),
        ['sdp', 'type'],
        `offer/answer carried extra keys (seed ${seed})`,
      );
      assert.equal(data.sdp.type, data.type);
      assert.equal(typeof data.sdp.sdp, 'string');
      assert.deepEqual(Object.keys(data.sdp).sort(), ['sdp', 'type']);
    }
    if (data.type === 'ice') {
      assert.deepEqual(
        Object.keys(data).sort(),
        ['candidate', 'type'],
        `ice carried extra keys (seed ${seed})`,
      );
      assert.equal(typeof data.candidate.candidate, 'string');
    }
  }

  // Property 3: the victim is still registered and responsive.
  const responsive = await new Promise((resolve) => {
    const timer = setTimeout(() => resolve(false), 2000);
    victim.addEventListener('message', (event) => {
      if (JSON.parse(String(event.data)).type === 'presence') {
        clearTimeout(timer);
        resolve(true);
      }
    });
    victim.send(JSON.stringify({ type: 'presence-request' }));
  });
  assert.equal(responsive, true, `victim socket stopped responding (seed ${seed})`);

  console.log(`  fuzz seed ${seed}: ${forwarded.length} signals forwarded, all well-formed`);
  try {
    attacker.close();
  } catch {}
  victim.close();
});

test('a prototype-polluting room name or device id cannot poison lookups', async (t) => {
  const { app, wsBase } = await startServer(t);

  const ws = await registerRoomDevice(wsBase, '__proto__polluter__');
  const joined = await new Promise<{ name: string; id: string }>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('no room')), 3000);
    ws.addEventListener('message', (event) => {
      const msg = JSON.parse(String(event.data));
      if (msg.type === 'room-joined') {
        clearTimeout(timer);
        resolve(msg.room);
      }
    });
    ws.send(JSON.stringify({ type: 'create-room', access: 'protected', name: '__proto__' }));
  });

  assert.equal(joined.name, '__proto__');
  assert.equal(({} as Record<string, unknown>).polluted, undefined);
  assert.equal((Object.prototype as Record<string, unknown>).polluted, undefined);
  // Rooms and clients are Maps, so a key like "__proto__" is inert data.
  assert.equal(app.rooms.get(joined.id).members.has('__proto__polluter__'), true);
  assert.equal(app.clients.get('__proto__'), undefined);

  ws.close();
});
