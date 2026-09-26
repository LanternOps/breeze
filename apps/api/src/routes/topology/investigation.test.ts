import { beforeEach, describe, expect, it, vi } from 'vitest';
import { Hono } from 'hono';

const mocks = vi.hoisted(() => ({
  status: 200, impact: vi.fn(), changes: vi.fn(),
  command: vi.fn(), poll: vi.fn(), unifi: vi.fn(), scan: vi.fn(), model: vi.fn(), insert: vi.fn(), update: vi.fn(), remove: vi.fn(), execute: vi.fn(),
  correlate: vi.fn(), alertUpdate: vi.fn(), exclusions: vi.fn(),
}));
vi.mock('./middleware', () => ({ requireTopologySiteCapability: () => async (c: any, next: any) => {
  if (mocks.status !== 200) return c.json({ error: 'Denied' }, mocks.status);
  c.set('topologyContext', { scope: { orgId: '10000000-0000-4000-8000-000000000001', siteId: c.req.param('siteId') } });
  return next();
} }));
vi.mock('../../services/topology/impact', () => ({ getTopologyImpact: mocks.impact }));
vi.mock('../../services/topology/changes', () => ({ getRecentTopologyChanges: mocks.changes }));
// Real mutation/probe/alert boundaries: an accidental import and call through these modules is observable.
vi.mock('../../services/commandQueue', () => ({ executeCommand: mocks.command, queueCommand: mocks.command, queueCommandForExecution: mocks.command, executeCommandWithSystemPrecheck: mocks.command }));
vi.mock('../../jobs/snmpWorker', () => ({ enqueueSnmpPoll: mocks.poll, buildSnmpPollCommand: mocks.poll }));
vi.mock('../../services/unifi/unifiCollectorService', () => ({ collectUnifiSite: mocks.unifi }));
vi.mock('../../services/discoveryJobCreation', () => ({ createDiscoveryJobIfIdle: mocks.scan }));
vi.mock('../../services/aiTools', () => ({ executeTool: mocks.model }));
vi.mock('../../jobs/alertCorrelation', () => ({ enqueueAlertCorrelation: mocks.correlate, runAlertCorrelationForDevice: mocks.correlate, processAlertCorrelationJob: mocks.correlate }));
vi.mock('../../services/alertService', () => ({ createAlert: mocks.alertUpdate, createSourcedAlert: mocks.alertUpdate, resolveAlert: mocks.alertUpdate, checkAutoResolve: mocks.alertUpdate }));
vi.mock('../../services/topology/exclusions', () => ({ loadActiveExclusions: mocks.exclusions }));
vi.mock('../../db', () => ({ db: { insert: mocks.insert, update: mocks.update, delete: mocks.remove, execute: mocks.execute } }));
import { topologyInvestigationRoutes } from './investigation';
import { GraphReadError } from '../../services/topology/graphCursor';

const ORG = '10000000-0000-4000-8000-000000000001';
const SITE = '20000000-0000-4000-8000-000000000001';
const NODE = '30000000-0000-4000-8000-000000000001';
const REL = '40000000-0000-4000-8000-000000000001';
const base = `/topology/sites/${SITE}`;
const app = () => new Hono().route('/topology', topologyInvestigationRoutes);
const window = 'since=2026-09-26T00:00:00Z&until=2026-09-26T12:00:00Z';
const sideEffects = () => [mocks.command, mocks.poll, mocks.unifi, mocks.scan, mocks.model, mocks.insert, mocks.update, mocks.remove, mocks.execute, mocks.correlate, mocks.alertUpdate, mocks.exclusions];

beforeEach(() => {
  vi.clearAllMocks(); mocks.status = 200;
  mocks.impact.mockResolvedValue({ siteId: SITE, coverage: 'complete' });
  mocks.changes.mockResolvedValue({ siteId: SITE, changes: [], cursor: null });
});

