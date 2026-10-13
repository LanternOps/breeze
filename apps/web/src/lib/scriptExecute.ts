import type { TFunction } from 'i18next';
import type { ScriptAdmissionResult } from '@breeze/shared';

import { fetchWithAuth } from '../stores/auth';
import { navigateTo } from './navigation';
import { ActionError, runAction } from './runAction';

/** Mirrors `MAX_SCRIPT_RUN_TARGETS` in apps/api/src/services/scriptRunTargets.ts. */
export const MAX_SCRIPT_RUN_TARGETS = 500;

/** Mirrors `scriptRunGroupTargetSchema` (groups only, 1 to 100). */
export const MAX_SCRIPT_RUN_GROUPS = 100;

export type ScriptRunGroupTarget = { type: 'groups'; groupIds: string[] };

/** A run targets either explicit devices or saved device groups, never both. */
export type ScriptRunTarget = string[] | ScriptRunGroupTarget;

/** `warnings` is only present on group-target runs (additive 201 field). */
export type ScriptExecuteResult = ScriptAdmissionResult & { warnings?: string[] };

export function isGroupTarget(target: ScriptRunTarget): target is ScriptRunGroupTarget {
  return !Array.isArray(target);
}

/**
 * POST /scripts/:id/execute through `runAction`.
 *
 * The Run Script modal renders failures (and per-target admission) inline in
 * its own form, so the error toast is suppressed here: a toast on top of the
 * inline alert would say the same thing twice. The thrown `ActionError` keeps
 * the parsed body (`code`, `count`, `perGroupCounts`, `warnings`, ...) for
 * `describeScriptExecuteError`.
 */
export async function postScriptExecute(
  scriptId: string,
  target: ScriptRunTarget,
  parameters: Record<string, string | number | boolean>,
  runAs: 'system' | 'user',
  errorFallback: string,
): Promise<ScriptExecuteResult> {
  const body = isGroupTarget(target)
    ? { target, parameters, runAs }
    : { deviceIds: target, parameters, runAs };

  return runAction<ScriptExecuteResult>({
    request: () => fetchWithAuth(`/scripts/${scriptId}/execute`, {
      method: 'POST',
      body: JSON.stringify(body),
    }),
    errorFallback,
    suppressErrorToast: () => true,
    onUnauthorized: () => { void navigateTo('/login', { replace: true }); },
  });
}

type PerGroupCount = { id: string; memberCount: number };

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' ? (value as Record<string, unknown>) : {};
}

/**
 * Turn a failed execute call into a sentence an operator can act on. The group
 * target codes carry structured detail (`count`, `perGroupCounts`, `groupIds`,
 * `warnings`) that the bare server prose would lose in translation.
 */
export function describeScriptExecuteError(
  err: unknown,
  t: TFunction,
  groupNames: ReadonlyMap<string, string>,
  fallback: string,
): string {
  if (!(err instanceof ActionError)) {
    return err instanceof Error ? err.message : fallback;
  }
  const body = asRecord(err.body);
  const warnings = Array.isArray(body.warnings)
    ? body.warnings.filter((w): w is string => typeof w === 'string')
    : [];

  if (err.code === 'TOO_MANY_TARGETS') {
    const count = typeof body.count === 'number' ? body.count : undefined;
    const perGroup = (Array.isArray(body.perGroupCounts) ? body.perGroupCounts : [])
      .map(asRecord)
      .filter((row): row is PerGroupCount => typeof row.id === 'string' && typeof row.memberCount === 'number')
      .map((row) => `${groupNames.get(row.id) ?? row.id} (${row.memberCount})`);
    const head = t('scripts:scriptExecutionModal.groups.errors.tooManyTargets', {
      count: count ?? MAX_SCRIPT_RUN_TARGETS + 1,
      max: MAX_SCRIPT_RUN_TARGETS,
    });
    return perGroup.length > 0
      ? `${head} ${t('scripts:scriptExecutionModal.groups.errors.perGroup', { groups: perGroup.join(', ') })}`
      : head;
  }

  if (err.code === 'GROUP_NOT_FOUND') {
    const ids = Array.isArray(body.groupIds) ? body.groupIds.filter((id): id is string => typeof id === 'string') : [];
    return t('scripts:scriptExecutionModal.groups.errors.groupNotFound', { count: ids.length || 1 });
  }

  if (err.code === 'NO_TARGETS') {
    const head = t('scripts:scriptExecutionModal.groups.errors.noTargets');
    return warnings.length > 0 ? `${head} ${warnings.join(' ')}` : head;
  }

  return err.message || fallback;
}
