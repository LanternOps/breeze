/**
 * Turns a policy's `ruleSetIds` into W02 §C1 `ruleSets` refs for one device
 * (#6263 W03a), behind the minimum agent version, with an explicit outcome:
 * a scan that cannot run YARA is recorded as `engine = 'legacy'` with the
 * reasons in `rule_set_errors` — never a silent legacy scan presented as YARA.
 *
 * Self-tenanted by the DEVICE: only sets owned by the device's org, its
 * partner's partner-wide sets, and the built-in pack can resolve, whatever
 * context the caller runs in (the dispatch worker runs in system scope). The
 * policy write gate (securityRuleSetGate) stops a policy naming anything else;
 * this is the backstop, and the agent fetch route re-checks under the agent's
 * own RLS context.
 */
import { and, eq, inArray, isNull, or, sql } from 'drizzle-orm';
import type { YaraRuleSetError, YaraRuleSetRef, SecurityScanEngine } from '@breeze/shared';
import { db } from '../db';
import { devices, organizations, yaraRuleSets } from '../db/schema';
import { compareAgentVersions, parseComparableVersion } from './agentEditionCompat';

/**
 * First agent release carrying the W02 YARA engine (#9112, merged after
 * v0.123.0). Older agents ignore `ruleSets` and run the legacy matcher, so the
 * server does not send them and records `agent_too_old` instead.
 */
export const MIN_AGENT_VERSION_YARA_SCAN = '0.124.0';

/**
 * Core-semver compare, failing CLOSED on anything unparseable — the
 * `agentSupportsSystemCleanup` rules (services/systemCleanup.ts): '' and 'dev'
 * must not compare as "equal to the minimum", and a prerelease of the minimum
 * (the lab build) counts as the minimum.
 */
export function agentSupportsYaraScan(agentVersion: string | null | undefined): boolean {
  if (typeof agentVersion !== 'string') return false;
  const core = agentVersion.trim().split('-', 1)[0] ?? '';
  if (!parseComparableVersion(core)) return false;
  return compareAgentVersions(core, MIN_AGENT_VERSION_YARA_SCAN) >= 0;
}

export type YaraRefErrorCode = 'not_found' | 'disabled' | 'not_published';

export interface ResolvedYaraRefs {
  refs: YaraRuleSetRef[];
  errors: Array<{ id: string; code: YaraRefErrorCode }>;
}

export async function resolveYaraRuleSetRefs(input: {
  deviceId: string;
  ruleSetIds: readonly string[];
}): Promise<ResolvedYaraRefs> {
  if (input.ruleSetIds.length === 0) return { refs: [], errors: [] };

  const [device] = await db
    .select({ agentId: devices.agentId, orgId: devices.orgId, partnerId: organizations.partnerId })
    .from(devices)
    .innerJoin(organizations, eq(organizations.id, devices.orgId))
    .where(eq(devices.id, input.deviceId))
    .limit(1);
  if (!device) {
    return { refs: [], errors: input.ruleSetIds.map((id) => ({ id, code: 'not_found' as const })) };
  }

  const rows = await db
    .select({
      id: yaraRuleSets.id,
      enabled: yaraRuleSets.enabled,
      publishedVersion: yaraRuleSets.publishedVersion,
      publishedSha256: yaraRuleSets.publishedSha256,
    })
    .from(yaraRuleSets)
    .where(
      and(
        inArray(yaraRuleSets.id, [...input.ruleSetIds]),
        or(
          eq(yaraRuleSets.orgId, device.orgId),
          and(isNull(yaraRuleSets.orgId), eq(yaraRuleSets.partnerId, device.partnerId)),
          sql`${yaraRuleSets.isBuiltin} = true`,
        ),
      ),
    );
  const byId = new Map(rows.map((r) => [r.id, r]));

  const refs: YaraRuleSetRef[] = [];
  const errors: ResolvedYaraRefs['errors'] = [];
  for (const id of input.ruleSetIds) {
    const row = byId.get(id);
    if (!row) errors.push({ id, code: 'not_found' });
    else if (!row.enabled) errors.push({ id, code: 'disabled' });
    else if (row.publishedVersion < 1 || !row.publishedSha256) errors.push({ id, code: 'not_published' });
    else {
      refs.push({
        id,
        version: row.publishedVersion,
        sha256: row.publishedSha256,
        url: `/api/v1/agents/${encodeURIComponent(device.agentId)}/yara/rule-sets/${id}/${row.publishedVersion}`,
      });
    }
  }
  return { refs, errors };
}

export interface YaraScanPlan {
  /** Empty means "send no `ruleSets` key" (W02 C1). */
  ruleSets: YaraRuleSetRef[];
  engine: SecurityScanEngine;
  /** null when there is nothing to record. */
  ruleSetErrors: YaraRuleSetError[] | null;
}

/** The scan outcome to dispatch and record for one device. */
export async function planYaraScan(input: {
  deviceId: string;
  agentVersion: string | null | undefined;
  ruleSetIds: readonly string[];
}): Promise<YaraScanPlan> {
  if (input.ruleSetIds.length === 0) {
    return { ruleSets: [], engine: 'legacy', ruleSetErrors: null };
  }
  if (!agentSupportsYaraScan(input.agentVersion)) {
    return {
      ruleSets: [],
      engine: 'legacy',
      ruleSetErrors: [{
        id: '*',
        code: 'agent_too_old',
        detail: `agent ${input.agentVersion || 'unknown'} is older than ${MIN_AGENT_VERSION_YARA_SCAN}`,
      }],
    };
  }
  const { refs, errors } = await resolveYaraRuleSetRefs({ deviceId: input.deviceId, ruleSetIds: input.ruleSetIds });
  return {
    ruleSets: refs,
    engine: refs.length > 0 ? 'yara' : 'legacy',
    ruleSetErrors: errors.length > 0 ? errors : null,
  };
}
