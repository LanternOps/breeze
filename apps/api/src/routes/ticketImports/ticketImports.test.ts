import { beforeEach, describe, expect, it, vi } from 'vitest';
import { Hono } from 'hono';
import { z } from 'zod';

const mocks = vi.hoisted(() => ({
  auth: { value: null as Record<string, unknown> | null },
  store: {
    listSources: vi.fn(),
    getSource: vi.fn(),
    getMappings: vi.fn(),
    readSourceForUse: vi.fn(),
    lockPrincipalForSource: vi.fn(),
    insertSource: vi.fn(),
    lockSource: vi.fn(),
    activeRunOf: vi.fn(),
    updateSource: vi.fn(),
    revokeSource: vi.fn(),
    deleteSource: vi.fn(),
    replaceMappings: vi.fn(),
  },
  runs: {
    startRun: vi.fn(),
    failQueuedRun: vi.fn(),
    getRun: vi.fn(),
    listRuns: vi.fn(),
    listRunIssues: vi.fn(),
    cancelRun: vi.fn(),
  },
  enqueue: vi.fn(),
  audit: vi.fn(),
  s3: { configured: true },
  seal: vi.fn((id: string, creds: Record<string, string>) => `sealed:${id}:${Object.keys(creds).join(',')}`),
  open: vi.fn((_id: string, _ct: string) => ({ token: 'stored-token' })),
  connect: vi.fn(),
  catalog: vi.fn(),
}));

vi.mock('../../middleware/auth', () => ({
  authMiddleware: async (c: any, next: any) => {
    if (!mocks.auth.value) return c.json({ error: 'Unauthorized' }, 401);
    c.set('auth', mocks.auth.value);
    return next();
  },
  requireScope: (...scopes: string[]) => async (c: any, next: any) => {
    const auth = c.get('auth');
    if (!scopes.includes(auth.scope)) return c.json({ error: 'Insufficient scope' }, 403);
    return next();
  },
  requirePermission: () => async (_c: any, next: any) => next(),
  requireMfa: () => async (_c: any, next: any) => next(),
  withAuthDbAccessContext: async (_auth: unknown, fn: () => unknown) => fn(),
}));
vi.mock('../../services/auditEvents', () => ({ writeRouteAudit: mocks.audit }));
vi.mock('../../services/s3Storage', () => ({ isS3Configured: () => mocks.s3.configured }));
vi.mock('../../services/ticketImport/sourceStore', async (orig) => ({
  ...(await orig<typeof import('../../services/ticketImport/sourceStore')>()),
  ...mocks.store,
}));
vi.mock('../../services/ticketImport/runStore', () => mocks.runs);
vi.mock('../../services/ticketImport/importQueue', () => ({ enqueueTicketImportSlice: mocks.enqueue }));
vi.mock('../../services/ticketImport/sourceCredentials', async (orig) => ({
  ...(await orig<typeof import('../../services/ticketImport/sourceCredentials')>()),
  sealSourceCredentials: mocks.seal,
  openSourceCredentials: mocks.open,
}));

import { TicketImportError } from '../../services/ticketImport/importErrors';
import { registerTicketImportModule } from '../../services/ticketImport/moduleRegistry';
import { SourceAuthError } from '../../services/ticketImport/sourceFetch';
import { ticketImportRoutes } from './index';

const PARTNER = '11111111-1111-4111-8111-111111111111';
const USER = '22222222-2222-4222-8222-222222222222';
const OTHER_USER = '33333333-3333-4333-8333-333333333333';
const PRINCIPAL = '44444444-4444-4444-8444-444444444444';
const SOURCE = '55555555-5555-4555-8555-555555555555';
const RUN = '66666666-6666-4666-8666-666666666666';
const WINDOW = '77777777-7777-4777-8777-777777777777';
const ORG = '88888888-8888-4888-8888-888888888888';

