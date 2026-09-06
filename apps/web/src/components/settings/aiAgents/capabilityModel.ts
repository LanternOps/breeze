import type { AgentCeilingDto, AgentToolCatalogDto, AgentToolOperationDto } from '@breeze/shared';

export type OperationOutcome = 'approval_request' | 'logged_proposal' | 'unattended';
export type AgentModeLike = 'off' | 'shadow' | 'act';
export type UnrecognisedReason = 'unknown_tool' | 'unreachable_tool' | 'bare_multi_op';

export interface SelectionState {
  selected: Set<string>;
}

const mutating = (tool: AgentToolCatalogDto['tools'][number]) => tool.operations.filter((op) => !op.readOnly);

export function entriesToSelection(
  entries: string[],
  catalog: AgentToolCatalogDto
): { selected: Set<string>; unrecognised: { entry: string; reason: UnrecognisedReason }[] } {
  const byName = new Map(catalog.tools.map((t) => [t.name, t]));
  const opKeys = new Set(catalog.tools.flatMap((t) => t.operations.map((op) => op.key)));
  const selected = new Set<string>();
  const unrecognised: { entry: string; reason: UnrecognisedReason }[] = [];
  for (const entry of entries) {
    const colon = entry.indexOf(':');
    const toolName = colon === -1 ? entry : entry.slice(0, colon);
    const tool = byName.get(toolName);
    if (!tool) {
      unrecognised.push({ entry, reason: 'unknown_tool' });
      continue;
    }
    if (colon === -1) {
      const ops = mutating(tool);
      if (ops.length === 1 && ops[0] && ops[0].action === null) {
        selected.add(ops[0].key);
        continue;
      }
      for (const op of ops) selected.add(op.key);
      unrecognised.push({ entry, reason: 'bare_multi_op' });
      continue;
    }
    if (opKeys.has(entry)) selected.add(entry);
    else unrecognised.push({ entry, reason: 'unknown_tool' });
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
  catalog: AgentToolCatalogDto
): { checked: 'all' | 'some' | 'none'; selectedCount: number; totalCount: number } {
  const ops = catalog.tools.filter((t) => t.capability === capabilityId).flatMap(mutating);
  const selectedCount = ops.filter((op) => selected.has(op.key)).length;
  const checked = selectedCount === 0 ? 'none' : selectedCount === ops.length ? 'all' : 'some';
  return { checked, selectedCount, totalCount: ops.length };
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
