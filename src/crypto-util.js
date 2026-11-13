'use strict';
// AES-256-GCM helpers for provider API keys at rest.
// The encryption key comes from APP_ENCRYPTION_KEY or a generated file key
// (data/.app-key). Keys are NEVER returned in full to the frontend.
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const config = require('./config');

function getKey() {
  if (config.appEncryptionKey) {
    const hex = config.appEncryptionKey.trim();
    if (/^[0-9a-fA-F]{64}$/.test(hex)) return Buffer.from(hex, 'hex');
    // Accept a passphrase-style value by hashing it (deterministic).
    return crypto.createHash('sha256').update(hex).digest();
  }
  const keyFile = path.join(path.dirname(config.dbPath), '.app-key');
  if (fs.existsSync(keyFile)) return Buffer.from(fs.readFileSync(keyFile, 'utf8').trim(), 'hex');
  const key = crypto.randomBytes(32);
  fs.mkdirSync(path.dirname(keyFile), { recursive: true });
  fs.writeFileSync(keyFile, key.toString('hex'), { mode: 0o600 });
  return key;
}

function encrypt(plain) {
  const key = getKey();
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv('aes-256-gcm', key, iv);
  const enc = Buffer.concat([cipher.update(plain, 'utf8'), cipher.final()]);
  const tag = cipher.getAuthTag();
  return Buffer.concat([iv, tag, enc]).toString('base64');
}

function decrypt(b64) {
  const key = getKey();
  const buf = Buffer.from(b64, 'base64');
  const iv = buf.subarray(0, 12);
  const tag = buf.subarray(12, 28);
  const enc = buf.subarray(28);
  const decipher = crypto.createDecipheriv('aes-256-gcm', key, iv);
  decipher.setAuthTag(tag);
  return Buffer.concat([decipher.update(enc), decipher.final()]).toString('utf8');
}

function mask(value) {
  if (!value) return '';
  if (value.length <= 8) return '••••••••';
  return value.slice(0, 4) + '••••••••' + value.slice(-4);
}

module.exports = { encrypt, decrypt, mask };
