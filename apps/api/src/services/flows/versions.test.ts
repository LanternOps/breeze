import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { AuthContext } from '../../middleware/auth';
import type { FlowValidationResult } from '@breeze/shared';

// ── programmable drizzle fake: one queue per builder kind ───────────────────
const { queues, calls } = vi.hoisted(() => ({
  queues: { select: [] as unknown[], insert: [] as unknown[], update: [] as unknown[], execute: [] as unknown[] },
  calls: [] as Array<{ kind: string; ops: Array<{ op: string; args: unknown[] }> }>,
}));

vi.mock('../../db', () => {
  function chain(kind: 'select' | 'insert' | 'update') {
    const rec = { kind, ops: [] as Array<{ op: string; args: unknown[] }> };
    calls.push(rec);
    const proxy: unknown = new Proxy(() => {}, {
      get(_t, prop) {
        if (prop === 'then') {
          const value = queues[kind].shift();
          return (res: (v: unknown) => void, rej: (e: unknown) => void) =>
            (value instanceof Error ? Promise.reject(value) : Promise.resolve(value ?? [])).then(res, rej);
        }
        return (...args: unknown[]) => {
          rec.ops.push({ op: String(prop), args });
          return proxy;
        };
      },
    });
    return proxy;
  }
  return {
    db: {
      select: () => chain('select'),
      insert: () => chain('insert'),
      update: () => chain('update'),
      execute: (q: unknown) => {
        calls.push({ kind: 'execute', ops: [{ op: 'execute', args: [q] }] });
        return Promise.resolve(queues.execute.shift() ?? []);
      },
    },
    runOutsideDbContext: (fn: () => unknown) => fn(),
    withSystemDbAccessContext: (fn: () => unknown) => fn(),
    getCurrentDbAccessContext: () => undefined,
    runAfterDbContextCommit: (_label: string, work: () => unknown) => { void work(); },
  };
});

vi.mock('../../config/env', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../config/env')>()),
  eventDispatchMode: vi.fn(() => 'off'),
  eventDispatchQueueSubscribers: vi.fn(() => new Set()),
}));
vi.mock('../flowValidator', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../flowValidator')>()),
  validateFlowDocument: vi.fn(),
  stepPinsFor: vi.fn(),
}));
vi.mock('./preApproval', () => ({ assessPreApprovals: vi.fn() }));
vi.mock('./repository', () => ({ takenFlowSlugs: vi.fn(), ownerForFlowRow: vi.fn() }));
vi.mock('../permissions', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../permissions')>()),
  getUserPermissions: vi.fn(),
}));
vi.mock('../auditEvents', () => ({ writeAuditEvent: vi.fn(), requestLikeFromSnapshot: () => ({}) }));
vi.mock('../userNotifications', () => ({ createNotification: vi.fn() }));
vi.mock('../aiOperator/taskOutbox', () => ({ publishIntentTerminalOutbox: vi.fn() }));
vi.mock('./builtins/aiBudget', () => ({ aiStepPermanentBudgetDenial: vi.fn() }));

import { eventDispatchMode, eventDispatchQueueSubscribers } from '../../config/env';
import { FlowStepPinError, stepPinsFor, validateFlowDocument, type FlowStepPin } from '../flowValidator';
import { assessPreApprovals } from './preApproval';
import { ownerForFlowRow, takenFlowSlugs } from './repository';
import { getUserPermissions, type UserPermissions } from '../permissions';
import { writeAuditEvent } from '../auditEvents';
import { createNotification } from '../userNotifications';
import { publishIntentTerminalOutbox } from '../aiOperator/taskOutbox';
import { aiStepPermanentBudgetDenial } from './builtins/aiBudget';
import { assertDelegatorAuthority, disableFlow, enableFlow, pauseFlow, webhookSecretSurvivesEnable } from './versions';

const ORG = '11111111-1111-4111-8111-111111111111';
const PARTNER = '22222222-2222-4222-8222-222222222222';
const FLOW_ID = '33333333-3333-4333-8333-333333333333';
const USER = '44444444-4444-4444-8444-444444444444';
const SCRIPT = '55555555-5555-4555-8555-555555555555';
const DEVICE = '66666666-6666-4666-8666-666666666666';
const VERSION_ID = '77777777-7777-4777-8777-777777777777';

const STEP_DEFAULTS = { approval: 'default', onFailure: 'stop', timeoutSec: 300 } as const;
const MANUAL_DOC = {
  version: 1, name: 'Disk Cleanup', trigger: { type: 'manual' }, inputs: [],
  steps: [
    { id: 'read', tool: 'get_device_details', input: { deviceId: DEVICE }, ...STEP_DEFAULTS },
    { id: 'run', tool: 'run_script', input: { scriptId: SCRIPT, deviceIds: [DEVICE] }, ...STEP_DEFAULTS },
  ],
};
const PINS: FlowStepPin[] = [
  { stepId: 'read', tool: 'get_device_details', source: 'core', tier: 1, approvalScope: null },
  { stepId: 'run', tool: 'run_script', source: 'core', tier: 3, approvalScope: 'supervised' },
];
const BINDING = { stepId: 'run', lane: 'act_asset', assetKind: 'script', scriptId: SCRIPT, contentDigest: 'a'.repeat(64) } as const;

function valid(doc: unknown): FlowValidationResult & { document: unknown } {
  return {
    valid: true, effectiveTier: 3, issues: [], document: doc,
    steps: (doc as typeof MANUAL_DOC).steps.map((s) => ({ id: s.id, tool: s.tool, source: 'core' as const, tier: 3 as const, approval: 'default' as const })),
  };
}

function row(over: Record<string, unknown> = {}) {
  return {
    id: FLOW_ID, orgId: ORG, partnerId: null, slug: 'disk_cleanup', name: 'Disk Cleanup', description: null,
    definition: MANUAL_DOC, definitionVersion: 3, effectiveTier: 3, status: 'draft', pausedReason: null,
    enabledByUserId: null, enabledAt: null, enabledPublicationSeq: null, scheduleLastOccurrenceKey: null,
    createdByUserId: USER, aiSessionId: null, managedByAgentId: null,
    createdAt: new Date('2026-10-20T00:00:00Z'), updatedAt: new Date('2026-10-20T00:00:00Z'), ...over,
  };
}

function auth(over: Partial<AuthContext> = {}): AuthContext {
  return {
    principal: { kind: 'user_session' },
    scope: 'organization', orgId: ORG, partnerId: PARTNER, partnerOrgAccess: null, accessibleOrgIds: [ORG],
    canAccessOrg: (id: string) => id === ORG, user: { id: USER, email: 'u@example.com' }, ...over,
  } as unknown as AuthContext;
}
const partnerAuth = (orgAccess: 'all' | 'selected') =>
  auth({ scope: 'partner', orgId: null, partnerOrgAccess: orgAccess, accessibleOrgIds: [ORG] } as Partial<AuthContext>);

