import type { Express } from 'express';

export interface RouteRegistration {
  method: string;
  path: string;
}

const routeInventorySymbol = Symbol.for('open-design.routeInventory');
const patternRouteInventorySymbol = Symbol.for('open-design.patternRouteInventory');

const guardedRouteKeys = new Set([
  'POST /api/projects/:id/export/pdf',
  'POST /api/projects/:id/media/generate',
]);

const guardedMethods = ['get', 'post', 'put', 'patch', 'delete', 'options', 'all', 'use'] as const;

export function guardedRouteKey(method: string, path: unknown): string | null {
  if (typeof path !== 'string') return null;
  const key = `${method.toUpperCase()} ${path}`;
  return guardedRouteKeys.has(key) ? key : null;
}

export function installRouteRegistrationGuard(app: Express): void {
  const seen = new Set<string>();
  const inventory: RouteRegistration[] = [];
  // Routes registered with a RegExp (or an array of paths) are not part of
  // the string inventory; they are recorded separately (as `String(path)`) so
  // reviewers — and the multi-user route classification — can see them.
  const patternInventory: RouteRegistration[] = [];
  (app as unknown as { [routeInventorySymbol]: RouteRegistration[] })[routeInventorySymbol] = inventory;
  (app as unknown as { [patternRouteInventorySymbol]: RouteRegistration[] })[patternRouteInventorySymbol] =
    patternInventory;

  for (const method of guardedMethods) {
    const original = (app as any)[method].bind(app) as (...args: unknown[]) => unknown;
    (app as any)[method] = (path: unknown, ...handlers: unknown[]) => {
      if (typeof path === 'string') {
        inventory.push({ method: method.toUpperCase(), path });
      } else if (path instanceof RegExp || Array.isArray(path)) {
        patternInventory.push({ method: method.toUpperCase(), path: String(path) });
      }
      const key = guardedRouteKey(method, path);
      if (key) {
        if (seen.has(key)) {
          throw new Error(`duplicate guarded route registration: ${key}`);
        }
        seen.add(key);
      }
      return original(path, ...handlers);
    };
  }
}

export function getRouteRegistrationInventory(app: Express): RouteRegistration[] {
  return [
    ...((app as unknown as { [routeInventorySymbol]?: RouteRegistration[] })[routeInventorySymbol] ?? []),
  ];
}

export function getPatternRouteRegistrationInventory(app: Express): RouteRegistration[] {
  return [
    ...((app as unknown as { [patternRouteInventorySymbol]?: RouteRegistration[] })[patternRouteInventorySymbol] ?? []),
  ];
}
