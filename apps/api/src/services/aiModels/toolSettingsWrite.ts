/**
 * The tool profile write path (#11398 W05): what an operator may store on a
 * model record — the tool profile, its `custom` allow-list and the context
 * window override — validated against the MERGED stored + patch state, and
 * the drawer's view of what each surface resolves to.
 *
 * Rules (each a 422 from `validateToolSettingsPatch`):
 *  1. `custom` ⇔ allow-list on the merged state (the DB CHECK
 *     `partner_ai_models_tool_allowlist_chk` would otherwise fail the write).
 *  2. Every custom tool name is declared on at least one profiled surface.
 *  3. The override is accepted on BYO OpenAI-compatible (gateway) models only:
 *     nothing else reads it (`resolveEffectiveContextWindow` is gateway-only).
 *  4. Surface floors: the write must not make a surface this model serves
 *     lose a tool it requires (`SURFACE_REQUIRED_TOOLS`, the troubleshooting
 *     run's `execute_command`/`run_script`). Judged on the profile each
 *     served surface RESOLVES to after the write (an override can move `auto`
 *     down), and only gaps this write introduces count: a gap that already
 *     exists (a discovered window made it) never blocks an unrelated edit.
 *     The runtime check (`finalizeSessionToolExposure`, `applyRunToolProfile`)
 *     still refuses at session start for every other route into a gap (a
 *     later assignment, a newly discovered window).
 *
 * Exposure only: nothing here touches RBAC, approvals, guardrails or
 * `guardrailPolicy.toolAllowlist`.
 *
 * The tool catalog is injected (`ToolProfileCatalog`): the registries it
 * reads (aiAgentSdkTools, scriptBuilderTools, clientAiTools) must stay out of
 * the worker's import closure, so only the routes build it
 * (`toolProfileCatalog.ts`).
 */
import { and, eq, isNull, or, sql } from 'drizzle-orm';
import {
  AI_TOOL_PROFILED_SURFACES,
  isConfigurableAiSurface,
  type AiOfferingToolProfileDto,
  type AiOfferingToolSurfaceDto,
  type AiToolAllowlist,
  type AiToolDomain,
  type AiToolProfile,
  type OfferingDetailsPatch,
} from '@breeze/shared';
import { db } from '../../db';
import { aiAgents, aiModelAssignments } from '../../db/schema';
import { outcomeToolsForRun } from '../aiAgents/outcomeTools';
import { resolveEffectiveContextWindow, type ContextWindowFields } from './contextWindowFacts';
import { RegistryWriteError } from './registryWriteErrors';
import { checkSurfaceCoverage, type RunFloorRef } from './surfaceRequiredTools';
import { effectiveToolProfile, resolveToolExposure } from './toolExposure';
import { toolProfileFactsFrom, type ToolProfileFacts } from './toolProfileFacts';
import { PROFILE_PREFIX_TOKENS, type ProfiledSurface } from './toolProfiles';

export interface ToolProfileCatalog {
  /** Every bare tool name a surface declares (env-gated tools included). */
  surfaceNames(surface: ProfiledSurface): ReadonlySet<string>;
  /** A registry tool's domain, for a `custom` allow-list's domains. */
  domainOf(name: string): AiToolDomain | undefined;
}

/** The offering columns this module reads. */
export interface StoredToolSettings extends ContextWindowFields {
  toolProfile: AiToolProfile;
  toolAllowlist: AiToolAllowlist | null;
}

/** The profiled surfaces a model serves now, and whether troubleshooting runs can reach it. */
export interface ServedToolSurfaces {
  surfaces: ReadonlySet<ProfiledSurface>;
  /** A device-troubleshooting run can resolve this model (its floor applies on `ai_agents`). */
  troubleshootingRuns: boolean;
}

export type ToolSettingsColumns = Partial<{
  toolProfile: AiToolProfile;
  toolAllowlist: AiToolAllowlist | null;
  contextWindowOverride: number | null;
}>;

const SURFACE_LABELS: Readonly<Record<ProfiledSurface, string>> = {
  chat: 'chat',
  helper: 'helper',
  script_builder: 'script builder',
  ai_agents: 'AI agents',
  office_chat: 'Office add-in',
};

const TROUBLESHOOTING_RUN: RunFloorRef = { profile: 'device_troubleshooting' };

export function hasToolSettings(patch: OfferingDetailsPatch): boolean {
  return patch.toolProfile !== undefined || patch.toolAllowlist !== undefined || patch.contextWindowOverride !== undefined;
}

function normalizedAllowlist(a: AiToolAllowlist): AiToolAllowlist {
  return { domains: [...new Set(a.domains)].sort(), tools: [...new Set(a.tools)].sort() };
}

/**
 * The required tools a surface would lack under these facts; [] when the
 * profile is the identity (`full`) or the surface keeps them all. A
 * `too_small` surface is judged on `minimal` (what `auto` falls back to), but
 * it refuses on the window anyway.
 */
