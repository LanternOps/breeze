import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

const { mockDb } = vi.hoisted(() => ({ mockDb: { select: vi.fn() } }));

vi.mock('../../../db', () => ({ db: mockDb }));

vi.mock('../../../db/schema', () => ({
  securityPostureSnapshots: {
    deviceId: 'sps.deviceId',
    capturedAt: 'sps.capturedAt',
    patchComplianceScore: 'sps.patchComplianceScore',
    factorDetails: 'sps.factorDetails',
  },
}));

import { patchComplianceHandler, PATCH_COMPLIANCE_MAX_SNAPSHOT_AGE_MS } from './patchCompliance';

const NOW = new Date('2026-09-26T12:00:00.000Z');

function setRows(rows: Array<Record<string, unknown>>) {
  mockDb.select.mockReturnValue({
    from: () => ({
      where: () => ({
        orderBy: () => ({ limit: () => Promise.resolve(rows) }),
      }),
    }),
  });
}

function snapshot(overrides: Record<string, unknown> = {}) {
  return {
    patchComplianceScore: 70,
    capturedAt: new Date(NOW.getTime() - 60 * 60_000),
    factorDetails: { patch_compliance: { score: 70, confidence: 0.9 } },
    ...overrides,
  };
}

const COND = { type: 'patch_compliance', operator: 'lt', value: 80 } as const;

describe('patchComplianceHandler', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(NOW);
    mockDb.select.mockReset();
  });
  afterEach(() => vi.useRealTimers());

  it('fires on a fresh snapshot whose score breaches the threshold', async () => {
    setRows([snapshot()]);
    const result = await patchComplianceHandler.evaluate(COND, 'dev-1');
    expect(result.passed).toBe(true);
    expect(result.actualValue).toBe(70);
  });

  it('does not fire on a fresh snapshot within the threshold', async () => {
    setRows([snapshot({ patchComplianceScore: 95 })]);
    const result = await patchComplianceHandler.evaluate(COND, 'dev-1');
    expect(result.passed).toBe(false);
    expect(result.dataAvailable).not.toBe(false);
  });

  it('treats a snapshot older than the freshness window as no data, not as a breach', async () => {
    setRows([snapshot({ capturedAt: new Date(NOW.getTime() - PATCH_COMPLIANCE_MAX_SNAPSHOT_AGE_MS - 60_000) })]);
    const result = await patchComplianceHandler.evaluate(COND, 'dev-1');
    expect(result).toMatchObject({ passed: false, dataAvailable: false });
  });

  it('accepts a snapshot right at the freshness boundary', async () => {
    setRows([snapshot({ capturedAt: new Date(NOW.getTime() - PATCH_COMPLIANCE_MAX_SNAPSHOT_AGE_MS) })]);
    const result = await patchComplianceHandler.evaluate(COND, 'dev-1');
    expect(result.passed).toBe(true);
  });

  it('treats a snapshot scored without patch telemetry as no data', async () => {
    // scorePatchCompliance() emits score 100 + a dataGap when the device has no
    // critical/important patch inventory — that 100 is a placeholder, not a measurement.
    setRows([snapshot({
      patchComplianceScore: 100,
      factorDetails: { patch_compliance: { score: 100, confidence: 0.35, dataGap: 'No telemetry' } },
    })]);
    const result = await patchComplianceHandler.evaluate({ ...COND, operator: 'gte', value: 100 }, 'dev-1');
    expect(result).toMatchObject({ passed: false, dataAvailable: false });
  });

  it('reports no data when the device has never been scored', async () => {
    setRows([]);
    const result = await patchComplianceHandler.evaluate(COND, 'dev-1');
    expect(result).toMatchObject({ passed: false, dataAvailable: false });
  });
});

// W06 (#8195, spec §10.1): the container image term is folded into the
// patch-compliance PERCENT views only. This handler scores from posture
// snapshots (posture is excluded from the term), so unchecked images can never
// read as a data gap here and never suppress a known OS-patch breach.
describe('patchComplianceHandler and container images (W06 pin)', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(NOW);
    mockDb.select.mockReset();
  });
  afterEach(() => vi.useRealTimers());

  it('still breaches on a known OS-patch score whatever the device runs', async () => {
    const from = vi.fn(() => ({
      where: () => ({ orderBy: () => ({ limit: () => Promise.resolve([snapshot({ patchComplianceScore: 40 })]) }) }),
    }));
    mockDb.select.mockReturnValue({ from });
    const result = await patchComplianceHandler.evaluate(COND, 'device-with-unchecked-images');
    expect(result.passed).toBe(true);
    expect(result.dataAvailable).not.toBe(false);
    expect(result.actualValue).toBe(40);
    // one read, of posture snapshots only — no workload/image source is consulted
    expect(from).toHaveBeenCalledTimes(1);
    expect(from).toHaveBeenCalledWith(expect.objectContaining({ deviceId: 'sps.deviceId' }));
  });

  it('neither this handler nor security posture reads container image data', async () => {
    const { readFile } = await import('node:fs/promises');
    const { fileURLToPath } = await import('node:url');
    for (const rel of ['./patchCompliance.ts', '../../securityPosture.ts']) {
      const source = await readFile(fileURLToPath(new URL(rel, import.meta.url)), 'utf8');
      expect(source).not.toMatch(/imageCompliance|containerImageComplianceTerms|device_workloads|deviceWorkloads/);
    }
  });
});
