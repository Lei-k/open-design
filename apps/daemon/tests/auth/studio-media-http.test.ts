import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, expect, it } from 'vitest';
import { cleanupIsolatedDataRoot, loadIsolatedServerModule, multiUserOptions, provisionAccounts,
  startMultiUserDaemon, type Principal, type StartedMultiUserDaemon } from './multiuser-harness.js';

// Studio media (#63): image, speech and video functions run on the turn's own
// key, write only into the run's project, and report usage on the run.
let daemon: StartedMultiUserDaemon;
let a: Principal; let b: Principal; let admin: Principal;
const key = 'sk-media-account-key-0123456789abcdefghij';
const PNG = Buffer.concat([Buffer.from('89504e470d0a1a0a', 'hex'), Buffer.alloc(64, 7)]);
const MP4 = Buffer.concat([Buffer.from([0, 0, 0, 24]), Buffer.from('ftypisom'), Buffer.alloc(64, 1)]);
let plan: Array<{ name: string; arguments: Record<string, unknown> }> = [];
let imageStatus = 200;
const media: Array<{ url: string; authorization: string; body?: Record<string, unknown> }> = [];
let toolOutputs: string[] = [];
const fixtureFetch: typeof fetch = async (url, init) => {
  const target = String(url);
  const authorization = new Headers(init?.headers).get('authorization') ?? '';
  if (target !== 'https://api.openai.com/v1/responses') {
    media.push({ url: target, authorization, ...(init?.body ? { body: JSON.parse(String(init.body)) } : {}) });
    if (target.endsWith('/images/generations')) {
      return imageStatus === 200 ? Response.json({ data: [{ b64_json: PNG.toString('base64') }] })
        : new Response(`${key} provider detail`, { status: imageStatus });
    }
    if (target.endsWith('/audio/speech')) return new Response(Buffer.from('ID3-fixture-mp3-bytes'), { headers: { 'content-type': 'audio/mpeg' } });
    if (target.endsWith('/videos')) return Response.json({ id: 'video_fixture_1', status: 'queued' });
    if (target.endsWith('/videos/video_fixture_1')) return Response.json({ id: 'video_fixture_1', status: 'completed' });
    if (target.endsWith('/videos/video_fixture_1/content')) return new Response(MP4, { headers: { 'content-type': 'video/mp4' } });
    return new Response('unexpected', { status: 404 });
  }
  const body = JSON.parse(String(init?.body)) as { input: Array<Record<string, unknown>>; tools: Array<{ name: string }> };
  expect(body.tools.map((tool) => tool.name)).toEqual(expect.arrayContaining(['generate_image', 'generate_speech', 'generate_video']));
  toolOutputs = body.input.filter((item) => item.type === 'function_call_output').map((item) => String(item.output));
  const done = toolOutputs.length;
  const next = plan[done];
  const output = next ? [{ type: 'function_call', call_id: `media-${done}`, name: next.name, arguments: JSON.stringify(next.arguments) }]
    : [{ type: 'message', role: 'assistant', content: [{ type: 'output_text', text: 'Media ready.' }] }];
  const events = [...(next ? [] : [{ type: 'response.output_text.delta', delta: 'Media ready.' }]), { type: 'response.completed', response: { output } }];
  return new Response(events.map((event) => `data: ${JSON.stringify(event)}\n\n`).join(''), { headers: { 'content-type': 'text/event-stream' } });
};

beforeAll(async () => {
  await loadIsolatedServerModule();
  daemon = await startMultiUserDaemon(multiUserOptions({ testCompanyOpenAIFetch: fixtureFetch }));
  const accounts = await provisionAccounts(daemon, ['media-a', 'media-b']);
  [a, b] = accounts.users as [Principal, Principal]; admin = accounts.admin;
  expect((await daemon.request({ method: 'PUT', path: '/api/multiuser/settings/provider-keys/openai', cookie: a.cookie,
    body: { revision: 0, apiKey: key } })).status).toBe(200);
}, 120_000);
afterAll(async () => { await daemon?.close(); cleanupIsolatedDataRoot(); });

