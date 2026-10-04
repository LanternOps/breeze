import { describe, expect, it, vi, beforeEach } from 'vitest';

// The service is mocked so these tests see exactly what the tool hands to it:
// get_monitor shows a network_check target as scheme + host and header values
// masked, and writing those shown values back must not replace the stored ones.
const { getMonitorDefinitionMock, updateMonitorDefinitionMock, createMonitorDefinitionMock } = vi.hoisted(() => ({
  getMonitorDefinitionMock: vi.fn(),
  updateMonitorDefinitionMock: vi.fn(),
  createMonitorDefinitionMock: vi.fn(),
}));
vi.mock('./monitors/monitorService', async (importOriginal) => ({
  ...(await importOriginal<typeof import('./monitors/monitorService')>()),
  getMonitorDefinition: getMonitorDefinitionMock,
  updateMonitorDefinition: updateMonitorDefinitionMock,
  createMonitorDefinition: createMonitorDefinitionMock,
}));

import { registerMonitorTools } from './aiToolsMonitors';
import type { AuthContext } from '../middleware/auth';
import type { AiTool } from './aiTools';
import { presentEndpointTarget } from '../utils/endpointDisplay';

const ORG = '11111111-1111-4111-8111-111111111111';
const PARTNER = '22222222-2222-4222-8222-222222222222';
const STORED_URL = 'https://ops:pw@status.example.com/hooks/T1/B1/abc123?token=xyz789';
const SHOWN = presentEndpointTarget(STORED_URL);

function auth(): AuthContext {
  return {
    principal: 'user',
    user: { id: 'u1', email: 'a@b.c', name: 'A', isPlatformAdmin: false },
    token: null,
    partnerId: PARTNER,
    orgId: ORG,
    scope: 'organization',
    accessibleOrgIds: [ORG],
    partnerOrgAccess: null,
    orgCondition: () => undefined,
    canAccessOrg: (orgId: string) => orgId === ORG,
  } as unknown as AuthContext;
}

async function manage(input: Record<string, unknown>) {
  const reg = new Map<string, AiTool>();
  registerMonitorTools(reg);
  return JSON.parse(await reg.get('manage_monitor_definitions')!.handler(input, auth()));
}

function storedMonitor(conditionOverrides: Record<string, unknown> = {}) {
  return {
    id: 'm1', orgId: ORG, partnerId: null, name: 'Status page', kind: 'network_check',
    condition: {
      checkType: 'http_check', target: STORED_URL, method: 'GET',
      headers: { Authorization: 'Bearer stored-value', 'X-Trace': 'on' },
      ...conditionOverrides,
    },
    responses: [], recurrenceActions: [],
  };
}

function lastUpdateCondition(): Record<string, unknown> {
  const call = updateMonitorDefinitionMock.mock.calls.at(-1);
  if (!call) throw new Error('updateMonitorDefinition was not called');
  return (call[1] as { condition: Record<string, unknown> }).condition;
}

beforeEach(() => {
  vi.clearAllMocks();
  getMonitorDefinitionMock.mockResolvedValue(storedMonitor());
  updateMonitorDefinitionMock.mockImplementation(async (_id: string, patch: Record<string, unknown>) => ({
    ...storedMonitor(), ...patch,
  }));
  createMonitorDefinitionMock.mockImplementation(async (input: Record<string, unknown>) => ({ id: 'new', orgId: ORG, partnerId: null, ...input }));
});