describe('impact route', () => {
  it('serves impact as private no-store evidence and never dispatches, correlates or touches alerts', async () => {
    const res = await app().request(`${base}/impact?subjectKind=relationship&subjectId=${REL}&graphRevision=7&windowMinutes=10`);
    expect(res.status).toBe(200);
    expect(res.headers.get('cache-control')).toBe('private, no-store');
    expect(mocks.impact).toHaveBeenCalledWith(expect.objectContaining({ scope: { orgId: ORG, siteId: SITE } }), { kind: 'relationship', id: REL }, { graphRevision: '7', windowMinutes: 10 });
    for (const boundary of sideEffects()) expect(boundary).not.toHaveBeenCalled();
  });

  it('defaults the window and leaves the revision unpinned when absent', async () => {
    expect((await app().request(`${base}/impact?subjectKind=node&subjectId=${NODE}&orgId=${ORG}`)).status).toBe(200);
    expect(mocks.impact).toHaveBeenCalledWith(expect.anything(), { kind: 'node', id: NODE }, { windowMinutes: 5 });
  });

  it.each([
    ['missing subject', 'subjectKind=node'],
    ['unknown subject kind', `subjectKind=site&subjectId=${NODE}`],
    ['non-uuid subject', 'subjectKind=node&subjectId=x'],
    ['window over 30 minutes', `subjectKind=node&subjectId=${NODE}&windowMinutes=31`],
    ['window zero', `subjectKind=node&subjectId=${NODE}&windowMinutes=0`],
    ['fractional window', `subjectKind=node&subjectId=${NODE}&windowMinutes=2.5`],
    ['bad revision', `subjectKind=node&subjectId=${NODE}&graphRevision=-1`],
    ['unknown parameter', `subjectKind=node&subjectId=${NODE}&suppress=true`],
    ['view parameter (exclusions never apply)', `subjectKind=node&subjectId=${NODE}&view=physical`],
    ['foreign org override', `subjectKind=node&subjectId=${NODE}&orgId=10000000-0000-4000-8000-000000000002`],
  ])('rejects %s with 400 before the service', async (_label, query) => {
    const response = await app().request(`${base}/impact?${query}`);
    expect(response.status).toBe(400);
    expect(mocks.impact).not.toHaveBeenCalled();
  });

  it.each([401, 403, 404])('blocks unauthorized reads with %s', async (status) => {
    mocks.status = status;
    expect((await app().request(`${base}/impact?subjectKind=node&subjectId=${NODE}`)).status).toBe(status);
    expect(mocks.impact).not.toHaveBeenCalled();
  });

  it('maps a changed graph revision to 409 and a hidden subject to 404', async () => {
    mocks.impact.mockRejectedValueOnce(new GraphReadError('graph_revision_changed', 409, 'Topology graph changed; reload the projection'));
    const conflict = await app().request(`${base}/impact?subjectKind=node&subjectId=${NODE}&graphRevision=3`);
    expect(conflict.status).toBe(409);
    expect(await conflict.json()).toMatchObject({ code: 'graph_revision_changed' });
    mocks.impact.mockRejectedValueOnce(new GraphReadError('topology_subject_not_found', 404, 'Topology subject not found'));
    expect((await app().request(`${base}/impact?subjectKind=node&subjectId=${NODE}`)).status).toBe(404);
  });
});

describe('changes route', () => {
  it('serves a bounded change page as private no-store and never dispatches', async () => {
    const res = await app().request(`${base}/changes?${window}&limit=25&cursor=abc.def`);
    expect(res.status).toBe(200);
    expect(res.headers.get('cache-control')).toBe('private, no-store');
    expect(mocks.changes).toHaveBeenCalledWith(expect.objectContaining({ scope: { orgId: ORG, siteId: SITE } }),
      { since: '2026-09-26T00:00:00Z', until: '2026-09-26T12:00:00Z', limit: 25, cursor: 'abc.def' });
    for (const boundary of sideEffects()) expect(boundary).not.toHaveBeenCalled();
  });

  it.each([
    ['a 25-hour window', 'since=2026-09-25T00:00:00Z&until=2026-09-26T01:00:00Z'],
    ['a limit over 200', `${window}&limit=201`],
    ['a missing since', 'until=2026-09-26T12:00:00Z'],
    ['an unknown parameter', `${window}&kind=collection_gap`],
  ])('rejects %s with 400 before the service', async (_label, query) => {
    expect((await app().request(`${base}/changes?${query}`)).status).toBe(400);
    expect(mocks.changes).not.toHaveBeenCalled();
  });

  it('maps an invalid cursor to 400 with a stable code', async () => {
    mocks.changes.mockRejectedValue(new GraphReadError('invalid_topology_cursor', 400, 'Invalid or expired topology cursor'));
    const res = await app().request(`${base}/changes?${window}&cursor=zzz.yyy`);
    expect(res.status).toBe(400);
    expect(await res.json()).toMatchObject({ code: 'invalid_topology_cursor' });
  });
});
