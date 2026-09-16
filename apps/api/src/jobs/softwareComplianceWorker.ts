import { Job, Queue, Worker } from 'bullmq';
import { and, eq, inArray, sql } from 'drizzle-orm';
import * as dbModule from '../db';
import {
  devices,
  softwareComplianceStatus,
  softwarePolicies,
  type SoftwarePolicyViolation,
} from '../db/schema';
import {
  recordSoftwarePolicyEvaluation,
  recordSoftwarePolicyViolation,
  recordSoftwareRemediationDecision,
} from '../routes/metrics';
import { getBullMQConnection } from '../services/redis';
import {
  evaluateSoftwarePolicyAgainstInventory,
  evaluateSoftwarePolicyArming,
  getSoftwareInventoryByDeviceIds,
  normalizeSoftwarePolicyRules,
  recordSoftwarePolicyAudit,
  upsertSoftwareComplianceStatuses,
  SOFTWARE_POLICY_INSTALL_AUDIT_ACTIONS,
  withStableViolationTimestamps,
  type SoftwarePolicyComplianceStatus,
  type SoftwarePolicyInstallRemediationStatus,
  type SoftwarePolicyRemediationStatus,
} from '../services/softwarePolicyService';
import { resolveDeviceIdsForSoftwarePolicy } from '../services/featureConfigResolver';
import { readLatestPolicyOwnedInstallByDevice } from '../services/softwarePolicyInstallRemediation';
import {
  scheduleSoftwareInstallRemediation,
  scheduleSoftwareRemediation,
  type InstallRemediationTarget,
} from './softwareRemediationWorker';
import {
  resolveInstallRemediationMaxAttempts,
  resolveInstallRemediationMaxPerPass,
} from '../services/softwareInstallRemediationKnobs';
import { captureException } from '../services/sentry';
import { attachWorkerObservability } from './workerObservability';

const { db } = dbModule;
const runWithSystemDbAccess = async <T>(fn: () => Promise<T>): Promise<T> => {
  const withSystem = dbModule.withSystemDbAccessContext;
  if (typeof withSystem !== 'function') {
    const msg = '[SoftwareComplianceWorker] withSystemDbAccessContext unavailable — DB operations may bypass RLS';
    console.error(msg);
    captureException(new Error(msg));
  }
  return typeof withSystem === 'function' ? withSystem(fn) : fn();
};

function fireAudit(input: Parameters<typeof recordSoftwarePolicyAudit>[0]): void {
  recordSoftwarePolicyAudit(input).catch((err) => {
    console.error('[SoftwareComplianceWorker] Audit write failed:', err);
  });
}

const SOFTWARE_COMPLIANCE_QUEUE = 'software-compliance';
const SCAN_INTERVAL_MS = 15 * 60 * 1000;
const REMEDIATION_COOLDOWN_DEFAULT_MINUTES = 120;
const QUERY_CHUNK_SIZE = 500;
const ON_DEMAND_DEDUPE_WINDOW_MS = 30 * 1000;

function chunkArray<T>(items: T[], size = QUERY_CHUNK_SIZE): T[][] {
  if (items.length === 0) return [];
  const chunks: T[][] = [];
  for (let index = 0; index < items.length; index += size) {
    chunks.push(items.slice(index, index + size));
  }
  return chunks;
}

function stableShortHash(value: string): string {
  let hash = 0;
  for (let index = 0; index < value.length; index += 1) {
    hash = ((hash << 5) - hash) + value.charCodeAt(index);
    hash |= 0;
  }
  return Math.abs(hash).toString(36);
}

type ExistingComplianceState = {
  deviceId: string;
  status: SoftwarePolicyComplianceStatus;
  violations: unknown;
  remediationStatus: SoftwarePolicyRemediationStatus | null;
  lastRemediationAttempt: Date | null;
  // Feature #5505 W02: the install verb's parallel axis.
  installRemediationStatus: SoftwarePolicyInstallRemediationStatus | null;
  lastInstallRemediationAttempt: Date | null;
  installRemediationAttempts: number;
};

function parseComplianceStatus(value: unknown): SoftwarePolicyComplianceStatus {
  if (value === 'compliant' || value === 'violation' || value === 'unknown') {
    return value;
  }
  return 'unknown';
}

function parseRemediationStatus(value: unknown): SoftwarePolicyRemediationStatus | null {
  if (
    value === 'none'
    || value === 'pending'
    || value === 'in_progress'
    || value === 'completed'
    || value === 'failed'
  ) {
    return value;
  }
  return null;
}

/** Superset of parseRemediationStatus: the install axis adds two terminal states. */
function parseInstallRemediationStatus(value: unknown): SoftwarePolicyInstallRemediationStatus | null {
  if (value === 'gave_up' || value === 'skipped') return value;
  return parseRemediationStatus(value);
}

/** A NULL or garbage counter reads as 0 — never NaN into a `>=` comparison. */
function parseAttemptCount(value: unknown): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) return 0;
  return Math.max(0, Math.floor(value));
}

