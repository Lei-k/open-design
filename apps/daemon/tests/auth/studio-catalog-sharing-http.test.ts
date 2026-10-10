// S40 (#61/#65): team catalogs. An account shares a private skill or design
// document with another account of the same deployment for `use`; the
// grantee lists, inspects, previews and selects it in its own turns, which
// capture the owner's version at admission. Revocation and owner deletion
// stop new use immediately and leave admitted runs and conversation pins
// alone. Strangers and the admin see nothing; names never shadow each other.
import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import Database from 'better-sqlite3';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { cleanupIsolatedDataRoot, loadIsolatedServerModule, login, multiUserOptions, provisionAccounts,
  startMultiUserDaemon, type Principal, type StartedMultiUserDaemon } from './multiuser-harness.js';
import { PERSONAL_CODEX_MOCK, codexHome, linkCodex, until } from './personal-codex-helpers.js';

/**
 * Research fixture: the turn's paid search runs after the catalog capture and
 * before the admission commit. While `researchHold` is set, every search waits
 * on it, so a test can change catalog authority inside that window.
 */
let researchHold: Promise<void> | null = null;
let researchCalls = 0;
const tavily: typeof fetch = async () => {
  researchCalls += 1;
  if (researchHold) await researchHold;
  return Response.json({ answer: 'CATALOG_RACE_FINDINGS', results: [{ title: 'Note', url: 'https://example.test/note', content: 'note' }] });
};
const companyOpenAI: typeof fetch = async () => new Response(`data: ${JSON.stringify({ type: 'response.completed', response: {
  output: [{ type: 'message', role: 'assistant', content: [{ type: 'output_text', text: 'Noted.' }] }] } })}\n\n`,
{ headers: { 'content-type': 'text/event-stream' } });

let daemon: StartedMultiUserDaemon; let root: string;
let a: Principal; let b: Principal; let c: Principal; let admin: Principal;
beforeAll(async () => {
  ({ dataRoot: root } = await loadIsolatedServerModule());
  daemon = await startMultiUserDaemon(multiUserOptions({ testPersonalCodexAppServer: PERSONAL_CODEX_MOCK,
    testTavilyFetch: tavily, testCompanyOpenAIFetch: companyOpenAI }));
  const accounts = await provisionAccounts(daemon, ['catalog-a', 'catalog-b', 'catalog-c']);
  [a, b, c] = accounts.users as [Principal, Principal, Principal]; admin = accounts.admin;
  await linkCodex(daemon, root, a, 'catalog-a@example.test');
  await linkCodex(daemon, root, b, 'catalog-b@example.test');
  const pool = await daemon.request({ path: '/api/admin/pool/openai', cookie: admin.cookie });
  expect((await daemon.request({ method: 'PUT', path: '/api/admin/pool/openai', cookie: admin.cookie, body: {
    revision: pool.json.provider.revision, model: 'company-model', enabled: true, capacity: 2, apiKey: 'sk-catalog-race-fixture-0123456789' } })).status).toBe(200);
  expect((await daemon.request({ method: 'PUT', path: '/api/multiuser/settings/provider-keys/tavily', cookie: b.cookie,
    body: { revision: 0, apiKey: 'tvly-catalog-b-fixture-0123456789' } })).status).toBe(200);
}, 120_000);
afterAll(async () => { await daemon?.close(); cleanupIsolatedDataRoot(); });

type Kind = 'skills' | 'design-systems';
const request = (user: Principal | null, method: string, route: string, body?: unknown) =>
  daemon.request({ method, path: route, ...(user ? { cookie: user.cookie } : {}), ...(body === undefined ? {} : { body }) });
