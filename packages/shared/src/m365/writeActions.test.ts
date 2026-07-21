import { describe, it, expect } from 'vitest';
import {
  m365WriteActionSchema,
  writeActionRequestSchema,
  writeActionResultSchema,
  M365_WRITE_ACTION_IDS,
} from './writeActions';

const UUID = '00000000-0000-4000-8000-000000000001';

describe('m365WriteActionSchema', () => {
  it('accepts the two first-cut actions', () => {
    expect(m365WriteActionSchema.parse({ type: 'm365.user.disable', userIdentifier: 'a@b.com', reason: 'offboard' }).type)
      .toBe('m365.user.disable');
    expect(m365WriteActionSchema.parse({ type: 'm365.user.reset_password', userIdentifier: 'a@b.com', reason: 'compromised' }).type)
      .toBe('m365.user.reset_password');
  });

  it('rejects an unknown action id', () => {
    expect(m365WriteActionSchema.safeParse({ type: 'm365.user.delete', userIdentifier: 'a@b.com', reason: 'x' }).success)
      .toBe(false);
  });

  it('rejects extra keys (strict) and a missing reason', () => {
    expect(m365WriteActionSchema.safeParse({ type: 'm365.user.disable', userIdentifier: 'a@b.com', reason: 'x', extra: 1 }).success)
      .toBe(false);
    expect(m365WriteActionSchema.safeParse({ type: 'm365.user.disable', userIdentifier: 'a@b.com' }).success)
      .toBe(false);
  });

  it("rejects a userIdentifier containing quotes/backslashes", () => {
    expect(m365WriteActionSchema.safeParse({ type: 'm365.user.disable', userIdentifier: "a'b@example.com", reason: 'x' }).success)
      .toBe(false);
  });
});

describe('writeActionRequestSchema', () => {
  it('requires correlationId, tenantId, idempotencyKey, action', () => {
    const ok = writeActionRequestSchema.safeParse({
      correlationId: UUID, tenantId: UUID, idempotencyKey: 'intent-123',
      action: { type: 'm365.user.disable', userIdentifier: 'a@b.com', reason: 'x' },
    });
    expect(ok.success).toBe(true);
    expect(writeActionRequestSchema.safeParse({
      correlationId: UUID, tenantId: UUID,
      action: { type: 'm365.user.disable', userIdentifier: 'a@b.com', reason: 'x' },
    }).success).toBe(false); // missing idempotencyKey
  });
});

describe('writeActionResultSchema', () => {
  it('accepts a disable success', () => {
    expect(writeActionResultSchema.safeParse({ success: true, action: 'm365.user.disable', userId: UUID }).success).toBe(true);
  });
  it('accepts a reset success with temporaryPassword', () => {
    expect(writeActionResultSchema.safeParse({
      success: true, action: 'm365.user.reset_password', userId: UUID,
      temporaryPassword: 'Tmp!23xyz', forceChangeNextSignIn: true,
    }).success).toBe(true);
  });
  it('accepts a failure with a known code', () => {
    expect(writeActionResultSchema.safeParse({ success: false, errorCode: 'user_not_found' }).success).toBe(true);
    expect(writeActionResultSchema.safeParse({ success: false, errorCode: 'not_a_code' }).success).toBe(false);
  });
  it('pins the action id list', () => {
    expect([...M365_WRITE_ACTION_IDS]).toEqual(['m365.user.disable', 'm365.user.reset_password']);
  });
});
