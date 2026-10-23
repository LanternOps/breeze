/**
 * Recipe readiness (spec §4.1, D-R1-12) — the pure half, as a table.
 *
 * `setup_required` means "something this tenant can fix". Unsatisfied
 * capabilities are partitioned by `availability`: `tenant_fixable` → `missing`
 * (drives the badge), `always_manual` → `alwaysManualCapabilities` (never
 * blocks). Both degrade their effects to human work identically. Only a
 * missing provider connection (or a flag) makes a recipe `unavailable`.
 *
 * No profile version literal appears here: stale/current are derived from
 * `M365_PERMISSION_PROFILES['customer-graph-actions']`.
 */
import { describe, expect, it, vi } from 'vitest';
import { M365_PERMISSION_PROFILES, type CanonicalAppRoleAssignment } from '@breeze/shared/m365';

vi.mock('../../db', () => ({
  db: new Proxy({}, { get() { throw new Error('the pure half touched the database'); } }),
  runOutsideDbContext: () => { throw new Error('no db'); },
  withSystemDbAccessContext: () => { throw new Error('no db'); },
}));

import { computeRecipeReadiness, degradedEffectTools, type ReadinessInputs } from './recipeReadiness';
import {
  IDENTITY_OFFBOARDING_CAPABILITIES,
  IDENTITY_OFFBOARDING_EFFECT_TOOLS,
  identityOffboardingRecipe,
} from './recipes/identityOffboarding';
import { serviceRecoveryRecipe } from './recipes/serviceRecovery';
import type { AnyRecipeDefinition } from './recipes/types';

const recipe = identityOffboardingRecipe as unknown as AnyRecipeDefinition;
const PROFILE = M365_PERMISSION_PROFILES['customer-graph-actions'];
const ALL_GRANTS: CanonicalAppRoleAssignment[] = [...(PROFILE.applicationPermissionAssignments ?? [])];
const EXCHANGE = ['m365.exchange.forwarding', 'm365.exchange.mailbox_delegate', 'm365.exchange.shared_mailbox_conversion'];

function inputs(over: Partial<ReadinessInputs> = {}): ReadinessInputs {
  return {
    orgId: 'org-1',
    m365: { status: 'active', permissionManifestVersion: PROFILE.version, observedGrants: ALL_GRANTS, grantsVerifiedAt: new Date() },
    google: { status: 'active', lastVerifiedAt: new Date() },
    agent: { id: 'agent-1', kind: 'helpdesk', toolAllowlist: [...IDENTITY_OFFBOARDING_EFFECT_TOOLS] },
    flagEnabled: true,
    ...over,
  };
}

