---
tracking_issue: LanternOps/breeze#5048
waves: W01 API catalog + merge fix + hardening · W02 web CapabilityPicker · W03 web guided create flow + preview route
---

# AI Agent Builder Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the AI agent form's free-text tool allowlist with a capability picker backed by a server-side tool catalog that only lists tools an agent can actually reach, then restructure create into a four-step guided flow with a server-evaluated plain-English review.

**Architecture:** One new API module (`services/aiAgents/agentToolCatalog.ts`) derives the catalog from the existing registry, `TOOL_TIERS`, and `checkGuardrails` (never hand-tiered), with a contract test that pins the agent-reachable universe. Two static-ish routes (`/tool-catalog`, `/ceiling`) feed a new `CapabilityPicker` React component that stores `tool:action` entries. The effective-policy merge becomes wildcard-aware so scoped entries survive a bare partner entry, and org rows can no longer add pre-authorized keys except through the four-eyes grant executor. W3 adds a `/preview` route and the stepper flow.

**Tech Stack:** Hono routes + Vitest (API); React 19 + react-i18next + Vitest/jsdom (web); Zod schemas in `packages/shared`.

**Spec:** `docs/superpowers/specs/ai-mcp/2026-09-06-ai-agent-builder-design.md` — read it first; §2 lists the verified facts and §4 the contract this plan implements.

## Global Constraints

- No schema change. `ai_agents.tool_allowlist` stays `string[]` of `tool` or `tool:action` (`TOOL_REF = /^[a-z0-9_]+(:[a-z0-9_]+)?$/`, max 300).
- The catalog universe is **registry ∩ `TOOL_TIERS` − session-only (`m365ToolTiers`, `googleToolTiers`) − `AGENT_HUMAN_ONLY_TOOLS`**. Tools outside it are never listed or suggested.
- Per-operation tier/readOnly come from `checkGuardrails(toolName, { [discriminator]: action })`; the discriminator is `TOOL_ACTION_INPUT_KEYS[toolName] ?? 'action'`. Never hand-declare a tier in the catalog.
- Web persistence rule: multi-operation tools are stored as `tool:action` entries, never compacted to a bare tool. Bare entries only for single-operation tools.
- Copy rules (spec §4.6): never "can read everything"; tier 3 = "Approval request", tier 2 = "Logged proposal"; never "auto, audited" in agent context.
- Every new `en/settings.json` key must be added to all 7 other locales (`de-DE, es-419, fr-CA, fr-FR, it-IT, pt-BR, tr-TR`) or `apps/web/src/lib/i18n/localeParity.test.ts` fails.
- New routes register **before** `aiAgentsRoutes.get('/:id', …)` (`apps/api/src/routes/aiAgents.ts:1508`) and use `scopes, requireAiRead` exactly like `/policy-decidable-keys` (`:397`).
- Run single test files with `cd apps/api && npx vitest run <path>` / `cd apps/web && npx vitest run <path>` (never `pnpm … test -- --run`).
- Commit after every green step. Branch per wave: `feature/<parent#>-agent-builder/wave-<subissue#>`. PR body includes `Closes #<sub-issue>`.

---

## File structure

**W01 (API)**
- Create `apps/api/src/services/aiAgents/agentToolCatalog.ts` — capability ids, `TOOL_CAPABILITY` map, `AGENT_KIND_PRESETS`, `listAgentReachableTools()`, `buildAgentToolCatalog()`.
- Create `apps/api/src/services/aiAgents/agentToolCatalog.contract.test.ts` — completeness/reachability/preset contract.
- Modify `apps/api/src/services/aiAgents/toolAllowlist.ts` — add `intersectToolRefs`.
- Modify `apps/api/src/services/aiAgents/effectivePolicy.ts:230,295` — use `intersectToolRefs`.
- Modify `apps/api/src/services/aiAgents/agentService.ts` — `SupervisedKeysGrantOnlyError`, `assertOrgRowSupervisedKeysGrantOnly`, wire into create/update.
- Modify `apps/api/src/routes/aiAgents.ts` — `GET /tool-catalog`, `GET /ceiling`, 422 mapping.
- Tests: `toolAllowlist.test.ts` (new), `effectivePolicy.test.ts`, `agentService.test.ts`, `routes/aiAgents.test.ts`.
- Modify `packages/shared/src/types/aiAgents.ts` — `AgentToolCatalogDto`, `AgentCeilingDto` wire types.

**W02 (web)**
- Create `apps/web/src/components/settings/aiAgents/CapabilityPicker.tsx`, `capabilityModel.ts` (pure selection/persistence logic), `useAgentToolCatalog.ts`, tests beside each.
- Modify `apps/web/src/components/settings/AiAgentForm.tsx` — replace Permissions textarea + datalist with `CapabilityPicker`; remove org-row supervised-key checkboxes; map 422 `supervised_keys_grant_only`.
- Modify `apps/web/src/locales/*/settings.json` (8 files) — `aiAgentsPage.catalog.*`.
- Modify `apps/docs/src/content/docs/features/ai-agents.mdx` — permissions section.

**W03 (web + one route)**
- Modify `apps/api/src/routes/aiAgents.ts` + `services/aiAgents/agentPreview.ts` (new) — `POST /preview`.
- Create `apps/web/src/components/settings/aiAgents/AgentCreateFlow.tsx`, `AgentSummaryCard.tsx`, `steps/*.tsx`.
- Modify `AiAgentsPage.tsx` (create opens the flow), `SetupStepper.tsx` (`ariaLabel` prop), locales.

---

# Wave W01 — API: catalog, ceiling, wildcard merge, hardening

### Task 1: `intersectToolRefs` (wildcard-aware allowlist intersection)

**Files:**
- Modify: `apps/api/src/services/aiAgents/toolAllowlist.ts` (append after `isToolAllowlisted`, line 45)
- Create: `apps/api/src/services/aiAgents/toolAllowlist.test.ts`

**Interfaces:**
- Produces: `intersectToolRefs(a: readonly string[], b: readonly string[]): string[]` — every `(tool, action)` admitted by the result is admitted by both inputs under `isToolAllowlisted`, and every pair admitted by both inputs is admitted by the result.

- [ ] **Step 1: Write the failing test**

```ts
// apps/api/src/services/aiAgents/toolAllowlist.test.ts
import { describe, it, expect } from 'vitest';
import { intersectToolRefs, isToolAllowlisted } from './toolAllowlist';

describe('intersectToolRefs', () => {
  it('keeps a scoped entry when the other side holds the bare tool (partner ceiling is a wildcard)', () => {
    expect(intersectToolRefs(['manage_services'], ['manage_services:restart']))
      .toEqual(['manage_services:restart']);
    expect(intersectToolRefs(['manage_services:restart'], ['manage_services']))
      .toEqual(['manage_services:restart']);
  });

  it('keeps a bare entry only when both sides are bare', () => {
    expect(intersectToolRefs(['run_script'], ['run_script'])).toEqual(['run_script']);
    expect(intersectToolRefs(['manage_services'], ['manage_services:stop', 'disk_cleanup:execute']))
      .toEqual(['manage_services:stop']);
  });

  it('drops entries the other side never admits', () => {
    expect(intersectToolRefs(['manage_services:restart'], ['manage_services:stop'])).toEqual([]);
    expect(intersectToolRefs(['run_script'], [])).toEqual([]);
  });

  it('is sound and complete against isToolAllowlisted', () => {
    const tools = ['manage_services', 'disk_cleanup', 'run_script'];
    const actions = ['restart', 'execute', null];
    const universe: string[] = [];
    for (const t of tools) { universe.push(t); for (const a of actions) if (a) universe.push(`${t}:${a}`); }
    const subsets = (xs: string[]): string[][] =>
      xs.reduce<string[][]>((acc, x) => acc.concat(acc.map((s) => [...s, x])), [[]]);
    const lists = subsets(universe).filter((s) => s.length <= 3);
    for (const a of lists) for (const b of lists) {
      const merged = intersectToolRefs(a, b);
      for (const t of tools) for (const act of actions) {
        const both = isToolAllowlisted(a, t, act) && isToolAllowlisted(b, t, act);
        expect(isToolAllowlisted(merged, t, act)).toBe(both);
      }
    }
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd apps/api && npx vitest run src/services/aiAgents/toolAllowlist.test.ts`
Expected: FAIL — `intersectToolRefs` is not exported.

