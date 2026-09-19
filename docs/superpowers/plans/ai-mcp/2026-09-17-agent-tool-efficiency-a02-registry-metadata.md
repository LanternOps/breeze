---
tracking_issue: LanternOps/breeze#6147
wave_issue: LanternOps/breeze#6149
branch: feature/6147-agent-tool-efficiency/wave-6149
---
# Agent tool efficiency A-W02: registry metadata — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: use `superpowers:subagent-driven-development` (recommended) or `superpowers:executing-plans` to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Every AI tool carries `domain` (one of the 14 closed domains), a `searchHint` (≤ 120 chars) and an `alwaysLoad` flag in the registry; the Agent SDK MCP server forwards the hint and flag to the SDK from that single source; the system prompt's "Available Tools by Domain" block is generated from the registry instead of hand-typed; and contract tests make a tool without metadata, or a prompt that names a tool the chat cannot call, a CI failure.

**Architecture:** Metadata lives on `AiTool` (`apps/api/src/services/aiTools.ts`) as three fields; the closed `AiToolDomain` union lives in `packages/shared` because the web (page-context boost, A-W04) and the MCP consent screen (B-W02) need it. Session-aware M365/Google tools, which are not in the `aiTools` Map, get a hint table beside their existing tier tables. The SDK bridge (`aiAgentSdkTools.ts`) is refactored so the ~147 `tool()` declarations are built by `buildBreezeSdkTools()` and then re-wrapped with `tool(name, description, schema, handler, { searchHint, alwaysLoad })` from registry metadata — no per-declaration edits, one source of truth. A new `aiToolIndex.ts` renders the prompt block from the registry for exactly the tools a surface registers; `aiAgent.ts` composes `BASE + index + TAIL`. `TOOL_CAPABILITY` (agent-builder taxonomy) stays as is; a relation table `CAPABILITY_DOMAINS` and a contract test stop the two taxonomies drifting apart.

**Tech Stack:** TypeScript, `@anthropic-ai/claude-agent-sdk` 0.3.181 (`tool()` extras `{ searchHint, alwaysLoad, annotations }` → `_meta['anthropic/searchHint']` / `_meta['anthropic/alwaysLoad']`), Vitest.

**Spec:** `docs/superpowers/specs/ai-mcp/2026-09-17-agent-tool-efficiency-and-mcp-modernization-design.md` — "Domains (decided 2026-09-17)", "Feature A → A-W02", Principles 2 and 6. Plan index: `docs/superpowers/plans/ai-mcp/2026-09-17-agent-tool-efficiency-and-mcp-modernization.md` (decisions D1–D4 apply here).

**Tracking:** `get_feature_status LanternOps/breeze#6147` before starting; `start_wave` on #6149; PR body carries `Closes #6149`. A-W01 (#6148) does not block this wave — they only share the spec.

**Verified against `origin/main` `5f20013cb`** (2026-09-17). Line numbers below are from that commit; re-grep before editing.

---

## Global Constraints

- **Commands.** API unit: `cd apps/api && npx vitest run <path>`. Shared: `cd packages/shared && npx vitest run <path>`. Typecheck: `cd apps/api && NODE_OPTIONS=--max-old-space-size=8192 npx tsc --noEmit -p tsconfig.json`; shared `cd packages/shared && npx tsc --noEmit -p tsconfig.json`. Lint: `pnpm lint` in each touched package. **Before the PR: `cd apps/api && npx vitest run` (whole unit suite — this wave touches 60+ files that dozens of contract suites iterate).**
- **Never** `pnpm --filter <pkg> test -- --run <path>` (the `--` is forwarded; vitest runs the whole suite in watch mode). `vitest run <path>` is a **substring** match — check the reported file count.
- **Never rename a tool** (spec principle 6). Names are in client allowlists, `ai_tool_executions`, approvals, `TOOL_TIERS`, `TOOL_PERMISSIONS`, `TOOL_CAPABILITY`, `toolInputSchemas`.
- **No migrations, no schema changes, no new tables.** Everything here is code + prompt text.
- **`aiToolNames.ts` stays a leaf.** The `aiTools` Map is declared in `apps/api/src/services/aiToolNames.ts:45` for a load-graph reason (`workerEntrypointClosure.contract.test.ts`). Put every new accessor in `aiTools.ts`, never in `aiToolNames.ts`.
- **`aiAgentSystemPrompt.ts` and `mcpGuidance.ts` stay registry-free.** `mcpGuidance.ts:3-7` deliberately hard-codes `MCP_TOOL_COUNT_APPROX = 200` to stay decoupled from the heavy hub. The generated index is composed in `aiAgent.ts`, not in the prompt module.
- **Domain is the spec's closed union of 14** (`core, devices, scripts, patching, monitoring, network, security, backup, tickets, billing, accounts, integrations, admin, ai`). Adding a value is a reviewed spec change, not a plan task.
- **`alwaysLoad: true` ⇒ `domain: 'core'`**, and the core set is provisional until A-W04 finalises it from A-W01 telemetry: exactly `resolve_device_context`, `query_devices`, `list_organizations`, `search_documentation` in this wave. A contract test freezes that set so A-W04 changes it deliberately.
- **The generated index lists only tools the chat surface can actually call** — the intersection of `TOOL_TIERS` keys and registered names. The 90 registered-but-undeclared tools in `KNOWN_MISSING_TOOL_TIERS` (`aiAgentSdkTools.registryParity.contract.test.ts:43-133`) are not advertised. Task 5 declares `search_documentation`, which the old hand list advertised while it was mute.
- **`onlyTools` throws outside production on an unknown name** (`aiAgentSdkTools.ts:3117-3133`). Nothing in this wave feeds `alwaysLoad` into `onlyTools` — that is A-W04.
- **Commit after every task.** Trailer:
  ```
  Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>
  ```

---

## File Structure

| Path | Responsibility |
|---|---|
| `packages/shared/src/types/aiToolDomains.ts` (+ `.test.ts`), `types/index.ts` | `AI_TOOL_DOMAINS`, `AiToolDomain`, labels, hint length cap (Task 1). |
| `apps/api/src/services/aiTools.ts` | `AiTool.domain/searchHint/alwaysLoad`; `getToolDomain`, `getToolSearchHint`, `getToolAlwaysLoad`, `listChatSurfaceToolNames` (Task 2). |
| `apps/api/src/services/aiToolsM365.ts`, `aiToolsGoogle.ts` | `m365ToolSearchHints`, `googleToolSearchHints` beside the tier tables (Task 2). |
| `apps/api/src/services/aiTools.domainMetadata.contract.test.ts` | Every tool has one domain, a bounded hint, and `alwaysLoad ⇒ core`; frozen core set (Task 2). |
| `apps/api/src/services/aiTools*.ts`, `services/workspace/workspaceTools.ts`, `services/deleteTenant.ts` | Assignment sweep (Tasks 3a–3c). |
| `apps/api/src/services/aiAgents/agentToolCatalog.ts` (+ `agentToolCatalog.domainRelation.contract.test.ts`) | `CAPABILITY_DOMAINS` relation + test (Task 4). |
| `apps/api/src/services/aiAgentSdkTools.ts`, `aiAgentSdkTools.registryParity.contract.test.ts`, `aiAgentSdkTools.mcpCoverage.test.ts` | `search_documentation` declaration (Task 5); `buildBreezeSdkTools` extraction + `attachRegistryMeta` + parity assertions (Task 6). |
| `apps/api/src/services/aiToolIndex.ts` (+ `.test.ts`) | `renderToolIndexByDomain`, `DOMAIN_NOTES` (Task 7). |
| `apps/api/src/services/aiAgentSystemPrompt.ts` (+ `.test.ts`), `aiAgent.ts`, five `aiAgent.*.test.ts` mocks | BASE/TAIL split, composition (Task 7). |

