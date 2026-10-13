import { execFileSync } from 'node:child_process';
import type { Dir, Dirent } from 'node:fs';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// Deterministic fault injection (#119 review F3/F4): fail the Nth realpath of
// a held descriptor, and walk directories in name order. Everything else is
// the real filesystem.
const hooks = vi.hoisted(() => ({ failHeldRealpathAt: 0, heldRealpathCalls: 0, sortedDirs: false }));
vi.mock('node:fs', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs')>();
  const realpathSync = Object.assign((target: Parameters<typeof actual.realpathSync>[0], options?: Parameters<typeof actual.realpathSync>[1]) => {
    if (hooks.failHeldRealpathAt > 0 && String(target).startsWith('/proc/self/fd/')
      && ++hooks.heldRealpathCalls === hooks.failHeldRealpathAt) {
      throw Object.assign(new Error(`ENOENT: no such file or directory, realpath '${String(target)}'`), { code: 'ENOENT' });
    }
    return actual.realpathSync(target, options as never);
  }, { native: actual.realpathSync.native });
  const opendirSync = (target: Parameters<typeof actual.opendirSync>[0], options?: Parameters<typeof actual.opendirSync>[1]): Dir => {
    const dir = actual.opendirSync(target, options);
    if (!hooks.sortedDirs) return dir;
    const entries: Dirent[] = [];
    for (let entry = dir.readSync(); entry; entry = dir.readSync()) entries.push(entry);
    dir.closeSync();
    entries.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
    return { readSync: () => entries.shift() ?? null, closeSync: () => undefined } as unknown as Dir;
  };
  return { ...actual, realpathSync, opendirSync };
});

const { linkSync, mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } = await import('node:fs');
const path = (await import('node:path')).default;
const { tmpdir } = await import('node:os');
const { STUDIO_SNAPSHOT_LIMITS, StudioCaptureRefusal, captureStudioProject, openStudioProjectSelection } =
  await import('../../src/projects/studio-snapshot.js');

let projectsRoot: string;
const project = (name: string) => path.join(projectsRoot, 'p1', ...name.split('/'));
const plant = (name: string, bytes: string) => { mkdirSync(path.dirname(project(name)), { recursive: true }); writeFileSync(project(name), bytes); };
const selection = () => openStudioProjectSelection(projectsRoot, 'p1', { fileBytes: STUDIO_SNAPSHOT_LIMITS.fileBytes, bytes: 32 * 1024 * 1024, depth: STUDIO_SNAPSHOT_LIMITS.depth });
const thrown = (run: () => unknown): unknown => { try { run(); } catch (error) { return error; } throw new Error('expected a throw'); };

beforeEach(() => {
  projectsRoot = realpathSync(mkdtempSync(path.join(tmpdir(), 'od-studio-snapshot-')));
  Object.assign(hooks, { failHeldRealpathAt: 0, heldRealpathCalls: 0, sortedDirs: false });
  plant('site/index.html', '<p>entry</p>');
});
afterEach(() => { Object.assign(hooks, { failHeldRealpathAt: 0, sortedDirs: false }); rmSync(projectsRoot, { recursive: true, force: true }); });

describe('selected-file capture', () => {
  it('treats filesystem-impossible and missing paths as unavailable (F2)', () => {
    const selected = selection();
    try {
      expect(selected.read(`site/${'a'.repeat(256)}.png`)).toBeNull(); // ENAMETOOLONG
      expect(selected.read('site/index.html/inner.png')).toBeNull(); // under a file
      expect(selected.read(`${'d/'.repeat(40)}x.png`)).toBeNull(); // deeper than the capture, but missing
      expect(selected.read('site/index.html')?.toString()).toBe('<p>entry</p>');
    } finally { selected.close(); }
  });

  it('still refuses an existing path deeper than the project capture walks', () => {
    plant(`${'d/'.repeat(STUDIO_SNAPSHOT_LIMITS.depth + 1)}x.png`, 'deep');
    const selected = selection();
    try {
      expect(thrown(() => selected.read(`${'d/'.repeat(STUDIO_SNAPSHOT_LIMITS.depth + 1)}x.png`)))
        .toMatchObject({ name: 'StudioCaptureRefusal', reason: 'invalid_path' });
    } finally { selected.close(); }
  });

  // Held-descriptor realpath calls during read('site/index.html'): 1 = the
  // opened `site` directory, 2 = the parent re-check after reading, 3 = the
  // file itself. Each failure is a typed change for that path (F3).
  it.each([[1, 'site'], [2, 'site/index.html'], [3, 'site/index.html']])(
    'turns a lost descriptor path at held-realpath call %i into a "changed" refusal for %s', (call, refusedPath) => {
      const selected = selection();
      try {
        hooks.failHeldRealpathAt = call;
        const error = thrown(() => selected.read('site/index.html'));
        expect(error).toBeInstanceOf(StudioCaptureRefusal);
        expect(error).toMatchObject({ path: refusedPath, reason: 'changed' });
        expect(hooks.heldRealpathCalls).toBe(call);
      } finally { selected.close(); }
    });
});

describe('whole-project capture keeps its original errors (F4)', () => {
  const fill = () => { for (let index = 0; index < STUDIO_SNAPSHOT_LIMITS.files - 1; index++) plant(`a/${String(index).padStart(3, '0')}.txt`, 'x'); };

  it.each(['hard link', 'fifo'])('refuses a %s after the file limit as "Project file refused", a plain Error', (kind) => {
    fill(); // with site/index.html: exactly 500 regular files before `z`
    if (kind === 'hard link') { writeFileSync(path.join(projectsRoot, 'twin'), 'x'); linkSync(path.join(projectsRoot, 'twin'), project('z')); }
    else execFileSync('mkfifo', [project('z')]);
    hooks.sortedDirs = true;
    const error = thrown(() => captureStudioProject(projectsRoot, 'p1'));
    expect(error).toBeInstanceOf(Error);
    expect((error as Error).constructor).toBe(Error);
    expect((error as Error).message).toBe('Project file refused');
  });

  it('still reports the file limit for a regular file after it', () => {
    fill(); plant('z', 'x');
    hooks.sortedDirs = true;
    const error = thrown(() => captureStudioProject(projectsRoot, 'p1')) as Error;
    expect([error.constructor, error.message]).toEqual([Error, 'Project snapshot limit exceeded']);
  });

  it('lets a lost descriptor path escape as the raw filesystem error, as before', () => {
    hooks.failHeldRealpathAt = 1;
    const error = thrown(() => captureStudioProject(projectsRoot, 'p1'));
    expect(error).not.toBeInstanceOf(StudioCaptureRefusal);
    expect(error).toMatchObject({ code: 'ENOENT' });
  });
});
