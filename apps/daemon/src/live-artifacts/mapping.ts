// Pure bounded JSON mapping. No filesystem, connector, credential or process access.
import type { BoundedJsonObject, BoundedJsonValue, LiveArtifactSource } from './schema.js';
import { validateBoundedJsonObject } from './schema.js';

export interface ApplyLiveArtifactOutputMappingOptions {
  source: LiveArtifactSource;
  output: BoundedJsonObject;
}

export function asBoundedRefreshOutput(value: BoundedJsonObject): BoundedJsonObject {
  const result = validateBoundedJsonObject(value, 'localRefreshOutput');
  if (!result.ok) {
    const firstIssue = result.issues[0];
    throw new Error(firstIssue === undefined ? result.error : `${firstIssue.path}: ${firstIssue.message}`);
  }
  return result.value;
}

const SAFE_MAPPING_SEGMENT = /^[A-Za-z_][A-Za-z0-9_-]*$|^(?:0|[1-9][0-9]*)$/;
const UNSAFE_MAPPING_SEGMENTS = new Set(['__proto__', 'prototype', 'constructor']);

function parseMappingPath(path: string, field: string): string[] {
  const normalized = path.startsWith('$.') ? path.slice(2) : path;
  if (normalized.length === 0 || normalized.startsWith('.') || normalized.endsWith('.') || normalized.includes('..')) {
    throw new Error(`${field} must be a dot-separated JSON path`);
  }
  const segments = normalized.split('.');
  for (const segment of segments) {
    if (!SAFE_MAPPING_SEGMENT.test(segment) || UNSAFE_MAPPING_SEGMENTS.has(segment)
      || /^\d+$/.test(segment) && (!Number.isSafeInteger(Number(segment)) || Number(segment) >= 500)) {
      throw new Error(`${field} contains unsupported JSON path segment: ${segment}`);
    }
  }
  return segments;
}

