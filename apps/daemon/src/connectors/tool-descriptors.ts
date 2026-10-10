type JsonObject = Record<string, unknown>;

const CONNECTORS_LIST_INPUT_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  properties: {
    useCase: { type: 'string', enum: ['personal_daily_digest'] },
  },
} satisfies JsonObject;

/** Shared desktop and Studio connector tools; transport binds execution authority. */
export const CONNECTOR_TOOL_DESCRIPTORS = [
  {
    name: 'connectors_list',
    description: 'List connector catalog and available read-only tools through the daemon tool endpoint. Use `{ "useCase": "personal_daily_digest" }` for curated daily-digest tools. POSIX equivalent: `"$OD_NODE_BIN" "$OD_BIN" tools connectors list --use-case personal_daily_digest --format compact` or fallback `"$OD_NODE_BIN" "$OD_BIN" tools connectors list --format compact`.',
    inputSchema: CONNECTORS_LIST_INPUT_SCHEMA,
  },
  {
    name: 'connectors_execute',
    description: 'Execute an allowed connector read tool through the daemon tool endpoint. POSIX equivalent: `"$OD_NODE_BIN" "$OD_BIN" tools connectors execute --connector <id> --tool <name> --input input.json`.',
    inputSchema: {
      type: 'object',
      additionalProperties: false,
      required: ['connectorId', 'toolName', 'input'],
      properties: {
        connectorId: { type: 'string', minLength: 1 },
        toolName: { type: 'string', minLength: 1 },
        input: { type: 'object', additionalProperties: true },
      },
    },
  },
];
