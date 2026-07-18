import './setup';
import { describe, expect, it, vi } from 'vitest';
import { canonicalGrantKey, M365_PERMISSION_PROFILES } from '@breeze/shared/m365';
import { and, eq, sql } from 'drizzle-orm';
import { db, withSystemDbAccessContext } from '../../db';
import { m365Connections, m365ConsentSessions } from '../../db/schema';
import { consumeConsentSession } from '../../services/m365ControlPlane/consentSessionService';
import {
  disconnectCustomerGraphReadConnection,
  initiateCustomerGraphReadConsent,
  loadRetestSnapshot,
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
      permissionManifestVersion: 2,
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
      permissionManifestVersion: 2,
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
      permissionManifestVersion: 2,
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
      permissionManifestVersion: 2,
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
    })).resolves.toBeNull();
    await expect(consumeConsentSession({
      rawState: usable!.rawState,
      phase: 'admin_consent',
      connectionId: usable!.connection.id,
      orgId: owner.orgId,
      consentAttemptId: usable!.connection.consentAttemptId,
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
    })).resolves.toMatchObject({
      connectionId: original.connection.id,
      consentAttemptId: original.connection.consentAttemptId,
    });
  });
});