const ALL_PERMS = [
  { resource: 'devices', action: 'read' }, { resource: 'devices', action: 'execute' },
  { resource: 'scripts', action: 'read' }, { resource: 'scripts', action: 'execute' },
  { resource: 'external_tools', action: 'use' }, { resource: 'external_tools', action: 'write' },
];
function perms(over: Partial<UserPermissions> = {}): UserPermissions {
  return { permissions: [{ resource: '*', action: '*' }], partnerId: null, orgId: ORG, roleId: 'r', scope: 'organization', ...over };
}

const callsOf = (kind: string) => calls.filter((c) => c.kind === kind);

/** The bound values (drizzle Param objects) inside a where clause — what a CAS predicate actually compares against. */
function paramValues(v: unknown, seen = new WeakSet<object>(), out: unknown[] = []): unknown[] {
  if (!v || typeof v !== 'object' || seen.has(v as object)) return out;
  seen.add(v as object);
  if ((v as { constructor?: { name?: string } }).constructor?.name === 'Param') {
    out.push((v as { value: unknown }).value);
    return out;
  }
  for (const child of Array.isArray(v) ? v : Object.values(v as Record<string, unknown>)) paramValues(child, seen, out);
  return out;
}
const whereValues = (rec: { ops: Array<{ op: string; args: unknown[] }> }) => paramValues(rec.ops.find((o) => o.op === 'where')!.args[0]).flat();

const setOf = (rec: { ops: Array<{ op: string; args: unknown[] }> }) => rec.ops.find((o) => o.op === 'set')!.args[0] as Record<string, unknown>;
const valuesOf = (rec: { ops: Array<{ op: string; args: unknown[] }> }) => rec.ops.find((o) => o.op === 'values')!.args[0] as Record<string, unknown>;

/**
 * Queue the reads/writes of a successful enable: flow row, latest publication
 * (max seq + its definition version), flows update, publication insert.
 */
function queueEnable(flow: ReturnType<typeof row> = row(), maxSeq: number | null = null, latestDefinitionVersion: number | null = null) {
  queues.select.push([flow], [{ max: maxSeq, latestDefinitionVersion }]);
  queues.update.push([{ ...flow, status: 'enabled', enabledPublicationSeq: (maxSeq ?? 0) + 1, enabledByUserId: USER, enabledAt: new Date() }]);
  queues.insert.push([{ id: VERSION_ID, publicationSeq: (maxSeq ?? 0) + 1, definitionVersion: flow.definitionVersion }]);
}

beforeEach(() => {
  for (const q of Object.values(queues)) q.length = 0;
  calls.length = 0;
  vi.mocked(eventDispatchMode).mockReset().mockReturnValue('off');
  vi.mocked(eventDispatchQueueSubscribers).mockReset().mockReturnValue(new Set());
  vi.mocked(validateFlowDocument).mockReset().mockImplementation(async (doc) => valid(doc) as never);
  vi.mocked(stepPinsFor).mockReset().mockResolvedValue(PINS);
  vi.mocked(assessPreApprovals).mockReset().mockResolvedValue({ eligibility: { run: { eligible: true } }, bindings: { run: BINDING } });
  vi.mocked(ownerForFlowRow).mockReset().mockImplementation(async (r) => (r.orgId ? { orgId: r.orgId, partnerId: PARTNER } : { orgId: null, partnerId: PARTNER }));
  vi.mocked(takenFlowSlugs).mockReset().mockResolvedValue(new Set());
  vi.mocked(getUserPermissions).mockReset().mockResolvedValue(perms());
  vi.mocked(writeAuditEvent).mockReset();
  vi.mocked(createNotification).mockReset().mockResolvedValue('n1');
  vi.mocked(publishIntentTerminalOutbox).mockReset().mockResolvedValue(undefined);
  vi.mocked(aiStepPermanentBudgetDenial).mockReset().mockResolvedValue(null);
});

afterEach(() => {
  vi.useRealTimers();
});

