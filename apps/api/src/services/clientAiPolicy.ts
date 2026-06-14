import { eq } from 'drizzle-orm';
import { db } from '../db';
import { clientAiOrgPolicies } from '../db/schema/clientAi';

/**
 * Per-org policy for Breeze AI for Office (spec §7).
 *
 * One row per org in client_ai_org_policies; ABSENCE of a row means
 * "disabled, defaults" — defaultClientAiPolicy() materialises that so callers
 * never branch on null. Deliberately separate from the technician AI budget
 * knobs so the two products never interfere.
 *
 * Callers must already be inside a DB access context that can see the org's
 * row (request path: clientAiAuthMiddleware / authMiddleware; pre-auth
 * exchange path: withSystemDbAccessContext).
 */

export interface ClientAiOrgPolicy {
  orgId: string;
  enabled: boolean;
  userAccess: 'all' | 'selected';
  /** portal_users UUIDs permitted when userAccess === 'selected'. */
  selectedUserIds: string[];
  allowedProviders: string[];
  /** Empty = all models of the allowed providers (provider defaults). */
  allowedModels: string[];
  writeMode: 'readwrite' | 'readonly';
  /**
   * Workbook-write approval policy (spec §7). 'ask' = the end user approves
   * every write in the pane (current behaviour). 'allow_auto' = the org permits
   * the end user to flip the pane into auto-apply. DEFAULT (and the
   * default-deny fallback) is always 'ask' — auto-apply is impossible unless the
   * org explicitly opts in here, enforced server-side, not just in the pane.
   */
  writeApproval: 'ask' | 'allow_auto';
  dlpConfig: Record<string, unknown>;
  dailyBudgetCents: number | null;
  monthlyBudgetCents: number | null;
  perUserMessagesPerMinute: number;
  orgMessagesPerHour: number;
  retentionDays: number | null;
  branding: Record<string, unknown>;
}

export function defaultClientAiPolicy(orgId: string): ClientAiOrgPolicy {
  return {
    orgId,
    enabled: false,
    userAccess: 'all',
    selectedUserIds: [],
    allowedProviders: ['anthropic'],
    allowedModels: [],
    writeMode: 'readwrite',
    writeApproval: 'ask',
    dlpConfig: {},
    dailyBudgetCents: null,
    monthlyBudgetCents: null,
    perUserMessagesPerMinute: 10,
    orgMessagesPerHour: 500,
    retentionDays: null,
    branding: {},
  };
}

function asStringArray(value: unknown, fallback: string[]): string[] {
  return Array.isArray(value) && value.every((v) => typeof v === 'string')
    ? (value as string[])
    : fallback;
}

function asRecord(value: unknown): Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

export async function getOrgPolicy(orgId: string): Promise<ClientAiOrgPolicy> {
  const [row] = await db
    .select()
    .from(clientAiOrgPolicies)
    .where(eq(clientAiOrgPolicies.orgId, orgId))
    .limit(1);

  if (!row) return defaultClientAiPolicy(orgId);

  const defaults = defaultClientAiPolicy(orgId);
  return {
    orgId,
    enabled: row.enabled === true,
    userAccess: row.userAccess === 'selected' ? 'selected' : 'all',
    selectedUserIds: asStringArray(row.selectedUserIds, defaults.selectedUserIds),
    allowedProviders: asStringArray(row.allowedProviders, defaults.allowedProviders),
    allowedModels: asStringArray(row.allowedModels, defaults.allowedModels),
    writeMode: row.writeMode === 'readonly' ? 'readonly' : 'readwrite',
    // Default-deny: ONLY the explicit 'allow_auto' opens the door; anything else
    // (legacy null, garbage, an unknown future value) collapses to 'ask'.
    writeApproval: row.writeApproval === 'allow_auto' ? 'allow_auto' : 'ask',
    dlpConfig: asRecord(row.dlpConfig),
    dailyBudgetCents: row.dailyBudgetCents ?? null,
    monthlyBudgetCents: row.monthlyBudgetCents ?? null,
    perUserMessagesPerMinute: row.perUserMessagesPerMinute ?? defaults.perUserMessagesPerMinute,
    orgMessagesPerHour: row.orgMessagesPerHour ?? defaults.orgMessagesPerHour,
    retentionDays: row.retentionDays ?? null,
    branding: asRecord(row.branding),
  };
}

export function isClientUserPermitted(policy: ClientAiOrgPolicy, clientUserId: string): boolean {
  if (policy.userAccess === 'all') return true;
  return policy.selectedUserIds.includes(clientUserId);
}

/** Returns the policy when the product is enabled for the org, else null. */
export async function requireClientAiEnabled(orgId: string): Promise<ClientAiOrgPolicy | null> {
  const policy = await getOrgPolicy(orgId);
  return policy.enabled ? policy : null;
}
