import { describe, it, expect, vi, beforeEach } from 'vitest';
import { Hono } from 'hono';

/**
 * Route gates for the AI for Office prompt-template manager.
 *
 * GET requires client_ai_templates:read. POST/PUT/DELETE require
 * client_ai_templates:write plus an MFA-assured session. Both gates run before
 * body validation and before any database access, so a denied request never
 * reads, writes or audits anything.
 *
 * requirePermission / requireMfa are replaced with grant-set stand-ins. The
 * permission stand-in decides with the real hasPermission from
 * services/permissions (so wildcard grants are matched exactly as in
 * production); the MFA stand-in returns the same 403 MFA_REQUIRED body as
 * middleware/auth.ts requireMfa.
 */

const { dbSelectMock, dbInsertMock, dbUpdateMock, dbDeleteMock, writeRouteAuditMock, orgConditionMock, gate } =
  vi.hoisted(() => ({
    orgConditionMock: vi.fn(() => undefined),
    dbSelectMock: vi.fn(),
    dbInsertMock: vi.fn(),
    dbUpdateMock: vi.fn(),
    dbDeleteMock: vi.fn(),
    writeRouteAuditMock: vi.fn(),
    gate: {
      grants: [] as string[],
      mfa: true,
    },
  }));

vi.mock('../../middleware/auth', () => ({
  authMiddleware: vi.fn((c: any, next: any) => {
    if (!c.req.header('authorization')) return c.json({ error: 'Unauthorized' }, 401);
    c.set('auth', {
      scope: 'partner',
      partnerId: 'f0f0f0f0-1111-4222-8333-444455556666',
      partnerOrgAccess: 'all',
      orgId: null,
      accessibleOrgIds: ['0c0c0c0c-1111-4222-8333-444455556666'],
      orgCondition: orgConditionMock,
      user: { id: 'ce11ce11-1111-4222-8333-444455556666', email: 'msp@example.com' },
    });
    return next();
  }),
  requirePermission: vi.fn((resource: string, action: string) => async (c: any, next: any) => {
    const { hasPermission } = await import('../../services/permissions');
    const allowed = hasPermission(
      {
        permissions: gate.grants.map((g) => {
          const [r, a] = g.split(':');
          return { resource: r!, action: a! };
        }),
        partnerId: 'f0f0f0f0-1111-4222-8333-444455556666',
        orgId: null,
        roleId: 'role-under-test',
        scope: 'partner',
      },
      resource,
      action
    );
    if (!allowed) return c.json({ error: 'Permission denied' }, 403);
    return next();
  }),
  requireMfa: vi.fn(() => (c: any, next: any) => {
    if (!gate.mfa) return c.json({ error: 'MFA required', code: 'MFA_REQUIRED' }, 403);
    return next();
  }),
}));

vi.mock('../../config/env', () => ({
  CLIENT_AI_ENTRA_CLIENT_ID: '00000000-aaaa-bbbb-cccc-000000000001',
}));

vi.mock('../../db', () => ({
  db: { select: dbSelectMock, insert: dbInsertMock, update: dbUpdateMock, delete: dbDeleteMock },
}));
vi.mock('../../services/auditEvents', () => ({ writeRouteAudit: writeRouteAuditMock }));

import { clientAiAdminTemplateRoutes } from './adminTemplates';
import { authMiddleware } from '../../middleware/auth';

const PARTNER_ID = 'f0f0f0f0-1111-4222-8333-444455556666';
const ORG_ID = '0c0c0c0c-1111-4222-8333-444455556666';
const TEMPLATE_ID = '7e7e7e7e-1111-4222-8333-444455556666';

const ORG_ROW = {
  id: TEMPLATE_ID,
  orgId: ORG_ID,
  partnerId: null,
  orgName: 'Contoso',
  name: 'Month-end checklist',
  description: null,
  promptBody: 'Walk through the month-end checklist.',
  category: null,
  hosts: null,
  createdAt: new Date(),
  updatedAt: new Date(),
};

