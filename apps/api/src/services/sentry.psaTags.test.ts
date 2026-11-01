import { expect, it } from 'vitest';
import { scrubEvent } from './sentry';
it('preserves bounded PSA identity tags', () => {
  const tags = {
    errorId: 'PSA_ALERT_TICKET_CREATE_FAILED',
    psa_connection_id: '11111111-1111-4111-8111-111111111111',
    psa_provider: 'connectwise',
    partner_id: '22222222-2222-4222-8222-222222222222',
  };
  expect(scrubEvent({ tags }).tags).toEqual(tags);
});