describe('enableFlow — refusals', () => {
  it('api key cannot enable', async () => {
    const r = await enableFlow(auth({ principal: { kind: 'api_key', apiKeyId: 'k' } } as Partial<AuthContext>), FLOW_ID, { expectedVersion: 3, preApprovedStepIds: [] });
    expect(r).toEqual({ ok: false, error: 'interactive_session_required' });
    expect(calls).toHaveLength(0);
  });

  it('an invisible flow is flow_not_found', async () => {
    queues.select.push([]);
    expect(await enableFlow(auth(), FLOW_ID, { expectedVersion: 3, preApprovedStepIds: [] })).toEqual({ ok: false, error: 'flow_not_found' });
  });

  it('stale expectedVersion is version_conflict', async () => {
    queues.select.push([row({ definitionVersion: 4 })]);
    expect(await enableFlow(auth(), FLOW_ID, { expectedVersion: 3, preApprovedStepIds: [] })).toEqual({ ok: false, error: 'version_conflict' });
    expect(callsOf('update')).toHaveLength(0);
    expect(callsOf('insert')).toHaveLength(0);
  });

  it('an enabled flow is already_enabled', async () => {
    queues.select.push([row({ status: 'enabled', enabledPublicationSeq: 1 })]);
    expect(await enableFlow(auth(), FLOW_ID, { expectedVersion: 3, preApprovedStepIds: [] })).toEqual({ ok: false, error: 'already_enabled' });
  });

  it('an org token on a partner-wide flow is flow_not_found', async () => {
    queues.select.push([row({ orgId: null, partnerId: PARTNER })]);
    expect(await enableFlow(auth(), FLOW_ID, { expectedVersion: 3, preApprovedStepIds: [] })).toEqual({ ok: false, error: 'flow_not_found' });
  });

  it('partner user with selected-org access cannot enable a partner-wide flow', async () => {
    queues.select.push([row({ orgId: null, partnerId: PARTNER })]);
    expect(await enableFlow(partnerAuth('selected'), FLOW_ID, { expectedVersion: 3, preApprovedStepIds: [] }))
      .toEqual({ ok: false, error: 'partner_wide_forbidden' });
    // The token says 'all' but the live membership has been narrowed: the delegation ceiling catches it.
    queues.select.push([row({ orgId: null, partnerId: PARTNER })]);
    vi.mocked(getUserPermissions).mockResolvedValue(perms({ scope: 'partner', orgId: null, partnerId: PARTNER, orgAccess: 'selected', allowedOrgIds: [ORG] }));
    expect(await enableFlow(partnerAuth('all'), FLOW_ID, { expectedVersion: 3, preApprovedStepIds: [] }))
      .toEqual({ ok: false, error: 'delegation_scope_restricted' });
    expect(getUserPermissions).toHaveBeenLastCalledWith(USER, { partnerId: PARTNER, orgId: undefined, scope: 'partner' });
    expect(callsOf('insert')).toHaveLength(0);
  });

  it('site-limited user is delegation_scope_restricted', async () => {
    queues.select.push([row()]);
    vi.mocked(getUserPermissions).mockResolvedValue(perms({ allowedSiteIds: ['site-1'] }));
    const r = await enableFlow(auth({ allowedSiteIds: ['site-1'] } as Partial<AuthContext>), FLOW_ID, { expectedVersion: 3, preApprovedStepIds: [] });
    expect(r).toEqual({ ok: false, error: 'delegation_scope_restricted' });
    expect(getUserPermissions).toHaveBeenCalledWith(USER, { partnerId: PARTNER, orgId: ORG, scope: 'organization' });
    expect(validateFlowDocument).not.toHaveBeenCalled();
  });

  it('user with allowedSiteIds [] is delegation_scope_restricted', async () => {
    queues.select.push([row()]);
    vi.mocked(getUserPermissions).mockResolvedValue(perms({ allowedSiteIds: [] }));
    expect(await enableFlow(auth(), FLOW_ID, { expectedVersion: 3, preApprovedStepIds: [] }))
      .toEqual({ ok: false, error: 'delegation_scope_restricted' });
  });

  it('a user with no role in the owner scope is delegation_scope_restricted', async () => {
    queues.select.push([row()]);
    vi.mocked(getUserPermissions).mockResolvedValue(null);
    expect(await enableFlow(auth(), FLOW_ID, { expectedVersion: 3, preApprovedStepIds: [] }))
      .toEqual({ ok: false, error: 'delegation_scope_restricted' });
  });

  it('an invalid document is invalid with the validation and writes nothing', async () => {
    queues.select.push([row()]);
    const bad = { valid: false, effectiveTier: null, steps: [], issues: [{ code: 'tool_not_found', severity: 'error', message: 'x' }] };
    vi.mocked(validateFlowDocument).mockResolvedValue(bad as never);
    expect(await enableFlow(auth(), FLOW_ID, { expectedVersion: 3, preApprovedStepIds: [] })).toEqual({ ok: false, error: 'invalid', validation: bad });
    expect(callsOf('update')).toHaveLength(0);
  });

  it.each([
    ['off', [] as string[]],
    ['shadow', ['flow-event-trigger']],
    ['enforce', [] as string[]],
  ])('event flow refused unless enforce and member (%s, %j)', async (mode, subs) => {
    const doc = { ...MANUAL_DOC, trigger: { type: 'event', event: 'device.offline', filter: {} } };
    queues.select.push([row({ definition: doc })]);
    vi.mocked(eventDispatchMode).mockReturnValue(mode as never);
    vi.mocked(eventDispatchQueueSubscribers).mockReturnValue(new Set(subs) as never);
    expect(await enableFlow(auth(), FLOW_ID, { expectedVersion: 3, preApprovedStepIds: [] }))
      .toEqual({ ok: false, error: 'event_dispatch_not_durable' });
    expect(callsOf('insert')).toHaveLength(0);
  });

  it('event flow with enforce and membership enables', async () => {
    const doc = { ...MANUAL_DOC, trigger: { type: 'event', event: 'device.offline', filter: {} } };
    queueEnable(row({ definition: doc }));
    vi.mocked(eventDispatchMode).mockReturnValue('enforce');
    vi.mocked(eventDispatchQueueSubscribers).mockReturnValue(new Set(['flow-event-trigger']) as never);
    const r = await enableFlow(auth(), FLOW_ID, { expectedVersion: 3, preApprovedStepIds: [] });
    expect(r.ok).toBe(true);
    expect(setOf(callsOf('update')[0]!).scheduleLastOccurrenceKey).toBeNull();
  });

  it('event flow enables through the real env parser now that flow-event-trigger is a known subscriber (Task A9)', async () => {
    const real = await vi.importActual<typeof import('../../config/env')>('../../config/env');
    const prev = process.env.EVENT_DISPATCH_QUEUE_SUBSCRIBERS;
    process.env.EVENT_DISPATCH_QUEUE_SUBSCRIBERS = 'webhook-delivery, flow-event-trigger';
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    try {
      vi.mocked(eventDispatchQueueSubscribers).mockImplementation(real.eventDispatchQueueSubscribers);
      vi.mocked(eventDispatchMode).mockReturnValue('enforce');
      expect(real.eventDispatchQueueSubscribers().has('flow-event-trigger' as never)).toBe(true);
      expect(warn).not.toHaveBeenCalled();
      const doc = { ...MANUAL_DOC, trigger: { type: 'event', event: 'device.offline', filter: {} } };
      queueEnable(row({ definition: doc }));
      const r = await enableFlow(auth(), FLOW_ID, { expectedVersion: 3, preApprovedStepIds: [] });
      expect(r.ok).toBe(true);
    } finally {
      if (prev === undefined) delete process.env.EVENT_DISPATCH_QUEUE_SUBSCRIBERS;
      else process.env.EVENT_DISPATCH_QUEUE_SUBSCRIBERS = prev;
      warn.mockRestore();
    }
  });

  // W5 (#5220, Decision 11): concurrency is refused only where it cannot be honoured.
  it('tier-3 step with concurrency 2 is foreach_concurrency_not_available', async () => {
    const doc = { ...MANUAL_DOC, steps: [{ ...MANUAL_DOC.steps[1]!, forEach: { items: 'inputs.ids', as: 'item', maxItems: 10, concurrency: 2 } }] };
    queues.select.push([row({ definition: doc })]);
    vi.mocked(stepPinsFor).mockResolvedValueOnce([PINS[1]!]);
    expect(await enableFlow(auth(), FLOW_ID, { expectedVersion: 3, preApprovedStepIds: [] }))
      .toEqual({ ok: false, error: 'foreach_concurrency_not_available' });
    expect(callsOf('update')).toHaveLength(0);
  });

  it('wait in for-each with concurrency 2 is refused', async () => {
    const doc = { ...MANUAL_DOC, steps: [{ id: 'pause', tool: 'wait', input: { minutes: 1 }, ...STEP_DEFAULTS, forEach: { items: 'inputs.ids', as: 'item', maxItems: 10, concurrency: 2 } }] };
    queues.select.push([row({ definition: doc })]);
    vi.mocked(stepPinsFor).mockResolvedValueOnce([{ stepId: 'pause', tool: 'wait', source: 'builtin', tier: 1, approvalScope: null }]);
    expect(await enableFlow(auth(), FLOW_ID, { expectedVersion: 3, preApprovedStepIds: [] }))
      .toEqual({ ok: false, error: 'foreach_concurrency_not_available' });
  });

  it('tier-2 step with concurrency 5 enables', async () => {
    const doc = { ...MANUAL_DOC, steps: [{ ...MANUAL_DOC.steps[0]!, forEach: { items: 'inputs.ids', as: 'item', maxItems: 10, concurrency: 5 } }] };
    queueEnable(row({ definition: doc }));
    vi.mocked(stepPinsFor).mockResolvedValueOnce([{ ...PINS[0]!, tier: 2 }]);
    expect((await enableFlow(auth(), FLOW_ID, { expectedVersion: 3, preApprovedStepIds: [] })).ok).toBe(true);
  });

  // W05 (#5220) Task A5, validator mocked (B1 adds the webhook trigger rules).
  it('webhook flow without a secret is webhook_secret_missing', async () => {
    const doc = { ...MANUAL_DOC, trigger: { type: 'webhook', auth: 'hmac' } };
    queues.select.push([row({ definition: doc, webhookSecretEncrypted: null, webhookSecretFingerprint: null, webhookSecretRotatedAt: null })]);
    expect(await enableFlow(auth(), FLOW_ID, { expectedVersion: 3, preApprovedStepIds: [] }))
      .toEqual({ ok: false, error: 'webhook_secret_missing' });
    expect(callsOf('update')).toHaveLength(0);
    expect(callsOf('insert')).toHaveLength(0);
  });

  it('webhook flow with a secret enables', async () => {
    const doc = { ...MANUAL_DOC, trigger: { type: 'webhook', auth: 'hmac' } };
    queueEnable(row({
      definition: doc, webhookSecretEncrypted: 'enc:v3:k:x', webhookSecretFingerprint: 'fp', webhookSecretRotatedAt: new Date('2027-03-01T00:00:00Z'),
    }));
    expect((await enableFlow(auth(), FLOW_ID, { expectedVersion: 3, preApprovedStepIds: [] })).ok).toBe(true);
  });

  // W5 PR B (#5220, Decision 13): spec §6.7 "cannot be enabled if the owner has no budget".
  describe('ai step budget', () => {
    const AI_DOC = { ...MANUAL_DOC, steps: [{ id: 'think', tool: 'ai', input: { prompt: 'x', tools: [], output: { type: 'object' } }, ...STEP_DEFAULTS }] };
    const AI_PINS: FlowStepPin[] = [{ stepId: 'think', tool: 'ai', source: 'builtin', tier: 1, approvalScope: null }];

    it('org flow with an ai step and AI disabled is ai_budget_unavailable', async () => {
      queues.select.push([row({ definition: AI_DOC })]);
      vi.mocked(stepPinsFor).mockResolvedValue(AI_PINS);
      vi.mocked(aiStepPermanentBudgetDenial).mockResolvedValue({ reason: 'ai_disabled', message: 'AI features are disabled for this organization' });
      expect(await enableFlow(auth(), FLOW_ID, { expectedVersion: 3, preApprovedStepIds: [] }))
        .toEqual({ ok: false, error: 'ai_budget_unavailable', message: 'AI features are disabled for this organization' });
      expect(aiStepPermanentBudgetDenial).toHaveBeenCalledWith(ORG, PARTNER);
      expect(callsOf('update')).toHaveLength(0);
    });

    it('org flow with an ai step and a usable budget enables', async () => {
      queueEnable(row({ definition: AI_DOC }));
      vi.mocked(stepPinsFor).mockResolvedValue(AI_PINS);
      expect((await enableFlow(auth(), FLOW_ID, { expectedVersion: 3, preApprovedStepIds: [] })).ok).toBe(true);
    });

    it('a partner-wide flow checks per run org at run time, not at enable', async () => {
      queueEnable(row({ orgId: null, partnerId: PARTNER, definition: AI_DOC }));
      vi.mocked(stepPinsFor).mockResolvedValue(AI_PINS);
      vi.mocked(aiStepPermanentBudgetDenial).mockResolvedValue({ reason: 'ai_disabled', message: 'x' });
      vi.mocked(getUserPermissions).mockResolvedValue(perms({ scope: 'partner', orgId: null, partnerId: PARTNER, orgAccess: 'all' }));
      expect((await enableFlow(partnerAuth('all'), FLOW_ID, { expectedVersion: 3, preApprovedStepIds: [] })).ok).toBe(true);
      expect(aiStepPermanentBudgetDenial).not.toHaveBeenCalled();
    });

    it('a flow without an ai step never checks the AI budget', async () => {
      queueEnable();
      expect((await enableFlow(auth(), FLOW_ID, { expectedVersion: 3, preApprovedStepIds: [] })).ok).toBe(true);
      expect(aiStepPermanentBudgetDenial).not.toHaveBeenCalled();
    });
  });

  it('missing permissions are all listed', async () => {
    const doc = {
      ...MANUAL_DOC,
      steps: [...MANUAL_DOC.steps, { id: 'ticket', tool: 'halo__create_ticket', input: { summary: 'x' }, ...STEP_DEFAULTS }],
    };
    queues.select.push([row({ definition: doc })]);
    vi.mocked(stepPinsFor).mockResolvedValue([
      ...PINS,
      { stepId: 'ticket', tool: 'halo__create_ticket', source: 'tenant', tier: 3, approvalScope: 'supervised', tenantToolId: 't', tenantRevision: 'r' },
    ]);
    vi.mocked(getUserPermissions).mockResolvedValue(perms({ permissions: [{ resource: 'external_tools', action: 'use' }] }));
    const r = await enableFlow(auth(), FLOW_ID, { expectedVersion: 3, preApprovedStepIds: [] });
    expect(r).toMatchObject({ ok: false, error: 'permission_missing' });
    const missing = (r as { missing: Array<{ stepId: string; permission: string }> }).missing;
    expect([...new Set(missing.map((m) => m.stepId))].sort()).toEqual(['read', 'run', 'ticket']);
    expect(missing.find((m) => m.stepId === 'run')!.permission).toBe('scripts.execute');
    expect(missing.find((m) => m.stepId === 'ticket')!.permission).toBe('external_tools.write');
    expect(missing.find((m) => m.stepId === 'read')!.permission).toBe('devices.read');
    expect(callsOf('insert')).toHaveLength(0);
  });

  it('built-in steps are covered by rule 7 at enable (notify alerts.write, http_request external_tools.write)', async () => {
    const doc = {
      ...MANUAL_DOC,
      steps: [
        { id: 'tell', tool: 'notify', input: { channelId: SCRIPT, title: 't', message: 'm' }, ...STEP_DEFAULTS },
        { id: 'call', tool: 'http_request', input: { method: 'POST', url: 'https://api.example.com/x' }, ...STEP_DEFAULTS },
        { id: 'pause', tool: 'wait', input: { minutes: 1 }, ...STEP_DEFAULTS },
      ],
    };
    queues.select.push([row({ definition: doc })]);
    vi.mocked(stepPinsFor).mockResolvedValue([
      { stepId: 'tell', tool: 'notify', source: 'builtin', tier: 2, approvalScope: null },
      { stepId: 'call', tool: 'http_request', source: 'builtin', tier: 3, approvalScope: 'supervised' },
      { stepId: 'pause', tool: 'wait', source: 'builtin', tier: 1, approvalScope: null },
    ]);
    vi.mocked(getUserPermissions).mockResolvedValue(perms({ permissions: [{ resource: 'external_tools', action: 'use' }] }));
    const r = await enableFlow(auth(), FLOW_ID, { expectedVersion: 3, preApprovedStepIds: [] });
    expect(r).toEqual({
      ok: false,
      error: 'permission_missing',
      missing: [{ stepId: 'tell', permission: 'alerts.write' }, { stepId: 'call', permission: 'external_tools.write' }],
    });
    expect(callsOf('update')).toHaveLength(0);
  });

  it('rule 7 passes for a user holding exactly the needed permissions', async () => {
    queueEnable();
    vi.mocked(getUserPermissions).mockResolvedValue(perms({ permissions: ALL_PERMS }));
    expect((await enableFlow(auth(), FLOW_ID, { expectedVersion: 3, preApprovedStepIds: [] })).ok).toBe(true);
  });

  it('ineligible pre-approval names the step', async () => {
    queues.select.push([row()]);
    vi.mocked(assessPreApprovals).mockResolvedValue({ eligibility: { run: { eligible: false, reason: 'variable_dependent' } }, bindings: {} });
    expect(await enableFlow(auth(), FLOW_ID, { expectedVersion: 3, preApprovedStepIds: ['run'] }))
      .toEqual({ ok: false, error: 'pre_approval_not_eligible', stepId: 'run', reason: 'variable_dependent' });
    expect(callsOf('insert')).toHaveLength(0);
  });

  // W6 (#5221, Decision 5): a fleet binding binds the NEW publication's id
  // and the user's maxTargets, and the publication row is inserted with that id.
  it('fleet pre-approvals are assessed against the new publication with the requested maxTargets', async () => {
    queueEnable();
    await enableFlow(auth(), FLOW_ID, { expectedVersion: 3, preApprovedStepIds: ['run'], fleetMaxTargets: { run: 40 } });
    const [, , , requested, opts] = vi.mocked(assessPreApprovals).mock.calls[0]!;
    expect([...(requested as Iterable<string>)]).toEqual(['run']);
    expect(opts).toMatchObject({ fleetMaxTargets: { run: 40 } });
    const publicationId = (opts as { publicationId: string }).publicationId;
    expect(publicationId).toMatch(/^[0-9a-f-]{36}$/);
    expect(valuesOf(callsOf('insert')[0]!).id).toBe(publicationId);
  });

  it('a pre-approval for a step the flow does not have is invalid', async () => {
    queues.select.push([row()]);
    const r = await enableFlow(auth(), FLOW_ID, { expectedVersion: 3, preApprovedStepIds: ['nope'] });
    expect(r).toMatchObject({ ok: false, error: 'invalid' });
    const issues = (r as { validation: FlowValidationResult }).validation.issues;
    expect(issues).toEqual([expect.objectContaining({ code: 'pre_approval_not_eligible', stepId: 'nope', severity: 'error' })]);
  });

  it('slug shadowed since save is slug_unavailable (checked under the partner lock)', async () => {
    queues.select.push([row()]);
    const order: string[] = [];
    vi.mocked(takenFlowSlugs).mockImplementation(async () => {
      order.push(`lookup-after-${callsOf('execute').length}-locks`);
      return new Set(['disk_cleanup']);
    });
    expect(await enableFlow(auth(), FLOW_ID, { expectedVersion: 3, preApprovedStepIds: [] })).toEqual({ ok: false, error: 'slug_unavailable' });
    expect(order).toEqual(['lookup-after-1-locks']);
    expect(JSON.stringify(callsOf('execute')[0]!.ops[0]!.args[0])).toContain(`flows_slug:${PARTNER}`);
    expect(callsOf('update')).toHaveLength(0);
  });

  it('the flow\'s own slug does not block its enable', async () => {
    queueEnable();
    const r = await enableFlow(auth(), FLOW_ID, { expectedVersion: 3, preApprovedStepIds: [] });
    expect(r.ok).toBe(true);
    expect(takenFlowSlugs).toHaveBeenCalledWith({ orgId: ORG, partnerId: PARTNER }, 'disk_cleanup', { excludeFlowId: FLOW_ID });
  });

  it('a step that stops resolving between validation and pinning is invalid, not a crash', async () => {
    queues.select.push([row()]);
    vi.mocked(stepPinsFor).mockRejectedValue(new FlowStepPinError('run'));
    const r = await enableFlow(auth(), FLOW_ID, { expectedVersion: 3, preApprovedStepIds: [] });
    expect(r).toMatchObject({ ok: false, error: 'invalid' });
    expect((r as { validation: FlowValidationResult }).validation.issues).toEqual([expect.objectContaining({ code: 'tool_not_found', stepId: 'run' })]);
    expect(callsOf('update')).toHaveLength(0);
  });

  it('a concurrent status change (0 rows updated) is version_conflict and inserts no publication', async () => {
    queues.select.push([row()], [{ max: null }]);
    queues.update.push([]);
    expect(await enableFlow(auth(), FLOW_ID, { expectedVersion: 3, preApprovedStepIds: [] })).toEqual({ ok: false, error: 'version_conflict' });
    expect(callsOf('insert')).toHaveLength(0);
  });
});

