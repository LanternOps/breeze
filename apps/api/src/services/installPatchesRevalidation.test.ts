import { beforeEach, describe, expect, it, vi } from 'vitest';

const { resolveMock, registerMock, contextMock } = vi.hoisted(() => ({
  resolveMock: vi.fn(),
  registerMock: vi.fn(),
  contextMock: vi.fn(),
}));

vi.mock('../db', () => ({
  getCurrentDbAccessContext: () => contextMock(),
}));

vi.mock('./patchEligibility', () => ({
  resolvePatchInstallEligibility: (...a: unknown[]) => resolveMock(...(a as [])),
}));
vi.mock('./commandClaimEligibility', () => ({
  registerCommandRevalidation: (...a: unknown[]) => registerMock(...(a as [])),
}));
vi.mock('../db/schema', () => ({
  patchJobs: { id: 'patch_jobs.id', orgId: 'patch_jobs.org_id', patches: 'patch_jobs.patches' },
}));

import {
  REQUESTED_PATCHES_NO_LONGER_ELIGIBLE,
  revalidateInstallPatchesForDelivery,
} from './installPatchesRevalidation';

const P1 = '11111111-1111-4111-8111-111111111111';
const P2 = '22222222-2222-4222-8222-222222222222';
const P3 = '33333333-3333-4333-8333-333333333333';
const ORG = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const JOB = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
const DEVICE = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc';

/** A reader whose one `select … limit` resolves to `jobRows`; records whether it was used. */
function reader(jobRows: unknown[]) {
  const limit = vi.fn(async () => jobRows);
  const select = vi.fn(() => ({ from: () => ({ where: () => ({ limit }) }) }));
  return { reader: { select } as never, select };
}

function row(payload: unknown) {
  return { id: 'cmd-1', type: 'install_patches', deviceId: DEVICE, payload, createdBy: null };
}

function verdict(eligible: string[], ineligible: string[] = []) {
  return {
    eligible: eligible.map((patchId) => ({ patchId })),
    ineligible: ineligible.map((patchId) => ({ patchId, reason: 'declined' })),
    ringId: null,
    resolvedAt: new Date().toISOString(),
  };
}

