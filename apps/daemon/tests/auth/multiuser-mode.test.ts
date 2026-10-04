// Issue #3/#4 — multi-user mode switch semantics.
//
// - Default off: single-user behaviour and route registration are unchanged,
//   no auth store or ownership table is created.
// - On only through the programmatic `startServer({ multiUser })` option with
//   the exact not-launch-ready acknowledgement; there is no environment
//   switch, and setting one refuses startup instead of silently degrading.
// - The single-tenant substitutes (OD_API_TOKEN, OD_DISABLE_API_AUTH, a
//   non-loopback bind that would need them) refuse startup in multi-user mode.

import { existsSync } from 'node:fs';
import path from 'node:path';
import Database from 'better-sqlite3';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import {
  MULTIUSER_ENV_SWITCH_NAMES,
  MULTIUSER_NOT_LAUNCH_READY_ACK,
  MultiUserModeRefusal,
  resolveMultiUserMode,
  type MultiUserModeOptions,
} from '../../src/services/multiuser-mode.js';
import {
  cleanupIsolatedDataRoot,
  loadIsolatedServerModule,
  multiUserOptions,
  rawRequest,
} from './multiuser-harness.js';

const TOUCHED_ENV = ['OD_API_TOKEN', 'OD_DISABLE_API_AUTH', 'OD_BIND_HOST', ...MULTIUSER_ENV_SWITCH_NAMES];
const SAVED_ENV = Object.fromEntries(TOUCHED_ENV.map((key) => [key, process.env[key]]));

