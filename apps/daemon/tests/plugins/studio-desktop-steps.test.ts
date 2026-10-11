// S67 repair 1 (#61/#63): no dead plugins on Web. The desktop-step detector
// reads a plugin's captured Markdown (SKILL.md and bundled references) and
// returns typed capability reasons for core steps no Studio turn performs. It
// fails closed: conditional branches and unreadable packages refuse as well.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { detectStudioDesktopSteps, readStudioPluginDocuments, studioPluginPackageDocuments,
  STUDIO_PLUGIN_DOCUMENT_LIMITS } from '../../src/plugins/studio-desktop-steps.js';
import { buildStudioSkillPackage } from '../../src/services/studio-skill-packages.js';

const subjects = (...texts: string[]) => detectStudioDesktopSteps(texts.map((text, index) => ({ path: `doc-${index}.md`, text })))
  .map((reason) => { expect(reason.code).toBe('capability'); return reason.subject; });
const REPO_PLUGINS = path.resolve('../..', 'plugins/_official');
const roots: string[] = [];
afterEach(() => { for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true }); });
const tree = (files: Record<string, string | Buffer>) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'studio-desktop-steps-'));
  roots.push(root);
  for (const [name, body] of Object.entries(files)) {
    fs.mkdirSync(path.dirname(path.join(root, name)), { recursive: true });
    fs.writeFileSync(path.join(root, name), body);
  }
  return root;
};

describe('detectStudioDesktopSteps', () => {
  it('names each desktop-only core step with its typed reason', () => {
    // `od media scaffold` is also an `od` subcommand with no Studio function.
    expect(subjects('Run `"$OD_BIN" media scaffold --project "$OD_PROJECT_ID"` first.')).toEqual(['desktop:media-scaffold', 'desktop:od-cli']);
    expect(subjects('The composition comes from media scaffold output.')).toEqual(['desktop:media-scaffold']);
    expect(subjects('Render with `--model hyperframes-html --composition-dir "$COMP"`.')).toEqual(['desktop:html-video-render']);
    expect(subjects('Then `npx hyperframes render` the composition.')).toEqual(['desktop:html-video-render']);
    expect(subjects('```bash\nod media generate --surface audio --audio-kind "<music|speech|sfx>"\n```')).toEqual(['desktop:music-sfx-audio']);
    expect(subjects('Invoke `$imagegen` for each job.')).toEqual(['desktop:codex-tool']);
    expect(subjects('```bash\npython "$SKILL_DIR/scripts/prepare_pet_run.py" --force\n```')).toEqual(['desktop:local-script']);
    expect(subjects('```sh\n./scripts/build.sh\n```')).toEqual(['desktop:local-script']);
    expect(subjects('Run `od plugin validate`, then `od plugin pack`.')).toEqual(['desktop:od-cli']);
  });

  it('fails closed on conditional and negative mentions', () => {
    // A conditional branch is still a core step the plugin may require.
    expect(subjects('If the user wants a rendered MP4, dispatch `od media generate --surface video --model hyperframes-html`.'))
      .toEqual(['desktop:html-video-render']);
    // So is a command the skill tells the model not to suggest.
    expect(subjects('Do NOT suggest follow-up commands such as `od plugin publish`.')).toEqual(['desktop:od-cli']);
  });

  it('keeps the steps Studio functions perform, and prose outside code, open', () => {
    expect(subjects('```bash\n"$OD_NODE_BIN" "$OD_BIN" media generate --surface image --output hero.png\n```')).toEqual([]);
    expect(subjects('Register it with `od tools live-artifacts create --input request.json`.')).toEqual([]);
    expect(subjects('Każdy kadr od lewej do prawej; python is a language and od is a word here.')).toEqual([]);
    expect(subjects('Use `node -e \'console.log(1)\'` to print JSON.')).toEqual([]);
    expect(subjects('Write each frame as HTML with HyperFrames-style timing comments for a later Remotion render step.')).toEqual([]);
    expect(subjects('Narrate it: `od media generate --surface audio --audio-kind speech`.')).toEqual([]);
  });

  it('reports every step across documents once, sorted', () => {
    expect(subjects('`$imagegen`', 'Run `python scripts/a.py` and `$imagegen` again.', '`od media scaffold`'))
      .toEqual(['desktop:codex-tool', 'desktop:local-script', 'desktop:media-scaffold', 'desktop:od-cli']);
  });
});

