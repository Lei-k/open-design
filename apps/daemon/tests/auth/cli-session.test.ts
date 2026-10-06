import { STUDIO_PARITY_LANES } from '@open-design/contracts';
import { chmodSync, mkdtempSync, readFileSync, rmSync, statSync, symlinkSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { tmpdir } from 'node:os';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { runSessionCli, cliSessionFetch, createCliSessionFile, extractCliSessionFile, pinCliServerOrigin, readCliSession, type CliSessionCredential } from '../../src/http/cli-session.js';

let root: string;
const credential = (): CliSessionCredential => ({ schemaVersion: 1, origin: 'https://studio.test.invalid',
  cookie: `__Host-od_session=${'a'.repeat(43)}`, expiresAt: Date.now() + 60_000 });
beforeEach(() => { root = mkdtempSync(path.join(tmpdir(), 'od-cli-session-')); });
afterEach(() => { vi.restoreAllMocks(); vi.unstubAllGlobals(); rmSync(root, { recursive: true, force: true }); });

describe('remote CLI credential boundary (#68)', () => {
  it.each(['http://remote.test.invalid', 'file:///tmp/session', 'https://user:secret@studio.test.invalid',
    'https://studio.test.invalid/path', 'https://studio.test.invalid?token=secret', 'https://studio.test.invalid#secret'])('rejects unsafe origin %s', (origin) => {
    expect(() => pinCliServerOrigin(origin)).toThrow();
  });
  it('accepts HTTPS and numeric loopback dev origins only', () => {
    expect(pinCliServerOrigin('https://studio.test.invalid/')).toBe('https://studio.test.invalid');
    expect(pinCliServerOrigin('http://127.0.0.1:7000')).toBe('http://127.0.0.1:7000');
    expect(() => pinCliServerOrigin('http://localhost:7000')).toThrow();
  });
  it('keeps A/B credentials in independent private files without overwriting', () => {
    const a = path.join(root, 'a');
    const b = path.join(root, 'b');
    createCliSessionFile(a, credential());
    createCliSessionFile(b, { ...credential(), cookie: `__Host-od_session=${'b'.repeat(43)}` });
    expect(statSync(a).mode & 0o777).toBe(0o600);
    expect(readCliSession(a).cookie).not.toBe(readCliSession(b).cookie);
    expect(() => createCliSessionFile(a, credential())).toThrow();
    expect(readCliSession(a).cookie).toBe(credential().cookie);
  });
  it('rejects symlinks, public permissions, unknown fields and expired sessions', () => {
    const a = path.join(root, 'a');
    createCliSessionFile(a, credential());
    symlinkSync(a, path.join(root, 'link'));
    expect(() => readCliSession(path.join(root, 'link'))).toThrow();
    chmodSync(a, 0o644);
    expect(() => readCliSession(a)).toThrow(/private/);
    chmodSync(a, 0o600);
    writeFileSync(a, JSON.stringify({ ...credential(), expiresAt: 1 }));
    expect(() => readCliSession(a)).toThrow(/expired/);
    expect(readCliSession(a, true).expiresAt).toBe(1);
    writeFileSync(a, JSON.stringify({ ...credential(), token: 'unexpected' }));
    expect(() => readCliSession(a)).toThrow(/Invalid/);
    expect(readFileSync(a, 'utf8')).toContain('unexpected');
  });
  it('strips asserted identities, pins Origin, and disallows all redirects', async () => {
    const transport = vi.fn<typeof fetch>(async () => new Response('{}'));
    await cliSessionFetch(credential(), transport)('https://studio.test.invalid/api/projects', {
      headers: { Authorization: 'Bearer planted', Cookie: 'other-cookie', 'x-od-workspace-id': 'forged', Origin: 'https://other.test.invalid' },
    });
    const headers = new Headers(transport.mock.calls[0]![1]?.headers);
    expect(headers.get('cookie')).toBe(credential().cookie);
    expect(headers.get('origin')).toBe(credential().origin);
    expect(headers.has('authorization')).toBe(false);
    expect(headers.has('x-od-workspace-id')).toBe(false);
    expect(transport.mock.calls[0]![1]?.redirect).toBe('error');
    for (const target of ['https://other.test.invalid/api/projects', 'http://studio.test.invalid/api/projects', 'https://studio.test.invalid/preview']) {
      await expect(cliSessionFetch(credential(), transport)(target)).rejects.toThrow(/mismatch/);
    }
    expect(transport).toHaveBeenCalledOnce();
  });
  it('extracts one explicit session file without confusing it for the subcommand', () => {
    expect(extractCliSessionFile(['--session-file', '/private/a', 'project', 'list', '--json'])).toEqual({
      args: ['project', 'list', '--json'], sessionFile: '/private/a',
    });
    expect(() => extractCliSessionFile(['--session-file', 'a', '--session-file=b'])).toThrow();
    expect(() => extractCliSessionFile(['--session-file', '--json'])).toThrow();
  });
});

it('prints only validated public capability fields from session me', async () => {
  const file = path.join(root, 'me-session'); createCliSessionFile(file, credential());
  const output = vi.spyOn(process.stdout, 'write').mockImplementation(() => true);
  const account = { id: 'a', username: 'alice', role: 'user', active: true, passwordState: 'set', createdAt: 1, updatedAt: 1 };
  const features = Object.fromEntries(STUDIO_PARITY_LANES.map(({ id }) => [id, { status: 'supported', undeclared: 'private-marker' }]));
  let fields: object = { studio: { schemaVersion: 1, shell: 'studio', features, undeclared: 'private-marker' }, studioRevision: 1 };
  vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({ account, ...fields }))));
  await runSessionCli(['me', '--json'], file);
  expect(output).toHaveBeenCalledOnce();
  const printed = String(output.mock.calls[0]![0]);
  expect(JSON.parse(printed).studio.shell).toBe('studio');
  expect(printed).not.toContain('private-marker');
  output.mockClear(); fields = { studioRevision: 1 };
  await expect(runSessionCli(['me', '--json'], file)).rejects.toThrow('Invalid capability response');
  expect(output).not.toHaveBeenCalled();
});
