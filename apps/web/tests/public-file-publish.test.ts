import { describe, expect, it } from 'vitest';
import {
  buildWorkspacePermissions,
  buildWorkspaceSeatSummary,
  type WorkspaceCollabContext,
} from '@open-design/contracts';
import {
  canPublishPublicFile,
  PublicFilePublishError,
  publicFilePublishFailure,
  publicFilePublishFailureKey,
} from '../src/collab/public-file-publish';

function context(overrides: Partial<WorkspaceCollabContext> = {}): WorkspaceCollabContext {
  return {
    workspaceId: 'ws-1',
    workspaceType: 'team',
    teamId: 'team-1',
    workspaceMemberId: 'wm-1',
    role: 'member',
    memberStatus: 'active',
    lifecycleState: 'active',
    billingState: 'active',
    planId: null,
    providerMode: 'platform_credits',
    seatSummary: buildWorkspaceSeatSummary({ seatLimit: 5, usedSeats: 1 }),
    permissions: buildWorkspacePermissions({ role: 'member', lifecycleState: 'active' }),
    ...overrides,
  };
}

describe('canPublishPublicFile', () => {
  it('allows a team workspace with a resolved member', () => {
    expect(canPublishPublicFile(context())).toBe(true);
  });

  // A personal workspace publishes under its OWN id. B's control-key auth path
  // stopped refusing non-team callers and now mints a principal whose teamId is
  // the workspace id, so the hub scopes a personal workspace as a partition of
  // one. The daemon's `publicFilePrincipal` applies the same rule; this is the
  // client half of that pair.
  it('allows a personal workspace with a resolved member', () => {
    expect(canPublishPublicFile(context({ workspaceType: 'personal' }))).toBe(true);
  });

  it('allows a personal workspace that carries no teamId at all', () => {
    const personal = context({ workspaceType: 'personal' });
    delete personal.teamId;
    expect(canPublishPublicFile(personal)).toBe(true);
  });

  // …but the gate is widened, not removed. Without a workspace there is no id
  // to publish under, and the daemon answers 409 WORKSPACE_IDENTITY_REQUIRED.
  it('refuses a signed-out / unresolved context', () => {
    expect(canPublishPublicFile(null)).toBe(false);
    expect(canPublishPublicFile(undefined)).toBe(false);
  });

  it('refuses a context whose member id has not resolved yet', () => {
    expect(canPublishPublicFile(context({ workspaceMemberId: '' }))).toBe(false);
    expect(canPublishPublicFile(context({ workspaceType: 'personal', workspaceMemberId: '' }))).toBe(false);
  });

  it('refuses a context whose workspace id has not resolved yet', () => {
    expect(canPublishPublicFile(context({ workspaceId: '' }))).toBe(false);
  });
});

describe('publicFilePublishFailureKey', () => {
  it('maps the workspace-identity refusal to its own explanation', () => {
    // Sign-in, NOT "switch to a team" — the gate is no longer team-scoped, and
    // the old copy sent personal users after a workspace they do not need.
    expect(publicFilePublishFailureKey(new Error('WORKSPACE_IDENTITY_REQUIRED'))).toBe(
      'fileViewer.publishFileRequiresWorkspace',
    );
  });

  it('falls back to a generic failure for anything else', () => {
    expect(publicFilePublishFailureKey(new Error('PUBLIC_FILE_URL_UNAVAILABLE'))).toBe(
      'fileViewer.publishFileFailed',
    );
    expect(publicFilePublishFailureKey(null)).toBe('fileViewer.publishFileFailed');
  });
});

describe('publicFilePublishFailure for a refused file (#119)', () => {
  const refused = (data: unknown, code = 'PUBLIC_LINK_FILE_REFUSED') =>
    new PublicFilePublishError('site/a.svg cannot be published (symlink)', 409, code, undefined, data as never);

  it.each([
    ['symlink', 'fileViewer.publishFileRefusedSymlink'],
    ['hard_link', 'fileViewer.publishFileRefusedHardLink'],
    ['not_regular', 'fileViewer.publishFileRefusedNotRegular'],
    ['too_large', 'fileViewer.publishFileRefusedTooLarge'],
    ['bundle_too_large', 'fileViewer.publishFileRefusedBundleTooLarge'],
    ['changed', 'fileViewer.publishFileRefusedChanged'],
    ['invalid_path', 'fileViewer.publishFileRefusedInvalidPath'],
  ])('names the file and the %s reason instead of "try again later"', (reason, key) => {
    const error = refused({ path: 'site/img/logo.svg', reason });
    expect(publicFilePublishFailure(error)).toEqual({ key, path: 'site/img/logo.svg' });
    expect(publicFilePublishFailureKey(error)).toBe(key);
  });

  it('falls back to the generic failure when the refusal is malformed or the code differs', () => {
    for (const data of [undefined, null, { path: 'a.svg' }, { path: '', reason: 'symlink' }, { path: 'a.svg', reason: 'other' }, { path: 7, reason: 'symlink' }]) {
      expect(publicFilePublishFailure(refused(data))).toEqual({ key: 'fileViewer.publishFileFailed' });
    }
    expect(publicFilePublishFailure(refused({ path: 'a.svg', reason: 'symlink' }, 'CONFLICT'))).toEqual({ key: 'fileViewer.publishFileFailed' });
    expect(publicFilePublishFailure(new Error('PUBLIC_LINK_FILE_REFUSED'))).toEqual({ key: 'fileViewer.publishFileFailed' });
  });
});
