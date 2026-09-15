import { describe, expect, it } from 'vitest';
import {
  PATCH_CHASE_MAX_ATTEMPTS, PATCH_FAILURE_CLASSES, PATCH_PLAN_ITEM_CLASSES, PATCH_PLAN_REFUSAL_REASONS, PATCH_REBOOT_UNPLANNABLE_REASONS,
} from '../types/aiPatchPlan';
import {
  PatchPlanReferenceError, isPatchWindowId, parsePatchWindowId, patchPlanOutcomeFromSubmission, patchPlanSubmissionSchema, triggerPatchPlanRunSchema,
} from './aiPatchPlan';

const DEV = '11111111-1111-4111-8111-111111111111';
const WIN = '22222222-2222-4222-8222-222222222222';
// W04: a resolved window id carries its occurrence start.
const WIN_ID = `${WIN}@2026-09-16T02:00:00.000Z`;
const base = {
  summary: 'Fleet is 82% compliant; 14 devices hold critical updates.',
  posture: { compliancePct: 82, devicesAtRisk: 14, oldestOutstandingDays: 63 },
  items: [] as unknown[],
};
const item = (over: Record<string, unknown>) => ({ severity: 'high', title: 't', detail: 'd', evidenceRef: 'e', ...over });

describe('patchPlanSubmissionSchema', () => {
  it('closes the item class union', () => {
    expect([...PATCH_PLAN_ITEM_CLASSES]).toEqual([
      'install', 'approval_advisory', 'reboot_plan', 'chase', 'escalation',
    ]);
    const bad = { ...base, items: [item({ class: 'reboot_now', deviceId: DEV })] };
    expect(patchPlanSubmissionSchema.safeParse(bad).success).toBe(false);
  });

  it('requires a deviceId on install, chase and reboot_plan and forbids one on approval_advisory', () => {
    expect(patchPlanSubmissionSchema.safeParse({ ...base, items: [item({ class: 'install', deviceId: null, patchIds: ['p'] })] }).success).toBe(false);
    expect(patchPlanSubmissionSchema.safeParse({ ...base, items: [item({ class: 'chase', patchIds: ['p'], jobResultIds: [DEV] })] }).success).toBe(false);
    expect(patchPlanSubmissionSchema.safeParse({ ...base, items: [item({ class: 'reboot_plan', windowId: WIN })] }).success).toBe(false);
    expect(patchPlanSubmissionSchema.safeParse({ ...base, items: [item({ class: 'approval_advisory', deviceId: DEV, patchIds: [DEV] })] }).success).toBe(false);
    expect(patchPlanSubmissionSchema.safeParse({ ...base, items: [item({ class: 'approval_advisory', patchIds: [DEV] })] }).success).toBe(true);
  });

  it('rejects an install with no patchIds and caps the list', () => {
    expect(patchPlanSubmissionSchema.safeParse({ ...base, items: [item({ class: 'install', deviceId: DEV, patchIds: [] })] }).success).toBe(false);
    expect(patchPlanSubmissionSchema.safeParse({ ...base, items: [item({ class: 'install', deviceId: DEV, patchIds: Array.from({ length: 51 }, () => DEV) })] }).success).toBe(false);
    expect(patchPlanSubmissionSchema.safeParse({ ...base, items: [item({ class: 'install', deviceId: DEV, patchIds: [DEV] })] }).success).toBe(true);
  });

  it('forbids the fields a class does not carry', () => {
    expect(patchPlanSubmissionSchema.safeParse({ ...base, items: [item({ class: 'install', deviceId: DEV, patchIds: [DEV], windowId: WIN })] }).success).toBe(false);
    expect(patchPlanSubmissionSchema.safeParse({ ...base, items: [item({ class: 'install', deviceId: DEV, patchIds: [DEV], jobResultIds: [DEV] })] }).success).toBe(false);
    expect(patchPlanSubmissionSchema.safeParse({ ...base, items: [item({ class: 'reboot_plan', deviceId: DEV, windowId: WIN, patchIds: [DEV] })] }).success).toBe(false);
    expect(patchPlanSubmissionSchema.safeParse({ ...base, items: [item({ class: 'escalation', windowId: WIN })] }).success).toBe(false);
    expect(patchPlanSubmissionSchema.safeParse({ ...base, items: [item({ class: 'reboot_plan', deviceId: DEV, windowId: WIN_ID })] }).success).toBe(true);
    expect(patchPlanSubmissionSchema.safeParse({ ...base, items: [item({ class: 'chase', deviceId: DEV, patchIds: [DEV], jobResultIds: [DEV] })] }).success).toBe(true);
  });

  it('rejects unknown keys and a multi-line or over-long title', () => {
    expect(patchPlanSubmissionSchema.safeParse({ ...base, extra: 1 }).success).toBe(false);
    expect(patchPlanSubmissionSchema.safeParse({ ...base, items: [item({ class: 'escalation', title: 'a\nb' })] }).success).toBe(false);
    expect(patchPlanSubmissionSchema.safeParse({ ...base, items: [item({ class: 'escalation', title: 'x'.repeat(121) })] }).success).toBe(false);
  });

  it('bounds posture to real percentages and caps the plan', () => {
    expect(patchPlanSubmissionSchema.safeParse({ ...base, posture: { ...base.posture, compliancePct: 101 } }).success).toBe(false);
    expect(patchPlanSubmissionSchema.safeParse({ ...base, posture: { ...base.posture, devicesAtRisk: -1 } }).success).toBe(false);
    const esc = item({ class: 'escalation', severity: 'low', deviceId: DEV });
    expect(patchPlanSubmissionSchema.safeParse({ ...base, items: Array.from({ length: 100 }, () => esc) }).success).toBe(true);
    expect(patchPlanSubmissionSchema.safeParse({ ...base, items: Array.from({ length: 101 }, () => esc) }).success).toBe(false);
  });

  // W03 (#5749): a chase/escalation item may CITE the class and attempt count
  // the evidence computed. The persister refuses a citation that disagrees
  // with the evidence; the schema only closes the vocabulary and the range.
  it('accepts failureClass and attemptCount on chase and escalation items only', () => {
    const chase = item({ class: 'chase', deviceId: DEV, patchIds: [DEV], jobResultIds: [DEV] });
    expect(patchPlanSubmissionSchema.safeParse({ ...base, items: [item({ ...chase, failureClass: 'transient', attemptCount: 1 })] }).success).toBe(true);
    expect(patchPlanSubmissionSchema.safeParse({ ...base, items: [item({ class: 'escalation', deviceId: DEV, failureClass: 'permanent', attemptCount: 3 })] }).success).toBe(true);
    expect(patchPlanSubmissionSchema.safeParse({ ...base, items: [item({ class: 'install', deviceId: DEV, patchIds: [DEV], failureClass: 'transient' })] }).success).toBe(false);
    expect(patchPlanSubmissionSchema.safeParse({ ...base, items: [item({ class: 'approval_advisory', patchIds: [DEV], attemptCount: 1 })] }).success).toBe(false);
  });

  it('closes the failure class vocabulary and bounds attemptCount to a positive integer', () => {
    expect([...PATCH_FAILURE_CLASSES]).toEqual(['transient', 'needs_reboot', 'disk_space', 'store_corrupt', 'permanent', 'unknown']);
    const chase = item({ class: 'chase', deviceId: DEV, patchIds: [DEV], jobResultIds: [DEV] });
    expect(patchPlanSubmissionSchema.safeParse({ ...base, items: [item({ ...chase, failureClass: 'flaky' })] }).success).toBe(false);
    expect(patchPlanSubmissionSchema.safeParse({ ...base, items: [item({ ...chase, attemptCount: 0 })] }).success).toBe(false);
    expect(patchPlanSubmissionSchema.safeParse({ ...base, items: [item({ ...chase, attemptCount: 1.5 })] }).success).toBe(false);
    expect(PATCH_CHASE_MAX_ATTEMPTS).toBe(2);
  });

  it('accepts a minimal well-formed plan and a null oldestOutstandingDays', () => {
    expect(patchPlanSubmissionSchema.safeParse(base).success).toBe(true);
    expect(patchPlanSubmissionSchema.safeParse({ ...base, posture: { ...base.posture, oldestOutstandingDays: null } }).success).toBe(true);
  });
});

