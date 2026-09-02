import { describe, expect, it, vi } from 'vitest';
import type { LegacySoftwareInventoryReport, SoftwareInventoryObservationV2 } from '@breeze/shared';
import {
  decideSoftwareInventoryAcceptance,
  replaceSoftwareInventoryProjection,
} from './softwareInventoryObservations';

const item = { name: 'Google Chrome', version: '127', vendor: 'Google LLC' };
const receivedAt = new Date('2026-08-24T12:00:00.000Z');

function v2(overrides: Partial<SoftwareInventoryObservationV2> = {}): SoftwareInventoryObservationV2 {
  return {
    schemaVersion: 2,
    observationId: '11111111-1111-4111-8111-111111111111',
    collectorVersion: '0.105.1',
    observedAt: '2026-08-24T11:59:00.000Z',
    completeness: 'complete',
    expectedSources: ['windows:registry:hklm64'],
    succeededSources: ['windows:registry:hklm64'],
    failedSources: [],
    truncated: false,
    itemCount: 1,
    items: [item],
    ...overrides,
  };
}

const emptyState = {
  latestReceivedAt: null,
  latestObservationId: null,
  hasAcceptedV2: false,
  visibleItemCount: 0,
  latestAcceptedExpectedSources: null,
};

describe('decideSoftwareInventoryAcceptance', () => {
  it('accepts a nonempty legacy projection before v2', () => {
    expect(decideSoftwareInventoryAcceptance({ report: { software: [item] }, state: emptyState, receivedAt }))
      .toEqual({ acceptedForInventory: true, absenceResolutionEligible: false, reasonCode: 'accepted_legacy' });
  });

  it.each([
    [{ software: [] } as LegacySoftwareInventoryReport, emptyState, 'retained_legacy_empty'],
    [{ software: [item] } as LegacySoftwareInventoryReport, { ...emptyState, hasAcceptedV2: true }, 'retained_legacy_after_v2'],
    [v2({ completeness: 'partial', expectedSources: ['a', 'b'], succeededSources: ['a'], failedSources: [{ source: 'b', code: 'command_failed' }] }), emptyState, 'rejected_partial'],
    [v2({ completeness: 'failed', succeededSources: [], failedSources: [{ source: 'windows:registry:hklm64', code: 'registry_read_failed' }], itemCount: 0, items: [] }), emptyState, 'rejected_failed'],
    [v2({ completeness: 'partial', truncated: true }), emptyState, 'rejected_truncated'],
  ] as const)('retains projection with stable reason %#', (report, state, reasonCode) => {
    expect(decideSoftwareInventoryAcceptance({ report, state, receivedAt })).toEqual({
      acceptedForInventory: false,
      absenceResolutionEligible: false,
      reasonCode,
    });
  });

  it('uses server receipt time, not observedAt, to reject older evidence', () => {
    expect(decideSoftwareInventoryAcceptance({
      report: v2({ observedAt: '2030-01-01T00:00:00.000Z' }),
      state: { ...emptyState, latestReceivedAt: new Date('2026-08-24T12:00:01.000Z') },
      receivedAt,
    }).reasonCode).toBe('rejected_out_of_order');
  });

  it('uses observation identity as the deterministic tie-break for equal receipts', () => {
    expect(decideSoftwareInventoryAcceptance({
      report: v2({ observationId: '11111111-1111-4111-8111-111111111111' }),
      state: {
        ...emptyState,
        latestReceivedAt: receivedAt,
        latestObservationId: '22222222-2222-4222-8222-222222222222',
      },
      receivedAt,
    }).reasonCode).toBe('rejected_out_of_order');
  });

  it('rejects a strict sub-10% collapse but accepts exactly 10%', () => {
    const state = {
      ...emptyState,
      hasAcceptedV2: true,
      visibleItemCount: 50,
      latestAcceptedExpectedSources: ['a'],
    };
    expect(decideSoftwareInventoryAcceptance({ report: v2({ expectedSources: ['a'], succeededSources: ['a'], itemCount: 4, items: Array(4).fill(item) }), state, receivedAt }).reasonCode)
      .toBe('rejected_count_collapse');
    expect(decideSoftwareInventoryAcceptance({ report: v2({ expectedSources: ['a'], succeededSources: ['a'], itemCount: 5, items: Array(5).fill(item) }), state, receivedAt }).reasonCode)
      .toBe('accepted_complete');
  });

  it('bypasses only collapse when the normalized source set changes', () => {
    const decision = decideSoftwareInventoryAcceptance({
      report: v2({ expectedSources: ['b', 'a'], succeededSources: ['a', 'b'], itemCount: 1, items: [item] }),
      state: { ...emptyState, hasAcceptedV2: true, visibleItemCount: 100, latestAcceptedExpectedSources: ['a'] },
      receivedAt,
    });
    expect(decision.reasonCode).toBe('accepted_complete');
    expect(decision.absenceResolutionEligible).toBe(true);
  });
});

