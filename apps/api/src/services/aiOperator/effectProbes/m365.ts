/**
 * M365 arm of the effect-probe registry (Recipe Library E4 #6169, plan D-E4-6).
 *
 * DELIBERATELY REGISTERS NOTHING TODAY. The M365 write catalog's probe
 * function (`probeM365Effect`, keyed by Graph action id and returning
 * `observedAt` as an ISO string) ships with the M1 wave, which has not
 * merged. Until it does, every `m365_*` effect answers `unknown` from the
 * registry default — which by spec §6.6 means the task hands off, never a
 * false verified success. M1 replaces this body with a tool-name → action-id
 * adapter over `M365_HEADLESS_ACTIONS` (`services/m365ToolsHeadless.ts`) that
 * converts `observedAt` to a `Date`.
 */
export function registerM365EffectProbes(): string[] {
  return [];
}
