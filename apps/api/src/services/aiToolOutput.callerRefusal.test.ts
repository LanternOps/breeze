import { describe, expect, it } from 'vitest';
import { compactToolResultForChat } from './aiToolOutput';

// #6354 W05: the refusal object must survive the real compactor untouched, so
// a pre-tool denial body (which IS compacted) keeps its typed payload.
describe('compactToolResultForChat keeps a caller-verification refusal', () => {
  it('does not strip requiresCallerVerification', () => {
    const body = JSON.stringify({
      error: 'Caller verification required',
      requiresCallerVerification: {
        orgId: '11111111-1111-1111-1111-111111111111',
        contactId: '22222222-2222-2222-2222-222222222222',
        action: 'disable_user',
        requiredTier: 2,
        reason: 'no_fresh_verification',
        latest: { id: '33333333-3333-3333-3333-333333333333', status: 'verified', method: 'sms_code', decidedAt: '2026-10-17T00:00:00.000Z' },
      },
    });
    expect(JSON.parse(compactToolResultForChat('m365_disable_user', body))).toEqual(JSON.parse(body));
  });
});
