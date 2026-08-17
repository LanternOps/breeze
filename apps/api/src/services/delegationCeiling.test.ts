import { describe, expect, it } from 'vitest';
import {
  DELEGATION_CEILING_DENIED_MESSAGE,
  checkDelegationCeiling,
  scopeCoversScope,
  siteAllowlistCovers,
} from './delegationCeiling';

const ORGS_WRITE = { resource: 'organizations', action: 'write' };
const SCRIPTS_EXECUTE = { resource: 'scripts', action: 'execute' };

/** Caller holds exactly the listed permissions and nothing else. */
function holder(...held: { resource: string; action: string }[]) {
  const keys = new Set(held.map((p) => `${p.resource}:${p.action}`));
  return (p: { resource: string; action: string }) => keys.has(`${p.resource}:${p.action}`);
}

describe('scopeCoversScope', () => {
  it('ranks organization < partner < system', () => {
    expect(scopeCoversScope('system', 'partner')).toBe(true);
    expect(scopeCoversScope('system', 'system')).toBe(true);
    expect(scopeCoversScope('partner', 'organization')).toBe(true);
    expect(scopeCoversScope('partner', 'partner')).toBe(true);
    expect(scopeCoversScope('organization', 'organization')).toBe(true);
  });

  it('denies upward delegation', () => {
    expect(scopeCoversScope('organization', 'partner')).toBe(false);
    expect(scopeCoversScope('organization', 'system')).toBe(false);
    expect(scopeCoversScope('partner', 'system')).toBe(false);
  });
});

describe('siteAllowlistCovers', () => {
  it('treats undefined/null as unrestricted on the caller side', () => {
    expect(siteAllowlistCovers(undefined, ['s-1'])).toBe(true);
    expect(siteAllowlistCovers(null, undefined)).toBe(true);
  });

  it('denies a site-restricted caller an unrestricted credential', () => {
    // The whole point: RLS does not defend the site axis, so an unrestricted
    // credential in the hands of a site-restricted tech is a real widening.
    expect(siteAllowlistCovers(['s-1'], undefined)).toBe(false);
    expect(siteAllowlistCovers(['s-1'], null)).toBe(false);
  });

  it('requires a subset when both sides are restricted', () => {
    expect(siteAllowlistCovers(['s-1', 's-2'], ['s-1'])).toBe(true);
    expect(siteAllowlistCovers(['s-1', 's-2'], ['s-1', 's-2'])).toBe(true);
    expect(siteAllowlistCovers(['s-1'], ['s-1', 's-2'])).toBe(false);
    expect(siteAllowlistCovers(['s-1'], ['s-9'])).toBe(false);
  });

  it('an empty caller allowlist is restricted-to-nothing, not unrestricted', () => {
    expect(siteAllowlistCovers([], ['s-1'])).toBe(false);
    expect(siteAllowlistCovers([], [])).toBe(true);
  });
});

describe('checkDelegationCeiling', () => {
  it('allows a caller whose authority is a superset on every axis', () => {
    const result = checkDelegationCeiling({
      caller: { scope: 'partner', allowedSiteIds: undefined },
      credential: { scope: 'organization', permissions: [ORGS_WRITE], allowedSiteIds: ['s-1'] },
      holdsPermission: holder(ORGS_WRITE),
    });
    expect(result).toEqual({ ok: true });
  });

  it('denies on the SCOPE axis — an org caller may not wield a partner credential', () => {
    const result = checkDelegationCeiling({
      caller: { scope: 'organization' },
      credential: { scope: 'partner', permissions: [], allowedSiteIds: undefined },
      holdsPermission: holder(),
    });
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error('unreachable');
    expect(result.violation).toBe('scope');
    expect(result.error).toBe(DELEGATION_CEILING_DENIED_MESSAGE);
  });

  it('denies on the PERMISSION axis — the exact §1.4 escalation', () => {
    // Caller holds organizations:write (enough to reach the rotate route) but
    // not scripts:execute, which the credential confers.
    const result = checkDelegationCeiling({
      caller: { scope: 'organization' },
      credential: {
        scope: 'organization',
        permissions: [ORGS_WRITE, SCRIPTS_EXECUTE],
        allowedSiteIds: undefined,
      },
      holdsPermission: holder(ORGS_WRITE),
    });
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error('unreachable');
    expect(result.violation).toBe('permission');
    expect(result.details).toMatchObject({ missingPermission: 'scripts:execute' });
  });

  it('denies on the SITE axis even when scope and permissions are fine', () => {
    const result = checkDelegationCeiling({
      caller: { scope: 'organization', allowedSiteIds: ['s-1'] },
      credential: { scope: 'organization', permissions: [ORGS_WRITE], allowedSiteIds: undefined },
      holdsPermission: holder(ORGS_WRITE),
    });
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error('unreachable');
    expect(result.violation).toBe('site');
  });

  it('reports the SCOPE violation first when several axes fail', () => {
    const result = checkDelegationCeiling({
      caller: { scope: 'organization', allowedSiteIds: ['s-1'] },
      credential: { scope: 'system', permissions: [SCRIPTS_EXECUTE], allowedSiteIds: undefined },
      holdsPermission: holder(),
    });
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error('unreachable');
    expect(result.violation).toBe('scope');
  });

  it('a credential with no permissions still has to clear scope and site', () => {
    // Guards against the check collapsing to "permissions only".
    expect(
      checkDelegationCeiling({
        caller: { scope: 'organization', allowedSiteIds: ['s-1'] },
        credential: { scope: 'organization', allowedSiteIds: undefined },
        holdsPermission: holder(),
      }).ok
    ).toBe(false);
  });

  it('actually consults holdsPermission (non-vacuous)', () => {
    const seen: string[] = [];
    const result = checkDelegationCeiling({
      caller: { scope: 'system' },
      credential: { scope: 'system', permissions: [ORGS_WRITE, SCRIPTS_EXECUTE] },
      holdsPermission: (p) => {
        seen.push(`${p.resource}:${p.action}`);
        return true;
      },
    });
    expect(result).toEqual({ ok: true });
    expect(seen).toEqual(['organizations:write', 'scripts:execute']);
  });
});
