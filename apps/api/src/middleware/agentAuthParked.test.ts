import { describe, expect, it } from 'vitest';
import { isParkedAllowedAgentPath, PARKED_ALLOWED_ACTIONS } from './agentAuthParked';

const AGENT = 'agent-A';
const CMD = '6f1c7a52-8d0e-4b8f-9a55-0f5a3d1c2b7e';

function segments(path: string): string[] {
  return path.split('/').filter(Boolean);
}

describe('isParkedAllowedAgentPath', () => {
  const allowed = [
    `/api/v1/agents/${AGENT}/heartbeat`,
    `/api/v1/agents/${AGENT}/rotate-token`,
    `/api/v1/agents/${AGENT}/rotate-token/confirm`,
    `/api/v1/agents/${AGENT}/commands`,
    `/api/v1/agents/${AGENT}/commands/${CMD}/result`,
    `/api/v1/agents/${AGENT}/uninstall-intent`,
  ];

  it.each(allowed)('admits %s', (path) => {
    expect(isParkedAllowedAgentPath(segments(path), AGENT)).toBe(true);
  });

  const denied = [
    `/api/v1/agents/${AGENT}/logs`,
    `/api/v1/agents/${AGENT}/config`,
    `/api/v1/agents/${AGENT}/inventory`,
    `/api/v1/agents/${AGENT}/hardware`,
    `/api/v1/agents/${AGENT}/security/recovery-keys`,
    `/api/v1/agents/${AGENT}/elevation-requests`,
    `/api/v1/agents/${AGENT}/unifi-collectors`,
    `/api/v1/agents/${AGENT}/monitoring-results`,
    `/api/v1/agents/${AGENT}/commands/${CMD}`,
    `/api/v1/agents/${AGENT}/commands/${CMD}/pam-observations`,
    `/api/v1/agents/${AGENT}/rotate-token/extra`,
    `/api/v1/agents/${AGENT}/heartbeat/extra`,
    `/api/v1/agents/${AGENT}/uninstall-intent/extra`,
    `/api/v1/agents/${AGENT}`,
    `/api/v1/agents/agent-B/heartbeat`,
    `/api/v1/agents/agent-B/commands/${CMD}/result`,
    `/api/v1/ext/foo/agent/${AGENT}/anything`,
    `/api/v1/ext/foo/agent/${AGENT}/heartbeat`,
    `/api/v1/ext/foo/agent/${AGENT}/agents/${AGENT}/heartbeat`,
    `/api/v1/workspace/agent/${AGENT}/crawl-config`,
    `/agents/${AGENT}/heartbeat`,
    `/api/v2/agents/${AGENT}/heartbeat`,
  ];

  it.each(denied)('refuses %s', (path) => {
    expect(isParkedAllowedAgentPath(segments(path), AGENT)).toBe(false);
  });

  it('is a positive list of exactly the rotation and lifecycle actions', () => {
    expect([...PARKED_ALLOWED_ACTIONS].sort()).toEqual(
      ['commands', 'heartbeat', 'rotate-token', 'uninstall-intent'],
    );
  });
});
