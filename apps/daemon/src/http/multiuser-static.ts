import fs from 'node:fs';
import path from 'node:path';
import type { Express } from 'express';

/** Public code only. No generic static root or SPA catch-all is authorized. */
// Canonical App routes from router.buildPath, plus the public auth/legacy entry.
// e2e/tests/studio-shell-routes.test.ts exercises the cross-runtime contract.
export const MULTIUSER_SHELL_PATHS = [
  '/', '/login', '/setup', '/projects', '/admin/users', '/admin/audit', '/account/agents',
  '/onboarding', '/automations', '/plugins', '/design-systems', '/library', '/brands',
  '/integrations', '/community', '/drafts', '/all-projects', '/members', '/board',
  '/workspace-settings', '/settings', '/marketplace', '/collab-demo',
  '/design-systems/create', '/design-systems/:designSystemId', '/brands/:brandId',
  '/marketplace/:pluginId', '/collab-demo/:projectId',
  '/projects/:projectId', '/projects/:projectId/conversations/:conversationId',
  '/projects/:projectId/files/*file', '/projects/:projectId/conversations/:conversationId/files/*file',
] as const;
export const MULTIUSER_ASSET_PATHS = ['/app-icon.png', '/fonts/AlbertSans-VariableFont_wght.ttf', '/fonts/AlbertSans-Italic-VariableFont_wght.ttf', '/fonts/JiduMonoPro-Regular.otf'] as const;
export const MULTIUSER_BUILD_ASSET_ROUTE = '/_next/static/*asset';

/** encodeURIComponent is the router's sole spelling for a dynamic segment. */
function canonicalSegment(value: string): boolean {
  try {
    const decoded = decodeURIComponent(value);
    return decoded.length > 0 && decoded !== '.' && decoded !== '..'
      && !/[\\/\x00-\x1f\x7f%]/.test(decoded) && encodeURIComponent(decoded) === value;
  } catch { return false; }
}

export function publicMultiUserFile(rawPath: string): string | null {
  if (rawPath.includes('\\') || rawPath.includes('//') || rawPath.includes('?') || rawPath.includes('#')) return null;
  const segments = rawPath.slice(1).split('/');
  for (const route of MULTIUSER_SHELL_PATHS) {
    const pattern = route.slice(1).split('/');
    if (pattern.some((part) => part.startsWith('*')) ? segments.length < pattern.length : segments.length !== pattern.length) continue;
    if (pattern.every((part, index) => part.startsWith('*')
      ? segments.slice(index).every(canonicalSegment)
      : part.startsWith(':') ? canonicalSegment(segments[index]!) : segments[index] === part)) return 'index.html';
  }
  if ((MULTIUSER_ASSET_PATHS as readonly string[]).includes(rawPath)) return rawPath.slice(1);
  if (!/^\/_next\/static\/(?:chunks|media)\/[A-Za-z0-9_.~-]+\.(?:js|css|woff2?|ttf|otf|png|svg)$/.test(rawPath)) return null;
  if (segments.some((part) => part === '.' || part === '..')) return null;
  return rawPath.slice(1);
}

/** Reject symlinks at every level, including links that point back into the root. */
function regularPublicFile(root: string, relative: string): boolean {
  try {
    let current = root;
    if (fs.lstatSync(current).isSymbolicLink()) return false;
    const segments = relative.split('/');
    for (const [index, segment] of segments.entries()) {
      current = path.join(current, segment);
      const stat = fs.lstatSync(current);
      if (stat.isSymbolicLink() || (index === segments.length - 1 ? !stat.isFile() : !stat.isDirectory())) return false;
    }
    return fs.realpathSync(current) === path.join(fs.realpathSync(root), relative);
  } catch { return false; }
}

export function registerMultiUserStatic(app: Express, staticDir: string): void {
  for (const route of [...MULTIUSER_SHELL_PATHS, ...MULTIUSER_ASSET_PATHS, MULTIUSER_BUILD_ASSET_ROUTE]) {
    app.get(route, (req, res) => {
      const file = publicMultiUserFile(req.path);
      res.setHeader('Cache-Control', 'no-store');
      res.setHeader('X-Content-Type-Options', 'nosniff');
      res.setHeader('Referrer-Policy', 'no-referrer');
      res.setHeader('X-Frame-Options', 'DENY');
      if (!file || !regularPublicFile(staticDir, file)) { res.status(404).end(); return; }
      res.sendFile(file, { root: staticDir, dotfiles: 'deny' });
    });
  }
}
