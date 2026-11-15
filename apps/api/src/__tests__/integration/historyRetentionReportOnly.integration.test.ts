/**
 * #4342 W6.c — the ten second-pass history retention targets against real
 * Postgres, through the unprivileged `breeze_app` pool (forced RLS).
 *
 * They are REPORT-ONLY BY CONSTRUCTION (`action: { kind: 'reportOnly' }`). This
 * file loads every W5 `_ENFORCE` flag AND a stray `<NAME>_RETENTION_ENFORCE`
 * for each second-pass name set to 'true' (hoisted, before import): the "no
 * configuration deletes" setup. Each target must still only count, and every
 * seeded row must survive. A count that forgot to elect system scope would see
 * zero rows, so every `eligible > 0` assertion also proves system scope works.
 *
 * Rows are seeded through the superuser client (`getTestDb`) with raw SQL.
 * `setup.ts` truncates the tenant roots between tests.
 */
import { vi } from 'vitest';

vi.hoisted(() => {
  // The twelve W5 targets, all enforcing.
  for (const name of [
    'AI_AGENT_RUN', 'PATCH_JOB_RESULT', 'SECURITY_POSTURE_SNAPSHOT', 'CIS_BASELINE_RESULT',
    'AUTOMATION_RUN', 'REPORT_RUN', 'USER_NOTIFICATION_READ', 'USER_NOTIFICATION',
    'REMOTE_SESSION', 'SUPPORT_SESSION', 'AUTH_SESSION', 'NETWORK_CHANGE_EVENT',
  ]) {
    process.env[`${name}_RETENTION_ENFORCE`] = 'true';
  }
  // A stray enforce flag for each second-pass target: it must change nothing.
  for (const name of [
    'SSO_SESSION', 'C2C_CONSENT_SESSION', 'TUNNEL_SESSION', 'UNIFI_SYNC_RUN', 'FLEET_REMEDIATION_RUN',
    'TICKET_IMPORT_RUN', 'TOPOLOGY_DIAGNOSTIC_RUN', 'AUDIT_BASELINE_RESULT',
    'PERIPHERAL_POLICY_DELIVERY_EVENT', 'ML_FEEDBACK_EVENT',
  ]) {
    process.env[`${name}_RETENTION_ENFORCE`] = 'true';
  }
  // Below the 30-day user-risk lookback: the job must floor it back to 30.
  process.env.AUTH_SESSION_RETENTION_DAYS = '7';
});

import './setup';

import { randomBytes, randomUUID } from 'node:crypto';
import { afterEach, beforeEach, describe, expect, it, vi as vitest } from 'vitest';
import { sql, type SQL } from 'drizzle-orm';

import {
  HISTORY_REPORT_ONLY_TARGETS,
  HISTORY_RETENTION_TARGETS,
  runHistoryRetention,
} from '../../jobs/historyRetention';
import { runRetentionTarget, type RetentionTargetResult } from '../../jobs/retentionTarget';
import { createDevice, createOrganization, createPartner, createSite, createUser } from './db-utils';
import { getTestDb } from './setup';

const DAY_MS = 24 * 60 * 60 * 1000;
const HOUR_MS = 60 * 60 * 1000;
const NOW = Date.now();
const daysAgo = (d: number) => new Date(NOW - d * DAY_MS);
/** One hour past / inside a `days`-day cutoff. */
const justPast = (days: number) => new Date(NOW - days * DAY_MS - HOUR_MS);
const justInside = (days: number) => new Date(NOW - days * DAY_MS + HOUR_MS);
const inFuture = (days: number) => new Date(NOW + days * DAY_MS);

/** `timestamptz` value. */
const tsz = (d: Date): SQL => sql`${d.toISOString()}::timestamptz`;
/** `timestamp without time zone` holding UTC wall time (what the drizzle columns write). */
const tsu = (d: Date): SQL => sql`(${d.toISOString()}::timestamptz AT TIME ZONE 'UTC')`;
const hex64 = () => randomBytes(32).toString('hex');

interface Seed {
  orgId: string;
  partnerId: string;
  siteId: string;
  userId: string;
  deviceId: string;
}

async function exec(q: SQL): Promise<void> {
  await getTestDb().execute(q);
}

