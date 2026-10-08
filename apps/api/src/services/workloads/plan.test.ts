import { describe, expect, it } from 'vitest';
import {
  workloadReportItemSchema,
  workloadRuntimeReportSchema,
  type WorkloadRuntime,
} from '@breeze/shared';
import {
  planWorkloadSync,
  type StoredWorkload,
  type StoredWorkloadRuntime,
  type WorkloadSyncInput,
} from './plan';

const NOW = new Date('2026-10-06T12:00:00Z');
const hoursAgo = (hours: number) => new Date(NOW.getTime() - hours * 3_600_000);

const item = (workloadId: string, over: Record<string, unknown> = {}) =>
  workloadReportItemSchema.parse({ kind: 'container', workloadId, name: workloadId, state: 'running', ...over });

const runtimeReport = (over: Record<string, unknown> = {}) => {
  const workloads = (over.workloads as unknown[] | undefined) ?? [];
  return workloadRuntimeReportSchema.parse({
    runtime: 'docker',
    detection: 'present',
    collection: 'ok',
    complete: true,
    runtimeVersion: '27.1.1',
    observedCount: workloads.length,
    error: null,
    workloads: [],
    ...over,
  });
};

const storedRow = (id: string, workloadId: string, lastSeenHoursAgo = 0, runtime: WorkloadRuntime = 'docker'): StoredWorkload => ({
  id,
  runtime,
  workloadId,
  lastSeenAt: hoursAgo(lastSeenHoursAgo),
});

const input = (over: Partial<WorkloadSyncInput> = {}): WorkloadSyncInput => ({
  now: NOW,
  collectedAt: NOW,
  runtimes: [],
  storedRuntimes: [],
  storedWorkloads: [],
  isEnabled: () => true,
  previousHostRuntimes: [],
  previousHostsWorkloads: false,
  ...over,
});

const onlyPlan = (over: Partial<WorkloadSyncInput>) => planWorkloadSync(input(over)).runtimes[0]!;

describe('ordering guard', () => {
  it.each([
    ['older', hoursAgo(1)],
    ['equal', NOW],
  ])('skips a runtime whose collectedAt is not newer than the stored one (%s)', (_name, reportedAt) => {
    const stored: StoredWorkloadRuntime = { runtime: 'docker', collectedAt: NOW };
    const plan = planWorkloadSync(
      input({
        collectedAt: reportedAt,
        runtimes: [runtimeReport({ workloads: [item('a')] })],
        storedRuntimes: [stored],
        storedWorkloads: [storedRow('s1', 'gone')],
        previousHostRuntimes: ['docker'],
        previousHostsWorkloads: true,
      }),
    );
    const [docker] = plan.runtimes;
    expect(docker).toMatchObject({ runtime: 'docker', applied: false, collection: null, runtimeRow: null });
    expect(docker!.workloads).toEqual({ updates: [], inserts: [], deleteIds: [] });
    expect(plan.host.changed).toBe(false);
  });

  it('applies a newer report and still applies another runtime in the same report when one is skipped', () => {
    const plan = planWorkloadSync(
      input({
        collectedAt: NOW,
        runtimes: [
          runtimeReport({ runtime: 'docker', detection: 'absent', collection: 'unavailable' }),
          runtimeReport({ runtime: 'hyperv', workloads: [item('vm-1', { kind: 'vm' })] }),
        ],
        storedRuntimes: [{ runtime: 'docker', collectedAt: NOW }],
        storedWorkloads: [storedRow('d1', 'c1')],
        previousHostRuntimes: ['docker'],
        previousHostsWorkloads: true,
      }),
    );
    expect(plan.runtimes.map((r) => [r.runtime, r.applied])).toEqual([['docker', false], ['hyperv', true]]);
    // The skipped docker entry does not drop docker from the host axis even though it said absent.
    expect(plan.host.workloadRuntimes).toEqual(['docker', 'hyperv']);
  });

  it('always applies a runtime that has no stored row', () => {
    expect(onlyPlan({ runtimes: [runtimeReport()] }).applied).toBe(true);
  });
});

