/**
 * Archived-org READ ONLY context + `includeArchived` org reads (Wave 4, Task 3).
 *
 * Spec: docs/superpowers/specs/tenancy-rls/2026-08-26-org-lifecycle-merge-archive-design.md
 * (Part 2, "Hidden + read-only").
 *
 * `archived` orgs are deliberately absent from `computeAccessibleOrgIds`
 * (`status IN ('active','trial')`), so they are invisible to every normal
 * request context. The ONLY way to read one is `withArchivedOrgReadContext`,
 * whose transaction is opened `READ ONLY` — read-onlyness is enforced by
 * Postgres (SQLSTATE 25006), not by middleware, so it holds for any caller
 * that obtains the context, including a worker or a public route.
 *
 * Everything here runs through the real `breeze_app` pool (rolbypassrls =
 * false — see setup.ts), so RLS and the transaction's read-only flag are
 * genuinely enforced.
 */
import './setup';

import { Hono } from 'hono';
import { eq, sql } from 'drizzle-orm';
import { describe, expect, it } from 'vitest';
import {
  db,
  withArchivedOrgReadContext,
  withSystemDbAccessContext,
} from '../../db';
import { devices, organizations } from '../../db/schema';
import { orgRoutes } from '../../routes/orgs';
import {
  createIntegrationTestClient,
  createOrganization,
  createPartner,
  createSite,
} from './db-utils';
import { getTestDb } from './setup';

function buildApp(): Hono {
  const app = new Hono();
  app.route('/api/v1/orgs', orgRoutes);
  return app;
}

/**
 * Land an existing org on `archived` as the privileged test role. Wave 1
 * shipped the enum value + the `archived_at` / `purge_at` columns; the
 * lifecycle service (Task 1) is what stamps them in production.
 */
async function archiveOrg(orgId: string): Promise<void> {
  await getTestDb().execute(sql`
    UPDATE organizations
       SET status = 'archived',
           archived_at = now(),
           purge_at = now() + interval '90 days',
           offboarding_target = 'archive'
     WHERE id = ${orgId}
  `);
}

/**
 * Returns the postgres.js cause of a rejection, or undefined when the call
 * unexpectedly succeeded. Drizzle wraps the top-level message as
 * "Failed query: ..." — the real SQLSTATE lands on `.cause`.
 */
async function captureDbCause(
  fn: () => Promise<unknown>,
): Promise<{ code?: string; message?: string } | undefined> {
  try {
    await fn();
    return undefined;
  } catch (err) {
    return (err as { cause?: { code?: string; message?: string } } | undefined)?.cause;
  }
}

interface ListResponse {
  data: Array<Record<string, unknown>>;
  pagination: { page: number; limit: number; total: number };
  archivedTruncated?: boolean;
}

