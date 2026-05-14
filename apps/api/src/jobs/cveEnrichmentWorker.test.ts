import { beforeEach, describe, expect, it, vi } from 'vitest';

const { queryOsvForPackage, mockRows, updateSet } = vi.hoisted(() => ({
  queryOsvForPackage: vi.fn(),
  mockRows: [
    {
      patchId: 'p1',
      packageId: 'Mozilla.Firefox',
      currentSeverity: 'moderate',
      ecosystem: 'npm',
      version: '120.0',
    },
  ],
  updateSet: vi.fn(),
}));

const updateChain = {
  set: (args: unknown) => {
    updateSet(args);
    return { where: vi.fn().mockResolvedValue(undefined) };
  },
};

vi.mock('drizzle-orm', () => ({
  eq: (left: unknown, right: unknown) => ({ op: 'eq', left, right }),
  and: (...args: unknown[]) => ({ op: 'and', args }),
  isNotNull: (col: unknown) => ({ op: 'isNotNull', col }),
  sql: (strings: TemplateStringsArray, ...values: unknown[]) => ({
    op: 'sql',
    strings: Array.from(strings),
    values,
  }),
}));

vi.mock('../db/schema', () => ({
  patches: {
    id: 'patches.id',
    source: 'patches.source',
    severity: 'patches.severity',
    packageId: 'patches.packageId',
    metadata: 'patches.metadata',
    cveIds: 'patches.cveIds',
    updatedAt: 'patches.updatedAt',
  },
  thirdPartyPackageCatalog: {
    source: 'cat.source',
    packageId: 'cat.packageId',
    osvEcosystem: 'cat.osvEcosystem',
  },
}));

vi.mock('../db', () => ({
  db: {
    select: vi.fn(() => ({
      from: (_table: unknown) => ({
        innerJoin: (_table2: unknown, _on: unknown) => ({
          where: (_where: unknown) => ({
            limit: (_limit: number) => Promise.resolve(mockRows),
          }),
        }),
      }),
    })),
    update: vi.fn(() => updateChain),
  },
}));

vi.mock('../services/osvClient', () => ({
  queryOsvForPackage: (...args: unknown[]) => queryOsvForPackage(...args),
}));

import { runCveEnrichmentBatch } from './cveEnrichmentWorker';

beforeEach(() => {
  queryOsvForPackage.mockReset();
  updateSet.mockReset();
});

describe('runCveEnrichmentBatch', () => {
  it('writes cve_ids and bumps severity when OSV severity is higher', async () => {
    queryOsvForPackage.mockResolvedValue({
      cveIds: ['CVE-2024-1', 'CVE-2024-2'],
      maxSeverity: 'critical',
    });

    const summary = await runCveEnrichmentBatch();

    expect(summary).toEqual({ scanned: 1, updated: 1, errors: 0 });
    expect(updateSet).toHaveBeenCalledWith(
      expect.objectContaining({
        cveIds: ['CVE-2024-1', 'CVE-2024-2'],
        severity: 'critical',
      })
    );
  });

  it('keeps existing severity when OSV severity is lower', async () => {
    queryOsvForPackage.mockResolvedValue({
      cveIds: ['CVE-2024-3'],
      maxSeverity: 'low',
    });

    await runCveEnrichmentBatch();

    expect(updateSet).toHaveBeenCalledWith(
      expect.objectContaining({
        cveIds: ['CVE-2024-3'],
        severity: 'moderate',
      })
    );
  });

  it('does not update when no CVEs found', async () => {
    queryOsvForPackage.mockResolvedValue({ cveIds: [], maxSeverity: null });

    const summary = await runCveEnrichmentBatch();

    expect(summary).toEqual({ scanned: 1, updated: 0, errors: 0 });
    expect(updateSet).not.toHaveBeenCalled();
  });

  it('increments errors when OSV throws', async () => {
    queryOsvForPackage.mockRejectedValue(new Error('network down'));

    const summary = await runCveEnrichmentBatch();

    expect(summary).toEqual({ scanned: 1, updated: 0, errors: 1 });
    expect(updateSet).not.toHaveBeenCalled();
  });
});
