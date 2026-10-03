/**
 * Integration — partner-scoped audit events in the Audit Trail (#7696).
 *
 * Partner-scoped changes (partner-library config policies, monitor definitions,
 * update rings, notification channels/routing rules) are audited with
 * `org_id = NULL`. Before #7696 they were stored but unreadable by anyone but
 * system scope: every Audit Trail query filtered on accessible org ids, the only
 * SELECT policy was `breeze_has_org_access(org_id)`, and the rows carried no
 * partner identity at all.
 *
 * Proven here against real Postgres as `breeze_app` with real JWTs:
 *   - the DB layer: partner A sees its own partner-scoped rows and nothing of
 *     partner B's; an org-scope session in partner A sees none of them; nobody
 *     but system sees a platform-wide (org NULL, partner NULL) row; the
 *     org/partner CHECK rejects a row stamped with both.
 *   - every Audit Trail read route (list standard + fast path, detail, search,
 *     stats/reports, export) and the `query_audit_log` AI tool honour the same
 *     visibility, with a cross-partner and an org-token negative.
 *   - the writer stamps partner_id from a partner-scope request and never on an
 *     org row.
 */
import './setup';
import { randomUUID } from 'node:crypto';
import { Hono } from 'hono';
import { describe, it, expect } from 'vitest';
import { and, eq, inArray, sql } from 'drizzle-orm';
import { db, withDbAccessContext, withSystemDbAccessContext } from '../../db';
import { auditLogs } from '../../db/schema';
import { auditLogRoutes } from '../../routes/auditLogs';
import { createAccessToken } from '../../services/jwt';
import { registerAuditTools } from '../../services/aiToolsAudit';
import { createAuditLog } from '../../services/auditService';
import { requestLikeFromSnapshot, writeAuditEvent, writeRouteAudit } from '../../services/auditEvents';
import { cascadeDeletePartner } from '../../services/tenantCascade';
import type { AiTool } from '../../services/aiTools';
import { buildOrgAccessClosures, type AuthContext } from '../../middleware/auth';
import { auditLogReadCondition } from '../../services/auditReadScope';
import {
  assignUserToOrganization,
  assignUserToPartner,
  createOrganization,
  createPartner,
  createRole,
  createUser,
  grantRolePermissions,
} from './db-utils';
import { getTestDb } from './setup';

const app = new Hono().route('/audit-logs', auditLogRoutes);

type Scope = 'partner' | 'organization';

