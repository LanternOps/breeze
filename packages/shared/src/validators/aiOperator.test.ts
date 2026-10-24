import { describe, expect, it } from 'vitest';
import { taskCheckpointSchema, TASK_CHECKPOINT_VERSION } from './aiOperator';
import * as checkpointArms from './aiOperator';

const DEVICE = '00000000-0000-4000-8000-000000000001';

const baseInput = {
  version: TASK_CHECKPOINT_VERSION,
  recipeInput: { deviceId: DEVICE, serviceName: 'spooler', triggeringAlertId: null },
  criterion: {
    adapter: 'service_running',
    adapterVersion: 1,
    deviceId: DEVICE,
    serviceName: 'spooler',
    alertId: null,
  },
};

describe('taskCheckpointSchema (Recipe Library wave E3)', () => {
  it('carries the wait fields E3 added, and rejects a non-ISO waitUntil', () => {
    const base = taskCheckpointSchema.parse(baseInput);
    expect(base.waitUntil).toBeUndefined();
    expect(base.resumeStepKey).toBeUndefined();

    const withWait = taskCheckpointSchema.parse({
      ...base,
      waitUntil: '2026-10-19T17:00:00.000Z',
      resumeStepKey: 'discover',
    });
    expect(withWait.waitUntil).toBe('2026-10-19T17:00:00.000Z');
    expect(withWait.resumeStepKey).toBe('discover');

    expect(() => taskCheckpointSchema.parse({ ...base, waitUntil: 'friday' })).toThrow();
    expect(() => taskCheckpointSchema.parse({ ...base, resumeStepKey: '' })).toThrow();
  });
});

// ---- R1a-0 Task 1b: per-recipe checkpoint arms (plan Amendment A.4 decision 4) ----

const ALERT = '00000000-0000-4000-8000-0000000000e1';
/** The exact object `admitServiceRecoveryTask` builds (taskService.ts:175-186). */
const admissionShaped = {
  version: TASK_CHECKPOINT_VERSION,
  recipeInput: { deviceId: DEVICE, serviceName: 'Spooler', triggeringAlertId: ALERT, maxRestartAttempts: 1 },
  criterion: {
    adapter: 'service_running', adapterVersion: 1, deviceId: DEVICE, serviceName: 'Spooler',
    freshnessSeconds: 120, alertId: ALERT, resolvableWithoutAlert: false,
  },
  findings: [], satisfiedCriteria: [], unsatisfiedCriteria: ['service_running'],
  mutationAttempts: 0, lastVerification: null, lastOperationKey: null, fixWatchId: null,
};

