import { writeCompanyProjectMedia, MEDIA_FILE_LIMIT } from '../services/company-project-files.js';

type Json = Record<string, unknown>;

/** Provider models the Studio media tools call; billed to the turn's own key (#63). */
export const STUDIO_MEDIA_MODELS = { image: 'gpt-image-1', speech: 'gpt-4o-mini-tts', video: 'sora-2' } as const;
const IMAGE_SIZES = ['1024x1024', '1536x1024', '1024x1536', 'auto'] as const;
const VOICES = ['alloy', 'ash', 'ballad', 'coral', 'echo', 'fable', 'nova', 'onyx', 'sage', 'shimmer', 'verse'] as const;
const VIDEO_SIZES = ['1280x720', '720x1280'] as const;
const VIDEO_SECONDS = ['4', '8', '12'] as const;
const VIDEO_POLL_MS = 5_000;
const VIDEO_DEADLINE_MS = 8 * 60_000;

/** Function tools for the Responses API; strict schemas, project-relative outputs only. */
export const STUDIO_MEDIA_TOOLS = [
  { name: 'generate_image', description: `Generate an image with ${STUDIO_MEDIA_MODELS.image} and save it as a PNG in the current project. Reference it from HTML by its relative path.`,
    properties: { prompt: { type: 'string' }, path: { type: 'string', description: 'Project-relative .png path' },
      size: { type: 'string', enum: [...IMAGE_SIZES] } }, required: ['prompt', 'path', 'size'] },
  { name: 'generate_speech', description: `Synthesize narration or a voice line with ${STUDIO_MEDIA_MODELS.speech} and save it as an MP3 in the current project.`,
    properties: { text: { type: 'string' }, voice: { type: 'string', enum: [...VOICES] }, path: { type: 'string', description: 'Project-relative .mp3 path' } },
    required: ['text', 'voice', 'path'] },
  { name: 'generate_video', description: `Generate a short video clip with ${STUDIO_MEDIA_MODELS.video} and save it as an MP4 in the current project. Takes minutes; generate one clip at a time.`,
    properties: { prompt: { type: 'string' }, path: { type: 'string', description: 'Project-relative .mp4 path' },
      size: { type: 'string', enum: [...VIDEO_SIZES] }, seconds: { type: 'string', enum: [...VIDEO_SECONDS] } },
    required: ['prompt', 'path', 'size', 'seconds'] },
] as const;
export const STUDIO_MEDIA_TOOL_NAMES: ReadonlySet<string> = new Set(STUDIO_MEDIA_TOOLS.map((tool) => tool.name));

export interface StudioMediaUsage { images: number; speechCharacters: number; videoSeconds: number }
export const emptyStudioMediaUsage = (): StudioMediaUsage => ({ images: 0, speechCharacters: 0, videoSeconds: 0 });

/** Secret-free error classes; provider bodies are never kept. */
export class StudioMediaError extends Error {
  constructor(readonly code: 'MEDIA_INPUT_REFUSED' | 'MEDIA_PROVIDER_AUTH' | 'MEDIA_RATE_LIMITED' | 'MEDIA_PROVIDER_FAILED' | 'MEDIA_TIMEOUT') { super(code); }
}
const providerError = (status: number) => new StudioMediaError(status === 401 || status === 403 ? 'MEDIA_PROVIDER_AUTH'
  : status === 429 ? 'MEDIA_RATE_LIMITED' : 'MEDIA_PROVIDER_FAILED');

async function boundedBytes(response: Response, limit: number): Promise<Buffer> {
  if (!response.body) throw new StudioMediaError('MEDIA_PROVIDER_FAILED');
  const reader = response.body.getReader(); const chunks: Buffer[] = []; let total = 0;
  try {
    for (;;) {
      const chunk = await reader.read(); if (chunk.done) break;
      total += chunk.value.byteLength; if (total > limit) throw new StudioMediaError('MEDIA_PROVIDER_FAILED');
      chunks.push(Buffer.from(chunk.value));
    }
  } finally { await reader.cancel().catch(() => {}); }
  return Buffer.concat(chunks);
}

/**
 * Run one media tool for an OpenAI worker turn. The key is the turn's own
 * (company or the account's), so the provider bill follows the turn; the
 * output lands only inside the run's project through the descriptor-checked
 * writer. Returns the saved relative path.
 */