export function missingRequiredTools(
  facts: ToolProfileFacts,
  surface: ProfiledSurface,
  catalog: ToolProfileCatalog,
  opts: { troubleshootingRuns: boolean },
): string[] {
  if (effectiveToolProfile(facts, surface).profile === 'full') return [];
  if (surface === 'ai_agents' && !opts.troubleshootingRuns) return [];
  const run = surface === 'ai_agents' ? TROUBLESHOOTING_RUN : undefined;
  const exposure = resolveToolExposure({
    surface,
    facts,
    surfaceBaseSet: [...catalog.surfaceNames(surface)],
    // A run's outcome tools ride as extras that survive every profile.
    extraTools: run ? outcomeToolsForRun(run).map((name) => ({ name, domain: null, alwaysKeep: true })) : [],
  }, { domainOf: catalog.domainOf });
  const coverage = checkSurfaceCoverage(surface, exposure, run);
  return coverage.ok ? [] : coverage.missing;
}

function underpoweredMessage(gaps: ReadonlyArray<{ surface: ProfiledSurface; missing: string[] }>): string {
  const parts = gaps.map((g) => `the ${SURFACE_LABELS[g.surface]} needs ${g.missing.join(', ')}`);
  return `This tool profile drops tools a feature using this model requires: ${parts.join('; ')}. `
    + 'Choose a larger profile, add those tools to the custom list, or assign another model to that feature first.';
}

export function validateToolSettingsPatch(input: {
  stored: StoredToolSettings;
  patch: OfferingDetailsPatch;
  /** The gateway connection's current config_version; null for platform / Anthropic / catalog models. */
  gateway: { configVersion: number } | null;
  served: ServedToolSurfaces;
  catalog: ToolProfileCatalog;
}): ToolSettingsColumns {
  const { stored, patch, gateway, served, catalog } = input;
  const out: ToolSettingsColumns = {};
  if (!hasToolSettings(patch)) return out;

  // 1. custom ⇔ allow-list, on the merged state.
  const profile = patch.toolProfile ?? stored.toolProfile;
  const allowlist = patch.toolAllowlist !== undefined
    ? (patch.toolAllowlist === null ? null : normalizedAllowlist(patch.toolAllowlist))
    : stored.toolAllowlist;
  if (profile === 'custom' && allowlist === null) {
    throw new RegistryWriteError('A custom tool profile needs a list of tool areas or tools.', 'invalid', 422,
      { field: 'toolAllowlist', reason: 'custom_requires_allowlist' });
  }
  if (profile !== 'custom' && allowlist !== null) {
    throw new RegistryWriteError('Only a custom tool profile carries a tool list. Clear the list when choosing another profile.', 'invalid', 422,
      { field: 'toolAllowlist', reason: 'allowlist_requires_custom' });
  }

  // 2. Every custom name is declared somewhere.
  if (patch.toolAllowlist) {
    const known = (name: string) => AI_TOOL_PROFILED_SURFACES.some((s) => catalog.surfaceNames(s).has(name));
    const unknownTools = allowlist!.tools.filter((name) => !known(name));
    if (unknownTools.length > 0) {
      throw new RegistryWriteError(`Unknown tool${unknownTools.length > 1 ? 's' : ''}: ${unknownTools.join(', ')}.`, 'invalid', 422,
        { field: 'toolAllowlist', unknownTools });
    }
  }

  // 3. The override only means something on a gateway model.
  if (patch.contextWindowOverride !== undefined && patch.contextWindowOverride !== null && gateway === null) {
    throw new RegistryWriteError(
      'A context window can only be set on a model served by your own OpenAI-compatible endpoint.', 'invalid', 422,
      { field: 'contextWindowOverride', reason: 'gateway_only' },
    );
  }

  // 4. Floors on every served surface, judged on what each resolves to; only new gaps count.
  const override = patch.contextWindowOverride !== undefined ? patch.contextWindowOverride : (stored.contextWindowOverride ?? null);
  const transport = gateway ? 'gateway' : 'anthropic';
  const windowOf = (fields: ContextWindowFields) => (gateway ? resolveEffectiveContextWindow(fields, gateway.configVersion).value : null);
  const before = toolProfileFactsFrom(stored, transport, windowOf(stored));
  const after: ToolProfileFacts = {
    toolProfile: profile,
    toolAllowlist: allowlist,
    effectiveWindow: windowOf({ ...stored, contextWindowOverride: override }),
    transport,
  };
  const gaps: Array<{ surface: ProfiledSurface; missing: string[] }> = [];
  for (const surface of AI_TOOL_PROFILED_SURFACES) {
    if (!served.surfaces.has(surface)) continue;
    const opts = { troubleshootingRuns: served.troubleshootingRuns };
    const had = new Set(missingRequiredTools(before, surface, catalog, opts));
    const missing = missingRequiredTools(after, surface, catalog, opts).filter((name) => !had.has(name));
    if (missing.length > 0) gaps.push({ surface, missing });
  }
  if (gaps.length > 0) {
    const field = patch.toolProfile !== undefined || patch.toolAllowlist !== undefined ? 'toolProfile' : 'contextWindowOverride';
    throw new RegistryWriteError(underpoweredMessage(gaps), 'tool_profile_underpowered', 422, { field, surfaces: gaps });
  }

  if (patch.toolProfile !== undefined) out.toolProfile = patch.toolProfile;
  if (patch.toolAllowlist !== undefined) out.toolAllowlist = allowlist;
  if (patch.contextWindowOverride !== undefined) out.contextWindowOverride = patch.contextWindowOverride;
  return out;
}