async function surviving(table: string, ids: string[]): Promise<Set<string>> {
  const list = sql.join(ids.map((id) => sql`${id}::uuid`), sql`, `);
  const rows = await getTestDb().execute(
    sql`SELECT id FROM ${sql.identifier(table)} WHERE id IN (${list})`,
  ) as unknown as Array<{ id: string }>;
  return new Set(rows.map((r) => r.id));
}

// ---------------------------------------------------------------------------
// Per-table seeds. Each returns every row id it inserted.
// ---------------------------------------------------------------------------

async function seedSsoSessions(s: Seed): Promise<string[]> {
  const providerId = randomUUID();
  await exec(sql`INSERT INTO sso_providers (id, org_id, name, type)
    VALUES (${providerId}::uuid, ${s.orgId}::uuid, 'Retention IdP', 'oidc')`);
  const ids: string[] = [];
  for (const expiresAt of [justPast(7), justInside(7), inFuture(1)]) {
    const id = randomUUID();
    ids.push(id);
    await exec(sql`INSERT INTO sso_sessions (id, provider_id, state, nonce, expires_at)
      VALUES (${id}::uuid, ${providerId}::uuid, ${randomUUID()}, 'n', ${tsu(expiresAt)})`);
  }
  return ids;
}

async function seedC2cConsentSessions(s: Seed): Promise<string[]> {
  const ids: string[] = [];
  for (const expiresAt of [justPast(7), justInside(7), inFuture(1)]) {
    const id = randomUUID();
    ids.push(id);
    await exec(sql`INSERT INTO c2c_consent_sessions (id, org_id, state, expires_at)
      VALUES (${id}::uuid, ${s.orgId}::uuid, ${randomUUID()}, ${tsu(expiresAt)})`);
  }
  return ids;
}

async function seedTunnelSessions(s: Seed): Promise<string[]> {
  const ids: string[] = [];
  const row = async (status: string, createdAt: Date, endedAt: Date | null) => {
    const id = randomUUID();
    ids.push(id);
    await exec(sql`INSERT INTO tunnel_sessions
      (id, device_id, user_id, org_id, type, status, target_host, target_port, created_at, ended_at)
      VALUES (${id}::uuid, ${s.deviceId}::uuid, ${s.userId}::uuid, ${s.orgId}::uuid, 'vnc', ${status},
        'localhost', 5900, ${tsu(createdAt)}, ${endedAt ? tsu(endedAt) : sql`NULL`})`);
  };
  await row('disconnected', daysAgo(400), justPast(365)); // eligible
  await row('failed', justPast(365), null); // eligible via COALESCE(ended_at, created_at)
  await row('active', daysAgo(400), null); // not ended: kept
  await row('disconnected', daysAgo(400), justInside(365)); // inside the window: kept
  return ids;
}

async function seedUnifiSyncRuns(s: Seed): Promise<string[]> {
  const ids: string[] = [];
  const integration = async (active: boolean) => {
    const id = randomUUID();
    await exec(sql`INSERT INTO unifi_integrations (id, partner_id, api_key_encrypted, is_active)
      VALUES (${id}::uuid, ${s.partnerId}::uuid, 'enc', ${active})`);
    return id;
  };
  const syncRun = async (integrationId: string, status: string, startedAt: Date) => {
    const id = randomUUID();
    ids.push(id);
    await exec(sql`INSERT INTO unifi_sync_runs (id, integration_id, partner_id, trigger, status, started_at)
      VALUES (${id}::uuid, ${integrationId}::uuid, ${s.partnerId}::uuid, 'scheduled', ${status}, ${tsz(startedAt)})`);
  };
  const a = await integration(true);
  await syncRun(a, 'success', daysAgo(100)); // eligible
  await syncRun(a, 'failed', daysAgo(95)); // eligible
  await syncRun(a, 'success', daysAgo(1)); // newest: kept
  const b = await integration(false);
  await syncRun(b, 'success', daysAgo(200)); // newest finished for B: kept
  await syncRun(b, 'running', daysAgo(300)); // non-terminal: kept
  await syncRun(a, 'partial', daysAgo(98)); // [5] partial is finished: eligible
  await syncRun(a, 'success', daysAgo(30)); // [6] has a newer run but inside the window: kept
  // C: only a newer RUNNING run above an old success. Running is not "finished",
  // so the success is still C's newest finished run: kept.
  const c = await integration(false);
  await syncRun(c, 'success', daysAgo(200)); // [7] kept
  await syncRun(c, 'running', daysAgo(10)); // [8] non-terminal: kept
  return ids;
}

