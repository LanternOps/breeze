import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * Regression coverage for the review finding on qa/sweep-post-v0.110.0:
 * `execute_command`'s description tells the model to send
 * `payload: { serviceName }` for start/stop/restart_service (matching
 * `manage_services`' own input schema), but unlike `manage_services` —
 * which normalizes `serviceName` to `payload.name` before calling
 * `executeCommand` — `execute_command`'s handler forwarded `input.payload`
 * verbatim. The agent (`agent/internal/remote/tools/services.go`) reads only
 * `payload["name"]`, so a model-issued `execute_command` call using
 * `serviceName` always failed silently on the device side, even though the
 * approval headline (`aiGuardrails.ts`'s `serviceNameFromPayload`) confidently
 * named the service.
 *
 * This suite asserts `execute_command` normalizes `serviceName` -> `name` for
 * the three service commandTypes before dispatching, while still accepting a
 * caller that already sends `name` directly.
 */

const mocks = vi.hoisted(() => ({
  executeCommand: vi.fn(async (..._args: unknown[]) => ({ status: 'completed' })),
}));
const { executeCommand } = mocks;

vi.mock('../db', () => ({
  runOutsideDbContext: vi.fn((fn: any) => fn()),
  withDbAccessContext: vi.fn(async (_ctx: unknown, fn: () => Promise<unknown>) => fn()),
  withSystemDbAccessContext: vi.fn(async (fn: () => Promise<unknown>) => fn()),
  db: { select: vi.fn() },
}));

vi.mock('./commandQueue', async (importOriginal) => {
  const actual = await importOriginal<typeof import('./commandQueue')>();
  return { ...actual, executeCommand: mocks.executeCommand };
});

import { db } from '../db';
import { registerScriptTools } from './aiToolsScripts';
import type { AiTool } from './aiTools';
import type { AuthContext } from '../middleware/auth';

const DEVICE_ID = '33333333-3333-3333-3333-333333333333';

function toolMap(): Map<string, AiTool> {
  const map = new Map<string, AiTool>();
  registerScriptTools(map);
  return map;
}

function makeAuth(): AuthContext {
  return {
    user: { id: 'u1', email: 'a@b.c', name: 'A', isPlatformAdmin: false },
    token: {} as any,
    partnerId: null,
    orgId: 'org-1',
    scope: 'organization',
    accessibleOrgIds: ['org-1'],
    orgCondition: () => undefined,
    canAccessOrg: () => true,
    canAccessSite: () => true,
  } as unknown as AuthContext;
}

function mockOnlineDevice() {
  (db.select as ReturnType<typeof vi.fn>).mockReturnValue({
    from: () => ({
      where: () => ({
        limit: () => Promise.resolve([
          { id: DEVICE_ID, hostname: 'dev1', siteId: null, status: 'online', orgId: 'org-1' },
        ]),
      }),
    }),
  });
}

beforeEach(() => {
  vi.clearAllMocks();
  mockOnlineDevice();
});

describe('execute_command — service payload normalization', () => {
  const serviceCommandTypes = ['start_service', 'stop_service', 'restart_service'];

  it.each(serviceCommandTypes)(
    '%s: normalizes payload.serviceName to payload.name (what the agent reads)',
    async (commandType) => {
      const tool = toolMap().get('execute_command')!;
      await tool.handler(
        { deviceId: DEVICE_ID, commandType, payload: { serviceName: 'Spooler' } },
        makeAuth(),
      );

      expect(executeCommand).toHaveBeenCalledTimes(1);
      const [, , payload] = executeCommand.mock.calls[0]!;
      expect(payload).toEqual({ name: 'Spooler' });
    },
  );

  it('still accepts payload.name directly (no serviceName sent)', async () => {
    const tool = toolMap().get('execute_command')!;
    await tool.handler(
      { deviceId: DEVICE_ID, commandType: 'restart_service', payload: { name: 'Spooler' } },
      makeAuth(),
    );

    const [, , payload] = executeCommand.mock.calls[0]!;
    expect(payload).toEqual({ name: 'Spooler' });
  });

  it('name wins if both name and serviceName are somehow present', async () => {
    const tool = toolMap().get('execute_command')!;
    await tool.handler(
      { deviceId: DEVICE_ID, commandType: 'restart_service', payload: { name: 'Real', serviceName: 'Decoy' } },
      makeAuth(),
    );

    const [, , payload] = executeCommand.mock.calls[0]!;
    expect(payload).toEqual({ name: 'Real' });
  });

  it('does not touch payload for non-service command types', async () => {
    const tool = toolMap().get('execute_command')!;
    await tool.handler(
      { deviceId: DEVICE_ID, commandType: 'kill_process', payload: { processName: 'foo.exe', pid: '123' } },
      makeAuth(),
    );

    const [, , payload] = executeCommand.mock.calls[0]!;
    expect(payload).toEqual({ processName: 'foo.exe', pid: '123' });
  });

  const selectedValues: Array<{ label: string; value: unknown }> = [
    { label: 'empty', value: '' }, { label: 'blank', value: ' ' },
    { label: 'null', value: null }, { label: 'false', value: false },
    { label: 'object', value: { nested: 'Chosen' } }, { label: 'array', value: ['Chosen'] },
    { label: 'zero display-only', value: 0 }, { label: 'finite display-only', value: 42 },
    { label: 'padded', value: ' Chosen ' }, { label: 'undefined fallback', value: undefined },
  ];
  for (const commandType of serviceCommandTypes) {
    it.each(selectedValues)(`${commandType}: $label preserves defined-name precedence without mutating input`, async ({ value }) => {
      const payload = Object.freeze({ name: value, serviceName: 'Alternate', extra: 'kept' });
      const original = structuredClone(payload);
      const input = Object.freeze({ deviceId: DEVICE_ID, commandType, payload });
      await toolMap().get('execute_command')!.handler(input, makeAuth());
      expect(executeCommand).toHaveBeenCalledTimes(1);
      expect(executeCommand.mock.calls[0]?.[2]).toEqual({ name: value === undefined ? 'Alternate' : value, extra: 'kept' });
      expect(input.payload).toEqual(original);
    });
  }

  it('retains undefined alias keys under the existing no-normalization branch', async () => {
    const payload = Object.freeze({ name: 'Chosen', serviceName: undefined });
    await toolMap().get('execute_command')!.handler({ deviceId: DEVICE_ID, commandType: 'restart_service', payload }, makeAuth());
    expect(executeCommand.mock.calls[0]?.[2]).toEqual(payload);
    expect(Object.hasOwn(executeCommand.mock.calls[0]?.[2] as object, 'serviceName')).toBe(true);
  });

  it('does not normalize service-shaped payloads on other command types', async () => {
    const payload = Object.freeze({ name: 'Chosen', serviceName: 'Alternate', pid: '123' });
    await toolMap().get('execute_command')!.handler({ deviceId: DEVICE_ID, commandType: 'kill_process', payload }, makeAuth());
    expect(executeCommand.mock.calls[0]?.[2]).toEqual(payload);
  });

  it('does not dispatch when device access is denied', async () => {
    const auth = makeAuth(); auth.canAccessSite = () => false;
    const input = Object.freeze({ deviceId: DEVICE_ID, commandType: 'restart_service', payload: Object.freeze({ name: 'Chosen', serviceName: 'Alternate' }) });
    const result = JSON.parse(await toolMap().get('execute_command')!.handler(input, auth));
    expect(result).toHaveProperty('error');
    expect(executeCommand).not.toHaveBeenCalled();
    expect(input.payload).toEqual({ name: 'Chosen', serviceName: 'Alternate' });
  });

  it('propagates the inert dispatcher failure without mutating approved input', async () => {
    const failure = new Error('synthetic dispatcher failure');
    executeCommand.mockRejectedValueOnce(failure);
    const input = Object.freeze({ deviceId: DEVICE_ID, commandType: 'restart_service', payload: Object.freeze({ name: 'Chosen', serviceName: 'Alternate' }) });
    await expect(toolMap().get('execute_command')!.handler(input, makeAuth())).rejects.toBe(failure);
    expect(executeCommand).toHaveBeenCalledTimes(1);
    expect(input.payload).toEqual({ name: 'Chosen', serviceName: 'Alternate' });
  });

});
