import { mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { clusterTest as base, expect } from '@/playwright/suite';
import { activeArtifactPreview, activeArtifactPreviewFrame } from '@/playwright/artifact-preview';
import { clickDeckNextSlide, clickPreviewToolbarAction } from '@/playwright/workspace';
import { createStudioRuntime, studioProjectId, type StudioRuntime } from '@/studio/runtime';
import { T } from '@/timeouts';

const test = base.extend<{ studio: StudioRuntime }>({
  studio: async ({}, use, info) => {
    const runtime = await createStudioRuntime();
    try { await use(runtime); }
    finally {
      const failed = info.status !== info.expectedStatus;
      if (failed) await info.attach('studio-runtime', { body: runtime.root, contentType: 'text/plain' });
      await runtime.close(failed);
    }
  },
});

test('[P1] Studio run renders its immutable image immediately and retains history after workspace edits', async ({ page, studio }, info) => {
  await studio.linkCodex(studio.a);
  await studio.configureTurn(studio.a, { reply: 'Created the owner image.', artifactBytes: {
    'hero.png': 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+a1foAAAAASUVORK5CYII=',
  } });
  const projectId = studioProjectId();
  const made = await studio.request('POST', '/api/projects', studio.a.cookie, { id: projectId, name: 'Studio image acceptance' });
  expect(made.status, made.text).toBe(200);
  await page.goto(`${studio.origin}/projects/${projectId}`);
  await page.locator('input[name="username"]').fill(studio.a.username);
  await page.locator('input[name="password"]').fill(studio.a.password);
  await page.getByRole('button', { name: 'Sign in', exact: true }).click();
  const composer = page.getByTestId('chat-composer-input');
  await expect(composer).toBeVisible({ timeout: T.long });
  // Personal Codex model/effort: an account preference sent with the standard request.
  const preferenceSaved = page.waitForResponse((response) => response.request().method() === 'PUT' && new URL(response.url()).pathname === '/api/app-config');
  await page.getByTestId('studio-codex-model').selectOption('gpt-5.4');
  expect((await preferenceSaved).status()).toBe(200);
  const effortSaved = page.waitForResponse((response) => response.request().method() === 'PUT' && new URL(response.url()).pathname === '/api/app-config');
  await page.getByTestId('studio-codex-reasoning').selectOption('high');
  expect((await effortSaved).status()).toBe(200);
  await page.screenshot({ path: info.outputPath('studio-codex-model-entry.png'), animations: 'disabled' });
  await composer.fill('[mock-write=hero.png]');
  const admitted = page.waitForResponse((response) => response.request().method() === 'POST' && new URL(response.url()).pathname === '/api/runs');
  await page.getByTestId('chat-send').click();
  const admission = await admitted;
  expect(admission.status()).toBe(202);
  expect(admission.request().postDataJSON()).toMatchObject({ model: 'gpt-5.4', reasoning: 'high' });
  const image = page.getByTestId('artifact-card-hero.png').locator('img');
  await expect(image).toBeVisible({ timeout: T.long });
  await expect(image).toHaveAttribute('src', /\/chat-artifact-snapshots\/[^/]+\/content$/);
  await expect.poll(() => image.evaluate((element: HTMLImageElement) => element.naturalWidth)).toBe(1);
  expect(await studio.turnEvidence(studio.a)).toMatchObject({ model: 'gpt-5.4', effort: 'high' });
  expect((await studio.request('GET', '/api/app-config', studio.a.cookie)).json.config.codexModel).toEqual({ model: 'gpt-5.4', reasoning: 'high' });
  expect((await studio.request('GET', '/api/app-config', studio.b.cookie)).json.config.codexModel).toEqual({ model: 'default', reasoning: 'default' });
  const snapshotUrl = await image.getAttribute('src');
  expect(snapshotUrl).toBeTruthy();
  const original = await studio.request('GET', snapshotUrl!, studio.a.cookie);
  expect(original.status).toBe(200);
  const overwritten = await studio.request('POST', `/api/projects/${projectId}/files`, studio.a.cookie, { name: 'hero.png', content: 'new workspace version' });
  expect(overwritten.status, overwritten.text).toBe(200);
  await page.reload();
  await expect(image).toHaveAttribute('src', snapshotUrl!);
  await expect.poll(() => image.evaluate((element: HTMLImageElement) => element.naturalWidth)).toBe(1);
  expect((await studio.request('GET', snapshotUrl!, studio.a.cookie)).text).toBe(original.text);
  const foreign = await studio.request('GET', snapshotUrl!, studio.b.cookie);
  expect(foreign.status).toBe(404);
  await page.screenshot({ path: info.outputPath('studio-immutable-image.png') });
});
test.use({ ignoreHTTPSErrors: true });
test.setTimeout(T.xlong * 3);

for (const taskType of [null, 'prototype', 'deck', 'document'] as const) {
test(`[P1] Studio Home rich composer creates one ${taskType ?? 'freeform'} project and hands its prompt to one run`, async ({ page, studio }, info) => {
  page.setDefaultTimeout(T.medium);
  await studio.linkCodex(studio.a);
  await studio.configureTurn(studio.a, { reply: 'Home first turn completed.' });
  await page.goto(studio.origin);
  await page.locator('input[name="username"]').fill(studio.a.username);
  await page.locator('input[name="password"]').fill(studio.a.password);
  await page.getByRole('button', { name: 'Sign in', exact: true }).click();
  const input = page.getByTestId('home-hero-input');
  await expect(input).toBeVisible({ timeout: T.long });
  if (taskType) {
    await page.getByTestId('home-hero-template-trigger').getByRole('button').click();
    const menu = page.getByTestId('home-hero-template-menu');
    await expect(menu.locator('[data-chip="image"]')).toBeDisabled();
    await expect(menu.locator('[data-chip="image"]')).toHaveAttribute('title', /pending/);
    await menu.locator(`[data-chip="${taskType}"]`).click();
    await expect(page.getByTestId('home-hero-template-picker')).toHaveAttribute('data-type', taskType);
  }
  await input.fill('Create a small product landing page from Home.');
  const send = page.getByTestId('home-hero-submit');
  await expect(send).toBeEnabled();
  if (taskType === 'deck') await page.screenshot({ path: info.outputPath('studio-home-composer-entry.png') });
  const projects = page.waitForResponse((response) => response.request().method() === 'POST' && new URL(response.url()).pathname === '/api/projects');
  const run = page.waitForResponse((response) => response.request().method() === 'POST' && new URL(response.url()).pathname === '/api/runs');
  await send.click();
  const created = await projects; expect(created.status()).toBe(200);
  expect((await run).status()).toBe(202);
  const project = (await created.json()).project;
  expect(project.metadata.kind).toBe(taskType === 'prototype' || taskType === 'deck' ? taskType : 'other');
  if (taskType === 'document') expect(project.metadata.intent).toBe('document');
  await expect(page.getByTestId('chat-composer')).toBeVisible({ timeout: T.long });
  await expect(page.getByTestId('chat-log')).toContainText('Home first turn completed.', { timeout: T.long });
  const conversation = (await created.json()).conversationId;
  const messages = await studio.request('GET', `/api/projects/${project.id}/conversations/${conversation}/messages`, studio.a.cookie);
  expect(messages.json.messages.filter((message: { role: string }) => message.role === 'user')).toHaveLength(1);
  await page.reload();
  await expect(page.getByTestId('chat-log')).toContainText('Home first turn completed.', { timeout: T.long });
  expect((await studio.request('GET', '/api/projects', studio.a.cookie)).json.projects).toHaveLength(1);
  expect((await studio.request('GET', '/api/runs', studio.a.cookie)).json.runs).toHaveLength(1);
  expect((await studio.request('GET', `/api/projects/${project.id}`, studio.b.cookie)).status).toBe(404);
});
}

test('[P1] Studio saves a private template in FileViewer and creates its captured files from Home', async ({ page, studio }, info) => {
  const sourceId = studioProjectId();
  expect((await studio.request('POST', '/api/projects', studio.a.cookie, { id: sourceId, name: 'Browser template source' })).status).toBe(200);
  expect((await studio.request('POST', `/api/projects/${sourceId}/files`, studio.a.cookie,
    { name: 'index.html', content: '<h1>Browser captured original</h1>' })).status).toBe(200);
  await page.goto(`${studio.origin}/projects/${sourceId}/files/index.html`);
  await page.locator('input[name="username"]').fill(studio.a.username);
  await page.locator('input[name="password"]').fill(studio.a.password);
  await page.getByRole('button', { name: 'Sign in', exact: true }).click();
  await expect(page.getByTestId('save-project-template')).toBeVisible({ timeout: T.long });
  const downloaded = page.waitForEvent('download');
  await page.getByTestId('download-project-archive').click();
  const download = await downloaded;
  expect(download.suggestedFilename()).toBe('Browser-template-source.zip');
  const localArchive = info.outputPath('studio-browser-owned.zip');
  await download.saveAs(localArchive);
  const { readFile } = await import('node:fs/promises');
  expect((await readFile(localArchive)).subarray(0, 4)).toEqual(Buffer.from([0x50, 0x4b, 0x03, 0x04]));
  await page.screenshot({ path: info.outputPath('studio-template-save-entry.png') });
  await page.getByTestId('save-project-template').click();
  const dialog = page.getByRole('dialog');
  await dialog.getByLabel('Template name', { exact: true }).fill('Browser private snapshot');
  const saved = page.waitForResponse((response) => response.request().method() === 'POST' && new URL(response.url()).pathname === '/api/templates');
  await dialog.getByRole('button', { name: 'Save', exact: true }).click();
  const response = await saved; expect(response.status()).toBe(201);
  const templateId = (await response.json()).template.id as string;
  expect((await studio.request('POST', `/api/projects/${sourceId}/files`, studio.a.cookie,
    { name: 'index.html', content: '<h1>Browser changed original</h1>' })).status).toBe(200);
  await page.goto(studio.origin);
  await page.getByTestId('home-new-project').click();
  const panel = page.getByTestId('new-project-panel');
  await panel.getByTestId('new-project-tab-template').click();
  await expect(panel.getByTestId('new-project-tab-template')).toHaveAttribute('aria-selected', 'true');
  await expect(panel.getByRole('button', { name: /Browser private snapshot/ }).first()).toBeVisible();
  const created = page.waitForResponse((result) => result.request().method() === 'POST' && new URL(result.url()).pathname === '/api/projects');
  await panel.getByTestId('new-project-name').fill('Browser template copy');
  await panel.getByRole('button', { name: /Browser private snapshot/ }).first().scrollIntoViewIfNeeded();
  await page.screenshot({ path: info.outputPath('studio-template-home-entry.png'), animations: 'disabled' });
  await panel.getByTestId('create-project').click();
  const made = await created; expect(made.status()).toBe(200);
  const id = (await made.json()).project.id as string;
  expect(made.request().postDataJSON().metadata).toMatchObject({ kind: 'template', templateId });
  expect((await studio.request('GET', `/api/projects/${id}/files/index.html`, studio.a.cookie)).text).toBe('<h1>Browser captured original</h1>');
  expect((await studio.request('GET', `/api/templates/${templateId}`, studio.b.cookie)).status).toBe(404);
  await page.reload();
  await expect(page.getByTestId('chat-composer')).toBeVisible({ timeout: T.long });
  const { mkdir, writeFile } = await import('node:fs/promises');
  const folder = `${studio.root}/browser-selected-folder`;
  await mkdir(`${folder}/assets`, { recursive: true });
  await writeFile(`${folder}/index.html`, '<h1>Browser folder upload</h1>');
  await writeFile(`${folder}/assets/logo.svg`, '<svg/>');
  await page.goto(studio.origin);
  await page.getByTestId('home-new-project').click();
  await expect(panel.getByTestId('import-browser-directory')).toBeVisible();
  const imported = page.waitForResponse((result) => result.request().method() === 'POST' && new URL(result.url()).pathname === '/api/import/files');
  await panel.getByTestId('browser-directory-input').setInputFiles(folder);
  const upload = await imported; expect(upload.status()).toBe(200);
  const importedId = (await upload.json()).project.id as string;
  expect((await studio.request('GET', `/api/projects/${importedId}/files/assets/logo.svg`, studio.a.cookie)).text).toBe('<svg/>');
  expect((await studio.request('GET', `/api/projects/${importedId}`, studio.b.cookie)).status).toBe(404);
});

test('[P1] Studio saves private skills, instructions and memory in shared Settings and runs their captured text', async ({ page, studio }, info) => {
  // No browser request may leave the deployment's own app/preview origins (telemetry off, no third-party calls).
  const foreign: string[] = [];
  page.on('request', (request) => {
    const url = new URL(request.url());
    if (!['https:', 'http:', 'wss:', 'ws:'].includes(url.protocol)) return;
    if (![new URL(studio.origin).origin, new URL(studio.previewOrigin).origin].includes(url.origin)) foreign.push(url.origin);
  });
  await studio.linkCodex(studio.a);
  await studio.configureTurn(studio.a, { promptReplyMarkers: ['Browser private skill marker', 'Browser account instructions marker', 'Browser account memory marker', 'Browser design original marker'] });
  await page.goto(`${studio.origin}/settings`);
  await page.locator('input[name="username"]').fill(studio.a.username);
  await page.locator('input[name="password"]').fill(studio.a.password);
  await page.getByRole('button', { name: 'Sign in', exact: true }).click();
  // Shared Settings frame: every desktop section stays in the navigation; open lanes show their reason.
  await expect(page.getByTestId('studio-settings-nav-agentAccounts')).toHaveClass(/active/, { timeout: T.long });
  await page.screenshot({ path: info.outputPath('studio-settings-navigation-entry.png'), animations: 'disabled' });
  for (const pending of ['media', 'integrations']) {
    await page.getByTestId(`studio-settings-nav-${pending}`).click();
    await expect(page.locator('.settings-content .studio-unavailable')).toBeVisible();
  }
  // Telemetry is off for Web accounts (deployment decision): the page says so and offers no opt-in.
  await page.getByTestId('studio-settings-nav-privacy').click();
  await expect(page.getByTestId('studio-privacy')).toContainText('No usage data leaves this deployment');
  await expect(page.getByTestId('studio-privacy').getByRole('checkbox')).toHaveCount(0);
  await page.screenshot({ path: info.outputPath('studio-privacy-entry.png'), animations: 'disabled' });
  // About: the deployed version and a no-store check for a newer deployment (#67 Web equivalent).
  await page.getByTestId('studio-settings-nav-about').click();
  await expect(page.getByTestId('studio-about-version')).not.toHaveText('—');
  await page.getByTestId('studio-about-check').click();
  await expect(page.getByTestId('studio-about').getByRole('status')).toHaveText('You are already on the latest version.');
  await page.getByTestId('studio-settings-nav-skills').click();
  await page.getByTestId('skills-new').click();
  const form = page.getByTestId('skills-create-form');
  await form.getByPlaceholder('my-skill').fill('Browser private skill');
  await form.locator('textarea[rows="14"]').fill('Browser private skill marker');
  const created = page.waitForResponse((response) => response.request().method() === 'POST' && new URL(response.url()).pathname === '/api/skills/import');
  await page.getByTestId('skills-save').click();
  const response = await created;
  expect(response.status()).toBe(201);
  const id = (await response.json()).skill.id;
  await expect(form).toHaveCount(0);
  // Folder import: SKILL.md plus a binary side file become one private package.
  const skillFolder = path.join(info.outputPath('skill-folder'), 'browser-folder-skill');
  mkdirSync(path.join(skillFolder, 'assets'), { recursive: true });
  writeFileSync(path.join(skillFolder, 'SKILL.md'), '---\nname: Browser folder skill\n---\nBrowser folder skill body');
  writeFileSync(path.join(skillFolder, 'assets', 'mark.bin'), Buffer.from([0, 255, 3]));
  const folderImported = page.waitForResponse((result) => result.request().method() === 'POST' && new URL(result.url()).pathname === '/api/skills/import-files');
  await page.getByTestId('skills-import-folder-input').setInputFiles(skillFolder);
  const folderResponse = await folderImported;
  expect(folderResponse.status()).toBe(201);
  const folderSkillId = (await folderResponse.json()).skill.id as string;
  await expect(page.locator('.settings-skills')).toContainText('Browser folder skill');
  await expect(page.locator('.settings-skills')).toContainText('assets');
  await expect(page.locator('.settings-skills')).toContainText('Browser folder skill body');
  expect((await studio.request('GET', `/api/skills/${encodeURIComponent(folderSkillId)}/files`, studio.a.cookie)).json.files
    .map((file: { path: string }) => file.path).sort()).toEqual(['SKILL.md', 'assets/mark.bin']);
  expect((await studio.request('GET', `/api/skills/${encodeURIComponent(folderSkillId)}`, studio.b.cookie)).status).toBe(404);
  await page.screenshot({ path: info.outputPath('studio-skill-folder-entry.png'), animations: 'disabled' });
  await page.getByTestId('studio-settings-nav-general').click();
  await page.getByTestId('settings-accent-color').fill('#1a74ff');
  const notification = page.getByRole('group', { name: 'Completion sound', exact: true });
  await notification.getByRole('button', { name: 'active', exact: true }).click();
  // Unsaved General edits survive switching sections; one save writes the account revision.
  await page.getByTestId('studio-settings-nav-instructions').click();
  await page.locator('.custom-instructions-input').fill('Browser account instructions marker');
  const instructionsSaved = page.waitForResponse((result) => result.request().method() === 'PUT' && new URL(result.url()).pathname === '/api/app-config');
  await page.getByTestId('studio-instructions-save').click();
  expect((await instructionsSaved).status()).toBe(200);
  const savedPreferences = (await studio.request('GET', '/api/app-config', studio.a.cookie)).json.config;
  expect(savedPreferences.accentColor).toBe('#1a74ff');
  expect(savedPreferences.notifications.soundEnabled).toBe(true);
  expect((await studio.request('GET', '/api/app-config', studio.b.cookie)).json.config.notifications.soundEnabled).toBe(false);
  await page.reload();
  await page.getByTestId('studio-settings-nav-general').click();
  await expect(page.getByTestId('settings-accent-color')).toHaveValue('#1a74ff');
  await expect(page.getByRole('group', { name: 'Completion sound', exact: true }).getByRole('button', { name: 'active', exact: true })).toHaveAttribute('aria-pressed', 'true');
  await expect(page.locator('html')).toHaveCSS('--accent', '#1a74ff');
  await page.getByTestId('settings-accent-color').scrollIntoViewIfNeeded();
  await page.screenshot({ path: info.outputPath('studio-settings-preferences-entry.png'), animations: 'disabled' });

  await page.getByTestId('studio-settings-nav-memory').click();
  await page.getByRole('button', { name: 'Add or import memories', exact: true }).click();
  const profile = page.getByTestId('memory-profile-panel');
  await profile.getByRole('textbox', { name: 'Role', exact: true }).fill('Browser account memory marker');
  const memorySaved = page.waitForResponse((result) => result.request().method() === 'PUT' && new URL(result.url()).pathname === '/api/memory/user_profile');
  await profile.getByRole('button', { name: 'Save profile', exact: true }).click();
  expect((await memorySaved).status()).toBe(200);
  await page.locator('[aria-labelledby="memory-add-modal-title"]').getByRole('button', { name: 'Close', exact: true }).click();
  await page.screenshot({ path: info.outputPath('studio-skills-entry.png') });
  await page.goto(`${studio.origin}/design-systems`);
  await page.getByTestId('design-systems-create').click();
  const designBody = '# Browser Document\nBrowser design original marker\nPrimary color: #2468ac';
  await page.getByTestId('design-system-document-body').fill(designBody);
  await page.screenshot({ path: info.outputPath('studio-design-create-entry.png') });
  const documentMade = page.waitForResponse((result) => result.request().method() === 'POST' && new URL(result.url()).pathname === '/api/design-systems');
  await page.getByTestId('design-system-document-create').click();
  const madeDocument = await documentMade;
  expect(madeDocument.status()).toBe(201);
  const createdDesign = (await madeDocument.json()).designSystem;
  const designId = createdDesign.id as string;
  await expect(page.getByTestId('design-system-document-edit')).toHaveValue(designBody);
  await page.reload();
  await expect(page.getByTestId('design-system-document-edit')).toHaveValue(designBody);
  expect((await studio.request('GET', `/api/design-systems/${designId}`, studio.b.cookie)).status).toBe(404);
  await page.goto(studio.origin);
  await page.getByTestId('home-new-project').click();
  const projectPanel = page.getByTestId('new-project-panel');
  await projectPanel.getByTestId('new-project-name').fill('Browser skill run');
  await projectPanel.getByTestId('new-project-skill').selectOption(id);
  await projectPanel.getByTestId('design-system-trigger').click();
  const documentOption = page.locator('.ds-picker-list-design-systems button').filter({ hasText: createdDesign.title });
  await expect(documentOption).toBeVisible({ timeout: T.medium });
  await documentOption.click();
  await expect(projectPanel.getByTestId('new-project-tab-media')).toBeDisabled();
  await expect(projectPanel.getByTestId('new-project-tab-live-artifact')).toBeDisabled();
  await expect(projectPanel.getByTestId('new-project-tab-template')).toBeEnabled();
  await expect(projectPanel.locator('.newproj-working-dir-row')).toHaveCount(0);
  await page.screenshot({ path: info.outputPath('studio-formal-project-entry.png') });
  const projectCreated = page.waitForResponse((result) => result.request().method() === 'POST' && new URL(result.url()).pathname === '/api/projects');
  await projectPanel.getByTestId('create-project').click();
  const madeProject = await projectCreated;
  expect(madeProject.status()).toBe(200);
  const projectId = (await madeProject.json()).project.id as string;
  expect(madeProject.request().postDataJSON()).toMatchObject({ skillId: id, designSystemId: designId,
    metadata: { kind: 'prototype', fidelity: 'high-fidelity', platformTargets: ['responsive'] } });
  const composer = page.getByTestId('chat-composer-input');
  await expect(composer).toBeVisible({ timeout: T.long });
  await page.getByTestId('home-hero-design-system-trigger').click();
  const designCleared = page.waitForResponse((result) => result.request().method() === 'PATCH' && new URL(result.url()).pathname === `/api/projects/${projectId}`);
  await page.locator('.project-ds-picker-list button[role=option]').first().click();
  expect((await designCleared).status()).toBe(200);
  await page.getByTestId('home-hero-design-system-trigger').click();
  const designSelected = page.waitForResponse((result) => result.request().method() === 'PATCH' && new URL(result.url()).pathname === `/api/projects/${projectId}`);
  await page.getByTestId(`project-ds-picker-option-${designId}`).click();
  expect((await designSelected).status()).toBe(200);
  await composer.fill('@Browser');
  await page.getByRole('option').filter({ hasText: 'Browser private skill' }).click();
  await composer.press('End');
  await composer.pressSequentially(' Use the selected private skill.');
  const admitted = page.waitForResponse((result) => result.request().method() === 'POST' && new URL(result.url()).pathname === '/api/runs');
  await page.getByTestId('chat-send').click();
  const started = await admitted;
  expect(started.status()).toBe(202);
  expect(started.request().postDataJSON().context.skillIds).toContain(id);
  expect(started.request().postDataJSON().designSystemId).toBe(designId);
  await expect(page.locator('body')).toContainText('Browser private skill marker', { timeout: T.long });
  await expect(page.locator('body')).toContainText('Browser account instructions marker', { timeout: T.long });
  await expect(page.locator('body')).toContainText('Browser account memory marker', { timeout: T.long });
  await expect(page.locator('body')).toContainText('Browser design original marker', { timeout: T.long });
  expect((await studio.request('GET', `/api/skills/${encodeURIComponent(id)}`, studio.b.cookie)).status).toBe(404);
  await page.reload();
  await expect(page.locator('body')).toContainText('Browser private skill marker', { timeout: T.long });
  await expect(page.locator('body')).toContainText('Browser account memory marker', { timeout: T.long });
  expect((await studio.request('GET', '/api/memory/user_profile', studio.b.cookie)).status).toBe(404);
  expect((await studio.request('GET', '/api/app-config', studio.b.cookie)).text).not.toContain('Browser account instructions marker');
  await page.goto(`${studio.origin}/settings`);
  await page.getByTestId('studio-settings-nav-instructions').click();
  await expect(page.locator('.custom-instructions-input')).toHaveValue('Browser account instructions marker');
  await page.screenshot({ path: info.outputPath('studio-skill-turn.png') });
  expect([...new Set(foreign)]).toEqual([]);
});

// One browser witness owns the iframe → parent → owner file-write transition.
// API authorization permutations belong to studio-preview/artifacts-http.
test('[P1] Studio deck navigation and manual edits survive reload under owner cookie authority', async ({ page, browser, studio }, info) => {
  const projectId = studioProjectId();
  const made = await studio.request('POST', '/api/projects', studio.a.cookie, { id: projectId, name: 'Studio preview acceptance' });
  expect(made.status, made.text).toBe(200);
  const content = `<!doctype html><html><head><style>body { background: #ffffff; }</style></head><body>
    <section class="slide" data-od-id="slide-one"><h1>Owner Slide One</h1></section>
    <section class="slide" data-od-id="slide-two" hidden><h1>Owner Slide Two</h1></section>
    <script>
      let active = 0; const slides = Array.from(document.querySelectorAll('.slide'));
      function render() { slides.forEach((slide, index) => { slide.hidden = index !== active; }); }
      addEventListener('message', (event) => {
        if (event.data?.type !== 'od:slide') return;
        if (event.data.action === 'next') active = Math.min(slides.length - 1, active + 1);
        if (event.data.action === 'prev') active = Math.max(0, active - 1);
        render(); parent.postMessage({ type: 'od:slide-state', active, count: slides.length }, '*');
      });
      render(); parent.postMessage({ type: 'od:slide-state', active, count: slides.length }, '*');
    </script></body></html>`;
  const seeded = await studio.request('POST', `/api/projects/${projectId}/files`, studio.a.cookie,
    { name: 'deck.html', content, artifactManifest: { version: 1, kind: 'deck', title: 'Owner deck', entry: 'deck.html', renderer: 'deck-html', exports: ['html', 'pdf'] } });
  expect(seeded.status, seeded.text).toBe(200);
  const location = `${studio.origin}/projects/${projectId}/files/deck.html`;
  await page.goto(location);
  await page.locator('input[name="username"]').fill(studio.a.username);
  await page.locator('input[name="password"]').fill(studio.a.password);
  await page.getByRole('button', { name: 'Sign in', exact: true }).click();
  const preview = activeArtifactPreview(page);
  const frame = activeArtifactPreviewFrame(page);
  await expect(preview).toBeVisible({ timeout: T.long });
  await expect(frame.getByRole('heading', { name: 'Owner Slide One' })).toBeVisible();
  expect(await preview.getAttribute('sandbox')).not.toContain('allow-same-origin');
  await clickDeckNextSlide(page);
  await expect(frame.getByRole('heading', { name: 'Owner Slide Two' })).toBeVisible();
  await clickPreviewToolbarAction(page, 'manual-edit-mode-toggle', /^Edit$/);
  await expect(frame.locator('html[data-od-edit-mode]')).toHaveCount(1);
  await frame.locator('body').evaluate(() => parent.postMessage({ type: 'od-edit-background' }, '*'));
  await expect(page.locator('.manual-edit-modal')).toContainText('PAGE');
  await page.locator('.manual-edit-modal .cc-row').filter({ hasText: 'Background' }).locator('input:not([type="color"])').fill('#eef2ff');
  const write = page.waitForResponse((response) => response.request().method() === 'POST'
    && new URL(response.url()).pathname === `/api/projects/${projectId}/files`);
  await page.locator('.manual-edit-modal').getByRole('button', { name: 'Save', exact: true }).click();
  expect((await write).status()).toBe(200);
  const saved = await studio.request('GET', `/api/projects/${projectId}/files/deck.html`, studio.a.cookie);
  expect(saved.text).toContain('background-color: rgb(238, 242, 255)');
  expect(saved.text).not.toContain('data-od-edit-selected');
  await page.reload();
  await expect(frame.getByRole('heading', { name: 'Owner Slide One' })).toBeVisible();
  await expect.poll(() => frame.locator('body').evaluate((body) => getComputedStyle(body).backgroundColor)).toBe('rgb(238, 242, 255)');
  await page.screenshot({ path: info.outputPath('studio-deck-owner.png') });
  // Export: the owner's one-file HTML bundle; renderer formats stay closed until #66.
  await page.getByRole('button', { name: 'Export', exact: true }).click();
  const exportMenu = page.locator('.chrome-unified-panel');
  await expect(exportMenu.getByRole('menuitem', { name: 'Export as standalone HTML' })).toBeVisible();
  await expect(exportMenu.getByRole('menuitem', { name: /PDF/ })).toHaveCount(0);
  await page.screenshot({ path: info.outputPath('studio-export-html-entry.png'), animations: 'disabled' });
  const exported = page.waitForResponse((response) => response.request().method() === 'POST' && new URL(response.url()).pathname === `/api/projects/${projectId}/export/html`);
  const downloaded = page.waitForEvent('download');
  await exportMenu.getByRole('menuitem', { name: 'Export as standalone HTML' }).click();
  expect((await exported).status()).toBe(200);
  expect((await downloaded).suggestedFilename()).toMatch(/\.html$/);
  const other = await browser.newContext({ ignoreHTTPSErrors: true });
  try {
    const b = await other.newPage();
    await b.goto(location);
    await b.locator('input[name="username"]').fill(studio.b.username);
    await b.locator('input[name="password"]').fill(studio.b.password);
    const verified = b.waitForResponse((response) => new URL(response.url()).pathname === '/api/auth/me' && response.status() === 200);
    await b.getByRole('button', { name: 'Sign in', exact: true }).click();
    expect((await (await verified).json()).account.id).toBe(studio.b.id);
    await expect(b.getByText('Owner Slide One', { exact: true })).toHaveCount(0);
    await expect(activeArtifactPreview(b)).toHaveCount(0);
    const foreign = await other.request.get(`${studio.origin}/api/projects/${projectId}/files/deck.html`);
    expect(foreign.status()).toBe(404);
    expect((await other.request.post(`${studio.origin}/api/projects/${projectId}/export/html`, { data: { fileName: 'deck.html' } })).status()).toBe(404);
  } finally { await other.close(); }
});


test('[P1] admin configures the company pool and Studio runs and reloads on its pinned OpenAI source', async ({ page, studio }, info) => {
  await page.goto(`${studio.origin}/admin/users`);
  await page.locator('input[name="username"]').fill(studio.admin.username);
  await page.locator('input[name="password"]').fill(studio.admin.password);
  await page.getByRole('button', { name: 'Sign in', exact: true }).click();
  const pool = page.getByTestId('company-openai-settings');
  await expect(pool.locator('input[name="model"]')).toBeVisible({ timeout: T.long });
  await pool.locator('input[name="model"]').fill('fixture-model');
  await pool.locator('input[name="capacity"]').fill('1');
  await pool.locator('input[name="enabled"]').check();
  const key = 'sk-browser-fixture-secret-12345678901234567890';
  await pool.locator('input[name="apiKey"]').fill(key);
  const configured = page.waitForResponse((response) => response.request().method() === 'PUT' && new URL(response.url()).pathname === '/api/admin/pool/openai');
  await pool.getByRole('button', { name: 'Save', exact: true }).click();
  const response = await configured;
  expect(response.status()).toBe(200);
  expect(JSON.stringify(await response.json())).not.toContain(key);
  await expect(pool.locator('input[name="apiKey"]')).toHaveValue('');
  await page.screenshot({ path: info.outputPath('studio-company-pool-entry.png') });
  await page.context().clearCookies();
  const projectId = studioProjectId();
  expect((await studio.request('POST', '/api/projects', studio.a.cookie, { id: projectId, name: 'Company browser acceptance' })).status).toBe(200);
  await page.goto(`${studio.origin}/projects/${projectId}`);
  await page.locator('input[name="username"]').fill(studio.a.username);
  await page.locator('input[name="password"]').fill(studio.a.password);
  await page.getByRole('button', { name: 'Sign in', exact: true }).click();
  const source = page.getByTestId('studio-execution-source');
  const sourcePicker = source.getByRole('combobox', { name: 'Execution source', exact: true });
  await expect(sourcePicker).toBeVisible({ timeout: T.long });
  await sourcePicker.selectOption('openai');
  const composer = page.getByTestId('chat-composer-input');
  await composer.fill('Create a company design.');
  const admitted = page.waitForResponse((result) => result.request().method() === 'POST' && new URL(result.url()).pathname === '/api/runs');
  await page.getByTestId('chat-send').click();
  const run = await admitted;
  expect(run.status(), await run.text()).toBe(202);
  expect(run.request().postDataJSON().agentId).toBe('openai');
  await expect(page.locator('body')).toContainText('Company browser design complete.', { timeout: T.long });
  const fileUrl = `/api/projects/${projectId}/files/company.html`;
  expect((await studio.request('GET', fileUrl, studio.a.cookie)).text).toContain('Company browser design');
  expect((await studio.request('GET', fileUrl, studio.b.cookie)).status).toBe(404);
  await page.reload();
  await expect(source).toContainText('OpenAI · company pool');
  await expect(page.getByTestId('assistant-role').first()).toContainText('OpenAI');
  await expect(source.locator('select')).toHaveCount(0);
  await composer.fill('Continue my company design.');
  const continued = page.waitForResponse((result) => result.request().method() === 'POST' && new URL(result.url()).pathname === '/api/runs');
  await page.getByTestId('chat-send').click();
  const continuation = await continued;
  expect(continuation.status()).toBe(202);
  expect(continuation.request().postDataJSON().agentId).toBe('openai');
  await expect(page.getByTestId('assistant-role').last()).toContainText('OpenAI');
  await page.screenshot({ path: info.outputPath('studio-company-run.png') });
});

test('[P1] Studio account control lives in the shared rail, workspace chrome and admin pages at desktop and phone widths', async ({ page, studio }, info) => {
  const projectId = studioProjectId();
  expect((await studio.request('POST', '/api/projects', studio.a.cookie, { id: projectId, name: 'Account chrome' })).status).toBe(200);
  await page.goto(studio.origin);
  await page.locator('input[name="username"]').fill(studio.a.username);
  await page.locator('input[name="password"]').fill(studio.a.password);
  await page.getByRole('button', { name: 'Sign in', exact: true }).click();
  // Same as the desktop entry: the account module rides the foot of the (collapsible) rail.
  const expand = page.getByTestId('entry-rail-collapse');
  await expect(expand).toBeVisible({ timeout: T.long });
  if (await expand.getAttribute('aria-expanded') === 'false') await expand.click();
  const trigger = page.locator('.entry-nav-rail').getByTestId('studio-account-trigger');
  await expect(trigger).toBeVisible({ timeout: T.long });
  await expect(trigger).toHaveText(/studio-a/);
  await expect(page.locator('.studio-account-chrome')).toHaveCount(0);
  await trigger.click();
  await expect(page.getByRole('menuitem', { name: 'Users' })).toHaveCount(0);
  await page.screenshot({ path: info.outputPath('studio-account-rail.png'), animations: 'disabled' });
  await page.getByRole('menuitem', { name: 'Settings' }).click();
  await expect(page.getByTestId('studio-settings-nav-agentAccounts')).toBeVisible({ timeout: T.long });
  await page.goto(`${studio.origin}/projects/${projectId}`);
  await expect(page.getByTestId('workspace-chrome-account-actions').getByTestId('studio-account-trigger')).toHaveText(/studio-a/, { timeout: T.long });
  await page.setViewportSize({ width: 390, height: 844 });
  await expect(page.getByTestId('studio-account-trigger')).toBeVisible();
  await page.screenshot({ path: info.outputPath('studio-account-phone-project.png'), animations: 'disabled' });
  await page.getByTestId('studio-account-trigger').click();
  await page.getByRole('menuitem', { name: 'Sign out' }).click();
  await expect(page.locator('input[name="username"]')).toBeVisible({ timeout: T.long });

  await page.setViewportSize({ width: 1280, height: 720 });
  // A pilot administrator sees the admin pages inside the shared App with the same account control.
  const pilot = await studio.request('PUT', `/api/admin/users/${studio.admin.id}/studio-pilot`, studio.admin.cookie, { studioPilot: true, revision: 0 });
  expect(pilot.status, pilot.text).toBe(200);
  await page.goto(`${studio.origin}/admin/users`);
  await page.locator('input[name="username"]').fill(studio.admin.username);
  await page.locator('input[name="password"]').fill(studio.admin.password);
  await page.getByRole('button', { name: 'Sign in', exact: true }).click();
  await expect(page.getByTestId('company-openai-settings')).toBeVisible({ timeout: T.long });
  await page.getByTestId('studio-account-trigger').click();
  await expect(page.getByRole('menuitem', { name: 'Audit' })).toBeVisible();
  await page.screenshot({ path: info.outputPath('studio-account-admin.png'), animations: 'disabled' });
});

test('[P1] Studio account automations create, run as the owner and stay private', async ({ page, studio }, info) => {
  await studio.linkCodex(studio.a);
  await studio.configureTurn(studio.a, { reply: 'Routine finished the brief.' });
  await page.goto(`${studio.origin}/automations`);
  await page.locator('input[name="username"]').fill(studio.a.username);
  await page.locator('input[name="password"]').fill(studio.a.password);
  await page.getByRole('button', { name: 'Sign in', exact: true }).click();
  await page.getByTestId('automations-new').click({ timeout: T.long });
  const modal = page.getByTestId('automation-modal');
  await modal.getByTestId('automation-modal-title').fill('Browser routine');
  await modal.getByTestId('automation-modal-prompt').fill('Summarize the design board for the team.');
  const created = page.waitForResponse((response) => response.request().method() === 'POST' && new URL(response.url()).pathname === '/api/routines');
  await modal.locator('button[type="submit"]').click();
  const made = await created;
  expect(made.status(), await made.text()).toBe(201);
  const routineId = (await made.json()).routine.id as string;
  const row = page.getByTestId('tasks-view').getByText('Browser routine');
  await expect(row).toBeVisible({ timeout: T.long });
  await page.screenshot({ path: info.outputPath('studio-automations-entry.png'), animations: 'disabled' });
  const ran = page.waitForResponse((response) => response.request().method() === 'POST' && new URL(response.url()).pathname === `/api/routines/${routineId}/run`);
  await page.getByTestId('tasks-view').getByRole('button', { name: 'Run', exact: true }).click();
  const started = await ran;
  expect(started.status()).toBe(202);
  const { projectId } = await started.json() as { projectId: string };
  // Run opens the owner's fresh routine conversation in the shared workspace.
  await expect(page).toHaveURL(new RegExp(`/projects/${projectId}`), { timeout: T.long });
  await expect.poll(async () => (await studio.request('GET', `/api/routines/${routineId}/runs`, studio.a.cookie)).json.runs[0]?.status,
    { timeout: T.long }).toBe('succeeded');
  await expect(page.locator('body')).toContainText('Routine finished the brief.', { timeout: T.long });
  await page.screenshot({ path: info.outputPath('studio-automation-run.png'), animations: 'disabled' });
  expect((await studio.request('GET', '/api/routines', studio.b.cookie)).json.routines).toEqual([]);
  expect((await studio.request('GET', `/api/routines/${routineId}`, studio.b.cookie)).status).toBe(404);
});

test('[P1] Studio owner comments on a preview element, sends it to the agent and keeps it private', async ({ page, studio }, info) => {
  await studio.linkCodex(studio.a);
  await studio.configureTurn(studio.a, { reply: 'Applied the comment.' });
  const projectId = studioProjectId();
  const made = await studio.request('POST', '/api/projects', studio.a.cookie, { id: projectId, name: 'Studio comment acceptance' });
  expect(made.status, made.text).toBe(200);
  const seeded = await studio.request('POST', `/api/projects/${projectId}/files`, studio.a.cookie, { name: 'index.html',
    content: '<!doctype html><html><body><h1 data-od-id="hero-title">Owner headline</h1><p>Body copy</p></body></html>' });
  expect(seeded.status, seeded.text).toBe(200);
  await page.goto(`${studio.origin}/projects/${projectId}/files/index.html`);
  await page.locator('input[name="username"]').fill(studio.a.username);
  await page.locator('input[name="password"]').fill(studio.a.password);
  await page.getByRole('button', { name: 'Sign in', exact: true }).click();
  const frame = activeArtifactPreviewFrame(page);
  await expect(frame.getByRole('heading', { name: 'Owner headline' })).toBeVisible({ timeout: T.long });
  await clickPreviewToolbarAction(page, 'board-mode-toggle', /^Comment$/);
  await clickPreviewToolbarAction(page, 'comment-panel-toggle', /^Comments \(\d+\)$/);
  await expect(frame.locator('html[data-od-comment-mode]')).toHaveCount(1, { timeout: T.medium });
  await frame.locator('[data-od-id="hero-title"]').click();
  await expect(page.getByTestId('comment-popover')).toBeVisible();
  await page.getByTestId('comment-popover-input').fill('Make the headline more specific.');
  const saved = page.waitForResponse((response) => response.request().method() === 'POST'
    && /\/conversations\/[^/]+\/comments$/.test(new URL(response.url()).pathname));
  await page.getByTestId('comment-popover-save').click();
  expect((await saved).status()).toBe(200);
  const sidePanel = page.getByTestId('comment-side-panel');
  await expect(sidePanel).toContainText('Make the headline more specific.');
  await page.screenshot({ path: info.outputPath('studio-comments-entry.png'), animations: 'disabled' });
  const conversationId = made.json.conversationId as string;
  const stored = await studio.request('GET', `/api/projects/${projectId}/conversations/${conversationId}/comments`, studio.a.cookie);
  expect(stored.json.comments).toEqual([expect.objectContaining({ elementId: 'hero-title', note: 'Make the headline more specific.' })]);
  expect((await studio.request('GET', `/api/projects/${projectId}/conversations/${conversationId}/comments`, studio.b.cookie)).status).toBe(404);
  await expect.poll(async () => {
    const selectAll = sidePanel.getByRole('button', { name: /select all/i }).first();
    if ((await selectAll.count()) === 0) return false;
    await selectAll.evaluate((element: HTMLButtonElement) => element.click());
    return (await page.getByTestId('comment-side-send-claude').count()) > 0;
  }).toBe(true);
  const admitted = page.waitForResponse((response) => response.request().method() === 'POST' && new URL(response.url()).pathname === '/api/runs');
  await page.getByTestId('comment-side-send-claude').click();
  const admission = await admitted;
  expect(admission.status(), await admission.text()).toBe(202);
  expect(admission.request().postDataJSON().commentAttachments).toEqual([expect.objectContaining({ elementId: 'hero-title', filePath: 'index.html' })]);
  await expect.poll(async () => String((await studio.turnEvidence(studio.a).catch(() => null))?.message ?? ''), { timeout: T.long })
    .toContain('<attached-preview-comments>');
  // Sending moves the comment through the apply lifecycle with owner PATCHes; the panel lists only open ones.
  await expect.poll(async () => (await studio.request('GET', `/api/projects/${projectId}/conversations/${conversationId}/comments`, studio.a.cookie))
    .json.comments[0]?.status, { timeout: T.long }).not.toBe('open');
  await page.reload();
  await expect(frame.getByRole('heading', { name: 'Owner headline' })).toBeVisible({ timeout: T.long });
  expect((await studio.request('GET', `/api/projects/${projectId}/conversations/${conversationId}/comments`, studio.b.cookie)).status).toBe(404);
});

test('[P1] Studio adopts a bundled in-page pet as an account preference that follows the account, not the browser', async ({ page, browser, studio }, info) => {
  await page.goto(`${studio.origin}/settings`);
  await page.locator('input[name="username"]').fill(studio.a.username);
  await page.locator('input[name="password"]').fill(studio.a.password);
  await page.getByRole('button', { name: 'Sign in', exact: true }).click();
  await page.getByTestId('studio-settings-nav-general').click({ timeout: T.long });
  const petBlock = page.getByTestId('studio-settings-pet');
  await expect(petBlock).toBeVisible();
  // Bundled catalog only: the host community sync is not offered.
  await expect(petBlock.getByRole('button', { name: /sync/i })).toHaveCount(0);
  const card = petBlock.locator('.pet-codex-card').filter({ hasText: 'Tux' });
  await expect(card).toBeVisible({ timeout: T.long });
  await card.hover();
  await card.getByRole('button', { name: 'Adopt', exact: true }).click();
  await expect(petBlock.locator('.pet-codex-grid').getByRole('button', { name: 'Adopted', exact: true })).toHaveCount(1, { timeout: T.long });
  await petBlock.scrollIntoViewIfNeeded();
  await page.screenshot({ path: info.outputPath('studio-pet-settings-entry.png'), animations: 'disabled' });
  const saved = page.waitForResponse((response) => response.request().method() === 'PUT' && new URL(response.url()).pathname === '/api/app-config');
  await page.getByTestId('studio-instructions-save').click();
  expect((await saved).status()).toBe(200);
  const stored = (await studio.request('GET', '/api/app-config', studio.a.cookie)).json.config.pet;
  expect(stored).toMatchObject({ adopted: true, enabled: true });
  expect(stored.custom.imageUrl).toMatch(/^data:image\//);
  await page.goto(`${studio.origin}/`);
  const overlay = page.getByRole('complementary', { name: 'Pet companion' });
  await expect(overlay).toBeVisible({ timeout: T.long });
  await page.screenshot({ path: info.outputPath('studio-pet-overlay.png'), animations: 'disabled' });
  // About → clear this browser's data: storage is emptied and the page's own session is revoked server-side.
  const cookieHeader = (await page.context().cookies(studio.origin)).map((cookie) => `${cookie.name}=${cookie.value}`).join('; ');
  expect((await studio.request('GET', '/api/auth/me', cookieHeader)).status).toBe(200);
  await page.evaluate(() => { localStorage.setItem('od-test-marker', '1'); sessionStorage.setItem('od-test-marker', '1'); });
  await page.goto(`${studio.origin}/settings`);
  await page.getByTestId('studio-settings-nav-about').click({ timeout: T.long });
  await page.getByTestId('studio-about-clear-data').scrollIntoViewIfNeeded();
  await page.screenshot({ path: info.outputPath('studio-clear-data-entry.png'), animations: 'disabled' });
  await page.getByTestId('studio-about-clear-data').click();
  await expect(page.locator('input[name="username"]')).toBeVisible({ timeout: T.long });
  expect(await page.evaluate(() => [localStorage.getItem('od-test-marker'), sessionStorage.getItem('od-test-marker')])).toEqual([null, null]);
  expect((await studio.request('GET', '/api/auth/me', cookieHeader)).status).toBe(401);
  // The account's server-side preference survives a browser clear.
  expect((await studio.request('GET', '/api/app-config', studio.a.cookie)).json.config.pet.adopted).toBe(true);
  // Another account in a fresh browser sees its own default (no pet).
  const other = await browser.newContext({ ignoreHTTPSErrors: true });
  try {
    const b = await other.newPage();
    await b.goto(`${studio.origin}/`);
    await b.locator('input[name="username"]').fill(studio.b.username);
    await b.locator('input[name="password"]').fill(studio.b.password);
    const verified = b.waitForResponse((response) => new URL(response.url()).pathname === '/api/app-config' && response.status() === 200);
    await b.getByRole('button', { name: 'Sign in', exact: true }).click();
    expect((await (await verified).json()).config.pet.adopted).toBe(false);
    await expect(b.getByRole('button', { name: 'Create project', exact: true })).toBeVisible({ timeout: T.long });
    await expect(b.getByRole('complementary', { name: 'Pet companion' })).toHaveCount(0);
    expect((await studio.request('GET', '/api/app-config', studio.b.cookie)).json.config.pet.adopted).toBe(false);
  } finally { await other.close(); }
});
