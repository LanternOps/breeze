/**
 * Typed client for the IOC sweep routes (#6263 W05, PR A).
 *
 * Reads throw `HttpError` so callers can tell a 403 (AccessDenied, no retry)
 * from a transient failure. Every POST goes through `runAction`
 * (no-silent-mutations guard); structured `detail` payloads stay on
 * `ActionError.body` so the dialog can act on them (a fresh preview after
 * `SWEEP_SCOPE_CHANGED`, the running group after `SWEEP_ALREADY_RUNNING`).
 */
import { fetchWithAuth } from '@/stores/auth';
import { runAction } from '@/lib/runAction';
import { throwIfNotOk } from '@/lib/httpError';
import { navigateTo } from '@/lib/navigation';
import { i18n } from '@/lib/i18n';
import { asList } from '@/lib/asList';
import type {
  SecuritySweepScanType,
  SecuritySweepScope,
  SecuritySweepSkipReason,
  SecuritySweepState,
  SweepProgress,
  SweepSummary,
} from '@breeze/shared';

const BASE = '/security/sweeps';

const onUnauthorized = () => void navigateTo('/login', { replace: true });

function fallback(): string {
  return i18n.t('common:states.error');
}

/** The body of `POST /sweeps/preview` and the create request, minus the digest. */
export interface SweepRequest {
  ruleSetIds: string[];
  scope: SecuritySweepScope;
  scanType: SecuritySweepScanType;
  paths?: string[];
  ttlHours?: number;
}

export interface SweepPreview {
  targeted: number;
  byOrg: Array<{ orgId: string; orgName: string | null; targeted: number }>;
  skipped: Partial<Record<SecuritySweepSkipReason, number>>;
  ruleSets: Array<{ id: string; name: string | null; version: number }>;
  previewDigest: string;
}

export interface SweepCreated {
  groupId: string;
  sweeps: SweepSummary[];
}

export interface SweepGroup {
  groupId: string;
  sweeps: SweepSummary[];
  targeted: number;
  progress: SweepProgress;
}

export interface SweepCancelResult {
  sweeps: SweepSummary[];
  cancelledQueued: number;
  cancelledUndelivered: number;
  stillRunning: number;
}

export interface SweepListPage {
  data: SweepSummary[];
  total: number;
  page: number;
  limit: number;
}

/** `detail` of an error body (`{ error, code, detail? }`), or `{}`. */
export function sweepErrorDetail(body: unknown): Record<string, unknown> {
  if (body && typeof body === 'object') {
    const detail = (body as { detail?: unknown }).detail;
    if (detail && typeof detail === 'object') return detail as Record<string, unknown>;
  }
  return {};
}

const num = (v: unknown): number | undefined => (typeof v === 'number' ? v : undefined);

/** Maps every W05-4/5/6 error code the sweep routes emit to locale copy. */
export function sweepsFriendly(code: string, _message?: string, body?: unknown): string | undefined {
  const detail = sweepErrorDetail(body);
  switch (code) {
    case 'ORG_OUT_OF_SCOPE':
      return i18n.t('security:sweeps.errors.orgOutOfScope');
    case 'SITE_OUT_OF_SCOPE':
      return i18n.t('security:sweeps.errors.siteOutOfScope');
    case 'DEVICE_OUT_OF_SCOPE':
      return i18n.t('security:sweeps.errors.deviceOutOfScope');
    case 'RULE_SET_NOT_FOUND':
      return i18n.t('security:sweeps.errors.ruleSetNotFound');
    case 'RULE_SET_NOT_PUBLISHED':
      return i18n.t('security:sweeps.errors.ruleSetNotPublished');
    case 'SWEEP_TOO_LARGE':
      return i18n.t('security:sweeps.errors.sweepTooLarge', { targeted: num(detail.targeted) ?? 0, max: num(detail.max) ?? 0 });
    case 'NO_ELIGIBLE_DEVICES':
      return i18n.t('security:sweeps.errors.noEligibleDevices');
    case 'SWEEP_SCOPE_CHANGED':
      return i18n.t('security:sweeps.errors.scopeChanged');
    case 'SWEEP_ALREADY_RUNNING':
      return i18n.t('security:sweeps.errors.alreadyRunning');
    case 'TOO_MANY_ACTIVE_SWEEPS':
      return i18n.t('security:sweeps.errors.tooManyActive', { max: num(detail.max) ?? 0 });
    case 'MFA_REQUIRED':
      return i18n.t('security:sweeps.errors.mfaRequired', {
        targeted: num(detail.targeted) ?? 0,
        threshold: num(detail.threshold) ?? 0,
      });
    case 'RATE_LIMITED':
      return i18n.t('security:sweeps.errors.rateLimited');
    default:
      return undefined;
  }
}

