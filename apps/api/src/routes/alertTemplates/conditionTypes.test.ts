import { describe, it, expect, vi, beforeEach } from 'vitest';
import { Hono } from 'hono';

// Regression coverage for #2948 on the alert-TEMPLATE routes.
//
// These endpoints validate `conditions` as `z.record(z.string(), z.any())` — an
// OBJECT, never an array — which is a different payload shape from
// POST /alerts/rules. Two things follow, and both are covered here:
//
//   * AlertTemplateEditor posts `{ triggers: [...], thresholdDefaults, ... }`,
//     so a retired type sits under `conditions.triggers[]`, not at the root. A
//     structure-aware walk that only recursed on a `conditions` array missed
//     this entirely and made the guard dead code for the product's own UI.
//   * The toggle route is the one-click path back to an enabled-but-unfirable
//     rule after the cleanup migration deactivated it.

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

vi.mock('../../db', () => ({ db: makeDb() }));
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

describe('alert-template condition types (#2948)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    dbRef.current = [];
    authRef.current = {
      scope: 'organization',
      user: { id: 'u-1', name: 'Tess Tech', email: 'tess@org.example' },
      partnerId: null, orgId: 'org-1', accessibleOrgIds: null, canAccessOrg: () => true,
    } as typeof authRef.current;
  });

  it('rejects a template whose editor-envelope triggers carry the retired type', async () => {
    const res = await request(templateRoutes, '/alert-templates/templates', 'POST', {
      name: 'T', severity: 'high',
      conditions: EDITOR_ENVELOPE([{ type: 'custom', field: 'x', customCondition: '> 1' }]),
    });

    expect(res.status).toBe(400);
    expect((await res.json() as { error: string }).error).toContain('custom');
  });

  it('accepts the same envelope when its triggers are live types', async () => {
    // `event` is what the editor actually writes and has no registry handler —
    // a registry-allowlist guard would have 400'd every template save.
    const res = await request(templateRoutes, '/alert-templates/templates', 'POST', {
      name: 'T', severity: 'high',
      conditions: EDITOR_ENVELOPE([{ type: 'event', eventSource: 'system', pattern: 'disk' }]),
    });

    expect(res.status).not.toBe(400);
  });

  it('rejects a retired type on template update', async () => {
    dbRef.current = [[{ id: TEMPLATE_ID, orgId: 'org-1', partnerId: null, isBuiltIn: false }]];

    const res = await request(templateRoutes, `/alert-templates/templates/${TEMPLATE_ID}`, 'PATCH', {
      conditions: EDITOR_ENVELOPE([{ type: 'custom' }]),
    });

    expect(res.status).toBe(400);
    expect((await res.json() as { error: string }).error).toContain('custom');
  });

  it('rejects a retired type in the object-shaped rule override', async () => {
    const res = await request(ruleRoutes, '/alert-templates/rules', 'POST', {
      templateId: TEMPLATE_ID, name: 'r',
      conditions: { type: 'custom', customCondition: 'x' },
    });

    expect(res.status).toBe(400);
    expect((await res.json() as { error: string }).error).toContain('custom');
  });

  it('refuses to re-enable a rule the cleanup migration deactivated', async () => {
    dbRef.current = [
      // ruleOwnershipConditionForOrg's organizations lookup runs first
      [{ partnerId: null }],
      // then the rule lookup — inactive, with all-custom override conditions
      [{
        id: RULE_ID, orgId: 'org-1', isActive: false, templateId: TEMPLATE_ID,
        overrideSettings: { conditions: [{ type: 'custom' }] },
      }],
    ];

    const res = await request(ruleRoutes, `/alert-templates/rules/${RULE_ID}/toggle`, 'POST', { enabled: true });

    expect(res.status).toBe(400);
    const body = await res.json() as { error: string };
    expect(body.error).toContain('custom');
    expect(body.error).toMatch(/cannot be re-enabled/i);
  });

  it('falls back to the template conditions when the rule carries no override', async () => {
    dbRef.current = [
      [{ partnerId: null }],
      [{ id: RULE_ID, orgId: 'org-1', isActive: false, templateId: TEMPLATE_ID, overrideSettings: {} }],
      [{ conditions: [{ type: 'custom' }] }],
    ];

    const res = await request(ruleRoutes, `/alert-templates/rules/${RULE_ID}/toggle`, 'POST', { enabled: true });

    expect(res.status).toBe(400);
  });

  it('still allows re-enabling a rule with a supported condition', async () => {
    dbRef.current = [
      [{ partnerId: null }],
      [{
        id: RULE_ID, orgId: 'org-1', isActive: false, templateId: TEMPLATE_ID,
        overrideSettings: { conditions: [{ type: 'metric', metric: 'cpu', operator: 'gt', value: 85 }] },
      }],
      [{ id: RULE_ID, isActive: true }],
    ];

    const res = await request(ruleRoutes, `/alert-templates/rules/${RULE_ID}/toggle`, 'POST', { enabled: true });

    expect(res.status).not.toBe(400);
  });

  it('does not re-check an already-active rule being toggled off', async () => {
    dbRef.current = [
      [{ partnerId: null }],
      [{
        id: RULE_ID, orgId: 'org-1', isActive: true, templateId: TEMPLATE_ID,
        overrideSettings: { conditions: [{ type: 'custom' }] },
      }],
      [{ id: RULE_ID, isActive: false }],
    ];

    const res = await request(ruleRoutes, `/alert-templates/rules/${RULE_ID}/toggle`, 'POST', { enabled: false });

    expect(res.status).not.toBe(400);
  });
});
