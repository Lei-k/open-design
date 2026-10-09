/** Conservative deployment floor: the pinned build validated for unified_exec and dynamic tools. */
export const STUDIO_CODEX_MINIMUM_VERSION = '0.162.1';
export function codexVersionAtStudioFloor(version: string): boolean {
  const match = /^(\d+)\.(\d+)\.(\d+)(?:\+[\w.-]+)?$/u.exec(version);
  if (!match) return false;
  const parts = match.slice(1).map(Number);
  if (!parts.every(Number.isSafeInteger)) return false;
  const [major, minor, patch] = parts;
  return major! > 0 || (minor! > 162 || (minor === 162 && patch! >= 1));
}
/** The first token describes the running server; later tokens may describe newer clients. */
export function codexDynamicToolsSupported(userAgent: unknown): boolean {
  if (typeof userAgent !== 'string') return false;
  const match = /^[^/\s]+\/([^\s]+)(?:\s|$)/u.exec(userAgent);
  return !!match && codexVersionAtStudioFloor(match[1]!);
}
