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
import type { McpClientOptions } from './mcpClient';
import { toolSourcesAllowPrivateEgress } from '../../config/env';

export interface DiscoveryOutcome {
  added: number;
  updated: number;
  removed: number;
  skipped: Array<{ name: string; reason: string }>;
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
}): string {
  const canonical = canonicalize({
    name: t.name,
    description: t.description,
    inputSchema: t.inputSchema,
    tier: t.tier,
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
export async function discoverSource(
  sourceId: string,
  deps?: { clientFactory?: (opts: McpClientOptions) => McpClient },
): Promise<DiscoveryOutcome> {
  const source = await withSystemDbAccessContext(async () => {
    const rows = await db.select().from(toolSources).where(eq(toolSources.id, sourceId)).limit(1);
    return rows[0];
  });
  if (!source) {
    throw new Error(`tool source not found: ${sourceId}`);
  }

  let listing: Array<{
    name: string;
    description?: string;
    inputSchema: Record<string, unknown>;
    outputSchema?: Record<string, unknown>;
    annotations?: Record<string, unknown>;
  }>;
  // `decryptToolSourceAuth` lives INSIDE this try, not just the client calls
  // below: a decrypt failure (corrupt ciphertext, key rotation gap) is a
  // failure of this source exactly like a transport/auth error, and must be
  // captured onto the row the same way, or the row is left showing a stale
  // `active` status forever while the BullMQ job keeps retrying and dying.
  let decryptedAuth: ReturnType<typeof decryptToolSourceAuth> | undefined;
  try {
    decryptedAuth = decryptToolSourceAuth({
      id: source.id,
      authKind: source.authKind,
      authConfigEncrypted: source.authConfigEncrypted,
    });

    const clientFactory = deps?.clientFactory ?? ((opts: McpClientOptions) => new McpClient(opts));
    const client = clientFactory({
      endpointUrl: source.endpointUrl,
      credentialOrigin: source.credentialOrigin,
      auth: decryptedAuth,
      allowPrivateNetwork: toolSourcesAllowPrivateEgress(),
    });

    await client.initialize();
    listing = await client.listTools();
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
    const now = new Date();

    for (const tool of listing) {
      seenNames.add(tool.name);
      const description = tool.description ?? '';
      const inputSchema = tool.inputSchema ?? { type: 'object' };
      const outputSchema = tool.outputSchema ?? null;
      const annotations = tool.annotations ?? {};
      const proposed = proposeTier(annotations);
      const addressable = isAddressable(source.slug, tool.name);
      if (!addressable) skipped.push({ name: tool.name, reason: NOT_ADDRESSABLE_ERROR });

      const existing = existingByName.get(tool.name);

      if (!existing) {
        const tier = proposed;
        const revision = computeToolRevision({ name: tool.name, description, inputSchema, tier });
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
          reviewNeeded: !addressable,
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
      const revision = computeToolRevision({ name: tool.name, description, inputSchema, tier });

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

    const status: 'active' | 'error' = removedEnabledNames.length > 0 ? 'error' : 'active';
    const lastError =
      removedEnabledNames.length > 0
        ? `enabled tools removed by re-discovery: ${removedEnabledNames.join(', ')}`
        : null;

    await db
      .update(toolSources)
      .set({ status, lastError, lastDiscoveredAt: now, updatedAt: now })
      .where(eq(toolSources.id, sourceId));

    return {
      added,
      updated,
      removed,
      skipped,
      status,
      ...(lastError ? { error: lastError } : {}),
    };
  });
}
