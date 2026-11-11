import { expect, it } from 'vitest';
import { scrubEvent } from './sentry';

it('preserves isolation fault phases and local UUID context through the scrubber', () => {
  const tags = {
    phase: 'isolation_heartbeat_block',
    isolationId: '11111111-1111-4111-8111-111111111111',
    deviceId: '22222222-2222-4222-8222-222222222222',
  };
  expect(scrubEvent({ tags }).tags).toEqual(tags);
});
it('preserves incident desynchronization UUIDs without allowing raw diagnostic values', () => {
  const tags = { isolationId: '11111111-1111-4111-8111-111111111111', incidentId: '22222222-2222-4222-8222-222222222222', incidentActionId: '33333333-3333-4333-8333-333333333333' };
  expect(scrubEvent({ tags: { ...tags, reason: 'agent-controlled prose', paths: 'raw body', deviceId: 'private-host.example.test', source: 'secret' } }).tags).toEqual(tags);
});
it('does not allow generic phase or identity tags outside isolation diagnostics', () => {
  expect(scrubEvent({ tags: { phase: 'unrelated', deviceId: '22222222-2222-4222-8222-222222222222' } }).tags).toEqual({});
});
