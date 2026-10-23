/**
 * Typed client for the YARA detection-rule routes (#6263 W03/W04).
 *
 * Reads throw `HttpError` on a non-ok response so callers can tell a 403
 * (AccessDenied, no retry) from a transient failure (retry). Every mutation
 * goes through `runAction` (no-silent-mutations guard). The publish-carrying
 * mutations return the parsed body so the caller can read `publish`; their
 * success toast is the caller's `successMessage`, which returns '' (no toast)
 * for every outcome that did not publish (W04-3).
 */
import { fetchWithAuth, type FetchWithAuthOptions } from '@/stores/auth';
import { runAction, type RunActionOptions } from '@/lib/runAction';
import { throwIfNotOk } from '@/lib/httpError';
import { navigateTo } from '@/lib/navigation';
import { i18n } from '@/lib/i18n';
import type {
  YaraIoc,
  YaraIocKind,
  YaraRuleSeverity,
  YaraTestResult,
  YaraThreatRuleView,
} from '@breeze/shared';

/** Mirrors W03 `summarize()` in `apps/api/src/routes/security/yara.ts`. */
export interface YaraRuleSetSummary {
  id: string;
  orgId: string | null;
  partnerId: string | null;
  name: string;
  description: string | null;
  source: string;
  isBuiltin: boolean;
  enabled: boolean;
  autoQuarantine: boolean;
  currentVersion: number;
  publishedVersion: number;
  publishedSha256: string | null;
  publishedAt: string | null;
  publishedEngine: string | null;
  stale: boolean;
  ruleCount: number;
  createdAt: string;
  updatedAt: string;
}

