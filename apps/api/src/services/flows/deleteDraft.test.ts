/**
 * Flows completion W01b (#12435): `deleteDraftFlow`, the service behind
 * DELETE /flows/:id. The real-DB proof (RLS, the row lock against a concurrent
 * enable, no cascade beyond the draft) is
 * __tests__/integration/flowDraftRoutes.integration.test.ts.
 *
 * The DB fake answers each awaited query with the next queued result, in the
 * service's order: the locked row, the publication count, the conversion, the
 * run count, then the delete.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { AuthContext } from '../../middleware/auth';

const dbh = vi.hoisted(() => ({ results: [] as unknown[][], calls: [] as string[] }));
vi.mock('../../db', () => {
  const chain = (kind: string) => (): unknown => {
    dbh.calls.push(kind);
    const proxy: unknown = new Proxy(() => {}, {
      get(_t, prop) {
        if (prop === 'then') {
          const value = dbh.results.shift() ?? [];
          return (res: (v: unknown) => void) => Promise.resolve(value).then(res);
        }
        if (prop === 'for') {
          return (mode: string) => {
            dbh.calls.push(`for:${mode}`);
            return proxy;
          };
        }
        return () => proxy;
      },
    });
    return proxy;
  };
  return {
    db: { select: chain('select'), insert: chain('insert'), update: chain('update'), delete: chain('delete') },
    runOutsideDbContext: (fn: () => unknown) => fn(),
    withSystemDbAccessContext: (fn: () => unknown) => fn(),
    getCurrentDbAccessContext: () => null,
  };
});
vi.mock('../auditEvents', () => ({ writeAuditEvent: vi.fn(), requestLikeFromSnapshot: () => ({}) }));
vi.mock('../sentry', () => ({ captureException: vi.fn() }));

import { writeAuditEvent } from '../auditEvents';
import { deleteDraftFlow } from './deleteDraft';

const ORG = '11111111-1111-4111-8111-111111111111';
const PARTNER = '22222222-2222-4222-8222-222222222222';
const FLOW = '33333333-3333-4333-8333-333333333333';
const CONVERSION = '44444444-4444-4444-8444-444444444444';
const AUTOMATION = '55555555-5555-4555-8555-555555555555';

const user = { id: 'u1', email: 'tech@example.com' };
const orgAuth = { scope: 'organization', orgId: ORG, partnerId: PARTNER, user } as unknown as AuthContext;
const fullPartner = { scope: 'partner', partnerId: PARTNER, partnerOrgAccess: 'all', user } as unknown as AuthContext;
const selectedPartner = { scope: 'partner', partnerId: PARTNER, partnerOrgAccess: 'selected', user } as unknown as AuthContext;

const draft = (o: Record<string, unknown> = {}) => ({
  id: FLOW, orgId: ORG, partnerId: null, name: 'Nightly', status: 'draft', definitionVersion: 2, enabledPublicationSeq: null,
  definition: { secret: 'never-audited' }, ...o,
});

/** Queue the reads that follow the lock, for a row with no history. */
function queueClean(row = draft()) {
  dbh.results.push([row], [{ n: 0 }], [], [{ n: 0 }], [{ id: FLOW }]);
}

