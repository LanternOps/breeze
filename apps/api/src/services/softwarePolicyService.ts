import { and, eq, inArray, sql, type SQL } from 'drizzle-orm';
import { db } from '../db';
import { captureException } from './sentry';
import {
  devices,
  softwareComplianceStatus,
  softwareInventory,
  softwarePolicies,
  softwarePolicyAudit,
  type SoftwarePolicyExecutableRule,
  type SoftwarePolicyRuleDefinition,
  type SoftwarePolicyRulesDefinition,
  type SoftwarePolicyViolation,
} from '../db/schema';

const BULK_CHUNK_SIZE = 500;

type SoftwarePolicyRow = typeof softwarePolicies.$inferSelect;

export type SoftwareInventoryRow = {
  name: string;
  version: string | null;
  vendor: string | null;
  catalogId: string | null;
};

export type SoftwarePolicyComplianceStatus = 'compliant' | 'violation' | 'unknown';
export type SoftwarePolicyRemediationStatus = 'none' | 'pending' | 'in_progress' | 'completed' | 'failed';

/**
 * Feature #5505 (contract D1): the install verb's own status axis. It is a
 * SUPERSET of SoftwarePolicyRemediationStatus, adding two install-specific
 * terminal states:
 *  - 'gave_up'  — the consecutive-attempt counter hit
 *                 SOFTWARE_INSTALL_REMEDIATION_MAX_ATTEMPTS. This is the
 *                 install-loop terminator (spec Risks §1); a policy whose rule
 *                 never matches what the installer registers would otherwise
 *                 reinstall every 15 minutes forever.
 *  - 'skipped'  — nothing was attempted and nothing is wrong with the device:
 *                 the rule carries no catalogId (so there is nothing to
 *                 install), the per-pass cap was reached, or (W03) the
 *                 catalog item has no install method for this device's OS.
 * Deliberately NOT a DB enum — remediation_status is a bare varchar(20) too.
 */
export type SoftwarePolicyInstallRemediationStatus =
  | 'none'
  | 'pending'
  | 'in_progress'
  | 'completed'
  | 'failed'
  | 'gave_up'
  | 'skipped';

export type SoftwareComplianceUpsertInput = {
  deviceId: string;
  policyId: string;
  status: SoftwarePolicyComplianceStatus;
  violations: SoftwarePolicyViolation[];
  checkedAt?: Date;
  /**
   * OPTIONAL ON PURPOSE, for all three of these. `undefined` means "this pass
   * has nothing to say about that column" and the generated statement must not
   * name it at all — see upsertSoftwareComplianceStatuses. Passing a value when
   * you mean "leave it alone" silently overwrites a live status.
   */
  remediationStatus?: SoftwarePolicyRemediationStatus;
  installRemediationStatus?: SoftwarePolicyInstallRemediationStatus;
  installRemediationAttempts?: number;
};

type DeviceSoftwareInventoryRow = SoftwareInventoryRow & {
  deviceId: string;
};

function chunkArray<T>(items: T[], size = BULK_CHUNK_SIZE): T[][] {
  if (items.length === 0) return [];
  const chunks: T[][] = [];
  for (let index = 0; index < items.length; index += size) {
    chunks.push(items.slice(index, index + size));
  }
  return chunks;
}

function normalizeComparable(value: string): string {
  return value.trim().toLowerCase();
}

