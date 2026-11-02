import { beforeEach, describe, expect, it, vi } from 'vitest';

const { requestReevaluation } = vi.hoisted(() => ({ requestReevaluation: vi.fn() }));

vi.mock('../jobs/deviceGroupJobs', () => ({
  requestDeviceGroupReevaluationAfterCommit: requestReevaluation,
}));
vi.mock('./commandCancelPropagation', () => ({
  propagateCancelledDeviceCommands: vi.fn(async () => undefined),
}));
vi.mock('./deviceUninstallDrain', () => ({
  queueDeviceUninstall: vi.fn(async () => ({ queued: true, mergedIntoExisting: false })),
}));

import { decommissionDeviceInTransaction } from './deviceDecommission';

const DEV = '11111111-1111-4111-8111-111111111111';
const ORG = '22222222-2222-4222-8222-222222222222';

/** Chainable tx double: the first UPDATE (the device row) returns `updatedRow`; everything else returns no rows. */
function makeTx(updatedRow: Record<string, unknown> | undefined) {
  const chain = (rows: unknown[]) => {
    const c: Record<string, unknown> = {};
    for (const m of ['set', 'from', 'where']) c[m] = () => c;
    c.returning = async () => rows;
    (c as { then: unknown }).then = (resolve: (v: unknown[]) => unknown) => Promise.resolve(rows).then(resolve);
    return c;
  };
  let updates = 0;
  return {
    update: vi.fn(() => (updates++ === 0 ? chain(updatedRow ? [updatedRow] : []) : chain([]))),
    select: vi.fn(() => chain([])),
  } as never;
}

describe('decommissionDeviceInTransaction — dynamic group membership (#9933)', () => {
  beforeEach(() => {
    requestReevaluation.mockReset();
  });

  it('re-evaluates every dynamic group in the device org once the decommission commits', async () => {
    const tx = makeTx({ id: DEV, orgId: ORG, status: 'decommissioned' });

    await decommissionDeviceInTransaction(tx, { deviceId: DEV, queueUninstall: false, actorUserId: null });

    // device.created evaluates ALL of the org's dynamic groups (device.updated
    // only those keyed on a changed field), and the evaluator leaves out
    // decommissioned devices — so this is what drops the stale rows.
    expect(requestReevaluation).toHaveBeenCalledTimes(1);
    expect(requestReevaluation).toHaveBeenCalledWith({
      deviceId: DEV,
      orgId: ORG,
      eventType: 'device.created',
      reason: 'device_decommissioned',
    });
  });

  it('requests nothing when no device row was updated', async () => {
    const tx = makeTx(undefined);

    await decommissionDeviceInTransaction(tx, { deviceId: DEV, queueUninstall: false, actorUserId: null });

    expect(requestReevaluation).not.toHaveBeenCalled();
  });
});
