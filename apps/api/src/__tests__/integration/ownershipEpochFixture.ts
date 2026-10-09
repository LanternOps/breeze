/**
 * Historical ownership-epoch fixture — PAM ownership epochs W1 (#8203).
 *
 * Waves 2, 3 and 5 need a state production cannot create until W6: a device
 * with CLOSED PAM history in epoch 1 that now lives in epoch 2 or 3 (the PAM
 * history move guard refuses every such move today). Every later task uses
 * this ONE helper instead of improvising.
 *
 * TEST-ONLY. It writes over the superuser connection inside one transaction
 * with `SET LOCAL session_replication_role = replica`, which suppresses every
 * user trigger AND every FK (RI) trigger for that transaction only. All rows
 * get explicit epoch values. After commit it re-checks the lineage FKs by
 * hand and throws if any target is missing.
 *
 * Until W2 swaps the PAM-chain FKs onto the epoch table, the seeded epoch-1
 * PAM rows deliberately violate `pam_actuations(device_id, org_id) ->
 * devices(id, org_id)` (the device now lives in another org) — that is the
 * exact shape W2's `(device_id, org_id, device_epoch) -> device_ownership_epochs`
 * FK makes legal. The post-commit check asserts the W2 target instead: the
 * chain's (device_id, org_id, epoch 1) epoch row exists.
 */
import { randomUUID } from 'node:crypto';
import postgres from 'postgres';
import { createOrganization, createPartner, createSite } from './db-utils';

const DATABASE_URL = process.env.DATABASE_URL
  ?? 'postgresql://breeze_test:breeze_test@localhost:5433/breeze_test';

export interface SeedMovedDeviceOptions {
  /** Org labels in ownership order, e.g. ['A','B'] or ['A','B','A']. Length >= 2. */
  path: readonly string[];
}

export interface SeededOrg {
  id: string;
  siteId: string;
}

export interface SeededMovedDevice {
  deviceId: string;
  partnerId: string;
  /** One entry per distinct label in `path`. */
  orgs: Record<string, SeededOrg>;
  /** = path.length */
  currentEpoch: number;
  /** Closed epoch-1 PAM chain, owned by org path[0]. */
  epoch1: { requestId: string; actuationId: string; resultId: string };
}

