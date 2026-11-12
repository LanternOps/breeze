import { describe, expect, it } from 'vitest';
import { drExecutionView } from './drExecutionView';
describe('execution status view', () => {
  it('retains display results and leaves stored input intact', () => {
    const stored = { results: { definition: { groups: [{ devices: ['device-1'] }] }, plannedGroups: [], dispatchStatus: 'queued' } };
    expect(drExecutionView(stored).results).toEqual({ plannedGroups: [], dispatchStatus: 'queued' });
    expect(stored.results.definition.groups[0]?.devices).toEqual(['device-1']);
  });
});
