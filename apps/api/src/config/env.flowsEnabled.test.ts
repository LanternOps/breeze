import { afterEach, describe, expect, it } from 'vitest';
import { flowsEnabled } from './env';

/** Tool catalog W06 (#5221) Task C4 / Decision 11: Flows default on in R1; `false` keeps them off. */
const original = process.env.FLOWS_ENABLED;
afterEach(() => {
  if (original === undefined) delete process.env.FLOWS_ENABLED;
  else process.env.FLOWS_ENABLED = original;
});

describe('FLOWS_ENABLED', () => {
  it('FLOWS_ENABLED unset is true', () => {
    delete process.env.FLOWS_ENABLED;
    expect(flowsEnabled()).toBe(true);
  });

  it('FLOWS_ENABLED empty is true (the compose `${FLOWS_ENABLED:-}` passthrough)', () => {
    process.env.FLOWS_ENABLED = '';
    expect(flowsEnabled()).toBe(true);
  });

  it.each(['false', '0', 'no', 'off', 'FALSE'])('FLOWS_ENABLED=%s is false', (raw) => {
    process.env.FLOWS_ENABLED = raw;
    expect(flowsEnabled()).toBe(false);
  });

  it.each(['true', '1', 'yes', 'on'])('FLOWS_ENABLED=%s is true', (raw) => {
    process.env.FLOWS_ENABLED = raw;
    expect(flowsEnabled()).toBe(true);
  });
});
