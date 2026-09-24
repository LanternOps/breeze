import { beforeEach, describe, expect, it, vi } from 'vitest';

// #3530: these result handlers run after the command row is already terminal,
// so a failure they swallow must at least reach Sentry, not only stdout.
const { captureExceptionMock, selectMock, updateMock, helpers } = vi.hoisted(() => ({
  captureExceptionMock: vi.fn(),
  selectMock: vi.fn(),
  updateMock: vi.fn(),
  helpers: {
    handleSensitiveDataCommandResult: vi.fn(),
    handleCisCommandResult: vi.fn(),
  },
}));
vi.mock('./sentry', () => ({ captureException: (...a: unknown[]) => captureExceptionMock(...a) }));
vi.mock('../routes/agents/helpers', () => helpers);
vi.mock('../db', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../db')>();
  return { ...actual, db: { ...actual.db, select: selectMock, update: updateMock }, runOutsideDbContext: (fn: () => unknown) => fn() };
});
vi.mock('../jobs/discoveryWorker', () => ({ enqueueDiscoveryResults: vi.fn(() => Promise.reject(new Error('redis down'))) }));
vi.mock('../jobs/snmpWorker', () => ({ enqueueSnmpPollResults: vi.fn() }));
vi.mock('./redis', () => ({ isRedisAvailable: vi.fn(() => true), getRedis: vi.fn(() => null) }));
import { commandResultHandlers, type CommandResultHandler } from './commandResultHandlers';

const CMD_ID = '44444444-4444-4444-8444-444444444444';
const JOB_ID = '55555555-5555-4555-8555-555555555555';
function input(type: string, payload: Record<string, unknown> = {}, result: Record<string, unknown> = {}): Parameters<CommandResultHandler>[0] {
  return {
    agentId: 'agent-1', commandId: CMD_ID,
    command: { id: CMD_ID, type, payload } as never,
    resolvedDeviceId: 'dev-1', result: { status: 'completed', ...result } as never, stdout: '{}',
  };
}

describe('result handlers report swallowed failures (#3530)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.spyOn(console, 'error').mockImplementation(() => {});
  });

  it.each(['sensitive_data_scan', 'quarantine_file'])('%s: a processing failure is captured with its phase tag', async (type) => {
    const boom = new Error('persist failed');
    helpers.handleSensitiveDataCommandResult.mockRejectedValueOnce(boom);
    await expect(commandResultHandlers[type]!(input(type))).resolves.toBeUndefined();
    expect(captureExceptionMock).toHaveBeenCalledWith(boom, undefined,
      { command_result_phase: 'sensitive_data_result' });
  });

  it.each(['cis_benchmark', 'apply_cis_remediation'])('%s: a processing failure is captured with its phase tag', async (type) => {
    const boom = new Error('persist failed');
    helpers.handleCisCommandResult.mockRejectedValueOnce(boom);
    await expect(commandResultHandlers[type]!(input(type))).resolves.toBeUndefined();
    expect(captureExceptionMock).toHaveBeenCalledWith(boom, undefined,
      { command_result_phase: 'cis_result' });
  });

  it('network_discovery: failing to mark the job failed is captured too', async () => {
    selectMock.mockReturnValue({ from: () => ({ where: () => ({ limit: () => Promise.resolve([{ orgId: 'o', siteId: 's' }]) }) }) });
    const markErr = new Error('db unavailable');
    updateMock.mockReturnValue({ set: () => ({ where: () => Promise.reject(markErr) }) });
    await commandResultHandlers.network_discovery!(input('network_discovery', { jobId: JOB_ID }, { result: { jobId: JOB_ID, hosts: [] } }));
    expect(captureExceptionMock).toHaveBeenCalledWith(markErr, undefined,
      { command_result_phase: 'discovery_mark_failed' });
  });
});
