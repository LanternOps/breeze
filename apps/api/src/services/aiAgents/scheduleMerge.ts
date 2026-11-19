// apps/api/src/services/aiAgents/scheduleMerge.ts
/**
 * The pure partner-baseline ∧ org-override merge for `ai_agent_schedules`.
 *
 * A LEAF module on purpose (types from `@breeze/shared` only, no db, no
 * services): `sweepActMode.ts` needs this from the intent RELEASE path, and
 * `scheduleService.ts` — where this used to live — imports the schema barrel
 * and the access layer, which is far more than a release-time brake should
 * pull in. `scheduleService` re-exports it, so every existing importer is
 * unchanged.
 */
import type { AiSweepKind } from '@breeze/shared';

/**
 * The org-facing merge, and the reason a stale override can never widen a
 * sweep: kinds are INTERSECTED, and either side may disable. Pure by design —
 * the sweeper (Task 9) calls it per (baseline, org) pair with no db access.
 */
export function effectiveSchedule(
  baseline: { enabled: boolean; sweepKinds: AiSweepKind[]; actMode?: boolean | null },
  override: { enabled: boolean; sweepKinds: AiSweepKind[]; actMode?: boolean | null } | null,
): { enabled: boolean; sweepKinds: AiSweepKind[]; actMode: boolean } {
  return {
    enabled: baseline.enabled && (override?.enabled ?? true),
    sweepKinds: override
      ? baseline.sweepKinds.filter((kind) => override.sweepKinds.includes(kind))
      : [...baseline.sweepKinds],
    // #4442 W04 — act mode is THREE-VALUED and fails closed on both arms.
    // Deliberately NOT the `baseline && (override ?? true)` shape used by
    // `enabled` above: this column is nullable with no default, so on an
    // override `null` has to mean "inherit" while `false` means "disarm" —
    // and on a baseline anything that is not exactly `true` is "not armed".
    // Hence the explicit `=== true` / `!== false` rather than truthiness.
    actMode: baseline.actMode === true && override?.actMode !== false,
  };
}

type EffectiveSchedule = ReturnType<typeof effectiveSchedule>;

/**
 * Full-control W16 (#6786, Decision 3): whether a write lets the schedule do
 * anything unattended that it could not do before. Compares the whole effective
 * schedule, because `enabled`, `sweepKinds` and `actMode` merge independently and
 * each one on its own widens what an armed schedule runs. A cadence change is
 * refused separately: it is neither wider nor narrower, just different.
 */
export function scheduleWriteWidens(before: EffectiveSchedule, after: EffectiveSchedule): boolean {
  return (after.enabled && !before.enabled)
    || after.sweepKinds.some((kind) => !before.sweepKinds.includes(kind))
    || (after.actMode && !before.actMode);
}
