/**
 * Audit-Chain External Anchor Worker (issue #916).
 *
 * THE GAP THIS CLOSES
 * -------------------
 * The audit hash-chain (audit_logs + the append-only audit_log_chain side
 * table, #1002) and its daily verifier (auditChainVerify.ts, #1240) all live
 * inside the same Postgres the application writes to. A privileged DB
 * compromise can DELETE both tables and re-seal a fresh, internally-consistent
 * forgery — audit_log_verify_chain would then return clean. Nothing records,
 * OUTSIDE the chain, what the head used to be, so a shrunk chain after a DELETE
 * is invisible.
 *
 * This worker periodically snapshots each org's chain head (seq + checksum +
 * entry count) into the append-only `audit_chain_anchors` table — which
 * breeze_app may INSERT but never UPDATE/DELETE (migration 2026-06-13-c) — and
 * SIGNS each snapshot with a per-deployment Ed25519 key whose seed never enters
 * Postgres (services/auditAnchorSigning.ts). It then:
 *   1. emits the signed anchor as a structured log line for off-box pickup by
 *      the existing log forwarder (the phase-1 external-retention hook), and
 *   2. runs audit_chain_verify_anchor() to compare the LIVE chain head against
 *      the most recent anchor, raising a P1 security incident when the head
 *      moved backwards / a sealed entry vanished / a historical checksum
 *      changed — i.e. exactly the forged-chain-after-DELETE that the in-chain
 *      verifier cannot catch.
 *
 * PHASE-1 / DEFERRED
 * ------------------
 * The durable off-box SINK itself (S3 Object Lock, write-only host, or SIEM
 * ingestion) is deferred pending the infra decision tracked on #916. Phase 1
 * ships: the append-only in-DB anchor, the signing seam, the signed structured
 * log emission (so a configured log forwarder already retains anchors off-box),
 * and divergence detection. Wiring a dedicated immutable sink is the follow-up.
 *
 * #1105 long-transaction pitfall: same handling as auditChainVerify — read the
 * org list in one short system txn, then run the per-org sweep via
 * runOutsideDbContext so no connection is held idle-in-transaction across the
 * loop. Each per-org anchor+verify opens its own short system txn.
 *
 * Schedule: daily at 04:45 UTC — AFTER auditChainVerify (04:15) so the
 * in-chain verify and retention prune have settled, and offset from the other
 * integrity crons. Anchoring after retention means the anchor reflects the
 * post-prune head, so a legitimate retention shrink does not look like tamper.
 *
 * Kill switch: AUDIT_CHAIN_ANCHOR_ENABLED=false skips schedule registration
 * (the worker still drains manual add() calls).
 */
import { Queue, Worker, Job } from 'bullmq';
import { sql } from 'drizzle-orm';
import * as dbModule from '../db';
import { incidents, type IncidentTimelineEntry } from '../db/schema/incidentResponse';
import { captureException } from '../services/sentry';
import { publishEvent } from '../services/eventBus';
import { getBullMQConnection } from '../services/redis';
import {
  type AnchorPayload,
  canonicalAnchorPayload,
  anchorDigest,
  signAnchorPayload,
  getAnchorSigningKeyId,
  isAnchorSigningEnabled,
} from '../services/auditAnchorSigning';

const QUEUE_NAME = 'audit-chain-anchor';
const JOB_NAME = 'audit-chain-anchor';
const REPEAT_JOB_ID = 'audit-chain-anchor';
// Daily at 04:45 UTC — after auditChainVerify (04:15) and retention (03:30).
const DAILY_CRON = '45 4 * * *';
const INTER_ORG_DELAY_MS = 50;

const INCIDENT_CLASSIFICATION = 'audit_integrity';
const INCIDENT_SEVERITY = 'p1' as const;
const EVENT_SOURCE = 'audit-chain-anchor';

// Anchor divergence reasons that indicate REAL tampering (a forged chain after
// a DELETE), vs. 'count_shrank' (ambiguous — benign retention when the anchored
// head is intact) and 'no_anchor' (informational baseline). Only these page.
const TAMPER_REASONS: ReadonlySet<string> = new Set([
  'seq_regressed',
  'anchored_head_missing',
  'checksum_diverged',
]);

