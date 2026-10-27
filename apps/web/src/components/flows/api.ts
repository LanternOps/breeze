// Typed fetch wrappers for the Flows API (tool catalog W3 #5218 reads, W4 #5219
// enable/disable/run/cancel), mounted at `/flows`. Reads throw `ActionError` on a
// non-2xx; every mutation goes through `runAction` with a success toast, so the
// caller only applies the catch pattern from CLAUDE.md (401 => return, non-
// ActionError => toast).
//
// Unlike the tool-sources routes, these answer bare bodies (`{ flows, total }`,
// `{ flow, validation }`) rather than a `{ data }` envelope.

import type {
  FlowDetailDto,
  FlowEnableRequest,
  FlowEnableResultDto,
  FlowLimitsUpdate,
  FlowLimitsViewDto,
  FlowManualRunRequest,
  FlowRunDetailDto,
  FlowRunStatus,
  FlowRunStepDetailDto,
  FlowRunSummaryDto,
  FlowSummaryDto,
  FlowStatus,
  FlowValidationResult,
  FlowWebhookDeliveryDto,
  FlowWebhookSecretRevealDto,
} from '@breeze/shared';
import { fetchWithAuth } from '../../stores/auth';
import { extractApiError } from '../../lib/apiError';
import { ActionError, runAction } from '../../lib/runAction';
import { i18n } from '../../lib/i18n';

export type {
  FlowDetailDto,
  FlowEnableRequest,
  FlowManualRunRequest,
  FlowRunDetailDto,
  FlowRunStatus,
  FlowRunStepDetailDto,
  FlowRunSummaryDto,
  FlowSummaryDto,
  FlowStatus,
  FlowValidationResult,
  FlowLimitsUpdate,
  FlowLimitsViewDto,
  FlowWebhookDeliveryDto,
  FlowWebhookSecretRevealDto,
};

const BASE = '/flows';

export interface ListFlowsParams {
  orgId?: string;
  status?: FlowStatus;
  limit?: number;
  offset?: number;
}

async function readJson<T>(res: Response): Promise<T> {
  if (!res.ok) {
    let body: unknown;
    try {
      body = await res.json();
    } catch {
      body = undefined;
    }
    throw new ActionError(extractApiError(body, `Request failed (${res.status})`), res.status);
  }
  try {
    return (await res.json()) as T;
  } catch {
    throw new ActionError(`Malformed response body (${res.status})`, res.status);
  }
}

export async function listFlows(
  params: ListFlowsParams = {},
): Promise<{ flows: FlowSummaryDto[]; total: number }> {
  const qs = new URLSearchParams();
  if (params.orgId) qs.set('orgId', params.orgId);
  if (params.status) qs.set('status', params.status);
  if (params.limit !== undefined) qs.set('limit', String(params.limit));
  if (params.offset !== undefined) qs.set('offset', String(params.offset));
  const query = qs.toString();
  const body = await readJson<{ flows?: FlowSummaryDto[]; total?: number }>(
    await fetchWithAuth(query ? `${BASE}?${query}` : BASE),
  );
  if (!Array.isArray(body?.flows)) {
    throw new ActionError('Unexpected response shape: missing flows', 200);
  }
  return { flows: body.flows, total: typeof body.total === 'number' ? body.total : body.flows.length };
}

export async function getFlow(
  id: string,
): Promise<{ flow: FlowDetailDto; validation: FlowValidationResult }> {
  const body = await readJson<{ flow?: FlowDetailDto; validation?: FlowValidationResult }>(
    await fetchWithAuth(`${BASE}/${encodeURIComponent(id)}`),
  );
  if (!body?.flow || !body.validation) {
    throw new ActionError('Unexpected response shape: missing flow', 200);
  }
  return { flow: body.flow, validation: body.validation };
}

export interface ListFlowRunsParams {
  status?: FlowRunStatus;
  orgId?: string;
  limit?: number;
  offset?: number;
}

