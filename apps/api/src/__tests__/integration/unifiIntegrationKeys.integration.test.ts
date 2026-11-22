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
