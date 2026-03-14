import { and, desc, eq, sql } from 'drizzle-orm';
import { db } from '../db';
import {
  auditBaselines,
  auditBaselineResults,
  auditPolicyStates,
  devices,
  organizations,
} from '../db/schema';
import { publishEvent } from './eventBus';

export type AuditBaselineOsType = 'windows' | 'macos' | 'linux';
export type AuditBaselineProfile = 'cis_l1' | 'cis_l2' | 'custom';

export interface AuditDeviation {
  setting: string;
  expected: unknown;
  actual: unknown;
  reason: 'missing' | 'mismatch';
}

interface RuleExpected {
  op: 'equals' | 'in' | 'includes' | 'gte' | 'lte' | 'regex';
  value?: unknown;
  values?: unknown[];
}

interface AuditComparisonResult {
  compliant: boolean;
  score: number;
  deviations: AuditDeviation[];
}

type BaselineTemplate = {
  name: string;
  osType: AuditBaselineOsType;
  profile: Exclude<AuditBaselineProfile, 'custom'>;
  settings: Record<string, unknown>;
};

export const DEFAULT_AUDIT_BASELINE_TEMPLATES: BaselineTemplate[] = [
  {
    name: 'CIS L1 Audit Baseline (Windows)',
    osType: 'windows',
    profile: 'cis_l1',
    settings: {
      'auditpol:logon': 'success_and_failure',
      'auditpol:account lockout': 'success_and_failure',
      'auditpol:security state change': 'success',
      'auditpol:system integrity': 'success_and_failure',
    },
  },
  {
    name: 'CIS L2 Audit Baseline (Windows)',
    osType: 'windows',
    profile: 'cis_l2',
    settings: {
      'auditpol:logon': 'success_and_failure',
      'auditpol:account lockout': 'success_and_failure',
      'auditpol:security state change': 'success',
      'auditpol:process creation': 'success_and_failure',
      'auditpol:credential validation': 'success_and_failure',
    },
  },
  {
    name: 'CIS L1 Audit Baseline (macOS)',
    osType: 'macos',
    profile: 'cis_l1',
    settings: {
      'audit_control.flags': { op: 'includes', value: 'lo' },
      'audit_control.naflags': { op: 'includes', value: 'lo' },
      'audit_control.policy': { op: 'includes', value: 'cnt' },
      'audit_control.filesz': { op: 'gte', value: 5 },
    },
  },
  {
    name: 'CIS L2 Audit Baseline (macOS)',
    osType: 'macos',
    profile: 'cis_l2',
    settings: {
      'audit_control.flags': { op: 'includes', value: 'aa' },
      'audit_control.naflags': { op: 'includes', value: 'lo' },
      'audit_control.policy': { op: 'includes', value: 'cnt' },
      'audit_control.filesz': { op: 'gte', value: 10 },
    },
  },
  {
    name: 'CIS L1 Audit Baseline (Linux)',
    osType: 'linux',
    profile: 'cis_l1',
    settings: {
      'auditd.enabled': true,
      'auditd.failure_mode': { op: 'in', values: ['single', '1'] },
      'auditd.max_log_file_action': { op: 'in', values: ['keep_logs', 'rotate'] },
      'auditd.space_left_action': { op: 'in', values: ['email', 'syslog', 'single'] },
    },
  },
  {
    name: 'CIS L2 Audit Baseline (Linux)',
    osType: 'linux',
    profile: 'cis_l2',
    settings: {
      'auditd.enabled': true,
      'auditd.failure_mode': { op: 'in', values: ['single', '2', 'panic'] },
      'auditd.max_log_file_action': 'keep_logs',
      'auditd.space_left_action': { op: 'in', values: ['email', 'single', 'halt'] },
      'auditd.admin_space_left_action': { op: 'in', values: ['single', 'halt'] },
    },
  },
];

function normalizeKey(key: string): string {
  return key.trim().toLowerCase();
}

function normalizeSettings(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return {};
  }

  const settings: Record<string, unknown> = {};
  for (const [key, settingValue] of Object.entries(value)) {
    const normalized = normalizeKey(key);
    if (!normalized) continue;
    settings[normalized] = settingValue;
  }

  return settings;
}