export async function listFlowRuns(
  flowId: string,
  params: ListFlowRunsParams = {},
): Promise<{ runs: FlowRunSummaryDto[]; total: number }> {
  const qs = new URLSearchParams();
  if (params.status) qs.set('status', params.status);
  if (params.orgId) qs.set('orgId', params.orgId);
  if (params.limit !== undefined) qs.set('limit', String(params.limit));
  if (params.offset !== undefined) qs.set('offset', String(params.offset));
  const query = qs.toString();
  const path = `${BASE}/${encodeURIComponent(flowId)}/runs`;
  const body = await readJson<{ runs?: FlowRunSummaryDto[]; total?: number }>(
    await fetchWithAuth(query ? `${path}?${query}` : path),
  );
  if (!Array.isArray(body?.runs)) {
    throw new ActionError('Unexpected response shape: missing runs', 200);
  }
  return { runs: body.runs, total: typeof body.total === 'number' ? body.total : body.runs.length };
}

/** The polled endpoint: step bodies (`renderedInput` / `output`) are omitted. */
export async function getFlowRun(runId: string): Promise<FlowRunDetailDto> {
  const body = await readJson<FlowRunDetailDto | null>(
    await fetchWithAuth(`${BASE}/runs/${encodeURIComponent(runId)}`),
  );
  if (!body || typeof body !== 'object' || typeof body.id !== 'string') {
    throw new ActionError('Unexpected response shape: missing run', 200);
  }
  return body;
}

/** One step row with its (redacted, possibly pruned) bodies; loaded lazily on expand. */
export async function getFlowRunStep(runId: string, stepRowId: string): Promise<FlowRunStepDetailDto> {
  const body = await readJson<FlowRunStepDetailDto | null>(
    await fetchWithAuth(`${BASE}/runs/${encodeURIComponent(runId)}/steps/${encodeURIComponent(stepRowId)}`),
  );
  if (!body || typeof body !== 'object' || typeof body.id !== 'string') {
    throw new ActionError('Unexpected response shape: missing step', 200);
  }
  return body;
}

// ---- Mutations -------------------------------------------------------------

/** POST init; the `fetchWithAuth` call itself stays lexically inside each `runAction` (no-silent-mutations guard). */
function postInit(body?: unknown): RequestInit {
  return {
    method: 'POST',
    ...(body === undefined
      ? {}
      : { headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) }),
  };
}

/**
 * Route error tokens (`{ error: 'delegation_scope_restricted' }`) -> localized
 * toast copy, so a refused write never toasts the raw token. MFA_REQUIRED is
 * not listed: runAction already localizes it from `errors:MFA_REQUIRED`.
 */
const FLOW_ERROR_KEYS: Record<string, string> = {
  delegation_scope_restricted: 'flows:run.delegationScopeRestricted',
  interactive_user_required: 'flows:run.interactiveUserRequired',
  org_forbidden: 'flows:run.orgForbidden',
  org_required: 'flows:run.orgRequired',
  not_manual: 'flows:run.notManual',
  not_enabled: 'flows:run.notEnabled',
  flow_queue_full: 'flows:run.queueFull',
  flow_not_found: 'flows:errors.notFound',
  run_not_found: 'flows:runDetail.notFound',
  already_terminal: 'flows:runDetail.alreadyTerminal',
  partner_wide_forbidden: 'flows:enable.partnerWideForbidden',
  interactive_session_required: 'flows:enable.interactiveRequired',
};

function flowFriendly(code: string): string | undefined {
  const key = FLOW_ERROR_KEYS[code];
  return key ? i18n.t(/* i18n-dynamic */ key) : undefined;
}

/** The machine token of a failed response: `code` (MFA_REQUIRED) or `error` (everything else). */
function errorToken(code: string | undefined, body: unknown): string | undefined {
  if (code) return code;
  const e = body && typeof body === 'object' ? (body as { error?: unknown }).error : undefined;
  return typeof e === 'string' ? e : undefined;
}

