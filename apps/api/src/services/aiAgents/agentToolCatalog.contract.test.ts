import { describe, it, expect } from 'vitest';
import { aiTools } from '../aiToolNames';
import '../aiTools'; // populates the registry
import { TOOL_TIERS } from '../aiAgentSdkTools';
import { m365ToolTiers } from '../aiToolsM365';
import { googleToolTiers } from '../aiToolsGoogle';
import { AGENT_HUMAN_ONLY_TOOLS } from '../aiGuardrails';
import { isPolicyDecidableKey } from '../actionIntents/policyDecidable';
import {
  AGENT_CAPABILITIES, TOOL_CAPABILITY, AGENT_KIND_PRESETS,
  listAgentReachableTools, listUnreachableRegisteredTools, buildAgentToolCatalog,
} from './agentToolCatalog';

const capabilityIds = new Set(AGENT_CAPABILITIES.map((c) => c.id));

describe('agentToolCatalog contract', () => {
  it('maps EVERY registered headless tool to a capability, and nothing else', () => {
    const registered = [...aiTools.keys()].sort();
    const mapped = Object.keys(TOOL_CAPABILITY).sort();
    expect(mapped).toEqual(registered);
    for (const id of Object.values(TOOL_CAPABILITY)) expect(capabilityIds.has(id)).toBe(true);
  });

  it('reachable = registry ∩ TOOL_TIERS − session-only − human-only', () => {
    const reachable = new Set(listAgentReachableTools());
    for (const name of reachable) {
      expect(aiTools.has(name)).toBe(true);
      expect(name in TOOL_TIERS).toBe(true);
      expect(name in m365ToolTiers).toBe(false);
      expect(name in googleToolTiers).toBe(false);
      expect(AGENT_HUMAN_ONLY_TOOLS.has(name)).toBe(false);
    }
    for (const name of aiTools.keys()) {
      if (name in TOOL_TIERS && !AGENT_HUMAN_ONLY_TOOLS.has(name)) expect(reachable.has(name)).toBe(true);
    }
  });

  it('pins the unreachable set so a reachability change is a deliberate edit (#3300)', () => {
    // Registered but absent from TOOL_TIERS: the agent SDK never offers these.
    // Widening reachability is a product decision; update this list WITH the
    // TOOL_TIERS change that makes it true, never on its own.
    expect(listUnreachableRegisteredTools()).toMatchSnapshot();
  });

  it('every preset entry names a reachable, mutating operation', () => {
    const catalog = buildAgentToolCatalog();
    const opsByKey = new Map(catalog.tools.flatMap((t) => t.operations.map((op) => [op.key, op] as const)));
    for (const entries of Object.values(AGENT_KIND_PRESETS)) {
      for (const entry of entries) {
        const op = opsByKey.get(entry);
        expect(op, `${entry} is not a catalog operation`).toBeDefined();
        expect(op!.readOnly, `${entry} is read-only; read tools are always on`).toBe(false);
      }
    }
  });

  it('operations carry tiers from checkGuardrails and flags from the registries', () => {
    const catalog = buildAgentToolCatalog();
    const services = catalog.tools.find((t) => t.name === 'manage_services')!;
    const byAction = Object.fromEntries(services.operations.map((op) => [op.action, op]));
    expect(byAction.list).toMatchObject({ readOnly: true });
    expect(byAction.restart).toMatchObject({ tier: 3, readOnly: false, policyDecidable: true, actEligible: true });
    expect(byAction.start).toMatchObject({ tier: 3, policyDecidable: true, actEligible: false });
    for (const tool of catalog.tools) for (const op of tool.operations) {
      expect(op.policyDecidable).toBe(isPolicyDecidableKey(op.key));
    }
    const cmd = catalog.tools.find((t) => t.name === 'execute_command')!;
    expect(cmd.operations.some((op) => op.action === 'restart_service' && op.tier === 3)).toBe(true);
  });

  it('every catalog tool has at least one operation and a single-operation tool uses the bare key', () => {
    for (const tool of buildAgentToolCatalog().tools) {
      expect(tool.operations.length).toBeGreaterThan(0);
      const [first] = tool.operations;
      if (tool.operations.length === 1 && first && first.action === null) expect(first.key).toBe(tool.name);
    }
  });
});
