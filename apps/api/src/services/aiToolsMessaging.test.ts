import { beforeEach, describe, expect, it, vi } from 'vitest';
import { z } from 'zod';

const executeSend = vi.fn();
const listMessages = vi.fn();
const getDetail = vi.fn();

vi.mock('../routes/endpointMessages/send', () => ({
  executeEndpointMessageSend: (...a: unknown[]) => executeSend(...a),
}));
vi.mock('./endpointMessaging/history', () => ({
  HISTORY_PAGE_MAX: 100,
  listEndpointMessages: (...a: unknown[]) => listMessages(...a),
  getEndpointMessageDetail: (...a: unknown[]) => getDetail(...a),
  decodeHistoryCursor: (raw: string | undefined) => (raw === 'bad' ? 'invalid' : undefined),
}));
vi.mock('./permissions', async (importOriginal) => {
  const actual = await importOriginal<typeof import('./permissions')>();
  return { ...actual, getUserPermissions: vi.fn().mockResolvedValue({ permissions: [], partnerId: null, orgId: 'o-1', roleId: 'r', scope: 'organization' }) };
});

import { registerMessagingTools } from './aiToolsMessaging';
import { toolInputSchemas } from './aiToolSchemas';
import { checkGuardrails } from './aiGuardrails';
import type { AiTool } from './aiTools';
import type { AuthContext } from '../middleware/auth';

const ORIGIN = { kind: 'ai_assistant' as const, sessionId: 'sess-8742' };
const DEVICE = '11111111-1111-4111-8111-111111111111';

function makeAuth(over: Partial<AuthContext> = {}): AuthContext {
  return {
    principal: { kind: 'user_session' },
    user: { id: 'u-1', email: 'u@example.test', name: 'U', isPlatformAdmin: false },
    token: { sub: 'u-1', email: 'u@example.test', roleId: null, orgId: 'o-1', partnerId: null, scope: 'organization', type: 'access', mfa: true },
    partnerId: null,
    orgId: 'o-1',
    scope: 'organization',
    accessibleOrgIds: ['o-1'],
    canAccessOrg: (id: string) => id === 'o-1',
    orgCondition: () => undefined,
    aiOrigin: ORIGIN,
    ...over,
  } as unknown as AuthContext;
}

function tool(): AiTool {
  const m = new Map<string, AiTool>();
  registerMessagingTools(m);
  return m.get('send_endpoint_message')!;
}

const sendInput = {
  action: 'send',
  targets: { deviceIds: [DEVICE] },
  title: 'Reboot tonight',
  body: 'Please save your work.',
  severity: 'info',
  requiresAck: false,
};

beforeEach(() => {
  executeSend.mockReset();
  listMessages.mockReset();
  getDetail.mockReset();
});

describe('send_endpoint_message guardrails', () => {
  it('send always needs approval (tier 3), never auto-execute', () => {
    const g = checkGuardrails('send_endpoint_message', sendInput);
    expect(g.tier).toBe(3);
    expect(g.requiresApproval).toBe(true);
    expect(g.approvalScope).toBe('supervised');
  });
  it.each(['list', 'get'])('%s is read-only tier 1', (action) => {
    const g = checkGuardrails('send_endpoint_message', { action });
    expect(g.tier).toBe(1);
    expect(g.requiresApproval).toBe(false);
  });
});

describe('send_endpoint_message schema', () => {
  function walk(schema: unknown, seen = new Set<unknown>()): string[] {
    if (!schema || typeof schema !== 'object' || seen.has(schema)) return [];
    seen.add(schema);
    const out: string[] = [];
    if (schema instanceof z.ZodUndefined) out.push('ZodUndefined');
    const def = (schema as { _def?: Record<string, unknown>; def?: Record<string, unknown> })._def
      ?? (schema as { def?: Record<string, unknown> }).def;
    const shape = (schema as { shape?: Record<string, unknown> }).shape;
    if (shape) for (const v of Object.values(shape)) out.push(...walk(v, seen));
    if (def) for (const v of Object.values(def)) {
      if (Array.isArray(v)) v.forEach((x) => out.push(...walk(x, seen)));
      else out.push(...walk(typeof v === 'function' ? undefined : v, seen));
    }
    return out;
  }

  it('is registered and contains no ZodUndefined', () => {
    const schema = toolInputSchemas.send_endpoint_message;
    expect(schema).toBeDefined();
    expect(walk(schema)).toEqual([]);
  });
  it('rejects unknown keys and a non-enum action', () => {
    const schema = toolInputSchemas.send_endpoint_message!;
    expect(schema.safeParse({ ...sendInput, action: 'retract' }).success).toBe(false);
    expect(schema.safeParse({ ...sendInput, bogus: 1 }).success).toBe(false);
    expect(schema.safeParse(sendInput).success).toBe(true);
  });
});

