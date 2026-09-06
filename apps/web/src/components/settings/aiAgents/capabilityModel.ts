import type { AgentCeilingDto, AgentToolCatalogDto, AgentToolOperationDto } from '@breeze/shared';

export type OperationOutcome = 'approval_request' | 'logged_proposal' | 'unattended';
export type AgentModeLike = 'off' | 'shadow' | 'act';
export type UnrecognisedReason = 'unknown_tool' | 'unreachable_tool' | 'bare_multi_op' | 'read_only';

export interface SelectionState {
  selected: Set<string>;
}

const mutating = (tool: AgentToolCatalogDto['tools'][number]) => tool.operations.filter((op) => !op.readOnly);

export function entriesToSelection(
  entries: string[],
  catalog: AgentToolCatalogDto
): { selected: Set<string>; unrecognised: { entry: string; reason: UnrecognisedReason }[] } {
  const byName = new Map(catalog.tools.map((t) => [t.name, t]));
  const opsByKey = new Map(catalog.tools.flatMap((t) => t.operations.map((op) => [op.key, op] as const)));
  const unreachable = new Set(catalog.unreachableTools);
  const selected = new Set<string>();
  const unrecognised: { entry: string; reason: UnrecognisedReason }[] = [];
  for (const entry of entries) {
    const colon = entry.indexOf(':');
    const toolName = colon === -1 ? entry : entry.slice(0, colon);
    const tool = byName.get(toolName);
    if (!tool) {
      unrecognised.push({ entry, reason: unreachable.has(toolName) ? 'unreachable_tool' : 'unknown_tool' });
      continue;
    }
    if (colon === -1) {
      const ops = mutating(tool);
      if (ops.length === 0) {
        // Every operation on this tool is read-only: always available to the
        // agent regardless of selection, so a bare entry naming it has no
        // effect. Neither `bare_multi_op` (there is nothing to expand into)
        // nor silent acceptance/drop is correct here.
        unrecognised.push({ entry, reason: 'read_only' });
        continue;
      }
      if (ops.length === 1 && ops[0] && ops[0].action === null) {
        selected.add(ops[0].key);
        continue;
      }
      for (const op of ops) selected.add(op.key);
      unrecognised.push({ entry, reason: 'bare_multi_op' });
      continue;
    }
    const op = opsByKey.get(entry);
    if (!op) {
      unrecognised.push({ entry, reason: unreachable.has(toolName) ? 'unreachable_tool' : 'unknown_tool' });
    } else if (op.readOnly) {
      // A scoped key naming a read-only operation: same "always available,
      // no effect" case as the bare-entry branch above, just addressed by
      // action instead of by tool.
      unrecognised.push({ entry, reason: 'read_only' });
    } else {
      selected.add(entry);
    }
  }
  return { selected, unrecognised };
}

export function selectionToEntries(selected: Set<string>, catalog: AgentToolCatalogDto): string[] {
  const order = catalog.tools.flatMap((t) => t.operations.map((op) => op.key));
  return order.filter((key) => selected.has(key));
}

export function capabilityState(
  capabilityId: string,
  selected: Set<string>,
  catalog: AgentToolCatalogDto,
  ceiling: AgentCeilingDto | null = null
): { checked: 'all' | 'some' | 'none'; selectedCount: number; totalCount: number } {
  const ops = catalog.tools.filter((t) => t.capability === capabilityId).flatMap(mutating);
  const opsInCeiling = ops.filter((op) => isWithinCeiling(op.key, ceiling));
  const totalCount = opsInCeiling.length;
  // Counted over ALL mutating ops, not just the in-ceiling ones: a stale
  // grant outside the ceiling is still a real selection, so it must not be
  // erased from the count — otherwise a capability that is fully selected
  // in-ceiling PLUS a stale out-of-ceiling extra would misreport 'all'
  // instead of 'some', and a capability with ONLY a stale out-of-ceiling
  // selection would misreport 'none' instead of 'some'.
  const selectedCount = ops.filter((op) => selected.has(op.key)).length;
  const allInCeilingSelected = opsInCeiling.every((op) => selected.has(op.key));
  const checked =
    selectedCount === 0 ? 'none' : selectedCount === totalCount && allInCeilingSelected ? 'all' : 'some';
  return { checked, selectedCount, totalCount };
}

export function outcomeFor(op: AgentToolOperationDto, mode: AgentModeLike): OperationOutcome {
  if (mode === 'act' && op.actEligible) return 'unattended';
  return op.tier === 3 ? 'approval_request' : 'logged_proposal';
}

export function isWithinCeiling(opKey: string, ceiling: AgentCeilingDto | null): boolean {
  if (!ceiling) return true;
  const colon = opKey.indexOf(':');
  const tool = colon === -1 ? opKey : opKey.slice(0, colon);
  return ceiling.toolAllowlist.includes(opKey) || ceiling.toolAllowlist.includes(tool);
}

export function summarise(
  selected: Set<string>,
  catalog: AgentToolCatalogDto,
  mode: AgentModeLike
): {
  operations: number;
  capabilities: number;
  approvalRequests: number;
  loggedProposals: number;
  unattended: string[];
  readOnlyToolCount: number;
} {
  const caps = new Set<string>();
  let approvalRequests = 0;
  let loggedProposals = 0;
  const unattended: string[] = [];
  for (const tool of catalog.tools) {
    for (const op of tool.operations) {
      if (!selected.has(op.key) || op.readOnly) continue;
      caps.add(tool.capability);
      const outcome = outcomeFor(op, mode);
      if (outcome === 'approval_request') approvalRequests++;
      else if (outcome === 'logged_proposal') loggedProposals++;
      else unattended.push(op.key);
    }
  }
  return {
    operations: approvalRequests + loggedProposals + unattended.length,
    capabilities: caps.size,
    approvalRequests,
    loggedProposals,
    unattended,
    readOnlyToolCount: catalog.tools.filter((t) => t.readOnly).length,
  };
}