function isEnabled(): boolean {
  const raw = process.env.AUDIT_CHAIN_ANCHOR_ENABLED;
  if (raw === undefined || raw === '') return true; // default ON
  const v = raw.trim().toLowerCase();
  return !(v === '0' || v === 'false' || v === 'no' || v === 'off');
}

const runWithSystemDbAccess = async <T>(fn: () => Promise<T>): Promise<T> => {
  if (typeof dbModule.withSystemDbAccessContext !== 'function') {
    throw new Error(
      '[AuditChainAnchor] withSystemDbAccessContext is not available — DB module may not have loaded correctly',
    );
  }
  return dbModule.withSystemDbAccessContext(fn);
};

const runOutsideDbContext = async <T>(fn: () => Promise<T>): Promise<T> => {
  if (typeof dbModule.runOutsideDbContext !== 'function') {
    return fn();
  }
  return dbModule.runOutsideDbContext(fn);
};

export interface AnchorSweepStats {
  orgsAnchored: number;
  anchorsSigned: number;
  divergencesFound: number;
  incidentsRaised: number;
  errors: number;
  durationMs: number;
}

interface OrgRow {
  id: string;
}

interface HeadRow {
  head_chain_seq: string | number;
  head_chain_checksum: string | null;
  entry_count: string | number;
}

interface AnchorWriteRow {
  anchor_seq: string | number;
  head_chain_seq: string | number;
  head_chain_checksum: string | null;
  entry_count: string | number;
  anchored_at: string;
  signed: boolean;
}

interface DivergenceRow {
  reason: string;
  anchor_seq: string | number | null;
  anchored_head_seq: string | number | null;
  anchored_entry_count: string | number | null;
  live_head_seq: string | number | null;
  live_entry_count: string | number | null;
  anchored_head_checksum: string | null;
  live_head_checksum: string | null;
}

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

const toNum = (v: string | number | null | undefined): number =>
  v === null || v === undefined ? 0 : typeof v === 'number' ? v : Number(v);

/**
 * Read the current chain head for an org in its own short system txn.
 * `orgId === null` targets the system (NULL-org) chain.
 */
async function readHead(orgId: string | null): Promise<HeadRow> {
  return runWithSystemDbAccess(async () => {
    const rows = (await dbModule.db.execute(sql`
      SELECT head_chain_seq, head_chain_checksum, entry_count
      FROM audit_chain_read_head(${orgId}::uuid)
    `)) as unknown as HeadRow[];
    const row = Array.isArray(rows) ? rows[0] : undefined;
    return (
      row ?? { head_chain_seq: 0, head_chain_checksum: null, entry_count: 0 }
    );
  });
}

/**
 * Write a (possibly signed) anchor for an org. Returns the persisted anchor.
 * The signature, when signing is enabled, is computed over the canonical
 * payload off-DB; the DB only stamps it when the re-read head still matches
 * what was signed (see migration 2026-06-13-c).
 */
async function writeAnchor(
  orgId: string | null,
  head: HeadRow,
): Promise<{ row: AnchorWriteRow; payload: AnchorPayload }> {
  const anchoredAt = new Date().toISOString();
  const payload: AnchorPayload = {
    orgId,
    headChainSeq: toNum(head.head_chain_seq),
    headChainChecksum: head.head_chain_checksum,
    entryCount: toNum(head.entry_count),
    anchoredAt,
  };

  // Sign off-DB (null when signing disabled). A malformed configured key
  // throws here and is surfaced as a per-org error rather than silently
  // anchoring unsigned.
  const signature = signAnchorPayload(payload);
  const signingKeyId = signature ? getAnchorSigningKeyId() : null;

  const row = await runWithSystemDbAccess(async () => {
    const rows = (await dbModule.db.execute(sql`
      SELECT anchor_seq, head_chain_seq, head_chain_checksum, entry_count, anchored_at, signed
      FROM audit_chain_anchor_head(
        ${orgId}::uuid,
        ${signature}::text,
        ${signingKeyId}::varchar,
        ${payload.headChainSeq}::bigint,
        ${payload.entryCount}::bigint,
        ${anchoredAt}::timestamptz
      )
    `)) as unknown as AnchorWriteRow[];
    const r = Array.isArray(rows) ? rows[0] : undefined;
    if (!r) throw new Error('audit_chain_anchor_head returned no row');
    return r;
  });

  return { row, payload };
}