async function mintClient(scope: Scope, partnerId: string, orgId: string) {
  const user = await createUser({
    partnerId,
    orgId: scope === 'organization' ? orgId : null,
    email: `audit-7696-${randomUUID()}@example.com`,
  });
  const role = await createRole({
    scope,
    partnerId: scope === 'partner' ? partnerId : undefined,
    orgId: scope === 'organization' ? orgId : undefined,
  });
  await grantRolePermissions(role.id, [{ resource: '*', action: '*' }]);
  if (scope === 'partner') await assignUserToPartner(user.id, partnerId, role.id, 'all');
  else await assignUserToOrganization(user.id, orgId, role.id);
  const token = await createAccessToken({
    sub: user.id,
    email: user.email,
    roleId: role.id,
    orgId: scope === 'organization' ? orgId : null,
    partnerId,
    scope,
    mfa: true,
    aep: 1,
    mep: 1,
    sid: randomUUID(),
  });
  const call = (method: string, path: string, body?: unknown) =>
    app.request(path, {
      method,
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
  return {
    user,
    get: (path: string) => call('GET', path),
    post: (path: string, body?: unknown) => call('POST', path, body),
  };
}

async function seedRow(values: { orgId: string | null; partnerId: string | null; action: string; resourceName?: string }) {
  const [row] = await getTestDb()
    .insert(auditLogs)
    .values({
      orgId: values.orgId,
      partnerId: values.partnerId,
      actorType: 'user',
      actorId: randomUUID(),
      actorEmail: 'tech@example.com',
      action: values.action,
      resourceType: 'configuration_policy',
      resourceName: values.resourceName ?? values.action,
      result: 'success',
    })
    .returning({ id: auditLogs.id });
  return row!.id;
}

/**
 * Two partners. Partner A owns org A1. Each partner has one partner-scoped
 * audit row; there is one platform-wide row and one org-A1 row. Every row's
 * action carries a per-test marker so the append-only table's history from
 * other suites cannot bleed into the assertions.
 */
async function fixture() {
  const partnerA = await createPartner();
  const partnerB = await createPartner();
  const orgA1 = await createOrganization({ partnerId: partnerA.id });
  const orgB1 = await createOrganization({ partnerId: partnerB.id });
  const marker = `p7696.${randomUUID().slice(0, 8)}`;
  const ids = {
    partnerA: await seedRow({ orgId: null, partnerId: partnerA.id, action: `${marker}.partner_a` }),
    partnerB: await seedRow({ orgId: null, partnerId: partnerB.id, action: `${marker}.partner_b` }),
    platform: await seedRow({ orgId: null, partnerId: null, action: `${marker}.platform` }),
    orgA1: await seedRow({ orgId: orgA1.id, partnerId: null, action: `${marker}.org_a1` }),
    orgB1: await seedRow({ orgId: orgB1.id, partnerId: null, action: `${marker}.org_b1` }),
  };
  return { partnerA, partnerB, orgA1, orgB1, marker, ids };
}

type Fixture = Awaited<ReturnType<typeof fixture>>;

/** from/to bracketing "now" generously (host vs DB clock skew). */
function windowQuery(): string {
  const now = Date.now();
  const from = new Date(now - 10 * 60_000).toISOString();
  const to = new Date(now + 10 * 60_000).toISOString();
  return `from=${encodeURIComponent(from)}&to=${encodeURIComponent(to)}`;
}

/** First column of a CSV export requested with columns=id,... */
function csvIds(body: string): string[] {
  return body.split('\n').slice(1).map((line) => line.split(',')[0]!.replace(/"/g, '')).filter(Boolean);
}

function idsOf(rows: Array<{ id: string }>): string[] {
  return rows.map((r) => r.id);
}

function expectVisibility(seen: string[], f: Fixture, visible: Array<keyof Fixture['ids']>, label: string) {
  for (const key of Object.keys(f.ids) as Array<keyof Fixture['ids']>) {
    if (visible.includes(key)) expect(seen, `${label}: expected ${key} visible`).toContain(f.ids[key]);
    else expect(seen, `${label}: expected ${key} hidden`).not.toContain(f.ids[key]);
  }
}

async function rlsVisible(f: Fixture, context: Parameters<typeof withDbAccessContext>[0]): Promise<string[]> {
  const rows = await withDbAccessContext(context, () =>
    db
      .select({ id: auditLogs.id })
      .from(auditLogs)
      .where(inArray(auditLogs.id, Object.values(f.ids))),
  );
  return idsOf(rows);
}

describe('audit_logs partner-scoped rows — RLS (#7696)', () => {
  it('runs as the unprivileged breeze_app role', async () => {
    const rows = await withSystemDbAccessContext(() =>
      db.execute(sql`select current_user as name, rolbypassrls from pg_roles where rolname = current_user`),
    );
    expect(rows[0]).toMatchObject({ name: 'breeze_app', rolbypassrls: false });
  });

  it('partner A sees its own partner-scoped rows and its orgs, never partner B or platform rows', async () => {
    const f = await fixture();
    const seen = await rlsVisible(f, {
      scope: 'partner',
      orgId: null,
      accessibleOrgIds: [f.orgA1.id],
      accessiblePartnerIds: [f.partnerA.id],
      currentPartnerId: f.partnerA.id,
    });
    expectVisibility(seen, f, ['partnerA', 'orgA1'], 'partner A RLS');
  });

  it('partner B cannot see partner A partner-scoped rows (cross-partner negative)', async () => {
    const f = await fixture();
    const seen = await rlsVisible(f, {
      scope: 'partner',
      orgId: null,
      accessibleOrgIds: [f.orgB1.id],
      accessiblePartnerIds: [f.partnerB.id],
      currentPartnerId: f.partnerB.id,
    });
    expectVisibility(seen, f, ['partnerB', 'orgB1'], 'partner B RLS');
  });

  it('an org-scope session in partner A cannot see partner A partner-scoped rows (org-token negative)', async () => {
    const f = await fixture();
    // currentPartnerId IS populated for org tokens (buildDbAccessContext) — the
    // policy must not key on it.
    const seen = await rlsVisible(f, {
      scope: 'organization',
      orgId: f.orgA1.id,
      accessibleOrgIds: [f.orgA1.id],
      accessiblePartnerIds: [],
      currentPartnerId: f.partnerA.id,
    });
    expectVisibility(seen, f, ['orgA1'], 'org A1 RLS');
  });

  it('system scope still sees every row', async () => {
    const f = await fixture();
    const rows = await withSystemDbAccessContext(() =>
      db.select({ id: auditLogs.id }).from(auditLogs).where(inArray(auditLogs.id, Object.values(f.ids))),
    );
    expectVisibility(idsOf(rows), f, ['partnerA', 'partnerB', 'platform', 'orgA1', 'orgB1'], 'system');
  });

  it('rejects a row stamped with both org_id and partner_id (23514)', async () => {
    const f = await fixture();
    let code: string | undefined;
    try {
      await seedRow({ orgId: f.orgA1.id, partnerId: f.partnerA.id, action: `${f.marker}.both` });
    } catch (err) {
      const e = err as { code?: string; cause?: { code?: string } };
      code = e.code ?? e.cause?.code;
    }
    expect(code).toBe('23514');
  });

  it('carries the partial index and a validated CHECK', async () => {
    const idx = await getTestDb().execute(sql`
      SELECT i.indisvalid FROM pg_index i JOIN pg_class c ON c.oid = i.indexrelid
      WHERE c.relname = 'audit_logs_partner_scope_idx'`);
    expect(idx).toEqual([{ indisvalid: true }]);
    const chk = await getTestDb().execute(sql`
      SELECT convalidated FROM pg_constraint
      WHERE conname = 'audit_logs_partner_only_without_org_chk' AND conrelid = 'public.audit_logs'::regclass`);
    expect(chk).toEqual([{ convalidated: true }]);
  });
});

describe('Audit Trail routes — partner-scoped rows (#7696)', () => {
  it('partner A sees its partner-scoped row on every read route; org and platform rows obey their own axis', async () => {
    const f = await fixture();
    const partnerA = await mintClient('partner', f.partnerA.id, f.orgA1.id);

    // GET / — standard path (action filter → not the fast path)
    const list = await partnerA.get(`/audit-logs?limit=100&action=${encodeURIComponent(f.marker)}`);
    expect(list.status).toBe(200);
    const listBody = await list.json();
    expectVisibility(idsOf(listBody.entries), f, ['partnerA', 'orgA1'], 'GET /');
    expect(listBody.pagination.total).toBe(2);

    // GET /logs — LATERAL fast path (skipCount, page 1, no filters)
    const fast = await partnerA.get('/audit-logs/logs?limit=100&skipCount=true');
    expect(fast.status).toBe(200);
    expectVisibility(idsOf((await fast.json()).data), f, ['partnerA', 'orgA1'], 'GET /logs fast path');

    // GET /logs/:id
    expect((await partnerA.get(`/audit-logs/logs/${f.ids.partnerA}`)).status).toBe(200);
    expect((await partnerA.get(`/audit-logs/logs/${f.ids.partnerB}`)).status).toBe(404);
    expect((await partnerA.get(`/audit-logs/logs/${f.ids.platform}`)).status).toBe(404);

    // GET /search
    const search = await partnerA.get(`/audit-logs/search?q=${encodeURIComponent(f.marker)}&limit=100`);
    expect(search.status).toBe(200);
    expectVisibility(idsOf((await search.json()).data), f, ['partnerA', 'orgA1'], 'GET /search');

    // Stats / reports: fresh partner, so a window around the fixture holds
    // exactly its two visible rows. Run before any export (an export writes its
    // own partner-attributed audit row).
    const win = windowQuery();
    const stats = await (await partnerA.get(`/audit-logs/stats?${win}`)).json();
    expect(stats.totalEvents).toBe(2);
    const activity = await (await partnerA.get(`/audit-logs/reports/user-activity?${win}`)).json();
    expect(activity.totalEvents).toBe(2);
    expectVisibility(idsOf(activity.recentActivity), f, ['partnerA', 'orgA1'], 'GET /reports/user-activity');

    // GET /export (CSV)
    const csv = await partnerA.get('/audit-logs/export?columns=id,action');
    expect(csv.status).toBe(200);
    expectVisibility(csvIds(await csv.text()), f, ['partnerA', 'orgA1'], 'GET /export');

    // POST /export (json) with the marker filter
    const exp = await partnerA.post('/audit-logs/export', {
      format: 'json',
      filters: { action: f.marker },
    });
    expect(exp.status).toBe(200);
    expectVisibility(idsOf((await exp.json()).data), f, ['partnerA', 'orgA1'], 'POST /export');
  });

  it('a pinned ?orgId= narrows to that org only (partner rows are not org rows)', async () => {
    const f = await fixture();
    const partnerA = await mintClient('partner', f.partnerA.id, f.orgA1.id);
    const res = await partnerA.get(`/audit-logs?limit=100&orgId=${f.orgA1.id}&action=${encodeURIComponent(f.marker)}`);
    expect(res.status).toBe(200);
    expectVisibility(idsOf((await res.json()).entries), f, ['orgA1'], 'GET /?orgId=A1');
  });

  it('partner B never sees partner A partner-scoped rows (cross-partner negative)', async () => {
    const f = await fixture();
    const partnerB = await mintClient('partner', f.partnerB.id, f.orgB1.id);
    const list = await partnerB.get(`/audit-logs?limit=100&action=${encodeURIComponent(f.marker)}`);
    expectVisibility(idsOf((await list.json()).entries), f, ['partnerB', 'orgB1'], 'partner B GET /');
    const fast = await partnerB.get('/audit-logs/logs?limit=100&skipCount=true');
    expectVisibility(idsOf((await fast.json()).data), f, ['partnerB', 'orgB1'], 'partner B fast path');
    expect((await partnerB.get(`/audit-logs/logs/${f.ids.partnerA}`)).status).toBe(404);
    const exp = await partnerB.post('/audit-logs/export', { format: 'json', filters: { action: f.marker } });
    expectVisibility(idsOf((await exp.json()).data), f, ['partnerB', 'orgB1'], 'partner B export');
    const csv = await partnerB.get('/audit-logs/export?columns=id,action');
    expectVisibility(csvIds(await csv.text()), f, ['partnerB', 'orgB1'], 'partner B GET /export');
  });

  it('an org user in partner A never sees partner A partner-scoped rows (org-token negative)', async () => {
    const f = await fixture();
    const orgUser = await mintClient('organization', f.partnerA.id, f.orgA1.id);
    const list = await orgUser.get(`/audit-logs?limit=100&action=${encodeURIComponent(f.marker)}`);
    expect(list.status).toBe(200);
    expectVisibility(idsOf((await list.json()).entries), f, ['orgA1'], 'org GET /');
    const fast = await orgUser.get('/audit-logs/logs?limit=100&skipCount=true');
    expectVisibility(idsOf((await fast.json()).data), f, ['orgA1'], 'org fast path');
    expect((await orgUser.get(`/audit-logs/logs/${f.ids.partnerA}`)).status).toBe(404);
    const search = await orgUser.get(`/audit-logs/search?q=${encodeURIComponent(f.marker)}&limit=100`);
    expectVisibility(idsOf((await search.json()).data), f, ['orgA1'], 'org search');
    const stats = await (await orgUser.get(`/audit-logs/stats?${windowQuery()}`)).json();
    expect(stats.totalEvents).toBe(1);
    const exp = await orgUser.post('/audit-logs/export', { format: 'json', filters: { action: f.marker } });
    expectVisibility(idsOf((await exp.json()).data), f, ['orgA1'], 'org export');
    const csv = await orgUser.get('/audit-logs/export?columns=id,action');
    expectVisibility(csvIds(await csv.text()), f, ['orgA1'], 'org GET /export');
  });

  it('fast path: excludeActions applies to the partner branch, and the merged branches interleave by time', async () => {
    const f = await fixture();
    const partnerA = await mintClient('partner', f.partnerA.id, f.orgA1.id);
    const excluded = await partnerA.get(
      `/audit-logs/logs?limit=100&skipCount=true&excludeActions=${encodeURIComponent(`${f.marker}.partner_a`)}`,
    );
    expectVisibility(idsOf((await excluded.json()).data), f, ['orgA1'], 'fast path excludeActions');

    // Newest row is a partner row: limit=1 must return it, not the org row.
    const newest = await seedRow({ orgId: null, partnerId: f.partnerA.id, action: `${f.marker}.partner_newest` });
    const top = await (await partnerA.get('/audit-logs/logs?limit=1&skipCount=true')).json();
    expect(idsOf(top.data)).toEqual([newest]);
  });

  it('a partner with zero accessible orgs still sees its partner-scoped rows', async () => {
    const partner = await createPartner();
    const marker = `p7696.${randomUUID().slice(0, 8)}`;
    const own = await seedRow({ orgId: null, partnerId: partner.id, action: `${marker}.own` });
    const client = await mintClient('partner', partner.id, randomUUID());
    const list = await (await client.get(`/audit-logs?limit=100&action=${encodeURIComponent(marker)}`)).json();
    expect(idsOf(list.entries)).toEqual([own]);
    const fast = await (await client.get('/audit-logs/logs?limit=100&skipCount=true')).json();
    expect(idsOf(fast.data)).toContain(own);
  });
});

describe('auditLogReadCondition — app-layer predicate without RLS (#7696)', () => {
  // RLS hides cross-tenant rows on every route above, so those negatives cannot
  // tell a correct app predicate from a too-wide one. Evaluate the predicate
  // under system scope (RLS out of the picture) to prove it independently.
  function predicateAuth(scope: 'partner' | 'organization', partnerId: string, orgIds: string[]) {
    return { scope, partnerId, ...buildOrgAccessClosures(orgIds) };
  }

  async function matching(f: Fixture, auth: ReturnType<typeof predicateAuth>) {
    const rows = await withSystemDbAccessContext(() =>
      db
        .select({ id: auditLogs.id })
        .from(auditLogs)
        .where(and(inArray(auditLogs.id, Object.values(f.ids)), auditLogReadCondition(auth))),
    );
    return idsOf(rows);
  }

  it('partner A: own partner rows + own orgs; partner B and org-scope tokens never match partner A rows', async () => {
    const f = await fixture();
    expectVisibility(await matching(f, predicateAuth('partner', f.partnerA.id, [f.orgA1.id])), f, ['partnerA', 'orgA1'], 'predicate partner A');
    expectVisibility(await matching(f, predicateAuth('partner', f.partnerB.id, [f.orgB1.id])), f, ['partnerB', 'orgB1'], 'predicate partner B');
    expectVisibility(await matching(f, predicateAuth('organization', f.partnerA.id, [f.orgA1.id])), f, ['orgA1'], 'predicate org A1');
  });
});

describe('query_audit_log AI tool — partner-scoped rows (#7696)', () => {
  function handler(): AiTool['handler'] {
    const reg = new Map<string, AiTool>();
    registerAuditTools(reg);
    return reg.get('query_audit_log')!.handler;
  }

  function makeAuth(scope: Scope, partnerId: string, orgId: string): AuthContext {
    const accessibleOrgIds = [orgId];
    return {
      user: { id: randomUUID(), email: 'op@example.com', name: 'Op', isPlatformAdmin: false },
      token: {} as never,
      partnerId,
      orgId: scope === 'organization' ? orgId : null,
      scope,
      accessibleOrgIds,
      orgCondition: (col: never) => inArray(col, accessibleOrgIds),
      canAccessOrg: (id: string) => accessibleOrgIds.includes(id),
      canAccessSite: () => true,
    } as unknown as AuthContext;
  }

  /** Ids the tool returns, querying each seeded row's exact action (the tool's filter is `eq`). */
  async function seenByTool(f: Fixture, auth: AuthContext, ctx: Parameters<typeof withDbAccessContext>[0]): Promise<string[]> {
    const seen: string[] = [];
    for (const key of Object.keys(f.ids) as Array<keyof Fixture['ids']>) {
      const action = `${f.marker}.${key === 'partnerA' ? 'partner_a' : key === 'partnerB' ? 'partner_b' : key === 'orgA1' ? 'org_a1' : key === 'orgB1' ? 'org_b1' : 'platform'}`;
      const out = await withDbAccessContext(ctx, () => handler()({ action, limit: 100 }, auth));
      const text = typeof out === 'string' ? out : JSON.stringify(out);
      if (text.includes(f.ids[key])) seen.push(f.ids[key]);
    }
    return seen;
  }

  it('partner A gets its partner-scoped row; partner B and an org user in A do not', async () => {
    const f = await fixture();
    const seenA = await seenByTool(f, makeAuth('partner', f.partnerA.id, f.orgA1.id), {
      scope: 'partner', orgId: null, accessibleOrgIds: [f.orgA1.id], accessiblePartnerIds: [f.partnerA.id], currentPartnerId: f.partnerA.id,
    });
    expectVisibility(seenA, f, ['partnerA', 'orgA1'], 'AI tool partner A');

    const seenB = await seenByTool(f, makeAuth('partner', f.partnerB.id, f.orgB1.id), {
      scope: 'partner', orgId: null, accessibleOrgIds: [f.orgB1.id], accessiblePartnerIds: [f.partnerB.id], currentPartnerId: f.partnerB.id,
    });
    expectVisibility(seenB, f, ['partnerB', 'orgB1'], 'AI tool partner B');

    const seenOrg = await seenByTool(f, makeAuth('organization', f.partnerA.id, f.orgA1.id), {
      scope: 'organization', orgId: f.orgA1.id, accessibleOrgIds: [f.orgA1.id], accessiblePartnerIds: [], currentPartnerId: f.partnerA.id,
    });
    expectVisibility(seenOrg, f, ['orgA1'], 'AI tool org A1');
  });
});

describe('cascadeDeletePartner — audit_logs partner attribution (#7696)', () => {
  it('purges a partner with partner-scoped audit rows and retains those rows (shared NULL-org chain)', async () => {
    const partner = await createPartner();
    const rowId = await seedRow({ orgId: null, partnerId: partner.id, action: `p7696.purge.${randomUUID().slice(0, 8)}` });
    await cascadeDeletePartner(partner.id, randomUUID());
    const rows = await getTestDb().select({ id: auditLogs.id }).from(auditLogs).where(eq(auditLogs.id, rowId));
    expect(rows).toHaveLength(1);
  });
});

describe('audit writer — partner attribution (#7696)', () => {
  function routeCtx(auth: Partial<AuthContext>) {
    return {
      req: { header: () => undefined },
      get: (key: string) => (key === 'auth' ? auth : undefined),
    } as never;
  }

  async function waitForRow(action: string) {
    for (let i = 0; i < 50; i++) {
      const rows = await getTestDb().select().from(auditLogs).where(eq(auditLogs.action, action));
      if (rows.length > 0) return rows[0]!;
      await new Promise((r) => setTimeout(r, 20));
    }
    throw new Error(`audit row ${action} never landed`);
  }

  it('stamps partner_id on a NULL-org row written from a partner-scope request', async () => {
    const partner = await createPartner();
    const action = `p7696.write.${randomUUID().slice(0, 8)}`;
    writeRouteAudit(
      routeCtx({ scope: 'partner', partnerId: partner.id, user: { id: randomUUID(), email: 'p@example.com' } as never }),
      { orgId: null, action, resourceType: 'configuration_policy' },
    );
    const row = await waitForRow(action);
    expect(row.orgId).toBeNull();
    expect(row.partnerId).toBe(partner.id);
  });

  it('never stamps partner_id from an org-scope request or on an org row', async () => {
    const partner = await createPartner();
    const org = await createOrganization({ partnerId: partner.id });
    const orgScopeNull = `p7696.write.${randomUUID().slice(0, 8)}`;
    writeRouteAudit(
      routeCtx({ scope: 'organization', partnerId: partner.id, orgId: org.id, user: { id: randomUUID() } as never }),
      { orgId: null, action: orgScopeNull, resourceType: 'user' },
    );
    expect((await waitForRow(orgScopeNull)).partnerId).toBeNull();

    const partnerOrgRow = `p7696.write.${randomUUID().slice(0, 8)}`;
    writeRouteAudit(
      routeCtx({ scope: 'partner', partnerId: partner.id, user: { id: randomUUID() } as never }),
      { orgId: org.id, action: partnerOrgRow, resourceType: 'device_group' },
    );
    const orgRow = await waitForRow(partnerOrgRow);
    expect(orgRow.orgId).toBe(org.id);
    expect(orgRow.partnerId).toBeNull();
  });

  it('attributes an auth-less snapshot-shim write (AI tools) from the ambient partner-scope DB context', async () => {
    const partner = await createPartner();
    const org = await createOrganization({ partnerId: partner.id });
    const partnerAction = `p7696.write.${randomUUID().slice(0, 8)}`;
    await withDbAccessContext(
      { scope: 'partner', orgId: null, accessibleOrgIds: [org.id], accessiblePartnerIds: [partner.id], currentPartnerId: partner.id },
      async () => writeAuditEvent(requestLikeFromSnapshot({}), { orgId: null, action: partnerAction, resourceType: 'notification_channel' }),
    );
    expect((await waitForRow(partnerAction)).partnerId).toBe(partner.id);

    const orgAction = `p7696.write.${randomUUID().slice(0, 8)}`;
    await withDbAccessContext(
      { scope: 'organization', orgId: org.id, accessibleOrgIds: [org.id], accessiblePartnerIds: [], currentPartnerId: partner.id },
      async () => writeAuditEvent(requestLikeFromSnapshot({}), { orgId: null, action: orgAction, resourceType: 'notification_channel' }),
    );
    expect((await waitForRow(orgAction)).partnerId).toBeNull();
  });

  it('createAuditLog persists an explicit partnerId and drops it on an org row', async () => {
    const partner = await createPartner();
    const org = await createOrganization({ partnerId: partner.id });
    const a1 = `p7696.write.${randomUUID().slice(0, 8)}`;
    await createAuditLog({ orgId: null, partnerId: partner.id, actorId: randomUUID(), action: a1, resourceType: 'update_ring', result: 'success' });
    const a2 = `p7696.write.${randomUUID().slice(0, 8)}`;
    await createAuditLog({ orgId: org.id, partnerId: partner.id, actorId: randomUUID(), action: a2, resourceType: 'update_ring', result: 'success' });
    const rows = await getTestDb()
      .select({ action: auditLogs.action, partnerId: auditLogs.partnerId })
      .from(auditLogs)
      .where(and(inArray(auditLogs.action, [a1, a2])));
    expect(rows.find((r) => r.action === a1)?.partnerId).toBe(partner.id);
    expect(rows.find((r) => r.action === a2)?.partnerId).toBeNull();
  });
});
