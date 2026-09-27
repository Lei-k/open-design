// Issue #4 — pure checks of the declarative route classification registry,
// its matcher, and the central gate decision. The inventory-completeness
// check against a REAL started daemon lives in multiuser-gate-http.test.ts.

import { describe, expect, it } from 'vitest';
import type { AuthActor } from '../../src/services/auth-service.js';
import {
  MULTIUSER_ROUTE_CLASSIFICATION,
  compileRoutePattern,
  matchMultiUserRoute,
  type MultiUserRouteClassification,
} from '../../src/http/multiuser-route-classes.js';
import { decideMultiUserAccess } from '../../src/http/multiuser-gate.js';

const actor = (role: 'admin' | 'user', accountId = `${role}-1`): AuthActor => ({
  accountId,
  username: role,
  role,
  sessionId: `${accountId}-session`,
  sessionExpiresAt: Number.MAX_SAFE_INTEGER,
});

describe('classification registry is well formed', () => {
  it('has unique keys, compilable patterns and a reason for every entry', () => {
    const seen = new Set<string>();
    for (const entry of MULTIUSER_ROUTE_CLASSIFICATION) {
      expect(seen.has(entry.key), `duplicate ${entry.key}`).toBe(false);
      seen.add(entry.key);
      expect(entry.key).toBe(`${entry.method} ${entry.path}`);
      expect(entry.reason.trim().length, entry.key).toBeGreaterThan(10);
      if (entry.nonStringPath) {
        expect(entry.routeClass, entry.key).toBe('blocked-in-multiuser');
      } else if (entry.routeClass !== 'middleware') {
        expect(compileRoutePattern(entry.path), entry.key).not.toBeNull();
      }
    }
  });

  it('declares a project param that exists in every owner-scoped pattern', () => {
    const owned = MULTIUSER_ROUTE_CLASSIFICATION.filter((e) => e.routeClass === 'owner-scoped-project');
    expect(owned.length).toBeGreaterThan(0);
    for (const entry of owned) {
      expect(entry.projectParam, entry.key).toBeTruthy();
      expect(entry.path.split('/')).toContain(`:${entry.projectParam}`);
    }
  });

  it('declares a run param for every run-owner route', () => {
    const owned = MULTIUSER_ROUTE_CLASSIFICATION.filter((e) => e.routeClass === 'owner-scoped-run');
    expect(owned.length).toBe(3);
    for (const entry of owned) expect(entry.path.split('/')).toContain(`:${entry.runParam}`);
  });

  it('never marks a parameterless project route owner-scoped or a project-param route actor-scoped', () => {
    for (const entry of MULTIUSER_ROUTE_CLASSIFICATION) {
      if (entry.routeClass === 'actor-scoped') {
        expect(entry.path.includes(':'), entry.key).toBe(false);
      }
    }
  });
});

describe('matcher mirrors Express routing permissively enough to fail closed', () => {
  const keysFor = (method: string, rawPath: string) =>
    matchMultiUserRoute(method, rawPath).map((m) => m.entry.key).sort();

  it('matches exact, case-insensitive literals and one trailing slash', () => {
    expect(keysFor('GET', '/api/projects')).toEqual(['GET /api/projects']);
    expect(keysFor('GET', '/API/Projects')).toEqual(['GET /api/projects']);
    expect(keysFor('GET', '/api/projects/')).toEqual(['GET /api/projects']);
    expect(keysFor('GET', '/api/projects//')).toEqual([]);
  });

  it('decodes params the way Express does and refuses undecodable ones', () => {
    const [match] = matchMultiUserRoute('GET', '/api/projects/%41bc');
    expect(match?.entry.key).toBe('GET /api/projects/:id');
    expect(match?.params.id).toBe('Abc');
    expect(matchMultiUserRoute('GET', '/api/projects/%E0%A4%A')).toEqual([]);
  });

  it('maps HEAD onto GET routes', () => {
    expect(keysFor('HEAD', '/api/projects')).toEqual(['GET /api/projects']);
  });

  it('never lets the SPA catch-all classify an arbitrary path', () => {
    expect(keysFor('GET', '/')).toEqual([]);
    expect(keysFor('GET', '/assets/app.js')).toEqual([]);
    expect(keysFor('GET', '/api/nope/nope/nope')).toEqual([]);
  });

  it('prefix-matches static mounts on segment boundaries only', () => {
    expect(keysFor('GET', '/artifacts/x/y.html')).toEqual(['USE /artifacts']);
    expect(keysFor('GET', '/artifacts')).toEqual(['USE /artifacts']);
    expect(keysFor('POST', '/frames/a')).toEqual(['USE /frames']);
    expect(keysFor('GET', '/artifactsX/y')).toEqual([]);
  });

  it('does not match regex-registered preview routes (they stay unclassified => denied)', () => {
    expect(keysFor('GET', '/api/projects/p1/raw/index.html')).toEqual([]);
  });

  it('rejects unsupported pattern syntax at compile time', () => {
    expect(compileRoutePattern('/api/{optional}')).toBeNull();
    expect(compileRoutePattern('/api/x(y)')).toBeNull();
    expect(compileRoutePattern('relative')).toBeNull();
  });
});