/**
 * Emit the signed anchor as a structured log line. This is the phase-1
 * external-retention hook: a configured log forwarder (per-org Elasticsearch /
 * SIEM) picks these up and retains them OFF the primary DB, so a later DB-side
 * chain rewrite can be reconciled against the forwarded anchor history. The
 * durable, write-once sink itself is the deferred phase-2 step (#916).
 *
 * The line is a single JSON object on stdout with a stable `evt` tag so the
 * forwarder can route it. Contains NO secrets — only the public snapshot, its
 * signature, and the public-key id.
 */
function emitAnchorLog(
  row: AnchorWriteRow,
  payload: AnchorPayload,
  signed: boolean,
  signingKeyId: string | null,
): void {
  const record = {
    evt: 'audit_chain_anchor',
    anchorSeq: toNum(row.anchor_seq),
    orgId: payload.orgId,
    headChainSeq: payload.headChainSeq,
    headChainChecksum: payload.headChainChecksum,
    entryCount: payload.entryCount,
    anchoredAt: payload.anchoredAt,
    digest: anchorDigest(payload),
    canonical: canonicalAnchorPayload(payload),
    signed,
    signingKeyId,
  };
  // Single-line JSON for forwarder ingestion.
  console.log(JSON.stringify(record));
}

/**
 * Compare the live chain head against the latest anchor for an org.
 */
async function verifyAnchor(orgId: string | null): Promise<DivergenceRow[]> {
  return runWithSystemDbAccess(async () => {
    const rows = (await dbModule.db.execute(sql`
      SELECT reason, anchor_seq, anchored_head_seq, anchored_entry_count,
             live_head_seq, live_entry_count, anchored_head_checksum, live_head_checksum
      FROM audit_chain_verify_anchor(${orgId}::uuid)
    `)) as unknown as DivergenceRow[];
    return Array.isArray(rows) ? rows : [];
  });
}

/**
 * Raise a P1 incident for an org whose live chain head diverged BACKWARDS from
 * its anchor — the forged-chain-after-DELETE signal. Runs in its own system txn.
 */
async function raiseAnchorDivergenceIncident(
  orgId: string,
  divergence: DivergenceRow,
): Promise<void> {
  const now = new Date();
  const title = 'Audit chain diverged from external anchor';
  const summary =
    `audit_chain_verify_anchor reported "${divergence.reason}" for this organization: ` +
    `the live audit chain head no longer extends forward from the last recorded anchor. ` +
    `anchored_head_seq=${toNum(divergence.anchored_head_seq)} (count ${toNum(divergence.anchored_entry_count)}), ` +
    `live_head_seq=${toNum(divergence.live_head_seq)} (count ${toNum(divergence.live_entry_count)}). ` +
    `This is the tamper class the in-chain verifier cannot see: an internally-consistent ` +
    `but SHORTER or rewritten chain produced by deleting and re-sealing audit rows. ` +
    `The append-only audit_chain_anchors row that flagged this cannot itself be rewritten by ` +
    `the app role. Investigate immediately for unauthorized audit deletion / DB compromise.`;

  const timeline: IncidentTimelineEntry[] = [
    {
      at: now.toISOString(),
      type: 'incident_created',
      actor: 'system',
      summary: `Anchor divergence detected: ${divergence.reason}.`,
      metadata: {
        reason: divergence.reason,
        anchorSeq: toNum(divergence.anchor_seq),
        anchoredHeadSeq: toNum(divergence.anchored_head_seq),
        anchoredEntryCount: toNum(divergence.anchored_entry_count),
        liveHeadSeq: toNum(divergence.live_head_seq),
        liveEntryCount: toNum(divergence.live_entry_count),
        anchoredHeadChecksum: divergence.anchored_head_checksum,
        liveHeadChecksum: divergence.live_head_checksum,
      },
    },
  ];

  const [incident] = await runWithSystemDbAccess(async () =>
    dbModule.db
      .insert(incidents)
      .values({
        orgId,
        title,
        classification: INCIDENT_CLASSIFICATION,
        severity: INCIDENT_SEVERITY,
        status: 'detected',
        summary,
        relatedAlerts: [],
        affectedDevices: [],
        timeline,
        detectedAt: now,
      })
      .returning(),
  );

  try {
    await publishEvent(
      'incident.created',
      orgId,
      {
        incidentId: incident?.id,
        title,
        classification: INCIDENT_CLASSIFICATION,
        severity: INCIDENT_SEVERITY,
        reason: divergence.reason,
      },
      EVENT_SOURCE,
    );
  } catch (err) {
    captureException(err);
    console.error(
      `[AuditChainAnchor] incident raised (id=${incident?.id}) but incident.created publish failed for org=${orgId}:`,
      err instanceof Error ? err.message : err,
    );
  }
}

