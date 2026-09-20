import { describe, it, expect } from 'vitest';
import { MONITOR_KIND_FIELDS } from './monitorKindFields';

// W05c1: the API accepts consecutiveFailures 1..100 for the agent-evaluated
// kinds; the editor's field cap must not silently stay at the old 20.
describe('consecutiveFailures field cap (W05c1)', () => {
  it.each(['service', 'process', 'network_check'] as const)('%s allows up to 100', (kind) => {
    const field = MONITOR_KIND_FIELDS[kind].find((f) => f.labelKey === 'monitoring:fields.consecutiveFailures');
    expect(field, `${kind} has a consecutiveFailures field`).toBeDefined();
    expect(field).toMatchObject({ min: 1, max: 100 });
  });
});