---

### Task 1: Shared domain union

**Files:**
- Create: `packages/shared/src/types/aiToolDomains.ts`, `packages/shared/src/types/aiToolDomains.test.ts`
- Modify: `packages/shared/src/types/index.ts` (add `export * from './aiToolDomains';`)

**Interfaces produced:** `AI_TOOL_DOMAINS`, `AiToolDomain`, `AI_TOOL_DOMAIN_LABELS`, `AI_TOOL_SEARCH_HINT_MAX_CHARS`, `isAiToolDomain(value: unknown): value is AiToolDomain`.

- [ ] **Step 1: Write the failing test**

`packages/shared/src/types/aiToolDomains.test.ts`:

```ts
import { describe, expect, it } from 'vitest';
import {
  AI_TOOL_DOMAINS, AI_TOOL_DOMAIN_LABELS, AI_TOOL_SEARCH_HINT_MAX_CHARS, isAiToolDomain,
} from './aiToolDomains';

describe('AI tool domains', () => {
  it('is the closed union decided in the 2026-09-17 spec, in spec order', () => {
    expect([...AI_TOOL_DOMAINS]).toEqual([
      'core', 'devices', 'scripts', 'patching', 'monitoring', 'network', 'security',
      'backup', 'tickets', 'billing', 'accounts', 'integrations', 'admin', 'ai',
    ]);
  });

  it('labels every domain and nothing else', () => {
    expect(Object.keys(AI_TOOL_DOMAIN_LABELS).sort()).toEqual([...AI_TOOL_DOMAINS].sort());
    for (const label of Object.values(AI_TOOL_DOMAIN_LABELS)) expect(label).toMatch(/^[A-Z]/);
  });

  it('guards unknown values', () => {
    expect(isAiToolDomain('devices')).toBe(true);
    expect(isAiToolDomain('psa')).toBe(false);
    expect(isAiToolDomain(undefined)).toBe(false);
    expect(AI_TOOL_SEARCH_HINT_MAX_CHARS).toBe(120);
  });
});
```

```bash
cd packages/shared && npx vitest run src/types/aiToolDomains.test.ts
```
Expected: FAIL — module not found.

- [ ] **Step 2: Implement**

`packages/shared/src/types/aiToolDomains.ts`:

```ts
/**
 * Closed set of AI tool domains (spec 2026-09-17 "Domains"). A tool has
 * exactly ONE domain. Adding a value here is a reviewed spec change: the
 * system-prompt index, Agent SDK tool search hints, MCP `_meta`, and (B-W02)
 * per-grant `mcp_domains` all key on it.
 *
 * `core` is not a subject area: it marks the always-loaded context tools that
 * every surface and every grant includes. `psa` was rejected as a name —
 * `query_psa_status` already uses "PSA" for external ConnectWise-style sync.
 */
export const AI_TOOL_DOMAINS = [
  'core', 'devices', 'scripts', 'patching', 'monitoring', 'network', 'security',
  'backup', 'tickets', 'billing', 'accounts', 'integrations', 'admin', 'ai',
] as const;

export type AiToolDomain = (typeof AI_TOOL_DOMAINS)[number];

export const AI_TOOL_DOMAIN_LABELS: Readonly<Record<AiToolDomain, string>> = {
  core: 'Core',
  devices: 'Devices',
  scripts: 'Scripts & automation',
  patching: 'Patching & software',
  monitoring: 'Monitoring & alerts',
  network: 'Network',
  security: 'Security & compliance',
  backup: 'Backup & recovery',
  tickets: 'Tickets & time',
  billing: 'Billing',
  accounts: 'Accounts',
  integrations: 'Integrations',
  admin: 'Administration',
  ai: 'AI agents',
};

/** Upper bound for `AiTool.searchHint` — one line the model sees in tool search results. */
export const AI_TOOL_SEARCH_HINT_MAX_CHARS = 120;

export function isAiToolDomain(value: unknown): value is AiToolDomain {
  return typeof value === 'string' && (AI_TOOL_DOMAINS as readonly string[]).includes(value);
}
```

Add `export * from './aiToolDomains';` to `packages/shared/src/types/index.ts` beside the other `aiAgent*` exports.

- [ ] **Step 3: Verify and commit**

```bash
cd packages/shared && npx vitest run src/types/aiToolDomains.test.ts && npx tsc --noEmit -p tsconfig.json && npx eslint src --max-warnings 0
git add packages/shared && git commit -m "feat(shared): closed AI tool domain union (A-W02)"
```

---

### Task 2: Registry fields and accessors

**Files:**
- Modify: `apps/api/src/services/aiTools.ts` (`AiTool` interface `:104-130`; accessors after `getAllRegisteredToolNames` `:428`)
- Modify: `apps/api/src/services/aiToolsM365.ts` (beside `m365ToolTiers`), `apps/api/src/services/aiToolsGoogle.ts` (beside `googleToolTiers`)
- Create: `apps/api/src/services/aiTools.domainMetadata.contract.test.ts`

**Interfaces produced:**

```ts
// aiTools.ts
export interface AiTool {
  definition: Anthropic.Tool;
  tier: AiToolTier;
  /** Exactly one closed domain (spec 2026-09-17). Drives the prompt index, tool search grouping, MCP _meta, and per-grant domains. */
  domain: AiToolDomain;
  /** ≤ 120 chars, one line. What a user would say when they need this tool — synonyms, not workflow. Forwarded to the Agent SDK as `_meta['anthropic/searchHint']`. */
  searchHint: string;
  /** Never deferred behind tool search. Only `core` tools may set this; A-W04 owns the final set. */
  alwaysLoad?: boolean;
  handler: …; deviceArgs?: …; captureExempt?: …;   // unchanged
}
export function getToolDomain(toolName: string): AiToolDomain | undefined;
export function getToolSearchHint(toolName: string): string | undefined;
export function getToolAlwaysLoad(toolName: string): boolean;
/** Names the chat/Helper SDK server registers: TOOL_TIERS keys that resolve to a registered tool. */
export function listChatSurfaceToolNames(): string[];
```

```ts
// aiToolsM365.ts / aiToolsGoogle.ts
export const m365ToolSearchHints: Readonly<Record<string, string>>;   // keys === Object.keys(m365ToolTiers)
export const googleToolSearchHints: Readonly<Record<string, string>>; // keys === Object.keys(googleToolTiers)
```

Session-aware tools are all `integrations`; `getToolDomain` returns `'integrations'` for any name present in either tier table.

- [ ] **Step 1: Write the failing contract test**

`apps/api/src/services/aiTools.domainMetadata.contract.test.ts`:

```ts
/**
 * A-W02 contract: every AI tool carries exactly one closed domain, a bounded
 * one-line search hint, and only `core` tools are always-loaded.
 *
 * No vi.mock — this suite needs the real registry (same rule as
 * aiAgentSdkTools.registryParity.contract.test.ts).
 */
import { describe, expect, it } from 'vitest';
import { AI_TOOL_DOMAINS, AI_TOOL_SEARCH_HINT_MAX_CHARS, isAiToolDomain } from '@breeze/shared';
import { aiTools } from './aiToolNames';
import {
  getAllRegisteredToolNames, getToolAlwaysLoad, getToolDomain, getToolSearchHint, listChatSurfaceToolNames,
} from './aiTools';
import { m365ToolSearchHints, m365ToolTiers } from './aiToolsM365';
import { googleToolSearchHints, googleToolTiers } from './aiToolsGoogle';
import { TOOL_TIERS } from './aiAgentSdkTools';

/** Provisional core set (spec "Domains" row `core`). A-W04 replaces this from A-W01 telemetry. */
const CORE_ALWAYS_LOAD = ['list_organizations', 'query_devices', 'resolve_device_context', 'search_documentation'];

describe('AI tool domain metadata (A-W02)', () => {
  const names = getAllRegisteredToolNames();

  it('registers enough tools for these assertions to mean something', () => {
    expect(names.length).toBeGreaterThan(150);
  });

  it('every registered tool resolves exactly one closed domain', () => {
    const bad = names.filter((n) => !isAiToolDomain(getToolDomain(n)));
    expect(bad, `tools without a valid domain: ${bad.join(', ')}`).toEqual([]);
  });

  it('every registered tool has a one-line search hint within the cap', () => {
    const bad = names
      .map((n) => [n, getToolSearchHint(n)] as const)
      .filter(([, h]) => !h || h.trim() !== h || h.includes('\n') || h.length > AI_TOOL_SEARCH_HINT_MAX_CHARS)
      .map(([n, h]) => `${n} (${h?.length ?? 'missing'})`);
    expect(bad, `hints missing/multiline/over cap: ${bad.join(', ')}`).toEqual([]);
  });

  it('search hints never restate the tool name and never carry workflow prose', () => {
    const bad = names.filter((n) => {
      const h = getToolSearchHint(n) ?? '';
      return h.includes(n) || /\b(then call|first call|step \d|after that)\b/i.test(h);
    });
    expect(bad).toEqual([]);
  });

  it('alwaysLoad implies domain core, and the core set is the frozen provisional set', () => {
    const always = names.filter((n) => getToolAlwaysLoad(n)).sort();
    expect(always).toEqual(CORE_ALWAYS_LOAD);
    for (const n of always) expect(getToolDomain(n)).toBe('core');
    const coreNotAlways = names.filter((n) => getToolDomain(n) === 'core' && !getToolAlwaysLoad(n));
    expect(coreNotAlways).toEqual([]);
    expect(always.length).toBeLessThanOrEqual(15);
  });

  it('session-aware hint tables mirror their tier tables key-for-key', () => {
    expect(Object.keys(m365ToolSearchHints).sort()).toEqual(Object.keys(m365ToolTiers).sort());
    expect(Object.keys(googleToolSearchHints).sort()).toEqual(Object.keys(googleToolTiers).sort());
    for (const n of Object.keys(m365ToolTiers)) expect(getToolDomain(n)).toBe('integrations');
    for (const n of Object.keys(googleToolTiers)) expect(getToolDomain(n)).toBe('integrations');
  });

  it('every domain in the union is used by at least one tool', () => {
    const used = new Set(names.map((n) => getToolDomain(n)));
    expect([...AI_TOOL_DOMAINS].filter((d) => !used.has(d))).toEqual([]);
  });

  it('listChatSurfaceToolNames is TOOL_TIERS ∩ registry, sorted, and every entry has a domain', () => {
    const chat = listChatSurfaceToolNames();
    expect(chat).toEqual([...chat].sort());
    const registered = new Set(names);
    expect(chat).toEqual(Object.keys(TOOL_TIERS).filter((n) => registered.has(n)).sort());
    expect(chat.filter((n) => !getToolDomain(n))).toEqual([]);
    expect(aiTools.size).toBeGreaterThan(0);
  });
});
```

```bash
cd apps/api && npx vitest run src/services/aiTools.domainMetadata.contract.test.ts
```
Expected: FAIL — `getToolDomain` is not exported.

- [ ] **Step 2: Implement the fields and accessors**

In `aiTools.ts`:

1. `import type { AiToolDomain } from '@breeze/shared';` (the API already aliases `@breeze/shared`, see `vitest.config.ts`).
2. Add `domain: AiToolDomain;`, `searchHint: string;`, `alwaysLoad?: boolean;` to `AiTool` after `tier`, with the docstrings from the Interfaces block above.
3. Import `m365ToolSearchHints`/`googleToolSearchHints` alongside the tier tables (the tier tables are already imported for `getToolTier`).
4. After `getAllRegisteredToolNames` (`:428`):

```ts
const SESSION_AWARE_DOMAIN: AiToolDomain = 'integrations';

export function getToolDomain(toolName: string): AiToolDomain | undefined {
  const registered = aiTools.get(toolName);
  if (registered) return registered.domain;
  if (toolName in m365ToolTiers || toolName in googleToolTiers) return SESSION_AWARE_DOMAIN;
  return undefined;
}

export function getToolSearchHint(toolName: string): string | undefined {
  return aiTools.get(toolName)?.searchHint
    ?? m365ToolSearchHints[toolName]
    ?? googleToolSearchHints[toolName];
}

export function getToolAlwaysLoad(toolName: string): boolean {
  return aiTools.get(toolName)?.alwaysLoad === true;
}

/**
 * The names the chat/Helper Agent SDK server registers today: every
 * TOOL_TIERS key that is a registered tool. Used by the generated prompt
 * index so the prompt never advertises a tool the model cannot call (#3300).
 * Imported lazily to keep aiTools.ts → aiAgentSdkTools.ts from becoming a
 * static cycle (aiAgentSdkTools.ts imports this module).
 */
export function listChatSurfaceToolNames(): string[] {
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const { TOOL_TIERS } = require('./aiAgentSdkTools') as { TOOL_TIERS: Record<string, unknown> };
  const registered = new Set(getAllRegisteredToolNames());
  return Object.keys(TOOL_TIERS).filter((name) => registered.has(name)).sort();
}
```

If `require` is not acceptable in this ESM/tsup build (check how `aiAgentSdkTools.ts` itself does lazy imports — it uses dynamic `import()` for `toolSources/resolver.ts`, see `mcpServer.ts:1060-1070` for the same pattern), put `listChatSurfaceToolNames` in `aiAgentSdkTools.ts` instead and import it from there in `aiToolIndex.ts` (Task 7). Either placement satisfies the test; pick the one that typechecks and does not create an import cycle (`aiAgentSdkTools.ts` → `aiTools.ts` already exists, so the reverse static import is the one to avoid).

In `aiToolsM365.ts` directly after `m365ToolTiers`:

```ts
/** One-line tool-search hints for the session-aware M365 tools (not in the aiTools Map). Keys mirror m365ToolTiers. */
export const m365ToolSearchHints: Readonly<Record<string, string>> = {
  m365_query_users: 'Microsoft 365 users, licenses, sign-in enabled state, MFA registration for a customer tenant',
  m365_query_signins: 'Entra sign-in events, failed logins, risky sign-ins, conditional access outcomes',
  m365_query_intune_devices: 'Intune managed devices, compliance state, enrolment, OS version from Microsoft 365',
  m365_query_groups: 'Microsoft 365 / Entra groups, membership, distribution lists, Teams-backed groups',
  m365_query_org: 'Microsoft 365 tenant details, verified domains, subscribed SKUs and licence counts',
  m365_query_sites: 'SharePoint sites, OneDrive storage usage, site ownership in Microsoft 365',
  // …one line per remaining m365ToolTiers key (mutations too: "offboard a Microsoft 365 user…", etc.)
};
```

Same shape in `aiToolsGoogle.ts` (`googleToolSearchHints`), one entry per `googleToolTiers` key. Write each hint as **what a technician would say** (synonyms, vendor nouns), ≤ 120 chars, no tool names.

- [ ] **Step 3: Run the test — expect the assignment failures only**

```bash
cd apps/api && npx vitest run src/services/aiTools.domainMetadata.contract.test.ts
```
Expected now: "every registered tool resolves exactly one closed domain" and the hint test FAIL listing ~190 names (Task 3 fixes); the session-aware and union-shape tests PASS. `tsc` is red across every `aiTools*.ts` file because `domain`/`searchHint` are required — that is the exhaustiveness guard doing its job; Tasks 3a–3c close it. Note it in the commit body.

```bash
git add apps/api/src/services/aiTools.ts apps/api/src/services/aiToolsM365.ts apps/api/src/services/aiToolsGoogle.ts apps/api/src/services/aiTools.domainMetadata.contract.test.ts
git commit -m "feat(ai): AiTool.domain/searchHint/alwaysLoad + accessors + contract test (A-W02)

tsc is red until the assignment sweep (next commits) fills the required fields."
```

---

### Task 3a–3c: Assignment sweep

Three commits, one per group, so review stays readable. Every registration in the files below gains `domain:` and `searchHint:` (and `alwaysLoad: true` on the four core tools). Registration idioms differ per file (`registerTool({...})`, `aiTools.set(name, {...})`, exported `*_TOOL` constants) — grep each file for `tier:` to find every object.

**Assignment table.** Domains come from the spec's Domains table; a file's default is listed first, and every tool the sweep found is placed explicitly. Any tool present in the file but missing from this table takes the file default — list such tools in the PR body.

| File | Default | Explicit assignments |
|---|---|---|
| `aiToolsDevice.ts` | devices | `query_devices` **core** (alwaysLoad), `resolve_device_context` **core** (alwaysLoad); `get_device_context`, `set_device_context`, `get_device_details`, `manage_tags`, `query_custom_fields` devices |
| `aiToolsDocs.ts` | core | `search_documentation` core (alwaysLoad) |
| `aiToolsOrgs.ts` | accounts | `list_organizations` **core** (alwaysLoad); `manage_organizations` accounts |
| `aiToolsDeliverables.ts` | accounts | all six |
| `aiToolsFilesystem.ts`, `aiToolsRemote.ts`, `aiToolsPerformance.ts`, `aiToolsFleetStatus.ts` | devices | `manage_startup_items` devices; `get_invite_funnel` **admin** |
| `aiToolsScripts.ts` | scripts | `manage_processes`, `manage_services`, `manage_scheduled_tasks`, `registry_operations` **devices**; the rest scripts |
| `aiToolsScriptProposals.ts`, `aiToolsPlaybooks.ts` | scripts | all |
| `aiToolsFleet.ts` | (per tool) | `manage_alert_rules`, `manage_service_monitors` **monitoring**; `manage_patches`, `manage_deployments`, `manage_maintenance_windows` **patching**; `manage_automations` **scripts**; `manage_groups`, `get_fleet_findings` **devices**; `generate_report` **admin** |
| `aiToolsPolicyPrereqs.ts` | (per tool) | `manage_update_rings`, `manage_software_policies` **patching**; `manage_peripheral_policies` **security**; `manage_backup_configs`, `manage_backup_profiles` **backup** |
| `aiToolsCompliance.ts`, `aiToolsSoftwarePolicyAudit.ts` | patching | `manage_software_policy`, `get_software_compliance`, `remediate_software_violation` patching; `get_compliance_status`, `query_compliance_policies` **security** |
| `aiToolsVulnerability.ts` | patching | all three (spec: vulnerabilities sit under patching) |
| `aiToolsAlerts.ts`, `aiToolsMonitoring.ts`, `aiToolsMonitors.ts`, `aiToolsEventLogs.ts`, `aiToolsAnalytics.ts`, `aiToolsIncident.ts` | monitoring | `manage_notification_channels` **integrations**; rest monitoring |
| `aiToolsNetwork.ts`, `aiToolsDns.ts` | network | all |
| `aiToolsSecurity.ts`, `aiToolsCisBenchmark.ts`, `aiToolsConfigPolicy.ts`, `aiToolsPam.ts`, `aiToolsPeripherals.ts`, `aiToolsBrowser.ts`, `aiToolsUserRisk.ts`, `aiToolsAudit.ts` | security | `get_fleet_health` **devices**; rest security |
| `aiToolsBackup.ts`, `aiToolsBackupVm.ts`, `aiToolsDR.ts`, `aiToolsHyperv.ts`, `aiToolsMssql.ts`, `aiToolsSLABackup.ts`, `aiToolsVault.ts`, `aiToolsBackupShared.ts` | backup | all |
| `aiToolsTicketing.ts` | tickets | `manage_tickets` |
| `aiToolsBilling.ts`, `aiToolsContracts.ts`, `aiToolsQuotes.ts`, `aiToolsCatalog.ts` | billing | all (incl. `lookup_distributor_product`) |
| `aiToolsC2C.ts`, `aiToolsHuntress.ts`, `aiToolsSentinelOne.ts`, `aiToolsIntegrations.ts`, `aiToolsM365.ts`, `aiToolsGoogle.ts` | integrations | all (M365/Google via the hint tables from Task 2) |
| `aiToolsAgentLogs.ts`, `aiToolsAgentMgmt.ts`, `aiToolsExport.ts`, `aiToolsExportDatasets.ts`, `aiToolsUI.ts`, `deleteTenant.ts` | admin | all (`manage_saved_filters`, `export_dataset`, `delete_tenant`, agent versions/restart/upgrade/logs/pprof) |
| `aiToolsAiAgentGovernance.ts`, `workspace/workspaceTools.ts` | ai | `manage_ai_agents`, `workspace_*` |

**Hint rules** (the contract test enforces the mechanical ones; the reviewer checks the rest):

1. ≤ 120 chars, one line, no trailing period, no tool names, no "Use this tool to".
2. Lead with the nouns a technician types: `"disk space, low disk, largest folders and files on one device"` beats `"Analyze disk usage"`.
3. Name the vendor or product for integrations (`"SentinelOne threats…"`, `"Huntress incidents…"`).
4. Disambiguate neighbours in the hint when the spec calls it out: vulnerability tools say `"CVE, vulnerability findings"`; `get_security_posture` says `"control scores (AV, firewall, encryption) — not CVEs"`; `manage_patches` says `"missing patches, KB approvals — not CVEs"`.
5. Multiplexers list their verbs once: `"tickets: list, get, create, update, comment, log time, start/stop timer"`.

