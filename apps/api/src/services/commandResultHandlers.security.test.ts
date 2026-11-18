/**
 * #10376: security command results must reach handleSecurityCommandResult on
 * BOTH agent transports. The REST route calls it inline; the websocket route
 * only dispatches through `commandResultHandlers`, so a type missing from that
 * registry is silently dropped for every WS-connected agent — the
 * `security_scans` row stays `running`, threats are never ingested, and an IOC
 * sweep never finishes.
 */
import { readFileSync } from 'node:fs';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const { handleSecurityCommandResultMock } = vi.hoisted(() => ({
  handleSecurityCommandResultMock: vi.fn(async () => undefined),
}));
vi.mock('../routes/agents/helpers', () => ({
  handleSecurityCommandResult: handleSecurityCommandResultMock,
}));

import { commandResultHandlers } from './commandResultHandlers';

const SECURITY_TYPES = [
  'security_collect_status',
  'security_scan',
  'security_threat_quarantine',
  'security_threat_remove',
  'security_threat_restore',
] as const;

const source = (path: string) => readFileSync(new URL(path, import.meta.url), 'utf8');

describe('security command results on the websocket transport (#10376)', () => {
  beforeEach(() => vi.clearAllMocks());

  it.each(SECURITY_TYPES)('%s is registered with the shared security result handler', async (type) => {
    const handler = commandResultHandlers[type];
    expect(handler).toBeTypeOf('function');

    const command = { id: 'cmd-1', type, deviceId: 'dev-1' } as never;
    const stdout = JSON.stringify({ scanRecordId: 'scan-1', threatsFound: 1, threats: [{ name: 'EICAR' }] });
    await handler!({
      agentId: 'agent-1',
      commandId: 'cmd-1',
      resolvedDeviceId: 'dev-1',
      command,
      // The WS envelope carries the structured `result`; the transport derives
      // `stdout` from it, and that derived stdout is what the handler parses.
      result: { status: 'completed', exitCode: 0, durationMs: 4000, stderr: 'warn', result: { threatsFound: 1 } },
      stdout,
    });

    expect(handleSecurityCommandResultMock).toHaveBeenCalledTimes(1);
    expect(handleSecurityCommandResultMock).toHaveBeenCalledWith(command, {
      status: 'completed',
      exitCode: 0,
      stdout,
      stderr: 'warn',
      durationMs: 4000,
      error: undefined,
    });
  });

  it('a failed scan (agent restarted mid-command) is forwarded as failed', async () => {
    await commandResultHandlers.security_scan!({
      agentId: 'agent-1',
      commandId: 'cmd-2',
      resolvedDeviceId: 'dev-1',
      command: { id: 'cmd-2', type: 'security_scan', deviceId: 'dev-1' } as never,
      result: { status: 'failed', error: 'agent restarted while command was running' },
      stdout: undefined,
    });
    expect(handleSecurityCommandResultMock).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ status: 'failed', error: 'agent restarted while command was running' }),
    );
  });

  it('the REST route keeps its inline call and does not ALSO dispatch security types through the registry', () => {
    const rest = source('../routes/agents/commands.ts');
    const registrySet = rest.match(/REGISTRY_DISPATCHED_COMMAND_TYPES = new Set\(\[([\s\S]*?)\]\);/);
    expect(registrySet).not.toBeNull();
    for (const type of SECURITY_TYPES) expect(registrySet![1]).not.toContain(`'${type}'`);
    expect(rest).toContain('await handleSecurityCommandResult(command, normalizedData);');
  });
});