/**
 * Anchor + verify a single org (or the system chain when orgId === null).
 * Order matters: VERIFY FIRST (against the prior anchor, before we write a new
 * one), THEN write the new anchor. Writing first would move the anchor forward
 * past a tampered head and mask the divergence.
 */
async function anchorAndVerifyOrg(
  orgId: string | null,
  stats: AnchorSweepStats,
): Promise<void> {
  // (1) Verify the live head against the EXISTING latest anchor first.
  const divergences = await verifyAnchor(orgId);
  for (const d of divergences) {
    if (d.reason === 'no_anchor') {
      // First-ever anchor for this org — informational, not tamper.
      continue;
    }
    stats.divergencesFound += 1;
    if (TAMPER_REASONS.has(d.reason)) {
      console.error(
        `[AuditChainAnchor] ANCHOR DIVERGENCE org=${orgId ?? 'SYSTEM'} reason=${d.reason} ` +
          `anchoredHeadSeq=${toNum(d.anchored_head_seq)} liveHeadSeq=${toNum(d.live_head_seq)}`,
      );
      // The system (NULL-org) chain cannot own an org-scoped incident row;
      // surface it via Sentry/logs only. Org chains get a P1 incident.
      if (orgId !== null) {
        await raiseAnchorDivergenceIncident(orgId, d);
        stats.incidentsRaised += 1;
      }
      captureException(
        new Error(
          `Audit chain anchor divergence: org=${orgId ?? 'SYSTEM'} reason=${d.reason} ` +
            `anchoredHeadSeq=${toNum(d.anchored_head_seq)} liveHeadSeq=${toNum(d.live_head_seq)}`,
        ),
      );
    } else {
      // count_shrank with an intact anchored head = expected after retention.
      console.log(
        `[AuditChainAnchor] org=${orgId ?? 'SYSTEM'} ${d.reason} (anchored head intact — ` +
          `treating as retention prune, not tamper)`,
      );
    }
  }

  // (2) Write the new forward anchor reflecting the current head.
  const head = await readHead(orgId);
  const { row, payload } = await writeAnchor(orgId, head);
  stats.orgsAnchored += 1;
  if (row.signed) stats.anchorsSigned += 1;
  emitAnchorLog(row, payload, row.signed, row.signed ? getAnchorSigningKeyId() : null);
}

/**
 * Walk every active org plus the system chain, verify each against its anchor,
 * and write a fresh signed anchor. Exported for tests / manual invocation.
 */
