import { beforeEach, describe, expect, it, vi } from 'vitest';
import { Hono } from 'hono';

const ORG_ID = '11111111-1111-4111-8111-111111111111';
const REPORT_ID = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const CONTACT_ID = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';

const state = vi.hoisted(() => ({
  results: [] as unknown[][],
  inserted: [] as Array<{ table: unknown; value: unknown }>,
  deleted: [] as unknown[],
  updated: [] as Array<{ value: unknown; condition?: unknown }>,
  whereConditions: [] as unknown[],
  getReport: vi.fn(),
}));

function selectChain(result: unknown[]) {
  const chain: Record<string, any> = {};
  for (const method of ['from', 'innerJoin', 'orderBy']) {
    chain[method] = vi.fn(() => chain);
  }
  chain.where = vi.fn((condition) => {
    state.whereConditions.push(condition);
    return chain;
  });
  chain.limit = vi.fn(() => Promise.resolve(result));
  chain.then = (resolve: (value: unknown) => unknown) =>
    Promise.resolve(result).then(resolve);
  return chain;
}

function database() {
  return {
    select: vi.fn(() => selectChain(state.results.shift() ?? [])),
    insert: vi.fn((table) => ({
      values: vi.fn((value) => {
        state.inserted.push({ table, value });
        return {
          onConflictDoNothing: vi.fn(() => ({
            returning: vi.fn(() => Promise.resolve([{ id: 'recipient-1' }])),
            then: (resolve: (value: unknown) => unknown) =>
              Promise.resolve(undefined).then(resolve),
          })),
          returning: vi.fn(() => Promise.resolve([{
            id: CONTACT_ID,
            name: 'Alex',
            email: 'alex@example.test',
          }])),
        };
      }),
    })),
    delete: vi.fn(() => ({
      where: vi.fn((condition) => {
        state.deleted.push(condition);
        return { returning: vi.fn(() => Promise.resolve([{ id: 'recipient-1' }])) };
      }),
    })),
    update: vi.fn(() => ({
      set: vi.fn((value) => {
        const entry = { value } as { value: unknown; condition?: unknown };
        state.updated.push(entry);
        return {
          where: vi.fn((condition) => {
            entry.condition = condition;
            return Promise.resolve();
          }),
        };
      }),
    })),
  };
}

const rootDb = vi.hoisted(() => ({ current: undefined as any }));

vi.mock('../../db', () => ({
  db: new Proxy({}, {
    get: (_target, property) => rootDb.current[property],
  }),
}));

vi.mock('../../db/schema', () => ({
  contacts: {
    id: 'contacts.id',
    orgId: 'contacts.orgId',
    name: 'contacts.name',
    email: 'contacts.email',
  },
  reportScheduleRecipients: {
    id: 'recipients.id',
    reportId: 'recipients.reportId',
    orgId: 'recipients.orgId',
    contactId: 'recipients.contactId',
  },
  reports: {
    id: 'reports.id',
    orgId: 'reports.orgId',
  },
}));

vi.mock('drizzle-orm', () => ({
  and: (...conditions: unknown[]) => ({ type: 'and', conditions }),
  asc: (column: unknown) => ({ type: 'asc', column }),
  eq: (column: unknown, value: unknown) => ({ type: 'eq', column, value }),
  sql: (strings: TemplateStringsArray, ...values: unknown[]) => ({
    type: 'sql',
    strings: [...strings],
    values,
  }),
}));

vi.mock('../../middleware/auth', () => ({
  authMiddleware: async (c: any, next: () => Promise<void>) => {
    if (!c.get('auth')) {
      c.set('auth', {
        scope: 'organization',
        orgId: ORG_ID,
        user: { id: 'user-1' },
      });
    }
    await next();
  },
  requirePermission: () => async (_c: unknown, next: () => Promise<void>) => next(),
  requireScope: () => async (_c: unknown, next: () => Promise<void>) => next(),
}));

vi.mock('../../services/permissions', () => ({
  PERMISSIONS: {
    REPORTS_READ: { resource: 'reports', action: 'read' },
    REPORTS_WRITE: { resource: 'reports', action: 'write' },
  },
}));

vi.mock('./helpers', () => ({
  getReportWithOrgCheck: state.getReport,
}));

import { recipientsRoutes } from './recipients';

function app() {
  const hono = new Hono();
  hono.route('/', recipientsRoutes);
  return hono;
}