/**
 * Failures the enable dialog renders inline (every code it maps, any status), so
 * a toast on top would report the same error twice. Unmapped errors still toast.
 */
const ENABLE_INLINE_CODES = new Set([
  'MFA_REQUIRED',
  'version_conflict',
  'already_enabled',
  'event_dispatch_not_durable',
  'foreach_concurrency_not_available',
  'delegation_scope_restricted',
  'partner_wide_forbidden',
  'interactive_session_required',
  'slug_unavailable',
  'flow_not_found',
  'permission_missing',
  'invalid',
  'pre_approval_not_eligible',
  'webhook_secret_missing',
  'ai_budget_unavailable',
]);

/** Failures the run dialog renders inline. */
const RUN_INLINE_CODES = new Set([
  'inputs_invalid',
  'permission_missing',
  'flow_queue_full',
  'not_enabled',
  'org_required',
  'delegation_scope_restricted',
  'interactive_user_required',
  'org_forbidden',
  'not_manual',
  'flow_not_found',
  'MFA_REQUIRED',
]);

/** The shared enable result; `webhookSecretInvalidated` must be surfaced (#10270). */
export type EnableFlowResult = FlowEnableResultDto;

/**
 * Enable the flow's current version. A 422 (validation / missing permissions /
 * ineligible pre-approval) carries `validation`, `missing`, `stepId`, `reason`
 * and `error` in the body; it is NOT toasted here, so the enable dialog can
 * render it inline. Read it from the thrown `ActionError.body`.
 */
export function enableFlow(flowId: string, body: FlowEnableRequest): Promise<EnableFlowResult> {
  return runAction<EnableFlowResult>({
    request: () => fetchWithAuth(`${BASE}/${encodeURIComponent(flowId)}/enable`, postInit(body)),
    errorFallback: i18n.t('flows:errors.enableFailed'),
    successMessage: i18n.t('flows:toast.enabled'),
    suppressErrorToast: (status, code, body) => {
      if (status === 422) return true;
      const token = errorToken(code, body);
      return token !== undefined && ENABLE_INLINE_CODES.has(token);
    },
    friendly: flowFriendly,
  });
}

export function disableFlow(flowId: string): Promise<{ ok: boolean; cancelledRuns: number }> {
  return runAction({
    request: () => fetchWithAuth(`${BASE}/${encodeURIComponent(flowId)}/disable`, postInit()),
    errorFallback: i18n.t('flows:errors.disableFailed'),
    friendly: flowFriendly,
    successMessage: i18n.t('flows:toast.disabled'),
  });
}

export function startFlowRun(
  flowId: string,
  body: Partial<FlowManualRunRequest>,
): Promise<{ runId: string; duplicate: boolean }> {
  return runAction({
    request: () => fetchWithAuth(`${BASE}/${encodeURIComponent(flowId)}/runs`, postInit(body)),
    errorFallback: i18n.t('flows:errors.runFailed'),
    suppressErrorToast: (status, code, body) => {
      if (status === 429) return true; // queue full: rendered inline
      const token = errorToken(code, body);
      return token !== undefined && RUN_INLINE_CODES.has(token);
    },
    friendly: flowFriendly,
    successMessage: i18n.t('flows:toast.runStarted'),
  });
}

// ---- W05 (#5220): webhook secret + delivery log, flow limits -----------------

export interface ListWebhookDeliveriesParams {
  limit?: number;
  /** ISO cursor: deliveries received strictly before this time. */
  before?: string;
}