async function readComplianceStateByDevice(
  policyId: string,
  deviceIds: string[]
): Promise<Map<string, ExistingComplianceState>> {
  const normalized = Array.from(
    new Set(deviceIds.filter((id): id is string => typeof id === 'string' && id.length > 0))
  );
  const byDevice = new Map<string, ExistingComplianceState>();
  if (normalized.length === 0) {
    return byDevice;
  }

  for (const chunk of chunkArray(normalized)) {
    const rows = await db
      .select({
        deviceId: softwareComplianceStatus.deviceId,
        status: softwareComplianceStatus.status,
        violations: softwareComplianceStatus.violations,
        remediationStatus: softwareComplianceStatus.remediationStatus,
        lastRemediationAttempt: softwareComplianceStatus.lastRemediationAttempt,
        installRemediationStatus: softwareComplianceStatus.installRemediationStatus,
        lastInstallRemediationAttempt: softwareComplianceStatus.lastInstallRemediationAttempt,
        installRemediationAttempts: softwareComplianceStatus.installRemediationAttempts,
      })
      .from(softwareComplianceStatus)
      .where(and(
        eq(softwareComplianceStatus.policyId, policyId),
        inArray(softwareComplianceStatus.deviceId, chunk),
      ));

    for (const row of rows) {
      byDevice.set(row.deviceId, {
        deviceId: row.deviceId,
        status: parseComplianceStatus(row.status),
        violations: row.violations,
        remediationStatus: parseRemediationStatus(row.remediationStatus),
        lastRemediationAttempt: row.lastRemediationAttempt,
        installRemediationStatus: parseInstallRemediationStatus(row.installRemediationStatus),
        lastInstallRemediationAttempt: row.lastInstallRemediationAttempt,
        installRemediationAttempts: parseAttemptCount(row.installRemediationAttempts),
      });
    }
  }

  return byDevice;
}

/**
 * Timing options only. `autoUninstall` used to be read here as
 * `autoUninstallEnabled`, which meant the worker carried its own copy of the
 * arming rule alongside evaluateSoftwarePolicyArming — the duplication that let
 * the two drift (contract D11). Arming now comes exclusively from that helper;
 * this function answers only "how long to wait", never "may we act".
 */
function readRemediationOptions(raw: unknown): {
  gracePeriodHours: number;
  cooldownMinutes: number;
} {
  if (!raw || typeof raw !== 'object') {
    return {
      gracePeriodHours: 0,
      cooldownMinutes: REMEDIATION_COOLDOWN_DEFAULT_MINUTES,
    };
  }

  const options = raw as Record<string, unknown>;
  const gracePeriodHours = typeof options.gracePeriod === 'number'
    ? Math.max(0, Math.min(24 * 90, Math.floor(options.gracePeriod)))
    : 0;
  const cooldownMinutes = typeof options.cooldownMinutes === 'number'
    ? Math.max(1, Math.min(24 * 90 * 60, Math.floor(options.cooldownMinutes)))
    : REMEDIATION_COOLDOWN_DEFAULT_MINUTES;

  return {
    gracePeriodHours,
    cooldownMinutes,
  };
}

/**
 * Earliest detection timestamp among violations of ONE type (contract D10).
 *
 * This used to be readEarliestUnauthorizedDetection, which hard-filtered
 * `type !== 'unauthorized'`, so a `missing` violation contributed nothing to
 * grace. With two remediation verbs each having their own grace clock, the
 * type is a REQUIRED argument rather than a default: the compiler then has to
 * point at every call site instead of letting one silently keep uninstall
 * semantics. Behaviour for 'unauthorized' is unchanged, byte for byte.
 */
export function readEarliestViolationDetection(
  violations: unknown,
  violationType: SoftwarePolicyViolation['type']
): Date | null {
  if (!Array.isArray(violations)) return null;
  let earliest: Date | null = null;

  for (const violation of violations) {
    if (!violation || typeof violation !== 'object') continue;
    const typed = violation as { type?: unknown; detectedAt?: unknown };
    if (typed.type !== violationType || typeof typed.detectedAt !== 'string') {
      continue;
    }
    const detectedAt = new Date(typed.detectedAt);
    if (Number.isNaN(detectedAt.getTime())) continue;
    if (!earliest || detectedAt.getTime() < earliest.getTime()) {
      earliest = detectedAt;
    }
  }

  return earliest;
}

/**
 * The only reasons this function ever defers. Narrowed from `string` so the
 * install decision can widen it into its own union without a cast.
 */
export type AutoRemediationDeferralReason = 'in_progress' | 'grace_period' | 'cooldown';

export function shouldQueueAutoRemediation(input: {
  violations: unknown;
  /** Which violation type's clock the grace window is measured against (D10). */
  violationType: SoftwarePolicyViolation['type'];
  previousRemediationStatus: string | null;
  lastRemediationAttempt: Date | null;
  now: Date;
  gracePeriodHours: number;
  cooldownMinutes: number;
}): { queue: boolean; reason?: AutoRemediationDeferralReason } {
  if (input.previousRemediationStatus === 'pending' || input.previousRemediationStatus === 'in_progress') {
    return { queue: false, reason: 'in_progress' };
  }

  const earliestDetectedAt = readEarliestViolationDetection(input.violations, input.violationType);
  if (input.gracePeriodHours > 0 && earliestDetectedAt) {
    const graceMs = input.gracePeriodHours * 60 * 60 * 1000;
    if ((input.now.getTime() - earliestDetectedAt.getTime()) < graceMs) {
      return { queue: false, reason: 'grace_period' };
    }
  }

  if (input.lastRemediationAttempt) {
    const cooldownMs = input.cooldownMinutes * 60 * 1000;
    if ((input.now.getTime() - input.lastRemediationAttempt.getTime()) < cooldownMs) {
      return { queue: false, reason: 'cooldown' };
    }
  }

  return { queue: true };
}

