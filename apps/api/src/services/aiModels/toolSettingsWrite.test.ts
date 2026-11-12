import { describe, expect, it } from 'vitest';
import type { AiToolDomain, OfferingDetailsPatch } from '@breeze/shared';
import { RegistryWriteError } from './registryWriteErrors';
import { CHAT_MINIMAL_TOOLS, CHAT_STANDARD_TOOLS, CURATED_PROFILES, type ProfiledSurface } from './toolProfiles';
import {
  buildToolProfileDto,
  hasToolSettings,
  validateToolSettingsPatch,
  type StoredToolSettings,
  type ToolProfileCatalog,
} from './toolSettingsWrite';

/**
 * A fake catalog: the registry is the curated chat/helper/agent names plus a
 * few others; the script builder and Office have their own names. Domains are
 * explicit so `custom` domain matching is deterministic.
 */
const REGISTRY = new Set<string>([
  ...CHAT_STANDARD_TOOLS, 'set_device_context', 'propose_action_plan', 'execute_command', 'run_script', 'manage_users',
]);
const SCRIPT_BUILDER = new Set<string>(CURATED_PROFILES.script_builder.standard);
const OFFICE = new Set<string>(CURATED_PROFILES.office_chat.standard);
const DOMAINS: Record<string, AiToolDomain> = { query_devices: 'devices', get_device_details: 'devices', execute_command: 'scripts', run_script: 'scripts' };
const catalog: ToolProfileCatalog = {
  surfaceNames: (s: ProfiledSurface) => (s === 'script_builder' ? SCRIPT_BUILDER : s === 'office_chat' ? OFFICE : REGISTRY),
  domainOf: (name) => DOMAINS[name],
};

const AT = '2026-11-12T10:00:00.000Z';
const stored = (over: Partial<StoredToolSettings> = {}): StoredToolSettings => ({
  toolProfile: 'auto', toolAllowlist: null, contextWindowOverride: null, contextWindowDiscovered: null,
  contextWindowObserved: null, contextWindowObservedAt: null, contextWindowObservedConfigVersion: null, ...over,
});
const patch = (over: Partial<OfferingDetailsPatch>): OfferingDetailsPatch => ({ expectedUpdatedAt: AT, ...over });
const GATEWAY = { configVersion: 3 };
const NOTHING_SERVED = { surfaces: new Set<ProfiledSurface>(), troubleshootingRuns: false };
const serving = (...surfaces: ProfiledSurface[]) => ({ surfaces: new Set(surfaces), troubleshootingRuns: false });

function refusal(fn: () => unknown): RegistryWriteError {
  try {
    fn();
  } catch (e) {
    if (e instanceof RegistryWriteError) return e;
    throw e;
  }
  throw new Error('expected a RegistryWriteError');
}

describe('hasToolSettings', () => {
  it('is true only when the patch carries a tool field', () => {
    expect(hasToolSettings(patch({ displayName: 'x' }))).toBe(false);
    expect(hasToolSettings(patch({ toolProfile: 'standard' }))).toBe(true);
    expect(hasToolSettings(patch({ toolAllowlist: null }))).toBe(true);
    expect(hasToolSettings(patch({ contextWindowOverride: null }))).toBe(true);
  });
});

