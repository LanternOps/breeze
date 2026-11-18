/**
 * Tool Catalog W06 (#5221) Task A5 — the script a `run_script_on_targets`
 * step runs: the flow owner's library script (rule 6 — an org flow its org's,
 * its partner's and system scripts; a partner-wide flow its partner's and
 * system scripts), not deleted. System context with the explicit owner
 * predicate (`scriptOwnershipCondition`, the automation reference rule).
 */
import { and, eq, isNull } from 'drizzle-orm';
import { db, runOutsideDbContext, withSystemDbAccessContext } from '../../../db';
import { scripts } from '../../../db/schema';
import { scriptOwnershipCondition } from '../../automationReferenceAuthorization';
import { scriptNeedsVariableScope } from '../../sourcedParameters';
import { loadTenantVariableScope, type TenantVariableScope } from '../../tenantVariableResolution';
import type { ToolOwnerRef } from '../../toolSources/resolver';

export type FleetScriptRow = typeof scripts.$inferSelect;

export async function loadOwnedScriptForRun(owner: ToolOwnerRef, scriptId: string): Promise<FleetScriptRow | null> {
  const ref = owner.orgId
    ? { scope: 'organization' as const, orgId: owner.orgId, partnerId: owner.partnerId }
    : { scope: 'partner' as const, orgId: null, partnerId: owner.partnerId };
  const [row] = await runOutsideDbContext(() => withSystemDbAccessContext(
    () => db
      .select()
      .from(scripts)
      .where(and(eq(scripts.id, scriptId), isNull(scripts.deletedAt), scriptOwnershipCondition(ref)))
      .limit(1),
    'flows.builtins.loadOwnedScriptForRun',
  ));
  return row ?? null;
}

/** The tenant-variable snapshot a `{{var.*}}` / variable-bound script needs, for the run org only. */
export async function loadRunVariableScope(script: FleetScriptRow, orgId: string): Promise<TenantVariableScope | undefined> {
  if (!scriptNeedsVariableScope(script)) return undefined;
  return runOutsideDbContext(() => withSystemDbAccessContext(
    () => loadTenantVariableScope([orgId]),
    'flows.builtins.loadRunVariableScope',
  ));
}
