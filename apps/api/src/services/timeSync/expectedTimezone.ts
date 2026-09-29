import {
  ianaToWindowsZone,
  TIME_SYNC_UNSET_SITE_TIMEZONES,
} from '@breeze/shared';
export interface ExpectedTimezone {
  iana: string;
  windowsId: string;
  source: 'policy' | 'site';
  sourceId: string;
  sourceName: string | null;
}
export interface ExpectedTimezoneInput {
  site: { id: string; name: string | null; timezone: string | null } | null;
  policy?: {
    policyId: string;
    policyName: string | null;
    expected: 'site' | 'pinned';
    pinnedTimezone: string | null;
  } | null;
}
const warned = new Set<string>();
function mapped(iana: string): string | null {
  const windowsId = ianaToWindowsZone(iana);
  if (!windowsId && !warned.has(iana)) {
    warned.add(iana);
    console.warn('[time-sync] unmapped expected timezone', { iana });
  }
  return windowsId;
}
export function resolveExpectedTimezone(
  input: ExpectedTimezoneInput,
): ExpectedTimezone | null {
  const { policy, site } = input;
  if (policy?.expected === 'pinned' && policy.pinnedTimezone) {
    const windowsId = mapped(policy.pinnedTimezone);
    if (windowsId)
      return {
        iana: policy.pinnedTimezone,
        windowsId,
        source: 'policy',
        sourceId: policy.policyId,
        sourceName: policy.policyName,
      };
  }
  if (
    !site?.timezone ||
    (TIME_SYNC_UNSET_SITE_TIMEZONES as readonly string[]).includes(
      site.timezone,
    )
  )
    return null;
  const windowsId = mapped(site.timezone);
  return windowsId
    ? {
        iana: site.timezone,
        windowsId,
        source: 'site',
        sourceId: site.id,
        sourceName: site.name,
      }
    : null;
}
