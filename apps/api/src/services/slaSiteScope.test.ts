import { describe, it, expect } from 'vitest';
import { slaDefinitionOutOfScope, slaScopeNarrowed, type SlaScopeAuth, type SlaTargetShape } from './slaSiteScope';

const SITE_A = 'site-a';
const SITE_B = 'site-b';
const DEV_1 = 'dev-1';
const DEV_2 = 'dev-2';

/** A site-restricted human: `allowedSiteIds` set, no exact-device axis. */
function siteAuth(allowedSiteIds: string[]): SlaScopeAuth {
  return {
    allowedSiteIds,
    canAccessSite: (siteId) => typeof siteId === 'string' && allowedSiteIds.includes(siteId),
  };
}

/** A device-bound agent run: `allowedDeviceIds` set, no site axis at all. */
function deviceAuth(allowedDeviceIds: string[]): SlaScopeAuth {
  return { allowedDeviceIds, canAccessSite: () => true };
}

/** Unrestricted on both axes. */
const unrestricted: SlaScopeAuth = { canAccessSite: () => true };

function def(targetType: string | null, targetIds: string[] | null): SlaTargetShape {
  return { targetType, targetIds };
}

describe('slaScopeNarrowed', () => {
  const cases: Array<[string, SlaScopeAuth, boolean]> = [
    ['unrestricted caller', unrestricted, false],
    ['site-restricted caller', siteAuth([SITE_A]), true],
    ['site-restricted caller with an EMPTY allowlist', siteAuth([]), true],
    ['device-bound run', deviceAuth([DEV_1]), true],
    ['device-bound run with an EMPTY allowlist', deviceAuth([]), true],
  ];
  it.each(cases)('%s -> %s', (_name, auth, expected) => {
    expect(slaScopeNarrowed(auth)).toBe(expected);
  });
});

describe('slaDefinitionOutOfScope', () => {
  // [name, auth, definition, resolved device allowlist, out-of-scope?]
  const cases: Array<[string, SlaScopeAuth, SlaTargetShape, string[] | null, boolean]> = [
    // Org-wide definitions carry nothing site-specific.
    ['org-wide definition stays visible to a site-restricted caller', siteAuth([SITE_A]), def(null, null), null, false],
    ['org-wide definition stays visible to a device-bound run', deviceAuth([DEV_1]), def('org', []), null, false],
    ['unrestricted caller sees a site definition', unrestricted, def('site', [SITE_B]), null, false],

    // Empty target list is unattributable -> fail closed.
    ['site definition with EMPTY targetIds fails closed', siteAuth([SITE_A]), def('site', []), null, true],
    ['site definition with NULL targetIds fails closed', siteAuth([SITE_A]), def('site', null), null, true],
    ['device definition with EMPTY targetIds fails closed', siteAuth([SITE_A]), def('device', []), [DEV_1], true],

    // Site targets need EVERY target reachable — a mutation of `every` to
    // `some` must turn this red.
    ['site definition wholly inside the allowlist is visible', siteAuth([SITE_A, SITE_B]), def('site', [SITE_A, SITE_B]), null, false],
    ['site definition MIXING a reachable and an unreachable site is denied', siteAuth([SITE_A]), def('site', [SITE_A, SITE_B]), null, true],
    ['site definition wholly outside the allowlist is denied', siteAuth([SITE_A]), def('site', [SITE_B]), null, true],
    ['site definition denied for an EMPTY site allowlist', siteAuth([]), def('site', [SITE_A]), null, true],

    // A device-bound run has no site axis to satisfy.
    ['site definition is denied to a device-bound run', deviceAuth([DEV_1]), def('site', [SITE_A]), [DEV_1], true],

    // Device targets, resolved through the caller's device allowlist.
    ['device definition wholly in the resolved set is visible', siteAuth([SITE_A]), def('device', [DEV_1]), [DEV_1, DEV_2], false],
    ['device definition MIXING a reachable and an unreachable device is denied', siteAuth([SITE_A]), def('device', [DEV_1, DEV_2]), [DEV_1], true],
    ['device definition outside the resolved set is denied', siteAuth([SITE_A]), def('device', [DEV_2]), [DEV_1], true],
    ['device definition denied when the resolved set is empty', siteAuth([SITE_A]), def('device', [DEV_1]), [], true],

    // The null-vs-[] collapse: a NARROWED caller whose device set could not be
    // resolved (no orgId on the auth context) must be denied, never waved
    // through. `null` used to read as "unrestricted" here.
    ['device definition denied for a narrowed caller with an UNRESOLVED device set', siteAuth([SITE_A]), def('device', [DEV_1]), null, true],
    ['device definition denied for a device-bound run with an UNRESOLVED device set', deviceAuth([DEV_1]), def('device', [DEV_1]), null, true],

    // Unknown target types are not site-attributable.
    ['unknown target type stays visible', siteAuth([SITE_A]), def('group', ['g-1']), null, false],
    ['target type matching is case-insensitive', siteAuth([SITE_A]), def('SITE', [SITE_B]), null, true],
  ];

  it.each(cases)('%s', (_name, auth, definition, allowedDeviceIds, expected) => {
    expect(slaDefinitionOutOfScope(auth, definition, allowedDeviceIds)).toBe(expected);
  });
});
