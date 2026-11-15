#!/usr/bin/env node
// INDEPENDENT check of the iOS→PWA direction.
//
// The e2e harness (tools/backup-e2e-test.swift) proves the iOS codec can
// READ a PWA backup. This script proves the opposite: a backup written by
// the iOS app (i.e. the shape produced by
// `BackupManager.exportBackup` + `ExportMessage.jsonObject`) is accepted by
// the PWA restore path (`pwa/backup.js` → `appStore.importBackupData`).
//
// It works on the REAL payload shape: the harness exports the real decoded
// history of a real PWA backup (through the production Swift code) and this
// script re-reads the resulting file with the PWA's OWN rules, i.e. the very
// same code paths `pwa/backup.js` and `pwa/app-store.js` use.
//
// Usage: node tools/backup-pwa-compat-check.js <backup.murmur> <password>
const fs = require('fs');
const crypto = require('crypto');

const [, , file, password] = process.argv;
if (!file) {
  console.error('usage: backup-pwa-compat-check.js <backup.murmur> <password>');
  process.exit(2);
}

let failures = 0;
function check(name, ok, detail) {
  console.log((ok ? '  OK   ' : '  FAIL ') + name + (detail ? ' — ' + detail : ''));
  if (!ok) failures++;
}
function sortedEntries(o) {
  return Object.entries(o || {}).sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0));
}

// --- PWA's own decrypt (pwa/backup.js decryptPayload) ---
function pwaDecrypt(raw) {
  const box = JSON.parse(raw);
  if (box.magic !== 'MURMURBAK1' || box.v !== 1) throw new Error('bad magic/version');
  const salt = Buffer.from(box.salt, 'base64');
  const iv = Buffer.from(box.iv, 'base64');
  const data = Buffer.from(box.data, 'base64');
  const key = crypto.pbkdf2Sync(password, salt, box.iterations || 250000, 32, 'sha256');
  const decipher = crypto.createDecipheriv('aes-256-gcm', key, iv);
  decipher.setAuthTag(data.subarray(data.length - 16));
  return {
    box,
    payload: JSON.parse(Buffer.concat([
      decipher.update(data.subarray(0, data.length - 16)), decipher.final()]).toString('utf8')),
  };
}

const { box, payload } = pwaDecrypt(fs.readFileSync(file, 'utf8'));

console.log('=== PWA reads the iOS-written backup ===');
check('magic MURMURBAK1', box.magic === 'MURMURBAK1');
check('v == 1', box.v === 1);
check('kdf PBKDF2-SHA256', box.kdf === 'PBKDF2-SHA256');
check('iterations 250000', box.iterations === 250000);
check('salt 16 bytes', Buffer.from(box.salt, 'base64').length === 16);
check('iv 12 bytes', Buffer.from(box.iv, 'base64').length === 12);

console.log('=== identity (pwa/backup.js restoreFromRaw) ===');
check('data.identity.npub starts with npub1',
  typeof payload.identity?.npub === 'string' && payload.identity.npub.startsWith('npub1'));
check('ls["murmur.sk"] present (64 bytes hex)',
  typeof payload.ls?.['murmur.sk'] === 'string' && payload.ls['murmur.sk'].length === 128);
check('ls["murmur.npub"] present', typeof payload.ls?.['murmur.npub'] === 'string');
check('ls["murmur.name"] present', 'murmur.name' in (payload.ls || {}));
check('ls["murmur.contact_names"] is an object',
  payload.ls?.['murmur.contact_names'] && typeof payload.ls['murmur.contact_names'] === 'object');
check('createdAt is ms', payload.createdAt > 1e12);

console.log('=== IDB mirror (pwa/app-store.js importBackupData DELETES kv then writes data.kv) ===');
const kv = payload.kv || {};
check('kv is an object', typeof kv === 'object');
check('kv has murmur.npub', typeof kv['murmur.npub'] === 'string');
check('kv has murmur.sk', typeof kv['murmur.sk'] === 'string');
check('kv has murmur.contact_names', kv['murmur.contact_names'] && typeof kv['murmur.contact_names'] === 'object');
// Lesson #127: without the maxTs map every reload re-bumps unread.
if (kv['murmur_maxts_v1'] !== undefined) {
  check('kv.murmur_maxts_v1 is peer->ts',
    typeof kv['murmur_maxts_v1'] === 'object' &&
    Object.values(kv['murmur_maxts_v1']).every(v => typeof v === 'number'));
  check('kv.murmur.messages_max_ts mirrors maxts',
    JSON.stringify(sortedEntries(kv['murmur.messages_max_ts'])) ===
    JSON.stringify(sortedEntries(kv['murmur_maxts_v1'])));
} else {
  console.log('  SKIP kv.murmur_maxts_v1 (no maxTs in this export)');
}

console.log('=== chat rows (pwa/app.js renderMessages / loadHistory) ===');
const chats = payload.chats || {};
const peers = Object.keys(chats);
check('chats is an object', typeof chats === 'object');
let rows = 0, badSig = 0, badDir = 0, callEvents = 0, sysRows = 0;
for (const [peer, msgs] of Object.entries(chats)) {
  if (!Array.isArray(msgs)) { badDir++; continue; }
  for (const m of msgs) {
    rows++;
    if (!m || typeof m !== 'object') { badDir++; continue; }
    if (m.callEvent) {
      callEvents++;
      if (m.direction !== 'system') badDir++;
      if (typeof m._sig !== 'string' || !m._sig.startsWith('call:')) badSig++;
      continue;
    }
    // PWA builds its key as `from + ts` (loadHistory: sigKey = fromNpub + m.ts).
    if (typeof m._sig !== 'string' || m._sig !== (m.from || '') + m.ts) badSig++;
    if (!['in', 'out', 'system'].includes(m.direction)) badDir++;
    if (m.direction === 'system') sysRows++;
  }
}
check('all rows are objects', badDir === 0, `${badDir} bad`);
check('every row has a PWA-compatible _sig (from+ts or call:…)', badSig === 0, `${badSig} bad of ${rows}`);
console.log(`  info  peers=${peers.length} rows=${rows} callEvents=${callEvents}`);

// --- the dedup rule that would duplicate messages if _sig were wrong ---
// loadHistory: `if (!hash && existingSigSet.has(sigKey)) continue;`
let dupRisk = 0;
for (const [peer, msgs] of Object.entries(chats)) {
  const sigSet = new Set();
  for (const m of msgs) {
    const key = m._hash ? 'h:' + m._hash : 's:' + m._sig;
    if (sigSet.has(key)) dupRisk++;
    sigSet.add(key);
  }
}
check('no duplicate rows inside one peer (app-store keyOf)', dupRisk === 0, `${dupRisk} dups`);

console.log(failures === 0 ? '\nALL CHECKS PASSED' : `\n${failures} CHECK(S) FAILED`);
process.exit(failures === 0 ? 0 : 1);
