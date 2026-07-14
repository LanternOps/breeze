import './setup';
import { createHash } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { eq, sql } from 'drizzle-orm';
import {
  db,
  withDbAccessContext,
  withSystemDbAccessContext,
  type DbAccessContext,
} from '../../db';
import { m365Connections, m365ConsentSessions } from '../../db/schema';
import { createOrganization, createPartner, createUser } from './db-utils';
import { transitionAdminConsentToIdentity } from '../../services/m365ControlPlane/connectionService';
import { hashTenantHint } from '../../services/m365ControlPlane/consentSessionService';

const runDb = it.runIf(!!process.env.DATABASE_URL);
const tenantId = '11111111-1111-4111-8111-111111111111';
const consentAttemptId = '22222222-2222-4222-8222-222222222222';
const credentialVersion = '0123456789abcdef0123456789abcdef';

async function seedFixture() {
  return withSystemDbAccessContext(async () => {
    const partner = await createPartner();
    const org = await createOrganization({ partnerId: partner.id });
    const user = await createUser({
      partnerId: partner.id,
      orgId: org.id,
      email: `m365-consent-rls-${Date.now()}@example.com`,
    });
    const [connection] = await db.insert(m365Connections).values({
      orgId: org.id,
      userId: null,
      tenantId,
      consentAttemptId,
      clientId: '33333333-3333-4333-8333-333333333333',
      clientSecret: null,
      profile: 'customer-graph-read',
      authMode: 'application-certificate',
      credentialDomain: 'customer-graph-read',
      vaultRef: `akv://vault.example/graph-read/${credentialVersion}`,
      credentialVersion,
      permissionManifestVersion: 2,
      observedGrants: [],
      status: 'pending-consent',
    }).returning({ id: m365Connections.id });
    const [session] = await db.insert(m365ConsentSessions).values({
      stateHash: 'a'.repeat(64),
      phase: 'admin_consent',
      connectionId: connection!.id,
      orgId: org.id,
      profile: 'customer-graph-read',
      consentAttemptId,
      userId: user.id,
      expiresAt: new Date(Date.now() + 300_000),
    }).returning({ id: m365ConsentSessions.id });

    const contexts: Array<[string, DbAccessContext]> = [
      ['organization', {
        scope: 'organization', orgId: org.id, accessibleOrgIds: [org.id],
        accessiblePartnerIds: [], userId: user.id,
      }],
      ['partner', {
        scope: 'partner', orgId: null, accessibleOrgIds: [org.id],
        accessiblePartnerIds: [partner.id], userId: user.id,
      }],
      ['user-only', {
        scope: 'organization', orgId: null, accessibleOrgIds: [],
        accessiblePartnerIds: [], userId: user.id,
      }],
    ];
    return { org, user, connection: connection!, session: session!, contexts };
  });
}