describe('send_endpoint_message handler', () => {
  it('is tier 3 in the tool definition and domain tickets', () => {
    expect(tool().tier).toBe(3);
  });

  it('send carries aiOrigin into executeEndpointMessageSend and mints a messageId', async () => {
    executeSend.mockResolvedValue({ status: 200, body: { batchId: 'b-1', deviceCount: 1, results: [] } });
    const out = JSON.parse(await tool().handler(sendInput, makeAuth()));
    expect(out).toMatchObject({ batchId: 'b-1', deviceCount: 1 });
    expect(executeSend).toHaveBeenCalledTimes(1);
    const [ctx, input] = executeSend.mock.calls[0]!;
    expect(ctx.auth.aiOrigin).toEqual(ORIGIN);
    expect(input.messageId).toMatch(/^[0-9a-f-]{36}$/);
    expect(input.title).toBe('Reboot tonight');
    expect(input.action).toBeUndefined();
  });

  it('send refuses when the auth has no aiOrigin', async () => {
    const out = JSON.parse(await tool().handler(sendInput, makeAuth({ aiOrigin: undefined })));
    expect(out.error).toBeTruthy();
    expect(executeSend).not.toHaveBeenCalled();
  });

  it('send refuses an autonomous ai_agent principal', async () => {
    const out = JSON.parse(await tool().handler(sendInput, makeAuth({
      principal: { kind: 'ai_agent', agentId: 'a', runId: 'r' },
    } as never)));
    expect(out.error).toBeTruthy();
    expect(executeSend).not.toHaveBeenCalled();
  });

  it.each([
    [{ kind: 'api_key', apiKeyId: 'k' }],
    [{ kind: 'oauth_grant', grantId: 'g' }],
    [{ kind: 'system', reason: 'x' }],
  ])('send runs only for a human chat session: refuses principal %o (unattended MCP opt-in cannot skip approval)', async (principal) => {
    const out = JSON.parse(await tool().handler(sendInput, makeAuth({ principal } as never)));
    expect(out.error).toBeTruthy();
    expect(executeSend).not.toHaveBeenCalled();
  });

  it('the model cannot self-confirm a large send: confirmedCount is never forwarded', async () => {
    executeSend.mockResolvedValue({ status: 200, body: { batchId: 'b', deviceCount: 1, results: [] } });
    await tool().handler({ ...sendInput, confirmedCount: 500 }, makeAuth());
    if (executeSend.mock.calls.length > 0) {
      expect(executeSend.mock.calls[0]![1].confirmedCount).toBeUndefined();
    }
  });

  it('a send that resolves above the confirmation threshold is refused with a console pointer', async () => {
    executeSend.mockResolvedValue({ status: 409, body: { error: 'confirmation_required', deviceCount: 250 } });
    const out = JSON.parse(await tool().handler(sendInput, makeAuth()));
    expect(out.error).toBe('confirmation_required');
    expect(out.message).toMatch(/100 devices/);
  });

  it('the approval card names severity, the target selector and acknowledgement, never the text', () => {
    const r = checkGuardrails('send_endpoint_message', {
      ...sendInput, severity: 'critical', requiresAck: true, targets: { siteIds: [DEVICE, DEVICE] }, title: 'secret title', body: 'secret body',
    });
    expect(r.description).toBe('Show a critical message to every device in 2 site(s), acknowledgement required. Review the title and body in the details before approving.');
    expect(r.description).not.toContain('secret');
  });

  it('is denied to autonomous agents above any allowlist (AGENT_HUMAN_ONLY_TOOLS)', async () => {
    const { AGENT_HUMAN_ONLY_TOOLS } = await import('./aiToolExposure');
    expect(AGENT_HUMAN_ONLY_TOOLS.has('send_endpoint_message')).toBe(true);
  });

  it('send surfaces a refused outcome as a tool error', async () => {
    executeSend.mockResolvedValue({ status: 429, body: { error: 'rate_limited' } });
    const out = JSON.parse(await tool().handler(sendInput, makeAuth()));
    expect(out.error).toBe('rate_limited');
    expect(out.status).toBe(429);
  });

  it('send without targets is a tool error (action-specific requirements live in the handler)', async () => {
    const out = JSON.parse(await tool().handler({ ...sendInput, targets: undefined }, makeAuth()));
    expect(out.error).toBeTruthy();
    expect(executeSend).not.toHaveBeenCalled();
  });

  it('send rejects invalid content before calling the route', async () => {
    const out = JSON.parse(await tool().handler({ ...sendInput, title: '' }, makeAuth()));
    expect(out.error).toBeTruthy();
    expect(executeSend).not.toHaveBeenCalled();
  });

  it('list delegates with a clamped limit', async () => {
    listMessages.mockResolvedValue({ items: [], nextCursor: null });
    const out = JSON.parse(await tool().handler({ action: 'list', limit: 5000 }, makeAuth()));
    expect(out).toEqual({ items: [], nextCursor: null });
    expect(listMessages.mock.calls[0]![0].limit).toBe(100);
  });

  it('get returns not-found as a tool error', async () => {
    getDetail.mockResolvedValue(null);
    const out = JSON.parse(await tool().handler({ action: 'get', messageId: DEVICE }, makeAuth()));
    expect(out.error).toBe('not_found');
  });
});

