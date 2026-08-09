/**
 * Route tests for PSA company import (#3246).
 *
 * Kept separate from psa.test.ts because these two routes need a MUTABLE auth
 * context (partner vs org vs system scope, and a cross-partner caller) plus the
 * org-import seam mocked, which the existing suite's fixed org-scope harness
 * cannot express.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { Hono } from 'hono';

vi.mock('../services', () => ({}));

const {
  authState,
  rateLimitGate,
  permissionGate,
  mfaGate,
  selectQueue,
  selectMock,
  updateMock,
  insertMock,
  deleteMock,
  createPSAProviderMock,
  getCompaniesMock,
  previewOrgImportMock,
  commitOrgImportMock,
  writeRouteAuditMock,
} = vi.hoisted(() => ({
  authState: {
    value: {} as Record<string, unknown>,
  },
  rateLimitGate: { deny: false },
  permissionGate: { deny: false },
  mfaGate: { deny: false },
  selectQueue: [] as unknown[][],
  selectMock: vi.fn(),
  updateMock: vi.fn(),
  insertMock: vi.fn(),
  deleteMock: vi.fn(),
  createPSAProviderMock: vi.fn(),
  getCompaniesMock: vi.fn(),
  previewOrgImportMock: vi.fn(),
  commitOrgImportMock: vi.fn(),
  writeRouteAuditMock: vi.fn(),
}));

function chainMock(resolvedValue: unknown = []) {
  const chain: Record<string, any> = {};
  for (const method of ['from', 'where', 'limit', 'returning', 'values', 'set', 'innerJoin', 'leftJoin', 'orderBy', 'offset']) {
    chain[method] = vi.fn(() => Object.assign(Promise.resolve(resolvedValue), chain));
  }
  return Object.assign(Promise.resolve(resolvedValue), chain);
}

selectMock.mockImplementation(() => chainMock(selectQueue.shift() ?? []));
updateMock.mockImplementation(() => chainMock([]));
insertMock.mockImplementation(() => chainMock([]));
deleteMock.mockImplementation(() => chainMock([]));

vi.mock('../db', () => ({
  runOutsideDbContext: vi.fn((fn: () => unknown) => fn()),
  withDbAccessContext: vi.fn(async (_ctx: unknown, fn: () => Promise<unknown>) => fn()),
  withSystemDbAccessContext: vi.fn(async (fn: () => Promise<unknown>) => fn()),
  db: {
    select: (...args: unknown[]) => selectMock(...(args as [])),
    insert: (...args: unknown[]) => insertMock(...(args as [])),
    update: (...args: unknown[]) => updateMock(...(args as [])),
    delete: (...args: unknown[]) => deleteMock(...(args as [])),
  },
}));

vi.mock('../db/schema', () => ({
  psaConnections: {
    id: 'psa_connections.id',
    orgId: 'psa_connections.org_id',
    partnerId: 'psa_connections.partner_id',
    provider: 'psa_connections.provider',
    name: 'psa_connections.name',
    credentials: 'psa_connections.credentials',
    settings: 'psa_connections.settings',
    syncSettings: 'psa_connections.sync_settings',
    createdAt: 'psa_connections.created_at',
    updatedAt: 'psa_connections.updated_at',
    lastSyncAt: 'psa_connections.last_sync_at',
  },
  psaTicketMappings: { id: 'x', connectionId: 'y', deviceId: 'z' },
  devices: { id: 'devices.id', siteId: 'devices.site_id' },
  organizations: { id: 'organizations.id', partnerId: 'organizations.partner_id' },
}));

vi.mock('../services/psa', () => ({ createPSAProvider: createPSAProviderMock }));

vi.mock('../services/psa/credentials', () => ({
  PsaConfigError: class PsaConfigError extends Error {},
  decryptCredentials: vi.fn((raw: unknown) => (raw === null ? null : { baseUrl: 'https://psa.example.com' })),
  encryptCredentials: vi.fn((v: unknown) => v),
  mergeProviderCredentials: vi.fn((_p: unknown, _e: unknown, next: unknown) => next),
  validateProviderCredentials: vi.fn((provider: string, credentials: unknown) => ({ provider, credentials })),
  validatePsaCredentialBaseUrl: vi.fn(() => null),
}));

vi.mock('../services/orgImport', () => ({
  MAX_IMPORT_ROWS: 1000,
  DEFAULT_IMPORT_SYSTEM: 'csv',
  previewOrgImport: previewOrgImportMock,
  commitOrgImport: commitOrgImportMock,
}));

vi.mock('../services/auditEvents', () => ({ writeRouteAudit: writeRouteAuditMock }));

vi.mock('../services/permissions', () => ({
  PERMISSIONS: {
    ORGS_READ: { resource: 'organizations', action: 'read' },
    ORGS_WRITE: { resource: 'organizations', action: 'write' },
    SITES_WRITE: { resource: 'sites', action: 'write' },
  },
  hasPermission: vi.fn(() => true),
}));

vi.mock('../services/partnerWideAccess', () => ({
  PARTNER_WIDE_WRITE_DENIED_MESSAGE: 'Partner-wide write denied',
  canManagePartnerWidePolicies: vi.fn(() => true),
}));

vi.mock('../middleware/userRateLimit', () => ({
  userRateLimit: vi.fn(() => async (c: any, next: any) => {
    if (rateLimitGate.deny) return c.json({ error: 'Rate limit exceeded', retryAfter: 60 }, 429);
    return next();
  }),
}));

vi.mock('../middleware/auth', () => ({
  withAuthDbAccessContext: vi.fn((_auth: unknown, fn: () => Promise<unknown>) => fn()),
  authMiddleware: vi.fn((c: any, next: any) => {
    c.set('auth', authState.value);
    return next();
  }),
  requireScope: vi.fn((...scopes: string[]) => async (c: any, next: any) => {
    const auth = c.get('auth');
    if (!auth || !scopes.includes(auth.scope)) return c.json({ error: 'Forbidden' }, 403);
    return next();
  }),
  requirePermission: vi.fn(() => async (c: any, next: any) => {
    if (permissionGate.deny) return c.json({ error: 'Permission denied' }, 403);
    c.set('permissions', { permissions: [], scope: 'partner' });
    return next();
  }),
  requireMfa: vi.fn(() => async (c: any, next: any) => {
    if (mfaGate.deny) return c.json({ error: 'MFA required' }, 403);
    return next();
  }),
}));

import { psaRoutes } from './psa';
import { PsaCursorOriginError } from '../services/psa/pagination';

const PARTNER = 'partner-1';
const OTHER_PARTNER = 'partner-2';

function partnerAuth(partnerId = PARTNER) {
  return {
    scope: 'partner',
    partnerId,
    partnerOrgAccess: 'all',
    orgId: null,
    user: { id: 'user-1', email: 'tech@msp.example' },
    canAccessOrg: () => true,
    accessibleOrgIds: [],
    orgCondition: () => undefined,
  };
}

function connectionRow(over: Record<string, unknown> = {}) {
  return {
    id: 'conn-1',
    orgId: null,
    partnerId: PARTNER,
    provider: 'connectwise',
    name: 'Acme ConnectWise',
    credentials: { enc: 'blob' },
    settings: {},
    syncSettings: {},
    createdAt: new Date(),
    updatedAt: new Date(),
    lastSyncAt: null,
    ...over,
  };
}

/** Queue the connection lookup (partner-owned rows need no org lookup). */
function queueConnection(over: Record<string, unknown> = {}) {
  selectQueue.push([connectionRow(over)]);
}

