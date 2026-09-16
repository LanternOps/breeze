import { beforeEach, describe, expect, it, vi } from 'vitest';
const mocks = vi.hoisted(() => ({ capture: vi.fn(), backfill: vi.fn(), drain: vi.fn(), compare: vi.fn(), status: vi.fn() }));
vi.mock('../src/services/topology/legacyImport', () => ({ getTopologyCaptureStatus: mocks.capture, importLegacyTopologySite: mocks.backfill, drainTopologyOutbox: mocks.drain, compareLegacyTopology: mocks.compare, getLegacyTopologyStatus: mocks.status }));
vi.mock('../src/jobs/topologyOutboxWorker', () => ({ retryableTopologyTransaction: () => false }));
import { executeTopologyMigration, parseTopologyMigrationArgs } from './topology-migrate';

const org = '00000000-0000-4000-8000-000000000001';
const site = '00000000-0000-4000-8000-000000000002';
beforeEach(() => vi.clearAllMocks());
describe('topology operator CLI', () => {
  it.each([[], ['backfill'], ['backfill', '--org', org], ['drain', '--org', org, '--site', 'invalid'], ['status', '--org', org, '--site', site, '--all', 'true'], ['status', '--org', org, '--site', site, '--org', org]].map(args => ({ args })))('rejects missing/ambiguous scope $args', ({ args }) => {
    expect(() => parseTopologyMigrationArgs(args)).toThrow();
  });
  it('keeps arbitrary precision barriers and bounds batch size', () => {
    expect(parseTopologyMigrationArgs(['drain', '--org', org, '--site', site, '--through', '9007199254740993'])).toMatchObject({ throughRevision: '9007199254740993', batchSize: 200 });
    expect(() => parseTopologyMigrationArgs(['backfill', '--org', org, '--site', site, '--batch-size', '1001'])).toThrow();
  });
  it.each(['capture-status', 'backfill', 'drain', 'compare'] as const)('exits nonzero when %s cannot prove its barrier', async command => {
    const options = parseTopologyMigrationArgs([command, '--org', org, '--site', site]);
    const mock = command === 'capture-status' ? mocks.capture : command === 'backfill' ? mocks.backfill : command === 'drain' ? mocks.drain : mocks.compare;
    mock.mockResolvedValue({ complete: false, ok: false, pendingThroughBarrier: 1 });
    expect((await executeTopologyMigration(options)).exitCode).toBe(2);
    expect(mock).toHaveBeenCalledOnce();
    expect(mock.mock.calls[0]![0]).toEqual({ orgId: org, siteId: site });
  });
  it('status never starts a backfill', async () => {
    mocks.status.mockResolvedValue({ initialized: false });
    expect((await executeTopologyMigration(parseTopologyMigrationArgs(['status', '--org', org, '--site', site]))).exitCode).toBe(0);
    expect(mocks.backfill).not.toHaveBeenCalled();
    expect(mocks.drain).not.toHaveBeenCalled();
  });
});
