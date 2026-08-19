import { createCipheriv, createDecipheriv, randomBytes } from 'crypto';

// AES-256-GCM payload encryption shared with the frontend clients (see
// mrkapu-web/lib/api/crypto.ts). This is a deterrent against casual
// DevTools/Postman tampering and scraping, not a confidentiality boundary —
// the key ships inside client JS/binaries, so it's readable by a
// sufficiently motivated attacker. AAD binds each envelope to the exact
// method+path it was issued for, so a captured payload can't be replayed
// against a different endpoint; an embedded timestamp bounds simple replay
// of the same request.

const ALGORITHM = 'aes-256-gcm';
const IV_LENGTH = 12;
const TAG_LENGTH = 16;
const MAX_SKEW_MS = 5 * 60 * 1000;

function loadKey(): Buffer {
  const hex = process.env.PAYLOAD_ENCRYPTION_KEY;
  if (!hex || hex.length !== 64) {
    throw new Error('PAYLOAD_ENCRYPTION_KEY must be a 64-char hex string (32 bytes)');
  }
  return Buffer.from(hex, 'hex');
}

function aad(method: string, path: string): Buffer {
  return Buffer.from(`${method.toUpperCase()}:${path}`, 'utf8');
}

export function encryptPayload(data: unknown, method: string, path: string): string {
  const key = loadKey();
  const iv = randomBytes(IV_LENGTH);
  const cipher = createCipheriv(ALGORITHM, key, iv);
  cipher.setAAD(aad(method, path));
  const plaintext = Buffer.from(JSON.stringify({ ...(data as object), _ts: Date.now() }), 'utf8');
  const ciphertext = Buffer.concat([cipher.update(plaintext), cipher.final()]);
  const tag = cipher.getAuthTag();
  return `${iv.toString('base64')}.${Buffer.concat([ciphertext, tag]).toString('base64')}`;
}

export class PayloadDecryptError extends Error {}

export function decryptPayload(envelope: string, method: string, path: string): Record<string, unknown> {
  const key = loadKey();
  const [ivB64, bodyB64] = envelope.split('.');
  if (!ivB64 || !bodyB64) throw new PayloadDecryptError('Malformed encrypted payload');

  const iv = Buffer.from(ivB64, 'base64');
  const body = Buffer.from(bodyB64, 'base64');
  if (body.length <= TAG_LENGTH) throw new PayloadDecryptError('Malformed encrypted payload');

  const ciphertext = body.subarray(0, body.length - TAG_LENGTH);
  const tag = body.subarray(body.length - TAG_LENGTH);

  const decipher = createDecipheriv(ALGORITHM, key, iv);
  decipher.setAAD(aad(method, path));
  decipher.setAuthTag(tag);

  let plaintext: Buffer;
  try {
    plaintext = Buffer.concat([decipher.update(ciphertext), decipher.final()]);
  } catch {
    throw new PayloadDecryptError('Payload failed integrity check');
  }

  const parsed = JSON.parse(plaintext.toString('utf8')) as Record<string, unknown>;
  const ts = parsed._ts;
  if (typeof ts !== 'number' || Math.abs(Date.now() - ts) > MAX_SKEW_MS) {
    throw new PayloadDecryptError('Payload expired or clock skew too large');
  }
  delete parsed._ts;
  return parsed;
}
