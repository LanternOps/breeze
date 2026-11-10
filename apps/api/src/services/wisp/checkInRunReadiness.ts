/**
 * #11610 — can a run-mode check-in actually run for this org? A run check-in
 * admits ONE assessment run, which is a `triage` run, so it needs an ENABLED
 * Triage agent (partner baseline → org override) and the server's agent kill
 * switch on. The same three conditions admission checks (runService rules 1-2);
 * scheduling asks up front so the model never promises a check that cannot run.
 */
import { envFlag } from '../../config/env';
import { resolveEffectiveAgentSystem } from '../aiAgents/effectivePolicy';

export type RunCheckInBlocker = 'kill_switch_off' | 'no_effective_agent' | 'agent_disabled' | 'mode_off';

/** The reason a run check-in for `orgId` could not run now, or null when it could. */
export async function runCheckInBlocker(orgId: string): Promise<RunCheckInBlocker | null> {
  if (!envFlag('BREEZE_AI_AGENTS_ENABLED', false)) return 'kill_switch_off';
  const resolved = await resolveEffectiveAgentSystem(orgId, 'triage');
  if (!resolved) return 'no_effective_agent';
  if (!resolved.effective.enabled) return 'agent_disabled';
  if (resolved.effective.mode === 'off') return 'mode_off';
  return null;
}

/** The model-facing sentence for a blocker (the same cause the degraded post names). */
export function runCheckInBlockerMessage(blocker: RunCheckInBlocker): string {
  switch (blocker) {
    case 'kill_switch_off':
      return 'AI agents are turned off on this server, so Wisp cannot check on its own. An administrator has to turn them on. Use mode notify.';
    case 'mode_off':
      return "This organization's Triage agent is set to mode Off, so Wisp cannot check on its own. Set it to Shadow or Act under Settings → AI Agents, or use mode notify.";
    case 'agent_disabled':
    case 'no_effective_agent':
      return 'No Triage agent is switched on for this organization, so Wisp cannot check on its own. Turn one on under Settings → AI Agents, or use mode notify.';
  }
}
