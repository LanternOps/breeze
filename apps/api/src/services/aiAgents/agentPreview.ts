/**
 * Task 11 (#5051) — `POST /ai/agents/preview` (spec §4.6 step 4): evaluates a
 * DRAFT agent policy (no row need exist yet) through the SAME catalog/ceiling
 * shapes the capability picker and the run loop use, so the guided create
 * flow's review card can never drift from what create/update would actually
 * enforce. Pure — no DB access, no side effects; the route resolves the
 * ceiling and hands it in.
 */
import type {
  AgentCeilingDto,
  AgentPreviewDto,
  AgentToolCatalogDto,
  AgentToolCatalogToolDto,
  AgentToolOperationDto,
} from '@breeze/shared/types/aiAgents';
import type { PreviewAiAgentInput } from '@breeze/shared/validators/aiAgents';
import { outcomeFor, unattendedBlockedBy } from '@breeze/shared';
import { intersectToolRefs, isToolAllowlisted } from './toolAllowlist';

/** `'manage_services:restart'` -> `{ tool: 'manage_services', action: 'restart' }`; a bare entry -> `action: null`. */
function splitEntry(entry: string): { tool: string; action: string | null } {
  const colon = entry.indexOf(':');
  return colon === -1
    ? { tool: entry, action: null }
    : { tool: entry.slice(0, colon), action: entry.slice(colon + 1) };
}

/**
 * Resolves one raw `toolAllowlist` entry against the catalog, mirroring the
 * web's `entriesToSelection` (`capabilityModel.ts`) exactly so the two never
 * classify the same entry differently. `unrecognised: true` means the entry
 * contributes no operation and the raw entry surfaces on the review card
 * instead — either because it could not be resolved at all (unknown tool, or
 * an unreachable action on a known tool), because it names an operation that
 * is always-on and read-only (a bare entry whose tool has no mutating
 * operations, or a scoped key naming a read-only operation — neither is ever
 * a proposed or approved operation in its own right; both are already
 * counted in `readOnlyToolCount`), or because a bare entry needed
 * disambiguation (the tool has more than one named action) — that case
 * ALSO still returns its mutating operations, so the same entry can both
 * expand into `operations` and be flagged (the web's `bare_multi_op`).
 *
 * A bare entry on a genuinely single-operation tool (`operations.length ===
 * 1 && operations[0].action === null`, `agentToolCatalog.ts`'s own
 * invariant whenever `key === name`) IS that tool's one operation, with no
 * flag — but only when that one operation is mutating; an all-read-only
 * single-op tool falls into the read-only case above instead.
 */
function resolveEntry(
  entry: string,
  toolsByName: ReadonlyMap<string, AgentToolCatalogToolDto>,
): { ops: AgentToolOperationDto[]; unrecognised: boolean } {
  const { tool: toolName, action } = splitEntry(entry);
  const tool = toolsByName.get(toolName);
  if (!tool) return { ops: [], unrecognised: true };

  if (action !== null) {
    const op = tool.operations.find((candidate) => candidate.action === action);
    if (!op || op.readOnly) return { ops: [], unrecognised: true };
    return { ops: [op], unrecognised: false };
  }

  const mutatingOps = tool.operations.filter((op) => !op.readOnly);
  if (mutatingOps.length === 0) return { ops: [], unrecognised: true };
  if (mutatingOps.length === 1 && mutatingOps[0]!.action === null) {
    return { ops: mutatingOps, unrecognised: false };
  }
  return { ops: mutatingOps, unrecognised: true };
}

export function buildAgentPreview(
  input: PreviewAiAgentInput,
  ceiling: AgentCeilingDto | null,
  catalog: AgentToolCatalogDto,
): AgentPreviewDto {
  const toolsByName = new Map(catalog.tools.map((tool) => [tool.name, tool]));
  const opsByKey = new Map<string, AgentToolOperationDto>();
  const unrecognised = new Set<string>();

  for (const entry of input.toolAllowlist) {
    const { ops, unrecognised: flagged } = resolveEntry(entry, toolsByName);
    if (flagged) unrecognised.add(entry);
    for (const op of ops) opsByKey.set(op.key, op);
  }

  // No ceiling (a partner draft, or an org draft with no live partner
  // baseline yet) means nothing narrows the draft's own supervised keys —
  // intersecting with itself under `intersectToolRefs` would be a no-op
  // dedupe, so skip straight to the draft's own list rather than compute it.
  const supervisedCeiling = ceiling
    ? intersectToolRefs(ceiling.supervisedActionKeys, input.actAssets.supervisedActionKeys)
    : input.actAssets.supervisedActionKeys;

  // The same asset gate the run loop applies (`remediationActResolver.ts`):
  // an act-eligible `run_script` is only unattended for a script in
  // `actAssets.scriptIds`. The guided create flow never sets it, so its
  // preview truthfully shows an approval request, with the reason attached.
  // Intersected with the ceiling the same way `effectivePolicy.ts` narrows
  // `scriptIds` (partner ∩ org) — an org row listing a script the baseline
  // does not is still only ever proposed.
  const authorizedScriptIds = ceiling
    ? input.actAssets.scriptIds.filter((id) => ceiling.scriptIds.includes(id))
    : input.actAssets.scriptIds;
  const outcomeContext = { authorizedScriptCount: authorizedScriptIds.length };

  const operations = [...opsByKey.values()].map((op) => {
    const { tool, action } = splitEntry(op.key);
    return {
      key: op.key,
      capability: toolsByName.get(tool)!.capability,
      outcome: outcomeFor(op, input.mode, outcomeContext),
      unattendedBlockedBy: unattendedBlockedBy(op, input.mode, outcomeContext),
      preauthorized: isToolAllowlisted(supervisedCeiling, tool, action),
      withinCeiling: ceiling ? isToolAllowlisted(ceiling.toolAllowlist, tool, action) : true,
    };
  });

  return {
    mode: input.mode,
    kind: input.kind,
    readOnlyToolCount: catalog.tools.filter((tool) => tool.readOnly).length,
    authorizedScriptCount: authorizedScriptIds.length,
    operations,
    unrecognised: [...unrecognised],
    triggers: {
      alertSeverities: input.triggers.alertSeverities,
      respectMaintenanceWindows: input.triggers.respectMaintenanceWindows,
      ticketAutonomousWrites: input.triggers.ticketAutonomousWrites,
    },
    protectedResources: input.protectedResources,
    limits: input.limits,
    cooldownSeconds: input.cooldownSeconds,
    recipients: input.recipients,
  };
}