describe('withArchivedOrgReadContext (READ ONLY transaction)', () => {
  it('serves the archived org row but refuses any write with SQLSTATE 25006', async () => {
    const partner = await createPartner();
    const org = await createOrganization({ partnerId: partner.id });
    await archiveOrg(org.id);

    // Positive control FIRST: without this, the write rejection below could
    // pass vacuously against a context that sees nothing at all.
    const visible = await withArchivedOrgReadContext([org.id], () =>
      db
        .select({ id: organizations.id, status: organizations.status })
        .from(organizations)
        .where(eq(organizations.id, org.id)),
    );
    expect(visible).toHaveLength(1);
    expect(visible[0]?.status).toBe('archived');

    const cause = await captureDbCause(() =>
      withArchivedOrgReadContext([org.id], () =>
        db
          .update(organizations)
          .set({ name: 'Tampered By A Read Context' })
          .where(eq(organizations.id, org.id)),
      ),
    );

    expect(cause).toBeDefined();
    expect(cause?.code).toBe('25006');

    // And the row really is untouched.
    const [after] = await withSystemDbAccessContext(() =>
      db
        .select({ name: organizations.name })
        .from(organizations)
        .where(eq(organizations.id, org.id)),
    );
    expect(after?.name).toBe(org.name);
  });

  it('refuses an INSERT inside the context too (read-onlyness is transaction-wide)', async () => {
    const partner = await createPartner();
    const org = await createOrganization({ partnerId: partner.id });
    await archiveOrg(org.id);

    const cause = await captureDbCause(() =>
      withArchivedOrgReadContext([org.id], () =>
        db.insert(organizations).values({
          partnerId: partner.id,
          name: 'Smuggled Org',
          slug: `smuggled-${Date.now()}`,
          currencyCode: 'USD',
        }),
      ),
    );

    expect(cause).toBeDefined();
    expect(cause?.code).toBe('25006');
  });

  it("hides another partner's archived org (RLS still applies to the id set)", async () => {
    const partnerA = await createPartner();
    const orgA = await createOrganization({ partnerId: partnerA.id });
    await archiveOrg(orgA.id);

    const partnerB = await createPartner();
    const orgB = await createOrganization({ partnerId: partnerB.id });
    await archiveOrg(orgB.id);

    const rows = await withArchivedOrgReadContext([orgA.id], () =>
      db
        .select({ id: organizations.id })
        .from(organizations)
        .where(eq(organizations.id, orgB.id)),
    );

    expect(rows).toEqual([]);
  });

  it('refuses to nest inside an existing DB access context', async () => {
    const partner = await createPartner();
    const org = await createOrganization({ partnerId: partner.id });
    await archiveOrg(org.id);

    await expect(
      withSystemDbAccessContext(() =>
        withArchivedOrgReadContext([org.id], async () => 'unreachable'),
      ),
    ).rejects.toThrow(/cannot nest/i);
  });
});

describe('GET /organizations — includeArchived', () => {
  it('hides archived orgs by default and returns them flagged with includeArchived=true', async () => {
    const app = buildApp();
    const client = await createIntegrationTestClient(app, { scope: 'partner' });
    const activeOrgId = client.env.organization.id;

    const archived = await createOrganization({
      partnerId: client.env.partner.id,
      name: 'Archived Customer',
    });
    const archivedSite = await createSite({ orgId: archived.id });
    // The device count for an archived org can only be read inside the
    // archived context — the request's own context cannot see its devices.
    await getTestDb().insert(devices).values({
      orgId: archived.id,
      siteId: archivedSite.id,
      agentId: `agent-archived-${Date.now()}`,
      hostname: 'archived-host',
      osType: 'windows',
      osVersion: '11',
      architecture: 'x64',
      agentVersion: '1.0.0',
    });
    await archiveOrg(archived.id);

    // Another partner's archived org must never surface.
    const otherPartner = await createPartner();
    const otherArchived = await createOrganization({ partnerId: otherPartner.id });
    await archiveOrg(otherArchived.id);

    const defaultRes = await client.get('/api/v1/orgs/organizations');
    expect(defaultRes.status).toBe(200);
    const defaultBody = (await defaultRes.json()) as ListResponse;
    expect(defaultBody.data.map((o) => o.id)).toEqual([activeOrgId]);

    const withArchivedRes = await client.get(
      '/api/v1/orgs/organizations?includeArchived=true',
    );
    expect(withArchivedRes.status).toBe(200);
    const withArchivedBody = (await withArchivedRes.json()) as ListResponse;

    const ids = withArchivedBody.data.map((o) => o.id);
    expect(ids).toContain(activeOrgId);
    expect(ids).toContain(archived.id);
    expect(ids).not.toContain(otherArchived.id);

    const archivedRow = withArchivedBody.data.find((o) => o.id === archived.id)!;
    expect(archivedRow.archived).toBe(true);
    expect(archivedRow.status).toBe('archived');
    expect(archivedRow.purgeAt).toBeTruthy();
    // Counted inside the archived context: the request's own context cannot
    // see an archived org's devices, so a naive count would report 0.
    expect(archivedRow.deviceCount).toBe(1);

    const activeRow = withArchivedBody.data.find((o) => o.id === activeOrgId)!;
    expect(activeRow.archived).toBeFalsy();
  });

  // The archived block is capped at the page limit rather than paginated, so
  // the cap has to be visible. Real Postgres here because the cap is enforced
  // by the discovery query's LIMIT, not by anything a mock would exercise.
  it('caps the archived block at the page limit and says so', async () => {
    const app = buildApp();
    const client = await createIntegrationTestClient(app, { scope: 'partner' });

    for (let i = 0; i < 3; i += 1) {
      const org = await createOrganization({
        partnerId: client.env.partner.id,
        name: `Archived ${i}`,
      });
      await archiveOrg(org.id);
    }

    const capped = await client.get(
      '/api/v1/orgs/organizations?page=1&limit=2&includeArchived=true',
    );
    const cappedBody = (await capped.json()) as ListResponse;
    expect(cappedBody.data.filter((o) => o.archived === true)).toHaveLength(2);
    expect(cappedBody.archivedTruncated).toBe(true);

    const whole = await client.get(
      '/api/v1/orgs/organizations?page=1&limit=50&includeArchived=true',
    );
    const wholeBody = (await whole.json()) as ListResponse;
    expect(wholeBody.data.filter((o) => o.archived === true)).toHaveLength(3);
    expect(wholeBody.archivedTruncated).toBe(false);
  });

  it('returns the archived org even when the partner has no active orgs left', async () => {
    const app = buildApp();
    const client = await createIntegrationTestClient(app, { scope: 'partner' });
    // Archive the partner's ONLY org: accessibleOrgIds is now empty, which is
    // the branch that used to short-circuit the whole handler.
    await archiveOrg(client.env.organization.id);

    const defaultRes = await client.get('/api/v1/orgs/organizations');
    const defaultBody = (await defaultRes.json()) as ListResponse;
    expect(defaultBody.data).toEqual([]);

    const res = await client.get('/api/v1/orgs/organizations?includeArchived=true');
    expect(res.status).toBe(200);
    const body = (await res.json()) as ListResponse;
    expect(body.data.map((o) => o.id)).toEqual([client.env.organization.id]);
    expect(body.data[0]?.archived).toBe(true);
  });
});

