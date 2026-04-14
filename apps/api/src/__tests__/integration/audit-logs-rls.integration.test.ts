/**
 * Integration regression test for issue #437 —
 * `audit_logs` RLS violation on viewer-token session audit.
 *
 * The fix (apps/api/src/routes/remote/helpers.ts) wraps `logSessionAudit`'s
 * insert in `withDbAccessContext({ scope: 'organization', orgId,
 * accessibleOrgIds: [orgId] }, ...)` so the write satisfies the
 * `breeze_org_isolation_insert` policy on `audit_logs`
 * (`WITH CHECK (breeze_has_org_access(org_id))`).
 *
 * These tests run against real Postgres as the unprivileged `breeze_app`
 * role (created by `ensureAppRole()` during integration setup), so the
 * RLS policy is actually enforced. They prove:
 *
 *   1. Without any access context established, a raw insert into
 *      `audit_logs` is rejected by RLS with the exact error message we
 *      saw in production. This reproduces the pre-fix bug.
 *   2. `logSessionAudit` establishes its own org-scoped context internally
 *      and the insert succeeds, with the row visible to a subsequent
 *      org-scoped read.
 *   3. `logSessionAudit` swallows RLS / DB errors so the request path is
 *      not broken when the audit write itself fails.
 */
import './setup';
import { describe, it, expect, vi } from 'vitest';
import { eq } from 'drizzle-orm';
import { db, withDbAccessContext } from '../../db';
import { auditLogs } from '../../db/schema';
import { logSessionAudit } from '../../routes/remote/helpers';
import { createPartner, createOrganization } from './db-utils';
import { getTestDb } from './setup';

describe('audit_logs RLS — logSessionAudit (issue #437)', () => {
  it('reproduces the pre-fix bug: a raw insert with no access context is rejected by RLS', async () => {
    const partner = await createPartner();
    const org = await createOrganization({ partnerId: partner.id });

    // Simulate the pre-fix behavior: call the production db pool directly,
    // without wrapping in withDbAccessContext. As `breeze_app` the session
    // has scope='none' / accessible_org_ids='' so
    // breeze_has_org_access(org_id) returns false and the WITH CHECK
    // clause rejects the row. Drizzle wraps the Postgres error as
    // DrizzleQueryError — the RLS message lives on `error.cause.message`.
    let caught: unknown;
    try {
      await db.insert(auditLogs).values({
        orgId: org.id,
        actorType: 'user',
        actorId: '00000000-0000-0000-0000-000000000001',
        action: 'session_offer_submitted',
        resourceType: 'remote_session',
        resourceId: '00000000-0000-0000-0000-000000000002',
        details: { sessionId: '00000000-0000-0000-0000-000000000002' },
        ipAddress: '10.0.0.1',
        result: 'success'
      });
    } catch (err) {
      caught = err;
    }

    expect(caught).toBeDefined();
    const cause = (caught as { cause?: { message?: string } } | undefined)?.cause;
    expect(cause?.message).toMatch(
      /new row violates row-level security policy for table "audit_logs"/
    );
  });

  it('logSessionAudit establishes an org-scoped context and the insert succeeds', async () => {
    const partner = await createPartner();
    const org = await createOrganization({ partnerId: partner.id });
    const sessionId = '11111111-1111-1111-1111-111111111111';
    const actorId = '22222222-2222-2222-2222-222222222222';

    await logSessionAudit(
      'session_offer_submitted',
      actorId,
      org.id,
      { sessionId, type: 'desktop', via: 'viewer_token' },
      '10.0.0.1'
    );

    // Verify the row landed. Read as superuser via the test client to
    // avoid any RLS interaction on the verification path.
    const rows = await getTestDb()
      .select()
      .from(auditLogs)
      .where(eq(auditLogs.resourceId, sessionId));

    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      orgId: org.id,
      actorType: 'user',
      actorId,
      action: 'session_offer_submitted',
      resourceType: 'remote_session',
      ipAddress: '10.0.0.1',
      result: 'success'
    });
  });

  it('logSessionAudit swallows RLS rejection instead of throwing (contract preserved)', async () => {
    // Pass an org_id for an org the caller has no access to by
    // constructing a syntactically valid but non-existent UUID. The
    // helper wraps in an org-scoped context pinned to that id, so the
    // RLS WITH CHECK passes — but the FK on audit_logs.org_id fails
    // because no matching `organizations` row exists. The helper must
    // still resolve without throwing so the request path is unaffected.
    const fakeOrgId = '33333333-3333-3333-3333-333333333333';
    const errSpy = vi.spyOn(console, 'error').mockImplementation(() => {});

    await expect(
      logSessionAudit(
        'session_offer_submitted',
        '44444444-4444-4444-4444-444444444444',
        fakeOrgId,
        { sessionId: '55555555-5555-5555-5555-555555555555' }
      )
    ).resolves.toBeUndefined();

    expect(errSpy).toHaveBeenCalledWith(
      'Failed to log session audit:',
      expect.any(Error)
    );
    errSpy.mockRestore();
  });

  it('nested withDbAccessContext: logSessionAudit runs under the caller\'s existing scope', async () => {
    const partner = await createPartner();
    const org = await createOrganization({ partnerId: partner.id });
    const sessionId = '66666666-6666-6666-6666-666666666666';

    // JWT-authenticated call sites reach logSessionAudit already inside
    // an access context established by the auth middleware. The helper's
    // internal withDbAccessContext short-circuits in that case and the
    // insert runs under the caller's scope — this test proves that path
    // still satisfies RLS.
    await withDbAccessContext(
      {
        scope: 'organization',
        orgId: org.id,
        accessibleOrgIds: [org.id]
      },
      () =>
        logSessionAudit(
          'session_offer_submitted',
          '77777777-7777-7777-7777-777777777777',
          org.id,
          { sessionId, type: 'desktop', via: 'jwt' }
        )
    );

    const rows = await getTestDb()
      .select()
      .from(auditLogs)
      .where(eq(auditLogs.resourceId, sessionId));

    expect(rows).toHaveLength(1);
  });
});
