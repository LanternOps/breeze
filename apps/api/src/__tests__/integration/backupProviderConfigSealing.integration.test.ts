/**
 * backup_configs.provider_config credentials against real Postgres: what the
 * row holds (ciphertext) versus what every Drizzle reader gets back
 * (plaintext), and the boot-time backfill over rows stored before sealing —
 * run as `breeze_app` with forced RLS (the backfill elects system scope
 * itself).
 */
import './setup';
import { describe, expect, it } from 'vitest';
import { eq, sql } from 'drizzle-orm';
import { db, withSystemDbAccessContext } from '../../db';
import { backupConfigs } from '../../db/schema';
import { decryptSecret, encryptSecret, isEncryptedSecret } from '../../services/secretCrypto';
import { sealBackupProviderConfig } from '../../services/backupProviderConfigSealing';
import { sealUnsealedBackupProviderConfigs } from '../../services/backupProviderConfigBackfill';
import { getTestDb } from './setup';
import { createOrganization, createPartner } from './db-utils';

const AAD = 'backup_configs.provider_config';

function s3(tag: string) {
  return {
    bucket: `bucket-${tag}`,
    region: 'us-east-1',
    endpoint: 'https://s3.example.com',
    accessKey: `AKIA-${tag}`,
    secretKey: `plain-secret-${tag}`,
  };
}

async function storedConfig(id: string): Promise<Record<string, any>> {
  const rows = await getTestDb().execute(sql`SELECT provider_config AS value FROM backup_configs WHERE id = ${id}::uuid`);
  const value = (rows as unknown as Array<{ value: unknown }>)[0]!.value;
  return (typeof value === 'string' ? JSON.parse(value) : value) as Record<string, any>;
}

async function insertRaw(orgId: string, providerConfig: unknown): Promise<string> {
  const rows = await getTestDb().execute(sql`
    INSERT INTO backup_configs (org_id, name, type, provider, provider_config)
    VALUES (${orgId}::uuid, ${`raw ${Math.random().toString(36).slice(2)}`}, 'file', 's3', ${JSON.stringify(providerConfig)}::jsonb)
    RETURNING id::text AS id
  `);
  return (rows as unknown as Array<{ id: string }>)[0]!.id;
}

async function readThroughDrizzle(id: string) {
  const [row] = await getTestDb().select({ providerConfig: backupConfigs.providerConfig })
    .from(backupConfigs).where(eq(backupConfigs.id, id));
  return row?.providerConfig;
}

function expectSealedTo(value: unknown, plaintext: string) {
  expect(typeof value).toBe('string');
  expect(isEncryptedSecret(value as string)).toBe(true);
  expect(decryptSecret(value as string, { aad: AAD })).toBe(plaintext);
}

describe('backup_configs.provider_config sealing (real Postgres)', () => {
  it('stores ciphertext on insert/update and every Drizzle read path returns plaintext', async () => {
    const partner = await createPartner();
    const org = await createOrganization({ partnerId: partner.id });
    const config = s3('drizzle');

    const [inserted] = await withSystemDbAccessContext(() => db.insert(backupConfigs).values({
      orgId: org.id, name: 'sealed', type: 'file', provider: 's3', providerConfig: config,
    }).returning());
    expect(inserted!.providerConfig).toEqual(config);

    const stored = await storedConfig(inserted!.id);
    expectSealedTo(stored.secretKey, config.secretKey);
    expectSealedTo(stored.accessKey, config.accessKey);
    expect(stored.bucket).toBe(config.bucket);
    expect(JSON.stringify(stored)).not.toContain('plain-secret');

    expect(await readThroughDrizzle(inserted!.id)).toEqual(config);
    const viaQuery = await getTestDb().query.backupConfigs.findFirst({ where: eq(backupConfigs.id, inserted!.id) });
    expect(viaQuery?.providerConfig).toEqual(config);

    const next = { ...config, secretKey: 'plain-secret-rotated' };
    const [updated] = await withSystemDbAccessContext(() => db.update(backupConfigs)
      .set({ providerConfig: next }).where(eq(backupConfigs.id, inserted!.id)).returning());
    expect(updated!.providerConfig).toEqual(next);
    expectSealedTo((await storedConfig(inserted!.id)).secretKey, 'plain-secret-rotated');
  });

  it('reads a row stored before sealing (plaintext) as the same config', async () => {
    const partner = await createPartner();
    const org = await createOrganization({ partnerId: partner.id });
    const legacy = s3('legacy');
    const id = await insertRaw(org.id, legacy);
    expect(await readThroughDrizzle(id)).toEqual(legacy);
  });
});