describe('m365_consent_sessions forced system-only RLS', () => {
  runDb('runs as the real breeze_app role without BYPASSRLS', async () => {
    const fx = await seedFixture();
    const rows = await withDbAccessContext(fx.contexts[0]![1], () =>
      db.execute(sql`SELECT current_user AS who, rolbypassrls FROM pg_roles WHERE rolname = current_user`));
    expect((rows as unknown as Array<{ who: string; rolbypassrls: boolean }>)[0])
      .toEqual({ who: 'breeze_app', rolbypassrls: false });
  });

  runDb('blocks organization, partner, and user-only CRUD', async () => {
    const fx = await seedFixture();
    for (const [scope, context] of fx.contexts) {
      const selected = await withDbAccessContext(context, () => db.select({ id: m365ConsentSessions.id })
        .from(m365ConsentSessions)
        .where(eq(m365ConsentSessions.id, fx.session.id)));
      expect(selected, `${scope} SELECT`).toEqual([]);

      await expect(withDbAccessContext(context, () => db.insert(m365ConsentSessions).values({
        stateHash: scope.padEnd(64, 'b'),
        phase: 'admin_consent',
        connectionId: fx.connection.id,
        orgId: fx.org.id,
        profile: 'customer-graph-read',
        consentAttemptId,
        userId: fx.user.id,
        expiresAt: new Date(Date.now() + 300_000),
      })), `${scope} INSERT`).rejects.toMatchObject({ cause: { code: '42501' } });

      const updated = await withDbAccessContext(context, () => db.update(m365ConsentSessions)
        .set({ expiresAt: new Date(Date.now() + 600_000) })
        .where(eq(m365ConsentSessions.id, fx.session.id))
        .returning({ id: m365ConsentSessions.id }));
      expect(updated, `${scope} UPDATE`).toEqual([]);

      const deleted = await withDbAccessContext(context, () => db.delete(m365ConsentSessions)
        .where(eq(m365ConsentSessions.id, fx.session.id))
        .returning({ id: m365ConsentSessions.id }));
      expect(deleted, `${scope} DELETE`).toEqual([]);
    }
  });

  runDb('allows system CRUD and cascades sessions on connection delete', async () => {
    const fx = await seedFixture();
    const selected = await withSystemDbAccessContext(() => db.select({ id: m365ConsentSessions.id })
      .from(m365ConsentSessions)
      .where(eq(m365ConsentSessions.id, fx.session.id)));
    expect(selected).toEqual([{ id: fx.session.id }]);

    const updated = await withSystemDbAccessContext(() => db.update(m365ConsentSessions)
      .set({ expiresAt: new Date(Date.now() + 600_000) })
      .where(eq(m365ConsentSessions.id, fx.session.id))
      .returning({ id: m365ConsentSessions.id }));
    expect(updated).toEqual([{ id: fx.session.id }]);

    await withSystemDbAccessContext(() => db.delete(m365Connections)
      .where(eq(m365Connections.id, fx.connection.id)));
    const afterCascade = await withSystemDbAccessContext(() => db.select({ id: m365ConsentSessions.id })
      .from(m365ConsentSessions)
      .where(eq(m365ConsentSessions.id, fx.session.id)));
    expect(afterCascade).toEqual([]);
  });

  runDb('enforces phase-specific secret fields', async () => {
    const fx = await seedFixture();
    await expect(withSystemDbAccessContext(() => db.insert(m365ConsentSessions).values({
      stateHash: 'c'.repeat(64),
      phase: 'identity_verification',
      connectionId: fx.connection.id,
      orgId: fx.org.id,
      profile: 'customer-graph-read',
      consentAttemptId,
      userId: fx.user.id,
      expiresAt: new Date(Date.now() + 300_000),
    }))).rejects.toMatchObject({ cause: { code: '23514' } });
  });

  runDb('rejects a session whose consent attempt does not match the connection', async () => {
    const fx = await seedFixture();
    await expect(withSystemDbAccessContext(() => db.insert(m365ConsentSessions).values({
      stateHash: 'd'.repeat(64),
      phase: 'admin_consent',
      connectionId: fx.connection.id,
      orgId: fx.org.id,
      profile: 'customer-graph-read',
      consentAttemptId: '99999999-9999-4999-8999-999999999999',
      userId: fx.user.id,
      expiresAt: new Date(Date.now() + 300_000),
    }))).rejects.toMatchObject({ cause: { code: '23503' } });
  });

  runDb('rolls back admin consume and verifying CAS when prepared identity insertion fails', async () => {
    const fx = await seedFixture();
    const adminRawState = 'real-admin-state';
    const identityRawState = 'prepared-identity-state';
    const sha256 = (value: string) => createHash('sha256').update(value).digest('hex');

    await withSystemDbAccessContext(async () => {
      await db.update(m365ConsentSessions).set({ stateHash: sha256(adminRawState) })
        .where(eq(m365ConsentSessions.id, fx.session.id));
      await db.insert(m365ConsentSessions).values({
        stateHash: sha256(identityRawState),
        phase: 'admin_consent',
        connectionId: fx.connection.id,
        orgId: fx.org.id,
        profile: 'customer-graph-read',
        consentAttemptId,
        userId: fx.user.id,
        expiresAt: new Date(Date.now() + 300_000),
      });
    });

    await expect(transitionAdminConsentToIdentity({
      attempt: {
        id: fx.connection.id,
        orgId: fx.org.id,
        profile: 'customer-graph-read',
        consentAttemptId,
        status: 'pending-consent',
      },
      rawAdminState: adminRawState,
      prepared: {
        rawState: identityRawState,
        tenantHintHash: hashTenantHint(tenantId),
        nonce: 'n'.repeat(43),
        codeVerifier: 'v'.repeat(43),
        codeChallenge: 'c'.repeat(43),
        expiresAt: new Date(Date.now() + 600_000),
      },
    })).rejects.toThrow('m365_consent_state_collision');

    const after = await withSystemDbAccessContext(async () => ({
      connection: await db.select({ status: m365Connections.status })
        .from(m365Connections).where(eq(m365Connections.id, fx.connection.id)),
      sessions: await db.select({
        stateHash: m365ConsentSessions.stateHash,
        phase: m365ConsentSessions.phase,
      }).from(m365ConsentSessions).where(eq(m365ConsentSessions.connectionId, fx.connection.id)),
    }));
    expect(after.connection).toEqual([{ status: 'pending-consent' }]);
    expect(after.sessions).toEqual(expect.arrayContaining([
      { stateHash: sha256(adminRawState), phase: 'admin_consent' },
      { stateHash: sha256(identityRawState), phase: 'admin_consent' },
    ]));
    expect(after.sessions).not.toContainEqual(expect.objectContaining({ phase: 'identity_verification' }));
  });
});
