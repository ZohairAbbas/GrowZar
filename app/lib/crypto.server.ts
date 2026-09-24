import {
  createCipheriv,
  createDecipheriv,
  randomBytes,
  timingSafeEqual,
} from "node:crypto";

/**
 * AES-256-GCM at rest, lifted from `salvage/lib/encryption.ts` with two
 * changes.
 *
 * **Key versioning.** The old hub had one key and no way to name it, so
 * rotating meant decrypting everything at once or losing it. Every ciphertext
 * here carries the id of the key that produced it, so a new key can be
 * introduced, used for new writes, and old records re-encrypted at leisure —
 * and a record encrypted under a retired key still tells you which key it
 * needs.
 *
 * **Key encoding.** The salvaged helper demanded 64 hex characters. This box's
 * `ENCRYPTION_KEY` is 32 bytes base64, which that helper would have rejected at
 * the first write. Both encodings are accepted here and the length is checked
 * after decoding, which is the thing that actually matters.
 *
 * Format: `v<keyId>:<iv>:<tag>:<ciphertext>`, all base64url.
 */
const ALGORITHM = "aes-256-gcm";
const IV_BYTES = 12;
const KEY_BYTES = 32;

/**
 * `ENCRYPTION_KEY` is key 1. `ENCRYPTION_KEY_V2`, `_V3` … are later ones.
 * The highest configured id is what new writes use.
 */
function keyEnvName(keyId: number): string {
  return keyId === 1 ? "ENCRYPTION_KEY" : `ENCRYPTION_KEY_V${keyId}`;
}

function decodeKey(raw: string, envName: string): Buffer {
  const trimmed = raw.trim();

  const key = /^[0-9a-fA-F]{64}$/.test(trimmed)
    ? Buffer.from(trimmed, "hex")
    : Buffer.from(trimmed, "base64");

  if (key.length !== KEY_BYTES) {
    throw new Error(
      `${envName} must decode to ${KEY_BYTES} bytes (got ${key.length}). Use 32 bytes as base64 or 64 hex characters.`,
    );
  }

  return key;
}

function loadKey(keyId: number): Buffer {
  const envName = keyEnvName(keyId);
  const raw = process.env[envName];
  if (!raw) throw new Error(`${envName} is not set`);
  return decodeKey(raw, envName);
}

/** The key new ciphertext is written with: the highest one configured. */
export function currentKeyId(): number {
  let highest = 1;
  for (let keyId = 2; keyId <= 32; keyId += 1) {
    if (process.env[keyEnvName(keyId)]) highest = keyId;
  }
  return highest;
}

export function encrypt(plaintext: string, keyId = currentKeyId()): string {
  const iv = randomBytes(IV_BYTES);
  const cipher = createCipheriv(ALGORITHM, loadKey(keyId), iv);

  const ciphertext = Buffer.concat([
    cipher.update(plaintext, "utf8"),
    cipher.final(),
  ]);

  return [
    `v${keyId}`,
    iv.toString("base64url"),
    cipher.getAuthTag().toString("base64url"),
    ciphertext.toString("base64url"),
  ].join(":");
}

export function decrypt(encoded: string): string {
  const parts = encoded.split(":");
  if (parts.length !== 4) {
    throw new Error("Ciphertext is not in the expected format");
  }

  const [version, ivPart, tagPart, dataPart] = parts as [
    string,
    string,
    string,
    string,
  ];

  const keyId = Number(version.replace(/^v/, ""));
  if (!Number.isInteger(keyId) || keyId < 1) {
    throw new Error("Ciphertext does not name a usable key version");
  }

  const decipher = createDecipheriv(
    ALGORITHM,
    loadKey(keyId),
    Buffer.from(ivPart, "base64url"),
  );
  decipher.setAuthTag(Buffer.from(tagPart, "base64url"));

  return Buffer.concat([
    decipher.update(Buffer.from(dataPart, "base64url")),
    decipher.final(),
  ]).toString("utf8");
}

/** Which key a stored value was written with, without decrypting it. */
export function keyIdOf(encoded: string): number | null {
  const version = encoded.split(":")[0];
  if (!version?.startsWith("v")) return null;
  const keyId = Number(version.slice(1));
  return Number.isInteger(keyId) ? keyId : null;
}

/** True when a stored value should be re-encrypted under the current key. */
export function needsRotation(encoded: string): boolean {
  const keyId = keyIdOf(encoded);
  return keyId !== null && keyId !== currentKeyId();
}

/** Re-encrypt under the current key. The plaintext never leaves this call. */
export function rotate(encoded: string): string {
  return encrypt(decrypt(encoded));
}

/** Constant-time compare for secrets that are compared rather than decrypted. */
export function secretsMatch(a: string, b: string): boolean {
  const left = Buffer.from(a);
  const right = Buffer.from(b);
  if (left.length !== right.length) return false;
  return timingSafeEqual(left, right);
}