describe('checkpoint arms (R1a-0 Task 1b)', () => {
  // Read through the namespace so a missing export is a failing assertion,
  // not a module-load error that hides every other case.
  const ns = checkpointArms as unknown as Record<string, any>;

  it('exports the base schema, the service-recovery arm, the snapshot ref and the arm guard', () => {
    expect(ns.taskCheckpointBaseSchema).toBeDefined();
    expect(ns.serviceRecoveryCheckpointSchema).toBeDefined();
    expect(ns.planningSnapshotRefSchema).toBeDefined();
    expect(typeof ns.isServiceRecoveryCheckpoint).toBe('function');
  });

  it('(a) the admission-shaped object parses through the union and is the service-recovery arm', () => {
    const parsed = taskCheckpointSchema.parse(admissionShaped);
    expect(ns.isServiceRecoveryCheckpoint(parsed)).toBe(true);
    expect(ns.serviceRecoveryCheckpointSchema.parse(admissionShaped)).toEqual(parsed);
  });

  it('(b) the service-recovery arm refuses a checkpoint with no criterion', () => {
    const { criterion: _c, ...noCriterion } = admissionShaped;
    expect(ns.serviceRecoveryCheckpointSchema.safeParse(noCriterion).success).toBe(false);
    expect(taskCheckpointSchema.safeParse(noCriterion).success).toBe(false);
  });

  it('(c) a planningSnapshot digest of 63 hex chars is refused; 64 lowercase hex is accepted', () => {
    const stepId = '00000000-0000-4000-8000-0000000000f1';
    const withRef = (ref: unknown) => taskCheckpointSchema.safeParse({ ...admissionShaped, planningSnapshot: ref }).success;
    expect(withRef({ stepId, digest: 'a'.repeat(63) })).toBe(false);
    expect(withRef({ stepId, digest: 'a'.repeat(64) })).toBe(true);
    expect(withRef({ stepId, digest: 'A'.repeat(64) })).toBe(false);
    expect(withRef({ stepId: 'nope', digest: 'a'.repeat(64) })).toBe(false);
    expect(withRef({ stepId, digest: 'a'.repeat(64), extra: 1 })).toBe(false);
  });

  it('(d) a parsed service-recovery checkpoint has NO planningSnapshot and NO dispatchNotBefore key', () => {
    const parsed = taskCheckpointSchema.parse(admissionShaped);
    expect(Object.hasOwn(parsed, 'planningSnapshot')).toBe(false);
    expect(Object.hasOwn(parsed, 'dispatchNotBefore')).toBe(false);
  });

  it('dispatchNotBefore must be ISO-8601', () => {
    expect(taskCheckpointSchema.safeParse({ ...admissionShaped, dispatchNotBefore: 'friday' }).success).toBe(false);
    expect(taskCheckpointSchema.parse({ ...admissionShaped, dispatchNotBefore: '2026-10-23T17:00:00.000Z' }))
      .toMatchObject({ dispatchNotBefore: '2026-10-23T17:00:00.000Z' });
  });

  it('the base schema carries neither version, recipeInput nor criterion, and does carry both new fields', () => {
    const keys = Object.keys(ns.taskCheckpointBaseSchema.shape);
    expect(keys).not.toContain('version');
    expect(keys).not.toContain('recipeInput');
    expect(keys).not.toContain('criterion');
    expect(keys).toEqual(expect.arrayContaining(['planningSnapshot', 'dispatchNotBefore']));
  });

  it("the service-recovery arm keeps today's key order: version, recipeInput, criterion first; new fields last", () => {
    const keys = Object.keys(ns.serviceRecoveryCheckpointSchema.shape);
    expect(keys.slice(0, 3)).toEqual(['version', 'recipeInput', 'criterion']);
    expect(keys.slice(-2)).toEqual(['planningSnapshot', 'dispatchNotBefore']);
  });
});

// ---- R1a Task 2: the identity_offboarding arm and the generalized create-task schema ----