describe('enableFlow — publication', () => {
  it('enable writes a publication with pins and bindings and sets the occurrence key', async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(new Date('2026-10-25T13:37:00Z'));
    const doc = { ...MANUAL_DOC, trigger: { type: 'schedule', cron: '0 2 * * *', timezone: 'UTC' } };
    queueEnable(row({ definition: doc }));
    const r = await enableFlow(auth(), FLOW_ID, { expectedVersion: 3, preApprovedStepIds: ['run'] });
    expect(r).toMatchObject({ ok: true, publication: { id: VERSION_ID, publicationSeq: 1, definitionVersion: 3 } });

    const set = setOf(callsOf('update')[0]!);
    expect(set).toMatchObject({
      status: 'enabled', enabledPublicationSeq: 1, enabledByUserId: USER, pausedReason: null,
      scheduleLastOccurrenceKey: '2026-10-25T02:00@UTC',
    });
    expect(set.enabledAt).toBeInstanceOf(Date);
    expect(whereValues(callsOf('update')[0]!)).toEqual(expect.arrayContaining([FLOW_ID, 3, 'draft', 'disabled', 'paused']));

    const values = valuesOf(callsOf('insert')[0]!);
    expect(values).toMatchObject({
      flowId: FLOW_ID, orgId: ORG, partnerId: null, publicationSeq: 1, definitionVersion: 3, effectiveTier: 3,
      stepPins: PINS, preApprovals: [BINDING], enabledByUserId: USER, definition: doc,
    });

    const ev = vi.mocked(writeAuditEvent).mock.calls[0]![1] as { action: string; details: Record<string, unknown> };
    expect(ev.action).toBe('flow.enable');
    expect(ev.details).toEqual({ publicationSeq: 1, definitionVersion: 3, preApprovedStepIds: ['run'], effectiveTier: 3 });
    if (r.ok) {
      expect(r.flow.preApprovedStepIds).toEqual(['run']);
      expect(r.flow.preApprovalEligibility).toEqual({ run: { eligible: true } });
    }
  });

  it('a step not requested for pre-approval is not bound even when eligible', async () => {
    queueEnable();
    await enableFlow(auth(), FLOW_ID, { expectedVersion: 3, preApprovedStepIds: [] });
    expect(valuesOf(callsOf('insert')[0]!).preApprovals).toEqual([]);
  });

  it('re-enable of unchanged content writes publication_seq 2', async () => {
    queueEnable(row({ status: 'disabled' }), 1);
    const r = await enableFlow(auth(), FLOW_ID, { expectedVersion: 3, preApprovedStepIds: [] });
    expect(r).toMatchObject({ ok: true, publication: { publicationSeq: 2 } });
    expect(valuesOf(callsOf('insert')[0]!).publicationSeq).toBe(2);
    expect(setOf(callsOf('update')[0]!).enabledPublicationSeq).toBe(2);
  });

  it('re-enable of a paused flow clears the paused reason', async () => {
    queueEnable(row({ status: 'paused', pausedReason: 'delegator_inactive', enabledPublicationSeq: 1 }), 1);
    const r = await enableFlow(auth(), FLOW_ID, { expectedVersion: 3, preApprovedStepIds: [] });
    expect(r.ok).toBe(true);
    expect(setOf(callsOf('update')[0]!)).toMatchObject({ status: 'enabled', pausedReason: null, enabledPublicationSeq: 2 });
  });

  it('a partner-wide flow publishes with partner_id and org_id NULL', async () => {
    queueEnable(row({ orgId: null, partnerId: PARTNER }));
    vi.mocked(getUserPermissions).mockResolvedValue(perms({ scope: 'partner', orgId: null, partnerId: PARTNER, orgAccess: 'all' }));
    const r = await enableFlow(partnerAuth('all'), FLOW_ID, { expectedVersion: 3, preApprovedStepIds: [] });
    expect(r.ok).toBe(true);
    expect(valuesOf(callsOf('insert')[0]!)).toMatchObject({ orgId: null, partnerId: PARTNER });
  });
});