describe('effective collection time', () => {
  it('clamps a future-dated collectedAt to receipt time, so a later normal report is still applied', () => {
    const farFuture = new Date(NOW.getTime() + 48 * 3_600_000);
    const first = planWorkloadSync(input({ now: NOW, collectedAt: farFuture, runtimes: [runtimeReport()] }));
    const firstRow = first.runtimes[0]!;
    expect(firstRow.applied).toBe(true);
    expect(firstRow.runtimeRow!.collectedAt).toEqual(NOW);

    const later = new Date(NOW.getTime() + 60 * 60_000);
    const second = planWorkloadSync(
      input({
        now: later,
        collectedAt: later,
        runtimes: [runtimeReport({ workloads: [item('a')] })],
        storedRuntimes: [{ runtime: 'docker', collectedAt: firstRow.runtimeRow!.collectedAt }],
      }),
    );
    expect(second.runtimes[0]!.applied).toBe(true);
  });

  it('compares the clamped time, not the raw future collectedAt, against the stored row', () => {
    const farFuture = new Date(NOW.getTime() + 48 * 3_600_000);
    // Effective time = min(+48 h, NOW) = NOW, equal to the stored row: skipped.
    expect(
      onlyPlan({
        now: NOW,
        collectedAt: farFuture,
        runtimes: [runtimeReport()],
        storedRuntimes: [{ runtime: 'docker', collectedAt: NOW }],
      }).applied,
    ).toBe(false);
    // One second later the clamped time is newer than the stored row: applied.
    expect(
      onlyPlan({
        now: new Date(NOW.getTime() + 1000),
        collectedAt: farFuture,
        runtimes: [runtimeReport()],
        storedRuntimes: [{ runtime: 'docker', collectedAt: NOW }],
      }).applied,
    ).toBe(true);
  });

  it('uses collectedAt when it is not in the future', () => {
    const past = hoursAgo(3);
    const plan = onlyPlan({ collectedAt: past, runtimes: [runtimeReport()] });
    expect(plan.runtimeRow!.collectedAt).toEqual(past);
  });
});

describe('replace-set for an ok and complete snapshot', () => {
  it('upserts the reported rows, keeps ids stable, and deletes only the rows that disappeared', () => {
    const plan = onlyPlan({
      runtimes: [runtimeReport({ workloads: [item('b'), item('c'), item('d')] })],
      storedRuntimes: [{ runtime: 'docker', collectedAt: hoursAgo(1) }],
      storedWorkloads: [storedRow('id-a', 'a'), storedRow('id-b', 'b'), storedRow('id-c', 'c')],
    });
    expect(plan.applied).toBe(true);
    expect(plan.collection).toBe('ok');
    expect(plan.workloads.updates.map((u) => u.id)).toEqual(['id-b', 'id-c']);
    expect(plan.workloads.inserts.map((r) => r.workloadId)).toEqual(['d']);
    expect(plan.workloads.deleteIds).toEqual(['id-a']);
    expect(plan.runtimeRow).toMatchObject({
      runtime: 'docker',
      detection: 'present',
      collection: 'ok',
      complete: true,
      runtimeVersion: '27.1.1',
      observedCount: 3,
      reportedCount: 3,
      lastError: null,
      collectedAt: NOW,
      lastAttemptAt: NOW,
      lastSuccessAt: NOW,
    });
  });

  it('an empty ok-and-complete snapshot deletes every stored row of that runtime only', () => {
    const plan = planWorkloadSync(
      input({
        runtimes: [runtimeReport({ workloads: [] })],
        storedWorkloads: [storedRow('x1', 'a'), storedRow('p1', 'a', 0, 'podman')],
      }),
    );
    expect(plan.runtimes[0]!.workloads.deleteIds).toEqual(['x1']);
  });
});

