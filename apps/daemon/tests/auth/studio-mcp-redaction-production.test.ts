// S60: stored account MCP secrets never leak (NODE_ENV=production).
import { studioMcpRedactionSuite } from './studio-mcp-redaction-suite.js';

studioMcpRedactionSuite('production');
