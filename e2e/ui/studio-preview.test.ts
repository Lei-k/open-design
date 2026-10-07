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
  await composer.fill('[mock-write=hero.png]');
  const admitted = page.waitForResponse((response) => response.request().method() === 'POST' && new URL(response.url()).pathname === '/api/runs');
  await page.getByTestId('chat-send').click();
  expect((await admitted).status()).toBe(202);
  const image = page.getByTestId('artifact-card-hero.png').locator('img');
  await expect(image).toBeVisible({ timeout: T.long });
  await expect(image).toHaveAttribute('src', /\/chat-artifact-snapshots\/[^/]+\/content$/);
  await expect.poll(() => image.evaluate((element: HTMLImageElement) => element.naturalWidth)).toBe(1);
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

test('[P1] Studio saves private skills, instructions and memory in shared Settings and runs their captured text', async ({ page, studio }, info) => {
  await studio.linkCodex(studio.a);
  await studio.configureTurn(studio.a, { promptReplyMarkers: ['Browser private skill marker', 'Browser account instructions marker', 'Browser account memory marker'] });
  await page.goto(`${studio.origin}/settings`);
  await page.locator('input[name="username"]').fill(studio.a.username);
  await page.locator('input[name="password"]').fill(studio.a.password);
  await page.getByRole('button', { name: 'Sign in', exact: true }).click();
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
  await page.locator('.custom-instructions-input').fill('Browser account instructions marker');
  const instructionsSaved = page.waitForResponse((result) => result.request().method() === 'PUT' && new URL(result.url()).pathname === '/api/app-config');
  await page.getByTestId('studio-instructions-save').click();
  expect((await instructionsSaved).status()).toBe(200);
  await page.getByRole('button', { name: 'Add or import memories', exact: true }).click();
  const profile = page.getByTestId('memory-profile-panel');
  await profile.getByRole('textbox', { name: 'Role', exact: true }).fill('Browser account memory marker');
  const memorySaved = page.waitForResponse((result) => result.request().method() === 'PUT' && new URL(result.url()).pathname === '/api/memory/user_profile');
  await profile.getByRole('button', { name: 'Save profile', exact: true }).click();
  expect((await memorySaved).status()).toBe(200);
  await page.getByRole('dialog').getByRole('button', { name: 'Close', exact: true }).click();
  await page.screenshot({ path: info.outputPath('studio-skills-entry.png') });
  const projectId = studioProjectId();
  expect((await studio.request('POST', '/api/projects', studio.a.cookie, { id: projectId, name: 'Browser skill run' })).status).toBe(200);
  await page.goto(`${studio.origin}/projects/${projectId}`);
  const composer = page.getByTestId('chat-composer-input');
  await expect(composer).toBeVisible({ timeout: T.long });
  await composer.fill('@Browser');
  await page.getByRole('option').filter({ hasText: 'Browser private skill' }).click();
  await composer.press('End');
  await composer.pressSequentially(' Use the selected private skill.');
  const admitted = page.waitForResponse((result) => result.request().method() === 'POST' && new URL(result.url()).pathname === '/api/runs');
  await page.getByTestId('chat-send').click();
  const started = await admitted;
  expect(started.status()).toBe(202);
  expect(started.request().postDataJSON().context.skillIds).toContain(id);
  await expect(page.locator('body')).toContainText('Browser private skill marker', { timeout: T.long });
  await expect(page.locator('body')).toContainText('Browser account instructions marker', { timeout: T.long });
  await expect(page.locator('body')).toContainText('Browser account memory marker', { timeout: T.long });
  expect((await studio.request('GET', `/api/skills/${encodeURIComponent(id)}`, studio.b.cookie)).status).toBe(404);
  await page.reload();
  await expect(page.locator('body')).toContainText('Browser private skill marker', { timeout: T.long });
  await expect(page.locator('body')).toContainText('Browser account memory marker', { timeout: T.long });
  expect((await studio.request('GET', '/api/memory/user_profile', studio.b.cookie)).status).toBe(404);
  expect((await studio.request('GET', '/api/app-config', studio.b.cookie)).text).not.toContain('Browser account instructions marker');
  await page.goto(`${studio.origin}/settings`);
  await expect(page.locator('.custom-instructions-input')).toHaveValue('Browser account instructions marker');
  await page.screenshot({ path: info.outputPath('studio-skill-turn.png') });
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
  await expect(source.locator('select')).toBeVisible({ timeout: T.long });
  await source.locator('select').selectOption('openai');
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