async function seedFleetRemediationRuns(s: Seed): Promise<string[]> {
  const ids: string[] = [];
  const finding = async () => {
    const id = randomUUID();
    await exec(sql`INSERT INTO fleet_findings (id, org_id, kind, semantic_key, title, first_seen_at, last_seen_at)
      VALUES (${id}::uuid, ${s.orgId}::uuid, 'log_correlation', ${randomUUID()}, 'Retention finding',
        ${tsz(daysAgo(700))}, ${tsz(daysAgo(1))})`);
    return id;
  };
  const remediation = async (findingId: string, status: string, createdAt: Date, completedAt: Date | null) => {
    const id = randomUUID();
    ids.push(id);
    await exec(sql`INSERT INTO fleet_remediation_runs
      (id, org_id, finding_id, finding_revision, action_kind, status, created_at, completed_at)
      VALUES (${id}::uuid, ${s.orgId}::uuid, ${findingId}::uuid, 1, 'command', ${status},
        ${tsz(createdAt)}, ${completedAt ? tsz(completedAt) : sql`NULL`})`);
  };
  const x = await finding();
  await remediation(x, 'succeeded', daysAgo(400), daysAgo(400)); // eligible
  await remediation(x, 'succeeded', daysAgo(1), daysAgo(1)); // newest: kept
  await remediation(x, 'queued', daysAgo(600), null); // non-terminal: kept
  const y = await finding();
  await remediation(y, 'failed', daysAgo(500), daysAgo(500)); // newest of Y: kept
  await remediation(x, 'succeeded', daysAgo(200), daysAgo(200)); // [4] has a newer run but inside the window: kept
  // [5] non-terminal with a stale completed_at (a roll-up bug shape): the status list alone keeps it.
  await remediation(x, 'running', daysAgo(450), daysAgo(450));
  return ids;
}

async function seedTicketImportRuns(s: Seed): Promise<string[]> {
  const ids: string[] = [];
  const source = async () => {
    const principalId = randomUUID();
    await exec(sql`INSERT INTO partner_service_principals (id, partner_id, name, scopes, created_by, updated_by)
      VALUES (${principalId}::uuid, ${s.partnerId}::uuid, ${`principal-${principalId}`}, ARRAY['tickets:write']::text[], ${s.userId}::uuid, ${s.userId}::uuid)`);
    const id = randomUUID();
    await exec(sql`INSERT INTO ticket_import_sources
      (id, partner_id, module, label, base_url, credentials_encrypted, partner_service_principal_id)
      VALUES (${id}::uuid, ${s.partnerId}::uuid, 'fixture', ${`src-${id.slice(0, 8)}`}, 'https://example.invalid',
        'enc', ${principalId}::uuid)`);
    return id;
  };
  const importRun = async (sourceId: string, state: string, startedAt: Date, finishedAt: Date) => {
    const id = randomUUID();
    ids.push(id);
    await exec(sql`INSERT INTO ticket_import_runs (id, partner_id, source_id, kind, state, options, started_at, finished_at)
      VALUES (${id}::uuid, ${s.partnerId}::uuid, ${sourceId}::uuid, 'dry_run', ${state}, '{}'::jsonb,
        ${tsz(startedAt)}, ${tsz(finishedAt)})`);
  };
  const sourceS = await source();
  await importRun(sourceS, 'completed', daysAgo(400), daysAgo(400)); // eligible
  await importRun(sourceS, 'failed', daysAgo(380), daysAgo(380)); // eligible
  await importRun(sourceS, 'completed', daysAgo(1), daysAgo(1)); // newest: kept
  const sourceT = await source();
  await importRun(sourceT, 'stopped', daysAgo(500), daysAgo(500)); // only run: kept
  await importRun(sourceS, 'completed', daysAgo(200), daysAgo(200)); // [4] has a newer run but inside the window: kept
  return ids;
}

