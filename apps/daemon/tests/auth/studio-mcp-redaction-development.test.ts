// S60: stored account MCP secrets never leak (NODE_ENV=development).
import { studioMcpRedactionSuite } from './studio-mcp-redaction-suite.js';

studioMcpRedactionSuite('development');
