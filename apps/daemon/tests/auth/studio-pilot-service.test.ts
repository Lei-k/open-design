import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { type AuthActor } from '../../src/services/auth-service.js';
import { makeTempDataRoot, ManualClock, openTestAuth } from './helpers.js';
let root: ReturnType<typeof makeTempDataRoot>;
let opened: ReturnType<typeof openTestAuth>;
let clock: ManualClock;
let admin: AuthActor;
let user: AuthActor;
beforeEach(async () => {
  root = makeTempDataRoot(); clock = new ManualClock(); opened = openTestAuth(root.dataRoot, clock);
  await opened.service.bootstrapFirstAdmin({ username: 'pilot-admin', password: 'synthetic-admin-password-77' });
  admin = opened.service.resolveSession((await opened.service.login({ username: 'pilot-admin', password: 'synthetic-admin-password-77' })).session.token)!;
  await opened.service.createAccount(admin, { username: 'pilot-user', password: 'synthetic-user-password-77', role: 'user' });
  user = opened.service.resolveSession((await opened.service.login({ username: 'pilot-user', password: 'synthetic-user-password-77' })).session.token)!;
});
afterEach(() => { vi.restoreAllMocks(); opened.store.close(); root.cleanup(); });
it('persists the default-off flag and revision over repeated schema reopen without revoking sessions', () => {
  expect(opened.service.getOwnStudioPilot(user)).toEqual({ studioPilot: false, revision: 0 });
  opened.service.updateStudioPilot(admin, user.accountId, { studioPilot: true, revision: 0 });
  for (let i = 0; i < 3; i++) {
    opened.store.close(); opened = openTestAuth(root.dataRoot, clock);
    expect(opened.service.getOwnStudioPilot(user)).toEqual({ studioPilot: true, revision: 1 });
    expect(opened.service.getOwnAccount(user).active).toBe(true);
    expect(opened.service.isBootstrapRequired()).toBe(false);
  }
  expect(opened.service.isActorCurrent(user)).toBe(false);
  expect(opened.service.isActorCurrent({ ...user, studioRevision: 1 })).toBe(true);
});
it('denies ordinary callers before any target account or pilot lookup', () => {
  const targetLookup = vi.spyOn(opened.store, 'getAccountById');
  const pilotLookup = vi.spyOn(opened.store, 'getStudioPilot');
  for (const id of [admin.accountId, 'missing-target']) {
    expect(() => opened.service.getStudioPilot(user, id)).toThrow('admin role required');
    expect(() => opened.service.updateStudioPilot(user, id, { studioPilot: true, revision: 0 })).toThrow('admin role required');
  }
  // Revalidation reads only the requesting user's live account/session.
  expect(targetLookup.mock.calls.every(([id]) => id === user.accountId)).toBe(true);
  expect(pilotLookup).not.toHaveBeenCalled();
});
it('retains account disable and last-admin protection when pilots change', () => {
  opened.service.updateStudioPilot(admin, admin.accountId, { studioPilot: true, revision: 0 });
  expect(() => opened.service.updateAccount(admin, admin.accountId, { active: false })).toThrow('last usable admin');
  opened.service.updateAccount(admin, user.accountId, { active: false });
  opened.service.updateStudioPilot(admin, user.accountId, { studioPilot: true, revision: 0 });
  expect(opened.store.getAccountById(user.accountId)?.active).toBe(false);
  expect(() => opened.service.getOwnStudioPilot(user)).toThrow();
});
