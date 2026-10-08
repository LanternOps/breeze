import type { TFunction } from 'i18next';
import type { AiSurface, OfferingEnableBlocker } from '@breeze/shared';

// Literal key maps: the i18n keyUsage test cannot check template keys.

export const SURFACE_LABEL_KEYS: Record<AiSurface, string> = {
  chat: 'aiModels.surfaces.chat',
  helper: 'aiModels.surfaces.helper',
  script_builder: 'aiModels.surfaces.script_builder',
  script_reviewer: 'aiModels.surfaces.script_reviewer',
  office_chat: 'aiModels.surfaces.office_chat',
  office_ticket: 'aiModels.surfaces.office_ticket',
  ai_agents: 'aiModels.surfaces.ai_agents',
  catalog_enrichment: 'aiModels.surfaces.catalog_enrichment',
  extension_content: 'aiModels.surfaces.extension_content',
  patch_test: 'aiModels.surfaces.patch_test',
};

export const ROLE_LABEL_KEYS = {
  triage: 'aiModels.roles.triage',
  analysis: 'aiModels.roles.analysis',
  remediation: 'aiModels.roles.remediation',
} as const;

export const ENABLE_BLOCKER_KEYS: Record<OfferingEnableBlocker, string> = {
  model_unavailable: 'aiModels.blockers.model_unavailable',
  unpriced: 'aiModels.blockers.unpriced',
  plan_required: 'aiModels.blockers.plan_required',
  connection_unavailable: 'aiModels.blockers.connection_unavailable',
  residency_unavailable: 'aiModels.blockers.residency_unavailable',
};

/** RegistryWriteCode (plus the route-level codes) → i18n key. */
export const REGISTRY_ERROR_KEYS: Record<string, string> = {
  not_found: 'aiModels.errors.not_found',
  unpriced: 'aiModels.errors.unpriced',
  not_eligible: 'aiModels.errors.not_eligible',
  offering_in_use: 'aiModels.errors.offering_in_use',
  stale_write: 'aiModels.errors.stale_write',
  conflict: 'aiModels.errors.conflict',
  invalid: 'aiModels.errors.invalid',
  tools_unsupported: 'aiModels.errors.tools_unsupported',
  widens_partner: 'aiModels.errors.widens_partner',
  crosses_funding: 'aiModels.errors.crossesFunding',
  write_failed: 'aiModels.errors.write_failed',
  registry_unavailable: 'aiModels.errors.registry_unavailable',
  registry_busy: 'aiModels.errors.registry_busy',
  queue_unavailable: 'aiModels.errors.queue_unavailable',
  APPROVALS_DECIDE_REQUIRED: 'aiModels.errors.approvals_decide_required',
  egress_blocked: 'aiModels.errors.egress_blocked',
  invalid_url: 'aiModels.errors.invalid_url',
  endpoint_unreachable: 'aiModels.errors.endpoint_unreachable',
  managed_by_env: 'aiModels.errors.managed_by_env',
  connection_in_use: 'aiModels.errors.connection_in_use',
  duplicate_model: 'aiModels.errors.duplicate_model',
  geo_not_supported: 'aiModels.errors.geo_not_supported',
  key_required_for_new_endpoint: 'aiModels.errors.key_required_for_new_endpoint',
  too_many_models: 'aiModels.errors.too_many_models',
};

/**
 * Label for a stored offering id that is no longer usable (disabled, ineligible
 * or gone). The defaults cards keep such ids visible so an admin can untick them.
 */
export function unavailableModelLabel(t: TFunction, name: string | null | undefined): string {
  return name ? t('settings:aiModels.defaults.unavailableModel', { model: name }) : t('settings:aiModels.defaults.unavailableUnknown');
}

/** Ids stored on the row (or still in the draft) that the available list no longer offers. */
export function unavailableIds(stored: readonly string[], draft: readonly string[], available: ReadonlySet<string>): string[] {
  return [...new Set([...stored, ...draft])].filter((id) => !available.has(id));
}

export const DEFAULT_SOURCE_KEYS = {
  org: 'aiModels.org.source.org',
  partner: 'aiModels.org.source.partner',
  none: 'aiModels.org.source.none',
} as const;

/**
 * Codes whose server message names the specific cause (which key was refused,
 * which feature blocks the change). The `friendly` hook leaves those alone so
 * the toast keeps the specifics.
 */
const SERVER_MESSAGE_CODES = new Set(['invalid', 'conflict', 'not_eligible', 'unpriced', 'tools_unsupported', 'widens_partner', 'offering_in_use', 'egress_blocked', 'invalid_url']);

/** `friendly` hook for runAction: localises the codes that carry no specifics. */
export function registryFriendly(t: TFunction) {
  return (code: string): string | undefined => {
    if (SERVER_MESSAGE_CODES.has(code)) return undefined;
    const key = REGISTRY_ERROR_KEYS[code];
    return key ? t(/* i18n-dynamic */ key) : undefined;
  };
}

/**
 * Codes the gateway create / endpoint PATCH use to refuse the Base URL itself
 * (`endpoint_unreachable` carries `details.field: 'baseUrl'`; the egress-policy
 * codes are always about the URL). The drawer shows these on the field (#7803).
 */
const BASE_URL_REFUSAL_CODES = new Set(['endpoint_unreachable', 'egress_blocked', 'invalid_url']);

export function isBaseUrlRefusal(status: number, code: string | undefined): boolean {
  return status === 400 && code !== undefined && BASE_URL_REFUSAL_CODES.has(code);
}
