import { describe, it, expect, vi, beforeEach } from 'vitest';
import { Hono } from 'hono';

const ORG_ID = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc';
const OTHER_ORG_ID = '99999999-9999-4999-8999-999999999999';
const PARTNER_ID = 'ffffffff-ffff-4fff-8fff-ffffffffffff';
const SCRIPT_ID = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';

// ---------------------------------------------------------------------------
// Mutable auth + queue-driven db mock (real Drizzle schema, mocked db module).
// ---------------------------------------------------------------------------
const h = vi.hoisted(() => {
  const state = {
    auth: {} as Record<string, unknown>,
    selectQueue: [] as unknown[][],
    inserts: [] as Array<{ table: unknown; values: unknown }>,
    updates: [] as Array<{ table: unknown; values: unknown }>
  };
  function chain(get: () => unknown) {
    const c: Record<string, unknown> = {};
    for (const m of ['from', 'where', 'limit', 'orderBy', 'offset', 'innerJoin', 'leftJoin']) {
      c[m] = () => c;
    }
    (c as { then: unknown }).then = (res: (v: unknown) => unknown, rej: (e: unknown) => unknown) =>
      Promise.resolve().then(get).then(res, rej);
    return c;
  }
  return { state, chain };
});

// Mirror routes/scripts.test.ts: stub the services barrel so the transitive
// service graph (queues, config validation) never loads in the test fork.
vi.mock('../services', () => ({}));

vi.mock('../db', () => ({
  db: {
    select: vi.fn(() => h.chain(() => h.state.selectQueue.shift() ?? [])),
    insert: vi.fn((table: unknown) => ({
      values: vi.fn((values: unknown) => {
        h.state.inserts.push({ table, values });
        const rows = Array.isArray(values)
          ? (values as Record<string, unknown>[]).map((v, i) => ({ id: `generated-${i}`, ...v }))
          : [{ id: SCRIPT_ID, ...(values as Record<string, unknown>) }];
        const p = Promise.resolve(rows) as Promise<unknown> & { returning?: unknown };
        p.returning = () => Promise.resolve(rows);
        return p;
      })
    })),
    update: vi.fn((table: unknown) => ({
      set: vi.fn((values: unknown) => {
        h.state.updates.push({ table, values });
        return { where: vi.fn(() => Promise.resolve()) };
      })
    }))
  },
  runOutsideDbContext: vi.fn((fn: () => unknown) => fn()),
  withSystemDbAccessContext: vi.fn(async (fn: () => unknown) => fn())
}));

vi.mock('../services/auditEvents', () => ({
  requestLikeFromSnapshot: vi.fn(() => ({ req: { header: () => undefined } })),
  writeRouteAudit: vi.fn()
}));

vi.mock('../middleware/auth', () => ({
  authMiddleware: vi.fn((c: { set: (k: string, v: unknown) => void }, next: () => Promise<void>) => {
    c.set('auth', h.state.auth);
    return next();
  }),
  requireScope: vi.fn(() => async (_c: unknown, next: () => Promise<void>) => next()),
  requirePermission: vi.fn(() => async (_c: unknown, next: () => Promise<void>) => next()),
  requireMfa: vi.fn(() => async (_c: unknown, next: () => Promise<void>) => next())
}));

import { scriptRoutes } from './scripts';
import { scripts as scriptsTable } from '../db/schema';
import { writeRouteAudit } from '../services/auditEvents';
import { PARTNER_WIDE_WRITE_DENIED_MESSAGE } from '../services/partnerWideAccess';

function setAuth(overrides: Record<string, unknown> = {}) {
  h.state.auth = {
    user: { id: 'user-123', email: 'test@example.com', name: 'Test User' },
    scope: 'organization',
    partnerId: PARTNER_ID,
    orgId: ORG_ID,
    partnerOrgAccess: undefined,
    accessibleOrgIds: [ORG_ID],
    canAccessOrg: (orgId: string) => orgId === ORG_ID,
    ...overrides
  };
}

const baseEntry = {
  name: 'Clear print spooler',
  osTypes: ['windows'],
  language: 'powershell',
  content: 'Restart-Service Spooler'
};

function importRequest(app: Hono, body: Record<string, unknown>) {
  return app.request('/scripts/bundle/import', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: 'Bearer valid-token' },
    body: JSON.stringify(body)
  });
}

