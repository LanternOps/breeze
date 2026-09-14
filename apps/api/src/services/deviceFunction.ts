import { and, eq, inArray } from 'drizzle-orm';
import { parseFunctionKey, type DeviceFunctionDto, type DeviceFunctionSource } from '@breeze/shared';
import { db } from '../db';
import { devices } from '../db/schema/devices';
import { deviceFunctionAssessments } from '../db/schema/deviceFunctionAssessments';

/**
 * Device function service (Fleet Designer W02, #5652).
 *
 * THE ONLY WRITER of `device_function_assessments` and of the projection
 * columns `devices.device_function` / `device_function_source`. Nothing else
 * may touch either — the projection is maintained here, in the same
 * transaction as the assessment row, never by a trigger.
 *
 * Every write follows the contacts parent-first pattern
 * (`services/contacts/crud.ts`): lock the device row `FOR UPDATE` in the
 * caller's org, which serialises competing writers per device and pins the
 * org the assessment will carry; then supersede the active row, insert the
 * new one, and rewrite the projection.
 *
 * Manual wins: a `manual` active row is never superseded by an `ai` row
 * (`kept_manual`); an `ai` row supersedes an older `ai` row; a manual write
 * supersedes anything; `clearDeviceFunction` supersedes whatever is active.
 *
 * `db` resolves to the request's ambient transaction inside a route
 * (`db/index.ts`), so `db.transaction` here is a savepoint when called from
 * the W03 apply route and a real transaction from a worker or test.
 */

export type DeviceFunctionErrorCode =
  | 'invalid_function_key'
  | 'label_required'
  | 'device_not_found';

export class DeviceFunctionError extends Error {
  constructor(public readonly code: DeviceFunctionErrorCode) {
    super(code);
    this.name = 'DeviceFunctionError';
  }
}

/** Bounds on the designer's evidence strings (display-only, never parsed). */
export const DEVICE_FUNCTION_EVIDENCE_MAX_ITEMS = 20;
export const DEVICE_FUNCTION_EVIDENCE_MAX_CHARS = 400;

type Executor = typeof db | Parameters<Parameters<typeof db.transaction>[0]>[0];

export interface UpsertDeviceFunctionInput {
  deviceId: string;
  orgId: string;
  functionKey: string;
  label?: string | null;
  source: DeviceFunctionSource;
  /** 0..1; ignored (stored NULL) for a manual row. */
  confidence?: number | null;
  evidence?: string[];
  runId?: string | null;
  reportRunId?: string | null;
  userId?: string | null;
}

export type UpsertDeviceFunctionResult =
  | { outcome: 'written'; assessmentId: string }
  | { outcome: 'kept_manual'; assessmentId: null };

export interface ClearDeviceFunctionInput {
  deviceId: string;
  orgId: string;
  userId?: string | null;
}

export interface ApplyDesignFunctionsInput {
  orgId: string;
  reportRunId: string | null;
  runId: string | null;
  userId: string | null;
  functions: Array<{
    functionKey: string;
    label?: string;
    deviceIds: string[];
    confidence: number;
    evidence: string[];
  }>;
}

export interface ApplyDesignFunctionsResult {
  written: number;
  keptManual: number;
  skippedForeign: number;
}

/**
 * Resolve the key + label pair every writer must agree on. Throws before any
 * statement runs so a bad key never opens a transaction.
 */
function resolveKeyAndLabel(functionKey: string, label: string | null | undefined): { functionKey: string; label: string | null } {
  const parsed = parseFunctionKey(functionKey);
  if (!parsed) throw new DeviceFunctionError('invalid_function_key');
  const trimmed = label?.trim() || null;
  if (parsed.kind === 'custom' && !trimmed) throw new DeviceFunctionError('label_required');
  return { functionKey, label: trimmed };
}

function boundEvidence(evidence: string[] | undefined): string[] {
  return (evidence ?? [])
    .filter((e): e is string => typeof e === 'string' && e.length > 0)
    .slice(0, DEVICE_FUNCTION_EVIDENCE_MAX_ITEMS)
    .map((e) => e.slice(0, DEVICE_FUNCTION_EVIDENCE_MAX_CHARS));
}

function formatConfidence(confidence: number | null | undefined): string | null {
  if (confidence == null || !Number.isFinite(confidence)) return null;
  return Math.min(1, Math.max(0, confidence)).toFixed(2);
}

/**
 * Parent-first lock: the device row in the caller's org, FOR UPDATE. Returns
 * null when the device is missing or lives in another org (RLS would already
 * hide it; the explicit predicate is belt-and-braces and pins the org the
 * assessment carries).
 */
