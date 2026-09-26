/**
 * Topology M4 Task 3 (#6000): a short-lived cache of VALIDATED explanations.
 *
 * The key is a SHA-256 over everything that changes authority or meaning —
 * org/site, session (its host aliases are per investigation), user, effective site set and permission version, graph/health
 * revisions, the canonical scope-stamp hash, selection, question, and the
 * prompt/schema/provider revisions — so it never carries question text or an
 * address. Values are the sanitized structured answer only, bounded in size,
 * and live at most five minutes and never past the evidence's `freshUntil`.
 *
 * A hit is NOT authority: callers must still re-run the org AI policy,
 * `assertTopologyAiCurrentScope` and citation reauthorization before using
 * it (see `aiInvestigation.ts`). Redis trouble is a miss, never an error.
 */
import { createHash } from 'node:crypto';
import { topologyAiExplanationSchema, type TopologyAiExplanation, type TopologyAiSelection } from '@breeze/shared';
import type { TopologyRequestContext } from './access';
import { getRedis } from '../redis';

export const TOPOLOGY_AI_CACHE_MAX_TTL_MS = 5 * 60_000;
const MAX_VALUE_BYTES = 64 * 1024;

export type TopologyAiCacheKeyParts = {
  /**
   * The topology session (= investigation). A cached answer's text carries
   * that investigation's host aliases, so it is never served to another
   * session (review C9).
   */
  sessionId: string;
  userId: string;
  effectiveSites: string;
  permissionVersion: string;
  revisions: { graph: string; health: string };
  scopeStampHash: string;
  selection: TopologyAiSelection;
  question: string;
  promptVersion: string;
  schemaVersion: number;
  providerRevision: string;
};

type CacheRedis = {
  get(key: string): Promise<string | null>;
  set(key: string, value: string, mode: 'PX', ttlMs: number): Promise<unknown>;
  del(key: string): Promise<unknown>;
};

export function topologyAiCacheKey(ctx: TopologyRequestContext, parts: TopologyAiCacheKeyParts): string {
  const digest = createHash('sha256').update(JSON.stringify({
    orgId: ctx.scope.orgId, siteId: ctx.scope.siteId, ...parts,
    question: createHash('sha256').update(parts.question.normalize('NFC').trim()).digest('hex'),
  })).digest('hex');
  return `topology-ai:{${ctx.scope.orgId}}:answer:${digest}`;
}

const client = () => getRedis() as CacheRedis | null;

export async function getCachedTopologyExplanation(ctx: TopologyRequestContext, parts: TopologyAiCacheKeyParts): Promise<TopologyAiExplanation | null> {
  const redis = client();
  if (!redis) return null;
  try {
    const raw = await redis.get(topologyAiCacheKey(ctx, parts));
    if (!raw) return null;
    const parsed = topologyAiExplanationSchema.safeParse((JSON.parse(raw) as { explanation?: unknown }).explanation);
    return parsed.success ? parsed.data : null;
  } catch {
    return null;
  }
}

export async function setCachedTopologyExplanation(
  ctx: TopologyRequestContext,
  parts: TopologyAiCacheKeyParts,
  explanation: TopologyAiExplanation,
  freshUntil: Date,
  now = new Date(),
): Promise<void> {
  const ttlMs = Math.min(TOPOLOGY_AI_CACHE_MAX_TTL_MS, freshUntil.getTime() - now.getTime());
  if (!(ttlMs > 0)) return;
  const value = JSON.stringify({ explanation: topologyAiExplanationSchema.parse(explanation) });
  if (Buffer.byteLength(value) > MAX_VALUE_BYTES) return;
  const redis = client();
  if (!redis) return;
  try {
    await redis.set(topologyAiCacheKey(ctx, parts), value, 'PX', Math.floor(ttlMs));
  } catch {
    // A cache write failure only costs a future miss.
  }
}

/** Invalidate ONE current-answer entry (scope change); canonical history is never touched. */
export async function deleteCachedTopologyExplanation(ctx: TopologyRequestContext, parts: TopologyAiCacheKeyParts): Promise<void> {
  const redis = client();
  if (!redis) return;
  try {
    await redis.del(topologyAiCacheKey(ctx, parts));
  } catch {
    // Expires on its own within five minutes.
  }
}
