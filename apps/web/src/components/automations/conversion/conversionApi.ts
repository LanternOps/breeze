// Typed client for legacy Job → flow conversions (Tool Catalog W06 #5221),
// mounted at `/flows/conversions`. Reads throw `ActionError` on a non-2xx (a 404
// on the list means Flows are off on this installation). Every mutation goes
// through `runAction`; callers apply the CLAUDE.md catch pattern (401 => return,
// non-ActionError => toast). Switch and revert refusals the dialogs render
// inline are not toasted on top.

import type {
  ConversionSwitchRequest,
  FlowConversionDto,
  FlowConversionPreviewDto,
  FlowConversionState,
  FlowDetailDto,
} from '@breeze/shared';
import { fetchWithAuth } from '../../../stores/auth';
import { extractApiError } from '../../../lib/apiError';
import { ActionError, runAction } from '../../../lib/runAction';
import { i18n } from '../../../lib/i18n';

export type { ConversionSwitchRequest, FlowConversionDto, FlowConversionPreviewDto };

const BASE = '/flows/conversions';

async function readJson<T>(res: Response): Promise<T> {
  if (!res.ok) {
    let body: unknown;
    try {
      body = await res.json();
    } catch {
      body = undefined;
    }
    const code = body && typeof body === 'object' ? (body as { error?: unknown }).error : undefined;
    throw new ActionError(
      extractApiError(body, `Request failed (${res.status})`),
      res.status,
      typeof code === 'string' ? code : undefined,
      body,
    );
  }
  try {
    return (await res.json()) as T;
  } catch {
    throw new ActionError(`Malformed response body (${res.status})`, res.status);
  }
}

// ---- Reads -------------------------------------------------------------------

export async function previewConversion(automationId: string): Promise<FlowConversionPreviewDto> {
  const body = await readJson<FlowConversionPreviewDto | null>(
    await fetchWithAuth(`${BASE}/preview/${encodeURIComponent(automationId)}`),
  );
  if (!body || typeof body !== 'object' || typeof body.fidelity !== 'string' || !Array.isArray(body.findings)) {
    throw new ActionError('Unexpected response shape: missing preview', 200);
  }
  return body;
}

export interface ListConversionsParams {
  state?: FlowConversionState;
  automationId?: string;
  limit?: number;
  offset?: number;
}

export async function listConversions(
  params: ListConversionsParams = {},
): Promise<{ conversions: FlowConversionDto[]; total: number }> {
  const qs = new URLSearchParams();
  if (params.state) qs.set('state', params.state);
  if (params.automationId) qs.set('automationId', params.automationId);
  if (params.limit !== undefined) qs.set('limit', String(params.limit));
  if (params.offset !== undefined) qs.set('offset', String(params.offset));
  const query = qs.toString();
  const body = await readJson<{ conversions?: FlowConversionDto[]; total?: number }>(
    await fetchWithAuth(query ? `${BASE}?${query}` : BASE),
  );
  if (!Array.isArray(body?.conversions)) {
    throw new ActionError('Unexpected response shape: missing conversions', 200);
  }
  return {
    conversions: body.conversions,
    total: typeof body.total === 'number' ? body.total : body.conversions.length,
  };
}

export async function getConversion(id: string): Promise<FlowConversionDto> {
  const body = await readJson<FlowConversionDto | null>(await fetchWithAuth(`${BASE}/${encodeURIComponent(id)}`));
  if (!body || typeof body !== 'object' || typeof body.id !== 'string') {
    throw new ActionError('Unexpected response shape: missing conversion', 200);
  }
  return body;
}

// ---- Mutations ---------------------------------------------------------------

/** POST init; `fetchWithAuth` stays lexically inside each `runAction` (no-silent-mutations guard). */
function postInit(body?: unknown): RequestInit {
  return {
    method: 'POST',
    ...(body === undefined
      ? {}
      : { headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) }),
  };
}

/**
 * Route refusal tokens → localized copy (`flows:conversion.errors.*`). Every
 * token the conversion routes answer with, plus the Job routes' frozen-row and
 * R1 refusals the Jobs page meets (`automation_converted`, `automation_disabled`,
 * `automations_moved_to_flows`).
 */