describe('script bundle routes', () => {
  let app: Hono;

  beforeEach(() => {
    vi.clearAllMocks();
    h.state.selectQueue = [];
    h.state.inserts = [];
    h.state.updates = [];
    setAuth();
    app = new Hono();
    app.route('/scripts', scriptRoutes);
  });

  describe('POST /scripts/bundle/import — partner-wide gate (#3262)', () => {
    it("rejects availability 'partner' for a partner user without canManagePartnerWidePolicies (403, nothing written)", async () => {
      setAuth({ scope: 'partner', orgId: null, partnerOrgAccess: 'selected' });
      const res = await importRequest(app, {
        bundle: { bundleVersion: 1, scripts: [baseEntry] },
        mode: 'skip',
        availability: 'partner'
      });
      expect(res.status).toBe(403);
      const body = await res.json();
      expect(body.error).toBe(PARTNER_WIDE_WRITE_DENIED_MESSAGE);
      expect(h.state.inserts).toHaveLength(0);
      expect(writeRouteAudit).not.toHaveBeenCalled();
    });

    it("rejects availability 'partner' for an org-scope caller", async () => {
      setAuth({ scope: 'organization' });
      const res = await importRequest(app, {
        bundle: { bundleVersion: 1, scripts: [baseEntry] },
        mode: 'skip',
        availability: 'partner'
      });
      expect(res.status).toBe(403);
      expect(h.state.inserts).toHaveLength(0);
    });

    it("imports partner-wide (org_id NULL, partner_id = caller's partner) for a full-partner admin", async () => {
      setAuth({ scope: 'partner', orgId: null, partnerOrgAccess: 'all' });
      h.state.selectQueue.push([]); // no name conflict
      const res = await importRequest(app, {
        bundle: { bundleVersion: 1, scripts: [baseEntry] },
        mode: 'skip',
        availability: 'partner'
      });
      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.imported).toBe(1);
      const scriptInsert = h.state.inserts.find((i) => i.table === scriptsTable);
      const values = scriptInsert!.values as Record<string, unknown>;
      expect(values.orgId).toBeNull();
      expect(values.partnerId).toBe(PARTNER_ID);
      expect(values.isSystem).toBe(false);
    });
  });

  it("defaults availability to 'org': an org caller's import lands in their org", async () => {
    h.state.selectQueue.push([]);
    const res = await importRequest(app, {
      bundle: { bundleVersion: 1, scripts: [baseEntry] },
      mode: 'skip'
    });
    expect(res.status).toBe(200);
    const values = h.state.inserts.find((i) => i.table === scriptsTable)!.values as Record<string, unknown>;
    expect(values.orgId).toBe(ORG_ID);
    expect(values.partnerId).toBe(PARTNER_ID);
  });

  it('strips isSystem and foreign tenancy from bundle entries — even for a system-scope caller', async () => {
    setAuth({ scope: 'system', orgId: null, partnerId: null, accessibleOrgIds: null });
    h.state.selectQueue.push([]);
    const res = await importRequest(app, {
      bundle: {
        bundleVersion: 1,
        scripts: [{ ...baseEntry, isSystem: true, orgId: OTHER_ORG_ID, partnerId: PARTNER_ID }]
      },
      mode: 'skip',
      availability: 'org',
      orgId: ORG_ID
    });
    expect(res.status).toBe(200);
    const values = h.state.inserts.find((i) => i.table === scriptsTable)!.values as Record<string, unknown>;
    expect(values.isSystem).toBe(false);
    expect(values.orgId).toBe(ORG_ID);
    expect(values.partnerId).toBeNull();
  });

  it('rejects an unknown bundleVersion with 400', async () => {
    const res = await importRequest(app, {
      bundle: { bundleVersion: 99, scripts: [baseEntry] },
      mode: 'skip'
    });
    expect(res.status).toBe(400);
    expect(h.state.inserts).toHaveLength(0);
  });

  it('audits every imported script with the bundle identity', async () => {
    h.state.selectQueue.push([], []);
    const res = await importRequest(app, {
      bundle: {
        bundleVersion: 1,
        scripts: [baseEntry, { ...baseEntry, name: 'Second script' }]
      },
      mode: 'skip'
    });
    expect(res.status).toBe(200);
    expect(writeRouteAudit).toHaveBeenCalledTimes(2);
    const call = vi.mocked(writeRouteAudit).mock.calls[0]![1] as unknown as Record<string, unknown>;
    expect(call.action).toBe('script.bundle.import');
    const details = call.details as Record<string, unknown>;
    expect(typeof details.bundleSha256).toBe('string');
    expect((details.bundleSha256 as string).length).toBe(64);
    expect(details.bundleScriptCount).toBe(2);
    expect(details.mode).toBe('skip');
  });

  describe('GET /scripts/bundle/export', () => {
    it('returns a clean bundle for readable scripts', async () => {
      h.state.selectQueue.push(
        [
          {
            id: SCRIPT_ID,
            orgId: ORG_ID,
            partnerId: PARTNER_ID,
            name: 'Mine',
            description: null,
            category: null,
            osTypes: ['windows'],
            language: 'powershell',
            content: 'Write-Host hi',
            parameters: null,
            timeoutSeconds: 300,
            runAs: 'system',
            isSystem: false,
            version: 1,
            exitCodeSeverityMapping: null,
            deletedAt: null
          }
        ],
        [] // tags
      );
      const res = await app.request(`/scripts/bundle/export?ids=${SCRIPT_ID}`, {
        headers: { Authorization: 'Bearer valid-token' }
      });
      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.bundleVersion).toBe(1);
      expect(body.scripts).toHaveLength(1);
      expect(body.scripts[0]).not.toHaveProperty('orgId');
      expect(body.scripts[0]).not.toHaveProperty('isSystem');
    });

    it('rejects malformed ids', async () => {
      const res = await app.request('/scripts/bundle/export?ids=not-a-guid', {
        headers: { Authorization: 'Bearer valid-token' }
      });
      expect(res.status).toBe(400);
    });
  });

  describe('POST /scripts/bundle/preview', () => {
    it('annotates conflicts without writing', async () => {
      h.state.selectQueue.push([{ id: SCRIPT_ID, name: baseEntry.name, version: 2 }]);
      const res = await app.request('/scripts/bundle/preview', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: 'Bearer valid-token' },
        body: JSON.stringify({ bundle: { bundleVersion: 1, scripts: [baseEntry] } })
      });
      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.entries[0].status).toBe('name-conflict');
      expect(h.state.inserts).toHaveLength(0);
    });

    it('applies the partner-wide gate to preview as well', async () => {
      setAuth({ scope: 'partner', orgId: null, partnerOrgAccess: 'selected' });
      const res = await app.request('/scripts/bundle/preview', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: 'Bearer valid-token' },
        body: JSON.stringify({
          bundle: { bundleVersion: 1, scripts: [baseEntry] },
          availability: 'partner'
        })
      });
      expect(res.status).toBe(403);
    });
  });
});