// #10270 "Needs Todd" 1, option (b): a webhook secret minted against an older
// draft is invalidated when that draft is published; one minted against the
// content being published survives.
describe('webhookSecretSurvivesEnable', () => {
  const MINTED = new Date('2027-03-01T00:00:00Z');
  const LATER = new Date('2027-03-02T00:00:00Z');

  it('no secret never survives', () => {
    expect(webhookSecretSurvivesEnable({ secretRotatedAt: null, flowUpdatedAt: MINTED, definitionVersion: 3, latestPublicationDefinitionVersion: 3 })).toBe(false);
  });

  it('nothing written to the flow since the mint: survives', () => {
    expect(webhookSecretSurvivesEnable({ secretRotatedAt: MINTED, flowUpdatedAt: new Date(MINTED), definitionVersion: 3, latestPublicationDefinitionVersion: null })).toBe(true);
  });

  it('the flow was written after the mint and the draft is newer than every publication: invalidated', () => {
    expect(webhookSecretSurvivesEnable({ secretRotatedAt: MINTED, flowUpdatedAt: LATER, definitionVersion: 3, latestPublicationDefinitionVersion: null })).toBe(false);
    expect(webhookSecretSurvivesEnable({ secretRotatedAt: MINTED, flowUpdatedAt: LATER, definitionVersion: 3, latestPublicationDefinitionVersion: 2 })).toBe(false);
  });

  it('a write that predates the mint (clock skew, an earlier timestamp) still counts as a change: equality only', () => {
    expect(webhookSecretSurvivesEnable({ secretRotatedAt: LATER, flowUpdatedAt: MINTED, definitionVersion: 3, latestPublicationDefinitionVersion: null })).toBe(false);
  });

  it('the draft is unchanged since the latest publication: survives whatever was written since (a disable, a pause)', () => {
    expect(webhookSecretSurvivesEnable({ secretRotatedAt: MINTED, flowUpdatedAt: LATER, definitionVersion: 3, latestPublicationDefinitionVersion: 3 })).toBe(true);
  });
});