async function seedTopologyDiagnosticRuns(s: Seed): Promise<string[]> {
  const { orgId, siteId, userId } = s;
  const ids: string[] = [];
  const nodeId = randomUUID();
  await exec(sql`INSERT INTO topology_site_state (org_id, site_id)
    VALUES (${orgId}::uuid, ${siteId}::uuid) ON CONFLICT DO NOTHING`);
  const node2Id = randomUUID();
  for (const id of [nodeId, node2Id]) {
    await exec(sql`INSERT INTO topology_nodes (id, org_id, site_id, identity_key, identity_material, kind)
      VALUES (${id}::uuid, ${orgId}::uuid, ${siteId}::uuid, ${id},
        ${JSON.stringify({ version: 1, kind: 'endpoint', sourceKey: id })}::jsonb, 'endpoint')`);
  }

  const entry = (contextKey: string, lastAppliedScheduledFor: Date | null, family = 'ipv4') => ({
    contextKey,
    family,
    lastAppliedScheduledFor: lastAppliedScheduledFor ? lastAppliedScheduledFor.toISOString() : null,
    consecutiveFailures: 0,
    consecutiveSuccesses: 0,
  });
  const policy = async (revision: number, entries: ReturnType<typeof entry>[]) => {
    const id = randomUUID();
    await exec(sql`INSERT INTO topology_monitoring_policies
      (id, org_id, site_id, key, definition, activation_intent, alert_state, revision)
      VALUES (${id}::uuid, ${orgId}::uuid, ${siteId}::uuid, ${`policy-${id.slice(0, 8)}`},
        '{"kind":"policy"}'::jsonb, false, ${JSON.stringify({ schemaVersion: 1, entries })}::jsonb, ${revision})`);
    return id;
  };
  // P is at revision 1. The (k1, ipv6) entry is applied up to 102 d ago: that is
  // after [9] (105 d), so [9] is not pending and only its own key keeps it, and
  // before [2] (100 d), so a family-blind pending check would wrongly hold [2].
  const p = await policy(1, [
    entry('k1', daysAgo(95)), entry('k1', daysAgo(102), 'ipv6'), entry('k3', daysAgo(130)), entry('k6', null),
  ]);
  // Q is at revision 2, for the two revision guards.
  const q = await policy(2, [entry('r1', daysAgo(140)), entry('r2', daysAgo(170))]);

  interface Sched { policyId: string; revision: number; contextKey: string; scheduledFor: Date; family?: string }
  const at = (d: number, policyId: string, revision: number, contextKey: string, family?: string): Sched =>
    ({ policyId, revision, contextKey, scheduledFor: daysAgo(d), family });

  const diagRun = async (
    finishedAt: Date | null,
    scheduled: Sched | null,
    o: { state?: string; node?: string } = {},
  ) => {
    const id = randomUUID();
    ids.push(id);
    const anchor = finishedAt ?? scheduled?.scheduledFor ?? new Date(NOW);
    const queuedAt = new Date(anchor.getTime() - HOUR_MS);
    const sched = scheduled
      ? sql`${scheduled.policyId}::uuid, ${scheduled.revision}, ${scheduled.contextKey}, ${scheduled.family ?? 'ipv4'},
          ${tsz(scheduled.scheduledFor)}, ${hex64()}, ${hex64()}, '{}'::jsonb`
      : sql`NULL, NULL, NULL, NULL, NULL, NULL, NULL, NULL`;
    const node = o.node ?? nodeId;
    await exec(sql`INSERT INTO topology_diagnostic_runs
      (id, org_id, site_id, recipe_id, recipe_version, requester_id, subject_node_id, origin_node_id,
       origin_snapshot, plan, plan_digest, idempotency_key, body_hash, attempt_id, state, queued_at,
       queue_deadline, deadline, finished_at,
       policy_id, policy_revision, scheduled_context_key, scheduled_family, scheduled_for, occurrence_key,
       continuity_key, requester_authority)
      VALUES (${id}::uuid, ${orgId}::uuid, ${siteId}::uuid, 'target_connectivity', 1, ${userId}::uuid,
        ${node}::uuid, ${node}::uuid, '{}'::jsonb, '{}'::jsonb, ${hex64()}, ${randomUUID()}, ${hex64()},
        ${randomUUID()}::uuid, ${o.state ?? 'completed'}, ${tsz(queuedAt)},
        ${tsz(new Date(queuedAt.getTime() + 60_000))}, ${tsz(new Date(queuedAt.getTime() + 120_000))},
        ${finishedAt ? tsz(finishedAt) : sql`NULL`},
        ${sched})`);
  };

  await diagRun(daysAgo(100), null); // [0] on-demand, outside the window: eligible
  await diagRun(daysAgo(80), null); // [1] on-demand, inside: kept
  // k1: [2] has a newer settled run AND was applied: eligible. [3] is the newest: kept.
  await diagRun(daysAgo(100), at(100, p, 1, 'k1'));
  await diagRun(daysAgo(95), at(95, p, 1, 'k1'));
  // k2: [4] the newest SETTLED run of its key: kept, even under [7], a newer queued run.
  await diagRun(daysAgo(200), at(200, p, 1, 'k2'));
  // k3: [5] has a newer run but is still pending assessment (applied to 130 d < 120 d): kept.
  await diagRun(daysAgo(120), at(120, p, 1, 'k3'));
  await diagRun(daysAgo(110), at(110, p, 1, 'k3')); // [6] kept
  await diagRun(null, at(190, p, 1, 'k2'), { state: 'queued' }); // [7] non-terminal: kept
  // [8] k1 on a second subject: the newest of its own (subject, key): kept.
  await diagRun(daysAgo(105), at(105, p, 1, 'k1'), { node: node2Id });
  // [9] k1 in the other family: the newest of (k1, ipv6): kept.
  await diagRun(daysAgo(105), at(105, p, 1, 'k1', 'ipv6'));
  // k6: its entry was never applied (null), so [10] is pending: kept. [11] newest: kept.
  await diagRun(daysAgo(100), at(100, p, 1, 'k6'));
  await diagRun(daysAgo(95), at(95, p, 1, 'k6'));
  // r1 (Q at revision 2): [12] is current-revision and the only newer run [13] is an
  // older revision, so [12] is still what the health overlay shows: kept. [13] kept.
  await diagRun(daysAgo(150), at(150, q, 2, 'r1'));
  await diagRun(daysAgo(140), at(140, q, 1, 'r1'));
  // r2: [14] is a stale revision (1; Q is at 2), which the assessment drain never takes
  // up, and a newer current-revision run [15] exists: eligible. [15] newest: kept.
  await diagRun(daysAgo(160), at(160, q, 1, 'r2'));
  await diagRun(daysAgo(155), at(155, q, 2, 'r2'));
  return ids;
}

