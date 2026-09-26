/**
 * Tools whose effect digest is MANDATORY (topology M4-D3, #6000): an unresolved
 * digest refuses intent creation, and a release that finds no pinned digest
 * fails closed instead of inheriting the legacy "NULL means nothing to check"
 * fallback. A light leaf so intentService.ts (whose suites mock effectDigest.ts
 * wholesale) and both release paths share one list; re-exported by
 * effectDigest.ts next to the resolver map.
 */
export const DIAGNOSE_CONNECTIVITY_TOOL_NAME = 'diagnose_connectivity';

const PINNED_EFFECT_DIGEST_REQUIRED: ReadonlySet<string> = new Set([DIAGNOSE_CONNECTIVITY_TOOL_NAME]);

export function requiresPinnedEffectDigest(toolName: string): boolean {
  return PINNED_EFFECT_DIGEST_REQUIRED.has(toolName);
}