function reasonFor(facts: ToolProfileFacts, surface: ProfiledSurface): AiOfferingToolSurfaceDto['reason'] {
  if (facts.toolProfile !== 'auto') return 'explicit';
  if (Object.values(PROFILE_PREFIX_TOKENS[surface]).some((v) => v === null)) return 'auto_unmeasured';
  return facts.effectiveWindow === null ? 'auto_unknown_window' : 'auto_window';
}

/** The drawer's "Tools and context" facts for one offering (#11398). */
export function buildToolProfileDto(
  stored: StoredToolSettings,
  opts: { effectiveWindow: number | null; gateway: boolean; catalog: ToolProfileCatalog; troubleshootingRuns: boolean },
): AiOfferingToolProfileDto {
  const facts = toolProfileFactsFrom(stored, opts.gateway ? 'gateway' : 'anthropic', opts.effectiveWindow);
  const surfaces = AI_TOOL_PROFILED_SURFACES.map((surface): AiOfferingToolSurfaceDto => {
    const { profile, tooSmall } = effectiveToolProfile(facts, surface);
    const auto = facts.effectiveWindow === null ? null : effectiveToolProfile({ ...facts, toolProfile: 'auto', toolAllowlist: null }, surface);
    return {
      surface,
      resolved: tooSmall ? 'too_small' : profile,
      autoProfile: auto === null ? null : auto.tooSmall ? 'too_small' : (auto.profile as 'full' | 'standard' | 'minimal'),
      reason: reasonFor(facts, surface),
      missingRequired: tooSmall ? [] : missingRequiredTools(facts, surface, opts.catalog, { troubleshootingRuns: opts.troubleshootingRuns }),
    };
  });
  const declared = (name: string) => AI_TOOL_PROFILED_SURFACES.some((s) => opts.catalog.surfaceNames(s).has(name));
  return {
    profile: facts.toolProfile,
    allowlist: facts.toolAllowlist,
    surfaces,
    droppedCustomNames: (facts.toolAllowlist?.tools ?? []).filter((name) => !declared(name)).sort(),
    windowOverrideSupported: opts.gateway,
  };
}

const PROFILED = new Set<string>(AI_TOOL_PROFILED_SURFACES);
/** ai_agents assignment roles a device-troubleshooting run resolves through (agentModelRole: `analysis`, inheriting `default`). */
const TROUBLESHOOTING_ROLES = new Set(['default', 'analysis']);

/**
 * The profiled surfaces this model serves now: any assignment row (partner or
 * org) naming it as default, permitted or failover, plus agents pinned to it.
 * Runs in the ambient (system, registry-locked) transaction of the write.
 */
export async function loadServedToolSurfaces(partnerId: string, offeringId: string): Promise<ServedToolSurfaces> {
  // Sequential: both run on the write's one transaction connection.
  const rows = await db.select({ surface: aiModelAssignments.surface, role: aiModelAssignments.role })
      .from(aiModelAssignments)
      .where(and(
        eq(aiModelAssignments.offeringPartnerId, partnerId),
        or(
          eq(aiModelAssignments.defaultOfferingId, offeringId),
          sql`${offeringId}::uuid = ANY(${aiModelAssignments.permittedOfferingIds})`,
          sql`${offeringId}::uuid = ANY(${aiModelAssignments.fallbackOfferingIds})`,
        ),
      ));
  const agents = await db.select({ kind: aiAgents.kind })
    .from(aiAgents)
    .where(and(eq(aiAgents.offeringPartnerId, partnerId), eq(aiAgents.offeringId, offeringId), isNull(aiAgents.disabledAt)));
  const surfaces = new Set<ProfiledSurface>();
  let troubleshootingRuns = false;
  for (const r of rows) {
    if (!isConfigurableAiSurface(r.surface) || !PROFILED.has(r.surface)) continue;
    surfaces.add(r.surface as ProfiledSurface);
    if (r.surface === 'ai_agents' && TROUBLESHOOTING_ROLES.has(r.role)) troubleshootingRuns = true;
  }
  if (agents.length > 0) surfaces.add('ai_agents');
  if (agents.some((a) => a.kind === 'troubleshoot')) troubleshootingRuns = true;
  return { surfaces, troubleshootingRuns };
}
