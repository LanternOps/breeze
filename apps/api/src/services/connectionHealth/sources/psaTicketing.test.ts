import { describe, expect, it, vi } from 'vitest';
vi.mock('../../../db', () => ({ db: {} }));
import { psaTicketingObservation } from './psaTicketing';
import { planTransitions } from '../transitions';
const now = new Date('2026-10-31T12:00:00Z');
const row = {
  id: 'connection',
  partnerId: 'partner',
  name: 'Example PSA',
  paused: true,
  terminal: false,
  capped: false,
};
describe('PSA ticketing partner health', () => {
  it('opens one partner incident for an auth pause and updates the same incident', () => {
    const obs = psaTicketingObservation(row, now);
    expect(obs).toMatchObject({
      orgId: null,
      partnerId: 'partner',
      sourceId: 'connection',
      state: 'broken',
      severity: 'permanent',
    });
    expect(obs.detail).toContain('not yet verified against a live ConnectWise Manage tenant');
    expect(planTransitions({ observations: [obs], tracked: [], now, seed: false })).toEqual([
      expect.objectContaining({ type: 'insertOpen' }),
    ]);
    expect(
      planTransitions({
        observations: [obs],
        tracked: [
          {
            id: 'incident',
            sourceId: 'connection',
            openedAt: now,
            resolvedAt: null,
            severity: 'permanent',
            healthyStreak: 0,
          },
        ],
        now,
        seed: false,
      })
    ).toEqual([expect.objectContaining({ type: 'update', incidentId: 'incident' })]);
  });
  it.each(['terminal', 'capped'] as const)('%s is broken even without a pause', (flag) => {
    expect(psaTicketingObservation({ ...row, paused: false, [flag]: true }, now).state).toBe(
      'broken'
    );
  });
  it('recovers when terminal rows are redriven and the pause/cap is cleared', () => {
    expect(psaTicketingObservation({ ...row, paused: false }, now).state).toBe('healthy');
  });
});
