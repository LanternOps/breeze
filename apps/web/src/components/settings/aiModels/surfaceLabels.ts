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
  write_failed: 'aiModels.errors.write_failed',
  registry_unavailable: 'aiModels.errors.registry_unavailable',
  registry_busy: 'aiModels.errors.registry_busy',
  queue_unavailable: 'aiModels.errors.queue_unavailable',
  APPROVALS_DECIDE_REQUIRED: 'aiModels.errors.approvals_decide_required',
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
const SERVER_MESSAGE_CODES = new Set(['invalid', 'conflict', 'not_eligible', 'unpriced', 'tools_unsupported', 'widens_partner', 'offering_in_use']);

/** `friendly` hook for runAction: localises the codes that carry no specifics. */
export function registryFriendly(t: TFunction) {
  return (code: string): string | undefined => {
    if (SERVER_MESSAGE_CODES.has(code)) return undefined;
    const key = REGISTRY_ERROR_KEYS[code];
    return key ? t(/* i18n-dynamic */ key) : undefined;
  };
}
