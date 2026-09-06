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
import { intersectToolRefs, isToolAllowlisted } from './toolAllowlist';

/** `'manage_services:restart'` -> `{ tool: 'manage_services', action: 'restart' }`; a bare entry -> `action: null`. */
function splitEntry(entry: string): { tool: string; action: string | null } {
  const colon = entry.indexOf(':');
  return colon === -1
    ? { tool: entry, action: null }
    : { tool: entry.slice(0, colon), action: entry.slice(colon + 1) };
}

/**
 * Resolves one raw `toolAllowlist` entry against the catalog. `null` means
 * the entry could not be resolved at all (unknown tool, or an unreachable
 * action on a known tool) — the caller routes that to `unrecognised`, never
 * to a fabricated operation.
 *
 * A bare entry on a single-operation tool IS that tool's one operation
 * (`agentToolCatalog.ts`'s own invariant: `operations.length === 1 &&
 * operations[0].action === null` whenever `key === name`). A bare entry on a
 * multi-operation tool is shorthand for "every action" (spec §4.3), so it
 * expands to that tool's MUTATING operations only — its read-only operations
 * are already counted in `readOnlyToolCount` and are never a proposed or
 * approved operation in their own right.
 */
function resolveEntry(
  entry: string,
  toolsByName: ReadonlyMap<string, AgentToolCatalogToolDto>,
): AgentToolOperationDto[] | null {
  const { tool: toolName, action } = splitEntry(entry);
  const tool = toolsByName.get(toolName);
  if (!tool) return null;

  if (action !== null) {
    const op = tool.operations.find((candidate) => candidate.action === action);
    return op ? [op] : null;
  }

  if (tool.operations.length === 1 && tool.operations[0]!.action === null) {
    return [tool.operations[0]!];
  }
  return tool.operations.filter((op) => !op.readOnly);
}

/**
 * `mode === 'act' && op.actEligible` -> unattended (the run loop will
 * actually dispatch it without a human, per `ACT_MANIFEST`); otherwise the
 * guardrail tier decides whether a human approves it up front (tier 3) or it
 * is logged as an already-applied proposal (tier 2) — the same split
 * `capabilityModel.outcomeFor` computes on the web side, computed here
 * server-side so the review card cannot drift from it.
 */
function resolveOutcome(
  op: AgentToolOperationDto,
  mode: PreviewAiAgentInput['mode'],
): AgentPreviewDto['operations'][number]['outcome'] {
  if (mode === 'act' && op.actEligible) return 'unattended';
  return op.tier === 3 ? 'approval_request' : 'logged_proposal';
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
    const resolved = resolveEntry(entry, toolsByName);
    if (resolved === null) {
      unrecognised.add(entry);
      continue;
    }
    for (const op of resolved) opsByKey.set(op.key, op);
  }

  // No ceiling (a partner draft, or an org draft with no live partner
  // baseline yet) means nothing narrows the draft's own supervised keys —
  // intersecting with itself under `intersectToolRefs` would be a no-op
  // dedupe, so skip straight to the draft's own list rather than compute it.
  const supervisedCeiling = ceiling
    ? intersectToolRefs(ceiling.supervisedActionKeys, input.actAssets.supervisedActionKeys)
    : input.actAssets.supervisedActionKeys;

  const operations = [...opsByKey.values()].map((op) => {
    const { tool, action } = splitEntry(op.key);
    return {
      key: op.key,
      capability: toolsByName.get(tool)!.capability,
      outcome: resolveOutcome(op, input.mode),
      preauthorized: isToolAllowlisted(supervisedCeiling, tool, action),
      withinCeiling: ceiling ? isToolAllowlisted(ceiling.toolAllowlist, tool, action) : true,
    };
  });

  return {
    mode: input.mode,
    kind: input.kind,
    readOnlyToolCount: catalog.tools.filter((tool) => tool.readOnly).length,
    operations,
    unrecognised: [...unrecognised],
    triggers: {
      alertSeverities: input.triggers.alertSeverities,
      respectMaintenanceWindows: input.triggers.respectMaintenanceWindows,
      ticketAutonomousWrites: input.triggers.ticketAutonomousWrites,
    },
    protectedResources: input.protectedResources,
    limits: input.limits,
    recipients: input.recipients,
  };
}