- [ ] **Task 3a — devices/core/scripts/patching/accounts files** (rows 1–11 of the table). Run the contract test after each file; commit:

```bash
cd apps/api && npx vitest run src/services/aiTools.domainMetadata.contract.test.ts   # failing count shrinks
git add apps/api/src/services && git commit -m "feat(ai): domain + searchHint on devices/core/scripts/patching/accounts tools (A-W02 3a)"
```

- [ ] **Task 3b — monitoring/network/security/backup/tickets files** (rows 12–17):

```bash
git add apps/api/src/services && git commit -m "feat(ai): domain + searchHint on monitoring/network/security/backup/tickets tools (A-W02 3b)"
```

- [ ] **Task 3c — billing/integrations/admin/ai files + session-aware hint tables completed** (rows 18–21). After this commit the contract test and `tsc` are green:

```bash
cd apps/api && npx vitest run src/services/aiTools.domainMetadata.contract.test.ts && NODE_OPTIONS=--max-old-space-size=8192 npx tsc --noEmit -p tsconfig.json
git add apps/api/src/services && git commit -m "feat(ai): domain + searchHint on billing/integrations/admin/ai tools — sweep complete (A-W02 3c)"
```

---

### Task 4: Capability ↔ domain relation

`TOOL_CAPABILITY` (`apps/api/src/services/aiAgents/agentToolCatalog.ts:69`) is the agent-builder taxonomy (17 values with a `tone`). It stays. This task makes a disagreement between the two taxonomies a CI failure instead of silent drift (index decision D1).

**Files:**
- Modify: `apps/api/src/services/aiAgents/agentToolCatalog.ts` (after `AGENT_CAPABILITIES`, `:34-57`)
- Create: `apps/api/src/services/aiAgents/agentToolCatalog.domainRelation.contract.test.ts`

**Interfaces produced:** `CAPABILITY_DOMAINS: Readonly<Record<AgentCapabilityId, readonly AiToolDomain[]>>`.

- [ ] **Step 1: Write the failing test**

```ts
import { describe, expect, it } from 'vitest';
import { aiTools } from '../aiToolNames';
import '../aiTools'; // populates the registry
import { getToolDomain } from '../aiTools';
import { AGENT_CAPABILITIES, CAPABILITY_DOMAINS, TOOL_CAPABILITY } from './agentToolCatalog';

describe('capability ↔ domain relation (A-W02)', () => {
  it('declares a domain set for every capability and nothing else', () => {
    expect(Object.keys(CAPABILITY_DOMAINS).sort()).toEqual(AGENT_CAPABILITIES.map((c) => c.id).sort());
    for (const domains of Object.values(CAPABILITY_DOMAINS)) expect(domains.length).toBeGreaterThan(0);
  });

  it('every registered tool sits in a domain its capability allows', () => {
    const offenders = [...aiTools.keys()].filter((name) => {
      const capability = TOOL_CAPABILITY[name];
      const domain = getToolDomain(name);
      return !capability || !domain || !CAPABILITY_DOMAINS[capability].includes(domain);
    }).map((name) => `${name}: capability=${TOOL_CAPABILITY[name]} domain=${getToolDomain(name)}`);
    expect(offenders, 'widen CAPABILITY_DOMAINS with a reason, or fix the tool domain').toEqual([]);
  });
});
```

Run: `cd apps/api && npx vitest run src/services/aiAgents/agentToolCatalog.domainRelation.contract.test.ts` → FAIL, `CAPABILITY_DOMAINS` not exported.

- [ ] **Step 2: Implement**

```ts
import type { AiToolDomain } from '@breeze/shared';

/**
 * Which tool domains (spec 2026-09-17, `AI_TOOL_DOMAINS`) a capability may
 * contain. The capability is the agent-builder grouping (with `tone`); the
 * domain is the load/grant grouping. They overlap but are not 1:1, so this
 * relation is what keeps them from drifting silently: a tool whose domain is
 * not in its capability's set fails agentToolCatalog.domainRelation.contract.
 * Widen an entry in the same commit as the tool that needs it, with a reason.
 */
export const CAPABILITY_DOMAINS: Readonly<Record<AgentCapabilityId, readonly AiToolDomain[]>> = {
  alerts_monitoring: ['monitoring', 'integrations'],          // notification channels
  services_startup: ['devices'],
  files_disk: ['devices'],
  scripts_commands: ['scripts', 'devices'],
  author_scripts: ['scripts'],
  tickets: ['tickets'],
  patching_software: ['patching'],
  security_response: ['security', 'integrations', 'monitoring'], // S1/Huntress; incident tools
  backup_recovery: ['backup'],
  config_policies: ['security', 'patching', 'backup'],        // policy prerequisites span three
  network: ['network'],
  remote_access: ['devices'],
  endpoint_agent: ['admin', 'devices'],
  automations_reports: ['scripts', 'admin', 'monitoring', 'core'], // search_documentation is core
  business: ['billing', 'accounts', 'tickets'],
  tenancy: ['accounts', 'admin', 'core'],                     // list_organizations is core
  workspace: ['ai'],
};
```

Run the test; for every offender it prints, decide: is the tool's domain wrong (fix Task 3's assignment) or is the relation too narrow (widen with a trailing comment)? Do not move tools between capabilities — `TOOL_CAPABILITY` is not this wave's surface.

- [ ] **Step 3: Verify and commit**

```bash
cd apps/api && npx vitest run src/services/aiAgents/agentToolCatalog
git add apps/api/src/services/aiAgents && git commit -m "feat(ai): CAPABILITY_DOMAINS relation + contract test (A-W02)"
```

---

### Task 5: Declare `search_documentation` for the chat surface

The old hand list advertised `search_documentation` (`aiAgentSystemPrompt.ts:109,120`) but it has no `tool()` declaration and no `TOOL_TIERS` entry (`KNOWN_MISSING_TOOL_TIERS`, `registryParity.contract.test.ts:122`), so chat could never call it. The generated index would drop it; the right fix is to declare it — it is Tier 1, has a `TOOL_PERMISSIONS` entry (`aiGuardrails.ts:1181`) and a `toolInputSchemas` entry (`aiToolSchemas.ts:1565`) already.

**Files:**
- Modify: `apps/api/src/services/aiAgentSdkTools.ts` (`TOOL_TIERS` `:163+`; the `tools` array `:1353+`)
- Modify: `apps/api/src/services/aiAgentSdkTools.registryParity.contract.test.ts` (remove `'search_documentation'` from `KNOWN_MISSING_TOOL_TIERS`)
- Modify: `apps/api/src/services/aiAgentSdkTools.mcpCoverage.test.ts` if it lists `search_documentation` as an exception

- [ ] **Step 1: Write the failing test** — append to `aiAgentSdkTools.mcpCoverage.test.ts` (it already has the `declaredToolNames()` source-regex helper at `:38`):

```ts
describe('search_documentation reaches the chat model (A-W02, #3300 class)', () => {
  it('is declared on the breeze SDK server and tiered', () => {
    expect(declaredToolNames().has('search_documentation')).toBe(true);
    expect(TOOL_TIERS.search_documentation).toBe(1);
  });
});
```