function hasEquality(condition: unknown, column: string, value: unknown): boolean {
  if (!condition || typeof condition !== 'object') return false;
  const node = condition as { type?: string; column?: unknown; value?: unknown; conditions?: unknown[] };
  if (node.type === 'eq' && node.column === column && node.value === value) return true;
  return node.conditions?.some((child) => hasEquality(child, column, value)) ?? false;
}

describe('report recipient routes', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    state.results.length = 0;
    state.inserted.length = 0;
    state.deleted.length = 0;
    state.updated.length = 0;
    state.whereConditions.length = 0;
    const tx = database();
    rootDb.current = {
      ...database(),
      transaction: vi.fn(async (callback: (tx: ReturnType<typeof database>) => unknown) => callback(tx)),
    };
    state.getReport.mockResolvedValue({
      id: REPORT_ID,
      orgId: ORG_ID,
      config: { emailRecipients: ['alex@example.test', 'keep@example.test'] },
    });
  });

  it('lists contact-bound recipients with an explicit recipient org predicate', async () => {
    state.results.push([{
      id: 'recipient-1',
      contactId: CONTACT_ID,
      name: 'Alex',
      email: 'alex@example.test',
    }]);

    const response = await app().request(`/${REPORT_ID}/recipients`);

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({
      data: [{
        id: 'recipient-1',
        contactId: CONTACT_ID,
        name: 'Alex',
        email: 'alex@example.test',
      }],
    });
    expect(state.whereConditions.some((condition) =>
      hasEquality(condition, 'recipients.orgId', ORG_ID))).toBe(true);
  });

  it('rejects a contact from another organization', async () => {
    state.results.push([]);

    const response = await app().request(`/${REPORT_ID}/recipients`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ contactId: CONTACT_ID }),
    });

    expect(response.status).toBe(404);
    expect(state.inserted).toHaveLength(0);
    expect(state.whereConditions.some((condition) =>
      hasEquality(condition, 'contacts.orgId', ORG_ID))).toBe(true);
  });

  it('adds an org-owned contact as a recipient', async () => {
    state.results.push([{ id: CONTACT_ID }]);

    const response = await app().request(`/${REPORT_ID}/recipients`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ contactId: CONTACT_ID }),
    });

    expect(response.status).toBe(201);
    expect(await response.json()).toEqual({ data: { id: 'recipient-1' } });
    expect(state.inserted[0]?.value).toEqual({
      reportId: REPORT_ID,
      orgId: ORG_ID,
      contactId: CONTACT_ID,
    });
  });

  it('deletes only the report recipient in the resolved organization', async () => {
    const response = await app().request(`/${REPORT_ID}/recipients/${CONTACT_ID}`, {
      method: 'DELETE',
    });

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ data: { deleted: true } });
    expect(hasEquality(state.deleted[0], 'recipients.orgId', ORG_ID)).toBe(true);
  });

  it('converts a legacy email into an org contact and removes only that legacy address', async () => {
    state.results.push([]);

    const response = await app().request(`/${REPORT_ID}/recipients/convert`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ email: 'Alex@Example.Test', name: 'Alex' }),
    });

    expect(response.status).toBe(201);
    expect(await response.json()).toEqual({
      data: { id: CONTACT_ID, name: 'Alex', email: 'alex@example.test' },
    });
    expect(state.inserted[0]?.value).toMatchObject({
      orgId: ORG_ID,
      email: 'alex@example.test',
      createdBy: 'user-1',
    });
    expect(state.inserted[1]?.value).toEqual({
      reportId: REPORT_ID,
      orgId: ORG_ID,
      contactId: CONTACT_ID,
    });
    expect(state.updated[0]?.value).toMatchObject({
      config: { emailRecipients: ['keep@example.test'] },
    });
    expect(hasEquality(state.updated[0]?.condition, 'reports.orgId', ORG_ID)).toBe(true);
  });

  it('validates recipient and conversion request bodies', async () => {
    const invalidContact = await app().request(`/${REPORT_ID}/recipients`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ contactId: 'not-a-guid' }),
    });
    const invalidEmail = await app().request(`/${REPORT_ID}/recipients/convert`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ email: 'not-an-email' }),
    });

    expect(invalidContact.status).toBe(400);
    expect(invalidEmail.status).toBe(400);
    expect(state.getReport).not.toHaveBeenCalled();
  });
});