registerTicketImportModule({
  id: 'testmod',
  label: 'Test module',
  optionsSchema: z.object({ timeNote: z.boolean().default(true) }).strict(),
  connect: (src) => mocks.connect(src),
  catalog: (src) => mocks.catalog(src),
  scan: async () => ({ rows: [], next: null }),
  load: async () => { throw new Error('unused'); },
  convert: () => { throw new Error('unused'); },
  fetchAttachment: async () => new Uint8Array(),
  probe: async () => ({ state: 'deleted' }),
  isSourceArticleId: () => true,
});

function signIn(overrides: Record<string, unknown> = {}) {
  mocks.auth.value = {
    scope: 'partner',
    partnerId: PARTNER,
    partnerOrgAccess: 'all',
    user: { id: USER, email: 'owner@example.test' },
    ...overrides,
  };
}

function app() {
  const a = new Hono();
  a.route('/ticket-imports', ticketImportRoutes);
  return a;
}

function send(method: string, path: string, body?: unknown) {
  return app().request(`/ticket-imports${path}`, {
    method,
    headers: { 'content-type': 'application/json' },
    ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
  });
}

const sourceView = (extra: Record<string, unknown> = {}) => ({
  id: SOURCE,
  partnerId: PARTNER,
  module: 'testmod',
  label: 'Zammad',
  baseUrl: 'https://helpdesk.example.com',
  principalId: PRINCIPAL,
  ownerUserId: USER,
  options: { timeNote: true },
  hasCredentials: true,
  revokedAt: null,
  revokedBy: null,
  createdBy: USER,
  createdAt: '2026-10-25T00:00:00.000Z',
  updatedAt: '2026-10-25T00:00:00.000Z',
  activeRunId: null,
  ...extra,
});

const connectReport = { identity: { key: '7', name: 'Import', email: null }, permissions: ['ticket.agent'], warnings: [], clockSkewMs: 0 };

const createBody = (extra: Record<string, unknown> = {}) => ({
  module: 'testmod',
  label: 'Zammad',
  baseUrl: 'https://helpdesk.example.com/',
  credentials: { token: 'secret-token-value' },
  principalId: PRINCIPAL,
  ...extra,
});