describe('GET /organizations/:id — archived target', () => {
  it("serves the caller's own archived org and still 404s another partner's", async () => {
    const app = buildApp();
    const client = await createIntegrationTestClient(app, { scope: 'partner' });

    const archived = await createOrganization({
      partnerId: client.env.partner.id,
      name: 'Archived Detail Org',
    });
    await archiveOrg(archived.id);

    const otherPartner = await createPartner();
    const otherArchived = await createOrganization({ partnerId: otherPartner.id });
    await archiveOrg(otherArchived.id);

    const ownRes = await client.get(`/api/v1/orgs/organizations/${archived.id}`);
    expect(ownRes.status).toBe(200);
    const ownBody = (await ownRes.json()) as Record<string, unknown>;
    expect(ownBody.id).toBe(archived.id);
    expect(ownBody.status).toBe('archived');
    expect(ownBody.archived).toBe(true);

    const crossRes = await client.get(
      `/api/v1/orgs/organizations/${otherArchived.id}`,
    );
    expect(crossRes.status).toBe(404);
  });

  // Against real Postgres, because the failure this guards is a DRIVER error:
  // a non-UUID reaching a uuid column raises 22P02, which surfaces as a 500
  // (plus a Sentry event) that any caller can pump with a junk URL. A mocked
  // suite cannot see it — the mock happily "matches" a garbage id.
  it('404s a malformed org id instead of raising 22P02', async () => {
    const app = buildApp();
    const client = await createIntegrationTestClient(app, { scope: 'partner' });

    for (const badId of ['undefined', 'not-a-uuid', '123']) {
      const res = await client.get(`/api/v1/orgs/organizations/${badId}`);
      expect(res.status, `id=${badId}`).toBe(404);
    }
  });
});