describe('send_endpoint_message tenancy axes (site + exact device)', () => {
  const SITE_A = '22222222-2222-4222-8222-222222222222';
  const apiKeyAuth = (over: Partial<AuthContext> = {}) =>
    makeAuth({ principal: { kind: 'api_key', apiKeyId: 'k' }, allowedSiteIds: [SITE_A], ...over } as never);

  it("list by a site-clamped API key narrows history to the key's sites (no loaded permissions)", async () => {
    listMessages.mockResolvedValue({ items: [], nextCursor: null });
    await tool().handler({ action: 'list' }, apiKeyAuth());
    expect(listMessages.mock.calls[0]![0].permissions).toEqual({ allowedSiteIds: [SITE_A] });
  });

  it("get by a site-clamped API key narrows the delivery detail to the key's sites", async () => {
    getDetail.mockResolvedValue(null);
    await tool().handler({ action: 'get', messageId: DEVICE }, apiKeyAuth());
    expect(getDetail.mock.calls[0]![0].permissions).toEqual({ allowedSiteIds: [SITE_A] });
  });

  it('a site-clamped key with an EMPTY site list sees nothing, not everything', async () => {
    listMessages.mockResolvedValue({ items: [], nextCursor: null });
    await tool().handler({ action: 'list' }, apiKeyAuth({ allowedSiteIds: [] }));
    expect(listMessages.mock.calls[0]![0].permissions).toEqual({ allowedSiteIds: [] });
  });

  it('an unrestricted API key reads unnarrowed (no site ceiling to apply)', async () => {
    listMessages.mockResolvedValue({ items: [], nextCursor: null });
    await tool().handler({ action: 'list' }, apiKeyAuth({ allowedSiteIds: undefined }));
    expect(listMessages.mock.calls[0]![0].permissions?.allowedSiteIds).toBeUndefined();
  });

  it("a user session narrows on its loaded permissions' site list", async () => {
    const { getUserPermissions } = await import('./permissions');
    vi.mocked(getUserPermissions).mockResolvedValueOnce({
      permissions: [], partnerId: null, orgId: 'o-1', roleId: 'r', scope: 'organization', allowedSiteIds: [SITE_A],
    });
    listMessages.mockResolvedValue({ items: [], nextCursor: null });
    await tool().handler({ action: 'list' }, makeAuth());
    expect(listMessages.mock.calls[0]![0].permissions.allowedSiteIds).toEqual([SITE_A]);
  });

  it('send by a site-restricted session whose permissions cannot be loaded fails closed', async () => {
    const { getUserPermissions } = await import('./permissions');
    vi.mocked(getUserPermissions).mockResolvedValueOnce(null);
    const out = JSON.parse(await tool().handler(sendInput, makeAuth({ allowedSiteIds: [SITE_A] })));
    expect(out.error).toBeTruthy();
    expect(executeSend).not.toHaveBeenCalled();
  });

  it.each(['send', 'list', 'get'])('%s fails closed for a caller with an exact-device ceiling', async (action) => {
    const out = JSON.parse(await tool().handler(
      { ...sendInput, action, messageId: DEVICE },
      makeAuth({ allowedDeviceIds: [DEVICE] } as never),
    ));
    expect(out.error).toBeTruthy();
    expect(executeSend).not.toHaveBeenCalled();
    expect(listMessages).not.toHaveBeenCalled();
    expect(getDetail).not.toHaveBeenCalled();
  });
});

describe('aiTools registry', () => {
  it('contains send_endpoint_message', async () => {
    const { aiTools } = await import('./aiTools');
    expect(aiTools.has('send_endpoint_message')).toBe(true);
  });
});
