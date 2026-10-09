import type { SkillDetail } from '@open-design/contracts';
import { expect, it } from 'vitest';
import { captureStudioPluginSkillContext } from '../../src/plugins/studio-skill-context.js';
import { buildStudioSkillPackage } from '../../src/services/studio-skill-packages.js';

const skill = { id: 'bundled', name: 'Bundled', source: 'built-in', body: 'CAPTURED_BODY' } as SkillDetail;
const resource = () => buildStudioSkillPackage(skill.id, [{ path: 'SKILL.md', bytes: Buffer.from('---\nname: bundled\n---\nCAPTURED_BODY'), executable: false },
  { path: 'scripts/build.py', bytes: Buffer.from('print("captured")'), executable: true }]);
it('keeps immutable script permissions and skill-relative paths in a stable namespace', () => {
  const captured = captureStudioPluginSkillContext({ ...skill, package: resource() });
  expect(captured.prompt).toContain('CAPTURED_BODY'); expect(captured.prompt).toContain(captured.files[0]!.name.slice(0, -'SKILL.md'.length));
  expect(captured.files[1]).toMatchObject({ name: expect.stringMatching(/^opendesign-context\/skill-[a-f0-9]{32}\/scripts\/build.py$/), executable: true });
  expect(captureStudioPluginSkillContext({ ...skill, package: resource() })).toEqual(captured);
});
it('refuses corrupt packages, mismatched bodies and live-folder fallbacks', () => {
  const corrupt = resource(); corrupt.files[1]!.data = Buffer.from('changed').toString('base64');
  for (const detail of [skill, { ...skill, package: corrupt }, { ...skill, body: 'DIFFERENT', package: resource() },
    { ...skill, body: 'x'.repeat(256 * 1024 + 1), package: resource() }, { ...skill, body: '', package: resource() }]) {
    expect(() => captureStudioPluginSkillContext(detail)).toThrow();
  }
});
it('synthesizes only an authorized account text document when no folder was captured', () => {
  const text = captureStudioPluginSkillContext({ ...skill, id: 'studio-skill:private', source: 'user' });
  expect(text.files).toHaveLength(1); expect(text.files[0]!.bytes.toString()).toBe(skill.body);
});
