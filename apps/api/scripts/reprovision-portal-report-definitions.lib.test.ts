import { describe, expect, it, vi } from 'vitest';

// Same mocking dialect as managedEvidenceDefinitions.test.ts: a single fake
// registry entry stands in for the real (empty-in-W01) registry so the repair
// path has something to iterate.
vi.mock('../src/services/managedEvidenceRegistry', () => {
  const entry = {
    type: 'threat_detection_review',
    defaultConfig: { sites: [] },
    definitionName: 'Service evidence — Threat Detection Review',
  };
  return {
    MANAGED_EVIDENCE_REGISTRY: { threat_detection_review: entry },
    isManagedEvidenceType: (v: string) => v === 'threat_detection_review',
    managedEvidenceEntry: (t: string) => {
      if (t !== 'threat_detection_review') throw new Error(`${t} is not a managed evidence type`);
      return entry;
    },
    MANAGED_EVIDENCE_DEFINITION_NAME_PREFIX: 'Service evidence — ',
  };
});

import {
  exitCodeFor,
  runReprovisionSweep,
  selectTargetOrgs,
  type ReprovisionDeps,
} from './reprovision-portal-report-definitions.lib';

function deps(overrides: Partial<ReprovisionDeps> = {}): ReprovisionDeps {
  return {
    listReportEnabledOrgs: vi.fn(async () => ['org-a', 'org-b']),
    listEvidenceLinkedOrgs: vi.fn(async () => []),
    existingCreator: vi.fn(async () => 'user-1'),
    provision: vi.fn(async () => {}),
    loadManagedConfig: vi.fn(async () => null),
    updateConfig: vi.fn(),
    log: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    ...overrides,
  };
}

describe('selectTargetOrgs', () => {
  it('includes an org that has a managed-evidence-linked deliverable even with portal reports off', async () => {
    const d = deps({
      listReportEnabledOrgs: vi.fn(async () => ['org-a']),
      listEvidenceLinkedOrgs: vi.fn(async () => ['org-b']),
    });

    const orgs = await selectTargetOrgs(d);

    expect([...orgs].sort()).toEqual(['org-a', 'org-b']);
  });

  it('de-duplicates an org present in both lists', async () => {
    const d = deps({
      listReportEnabledOrgs: vi.fn(async () => ['org-a', 'org-b']),
      listEvidenceLinkedOrgs: vi.fn(async () => ['org-b', 'org-c']),
    });

    const orgs = await selectTargetOrgs(d);

    expect([...orgs].sort()).toEqual(['org-a', 'org-b', 'org-c']);
  });
});

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
      repaired: 0,
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
      repaired: 0,
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

  describe('config repair', () => {
    it('does not rewrite an existing definition config without --repair', async () => {
      const d = deps({
        loadManagedConfig: vi.fn(async () => ({ sites: ['drifted'] })),
      });

      const summary = await runReprovisionSweep(d, { apply: true });

      expect(d.updateConfig).not.toHaveBeenCalled();
      expect(summary.repaired).toBe(0);
    });

    it('rewrites a drifted config to the registry default only under --repair', async () => {
      const d = deps({
        listReportEnabledOrgs: vi.fn(async () => ['org-a']),
        loadManagedConfig: vi.fn(async (orgId: string, type: string) => (
          orgId === 'org-a' && type === 'threat_detection_review'
            ? { sites: ['drifted'] }
            : null
        )),
      });

      const summary = await runReprovisionSweep(d, { apply: true, repair: true });

      expect(d.updateConfig).toHaveBeenCalledTimes(1);
      expect(d.updateConfig).toHaveBeenCalledWith('org-a', 'threat_detection_review', { sites: [] });
      expect(summary.repaired).toBe(1);
      expect(d.log).toHaveBeenCalledWith(expect.stringContaining('drifted'));
    });

    it('leaves a config that already matches the registry default untouched', async () => {
      const d = deps({
        listReportEnabledOrgs: vi.fn(async () => ['org-a']),
        loadManagedConfig: vi.fn(async () => ({ sites: [] })),
      });

      const summary = await runReprovisionSweep(d, { apply: true, repair: true });

      expect(d.updateConfig).not.toHaveBeenCalled();
      expect(summary.repaired).toBe(0);
    });

    it('never repairs outside --apply', async () => {
      const d = deps({
        listReportEnabledOrgs: vi.fn(async () => ['org-a']),
        loadManagedConfig: vi.fn(async () => ({ sites: ['drifted'] })),
      });

      const summary = await runReprovisionSweep(d, { apply: false, repair: true });

      expect(d.updateConfig).not.toHaveBeenCalled();
      expect(summary.repaired).toBe(0);
      expect(d.log).toHaveBeenCalledWith(expect.stringContaining('would repair'));
    });

    it("keeps repairing after one org's repair throws, counts it, and still prints the summary", async () => {
      const d = deps({
        listReportEnabledOrgs: vi.fn(async () => ['org-a', 'org-b']),
        loadManagedConfig: vi.fn(async () => ({ sites: ['drifted'] })),
        updateConfig: vi.fn(async (orgId: string) => {
          if (orgId === 'org-a') throw new Error('boom');
        }),
      });

      const summary = await runReprovisionSweep(d, { apply: true, repair: true });

      // org-a's repair failure must not stop org-b from being repaired.
      expect(d.updateConfig).toHaveBeenCalledWith('org-b', 'threat_detection_review', { sites: [] });
      expect(summary.failed).toBe(1);
      expect(summary.repaired).toBe(1);
      expect(exitCodeFor(summary)).toBe(1);
      expect(d.error).toHaveBeenCalledWith(
        expect.stringContaining('org-a/threat_detection_review'),
        expect.any(Error),
      );
      expect(d.log).toHaveBeenCalledWith(expect.stringContaining('done'));
    });
  });
});

describe('exitCodeFor', () => {
  it('fails the run when any org failed', () => {
    expect(exitCodeFor({
      orgs: 3, provisioned: 2, skippedNoCreator: 0, failed: 1, repaired: 0,
    })).toBe(1);
  });

  it('succeeds on a clean sweep', () => {
    expect(exitCodeFor({
      orgs: 3, provisioned: 3, skippedNoCreator: 0, failed: 0, repaired: 0,
    })).toBe(0);
  });

  it('does not fail the run for deliberate skips', () => {
    // Skips are an expected, documented outcome, not a partial failure: an org
    // with no usable creator is provisioned by the normal flag path later.
    expect(exitCodeFor({
      orgs: 3, provisioned: 0, skippedNoCreator: 3, failed: 0, repaired: 0,
    })).toBe(0);
  });
});
