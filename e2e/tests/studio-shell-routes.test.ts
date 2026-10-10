import { expect, it } from 'vitest';
import { fileURLToPath } from 'node:url';
// Load the browser module through Vitest; it has its own Bundler-mode typecheck.
const routerModule = fileURLToPath(new URL('../../apps/web/src/router.ts', import.meta.url));
const { buildPath } = await import(routerModule) as { buildPath: (route: object) => string };
import { publicMultiUserFile } from '../../apps/daemon/src/http/multiuser-static.js';

it('serves canonical App router outputs through the multi-user public shell', () => {
  const home: string[] = ['home', 'onboarding', 'projects', 'tasks', 'plugins', 'design-systems', 'library', 'brands',
    'integrations', 'community', 'drafts', 'all-projects', 'members', 'board', 'workspace-settings', 'settings'];
  const routes: object[] = [
    ...home.map((view) => ({ kind: 'home', view })),
    { kind: 'home', view: 'brands', brandId: 'user:brand' },
    { kind: 'design-system-create' }, { kind: 'design-system-detail', designSystemId: 'user:brand' },
    { kind: 'marketplace' }, { kind: 'marketplace-detail', pluginId: 'my plugin' },
    { kind: 'collab-demo', projectId: null }, { kind: 'collab-demo', projectId: 'p-1' }, { kind: 'community' },
    ...[null, 'c-1'].flatMap((conversationId) => [null, 'nested/hello world.html', '日本語.html'].map((fileName) => ({
      kind: 'project', projectId: 'p-1', conversationId, fileName,
    }))),
  ];
  for (const route of routes) expect(publicMultiUserFile(buildPath(route)), JSON.stringify(route)).toBe('index.html');
});
