/**
 * Real-Postgres proof that the customer-graph-read disconnect and the synced
 * tenant erasure are ONE transaction (spec §5.8): a clean disconnect revokes
 * the connection and erases state + entity rows; an erasure that fails
 * part-way rolls the status flip back too, so a "disconnected" connection can
 * never leave a customer's directory behind. A mocked DB cannot show this —
 * only Postgres can prove the rollback.
 */
import './setup';
import { randomUUID } from 'node:crypto';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { eq } from 'drizzle-orm';

const { failAfterErase } = vi.hoisted(() => ({ failAfterErase: { on: false } }));

vi.mock('../../services/m365Sync/lifecycle', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../services/m365Sync/lifecycle')>();
  return {
    ...actual,
    // Run the REAL erasure, then fail — the harshest case: every delete has
    // already executed inside the transaction when the throw lands.
    onConnectionDisconnected: async (conn: { id: string; orgId: string }) => {
      await actual.onConnectionDisconnected(conn);
      if (failAfterErase.on) throw new Error('erasure failed late');
    },
  };
});

import { db, withSystemDbAccessContext } from '../../db';
import { m365Connections, m365SyncState, m365Users } from '../../db/schema';
import { disconnectCustomerGraphReadConnection } from '../../services/m365ControlPlane/connectionService';
import { createOrganization, createPartner } from './db-utils';

const runDb = it.runIf(!!process.env.DATABASE_URL);

let orgId: string;
let connectionId: string;

beforeEach(async () => {
  failAfterErase.on = false;
  await withSystemDbAccessContext(async () => {
    const partner = await createPartner();
    const org = await createOrganization({ partnerId: partner.id });
    orgId = org.id;
    const credentialVersion = '0123456789abcdef0123456789abcdef';
    const [connection] = await db.insert(m365Connections).values({
      orgId, userId: null, tenantId: randomUUID(), clientId: randomUUID(), clientSecret: null,
      profile: 'customer-graph-read', authMode: 'application-certificate',
      credentialDomain: 'customer-graph-read',
      vaultRef: `akv://vault.example/m365-customer-graph-read-${orgId}/${credentialVersion}`,
      credentialVersion, permissionManifestVersion: 3, consentAttemptId: randomUUID(),
      consentGeneration: 2, status: 'active',
    }).returning({ id: m365Connections.id });
    connectionId = connection!.id;
    await db.insert(m365SyncState).values({ orgId, connectionId, domain: 'users', intervalSeconds: 21600 });
    await db.insert(m365Users).values({ orgId, graphId: 'u1', coreHash: 'f'.repeat(64) });
  });
});

async function snapshot() {
  return withSystemDbAccessContext(async () => ({
    status: (await db.select({ status: m365Connections.status }).from(m365Connections)
      .where(eq(m365Connections.id, connectionId)))[0]?.status,
    state: (await db.select().from(m365SyncState).where(eq(m365SyncState.orgId, orgId))).length,
    users: (await db.select().from(m365Users).where(eq(m365Users.orgId, orgId))).length,
  }));
}

describe('customer-graph-read disconnect + sync erasure atomicity (real Postgres)', () => {
  runDb('a clean disconnect revokes the connection and erases the synced snapshot', async () => {
    await disconnectCustomerGraphReadConnection({ id: connectionId, orgId, actorId: randomUUID() });
    expect(await snapshot()).toEqual({ status: 'revoked', state: 0, users: 0 });
  });

  runDb('an erasure failure rolls back the status flip AND the deletes — nothing half-happens', async () => {
    failAfterErase.on = true;
    await expect(disconnectCustomerGraphReadConnection({ id: connectionId, orgId, actorId: randomUUID() }))
      .rejects.toThrow('erasure failed late');
    expect(await snapshot()).toEqual({ status: 'active', state: 1, users: 1 });
  });
});