describe('run-owner gate', () => {
  it('refuses a foreign run for users and admins before the handler', () => {
    const matches = matchMultiUserRoute('GET', '/api/runs/run-a/events');
    for (const role of ['user', 'admin'] as const) {
      expect(decideMultiUserAccess({ matches, actor: actor(role), isProjectOwner: () => true,
        isRunOwner: () => false })).toEqual({ kind: 'run-not-found' });
    }
  });
});

describe('decideMultiUserAccess', () => {
  const entry = (overrides: Partial<MultiUserRouteClassification>): MultiUserRouteClassification => ({
    method: 'GET',
    path: '/x',
    key: 'GET /x',
    routeClass: 'blocked-in-multiuser',
    reason: 'synthetic entry for decision tests',
    ...overrides,
  });
  const owns = (projectId: string, accountId: string) => projectId === 'p-owned' && accountId === 'user-1';

  it('passes public probes and auth routes without a session', () => {
    for (const routeClass of ['public-probe', 'auth'] as const) {
      const d = decideMultiUserAccess({ matches: [{ entry: entry({ routeClass }), params: {} }], actor: null, isProjectOwner: owns });
      expect(d.kind).toBe('pass-unauthenticated');
    }
  });

  it('requires a session for everything else, including unclassified paths', () => {
    for (const matches of [[], [{ entry: entry({ routeClass: 'actor-scoped' }), params: {} }], [{ entry: entry({}), params: {} }]]) {
      expect(decideMultiUserAccess({ matches, actor: null, isProjectOwner: owns }).kind).toBe('unauthenticated');
    }
  });

  it('fails closed on unclassified, blocked, and mixed-class matches', () => {
    const u = actor('user');
    expect(decideMultiUserAccess({ matches: [], actor: u, isProjectOwner: owns }).kind).toBe('not-found');
    expect(decideMultiUserAccess({ matches: [{ entry: entry({}), params: {} }], actor: u, isProjectOwner: owns }).kind).toBe('blocked');
    const mixed = [
      { entry: entry({ routeClass: 'actor-scoped', key: 'GET /a' }), params: {} },
      { entry: entry({ routeClass: 'public-probe', key: 'GET /b' }), params: {} },
    ];
    expect(decideMultiUserAccess({ matches: mixed, actor: null, isProjectOwner: owns }).kind).toBe('unauthenticated');
    expect(decideMultiUserAccess({ matches: mixed, actor: u, isProjectOwner: owns }).kind).toBe('blocked');
  });

  it('enforces admin-only by the persisted role on the resolved actor', () => {
    const matches = [{ entry: entry({ routeClass: 'admin-only' }), params: {} }];
    expect(decideMultiUserAccess({ matches, actor: actor('user'), isProjectOwner: owns }).kind).toBe('forbidden');
    expect(decideMultiUserAccess({ matches, actor: actor('admin'), isProjectOwner: owns }).kind).toBe('allow');
  });

  it('checks project ownership from the route param, with no admin override', () => {
    const scoped = (id: string) => [{
      entry: entry({ routeClass: 'owner-scoped-project', projectParam: 'id', path: '/p/:id', key: 'GET /p/:id' }),
      params: { id },
    }];
    expect(decideMultiUserAccess({ matches: scoped('p-owned'), actor: actor('user', 'user-1'), isProjectOwner: owns }).kind).toBe('allow');
    expect(decideMultiUserAccess({ matches: scoped('p-owned'), actor: actor('user', 'user-2'), isProjectOwner: owns }).kind).toBe('project-not-found');
    expect(decideMultiUserAccess({ matches: scoped('p-owned'), actor: actor('admin', 'admin-1'), isProjectOwner: owns }).kind).toBe('project-not-found');
    expect(decideMultiUserAccess({ matches: scoped('p-missing'), actor: actor('user', 'user-1'), isProjectOwner: owns }).kind).toBe('project-not-found');
    const noParam = [{ entry: entry({ routeClass: 'owner-scoped-project', projectParam: 'id' }), params: {} }];
    expect(decideMultiUserAccess({ matches: noParam, actor: actor('user', 'user-1'), isProjectOwner: owns }).kind).toBe('project-not-found');
  });
});
