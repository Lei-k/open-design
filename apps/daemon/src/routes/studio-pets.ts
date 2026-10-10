import { promises as fs } from 'node:fs';
import type { Express } from 'express';
import { listCodexPets, readCodexPetSpritesheet } from '../codex-pets.js';
import { multiUserActorOf } from '../http/multiuser-gate.js';
import { sendApiError } from '../http/api-errors.js';

/** Bundled sprite atlases are a few MiB; anything larger is not a shipped pet. */
const SPRITESHEET_MAX_BYTES = 8 * 1024 * 1024;

/**
 * In-page pet catalog for Studio accounts (#67). Only the pets bundled with
 * this build are listed and served: the host's `CODEX_HOME` pets and the
 * community sync (which writes there) belong to the machine owner, not to a
 * Web account. The adopted pet itself is an account preference (#62).
 */
export function registerStudioPetRoutes(app: Express, input: { bundledRoot: string }): void {
  app.get('/api/multiuser/catalog/codex-pets', async (_req, res) => {
    if (!multiUserActorOf(res)) return sendApiError(res, 401, 'UNAUTHORIZED', 'authentication required');
    try {
      const result = await listCodexPets({ baseUrl: '', bundledRoot: input.bundledRoot, userRoot: false });
      // Same-origin sprite URLs; the standard path rewrites to this catalog.
      res.set('Cache-Control', 'no-store').json({ pets: result.pets.map((pet) => ({ ...pet, bundled: true })), rootDir: '' });
    } catch {
      sendApiError(res, 500, 'INTERNAL_ERROR', 'pet catalog unavailable');
    }
  });
  app.get('/api/multiuser/catalog/codex-pets/:id/spritesheet', async (req, res) => {
    if (!multiUserActorOf(res)) return sendApiError(res, 401, 'UNAUTHORIZED', 'authentication required');
    try {
      const sheet = await readCodexPetSpritesheet(String(req.params.id), { bundledRoot: input.bundledRoot, userRoot: false });
      const stat = sheet ? await fs.lstat(sheet.absPath) : null;
      if (!sheet || !stat?.isFile() || stat.size > SPRITESHEET_MAX_BYTES) return sendApiError(res, 404, 'NOT_FOUND', 'pet not found');
      res.set({ 'Content-Type': sheet.ext === 'webp' ? 'image/webp' : sheet.ext === 'gif' ? 'image/gif' : 'image/png',
        'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff' });
      res.send(await fs.readFile(sheet.absPath));
    } catch {
      if (!res.headersSent) sendApiError(res, 404, 'NOT_FOUND', 'pet not found');
    }
  });
}