describe('a failing collection never deletes workloads', () => {
  it.each(['unavailable', 'permission_denied', 'error', 'unsupported'] as const)(
    'collection %s writes the runtime row only and leaves rows and last_success_at alone',
    (collection) => {
      const plan = onlyPlan({
        runtimes: [runtimeReport({ collection, complete: false, error: 'boom', workloads: [] })],
        // s2 is past the 24 h age-out: a failing collection must not age it out either.
        storedWorkloads: [storedRow('s1', 'a'), storedRow('s2', 'b', 30)],
        previousHostRuntimes: ['docker'],
        previousHostsWorkloads: true,
      });
      expect(plan.workloads).toEqual({ updates: [], inserts: [], deleteIds: [] });
      expect(plan.runtimeRow).toMatchObject({
        collection,
        complete: false,
        lastError: 'boom',
        lastSuccessAt: null,
      });
    },
  );

  it('a failing collection that claims complete still deletes nothing', () => {
    const plan = onlyPlan({
      runtimes: [runtimeReport({ collection: 'error', complete: true, observedCount: 0, error: 'boom', workloads: [] })],
      storedWorkloads: [storedRow('s1', 'a'), storedRow('s2', 'b', 30)],
    });
    expect(plan.workloads).toEqual({ updates: [], inserts: [], deleteIds: [] });
  });

  it('stores no error text for an ok collection', () => {
    expect(onlyPlan({ runtimes: [runtimeReport({ error: 'stale text' })] }).runtimeRow!.lastError).toBeNull();
  });
});

describe('truncated snapshots', () => {
  it('age-out: deletes unreported rows not seen for more than 24 h and keeps recent ones', () => {
    const plan = onlyPlan({
      runtimes: [runtimeReport({ complete: false, observedCount: 5, workloads: [item('z')] })],
      storedWorkloads: [storedRow('old', 'x', 25), storedRow('fresh', 'y', 23), storedRow('edge', 'e', 24)],
    });
    expect(plan.workloads.inserts.map((r) => r.workloadId)).toEqual(['z']);
    // exactly 24 h is not "older than 24 h"
    expect(plan.workloads.deleteIds).toEqual(['old']);
  });

  it('retained cap: trims the oldest unreported rows down to 1500 retained', () => {
    const stored = Array.from({ length: 1000 }, (_, i) => ({
      id: `s${String(i).padStart(4, '0')}`,
      runtime: 'docker' as const,
      workloadId: `old-${i}`,
      lastSeenAt: new Date(NOW.getTime() - (i + 1) * 1000),
    }));
    const reported = Array.from({ length: 600 }, (_, i) => item(`new-${i}`));
    const plan = onlyPlan({
      runtimes: [runtimeReport({ complete: false, observedCount: 1200, workloads: reported })],
      storedWorkloads: stored,
    });
    expect(plan.workloads.inserts).toHaveLength(600);
    // 600 reported + 1000 retained = 1600 > 1500: the 100 oldest unreported rows go.
    expect(plan.workloads.deleteIds).toHaveLength(100);
    expect(plan.workloads.deleteIds[0]).toBe('s0900');
    expect(plan.workloads.deleteIds.at(-1)).toBe('s0999');
  });

  it('counts only unaged rows toward the retained cap', () => {
    // 800 aged-out + 800 fresh unreported + 200 reported: the aged rows go by
    // age-out; 800 fresh + 200 reported = 1000 <= 1500, so no fresh row is trimmed.
    const aged = Array.from({ length: 800 }, (_, i) => storedRow(`a${String(i).padStart(4, '0')}`, `aged-${i}`, 30));
    const fresh = Array.from({ length: 800 }, (_, i) => storedRow(`f${String(i).padStart(4, '0')}`, `fresh-${i}`, 1));
    const reported = Array.from({ length: 200 }, (_, i) => item(`new-${i}`));
    const plan = onlyPlan({
      runtimes: [runtimeReport({ complete: false, observedCount: 2000, workloads: reported })],
      storedWorkloads: [...aged, ...fresh],
    });
    expect(plan.workloads.deleteIds).toHaveLength(800);
    expect(plan.workloads.deleteIds.every((id) => id.startsWith('a'))).toBe(true);
  });

  it('breaks a retained-cap tie on equal lastSeenAt by id', () => {
    const sameTime = Array.from({ length: 1501 }, (_, i) => ({
      id: `t${String(1500 - i).padStart(4, '0')}`,
      runtime: 'docker' as const,
      workloadId: `w-${i}`,
      lastSeenAt: hoursAgo(1),
    }));
    const plan = onlyPlan({
      runtimes: [runtimeReport({ complete: false, observedCount: 1501, workloads: [] })],
      storedWorkloads: sameTime,
    });
    expect(plan.workloads.deleteIds).toEqual(['t0000']);
  });

  it('treats observed greater than reported as truncated even when the agent claims complete', () => {
    const plan = onlyPlan({
      runtimes: [runtimeReport({ complete: true, observedCount: 50, workloads: [item('a')] })],
      storedWorkloads: [storedRow('recent', 'b', 1)],
    });
    expect(plan.workloads.deleteIds).toEqual([]);
  });

  it('never deletes a row that the truncated report itself carried', () => {
    const plan = onlyPlan({
      runtimes: [runtimeReport({ complete: false, observedCount: 3, workloads: [item('a')] })],
      storedWorkloads: [storedRow('id-a', 'a', 100)],
    });
    expect(plan.workloads.deleteIds).toEqual([]);
    expect(plan.workloads.updates.map((u) => u.id)).toEqual(['id-a']);
  });
});