async function seedAuditBaselineResults(s: Seed): Promise<string[]> {
  const ids: string[] = [];
  const baselineId = randomUUID();
  await exec(sql`INSERT INTO audit_baselines (id, org_id, name, os_type, profile, settings)
    VALUES (${baselineId}::uuid, ${s.orgId}::uuid, 'Retention baseline', 'windows', 'standard', '{}'::jsonb)`);
  const result = async (deviceId: string, checkedAt: Date) => {
    const id = randomUUID();
    ids.push(id);
    await exec(sql`INSERT INTO audit_baseline_results (id, org_id, device_id, baseline_id, compliant, score, deviations, checked_at)
      VALUES (${id}::uuid, ${s.orgId}::uuid, ${deviceId}::uuid, ${baselineId}::uuid, true, 100, '[]'::jsonb, ${tsu(checkedAt)})`);
  };
  await result(s.deviceId, daysAgo(100)); // eligible
  await result(s.deviceId, daysAgo(95)); // eligible
  await result(s.deviceId, daysAgo(1)); // newest: kept
  const d2 = (await createDevice({ orgId: s.orgId, siteId: s.siteId })).id;
  await result(d2, daysAgo(200)); // only row for D2: kept
  await result(s.deviceId, daysAgo(30)); // [4] has a newer row but inside the window: kept
  // [5] same device, a second baseline whose only row is old: the newest for (D1, B2): kept.
  const baseline2 = randomUUID();
  await exec(sql`INSERT INTO audit_baselines (id, org_id, name, os_type, profile, settings)
    VALUES (${baseline2}::uuid, ${s.orgId}::uuid, 'Retention baseline 2', 'windows', 'standard', '{}'::jsonb)`);
  const id5 = randomUUID();
  ids.push(id5);
  await exec(sql`INSERT INTO audit_baseline_results (id, org_id, device_id, baseline_id, compliant, score, deviations, checked_at)
    VALUES (${id5}::uuid, ${s.orgId}::uuid, ${s.deviceId}::uuid, ${baseline2}::uuid, true, 100, '[]'::jsonb, ${tsu(daysAgo(200))})`);
  return ids;
}

