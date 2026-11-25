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
  organizations: { id: 'organizations.id', partnerId: 'organizations.partner_id' },
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
const PARTNER = 'dddddddd-dddd-4ddd-8ddd-dddddddddddd';

/**
 * A reader whose successive `select … limit` calls resolve to `results` in
 * order: the patch job, then (outside system scope) the job org's partner.
 */
function reader(job: unknown[], org: unknown[] = [{ partnerId: PARTNER }]) {
  const queue = [job, org];
  const limit = vi.fn(async () => queue.shift() ?? []);
  const select = vi.fn(() => ({ from: () => ({ where: () => ({ limit }) }) }));
  return { reader: { select } as never, select };
}

function row(payload: unknown) {
  return { id: 'cmd-1', type: 'install_patches', deviceId: DEVICE, payload, createdBy: null };
}

function verdict(eligible: string[], ineligible: Array<[string, string]> = []) {
  return {
    eligible: eligible.map((patchId) => ({ patchId })),
    ineligible: ineligible.map(([patchId, reason]) => ({ patchId, reason })),
    ringId: null,
    resolvedAt: new Date().toISOString(),
  };
}

function cancelled(reasons: Record<string, string>, extra: Record<string, unknown> = {}) {
  const ids = Object.keys(reasons).sort();
  return {
    cancel: REQUESTED_PATCHES_NO_LONGER_ELIGIBLE,
    recordReasonOnOwner: true,
    detail: { ineligiblePatchIds: ids, reasons, ...extra },
  };
}