describe('policy override', () => {
  it('a disabled runtime is recorded as disabled, its workloads are ignored and stored rows are deleted, but the host axis keeps the runtime', () => {
    const plan = planWorkloadSync(
      input({
        runtimes: [runtimeReport({ workloads: [item('a'), item('b')] })],
        storedWorkloads: [storedRow('s1', 'a'), storedRow('s2', 'z')],
        isEnabled: () => false,
      }),
    );
    const docker = plan.runtimes[0]!;
    expect(docker.collection).toBe('disabled');
    expect(docker.workloads).toEqual({ updates: [], inserts: [], deleteIds: ['s1', 's2'] });
    expect(docker.runtimeRow).toMatchObject({
      detection: 'present',
      collection: 'disabled',
      complete: true,
      observedCount: 0,
      reportedCount: 0,
      lastError: null,
      lastSuccessAt: null,
    });
    expect(plan.host).toEqual({ workloadRuntimes: ['docker'], hostsWorkloads: true, changed: true });
  });

  it('overrides an agent-reported error too, and honors only the per-runtime flag', () => {
    const plan = planWorkloadSync(
      input({
        runtimes: [
          runtimeReport({ runtime: 'docker', collection: 'error', error: 'x' }),
          runtimeReport({ runtime: 'hyperv', workloads: [item('vm', { kind: 'vm' })] }),
        ],
        isEnabled: (runtime) => runtime === 'hyperv',
      }),
    );
    expect(plan.runtimes.map((r) => [r.runtime, r.collection])).toEqual([['docker', 'disabled'], ['hyperv', 'ok']]);
  });

  it('an agent-reported disabled collection behaves like the override', () => {
    const plan = onlyPlan({
      runtimes: [runtimeReport({ collection: 'disabled', complete: true })],
      storedWorkloads: [storedRow('s1', 'a')],
    });
    expect(plan.workloads.deleteIds).toEqual(['s1']);
    expect(plan.runtimeRow).toMatchObject({ collection: 'disabled', observedCount: 0, reportedCount: 0 });
  });

  it('containerd is never enumerated and never policy-disabled', () => {
    const plan = onlyPlan({
      runtimes: [runtimeReport({ runtime: 'containerd', collection: 'unsupported', complete: false })],
      isEnabled: () => false,
    });
    expect(plan.collection).toBe('unsupported');
    expect(plan.workloads).toEqual({ updates: [], inserts: [], deleteIds: [] });
  });
});