export async function seedMovedDeviceWithHistory(options: SeedMovedDeviceOptions): Promise<SeededMovedDevice> {
  const { path } = options;
  if (path.length < 2) throw new Error('seedMovedDeviceWithHistory: path needs at least two owners');

  const partner = await createPartner();
  const orgs: Record<string, SeededOrg> = {};
  for (const label of path) {
    if (orgs[label]) continue;
    const org = await createOrganization({ partnerId: partner.id });
    const site = await createSite({ orgId: org.id });
    orgs[label] = { id: org.id, siteId: site!.id };
  }

  const owner = (epoch: number): SeededOrg => orgs[path[epoch - 1]!]!;
  const currentEpoch = path.length;
  const current = owner(currentEpoch);
  const first = owner(1);
  const deviceId = randomUUID();
  const hostname = `epoch-fixture-${deviceId.slice(0, 8)}`;
  const requestId = randomUUID();
  const actuationId = randomUUID();
  const resultId = randomUUID();
  const hash = 'a'.repeat(64);
  const exe = 'C:\\Program Files\\Fixture\\fixture.exe';

  const client = postgres(DATABASE_URL, { max: 1, onnotice: () => {} });
  try {
    await client.begin(async (tx) => {
      await tx`SET LOCAL session_replication_role = replica`;

      await tx`
        INSERT INTO devices (id, org_id, site_id, agent_id, hostname, os_type, os_version,
                             architecture, agent_version, pam_lifetime_protocol_version, ownership_epoch)
        VALUES (${deviceId}, ${current.id}, ${current.siteId}, ${`agent-${deviceId}`}, ${hostname},
                'windows', '11', 'amd64', '2.0.0', 2, ${currentEpoch})`;

      for (let epoch = 1; epoch <= currentEpoch; epoch++) {
        const o = owner(epoch);
        await tx`
          INSERT INTO device_ownership_epochs (device_id, epoch, org_id, site_id, cause, started_at)
          VALUES (${deviceId}, ${epoch}, ${o.id}, ${o.siteId},
                  ${epoch === 1 ? 'enrollment' : 'device_move'},
                  now() - make_interval(days => ${currentEpoch - epoch + 1}))`;
        if (epoch < currentEpoch) {
          await tx`
            INSERT INTO device_ownership_epoch_closures
              (device_id, epoch, org_id, closed_at, hostname_snapshot, display_name_snapshot, site_id_snapshot)
            VALUES (${deviceId}, ${epoch}, ${o.id}, now() - make_interval(days => ${currentEpoch - epoch}),
                    ${hostname}, NULL, ${o.siteId})`;
        }
      }

      // Closed epoch-1 PAM chain in the first owner's org.
      await tx`
        INSERT INTO elevation_requests (
          id, org_id, site_id, partner_id, device_id, flow_type, subject_username, reason,
          target_executable_path, target_executable_hash, status, approved_at, expired_at
        ) VALUES (
          ${requestId}, ${first.id}, ${first.siteId}, ${partner.id}, ${deviceId}, 'uac_intercept',
          'fixture-user', 'ownership epoch fixture', ${exe}, ${hash}, 'expired',
          now() - interval '10 days', now() - interval '9 days'
        )`;
      await tx`
        INSERT INTO pam_actuations (
          id, org_id, device_id, elevation_request_id, request_revision, generation,
          desired_state, observed_state, target_executable_path, target_executable_hash,
          subject_username, cleanup_requested_at, cleaned_at
        ) VALUES (
          ${actuationId}, ${first.id}, ${deviceId}, ${requestId}, 1, 1,
          'cleanup', 'cleaned', ${exe}, ${hash}, 'fixture-user',
          now() - interval '9 days', now() - interval '9 days'
        )`;
      await tx`
        INSERT INTO pam_actuation_results (
          id, observation_id, org_id, device_id, actuation_id, generation, result_kind, evidence, observed_at
        ) VALUES (
          ${resultId}, ${randomUUID()}, ${first.id}, ${deviceId}, ${actuationId}, 1, 'cleaned',
          '{"source":"ownership-epoch-fixture"}'::jsonb, now() - interval '9 days'
        )`;
      // The 1 -> 2 transition retired the epoch-1 actuation.
      await tx`
        INSERT INTO pam_ledger_retirements (device_id, actuation_id, retired_epoch, retired_at)
        VALUES (${deviceId}, ${actuationId}, 1, now() - interval '8 days')`;
    });

    // FKs were not checked inside the transaction — check them now.
    const [check] = await client<{ problems: string[] }[]>`
      SELECT array_remove(ARRAY[
        CASE WHEN EXISTS (
          SELECT 1 FROM device_ownership_epochs e
          WHERE e.device_id = ${deviceId}
            AND NOT EXISTS (SELECT 1 FROM organizations o WHERE o.id = e.org_id)
        ) THEN 'epoch org missing' END,
        CASE WHEN EXISTS (
          SELECT 1 FROM device_ownership_epoch_closures c
          WHERE c.device_id = ${deviceId}
            AND NOT EXISTS (SELECT 1 FROM device_ownership_epochs e
                            WHERE (e.device_id, e.org_id, e.epoch) = (c.device_id, c.org_id, c.epoch))
        ) THEN 'closure epoch missing' END,
        CASE WHEN NOT EXISTS (
          SELECT 1 FROM devices d JOIN device_ownership_epochs e
            ON e.device_id = d.id AND e.org_id = d.org_id AND e.epoch = d.ownership_epoch
          WHERE d.id = ${deviceId}
        ) THEN 'current epoch row missing' END,
        CASE WHEN NOT EXISTS (
          SELECT 1 FROM pam_actuations a
          JOIN elevation_requests r ON r.id = a.elevation_request_id AND r.org_id = a.org_id
          JOIN device_ownership_epochs e ON e.device_id = a.device_id AND e.org_id = a.org_id AND e.epoch = 1
          WHERE a.id = ${actuationId}
        ) THEN 'actuation request/epoch missing' END,
        CASE WHEN NOT EXISTS (
          SELECT 1 FROM pam_actuation_results res
          JOIN pam_actuations a ON a.id = res.actuation_id AND a.org_id = res.org_id
          WHERE res.id = ${resultId}
        ) THEN 'result actuation missing' END,
        CASE WHEN NOT EXISTS (
          SELECT 1 FROM pam_ledger_retirements m JOIN devices d ON d.id = m.device_id
          WHERE m.device_id = ${deviceId} AND m.actuation_id = ${actuationId}
        ) THEN 'retirement device missing' END
      ], NULL) AS problems`;
    if (check!.problems.length > 0) {
      throw new Error(`seedMovedDeviceWithHistory: FK targets missing: ${check!.problems.join(', ')}`);
    }
  } finally {
    await client.end({ timeout: 1 });
  }

  return {
    deviceId,
    partnerId: partner.id,
    orgs,
    currentEpoch,
    epoch1: { requestId, actuationId, resultId },
  };
}
