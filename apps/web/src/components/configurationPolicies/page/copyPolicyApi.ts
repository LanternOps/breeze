import { CONFIG_POLICY_COPY_DROP_REASONS, type ConfigPolicyCopyDropReason } from '@breeze/shared';
import { i18n } from '@/lib/i18n';
import { runAction } from '@/lib/runAction';
import { navigateTo } from '@/lib/navigation';
import { fetchWithAuth } from '../../../stores/auth';
import type { FeatureType } from '../featureTabs/types';

/**
 * `POST /configuration-policies/:id/copy` (#12309, #11776; plan W05b K3). The
 * owner and the parent go in the body; the server checks both, and decides
 * what the copy can carry. The copy is always inactive and applies nowhere.
 */
export type CopyBody =
  | { name: string; ownerScope: 'partner'; parentPolicyId: string | null }
  | { name: string; ownerScope: 'organization'; orgId?: string; parentPolicyId: string | null };

export type CopyDrop = { featureType: FeatureType; reason: ConfigPolicyCopyDropReason };

export type CopyPreview =
  | { ok: true; carried: FeatureType[]; dropped: CopyDrop[] }
  | { ok: false; status: number; message: string };

const REASONS: ReadonlySet<string> = new Set(CONFIG_POLICY_COPY_DROP_REASONS);

/**
 * The codes of the arming gates a copy re-runs (HP warranty collection,
 * auto-quarantine, security agents, vendor updates): all mean the caller
 * lacks devices:execute (or MFA) for a feature the copy would turn on.
 */
const EXECUTE_REQUIRED_CODES: ReadonlySet<string> = new Set([
  'HP_CMSL_EXECUTE_REQUIRED',
  'AUTO_QUARANTINE_EXECUTE_REQUIRED',
  'AUTO_QUARANTINE_AUTHORITY_UNAVAILABLE',
  'security_agents_execute_required',
  'oem_updates_execute_required',
]);


/** Readable copy for a refusal's `code` or `error`; undefined = use the server's text. */
export function copyRefusalMessage(code: string | undefined): string | undefined {
  if (!code) return undefined;
  if (EXECUTE_REQUIRED_CODES.has(code)) return i18n.t('policies:configurationPolicies.copyPolicy.executeRequired');
  if (code === 'INVALID_PARENT_POLICY') return i18n.t('policies:configurationPolicies.copyPolicy.invalidParent');
  if (code === 'MFA_REQUIRED') return i18n.t('policies:configurationPolicies.copyPolicy.mfaRequired');
  return undefined;
}

function parseDrops(raw: unknown): CopyDrop[] | null {
  if (!Array.isArray(raw)) return null;
  const drops: CopyDrop[] = [];
  for (const row of raw) {
    if (!row || typeof row !== 'object') return null;
    const { featureType, reason } = row as Record<string, unknown>;
    if (typeof featureType !== 'string' || typeof reason !== 'string') return null;
    // A reason this page has no words for is still a feature that is not
    // copied: say so, without inventing why.
    drops.push({
      featureType: featureType as FeatureType,
      reason: (REASONS.has(reason) ? reason : 'settings_not_valid') as ConfigPolicyCopyDropReason,
    });
  }
  return drops;
}

/**
 * The dry run: what the copy would carry and what it would leave behind.
 * Writes nothing.
 */
export async function previewCopy(sourceId: string, body: CopyBody): Promise<CopyPreview> {
  let response: Response;
  try {
    // runaction-exempt: a dry run writes nothing and re-runs whenever the owner or parent changes; the dialog shows the outcome inline, so a toast would be noise.
    response = await fetchWithAuth(`/configuration-policies/${sourceId}/copy`, {
      method: 'POST',
      body: JSON.stringify({ ...body, dryRun: true }),
    });
  } catch {
    return { ok: false, status: 0, message: i18n.t('policies:configurationPolicies.copyPolicy.previewFailed') };
  }
  let data: Record<string, unknown> | null = null;
  try {
    data = (await response.json()) as Record<string, unknown>;
  } catch {
    data = null;
  }
  if (!response.ok) {
    const code = typeof data?.code === 'string' ? data.code : typeof data?.error === 'string' ? data.error : undefined;
    const message = copyRefusalMessage(code)
      ?? (typeof data?.error === 'string' ? data.error : i18n.t('policies:configurationPolicies.copyPolicy.previewFailed'));
    return { ok: false, status: response.status, message };
  }
  const carried = Array.isArray(data?.carried) && data.carried.every((t) => typeof t === 'string')
    ? (data.carried as FeatureType[])
    : null;
  const dropped = parseDrops(data?.dropped);
  if (!carried || !dropped) return { ok: false, status: response.status, message: i18n.t('policies:configurationPolicies.copyPolicy.previewFailed') };
  return { ok: true, carried, dropped };
}

/** The copy itself, through runAction: the new policy's id and what it left behind. */
export async function copyPolicy(sourceId: string, body: CopyBody): Promise<{ policyId: string; dropped: CopyDrop[] }> {
  return runAction<{ policyId: string; dropped: CopyDrop[] }>({
    request: () =>
      fetchWithAuth(`/configuration-policies/${sourceId}/copy`, {
        method: 'POST',
        body: JSON.stringify(body),
      }),
    parseSuccess: (data) => {
      const row = data as { policyId?: unknown; dropped?: unknown } | null;
      if (typeof row?.policyId !== 'string') throw new Error('copy: no policyId in the response');
      return { policyId: row.policyId, dropped: parseDrops(row.dropped) ?? [] };
    },
    errorFallback: i18n.t('policies:configurationPolicies.copyPolicy.failed'),
    friendly: (code) => copyRefusalMessage(code),
    successMessage: i18n.t('policies:configurationPolicies.copyPolicy.copiedToast'),
    onUnauthorized: () => void navigateTo('/login', { replace: true }),
  });
}
