import { expect, it } from 'vitest';
import { buildDeviceWorkloadsView } from './view';

const T = new Date('2026-10-06T12:00:00Z');
const runtimeRow = (over: Record<string, unknown> = {}) =>
  ({
    id: 'r1',
    deviceId: 'd1',
    orgId: 'o1',
    runtime: 'docker',
    detection: 'present',
    collection: 'ok',
    complete: true,
    runtimeVersion: '27.1.1',
    observedCount: 2,
    reportedCount: 2,
    lastError: null,
    collectedAt: T,
    lastAttemptAt: T,
    lastSuccessAt: T,
    updatedAt: T,
    ...over,
  }) as never;
const workloadRow = (over: Record<string, unknown> = {}) =>
  ({
    id: 'w1',
    deviceId: 'd1',
    orgId: 'o1',
    runtime: 'docker',
    kind: 'container',
    workloadId: 'a',
    name: 'web',
    state: 'running',
    rawState: null,
    imageRef: null,
    imageRepository: null,
    imageTag: null,
    imageDigest: null,
    imageId: null,
    guestOs: null,
    composeProject: null,
    composeService: null,
    composeWorkingDir: null,
    restartPolicy: null,
    cpuCount: null,
    memoryMb: null,
    startedAt: null,
    runtimeCreatedAt: null,
    firstSeenAt: T,
    lastSeenAt: T,
    updatedAt: T,
    ...over,
  }) as never;

it('returns exactly capability, runtimes and workloads, with ISO timestamps and no tenant ids', () => {
  const view = buildDeviceWorkloadsView(1, [runtimeRow()], [workloadRow({ startedAt: T })]);
  expect(Object.keys(view).sort()).toEqual(['capability', 'runtimes', 'workloads']);
  expect(view.runtimes[0]).toMatchObject({
    runtime: 'docker',
    collectedAt: '2026-10-06T12:00:00.000Z',
    lastSuccessAt: '2026-10-06T12:00:00.000Z',
  });
  expect(view.workloads[0]).toMatchObject({ startedAt: '2026-10-06T12:00:00.000Z', runtimeCreatedAt: null });
  for (const row of [...view.runtimes, ...view.workloads]) {
    expect(row).not.toHaveProperty('deviceId');
    expect(row).not.toHaveProperty('orgId');
    expect(row).not.toHaveProperty('updatedAt');
  }
});

it('sorts workloads by runtime, then state, then name, then workloadId', () => {
  const view = buildDeviceWorkloadsView(
    1,
    [],
    [
      workloadRow({ id: '1', runtime: 'proxmox', kind: 'vm', state: 'running', name: 'b', workloadId: '2' }),
      workloadRow({ id: '2', runtime: 'docker', state: 'stopped', name: 'a', workloadId: '3' }),
      workloadRow({ id: '3', runtime: 'docker', state: 'running', name: 'z', workloadId: '4' }),
      workloadRow({ id: '4', runtime: 'docker', state: 'running', name: 'a', workloadId: '6' }),
      workloadRow({ id: '5', runtime: 'docker', state: 'running', name: 'a', workloadId: '5' }),
    ],
  );
  expect(view.workloads.map((w) => w.id)).toEqual(['5', '4', '3', '2', '1']);
});

it('sorts runtimes by name', () => {
  const view = buildDeviceWorkloadsView(1, [runtimeRow({ runtime: 'proxmox' }), runtimeRow({ runtime: 'docker' })], []);
  expect(view.runtimes.map((r) => r.runtime)).toEqual(['docker', 'proxmox']);
});

it.each([
  [0, 0],
  [1, 1],
  [2, 1],
  [-1, 0],
])('normalizes stored capability %s to %s', (stored, expected) => {
  expect(buildDeviceWorkloadsView(stored, [], []).capability).toBe(expected);
});