describe('enableFlow — webhook secret binding (#10270 option b)', () => {
  const WEBHOOK_DOC = { ...MANUAL_DOC, trigger: { type: 'webhook', auth: 'hmac' } };
  const MINTED = new Date('2027-03-01T00:00:00Z');
  const EDITED = new Date('2027-03-01T00:05:00Z');
  const secret = (rotatedAt: Date) => ({ webhookSecretEncrypted: 'enc:v3:k:x', webhookSecretFingerprint: 'fp', webhookSecretRotatedAt: rotatedAt });
  const SECRET_KEYS = ['webhookSecretEncrypted', 'webhookSecretFingerprint', 'webhookSecretRotatedAt'];

  it('a draft edited after the mint: the enable clears the secret in the flip and says so', async () => {
    queueEnable(row({ definition: WEBHOOK_DOC, ...secret(MINTED), updatedAt: EDITED }));
    const r = await enableFlow(auth(), FLOW_ID, { expectedVersion: 3, preApprovedStepIds: [] });
    expect(r).toMatchObject({ ok: true, webhookSecretInvalidated: true });
    expect(setOf(callsOf('update')[0]!)).toMatchObject({
      status: 'enabled', webhookSecretEncrypted: null, webhookSecretFingerprint: null, webhookSecretRotatedAt: null,
    });
    // The publication is still written: the flow is live, the sender needs a fresh secret.
    expect(callsOf('insert')).toHaveLength(1);
    const ev = vi.mocked(writeAuditEvent).mock.calls[0]![1] as { action: string; details: Record<string, unknown> };
    expect(ev.action).toBe('flow.enable');
    expect(ev.details).toMatchObject({ webhookSecretInvalidated: true });
  });

  it('a secret minted after the last edit survives the enable', async () => {
    queueEnable(row({ definition: WEBHOOK_DOC, ...secret(MINTED), updatedAt: new Date(MINTED) }));
    const r = await enableFlow(auth(), FLOW_ID, { expectedVersion: 3, preApprovedStepIds: [] });
    expect(r).toMatchObject({ ok: true, webhookSecretInvalidated: false });
    const set = setOf(callsOf('update')[0]!);
    for (const k of SECRET_KEYS) expect(set).not.toHaveProperty(k);
  });

  it('re-enable with no draft change since the latest publication keeps the secret (the disable bumped updated_at)', async () => {
    queueEnable(row({ definition: WEBHOOK_DOC, status: 'disabled', ...secret(MINTED), updatedAt: EDITED }), 1, 3);
    const r = await enableFlow(auth(), FLOW_ID, { expectedVersion: 3, preApprovedStepIds: [] });
    expect(r).toMatchObject({ ok: true, webhookSecretInvalidated: false, publication: { publicationSeq: 2 } });
    const set = setOf(callsOf('update')[0]!);
    for (const k of SECRET_KEYS) expect(set).not.toHaveProperty(k);
  });

  it('a draft edited since the latest publication, secret older than the edit: invalidated', async () => {
    queueEnable(row({ definition: WEBHOOK_DOC, status: 'disabled', ...secret(MINTED), updatedAt: EDITED }), 1, 2);
    const r = await enableFlow(auth(), FLOW_ID, { expectedVersion: 3, preApprovedStepIds: [] });
    expect(r).toMatchObject({ ok: true, webhookSecretInvalidated: true });
    expect(setOf(callsOf('update')[0]!)).toMatchObject({ webhookSecretEncrypted: null, webhookSecretFingerprint: null, webhookSecretRotatedAt: null });
  });

  it('the flip is fenced to the secret generation it judged: a rotation racing it is version_conflict and publishes nothing', async () => {
    queues.select.push([row({ definition: WEBHOOK_DOC, ...secret(MINTED), updatedAt: EDITED })], [{ max: null, latestDefinitionVersion: null }]);
    queues.update.push([]);
    expect(await enableFlow(auth(), FLOW_ID, { expectedVersion: 3, preApprovedStepIds: [] })).toEqual({ ok: false, error: 'version_conflict' });
    expect(whereValues(callsOf('update')[0]!).map((v) => (v instanceof Date ? v.getTime() : v))).toContain(MINTED.getTime());
    expect(callsOf('insert')).toHaveLength(0);
  });

  it('a non-webhook flow never touches the secret columns', async () => {
    queueEnable(row({ ...secret(MINTED), updatedAt: EDITED }));
    const r = await enableFlow(auth(), FLOW_ID, { expectedVersion: 3, preApprovedStepIds: [] });
    expect(r).toMatchObject({ ok: true, webhookSecretInvalidated: false });
    const set = setOf(callsOf('update')[0]!);
    for (const k of SECRET_KEYS) expect(set).not.toHaveProperty(k);
  });
});