function readOptionalString(value: unknown): string | undefined {
  if (typeof value !== 'string') return undefined;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : undefined;
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function compareVersionTokens(left: string, right: string): number {
  const leftNumeric = /^\d+$/.test(left);
  const rightNumeric = /^\d+$/.test(right);

  if (leftNumeric && rightNumeric) {
    const leftNum = Number.parseInt(left, 10);
    const rightNum = Number.parseInt(right, 10);
    if (leftNum > rightNum) return 1;
    if (leftNum < rightNum) return -1;
    return 0;
  }

  return left.localeCompare(right, undefined, {
    numeric: true,
    sensitivity: 'base',
  });
}

export function compareSoftwareVersions(leftVersion: string, rightVersion: string): number {
  const leftTokens = leftVersion.split(/[^0-9a-zA-Z]+/).filter((token) => token.length > 0);
  const rightTokens = rightVersion.split(/[^0-9a-zA-Z]+/).filter((token) => token.length > 0);
  const maxLength = Math.max(leftTokens.length, rightTokens.length);

  for (let index = 0; index < maxLength; index += 1) {
    const left = leftTokens[index] ?? '0';
    const right = rightTokens[index] ?? '0';
    const comparison = compareVersionTokens(left, right);
    if (comparison !== 0) return comparison;
  }

  return 0;
}

function violationFingerprint(violation: SoftwarePolicyViolation): string {
  const type = violation.type.toLowerCase();
  if (violation.type === 'unauthorized') {
    const name = normalizeComparable(violation.software?.name ?? '');
    const version = normalizeComparable(violation.software?.version ?? '');
    return `${type}:software:${name}:${version}`;
  }

  const ruleName = normalizeComparable(violation.rule?.name ?? '');
  const minVersion = normalizeComparable(violation.rule?.minVersion ?? '');
  const maxVersion = normalizeComparable(violation.rule?.maxVersion ?? '');
  return `${type}:rule:${ruleName}:${minVersion}:${maxVersion}`;
}

export function withStableViolationTimestamps(
  nextViolations: SoftwarePolicyViolation[],
  previousViolations: unknown
): SoftwarePolicyViolation[] {
  if (!Array.isArray(previousViolations) || nextViolations.length === 0) {
    return nextViolations;
  }

  const previousByKey = new Map<string, string>();
  for (const raw of previousViolations) {
    if (!raw || typeof raw !== 'object') continue;
    const candidate = raw as SoftwarePolicyViolation;
    const key = violationFingerprint(candidate);
    if (!key) continue;
    const detectedAt = candidate.detectedAt;
    if (typeof detectedAt !== 'string') continue;
    const normalized = new Date(detectedAt);
    if (Number.isNaN(normalized.getTime())) continue;
    const existing = previousByKey.get(key);
    if (!existing || normalized.getTime() < new Date(existing).getTime()) {
      previousByKey.set(key, normalized.toISOString());
    }
  }

  return nextViolations.map((violation) => {
    const key = violationFingerprint(violation);
    const previousDetectedAt = previousByKey.get(key);
    if (!previousDetectedAt) return violation;
    return {
      ...violation,
      detectedAt: previousDetectedAt,
    };
  });
}

/**
 * Remediation-arming gate (#3543, incident #3381; verb-aware since #5505).
 *
 * A policy only authorises remediation commands for a given verb when all three
 * are true: `mode !== 'audit'`, `enforceMode`, and that verb's own flag —
 * `remediationOptions.autoUninstall` for `'uninstall'`,
 * `remediationOptions.autoInstall` for `'install'`. The two flags are
 * deliberately independent: a policy armed to REMOVE unauthorised software is
 * not thereby armed to INSTALL anything.
 *
 * Until #3543 the gate lived ONLY inline in softwareComplianceWorker.ts, so
 * every other path that reached `scheduleSoftwareRemediation` (the AI tool, the
 * manual route, a replayed BullMQ job) could queue mass uninstalls against a
 * policy whose owner had deliberately left enforcement off. This is the single
 * shared definition — callers must use it rather than re-deriving the check.
 *
 * `verb` is REQUIRED and has no default: an unarmed policy must never be
 * mistaken for an armed one because a caller forgot an argument.
 */
export type PolicyRemediationVerb = 'uninstall' | 'install';

export type SoftwarePolicyUnarmedReason =
  | 'audit_mode'
  | 'enforce_mode_off'
  | 'auto_uninstall_off'
  | 'auto_install_off';

export type SoftwarePolicyArmingState =
  | { armed: true }
  | { armed: false; reason: SoftwarePolicyUnarmedReason; message: string };

export type SoftwarePolicyArmingInput = {
  mode: string | null | undefined;
  enforceMode: boolean | null | undefined;
  remediationOptions: unknown;
};

/** `autoUninstall` is opt-in: absent or non-object options mean NOT armed. */
export function readSoftwarePolicyAutoUninstall(raw: unknown): boolean {
  if (!raw || typeof raw !== 'object') return false;
  return (raw as Record<string, unknown>).autoUninstall === true;
}

/** `autoInstall` is opt-in: absent or non-object options mean NOT armed. */
export function readSoftwarePolicyAutoInstall(raw: unknown): boolean {
  if (!raw || typeof raw !== 'object') return false;
  return (raw as Record<string, unknown>).autoInstall === true;
}

export function evaluateSoftwarePolicyArming(
  policy: SoftwarePolicyArmingInput,
  verb: PolicyRemediationVerb
): SoftwarePolicyArmingState {
  if (policy.mode === 'audit') {
    return {
      armed: false,
      reason: 'audit_mode',
      message: `Policy is audit-only (mode="audit"); it cannot ${verb} software.`,
    };
  }
  if (policy.enforceMode !== true) {
    return {
      armed: false,
      reason: 'enforce_mode_off',
      message:
        `Policy enforcement is off (enforceMode=false), so it is detect-only and must not ${verb} software. `
        + 'An administrator has to enable enforcement on the policy first.',
    };
  }
  if (verb === 'install') {
    if (!readSoftwarePolicyAutoInstall(policy.remediationOptions)) {
      return {
        armed: false,
        reason: 'auto_install_off',
        message:
          'Policy remediation is not armed (remediationOptions.autoInstall is not true), so it must not install software. '
          + 'An administrator has to enable automatic install on the policy first.',
      };
    }
    return { armed: true };
  }
  if (!readSoftwarePolicyAutoUninstall(policy.remediationOptions)) {
    return {
      armed: false,
      reason: 'auto_uninstall_off',
      message:
        'Policy remediation is not armed (remediationOptions.autoUninstall is not true), so it must not uninstall software. '
        + 'An administrator has to enable automatic uninstall on the policy first.',
    };
  }
  return { armed: true };
}

/**
 * Install-remediation audit actions (#5505 D6).
 *
 * `software_policy_audit.action` is a bare `varchar(50)`
 * (`db/schema/softwarePolicies.ts:142`) written as `action: string` — no enum,
 * no pre-existing const set — so this object IS the registry. Every emitter
 * imports it; no install emit site writes a string literal.
 *
 * Install actions never reuse an uninstall action value: an audit reader must
 * never have to infer which verb an event describes. The existing uninstall
 * action strings are deliberately NOT refactored into a matching object here —
 * that is a separate, unrelated change.
 */
export const SOFTWARE_POLICY_INSTALL_AUDIT_ACTIONS = {
  /** An install was queued for a (policy, device). */
  queued: 'install_queued',
  /** The queued install reported success. */
  succeeded: 'install_succeeded',
  /** The queued install reported failure (one attempt). */
  failed: 'install_failed',
  /** Consecutive attempts exhausted; the install loop guard stopped retrying. */
  gaveUp: 'install_gave_up',
  /**
   * The pass ran to completion and created NO deployment, with nothing having
   * errored — every candidate was skipped (unreachable catalog item, no
   * install target for the device's OS, or a payload id the policy no longer
   * reports missing).
   *
   * Added by #5505 W03. Without it the emit site had to fall back to `queued`
   * for this outcome, which put "an install was queued for this device" in the
   * durable audit trail when nothing was: `action` is the dimension a
   * technician filters on, and the contradiction was visible only by reading
   * details.deploymentsCreated. The reason for each skip travels in
   * details.skipped.
   */
  skipped: 'install_skipped',
} as const;

export type SoftwarePolicyInstallAuditAction =
  (typeof SOFTWARE_POLICY_INSTALL_AUDIT_ACTIONS)[keyof typeof SOFTWARE_POLICY_INSTALL_AUDIT_ACTIONS];

export function normalizeSoftwarePolicyRules(rules: unknown): SoftwarePolicyRulesDefinition {
  if (!rules || typeof rules !== 'object') {
    return { software: [], allowUnknown: false };
  }

  const raw = rules as Record<string, unknown>;
  const rawSoftware = Array.isArray(raw.software) ? raw.software : [];

  const software = rawSoftware
    .filter((entry): entry is Record<string, unknown> => !!entry && typeof entry === 'object')
    .map((entry) => {
      const name = readOptionalString(entry.name);
      if (!name) {
        return null;
      }

      const rule: SoftwarePolicyRuleDefinition = { name };
      const vendor = readOptionalString(entry.vendor);
      const minVersion = readOptionalString(entry.minVersion);
      const maxVersion = readOptionalString(entry.maxVersion);
      const catalogId = readOptionalString(entry.catalogId);
      const reason = readOptionalString(entry.reason);

      if (vendor) rule.vendor = vendor;
      if (minVersion) rule.minVersion = minVersion;
      if (maxVersion) rule.maxVersion = maxVersion;
      if (catalogId) rule.catalogId = catalogId;
      if (reason) rule.reason = reason;

      return rule;
    })
    .filter((entry): entry is SoftwarePolicyRuleDefinition => entry !== null);

  const rawExecutable = Array.isArray(raw.executable) ? raw.executable : [];
  const executable = rawExecutable
    .filter((entry): entry is Record<string, unknown> => !!entry && typeof entry === 'object')
    .map((entry) => {
      const name = readOptionalString(entry.name);
      if (!name) {
        return null;
      }

      const rule: SoftwarePolicyExecutableRule = { name };
      const sha256 = readOptionalString(entry.sha256);
      const signer = readOptionalString(entry.signer);
      const publisher = readOptionalString(entry.publisher);
      const pathGlob = readOptionalString(entry.pathGlob);

      if (sha256) rule.sha256 = sha256;
      if (signer) rule.signer = signer;
      if (publisher) rule.publisher = publisher;
      if (pathGlob) rule.pathGlob = pathGlob;

      return rule;
    })
    .filter((entry): entry is SoftwarePolicyExecutableRule => entry !== null);

  const result: SoftwarePolicyRulesDefinition = {
    software,
    allowUnknown: raw.allowUnknown === true,
  };
  if (executable.length > 0) {
    result.executable = executable;
  }
  return result;
}

export function matchesSoftwareRule(
  installed: SoftwareInventoryRow,
  rule: SoftwarePolicyRuleDefinition
): boolean {
  if (rule.catalogId && installed.catalogId && installed.catalogId !== rule.catalogId) {
    return false;
  }

  const pattern = `^${escapeRegExp(rule.name).replace(/\\\*/g, '.*')}$`;
  const nameRegex = new RegExp(pattern, 'i');
  if (!nameRegex.test(installed.name)) {
    return false;
  }

  if (rule.vendor && normalizeComparable(installed.vendor ?? '') !== normalizeComparable(rule.vendor)) {
    return false;
  }

  if (rule.minVersion) {
    if (!installed.version) return false;
    if (compareSoftwareVersions(installed.version, rule.minVersion) < 0) return false;
  }

  if (rule.maxVersion) {
    if (!installed.version) return false;
    if (compareSoftwareVersions(installed.version, rule.maxVersion) > 0) return false;
  }

  return true;
}

export function evaluateSoftwareInventory(
  mode: typeof softwarePolicies.$inferSelect.mode,
  rules: SoftwarePolicyRulesDefinition,
  inventory: SoftwareInventoryRow[]
): SoftwarePolicyViolation[] {
  const violations: SoftwarePolicyViolation[] = [];
  const detectedAt = new Date().toISOString();
  const softwareRules = rules.software ?? [];
  const allowUnknown = rules.allowUnknown === true;

  if (mode === 'allowlist') {
    for (const installed of inventory) {
      const allowed = softwareRules.some((rule) => matchesSoftwareRule(installed, rule));
      if (!allowed && !allowUnknown) {
        violations.push({
          type: 'unauthorized',
          software: {
            name: installed.name,
            version: installed.version,
            vendor: installed.vendor,
          },
          severity: 'medium',
          detectedAt,
        });
      }
    }

    for (const rule of softwareRules) {
      const found = inventory.some((installed) => matchesSoftwareRule(installed, rule));
      if (!found) {
        violations.push({
          type: 'missing',
          rule: {
            name: rule.name,
            minVersion: rule.minVersion,
            maxVersion: rule.maxVersion,
            // #5505 D9: the install path resolves the catalog item from here.
            // `reason` mirrors the audit-mode branch below, which has always
            // carried it — a `missing` violation dropping it was an oversight.
            catalogId: rule.catalogId,
            reason: rule.reason,
          },
          severity: 'high',
          detectedAt,
        });
      }
    }

    return violations;
  }

  // Audit mode uses blocklist-style detection but does not auto-remediate.
  for (const installed of inventory) {
    const matchedRule = softwareRules.find((rule) => matchesSoftwareRule(installed, rule));
    if (!matchedRule) continue;

    violations.push({
      type: 'unauthorized',
      software: {
        name: installed.name,
        version: installed.version,
        vendor: installed.vendor,
      },
      rule: {
        name: matchedRule.name,
        minVersion: matchedRule.minVersion,
        maxVersion: matchedRule.maxVersion,
        reason: matchedRule.reason,
      },
      severity: mode === 'blocklist' ? 'critical' : 'medium',
      detectedAt,
    });
  }

  return violations;
}

export function evaluateSoftwarePolicyAgainstInventory(
  policy: Pick<typeof softwarePolicies.$inferSelect, 'mode' | 'rules'>,
  inventory: SoftwareInventoryRow[]
): {
  status: Exclude<SoftwarePolicyComplianceStatus, 'unknown'>;
  violations: SoftwarePolicyViolation[];
} {
  const rules = normalizeSoftwarePolicyRules(policy.rules);
  const violations = evaluateSoftwareInventory(policy.mode, rules, inventory);
  return {
    status: violations.length > 0 ? 'violation' : 'compliant',
    violations,
  };
}

export async function getSoftwareInventoryByDeviceIds(
  deviceIds: string[]
): Promise<Map<string, SoftwareInventoryRow[]>> {
  const normalizedDeviceIds = Array.from(
    new Set(deviceIds.filter((id): id is string => typeof id === 'string' && id.length > 0))
  );
  const byDeviceId = new Map<string, SoftwareInventoryRow[]>();
  if (normalizedDeviceIds.length === 0) {
    return byDeviceId;
  }

  for (const deviceId of normalizedDeviceIds) {
    byDeviceId.set(deviceId, []);
  }

  for (const chunk of chunkArray(normalizedDeviceIds)) {
    const rows = await db
      .select({
        deviceId: softwareInventory.deviceId,
        name: softwareInventory.name,
        version: softwareInventory.version,
        vendor: softwareInventory.vendor,
        catalogId: softwareInventory.catalogId,
      })
      .from(softwareInventory)
      .where(inArray(softwareInventory.deviceId, chunk));

    for (const row of rows as DeviceSoftwareInventoryRow[]) {
      const bucket = byDeviceId.get(row.deviceId);
      if (!bucket) continue;
      bucket.push({
        name: row.name,
        version: row.version,
        vendor: row.vendor,
        catalogId: row.catalogId,
      });
    }
  }

  return byDeviceId;
}

export async function evaluateSoftwarePolicyForDevice(
  policy: typeof softwarePolicies.$inferSelect,
  deviceId: string
): Promise<{
  status: Exclude<SoftwarePolicyComplianceStatus, 'unknown'>;
  violations: SoftwarePolicyViolation[];
}> {
  const inventory = await db
    .select({
      name: softwareInventory.name,
      version: softwareInventory.version,
      vendor: softwareInventory.vendor,
      catalogId: softwareInventory.catalogId,
    })
    .from(softwareInventory)
    .where(eq(softwareInventory.deviceId, deviceId));

  return evaluateSoftwarePolicyAgainstInventory(policy, inventory);
}

/**
 * Optional columns of software_compliance_status, keyed by their
 * SoftwareComplianceUpsertInput field name. Values are FACTORIES, not shared
 * SQL objects, so each generated statement gets its own fragment.
 */
type ComplianceUpsertOptionalKey = keyof SoftwareComplianceUpsertInput
  & ('remediationStatus' | 'installRemediationStatus' | 'installRemediationAttempts');

const COMPLIANCE_UPSERT_OPTIONAL_COLUMNS: Record<ComplianceUpsertOptionalKey, () => SQL> = {
  remediationStatus: () => sql`excluded.remediation_status`,
  installRemediationStatus: () => sql`excluded.install_remediation_status`,
  installRemediationAttempts: () => sql`excluded.install_remediation_attempts`,
};

const COMPLIANCE_UPSERT_OPTIONAL_KEYS = Object.keys(
  COMPLIANCE_UPSERT_OPTIONAL_COLUMNS
) as ComplianceUpsertOptionalKey[];

export async function upsertSoftwareComplianceStatuses(
  inputs: SoftwareComplianceUpsertInput[]
): Promise<void> {
  if (inputs.length === 0) return;

  const normalized = inputs.filter((input) => (
    typeof input.deviceId === 'string'
    && input.deviceId.length > 0
    && typeof input.policyId === 'string'
    && input.policyId.length > 0
  ));
  if (normalized.length === 0) return;

  // Group by WHICH optional columns each input actually carries.
  //
  // A bulk onConflictDoUpdate shares ONE `set` clause across its whole chunk,
  // and `excluded.<col>` reads the value of the row this statement tried to
  // insert. So an input that says nothing about a column must not travel in the
  // same statement as one that does — otherwise the silent input's insert-time
  // DEFAULT ('none' / 0) is written over a live value. That is exactly why the
  // original implementation split on "was remediationStatus provided"; this
  // generalises the same split to every optional column and is byte-equivalent
  // for callers that pass only remediationStatus (they still produce the same
  // two groups, with the same set clauses, as before).
  //
  // The membership test is `!== undefined`, NOT truthiness:
  // installRemediationAttempts: 0 is the counter RESET and must be written.
  const byShape = new Map<string, SoftwareComplianceUpsertInput[]>();
  for (const input of normalized) {
    const presentKeys = COMPLIANCE_UPSERT_OPTIONAL_KEYS.filter((key) => input[key] !== undefined);
    const shapeKey = presentKeys.join('|');
    const bucket = byShape.get(shapeKey);
    if (bucket) bucket.push(input);
    else byShape.set(shapeKey, [input]);
  }

  for (const [shapeKey, group] of byShape) {
    const optionalKeys = shapeKey.length > 0
      ? (shapeKey.split('|') as ComplianceUpsertOptionalKey[])
      : [];

    for (const chunk of chunkArray(group)) {
      if (chunk.length === 0) continue;
      await db
        .insert(softwareComplianceStatus)
        .values(chunk.map((input) => {
          const row: Record<string, unknown> = {
            deviceId: input.deviceId,
            policyId: input.policyId,
            status: input.status,
            violations: input.violations,
            lastChecked: input.checkedAt ?? new Date(),
          };
          for (const key of optionalKeys) {
            row[key] = input[key];
          }
          return row as typeof softwareComplianceStatus.$inferInsert;
        }))
        .onConflictDoUpdate({
          target: [softwareComplianceStatus.deviceId, softwareComplianceStatus.policyId],
          set: {
            status: sql`excluded.status`,
            violations: sql`excluded.violations`,
            lastChecked: sql`excluded.last_checked`,
            ...Object.fromEntries(
              optionalKeys.map((key) => [key, COMPLIANCE_UPSERT_OPTIONAL_COLUMNS[key]()])
            ),
          },
        });
    }
  }
}

export async function upsertSoftwareComplianceStatus(params: {
  deviceId: string;
  policyId: string;
  status: SoftwarePolicyComplianceStatus;
  violations: SoftwarePolicyViolation[];
  remediationStatus?: 'none' | 'pending' | 'in_progress' | 'completed' | 'failed';
}): Promise<void> {
  await upsertSoftwareComplianceStatuses([{
    deviceId: params.deviceId,
    policyId: params.policyId,
    status: params.status,
    violations: params.violations,
    checkedAt: new Date(),
    remediationStatus: params.remediationStatus,
  }]);
}

export async function recordSoftwarePolicyAudit(input: {
  // Dual-owner audit (#2126): a device-level event under a partner-wide policy
  // carries BOTH the device's orgId (org-admin visibility) and the policy's
  // partnerId (partner-admin visibility); policy-level events carry whichever
  // axis owns the policy. At least one must be set (DB CHECK enforces it).
  orgId: string | null;
  partnerId?: string | null;
  policyId?: string | null;
  deviceId?: string | null;
  action: string;
  actor: 'user' | 'system' | 'ai';
  actorId?: string | null;
  details?: Record<string, unknown> | null;
}): Promise<void> {
  try {
    if (!input.orgId && !input.partnerId) {
      throw new Error('software policy audit requires at least one owner axis (orgId or partnerId)');
    }
    await db.insert(softwarePolicyAudit).values({
      orgId: input.orgId,
      partnerId: input.partnerId ?? null,
      policyId: input.policyId ?? null,
      deviceId: input.deviceId ?? null,
      action: input.action,
      actor: input.actor,
      actorId: input.actorId ?? null,
      details: input.details ?? null,
    });
  } catch (err) {
    // Audit rows exist for accountability — losing one silently defeats the
    // point, so surface to Sentry (mirrors auditService's exhausted-retry
    // posture) in addition to the structured log.
    console.error('[softwarePolicyService] Failed to write policy audit record', {
      orgId: input.orgId,
      partnerId: input.partnerId,
      policyId: input.policyId,
      deviceId: input.deviceId,
      action: input.action,
      error: err,
    });
    captureException(err);
  }
}
