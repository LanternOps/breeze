/**
 * The advertised fixed prefix of a surface under a tool profile (#11393 W03
 * T9): what a gateway (OpenAI-compatible) upstream is sent before the first
 * user word, i.e. the system prompt plus every advertised tool schema, after
 * translation (and schema compaction when the exposure asks for it),
 * estimated as bytes / 3 like gateway/openai/adapter.ts. `PROFILE_PREFIX_TOKENS`
 * pins these numbers (toolProfiles.prefix.contract.test.ts); `auto` reads them.
 *
 * Every input comes from the production path, never re-typed: the exposure
 * from `finalizeSessionToolExposure` / `applyRunToolProfile`, the tools from
 * `breezeServerTools` / `scriptBuilderServerTools` (the lists the MCP servers
 * register), the schemas as the SDK's MCP server advertises them
 * (advertisedSchema.ts), the chat prompt from `composeConstrainedSystemPrompt`
 * / `composeStaticSystemPrompt`, the translation from
 * `translateMessagesRequest`. Not counted: the CLI's own per-request additions
 * (its environment block) and the per-user/page lines of the chat prompt,
 * which are the same for every profile.
 *
 * Offline and deterministic (no SDK child, no network): handlers are never
 * bound to anything that can run.
 */
import type { AiAgentRunProfile } from '@breeze/shared';
import { breezeServerTools, chatToolDomain, listChatSurfaceToolNames } from '../../aiAgentSdkTools';
import { applyRunToolProfile } from '../../aiAgents/runToolProfile';
import { buildOutcomeSdkTools } from '../../aiAgents/outcomeTools';
import { composeConstrainedSystemPrompt, composeStaticSystemPrompt } from '../../aiToolIndex';
import { allowedToolsUnder, finalizeSessionToolExposure, ToolProfileUnderpoweredError } from '../../aiModels/sessionToolExposure';
import { resolveToolExposure, type ToolExposure, type ToolProfileFacts } from '../../aiModels/toolExposure';
import type { ProfiledSurface } from '../../aiModels/toolProfiles';
import { translateMessagesRequest } from '../../aiModels/gateway/openai/translateRequest';
import { scriptBuilderServerTools } from '../../scriptBuilderTools';
import { buildTenantSdkTools, tenantMcpToolNames } from '../../toolSources/sdkBridge';
import type { SdkTool } from '../../aiAgents/outcomeTools';
import type { TenantToolDescriptor } from '../../toolSources/resolver';
import { advertisedTool } from './advertisedSchema';
import { getCaptureSystemPrompt } from './runSurface';
import { CAPTURE_SURFACES, type CaptureSurface, type CaptureSurfaceId } from './surfaces';

export type MeasuredProfile = 'minimal' | 'standard' | 'full';
const MEASURED_PROFILES: readonly MeasuredProfile[] = ['minimal', 'standard', 'full'];

/**
 * The capture surfaces each profiled surface is measured on. A surface whose
 * prompt or tool set varies (helper level, agent run profile) pins the LARGEST
 * of its variants, so `auto` never picks a profile that one variant cannot fit.
 * Office is not measured yet: its prefixes stay null and `auto` keeps it `full`.
 */
export const PREFIX_SURFACE_SOURCES: Readonly<Partial<Record<ProfiledSurface, readonly CaptureSurfaceId[]>>> = Object.freeze({
  chat: ['chat'],
  helper: ['helper-basic', 'helper-standard', 'helper-extended'],
  script_builder: ['script-builder'],
  ai_agents: ['agent-full-remediation', 'agent-analysis'],
});

const deny = (): never => { throw new Error('advertisedPrefix: handlers never run'); };
const denyPreToolUse = async () => ({ allowed: false as const, error: 'advertisedPrefix: execution disabled' });

/** Facts for a gateway offering on an explicit profile (the transport `auto` is live on). */
export function gatewayFacts(profile: MeasuredProfile): ToolProfileFacts {
  return { toolProfile: profile, toolAllowlist: null, effectiveWindow: null, transport: 'gateway' };
}

function profiledSurfaceOf(surface: CaptureSurface): 'chat' | 'helper' | 'script_builder' | 'ai_agents' {
  if (surface.id === 'chat') return 'chat';
  if (surface.id === 'script-builder') return 'script_builder';
  if (surface.agentProfile) return 'ai_agents';
  return 'helper';
}

export interface AdvertisedRequest {
  exposure: ToolExposure;
  system: string;
  tools: Array<{ name: string; description: string; input_schema: Record<string, unknown> }>;
  /** The tool list the surface's MCP server registers (handlers deny-bound), for an exposure-aware capture. */
  serverTools: SdkTool[];
  /** `query({ allowedTools })` under the exposure (MCP names). */
  allowedTools: string[];
}

function finish(surface: CaptureSurface, exposure: ToolExposure, system: string, serverTools: SdkTool[], baseAllowed: readonly string[]): AdvertisedRequest {
  return {
    exposure, system, serverTools,
    tools: serverTools.map((t) => advertisedTool(surface.mcpServerName, t)),
    allowedTools: allowedToolsUnder(exposure, baseAllowed) ?? [...baseAllowed],
  };
}

/**
 * The exposure, prompt and advertised tools a surface would send under
 * `profile` on a gateway connection, through the production resolvers.
 */
