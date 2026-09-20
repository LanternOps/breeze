import { and, inArray, isNull, or } from 'drizzle-orm';
import type { PgColumn } from 'drizzle-orm/pg-core';
import { getCurrentDbAccessContext, type DbAccessContext } from '../../../db';
import { configPolicyAssignments, configPolicyFeatureLinks, configurationPolicies, devices, escalationPolicies, monitorDefinitions, notificationChannels, notificationRoutingRules, organizations } from '../../../db/schema';
import { dbAccessContextFromAuth, type AuthContext } from '../../../middleware/auth';
import { getConfigPolicy } from '../../configurationPolicy';
import { canManagePartnerWidePolicies } from '../../partnerWideAccess';
import { canMutateOrgWideGovernance } from '../../siteCeilingAccess';
import { ConversionError } from './convert';
import { resolveDeviceIdsForPolicy, type DbExecutor } from './legacyBaseline';
import { loadPolicySources, type PolicySources } from './loadSources';
import { canonical, sha } from './mapping';

export type SerializedAuth = Omit<AuthContext, 'orgCondition' | 'canAccessOrg' | 'canAccessSite' | 'token'>;
export interface PreviewAccessSnapshot { auth: SerializedAuth; dbContext: DbAccessContext }

export function snapshotPreviewAccess(auth: AuthContext): PreviewAccessSnapshot {
  // A conversion route is self-managed (no ambient context) precisely so its
  // isolated transaction is the only pooled connection it holds, so derive the
  // context from the caller's auth when there is none to read.
  const dbContext = getCurrentDbAccessContext() ?? dbAccessContextFromAuth(auth);
  const { orgCondition, canAccessOrg, canAccessSite, token, ...data } = auth;
  // Match the JSON boundary used by BullMQ, including omission of undefined fields.
  return JSON.parse(JSON.stringify({ auth: data, dbContext })) as PreviewAccessSnapshot;
}

export function restorePreviewAuth(snapshot: PreviewAccessSnapshot): AuthContext {
  const a = structuredClone(snapshot.auth);
  return { ...a, token: null,
    canAccessOrg: (id) => a.scope === 'system' || (a.accessibleOrgIds ?? []).includes(id),
    canAccessSite: (id) => a.allowedSiteIds === undefined || (!!id && (a.allowedSiteIds ?? []).includes(id)),
    orgCondition: (column) => a.scope === 'system' ? undefined : inArray(column, a.accessibleOrgIds ?? []),
  };
}

export const previewScopeHash = (snapshot: PreviewAccessSnapshot): string => sha(canonical(snapshot));

export async function authorizePreview(policyId: string, auth: AuthContext) {
  if (!canMutateOrgWideGovernance(auth)) throw new ConversionError('partner_wide_denied', 'Full policy scope is required');
  const policy = await getConfigPolicy(policyId, auth);
  if (!policy) throw new ConversionError('policy_not_found', 'Policy not found');
  if (!policy.orgId && (!canManagePartnerWidePolicies(auth)
    || (auth.scope !== 'system' && auth.partnerId !== policy.partnerId))) {
    throw new ConversionError('partner_wide_denied', 'Partner-wide access required');
  }
  return policy;
}

// Normalize unordered row sets without changing ordered response actions or escalation steps.
function sourceRows(source: PolicySources) {
  const byId = <T extends { id: string }>(rows: T[]): T[] => [...rows].sort((a, b) => a.id.localeCompare(b.id));
  return { ...source, inlineRules: byId(source.inlineRules), watches: byId(source.watches),
    policyAutomations: byId(source.policyAutomations), standaloneAutomations: byId(source.standaloneAutomations),
    openAlertsBySource: [...source.openAlertsBySource].sort(([a], [b]) => a.localeCompare(b)) };
}

/** Only the digest crosses the queue boundary; channel configuration stays in the caller's DB context. */
export async function previewFreshness(policyId: string, executor: DbExecutor): Promise<string> {
  const sources = await loadPolicySources(policyId, executor);
  if (!sources) throw new ConversionError('policy_not_found', 'Policy not found');
  const ids = [...await resolveDeviceIdsForPolicy(policyId, executor)].sort();
  const deviceRows = ids.length ? await executor.select().from(devices).where(inArray(devices.id, ids)).orderBy(devices.id) : [];
  // Include the owner even for an empty scope, so its settings still invalidate previews.
  const orgIds = [...new Set([sources.policy.orgId, ...deviceRows.map((d) => d.orgId)].filter((id): id is string => !!id))];
  const orgs = orgIds.length ? await executor.select().from(organizations).where(inArray(organizations.id, orgIds)).orderBy(organizations.id) : [];
  const partnerIds = [...new Set([sources.policy.partnerId, ...orgs.map((o) => o.partnerId)].filter((id): id is string => !!id))];
  const axis = (table: { orgId: PgColumn; partnerId: PgColumn }) => or(inArray(table.orgId, orgIds), and(isNull(table.orgId), inArray(table.partnerId, partnerIds)));
  const routes = await executor.select().from(notificationRoutingRules).where(axis(notificationRoutingRules)).orderBy(notificationRoutingRules.id);
  const channels = await executor.select().from(notificationChannels).where(axis(notificationChannels)).orderBy(notificationChannels.id);
  // Escalation steps are JSON on the policy row, included in full here.
  const escalation = await executor.select().from(escalationPolicies).where(axis(escalationPolicies)).orderBy(escalationPolicies.id);
  const policies = await executor.select().from(configurationPolicies).where(axis(configurationPolicies)).orderBy(configurationPolicies.id);
  const policyIds = policies.map((p) => p.id);
  const assignments = policyIds.length ? await executor.select().from(configPolicyAssignments).where(inArray(configPolicyAssignments.configPolicyId, policyIds)).orderBy(configPolicyAssignments.id) : [];
  const links = policyIds.length ? await executor.select().from(configPolicyFeatureLinks).where(inArray(configPolicyFeatureLinks.configPolicyId, policyIds)).orderBy(configPolicyFeatureLinks.id) : [];
  const definitions = await executor.select().from(monitorDefinitions).where(axis(monitorDefinitions)).orderBy(monitorDefinitions.id);
  const competitors = await Promise.all([...policies].sort((a, b) => a.id.localeCompare(b.id)).map((p) => loadPolicySources(p.id, executor)));
  return sha(canonical({ sources: sourceRows(sources), competitors: competitors.map((p) => p ? sourceRows(p) : null),
    ids, deviceRows, orgs, policies, assignments, links, definitions, routes, channels, escalation }));
}
