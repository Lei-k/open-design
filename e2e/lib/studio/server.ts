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
  const started = await startServer({ port: 0, host: '127.0.0.1', returnServer: true,
    staticDir: path.join(input.workspaceRoot, 'apps/web/out'),
    multiUser: { acknowledgeNotLaunchReady: MULTIUSER_NOT_LAUNCH_READY_ACK,
      allowedOrigins: [input.appOrigin], previewOrigin: input.previewOrigin,
      bootstrapSecret: 'studio-browser-fixture-bootstrap-secret',
      auth: { passwordParams: { logN: 14, r: 8, p: 1 } },
      testPersonalCodexAppServer: path.join(input.workspaceRoot, 'mocks/personal-codex-app-server.ts') },
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
