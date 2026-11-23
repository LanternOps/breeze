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
import {
  addKey,
  deleteKey,
  getKeyForTest,
  getSyncKeys,
  openUnifiKey,
  recordKeyResults,
  sealUnifiKey,
  UNIFI_MAX_KEYS,
  UnifiKeyError,
  updateKey,
} from '../../services/unifi/unifiKeyService';
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

  runDb('getSyncKeys no longer adopts the legacy column (W3: the key row is the only source)', async () => {
    const partner = await createPartner();
    await asPartner(partner.id, () => upsertConnection(db, partner.id, { baseUrl: 'https://api.ui.com', apiKey: 'row-key-1111' }));
    const [integration] = await withSystemDbAccessContext(() =>
      db.select().from(unifiIntegrations).where(eq(unifiIntegrations.partnerId, partner.id)),
    );
    const [before] = await keysOf(integration!.id);
    await (getTestDb() as any).update(unifiIntegrations)
      .set({ apiKeyEncrypted: sealUnifiKey('legacy-key-2222') })
      .where(eq(unifiIntegrations.id, integration!.id));

    const sync = await asPartner(partner.id, () => getSyncKeys(db, integration!.id, partner.id));
    expect(sync!.keys[0]).toMatchObject({ apiKey: 'row-key-1111', keyLast4: '1111' });
    const [after] = await keysOf(integration!.id);
    expect(after!.apiKeyEncrypted).toBe(before!.apiKeyEncrypted);
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

describe('key management on unifi_integration_keys (#11808 W3, breeze_app)', () => {
  const asPartner = <T>(partnerId: string, fn: () => Promise<T>) => withDbAccessContext(partnerContext(partnerId), fn);

  async function connected(apiKey = 'first-key-0001') {
    const partner = await createPartner();
    await asPartner(partner.id, () => upsertConnection(db, partner.id, { baseUrl: 'https://api.ui.com', apiKey }));
    const [integration] = await withSystemDbAccessContext(() =>
      db.select().from(unifiIntegrations).where(eq(unifiIntegrations.partnerId, partner.id)),
    );
    return { partnerId: partner.id, integrationId: integration!.id };
  }

  async function seedExtraKeys(integrationId: string, partnerId: string, n: number) {
    const admin = getTestDb() as any;
    for (let i = 0; i < n; i++) {
      await admin.insert(unifiIntegrationKeys).values({
        integrationId, partnerId, label: `Seeded ${i}`, apiKeyEncrypted: sealUnifiKey(`seeded-${i}`),
      });
    }
  }

  async function legacyCiphertext(integrationId: string): Promise<string | null> {
    const [row] = await withSystemDbAccessContext(() =>
      db.select({ v: unifiIntegrations.apiKeyEncrypted }).from(unifiIntegrations).where(eq(unifiIntegrations.id, integrationId)),
    );
    return row!.v;
  }

  // Review Focus 5. Each call runs in its own system context (its own pooled
  // connection and transaction), so the two really overlap. Several rounds,
  // because one round could serialize by luck: without the integration row
  // lock, both calls count 24 and both insert.
  runDb('two concurrent addKey calls with one slot left produce 25 keys', async () => {
    for (let round = 0; round < 4; round++) {
      const { partnerId, integrationId } = await connected();
      await seedExtraKeys(integrationId, partnerId, UNIFI_MAX_KEYS - 2); // 24 keys
      const add = (label: string) => withSystemDbAccessContext(() => addKey(db, {
        integrationId, partnerId, label, apiKey: `race-${label}-key`, seenHostIds: [], createdBy: null,
      }));
      const results = await Promise.allSettled([add(`Race A${round}`), add(`Race B${round}`)]);
      const fulfilled = results.filter((r) => r.status === 'fulfilled');
      const rejected = results.filter((r): r is PromiseRejectedResult => r.status === 'rejected');
      expect(fulfilled).toHaveLength(1);
      expect(rejected).toHaveLength(1);
      expect(rejected[0]!.reason).toBeInstanceOf(UnifiKeyError);
      expect(rejected[0]!.reason.code).toBe('UNIFI_KEY_LIMIT');
      expect(await keysOf(integrationId)).toHaveLength(UNIFI_MAX_KEYS);
    }
  });

  runDb('two concurrent addKey calls with the same label (case and spaces differ) produce one key', async () => {
    for (let round = 0; round < 4; round++) {
      const { partnerId, integrationId } = await connected();
      const add = (label: string) => withSystemDbAccessContext(() => addKey(db, {
        integrationId, partnerId, label, apiKey: `dup-${label.length}-key`, seenHostIds: [], createdBy: null,
      }));
      const results = await Promise.allSettled([add('Fabric North'), add('  fabric north ')]);
      const rejected = results.filter((r): r is PromiseRejectedResult => r.status === 'rejected');
      expect(rejected).toHaveLength(1);
      expect(rejected[0]!.reason).toBeInstanceOf(UnifiKeyError);
      expect(rejected[0]!.reason.code).toBe('UNIFI_KEY_LABEL_TAKEN');
      expect(await keysOf(integrationId)).toHaveLength(2);
    }
  });

  // DELETE /unifi/keys/:id runs in the request transaction and maps a refusal
  // to 409 with the catch outside deleteKey's savepoint; the request must then
  // still commit.
  runDb('a refused add or delete inside a request context leaves nothing behind and the context still works', async () => {
    const { partnerId, integrationId } = await connected();
    const [only] = await keysOf(integrationId);
    const err = await asPartner(partnerId, async () => {
      const refusedDelete = await deleteKey(db, { integrationId, partnerId, keyId: only!.id }).catch((e) => e);
      expect(refusedDelete).toBeInstanceOf(UnifiKeyError);
      expect(refusedDelete.code).toBe('UNIFI_LAST_ENABLED_KEY');
      const refused = await addKey(db, { integrationId, partnerId, label: 'GLOBAL', apiKey: 'dupe-key', seenHostIds: [], createdBy: null })
        .catch((e) => e);
      // The same context keeps working after the refusal (no aborted transaction).
      await addKey(db, { integrationId, partnerId, label: 'Fabric', apiKey: 'fabric-key-7777', seenHostIds: ['h1'], createdBy: null });
      return refused;
    });
    expect(err).toBeInstanceOf(UnifiKeyError);
    expect(err.code).toBe('UNIFI_KEY_LABEL_TAKEN');
    const keys = await keysOf(integrationId);
    expect(keys.map((k) => k.label).sort()).toEqual(['Fabric', 'Global']);
    const fabric = keys.find((k) => k.label === 'Fabric')!;
    expect(fabric).toMatchObject({ status: 'pending', keyLast4: '7777', lastSeenHostIds: ['h1'], isEnabled: true });
    expect(openUnifiKey(fabric.apiKeyEncrypted)).toBe('fabric-key-7777');
  });

  runDb('replacing or deleting keys keeps the legacy column on the first key', async () => {
    const { partnerId, integrationId } = await connected('original-0001');
    const [first] = await keysOf(integrationId);
    const second = await asPartner(partnerId, () => addKey(db, {
      integrationId, partnerId, label: 'Fabric', apiKey: 'second-0002', seenHostIds: [], createdBy: null,
    }));

    // Replacing the second key leaves the legacy column on the first.
    await asPartner(partnerId, () => updateKey(db, { integrationId, partnerId, keyId: second.id, apiKey: 'second-new-0003', seenHostIds: [] }));
    expect(openUnifiKey((await legacyCiphertext(integrationId))!)).toBe('original-0001');

    // Replacing the first key moves it.
    await asPartner(partnerId, () => updateKey(db, { integrationId, partnerId, keyId: first!.id, apiKey: 'original-new-0004', seenHostIds: ['h1'] }));
    expect(openUnifiKey((await legacyCiphertext(integrationId))!)).toBe('original-new-0004');

    // Deleting the first key re-points it at the survivor, so a W1/W2 worker's
    // one-key reconcile finds nothing to adopt.
    await expect(asPartner(partnerId, () => deleteKey(db, { integrationId, partnerId, keyId: first!.id }))).resolves.toBe(true);
    const [survivor] = await keysOf(integrationId);
    expect(survivor!.id).toBe(second.id);
    expect(await legacyCiphertext(integrationId)).toBe(survivor!.apiKeyEncrypted);
    expect(openUnifiKey(survivor!.apiKeyEncrypted)).toBe('second-new-0003');

    // The last key cannot go; deleting an absent key is a no-op.
    await expect(asPartner(partnerId, () => deleteKey(db, { integrationId, partnerId, keyId: second.id })))
      .rejects.toMatchObject({ code: 'UNIFI_LAST_ENABLED_KEY' });
    await expect(asPartner(partnerId, () => deleteKey(db, { integrationId, partnerId, keyId: first!.id }))).resolves.toBe(false);
  });

  // A sync that read the OLD secret and finishes after a replace must not land
  // its verdict (typically "rejected") on the freshly reset key.
  runDb('a sync run that started before a key was replaced never records over it', async () => {
    const { partnerId, integrationId } = await connected('old-secret-0001');
    const [key] = await keysOf(integrationId);
    const runStartedAt = new Date(Date.now() - 5_000);
    await asPartner(partnerId, () => updateKey(db, { integrationId, partnerId, keyId: key!.id, apiKey: 'new-secret-0002', seenHostIds: ['h1'] }));

    await withSystemDbAccessContext(() => recordKeyResults(db, {
      integrationId, partnerId, runStartedAt, keyLast4ById: new Map(),
      results: [{ keyId: key!.id, label: 'Global', status: 'failed', authFailure: true, hostsSeen: null, sitesSeen: null, hostIds: null, error: 'UniFi API error 401' }],
    }));
    const [after] = await keysOf(integrationId);
    expect(after).toMatchObject({ status: 'pending', lastSyncStatus: null, lastSyncError: null, keyLast4: '0002', lastSeenHostIds: ['h1'] });

    // A run that starts after the replace records normally.
    await withSystemDbAccessContext(() => recordKeyResults(db, {
      integrationId, partnerId, runStartedAt: new Date(Date.now() + 1_000), keyLast4ById: new Map(),
      results: [{ keyId: key!.id, label: 'Global', status: 'success', authFailure: false, hostsSeen: 1, sitesSeen: 2, hostIds: ['h1'], error: null }],
    }));
    const [synced] = await keysOf(integrationId);
    expect(synced).toMatchObject({ status: 'connected', lastSyncStatus: 'success', sitesSeen: 2 });
  });

  runDb('a sync run that started before a /connect reconnect never records over the new key', async () => {
    const { partnerId, integrationId } = await connected('old-secret-0001');
    const [key] = await keysOf(integrationId);
    const runStartedAt = new Date(Date.now() - 5_000);
    await asPartner(partnerId, () => upsertConnection(db, partnerId, { baseUrl: 'https://api.ui.com', apiKey: 'reconnected-0003' }));

    await withSystemDbAccessContext(() => recordKeyResults(db, {
      integrationId, partnerId, runStartedAt, keyLast4ById: new Map(),
      results: [{ keyId: key!.id, label: 'Global', status: 'failed', authFailure: true, hostsSeen: null, sitesSeen: null, hostIds: null, error: 'UniFi API error 401' }],
    }));
    const [after] = await keysOf(integrationId);
    expect(after).toMatchObject({ status: 'connected', lastSyncStatus: null, lastSyncError: null, keyLast4: '0003' });
  });

  runDb('another partner cannot change or remove a key', async () => {
    const { partnerId, integrationId } = await connected();
    const other = await createPartner();
    const [key] = await keysOf(integrationId);
    await expect(asPartner(other.id, () => updateKey(db, { integrationId, partnerId, keyId: key!.id, label: 'Hijacked' })))
      .rejects.toMatchObject({ code: 'UNIFI_NOT_CONNECTED' });
    await expect(asPartner(other.id, () => addKey(db, {
      integrationId, partnerId, label: 'Planted', apiKey: 'planted', seenHostIds: [], createdBy: null,
    }))).rejects.toMatchObject({ code: 'UNIFI_NOT_CONNECTED' });
    expect((await keysOf(integrationId)).map((k) => k.label)).toEqual(['Global']);
    await expect(asPartner(other.id, () => deleteKey(db, { integrationId, partnerId, keyId: key!.id })))
      .rejects.toMatchObject({ code: 'UNIFI_NOT_CONNECTED' });
    await expect(asPartner(other.id, () => getKeyForTest(db, integrationId, partnerId, key!.id))).resolves.toBeNull();
    expect(await keysOf(integrationId)).toHaveLength(1);
  });

  // D11 under concurrency: two disables of the last two enabled keys must not
  // leave the connection with none enabled.
  runDb('two concurrent disables of the last two enabled keys leave one enabled', async () => {
    for (let round = 0; round < 4; round++) {
      const { partnerId, integrationId } = await connected();
      const second = await asPartner(partnerId, () => addKey(db, {
        integrationId, partnerId, label: `Second ${round}`, apiKey: 'second-key', seenHostIds: [], createdBy: null,
      }));
      const [first] = (await keysOf(integrationId)).filter((k) => k.id !== second.id);
      const disable = (keyId: string) => withSystemDbAccessContext(() => updateKey(db, { integrationId, partnerId, keyId, isEnabled: false }));
      const results = await Promise.allSettled([disable(first!.id), disable(second.id)]);
      const rejected = results.filter((r): r is PromiseRejectedResult => r.status === 'rejected');
      expect(rejected).toHaveLength(1);
      expect(rejected[0]!.reason.code).toBe('UNIFI_LAST_ENABLED_KEY');
      expect((await keysOf(integrationId)).filter((k) => k.isEnabled)).toHaveLength(1);
    }
  });
});