Run: `cd apps/api && npx vitest run src/services/aiAgentSdkTools.mcpCoverage.test.ts` → FAIL.

- [ ] **Step 2: Implement**

`TOOL_TIERS`: add `search_documentation: 1,` in the Tier-1 block. In the `tools` array, next to the other read tools:

```ts
    tool(
      'search_documentation',
      registryDescription('search_documentation'),
      {
        query: z.string().min(1).max(200),
        section: z.enum(['getting-started', 'deploy', 'agents', 'security', 'features', 'monitoring', 'reference']).optional(),
      },
      makeHandler('search_documentation', getAuth, onPreToolUse, onPostToolUse)
    ),
```

The Zod shape must match `toolInputSchemas.search_documentation` (`aiToolSchemas.ts:1565`) key-for-key — copy its shape. Remove `'search_documentation'` from `KNOWN_MISSING_TOOL_TIERS`; the staleness test there fails otherwise.

- [ ] **Step 3: Verify and commit**

```bash
cd apps/api && npx vitest run src/services/aiAgentSdkTools.mcpCoverage.test.ts src/services/aiAgentSdkTools.registryParity.contract.test.ts src/services/aiAgentSdkTools.handlerCoverage.contract.test.ts
git add apps/api/src/services && git commit -m "feat(ai): declare search_documentation on the chat SDK server (A-W02)"
```

---

### Task 6: SDK bridge — one source of truth for searchHint/alwaysLoad

**Files:**
- Modify: `apps/api/src/services/aiAgentSdkTools.ts` (`createBreezeMcpServer` `:1331-3146`)
- Modify: `apps/api/src/services/aiAgentSdkTools.registryParity.contract.test.ts` (new describe block)

**Interfaces produced:**

```ts
export function buildBreezeSdkTools(
  getAuth: () => AuthContext,
  onPreToolUse?: PreToolUseCallback,
  onPostToolUse?: PostToolUseCallback,
  getActiveSession?: () => ActiveSession,
): SdkTool[];                                   // the ~147 tool() declarations, unwrapped, unfiltered
export function attachRegistryMeta(def: SdkTool): SdkTool;  // re-invokes tool() with { searchHint, alwaysLoad, annotations }
```

`createBreezeMcpServer`'s signature and behaviour are unchanged except that every registered core tool now carries `_meta['anthropic/searchHint']` and, for the core set, `_meta['anthropic/alwaysLoad'] = true`. Extra (tenant BYO / outcome) tools are untouched — A-W04 decides their deferral.

- [ ] **Step 1: Write the failing test** — append to `aiAgentSdkTools.registryParity.contract.test.ts`:

```ts
import { attachRegistryMeta, buildBreezeSdkTools } from './aiAgentSdkTools';
import { getToolAlwaysLoad, getToolSearchHint } from './aiTools';

describe('SDK declarations carry registry search metadata (A-W02)', () => {
  const fakeAuth = () => { throw new Error('handlers must not run in this test'); };
  const declared = buildBreezeSdkTools(fakeAuth as never).map(attachRegistryMeta);

  it('builds the full declared set', () => {
    expect(declared.length).toBeGreaterThan(140);
  });

  it('every declared tool has the registry hint in _meta and alwaysLoad only where the registry says so', () => {
    const bad = declared.filter((t) => {
      const meta = (t._meta ?? {}) as Record<string, unknown>;
      return meta['anthropic/searchHint'] !== getToolSearchHint(t.name)
        || (meta['anthropic/alwaysLoad'] === true) !== getToolAlwaysLoad(t.name);
    }).map((t) => t.name);
    expect(bad, 'declarations whose _meta disagrees with the registry').toEqual([]);
  });

  it('keeps name, description, schema and handler intact when attaching meta', () => {
    const raw = buildBreezeSdkTools(fakeAuth as never);
    const byName = new Map(declared.map((t) => [t.name, t]));
    for (const t of raw) {
      const wrapped = byName.get(t.name)!;
      expect(wrapped.description).toBe(t.description);
      expect(Object.keys(wrapped.inputSchema)).toEqual(Object.keys(t.inputSchema));
      expect(wrapped.handler).toBe(t.handler);
    }
  });
});
```

Run: `cd apps/api && npx vitest run src/services/aiAgentSdkTools.registryParity.contract.test.ts` → FAIL, `buildBreezeSdkTools` not exported.

- [ ] **Step 2: Extract `buildBreezeSdkTools`**

Inside `createBreezeMcpServer` (`:1331`), the body runs: `makeHandler` alias (`:1345-1350`) → `const tools = [ …147 tool() calls… ]` (`:1353` to just before the `extraTools` collision guard at `:3095`) → guards → filter → `createSdkMcpServer`. Cut the first two parts into:

```ts
export function buildBreezeSdkTools(
  getAuth: () => AuthContext,
  onPreToolUse?: PreToolUseCallback,
  onPostToolUse?: PostToolUseCallback,
  getActiveSession?: () => ActiveSession,
): SdkTool[] {
  const makeHandler = (…) => makeToolHandler(…, getActiveSession, …);   // moved verbatim from :1345-1350
  const tools = [
    // …the array, moved verbatim…
  ];
  return tools as SdkTool[];
}
```

and have `createBreezeMcpServer` start with `const tools = buildBreezeSdkTools(getAuth, onPreToolUse, onPostToolUse, getActiveSession);`. Nothing else in the function moves. (The comment at `:892` explains why the array is not annotated `SdkTool[]` inline — the `as SdkTool[]` on the return handles it.)

- [ ] **Step 3: Add `attachRegistryMeta` and apply it**

Above `createBreezeMcpServer`:

```ts
/**
 * A-W02: the registry is the single source of truth for tool-search
 * metadata. Rather than editing ~147 tool() declarations, re-declare each
 * one through tool()'s public extras param so the SDK writes
 * `_meta['anthropic/searchHint']` / `_meta['anthropic/alwaysLoad']` itself
 * (sdk.d.ts: tool(_name, _description, _inputSchema, _handler, { annotations,
 * searchHint, alwaysLoad })). Throws on a declaration with no registry hint —
 * every core declaration must resolve one (registryParity contract).
 */
export function attachRegistryMeta(def: SdkTool): SdkTool {
  const searchHint = getToolSearchHint(def.name);
  if (!searchHint) {
    throw new Error(`[attachRegistryMeta] no registry searchHint for tool "${def.name}"`);
  }
  return tool(def.name, def.description, def.inputSchema, def.handler, {
    annotations: def.annotations,
    searchHint,
    alwaysLoad: getToolAlwaysLoad(def.name),
  }) as SdkTool;
}
```

In `createBreezeMcpServer`, change the final call to:

```ts
  return createSdkMcpServer({
    name: 'breeze',
    version: '1.0.0',
    tools: [...registeredTools.map(attachRegistryMeta), ...wrappedExtraTools],
  });
```

Import `getToolAlwaysLoad, getToolSearchHint` from `./aiTools` (the file already imports `aiTools` from there).

- [ ] **Step 4: Verify and commit**

```bash
cd apps/api && npx vitest run src/services/aiAgentSdkTools && NODE_OPTIONS=--max-old-space-size=8192 npx tsc --noEmit -p tsconfig.json
```
The substring `src/services/aiAgentSdkTools` pulls in every `aiAgentSdkTools.*.test.ts` (expect ≥ 6 files). All green.

