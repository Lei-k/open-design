import { createHash } from 'node:crypto';
import { closeSync, constants, mkdirSync, openSync, realpathSync } from 'node:fs';
import path from 'node:path';
import type Database from 'better-sqlite3';
import type { Express, Request, Response } from 'express';
import type { RunExecutionSource, StudioSynthesisAction, StudioSynthesisResult, StudioSynthesisState } from '@open-design/contracts';
import { getProject, getConversation } from '../db.js';
import { multiUserActorOf } from '../http/multiuser-gate.js';
import { sendApiError } from '../http/api-errors.js';
import { ProjectAccessStore } from '../storage/project-access.js';
import { StudioSynthesisStore } from '../storage/studio-synthesis.js';
import { StudioCatalogGrants } from '../storage/studio-catalog-grants.js';
import { StudioSynthesisError, type StudioSynthesisPool, type StudioSynthesisLease } from '../services/studio-synthesis.js';
import { captureStudioProject, captureStudioResource } from '../projects/studio-snapshot.js';
import { projectDir } from '../projects.js';
import { writeCompanyProjectDocument } from '../services/company-project-files.js';
import { exportProjectTranscript, TranscriptExportLockedError } from '../transcript-export.js';
import { finalizeDesignPackage, FinalizePackageLockedError } from '../design/finalize-design.js';
import { synthesizeHandoffPrompt, EmptyTranscriptError } from '../design/handoff-design.js';
import { knownSecrets, scrubKnownSecrets } from '../mcp-client/studio-untrusted.js';
import type { AuthActor } from '../services/auth-service.js';
import type { StudioDesignCatalog } from './studio-design-catalog.js';

