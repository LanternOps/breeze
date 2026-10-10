import { describe, expect, it } from 'vitest';
import {
  WORKLOAD_INVENTORY_DEFAULTS,
  isWorkloadRuntimeEnabled,
  workloadInventoryInlineSettingsSchema,
  workloadsReportSchema,
} from './workloads';

const workload = (over: Record<string, unknown> = {}) => ({
  kind: 'container',
  workloadId: 'a'.repeat(64),
  name: 'web',
  state: 'running',
  ...over,
});
const runtime = (over: Record<string, unknown> = {}) => ({
  runtime: 'docker',
  detection: 'present',
  collection: 'ok',
  complete: true,
  runtimeVersion: '27.1.1',
  observedCount: 1,
  error: null,
  workloads: [workload()],
  ...over,
});
const report = (over: Record<string, unknown> = {}) => ({
  protocolVersion: 1,
  collectedAt: '2026-10-06T12:00:00Z',
  runtimes: [runtime()],
  ...over,
});

describe('workloadsReportSchema', () => {
  it('accepts a minimal report and normalizes absent optional columns to null', () => {
    const parsed = workloadsReportSchema.parse(report());
    const item = parsed.runtimes[0]!.workloads[0]!;
    expect(item).toMatchObject({
      kind: 'container',
      name: 'web',
      state: 'running',
      rawState: null,
      imageRef: null,
      imageDigest: null,
      composeProject: null,
      startedAt: null,
      cpuCount: null,
      memoryMb: null,
    });
  });

  it('accepts an offset timestamp as well as Z', () => {
    expect(
      workloadsReportSchema.safeParse(report({ collectedAt: '2026-10-06T08:00:00-04:00' })).success,
    ).toBe(true);
  });

  it('rejects an unknown key at every level (the field allowlist is enforced here, not only in the agent)', () => {
    expect(workloadsReportSchema.safeParse({ ...report(), extra: 1 }).success).toBe(false);
    expect(workloadsReportSchema.safeParse(report({ runtimes: [runtime({ extra: 1 })] })).success).toBe(false);
    for (const forbidden of ['env', 'command', 'entrypoint', 'args', 'mounts', 'volumes', 'ports', 'networks', 'labels']) {
      const result = workloadsReportSchema.safeParse(
        report({ runtimes: [runtime({ workloads: [workload({ [forbidden]: ['x'] })] })] }),
      );
      expect(result.success, `${forbidden} must be rejected`).toBe(false);
    }
  });

  it('rejects an unsupported protocol version and a missing collectedAt', () => {
    expect(workloadsReportSchema.safeParse(report({ protocolVersion: 2 })).success).toBe(false);
    const { collectedAt: _omit, ...rest } = report();
    expect(workloadsReportSchema.safeParse(rest).success).toBe(false);
  });

  it('bounds every string at its column length', () => {
    const tooLong: Array<[string, number]> = [
      ['workloadId', 129],
      ['name', 256],
      ['rawState', 41],
      ['imageRef', 513],
      ['imageRepository', 401],
      ['imageTag', 129],
      ['imageDigest', 81],
      ['imageId', 81],
      ['guestOs', 129],
      ['composeProject', 129],
      ['composeService', 129],
      ['composeWorkingDir', 513],
      ['restartPolicy', 31],
    ];
    for (const [field, length] of tooLong) {
      const result = workloadsReportSchema.safeParse(
        report({ runtimes: [runtime({ workloads: [workload({ [field]: 'x'.repeat(length) })] })] }),
      );
      expect(result.success, `${field} at ${length}`).toBe(false);
    }
    expect(workloadsReportSchema.safeParse(report({ runtimes: [runtime({ runtimeVersion: 'x'.repeat(65) })] })).success).toBe(false);
    expect(workloadsReportSchema.safeParse(report({ runtimes: [runtime({ error: 'x'.repeat(501) })] })).success).toBe(false);
  });

  it('caps a runtime at 1000 workloads and a report at 5 runtimes', () => {
    const many = (n: number) =>
      Array.from({ length: n }, (_, i) => workload({ workloadId: `w${i}` }));
    expect(workloadsReportSchema.safeParse(report({ runtimes: [runtime({ workloads: many(1000), observedCount: 1000 })] })).success).toBe(true);
    expect(workloadsReportSchema.safeParse(report({ runtimes: [runtime({ workloads: many(1001), observedCount: 1001 })] })).success).toBe(false);
    const six = ['docker', 'podman', 'hyperv', 'proxmox', 'containerd', 'docker'].map((r) =>
      runtime({ runtime: r, workloads: [], observedCount: 0 }),
    );
    expect(workloadsReportSchema.safeParse(report({ runtimes: six })).success).toBe(false);
  });

  it('rejects a duplicate runtime entry', () => {
    const result = workloadsReportSchema.safeParse(report({ runtimes: [runtime(), runtime()] }));
    expect(result.success).toBe(false);
  });

  it('rejects a duplicate workloadId within one runtime but allows the same id under another runtime', () => {
    const dup = workloadsReportSchema.safeParse(
      report({
        runtimes: [runtime({ workloads: [workload(), workload()], observedCount: 2 })],
      }),
    );
    expect(dup.success).toBe(false);
    const cross = workloadsReportSchema.safeParse(
      report({
        runtimes: [
          runtime(),
          runtime({ runtime: 'podman' }),
        ],
      }),
    );
    expect(cross.success).toBe(true);
  });

  it('requires the workload kind to fit the runtime', () => {
    expect(
      workloadsReportSchema.safeParse(
        report({ runtimes: [runtime({ runtime: 'hyperv', workloads: [workload({ kind: 'container' })] })] }),
      ).success,
    ).toBe(false);
    expect(
      workloadsReportSchema.safeParse(
        report({ runtimes: [runtime({ runtime: 'proxmox', workloads: [workload({ kind: 'lxc' }), workload({ workloadId: '101', kind: 'vm' })], observedCount: 2 })] }),
      ).success,
    ).toBe(true);
  });

  it('allows containerd only as detection with no workloads', () => {
    expect(
      workloadsReportSchema.safeParse(
        report({ runtimes: [runtime({ runtime: 'containerd', collection: 'unsupported', workloads: [], observedCount: 0 })] }),
      ).success,
    ).toBe(true);
    expect(
      workloadsReportSchema.safeParse(
        report({ runtimes: [runtime({ runtime: 'containerd', workloads: [workload()] })] }),
      ).success,
    ).toBe(false);
  });

  it('accepts an ok collection only for a present, enumerated runtime', () => {
    // An ok snapshot is authoritative (it reconciles by absence), so it must come
    // from a runtime that is installed and actually enumerated.
    for (const detection of ['unknown', 'absent']) {
      expect(
        workloadsReportSchema.safeParse(report({ runtimes: [runtime({ detection, workloads: [], observedCount: 0 })] })).success,
        `${detection} + ok`,
      ).toBe(false);
    }
    expect(
      workloadsReportSchema.safeParse(
        report({ runtimes: [runtime({ runtime: 'containerd', collection: 'ok', workloads: [], observedCount: 0 })] }),
      ).success,
    ).toBe(false);
    expect(
      workloadsReportSchema.safeParse(
        report({ runtimes: [runtime({ detection: 'absent', collection: 'unavailable', workloads: [], observedCount: 0 })] }),
      ).success,
    ).toBe(true);
  });

  it('rejects a NUL character in any reported string (Postgres cannot store it)', () => {
    for (const field of ['workloadId', 'name', 'rawState', 'imageRef', 'guestOs', 'composeProject']) {
      const result = workloadsReportSchema.safeParse(
        report({ runtimes: [runtime({ workloads: [workload({ [field]: 'a\u0000b' })] })] }),
      );
      expect(result.success, field).toBe(false);
    }
    expect(
      workloadsReportSchema.safeParse(report({ runtimes: [runtime({ collection: 'error', error: 'a\u0000b', workloads: [], observedCount: 0 })] })).success,
    ).toBe(false);
    expect(workloadsReportSchema.safeParse(report({ runtimes: [runtime({ runtimeVersion: 'a\u0000' })] })).success).toBe(false);
  });

  it('rejects out-of-vocabulary values', () => {
    expect(workloadsReportSchema.safeParse(report({ runtimes: [runtime({ detection: 'maybe' })] })).success).toBe(false);
    expect(workloadsReportSchema.safeParse(report({ runtimes: [runtime({ collection: 'partial' })] })).success).toBe(false);
    expect(workloadsReportSchema.safeParse(report({ runtimes: [runtime({ workloads: [workload({ state: 'exited' })] })] })).success).toBe(false);
    expect(workloadsReportSchema.safeParse(report({ runtimes: [runtime({ runtime: 'lxd' })] })).success).toBe(false);
  });
});