```bash
git add apps/api/src/services && git commit -m "feat(ai): buildBreezeSdkTools + attachRegistryMeta — SDK search metadata from the registry (A-W02)"
```

---

### Task 7: Generated prompt index

**Files:**
- Create: `apps/api/src/services/aiToolIndex.ts`, `apps/api/src/services/aiToolIndex.test.ts`
- Modify: `apps/api/src/services/aiAgentSystemPrompt.ts` (delete `:86-110`; split into `AI_SYSTEM_PROMPT_BASE` + `AI_SYSTEM_PROMPT_TAIL`)
- Modify: `apps/api/src/services/aiAgentSystemPrompt.test.ts`
- Modify: `apps/api/src/services/aiAgent.ts:629`
- Modify: mocks in `aiAgent.deviceMemory.test.ts:25`, `aiAgent.pageContextOrg.test.ts:41`, `aiAgent.m365.test.ts:29`, `aiAgent.authz.test.ts:51`, `aiAgent.deviceTask.test.ts:30`

**Interfaces produced:**

```ts
// aiToolIndex.ts
export interface ToolIndexEntry { name: string; domain: AiToolDomain; searchHint: string; actions: string[] }
export const DOMAIN_NOTES: Readonly<Partial<Record<AiToolDomain, string>>>;   // ≤ 400 chars each; empty this wave except `patching`
export function listToolIndex(names: Iterable<string>): ToolIndexEntry[];     // skips names with no domain
export function renderToolIndexByDomain(names: Iterable<string>): string;     // the markdown block
```

