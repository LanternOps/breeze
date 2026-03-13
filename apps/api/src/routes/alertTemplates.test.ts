import { describe, it, expect, vi, beforeEach } from 'vitest';
import { Hono } from 'hono';
import { randomUUID } from 'crypto';

/* ------------------------------------------------------------------ */
/*  In-memory template store                                          */
/* ------------------------------------------------------------------ */
let store: Record<string, any>[] = [];

function makeTemplate(values: Record<string, any>) {
  const now = new Date();
  return {
    id: randomUUID(),
    orgId: values.orgId ?? null,
    name: values.name,
    description: values.description ?? null,
    category: values.category ?? 'Custom',
    conditions: values.conditions ?? {},
    severity: values.severity ?? 'medium',
    titleTemplate: values.titleTemplate ?? '',
    messageTemplate: values.messageTemplate ?? '',
    targets: values.targets ?? null,
    autoResolve: false,
    autoResolveConditions: null,
    cooldownMinutes: values.cooldownMinutes ?? 5,
    isBuiltIn: values.isBuiltIn ?? false,
    createdAt: now,
    updatedAt: now,
  };
}

/* ------------------------------------------------------------------ */
/*  Chainable mock helpers                                            */
/* ------------------------------------------------------------------ */

/** Terminal chain element — any further calls (.orderBy, .limit, etc.) just return the same promise */
function terminalChain(resultFn: () => any): any {
  const promise = Promise.resolve(resultFn());
  const handler: ProxyHandler<any> = {
    get(_target, prop) {
      if (prop === 'then') return promise.then.bind(promise);
      if (prop === 'catch') return promise.catch.bind(promise);
      if (prop === 'finally') return promise.finally.bind(promise);
      // Any further chained method (.orderBy, .limit, etc.) returns a new terminal
      return (..._args: any[]) => terminalChain(resultFn);
    },
  };
  return new Proxy(() => {}, handler);
}

/* ------------------------------------------------------------------ */
/*  Mocks                                                             */
/* ------------------------------------------------------------------ */

vi.mock('../services', () => ({}));

vi.mock('../services/auditEvents', () => ({
  writeRouteAudit: vi.fn(),
}));

vi.mock('../db', () => ({
  db: {
    select: vi.fn((_cols?: any) => ({
      from: vi.fn((_table: any) => ({
        where: vi.fn((_cond: any) => terminalChain(() => [...store])),
        orderBy: vi.fn((..._args: any[]) => terminalChain(() => [...store])),
      })),
    })),

    insert: vi.fn((_table: any) => ({
      values: vi.fn((values: any) => ({
        returning: vi.fn(() => {
          const row = makeTemplate(values);
          store.push(row);
          return Promise.resolve([row]);
        }),
      })),
    })),

    update: vi.fn((_table: any) => ({
      set: vi.fn((setValues: any) => ({
        where: vi.fn((_cond: any) => ({
          returning: vi.fn(() => {
            // Find first row and apply updates
            if (store.length > 0) {
              const row = store[0] as Record<string, unknown>;
              Object.assign(row, setValues);
              return Promise.resolve([{ ...row }]);
            }
            return Promise.resolve([]);
          }),
        })),
      })),
    })),

    delete: vi.fn((_table: any) => ({
      where: vi.fn((_cond: any) => {
        store = [];
        return Promise.resolve();
      }),
    })),
  },
  runOutsideDbContext: vi.fn((fn: () => any) => fn()),
  withSystemDbAccessContext: vi.fn(async (fn: () => any) => fn()),
}));

vi.mock('../db/schema', () => ({
  alertTemplates: {
    id: 'id',
    orgId: 'org_id',
    name: 'name',
    description: 'description',
    isBuiltIn: 'is_built_in',
    severity: 'severity',
    conditions: 'conditions',
  },
  alertRules: {},
  alertCorrelations: {},
  alerts: {},
}));

vi.mock('../middleware/auth', () => ({
  authMiddleware: vi.fn((c: any, next: any) => {
    c.set('auth', {
      scope: 'organization',
      orgId: '11111111-1111-1111-1111-111111111111',
      partnerId: null,
      user: { id: 'user-123', email: 'test@example.com' },
    });
    return next();
  }),
  requireScope: vi.fn(() => (c: any, next: any) => next()),
}));

import { authMiddleware } from '../middleware/auth';
import { db } from '../db';
import { alertTemplateRoutes } from './alertTemplates';

/* ------------------------------------------------------------------ */
/*  Tests                                                             */
/* ------------------------------------------------------------------ */

const ORG_ID = '11111111-1111-1111-1111-111111111111';

