import { beforeEach, describe, expect, it, vi } from 'vitest';
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
  };
});

vi.mock('../flowValidator', () => ({ validateFlowDocument: vi.fn() }));
vi.mock('./owner', () => ({ resolveFlowOwnerForCaller: vi.fn() }));
vi.mock('./repository', () => ({ takenFlowSlugs: vi.fn(), ownerForFlowRow: vi.fn() }));
vi.mock('../auditEvents', () => ({ writeAuditEvent: vi.fn(), requestLikeFromSnapshot: () => ({}) }));

import { validateFlowDocument } from '../flowValidator';
import { resolveFlowOwnerForCaller } from './owner';
import { ownerForFlowRow, takenFlowSlugs } from './repository';
import { writeAuditEvent } from '../auditEvents';
import { getFlow, saveDraftFlow } from './service';
import { PARTNER_WIDE_WRITE_DENIED_MESSAGE } from '../partnerWideAccess';

const ORG = '11111111-1111-4111-8111-111111111111';
const PARTNER = '22222222-2222-4222-8222-222222222222';
const FLOW_ID = '33333333-3333-4333-8333-333333333333';
const USER = '44444444-4444-4444-8444-444444444444';

const DOC = { version: 1, name: 'Disk Cleanup', trigger: { type: 'manual' }, inputs: [], steps: [{ id: 'a', tool: 'wait', input: { minutes: 1 }, approval: 'default', onFailure: 'stop', timeoutSec: 300 }] };
const VALID: FlowValidationResult & { document: typeof DOC } = {
  valid: true, effectiveTier: 1, steps: [{ id: 'a', tool: 'wait', source: 'builtin', tier: 1, approval: 'default' }], issues: [], document: DOC,
};

function row(over: Record<string, unknown> = {}) {
  return {
    id: FLOW_ID, orgId: ORG, partnerId: null, slug: 'disk_cleanup', name: 'Disk Cleanup', description: null,
    definition: DOC, definitionVersion: 1, effectiveTier: 1, status: 'draft', pausedReason: null,
    enabledByUserId: null, enabledAt: null, createdByUserId: USER, aiSessionId: null, managedByAgentId: null,
    createdAt: new Date('2026-10-20T00:00:00Z'), updatedAt: new Date('2026-10-20T00:00:00Z'), ...over,
  };
}

function auth(over: Partial<AuthContext> = {}): AuthContext {
  return {
    scope: 'organization', orgId: ORG, partnerId: PARTNER, partnerOrgAccess: null, accessibleOrgIds: [ORG],
    canAccessOrg: (id: string) => id === ORG, user: { id: USER, email: 'u@example.com' }, ...over,
  } as unknown as AuthContext;
}

const partnerAuth = (orgAccess: 'all' | 'selected') =>
  auth({ scope: 'partner', orgId: null, partnerOrgAccess: orgAccess, accessibleOrgIds: [ORG] } as Partial<AuthContext>);

const callsOf = (kind: string) => calls.filter((c) => c.kind === kind);

beforeEach(() => {
  for (const q of Object.values(queues)) q.length = 0;
  calls.length = 0;
  vi.mocked(validateFlowDocument).mockReset().mockResolvedValue(VALID as never);
  vi.mocked(resolveFlowOwnerForCaller).mockReset().mockResolvedValue({ owner: { orgId: ORG, partnerId: PARTNER } });
  vi.mocked(takenFlowSlugs).mockReset().mockResolvedValue(new Set());
  vi.mocked(ownerForFlowRow).mockReset().mockResolvedValue({ orgId: ORG, partnerId: PARTNER });
  vi.mocked(writeAuditEvent).mockReset();
});