let app: Hono;

beforeEach(() => {
  vi.clearAllMocks();
  selectQueue.length = 0;
  rateLimitGate.deny = false;
  permissionGate.deny = false;
  mfaGate.deny = false;
  authState.value = partnerAuth();

  getCompaniesMock.mockReset();
  getCompaniesMock.mockResolvedValue({
    companies: [
      { id: '1', name: 'Acme Ltd' },
      { id: '2', name: 'Globex' },
    ],
    truncated: false,
  });
  createPSAProviderMock.mockReturnValue({ getCompanies: getCompaniesMock });

  previewOrgImportMock.mockResolvedValue([]);
  commitOrgImportMock.mockResolvedValue({ imported: [], updated: [], skipped: [], errors: [] });

  app = new Hono();
  app.route('/psa', psaRoutes);
});

const preview = (id = 'conn-1') =>
  app.request(`/psa/connections/${id}/import/preview`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({}),
  });

const commit = (body: unknown, id = 'conn-1') =>
  app.request(`/psa/connections/${id}/import`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });

// ─────────────────────────────────────────────────────────────────────────────
// Gates
// ─────────────────────────────────────────────────────────────────────────────

describe('import route gates', () => {
  it('rejects an ORG-scoped token — import writes into a partner tenant tree', async () => {
    authState.value = { ...partnerAuth(), scope: 'organization', orgId: 'org-1' };
    const res = await preview();
    expect(res.status).toBe(403);
    expect(getCompaniesMock).not.toHaveBeenCalled();
  });

  it('requires MFA', async () => {
    mfaGate.deny = true;
    const res = await preview();
    expect(res.status).toBe(403);
    expect(await res.json()).toEqual({ error: 'MFA required' });
    expect(getCompaniesMock).not.toHaveBeenCalled();
  });

  it('requires the write permissions', async () => {
    permissionGate.deny = true;
    const res = await preview();
    expect(res.status).toBe(403);
    expect(getCompaniesMock).not.toHaveBeenCalled();
  });

  it('rate-limits preview, without reaching the PSA', async () => {
    rateLimitGate.deny = true;
    const res = await preview();
    expect(res.status).toBe(429);
    expect(getCompaniesMock).not.toHaveBeenCalled();
  });

  it('404s an unknown connection', async () => {
    selectQueue.push([]);
    const res = await preview();
    expect(res.status).toBe(404);
  });

  it('403s a connection owned by ANOTHER partner', async () => {
    queueConnection({ partnerId: OTHER_PARTNER });
    const res = await preview();
    expect(res.status).toBe(403);
    expect(await res.json()).toEqual({ error: 'Access denied' });
    expect(getCompaniesMock).not.toHaveBeenCalled();
  });

  it('400s a jira connection with a capability error, never calling the PSA', async () => {
    queueConnection({ provider: 'jira' });
    const res = await preview();
    expect(res.status).toBe(400);
    expect((await res.json()).error).toContain('does not support organization import');
    expect(createPSAProviderMock).not.toHaveBeenCalled();
    expect(getCompaniesMock).not.toHaveBeenCalled();
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Preview
// ─────────────────────────────────────────────────────────────────────────────

describe('POST /connections/:id/import/preview', () => {
  it('maps companies to import rows and returns the annotated preview', async () => {
    queueConnection();
    previewOrgImportMock.mockResolvedValue([
      { index: 0, organization: 'Acme Ltd', annotation: 'create', slug: 'acme-ltd', organizationId: null },
      { index: 1, organization: 'Globex', annotation: 'link-match', slug: null, organizationId: 'org-9' },
    ]);

    const res = await preview();

    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.truncated).toBe(false);
    expect(body.rows).toHaveLength(2);
    expect(body.rows[1].annotation).toBe('link-match');

    // Rows handed to the seam carry the provider slug as externalSystem.
    expect(previewOrgImportMock).toHaveBeenCalledWith(
      [
        { organization: 'Acme Ltd', externalId: '1', externalSystem: 'connectwise' },
        { organization: 'Globex', externalId: '2', externalSystem: 'connectwise' },
      ],
      PARTNER
    );
  });

  it('surfaces truncation to the caller', async () => {
    queueConnection();
    getCompaniesMock.mockResolvedValue({ companies: [{ id: '1', name: 'Acme' }], truncated: true });

    const res = await preview();

    expect(res.status).toBe(200);
    expect((await res.json()).truncated).toBe(true);
  });

  it('maps an off-origin pagination cursor refusal to 502', async () => {
    queueConnection();
    getCompaniesMock.mockRejectedValue(
      new PsaCursorOriginError('https://attacker.example', 'https://psa.example.com')
    );

    const res = await preview();

    expect(res.status).toBe(502);
    expect((await res.json()).error).toContain('attacker.example');
  });

  it('maps a generic PSA failure to 502', async () => {
    queueConnection();
    getCompaniesMock.mockRejectedValue(new Error('upstream exploded'));

    const res = await preview();

    expect(res.status).toBe(502);
    expect((await res.json()).error).toContain('upstream exploded');
  });

  it('403s when an org-owned connection resolves to a DIFFERENT partner', async () => {
    // Defense in depth. ensureConnectionAccess already implies this via
    // canAccessOrg, but if that helper ever loosened, the explicit partner
    // equality check is what still stops a cross-tenant import.
    selectQueue.push([connectionRow({ orgId: 'org-5', partnerId: null })]);
    selectQueue.push([{ partnerId: OTHER_PARTNER }]);

    const res = await preview();

    expect(res.status).toBe(403);
    expect(getCompaniesMock).not.toHaveBeenCalled();
    expect(previewOrgImportMock).not.toHaveBeenCalled();
  });

  it('404s when an org-owned connection has no resolvable partner', async () => {
    selectQueue.push([connectionRow({ orgId: 'org-5', partnerId: null })]);
    selectQueue.push([]);

    const res = await preview();

    expect(res.status).toBe(404);
    expect(getCompaniesMock).not.toHaveBeenCalled();
  });

  it('resolves the partner from the OWNING ORG for an org-owned connection', async () => {
    selectQueue.push([connectionRow({ orgId: 'org-5', partnerId: null })]);
    selectQueue.push([{ partnerId: PARTNER }]);

    const res = await preview();

    expect(res.status).toBe(200);
    expect(previewOrgImportMock).toHaveBeenCalledWith(expect.anything(), PARTNER);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Commit
// ─────────────────────────────────────────────────────────────────────────────

describe('POST /connections/:id/import', () => {
  it('FORCES externalSystem to the connection provider even when the client lies', async () => {
    queueConnection();

    const res = await commit({
      rows: [
        {
          organization: 'Acme Ltd',
          externalId: '1',
          // A caller trying to claim another system's dedupe namespace.
          externalSystem: 'quickbooks',
          expectedAnnotation: 'create',
        },
      ],
      mode: 'skip',
    });

    expect(res.status).toBe(200);
    expect(commitOrgImportMock).toHaveBeenCalledWith(
      [
        {
          organization: 'Acme Ltd',
          externalId: '1',
          externalSystem: 'connectwise',
          expectedAnnotation: 'create',
        },
      ],
      PARTNER,
      { userId: 'user-1' },
      'skip'
    );
  });

  it('preserves the acknowledgement fields the seam needs', async () => {
    queueConnection();

    await commit({
      rows: [
        {
          organization: 'Acme',
          externalId: '1',
          expectedAnnotation: 'matched-soft-deleted',
          expectedOrganizationId: '11111111-1111-4111-8111-111111111111',
          reactivate: true,
        },
        { organization: 'Globex', externalId: '2', expectedAnnotation: 'name-match', forceCreate: true },
      ],
      mode: 'update',
    });

    const [rows, , , mode] = commitOrgImportMock.mock.calls[0]!;
    expect(mode).toBe('update');
    expect(rows[0]).toMatchObject({
      expectedAnnotation: 'matched-soft-deleted',
      expectedOrganizationId: '11111111-1111-4111-8111-111111111111',
      reactivate: true,
    });
    expect(rows[1]).toMatchObject({ expectedAnnotation: 'name-match', forceCreate: true });
  });

  it('writes the org/link/site audit trail AND a connection-level import event', async () => {
    queueConnection();
    commitOrgImportMock.mockResolvedValue({
      imported: [
        {
          index: 0,
          organization: 'Acme Ltd',
          organizationId: 'org-1',
          siteId: 'site-1',
          siteName: 'Acme Ltd',
          createdOrganization: true,
          createdLink: true,
          slug: 'acme-ltd',
        },
      ],
      updated: [],
      skipped: [],
      errors: [],
    });

    const res = await commit({
      rows: [{ organization: 'Acme Ltd', externalId: '1', expectedAnnotation: 'create' }],
      mode: 'skip',
    });

    expect(res.status).toBe(200);

    const actions = writeRouteAuditMock.mock.calls.map(([, e]) => e.action);
    expect(actions).toEqual([
      'organization.create',
      'organization.external_link.create',
      'site.create',
      'psa.connection.import',
    ]);

    const linkEvent = writeRouteAuditMock.mock.calls.find(
      ([, e]) => e.action === 'organization.external_link.create'
    )![1];
    // The link audit records the FORCED system, not anything client-supplied.
    expect(linkEvent.details).toMatchObject({ system: 'connectwise', externalId: '1', source: 'psa_import' });

    const importEvent = writeRouteAuditMock.mock.calls.find(
      ([, e]) => e.action === 'psa.connection.import'
    )![1];
    expect(importEvent.resourceType).toBe('psa_connection');
    expect(importEvent.details).toMatchObject({ provider: 'connectwise', mode: 'skip', requested: 1, imported: 1 });
  });

  it('rejects a body with no rows', async () => {
    queueConnection();
    const res = await commit({ rows: [], mode: 'skip' });
    expect(res.status).toBe(400);
    expect(commitOrgImportMock).not.toHaveBeenCalled();
  });

  it('403s a cross-partner connection before committing anything', async () => {
    queueConnection({ partnerId: OTHER_PARTNER });
    const res = await commit({ rows: [{ organization: 'Acme' }], mode: 'skip' });
    expect(res.status).toBe(403);
    expect(commitOrgImportMock).not.toHaveBeenCalled();
  });

  it('400s a jira connection', async () => {
    queueConnection({ provider: 'jira' });
    const res = await commit({ rows: [{ organization: 'Acme' }], mode: 'skip' });
    expect(res.status).toBe(400);
    expect(commitOrgImportMock).not.toHaveBeenCalled();
  });

  it('makes no outbound PSA call — commit consumes client-supplied rows', async () => {
    queueConnection();
    await commit({ rows: [{ organization: 'Acme', externalId: '1' }], mode: 'skip' });
    expect(getCompaniesMock).not.toHaveBeenCalled();
  });

  it('does not decrypt credentials or build an adapter on the commit path', async () => {
    // Commit never talks to the PSA, so a connection whose credentials were
    // rotated (or are unreadable) must still be able to finish an import the
    // user already previewed.
    queueConnection();

    const res = await commit({ rows: [{ organization: 'Acme', externalId: '1' }], mode: 'skip' });

    expect(res.status).toBe(200);
    expect(createPSAProviderMock).not.toHaveBeenCalled();
  });
});
