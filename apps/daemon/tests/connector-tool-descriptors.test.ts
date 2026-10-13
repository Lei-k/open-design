// S60 A6: desktop connector tool descriptors are byte-identical to S59; Studio
// runs get a variant without the `"$OD_BIN" tools connectors …` fallback, which
// does not exist inside a Studio run.
import { createHash } from 'node:crypto';
import { expect, it } from 'vitest';
import * as descriptors from '../src/connectors/tool-descriptors.js';

const DESKTOP_SHA256_AT_S59 = '5a203932138ffb6a922fe721ed04b6ddeb9fb31551cd76599b4deec68c8fbfec';

it('keeps the desktop descriptors byte-for-byte unchanged', () => {
  expect(createHash('sha256').update(JSON.stringify(descriptors.CONNECTOR_TOOL_DESCRIPTORS)).digest('hex')).toBe(DESKTOP_SHA256_AT_S59);
});

it('gives Studio runs the same tools and schemas without any CLI fallback', () => {
  const studio = (descriptors as Record<string, unknown>).STUDIO_CONNECTOR_TOOL_DESCRIPTORS as typeof descriptors.CONNECTOR_TOOL_DESCRIPTORS | undefined;
  expect(studio).toBeDefined();
  expect(studio!.map((tool) => tool.name)).toEqual(descriptors.CONNECTOR_TOOL_DESCRIPTORS.map((tool) => tool.name));
  expect(studio!.map((tool) => tool.inputSchema)).toEqual(descriptors.CONNECTOR_TOOL_DESCRIPTORS.map((tool) => tool.inputSchema));
  for (const tool of studio!) {
    expect(tool.description).not.toMatch(/OD_BIN|OD_NODE_BIN|POSIX equivalent|tools connectors/);
    expect(tool.description).toMatch(/no command-line fallback/i);
  }
});
