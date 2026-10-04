import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  cancelCodexLogin,
  fetchPersonalAgentAccounts,
  readCodexLogin,
  startCodexLogin,
  unlinkCodexAccount,
  verifyCodexAccount,
} from '../../src/providers/agent-accounts';

const summary = {
  mode: 'multi-user',
  personalSubscriptionsEnabled: true,
  codex: { account: null, pendingAttempt: null },
  claude: { available: false },
};

function respond(status: number, body: unknown) {
  return vi.fn(async () => new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } }));
}

describe('agent accounts API client', () => {
  afterEach(() => vi.unstubAllGlobals());

  it('fails closed: single-user 404, signed-out 401, bad shapes and network errors read as null', async () => {
    for (const fetchMock of [
      respond(404, { error: { code: 'NOT_FOUND' } }),
      respond(401, { error: { code: 'UNAUTHORIZED' } }),
      respond(200, { ...summary, mode: 'single-user' }),
      respond(200, { codex: {} }),
      vi.fn(async () => { throw new TypeError('offline'); }),
    ]) {
      vi.stubGlobal('fetch', fetchMock);
      expect(await fetchPersonalAgentAccounts()).toBeNull();
    }
    vi.stubGlobal('fetch', respond(200, summary));
    expect(await fetchPersonalAgentAccounts()).toEqual(summary);
  });

  it('sends explicit consent only through verify and encodes ids into the path', async () => {
    const fetchMock = respond(200, { account: { id: 'acc' } });
    vi.stubGlobal('fetch', fetchMock);
    await verifyCodexAccount('a/b');
    const [url, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe('/api/agent-accounts/codex/accounts/a%2Fb/verify');
    expect(init.method).toBe('POST');
    expect(JSON.parse(String(init.body))).toEqual({ consentToUsePlan: true });
  });

  it('maps every login action to its route and surfaces stable error codes', async () => {
    const fetchMock = respond(202, { attempt: { id: 'att', status: 'pending' } });
    vi.stubGlobal('fetch', fetchMock);
    expect(await startCodexLogin()).toEqual({ ok: true, value: { id: 'att', status: 'pending' } });
    await readCodexLogin('att');
    await cancelCodexLogin('att');
    expect(fetchMock.mock.calls.map((call) => (call as unknown as [string, RequestInit]).slice(0, 2).map((v, i) => (i === 0 ? v : (v as RequestInit).method))))
      .toEqual([
        ['/api/agent-accounts/codex/logins', 'POST'],
        ['/api/agent-accounts/codex/logins/att', 'GET'],
        ['/api/agent-accounts/codex/logins/att/cancel', 'POST'],
      ]);
    vi.stubGlobal('fetch', respond(403, { error: { code: 'MULTIUSER_PERSONAL_DISABLED' } }));
    expect(await startCodexLogin()).toEqual({ ok: false, status: 403, code: 'MULTIUSER_PERSONAL_DISABLED' });
    vi.stubGlobal('fetch', respond(200, { unlinked: true }));
    expect(await unlinkCodexAccount('acc')).toEqual({ ok: true, value: true });
  });
});
