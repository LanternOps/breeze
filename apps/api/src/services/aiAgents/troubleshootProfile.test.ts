import { describe, expect, it } from 'vitest';
import { AI_AGENT_LIMIT_DEFAULTS } from '@breeze/shared';
import {
  TROUBLESHOOT_MODE_PROMPT,
  TROUBLESHOOT_PROPOSABLE_TOOLS,
  TROUBLESHOOT_READ_TOOLS,
  isTroubleshootProfile,
  troubleshootLimits,
  troubleshootToolAllowlist,
} from './troubleshootProfile';

describe('troubleshootProfile', () => {
  it('recognises only the device_troubleshooting profile', () => {
    expect(isTroubleshootProfile({ profile: 'device_troubleshooting' })).toBe(true);
    for (const profile of ['full', 'remediation_research', 'analysis', 'assessment'] as const) {
      expect(isTroubleshootProfile({ profile })).toBe(false);
    }
  });

  it('pins turns 30, budget 100 cents and 3 actions (approval cards) per run, keeping unrelated keys', () => {
    const limits = { ...AI_AGENT_LIMIT_DEFAULTS, maxTurnsPerRun: 99, maxBudgetCentsPerRun: 999, maxActionsPerRun: 50 };
    const pinned = troubleshootLimits(limits);
    expect(pinned.maxTurnsPerRun).toBe(30);
    expect(pinned.maxBudgetCentsPerRun).toBe(100);
    expect(pinned.maxActionsPerRun).toBe(3);
    expect(pinned.maxRunsPerHour).toBe(limits.maxRunsPerHour);
    expect(pinned.maxDevicesPerRun).toBe(limits.maxDevicesPerRun);
  });

  it('allowlist is reads ∪ proposable, whatever the agent allowlist says (floor, not intersection)', () => {
    const expected = [...TROUBLESHOOT_READ_TOOLS, ...TROUBLESHOOT_PROPOSABLE_TOOLS];
    expect(troubleshootToolAllowlist([])).toEqual(expected);
    expect(troubleshootToolAllowlist(['manage_services', 'delete_device'])).toEqual(expected);
    expect(new Set(expected).size).toBe(expected.length);
  });

  it('names the planned reads and proposable tools exactly', () => {
    expect([...TROUBLESHOOT_READ_TOOLS]).toEqual([
      'get_device_details', 'get_device_context', 'get_device_health', 'get_device_events', 'get_device_software',
      'analyze_metrics', 'search_logs', 'find_proven_fixes', 'list_scripts',
    ]);
    expect([...TROUBLESHOOT_PROPOSABLE_TOOLS]).toEqual([
      'execute_command', 'registry_operations', 'set_device_context', 'run_script', 'file_operations',
    ]);
  });

  it('mode prompt is fixed text and tells the model changes need a person to approve', () => {
    expect(TROUBLESHOOT_MODE_PROMPT).not.toContain('${');
    expect(TROUBLESHOOT_MODE_PROMPT).toMatch(/approve/i);
    expect(TROUBLESHOOT_MODE_PROMPT).toMatch(/one device/i);
  });
});