- [ ] **Step 3: Implement**

Append to `toolAllowlist.ts`:

```ts
/**
 * Intersection of two allowlists under `isToolAllowlisted` semantics. A bare
 * `tool` entry is a wildcard over every action, so `tool` ∩ `tool:x` is
 * `tool:x`, not ∅ (the plain string intersection the merge used before
 * silently emptied any org row that scoped what its partner left bare). A
 * bare entry survives only when BOTH sides carry it bare. Order: `a`'s
 * survivors first, then `b`'s, de-duplicated.
 */
export function intersectToolRefs(a: readonly string[], b: readonly string[]): string[] {
  const out = new Set<string>();
  const keep = (from: readonly string[], other: readonly string[]) => {
    for (const entry of from) {
      const colon = entry.indexOf(':');
      const tool = colon === -1 ? entry : entry.slice(0, colon);
      if (colon === -1) {
        if (other.includes(tool)) out.add(tool);
      } else if (other.includes(entry) || other.includes(tool)) {
        out.add(entry);
      }
    }
  };
  keep(a, b);
  keep(b, a);
  return [...out];
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd apps/api && npx vitest run src/services/aiAgents/toolAllowlist.test.ts`
Expected: PASS (4 tests).

- [ ] **Step 5: Commit**

```bash
git add apps/api/src/services/aiAgents/toolAllowlist.ts apps/api/src/services/aiAgents/toolAllowlist.test.ts
git commit -m "feat(ai-agents): wildcard-aware intersectToolRefs for allowlist merging"
```

### Task 2: Use `intersectToolRefs` in the effective-policy merge

**Files:**
- Modify: `apps/api/src/services/aiAgents/effectivePolicy.ts:230` and `:295-298`
- Modify: `apps/api/src/services/aiAgents/effectivePolicy.test.ts`

**Interfaces:**
- Consumes: `intersectToolRefs` (Task 1).
- Produces: `mergeAgentPolicies(...).effective.toolAllowlist` and `.effective.actAssets.supervisedActionKeys` honour bare-as-wildcard.

- [ ] **Step 1: Write the failing test** (append inside the existing `mergeAgentPolicies` describe, using the file's `policy()` helper and `KEY_A = 'manage_services:restart'`)

```ts
it('toolAllowlist: an org row that scopes what the partner left bare keeps the scoped entries (not ∅)', () => {
  const partner = policy({ toolAllowlist: ['manage_services', 'run_script'] });
  const org = policy({ toolAllowlist: ['manage_services:restart', 'run_script'] });
  expect(mergeAgentPolicies(partner, org, { allowedModels: null }).effective.toolAllowlist)
    .toEqual(['run_script', 'manage_services:restart']);
});

it('supervisedActionKeys: bare partner key is a ceiling over its actions', () => {
  const partner = policy({ actAssets: { scriptIds: [], supervisedActionKeys: ['manage_services'] } });
  const org = policy({ actAssets: { scriptIds: [], supervisedActionKeys: [KEY_A] } });
  expect(mergeAgentPolicies(partner, org, { allowedModels: null }).effective.actAssets.supervisedActionKeys)
    .toEqual([KEY_A]);
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `cd apps/api && npx vitest run src/services/aiAgents/effectivePolicy.test.ts`
Expected: the two new tests FAIL with `[]` / `['run_script']`.

- [ ] **Step 3: Implement** — in `effectivePolicy.ts` add `import { intersectToolRefs } from './toolAllowlist';` and change the two call sites:

```ts
// line 230
toolAllowlist: pick('toolAllowlist', intersectToolRefs(partner.toolAllowlist, org.toolAllowlist), 'merged'),
// lines 295-298
supervisedActionKeys: intersectToolRefs(
  partner.actAssets.supervisedActionKeys ?? [],
  org.actAssets.supervisedActionKeys ?? [],
),
```
Leave `scriptIds` and every trigger list on the plain `intersect` (they are ids, not tool refs).

- [ ] **Step 4: Run the whole file plus the ceiling contract**

Run: `cd apps/api && npx vitest run src/services/aiAgents/effectivePolicy.test.ts src/services/aiAgents/effectivePolicy.ceiling.contract.test.ts`
Expected: PASS. If an existing assertion expected `[]` for a bare-vs-scoped case, that assertion encoded the bug — update it and say so in the commit body.

- [ ] **Step 5: Commit**

```bash
git add apps/api/src/services/aiAgents/effectivePolicy.ts apps/api/src/services/aiAgents/effectivePolicy.test.ts
git commit -m "fix(ai-agents): merge toolAllowlist/supervisedActionKeys with bare-as-wildcard semantics"
```

### Task 3: Agent tool catalog module + contract test

**Files:**
- Create: `apps/api/src/services/aiAgents/agentToolCatalog.ts`
- Create: `apps/api/src/services/aiAgents/agentToolCatalog.contract.test.ts`
- Modify: `packages/shared/src/types/aiAgents.ts` (append wire types)

**Interfaces:**
- Consumes: `aiTools` (`services/aiToolNames.ts`), `getToolDefinitions` (`services/aiTools.ts`), `TOOL_TIERS` (`services/aiAgentSdkTools.ts`), `m365ToolTiers`, `googleToolTiers`, `checkGuardrails`, `TOOL_ACTION_INPUT_KEYS`, `TIER2_READONLY_TOOLS`, `AGENT_HUMAN_ONLY_TOOLS` (`services/aiGuardrails.ts`), `toolInputSchemas` (`services/aiToolSchemas.ts`), `isPolicyDecidableKey` (`services/actionIntents/policyDecidable.ts`), `resolveActOperation` (`services/aiAgents/actManifest.ts`).
- Produces:
  ```ts
  export type AgentCapabilityId = 'alerts_monitoring' | 'services_startup' | 'files_disk' | 'scripts_commands' | 'tickets' | 'patching_software' | 'security_response' | 'backup_recovery' | 'config_policies' | 'network' | 'remote_access' | 'endpoint_agent' | 'automations_reports' | 'business' | 'tenancy';
  export const AGENT_CAPABILITIES: readonly { id: AgentCapabilityId; tone: 'standard' | 'high' }[];
  export const TOOL_CAPABILITY: Readonly<Record<string, AgentCapabilityId>>;
  export const AGENT_KIND_PRESETS: Readonly<Record<AiAgentKind, readonly string[]>>;
  export function listAgentReachableTools(): string[];
  export function listUnreachableRegisteredTools(): string[];
  export function buildAgentToolCatalog(): AgentToolCatalogDto;   // memoised
  ```
  and in shared:
  ```ts
  export interface AgentToolOperationDto { key: string; action: string | null; tier: 1 | 2 | 3; readOnly: boolean; policyDecidable: boolean; actEligible: boolean }
  export interface AgentToolCatalogToolDto { name: string; capability: string; tier: 1 | 2 | 3; readOnly: boolean; operations: AgentToolOperationDto[] }
  export interface AgentToolCatalogDto { capabilities: { id: string; tone: 'standard' | 'high' }[]; tools: AgentToolCatalogToolDto[]; presets: Record<AiAgentKind, string[]> }
  export interface AgentCeilingDto { toolAllowlist: string[]; supervisedActionKeys: string[] }
  ```

- [ ] **Step 1: Add the shared wire types** — append the four interfaces above to `packages/shared/src/types/aiAgents.ts` (next to `AiAgentDto`). No test; they are types only.

- [ ] **Step 2: Write the failing contract test**

```ts
// apps/api/src/services/aiAgents/agentToolCatalog.contract.test.ts
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
      if (tool.operations.length === 1 && tool.operations[0].action === null) expect(tool.operations[0].key).toBe(tool.name);
    }
  });
});
```

- [ ] **Step 3: Run to verify it fails**

Run: `cd apps/api && npx vitest run src/services/aiAgents/agentToolCatalog.contract.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 4: Implement the module**

