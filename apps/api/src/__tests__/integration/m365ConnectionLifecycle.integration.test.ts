import './setup';
import { describe, expect, it, vi } from 'vitest';
import { canonicalGrantKey, M365_PERMISSION_PROFILES } from '@breeze/shared/m365';
import { and, eq, sql } from 'drizzle-orm';
import { db, withSystemDbAccessContext } from '../../db';
import { m365Connections, m365ConsentSessions } from '../../db/schema';
import { consumeConsentSession } from '../../services/m365ControlPlane/consentSessionService';
import {
  applyUpgradeVerificationResult,
  disconnectCustomerGraphReadConnection,
  initiateCustomerGraphReadConsent,
  initiateCustomerGraphReadUpgradeConsent,
  loadRetestSnapshot,
  retestCustomerGraphReadConnection,
} from '../../services/m365ControlPlane/connectionService';
import { createOrganization, createPartner, createUser } from './db-utils';
import { getTestDb } from './setup';

vi.mock('../../services/m365ControlPlane/runtimeConfig', () => ({
  loadM365CustomerGraphReadRuntimeConfig: vi.fn(() => ({
    clientId: '55555555-5555-4555-8555-555555555555',
    vaultRef: 'akv://vault.example/m365-customer-graph-read/0123456789abcdef0123456789abcdef',
    credentialVersion: '0123456789abcdef0123456789abcdef',
    callbackUrl: 'https://console.example.test/api/v1/m365/consent/callback',
    executorUrl: 'https://executor.internal.example.test',
    executorAudience: 'm365-graph-read-executor',
    executorSigningPrivateJwk: {},
    executorSigningKid: 'key-1',
    onboardingOrgIds: '*',
  })),
}));

const runDb = it.runIf(!!process.env.DATABASE_URL);
const FAIL_TRIGGER = 'm365_connection_lifecycle_fail_session_insert';
const FAIL_FUNCTION = 'm365_connection_lifecycle_fail_session_insert_fn';

async function ownerFixture() {
  return withSystemDbAccessContext(async () => {
    const partner = await createPartner();
    const org = await createOrganization({ partnerId: partner.id });
    const user = await createUser({
      partnerId: partner.id,
      orgId: org.id,
      email: `m365-lifecycle-${Date.now()}-${crypto.randomUUID()}@example.com`,
    });
    return { orgId: org.id, actorId: user.id };
  });
}

async function currentConnection(orgId: string) {
  return withSystemDbAccessContext(async () => {
    const rows = await db.select().from(m365Connections).where(and(
      eq(m365Connections.orgId, orgId),
      eq(m365Connections.profile, 'customer-graph-read'),
    ));
    return rows[0];
  });
}

async function installFailingSessionTrigger() {
  const admin = getTestDb();
  await admin.execute(sql.raw(`
    CREATE OR REPLACE FUNCTION public.${FAIL_FUNCTION}()
    RETURNS trigger
    LANGUAGE plpgsql
    AS $function$
    BEGIN
      RAISE EXCEPTION 'forced lifecycle session insert failure';
    END;
    $function$;
  `));
  await admin.execute(sql.raw(`
    CREATE TRIGGER ${FAIL_TRIGGER}
    BEFORE INSERT ON m365_consent_sessions
    FOR EACH ROW EXECUTE FUNCTION public.${FAIL_FUNCTION}();
  `));
}

async function removeFailingSessionTrigger() {
  const admin = getTestDb();
  await admin.execute(sql.raw(
    `DROP TRIGGER IF EXISTS ${FAIL_TRIGGER} ON m365_consent_sessions;`,
  ));
  await admin.execute(sql.raw(`DROP FUNCTION IF EXISTS public.${FAIL_FUNCTION}();`));
}