describe('deleteDraftFlow', () => {
  beforeEach(() => {
    dbh.results.length = 0;
    dbh.calls.length = 0;
    vi.mocked(writeAuditEvent).mockReset();
  });

  it('delete of a never-published draft is 204 and audited', async () => {
    queueClean();
    expect(await deleteDraftFlow(orgAuth, FLOW, 2)).toEqual({ ok: true });
    // Locked FOR UPDATE first, then deleted.
    expect(dbh.calls.slice(0, 2)).toEqual(['select', 'for:update']);
    expect(dbh.calls).toContain('delete');
    expect(writeAuditEvent).toHaveBeenCalledTimes(1);
    const event = vi.mocked(writeAuditEvent).mock.calls[0]![1];
    expect(event).toMatchObject({
      orgId: ORG, actorId: 'u1', action: 'flow.draft.delete', resourceType: 'flow', resourceId: FLOW, resourceName: 'Nightly', result: 'success',
      details: { definitionVersion: 2, ownerScope: 'organization' },
    });
    // Never the definition.
    expect(JSON.stringify(event)).not.toContain('never-audited');
  });

  it('a partner-wide draft is audited against the partner', async () => {
    queueClean(draft({ orgId: null, partnerId: PARTNER }));
    expect(await deleteDraftFlow(fullPartner, FLOW, 2)).toEqual({ ok: true });
    expect(vi.mocked(writeAuditEvent).mock.calls[0]![1]).toMatchObject({ orgId: null, partnerId: PARTNER, details: { ownerScope: 'partner' } });
  });

  it('an unknown or RLS-hidden flow is flow_not_found', async () => {
    dbh.results.push([]);
    expect(await deleteDraftFlow(orgAuth, FLOW, 1)).toEqual({ ok: false, error: 'flow_not_found' });
    expect(dbh.calls).not.toContain('delete');
  });

  it('org token DELETE on a partner-wide flow is 404', async () => {
    dbh.results.push([draft({ orgId: null, partnerId: PARTNER })]);
    expect(await deleteDraftFlow(orgAuth, FLOW, 2)).toEqual({ ok: false, error: 'flow_not_found' });
    expect(dbh.calls).not.toContain('delete');
  });

  it('a selected-access partner user deleting a partner-wide draft is partner_wide_forbidden', async () => {
    dbh.results.push([draft({ orgId: null, partnerId: PARTNER })]);
    expect(await deleteDraftFlow(selectedPartner, FLOW, 2)).toEqual({ ok: false, error: 'partner_wide_forbidden' });
    expect(dbh.calls).not.toContain('delete');
  });

  it('stale expectedVersion is 409', async () => {
    dbh.results.push([draft()]);
    expect(await deleteDraftFlow(orgAuth, FLOW, 1)).toEqual({ ok: false, error: 'version_conflict' });
    expect(dbh.calls).not.toContain('delete');
  });

  it('a disabled flow is 409 flow_has_history', async () => {
    dbh.results.push([draft({ status: 'disabled', enabledPublicationSeq: 1 })]);
    expect(await deleteDraftFlow(orgAuth, FLOW, 2)).toEqual({ ok: false, error: 'flow_has_history' });
    expect(dbh.calls).not.toContain('delete');
  });

  it.each(['enabled', 'paused'])('an %s flow is 409 flow_has_history', async (status) => {
    dbh.results.push([draft({ status, enabledPublicationSeq: 1 })]);
    expect(await deleteDraftFlow(orgAuth, FLOW, 2)).toEqual({ ok: false, error: 'flow_has_history' });
  });

  it('a draft with a publication is 409 flow_has_history', async () => {
    // A draft that once published (status draft, but a flow_versions row exists).
    dbh.results.push([draft()], [{ n: 1 }]);
    expect(await deleteDraftFlow(orgAuth, FLOW, 2)).toEqual({ ok: false, error: 'flow_has_history' });
    expect(dbh.calls).not.toContain('delete');
  });

  it("a shadow conversion's draft is 409 flow_has_history with conversionId and automationId", async () => {
    dbh.results.push([draft()], [{ n: 0 }], [{ id: CONVERSION, automationId: AUTOMATION }]);
    expect(await deleteDraftFlow(orgAuth, FLOW, 2)).toEqual({
      ok: false, error: 'flow_has_history', conversionId: CONVERSION, automationId: AUTOMATION,
    });
    expect(dbh.calls).not.toContain('delete');
  });

  it('a draft with any run is 409 flow_has_history', async () => {
    dbh.results.push([draft()], [{ n: 0 }], [], [{ n: 1 }]);
    expect(await deleteDraftFlow(orgAuth, FLOW, 2)).toEqual({ ok: false, error: 'flow_has_history' });
    expect(dbh.calls).not.toContain('delete');
  });

  it('a delete that matches no row (the guarded WHERE) is flow_not_found and not audited', async () => {
    dbh.results.push([draft()], [{ n: 0 }], [], [{ n: 0 }], []);
    expect(await deleteDraftFlow(orgAuth, FLOW, 2)).toEqual({ ok: false, error: 'flow_not_found' });
    expect(writeAuditEvent).not.toHaveBeenCalled();
  });
});
