import { fetchWithAuth } from '../../../stores/auth';
import { extractApiError } from '@/lib/apiError';
import { i18n } from '@/lib/i18n';

// Mirrors of apps/api/src/services/monitors/conversion/ (W05c1). Do not widen
// them here — a field the API does not send is a lie the panel will render.
export type ConversionSourceTable =
  | 'config_policy_alert_rules' | 'config_policy_monitoring_watches' | 'alert_templates'
  | 'automations' | 'config_policy_automations' | 'network_monitors';
export type ProposedRole = 'primary' | 'resource_cpu' | 'resource_memory' | 'response';
export type ProposedMonitor = {
  role: ProposedRole; kind: string; name: string; condition: Record<string, unknown>; severity: string;
  deliveryMode: 'inherit' | 'channels' | 'none'; deliveryChannelIds: string[];
  escalationPolicyId: string | null; responses: unknown[]; enabled: boolean; cooldownMinutes: number; autoResolve: boolean;
};
export type RetirementReason = 'operator' | `unconvertible:${string}`;
export type ConversionPreviewItem = {
  sourceTable: ConversionSourceTable; sourceId: string; name: string;
  outcome: 'convertible' | 'unconvertible'; reason?: string;
  proposed: ProposedMonitor[]; notes: string[]; openAlerts: number;
};
export type PolicyConversionPreview = {
  policyId: string; previewHash: string; items: ConversionPreviewItem[];
  inheritanceMode: 'cumulative' | 'replace';
  equivalence: { devicesChecked: number; deltas: Array<{ deviceId: string; detail: string }> };
  blockedBy?: 'parent_unconverted' | 'prerequisite_missing';
};
export type ConversionLedgerEntry = {
  id: string; sourceTable: ConversionSourceTable; sourceId: string; sourceName: string;
  policyId: string | null; convertedBy: string | null; convertedAt: string;
  revertedAt: string | null; revertable: boolean;
  outputs: Array<{ monitorId: string; role: string; reused: boolean }>;
};
export type LedgerPage = { items: ConversionLedgerEntry[]; nextCursor: string | null };
export type PartnerConversionPreview = {
  partnerId: string; previewHash: string; policies: number; rows: number; convertible: number;
  unconvertible: Array<{ policyId: string | null; policyName: string | null;
    sourceTable: ConversionSourceTable; sourceId: string; name: string; reason: string }>;
};
export const readPartnerPreview = (body: unknown): PartnerConversionPreview => unwrap(body);
export const readRetireResult = (body: unknown): { conversionId: string } => unwrap(body);
export type PendingCounts = { policies: number; rows: number; pendingPolicies?: Array<{ id: string; name: string }> };
export type ConvertResult = { conversionIds: string[]; retired: number; monitorsCreated: number };
export type PartnerConvertResult = { policies: number; converted: number; unconvertible: number };

export const CONVERSION_BASE = '/monitor-definitions/conversion';
// The ONLY place W05c1's leaf paths appear on the web. Verified in Task 1 Step 0.
export const conversionPaths = {
  preview: (policyId: string) => `${CONVERSION_BASE}/policies/${encodeURIComponent(policyId)}/preview`,
  convert: (policyId: string) => `${CONVERSION_BASE}/policies/${encodeURIComponent(policyId)}/convert`,
  revert: (conversionId: string) => `${CONVERSION_BASE}/${encodeURIComponent(conversionId)}/revert`,
  retire: () => `${CONVERSION_BASE}/retire`,
  partnerPreview: () => `${CONVERSION_BASE}/partner/preview`,
  ledger: (filters: { orgId?: string; policyId?: string; cursor?: string; limit?: number } = {}) => {
    const query = new URLSearchParams();
    for (const [key, value] of Object.entries(filters)) if (value != null) query.set(key, String(value));
    return `${CONVERSION_BASE}/ledger?${query}`;
  },
  partnerConvertAll: () => `${CONVERSION_BASE}/partner/convert-all`,
  pending: (orgId: string | null) =>
    orgId ? `${CONVERSION_BASE}/pending?orgId=${encodeURIComponent(orgId)}` : `${CONVERSION_BASE}/pending`,
} as const;

function unwrap<T>(body: unknown): T {
  return (body && typeof body === 'object' && 'data' in (body as object) ? (body as { data: T }).data : body) as T;
}

/**
 * Machine tokens the conversion routes put in `error` (ConversionError codes,
 * the prerequisite 409 and the failed background preview). They carry no
 * `code`, so runAction's `errors:<code>` lookup never sees them.
 */
