/**
 * #8598 — server-side validation of an automation's `conditions` when it is a
 * target config (`DeploymentTargetConfig`). `routes/automations.ts` accepts
 * `conditions: z.unknown()`, so before this an empty `groupIds`, a cross-org
 * id or a typo'd `type` all persisted. A typo is the dangerous one: the runtime
 * (`isDeploymentTargetConfig`) does not recognise the object and falls through
 * to "every device in the owner org".
 *
 * Passes untouched (no DB read): `undefined`, `null`, a legacy condition array,
 * and an empty object `{}` — all of which the runtime already treats as "no
 * target config", and none of which carry an id to check.
 *
 * Partner-wide automations (orgId NULL) may not use `groups` or `devices`: a
 * group or device id lives in exactly one org, so such a target would silently
 * match one org of the many the automation fans out to. `all` and `filter`
 * fan out per org and stay allowed.
 *
 * Runs in the caller's DB context. A missing id and an id in another org get
 * the same message, so the response does not reveal whether it exists.
 */
import { inArray } from 'drizzle-orm';
import { automationTargetConfigSchema } from '@breeze/shared';
import { db } from '../db';
import { deviceGroups, devices } from '../db/schema';

export type AutomationTargetValidationResult =
  | { ok: true }
  | { ok: false; error: string; code: 'INVALID_TARGET'; groupIds?: string[]; deviceIds?: string[] };

export const PARTNER_WIDE_ID_TARGET_ERROR =
  'Partner-wide automations cannot target specific device groups or devices, because each group or device belongs to a single organization. Use "all devices" or a filter target instead.';

function invalid(error: string, extra: { groupIds?: string[]; deviceIds?: string[] } = {}): AutomationTargetValidationResult {
  return { ok: false, error, code: 'INVALID_TARGET', ...extra };
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function idsOutsideOwnerOrg(requested: string[], rows: { id: string; orgId: string }[], ownerOrgId: string): string[] {
  const orgById = new Map(rows.map((row) => [row.id, row.orgId]));
  return [...new Set(requested)].filter((id) => orgById.get(id) !== ownerOrgId);
}

export async function validateAutomationTargetConditions(input: {
  owner: { orgId: string | null; partnerId: string | null };
  conditions: unknown;
}): Promise<AutomationTargetValidationResult> {
  const { owner, conditions } = input;

  if (conditions === undefined || conditions === null || Array.isArray(conditions)) return { ok: true };
  if (!isPlainObject(conditions)) {
    return invalid('Automation conditions must be a target configuration object or a condition list');
  }
  if (Object.keys(conditions).length === 0) return { ok: true };

  const parsed = automationTargetConfigSchema.safeParse(conditions);
  if (!parsed.success) {
    const issue = parsed.error.issues[0];
    const where = issue?.path.length ? `${issue.path.join('.')}: ` : '';
    return invalid(`Invalid automation target: ${where}${issue?.message ?? 'unrecognised target configuration'}`);
  }
  const target = parsed.data;

  if (target.type !== 'groups' && target.type !== 'devices') return { ok: true };

  if (!owner.orgId) return invalid(PARTNER_WIDE_ID_TARGET_ERROR);

  if (target.type === 'groups') {
    const requested = target.groupIds ?? [];
    const rows = await db
      .select({ id: deviceGroups.id, orgId: deviceGroups.orgId })
      .from(deviceGroups)
      .where(inArray(deviceGroups.id, requested));
    const bad = idsOutsideOwnerOrg(requested, rows, owner.orgId);
    if (bad.length > 0) {
      return invalid(`Device group(s) not found in this automation's organization: ${bad.join(', ')}`, { groupIds: bad });
    }
    return { ok: true };
  }

  const requested = target.deviceIds ?? [];
  const rows = await db
    .select({ id: devices.id, orgId: devices.orgId })
    .from(devices)
    .where(inArray(devices.id, requested));
  const bad = idsOutsideOwnerOrg(requested, rows, owner.orgId);
  if (bad.length > 0) {
    return invalid(`Device(s) not found in this automation's organization: ${bad.join(', ')}`, { deviceIds: bad });
  }
  return { ok: true };
}
