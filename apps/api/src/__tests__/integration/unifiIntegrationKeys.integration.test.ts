/**
 * Real-PostgreSQL contract for `unifi_integration_keys` (#11808 W1, #12276).
 *
 * The table holds one encrypted UniFi Site Manager API key per row, on the
 * partner axis (RLS shape 3), with a composite FK to its integration. The
 * migration that creates it copies each cloud integration's key verbatim
 * (ciphertext byte for byte, same column-bound AAD tag).
 *
 * Seeding runs on the superuser test client; every assertion about what the
 * app can see or write runs through the production `db` pool as the
 * non-BYPASSRLS `breeze_app` role. The migration re-run uses `replayMigration`
 * on the superuser client, as autoMigrate would.
 */
import './setup';
import { describe, expect, it } from 'vitest';
import { eq, sql } from 'drizzle-orm';
import { db, withDbAccessContext, withSystemDbAccessContext, type DbAccessContext } from '../../db';
import { unifiIntegrationKeys, unifiIntegrations } from '../../db/schema';
import { columnAad, UNIFI_KEY_COLUMN_SPEC } from '../../services/encryptedColumnRegistry';
import { decryptSecret, encryptSecret } from '../../services/secretCrypto';
import { createSelfHostedIntegration, upsertConnection, UnifiMultiKeyError } from '../../services/unifi/unifiConnectionService';
import { getSyncKeys, openUnifiKey, sealUnifiKey } from '../../services/unifi/unifiKeyService';
import { createPartner } from './db-utils';
import { replayMigration } from './replayMigration';
import { getTestDb } from './setup';

const runDb = it.runIf(!!process.env.DATABASE_URL);
const MIGRATION = '2027-01-29-140000-unifi-integration-keys.sql';
const LEGACY_AAD = 'unifi_integrations.api_key_encrypted';

function partnerContext(partnerId: string): DbAccessContext {
  return { scope: 'partner', orgId: null, accessibleOrgIds: [], accessiblePartnerIds: [partnerId], userId: null };
}

function sqlState(err: unknown): string | undefined {
  const e = err as { code?: string; cause?: { code?: string } } | undefined;
  return e?.cause?.code ?? e?.code;
}

async function seedIntegration(input: {
  partnerId: string;
  connectionType?: 'cloud' | 'self_hosted';
  apiKey?: string | null;
  accountLabel?: string | null;
  status?: string;
  lastSyncError?: string | null;
}): Promise<{ id: string; apiKeyEncrypted: string | null }> {
  const admin = getTestDb() as any;
  const apiKeyEncrypted = input.apiKey === null || input.connectionType === 'self_hosted'
    ? null
    : encryptSecret(input.apiKey ?? 'k-123', { aad: LEGACY_AAD });
  const [row] = await admin
    .insert(unifiIntegrations)
    .values({
      partnerId: input.partnerId,
      connectionType: input.connectionType ?? 'cloud',
      apiKeyEncrypted,
      accountLabel: input.accountLabel ?? null,
      status: input.status ?? 'connected',
      lastSyncError: input.lastSyncError ?? null,
    })
    .returning({ id: unifiIntegrations.id, apiKeyEncrypted: unifiIntegrations.apiKeyEncrypted });
  return row;
}

async function keysOf(integrationId: string) {
  return withSystemDbAccessContext(() =>
    db.select().from(unifiIntegrationKeys).where(eq(unifiIntegrationKeys.integrationId, integrationId)),
  );
}