export const CONVERSION_ERROR_CODES = [
  'preview_stale', 'preview_failed', 'equivalence_delta', 'CONVERSION_PREREQUISITE_MISSING', 'blocked',
  'already_converted', 'partner_wide_denied', 'policy_not_found', 'source_not_found',
  'conversion_not_found', 'conversion_revert_unavailable', 'invalid_reason',
] as const;
const TOKEN_SHAPE = /^[A-Za-z]+(?:_[A-Za-z0-9]+)+$/;

/**
 * The one place a conversion error body becomes user-facing text: a known
 * token maps to its translated sentence; otherwise the server's readable
 * `message`; otherwise, for an unknown machine token, a generic sentence.
 * Returns undefined when `error` is already prose, so the caller keeps it.
 */
export function conversionErrorMessage(body: unknown): string | undefined {
  if (!body || typeof body !== 'object') return undefined;
  const { error, message } = body as { error?: unknown; message?: unknown };
  if (typeof error === 'string' && (CONVERSION_ERROR_CODES as readonly string[]).includes(error)) {
    return i18n.t(/* i18n-dynamic */ `monitoring:conversion.errorCodes.${error}`);
  }
  if (typeof message === 'string' && message.trim()) return message;
  if (typeof error === 'string' && TOKEN_SHAPE.test(error)) return i18n.t('monitoring:conversion.errorCodes.unknown');
  return undefined;
}
/** `friendly` hook for runAction on every conversion mutation. */
export const conversionFriendly = (_code: string, _message: string, body?: unknown): string | undefined =>
  conversionErrorMessage(body);

async function readJson<T>(response: Response, fallback: string): Promise<T> {
  const body = await response.json().catch(() => null);
  if (!response.ok) throw new Error(conversionErrorMessage(body) ?? extractApiError(body, fallback));
  return unwrap<T>(body);
}

export type PreviewProgress = { checked: number; total: number };
export interface PreviewOptions { signal?: AbortSignal; onProgress?: (progress: PreviewProgress) => void }
function waitForPreview(signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    const abort = () => {
      clearTimeout(timer);
      signal?.removeEventListener('abort', abort);
      reject(new DOMException('Preview cancelled', 'AbortError'));
    };
    const timer = setTimeout(() => { signal?.removeEventListener('abort', abort); resolve(); }, 1000);
    signal?.addEventListener('abort', abort, { once: true });
    if (signal?.aborted) abort();
  });
}
export async function fetchPolicyPreview(policyId: string, options: PreviewOptions = {}): Promise<PolicyConversionPreview> {
  for (;;) {
    if (options.signal?.aborted) throw new DOMException('Preview cancelled', 'AbortError');
    const response = options.signal
      ? await fetchWithAuth(conversionPaths.preview(policyId), { signal: options.signal })
      : await fetchWithAuth(conversionPaths.preview(policyId));
    const value = await readJson<PolicyConversionPreview | {
      status: 'running'; progress: PreviewProgress;
    }>(response, 'Failed to load the conversion preview');
    if ('status' in value && value.status === 'running') {
      options.onProgress?.(value.progress);
      await waitForPreview(options.signal);
      continue;
    }
    return value as PolicyConversionPreview;
  }
}

/**
 * The API wraps every conversion response in `{ data }`; going through
 * readJson/unwrap is what keeps `items` from arriving undefined.
 */
export async function fetchLedgerPage(filters: { orgId?: string; policyId?: string; cursor?: string; limit?: number }): Promise<LedgerPage> {
  return readJson<LedgerPage>(await fetchWithAuth(conversionPaths.ledger(filters)), 'Failed to load the conversion history');
}

export async function fetchPendingCounts(orgId: string | null): Promise<PendingCounts> {
  return readJson(await fetchWithAuth(conversionPaths.pending(orgId)), 'Failed to count pending conversions');
}

export const convertBody = (previewHash: string, sourceIds?: string[]) =>
  sourceIds ? { previewHash, sourceIds } : { previewHash };
export const retireBody = (sourceTable: ConversionSourceTable, sourceId: string, reason: 'operator' | `unconvertible:${string}`) =>
  ({ sourceTable, sourceId, reason });

export const readConvertResult = (body: unknown): ConvertResult => unwrap<ConvertResult>(body);
export const readPartnerConvertResult = (body: unknown): PartnerConvertResult => unwrap<PartnerConvertResult>(body);
