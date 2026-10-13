// S60 Repair 1 (#62): provider-returned MCP metadata is untrusted. Only
// allowlisted, bounded fields survive, scrubbed of every known secret of the
// server — whole, as a "Bearer"/"Basic" credential part, URL-encoded, or as a
// fragment sharing a 12-character window with one.
import { describe, expect, it } from 'vitest';
import {
  carriesSecret, knownSecrets, REDACTED, scrubSecrets, untrustedProtocolVersion, untrustedScope, untrustedText, untrustedTokenType,
} from '../../src/mcp-client/studio-untrusted.js';

const ACCESS = 'SNTLMCP_access_token_0123456789abcdef';
const HEADER = 'hdr/value+with=chars';
const secrets = knownSecrets([ACCESS, `Bearer ${HEADER}`, 'abc', null, undefined, '']);

describe('known secrets', () => {
  it('include full values, credential parts and URL-encoded forms, never values shorter than 4', () => {
    expect(secrets.values).toEqual(expect.arrayContaining([ACCESS, `Bearer ${HEADER}`, HEADER, encodeURIComponent(HEADER)]));
    expect(secrets.values).not.toContain('abc');
  });
  it('detect whole secrets and fragments', () => {
    expect(carriesSecret(`x${ACCESS}y`, secrets)).toBe(true);
    expect(carriesSecret(`x${ACCESS.slice(4, 20)}`, secrets)).toBe(true);
    expect(carriesSecret('mcp:read', secrets)).toBe(false);
  });
});

describe('scrubbing', () => {
  it('replaces secrets, encoded secrets and overlapping runs; leaves ordinary text', () => {
    expect(scrubSecrets(`name ${ACCESS} ${encodeURIComponent(HEADER)} x${ACCESS.slice(3, 22)}z plain`, secrets))
      .toBe(`name ${REDACTED} ${REDACTED} ${REDACTED} plain`);
  });
  it('untrustedText is printable, bounded and null when only a secret was there', () => {
    expect(untrustedText(`fixture\n${ACCESS}`, secrets)).toBe(`fixture ${REDACTED}`);
    expect(untrustedText(ACCESS, secrets)).toBeNull();
    expect(untrustedText(42, secrets)).toBeNull();
    expect(untrustedText('n'.repeat(500), secrets)).toHaveLength(128);
    // A secret straddling the bound is scrubbed before the cut, never left as a prefix.
    expect(untrustedText(`${'n'.repeat(120)}${ACCESS}`, secrets)).not.toContain(ACCESS.slice(0, 8));
  });
});

describe('scope allowlist', () => {
  it('keeps valid scope tokens, drops tokens carrying or overlapping a secret, dedupes and bounds', () => {
    expect(untrustedScope(`mcp:read ${ACCESS} x${ACCESS.slice(4, 24)} mcp:read files.write "quoted" back\\slash`, secrets)).toBe('mcp:read files.write');
    expect(untrustedScope(ACCESS, secrets)).toBeNull();
    expect(untrustedScope(Array.from({ length: 50 }, (_, i) => `s${i}`).join(' '), secrets)!.split(' ')).toHaveLength(32);
    expect(untrustedScope(Array.from({ length: 20 }, (_, i) => `${i}${'x'.repeat(100)}`).join(' '), secrets)!.length).toBeLessThanOrEqual(1024);
    expect(untrustedScope(['not', 'a', 'string'], secrets)).toBeNull();
  });
  it('protocol versions are date-shaped and token types short tokens', () => {
    expect(untrustedProtocolVersion('2025-06-18')).toBe('2025-06-18');
    expect(untrustedProtocolVersion(`2025-06-18 ${ACCESS}`)).toBeNull();
    expect(untrustedTokenType('DPoP')).toBe('DPoP');
    expect(untrustedTokenType(`Bearer ${ACCESS}`)).toBe('Bearer');
  });
});