```ts
// apps/api/src/services/aiAgents/agentToolCatalog.ts
/**
 * The agent-facing tool catalog: which tools an ai_agent principal can reach,
 * how they group into capabilities for the picker, and what each operation
 * resolves to under the guardrails. Everything security-relevant here is
 * DERIVED (checkGuardrails, POLICY_DECIDABLE_TIER3, ACT_MANIFEST); only the
 * capability placement and kind presets are authored. Contract test:
 * agentToolCatalog.contract.test.ts.
 */
import type { AiAgentKind, AgentToolCatalogDto, AgentToolCatalogToolDto, AgentToolOperationDto } from '@breeze/shared/types/aiAgents';
import { aiTools } from '../aiToolNames';
import { getToolDefinitions } from '../aiTools';
import { TOOL_TIERS } from '../aiAgentSdkTools';
import { m365ToolTiers } from '../aiToolsM365';
import { googleToolTiers } from '../aiToolsGoogle';
import { AGENT_HUMAN_ONLY_TOOLS, TIER2_READONLY_TOOLS, TOOL_ACTION_INPUT_KEYS, checkGuardrails } from '../aiGuardrails';
import { toolInputSchemas } from '../aiToolSchemas';
import { isPolicyDecidableKey } from '../actionIntents/policyDecidable';
import { resolveActOperation } from './actManifest';

export type AgentCapabilityId =
  | 'alerts_monitoring' | 'services_startup' | 'files_disk' | 'scripts_commands' | 'tickets'
  | 'patching_software' | 'security_response' | 'backup_recovery' | 'config_policies' | 'network'
  | 'remote_access' | 'endpoint_agent' | 'automations_reports' | 'business' | 'tenancy';

export const AGENT_CAPABILITIES: readonly { id: AgentCapabilityId; tone: 'standard' | 'high' }[] = [
  { id: 'alerts_monitoring', tone: 'standard' },
  { id: 'services_startup', tone: 'standard' },
  { id: 'files_disk', tone: 'standard' },
  { id: 'scripts_commands', tone: 'standard' },
  { id: 'tickets', tone: 'standard' },
  { id: 'patching_software', tone: 'standard' },
  { id: 'security_response', tone: 'high' },
  { id: 'backup_recovery', tone: 'high' },
  { id: 'config_policies', tone: 'standard' },
  { id: 'network', tone: 'standard' },
  { id: 'remote_access', tone: 'standard' },
  { id: 'endpoint_agent', tone: 'standard' },
  { id: 'automations_reports', tone: 'standard' },
  { id: 'business', tone: 'standard' },
  { id: 'tenancy', tone: 'high' },
];

/**
 * Every registered headless tool → capability. The contract test fails on a
 * registered tool missing here or an entry naming an unregistered tool, so
 * adding a tool means adding a line. Read-only tools are mapped too (the
 * picker lists them under "always on").
 */
export const TOOL_CAPABILITY: Readonly<Record<string, AgentCapabilityId>> = {
  // alerts_monitoring
  manage_alerts: 'alerts_monitoring', manage_alert_rules: 'alerts_monitoring', manage_monitors: 'alerts_monitoring',
  manage_service_monitors: 'alerts_monitoring', manage_notification_channels: 'alerts_monitoring', query_monitors: 'alerts_monitoring',
  get_service_monitoring_status: 'alerts_monitoring', get_fleet_findings: 'alerts_monitoring',
  // services_startup
  manage_services: 'services_startup', manage_startup_items: 'services_startup',
  // files_disk
  file_operations: 'files_disk', disk_cleanup: 'files_disk', analyze_disk_usage: 'files_disk',
  // scripts_commands
  run_script: 'scripts_commands', execute_command: 'scripts_commands', execute_playbook: 'scripts_commands',
  cancel_script_execution: 'scripts_commands', manage_processes: 'scripts_commands', manage_scheduled_tasks: 'scripts_commands',
  registry_operations: 'scripts_commands', list_scripts: 'scripts_commands', get_script_details: 'scripts_commands',
  list_script_templates: 'scripts_commands', get_script_execution_history: 'scripts_commands', get_script_execution: 'scripts_commands',
  search_script_library: 'scripts_commands', list_playbooks: 'scripts_commands', get_playbook_history: 'scripts_commands',
  // ... continue for EVERY name in aiTools.keys(): the implementer enumerates
  // `[...aiTools.keys()].sort()` and assigns each per spec §4.1's table
  // (devices/inventory reads → automations_reports; backup*/hyperv*/mssql*/dr*/vault*/sla* → backup_recovery;
  // security*/s1_*/huntress*/cis*/vulnerability*/user_risk*/pam (request_elevation…) → security_response;
  // configuration_policy*/dns/browser/peripheral policies → config_policies; network* → network;
  // remote/screen/computer_control → remote_access; agent logs/versions/upgrade/restart/pprof → endpoint_agent;
  // automations/reports/groups/tags/saved_filters/custom_fields/analytics/docs/audit → automations_reports;
  // quotes/invoices/contracts/catalog/billing → business; organizations/delete_tenant/webhooks/psa/integrations → tenancy;
  // tickets → tickets; patches/deployments/update_rings/software*/compliance/vulnerability remediation → patching_software).
};

export const AGENT_KIND_PRESETS: Readonly<Record<AiAgentKind, readonly string[]>> = {
  triage: ['manage_alerts:acknowledge', 'manage_alerts:resolve', 'manage_services:restart', 'manage_startup_items:disable', 'disk_cleanup:execute', 'run_script'],
  patch: ['manage_patches:approve', 'manage_patches:install', 'manage_deployments:start', 'manage_services:restart'],
  helpdesk: ['manage_services:restart', 'disk_cleanup:execute', 'run_script'],
};

function isSessionOnly(name: string): boolean {
  return name in m365ToolTiers || name in googleToolTiers;
}

export function listAgentReachableTools(): string[] {
  return [...aiTools.keys()]
    .filter((name) => name in TOOL_TIERS && !isSessionOnly(name) && !AGENT_HUMAN_ONLY_TOOLS.has(name))
    .sort();
}

export function listUnreachableRegisteredTools(): string[] {
  return [...aiTools.keys()].filter((name) => !(name in TOOL_TIERS)).sort();
}

/** Same two sources as aiGuardrails.approvalScope.contract.test.ts, unioned. */
function discriminatorValues(toolName: string): string[] | null {
  const key = TOOL_ACTION_INPUT_KEYS[toolName] ?? 'action';
  const values = new Set<string>();
  const definition = getToolDefinitions().find((d) => d.name === toolName);
  const props = (definition?.input_schema as { properties?: Record<string, unknown> } | undefined)?.properties;
  const jsonEnum = (props?.[key] as { enum?: unknown[] } | undefined)?.enum;
  if (Array.isArray(jsonEnum)) for (const v of jsonEnum) if (typeof v === 'string') values.add(v);
  const zodField = (toolInputSchemas[toolName] as { shape?: Record<string, unknown> } | undefined)?.shape?.[key];
  const zodEnum = (zodField as { options?: unknown[] } | undefined)?.options;
  if (Array.isArray(zodEnum)) for (const v of zodEnum) if (typeof v === 'string') values.add(v);
  return values.size > 0 ? [...values] : null;
}

function resolveOperation(toolName: string, action: string | null): AgentToolOperationDto {
  const key = TOOL_ACTION_INPUT_KEYS[toolName] ?? 'action';
  const input: Record<string, unknown> = action === null ? {} : { [key]: action };
  const check = checkGuardrails(toolName, input);
  const tier = check.tier === 4 ? 3 : check.tier; // tier 4 never occurs for a registered tool; clamp for the DTO
  const readOnly = tier === 1 || (tier === 2 && (check.readOnly === true || TIER2_READONLY_TOOLS.has(toolName)));
  const opKey = action === null ? toolName : `${toolName}:${action}`;
  return {
    key: opKey,
    action,
    tier,
    readOnly,
    policyDecidable: isPolicyDecidableKey(opKey),
    actEligible: resolveActOperation(toolName, input)?.toolName === toolName && !readOnly,
  };
}

let memo: AgentToolCatalogDto | null = null;

export function buildAgentToolCatalog(): AgentToolCatalogDto {
  if (memo) return memo;
  const tools: AgentToolCatalogToolDto[] = listAgentReachableTools().map((name) => {
    const actions = discriminatorValues(name);
    const operations = actions ? actions.sort().map((a) => resolveOperation(name, a)) : [resolveOperation(name, null)];
    const base = aiTools.get(name)!.tier;
    const tier = base === 4 ? 3 : base;
    return {
      name,
      capability: TOOL_CAPABILITY[name],
      tier,
      readOnly: operations.every((op) => op.readOnly),
      operations,
    };
  });
  memo = {
    capabilities: AGENT_CAPABILITIES.map((c) => ({ ...c })),
    tools,
    presets: { triage: [...AGENT_KIND_PRESETS.triage], patch: [...AGENT_KIND_PRESETS.patch], helpdesk: [...AGENT_KIND_PRESETS.helpdesk] },
  };
  return memo;
}

/** Test seam: registries are static per process, but the test file order is not. */
export function resetAgentToolCatalogMemo(): void { memo = null; }
```