// ---------------------------------------------------------------------------
// Reads
// ---------------------------------------------------------------------------

export async function listSweeps(
  params: { state?: SecuritySweepState; orgId?: string; page?: number; limit?: number } = {},
): Promise<SweepListPage> {
  const qs = new URLSearchParams();
  if (params.state) qs.set('state', params.state);
  if (params.orgId) qs.set('orgId', params.orgId);
  qs.set('page', String(params.page ?? 1));
  qs.set('limit', String(params.limit ?? 25));
  const res = throwIfNotOk(await fetchWithAuth(`${BASE}?${qs.toString()}`));
  const body = (await res.json()) as {
    data?: unknown;
    pagination?: { page?: number; limit?: number; total?: number };
  };
  if (!Array.isArray(body.data)) throw new Error('Invalid sweep list');
  return {
    data: body.data as SweepSummary[],
    total: body.pagination?.total ?? body.data.length,
    page: body.pagination?.page ?? 1,
    limit: body.pagination?.limit ?? 25,
  };
}

export async function getSweep(id: string): Promise<SweepSummary> {
  const res = throwIfNotOk(await fetchWithAuth(`${BASE}/${encodeURIComponent(id)}`));
  const body = (await res.json()) as { data?: SweepSummary };
  if (!body.data) throw new Error('Invalid sweep');
  return body.data;
}

export async function getSweepGroup(groupId: string): Promise<SweepGroup> {
  const res = throwIfNotOk(await fetchWithAuth(`${BASE}/groups/${encodeURIComponent(groupId)}`));
  const body = (await res.json()) as { data?: SweepGroup };
  if (!body.data || !Array.isArray(body.data.sweeps)) throw new Error('Invalid sweep group');
  return body.data;
}

/** Sites of one org, for the "Sites" scope picker (the same read the org record uses). */
export async function listOrgSites(orgId: string): Promise<Array<{ id: string; name: string }>> {
  const res = throwIfNotOk(
    await fetchWithAuth(`/orgs/sites?organizationId=${encodeURIComponent(orgId)}&page=1&limit=100`),
  );
  return asList<{ id: string; name: string }>(await res.json());
}

// ---------------------------------------------------------------------------
// Mutations (every POST goes through runAction)
// ---------------------------------------------------------------------------

/**
 * Preview writes nothing, but it is a POST: failures are shown inline by the
 * dialog (it needs the structured detail), so the error toast is suppressed.
 */
export async function previewSweep(request: SweepRequest): Promise<SweepPreview> {
  const body = await runAction<{ data: SweepPreview }>({
    request: () => fetchWithAuth(`${BASE}/preview`, { method: 'POST', body: JSON.stringify(request) }),
    errorFallback: fallback(),
    friendly: sweepsFriendly,
    suppressErrorToast: () => true,
    onUnauthorized,
  });
  return body.data;
}

/** Codes the dialog renders inline, so a toast on top would say it twice. */
const INLINE_CREATE_CODES = new Set(['SWEEP_SCOPE_CHANGED', 'SWEEP_ALREADY_RUNNING']);

export async function createSweep(request: SweepRequest & { previewDigest: string }): Promise<SweepCreated> {
  const body = await runAction<{ data: SweepCreated }>({
    request: () => fetchWithAuth(BASE, { method: 'POST', body: JSON.stringify(request) }),
    errorFallback: fallback(),
    friendly: sweepsFriendly,
    suppressErrorToast: (_status, code) => code !== undefined && INLINE_CREATE_CODES.has(code),
    successMessage: i18n.t('security:sweeps.started'),
    onUnauthorized,
  });
  return body.data;
}

const cancelMessage = (r: { data: SweepCancelResult }): string =>
  i18n.t('security:sweeps.cancelled', {
    queued: r.data.cancelledQueued + r.data.cancelledUndelivered,
    stillRunning: r.data.stillRunning,
  });

export async function cancelSweep(id: string): Promise<SweepCancelResult> {
  const body = await runAction<{ data: SweepCancelResult }>({
    request: () => fetchWithAuth(`${BASE}/${encodeURIComponent(id)}/cancel`, { method: 'POST' }),
    errorFallback: fallback(),
    friendly: sweepsFriendly,
    successMessage: cancelMessage,
    onUnauthorized,
  });
  return body.data;
}

export async function cancelSweepGroup(groupId: string): Promise<SweepCancelResult> {
  const body = await runAction<{ data: SweepCancelResult }>({
    request: () => fetchWithAuth(`${BASE}/groups/${encodeURIComponent(groupId)}/cancel`, { method: 'POST' }),
    errorFallback: fallback(),
    friendly: sweepsFriendly,
    successMessage: cancelMessage,
    onUnauthorized,
  });
  return body.data;
}