describe('validateToolSettingsPatch: custom ⇔ allow-list over the merged state', () => {
  const run = (s: StoredToolSettings, p: OfferingDetailsPatch) =>
    validateToolSettingsPatch({ stored: s, patch: p, gateway: GATEWAY, served: NOTHING_SERVED, catalog });

  it('patch { toolProfile: custom } alone against a stored null allow-list → 422', () => {
    const e = refusal(() => run(stored(), patch({ toolProfile: 'custom' })));
    expect(e.status).toBe(422);
    expect(e.details).toMatchObject({ field: 'toolAllowlist', reason: 'custom_requires_allowlist' });
  });

  it('patch { toolAllowlist } alone against stored standard → 422', () => {
    const e = refusal(() => run(stored({ toolProfile: 'standard' }), patch({ toolAllowlist: { domains: ['devices'], tools: [] } })));
    expect(e.status).toBe(422);
    expect(e.details).toMatchObject({ field: 'toolAllowlist', reason: 'allowlist_requires_custom' });
  });

  it('switching custom → standard without clearing the stored allow-list → 422', () => {
    const e = refusal(() => run(stored({ toolProfile: 'custom', toolAllowlist: { domains: ['devices'], tools: [] } }), patch({ toolProfile: 'standard' })));
    expect(e.details).toMatchObject({ field: 'toolAllowlist', reason: 'allowlist_requires_custom' });
  });

  it('both together succeed, and only the patched columns are returned', () => {
    expect(run(stored(), patch({ toolProfile: 'custom', toolAllowlist: { domains: ['devices'], tools: ['search_logs'] } })))
      .toEqual({ toolProfile: 'custom', toolAllowlist: { domains: ['devices'], tools: ['search_logs'] } });
    expect(run(stored({ toolProfile: 'custom', toolAllowlist: { domains: ['devices'], tools: [] } }), patch({ toolProfile: 'standard', toolAllowlist: null })))
      .toEqual({ toolProfile: 'standard', toolAllowlist: null });
  });

  it('editing only the allow-list of a stored custom profile succeeds', () => {
    expect(run(stored({ toolProfile: 'custom', toolAllowlist: { domains: ['devices'], tools: [] } }), patch({ toolAllowlist: { domains: [], tools: ['search_logs'] } })))
      .toEqual({ toolAllowlist: { domains: [], tools: ['search_logs'] } });
  });

  it('dedupes and sorts the stored allow-list', () => {
    expect(run(stored(), patch({ toolProfile: 'custom', toolAllowlist: { domains: ['devices', 'devices'], tools: ['search_logs', 'query_devices', 'search_logs'] } })))
      .toEqual({ toolProfile: 'custom', toolAllowlist: { domains: ['devices'], tools: ['query_devices', 'search_logs'] } });
  });
});

describe('validateToolSettingsPatch: tool names', () => {
  const run = (p: OfferingDetailsPatch) =>
    validateToolSettingsPatch({ stored: stored(), patch: p, gateway: GATEWAY, served: NOTHING_SERVED, catalog });

  it('an undeclared custom name → 422 unknownTools (sorted)', () => {
    const e = refusal(() => run(patch({ toolProfile: 'custom', toolAllowlist: { domains: [], tools: ['search_logs', 'zz_nope', 'aa_nope'] } })));
    expect(e.status).toBe(422);
    expect(e.details).toEqual({ field: 'toolAllowlist', unknownTools: ['aa_nope', 'zz_nope'] });
  });

  it('a name declared on any one surface (script builder, Office) is known', () => {
    expect(() => run(patch({ toolProfile: 'custom', toolAllowlist: { domains: [], tools: ['apply_script_code', 'read_range'] } }))).not.toThrow();
  });
});

describe('validateToolSettingsPatch: context window override', () => {
  it('a non-null override on a non-gateway model → 422 gateway_only', () => {
    const e = refusal(() => validateToolSettingsPatch({
      stored: stored(), patch: patch({ contextWindowOverride: 32768 }), gateway: null, served: NOTHING_SERVED, catalog,
    }));
    expect(e.status).toBe(422);
    expect(e.details).toEqual({ field: 'contextWindowOverride', reason: 'gateway_only' });
  });

  it('clearing the override is always allowed, gateway or not', () => {
    expect(validateToolSettingsPatch({ stored: stored(), patch: patch({ contextWindowOverride: null }), gateway: null, served: NOTHING_SERVED, catalog }))
      .toEqual({ contextWindowOverride: null });
  });

  it('a gateway override is returned as the column value', () => {
    expect(validateToolSettingsPatch({ stored: stored(), patch: patch({ contextWindowOverride: 32768 }), gateway: GATEWAY, served: NOTHING_SERVED, catalog }))
      .toEqual({ contextWindowOverride: 32768 });
  });
});

