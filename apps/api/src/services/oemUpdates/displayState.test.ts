import { describe, expect, it } from 'vitest';
import { deriveOemDisplayState, type OemDisplayStatus } from './displayState';

const now = new Date('2027-02-20T12:00:00.000Z');
const DAY = 24 * 60 * 60 * 1000;

function status(overrides: Partial<OemDisplayStatus> = {}): OemDisplayStatus {
  return {
    applicability: 'applicable',
    lastOutcome: 'success',
    occurrenceKey: '2027-02',
    lastSuccessAt: new Date(now.getTime() - DAY),
    rebootPendingSince: null,
    ...overrides,
  };
}

const inOccurrence = { occurrenceKey: '2027-02', isPastLastNight: false };
const pastOccurrence = { occurrenceKey: '2027-02', isPastLastNight: true };

describe('deriveOemDisplayState', () => {
  it.each<[string, Parameters<typeof deriveOemDisplayState>[0], string]>([
    ['no row, no link', { status: null, linkEnabled: false, occurrence: null, now }, 'not_managed'],
    ['no row, link on, nothing has run yet', { status: null, linkEnabled: true, occurrence: inOccurrence, now }, 'not_managed'],
    ['no row, link on, occurrence over', { status: null, linkEnabled: true, occurrence: pastOccurrence, now }, 'overdue'],
    ['a Run Now result on an unmanaged device', { status: status(), linkEnabled: false, occurrence: null, now }, 'not_managed'],
    ['the tool refused the model', { status: status({ applicability: 'not_supported', lastOutcome: 'not_supported' }), linkEnabled: true, occurrence: inOccurrence, now }, 'not_supported'],
    ['not applicable to any lane', { status: status({ applicability: 'not_applicable', lastOutcome: null }), linkEnabled: true, occurrence: inOccurrence, now }, 'not_managed'],
    ['finished this occurrence', { status: status(), linkEnabled: true, occurrence: inOccurrence, now }, 'up_to_date'],
    ['no_updates this occurrence', { status: status({ lastOutcome: 'no_updates' }), linkEnabled: true, occurrence: pastOccurrence, now }, 'up_to_date'],
    ['last month was good, this month has not started', { status: status({ occurrenceKey: '2027-01' }), linkEnabled: true, occurrence: inOccurrence, now }, 'up_to_date'],
    ['last month was good, this month ran out', { status: status({ occurrenceKey: '2027-01' }), linkEnabled: true, occurrence: pastOccurrence, now }, 'overdue'],
    ['failed', { status: status({ lastOutcome: 'failed', lastSuccessAt: null }), linkEnabled: true, occurrence: inOccurrence, now }, 'failing'],
    ['partial', { status: status({ lastOutcome: 'partial' }), linkEnabled: true, occurrence: inOccurrence, now }, 'failing'],
    ['tool_unavailable', { status: status({ lastOutcome: 'tool_unavailable' }), linkEnabled: true, occurrence: inOccurrence, now }, 'failing'],
    ['interrupted', { status: status({ lastOutcome: 'interrupted' }), linkEnabled: true, occurrence: inOccurrence, now }, 'failing'],
    ['no recovery key', { status: status({ lastOutcome: 'blocked_no_recovery_key' }), linkEnabled: true, occurrence: inOccurrence, now }, 'failing'],
    ['on battery tonight is not a failure', { status: status({ lastOutcome: 'blocked_on_battery', occurrenceKey: '2027-01' }), linkEnabled: true, occurrence: inOccurrence, now }, 'up_to_date'],
    ['retry_later is not a failure', { status: status({ lastOutcome: 'retry_later', lastSuccessAt: null }), linkEnabled: true, occurrence: inOccurrence, now }, 'not_managed'],
    ['blocked and out of nights', { status: status({ lastOutcome: 'blocked_on_battery', lastSuccessAt: null }), linkEnabled: true, occurrence: pastOccurrence, now }, 'overdue'],
    ['a pending reboot', { status: status({ lastOutcome: 'success_reboot_required', rebootPendingSince: new Date(now.getTime() - DAY) }), linkEnabled: true, occurrence: inOccurrence, now }, 'waiting_for_reboot'],
    ['blocked by a pending reboot is not failing', { status: status({ lastOutcome: 'blocked_reboot_pending', rebootPendingSince: new Date(now.getTime() - DAY) }), linkEnabled: true, occurrence: inOccurrence, now }, 'waiting_for_reboot'],
    ['a Run Now reboot pending on an unmanaged device', { status: status({ rebootPendingSince: new Date(now.getTime() - DAY) }), linkEnabled: false, occurrence: null, now }, 'waiting_for_reboot'],
    ['two nights held', { status: status({ rebootPendingSince: new Date(now.getTime() - 2.9 * DAY) }), linkEnabled: true, occurrence: inOccurrence, now }, 'waiting_for_reboot'],
    ['three nights held', { status: status({ rebootPendingSince: new Date(now.getTime() - 3 * DAY) }), linkEnabled: true, occurrence: inOccurrence, now }, 'reboot_overdue'],
    ['three attempts used is overdue, with nights left', { status: status({ lastOutcome: 'failed', attempts: 3 }), linkEnabled: true, occurrence: inOccurrence, now }, 'overdue'],
    ['two attempts used still reads as failing', { status: status({ lastOutcome: 'failed', attempts: 2 }), linkEnabled: true, occurrence: inOccurrence, now }, 'failing'],
    ['three attempts from last month do not count', { status: status({ lastOutcome: 'failed', attempts: 3, occurrenceKey: '2027-01' }), linkEnabled: true, occurrence: inOccurrence, now }, 'failing'],
    ['three attempts and finished on the last is up to date', { status: status({ lastOutcome: 'success', attempts: 3 }), linkEnabled: true, occurrence: inOccurrence, now }, 'up_to_date'],
    ['reboot never, however long, waits for the reboot', { status: status({ rebootPendingSince: new Date(now.getTime() - 20 * DAY) }), linkEnabled: true, rebootMode: 'never', occurrence: inOccurrence, now }, 'waiting_for_reboot'],
    ['reboot never, blocked by a pending reboot, is not failing', { status: status({ lastOutcome: 'blocked_reboot_pending', rebootPendingSince: new Date(now.getTime() - DAY) }), linkEnabled: true, rebootMode: 'never', occurrence: inOccurrence, now }, 'waiting_for_reboot'],
    ['overnight goes overdue after three nights', { status: status({ rebootPendingSince: new Date(now.getTime() - 3 * DAY) }), linkEnabled: true, rebootMode: 'overnight', occurrence: inOccurrence, now }, 'reboot_overdue'],
  ])('%s', (_name, input, expected) => {
    expect(deriveOemDisplayState(input)).toBe(expected);
  });

  it('covers all seven states', () => {
    const seen = new Set([
      deriveOemDisplayState({ status: status(), linkEnabled: true, occurrence: inOccurrence, now }),
      deriveOemDisplayState({ status: null, linkEnabled: true, occurrence: pastOccurrence, now }),
      deriveOemDisplayState({ status: status({ lastOutcome: 'failed' }), linkEnabled: true, occurrence: inOccurrence, now }),
      deriveOemDisplayState({ status: status({ applicability: 'not_supported' }), linkEnabled: true, occurrence: inOccurrence, now }),
      deriveOemDisplayState({ status: null, linkEnabled: false, occurrence: null, now }),
      deriveOemDisplayState({ status: status({ rebootPendingSince: now }), linkEnabled: true, occurrence: inOccurrence, now }),
      deriveOemDisplayState({ status: status({ rebootPendingSince: new Date(now.getTime() - 4 * DAY) }), linkEnabled: true, occurrence: inOccurrence, now }),
    ]);
    expect(seen.size).toBe(7);
  });
});