describe('unifi_integration_keys migration backfill', () => {
  runDb('backfills one key per cloud integration with the ciphertext unchanged', async () => {
    const partner = await createPartner();
    const integration = await seedIntegration({ partnerId: partner.id, apiKey: 'k-123', accountLabel: 'Main' });

    await replayMigration(MIGRATION);
    await replayMigration(MIGRATION); // idempotent: a second run adds nothing

    const keys = await keysOf(integration.id);
    expect(keys).toHaveLength(1);
    const [key] = keys;
    expect(key!.label).toBe('Main');
    expect(key!.status).toBe('connected');
    expect(key!.partnerId).toBe(partner.id);
    expect(key!.isEnabled).toBe(true);
    expect(key!.keyLast4).toBeNull();
    expect(key!.lastSyncStatus).toBeNull();
    expect(key!.apiKeyEncrypted).toBe(integration.apiKeyEncrypted);
    expect(key!.apiKeyEncrypted).toMatch(/^enc:v3:/);
    expect(decryptSecret(key!.apiKeyEncrypted, { aad: columnAad(UNIFI_KEY_COLUMN_SPEC) })).toBe('k-123');
  });

  runDb("copies the parent's status to the backfilled key", async () => {
    const partner = await createPartner();
    const reauth = await seedIntegration({ partnerId: partner.id, status: 'reauth_required', lastSyncError: 'HTTP 401' });
    const partnerB = await createPartner();
    const errored = await seedIntegration({ partnerId: partnerB.id, status: 'error', lastSyncError: 'UniFi /v1/sites read failed' });
    const partnerC = await createPartner();
    const odd = await seedIntegration({ partnerId: partnerC.id, status: 'disabled' });

    await replayMigration(MIGRATION);

    const [reauthKey] = await keysOf(reauth.id);
    expect(reauthKey).toMatchObject({ status: 'reauth_required', lastSyncError: 'HTTP 401' });
    const [errorKey] = await keysOf(errored.id);
    expect(errorKey).toMatchObject({ status: 'error', lastSyncError: 'UniFi /v1/sites read failed' });
    const [oddKey] = await keysOf(odd.id);
    expect(oddKey!.status).toBe('pending');
  });

  runDb('labels a backfilled key Global when the account label is blank', async () => {
    const partner = await createPartner();
    const blank = await seedIntegration({ partnerId: partner.id, accountLabel: '  ' });
    const partnerB = await createPartner();
    const unlabelled = await seedIntegration({ partnerId: partnerB.id, accountLabel: null });

    await replayMigration(MIGRATION);

    expect((await keysOf(blank.id))[0]!.label).toBe('Global');
    expect((await keysOf(unlabelled.id))[0]!.label).toBe('Global');
  });

  // /connect accepts an accountLabel of up to 200 characters, but a key label is
  // capped at 100. An existing long label must not abort the migration on boot.
  runDb('clamps an account label longer than 100 characters', async () => {
    const partner = await createPartner();
    const long = `  ${'L'.repeat(150)}  `;
    const integration = await seedIntegration({ partnerId: partner.id, accountLabel: long });

    await expect(replayMigration(MIGRATION)).resolves.toBeUndefined();

    const [key] = await keysOf(integration.id);
    expect(key!.label).toBe('L'.repeat(100));
  });

  runDb('self-hosted integrations get no key row', async () => {
    const partner = await createPartner();
    const integration = await seedIntegration({ partnerId: partner.id, connectionType: 'self_hosted' });

    await replayMigration(MIGRATION);

    expect(await keysOf(integration.id)).toHaveLength(0);
  });

  runDb('a cloud integration may exist without a legacy key once the table holds the invariant', async () => {
    const partner = await createPartner();
    // unifi_integrations_cloud_key_chk is dropped by the migration.
    await expect(seedIntegration({ partnerId: partner.id, apiKey: null })).resolves.toBeDefined();
  });
});