describe('workloadInventoryInlineSettingsSchema', () => {
  it('defaults to disabled with every runtime allowed and a 60 minute interval', () => {
    expect(workloadInventoryInlineSettingsSchema.parse({})).toEqual(WORKLOAD_INVENTORY_DEFAULTS);
    expect(WORKLOAD_INVENTORY_DEFAULTS).toEqual({
      enabled: false,
      dockerEnabled: true,
      podmanEnabled: true,
      hypervEnabled: true,
      proxmoxEnabled: true,
      intervalMinutes: 60,
    });
  });

  it.each([
    [14, false],
    [15, true],
    [1440, true],
    [1441, false],
    [60.5, false],
  ])('interval %s -> valid=%s', (intervalMinutes, valid) => {
    expect(workloadInventoryInlineSettingsSchema.safeParse({ intervalMinutes }).success).toBe(valid);
  });

  it('rejects unknown keys', () => {
    expect(workloadInventoryInlineSettingsSchema.safeParse({ enabled: true, extra: 1 }).success).toBe(false);
  });

  it('enables a runtime only when the feature and the runtime flag are both on; containerd is never enumerated', () => {
    const on = workloadInventoryInlineSettingsSchema.parse({ enabled: true, podmanEnabled: false });
    expect(isWorkloadRuntimeEnabled(on, 'docker')).toBe(true);
    expect(isWorkloadRuntimeEnabled(on, 'podman')).toBe(false);
    expect(isWorkloadRuntimeEnabled(on, 'hyperv')).toBe(true);
    expect(isWorkloadRuntimeEnabled(on, 'proxmox')).toBe(true);
    expect(isWorkloadRuntimeEnabled(on, 'containerd')).toBe(false);
    const off = workloadInventoryInlineSettingsSchema.parse({ enabled: false });
    expect(isWorkloadRuntimeEnabled(off, 'docker')).toBe(false);
  });
});