describe('disableFlow', () => {
  it('disable cancels queued and parked runs and flags running ones', async () => {
    queues.select.push([row({ status: 'enabled', enabledPublicationSeq: 1 })]);
    queues.update.push(
      [{ id: FLOW_ID }], // flows
      [{ id: 'run-queued' }, { id: 'run-waiting' }], // queued / waiting → cancelled
      [{ id: 'run-approval' }], // awaiting_approval → cancel requested
      [{ id: 'intent-1', orgId: ORG }], // pending intents → cancelled
      [{ id: 'run-running' }], // running → cancel requested
    );
    const r = await disableFlow(auth(), FLOW_ID);
    expect(r).toEqual({ ok: true, cancelledRuns: 2 });

    const updates = callsOf('update');
    expect(setOf(updates[0]!)).toMatchObject({ status: 'disabled', enabledPublicationSeq: null, pausedReason: null });

    const cancel = setOf(updates[1]!);
    expect(cancel).toMatchObject({ status: 'cancelled', errorCode: 'flow_disabled', wakeAt: null, leaseToken: null, leaseExpiresAt: null });
    expect(cancel.finishedAt).toBeInstanceOf(Date);
    expect(cancel.cancelRequestedAt).toBeInstanceOf(Date);
    expect(whereValues(updates[1]!)).toEqual([FLOW_ID, 'queued', 'waiting']);

    // cancel_requested_at is set on the parked run BEFORE its intents are cancelled.
    expect(Object.keys(setOf(updates[2]!))).toContain('cancelRequestedAt');
    expect(setOf(updates[2]!)).not.toHaveProperty('status');
    expect(whereValues(updates[2]!)).toEqual([FLOW_ID, 'awaiting_approval']);
    expect(setOf(updates[3]!)).toEqual({ status: 'cancelled' });
    expect(whereValues(updates[3]!)).toEqual(['run-approval', 'pending_approval', 'approved']);
    expect(publishIntentTerminalOutbox).toHaveBeenCalledWith(expect.anything(), { id: 'intent-1', orgId: ORG, taskId: null }, 'intent_cancelled');

    expect(setOf(updates[4]!)).not.toHaveProperty('status');
    expect(whereValues(updates[4]!)).toEqual([FLOW_ID, 'running']);

    const ev = vi.mocked(writeAuditEvent).mock.calls[0]![1] as { action: string; details: Record<string, unknown> };
    expect(ev.action).toBe('flow.disable');
    expect(ev.details).toMatchObject({ cancelledRuns: 2, cancelRequestedRuns: 2, cancelledIntents: 1 });
  });

  it('no parked runs ⇒ no intent update', async () => {
    queues.select.push([row({ status: 'enabled', enabledPublicationSeq: 1 })]);
    queues.update.push([{ id: FLOW_ID }], [], [], []);
    expect(await disableFlow(auth(), FLOW_ID)).toEqual({ ok: true, cancelledRuns: 0 });
    expect(callsOf('update')).toHaveLength(4);
    expect(publishIntentTerminalOutbox).not.toHaveBeenCalled();
  });

  it('a draft flow is not_enabled', async () => {
    queues.select.push([row()]);
    expect(await disableFlow(auth(), FLOW_ID)).toEqual({ ok: false, error: 'not_enabled' });
    expect(callsOf('update')).toHaveLength(0);
  });

  it('an invisible flow is flow_not_found', async () => {
    queues.select.push([]);
    expect(await disableFlow(auth(), FLOW_ID)).toEqual({ ok: false, error: 'flow_not_found' });
  });

  it('a selected-access partner user cannot disable a partner-wide flow', async () => {
    queues.select.push([row({ orgId: null, partnerId: PARTNER, status: 'enabled', enabledPublicationSeq: 1 })]);
    expect(await disableFlow(partnerAuth('selected'), FLOW_ID)).toEqual({ ok: false, error: 'partner_wide_forbidden' });
    expect(callsOf('update')).toHaveLength(0);
  });
});

