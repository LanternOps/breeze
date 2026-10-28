/**
 * #10393 — three Huntress AI-tool defects from the US-prod Wisp session:
 *   1. get_huntress_status reported an all-time severity breakdown next to an
 *      open-only incident count, so 13 resolved "critical" incidents read as open.
 *   2. get_huntress_incidents rows carried the full description plus the raw
 *      `details` jsonb, so a 42-row page could not fit the chat budget and came
 *      back as a row-less `summarized: true` digest.
 *   3. No tool read `huntress_agents`, so the "53 unmapped agents" in the status
 *      output could not be listed.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('../db', () => ({
  runOutsideDbContext: vi.fn((fn: any) => fn()),
  withDbAccessContext: vi.fn(async (_ctx: unknown, fn: () => Promise<unknown>) => fn()),
  withSystemDbAccessContext: vi.fn(async (fn: () => Promise<unknown>) => fn()),
  db: { select: vi.fn(), insert: vi.fn(), update: vi.fn(), delete: vi.fn() },
}));
vi.mock('../jobs/huntressSync', () => ({ scheduleHuntressSync: vi.fn() }));

import { PgDialect } from 'drizzle-orm/pg-core';
import type { SQL } from 'drizzle-orm';
import { db } from '../db';
import { registerHuntressTools } from './aiToolsHuntress';
import { compactToolResultForChat } from './aiToolOutput';
import type { AuthContext } from '../middleware/auth';
import type { AiTool } from './aiTools';

const mockDb = db as unknown as { select: ReturnType<typeof vi.fn> };
const dialect = new PgDialect();

function registry(): Map<string, AiTool> {
  const reg = new Map<string, AiTool>();
  registerHuntressTools(reg);
  return reg;
}
function handlerFor(name: string): AiTool['handler'] {
  const tool = registry().get(name);
  if (!tool) throw new Error(`tool ${name} is not registered`);
  return tool.handler;
}
function makeAuth(overrides: Partial<AuthContext> = {}): AuthContext {
  return {
    user: { id: 'u1', email: 'a@b.c', name: 'A', isPlatformAdmin: false },
    token: {} as any, partnerId: null, orgId: 'org-1', scope: 'organization',
    accessibleOrgIds: ['org-1'], orgCondition: () => undefined, canAccessOrg: () => true,
    ...overrides,
  } as unknown as AuthContext;
}

type Captured = { cols: Record<string, unknown> | undefined; where: SQL | undefined; limit?: number };
/** Chainable query mock: records the projection + WHERE and resolves to `rows(cols)`. */
function chain(cols: Record<string, unknown> | undefined, rows: unknown[], log: Captured[]): any {
  const entry: Captured = { cols, where: undefined };
  log.push(entry);
  const p: any = Promise.resolve(rows);
  for (const m of ['from', 'innerJoin', 'leftJoin', 'orderBy', 'groupBy', 'offset']) p[m] = () => p;
  p.where = (w: SQL | undefined) => { entry.where = w; return p; };
  p.limit = (n: number) => { entry.limit = n; return p; };
  return p;
}
const renderWhere = (w: SQL | undefined): string => (w ? dialect.sqlToQuery(w).sql : '');
/** Project a full fake row through the selected columns, as Postgres would. */
function project(cols: Record<string, unknown> | undefined, full: Record<string, unknown>): Record<string, unknown> {
  if (!cols) return full;
  return Object.fromEntries(Object.keys(cols).map((k) => [k, full[k] ?? null]));
}