describe('manage_monitor_definitions update with displayed endpoint values', () => {
  it('keeps the stored URL when the displayed target is written back', async () => {
    const result = await manage({
      action: 'update', monitorId: 'm1',
      definition: { condition: { checkType: 'http_check', target: SHOWN.target, method: 'HEAD' } },
    });
    expect(result.error).toBeUndefined();
    expect(lastUpdateCondition().target).toBe(STORED_URL);
    expect(lastUpdateCondition().method).toBe('HEAD');
  });

  it('keeps the stored URL when the displayed target comes back with its fingerprint', async () => {
    const result = await manage({
      action: 'update', monitorId: 'm1',
      definition: {
        condition: { checkType: 'http_check', target: SHOWN.target, targetFingerprint: SHOWN.fingerprint, method: 'GET' },
      },
    });
    expect(result.error).toBeUndefined();
    const condition = lastUpdateCondition();
    expect(condition.target).toBe(STORED_URL);
    expect(condition).not.toHaveProperty('targetFingerprint');
  });

  it('keeps a stored header value written back as [REDACTED]', async () => {
    const result = await manage({
      action: 'update', monitorId: 'm1',
      definition: {
        condition: {
          checkType: 'http_check', target: SHOWN.target,
          headers: { Authorization: '[REDACTED]', 'X-Trace': 'off' },
        },
      },
    });
    expect(result.error).toBeUndefined();
    expect(lastUpdateCondition().headers).toEqual({ Authorization: 'Bearer stored-value', 'X-Trace': 'off' });
  });

  it('rejects a masked header when the target moves to another origin, leaving the stored row alone', async () => {
    const result = await manage({
      action: 'update', monitorId: 'm1',
      definition: {
        condition: { checkType: 'http_check', target: 'https://other.example.net/health', headers: { Authorization: '[REDACTED]' } },
      },
    });
    expect(result.error).toMatch(/Authorization/);
    expect(updateMonitorDefinitionMock).not.toHaveBeenCalled();
  });

  it('rejects a fully masked header map when the target moves to another origin', async () => {
    const result = await manage({
      action: 'update', monitorId: 'm1',
      definition: { condition: { checkType: 'http_check', target: 'https://other.example.net/health', headers: '[REDACTED]' } },
    });
    expect(result.error).toMatch(/header/i);
    expect(updateMonitorDefinitionMock).not.toHaveBeenCalled();
  });

  it('keeps a stored header when the target changes path on the same origin', async () => {
    const result = await manage({
      action: 'update', monitorId: 'm1',
      definition: {
        condition: { checkType: 'http_check', target: 'https://status.example.com/v2/health', headers: { Authorization: '[REDACTED]' } },
      },
    });
    expect(result.error).toBeUndefined();
    expect(lastUpdateCondition().target).toBe('https://status.example.com/v2/health');
    expect(lastUpdateCondition().headers).toEqual({ Authorization: 'Bearer stored-value' });
  });

  it('keeps a stored header when the condition omits the target', async () => {
    const result = await manage({
      action: 'update', monitorId: 'm1',
      definition: { condition: { checkType: 'http_check', headers: { Authorization: '[REDACTED]' } } },
    });
    expect(result.error).toBeUndefined();
    expect(lastUpdateCondition().headers).toEqual({ Authorization: 'Bearer stored-value' });
  });

  it('stores a genuinely new full URL', async () => {
    const result = await manage({
      action: 'update', monitorId: 'm1',
      definition: { condition: { checkType: 'http_check', target: 'https://other.example.com/health' } },
    });
    expect(result.error).toBeUndefined();
    expect(lastUpdateCondition().target).toBe('https://other.example.com/health');
  });

  it('rejects a displayed value whose fingerprint does not match the stored URL', async () => {
    const result = await manage({
      action: 'update', monitorId: 'm1',
      definition: { condition: { checkType: 'http_check', target: 'https://other.example.com', targetFingerprint: SHOWN.fingerprint } },
    });
    expect(result.error).toMatch(/full URL/);
    expect(updateMonitorDefinitionMock).not.toHaveBeenCalled();
  });

  it('rejects a masked header value for a header that is not stored', async () => {
    const result = await manage({
      action: 'update', monitorId: 'm1',
      definition: { condition: { checkType: 'http_check', target: SHOWN.target, headers: { 'X-Api-Key': '[REDACTED]' } } },
    });
    expect(result.error).toContain('X-Api-Key');
    expect(updateMonitorDefinitionMock).not.toHaveBeenCalled();
  });

  it('rejects a masked value elsewhere in the definition instead of storing it', async () => {
    const result = await manage({
      action: 'update', monitorId: 'm1',
      definition: {
        responses: [{ type: 'run_script', scriptId: '33333333-3333-4333-8333-333333333333', parameters: { apiToken: '[REDACTED]' } }],
      },
    });
    expect(result.error).toMatch(/masked/i);
    expect(updateMonitorDefinitionMock).not.toHaveBeenCalled();
  });

  it('leaves enable/disable untouched', async () => {
    const result = await manage({ action: 'disable', monitorId: 'm1' });
    expect(result.error).toBeUndefined();
    expect(updateMonitorDefinitionMock).toHaveBeenCalledWith('m1', expect.objectContaining({ enabled: false }), expect.anything());
  });
});

describe('manage_monitor_definitions create with displayed endpoint values', () => {
  function definition(condition: Record<string, unknown>) {
    return { name: 'Status page', kind: 'network_check', severity: 'high', condition: { checkType: 'http_check', ...condition } };
  }

  it('rejects a fingerprinted target', async () => {
    const result = await manage({
      action: 'create',
      definition: definition({ target: SHOWN.target, targetFingerprint: SHOWN.fingerprint }),
    });
    expect(result.error).toMatch(/full URL/);
    expect(createMonitorDefinitionMock).not.toHaveBeenCalled();
  });

  it('rejects a placeholder target', async () => {
    const result = await manage({ action: 'create', definition: definition({ target: '[invalid-url]' }) });
    expect(result.error).toMatch(/full URL/);
    expect(createMonitorDefinitionMock).not.toHaveBeenCalled();
  });

  it('rejects a masked header value', async () => {
    const result = await manage({
      action: 'create',
      definition: definition({ target: 'https://status.example.com/health', headers: { Authorization: '[REDACTED]' } }),
    });
    expect(result.error).toContain('Authorization');
    expect(createMonitorDefinitionMock).not.toHaveBeenCalled();
  });

  it('creates with a full URL', async () => {
    const result = await manage({ action: 'create', definition: definition({ target: 'https://status.example.com/health' }) });
    expect(result.error).toBeUndefined();
    expect(createMonitorDefinitionMock).toHaveBeenCalledTimes(1);
  });
});
