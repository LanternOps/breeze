import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import canonical from '../../../../packages/shared/src/fixtures/pam-lifetime-v2-command-contract.json';

const { executeMock } = vi.hoisted(() => ({
  executeMock: vi.fn(),
}));
const { assertDeviceExecuteAllowedMock } = vi.hoisted(() => ({
  assertDeviceExecuteAllowedMock: vi.fn(async () => undefined),
}));

vi.mock('bullmq', () => ({ Queue: class {}, Worker: class {}, Job: class {} }));
vi.mock('../db', () => ({
  db: { execute: executeMock },
  withSystemDbAccessContext: (fn: () => Promise<unknown>) => fn(),
}));
vi.mock('../services/redis', () => ({ getBullMQConnection: () => ({}) }));
vi.mock('../services/sentry', () => ({ captureException: vi.fn() }));
vi.mock('../services/partnerTrust.commands', async () => ({
  ...(await vi.importActual<typeof import('../services/partnerTrust.commands')>('../services/partnerTrust.commands')),
  assertDeviceExecuteAllowed: assertDeviceExecuteAllowedMock,
}));

import { processPamActuationEvent } from './pamActuationWorker';
import { TrustDeniedError } from '../services/partnerTrust.commands';

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
  target_executable_path: canonical.apply.targetPath,
  target_executable_hash: null,
  subject_username: canonical.apply.subjectUsername,
  expires_at: new Date(canonical.apply.expiresAt),
};

function collectStrings(value: unknown, seen = new Set<object>()): string[] {
  if (typeof value === 'string') return [value];
  if (value === null || typeof value !== 'object' || seen.has(value)) return [];
  seen.add(value);
  return Object.values(value).flatMap((entry) => collectStrings(entry, seen));
}

function commandPayloadAt(callIndex: number): Record<string, unknown> {
  const values = collectStrings(executeMock.mock.calls[callIndex]?.[0]);
  const raw = values.find((value) => value.startsWith('{"protocolVersion":2'));
  if (!raw) throw new Error(`command payload missing from execute call ${callIndex}`);
  return JSON.parse(raw) as Record<string, unknown>;
}

describe('processPamActuationEvent', () => {
  beforeEach(() => {
    vi.resetAllMocks();
    vi.useFakeTimers();
    vi.setSystemTime(canonical.apply.serverTime);
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('inserts and binds one v2 command for duplicate outbox delivery', async () => {
    executeMock
      .mockResolvedValueOnce({ rows: [current] })
      .mockResolvedValueOnce({ rows: [] })
      .mockResolvedValueOnce({ rows: [] });
    await expect(processPamActuationEvent({ actuationId: current.id, generation: 4 }))
      .resolves.toBe('dispatched');
    expect(assertDeviceExecuteAllowedMock).toHaveBeenCalledWith(current.device_id, 'pam_apply_v2', null);
    expect(commandPayloadAt(1)).toEqual(canonical.apply);

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
      .mockResolvedValueOnce({ rows: [{ ...current, generation: 5, desired_state: 'cleanup' }] })
      .mockResolvedValueOnce({ rows: [] })
      .mockResolvedValueOnce({ rows: [] });
    await expect(processPamActuationEvent({ actuationId: current.id, generation: 5 }))
      .resolves.toBe('dispatched');
    expect(commandPayloadAt(1)).toEqual(canonical.cleanup);
    const sqlText = executeMock.mock.calls.map(([query]) => JSON.stringify(query)).join('\n');
    expect(sqlText).toContain('pam_cleanup_v2');
    expect(sqlText).not.toContain('pam_apply_v2');
  });

  it('fails closed on ownership mismatch without inserting a command', async () => {
    executeMock
      .mockResolvedValueOnce({ rows: [{ ...current, device_org_id: '90000000-0000-4000-8000-000000000001' }] })
      .mockResolvedValueOnce({ rows: [] });

    await expect(processPamActuationEvent({ actuationId: current.id, generation: 4 }))
      .resolves.toBe('blocked');
    const sqlText = executeMock.mock.calls.map(([query]) => JSON.stringify(query)).join('\n');
    expect(sqlText).toContain('identity_mismatch');
    expect(sqlText).not.toContain('INSERT INTO device_commands');
  });

  it('marks a trust-denied actuation failed without inserting a command', async () => {
    executeMock
      .mockResolvedValueOnce({ rows: [current] })
      .mockResolvedValueOnce({ rows: [] });
    assertDeviceExecuteAllowedMock.mockRejectedValueOnce(
      new TrustDeniedError('TRUST_RESTRICTED', 'Partner access is restricted.', current.device_id, 'pam_apply_v2'),
    );

    await expect(processPamActuationEvent({ actuationId: current.id, generation: 4 }))
      .resolves.toBe('blocked');

    expect(executeMock).toHaveBeenCalledTimes(2);
    const sqlText = executeMock.mock.calls.map(([query]) => JSON.stringify(query)).join('\n');
    expect(sqlText).toContain('TRUST_RESTRICTED');
    expect(sqlText).not.toContain('INSERT INTO device_commands');
  });

  it('uses the builder as the only expired-apply authority', async () => {
    executeMock
      .mockResolvedValueOnce({ rows: [{ ...current, expires_at: new Date(canonical.apply.serverTime) }] })
      .mockResolvedValueOnce({ rows: [] });

    await expect(processPamActuationEvent({ actuationId: current.id, generation: 4 }))
      .resolves.toBe('blocked');
    expect(executeMock).toHaveBeenCalledTimes(2);
    const sqlText = executeMock.mock.calls.map(([query]) => JSON.stringify(query)).join('\n');
    expect(sqlText).toContain('expired_before_dispatch');
    expect(sqlText).not.toContain('INSERT INTO device_commands');
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