export async function runAnchorSweep(): Promise<AnchorSweepStats> {
  const startedAt = Date.now();
  const stats: AnchorSweepStats = {
    orgsAnchored: 0,
    anchorsSigned: 0,
    divergencesFound: 0,
    incidentsRaised: 0,
    errors: 0,
    durationMs: 0,
  };

  if (!isAnchorSigningEnabled()) {
    console.warn(
      '[AuditChainAnchor] AUDIT_ANCHOR_SIGNING_KEY is NOT set — anchors are written UNSIGNED. ' +
        'The append-only in-DB anchor still detects forged-chain-after-DELETE, but off-box ' +
        'verification has no signature to check. Provision an Ed25519 seed (base64) to enable signing.',
    );
  }

  const orgs = await runWithSystemDbAccess(async () => {
    const rows = (await dbModule.db.execute(sql`
      SELECT id FROM organizations WHERE status = 'active'
    `)) as unknown as OrgRow[];
    return rows;
  });

  // null = the system (NULL-org) chain, anchored alongside every tenant.
  const targets: Array<string | null> = [null, ...orgs.map((o) => o.id)];

  await runOutsideDbContext(async () => {
    for (const orgId of targets) {
      try {
        await anchorAndVerifyOrg(orgId, stats);
      } catch (err) {
        stats.errors += 1;
        captureException(err);
        console.error(
          `[AuditChainAnchor] anchor/verify failed for org=${orgId ?? 'SYSTEM'}:`,
          err instanceof Error ? err.message : err,
        );
      }
      if (INTER_ORG_DELAY_MS > 0) {
        await sleep(INTER_ORG_DELAY_MS);
      }
    }
  });

  stats.durationMs = Date.now() - startedAt;
  console.log(
    `[AuditChainAnchor] Anchored ${stats.orgsAnchored} chain(s) (${stats.anchorsSigned} signed); ` +
      `${stats.divergencesFound} divergence(s), ${stats.incidentsRaised} incident(s) in ${stats.durationMs}ms (errors=${stats.errors})`,
  );
  return stats;
}

let anchorQueue: Queue | null = null;
let anchorWorker: Worker | null = null;

export function getAuditChainAnchorQueue(): Queue {
  if (!anchorQueue) {
    anchorQueue = new Queue(QUEUE_NAME, {
      connection: getBullMQConnection(),
    });
  }
  return anchorQueue;
}

export function createAuditChainAnchorWorker(): Worker {
  anchorWorker = new Worker(
    QUEUE_NAME,
    async (job: Job) => {
      if (job.name !== JOB_NAME) {
        console.warn(`[AuditChainAnchor] Ignoring unknown job name: ${job.name}`);
        return { skipped: true, orgsAnchored: 0 };
      }
      return runAnchorSweep();
    },
    {
      connection: getBullMQConnection(),
      concurrency: 1,
    },
  );
  return anchorWorker;
}

export async function scheduleAuditChainAnchor(
  queue: Queue = getAuditChainAnchorQueue(),
): Promise<void> {
  const existingJobs = await queue.getRepeatableJobs();
  for (const job of existingJobs) {
    if (job.name === JOB_NAME) {
      await queue.removeRepeatableByKey(job.key);
    }
  }

  if (!isEnabled()) {
    console.log(
      '[AuditChainAnchor] AUDIT_CHAIN_ANCHOR_ENABLED=false — skipping schedule registration',
    );
    return;
  }

  await queue.add(
    JOB_NAME,
    {},
    {
      jobId: REPEAT_JOB_ID,
      repeat: { pattern: DAILY_CRON },
      removeOnComplete: { count: 10 },
      removeOnFail: { count: 25 },
    },
  );
  console.log(
    `[AuditChainAnchor] Scheduled daily anchoring (cron "${DAILY_CRON}", jobId=${REPEAT_JOB_ID})`,
  );
}

export async function initializeAuditChainAnchorWorker(): Promise<void> {
  try {
    createAuditChainAnchorWorker();

    anchorWorker?.on('error', (error) => {
      console.error('[AuditChainAnchor] Worker error:', error);
      captureException(error);
    });

    anchorWorker?.on('failed', (job, error) => {
      console.error(`[AuditChainAnchor] Job ${job?.id} failed:`, error);
      captureException(error);
    });

    await scheduleAuditChainAnchor();
    console.log('[AuditChainAnchor] Worker initialized');
  } catch (error) {
    console.error('[AuditChainAnchor] Failed to initialize:', error);
    throw error;
  }
}

export async function shutdownAuditChainAnchorWorker(): Promise<void> {
  if (anchorWorker) {
    await anchorWorker.close();
    anchorWorker = null;
  }
  if (anchorQueue) {
    await anchorQueue.close();
    anchorQueue = null;
  }
}

export const __testOnly = {
  QUEUE_NAME,
  JOB_NAME,
  REPEAT_JOB_ID,
  DAILY_CRON,
  INCIDENT_CLASSIFICATION,
  TAMPER_REASONS,
  isEnabled,
};
