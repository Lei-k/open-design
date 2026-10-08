// Test-only production daemon host. Run in its own process because server.ts
// resolves the data root at import time. This is not a development launcher.
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import type { Server } from 'node:http';
import { MULTIUSER_NOT_LAUNCH_READY_ACK } from '../../../apps/daemon/src/services/multiuser-mode.js';

interface StartedStudioHost { url: string; server: Server; shutdown: () => Promise<void> | void }

process.once('message', async (input: { dataRoot: string; appOrigin: string; previewOrigin: string; workspaceRoot: string }) => {
  process.env.OD_DATA_DIR = input.dataRoot;
  // The daemon compiles against its own Node/undici environment. Do not pull
  // its entire private TS graph into the browser test compiler.
  const { startServer } = await import(pathToFileURL(path.join(input.workspaceRoot, 'apps/daemon/src/server.ts')).href) as {
    startServer: (options: unknown) => Promise<StartedStudioHost>;
  };
  // Mock only the external provider; all HTTP admission, authorization, file
  // functions, persistence and browser transports use the production daemon.
  const companyFetch: typeof fetch = async (url, init) => {
    // Media endpoints (#63): a fixed valid PNG for images.
    if (String(url) === 'https://api.openai.com/v1/images/generations') {
      const png = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==';
      return Response.json({ data: [{ b64_json: png }] });
    }
    const request = JSON.parse(String(init?.body)) as { input: Array<{ type?: string; role?: string; content?: unknown }> };
    // Automatic memory (#62): the extractor's request returns one durable fact.
    if (String(request.input.find((item) => item.role === 'developer')?.content ?? '').startsWith('You are a memory extractor')) {
      const entries = JSON.stringify({ entries: [{ type: 'feedback', name: 'Prefers dense dashboards', description: 'Layout preference',
        body: 'Likes dense dashboards with small type.' }] });
      return new Response([{ type: 'response.output_text.delta', delta: entries }, { type: 'response.completed', response: { output: [] } }]
        .map((event) => `data: ${JSON.stringify(event)}\n\n`).join(''), { headers: { 'content-type': 'text/event-stream' } });
    }
    const wrote = request.input.some((item) => item.type === 'function_call_output');
    const user = request.input.filter((item) => item.role === 'user').map((item) => String(item.content)).join('\n');
    if (user.includes('BROWSER_IMAGE')) {
      const output = wrote ? [{ type: 'message', role: 'assistant', content: [{ type: 'output_text', text: 'Image saved to hero.png.' }] }]
        : [{ type: 'function_call', call_id: 'browser-image', name: 'generate_image', arguments: JSON.stringify({ prompt: 'A product hero', path: 'hero.png', size: '1024x1024' }) }];
      const events = [...(wrote ? [{ type: 'response.output_text.delta', delta: 'Image saved to hero.png.' }] : []), { type: 'response.completed', response: { output } }];
      return new Response(events.map((event) => `data: ${JSON.stringify(event)}\n\n`).join(''), { headers: { 'content-type': 'text/event-stream' } });
    }
    const output = wrote ? [{ type: 'message', role: 'assistant', content: [{ type: 'output_text', text: 'Company browser design complete.' }] }]
      : [{ type: 'function_call', call_id: 'browser-write', name: 'write_project_file', arguments: JSON.stringify({ path: 'company.html', content: '<!doctype html><html><body><h1>Company browser design</h1></body></html>' }) }];
    const events = [...(wrote ? [{ type: 'response.output_text.delta', delta: 'Company browser design complete.\n' }] : []), { type: 'response.completed', response: { output } }];
    return new Response(events.map((event) => `data: ${JSON.stringify(event)}\n\n`).join(''), { headers: { 'content-type': 'text/event-stream' } });
  };
  const started = await startServer({ port: 0, host: '127.0.0.1', returnServer: true,
    staticDir: path.join(input.workspaceRoot, 'apps/web/out'),
    multiUser: { acknowledgeNotLaunchReady: MULTIUSER_NOT_LAUNCH_READY_ACK,
      allowedOrigins: [input.appOrigin], previewOrigin: input.previewOrigin,
      bootstrapSecret: 'studio-browser-fixture-bootstrap-secret',
      auth: { passwordParams: { logN: 14, r: 8, p: 1 } },
      testCompanyOpenAIFetch: companyFetch,
      // Account research (#63): a fixed Tavily answer; accounts still need their own key.
      testTavilyFetch: async () => Response.json({ answer: 'Calm, muted palettes lead this season.',
        results: [{ title: 'Palette trends', url: 'https://example.test/palette-trends', content: 'Muted greens and warm greys.' }] }),
      testPersonalCodexAppServer: path.join(input.workspaceRoot, 'mocks/personal-codex-app-server.ts'),
      // Server-rendered exports through Playwright's managed Chromium; no external asset hosts in tests.
      studioRenderer: { assetHosts: [],
        domToPptxBundlePath: path.join(input.workspaceRoot, 'apps/desktop/vendor/dom-to-pptx/dom-to-pptx.bundle.js.gz') } },
  });
  if (!started || typeof started !== 'object' || !('server' in started)) throw new Error('Missing daemon test host');
  let closing = false;
  const close = async () => {
    if (closing) return;
    closing = true;
    await started.shutdown();
    started.server.closeAllConnections();
    await new Promise<void>((resolve) => started.server.close(() => resolve()));
    process.exit(0);
  };
  process.once('SIGTERM', () => { void close(); });
  process.once('disconnect', () => { void close(); });
  process.send?.({ url: started.url });
});
