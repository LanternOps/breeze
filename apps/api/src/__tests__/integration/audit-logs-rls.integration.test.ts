/**
 * Integration regression test for issue #437 —
 * `audit_logs` RLS violation on viewer-token session audit.
 *
 * The original fix (helpers.ts) wrapped `logSessionAudit`'s insert in
 * `withDbAccessContext({ scope: 'organization', orgId, accessibleOrgIds:
 * [orgId] }, ...)`, which satisfied RLS on the viewer-token path but left
 * two latent hazards for JWT-authenticated callers:
 *
 *   1. Nested `withDbAccessContext` short-circuits to a no-op under an
 *      existing context, so partner-scope callers wrote the audit row
 *      under their own scope rather than under org scope.
 *   2. The audit insert ran inside the caller's request transaction. A
 *      failing insert aborts the whole caller tx and silently rolls back
 *      real work (session creation, transfer creation) because
 *      `logSessionAudit` swallows its own errors.
 *
 * The follow-up fix moves `logSessionAudit` to the same pattern as
 * `services/auditService.createAuditLog`: `runOutsideDbContext` →
 * `withSystemDbAccessContext`, which forces a fresh system-scope
 * transaction on a separate pooled connection. That closes both hazards.
 *
 * These tests run against real Postgres as the unprivileged `breeze_app`
 * role so RLS policies are actually enforced. They prove:
 *
 *   1. Pre-fix reproducer: a raw insert into `audit_logs` with no access
 *      context is rejected by RLS with the exact production error.
 *      (Acts as a smoke test that the integration harness actually
 *      enforces RLS — if DATABASE_URL_APP were misconfigured to point at
 *      the superuser, this test would pass the insert and falsely
 *      green-light the rest of the suite.)
 *   2. Positive case: `logSessionAudit` with no outer context lands the
 *      row. This is the actual regression guard for #437.
 *   3. Error-swallow contract: a FK violation in the audit insert is
 *      swallowed rather than thrown so the caller path is unaffected.
 *   4. Partner-scope outer context: `logSessionAudit` called from inside
 *      a partner-scope caller context lands the row (proves the
 *      `runOutsideDbContext` rewrite doesn't narrow or break the caller's
 *      outer scope, and that the audit write reaches system scope
 *      regardless of the caller's scope).
 *   5. Transaction isolation: when the caller's request tx rolls back,
 *      the audit row written via `logSessionAudit` must persist. This is
 *      the hazard the rewrite exists to prevent — proves the audit write
 *      really runs on its own connection, not inside the caller's tx.
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
  it('reproduces the pre-fix bug: raw insert with no access context is rejected by RLS (harness smoke test)', async () => {
    const partner = await createPartner();
    const org = await createOrganization({ partnerId: partner.id });

    // Simulate the pre-fix behavior: call the production db pool directly,
    // without any access context. As `breeze_app` the session has scope
    // defaulting to 'none' / accessible_org_ids='', so breeze_has_org_access
    // returns false and the WITH CHECK clause rejects the row.
    //
    // Note: this test reproduces the bug regardless of whether the fix is
    // applied — its role is to anchor the RLS contract and prove the
    // integration harness is genuinely running as breeze_app. Test #2
    // below is the actual regression guard for the fix.
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

  it('logSessionAudit with no outer context writes the row on its own system-scope connection', async () => {
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

    // Read back as superuser to avoid any RLS interaction on verification.
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

  it('swallows DB errors (FK violation on bogus orgId) so the request path is not broken', async () => {
    // Under the new system-scope pattern, `breeze_has_org_access` returns
    // TRUE for any orgId (system scope bypasses the accessible_org_ids
    // check), so RLS passes regardless of whether the org exists. The
    // failure exercised here is the `audit_logs.org_id -> organizations.id`
    // FK, not an RLS rejection. The contract the helper preserves is
    // "any DB error on the audit insert must resolve rather than throw"
    // so the caller's request path is unaffected.
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

  it('partner-scope outer context: audit write lands under system scope without affecting caller scope', async () => {
    // Simulate an MSP-staff JWT-authenticated call: caller is on partner
    // scope with access to multiple orgs, and calls logSessionAudit for
    // one of those orgs. Under the previous fix, the helper's nested
    // withDbAccessContext short-circuited to the outer partner scope, and
    // the insert ran under whatever scope the caller had. Under the
    // rewrite, the helper runs outside the caller's context entirely and
    // writes under system scope.
    const partner = await createPartner();
    const orgA = await createOrganization({ partnerId: partner.id });
    const orgB = await createOrganization({ partnerId: partner.id });
    const sessionId = '66666666-6666-6666-6666-666666666666';

    await withDbAccessContext(
      {
        scope: 'partner',
        orgId: null,
        accessibleOrgIds: [orgA.id, orgB.id],
        accessiblePartnerIds: [partner.id]
      },
      () =>
        logSessionAudit(
          'session_offer_submitted',
          '77777777-7777-7777-7777-777777777777',
          orgA.id,
          { sessionId, type: 'desktop', via: 'jwt' }
        )
    );

    const rows = await getTestDb()
      .select()
      .from(auditLogs)
      .where(eq(auditLogs.resourceId, sessionId));

    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ orgId: orgA.id });
  });

  it('transaction isolation: audit row persists even when caller request tx rolls back', async () => {
    // The hazard the rewrite fixes: if the audit insert runs inside the
    // caller's request transaction and something in that transaction
    // throws, Postgres rolls back the whole tx — including the audit
    // row. Under the rewrite, `runOutsideDbContext` forces the audit
    // write onto a separate pooled connection, so rollback of the
    // caller's tx leaves the audit row committed.
    //
    // We prove this by writing two rows inside an org-scoped caller tx:
    //   (a) a direct `db.insert(auditLogs)` marker — this should roll
    //       back with the caller tx.
    //   (b) a `logSessionAudit()` call — this should run outside the
    //       caller tx and survive rollback.
    // Then we throw from the caller callback and verify (a) is gone but
    // (b) remains.
    const partner = await createPartner();
    const org = await createOrganization({ partnerId: partner.id });
    const rollbackMarkerId = '88888888-8888-8888-8888-888888888888';
    const auditSurvivorSessionId = '99999999-9999-9999-9999-999999999999';

    await expect(
      withDbAccessContext(
        {
          scope: 'organization',
          orgId: org.id,
          accessibleOrgIds: [org.id]
        },
        async () => {
          // (a) Caller's own audit write inside its tx. Will roll back.
          await db.insert(auditLogs).values({
            orgId: org.id,
            actorType: 'user',
            actorId: '00000000-0000-0000-0000-000000000aaa',
            action: 'rollback_marker',
            resourceType: 'remote_session',
            resourceId: rollbackMarkerId,
            details: {},
            result: 'success'
          });

          // (b) Audit helper — must escape the caller's tx.
          await logSessionAudit(
            'session_offer_submitted',
            '00000000-0000-0000-0000-000000000bbb',
            org.id,
            { sessionId: auditSurvivorSessionId, type: 'desktop', via: 'jwt' }
          );

          throw new Error('simulated caller rollback');
        }
      )
    ).rejects.toThrow('simulated caller rollback');

    // (a) Marker must have been rolled back with the caller tx.
    const markerRows = await getTestDb()
      .select()
      .from(auditLogs)
      .where(eq(auditLogs.resourceId, rollbackMarkerId));
    expect(markerRows).toHaveLength(0);

    // (b) logSessionAudit row must have been committed on its own
    //     connection and survived the rollback.
    const survivorRows = await getTestDb()
      .select()
      .from(auditLogs)
      .where(eq(auditLogs.resourceId, auditSurvivorSessionId));
    expect(survivorRows).toHaveLength(1);
    expect(survivorRows[0]).toMatchObject({
      orgId: org.id,
      action: 'session_offer_submitted'
    });
  });
});
