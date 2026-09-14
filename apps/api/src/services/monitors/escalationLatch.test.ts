import { beforeEach, describe, expect, it, vi } from 'vitest';

const {
  createSourcedAlertMock,
  selectMock,
  updateMock,
  capturedUpdateSets,
} = vi.hoisted(() => ({
  createSourcedAlertMock: vi.fn(),
  selectMock: vi.fn(),
  updateMock: vi.fn(),
  capturedUpdateSets: [] as Record<string, unknown>[],
}));

vi.mock('../alertService', () => ({
  createSourcedAlert: createSourcedAlertMock,
}));

vi.mock('../../db', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../db')>()),
  db: { select: selectMock, update: updateMock },
}));

import { escalationSeverityFor, fireEscalationLatch } from './escalationLatch';

const MONITOR = '11111111-1111-4111-8111-111111111111';
const DEVICE = '22222222-2222-4222-8222-222222222222';
const ORG = '33333333-3333-4333-8333-333333333333';
const EPISODE = '44444444-4444-4444-8444-444444444444';

function selectChain<T>(rows: T) {
  const chain = {
    from: () => chain,
    where: () => chain,
    limit: () => chain,
    then: (resolve: (v: T) => unknown, reject?: (e: unknown) => unknown) =>
      Promise.resolve(rows).then(resolve, reject),
  };
  return chain;
}

function updateChain() {
  const chain = {
    set: (values: Record<string, unknown>) => {
      capturedUpdateSets.push(values);
      return chain;
    },
    where: () => chain,
    then: (resolve: (v: unknown) => unknown, reject?: (e: unknown) => unknown) =>
      Promise.resolve([]).then(resolve, reject),
  };
  return chain;
}

function monitor(overrides: Record<string, unknown> = {}) {
  return {
    id: MONITOR,
    name: 'Disk over 80%',
    severity: 'medium',
    recurrenceThreshold: 3,
    recurrenceWindowHours: 72,
    recurrenceActions: [],
    pauseResponsesOnEscalation: true,
    deliveryMode: 'inherit',
    deliveryChannelIds: [],
    escalationPolicyId: null,
    ...overrides,
  } as never;
}

beforeEach(() => {
  capturedUpdateSets.length = 0;
  createSourcedAlertMock.mockReset();
  createSourcedAlertMock.mockResolvedValue('alert-1');
  selectMock.mockReset();
  selectMock.mockImplementation(() => selectChain([{ displayName: 'WS-1', hostname: 'ws-1' }]));
  updateMock.mockReset();
  updateMock.mockImplementation(() => updateChain());
});

describe('escalationSeverityFor', () => {
  it.each([
    ['info', 'high'],
    ['low', 'high'],
    ['medium', 'high'],
    ['high', 'critical'],
    ['critical', 'critical'],
  ] as const)('bumps %s to %s', (input, expected) => {
    expect(escalationSeverityFor(input)).toBe(expected);
  });
});

describe('fireEscalationLatch', () => {
  const input = {
    deviceId: DEVICE,
    orgId: ORG,
    episodeId: EPISODE,
    episodesInWindow: 3,
  };

  it('creates ONE alert with requiresHuman true, the episode id and the monitor id', async () => {
    await fireEscalationLatch({ monitor: monitor(), ...input });

    expect(createSourcedAlertMock).toHaveBeenCalledTimes(1);
    expect(createSourcedAlertMock).toHaveBeenCalledWith(
      expect.objectContaining({
        deviceId: DEVICE,
        orgId: ORG,
        requiresHuman: true,
        episodeId: EPISODE,
        monitorId: MONITOR,
        severity: 'high',
      }),
    );
  });

  it('titles the alert with the monitor, the count, the window and the device', async () => {
    await fireEscalationLatch({ monitor: monitor(), ...input });

    const { title } = createSourcedAlertMock.mock.calls[0]![0];
    expect(title).toBe('Disk over 80% recurred 3 times in 3 days on WS-1');
  });

  it('uses hours in the copy when the window is under a day', async () => {
    await fireEscalationLatch({
      monitor: monitor({ recurrenceWindowHours: 6, recurrenceThreshold: 2 }),
      ...input,
      episodesInWindow: 2,
    });

    const { title } = createSourcedAlertMock.mock.calls[0]![0];
    expect(title).toBe('Disk over 80% recurred 2 times in 6 hours on WS-1');
  });

  it('writes escalation_alert_id back onto monitor_device_state', async () => {
    const result = await fireEscalationLatch({ monitor: monitor(), ...input });

    expect(result.escalationAlertId).toBe('alert-1');
    expect(capturedUpdateSets[0]).toMatchObject({ escalationAlertId: 'alert-1' });
  });

  it('does not write escalation_alert_id when the alert publish was rolled back', async () => {
    createSourcedAlertMock.mockResolvedValue(null);

    const result = await fireEscalationLatch({ monitor: monitor(), ...input });

    expect(result.escalationAlertId).toBeNull();
    expect(capturedUpdateSets).toHaveLength(0);
  });

  it('does not throw when the alert creation itself throws', async () => {
    createSourcedAlertMock.mockRejectedValue(new Error('boom'));

    await expect(fireEscalationLatch({ monitor: monitor(), ...input })).resolves.toEqual({
      escalationAlertId: null,
      recurrenceActionsPending: 0,
    });
  });

  it('reports authored recurrence actions as pending in the alert context', async () => {
    await fireEscalationLatch({
      monitor: monitor({ recurrenceActions: [{ type: 'run_script' }, { type: 'create_ticket' }] }),
      ...input,
    });

    const { context } = createSourcedAlertMock.mock.calls[0]![0];
    expect(context).toMatchObject({
      source: 'monitor_recurrence',
      monitorId: MONITOR,
      episodeId: EPISODE,
      episodesInWindow: 3,
      recurrenceActionsPending: 2,
    });
  });

  it('reports zero pending actions when none are authored', async () => {
    await fireEscalationLatch({ monitor: monitor(), ...input });

    const { context } = createSourcedAlertMock.mock.calls[0]![0];
    expect(context.recurrenceActionsPending).toBe(0);
  });
});
