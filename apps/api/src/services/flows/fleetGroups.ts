/**
 * Tool Catalog W06 (#5221, Decision 5) — the definition digest of every
 * DYNAMIC device group a fleet selector names, in one org. A fleet
 * pre-approval binds these: whoever edits a dynamic group's filter retargets
 * the step, so a change is `binding_drift`. Static groups are omitted —
 * membership is live by design (disclosed on the approval card). System
 * context with an explicit org predicate.
 */
import { createHash } from 'node:crypto';
import { and, eq, inArray } from 'drizzle-orm';
import { db, runOutsideDbContext, withSystemDbAccessContext } from '../../db';
import { deviceGroups } from '../../db/schema';
import { canonicalizeArguments } from '../actionIntents/canonicalize';

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export async function loadDynamicGroupDefinitions(orgId: string | null, groupIds: readonly string[]): Promise<Record<string, string>> {
  const wanted = [...new Set(groupIds.filter((g) => UUID_RE.test(g)))];
  if (!orgId || wanted.length === 0) return {};
  const rows = await runOutsideDbContext(() => withSystemDbAccessContext(
    () => db
      .select({ id: deviceGroups.id, type: deviceGroups.type, filterConditions: deviceGroups.filterConditions, rules: deviceGroups.rules })
      .from(deviceGroups)
      .where(and(eq(deviceGroups.orgId, orgId), inArray(deviceGroups.id, wanted))),
    'flows.fleetGroups.definitions',
  ));
  const out: Record<string, string> = {};
  for (const r of rows) {
    if (r.type !== 'dynamic') continue;
    const material = canonicalizeArguments({ filterConditions: r.filterConditions ?? null, rules: r.rules ?? null } as Record<string, unknown>);
    out[r.id] = createHash('sha256').update(material).digest('hex');
  }
  return out;
}