/** Why an install was not queued for a device on this pass. */
export type InstallRemediationSkipReason =
  | AutoRemediationDeferralReason
  | 'no_missing_violations'
  | 'no_catalog_id'
  | 'attempts_exhausted'
  | 'pass_cap';

export type InstallRemediationDecision =
  | { queue: true; catalogIds: string[]; attempt: number }
  | { queue: false; reason: InstallRemediationSkipReason };

/**
 * The whole install gate for one device, as a pure function (feature #5505 W02).
 *
 * GATE ORDER IS DELIBERATE and is the part most worth reading twice:
 *
 *  1. `missing` violations at all? A device whose only violations are
 *     `unauthorized` is not an install candidate — the uninstall verb owns it.
 *  2. Any of them carry a catalogId? A rule without one can be DETECTED as
 *     missing but cannot be installed: there is nothing to install. Spec §4
 *     requires the worker to skip it and say so rather than fail silently, so
 *     this maps to a visible 'skipped'. Checked before the timing gates because
 *     it is a policy-authoring defect the technician has to see now, not in two
 *     hours when the cooldown lapses.
 *  3. Consecutive attempts exhausted? Checked BEFORE grace/cooldown so an
 *     exhausted device reports the honest terminal reason ('gave_up') instead
 *     of disappearing behind an incidental cooldown. This is the terminator for
 *     spec Risks §1: a policy whose rule never matches what the installer
 *     registers in Add/Remove Programs would otherwise reinstall forever.
 *  4. Timing (in_progress / grace / cooldown), via the SAME
 *     shouldQueueAutoRemediation the uninstall verb uses, with the grace clock
 *     pointed at the `missing` violations (contract D10).
 *  5. Per-pass cap LAST. The cap must only be consumed by devices that would
 *     genuinely have queued; checking it earlier would let devices sitting in
 *     cooldown eat the budget and starve devices that are actually ready.
 *
 * Pure and total: no I/O, no clock read, no env read. Every input is supplied
 * by the caller so the whole matrix is testable without a database.
 */
export function decideInstallRemediation(input: {
  violations: SoftwarePolicyViolation[];
  previousInstallStatus: string | null;
  lastInstallAttempt: Date | null;
  attempts: number;
  now: Date;
  gracePeriodHours: number;
  cooldownMinutes: number;
  maxAttempts: number;
  capRemaining: number;
}): InstallRemediationDecision {
  const missingViolations = input.violations.filter(
    (violation) => !!violation && violation.type === 'missing'
  );
  if (missingViolations.length === 0) {
    return { queue: false, reason: 'no_missing_violations' };
  }

  const catalogIds: string[] = [];
  for (const violation of missingViolations) {
    const raw = violation.rule?.catalogId;
    if (typeof raw !== 'string') continue;
    const catalogId = raw.trim();
    if (catalogId.length === 0) continue;
    if (!catalogIds.includes(catalogId)) catalogIds.push(catalogId);
  }
  if (catalogIds.length === 0) {
    return { queue: false, reason: 'no_catalog_id' };
  }

  const attempts = Number.isFinite(input.attempts) ? Math.max(0, Math.floor(input.attempts)) : 0;
  if (attempts >= input.maxAttempts) {
    return { queue: false, reason: 'attempts_exhausted' };
  }

  const timing = shouldQueueAutoRemediation({
    violations: input.violations,
    violationType: 'missing',
    previousRemediationStatus: input.previousInstallStatus,
    lastRemediationAttempt: input.lastInstallAttempt,
    now: input.now,
    gracePeriodHours: input.gracePeriodHours,
    cooldownMinutes: input.cooldownMinutes,
  });
  if (!timing.queue && timing.reason) {
    return { queue: false, reason: timing.reason };
  }

  if (input.capRemaining <= 0) {
    return { queue: false, reason: 'pass_cap' };
  }

  return { queue: true, catalogIds, attempt: attempts + 1 };
}

/**
 * Unstick an install-remediation row whose enqueue produced no deployment
 * (#5505 W03, follow-up to W02's review).
 *
 * THE PROBLEM. W02 (#5917) shipped the producer ahead of the processor. Every
 * install job it enqueued hit the parking branch in the remediation worker,
 * completed as a no-op, and left its row at `install_remediation_status =
 * 'pending'` with an attempt stamped and the attempt counter incremented.
 * Installing a processor does NOT drain those rows: shouldQueueAutoRemediation's
 * first branch reads 'pending' as 'in_progress' with no staleness escape, and
 * installStatusForSkip writes nothing for a timing deferral — so the row is
 * stuck forever and the parked job is already gone from Redis.
 *
 * THE RULE. A row qualifies when its status is LIVE ('pending' | 'in_progress')
 * and no policy-owned deployment exists for it at or after the attempt that put
 * it there. It is reset to 'none' so the next gate evaluates it normally.
 *
 * WHY THE TIMESTAMP, NOT MEMBERSHIP. A device whose PREVIOUS cycle installed
 * successfully still has policy-owned deployments; reading mere membership as
 * proof of live work would leave exactly the crash-abandoned rows stuck.
 *
 * WHY DECREMENT BY ONE, NOT RESET TO ZERO. The counter is a loop terminator for
 * real install attempts, and an enqueue that produced no deployment made none —
 * so exactly one increment is unearned, and exactly one is given back. Resetting
 * to zero would also undo genuine attempts and could mask a true install loop;
 * decrementing is self-limiting, because each future enqueue adds one back.
 * A device that had already burned its whole budget while parked therefore gets
 * one honest attempt before 'gave_up', rather than being written off having
 * never installed anything.
 *
 * WHY THE TIMESTAMP IS CLEARED TOO. last_install_remediation_attempt records an
 * attempt that never happened, and shouldQueueAutoRemediation measures the
 * cooldown (2h by default) against it — so leaving it would unstick the row and
 * then immediately defer it again for up to two hours. Nulling it is both the
 * honest value and what makes the drain happen on the pass that reconciles.
 *
 * IDEMPOTENT. The result is a non-live status, so a second pass over the same
 * row returns undefined. Running the sweep every pass is a no-op once drained.
 *
 * SAFE AGAINST A DOUBLE INSTALL. A row reset in error (the job was enqueued but
 * has not run yet, so no deployment exists) costs at most one redundant job:
 * scheduleSoftwareInstallRemediation dedupes on its own jobId, and
 * processRemediateDeviceInstall re-checks hasUnfinishedPolicyOwnedInstall before
 * creating anything. No second deployment can result.
 *
 * Pure and total: no I/O, no clock read. Exported for tests.
 */