// S60 Repair 2: every representation the daemon sends is a known secret, and
// credential-shaped provider fields are rejected even without an exact match.
describe('outbound credential representations', () => {
  const CLIENT = 'fixture-client-1'; const SECRET = 'SNTLMCP_client_secret_0123456789ab+/=&:';
  const basic = Buffer.from(`${CLIENT}:${SECRET}`).toString('base64');
  const set = knownSecrets([`Basic ${basic}`, 'r+/=&x0123456789']);
  it('derive the Basic payload, its decoding, client-secret part, percent/form/base64 forms', () => {
    for (const form of [`Basic ${basic}`, basic, `${CLIENT}:${SECRET}`, SECRET, encodeURIComponent(SECRET), new URLSearchParams({ v: SECRET }).toString().slice(2),
      Buffer.from(SECRET).toString('base64'), 'r+/=&x0123456789', encodeURIComponent('r+/=&x0123456789'), new URLSearchParams({ v: 'r+/=&x0123456789' }).toString().slice(2)]) expect(set.values, form).toContain(form);
  });
  it('drop an echoed Basic credential from scope and text', () => {
    expect(untrustedScope(`mcp:read Basic ${basic}`, set)).toBe('mcp:read');
    expect(untrustedText(`srv Basic ${basic}`, set)).not.toContain(basic);
  });
  it('reject credential-shaped values even when no exact secret matches', () => {
    const unknown = knownSecrets([]);
    const other = Buffer.from('someone:else-secret-value').toString('base64');
    expect(untrustedScope(`mcp:read Bearer abcdefghijklmnop Basic ${other} ${Buffer.from('a-long-encoded-text-value').toString('base64')}`, unknown)).toBe('mcp:read');
    expect(untrustedText(`name Bearer abcdefghijklmnop`, unknown)).toBe(`name Bearer ${REDACTED}`);
    expect(untrustedScope('offline_access repo:read https://example.com/auth/read', unknown)).toBe('offline_access repo:read https://example.com/auth/read');
  });
});

// Promoted unchanged assertions from the immutable S60 round-3 review.
it('preserves valid ordinary scopes after a scope named basic', () => {
  expect(untrustedScope('basic repo:status', knownSecrets([]))).toBe('basic repo:status');
});
it('preserves an ordinary provider name containing the word Mutual', () => {
  expect(untrustedText('Mutual Fund MCP', knownSecrets([]))).toBe('Mutual Fund MCP');
});

// S62 A4 (promoted from the immutable S61 review probes): an auth-scheme word
// followed by an ordinary long word is metadata. Only a known credential or a
// strong shape (mixed letters/digits, high entropy, or base64 of `id:secret`)
// after a scheme word is a credential.
describe('S62 A4 scheme words before ordinary long tokens', () => {
  const none = knownSecrets([]);
  it.each(['basic internationalization', 'basic read_repository_metadata', 'Bearer ReadRepositoryMetadata', 'Bearer short1234', 'Bearer abc.def.ghi'])('keeps %s', (value) => {
    expect(untrustedScope(value, none)).toBe(value);
    expect(untrustedText(value, none)).toBe(value);
    expect(scrubSecrets(value, none)).toBe(value);
  });
  it.each(['Bearer a1b2c3d4e5f6a7b8c9d0', 'Bearer tok_ABCDEFGH12345678', `Basic ${Buffer.from('user:pass').toString('base64')}`, 'Bearer abcdefghijklmnop'])('still redacts %s', (value) => {
    const payload = value.split(' ')[1]!;
    expect(untrustedScope(`mcp:read ${value}`, none)).toBe('mcp:read');
    expect(untrustedText(`srv ${value}`, none)).not.toContain(payload);
  });
  it('known credentials after scheme words and fragments are still removed', () => {
    const S = 'SNTLMCP_header_value_0123456789abcdef';
    const k = knownSecrets([S, 'Bearer tok_ABCDEFGH12345678']);
    expect(scrubSecrets(`Bearer ${S}`, k)).not.toContain(S);
    expect(scrubSecrets(`x ${S.slice(3, 20)} y`, k)).not.toContain(S.slice(3, 20));
    expect(untrustedScope(`basic Bearer ${S} repo:status`, k)).toBe('basic repo:status');
    expect(untrustedScope(`mutual ${S.slice(2, 18)} ok`, k)).toBe('ok');
    expect(scrubSecrets('Bearer tok_ABCDEFGH12345678', k)).not.toContain('tok_ABCDEFGH');
    expect(scrubSecrets(Buffer.from(S).toString('base64'), k)).not.toContain(Buffer.from(S).toString('base64'));
  });
});
