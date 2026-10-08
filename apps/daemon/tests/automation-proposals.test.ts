import { promises as fsp } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import {
  applyAutomationProposal,
  createAutomationProposal,
  getAutomationProposal,
  listAutomationProposals,
  rejectAutomationProposal,
} from '../src/automation-proposals.js';
import { listAllAutomationTemplates } from '../src/automation-templates.js';
import { listDesignSystems } from '../src/design-systems/index.js';
import { readMemoryEntry, upsertMemoryEntry } from '../src/memory.js';
import { listSkills } from '../src/skills.js';

let dataDir = '';

/** Appends a proposal to the store as an older daemon would have saved it (no create-time checks). */
async function storeDirectly(input: Record<string, unknown> & { id: string }): Promise<{ id: string }> {
  const at = new Date().toISOString();
  const file = path.join(dataDir, 'automation-proposals', 'proposals.json');
  const current = await fsp.readFile(file, 'utf8').then((text) => JSON.parse(text).proposals as unknown[]).catch(() => []);
  await fsp.mkdir(path.dirname(file), { recursive: true });
  await fsp.writeFile(file, JSON.stringify({ proposals: [...current, { status: 'pending-review', reviewPolicy: 'always', createdAt: at, updatedAt: at,
    sourcePacketIds: [], ...input }] }));
  return { id: input.id };
}

beforeEach(async () => {
  dataDir = await fsp.mkdtemp(path.join(os.tmpdir(), 'od-automation-proposals-'));
});

afterEach(async () => {
  await fsp.rm(dataDir, { recursive: true, force: true });
});

