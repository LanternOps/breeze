/**
 * #12427 W01 T6 parity contract: `call_tool` is the same authority surface as
 * a direct `tools/call`.
 *
 * For every registry tool (each declared action, with executeTool mocked to
 * echo) and the fixtures below, the wrapped call and the direct call give the
 * same HTTP status, WWW-Authenticate, JSON-RPC response, request audit row
 * (minus the three call_tool attribution keys), tool-execution audit rows,
 * ledger calls and rate-limit keys. Inputs are derived from each tool's own
 * schema, so a new tool joins the contract with no edit here.
 *
 * The documented difference: an approval `requestState` is sealed per surface
 * (spec §3.4), so the two states are opened and compared field by field.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../config/env', async (orig) => (await import('./mcpServerToolList.testHarness')).envMock(orig as never));
vi.mock('../middleware/apiKeyAuth', async () => (await import('./mcpServerToolList.testHarness')).apiKeyAuthMock());
vi.mock('../middleware/bearerTokenAuth', async () => (await import('./mcpServerToolList.testHarness')).bearerMock());
vi.mock('../db', async (orig) => (await import('./mcpServerToolList.testHarness')).dbMock(orig as never));
vi.mock('../services/permissions', async (orig) => (await import('./mcpServerToolList.testHarness')).permissionsMock(orig as never));
vi.mock('../services/aiTools', async (orig) => (await import('./mcpServerToolList.testHarness')).aiToolsMock(orig as never));
vi.mock('../services/aiGuardrails', async (orig) => (await import('./mcpServerToolList.testHarness')).guardrailsMock(orig as never));
vi.mock('../services/auditEvents', async () => (await import('./mcpServerToolList.testHarness')).auditMock());
vi.mock('../services/toolSources/resolver', async () => (await import('./mcpServerToolList.testHarness')).resolverMock());
vi.mock('../services/flows/mcpFlowTools', async () => (await import('./mcpServerToolList.testHarness')).flowToolsMock());
vi.mock('./mcpExecutionOrg', async () => (await import('./mcpServerToolList.testHarness')).executionOrgMock());
vi.mock('../services/redis', async () => (await import('./mcpServerToolList.testHarness')).redisMock());
vi.mock('../services/mcpToolExecutionLedger', async () => (await import('./mcpServerToolList.testHarness')).ledgerMock());
vi.mock('../services/sentry', () => ({ captureException: vi.fn(), captureMessage: vi.fn() }));
vi.mock('../modules/mcpInvites', () => ({ initMcpBootstrap: () => ({ unauthTools: [], authTools: [] }) }));
vi.mock('../services/toolSources/execute', async (orig) => (await import('./mcpServerToolList.testHarness')).tenantExecuteMock(orig as never));
vi.mock('../services/toolSources/guardrails', async (orig) => (await import('./mcpServerToolList.testHarness')).tenantGuardrailsMock(orig as never));
vi.mock('../services/rate-limit', async () => (await import('./mcpServerToolList.testHarness')).rateLimitMock());
const intentMocks = vi.hoisted(() => ({ createMcpActionIntent: vi.fn(), loadOwnedMcpIntent: vi.fn(), countLiveMcpIntentsForOrigin: vi.fn(async () => 0), cancelOwnedMcpIntent: vi.fn() }));
vi.mock('../services/mcpIntentCreation', () => ({
  createMcpActionIntent: (...a: unknown[]) => intentMocks.createMcpActionIntent(...a),
  loadOwnedMcpIntent: (...a: unknown[]) => intentMocks.loadOwnedMcpIntent(...a),
  countLiveMcpIntentsForOrigin: (...a: unknown[]) => intentMocks.countLiveMcpIntentsForOrigin(...a),
  cancelOwnedMcpIntent: (...a: unknown[]) => intentMocks.cancelOwnedMcpIntent(...a),
  resolveMcpClientLabel: vi.fn(async () => 'MCP · test'),
}));

import { mcpServerRoutes } from './mcpServer';
import { createMcpHarness, harnessState, resetHarnessState, UNRESTRICTED_KEY, type HarnessResponse } from './mcpServerToolList.testHarness';
import { getToolDefinitions } from '../services/aiTools';
import { mcpRequestStateKey, openMcpRequestState } from '../services/mcpRequestState';

const mcp = createMcpHarness(mcpServerRoutes, harnessState.writeAuditEvent);
type Era = 'legacy' | 'modern';
const wrap = (name: string, args: Record<string, unknown>) => ({ name: 'call_tool', arguments: { name, arguments: args } });
const CALL_TOOL_KEYS = ['metaTool', 'toolName', 'requestedToolName'];

function omitVolatile(details: Record<string, unknown> | undefined, extra: string[] = []) {
  if (!details) return details;
  const drop = new Set(['correlation', 'clientInfoTrust', 'sessionId', 'hasSession', 'rawResourceId', 'durationMs', ...extra]);
  return Object.fromEntries(Object.entries(details).filter(([key]) => !drop.has(key)));
}

type Observed = { res: HarnessResponse; ledger: unknown[][]; rateLimited: unknown[] };

async function observe(era: Era, params: Record<string, unknown>, opts = {}): Promise<Observed> {
  harnessState.ledgerBegin.mockClear();
  harnessState.checkToolRateLimit.mockClear();
  const res = await mcp[era]('tools/call', params, opts);
  return {
    res,
    // The ledger row's tool, tier and input; its correlation ids differ per request.
    ledger: harnessState.ledgerBegin.mock.calls.map((call) => {
      const arg = call[0] as Record<string, unknown>;
      return [arg.toolName, arg.tier, arg.toolInput];
    }),
    rateLimited: harnessState.checkToolRateLimit.mock.calls.map((call) => call[0]),
  };
}

/** Asserts parity and returns the direct response for the caller's own checks. */
async function expectParity(era: Era, name: string, input: Record<string, unknown>, opts: Record<string, unknown> = {}): Promise<HarnessResponse> {
  const direct = await observe(era, { name, arguments: input }, opts);
  const wrapped = await observe(era, wrap(name, input), opts);
  const label = `${era} ${name} ${JSON.stringify(input)}`;
  expect(wrapped.res.status, label).toBe(direct.res.status);
  expect(wrapped.res.wwwAuthenticate, label).toBe(direct.res.wwwAuthenticate);
  expect(wrapped.res.body, label).toEqual(direct.res.body);
  expect(wrapped.res.requestAudits, label).toHaveLength(1);
  expect(direct.res.requestAudits, label).toHaveLength(1);
  const wrappedRow = wrapped.res.requestAudits[0]!;
  expect(wrappedRow.details.metaTool, label).toBe('call_tool');
  expect(omitVolatile(wrappedRow.details, CALL_TOOL_KEYS), label).toEqual(omitVolatile(direct.res.requestAudits[0]!.details));
  expect(wrappedRow.result, label).toBe(direct.res.requestAudits[0]!.result);
  expect(wrapped.res.toolAudits.map((r) => [r.action, r.result, omitVolatile(r.details)]), label)
    .toEqual(direct.res.toolAudits.map((r) => [r.action, r.result, omitVolatile(r.details)]));
  expect(wrapped.ledger, label).toEqual(direct.ledger);
  expect(wrapped.rateLimited, label).toEqual(direct.rateLimited);
  return direct.res;
}

