import { describe, it, expect } from 'vitest';
import {
  PORTAL_ACCESS_POLICY_FIELDS,
  PORTAL_ACCESS_POLICY_ERROR_CODES,
  portalAccessPolicyPatchSchema,
  decidePortalAccessRequestsSchema,
} from './portalAccessPolicy';
import * as validators from './index';

const UUID_A = '7d9f1c2e-4b3a-4c5d-8e6f-0a1b2c3d4e5f';
const UUID_B = '2b6c8e1f-9a7d-4f3e-a1b2-c3d4e5f60718';

describe('portalAccessPolicyPatchSchema', () => {
  it('accepts a partial patch and null (inherit / clear) on every field', () => {
    expect(portalAccessPolicyPatchSchema.parse({ passwordMode: 'sso_only' })).toEqual({ passwordMode: 'sso_only' });
    const allNull = Object.fromEntries(PORTAL_ACCESS_POLICY_FIELDS.map((f) => [f, null]));
    expect(portalAccessPolicyPatchSchema.parse(allNull)).toEqual(allNull);
    expect(portalAccessPolicyPatchSchema.parse({})).toEqual({});
  });

  it('portalAccessPolicyPatchSchema rejects unknown keys, password_mode "off", ssoSessionMaxHours 0/169/1.5', () => {
    expect(portalAccessPolicyPatchSchema.safeParse({ password_mode: 'allowed' }).success).toBe(false);
    expect(portalAccessPolicyPatchSchema.safeParse({ entraEnabled: true, extra: 1 }).success).toBe(false);
    expect(portalAccessPolicyPatchSchema.safeParse({ passwordMode: 'off' }).success).toBe(false);
    expect(portalAccessPolicyPatchSchema.safeParse({ ssoSessionMaxHours: 0 }).success).toBe(false);
    expect(portalAccessPolicyPatchSchema.safeParse({ ssoSessionMaxHours: 169 }).success).toBe(false);
    expect(portalAccessPolicyPatchSchema.safeParse({ ssoSessionMaxHours: 1.5 }).success).toBe(false);
    expect(portalAccessPolicyPatchSchema.safeParse({ ssoSessionMaxHours: '12' }).success).toBe(false);
    expect(portalAccessPolicyPatchSchema.safeParse({ ssoSessionMaxHours: 1 }).success).toBe(true);
    expect(portalAccessPolicyPatchSchema.safeParse({ ssoSessionMaxHours: 168 }).success).toBe(true);
  });

  it('accepts only the documented enum values', () => {
    for (const v of ['off', 'approval', 'instant']) {
      expect(portalAccessPolicyPatchSchema.safeParse({ selfRegistrationMode: v }).success).toBe(true);
    }
    expect(portalAccessPolicyPatchSchema.safeParse({ selfRegistrationMode: 'invited_only' }).success).toBe(false);
    for (const v of ['invited_only', 'approval', 'instant']) {
      expect(portalAccessPolicyPatchSchema.safeParse({ ssoNewPersonMode: v }).success).toBe(true);
    }
    expect(portalAccessPolicyPatchSchema.safeParse({ ssoNewPersonMode: 'off' }).success).toBe(false);
    expect(portalAccessPolicyPatchSchema.safeParse({ entraEnabled: 'true' }).success).toBe(false);
  });

  it('names the six policy fields and the four error codes', () => {
    expect([...PORTAL_ACCESS_POLICY_FIELDS]).toEqual([
      'entraEnabled', 'googleEnabled', 'passwordMode', 'selfRegistrationMode', 'ssoNewPersonMode', 'ssoSessionMaxHours',
    ]);
    expect(PORTAL_ACCESS_POLICY_ERROR_CODES).toEqual({
      METHOD_UNAVAILABLE: 'PORTAL_ACCESS_POLICY_METHOD_UNAVAILABLE',
      SSO_ONLY_NEEDS_SSO: 'PORTAL_ACCESS_POLICY_SSO_ONLY_NEEDS_SSO',
      // W4 (#11381): Microsoft needs a proven tenant (D2); the sso_only save needs an acknowledged impact (D12).
      TENANT_NOT_PROVEN: 'PORTAL_ACCESS_POLICY_TENANT_NOT_PROVEN',
      SSO_ONLY_CONFIRM_REQUIRED: 'PORTAL_ACCESS_POLICY_SSO_ONLY_CONFIRM_REQUIRED',
    });
  });
});

describe('decidePortalAccessRequestsSchema', () => {
  it('accepts 1..100 uuids with approve or deny', () => {
    expect(decidePortalAccessRequestsSchema.parse({ requestIds: [UUID_A, UUID_B], decision: 'deny' }))
      .toEqual({ requestIds: [UUID_A, UUID_B], decision: 'deny' });
    expect(decidePortalAccessRequestsSchema.safeParse({ requestIds: Array(100).fill(UUID_A), decision: 'approve' }).success)
      .toBe(true);
  });

  it('rejects an empty list, more than 100 ids, a non-uuid, an unknown decision and unknown keys', () => {
    expect(decidePortalAccessRequestsSchema.safeParse({ requestIds: [], decision: 'approve' }).success).toBe(false);
    expect(decidePortalAccessRequestsSchema.safeParse({ requestIds: Array(101).fill(UUID_A), decision: 'approve' }).success)
      .toBe(false);
    expect(decidePortalAccessRequestsSchema.safeParse({ requestIds: ['not-a-uuid'], decision: 'approve' }).success).toBe(false);
    expect(decidePortalAccessRequestsSchema.safeParse({ requestIds: [UUID_A], decision: 'expire' }).success).toBe(false);
    expect(decidePortalAccessRequestsSchema.safeParse({ requestIds: [UUID_A], decision: 'deny', note: 'x' }).success).toBe(false);
  });
});

describe('validators index', () => {
  it('re-exports the portal access policy schemas', () => {
    expect(validators.portalAccessPolicyPatchSchema).toBe(portalAccessPolicyPatchSchema);
    expect(validators.decidePortalAccessRequestsSchema).toBe(decidePortalAccessRequestsSchema);
  });
});