describe('plugin package documents', () => {
  it('reads every Markdown document of a plugin folder and skips other files, hidden entries and node_modules', () => {
    const root = tree({ 'SKILL.md': '# Skill', 'references/notes.md': 'Notes', 'example.html': '<h1>od plugin install</h1>',
      '.hidden/secret.md': '`$imagegen`', 'node_modules/x/README.md': '`$imagegen`' });
    expect(readStudioPluginDocuments(root)).toEqual([{ path: 'SKILL.md', text: '# Skill' }, { path: 'references/notes.md', text: 'Notes' }]);
  });

  it('fails closed on unreadable, linked, invalid or oversized packages', () => {
    expect(readStudioPluginDocuments('')).toBeNull();
    expect(readStudioPluginDocuments('relative/path')).toBeNull();
    expect(readStudioPluginDocuments(path.join(os.tmpdir(), 'studio-desktop-steps-missing'))).toBeNull();
    expect(readStudioPluginDocuments(tree({ 'SKILL.md': Buffer.from([0xff, 0xfe]) }))).toBeNull();
    expect(readStudioPluginDocuments(tree({ 'SKILL.md': 'x'.repeat(STUDIO_PLUGIN_DOCUMENT_LIMITS.fileBytes + 1) }))).toBeNull();
    const linked = tree({ 'real.txt': '`$imagegen`' });
    fs.symlinkSync(path.join(linked, 'real.txt'), path.join(linked, 'SKILL.md'));
    expect(readStudioPluginDocuments(linked)).toBeNull();
  });

  it('reads the plugin\'s own Markdown from a pinned package, not captured catalog context', () => {
    const pinned = buildStudioSkillPackage('studio-plugin:fixture@1.0.0', [
      { path: 'SKILL.md', bytes: Buffer.from('Run `od plugin install --source x`.'), executable: false },
      { path: 'opendesign-context/design-brand/DESIGN.md', bytes: Buffer.from('`$imagegen`'), executable: false },
      { path: 'scripts/run.py', bytes: Buffer.from('print(1)'), executable: true },
    ]);
    expect(studioPluginPackageDocuments(pinned)).toEqual([{ path: 'SKILL.md', text: 'Run `od plugin install --source x`.' }]);
    expect(studioPluginPackageDocuments(undefined)).toEqual([]);
    const corrupt = buildStudioSkillPackage('studio-plugin:fixture@1.0.0', [{ path: 'SKILL.md', bytes: Buffer.from([0xff]), executable: false }]);
    expect(studioPluginPackageDocuments(corrupt)).toBeNull();
  });
});

describe('the bundled catalog', () => {
  // Every plugin S67 made applicable, plus the S42 pipeline plugin, against the shipped packages.
  const expected: Record<string, string[]> = {
    'example-audio-jingle': ['desktop:music-sfx-audio'],
    'example-hatch-pet': ['desktop:codex-tool', 'desktop:local-script'],
    'example-hyperframes': ['desktop:html-video-render', 'desktop:local-script', 'desktop:media-scaffold', 'desktop:od-cli'],
    'example-video-shortform': ['desktop:html-video-render'],
    'od-share-to-community': ['desktop:od-cli'],
    'example-image-poster': [], 'example-frame-glitch-title': [], 'example-frame-data-chart-nyt': [], 'example-frame-flowchart-sticky': [],
    'example-frame-light-leak-cinema': [], 'example-frame-liquid-bg-hero': [], 'example-frame-logo-outro': [],
    'example-frame-macos-notification': [], 'example-vfx-text-cursor': [], 'example-video-hyperframes': [],
  };
  const folder = (id: string) => {
    for (const group of fs.readdirSync(REPO_PLUGINS)) {
      for (const name of [id, id.replace(/^example-/, '')]) {
        const candidate = path.join(REPO_PLUGINS, group, name);
        if (fs.existsSync(path.join(candidate, 'open-design.json'))
          && JSON.parse(fs.readFileSync(path.join(candidate, 'open-design.json'), 'utf8')).name === id) return candidate;
      }
    }
    throw new Error(`bundled plugin ${id} not found`);
  };
  it.each(Object.entries(expected))('detects exactly the desktop-only core steps of %s', (id, steps) => {
    const documents = readStudioPluginDocuments(folder(id));
    expect(documents).not.toBeNull();
    expect(detectStudioDesktopSteps(documents!).map((reason) => reason.subject)).toEqual(steps);
  });
});
