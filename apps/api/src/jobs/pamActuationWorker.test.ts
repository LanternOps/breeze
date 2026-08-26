import { beforeEach, describe, expect, it, vi } from 'vitest';

const { executeMock } = vi.hoisted(() => ({
  executeMock: vi.fn(),
}));

vi.mock('bullmq', () => ({ Queue: class {}, Worker: class {}, Job: class {} }));
vi.mock('../db', () => ({
  db: { execute: executeMock },
  withSystemDbAccessContext: (fn: () => Promise<unknown>) => fn(),
}));
vi.mock('../services/redis', () => ({ getBullMQConnection: () => ({}) }));
vi.mock('../services/sentry', () => ({ captureException: vi.fn() }));

import { processPamActuationEvent } from './pamActuationWorker';

const current = {
  id: '30000000-0000-4000-8000-000000000001',
  org_id: '30000000-0000-4000-8000-000000000002',
  request_org_id: '30000000-0000-4000-8000-000000000002',
  device_org_id: '30000000-0000-4000-8000-000000000002',
  device_id: '30000000-0000-4000-8000-000000000003',
  elevation_request_id: '30000000-0000-4000-8000-000000000004',
  request_revision: 2,
  generation: 4,
  desired_state: 'active',
  current_command_id: null,
  pam_lifetime_protocol_version: 2,
  target_executable_path: 'C:\\admin.exe',
  target_executable_hash: null,
  subject_username: 'operator',
  expires_at: new Date(Date.now() + 60_000),
};

describe('processPamActuationEvent', () => {
  beforeEach(() => {
    vi.resetAllMocks();
  });

  it('inserts and binds one v2 command for duplicate outbox delivery', async () => {
    executeMock
      .mockResolvedValueOnce({ rows: [current] })
      .mockResolvedValueOnce({ rows: [] })
      .mockResolvedValueOnce({ rows: [] });
    await expect(processPamActuationEvent({ actuationId: current.id, generation: 4 }))
      .resolves.toBe('dispatched');

    executeMock.mockReset().mockResolvedValueOnce({
      rows: [{ ...current, current_command_id: '40000000-0000-4000-8000-000000000001' }],
    });
    await expect(processPamActuationEvent({ actuationId: current.id, generation: 4 }))
      .resolves.toBe('duplicate');
    expect(executeMock).toHaveBeenCalledTimes(1);
  });

  it('does not dispatch a lower generation or regress cleanup to apply', async () => {
    executeMock.mockResolvedValueOnce({ rows: [{ ...current, generation: 5, desired_state: 'cleanup' }] });
    await expect(processPamActuationEvent({ actuationId: current.id, generation: 4 }))
      .resolves.toBe('stale');
    expect(executeMock).toHaveBeenCalledTimes(1);

    executeMock.mockReset()
      .mockResolvedValueOnce({ rows: [{ ...current, desired_state: 'cleanup' }] })
      .mockResolvedValueOnce({ rows: [] })
      .mockResolvedValueOnce({ rows: [] });
    await expect(processPamActuationEvent({ actuationId: current.id, generation: 4 }))
      .resolves.toBe('dispatched');
    const sqlText = executeMock.mock.calls.map(([query]) => JSON.stringify(query)).join('\n');
    expect(sqlText).toContain('pam_cleanup_v2');
    expect(sqlText).not.toContain('pam_apply_v2');
  });

  it.each([undefined, 0])('fails closed when PAM capability is %s', async (version) => {
    executeMock.mockResolvedValueOnce({
      rows: [{ ...current, pam_lifetime_protocol_version: version }],
    }).mockResolvedValueOnce({ rows: [] });
    await expect(processPamActuationEvent({ actuationId: current.id, generation: 4 }))
      .resolves.toBe('unsupported');
    expect(executeMock).toHaveBeenCalledTimes(2);
  });
});
