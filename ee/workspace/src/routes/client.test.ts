import { Hono } from 'hono';
import { describe, expect, it, vi } from 'vitest';
import type { ExtensionAuditEvent } from '../hostTypes';
import type { FilingRecord } from '../services/filingService';
import { createClientRoutes } from './client';
import type { WorkspaceAuthContext, WorkspaceRouteEnv } from './adminGate';

const ORG_ID = '11111111-1111-4111-8111-111111111111';
const USER_ID = '33333333-3333-4333-8333-333333333333';
const FILE_ID = '77777777-7777-4777-8777-777777777777';

function orgAuth(overrides: Partial<WorkspaceAuthContext> = {}): WorkspaceAuthContext {
  return {
    user: { id: USER_ID, email: 'jenny@fairoaksca.gov', name: 'Jenny Tran' },
    scope: 'organization',
    orgId: ORG_ID,
    partnerId: undefined,
    accessibleOrgIds: [ORG_ID],
    ...overrides,
  } as WorkspaceAuthContext;
}

function record(overrides: Partial<FilingRecord> = {}): FilingRecord {
  return {
    fileIndexId: FILE_ID,
    relPath: 'Emails/Unfiled/re PO 4021 pipe submittal.eml',
    name: 're PO 4021 pipe submittal.eml',
    emailMeta: { subject: 'RE: PO 4021 - pipe submittal', from: 'pdeluca@fairoaksca.gov' },
    status: null,
    suggestedProjectKey: null,
    suggestedProjectLabel: null,
    matchedEntityType: null,
    matchedEntityValue: null,
    confidence: null,
    rationale: null,
    decidedProjectKey: null,
    ...overrides,
  };
}

const SUGGESTED = record({
  status: 'suggested',
  suggestedProjectKey: '2023-041',
  suggestedProjectLabel: 'Henderson Water Main Replacement',
  matchedEntityType: 'po',
  matchedEntityValue: 'PO 4021',
  confidence: 'high',
  rationale: 'matched City of Fairoaks PO #4021',
});

function makeHarness(options: {
  contentEnabled?: boolean;
  auth?: WorkspaceAuthContext | null;
  match?: { fileIndexId: string; tier: 1 | 2 | 3 } | null;
  fileable?: FilingRecord | null;
} = {}) {
  const emailMatchService = {
    match: vi.fn(async () => (options.match === undefined
      ? { fileIndexId: FILE_ID, tier: 2 as const }
      : options.match)),
  };
  const filingService = {
    get: vi.fn(async (): Promise<FilingRecord | null> => (
      options.fileable === undefined ? record() : options.fileable)),
    classify: vi.fn(async (): Promise<FilingRecord | null> => SUGGESTED),
    assign: vi.fn(async (): Promise<FilingRecord | null> => record({
      status: 'confirmed', decidedProjectKey: '2023-041',
    })),
    projects: vi.fn(async () => [{ key: '2023-041', label: 'Henderson Water Main Replacement' }]),
  };
  const getSettings = vi.fn(async (_orgId: string) => ({
    contentEnabled: options.contentEnabled ?? true,
  }));
  const audit = vi.fn(async (_event: ExtensionAuditEvent) => {});
  const log = vi.fn();
  const app = new Hono<WorkspaceRouteEnv>();
  const auth = options.auth === undefined ? orgAuth() : options.auth;
  app.use('*', async (c, next) => {
    if (auth) c.set('auth', auth);
    await next();
  });
  app.route('/', createClientRoutes({ emailMatchService, filingService, getSettings, audit, log }));
  return { app, emailMatchService, filingService, getSettings, audit, log };
}

const MATCH_QUERY = '/filing/match?subject=RE%3A%20PO%204021%20-%20pipe%20submittal'
  + '&sender=pdeluca%40fairoaksca.gov&date=2026-07-14T10%3A00%3A00.000Z';

describe('client filing routes — gate', () => {
  it.each([
    ['GET', MATCH_QUERY],
    ['GET', '/content/projects'],
    ['POST', `/filing/${FILE_ID}/assign`],
  ])('rejects %s %s for a partner-scoped principal with 403', async (method, path) => {
    const { app, filingService } = makeHarness({ auth: orgAuth({ scope: 'partner' }) });
    const res = await app.request(path, {
      method,
      ...(method === 'POST'
        ? { body: JSON.stringify({ projectKey: '2023-041' }), headers: { 'content-type': 'application/json' } }
        : {}),
    });
    expect(res.status).toBe(403);
    expect(filingService.get).not.toHaveBeenCalled();
    expect(filingService.assign).not.toHaveBeenCalled();
  });

  it('rejects a request with no auth context', async () => {
    const { app } = makeHarness({ auth: null });
    expect((await app.request(MATCH_QUERY)).status).toBe(403);
  });
});

