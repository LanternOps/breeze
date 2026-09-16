/**
 * Chat bridge (Agent SDK `extraTools`) for tenant (BYO MCP) tools — Task A10
 * (spec 2026-09-07 §8, plan
 * docs/superpowers/plans/ai-mcp/2026-09-07-tool-catalog-w1-tool-sources-mcp.md).
 *
 * Turns the `TenantToolDescriptor`s a caller may see (already narrowed by
 * `toolSources/resolver.ts`) into `SdkTool`s that `createBreezeMcpServer`
 * registers via its `extraTools` argument, alongside the core registry.
 *
 * Execution runs through the SAME chokepoint every other tenant-tool surface
 * uses — `toolSources/execute.ts`'s `executeTenantToolDetailed` — so this
 * module never re-implements validation, rate limiting, or dispatch; it only
 * shapes input/output for the SDK and forwards `isError` so
 * `wrapExtraToolWithHooks` (`aiAgentSdkTools.ts`) can see a tenant-tool
 * failure the same way it sees a core-tool failure.
 *
 * The handler below is intentionally hook-free: `wrapExtraToolWithHooks`
 * (`aiAgentSdkTools.ts`) wraps every `extraTools` entry with
 * onPreToolUse/onPostToolUse itself, so a handler that also ran the hooks
 * would fire them twice. Guardrails/RBAC/rate-limit for tenant tools are
 * gated by `createSessionPreToolUse`'s tenant branch (`aiAgentSdk.ts`)
 * BEFORE the SDK ever calls the handler here.
 */
import { tool } from '@anthropic-ai/claude-agent-sdk';
import { z } from 'zod';
import type { SdkTool } from '../aiAgents/outcomeTools';
import type { AuthContext } from '../../middleware/auth';
import type { TenantToolDescriptor } from './resolver';
import { executeTenantToolDetailed } from './execute';
import { compactToolResultForChat } from '../aiToolOutput';

/**
 * A vendor's JSON-Schema `inputSchema` is arbitrary — `z.fromJSONSchema` can
 * throw on a shape it doesn't understand (e.g. an unresolvable `$ref`), and
 * even when it succeeds the result is not always an object schema (a bare
 * `{type:'string'}` top-level schema is legal JSON-Schema but not something
 * `tool()`'s shape argument — which is always an object shape — can express).
 * Both cases fall back to one permissive `input` field rather than failing
 * the whole tool's registration.
 */
export function zodShapeFromJsonSchema(schema: Record<string, unknown>): z.ZodRawShape {
  try {
    const parsed = z.fromJSONSchema(schema, { defaultTarget: 'draft-2020-12' });
    if (parsed instanceof z.ZodObject) {
      return parsed.shape;
    }
  } catch {
    // Foreign schema didn't compile — fall through to the permissive shape.
  }
  return { input: z.record(z.string(), z.unknown()) };
}

/**
 * One `SdkTool` per descriptor, named by its qualified name (e.g.
 * `hudu__get_asset`) — the same name `tenantMcpToolNames` prefixes for
 * `allowedTools` and the same name the MCP HTTP server dispatches on
 * (`isTenantToolName`/`resolveTenantToolByName` in `routes/mcpServer.ts`).
 *
 * `getAuth`/`getOrgId` are thunks, not values: a reused chat session's
 * `toolAuth`/`orgId` can change across turns (device-bound re-narrowing,
 * follow-up messages), so each call reads the session's CURRENT auth/org at
 * call time — mirroring every other tool factory in `aiAgentSdkTools.ts`.
 *
 * Cast `as SdkTool` at each construction site (same reason `outcomeTools.ts`
 * casts at its construction sites): `tool()` returns
 * `SdkMcpToolDefinition<Shape>` for each descriptor's own concrete shape,
 * which does not widen into the loose `SdkTool` used to type a heterogeneous
 * array of per-descriptor tools.
 */
export function buildTenantSdkTools(
  descriptors: TenantToolDescriptor[],
  getAuth: () => AuthContext,
  getOrgId: () => string,
): SdkTool[] {
  return descriptors.map((d) =>
    tool(
      d.qualifiedName,
      `[External: ${d.sourceName}] ${d.description}`,
      zodShapeFromJsonSchema(d.inputSchema),
      async (args: Record<string, unknown>) => {
        const { isError, text } = await executeTenantToolDetailed(d, args, getAuth(), {
          surface: 'chat',
          orgId: getOrgId(),
        });
        return {
          content: [
            {
              type: 'text' as const,
              text: compactToolResultForChat(d.qualifiedName, text),
            },
          ],
          ...(isError ? { isError: true } : {}),
        };
      },
    ) as SdkTool,
  );
}

/**
 * The MCP tool names a chat session should add to `allowedTools` for these
 * descriptors — `mcp__breeze__<qualifiedName>`, the same prefix
 * `BREEZE_MCP_TOOL_NAMES` (`aiAgentSdkTools.ts`) uses for the core registry.
 */
export function tenantMcpToolNames(descriptors: TenantToolDescriptor[]): string[] {
  return descriptors.map((d) => `mcp__breeze__${d.qualifiedName}`);
}
