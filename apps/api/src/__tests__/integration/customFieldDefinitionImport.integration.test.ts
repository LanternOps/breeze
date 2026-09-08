/**
 * Custom-field DEFINITION importer against real Postgres (#3257 W07, #4775).
 *
 * Four things this suite exists to prove, none of which a mocked unit test can:
 *
 *  a. A partner-wide import from a caller without `canManagePartnerWidePolicies`
 *     is refused **403** at preview AND at commit, through the real route stack
 *     (real `resolveImportPartnerId`, real capability helper) — not a 200 with
 *     an annotation the browser might ignore.
 *  b. A cross-axis shadow is annotated `key-shadowed` at PREVIEW, and if
 *     submitted anyway the commit refuses it with the same code — driven by
 *     W03's real `custom_field_definitions_no_shadow` trigger (P0001), not by a
 *     stub.
 *  c. TOCTOU: a definition created BETWEEN preview and commit flips the
 *     annotation, and the row is rejected with `annotation-changed` rather than
 *     silently becoming a no-op or a duplicate.
 *  d. Organization isolation: a row naming an organization outside the caller's
 *     reach never lands, and reports `org-not-found` rather than acting as an
 *     existence oracle.
 *
 * ── Why the middleware is re-created rather than stubbed away ───────────────
 * `authMiddleware` does two things this suite depends on: it puts an
 * `AuthContext` on the request, and it opens the request's
 * `withDbAccessContext` transaction. `fakeAuth` below does BOTH, so the route
 * handlers, the service's per-row nested `db.transaction` (a SAVEPOINT inside
 * that request transaction) and RLS all behave exactly as they do in
 * production. Only the token exchange is skipped.
 *
 * The importer's snapshot READ runs in a system context by design — a
 * partner-scoped import spans many of that partner's organizations, and no one
 * request context can see another org's rows (#4944 added a partner-wide SELECT
 * branch to this table, which closes the org-token-can't-see-partner-wide half
 * but not the cross-org half). RLS is therefore NOT the control on that read.
 * Test (d) is an app-layer assertion by necessity, and asserting it here —
 * under a real system-context read — is the only place it can be proven at all.
 */
import './setup';
import { afterEach, describe, expect, it } from 'vitest';
import { and, eq } from 'drizzle-orm';
import { Hono } from 'hono';
import { db, withDbAccessContext, type DbAccessContext } from '../../db';
import { customFieldDefinitions } from '../../db/schema';
import {
  assignUserToOrganization,
  assignUserToPartner,
  createOrganization,
  createPartner,
  createRole,
  createUser,
  grantRolePermissions,
} from './db-utils';
import { buildDbAccessContext } from '../../middleware/auth';
import { pgErrorCode, pgErrorNode } from '../../utils/pgErrors';
import {
  commitCustomFieldDefinitionImport,
  previewCustomFieldDefinitionImport,
  type DefinitionImportContext,
} from '../../services/customFields/import/definitionImport';
import { customFieldImportRoutes } from '../../routes/customFieldImport';
import { PARTNER_WIDE_WRITE_DENIED_MESSAGE } from '../../services/partnerWideAccess';

const runDb = it.runIf(!!process.env.DATABASE_URL);

const SYSTEM_CTX: DbAccessContext = {
  scope: 'system',
  orgId: null,
  accessibleOrgIds: null,
  accessiblePartnerIds: null,
  userId: null,
};

const createdDefinitions: string[] = [];

afterEach(async () => {
  if (createdDefinitions.length === 0) return;
  await withDbAccessContext(SYSTEM_CTX, async () => {
    for (const id of createdDefinitions) {
      await db.delete(customFieldDefinitions).where(eq(customFieldDefinitions.id, id));
    }
  });
  createdDefinitions.length = 0;
});

/**
 * The shape `middleware/auth` puts on the request.
 *
 * `token.mfa` and the `user` row are real requirements, not decoration: the
 * routes mount the REAL `requireMfa()` and the REAL `requirePermission()`, and
 * the latter resolves `devices:write` out of the permissions catalog for this
 * user id. The fixtures below therefore create a genuine user + membership +
 * role + grant, so the whole middleware chain runs — only the token exchange is
 * skipped.
 */
interface FakeAuth {
  scope: 'organization' | 'partner' | 'system';
  partnerId: string | null;
  orgId: string | null;
  accessibleOrgIds: string[] | null;
  partnerOrgAccess: 'all' | 'selected' | null;
  user: { id: string; email: string };
  token: { mfa: boolean };
}