function stableNormalize(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map(stableNormalize);
  }

  if (value && typeof value === 'object') {
    const entries = Object.entries(value as Record<string, unknown>)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, child]) => [key, stableNormalize(child)] as const);
    return Object.fromEntries(entries);
  }

  return value;
}

function deepEquals(left: unknown, right: unknown): boolean {
  return JSON.stringify(stableNormalize(left)) === JSON.stringify(stableNormalize(right));
}

function asRuleExpected(value: unknown): RuleExpected | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return null;
  }

  const candidate = value as Partial<RuleExpected>;
  if (!candidate.op) {
    return null;
  }

  if (!['equals', 'in', 'includes', 'gte', 'lte', 'regex'].includes(candidate.op)) {
    return null;
  }

  if (candidate.op === 'in' && !Array.isArray(candidate.values)) {
    console.warn(`[auditBaseline] asRuleExpected: op 'in' missing values array`);
    return null;
  }

  if (candidate.op !== 'in' && candidate.value === undefined) {
    console.warn(`[auditBaseline] asRuleExpected: op '${candidate.op}' missing value`);
    return null;
  }

  return candidate as RuleExpected;
}

function matchesExpected(actual: unknown, expected: unknown): boolean {
  const rule = asRuleExpected(expected);
  if (!rule) {
    return deepEquals(actual, expected);
  }

  switch (rule.op) {
    case 'equals':
      return deepEquals(actual, rule.value);
    case 'in': {
      const values = Array.isArray(rule.values) ? rule.values : [];
      return values.some((value) => deepEquals(actual, value));
    }
    case 'includes': {
      if (Array.isArray(actual)) {
        return actual.some((value) => deepEquals(value, rule.value));
      }
      if (typeof actual === 'string' && typeof rule.value === 'string') {
        return actual.toLowerCase().includes(rule.value.toLowerCase());
      }
      return false;
    }
    case 'gte': {
      const actualNum = Number(actual);
      const expectedNum = Number(rule.value);
      return Number.isFinite(actualNum) && Number.isFinite(expectedNum) && actualNum >= expectedNum;
    }
    case 'lte': {
      const actualNum = Number(actual);
      const expectedNum = Number(rule.value);
      return Number.isFinite(actualNum) && Number.isFinite(expectedNum) && actualNum <= expectedNum;
    }
    case 'regex': {
      if (typeof actual !== 'string' || typeof rule.value !== 'string') {
        return false;
      }
      try {
        return new RegExp(rule.value, 'i').test(actual);
      } catch (err) {
        console.warn(`[auditBaseline] invalid regex in rule value "${rule.value}":`, err);
        return false;
      }
    }
    default:
      return false;
  }
}

export function compareAuditPolicySettings(
  actualInput: unknown,
  expectedInput: unknown
): AuditComparisonResult {
  const actual = normalizeSettings(actualInput);
  const expected = normalizeSettings(expectedInput);

  const deviations: AuditDeviation[] = [];
  const expectedEntries = Object.entries(expected);

  for (const [setting, expectedValue] of expectedEntries) {
    if (!(setting in actual)) {
      deviations.push({
        setting,
        expected: expectedValue,
        actual: null,
        reason: 'missing',
      });
      continue;
    }

    const actualValue = actual[setting];
    if (!matchesExpected(actualValue, expectedValue)) {
      deviations.push({
        setting,
        expected: expectedValue,
        actual: actualValue,
        reason: 'mismatch',
      });
    }
  }

  if (expectedEntries.length === 0) {
    return {
      compliant: true,
      score: 100,
      deviations,
    };
  }

  const passed = expectedEntries.length - deviations.length;
  const score = Math.max(0, Math.round((passed / expectedEntries.length) * 100));

  return {
    compliant: deviations.length === 0,
    score,
    deviations,
  };
}

export function getTemplateSettings(
  osType: AuditBaselineOsType,
  profile: Exclude<AuditBaselineProfile, 'custom'>
): Record<string, unknown> {
  const template = DEFAULT_AUDIT_BASELINE_TEMPLATES.find((candidate) => {
    return candidate.osType === osType && candidate.profile === profile;
  });

  return template?.settings ?? {};
}

