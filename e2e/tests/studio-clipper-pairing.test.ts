import { readFileSync } from 'node:fs';
import { runInNewContext } from 'node:vm';
import { expect, it } from 'vitest';

const source = readFileSync(new URL('../../clipper/background.js', import.meta.url), 'utf8');
function worker(changeDuringRequest = false) {
  const storage: Record<string, unknown> = { daemonUrl: 'https://studio-a.example', libraryToken: 'TOKEN_A', libraryTokenUrl: 'https://studio-a.example' };
  const calls: { url: string; init: RequestInit }[] = []; let reads = 0;
  let listener: (message: unknown, sender: unknown, reply: (value: any) => void) => void;
  runInNewContext(source, { URL, chrome: {
    storage: { local: {
      async get(keys: string[]) { if (changeDuringRequest && ++reads === 3) Object.assign(storage, { daemonUrl: 'https://studio-b.example', libraryToken: 'TOKEN_B', libraryTokenUrl: 'https://studio-b.example' }); return Object.fromEntries(keys.map((key) => [key, storage[key]])); },
      async set(value: Record<string, unknown>) { Object.assign(storage, value); },
      async remove(keys: string[]) { keys.forEach((key) => delete storage[key]); },
    } },
    runtime: { getURL: () => 'chrome-extension://abc/', onMessage: { addListener(value: typeof listener) { listener = value; } }, onInstalled: { addListener() {} } },
    contextMenus: { onClicked: { addListener() {} } },
  }, fetch: async (url: string, init: RequestInit) => { calls.push({ url, init }); return Response.json(url.endsWith('/confirm') ? { token: 'PAIR_TOKEN' } : { ok: true }); } });
  const message = (body: unknown, sender: unknown = {}) => new Promise<any>((resolve) => listener(body, sender, resolve));
  return { storage, calls, message };
}
it('exchanges a Settings code without cookies and returns no token to the popup', async () => {
  const fixture = worker(); const reply = await fixture.message({ type: 'pairAccount', code: 'ONCE' });
  expect(reply.ok).toBe(true); expect(JSON.stringify(reply)).not.toContain('PAIR_TOKEN');
  expect(fixture.storage.libraryToken).toBe('PAIR_TOKEN'); expect(fixture.storage.libraryTokenUrl).toBe('https://studio-a.example');
  expect(fixture.calls[0].init.credentials).toBe('omit'); expect(JSON.parse(String(fixture.calls[0].init.body))).toMatchObject({ code: 'ONCE', extensionOrigin: 'chrome-extension://abc' });
  expect((fixture.calls[1].init.headers as Record<string, string>).authorization).toBe('Bearer PAIR_TOKEN');
});
it('clears credentials when deployment changes and rejects content-script pairing', async () => {
  const fixture = worker(); await fixture.message({ type: 'setDaemonUrl', url: 'https://studio-b.example' });
  expect(fixture.storage.libraryToken).toBeUndefined(); expect(fixture.calls[0].init.headers).toEqual({});
  const reply = await fixture.message({ type: 'pairAccount', code: 'PAGE_STOLEN' }, { tab: { id: 1 } });
  expect(reply.ok).toBe(false); expect(fixture.calls).toHaveLength(1);
});
it('never sends another deployment’s token when the URL changes during a request', async () => {
  const fixture = worker(true); await fixture.message({ type: 'getStatus' });
  expect(fixture.calls[0].url).toBe('https://studio-a.example/api/library/clipper-probe');
  expect((fixture.calls[0].init.headers as Record<string, string>).authorization).toBeUndefined();
});
it('refuses pairing and credential transmission over remote plaintext HTTP', async () => {
  const fixture = worker(); Object.assign(fixture.storage, { daemonUrl: 'http://remote.example', libraryTokenUrl: 'http://remote.example' });
  expect((await fixture.message({ type: 'pairAccount', code: 'ONCE' })).ok).toBe(false); expect(fixture.calls).toHaveLength(0);
  await fixture.message({ type: 'getStatus' }); expect(fixture.calls[0].init.headers).toEqual({});
});
it('labels the code field and exchange action distinctly in every extension locale', () => {
  const context: { OD_CLIPPER_I18N?: { LOCALES: string[]; dictionaries: Record<string, Record<string, string>> } } = {};
  runInNewContext(readFileSync(new URL('../../clipper/i18n.js', import.meta.url), 'utf8'), context);
  const i18n = context.OD_CLIPPER_I18N!;
  expect(i18n.LOCALES).toHaveLength(21);
  for (const locale of i18n.LOCALES) {
    const { pairCode, pairAccount } = i18n.dictionaries[locale];
    expect(pairCode, locale).not.toBe(pairAccount);
    if (locale === 'en') { expect(pairCode).toBe('Pairing code'); expect(pairAccount).toBe('Pair account'); }
    else { expect(pairCode, locale).not.toBe('Create pairing code'); expect(pairAccount, locale).not.toBe('Create pairing code'); }
  }
  expect(i18n.dictionaries.vi.pairCode).toBe('Mã ghép nối'); expect(i18n.dictionaries.nl.pairAccount).toBe('Account koppelen');
  const html = readFileSync(new URL('../../clipper/popup.html', import.meta.url), 'utf8');
  expect(html).toContain('data-i18n="pairCode">Pairing code'); expect(html).toContain('data-i18n="pairAccount">Pair account');
});
