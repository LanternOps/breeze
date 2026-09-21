import { describe, expect, it } from 'vitest';
import { topologyHealthLabel } from './topologyPresentation';

/**
 * The reason vocabulary is the API's, not the UI's: an unanswered ICMP probe is
 * `icmp_no_response` (`apps/api/src/services/topology/diagnosticHealth.ts`).
 * A label keyed on a token the server never emits is a silent "Not measured".
 */
describe('topologyHealthLabel', () => {
  it('names an unanswered ICMP probe using the API reason code', () => {
    expect(topologyHealthLabel('unknown', [{ code: 'icmp_no_response', message: 'No ICMP response' }]))
      .toBe('No ICMP response');
  });

  it('falls back to the status label when no reason claims the row', () => {
    expect(topologyHealthLabel('unknown', [{ code: 'no_monitor_result', message: 'Not measured' }]))
      .toBe('Not measured');
    expect(topologyHealthLabel('healthy', [])).toBe('Healthy');
    expect(topologyHealthLabel('degraded', [])).toBe('Degraded');
    expect(topologyHealthLabel('failed_check', [])).toBe('Check failed');
  });
});
