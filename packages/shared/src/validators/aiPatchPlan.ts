import { z } from 'zod';
import { AI_SWEEP_SEVERITIES } from '../types/aiAgentSchedules';
import {
  PATCH_PLAN_DETAIL_MAX_CHARS, PATCH_PLAN_EVIDENCE_REF_MAX_CHARS, PATCH_PLAN_ITEM_CLASSES,
  PATCH_PLAN_MAX_ITEMS, PATCH_PLAN_MAX_JOB_RESULT_IDS_PER_ITEM, PATCH_PLAN_MAX_PATCH_IDS_PER_ITEM,
  PATCH_PLAN_SCHEMA_VERSION, PATCH_PLAN_SUMMARY_MAX_CHARS, PATCH_PLAN_TITLE_MAX_CHARS,
  type PatchPlanItem, type PatchPlanItemClass, type PatchPlanOutcome, type PatchPlanOutcomeRefs,
  type PatchPlanSubmission,
} from '../types/aiPatchPlan';

const uuid = z.string().uuid();
// Strip every Unicode control/format char except the newline a multi-line
// detail legitimately carries. Model output is rendered verbatim on the run
// trace and in the digest.
const CONTROL_EXCEPT_NEWLINE = /[^\P{C}\n]/gu;
const text = (max: number) => z.string().trim().min(1).max(max)
  .transform((s) => s.replace(CONTROL_EXCEPT_NEWLINE, ''));

/**
 * AI patch agent (W01) — `POST /ai/patch-plan/runs`'s body. `.strict()` so a
 * caller sending `deviceId` (this profile is device-less by construction)
 * 400s instead of being silently ignored.
 */
export const triggerPatchPlanRunSchema = z.object({
  orgId: uuid,
}).strict();

type FieldRule = 'required' | 'optional' | 'forbidden';
interface ClassRules { deviceId: FieldRule; patchIds: FieldRule; jobResultIds: FieldRule; windowId: FieldRule }

/**
 * Per-class field contract. `Record<PatchPlanItemClass, …>` is the
 * exhaustiveness guard: a sixth class does not compile without a row here.
 * `approval_advisory` forbids `deviceId` because `patch_approvals` is
 * partner/ring-scoped, never device-scoped (OD-3 A).
 */
export const PATCH_PLAN_CLASS_RULES: Readonly<Record<PatchPlanItemClass, ClassRules>> = Object.freeze({
  install: { deviceId: 'required', patchIds: 'required', jobResultIds: 'forbidden', windowId: 'forbidden' },
  chase: { deviceId: 'required', patchIds: 'required', jobResultIds: 'required', windowId: 'forbidden' },
  reboot_plan: { deviceId: 'required', patchIds: 'forbidden', jobResultIds: 'forbidden', windowId: 'required' },
  approval_advisory: { deviceId: 'forbidden', patchIds: 'required', jobResultIds: 'forbidden', windowId: 'forbidden' },
  escalation: { deviceId: 'optional', patchIds: 'optional', jobResultIds: 'optional', windowId: 'forbidden' },
});

function present(v: unknown): boolean {
  if (v === undefined || v === null) return false;
  return !Array.isArray(v) || v.length > 0;
}

const patchPlanItemSchema = z.object({
  class: z.enum(PATCH_PLAN_ITEM_CLASSES),
  severity: z.enum(AI_SWEEP_SEVERITIES),
  deviceId: uuid.nullable().optional(),
  patchIds: z.array(uuid).max(PATCH_PLAN_MAX_PATCH_IDS_PER_ITEM).optional(),
  jobResultIds: z.array(uuid).max(PATCH_PLAN_MAX_JOB_RESULT_IDS_PER_ITEM).optional(),
  windowId: uuid.nullable().optional(),
  title: z.string().trim().min(1).max(PATCH_PLAN_TITLE_MAX_CHARS)
    .refine((s) => !/[\r\n]/.test(s), { message: 'title must be a single line' })
    .transform((s) => s.replace(/\p{C}/gu, '')),
  detail: text(PATCH_PLAN_DETAIL_MAX_CHARS),
  evidenceRef: z.string().trim().min(1).max(PATCH_PLAN_EVIDENCE_REF_MAX_CHARS),
}).strict().superRefine((item, ctx) => {
  const rules = PATCH_PLAN_CLASS_RULES[item.class];
  for (const field of ['deviceId', 'patchIds', 'jobResultIds', 'windowId'] as const) {
    const has = present(item[field]);
    if (rules[field] === 'required' && !has) {
      ctx.addIssue({ code: 'custom', path: [field], message: `a ${item.class} item requires ${field}` });
    } else if (rules[field] === 'forbidden' && has) {
      ctx.addIssue({ code: 'custom', path: [field], message: `a ${item.class} item must not carry ${field}` });
    }
  }
});

export const patchPlanSubmissionSchema = z.object({
  summary: text(PATCH_PLAN_SUMMARY_MAX_CHARS),
  posture: z.object({
    compliancePct: z.number().min(0).max(100),
    devicesAtRisk: z.number().int().min(0),
    oldestOutstandingDays: z.number().int().min(0).nullable(),
  }).strict(),
  items: z.array(patchPlanItemSchema).max(PATCH_PLAN_MAX_ITEMS),
}).strict();

/** Thrown by `patchPlanOutcomeFromSubmission` — its message names the offending path so the model can fix it within its turn budget. */
export class PatchPlanReferenceError extends Error {
  constructor(readonly path: string, reason: string) {
    super(`${path}: ${reason}`);
    this.name = 'PatchPlanReferenceError';
  }
}

/**
 * The pure mapper from a structurally valid submission to the stored outcome,
 * with the IN-TOOL referential gate (same split as
 * `fleetDesignOutcomeFromSubmission`). It throws on a device or patch the
 * model could have found in its own evidence, so the model retries within its
 * turn budget. It deliberately does NOT throw on `windowId` / `jobResultIds`:
 * W01 evidence resolves neither, so no retry could ever succeed — those are
 * refused by `persistPatchPlan` with a recorded disposition instead.
 */
export function patchPlanOutcomeFromSubmission(
  submission: PatchPlanSubmission,
  refs: PatchPlanOutcomeRefs,
  meta: { evidenceTruncated: boolean; generatedAt: string },
): PatchPlanOutcome {
  const allPatchIds = new Set<string>();
  for (const ids of refs.patchIdsByDevice.values()) for (const id of ids) allPatchIds.add(id);

  submission.items.forEach((item: PatchPlanItem, i) => {
    const deviceId = item.deviceId ?? null;
    if (deviceId !== null && !refs.deviceIds.has(deviceId)) {
      throw new PatchPlanReferenceError(`items[${i}].deviceId`, 'device id is not in this run\'s patch evidence');
    }
    const scope = deviceId !== null ? refs.patchIdsByDevice.get(deviceId) ?? new Set<string>() : allPatchIds;
    (item.patchIds ?? []).forEach((p, j) => {
      if (!scope.has(p)) {
        throw new PatchPlanReferenceError(
          `items[${i}].patchIds[${j}]`,
          deviceId !== null ? 'patch id is not outstanding on that device in the evidence' : 'patch id is not in this run\'s patch evidence',
        );
      }
    });
  });

  return {
    schemaVersion: PATCH_PLAN_SCHEMA_VERSION,
    summary: submission.summary,
    posture: submission.posture,
    items: submission.items,
    dispositions: [],
    evidenceTruncated: meta.evidenceTruncated,
    generatedAt: meta.generatedAt,
  };
}
