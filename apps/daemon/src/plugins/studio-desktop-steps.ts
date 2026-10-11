// Studio (multi-user Web) desktop-only step detector, S67 repair 1 (#61/#63).
//
// Coordinator decision: no dead plugins. A plugin is not applicable on Web when
// its captured package instructs a core step that no Studio turn can perform,
// even if every atom and capability its manifest declares is supported. The
// manifest under-declares these steps, so this detector reads the package the
// worker would read: every Markdown document of the plugin (SKILL.md bodies
// and bundled references). It is evaluated identically at catalog, at apply
// (pinned into the immutable application's requirements) and at run admission
// (over the pinned package). Nothing is keyed by plugin id.
//
// Rules are deliberately small and fail closed: a step mentioned at all,
// including inside a conditional branch ("if the user asks for an MP4, run …")
// or a negative example, counts. Distinctive tokens match anywhere; generic
// shell/CLI shapes (`python x.py`, `od plugin …`) match only inside Markdown
// code spans or fenced blocks, so prose (e.g. Polish "od") never trips them.
// A package that cannot be read within bounds is itself a refusal.
//
// Repair 2 (review P3): each inline code span and each logical line of a
// fenced block is one command, evaluated on its own. A span that only names
// something (the `od` executable, an `accent` token, a `$` prompt) is a
// description, not a step; joining separate spans used to invent commands out
// of unrelated prose ("named `od`. … token `accent`" read as `od accent`).

import fs from 'node:fs';
import path from 'node:path';
import type { StudioPluginUnavailableReason } from '@open-design/contracts';
import type { StudioSkillPackage } from '../services/studio-skill-packages.js';

/** One Markdown document of a plugin package, by package-relative path. */
export interface StudioPluginDocument { path: string; text: string }

/**
 * Desktop-only steps, reported as `capability` reasons with a `desktop:` subject.
 * - `desktop:media-scaffold`: `od media scaffold` composition scaffolding.
 * - `desktop:html-video-render`: HyperFrames/Remotion HTML-to-video rendering
 *   (`hyperframes-html`, `--composition-dir` anywhere; `npx hyperframes`,
 *   `hyperframes|remotion render` in code).
 * - `desktop:music-sfx-audio`: music or sound-effect audio (`--audio-kind music|sfx`);
 *   Studio generates speech only.
 * - `desktop:codex-tool`: Codex-only built-in tools (`$imagegen`, `image_gen`).
 * - `desktop:local-script`: running an interpreter on a script file or `./x.sh`.
 * - `desktop:od-cli`: an `od` / `$OD_BIN` subcommand with no Studio function. Only
 *   `od media generate` (S34 functions) and `od tools live-artifacts` (S52 tools) map.
 */
export const STUDIO_DESKTOP_STEP_SUBJECTS = ['desktop:codex-tool', 'desktop:html-video-render', 'desktop:local-script',
  'desktop:media-scaffold', 'desktop:music-sfx-audio', 'desktop:od-cli'] as const;
export type StudioDesktopStepSubject = typeof STUDIO_DESKTOP_STEP_SUBJECTS[number];