describe('host axis', () => {
  it('detection present adds membership and the result is sorted', () => {
    const plan = planWorkloadSync(
      input({
        runtimes: [runtimeReport({ runtime: 'proxmox', workloads: [] }), runtimeReport({ runtime: 'docker', workloads: [] })],
      }),
    );
    expect(plan.host).toEqual({ workloadRuntimes: ['docker', 'proxmox'], hostsWorkloads: true, changed: true });
  });

  it('detection unknown keeps previous membership but still writes the runtime row and leaves workloads alone', () => {
    const plan = planWorkloadSync(
      input({
        runtimes: [runtimeReport({ detection: 'unknown', collection: 'error', complete: false, error: 'socket busy' })],
        storedWorkloads: [storedRow('s1', 'a')],
        previousHostRuntimes: ['docker'],
        previousHostsWorkloads: true,
      }),
    );
    expect(plan.host).toEqual({ workloadRuntimes: ['docker'], hostsWorkloads: true, changed: false });
    expect(plan.runtimes[0]!.runtimeRow).toMatchObject({ detection: 'unknown', collection: 'error' });
    expect(plan.runtimes[0]!.workloads.deleteIds).toEqual([]);
  });

  it('detection unknown does not add a runtime the device never had', () => {
    const plan = planWorkloadSync(input({ runtimes: [runtimeReport({ detection: 'unknown', collection: 'error' })] }));
    expect(plan.host).toEqual({ workloadRuntimes: [], hostsWorkloads: false, changed: false });
  });

  it('detection absent keeps the runtime row as absent, deletes every workload row and drops membership', () => {
    const plan = planWorkloadSync(
      input({
        runtimes: [runtimeReport({ detection: 'absent', collection: 'unavailable' })],
        storedRuntimes: [{ runtime: 'docker', collectedAt: hoursAgo(2) }],
        storedWorkloads: [storedRow('s1', 'a'), storedRow('s2', 'b')],
        previousHostRuntimes: ['docker', 'hyperv'],
        previousHostsWorkloads: true,
      }),
    );
    const docker = plan.runtimes[0]!;
    expect(docker).toMatchObject({
      applied: true,
      collection: 'unavailable',
      runtimeRow: {
        detection: 'absent',
        collection: 'unavailable',
        complete: true,
        observedCount: 0,
        reportedCount: 0,
        lastSuccessAt: null,
        collectedAt: NOW,
      },
    });
    expect(docker.workloads).toEqual({ updates: [], inserts: [], deleteIds: ['s1', 's2'] });
    expect(plan.host).toEqual({ workloadRuntimes: ['hyperv'], hostsWorkloads: true, changed: true });
  });

  it('a first-ever absent report (no stored row) still writes the absent runtime row', () => {
    const plan = onlyPlan({
      runtimes: [runtimeReport({ detection: 'absent', collection: 'unavailable' })],
    });
    expect(plan).toMatchObject({ applied: true, runtimeRow: { detection: 'absent', collectedAt: NOW } });
  });

  it('absent wins over a policy override (the row records what the agent reported, not disabled)', () => {
    const plan = onlyPlan({
      runtimes: [runtimeReport({ detection: 'absent', collection: 'unavailable' })],
      isEnabled: () => false,
    });
    expect(plan.runtimeRow).toMatchObject({ detection: 'absent', collection: 'unavailable' });
  });

  it('a replayed older present report after an absent one is skipped', () => {
    const plan = planWorkloadSync(
      input({
        collectedAt: hoursAgo(1),
        runtimes: [runtimeReport({ detection: 'present', workloads: [item('a')] })],
        storedRuntimes: [{ runtime: 'docker', collectedAt: NOW }], // the absent row's collected_at
        previousHostRuntimes: [],
        previousHostsWorkloads: false,
      }),
    );
    expect(plan.runtimes[0]).toMatchObject({ applied: false, runtimeRow: null });
    expect(plan.host).toEqual({ workloadRuntimes: [], hostsWorkloads: false, changed: false });
  });

  it('a runtime the report does not mention is untouched', () => {
    const plan = planWorkloadSync(
      input({
        runtimes: [runtimeReport({ runtime: 'docker', detection: 'absent', collection: 'unavailable' })],
        previousHostRuntimes: ['docker', 'hyperv'],
        previousHostsWorkloads: true,
      }),
    );
    expect(plan.runtimes).toHaveLength(1);
    expect(plan.host.workloadRuntimes).toEqual(['hyperv']);
  });

  it('containerd detection joins the host axis', () => {
    const plan = planWorkloadSync(
      input({ runtimes: [runtimeReport({ runtime: 'containerd', collection: 'unsupported', complete: false })] }),
    );
    expect(plan.host.workloadRuntimes).toEqual(['containerd']);
  });

  it('heals an inconsistent hosts_workloads flag', () => {
    const plan = planWorkloadSync(
      input({
        runtimes: [runtimeReport({ runtime: 'docker', workloads: [] })],
        previousHostRuntimes: ['docker'],
        previousHostsWorkloads: false,
      }),
    );
    expect(plan.host).toEqual({ workloadRuntimes: ['docker'], hostsWorkloads: true, changed: true });
  });

  it('reports changed = false when membership and flag are already correct', () => {
    const plan = planWorkloadSync(
      input({
        runtimes: [runtimeReport({ runtime: 'docker', workloads: [] })],
        previousHostRuntimes: ['docker'],
        previousHostsWorkloads: true,
      }),
    );
    expect(plan.host.changed).toBe(false);
  });
});
