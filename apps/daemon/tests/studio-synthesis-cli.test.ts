import { afterEach, expect, it, vi } from 'vitest';
import { runStudioSynthesisCli, studioSynthesisCliRequest } from '../src/projects/synthesis-cli.js';
vi.mock('../src/daemon-url.js', () => ({ resolveDaemonUrl: async () => 'https://studio.invalid' }));
afterEach(() => { vi.restoreAllMocks(); vi.unstubAllGlobals(); });
it.each(['company_pool', 'personal_api_key'])('plans credential-free finalize on %s', async (source) => {
  expect(await studioSynthesisCliRequest(['finalize', 'p', '--execution-source', source, '--json']))
    .toEqual({ method: 'POST', path: '/api/projects/p/finalize/openai', body: { executionSource: source }, json: true });
});
it('plans bounded JSON stdin handoff and digest state without alternate transport', async () => {
  expect(await studioSynthesisCliRequest(['handoff', 'p', '--prompt-file', '-', '--json'], async () => JSON.stringify({ conversationId: 'c', executionSource: 'personal_api_key' })))
    .toMatchObject({ method: 'POST', path: '/api/projects/p/handoff', body: { conversationId: 'c', executionSource: 'personal_api_key' } });
  expect(await studioSynthesisCliRequest(['synthesis', 'p', '--json'])).toMatchObject({ method: 'GET', path: '/api/projects/p/synthesis' });
});
it.each(['apiKey', 'baseUrl', 'protocol', 'model'])('rejects client %s and ambiguous request input', async (field) => {
  await expect(studioSynthesisCliRequest(['finalize', 'p', '--prompt-file', '-'], async () => JSON.stringify({ [field]: 'unsafe' }))).rejects.toThrow();
  await expect(studioSynthesisCliRequest(['finalize', 'p', `--${field}`, 'unsafe'])).rejects.toThrow();
  await expect(studioSynthesisCliRequest(['finalize', 'p', '--execution-source', 'company_pool', '--prompt-file', '-'], async () => '{"executionSource":"personal_api_key"}')).rejects.toThrow();
});
it('bounds stdin and refuses invalid source, tokens and missing conversation', async () => {
  for (const args of [['handoff','p'], ['finalize','p','--execution-source','host'], ['finalize','p','--max-tokens','0']])
    await expect(studioSynthesisCliRequest(args)).rejects.toThrow();
  await expect(studioSynthesisCliRequest(['finalize','p','--prompt-file','-'], async () => 'x'.repeat(8193))).rejects.toThrow();
});
it('uses the same POST contract and never prints untrusted provider error text', async () => {
  const stdout = vi.spyOn(process.stdout, 'write').mockImplementation(() => true);
  const stderr = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
  const fetcher = vi.fn(async () => Response.json({ error: { code: 'MULTIUSER_SYNTHESIS_PROVIDER_FAILED', message: 'sk-provider-secret' } }, { status: 502 }));
  vi.stubGlobal('fetch', fetcher);
  expect(await runStudioSynthesisCli(['finalize', 'p', '--execution-source', 'personal_api_key', '--json'])).toBe(1);
  expect(fetcher).toHaveBeenCalledWith('https://studio.invalid/api/projects/p/finalize/openai', expect.objectContaining({ method: 'POST', body: '{"executionSource":"personal_api_key"}' }));
  expect(stdout).not.toHaveBeenCalled(); expect(stderr.mock.calls.flat().join('')).not.toContain('sk-provider-secret');
  expect(stderr.mock.calls.flat().join('')).toContain('MULTIUSER_SYNTHESIS_PROVIDER_FAILED');
});
it('keeps a typed Codex refusal reason in machine output', async () => {
  vi.spyOn(process.stdout, 'write').mockReturnValue(true);
  const stderr = vi.spyOn(process.stderr, 'write').mockReturnValue(true);
  vi.stubGlobal('fetch', vi.fn(async () => Response.json({ error: { code: 'MULTIUSER_CAPABILITY_UNAVAILABLE', details: { reason: 'personal-codex' } } }, { status: 409 })));
  expect(await runStudioSynthesisCli(['finalize', 'p', '--execution-source', 'personal_subscription', '--json'])).toBe(1);
  expect(JSON.parse(String(stderr.mock.calls[0]![0])).error.details.reason).toBe('personal-codex');
});
it('refuses non-string sources in prompt-file requests before session I/O', async () => {
  await expect(studioSynthesisCliRequest(['finalize','p','--prompt-file','-'], async () => '{"executionSource":["personal_api_key"]}')).rejects.toThrow();
});