async function skill(user: Principal, body: string, name = `shared-${randomUUID().slice(0, 8)}`) {
  const made = await request(user, 'POST', '/api/skills/import', { name, body });
  expect(made.status, made.text).toBe(201); return made.json.skill.id as string;
}
async function design(user: Principal, body: string, title = 'Shared design') {
  const made = await request(user, 'POST', '/api/design-systems', { title, body });
  expect(made.status, made.text).toBe(201); return made.json.designSystem.id as string;
}
const enc = encodeURIComponent;
const share = (kind: Kind, id: string, username: string, by = a, role = 'use') =>
  request(by, 'PUT', `/api/multiuser/catalog/${kind}/${enc(id)}/shares`, { username, role });
const revoke = (kind: Kind, id: string, accountId: string, by = a) => request(by, 'DELETE', `/api/multiuser/catalog/${kind}/${enc(id)}/shares/${enc(accountId)}`, {});
const listed = async (user: Principal, kind: Kind) => {
  const res = await request(user, 'GET', `/api/${kind}`);
  expect(res.status, res.text).toBe(200);
  return (kind === 'skills' ? res.json.skills : res.json.designSystems) as Array<Record<string, any>>;
};
async function project(user: Principal, extra: Record<string, unknown> = {}) {
  const id = randomUUID();
  const made = await request(user, 'POST', '/api/projects', { id, name: `catalog ${id.slice(0, 6)}`, ...extra });
  expect(made.status, made.text).toBe(200);
  return { projectId: id, conversationId: made.json.conversationId as string };
}
const run = (user: Principal, context: { projectId: string; conversationId: string }, extra: Record<string, unknown> = {}) =>
  request(user, 'POST', '/api/runs', { ...context, message: 'Use the shared catalog', agentId: 'codex', executionSource: 'personal_subscription', ...extra });
async function finish(user: Principal, started: { status: number; text: string; json: any }): Promise<string> {
  expect(started.status, started.text).toBe(202);
  expect((await request(user, 'GET', `/api/runs/${started.json.runId}/events`)).text).toContain('"status":"succeeded"');
  return JSON.parse(readFileSync(path.join(codexHome(root, user.id), 'mock-turn-evidence.json'), 'utf8')).message as string;
}

/** The captured skill/design text of a conversation's newest admitted run. */
function latestCapture(conversationId: string): string {
  const db = new Database(path.join(root, 'app.sqlite'), { readonly: true });
  try {
    const row = db.prepare('SELECT request_json FROM multiuser_runs WHERE conversation_id = ? ORDER BY queue_seq DESC LIMIT 1').get(conversationId) as { request_json: string };
    const request = JSON.parse(row.request_json) as { skillSnapshots?: Array<{ body: string }>; designSnapshot?: { prompt: { designSystemBody: string } } };
    return [...(request.skillSnapshots ?? []).map((item) => item.body), request.designSnapshot?.prompt.designSystemBody ?? ''].join('\n');
  } finally { db.close(); }
}