describe('/ticket-imports routes', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    signIn();
    mocks.s3.configured = true;
    mocks.connect.mockResolvedValue(connectReport);
    mocks.catalog.mockResolvedValue({ orgs: [], groups: [], priorities: [], states: [], attributes: [], counts: {} });
    mocks.store.getSource.mockResolvedValue(sourceView());
    mocks.store.getMappings.mockResolvedValue({ orgs: [], categories: [] });
    mocks.store.readSourceForUse.mockResolvedValue({ view: sourceView(), credentialsEncrypted: 'ciphertext-blob' });
    mocks.store.lockSource.mockResolvedValue({
      id: SOURCE, module: 'testmod', baseUrl: 'https://helpdesk.example.com', principalId: PRINCIPAL, ownerUserId: USER, revoked: false, options: {},
    });
    mocks.store.activeRunOf.mockResolvedValue(null);
    mocks.store.revokeSource.mockResolvedValue({ alreadyRevoked: false });
  });

  describe('who', () => {
    it('refuses an unauthenticated caller', async () => {
      mocks.auth.value = null;
      expect((await send('GET', '/sources')).status).toBe(401);
    });

    it('refuses organization scope and a partner admin without all-org access', async () => {
      signIn({ scope: 'organization' });
      expect((await send('GET', '/modules')).status).toBe(403);
      signIn({ partnerOrgAccess: 'selected' });
      const res = await send('GET', '/sources');
      expect(res.status).toBe(403);
      expect(mocks.store.listSources).not.toHaveBeenCalled();
      expect((await send('POST', `/runs/${RUN}/cancel`)).status).toBe(403);
      expect(mocks.runs.cancelRun).not.toHaveBeenCalled();
    });

    it('lists the modules with their options as JSON Schema', async () => {
      const res = await send('GET', '/modules');
      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.data).toEqual(expect.arrayContaining([
        expect.objectContaining({ id: 'testmod', label: 'Test module', optionsSchema: expect.objectContaining({ type: 'object' }) }),
      ]));
    });
  });

  describe('POST /sources', () => {
    it('live-tests the credential under a generated id, seals it, and never returns it', async () => {
      const res = await send('POST', '/sources', createBody());
      expect(res.status).toBe(201);
      const text = await res.text();
      expect(text).not.toContain('secret-token-value');
      expect(text).not.toContain('sealed:');
      const handle = mocks.connect.mock.calls[0]![0];
      expect(handle.baseUrl).toBe('https://helpdesk.example.com');
      expect(handle.credentials).toEqual({ token: 'secret-token-value' });
      const inserted = mocks.store.insertSource.mock.calls[0]![0];
      expect(inserted.id).toBe(handle.sourceId);
      expect(inserted.credentialsEncrypted).toBe(`sealed:${handle.sourceId}:token`);
      expect(inserted.options).toEqual({ timeNote: true });
      // The principal is checked before the call and again under the lock.
      expect(mocks.store.lockPrincipalForSource).toHaveBeenCalledTimes(2);
      expect(mocks.store.lockPrincipalForSource).toHaveBeenCalledWith({ partnerId: PARTNER, principalId: PRINCIPAL, ownerUserId: USER });
      const audit = mocks.audit.mock.calls[0]![1];
      expect(audit.action).toBe('ticket_import.source_created');
      expect(JSON.stringify(audit)).not.toContain('secret-token-value');
    });

    it('is owner-only: a principal the caller does not own is refused before the source is called', async () => {
      mocks.store.lockPrincipalForSource.mockRejectedValueOnce(
        new TicketImportError('TICKET_IMPORT_OWNER_REQUIRED', 'Only the owner', 403),
      );
      const res = await send('POST', '/sources', createBody());
      expect(res.status).toBe(403);
      expect((await res.json()).code).toBe('TICKET_IMPORT_OWNER_REQUIRED');
      expect(mocks.connect).not.toHaveBeenCalled();
      expect(mocks.store.insertSource).not.toHaveBeenCalled();
    });

    it('refuses rejected credentials, an unsafe URL, an unknown module and invalid options', async () => {
      mocks.connect.mockRejectedValueOnce(new SourceAuthError());
      let res = await send('POST', '/sources', createBody());
      expect(res.status).toBe(400);
      expect((await res.json()).code).toBe('TICKET_IMPORT_INVALID_CREDENTIALS');
      expect(mocks.store.insertSource).not.toHaveBeenCalled();

      res = await send('POST', '/sources', createBody({ baseUrl: 'http://169.254.169.254/latest' }));
      expect((await res.json()).code).toBe('TICKET_IMPORT_INVALID_URL');
      res = await send('POST', '/sources', createBody({ module: 'nope' }));
      expect((await res.json()).code).toBe('TICKET_IMPORT_MODULE_UNKNOWN');
      res = await send('POST', '/sources', createBody({ options: { timeNote: 'yes' } }));
      expect((await res.json()).code).toBe('TICKET_IMPORT_INVALID_OPTIONS');
      res = await send('POST', '/sources', createBody({ credentials: {} }));
      expect(res.status).toBe(400);
      expect(mocks.connect).toHaveBeenCalledTimes(1);
    });
  });

  describe('PATCH /sources/:id', () => {
    it('is owner-only', async () => {
      signIn({ user: { id: OTHER_USER } });
      const res = await send('PATCH', `/sources/${SOURCE}`, { label: 'New' });
      expect(res.status).toBe(403);
      expect((await res.json()).code).toBe('TICKET_IMPORT_OWNER_REQUIRED');
      expect(mocks.store.updateSource).not.toHaveBeenCalled();
    });

    it('requires new credentials for a new origin, and re-tests the stored ones for a new path', async () => {
      let res = await send('PATCH', `/sources/${SOURCE}`, { baseUrl: 'https://other.example.com' });
      expect(res.status).toBe(400);
      expect((await res.json()).code).toBe('TICKET_IMPORT_CREDENTIALS_REQUIRED');
      expect(mocks.store.updateSource).not.toHaveBeenCalled();

      res = await send('PATCH', `/sources/${SOURCE}`, { baseUrl: 'https://helpdesk.example.com/zammad' });
      expect(res.status).toBe(200);
      expect(mocks.open).toHaveBeenCalledWith(SOURCE, 'ciphertext-blob');
      expect(mocks.connect.mock.calls[0]![0].credentials).toEqual({ token: 'stored-token' });
      expect(mocks.store.updateSource).toHaveBeenCalledWith({ partnerId: PARTNER, sourceId: SOURCE, baseUrl: 'https://helpdesk.example.com/zammad' });
    });

    it('re-seals new credentials under the same id (which clears a revocation)', async () => {
      mocks.store.readSourceForUse.mockResolvedValueOnce({ view: sourceView({ revokedAt: '2026-10-24T00:00:00.000Z', hasCredentials: false }), credentialsEncrypted: null });
      const res = await send('PATCH', `/sources/${SOURCE}`, { baseUrl: 'https://new.example.com', credentials: { token: 'new-token' } });
      expect(res.status).toBe(200);
      expect(mocks.store.updateSource).toHaveBeenCalledWith({
        partnerId: PARTNER,
        sourceId: SOURCE,
        baseUrl: 'https://new.example.com',
        credentialsEncrypted: `sealed:${SOURCE}:token`,
      });
      expect(mocks.audit.mock.calls[0]![1].details).toMatchObject({ changed: ['baseUrl', 'credentials'], reconnected: true });
      expect(JSON.stringify(mocks.audit.mock.calls[0]![1])).not.toContain('new-token');
    });

    it('refuses a connection change while a run is active', async () => {
      mocks.store.activeRunOf.mockResolvedValueOnce(RUN);
      const res = await send('PATCH', `/sources/${SOURCE}`, { credentials: { token: 'new-token' } });
      expect(res.status).toBe(409);
      expect((await res.json()).code).toBe('TICKET_IMPORT_RUN_ACTIVE');
      expect(mocks.connect).not.toHaveBeenCalled();
    });
  });

  describe('revoke, delete and mappings', () => {
    it('lets any partner-wide admin revoke and delete (narrowing)', async () => {
      signIn({ user: { id: OTHER_USER } });
      expect((await send('POST', `/sources/${SOURCE}/revoke`)).status).toBe(200);
      expect(mocks.store.revokeSource).toHaveBeenCalledWith(PARTNER, SOURCE, OTHER_USER);
      expect((await send('DELETE', `/sources/${SOURCE}`)).status).toBe(200);
      expect(mocks.store.deleteSource).toHaveBeenCalledWith(PARTNER, SOURCE);
      expect(mocks.audit.mock.calls.map((call) => call[1].action)).toEqual(['ticket_import.source_revoked', 'ticket_import.source_deleted']);
    });

    it('answers 409 TICKET_IMPORT_RUN_ACTIVE from the store', async () => {
      mocks.store.revokeSource.mockRejectedValueOnce(new TicketImportError('TICKET_IMPORT_RUN_ACTIVE', 'busy', 409, { runId: RUN }));
      const res = await send('POST', `/sources/${SOURCE}/revoke`);
      expect(res.status).toBe(409);
      expect(await res.json()).toMatchObject({ code: 'TICKET_IMPORT_RUN_ACTIVE', details: { runId: RUN } });
    });

    it('keeps mappings owner-only and validates the module options', async () => {
      const body = { orgs: [{ sourceOrgKey: null, orgId: ORG }], categories: [], options: { timeNote: false } };
      signIn({ user: { id: OTHER_USER } });
      expect((await send('PUT', `/sources/${SOURCE}/mappings`, body)).status).toBe(403);
      signIn();
      expect((await send('PUT', `/sources/${SOURCE}/mappings`, { ...body, options: { timeNote: 1 } })).status).toBe(400);
      const res = await send('PUT', `/sources/${SOURCE}/mappings`, body);
      expect(res.status).toBe(200);
      expect(mocks.store.replaceMappings).toHaveBeenCalledWith(expect.objectContaining({
        options: { timeNote: false },
        mappings: { orgs: [{ sourceOrgKey: null, sourceOrgName: null, orgId: ORG }], categories: [] },
      }));
    });
  });

  describe('runs', () => {
    const runView = { id: RUN, sourceId: SOURCE, kind: 'import', windowId: WINDOW, state: 'queued' };

    it('starts a run, then enqueues its first slice', async () => {
      mocks.runs.startRun.mockResolvedValue(runView);
      const res = await send('POST', `/sources/${SOURCE}/runs`, { kind: 'import', windowId: WINDOW });
      expect(res.status).toBe(201);
      expect(mocks.runs.startRun).toHaveBeenCalledWith(expect.objectContaining({
        partnerId: PARTNER, sourceId: SOURCE, kind: 'import', windowId: WINDOW, startedBy: USER, objectStorageConfigured: true,
      }));
      expect(mocks.enqueue).toHaveBeenCalledWith({ runId: RUN, partnerId: PARTNER, seq: 0 });
      expect(mocks.audit.mock.calls[0]![1].action).toBe('ticket_import.run_started');
    });

    it('passes the S3 state to the start (the store refuses an import without it)', async () => {
      mocks.s3.configured = false;
      mocks.runs.startRun.mockRejectedValueOnce(new TicketImportError('TICKET_IMPORT_OBJECT_STORAGE_REQUIRED', 'S3', 409));
      const res = await send('POST', `/sources/${SOURCE}/runs`, { kind: 'import', windowId: WINDOW });
      expect(res.status).toBe(409);
      expect(mocks.runs.startRun.mock.calls[0]![0].objectStorageConfigured).toBe(false);
      expect(mocks.enqueue).not.toHaveBeenCalled();
    });

    it('fails the run and answers 503 when the first slice cannot be queued', async () => {
      mocks.runs.startRun.mockResolvedValue(runView);
      mocks.enqueue.mockRejectedValueOnce(new Error('redis down'));
      const res = await send('POST', `/sources/${SOURCE}/runs`, { kind: 'dry_run' });
      expect(res.status).toBe(503);
      expect(mocks.runs.failQueuedRun).toHaveBeenCalledWith(PARTNER, RUN, 'enqueue_failed');
    });

    it('validates the start body', async () => {
      expect((await send('POST', `/sources/${SOURCE}/runs`, { kind: 'import' })).status).toBe(400);
      expect((await send('POST', `/sources/${SOURCE}/runs`, { kind: 'dry_run', windowId: WINDOW })).status).toBe(400);
    });

    it('lets any partner-wide admin cancel, and audits only a real cancel', async () => {
      signIn({ user: { id: OTHER_USER } });
      mocks.runs.cancelRun.mockResolvedValueOnce({ run: { ...runView, state: 'cancelled' }, alreadyFinished: false });
      expect((await send('POST', `/runs/${RUN}/cancel`)).status).toBe(200);
      mocks.runs.cancelRun.mockResolvedValueOnce({ run: { ...runView, state: 'completed' }, alreadyFinished: true });
      const again = await send('POST', `/runs/${RUN}/cancel`);
      expect(await again.json()).toMatchObject({ alreadyFinished: true });
      expect(mocks.audit).toHaveBeenCalledTimes(1);
      mocks.runs.cancelRun.mockResolvedValueOnce(null);
      expect((await send('POST', `/runs/${RUN}/cancel`)).status).toBe(404);
    });

    it('reads a run and pages its issues by kind', async () => {
      mocks.runs.getRun.mockResolvedValueOnce(runView);
      expect((await send('GET', `/runs/${RUN}`)).status).toBe(200);
      mocks.runs.listRunIssues.mockResolvedValueOnce({ issues: [], next: null });
      expect((await send('GET', `/runs/${RUN}/issues?kind=failed&limit=10`)).status).toBe(200);
      expect(mocks.runs.listRunIssues).toHaveBeenCalledWith({ partnerId: PARTNER, runId: RUN, kind: 'failed', limit: 10 });
      expect((await send('GET', `/runs/${RUN}/issues?kind=bogus`)).status).toBe(400);
    });
  });
});