describe('unifi_integration_keys constraints', () => {
  async function insertKey(ctx: DbAccessContext | 'system', values: { integrationId: string; partnerId: string; label: string }) {
    const write = () => db.insert(unifiIntegrationKeys).values({
      ...values,
      apiKeyEncrypted: encryptSecret('k-x', { aad: LEGACY_AAD })!,
    }).returning({ id: unifiIntegrationKeys.id });
    return ctx === 'system' ? withSystemDbAccessContext(write) : withDbAccessContext(ctx, write);
  }

  runDb('label unique ignoring case', async () => {
    const partner = await createPartner();
    const integration = await seedIntegration({ partnerId: partner.id, connectionType: 'self_hosted' });
    await insertKey(partnerContext(partner.id), { integrationId: integration.id, partnerId: partner.id, label: 'Macera' });

    let caught: unknown;
    try {
      await insertKey(partnerContext(partner.id), { integrationId: integration.id, partnerId: partner.id, label: 'macera ' });
    } catch (err) { caught = err; }
    expect(sqlState(caught)).toBe('23505');
  });

  runDb('a label must be 1-100 characters after trimming', async () => {
    const partner = await createPartner();
    const integration = await seedIntegration({ partnerId: partner.id, connectionType: 'self_hosted' });
    for (const label of ['   ', 'x'.repeat(101)]) {
      let caught: unknown;
      try {
        await insertKey('system', { integrationId: integration.id, partnerId: partner.id, label });
      } catch (err) { caught = err; }
      expect(sqlState(caught), JSON.stringify(label)).toBe('23514');
    }
  });

  runDb("the composite FK refuses a key whose partner_id is not its integration's", async () => {
    const partnerA = await createPartner();
    const partnerB = await createPartner();
    const integrationA = await seedIntegration({ partnerId: partnerA.id, connectionType: 'self_hosted' });
    const integrationB = await seedIntegration({ partnerId: partnerB.id, connectionType: 'self_hosted' });

    // A foreign partner_id on the caller's own integration.
    let foreignPartner: unknown;
    try {
      await insertKey('system', { integrationId: integrationA.id, partnerId: partnerB.id, label: 'Forged' });
    } catch (err) { foreignPartner = err; }
    expect(sqlState(foreignPartner)).toBe('23503');

    // The caller's own partner_id paired with another partner's integration.
    let foreignIntegration: unknown;
    try {
      await insertKey(partnerContext(partnerA.id), { integrationId: integrationB.id, partnerId: partnerA.id, label: 'Forged' });
    } catch (err) { foreignIntegration = err; }
    expect(sqlState(foreignIntegration)).toBe('23503');
  });

  runDb('deleting the integration cascades its keys', async () => {
    const partner = await createPartner();
    const integration = await seedIntegration({ partnerId: partner.id });
    await replayMigration(MIGRATION);
    expect(await keysOf(integration.id)).toHaveLength(1);

    await withDbAccessContext(partnerContext(partner.id), () =>
      db.delete(unifiIntegrations).where(eq(unifiIntegrations.id, integration.id)),
    );

    expect(await keysOf(integration.id)).toHaveLength(0);
  });

  runDb('the table is RLS enabled and forced', async () => {
    const [row] = await (getTestDb() as any).execute(sql`
      SELECT relrowsecurity, relforcerowsecurity FROM pg_class WHERE oid = 'public.unifi_integration_keys'::regclass
    `);
    expect(row).toMatchObject({ relrowsecurity: true, relforcerowsecurity: true });
  });
});

