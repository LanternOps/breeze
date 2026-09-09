import { describe, expect, it } from 'vitest';

import {
  DISMISS_NOTES_MAX_LENGTH,
  availableFindingActions,
  canAcknowledge,
  canDismiss,
  canReopen,
  findingActionLabel,
  findingSeverityRank,
  findingSeverityTier,
  findingStatusLabel,
  severityLabel,
  validateDismissNote,
  type FleetFindingSeverity,
  type FleetFindingStatus,
} from './findingActions';

const ALL_STATUSES: FleetFindingStatus[] = ['open', 'acknowledged', 'dismissed', 'resolved'];

describe('finding action gating', () => {
  // The table is the contract: it must match
  // apps/web/src/components/fleet/FindingDrawer.tsx so a tech sees the same
  // affordances on the phone as in the browser. `resolved` is terminal — the
  // reconciler owns it and no human action applies.
  const expected: Record<FleetFindingStatus, { ack: boolean; dismiss: boolean; reopen: boolean }> =
    {
      open: { ack: true, dismiss: true, reopen: false },
      acknowledged: { ack: false, dismiss: true, reopen: true },
      dismissed: { ack: false, dismiss: false, reopen: true },
      resolved: { ack: false, dismiss: false, reopen: false },
    };

  it.each(ALL_STATUSES)('gates every action for status %s exactly as the web drawer', (status) => {
    expect(canAcknowledge(status)).toBe(expected[status].ack);
    expect(canDismiss(status)).toBe(expected[status].dismiss);
    expect(canReopen(status)).toBe(expected[status].reopen);
  });

  it('lists the available actions in the order they are rendered', () => {
    expect(availableFindingActions('open')).toEqual(['acknowledge', 'dismiss']);
    expect(availableFindingActions('acknowledged')).toEqual(['dismiss', 'reopen']);
    expect(availableFindingActions('dismissed')).toEqual(['reopen']);
    expect(availableFindingActions('resolved')).toEqual([]);
  });

  it('offers nothing for a status the server may add later', () => {
    const future = 'snoozed' as FleetFindingStatus;
    expect(canAcknowledge(future)).toBe(false);
    expect(canDismiss(future)).toBe(false);
    expect(canReopen(future)).toBe(false);
    expect(availableFindingActions(future)).toEqual([]);
  });
});

describe('validateDismissNote', () => {
  it('requires a note — the API rejects a dismiss without one', () => {
    expect(validateDismissNote('')).toEqual({ ok: false, reason: 'required' });
    expect(validateDismissNote('   \n  ')).toEqual({ ok: false, reason: 'required' });
  });

  it('trims an accepted note', () => {
    expect(validateDismissNote('  known false positive  ')).toEqual({
      ok: true,
      notes: 'known false positive',
    });
  });

  it('accepts exactly the maximum length and rejects one over', () => {
    const atMax = 'x'.repeat(DISMISS_NOTES_MAX_LENGTH);
    expect(validateDismissNote(atMax)).toEqual({ ok: true, notes: atMax });
    expect(validateDismissNote(`${atMax}x`)).toEqual({ ok: false, reason: 'too_long' });
  });

  it('measures the trimmed note, not the raw input', () => {
    const atMax = 'x'.repeat(DISMISS_NOTES_MAX_LENGTH);
    expect(validateDismissNote(`  ${atMax}  `)).toEqual({ ok: true, notes: atMax });
  });

  it('pins the maximum to the server schema', () => {
    expect(DISMISS_NOTES_MAX_LENGTH).toBe(2000);
  });
});

describe('labels', () => {
  it('names each action the way the button reads', () => {
    expect(findingActionLabel('acknowledge')).toBe('Acknowledge');
    expect(findingActionLabel('dismiss')).toBe('Dismiss');
    expect(findingActionLabel('reopen')).toBe('Reopen');
  });

  it('names each status', () => {
    expect(findingStatusLabel('open')).toBe('Open');
    expect(findingStatusLabel('acknowledged')).toBe('Acknowledged');
    expect(findingStatusLabel('dismissed')).toBe('Dismissed');
    expect(findingStatusLabel('resolved')).toBe('Resolved');
  });

  it('falls back to the raw value for an unknown status rather than rendering nothing', () => {
    expect(findingStatusLabel('snoozed' as FleetFindingStatus)).toBe('snoozed');
  });

  it('names each severity', () => {
    expect(severityLabel('critical')).toBe('Critical');
    expect(severityLabel('error')).toBe('Error');
    expect(severityLabel('warning')).toBe('Warning');
    expect(severityLabel('info')).toBe('Info');
  });
});

describe('findingSeverityRank', () => {
  it('ranks critical above error above warning above info', () => {
    expect(findingSeverityRank('critical')).toBeGreaterThan(findingSeverityRank('error'));
    expect(findingSeverityRank('error')).toBeGreaterThan(findingSeverityRank('warning'));
    expect(findingSeverityRank('warning')).toBeGreaterThan(findingSeverityRank('info'));
  });

  it('sorts an unknown severity last', () => {
    expect(findingSeverityRank('nonsense' as 'info')).toBe(0);
    expect(findingSeverityRank('info')).toBeGreaterThan(0);
  });
});

describe('findingSeverityTier', () => {
  it('maps each severity onto the shared riskTier band the alert rows use', () => {
    expect(findingSeverityTier('critical')).toBe('critical');
    expect(findingSeverityTier('error')).toBe('high');
    expect(findingSeverityTier('warning')).toBe('medium');
    expect(findingSeverityTier('info')).toBe('low');
  });

  it('falls back to the lowest band for a severity this build does not know', () => {
    expect(findingSeverityTier('nonsense' as FleetFindingSeverity)).toBe('low');
  });
});
