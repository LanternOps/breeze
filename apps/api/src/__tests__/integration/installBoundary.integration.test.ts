/**
 * #8318 wave 1a — the install incarnation boundary, every category, against
 * real Postgres (spec docs/superpowers/specs/installer-enrollment/2026-10-12-reinstall-reattach-design.md
 * §5, §5.8 "Integration test").
 *
 * One item of every handled category is seeded on a TARGET device and on a
 * CONTROL device in the same org. The boundary runs directly (nothing calls it
 * in production until wave 1b's confirm), in a system DB context, as the
 * confirm will. Then:
 *   - every target item is cancelled, revoked, expired, reset or cleared;
 *   - none of it reaches the new install's first heartbeat: the command claim
 *     hands out nothing from before, a late result is refused, PAM sends no
 *     cleanup, and work enqueued AFTER the boundary is delivered normally;
 *   - configuration and history survive on the target;
 *   - the control device is untouched;
 *   - the boundary is all-or-nothing, version-checked and repeatable.
 */
import './setup';

import { randomUUID } from 'node:crypto';

import { eq, sql } from 'drizzle-orm';
import postgres from 'postgres';
import { describe, expect, it } from 'vitest';

import { db, withSystemDbAccessContext } from '../../db';
import { backupSnapshots, deviceCommands, devices } from '../../db/schema';
import { claimPendingCommandsForDevice } from '../../services/commandDispatch';
import { commandAcceptsAgentResultCondition } from '../../services/commandResultAcceptance';
import {
  InstallBoundaryRefusedError,
  runInstallIncarnationBoundary,
} from '../../services/deviceInstallBoundary';
import { requestPamCleanup } from '../../services/pamActuationLifecycle';
import { decideRestoreGate } from '../../services/backupRestoreGate';
import { resolveRestoreIntegrity, snapshotPredatesDeviceIncarnationSql } from '../../services/backupRestoreIntegrity';
import { setupTestEnvironment } from './db-utils';
import { getTestDb } from './setup';

const HEX64 = 'a'.repeat(64);
const hex64 = () => (randomUUID() + randomUUID()).replaceAll('-', '');
const AGENT_CAPS = {
  peripheralPolicyProtocolVersion: 2,
  rollbackProtocolVersion: 1,
  pamLifetimeProtocolVersion: 2,
} as const;

type Env = Awaited<ReturnType<typeof setupTestEnvironment>>;

async function exec<T = Record<string, unknown>>(query: ReturnType<typeof sql>): Promise<T[]> {
  return (await getTestDb().execute(query)) as unknown as T[];
}

async function one<T = Record<string, unknown>>(query: ReturnType<typeof sql>): Promise<T> {
  const [row] = await exec<T>(query);
  if (!row) throw new Error('fixture insert returned no row');
  return row;
}

/** Insert rows whose parents are expensive to build: FK and insert triggers off, CHECKs still on. */
async function withoutReferences(fn: (tx: typeof db) => Promise<void>): Promise<void> {
  await getTestDb().transaction(async (tx) => {
    await tx.execute(sql`SET LOCAL session_replication_role = replica`);
    await fn(tx as unknown as typeof db);
  });
}

async function makeDevice(env: Env): Promise<string> {
  const row = await one<{ id: string }>(sql`
    INSERT INTO devices (org_id, site_id, agent_id, hostname, os_type, os_version, architecture, agent_version, status,
                         script_secret_env_version, pam_lifetime_protocol_version, rollback_protocol_version,
                         backup_read_protocol_version, backup_integrity_protocol_version, backup_write_protocol_version,
                         edition_migration_dispatched_at, uninstall_intent_at)
    VALUES (${env.organization.id}, ${env.site.id}, ${`agent-${randomUUID()}`}, ${`host-${randomUUID().slice(0, 8)}`},
            'windows', '11', 'amd64', '2.0.0', 'online', 1, 2, 1, 1, 2, 1, now(), now() - interval '2 days')
    RETURNING id`);
  return row.id;
}

type Seeded = Record<string, string>;

