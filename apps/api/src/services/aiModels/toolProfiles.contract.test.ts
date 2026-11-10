import { describe, expect, it } from 'vitest';
import { TOOL_TIERS } from '../aiAgentSdkTools';
import { TIER2_ACTIONS, TIER3_ACTIONS } from '../aiGuardrails';
import { MFA_GATED_TOOL_ACTIONS } from '../aiToolMfaGate';
import { CLIENT_TOOL_REGISTRIES } from '../clientAiTools';
import { SCRIPT_BUILDER_TOOL_TIERS } from '../scriptBuilderTools';
import { WISP_NON_FOCAL_TOOLS, WISP_TOOL_SUBJECTS } from '../wisp/toolSubjects';
import { CHAT_MINIMAL_TOOLS, CURATED_PROFILES, PROFILED_SURFACES } from './toolProfiles';

const REGISTRY = TOOL_TIERS as Record<string, number>;
const OFFICE_NAMES = new Set(Object.values(CLIENT_TOOL_REGISTRIES).flatMap((r) => Object.keys(r)));

/** The tier a surface's own registry gives a name (script builder has its own tier map). */
function tierOn(surface: string, name: string): number | undefined {
  if (surface === 'script_builder') return SCRIPT_BUILDER_TOOL_TIERS[name];
  return REGISTRY[name];
}

/** Base tier 1 with no supervised, approval or MFA-gated action. */
function isLiterallyReadOnly(surface: string, name: string): boolean {
  if (surface === 'office_chat') {
    return Object.values(CLIENT_TOOL_REGISTRIES).every((r) => !r[name] || r[name]!.mutating === false);
  }
  return tierOn(surface, name) === 1 && !TIER2_ACTIONS[name] && !TIER3_ACTIONS[name] && !MFA_GATED_TOOL_ACTIONS[name];
}

describe('curated tool profiles (#11394)', () => {
  it('every curated name is declared on its surface', () => {
    for (const surface of PROFILED_SURFACES) {
      for (const name of CURATED_PROFILES[surface].standard) {
        const declared = surface === 'office_chat' ? OFFICE_NAMES.has(name)
          : surface === 'script_builder' ? name in SCRIPT_BUILDER_TOOL_TIERS
            : name in REGISTRY;
        expect(declared, `${surface}: ${name}`).toBe(true);
      }
    }
  });

  it('every curated registry tool stays classified for Wisp (WISP_TOOL_SUBJECTS ∪ WISP_NON_FOCAL_TOOLS)', () => {
    for (const surface of PROFILED_SURFACES) {
      for (const name of CURATED_PROFILES[surface].standard) {
        if (!(name in REGISTRY)) continue;
        expect(Boolean(WISP_TOOL_SUBJECTS[name]) || WISP_NON_FOCAL_TOOLS.has(name), name).toBe(true);
      }
    }
  });

  it('every minimal tool is literally read-only: base tier 1, no TIER2/TIER3/MFA-gated action', () => {
    for (const surface of PROFILED_SURFACES) {
      for (const name of CURATED_PROFILES[surface].minimal) {
        expect(isLiterallyReadOnly(surface, name), `${surface} minimal: ${name}`).toBe(true);
      }
    }
  });

  it('negative control: the read-only check rejects manage_alerts and resolve_device_context', () => {
    expect(isLiterallyReadOnly('chat', 'manage_alerts')).toBe(false);
    expect(isLiterallyReadOnly('chat', 'resolve_device_context')).toBe(false);
    expect(isLiterallyReadOnly('script_builder', 'execute_script_on_device')).toBe(false);
  });

  it('chat minimal is exactly the 12 names of plan Decision 5', () => {
    expect([...CURATED_PROFILES.chat.minimal].sort()).toEqual([
      'analyze_metrics', 'get_alert_correlations', 'get_device_details', 'get_device_hardware_health', 'get_device_health',
      'get_fleet_health', 'get_org_summary', 'list_organizations', 'query_audit_log', 'query_devices', 'search_documentation',
      'search_logs',
    ]);
    expect(CHAT_MINIMAL_TOOLS).toHaveLength(12);
  });

  it('chat standard has 35..45 names, no duplicates', () => {
    const standard = CURATED_PROFILES.chat.standard;
    expect(standard.length).toBeGreaterThanOrEqual(35);
    expect(standard.length).toBeLessThanOrEqual(45);
    expect(new Set(standard).size).toBe(standard.length);
  });

  it('minimal ⊂ standard on every surface, and neither is empty', () => {
    for (const surface of PROFILED_SURFACES) {
      const { minimal, standard } = CURATED_PROFILES[surface];
      expect(minimal.length, surface).toBeGreaterThan(0);
      for (const name of minimal) expect(standard, `${surface}: ${name}`).toContain(name);
    }
  });
});
