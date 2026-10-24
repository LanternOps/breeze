import { beforeEach, describe, expect, it, vi } from 'vitest';
import { Hono } from 'hono';
import { HTTPException } from 'hono/http-exception';
import { PARTNER_SETTINGS_CATALOG, CATALOG_TAB_KEYS } from '@breeze/shared';

const { dbMock, state } = vi.hoisted(() => {
  const state = {
    partnerRows: [] as unknown[],
    /** Rows for each db.execute call, by the kind of query (decided from its SQL). */
    respond: (_query: unknown): unknown[] => [],
  };
  const dbMock = {
    select: vi.fn(() => {
      const chain: any = {
        from: vi.fn(() => chain),
        where: vi.fn(() => chain),
        limit: vi.fn(() => Promise.resolve(state.partnerRows)),
      };
      return chain;
    }),
    execute: vi.fn((query: unknown) => Promise.resolve(state.respond(query))),
  };
  return { dbMock, state };
});

vi.mock('../db', () => ({
  db: dbMock,
  runOutsideDbContext: vi.fn((fn: () => unknown) => fn()),
  withSystemDbAccessContext: vi.fn(async (fn: () => unknown) => fn()),
  withDbAccessContext: vi.fn(async (_ctx: unknown, fn: () => unknown) => fn()),
}));

// The real requireScope / requirePartner semantics; requirePermission passes
// (ORGS_READ is granted to every partner role under test).
vi.mock('../middleware/auth', () => ({
  requireScope: (...scopes: string[]) => async (c: any, next: any) => {
    if (!scopes.includes(c.get('auth')?.scope)) throw new HTTPException(403, { message: 'Insufficient permissions' });
    await next();
  },
  requirePartner: async (c: any, next: any) => {
    if (!c.get('auth')?.partnerId) throw new HTTPException(403, { message: 'Partner context required' });
    await next();
  },
  requirePermission: () => async (_c: any, next: any) => next(),
}));

import { PgDialect } from 'drizzle-orm/pg-core';
import type { SQL } from 'drizzle-orm';
import { partnerSettingsInheritanceRoutes } from './partnerSettingsInheritance';
import { BINDINGS } from '../services/partnerSettingsInheritance/bindings';
import { isSecretJsonPath } from '../services/encryptedColumnTransform';
import { PARTNER_WIDE_READ_DENIED_MESSAGE } from '../services/partnerWideAccess';

const dialect = new PgDialect();
const ORG_1 = '00000000-0000-4000-8000-000000000001';
const ORG_2 = '00000000-0000-4000-8000-000000000002';
const CHANNEL_1 = '00000000-0000-4000-8000-000000000101';

type AuthShape = { scope: string; partnerId: string | null; orgId: string | null; partnerOrgAccess?: string; accessibleOrgIds: string[] | null };

const FULL: AuthShape = { scope: 'partner', partnerId: 'partner-1', orgId: null, partnerOrgAccess: 'all', accessibleOrgIds: [ORG_1, ORG_2] };
const SELECTED: AuthShape = { ...FULL, partnerOrgAccess: 'selected' };
const ORG_TOKEN: AuthShape = { scope: 'organization', partnerId: 'partner-1', orgId: ORG_1, accessibleOrgIds: [ORG_1] };
const SYSTEM: AuthShape = { scope: 'system', partnerId: null, orgId: null, accessibleOrgIds: null };

/** Mirrors orgs.ts: the sub-router mounted at '/' next to unrelated org routes. */
function buildApp(auth: AuthShape): Hono {
  const app = new Hono();
  app.use('*', async (c, next) => {
    c.set('auth' as never, auth as never);
    await next();
  });
  app.route('/', partnerSettingsInheritanceRoutes);
  app.get('/organizations', (c) => c.json({ data: [] }));
  app.get('/partners/me', (c) => c.json({ data: {} }));
  return app;
}

const get = (auth: AuthShape, path: string) => buildApp(auth).request(path);

// Canaries at every secret path and every secret entry's org source.
const partnerSettingsWithCanaries = {
  notifications: {
    pushoverAppToken: 'CANARY-PLAIN-partner.pushoverAppToken',
    pushoverDefaultUser: 'enc:v1:CANARY-CT-partner.pushoverDefaultUser',
    slackWebhookUrl: 'CANARY-PLAIN-partner.slackWebhookUrl',
    webhooks: ['enc:v1:CANARY-CT-partner.webhooks'],
  },
  eventLogs: { enabled: true, elasticsearchUrl: 'https://p.example', elasticsearchApiKey: 'CANARY-PLAIN-partner.eventLogs', elasticsearchPassword: 'enc:v1:CANARY-CT-partner.eventLogs' },
  remoteAccessProviders: { providers: [{ id: 'x', name: 'x', urlTemplate: 'x', customFieldKey: 'x', enabled: true, password: 'CANARY-PLAIN-partner.providers' }] },
};

function secretOrgValue(id: string): unknown {
  if (id === 'eventLogs') {
    return { enabled: true, elasticsearchUrl: `CANARY-PLAIN-${id}`, elasticsearchApiKey: `enc:v1:CANARY-CT-${id}`, elasticsearchPassword: `CANARY-PLAIN-${id}` };
  }
  return `CANARY-PLAIN-${id}`;
}