describe('customer Graph-read lifecycle transaction integration', () => {
  runDb('disconnect commits a clean revocation while preserving a valid manifest and releasing tenant ownership', async () => {
    const owner = await ownerFixture();
    const initiated = await initiateCustomerGraphReadConsent({
      orgId: owner.orgId,
      actorId: owner.actorId,
    });
    const tenantId = crypto.randomUUID();
    const verifiedAt = new Date('2026-07-14T16:00:00.000Z');
    const requiredGrants = [...M365_PERMISSION_PROFILES['customer-graph-read'].applicationPermissionAssignments]
      .sort((left, right) => canonicalGrantKey(left).localeCompare(canonicalGrantKey(right)));
    await withSystemDbAccessContext(() => db.update(m365Connections).set({
      tenantId,
      displayName: 'Contoso',
      permissionManifestVersion: 3,
      observedGrants: requiredGrants,
      grantsVerifiedAt: verifiedAt,
      lastVerifiedAt: verifiedAt,
      consentedAt: verifiedAt,
      expiresAt: new Date('2027-07-14T16:00:00.000Z'),
      status: 'active',
      lastErrorCode: 'old-error',
    }).where(eq(m365Connections.id, initiated.connection.id)));

    await expect(disconnectCustomerGraphReadConnection({
      id: initiated.connection.id,
      orgId: owner.orgId,
      actorId: owner.actorId,
    })).resolves.toMatchObject({
      tenantId: null,
      clientId: '',
      displayName: null,
      permissionManifestVersion: 3,
      observedGrants: [],
      grantsVerifiedAt: null,
      lastVerifiedAt: null,
      status: 'revoked',
      lastErrorCode: null,
    });

    const revoked = await currentConnection(owner.orgId);
    expect(revoked).toMatchObject({
      tenantId: null,
      clientId: '',
      displayName: null,
      permissionManifestVersion: 3,
      observedGrants: [],
      grantsVerifiedAt: null,
      lastVerifiedAt: null,
      consentedAt: null,
      expiresAt: null,
      status: 'revoked',
      lastErrorCode: null,
    });
    const sessions = await withSystemDbAccessContext(() => db.select()
      .from(m365ConsentSessions)
      .where(eq(m365ConsentSessions.connectionId, initiated.connection.id)));
    expect(sessions).toEqual([]);

    await expect(loadRetestSnapshot({
      id: initiated.connection.id,
      orgId: owner.orgId,
      auth: {
        scope: 'organization',
        orgId: owner.orgId,
        accessibleOrgIds: [owner.orgId],
        partnerId: null,
        user: { id: owner.actorId },
      } as never,
    })).rejects.toMatchObject({ code: 'connection_not_found' });

    const secondOwner = await ownerFixture();
    await expect(withSystemDbAccessContext(() => db.insert(m365Connections).values({
      orgId: secondOwner.orgId,
      userId: null,
      tenantId,
      clientId: '55555555-5555-4555-8555-555555555555',
      clientSecret: null,
      profile: 'customer-graph-read',
      authMode: 'application-certificate',
      credentialDomain: 'customer-graph-read',
      vaultRef: 'akv://vault.example/m365-customer-graph-read/0123456789abcdef0123456789abcdef',
      credentialVersion: '0123456789abcdef0123456789abcdef',
      permissionManifestVersion: 3,
      observedGrants: requiredGrants,
      consentAttemptId: crypto.randomUUID(),
      grantsVerifiedAt: verifiedAt,
      displayName: 'Fabrikam',
      status: 'active',
      consentedAt: verifiedAt,
      lastVerifiedAt: verifiedAt,
      createdBy: secondOwner.actorId,
    }).returning())).resolves.toHaveLength(1);
  });

  runDb('serializes concurrent initiations and leaves exactly the current attempt state usable', async () => {
    const owner = await ownerFixture();

    const returned = await Promise.all([
      initiateCustomerGraphReadConsent({ orgId: owner.orgId, actorId: owner.actorId }),
      initiateCustomerGraphReadConsent({ orgId: owner.orgId, actorId: owner.actorId }),
    ]);
    const current = await currentConnection(owner.orgId);
    expect(current?.status).toBe('pending-consent');
    expect(current?.consentAttemptId).toBeTruthy();

    const usable = returned.find(
      (candidate) => candidate.connection.consentAttemptId === current!.consentAttemptId,
    );
    const stale = returned.find(
      (candidate) => candidate.connection.consentAttemptId !== current!.consentAttemptId,
    );
    expect(usable).toBeDefined();
    expect(stale).toBeDefined();

    await expect(consumeConsentSession({
      rawState: stale!.rawState,
      phase: 'admin_consent',
      connectionId: stale!.connection.id,
      orgId: owner.orgId,
      consentAttemptId: stale!.connection.consentAttemptId,
      profile: 'customer-graph-read',
    })).resolves.toBeNull();
    await expect(consumeConsentSession({
      rawState: usable!.rawState,
      phase: 'admin_consent',
      connectionId: usable!.connection.id,
      orgId: owner.orgId,
      consentAttemptId: usable!.connection.consentAttemptId,
      profile: 'customer-graph-read',
    })).resolves.toMatchObject({
      connectionId: usable!.connection.id,
      consentAttemptId: usable!.connection.consentAttemptId,
    });
  });

  runDb('rolls back session deletion and attempt rotation when the final session insert fails', async () => {
    const owner = await ownerFixture();
    const original = await initiateCustomerGraphReadConsent({
      orgId: owner.orgId,
      actorId: owner.actorId,
    });
    await installFailingSessionTrigger();
    try {
      await expect(initiateCustomerGraphReadConsent({
        orgId: owner.orgId,
        actorId: owner.actorId,
      })).rejects.toBeDefined();

      const afterFailure = await currentConnection(owner.orgId);
      expect(afterFailure).toMatchObject({
        id: original.connection.id,
        consentAttemptId: original.connection.consentAttemptId,
        status: 'pending-consent',
      });
      const sessions = await withSystemDbAccessContext(() => db.select({
        connectionId: m365ConsentSessions.connectionId,
        consentAttemptId: m365ConsentSessions.consentAttemptId,
      }).from(m365ConsentSessions).where(eq(
        m365ConsentSessions.connectionId,
        original.connection.id,
      )));
      expect(sessions).toEqual([{
        connectionId: original.connection.id,
        consentAttemptId: original.connection.consentAttemptId,
      }]);
    } finally {
      await removeFailingSessionTrigger();
    }

    await expect(consumeConsentSession({
      rawState: original.rawState,
      phase: 'admin_consent',
      connectionId: original.connection.id,
      orgId: owner.orgId,
      consentAttemptId: original.connection.consentAttemptId,
      profile: 'customer-graph-read',
    })).resolves.toMatchObject({
      connectionId: original.connection.id,
      consentAttemptId: original.connection.consentAttemptId,
    });
  });
});


