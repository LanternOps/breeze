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
import { toolSourcesAllowPrivateEgress } from '../../config/env';
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

/** One dispatch outcome. `isError` is the authoritative failure signal. */
export interface TenantToolExecution {
  isError: boolean;
  /** The text a surface shows the model: the result, or the failure reason. */
  text: string;
}

/**
 * Runs one tenant tool call and reports the outcome STRUCTURALLY. Always
 * resolves — every failure mode (validation, rate limit, revocation, a
 * throwing rate limiter or credential decrypt, a remote error) comes back as
 * `{ isError: true }` rather than a rejection, so a caller can never mistake
 * a failure for a success by forgetting a try/catch.
 *
 * Callers must branch on `isError`, not on the shape of `text`: an MCP
 * `tools/call` reply needs `isError: true`, the chat bridge's
 * `wrapExtraToolWithHooks` reads `result.isError` for its post-tool-use
 * signal, and the MCP audit ledger records success/failure from it. Deriving
 * it by sniffing the JSON body is how both surfaces recorded every failed
 * external call as a success in review.
 */
export async function executeTenantToolDetailed(
  d: TenantToolDescriptor,
  input: Record<string, unknown>,
  auth: AuthContext,
  opts: ExecuteTenantToolOptions,
): Promise<TenantToolExecution> {
  const validation = d.validate(input);
  if (!validation.success) {
    return { isError: true, text: validation.error };
  }

  let isError: boolean;
  let resultText: string;

  try {
    const principalId = opts.actor?.id ?? auth.user.id;
    const rateLimitError = await checkTenantToolRateLimit(d, principalId);
    if (rateLimitError) {
      return { isError: true, text: rateLimitError };
    }

    // Fresh reload: revocation (disabled / removed / source inactive) is
    // rechecked at dispatch time, not trusted from whenever `d` was resolved.
    // `auth` is passed so the reload re-applies the OWNER predicate: the
    // descriptor may have been captured by a chat session that has since been
    // re-narrowed to a different org (a device moved between orgs, #3087), and
    // a load by id alone would dispatch the previous tenant's tool with the
    // previous tenant's credential. `opts.orgId` is threaded through as the
    // same `targetOrgId` resolution used to find `d` in the first place — a
    // partner-scoped caller re-validating an org-owned tool needs the same
    // org-targeting the resolve step applied, or an otherwise-valid reload
    // would spuriously fail the owner check (#6023).
    const loaded = await loadTenantToolForExecution(d.id, auth, opts.orgId);

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
        allowPrivateNetwork: toolSourcesAllowPrivateEgress(),
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
  } catch (err) {
    // A throw from the rate limiter (Redis blip), the reload, or the
    // credential decrypt used to escape this function entirely — which meant
    // NO audit row was written for an attempted call against a tenant's
    // external system. Report it like any other failure so the audit write
    // below always runs. The message is metadata (a Redis/crypto error),
    // never remote content, so there is nothing to redact against — and we
    // have no decrypted credential here to redact with.
    isError = true;
    resultText = `External tool dispatch failed: ${err instanceof Error ? err.message : String(err)}`;
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

  return { isError, text: resultText };
}

/**
 * String form of {@link executeTenantToolDetailed} — the result text on
 * success, `{"error": "..."}` on failure. Kept for callers that only render
 * text; anything that records an outcome (audit status, MCP `isError`, a
 * post-tool-use hook) must use the detailed form instead.
 */
export async function executeTenantTool(
  d: TenantToolDescriptor,
  input: Record<string, unknown>,
  auth: AuthContext,
  opts: ExecuteTenantToolOptions,
): Promise<string> {
  const { isError, text } = await executeTenantToolDetailed(d, input, auth, opts);
  return isError ? JSON.stringify({ error: text }) : text;
}