describe('checkpoint arms (R1a Task 2): identity_offboarding', () => {
  const ns = checkpointArms as unknown as Record<string, any>;
  const CONTACT = '00000000-0000-4000-8000-000000000002';
  // Amended 2026-10-18: the shipped schema requires `version: 1` and, for the
  // service-recovery arm, `criterion`.
  const SR_CRITERION = {
    adapter: 'service_running', adapterVersion: 1,
    deviceId: DEVICE, serviceName: 'spooler', alertId: null,
  };

  it('taskCheckpointSchema still parses a service_recovery checkpoint to the SR arm', () => {
    const c = taskCheckpointSchema.parse({
      version: 1,
      recipeInput: { deviceId: DEVICE, serviceName: 'spooler', triggeringAlertId: null },
      criterion: SR_CRITERION,
    });
    expect(ns.isServiceRecoveryCheckpoint(c)).toBe(true);
    expect(ns.isIdentityOffboardingCheckpoint(c)).toBe(false);
    expect(Object.hasOwn(c, 'manualWorkCursor')).toBe(false);
    expect(Object.hasOwn(c, 'planningSnapshot')).toBe(false);
  });

  it('the admission-shaped SR object re-serializes to the same bytes through the two-arm union', () => {
    expect(JSON.stringify(taskCheckpointSchema.parse(admissionShaped)))
      .toBe(JSON.stringify(ns.serviceRecoveryCheckpointSchema.parse(admissionShaped)));
  });

  it('taskCheckpointSchema parses an identity_offboarding checkpoint to the identity arm', () => {
    const c = taskCheckpointSchema.parse({ version: 1, recipeInput: { contactId: CONTACT } });
    expect(ns.isIdentityOffboardingCheckpoint(c)).toBe(true);
    expect(ns.isServiceRecoveryCheckpoint(c)).toBe(false);
    expect((c as any).manualWorkCursor).toBe(0);
    expect(Object.hasOwn(c, 'criterion')).toBe(false);
    expect((c as any).recipeInput.effects.disableAccount).toBe(true);
  });

  it('refuses an identity checkpoint that carries a criterion, and an SR one without', () => {
    expect(() => taskCheckpointSchema.parse({
      version: 1, recipeInput: { contactId: CONTACT }, criterion: SR_CRITERION,
    })).toThrow();
    expect(() => taskCheckpointSchema.parse({
      version: 1, recipeInput: { deviceId: DEVICE, serviceName: 'spooler', triggeringAlertId: null },
    })).toThrow();
  });

  it('the identity arm requires version 1 and bounds manualWorkCursor', () => {
    expect(() => taskCheckpointSchema.parse({ recipeInput: { contactId: CONTACT } })).toThrow();
    expect(() => taskCheckpointSchema.parse({ version: 1, recipeInput: { contactId: CONTACT }, manualWorkCursor: 65 })).toThrow();
    expect(() => taskCheckpointSchema.parse({ version: 1, recipeInput: { contactId: CONTACT }, manualWorkCursor: -1 })).toThrow();
  });

  it('the identity arm is strict: an unknown key is refused', () => {
    expect(() => taskCheckpointSchema.parse({ version: 1, recipeInput: { contactId: CONTACT }, effectCursor: 0 })).toThrow();
  });
});

describe('createOperatorTaskSchema and operatorTaskDraftSchema (R1a Task 2)', () => {
  const ns = checkpointArms as unknown as Record<string, any>;
  const ORG = '00000000-0000-4000-8000-00000000000a';

  it('createOperatorTaskSchema still accepts the shipped service_recovery body', () => {
    expect(() => ns.createOperatorTaskSchema.parse({
      mode: 'live', recipeKey: 'service_recovery', recipeVersion: 1, orgId: ORG,
      deviceId: '00000000-0000-4000-8000-00000000000b',
      inputs: { serviceName: 'spooler' },
      clientIdempotencyKey: 'abcdefgh-1',
    })).not.toThrow();
  });

  it('createOperatorTaskSchema accepts a device-less body and STILL rejects an unknown top-level field', () => {
    expect(() => ns.createOperatorTaskSchema.parse({
      mode: 'live', recipeKey: 'identity_offboarding', recipeVersion: 1, orgId: ORG,
      inputs: { contactId: '00000000-0000-4000-8000-00000000000c' },
      clientIdempotencyKey: 'abcdefgh-2',
    })).not.toThrow();
    expect(() => ns.createOperatorTaskSchema.parse({
      mode: 'live', recipeKey: 'identity_offboarding', recipeVersion: 1, orgId: ORG, inputs: {},
      clientIdempotencyKey: 'abcdefgh-3', agentId: '00000000-0000-4000-8000-00000000000d',
    })).toThrow();
  });

  it('operatorTaskDraftSchema takes no mode and no idempotency key, and is strict', () => {
    const body = { recipeKey: 'identity_offboarding', recipeVersion: 1, orgId: ORG, inputs: { personHint: 'Dana' } };
    expect(ns.operatorTaskDraftSchema.parse(body)).toEqual(body);
    expect(() => ns.operatorTaskDraftSchema.parse({ ...body, mode: 'live' })).toThrow();
    expect(() => ns.operatorTaskDraftSchema.parse({ ...body, clientIdempotencyKey: 'abcdefgh-4' })).toThrow();
  });
});