describe('replaceSoftwareInventoryProjection', () => {
  function projectionTx(
    linkedFindings: Array<{ findingId: string; name: string; vendor: string | null }>,
    replacements: Array<{ id: string; name: string; vendor: string | null }>,
  ) {
    const updateSets: Array<Record<string, unknown>> = [];
    const inserted: Array<Record<string, unknown>> = [];
    const select = vi.fn().mockReturnValue({
      from: vi.fn().mockReturnValue({
        innerJoin: vi.fn().mockReturnValue({
          where: vi.fn().mockReturnValue({
            orderBy: vi.fn().mockReturnValue({ for: vi.fn().mockResolvedValue(linkedFindings) }),
          }),
        }),
        where: vi.fn().mockResolvedValue(replacements),
      }),
    });
    return {
      tx: {
        select,
        delete: vi.fn().mockReturnValue({ where: vi.fn().mockResolvedValue(undefined) }),
        insert: vi.fn().mockReturnValue({
          values: vi.fn((values: Array<Record<string, unknown>>) => {
            inserted.push(...values);
            return Promise.resolve(undefined);
          }),
        }),
        update: vi.fn().mockReturnValue({
          set: vi.fn((value: Record<string, unknown>) => {
            updateSets.push(value);
            return { where: vi.fn().mockResolvedValue(undefined) };
          }),
        }),
      },
      inserted,
      select,
      updateSets,
    };
  }

  it('preserves the ordered finding lock and relinks normalized name/vendor matches', async () => {
    const ordered = vi.fn();
    const locked = vi.fn().mockResolvedValue([
      { findingId: 'finding-1', name: ' GOOGLE Chrome ', vendor: 'Google LLC' },
    ]);
    const updateSets: unknown[] = [];
    const tx = {
      select: vi.fn().mockReturnValue({
        from: vi.fn().mockReturnValue({
          innerJoin: vi.fn().mockReturnValue({
            where: vi.fn().mockReturnValue({ orderBy: ordered.mockReturnValue({ for: locked }) }),
          }),
          where: vi.fn().mockResolvedValue([{ id: 'new-row', name: 'Google Chrome', vendor: ' google llc ' }]),
        }),
      }),
      delete: vi.fn().mockReturnValue({ where: vi.fn().mockResolvedValue(undefined) }),
      insert: vi.fn().mockReturnValue({ values: vi.fn().mockResolvedValue(undefined) }),
      update: vi.fn().mockReturnValue({
        set: vi.fn((value) => {
          updateSets.push(value);
          return { where: vi.fn().mockResolvedValue(undefined) };
        }),
      }),
    };

    await replaceSoftwareInventoryProjection(tx as never, {
      device: { id: 'device-1', orgId: 'org-1', agentVersion: '0.105.1' },
      items: [item],
      observationId: '11111111-1111-4111-8111-111111111111',
      receivedAt,
    });

    expect(ordered).toHaveBeenCalledTimes(1);
    expect(locked).toHaveBeenCalledWith('update', expect.any(Object));
    expect(updateSets).toEqual([expect.objectContaining({ softwareInventoryId: 'new-row' })]);
  });

  it('does not re-link a finding when only the normalized name matches but vendor differs', async () => {
    const { tx, updateSets } = projectionTx(
      [{ findingId: 'finding-1', name: 'Agent', vendor: 'Vendor A' }],
      [{ id: 'new-row', name: 'Agent', vendor: 'Vendor B' }],
    );
    await replaceSoftwareInventoryProjection(tx as never, {
      device: { id: 'device-1', orgId: 'org-1', agentVersion: '0.105.1' },
      items: [{ name: 'Agent', vendor: 'Vendor B' }],
      observationId: '11111111-1111-4111-8111-111111111111',
      receivedAt,
    });
    expect(updateSets).toHaveLength(0);
  });

  it('skips replacement-row lookup and relinking when no finding points at the old projection', async () => {
    const { tx, select, updateSets } = projectionTx([], []);
    await replaceSoftwareInventoryProjection(tx as never, {
      device: { id: 'device-1', orgId: 'org-1', agentVersion: '0.105.1' },
      items: [item],
      observationId: '11111111-1111-4111-8111-111111111111',
      receivedAt,
    });
    expect(select).toHaveBeenCalledTimes(1);
    expect(updateSets).toHaveLength(0);
  });

  it('normalizes both Breeze Agent editions to the authenticated live version', async () => {
    const { tx, inserted } = projectionTx([], []);
    await replaceSoftwareInventoryProjection(tx as never, {
      device: { id: 'device-1', orgId: 'org-1', agentVersion: '0.105.1' },
      items: [
        { name: 'Breeze Agent', version: '0.100.0' },
        { name: 'Breeze Agent (Self-Hosted)', version: '0.101.0' },
        { name: 'Google Chrome', version: '127' },
      ],
      observationId: '11111111-1111-4111-8111-111111111111',
      receivedAt,
    });
    expect(inserted.map((row) => [row.name, row.version])).toEqual([
      ['Breeze Agent', '0.105.1'],
      ['Breeze Agent (Self-Hosted)', '0.105.1'],
      ['Google Chrome', '127'],
    ]);
  });

  it('does not replace a reported agent version with the provisioning sentinel', async () => {
    const { tx, inserted } = projectionTx([], []);
    await replaceSoftwareInventoryProjection(tx as never, {
      device: { id: 'device-1', orgId: 'org-1', agentVersion: '0.0.0' },
      items: [{ name: 'Breeze Agent', version: '0.100.0' }],
      observationId: '11111111-1111-4111-8111-111111111111',
      receivedAt,
    });
    expect(inserted[0]?.version).toBe('0.100.0');
  });
});
