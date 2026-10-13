import { closeSync, constants, fstatSync, openSync, readSync } from 'node:fs';
import type { StudioFinalizeRequest, StudioHandoffRequest, StudioSynthesisResult } from '@open-design/contracts';
import { API_ERROR_CODES, STUDIO_SYNTHESIS_REFUSALS } from '@open-design/contracts';
import { resolveDaemonUrl } from '../daemon-url.js';

export const STUDIO_SYNTHESIS_USAGE = `od project finalize|handoff|synthesis PROJECT --session-file PATH [--json]
  finalize|handoff: [--execution-source company_pool|personal_api_key|personal_subscription]
                   [--max-tokens N] [--digest SHA256] [--prompt-file PATH|-]
  handoff: --conversation ID
  --prompt-file supplies the credential-free request as JSON, bounded to 8 KiB.
  Omitted source uses this actor's latest project turn pin. Codex is refused.
  Credentials, endpoints, protocols and models come from Studio Settings.`;

async function input(file: string): Promise<string> {
  if (file === '-') {
    let text = ''; let size = 0;
    for await (const chunk of process.stdin) {
      size += Buffer.byteLength(chunk); if (size > 8192) throw new Error('size'); text += String(chunk);
    }
    return text;
  }
  const fd = openSync(file, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  try {
    const stat = fstatSync(fd); if (!stat.isFile() || stat.size > 8192) throw new Error('file');
    const buffer = Buffer.alloc(8193); let bytes = 0;
    for (;;) { const count = readSync(fd, buffer, bytes, buffer.length - bytes, bytes); if (!count) break; bytes += count; if (bytes > 8192) throw new Error('size'); }
    return buffer.subarray(0, bytes).toString('utf8');
  }
  finally { closeSync(fd); }
}
export async function studioSynthesisCliRequest(args: string[], read = input): Promise<{
  method: 'GET' | 'POST'; path: string; body?: StudioFinalizeRequest | StudioHandoffRequest; json: boolean; daemonUrl?: string;
}> {
  const [action, ...rest] = args;
  const positionals: string[] = []; const flags: Record<string,string> = {}; let json = false;
  for (let i = 0; i < rest.length; i++) {
    const flag = rest[i]!;
    if (flag === '--json') { json = true; continue; }
    if (['--execution-source','--conversation','--max-tokens','--digest','--prompt-file','--daemon-url'].includes(flag)) {
      const value = rest[++i]; if (!value || value.startsWith('--') || flags[flag] !== undefined) throw new Error('flags');
      flags[flag] = value;
    } else if (flag.startsWith('-')) throw new Error('flags'); else positionals.push(flag);
  }
  if (!['finalize','handoff','synthesis'].includes(action ?? '') || positionals.length !== 1) throw new Error('arguments');
  let body: Record<string,unknown> = {};
  if (flags['--prompt-file']) {
    const raw = await read(flags['--prompt-file']); if (Buffer.byteLength(raw) > 8192) throw new Error('size');
    body = JSON.parse(raw) as Record<string,unknown>;
  }
  if (!body || typeof body !== 'object' || Array.isArray(body)
    || Object.keys(body).some((key) => !['executionSource','conversationId','maxTokens','digest'].includes(key))) throw new Error('body');
  for (const [flag,key] of [['--execution-source','executionSource'],['--conversation','conversationId'],['--max-tokens','maxTokens'],['--digest','digest']] as const) {
    if (flags[flag] !== undefined) { if (body[key] !== undefined) throw new Error('ambiguous'); body[key] = key === 'maxTokens' ? Number(flags[flag]) : flags[flag]; }
  }
  if (body.executionSource !== undefined && (typeof body.executionSource !== 'string' || !['personal_api_key','company_pool','personal_subscription'].includes(body.executionSource))
    || body.maxTokens !== undefined && (!Number.isSafeInteger(body.maxTokens) || Number(body.maxTokens) < 1 || Number(body.maxTokens) > 16384)
    || body.digest !== undefined && (typeof body.digest !== 'string' || !/^[a-f0-9]{64}$/.test(body.digest))
    || action === 'handoff' && (typeof body.conversationId !== 'string' || !body.conversationId)
    || action !== 'handoff' && body.conversationId !== undefined || action === 'synthesis' && Object.keys(body).length) throw new Error('body');
  return { method: action === 'synthesis' ? 'GET' : 'POST', path: `/api/projects/${encodeURIComponent(positionals[0]!)}/${action === 'finalize' ? 'finalize/openai' : action}`,
    ...(action === 'synthesis' ? {} : { body: body as StudioFinalizeRequest | StudioHandoffRequest }), json,
    ...(flags['--daemon-url'] ? { daemonUrl: flags['--daemon-url'] } : {}) };
}
export async function runStudioSynthesisCli(args: string[]): Promise<number> {
  if (args.includes('--help') || args.includes('-h')) { process.stdout.write(`${STUDIO_SYNTHESIS_USAGE}\n`); return 0; }
  try {
    const request = await studioSynthesisCliRequest(args);
    const base = await resolveDaemonUrl(request.daemonUrl ? { flagUrl: request.daemonUrl } : {});
    const response = await fetch(`${base.replace(/\/$/,'')}${request.path}`, { method: request.method,
      ...(request.body ? { headers: { 'content-type':'application/json' }, body: JSON.stringify(request.body) } : {}) });
    const result = await response.json() as StudioSynthesisResult & { error?: { code?: string; details?: { reason?: unknown } } };
    if (!response.ok) {
      const code = result.error?.code && (API_ERROR_CODES as readonly string[]).includes(result.error.code) ? result.error.code : 'CLI_SESSION_REQUEST_FAILED';
      const reason = result.error?.details?.reason;
      process.stderr.write(`${JSON.stringify({ ok: false, error: { code, message: 'Studio synthesis refused. Review source, project and session state.',
        ...(typeof reason === 'string' && (STUDIO_SYNTHESIS_REFUSALS as readonly string[]).includes(reason) ? { details: { reason } } : {}) } })}\n`);
      return 1;
    }
    if (request.method === 'POST' && (result.current !== true || typeof result.digest !== 'string' || typeof result.fileName !== 'string')) throw new Error('response');
    process.stdout.write(request.json || request.method === 'GET' ? `${JSON.stringify(result)}\n`
      : `${result.prompt ?? result.fileName}\n`);
    return 0;
  } catch {
    process.stderr.write(`${JSON.stringify({ ok: false, error: { code: 'CLI_SESSION_REQUEST_FAILED', message: 'Invalid Studio synthesis request or unavailable session.' } })}\n`);
    return 1;
  }
}