// AI patch agent W04 (#5750) — a resolved window id is `<uuid>@<ISO start>`,
// never a bare uuid (a maintenance settings row recurs; the occurrence is
// part of the identity).
describe('windowId grammar (W04)', () => {
  it('accepts <uuid>@<ISO start> and parses it', () => {
    expect(patchPlanSubmissionSchema.safeParse({ ...base, items: [item({ class: 'reboot_plan', deviceId: DEV, windowId: WIN_ID })] }).success).toBe(true);
    expect(parsePatchWindowId(WIN_ID)).toEqual({ sourceId: WIN, startsAt: new Date('2026-09-16T02:00:00.000Z') });
    expect(isPatchWindowId(WIN_ID)).toBe(true);
  });
  it('rejects a bare uuid, a non-ISO start and free text', () => {
    for (const bad of [WIN, `${WIN}@tomorrow`, 'next window', `${WIN}@2026-09-16T02:00:00.000Z@x`]) {
      expect(patchPlanSubmissionSchema.safeParse({ ...base, items: [item({ class: 'reboot_plan', deviceId: DEV, windowId: bad })] }).success).toBe(false);
      expect(parsePatchWindowId(bad)).toBeNull();
    }
  });
  it('closes the reboot refusal and unplannable reason unions', () => {
    for (const r of ['reboot_policy_not_window_gated', 'redundancy_unknown', 'redundancy_collision']) {
      expect(PATCH_PLAN_REFUSAL_REASONS).toContain(r);
    }
    expect([...PATCH_REBOOT_UNPLANNABLE_REASONS]).toEqual(['no_window_in_horizon', 'reboot_policy_not_window_gated', 'redundancy_unknown']);
  });
});

