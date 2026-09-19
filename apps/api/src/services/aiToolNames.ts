/**
 * Reserved AI-tool-name registry — the leaf half of the core/extension
 * AI-tool-name collision guard (wave 3.5d-b, #4086, Task 5 chain (ii) break).
 *
 * `extensions/stageExtension.ts` used to import `hasCoreAiToolName` directly
 * from `services/aiTools.ts` — the ~45-domain-module tool registry hub. That
 * static edge dragged the ENTIRE hub in whenever stageExtension.ts loaded,
 * including `aiToolsBackup.ts -> commandQueue.ts -> routes/agentWs.ts`. Since
 * `extensions/builtinExtensions.ts` (which statically imports
 * stageExtension.ts) is one of `worker.ts`'s dynamic-import boot seeds, a
 * `BREEZE_ROLE=worker` process's REAL boot closure quietly reached the
 * socket-local route graph it must never load. See
 * `workerEntrypointClosure.contract.test.ts`.
 *
 * This module OWNS the shared `aiTools` Map instance, the extensible
 * reserved-name-predicate list, and the single call to
 * `extensionContributionRegistry.configureReservedAiToolNames(...)`. All
 * three MUST live here, not in `aiTools.ts`: importing this leaf ALONE (as
 * `stageExtension.ts` now does) is what wires the predicate onto the
 * registry, with zero dependency on `aiTools.ts` — or any of the ~45 domain
 * tool modules it eagerly imports — ever loading.
 *
 * `aiTools.ts` imports `aiTools` (the map) and `hasCoreAiToolName` back from
 * here, populates the map via its usual `registerXTools(aiTools)` calls, and
 * registers the M365/Google tool-tier tables via
 * `registerReservedAiToolNamePredicate` (those tools are session-aware and
 * never added to the `aiTools` map itself — see aiTools.ts's comment above
 * its `registerM365Tools` import). `aiTools.ts` must NOT declare a second Map
 * or call `configureReservedAiToolNames` itself: `current || predicate`
 * accumulation in `ExtensionContributionRegistry#configureReservedAiToolNames`
 * means a second call there would either double-register the predicate or
 * make the final registered behavior depend on which module happened to
 * import first. `aiToolNames.test.ts` asserts the registered state is
 * identical whether this leaf is imported alone or transitively via
 * `aiTools.ts`.
 */
import { extensionContributionRegistry } from '../extensions/contributionRegistry';
import type { AiTool } from './aiTools';

/** The shared core AI tool registry. Owned here; `aiTools.ts` populates it
 *  via its `registerXTools(aiTools)` calls (unchanged from before this
 *  extraction — only the Map's declaration site moved). */
export const aiTools: Map<string, AiTool> = new Map();

type ReservedNamePredicate = (name: string) => boolean;
const extraReservedNamePredicates: ReservedNamePredicate[] = [];

/**
 * Register an additional reserved-name source beyond the `aiTools` map
 * itself. Used by `aiTools.ts` for the M365/Google tool-tier tables, which
 * are session-aware and therefore never added to the `aiTools` map.
 */
export function registerReservedAiToolNamePredicate(predicate: ReservedNamePredicate): void {
  extraReservedNamePredicates.push(predicate);
}

export function hasCoreAiToolName(toolName: string): boolean {
  return aiTools.has(toolName) || extraReservedNamePredicates.some((predicate) => predicate(toolName));
}

extensionContributionRegistry.configureReservedAiToolNames(hasCoreAiToolName);