async function seedPeripheralDeliveryEvents(s: Seed): Promise<string[]> {
  const ids: string[] = [];
  for (const occurredAt of [justPast(365), justInside(365)]) {
    const id = randomUUID();
    ids.push(id);
    await exec(sql`INSERT INTO peripheral_policy_delivery_events
      (id, org_id, device_id, command_id, event_kind, phase, revision, digest, occurred_at)
      VALUES (${id}::uuid, ${s.orgId}::uuid, ${s.deviceId}::uuid, ${randomUUID()}::uuid, 'requested', 'enforce', 1,
        ${`sha256:${hex64()}`}, ${tsz(occurredAt)})`);
  }
  return ids;
}

async function seedMlFeedbackEvents(s: Seed): Promise<string[]> {
  const ids: string[] = [];
  for (const occurredAt of [justPast(400), justInside(400)]) {
    const id = randomUUID();
    ids.push(id);
    await exec(sql`INSERT INTO ml_feedback_events (id, org_id, source_type, source_id, event_type, outcome, occurred_at)
      VALUES (${id}::uuid, ${s.orgId}::uuid, 'alert', ${randomUUID()}, 'fixture', 'confirmed', ${tsu(occurredAt)})`);
  }
  return ids;
}

/**
 * Run order of `HISTORY_REPORT_ONLY_TARGETS`. `eligibleIdx` names, by insertion
 * order within the seed, exactly the rows the predicate must select (the
 * `// eligible` rows above); its length is the expected count.
 */
const CASES: ReadonlyArray<{
  table: string;
  eligibleIdx: number[];
  seed: (s: Seed) => Promise<string[]>;
}> = [
  { table: 'sso_sessions', eligibleIdx: [0], seed: seedSsoSessions },
  { table: 'c2c_consent_sessions', eligibleIdx: [0], seed: seedC2cConsentSessions },
  { table: 'tunnel_sessions', eligibleIdx: [0, 1], seed: seedTunnelSessions },
  { table: 'unifi_sync_runs', eligibleIdx: [0, 1, 5], seed: seedUnifiSyncRuns },
  { table: 'fleet_remediation_runs', eligibleIdx: [0], seed: seedFleetRemediationRuns },
  { table: 'ticket_import_runs', eligibleIdx: [0, 1], seed: seedTicketImportRuns },
  // [0] the 100 d on-demand run, [2] k1's older applied run, [14] r2's stale-revision run.
  { table: 'topology_diagnostic_runs', eligibleIdx: [0, 2, 14], seed: seedTopologyDiagnosticRuns },
  { table: 'audit_baseline_results', eligibleIdx: [0, 1], seed: seedAuditBaselineResults },
  { table: 'peripheral_policy_delivery_events', eligibleIdx: [0], seed: seedPeripheralDeliveryEvents },
  { table: 'ml_feedback_events', eligibleIdx: [0], seed: seedMlFeedbackEvents },
];

/** The ids the target's own predicate selects right now, at its configured window. */
async function selectedBy(entry: (typeof HISTORY_REPORT_ONLY_TARGETS)[number]): Promise<Set<string>> {
  const now = new Date();
  const cutoffIso = new Date(now.getTime() - entry.knobs.retentionDays * DAY_MS).toISOString();
  const rows = await getTestDb().execute(
    sql`SELECT id FROM ${sql.identifier(entry.target.table)} WHERE ${entry.target.where(cutoffIso, now.toISOString())}`,
  ) as unknown as Array<{ id: string }>;
  return new Set(rows.map((r) => r.id));
}

function reportEligible(r: RetentionTargetResult | undefined, table: string): number {
  if (!r || r.mode !== 'report') throw new Error(`expected a report result for ${table}, got ${r?.mode}`);
  expect(r.table).toBe(table);
  return r.eligible;
}

