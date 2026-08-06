/**
 * Client-side evaluation of a device group's LEGACY `rules` array.
 *
 * Groups authored today store a rich `filterConditions` tree that only the
 * server can evaluate (it reaches hardware, metrics and software tables), so
 * this matcher exists purely to keep pre-filter groups showing a plausible
 * member count until the server has computed one. Two rules follow from that:
 *
 * 1. It runs against whatever `/devices` returned, NOT against a type this
 *    page controls. The list endpoint returns `osType`; it has never returned
 *    `os`. Reading `device.os.toLowerCase()` threw for every device, the throw
 *    escaped render, and the whole Astro island unmounted — a permanently
 *    blank /devices/groups page until the offending group row was deleted.
 * 2. Every field it touches — on the device AND on the rule — is treated as
 *    possibly absent. A malformed group row is a rendering nuisance, never a
 *    page-level crash.
 */

export type LegacyRuleField = 'os' | 'site' | 'tag' | 'hostname';

export type LegacyRuleOperator =
  | 'is'
  | 'is_not'
  | 'contains'
  | 'not_contains'
  | 'matches'
  | 'not_matches';

export interface DeviceGroupRule {
  id: string;
  field: LegacyRuleField;
  operator: LegacyRuleOperator;
  value: string;
}

/**
 * The subset of a device the matcher reads, in the shape `/devices` actually
 * returns. Everything but `id` is optional on purpose — the API omits fields
 * (`siteName` is never in the list payload at all) and older rows carry nulls.
 */
export interface MatchableDevice {
  id: string;
  hostname?: string | null;
  /** Canonical OS field from the API. */
  osType?: string | null;
  /** Only ever existed in this page's hand-written type; tolerated on read. */
  os?: string | null;
  siteId?: string | null;
  siteName?: string | null;
  tags?: unknown;
}

/** Reads the OS the devices API reports, tolerating the historical `os` key. */
export function deviceOsType(device: MatchableDevice | null | undefined): string {
  if (!device) return '';
  return String(device.osType ?? device.os ?? '');
}

const normalize = (value: unknown): string => String(value ?? '').trim().toLowerCase();

/**
 * True when `device` satisfies `rule`. Never throws: an unknown field, a rule
 * with no value, or a device missing the field all resolve to a boolean.
 */
export function matchesRule(
  device: MatchableDevice | null | undefined,
  rule: Partial<DeviceGroupRule> | null | undefined,
): boolean {
  if (!device || !rule) return false;

  const normalizedValue = normalize(rule.value);
  if (!normalizedValue) return false;

  if (rule.field === 'os') {
    const match = normalize(deviceOsType(device)) === normalizedValue;
    return rule.operator === 'is' ? match : !match;
  }

  if (rule.field === 'site') {
    const siteIdMatch = device.siteId != null && normalize(device.siteId) === normalizedValue;
    const siteNameMatch = device.siteName != null && normalize(device.siteName) === normalizedValue;
    const match = siteIdMatch || siteNameMatch;
    return rule.operator === 'is' ? match : !match;
  }

  if (rule.field === 'tag') {
    const hasTag = Array.isArray(device.tags)
      ? device.tags.some((tag) => normalize(tag) === normalizedValue)
      : false;
    return rule.operator === 'contains' ? hasTag : !hasTag;
  }

  // Default branch: hostname, and anything the group row names that this
  // matcher doesn't know about (which is most of the filter vocabulary).
  const rawHostname = String(device.hostname ?? '');
  const hostname = rawHostname.toLowerCase();

  if (rule.operator === 'contains' || rule.operator === 'not_contains') {
    const match = hostname.includes(normalizedValue);
    return rule.operator === 'contains' ? match : !match;
  }

  const regexMatch = (() => {
    try {
      return new RegExp(String(rule.value ?? ''), 'i').test(rawHostname);
    } catch {
      return hostname.includes(normalizedValue);
    }
  })();
  return rule.operator === 'matches' ? regexMatch : !regexMatch;
}

/** Ids of the devices satisfying every rule. Empty when there are no rules. */
export function matchDeviceIds(
  devices: readonly MatchableDevice[] | null | undefined,
  rules: ReadonlyArray<Partial<DeviceGroupRule> | null | undefined> | null | undefined,
): string[] {
  const activeRules = Array.isArray(rules) ? rules.filter(Boolean) : [];
  if (activeRules.length === 0) return [];
  return (devices ?? [])
    .filter((device) => activeRules.every((rule) => matchesRule(device, rule)))
    .map((device) => device.id);
}
