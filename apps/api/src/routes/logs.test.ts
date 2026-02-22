import { beforeEach, describe, expect, it, vi } from 'vitest';
import { Hono } from 'hono';

const {
  createSavedLogSearchQueryMock,
  deleteSavedLogSearchQueryMock,
  detectPatternCorrelationMock,
  getLogAggregationMock,
  getLogTrendsMock,
  getSavedLogSearchQueryByIdMock,
  getSavedLogSearchQueryMock,
  listSavedLogSearchQueriesMock,
  runCorrelationRulesMock,
  searchFleetLogsMock,
  updateSavedSearchRunStatsMock,
} = vi.hoisted(() => ({
  createSavedLogSearchQueryMock: vi.fn(),
  deleteSavedLogSearchQueryMock: vi.fn(),
  detectPatternCorrelationMock: vi.fn(),
  getLogAggregationMock: vi.fn(),
  getLogTrendsMock: vi.fn(),
  getSavedLogSearchQueryByIdMock: vi.fn(),
  getSavedLogSearchQueryMock: vi.fn(),
  listSavedLogSearchQueriesMock: vi.fn(),
  runCorrelationRulesMock: vi.fn(),
  searchFleetLogsMock: vi.fn(),
  updateSavedSearchRunStatsMock: vi.fn(),
}));

const { enqueueAdHocPatternCorrelationDetectionMock } = vi.hoisted(() => ({
  enqueueAdHocPatternCorrelationDetectionMock: vi.fn(),
}));

const { getLogCorrelationDetectionJobMock } = vi.hoisted(() => ({
  getLogCorrelationDetectionJobMock: vi.fn(),
}));

vi.mock('../db', () => ({
  db: {
    select: vi.fn(),
  },
}));

vi.mock('../db/schema', () => ({
  logCorrelations: {
    id: 'id',
    orgId: 'orgId',
    ruleId: 'ruleId',
    pattern: 'pattern',
    firstSeen: 'firstSeen',
    lastSeen: 'lastSeen',
    occurrences: 'occurrences',
    affectedDevices: 'affectedDevices',
    sampleLogs: 'sampleLogs',
    status: 'status',
    alertId: 'alertId',
    createdAt: 'createdAt',
  },
  logCorrelationRules: {
    id: 'id',
    name: 'name',
  },
}));

vi.mock('../jobs/logCorrelation', () => ({
  enqueueAdHocPatternCorrelationDetection: enqueueAdHocPatternCorrelationDetectionMock,
  getLogCorrelationDetectionJob: getLogCorrelationDetectionJobMock,
}));

vi.mock('../services/logSearch', () => ({
  createSavedLogSearchQuery: createSavedLogSearchQueryMock,
  deleteSavedLogSearchQuery: deleteSavedLogSearchQueryMock,
  detectPatternCorrelation: detectPatternCorrelationMock,
  getLogAggregation: getLogAggregationMock,
  getLogTrends: getLogTrendsMock,
  getSavedLogSearchQueryById: getSavedLogSearchQueryByIdMock,
  getSavedLogSearchQuery: getSavedLogSearchQueryMock,
  listSavedLogSearchQueries: listSavedLogSearchQueriesMock,
  mergeSavedLogSearchFilters: (savedFilters: Record<string, unknown>, requestFilters: Record<string, unknown>) => ({
    ...savedFilters,
    ...requestFilters,
    query: requestFilters.query ?? savedFilters.query ?? savedFilters.search,
  }),
  resolveSingleOrgId: (auth: any, requestedOrgId?: string) => {
    if (requestedOrgId) {
      return auth.canAccessOrg(requestedOrgId) ? requestedOrgId : null;
    }
    if (auth.orgId) return auth.orgId;
    if (Array.isArray(auth.accessibleOrgIds) && auth.accessibleOrgIds.length === 1) {
      return auth.accessibleOrgIds[0] ?? null;
    }
    return null;
  },
  runCorrelationRules: runCorrelationRulesMock,
  searchFleetLogs: searchFleetLogsMock,
  updateSavedSearchRunStats: updateSavedSearchRunStatsMock,
}));

vi.mock('../middleware/auth', () => ({
  authMiddleware: vi.fn((c: any, next: any) => {
    c.set('auth', {
      scope: 'organization',
      orgId: '11111111-1111-1111-1111-111111111111',
      accessibleOrgIds: ['11111111-1111-1111-1111-111111111111'],
      user: { id: 'user-1' },
      canAccessOrg: (orgId: string) => orgId === '11111111-1111-1111-1111-111111111111',
      orgCondition: () => undefined,
    });
    return next();
  }),
  requireScope: vi.fn(() => async (_c: unknown, next: () => Promise<unknown>) => next()),
}));

import { logsRoutes } from './logs';
import { authMiddleware } from '../middleware/auth';