/** One item of every category the boundary handles, plus survivors, on `deviceId`. */
async function seedEveryCategory(env: Env, deviceId: string): Promise<Seeded> {
  const org = env.organization.id;
  const partner = env.partner.id;
  const site = env.site.id;
  const user = env.user.id;
  const ids: Seeded = {};

  // §5.2 commands, with an owning script execution.
  const script = await one<{ id: string }>(sql`
    INSERT INTO scripts (org_id, name, os_types, language, content)
    VALUES (${org}, ${`boundary-${randomUUID()}`}, ARRAY['windows'], 'powershell', 'Write-Output 1') RETURNING id`);
  ids.scriptExecution = (await one<{ id: string }>(sql`
    INSERT INTO script_executions (script_id, device_id, org_id, triggered_by, trigger_type, status)
    VALUES (${script.id}, ${deviceId}, ${org}, ${user}, 'manual', 'pending') RETURNING id`)).id;
  ids.commandPending = (await one<{ id: string }>(sql`
    INSERT INTO device_commands (device_id, type, status, payload)
    VALUES (${deviceId}, 'script', 'pending', ${JSON.stringify({ executionId: ids.scriptExecution, scriptId: script.id })}::jsonb)
    RETURNING id`)).id;
  ids.commandSent = (await one<{ id: string }>(sql`
    INSERT INTO device_commands (device_id, type, status) VALUES (${deviceId}, 'refresh_inventory', 'sent') RETURNING id`)).id;
  ids.commandUninstall = (await one<{ id: string }>(sql`
    INSERT INTO device_commands (device_id, type, status) VALUES (${deviceId}, 'self_uninstall', 'pending') RETURNING id`)).id;
  ids.commandTimedOut = (await one<{ id: string }>(sql`
    INSERT INTO device_commands (device_id, type, status, result)
    VALUES (${deviceId}, 'script', 'failed', '{"status":"timeout","timedOutBy":"server"}'::jsonb) RETURNING id`)).id;
  ids.commandCompleted = (await one<{ id: string }>(sql`
    INSERT INTO device_commands (device_id, type, status) VALUES (${deviceId}, 'refresh_inventory', 'completed') RETURNING id`)).id;

  // §5.3 PAM: an un-actuated request with a pending approval, and an actuated one.
  ids.elevationPending = (await one<{ id: string }>(sql`
    INSERT INTO elevation_requests (org_id, site_id, partner_id, device_id, flow_type, subject_username, reason,
                                    target_executable_path, target_executable_hash, status)
    VALUES (${org}, ${site}, ${partner}, ${deviceId}, 'uac_intercept', 'fixture-user', 'boundary',
            'C:\\fixture.exe', ${HEX64}, 'pending') RETURNING id`)).id;
  ids.elevationApproval = (await one<{ id: string }>(sql`
    INSERT INTO approval_requests (user_id, requesting_client_label, action_label, action_tool_name, risk_tier,
                                   risk_summary, expires_at, elevation_request_id)
    VALUES (${user}, 'fixture', 'Elevate', 'pam', 'low', 'fixture', now() + interval '1 hour', ${ids.elevationPending})
    RETURNING id`)).id;
  ids.elevationActuated = (await one<{ id: string }>(sql`
    INSERT INTO elevation_requests (org_id, site_id, partner_id, device_id, flow_type, subject_username, reason,
                                    target_executable_path, target_executable_hash, status, approved_at)
    VALUES (${org}, ${site}, ${partner}, ${deviceId}, 'uac_intercept', 'fixture-user', 'boundary',
            'C:\\fixture.exe', ${HEX64}, 'approved', now()) RETURNING id`)).id;
  ids.actuation = (await one<{ id: string }>(sql`
    INSERT INTO pam_actuations (org_id, device_id, elevation_request_id, request_revision, generation,
                                desired_state, observed_state, target_executable_path, target_executable_hash, subject_username)
    VALUES (${org}, ${deviceId}, ${ids.elevationActuated}, 1, 1, 'active', 'verified_active',
            'C:\\fixture.exe', ${HEX64}, 'fixture-user') RETURNING id`)).id;

  // §5.4 backup and recovery.
  const config = await one<{ id: string }>(sql`
    INSERT INTO backup_configs (org_id, name, type, provider, provider_config)
    VALUES (${org}, ${`boundary-${randomUUID()}`}, 'file', 'local', '{}'::jsonb) RETURNING id`);
  ids.backupJobRunning = (await one<{ id: string }>(sql`
    INSERT INTO backup_jobs (config_id, device_id, org_id, status) VALUES (${config.id}, ${deviceId}, ${org}, 'running') RETURNING id`)).id;
  const doneJob = await one<{ id: string }>(sql`
    INSERT INTO backup_jobs (config_id, device_id, org_id, status) VALUES (${config.id}, ${deviceId}, ${org}, 'completed') RETURNING id`);
  ids.snapshot = (await one<{ id: string }>(sql`
    INSERT INTO backup_snapshots (job_id, device_id, snapshot_id, org_id, config_id, timestamp)
    VALUES (${doneJob.id}, ${deviceId}, ${`snap-${randomUUID()}`}, ${org}, ${config.id}, now() - interval '1 day') RETURNING id`)).id;
  ids.restoreJob = (await one<{ id: string }>(sql`
    INSERT INTO restore_jobs (device_id, restore_type, org_id, status, snapshot_id)
    VALUES (${deviceId}, 'selective', ${org}, 'pending', ${ids.snapshot}) RETURNING id`)).id;
  ids.verification = (await one<{ id: string }>(sql`
    INSERT INTO backup_verifications (org_id, device_id, backup_job_id, verification_type, status, started_at)
    VALUES (${org}, ${deviceId}, ${doneJob.id}, 'integrity', 'running', now()) RETURNING id`)).id;
  ids.recoveryToken = (await one<{ id: string }>(sql`
    INSERT INTO recovery_tokens (org_id, device_id, snapshot_id, token_hash, restore_type, expires_at, status)
    VALUES (${org}, ${deviceId}, ${ids.snapshot}, ${HEX64}, 'full', now() + interval '1 day', 'active') RETURNING id`)).id;
  ids.recoveryMedia = (await one<{ id: string }>(sql`
    INSERT INTO recovery_media_artifacts (org_id, token_id, snapshot_id, platform, architecture, status)
    VALUES (${org}, ${ids.recoveryToken}, ${ids.snapshot}, 'linux', 'amd64', 'ready') RETURNING id`)).id;
  ids.bareMetal = (await one<{ id: string }>(sql`
    INSERT INTO bare_metal_recoveries (org_id, device_id, identity, code_hash, code_expires_at, nonce_hash, status)
    VALUES (${org}, ${deviceId}, 'original', ${hex64()}, now() + interval '1 hour', ${hex64()}, 'restoring') RETURNING id`)).id;
  // The write session's reservation guard is a parent trigger: insert it without references.
  ids.storageSession = randomUUID();
  await withoutReferences(async (tx) => {
    await tx.execute(sql`
      INSERT INTO backup_storage_sessions (id, org_id, device_id, source_device_id, config_id, storage_identity, scope,
        use_file_index, token_hash, generation, max_calls, max_resolved_objects, expires_at, deadline,
        rate_calls_available, rate_objects_available, rate_refilled_at, job_id, reservation_snapshot_id, reservation_generation)
      VALUES (${ids.storageSession}, ${org}, ${deviceId}, ${deviceId}, ${config.id}, 'local::fixture', 'snapshot_write', false,
        ${hex64()}, 1, 10, 10, now() + interval '1 hour', now() + interval '2 hours',
        1, 1, now(), ${doneJob.id}, 'reserved-snap', 1)`);
  });
  ids.chain = (await one<{ id: string }>(sql`
    INSERT INTO backup_chains (org_id, device_id, config_id, chain_type, target_name, is_active)
    VALUES (${org}, ${deviceId}, ${config.id}, 'mssql', 'db1', true) RETURNING id`)).id;
  ids.reservedAuthorization = (await one<{ id: string }>(sql`
    INSERT INTO backup_restore_authorizations (org_id, snapshot_db_id, device_id, command_type, reason, resource_digest,
                                               audit_written_at, command_id)
    VALUES (${org}, ${ids.snapshot}, ${deviceId}, 'backup_restore', 'unattested', ${`sha256:${HEX64}`}, now(), ${randomUUID()})
    RETURNING id`)).id;

  // §5.5 grants, authorizations, directives, secrets.
  ids.diagPending = (await one<{ id: string }>(sql`
    INSERT INTO diagnostic_access_grants (org_id, device_id, requested_by_user_id, beneficiary_kind, beneficiary_id, source,
      request_expires_at, purpose, operations, scopes, duration_minutes, status)
    VALUES (${org}, ${deviceId}, ${user}, 'user', ${user}, 'manual', now() + interval '1 hour', 'fixture',
      ARRAY['list'], '["C:/"]'::jsonb, 60, 'pending_approval') RETURNING id`)).id;
  ids.diagApproval = (await one<{ id: string }>(sql`
    INSERT INTO approval_requests (user_id, requesting_client_label, action_label, action_tool_name, risk_tier,
                                   risk_summary, expires_at, diagnostic_access_grant_id)
    VALUES (${user}, 'fixture', 'Diagnose', 'diagnostic', 'low', 'fixture', now() + interval '1 hour', ${ids.diagPending})
    RETURNING id`)).id;
  ids.diagActive = (await one<{ id: string }>(sql`
    INSERT INTO diagnostic_access_grants (org_id, device_id, requested_by_user_id, beneficiary_kind, beneficiary_id, source,
      request_expires_at, purpose, operations, scopes, duration_minutes, status, approved_at, approved_by_user_id, expires_at)
    VALUES (${org}, ${deviceId}, ${user}, 'user', ${user}, 'manual', now() + interval '1 hour', 'fixture',
      ARRAY['list'], '["C:/"]'::jsonb, 60, 'active', now(), ${user}, now() + interval '30 minutes') RETURNING id`)).id;
  const policy = await one<{ id: string }>(sql`
    INSERT INTO software_policies (org_id, name, mode, rules) VALUES (${org}, ${`boundary-${randomUUID()}`}, 'audit', '[]'::jsonb) RETURNING id`);
  ids.remediationRequest = (await one<{ id: string }>(sql`
    INSERT INTO software_remediation_requests (org_id, policy_id, device_id, expires_at)
    VALUES (${org}, ${policy.id}, ${deviceId}, now() + interval '1 hour') RETURNING id`)).id;
  ids.rollbackDirective = (await one<{ id: string }>(sql`
    INSERT INTO agent_rollback_directives (org_id, device_id, platform, architecture, current_version, target_version,
      component_versions, release_manifest, manifest_signature, manifest_signing_key_id, artifacts, reason, authorized_by,
      approved_at, expires_at, directive_signing_key_id, directive_signature, status)
    VALUES (${org}, ${deviceId}, 'windows', 'amd64', '2.0.0', '1.9.0', '{}'::jsonb, 'm', 's', 'k', '[]'::jsonb, 'fixture',
      ${user}, now(), now() + interval '1 hour', 'k', 's', 'requested') RETURNING id`)).id;
  ids.provisionHandle = (await one<{ id: string }>(sql`
    INSERT INTO provision_credential_handles (token, org_id, device_id, credentials, expires_at)
    VALUES (${randomUUID()}, ${org}, ${deviceId}, '{"agentToken":"brz_secret"}'::jsonb, now() + interval '1 hour') RETURNING id`)).id;

  // §5.5 sessions and the helper's messaging surfaces.
  ids.remoteSession = (await one<{ id: string }>(sql`
    INSERT INTO remote_sessions (device_id, user_id, type, org_id, status)
    VALUES (${deviceId}, ${user}, 'terminal', ${org}, 'active') RETURNING id`)).id;
  ids.tunnel = (await one<{ id: string }>(sql`
    INSERT INTO tunnel_sessions (device_id, user_id, org_id, type, target_host, target_port, status)
    VALUES (${deviceId}, ${user}, ${org}, 'proxy', '127.0.0.1', 8080, 'active') RETURNING id`)).id;
  ids.chat = (await one<{ id: string }>(sql`
    INSERT INTO endpoint_conversations (org_id, device_id, status, allow_user_reply)
    VALUES (${org}, ${deviceId}, 'open', true) RETURNING id`)).id;
  ids.messageDelivery = (await one<{ id: string }>(sql`
    INSERT INTO endpoint_message_deliveries (org_id, device_id, status) VALUES (${org}, ${deviceId}, 'queued') RETURNING id`)).id;

  // §5.6 AI and automation work in flight (parents too expensive to build: FKs off).
  ids.intent = randomUUID();
  ids.aiTask = randomUUID();
  ids.aiTarget = randomUUID();
  ids.fixWatch = randomUUID();
  ids.playbook = randomUUID();
  ids.arm = randomUUID();
  ids.callerVerification = randomUUID();
  await withoutReferences(async (tx) => {
    await tx.execute(sql`
      INSERT INTO action_intents (id, org_id, source, action_name, argument_digest, target_summary, impact_summary, risk_tier,
        idempotency_key, correlation_id, expires_at, status, scope_kind, scope_device_id, origin_principal_kind, requested_by_user_id)
      VALUES (${ids.intent}, ${org}, 'chat', 'fixture_action', ${HEX64}, 't', 'i', 1, ${randomUUID()}, ${randomUUID()},
        now() + interval '1 hour', 'approved', 'device', ${deviceId}, 'user_session', ${user})`);
    await tx.execute(sql`
      INSERT INTO ai_operator_tasks (id, org_id, agent_id, agent_kind, agent_name, workflow_key, origin_kind, objective, state, device_id)
      VALUES (${ids.aiTask}, ${org}, ${randomUUID()}, 'k', 'n', 'w', 'manual', 'fixture', 'running', ${deviceId})`);
    await tx.execute(sql`
      INSERT INTO ai_operator_task_targets (id, org_id, task_id, target_kind, target_label, target_ordinal, device_id, state)
      VALUES (${ids.aiTarget}, ${org}, ${ids.aiTask}, 'device', 'target', 0, ${deviceId}, 'active')`);
    await tx.execute(sql`
      INSERT INTO ai_agent_fix_watches (id, org_id, partner_id, agent_id, run_id, device_id, state)
      VALUES (${ids.fixWatch}, ${org}, ${partner}, ${randomUUID()}, ${randomUUID()}, ${deviceId}, 'watching')`);
    await tx.execute(sql`
      INSERT INTO playbook_executions (id, org_id, device_id, playbook_id, triggered_by, status)
      VALUES (${ids.playbook}, ${org}, ${deviceId}, ${randomUUID()}, 'manual', 'running')`);
    await tx.execute(sql`
      INSERT INTO topology_telemetry_arms (id, org_id, site_id, producer_kind, target_node_id, collector_device_id, credential_profile_id,
        authority_key, target_address, credential_digest, interfaces, armed_by, authority_actor, authority_permission_version,
        effect_digest, expires_at, state)
      VALUES (${ids.arm}, ${org}, ${site}, 'snmp', ${randomUUID()}, ${deviceId}, ${randomUUID()}, ${`snmp:${randomUUID()}`},
        '10.0.0.1', ${HEX64}, '[1]'::jsonb, ${user}, '{}'::jsonb, 'v1', ${HEX64}, now() + interval '1 day', 'armed')`);
    await tx.execute(sql`
      INSERT INTO caller_verifications (id, org_id, contact_id, initiated_by_user_id, technician_label, action_scope, method,
        tier, tier_reason, match_value, decoy_values, reverse_code, attempt_no, expires_at, workstation_device_ref, status)
      VALUES (${ids.callerVerification}, ${org}, ${randomUUID()}, ${user}, 'tech', 'any', 'workstation', 1, 'fixture',
        '12', ARRAY['34','56']::bpchar[], '1234', 1, now() + interval '1 hour', ${deviceId}, 'verified')`);
  });
  ids.cleanupRun = (await one<{ id: string }>(sql`
    INSERT INTO device_filesystem_cleanup_runs (device_id, org_id, status) VALUES (${deviceId}, ${org}, 'previewed') RETURNING id`)).id;
  const patch = await one<{ id: string }>(sql`
    INSERT INTO patches (source, external_id, title) VALUES ('custom', ${`boundary-${randomUUID()}`}, 'Fixture patch') RETURNING id`);
  ids.patchRollback = (await one<{ id: string }>(sql`
    INSERT INTO patch_rollbacks (device_id, patch_id, status) VALUES (${deviceId}, ${patch.id}, 'pending') RETURNING id`)).id;
  ids.securityScan = (await one<{ id: string }>(sql`
    INSERT INTO security_scans (device_id, scan_type, status, org_id) VALUES (${deviceId}, 'quick', 'running', ${org}) RETURNING id`)).id;
  ids.sensitiveScan = (await one<{ id: string }>(sql`
    INSERT INTO sensitive_data_scans (org_id, device_id, status) VALUES (${org}, ${deviceId}, 'queued') RETURNING id`)).id;
  ids.restorePoint = (await one<{ id: string }>(sql`
    INSERT INTO device_restore_point_attempts (request_id, org_id, device_id, trigger, status)
    VALUES (${randomUUID()}, ${org}, ${deviceId}, 'script', 'requested') RETURNING id`)).id;
  ids.vault = (await one<{ id: string }>(sql`
    INSERT INTO local_vaults (org_id, device_id, vault_path, last_sync_status) VALUES (${org}, ${deviceId}, 'D:\\vault', 'pending') RETURNING id`)).id;

  // §5.7 install-specific state.
  ids.devicePatch = (await one<{ id: string }>(sql`
    INSERT INTO device_patches (device_id, patch_id, org_id, status) VALUES (${deviceId}, ${patch.id}, ${org}, 'installed') RETURNING id`)).id;
  const deployment = await one<{ id: string }>(sql`
    INSERT INTO deployments (org_id, name, type, payload, target_type, target_config, rollout_config)
    VALUES (${org}, 'fixture', 'software', '{}'::jsonb, 'devices', '{}'::jsonb, '{}'::jsonb) RETURNING id`);
  ids.deploymentDevice = (await one<{ id: string }>(sql`
    INSERT INTO deployment_devices (deployment_id, device_id, status, started_at)
    VALUES (${deployment.id}, ${deviceId}, 'running', now()) RETURNING id`)).id;
  ids.cisAction = (await one<{ id: string }>(sql`
    INSERT INTO cis_remediation_actions (org_id, device_id, check_id, action, status)
    VALUES (${org}, ${deviceId}, '1.1.1', 'apply', 'queued') RETURNING id`)).id;
  await exec(sql`
    INSERT INTO peripheral_policy_device_states (device_id, org_id, desired_phase, desired_revision, desired_digest, desired_envelope,
      delivery_status, applied_phase, applied_revision, applied_digest)
    VALUES (${deviceId}, ${org}, 'enforce', 3, ${`sha256:${HEX64}`}, '{}'::jsonb, 'applied', 'enforce', 3, ${`sha256:${HEX64}`})`);
  await exec(sql`
    INSERT INTO device_software_inventory_state (device_id, org_id, has_accepted_v2, visible_item_count)
    VALUES (${deviceId}, ${org}, true, 400)`);
  await exec(sql`
    INSERT INTO device_time_status (device_id, org_id, collected_at, received_at, last_sequence)
    VALUES (${deviceId}, ${org}, now(), now(), 900)`);
  await exec(sql`
    INSERT INTO device_filesystem_scan_state (device_id, org_id, scan_path) VALUES (${deviceId}, ${org}, 'C:\\')`);
  await exec(sql`INSERT INTO onedrive_device_state (device_id, org_id) VALUES (${deviceId}, ${org})`);
  ids.compliance = (await one<{ id: string }>(sql`
    INSERT INTO software_compliance_status (device_id, policy_id, last_checked, status, remediation_status)
    VALUES (${deviceId}, ${policy.id}, now(), 'violation', 'in_progress') RETURNING id`)).id;
  ids.deviceSession = (await one<{ id: string }>(sql`
    INSERT INTO device_sessions (org_id, device_id, username, is_active, login_at)
    VALUES (${org}, ${deviceId}, 'alice', true, now() - interval '2 hours') RETURNING id`)).id;

  // Survivors (§5.1): membership and history.
  const group = await one<{ id: string }>(sql`
    INSERT INTO device_groups (org_id, name) VALUES (${org}, ${`boundary-${randomUUID()}`}) RETURNING id`);
  await exec(sql`
    INSERT INTO device_group_memberships (device_id, group_id, org_id) VALUES (${deviceId}, ${group.id}, ${org})`);
  ids.alert = (await one<{ id: string }>(sql`
    INSERT INTO alerts (device_id, org_id, severity, title) VALUES (${deviceId}, ${org}, 'low', 'history') RETURNING id`)).id;

  return ids;
}