/** One input per declared action (an action-less tool gets `{}`), from the tool's own schema. */
function derivedInputs(tool: { input_schema: unknown }): Array<Record<string, unknown>> {
  const action = (tool.input_schema as { properties?: { action?: { enum?: unknown[] } } }).properties?.action?.enum;
  const actions = Array.isArray(action) ? action.filter((a): a is string => typeof a === 'string') : [];
  return actions.length === 0 ? [{}] : actions.map((a) => ({ action: a }));
}

beforeEach(() => {
  resetHarnessState();
  process.env.MCP_STATELESS_ENABLED = 'true';
  harnessState.executeTool.mockImplementation(async (name: string, input: unknown) => JSON.stringify({ echoed: name, input }));
});
afterEach(() => {
  vi.unstubAllEnvs();
  delete process.env.MCP_STATELESS_ENABLED;
});

describe('the real registry', () => {
  beforeEach(() => { harnessState.realRegistry = true; });

  it('every tool × declared action: wrapped === direct (unrestricted, ai:read+write+execute)', async () => {
    const outcomes = new Map<string, number>();
    let cases = 0;
    for (const tool of getToolDefinitions()) {
      for (const input of derivedInputs(tool)) {
        const res = await expectParity('modern', tool.name, input);
        cases += 1;
        const kind = res.body.error ? `error ${res.body.error.code}` : res.body.result?.isError ? 'isError' : 'result';
        outcomes.set(kind, (outcomes.get(kind) ?? 0) + 1);
      }
    }
    expect(cases).toBeGreaterThan(500);
    // Not vacuous: the sweep reached execution and the approval refusal.
    expect(outcomes.get('result') ?? 0).toBeGreaterThan(100);
    expect(outcomes.get('isError') ?? 0).toBeGreaterThan(10);
  }, 600_000);

  it('every tool, first action: wrapped === direct for an ai:read-only key and for a core+devices grant', async () => {
    for (const context of [{ ...UNRESTRICTED_KEY, scopes: ['ai:read'] }, { ...UNRESTRICTED_KEY, mcpDomains: ['devices'] }]) {
      harnessState.context = context;
      const codes = new Set<number>();
      for (const tool of getToolDefinitions()) {
        const res = await expectParity('modern', tool.name, derivedInputs(tool)[0]!);
        if (res.body.error) codes.add(res.body.error.code);
      }
      // ai:read: -32603 insufficient scope; the grant: -32003 domain_not_granted.
      expect([...codes].some((c) => c === -32603 || c === -32003)).toBe(true);
    }
  }, 600_000);

  it('the partner-wide refusal and an escalated multiplexer action are among the pairs (named, not only swept)', async () => {
    const partnerWide = await expectParity('modern', 'get_partner_settings_inheritance', {});
    expect(JSON.stringify(partnerWide.body)).toMatch(/partner/i);
    const escalated = await expectParity('modern', 'registry_operations', { action: 'delete_key' });
    expect(JSON.stringify(escalated.body)).toContain('MCP_APPROVAL_REQUIRED');
  });
});

