/**
 * Tool source discovery — Tool Catalog W1 (#5215 / #5216), Task A6.
 * Spec: docs/superpowers/specs/ai-mcp/2026-09-07-tool-catalog-and-flows-design.md §5.3.
 *
 * Reconciles a `tool_sources` row's remote MCP tool listing against the
 * locally-cached `tool_source_tools` rows: proposes a tier from MCP
 * annotations, tracks a content revision for Tier-3 drift detection at
 * execution time (see `services/toolSources/execute.ts`, Task A8), and marks
 * tools that disappeared from the listing as removed.
 *
 * W2 (#5217): an `openapi` source's listing comes from fetching and
 * projecting its OpenAPI document (`openapiSpec.ts`, `openapiProjection.ts`)
 * instead of `tools/list`; everything after the listing — reconcile, tiers,
 * revisions, removal/review flags — is shared. Each completed run writes
 * `last_discovery_summary` (skips + warnings); `last_error` stays reserved
 * for real failures.
 *
 * Runs as a background job (`jobs/toolSourceDiscoveryWorker.ts`) — DB access
 * uses `withSystemDbAccessContext` directly (never `runOutsideDbContext`
 * first: that helper is only needed to escape an ALREADY-open request
 * context, and this module is never invoked from inside one). The MCP
 * client calls (`initialize`/`listTools`) run entirely OUTSIDE any
 * `withSystemDbAccessContext` block — they are the "external I/O outside any
 * transaction" the plan calls for, so a slow/hanging remote server never
 * pins a pooled DB connection.
 */
import { eq } from 'drizzle-orm';
import { qualifiedToolName, QUALIFIED_TOOL_NAME_MAX, SOURCE_TOOL_NAME_RE } from '@breeze/shared';
import { createHash } from 'crypto';
import { withSystemDbAccessContext, db } from '../../db';
import { toolSources, toolSourceTools } from '../../db/schema';
import { decryptToolSourceAuth, redactSecrets, secretValuesOf } from './secrets';
import { McpClient } from './mcpClient';
import type { McpClientOptions, McpToolListing } from './mcpClient';
import { toolSourcesAllowPrivateEgress } from '../../config/env';
import type { ToolSourceDiscoverySkip, ToolSourceDiscoverySummary, ToolSourceDiscoveryWarning } from '@breeze/shared';
import type { ToolSourceRow } from '../../db/schema';
import type { ToolSourceAuthConfig } from './secrets';
import { fetchOpenApiDocument, type FetchSpecOptions, type OpenApiDocument } from './openapiSpec';
import { projectOpenApiDocument } from './openapiProjection';

export interface DiscoveryOutcome {
  added: number;
  updated: number;
  removed: number;
  skipped: Array<{ name: string; reason: string }>;
  /** Non-fatal findings of a completed run (W2): never a failure, never `last_error`. */
  warnings?: ToolSourceDiscoveryWarning[];
  status: 'active' | 'error';
  error?: string;
}

/**
 * Proposes a tool's tier from its MCP annotations: `readOnlyHint === true`
 * and NOT `destructiveHint === true` proposes Tier 1 (read-only); anything
 * else (including missing/ambiguous annotations) proposes Tier 3. There is
 * no proposed Tier 2 — a human settles on Tier 2 manually via the tools
 * PATCH route (Task A9).
 */
export function proposeTier(annotations: Record<string, unknown> | undefined): 1 | 3 {
  if (!annotations) return 3;
  const readOnly = annotations.readOnlyHint === true;
  const destructive = annotations.destructiveHint === true;
  return readOnly && !destructive ? 1 : 3;
}

/** Recursively sorts object keys so JSON.stringify is order-independent. */
function canonicalize(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map(canonicalize);
  }
  if (value !== null && typeof value === 'object') {
    const sortedKeys = Object.keys(value as Record<string, unknown>).sort();
    const out: Record<string, unknown> = {};
    for (const key of sortedKeys) {
      out[key] = canonicalize((value as Record<string, unknown>)[key]);
    }
    return out;
  }
  return value;
}