const DEVICES_WRITE = [{ resource: 'devices', action: 'write' }];

async function partnerAuth(
  partnerId: string,
  orgIds: string[],
  orgAccess: 'all' | 'selected',
): Promise<FakeAuth> {
  const role = await createRole({ scope: 'partner', partnerId });
  await grantRolePermissions(role.id, DEVICES_WRITE);
  const user = await createUser({ partnerId });
  await assignUserToPartner(user.id, partnerId, role.id, orgAccess);
  return {
    scope: 'partner',
    partnerId,
    orgId: null,
    accessibleOrgIds: orgIds,
    partnerOrgAccess: orgAccess,
    user: { id: user.id, email: user.email },
    token: { mfa: true },
  };
}

async function orgAuth(partnerId: string, orgId: string): Promise<FakeAuth> {
  const role = await createRole({ scope: 'organization', orgId });
  await grantRolePermissions(role.id, DEVICES_WRITE);
  const user = await createUser({ partnerId, orgId });
  await assignUserToOrganization(user.id, orgId, role.id);
  return {
    scope: 'organization',
    partnerId,
    orgId,
    accessibleOrgIds: [orgId],
    partnerOrgAccess: null,
    user: { id: user.id, email: user.email },
    token: { mfa: true },
  };
}

/**
 * Built with the CANONICAL helper, not by hand. `buildDbAccessContext` derives
 * `accessiblePartnerIds` from scope+partnerId and sets `currentPartnerId` —
 * a hand-rolled copy would drift from the request path. `currentPartnerId` is
 * load-bearing for this table since #4944 added
 * `custom_field_definitions_partner_wide_select`, which keys on it, so a
 * harness that omitted it would quietly stop proving anything about that path.
 */
function dbContextFor(auth: FakeAuth): DbAccessContext {
  return buildDbAccessContext({
    scope: auth.scope,
    orgId: auth.orgId,
    accessibleOrgIds: auth.accessibleOrgIds,
    partnerId: auth.partnerId,
    userId: auth.user.id,
  });
}

/**
 * Stand up the real route app with everything but the token exchange intact:
 * the auth context AND the request's db access transaction, exactly as
 * `authMiddleware` provides them.
 */
function appFor(auth: FakeAuth) {
  const app = new Hono();
  app.use('*', async (c, next) => {
    c.set('auth', auth as never);
    await withDbAccessContext(dbContextFor(auth), () => next());
  });
  app.route('/custom-fields', customFieldImportRoutes);
  return app;
}

async function post(auth: FakeAuth, path: string, body: unknown) {
  const res = await appFor(auth).request(path, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: 'Bearer test' },
    body: JSON.stringify(body),
  });
  return { status: res.status, body: (await res.json()) as any };
}

const PREVIEW = '/custom-fields/import/preview';
const COMMIT = '/custom-fields/import';

async function seedDefinition(
  owner: { orgId: string | null; partnerId: string | null },
  fieldKey: string,
  type: 'text' | 'date',
): Promise<string> {
  const rows = await withDbAccessContext(SYSTEM_CTX, () =>
    db
      .insert(customFieldDefinitions)
      .values({ ...owner, name: fieldKey, fieldKey, type })
      .returning({ id: customFieldDefinitions.id }),
  );
  const id = rows[0]!.id;
  createdDefinitions.push(id);
  return id;
}

async function definitionCount(fieldKey: string, orgId: string | null, partnerId: string | null) {
  return withDbAccessContext(SYSTEM_CTX, async () => {
    const rows = await db
      .select({ id: customFieldDefinitions.id })
      .from(customFieldDefinitions)
      .where(
        and(
          eq(customFieldDefinitions.fieldKey, fieldKey),
          orgId ? eq(customFieldDefinitions.orgId, orgId) : eq(customFieldDefinitions.partnerId, partnerId!),
        ),
      );
    for (const r of rows) if (!createdDefinitions.includes(r.id)) createdDefinitions.push(r.id);
    return rows.length;
  });
}

/** Unique per test so a parallel shard cannot collide on the per-axis unique index. */
function uniqueKey(prefix: string): string {
  return `${prefix}_${Math.random().toString(36).slice(2, 8)}`;
}