describe('validateToolSettingsPatch: surface floors (a profile never drops a tool a served surface requires)', () => {
  const run = (s: StoredToolSettings, p: OfferingDetailsPatch, served = serving()) =>
    validateToolSettingsPatch({ stored: s, patch: p, gateway: GATEWAY, served, catalog });

  it('minimal on a model that serves the script builder → 422 tool_profile_underpowered naming execute_script_on_device', () => {
    const e = refusal(() => run(stored(), patch({ toolProfile: 'minimal' }), serving('script_builder')));
    expect(e.status).toBe(422);
    expect(e.code).toBe('tool_profile_underpowered');
    expect(e.details).toEqual({ field: 'toolProfile', surfaces: [{ surface: 'script_builder', missing: ['execute_script_on_device'] }] });
    expect(e.message).toContain('script builder');
  });

  it('control: the same minimal profile on a model that does not serve the script builder is accepted', () => {
    expect(run(stored(), patch({ toolProfile: 'minimal' }), serving('chat', 'helper'))).toEqual({ toolProfile: 'minimal' });
  });

  it('standard keeps the script builder floor', () => {
    expect(run(stored(), patch({ toolProfile: 'standard' }), serving('script_builder'))).toEqual({ toolProfile: 'standard' });
  });

  it('custom without the script builder tools → 422 listing both; with them → accepted', () => {
    const e = refusal(() => run(stored(), patch({ toolProfile: 'custom', toolAllowlist: { domains: ['devices'], tools: [] } }), serving('script_builder')));
    expect(e.details).toEqual({ field: 'toolProfile', surfaces: [{ surface: 'script_builder', missing: ['execute_script_on_device', 'apply_script_code'] }] });
    expect(() => run(stored(), patch({
      toolProfile: 'custom', toolAllowlist: { domains: ['devices'], tools: ['execute_script_on_device', 'apply_script_code'] },
    }), serving('script_builder'))).not.toThrow();
  });

  it('chat never fails its floor: set_device_context survives every profile, incl. a custom list without it', () => {
    expect(() => run(stored(), patch({ toolProfile: 'minimal' }), serving('chat'))).not.toThrow();
    expect(() => run(stored(), patch({ toolProfile: 'custom', toolAllowlist: { domains: [], tools: ['search_logs'] } }), serving('chat'))).not.toThrow();
  });

  it('ai_agents with troubleshooting runs: minimal drops execute_command and run_script → 422', () => {
    const e = refusal(() => run(stored(), patch({ toolProfile: 'minimal' }), { surfaces: new Set<ProfiledSurface>(['ai_agents']), troubleshootingRuns: true }));
    expect(e.details).toEqual({ field: 'toolProfile', surfaces: [{ surface: 'ai_agents', missing: ['execute_command', 'run_script'] }] });
  });

  it('ai_agents without troubleshooting runs: outcome tools always survive, so minimal is accepted', () => {
    expect(() => run(stored(), patch({ toolProfile: 'minimal' }), serving('ai_agents'))).not.toThrow();
  });

  it('a custom domain keeps a required tool (domain scripts covers execute_command / run_script)', () => {
    expect(() => run(stored(), patch({ toolProfile: 'custom', toolAllowlist: { domains: ['scripts'], tools: [] } }),
      { surfaces: new Set<ProfiledSurface>(['ai_agents']), troubleshootingRuns: true })).not.toThrow();
  });

  it('an override that makes auto pick minimal for a served script builder → 422 (field contextWindowOverride)', () => {
    // 8,192 tokens: script builder auto → minimal (W02 threshold table).
    const e = refusal(() => run(stored(), patch({ contextWindowOverride: 8192 }), serving('script_builder')));
    expect(e.code).toBe('tool_profile_underpowered');
    expect(e.details).toMatchObject({ field: 'contextWindowOverride', surfaces: [{ surface: 'script_builder', missing: ['execute_script_on_device'] }] });
  });

  it('a gap that already exists is not blamed on this write: clearing an override is never refused by the floor', () => {
    // Stored state: auto + a discovered 8,192 window → the script builder is already underpowered.
    const s = stored({ contextWindowDiscovered: 8192, contextWindowOverride: 9000 });
    expect(run(s, patch({ contextWindowOverride: null }), serving('script_builder'))).toEqual({ contextWindowOverride: null });
  });

  it('reports every served surface that loses a floor, in surface order', () => {
    const e = refusal(() => run(stored(), patch({ toolProfile: 'minimal' }),
      { surfaces: new Set<ProfiledSurface>(['script_builder', 'ai_agents', 'chat']), troubleshootingRuns: true }));
    expect((e.details as { surfaces: Array<{ surface: string }> }).surfaces.map((s) => s.surface)).toEqual(['script_builder', 'ai_agents']);
  });
});