describe('install_patches delivery revalidation (#12493)', () => {
  beforeEach(() => {
    resolveMock.mockReset();
    // The agent heartbeat's context: org-scoped, partner axis = the device org's partner.
    contextMock.mockReturnValue({ scope: 'organization', currentPartnerId: PARTNER });
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

  it('a patchJobId that is not a uuid is held, not looked up and not delivered', async () => {
    for (const bad of ['', '  ', 'job-1', 42]) {
      const { reader: r, select } = reader([]);
      await expect(revalidateInstallPatchesForDelivery(r, row({ patchJobId: bad, patchIds: [P1] }))).rejects.toThrow(
        /not a uuid/,
      );
      expect(select).not.toHaveBeenCalled();
    }
  });

  it('a job without patches.patchIds (scheduled / ring / config-policy) is delivered without re-judging', async () => {
    const { reader: r } = reader([{ orgId: ORG, patches: { ringId: 'r1' } }]);
    expect(await revalidateInstallPatchesForDelivery(r, row({ patchJobId: JOB, patchIds: [P1] }))).toBeNull();
    expect(resolveMock).not.toHaveBeenCalled();
  });

  it('a job whose patches snapshot is not an object is held, not read as "no list"', async () => {
    for (const patches of [null, [P1], 'x']) {
      const { reader: r } = reader([{ orgId: ORG, patches }]);
      await expect(revalidateInstallPatchesForDelivery(r, row({ patchJobId: JOB, patchIds: [P1] }))).rejects.toThrow(
        /malformed patches snapshot/,
      );
    }
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

  it('any delivered patch no longer eligible → the whole command is cancelled, naming the dropped ids and why', async () => {
    resolveMock.mockResolvedValue(verdict([P1], [[P2, 'declined']]));
    const { reader: r } = reader([{ orgId: ORG, patches: { patchIds: [P1, P2] } }]);

    expect(await revalidateInstallPatchesForDelivery(r, row({ patchJobId: JOB, patchIds: [P1, P2] }))).toEqual(
      cancelled({ [P2]: 'declined' }),
    );
  });

  it('ids carried only in payload.patches are judged too', async () => {
    resolveMock.mockResolvedValue(verdict([P1], [[P2, 'blocked_by_app_rule']]));
    const { reader: r } = reader([{ orgId: ORG, patches: { patchIds: [P1, P2] } }]);

    const result = await revalidateInstallPatchesForDelivery(
      r,
      row({ patchJobId: JOB, patchIds: [P1], patches: [{ id: P1 }, { id: P2 }] }),
    );

    expect(resolveMock).toHaveBeenCalledWith({ deviceId: DEVICE, orgId: ORG, patchIds: [P1, P2] });
    expect(result).toEqual(cancelled({ [P2]: 'blocked_by_app_rule' }));
  });

  it('a delivered id the job never named is cancelled without consulting eligibility; non-uuid text never reaches the detail', async () => {
    const { reader: r } = reader([{ orgId: ORG, patches: { patchIds: [P1] } }]);

    expect(
      await revalidateInstallPatchesForDelivery(r, row({ patchJobId: JOB, patchIds: [P1, P3, 'some <title> text'] })),
    ).toEqual(cancelled({ [P3]: 'not_requested_by_job' }, { truncated: true }));
    expect(resolveMock).not.toHaveBeenCalled();
  });

  it('a malformed job list or an empty delivered set is refused whole', async () => {
    const malformed = reader([{ orgId: ORG, patches: { patchIds: 'not-a-list' } }]).reader;
    expect(await revalidateInstallPatchesForDelivery(malformed, row({ patchJobId: JOB, patchIds: [P1] }))).toEqual(
      cancelled({ [P1]: 'invalid_job_patch_list' }),
    );
    const listed = reader([{ orgId: ORG, patches: { patchIds: [P1] } }]).reader;
    expect(await revalidateInstallPatchesForDelivery(listed, row({ patchJobId: JOB }))).toEqual(cancelled({}));
    expect(resolveMock).not.toHaveBeenCalled();
  });

  it('the detail is capped', async () => {
    const many = Array.from({ length: 150 }, (_, i) => `00000000-0000-4000-8000-${String(i).padStart(12, '0')}`);
    resolveMock.mockResolvedValue(verdict([]));
    const { reader: r } = reader([{ orgId: ORG, patches: { patchIds: many } }]);
    const result = (await revalidateInstallPatchesForDelivery(r, row({ patchJobId: JOB, patchIds: many }))) as unknown as {
      detail: { ineligiblePatchIds: string[]; truncated?: boolean };
    };
    expect(result.detail.ineligiblePatchIds).toHaveLength(100);
    expect(result.detail.truncated).toBe(true);
  });

  it('a claim context without the device partner\'s axis is held, not judged on rows it cannot see', async () => {
    const contexts = [
      undefined,
      { scope: 'organization', currentPartnerId: null },
      { scope: 'organization', currentPartnerId: 'eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee' },
    ];
    for (const ctx of contexts) {
      contextMock.mockReturnValue(ctx);
      const { reader: r } = reader([{ orgId: ORG, patches: { patchIds: [P1] } }]);
      await expect(revalidateInstallPatchesForDelivery(r, row({ patchJobId: JOB, patchIds: [P1] }))).rejects.toThrow(
        /not judging eligibility/,
      );
    }
    // An org with no partner cannot be matched either.
    contextMock.mockReturnValue({ scope: 'organization', currentPartnerId: PARTNER });
    const orphan = reader([{ orgId: ORG, patches: { patchIds: [P1] } }], [{ partnerId: null }]).reader;
    await expect(revalidateInstallPatchesForDelivery(orphan, row({ patchJobId: JOB, patchIds: [P1] }))).rejects.toThrow(
      /not judging eligibility/,
    );
    expect(resolveMock).not.toHaveBeenCalled();

    // System scope (the push leg) is judged without the partner read.
    contextMock.mockReturnValue({ scope: 'system', currentPartnerId: null });
    resolveMock.mockResolvedValue(verdict([P1]));
    const { reader: sys, select } = reader([{ orgId: ORG, patches: { patchIds: [P1] } }]);
    expect(await revalidateInstallPatchesForDelivery(sys, row({ patchJobId: JOB, patchIds: [P1] }))).toBeNull();
    expect(select).toHaveBeenCalledTimes(1);
  });

  it('a resolver fault propagates (held by the caller), never read as eligible', async () => {
    resolveMock.mockRejectedValue(new Error('connection reset'));
    const { reader: r } = reader([{ orgId: ORG, patches: { patchIds: [P1] } }]);
    await expect(revalidateInstallPatchesForDelivery(r, row({ patchJobId: JOB, patchIds: [P1] }))).rejects.toThrow(
      'connection reset',
    );
  });
});