describe('computeRecipeReadiness', () => {
  it('1. flag off → unavailable, and no gaps of either kind are reported', () => {
    const r = computeRecipeReadiness(recipe, inputs({ flagEnabled: false }));
    expect(r.readiness).toBe('unavailable');
    expect(r.missing).toEqual([]);
    expect(r.alwaysManualCapabilities).toEqual([]);
    expect(r.manualStepCount).toBe(0);
    expect(r.degradedEffects).toEqual([]);
  });

  it('2. no connections at all → unavailable, both provider capabilities missing and NOT degradable', () => {
    const r = computeRecipeReadiness(recipe, inputs({ m365: null, google: null }));
    expect(r.readiness).toBe('unavailable');
    const providers = r.missing.filter((m) => m.kind === 'provider_connection');
    expect(providers.map((p) => p.key).sort()).toEqual(['google.workspace.connection', 'm365.connection']);
    for (const p of providers) expect(p.degradesToHumanWork).toBe(false);
    expect(providers.find((p) => p.key === 'm365.connection')!.action.kind).toBe('connect_m365');
    expect(providers.find((p) => p.key === 'google.workspace.connection')!.action.kind).toBe('connect_google');
  });

  it('3. Google active, no M365 → setup_required, degraded BY PROVIDER (every m365_* tool, no google_* tool)', () => {
    const r = computeRecipeReadiness(recipe, inputs({ m365: null }));
    expect(r.readiness).toBe('setup_required');
    const fixableM365 = IDENTITY_OFFBOARDING_CAPABILITIES
      .filter((c) => c.provider === 'm365' && (c.availability ?? 'tenant_fixable') === 'tenant_fixable').map((c) => c.key);
    for (const k of fixableM365) expect(r.missing.map((m) => m.key)).toContain(k);
    const m365Tools = IDENTITY_OFFBOARDING_EFFECT_TOOLS.filter((t) => t.startsWith('m365_'));
    expect([...r.degradedEffects].sort()).toEqual([...m365Tools].sort());
    for (const m of r.missing.filter((x) => x.kind !== 'provider_connection')) expect(m.degradesToHumanWork).toBe(true);
  });

  it('4. M365 on a STALE manifest → setup_required with reconsent; roles the stale grant set holds stay satisfied', () => {
    const stale = ALL_GRANTS.filter((g) => g.value === 'User.ReadWrite.All' || g.value === 'User-PasswordProfile.ReadWrite.All');
    const r = computeRecipeReadiness(recipe, inputs({
      m365: { status: 'active', permissionManifestVersion: PROFILE.version - 1, observedGrants: stale, grantsVerifiedAt: new Date() },
    }));
    expect(r.readiness).toBe('setup_required');
    const missingGrants = r.missing.filter((m) => m.kind === 'permission_grant');
    expect(missingGrants.map((m) => m.key).sort()).toEqual([
      'm365.graph.auto_reply', 'm365.graph.group_membership_write', 'm365.graph.intune_retire', 'm365.graph.session_revoke',
    ]);
    for (const m of missingGrants) expect(m.action.kind).toBe('reconsent_m365');
    expect(r.capabilityReadiness['m365.graph.user_disable']).toBe(true);
    expect(r.capabilityReadiness['m365.graph.license_write']).toBe(true);
    expect(r.degradedEffects).toContain('m365_set_auto_reply');
    expect(r.degradedEffects).not.toContain('m365_disable_user');
  });

  it('4b. a connection whose grants were never verified degrades every Graph effect (fail closed)', () => {
    const r = computeRecipeReadiness(recipe, inputs({
      m365: { status: 'active', permissionManifestVersion: PROFILE.version, observedGrants: ALL_GRANTS, grantsVerifiedAt: null },
    }));
    expect(r.readiness).toBe('setup_required');
    for (const t of IDENTITY_OFFBOARDING_EFFECT_TOOLS.filter((x) => x.startsWith('m365_'))) expect(r.degradedEffects).toContain(t);
  });

  it('5. both active, current profile, full grants, complete allowlist → READY with 3 steps by hand', () => {
    const r = computeRecipeReadiness(recipe, inputs());
    expect(r.readiness).toBe('ready');
    expect(r.missing).toEqual([]);
    expect(r.alwaysManualCapabilities.map((c) => c.key).sort()).toEqual([...EXCHANGE].sort());
    expect(r.manualStepCount).toBe(3);
    for (const c of r.alwaysManualCapabilities) {
      expect(c.availability).toBe('always_manual');
      expect(c.degradesToHumanWork).toBe(true);
      expect(c.action.kind).toBe('none');
    }
    expect(r.degradedEffects).toEqual([]);
  });

  it('6. always_manual never blocks and tenant_fixable always does — the discriminating pair', () => {
    const oneFixableDown = computeRecipeReadiness(recipe, inputs({
      agent: { id: 'agent-1', kind: 'helpdesk', toolAllowlist: IDENTITY_OFFBOARDING_EFFECT_TOOLS.filter((t) => t !== 'google_signout') },
    }));
    expect(oneFixableDown.readiness).toBe('setup_required');

    // A fourth capability reclassified always_manual in a LOCAL fixture: the
    // state returns to ready and the count becomes 4. Without this half, a
    // function that ignored the Exchange keys BY NAME would pass every case.
    const fixture = {
      ...recipe,
      requires: recipe.requires.map((c) => (c.key === 'google.tool.session_revoke' || c.key === 'agent.helpdesk.tool_allowlist'
        ? { ...c, availability: 'always_manual' as const } : c)),
    } as AnyRecipeDefinition;
    const reclassified = computeRecipeReadiness(fixture, inputs({
      agent: { id: 'agent-1', kind: 'helpdesk', toolAllowlist: IDENTITY_OFFBOARDING_EFFECT_TOOLS.filter((t) => t !== 'google_signout') },
    }));
    expect(reclassified.readiness).toBe('ready');
    expect(reclassified.manualStepCount).toBe(5);
    expect(reclassified.degradedEffects).toEqual(['google_signout']);
  });

  it('7. agent missing one tool → that tool alone degraded, in missing, action names the exact subset and the agent', () => {
    const r = computeRecipeReadiness(recipe, inputs({
      agent: { id: 'agent-1', kind: 'helpdesk', toolAllowlist: IDENTITY_OFFBOARDING_EFFECT_TOOLS.filter((t) => t !== 'm365_disable_user') },
    }));
    expect(r.degradedEffects).toEqual(['m365_disable_user']);
    const umbrella = r.missing.find((m) => m.key === 'agent.helpdesk.tool_allowlist')!;
    expect(umbrella.availability).toBe('tenant_fixable');
    expect(umbrella.action).toMatchObject({ kind: 'add_agent_tools', toolNames: ['m365_disable_user'], agentId: 'agent-1' });
  });

  it('7b. a bare tool:action allowlist entry does NOT satisfy a bare tool requirement it does not name', () => {
    const r = computeRecipeReadiness(recipe, inputs({
      agent: { id: 'agent-1', kind: 'helpdesk', toolAllowlist: [...IDENTITY_OFFBOARDING_EFFECT_TOOLS.filter((t) => t !== 'google_signout'), 'google_signout:x'] },
    }));
    expect(r.degradedEffects).toContain('google_signout');
  });

  it('8. no agent at all → every agent_tool capability missing, agentId null, kind still add_agent_tools', () => {
    const r = computeRecipeReadiness(recipe, inputs({ agent: null }));
    const agentCaps = r.missing.filter((m) => m.kind === 'agent_tool');
    expect(agentCaps.length).toBe(IDENTITY_OFFBOARDING_CAPABILITIES.filter((c) => c.kind === 'agent_tool').length);
    for (const c of agentCaps) {
      expect(c.action.kind).toBe('add_agent_tools');
      expect(c.action.agentId).toBeNull();
    }
    expect([...r.degradedEffects].sort()).toEqual([...IDENTITY_OFFBOARDING_EFFECT_TOOLS].sort());
  });

  it('9. a degraded M365 connection is NOT usable — every M365 capability is missing', () => {
    const r = computeRecipeReadiness(recipe, inputs({
      m365: { status: 'degraded', permissionManifestVersion: PROFILE.version, observedGrants: ALL_GRANTS, grantsVerifiedAt: new Date() },
    }));
    for (const c of IDENTITY_OFFBOARDING_CAPABILITIES.filter((x) => x.provider === 'm365')) {
      expect(r.capabilityReadiness[c.key], c.key).toBe(false);
    }
    expect(r.readiness).toBe('setup_required');
  });

  it('10. capabilityReadiness has EVERY requires key; missing ∪ alwaysManual is exactly the unsatisfied set, no overlap', () => {
    for (const over of [{}, { m365: null }, { agent: null }, { google: null, m365: null }] as Partial<ReadinessInputs>[]) {
      const r = computeRecipeReadiness(recipe, inputs(over));
      expect(Object.keys(r.capabilityReadiness).sort()).toEqual(recipe.requires.map((c) => c.key).sort());
      const unsatisfied = Object.entries(r.capabilityReadiness).filter(([, v]) => !v).map(([k]) => k).sort();
      const reported = [...r.missing, ...r.alwaysManualCapabilities].map((m) => m.key);
      expect(new Set(reported).size).toBe(reported.length);
      expect([...reported].sort()).toEqual(unsatisfied);
    }
  });

  it('11. service_recovery (no requires) is ready whenever its flag is on — nothing special-cases identity', () => {
    const r = computeRecipeReadiness(serviceRecoveryRecipe as unknown as AnyRecipeDefinition, inputs({ m365: null, google: null, agent: null }));
    expect(r.readiness).toBe('ready');
    expect(r.manualStepCount).toBe(0);
    expect(r.missing).toEqual([]);
    expect(computeRecipeReadiness(serviceRecoveryRecipe as unknown as AnyRecipeDefinition, inputs({ flagEnabled: false })).readiness)
      .toBe('unavailable');
  });

  it('12. an UNCLASSIFIED capability (no availability) is tenant_fixable and therefore BLOCKS', () => {
    const fixture = {
      ...recipe,
      requires: [...recipe.requires, { key: 'fixture.unclassified', kind: 'tool_source', provider: 'm365', detail: 'x' }],
    } as AnyRecipeDefinition;
    const r = computeRecipeReadiness(fixture, inputs());
    expect(r.readiness).toBe('setup_required');
    expect(r.missing.map((m) => m.key)).toEqual(['fixture.unclassified']);
    expect(r.missing[0]!.availability).toBe('tenant_fixable');
  });

  it('caller verification degrades the gated tool to human work WITHOUT changing the badge', () => {
    const r = computeRecipeReadiness(recipe, inputs({ callerVerificationBlocked: ['m365_disable_user', 'm365_reset_password'] }));
    expect(r.readiness).toBe('ready');
    expect(r.missing).toEqual([]);
    expect(r.degradedEffects).toEqual(['m365_disable_user']);
    // Only tools the recipe actually uses are reported.
    expect(r.callerVerificationBlocked).toEqual(['m365_disable_user']);
    expect(r.capabilityReadiness['m365.graph.user_disable']).toBe(true);
  });

  it('degradedEffectTools returns the readiness degraded set', () => {
    const r = computeRecipeReadiness(recipe, inputs({ m365: null }));
    expect(degradedEffectTools(r)).toEqual(r.degradedEffects);
  });
});
