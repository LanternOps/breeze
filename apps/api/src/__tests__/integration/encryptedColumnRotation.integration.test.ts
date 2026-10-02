/**
 * The key-rotation walker (reencryptRegisteredSecrets) against real Postgres,
 * for each kind of registered column: its compare-and-set write must be valid
 * SQL for text, text-array and jsonb columns and must actually land.
 */
import './setup';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { eq, sql } from 'drizzle-orm';
import { backupConfigs, discoveryProfiles, sites, snmpDevices } from '../../db/schema';
import { reencryptRegisteredSecrets, encryptedColumnRegistry } from '../../services/encryptedColumnRegistry';
import { decryptSecret, getEncryptedSecretKeyId } from '../../services/secretCrypto';
import { getTestDb } from './setup';
import { createOrganization, createPartner } from './db-utils';

const KEY_ENV = ['APP_ENCRYPTION_KEY_ID', 'APP_ENCRYPTION_KEYRING'] as const;
const saved = Object.fromEntries(KEY_ENV.map((k) => [k, process.env[k]]));

function spec(table: string, column: string) {
  const found = encryptedColumnRegistry.find((s) => s.table === table && s.column === column);
  if (!found) throw new Error(`${table}.${column} not registered`);
  return found;
}

describe('reencryptRegisteredSecrets (real Postgres)', () => {
  beforeEach(() => {
    process.env.APP_ENCRYPTION_KEY_ID = 'rotation-test';
    process.env.APP_ENCRYPTION_KEYRING = JSON.stringify({ 'rotation-test': 'rotation-test-key-material-0123456789' });
  });
  afterEach(() => {
    for (const key of KEY_ENV) {
      if (saved[key] === undefined) delete process.env[key];
      else process.env[key] = saved[key];
    }
  });

  it('seals plaintext in text, text-array and jsonb columns', async () => {
    const partner = await createPartner();
    const org = await createOrganization({ partnerId: partner.id });
    const [site] = await getTestDb().insert(sites).values({ orgId: org.id, name: 'rotation site' }).returning({ id: sites.id });
    const [profile] = await getTestDb().insert(discoveryProfiles).values({
      orgId: org.id, siteId: site!.id, name: 'rotation profile', snmpCommunities: ['public-plain', 'private-plain'],
    }).returning({ id: discoveryProfiles.id });
    const [config] = await getTestDb().execute(sql`
      INSERT INTO backup_configs (org_id, name, type, provider, provider_config)
      VALUES (${org.id}::uuid, 'rotation config', 'file', 's3', ${JSON.stringify({ bucket: 'b', region: 'r', secretKey: 'plain-rotation-secret' })}::jsonb)
      RETURNING id::text AS id
    `) as unknown as Array<{ id: string }>;

    const errors: string[] = [];
    const stats = await reencryptRegisteredSecrets({
      dryRun: false,
      registry: [
        spec('discovery_profiles', 'snmp_communities'),
        spec('backup_configs', 'provider_config'),
      ],
      logger: { log: () => {}, warn: () => {}, error: (m: string) => errors.push(m) },
    });

    expect(errors).toEqual([]);
    expect(stats.errors).toEqual([]);
    expect(stats.contended).toBe(0);
    expect(stats.updated).toBe(2);

    const [storedProfile] = await getTestDb().select({ c: discoveryProfiles.snmpCommunities })
      .from(discoveryProfiles).where(eq(discoveryProfiles.id, profile!.id));
    expect(storedProfile!.c).toHaveLength(2);
    for (const entry of storedProfile!.c!) expect(getEncryptedSecretKeyId(entry)).toBe('rotation-test');
    expect(storedProfile!.c!.map((e) => decryptSecret(e))).toEqual(['public-plain', 'private-plain']);

    const [rawConfig] = await getTestDb().execute(sql`SELECT provider_config AS v FROM backup_configs WHERE id = ${config!.id}::uuid`) as unknown as Array<{ v: any }>;
    const stored = typeof rawConfig!.v === 'string' ? JSON.parse(rawConfig!.v) : rawConfig!.v;
    expect(getEncryptedSecretKeyId(stored.secretKey)).toBe('rotation-test');
    const [readBack] = await getTestDb().select({ p: backupConfigs.providerConfig }).from(backupConfigs).where(eq(backupConfigs.id, config!.id));
    expect(readBack!.p).toEqual({ bucket: 'b', region: 'r', secretKey: 'plain-rotation-secret' });
  });

  it('seals a plaintext text column', async () => {
    const partner = await createPartner();
    const org = await createOrganization({ partnerId: partner.id });
    const rows = await getTestDb().execute(sql`
      INSERT INTO snmp_devices (org_id, name, ip_address, snmp_version, community)
      VALUES (${org.id}::uuid, 'switch', '10.0.0.1', 'v2c', 'plain-community')
      RETURNING id::text AS id
    `) as unknown as Array<{ id: string }>;

    const stats = await reencryptRegisteredSecrets({
      dryRun: false,
      registry: [spec('snmp_devices', 'community')],
      logger: { log: () => {}, warn: () => {}, error: () => {} },
    });

    expect(stats.errors).toEqual([]);
    expect(stats.updated).toBe(1);
    const [row] = await getTestDb().select({ c: snmpDevices.community }).from(snmpDevices).where(eq(snmpDevices.id, rows[0]!.id));
    expect(getEncryptedSecretKeyId(row!.c!)).toBe('rotation-test');
    expect(decryptSecret(row!.c!)).toBe('plain-community');
  });
});