describe('saveDraftFlow — create', () => {
  it('denies a partner-wide create without canManagePartnerWidePolicies', async () => {
    vi.mocked(resolveFlowOwnerForCaller).mockResolvedValue({ owner: { orgId: null, partnerId: PARTNER } });
    const r = await saveDraftFlow(partnerAuth('selected'), { document: DOC, ownerScope: 'partner' });
    expect(r).toEqual({ saved: false, error: PARTNER_WIDE_WRITE_DENIED_MESSAGE });
    expect(callsOf('insert')).toHaveLength(0);
  });

  it('returns the owner error and writes nothing', async () => {
    vi.mocked(resolveFlowOwnerForCaller).mockResolvedValue({ error: 'Cannot access another organization' });
    const r = await saveDraftFlow(auth(), { document: DOC, orgId: PARTNER });
    expect(r).toEqual({ saved: false, error: 'Cannot access another organization' });
    expect(validateFlowDocument).not.toHaveBeenCalled();
  });

  it('org create inserts under the resolved org with partner_id NULL, slug from the name', async () => {
    queues.insert.push([row()]);
    const r = await saveDraftFlow(auth(), { document: DOC });
    expect(r.saved).toBe(true);
    const values = callsOf('insert')[0]!.ops.find((o) => o.op === 'values')!.args[0] as Record<string, unknown>;
    expect(values).toMatchObject({ orgId: ORG, partnerId: null, slug: 'disk_cleanup', status: 'draft', effectiveTier: 1, createdByUserId: USER, definitionVersion: 1 });
    expect(values.aiSessionId).toBeUndefined();
    expect(validateFlowDocument).toHaveBeenCalledWith(DOC, { owner: { orgId: ORG, partnerId: PARTNER } });
  });

  it('invalid document ⇒ saved:false with the validation, and no insert', async () => {
    const invalid = { valid: false, effectiveTier: null, steps: [], issues: [{ code: 'tool_not_found', severity: 'error', message: 'x' }] };
    vi.mocked(validateFlowDocument).mockResolvedValue(invalid as never);
    const r = await saveDraftFlow(auth(), { document: DOC });
    expect(r).toEqual({ saved: false, validation: invalid });
    expect(callsOf('insert')).toHaveLength(0);
    expect(callsOf('execute')).toHaveLength(0);
  });

  it('slug collision ⇒ _2 (then _3)', async () => {
    vi.mocked(takenFlowSlugs).mockResolvedValue(new Set(['disk_cleanup', 'disk_cleanup_2']));
    queues.insert.push([row({ slug: 'disk_cleanup_3' })]);
    await saveDraftFlow(auth(), { document: DOC });
    const values = callsOf('insert')[0]!.ops.find((o) => o.op === 'values')!.args[0] as Record<string, unknown>;
    expect(values.slug).toBe('disk_cleanup_3');
  });

  it('checks both directions: an org owner and a partner owner both consult takenFlowSlugs for their owner', async () => {
    queues.insert.push([row()]);
    await saveDraftFlow(auth(), { document: DOC });
    expect(takenFlowSlugs).toHaveBeenLastCalledWith({ orgId: ORG, partnerId: PARTNER }, 'disk_cleanup');
    vi.mocked(resolveFlowOwnerForCaller).mockResolvedValue({ owner: { orgId: null, partnerId: PARTNER } });
    queues.insert.push([row({ orgId: null, partnerId: PARTNER })]);
    await saveDraftFlow(partnerAuth('all'), { document: DOC, ownerScope: 'partner' });
    expect(takenFlowSlugs).toHaveBeenLastCalledWith({ orgId: null, partnerId: PARTNER }, 'disk_cleanup');
  });

  it('takes the per-partner advisory lock before the collision lookup', async () => {
    const order: string[] = [];
    vi.mocked(takenFlowSlugs).mockImplementation(async () => {
      order.push(`lookup-after-${callsOf('execute').length}-locks`);
      return new Set();
    });
    queues.insert.push([row()]);
    await saveDraftFlow(auth(), { document: DOC });
    expect(order).toEqual(['lookup-after-1-locks']);
    const lock = callsOf('execute')[0]!.ops[0]!.args[0] as { queryChunks?: unknown[] };
    expect(JSON.stringify(lock)).toMatch(/pg_advisory_xact_lock/);
    expect(JSON.stringify(lock)).toContain(`flows_slug:${PARTNER}`);
  });

  it('an explicit invalid slug is refused', async () => {
    const r = await saveDraftFlow(auth(), { document: DOC, slug: 'a__b' });
    expect(r).toEqual({ saved: false, error: 'invalid_slug' });
    expect(callsOf('insert')).toHaveLength(0);
  });

  it('audit details never contain the definition', async () => {
    queues.insert.push([row()]);
    await saveDraftFlow(auth(), { document: DOC });
    const ev = vi.mocked(writeAuditEvent).mock.calls[0]![1] as { action: string; details: Record<string, unknown> };
    expect(ev.action).toBe('flow.draft.save');
    expect(ev.details).not.toHaveProperty('definition');
    expect(ev.details).toMatchObject({ definitionVersion: 1, effectiveTier: 1, stepCount: 1, ownerScope: 'organization' });
  });
});

