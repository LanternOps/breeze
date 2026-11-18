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
  ] as const)('%s contains only fixed text and identity tags', (errorId) => {
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

it('always logs ids and lastError and omits absent partner tags', () => {
  vi.clearAllMocks();
  const f = harness();
  f.ctx.connection.partnerId = null;
  f.ctx.mapping.lastError = 'psa_transient';
  const log = vi.spyOn(console, 'error').mockImplementation(() => {});
  reportTicketingFailure(f.ctx, 'PSA_ALERT_TICKET_CREATE_FAILED');
  expect(log).toHaveBeenCalledWith('[psa-ticketing] attention required', expect.objectContaining({
    errorId: 'PSA_ALERT_TICKET_CREATE_FAILED', mappingId: 'mapping', alertId: 'alert',
    connectionId: 'connection', lastError: 'psa_transient',
  }));
  expect(vi.mocked(captureException).mock.calls[0]![2]).not.toHaveProperty('partner_id');
  log.mockRestore();
});
it('captures the original non-adapter Error including its cause', () => {
  vi.clearAllMocks();
  const error = new Error('internal failure', { cause: new Error('root cause') });
  reportTicketingFailure(harness().ctx, 'PSA_ALERT_TICKET_OUTCOME_UNKNOWN', error);
  expect(vi.mocked(captureException).mock.calls[0]![0]).toBe(error);
});
