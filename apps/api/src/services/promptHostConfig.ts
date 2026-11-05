/**
 * The prompt host kill switch (#10190; spec §3.1 rule 2, plan P4).
 *
 * Every main-agent heartbeat response carries `promptHost.enabledKinds`. The
 * agent intersects it with what the chosen renderer advertised at its live
 * authentication and with the kinds its own build speaks; a kind missing from
 * any of the three goes the legacy way (`notify`, `consent_request` v2, ...).
 * This list is server configuration, never a capability claim: it is how a
 * kind is turned on per region, and off again with an env change and a
 * restart, without an agent release.
 *
 * `PROMPT_HOST_ENABLED_KINDS`:
 *   - unset, or `default` (any case) -> DEFAULT_ENABLED_PROMPT_KINDS. The
 *     `default` token exists because compose cannot pass "unset" through an
 *     `environment:` key; the compose files map `${PROMPT_HOST_ENABLED_KINDS-default}`
 *     so an operator who sets nothing still gets the code default when W09
 *     flips it, while an explicit empty value stays the kill switch.
 *   - empty or whitespace -> nothing (the kill switch).
 *   - otherwise a comma list of a bare `kind` (all versions) or `kind@n`
 *     (one version). Entries outside PROMPT_KINDS, or a malformed `kind@n`,
 *     are dropped with one warning per distinct value; a value in which
 *     nothing survives is logged as an error, because it silently acts as
 *     the kill switch.
 */
import { PROMPT_KIND_NAMES, isPromptKind, parsePromptKindAd } from '@breeze/shared/promptHost';

export const PROMPT_HOST_ENABLED_KINDS_ENV = 'PROMPT_HOST_ENABLED_KINDS';

/**
 * Empty until W09 flips it to the kinds that have run enabled in both hosted
 * regions for at least one release. Until then a self-hoster keeps today's
 * dialogs unless they opt in.
 */
export const DEFAULT_ENABLED_PROMPT_KINDS: readonly string[] = Object.freeze([]);

const DEFAULT_TOKEN = 'default';

/** The canonical entry for one list item, or null when it must be dropped. */
function canonicalEntry(entry: string): string | null {
  if (!entry.includes('@')) return isPromptKind(entry) ? entry : null;
  const ad = parsePromptKindAd(entry);
  return ad && isPromptKind(ad.name) ? `${ad.name}@${ad.version}` : null;
}

export function parseEnabledPromptKinds(
  raw: string | undefined,
  defaults: readonly string[] = DEFAULT_ENABLED_PROMPT_KINDS,
): string[] {
  if (raw === undefined || raw.trim().toLowerCase() === DEFAULT_TOKEN) return [...defaults];
  if (raw.trim() === '') return [];
  const enabled = new Set<string>();
  const dropped: string[] = [];
  for (const segment of raw.split(',')) {
    const entry = segment.trim();
    if (!entry) continue;
    const canonical = canonicalEntry(entry);
    if (canonical) enabled.add(canonical);
    else dropped.push(entry);
  }
  const hint = `Use a kind (${PROMPT_KIND_NAMES.join(', ')}) or kind@n with n >= 1.`;
  if (enabled.size === 0) {
    // A non-empty value that enables nothing is almost always a typo, and it
    // acts exactly like the kill switch. Loud, so nobody mistakes it for an
    // intended "off" (the intended off is an empty value).
    console.error(
      `[promptHost] no valid entries in ${PROMPT_HOST_ENABLED_KINDS_ENV} — behaving as the kill switch `
        + `(every prompt uses the legacy dialog). Ignored: ${dropped.join(', ') || '(only separators)'}. ${hint}`,
    );
  } else if (dropped.length) {
    console.warn(
      `[promptHost] ${PROMPT_HOST_ENABLED_KINDS_ENV}: ignoring ${dropped.length} unknown or malformed `
        + `entr${dropped.length === 1 ? 'y' : 'ies'}: ${dropped.join(', ')}. ${hint} These kinds stay on the legacy path.`,
    );
  }
  return [...enabled];
}

let cache: { raw: string | undefined; kinds: readonly string[] } | null = null;

/**
 * The enabled kinds for this process, read from the env. Parsed once per
 * distinct value, so a bad entry warns once rather than on every heartbeat.
 */
export function enabledPromptKinds(): readonly string[] {
  const raw = process.env.PROMPT_HOST_ENABLED_KINDS;
  if (!cache || cache.raw !== raw) {
    cache = { raw, kinds: Object.freeze(parseEnabledPromptKinds(raw)) };
  }
  return cache.kinds;
}

/** Test-only: forget the parsed value. */
export function __resetEnabledPromptKindsCacheForTests(): void {
  cache = null;
}
