/** #11673: a run check-in's answer carries the whole run summary, its last paragraph included. */
import { describe, expect, it } from 'vitest';
import { checkInRunResultBody } from './checkInRuns';

describe('checkInRunResultBody', () => {
  const nextStep = '**Next step:** replace the failing disk this week.';
  const summary = `${'Evidence line about the SMART counters on the data volume.\n'.repeat(30)}\n${nextStep}`;

  it('keeps a full-length summary whole, so its closing recommendation survives', () => {
    expect(summary.length).toBeGreaterThan(1500);
    expect(summary.length).toBeLessThanOrEqual(2000);
    expect(checkInRunResultBody({ status: 'completed', summary })).toBe(summary.trim());
  });

  it('adds the waiting line after the whole summary for a run waiting on approval', () => {
    const body = checkInRunResultBody({ status: 'awaiting_approval', summary });
    expect(body).toContain(nextStep);
    expect(body.endsWith('A step I proposed is waiting for your approval.')).toBe(true);
  });
});