describe('buildToolProfileDto', () => {
  it('auto with an unknown window: every surface full, reason auto_unknown_window (Office: auto_unmeasured)', () => {
    const dto = buildToolProfileDto(stored(), { effectiveWindow: null, gateway: true, catalog, troubleshootingRuns: true });
    expect(dto.profile).toBe('auto');
    expect(dto.windowOverrideSupported).toBe(true);
    expect(dto.surfaces.map((s) => [s.surface, s.resolved, s.reason])).toEqual([
      ['chat', 'full', 'auto_unknown_window'],
      ['helper', 'full', 'auto_unknown_window'],
      ['script_builder', 'full', 'auto_unknown_window'],
      ['ai_agents', 'full', 'auto_unknown_window'],
      ['office_chat', 'full', 'auto_unmeasured'],
    ]);
    expect(dto.surfaces.every((s) => s.missingRequired.length === 0)).toBe(true);
  });

  it('auto with an 8,192 window: chat minimal, the script builder minimal and missing execute_script_on_device', () => {
    const dto = buildToolProfileDto(stored(), { effectiveWindow: 8192, gateway: true, catalog, troubleshootingRuns: true });
    const by = Object.fromEntries(dto.surfaces.map((s) => [s.surface, s]));
    expect(by.chat).toMatchObject({ resolved: 'minimal', reason: 'auto_window', missingRequired: [] });
    expect(by.script_builder).toMatchObject({ resolved: 'minimal', missingRequired: ['execute_script_on_device'] });
    expect(by.ai_agents).toMatchObject({ resolved: 'minimal', missingRequired: ['execute_command', 'run_script'] });
  });

  it('autoProfile: what auto would pick at the known window, so an explicit profile that cannot fit is visible', () => {
    const dto = buildToolProfileDto(stored({ toolProfile: 'full' }), { effectiveWindow: 32_768, gateway: true, catalog, troubleshootingRuns: false });
    const by = Object.fromEntries(dto.surfaces.map((s) => [s.surface, s]));
    expect(by.chat).toMatchObject({ resolved: 'full', reason: 'explicit', autoProfile: 'standard' });
    expect(by.helper).toMatchObject({ autoProfile: 'full' });
    expect(by.office_chat).toMatchObject({ autoProfile: 'full' });
    const unknown = buildToolProfileDto(stored({ toolProfile: 'full' }), { effectiveWindow: null, gateway: true, catalog, troubleshootingRuns: false });
    expect(unknown.surfaces.every((s) => s.autoProfile === null)).toBe(true);
  });

  it('auto with a 4,096 window: too_small', () => {
    const dto = buildToolProfileDto(stored(), { effectiveWindow: 4096, gateway: true, catalog, troubleshootingRuns: false });
    expect(dto.surfaces.find((s) => s.surface === 'chat')).toMatchObject({ resolved: 'too_small', reason: 'auto_window' });
  });

  it('an explicit profile is explicit on every surface; a non-gateway model cannot take an override', () => {
    const dto = buildToolProfileDto(stored({ toolProfile: 'standard' }), { effectiveWindow: null, gateway: false, catalog, troubleshootingRuns: false });
    expect(dto.surfaces.every((s) => s.resolved === 'standard' && s.reason === 'explicit')).toBe(true);
    expect(dto.windowOverrideSupported).toBe(false);
  });

  it('droppedCustomNames: stored custom names no surface declares any more', () => {
    const dto = buildToolProfileDto(
      stored({ toolProfile: 'custom', toolAllowlist: { domains: [], tools: ['search_logs', 'retired_tool', 'read_range'] } }),
      { effectiveWindow: null, gateway: true, catalog, troubleshootingRuns: false },
    );
    expect(dto.droppedCustomNames).toEqual(['retired_tool']);
    expect(dto.allowlist).toEqual({ domains: [], tools: ['search_logs', 'retired_tool', 'read_range'] });
  });

  it('chat minimal is the curated 12 (sanity: the fake catalog carries them)', () => {
    expect(CHAT_MINIMAL_TOOLS.every((n) => REGISTRY.has(n))).toBe(true);
  });
});
