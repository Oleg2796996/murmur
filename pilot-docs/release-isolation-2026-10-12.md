# MurMur release/isolation verification — 2026-10-12

## Release state

Promotion completed after Oleg's confirmation of the test build.

- Test: `murmur.senswifi.ru` → `2.27.1.2`
- Production: `murmurchat.org` → `82.221.141.224`
- Both relay services: `murmur-relay.service = active`
- Production was not modified before test verification.

## Exact promoted artifacts

| Artifact | SHA-256 (test = prod) |
|---|---|
| `/usr/local/bin/murmur-relay` | `2fa224b639e32c9cbe490905e2ff64f0ea1ec96e71b2d1a81dfe1a32ea97e6fb` |
| `pwa/app.js` | `5dfbf35462b9cee4b8d0f1ff6936246cc93bd90522de5c1c9d99b6be230bf563` |
| `pwa/call-audio.js` | `817a74e3f66eaf79e9ea88aa23e3366f2713c1c1cbcf085753f536b62b369f86` |
| `pwa/service-worker.js` | `55f755eee30a970531acbb0f016098ba6e8a4fcac501e803e9be73321e7ccefc` |
| `pwa/index.html` | `72d9f53ce2e60edce41f05d24cd9039184d2c03bcd7181c2a0feac5b57b0690f` |

## Public cache-bust markers (both domains)

- `app.js?v=call54b-badge-min-20261012`
- `call-audio.js?v=call55-cold-accept-race-20261012`
- `service-worker.js?v=sw-call54b-badge-min-20261012`
- HTTP root check: `200` on both domains.
- Public SHA-256 for app/call-audio/SW matches the server files on both domains.

## Isolation checks

- Test and production are separate VPS hosts and separate domains.
- Test promotion path: test VPS only; production was left unchanged until explicit approval.
- After promotion, test and production runtime/PWA artifacts are byte-identical.
- The only intended environment distinction remains the domain/relay endpoint configuration and contour-specific landing asset policy. No cross-domain app artifact drift was found in the promoted files.
- Both services are active after promotion.

## Functional changes included

- Minimal badge clear: page + Service Worker `CLEAR_BADGE` path.
- Removed sticker-era deferred push branch and resume navigation/reload behavior that interfered with calls.
- `call55`: serialize cold iOS incoming-call accept so duplicate offers cannot replace the PeerConnection during `getUserMedia`/SDP setup.
- Proven call signaling markers retained (`call_signal`, `incoming_call`).

## Backups

- Test revision backup: `/home/oleg/backups/murmur-vps/revision-stickers-calls-final-pre-20261012-121000/`
- Production promotion backup: `/home/oleg/backups/murmur-vps/prod-promotion-call55-badge-pre-20261012-142840/`
- Call55 test backup: `/home/oleg/backups/murmur-vps/call55-cold-accept-pre-20261012-141639/`

## Repository note

The workspace repository is not a clean source-of-truth snapshot yet: `pwa/app.js`, `pwa/call-audio.js`, `pwa/index.html`, `pwa/service-worker.js`, and `pilot-docs/` contain the promoted worktree changes. Before the next release, commit/sync these exact server-verified artifacts; do not rebuild from an older HEAD.
