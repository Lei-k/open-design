import fs from 'node:fs';
import path from 'node:path';
import type { Express } from 'express';

/** Public code only. No generic static root or SPA catch-all is authorized. */
export const MULTIUSER_SHELL_PATHS = ['/', '/login', '/setup', '/projects', '/admin/users', '/admin/audit'] as const;
export const MULTIUSER_ASSET_PATHS = ['/app-icon.png', '/fonts/AlbertSans-VariableFont_wght.ttf', '/fonts/AlbertSans-Italic-VariableFont_wght.ttf', '/fonts/JiduMonoPro-Regular.otf'] as const;
export const MULTIUSER_BUILD_ASSET_ROUTE = '/_next/static/*asset';

export function publicMultiUserFile(rawPath: string): string | null {
  // Require one canonical spelling; never decode path separators or dot segments.
  if (rawPath.includes('%') || rawPath.includes('\\') || rawPath.includes('//')) return null;
  if ((MULTIUSER_SHELL_PATHS as readonly string[]).includes(rawPath)) return 'index.html';
  if ((MULTIUSER_ASSET_PATHS as readonly string[]).includes(rawPath)) return rawPath.slice(1);
  if (!/^\/_next\/static\/(?:chunks|media)\/[A-Za-z0-9_.~-]+\.(?:js|css|woff2?|ttf|otf|png|svg)$/.test(rawPath)) return null;
  if (rawPath.split('/').some((part) => part === '.' || part === '..')) return null;
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
      if (!file || !regularPublicFile(staticDir, file)) { res.status(404).end(); return; }
      res.sendFile(file, { root: staticDir, dotfiles: 'deny' });
    });
  }
}