export function reconcileOrphanedInstallRemediation(input: {
  installRemediationStatus: SoftwarePolicyInstallRemediationStatus | null;
  lastInstallRemediationAttempt: Date | null;
  installRemediationAttempts: number;
  latestPolicyOwnedDeploymentAt: Date | null;
}):
  | {
      installRemediationStatus: 'none';
      installRemediationAttempts: number;
      lastInstallRemediationAttempt: null;
    }
  | undefined {
  const isLive =
    input.installRemediationStatus === 'pending' || input.installRemediationStatus === 'in_progress';
  if (!isLive) return undefined;

  const deployedAt = input.latestPolicyOwnedDeploymentAt;
  if (deployedAt) {
    const attemptedAt = input.lastInstallRemediationAttempt;
    // No attempt timestamp at all means nothing can vouch for this live status,
    // so any deployment is necessarily from an earlier cycle.
    if (attemptedAt && deployedAt.getTime() >= attemptedAt.getTime()) {
      return undefined;
    }
  }

  const attempts = Number.isFinite(input.installRemediationAttempts)
    ? Math.max(0, Math.floor(input.installRemediationAttempts))
    : 0;
  return {
    installRemediationStatus: 'none',
    installRemediationAttempts: Math.max(0, attempts - 1),
    lastInstallRemediationAttempt: null,
  };
}

/**
 * What (if anything) a skip should write to install_remediation_status.
 *
 * Timing deferrals write NOTHING, mirroring the uninstall path: a device inside
 * grace or cooldown has no new status to report, and overwriting a live
 * 'pending' with 'skipped' would tell a technician Breeze abandoned an install
 * that is in fact still in flight.
 */
export function installStatusForSkip(
  reason: InstallRemediationSkipReason
): SoftwarePolicyInstallRemediationStatus | undefined {
  if (reason === 'attempts_exhausted') return 'gave_up';
  if (reason === 'no_catalog_id' || reason === 'pass_cap') return 'skipped';
  return undefined;
}

type ScanPoliciesJobData = {
  type: 'scan-policies';
};

type CheckPolicyJobData = {
  type: 'check-policy';
  policyId: string;
  deviceIds?: string[];
  /**
   * Site-ceiling gate contract §3: the policy's approval_generation at
   * enqueue time. Compared against the freshly-reloaded row at dispatch —
   * a mismatch means the policy was edited after this job was queued, so
   * the job is skipped rather than enforcing a policy shape that no longer
   * applies. `undefined` means the caller did not opt into the check
   * (existing behavior — reload + isActive check only).
   */
  generation?: number;
};

type SoftwareComplianceJobData = ScanPoliciesJobData | CheckPolicyJobData;

let softwareComplianceQueue: Queue<SoftwareComplianceJobData> | null = null;
let softwareComplianceWorker: Worker<SoftwareComplianceJobData> | null = null;

export function getSoftwareComplianceQueue(): Queue<SoftwareComplianceJobData> {
  if (!softwareComplianceQueue) {
    softwareComplianceQueue = new Queue<SoftwareComplianceJobData>(SOFTWARE_COMPLIANCE_QUEUE, {
      connection: getBullMQConnection(),
    });
  }
  return softwareComplianceQueue;
}

async function processScanPolicies(): Promise<{ queued: number }> {
  const activePolicies = await db
    .select({ id: softwarePolicies.id })
    .from(softwarePolicies)
    .where(eq(softwarePolicies.isActive, true));

  if (activePolicies.length === 0) {
    return { queued: 0 };
  }

  const queue = getSoftwareComplianceQueue();
  const slot = Math.floor(Date.now() / SCAN_INTERVAL_MS);

  await queue.addBulk(
    activePolicies.map((policy) => ({
      name: 'check-policy',
      data: {
        type: 'check-policy' as const,
        policyId: policy.id,
      },
      opts: {
        jobId: `software-compliance-${policy.id}-${slot}`,
        removeOnComplete: { count: 200 },
        removeOnFail: { count: 300 },
        attempts: 3,
        backoff: { type: 'exponential' as const, delay: 5000 },
      },
    }))
  );

  return { queued: activePolicies.length };
}

