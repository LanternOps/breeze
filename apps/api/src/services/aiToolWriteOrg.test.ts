import { describe, expect, it } from 'vitest';
import { resolveWritableToolOrgId, WRITE_ORG_AMBIGUOUS_ERROR } from './aiToolWriteOrg';
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