export const CONVERSION_ERROR_CODES = [
  'automation_not_found',
  'conversion_not_found',
  'conversion_exists',
  'source_changed',
  'unconvertible',
  'draft_rejected',
  'partner_wide_forbidden',
  'owner_forbidden',
  'interactive_session_required',
  'delegation_scope_restricted',
  'not_shadow',
  'not_switched',
  'version_conflict',
  'already_enabled',
  'slug_unavailable',
  'shadow_too_new',
  'shadow_too_short',
  'shadow_divergent',
  'scope_widening_not_accepted',
  'automation_disabled',
  'automation_converted',
  'automations_moved_to_flows',
  'flow_not_found',
  'revert_closed',
  'generated_script_rejected',
  'permission_missing',
  'pre_approval_not_eligible',
  'invalid',
  'event_dispatch_not_durable',
  'webhook_secret_missing',
] as const;
export type ConversionErrorCode = (typeof CONVERSION_ERROR_CODES)[number];

const KNOWN = new Set<string>(CONVERSION_ERROR_CODES);

export function conversionErrorMessage(code: string | undefined): string | undefined {
  if (!code || !KNOWN.has(code)) return undefined;
  return i18n.t(/* i18n-dynamic */ `flows:conversion.errors.${code}`);
}

/** The machine token of a failed response: `code` (MFA_REQUIRED) or `error` (everything else). */
export function conversionErrorToken(err: ActionError): string | undefined {
  if (err.code) return err.code;
  const e = err.body && typeof err.body === 'object' ? (err.body as { error?: unknown }).error : undefined;
  return typeof e === 'string' ? e : undefined;
}

function friendly(code: string): string | undefined {
  return conversionErrorMessage(code);
}

export function createConversion(automationId: string, expectedSourceDigest: string): Promise<FlowConversionDto> {
  return runAction<FlowConversionDto>({
    request: () => fetchWithAuth(BASE, postInit({ automationId, expectedSourceDigest })),
    errorFallback: i18n.t('flows:conversion.errors.createFailed'),
    successMessage: i18n.t('flows:conversion.toast.created'),
    friendly,
  });
}

export interface BulkConversionResult {
  created: number;
  skipped: Record<string, number>;
}

export function createConversionsBulk(
  body: { ownerScope: 'organization'; orgId?: string } | { ownerScope: 'partner' },
): Promise<BulkConversionResult> {
  return runAction<BulkConversionResult>({
    request: () => fetchWithAuth(`${BASE}/bulk`, postInit(body)),
    errorFallback: i18n.t('flows:conversion.errors.bulkFailed'),
    successMessage: (r) => i18n.t('flows:conversion.toast.bulkCreated', { count: r?.created ?? 0 }),
    friendly,
  });
}

export interface SwitchConversionResult {
  conversion: FlowConversionDto;
  flow: FlowDetailDto;
  publication: { id: string; publicationSeq: number; definitionVersion: number };
  webhookSecretInvalidated: boolean;
  generatedScripts: Array<{ stepId: string; scriptId: string; name: string }>;
}

/**
 * Switch a shadow conversion. Every 4xx except a 401 is rendered inline by the
 * switch dialog (gate refusals, 422 validation/enable refusals), so none is
 * toasted here. Read the refusal from the thrown `ActionError.body`.
 */
export function switchConversion(id: string, body: ConversionSwitchRequest): Promise<SwitchConversionResult> {
  return runAction<SwitchConversionResult>({
    request: () => fetchWithAuth(`${BASE}/${encodeURIComponent(id)}/switch`, postInit(body)),
    errorFallback: i18n.t('flows:conversion.errors.switchFailed'),
    successMessage: i18n.t('flows:conversion.toast.switched'),
    suppressErrorToast: (status) => status >= 400 && status < 500,
    friendly,
  });
}

/** Revert a switched conversion: the Job runs again and the flow admits nothing new. */
export function revertConversion(id: string): Promise<{ conversion: FlowConversionDto }> {
  return runAction<{ conversion: FlowConversionDto }>({
    request: () => fetchWithAuth(`${BASE}/${encodeURIComponent(id)}/revert`, postInit()),
    errorFallback: i18n.t('flows:conversion.errors.revertFailed'),
    successMessage: i18n.t('flows:conversion.toast.reverted'),
    friendly,
  });
}