describe('connection service on unifi_integration_keys (breeze_app)', () => {
  const asPartner = <T>(partnerId: string, fn: () => Promise<T>) => withDbAccessContext(partnerContext(partnerId), fn);

  runDb('upsertConnection creates the first key, and a reconnect replaces its ciphertext in place', async () => {
    const partner = await createPartner();
    await asPartner(partner.id, () => upsertConnection(db, partner.id, { baseUrl: 'https://api.ui.com', apiKey: 'first-key-1111' }));
    const [integration] = await withSystemDbAccessContext(() =>
      db.select().from(unifiIntegrations).where(eq(unifiIntegrations.partnerId, partner.id)),
    );
    const [first] = await keysOf(integration!.id);
    expect(first).toMatchObject({ label: 'Global', status: 'connected', keyLast4: '1111', partnerId: partner.id });
    expect(openUnifiKey(first!.apiKeyEncrypted)).toBe('first-key-1111');
    // The legacy column carries the same ciphertext (rollback safety, plan D12).
    expect(integration!.apiKeyEncrypted).toBe(first!.apiKeyEncrypted);

    await asPartner(partner.id, () => upsertConnection(db, partner.id, { baseUrl: 'https://api.ui.com', apiKey: 'second-key-2222' }));
    const keys = await keysOf(integration!.id);
    expect(keys).toHaveLength(1);
    expect(keys[0]!.id).toBe(first!.id);
    expect(keys[0]!.keyLast4).toBe('2222');
    expect(openUnifiKey(keys[0]!.apiKeyEncrypted)).toBe('second-key-2222');

    const sync = await asPartner(partner.id, () => getSyncKeys(db, integration!.id, partner.id));
    expect(sync).toEqual({
      baseUrl: 'https://api.ui.com',
      keys: [{ id: first!.id, label: 'Global', apiKey: 'second-key-2222', keyLast4: '2222', lastSeenHostIds: null }],
    });
  });

  runDb('upsertConnection refuses a connection with two keys and changes nothing', async () => {
    const partner = await createPartner();
    await asPartner(partner.id, () => upsertConnection(db, partner.id, { baseUrl: 'https://api.ui.com', apiKey: 'kept-key-1' }));
    const [before] = await withSystemDbAccessContext(() =>
      db.select().from(unifiIntegrations).where(eq(unifiIntegrations.partnerId, partner.id)),
    );
    await withSystemDbAccessContext(() => db.insert(unifiIntegrationKeys).values({
      integrationId: before!.id, partnerId: partner.id, label: 'Fabric', apiKeyEncrypted: sealUnifiKey('fabric-key'),
    }));

    const err = await asPartner(partner.id, () =>
      upsertConnection(db, partner.id, { baseUrl: 'https://elsewhere.example', apiKey: 'new-key-9' }),
    ).catch((e) => e);
    expect(err).toBeInstanceOf(UnifiMultiKeyError);

    const [after] = await withSystemDbAccessContext(() =>
      db.select().from(unifiIntegrations).where(eq(unifiIntegrations.id, before!.id)),
    );
    expect(after!.baseUrl).toBe('https://api.ui.com');
    expect(after!.apiKeyEncrypted).toBe(before!.apiKeyEncrypted);
    const keys = await keysOf(before!.id);
    expect(keys.map((k) => openUnifiKey(k.apiKeyEncrypted)).sort()).toEqual(['fabric-key', 'kept-key-1']);
  });

  runDb('getSyncKeys adopts a reconnect an older API instance wrote to the legacy column, once', async () => {
    const partner = await createPartner();
    await asPartner(partner.id, () => upsertConnection(db, partner.id, { baseUrl: 'https://api.ui.com', apiKey: 'row-key-1111' }));
    const [integration] = await withSystemDbAccessContext(() =>
      db.select().from(unifiIntegrations).where(eq(unifiIntegrations.partnerId, partner.id)),
    );
    // An older instance's /connect writes the legacy column alone.
    const legacy = sealUnifiKey('legacy-key-2222');
    await (getTestDb() as any).update(unifiIntegrations).set({ apiKeyEncrypted: legacy }).where(eq(unifiIntegrations.id, integration!.id));

    const first = await asPartner(partner.id, () => getSyncKeys(db, integration!.id, partner.id));
    expect(first!.keys[0]).toMatchObject({ apiKey: 'legacy-key-2222', keyLast4: null });
    const [adopted] = await keysOf(integration!.id);
    expect(adopted!.apiKeyEncrypted).toBe(legacy);
    expect(adopted!.keyLast4).toBeNull();

    const second = await asPartner(partner.id, () => getSyncKeys(db, integration!.id, partner.id));
    expect(second!.keys[0]).toMatchObject({ apiKey: 'legacy-key-2222' });
    const [after] = await keysOf(integration!.id);
    expect(after!.updatedAt.getTime()).toBe(adopted!.updatedAt.getTime());
  });

  runDb("switching to self-hosted deletes the connection's keys; getSyncKeys then returns null", async () => {
    const partner = await createPartner();
    await asPartner(partner.id, () => upsertConnection(db, partner.id, { baseUrl: 'https://api.ui.com', apiKey: 'cloud-key' }));
    const created = await asPartner(partner.id, () => createSelfHostedIntegration(db, partner.id, { accountLabel: null }));
    expect(await keysOf(created.id)).toHaveLength(0);
    await expect(asPartner(partner.id, () => getSyncKeys(db, created.id, partner.id))).resolves.toBeNull();
  });

  runDb("another partner cannot read a connection's keys through getSyncKeys", async () => {
    const partner = await createPartner();
    const other = await createPartner();
    await asPartner(partner.id, () => upsertConnection(db, partner.id, { baseUrl: 'https://api.ui.com', apiKey: 'private-key' }));
    const [integration] = await withSystemDbAccessContext(() =>
      db.select().from(unifiIntegrations).where(eq(unifiIntegrations.partnerId, partner.id)),
    );
    await expect(asPartner(other.id, () => getSyncKeys(db, integration!.id, partner.id))).resolves.toBeNull();
  });
});