export async function seedDefaultAuditBaselines(): Promise<{ created: number }> {
  const orgRows = await db.select({ id: organizations.id }).from(organizations);
  if (orgRows.length === 0) {
    return { created: 0 };
  }

  // Check which org+osType+profile combos already have baselines
  const existing = await db
    .select({
      orgId: auditBaselines.orgId,
      osType: auditBaselines.osType,
      profile: auditBaselines.profile,
    })
    .from(auditBaselines);

  const existingKeys = new Set(
    existing.map((e) => `${e.orgId}:${e.osType}:${e.profile}`)
  );

  const values = orgRows.flatMap((org) =>
    DEFAULT_AUDIT_BASELINE_TEMPLATES
      .filter((template) => !existingKeys.has(`${org.id}:${template.osType}:${template.profile}`))
      .map((template) => ({
        orgId: org.id,
        name: template.name,
        osType: template.osType,
        profile: template.profile,
        settings: template.settings,
        isActive: false,
        createdBy: null,
      }))
  );

  if (values.length === 0) {
    return { created: 0 };
  }

  const inserted = await db
    .insert(auditBaselines)
    .values(values)
    .returning({ id: auditBaselines.id });

  return { created: inserted.length };
}

export interface CollectAuditPolicyPayload {
  osType?: string;
  collectedAt?: string;
  settings?: Record<string, unknown>;
  raw?: Record<string, unknown>;
}

export async function insertAuditPolicyState(
  deviceId: string,
  payload: CollectAuditPolicyPayload
): Promise<typeof auditPolicyStates.$inferSelect> {
  const [device] = await db
    .select({ id: devices.id, orgId: devices.orgId, osType: devices.osType })
    .from(devices)
    .where(eq(devices.id, deviceId))
    .limit(1);

  if (!device) {
    throw new Error('Device not found');
  }

  const now = new Date();
  const collectedAt = typeof payload.collectedAt === 'string'
    ? new Date(payload.collectedAt)
    : now;

  const [state] = await db
    .insert(auditPolicyStates)
    .values({
      orgId: device.orgId,
      deviceId: device.id,
      osType: payload.osType ?? device.osType,
      settings: normalizeSettings(payload.settings),
      raw: payload.raw ?? null,
      collectedAt: Number.isNaN(collectedAt.getTime()) ? now : collectedAt,
    })
    .returning();

  if (!state) {
    throw new Error('Failed to persist audit policy state');
  }

  return state;
}

async function evaluatePolicyStateAgainstBaseline(
  state: typeof auditPolicyStates.$inferSelect,
  baseline: typeof auditBaselines.$inferSelect
): Promise<typeof auditBaselineResults.$inferSelect> {
  const comparison = compareAuditPolicySettings(state.settings, baseline.settings);
  const checkedAt = new Date();

  const [previous] = await db
    .select({
      compliant: auditBaselineResults.compliant,
      checkedAt: auditBaselineResults.checkedAt,
    })
    .from(auditBaselineResults)
    .where(and(
      eq(auditBaselineResults.deviceId, state.deviceId),
      eq(auditBaselineResults.baselineId, baseline.id),
    ))
    .orderBy(desc(auditBaselineResults.checkedAt))
    .limit(1);

  const [result] = await db
    .insert(auditBaselineResults)
    .values({
      orgId: state.orgId,
      deviceId: state.deviceId,
      baselineId: baseline.id,
      compliant: comparison.compliant,
      score: comparison.score,
      deviations: comparison.deviations,
      checkedAt,
      remediatedAt: previous && !previous.compliant && comparison.compliant ? checkedAt : null,
    })
    .returning();

  if (!result) {
    throw new Error('Failed to persist audit baseline result');
  }

  try {
    if (!comparison.compliant) {
      await publishEvent(
        'compliance.audit_deviation',
        state.orgId,
        {
          baselineId: baseline.id,
          deviceId: state.deviceId,
          score: comparison.score,
          deviations: comparison.deviations,
        },
        'audit-baseline-evaluator'
      );
    } else if (previous && !previous.compliant) {
      await publishEvent(
        'compliance.audit_remediated',
        state.orgId,
        {
          baselineId: baseline.id,
          deviceId: state.deviceId,
          score: comparison.score,
        },
        'audit-baseline-evaluator'
      );
    }
  } catch (err) {
    console.error(`[auditBaseline] publishEvent failed for device ${state.deviceId}, baseline ${baseline.id}:`, err);
  }

  return result;
}

