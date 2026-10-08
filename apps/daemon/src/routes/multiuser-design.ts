import { createHash, randomBytes, randomUUID } from 'node:crypto';
import path from 'node:path';
import type Database from 'better-sqlite3';
import type { Express, Request, Response } from 'express';
import type {
  MultiUserDesignCatalogResponse,
  MultiUserDesignSelection,
  MultiUserDesignSelectionsResponse,
  MultiUserPreviewRenewResponse,
  MultiUserPreviewUrlResponse,
} from '@open-design/contracts';
import { getConversation, getProject, insertConversation } from '../db.js';
import { sendApiError } from '../http/api-errors.js';
import { multiUserActorOf } from '../http/multiuser-gate.js';
import { composeSystemPrompt } from '../prompts/system.js';
import { listFiles, openProjectReadStreamNoFollow, resolveProjectDir, resolveProjectFilePath } from '../projects.js';
import { AuthStore } from '../storage/auth-store.js';
import { ProjectOwnershipStore } from '../storage/project-ownership.js';
import type { SkillInfo } from '../skills.js';
import type { DesignSystemSummary } from '../design-systems/index.js';

const PREVIEW_TTL_MS = 5 * 60_000;
const MAX_PREVIEW_CAPABILITIES_PER_OWNER = 64;
const PREVIEW_SCOPE_RE = /^[A-Za-z0-9_-]{32,128}$/u;
const EXECUTABLE_MIME_RE = /^(?:text\/(?:html|javascript|xml)|image\/svg\+xml|application\/(?:xhtml\+xml|javascript|xml|pdf))/iu;
const PREVIEW_CSP = [
  'sandbox allow-scripts allow-forms',
  "default-src 'self' data: blob:",
  "img-src 'self' data: blob:",
  "media-src 'self' data: blob:",
  "font-src 'self' data:",
  "style-src 'self' 'unsafe-inline'",
  "script-src 'self' 'unsafe-inline' 'unsafe-eval'",
  "connect-src 'none'",
  "form-action 'none'",
  "base-uri 'none'",
  "object-src 'none'",
].join('; ');

type SelectionRow = {
  conversation_id: string;
  owner_account_id: string;
  skill_id: string;
  design_system_id: string;
  locale: string;
};

type PreviewCapability = {
  projectId: string;
  ownerAccountId: string;
  sessionId: string;
  expiresAt: number;
};

function encodedPath(value: string): string {
  return value.split('/').map(encodeURIComponent).join('/');
}

function splatPath(req: Request): string | null {
  const raw = req.params.path ?? req.params.splat;
  const value = Array.isArray(raw) ? raw.join('/') : raw;
  if (typeof value !== 'string' || !value || value.includes('\0') || path.isAbsolute(value)) return null;
  const normalized = value.replaceAll('\\', '/');
  if (normalized.split('/').some((part) => part === '..' || part === '')) return null;
  return normalized;
}

