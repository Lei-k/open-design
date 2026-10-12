// Offline replay of the actual Docker extraction RUN; no Docker or download.
import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
const archiveDir = process.env.OD_TEST_CODEX_RELEASE_ARCHIVES;
const dockerfile = fs.readFileSync(fileURLToPath(new URL('../../../../deploy/Dockerfile', import.meta.url)), 'utf8');
const stage = dockerfile.split(' AS codex-download\n')[1]!.split('\nFROM scratch')[0]!;
const digest = 'a676f5722aae0d86cbe3764332f08eab1fdd89dc0a300b3ad4ffbf48611fa3e3';
function extract(archive: string, sha: string, check: (result: ReturnType<typeof spawnSync>, output: string) => void) {
  const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 's73-extract-'));
  try {
    const output = path.join(scratch, 'out');
    // Substitute only acquisition/locations. Keep the build's extraction/checks intact.
    const step = stage.slice(stage.indexOf('RUN ') + 4).trim().replaceAll('\\\n', '\n')
      .replace(/wget -qO [^;]+;/u, 'cp "$OFFLINE_ARCHIVE" /tmp/codex.tgz;')
      .replaceAll('/tmp', scratch).replaceAll('/out', output);
    const result = spawnSync('/bin/sh', ['-c', step], { stdio: 'inherit',
      env: { PATH: process.env.PATH, CODEX_VERSION: '0.162.1', CODEX_SHA256: sha, OFFLINE_ARCHIVE: archive } });
    check(result, output);
  } finally { fs.rmSync(scratch, { recursive: true, force: true }); }
}
describe.skipIf(!archiveDir)('offline Codex release extraction', () => {
  it('pins the full package and ships both executable binaries plus package search metadata', () => {
    expect(stage).toContain(`ARG CODEX_SHA256=${digest}`);
    expect(stage).toContain('/codex-package-x86_64-unknown-linux-musl.tar.gz');
    expect(stage).toContain('tar --no-same-owner');
    extract(path.join(archiveDir!, 'pkg.tgz'), digest, (result, output) => {
      expect(result.error).toBeUndefined();
      expect(result.status).toBe(0);
      for (const file of ['bin/codex', 'bin/codex-code-mode-host', 'codex-path/rg']) {
        expect(fs.statSync(path.join(output, file)).isFile()).toBe(true);
        expect(fs.statSync(path.join(output, file)).uid).toBe(fs.statSync(output).uid);
        fs.accessSync(path.join(output, file), fs.constants.X_OK);
      }
      expect(JSON.parse(fs.readFileSync(path.join(output, 'codex-package.json'), 'utf8')).version).toBe('0.162.1');
      expect(fs.existsSync(path.join(output, 'codex-resources/voice'))).toBe(false);
    });
  });
  it('rejects supplied contexts missing search/metadata or executable search permissions', () => {
    extract(path.join(archiveDir!, 'pkg.tgz'), digest, (result, output) => {
      expect(result.error).toBeUndefined(); expect(result.status).toBe(0);
      const finalStage = dockerfile.split('FROM runtime AS multiuser')[1]!;
      const checks = finalStage.slice(finalStage.indexOf('RUN test -f ') + 4, finalStage.indexOf('\n# Editable PPTX'))
        .replaceAll('\\\n', '\n').replaceAll('/opt/codex', output)
        .replace(/&& [^\s]+\/bin\/codex --version/u, '&& true'); // No native execution is needed to test context validation.
      const validate = () => spawnSync('/bin/sh', ['-c', checks], { stdio: 'inherit' }).status;
      expect(validate()).toBe(0);
      const rg = path.join(output, 'codex-path/rg');
      fs.renameSync(rg, rg + '.saved'); expect(validate()).not.toBe(0); fs.renameSync(rg + '.saved', rg);
      fs.chmodSync(rg, 0o600); expect(validate()).not.toBe(0); fs.chmodSync(rg, 0o755);
      fs.rmSync(path.join(output, 'codex-package.json')); expect(validate()).not.toBe(0);
    });
  });
  it('refuses the binary-only archive even with its own valid checksum', () => {
    const archive = path.join(archiveDir!, 'c.tgz');
    extract(archive, createHash('sha256').update(fs.readFileSync(archive)).digest('hex'), (result) => {
      expect(result.status).not.toBe(0);
    });
  });
  it('refuses an incorrect package checksum', () => {
    extract(path.join(archiveDir!, 'pkg.tgz'), '0'.repeat(64), (result) => expect(result.status).not.toBe(0));
  });
});