export async function processCheckPolicy(data: CheckPolicyJobData): Promise<{
  policyId: string;
  devicesEvaluated: number;
  violations: number;
  remediationQueued: number;
  installRemediationQueued: number;
}> {
  const [policy] = await db
    .select()
    .from(softwarePolicies)
    .where(and(
      eq(softwarePolicies.id, data.policyId),
      eq(softwarePolicies.isActive, true),
    ))
    .limit(1);

  if (!policy) {
    console.warn(
      `[SoftwareComplianceWorker] Policy ${data.policyId} not found or inactive — job may be stale (queued after deletion)`
    );
    return {
      policyId: data.policyId,
      devicesEvaluated: 0,
      violations: 0,
      remediationQueued: 0,
      installRemediationQueued: 0,
    };
  }

  // Site-ceiling gate contract §3: a queued job may carry a generation
  // snapshot from enqueue time. If the policy was edited since, this job's
  // premise (enforce THAT config shape) no longer holds — skip rather than
  // enforce a superseded policy.
  if (data.generation !== undefined && policy.approvalGeneration !== data.generation) {
    console.warn(
      `[SoftwareComplianceWorker] Policy ${data.policyId} generation mismatch (job=${data.generation}, current=${policy.approvalGeneration}) — skipping superseded job`
    );
    return {
      policyId: data.policyId,
      devicesEvaluated: 0,
      violations: 0,
      remediationQueued: 0,
      installRemediationQueued: 0,
    };
  }

  // Resolve devices via config policy hierarchy ("closest wins")
  const resolvedDeviceIds = await resolveDeviceIdsForSoftwarePolicy(policy.id);
  let deviceIds = resolvedDeviceIds;
  if (Array.isArray(data.deviceIds) && data.deviceIds.length > 0) {
    const requested = new Set(data.deviceIds);
    deviceIds = resolvedDeviceIds.filter((id) => requested.has(id));
  }

  // Device→org map for the dual-owner audit rows (#2126): a per-device event
  // under a partner-wide policy (policy.orgId NULL) must carry the DEVICE's
  // org so the org admin can see it, alongside the policy's partnerId.
  //
  // Quick Support exclusion: ephemeral devices (`devices.isEphemeral`) live in
  // the hidden per-partner 'quick_support' org and are a stranger's personal
  // machine borrowed for one ~20-minute session. That org stays inside
  // technicians' accessibleOrgIds for RLS reasons, so a partner-wide policy
  // resolves them like any other device. Filtering them out of this lookup and
  // then narrowing deviceIds to what it returned keeps them out of compliance
  // evaluation AND out of the remediation (software install/uninstall) queue.
  const orgByDevice = new Map<string, string>();
  for (const chunk of chunkArray(deviceIds)) {
    const rows = await db
      .select({ id: devices.id, orgId: devices.orgId })
      .from(devices)
      .where(and(inArray(devices.id, chunk), eq(devices.isEphemeral, false)));
    for (const row of rows) orgByDevice.set(row.id, row.orgId);
  }
  deviceIds = deviceIds.filter((id) => orgByDevice.has(id));

  if (deviceIds.length === 0) {
    return {
      policyId: policy.id,
      devicesEvaluated: 0,
      violations: 0,
      remediationQueued: 0,
      installRemediationQueued: 0,
    };
  }

  const normalizedRules = normalizeSoftwarePolicyRules(policy.rules);
  const remediationOptions = readRemediationOptions(policy.remediationOptions);
  // Contract D11: ONE arming truth, shared with softwareRemediationWorker.ts and
  // the AI compliance tool. Evaluated once per pass — the policy row cannot
  // change mid-loop, and the generation gate above already refused a job whose
  // policy was edited after enqueue.
  const uninstallArming = evaluateSoftwarePolicyArming(policy, 'uninstall');
  const installArming = evaluateSoftwarePolicyArming(policy, 'install');
  const existingByDevice = await readComplianceStateByDevice(policy.id, deviceIds);

  // ---- #5505 W03: orphaned-install reconcile sweep, part 1 of 2 ------------
  // Prefetch only. The DECISION happens per device inside the loop below, in
  // the branch where a stuck status actually blocks progress — a device with
  // nothing missing any more is converging normally and W02's own
  // 'pending' -> 'completed' transition must be left to handle it.
  // See reconcileOrphanedInstallRemediation for why these rows exist at all.
  const reconcileCandidateIds = Array.from(existingByDevice.values())
    .filter(
      (state) =>
        state.installRemediationStatus === 'pending'
        || state.installRemediationStatus === 'in_progress'
    )
    .map((state) => state.deviceId);
  const latestPolicyOwnedInstallByDevice = reconcileCandidateIds.length > 0
    ? await readLatestPolicyOwnedInstallByDevice(policy.id, reconcileCandidateIds)
    : new Map<string, Date>();
  // ---- end reconcile sweep, part 1 ----------------------------------------
  const inventoryByDevice = await getSoftwareInventoryByDeviceIds(deviceIds);

  let violations = 0;
  const remediationTargets = new Set<string>();
  // Feature #5505 W02. Knobs are read ONCE PER PASS — per call, never module
  // load (contract D5); the cap is per policy per pass by definition.
  const installMaxPerPass = resolveInstallRemediationMaxPerPass();
  const installMaxAttempts = resolveInstallRemediationMaxAttempts();
  const installTargets: InstallRemediationTarget[] = [];
  const complianceUpserts: Parameters<typeof upsertSoftwareComplianceStatuses>[0] = [];
  const now = new Date();

  for (const deviceId of deviceIds) {
    const startedAt = Date.now();
    try {
      const existing = existingByDevice.get(deviceId);
      const inventory = inventoryByDevice.get(deviceId) ?? [];
      const evaluated = evaluateSoftwarePolicyAgainstInventory(policy, inventory);
      const violationsWithStableTimestamps = withStableViolationTimestamps(
        evaluated.violations,
        existing?.violations ?? null
      );
      const status = violationsWithStableTimestamps.length > 0 ? 'violation' : 'compliant';

      let remediationStatus: 'none' | 'pending' | 'in_progress' | 'completed' | 'failed' | undefined;
      if (status === 'compliant') {
        if (
          existing?.remediationStatus
          && existing.remediationStatus !== 'none'
          && existing.remediationStatus !== 'completed'
        ) {
          remediationStatus = 'completed';
        }
      } else if (existing?.remediationStatus === 'completed') {
        remediationStatus = 'none';
      }

      // ---- Feature #5505 W02: the install verb -------------------------------
      // Keyed on "does this device have a `missing` violation", NOT on the
      // overall compliance status: a device can be in `violation` purely
      // because of unauthorized software while having nothing missing, and the
      // two verbs must not read each other's condition.
      const hasMissingViolation = violationsWithStableTimestamps.some((v) => v.type === 'missing');

      let installRemediationStatus: SoftwarePolicyInstallRemediationStatus | undefined;
      let installRemediationAttempts: number | undefined;
      if (!hasMissingViolation) {
        // Desired state reached. Mirrors the uninstall transition above: a
        // working status settles to 'completed', and the CONSECUTIVE counter
        // resets so a future recurrence starts with a full attempt budget.
        // 'gave_up' also settles to 'completed' — the software is present now,
        // however it got there, and leaving a permanent tombstone on a healthy
        // device would be a lie.
        if (
          existing?.installRemediationStatus
          && existing.installRemediationStatus !== 'none'
          && existing.installRemediationStatus !== 'completed'
        ) {
          installRemediationStatus = 'completed';
        }
        if ((existing?.installRemediationAttempts ?? 0) > 0) {
          installRemediationAttempts = 0;
        }
      } else if (existing?.installRemediationStatus === 'completed') {
        // It came back. Clear the stale success so the next decision is not read
        // against a status describing a previous cycle.
        installRemediationStatus = 'none';
      }

      if (hasMissingViolation && installArming.armed) {
        // #5505 W03 reconcile sweep, part 2 of 2. This device still wants
        // software AND the policy is armed, so a live-but-orphaned status here
        // is exactly the stuck state: shouldQueueAutoRemediation would read it
        // as in_progress forever. Reconciling in place feeds the corrected
        // values straight into the gate, so the SAME pass that unsticks the row
        // also queues it — and the corrected values ride out on the upsert
        // below rather than needing their own UPDATE statement.
        const reconciled = reconcileOrphanedInstallRemediation({
          installRemediationStatus: existing?.installRemediationStatus ?? null,
          lastInstallRemediationAttempt: existing?.lastInstallRemediationAttempt ?? null,
          installRemediationAttempts: existing?.installRemediationAttempts ?? 0,
          latestPolicyOwnedDeploymentAt: latestPolicyOwnedInstallByDevice.get(deviceId) ?? null,
        });
        if (reconciled) {
          console.warn(
            `[SoftwareComplianceWorker] Reconciled orphaned install-remediation row for policy ${policy.id} device ${deviceId} (#5505 W03)`
          );
          installRemediationStatus = reconciled.installRemediationStatus;
          installRemediationAttempts = reconciled.installRemediationAttempts;
        }

        const installDecision = decideInstallRemediation({
          violations: violationsWithStableTimestamps,
          previousInstallStatus:
            reconciled?.installRemediationStatus ?? existing?.installRemediationStatus ?? null,
          lastInstallAttempt:
            reconciled ? reconciled.lastInstallRemediationAttempt : (existing?.lastInstallRemediationAttempt ?? null),
          attempts: reconciled?.installRemediationAttempts ?? existing?.installRemediationAttempts ?? 0,
          now,
          gracePeriodHours: remediationOptions.gracePeriodHours,
          cooldownMinutes: remediationOptions.cooldownMinutes,
          maxAttempts: installMaxAttempts,
          // Cap is measured against what THIS pass has already committed to.
          capRemaining: installMaxPerPass - installTargets.length,
        });

        if (installDecision.queue) {
          installTargets.push({
            deviceId,
            catalogIds: installDecision.catalogIds,
            attempt: installDecision.attempt,
          });
          recordSoftwareRemediationDecision('install_queued');
        } else {
          recordSoftwareRemediationDecision(`install_${installDecision.reason}`);
          const skipStatus = installStatusForSkip(installDecision.reason);
          if (skipStatus) {
            installRemediationStatus = skipStatus;
          }
          // Audit the give-up ONCE, on the transition. Firing it every pass
          // would put one row per device per 15 minutes into
          // software_policy_audit for as long as the policy stays armed.
          if (skipStatus === 'gave_up' && existing?.installRemediationStatus !== 'gave_up') {
            fireAudit({
              orgId: policy.orgId ?? orgByDevice.get(deviceId) ?? null,
              partnerId: policy.partnerId,
              policyId: policy.id,
              deviceId,
              action: SOFTWARE_POLICY_INSTALL_AUDIT_ACTIONS.gaveUp,
              actor: 'system',
              details: {
                policyName: policy.name,
                attempts: existing?.installRemediationAttempts ?? 0,
                maxAttempts: installMaxAttempts,
              },
            });
          }
        }
      }
      // ---- end install verb -------------------------------------------------

      complianceUpserts.push({
        deviceId,
        policyId: policy.id,
        status,
        violations: violationsWithStableTimestamps,
        checkedAt: now,
        remediationStatus,
        installRemediationStatus,
        installRemediationAttempts,
      });
      recordSoftwarePolicyEvaluation(policy.mode, status, Date.now() - startedAt, 'evaluated');

      if (status === 'violation') {
        violations += 1;
        recordSoftwarePolicyViolation(policy.mode, violationsWithStableTimestamps.length);

        fireAudit({
          orgId: policy.orgId ?? orgByDevice.get(deviceId) ?? null,
          partnerId: policy.partnerId,
          policyId: policy.id,
          deviceId,
          action: 'violation_detected',
          actor: 'system',
          details: {
            mode: policy.mode,
            violationCount: violationsWithStableTimestamps.length,
          },
        });

        // Two INDEPENDENT gates over the same violation set (spec §2). A policy
        // may arm both, one, or neither, and a device may be queued for both
        // verbs in one pass — removing an unauthorised app and installing a
        // required one are not in conflict.
        if (
          uninstallArming.armed
          && violationsWithStableTimestamps.some((violation) => violation.type === 'unauthorized')
        ) {
          const remediationDecision = shouldQueueAutoRemediation({
            violations: violationsWithStableTimestamps,
            violationType: 'unauthorized',
            previousRemediationStatus: existing?.remediationStatus ?? null,
            lastRemediationAttempt: existing?.lastRemediationAttempt ?? null,
            now,
            gracePeriodHours: remediationOptions.gracePeriodHours,
            cooldownMinutes: remediationOptions.cooldownMinutes,
          });

          if (remediationDecision.queue) {
            remediationTargets.add(deviceId);
            recordSoftwareRemediationDecision('queued');
          } else {
            recordSoftwareRemediationDecision(remediationDecision.reason ?? 'skipped');
          }
        }
      }
    } catch (error) {
      console.error('[SoftwareComplianceWorker] Device compliance evaluation failed', {
        policyId: policy.id,
        deviceId,
        error,
      });
      captureException(error);
      complianceUpserts.push({
        deviceId,
        policyId: policy.id,
        status: 'unknown',
        violations: [],
        checkedAt: now,
      });
      recordSoftwarePolicyEvaluation(policy.mode, 'unknown', Date.now() - startedAt, 'error');

      fireAudit({
        orgId: policy.orgId ?? orgByDevice.get(deviceId) ?? null,
        partnerId: policy.partnerId,
        policyId: policy.id,
        deviceId,
        action: 'compliance_check_failed',
        actor: 'system',
        details: {
          mode: policy.mode,
          error: error instanceof Error ? error.message : 'Unknown compliance evaluation error',
        },
      });
    }
  }

  if (complianceUpserts.length > 0) {
    await upsertSoftwareComplianceStatuses(complianceUpserts);
  }

  let remediationQueued = 0;
  const remediationTargetIds = Array.from(remediationTargets);
  if (remediationTargetIds.length > 0) {
    remediationQueued = await scheduleSoftwareRemediation(policy.id, remediationTargetIds);

    if (remediationQueued > 0) {
      for (const chunk of chunkArray(remediationTargetIds)) {
        await db
          .update(softwareComplianceStatus)
          .set({
            remediationStatus: 'pending',
            lastRemediationAttempt: new Date(),
          })
          .where(and(
            eq(softwareComplianceStatus.policyId, policy.id),
            inArray(softwareComplianceStatus.deviceId, chunk),
          ));
      }
    }

    fireAudit({
      orgId: policy.orgId,
      partnerId: policy.partnerId,
      policyId: policy.id,
      action: 'remediation_scheduled',
      actor: 'system',
      details: {
        targetCount: remediationTargetIds.length,
        queuedCount: remediationQueued,
        deferredCount: Math.max(0, remediationTargetIds.length - remediationQueued),
        ruleCount: normalizedRules.software.length,
      },
    });

    recordSoftwareRemediationDecision('scheduled', remediationQueued);
  }

  let installRemediationQueued = 0;
  if (installTargets.length > 0) {
    // Placed AFTER the upsertSoftwareComplianceStatuses flush above, so every
    // row this block is about to UPDATE is guaranteed to exist.
    const enqueuedDeviceIds = await scheduleSoftwareInstallRemediation(
      policy.id,
      installTargets,
      policy.approvalGeneration,
    );
    installRemediationQueued = enqueuedDeviceIds.length;

    if (enqueuedDeviceIds.length > 0) {
      const attemptedAt = new Date();
      for (const chunk of chunkArray(enqueuedDeviceIds)) {
        await db
          .update(softwareComplianceStatus)
          .set({
            installRemediationStatus: 'pending',
            lastInstallRemediationAttempt: attemptedAt,
            // Incremented in SQL, not from the value read at the top of the
            // pass: this is the authoritative counter, and doing the arithmetic
            // in the statement keeps it correct even if a concurrent pass or the
            // W03 processor touched the row in between.
            installRemediationAttempts: sql`${softwareComplianceStatus.installRemediationAttempts} + 1`,
          })
          .where(and(
            eq(softwareComplianceStatus.policyId, policy.id),
            inArray(softwareComplianceStatus.deviceId, chunk),
          ));
      }
    }

    fireAudit({
      orgId: policy.orgId,
      partnerId: policy.partnerId,
      policyId: policy.id,
      action: SOFTWARE_POLICY_INSTALL_AUDIT_ACTIONS.queued,
      actor: 'system',
      details: {
        targetCount: installTargets.length,
        queuedCount: installRemediationQueued,
        deferredCount: Math.max(0, installTargets.length - installRemediationQueued),
        maxPerPass: installMaxPerPass,
        maxAttempts: installMaxAttempts,
      },
    });

    recordSoftwareRemediationDecision('install_scheduled', installRemediationQueued);
  }

  return {
    policyId: policy.id,
    devicesEvaluated: deviceIds.length,
    violations,
    remediationQueued,
    installRemediationQueued,
  };
}