async function turn(steps: typeof plan, kind = 'image') {
  plan = steps;
  const projectId = randomUUID();
  const made = await daemon.request({ method: 'POST', path: '/api/projects', cookie: a.cookie,
    body: { id: projectId, name: 'Media project', metadata: { kind } } });
  expect(made.status, made.text).toBe(200);
  const run = await daemon.request({ method: 'POST', path: '/api/runs', cookie: a.cookie, body: { projectId, conversationId: made.json.conversationId,
    agentId: 'openai-byok', executionSource: 'personal_api_key', message: 'Make the media' } });
  expect(run.status, run.text).toBe(202);
  const events = await daemon.request({ path: `/api/runs/${run.json.runId}/events`, cookie: a.cookie });
  const info = await daemon.request({ path: `/api/runs/${run.json.runId}`, cookie: a.cookie });
  return { projectId, events: events.text, info: info.json };
}

it('generates an image, narration and a video clip on the account key and saves them only in the run project', async () => {
  media.length = 0;
  const { projectId, events, info } = await turn([
    { name: 'generate_image', arguments: { prompt: 'A calm product hero', path: 'assets/hero.png', size: '1536x1024' } },
    { name: 'generate_speech', arguments: { text: 'Welcome to the launch.', voice: 'coral', path: 'audio/welcome.mp3' } },
    { name: 'generate_video', arguments: { prompt: 'Slow pan over the hero', path: 'video/pan.mp4', size: '1280x720', seconds: '4' } },
  ]);
  expect(info.status).toBe('succeeded');
  expect(info.output.media).toEqual({ images: 1, speechCharacters: 22, videoSeconds: 4 });
  expect(info.output.files).toEqual(expect.arrayContaining(['assets/hero.png', 'audio/welcome.mp3', 'video/pan.mp4']));
  expect(events).toContain('"name":"generate_image"');
  expect(events).not.toContain(key);
  expect(media.every((call) => call.authorization === `Bearer ${key}`)).toBe(true);
  expect(media.find((call) => call.url.endsWith('/images/generations'))?.body).toMatchObject({ model: 'gpt-image-1', size: '1536x1024' });
  const image = await daemon.request({ path: `/api/projects/${projectId}/raw/assets/hero.png`, cookie: a.cookie });
  expect(image.status).toBe(200);
  expect((await daemon.request({ path: `/api/projects/${projectId}/raw/assets/hero.png`, cookie: b.cookie })).status).toBe(404);
  const listed = await daemon.request({ path: `/api/projects/${projectId}/files`, cookie: a.cookie });
  expect(listed.json.files.map((file: { name: string }) => file.name)).toEqual(expect.arrayContaining(['assets/hero.png', 'audio/welcome.mp3', 'video/pan.mp4']));
});

it('refuses unsafe outputs and reports provider refusals to the model without echoing them', async () => {
  imageStatus = 401;
  const { projectId, events, info } = await turn([
    { name: 'generate_image', arguments: { prompt: 'x', path: '../escape.png', size: '1024x1024' } },
    { name: 'generate_image', arguments: { prompt: 'x', path: '.hidden/a.png', size: '1024x1024' } },
    { name: 'generate_image', arguments: { prompt: 'x', path: 'ok.png', size: '1024x1024' } },
  ]);
  imageStatus = 200;
  expect(info.status).toBe('succeeded');
  // Run events redact tool output; the model receives the secret-free codes.
  expect(events.match(/"isError":true/g)).toHaveLength(3);
  expect(toolOutputs).toEqual([JSON.stringify({ error: 'MEDIA_INPUT_REFUSED' }), JSON.stringify({ error: 'MEDIA_INPUT_REFUSED' }),
    JSON.stringify({ error: 'MEDIA_PROVIDER_AUTH' })]);
  expect(events + toolOutputs.join('')).not.toContain('provider detail');
  expect(info.output.media).toBeUndefined();
  expect((await daemon.request({ path: `/api/projects/${projectId}/raw/ok.png`, cookie: a.cookie })).status).toBe(404);
  // An admin has no media or key path into the account's work.
  expect((await daemon.request({ path: `/api/projects/${projectId}/files`, cookie: admin.cookie })).status).toBe(404);
});