export interface RegisterStudioSynthesisRoutesDeps {
  db: Database.Database;
  projectsRoot: string;
  designSystemsRoot: string;
  pool: StudioSynthesisPool;
  sessionCurrent(actor: AuthActor): boolean;
  accountActive(id: string): boolean;
  designCatalog?: StudioDesignCatalog;
  /** Same programmatic mock transport as ordinary OpenAI turns. */
  fetch?: typeof fetch;
}
const sources: RunExecutionSource[] = ['personal_subscription', 'company_pool', 'personal_api_key'];
export function registerStudioSynthesisRoutes(app: Express, deps: RegisterStudioSynthesisRoutesDeps): void {
  const store = new StudioSynthesisStore(deps.db);
  const access = new ProjectAccessStore(deps.db, { accountActive: deps.accountActive });
  const designGrants = new StudioCatalogGrants(deps.db, { accountActive: deps.accountActive });
  const notFound = (res: Response) => sendApiError(res, 404, 'NOT_FOUND', 'not found');
  const target = (req: Request, res: Response, write: boolean) => {
    const actor = multiUserActorOf(res);
    const id = String(req.params.id ?? '');
    if (!actor || !getProject(deps.db, id) || !(write ? access.canWrite(id, actor.accountId) : access.canView(id, actor.accountId))) {
      notFound(res); return null;
    }
    return { actor, id };
  };
  const authority = (actor: AuthActor, id: string) => {
    if (!deps.sessionCurrent(actor) || !deps.accountActive(actor.accountId) || !access.canWrite(id, actor.accountId) || !getProject(deps.db, id))
      throw new StudioSynthesisError(409, 'MULTIUSER_SYNTHESIS_AUTHORITY_CHANGED');
  };
  const capture = (id: string) => {
    try {
      const files = captureStudioProject(deps.projectsRoot, id);
      const hash = createHash('sha256');
      for (const file of [...files].sort((a, b) => a.name < b.name ? -1 : a.name > b.name ? 1 : 0))
        hash.update(JSON.stringify([file.name, file.bytes.length])).update(file.bytes);
      const conversations = deps.db.prepare('SELECT id,title,session_mode FROM conversations WHERE project_id = ? ORDER BY id').all(id) as Array<{ id: string }>;
      hash.update(JSON.stringify(conversations));
      for (const conversation of conversations) hash.update(JSON.stringify(deps.db.prepare(`SELECT id,role,content,events_json,attachments_json,comment_attachments_json,position
        FROM messages WHERE conversation_id = ? ORDER BY position,id`).all(conversation.id)));
      const project = getProject(deps.db, id)!;
      const activeArtifact = (deps.db.prepare('SELECT name FROM tabs WHERE project_id = ? AND is_active = 1 LIMIT 1').get(id) as { name: string } | undefined)?.name ?? null;
      hash.update(JSON.stringify([project.designSystemId, project.metadata]));
      hash.update(JSON.stringify(activeArtifact));
      if (project.designSystemId?.startsWith('user:')) {
        hash.update(JSON.stringify(deps.db.prepare('SELECT document_json,revision,deleted_at FROM studio_design_systems WHERE id = ?').get(project.designSystemId) ?? null));
      } else if (project.designSystemId) {
        for (const file of captureStudioResource(deps.designSystemsRoot, path.join(deps.designSystemsRoot, project.designSystemId)))
          hash.update(JSON.stringify([file.name, file.bytes.length])).update(file.bytes);
      }
      return { files, activeArtifact, digest: hash.digest('hex') };
    } catch { throw new StudioSynthesisError(409, 'MULTIUSER_SYNTHESIS_CAPTURE_REFUSED'); }
  };
  const defaultSource = (accountId: string, id: string): RunExecutionSource | null => {
    // A shared editor never inherits another actor's credential pin.
    const row = deps.db.prepare(`SELECT execution_source,request_json FROM multiuser_runs
      WHERE owner_account_id = ? AND project_id = ? ORDER BY queue_seq DESC,created_at DESC LIMIT 1`)
      .get(accountId, id) as { execution_source: RunExecutionSource; request_json: string | null } | undefined;
    if (!row || !sources.includes(row.execution_source)) return null;
    if (row.execution_source === 'company_pool') {
      try { if (JSON.parse(row.request_json ?? '{}').companyProvider !== 'openai') return null; } catch { return null; }
    }
    return row.execution_source;
  };
  const failure = (res: Response, error: unknown) => {
    if (error instanceof StudioSynthesisError) return sendApiError(res, error.status, error.code, 'Studio synthesis could not complete.',
      error.reason ? { details: { capability: 'deploy-synthesis', reason: error.reason } } : {});
    if (error instanceof FinalizePackageLockedError || error instanceof TranscriptExportLockedError)
      return sendApiError(res, 409, 'CONFLICT', 'Project synthesis is busy.');
    if (error instanceof EmptyTranscriptError) return sendApiError(res, 400, 'EMPTY_TRANSCRIPT', 'The conversation has no messages.');
    // No provider text, paths or native errors are reflected or logged.
    return sendApiError(res, 502, 'MULTIUSER_SYNTHESIS_PROVIDER_FAILED', 'The synthesis provider did not complete the request.');
  };
  const base = '/api/multiuser/projects/:id';
  const readState = (req: Request, res: Response) => {
    const found = target(req, res, false); if (!found) return;
    try {
      const captured = capture(found.id);
      const canEdit = access.canWrite(found.id, found.actor.accountId);
      const state: StudioSynthesisState = { digest: captured.digest, defaultSource: defaultSource(found.actor.accountId, found.id),
        sources: sources.map((source) => canEdit ? deps.pool.synthesisSource(found.actor.accountId, source)
          : { executionSource: source, available: false, reason: 'project-read-only' }), results: store.results(found.id, captured.digest) };
      res.setHeader('Cache-Control', 'no-store'); res.json(state);
    } catch (error) { failure(res, error); }
  };
  app.get(`${base}/synthesis`, readState);
  app.get('/api/projects/:id/synthesis', readState);
  const run = async (req: Request, res: Response, action: StudioSynthesisAction) => {
    const found = target(req, res, true); if (!found) return;
    let lease: StudioSynthesisLease | undefined;
    let directory: number | undefined;
    let jobId: string | undefined;
    let timer: NodeJS.Timeout | undefined;
    const abort = new AbortController();
    const disconnect = () => abort.abort();
    res.on('close', disconnect);
    try {
      authority(found.actor, found.id);
      const body = req.body ?? {};
      if (Array.isArray(body) || typeof body !== 'object' || Object.keys(body).some((key) =>
        !['executionSource','maxTokens','digest', ...(action === 'handoff' ? ['conversationId'] : [])].includes(key))
        || body.executionSource !== undefined && !sources.includes(body.executionSource)
        || body.maxTokens !== undefined && (!Number.isSafeInteger(body.maxTokens) || body.maxTokens < 1 || body.maxTokens > 16384)
        || body.digest !== undefined && (typeof body.digest !== 'string' || !/^[a-f0-9]{64}$/.test(body.digest)))
        return sendApiError(res, 400, 'BAD_REQUEST', 'Invalid Studio synthesis request.');
      if (action === 'finalize' && req.params.provider !== 'openai')
        throw new StudioSynthesisError(409, 'MULTIUSER_CAPABILITY_UNAVAILABLE', 'provider-disabled');
      const conversation = action === 'handoff' && typeof body.conversationId === 'string' ? getConversation(deps.db, body.conversationId) : null;
      if (action === 'handoff' && (!conversation || conversation.projectId !== found.id)) return notFound(res);
      const source: RunExecutionSource | null = body.executionSource ?? defaultSource(found.actor.accountId, found.id);
      if (!source) throw new StudioSynthesisError(409, 'MULTIUSER_CAPABILITY_UNAVAILABLE', 'source-required');
      if (source === 'personal_subscription') throw new StudioSynthesisError(409, 'MULTIUSER_CAPABILITY_UNAVAILABLE', 'personal-codex');
      const sourceState = deps.pool.synthesisSource(found.actor.accountId, source);
      if (!sourceState.available) throw new StudioSynthesisError(sourceState.reason === 'quota-exhausted' ? 429 : 403,
        sourceState.reason === 'quota-exhausted' ? 'MULTIUSER_QUOTA_EXHAUSTED' : 'MULTIUSER_CAPABILITY_UNAVAILABLE', sourceState.reason ?? undefined);
      const captured = capture(found.id);
      if (body.digest && body.digest !== captured.digest) throw new StudioSynthesisError(409, 'MULTIUSER_SYNTHESIS_STALE');
      const expected = projectDir(deps.projectsRoot, found.id);
      mkdirSync(expected, { recursive: true });
      directory = openSync(expected, constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW);
      const heldDirectory = `/proc/self/fd/${directory}`;
      const designId = getProject(deps.db, found.id)?.designSystemId;
      const check = () => {
        abort.signal.throwIfAborted(); authority(found.actor, found.id);
        if (realpathSync(heldDirectory) !== expected) throw new StudioSynthesisError(409, 'MULTIUSER_SYNTHESIS_AUTHORITY_CHANGED');
        if (action === 'handoff' && getConversation(deps.db, body.conversationId)?.projectId !== found.id)
          throw new StudioSynthesisError(409, 'MULTIUSER_SYNTHESIS_AUTHORITY_CHANGED');
        if (designId?.startsWith('user:') && !designGrants.roleOf('design-system', designId, found.actor.accountId))
          throw new StudioSynthesisError(409, 'MULTIUSER_SYNTHESIS_AUTHORITY_CHANGED');
      };
      const transcriptResult = exportProjectTranscript(deps.db, deps.projectsRoot, found.id, {
        directory: heldDirectory, captureOnly: true, ...(action === 'handoff' ? { conversationId: body.conversationId } : {}),
      });
      if (action === 'handoff' && transcriptResult.messageCount === 0) throw new EmptyTranscriptError('empty');
      const transcript = { jsonl: transcriptResult.jsonl!, messageCount: transcriptResult.messageCount };
      const design = designId ? await deps.designCatalog?.readSystem(found.actor.accountId, designId) : null;
      if (designId && !design) throw new StudioSynthesisError(409, 'MULTIUSER_SYNTHESIS_CAPTURE_REFUSED');
      check();
      if (capture(found.id).digest !== captured.digest) throw new StudioSynthesisError(409, 'MULTIUSER_SYNTHESIS_STALE');
      lease = deps.pool.beginSynthesis(found.actor.accountId, found.id, source, check);
      timer = setTimeout(() => abort.abort(), 120_000);
      const signal = AbortSignal.any([abort.signal, lease.signal]);
      const secrets = knownSecrets([lease.apiKey]);
      const boundedFetch: typeof fetch = async (url, init) => {
        lease!.check(); signal.throwIfAborted();
        if (String(url) !== 'https://api.openai.com/v1/chat/completions') throw new StudioSynthesisError(502, 'MULTIUSER_SYNTHESIS_PROVIDER_FAILED');
        const response = await (deps.fetch ?? globalThis.fetch)(url, { ...init, signal, redirect: 'error' });
        lease!.check(); signal.throwIfAborted();
        const reader = response.body?.getReader();
        const chunks: Uint8Array[] = []; let bytes = 0;
        try { if (reader) for (;;) {
          const chunk = await reader.read(); lease!.check(); signal.throwIfAborted();
          if (chunk.done) break;
          bytes += chunk.value.byteLength;
          if (bytes > 2 * 1024 * 1024) throw new StudioSynthesisError(502, 'MULTIUSER_SYNTHESIS_PROVIDER_FAILED');
          chunks.push(chunk.value);
        } } finally { await reader?.cancel().catch(() => {}); }
        return new Response(Buffer.concat(chunks), { status: response.status, headers: { 'content-type': 'application/json' } });
      };
      jobId = lease.id;
      store.start({ id: jobId, projectId: found.id, accountId: found.actor.accountId, action, executionSource: source, model: lease.model });
      let result: StudioSynthesisResult | undefined;
      const commit = (text: string, usage: { inputTokens: number; outputTokens: number }) => {
        const inputTokens = Number.isSafeInteger(usage.inputTokens) && usage.inputTokens >= 0 ? usage.inputTokens : 0;
        const outputTokens = Number.isSafeInteger(usage.outputTokens) && usage.outputTokens >= 0 ? usage.outputTokens : 0;
        store.usage(jobId!, inputTokens, outputTokens);
        lease!.check(); signal.throwIfAborted();
        if (capture(found.id).digest !== captured.digest) throw new StudioSynthesisError(409, 'MULTIUSER_SYNTHESIS_STALE');
        const safeText = scrubKnownSecrets(text, secrets);
        const fileName = action === 'finalize' ? 'DESIGN.md' : 'HANDOFF.md';
        writeCompanyProjectDocument(deps.projectsRoot, found.id, fileName, safeText);
        lease!.check();
        result = { id: jobId!, projectId: found.id, action, conversationId: conversation?.id ?? null, executionSource: source,
          fileName, digest: capture(found.id).digest, current: true, createdAt: Date.now(), model: lease!.model,
          inputTokens, outputTokens, transcriptMessageCount: transcript.messageCount };
        store.settle(jobId!, result);
        if (action === 'handoff') result = { ...result, prompt: safeText };
      };
      const options = { apiKey: lease.apiKey, baseUrl: 'https://api.openai.com', model: lease.model,
        maxTokens: body.maxTokens, signal, fetchImpl: boundedFetch };
      if (action === 'finalize') {
        const artifact = captured.files.find((file) => file.name === captured.activeArtifact)
          ?? captured.files.find((file) => file.name.endsWith('.html'));
        await finalizeDesignPackage(deps.db, deps.projectsRoot, deps.designSystemsRoot, found.id, { ...options, protocol: 'openai',
          studio: { directory: heldDirectory, transcript, designSystemBody: design?.body ?? null,
            artifact: artifact ? { name: artifact.name, body: artifact.bytes.toString('utf8').slice(0, 128 * 1024), manifest: null } : null, commit } });
      } else {
        const handoff = await synthesizeHandoffPrompt(deps.db, deps.projectsRoot, found.id, { ...options, protocol: 'openai',
          conversationId: body.conversationId, studioTranscript: transcript });
        commit(handoff.prompt, handoff);
      }
      res.setHeader('Cache-Control', 'no-store'); res.json(result);
    } catch (error) {
      if (jobId) store.settle(jobId);
      try { lease?.check(); } catch (lost) { error = lost; }
      failure(res, error);
    } finally {
      if (timer) clearTimeout(timer);
      res.off('close', disconnect); lease?.finish();
      if (directory !== undefined) closeSync(directory);
    }
  };
  app.post(`${base}/finalize/:provider`, (req, res) => run(req, res, 'finalize'));
  app.post(`${base}/handoff`, (req, res) => run(req, res, 'handoff'));
}