describe('alert template routes', () => {
  let app: Hono;

  const createTemplate = async () => {
    const res = await app.request('/alert-templates/templates', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: 'Bearer token' },
      body: JSON.stringify({
        name: 'Custom Latency',
        description: 'Custom latency threshold',
        severity: 'medium',
        conditions: {
          metric: 'network.latencyMs',
          operator: '>',
          threshold: 300,
        },
      }),
    });
    const body = await res.json();
    return { res, body };
  };

  beforeEach(() => {
    vi.clearAllMocks();
    store = [];

    vi.mocked(authMiddleware).mockImplementation((c: any, next: any) => {
      c.set('auth', {
        scope: 'organization',
        orgId: ORG_ID,
        partnerId: null,
        user: { id: 'user-123', email: 'test@example.com' },
      });
      return next();
    });

    /* ---- wire up db.select to use live store ---- */
    vi.mocked(db.select).mockImplementation((_cols?: any) => ({
      from: vi.fn((_table: any) => {
        const chain = (rows: any[]) => terminalChain(() => rows);
        return {
          where: vi.fn((_cond: any) => chain([...store])),
          orderBy: vi.fn((..._args: any[]) => chain([...store])),
        };
      }),
    }) as any);

    vi.mocked(db.insert).mockImplementation((_table: any) => ({
      values: vi.fn((values: any) => ({
        returning: vi.fn(() => {
          const row = makeTemplate(values);
          store.push(row);
          return Promise.resolve([row]);
        }),
      })),
    }) as any);

    vi.mocked(db.update).mockImplementation((_table: any) => ({
      set: vi.fn((setValues: any) => ({
        where: vi.fn((_cond: any) => ({
          returning: vi.fn(() => {
            if (store.length > 0) {
              const row = store[0] as Record<string, unknown>;
              Object.assign(row, setValues);
              return Promise.resolve([{ ...row }]);
            }
            return Promise.resolve([]);
          }),
        })),
      })),
    }) as any);

    vi.mocked(db.delete).mockImplementation((_table: any) => ({
      where: vi.fn((_cond: any) => {
        store = [];
        return Promise.resolve();
      }),
    }) as any);

    app = new Hono();
    app.route('/alert-templates', alertTemplateRoutes);
  });

  describe('GET /alert-templates/templates', () => {
    it('should list templates with pagination', async () => {
      // Seed a template so the list is non-empty
      store.push(
        makeTemplate({
          orgId: ORG_ID,
          name: 'Seed Template',
          severity: 'low',
          isBuiltIn: false,
        })
      );

      const res = await app.request('/alert-templates/templates', {
        method: 'GET',
        headers: { Authorization: 'Bearer token' },
      });

      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.data.length).toBeGreaterThan(0);
      expect(body.total).toBeGreaterThan(0);
    });
  });

  describe('POST /alert-templates/templates', () => {
    it('should create a custom template', async () => {
      const { res, body } = await createTemplate();

      expect(res.status).toBe(201);
      expect(body.data.isBuiltIn).toBe(false);
      expect(body.data.name).toBe('Custom Latency');
      expect(body.data.cooldownMinutes).toBe(15);
    });
  });

  describe('GET /alert-templates/templates/:id', () => {
    it('should fetch a template by id', async () => {
      const { body: created } = await createTemplate();

      const res = await app.request(`/alert-templates/templates/${created.data.id}`, {
        method: 'GET',
        headers: { Authorization: 'Bearer token' },
      });

      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.data.id).toBe(created.data.id);
    });
  });

  describe('PATCH /alert-templates/templates/:id', () => {
    it('should update a custom template', async () => {
      const { body: created } = await createTemplate();

      const res = await app.request(`/alert-templates/templates/${created.data.id}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json', Authorization: 'Bearer token' },
        body: JSON.stringify({
          name: 'Custom Latency Updated',
          defaultCooldownMinutes: 25,
        }),
      });

      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.data.name).toBe('Custom Latency Updated');
      expect(body.data.cooldownMinutes).toBe(25);
    });

    it('should reject updates to built-in templates', async () => {
      // Seed a built-in template
      const builtIn = makeTemplate({
        orgId: null,
        name: 'Built-in CPU Alert',
        severity: 'high',
        isBuiltIn: true,
      });
      store.push(builtIn);

      const res = await app.request(`/alert-templates/templates/${builtIn.id}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json', Authorization: 'Bearer token' },
        body: JSON.stringify({ name: 'Nope' }),
      });

      expect(res.status).toBe(403);
    });
  });

  describe('DELETE /alert-templates/templates/:id', () => {
    it('should delete a custom template', async () => {
      const { body: created } = await createTemplate();

      const res = await app.request(`/alert-templates/templates/${created.data.id}`, {
        method: 'DELETE',
        headers: { Authorization: 'Bearer token' },
      });

      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.data.deleted).toBe(true);

      // After deletion the store is empty, so fetch should 404
      const fetchRes = await app.request(`/alert-templates/templates/${created.data.id}`, {
        method: 'GET',
        headers: { Authorization: 'Bearer token' },
      });
      expect(fetchRes.status).toBe(404);
    });
  });
});