/**
 * sha256 hex digest of the tool's canonical definition — stable regardless
 * of the key order the remote server (or our own object construction) uses.
 * `tier` is deliberately part of the hash: a Tier-3 action-intent's stored
 * `toolRevision` (Task B) must drift-detect a tier change at release time,
 * not just a schema/description/name change.
 */
export function computeToolRevision(t: {
  name: string;
  description: string;
  inputSchema: unknown;
  tier: number;
  /**
   * OpenAPI only (W2): the routing binding (`annotations.operation`). A vendor
   * moving an operation to another path or verb while keeping its name and
   * schema must still drift-detect an approved Tier-3 intent. Absent for MCP
   * tools, so their revisions are byte-identical to W01's.
   */
  operation?: unknown;
}): string {
  const canonical = canonicalize({
    name: t.name,
    description: t.description,
    inputSchema: t.inputSchema,
    tier: t.tier,
    ...(t.operation !== undefined ? { operation: t.operation } : {}),
  });
  return createHash('sha256').update(JSON.stringify(canonical)).digest('hex');
}

/** Whether a tool's name is addressable as a qualified `<slug>__<name>` tool. */
function isAddressable(sourceSlug: string, name: string): boolean {
  if (!SOURCE_TOOL_NAME_RE.test(name)) return false;
  return qualifiedToolName(sourceSlug, name).length <= QUALIFIED_TOOL_NAME_MAX;
}

const NOT_ADDRESSABLE_ERROR = 'name_not_addressable';

/**
 * Runs discovery for one tool source: fetches its remote MCP tool listing
 * and reconciles it against the cached `tool_source_tools` rows. Never
 * throws for a reachable-but-erroring remote server — transport/protocol/
 * auth failures are captured onto the source row (`status: 'error'`,
 * `lastError`, redacted) and returned in the outcome instead. A missing
 * source row IS a caller error (the worker should never enqueue a
 * nonexistent id) and throws.
 */
export interface DiscoveryDeps {
  clientFactory?: (opts: McpClientOptions) => McpClient;
  /** OpenAPI kind (W2): default `fetchOpenApiDocument` — tests inject a scripted fake. */
  specFetcher?: (opts: FetchSpecOptions) => Promise<OpenApiDocument>;
}

/** Caps on what one summary row may hold (D17) — it is shown in the UI and exported nowhere. */
export const SUMMARY_MAX_SKIPPED = 500;
const SUMMARY_MAX_NAME_CHARS = 256;
const SUMMARY_MAX_PATH_CHARS = 2_048;
const SUMMARY_MAX_ORIGINS = 20;

/** The kind-agnostic listing the reconcile loop consumes, plus what the lister refused. */
interface RemoteListing {
  listing: McpToolListing[];
  skipped: ToolSourceDiscoverySkip[];
  warnings: ToolSourceDiscoveryWarning[];
  /** Projectable operations in an OpenAPI document; null for MCP. */
  operationCount: number | null;
}

/**
 * Produces the listing for `source.kind`. Runs OUTSIDE any DB context (both
 * branches do network I/O). Everything after this — reconcile, revisions,
 * removal and review flags — is shared by both kinds.
 */
async function listRemoteTools(
  source: ToolSourceRow,
  auth: ToolSourceAuthConfig,
  deps?: DiscoveryDeps,
): Promise<RemoteListing> {
  if (source.kind === 'openapi') {
    // tool_sources_spec_url_kind_chk guarantees this; a NULL here is corruption, not a vendor fault.
    if (!source.specUrl) throw new Error('openapi source has no spec_url');
    const fetchSpec = deps?.specFetcher ?? fetchOpenApiDocument;
    const doc = await fetchSpec({
      specUrl: source.specUrl,
      credentialOrigin: source.credentialOrigin,
      auth,
      allowPrivateNetwork: toolSourcesAllowPrivateEgress(),
    });
    const projected = projectOpenApiDocument(doc, {
      sourceSlug: source.slug,
      credentialOrigin: source.credentialOrigin,
      specUrl: source.specUrl,
    });
    return {
      listing: projected.operations,
      skipped: projected.skipped,
      warnings: projected.serverOriginWarnings.length > 0
        ? [{ code: 'server_origin_mismatch', origins: projected.serverOriginWarnings }]
        : [],
      operationCount: projected.operationCount,
    };
  }

  const clientFactory = deps?.clientFactory ?? ((opts: McpClientOptions) => new McpClient(opts));
  const client = clientFactory({
    endpointUrl: source.endpointUrl,
    credentialOrigin: source.credentialOrigin,
    auth,
    allowPrivateNetwork: toolSourcesAllowPrivateEgress(),
  });
  await client.initialize();
  return { listing: await client.listTools(), skipped: [], warnings: [], operationCount: null };
}

