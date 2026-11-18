import { describe, expect, it } from 'vitest';
import { classifyAutomation } from './classify';

/** Tool Catalog W06 (#5221) Task A7 — the ordered class predicate (M > A > P > S; first match wins). */
const base = { managedByMonitorId: null, managedByAgentId: null, trigger: { type: 'manual' }, retiredAt: null };

describe('classifyAutomation', () => {
  it('monitor row with an agent id is M', () => {
    expect(classifyAutomation({ ...base, managedByMonitorId: 'm', managedByAgentId: 'a' })).toBe('M');
  });

  it('agent-managed row is A', () => {
    expect(classifyAutomation({ ...base, managedByAgentId: 'a' })).toBe('A');
  });

  it('null-managed row with _policyWorkflow is P', () => {
    expect(classifyAutomation({ ...base, trigger: { type: 'event', eventType: 'x', filter: { _policyWorkflow: { id: 'p' } } } })).toBe('P');
  });

  it('everything else live is S; a retired S row is retired', () => {
    expect(classifyAutomation(base)).toBe('S');
    expect(classifyAutomation({ ...base, retiredAt: new Date() })).toBe('retired');
    // A managed row stays managed whether or not it is retired.
    expect(classifyAutomation({ ...base, managedByMonitorId: 'm', retiredAt: new Date() })).toBe('M');
  });
});