describe('custom-field definition import (integration)', () => {
  runDb('refuses a partner-wide import from an org-scoped caller with 403 at preview AND commit', async () => {
    const partner = await createPartner();
    const org = await createOrganization({ partnerId: partner.id });
    const auth = await orgAuth(partner.id, org.id);
    const fieldKey = uniqueKey('udf_pw');
    const rows = [{ fieldKey, name: 'Warranty', type: 'date', ownerScope: 'partner' }];

    const preview = await post(auth, PREVIEW, { rows });
    expect(preview.status).toBe(403);
    expect(preview.body.error).toBe(PARTNER_WIDE_WRITE_DENIED_MESSAGE);

    const commit = await post(auth, COMMIT, { rows: [{ ...rows[0], expectedAnnotation: 'create' }] });
    expect(commit.status).toBe(403);

    // The refusal is real, not cosmetic: nothing was written on either call.
    expect(await definitionCount(fieldKey, null, partner.id)).toBe(0);
  });

  runDb('refuses a partner-wide import from a `selected` partner user with 403', async () => {
    const partner = await createPartner();
    const org = await createOrganization({ partnerId: partner.id });
    const fieldKey = uniqueKey('udf_sel');
    const auth = await partnerAuth(partner.id, [org.id], 'selected');

    const preview = await post(auth, PREVIEW, {
      rows: [{ fieldKey, name: 'Warranty', type: 'date', ownerScope: 'partner' }],
    });
    expect(preview.status).toBe(403);
    expect(await definitionCount(fieldKey, null, partner.id)).toBe(0);
  });

  runDb('annotates a cross-axis shadow at preview and refuses it at commit', async () => {
    const partner = await createPartner();
    const org = await createOrganization({ partnerId: partner.id });
    const fieldKey = uniqueKey('udf_shadow');
    await seedDefinition({ orgId: null, partnerId: partner.id }, fieldKey, 'text');

    const auth = await partnerAuth(partner.id, [org.id], 'all');
    const row = { fieldKey, name: 'Local copy', type: 'text', ownerScope: 'organization', organizationId: org.id };

    const preview = await post(auth, PREVIEW, { rows: [row] });
    expect(preview.status).toBe(200);
    expect(preview.body.rows[0].annotation).toBe('key-shadowed');

    // Submitted anyway, acknowledged as a `create`: refused, with the shadow
    // reported rather than an unexplained write failure.
    const commit = await post(auth, COMMIT, { rows: [{ ...row, expectedAnnotation: 'create' }] });
    expect(commit.status).toBe(200);
    expect(commit.body.created).toHaveLength(0);
    expect(commit.body.errors[0].code).toBe('key-shadowed');
    expect(await definitionCount(fieldKey, org.id, null)).toBe(0);
  });

  runDb("proves W03's trigger — not just the snapshot — refuses the shadow", async () => {
    // The service annotates from a snapshot. If that snapshot were wrong, the
    // DATABASE must still refuse the write. Forge the insert directly to show
    // the trigger is live and raises P0001, which is what the commit path maps
    // to `key-shadowed` when a shadow appears after the snapshot was taken.
    const partner = await createPartner();
    const org = await createOrganization({ partnerId: partner.id });
    const fieldKey = uniqueKey('udf_trig');
    await seedDefinition({ orgId: null, partnerId: partner.id }, fieldKey, 'text');

    let thrown: unknown;
    try {
      await withDbAccessContext(SYSTEM_CTX, () =>
        db.insert(customFieldDefinitions).values({
          orgId: org.id,
          partnerId: null,
          name: 'forged',
          fieldKey,
          type: 'text',
        }),
      );
    } catch (err) {
      thrown = err;
    }
    // Drizzle wraps the driver error, so the SQLSTATE lives on `.cause` — which
    // is exactly why the service reads it through `pgErrorCode` rather than
    // `err.code`. A check on the outer error would pass vacuously here and miss
    // every real trigger violation in production.
    expect(pgErrorCode(thrown)).toBe('P0001');
    expect(pgErrorNode(thrown)?.constraint_name).toBe('custom_field_definitions_no_shadow');
  });

  runDb('rejects a row whose annotation changed between preview and commit (TOCTOU)', async () => {
    const partner = await createPartner();
    const org = await createOrganization({ partnerId: partner.id });
    const auth = await partnerAuth(partner.id, [org.id], 'all');
    const fieldKey = uniqueKey('udf_toctou');
    const row = { fieldKey, name: 'Warranty', type: 'date', ownerScope: 'partner' };

    const preview = await post(auth, PREVIEW, { rows: [row] });
    expect(preview.body.rows[0].annotation).toBe('create');

    // Someone else creates it in the window between preview and commit.
    const raced = await seedDefinition({ orgId: null, partnerId: partner.id }, fieldKey, 'date');

    const commit = await post(auth, COMMIT, { rows: [{ ...row, expectedAnnotation: 'create' }] });
    expect(commit.status).toBe(200);
    expect(commit.body.created).toHaveLength(0);
    expect(commit.body.errors[0].code).toBe('annotation-changed');
    // The acknowledged `create` did NOT silently become a no-op against the
    // row that appeared: exactly one definition exists, the raced one.
    expect(await definitionCount(fieldKey, null, partner.id)).toBe(1);
    expect(createdDefinitions).toContain(raced);
  });

  runDb('rejects an already-exists acknowledgement pinned to a definition that changed hands', async () => {
    const partner = await createPartner();
    const org = await createOrganization({ partnerId: partner.id });
    const auth = await partnerAuth(partner.id, [org.id], 'all');
    const fieldKey = uniqueKey('udf_pin');
    await seedDefinition({ orgId: null, partnerId: partner.id }, fieldKey, 'date');

    const commit = await post(auth, COMMIT, {
      rows: [{
        fieldKey,
        name: 'Warranty',
        type: 'date',
        ownerScope: 'partner',
        expectedAnnotation: 'already-exists',
        expectedDefinitionId: '99999999-9999-4999-8999-999999999999',
      }],
    });
    expect(commit.body.errors[0].code).toBe('match-changed');
    expect(commit.body.skipped).toHaveLength(0);
  });

  runDb('never lands a row naming an organization outside the caller reach', async () => {
    const partner = await createPartner();
    const mine = await createOrganization({ partnerId: partner.id });
    const theirs = await createOrganization({ partnerId: partner.id });
    // A partner user restricted to `mine` — `theirs` exists and is under the
    // same partner, which is the case a partner-only filter would let through.
    const auth = await partnerAuth(partner.id, [mine.id], 'all');
    const fieldKey = uniqueKey('udf_iso');

    const preview = await post(auth, PREVIEW, {
      rows: [{ fieldKey, name: 'Asset tag', type: 'text', ownerScope: 'organization', organizationId: theirs.id }],
    });
    expect(preview.body.rows[0].annotation).toBe('org-not-found');

    const commit = await post(auth, COMMIT, {
      rows: [{
        fieldKey,
        name: 'Asset tag',
        type: 'text',
        ownerScope: 'organization',
        organizationId: theirs.id,
        expectedAnnotation: 'create',
      }],
    });
    expect(commit.body.created).toHaveLength(0);
    expect(commit.body.errors[0].code).toBe('org-not-found');
    expect(await definitionCount(fieldKey, theirs.id, null)).toBe(0);
  });

  runDb('creates, then skips on re-import, and isolates a failing row from a good one', async () => {
    const partner = await createPartner();
    const org = await createOrganization({ partnerId: partner.id });
    const auth = await partnerAuth(partner.id, [org.id], 'all');
    const goodKey = uniqueKey('udf_ok');
    const shadowKey = uniqueKey('udf_bad');
    await seedDefinition({ orgId: null, partnerId: partner.id }, shadowKey, 'text');

    const first = await post(auth, COMMIT, {
      externalSystem: 'datto_rmm',
      rows: [
        { fieldKey: goodKey, name: 'Asset tag', type: 'text', ownerScope: 'organization', organizationId: org.id, sourceLabel: 'udf7', expectedAnnotation: 'create' },
        { fieldKey: shadowKey, name: 'Shadow', type: 'text', ownerScope: 'organization', organizationId: org.id, expectedAnnotation: 'create' },
      ],
    });
    expect(first.status).toBe(200);
    expect(first.body.created).toHaveLength(1);
    expect(first.body.created[0]).toMatchObject({ index: 0, fieldKey: goodKey, ownerScope: 'organization' });
    // The refused row did not cost the good one: per-row isolation is real,
    // which inside ONE request transaction is only true because each write runs
    // in its own nested transaction (SAVEPOINT).
    expect(first.body.errors[0]).toMatchObject({ index: 1, code: 'key-shadowed' });
    createdDefinitions.push(first.body.created[0].definitionId);

    // Re-importing the same file writes nothing.
    const again = await post(auth, COMMIT, {
      rows: [{
        fieldKey: goodKey,
        name: 'Asset tag',
        type: 'text',
        ownerScope: 'organization',
        organizationId: org.id,
        expectedAnnotation: 'already-exists',
        expectedDefinitionId: first.body.created[0].definitionId,
      }],
    });
    expect(again.body.created).toHaveLength(0);
    expect(again.body.skipped[0]).toMatchObject({ fieldKey: goodKey, reason: 'already-exists' });
    expect(await definitionCount(goodKey, org.id, null)).toBe(1);
  });

  runDb('isolates a REAL write-time database refusal from a good row in the same batch', async () => {
    // Every other refusal in this suite is caught by the snapshot BEFORE any
    // insert is attempted, so none of them exercises the per-row nested
    // transaction under an actual failing statement. This one does.
    //
    // The setup is the one legitimate way the snapshot can be blind: an
    // org-owned definition lives under an organization the caller cannot
    // reach, so `loadSnapshot` skips it, `annotateRows` says `create` for a
    // partner-wide row with that key — and W03's trigger refuses the INSERT.
    const partner = await createPartner();
    const mine = await createOrganization({ partnerId: partner.id });
    const unreachable = await createOrganization({ partnerId: partner.id });
    const shadowed = uniqueKey('udf_race');
    const good = uniqueKey('udf_good');
    await seedDefinition({ orgId: unreachable.id, partnerId: null }, shadowed, 'text');

    // The service is called directly: the route derives the caller's reach from
    // the token, and this scenario is precisely "reach that excludes a row the
    // database still enforces against".
    const ctx: DefinitionImportContext = {
      partnerId: partner.id,
      accessibleOrgIds: [mine.id],
      canManagePartnerWide: true,
    };
    const auth = await partnerAuth(partner.id, [mine.id], 'all');

    const summary = await withDbAccessContext(dbContextFor(auth), async () => {
      const preview = await previewCustomFieldDefinitionImport(
        [{ fieldKey: shadowed, name: 'Shadowed', type: 'text', ownerScope: 'partner' }],
        ctx,
      );
      // Preview genuinely could not see it — this is what makes the write real.
      expect(preview[0]!.annotation).toBe('create');

      return commitCustomFieldDefinitionImport(
        [
          { fieldKey: shadowed, name: 'Shadowed', type: 'text', ownerScope: 'partner', expectedAnnotation: 'create' },
          { fieldKey: good, name: 'Good', type: 'text', ownerScope: 'partner', expectedAnnotation: 'create' },
        ],
        ctx,
        { userId: auth.user.id },
      );
    });

    // Row 0 failed at the INSERT and was mapped from the trigger's P0001.
    expect(summary.errors).toHaveLength(1);
    expect(summary.errors[0]).toMatchObject({ index: 0, code: 'key-shadowed' });
    // Row 1 still landed: the failure rolled back to row 0's SAVEPOINT and left
    // the request transaction healthy. Without the nested transaction this
    // would be a 25P02 instead.
    expect(summary.created).toHaveLength(1);
    expect(summary.created[0]).toMatchObject({ index: 1, fieldKey: good });
    createdDefinitions.push(summary.created[0]!.definitionId);
    expect(await definitionCount(shadowed, null, partner.id)).toBe(0);

    // …and the driver's own text never reaches the wire.
    const serialized = JSON.stringify(summary);
    expect(serialized).not.toMatch(/DETAIL|insert into|Failed query|params:/i);
    expect(serialized).not.toMatch(/cause/);
  });

  runDb('treats a soft-deleted organization as out of reach', async () => {
    // `loadSnapshot` filters on `isNull(organizations.deletedAt)`. The mocked
    // unit tests cannot see that predicate at all — only a real query can.
    const partner = await createPartner();
    const live = await createOrganization({ partnerId: partner.id });
    const deleted = await createOrganization({ partnerId: partner.id, deletedAt: new Date() });
    const auth = await partnerAuth(partner.id, [live.id, deleted.id], 'all');
    const fieldKey = uniqueKey('udf_soft');

    const preview = await post(auth, PREVIEW, {
      rows: [{ fieldKey, name: 'Asset tag', type: 'text', ownerScope: 'organization', organizationId: deleted.id }],
    });
    expect(preview.body.rows[0].annotation).toBe('org-not-found');

    const commit = await post(auth, COMMIT, {
      rows: [{
        fieldKey,
        name: 'Asset tag',
        type: 'text',
        ownerScope: 'organization',
        organizationId: deleted.id,
        expectedAnnotation: 'create',
      }],
    });
    expect(commit.body.created).toHaveLength(0);
    expect(commit.body.errors[0].code).toBe('org-not-found');
    expect(await definitionCount(fieldKey, deleted.id, null)).toBe(0);
  });
});
