import { inArray } from 'drizzle-orm';
import { db, withDbTransaction } from '../db';
import { organizations } from '../db/schema';
import { captureException } from './sentry';

/**
 * #10431: the structured refusal an AI tool returns when a multi-device call
 * spans organizations but the write it makes belongs to exactly one. It tells
 * the model which devices sit in which org, so it can call once per group
 * instead of re-querying device by device. One shape for every tool that
 * returns it (propose_script, manage_patches install).
 */
export interface SplitByOrg {
  error: 'split_by_org';
  groups: Array<{ orgId: string; orgName: string | null; deviceIds: string[] }>;
  hint: string;
}

/**
 * Build the split from `byOrg` (org id -> device ids, insertion-ordered: the
 * caller decides the order, normally its own device list's). Every org in it
 * must already have been resolved through the caller's own scope; this adds
 * names only, so it cannot widen reach.
 */
export async function splitByOrg(
  byOrg: Map<string, string[]>,
  options: { tool: string; hint: string },
): Promise<SplitByOrg> {
  // Names are a convenience for the model; the org ids are what it needs. The
  // read runs under the caller's own context.
  const names = new Map<string, string>();
  try {
    // Own savepoint, catch outside it: a bare failing query would poison the
    // enclosing transaction and turn this degraded answer into a commit error.
    const rows = await withDbTransaction(() => db.select({ id: organizations.id, name: organizations.name })
      .from(organizations).where(inArray(organizations.id, [...byOrg.keys()])));
    for (const row of rows) names.set(row.id, row.name);
  } catch (err) {
    console.warn(`[${options.tool}] could not read org names for split_by_org`, err);
    captureException(err instanceof Error ? err : new Error(String(err)), undefined, {
      service: options.tool,
    });
  }
  return {
    error: 'split_by_org',
    groups: [...byOrg].map(([orgId, deviceIds]) => ({ orgId, orgName: names.get(orgId) ?? null, deviceIds })),
    hint: options.hint,
  };
}