/** Builds the bounded `last_discovery_summary` for a COMPLETED run (D17). */
export function buildDiscoverySummary(
  at: Date,
  operationCount: number | null,
  skipped: ToolSourceDiscoverySkip[],
  warnings: ToolSourceDiscoveryWarning[],
): ToolSourceDiscoverySummary {
  return {
    version: 1,
    at: at.toISOString(),
    operationCount,
    skipped: skipped.slice(0, SUMMARY_MAX_SKIPPED).map((s) => ({
      name: String(s.name).slice(0, SUMMARY_MAX_NAME_CHARS),
      ...(s.method !== undefined ? { method: String(s.method).slice(0, 16) } : {}),
      ...(s.path !== undefined ? { path: String(s.path).slice(0, SUMMARY_MAX_PATH_CHARS) } : {}),
      reason: s.reason,
    })),
    skippedTotal: skipped.length,
    warnings: warnings.map((w) => ({
      code: w.code,
      origins: w.origins.slice(0, SUMMARY_MAX_ORIGINS).map((o) => String(o).slice(0, SUMMARY_MAX_NAME_CHARS)),
    })),
  };
}

export async function discoverSource(sourceId: string, deps?: DiscoveryDeps): Promise<DiscoveryOutcome> {
  const source = await withSystemDbAccessContext(async () => {
    const rows = await db.select().from(toolSources).where(eq(toolSources.id, sourceId)).limit(1);
    return rows[0];
  });
  if (!source) {
    throw new Error(`tool source not found: ${sourceId}`);
  }

  let remote: RemoteListing;
  // `decryptToolSourceAuth` lives INSIDE this try, not just the client calls
  // below: a decrypt failure (corrupt ciphertext, key rotation gap) is a
  // failure of this source exactly like a transport/auth error, and must be
  // captured onto the row the same way, or the row is left showing a stale
  // `active` status forever while the BullMQ job keeps retrying and dying.
  // The OpenAPI fetch/parse/projection lives inside it too, so an
  // `OpenApiSpecError` (version, remote $ref, caps, transport) lands on the
  // same `status='error'` + redacted `last_error` path. A failed run leaves
  // `last_discovery_summary` untouched — its `at` names the run it describes.
  let decryptedAuth: ReturnType<typeof decryptToolSourceAuth> | undefined;
  try {
    decryptedAuth = decryptToolSourceAuth({
      id: source.id,
      authKind: source.authKind,
      authConfigEncrypted: source.authConfigEncrypted,
    });
    remote = await listRemoteTools(source, decryptedAuth, deps);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    // A decrypt failure has no decrypted config to redact against — the
    // error message is a crypto library message (metadata), never remote
    // content, so there is nothing of the vendor's to redact.
    const redacted = redactSecrets(message, decryptedAuth ? secretValuesOf(decryptedAuth) : []);
    await withSystemDbAccessContext(async () => {
      await db
        .update(toolSources)
        .set({ status: 'error', lastError: redacted, updatedAt: new Date() })
        .where(eq(toolSources.id, sourceId));
    });
    return { added: 0, updated: 0, removed: 0, skipped: [], status: 'error', error: redacted };
  }

  return withSystemDbAccessContext(async () => {
    const existingRows = await db
      .select()
      .from(toolSourceTools)
      .where(eq(toolSourceTools.sourceId, sourceId));
    const existingByName = new Map(existingRows.map((row) => [row.name as string, row]));
    const seenNames = new Set<string>();

    let added = 0;
    let updated = 0;
    let removed = 0;
    const skipped: Array<{ name: string; reason: string }> = [];
    const summarySkipped: ToolSourceDiscoverySkip[] = [...remote.skipped];
    const now = new Date();
    const isOpenApi = source.kind === 'openapi';

    for (const tool of remote.listing) {
      seenNames.add(tool.name);
      const description = tool.description ?? '';
      const inputSchema = tool.inputSchema ?? { type: 'object' };
      const outputSchema = tool.outputSchema ?? null;
      const annotations = tool.annotations ?? {};
      const proposed = proposeTier(annotations);
      const addressable = isAddressable(source.slug, tool.name);
      if (!addressable) {
        skipped.push({ name: tool.name, reason: NOT_ADDRESSABLE_ERROR });
        summarySkipped.push({ name: tool.name, reason: NOT_ADDRESSABLE_ERROR });
      }
      const operation = isOpenApi ? annotations.operation : undefined;

      const existing = existingByName.get(tool.name);

      if (!existing) {
        const tier = proposed;
        const revision = computeToolRevision({ name: tool.name, description, inputSchema, tier, operation });
        await db.insert(toolSourceTools).values({
          sourceId,
          orgId: source.orgId,
          partnerId: source.partnerId,
          name: tool.name,
          qualifiedName: qualifiedToolName(source.slug, tool.name),
          description,
          inputSchema,
          outputSchema,
          annotations,
          proposedTier: proposed,
          tier,
          enabled: false,
          // Every newly discovered tool starts flagged for human review,
          // regardless of the tier its own peer-declared annotations
          // propose — a peer's self-reported readOnlyHint is not corroborated
          // server-side, so an admin must look at it once before it can be
          // bulk-enabled (see bulkToolsAction('enable_reads') in service.ts).
          reviewNeeded: true,
          revision,
          lastError: addressable ? null : NOT_ADDRESSABLE_ERROR,
          discoveredAt: now,
          removedAt: null,
          updatedAt: now,
        });
        added += 1;
        continue;
      }

      let tier = existing.tier as number;
      let reviewNeeded = existing.reviewNeeded as boolean;
      if (proposed !== existing.proposedTier) {
        reviewNeeded = true;
        if (proposed === 3) tier = 3;
      }
      if (!addressable) reviewNeeded = true;
      const revision = computeToolRevision({ name: tool.name, description, inputSchema, tier, operation });

      await db
        .update(toolSourceTools)
        .set({
          description,
          inputSchema,
          outputSchema,
          annotations,
          proposedTier: proposed,
          tier,
          reviewNeeded,
          revision,
          lastError: addressable ? null : NOT_ADDRESSABLE_ERROR,
          removedAt: null,
          updatedAt: now,
        })
        .where(eq(toolSourceTools.id, existing.id as string));
      updated += 1;
    }

    const removedEnabledNames: string[] = [];
    for (const existing of existingRows) {
      const name = existing.name as string;
      if (seenNames.has(name)) continue;
      if (existing.removedAt) continue;
      await db
        .update(toolSourceTools)
        .set({ removedAt: now, enabled: false, updatedAt: now })
        .where(eq(toolSourceTools.id, existing.id as string));
      removed += 1;
      if (existing.enabled) removedEnabledNames.push(name);
    }

    // `status`/`last_error` keep their W01 meaning exactly: a warning (e.g. a
    // servers[] origin mismatch) is NOT a failure and never touches
    // `last_error`, so it can never overwrite the removed-tools error below.
    // Warnings and skip reasons live in `last_discovery_summary` (D17/D18).
    const status: 'active' | 'error' = removedEnabledNames.length > 0 ? 'error' : 'active';
    const lastError =
      removedEnabledNames.length > 0
        ? `enabled tools removed by re-discovery: ${removedEnabledNames.join(', ')}`
        : null;
    const lastDiscoverySummary = buildDiscoverySummary(now, remote.operationCount, summarySkipped, remote.warnings);

    await db
      .update(toolSources)
      .set({ status, lastError, lastDiscoveredAt: now, lastDiscoverySummary, updatedAt: now })
      .where(eq(toolSources.id, sourceId));

    return {
      added,
      updated,
      removed,
      skipped: [...remote.skipped.map((s) => ({ name: s.name, reason: s.reason })), ...skipped],
      warnings: remote.warnings,
      status,
      ...(lastError ? { error: lastError } : {}),
    };
  });
}