function restoreEnv(): void {
  for (const key of TOUCHED_ENV) {
    const value = SAVED_ENV[key];
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
}

function clearEnv(): void {
  for (const key of TOUCHED_ENV) delete process.env[key];
}

const ok = (overrides: Partial<MultiUserModeOptions> = {}) => multiUserOptions(overrides);

describe('resolveMultiUserMode (pure rule table)', () => {
  const base = { env: {} as NodeJS.ProcessEnv, host: '127.0.0.1' };

  it('is off (null) when no programmatic option is supplied', () => {
    expect(resolveMultiUserMode({ ...base, options: undefined })).toBeNull();
    expect(resolveMultiUserMode({ ...base, options: null })).toBeNull();
  });

  it('turns on only with the exact acknowledgement literal', () => {
    const mode = resolveMultiUserMode({ ...base, options: ok() });
    expect(mode?.allowedOrigins).toEqual(ok().allowedOrigins);
    for (const ack of ['', 'yes', MULTIUSER_NOT_LAUNCH_READY_ACK.toUpperCase(), undefined]) {
      expect(() => resolveMultiUserMode({
        ...base,
        options: { ...ok(), acknowledgeNotLaunchReady: ack as typeof MULTIUSER_NOT_LAUNCH_READY_ACK },
      })).toThrow(MultiUserModeRefusal);
    }
  });

  it('has no environment switch: any multi-user env var refuses startup, on or off', () => {
    for (const name of MULTIUSER_ENV_SWITCH_NAMES) {
      for (const value of ['1', 'true', '0']) {
        const env = { [name]: value } as NodeJS.ProcessEnv;
        expect(() => resolveMultiUserMode({ ...base, env, options: undefined }), `${name}=${value}`).toThrow(MultiUserModeRefusal);
        expect(() => resolveMultiUserMode({ ...base, env, options: ok() }), `${name}=${value}`).toThrow(MultiUserModeRefusal);
      }
      expect(resolveMultiUserMode({ ...base, env: { [name]: '' } as NodeJS.ProcessEnv, options: undefined })).toBeNull();
    }
  });

  it('refuses new multi-user switch spellings without catching unrelated OD variables', () => {
    for (const name of ['OD_MULTIUSER_ENABLED', 'OD_ENABLE_MULTI_USER', 'OD_MULTI-USER-FLAG']) {
      expect(() => resolveMultiUserMode({ ...base, env: { [name]: 'true' }, options: undefined }), name)
        .toThrow(MultiUserModeRefusal);
      expect(() => resolveMultiUserMode({ ...base, env: { [name]: '1' }, options: ok() }), name)
        .toThrow(MultiUserModeRefusal);
      expect(resolveMultiUserMode({ ...base, env: { [name]: '  ' }, options: undefined })).toBeNull();
    }
    const realEnv = {
      OD_DATA_DIR: '/unused',
      OD_BIND_HOST: '127.0.0.1',
      OD_APP_CHANNEL: 'beta',
      OD_WORKSPACE_CONTEXT_SOURCE: 'local',
      OD_DISABLE_API_AUTH: '0',
    };
    expect(resolveMultiUserMode({ ...base, env: realEnv, options: undefined })).toBeNull();
  });

  it('refuses the single-tenant substitutes for per-user sessions', () => {
    expect(() => resolveMultiUserMode({ ...base, env: { OD_API_TOKEN: 'x'.repeat(32) }, options: ok() }))
      .toThrow(/OD_API_TOKEN/);
    expect(() => resolveMultiUserMode({ ...base, env: { OD_DISABLE_API_AUTH: '1' }, options: ok() }))
      .toThrow(/OD_DISABLE_API_AUTH/);
    for (const host of ['0.0.0.0', '::', '10.0.0.5', 'od.example.com']) {
      expect(() => resolveMultiUserMode({ ...base, host, options: ok() }), host).toThrow(/loopback/);
    }
    // The same env is fine when multi-user mode is off (single-user contract untouched).
    expect(resolveMultiUserMode({ ...base, env: { OD_API_TOKEN: 'x'.repeat(32) }, options: undefined })).toBeNull();
  });

  it('requires exact allowed origins', () => {
    expect(() => resolveMultiUserMode({ ...base, options: ok({ allowedOrigins: [] }) })).toThrow(MultiUserModeRefusal);
    expect(() => resolveMultiUserMode({ ...base, options: ok({ allowedOrigins: ['https://a.example/path'] }) }))
      .toThrow(MultiUserModeRefusal);
  });
});

describe('startServer mode switch', () => {
  let mod: typeof import('../../src/server.js');
  let dataRoot: string;

  beforeAll(async () => {
    clearEnv();
    ({ mod, dataRoot } = await loadIsolatedServerModule());
  }, 120_000);

  afterEach(() => {
    clearEnv();
  });

  afterAll(() => {
    restoreEnv();
    cleanupIsolatedDataRoot();
  });

  it('mode off: single-user behaviour unchanged, no auth routes, no auth store, no ownership table', async () => {
    const started = (await mod.startServer({ port: 0, returnServer: true })) as import('../../src/server.js').StartServerResult;
    try {
      const keys = started.routeInventory.map((route) => `${route.method} ${route.path}`);
      expect(started.pathlessRouteInventory).toBeUndefined();
      expect(keys.some((key) => key.includes('/api/auth'))).toBe(false);
      const me = await rawRequest(started.url, { path: '/api/auth/me' });
      expect(me.status).toBe(404);
      const list = await rawRequest(started.url, { path: '/api/projects' });
      expect(list.status).toBe(200);
      expect(existsSync(path.join(dataRoot, 'auth'))).toBe(false);
      const db = new Database(path.join(dataRoot, 'app.sqlite'), { readonly: true });
      try {
        const table = db
          .prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'multiuser_project_owners'")
          .get();
        expect(table).toBeUndefined();
      } finally {
        db.close();
      }
    } finally {
      await Promise.resolve(started.shutdown());
      await new Promise<void>((resolve) => started.server.close(() => resolve()));
    }
  }, 60_000);

  it('refuses to start multi-user mode next to OD_API_TOKEN', async () => {
    process.env.OD_API_TOKEN = 'a'.repeat(40);
    await expect(mod.startServer({ port: 0, returnServer: true, multiUser: ok() })).rejects.toThrow(/OD_API_TOKEN/);
  });

  it('refuses to start multi-user mode next to OD_DISABLE_API_AUTH', async () => {
    process.env.OD_DISABLE_API_AUTH = '1';
    await expect(mod.startServer({ port: 0, returnServer: true, multiUser: ok() })).rejects.toThrow(/OD_DISABLE_API_AUTH/);
  });

  it('refuses a non-loopback bind in multi-user mode', async () => {
    await expect(mod.startServer({ port: 0, host: '0.0.0.0', returnServer: true, multiUser: ok() }))
      .rejects.toThrow(/loopback/);
  });

  it('refuses without the acknowledgement', async () => {
    await expect(mod.startServer({
      port: 0,
      returnServer: true,
      multiUser: { ...ok(), acknowledgeNotLaunchReady: 'ok' as typeof MULTIUSER_NOT_LAUNCH_READY_ACK },
    })).rejects.toThrow(MultiUserModeRefusal);
  });

  it('refuses an environment switch instead of silently starting single-user', async () => {
    process.env.OD_MULTIUSER_MODE = '1';
    await expect(mod.startServer({ port: 0, returnServer: true })).rejects.toThrow(MultiUserModeRefusal);
  });
});