function safeDispositionName(value: string): string {
  return path.basename(value).replace(/[\r\n"\\]/gu, '_') || 'download';
}

function setPrivateFileHeaders(res: Response): void {
  res.setHeader('Cache-Control', 'no-store');
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.removeHeader('Access-Control-Allow-Origin');
}

function setPreviewHeaders(res: Response): void {
  setPrivateFileHeaders(res);
  // The Studio viewer's opaque srcDoc frame loads fonts and fetches relative
  // assets from here; the bytes are already readable by any holder of this
  // bearer URL, and no credentials are ever honored on the preview origin.
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Content-Security-Policy', PREVIEW_CSP);
  res.setHeader('Referrer-Policy', 'no-referrer');
}

export interface MultiUserDesignCapture {
  skill: { id: string; name: string; body: string; mode?: Parameters<typeof composeSystemPrompt>[0]['skillMode'] };
  design: { id: string } & Pick<Parameters<typeof composeSystemPrompt>[0],
    'designSystemBody' | 'designSystemTitle' | 'designSystemUsageMd' | 'designSystemTokensCss' |
    'designSystemComponentsManifest' | 'designSystemFixtureHtml' | 'designSystemPullIndex' | 'designSystemImportMode'>;
}

export interface MultiUserDesignRoutes {
  selection(conversationId: string, ownerId: string): MultiUserDesignSelection | null;
  composeStablePrompt(input: {
    conversationId: string;
    ownerId: string;
    projectId: string;
    userInstructions?: string;
    memoryBody?: string;
    /** Conversation-captured revisions; the live bundled tree is never read. */
    captured: MultiUserDesignCapture;
  }): Promise<{ prompt: string; hash: string; selection: MultiUserDesignSelection } | null>;
  invalidateOwnerCapabilities(ownerId: string): void;
  close(): void;
}

export function registerMultiUserDesignRoutes(app: Express, input: {
  db: Database.Database;
  dataRoot: string;
  projectsRoot: string;
  previewOrigin: string;
  listBuiltInSkills: () => Promise<SkillInfo[]>;
  listBuiltInDesignSystems: () => Promise<DesignSystemSummary[]>;
  clock?: () => number;
}): MultiUserDesignRoutes {
  const { db, projectsRoot } = input;
  const owners = new ProjectOwnershipStore(db);
  const auth = AuthStore.open({ dataRoot: input.dataRoot });
  const now = input.clock ?? Date.now;
  const capabilities = new Map<string, PreviewCapability>();
  let closed = false;

  db.exec(`
    CREATE TABLE IF NOT EXISTS multiuser_design_selections (
      conversation_id TEXT PRIMARY KEY REFERENCES conversations(id) ON DELETE CASCADE,
      owner_account_id TEXT NOT NULL,
      skill_id TEXT NOT NULL,
      design_system_id TEXT NOT NULL,
      locale TEXT NOT NULL,
      created_at INTEGER NOT NULL
    );
    CREATE TRIGGER IF NOT EXISTS multiuser_design_selection_immutable
      BEFORE UPDATE ON multiuser_design_selections
      BEGIN SELECT RAISE(ABORT, 'multi-user design selection is immutable'); END;
  `);

  const actorId = (res: Response) => multiUserActorOf(res)?.accountId ?? '';
  const selection = (conversationId: string, ownerId: string): MultiUserDesignSelection | null => {
    const row = db.prepare('SELECT * FROM multiuser_design_selections WHERE conversation_id = ? AND owner_account_id = ?')
      .get(conversationId, ownerId) as SelectionRow | undefined;
    return row ? {
      conversationId: row.conversation_id,
      skillId: row.skill_id,
      designSystemId: row.design_system_id,
      locale: row.locale,
    } : null;
  };

  const catalog = async (): Promise<MultiUserDesignCatalogResponse & {
    rawSkills: SkillInfo[];
    rawSystems: DesignSystemSummary[];
  }> => {
    const [rawSkills, rawSystems] = await Promise.all([
      input.listBuiltInSkills(),
      input.listBuiltInDesignSystems(),
    ]);
    return {
      rawSkills,
      rawSystems,
      skills: rawSkills.filter((skill) => skill.source === 'built-in').map((skill) => ({
        id: skill.id,
        name: skill.name,
        ...(skill.displayName ? { displayName: skill.displayName } : {}),
        description: skill.description,
        ...(skill.descriptionI18n ? { descriptionI18n: skill.descriptionI18n } : {}),
        mode: skill.mode,
        previewType: skill.previewType,
        designSystemRequired: skill.designSystemRequired,
      })),
      designSystems: rawSystems.filter((system) => system.source === 'built-in').map((system) => ({
        id: system.id,
        title: system.title,
        category: system.category,
        summary: system.summary,
        ...(system.swatches ? { swatches: system.swatches } : {}),
      })),
    };
  };

  app.get('/api/multiuser/design-catalog', async (_req, res) => {
    try {
      const { rawSkills: _rawSkills, rawSystems: _rawSystems, ...body } = await catalog();
      res.setHeader('Cache-Control', 'private, max-age=60');
      res.json(body);
    } catch (error) {
      sendApiError(res, 500, 'INTERNAL_ERROR', error instanceof Error ? error.message : String(error));
    }
  });

  app.post('/api/multiuser/projects/:id/conversations', async (req, res) => {
    const ownerId = actorId(res);
    const project = getProject(db, req.params.id);
    if (!project || !ownerId || !owners.isOwnedBy(project.id, ownerId)) {
      return sendApiError(res, 404, 'PROJECT_NOT_FOUND', 'not found');
    }
    const body = req.body as Record<string, unknown> | null;
    if (!body || typeof body !== 'object' || Array.isArray(body)
        || Object.keys(body).some((key) => !['title', 'skillId', 'designSystemId', 'locale'].includes(key))) {
      return sendApiError(res, 400, 'BAD_REQUEST', 'invalid design conversation request');
    }
    const skillId = typeof body.skillId === 'string' ? body.skillId : '';
    const designSystemId = typeof body.designSystemId === 'string' ? body.designSystemId : '';
    const locale = typeof body.locale === 'string' && /^[A-Za-z]{2,3}(?:-[A-Za-z0-9]{2,8})?$/u.test(body.locale)
      ? body.locale : 'en';
    const title = typeof body.title === 'string' ? body.title.trim().slice(0, 120) || null : null;
    const available = await catalog();
    if (!available.skills.some((skill) => skill.id === skillId)
        || !available.designSystems.some((system) => system.id === designSystemId)) {
      return sendApiError(res, 400, 'BAD_REQUEST', 'skillId and designSystemId must name built-in catalogue entries');
    }
    const createdAt = now();
    const conversationId = randomUUID();
    const conversation = db.transaction(() => {
      const next = insertConversation(db, {
        id: conversationId,
        projectId: project.id,
        title,
        sessionMode: 'design',
        createdAt,
        updatedAt: createdAt,
      });
      db.prepare(`INSERT INTO multiuser_design_selections
        (conversation_id, owner_account_id, skill_id, design_system_id, locale, created_at)
        VALUES (?, ?, ?, ?, ?, ?)`).run(conversationId, ownerId, skillId, designSystemId, locale, createdAt);
      return next;
    })();
    res.status(201).json({ conversation, design: selection(conversationId, ownerId)! });
  });

  app.get('/api/multiuser/projects/:id/conversations/:cid/design', (req, res) => {
    const ownerId = actorId(res);
    const conversation = getConversation(db, req.params.cid);
    const design = selection(req.params.cid, ownerId);
    if (!conversation || conversation.projectId !== req.params.id || !design) {
      return sendApiError(res, 404, 'NOT_FOUND', 'not found');
    }
    res.json({ design });
  });

  app.get('/api/multiuser/projects/:id/design-selections', (req, res) => {
    const ownerId = actorId(res);
    const response: MultiUserDesignSelectionsResponse = {
      designs: (db.prepare(`SELECT s.* FROM multiuser_design_selections s
        JOIN conversations c ON c.id = s.conversation_id
        WHERE c.project_id = ? AND s.owner_account_id = ? ORDER BY s.created_at, s.conversation_id`)
        .all(req.params.id, ownerId) as SelectionRow[]).map((row) => ({
        conversationId: row.conversation_id,
        skillId: row.skill_id,
        designSystemId: row.design_system_id,
        locale: row.locale,
      })),
    };
    res.json(response);
  });

  app.get('/api/projects/:id/file-content/*path', async (req, res) => {
    const relativePath = splatPath(req);
    const project = getProject(db, req.params.id);
    if (!relativePath || !project) return sendApiError(res, 404, 'FILE_NOT_FOUND', 'not found');
    try {
      const meta = await resolveProjectFilePath(projectsRoot, project.id, relativePath, project.metadata);
      setPrivateFileHeaders(res);
      const forcedDownload = req.query.download === '1' || EXECUTABLE_MIME_RE.test(meta.mime);
      res.setHeader('Content-Type', forcedDownload ? 'application/octet-stream' : meta.mime);
      res.setHeader('Content-Disposition', `${forcedDownload ? 'attachment' : 'inline'}; filename="${safeDispositionName(meta.name)}"`);
      const stream = await openProjectReadStreamNoFollow(resolveProjectDir(projectsRoot, project.id, project.metadata), meta.filePath);
      stream.on('error', () => res.destroy()).pipe(res);
    } catch {
      if (res.headersSent) return void res.destroy();
      sendApiError(res, 404, 'FILE_NOT_FOUND', 'not found');
    }
  });

  app.get('/api/multiuser/projects/:id/preview-url', async (req, res) => {
    const ownerId = actorId(res);
    const actor = multiUserActorOf(res);
    const project = getProject(db, req.params.id);
    const file = typeof req.query.file === 'string' ? req.query.file : '';
    if (!actor || !project || !owners.isOwnedBy(project.id, ownerId) || !file) {
      return sendApiError(res, 404, 'NOT_FOUND', 'not found');
    }
    try {
      const meta = await resolveProjectFilePath(projectsRoot, project.id, file, project.metadata);
      const requestedAt = now();
      for (const [existingScope, capability] of capabilities) {
        if (capability.expiresAt <= requestedAt) capabilities.delete(existingScope);
      }
      const ownerScopes = [...capabilities.entries()]
        .filter(([, capability]) => capability.ownerAccountId === ownerId)
        .sort((left, right) => left[1].expiresAt - right[1].expiresAt);
      while (ownerScopes.length >= MAX_PREVIEW_CAPABILITIES_PER_OWNER) {
        const oldest = ownerScopes.shift();
        if (oldest) capabilities.delete(oldest[0]);
      }
      const scope = randomBytes(32).toString('base64url');
      const expiresAt = Math.min(requestedAt + PREVIEW_TTL_MS, actor.sessionExpiresAt);
      capabilities.set(scope, { projectId: project.id, ownerAccountId: ownerId, sessionId: actor.sessionId, expiresAt });
      const response: MultiUserPreviewUrlResponse = {
        url: `${input.previewOrigin}/api/multiuser/projects/${encodeURIComponent(project.id)}/preview/${scope}/${encodedPath(meta.name)}`,
        renewUrl: `/api/multiuser/projects/${encodeURIComponent(project.id)}/preview/${scope}/renew`,
        expiresAt, file: meta.name, csp: PREVIEW_CSP, iframeSandbox: 'allow-scripts allow-forms', opaqueOrigin: true,
      };
      res.setHeader('Cache-Control', 'no-store');
      res.json(response);
    } catch {
      sendApiError(res, 404, 'NOT_FOUND', 'not found');
    }
  });

  app.post('/api/multiuser/projects/:id/preview/:scope/renew', (req, res) => {
    const ownerId = actorId(res);
    const actor = multiUserActorOf(res);
    const scope = String(req.params.scope ?? '');
    const capability = PREVIEW_SCOPE_RE.test(scope) ? capabilities.get(scope) : undefined;
    const requestedAt = now();
    // A non-x-od header keeps this host-only: an opaque-origin preview would
    // require a CORS preflight, and neither origin grants it CORS access.
    if (req.get('preview-scope-renewal') !== '1') {
      return sendApiError(res, 403, 'FORBIDDEN', 'preview scope renewal requires host authorization');
    }
    if (!actor || !capability || capability.projectId !== req.params.id
        || capability.ownerAccountId !== ownerId || capability.sessionId !== actor.sessionId
        || capability.expiresAt <= requestedAt || !owners.isOwnedBy(capability.projectId, ownerId)) {
      if (capability?.expiresAt !== undefined && capability.expiresAt <= requestedAt) capabilities.delete(scope);
      return sendApiError(res, 404, 'NOT_FOUND', 'not found');
    }
    const expiresAt = Math.min(requestedAt + PREVIEW_TTL_MS, actor.sessionExpiresAt);
    if (expiresAt <= requestedAt) {
      capabilities.delete(scope);
      return sendApiError(res, 404, 'NOT_FOUND', 'not found');
    }
    capability.expiresAt = expiresAt;
    const response: MultiUserPreviewRenewResponse = { expiresAt };
    res.setHeader('Cache-Control', 'no-store');
    res.json(response);
  });

  app.get('/api/multiuser/projects/:id/preview/:scope/*path', async (req, res) => {
    const relativePath = splatPath(req);
    const scope = String(req.params.scope ?? '');
    const capability = PREVIEW_SCOPE_RE.test(scope) ? capabilities.get(scope) : undefined;
    if (!relativePath || !capability || capability.projectId !== req.params.id || capability.expiresAt <= now()) {
      if (capability?.expiresAt && capability.expiresAt <= now()) capabilities.delete(scope);
      return sendApiError(res, 404, 'NOT_FOUND', 'not found');
    }
    const session = auth.getSessionById(capability.sessionId);
    const account = auth.getAccountById(capability.ownerAccountId);
    if (!session || session.accountId !== capability.ownerAccountId || session.expiresAt <= now()
        || !account?.active || account.passwordState !== 'set' || !owners.isOwnedBy(capability.projectId, capability.ownerAccountId)) {
      capabilities.delete(scope);
      return sendApiError(res, 404, 'NOT_FOUND', 'not found');
    }
    const project = getProject(db, capability.projectId);
    if (!project) return sendApiError(res, 404, 'NOT_FOUND', 'not found');
    try {
      const meta = await resolveProjectFilePath(projectsRoot, project.id, relativePath, project.metadata);
      const stream = await openProjectReadStreamNoFollow(resolveProjectDir(projectsRoot, project.id, project.metadata), meta.filePath);
      setPreviewHeaders(res);
      res.setHeader('Content-Type', meta.mime);
      stream.on('error', () => res.destroy()).pipe(res);
    } catch {
      if (res.headersSent) return void res.destroy();
      sendApiError(res, 404, 'NOT_FOUND', 'not found');
    }
  });

  return {
    selection,
    async composeStablePrompt({ conversationId, ownerId, projectId, userInstructions, memoryBody, captured }) {
      const design = selection(conversationId, ownerId);
      const project = getProject(db, projectId);
      if (!design || !project || !owners.isOwnedBy(projectId, ownerId)) return null;
      if (captured.skill.id !== design.skillId || captured.design.id !== design.designSystemId || !captured.design.designSystemBody) return null;
      const { id: _designId, ...designPrompt } = captured.design;
      const prompt = composeSystemPrompt({
        agentId: 'codex',
        streamFormat: 'json-event-stream',
        executionProfile: 'filesystem',
        promptCoreVariant: 'slim',
        sessionMode: 'design',
        locale: design.locale,
        metadata: project.metadata,
        skillBody: captured.skill.body,
        skillName: captured.skill.name,
        skillMode: captured.skill.mode,
        ...designPrompt,
        memoryBody,
        userInstructions,
        pluginBlock: undefined,
      });
      return { prompt, hash: createHash('sha256').update(prompt).digest('hex'), selection: design };
    },
    invalidateOwnerCapabilities(ownerId) {
      for (const [scope, capability] of capabilities) {
        if (capability.ownerAccountId === ownerId) capabilities.delete(scope);
      }
    },
    close() {
      if (closed) return;
      closed = true;
      capabilities.clear();
      auth.close();
    },
  };
}
