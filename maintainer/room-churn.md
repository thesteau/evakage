# Room boundary churn measurement

Measured locally on 2026-10-04 with Chromium on Windows, seven isolated browser
contexts and one loopback server. No TURN, network shaping, physical phones or
background interruption were involved.

## Reproduce

```sh
npm run test:e2e -- tests/e2e/room-churn.spec.js --workers=1 --repeat-each=3
```

Each run forms a six-device mesh, then repeats three cycles of an explicit
seventh-device join and leave. All seven browsers stay online; explicit leave
releases the seat, whereas disconnect would retain an away seat. Pairing briefly opens direct conversations; the fixture exits them before
the room baseline, so shared conversations cannot mask room teardown.

A test-only wrapper counts actual RTCPeerConnection constructions, close calls
(counted once per instance), and first connected events. The application source
and room policy are unchanged. Each transition sends from the owner as soon as
the new transport appears, before waiting for mesh handshakes, then sends from a
second incumbent after readiness. Every seated device must show exactly one
copy. All six incumbents must end with exactly thirteen messages. The final
constructed-minus-closed count must match the baseline, catching accumulated
connection instances. The test attaches raw `room-churn.json` to its Playwright
result directory; CI's existing test-results artifact retains it on failure.

## Results

Three isolated runs passed: nine joins and nine leaves, with no missing or
duplicate tested messages and no page errors. There were 30 browser-side peer
connections initially: two endpoints for each of fifteen device pairs.

| Measurement | Median | Range |
| --- | ---: | ---: |
| Initial six-seat message delivery | 86 ms | 79–100 ms |
| Join to relay UI readiness | 68 ms | 64–136 ms |
| First message delivery after joining | 138 ms | 89–157 ms |
| Leave to all six devices showing five encrypted links | 886 ms | 871–1360 ms |
| First message delivery while mesh recovers | 277 ms | 256–295 ms |
| Reverse message delivery after mesh readiness | 84 ms | 77–94 ms |

Every join closed all 30 connection endpoints and opened none. Every leave
constructed and connected 30 replacements. Across nine cycles this means 270
closes and 270 reconnections. First messages after joining arrived via relay at
all six receivers; first messages after leaving arrived directly at all five
receivers. Chat delivered before the full mesh became ready.

These timings include Playwright actions, rendering and assertion polling. They
are user-visible test timings, not pure ICE latency or network round-trip time.
The readiness clock starts before the membership action. Delivery starts before
filling/sending the composer and ends when the last recipient UI is observed.
No timing threshold is enforced: host load and network conditions vary.

## Decision

The repeated full rebuild is confirmed, but this local sample does not show a
chat delivery failure. Keep the current policy for now. Before adding hysteresis,
repeat on a routed/TURN network or phones and measure transfer interruption and
CPU/battery cost. This closes the local boundary measurement task; it does not
establish larger-room reliability, file continuity, away-seat churn costs or
performance on real devices.

Those original measurements preceded mandatory code pairing. Current validation
passes lint, type checking, 92 unit tests, 33 Chromium scenarios and smoke tests
in Chromium, Firefox and WebKit.

## TURN and interrupted files — 2026-10-04

The expanded test has a chat case and an in-flight file case; both run in the
ordinary browser suite. Seven devices pair using real invitation codes. The file
case repeats three boundary cycles with a 512 KiB file in each direction:

- Before the seventh device joins, the sender pauses immediately before direct
  chunk 1. A receiver must already hold plaintext and cannot Save. Joining closes
  the mesh; the interrupted send falls back to a fresh HTTP relay upload.
- Before the seventh device leaves, the HTTP upload pauses after its first
  complete encrypted chunk. Leaving rebuilds the mesh while that existing upload
  continues. This tests a membership transition, not an HTTP resume.
- All five incumbent recipients must end with one file row, SHA-256 verification
  and an enabled Save button. One recipient per phase saves the exact input bytes.
  Chat must still arrive once per recipient and peer endpoints must not accumulate.

This exposed a stale direct `transferId` retained during relay fallback: the file
passed its hash check but the UI kept showing Receiving and hid Save. Relay
handoff now clears direct-transfer state. The file case is a regression test for
that behavior. Re-announced failed downloads also wait for explicit Restart;
reconnecting does not automatically fetch them again.

The local TURN server used Coturn 4.18.0, pinned to image digest
`sha256:bbefd3e1fdfdc0d58770fe01b581fd8b00d9f3a5580d00acb77cf719a6bc78e3`.
Browser-to-TURN transport is TCP through a loopback-bound Docker port; both peers
are forced to relay. The test checks all 30 selected endpoint candidate pairs
before and after churn are relay/relay. This prevents direct ICE fallback from
passing as TURN coverage. Peer traffic stays inside the local container; there
is no WAN delay, real mobile radio, backgrounding or network shaping.

The reproduction script uses random credentials and an isolated container,
removing that exact container afterward. Loopback relay peers are enabled only
for this local test configuration. See [Coturn's Docker documentation](https://github.com/coturn/coturn/blob/master/docker/coturn/README.md).

```sh
# Local file regression without Docker
npm run test:e2e -- tests/e2e/room-churn.spec.js --grep "file transfers" --workers=1
# TURN-only file regression; Docker must be running
node scripts/benchmarks/room-turn.mjs
# Repeat with Pixel 7 browser emulation, not a physical phone
node scripts/benchmarks/room-turn.mjs --mobile --repeat=3
```

Six archived runs passed: one TURN chat run, one loopback file run, one TURN file
run and three mobile-emulation TURN file runs. The five file runs covered fifteen
joins and fifteen leaves, 150 verified recipient files and 30 exact saved-byte
comparisons. Every transition still closes or rebuilds 30 endpoints. No tested
chat or file was duplicated, and no page error was observed.

| Local profile | Mesh readiness median (range) | Join file observed complete, median | Leave file observed complete, median |
| --- | ---: | ---: | ---: |
| Desktop TURN chat | 875 ms (867–885) | — | — |
| Desktop loopback file | 889 ms (880–911) | 536 ms | 1088 ms |
| Desktop TURN file | 1041 ms (1027–1053) | 761 ms | 1493 ms |
| Mobile emulation TURN file, three runs | 882 ms (871–898) | 4522 ms | 3961 ms |

File observation is an upper bound: assertions run after the forward/reverse
chat actions, so it includes their interaction and polling delay. Mobile
emulation's multi-second composer interactions are not a measurement of phone
transfer speed or radio latency. Mesh readiness is measured independently.
These are small-file functional measurements, not throughput or memory bounds.
The [raw reports](validation/room-churn-20261004.json) preserve every sample and
selected-candidate check. Desktop and simulated-phone validation are accepted
for the current foreground-use scope, completing the room churn check. Keep the
six-seat boundary. Actual WAN, physical-phone radio, CPU/battery and large-file
costs remain unmeasured; they are outside the current completion requirements.
