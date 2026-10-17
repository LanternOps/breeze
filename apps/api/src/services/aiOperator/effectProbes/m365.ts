/**
 * M365 arm of the effect-probe registry (Recipe Library E4 #6169, M1 #6170).
 *
 * A tool-name → action-id adapter over `M365_HEADLESS_ACTIONS`
 * (services/m365ToolsHeadless.ts) and the control plane's typed probe,
 * `probeM365Effect` (services/m365ControlPlane/effectProbes.ts). The probe
 * criteria live there; this file only:
 *   - registers one probe per headless M365 tool (the approved effect set and
 *     operation rows are keyed by tool name). Probe-only action ids are not in
 *     that map, so no tool can name one;
 *   - rebuilds the typed action with the SAME builder the headless write uses
 *     and re-validates it, so the probe observes exactly what the write would
 *     have written. Arguments that do not form a valid action answer
 *     `unknown` without touching Graph;
 *   - opens a strictly org-scoped db context for the probe. The operator task
 *     worker calls probes with no context, and a contextless read is denied by
 *     RLS (the connection would look missing and every probe would be
 *     `unknown`). The task's org id is the one the release worker would act
 *     on, so this is the same scope the effect's write runs under — never a
 *     system context;
 *   - converts `observedAt` from the ISO string to a Date.
 */
import { m365WriteActionSchema } from '@breeze/shared/m365';
import { runOutsideDbContext, withDbAccessContext } from '../../../db';
import { probeM365Effect } from '../../m365ControlPlane/effectProbes';
import { buildWriteAction, M365_HEADLESS_ACTIONS } from '../../m365ToolsHeadless';
import { registerEffectProbe, type EffectProbe } from './index';

function adapt(toolName: string, actionId: (typeof M365_HEADLESS_ACTIONS)[keyof typeof M365_HEADLESS_ACTIONS]): EffectProbe {
  return async (effect, ctx) => {
    const parsed = m365WriteActionSchema.safeParse(buildWriteAction(actionId, effect.canonicalArguments as Record<string, unknown>));
    if (!parsed.success || parsed.data.type !== actionId) {
      return {
        state: 'unknown',
        observedAt: new Date(),
        detail: `${toolName}: the approved arguments do not form a valid ${actionId} action, so the effect cannot be observed`,
      };
    }
    const action = parsed.data;
    const observed = await runOutsideDbContext(() => withDbAccessContext(
      { scope: 'organization', orgId: ctx.orgId, accessibleOrgIds: [ctx.orgId], label: 'aiOperator.effectProbe.m365' },
      () => probeM365Effect(actionId, action, { orgId: ctx.orgId, effectRequestedAt: ctx.effectRequestedAt }),
    ));
    return { state: observed.state, observedAt: new Date(observed.observedAt), detail: observed.detail };
  };
}

export function registerM365EffectProbes(): string[] {
  const names: string[] = [];
  for (const [toolName, actionId] of Object.entries(M365_HEADLESS_ACTIONS) as [string, (typeof M365_HEADLESS_ACTIONS)[keyof typeof M365_HEADLESS_ACTIONS]][]) {
    registerEffectProbe(toolName, adapt(toolName, actionId));
    names.push(toolName);
  }
  return names;
}