function chain(rows: unknown[]) {
  const c: Record<string, unknown> = {};
  const self = vi.fn(() => c);
  for (const m of ['from', 'where', 'orderBy', 'leftJoin', 'limit']) c[m] = self;
  c.then = (resolve: (v: unknown) => unknown, reject?: (e: unknown) => unknown) =>
    Promise.resolve(rows).then(resolve, reject);
  return c;
}

function buildApp() {
  const app = new Hono();
  app.use('*', authMiddleware as never);
  app.route('/client-ai/admin', clientAiAdminTemplateRoutes);
  return app;
}

const AUTHED = { Authorization: 'Bearer token', 'Content-Type': 'application/json' };

type Verb = {
  label: string;
  method: 'GET' | 'POST' | 'PUT' | 'DELETE';
  path: string;
  body?: unknown;
  okStatus: number;
};

const READ: Verb = {
  label: 'GET /templates',
  method: 'GET',
  path: '/client-ai/admin/templates',
  okStatus: 200,
};
const WRITES: Verb[] = [
  {
    label: 'POST /templates',
    method: 'POST',
    path: '/client-ai/admin/templates',
    body: { name: 'New', promptBody: 'Body', orgId: ORG_ID },
    okStatus: 201,
  },
  {
    label: 'PUT /templates/:id',
    method: 'PUT',
    path: `/client-ai/admin/templates/${TEMPLATE_ID}`,
    body: { name: 'Renamed' },
    okStatus: 200,
  },
  {
    label: 'DELETE /templates/:id',
    method: 'DELETE',
    path: `/client-ai/admin/templates/${TEMPLATE_ID}`,
    okStatus: 200,
  },
];

