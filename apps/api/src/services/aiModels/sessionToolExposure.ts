/**
 * One tool exposure per streaming-session entry (#11393 W01). Chat, the
 * helper, the script builder, Office and the topology turn all create their
 * live query through `streamingSessionManager.getOrCreate`; this turns the
 * model's facts plus what that surface registers into the three things the
 * query consumes — the Breeze registration filter (`onlyTools`), the extra
 * tools kept, and `allowedTools` — from ONE resolved exposure, so they can
 * never disagree. The identity exposure changes none of them.
 */
import type { AiApprovalMode, AiSurface, AiToolDomain } from '@breeze/shared';
import {
  SURFACE_UNDERPOWERED_MESSAGE,
  TOOL_PROFILE_UNDERPOWERED,
  checkSurfaceCoverage,
} from './surfaceRequiredTools';
import { effectiveToolProfile, resolveToolExposure, type ExtraToolInput, type ToolExposure, type ToolProfileFacts } from './toolExposure';

const MCP_NAME = /^mcp__.+?__(.+)$/;

/** `mcp__<server>__<tool>` → `<tool>`; a bare name is returned as is. Server names never contain `__`. */
export function bareToolName(mcpName: string): string {
  return MCP_NAME.exec(mcpName)?.[1] ?? mcpName;
}

const SURFACE_LABELS: Readonly<Partial<Record<AiSurface, string>>> = {
  chat: 'chat',
  helper: 'helper',
  script_builder: 'script builder',
  office_chat: 'Office add-in',
  ai_agents: 'AI agent',
};

export class ToolProfileUnderpoweredError extends Error {
  readonly code = TOOL_PROFILE_UNDERPOWERED;
  readonly status = 409;
  constructor(readonly surface: AiSurface, readonly missing: readonly string[]) {
    super(SURFACE_UNDERPOWERED_MESSAGE(SURFACE_LABELS[surface] ?? surface));
    this.name = 'ToolProfileUnderpoweredError';
  }
}

export interface SessionToolExposureInput {
  surface: AiSurface;
  facts: ToolProfileFacts;
  /** The MCP names the caller allow-lists (helper, script builder, Office); undefined = the Breeze registry. */
  allowedTools: readonly string[] | undefined;
  /** Bare Breeze registry names (what `createBreezeMcpServer` declares). */
  registryNames: () => readonly string[];
  /** The session registers the Breeze server (no caller `mcpServerFactory`), so `onlyTools` applies. */
  breezeServer: boolean;
  /** A registry tool's domain (`chatToolDomain`), for a `custom` allow-list's domains. */
  domainOf: (name: string) => AiToolDomain | undefined;
  /** Tenant / flow tools (registered on the Breeze server under `mcp__breeze__<name>`). */
  extraTools: readonly ExtraToolInput[];
  approvalMode?: AiApprovalMode;
}

export interface SessionToolExposure {
  exposure: ToolExposure;
  /** `allowedTools` for `query()`: the caller's list (or undefined) when unchanged, otherwise the filtered list. */
  allowedTools: string[] | undefined;
  /** `createBreezeMcpServer` registration filter; undefined = register everything (today's behaviour). */
  onlyTools: ReadonlySet<string> | undefined;
  /** Whether an extra tool (by registered name) stays registered. */
  keepsExtra: (name: string) => boolean;
}

/**
 * Throws `ToolProfileUnderpoweredError` when the exposure drops a tool the
 * surface requires — before any provider call. Never called for `ai_agents`
 * (the run loop checks its run-specific floor itself).
 */
export function finalizeSessionToolExposure(input: SessionToolExposureInput): SessionToolExposure {
  const { surface, facts, allowedTools, extraTools, approvalMode, breezeServer } = input;
  // The identity exposure never reads the base set: skip enumerating the registry.
  const constrained = effectiveToolProfile(facts, surface).profile !== 'full';
  // A helper session that registers only its client-declared tools (a
  // `mcpServerFactory`, not the Breeze server) has nothing the curated helper
  // lists describe: those tools are the client's own small set and are kept
  // as extras rather than filtered to zero.
  const clientDeclaredOnly = surface === 'helper' && !breezeServer;
  const callerNames = allowedTools ? allowedTools.map(bareToolName) : [];
  const surfaceBaseSet = !constrained || clientDeclaredOnly ? [] : allowedTools ? callerNames : input.registryNames();
  const exposure = resolveToolExposure({
    surface,
    facts,
    surfaceBaseSet,
    extraTools: clientDeclaredOnly && constrained
      ? [...extraTools, ...callerNames.map((name) => ({ name, domain: null, alwaysKeep: true }))]
      : extraTools,
    ...(approvalMode ? { approvalMode } : {}),
  }, { domainOf: input.domainOf });
  if (exposure.names === null) {
    return { exposure, allowedTools: allowedTools ? [...allowedTools] : undefined, onlyTools: undefined, keepsExtra: () => true };
  }
  if (surface !== 'ai_agents') {
    const offered = new Set([...surfaceBaseSet, ...extraTools.map((t) => t.name), ...callerNames]);
    const coverage = checkSurfaceCoverage(surface, exposure, undefined, offered);
    if (!coverage.ok) throw new ToolProfileUnderpoweredError(surface, coverage.missing);
  }
  const registry = new Set(input.registryNames());
  const keptExtras = new Set(exposure.extraToolNames);
  return {
    exposure,
    allowedTools: allowedToolsUnder(exposure, allowedTools),
    onlyTools: breezeServer ? new Set(exposure.names.filter((n) => registry.has(n))) : undefined,
    keepsExtra: (name) => keptExtras.has(name),
  };
}

/**
 * `allowedTools` under an exposure: the caller's list narrowed to the kept
 * names, or (Breeze registry, no caller list) the kept names as
 * `mcp__breeze__` names. The identity exposure returns the caller's list.
 * Used at creation and again on every reuse of the live query.
 */
export function allowedToolsUnder(exposure: ToolExposure, allowedTools: readonly string[] | undefined): string[] | undefined {
  if (exposure.names === null) return allowedTools ? [...allowedTools] : undefined;
  const kept = new Set([...exposure.names, ...exposure.extraToolNames]);
  return allowedTools
    ? allowedTools.filter((name) => kept.has(bareToolName(name)))
    : [...exposure.names, ...exposure.extraToolNames].map((name) => `mcp__breeze__${name}`);
}