export function isJsonObject(value: BoundedJsonValue | undefined): value is BoundedJsonObject {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function readMappedValue(root: BoundedJsonObject, path: string): BoundedJsonValue | undefined {
  let current: BoundedJsonValue | undefined = root;
  for (const segment of parseMappingPath(path, 'outputMapping.dataPaths.from')) {
    if (Array.isArray(current)) {
      const index = Number(segment);
      if (!Number.isSafeInteger(index) || index < 0) throw new Error(`outputMapping.dataPaths.from array segment is invalid: ${segment}`);
      current = current[index];
    } else if (isJsonObject(current)) {
      current = current[segment];
    } else {
      return undefined;
    }
    if (current === undefined) return undefined;
  }
  return current;
}

function makeContainer(nextSegment: string): BoundedJsonObject | BoundedJsonValue[] {
  return /^(?:0|[1-9][0-9]*)$/.test(nextSegment) ? [] : {};
}

function writeMappedValue(root: BoundedJsonObject, path: string, value: BoundedJsonValue): void {
  const segments = parseMappingPath(path, 'outputMapping.dataPaths.to');
  let current: BoundedJsonObject | BoundedJsonValue[] = root;
  for (let index = 0; index < segments.length; index += 1) {
    const segment = segments[index]!;
    const isLast = index === segments.length - 1;
    if (Array.isArray(current)) {
      const arrayIndex = Number(segment);
      if (!Number.isSafeInteger(arrayIndex) || arrayIndex < 0) throw new Error('outputMapping.dataPaths.to array segments must be non-negative integers');
      if (isLast) {
        current[arrayIndex] = value;
        return;
      }
      const next = current[arrayIndex];
      if (!isJsonObject(next) && !Array.isArray(next)) {
        current[arrayIndex] = makeContainer(segments[index + 1]!);
      }
      current = current[arrayIndex] as BoundedJsonObject | BoundedJsonValue[];
      continue;
    }

    if (isLast) {
      current[segment] = value;
      return;
    }
    const next = current[segment];
    if (!isJsonObject(next) && !Array.isArray(next)) {
      current[segment] = makeContainer(segments[index + 1]!);
    }
    current = current[segment] as BoundedJsonObject | BoundedJsonValue[];
  }
}

export function applyDataPaths(output: BoundedJsonObject, dataPaths: NonNullable<LiveArtifactSource['outputMapping']>['dataPaths']): BoundedJsonObject {
  if (dataPaths === undefined || dataPaths.length === 0) return output;
  const mapped: BoundedJsonObject = {};
  for (const dataPath of dataPaths) {
    const value = readMappedValue(output, dataPath.from);
    if (value !== undefined) writeMappedValue(mapped, dataPath.to, value);
  }
  return mapped;
}

function humanizeKey(key: string): string {
  const spaced = key.replace(/[_-]+/g, ' ').replace(/([a-z0-9])([A-Z])/g, '$1 $2').trim();
  return spaced.length === 0 ? key : spaced.replace(/^./, (char) => char.toUpperCase());
}

function isPrimitive(value: BoundedJsonValue): value is null | boolean | number | string {
  return value === null || typeof value !== 'object';
}

function firstObjectArray(value: BoundedJsonValue): BoundedJsonObject[] | undefined {
  if (Array.isArray(value)) return value.filter(isJsonObject).slice(0, 500);
  if (!isJsonObject(value)) return undefined;
  for (const key of ['rows', 'items', 'matches', 'results', 'data']) {
    const child = value[key];
    if (Array.isArray(child)) return child.filter(isJsonObject).slice(0, 500);
  }
  for (const child of Object.values(value)) {
    const nested = firstObjectArray(child);
    if (nested !== undefined) return nested;
  }
  return undefined;
}

function compactTable(value: BoundedJsonObject): BoundedJsonObject {
  const rows = firstObjectArray(value) ?? [value];
  const keys: string[] = [];
  for (const row of rows) {
    for (const [key, child] of Object.entries(row)) {
      if (keys.length >= 20) break;
      if (!keys.includes(key) && isPrimitive(child)) keys.push(key);
    }
  }
  const compactRows = rows.slice(0, 100).map((row) => Object.fromEntries(keys.map((key) => [key, isPrimitive(row[key] ?? null) ? (row[key] ?? null) : JSON.stringify(row[key])])) as BoundedJsonObject);
  return {
    columns: keys.map((key) => ({ key, label: humanizeKey(key) })),
    rows: compactRows,
    count: rows.length,
    truncated: rows.length > compactRows.length,
  };
}

function findMetricValue(value: BoundedJsonValue): BoundedJsonValue | undefined {
  if (isPrimitive(value) && typeof value !== 'boolean' && value !== null) return value;
  if (Array.isArray(value)) return value.length;
  if (!isJsonObject(value)) return undefined;
  for (const key of ['value', 'count', 'total', 'score', 'amount']) {
    const child = value[key];
    if ((typeof child === 'number' || typeof child === 'string') && child !== '') return child;
  }
  for (const child of Object.values(value)) {
    const found = findMetricValue(child);
    if (found !== undefined) return found;
  }
  return undefined;
}

function optionalPrimitiveString(value: BoundedJsonValue | undefined): string | undefined {
  if (typeof value === 'string' || typeof value === 'number') return String(value);
  return undefined;
}

function metricSummary(value: BoundedJsonObject): BoundedJsonObject {
  const entries = Object.entries(value);
  if (entries.length === 1 && isJsonObject(entries[0]?.[1])) return metricSummary(entries[0][1]);
  const metricValue = findMetricValue(value) ?? '';
  return {
    label: optionalPrimitiveString(value.label) ?? optionalPrimitiveString(value.name) ?? optionalPrimitiveString(value.title) ?? 'Metric',
    value: typeof metricValue === 'number' || typeof metricValue === 'string' ? metricValue : String(metricValue),
    ...(optionalPrimitiveString(value.unit) === undefined ? {} : { unit: optionalPrimitiveString(value.unit)! }),
    ...(optionalPrimitiveString(value.delta) === undefined ? {} : { delta: optionalPrimitiveString(value.delta)! }),
    source: value,
  };
}

export function applyLiveArtifactOutputMapping(options: ApplyLiveArtifactOutputMappingOptions): BoundedJsonObject {
  const mapping = options.source.outputMapping;
  const selected = applyDataPaths(options.output, mapping?.dataPaths);
  if (mapping?.dataPaths !== undefined && mapping.dataPaths.length > 0 && Object.keys(selected).length === 0) {
    return {};
  }
  const transform = mapping?.transform ?? 'identity';
  const transformed = transform === 'identity'
    ? selected
    : transform === 'compact_table'
      ? compactTable(selected)
      : metricSummary(selected);
  return asBoundedRefreshOutput(transformed);
}