Completing `TOOL_CAPABILITY`: run `cd apps/api && npx tsx -e "import('./src/services/aiTools').then(()=>import('./src/services/aiToolNames')).then(m=>console.log([...m.aiTools.keys()].sort().join('\n')))"` and assign every name. Read-only tools go in the capability their mutating siblings use (e.g. `query_backups` → `backup_recovery`). When unsure, place by the RBAC `resource` in `TOOL_PERMISSIONS` (`aiGuardrails.ts:558`).

- [ ] **Step 5: Run the contract test**

Run: `cd apps/api && npx vitest run src/services/aiAgents/agentToolCatalog.contract.test.ts -u` (first run writes the unreachable-set snapshot; commit it), then again without `-u`.
Expected: PASS. If `execute_command`'s `restart_service` check fails, confirm the discriminator resolution used `commandType` (see `TOOL_ACTION_INPUT_KEYS`).

- [ ] **Step 6: Typecheck** — `cd apps/api && npx tsc --noEmit -p tsconfig.json` and `cd packages/shared && npx tsc --noEmit`.

- [ ] **Step 7: Commit**

```bash
git add apps/api/src/services/aiAgents/agentToolCatalog.ts apps/api/src/services/aiAgents/agentToolCatalog.contract.test.ts apps/api/src/services/aiAgents/__snapshots__ packages/shared/src/types/aiAgents.ts
git commit -m "feat(ai-agents): derive an agent-reachable tool catalog with capability groups and kind presets"
```

### Task 4: `GET /ai/agents/tool-catalog` and `GET /ai/agents/ceiling`

**Files:**
- Modify: `apps/api/src/routes/aiAgents.ts` (insert both routes directly after the `/policy-decidable-keys` route at line 403)
- Modify: `apps/api/src/services/aiAgents/effectivePolicy.ts` (add `loadPartnerBaselineCeiling`)
- Modify: `apps/api/src/routes/aiAgents.test.ts`

**Interfaces:**
- Consumes: `buildAgentToolCatalog` (Task 3), `readWithPartnerAxisVisibility` (`db/partnerAxisRead.ts:49`), `AI_AGENT_KINDS`.
- Produces:
  - `GET /tool-catalog` → `{ data: AgentToolCatalogDto }`, header `Cache-Control: private, max-age=300`.
  - `GET /ceiling?kind=triage|patch|helpdesk` → `{ data: AgentCeilingDto | null }`; `null` for partner/system scope or when no live baseline exists.
  - `loadPartnerBaselineCeiling(partnerId: string | null, kind: AiAgentKind): Promise<AgentCeilingDto | null>`.