export async function runStudioMediaTool(name: string, args: Json, ctx: {
  apiKey: string; fetch: typeof fetch; signal: AbortSignal; projectsRoot: string; projectId: string;
  check: () => void; usage: StudioMediaUsage; sleep?: (ms: number, signal: AbortSignal) => Promise<void>;
}): Promise<{ saved: string; bytes: number; model: string }> {
  const keys = (allowed: string[]) => Object.keys(args).every((key) => allowed.includes(key));
  const relative = (value: unknown, ext: string) => typeof value === 'string' && value.length <= 512 && value.toLowerCase().endsWith(ext)
    && !value.includes('\0') && !value.startsWith('/') && !value.includes('\\') && !value.split('/').some((part) => !part || part === '..' || part.startsWith('.'));
  const headers = { authorization: `Bearer ${ctx.apiKey}`, 'content-type': 'application/json' };
  const post = (url: string, body: Json) => ctx.fetch(url, { method: 'POST', signal: ctx.signal, redirect: 'error', headers, body: JSON.stringify(body) });
  const save = (path: string, bytes: Buffer, model: string) => {
    ctx.check(); writeCompanyProjectMedia(ctx.projectsRoot, ctx.projectId, path, bytes);
    return { saved: path, bytes: bytes.length, model };
  };
  if (name === 'generate_image') {
    if (!keys(['prompt', 'path', 'size']) || typeof args.prompt !== 'string' || !args.prompt.trim() || args.prompt.length > 32_000
      || !relative(args.path, '.png') || !IMAGE_SIZES.includes(args.size as never)) throw new StudioMediaError('MEDIA_INPUT_REFUSED');
    const response = await post('https://api.openai.com/v1/images/generations', { model: STUDIO_MEDIA_MODELS.image, prompt: args.prompt, size: args.size, n: 1 });
    ctx.check();
    if (!response.ok) { await response.body?.cancel(); throw providerError(response.status); }
    const json = JSON.parse((await boundedBytes(response, MEDIA_FILE_LIMIT * 2)).toString('utf8')) as { data?: Array<{ b64_json?: unknown }> };
    const encoded = json.data?.[0]?.b64_json;
    if (typeof encoded !== 'string') throw new StudioMediaError('MEDIA_PROVIDER_FAILED');
    const bytes = Buffer.from(encoded, 'base64');
    if (bytes.subarray(0, 8).toString('hex') !== '89504e470d0a1a0a') throw new StudioMediaError('MEDIA_PROVIDER_FAILED');
    ctx.usage.images += 1;
    return save(args.path as string, bytes, STUDIO_MEDIA_MODELS.image);
  }
  if (name === 'generate_speech') {
    if (!keys(['text', 'voice', 'path']) || typeof args.text !== 'string' || !args.text.trim() || args.text.length > 4096
      || !VOICES.includes(args.voice as never) || !relative(args.path, '.mp3')) throw new StudioMediaError('MEDIA_INPUT_REFUSED');
    const response = await post('https://api.openai.com/v1/audio/speech', { model: STUDIO_MEDIA_MODELS.speech, voice: args.voice, input: args.text, response_format: 'mp3' });
    ctx.check();
    if (!response.ok) { await response.body?.cancel(); throw providerError(response.status); }
    const bytes = await boundedBytes(response, MEDIA_FILE_LIMIT);
    if (bytes.length < 4) throw new StudioMediaError('MEDIA_PROVIDER_FAILED');
    ctx.usage.speechCharacters += args.text.length;
    return save(args.path as string, bytes, STUDIO_MEDIA_MODELS.speech);
  }
  if (name === 'generate_video') {
    if (!keys(['prompt', 'path', 'size', 'seconds']) || typeof args.prompt !== 'string' || !args.prompt.trim() || args.prompt.length > 32_000
      || !relative(args.path, '.mp4') || !VIDEO_SIZES.includes(args.size as never) || !VIDEO_SECONDS.includes(args.seconds as never)) {
      throw new StudioMediaError('MEDIA_INPUT_REFUSED');
    }
    const created = await post('https://api.openai.com/v1/videos', { model: STUDIO_MEDIA_MODELS.video, prompt: args.prompt, size: args.size, seconds: args.seconds });
    ctx.check();
    if (!created.ok) { await created.body?.cancel(); throw providerError(created.status); }
    const job = JSON.parse((await boundedBytes(created, 64 * 1024)).toString('utf8')) as { id?: unknown };
    if (typeof job.id !== 'string' || !/^[A-Za-z0-9_-]{1,128}$/.test(job.id)) throw new StudioMediaError('MEDIA_PROVIDER_FAILED');
    const sleep = ctx.sleep ?? ((ms, signal) => new Promise<void>((resolve, reject) => {
      const timer = setTimeout(resolve, ms);
      signal.addEventListener('abort', () => { clearTimeout(timer); reject(signal.reason); }, { once: true });
    }));
    const deadline = Date.now() + VIDEO_DEADLINE_MS;
    for (;;) {
      const status = await ctx.fetch(`https://api.openai.com/v1/videos/${job.id}`, { signal: ctx.signal, redirect: 'error', headers: { authorization: headers.authorization } });
      ctx.check();
      if (!status.ok) { await status.body?.cancel(); throw providerError(status.status); }
      const state = JSON.parse((await boundedBytes(status, 64 * 1024)).toString('utf8')) as { status?: unknown };
      if (state.status === 'completed') break;
      if (state.status === 'failed' || state.status === 'canceled') throw new StudioMediaError('MEDIA_PROVIDER_FAILED');
      if (Date.now() > deadline) throw new StudioMediaError('MEDIA_TIMEOUT');
      await sleep(VIDEO_POLL_MS, ctx.signal); ctx.check();
    }
    const content = await ctx.fetch(`https://api.openai.com/v1/videos/${job.id}/content`, { signal: ctx.signal, redirect: 'error', headers: { authorization: headers.authorization } });
    ctx.check();
    if (!content.ok) { await content.body?.cancel(); throw providerError(content.status); }
    const bytes = await boundedBytes(content, MEDIA_FILE_LIMIT);
    if (bytes.subarray(4, 8).toString('latin1') !== 'ftyp') throw new StudioMediaError('MEDIA_PROVIDER_FAILED');
    ctx.usage.videoSeconds += Number(args.seconds);
    return save(args.path as string, bytes, STUDIO_MEDIA_MODELS.video);
  }
  throw new StudioMediaError('MEDIA_INPUT_REFUSED');
}

/** Runtime addendum for OpenAI worker turns: the tools replace any CLI media workflow in the composed prompt. */
export const STUDIO_MEDIA_PROMPT = `\n\n---\n\n## Studio runtime: media generation\n\nThis runtime has no shell and no \`od\` CLI. Wherever earlier instructions say to run \`od media generate\` or a media CLI, call the matching function instead: \`generate_image\` (PNG), \`generate_speech\` (MP3 narration) or \`generate_video\` (short MP4 clip). Each saves into the current project at the relative path you choose; then reference that path from your HTML or tell the user where it is. Generated media is billed to the same OpenAI account as this conversation, so generate only what the request needs and never loop on retries.`;
