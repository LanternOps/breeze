// A-W05 Task 5c: get_cis_compliance offset-mode envelope + opt-in summary.
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { expectDefaultPageFits, fixtureRow } from './aiToolOutputBudget.testkit';

vi.mock('../db', () => ({
  runOutsideDbContext: vi.fn((fn: any) => fn()),
  withDbAccessContext: vi.fn(async (_ctx: unknown, fn: () => Promise<unknown>) => fn()),
  withSystemDbAccessContext: vi.fn(async (fn: () => Promise<unknown>) => fn()),
  db: { select: vi.fn(), insert: vi.fn(), update: vi.fn(), delete: vi.fn(), transaction: vi.fn() },
}));
vi.mock('../jobs/cisJobs', () => ({ scheduleCisRemediationWithResult: vi.fn() }));
vi.mock('./cisHardening', () => ({ extractFailedCheckIds: vi.fn(() => new Set()) }));

import { db } from '../db';
import { registerCisBenchmarkTools } from './aiToolsCisBenchmark';
import type { AuthContext } from '../middleware/auth';
import type { AiTool } from './aiTools';

const mockDb = db as unknown as { select: ReturnType<typeof vi.fn> };

function handlerFor(name: string): AiTool['handler'] {
  const reg = new Map<string, AiTool>();
  registerCisBenchmarkTools(reg);
  return reg.get(name)!.handler;
}

function makeAuth(): AuthContext {
  return {
    user: { id: 'u1', email: 'a@b.c', name: 'A', isPlatformAdmin: false },
    token: {} as any,
    partnerId: null,
    orgId: 'org-1',
    scope: 'organization',
    accessibleOrgIds: ['org-1'],
    orgCondition: () => undefined,
    canAccessOrg: () => true,
    allowedSiteIds: undefined,
    canAccessSite: () => true,
  } as unknown as AuthContext;
}

function chain(result: unknown): any {
  const p: any = Promise.resolve(result);
  for (const m of ['from', 'innerJoin', 'leftJoin', 'where', 'orderBy', 'limit', 'groupBy', 'offset', 'as']) {
    p[m] = () => p;
  }
  return p;
}

function resultRow(i: number) {
  return {
    ...fixtureRow(i, { orgId: 'id', baselineId: 'id', baselineName: 'medium', baselineBenchmarkVersion: 'short', deviceId: 'id', deviceHostname: 'short', deviceOsType: 'short', deviceStatus: 'short' }),
    baselineLevel: 1, baselineIsActive: true, checkedAt: new Date('2026-09-20T10:00:00Z'),
    score: 80, totalChecks: 100, passedChecks: 80, failedChecks: 20,
    summary: { failedCheckIds: Array.from({ length: 20 }, (_, s) => `CIS-${s}`) },
  };
}

const tool = () => handlerFor('get_cis_compliance');

describe('get_cis_compliance output shape (A-W05 5c)', () => {
  beforeEach(() => vi.clearAllMocks());

  it('declares limit/offset/cursor and includeSummary on the registry', () => {
    const reg = new Map<string, AiTool>();
    registerCisBenchmarkTools(reg);
    const props = (reg.get('get_cis_compliance')!.definition.input_schema as { properties: Record<string, { description: string }> }).properties;
    expect(props.limit!.description).toBe('Max results (default 12, max 500)');
    expect(props.offset!.description).toBe('Pagination offset (default 0)');
    expect(props.cursor!.description).toBe('nextCursor from a previous call with the same filters');
    expect(props.includeSummary).toBeDefined();
  });

  it('a default page of realistic rows fits the chat budget uncompacted, and summary is omitted unless requested', async () => {
    let call = 0;
    const rows = Array.from({ length: 12 }, (_, i) => resultRow(i));
    mockDb.select.mockImplementation(() => {
      call += 1;
      if (call === 1) return chain(null);
      if (call === 2) return chain([{ total: 12, averageScore: 80, failingDevices: 5 }]);
      return chain(rows);
    });

    const raw = await tool()({}, makeAuth());
    const out = JSON.parse(raw) as Record<string, unknown> & { results: Array<Record<string, unknown>> };
    expect(Object.keys(out)).toEqual(expect.arrayContaining(['count', 'totalMatched', 'summary', 'results', 'showing', 'limit', 'offset', 'hasMore', 'nextCursor']));
    expect(out.results[0]!.summary).toBeUndefined();
    expectDefaultPageFits('get_cis_compliance', raw);
  });

  it('includes per-row summary only when includeSummary is true', async () => {
    let call = 0;
    mockDb.select.mockImplementation(() => {
      call += 1;
      if (call === 1) return chain(null);
      if (call === 2) return chain([{ total: 1, averageScore: 80, failingDevices: 0 }]);
      return chain([resultRow(0)]);
    });

    const out = JSON.parse(await tool()({ includeSummary: true }, makeAuth())) as { results: Array<{ summary?: unknown }> };
    expect(out.results[0]!.summary).toBeDefined();
  });
});
