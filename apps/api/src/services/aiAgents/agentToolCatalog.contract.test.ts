import { describe, it, expect } from 'vitest';
import { aiTools } from '../aiToolNames';
import '../aiTools'; // populates the registry
import { TOOL_TIERS } from '../aiAgentSdkTools';
import { m365ToolTiers } from '../aiToolsM365';
import { googleToolTiers } from '../aiToolsGoogle';
import { AGENT_HUMAN_ONLY_TOOLS, BLOCKED_TOOLS } from '../aiGuardrails';
import { isSecretBearingTool } from '../actionIntents/secretBearingTools';
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

  it('reachable = registry ∩ TOOL_TIERS − session-only − human-only − blocked − secret-bearing', () => {
    const reachable = new Set(listAgentReachableTools());
    for (const name of reachable) {
      expect(aiTools.has(name)).toBe(true);
      expect(name in TOOL_TIERS).toBe(true);
      expect(name in m365ToolTiers).toBe(false);
      expect(name in googleToolTiers).toBe(false);
      expect(AGENT_HUMAN_ONLY_TOOLS.has(name)).toBe(false);
      // Same runtime deny set `checkAgentGuardrails` enforces unconditionally
      // (aiGuardrails.ts ~1692-1697): a blocked or secret-bearing tool must
      // never be reachable, even though nothing in the current headless
      // registry actually trips either check today (BLOCKED_TOOLS is empty;
      // the two SECRET_BEARING_TOOLS are session-only and excluded above
      // already) — this pins the exclusion so it still holds the day either
      // set gains a headless member.
      expect(BLOCKED_TOOLS.has(name)).toBe(false);
      expect(isSecretBearingTool(name)).toBe(false);
    }
    for (const name of aiTools.keys()) {
      if (name in TOOL_TIERS && !AGENT_HUMAN_ONLY_TOOLS.has(name)) expect(reachable.has(name)).toBe(true);
    }
  });

  it('pins the unreachable set so a reachability change is a deliberate edit (#3300)', () => {
    // Every registered tool NOT in the reachable set: absent from TOOL_TIERS,
    // OR excluded by the same runtime-deny filters as `listAgentReachableTools`
    // (session-only, human-only, blocked, secret-bearing). Widening
    // reachability is a product decision; update this snapshot WITH the
    // registry/guardrail change that makes it true, never on its own.
    expect(listUnreachableRegisteredTools()).toMatchSnapshot();
  });

  it('unreachableTools ∪ reachable = every registered tool name, and the two sets are disjoint (Task 7, #5049)', () => {
    const reachable = new Set(listAgentReachableTools());
    const unreachable = new Set(listUnreachableRegisteredTools());
    const registered = new Set(aiTools.keys());
    for (const name of reachable) expect(unreachable.has(name)).toBe(false);
    for (const name of unreachable) expect(reachable.has(name)).toBe(false);
    expect(new Set([...reachable, ...unreachable])).toEqual(registered);
    // A concrete, non-vacuous member: registered + in TOOL_TIERS, but
    // AGENT_HUMAN_ONLY_TOOLS — so `listUnreachableRegisteredTools` must widen
    // beyond a bare `!(name in TOOL_TIERS)` filter to catch it.
    expect(unreachable.has('manage_ai_agents')).toBe(true);
  });

  it("buildAgentToolCatalog's DTO carries unreachableTools matching listUnreachableRegisteredTools() (Task 7, #5049)", () => {
    const catalog = buildAgentToolCatalog();
    expect(catalog.unreachableTools).toEqual(listUnreachableRegisteredTools());
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

  it('actEligible is derived from ACT_MANIFEST membership, not a synthetic-input matches() probe', () => {
    // run_script/execute_playbook match on scriptId / playbookId+deviceId — a
    // synthetic `{}` or `{ action }` input never carries those, so probing
    // `resolveActOperation` here always came back null for bare-tool
    // ACT_MANIFEST members even though they ARE act-eligible.
    const catalog = buildAgentToolCatalog();
    const runScript = catalog.tools.find((t) => t.name === 'run_script')!;
    expect(runScript.operations).toHaveLength(1);
    expect(runScript.operations[0]).toMatchObject({ key: 'run_script', actEligible: true });

    const executePlaybook = catalog.tools.find((t) => t.name === 'execute_playbook')!;
    expect(executePlaybook.operations).toHaveLength(1);
    expect(executePlaybook.operations[0]).toMatchObject({ key: 'execute_playbook', actEligible: true });

    const services = catalog.tools.find((t) => t.name === 'manage_services')!;
    const byAction = Object.fromEntries(services.operations.map((op) => [op.action, op]));
    expect(byAction.start).toMatchObject({ actEligible: false });

    const diskCleanup = catalog.tools.find((t) => t.name === 'disk_cleanup')!;
    const byDiskAction = Object.fromEntries(diskCleanup.operations.map((op) => [op.action, op]));
    expect(byDiskAction.execute).toMatchObject({ actEligible: true });
  });

  it('flags run_script — and only run_script — as needing an authorized script before it runs unattended (#5048 QA)', () => {
    // Mirrors agentService.ts's hasActEligibleSurface and
    // remediationActResolver.ts: run_script is in ACT_MANIFEST but is never
    // dispatched unattended for a script absent from actAssets.scriptIds.
    const catalog = buildAgentToolCatalog();
    const gated = catalog.tools.flatMap((t) => t.operations).filter((op) => op.actRequiresAuthorizedScripts);
    expect(gated.map((op) => op.key)).toEqual(['run_script']);
    expect(gated[0]).toMatchObject({ actEligible: true });
    for (const tool of catalog.tools) for (const op of tool.operations) {
      expect(typeof op.actRequiresAuthorizedScripts).toBe('boolean');
    }
  });

  it('every catalog tool has at least one operation and a single-operation tool uses the bare key', () => {
    for (const tool of buildAgentToolCatalog().tools) {
      expect(tool.operations.length).toBeGreaterThan(0);
      const [first] = tool.operations;
      if (tool.operations.length === 1 && first && first.action === null) expect(first.key).toBe(tool.name);
    }
  });
});