function rowsFor(query: unknown): unknown[] {
  const { sql: text } = dialect.sqlToQuery(query as SQL);
  // Tab aggregate: one row of positional counts.
  if (/count\(\*\) FILTER/.test(text)) return [Object.fromEntries(Array.from({ length: 60 }, (_, i) => [`c${i}`, 1]))];
  // Pushover channel listing for a drill-down page.
  if (/AS org_id, \(/.test(text)) {
    return [
      { id: CHANNEL_1, name: 'Primary', org_id: ORG_1, present: true, value: 'CANARY-PLAIN-channel' },
      { id: CHANNEL_1.replace('101', '102'), name: 'Secondary', org_id: ORG_1, present: true, value: 'enc:v1:CANARY-CT-channel' },
    ];
  }
  // Drill-down org rows: every secret entry's own value is a canary.
  return [
    { id: ORG_1, name: 'Alpha', sort_name: 'alpha', present: true, value: currentSecretValue },
    { id: ORG_2, name: 'Beta', sort_name: 'beta', present: true, value: currentSecretValue },
  ];
}

let currentSecretValue: unknown = null;

beforeEach(() => {
  vi.clearAllMocks();
  state.partnerRows = [{ settings: partnerSettingsWithCanaries, orgCount: 2 }];
  state.respond = rowsFor;
  currentSecretValue = null;
});

function keyPaths(value: unknown, prefix: string[] = []): string[][] {
  if (Array.isArray(value)) return value.flatMap((item) => keyPaths(item, prefix));
  if (value && typeof value === 'object') {
    return Object.entries(value).flatMap(([key, child]) => [[...prefix, key], ...keyPaths(child, [...prefix, key])]);
  }
  return [];
}

describe('GET /partners/me/settings-inheritance', () => {
  it('org token → 403', async () => {
    expect((await get(ORG_TOKEN, '/partners/me/settings-inheritance?tab=security')).status).toBe(403);
  });

  it('system scope → 403', async () => {
    expect((await get(SYSTEM, '/partners/me/settings-inheritance?tab=security')).status).toBe(403);
  });

  it('selected-access partner → 403 PARTNER_WIDE_REQUIRED', async () => {
    const res = await get(SELECTED, '/partners/me/settings-inheritance?tab=security');
    expect(res.status).toBe(403);
    expect(await res.json()).toEqual({ error: PARTNER_WIDE_READ_DENIED_MESSAGE, code: 'PARTNER_WIDE_REQUIRED' });
  });

  it('the gate runs before validation (no existence oracle for a selected-access user)', async () => {
    expect((await get(SELECTED, '/partners/me/settings-inheritance?tab=nope')).status).toBe(403);
  });

  it('full-access partner → 200 with InheritanceTabDto shape', async () => {
    const res = await get(FULL, '/partners/me/settings-inheritance?tab=security');
    expect(res.status).toBe(200);
    const body = (await res.json()) as { data: { tab: string; orgCount: number; fields: { id: string; kind: string; counts: unknown }[] } };
    expect(body.data.tab).toBe('security');
    expect(body.data.orgCount).toBe(2);
    expect(body.data.fields.map((f) => f.id)).toEqual(PARTNER_SETTINGS_CATALOG.filter((e) => e.tab === 'security').map((e) => e.id));
    expect(body.data.fields.find((f) => f.id === 'security.requireMfa')).toMatchObject({ kind: 'locks', partnerSet: false, inForce: false });
  });

  it('unknown tab → 400; missing tab → 400', async () => {
    expect((await get(FULL, '/partners/me/settings-inheritance?tab=nope')).status).toBe(400);
    expect((await get(FULL, '/partners/me/settings-inheritance')).status).toBe(400);
  });

  it('an unreadable partner row → 404', async () => {
    state.partnerRows = [];
    expect((await get(FULL, '/partners/me/settings-inheritance?tab=security')).status).toBe(404);
    expect((await get(FULL, '/partners/me/settings-inheritance/orgs?field=security.requireMfa')).status).toBe(404);
  });

  it('an unexpected database error is rethrown to the app error handler, never swallowed', async () => {
    state.respond = () => {
      throw new Error('boom');
    };
    const app = buildApp(FULL);
    const seen: unknown[] = [];
    app.onError((err, c) => {
      seen.push(err);
      return c.json({ error: 'Internal error' }, 500);
    });
    expect((await app.request('/partners/me/settings-inheritance?tab=security')).status).toBe(500);
    expect((seen[0] as Error).message).toBe('boom');
  });

  it('a null accessibleOrgIds under partner scope is a 500, never "all orgs"', async () => {
    const app = buildApp({ ...FULL, accessibleOrgIds: null });
    app.onError((_err, c) => c.json({ error: 'Internal error' }, 500));
    expect((await app.request('/partners/me/settings-inheritance?tab=security')).status).toBe(500);
    expect(dbMock.execute).not.toHaveBeenCalled();
  });
});

describe('GET /partners/me/settings-inheritance/orgs', () => {
  const path = (query: string) => `/partners/me/settings-inheritance/orgs?${query}`;

  it('org token / system / selected-access → 403', async () => {
    expect((await get(ORG_TOKEN, path('field=security.requireMfa'))).status).toBe(403);
    expect((await get(SYSTEM, path('field=security.requireMfa'))).status).toBe(403);
    const selected = await get(SELECTED, path('field=security.requireMfa'));
    expect(selected.status).toBe(403);
    expect(((await selected.json()) as { code: string }).code).toBe('PARTNER_WIDE_REQUIRED');
  });

  it('full-access → 200 with InheritanceOrgPageDto shape', async () => {
    currentSecretValue = true;
    const res = await get(FULL, path('field=security.requireMfa'));
    expect(res.status).toBe(200);
    const body = (await res.json()) as { data: { field: string; rows: unknown[]; nextCursor: string | null } };
    expect(body.data.field).toBe('security.requireMfa');
    expect(body.data.rows).toHaveLength(2);
    expect(body.data.nextCursor).toBeNull();
  });

  it('unknown field → 400', async () => {
    expect((await get(FULL, path('field=nope.nothing'))).status).toBe(400);
    expect((await get(FULL, path('field=__proto__'))).status).toBe(400);
  });

  it('limit 51 → 400; limit 0 → 400', async () => {
    expect((await get(FULL, path('field=security.requireMfa&limit=51'))).status).toBe(400);
    expect((await get(FULL, path('field=security.requireMfa&limit=0'))).status).toBe(400);
  });

  it('malformed cursor → 400', async () => {
    expect((await get(FULL, path('field=security.requireMfa&cursor=not!base64'))).status).toBe(400);
    const notATuple = Buffer.from('{"a":1}').toString('base64url');
    expect((await get(FULL, path(`field=security.requireMfa&cursor=${notATuple}`))).status).toBe(400);
  });

  it('a bucket that does not apply → 400', async () => {
    expect((await get(FULL, path('field=notifications.pushoverAppToken&bucket=overrides'))).status).toBe(400);
    expect((await get(FULL, path('field=security.requireMfa&bucket=clamped'))).status).toBe(400);
    expect((await get(FULL, path('field=security.requireMfa&bucket=nope'))).status).toBe(400);
  });

  it('a field without an org value → 400', async () => {
    expect((await get(FULL, path('field=networkProxy.dedicatedTunnelOrigin'))).status).toBe(400);
  });
});

describe('no secret value in any response', () => {
  const secretWithSource = PARTNER_SETTINGS_CATALOG.filter((e) => e.secret && BINDINGS[e.id]!.orgSource !== null);

  it('covers at least the event-log and pushover credential entries', () => {
    expect(secretWithSource.map((e) => e.id).sort()).toEqual(['eventLogs', 'notifications.pushoverAppToken', 'notifications.pushoverDefaultUser']);
  });

  it('neither canary appears in either route, for every tab and every bucket', async () => {
    const bodies: string[] = [];
    for (const tab of CATALOG_TAB_KEYS) {
      const res = await get(FULL, `/partners/me/settings-inheritance?tab=${tab}`);
      expect(res.status, tab).toBe(200);
      bodies.push(await res.text());
    }
    for (const entry of secretWithSource) {
      currentSecretValue = secretOrgValue(entry.id);
      for (const bucket of ['ownValue', 'shadowed', 'overrides', 'clamped']) {
        const res = await get(FULL, `/partners/me/settings-inheritance/orgs?field=${entry.id}&bucket=${bucket}`);
        // overrides is never computable for a secret field; a bucket that does not apply is a 400.
        const applies = BINDINGS[entry.id]!.bucketSql(bucket as never, partnerSettingsWithCanaries) !== null;
        expect(applies && bucket === 'overrides', entry.id).toBe(false);
        expect(res.status, `${entry.id}/${bucket}`).toBe(applies ? 200 : 400);
        bodies.push(await res.text());
      }
    }
    const all = bodies.join('\n');
    expect(all).not.toContain('CANARY-PLAIN-');
    expect(all).not.toContain('CANARY-CT-');
    // Backstop: no serialized key path is a secret path.
    for (const body of bodies) {
      for (const path of keyPaths(JSON.parse(body))) expect(isSecretJsonPath(path), path.join('.')).toBe(false);
    }
  });

  it('a secret drill-down row reports presence only', async () => {
    currentSecretValue = secretOrgValue('eventLogs');
    const res = await get(FULL, '/partners/me/settings-inheritance/orgs?field=eventLogs');
    const body = (await res.json()) as { data: { rows: { ownValue: unknown }[] } };
    for (const row of body.data.rows) expect(row.ownValue).toEqual({ set: true });
  });
});

describe('mounting', () => {
  it('unrelated org routes are not gated', async () => {
    expect((await get(SELECTED, '/organizations')).status).toBe(200);
    expect((await get(SELECTED, '/partners/me')).status).toBe(200);
    expect((await get(ORG_TOKEN, '/organizations')).status).toBe(200);
    expect((await get(SYSTEM, '/organizations')).status).toBe(200);
  });
});