// ---------------------------------------------------------------------------
// 1. get_huntress_status — severity breakdown counts OPEN incidents only
// ---------------------------------------------------------------------------
describe('get_huntress_status — severity breakdown matches the open-incident population (#10393)', () => {
  beforeEach(() => vi.clearAllMocks());

  const integration = {
    id: 'int1', partnerId: 'p1', name: 'Hunt', isActive: true,
    lastSyncAt: null, lastSyncStatus: null, lastSyncError: null,
  };

  it('filters the per-severity counts with the same resolved-status exclusion as openIncidents and labels them openBySeverity', async () => {
    const log: Captured[] = [];
    let call = 0;
    mockDb.select.mockImplementation((cols?: Record<string, unknown>) => {
      call++;
      if (call === 1) return chain(cols, [integration], log);
      if (cols && 'severity' in cols) {
        return chain(cols, [
          { integrationId: 'int1', severity: 'critical', count: 2 },
          { integrationId: 'int1', severity: 'low', count: 40 },
        ], log);
      }
      if (cols && 'openIncidents' in cols && 'integrationId' in cols) {
        return chain(cols, [{ integrationId: 'int1', openIncidents: 42 }], log);
      }
      if (cols && 'openIncidents' in cols) return chain(cols, [{ openIncidents: 42 }], log);
      if (cols && 'count' in cols) return chain(cols, [{ count: 1 }], log);
      return chain(cols, [], log);
    });

    const parsed = JSON.parse(await handlerFor('get_huntress_status')({}, makeAuth()));

    const severityQuery = log.find((q) => q.cols && 'severity' in q.cols);
    expect(severityQuery).toBeDefined();
    const severitySql = renderWhere(severityQuery!.where);
    expect(severitySql).toMatch(/not in \('resolved', 'closed', 'dismissed'\)/);
    expect(severitySql).toContain('"huntress_incidents"."status"');

    const metrics = parsed.integrations[0].metrics;
    expect(metrics.openIncidents).toBe(42);
    expect(metrics.bySeverity).toBeUndefined();
    expect(metrics.openBySeverity).toEqual([
      { severity: 'critical', count: 2 },
      { severity: 'low', count: 40 },
    ]);
  });
});

// ---------------------------------------------------------------------------
// 2. get_huntress_incidents — lean list rows that survive chat compaction
// ---------------------------------------------------------------------------
const LONG_DESCRIPTION =
  'Huntress detected a persistent foothold on this host. The scheduled task launches an encoded PowerShell '
  + 'payload from a user-writable directory every fifteen minutes and beacons to an external address. '.repeat(6);
function fullIncident(i: number): Record<string, unknown> {
  return {
    id: `00000000-0000-4000-8000-${String(i).padStart(12, '0')}`,
    orgId: '11111111-1111-4111-8111-111111111111',
    integrationId: '22222222-2222-4222-8222-222222222222',
    deviceId: `33333333-3333-4333-8333-${String(i).padStart(12, '0')}`,
    huntressIncidentId: `hr-${1000 + i}`,
    severity: i % 3 === 0 ? 'critical' : 'low',
    category: 'footholds',
    title: `Malicious scheduled task on host ${i}`,
    description: LONG_DESCRIPTION,
    recommendation: 'Remove the scheduled task, delete the payload and reset the user password. '.repeat(4),
    status: 'open',
    reportedAt: '2026-10-27T10:00:00.000Z',
    resolvedAt: null,
    details: { summary: LONG_DESCRIPTION, remediations: [{ type: 'task', text: LONG_DESCRIPTION }] },
    createdAt: '2026-10-27T10:05:00.000Z',
    updatedAt: '2026-10-27T10:05:00.000Z',
    deviceHostname: `WKS-${String(i).padStart(3, '0')}`,
  };
}

