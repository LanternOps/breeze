import { expect, it } from 'vitest';
import {
  startCallerVerificationSchema as start,
  callerVerificationPolicySchema as policy,
  administrativeCallerVerificationSchema as admin,
  callerVerificationBindingSchema as binding,
  callerVerificationMethodsQuerySchema as methodsQuery,
  callerVerificationFenceOverrideSchema as fence,
  attestCallerVerificationSchema as attest,
} from './callerVerification';

const id = '11111111-1111-4111-8111-111111111111';
const other = '22222222-2222-4222-8222-222222222222';

it('requires an explicit workstation target and forbids administrative challenge starts', () => {
  expect(start.safeParse({ contactId: id, method: 'workstation', actionScope: 'reset_password' }).success).toBe(false);
  expect(start.safeParse({ contactId: id, method: 'workstation', actionScope: 'reset_password', deviceId: id, username: 'alice' }).success).toBe(true);
  expect(start.safeParse({ contactId: id, method: 'administrative_stepup', actionScope: 'disable_user' }).success).toBe(false);
  expect(start.safeParse({ contactId: 'bad', method: 'sms', actionScope: 'any' }).success).toBe(false);
  expect(start.safeParse({ contactId: id, method: 'sms', actionScope: 'any', extra: 1 }).success).toBe(false);
});

it('only disable_user permits a different target', () => {
  expect(start.safeParse({ contactId: id, targetContactId: other, method: 'sms', actionScope: 'reset_password' }).success).toBe(false);
  expect(start.safeParse({ contactId: id, targetContactId: other, method: 'sms', actionScope: 'disable_user' }).success).toBe(true);
  expect(start.safeParse({ contactId: id, targetContactId: id, method: 'sms', actionScope: 'reset_password' }).success).toBe(true);
});

it('preserves null inheritance and boundary zero without silently defaulting a policy', () => {
  expect(policy.parse({ requiredTierResetPassword: 0, allowedMethods: [], requireTicket: null }))
    .toEqual({ requiredTierResetPassword: 0, allowedMethods: [], requireTicket: null });
  for (const v of [-1, 4]) expect(policy.safeParse({ requiredTierResetPassword: v }).success).toBe(false);
  expect(policy.safeParse({ allowedMethods: ['administrative_stepup'] }).success).toBe(false);
  expect(policy.safeParse({ disableUserAuthorizerRoles: ['it_admin'] }).success).toBe(false);
  expect(policy.safeParse({ verificationTtlMinutes: 241 }).success).toBe(false);
  expect(policy.safeParse({ ownerScope: 'partner' }).success).toBe(false);
});

it('requires a meaningful administrative reason', () => {
  expect(admin.safeParse({ targetContactId: id, stepUpGrantId: id, reason: 'short' }).success).toBe(false);
  expect(admin.safeParse({ targetContactId: id, stepUpGrantId: id, reason: 'Confirmed offboarding by HR.' }).success).toBe(true);
});

it('validates bindings, notes, override reasons and the methods query default', () => {
  expect(binding.safeParse({ entraTenantId: id, entraOid: other, upn: null }).success).toBe(true);
  expect(binding.safeParse({ entraTenantId: 'tenant', entraOid: other, upn: null }).success).toBe(false);
  expect(attest.safeParse({ note: 'too short' }).success).toBe(false);
  expect(fence.safeParse({ reason: 'Security confirmed the caller independently.' }).success).toBe(true);
  expect(methodsQuery.parse({})).toEqual({ actionScope: 'any' });
});