describe('customer Graph-read upgrade consent integration', () => {
  function authContextFor(fixture: { orgId: string; actorId: string }) {
    return {
      scope: 'organization',
      orgId: fixture.orgId,
      accessibleOrgIds: [fixture.orgId],
      partnerId: null,
      user: { id: fixture.actorId },
    } as never;
  }

  async function executableConnection() {
    const owner = await ownerFixture();
    const initiated = await initiateCustomerGraphReadConsent({
      orgId: owner.orgId,
      actorId: owner.actorId,
    });
    const tenantId = crypto.randomUUID();
    const verifiedAt = new Date('2026-09-01T16:00:00.000Z');
    await withSystemDbAccessContext(() => db.update(m365Connections).set({
      tenantId,
      displayName: 'Contoso',
      permissionManifestVersion: 2,
      observedGrants: [],
      grantsVerifiedAt: verifiedAt,
      lastVerifiedAt: verifiedAt,
      consentedAt: verifiedAt,
      status: 'active',
      lastErrorCode: null,
    }).where(eq(m365Connections.id, initiated.connection.id)));
    return { ...owner, connectionId: initiated.connection.id, tenantId };
  }

  runDb('binds an upgrade session to the existing attempt and leaves the connection active', async () => {
    const fixture = await executableConnection();
    const before = await currentConnection(fixture.orgId);

    const initiated = await initiateCustomerGraphReadUpgradeConsent({
      connectionId: fixture.connectionId,
      orgId: fixture.orgId,
      auth: authContextFor(fixture),
    });

    const after = await currentConnection(fixture.orgId);
    expect(after?.status).toBe('active');
    expect(after?.consentAttemptId).toBe(before?.consentAttemptId);
    expect(after?.permissionManifestVersion).toBe(2);

    const sessions = await withSystemDbAccessContext(() => db.select()
      .from(m365ConsentSessions)
      .where(eq(m365ConsentSessions.connectionId, fixture.connectionId)));
    expect(sessions).toHaveLength(1);
    expect(sessions[0]!.purpose).toBe('upgrade');
    expect(sessions[0]!.consentAttemptId).toBe(before?.consentAttemptId);
    expect(initiated.consentUrl).toContain('adminconsent');
  });

  runDb('rejects a purpose outside the two legal values', async () => {
    const fixture = await executableConnection();
    const conn = await currentConnection(fixture.orgId);

    // Drizzle wraps the driver error as "Failed query: …" and hangs the real
    // PostgresError off `cause`, so assert on the constraint name there rather
    // than on the outer message.
    const rejection = await withSystemDbAccessContext(() => db.execute(sql`
      INSERT INTO m365_consent_sessions
        (state_hash, phase, purpose, connection_id, org_id, profile, consent_attempt_id, user_id, expires_at)
      VALUES (
        ${'f'.repeat(64)}, 'admin_consent', 'sideways', ${conn!.id}, ${fixture.orgId},
        'customer-graph-read', ${conn!.consentAttemptId}, ${fixture.actorId}, now() + interval '10 minutes'
      )
    `)).then(() => null, (error: unknown) => error);
    expect(rejection).not.toBeNull();
    const cause = (rejection as { cause?: { code?: string; constraint_name?: string } }).cause;
    expect(cause?.code).toBe('23514');
    expect(cause?.constraint_name).toBe('m365_consent_sessions_purpose_check');
  });

  runDb('promotes the manifest in place and bumps the consent generation on a full approval', async () => {
    const fixture = await executableConnection();
    await initiateCustomerGraphReadUpgradeConsent({
      connectionId: fixture.connectionId,
      orgId: fixture.orgId,
      auth: authContextFor(fixture),
    });
    const conn = await currentConnection(fixture.orgId);
    const manifest = M365_PERMISSION_PROFILES['customer-graph-read'];

    const applied = await applyUpgradeVerificationResult({
      id: conn!.id,
      orgId: fixture.orgId,
      profile: 'customer-graph-read',
      consentAttemptId: conn!.consentAttemptId!,
      status: 'active',
    }, {
      success: true,
      tenantId: fixture.tenantId,
      applicationId: '55555555-5555-4555-8555-555555555555',
      organizationDisplayName: 'Contoso',
      manifestVersion: manifest.version,
      verifiedAt: '2026-09-08T10:00:00.000Z',
      grantReconciliation: 'complete',
      grantsVerifiedAt: '2026-09-08T10:00:01.000Z',
      // The DB CHECK breeze_m365_observed_grants_are_canonical requires
      // (resourceApplicationId, appRoleId) order; the manifest is listed
      // alphabetically by scope value, and the executor canonicalises what it
      // returns, so the fixture has to do the same.
      observedGrants: [...(manifest.applicationPermissionAssignments ?? [])]
        .sort((left, right) => canonicalGrantKey(left).localeCompare(canonicalGrantKey(right))),
    } as never);

    expect(applied.failureCode).toBeNull();
    expect(applied.connection.permissionManifestVersion).toBe(manifest.version);
    expect(applied.connection.status).toBe('active');
    const after = await currentConnection(fixture.orgId);
    expect(after?.consentGeneration).toBe((conn?.consentGeneration ?? 0) + 1);
  });

  runDb('leaves an abandoned upgrade executing on the old manifest', async () => {
    const fixture = await executableConnection();
    await initiateCustomerGraphReadUpgradeConsent({
      connectionId: fixture.connectionId,
      orgId: fixture.orgId,
      auth: authContextFor(fixture),
    });
    const conn = await currentConnection(fixture.orgId);

    const applied = await applyUpgradeVerificationResult({
      id: conn!.id,
      orgId: fixture.orgId,
      profile: 'customer-graph-read',
      consentAttemptId: conn!.consentAttemptId!,
      status: 'active',
    }, { success: false, errorCode: 'consent_cancelled' } as never);

    expect(applied.failureCode).toBe('consent_cancelled');
    const after = await currentConnection(fixture.orgId);
    expect(after?.status).toBe('active');
    expect(after?.permissionManifestVersion).toBe(2);
    expect(after?.consentGeneration).toBe(conn?.consentGeneration);
    expect(after?.lastVerifiedAt).toEqual(conn?.lastVerifiedAt);
  });

  runDb('lets a retest rotate the attempt while an upgrade session is live', async () => {
    // Before the retest fix this raised 23503: the consent-session composite
    // FK has ON DELETE CASCADE but no ON UPDATE CASCADE.
    const fixture = await executableConnection();
    await initiateCustomerGraphReadUpgradeConsent({
      connectionId: fixture.connectionId,
      orgId: fixture.orgId,
      auth: authContextFor(fixture),
    });

    await expect(retestCustomerGraphReadConnection({
      id: fixture.connectionId,
      orgId: fixture.orgId,
      auth: authContextFor(fixture),
      executorClient: {
        retestCustomerGraphRead: async () => ({ success: false, errorCode: 'credential_unavailable' }),
      } as never,
    })).resolves.toBeDefined();

    const sessions = await withSystemDbAccessContext(() => db.select()
      .from(m365ConsentSessions)
      .where(eq(m365ConsentSessions.connectionId, fixture.connectionId)));
    expect(sessions).toHaveLength(0);
  });
});
