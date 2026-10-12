import { readFileSync } from 'node:fs';
import { expect, it } from 'vitest';
import { en } from '../../src/i18n/locales/en';
import { LOCALES, type Dict } from '../../src/i18n/types';

const keys: Array<keyof Dict> = ['studio.libraryPairTitle', 'studio.libraryStudioUrl', 'studio.libraryCopyUrl',
  'studio.libraryUrlCopied', 'studio.libraryUrlCopyFailed', 'studio.libraryPairedExtensions', 'studio.libraryRevokeLabel'];

it.each(LOCALES)('supplies explicit Library pairing copy and the token label placeholder in %s', async (locale) => {
  const module = await import(`../../src/i18n/locales/${locale}.ts`);
  const dict = Object.values(module).find((value): value is Dict => Boolean(value) && typeof value === 'object');
  if (!dict) throw new Error(`Missing ${locale} dictionary`);
  const source = readFileSync(new URL(`../../src/i18n/locales/${locale}.ts`, import.meta.url), 'utf8');
  const explicit = new Set(Array.from(source.matchAll(/^\s*['"]([^'"]+)['"]:/gm), (match) => match[1] ?? ''));
  for (const key of keys) {
    expect(explicit.has(key), `${locale}.${key} must not fall back to English`).toBe(true);
    expect(dict[key].trim(), `${locale}.${key}`).not.toBe('');
    if (locale !== 'en') expect(dict[key], `${locale}.${key}`).not.toBe(en[key]);
  }
  expect(dict['studio.libraryRevokeLabel']).toContain('{label}');
});
