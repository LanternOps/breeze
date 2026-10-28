import { describe, expect, it } from 'vitest';
import {
  READ_ORG_UNBOUNDED_ERROR,
  resolveReadableToolOrgScope,
  resolveWritableToolOrgId,
  WRITE_ORG_AMBIGUOUS_ERROR,
} from './aiToolWriteOrg';
import { resolveWritableToolOrgId as hubExport } from './aiTools';

const ORG_A = '11111111-1111-1111-1111-111111111111';
const ORG_B = '22222222-2222-2222-2222-222222222222';

function auth(overrides: Record<string, unknown>) {
  const accessible = (overrides.accessibleOrgIds ?? []) as string[] | null;
  return {
    scope: 'partner',
    orgId: null,
    accessibleOrgIds: accessible,
    canAccessOrg: (id: string) => accessible === null || accessible.includes(id),
    ...overrides,
  } as any;
}

describe('resolveWritableToolOrgId (#6667)', () => {
  it('is the same function object through the aiTools hub re-export', () => {
    expect(hubExport).toBe(resolveWritableToolOrgId);
  });

  it('org-scoped token resolves to auth.orgId and refuses any other org', () => {
    const org = auth({ scope: 'organization', orgId: ORG_A, accessibleOrgIds: [ORG_A] });
    expect(resolveWritableToolOrgId(org)).toEqual({ orgId: ORG_A });
    expect(resolveWritableToolOrgId(org, ORG_A)).toEqual({ orgId: ORG_A });
    expect(resolveWritableToolOrgId(org, ORG_B)).toEqual({ error: 'Cannot access another organization' });
  });

  it('org-scoped token without an orgId is refused', () => {
    expect(resolveWritableToolOrgId(auth({ scope: 'organization', orgId: null }))).toEqual({
      error: 'Organization context required',
    });
  });

  it('partner caller: explicit accessible org wins, inaccessible org is refused', () => {
    const partner = auth({ accessibleOrgIds: [ORG_A] });
    expect(resolveWritableToolOrgId(partner, ORG_A)).toEqual({ orgId: ORG_A });
    expect(resolveWritableToolOrgId(partner, ORG_B)).toEqual({ error: 'Access denied to this organization' });
  });

  it('partner caller with exactly one org gets that org', () => {
    expect(resolveWritableToolOrgId(auth({ accessibleOrgIds: [ORG_A] }))).toEqual({ orgId: ORG_A });
  });

  it('never picks accessibleOrgIds[0] for a multi-org caller', () => {
    expect(resolveWritableToolOrgId(auth({ accessibleOrgIds: [ORG_A, ORG_B] }))).toEqual({
      error: WRITE_ORG_AMBIGUOUS_ERROR,
    });
  });

  it('refuses an unrestricted (null) caller with no orgId', () => {
    expect(resolveWritableToolOrgId(auth({ scope: 'system', accessibleOrgIds: null }))).toEqual({
      error: WRITE_ORG_AMBIGUOUS_ERROR,
    });
  });

  it('refuses a caller with no accessible org', () => {
    expect(resolveWritableToolOrgId(auth({ accessibleOrgIds: [] }))).toEqual({
      error: 'orgId is required for this operation',
    });
  });
});

describe('resolveWritableToolOrgId: device-page write default (#6675)', () => {
  const ORG_C = '33333333-3333-3333-3333-333333333333';

  it('a multi-org caller with no orgId writes to the device-page anchor org', () => {
    const partner = auth({ accessibleOrgIds: [ORG_A, ORG_B], aiWriteDefaultOrgId: ORG_B });
    expect(resolveWritableToolOrgId(partner)).toEqual({ orgId: ORG_B });
  });

  it('an explicit accessible orgId wins over the anchor', () => {
    const partner = auth({ accessibleOrgIds: [ORG_A, ORG_B], aiWriteDefaultOrgId: ORG_B });
    expect(resolveWritableToolOrgId(partner, ORG_A)).toEqual({ orgId: ORG_A });
  });

  it('an explicit inaccessible orgId is refused even with an anchor', () => {
    const partner = auth({ accessibleOrgIds: [ORG_A, ORG_B], aiWriteDefaultOrgId: ORG_B });
    expect(resolveWritableToolOrgId(partner, ORG_C)).toEqual({ error: 'Access denied to this organization' });
  });

  it('ignores an anchor the caller can no longer access (re-checked at call time)', () => {
    const partner = auth({ accessibleOrgIds: [ORG_A, ORG_B], aiWriteDefaultOrgId: ORG_C });
    expect(resolveWritableToolOrgId(partner)).toEqual({ error: WRITE_ORG_AMBIGUOUS_ERROR });
  });

  it('outranks a partner token home org, as the session anchor does (#5684)', () => {
    const partner = auth({ orgId: ORG_A, accessibleOrgIds: [ORG_A, ORG_B], aiWriteDefaultOrgId: ORG_B });
    expect(resolveWritableToolOrgId(partner)).toEqual({ orgId: ORG_B });
  });

  it('never moves an org-scoped token off its own org', () => {
    const org = auth({ scope: 'organization', orgId: ORG_A, accessibleOrgIds: [ORG_A], aiWriteDefaultOrgId: ORG_B });
    expect(resolveWritableToolOrgId(org)).toEqual({ orgId: ORG_A });
  });

  it('a read that opts out keeps the pre-#6675 resolution', () => {
    const partner = auth({ accessibleOrgIds: [ORG_A, ORG_B], aiWriteDefaultOrgId: ORG_B });
    expect(resolveWritableToolOrgId(partner, undefined, { useWriteDefault: false })).toEqual({
      error: WRITE_ORG_AMBIGUOUS_ERROR,
    });
  });

  it('without an anchor a multi-org caller is still refused (non-page chat, #6667)', () => {
    expect(resolveWritableToolOrgId(auth({ accessibleOrgIds: [ORG_A, ORG_B] }))).toEqual({
      error: WRITE_ORG_AMBIGUOUS_ERROR,
    });
  });
});