const ANYWHERE: ReadonlyArray<[StudioDesktopStepSubject, RegExp]> = [
  ['desktop:media-scaffold', /\bmedia\s+scaffold\b/],
  ['desktop:html-video-render', /hyperframes-html|--composition-dir\b/i],
  ['desktop:music-sfx-audio', /--audio-kind\b[^\n]*\b(?:music|sfx)\b/i],
  ['desktop:codex-tool', /\$imagegen\b|\bimage_gen\b/],
];
// Command shapes, matched within one command (see `commandsOf`): whitespace
// between words is horizontal only, so no rule reaches into another line.
const SCRIPT = /(?:^|[\s(;|&"'])(?:python3?|bash|sh|zsh|node|deno|bun|ruby|perl|tsx|ts-node)[ \t]+(?:-[\w-]+[ \t]+)*["']?(?:\$\{?\w+\}?\/|~\/|\.{0,2}\/|[\w.-]+\/)?[\w.${}/-]*\.(?:py|sh|bash|zsh|js|mjs|cjs|ts|rb|pl)\b|(?:^|[\s(;|&"'])\.\/[\w./-]+\.(?:py|sh|bash)\b/;
const OD_COMMAND = /(?:^|[\s(;|&"'])(?:od|\$\{?OD_BIN\}?)["']?[ \t]+([a-z][\w-]*)(?:[ \t]+([a-z][\w-]*))?/g;
const OD_MAPPED = new Set(['media generate', 'tools live-artifacts']);
const RENDER_CLI = /\bnpx[ \t]+(?:-y[ \t]+)?(?:hyperframes|remotion)\b|\b(?:hyperframes|remotion)[ \t]+render\b/i;
const FENCED = /^(```|~~~)[^\n]*\n([\s\S]*?)^\1/gm;

/**
 * The commands of a Markdown document, each evaluated on its own: every inline
 * code span, and every logical line of a fenced block (a trailing `\` joins
 * the next line, as a shell does). Never a concatenation of separate units.
 */
function commandsOf(text: string): string[] {
  const fenced = [...text.matchAll(FENCED)].flatMap((match) => match[2]!.replace(/\\\r?\n[ \t]*/g, ' ').split(/\r?\n/));
  const inline = [...text.replace(FENCED, '').matchAll(/`([^`\n]+)`/g)].map((match) => match[1]!);
  return [...fenced, ...inline].filter((command) => command.trim().length > 0);
}

/** Typed reasons for every desktop-only step any document instructs, sorted. */
export function detectStudioDesktopSteps(documents: readonly StudioPluginDocument[]): StudioPluginUnavailableReason[] {
  const found = new Set<StudioDesktopStepSubject>();
  for (const document of documents) {
    for (const [subject, pattern] of ANYWHERE) if (pattern.test(document.text)) found.add(subject);
    for (const command of commandsOf(document.text)) {
      if (SCRIPT.test(command)) found.add('desktop:local-script');
      if (RENDER_CLI.test(command)) found.add('desktop:html-video-render');
      for (const match of command.matchAll(OD_COMMAND)) {
        if (!OD_MAPPED.has(`${match[1]} ${match[2] ?? ''}`.trim())) found.add('desktop:od-cli');
      }
    }
  }
  return [...found].sort().map((subject) => ({ code: 'capability', subject }));
}

/** Bounds for reading a plugin's Markdown; exceeding any of them fails closed. */
export const STUDIO_PLUGIN_DOCUMENT_LIMITS = { files: 256, fileBytes: 256 * 1024, totalBytes: 4 * 1024 * 1024, depth: 16 } as const;
const isDocument = (name: string) => /\.(?:md|markdown)$/i.test(name);

/**
 * Every Markdown document under a bundled plugin folder: no symbolic links,
 * hidden entries or `node_modules`, strict UTF-8, within the bounds above.
 * Null when the folder cannot be read completely; callers refuse the plugin.
 */
export function readStudioPluginDocuments(folder: string): StudioPluginDocument[] | null {
  const out: StudioPluginDocument[] = [];
  let total = 0;
  const decoder = new TextDecoder('utf-8', { fatal: true });
  const walk = (directory: string, relative: string, depth: number): boolean => {
    if (depth > STUDIO_PLUGIN_DOCUMENT_LIMITS.depth) return false;
    let entries: fs.Dirent[];
    try { entries = fs.readdirSync(directory, { withFileTypes: true }); } catch { return false; }
    for (const entry of entries.sort((a, b) => (a.name < b.name ? -1 : 1))) {
      if (entry.name.startsWith('.') || entry.name === 'node_modules') continue;
      const name = relative ? `${relative}/${entry.name}` : entry.name;
      if (entry.isSymbolicLink()) { if (isDocument(entry.name)) return false; continue; }
      if (entry.isDirectory()) { if (!walk(path.join(directory, entry.name), name, depth + 1)) return false; continue; }
      if (!entry.isFile() || !isDocument(entry.name)) continue;
      let bytes: Buffer;
      try { bytes = fs.readFileSync(path.join(directory, entry.name)); } catch { return false; }
      total += bytes.length;
      if (out.length >= STUDIO_PLUGIN_DOCUMENT_LIMITS.files || bytes.length > STUDIO_PLUGIN_DOCUMENT_LIMITS.fileBytes
        || total > STUDIO_PLUGIN_DOCUMENT_LIMITS.totalBytes) return false;
      try { out.push({ path: name, text: decoder.decode(bytes) }); } catch { return false; }
    }
    return true;
  };
  if (!folder || !path.isAbsolute(folder)) return null;
  return walk(folder, '', 0) ? out : null;
}

/**
 * The plugin's own Markdown documents in a pinned application package. Context
 * the application captured from catalogs (`opendesign-context/…`: design
 * systems and referenced skills) is not part of the plugin package. Null when a
 * pinned document is not strict UTF-8; callers refuse the plugin.
 */
export function studioPluginPackageDocuments(resource: StudioSkillPackage | undefined): StudioPluginDocument[] | null {
  if (!resource) return [];
  const decoder = new TextDecoder('utf-8', { fatal: true });
  const out: StudioPluginDocument[] = [];
  for (const file of resource.files) {
    if (!isDocument(file.path) || file.path.startsWith('opendesign-context/')) continue;
    try { out.push({ path: file.path, text: decoder.decode(Buffer.from(file.data, 'base64')) }); } catch { return null; }
  }
  return out;
}

/** The refusal for a package the detector cannot read completely. */
export const STUDIO_PLUGIN_PACKAGE_UNREADABLE: StudioPluginUnavailableReason = { code: 'context', subject: 'package' };
