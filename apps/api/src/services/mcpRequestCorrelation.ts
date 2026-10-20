/**
 * B-W03 (#6157, D-B19): per-request MCP correlation without sessions.
 *
 * The stateless era has no `Mcp-Session-Id`, so audit and abuse correlation
 * key on the authenticated principal plus a server-minted request UUID. No
 * client-supplied value is ever used as an identifier: `requestId` is minted
 * here, `tokenJti` comes from the verified bearer, and `clientInfo` is
 * bounded, stored only inside `correlation`, and flagged `self_reported`.
 *
 * One record is threaded through the request audit, the tool audit, tenant
 * tool execution and both ledger representations.
 */
import { randomUUID } from 'node:crypto';
import type { McpProtocolVersion } from './mcpProtocol';

export type McpRequestCorrelation = {
  requestId: string;
  era: 'legacy' | 'modern';
  protocolVersion: McpProtocolVersion;
  transport: 'streamable_http' | 'http_sse';
  /** Verified-owned legacy session id, or null (always null in modern). */
  sessionId: string | null;
  principalKey: string;
  /** OAuth access-token `jti`; null for API keys and jti-less bearers. */
  tokenJti: string | null;
  /** Self-reported by the client; bounded, never an identifier. */
  clientInfo: { name: string; version: string | null } | null;
};

const CLIENT_INFO_FIELD_MAX = 64;
const OAUTH_API_KEY_PREFIX = 'oauth:';
const OAUTH_NO_JTI = 'oauth:no-jti';

// eslint-disable-next-line no-control-regex
const CONTROL_CHARS = /[\u0000-\u001f\u007f]/g;

function boundedField(v: unknown): string | null {
  if (typeof v !== 'string') return null;
  const cleaned = v.replace(CONTROL_CHARS, '').slice(0, CLIENT_INFO_FIELD_MAX);
  return cleaned.length > 0 ? cleaned : null;
}

export function sanitizeMcpClientInfo(raw: unknown): McpRequestCorrelation['clientInfo'] {
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) return null;
  const { name, version } = raw as { name?: unknown; version?: unknown };
  const boundedName = boundedField(name);
  if (!boundedName) return null;
  return { name: boundedName, version: boundedField(version) };
}

function tokenJtiFromApiKeyId(apiKeyId: string): string | null {
  if (!apiKeyId.startsWith(OAUTH_API_KEY_PREFIX) || apiKeyId === OAUTH_NO_JTI) return null;
  const jti = apiKeyId.slice(OAUTH_API_KEY_PREFIX.length);
  return jti.length > 0 ? jti : null;
}

export function buildMcpRequestCorrelation(
  input: Omit<McpRequestCorrelation, 'requestId' | 'tokenJti' | 'clientInfo'> & { apiKeyId: string; rawClientInfo?: unknown },
): McpRequestCorrelation {
  return {
    requestId: randomUUID(),
    era: input.era,
    protocolVersion: input.protocolVersion,
    transport: input.transport,
    sessionId: input.sessionId,
    principalKey: input.principalKey,
    tokenJti: tokenJtiFromApiKeyId(input.apiKeyId),
    clientInfo: sanitizeMcpClientInfo(input.rawClientInfo),
  };
}

export function correlationAuditDetails(c: McpRequestCorrelation): Record<string, unknown> {
  return {
    correlation: {
      requestId: c.requestId,
      era: c.era,
      protocolVersion: c.protocolVersion,
      transport: c.transport,
      sessionId: c.sessionId,
      principalKey: c.principalKey,
      tokenJti: c.tokenJti,
      clientInfo: c.clientInfo,
    },
    clientInfoTrust: 'self_reported',
  };
}