export async function evaluateLatestAuditPolicyForDevice(deviceId: string): Promise<typeof auditBaselineResults.$inferSelect | null> {
  const [state] = await db
    .select()
    .from(auditPolicyStates)
    .where(eq(auditPolicyStates.deviceId, deviceId))
    .orderBy(desc(auditPolicyStates.collectedAt))
    .limit(1);

  if (!state) {
    return null;
  }

  const [baseline] = await db
    .select()
    .from(auditBaselines)
    .where(and(
      eq(auditBaselines.orgId, state.orgId),
      eq(auditBaselines.osType, state.osType),
      eq(auditBaselines.isActive, true),
    ))
    .orderBy(desc(auditBaselines.updatedAt), desc(auditBaselines.createdAt))
    .limit(1);

  if (!baseline) {
    return null;
  }

  return evaluatePolicyStateAgainstBaseline(state, baseline);
}

export async function evaluateAuditBaselineDrift(options: { orgId?: string } = {}): Promise<{
  evaluated: number;
  compliant: number;
  nonCompliant: number;
}> {
  const latestStateTimestamps = db
    .select({
      deviceId: auditPolicyStates.deviceId,
      latestCollectedAt: sql<Date>`max(${auditPolicyStates.collectedAt})`.as('latest_collected_at'),
    })
    .from(auditPolicyStates)
    .where(options.orgId ? eq(auditPolicyStates.orgId, options.orgId) : undefined)
    .groupBy(auditPolicyStates.deviceId)
    .as('latest_audit_policy_states');

  const latestStatesRows = await db
    .select({ state: auditPolicyStates })
    .from(auditPolicyStates)
    .innerJoin(latestStateTimestamps, and(
      eq(auditPolicyStates.deviceId, latestStateTimestamps.deviceId),
      eq(auditPolicyStates.collectedAt, latestStateTimestamps.latestCollectedAt),
    ));

  const latestStates = latestStatesRows.map((row) => row.state);

  const activeBaselines = options.orgId
    ? await db
      .select()
      .from(auditBaselines)
      .where(and(eq(auditBaselines.orgId, options.orgId), eq(auditBaselines.isActive, true)))
      .orderBy(desc(auditBaselines.updatedAt), desc(auditBaselines.createdAt))
    : await db
      .select()
      .from(auditBaselines)
      .where(eq(auditBaselines.isActive, true))
      .orderBy(desc(auditBaselines.updatedAt), desc(auditBaselines.createdAt));

  const baselineByOrgOs = new Map<string, typeof auditBaselines.$inferSelect>();
  for (const baseline of activeBaselines) {
    const key = `${baseline.orgId}:${baseline.osType}`;
    if (!baselineByOrgOs.has(key)) {
      baselineByOrgOs.set(key, baseline);
    }
  }

  let evaluated = 0;
  let compliant = 0;
  let nonCompliant = 0;

  for (const state of latestStates) {
    const baseline = baselineByOrgOs.get(`${state.orgId}:${state.osType}`);
    if (!baseline) continue;

    const result = await evaluatePolicyStateAgainstBaseline(state, baseline);
    evaluated++;
    if (result.compliant) {
      compliant++;
    } else {
      nonCompliant++;
    }
  }

  return {
    evaluated,
    compliant,
    nonCompliant,
  };
}

export async function processCollectedAuditPolicyCommandResult(
  deviceId: string,
  stdout?: string
): Promise<{
  state: typeof auditPolicyStates.$inferSelect;
  evaluation: typeof auditBaselineResults.$inferSelect | null;
} | null> {
  if (!stdout) {
    console.warn(`[auditBaseline] processCollectedAuditPolicyCommandResult: no stdout for device ${deviceId}`);
    return null;
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(stdout);
  } catch (err) {
    console.error(`[auditBaseline] processCollectedAuditPolicyCommandResult: JSON parse error for device ${deviceId}:`, err);
    return null;
  }

  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    console.warn(`[auditBaseline] processCollectedAuditPolicyCommandResult: unexpected shape (${typeof parsed}) for device ${deviceId}`);
    return null;
  }

  const payload = parsed as CollectAuditPolicyPayload;
  const state = await insertAuditPolicyState(deviceId, payload);
  const evaluation = await evaluateLatestAuditPolicyForDevice(deviceId);

  return { state, evaluation };
}