describe('patchPlanOutcomeFromSubmission (the in-tool referential gate)', () => {
  const P1 = '33333333-3333-4333-8333-333333333333';
  const P9 = '44444444-4444-4444-8444-444444444444';
  const OTHER = '55555555-5555-4555-8555-555555555555';
  const refs = {
    deviceIds: new Set([DEV]),
    patchIdsByDevice: new Map([[DEV, new Set([P1])]]),
    windowIds: new Set<string>(),
    jobResultIds: new Set<string>(),
  };
  const meta = { evidenceTruncated: true, generatedAt: '2026-09-14T02:00:00.000Z' };
  const plan = (items: unknown[]) => patchPlanSubmissionSchema.parse({ ...base, items });

  it('throws on a device absent from the evidence, naming the path', () => {
    expect(() => patchPlanOutcomeFromSubmission(plan([item({ class: 'install', deviceId: OTHER, patchIds: [P1] })]), refs, meta))
      .toThrow(PatchPlanReferenceError);
    expect(() => patchPlanOutcomeFromSubmission(plan([item({ class: 'install', deviceId: OTHER, patchIds: [P1] })]), refs, meta))
      .toThrow(/items\[0\]\.deviceId/);
  });

  it('throws on a patch not outstanding on that device, and on an advisory patch absent from all evidence', () => {
    expect(() => patchPlanOutcomeFromSubmission(plan([item({ class: 'install', deviceId: DEV, patchIds: [P9] })]), refs, meta))
      .toThrow(/items\[0\]\.patchIds\[0\]/);
    expect(() => patchPlanOutcomeFromSubmission(plan([item({ class: 'approval_advisory', patchIds: [P9] })]), refs, meta))
      .toThrow(PatchPlanReferenceError);
  });

  it('does NOT throw on an unresolved window or job result — the persister refuses those with a disposition', () => {
    const out = patchPlanOutcomeFromSubmission(plan([
      item({ class: 'reboot_plan', deviceId: DEV, windowId: WIN_ID }),
      item({ class: 'chase', deviceId: DEV, patchIds: [P1], jobResultIds: [OTHER] }),
    ]), refs, meta);
    expect(out.items).toHaveLength(2);
  });

  it('maps a valid plan to the stored outcome shape', () => {
    const out = patchPlanOutcomeFromSubmission(plan([item({ class: 'install', deviceId: DEV, patchIds: [P1] })]), refs, meta);
    expect(out).toMatchObject({ schemaVersion: 1, dispositions: [], evidenceTruncated: true, generatedAt: meta.generatedAt });
    expect(out.items[0]).toMatchObject({ class: 'install', deviceId: DEV, patchIds: [P1] });
  });
});

describe('triggerPatchPlanRunSchema', () => {
  it('takes exactly an orgId', () => {
    expect(triggerPatchPlanRunSchema.safeParse({ orgId: DEV }).success).toBe(true);
    expect(triggerPatchPlanRunSchema.safeParse({ orgId: 'nope' }).success).toBe(false);
    expect(triggerPatchPlanRunSchema.safeParse({ orgId: DEV, deviceId: DEV }).success).toBe(false);
  });
});