describe('client filing routes — content gate', () => {
  it.each([
    ['GET', MATCH_QUERY],
    ['GET', '/content/projects'],
  ])('answers %s %s with 404 content_disabled when content is off for the org', async (_m, path) => {
    const { app, filingService, emailMatchService } = makeHarness({ contentEnabled: false });
    const res = await app.request(path);
    expect(res.status).toBe(404);
    expect(await res.json()).toEqual({ error: 'content_disabled' });
    expect(emailMatchService.match).not.toHaveBeenCalled();
    expect(filingService.projects).not.toHaveBeenCalled();
  });

  it('answers assign with 404 content_disabled when content is off for the org', async () => {
    const { app, filingService } = makeHarness({ contentEnabled: false });
    const res = await app.request(`/filing/${FILE_ID}/assign`, {
      method: 'POST',
      body: JSON.stringify({ projectKey: '2023-041' }),
      headers: { 'content-type': 'application/json' },
    });
    expect(res.status).toBe(404);
    expect(await res.json()).toEqual({ error: 'content_disabled' });
    expect(filingService.assign).not.toHaveBeenCalled();
  });
});

describe('GET /filing/match', () => {
  it('matches the open message and classifies on demand when no filing row exists', async () => {
    const { app, emailMatchService, filingService, audit } = makeHarness();
    const res = await app.request(MATCH_QUERY);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({
      match: { fileIndexId: FILE_ID, tier: 2, filing: SUGGESTED },
    });
    // org from the auth context, groupIds [] (fail closed: ungrouped only)
    expect(emailMatchService.match).toHaveBeenCalledWith(ORG_ID, {
      subject: 'RE: PO 4021 - pipe submittal',
      sender: 'pdeluca@fairoaksca.gov',
      dateISO: '2026-07-14T10:00:00.000Z',
    }, []);
    expect(filingService.classify).toHaveBeenCalledWith(ORG_ID, FILE_ID, []);
    // The matched file is looked up ONE row at a time — never by scanning the
    // org's whole unfiled list to `.find()` a single id (every pane open pays
    // that cost, on an estate with thousands of unfiled emails).
    expect(filingService.get).toHaveBeenCalledWith(ORG_ID, FILE_ID, []);
    expect(audit).toHaveBeenCalledWith(expect.objectContaining({
      orgId: ORG_ID,
      actorType: 'user',
      actorId: USER_ID,
      action: 'workspace.filing.classify',
      resourceType: 'workspace_file',
      resourceId: FILE_ID,
      result: 'success',
      details: expect.objectContaining({ via: 'client' }),
    }));
  });

  it('passes the internetMessageId through for the tier-1 arm', async () => {
    const { app, emailMatchService } = makeHarness({ match: { fileIndexId: FILE_ID, tier: 1 } });
    const res = await app.request(`${MATCH_QUERY}&internetMessageId=%3Cabc%40mail%3E`);
    expect(res.status).toBe(200);
    expect(emailMatchService.match).toHaveBeenCalledWith(ORG_ID, expect.objectContaining({
      internetMessageId: '<abc@mail>',
    }), []);
  });

  it('does not re-classify when the matched email already carries a filing row', async () => {
    const { app, filingService, audit } = makeHarness({ fileable: SUGGESTED });
    const res = await app.request(MATCH_QUERY);
    expect(await res.json()).toEqual({
      match: { fileIndexId: FILE_ID, tier: 2, filing: SUGGESTED },
    });
    expect(filingService.classify).not.toHaveBeenCalled();
    expect(audit).not.toHaveBeenCalled();
  });

  it('answers match null when no crawled email matches the probe', async () => {
    const { app, filingService } = makeHarness({ match: null });
    const res = await app.request(MATCH_QUERY);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ match: null });
    expect(filingService.classify).not.toHaveBeenCalled();
  });

  // The matched file is outside the caller's filing view (already filed under a
  // project path, tombstoned, or hidden): report the match, never a filing row
  // synthesized from nothing.
  it('reports a null filing when the matched file is not a fileable email in view', async () => {
    const { app, filingService } = makeHarness({ fileable: null });
    const res = await app.request(MATCH_QUERY);
    expect(await res.json()).toEqual({ match: { fileIndexId: FILE_ID, tier: 2, filing: null } });
    expect(filingService.classify).not.toHaveBeenCalled();
  });

  it.each([
    ['missing subject', '/filing/match?sender=a%40b.com'],
    ['unknown key', `${MATCH_QUERY}&orgId=${ORG_ID}`],
    ['non-ISO date', '/filing/match?subject=hi&date=yesterday'],
    ['blank subject', '/filing/match?subject='],
  ])('rejects a %s query with 400', async (_label, path) => {
    const { app, emailMatchService } = makeHarness();
    const res = await app.request(path);
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({ error: 'invalid request' });
    expect(emailMatchService.match).not.toHaveBeenCalled();
  });
});