export async function listWebhookDeliveries(
  flowId: string,
  params: ListWebhookDeliveriesParams = {},
): Promise<{ deliveries: FlowWebhookDeliveryDto[]; identifiersHidden: boolean }> {
  const qs = new URLSearchParams();
  if (params.limit !== undefined) qs.set('limit', String(params.limit));
  if (params.before) qs.set('before', params.before);
  const query = qs.toString();
  const path = `${BASE}/${encodeURIComponent(flowId)}/webhook-deliveries`;
  const body = await readJson<{ deliveries?: FlowWebhookDeliveryDto[]; identifiersHidden?: boolean }>(
    await fetchWithAuth(query ? `${path}?${query}` : path),
  );
  if (!Array.isArray(body?.deliveries)) {
    throw new ActionError('Unexpected response shape: missing deliveries', 200);
  }
  // A restricted reader (site- or device-limited) gets the delivery id and the
  // org-resolver value nulled; the flag says they are hidden, not absent.
  return { deliveries: body.deliveries, identifiersHidden: body.identifiersHidden === true };
}

/** The partner default (no orgId), or one org's override and what resolves for it. */
export async function getFlowLimits(orgId?: string): Promise<FlowLimitsViewDto> {
  const path = orgId ? `${BASE}/limits?orgId=${encodeURIComponent(orgId)}` : `${BASE}/limits`;
  // The level is explicit in the URL: never let the switcher's org be injected,
  // or a partner admin with an org selected could never read the partner default.
  const body = await readJson<FlowLimitsViewDto | null>(await fetchWithAuth(path, { orgIdOverride: null }));
  if (!body || typeof body !== 'object' || !body.limits) {
    throw new ActionError('Unexpected response shape: missing limits', 200);
  }
  return body;
}

const SECRET_ERROR_KEYS: Record<string, string> = {
  draft_unresolvable: 'flows:webhook.secret.draftUnresolvable',
  not_webhook: 'flows:webhook.secret.notWebhook',
};

/**
 * Create or rotate the flow's webhook secret. The plaintext is returned to the
 * caller (the reveal-once dialog) and never toasted: there is no success toast
 * at all, so the secret cannot leak into a toast history.
 */
export function rotateWebhookSecret(flowId: string): Promise<FlowWebhookSecretRevealDto> {
  return runAction<FlowWebhookSecretRevealDto>({
    request: () => fetchWithAuth(`${BASE}/${encodeURIComponent(flowId)}/webhook-secret`, postInit()),
    errorFallback: i18n.t('flows:webhook.secret.failed'),
    friendly: (code) => {
      const key = SECRET_ERROR_KEYS[code];
      return key ? i18n.t(/* i18n-dynamic */ key) : flowFriendly(code);
    },
  });
}

const LIMITS_ERROR_KEYS: Record<string, string> = {
  partner_wide_forbidden: 'flows:limits.partnerWideForbidden',
  org_scope_read_only: 'flows:limits.orgScopeReadOnly',
  partner_scope_required: 'flows:limits.partnerWideForbidden',
  org_not_found: 'flows:limits.loadFailed',
};

/**
 * Save one level's limits (`null` clears a field to inherit). A 422
 * `limit_above_partner_ceiling` carries `{ field, ceiling }` and is rendered
 * inline by the form, so it is not toasted.
 */
export function saveFlowLimits(body: FlowLimitsUpdate): Promise<FlowLimitsViewDto> {
  return runAction<FlowLimitsViewDto>({
    request: () => fetchWithAuth(`${BASE}/limits`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
      orgIdOverride: null, // the level is in the body, never the ambient switcher org
    }),
    errorFallback: i18n.t('flows:limits.saveFailed'),
    successMessage: i18n.t('flows:limits.saved'),
    suppressErrorToast: (_status, code, resBody) => errorToken(code, resBody) === 'limit_above_partner_ceiling',
    friendly: (code) => {
      const key = LIMITS_ERROR_KEYS[code];
      return key ? i18n.t(/* i18n-dynamic */ key) : undefined;
    },
  });
}

export function cancelFlowRun(runId: string): Promise<{ status: FlowRunStatus }> {
  return runAction({
    request: () => fetchWithAuth(`${BASE}/runs/${encodeURIComponent(runId)}/cancel`, postInit()),
    errorFallback: i18n.t('flows:errors.cancelFailed'),
    friendly: flowFriendly,
    successMessage: i18n.t('flows:toast.runCancelled'),
  });
}