export function createSoftwareComplianceWorker(): Worker<SoftwareComplianceJobData> {
  return new Worker<SoftwareComplianceJobData>(
    SOFTWARE_COMPLIANCE_QUEUE,
    async (job: Job<SoftwareComplianceJobData>) => {
      return runWithSystemDbAccess(async () => {
        if (job.data.type === 'scan-policies') {
          return processScanPolicies();
        }
        return processCheckPolicy(job.data);
      });
    },
    {
      connection: getBullMQConnection(),
      concurrency: 4,
      lockDuration: 300_000,
      stalledInterval: 60_000,
      maxStalledCount: 2,
      settings: {
        backoffStrategy: (attemptsMade: number) => Math.min(attemptsMade * 5000, 30000),
      },
    }
  );
}

async function scheduleComplianceScan(): Promise<void> {
  const queue = getSoftwareComplianceQueue();
  const existing = await queue.getRepeatableJobs();
  for (const job of existing) {
    if (job.name === 'scan-policies') {
      await queue.removeRepeatableByKey(job.key);
    }
  }

  await queue.add(
    'scan-policies',
    { type: 'scan-policies' },
    {
      repeat: { every: SCAN_INTERVAL_MS },
      removeOnComplete: { count: 20 },
      removeOnFail: { count: 50 },
    }
  );
}

