/**
 * The production `ToolProfileCatalog` (#11398): every tool name each profiled
 * surface declares, and a registry tool's domain. Built from the tool
 * registries themselves, so a custom allow-list is validated against what the
 * surfaces really register.
 *
 * Imported by the /ai/models routes only. The registries pull in the tool
 * handler graph, which must stay out of the worker's import closure
 * (workerEntrypointClosure.contract.test.ts); `toolSettingsWrite.ts` and
 * `registryView.ts` take the catalog as a parameter for that reason.
 */
import { TOOL_TIERS, chatToolDomain } from '../aiAgentSdkTools';
import { CLIENT_TOOL_REGISTRIES } from '../clientAiTools';
import { SCRIPT_BUILDER_TOOL_TIERS } from '../scriptBuilderTools';
import type { ToolProfileCatalog } from './toolSettingsWrite';
import type { ProfiledSurface } from './toolProfiles';

let cached: ToolProfileCatalog | null = null;

export function breezeToolProfileCatalog(): ToolProfileCatalog {
  if (cached) return cached;
  // Chat, the helper and AI agents all register the Breeze registry (the
  // helper a per-level subset of it; its profiles have no floors).
  const registry: ReadonlySet<string> = new Set(Object.keys(TOOL_TIERS));
  const scriptBuilder: ReadonlySet<string> = new Set(Object.keys(SCRIPT_BUILDER_TOOL_TIERS));
  const office: ReadonlySet<string> = new Set(Object.values(CLIENT_TOOL_REGISTRIES).flatMap((r) => Object.keys(r)));
  const bySurface: Readonly<Record<ProfiledSurface, ReadonlySet<string>>> = {
    chat: registry, helper: registry, ai_agents: registry, script_builder: scriptBuilder, office_chat: office,
  };
  cached = { surfaceNames: (surface) => bySurface[surface], domainOf: chatToolDomain };
  return cached;
}
