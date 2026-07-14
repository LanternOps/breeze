import './setup';
import { describe, expect, it, vi } from 'vitest';
import { and, eq, sql } from 'drizzle-orm';
import { db, withSystemDbAccessContext } from '../../db';
import { m365Connections, m365ConsentSessions } from '../../db/schema';
import { consumeConsentSession } from '../../services/m365ControlPlane/consentSessionService';
import { initiateCustomerGraphReadConsent } from '../../services/m365ControlPlane/connectionService';
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
