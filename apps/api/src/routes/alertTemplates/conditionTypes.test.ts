import { describe, it, expect, vi, beforeEach } from 'vitest';
import { Hono } from 'hono';

const { authRef, dbRef } = vi.hoisted(() => ({
  authRef: {
    current: {
      scope: 'organization' as string,
      user: { id: 'u-1', name: 'Tess Tech', email: 'tess@org.example' },
      partnerId: null as string | null,
      orgId: 'org-1' as string | null,
      accessibleOrgIds: null as string[] | null,
      canAccessOrg: (_id: string) => true as boolean,
    },
  },
  // Rows returned, in call order, by each db.select(...) chain.
  dbRef: { current: [] as unknown[][] },
}));

vi.mock('../../middleware/auth', () => ({
  authMiddleware: vi.fn(async (_c: any, next: any) => next()),
  requireScope: () => async (c: any, next: any) => {
    c.set('auth', authRef.current);
    await next();
  },
  requirePermission: () => async (_c: any, next: any) => next(),
  requireMfa: () => async (_c: any, next: any) => next(),
  siteAccessCheck: () => () => true,
}));

// Chainable + thenable Drizzle stub: every chain method returns `this`, and
// awaiting it yields the next queued result array.
function makeDb() {
  const chain: any = new Proxy(function () {} as any, {
    get(_t, prop) {
      if (prop === 'then') {
        return (resolve: (v: unknown) => void) => resolve(dbRef.current.shift() ?? []);
      }
      return () => chain;
    },
    apply: () => chain,
  });
  return { select: () => chain, update: () => chain, insert: () => chain, delete: () => chain };
}

vi.mock('../../db', () => ({
  db: makeDb(),
  // The re-activation gate reads alert_templates in a SYSTEM context: an
  // org-scoped caller cannot see a partner-owned template, and a zero-row read
  // would look like "no retired conditions". Pass-throughs here so the test
  // exercises the real query.
  runOutsideDbContext: (fn: () => unknown) => fn(),
  withSystemDbAccessContext: (fn: () => unknown) => fn(),
}));
vi.mock('../../db/schema', () => ({
  alertRules: { id: 'id', orgId: 'orgId', isActive: 'isActive', templateId: 'templateId' },
  alertTemplates: { id: 'id', orgId: 'orgId', conditions: 'conditions' },
  organizations: { id: 'id', partnerId: 'partnerId' },
}));
vi.mock('../../services/auditEvents', () => ({ writeRouteAudit: vi.fn() }));
vi.mock('./helpers', () => ({
  resolveScopedOrgId: vi.fn(() => 'org-1'),
  parseBoolean: vi.fn(() => undefined),
}));
vi.mock('../../utils/pagination', () => ({
  getPagination: vi.fn(() => ({ page: 1, limit: 50, offset: 0 })),
}));

import { ruleRoutes } from './rules';
import { templateRoutes } from './templates';
import { LEGACY_ALERTING_GONE } from '../legacyAlertingGone';

const RULE_ID = '5d4c3b2a-1111-4222-8333-444455556666';
const TEMPLATE_ID = '11112222-3333-4444-8555-666677778888';

function request(routes: Hono, path: string, method: string, body: unknown) {
  const app = new Hono();
  app.route('/alert-templates', routes);
  return app.request(path, {
    method,
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
}

// The exact envelope AlertTemplateEditor.tsx submits.
const EDITOR_ENVELOPE = (triggers: unknown[]) => ({
  triggers,
  thresholdDefaults: {},
  notifications: {},
  escalationRules: [],
  autoRemediation: {},
  suppression: {},
});

describe('retired alert-template condition writes', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    dbRef.current = [];
  });

  it.each(['custom', 'event', 'metric'])('retires template authoring with %s conditions', async (type) => {
    for (const [method, path] of [
      ['POST', '/alert-templates/templates'],
      ['PATCH', `/alert-templates/templates/${TEMPLATE_ID}`],
    ] as const) {
      const res = await request(templateRoutes, path, method, {
        name: 'T', severity: 'high', conditions: EDITOR_ENVELOPE([{ type }]),
      });
      expect(res.status).toBe(410);
      expect(await res.json()).toEqual(LEGACY_ALERTING_GONE);
    }
  });

  it.each([
    ['POST', '/alert-templates/rules', { templateId: TEMPLATE_ID, name: 'r', conditions: { type: 'custom' } }],
    ['PATCH', `/alert-templates/rules/${RULE_ID}`, { enabled: true }],
    ['POST', `/alert-templates/rules/${RULE_ID}/toggle`, { enabled: true }],
    ['POST', `/alert-templates/rules/${RULE_ID}/toggle`, { enabled: false }],
  ] as const)('retires %s %s regardless of condition or activation state', async (method, path, body) => {
    const res = await request(ruleRoutes, path, method, body);
    expect(res.status).toBe(410);
    expect(await res.json()).toEqual(LEGACY_ALERTING_GONE);
  });
});