async function value<T>(query: ReturnType<typeof sql>): Promise<T | undefined> {
  const [row] = await exec<{ v: T }>(query);
  return row?.v;
}

async function countWhere(table: string, column: string, deviceId: string): Promise<number> {
  const [row] = await exec<{ n: number }>(sql`SELECT count(*)::int AS n FROM ${sql.identifier(table)} WHERE ${sql.identifier(column)} = ${deviceId}::uuid`);
  return row!.n;
}

/** Snapshot of the state every handled category leaves behind, read as the superuser. */
async function stateOf(ids: Seeded, deviceId: string) {
  return {
    commandPending: await value<string>(sql`SELECT status AS v FROM device_commands WHERE id = ${ids.commandPending}`),
    commandPendingReason: await value<string>(sql`SELECT result->>'reason' AS v FROM device_commands WHERE id = ${ids.commandPending}`),
    commandSent: await value<string>(sql`SELECT status AS v FROM device_commands WHERE id = ${ids.commandSent}`),
    commandUninstall: await value<string>(sql`SELECT status AS v FROM device_commands WHERE id = ${ids.commandUninstall}`),
    commandTimedOut: await value<string>(sql`SELECT status AS v FROM device_commands WHERE id = ${ids.commandTimedOut}`),
    commandCompleted: await value<string>(sql`SELECT status AS v FROM device_commands WHERE id = ${ids.commandCompleted}`),
    scriptExecution: await value<string>(sql`SELECT status::text AS v FROM script_executions WHERE id = ${ids.scriptExecution}`),
    elevationPending: await value<string>(sql`SELECT status::text AS v FROM elevation_requests WHERE id = ${ids.elevationPending}`),
    elevationActuated: await value<string>(sql`SELECT status::text AS v FROM elevation_requests WHERE id = ${ids.elevationActuated}`),
    elevationApproval: await value<string>(sql`SELECT status::text AS v FROM approval_requests WHERE id = ${ids.elevationApproval}`),
    actuation: await value<string>(sql`SELECT observed_state || '/' || desired_state || '/' || coalesce(failure_code, '-') || '/' || generation AS v FROM pam_actuations WHERE id = ${ids.actuation}`),
    backupJobRunning: await value<string>(sql`SELECT status::text AS v FROM backup_jobs WHERE id = ${ids.backupJobRunning}`),
    restoreJob: await value<string>(sql`SELECT status::text AS v FROM restore_jobs WHERE id = ${ids.restoreJob}`),
    verification: await value<string>(sql`SELECT status AS v FROM backup_verifications WHERE id = ${ids.verification}`),
    recoveryToken: await value<string>(sql`SELECT status AS v FROM recovery_tokens WHERE id = ${ids.recoveryToken}`),
    recoveryMedia: await value<string>(sql`SELECT status AS v FROM recovery_media_artifacts WHERE id = ${ids.recoveryMedia}`),
    bareMetal: await value<string>(sql`SELECT status || '/' || coalesce(failure_reason, '-') AS v FROM bare_metal_recoveries WHERE id = ${ids.bareMetal}`),
    storageSessionRevoked: await value<boolean>(sql`SELECT revoked_at IS NOT NULL AS v FROM backup_storage_sessions WHERE id = ${ids.storageSession}`),
    chainActive: await value<boolean>(sql`SELECT is_active AS v FROM backup_chains WHERE id = ${ids.chain}`),
    reservedAuthorization: await value<number>(sql`SELECT count(*)::int AS v FROM backup_restore_authorizations WHERE id = ${ids.reservedAuthorization}`),
    diagPending: await value<string>(sql`SELECT status::text AS v FROM diagnostic_access_grants WHERE id = ${ids.diagPending}`),
    diagActive: await value<string>(sql`SELECT status::text AS v FROM diagnostic_access_grants WHERE id = ${ids.diagActive}`),
    diagApproval: await value<string>(sql`SELECT status::text AS v FROM approval_requests WHERE id = ${ids.diagApproval}`),
    callerVerification: await value<string>(sql`SELECT status::text AS v FROM caller_verifications WHERE id = ${ids.callerVerification}`),
    remediationUsable: await value<boolean>(sql`SELECT expires_at > now() + interval '1 second' AS v FROM software_remediation_requests WHERE id = ${ids.remediationRequest}`),
    rollbackDirective: await value<string>(sql`SELECT status AS v FROM agent_rollback_directives WHERE id = ${ids.rollbackDirective}`),
    provisionHandles: await countWhere('provision_credential_handles', 'device_id', deviceId),
    remoteSession: await value<string>(sql`SELECT status::text AS v FROM remote_sessions WHERE id = ${ids.remoteSession}`),
    tunnel: await value<string>(sql`SELECT status::text AS v FROM tunnel_sessions WHERE id = ${ids.tunnel}`),
    chat: await value<string>(sql`SELECT status || '/' || coalesce(close_reason, '-') AS v FROM endpoint_conversations WHERE id = ${ids.chat}`),
    messageDelivery: await value<string>(sql`SELECT status AS v FROM endpoint_message_deliveries WHERE id = ${ids.messageDelivery}`),
    intentScopedToDevice: await value<boolean>(sql`SELECT scope_device_id IS NOT NULL AS v FROM action_intents WHERE id = ${ids.intent}`),
    aiTask: await value<string>(sql`SELECT state || '/' || coalesce(target_detached_reason, '-') AS v FROM ai_operator_tasks WHERE id = ${ids.aiTask}`),
    aiTarget: await value<string>(sql`SELECT state || '/' || coalesce(detached_reason, '-') AS v FROM ai_operator_task_targets WHERE id = ${ids.aiTarget}`),
    fixWatch: await value<string>(sql`SELECT state AS v FROM ai_agent_fix_watches WHERE id = ${ids.fixWatch}`),
    playbook: await value<string>(sql`SELECT status::text AS v FROM playbook_executions WHERE id = ${ids.playbook}`),
    arm: await value<string>(sql`SELECT state || '/' || coalesce(blocked_reason, '-') AS v FROM topology_telemetry_arms WHERE id = ${ids.arm}`),
    cleanupRun: await value<string>(sql`SELECT status::text AS v FROM device_filesystem_cleanup_runs WHERE id = ${ids.cleanupRun}`),
    patchRollback: await value<string>(sql`SELECT status::text AS v FROM patch_rollbacks WHERE id = ${ids.patchRollback}`),
    securityScan: await value<string>(sql`SELECT status AS v FROM security_scans WHERE id = ${ids.securityScan}`),
    sensitiveScan: await value<string>(sql`SELECT status AS v FROM sensitive_data_scans WHERE id = ${ids.sensitiveScan}`),
    restorePoint: await value<string>(sql`SELECT status AS v FROM device_restore_point_attempts WHERE id = ${ids.restorePoint}`),
    vault: await value<string>(sql`SELECT last_sync_status AS v FROM local_vaults WHERE id = ${ids.vault}`),
    devicePatches: await countWhere('device_patches', 'device_id', deviceId),
    deploymentDevice: await value<string>(sql`SELECT status::text AS v FROM deployment_devices WHERE id = ${ids.deploymentDevice}`),
    cisAction: await value<string>(sql`SELECT status::text AS v FROM cis_remediation_actions WHERE id = ${ids.cisAction}`),
    peripheral: await value<string>(sql`SELECT delivery_status || '/' || coalesce(applied_digest, '-') AS v FROM peripheral_policy_device_states WHERE device_id = ${deviceId}`),
    softwareGate: await countWhere('device_software_inventory_state', 'device_id', deviceId),
    timeStatus: await countWhere('device_time_status', 'device_id', deviceId),
    scanState: await countWhere('device_filesystem_scan_state', 'device_id', deviceId),
    onedrive: await countWhere('onedrive_device_state', 'device_id', deviceId),
    compliance: await countWhere('software_compliance_status', 'device_id', deviceId),
    deviceSession: await value<boolean>(sql`SELECT is_active AS v FROM device_sessions WHERE id = ${ids.deviceSession}`),
    groupMembership: await countWhere('device_group_memberships', 'device_id', deviceId),
    alerts: await countWhere('alerts', 'device_id', deviceId),
  };
}

