import { describe, expect, it, vi } from 'vitest';
vi.mock('../sentry', () => ({ captureException: vi.fn() }));
import { captureException } from '../sentry';
import { reportTicketingFailure } from './reporting';
import { harness } from './testHarness';
describe('safe PSA Sentry payloads', () => {
  it.each([
    'PSA_ALERT_TICKET_CREATE_FAILED',
    'PSA_ALERT_TICKET_OUTCOME_UNKNOWN',
    'PSA_ALERT_TICKET_CLOSE_FAILED',
    'PSA_ALERT_TICKET_AUTH_PAUSED',
  ])('%s contains only fixed text and identity tags', (errorId) => {
    vi.clearAllMocks();
    const f = harness();
    f.ctx.mapping.lastError = 'SECRET RESPONSE';
    reportTicketingFailure(f.ctx, errorId);
    expect(captureException).toHaveBeenCalledWith(expect.any(Error), undefined, {
      errorId,
      psa_connection_id: 'connection',
      psa_provider: 'connectwise',
      partner_id: 'partner',
    });
    const args = vi.mocked(captureException).mock.calls[0]!;
    expect((args[0] as Error).message).not.toContain('SECRET');
    expect(JSON.stringify(args)).not.toContain('SECRET');
  });
});
