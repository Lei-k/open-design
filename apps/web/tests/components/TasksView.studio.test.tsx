// @vitest-environment jsdom

// #64: a Studio account's Automations tab. Connector-only bundled templates
// and connector/live-artifact routines stay visible but disabled with the
// reason; a template routine records its bundled template on the account's
// own routine; typed daemon refusals show their message.
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, expect, it, vi } from 'vitest';
import { STUDIO_PARITY_LANES, type AuthAccount, type StudioAutomationTemplate, type StudioRuntimeCapabilities } from '@open-design/contracts';
import { CookieSession } from '../../src/multiuser/session';
import { activateStudioTransport } from '../../src/runtime/studio-transport';
import { TasksView } from '../../src/components/TasksView';

const capabilities: StudioRuntimeCapabilities = { schemaVersion: 1, shell: 'studio', features: Object.fromEntries(
  STUDIO_PARITY_LANES.map(({ id }) => [id, id === 'automations' ? { status: 'pilot', reason: 'Pilot automations' } : { status: 'unavailable', reason: 'Pending' }]),
) as StudioRuntimeCapabilities['features'] };
const account: AuthAccount = { id: 'A', username: 'A', role: 'user', active: true, passwordState: 'set', createdAt: 1, updatedAt: 1 };
const memoryTemplate: StudioAutomationTemplate = {
  id: 'ingest-source-memory-tree', title: 'Ingest source into memory tree', description: 'Reviewable memory nodes.',
  purpose: 'Keep durable knowledge.', triggerKinds: ['manual', 'schedule'], sourceKinds: ['upload', 'chat'],
  stages: [{ id: 'ingest', kind: 'ingest', title: 'Capture source' }], outputSinks: ['memory'], reviewPolicy: 'always', tokenCompression: 'balanced',
};
const connectorTemplate: StudioAutomationTemplate = {
  ...memoryTemplate, id: 'connector-digest-design-context', title: 'Connector digest to design context', triggerKinds: ['schedule', 'connector'],
  sourceKinds: ['connector'], tags: ['connectors'], unavailable: { code: 'MULTIUSER_CAPABILITY_UNAVAILABLE', requires: 'connectors' },
};

afterEach(() => { cleanup(); vi.restoreAllMocks(); vi.unstubAllGlobals(); });

it('disables connector templates with the reason and records the bundled template on the account routine', async () => {
  const posts: Array<{ url: string; body: Record<string, unknown> }> = [];
  vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    if (url === '/api/auth/me') return Response.json({ account, studio: capabilities, studioRevision: 1 });
    if (url === '/api/automation-templates') return Response.json({ templates: [memoryTemplate, connectorTemplate] });
    if (url.startsWith('/api/automation-proposals')) return Response.json({ proposals: [] });
    if (url === '/api/routines' && init?.method === 'POST') {
      const body = JSON.parse(String(init.body)) as Record<string, unknown>;
      posts.push({ url, body });
      return Response.json({ routine: { id: 'studio-routine-1', ...body, enabled: true, nextRunAt: null, lastRun: null, createdAt: 1, updatedAt: 1,
        skillId: null, agentId: 'codex' } }, { status: 201 });
    }
    if (url === '/api/routines') return Response.json({ routines: [] });
    if (url === '/api/projects') return Response.json({ projects: [] });
    return Response.json({ error: { code: 'NOT_FOUND', message: 'missing' } }, { status: 404 });
  }));
  const session = new CookieSession();
  await session.verify();
  activateStudioTransport(session, session.snapshot().generation, { usable: (lane) => lane === 'automations' });
  render(<TasksView />);

  const connectorCard = await screen.findByTestId('automation-template-connector-digest-design-context');
  expect((connectorCard as HTMLButtonElement).disabled).toBe(true);
  expect(connectorCard.textContent).toContain('Needs connectors');
  // Orbit digests and live-artifact refreshers need connectors too.
  expect((screen.getByTestId('automation-template-orbit-daily') as HTMLButtonElement).disabled).toBe(true);
  expect((screen.getByTestId('automation-template-live-status-board') as HTMLButtonElement).disabled).toBe(true);

  fireEvent.click(screen.getByTestId('automation-template-ingest-source-memory-tree'));
  await waitFor(() => expect((screen.getByTestId('automation-modal-title') as HTMLInputElement).value).toBe('Ingest source into memory tree'));
  expect((screen.getByTestId('automation-modal-prompt') as HTMLTextAreaElement).value).toContain('Use Automation template "ingest-source-memory-tree".');
  fireEvent.click(screen.getByTestId('automation-modal').querySelector('button[type="submit"]')!);
  await waitFor(() => expect(posts).toHaveLength(1));
  expect(posts[0]!.body).toMatchObject({ templateId: 'ingest-source-memory-tree', name: 'Ingest source into memory tree' });
  session.dispose();
});

it('shows the typed refusal message when crystallize or review is refused', async () => {
  const proposal = { id: 'p1', title: 'Skill: brief', summary: 'Draft skill', targetKind: 'skill', action: 'create', status: 'pending-review',
    reviewPolicy: 'always', createdAt: '2026-10-08T00:00:00.000Z', updatedAt: '2026-10-08T00:00:00.000Z', sourcePacketIds: [], patch: { format: 'markdown', after: '# x' } };
  vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    if (url === '/api/auth/me') return Response.json({ account, studio: capabilities, studioRevision: 1 });
    if (url === '/api/automation-proposals/p1/apply' && init?.method === 'POST') {
      return Response.json({ error: { code: 'CONFLICT', message: 'a skill with this name already exists' } }, { status: 409 });
    }
    if (url.startsWith('/api/automation-proposals')) return Response.json({ proposals: [proposal] });
    if (url === '/api/automation-templates') return Response.json({ templates: [] });
    if (url === '/api/routines') return Response.json({ routines: [] });
    if (url === '/api/projects') return Response.json({ projects: [] });
    return Response.json({}, { status: 404 });
  }));
  const session = new CookieSession();
  await session.verify();
  activateStudioTransport(session, session.snapshot().generation, { usable: (lane) => lane === 'automations' });
  render(<TasksView />);
  fireEvent.click(await screen.findByRole('button', { name: /Apply/i }));
  expect((await screen.findByRole('alert')).textContent).toBe('a skill with this name already exists');
  session.dispose();
});
