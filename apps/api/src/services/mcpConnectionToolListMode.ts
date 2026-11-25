/**
 * The stored MCP tool list mode of OAuth connections (#12429): reads for the
 * consent form, the owner's Connected apps page and the partner's Connected
 * Apps list, and the owner's edit.
 *
 * `oauth_grants` rows belong to a user, and its RLS policy admits the row's own
 * user or system scope only. Every query here therefore runs in system scope
 * and carries its own authority predicate — the owner's user id, or (partner
 * summary) the caller's partner id — as a required argument. "Active" is the one
 * definition bearer admission uses (liveGrantCondition), so a row these reads
 * call active is exactly a row a client can still present.
 */
import { and, desc, eq, inArray } from 'drizzle-orm';
import type {
  McpConnectionToolListMode,
  McpPartnerClientToolListMode,
  McpToolListMode,
} from '@breeze/shared';
import { db, runOutsideDbContext, withSystemDbAccessContext } from '../db';
import { oauthGrants } from '../db/schema';
import { liveGrantCondition } from '../oauth/grantStatus';
import { effectiveMcpToolListMode } from './mcpToolListMode';

const asSystem = <T>(fn: () => Promise<T>): Promise<T> =>
  runOutsideDbContext(() => withSystemDbAccessContext(fn));

const NO_CONNECTION: McpConnectionToolListMode = { kind: 'none', grantCount: 0 };

function groupByClient(rows: Array<{ clientId: string; mode: McpToolListMode | null }>) {
  const byClient = new Map<string, Array<McpToolListMode | null>>();
  for (const row of rows) byClient.set(row.clientId, [...(byClient.get(row.clientId) ?? []), row.mode]);
  return byClient;
}

/** Stored values are compared, not effective ones: `full` and an inherited `full` are `mixed`. */
function summarizeConnection(stored: Array<McpToolListMode | null>): McpConnectionToolListMode {
  if (stored.length === 0) return NO_CONNECTION;
  const [first] = stored;
  if (stored.some((mode) => mode !== first)) return { kind: 'mixed', grantCount: stored.length };
  return { kind: 'uniform', stored: first!, effective: effectiveMcpToolListMode(first!), grantCount: stored.length };
}

/**
 * One user's active connections, per OAuth client, across every partner they
 * connected for. A client with no active connection is absent from the map.
 */
export async function getUserConnectionToolListModes(
  userId: string,
  now: Date = new Date(),
): Promise<(clientId: string) => McpConnectionToolListMode> {
  const rows = await asSystem(() => db
    .select({ clientId: oauthGrants.clientId, mode: oauthGrants.mcpToolListMode })
    .from(oauthGrants)
    .where(and(eq(oauthGrants.accountId, userId), liveGrantCondition(now))));
  const byClient = groupByClient(rows);
  return (clientId) => summarizeConnection(byClient.get(clientId) ?? []);
}

/**
 * The owner's edit: every active connection of THIS user to this client.
 * Deliberately no partner filter — the owner's page has one row per client — and
 * the user id is in the UPDATE itself, so no other user's connection and no
 * revoked or expired one can be written. Returns how many rows were.
 */
export async function setUserConnectionToolListMode(
  input: { userId: string; clientId: string; mode: McpToolListMode | null },
  now: Date = new Date(),
): Promise<number> {
  const rows = await asSystem(() => db
    .update(oauthGrants)
    .set({ mcpToolListMode: input.mode })
    .where(and(
      eq(oauthGrants.accountId, input.userId),
      eq(oauthGrants.clientId, input.clientId),
      liveGrantCondition(now),
    ))
    .returning({ id: oauthGrants.id }));
  return rows.length;
}

/** Per-client summary of THIS partner's active connections (any user), for its admin's read-only list. */
export async function getPartnerClientToolListModes(
  partnerId: string,
  now: Date = new Date(),
): Promise<(clientId: string) => McpPartnerClientToolListMode> {
  const rows = await asSystem(() => db
    .selectDistinct({ clientId: oauthGrants.clientId, mode: oauthGrants.mcpToolListMode })
    .from(oauthGrants)
    .where(and(eq(oauthGrants.partnerId, partnerId), liveGrantCondition(now))));
  const byClient = groupByClient(rows);
  return (clientId) => {
    const stored = byClient.get(clientId);
    if (!stored) return null;
    return stored.length > 1 ? 'mixed' : stored[0] ?? 'default';
  };
}

/**
 * What the consent form pre-selects: the stored mode of the user's newest
 * active connection to this client, per partner. A partner with none is absent.
 */
export async function getPriorConnectionToolListModes(
  input: { userId: string; clientId: string; partnerIds: readonly string[] },
  now: Date = new Date(),
): Promise<ReadonlyMap<string, McpToolListMode | null>> {
  if (input.partnerIds.length === 0) return new Map();
  const rows = await asSystem(() => db
    .selectDistinctOn([oauthGrants.partnerId], { partnerId: oauthGrants.partnerId, mode: oauthGrants.mcpToolListMode })
    .from(oauthGrants)
    .where(and(
      eq(oauthGrants.accountId, input.userId),
      eq(oauthGrants.clientId, input.clientId),
      inArray(oauthGrants.partnerId, [...input.partnerIds]),
      liveGrantCondition(now),
    ))
    .orderBy(oauthGrants.partnerId, desc(oauthGrants.createdAt), desc(oauthGrants.id)));
  return new Map(rows.map((row) => [row.partnerId!, row.mode]));
}