describe('install_patches delivery revalidation (#12493)', () => {
  beforeEach(() => {
    resolveMock.mockReset();
    // The agent heartbeat's context: org-scoped, partner axis set.
    contextMock.mockReturnValue({ scope: 'organization', currentPartnerId: 'partner-1' });
  });

  it('registers itself for install_patches at module load', () => {
    expect(registerMock).toHaveBeenCalledWith('install_patches', revalidateInstallPatchesForDelivery);
  });

  it('an install with no patchJobId (a technician\'s install, vulnerability remediation) is delivered without a read', async () => {
    const { reader: r, select } = reader([]);
    expect(await revalidateInstallPatchesForDelivery(r, row({ patchIds: [P1] }))).toBeNull();
    expect(await revalidateInstallPatchesForDelivery(r, row(null))).toBeNull();
    expect(select).not.toHaveBeenCalled();
    expect(resolveMock).not.toHaveBeenCalled();
  });

  it('a job without patches.patchIds (scheduled / ring / config-policy) is delivered without re-judging', async () => {
    const { reader: r } = reader([{ orgId: ORG, patches: { ringId: 'r1' } }]);
    expect(await revalidateInstallPatchesForDelivery(r, row({ patchJobId: JOB, patchIds: [P1] }))).toBeNull();
    expect(resolveMock).not.toHaveBeenCalled();
  });

  it('a patchJobId whose job cannot be read throws, so the claim holds the row (fail closed)', async () => {
    const { reader: r } = reader([]);
    await expect(revalidateInstallPatchesForDelivery(r, row({ patchJobId: JOB, patchIds: [P1] }))).rejects.toThrow(
      /patch job .* is not readable/,
    );
    expect(resolveMock).not.toHaveBeenCalled();
  });

  it('every delivered patch still eligible → delivered; judged under the job org for exactly the delivered ids', async () => {
    resolveMock.mockResolvedValue(verdict([P1, P2]));
    const { reader: r } = reader([{ orgId: ORG, patches: { patchIds: [P1, P2] } }]);

    expect(await revalidateInstallPatchesForDelivery(r, row({ patchJobId: JOB, patchIds: [P2, P1] }))).toBeNull();
    expect(resolveMock).toHaveBeenCalledWith({ deviceId: DEVICE, orgId: ORG, patchIds: [P1, P2] });
  });

  it('any delivered patch no longer eligible → the whole command is cancelled, naming only the dropped ids', async () => {
    resolveMock.mockResolvedValue(verdict([P1], [P2]));
    const { reader: r } = reader([{ orgId: ORG, patches: { patchIds: [P1, P2] } }]);

    expect(await revalidateInstallPatchesForDelivery(r, row({ patchJobId: JOB, patchIds: [P1, P2] }))).toEqual({
      cancel: REQUESTED_PATCHES_NO_LONGER_ELIGIBLE,
      detail: { ineligiblePatchIds: [P2] },
    });
  });

  it('ids carried only in payload.patches are judged too', async () => {
    resolveMock.mockResolvedValue(verdict([P1]));
    const { reader: r } = reader([{ orgId: ORG, patches: { patchIds: [P1, P2] } }]);

    const result = await revalidateInstallPatchesForDelivery(
      r,
      row({ patchJobId: JOB, patchIds: [P1], patches: [{ id: P1 }, { id: P2 }] }),
    );

    expect(resolveMock).toHaveBeenCalledWith({ deviceId: DEVICE, orgId: ORG, patchIds: [P1, P2] });
    expect(result).toEqual({ cancel: REQUESTED_PATCHES_NO_LONGER_ELIGIBLE, detail: { ineligiblePatchIds: [P2] } });
  });

  it('a delivered id the job never named is cancelled without consulting eligibility', async () => {
    const { reader: r } = reader([{ orgId: ORG, patches: { patchIds: [P1] } }]);

    expect(await revalidateInstallPatchesForDelivery(r, row({ patchJobId: JOB, patchIds: [P1, P3] }))).toEqual({
      cancel: REQUESTED_PATCHES_NO_LONGER_ELIGIBLE,
      detail: { ineligiblePatchIds: [P3] },
    });
    expect(resolveMock).not.toHaveBeenCalled();
  });

  it('a malformed job list or an empty delivered set is refused whole', async () => {
    const malformed = reader([{ orgId: ORG, patches: { patchIds: 'not-a-list' } }]).reader;
    expect(await revalidateInstallPatchesForDelivery(malformed, row({ patchJobId: JOB, patchIds: [P1] }))).toEqual({
      cancel: REQUESTED_PATCHES_NO_LONGER_ELIGIBLE,
      detail: { ineligiblePatchIds: [P1] },
    });
    const listed = reader([{ orgId: ORG, patches: { patchIds: [P1] } }]).reader;
    expect(await revalidateInstallPatchesForDelivery(listed, row({ patchJobId: JOB }))).toEqual({
      cancel: REQUESTED_PATCHES_NO_LONGER_ELIGIBLE,
      detail: { ineligiblePatchIds: [] },
    });
    expect(resolveMock).not.toHaveBeenCalled();
  });

  it('a claim context without the partner axis is held, not judged on rows it cannot see', async () => {
    const { reader: r } = reader([{ orgId: ORG, patches: { patchIds: [P1] } }]);
    for (const ctx of [undefined, { scope: 'organization', currentPartnerId: null }]) {
      contextMock.mockReturnValue(ctx);
      await expect(revalidateInstallPatchesForDelivery(r, row({ patchJobId: JOB, patchIds: [P1] }))).rejects.toThrow(
        /cannot read partner-wide patch policy/,
      );
    }
    expect(resolveMock).not.toHaveBeenCalled();
    // System scope (the push leg) is judged.
    contextMock.mockReturnValue({ scope: 'system', currentPartnerId: null });
    resolveMock.mockResolvedValue(verdict([P1]));
    expect(await revalidateInstallPatchesForDelivery(r, row({ patchJobId: JOB, patchIds: [P1] }))).toBeNull();
  });

  it('a resolver fault propagates (held by the caller), never read as eligible', async () => {
    resolveMock.mockRejectedValue(new Error('connection reset'));
    const { reader: r } = reader([{ orgId: ORG, patches: { patchIds: [P1] } }]);
    await expect(revalidateInstallPatchesForDelivery(r, row({ patchJobId: JOB, patchIds: [P1] }))).rejects.toThrow(
      'connection reset',
    );
  });
});