describe('saveDraftFlow — update', () => {
  it('a row the caller cannot see ⇒ flow_not_found', async () => {
    queues.select.push([]);
    const r = await saveDraftFlow(auth(), { document: DOC, flowId: FLOW_ID });
    expect(r).toEqual({ saved: false, error: 'flow_not_found' });
  });

  it('an org token on a partner-wide row (visible via the SELECT branch) ⇒ flow_not_found, no update', async () => {
    queues.select.push([row({ orgId: null, partnerId: PARTNER })]);
    const r = await saveDraftFlow(auth(), { document: DOC, flowId: FLOW_ID });
    expect(r).toEqual({ saved: false, error: 'flow_not_found' });
    expect(callsOf('update')).toHaveLength(0);
  });

  it('a selected-access partner user cannot update a partner-wide row', async () => {
    queues.select.push([row({ orgId: null, partnerId: PARTNER })]);
    const r = await saveDraftFlow(partnerAuth('selected'), { document: DOC, flowId: FLOW_ID });
    expect(r).toEqual({ saved: false, error: PARTNER_WIDE_WRITE_DENIED_MESSAGE });
    expect(callsOf('update')).toHaveLength(0);
  });

  it('non-draft ⇒ flow_not_draft', async () => {
    queues.select.push([row({ status: 'enabled' })]);
    expect(await saveDraftFlow(auth(), { document: DOC, flowId: FLOW_ID })).toEqual({ saved: false, error: 'flow_not_draft' });
  });

  it('stale expectedVersion ⇒ version_conflict', async () => {
    queues.select.push([row({ definitionVersion: 3 })]);
    expect(await saveDraftFlow(auth(), { document: DOC, flowId: FLOW_ID, expectedVersion: 2 })).toEqual({ saved: false, error: 'version_conflict' });
    expect(callsOf('update')).toHaveLength(0);
  });

  it('a concurrent save (0 rows updated) ⇒ version_conflict', async () => {
    queues.select.push([row()]);
    queues.update.push([]);
    expect(await saveDraftFlow(auth(), { document: DOC, flowId: FLOW_ID })).toEqual({ saved: false, error: 'version_conflict' });
  });

  it('validates against the ROW owner and bumps definition_version', async () => {
    queues.select.push([row({ definitionVersion: 4 })]);
    queues.update.push([row({ definitionVersion: 5 })]);
    const r = await saveDraftFlow(auth(), { document: DOC, flowId: FLOW_ID, expectedVersion: 4, orgId: PARTNER });
    expect(r.saved).toBe(true);
    expect(resolveFlowOwnerForCaller).not.toHaveBeenCalled();
    expect(ownerForFlowRow).toHaveBeenCalled();
    expect(validateFlowDocument).toHaveBeenCalledWith(DOC, { owner: { orgId: ORG, partnerId: PARTNER } });
    const set = callsOf('update')[0]!.ops.find((o) => o.op === 'set')!.args[0] as Record<string, unknown>;
    expect(set).toHaveProperty('definitionVersion');
    expect(set).not.toHaveProperty('slug');
    expect(set).not.toHaveProperty('orgId');
  });
});

describe('getFlow', () => {
  it('returns null for an invisible row', async () => {
    queues.select.push([]);
    expect(await getFlow(auth(), FLOW_ID)).toBeNull();
  });

  it('get re-validates live', async () => {
    queues.select.push([row()]);
    const live = { valid: false, effectiveTier: null, steps: [], issues: [{ code: 'tool_not_found', severity: 'error', message: 'gone' }] };
    vi.mocked(validateFlowDocument).mockResolvedValue(live as never);
    const r = await getFlow(auth(), FLOW_ID);
    expect(r?.validation).toEqual(live);
    expect(r?.flow).toMatchObject({ id: FLOW_ID, ownerScope: 'organization', triggerType: 'manual', status: 'draft' });
  });
});
