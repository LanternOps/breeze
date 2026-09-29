import { describe, expect, it, vi } from 'vitest';

vi.mock('../../middleware/auth', () => ({
  hasSatisfiedMfa: (auth: { token?: { mfa?: boolean } }) => auth.token?.mfa === true,
}));

import { callerMaySetEmailRecipients, RECIPIENTS_NEED_EXPORT_AND_MFA } from './recipientGate';

const withExport = { permissions: [{ resource: 'reports', action: 'export' }] };
const withoutExport = { permissions: [{ resource: 'reports', action: 'write' }] };
const mfa = { token: { mfa: true } } as never;
const noMfa = { token: { mfa: false } } as never;

describe('callerMaySetEmailRecipients (moved from core.ts, behaviour unchanged)', () => {
  it('requires reports:export AND a satisfied MFA session', () => {
    expect(callerMaySetEmailRecipients(mfa, withExport as never)).toBe(true);
    expect(callerMaySetEmailRecipients(noMfa, withExport as never)).toBe(false);
    expect(callerMaySetEmailRecipients(mfa, withoutExport as never)).toBe(false);
    expect(callerMaySetEmailRecipients(mfa, undefined)).toBe(false);
  });

  it('keeps the exact 403 body core.ts has always sent', () => {
    expect(RECIPIENTS_NEED_EXPORT_AND_MFA).toEqual({
      error: 'Setting or changing email recipients on a report requires the export permission and an MFA-verified session',
    });
  });
});