describe('history retention second pass: report-only by construction (#4342 W6.c, real Postgres)', () => {
  let seed: Seed;

  beforeEach(async () => {
    vitest.spyOn(console, 'log').mockImplementation(() => {});
    vitest.spyOn(console, 'warn').mockImplementation(() => {});
    const partnerId = (await createPartner()).id;
    const orgId = (await createOrganization({ partnerId, name: 'Report-Only Retention Org' })).id;
    const siteId = (await createSite({ orgId })).id;
    const userId = (await createUser({ partnerId, orgId })).id;
    const deviceId = (await createDevice({ orgId, siteId })).id;
    seed = { partnerId, orgId, siteId, userId, deviceId };
  });

  afterEach(() => {
    vitest.restoreAllMocks();
  });

  it('runs the ten second-pass targets, in order, after the twelve', () => {
    expect(HISTORY_REPORT_ONLY_TARGETS.map((e) => e.target.table)).toEqual(CASES.map((c) => c.table));
    for (const e of HISTORY_REPORT_ONLY_TARGETS) {
      expect(e.target.action).toEqual({ kind: 'reportOnly' });
      expect(e.knobs.enforce).toBe(false);
    }
  });

  it('pins the live column types each predicate compares against', async () => {
    const expected: Record<string, string> = {
      'sso_sessions.expires_at': 'timestamp without time zone',
      'c2c_consent_sessions.expires_at': 'timestamp without time zone',
      'tunnel_sessions.ended_at': 'timestamp without time zone',
      'tunnel_sessions.created_at': 'timestamp without time zone',
      'audit_baseline_results.checked_at': 'timestamp without time zone',
      'ml_feedback_events.occurred_at': 'timestamp without time zone',
      'unifi_sync_runs.started_at': 'timestamp with time zone',
      'fleet_remediation_runs.completed_at': 'timestamp with time zone',
      'fleet_remediation_runs.created_at': 'timestamp with time zone',
      'ticket_import_runs.finished_at': 'timestamp with time zone',
      'ticket_import_runs.started_at': 'timestamp with time zone',
      'topology_diagnostic_runs.finished_at': 'timestamp with time zone',
      'topology_diagnostic_runs.scheduled_for': 'timestamp with time zone',
      'peripheral_policy_delivery_events.occurred_at': 'timestamp with time zone',
    };
    const tables = [...new Set(Object.keys(expected).map((k) => k.split('.')[0]!))];
    const rows = await getTestDb().execute(sql`
      SELECT table_name || '.' || column_name AS col, data_type
      FROM information_schema.columns
      WHERE table_schema = 'public'
        AND table_name IN (${sql.join(tables.map((t) => sql`${t}`), sql`, `)})`,
    ) as unknown as Array<{ col: string; data_type: string }>;
    const live = Object.fromEntries(rows.map((r) => [r.col, r.data_type]));
    const actual = Object.fromEntries(Object.keys(expected).map((k) => [k, live[k]]));
    expect(actual).toEqual(expected);
  });

  describe.each(CASES.map((c, i) => ({ ...c, i, expected: c.eligibleIdx.length })))('$table', ({ table, eligibleIdx, expected, seed: seedTable, i }) => {
    it(`reports ${expected} eligible and deletes nothing, even with every enforce flag set`, async () => {
      const ids = await seedTable(seed);
      const entry = HISTORY_REPORT_ONLY_TARGETS[i]!;
      expect(entry.target.table).toBe(table);
      // Exactly the intended rows, not just the right number of them.
      expect(await selectedBy(entry)).toEqual(new Set(eligibleIdx.map((k) => ids[k]!)));

      const results = await runHistoryRetention();
      const result = results[HISTORY_RETENTION_TARGETS.length + i];
      expect(result?.mode).toBe('report');
      expect(reportEligible(result, table)).toBe(expected);
      expect((await surviving(table, ids)).size).toBe(ids.length);

      // The runner-level guarantee: enforce: true on a reportOnly target still only counts.
      const direct = await runRetentionTarget(
        entry.target,
        { ...entry.knobs, enforce: true },
        { logPrefix: '[t]', label: 't' },
      );
      expect(direct.mode).toBe('report');
      expect(reportEligible(direct, table)).toBe(expected);
      expect((await surviving(table, ids)).size).toBe(ids.length);
    });
  });

  it('no configuration deletes a second-pass row', async () => {
    const seeded: Array<{ table: string; ids: string[] }> = [];
    for (const c of CASES) seeded.push({ table: c.table, ids: await c.seed(seed) });

    for (const job of [{}, { forceReport: false }]) {
      const results = await runHistoryRetention(job);
      expect(results).toHaveLength(HISTORY_RETENTION_TARGETS.length + CASES.length);
      CASES.forEach((c, i) => {
        const r = results[HISTORY_RETENTION_TARGETS.length + i];
        expect(r?.mode).toBe('report');
        expect(reportEligible(r, c.table)).toBe(c.eligibleIdx.length);
      });
      for (const { table, ids } of seeded) {
        expect((await surviving(table, ids)).size, `${table} rows survive`).toBe(ids.length);
      }
    }
  });
});
