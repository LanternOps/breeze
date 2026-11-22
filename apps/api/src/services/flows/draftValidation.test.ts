/**
 * Flows completion W01b (#12435): `validateFlowDraft`, the service behind
 * POST /flows/validate.
 *
 * The real validator runs (flowValidator.ts); only the catalog's tenant tools,
 * the ownership lookups and the DB are faked. So the event-durability warning
 * and the shadow placeholder allowance below are the validator's own answers,
 * not a fixture echoed back.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { AuthContext } from '../../middleware/auth';

// Each awaited query yields the next queued result; writes are recorded.
const dbh = vi.hoisted(() => ({ results: [] as unknown[][], writes: [] as string[] }));
vi.mock('../../db', () => {
  const chain = (): unknown => {
    const proxy: unknown = new Proxy(() => {}, {
      get(_t, prop) {
        if (prop === 'then') {
          const value = dbh.results.shift() ?? [];
          return (res: (v: unknown) => void) => Promise.resolve(value).then(res);
        }
        return () => proxy;
      },
    });
    return proxy;
  };
  const write = (kind: string) => () => {
    dbh.writes.push(kind);
    return chain();
  };
  return {
    db: { select: chain, insert: write('insert'), update: write('update'), delete: write('delete'), execute: write('execute') },
    runOutsideDbContext: (fn: () => unknown) => fn(),
    withSystemDbAccessContext: (fn: () => unknown) => fn(),
  };
});
vi.mock('../toolSources/resolver', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../toolSources/resolver')>();
  return { ...actual, resolveTenantToolsForOwner: vi.fn(async () => []) };
});
vi.mock('./ownedReferences', () => ({
  findOwnedScriptIds: vi.fn(async () => new Set()),
  findOwnedDeviceGroupIds: vi.fn(async () => new Set()),
  findOwnedDeviceIds: vi.fn(async () => new Set()),
  findOwnedNotificationChannel: vi.fn(async () => null),
}));
vi.mock('./repository', () => ({ ownerForFlowRow: vi.fn() }));
vi.mock('./conversion/ledger', async (importOriginal) => {
  const actual = await importOriginal<typeof import('./conversion/ledger')>();
  return { ...actual, shadowPlaceholderAllowance: vi.fn(async () => new Set()) };
});
vi.mock('./catalog', async (importOriginal) => {
  const actual = await importOriginal<typeof import('./catalog')>();
  return { ...actual, loadFlowCatalog: vi.fn(actual.loadFlowCatalog) };
});

import { loadFlowCatalog } from './catalog';
import { shadowPlaceholderAllowance } from './conversion/ledger';
import { ownerForFlowRow } from './repository';
import { resolveFlowOwnerForCaller } from './owner';
import { WRITE_ORG_AMBIGUOUS_ERROR } from '../aiToolWriteOrg';
import { isOwnerAccessDeniedMessage, validateFlowDraft } from './draftValidation';

const ORG = '11111111-1111-4111-8111-111111111111';
const OTHER_ORG = '99999999-9999-4999-8999-999999999999';
const PARTNER = '22222222-2222-4222-8222-222222222222';
const FLOW = '33333333-3333-4333-8333-333333333333';
const SCRIPT = '44444444-4444-4444-8444-444444444444';

const orgAuth = { scope: 'organization', orgId: ORG, partnerId: PARTNER, accessibleOrgIds: [ORG], canAccessOrg: (id: string) => id === ORG } as unknown as AuthContext;
const partnerAuth = {
  scope: 'partner', orgId: null, partnerId: PARTNER, partnerOrgAccess: 'all', accessibleOrgIds: [ORG, OTHER_ORG],
  canAccessOrg: (id: string) => id === ORG || id === OTHER_ORG,
} as unknown as AuthContext;

const doc = (steps: unknown[], trigger: Record<string, unknown> = { type: 'manual' }) => ({ version: 1, name: 'Checked', trigger, inputs: [], steps });
const WAIT = { id: 'a', tool: 'wait', input: { minutes: 1 } };
const SCRIPT_STEP = { id: 'run', tool: 'run_script', input: { scriptId: SCRIPT, deviceIds: ['{{trigger.device.id}}'] } };
const flowRow = (o: Record<string, unknown> = {}) => ({ id: FLOW, orgId: ORG, partnerId: null, status: 'draft', definitionVersion: 1, ...o });

describe('validateFlowDraft', () => {
  beforeEach(() => {
    dbh.results.length = 0;
    dbh.writes.length = 0;
    vi.mocked(ownerForFlowRow).mockReset().mockResolvedValue({ orgId: ORG, partnerId: PARTNER });
    vi.mocked(shadowPlaceholderAllowance).mockReset().mockResolvedValue(new Set());
    vi.mocked(loadFlowCatalog).mockClear();
  });
  afterEach(() => vi.unstubAllEnvs());

  it('validates against the caller-resolved owner when there is no flowId', async () => {
    // resolveFlowOwnerForCaller re-derives the org's partner: one organizations row.
    dbh.results.push([{ partnerId: PARTNER }]);
    const r = await validateFlowDraft(orgAuth, { document: doc([WAIT]) });
    expect(r).toEqual({ ok: true, validation: expect.objectContaining({ valid: true, effectiveTier: 1 }) });
    expect(r.ok && 'document' in r.validation).toBe(false);
  });

  it('validate answers ok with valid:false for an invalid document', async () => {
    dbh.results.push([{ partnerId: PARTNER }]);
    const r = await validateFlowDraft(orgAuth, { document: doc([{ id: 'a', tool: 'nope_tool', input: {} }]) });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.validation.valid).toBe(false);
    expect(r.validation.issues.map((i) => i.code)).toContain('tool_not_found');
  });

  it('validate with flowId answers what save would for a shadow draft', async () => {
    // A shadow conversion's flow: its generated-script placeholder is excused.
    dbh.results.push([flowRow()]);
    vi.mocked(shadowPlaceholderAllowance).mockResolvedValueOnce(new Set([SCRIPT]));
    const shadow = await validateFlowDraft(orgAuth, { document: doc([SCRIPT_STEP]), flowId: FLOW });
    expect(shadow.ok && shadow.validation.valid).toBe(true);
    expect(shadowPlaceholderAllowance).toHaveBeenCalledWith(expect.anything(), FLOW);

    // An ordinary draft (no shadow generation): the same script id is refused.
    dbh.results.push([flowRow()]);
    const ordinary = await validateFlowDraft(orgAuth, { document: doc([SCRIPT_STEP]), flowId: FLOW });
    expect(ordinary.ok).toBe(true);
    if (!ordinary.ok) return;
    expect(ordinary.validation.valid).toBe(false);
    expect(ordinary.validation.issues.map((i) => [i.code, i.pointer])).toEqual([['reference_not_owned', '/steps/0/input/scriptId']]);
  });

  it('with a flowId the owner comes from the row; ownerScope and orgId in the body are ignored', async () => {
    dbh.results.push([flowRow()]);
    const r = await validateFlowDraft(orgAuth, { document: doc([WAIT]), flowId: FLOW, ownerScope: 'partner', orgId: OTHER_ORG });
    expect(r.ok).toBe(true);
    expect(ownerForFlowRow).toHaveBeenCalledWith(expect.objectContaining({ id: FLOW }));
    expect(loadFlowCatalog).toHaveBeenCalledWith({ orgId: ORG, partnerId: PARTNER });
  });

  it('validate writes nothing', async () => {
    dbh.results.push([flowRow()]);
    await validateFlowDraft(orgAuth, { document: doc([SCRIPT_STEP]), flowId: FLOW });
    dbh.results.push([{ partnerId: PARTNER }]);
    await validateFlowDraft(orgAuth, { document: doc([WAIT]) });
    expect(dbh.writes).toEqual([]);
  });

  it('an event trigger on a non-durable installation returns the event_dispatch_not_durable warning with pointer /trigger/event', async () => {
    vi.stubEnv('EVENT_DISPATCH_MODE', 'shadow');
    dbh.results.push([{ partnerId: PARTNER }]);
    const r = await validateFlowDraft(orgAuth, { document: doc([WAIT], { type: 'event', event: 'device.online' }) });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.validation.valid).toBe(true);
    expect(r.validation.issues.map((i) => [i.code, i.severity, i.pointer])).toEqual([['event_dispatch_not_durable', 'warning', '/trigger/event']]);
  });

  it('an unknown flowId is 404', async () => {
    dbh.results.push([]);
    expect(await validateFlowDraft(orgAuth, { document: doc([WAIT]), flowId: FLOW })).toEqual({ ok: false, error: 'flow_not_found' });
    expect(loadFlowCatalog).not.toHaveBeenCalled();
  });

  it('a flow whose owner no longer resolves is flow_not_found', async () => {
    dbh.results.push([flowRow()]);
    vi.mocked(ownerForFlowRow).mockResolvedValueOnce(null);
    expect(await validateFlowDraft(orgAuth, { document: doc([WAIT]), flowId: FLOW })).toEqual({ ok: false, error: 'flow_not_found' });
    expect(loadFlowCatalog).not.toHaveBeenCalled();
  });

  it('validate with a flowId applies the same reach rule as update', async () => {
    // An org token reads a partner-wide row through the SELECT-only branch, but update answers it as absent.
    dbh.results.push([flowRow({ orgId: null, partnerId: PARTNER })]);
    expect(await validateFlowDraft(orgAuth, { document: doc([WAIT]), flowId: FLOW })).toEqual({ ok: false, error: 'flow_not_found' });
    expect(ownerForFlowRow).not.toHaveBeenCalled();
    expect(loadFlowCatalog).not.toHaveBeenCalled();
    expect(shadowPlaceholderAllowance).not.toHaveBeenCalled();
  });

  it('a partner caller may validate a partner-wide flow by id', async () => {
    dbh.results.push([flowRow({ orgId: null, partnerId: PARTNER })]);
    vi.mocked(ownerForFlowRow).mockResolvedValueOnce({ orgId: null, partnerId: PARTNER });
    const r = await validateFlowDraft(partnerAuth, { document: doc([WAIT]), flowId: FLOW });
    expect(r.ok).toBe(true);
    expect(loadFlowCatalog).toHaveBeenCalledWith({ orgId: null, partnerId: PARTNER });
  });

  it('an access-denied owner message is 403 owner_invalid and any other is 400', async () => {
    const denied = await validateFlowDraft(orgAuth, { document: doc([WAIT]), orgId: OTHER_ORG });
    expect(denied).toEqual({ ok: false, error: 'owner_invalid', message: 'Cannot access another organization', accessDenied: true });
    const malformed = await validateFlowDraft(partnerAuth, { document: doc([WAIT]), ownerScope: 'partner', orgId: ORG });
    expect(malformed).toEqual({ ok: false, error: 'owner_invalid', message: 'orgId cannot be combined with ownerScope "partner"', accessDenied: false });
    expect(loadFlowCatalog).not.toHaveBeenCalled();
  });
});

/**
 * The route maps owner messages by text (403 for "you may not act for that
 * owner", 400 otherwise). These drive the REAL resolver to each message, so a
 * reworded message fails here instead of silently changing a status.
 */
