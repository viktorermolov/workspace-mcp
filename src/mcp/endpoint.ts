import { requireMcpAuth } from '@better-auth/mcp';
import { createMcpHandler } from '@modelcontextprotocol/server';
import type { Auth } from '../auth/auth.ts';
import { checkAccess, touchConnection } from '../auth/connections.ts';
import { recordDiag } from '../auth/diagnostics.ts';
import type { Config } from '../config.ts';
import type { DB } from '../db/db.ts';
import type { Actor } from '../domain/core.ts';
import { memberByUser } from '../domain/entities.ts';
import { log } from '../util/log.ts';
import { buildMcpServer } from './server.ts';

export const MAX_MCP_BODY = 1024 * 1024;

/**
 * /mcp: verifies the bearer token (signature, issuer, audience = this resource, expiry) with better-auth,
 * then checks that the connection is still approved, then serves the request statelessly.
 */
export function createMcpEndpoint(opts: { config: Config; db: DB; auth: Auth; version: string }) {
  const { config, db, auth, version } = opts;
  const metadataUrl = `${config.publicUrl}/.well-known/oauth-protected-resource/mcp`;

  const mcp = createMcpHandler(
    ({ authInfo }) => {
      const actor = authInfo?.extra?.actor as Actor | undefined;
      if (!actor) throw new Error('unauthenticated MCP request reached the server factory');
      return buildMcpServer(db, () => actor, version, config.sourceUrl);
    },
    {
      maxRequestBodySize: MAX_MCP_BODY,
      onerror: (e) => log.warn('mcp request error', { error: e.message }),
    },
  );

  const denied = (clientId: string | undefined, reason: string) => {
    recordDiag(db, { client_id: clientId ?? null, step: 'mcp', method: 'POST', path: '/mcp', status: 401, outcome: 'error', detail: { reason } });
    return new Response(JSON.stringify({ jsonrpc: '2.0', error: { code: -32001, message: `Unauthorized: ${reason}` }, id: null }), {
      status: 401,
      headers: {
        'content-type': 'application/json',
        'www-authenticate': `Bearer error="invalid_token", error_description="${reason}", resource_metadata="${metadataUrl}"`,
      },
    });
  };

  const handler = requireMcpAuth(
    auth,
    async (request, claims) => {
      const clientId = (claims.azp ?? claims.client_id) as string | undefined;
      const check = checkAccess(db, clientId, claims.iat);
      if (!check.ok) return denied(clientId, check.reason);
      const member = typeof claims.sub === 'string' ? memberByUser(db, claims.sub) : undefined;
      if (!member) return denied(clientId, 'unknown user');
      const first = !check.connection.last_activity_at;
      touchConnection(db, check.connection.client_id);
      if (first) recordDiag(db, { client_id: clientId, step: 'mcp', method: request.method, path: '/mcp', status: 200, outcome: 'ok', detail: { first_call: true } });
      const actor: Actor = { kind: 'agent', memberId: member.id, connectionId: check.connection.client_id, connectionName: check.connection.name };
      const scopes = typeof claims.scope === 'string' ? claims.scope.split(' ').filter(Boolean) : [];
      return mcp.fetch(request, {
        authInfo: {
          token: 'verified',
          clientId: check.connection.client_id,
          scopes,
          expiresAt: typeof claims.exp === 'number' ? claims.exp : undefined,
          resource: new URL(config.mcpUrl),
          extra: { actor },
        },
      });
    },
    { resource: config.mcpUrl },
  );

  return {
    fetch: async (request: Request) => {
      const res = await handler(request);
      if (res.status === 401 && !request.headers.get('authorization')) {
        recordDiag(db, { step: 'mcp', method: request.method, path: '/mcp', status: 401, outcome: 'error', detail: { reason: 'no token (expected first step: discovery)' } });
      }
      return res;
    },
    close: () => mcp.close(),
  };
}
