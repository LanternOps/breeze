/**
 * Tools whose effect digest is MANDATORY (topology M4-D3, #6000): an unresolved
 * digest refuses intent creation, and a release that finds no pinned digest
 * fails closed instead of inheriting the legacy "NULL means nothing to check"
 * fallback. A light leaf so intentService.ts (whose suites mock effectDigest.ts
 * wholesale) and both release paths share one list; re-exported by
 * effectDigest.ts next to the resolver map.
 */
export const DIAGNOSE_CONNECTIVITY_TOOL_NAME = 'diagnose_connectivity';

const PINNED_EFFECT_DIGEST_REQUIRED: ReadonlySet<string> = new Set([
  DIAGNOSE_CONNECTIVITY_TOOL_NAME,
  // operator_plan: the approval's whole authority is the pinned effect rows.
  'operator_plan',
  // #6268: both Tier-3 actions (sweep, import_iocs) have resolvers; its Tier-1
  // and Tier-2 actions never create an intent.
  'ioc_hunt',
  // Tool Catalog W06 (#5221, Decision 5): a fleet script approval's whole authority is the
  // pinned script + frozen device list (fleetEffectDigest.ts).
  'run_script_on_targets',
]);

/**
 * Per-ACTION mandatory pins (full-control W14 PR B, #6784; PR B quorum QB7): the money surfaces of multiplexer
 * tools whose other actions are ordinary, so the whole tool cannot be listed above. An approval for one of these
 * whose preview / payload could not be resolved is refused at creation, and a release that finds no digest fails.
 */
const PINNED_EFFECT_DIGEST_REQUIRED_ACTIONS: ReadonlySet<string> = new Set([
  'manage_contracts:generate_invoice',
  'manage_accounting_sync:push',
  'manage_accounting_sync:push_bulk',
]);

export function requiresPinnedEffectDigest(toolName: string, args?: Record<string, unknown> | null): boolean {
  if (PINNED_EFFECT_DIGEST_REQUIRED.has(toolName)) return true;
  const action = args && typeof args.action === 'string' ? args.action : undefined;
  return action !== undefined && PINNED_EFFECT_DIGEST_REQUIRED_ACTIONS.has(`${toolName}:${action}`);
}