Rendered shape (one line per domain, spec order, domains with no tool omitted; actions appended when a tool's `input_schema.properties.action.enum` has ≤ 8 values, else `(N actions)`):

```
## Available Tools by Domain
- **Core**: list_organizations, query_devices, resolve_device_context, search_documentation
- **Devices**: get_device_details, manage_groups (list/get/create/update/delete/add_devices/remove_devices), …
- **Patching & software**: manage_patches (list/approve/decline/install/rollback/scan), get_vulnerability_report, …
  Note: <DOMAIN_NOTES.patching>
…
```

- [ ] **Step 1: Write the failing tests**

`apps/api/src/services/aiToolIndex.test.ts`:

```ts
import { describe, expect, it } from 'vitest';
import { AI_TOOL_DOMAINS, AI_TOOL_DOMAIN_LABELS } from '@breeze/shared';
import './aiTools'; // populates the registry
import { listChatSurfaceToolNames } from './aiTools';
import { DOMAIN_NOTES, listToolIndex, renderToolIndexByDomain } from './aiToolIndex';

describe('renderToolIndexByDomain (A-W02)', () => {
  const names = listChatSurfaceToolNames();
  const text = renderToolIndexByDomain(names);

  it('renders domains in spec order under the standing heading', () => {
    expect(text.startsWith('## Available Tools by Domain\n')).toBe(true);
    const labelsInOrder = text.match(/^- \*\*([^*]+)\*\*: /gm)!.map((l) => l.replace(/^- \*\*|\*\*: $/g, ''));
    const expected = AI_TOOL_DOMAINS
      .filter((d) => listToolIndex(names).some((e) => e.domain === d))
      .map((d) => AI_TOOL_DOMAIN_LABELS[d]);
    expect(labelsInOrder).toEqual(expected);
  });

  it('names every chat-callable tool exactly once and nothing else', () => {
    const mentioned = text.match(/\b[a-z][a-z0-9]*(?:_[a-z0-9]+)+\b/g) ?? [];
    const set = new Set(names);
    const unknown = mentioned.filter((m) => !set.has(m) && !isActionToken(text, m));
    expect(unknown).toEqual([]);
    for (const n of names) expect(text.split(n).length - 1, n).toBe(1);
  });

  it('keeps the vulnerability tools findable with CVE vocabulary (#2605 pin moves here)', () => {
    expect(text).toContain('get_vulnerability_report');
    expect(text).toContain('get_device_vulnerabilities');
    expect(text).toContain('remediate_vulnerability');
    expect(text).toMatch(/CVE/);
  });

  it('skips names that have no domain instead of throwing', () => {
    expect(listToolIndex(['query_devices', 'propose_action_plan', 'not_a_tool']).map((e) => e.name)).toEqual(['query_devices']);
  });

  it('stays small: the whole index is under 5 KB and every note under 400 chars', () => {
    expect(Buffer.byteLength(text, 'utf8')).toBeLessThan(5 * 1024);
    for (const note of Object.values(DOMAIN_NOTES)) expect(note!.length).toBeLessThanOrEqual(400);
  });
});

/** Action tokens are rendered inside parentheses after a tool name; ignore those in the unknown-name check. */
function isActionToken(text: string, token: string): boolean {
  return new RegExp(`\\(([a-z0-9_]+/)*${token}(/[a-z0-9_]+)*\\)`).test(text);
}
```

`aiAgentSystemPrompt.test.ts` changes: the `describe('AI_SYSTEM_PROMPT_BASE vulnerability tool routing (#2605)')` block now reads `AI_SYSTEM_PROMPT_TAIL` for the disambiguation regexes (`get_security_posture returns **control scores**`, `manage_patches returns the **patch/KB inventory`, `never state that a device or the fleet has no vulnerabilities`, `no findings are currently correlated`) and drops the three `toContain('get_…')` assertions (moved to `aiToolIndex.test.ts` above). Add:

```ts
it('carries no hand-typed tool index any more', () => {
  expect(AI_SYSTEM_PROMPT_BASE).not.toContain('## Available Tools by Domain');
  expect(AI_SYSTEM_PROMPT_BASE).not.toMatch(/\bquery_devices\b/);
  expect(AI_SYSTEM_PROMPT_TAIL).not.toContain('## Available Tools by Domain');
});
it('BASE + TAIL stay under 7 KB together', () => {
  expect(Buffer.byteLength(AI_SYSTEM_PROMPT_BASE + AI_SYSTEM_PROMPT_TAIL, 'utf8')).toBeLessThan(7 * 1024);
});
```

Run: `cd apps/api && npx vitest run src/services/aiToolIndex.test.ts src/services/aiAgentSystemPrompt.test.ts` → FAIL (module missing; TAIL not exported).

- [ ] **Step 2: Implement `aiToolIndex.ts`**

```ts
import { AI_TOOL_DOMAINS, AI_TOOL_DOMAIN_LABELS, type AiToolDomain } from '@breeze/shared';
import { aiTools } from './aiToolNames';
import { getToolDomain, getToolSearchHint } from './aiTools';

export interface ToolIndexEntry { name: string; domain: AiToolDomain; searchHint: string; actions: string[] }

/**
 * One short note per domain, rendered under that domain's line. This is the
 * ONE place disambiguation prose lives (spec A-W03: "keep disambiguation once,
 * in the generated index"). ≤ 400 chars each; no tool names the domain does
 * not contain.
 */
export const DOMAIN_NOTES: Readonly<Partial<Record<AiToolDomain, string>>> = {
  patching: 'CVE/vulnerability questions use the vulnerability tools; get_security_posture returns control scores, not CVEs; manage_patches returns the patch/KB inventory, not a vulnerability answer.',
};

const MAX_INLINE_ACTIONS = 8;

function actionsOf(name: string): string[] {
  const schema = aiTools.get(name)?.definition.input_schema as { properties?: Record<string, { enum?: unknown[] }> } | undefined;
  const values = schema?.properties?.action?.enum;
  return Array.isArray(values) ? values.filter((v): v is string => typeof v === 'string') : [];
}

export function listToolIndex(names: Iterable<string>): ToolIndexEntry[] {
  const entries: ToolIndexEntry[] = [];
  for (const name of new Set(names)) {
    const domain = getToolDomain(name);
    const searchHint = getToolSearchHint(name);
    if (!domain || !searchHint) continue;
    entries.push({ name, domain, searchHint, actions: actionsOf(name) });
  }
  return entries.sort((a, b) => a.name.localeCompare(b.name, 'en'));
}

export function renderToolIndexByDomain(names: Iterable<string>): string {
  const entries = listToolIndex(names);
  const lines = ['## Available Tools by Domain'];
  for (const domain of AI_TOOL_DOMAINS) {
    const inDomain = entries.filter((e) => e.domain === domain);
    if (inDomain.length === 0) continue;
    const rendered = inDomain.map((e) => e.actions.length === 0
      ? e.name
      : e.actions.length <= MAX_INLINE_ACTIONS
        ? `${e.name} (${e.actions.join('/')})`
        : `${e.name} (${e.actions.length} actions)`);
    lines.push(`- **${AI_TOOL_DOMAIN_LABELS[domain]}**: ${rendered.join(', ')}`);
    const note = DOMAIN_NOTES[domain];
    if (note) lines.push(`  Note: ${note}`);
  }
  return lines.join('\n');
}
```

- [ ] **Step 3: Split the prompt and compose**

`aiAgentSystemPrompt.ts`: delete lines `:86-110` (`## Available Tools by Domain` through the Microsoft 365 bullet). End `AI_SYSTEM_PROMPT_BASE` right before the deleted block; start a new export with everything after it:

```ts
/** Everything that follows the generated tool index: disambiguation, docs references, error recovery. */
export const AI_SYSTEM_PROMPT_TAIL = `## Vulnerability vs. Posture vs. Patching — pick the right tool
…unchanged text through the Error Recovery section…`;
```

`aiAgent.ts:629`:

```ts
  parts.push(AI_SYSTEM_PROMPT_BASE);
  parts.push(renderToolIndexByDomain(listChatSurfaceToolNames()));
  parts.push(AI_SYSTEM_PROMPT_TAIL);
```

with `import { AI_SYSTEM_PROMPT_BASE, AI_SYSTEM_PROMPT_TAIL } from './aiAgentSystemPrompt';` and `import { renderToolIndexByDomain } from './aiToolIndex';` (`listChatSurfaceToolNames` from wherever Task 2 placed it).

Five `aiAgent.*.test.ts` files mock the prompt module as `{ AI_SYSTEM_PROMPT_BASE: 'base' }`; extend each to `{ AI_SYSTEM_PROMPT_BASE: 'base', AI_SYSTEM_PROMPT_TAIL: 'tail' }`. If any of them fails because the index now pulls the registry, add `vi.mock('./aiToolIndex', () => ({ renderToolIndexByDomain: () => 'index' }))` to that file — say which in the commit body.

- [ ] **Step 4: One-off check — nothing the old hand list advertised went missing**

```bash
cd apps/api && git show origin/main:apps/api/src/services/aiAgentSystemPrompt.ts | sed -n '86,110p' | grep -oE '\b[a-z][a-z0-9]*(_[a-z0-9]+)+\b' | sort -u > /tmp/old-index-names.txt
npx vitest run src/services/aiToolIndex.test.ts   # green
node -e "
const names=require('fs').readFileSync('/tmp/old-index-names.txt','utf8').trim().split('\n');
const {TOOL_TIERS}=require('./src/services/aiAgentSdkTools'); // if this fails to load under node, run the check inside a throwaway vitest file instead
console.log(names.filter(n=>!(n in TOOL_TIERS)));"
```

Expected leftovers: action tokens (`list`, `acknowledge`, …) and any tool that was advertised but undeclared. For each undeclared *tool* name: it is a #3300-class bug the old prompt had; list it in the PR body under "advertised-but-mute tools no longer advertised" (do **not** declare more tools in this wave — that is A-W06's list to burn down).

- [ ] **Step 5: Verify and commit**

```bash
cd apps/api && npx vitest run src/services/aiToolIndex.test.ts src/services/aiAgentSystemPrompt.test.ts src/services/aiAgent src/services/mcpGuidance
git add apps/api/src/services && git commit -m "feat(ai): generate the system-prompt tool index from the registry; split BASE/TAIL (A-W02)"
```

---

### Task 8: Verification and PR

- [ ] **Step 1: Whole unit suite, typecheck, lint**

```bash
cd apps/api && npx vitest run
cd apps/api && NODE_OPTIONS=--max-old-space-size=8192 npx tsc --noEmit -p tsconfig.json && pnpm lint
cd packages/shared && npx vitest run && npx tsc --noEmit -p tsconfig.json && pnpm lint
```

Suites most likely to move and why: `aiAgentSdkTools.*` (bridge refactor), `aiAgentSystemPrompt.test.ts` (split), `aiAgent.*.test.ts` (mocks), `mcpGuidancePromptTools.test.ts` (scans `MCP_PROMPTS` only — must be untouched), `agentToolCatalog.contract.test.ts` (unchanged: `TOOL_CAPABILITY` keys still equal registry keys), `workerEntrypointClosure.contract.test.ts` (`aiToolNames.ts` untouched).

- [ ] **Step 2: Measure what the wave claims**

Record in the PR body: bytes of `AI_SYSTEM_PROMPT_BASE + TAIL` (target < 7 KB), bytes of the rendered index (target < 5 KB), number of tools with `alwaysLoad` (4), number of tools per domain (a 14-row table from `listToolIndex(listChatSurfaceToolNames())`).

- [ ] **Step 3: PR**

Branch `feature/6147-agent-tool-efficiency/wave-6149`, `Closes #6149`. Body lists: the assignment table deviations (tools that took a file default), the CAPABILITY_DOMAINS widenings with reasons, the advertised-but-mute leftovers from Task 7 Step 4, and the measurements. One `/pr-review-toolkit:review-pr` round.

---

## Self-review against the spec

- "Add `domain` (closed union of 14), `searchHint`, `alwaysLoad` to `AiTool` and the SDK declaration" → Tasks 1, 2, 3, 6.
- "Extend the parity contract test" → Task 6 Step 1.
- "New contract test: every tool has exactly one domain and a hint ≤ 120 chars" → Task 2.
- "Generate the system prompt's Available Tools by Domain block from the registry (delete the hand list)" → Task 7.
- "Pass `searchHint`/`alwaysLoad` through `tool()`" → Task 6 (`attachRegistryMeta`).
- Principle 2 (one source of truth): SDK meta and prompt index both derive from `AiTool`; the only other keyed list touched is `TOOL_CAPABILITY`, guarded by Task 4.
- Principle 6 (never rename): no tool renamed; `search_documentation` is declared under its existing name.