function send(v: Verb, body: unknown = v.body) {
  return buildApp().request(v.path, {
    method: v.method,
    headers: AUTHED,
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
}

function expectNoDbAccess() {
  expect(dbSelectMock).not.toHaveBeenCalled();
  expect(dbInsertMock).not.toHaveBeenCalled();
  expect(dbUpdateMock).not.toHaveBeenCalled();
  expect(dbDeleteMock).not.toHaveBeenCalled();
  expect(writeRouteAuditMock).not.toHaveBeenCalled();
}

beforeEach(() => {
  vi.clearAllMocks();
  gate.grants = [];
  gate.mfa = true;
  dbSelectMock.mockImplementation(() => chain([ORG_ROW]));
  dbInsertMock.mockImplementation(() => ({
    values: vi.fn((v: Record<string, unknown>) => ({
      returning: vi.fn(() => Promise.resolve([{ ...ORG_ROW, ...v }])),
    })),
  }));
  dbUpdateMock.mockImplementation(() => ({
    set: vi.fn((v: Record<string, unknown>) => ({
      where: vi.fn(() => ({
        returning: vi.fn(() => Promise.resolve([{ ...ORG_ROW, ...v }])),
      })),
    })),
  }));
  dbDeleteMock.mockImplementation(() => ({
    where: vi.fn(() => ({ returning: vi.fn(() => Promise.resolve([ORG_ROW])) })),
  }));
});

describe('GET /client-ai/admin/templates requires client_ai_templates:read', () => {
  it('returns 403 with only organizations:read and never reads the db', async () => {
    gate.grants = ['organizations:read', 'organizations:write'];
    const res = await send(READ);
    expect(res.status).toBe(403);
    expectNoDbAccess();
  });

  it('returns 403 with only client_ai_templates:write', async () => {
    gate.grants = ['client_ai_templates:write'];
    const res = await send(READ);
    expect(res.status).toBe(403);
    expectNoDbAccess();
  });

  it('returns 200 with client_ai_templates:read', async () => {
    gate.grants = ['client_ai_templates:read'];
    const res = await send(READ);
    expect(res.status).toBe(200);
    expect((await res.json()).data).toHaveLength(1);
  });

  it('does not require MFA for reads', async () => {
    gate.grants = ['client_ai_templates:read'];
    gate.mfa = false;
    const res = await send(READ);
    expect(res.status).toBe(200);
  });
});

describe.each(WRITES)('$label requires client_ai_templates:write and MFA', (v) => {
  it('returns 403 with only organizations:write and touches nothing', async () => {
    gate.grants = ['organizations:read', 'organizations:write'];
    const res = await send(v);
    expect(res.status).toBe(403);
    expectNoDbAccess();
  });

  it('returns 403 with only client_ai_templates:read and touches nothing', async () => {
    gate.grants = ['client_ai_templates:read'];
    const res = await send(v);
    expect(res.status).toBe(403);
    expectNoDbAccess();
  });

  it('returns 403 MFA_REQUIRED without an MFA-assured session and touches nothing', async () => {
    gate.grants = ['client_ai_templates:read', 'client_ai_templates:write'];
    gate.mfa = false;
    const res = await send(v);
    expect(res.status).toBe(403);
    expect(await res.json()).toMatchObject({ code: 'MFA_REQUIRED' });
    expectNoDbAccess();
  });

  it(`returns ${v.okStatus} with client_ai_templates:write and MFA`, async () => {
    gate.grants = ['client_ai_templates:write'];
    const res = await send(v);
    expect(res.status).toBe(v.okStatus);
    expect(writeRouteAuditMock).toHaveBeenCalledTimes(1);
  });

  it('is satisfied by the wildcard grant', async () => {
    gate.grants = ['*:*'];
    const res = await send(v);
    expect(res.status).toBe(v.okStatus);
  });
});

describe('gates run before body validation', () => {
  const POST = WRITES[0]!;
  const INVALID = { name: '', promptBody: 'x', unexpected: true };

  it('a caller without the write grant gets 403, not a 400 describing the schema', async () => {
    gate.grants = ['organizations:write'];
    const res = await send(POST, INVALID);
    expect(res.status).toBe(403);
    expectNoDbAccess();
  });

  it('a caller without MFA gets 403 MFA_REQUIRED, not a 400', async () => {
    gate.grants = ['client_ai_templates:write'];
    gate.mfa = false;
    const res = await send(POST, INVALID);
    expect(res.status).toBe(403);
    expect(await res.json()).toMatchObject({ code: 'MFA_REQUIRED' });
  });

  it('a fully authorized caller still gets 400 for an invalid body', async () => {
    gate.grants = ['client_ai_templates:write'];
    const res = await send(POST, INVALID);
    expect(res.status).toBe(400);
    expectNoDbAccess();
  });
});

describe('GET /client-ai/admin/templates/org-options (create-dialog org list)', () => {
  const OPTIONS: Verb = {
    label: 'GET /templates/org-options',
    method: 'GET',
    path: '/client-ai/admin/templates/org-options',
    okStatus: 200,
  };

  it('returns 403 to a reader without client_ai_templates:write and never reads the db', async () => {
    gate.grants = ['organizations:read', 'client_ai_templates:read'];
    const res = await send(OPTIONS);
    expect(res.status).toBe(403);
    expectNoDbAccess();
  });

  it('lists only id and name of the orgs the caller can reach for a writer without organizations:read', async () => {
    gate.grants = ['client_ai_templates:write'];
    gate.mfa = false; // a read: no MFA requirement
    dbSelectMock.mockImplementation(() => chain([{ orgId: ORG_ID, orgName: 'Contoso' }]));
    const res = await send(OPTIONS);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ data: [{ orgId: ORG_ID, orgName: 'Contoso' }] });
    expect(orgConditionMock).toHaveBeenCalledTimes(1);
    expect(writeRouteAuditMock).not.toHaveBeenCalled();
  });

  it('honors the ?orgId= narrowing the web client injects', async () => {
    gate.grants = ['client_ai_templates:write'];
    dbSelectMock.mockImplementation(() =>
      chain([
        { orgId: ORG_ID, orgName: 'Contoso' },
        { orgId: '9d9d9d9d-1111-4222-8333-444455556666', orgName: 'Fabrikam' },
      ])
    );
    const res = await send({ ...OPTIONS, path: `${OPTIONS.path}?orgId=${ORG_ID}` });
    expect(res.status).toBe(200);
    expect((await res.json()).data).toEqual([{ orgId: ORG_ID, orgName: 'Contoso' }]);
  });
});
