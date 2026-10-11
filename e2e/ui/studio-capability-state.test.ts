import { clusterTest as base, expect } from '@/playwright/suite';
import { createStudioRuntime, studioProjectId, type StudioRuntime } from '@/studio/runtime';
import { T } from '@/timeouts';

const test = base.extend<{ studio: StudioRuntime }>({
  studio: async ({}, use, info) => {
    const runtime = await createStudioRuntime();
    try { await use(runtime); }
    finally { await runtime.close(info.status !== info.expectedStatus); }
  },
});

test('[P1] Studio capability controls and shell remain reachable at 390 × 844', async ({ page, studio }, info) => {
  await page.setViewportSize({ width: 390, height: 844 });
  const projectId = studioProjectId();
  expect((await studio.request('POST', '/api/projects', studio.a.cookie, { id: projectId, name: 'Mobile capability checks' })).status).toBe(200);
  expect((await studio.request('POST', `/api/projects/${projectId}/files`, studio.a.cookie,
    { name: 'index.html', content: '<html><body><h1>Mobile preview</h1></body></html>' })).status).toBe(200);
  await page.goto(studio.origin);
  await page.locator('input[name="username"]').fill(studio.a.username);
  await page.locator('input[name="password"]').fill(studio.a.password);
  await page.getByRole('button', { name: 'Sign in', exact: true }).click();
  await expect(page.getByTestId('studio-account-trigger')).toBeVisible({ timeout: T.long });
  const noOverflow = async () => expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
  await noOverflow();
  await page.screenshot({ path: info.outputPath('s65-shell-390.png'), animations: 'disabled' });
  await page.getByTestId('home-new-project').click();
  const importFiles = page.getByTestId('import-browser-files');
  await importFiles.scrollIntoViewIfNeeded();
  await expect(importFiles).toBeEnabled();
  expect((await importFiles.boundingBox())!.height).toBeGreaterThanOrEqual(40);
  await noOverflow();
  await page.screenshot({ path: info.outputPath('s65-import-390.png'), animations: 'disabled' });

  await page.goto(`${studio.origin}/settings`);
  await page.getByTestId('studio-settings-nav-general').click({ timeout: T.long });
  await expect(page.getByTestId('studio-settings-pet')).toBeVisible({ timeout: T.long });
  const permissionReason = page.getByRole('status').filter({ hasText: 'Your browser will ask for notification permission' });
  await expect(permissionReason).toBeVisible();
  await permissionReason.scrollIntoViewIfNeeded();
  await noOverflow();
  await page.screenshot({ path: info.outputPath('s65-notifications-390.png'), animations: 'disabled' });
  await page.getByTestId('studio-settings-pet').scrollIntoViewIfNeeded();
  const petToggle = page.getByTestId('studio-settings-pet').locator('.pet-wake-controls button');
  const petBounds = (await petToggle.boundingBox())!;
  expect(petBounds.x + petBounds.width).toBeLessThanOrEqual(390);
  expect(petBounds.height).toBeGreaterThanOrEqual(40);
  await page.screenshot({ path: info.outputPath('s65-pet-390.png'), animations: 'disabled' });
  await page.getByTestId('studio-settings-nav-about').click();
  await expect(page.getByTestId('studio-about-clear-data')).toBeVisible();
  expect((await page.getByTestId('studio-about-clear-data').boundingBox())!.height).toBeGreaterThanOrEqual(40);
  await noOverflow();
  await page.screenshot({ path: info.outputPath('s65-about-390.png'), animations: 'disabled' });
  await page.getByTestId('studio-settings-nav-deploy').click();
  const deploySettings = page.getByTestId('studio-deploy-settings');
  await expect(deploySettings.getByText('Vercel')).toBeVisible();
  await noOverflow();
  await page.screenshot({ path: info.outputPath('s65-deploy-settings-390.png'), animations: 'disabled' });

  await page.goto(`${studio.origin}/projects/${projectId}/files/index.html`);
  await expect(page.getByTestId('studio-account-trigger')).toBeVisible({ timeout: T.long });
  await expect(page.getByRole('button', { name: 'Export', exact: true })).toBeVisible({ timeout: T.long });
  await noOverflow();
  await page.screenshot({ path: info.outputPath('s65-project-390.png'), animations: 'disabled' });
  await page.getByRole('button', { name: 'Export', exact: true }).click();
  await expect(page.locator('.chrome-unified-panel').getByRole('menuitem', { name: 'Export as standalone HTML' })).toBeVisible();
  await noOverflow();
  await page.screenshot({ path: info.outputPath('s65-export-390.png'), animations: 'disabled' });
});
