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
