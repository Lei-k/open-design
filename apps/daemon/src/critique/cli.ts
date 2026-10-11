import { constants, fstatSync, openSync, readSync, closeSync } from 'node:fs';

class CritiqueCliInput extends Error {}
const USAGE = `od critique start PROJECT --conversation-id ID --agent codex|openai|openai-byok --prompt-file path|- [--json]
od critique list PROJECT [--json]
od critique status|watch|transcript|interrupt|artifact PROJECT RUN [--json]
Use --session-file for Studio. --prompt TEXT also accepts short prompts.`;

/** Session fetch is installed by cli.ts; every command uses the Web endpoints. */
export async function runCritiqueCli(args: string[], resolveBase: (flags: Record<string, string>) => Promise<string>): Promise<number> {
  const flags: Record<string, string> = {}; const positionals: string[] = []; let json = false;
  try {
    for (let index = 0; index < args.length; index++) {
      const arg = args[index]!;
      if (arg === '--help' || arg === '-h') { console.log(USAGE); return 0; }
      if (arg === '--json') { json = true; continue; }
      if (!arg.startsWith('--')) { positionals.push(arg); continue; }
      const [name, inline] = arg.slice(2).split('=', 2);
      if (!['daemon-url', 'conversation-id', 'agent', 'prompt', 'prompt-file'].includes(name!)) throw new CritiqueCliInput('Invalid critique option.');
      const value = inline ?? args[++index];
      if (!value || value.startsWith('--') || flags[name!] !== undefined) throw new CritiqueCliInput('Invalid critique option value.');
      flags[name!] = value;
    }
    const [command, project, run] = positionals;
    if (!command || !['start', 'list', 'status', 'watch', 'transcript', 'interrupt', 'artifact'].includes(command)
      || positionals.length !== (command === 'start' || command === 'list' ? 2 : 3)
      || !project || !/^[A-Za-z0-9_-]{1,128}$/.test(project) || run && !/^[A-Za-z0-9_-]{1,128}$/.test(run)) throw new CritiqueCliInput('Invalid critique command or arguments.');
    let body: Record<string, unknown> | undefined;
    if (command === 'start') {
      if (!flags['conversation-id'] || !['codex', 'openai', 'openai-byok'].includes(flags.agent ?? '') || Boolean(flags.prompt) === Boolean(flags['prompt-file'])) {
        throw new CritiqueCliInput('Start requires --conversation-id, --agent and exactly one of --prompt or --prompt-file.');
      }
      let prompt = flags.prompt;
      if (flags['prompt-file']) {
        const stdin = flags['prompt-file'] === '-';
        const fd = stdin ? 0 : openSync(flags['prompt-file'], constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
        try {
          if (!stdin && (!fstatSync(fd).isFile() || fstatSync(fd).size > 64000)) throw new CritiqueCliInput('Prompt must be a file of at most 64000 bytes.');
          const buffer = Buffer.alloc(64001); let used = 0;
          while (used < buffer.length) { const read = readSync(fd, buffer, used, buffer.length - used, null); if (!read) break; used += read; }
          if (used > 64000) throw new CritiqueCliInput('Prompt is too large.');
          prompt = buffer.subarray(0, used).toString('utf8');
        } finally { if (!stdin) closeSync(fd); }
      }
      if (!prompt?.trim() || Buffer.byteLength(prompt) > 64000) throw new CritiqueCliInput('Prompt is empty or too large.');
      body = { conversationId: flags['conversation-id'], agentId: flags.agent, message: prompt };
    } else if (Object.keys(flags).some((key) => key !== 'daemon-url')) throw new CritiqueCliInput('Unexpected critique option.');
    const base = await resolveBase(flags);
    const route = `${base}/api/projects/${encodeURIComponent(project)}/critique${run ? `/${encodeURIComponent(run)}` : ''}`
      + (command === 'watch' ? '/events' : ['transcript', 'interrupt', 'artifact'].includes(command) ? `/${command}` : '');
    const response = await fetch(route, { method: command === 'start' || command === 'interrupt' ? 'POST' : 'GET',
      ...(body ? { headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) } : {}) });
    if (!response.ok) { process.stderr.write(`${JSON.stringify(await response.json())}\n`); return 1; }
    if (command === 'artifact') {
      const content = await response.text();
      process.stdout.write(json ? `${JSON.stringify({ mime: response.headers.get('content-type'), content })}\n` : content);
    } else if (command === 'watch') {
      const reader = response.body!.getReader(); const decoder = new TextDecoder(); let pending = '';
      try {
        while (true) {
          const chunk = await reader.read(); pending += decoder.decode(chunk.value, { stream: !chunk.done });
          let end: number;
          while ((end = pending.indexOf('\n\n')) >= 0) {
            const frame = pending.slice(0, end); pending = pending.slice(end + 2);
            const event = /^event: (.+)$/m.exec(frame)?.[1]; const data = /^data: (.+)$/m.exec(frame)?.[1];
            if (event && data) process.stdout.write(json ? `${JSON.stringify({ event, data: JSON.parse(data) })}\n` : `${frame}\n\n`);
          }
          if (pending.length > 8 * 1024 * 1024) throw new Error('critique_frame_limit');
          if (chunk.done) break;
        }
      } finally { await reader.cancel(); }
    } else process.stdout.write(`${JSON.stringify(await response.json())}\n`);
    return 0;
  } catch (error) {
    process.stderr.write(`${JSON.stringify({ error: { code: 'CRITIQUE_CLI_INPUT', message: error instanceof CritiqueCliInput ? error.message : 'Critique command failed; check the session and prompt input.' } })}\n`);
    return 2;
  }
}