describe('logs routes', () => {
  let app: Hono;

  beforeEach(() => {
    vi.clearAllMocks();
    app = new Hono();
    app.route('/logs', logsRoutes);

    vi.mocked(authMiddleware).mockImplementation((c: any, next: any) => {
      c.set('auth', {
        scope: 'organization',
        orgId: '11111111-1111-1111-1111-111111111111',
        accessibleOrgIds: ['11111111-1111-1111-1111-111111111111'],
        user: { id: 'user-1' },
        canAccessOrg: (orgId: string) => orgId === '11111111-1111-1111-1111-111111111111',
        orgCondition: () => undefined,
      });
      return next();
    });

    searchFleetLogsMock.mockResolvedValue({
      results: [],
      total: 0,
      totalMode: 'exact',
      limit: 100,
      offset: 0,
      hasMore: false,
      nextCursor: null,
    });
    updateSavedSearchRunStatsMock.mockResolvedValue(undefined);
    getSavedLogSearchQueryMock.mockResolvedValue(null);
    getSavedLogSearchQueryByIdMock.mockResolvedValue(null);
    deleteSavedLogSearchQueryMock.mockResolvedValue(false);
    detectPatternCorrelationMock.mockResolvedValue(null);
    enqueueAdHocPatternCorrelationDetectionMock.mockResolvedValue('job-1');
    getLogCorrelationDetectionJobMock.mockResolvedValue(null);
    runCorrelationRulesMock.mockResolvedValue([]);
    listSavedLogSearchQueriesMock.mockResolvedValue([]);
    createSavedLogSearchQueryMock.mockResolvedValue({ id: 'query-1' });
  });

  it('applies saved query filters and request overrides in POST /logs/search', async () => {
    getSavedLogSearchQueryMock.mockResolvedValue({
      id: '22222222-2222-2222-2222-222222222222',
      filters: {
        query: 'saved query',
        level: ['error'],
        source: 'kernel',
      },
    });

    const res = await app.request('/logs/search', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        savedQueryId: '22222222-2222-2222-2222-222222222222',
        query: 'override query',
        limit: 50,
      }),
    });

    expect(res.status).toBe(200);
    expect(searchFleetLogsMock).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        query: 'override query',
        level: ['error'],
        source: 'kernel',
        limit: 50,
      }),
    );
    expect(updateSavedSearchRunStatsMock).toHaveBeenCalledWith('22222222-2222-2222-2222-222222222222');
  });

  it('queues ad-hoc correlation detection jobs and returns 202', async () => {
    const res = await app.request('/logs/correlation/detect', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        pattern: 'connection reset by peer',
        isRegex: false,
        timeWindow: 600,
      }),
    });

    expect(res.status).toBe(202);
    const body = await res.json();
    expect(body.queued).toBe(true);
    expect(body.jobId).toBe('job-1');
    expect(detectPatternCorrelationMock).not.toHaveBeenCalled();
  });

  it('falls back inline when queueing ad-hoc detection fails', async () => {
    enqueueAdHocPatternCorrelationDetectionMock.mockRejectedValue(new Error('Redis unavailable'));
    detectPatternCorrelationMock.mockResolvedValue({
      orgId: '11111111-1111-1111-1111-111111111111',
      pattern: 'panic',
      firstSeen: new Date('2026-02-21T00:00:00.000Z'),
      lastSeen: new Date('2026-02-21T00:10:00.000Z'),
      occurrences: 12,
      affectedDevices: [],
      sampleLogs: [],
      timeWindowSeconds: 300,
      minDevices: 2,
      minOccurrences: 3,
    });

    const res = await app.request('/logs/correlation/detect', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        pattern: 'panic',
      }),
    });

    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.queued).toBe(false);
    expect(body.fallback).toBe('inline');
    expect(body.detected).toBe(true);
    expect(detectPatternCorrelationMock).toHaveBeenCalled();
  });

  it('returns ad-hoc detection job status and result', async () => {
    getLogCorrelationDetectionJobMock.mockResolvedValue({
      id: 'job-1',
      name: 'pattern-detect',
      state: 'completed',
      data: {
        type: 'pattern',
        orgId: '11111111-1111-1111-1111-111111111111',
        pattern: 'panic',
        isRegex: false,
        queuedAt: '2026-02-21T19:00:00.000Z',
      },
      result: { mode: 'pattern', detected: true },
      failedReason: null,
      attemptsMade: 1,
      processedOn: Date.parse('2026-02-21T19:00:02.000Z'),
      finishedOn: Date.parse('2026-02-21T19:00:03.000Z'),
    });

    const res = await app.request('/logs/correlation/detect/job-1');
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.status).toBe('completed');
    expect(body.result.detected).toBe(true);
  });

  it('returns 403 for inaccessible detection job org', async () => {
    getLogCorrelationDetectionJobMock.mockResolvedValue({
      id: 'job-2',
      name: 'pattern-detect',
      state: 'active',
      data: {
        type: 'pattern',
        orgId: '99999999-9999-9999-9999-999999999999',
        pattern: 'panic',
        isRegex: false,
        queuedAt: '2026-02-21T19:00:00.000Z',
      },
      result: null,
      failedReason: null,
      attemptsMade: 1,
      processedOn: null,
      finishedOn: null,
    });

    const res = await app.request('/logs/correlation/detect/job-2');
    expect(res.status).toBe(403);
  });

  it('allows system scope to delete a non-shared saved query', async () => {
    vi.mocked(authMiddleware).mockImplementation((c: any, next: any) => {
      c.set('auth', {
        scope: 'system',
        orgId: null,
        accessibleOrgIds: [],
        user: { id: 'system-user' },
        canAccessOrg: () => true,
        orgCondition: () => undefined,
      });
      return next();
    });

    getSavedLogSearchQueryByIdMock.mockResolvedValue({
      id: '33333333-3333-3333-3333-333333333333',
      createdBy: 'someone-else',
      isShared: false,
    });
    deleteSavedLogSearchQueryMock.mockResolvedValue(true);

    const res = await app.request('/logs/queries/33333333-3333-3333-3333-333333333333', {
      method: 'DELETE',
    });

    expect(res.status).toBe(204);
    expect(deleteSavedLogSearchQueryMock).toHaveBeenCalledWith(
      expect.objectContaining({ scope: 'system' }),
      '33333333-3333-3333-3333-333333333333',
    );
  });

  it('returns 404 when savedQueryId does not exist', async () => {
    getSavedLogSearchQueryMock.mockResolvedValue(null);

    const res = await app.request('/logs/search', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ savedQueryId: '22222222-2222-2222-2222-222222222222' }),
    });

    expect(res.status).toBe(404);
    const body = await res.json();
    expect(body.error).toMatch(/not found/i);
  });

  it('returns 400 when search service throws a time range error', async () => {
    searchFleetLogsMock.mockRejectedValue(new Error('Invalid time range. start must be before end.'));

    const res = await app.request('/logs/search', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ query: 'test' }),
    });

    expect(res.status).toBe(400);
  });

  it('returns 400 for rules-based correlation detect when orgId cannot be resolved', async () => {
    vi.mocked(authMiddleware).mockImplementation((c: any, next: any) => {
      c.set('auth', {
        scope: 'partner',
        orgId: null,
        accessibleOrgIds: ['org-a', 'org-b'],
        user: { id: 'partner-user' },
        canAccessOrg: () => true,
        orgCondition: () => undefined,
      });
      return next();
    });

    const res = await app.request('/logs/correlation/detect', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({}),
    });

    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.error).toMatch(/orgId/i);
    expect(runCorrelationRulesMock).not.toHaveBeenCalled();
  });

  it('runs correlation rules scoped to resolved orgId', async () => {
    runCorrelationRulesMock.mockResolvedValue([]);

    const res = await app.request('/logs/correlation/detect', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({}),
    });

    expect(res.status).toBe(200);
    expect(runCorrelationRulesMock).toHaveBeenCalledWith(
      expect.objectContaining({ orgId: '11111111-1111-1111-1111-111111111111' }),
    );
  });

  it('GET /logs/queries returns list of saved queries', async () => {
    listSavedLogSearchQueriesMock.mockResolvedValue([
      { id: 'q-1', name: 'My Query' },
    ]);

    const res = await app.request('/logs/queries');
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.data).toHaveLength(1);
    expect(body.data[0].id).toBe('q-1');
  });

  it('POST /logs/queries creates a saved query and returns 201', async () => {
    createSavedLogSearchQueryMock.mockResolvedValue({ id: 'new-query-id', name: 'My Search' });

    const res = await app.request('/logs/queries', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ name: 'My Search', filters: {} }),
    });

    expect(res.status).toBe(201);
    const body = await res.json();
    expect(body.data.id).toBe('new-query-id');
  });

  it('GET /logs/queries/:id returns 404 when query not found', async () => {
    getSavedLogSearchQueryMock.mockResolvedValue(null);

    const res = await app.request('/logs/queries/44444444-4444-4444-4444-444444444444');
    expect(res.status).toBe(404);
  });

  it('returns 403 when non-owner org-scoped user tries to delete a saved query', async () => {
    getSavedLogSearchQueryByIdMock.mockResolvedValue({
      id: '33333333-3333-3333-3333-333333333333',
      createdBy: 'someone-else',
      isShared: false,
    });
    deleteSavedLogSearchQueryMock.mockResolvedValue(false);

    const res = await app.request('/logs/queries/33333333-3333-3333-3333-333333333333', {
      method: 'DELETE',
    });

    expect(res.status).toBe(403);
  });

  it('returns 404 when detection job is not found', async () => {
    getLogCorrelationDetectionJobMock.mockResolvedValue(null);

    const res = await app.request('/logs/correlation/detect/nonexistent-job');
    expect(res.status).toBe(404);
  });
});
