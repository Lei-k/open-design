// Issue #2 — password KDF for the multi-user auth foundation.
//
// These tests pin the stored-hash format, the per-account salt, the
// production default cost, and the fail-closed parse of stored hashes.
// Tests inject the structural-floor cost (`FAST_TEST_SCRYPT_PARAMS`) only to
// keep the suite fast; the production default is asserted separately.

import { describe, expect, it } from 'vitest';
import {
  DEFAULT_SCRYPT_PARAMS,
  hashPassword,
  verifyPassword,
} from '../../src/services/auth-passwords.js';
import { FAST_TEST_SCRYPT_PARAMS } from './helpers.js';

describe('auth passwords — scrypt KDF', () => {
  it('uses an OWASP-tier scrypt default (N=2^15, r=8, p=3)', () => {
    expect(DEFAULT_SCRYPT_PARAMS).toEqual({ logN: 15, r: 8, p: 3 });
  });

  it('encodes algorithm, cost, salt and key; never contains the plaintext', async () => {
    const hash = await hashPassword('correct horse battery', FAST_TEST_SCRYPT_PARAMS);
    expect(hash).toMatch(/^\$scrypt\$ln=14,r=8,p=1\$[A-Za-z0-9_-]{22}\$[A-Za-z0-9_-]{43}$/);
    expect(hash).not.toContain('correct horse battery');
  });

  it('salts per hash: the same password hashes differently each time', async () => {
    const a = await hashPassword('correct horse battery', FAST_TEST_SCRYPT_PARAMS);
    const b = await hashPassword('correct horse battery', FAST_TEST_SCRYPT_PARAMS);
    expect(a).not.toBe(b);
    expect(a.split('$')[3]).not.toBe(b.split('$')[3]);
  });

  it('verifies the right password and rejects wrong ones', async () => {
    const hash = await hashPassword('correct horse battery', FAST_TEST_SCRYPT_PARAMS);
    await expect(verifyPassword('correct horse battery', hash)).resolves.toBe(true);
    await expect(verifyPassword('correct horse batterY', hash)).resolves.toBe(false);
    await expect(verifyPassword('', hash)).resolves.toBe(false);
  });

  it('verifies with the cost stored in the hash, not the current default', async () => {
    const hash = await hashPassword('correct horse battery', FAST_TEST_SCRYPT_PARAMS);
    // DEFAULT_SCRYPT_PARAMS differs from the stored cost; verification must
    // still succeed because it reads the parameters from the encoded hash.
    expect(DEFAULT_SCRYPT_PARAMS.logN).not.toBe(FAST_TEST_SCRYPT_PARAMS.logN);
    await expect(verifyPassword('correct horse battery', hash)).resolves.toBe(true);
  });

  it('normalizes Unicode (NFKC) consistently on hash and verify', async () => {
    const composed = 'pässwörd-longer-than-12';
    const decomposed = composed.normalize('NFD');
    expect(decomposed).not.toBe(composed);
    const hash = await hashPassword(composed, FAST_TEST_SCRYPT_PARAMS);
    await expect(verifyPassword(decomposed, hash)).resolves.toBe(true);
  });

  it('fails closed on malformed or out-of-bounds stored hashes', async () => {
    const good = await hashPassword('correct horse battery', FAST_TEST_SCRYPT_PARAMS);
    const [, , , salt, key] = good.split('$');
    const malformed = [
      '',
      'plaintext',
      `$bcrypt$ln=14,r=8,p=1$${salt}$${key}`,
      `$scrypt$ln=30,r=8,p=1$${salt}$${key}`, // absurd cost → refuse, do not DoS
      `$scrypt$ln=4,r=8,p=1$${salt}$${key}`, // below floor
      `$scrypt$ln=14,r=8,p=1$$${key}`,
      `$scrypt$ln=14,r=8,p=1$${salt}$`,
      `$scrypt$ln=14,r=8$${salt}$${key}`,
      `${good}$extra`,
    ];
    for (const stored of malformed) {
      await expect(verifyPassword('correct horse battery', stored)).resolves.toBe(false);
    }
  });

  it('rejects KDF params below the structural floor when hashing', async () => {
    await expect(hashPassword('correct horse battery', { logN: 10, r: 8, p: 1 })).rejects.toThrow();
  });
});
