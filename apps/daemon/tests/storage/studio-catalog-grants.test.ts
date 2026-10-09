import Database from 'better-sqlite3';
import { STUDIO_CATALOG_GRANTS_MAX } from '@open-design/contracts';
import { afterEach, beforeEach, expect, it } from 'vitest';
import { StudioCatalogGrantLimitError, StudioCatalogGrants } from '../../src/storage/studio-catalog-grants.js';
import { StudioDesignSystems } from '../../src/storage/studio-design-systems.js';
import { StudioSkills } from '../../src/storage/studio-skills.js';

let db: Database.Database;
beforeEach(() => { db = new Database(':memory:'); });
afterEach(() => { db.close(); });

it('derives roles from the owner binding and grants, bounded per item and gone with the item', () => {
  const skills = new StudioSkills(db);
  const designs = new StudioDesignSystems(db);
  const grants = new StudioCatalogGrants(db);
  const skill = skills.create('owner', { name: 'Shared', body: 'body' })!;
  const document = designs.create('owner', { title: 'Doc', body: 'body' });
  expect(grants.roleOf('skill', skill.id, 'owner')).toBe('owner');
  expect(grants.roleOf('skill', skill.id, 'grantee-0')).toBeNull();
  // A grant names one kind: the same id under the other kind grants nothing.
  grants.set('skill', skill.id, 'grantee-0', 1);
  expect(grants.roleOf('skill', skill.id, 'grantee-0')).toBe('use');
  expect(grants.roleOf('design-system', skill.id, 'grantee-0')).toBeNull();
  expect(() => grants.set('skill', skill.id, 'owner', 1)).toThrow('owner');
  expect(() => grants.set('skill', 'studio-skill:missing', 'grantee-0', 1)).toThrow();
  // Re-granting is idempotent and keeps the first grant time.
  expect(grants.set('skill', skill.id, 'grantee-0', 99).grantedAt).toBe(1);
  for (let index = 1; index < STUDIO_CATALOG_GRANTS_MAX; index++) grants.set('skill', skill.id, `grantee-${index}`, index + 1);
  expect(grants.list('skill', skill.id)).toHaveLength(STUDIO_CATALOG_GRANTS_MAX);
  expect(() => grants.set('skill', skill.id, 'one-too-many', 100)).toThrow(StudioCatalogGrantLimitError);
  expect(grants.memberCounts('skill', [skill.id, document.id]).get(skill.id)).toBe(STUDIO_CATALOG_GRANTS_MAX + 1);
  expect(grants.sharedWith('skill', 'grantee-3')).toEqual([{ resourceId: skill.id, ownerAccountId: 'owner' }]);
  // Soft-deleting the resource grants nothing, even before the rows are removed.
  expect(skills.delete('owner', skill.id)).toBe(true);
  expect(grants.roleOf('skill', skill.id, 'grantee-3')).toBeNull();
  expect(grants.sharedWith('skill', 'grantee-3')).toEqual([]);
  expect(grants.removeAll('skill', skill.id)).toBe(STUDIO_CATALOG_GRANTS_MAX);
  grants.set('design-system', document.id, 'grantee-0', 1);
  expect(grants.remove('design-system', document.id, 'grantee-0')).toBe(true);
  expect(grants.remove('design-system', document.id, 'grantee-0')).toBe(false);
  expect(() => db.prepare("INSERT INTO studio_catalog_grants (kind, resource_id, grantee_account_id, role, granted_at) VALUES ('skill', 'x', 'y', 'edit', 1)").run()).toThrow();
});