describe('POST /filing/:fileIndexId/assign', () => {
  async function assign(app: Hono<WorkspaceRouteEnv>, fileIndexId: string, body: unknown) {
    return app.request(`/filing/${fileIndexId}/assign`, {
      method: 'POST',
      body: JSON.stringify(body),
      headers: { 'content-type': 'application/json' },
    });
  }

  it('assigns and audits with the end user as actor', async () => {
    const { app, filingService, audit } = makeHarness();
    const res = await assign(app, FILE_ID, { projectKey: '2023-041' });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({
      filing: record({ status: 'confirmed', decidedProjectKey: '2023-041' }),
    });
    // decidedLabel is the end user's display name; groupIds [] as everywhere.
    expect(filingService.assign)
      .toHaveBeenCalledWith(ORG_ID, FILE_ID, '2023-041', 'Jenny Tran', []);
    expect(audit).toHaveBeenCalledWith(expect.objectContaining({
      orgId: ORG_ID,
      actorType: 'user',
      actorId: USER_ID,
      action: 'workspace.filing.assign',
      resourceType: 'workspace_file',
      resourceId: FILE_ID,
      result: 'success',
      details: { projectKey: '2023-041', via: 'client' },
    }));
  });

  it('passes a reassignment through unchanged', async () => {
    const { app, filingService } = makeHarness();
    filingService.assign.mockResolvedValueOnce(record({
      status: 'reassigned', decidedProjectKey: '2025-012',
    }));
    const res = await assign(app, FILE_ID, { projectKey: '2025-012' });
    expect((await res.json() as { filing: FilingRecord }).filing.status).toBe('reassigned');
  });

  it('answers 404 for an unknown file or project (service null)', async () => {
    const { app, filingService } = makeHarness();
    filingService.assign.mockResolvedValueOnce(null);
    const res = await assign(app, FILE_ID, { projectKey: '9999-999' });
    expect(res.status).toBe(404);
    expect(await res.json()).toEqual({ error: 'not found' });
  });

  it('answers 404 for a malformed fileIndexId without touching the service', async () => {
    const { app, filingService } = makeHarness();
    const res = await assign(app, 'not-a-uuid', { projectKey: '2023-041' });
    expect(res.status).toBe(404);
    expect(filingService.assign).not.toHaveBeenCalled();
  });

  it.each([
    ['unknown key', { projectKey: '2023-041', orgId: ORG_ID }],
    ['empty projectKey', { projectKey: '' }],
    ['over-long projectKey', { projectKey: 'x'.repeat(41) }],
    ['wrong type', { projectKey: 7 }],
    ['no body at all', undefined],
  ])('rejects a %s body with 400', async (_label, body) => {
    const { app, filingService } = makeHarness();
    const res = await assign(app, FILE_ID, body);
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({ error: 'invalid request' });
    expect(filingService.assign).not.toHaveBeenCalled();
  });

  it('keeps a failed audit write from changing the outcome, but logs it', async () => {
    const { app, audit, log } = makeHarness();
    audit.mockRejectedValueOnce(new Error('audit sink down'));
    const res = await assign(app, FILE_ID, { projectKey: '2023-041' });
    expect(res.status).toBe(200);
    expect(log).toHaveBeenCalledWith('error', expect.stringContaining('audit sink down'));
  });
});

describe('GET /content/projects', () => {
  it('returns the org project list', async () => {
    const { app, filingService } = makeHarness();
    const res = await app.request('/content/projects');
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({
      projects: [{ key: '2023-041', label: 'Henderson Water Main Replacement' }],
    });
    expect(filingService.projects).toHaveBeenCalledWith(ORG_ID);
  });
});
