import { beforeEach, describe, expect, it, vi } from 'vitest';

const { queueCommandForExecutionMock, createAuditLogAsyncMock, encryptMock } = vi.hoisted(() => ({
  queueCommandForExecutionMock: vi.fn<(...args: unknown[]) => Promise<unknown>>(),
  createAuditLogAsyncMock: vi.fn<(entry: Record<string, unknown>) => Promise<void>>(async () => undefined),
  encryptMock: vi.fn((_type: string, payload: Record<string, unknown>) => ({ ...payload, token: 'enc:' + String(payload.token) })),
}));

vi.mock('./commandQueue', () => ({
  queueCommandForExecution: (...args: unknown[]) => queueCommandForExecutionMock(...(args as [])),
}));
vi.mock('./auditService', () => ({
  createAuditLogAsync: (entry: Record<string, unknown>) => createAuditLogAsyncMock(entry),
}));
vi.mock('./sensitiveCommandPayload', async (importOriginal) => {
  const actual = await importOriginal<typeof import('./sensitiveCommandPayload')>();
  return { ...actual, encryptSensitivePayloadFields: encryptMock };
});

import { CommandTypes } from './commandTypes';
import { TERMINAL_PAYLOAD_STRIP_KEYS, hasSensitivePayload } from './sensitiveCommandPayload';
import { bareMetalRebuildPayloadSchema, queueBareMetalRebuild } from './bareMetalRebuildCommand';

const ORG_ID = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc';
const HOST_ID = 'dddddddd-dddd-4ddd-8ddd-dddddddddddd';
const RECOVERY_ID = 'aaaaaaaa-1111-4aaa-8aaa-aaaaaaaaaaaa';
const USER_ID = 'bbbbbbbb-2222-4bbb-8bbb-bbbbbbbbbbbb';

const validPayload = {
  recoveryId: RECOVERY_ID,
  token: `brz_rec_${'a'.repeat(64)}`,
  server: 'https://breeze.example.com',
  target: { kind: 'vhdx' as const, path: '/srv/rebuild/dev-1.vhdx', imageSizeBytes: 64 * 1024 ** 3 },
  identity: 'new' as const,
};

describe('CommandTypes.BARE_METAL_REBUILD (W05a)', () => {
  it('is the literal bare_metal_rebuild', () => {
    expect(CommandTypes.BARE_METAL_REBUILD).toBe('bare_metal_rebuild');
  });

  it('is a sensitive-payload command whose token is erased at terminal', () => {
    // The payload carries a server-minted recovery token: encrypt at rest and
    // strip on every terminal writer, like encryption_rotate_key's password.
    expect(hasSensitivePayload('bare_metal_rebuild')).toBe(true);
    expect(TERMINAL_PAYLOAD_STRIP_KEYS).toContain('token');
  });
});

describe('bareMetalRebuildPayloadSchema', () => {
  it('accepts the documented payload', () => {
    expect(bareMetalRebuildPayloadSchema.safeParse(validPayload).success).toBe(true);
  });

  it('rejects a relative target path', () => {
    const parsed = bareMetalRebuildPayloadSchema.safeParse({
      ...validPayload,
      target: { ...validPayload.target, path: 'out/dev-1.vhdx' },
    });
    expect(parsed.success).toBe(false);
  });

  it('rejects a missing token', () => {
    const { token: _token, ...noToken } = validPayload;
    expect(bareMetalRebuildPayloadSchema.safeParse(noToken).success).toBe(false);
    expect(bareMetalRebuildPayloadSchema.safeParse({ ...validPayload, token: '' }).success).toBe(false);
  });

  it('rejects a disk target — only image conversions run on a rebuild host', () => {
    expect(bareMetalRebuildPayloadSchema.safeParse({
      ...validPayload,
      target: { kind: 'disk', path: '/dev/sda' },
    }).success).toBe(false);
  });
});

describe('queueBareMetalRebuild', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    queueCommandForExecutionMock.mockResolvedValue({ command: { id: 'cmd-1', status: 'sent' } });
  });

  it('queues bare_metal_rebuild to the host device inside the org, with the token encrypted at rest', async () => {
    const out = await queueBareMetalRebuild({ orgId: ORG_ID, hostDeviceId: HOST_ID, payload: validPayload, userId: USER_ID });

    expect(out).toEqual({ command: { id: 'cmd-1', status: 'sent' }, error: null });
    expect(encryptMock).toHaveBeenCalledWith('bare_metal_rebuild', validPayload);
    expect(queueCommandForExecutionMock).toHaveBeenCalledTimes(1);
    const [deviceId, type, payload, options] = queueCommandForExecutionMock.mock.calls[0]!;
    expect(deviceId).toBe(HOST_ID);
    expect(type).toBe('bare_metal_rebuild');
    expect(payload).toMatchObject({ recoveryId: RECOVERY_ID, token: `enc:${validPayload.token}`, target: validPayload.target });
    expect(options).toEqual({ userId: USER_ID, expectedOrgId: ORG_ID });
  });

  it('audits bmr.rebuild.command with the recovery, host and target — never the token', async () => {
    await queueBareMetalRebuild({ orgId: ORG_ID, hostDeviceId: HOST_ID, payload: validPayload, userId: USER_ID });

    expect(createAuditLogAsyncMock).toHaveBeenCalledTimes(1);
    const entry = createAuditLogAsyncMock.mock.calls[0]![0];
    expect(entry).toMatchObject({
      orgId: ORG_ID,
      action: 'bmr.rebuild.command',
      resourceType: 'bare_metal_recovery',
      resourceId: RECOVERY_ID,
      actorId: USER_ID,
      result: 'success',
      details: { recoveryId: RECOVERY_ID, hostDeviceId: HOST_ID, commandId: 'cmd-1', target: validPayload.target },
    });
    expect(JSON.stringify(entry)).not.toContain(validPayload.token);
  });

  it('returns the queue error and records the dispatch failure in the audit trail', async () => {
    queueCommandForExecutionMock.mockResolvedValue({ error: 'Device is offline' });

    const out = await queueBareMetalRebuild({ orgId: ORG_ID, hostDeviceId: HOST_ID, payload: validPayload });

    expect(out).toEqual({ command: null, error: 'Device is offline' });
    expect(createAuditLogAsyncMock).toHaveBeenCalledTimes(1);
    expect(createAuditLogAsyncMock.mock.calls[0]![0]).toMatchObject({ action: 'bmr.rebuild.command', result: 'failure', errorMessage: 'Device is offline' });
  });
});