async function lockDevice(tx: Executor, deviceId: string, orgId: string): Promise<{ id: string; orgId: string } | null> {
  const [device] = await tx
    .select({ id: devices.id, orgId: devices.orgId })
    .from(devices)
    .where(and(eq(devices.id, deviceId), eq(devices.orgId, orgId)))
    .limit(1)
    .for('update');
  return device ?? null;
}

async function readActive(tx: Executor, deviceId: string, orgId: string) {
  const [active] = await tx
    .select()
    .from(deviceFunctionAssessments)
    .where(and(
      eq(deviceFunctionAssessments.deviceId, deviceId),
      eq(deviceFunctionAssessments.orgId, orgId),
      eq(deviceFunctionAssessments.active, true),
    ))
    .limit(1);
  return active ?? null;
}

async function supersede(tx: Executor, assessmentId: string, orgId: string, now: Date): Promise<void> {
  await tx
    .update(deviceFunctionAssessments)
    .set({ active: false, supersededAt: now })
    .where(and(eq(deviceFunctionAssessments.id, assessmentId), eq(deviceFunctionAssessments.orgId, orgId)));
}

async function writeProjection(
  tx: Executor,
  deviceId: string,
  orgId: string,
  projection: { deviceFunction: string | null; deviceFunctionSource: DeviceFunctionSource | null },
  now: Date,
): Promise<void> {
  await tx
    .update(devices)
    .set({ ...projection, updatedAt: now })
    .where(and(eq(devices.id, deviceId), eq(devices.orgId, orgId)));
}

function runInTransaction<T>(exec: Executor | undefined, fn: (tx: Executor) => Promise<T>): Promise<T> {
  if (exec) return fn(exec);
  return db.transaction((tx) => fn(tx));
}

export async function upsertDeviceFunction(
  input: UpsertDeviceFunctionInput,
  exec?: Executor,
): Promise<UpsertDeviceFunctionResult> {
  const { functionKey, label } = resolveKeyAndLabel(input.functionKey, input.label);
  const evidence = input.source === 'manual' ? [] : boundEvidence(input.evidence);
  const confidence = input.source === 'manual' ? null : formatConfidence(input.confidence);

  return runInTransaction(exec, async (tx) => {
    const device = await lockDevice(tx, input.deviceId, input.orgId);
    if (!device) throw new DeviceFunctionError('device_not_found');

    const active = await readActive(tx, device.id, device.orgId);
    if (active && active.source === 'manual' && input.source === 'ai') {
      return { outcome: 'kept_manual', assessmentId: null };
    }

    const now = new Date();
    if (active) await supersede(tx, active.id, device.orgId, now);

    const [row] = await tx
      .insert(deviceFunctionAssessments)
      .values({
        orgId: device.orgId,
        deviceId: device.id,
        functionKey,
        label,
        confidence,
        evidence,
        source: input.source,
        runId: input.runId ?? null,
        reportRunId: input.reportRunId ?? null,
        createdByUserId: input.userId ?? null,
      })
      .returning({ id: deviceFunctionAssessments.id });

    await writeProjection(tx, device.id, device.orgId, { deviceFunction: functionKey, deviceFunctionSource: input.source }, now);
    return { outcome: 'written', assessmentId: row!.id };
  });
}

export async function clearDeviceFunction(
  input: ClearDeviceFunctionInput,
  exec?: Executor,
): Promise<{ outcome: 'cleared'; supersededAssessmentId: string | null }> {
  return runInTransaction(exec, async (tx) => {
    const device = await lockDevice(tx, input.deviceId, input.orgId);
    if (!device) throw new DeviceFunctionError('device_not_found');

    const active = await readActive(tx, device.id, device.orgId);
    const now = new Date();
    if (active) await supersede(tx, active.id, device.orgId, now);
    // Always normalise the projection — a drifted column must not survive a clear.
    await writeProjection(tx, device.id, device.orgId, { deviceFunction: null, deviceFunctionSource: null }, now);
    return { outcome: 'cleared', supersededAssessmentId: active?.id ?? null };
  });
}

export interface RestoreDeviceFunctionInput {
  deviceId: string;
  orgId: string;
  /** The assessment to make active again; null = leave the device with no function. */
  assessmentId: string | null;
  userId?: string | null;
}

/**
 * Rollback primitive (Fleet Designer W03): supersede whatever is active and
 * re-activate `assessmentId` (a row this device owned before the apply), or
 * clear the projection when the device had no function. Same parent-first
 * lock as every other writer; the re-activated row keeps its original
 * provenance (source, confidence, run) — nothing is rewritten on it except
 * `active` / `superseded_at`.
 */
