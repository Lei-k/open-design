// Per-user OS-level isolation for personal-subscription app-server children (#18).
//
// Daemon and agent children share one OS uid, so file modes alone cannot stop a
// task shell in one user's run from reading another user's CODEX_HOME or the
// daemon database. Every personal `codex app-server` child (login, identity
// read, verification, runs, logout) therefore starts inside a bubblewrap
// sandbox whose filesystem holds only:
//   - read-only system directories (and the few /etc files name resolution and
//     TLS need),
//   - read-only program paths (the app-server binary or the mock and its runtime),
//   - read-write: this child's CODEX_HOME, HOME, TMPDIR and working directory.
// The daemon data root, other users' homes, the operator's home and the host's
// /tmp do not exist inside. The network stays shared: the provider is remote.
//
// User decision 2026-10-06 (#18, option A): a per-run sandbox, not per-user uids.
// This outer boundary is also the command sandbox for personal runs. The
// app-server receives `danger-full-access` inside it so Codex does not try to
// create a second, commonly unsupported Linux sandbox; "full access" reaches
// only the four writable mounts above, never the daemon or another user.

import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';

export interface PersonalSandbox {
  /** Absolute path of the bubblewrap executable. */
  bwrap: string;
  /** Program paths mounted read-only at the same location (binary, runtime, mock). */
  readOnlyPaths: readonly string[];
}

/** The writable locations of one app-server child; everything else is absent or read-only. */
export interface PersonalSandboxMounts {
  codexHome: string;
  home: string;
  temp: string;
  cwd: string;
}

const SYSTEM_DIRECTORIES = ['/usr', '/etc/ssl', '/etc/ca-certificates', '/etc/pki', '/etc/alternatives'];
/** Top-level entries that are symlinks into /usr on merged-/usr systems, directories elsewhere. */
const SYSTEM_TOP_LEVEL = ['/bin', '/sbin', '/lib', '/lib32', '/lib64', '/libx32'];
const SYSTEM_FILES = [
  '/etc/resolv.conf', '/etc/hosts', '/etc/nsswitch.conf', '/etc/host.conf', '/etc/gai.conf',
  '/etc/passwd', '/etc/group', '/etc/localtime',
];

function exists(file: string): boolean {
  try { fs.statSync(file); return true; } catch { return false; }
}

/** The bubblewrap arguments that build the sandbox's filesystem, without the command. */
export function personalSandboxArgs(sandbox: PersonalSandbox, mounts: PersonalSandboxMounts): string[] {
  const args = ['--unshare-all', '--share-net', '--die-with-parent', '--new-session'];
  for (const dir of SYSTEM_DIRECTORIES) if (exists(dir)) args.push('--ro-bind', dir, dir);
  for (const entry of SYSTEM_TOP_LEVEL) {
    const info = fs.lstatSync(entry, { throwIfNoEntry: false });
    if (!info) continue;
    if (info.isSymbolicLink()) args.push('--symlink', fs.readlinkSync(entry), entry);
    else if (info.isDirectory()) args.push('--ro-bind', entry, entry);
  }
  // A source symlink (e.g. /etc/resolv.conf → systemd's stub) is followed by bwrap.
  for (const file of SYSTEM_FILES) if (exists(file)) args.push('--ro-bind', file, file);
  args.push('--proc', '/proc', '--dev', '/dev', '--tmpfs', '/tmp');
  for (const dir of [...new Set(sandbox.readOnlyPaths)]) args.push('--ro-bind', dir, dir);
  // Parents before children, so a nested writable path is not hidden by its parent's mount.
  const writable = [...new Set([mounts.codexHome, mounts.home, mounts.temp, mounts.cwd])]
    .sort((a, b) => a.length - b.length);
  for (const dir of writable) args.push('--bind', dir, dir);
  args.push('--chdir', mounts.cwd);
  return args;
}

/** `command` wrapped to run inside the sandbox. */
export function sandboxedCommand(sandbox: PersonalSandbox, mounts: PersonalSandboxMounts,
  command: readonly [string, ...string[]]): [string, ...string[]] {
  return [sandbox.bwrap, ...personalSandboxArgs(sandbox, mounts), '--', ...command];
}

/**
 * Whether `bwrap` can build this sandbox on this host (unprivileged user
 * namespaces may be disabled, or restricted by AppArmor). Spawns one short
 * child in an empty scratch directory under `scratchRoot`, which it removes.
 */
export function probePersonalSandbox(bwrap: string, scratchRoot: string): boolean {
  if (!path.isAbsolute(bwrap) || !exists(bwrap)) return false;
  let scratch: string | null = null;
  try {
    scratch = fs.mkdtempSync(path.join(scratchRoot, 'od-sandbox-probe-'));
    const [bin, ...args] = sandboxedCommand({ bwrap, readOnlyPaths: [] },
      { codexHome: scratch, home: scratch, temp: scratch, cwd: scratch }, ['/bin/sh', '-c', 'exit 0']);
    const result = spawnSync(bin, args, { stdio: 'ignore', timeout: 10_000, env: {} });
    return result.status === 0;
  } catch {
    return false;
  } finally {
    if (scratch) fs.rmSync(scratch, { recursive: true, force: true });
  }
}