export async function initializeSoftwareComplianceWorker(): Promise<void> {
  softwareComplianceWorker = createSoftwareComplianceWorker();
  attachWorkerObservability(softwareComplianceWorker, 'softwareComplianceWorker');

  softwareComplianceWorker.on('error', (error) => {
    console.error('[SoftwareComplianceWorker] Worker error', { error });
    captureException(error);
  });

  softwareComplianceWorker.on('failed', (job, error) => {
    const data = job?.data as { type?: string; policyId?: string } | undefined;
    console.error('[SoftwareComplianceWorker] Job failed', {
      jobId: job?.id,
      jobType: data?.type,
      policyId: data?.policyId,
      error,
    });
    captureException(error);
  });

  try {
    await scheduleComplianceScan();
    console.log('[SoftwareComplianceWorker] Initialized');
  } catch (error) {
    console.error('[SoftwareComplianceWorker] Failed to schedule compliance scan — scans will not run:', error);
    captureException(error);
  }
}

export async function shutdownSoftwareComplianceWorker(): Promise<void> {
  if (softwareComplianceWorker) {
    await softwareComplianceWorker.close();
    softwareComplianceWorker = null;
  }

  if (softwareComplianceQueue) {
    await softwareComplianceQueue.close();
    softwareComplianceQueue = null;
  }
}