export interface YaraRuleRow {
  id: string;
  name: string;
  source: string;
  severity: YaraRuleSeverity;
  tags: string[];
  enabled: boolean;
  /** Stored as `code: message` text; line numbers are not persisted. */
  compileError: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface YaraRuleSetDetail extends YaraRuleSetSummary {
  rules: YaraRuleRow[];
}

/** W03 `publishBody` (`apps/api/src/routes/security/yaraAccess.ts`). */
export interface YaraPublishBody {
  published: boolean;
  version: number;
  currentVersion: number;
  stale: boolean;
  errors: Array<{ ruleId: string | null; name: string; code: string; message: string; line?: number }>;
  autoQuarantineOnly?: boolean;
  precheckUnavailable?: boolean;
}

/** A mutation body that may carry a publish outcome (absent = nothing republished). */
export interface PublishCarryingBody {
  publish?: YaraPublishBody;
}

export type SuccessMessage<T> = RunActionOptions<T>['successMessage'];

export type RuleSetOwnerKind = 'builtin' | 'partner' | 'organization';

export function ownerKind(set: Pick<YaraRuleSetSummary, 'isBuiltin' | 'orgId'>): RuleSetOwnerKind {
  if (set.isBuiltin) return 'builtin';
  return set.orgId === null ? 'partner' : 'organization';
}

const BASE = '/security/yara';

const onUnauthorized = () => void navigateTo('/login', { replace: true });

function fallback(): string {
  return i18n.t('common:states.error');
}

/** Maps the W03/W04 error codes the routes emit to friendly copy. */
export function detectionRulesFriendly(code: string): string | undefined {
  switch (code) {
    case 'AUTO_QUARANTINE_EXECUTE_REQUIRED':
      return i18n.t('security:detectionRules.errors.autoQuarantineExecuteRequired');
    case 'IOC_BATCH_ALREADY_IMPORTED':
      return i18n.t('security:detectionRules.errors.iocBatchAlreadyImported');
    case 'IOC_RULE_NAME_TAKEN':
      return i18n.t('security:detectionRules.errors.iocRuleNameTaken');
    case 'IOC_TOO_MANY_RULES':
      return i18n.t('security:detectionRules.errors.iocTooManyRules');
    case 'IOC_INVALID':
      return i18n.t('security:detectionRules.errors.iocInvalid');
    default:
      return undefined;
  }
}

// ---------------------------------------------------------------------------
// Reads
// ---------------------------------------------------------------------------

export async function listRuleSets(
  options: Pick<FetchWithAuthOptions, 'orgIdOverride' | 'skipOrgIdInjection' | 'signal'> = {},
): Promise<YaraRuleSetSummary[]> {
  const res = throwIfNotOk(await fetchWithAuth(`${BASE}/rule-sets`, options));
  const body = (await res.json()) as { data?: unknown };
  if (!Array.isArray(body.data)) throw new Error('Invalid rule set list');
  return body.data as YaraRuleSetSummary[];
}

export async function getRuleSet(id: string): Promise<YaraRuleSetDetail> {
  const res = throwIfNotOk(await fetchWithAuth(`${BASE}/rule-sets/${encodeURIComponent(id)}`));
  const body = (await res.json()) as { data?: YaraRuleSetDetail };
  if (!body.data || !Array.isArray(body.data.rules)) throw new Error('Invalid rule set');
  return body.data;
}

export interface ThreatDetailsResponse {
  threat: Record<string, unknown>;
  rule: YaraThreatRuleView;
}

export async function getThreatDetails(threatId: string): Promise<ThreatDetailsResponse> {
  const res = throwIfNotOk(await fetchWithAuth(`/security/threats/${encodeURIComponent(threatId)}/details`));
  const body = (await res.json()) as { data?: ThreatDetailsResponse };
  if (!body.data || typeof body.data.threat !== 'object' || body.data.threat === null) {
    throw new Error('Invalid threat details');
  }
  return body.data;
}

// ---------------------------------------------------------------------------
// Rule-set mutations
// ---------------------------------------------------------------------------

export interface CreateRuleSetInput {
  name: string;
  description?: string;
  ownerScope: 'organization' | 'partner';
  /** Required for a partner-scope user creating an org set; org tokens omit it. */
  orgId?: string;
}

export function createRuleSet(input: CreateRuleSetInput): Promise<{ data: YaraRuleSetSummary }> {
  return runAction<{ data: YaraRuleSetSummary }>({
    request: () => fetchWithAuth(`${BASE}/rule-sets`, { method: 'POST', body: JSON.stringify(input) }),
    errorFallback: fallback(),
    friendly: detectionRulesFriendly,
    successMessage: i18n.t('security:detectionRules.created'),
    onUnauthorized,
  });
}

export interface UpdateRuleSetInput {
  name?: string;
  description?: string;
  enabled?: boolean;
  autoQuarantine?: boolean;
}

export function updateRuleSet<T extends PublishCarryingBody & { data: YaraRuleSetSummary | null }>(
  id: string,
  patch: UpdateRuleSetInput,
  successMessage: SuccessMessage<T>,
): Promise<T> {
  return runAction<T>({
    request: () =>
      fetchWithAuth(`${BASE}/rule-sets/${encodeURIComponent(id)}`, { method: 'PATCH', body: JSON.stringify(patch) }),
    errorFallback: fallback(),
    friendly: detectionRulesFriendly,
    successMessage,
    onUnauthorized,
  });
}

export function deleteRuleSet(id: string): Promise<unknown> {
  return runAction({
    request: () => fetchWithAuth(`${BASE}/rule-sets/${encodeURIComponent(id)}`, { method: 'DELETE' }),
    errorFallback: fallback(),
    friendly: detectionRulesFriendly,
    successMessage: i18n.t('security:detectionRules.deleted'),
    onUnauthorized,
  });
}

// ---------------------------------------------------------------------------
// Rule mutations
// ---------------------------------------------------------------------------

export interface RuleInput {
  name: string;
  source: string;
  severity?: YaraRuleSeverity;
  tags?: string[];
  enabled?: boolean;
}

export type RuleMutationBody = PublishCarryingBody & { data?: { id: string } };

export function createRule(
  setId: string,
  input: RuleInput,
  successMessage: SuccessMessage<RuleMutationBody>,
): Promise<RuleMutationBody> {
  return runAction<RuleMutationBody>({
    request: () =>
      fetchWithAuth(`${BASE}/rule-sets/${encodeURIComponent(setId)}/rules`, {
        method: 'POST',
        body: JSON.stringify(input),
      }),
    errorFallback: fallback(),
    friendly: detectionRulesFriendly,
    successMessage,
    onUnauthorized,
  });
}

export function updateRule(
  ruleId: string,
  patch: Partial<RuleInput>,
  successMessage: SuccessMessage<RuleMutationBody>,
): Promise<RuleMutationBody> {
  return runAction<RuleMutationBody>({
    request: () =>
      fetchWithAuth(`${BASE}/rules/${encodeURIComponent(ruleId)}`, { method: 'PATCH', body: JSON.stringify(patch) }),
    errorFallback: fallback(),
    friendly: detectionRulesFriendly,
    successMessage,
    onUnauthorized,
  });
}

export function deleteRule(
  ruleId: string,
  successMessage: SuccessMessage<RuleMutationBody>,
): Promise<RuleMutationBody> {
  return runAction<RuleMutationBody>({
    request: () => fetchWithAuth(`${BASE}/rules/${encodeURIComponent(ruleId)}`, { method: 'DELETE' }),
    errorFallback: fallback(),
    friendly: detectionRulesFriendly,
    successMessage,
    onUnauthorized,
  });
}

// ---------------------------------------------------------------------------
// IOC import (W04-1, set-scoped per D3)
// ---------------------------------------------------------------------------

export interface ImportIocsInput {
  label: string;
  severity?: YaraRuleSeverity;
  /** Structured IOCs only — the server re-generates the rules; never send rule text. */
  iocs: YaraIoc[];
}

export type ImportIocsBody = PublishCarryingBody & {
  data: { rules: Array<{ id: string | null; name: string; kind: YaraIocKind; iocCount: number }> };
};

export function importIocs(
  setId: string,
  input: ImportIocsInput,
  successMessage: SuccessMessage<ImportIocsBody>,
): Promise<ImportIocsBody> {
  // Exactly these keys: the route's schema is `.strict()` at both levels.
  const body = {
    label: input.label,
    ...(input.severity ? { severity: input.severity } : {}),
    iocs: input.iocs.map((ioc) => ({ kind: ioc.kind, value: ioc.value })),
  };
  return runAction<ImportIocsBody>({
    request: () =>
      fetchWithAuth(`${BASE}/rule-sets/${encodeURIComponent(setId)}/ioc-import`, {
        method: 'POST',
        body: JSON.stringify(body),
      }),
    errorFallback: fallback(),
    friendly: detectionRulesFriendly,
    successMessage,
    onUnauthorized,
  });
}

// ---------------------------------------------------------------------------
// Test upload (W04-2, D1: scanned in the API sandbox)
// ---------------------------------------------------------------------------

/**
 * Client-side ceiling for one test request. The server may take up to 15 s to
 * read the body plus up to 30 s for the scan child, and a client disconnect
 * kills the child, so `fetchWithAuth`'s 30 s JSON default would abort tests
 * the server is still legitimately running. Passed as the caller-provided
 * `signal`, which `fetchWithAuth` already honours instead of its default.
 */
export const RULE_TEST_TIMEOUT_MS = 90_000;

/**
 * Statuses the test panel renders inline (with its own copy), so runAction
 * must not also toast them. Everything else (400, 403, 404, 5xx other than
 * 503) toasts as usual.
 */
const TEST_INLINE_STATUSES = new Set([408, 413, 422, 429, 503]);

export function testSample(
  setId: string,
  file: File,
  opts: { filepath?: string; signal?: AbortSignal } = {},
): Promise<{ data: YaraTestResult }> {
  const params = new URLSearchParams({ filename: file.name });
  if (opts.filepath) params.set('filepath', opts.filepath);
  return runAction<{ data: YaraTestResult }>({
    request: () =>
      fetchWithAuth(`${BASE}/rule-sets/${encodeURIComponent(setId)}/test?${params.toString()}`, {
        method: 'POST',
        // The raw file, not FormData: the route reads an octet-stream body.
        body: file,
        headers: { 'Content-Type': 'application/octet-stream' },
        signal: opts.signal ?? AbortSignal.timeout(RULE_TEST_TIMEOUT_MS),
      }),
    errorFallback: i18n.t('security:detectionRules.test.requestFailed'),
    suppressErrorToast: (status) => TEST_INLINE_STATUSES.has(status),
    onUnauthorized,
  });
}
