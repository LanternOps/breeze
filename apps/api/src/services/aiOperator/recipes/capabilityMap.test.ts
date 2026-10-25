/**
 * `capabilityForTool` — the tool → capability map, derived from a recipe's
 * own `requires` list rather than hand-maintained per recipe (R2 Task 1, G2).
 *
 * R1 built this as `CAPABILITY_FOR_TOOL`, a module constant inside
 * identityOffboarding.ts. With a second recipe the derivation has to be a
 * property of whichever recipe is asked about, so it moves here and the
 * offboarding constant becomes a call of it.
 *
 * THE UMBRELLA RULE is the subtlety worth its own cases. A recipe declares one
 * blanket `agent_tool` capability naming EVERY effect tool
 * (`HELPDESK_ALLOWLIST_CAPABILITY`), because the helpdesk agent's allowlist
 * has to cover all of them. If that entry entered the map, every tool would
 * map to it and the per-effect capabilities would be unreachable. The shipped
 * derivation excludes it BY NAME; this one must too, exactly — a tool named
 * only by the umbrella has NO entry (it is not "gated by the umbrella").
 *
 * The regression case asserts against a LITERAL copy of the shipped map, taken
 * before the constant was rewritten. Comparing the derivation with
 * `CAPABILITY_FOR_TOOL` after the rewrite would compare the function with
 * itself and prove nothing.
 */
import { describe, expect, it } from 'vitest';
import { capabilityForTool, HELPDESK_ALLOWLIST_CAPABILITY } from './capabilityMap';
import { CAPABILITY_FOR_TOOL, identityOffboardingRecipe } from './identityOffboarding';
import type { CapabilityRequirement } from './types';

function recipeWith(requires: CapabilityRequirement[]) {
  return { requires };
}

/** `CAPABILITY_FOR_TOOL` as shipped by R1 (identityOffboarding.ts), verbatim. */
const SHIPPED_OFFBOARDING_MAP: Readonly<Record<string, string>> = {
  google_set_vacation: 'google.tool.mail_settings',
  google_set_forwarding: 'google.tool.mail_settings',
  google_add_mail_delegate: 'google.tool.mail_settings',
  google_remove_from_group: 'google.tool.group_membership_write',
  google_remove_license: 'google.tool.license_write',
  google_account_wipe_mobile_device: 'google.tool.mobile_account_wipe',
  google_signout: 'google.tool.session_revoke',
  google_suspend_user: 'google.tool.suspend',
  m365_set_auto_reply: 'm365.graph.auto_reply',
  m365_remove_from_group: 'm365.graph.group_membership_write',
  m365_remove_license: 'm365.graph.license_write',
  m365_retire_intune_device: 'm365.graph.intune_retire',
  m365_revoke_sessions: 'm365.graph.session_revoke',
  m365_disable_user: 'm365.graph.user_disable',
};

describe('capabilityForTool', () => {
  it('exports the helpdesk umbrella key unchanged', () => {
    expect(HELPDESK_ALLOWLIST_CAPABILITY).toBe('agent.helpdesk.tool_allowlist');
  });

  it('maps each tool to the capability that names it', () => {
    const map = capabilityForTool(recipeWith([
      { key: 'p.groups', kind: 'permission_grant', provider: 'm365', detail: 'd', toolNames: ['m365_add_to_group'] },
      { key: 'p.licence', kind: 'permission_grant', provider: 'm365', detail: 'd', toolNames: ['m365_assign_license'] },
    ]));
    expect(map).toEqual({ m365_add_to_group: 'p.groups', m365_assign_license: 'p.licence' });
  });

  it('EXCLUDES the helpdesk umbrella by name, in either declaration order — a tool it alone names has no entry', () => {
    const umbrella: CapabilityRequirement = {
      key: HELPDESK_ALLOWLIST_CAPABILITY, kind: 'agent_tool', provider: null, detail: 'd',
      toolNames: ['m365_add_to_group', 'm365_assign_license'],
    };
    const groups: CapabilityRequirement = {
      key: 'p.groups', kind: 'permission_grant', provider: 'm365', detail: 'd', toolNames: ['m365_add_to_group'],
    };
    for (const requires of [[umbrella, groups], [groups, umbrella]]) {
      const map = capabilityForTool(recipeWith(requires));
      expect(map).toEqual({ m365_add_to_group: 'p.groups' });
      expect(Object.values(map)).not.toContain(HELPDESK_ALLOWLIST_CAPABILITY);
    }
  });

  it('does NOT exclude other agent_tool capabilities (Google tool families are agent_tool)', () => {
    const map = capabilityForTool(recipeWith([
      { key: 'google.tool.suspend', kind: 'agent_tool', provider: 'google', detail: 'd', toolNames: ['google_suspend_user'] },
    ]));
    expect(map).toEqual({ google_suspend_user: 'google.tool.suspend' });
  });

  it('ignores a capability that names no tool (a provider connection)', () => {
    const map = capabilityForTool(recipeWith([
      { key: 'm365.connection', kind: 'provider_connection', provider: 'm365', detail: 'd' },
    ]));
    expect(map).toEqual({});
  });

  it('is frozen, so a caller cannot mutate one recipe map and affect another', () => {
    const map = capabilityForTool(recipeWith([
      { key: 'k', kind: 'agent_tool', provider: null, detail: 'd', toolNames: ['t'] },
    ]));
    expect(Object.isFrozen(map)).toBe(true);
  });

  it('reproduces R1s shipped offboarding map exactly, and the offboarding constant is that derivation — the regression proof', () => {
    expect(capabilityForTool(identityOffboardingRecipe)).toEqual(SHIPPED_OFFBOARDING_MAP);
    expect(CAPABILITY_FOR_TOOL).toEqual(SHIPPED_OFFBOARDING_MAP);
    expect(Object.keys(CAPABILITY_FOR_TOOL)).toEqual(Object.keys(SHIPPED_OFFBOARDING_MAP));
    expect(Object.isFrozen(CAPABILITY_FOR_TOOL)).toBe(true);
  });
});