- [ ] **Step 1: Write the failing route tests** (append to `routes/aiAgents.test.ts`, using its `buildApp` and `hasPermMock`; mock the service with the file's existing `vi.mock('../services/aiAgents/effectivePolicy', …)` pattern, adding `loadPartnerBaselineCeiling: vi.fn()`)

```ts
describe('GET /ai-agents/tool-catalog', () => {
  it('returns capabilities, reachable tools with operations, and kind presets', async () => {
    const res = await buildApp().request('/ai-agents/tool-catalog');
    expect(res.status).toBe(200);
    expect(res.headers.get('cache-control')).toBe('private, max-age=300');
    const body = (await res.json()) as { data: { capabilities: unknown[]; tools: Array<{ name: string; operations: unknown[] }>; presets: Record<string, string[]> } };
    expect(body.data.capabilities.length).toBeGreaterThan(10);
    expect(body.data.tools.some((t) => t.name === 'manage_services')).toBe(true);
    expect(body.data.tools.some((t) => t.name === 'manage_ai_agents')).toBe(false);
    expect(body.data.presets.triage).toContain('manage_services:restart');
  });

  it('is gated on ai_agents:read', async () => {
    hasPermMock.mockReturnValue(false);
    expect((await buildApp().request('/ai-agents/tool-catalog')).status).toBe(403);
  });
});

describe('GET /ai-agents/ceiling', () => {
  it('projects the partner baseline allowlist for an org session', async () => {
    vi.mocked(loadPartnerBaselineCeiling).mockResolvedValueOnce({ toolAllowlist: ['manage_services'], supervisedActionKeys: [] });
    const res = await buildApp(false, { partnerId: PARTNER_ID }).request('/ai-agents/ceiling?kind=triage');
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ data: { toolAllowlist: ['manage_services'], supervisedActionKeys: [] } });
    expect(loadPartnerBaselineCeiling).toHaveBeenCalledWith(PARTNER_ID, 'triage');
  });

  it('returns null for a partner-scope session (the partner row IS the ceiling)', async () => {
    const res = await buildApp(false, { scope: 'partner', partnerId: PARTNER_ID, orgId: null }).request('/ai-agents/ceiling?kind=triage');
    expect(await res.json()).toEqual({ data: null });
    expect(loadPartnerBaselineCeiling).not.toHaveBeenCalled();
  });

  it('rejects an unknown kind', async () => {
    expect((await buildApp().request('/ai-agents/ceiling?kind=nope')).status).toBe(400);
  });
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `cd apps/api && npx vitest run src/routes/aiAgents.test.ts -t "tool-catalog|ceiling"`
Expected: FAIL with 404s.

- [ ] **Step 3: Implement** — in `effectivePolicy.ts`, beside `loadPartnerBaselineKinds`:

```ts
/**
 * The partner-wide baseline's tool ceiling for ONE kind, projected for an
 * org-scoped caller that cannot read the partner row itself. Same
 * partner-axis read as `loadPartnerBaselineKinds`; nothing but the two
 * allowlists leaves this function.
 */
export async function loadPartnerBaselineCeiling(
  partnerId: string | null,
  kind: AiAgentKind,
): Promise<AgentCeilingDto | null> {
  if (!partnerId) return null;
  const rows = await readWithPartnerAxisVisibility(() =>
    db
      .select({ toolAllowlist: aiAgents.toolAllowlist, actAssets: aiAgents.actAssets })
      .from(aiAgents)
      .where(and(
        eq(aiAgents.partnerId, partnerId),
        isNull(aiAgents.orgId),
        eq(aiAgents.kind, kind),
        isNull(aiAgents.disabledAt),
      ))
      .limit(1));
  const row = rows[0];
  if (!row) return null;
  const actAssets = aiAgentActAssetsSchema.parse(row.actAssets ?? {});
  return {
    toolAllowlist: Array.isArray(row.toolAllowlist) ? [...row.toolAllowlist] : [],
    supervisedActionKeys: actAssets.supervisedActionKeys ?? [],
  };
}
```

In `routes/aiAgents.ts` after line 403:

```ts
aiAgentsRoutes.get('/tool-catalog', scopes, requireAiRead, async (c) => {
  c.header('Cache-Control', 'private, max-age=300');
  return c.json({ data: buildAgentToolCatalog() });
});

aiAgentsRoutes.get(
  '/ceiling',
  scopes,
  requireAiRead,
  zValidator('query', z.object({ kind: z.enum(AI_AGENT_KINDS) })),
  async (c) => {
    const auth = c.get('auth');
    if (auth.scope !== 'organization') return c.json({ data: null });
    const { kind } = c.req.valid('query');
    return c.json({ data: await loadPartnerBaselineCeiling(auth.partnerId, kind) });
  },
);
```
Add the imports (`buildAgentToolCatalog` from `../services/aiAgents/agentToolCatalog`, `loadPartnerBaselineCeiling` from `../services/aiAgents/effectivePolicy`).

- [ ] **Step 4: Run route tests**

Run: `cd apps/api && npx vitest run src/routes/aiAgents.test.ts`
Expected: PASS (whole file).

- [ ] **Step 5: Commit**

```bash
git add apps/api/src/routes/aiAgents.ts apps/api/src/routes/aiAgents.test.ts apps/api/src/services/aiAgents/effectivePolicy.ts
git commit -m "feat(ai-agents): GET /tool-catalog and GET /ceiling for the capability picker"
```

### Task 5: Supervised keys on org rows are grant-only

**Files:**
- Modify: `apps/api/src/services/aiAgents/agentService.ts` (error class next to `InvalidSupervisedActionKeysError` at line 64; guard next to `assertSupervisedActionKeysValid` at 143; wire at 531 and 619)
- Modify: `apps/api/src/routes/aiAgents.ts:213` (422 mapping)
- Modify: `apps/api/src/services/aiAgents/agentService.test.ts`

**Interfaces:**
- Produces: `class SupervisedKeysGrantOnlyError extends Error { code: 'supervised_keys_grant_only'; rejected: { key: string; reason: 'grant_only' }[] }`; `assertOrgRowSupervisedKeysGrantOnly(owner: AgentOwner, existing: readonly string[], next: readonly string[] | undefined): void` (exported for tests).

- [ ] **Step 1: Write the failing tests** (append to `agentService.test.ts`)

```ts
import { assertOrgRowSupervisedKeysGrantOnly, SupervisedKeysGrantOnlyError } from './agentService';

describe('assertOrgRowSupervisedKeysGrantOnly (spec §4.4)', () => {
  const org = { orgId: 'org-1', partnerId: 'p-1' };
  const partner = { orgId: null, partnerId: 'p-1' };

  it('rejects an org row adding a key it does not already hold', () => {
    expect(() => assertOrgRowSupervisedKeysGrantOnly(org, [], ['manage_services:restart']))
      .toThrow(SupervisedKeysGrantOnlyError);
    try { assertOrgRowSupervisedKeysGrantOnly(org, ['manage_services:stop'], ['manage_services:stop', 'manage_services:restart']); }
    catch (e) { expect((e as SupervisedKeysGrantOnlyError).rejected).toEqual([{ key: 'manage_services:restart', reason: 'grant_only' }]); }
  });

  it('allows an org row to keep or remove keys', () => {
    expect(() => assertOrgRowSupervisedKeysGrantOnly(org, ['manage_services:restart'], ['manage_services:restart'])).not.toThrow();
    expect(() => assertOrgRowSupervisedKeysGrantOnly(org, ['manage_services:restart'], [])).not.toThrow();
    expect(() => assertOrgRowSupervisedKeysGrantOnly(org, ['manage_services:restart'], undefined)).not.toThrow();
  });

  it('leaves partner rows alone (their keys are the ceiling, edited directly)', () => {
    expect(() => assertOrgRowSupervisedKeysGrantOnly(partner, [], ['manage_services:restart'])).not.toThrow();
  });
});
```
Plus one integration-style assertion in the existing `createAgent` describe: creating an org-owned agent with `actAssets.supervisedActionKeys: ['manage_services:restart']` rejects with `SupervisedKeysGrantOnlyError` **before** any insert (assert the insert mock was not called), mirroring the file's existing "rejected key must never be persisted" test shape.

- [ ] **Step 2: Run to verify it fails**

Run: `cd apps/api && npx vitest run src/services/aiAgents/agentService.test.ts -t "grant-only|GrantOnly"`
Expected: FAIL — not exported.

- [ ] **Step 3: Implement**

```ts
// next to InvalidSupervisedActionKeysError
export class SupervisedKeysGrantOnlyError extends Error {
  readonly code = 'supervised_keys_grant_only';
  constructor(public rejected: Array<{ key: string; reason: 'grant_only' }>) {
    super(`supervised_keys_grant_only: ${rejected.map((r) => r.key).join(', ')}`);
    this.name = 'SupervisedKeysGrantOnlyError';
  }
}

/**
 * Spec §4.4: on an ORG row a pre-authorized key goes live only through the
 * four-eyes grant executor (supervisedKeyGrant.ts, direct UPDATE under an
 * advisory lock) — never through create/update. Removals stay open so manual
 * revoke and auto-demotion keep working. Partner rows are the CEILING and are
 * edited directly.
 */
export function assertOrgRowSupervisedKeysGrantOnly(
  owner: AgentOwner,
  existing: readonly string[],
  next: readonly string[] | undefined,
): void {
  if (next === undefined || owner.orgId === null) return;
  const added = next.filter((key) => !existing.includes(key));
  if (added.length > 0) throw new SupervisedKeysGrantOnlyError(added.map((key) => ({ key, reason: 'grant_only' as const })));
}
```
Wire: in `createAgent` after line 531 → `assertOrgRowSupervisedKeysGrantOnly(owner, [], input.actAssets.supervisedActionKeys);`. In `updateAgent` inside the `if (input.actAssets?.supervisedActionKeys !== undefined)` block at 619 → `assertOrgRowSupervisedKeysGrantOnly(owner, stored.actAssets.supervisedActionKeys ?? [], input.actAssets.supervisedActionKeys);`. In `routes/aiAgents.ts` beside line 213:

```ts
if (err instanceof SupervisedKeysGrantOnlyError) {
  return c.json({ error: err.message, code: err.code, rejected: err.rejected }, 422);
}
```

- [ ] **Step 4: Run the agent service, grant, demote and graduation suites**

Run: `cd apps/api && npx vitest run src/services/aiAgents/agentService.test.ts src/services/aiAgents/supervisedKeyGrant.test.ts src/services/aiAgents/supervisedKeyDemote.test.ts src/services/aiAgents/graduationService.test.ts src/routes/aiAgents.test.ts`
Expected: PASS. The grant executor writes with a direct `.update(aiAgents)` (`supervisedKeyGrant.ts:417`), so it is unaffected; if any test creates an org agent WITH keys as fixture setup, change that fixture to a partner row or seed the row directly.

- [ ] **Step 5: Commit**

```bash
git add apps/api/src/services/aiAgents/agentService.ts apps/api/src/services/aiAgents/agentService.test.ts apps/api/src/routes/aiAgents.ts
git commit -m "fix(ai-agents): org rows cannot add supervisedActionKeys outside the grant executor"
```

### Task 6: W01 verification, review, PR

- [ ] **Step 1:** `cd apps/api && npx tsc --noEmit` and `npx vitest run src/services/aiAgents src/routes/aiAgents.test.ts src/services/aiGuardrails` — all green.
- [ ] **Step 2:** `pnpm lint` at repo root — clean.
- [ ] **Step 3:** Run the integration suites that touch these files against a real DB: `cd apps/api && npx vitest run -c vitest.integration.config.ts src/__tests__/integration/aiAgents` (whatever exists under that prefix) — green or explain.
- [ ] **Step 4:** Push, open PR titled `feat(ai-agents): agent tool catalog, ceiling projection, wildcard policy merge, grant-only supervised keys (W01)` with `Closes #<W01 sub-issue>`, then run `/code-review` once (high blast radius: auth/permissions). Fix confirmed findings inline.
- [ ] **Step 5:** Merge on green (`gh pr merge --squash --admin`).

---

# Wave W02 — Web: CapabilityPicker in the existing drawer

### Task 7: Pure selection model (`capabilityModel.ts`)

**Files:**
- Create: `apps/web/src/components/settings/aiAgents/capabilityModel.ts`
- Create: `apps/web/src/components/settings/aiAgents/capabilityModel.test.ts`

**Interfaces:**
- Consumes: `AgentToolCatalogDto`, `AgentCeilingDto` from `@breeze/shared/types/aiAgents`.
- Produces:
  ```ts
  export type OperationOutcome = 'approval_request' | 'logged_proposal' | 'unattended';
  export interface SelectionState { selected: Set<string> }            // operation keys (tool or tool:action)
  export function entriesToSelection(entries: string[], catalog: AgentToolCatalogDto): { selected: Set<string>; unrecognised: { entry: string; reason: 'unknown_tool' | 'unreachable_tool' | 'bare_multi_op' }[] };
  export function selectionToEntries(selected: Set<string>, catalog: AgentToolCatalogDto): string[];   // persistence rule
  export function capabilityState(capabilityId: string, selected: Set<string>, catalog: AgentToolCatalogDto): { checked: 'all' | 'some' | 'none'; selectedCount: number; totalCount: number };
  export function outcomeFor(op: AgentToolOperationDto, mode: 'off' | 'shadow' | 'act'): OperationOutcome;
  export function isWithinCeiling(opKey: string, ceiling: AgentCeilingDto | null): boolean;   // uses bare-as-wildcard
  export function summarise(selected: Set<string>, catalog: AgentToolCatalogDto, mode: 'off'|'shadow'|'act'): { operations: number; capabilities: number; approvalRequests: number; loggedProposals: number; unattended: string[]; readOnlyToolCount: number };
  ```

- [ ] **Step 1: Write the failing tests**

```ts
// capabilityModel.test.ts
import { describe, it, expect } from 'vitest';
import type { AgentToolCatalogDto } from '@breeze/shared/types/aiAgents';
import { entriesToSelection, selectionToEntries, capabilityState, outcomeFor, isWithinCeiling, summarise } from './capabilityModel';

const catalog: AgentToolCatalogDto = {
  capabilities: [{ id: 'services_startup', tone: 'standard' }, { id: 'scripts_commands', tone: 'standard' }],
  tools: [
    { name: 'manage_services', capability: 'services_startup', tier: 3, readOnly: false, operations: [
      { key: 'manage_services:list', action: 'list', tier: 2, readOnly: true, policyDecidable: false, actEligible: false },
      { key: 'manage_services:restart', action: 'restart', tier: 3, readOnly: false, policyDecidable: true, actEligible: true },
      { key: 'manage_services:stop', action: 'stop', tier: 3, readOnly: false, policyDecidable: true, actEligible: false },
    ] },
    { name: 'run_script', capability: 'scripts_commands', tier: 3, readOnly: false, operations: [
      { key: 'run_script', action: null, tier: 3, readOnly: false, policyDecidable: false, actEligible: true },
    ] },
    { name: 'query_devices', capability: 'scripts_commands', tier: 1, readOnly: true, operations: [
      { key: 'query_devices', action: null, tier: 1, readOnly: true, policyDecidable: false, actEligible: false },
    ] },
  ],
  presets: { triage: ['manage_services:restart'], patch: [], helpdesk: [] },
};

describe('capabilityModel', () => {
  it('expands a bare multi-operation entry into its mutating operations and flags it', () => {
    const r = entriesToSelection(['manage_services', 'run_script', 'restart_spooler'], catalog);
    expect([...r.selected].sort()).toEqual(['manage_services:restart', 'manage_services:stop', 'run_script']);
    expect(r.unrecognised).toEqual([
      { entry: 'manage_services', reason: 'bare_multi_op' },
      { entry: 'restart_spooler', reason: 'unknown_tool' },
    ]);
  });

  it('never compacts to a bare tool, even when every operation is selected', () => {
    const selected = new Set(['manage_services:restart', 'manage_services:stop', 'run_script']);
    expect(selectionToEntries(selected, catalog)).toEqual(['manage_services:restart', 'manage_services:stop', 'run_script']);
  });

  it('reports capability tri-state over mutating operations only', () => {
    expect(capabilityState('services_startup', new Set(['manage_services:restart']), catalog))
      .toEqual({ checked: 'some', selectedCount: 1, totalCount: 2 });
    expect(capabilityState('services_startup', new Set(['manage_services:restart', 'manage_services:stop']), catalog).checked).toBe('all');
    expect(capabilityState('services_startup', new Set(), catalog).checked).toBe('none');
  });

  it('maps tier and mode to an outcome', () => {
    const restart = catalog.tools[0].operations[1];
    const list = catalog.tools[0].operations[0];
    expect(outcomeFor(restart, 'shadow')).toBe('approval_request');
    expect(outcomeFor(restart, 'act')).toBe('unattended');
    expect(outcomeFor({ ...restart, actEligible: false }, 'act')).toBe('approval_request');
    expect(outcomeFor({ ...list, readOnly: false }, 'shadow')).toBe('logged_proposal');
  });

  it('treats a bare ceiling entry as a wildcard', () => {
    const ceiling = { toolAllowlist: ['manage_services'], supervisedActionKeys: [] };
    expect(isWithinCeiling('manage_services:stop', ceiling)).toBe(true);
    expect(isWithinCeiling('run_script', ceiling)).toBe(false);
    expect(isWithinCeiling('run_script', null)).toBe(true);
  });

  it('summarises counts for the footer sentence', () => {
    expect(summarise(new Set(['manage_services:restart', 'run_script']), catalog, 'shadow'))
      .toEqual({ operations: 2, capabilities: 2, approvalRequests: 2, loggedProposals: 0, unattended: [], readOnlyToolCount: 1 });
  });
});
```

- [ ] **Step 2: Run to verify it fails** — `cd apps/web && npx vitest run src/components/settings/aiAgents/capabilityModel.test.ts` → module not found.

- [ ] **Step 3: Implement**

```ts
// capabilityModel.ts
import type { AgentCeilingDto, AgentToolCatalogDto, AgentToolOperationDto } from '@breeze/shared/types/aiAgents';

export type OperationOutcome = 'approval_request' | 'logged_proposal' | 'unattended';
export type AgentModeLike = 'off' | 'shadow' | 'act';
export type UnrecognisedReason = 'unknown_tool' | 'unreachable_tool' | 'bare_multi_op';

const mutating = (tool: AgentToolCatalogDto['tools'][number]) => tool.operations.filter((op) => !op.readOnly);

export function entriesToSelection(entries: string[], catalog: AgentToolCatalogDto) {
  const byName = new Map(catalog.tools.map((t) => [t.name, t]));
  const opKeys = new Set(catalog.tools.flatMap((t) => t.operations.map((op) => op.key)));
  const selected = new Set<string>();
  const unrecognised: { entry: string; reason: UnrecognisedReason }[] = [];
  for (const entry of entries) {
    const colon = entry.indexOf(':');
    const toolName = colon === -1 ? entry : entry.slice(0, colon);
    const tool = byName.get(toolName);
    if (!tool) { unrecognised.push({ entry, reason: 'unknown_tool' }); continue; }
    if (colon === -1) {
      const ops = mutating(tool);
      if (ops.length === 1 && ops[0].action === null) { selected.add(ops[0].key); continue; }
      for (const op of ops) selected.add(op.key);
      unrecognised.push({ entry, reason: 'bare_multi_op' });
      continue;
    }
    if (opKeys.has(entry)) selected.add(entry); else unrecognised.push({ entry, reason: 'unknown_tool' });
  }
  return { selected, unrecognised };
}

export function selectionToEntries(selected: Set<string>, catalog: AgentToolCatalogDto): string[] {
  const order = catalog.tools.flatMap((t) => t.operations.map((op) => op.key));
  return order.filter((key) => selected.has(key));
}

export function capabilityState(capabilityId: string, selected: Set<string>, catalog: AgentToolCatalogDto) {
  const ops = catalog.tools.filter((t) => t.capability === capabilityId).flatMap(mutating);
  const selectedCount = ops.filter((op) => selected.has(op.key)).length;
  const checked = selectedCount === 0 ? 'none' : selectedCount === ops.length ? 'all' : 'some';
  return { checked, selectedCount, totalCount: ops.length } as const;
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

export function summarise(selected: Set<string>, catalog: AgentToolCatalogDto, mode: AgentModeLike) {
  const caps = new Set<string>();
  let approvalRequests = 0, loggedProposals = 0;
  const unattended: string[] = [];
  for (const tool of catalog.tools) for (const op of tool.operations) {
    if (!selected.has(op.key) || op.readOnly) continue;
    caps.add(tool.capability);
    const outcome = outcomeFor(op, mode);
    if (outcome === 'approval_request') approvalRequests++;
    else if (outcome === 'logged_proposal') loggedProposals++;
    else unattended.push(op.key);
  }
  return {
    operations: approvalRequests + loggedProposals + unattended.length,
    capabilities: caps.size,
    approvalRequests, loggedProposals, unattended,
    readOnlyToolCount: catalog.tools.filter((t) => t.readOnly).length,
  };
}
```

- [ ] **Step 4: Run to green**, then **Step 5: Commit** `feat(web): capability selection model for the AI agent picker`.

### Task 8: `useAgentToolCatalog` hook and i18n catalog strings

**Files:**
- Create: `apps/web/src/components/settings/aiAgents/useAgentToolCatalog.ts`
- Modify: `apps/web/src/locales/en/settings.json` (+7 locales) — add `aiAgentsPage.catalog`.

**Interfaces:**
- Produces: `useAgentToolCatalog(opts: { kind: AiAgentKind; ownerScope: 'organization' | 'partner' }): { catalog: AgentToolCatalogDto | null; ceiling: AgentCeilingDto | null; error: boolean }` (fetches `/ai/agents/tool-catalog` once, `/ai/agents/ceiling?kind=` when `ownerScope === 'organization'`; same `fetchWithAuth` + cancelled-flag pattern as the policy-keys effect at `AiAgentForm.tsx:605-631`).
- i18n keys: `aiAgentsPage.catalog.capabilities.<id>.label|description` (15 ids), `aiAgentsPage.catalog.tools.<name>` (every reachable tool; run W01's `listAgentReachableTools()` for the list), `aiAgentsPage.catalog.actions.<tool>.<action>` for every multi-operation tool, plus UI strings: `alwaysOn`, `alwaysOnCount`, `recommendedTitle`, `recommendedApply`, `recommendedApplied`, `searchPlaceholder`, `showToolNames`, `outcome.approval_request`, `outcome.logged_proposal`, `outcome.unattended`, `preauthorizable`, `notInCeiling`, `ceilingNote`, `moreCapabilities`, `unrecognisedTitle`, `unrecognised.unknown_tool|unreachable_tool|bare_multi_op`, `summary.shadow|act|off` (interpolating `{{operations}} {{capabilities}} {{approvalRequests}} {{loggedProposals}}`), `modeLine.shadow|act|off`.

- [ ] **Step 1:** Write the hook with a test that mocks `fetchWithAuth` (mirror `AiAgentForm.test.tsx:91-124`): asserts the catalog URL is fetched once, the ceiling only for organization scope, and `error: true` on a non-OK response.
- [ ] **Step 2:** Add the `en` keys, then add the same keys to the 7 other locales with translations (a subagent may translate; keep product nouns and tool names untranslated). Run `cd apps/web && npx vitest run src/lib/i18n/localeParity.test.ts` → PASS.
- [ ] **Step 3:** Commit `feat(web): agent tool catalog hook and catalog i18n strings`.

### Task 9: `CapabilityPicker` component

**Files:**
- Create: `apps/web/src/components/settings/aiAgents/CapabilityPicker.tsx`
- Create: `apps/web/src/components/settings/aiAgents/CapabilityPicker.test.tsx`

**Interfaces:**
- Props: `{ catalog: AgentToolCatalogDto; ceiling: AgentCeilingDto | null; kind: AiAgentKind; mode: 'off'|'shadow'|'act'; entries: string[]; onChange: (entries: string[]) => void; showToolNames?: boolean }`.
- Renders (spec §4.5): mode line; recommended banner (`Use recommended` adds the preset's keys to the selection); search input; `Show tool names` switch (`role="switch"`, pattern from `AiAgentSchedulesSection.tsx:889`); always-on disclosure (`<details>`); capability rows (`<ul className="divide-y rounded-lg border">`) with a tri-state checkbox (`<input type="checkbox" ref → el.indeterminate = state === 'some'>`, `aria-checked="mixed"`), `aria-expanded` toggle, `x of y operations`; expanded tool groups with operation rows: checkbox, label, mono key (when `showToolNames`), outcome badge (`badgeClass('warning'|'info'|'success')` from `components/aiAgents/statusBadge.ts`), green dot + `title` when `policyDecidable`; rows outside the ceiling are `disabled` with the `notInCeiling` badge; capabilities not touched by the kind preset collapse under `moreCapabilities`; unrecognised entries list with a Remove button per entry (calls `onChange` with the entry removed); footer summary sentence from `summarise`.
- `data-testid`s: `capability-picker`, `capability-row-<id>`, `capability-checkbox-<id>`, `operation-checkbox-<key>`, `capability-picker-search`, `capability-picker-show-names`, `capability-picker-recommended`, `capability-picker-unrecognised`, `capability-picker-summary`.

- [ ] **Step 1: Write failing tests** (render with the Task 7 fixture catalog):
  - clicking `operation-checkbox-manage_services:restart` calls `onChange(['manage_services:restart'])` (persistence rule: scoped entry);
  - clicking `capability-checkbox-services_startup` from none selects `['manage_services:restart','manage_services:stop']`; clicking again clears;
  - with `ceiling.toolAllowlist = ['manage_services:restart']`, the `:stop` checkbox is disabled and the row shows the not-in-ceiling badge;
  - `entries: ['restart_spooler']` renders the unrecognised list and Remove calls `onChange([])`;
  - the summary reads the interpolated counts (`2 operations` after selecting two);
  - the mono key is hidden until the switch is toggled.
- [ ] **Step 2:** Run → FAIL. **Step 3:** Implement (keep it under ~400 lines; put the operation row in `OperationRow.tsx` if it grows). **Step 4:** Run → PASS. **Step 5:** Commit `feat(web): CapabilityPicker`.

### Task 10: Wire the picker into `AiAgentForm`, remove org-row key checkboxes

**Files:**
- Modify: `apps/web/src/components/settings/AiAgentForm.tsx:1368-1420` (Permissions), `:1091-1114` (policy-decide fieldset gating), `:761-776` (422 mapping), `:455-485` (delete `toolSuggestions`/`addSuggestedTool`)
- Modify: `apps/web/src/components/settings/AiAgentForm.test.tsx`

- [ ] **Step 1: Failing tests** — in `AiAgentForm.test.tsx` extend `mockEndpoints` to answer `/ai/agents/tool-catalog` (fixture catalog) and `/ai/agents/ceiling?kind=triage`; assert: (a) the picker renders inside `ai-agent-permissions` and the old `ai-agent-toolallowlist` textarea is gone; (b) saving after selecting `manage_services:restart` POSTs `toolAllowlist: ['manage_services:restart']`; (c) an org-owned agent in act mode renders the policy-decide fieldset **read-only** (no checkboxes, keys listed with a `graduation.grantOnlyHint` sentence); a partner row still renders checkboxes; (d) a 422 `{ code: 'supervised_keys_grant_only', rejected: [...] }` surfaces per-key messages like `invalid_supervised_action_keys` does.
- [ ] **Step 2:** Run → FAIL.
- [ ] **Step 3:** Implement: replace the `listField` textarea + datalist block with `<CapabilityPicker …entries={lines(draft.toolAllowlist)} onChange={(next) => patch({ toolAllowlist: next.join('\n') })} />` (the draft keeps its newline-string shape so the save body at `:685` is untouched); keep `catalog === null` → fall back to the old textarea with the `catalogUnavailable` hint (never block the form on a failed fetch); delete the suggestion state/handlers; in the policy-decide fieldset render checkboxes only when `draft.ownerScope === 'partner'`, otherwise a read-only list; add the `supervised_keys_grant_only` branch beside the `invalid_supervised_action_keys` mapping.
- [ ] **Step 4:** `cd apps/web && npx vitest run src/components/settings/AiAgentForm.test.tsx src/components/settings/aiAgents` → PASS; `npx tsc --noEmit -p apps/web` (or `pnpm --filter @breeze/web typecheck` if defined); `pnpm lint`.
- [ ] **Step 5:** Update `apps/docs/src/content/docs/features/ai-agents.mdx` Permissions paragraph and drop the stale "only Off and Shadow" caution (`update-breeze-docs` skill).
- [ ] **Step 6:** Commit, push, PR `feat(web): capability picker replaces the AI agent tool allowlist textarea (W02)` with `Closes #<W02>`; one `/code-review` round; merge on green.
- [ ] **Step 7:** Browser check on a wt-stack: create a triage agent, apply the preset, save, reopen, confirm the entries round-trip and the ceiling badges appear for an org agent.

---

# Wave W03 — Guided create flow + server-evaluated preview

### Task 11: `POST /ai/agents/preview`

**Files:**
- Create: `apps/api/src/services/aiAgents/agentPreview.ts` + `agentPreview.test.ts`
- Modify: `apps/api/src/routes/aiAgents.ts` (route before `/:id`), `routes/aiAgents.test.ts`
- Modify: `packages/shared/src/validators/aiAgents.ts` (`previewAiAgentSchema = createAiAgentSchema.omit({ name: true }).extend({ name: z.string().optional() })`), `packages/shared/src/types/aiAgents.ts` (`AgentPreviewDto`).

**Interfaces:**
- `buildAgentPreview(input: PreviewAiAgentInput, ceiling: AgentCeilingDto | null, catalog: AgentToolCatalogDto): AgentPreviewDto` — pure.
- `AgentPreviewDto = { mode; kind; readOnlyToolCount: number; operations: { key: string; capability: string; outcome: 'approval_request'|'logged_proposal'|'unattended'; preauthorized: boolean; withinCeiling: boolean }[]; unrecognised: string[]; triggers: { alertSeverities: string[]; respectMaintenanceWindows: boolean; ticketAutonomousWrites: boolean }; protectedResources; limits; recipients }`.
- Route: `POST /preview` (`scopes, requireAiRead`, `zValidator('json', previewAiAgentSchema)`), computes the ceiling via `loadPartnerBaselineCeiling` when the caller is org-scoped and `ownerScope === 'organization'`, applies `intersectToolRefs(ceiling.toolAllowlist, input.toolAllowlist)` for `withinCeiling`, resolves each entry through the catalog (bare entries expand to the tool's mutating operations), outcome via the same rule as `capabilityModel.outcomeFor` but computed server-side (`mode === 'act' && actEligible → unattended; tier 3 → approval_request; else logged_proposal`), `preauthorized = key ∈ intersectToolRefs(ceiling?.supervisedActionKeys ?? [], input.actAssets.supervisedActionKeys ?? [])`.

- [ ] Tests first (pure function: bare entry expansion, ceiling narrowing, act-mode unattended, unrecognised passthrough; route: 200 shape, 400 on invalid body, 403 without read). Implement. Commit `feat(ai-agents): POST /preview evaluates a draft agent policy server-side`.

### Task 12: `AgentSummaryCard`

**Files:** Create `apps/web/src/components/settings/aiAgents/AgentSummaryCard.tsx` + test; locales `aiAgentsPage.summary.*`.

- Props `{ preview: AgentPreviewDto; name: string; orgName: string | null; onEdit?: (section: 'purpose'|'does'|'safety') => void }`. Rows exactly as the mockup: Runs when · Can read · May propose (chips by outcome tone) · Executes unattended · Never touches · Limits · Asks for approval from. Copy per spec §4.6 (no "everything"). Test: renders 8 chips for an 8-operation preview, says "Nothing." for shadow with no unattended ops, lists unattended keys in act mode.
- Commit `feat(web): AgentSummaryCard`.

### Task 13: `AgentCreateFlow` (four steps) and page wiring

**Files:** Create `apps/web/src/components/settings/aiAgents/AgentCreateFlow.tsx`, `steps/PurposeStep.tsx`, `steps/WhatItDoesStep.tsx`, `steps/SafetyStep.tsx`, `steps/ReviewStep.tsx`, tests; modify `AiAgentsPage.tsx` (create button → `setCreating(true)` renders the flow in place of the list; edit keeps the Drawer), `SetupStepper.tsx` (add optional `ariaLabel` prop, default to the current auth string), locales `aiAgentsPage.flow.*`.

- The flow owns one `Draft` (reuse the `Draft` type by exporting it from `AiAgentForm.tsx`, plus `draftFrom` and the save-body builder extracted to `agentDraft.ts` so both the drawer and the flow build the identical POST body — do this extraction FIRST as its own commit with the drawer's tests still green).
- Step 1 = Mode radiogroup (move the existing JSX into `PurposeStep` unchanged, including the act acknowledgement) → kind cards → owner scope → name/model/instructions. Step 2 = triggers + `CapabilityPicker`. Step 3 = protected resources + limits + recipients + (partner) supervised-key ceiling checkboxes. Step 4 = `AgentSummaryCard` fed by `POST /preview` on entry (re-fetched when the draft changes) + `Start enabled` switch + Create (POST `/ai/agents` via `runAction`, then navigate to the list with the new agent highlighted).
- Tests: step navigation persists draft state; Create posts the same body the drawer would for an identical draft (snapshot both through `agentDraft.ts`); the preview request fires on step 4.
- Commit per step file; PR `feat(web): four-step guided create flow with server-evaluated review (W03)` with `Closes #<W03>`; one review round; merge on green; browser walk-through on a wt-stack (create in shadow, verify the summary matches the saved agent's page).

---

## Self-review

- Spec coverage: §4.1 → Task 3; §4.2 → Tasks 4, 11; §4.3 → Tasks 1, 2, 7, 10; §4.4 → Task 5 (+ Task 10 removes the org checkboxes); §4.5 → Tasks 7–10; §4.6 → Tasks 12–13; §4.7 → each task's tests; §4.8 → wave split above.
- Placeholders: `TOOL_CAPABILITY` is deliberately partial in this document because the full 185-line map is generated from the registry in Task 3 step 4 and enforced by the contract test; every other step carries real code.
- Type consistency: `intersectToolRefs`, `buildAgentToolCatalog`, `loadPartnerBaselineCeiling`, `assertOrgRowSupervisedKeysGrantOnly`, `entriesToSelection`, `selectionToEntries`, `outcomeFor`, `summarise` are named identically wherever used.