export function advertisedRequest(
  surface: CaptureSurface,
  profile: MeasuredProfile,
  opts: { tenantTools?: readonly TenantToolDescriptor[] } = {},
): AdvertisedRequest {
  const facts = gatewayFacts(profile);
  const kind = profiledSurfaceOf(surface);

  if (kind === 'ai_agents') {
    const run = { profile: surface.agentProfile! as AiAgentRunProfile };
    const applied = applyRunToolProfile({
      run, facts, exposedNames: surface.allowedTools, onlyTools: surface.onlyTools,
      flowToolNames: [], offeringId: null, domainOf: chatToolDomain,
    });
    const constrained = applied.exposure.names !== null;
    const tools = breezeServerTools(deny, denyPreToolUse, undefined, undefined, buildOutcomeSdkTools(surface.outcomeTools ?? []), {
      ...(applied.onlyTools ? { onlyTools: applied.onlyTools } : {}),
      ...(constrained ? { toolExposure: applied.exposure } : {}),
    });
    return finish(surface, applied.exposure, getCaptureSystemPrompt(surface), tools, surface.allowedTools);
  }

  if (kind === 'script_builder') {
    let exposure: ToolExposure;
    try {
      exposure = finalizeSessionToolExposure({
        surface: 'script_builder', facts, allowedTools: surface.allowedTools, registryNames: listChatSurfaceToolNames,
        breezeServer: false, domainOf: chatToolDomain, extraTools: [],
      }).exposure;
    } catch (err) {
      // `minimal` drops the builder's floor (execute_script_on_device), so the
      // builder refuses it; its prefix is still measured, from the same
      // resolver without the floor, to decide minimal vs too_small for `auto`.
      if (!(err instanceof ToolProfileUnderpoweredError)) throw err;
      exposure = resolveToolExposure({
        surface: 'script_builder', facts, surfaceBaseSet: surface.allowedTools.map((n) => n.replace(/^mcp__script_builder__/, '')), extraTools: [],
      });
    }
    const tools = scriptBuilderServerTools(deny as never, denyPreToolUse, undefined, () => ({ toolExposure: exposure }));
    return finish(surface, exposure, getCaptureSystemPrompt(surface), tools as SdkTool[], surface.allowedTools);
  }

  const tenantDescriptors = [...(opts.tenantTools ?? [])];
  const session = finalizeSessionToolExposure({
    surface: kind,
    facts,
    allowedTools: kind === 'chat' ? undefined : surface.allowedTools,
    registryNames: listChatSurfaceToolNames,
    breezeServer: true,
    domainOf: chatToolDomain,
    extraTools: tenantDescriptors.map((d) => ({ name: d.qualifiedName, domain: 'integrations' as const })),
  });
  const { exposure } = session;
  const constrained = exposure.names !== null;
  const tenantTools = buildTenantSdkTools(tenantDescriptors, deny, () => 'measure-org')
    .filter((t) => !constrained || session.keepsExtra(t.name));
  const onlyTools = kind === 'chat' ? session.onlyTools : surface.onlyTools;
  const tools = breezeServerTools(deny, denyPreToolUse, undefined, undefined, tenantTools, {
    ...(onlyTools ? { onlyTools } : {}),
    ...(constrained ? { toolExposure: exposure } : {}),
  });
  const system = kind === 'chat'
    ? (constrained ? composeConstrainedSystemPrompt(exposure.names!) : composeStaticSystemPrompt(listChatSurfaceToolNames()))
    : getCaptureSystemPrompt(surface);
  const baseAllowed = kind === 'chat'
    ? [...surface.allowedTools, ...tenantMcpToolNames(tenantDescriptors)]
    : surface.allowedTools;
  return finish(surface, exposure, system, tools, baseAllowed);
}

/** bytes / 3 of the translated upstream request carrying only the prefix and a one-word user turn. */
export function advertisedPrefixTokens(request: AdvertisedRequest): number {
  const translated = translateMessagesRequest({
    model: 'measure', max_tokens: 1, system: request.system,
    messages: [{ role: 'user', content: 'x' }],
    tools: request.tools,
  }, 'measure', { compactSchemas: request.exposure.compactSchemas });
  const { system, messages, tools } = { system: null, messages: translated.body.messages, tools: translated.body.tools ?? [] };
  return Math.ceil(Buffer.byteLength(JSON.stringify({ s: system, m: messages, t: tools }), 'utf8') / 3);
}

/** A fresh measurement of every pinned surface × profile (the max over each surface's variants). */
export function measureProfilePrefixes(): Record<keyof typeof PREFIX_SURFACE_SOURCES, Record<MeasuredProfile, number>> {
  const out = {} as Record<keyof typeof PREFIX_SURFACE_SOURCES, Record<MeasuredProfile, number>>;
  for (const [surface, sources] of Object.entries(PREFIX_SURFACE_SOURCES) as Array<[keyof typeof PREFIX_SURFACE_SOURCES, readonly CaptureSurfaceId[]]>) {
    out[surface] = Object.fromEntries(MEASURED_PROFILES.map((profile) => [
      profile,
      Math.max(...sources.map((id) => advertisedPrefixTokens(advertisedRequest(CAPTURE_SURFACES[id], profile)))),
    ])) as Record<MeasuredProfile, number>;
  }
  return out;
}
