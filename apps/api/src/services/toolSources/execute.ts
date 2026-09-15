/**
 * Tenant tool executor — Task A8.
 *
 * The single dispatch chokepoint every surface (chat `extraTools` bridge,
 * MCP HTTP server, the `/tool-sources/:id/tools/:toolId/test` route) calls
 * through to actually run a BYO MCP tool. Order matters and mirrors the
 * plan's Execution paragraph exactly:
 *
 *   validate -> rate limit -> fresh reload (revocation recheck) -> decrypt
 *   auth -> call the remote MCP server (OUTSIDE any DB context) -> redact ->
 *   truncate -> audit (never the input values or output).
 */
import { McpClient, type McpCallResult } from './mcpClient';
import { decryptToolSourceAuth, redactSecrets, secretValuesOf } from './secrets';
import { loadTenantToolForExecution, type TenantToolDescriptor } from './resolver';
import { checkTenantToolRateLimit } from './guardrails';
import { writeAuditEvent, requestLikeFromSnapshot } from '../auditEvents';
import type { AuthContext } from '../../middleware/auth';

export interface ExecuteTenantToolOptions {
  orgId?: string | null;
  actor?: { kind: 'user' | 'api_key' | 'flow'; id: string };
  surface: 'chat' | 'mcp' | 'test';
}

const MAX_RESULT_CHARS = 262_144;
const TRUNCATION_SUFFIX = '\n…[truncated]';

function buildResultText(result: McpCallResult): string {
  if (result.structuredContent !== undefined) {
    return JSON.stringify(result.structuredContent);
  }
  return result.content
    .filter((part): part is { type: string; text: string } => part.type === 'text' && typeof part.text === 'string')
    .map((part) => part.text)
    .join('');
}

function truncate(text: string): string {
  if (text.length <= MAX_RESULT_CHARS) return text;
  return `${text.slice(0, MAX_RESULT_CHARS)}${TRUNCATION_SUFFIX}`;
}

/**
 * Runs one tenant tool call. Always resolves (never throws) — every failure
 * mode is reported back as a JSON error string, the same contract a normal
 * tool-call result string has for callers on every surface.
 */
export async function executeTenantTool(
  d: TenantToolDescriptor,
  input: Record<string, unknown>,
  auth: AuthContext,
  opts: ExecuteTenantToolOptions,
): Promise<string> {
  const validation = d.validate(input);
  if (!validation.success) {
    return JSON.stringify({ error: validation.error });
  }

  const principalId = opts.actor?.id ?? auth.user.id;
  const rateLimitError = await checkTenantToolRateLimit(d, principalId);
  if (rateLimitError) {
    return JSON.stringify({ error: rateLimitError });
  }

  // Fresh reload: revocation (disabled / removed / source inactive) is
  // rechecked at dispatch time, not trusted from whenever `d` was resolved.
  const loaded = await loadTenantToolForExecution(d.id);

  let isError: boolean;
  let resultText: string;

  if (!loaded) {
    isError = true;
    resultText = `Tool "${d.qualifiedName}" is no longer available (disabled, removed, or its source is inactive).`;
  } else {
    const { source } = loaded;
    const authConfig = decryptToolSourceAuth(source);
    const client = new McpClient({
      endpointUrl: source.endpointUrl,
      credentialOrigin: source.credentialOrigin,
      auth: authConfig,
    });

    // Outside any DB context: `loadTenantToolForExecution` has already
    // resolved and its system-scoped transaction has closed by the time we
    // get here (we're past its `await`), so this call never holds a pooled
    // connection open across the network round trip.
    let rawResultText: string;
    try {
      const callResult = await client.callTool(d.name, input);
      isError = callResult.isError === true;
      rawResultText = buildResultText(callResult);
    } catch (err) {
      isError = true;
      rawResultText = err instanceof Error ? err.message : String(err);
    }

    resultText = redactSecrets(rawResultText, secretValuesOf(authConfig));
  }

  resultText = truncate(resultText);

  // Audit: never the input values or output — only shape/metadata.
  writeAuditEvent(requestLikeFromSnapshot({}), {
    orgId: opts.orgId ?? auth.orgId,
    action: 'ai.external_tool.call',
    resourceType: 'tool_source_tool',
    resourceId: d.id,
    resourceName: d.qualifiedName,
    details: {
      sourceId: d.sourceId,
      tier: d.tier,
      revision: d.revision,
      surface: opts.surface,
      inputKeys: Object.keys(input),
      isError,
    },
    actorId: opts.actor?.id ?? auth.user.id,
    actorEmail: auth.user.email,
  });

  return isError ? JSON.stringify({ error: resultText }) : resultText;
}
