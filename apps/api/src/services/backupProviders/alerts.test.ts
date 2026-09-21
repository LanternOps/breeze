import { describe, expect, it } from 'vitest';
import {
  BACKUP_PROVIDER_ALERT_SOURCE,
  PROVIDER_CONDITION_META,
  computeProviderCondition,
  decodeConditionState,
  encodeConditionState,
  nextConditionState,
  type ProviderConditionState,
} from './alerts';

const NOW = new Date('2026-09-15T12:00:00Z');
const hoursAgo = (h: number) => new Date(NOW.getTime() - h * 3600_000);

describe('condition-state codec', () => {
  it('round-trips all three phases', () => {
    const states: ProviderConditionState[] = [
      { phase: 'clear' },
      { phase: 'pending', condition: 'failed' },
      { phase: 'raised', condition: 'completed_with_errors' },
    ];
    for (const state of states) {
      expect(decodeConditionState(encodeConditionState(state))).toEqual(state);
    }
  });

  it('encodes clear as NULL so the column reads empty in SQL', () => {
    expect(encodeConditionState({ phase: 'clear' })).toBeNull();
  });

  it('never exceeds the pending_condition column width (varchar(30))', () => {
    for (const condition of Object.keys(PROVIDER_CONDITION_META) as Array<keyof typeof PROVIDER_CONDITION_META>) {
      expect(encodeConditionState({ phase: 'pending', condition })!.length).toBeLessThanOrEqual(30);
      expect(encodeConditionState({ phase: 'raised', condition })!.length).toBeLessThanOrEqual(30);
    }
  });

  it('decodes an unrecognised value as clear rather than throwing', () => {
    expect(decodeConditionState('raised:nonsense')).toEqual({ phase: 'clear' });
    expect(decodeConditionState('nonsense')).toEqual({ phase: 'clear' });
    expect(decodeConditionState(null)).toEqual({ phase: 'clear' });
  });
});

describe('computeProviderCondition', () => {
  const cases: Array<[string, Parameters<typeof computeProviderCondition>[0], string | null]> = [
    ['failed', { status: 'failed', lastSuccessAt: hoursAgo(1), errorsCount: 3 }, 'failed'],
    ['over_quota', { status: 'over_quota', lastSuccessAt: hoursAgo(1), errorsCount: 0 }, 'over_quota'],
    ['no_selection', { status: 'no_selection', lastSuccessAt: null, errorsCount: 0 }, 'no_selection'],
    ['no_backups', { status: 'no_backups', lastSuccessAt: null, errorsCount: 0 }, 'no_backups'],
    ['completed_with_errors', { status: 'completed_with_errors', lastSuccessAt: hoursAgo(1), errorsCount: 2 }, 'completed_with_errors'],
    ['interrupted folds into completed_with_errors', { status: 'interrupted', lastSuccessAt: hoursAgo(1), errorsCount: 0 }, 'completed_with_errors'],
    ['completed, fresh success', { status: 'completed', lastSuccessAt: hoursAgo(2), errorsCount: 0 }, null],
    ['completed, 30h old success', { status: 'completed', lastSuccessAt: hoursAgo(30), errorsCount: 0 }, null],
    ['completed, 60h old success', { status: 'completed', lastSuccessAt: hoursAgo(60), errorsCount: 0 }, 'stale'],
    ['completed, never succeeded', { status: 'completed', lastSuccessAt: null, errorsCount: 0 }, 'stale'],
    ['in_progress, fresh success', { status: 'in_progress', lastSuccessAt: hoursAgo(3), errorsCount: 0 }, null],
    ['not_started, 60h old success', { status: 'not_started', lastSuccessAt: hoursAgo(60), errorsCount: 0 }, 'stale'],
    ['unknown, fresh success', { status: 'unknown', lastSuccessAt: hoursAgo(3), errorsCount: 0 }, null],
  ];

  it.each(cases)('%s', (_label, input, expected) => {
    expect(computeProviderCondition(input, NOW)).toBe(expected);
  });

  it('prefers the session-status condition over stale when both hold', () => {
    expect(computeProviderCondition({ status: 'failed', lastSuccessAt: null, errorsCount: 1 }, NOW)).toBe('failed');
  });
});