export async function scheduleSoftwareComplianceCheck(
  policyId?: string,
  deviceIds?: string[],
  generation?: number
): Promise<string> {
  const queue = getSoftwareComplianceQueue();
  const uniqueDeviceIds = Array.isArray(deviceIds)
    ? Array.from(new Set(deviceIds.filter((id) => typeof id === 'string' && id.length > 0)))
    : undefined;

  // Site-ceiling gate contract §3: most callers (create, /check,
  // agents/helpers.ts, aiToolsCompliance.ts) don't have a fresh row in hand
  // to pass a generation with — only the PATCH route does. Backfill from the
  // current row here so the worker's mismatch comparison is armed for every
  // enqueue path, not just PATCH. If the row can't be found, leave it
  // undefined — existing (opt-out) behavior.
  let resolvedGeneration = generation;
  if (resolvedGeneration === undefined && policyId) {
    const [current] = await db
      .select({ approvalGeneration: softwarePolicies.approvalGeneration })
      .from(softwarePolicies)
      .where(eq(softwarePolicies.id, policyId))
      .limit(1);
    resolvedGeneration = current?.approvalGeneration;
  }

  const job = await queue.add(
    policyId ? 'check-policy' : 'scan-policies',
    policyId
      ? {
        type: 'check-policy',
        policyId,
        deviceIds: uniqueDeviceIds,
        generation: resolvedGeneration,
      }
      : {
        type: 'scan-policies',
      },
    {
      // '-' separator (not ':') — BullMQ rejects custom jobIds whose colon-split
      // length !== 3, and this 4-part id would throw. See #1101.
      jobId: policyId
        ? [
          'software-compliance',
          policyId,
          stableShortHash(JSON.stringify(uniqueDeviceIds ?? [])),
          Math.floor(Date.now() / ON_DEMAND_DEDUPE_WINDOW_MS).toString(36),
        ].join('-')
        : undefined,
      removeOnComplete: { count: 100 },
      removeOnFail: { count: 200 },
      attempts: 3,
      backoff: { type: 'exponential' as const, delay: 5000 },
    }
  );

  return String(job.id);
}