describe('get_huntress_incidents — list rows are lean enough to reach the model (#10393)', () => {
  beforeEach(() => vi.clearAllMocks());

  function mockIncidentList(total: number, log: Captured[]) {
    mockDb.select.mockImplementation((cols?: Record<string, unknown>) => {
      if (cols && 'count' in cols && Object.keys(cols).length === 1) return chain(cols, [{ count: total }], log);
      return chain(cols, Array.from({ length: total }, (_, i) => project(cols, fullIncident(i))), log);
    });
  }

  it('does not select the raw details jsonb or the recommendation into list rows, and shortens the description', async () => {
    const log: Captured[] = [];
    mockIncidentList(3, log);
    const parsed = JSON.parse(await handlerFor('get_huntress_incidents')({ limit: 100 }, makeAuth()));

    const listQuery = log.find((q) => q.cols && 'title' in q.cols)!;
    expect(Object.keys(listQuery.cols!)).not.toContain('details');
    expect(Object.keys(listQuery.cols!)).not.toContain('recommendation');

    const row = parsed.incidents[0];
    expect(row.details).toBeUndefined();
    expect(row.recommendation).toBeUndefined();
    expect(typeof row.description).toBe('string');
    expect(row.description.length).toBeLessThan(LONG_DESCRIPTION.length);
    expect(row.description.length).toBeLessThanOrEqual(201);
    expect(row.descriptionTruncated).toBe(true);
    expect(row.title).toBe('Malicious scheduled task on host 0');
    expect(row.deviceHostname).toBe('WKS-000');
  });

  it('a 42-incident page reaches chat as real rows, not a row-less summarized digest', async () => {
    const log: Captured[] = [];
    mockIncidentList(42, log);
    const raw = await handlerFor('get_huntress_incidents')({ limit: 100 }, makeAuth());
    const chat = JSON.parse(compactToolResultForChat('get_huntress_incidents', raw));

    expect(chat.summarized).toBeUndefined();
    expect(chat.total).toBe(42);
    const rows = (chat.incidents as unknown[]).filter((r) => typeof r === 'object');
    expect(rows.length).toBeGreaterThanOrEqual(10);
    expect((rows[0] as { title: string }).title).toContain('Malicious scheduled task');
  });

  it('incidentId returns the one incident in full — description, recommendation and details — under the same scope', async () => {
    const log: Captured[] = [];
    mockDb.select.mockImplementation((cols?: Record<string, unknown>) =>
      chain(cols, [project(cols, fullIncident(7))], log));

    const parsed = JSON.parse(await handlerFor('get_huntress_incidents')(
      { incidentId: '00000000-0000-4000-8000-000000000007' },
      makeAuth({ allowedDeviceIds: ['33333333-3333-4333-8333-000000000007'] } as Partial<AuthContext>),
    ));

    expect(parsed.incident.description).toBe(LONG_DESCRIPTION);
    expect(parsed.incident.recommendation).toContain('Remove the scheduled task');
    expect(parsed.incident.details).toEqual(fullIncident(7).details);
    expect(parsed.incident.descriptionTruncated).toBeUndefined();

    const q = log.find((entry) => entry.cols && 'details' in entry.cols)!;
    const where = renderWhere(q.where);
    expect(where).toContain('"huntress_incidents"."id" = $');
    // The device axis still narrows the lookup (a device-bound run cannot read
    // a sibling device's incident by id), and resolved incidents are readable.
    expect(where).toContain('"huntress_incidents"."device_id" in');
    expect(where).not.toMatch(/not in \('resolved'/);
  });

  it('incidentId that matches nothing in scope is a not-found error, not an empty success', async () => {
    const log: Captured[] = [];
    mockDb.select.mockImplementation((cols?: Record<string, unknown>) => chain(cols, [], log));
    const parsed = JSON.parse(await handlerFor('get_huntress_incidents')(
      { incidentId: '00000000-0000-4000-8000-000000000099' }, makeAuth(),
    ));
    expect(parsed.error).toMatch(/not found/i);
    expect(parsed.incident).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// 3. get_huntress_agents — the mapped/unmapped agent read
// ---------------------------------------------------------------------------
function isDeviceResolverSelect(cols: unknown): boolean {
  return !!cols && typeof cols === 'object' && 'id' in (cols as object) && 'siteId' in (cols as object)
    && Object.keys(cols as object).length === 2;
}
const agentRow = (over: Record<string, unknown> = {}) => ({
  id: 'a1', orgId: 'org-1', integrationId: 'int1', huntressAgentId: 'h-1', hostname: 'BULLET',
  platform: 'windows', status: 'online', lastSeenAt: '2026-10-28T03:00:00.000Z',
  deviceId: null, deviceHostname: null, metadata: { big: 'x'.repeat(5000) }, ...over,
});

describe('get_huntress_agents (#10393)', () => {
  beforeEach(() => vi.clearAllMocks());

  it('is registered as a Tier 1 read in the integrations domain', () => {
    const tool = registry().get('get_huntress_agents');
    expect(tool).toBeDefined();
    expect(tool!.tier).toBe(1);
    expect(tool!.domain).toBe('integrations');
    expect(tool!.deviceArgs).toEqual(['deviceId']);
  });

  it('mapping=unmapped narrows to device_id IS NULL and reports mapped=false without the metadata jsonb', async () => {
    const log: Captured[] = [];
    mockDb.select.mockImplementation((cols?: Record<string, unknown>) => {
      if (cols && 'count' in cols && Object.keys(cols).length === 1) return chain(cols, [{ count: 1 }], log);
      return chain(cols, [project(cols, agentRow())], log);
    });

    const parsed = JSON.parse(await handlerFor('get_huntress_agents')({ mapping: 'unmapped' }, makeAuth()));

    const listQuery = log.find((q) => q.cols && 'hostname' in q.cols)!;
    expect(Object.keys(listQuery.cols!)).not.toContain('metadata');
    expect(renderWhere(listQuery.where)).toContain('"huntress_agents"."device_id" is null');
    const countQuery = log.find((q) => q.cols && 'count' in q.cols)!;
    expect(renderWhere(countQuery.where)).toContain('"huntress_agents"."device_id" is null');

    expect(parsed.total).toBe(1);
    expect(parsed.agents).toEqual([expect.objectContaining({
      hostname: 'BULLET', mapped: false, deviceId: null, status: 'online', lastSeenAt: '2026-10-28T03:00:00.000Z',
    })]);
    expect(parsed.agents[0].metadata).toBeUndefined();
  });

  it('mapping=mapped narrows to device_id IS NOT NULL and links the Breeze device', async () => {
    const log: Captured[] = [];
    mockDb.select.mockImplementation((cols?: Record<string, unknown>) => {
      if (cols && 'count' in cols && Object.keys(cols).length === 1) return chain(cols, [{ count: 1 }], log);
      return chain(cols, [project(cols, agentRow({ deviceId: 'd1', deviceHostname: 'bullet.local' }))], log);
    });

    const parsed = JSON.parse(await handlerFor('get_huntress_agents')({ mapping: 'mapped' }, makeAuth()));
    const listQuery = log.find((q) => q.cols && 'hostname' in q.cols)!;
    expect(renderWhere(listQuery.where)).toContain('"huntress_agents"."device_id" is not null');
    expect(parsed.agents[0]).toEqual(expect.objectContaining({ mapped: true, deviceId: 'd1', deviceHostname: 'bullet.local' }));
  });

  it('rejects an org the caller cannot access before querying', async () => {
    const parsed = JSON.parse(await handlerFor('get_huntress_agents')(
      { orgId: 'org-x' }, makeAuth({ canAccessOrg: () => false } as Partial<AuthContext>),
    ));
    expect(parsed.error).toMatch(/access denied/i);
    expect(mockDb.select).not.toHaveBeenCalled();
  });

  it('applies the org condition, requested org, and the device axis for a device-bound run', async () => {
    const log: Captured[] = [];
    mockDb.select.mockImplementation((cols?: Record<string, unknown>) => {
      if (cols && 'count' in cols && Object.keys(cols).length === 1) return chain(cols, [{ count: 0 }], log);
      return chain(cols, [], log);
    });
    await handlerFor('get_huntress_agents')(
      { orgId: '11111111-1111-4111-8111-111111111111' },
      makeAuth({ allowedDeviceIds: ['d-1'] } as Partial<AuthContext>),
    );
    const where = renderWhere(log.find((q) => q.cols && 'hostname' in q.cols)!.where);
    expect(where).toContain('"huntress_agents"."org_id" = $');
    expect(where).toContain('"huntress_agents"."device_id" in');
  });

  it('a site-restricted caller with no in-scope devices gets an empty list and the agent scan never runs (fail closed)', async () => {
    let scanRan = false;
    mockDb.select.mockImplementation((cols?: unknown) => {
      if (isDeviceResolverSelect(cols)) {
        return { from: () => ({ where: () => Promise.resolve([{ id: 'd-siteB', siteId: 'site-B' }]) }) };
      }
      scanRan = true;
      return chain(cols as Record<string, unknown>, [project(cols as Record<string, unknown>, agentRow())], []);
    });
    const auth = makeAuth({
      allowedSiteIds: ['site-A'],
      canAccessSite: (s: string | null | undefined) => s === 'site-A',
    } as Partial<AuthContext>);
    const parsed = JSON.parse(await handlerFor('get_huntress_agents')({}, auth));
    expect(parsed.agents).toEqual([]);
    expect(parsed.total).toBe(0);
    expect(parsed.scopeNote).toBeDefined();
    expect(scanRan).toBe(false);
  });
});