describe('resolveReadableToolOrgScope (#10396)', () => {
  const ORG_C = '33333333-3333-3333-3333-333333333333';

  it('a multi-org partner caller with no orgId reads every org it reaches, never accessibleOrgIds[0]', () => {
    const partner = auth({ accessibleOrgIds: [ORG_A, ORG_B, ORG_C] });
    expect(resolveReadableToolOrgScope(partner)).toEqual({
      ok: true,
      orgIds: [ORG_A, ORG_B, ORG_C],
      allAccessibleOrgs: true,
    });
  });

  it('returns a copy, so a caller cannot mutate the auth reach through it', () => {
    const reach = [ORG_A, ORG_B];
    const scope = resolveReadableToolOrgScope(auth({ accessibleOrgIds: reach }));
    expect(scope.ok).toBe(true);
    if (scope.ok) expect(scope.orgIds).not.toBe(reach);
  });

  it('an explicit accessible orgId narrows to that org; an inaccessible one is refused', () => {
    const partner = auth({ accessibleOrgIds: [ORG_A, ORG_B] });
    expect(resolveReadableToolOrgScope(partner, ORG_B)).toEqual({ ok: true, orgIds: [ORG_B], allAccessibleOrgs: false });
    expect(resolveReadableToolOrgScope(partner, ORG_C)).toEqual({ ok: false, error: 'Access denied to this organization' });
  });

  it('org-scoped token reads its own org and refuses any other', () => {
    const org = auth({ scope: 'organization', orgId: ORG_A, accessibleOrgIds: [ORG_A] });
    expect(resolveReadableToolOrgScope(org)).toEqual({ ok: true, orgIds: [ORG_A], allAccessibleOrgs: false });
    expect(resolveReadableToolOrgScope(org, ORG_B)).toEqual({ ok: false, error: 'Cannot access another organization' });
  });

  it('a non-org token that carries auth.orgId reads that org', () => {
    const partner = auth({ orgId: ORG_B, accessibleOrgIds: [ORG_A, ORG_B] });
    expect(resolveReadableToolOrgScope(partner)).toEqual({ ok: true, orgIds: [ORG_B], allAccessibleOrgs: false });
  });

  // Wisp's narrowAuthToCeiling / unreachableWispAuth spread `...auth`: they cut
  // `accessibleOrgIds` and rebuild the closures but keep the login's `orgId`.
  it('fails closed on a carried auth.orgId outside the (ceiling-narrowed) reach', () => {
    const narrowed = auth({ orgId: ORG_C, accessibleOrgIds: [ORG_A, ORG_B] });
    expect(resolveReadableToolOrgScope(narrowed)).toEqual({ ok: false, error: 'Access denied to this organization' });
  });

  it('fails closed for an org-scoped auth whose own org was cut from the reach', () => {
    const cut = auth({ scope: 'organization', orgId: ORG_A, accessibleOrgIds: [] });
    expect(resolveReadableToolOrgScope(cut)).toEqual({ ok: false, error: 'Access denied to this organization' });
    expect(resolveReadableToolOrgScope(cut, ORG_A)).toEqual({ ok: false, error: 'Access denied to this organization' });
  });

  it('a single-org reach is not reported as all-accessible', () => {
    expect(resolveReadableToolOrgScope(auth({ accessibleOrgIds: [ORG_A] }))).toEqual({
      ok: true,
      orgIds: [ORG_A],
      allAccessibleOrgs: false,
    });
  });

  it('ignores the device-page write default: a read is never narrowed by it', () => {
    const partner = auth({ accessibleOrgIds: [ORG_A, ORG_B], aiWriteDefaultOrgId: ORG_B });
    expect(resolveReadableToolOrgScope(partner)).toEqual({ ok: true, orgIds: [ORG_A, ORG_B], allAccessibleOrgs: true });
  });

  it('fails closed for an unrestricted (system) caller with no orgId instead of reading every tenant', () => {
    // `auth()` reads a null reach as [] for canAccessOrg; system scope reaches every org.
    const system = auth({ scope: 'system', accessibleOrgIds: null, canAccessOrg: () => true });
    expect(resolveReadableToolOrgScope(system)).toEqual({ ok: false, error: READ_ORG_UNBOUNDED_ERROR });
    expect(resolveReadableToolOrgScope(system, ORG_A)).toEqual({ ok: true, orgIds: [ORG_A], allAccessibleOrgs: false });
  });

  it('refuses a caller with no accessible org', () => {
    expect(resolveReadableToolOrgScope(auth({ accessibleOrgIds: [] }))).toEqual({
      ok: false,
      error: 'No organization context available',
    });
  });
});
