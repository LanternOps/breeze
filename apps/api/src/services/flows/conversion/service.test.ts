import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * Tool Catalog W06 (#5221) Task B1 — the conversion service against a fake SQL
 * boundary: every awaited query yields the next queued result (an Error
 * rejects). The converter is the real one; its context, the draft-save service
 * and the site-scope resolver are mocked. RLS and the unique index on real
 * Postgres are in __tests__/integration/flowConversionService.integration.test.ts.
 */
const dbh = vi.hoisted(() => ({
  results: [] as unknown[],
  inserts: [] as unknown[],
  locks: [] as string[],
}));

vi.mock('../../../db', () => {
  const chain = (): unknown => {
    const proxy: unknown = new Proxy(() => {}, {
      get(_t, prop) {
        if (prop === 'then') {
          const value = dbh.results.shift() ?? [];
          return (res: (v: unknown) => void, rej: (e: unknown) => void) =>
            (value instanceof Error ? Promise.reject(value) : Promise.resolve(value)).then(res, rej);
        }
        if (prop === 'values') return (v: unknown) => { dbh.inserts.push(v); return proxy; };
        if (prop === 'for') return (mode: string) => { dbh.locks.push(mode); return proxy; };
        return () => proxy;
      },
    });
    return proxy;
  };
  return {
    db: { select: chain, selectDistinctOn: chain, insert: chain, update: chain, execute: async () => [] },
    withDbTransaction: async (fn: () => Promise<unknown>) => fn(),
    runOutsideDbContext: (fn: () => unknown) => fn(),
    withSystemDbAccessContext: async (fn: () => Promise<unknown>) => fn(),
  };
});
vi.mock('./context', () => ({ loadConversionContext: vi.fn() }));
vi.mock('../service', () => ({ saveDraftFlow: vi.fn() }));
vi.mock('../../auditEvents', () => ({ writeAuditEvent: vi.fn(), requestLikeFromSnapshot: () => ({}) }));
vi.mock('../../automationRuntime', () => ({ checkAutomationTargetsWithinSiteScope: vi.fn() }));

import type { AuthContext } from '../../../middleware/auth';
import { saveDraftFlow } from '../service';
import { loadConversionContext } from './context';
import { automationSourceDigest } from './convertAutomation';
import { ctx, ORG, PARTNER, row, SCRIPT } from './__fixtures__/automations';
import { checkAutomationTargetsWithinSiteScope } from '../../automationRuntime';
import { createConversion, createConversionsForOwner, getConversion, listConversions, previewConversion } from './service';

const USER = { id: '99999999-9999-4999-8999-999999999999', email: 'conv@example.com' };
const FLOW = '88888888-8888-4888-8888-888888888888';
const CONV = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const SIBLING_ORG = '12121212-1212-4121-8121-121212121212';

function orgAuth(): AuthContext {
  return {
    principal: { kind: 'user_session' }, user: USER, scope: 'organization', orgId: ORG, partnerId: PARTNER,
    partnerOrgAccess: null, accessibleOrgIds: [ORG], canAccessOrg: (id: string) => id === ORG,
  } as unknown as AuthContext;
}
function partnerAuth(orgAccess: 'all' | 'selected' = 'all'): AuthContext {
  return {
    principal: { kind: 'user_session' }, user: USER, scope: 'partner', orgId: null, partnerId: PARTNER,
    partnerOrgAccess: orgAccess, accessibleOrgIds: [ORG], canAccessOrg: (id: string) => id === ORG,
  } as unknown as AuthContext;
}

function ledgerRow(over: Record<string, unknown> = {}) {
  const now = new Date();
  return {
    id: CONV, orgId: ORG, partnerId: null, automationId: row().id, flowId: FLOW, state: 'shadow', fidelity: 'exact',
    findings: [], sourceDigest: automationSourceDigest(row()), sourceSnapshot: {}, documentDigest: 'd'.repeat(64),
    shadowRuns: 0, shadowDivergences: 0, shadowStartedAt: now, shadowLastAt: null, shadowLastDivergence: null,
    switchAt: null, switchedAt: null, revertAt: null, convertedBy: USER.id, switchedBy: null, revertedBy: null,
    divergenceAcknowledged: false, scopeWideningAccepted: false, createdAt: now, updatedAt: now, ...over,
  };
}

function savedDraft() {
  vi.mocked(saveDraftFlow).mockResolvedValue({
    saved: true,
    flow: { id: FLOW, definition: { version: 1, name: 'Nightly cleanup', steps: [] } },
    validation: { valid: true, effectiveTier: 3, steps: [], issues: [] },
  } as never);
}

/** The queries one successful create issues, in order. */
function queueCreate(automation: ReturnType<typeof row>, inserted: unknown = ledgerRow()) {
  dbh.results.push([automation], [], [automation], [], [inserted]);
}

beforeEach(() => {
  dbh.results.length = 0;
  dbh.inserts.length = 0;
  dbh.locks.length = 0;
  vi.mocked(loadConversionContext).mockReset().mockResolvedValue(ctx());
  vi.mocked(saveDraftFlow).mockReset();
});

describe('previewConversion', () => {
  it('class M preview is managed_row', async () => {
    dbh.results.push([row({ managedByMonitorId: '13131313-1313-4131-8131-131313131313' })]);
    const p = await previewConversion(orgAuth(), row().id);
    expect(p).not.toBeNull();
    expect(p!.fidelity).toBe('unconvertible');
    expect(p!.findings.map((f) => f.code)).toContain('managed_row');
    expect(p!.document).toBeNull();
    expect(p!.sourceDigest).toBe(automationSourceDigest(row()));
  });

  it("org token cannot preview a sibling org's automation", async () => {
    // Even if a read returned it, the app-layer owner check refuses the row.
    dbh.results.push([row({ orgId: SIBLING_ORG })]);
    expect(await previewConversion(orgAuth(), row().id)).toBeNull();
    expect(loadConversionContext).not.toHaveBeenCalled();
  });

  it('an exact Job previews its document, target count and digests', async () => {
    dbh.results.push([row()]);
    const p = await previewConversion(orgAuth(), row().id);
    expect(p).toMatchObject({ automationId: row().id, fidelity: 'exact', targetCount: 30 });
    expect(p!.document).not.toBeNull();
    expect(p!.documentDigest).toMatch(/^[0-9a-f]{64}$/);
  });
});

describe('createConversion', () => {
  it('create refuses a changed digest', async () => {
    dbh.results.push([row()]);
    const r = await createConversion(orgAuth(), row().id, { expectedSourceDigest: 'f'.repeat(64) });
    expect(r).toEqual({ ok: false, error: 'source_changed' });
    expect(saveDraftFlow).not.toHaveBeenCalled();
    expect(dbh.inserts).toEqual([]);
  });

  it('a digest that changes between the read and the lock is source_changed', async () => {
    const before = row();
    const after = row({ actions: [{ type: 'run_script', scriptId: SCRIPT, whenOffline: 'skip' }] as never });
    dbh.results.push([before], [], [after]);
    const r = await createConversion(orgAuth(), before.id, { expectedSourceDigest: automationSourceDigest(before) });
    expect(r).toEqual({ ok: false, error: 'source_changed' });
    expect(saveDraftFlow).not.toHaveBeenCalled();
  });

  it("draft is on the automation's axis", async () => {
    savedDraft();
    // Org Job: the draft lands in the Job's org and the ledger row carries that org only.
    queueCreate(row());
    const org = await createConversion(orgAuth(), row().id, { expectedSourceDigest: automationSourceDigest(row()) });
    expect(org.ok).toBe(true);
    expect(dbh.locks).toEqual(['no key update']);
    expect(saveDraftFlow).toHaveBeenLastCalledWith(expect.anything(), expect.objectContaining({ ownerScope: 'organization', orgId: ORG }));
    expect(dbh.inserts.at(-1)).toMatchObject({ orgId: ORG, partnerId: null, automationId: row().id, flowId: FLOW, convertedBy: USER.id });

    // Partner-wide Job: a partner-wide draft (no orgId) and a partner-axis ledger row.
    // (A condition list, not a group target: a partner-wide group target is a blocker.)
    const pw = row({ orgId: null, partnerId: PARTNER, conditions: [] as never });
    vi.mocked(loadConversionContext).mockResolvedValue(ctx({ owner: { orgId: null, partnerId: PARTNER }, partnerOrgs: { live: 1, total: 1 } }));
    queueCreate(pw, ledgerRow({ orgId: null, partnerId: PARTNER }));
    const partner = await createConversion(partnerAuth(), pw.id, { expectedSourceDigest: automationSourceDigest(pw) });
    expect(partner.ok).toBe(true);
    const draftReq = vi.mocked(saveDraftFlow).mock.calls.at(-1)![1];
    expect(draftReq).toMatchObject({ ownerScope: 'partner' });
    expect(draftReq.orgId).toBeUndefined();
    expect(dbh.inserts.at(-1)).toMatchObject({ orgId: null, partnerId: PARTNER });
  });

  it('partner-wide needs canManagePartnerWidePolicies', async () => {
    const pw = row({ orgId: null, partnerId: PARTNER });
    dbh.results.push([pw]);
    const r = await createConversion(partnerAuth('selected'), pw.id, { expectedSourceDigest: automationSourceDigest(pw) });
    expect(r).toEqual({ ok: false, error: 'partner_wide_forbidden' });
    expect(saveDraftFlow).not.toHaveBeenCalled();
    expect(dbh.inserts).toEqual([]);
  });

  it('second live conversion is conversion_exists', async () => {
    // Pre-check: a live generation is already there.
    dbh.results.push([row()], [{ id: CONV }]);
    expect(await createConversion(orgAuth(), row().id, { expectedSourceDigest: automationSourceDigest(row()) }))
      .toEqual({ ok: false, error: 'conversion_exists', conversionId: CONV });
    expect(saveDraftFlow).not.toHaveBeenCalled();

    // Race: the live unique index refuses the insert.
    savedDraft();
    const uq = Object.assign(new Error('duplicate key'), { code: '23505', constraint_name: 'flow_automation_conversions_live_uq' });
    dbh.results.push([row()], [], [row()], [], uq);
    expect(await createConversion(orgAuth(), row().id, { expectedSourceDigest: automationSourceDigest(row()) }))
      .toEqual({ ok: false, error: 'conversion_exists', conversionId: null });
  });

  it('refuses unconvertible and an API-key session', async () => {
    dbh.results.push([row({ managedByAgentId: '14141414-1414-4141-8141-141414141414' })], []);
    const r = await createConversion(orgAuth(), row().id, { expectedSourceDigest: automationSourceDigest(row()) });
    expect(r).toMatchObject({ ok: false, error: 'unconvertible' });
    const apiKey = { ...orgAuth(), principal: { kind: 'api_key' } } as unknown as AuthContext;
    expect(await createConversion(apiKey, row().id, { expectedSourceDigest: 'a'.repeat(64) }))
      .toEqual({ ok: false, error: 'interactive_session_required' });
  });
});

describe('conversion reads honour the site ceiling (security review)', () => {
  /** An org user limited to one site: the Job's targets fall outside it. */
  function siteLimitedAuth(): AuthContext {
    return { ...orgAuth(), allowedSiteIds: ['19191919-1919-4191-8191-191919191919'] } as unknown as AuthContext;
  }

  beforeEach(() => {
    vi.mocked(checkAutomationTargetsWithinSiteScope).mockReset()
      .mockResolvedValue({ ok: false, outOfScopeDeviceIds: ['x'], unbounded: false, restricted: true, targetDeviceIds: ['x'] } as never);
  });

  it('a site-limited user cannot get the conversion of an out-of-ceiling automation', async () => {
    dbh.results.push([ledgerRow()], [row()]);
    expect(await getConversion(siteLimitedAuth(), CONV)).toBeNull();
    expect(checkAutomationTargetsWithinSiteScope).toHaveBeenCalled();
  });

  it('a site-limited user does not list the conversion of an out-of-ceiling automation', async () => {
    dbh.results.push([ledgerRow()], [row()]);
    expect(await listConversions(siteLimitedAuth(), {})).toEqual({ conversions: [], total: 0 });
    expect(checkAutomationTargetsWithinSiteScope).toHaveBeenCalled();
  });

  it('an in-ceiling conversion stays visible to the site-limited user', async () => {
    vi.mocked(checkAutomationTargetsWithinSiteScope).mockResolvedValue({ ok: true } as never);
    dbh.results.push([ledgerRow()], [row()], [row()]);
    const listed = await listConversions(siteLimitedAuth(), {});
    expect(listed.total).toBe(1);
    expect(listed.conversions.map((c) => c.id)).toEqual([CONV]);
    dbh.results.length = 0;
    dbh.results.push([ledgerRow()], [row()]);
    expect(await getConversion(siteLimitedAuth(), CONV)).toMatchObject({ id: CONV, switchBlockedBy: 'shadow_too_new' });
  });
});

describe('createConversionsForOwner', () => {
  it('bulk skips and counts reasons', async () => {
    savedDraft();
    const a = row({ id: '15151515-1515-4151-8151-151515151515' });
    const m = row({ id: '16161616-1616-4161-8161-161616161616', managedByMonitorId: '13131313-1313-4131-8131-131313131313' });
    const c = row({ id: '17171717-1717-4171-8171-171717171717' });
    dbh.results.push(
      [a, m, c],                                  // the owner's unretired Jobs
      [a], [], [a], [], [ledgerRow({ automationId: a.id })], // a: created
      [m], [],                                    // m: managed_row
      [c], [{ id: CONV }],                        // c: a live generation exists
    );
    const r = await createConversionsForOwner(orgAuth(), { ownerScope: 'organization' });
    expect(r).toEqual({ ok: true, created: 1, skipped: { managed_row: 1, conversion_exists: 1 } });
  });

  it('a partner-wide bulk needs the partner-wide capability', async () => {
    expect(await createConversionsForOwner(partnerAuth('selected'), { ownerScope: 'partner' }))
      .toMatchObject({ ok: false, error: 'partner_wide_forbidden' });
  });
});
