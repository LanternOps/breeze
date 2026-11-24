import { describe, expect, it } from 'vitest';
import type { JwtClaimsState } from '@/lib/authScope';
import { parsePolicyAccess, resolveViewerAccess } from './viewerAccess';

const org: JwtClaimsState = { status: 'resolved', claims: { scope: 'organization', orgId: 'org-1', partnerId: null } };
const partner: JwtClaimsState = { status: 'resolved', claims: { scope: 'partner', orgId: null, partnerId: 'p-1' } };
const pending: JwtClaimsState = { status: 'unresolved' };
const writer = [{ resource: 'devices', action: 'write' }];
const reader = [{ resource: 'devices', action: 'read' }];

const base = { access: null, policyOrgId: 'org-1', claims: org, permissions: writer, canManagePartnerWide: undefined };

describe('parsePolicyAccess (#12469)', () => {
  it('reads the W03a access object and rejects anything else', () => {
    expect(parsePolicyAccess({ canEdit: false, reason: 'site_restricted' })).toEqual({ canEdit: false, reason: 'site_restricted' });
    expect(parsePolicyAccess({ canEdit: true, reason: null })).toEqual({ canEdit: true, reason: null });
    expect(parsePolicyAccess(undefined)).toBeNull();
    expect(parsePolicyAccess({ canEdit: 'no' })).toBeNull();
    expect(parsePolicyAccess('x')).toBeNull();
  });
});

describe('resolveViewerAccess (#12469)', () => {
  it('an org user on their own policy with devices.write can edit', () => {
    expect(resolveViewerAccess(base)).toEqual({ canEdit: true, reason: null });
  });

  it("the API's access wins, with its reason", () => {
    expect(resolveViewerAccess({ ...base, access: { canEdit: false, reason: 'site_restricted' } })).toEqual({
      canEdit: false,
      reason: 'site_restricted',
    });
    // An unknown reason still reads as read-only, with the generic words.
    expect(resolveViewerAccess({ ...base, access: { canEdit: false, reason: 'something_new' } })).toEqual({
      canEdit: false,
      reason: 'not_editable',
    });
  });

  it('an access field that is present but malformed fails closed', () => {
    expect(resolveViewerAccess({ ...base, access: { canEdit: 'no' } })).toEqual({ canEdit: false, reason: 'not_editable' });
  });

  it('API access that says editable still needs devices.write', () => {
    expect(resolveViewerAccess({ ...base, access: { canEdit: true, reason: null }, permissions: reader })).toEqual({
      canEdit: false,
      reason: 'no_write_permission',
    });
  });

  it('without access, an org-scope caller on an MSP-managed policy is read-only', () => {
    expect(resolveViewerAccess({ ...base, policyOrgId: null })).toEqual({ canEdit: false, reason: 'msp_managed_org_user' });
  });

  it('without access, a partner caller who cannot manage MSP-managed policies is read-only on one', () => {
    expect(
      resolveViewerAccess({ ...base, policyOrgId: null, claims: partner, canManagePartnerWide: false }),
    ).toEqual({ canEdit: false, reason: 'msp_managed_limited_access' });
    // Absent means capable (the server still decides), as auth.ts documents.
    expect(resolveViewerAccess({ ...base, policyOrgId: null, claims: partner })).toEqual({ canEdit: true, reason: null });
  });

  it('fails closed on an MSP-managed policy while the scope is unknown', () => {
    expect(resolveViewerAccess({ ...base, policyOrgId: null, claims: pending })).toEqual({ canEdit: false, reason: null });
    expect(resolveViewerAccess({ ...base, claims: pending })).toEqual({ canEdit: true, reason: null });
  });

  it('a caller without devices.write is read-only; an unknown permission list is left to the server', () => {
    expect(resolveViewerAccess({ ...base, permissions: reader })).toEqual({ canEdit: false, reason: 'no_write_permission' });
    expect(resolveViewerAccess({ ...base, permissions: [{ resource: '*', action: '*' }] })).toEqual({ canEdit: true, reason: null });
    expect(resolveViewerAccess({ ...base, permissions: undefined })).toEqual({ canEdit: true, reason: null });
  });
});
