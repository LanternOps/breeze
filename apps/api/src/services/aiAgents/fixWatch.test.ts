import { describe, expect, it } from 'vitest';
import {
  ALERT_RECURRENCE_WINDOW_MS,
  POSTCONDITION_WINDOW_MS,
  actTargetFingerprint,
  selectFixWatches,
  type FixWatchActRecord,
  type FixWatchRunInput,
} from './fixWatch';

const RUN: FixWatchRunInput = {
  id: 'run-1',
  orgId: 'org-1',
  agentId: 'agent-1',
  deviceId: 'device-1',
  alertId: 'alert-1',
  alertRuleId: 'rule-1',
  alertConfigItemName: 'cpu_high',
  finishedAt: new Date('2026-08-28T12:00:00.000Z'),
};

function act(over: Partial<FixWatchActRecord> = {}): FixWatchActRecord {
  return {
    opKey: 'manage_services.restart',
    verifySpecKind: 'service_running',
    verification: 'passed',
    target: { kind: 'service', serviceName: 'Spooler' },
    ...over,
  };
}

describe('actTargetFingerprint', () => {
  it('is case-insensitive for a service name, so one service maps to one circuit', () => {
    expect(actTargetFingerprint({ kind: 'service', serviceName: 'Spooler' }))
      .toBe(actTargetFingerprint({ kind: 'service', serviceName: 'spooler' }));
  });

  it('distinguishes two different services — a failed restart of A must not implicate B', () => {
    expect(actTargetFingerprint({ kind: 'service', serviceName: 'Spooler' }))
      .not.toBe(actTargetFingerprint({ kind: 'service', serviceName: 'Netlogon' }));
  });

  it('distinguishes two different scripts', () => {
    expect(actTargetFingerprint({ kind: 'script', scriptId: 'a' }))
      .not.toBe(actTargetFingerprint({ kind: 'script', scriptId: 'b' }));
  });

  it('is order-insensitive for disk-cleanup paths but sensitive to the set', () => {
    const ab = actTargetFingerprint({ kind: 'disk_cleanup', paths: ['/a', '/b'] });
    const ba = actTargetFingerprint({ kind: 'disk_cleanup', paths: ['/b', '/a'] });
    const ac = actTargetFingerprint({ kind: 'disk_cleanup', paths: ['/a', '/c'] });
    expect(ab).toBe(ba);
    expect(ab).not.toBe(ac);
  });
});

describe('selectFixWatches', () => {
  it('schedules both lanes for a verified service restart', () => {
    const watches = selectFixWatches(RUN, [act()]);

    expect(watches.map((w) => w.watchKind).sort()).toEqual(['alert_recurrence', 'postcondition']);
    for (const w of watches) {
      expect(w.opKey).toBe('manage_services.restart');
      expect(w.targetFingerprint).toBe(actTargetFingerprint(act().target));
      expect(w.baselineAt).toEqual(RUN.finishedAt);
    }
  });

  it('uses a shorter window for the postcondition re-check than for alert recurrence', () => {
    const watches = selectFixWatches(RUN, [act()]);
    const post = watches.find((w) => w.watchKind === 'postcondition')!;
    const recur = watches.find((w) => w.watchKind === 'alert_recurrence')!;

    expect(post.dueAt.getTime()).toBe(RUN.finishedAt.getTime() + POSTCONDITION_WINDOW_MS);
    expect(recur.dueAt.getTime()).toBe(RUN.finishedAt.getTime() + ALERT_RECURRENCE_WINDOW_MS);
    expect(POSTCONDITION_WINDOW_MS).toBeLessThan(ALERT_RECURRENCE_WINDOW_MS);
  });

  it('schedules ONLY the alert-recurrence lane for an op with no re-readable postcondition', () => {
    // run_script's verify is an exit code — point-in-time, nothing to re-read.
    // The recurrence lane is the only thing that says anything about it at all.
    const watches = selectFixWatches(RUN, [
      act({ opKey: 'run_script', verifySpecKind: 'script_exit_code', target: { kind: 'script', scriptId: 's1' } }),
    ]);

    expect(watches.map((w) => w.watchKind)).toEqual(['alert_recurrence']);
  });

  it('does not schedule a postcondition watch for disk cleanup', () => {
    // disk_usage_improved's verification reads the cleanup command's own
    // status/failedCount and never performs a disk read, so there is no
    // baseline to re-check against (quorum decision 6).
    const watches = selectFixWatches(RUN, [
      act({
        opKey: 'disk_cleanup.execute',
        verifySpecKind: 'disk_usage_improved',
        target: { kind: 'disk_cleanup', paths: ['/tmp'] },
      }),
    ]);

    expect(watches.map((w) => w.watchKind)).toEqual(['alert_recurrence']);
  });

  it('watches nothing for an action whose immediate verification failed', () => {
    // A failed verify already raised its own attention alert and already
    // counts against the circuit — "did it hold" is not the open question.
    expect(selectFixWatches(RUN, [act({ verification: 'failed' })])).toEqual([]);
  });

  it('watches nothing for an inconclusive or skipped verification', () => {
    expect(selectFixWatches(RUN, [act({ verification: 'inconclusive' })])).toEqual([]);
    expect(selectFixWatches(RUN, [act({ verification: 'skipped' })])).toEqual([]);
  });

  it('omits the alert-recurrence lane when the run had no originating alert', () => {
    const watches = selectFixWatches(
      { ...RUN, alertId: null, alertRuleId: null, alertConfigItemName: null },
      [act()],
    );

    expect(watches.map((w) => w.watchKind)).toEqual(['postcondition']);
  });

  it('creates one watch per target, so a two-service run attributes each regression exactly', () => {
    const watches = selectFixWatches(RUN, [
      act({ target: { kind: 'service', serviceName: 'Spooler' } }),
      act({ target: { kind: 'service', serviceName: 'Netlogon' } }),
    ]);

    const recurrences = watches.filter((w) => w.watchKind === 'alert_recurrence');
    expect(recurrences).toHaveLength(2);
    expect(new Set(recurrences.map((w) => w.targetFingerprint)).size).toBe(2);
  });

  it('deduplicates two acts against the SAME target so the unique constraint cannot fire', () => {
    // The model restarting the same service twice in one run is one target,
    // not two — (run_id, watch_kind, target_fingerprint) is unique.
    const watches = selectFixWatches(RUN, [act(), act()]);

    expect(watches.filter((w) => w.watchKind === 'postcondition')).toHaveLength(1);
    expect(watches.filter((w) => w.watchKind === 'alert_recurrence')).toHaveLength(1);
  });

  it('returns nothing for a run with no device', () => {
    expect(selectFixWatches({ ...RUN, deviceId: null }, [act()])).toEqual([]);
  });

  it('carries the captured alert identity, not just the alert FK', () => {
    // The alert row can be resolved or deleted before the watch falls due;
    // recurrence is a question about the identity, not that row.
    const watches = selectFixWatches(RUN, [act()]);
    const recur = watches.find((w) => w.watchKind === 'alert_recurrence')!;

    expect(recur.alertRuleId).toBe('rule-1');
    expect(recur.alertConfigItemName).toBe('cpu_high');
  });

  it('stamps the contract version on every watch it emits', () => {
    for (const w of selectFixWatches(RUN, [act()])) {
      expect(w.contractVersion).toBeGreaterThanOrEqual(1);
    }
  });
});
