// Password KDF for the multi-user auth foundation (issue #2).
//
// Stored format (PHC-like, self-describing so the cost can be raised later
// without invalidating existing hashes):
//
//   $scrypt$ln=<log2 N>,r=<r>,p=<p>$<salt base64url, 16 bytes>$<key base64url, 32 bytes>
//
// Invariants:
// - Every hash has its own random salt.
// - Passwords are NFKC-normalized before hashing and before verifying, so
//   visually identical input typed on different keyboards/IMEs verifies.
// - Verification reads the cost from the stored hash, never from the current
//   default, and compares keys with `timingSafeEqual`.
// - Parsing a stored hash is strict and fails CLOSED: anything malformed,
//   non-canonical, below the structural floor, or above the resource ceiling
//   verifies as `false` instead of throwing or burning unbounded CPU/memory.
// - Nothing in this module logs; errors never carry the password.

import { randomBytes, scrypt as scryptCallback, timingSafeEqual, type ScryptOptions } from 'node:crypto';

export interface ScryptParams {
  /** log2 of the scrypt CPU/memory cost N. */
  logN: number;
  /** scrypt block size. */
  r: number;
  /** scrypt parallelization. */
  p: number;
}

/** OWASP password-storage tier for scrypt: N=2^15, r=8, p=3. */
export const DEFAULT_SCRYPT_PARAMS: Readonly<ScryptParams> = Object.freeze({ logN: 15, r: 8, p: 3 });

/**
 * Structural floor. Hashes weaker than this are refused on both write and
 * verify. Tests use exactly this floor to stay fast; production uses
 * `DEFAULT_SCRYPT_PARAMS`.
 */
export const MIN_SCRYPT_LOG_N = 14;
/** Resource ceiling so a tampered stored hash cannot request absurd work. */
export const MAX_SCRYPT_LOG_N = 17;
const MIN_R = 8;
const MAX_R = 16;
const MIN_P = 1;
const MAX_P = 16;
/** 128 * N * r must stay under this (256 MiB) for any accepted parameter set. */
const MAX_SCRYPT_MEMORY_BYTES = 256 * 1024 * 1024;

const SALT_BYTES = 16;
const KEY_BYTES = 32;
const ALGORITHM_ID = 'scrypt';

const STORED_HASH_RE =
  /^\$scrypt\$ln=([1-9][0-9]?),r=([1-9][0-9]?),p=([1-9][0-9]?)\$([A-Za-z0-9_-]{22})\$([A-Za-z0-9_-]{43})$/;

export class PasswordParamsError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'PasswordParamsError';
  }
}

function paramsWithinBounds(params: ScryptParams): boolean {
  const { logN, r, p } = params;
  if (![logN, r, p].every((v) => Number.isSafeInteger(v))) return false;
  if (logN < MIN_SCRYPT_LOG_N || logN > MAX_SCRYPT_LOG_N) return false;
  if (r < MIN_R || r > MAX_R) return false;
  if (p < MIN_P || p > MAX_P) return false;
  return 128 * 2 ** logN * r <= MAX_SCRYPT_MEMORY_BYTES;
}

export function assertScryptParams(params: ScryptParams): void {
  if (!paramsWithinBounds(params)) {
    throw new PasswordParamsError(
      `scrypt parameters out of bounds (logN ${MIN_SCRYPT_LOG_N}-${MAX_SCRYPT_LOG_N}, r ${MIN_R}-${MAX_R}, p ${MIN_P}-${MAX_P})`,
    );
  }
}

/** Canonical password bytes: NFKC-normalized UTF-8. */
function passwordBytes(password: string): Buffer {
  return Buffer.from(password.normalize('NFKC'), 'utf8');
}

function deriveKey(password: Buffer, salt: Buffer, params: ScryptParams): Promise<Buffer> {
  const N = 2 ** params.logN;
  const options: ScryptOptions = {
    N,
    r: params.r,
    p: params.p,
    // Node's default maxmem (32 MiB) is exactly the default-tier requirement;
    // give explicit headroom derived from the (already bounded) parameters.
    maxmem: 2 * 128 * N * params.r + 1024 * 1024,
  };
  return new Promise((resolve, reject) => {
    scryptCallback(password, salt, KEY_BYTES, options, (error, key) => {
      if (error) reject(new PasswordParamsError('scrypt derivation failed'));
      else resolve(key);
    });
  });
}

function decodeCanonicalBase64Url(value: string, expectedBytes: number): Buffer | null {
  const bytes = Buffer.from(value, 'base64url');
  if (bytes.length !== expectedBytes) return null;
  // Reject non-canonical encodings (trailing bits set) so one stored hash has
  // exactly one textual form.
  if (bytes.toString('base64url') !== value) return null;
  return bytes;
}

interface ParsedHash {
  params: ScryptParams;
  salt: Buffer;
  key: Buffer;
}

function parseStoredHash(stored: unknown): ParsedHash | null {
  if (typeof stored !== 'string' || stored.length > 256) return null;
  const match = STORED_HASH_RE.exec(stored);
  if (!match) return null;
  const params: ScryptParams = {
    logN: Number(match[1]),
    r: Number(match[2]),
    p: Number(match[3]),
  };
  if (!paramsWithinBounds(params)) return null;
  const salt = decodeCanonicalBase64Url(match[4]!, SALT_BYTES);
  const key = decodeCanonicalBase64Url(match[5]!, KEY_BYTES);
  if (!salt || !key) return null;
  return { params, salt, key };
}

/** Hash a password with a fresh random salt. Rejects out-of-bounds params. */
export async function hashPassword(
  password: string,
  params: ScryptParams = DEFAULT_SCRYPT_PARAMS,
): Promise<string> {
  if (typeof password !== 'string') throw new PasswordParamsError('password must be a string');
  assertScryptParams(params);
  const salt = randomBytes(SALT_BYTES);
  const key = await deriveKey(passwordBytes(password), salt, params);
  return `$${ALGORITHM_ID}$ln=${params.logN},r=${params.r},p=${params.p}$${salt.toString('base64url')}$${key.toString('base64url')}`;
}

/**
 * Verify a password against a stored hash. Never throws: malformed or
 * out-of-bounds stored hashes, non-string input and derivation failures all
 * resolve to `false`.
 */
export async function verifyPassword(password: unknown, stored: unknown): Promise<boolean> {
  const parsed = parseStoredHash(stored);
  if (!parsed || typeof password !== 'string') return false;
  try {
    const candidate = await deriveKey(passwordBytes(password), parsed.salt, parsed.params);
    return candidate.length === parsed.key.length && timingSafeEqual(candidate, parsed.key);
  } catch {
    return false;
  }
}