describe('team catalogs between accounts', () => {
  it('lets the owner grant use to an active account; strangers and the admin see nothing and cannot manage grants', async () => {
    const skillId = await skill(a, 'SHARED_SKILL_LIST_MARKER body');
    const designId = await design(a, '# Shared\nSHARED_DESIGN_LIST_MARKER #1A74FF');
    const missingSkill = `studio-skill:${randomUUID()}`;
    const missingDesign = `user:studio_${randomUUID()}`;
    // Before any grant, B is refused exactly like a missing id.
    expect((await request(b, 'GET', `/api/skills/${enc(skillId)}`)).text).toBe((await request(b, 'GET', `/api/skills/${enc(missingSkill)}`)).text);
    // Unknown, own and inactive usernames are one refusal; only `use` passes the gate.
    const unknown = await share('skills', skillId, 'nobody-catalog');
    expect(unknown.status).toBe(404);
    expect((await share('skills', skillId, a.username)).text).toBe(unknown.text);
    const gone = await request(admin, 'POST', '/api/auth/users', { username: 'catalog-gone', password: 'catalog-gone-password-battery', role: 'user' });
    expect(gone.status, gone.text).toBe(201);
    expect((await request(admin, 'PATCH', `/api/auth/users/${gone.json.account.id}`, { active: false })).status).toBe(200);
    expect((await share('skills', skillId, 'catalog-gone')).text).toBe(unknown.text);
    for (const body of [{ username: b.username, role: 'edit' }, { username: b.username }, { username: b.username, role: 'use', accountId: b.id }]) {
      expect((await request(a, 'PUT', `/api/multiuser/catalog/skills/${enc(skillId)}/shares`, body)).status).toBe(400);
    }
    // Only the owner manages grants: a stranger, the admin and (later) the grantee get the missing-item 404.
    for (const user of [c, admin]) {
      for (const [kind, id, missing] of [['skills', skillId, missingSkill], ['design-systems', designId, missingDesign]] as const) {
        const refused = await share(kind, id, b.username, user);
        expect(refused.status).toBe(404);
        expect(refused.text).toBe((await share(kind, missing, b.username, user)).text);
        expect((await request(user, 'GET', `/api/multiuser/catalog/${kind}/${enc(id)}/access`)).text)
          .toBe((await request(user, 'GET', `/api/multiuser/catalog/${kind}/${enc(missing)}/access`)).text);
      }
    }
    const granted = await share('skills', skillId, b.username);
    expect(granted.status, granted.text).toBe(200);
    expect(granted.json.member).toMatchObject({ accountId: b.id, username: b.username, role: 'use' });
    expect((await share('design-systems', designId, b.username)).status).toBe(200);
    expect((await share('skills', skillId, c.username, b)).status).toBe(404);
    // Lists: the grantee sees the owner's username; the owner sees its member count; nobody else sees it.
    expect((await listed(b, 'skills')).find((item) => item.id === skillId)?.studioShare).toEqual({ role: 'use', ownerUsername: a.username, memberCount: 2 });
    expect((await listed(a, 'skills')).find((item) => item.id === skillId)?.studioShare).toEqual({ role: 'owner', ownerUsername: a.username, memberCount: 2 });
    expect((await listed(b, 'design-systems')).find((item) => item.id === designId)).toMatchObject({ canMutate: false, isEditable: false,
      studioShare: { role: 'use', ownerUsername: a.username, memberCount: 2 } });
    for (const user of [c, admin]) {
      for (const kind of ['skills', 'design-systems'] as const) expect(JSON.stringify(await listed(user, kind))).not.toContain(kind === 'skills' ? skillId : designId);
    }
    // The grantee inspects and previews; it never edits, revises, deletes or reads history.
    const detail = await request(b, 'GET', `/api/skills/${enc(skillId)}`);
    expect(detail.status, detail.text).toBe(200);
    expect(detail.json).toMatchObject({ body: 'SHARED_SKILL_LIST_MARKER body', studioShare: { role: 'use' } });
    expect(detail.json.package).toBeUndefined();
    expect((await request(b, 'GET', `/api/skills/${enc(skillId)}/files`)).status).toBe(200);
    for (const suffix of ['', '/files', '/file?path=DESIGN.md', '/preview', '/showcase']) {
      const res = await request(b, 'GET', `/api/design-systems/${enc(designId)}${suffix}`);
      expect(res.status, `${suffix} ${res.text}`).toBe(200);
      expect(res.text).toContain(suffix === '/files' ? 'DESIGN.md' : 'SHARED_DESIGN_LIST_MARKER');
    }
    for (const [method, route, body, missing] of [
      ['PUT', `/api/skills/${enc(skillId)}`, { body: 'grantee edit' }, `/api/skills/${enc(missingSkill)}`],
      ['DELETE', `/api/skills/${enc(skillId)}`, {}, `/api/skills/${enc(missingSkill)}`],
      ['PATCH', `/api/design-systems/${enc(designId)}`, { body: 'grantee edit' }, `/api/design-systems/${enc(missingDesign)}`],
      ['DELETE', `/api/design-systems/${enc(designId)}`, {}, `/api/design-systems/${enc(missingDesign)}`],
      ['GET', `/api/design-systems/${enc(designId)}/revisions`, undefined, `/api/design-systems/${enc(missingDesign)}/revisions`],
    ] as const) {
      const refused = await request(b, method, route, body);
      expect(refused.status, `${method} ${route}`).toBe(404);
      expect(refused.text).toBe((await request(b, method, missing, body)).text);
    }
    expect((await request(a, 'GET', `/api/skills/${enc(skillId)}`)).json.body).toBe('SHARED_SKILL_LIST_MARKER body');
    // Strangers and the admin: detail, files and previews are the missing-item 404.
    for (const user of [c, admin]) {
      for (const [route, missing] of [[`/api/skills/${enc(skillId)}`, `/api/skills/${enc(missingSkill)}`],
        [`/api/design-systems/${enc(designId)}/preview`, `/api/design-systems/${enc(missingDesign)}/preview`]]) {
        const refused = await request(user, 'GET', route!);
        expect(refused.status).toBe(404);
        expect(refused.text).toBe((await request(user, 'GET', missing!)).text);
      }
    }
    const access = await request(b, 'GET', `/api/multiuser/catalog/skills/${enc(skillId)}/access`);
    expect(access.json).toMatchObject({ kind: 'skill', resourceId: skillId, role: 'use', shared: true,
      self: { accountId: b.id, role: 'use' }, owner: { accountId: a.id, username: a.username, role: 'owner' } });
    expect(access.json.members.map((member: { username: string; role: string }) => `${member.username}:${member.role}`)).toEqual([`${a.username}:owner`, `${b.username}:use`]);
    // The owner cannot leave; a grantee leaves its own grant only.
    expect((await request(a, 'DELETE', `/api/multiuser/catalog/skills/${enc(skillId)}/access`, {})).status).toBe(409);
    expect((await request(b, 'DELETE', `/api/multiuser/catalog/skills/${enc(skillId)}/access`, {})).status).toBe(200);
    expect((await listed(b, 'skills')).some((item) => item.id === skillId)).toBe(false);
    expect((await listed(a, 'skills')).find((item) => item.id === skillId)?.studioShare).toBeUndefined();
    expect((await request(c, 'DELETE', `/api/multiuser/catalog/design-systems/${enc(designId)}/access`, {})).status).toBe(404);
  });

  it('captures the owner\'s version at admission; revoke and owner delete stop new use and keep admitted pins', async () => {
    const skillId = await skill(a, 'SHARED_SKILL_ORIGINAL guidance');
    const designId = await design(a, '# Team\nSHARED_DESIGN_ORIGINAL tokens');
    expect((await share('skills', skillId, b.username)).status).toBe(200);
    expect((await share('design-systems', designId, b.username)).status).toBe(200);
    const pinned = await project(b);
    const first = await finish(b, await run(b, pinned, { skillIds: [skillId], designSystemId: designId }));
    expect(first).toContain('SHARED_SKILL_ORIGINAL'); expect(first).toContain('SHARED_DESIGN_ORIGINAL');
    // The owner revises: B's conversation keeps its captured version; a new conversation captures the new one.
    expect((await request(a, 'PUT', `/api/skills/${enc(skillId)}`, { body: 'SHARED_SKILL_REVISED guidance' })).status).toBe(200);
    expect((await request(a, 'PATCH', `/api/design-systems/${enc(designId)}`, { body: '# Team\nSHARED_DESIGN_REVISED tokens' })).status).toBe(200);
    await finish(b, await run(b, pinned, { skillIds: [skillId], designSystemId: designId }));
    const continued = latestCapture(pinned.conversationId);
    expect(continued).toContain('SHARED_SKILL_ORIGINAL'); expect(continued).toContain('SHARED_DESIGN_ORIGINAL');
    expect(continued).not.toContain('SHARED_SKILL_REVISED');
    const fresh = await finish(b, await run(b, await project(b), { skillIds: [skillId], designSystemId: designId }));
    expect(fresh).toContain('SHARED_SKILL_REVISED'); expect(fresh).toContain('SHARED_DESIGN_REVISED');
    // Revoke: catalog, preview and new admissions are refused at once; the admitted pin keeps working.
    expect((await revoke('skills', skillId, b.id)).status).toBe(200);
    expect((await revoke('design-systems', designId, b.id)).status).toBe(200);
    expect((await revoke('skills', skillId, b.id)).status).toBe(404);
    expect((await request(b, 'GET', `/api/skills/${enc(skillId)}`)).status).toBe(404);
    expect((await request(b, 'GET', `/api/design-systems/${enc(designId)}/preview`)).status).toBe(404);
    expect((await run(b, await project(b), { skillIds: [skillId] })).status).toBe(404);
    expect((await run(b, await project(b), { designSystemId: designId })).status).toBe(404);
    await finish(b, await run(b, pinned, { skillIds: [skillId], designSystemId: designId }));
    const afterRevoke = latestCapture(pinned.conversationId);
    expect(afterRevoke).toContain('SHARED_SKILL_ORIGINAL'); expect(afterRevoke).toContain('SHARED_DESIGN_ORIGINAL');
    // Owner deletion removes every grant; the grantee's pinned conversation still runs.
    const doomed = await skill(a, 'DOOMED_SKILL_ORIGINAL guidance');
    expect((await share('skills', doomed, b.username)).status).toBe(200);
    const doomedContext = await project(b);
    expect(await finish(b, await run(b, doomedContext, { skillIds: [doomed] }))).toContain('DOOMED_SKILL_ORIGINAL');
    expect((await request(a, 'DELETE', `/api/skills/${enc(doomed)}`, {})).status).toBe(200);
    const db = new Database(path.join(root, 'app.sqlite'), { readonly: true });
    try { expect(db.prepare('SELECT COUNT(*) AS n FROM studio_catalog_grants WHERE resource_id = ?').get(doomed)).toEqual({ n: 0 }); }
    finally { db.close(); }
    expect((await listed(b, 'skills')).some((item) => item.id === doomed)).toBe(false);
    expect((await run(b, await project(b), { skillIds: [doomed] })).status).toBe(404);
    await finish(b, await run(b, doomedContext, { skillIds: [doomed] }));
    expect(latestCapture(doomedContext.conversationId)).toContain('DOOMED_SKILL_ORIGINAL');
  }, 90_000);

  it('never lets the same name in different owner namespaces shadow another account\'s entry', async () => {
    const name = `brand-voice-${randomUUID().slice(0, 8)}`;
    const mine = await skill(b, 'B_OWN_BRAND_VOICE', name);
    const theirs = await skill(a, 'A_SHARED_BRAND_VOICE', name);
    expect((await share('skills', theirs, b.username)).status).toBe(200);
    const bList = (await listed(b, 'skills')).filter((item) => item.name === name);
    expect(bList.map((item) => item.id).sort()).toEqual([mine, theirs].sort());
    expect(bList.find((item) => item.id === mine)?.studioShare).toBeUndefined();
    expect(bList.find((item) => item.id === theirs)?.studioShare?.role).toBe('use');
    expect((await listed(a, 'skills')).filter((item) => item.name === name).map((item) => item.id)).toEqual([theirs]);
    expect(await finish(b, await run(b, await project(b), { skillIds: [mine] }))).toContain('B_OWN_BRAND_VOICE');
    const sharedTurn = await finish(b, await run(b, await project(b), { skillIds: [theirs] }));
    expect(sharedTurn).toContain('A_SHARED_BRAND_VOICE'); expect(sharedTurn).not.toContain('B_OWN_BRAND_VOICE');
    // B edits its own entry; A's is untouched, and B cannot reach A's by name.
    expect((await request(b, 'PUT', `/api/skills/${enc(mine)}`, { body: 'B_OWN_BRAND_VOICE_V2' })).status).toBe(200);
    expect((await request(a, 'GET', `/api/skills/${enc(theirs)}`)).json.body).toBe('A_SHARED_BRAND_VOICE');
    const designs = [await design(a, '# Same\nA_SAME_TITLE_DESIGN', 'Same title'), await design(b, '# Same\nB_SAME_TITLE_DESIGN', 'Same title')];
    expect((await share('design-systems', designs[0]!, b.username)).status).toBe(200);
    const titled = (await listed(b, 'design-systems')).filter((item) => item.title === 'Same title');
    expect(titled.map((item) => item.id).sort()).toEqual([...designs].sort());
    expect((await request(b, 'GET', `/api/design-systems/${enc(designs[0]!)}/file?path=DESIGN.md`)).json.file.content).toContain('A_SAME_TITLE_DESIGN');
  }, 60_000);

  it('lets a shared-project member use the pinned captured version without granting catalog access', async () => {
    const pinnedDesign = await design(a, '# Project\nPROJECT_PIN_DESIGN_ORIGINAL');
    const pinnedSkill = await skill(a, 'PROJECT_PIN_SKILL_ORIGINAL');
    const owned = await project(a, { designSystemId: pinnedDesign, skillId: pinnedSkill });
    const ownerTurn = await finish(a, await run(a, owned));
    expect(ownerTurn).toContain('PROJECT_PIN_DESIGN_ORIGINAL'); expect(ownerTurn).toContain('PROJECT_PIN_SKILL_ORIGINAL');
    expect((await request(a, 'PUT', `/api/multiuser/projects/${owned.projectId}/shares`, { username: b.username, role: 'edit' })).status).toBe(200);
    // No implicit catalog access through the project share.
    expect((await request(b, 'GET', `/api/design-systems/${enc(pinnedDesign)}`)).status).toBe(404);
    expect((await request(b, 'GET', `/api/skills/${enc(pinnedSkill)}`)).status).toBe(404);
    expect(JSON.stringify(await listed(b, 'design-systems'))).not.toContain(pinnedDesign);
    // The owner revises after admitting: the member inherits the admitted version, not the live catalog.
    expect((await request(a, 'PATCH', `/api/design-systems/${enc(pinnedDesign)}`, { body: '# Project\nPROJECT_PIN_DESIGN_REVISED' })).status).toBe(200);
    const thread = await request(b, 'POST', `/api/projects/${owned.projectId}/conversations`, { title: 'member thread' });
    expect(thread.status, thread.text).toBe(200);
    const memberContext = { projectId: owned.projectId, conversationId: thread.json.conversation.id as string };
    const memberTurn = await finish(b, await run(b, memberContext));
    expect(memberTurn).toContain('PROJECT_PIN_DESIGN_ORIGINAL'); expect(memberTurn).toContain('PROJECT_PIN_SKILL_ORIGINAL');
    expect(memberTurn).not.toContain('PROJECT_PIN_DESIGN_REVISED');
    // The pin never becomes an explicit selection elsewhere.
    expect((await run(b, await project(b), { designSystemId: pinnedDesign })).status).toBe(404);
    const second = await request(b, 'POST', `/api/projects/${owned.projectId}/conversations`, { title: 'explicit thread' });
    const explicit = { projectId: owned.projectId, conversationId: second.json.conversation.id as string };
    expect((await run(b, explicit, { skillId: pinnedSkill })).status).toBe(404);
    expect((await run(b, explicit, { designSystemId: pinnedDesign })).status).toBe(404);
    // A project whose owner never admitted the pin offers nothing to inherit.
    const unadmitted = await project(a, { designSystemId: pinnedDesign });
    expect((await request(a, 'PUT', `/api/multiuser/projects/${unadmitted.projectId}/shares`, { username: b.username, role: 'edit' })).status).toBe(200);
    const unadmittedThread = await request(b, 'POST', `/api/projects/${unadmitted.projectId}/conversations`, { title: 'member thread' });
    expect((await run(b, { projectId: unadmitted.projectId, conversationId: unadmittedThread.json.conversation.id })).status).toBe(404);
  }, 90_000);

  it('suspends every grant of a deactivated owner and restores them on reactivation; admitted pins keep running', async () => {
    const owner = await account('catalog-owner-off');
    const skillId = await skill(owner, 'OWNER_OFF_SKILL_ORIGINAL guidance');
    const designId = await design(owner, '# Owner off\nOWNER_OFF_DESIGN_ORIGINAL tokens');
    expect((await share('skills', skillId, b.username, owner)).status).toBe(200);
    expect((await share('design-systems', designId, b.username, owner)).status).toBe(200);
    const pinned = await project(b);
    const first = await finish(b, await run(b, pinned, { skillIds: [skillId], designSystemId: designId }));
    expect(first).toContain('OWNER_OFF_SKILL_ORIGINAL'); expect(first).toContain('OWNER_OFF_DESIGN_ORIGINAL');
    const missingSkill = `studio-skill:${randomUUID()}`;
    const missingDesign = `user:studio_${randomUUID()}`;

    expect((await request(admin, 'PATCH', `/api/auth/users/${owner.id}`, { active: false })).status).toBe(200);
    // Lists, detail, files, preview bytes and the member view: the same refusal as a missing id.
    expect(JSON.stringify(await listed(b, 'skills'))).not.toContain(skillId);
    expect(JSON.stringify(await listed(b, 'design-systems'))).not.toContain(designId);
    for (const [route, missing] of [
      [`/api/skills/${enc(skillId)}`, `/api/skills/${enc(missingSkill)}`],
      [`/api/skills/${enc(skillId)}/files`, `/api/skills/${enc(missingSkill)}/files`],
      ...['', '/files', '/file?path=DESIGN.md', '/preview', '/showcase'].map((suffix) =>
        [`/api/design-systems/${enc(designId)}${suffix}`, `/api/design-systems/${enc(missingDesign)}${suffix}`]),
      [`/api/multiuser/catalog/skills/${enc(skillId)}/access`, `/api/multiuser/catalog/skills/${enc(missingSkill)}/access`],
      [`/api/multiuser/catalog/design-systems/${enc(designId)}/access`, `/api/multiuser/catalog/design-systems/${enc(missingDesign)}/access`],
    ] as Array<[string, string]>) {
      const refused = await request(b, 'GET', route);
      expect(refused.status, route).toBe(404);
      expect(refused.text, route).toBe((await request(b, 'GET', missing)).text);
    }
    // New selections, new conversations and project setup are refused.
    expect((await run(b, await project(b), { skillIds: [skillId] })).status).toBe(404);
    expect((await run(b, await project(b), { designSystemId: designId })).status).toBe(404);
    const setup = await request(b, 'POST', '/api/projects', { id: randomUUID(), name: 'owner off setup', designSystemId: designId });
    expect(setup.status).toBe(404);
    // The admitted conversation keeps its captured version; nothing historical is rewritten.
    await finish(b, await run(b, pinned, { skillIds: [skillId], designSystemId: designId }));
    const kept = latestCapture(pinned.conversationId);
    expect(kept).toContain('OWNER_OFF_SKILL_ORIGINAL'); expect(kept).toContain('OWNER_OFF_DESIGN_ORIGINAL');

    // Reactivation lifts the suspension: grants were never revoked, so they apply again.
    expect((await request(admin, 'PATCH', `/api/auth/users/${owner.id}`, { active: true })).status).toBe(200);
    expect((await listed(b, 'skills')).find((item) => item.id === skillId)?.studioShare).toMatchObject({ role: 'use', ownerUsername: owner.username });
    expect((await request(b, 'GET', `/api/design-systems/${enc(designId)}/preview`)).text).toContain('OWNER_OFF_DESIGN_ORIGINAL');
  }, 90_000);

  it('refuses an admission whose shared capture loses authority before the commit, on personal and company paths', async () => {
    const conversationRows = (conversationId: string) => {
      const db = new Database(path.join(root, 'app.sqlite'), { readonly: true });
      try {
        return {
          runs: (db.prepare('SELECT COUNT(*) AS n FROM multiuser_runs WHERE conversation_id = ?').get(conversationId) as { n: number }).n,
          messages: (db.prepare('SELECT COUNT(*) AS n FROM messages WHERE conversation_id = ?').get(conversationId) as { n: number }).n,
        };
      } finally { db.close(); }
    };
    const sources = [{ agentId: 'codex', executionSource: 'personal_subscription' }, { agentId: 'openai', executionSource: 'company_pool' }];
    const losses: Array<{ label: string; lose: (owner: Principal, ids: { skillId: string; designId: string }) => Promise<void> }> = [
      { label: 'skill revoked', lose: async (owner, ids) => { expect((await revoke('skills', ids.skillId, b.id, owner)).status).toBe(200); } },
      { label: 'design revoked', lose: async (owner, ids) => { expect((await revoke('design-systems', ids.designId, b.id, owner)).status).toBe(200); } },
      { label: 'owner deactivated', lose: async (owner) => { expect((await request(admin, 'PATCH', `/api/auth/users/${owner.id}`, { active: false })).status).toBe(200); } },
      { label: 'control (no change)', lose: async () => {} },
    ];
    for (const source of sources) {
      for (const loss of losses) {
        const label = `${source.executionSource} / ${loss.label}`;
        const owner = await account(`race-${randomUUID().slice(0, 8)}`);
        const ids = { skillId: await skill(owner, 'RACE_SKILL guidance'), designId: await design(owner, '# Race\nRACE_DESIGN tokens') };
        expect((await share('skills', ids.skillId, b.username, owner)).status).toBe(200);
        expect((await share('design-systems', ids.designId, b.username, owner)).status).toBe(200);
        const context = await project(b);
        let release!: () => void;
        researchHold = new Promise<void>((resolve) => { release = resolve; });
        const callsBefore = researchCalls;
        try {
          const pending = run(b, context, { ...source, skillIds: [ids.skillId], designSystemId: ids.designId,
            clientRequestId: `race-${randomUUID()}`, research: { enabled: true, query: 'race' } });
          // The search is held: capture already happened and the commit has not.
          await until(() => researchCalls, (count) => count > callsBefore, `${label}: held search`);
          await loss.lose(owner, ids);
          release(); researchHold = null;
          const reply = await pending;
          if (loss.label.startsWith('control')) {
            expect(reply.status, `${label}: ${reply.text}`).toBe(202);
            await until(() => request(b, 'GET', `/api/runs/${reply.json.runId}`), (r) => ['succeeded', 'failed'].includes(r.json.status), `${label}: run`);
            continue;
          }
          expect(reply.status, `${label}: ${reply.text}`).toBe(404);
          expect(reply.json?.runId, label).toBeUndefined();
          expect(conversationRows(context.conversationId), label).toEqual({ runs: 0, messages: 0 });
        } finally { release(); researchHold = null; }
      }
    }
  }, 120_000);
});

/** A fresh signed-in account, so deactivating it leaves the shared principals alone. */
async function account(username: string): Promise<Principal> {
  const password = `${username}-password-battery-staple`;
  const created = await request(admin, 'POST', '/api/auth/users', { username, password, role: 'user' });
  expect(created.status, created.text).toBe(201);
  return { id: created.json.account.id as string, username, password, cookie: await login(daemon, username, password) };
}