describe('nextConditionState (two-poll hysteresis)', () => {
  it('first observation stores pending and raises nothing', () => {
    expect(nextConditionState({ phase: 'clear' }, 'failed')).toEqual({
      next: { phase: 'pending', condition: 'failed' },
      raise: false,
      recoveredFrom: null,
    });
  });

  it('second consecutive observation raises', () => {
    expect(nextConditionState({ phase: 'pending', condition: 'failed' }, 'failed')).toEqual({
      next: { phase: 'raised', condition: 'failed' },
      raise: true,
      recoveredFrom: null,
    });
  });

  it('a third consecutive observation holds and raises nothing again', () => {
    expect(nextConditionState({ phase: 'raised', condition: 'failed' }, 'failed')).toEqual({
      next: { phase: 'raised', condition: 'failed' },
      raise: false,
      recoveredFrom: null,
    });
  });

  it('clears on the FIRST poll where the condition no longer holds, and reports recovery', () => {
    expect(nextConditionState({ phase: 'raised', condition: 'failed' }, null)).toEqual({
      next: { phase: 'clear' },
      raise: false,
      recoveredFrom: 'failed',
    });
  });

  it('clearing a merely-pending condition reports no recovery (nothing was ever announced)', () => {
    expect(nextConditionState({ phase: 'pending', condition: 'failed' }, null)).toEqual({
      next: { phase: 'clear' },
      raise: false,
      recoveredFrom: null,
    });
  });

  it('a changed condition recovers the old one and re-starts hysteresis for the new one', () => {
    expect(nextConditionState({ phase: 'raised', condition: 'failed' }, 'stale')).toEqual({
      next: { phase: 'pending', condition: 'stale' },
      raise: false,
      recoveredFrom: 'failed',
    });
  });
});

describe('PROVIDER_CONDITION_META', () => {
  it('matches the spec severity/title table', () => {
    expect(PROVIDER_CONDITION_META.failed.severity).toBe('high');
    expect(PROVIDER_CONDITION_META.over_quota.severity).toBe('high');
    expect(PROVIDER_CONDITION_META.no_selection.severity).toBe('medium');
    expect(PROVIDER_CONDITION_META.no_backups.severity).toBe('high');
    expect(PROVIDER_CONDITION_META.completed_with_errors.severity).toBe('medium');
    expect(PROVIDER_CONDITION_META.stale.severity).toBe('high');
    expect(PROVIDER_CONDITION_META.failed.title('SRV-01')).toBe('Backup failed on SRV-01');
    expect(PROVIDER_CONDITION_META.over_quota.title('SRV-01')).toBe('Backup over quota on SRV-01');
    expect(PROVIDER_CONDITION_META.no_selection.title('SRV-01')).toBe('Backup has nothing selected on SRV-01');
    expect(PROVIDER_CONDITION_META.no_backups.title('SRV-01')).toBe('No backups recorded for SRV-01');
    expect(PROVIDER_CONDITION_META.completed_with_errors.title('SRV-01')).toBe('Backup completed with errors on SRV-01');
    expect(PROVIDER_CONDITION_META.stale.title('SRV-01')).toBe('No successful backup in 48 hours on SRV-01');
  });

  it('keeps every title inside the alerts.title column width (varchar(500))', () => {
    const longName = 'x'.repeat(255);
    for (const meta of Object.values(PROVIDER_CONDITION_META)) {
      expect(meta.title(longName).length).toBeLessThanOrEqual(500);
    }
  });
});

describe('BACKUP_PROVIDER_ALERT_SOURCE', () => {
  it('is the literal the dedupe query and the plan index both key on', () => {
    expect(BACKUP_PROVIDER_ALERT_SOURCE).toBe('backup_provider');
  });
});