describe('automation evolution proposals', () => {
  it('creates a reviewable memory proposal and applies it into the memory store', async () => {
    const proposal = await createAutomationProposal(dataDir, {
      id: 'proposal-memory-1',
      title: 'Project memory from connector digest',
      summary: 'Preserve a durable project decision found by an automation.',
      targetKind: 'memory-node',
      action: 'create',
      sourcePacketIds: ['packet-1'],
      patch: {
        format: 'json',
        after: JSON.stringify({
          name: 'Connector decision',
          description: 'Decision captured from connector activity',
          type: 'project',
          body: '- Decision: keep design-system extraction behind review.',
        }),
      },
      metadata: { memoryType: 'project' },
    });

    expect(proposal.status).toBe('pending-review');

    const applied = await applyAutomationProposal(dataDir, proposal.id);

    expect(applied.proposal.status).toBe('applied');
    expect(applied.result).toMatchObject({ action: 'create' });

    const memoryId = (applied.result as { memoryId: string }).memoryId;
    const entry = await readMemoryEntry(dataDir, memoryId);
    expect(entry).toMatchObject({
      name: 'Connector decision',
      type: 'project',
    });
    expect(entry?.body).toContain('keep design-system extraction behind review');
  });

  it('keeps a memory update bound to its targetRef and refuses a different embedded id before writing', async () => {
    for (const id of ['entry_a', 'entry_b']) {
      await upsertMemoryEntry(dataDir, { id, name: id, description: id, type: 'project', body: `${id} original body` }, {});
    }
    const original = { a: (await readMemoryEntry(dataDir, 'entry_a'))?.body, b: (await readMemoryEntry(dataDir, 'entry_b'))?.body };
    expect(original.a).toContain('entry_a original body');
    const mismatchedInput = {
      id: 'proposal-memory-mismatch', title: 'Update A', summary: 'Targets A', targetKind: 'memory-node' as const, action: 'update' as const,
      targetRef: 'entry_a', patch: { format: 'json' as const, after: JSON.stringify({ id: 'entry_b', body: 'replacement' }) },
    };
    // Refused when created, and refused at apply when such a proposal is already stored.
    await expect(createAutomationProposal(dataDir, mismatchedInput)).rejects.toThrow(/targetRef/);
    const mismatched = await storeDirectly(mismatchedInput);
    await expect(applyAutomationProposal(dataDir, mismatched.id)).rejects.toThrow(/targetRef/);
    expect((await readMemoryEntry(dataDir, 'entry_a'))?.body).toBe(original.a);
    expect((await readMemoryEntry(dataDir, 'entry_b'))?.body).toBe(original.b);
    expect((await listAutomationProposals(dataDir, { status: 'pending-review' })).map((item) => item.id)).toContain(mismatched.id);

    // Repeating the target's own id is fine: the write lands on targetRef.
    const bound = await createAutomationProposal(dataDir, {
      id: 'proposal-memory-bound', title: 'Update A', summary: 'Targets A', targetKind: 'memory-node', action: 'update',
      targetRef: 'entry_a', patch: { format: 'json', after: JSON.stringify({ id: 'entry_a', body: 'replacement' }) },
    });
    expect((await applyAutomationProposal(dataDir, bound.id)).result).toMatchObject({ memoryId: 'entry_a', action: 'update' });
    expect((await readMemoryEntry(dataDir, 'entry_a'))?.body).toContain('replacement');
    expect((await readMemoryEntry(dataDir, 'entry_b'))?.body).toBe(original.b);
  });

  it('keeps design-system and skill updates bound to a declared targetRef', async () => {
    for (const [kind, file] of [['design-system', 'design-systems/other/DESIGN.md'], ['skill', 'skills/other/SKILL.md']] as const) {
      await fsp.mkdir(path.dirname(path.join(dataDir, file)), { recursive: true });
      await fsp.writeFile(path.join(dataDir, file), 'ORIGINAL\n');
      const unbound = {
        id: `proposal-${kind}-unbound`, title: 'other', summary: 'Retarget by metadata', targetKind: kind, action: 'update' as const,
        targetRef: 'not-a-target-path', metadata: { slug: 'other' }, patch: { format: 'markdown' as const, after: '# Replaced\n' },
      };
      await expect(createAutomationProposal(dataDir, unbound)).rejects.toThrow(/targetRef/);
      const proposal = await storeDirectly(unbound);
      await expect(applyAutomationProposal(dataDir, proposal.id)).rejects.toThrow(/targetRef/);
      expect(await fsp.readFile(path.join(dataDir, file), 'utf8')).toBe('ORIGINAL\n');
    }
  });

  it('rejects a pending proposal without applying it', async () => {
    const proposal = await createAutomationProposal(dataDir, {
      id: 'proposal-reject-1',
      title: 'Unwanted memory',
      summary: 'This should stay review-only.',
      targetKind: 'memory-node',
      action: 'create',
      patch: {
        format: 'markdown',
        after: '- Avoid applying this proposal.',
      },
    });

    const rejected = await rejectAutomationProposal(dataDir, proposal.id, 'not durable');

    expect(rejected.status).toBe('rejected');
    expect(rejected.metadata).toMatchObject({ rejectedReason: 'not durable' });
    expect(await listAutomationProposals(dataDir, { status: 'pending-review' })).toEqual([]);
  });

  it('applies design-system proposals into the user design-system root', async () => {
    const proposal = await createAutomationProposal(dataDir, {
      id: 'proposal-design-system-1',
      title: 'Draft design system',
      summary: 'Create a user design-system draft.',
      targetKind: 'design-system',
      action: 'create',
      targetRef: 'design-systems/acme/DESIGN.md',
      patch: {
        format: 'markdown',
        after: '# Acme Design System\n\n> Category: Self-evolved\n',
      },
    });

    const applied = await applyAutomationProposal(dataDir, proposal.id);

    expect(applied.result).toMatchObject({
      designSystemId: 'acme',
      path: 'design-systems/acme/DESIGN.md',
    });
    await expect(
      fsp.readFile(path.join(dataDir, 'design-systems', 'acme', 'DESIGN.md'), 'utf8'),
    ).resolves.toContain('Acme Design System');
    await expect(listDesignSystems(path.join(dataDir, 'design-systems'))).resolves.toEqual(
      expect.arrayContaining([expect.objectContaining({ id: 'acme' })]),
    );
  });

  it('applies skill proposals into the user skill root', async () => {
    const proposal = await createAutomationProposal(dataDir, {
      id: 'proposal-skill-1',
      title: 'Draft reusable skill',
      summary: 'Create a user skill draft.',
      targetKind: 'skill',
      action: 'create',
      targetRef: 'skills/reusable-flow/SKILL.md',
      patch: {
        format: 'markdown',
        after: [
          '---',
          'name: "Reusable Flow"',
          'description: "Captured workflow"',
          '---',
          '',
          '# Reusable Flow',
        ].join('\n'),
      },
    });

    const applied = await applyAutomationProposal(dataDir, proposal.id);

    expect(applied.result).toMatchObject({
      skillSlug: 'reusable-flow',
      path: 'skills/reusable-flow/SKILL.md',
    });
    await expect(
      fsp.readFile(path.join(dataDir, 'skills', 'reusable-flow', 'SKILL.md'), 'utf8'),
    ).resolves.toContain('Reusable Flow');
    await expect(listSkills(path.join(dataDir, 'skills'))).resolves.toEqual(
      expect.arrayContaining([expect.objectContaining({ id: 'Reusable Flow' })]),
    );
  });

  it('applies automation-template proposals into the user template store', async () => {
    const proposal = await createAutomationProposal(dataDir, {
      id: 'proposal-template-1',
      title: 'Draft automation template',
      summary: 'Create a user automation template.',
      targetKind: 'automation-template',
      action: 'create',
      patch: {
        format: 'json',
        after: JSON.stringify({
          id: 'daily-context',
          title: 'Daily context digest',
          description: 'Turn one trusted source into context proposals every day.',
          purpose: 'Self-evolve project context from recurring source material.',
          triggerKinds: ['schedule'],
          sourceKinds: ['connector'],
          stages: [
            { id: 'ingest', kind: 'ingest', title: 'Capture source' },
            { id: 'propose', kind: 'propose', title: 'Create proposals' },
          ],
          outputSinks: ['memory', 'automation-template'],
          reviewPolicy: 'always',
          tokenCompression: 'balanced',
          tags: ['self-evolution'],
        }),
      },
    });

    const applied = await applyAutomationProposal(dataDir, proposal.id);

    expect(applied.result).toMatchObject({
      automationTemplateId: 'daily-context',
      path: 'automation-templates/daily-context.json',
    });
    await expect(listAllAutomationTemplates(dataDir)).resolves.toEqual(
      expect.arrayContaining([expect.objectContaining({ id: 'daily-context' })]),
    );
  });

  it('guards built-in automation templates from proposal overwrite', async () => {
    const proposal = await createAutomationProposal(dataDir, {
      id: 'proposal-template-built-in-1',
      title: 'Overwrite built-in template',
      summary: 'This should remain protected.',
      targetKind: 'automation-template',
      action: 'update',
      patch: {
        format: 'json',
        after: JSON.stringify({
          id: 'extract-design-system',
          title: 'Changed',
          description: 'Changed',
          purpose: 'Changed',
          triggerKinds: ['manual'],
          sourceKinds: ['chat'],
          stages: [{ id: 'propose', kind: 'propose', title: 'Propose' }],
          outputSinks: ['memory'],
          reviewPolicy: 'always',
          tokenCompression: 'off',
        }),
      },
    });

    await expect(applyAutomationProposal(dataDir, proposal.id)).rejects.toThrow(
      'cannot overwrite built-in automation template',
    );
  });
});