const UNTOUCHED = {
  commandPending: 'pending',
  commandPendingReason: null as string | null,
  commandSent: 'sent',
  commandUninstall: 'pending',
  commandTimedOut: 'failed',
  commandCompleted: 'completed',
  scriptExecution: 'pending',
  elevationPending: 'pending',
  elevationActuated: 'approved',
  elevationApproval: 'pending',
  actuation: 'verified_active/active/-/1',
  backupJobRunning: 'running',
  restoreJob: 'pending',
  verification: 'running',
  recoveryToken: 'active',
  recoveryMedia: 'ready',
  bareMetal: 'restoring/-',
  storageSessionRevoked: false,
  chainActive: true,
  reservedAuthorization: 1,
  diagPending: 'pending_approval',
  diagActive: 'active',
  diagApproval: 'pending',
  callerVerification: 'verified',
  remediationUsable: true,
  rollbackDirective: 'requested',
  provisionHandles: 1,
  remoteSession: 'active',
  tunnel: 'active',
  chat: 'open/-',
  messageDelivery: 'queued',
  intentScopedToDevice: true,
  aiTask: 'running/-',
  aiTarget: 'active/-',
  fixWatch: 'watching',
  playbook: 'running',
  arm: 'armed/-',
  cleanupRun: 'previewed',
  patchRollback: 'pending',
  securityScan: 'running',
  sensitiveScan: 'queued',
  restorePoint: 'requested',
  vault: 'pending',
  devicePatches: 1,
  deploymentDevice: 'running',
  cisAction: 'queued',
  peripheral: `applied/sha256:${HEX64}`,
  softwareGate: 1,
  timeStatus: 1,
  scanState: 1,
  onedrive: 1,
  compliance: 1,
  deviceSession: true,
  groupMembership: 1,
  alerts: 1,
};

