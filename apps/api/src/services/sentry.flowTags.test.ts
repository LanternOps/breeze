import { expect, it } from 'vitest';
import { scrubEvent } from './sentry';

// Tool Catalog W04 (#5219): every flow-runner capture carries the run's ids
// and a literal call-site name. Without the allowlist entries the scrubber
// drops them and every flow failure arrives as an indistinguishable blank.
it('preserves flow-runner identity tags after scrubbing', () => {
  const tags = {
    org_id: '11111111-1111-4111-8111-111111111111',
    flow_id: '22222222-2222-4222-8222-222222222222',
    flow_run_id: '33333333-3333-4333-8333-333333333333',
    flow_site: 'reconciler.enqueue',
  };
  expect(scrubEvent({ tags }).tags).toEqual(tags);
});