// Desktop proposals persisted (or posted) before targets were canonical: the
// contract keeps targetRef optional, so an unambiguous legacy target (the
// embedded memory id, or metadata.slug for skills and design systems) is
// converted into targetRef on load and on creation. Conflicts and title-only
// guesses are refused and change nothing.
describe('legacy desktop proposal targets', () => {
  const at = '2026-01-01T00:00:00.000Z';
  const persist = async (proposals: Array<Record<string, unknown>>) => {
    await fsp.mkdir(path.join(dataDir, 'automation-proposals'), { recursive: true });
    await fsp.writeFile(path.join(dataDir, 'automation-proposals', 'proposals.json'), JSON.stringify({ proposals: proposals.map((proposal) => ({
      title: 'Legacy', summary: 'Legacy desktop proposal', status: 'pending-review', reviewPolicy: 'always', createdAt: at, updatedAt: at,
      sourcePacketIds: [], ...proposal })) }));
  };
  const seedMemory = async () => {
    for (const id of ['entry_a', 'entry_b']) {
      await upsertMemoryEntry(dataDir, { id, name: id, description: id, type: 'project', body: `${id} original body` }, {});
    }
    return { a: (await readMemoryEntry(dataDir, 'entry_a'))?.body, b: (await readMemoryEntry(dataDir, 'entry_b'))?.body };
  };
  const seedFiles = async () => {
    const files = ['skills/alpha/SKILL.md', 'skills/beta/SKILL.md', 'design-systems/alpha/DESIGN.md', 'design-systems/beta/DESIGN.md'];
    for (const file of files) {
      await fsp.mkdir(path.dirname(path.join(dataDir, file)), { recursive: true });
      await fsp.writeFile(path.join(dataDir, file), 'ORIGINAL\n');
    }
  };
  const read = (file: string) => fsp.readFile(path.join(dataDir, file), 'utf8').catch(() => null);

  it('applies a persisted memory update keyed only by its embedded id to that entry', async () => {
    const original = await seedMemory();
    await persist([{ id: 'legacy-memory', targetKind: 'memory-node', action: 'update',
      patch: { format: 'json', after: JSON.stringify({ id: 'entry_a', body: 'LEGACY_MEMORY_MARKER' }) } }]);
    expect((await getAutomationProposal(dataDir, 'legacy-memory'))?.targetRef).toBe('entry_a');
    const applied = await applyAutomationProposal(dataDir, 'legacy-memory');
    expect(applied.result).toMatchObject({ memoryId: 'entry_a', action: 'update' });
    expect((await readMemoryEntry(dataDir, 'entry_a'))?.body).toContain('LEGACY_MEMORY_MARKER');
    expect((await readMemoryEntry(dataDir, 'entry_b'))?.body).toBe(original.b);
  });

  it('applies persisted skill and design-system updates and deletes keyed by metadata.slug', async () => {
    await seedFiles();
    await persist([
      { id: 'legacy-skill', targetKind: 'skill', action: 'update', metadata: { slug: 'alpha' }, patch: { format: 'markdown', after: '# Alpha v2' } },
      { id: 'legacy-design', targetKind: 'design-system', action: 'delete', metadata: { slug: 'alpha' }, patch: { format: 'markdown' } },
    ]);
    expect((await getAutomationProposal(dataDir, 'legacy-skill'))?.targetRef).toBe('skills/alpha/SKILL.md');
    expect((await getAutomationProposal(dataDir, 'legacy-design'))?.targetRef).toBe('design-systems/alpha/DESIGN.md');
    expect((await applyAutomationProposal(dataDir, 'legacy-skill')).result).toMatchObject({ skillSlug: 'alpha', action: 'update' });
    expect((await applyAutomationProposal(dataDir, 'legacy-design')).result).toMatchObject({ designSystemId: 'alpha', action: 'delete' });
    expect(await read('skills/alpha/SKILL.md')).toBe('# Alpha v2\n');
    expect(await read('skills/beta/SKILL.md')).toBe('ORIGINAL\n');
    expect(await read('design-systems/alpha/DESIGN.md')).toBeNull();
    expect(await read('design-systems/beta/DESIGN.md')).toBe('ORIGINAL\n');
  });

  it('refuses conflicting and title-only legacy targets and changes nothing', async () => {
    const original = await seedMemory();
    await seedFiles();
    await persist([
      { id: 'conflict-skill', targetKind: 'skill', action: 'update', targetRef: 'skills/alpha/SKILL.md', metadata: { slug: 'beta' },
        patch: { format: 'markdown', after: '# Replaced' } },
      { id: 'conflict-memory', targetKind: 'memory-node', action: 'update', targetRef: 'entry_a',
        patch: { format: 'json', after: JSON.stringify({ id: 'entry_b', body: 'replacement' }) } },
      { id: 'title-memory', title: 'entry_a', targetKind: 'memory-node', action: 'update', patch: { format: 'json', after: JSON.stringify({ name: 'entry_a', type: 'project', body: 'guessed' }) } },
      { id: 'title-design', title: 'beta', targetKind: 'design-system', action: 'update', patch: { format: 'markdown', after: '# Guessed' } },
    ]);
    for (const id of ['conflict-skill', 'conflict-memory', 'title-memory', 'title-design']) {
      await expect(applyAutomationProposal(dataDir, id), id).rejects.toThrow(/target/i);
    }
    expect(await read('skills/alpha/SKILL.md')).toBe('ORIGINAL\n');
    expect(await read('skills/beta/SKILL.md')).toBe('ORIGINAL\n');
    expect(await read('design-systems/beta/DESIGN.md')).toBe('ORIGINAL\n');
    expect((await readMemoryEntry(dataDir, 'entry_a'))?.body).toBe(original.a);
    expect((await readMemoryEntry(dataDir, 'entry_b'))?.body).toBe(original.b);
    expect((await listAutomationProposals(dataDir, { status: 'pending-review' })).map((item) => item.id).sort())
      .toEqual(['conflict-memory', 'conflict-skill', 'title-design', 'title-memory']);
  });

  it('canonicalizes legacy targets when a proposal is created and refuses conflicts there', async () => {
    const memory = await createAutomationProposal(dataDir, { title: 'Update A', summary: 'Legacy shape', targetKind: 'memory-node', action: 'update',
      patch: { format: 'json', after: JSON.stringify({ id: 'entry_a', body: 'x' }) } });
    expect(memory.targetRef).toBe('entry_a');
    const skill = await createAutomationProposal(dataDir, { title: 'Alpha', summary: 'Legacy shape', targetKind: 'skill', action: 'update',
      metadata: { slug: 'alpha' }, patch: { format: 'markdown', after: '# Alpha' } });
    expect(skill.targetRef).toBe('skills/alpha/SKILL.md');
    await expect(createAutomationProposal(dataDir, { title: 'x', summary: 'y', targetKind: 'memory-node', action: 'update', targetRef: 'entry_a',
      patch: { format: 'json', after: JSON.stringify({ id: 'entry_b', body: 'x' }) } })).rejects.toThrow(/target/i);
    await expect(createAutomationProposal(dataDir, { title: 'x', summary: 'y', targetKind: 'skill', action: 'update', targetRef: 'skills/alpha/SKILL.md',
      metadata: { slug: 'beta' }, patch: { format: 'markdown', after: '# x' } })).rejects.toThrow(/target/i);
    expect((await listAutomationProposals(dataDir)).map((item) => item.id).sort()).toEqual([memory.id, skill.id].sort());
  });
});
