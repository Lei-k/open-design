import { describe, expect, it } from 'vitest';
import { STUDIO_PARITY_LANES } from '@open-design/contracts';
import { MULTIUSER_ROUTE_CLASSIFICATION } from '../../src/http/multiuser-route-classes.js';
import { multiUserStudioCapabilities, studioLaneForRoute, studioRouteParityInventory } from '../../src/http/studio-parity.js';

describe('Studio parity delivery ledger (#52)', () => {
  it('assigns every allowed and blocked route, pattern and mount to a delivery owner', () => {
    const inventory = studioRouteParityInventory();
    expect(inventory.map((row) => row.key)).toEqual(MULTIUSER_ROUTE_CLASSIFICATION.map((entry) => entry.key));
    for (const row of inventory) {
      expect(STUDIO_PARITY_LANES.find((lane) => lane.issue === row.issue)?.id, row.key).toBe(row.lane);
      expect(row.owner, row.key).toBeTruthy();
      expect(row.component, row.key).toBeTruthy();
      expect(row.targetData, row.key).toBeTruthy();
      expect(row.credentialOwner, row.key).toBeTruthy();
      expect(row.webStrategy, row.key).toBeTruthy();
    }
  });
  it('does not advertise a partial route opening as complete Studio parity', () => {
    const capabilities = multiUserStudioCapabilities();
    expect(capabilities.shell).toBe('legacy-multiuser');
    expect(Object.keys(capabilities.features).sort()).toEqual(STUDIO_PARITY_LANES.map((lane) => lane.id).sort());
    for (const lane of STUDIO_PARITY_LANES) {
      const feature = capabilities.features[lane.id];
      if (lane.id === 'baseline') expect(feature.status).toBe('supported');
      else {
        expect(feature.status).toBe('unavailable');
        if (feature.status !== 'supported') expect(feature.reason).toContain(`#${lane.issue}`);
      }
    }
  });
  it('covers all nineteen subissues with acyclic dependencies and explicit acceptance', () => {
    expect(STUDIO_PARITY_LANES.map((lane) => lane.issue)).toEqual(Array.from({ length: 19 }, (_, index) => 52 + index));
    for (const lane of STUDIO_PARITY_LANES) {
      expect(lane.owner).toBeTruthy();
      expect(lane.acceptance.length).toBeGreaterThan(30);
      for (const dependency of lane.dependsOn) expect(STUDIO_PARITY_LANES.some((candidate) => candidate.issue === dependency)).toBe(true);
    }
    const visited = new Set<number>();
    function visit(issue: number, ancestors: number[] = []) {
      expect(ancestors, `dependency cycle at #${issue}`).not.toContain(issue);
      if (visited.has(issue)) return;
      for (const dependency of STUDIO_PARITY_LANES.find((lane) => lane.issue === issue)!.dependsOn) visit(dependency, [...ancestors, issue]);
      visited.add(issue);
    }
    for (const lane of STUDIO_PARITY_LANES) visit(lane.issue);
  });
  it('requires a decision for new domains instead of silently claiming support', () => {
    expect(studioLaneForRoute({ method: 'GET', path: '/api/new-domain/private', routeClass: 'blocked-in-multiuser' })).toBeNull();
    expect(studioLaneForRoute({ method: 'GET', path: '/api/projects/:id/new-private-resource', routeClass: 'blocked-in-multiuser' })).toBeNull();
  });
});
