import './setup';

import { randomUUID } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { sql } from 'drizzle-orm';
import { getTestDb } from './setup';
import { createOrganization, createPartner } from './db-utils';
import { listBackupVerifications } from '../../routes/backup/verificationService';
import { listRecoveryReadiness } from '../../routes/backup/readinessCalculator';

describe('backup verification current-site visibility', () => {
  it('filters verification and readiness rows before limit and follows a current site move', async () => {
    const partner = await createPartner();
    const org = await createOrganization({ partnerId: partner.id });
    const siteA = randomUUID();
    const siteB = randomUUID();
    const visibleDevice = randomUUID();
    const hiddenDevice = randomUUID();
    const configId = randomUUID();
    const visibleJob = randomUUID();
    const hiddenJob = randomUUID();

    await getTestDb().execute(sql`
      INSERT INTO sites (id, org_id, name) VALUES
        (${siteA}, ${org.id}, 'Visible'),
        (${siteB}, ${org.id}, 'Hidden')
    `);
    await getTestDb().execute(sql`
      INSERT INTO devices (id, org_id, site_id, agent_id, hostname, os_type, os_version, architecture, agent_version) VALUES
        (${visibleDevice}, ${org.id}, ${siteA}, ${`agent-${randomUUID()}`}, 'visible-host', 'windows', '11', 'amd64', '2.0.0'),
        (${hiddenDevice}, ${org.id}, ${siteB}, ${`agent-${randomUUID()}`}, 'hidden-host', 'windows', '11', 'amd64', '2.0.0')
    `);
    await getTestDb().execute(sql`
      INSERT INTO backup_configs (id, org_id, name, type, provider, provider_config)
        VALUES (${configId}, ${org.id}, 'Site scope', 'file', 'local', '{}'::jsonb)
    `);
    await getTestDb().execute(sql`
      INSERT INTO backup_jobs (id, org_id, config_id, device_id, status, type) VALUES
        (${visibleJob}, ${org.id}, ${configId}, ${visibleDevice}, 'completed', 'manual'),
        (${hiddenJob}, ${org.id}, ${configId}, ${hiddenDevice}, 'completed', 'manual')
    `);
    await getTestDb().execute(sql`
      INSERT INTO backup_verifications (
        org_id, device_id, backup_job_id, verification_type, status, started_at, completed_at, details
      ) VALUES
        (${org.id}, ${visibleDevice}, ${visibleJob}, 'integrity', 'passed', now() - interval '1 hour', now() - interval '1 hour', '{"simulated":true,"restorePath":"/private/visible","failedFiles":["secret.txt"],"commandId":"internal-command"}'::jsonb),
        (${org.id}, ${hiddenDevice}, ${hiddenJob}, 'integrity', 'failed', now(), now(), '{"path":"hidden"}'::jsonb)
    `);
    await getTestDb().execute(sql`
      INSERT INTO recovery_readiness (org_id, device_id, readiness_score, risk_factors, calculated_at) VALUES
        (${org.id}, ${visibleDevice}, 90, '[]'::jsonb, now()),
        (${org.id}, ${hiddenDevice}, 10, '[{"code":"hidden-risk","severity":"high","message":"hidden"}]'::jsonb, now())
    `);

    const visible = await listBackupVerifications(org.id, { allowedSiteIds: [siteA], limit: 1 });
    expect(visible).toHaveLength(1);
    expect(visible[0]?.deviceId).toBe(visibleDevice);
    expect(visible[0]?.details).toEqual({ simulated: true });
    expect(JSON.stringify(visible[0])).not.toContain('restorePath');
    expect(JSON.stringify(visible[0])).not.toContain('failedFiles');
    expect(JSON.stringify(visible[0])).not.toContain('internal-command');
    expect(await listBackupVerifications(org.id, { allowedSiteIds: [] })).toEqual([]);

    const readiness = await listRecoveryReadiness(org.id, [siteA]);
    expect(readiness.map((row) => row.deviceId)).toEqual([visibleDevice]);

    await getTestDb().execute(sql`UPDATE devices SET site_id = ${siteB} WHERE id = ${visibleDevice}`);
    expect(await listBackupVerifications(org.id, { allowedSiteIds: [siteA], limit: 1 })).toEqual([]);
    expect(await listRecoveryReadiness(org.id, [siteA])).toEqual([]);
  });
});