function runBoundary(deviceId: string, expectedIncarnation: number, actorUserId: string | null) {
  return withSystemDbAccessContext(() =>
    runInstallIncarnationBoundary({ deviceId, expectedIncarnation, actorUserId }),
  );
}

describe('install incarnation boundary — every category (#8318 §5, §5.8)', () => {
  it('invalidates every handled category on the target, keeps configuration and history, and leaves other devices alone', async () => {
    const env = await setupTestEnvironment();
    const target = await makeDevice(env);
    const control = await makeDevice(env);
    const targetIds = await seedEveryCategory(env, target);
    const controlIds = await seedEveryCategory(env, control);

    expect(await stateOf(targetIds, target)).toEqual(UNTOUCHED);

    const result = await runBoundary(target, 1, env.user.id);
    expect(result.previousIncarnation).toBe(1);
    expect(result.newIncarnation).toBe(2);
    expect(result.counts.commands.device_commands).toBe(3);

    expect(await stateOf(targetIds, target)).toEqual({
      commandPending: 'cancelled',
      commandPendingReason: 'superseded_by_reattach',
      commandSent: 'cancelled',
      commandUninstall: 'cancelled',
      commandTimedOut: 'failed', // terminal already; refused by the incarnation check below
      commandCompleted: 'completed',
      scriptExecution: 'cancelled',
      elevationPending: 'expired',
      elevationActuated: 'expired',
      elevationApproval: 'expired',
      actuation: 'failed/cleanup/superseded_by_reinstall/2',
      backupJobRunning: 'cancelled',
      restoreJob: 'cancelled',
      verification: 'failed',
      recoveryToken: 'revoked',
      recoveryMedia: 'expired',
      bareMetal: 'failed/superseded_by_reattach',
      storageSessionRevoked: true,
      chainActive: false,
      reservedAuthorization: 0,
      diagPending: 'expired',
      diagActive: 'revoked',
      diagApproval: 'expired',
      callerVerification: 'revoked',
      remediationUsable: false,
      rollbackDirective: 'expired',
      provisionHandles: 0,
      remoteSession: 'disconnected',
      tunnel: 'disconnected',
      chat: 'closed/device_reinstalled',
      messageDelivery: 'superseded',
      intentScopedToDevice: false,
      aiTask: 'stopping/device_reinstalled',
      aiTarget: 'detached/device_reinstalled',
      fixWatch: 'cancelled',
      playbook: 'cancelled',
      arm: 'blocked/collector_reinstalled',
      cleanupRun: 'failed',
      patchRollback: 'cancelled',
      securityScan: 'failed',
      sensitiveScan: 'failed',
      restorePoint: 'failed',
      vault: 'failed',
      devicePatches: 0,
      deploymentDevice: 'pending',
      cisAction: 'cancelled',
      peripheral: 'rejected/-',
      softwareGate: 0,
      timeStatus: 0,
      scanState: 0,
      onedrive: 0,
      compliance: 0,
      deviceSession: false,
      // §5.1 survivors.
      groupMembership: 1,
      alerts: 1,
    });

    // The control device in the same org is untouched.
    expect(await stateOf(controlIds, control)).toEqual(UNTOUCHED);

    // The device row: incarnation advanced, the null rule satisfied, capabilities forgotten.
    const [row] = await getTestDb().select().from(devices).where(eq(devices.id, target));
    expect(row!.installIncarnation).toBe(2);
    expect(row!.incarnationStartedAt).toBeInstanceOf(Date);
    expect(row!.lastReattachedAt).toBeInstanceOf(Date);
    expect(row!.scriptSecretEnvVersion).toBe(0);
    expect(row!.pamLifetimeProtocolVersion).toBe(0);
    expect(row!.rollbackProtocolVersion).toBe(0);
    expect(row!.backupReadProtocolVersion).toBeNull();
    expect(row!.backupIntegrityProtocolVersion).toBeNull();
    expect(row!.editionMigrationDispatchedAt).toBeNull();
    // The old install's uninstall intent would let the reaper decommission the row again.
    expect(row!.uninstallIntentAt).toBeNull();
    const [controlRow] = await getTestDb().select().from(devices).where(eq(devices.id, control));
    expect(controlRow!.uninstallIntentAt).toBeInstanceOf(Date);
    expect(controlRow!.installIncarnation).toBe(1);
    // Identity is wave 1b's: the boundary does not touch the agent id or the org.
    expect(row!.orgId).toBe(env.organization.id);
  });

  it('nothing of the old install reaches the new install’s first heartbeat; fresh work does', async () => {
    const env = await setupTestEnvironment();
    const target = await makeDevice(env);
    const ids = await seedEveryCategory(env, target);
    await runBoundary(target, 1, env.user.id);

    // A command enqueued AFTER the boundary is stamped for the new install and delivered.
    const [fresh] = await getTestDb()
      .insert(deviceCommands)
      .values({ deviceId: target, type: 'refresh_inventory' })
      .returning({ id: deviceCommands.id, deviceIncarnation: deviceCommands.deviceIncarnation });
    expect(fresh!.deviceIncarnation).toBe(2);
    const claimed = await withSystemDbAccessContext(() =>
      claimPendingCommandsForDevice(target, 10, 'agent', undefined, { ...AGENT_CAPS }),
    );
    expect(claimed.map((c) => c.id)).toEqual([fresh!.id]);

    // A late result for the old install's work — including the server-timed-out
    // row the #3607 path would otherwise reopen — is refused.
    const acceptable = await getTestDb()
      .select({ id: deviceCommands.id })
      .from(deviceCommands)
      .where(sql`${deviceCommands.deviceId} = ${target} AND ${commandAcceptsAgentResultCondition()}`);
    // Only the fresh command (now `sent`) accepts a result.
    expect(acceptable.map((r) => r.id)).toEqual([fresh!.id]);
    expect(acceptable.map((r) => r.id)).not.toContain(ids.commandTimedOut);
    expect(acceptable.map((r) => r.id)).not.toContain(ids.commandSent);

    // PAM: a later expiry, revoke or policy removal cannot send a cleanup to the new install.
    const outbox = () => value<number>(sql`SELECT count(*)::int AS v FROM intent_outbox WHERE pam_actuation_id = ${ids.actuation}`);
    const outboxBefore = await outbox();
    await withSystemDbAccessContext(() =>
      db.transaction((tx) => requestPamCleanup(tx, { elevationRequestId: ids.elevationActuated!, cause: 'expired' })),
    );
    expect(await value<string>(sql`SELECT observed_state || '/' || generation AS v FROM pam_actuations WHERE id = ${ids.actuation}`))
      .toBe('failed/2');
    expect(await outbox()).toBe(outboxBefore);
  });

  it('a snapshot taken by the old install loses the producer-only free pass; a never-reattached device keeps it', async () => {
    const env = await setupTestEnvironment();
    const target = await makeDevice(env);
    const ids = await seedEveryCategory(env, target);
    const job = await value<string>(sql`SELECT job_id::text AS v FROM backup_snapshots WHERE id = ${ids.snapshot}`);
    const provider = await value<string>(sql`SELECT snapshot_id AS v FROM backup_snapshots WHERE id = ${ids.snapshot}`);
    await exec(sql`UPDATE backup_snapshots SET storage_identity = 'local::fixture' WHERE id = ${ids.snapshot}`);
    await exec(sql`
      INSERT INTO backup_snapshot_attestations (org_id, snapshot_db_id, device_id, job_id, provider_snapshot_id,
        storage_identity, key_layout, verification_mode, accepted_via, result_received_at, format_version, statement,
        statement_sha256, status, manifest_key, manifest_sha256, manifest_size)
      SELECT org_id, id, device_id, job_id, snapshot_id, storage_identity, 'legacy_flat', 'producer_only', 'agent_result',
             now(), 1, 'fixture', ${HEX64}, 'producer_only', 'snapshots/' || snapshot_id || '/manifest.json', ${HEX64}, 10
        FROM backup_snapshots WHERE id = ${ids.snapshot}`);
    expect(job && provider).toBeTruthy();

    const decide = async () => {
      const integrity = await withSystemDbAccessContext(() => resolveRestoreIntegrity(ids.snapshot!));
      return decideRestoreGate({ commandType: 'backup_restore', integrity, targetDeviceId: target });
    };
    expect(await decide()).toEqual({ kind: 'allow' });

    await runBoundary(target, 1, env.user.id);
    expect(await decide()).toEqual({ kind: 'authorization_required', reason: 'producer_only_other_target' });
  });

  it('dates snapshots against the incarnation in UTC, whatever the session TimeZone', async () => {
    const env = await setupTestEnvironment();
    const target = await makeDevice(env);
    const ids = await seedEveryCategory(env, target);
    await runBoundary(target, 1, null);
    const [targetRow] = await getTestDb().select().from(devices).where(eq(devices.id, target));
    const started = targetRow!.incarnationStartedAt;
    const predates = async (snapshotAt: Date, timeZone: string) =>
      getTestDb().transaction(async (tx) => {
        await tx.execute(sql`SELECT set_config('TimeZone', ${timeZone}, true)`);
        // Written the way the app writes it: drizzle stores UTC wall-clock in a `timestamp` column.
        await tx.update(backupSnapshots).set({ timestamp: snapshotAt }).where(eq(backupSnapshots.id, ids.snapshot!));
        const [row] = await tx
          .select({ v: snapshotPredatesDeviceIncarnationSql() })
          .from(backupSnapshots)
          .where(eq(backupSnapshots.id, ids.snapshot!));
        return row!.v;
      });
    const hourBefore = new Date(started!.getTime() - 60 * 60_000);
    const hourAfter = new Date(started!.getTime() + 60 * 60_000);
    for (const zone of ['UTC', 'Pacific/Honolulu', 'Pacific/Kiritimati']) {
      expect(await predates(hourBefore, zone), `${zone}: an old-install snapshot`).toBe(true);
      expect(await predates(hourAfter, zone), `${zone}: a new-install snapshot`).toBe(false);
    }
  });

  it('a command enqueued before the boundary takes its lock is cancelled by it (§4.2, insert first)', async () => {
    const env = await setupTestEnvironment();
    const target = await makeDevice(env);
    const inserter = postgres(process.env.DATABASE_URL!, { max: 1, onnotice: () => {} });
    try {
      let boundary: Promise<unknown> | undefined;
      const commandId = await inserter.begin(async (tx) => {
        const [row] = await tx<{ id: string; device_incarnation: number }[]>`
          INSERT INTO device_commands (device_id, type) VALUES (${target}, 'refresh_inventory')
          RETURNING id, device_incarnation`;
        expect(row!.device_incarnation).toBe(1);
        // The boundary now queues behind this insert's KEY SHARE on the device row.
        boundary = runBoundary(target, 1, null);
        boundary.catch(() => {});
        const deadline = Date.now() + 10_000;
        for (;;) {
          const [waiting] = await exec<{ n: number }>(sql`
            SELECT count(*)::int AS n FROM pg_stat_activity
             WHERE wait_event_type = 'Lock' AND query ILIKE '%"devices"%for update%'`);
          if ((waiting?.n ?? 0) > 0) break;
          if (Date.now() > deadline) throw new Error('the boundary never queued behind the insert');
          await new Promise((r) => setTimeout(r, 25));
        }
        return row!.id;
      });
      await boundary;
      const cancelled = await one<{ status: string; reason: string }>(sql`
        SELECT status, result->>'reason' AS reason FROM device_commands WHERE id = ${commandId}`);
      expect(cancelled).toEqual({ status: 'cancelled', reason: 'superseded_by_reattach' });
    } finally {
      await inserter.end({ timeout: 5 });
    }
  });

  it('is all-or-nothing: a failure after it rolls every handler back', async () => {
    const env = await setupTestEnvironment();
    const target = await makeDevice(env);
    const ids = await seedEveryCategory(env, target);
    await expect(
      withSystemDbAccessContext(async () => {
        await runInstallIncarnationBoundary({ deviceId: target, expectedIncarnation: 1, actorUserId: null });
        throw new Error('confirm failed after the boundary');
      }),
    ).rejects.toThrow('confirm failed after the boundary');
    expect(await stateOf(ids, target)).toEqual(UNTOUCHED);
    expect(await value<number>(sql`SELECT install_incarnation AS v FROM devices WHERE id = ${target}`)).toBe(1);
  });

  it('refuses a stale version and advances one incarnation at a time', async () => {
    const env = await setupTestEnvironment();
    const target = await makeDevice(env);
    await runBoundary(target, 1, null);
    await expect(runBoundary(target, 1, null)).rejects.toBeInstanceOf(InstallBoundaryRefusedError);
    await expect(runBoundary(target, 1, null)).rejects.toMatchObject({ code: 'incarnation_changed' });
    const second = await runBoundary(target, 2, null);
    expect(second.newIncarnation).toBe(3);
    await expect(runBoundary(randomUUID(), 1, null)).rejects.toMatchObject({ code: 'device_not_found' });
  });
});