describe('sealUnsealedBackupProviderConfigs', () => {
  it('seals plaintext rows across tenants, keeps sealed values byte-identical, and is a no-op on re-run', async () => {
    const partnerA = await createPartner();
    const partnerB = await createPartner();
    const orgA = await createOrganization({ partnerId: partnerA.id });
    const orgB = await createOrganization({ partnerId: partnerB.id });

    const plainA = s3('a');
    const plainB = { bucket: 'b2', keyId: 'key-id', applicationKey: 'plain-secret-b2' };
    const idA = await insertRaw(orgA.id, plainA);
    const idB = await insertRaw(orgB.id, plainB);
    // A row already half-sealed (secretKey) with a plaintext access key.
    const sealedSecret = (sealBackupProviderConfig(s3('mixed')) as Record<string, string>).secretKey!;
    const mixed = { ...s3('mixed'), secretKey: sealedSecret };
    const idMixed = await insertRaw(orgA.id, mixed);
    const localId = await insertRaw(orgB.id, { path: '/srv/backups' });

    const errors: string[] = [];
    const first = await sealUnsealedBackupProviderConfigs({ logger: { error: (m: string) => errors.push(m) } });

    expect(errors).toEqual([]);
    expect(first.failed).toBe(0);
    expect(first.contended).toBe(0);
    // Other suites' rows may share the database: assert at least ours.
    expect(first.sealed).toBeGreaterThanOrEqual(3);

    const a = await storedConfig(idA);
    expectSealedTo(a.secretKey, plainA.secretKey);
    expectSealedTo(a.accessKey, plainA.accessKey);
    expect(a.bucket).toBe(plainA.bucket);
    expectSealedTo((await storedConfig(idB)).applicationKey, 'plain-secret-b2');
    const m = await storedConfig(idMixed);
    expect(m.secretKey).toBe(sealedSecret);
    expectSealedTo(m.accessKey, 'AKIA-mixed');
    expect(await storedConfig(localId)).toEqual({ path: '/srv/backups' });

    // Readers get the original values back.
    expect(await readThroughDrizzle(idA)).toEqual(plainA);
    expect(await readThroughDrizzle(idB)).toEqual(plainB);
    expect(await readThroughDrizzle(idMixed)).toEqual(s3('mixed'));

    const before = await storedConfig(idA);
    const second = await sealUnsealedBackupProviderConfigs();
    expect(second).toEqual({ scanned: 0, sealed: 0, contended: 0, failed: 0 });
    expect(await storedConfig(idA)).toEqual(before);
  });

  it('never overwrites a destination saved between its read and its write', async () => {
    const partner = await createPartner();
    const org = await createOrganization({ partnerId: partner.id });
    const id = await insertRaw(org.id, s3('race'));
    const saved = s3('saved-concurrently');

    let raced = false;
    const result = await sealUnsealedBackupProviderConfigs({
      beforeWrite: async (rowId) => {
        if (raced || rowId !== id) return;
        raced = true;
        await getTestDb().execute(sql`
          UPDATE backup_configs SET provider_config = ${JSON.stringify(saved)}::jsonb WHERE id = ${id}::uuid
        `);
      },
    });

    expect(raced).toBe(true);
    expect(result.contended).toBe(0);
    // The concurrent save won; its values (not the stale ones) are what got sealed.
    expect(await readThroughDrizzle(id)).toEqual(saved);
    expectSealedTo((await storedConfig(id)).secretKey, saved.secretKey);
  });

  it('a foreign ciphertext cannot be written through Drizzle', async () => {
    const partner = await createPartner();
    const org = await createOrganization({ partnerId: partner.id });
    const foreign = encryptSecret('sealed-elsewhere')!;
    await expect(withSystemDbAccessContext(() => db.insert(backupConfigs).values({
      orgId: org.id, name: 'foreign', type: 'file', provider: 's3',
      providerConfig: { ...s3('foreign'), secretKey: foreign },
    }))).rejects.toThrow(/internal encrypted format/);
  });
});