describe('isOwnerAccessDeniedMessage against the real owner resolver', () => {
  beforeEach(() => {
    dbh.results.length = 0;
  });

  const errorOf = async (auth: unknown, req: { ownerScope?: 'organization' | 'partner'; orgId?: string }) => {
    const r = await resolveFlowOwnerForCaller(auth as AuthContext, req, 'read');
    if (!('error' in r)) throw new Error('expected an owner error');
    return r.error;
  };

  it.each([
    ['Cannot access another organization', () => errorOf(orgAuth, { orgId: OTHER_ORG })],
    ['Access denied to this organization', () => errorOf({ ...partnerAuth, canAccessOrg: () => false }, { orgId: ORG })],
    ['Partner-wide flows require a partner-scoped caller', () => errorOf(orgAuth, { ownerScope: 'partner' })],
  ])('"%s" is access-denied', async (message, produce) => {
    expect(await produce()).toBe(message);
    expect(isOwnerAccessDeniedMessage(message)).toBe(true);
  });

  it.each([
    ['orgId cannot be combined with ownerScope "partner"', () => errorOf(partnerAuth, { ownerScope: 'partner', orgId: ORG })],
    ['Organization context required', () => errorOf({ ...orgAuth, orgId: null }, {})],
    ['orgId is required for this operation', () => errorOf({ ...partnerAuth, accessibleOrgIds: [] }, {})],
    [WRITE_ORG_AMBIGUOUS_ERROR, () => errorOf(partnerAuth, {})],
    ['Organization not found', () => {
      dbh.results.push([]);
      return errorOf(orgAuth, {});
    }],
  ])('"%s" is not access-denied', async (message, produce) => {
    expect(await produce()).toBe(message);
    expect(isOwnerAccessDeniedMessage(message)).toBe(false);
  });
});