describe('fixtures', () => {
  beforeEach(() => {
    harnessState.catalog = {
      ...harnessState.catalog,
      run_widget_job: { tier: 3, domain: 'devices' },
    };
    harnessState.tenantTools = [{ tier: 1, definition: { name: 'acme__lookup_widget', description: 'Look up a widget.', input_schema: { type: 'object', properties: {} } } }];
  });

  it.each(['legacy', 'modern'] as const)('%s: a tenant tool, a flow tool and an alias', async (era) => {
    const tenant = await expectParity(era, 'acme__lookup_widget', { id: 'w1' });
    expect(tenant.body.result.content[0].text).toContain('tenant');
    const flow = await expectParity(era, 'flow__weekly_report', {});
    expect(flow.body.result.content[0].text).toContain('flow');
    const alias = await expectParity(era, 'get_fleet_status', {});
    expect(alias.body.result.content[0].text).toContain('get_invite_funnel');
  });

  it('missing ai:write and ai:execute', async () => {
    harnessState.context = { ...UNRESTRICTED_KEY, scopes: ['ai:read'] };
    expect((await expectParity('legacy', 'acknowledge_alert', {})).body.error.data).toMatchObject({ requiredScope: 'ai:write' });
  });

  it('RBAC rejection', async () => {
    harnessState.checkToolPermission.mockResolvedValue('Permission denied: alerts.write');
    expect((await expectParity('legacy', 'acknowledge_alert', {})).body.error).toEqual({ code: -32603, message: 'Permission denied: alerts.write' });
  });

  it('guardrail rejection', async () => {
    harnessState.guardrailOverride = (name) => (name === 'get_alert_summary' ? { allowed: false, tier: 1, reason: 'blocked by guardrail' } : undefined);
    expect(JSON.stringify((await expectParity('legacy', 'get_alert_summary', {})).body)).toContain('blocked by guardrail');
  });

  it('effective-tier escalation to the approval gate', async () => {
    harnessState.guardrailOverride = (name) => (name === 'acknowledge_alert' ? { allowed: true, tier: 3 } : undefined);
    expect(JSON.stringify((await expectParity('legacy', 'acknowledge_alert', {})).body)).toContain('MCP_APPROVAL_REQUIRED');
  });

  describe('Tier 3 for an unattended principal (ledger path)', () => {
    beforeEach(() => {
      vi.stubEnv('MCP_UNATTENDED_TIER3_PRINCIPALS', `api_key:${UNRESTRICTED_KEY.id}`);
    });

    it('executes through the ledger identically', async () => {
      const res = await expectParity('legacy', 'run_widget_job', { deviceId: 'd1' });
      expect(res.body.result.content[0].text).toContain('run_widget_job');
      expect(harnessState.ledgerBegin).toHaveBeenCalled();
    });

    it('a ledger-creation failure fails closed identically', async () => {
      harnessState.ledgerBegin.mockRejectedValue(new Error('ledger down'));
      const res = await expectParity('legacy', 'run_widget_job', {});
      expect(res.body.error ?? res.body.result?.isError).toBeTruthy();
      expect(harnessState.executeTool).not.toHaveBeenCalled();
    });

    it('production: missing ai:execute_admin, then the execute allowlist', async () => {
      vi.stubEnv('NODE_ENV', 'production');
      vi.stubEnv('APP_ENCRYPTION_KEY', 'test-encryption-key-for-parity-0123456789');
      const admin = await expectParity('legacy', 'run_widget_job', {});
      expect(admin.body.error.message).toContain('ai:execute_admin');
      harnessState.context = { ...UNRESTRICTED_KEY, scopes: [...(UNRESTRICTED_KEY.scopes as string[]), 'ai:execute_admin'] };
      const allowlist = await expectParity('legacy', 'run_widget_job', {});
      expect(allowlist.body.error.message).toContain('MCP_EXECUTE_TOOL_ALLOWLIST');
    });
  });

  describe('Tier 3 approval intents (MCP_TIER3_INTENTS_ENABLED)', () => {
    const ACTION_ID = '77777777-7777-4777-8777-777777777777';
    beforeEach(() => {
      vi.stubEnv('MCP_TIER3_INTENTS_ENABLED', 'true');
      intentMocks.createMcpActionIntent.mockReset().mockResolvedValue({
        kind: 'pending', isNew: true,
        status: {
          actionId: ACTION_ID, status: 'pending_approval', toolName: 'run_widget_job', approvalScope: 'four_eyes',
          expiresAt: '2027-01-01T00:00:00.000Z', approvalUrl: `https://app.example.com/approvals#intent-${ACTION_ID}`,
        },
      });
    });

    it.each(['legacy', 'modern'] as const)('%s: pending_approval is identical', async (era) => {
      const res = await expectParity(era, 'run_widget_job', { deviceId: 'd1' });
      expect(res.body.result.structuredContent).toMatchObject({ status: 'pending_approval', actionId: ACTION_ID });
      expect(intentMocks.createMcpActionIntent).toHaveBeenCalledTimes(2);
      for (const call of intentMocks.createMcpActionIntent.mock.calls) expect((call[0] as { toolName: string }).toolName).toBe('run_widget_job');
    });

    it('modern URL-elicitation client: input_required on both; the sealed states agree on a/p/m/t/d/e', async () => {
      const opts = { clientCapabilities: { elicitation: { url: {} } } };
      const direct = await observe('modern', { name: 'run_widget_job', arguments: { deviceId: 'd1' } }, opts);
      const wrapped = await observe('modern', wrap('run_widget_job', { deviceId: 'd1' }), opts);
      expect(direct.res.body.result.resultType).toBe('input_required');
      const strip = (body: any) => ({ ...body, result: { ...body.result, requestState: '<sealed>' } });
      expect(strip(wrapped.res.body)).toEqual(strip(direct.res.body));
      const open = (body: any) => {
        const opened = openMcpRequestState(body.result.requestState, mcpRequestStateKey(), Math.floor(Date.now() / 1000));
        if (!opened.ok) throw new Error('state did not open');
        return opened.payload;
      };
      const { e: _de, w: directSurface, ...directState } = open(direct.res.body) as Record<string, unknown>;
      const { e: _we, w: wrappedSurface, ...wrappedState } = open(wrapped.res.body) as Record<string, unknown>;
      expect(wrappedState).toEqual(directState);
      expect(directState.t).toBe('run_widget_job');
      expect([directSurface, wrappedSurface]).toEqual(SURFACE_BYTES);
    });
  });
});

/** [direct, wrapped] values of the sealed surface byte (spec §3.4, T7). */
const SURFACE_BYTES = [0, 1];
