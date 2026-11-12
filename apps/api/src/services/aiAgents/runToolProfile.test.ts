import { describe, expect, it } from 'vitest';
import type { ToolProfileFacts } from '../aiModels/toolExposure';
import { CHAT_MINIMAL_TOOLS } from '../aiModels/toolProfiles';
import { AgentRunBlockedError } from './modelBlocked';
import { applyRunToolProfile, type RunToolProfileInput } from './runToolProfile';

const facts = (over: Partial<ToolProfileFacts> = {}): ToolProfileFacts => ({
  toolProfile: 'auto', toolAllowlist: null, effectiveWindow: null, transport: 'gateway', ...over,
});
const TROUBLESHOOT = ['get_device_details', 'search_logs', 'list_scripts', 'execute_command', 'run_script', 'set_device_context'];

function input(over: Partial<RunToolProfileInput> = {}): RunToolProfileInput {
  return {
    run: { profile: 'device_troubleshooting' },
    facts: facts(),
    exposedNames: TROUBLESHOOT.map((n) => `mcp__breeze__${n}`),
    onlyTools: new Set(TROUBLESHOOT),
    flowToolNames: [],
    offeringId: 'off-1',
    domainOf: () => undefined,
    ...over,
  };
}

describe('applyRunToolProfile (#11394)', () => {
  it('identity: exposure and registration unchanged', () => {
    const base = input();
    const r = applyRunToolProfile(base);
    expect(r.exposedNames).toEqual(base.exposedNames);
    expect(r.onlyTools).toBe(base.onlyTools);
    expect(r.exposure.names).toBeNull();
  });

  it('troubleshoot run under minimal is blocked tool_profile_underpowered before any provider call', () => {
    let caught: unknown;
    try { applyRunToolProfile(input({ facts: facts({ toolProfile: 'minimal' }) })); } catch (err) { caught = err; }
    expect(caught).toBeInstanceOf(AgentRunBlockedError);
    expect(caught).toMatchObject({
      errorCode: 'tool_profile_underpowered',
      outcome: { blockedReason: 'tool_profile_underpowered', offeringId: 'off-1', missingTools: ['execute_command', 'run_script'] },
    });
  });

  it('troubleshoot run under standard keeps its floor and narrows the rest', () => {
    const r = applyRunToolProfile(input({ facts: facts({ toolProfile: 'standard' }) }));
    expect(new Set(r.onlyTools)).toEqual(new Set(['get_device_details', 'search_logs', 'list_scripts', 'execute_command', 'run_script']));
    expect(r.exposedNames).toEqual(['get_device_details', 'search_logs', 'list_scripts', 'execute_command', 'run_script'].map((n) => `mcp__breeze__${n}`));
  });

  it('a verdict run keeps its outcome tool (and submit_task_step) under minimal', () => {
    const exposed = [...CHAT_MINIMAL_TOOLS, 'manage_alerts'].map((n) => `mcp__breeze__${n}`);
    const r = applyRunToolProfile(input({
      run: { profile: 'verdict', taskId: 't-1' },
      facts: facts({ toolProfile: 'minimal' }),
      exposedNames: [...exposed, 'mcp__breeze__submit_alert_verdict', 'mcp__breeze__submit_task_step'],
      onlyTools: new Set([...CHAT_MINIMAL_TOOLS, 'manage_alerts']),
    }));
    expect(r.exposure.extraToolNames).toEqual(['submit_alert_verdict', 'submit_task_step']);
    expect(r.exposedNames).toContain('mcp__breeze__submit_alert_verdict');
    expect(r.exposedNames).toContain('mcp__breeze__submit_task_step');
    expect(r.exposedNames).not.toContain('mcp__breeze__manage_alerts');
    expect(r.onlyTools!.has('manage_alerts')).toBe(false);
  });

  it('flow tools are dropped under minimal, kept under custom scripts', () => {
    const exposed = [...TROUBLESHOOT.map((n) => `mcp__breeze__${n}`), 'mcp__breeze__flow__reset'];
    const minimal = applyRunToolProfile(input({ run: { profile: 'full' }, facts: facts({ toolProfile: 'minimal' }), exposedNames: exposed, flowToolNames: ['flow__reset'] }));
    expect(minimal.keepsFlowTool('flow__reset')).toBe(false);
    expect(minimal.exposedNames).not.toContain('mcp__breeze__flow__reset');
    const custom = applyRunToolProfile(input({
      run: { profile: 'full' }, facts: facts({ toolProfile: 'custom', toolAllowlist: { domains: ['scripts'], tools: [] } }),
      exposedNames: exposed, flowToolNames: ['flow__reset'],
    }));
    expect(custom.keepsFlowTool('flow__reset')).toBe(true);
    expect(custom.exposedNames).toContain('mcp__breeze__flow__reset');
  });
});