describe('pauseFlow', () => {
  it('pauses an enabled flow, keeps the publication, audits and notifies the delegator', async () => {
    queues.update.push([row({ status: 'paused', pausedReason: 'binding_drift', enabledPublicationSeq: 4, enabledByUserId: USER })]);
    await pauseFlow(FLOW_ID, 'binding_drift');
    const set = setOf(callsOf('update')[0]!);
    expect(set).toMatchObject({ status: 'paused', pausedReason: 'binding_drift' });
    expect(set).not.toHaveProperty('enabledPublicationSeq');
    expect(whereValues(callsOf('update')[0]!)).toEqual([FLOW_ID, 'enabled']);
    const ev = vi.mocked(writeAuditEvent).mock.calls[0]![1] as { action: string; details: Record<string, unknown> };
    expect(ev).toMatchObject({ action: 'flow.pause', resourceId: FLOW_ID, details: { reason: 'binding_drift', publicationSeq: 4 } });
    expect(createNotification).toHaveBeenCalledWith(expect.objectContaining({
      userId: USER, orgId: ORG, type: 'automation', link: `/flows/${FLOW_ID}`,
      dedupeKey: `flow-paused:${FLOW_ID}:4:binding_drift`,
    }));
  });

  it('is idempotent: a flow that is not enabled is left alone and nobody is notified', async () => {
    queues.update.push([]);
    await pauseFlow(FLOW_ID, 'drift');
    expect(writeAuditEvent).not.toHaveBeenCalled();
    expect(createNotification).not.toHaveBeenCalled();
  });

  // Round-2 review: a run on an OLD publication must never pause a flow
  // someone re-enabled since — the pause is fenced to the run's publication.
  it('with expectedPublicationSeq the pause is fenced to that publication', async () => {
    queues.update.push([]);
    await pauseFlow(FLOW_ID, 'delegator_inactive', { expectedPublicationSeq: 1 });
    expect(whereValues(callsOf('update')[0]!)).toEqual([FLOW_ID, 'enabled', 1]);
    // Re-enabled on publication 2 ⇒ the fenced UPDATE matched nothing: no audit, no notification.
    expect(writeAuditEvent).not.toHaveBeenCalled();
    expect(createNotification).not.toHaveBeenCalled();
  });

  it('a notification failure does not fail the pause', async () => {
    queues.update.push([row({ status: 'paused', pausedReason: 'drift', enabledPublicationSeq: 1, enabledByUserId: USER })]);
    vi.mocked(createNotification).mockRejectedValue(new Error('boom'));
    await expect(pauseFlow(FLOW_ID, 'drift')).resolves.toBeUndefined();
  });
});

describe('assertDelegatorAuthority', () => {
  const pub = (over: Record<string, unknown> = {}) => ({ id: VERSION_ID, flowId: FLOW_ID, enabledByUserId: USER, ...over }) as never;
  const ORG_OWNER = { orgId: ORG, partnerId: PARTNER };
  const PARTNER_OWNER = { orgId: null, partnerId: PARTNER };
  const RULE7 = { doc: MANUAL_DOC as never, pins: PINS };

  it('an active, unrestricted delegator passes', async () => {
    queues.select.push([{ status: 'active' }]);
    expect(await assertDelegatorAuthority(pub(), ORG_OWNER, RULE7)).toBe(true);
    expect(getUserPermissions).toHaveBeenCalledWith(USER, { partnerId: PARTNER, orgId: ORG, scope: 'organization' });
  });

  it('a deleted delegator (NULL tombstone) fails without a lookup', async () => {
    expect(await assertDelegatorAuthority(pub({ enabledByUserId: null }), ORG_OWNER, RULE7)).toBe(false);
    expect(callsOf('select')).toHaveLength(0);
  });

  it.each(['disabled', 'invited'])('a %s delegator fails', async (status) => {
    queues.select.push([{ status }]);
    expect(await assertDelegatorAuthority(pub(), ORG_OWNER, RULE7)).toBe(false);
  });

  it('a delegator removed from the owner scope fails', async () => {
    queues.select.push([{ status: 'active' }]);
    vi.mocked(getUserPermissions).mockResolvedValue(null);
    expect(await assertDelegatorAuthority(pub(), ORG_OWNER, RULE7)).toBe(false);
  });

  it('a delegator narrowed to a site allowlist fails', async () => {
    queues.select.push([{ status: 'active' }]);
    vi.mocked(getUserPermissions).mockResolvedValue(perms({ allowedSiteIds: [] }));
    expect(await assertDelegatorAuthority(pub(), ORG_OWNER, RULE7)).toBe(false);
  });

  it('a partner delegator whose access to the flow org was deselected fails', async () => {
    queues.select.push([{ status: 'active' }]);
    vi.mocked(getUserPermissions).mockResolvedValue(perms({ scope: 'partner', orgId: ORG, partnerId: PARTNER, orgAccess: 'selected', allowedOrgIds: [] }));
    expect(await assertDelegatorAuthority(pub(), ORG_OWNER, RULE7)).toBe(false);
  });

  it('partner-wide requires live orgAccess all', async () => {
    queues.select.push([{ status: 'active' }], [{ status: 'active' }]);
    vi.mocked(getUserPermissions).mockResolvedValue(perms({ scope: 'partner', orgId: null, partnerId: PARTNER, orgAccess: 'selected', allowedOrgIds: [ORG] }));
    expect(await assertDelegatorAuthority(pub(), PARTNER_OWNER, RULE7)).toBe(false);
    vi.mocked(getUserPermissions).mockResolvedValue(perms({ scope: 'partner', orgId: null, partnerId: PARTNER, orgAccess: 'all' }));
    expect(await assertDelegatorAuthority(pub(), PARTNER_OWNER, RULE7)).toBe(true);
  });

  // W5 PR B (#5220, Decision 12): built-ins are no longer a side door.
  it('delegator losing external_tools.write pauses the flow (built-in rule 7)', async () => {
    const doc = { ...MANUAL_DOC, steps: [{ id: 'call', tool: 'http_request', input: { method: 'GET', url: 'https://api.example.com/x' }, ...STEP_DEFAULTS }] };
    const rule7 = { doc: doc as never, pins: [{ stepId: 'call', tool: 'http_request', source: 'builtin', tier: 2, approvalScope: null }] as FlowStepPin[] };
    queues.select.push([{ status: 'active' }], [{ status: 'active' }]);
    vi.mocked(getUserPermissions).mockResolvedValue(perms({ permissions: [{ resource: 'external_tools', action: 'use' }] }));
    expect(await assertDelegatorAuthority(pub(), ORG_OWNER, rule7)).toBe(false);
    vi.mocked(getUserPermissions).mockResolvedValue(perms({ permissions: [{ resource: 'external_tools', action: 'write' }] }));
    expect(await assertDelegatorAuthority(pub(), ORG_OWNER, rule7)).toBe(true);
  });

  // Review finding 6: rule 7 re-applied at run time. A delegator who is still
  // active and unrestricted but was DEMOTED (lost a permission a step needs)
  // must not keep delegating it.
  it('a demoted-but-active delegator who no longer holds a step\'s permissions fails (rule 7)', async () => {
    queues.select.push([{ status: 'active' }]);
    vi.mocked(getUserPermissions).mockResolvedValue(perms({
      permissions: [{ resource: 'devices', action: 'read' }, { resource: 'scripts', action: 'read' }],
    }));
    expect(await assertDelegatorAuthority(pub(), ORG_OWNER, RULE7)).toBe(false);
  });

  it('a delegator who still holds every step\'s permissions passes rule 7', async () => {
    queues.select.push([{ status: 'active' }]);
    vi.mocked(getUserPermissions).mockResolvedValue(perms({ permissions: ALL_PERMS }));
    expect(await assertDelegatorAuthority(pub(), ORG_OWNER, RULE7)).toBe(true);
  });
});
