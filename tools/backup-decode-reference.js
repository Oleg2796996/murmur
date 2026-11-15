#!/usr/bin/env node
// Independent reference decoder for a MurMur `.murmur` backup (PWA format).
//
// Purpose: a SECOND implementation of the payload decoding, so the Swift
// codec can be checked against something that was written independently of it
// (node + the same crypto primitives the PWA uses in the browser).
//
// Usage: node backup-decode-reference.js <backup.murmur> <password> [out.json]
//
// The decrypted payload is written as JSON (out.json) with the shape:
//   { ls, kv, chats, identity, createdAt }
// so the Swift harness can compare peer/message/contact counts.
const fs = require('fs');
const crypto = require('crypto');

const [, , file, password, outPath] = process.argv;
if (!file) {
  console.error('usage: backup-decode-reference.js <backup.murmur> <password> [out.json]');
  process.exit(2);
}

const raw = fs.readFileSync(file, 'utf8');
let box;
try {
  box = JSON.parse(raw);
} catch (e) {
  console.error('not JSON:', e.message);
  process.exit(1);
}
if (box.magic !== 'MURMURBAK1') {
  console.error('bad magic:', box.magic);
  process.exit(1);
}
const salt = Buffer.from(box.salt, 'base64');
const iv = Buffer.from(box.iv, 'base64');
const data = Buffer.from(box.data, 'base64');
const iterations = box.iterations || 250000;

const key = crypto.pbkdf2Sync(password, salt, iterations, 32, 'sha256');
const ct = data.subarray(0, data.length - 16);
const tag = data.subarray(data.length - 16);
const decipher = crypto.createDecipheriv('aes-256-gcm', key, iv);
decipher.setAuthTag(tag);
let plain;
try {
  plain = Buffer.concat([decipher.update(ct), decipher.final()]);
} catch (e) {
  console.error('decrypt failed:', e.message);
  process.exit(1);
}

const payload = JSON.parse(plain.toString('utf8'));
const summary = {
  magic: box.magic,
  v: box.v,
  iterations,
  plainBytes: plain.length,
  lsKeys: Object.keys(payload.ls || {}).sort(),
  kvKeys: Object.keys(payload.kv || {}).sort(),
  peers: Object.keys(payload.chats || {}).length,
  totalMessages: Object.values(payload.chats || {}).reduce((a, v) => a + (Array.isArray(v) ? v.length : 0), 0),
  skLen: (payload.ls || {})['murmur.sk']?.length || 0,
  npub: (payload.ls || {})['murmur.npub'] || '',
  contactCount: Object.keys((payload.ls || {})['murmur.contact_names'] || {}).length,
  unreadPeers: Object.keys((payload.ls || {})['murmur_unread_v1'] || {}).length,
  callEvents: Object.values(payload.chats || {}).reduce(
    (a, v) => a + (Array.isArray(v) ? v.filter((m) => m && m.callEvent).length : 0), 0),
  withAttachments: Object.values(payload.chats || {}).reduce(
    (a, v) => a + (Array.isArray(v) ? v.filter((m) => m && ((m.attachments_meta || []).length || (m.attachments || []).length)).length : 0), 0),
};

console.log(JSON.stringify(summary, null, 2));
if (outPath) {
  fs.writeFileSync(outPath, JSON.stringify(payload));
  console.error('payload written to ' + outPath);
}
