import { describe, expect, it, vi } from 'vitest';
import {
  exitCodeFor,
  runReprovisionSweep,
  type ReprovisionDeps,
} from './reprovision-portal-report-definitions.lib';

function deps(overrides: Partial<ReprovisionDeps> = {}): ReprovisionDeps {
  return {
    listReportEnabledOrgs: vi.fn(async () => ['org-a', 'org-b']),
    existingCreator: vi.fn(async () => 'user-1'),
    provision: vi.fn(async () => {}),
    log: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    ...overrides,
  };
}

describe('runReprovisionSweep', () => {
  it('writes nothing in the default dry run', async () => {
    const d = deps();

    const summary = await runReprovisionSweep(d, { apply: false });

    expect(d.provision).not.toHaveBeenCalled();
    expect(summary).toEqual({
      orgs: 2,
      provisioned: 2,
      skippedNoCreator: 0,
      failed: 0,
    });
    expect(d.log).toHaveBeenCalledWith(expect.stringContaining('DRY RUN'));
  });

  it('provisions every org once under --apply', async () => {
    const d = deps();

    const summary = await runReprovisionSweep(d, { apply: true });

    expect(d.provision).toHaveBeenCalledTimes(2);
    expect(d.provision).toHaveBeenCalledWith({ orgId: 'org-a', createdBy: 'user-1' });
    expect(d.provision).toHaveBeenCalledWith({ orgId: 'org-b', createdBy: 'user-1' });
    expect(summary.provisioned).toBe(2);
    expect(d.log).toHaveBeenCalledWith(expect.stringContaining('APPLY'));
  });

  it('skips an org with no usable creator instead of inventing one', async () => {
    const d = deps({
      existingCreator: vi.fn(async (orgId: string) =>
        orgId === 'org-a' ? null : 'user-1',
      ),
    });

    const summary = await runReprovisionSweep(d, { apply: true });

    expect(d.provision).toHaveBeenCalledTimes(1);
    expect(d.provision).toHaveBeenCalledWith({ orgId: 'org-b', createdBy: 'user-1' });
    expect(summary.skippedNoCreator).toBe(1);
    expect(summary.provisioned).toBe(1);
    expect(d.warn).toHaveBeenCalledWith(expect.stringContaining('org-a'));
  });

  it('keeps sweeping after one org throws, and counts it', async () => {
    const d = deps({
      listReportEnabledOrgs: vi.fn(async () => ['org-a', 'org-b', 'org-c']),
      provision: vi.fn(async ({ orgId }) => {
        if (orgId === 'org-a') throw new Error('boom');
      }),
    });

    const summary = await runReprovisionSweep(d, { apply: true });

    // The failure must not abort the loop: org-b and org-c still ran.
    expect(d.provision).toHaveBeenCalledTimes(3);
    expect(summary).toEqual({
      orgs: 3,
      provisioned: 2,
      skippedNoCreator: 0,
      failed: 1,
    });
    expect(d.error).toHaveBeenCalledWith(
      expect.stringContaining('org-a'),
      expect.any(Error),
    );
  });

  it('reports an empty fleet without touching anything', async () => {
    const d = deps({ listReportEnabledOrgs: vi.fn(async () => []) });

    const summary = await runReprovisionSweep(d, { apply: true });

    expect(d.provision).not.toHaveBeenCalled();
    expect(summary.orgs).toBe(0);
    expect(exitCodeFor(summary)).toBe(0);
  });
});

describe('exitCodeFor', () => {
  it('fails the run when any org failed', () => {
    expect(exitCodeFor({
      orgs: 3, provisioned: 2, skippedNoCreator: 0, failed: 1,
    })).toBe(1);
  });

  it('succeeds on a clean sweep', () => {
    expect(exitCodeFor({
      orgs: 3, provisioned: 3, skippedNoCreator: 0, failed: 0,
    })).toBe(0);
  });

  it('does not fail the run for deliberate skips', () => {
    // Skips are an expected, documented outcome, not a partial failure: an org
    // with no usable creator is provisioned by the normal flag path later.
    expect(exitCodeFor({
      orgs: 3, provisioned: 0, skippedNoCreator: 3, failed: 0,
    })).toBe(0);
  });
});
