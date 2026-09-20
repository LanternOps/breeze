import { beforeEach, describe, expect, it, vi } from 'vitest';

const { dispatchMock } = vi.hoisted(() => ({ dispatchMock: vi.fn() }));
vi.mock('../db', () => ({ db: { update: vi.fn() } }));
vi.mock('./scriptDispatch', () => ({ dispatchScriptToDevice: dispatchMock }));

import { executeCommandAction } from './automationRuntime';

function buildContext(): Parameters<typeof executeCommandAction>[2] {
  return {
    automation: { id: 'automation-1', orgId: 'org-1', name: 'Service watch', createdBy: 'user-1', managedByAgentId: null },
    runId: '99999999-8888-4777-8666-555555555555',
    device: {
      id: 'device-1', orgId: 'org-1', hostname: 'HOST-1', displayName: null,
      osType: 'windows', status: 'online', agentId: 'agent-1', siteId: 'site-1', customFields: {},
    },
    scriptsById: new Map(),
    channelsById: new Map(),
    variableScope: { orgIds: new Set(['org-1']) },
  };
}

describe('executeCommandAction — agent-local restart_service', () => {
  beforeEach(() => {
    dispatchMock.mockReset().mockResolvedValue({
      ok: true, commandId: 'cmd-1', delivered: true, deliveryOutcome: 'sent',
    });
  });

  it.each(['', '   '])('records success without dispatching a blank restart command %j', async (command) => {
    const result = await executeCommandAction({ type: 'execute_command', kind: 'restart_service', command }, 0, buildContext());
    expect(result.outcome).toEqual({ status: 'succeeded' });
    expect(result.log).toMatchObject({
      message: 'restart_service handled by the agent watch; no server-side command',
      level: 'info', actionIndex: 0,
    });
    expect(dispatchMock).not.toHaveBeenCalled();
  });

  it('still dispatches a hand-authored restart command', async () => {
    const result = await executeCommandAction({
      type: 'execute_command', kind: 'restart_service', command: 'Restart-Service Spooler',
    }, 0, buildContext());
    expect(result.outcome).toMatchObject({ status: 'delivered', commandId: 'cmd-1' });
    expect(dispatchMock).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({
      source: expect.objectContaining({ kind: 'raw', content: 'Restart-Service Spooler' }),
    }));
  });
});
