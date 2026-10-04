import type { Express } from 'express';

export interface RouteRegistration {
  method: string;
  path: string;
}

const routeInventorySymbol = Symbol.for('open-design.routeInventory');
const patternRouteInventorySymbol = Symbol.for('open-design.patternRouteInventory');
const pathlessRouteInventorySymbol = Symbol.for('open-design.pathlessRouteInventory');
const pathlessUseLabelSymbol = Symbol.for('open-design.pathlessUseLabel');

/** Label a pathless middleware for the multi-user startup classification. */
export function acknowledgePathlessUse<T extends Function>(handler: T, label: string): T {
  (handler as T & { [pathlessUseLabelSymbol]?: string })[pathlessUseLabelSymbol] = label;
  return handler;
}

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
  const pathlessInventory: RouteRegistration[] = [];
  const pathlessCounts = new Map<string, number>();
  (app as unknown as { [routeInventorySymbol]: RouteRegistration[] })[routeInventorySymbol] = inventory;
  (app as unknown as { [patternRouteInventorySymbol]: RouteRegistration[] })[patternRouteInventorySymbol] =
    patternInventory;
  (app as unknown as { [pathlessRouteInventorySymbol]: RouteRegistration[] })[pathlessRouteInventorySymbol] =
    pathlessInventory;

  for (const method of guardedMethods) {
    const original = (app as any)[method].bind(app) as (...args: unknown[]) => unknown;
    (app as any)[method] = (path: unknown, ...handlers: unknown[]) => {
      if (typeof path === 'string') {
        inventory.push({ method: method.toUpperCase(), path });
      } else if (path instanceof RegExp || (Array.isArray(path) && (
        method !== 'use' || path.every((part) => typeof part === 'string' || part instanceof RegExp)
      ))) {
        patternInventory.push({ method: method.toUpperCase(), path: String(path) });
      } else if (method === 'use') {
        const flatten = (item: unknown): void => {
          if (Array.isArray(item)) {
            item.forEach(flatten);
            return;
          }
          const labelled = item as { [pathlessUseLabelSymbol]?: string } | null;
          const label = typeof item === 'function' && labelled?.[pathlessUseLabelSymbol]
            ? labelled[pathlessUseLabelSymbol] : 'unclassified';
          const count = (pathlessCounts.get(label) ?? 0) + 1;
          pathlessCounts.set(label, count);
          pathlessInventory.push({ method: 'USE', path: `<pathless:${label}:${count}>` });
        };
        flatten(path);
        handlers.forEach(flatten);
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

export function getPathlessRouteRegistrationInventory(app: Express): RouteRegistration[] {
  return [
    ...((app as unknown as { [pathlessRouteInventorySymbol]?: RouteRegistration[] })[pathlessRouteInventorySymbol] ?? []),
  ];
}
