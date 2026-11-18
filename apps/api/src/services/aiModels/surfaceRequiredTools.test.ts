import { AI_AGENT_RUN_PROFILES } from '@breeze/shared';
import { describe, expect, it } from 'vitest';
import { TOOL_TIERS } from '../aiAgentSdkTools';
import { outcomeToolsForRun } from '../aiAgents/outcomeTools';
import { TROUBLESHOOT_PROPOSABLE_TOOLS } from '../aiAgents/troubleshootProfile';
import { SCRIPT_BUILDER_TOOL_TIERS } from '../scriptBuilderTools';
import {
  SURFACE_REQUIRED_TOOLS,
  SURFACE_UNDERPOWERED_MESSAGE,
  TOOL_PROFILE_UNDERPOWERED,
  checkSurfaceCoverage,
  requiredToolsFor,
} from './surfaceRequiredTools';
import { resolveToolExposure, type ToolProfileFacts } from './toolExposure';
import { CHAT_STANDARD_TOOLS } from './toolProfiles';

const facts = (over: Partial<ToolProfileFacts>): ToolProfileFacts => ({
  toolProfile: 'auto', toolAllowlist: null, effectiveWindow: null, transport: 'gateway', ...over,
});
const SCRIPT_BUILDER_BASE = Object.keys(SCRIPT_BUILDER_TOOL_TIERS);
const AGENT_BASE = [...CHAT_STANDARD_TOOLS, 'registry_operations', 'get_device_context'];

function agentExposure(profile: ToolProfileFacts['toolProfile'], run: { profile: (typeof AI_AGENT_RUN_PROFILES)[number]; taskId?: string | null }) {
  return resolveToolExposure({
    surface: 'ai_agents',
    runProfile: run.profile,
    facts: facts({ toolProfile: profile, toolAllowlist: profile === 'custom' ? { domains: [], tools: [] } : null }),
    surfaceBaseSet: AGENT_BASE,
    extraTools: outcomeToolsForRun(run).map((name) => ({ name, domain: null, alwaysKeep: true })),
  });
}

describe('SURFACE_REQUIRED_TOOLS (#11394)', () => {
  it('names only tools its surface declares', () => {
    for (const name of SURFACE_REQUIRED_TOOLS.chat) expect(name in TOOL_TIERS, name).toBe(true);
    for (const name of SURFACE_REQUIRED_TOOLS.script_builder) expect(name in SCRIPT_BUILDER_TOOL_TIERS, name).toBe(true);
    for (const run of AI_AGENT_RUN_PROFILES) {
      for (const name of requiredToolsFor('ai_agents', { profile: run })) {
        const outcome = (outcomeToolsForRun({ profile: run }) as string[]).includes(name);
        expect(outcome || name in TOOL_TIERS, `${run}: ${name}`).toBe(true);
      }
    }
    for (const name of requiredToolsFor('ai_agents', { profile: 'device_troubleshooting' })) {
      if (!(outcomeToolsForRun({ profile: 'device_troubleshooting' }) as string[]).includes(name)) {
        expect(TROUBLESHOOT_PROPOSABLE_TOOLS as readonly string[]).toContain(name);
      }
    }
  });

  it('the identity exposure always passes', () => {
    const e = resolveToolExposure({ surface: 'script_builder', facts: facts({}), surfaceBaseSet: SCRIPT_BUILDER_BASE, extraTools: [] });
    expect(checkSurfaceCoverage('script_builder', e)).toEqual({ ok: true });
  });

  it('script_builder custom without execute_script_on_device refuses with the underpowered message', () => {
    const e = resolveToolExposure({
      surface: 'script_builder',
      facts: facts({ toolProfile: 'custom', toolAllowlist: { domains: [], tools: ['apply_script_code', 'list_scripts'] } }),
      surfaceBaseSet: SCRIPT_BUILDER_BASE,
      extraTools: [],
    });
    expect(checkSurfaceCoverage('script_builder', e)).toEqual({ ok: false, missing: ['execute_script_on_device'] });
    expect(SURFACE_UNDERPOWERED_MESSAGE('script builder')).toBe(
      "This model's tool profile does not include what the script builder needs. Assign a larger model to this surface, or widen the profile.",
    );
    expect(TOOL_PROFILE_UNDERPOWERED).toBe('tool_profile_underpowered');
  });

  it('script_builder standard passes, minimal does not (read-only cannot test-run)', () => {
    const run = (p: 'minimal' | 'standard') => checkSurfaceCoverage('script_builder', resolveToolExposure({
      surface: 'script_builder', facts: facts({ toolProfile: p }), surfaceBaseSet: SCRIPT_BUILDER_BASE, extraTools: [],
    }));
    expect(run('standard')).toEqual({ ok: true });
    expect(run('minimal')).toEqual({ ok: false, missing: ['execute_script_on_device'] });
  });

  it('outcome tools incl. submit_task_step (taskId set) survive any profile', () => {
    for (const profile of ['minimal', 'standard', 'custom'] as const) {
      const e = agentExposure(profile, { profile: 'verdict', taskId: 'task-1' });
      expect(e.extraToolNames).toEqual(['submit_alert_verdict', 'submit_task_step']);
      expect(checkSurfaceCoverage('ai_agents', e, { profile: 'verdict', taskId: 'task-1' })).toEqual({ ok: true });
    }
  });

  it('a missing outcome tool fails coverage (the floor is checked, not assumed)', () => {
    const e = resolveToolExposure({
      surface: 'ai_agents', runProfile: 'verdict', facts: facts({ toolProfile: 'minimal' }), surfaceBaseSet: AGENT_BASE, extraTools: [],
    });
    expect(checkSurfaceCoverage('ai_agents', e, { profile: 'verdict' })).toEqual({ ok: false, missing: ['submit_alert_verdict'] });
  });

  it('troubleshoot profile fails coverage under minimal (missing execute_command, run_script), passes under standard', () => {
    const run = { profile: 'device_troubleshooting' as const };
    expect(checkSurfaceCoverage('ai_agents', agentExposure('minimal', run), run)).toEqual({ ok: false, missing: ['execute_command', 'run_script'] });
    expect(checkSurfaceCoverage('ai_agents', agentExposure('standard', run), run)).toEqual({ ok: true });
  });

  it('analysis and other read-only run profiles pass coverage under minimal', () => {
    for (const profile of ['analysis', 'verdict', 'sweep', 'narrative', 'full'] as const) {
      expect(checkSurfaceCoverage('ai_agents', agentExposure('minimal', { profile }), { profile }), profile).toEqual({ ok: true });
    }
  });

  it('chat minimal passes', () => {
    const e = resolveToolExposure({
      surface: 'chat', facts: facts({ toolProfile: 'minimal' }), surfaceBaseSet: ['query_devices', 'set_device_context'], extraTools: [],
    });
    expect(checkSurfaceCoverage('chat', e)).toEqual({ ok: true });
  });

  it('ai_agents coverage without a run is a programming error', () => {
    const e = agentExposure('minimal', { profile: 'full' });
    expect(() => checkSurfaceCoverage('ai_agents', e)).toThrow(/needs the run/);
  });
});
