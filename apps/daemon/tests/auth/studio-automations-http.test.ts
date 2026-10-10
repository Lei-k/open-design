// #64: account-owned automation self-evolution. Bundled templates are the same
// read for every account; packets, ingestions and proposals are private to the
// account; applying writes only into that account's memory, private skill
// packages and design documents; crystallize turns the owner's own succeeded
// routine run into reviewable proposals. Connector context stays refused.
import { mkdirSync, readdirSync, writeFileSync, existsSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import path from 'node:path';
import { afterAll, beforeAll, expect, it } from 'vitest';
import { cleanupIsolatedDataRoot, loadIsolatedServerModule, multiUserOptions, provisionAccounts,
  startMultiUserDaemon, type Principal, type StartedMultiUserDaemon } from './multiuser-harness.js';
import { PERSONAL_CODEX_MOCK, linkCodex, until } from './personal-codex-helpers.js';

let daemon: StartedMultiUserDaemon; let root: string; let a: Principal; let b: Principal; let admin: Principal;
beforeAll(async () => {
  ({ dataRoot: root } = await loadIsolatedServerModule());
  // Host-global stores that must never reach a Web account.
  mkdirSync(path.join(root, 'automation-templates'), { recursive: true });
  writeFileSync(path.join(root, 'automation-templates/templates.json'), JSON.stringify({ templates: [{ id: 'host-private-template', title: 'HOST_TEMPLATE',
    description: 'host', purpose: 'host', stages: [{ id: 'ingest', kind: 'ingest', title: 'x' }] }] }));
  mkdirSync(path.join(root, 'automation-proposals'), { recursive: true });
  writeFileSync(path.join(root, 'automation-proposals/proposals.json'), JSON.stringify({ proposals: [{ id: 'host-proposal', title: 'HOST_PROPOSAL',
    summary: 'host', targetKind: 'memory-node', action: 'create', status: 'pending-review', reviewPolicy: 'always', createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-01T00:00:00.000Z', sourcePacketIds: [], patch: { format: 'json', after: '{}' } }] }));
  daemon = await startMultiUserDaemon(multiUserOptions({ testPersonalCodexAppServer: PERSONAL_CODEX_MOCK }));
  const accounts = await provisionAccounts(daemon, ['evolve-a', 'evolve-b']);
  [a, b] = accounts.users as [Principal, Principal]; admin = accounts.admin;
  await linkCodex(daemon, root, a, 'evolve-a@example.test');
  for (const user of [a, b]) {
    expect((await daemon.request({ method: 'PUT', path: `/api/admin/users/${user.id}/studio-pilot`, cookie: admin.cookie,
      body: { studioPilot: true, revision: 0 } })).status).toBe(200);
  }
}, 120_000);
afterAll(async () => { await daemon?.close(); cleanupIsolatedDataRoot(); });

const get = (user: Principal, path: string) => daemon.request({ path, cookie: user.cookie });
const post = (user: Principal, path: string, body: unknown = {}) => daemon.request({ method: 'POST', path, cookie: user.cookie, body });
const ingest = (user: Principal, extra: Record<string, unknown> = {}) => post(user, '/api/automation-ingestions', {
  sourceKind: 'upload', title: 'Brand voice notes', bodyMarkdown: 'EVOLVE_MARKER keep headlines short and warm.', candidateSinks: ['memory', 'skill', 'design-system'], ...extra });

it('lists only bundled templates, opens connector templates with owner-granted context and creates routines from them on the account', async () => {
  for (const user of [a, admin]) {
    const listed = await get(user, '/api/automation-templates');
    expect(listed.status, listed.text).toBe(200);
    expect(listed.text).not.toContain('HOST_TEMPLATE');
    const ids = listed.json.templates.map((template: { id: string }) => template.id);
    expect(ids).toContain('crystallize-run-into-skill');
    expect(listed.json.templates.find((template: { id: string }) => template.id === 'connector-digest-design-context').unavailable)
      .toBeUndefined();
    expect(listed.json.templates.find((template: { id: string }) => template.id === 'ingest-source-memory-tree').unavailable).toBeUndefined();
  }
  expect((await get(a, '/api/automation-templates/host-private-template')).status).toBe(404);
  expect((await get(a, '/api/automation-templates/ingest-source-memory-tree')).json.template.id).toBe('ingest-source-memory-tree');

  const schedule = { kind: 'daily', time: '08:00', timezone: 'UTC' };
  const made = await post(a, '/api/routines', { templateId: 'ingest-source-memory-tree', schedule, target: { mode: 'create_each_run' } });
  expect(made.status, made.text).toBe(201);
  expect(made.json.routine).toMatchObject({ templateId: 'ingest-source-memory-tree', name: 'Ingest source into memory tree', agentId: 'codex' });
  expect(made.json.routine.prompt).toContain('Use Automation template "ingest-source-memory-tree".');
  expect((await get(b, '/api/routines')).json.routines).toEqual([]);
  const connector = await post(a, '/api/routines', { templateId: 'connector-digest-design-context', name: 'Digest', prompt: 'x', schedule, target: { mode: 'create_each_run' } });
  expect(connector.status).toBe(403);
  expect(connector.json.error.code).toBe('CONNECTOR_NOT_GRANTED');
  expect((await post(a, '/api/routines', { templateId: 'host-private-template', schedule, target: { mode: 'create_each_run' } })).status).toBe(404);
  expect((await daemon.request({ method: 'PATCH', path: `/api/routines/${encodeURIComponent(made.json.routine.id)}`, cookie: a.cookie,
    body: { templateId: 'compress-project-context' } })).status).toBe(400);
});

it('keeps packets and proposals private and applies them only into the account stores', async () => {
  const ingested = await ingest(a);
  expect(ingested.status, ingested.text).toBe(200);
  const { packet, proposals } = ingested.json as { packet: { id: string }; proposals: Array<{ id: string; targetKind: string; targetRef?: string }> };
  expect(proposals.map((proposal) => proposal.targetKind).sort()).toEqual(['design-system', 'memory-node', 'skill']);
  expect(proposals.every((proposal) => proposal.targetRef === undefined)).toBe(true);
  expect((await get(a, '/api/automation-source-packets')).json.packets.map((item: { id: string }) => item.id)).toEqual([packet.id]);
  const pending = await get(a, '/api/automation-proposals?status=pending-review');
  expect(pending.text).not.toContain('HOST_PROPOSAL');
  expect(pending.json.proposals).toHaveLength(3);

  // B and the admin see nothing and cannot read, apply or reject A's rows; foreign ≡ missing.
  for (const other of [b, admin]) {
    expect((await get(other, '/api/automation-source-packets')).json.packets).toEqual([]);
    expect((await get(other, '/api/automation-proposals')).json.proposals).toEqual([]);
    const missing = await get(other, `/api/automation-source-packets/${randomUUID()}`);
    const foreign = await get(other, `/api/automation-source-packets/${packet.id}`);
    expect([foreign.status, foreign.json]).toEqual([missing.status, missing.json]);
    for (const proposal of proposals) {
      expect((await get(other, `/api/automation-proposals/${proposal.id}`)).status).toBe(404);
      expect((await post(other, `/api/automation-proposals/${proposal.id}/apply`)).status).toBe(404);
      expect((await post(other, `/api/automation-proposals/${proposal.id}/reject`, { reason: 'no' })).status).toBe(404);
    }
    // A proposal cannot cite another account's packet.
    expect((await post(other, '/api/automation-proposals', { title: 'x', summary: 'y', targetKind: 'memory-node', action: 'create',
      sourcePacketIds: [packet.id], patch: { format: 'json', after: '{"name":"x","type":"user","body":"y"}' } })).status).toBe(404);
  }

  const byKind = (kind: string) => proposals.find((proposal) => proposal.targetKind === kind)!;
  const memory = await post(a, `/api/automation-proposals/${byKind('memory-node').id}/apply`);
  expect(memory.status, memory.text).toBe(200);
  expect(memory.json.proposal.status).toBe('applied');
  const memoryId = memory.json.result.memoryId as string;
  const entry = await get(a, `/api/memory/${memoryId}`);
  expect(entry.json.entry.body).toContain('EVOLVE_MARKER');
  expect(entry.json.entry.body).toContain(`Source packet: ${packet.id}`);
  expect((await get(b, `/api/memory/${memoryId}`)).status).toBe(404);
  // The host memory store is never written.
  expect(existsSync(path.join(root, 'memory')) ? readdirSync(path.join(root, 'memory')).filter((file) => file.includes(memoryId)) : []).toEqual([]);
  // Applying twice is a conflict, not a second write.
  expect((await post(a, `/api/automation-proposals/${byKind('memory-node').id}/apply`)).status).toBe(409);

  const skill = await post(a, `/api/automation-proposals/${byKind('skill').id}/apply`);
  expect(skill.status, skill.text).toBe(200);
  const skillId = skill.json.result.skillId as string;
  expect(skillId).toMatch(/^studio-skill:/);
  const files = await get(a, `/api/skills/${encodeURIComponent(skillId)}/files`);
  expect(files.json.files.map((file: { path: string }) => file.path).sort()).toEqual(['SKILL.md', 'references/source.md']);
  expect((await get(a, `/api/skills/${encodeURIComponent(skillId)}`)).json.body).toContain('EVOLVE_MARKER');
  expect((await get(b, `/api/skills/${encodeURIComponent(skillId)}`)).status).toBe(404);
  const hostEntries = (dir: string) => existsSync(path.join(root, dir)) ? readdirSync(path.join(root, dir)) : [];
  expect(hostEntries('skills').filter((name) => name.includes('brand-voice'))).toEqual([]);

  const rejected = await post(a, `/api/automation-proposals/${byKind('design-system').id}/reject`, { reason: 'not now' });
  expect(rejected.json.proposal).toMatchObject({ status: 'rejected', metadata: expect.objectContaining({ rejectedReason: 'not now' }) });
  expect((await post(a, `/api/automation-proposals/${byKind('design-system').id}/apply`)).status).toBe(409);
  expect(hostEntries('design-systems').filter((name) => name.includes('brand-voice'))).toEqual([]);

  // A manual update proposal for the account's own memory entry applies in place.
  const update = await post(a, '/api/automation-proposals', { title: 'Tighten', summary: 'Shorter memory', targetKind: 'memory-node', action: 'update',
    targetRef: memoryId, patch: { format: 'json', after: JSON.stringify({ body: 'UPDATED_MARKER' }) } });
  expect(update.status, update.text).toBe(200);
  expect((await post(a, `/api/automation-proposals/${update.json.proposal.id}/apply`)).status).toBe(200);
  expect((await get(a, `/api/memory/${memoryId}`)).json.entry.body).toContain('UPDATED_MARKER');
  // B cannot target A's entry by id; a missing entry and a foreign one look the same.
  const foreignTarget = await post(b, '/api/automation-proposals', { title: 'x', summary: 'y', targetKind: 'memory-node', action: 'update',
    targetRef: memoryId, patch: { format: 'json', after: '{"body":"stolen"}' } });
  expect(foreignTarget.status).toBe(200);
  expect((await post(b, `/api/automation-proposals/${foreignTarget.json.proposal.id}/apply`)).status).toBe(404);
  expect((await get(a, `/api/memory/${memoryId}`)).json.entry.body).not.toContain('stolen');
});

it('keeps a memory update bound to its targetRef and refuses a different embedded id before writing', async () => {
  for (const id of ['entry_a', 'entry_b']) {
    const made = await post(a, '/api/memory', { id, type: 'project', name: id, description: id, body: `${id} original body` });
    expect(made.status, made.text).toBe(200);
  }
  const body = async (id: string) => (await get(a, `/api/memory/${id}`)).json.entry.body as string;
  const original = { a: await body('entry_a'), b: await body('entry_b') };
  expect(original.a).toContain('entry_a original body');
  // A conflicting embedded id is refused when the proposal is created.
  const mismatched = await post(a, '/api/automation-proposals', { title: 'Update A', summary: 'Targets A', targetKind: 'memory-node', action: 'update',
    targetRef: 'entry_a', patch: { format: 'json', after: JSON.stringify({ id: 'entry_b', body: 'replacement' }) } });
  expect([mismatched.status, mismatched.json.error?.code]).toEqual([400, 'BAD_REQUEST']);
  expect(await body('entry_a')).toBe(original.a);
  expect(await body('entry_b')).toBe(original.b);

  // targetRef stays optional (contract): an update naming its entry only by the
  // embedded id is bound to that entry.
  const legacy = await post(a, '/api/automation-proposals', { title: 'Update B', summary: 'Embedded id only', targetKind: 'memory-node', action: 'update',
    patch: { format: 'json', after: JSON.stringify({ id: 'entry_b', body: 'LEGACY_MARKER' }) } });
  expect(legacy.status, legacy.text).toBe(200);
  expect(legacy.json.proposal.targetRef).toBe('entry_b');
  expect((await post(a, `/api/automation-proposals/${legacy.json.proposal.id}/apply`)).json.result).toMatchObject({ memoryId: 'entry_b', action: 'update' });
  expect(await body('entry_b')).toContain('LEGACY_MARKER');
  expect(await body('entry_a')).toBe(original.a);

  // Repeating the target's own id is fine: the write lands on targetRef only.
  const bound = await post(a, '/api/automation-proposals', { title: 'Update A', summary: 'Targets A', targetKind: 'memory-node', action: 'update',
    targetRef: 'entry_a', patch: { format: 'json', after: JSON.stringify({ id: 'entry_a', body: 'BOUND_MARKER' }) } });
  const applied = await post(a, `/api/automation-proposals/${bound.json.proposal.id}/apply`);
  expect(applied.status, applied.text).toBe(200);
  expect(applied.json.result).toMatchObject({ memoryId: 'entry_a', action: 'update' });
  expect(await body('entry_a')).toContain('BOUND_MARKER');
  expect(await body('entry_b')).toContain('LEGACY_MARKER');
  expect(await body('entry_b')).not.toContain('BOUND_MARKER');
});

it('refuses connector context, foreign projects, host-shaped fields and malformed account templates', async () => {
  const connector = await ingest(a, { sourceKind: 'connector' });
  expect([connector.status, connector.json.error.code]).toEqual([403, 'MULTIUSER_CAPABILITY_UNAVAILABLE']);
  expect((await ingest(a, { connectorId: 'slack' })).status).toBe(403);
  expect((await ingest(a, { templateId: 'connector-digest-design-context' })).status).toBe(403);
  expect((await ingest(a, { ownerAccountId: b.id })).status).toBe(400);
  const foreignProject = randomUUID();
  expect((await post(b, '/api/projects', { id: foreignProject, name: 'B private' })).status).toBe(200);
  expect((await ingest(a, { projectId: foreignProject })).status).toBe(404);
  expect((await ingest(a, { projectId: randomUUID() })).status).toBe(404);
  const template = await post(a, '/api/automation-proposals', { title: 'x', summary: 'y', targetKind: 'automation-template', action: 'create',
    patch: { format: 'json', after: '{}' } });
  expect([template.status, template.json.error.code]).toEqual([400, 'BAD_REQUEST']);
  expect((await post(a, '/api/automation-proposals', { id: 'chosen', title: 'x', summary: 'y', targetKind: 'skill', action: 'create',
    patch: { format: 'markdown', after: '# x' } })).status).toBe(400);
  expect((await post(a, '/api/automation-proposals', { title: 'x', summary: 'y', targetKind: 'skill', action: 'create', status: 'applied',
    patch: { format: 'markdown', after: '# x' } })).status).toBe(400);
});

it('crystallizes only the owner\'s succeeded run into a private skill package', async () => {
  const made = await post(a, '/api/routines', { name: 'Brief writer', prompt: 'CRYSTAL_PROMPT write the weekly brief',
    schedule: { kind: 'daily', time: '09:00', timezone: 'UTC' }, target: { mode: 'create_each_run' } });
  const routineId = made.json.routine.id as string;
  expect((await post(a, `/api/routines/${encodeURIComponent(routineId)}/run`)).status).toBe(202);
  const finished = await until(() => get(a, `/api/routines/${encodeURIComponent(routineId)}/runs`),
    (result) => ['succeeded', 'failed', 'canceled'].includes(result.json.runs[0]?.status), 'routine run');
  const run = finished.json.runs[0] as { id: string; status: string };
  expect(run.status).toBe('succeeded');
  const crystallizePath = `/api/routines/${encodeURIComponent(routineId)}/runs/${encodeURIComponent(run.id)}/crystallize`;
  for (const other of [b, admin]) expect((await post(other, crystallizePath)).status).toBe(404);
  expect((await post(a, `/api/routines/${encodeURIComponent(routineId)}/runs/${randomUUID()}/crystallize`)).status).toBe(404);
  const crystal = await post(a, crystallizePath);
  expect(crystal.status, crystal.text).toBe(200);
  expect(crystal.json).toMatchObject({ routineId, runId: run.id });
  expect(crystal.json.packet.bodyMarkdown).toContain('CRYSTAL_PROMPT');
  const skillProposal = crystal.json.proposals.find((proposal: { targetKind: string }) => proposal.targetKind === 'skill');
  expect(skillProposal).toBeTruthy();
  expect((await get(b, `/api/automation-proposals/${skillProposal.id}`)).status).toBe(404);
  const applied = await post(a, `/api/automation-proposals/${skillProposal.id}/apply`);
  expect(applied.status, applied.text).toBe(200);
  const skill = await get(a, `/api/skills/${encodeURIComponent(applied.json.result.skillId)}`);
  expect(skill.json).toMatchObject({ name: 'Brief writer run skill', source: 'user' });
  expect((await get(a, `/api/skills/${encodeURIComponent(applied.json.result.skillId)}/files`)).text).toContain('references/source.md');
  // The crystallized package is selectable like any other private skill.
  expect((await get(a, '/api/skills')).json.skills.some((item: { id: string }) => item.id === applied.json.result.skillId)).toBe(true);
  expect((await get(b, '/api/skills')).json.skills.some((item: { id: string }) => item.id === applied.json.result.skillId)).toBe(false);
}, 30_000);
