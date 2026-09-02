import { describe, expect, it } from 'vitest';
import { softwareInventoryReportSchema } from './softwareInventoryObservation';

const item = { name: 'Breeze Agent', version: '0.105.1', vendor: 'LanternOps' };

function complete(overrides: Record<string, unknown> = {}) {
  return {
    schemaVersion: 2,
    observationId: '11111111-1111-4111-8111-111111111111',
    collectorVersion: '0.105.1',
    observedAt: '2026-08-24T12:00:00.000Z',
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

describe('softwareInventoryReportSchema', () => {
  it('accepts legacy inventory up to its 10,000-item compatibility bound', () => {
    expect(softwareInventoryReportSchema.safeParse({ software: [item] }).success).toBe(true);
  });

  it('accepts an internally consistent complete v2 observation', () => {
    expect(softwareInventoryReportSchema.safeParse(complete()).success).toBe(true);
  });

  it.each([
    ['duplicate expected source', complete({ expectedSources: ['a', 'a'], succeededSources: ['a'] })],
    ['unaccounted expected source', complete({ expectedSources: ['a', 'b'], succeededSources: ['a'] })],
    ['overlapping success and failure', complete({ expectedSources: ['a'], succeededSources: ['a'], failedSources: [{ source: 'a', code: 'command_failed' }] })],
    ['mismatched item count', complete({ itemCount: 0 })],
    ['complete but truncated', complete({ truncated: true })],
    ['partial with no successful source', complete({ completeness: 'partial', succeededSources: [], failedSources: [{ source: 'windows:registry:hklm64', code: 'registry_read_failed' }] })],
    ['failed with a successful source', complete({ completeness: 'failed', failedSources: [], succeededSources: ['windows:registry:hklm64'] })],
    ['invalid observation identity', complete({ observationId: 'not-a-uuid' })],
  ])('rejects %s', (_label, report) => {
    expect(softwareInventoryReportSchema.safeParse(report).success).toBe(false);
  });

  it('accepts partial and failed observations when every source is accounted for', () => {
    expect(softwareInventoryReportSchema.safeParse(complete({
      completeness: 'partial',
      expectedSources: ['a', 'b'],
      succeededSources: ['a'],
      failedSources: [{ source: 'b', code: 'command_failed' }],
    })).success).toBe(true);
    expect(softwareInventoryReportSchema.safeParse(complete({
      completeness: 'failed',
      succeededSources: [],
      failedSources: [{ source: 'windows:registry:hklm64', code: 'registry_read_failed' }],
      truncated: true,
      itemCount: 0,
      items: [],
    })).success).toBe(true);
  });
});
