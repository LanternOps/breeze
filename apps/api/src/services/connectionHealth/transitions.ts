import {
  HEALTHY_TO_RESOLVE, REOPEN_WINDOW_MS,
  type HealthObservation, type TrackedIncident, type TransitionAction,
} from './types';

/**
 * Spec §1.2 state machine, pure. One incident per (source_kind, source_id):
 * `tracked` holds that kind's open, pending (openedAt null) and
 * recently-resolved rows. Order of the result follows `tracked`, then new
 * observations, so tests and logs are deterministic.
 */
export function planTransitions(input: {
  observations: readonly HealthObservation[];
  tracked: readonly TrackedIncident[];
  now: Date;
  seed: boolean;
}): TransitionAction[] {
  const { observations, tracked, now, seed } = input;
  const bySource = new Map<string, HealthObservation>();
  for (const o of observations) {
    if (bySource.has(o.sourceId)) throw new Error(`duplicate observation for ${o.sourceKind}:${o.sourceId}`);
    bySource.set(o.sourceId, o);
  }

  const actions: TransitionAction[] = [];
  const handled = new Set<string>();

  for (const t of tracked) {
    handled.add(t.sourceId);
    const o = bySource.get(t.sourceId);

    if (t.resolvedAt) {
      // Recently resolved: only a broken observation inside the window matters.
      if (o?.state === 'broken' && now.getTime() - t.resolvedAt.getTime() <= REOPEN_WINDOW_MS) {
        actions.push({ type: 'reopen', incidentId: t.id, obs: o });
      }
      continue;
    }

    const pending = t.openedAt === null;
    if (!o || o.state === 'retired') {
      actions.push(pending
        ? { type: 'deletePending', incidentId: t.id }
        : { type: 'resolve', incidentId: t.id, resolution: 'retired' });
      continue;
    }
    if (o.state === 'unknown') continue;
    if (o.state === 'healthy') {
      if (pending) {
        actions.push({ type: 'deletePending', incidentId: t.id });
      } else if (t.healthyStreak + 1 >= HEALTHY_TO_RESOLVE) {
        actions.push({ type: 'resolve', incidentId: t.id, resolution: 'recovered' });
      } else {
        actions.push({ type: 'healthyTick', incidentId: t.id, healthyStreak: t.healthyStreak + 1 });
      }
      continue;
    }
    // broken
    if (pending) {
      actions.push({ type: 'promotePending', incidentId: t.id, obs: o, notify: !seed });
    } else {
      actions.push({
        type: 'update', incidentId: t.id, obs: o,
        escalated: t.severity === 'transient' && o.severity === 'permanent',
      });
    }
  }

  for (const o of observations) {
    if (handled.has(o.sourceId) || o.state !== 'broken') continue;
    if (seed || o.severity === 'permanent') {
      actions.push({ type: 'insertOpen', obs: o, notify: !seed });
    } else {
      actions.push({ type: 'insertPending', obs: o });
    }
  }
  return actions;
}
