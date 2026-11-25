import { readFileSync } from 'node:fs';

/** Service version from package.json (also reported by /healthz and the MCP server info). */
export const VERSION: string = (JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8')) as { version: string }).version;