export async function restoreDeviceFunction(
  input: RestoreDeviceFunctionInput,
  exec?: Executor,
): Promise<{ outcome: 'restored' | 'cleared'; supersededAssessmentId: string | null }> {
  return runInTransaction(exec, async (tx) => {
    const device = await lockDevice(tx, input.deviceId, input.orgId);
    if (!device) throw new DeviceFunctionError('device_not_found');

    const active = await readActive(tx, device.id, device.orgId);
    const now = new Date();
    if (active && active.id !== input.assessmentId) await supersede(tx, active.id, device.orgId, now);

    if (input.assessmentId) {
      const [restored] = await tx
        .update(deviceFunctionAssessments)
        .set({ active: true, supersededAt: null })
        .where(and(
          eq(deviceFunctionAssessments.id, input.assessmentId),
          eq(deviceFunctionAssessments.deviceId, device.id),
          eq(deviceFunctionAssessments.orgId, device.orgId),
        ))
        .returning({ functionKey: deviceFunctionAssessments.functionKey, source: deviceFunctionAssessments.source });
      if (restored) {
        await writeProjection(tx, device.id, device.orgId, { deviceFunction: restored.functionKey, deviceFunctionSource: restored.source }, now);
        return { outcome: 'restored', supersededAssessmentId: active && active.id !== input.assessmentId ? active.id : null };
      }
      // The prior row is gone (erased); fall through to a clear rather than
      // leave a projection pointing at nothing.
    }
    await writeProjection(tx, device.id, device.orgId, { deviceFunction: null, deviceFunctionSource: null }, now);
    return { outcome: 'cleared', supersededAssessmentId: active && active.id !== input.assessmentId ? active.id : null };
  });
}

export async function getDeviceFunction(deviceId: string, orgId: string, exec: Executor = db): Promise<DeviceFunctionDto> {
  const active = await readActive(exec, deviceId, orgId);
  if (!active) {
    return {
      deviceId, functionKey: null, label: null, source: null, confidence: null,
      evidence: [], assessedAt: null, runId: null, reportRunId: null,
    };
  }
  return {
    deviceId,
    functionKey: active.functionKey,
    label: active.label ?? null,
    source: active.source,
    confidence: active.confidence == null ? null : Number(active.confidence),
    evidence: Array.isArray(active.evidence) ? active.evidence : [],
    assessedAt: active.createdAt instanceof Date ? active.createdAt.toISOString() : String(active.createdAt),
    runId: active.runId ?? null,
    reportRunId: active.reportRunId ?? null,
  };
}

/**
 * Section-2 apply (called by W03's apply step): one `ai` row per approved
 * device per function. Device ids outside the org are counted, not written
 * and not thrown on — the report may be stale against a device that moved.
 * Validates every key before the first statement so a bad function aborts
 * the whole step, not half of it.
 */
export async function applyDesignFunctions(
  input: ApplyDesignFunctionsInput,
  exec?: Executor,
): Promise<ApplyDesignFunctionsResult> {
  for (const fn of input.functions) resolveKeyAndLabel(fn.functionKey, fn.label);

  const requested = [...new Set(input.functions.flatMap((fn) => fn.deviceIds))];
  const result: ApplyDesignFunctionsResult = { written: 0, keptManual: 0, skippedForeign: 0 };
  if (requested.length === 0) return result;

  return runInTransaction(exec, async (tx) => {
    const rows = await tx
      .select({ id: devices.id })
      .from(devices)
      .where(and(eq(devices.orgId, input.orgId), inArray(devices.id, requested)));
    const inOrg = new Set(rows.map((r) => r.id));

    for (const fn of input.functions) {
      for (const deviceId of new Set(fn.deviceIds)) {
        if (!inOrg.has(deviceId)) {
          result.skippedForeign += 1;
          continue;
        }
        let outcome: UpsertDeviceFunctionResult;
        try {
          outcome = await upsertDeviceFunction(fnInput(fn, deviceId), tx);
        } catch (err) {
          // The membership read above and the per-device lock are separate
          // statements: a device deleted or moved out of the org in between
          // surfaces here as device_not_found. Count it like any other foreign
          // id rather than aborting the whole step — the contract is "never
          // throw for a device that is not (or no longer) ours".
          if (err instanceof DeviceFunctionError && err.code === 'device_not_found') {
            result.skippedForeign += 1;
            continue;
          }
          throw err;
        }
        if (outcome.outcome === 'written') result.written += 1;
        else result.keptManual += 1;
      }
    }
    return result;
  });

  function fnInput(fn: ApplyDesignFunctionsInput['functions'][number], deviceId: string): UpsertDeviceFunctionInput {
    return {
      deviceId,
      orgId: input.orgId,
      functionKey: fn.functionKey,
      label: fn.label ?? null,
      source: 'ai',
      confidence: fn.confidence,
      evidence: fn.evidence,
      runId: input.runId,
      reportRunId: input.reportRunId,
      userId: input.userId,
    };
  }
}
