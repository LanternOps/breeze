---
tracking_issue: LanternOps/breeze#6147
wave_issue: LanternOps/breeze#6150
branch: feature/6147-agent-tool-efficiency/wave-6150
---
# Agent tool efficiency A-W03: description diet — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: use `superpowers:subagent-driven-development` (recommended) or `superpowers:executing-plans` to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** One description per tool, ≤ 300 chars, with every parameter description ≤ 160 chars and no workflow prose; a Test API lint with a frozen offender baseline that this wave shrinks to zero; the how-to prose that used to live in descriptions moved to where the model or the reader actually needs it; and the A-W01 golden eval re-run to prove first-call accuracy did not drop.

**Architecture:** Today there are **two** description surfaces: `AiTool.definition.description` in the registry (what the external MCP server and 6 `registryDescription()` declarations send) and 132 inline string literals in `aiAgentSdkTools.ts` (what the chat/Helper model sees for 90 % of tools). The diet starts by collapsing them into one — every `tool()` declaration reads `registryDescription(name)` — so there is exactly one text to shrink and one lint to run. The lint is a whole-registry contract test (`aiTools.descriptionBudget.contract.test.ts`) with a frozen `DESCRIPTION_BUDGET_BASELINE` map asserted shrink-only. The biggest offender, `manage_policy_feature_link` (8.7 KB of per-feature-type `inlineSettings` shapes), gets a read-only `describe` action that returns the shape for one feature type on demand. Workflow prose the model still needs goes into `DOMAIN_NOTES` (A-W02's generated index) once per domain; prose external MCP clients need goes into `MCP_PROMPTS`; user-facing how-to goes into `apps/docs`.

**Tech Stack:** TypeScript, Vitest, the A-W02 registry metadata (`getToolDomain`, `DOMAIN_NOTES`, `renderToolIndexByDomain`), the A-W01 eval (`ai:tool-eval`).

**Spec:** `docs/superpowers/specs/ai-mcp/2026-09-17-agent-tool-efficiency-and-mcp-modernization-design.md` — "Feature A → A-W03", Principles 1, 2, 5. Plan index decision D7.

**Tracking:** `get_feature_status LanternOps/breeze#6147`; `start_wave` on #6150; PR `Closes #6150`. **Depends on A-W02 (#6149) merged** (uses `DOMAIN_NOTES`, `listChatSurfaceToolNames`, `buildBreezeSdkTools`) and on A-W01 (#6148) merged (uses `ai:tool-eval` for the before/after).

**Verified against `origin/main` `5f20013cb`** (2026-09-17); A-W02 names are from its plan.

---

## Global Constraints

- **Commands.** API unit: `cd apps/api && npx vitest run <path>`; typecheck `cd apps/api && NODE_OPTIONS=--max-old-space-size=8192 npx tsc --noEmit -p tsconfig.json`; `pnpm lint`. **Before the PR: `cd apps/api && npx vitest run`.** Never `pnpm --filter <pkg> test -- --run <path>`.
- **Budgets (spec):** tool description ≤ **300** chars; every `input_schema` property description (recursively through `properties`/`items`) ≤ **160** chars; no workflow prose. "Workflow prose" is enforced mechanically as: none of `/\b(step \d|first call|then call|after that|workflow:)\b/i`, no numbered lists (`/(^|\s)\d\)\s/`), no JSON examples (`/\{\s*"[a-zA-Z]+"\s*:/`).
- **Never rename a tool; never remove an action.** Shrinking a description must not drop an action name the enum declares — the lint checks that every enum value still appears in the description or in a trailing `Actions:` clause.
- **`registryDescription()` throws on an unknown name at server construction** (`aiAgentSdkTools.ts:466-471`) — keep it that way; it is the rename detector.
- **`manage_policy_feature_link`'s reference text is load-bearing** (docstring `aiAgentSdkTools.ts:451-465`, `mcpCoverage.test.ts:328` asserts it advertises `featurePolicyId` and the prerequisite workflow). It is not deleted; it moves behind a `describe` action and the assertions move with it.
- **Two things must be measured, not asserted:** the offender counts before freezing the baseline (Task 1 prints them under vitest — a `tsx` import of the registry does not terminate cleanly, see A-W01), and eval accuracy before/after (Task 7).
- **Prompt text is a product surface.** Every rewritten description keeps: what the tool returns or does (first sentence), when to use it vs its named neighbour (second sentence, only when a neighbour exists), and its action list once. Nothing else.
- **Commit after every task.** Trailer:
  ```
  Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>
  ```

---

## File Structure

| Path | Responsibility |
|---|---|
| `apps/api/src/services/aiTools.descriptionBudget.contract.test.ts` | The lint + frozen baseline (Task 1). |
| `apps/api/src/services/aiAgentSdkTools.ts`, `aiAgentSdkTools.mcpCoverage.test.ts` | Every `tool()` reads the registry description (Task 2). |
| `apps/api/src/services/aiToolsConfigPolicy.ts` (+ `.test.ts`), `aiToolSchemas.ts`, `aiGuardrails.ts` | `describe` action + `POLICY_FEATURE_INLINE_SETTINGS_REFERENCE` (Task 3). |
| `apps/api/src/services/aiTools*.ts` | Rewrites, three commits by domain group (Tasks 4a–4c). |
| `apps/api/src/services/aiToolIndex.ts`, `aiAgentSystemPrompt.ts` (+ tests) | Disambiguation moves into `DOMAIN_NOTES`; TAIL loses its copy (Task 5). |
| `apps/api/src/services/mcpGuidance.ts` (+ tests), `apps/docs/src/content/docs/features/ai-tools.mdx` | Where moved how-to prose lands (Task 6). |
| `docs/superpowers/specs/ai-mcp/2026-09-17-agent-tool-efficiency-baseline.md` | Before/after eval rows (Task 7). |

---

### Task 1: The budget lint with a frozen baseline

**Files:**
- Create: `apps/api/src/services/aiTools.descriptionBudget.contract.test.ts`

- [ ] **Step 1: Write the test in "print" mode first**

```ts
/**
 * A-W03 contract: tool descriptions ≤ 300 chars, parameter descriptions ≤ 160,
 * no workflow prose, every declared action still named. Offenders that predate
 * this wave sit in DESCRIPTION_BUDGET_BASELINE, which is FROZEN and shrink-only:
 * an entry may only get shorter or disappear. A new tool must fit the budget.
 *
 * No vi.mock — real registry.
 */
import { describe, expect, it } from 'vitest';
import { aiTools } from './aiToolNames';
import './aiTools';

export const TOOL_DESCRIPTION_MAX = 300;
export const PARAM_DESCRIPTION_MAX = 160;
const WORKFLOW_PROSE = [/\b(step \d|first call|then call|after that|workflow:)\b/i, /(^|\s)\d\)\s/, /\{\s*"[a-zA-Z]+"\s*:/];

/** tool → { description: current length | undefined, params: longest param length | undefined } — filled by Step 2. */
const DESCRIPTION_BUDGET_BASELINE: ReadonlyMap<string, { description?: number; params?: number }> = new Map([]);

interface Offence { tool: string; description?: number; params?: number; prose?: string; missingActions?: string[] }

function walkParamDescriptions(schema: unknown, out: number[] = []): number[] {
  if (!schema || typeof schema !== 'object') return out;
  const s = schema as { description?: unknown; properties?: Record<string, unknown>; items?: unknown };
  if (typeof s.description === 'string') out.push(s.description.length);
  for (const v of Object.values(s.properties ?? {})) walkParamDescriptions(v, out);
  if (s.items) walkParamDescriptions(s.items, out);
  return out;
}

function offenceFor(name: string): Offence | null {
  const t = aiTools.get(name)!;
  const d = t.definition.description ?? '';
  const params = walkParamDescriptions(t.definition.input_schema).filter((n) => n > PARAM_DESCRIPTION_MAX);
  const enumValues = ((t.definition.input_schema as { properties?: { action?: { enum?: unknown[] } } }).properties?.action?.enum ?? [])
    .filter((v): v is string => typeof v === 'string');
  const missingActions = enumValues.filter((a) => !d.includes(a));
  const prose = WORKFLOW_PROSE.find((re) => re.test(d))?.source;
  const o: Offence = { tool: name };
  if (d.length > TOOL_DESCRIPTION_MAX) o.description = d.length;
  if (params.length > 0) o.params = Math.max(...params);
  if (prose) o.prose = prose;
  if (missingActions.length > 0) o.missingActions = missingActions;
  return Object.keys(o).length > 1 ? o : null;
}

describe('AI tool description budget (A-W03)', () => {
  const names = [...aiTools.keys()].sort();
  const offences = names.map(offenceFor).filter((o): o is Offence => o !== null);

  it('has a populated registry', () => { expect(names.length).toBeGreaterThan(150); });

  it('PRINT (remove after Step 2): current offenders', () => {
    if (process.env.PRINT_DESCRIPTION_BASELINE) {
      console.log(JSON.stringify(offences.map((o) => [o.tool, { description: o.description, params: o.params }]), null, 0));
    }
  });

  it('every tool outside the baseline fits the budget', () => {
    const fresh = offences.filter((o) => !DESCRIPTION_BUDGET_BASELINE.has(o.tool) && (o.description || o.params));
    expect(fresh, 'new offenders — shorten, do not add to the baseline').toEqual([]);
  });

  it('no description carries workflow prose or drops a declared action (no baseline for these)', () => {
    expect(offences.filter((o) => o.prose).map((o) => `${o.tool}: /${o.prose}/`)).toEqual([]);
    expect(offences.filter((o) => o.missingActions).map((o) => `${o.tool}: ${o.missingActions!.join(',')}`)).toEqual([]);
  });

  it('baseline entries only shrink (ratchet) and disappear once fixed', () => {
    const grew: string[] = []; const stale: string[] = [];
    for (const [tool, frozen] of DESCRIPTION_BUDGET_BASELINE) {
      const now = offenceFor(tool);
      if (!now || (!now.description && !now.params)) { stale.push(tool); continue; }
      if ((now.description ?? 0) > (frozen.description ?? TOOL_DESCRIPTION_MAX)) grew.push(`${tool} description`);
      if ((now.params ?? 0) > (frozen.params ?? PARAM_DESCRIPTION_MAX)) grew.push(`${tool} params`);
    }
    expect(grew, 'a baselined description got LONGER').toEqual([]);
    expect(stale, 'fixed — delete from DESCRIPTION_BUDGET_BASELINE').toEqual([]);
  });
});
```

- [ ] **Step 2: Measure and freeze**

```bash
cd apps/api && PRINT_DESCRIPTION_BASELINE=1 npx vitest run src/services/aiTools.descriptionBudget.contract.test.ts 2>&1 | grep '^\[\[' 
```

Paste the printed array into `DESCRIPTION_BUDGET_BASELINE` (one tuple per line, sorted by tool). The 2026-09-17 source-text estimate is 24 tools over 300 (`manage_policy_feature_link` 8 708, `execute_command` 1 177, `manage_patches` 975, `get_script_execution` 749, `get_invite_funnel` 574, `manage_alert_rules` 534, `get_vulnerability_report` 527, `remediate_vulnerability` 477, `manage_configuration_policy` 476, `manage_backup_profiles` 445, …) and ~18 params over 160 — the runtime numbers replace these. Delete the `PRINT` test. The `workflow prose` / `missing action` test has **no** baseline: if it fails at this point, fix those descriptions now (they are few) rather than baselining them.

- [ ] **Step 3: Verify and commit**

```bash
cd apps/api && npx vitest run src/services/aiTools.descriptionBudget.contract.test.ts
git add apps/api/src/services/aiTools.descriptionBudget.contract.test.ts && git commit -m "test(ai): description budget lint with frozen offender baseline (A-W03)"
```

---

### Task 2: One description surface — SDK declarations read the registry

**Files:**
- Modify: `apps/api/src/services/aiAgentSdkTools.ts` (every `tool('<name>', '<inline literal>', …)` inside `buildBreezeSdkTools`)
- Modify: `apps/api/src/services/aiAgentSdkTools.mcpCoverage.test.ts` (`declaredDescription()` at `:44` and its users at `:408-420`)
- Modify: `apps/api/src/services/aiAgentSdkTools.registryParity.contract.test.ts` (new assertion)

- [ ] **Step 1: Write the failing test** — append to `registryParity.contract.test.ts`:

```ts
describe('SDK declarations use the registry description (A-W03, one description surface)', () => {
  it('every declared tool that is in the aiTools Map carries exactly the registry description', () => {
    const declared = buildBreezeSdkTools((() => { throw new Error('no handlers'); }) as never);
    const drift = declared
      .filter((t) => aiTools.has(t.name))
      .filter((t) => t.description !== aiTools.get(t.name)!.definition.description)
      .map((t) => t.name);
    expect(drift, 'declarations with their own description literal').toEqual([]);
  });
});
```

(`aiTools` from `./aiToolNames` + `import './aiTools'`.) Run → FAIL with ~132 names.

- [ ] **Step 2: Reconcile, then replace the literals**

Reconciliation rule, applied per tool **before** deleting its literal — the SDK literal was the text the chat model tuned on, so it must not vanish silently:

1. Produce the pairs once (throwaway vitest file or a node one-liner over `buildBreezeSdkTools` + `aiTools`): `name | registryLength | sdkLength | equal?`.
2. If the registry description already fits the budget and names every action → keep it, delete the literal.
3. Else write the **new registry description** now, to the budget, using the literal as the source of any disambiguation sentence the registry copy lacked (e.g. `get_security_posture`'s "not CVEs" clause lives in the SDK literal today, `mcpCoverage.test.ts:418`). This is the diet for that tool; Task 4 will find it already done.
4. Replace the literal with `registryDescription('<name>')`. M365/Google session-aware declarations (not in the Map) keep their literals — they are outside the registry by design; apply the budget to them by hand and add the same length assertion for `m365ToolTiers`/`googleToolTiers` keys in the lint (read the literal via `buildBreezeSdkTools`).

`mcpCoverage.test.ts`: `declaredDescription(name)` (`:44`) regex-extracts an inline literal and is used by the vulnerability/posture assertions (`:408-420`). Change it to return `aiTools.get(name)?.definition.description ?? <old regex result>` so those assertions keep pinning the same wording on the single surface.

- [ ] **Step 3: Verify and commit**

```bash
cd apps/api && npx vitest run src/services/aiAgentSdkTools src/services/aiTools.descriptionBudget.contract.test.ts
git add apps/api/src/services && git commit -m "refactor(ai): SDK tool declarations read the registry description — one surface (A-W03)"
```

---

### Task 3: `manage_policy_feature_link` — `describe` action carries the reference

**Files:**
- Modify: `apps/api/src/services/aiToolsConfigPolicy.ts` (`:870-925` definition; handler `:924+`)
- Modify: `apps/api/src/services/aiToolSchemas.ts` (`manage_policy_feature_link` action enum)
- Modify: `apps/api/src/services/aiGuardrails.ts` (`TIER2_READONLY_ACTIONS` `:161`)
- Modify: `apps/api/src/services/aiAgentSdkTools.mcpCoverage.test.ts:328` ("advertises featurePolicyId and the prerequisite workflow")
- Create/modify: `apps/api/src/services/aiToolsConfigPolicy.test.ts`

**Interfaces produced:**

```ts
export const POLICY_FEATURE_INLINE_SETTINGS_REFERENCE: Readonly<Record<PolicyFeatureType, string>>;  // one entry per featureType enum value, the text moved out of the description
// manage_policy_feature_link gains action 'describe' (read-only): input { action: 'describe', featureType } → { featureType, inlineSettings: string, linkOnly: boolean, featurePolicyIdHint?: string }
```

- [ ] **Step 1: Write the failing tests**

```ts
import { describe, expect, it } from 'vitest';
import { aiTools } from './aiToolNames';
import './aiTools';
import { POLICY_FEATURE_INLINE_SETTINGS_REFERENCE } from './aiToolsConfigPolicy';
import { toolInputSchemas } from './aiToolSchemas';
import { TIER2_READONLY_ACTIONS } from './aiGuardrails';

describe('manage_policy_feature_link describe action (A-W03)', () => {
  const tool = aiTools.get('manage_policy_feature_link')!;
  const enumValues = (tool.definition.input_schema as { properties: { action: { enum: string[] }; featureType: { enum: string[] } } }).properties;

  it('declares describe in the advertised enum, the Zod schema, and the read-only action table', () => {
    expect(enumValues.action.enum).toContain('describe');
    expect(toolInputSchemas.manage_policy_feature_link.safeParse({ action: 'describe', configPolicyId: '11111111-1111-4111-8111-111111111111', featureType: 'patch' }).success).toBe(true);
    expect(TIER2_READONLY_ACTIONS.manage_policy_feature_link).toContain('describe');
  });

  it('has a reference entry for every feature type and none extra', () => {
    expect(Object.keys(POLICY_FEATURE_INLINE_SETTINGS_REFERENCE).sort()).toEqual([...enumValues.featureType.enum].sort());
  });

  it('describe returns the reference for one feature type without touching the DB', async () => {
    const out = JSON.parse(await tool.handler({ action: 'describe', configPolicyId: '11111111-1111-4111-8111-111111111111', featureType: 'backup' }, {} as never));
    expect(out).toMatchObject({ featureType: 'backup', linkOnly: false });
    expect(out.inlineSettings).toContain('scheduleFrequency');
    expect(out.featurePolicyIdHint).toMatch(/backup PROFILE/);
  });

  it('describe rejects an unknown feature type with a JSON error', async () => {
    const out = JSON.parse(await tool.handler({ action: 'describe', configPolicyId: '11111111-1111-4111-8111-111111111111', featureType: 'nope' }, {} as never));
    expect(out.error).toMatch(/featureType/);
  });

  it('the description is on budget and points at describe', () => {
    expect(tool.definition.description!.length).toBeLessThanOrEqual(300);
    expect(tool.definition.description).toMatch(/describe/);
  });
});
```

Run → FAIL.

- [ ] **Step 2: Implement**

In `aiToolsConfigPolicy.ts`, above the registration:

```ts
type PolicyFeatureType = 'patch' | 'alert_rule' | 'backup' | 'security' | 'monitoring' | 'maintenance' | 'compliance' | 'automation' | 'event_log'
  | 'software_policy' | 'sensitive_data' | 'peripheral_control' | 'warranty' | 'helper' | 'remote_access' | 'pam' | 'onedrive_helper' | 'vulnerability' | 'device_lifecycle';

/**
 * The per-feature-type `inlineSettings` reference that used to be the tool
 * description (8.7 KB sent on every turn). Returned on demand by
 * `manage_policy_feature_link` action `describe`. Text moved verbatim from
 * the old description; edit it here and only here.
 */
export const POLICY_FEATURE_INLINE_SETTINGS_REFERENCE: Readonly<Record<PolicyFeatureType, string>> = {
  patch: '{ sources: ["os","third_party"], autoApprove: true, … }',   // ← paste the old bullet text for `patch`, verbatim
  alert_rule: '…', monitoring: '…', maintenance: '…', automation: '…', event_log: '…', compliance: '…', security: '…',
  backup: '…', sensitive_data: '…', warranty: '…', helper: '…', pam: '…', vulnerability: '…', device_lifecycle: '…',
  remote_access: '…', onedrive_helper: '…',
  software_policy: 'Link-only: set featurePolicyId to an existing software policy UUID; no inlineSettings.',
  peripheral_control: 'Link-only: set featurePolicyId to an existing peripheral policy UUID; no inlineSettings.',
};

const LINK_ONLY_FEATURE_TYPES = new Set<PolicyFeatureType>(['software_policy', 'peripheral_control']);
const FEATURE_POLICY_ID_HINTS: Partial<Record<PolicyFeatureType, string>> = {
  backup: 'featurePolicyId → backup PROFILE UUID (manage_backup_profiles — "what to protect"), combined with inlineSettings { schedule, retention, destinationConfigId? }',
  patch: 'featurePolicyId → existing update ring UUID (approval deferral), combined with inlineSettings for schedule/reboot',
  software_policy: 'featurePolicyId → existing software policy UUID',
  peripheral_control: 'featurePolicyId → existing peripheral policy UUID',
};
```

Every `'…'` above is the corresponding bullet from the current description at `aiToolsConfigPolicy.ts:875-903`, moved verbatim (the plan does not reproduce 8.7 KB; the source file has it). New description (≤ 300):

```
Add, update, remove or list the feature links that bundle settings into a configuration policy. Actions: add, update, remove, list, describe. Call describe with a featureType first — it returns that type's inlineSettings shape and whether it is link-only (featurePolicyId). 
```

Enum: add `'describe'`. Handler: at the top of the `safeHandler` body,

```ts
if (action === 'describe') {
  const featureType = input.featureType;
  if (typeof featureType !== 'string' || !(featureType in POLICY_FEATURE_INLINE_SETTINGS_REFERENCE)) {
    return JSON.stringify({ error: `featureType must be one of: ${Object.keys(POLICY_FEATURE_INLINE_SETTINGS_REFERENCE).join(', ')}` });
  }
  const ft = featureType as PolicyFeatureType;
  return JSON.stringify({ featureType: ft, linkOnly: LINK_ONLY_FEATURE_TYPES.has(ft), inlineSettings: POLICY_FEATURE_INLINE_SETTINGS_REFERENCE[ft], featurePolicyIdHint: FEATURE_POLICY_ID_HINTS[ft] });
}
```

`aiToolSchemas.ts`: add `'describe'` to the `manage_policy_feature_link` action enum. `aiGuardrails.ts:161`: add `manage_policy_feature_link: ['list', 'describe'],` to `TIER2_READONLY_ACTIONS` (if `list` is already covered elsewhere, add only `describe` — read the table). `mcpCoverage.test.ts:328`: the "advertises featurePolicyId and the prerequisite workflow" assertion now checks the description mentions `describe` and `featurePolicyId`, and that `POLICY_FEATURE_INLINE_SETTINGS_REFERENCE.backup` contains the prerequisite text it used to look for.

`configuration-policy` skill (`.claude/skills/configuration-policy/SKILL.md`) documents the inlineSettings shapes for humans — add one line there: "The model-facing copy is `POLICY_FEATURE_INLINE_SETTINGS_REFERENCE` in `aiToolsConfigPolicy.ts`; keep both in step."

- [ ] **Step 3: Verify and commit**

```bash
cd apps/api && npx vitest run src/services/aiToolsConfigPolicy src/services/aiGuardrails.readonly.contract.test.ts src/services/aiAgentSdkTools.mcpCoverage.test.ts src/services/aiTools.descriptionBudget.contract.test.ts src/routes/mcpServer.approvalGate.test.ts
```
The budget test's ratchet now reports `manage_policy_feature_link` as **stale** → delete it from `DESCRIPTION_BUDGET_BASELINE` in the same commit.

```bash
git add apps/api .claude/skills/configuration-policy && git commit -m "feat(ai): manage_policy_feature_link describe action; reference text out of the description (A-W03)"
```

---

### Tasks 4a–4c: Rewrite the remaining offenders, by domain group

Each task: for every tool in the group that is still in `DESCRIPTION_BUDGET_BASELINE`, rewrite `definition.description` and the over-long parameter descriptions; run the lint; delete the fixed entries from the baseline; commit. Group by A-W02 domain (`getToolDomain`), so a reviewer reads one subject area per commit.

**Rewrite recipe** (apply literally):

1. **Sentence 1 — what it returns or does.** Concrete nouns, ≤ 140 chars. `execute_command` → "Run one shell/PowerShell command on a device and return stdout/stderr/exit code."
2. **Sentence 2 — when, vs the neighbour.** Only if a neighbour exists; name it once. `manage_patches` → "Patch/KB inventory and approvals — not CVE findings (use get_vulnerability_report)."
3. **Actions clause** — `Actions: a, b, c.` listing every enum value (the lint checks presence). For > 8 actions the clause still lists them all; the 300 budget holds because sentences 1–2 shrink.
4. **Move, don't delete:** any "how to" sentence (ordering of calls, prerequisites like "create the standalone policy, then link it") goes to `DOMAIN_NOTES[<domain>]` in `aiToolIndex.ts` (≤ 400 chars per domain, one note per domain — merge with what is there). Any JSON example goes to the `apps/docs` page from Task 6. Any client-facing MCP guidance goes to `MCP_PROMPTS` (Task 6).
5. **Parameter descriptions:** type/format/default/valid values only. `orgId: 'Organization UUID (partner callers: required when more than one org is accessible)'`.

- [ ] **Task 4a — devices, scripts, patching, core** (expected offenders include `execute_command`, `manage_patches`, `get_script_execution`, `get_vulnerability_report`, `remediate_vulnerability`):

```bash
cd apps/api && npx vitest run src/services/aiTools.descriptionBudget.contract.test.ts src/services/aiToolIndex.test.ts
git add apps/api/src/services && git commit -m "refactor(ai): description diet — devices/scripts/patching/core (A-W03 4a)"
```

- [ ] **Task 4b — monitoring, network, security, backup** (`manage_alert_rules`, `manage_configuration_policy`, `manage_backup_profiles`, `manage_monitor_definitions`, …):

```bash
git add apps/api/src/services && git commit -m "refactor(ai): description diet — monitoring/network/security/backup (A-W03 4b)"
```

- [ ] **Task 4c — tickets, billing, accounts, integrations, admin, ai** (`get_invite_funnel`, `lookup_distributor_product`, `manage_ai_agents`, `manage_organizations`, M365/Google literals):

After this commit `DESCRIPTION_BUDGET_BASELINE` is `new Map([])` and the ratchet test's `stale` list is empty.

```bash
cd apps/api && npx vitest run src/services/aiTools.descriptionBudget.contract.test.ts && grep -c "new Map(\[\])" src/services/aiTools.descriptionBudget.contract.test.ts
git add apps/api/src/services && git commit -m "refactor(ai): description diet — tickets/billing/accounts/integrations/admin/ai; baseline empty (A-W03 4c)"
```

---

### Task 5: Disambiguation lives once, in the generated index

**Files:**
- Modify: `apps/api/src/services/aiToolIndex.ts` (`DOMAIN_NOTES`), `aiToolIndex.test.ts`
- Modify: `apps/api/src/services/aiAgentSystemPrompt.ts` (`AI_SYSTEM_PROMPT_TAIL` — remove the "Vulnerability vs. Posture vs. Patching" section), `aiAgentSystemPrompt.test.ts`

- [ ] **Step 1: Write the failing test** — in `aiToolIndex.test.ts`:

```ts
it('carries the vulnerability/posture/patching disambiguation and the empty-report caveat (moved from the prompt tail, #2605)', () => {
  expect(DOMAIN_NOTES.patching).toMatch(/get_security_posture returns control scores/);
  expect(DOMAIN_NOTES.patching).toMatch(/manage_patches returns the patch\/KB inventory/);
  expect(DOMAIN_NOTES.patching).toMatch(/never state that a device or the fleet has no vulnerabilities/);
});
```

and in `aiAgentSystemPrompt.test.ts` flip the four TAIL regex assertions to `not.toMatch` (the text lives in the index now) and keep the "CVE vocabulary is findable" assertion against `renderToolIndexByDomain(listChatSurfaceToolNames())`.

- [ ] **Step 2: Implement** — move the five bullets from `AI_SYSTEM_PROMPT_TAIL` into `DOMAIN_NOTES.patching` as one ≤ 400-char paragraph (drop the bullet markers; keep the four load-bearing clauses the tests pin). Delete the section from TAIL.

- [ ] **Step 3: Verify and commit**

```bash
cd apps/api && npx vitest run src/services/aiToolIndex.test.ts src/services/aiAgentSystemPrompt.test.ts
git add apps/api/src/services && git commit -m "refactor(ai): vulnerability disambiguation lives once in DOMAIN_NOTES (A-W03)"
```

---

### Task 6: Where the moved prose lands

**Files:**
- Modify: `apps/api/src/services/mcpGuidance.ts` (`MCP_PROMPTS` `:35-105`), `mcpGuidancePromptTools.test.ts`
- Create: `apps/docs/src/content/docs/features/ai-tools.mdx`
- Modify: `scripts/build-docs-index.ts` output is regenerated (`apps/api/src/data/docsIndex.json`) so `search_documentation` can find the new page

- [ ] **Step 1: MCP prompts** — for each workflow sentence removed in Task 4 that an external client needs (today: the configuration-policy "create the standalone policy, then link it via featurePolicyId" flow, and the patch approve→install flow), extend the existing `breeze-patch-remediate` / `breeze-turnkey-setup` prompt `render()` text rather than adding prompts. `mcpGuidancePromptTools.test.ts` cross-checks every snake_case token against `aiTools.keys()` — only name real tools. Run:

```bash
cd apps/api && npx vitest run src/services/mcpGuidance
```

- [ ] **Step 2: Docs page** — `apps/docs/src/content/docs/features/ai-tools.mdx`: title "AI tools reference", one H2 per domain (the 14 from `AI_TOOL_DOMAINS`), and under each the JSON examples and multi-step how-tos removed from descriptions (the `manage_policy_feature_link` inlineSettings shapes belong here in full, as a table by feature type). Then:

```bash
pnpm exec tsx scripts/build-docs-index.ts && git diff --stat apps/api/src/data/docsIndex.json   # the new page appears
cd apps/docs && pnpm astro check
```

- [ ] **Step 3: Commit**

```bash
git add apps/api/src/services/mcpGuidance.ts apps/api/src/data/docsIndex.json apps/docs/src/content/docs/features/ai-tools.mdx
git commit -m "docs(ai): AI tools reference page + MCP prompt workflows for prose moved out of descriptions (A-W03)"
```

---

### Task 7: Prove accuracy did not drop, then PR

- [ ] **Step 1: Eval before/after**

The "before" row is the one A-W01 recorded in `docs/superpowers/specs/ai-mcp/2026-09-17-agent-tool-efficiency-baseline.md` §3 (same model, `--tool-search default`, surface `chat`). Run the "after":

```bash
cd apps/api && DATABASE_URL=postgresql://unused:unused@127.0.0.1:5432/unused ANTHROPIC_API_KEY=$KEY pnpm --filter @breeze/api ai:tool-eval -- --surface chat --out /tmp/eval-a03.json --summary-md /tmp/eval-a03.md
DATABASE_URL=… ANTHROPIC_API_KEY=… pnpm --filter @breeze/api ai:tool-capture -- --surface chat --turns 2 --out /tmp/cap-a03.jsonl
```

Append a dated row to baseline §3 and §6 (accuracy, first-turn input tokens). **Gate:** accuracy ≥ the A-W01 row. If it dropped, the misses table says which tools — restore the disambiguation sentence for those tools (within budget) and re-run; do not open the PR on a regression.

- [ ] **Step 2: Verification**

```bash
cd apps/api && npx vitest run && NODE_OPTIONS=--max-old-space-size=8192 npx tsc --noEmit -p tsconfig.json && pnpm lint
```

- [ ] **Step 3: PR** — branch `feature/6147-agent-tool-efficiency/wave-6150`, `Closes #6150`. Body: before/after accuracy and token rows, the count of descriptions rewritten, the `describe` action, where each class of moved prose went, and confirmation that `DESCRIPTION_BUDGET_BASELINE` is empty. One review round.

---

## Self-review against the spec

- "Lint in Test API: tool description ≤ 300 chars, param description ≤ 160, no workflow prose" → Task 1 (unit runner, no DB).
- "Move long how-to text into `mcpGuidance` prompts + `search_documentation` content" → Task 6 (prompts; docs page indexed for `search_documentation`); model-visible workflow sentences → `DOMAIN_NOTES` (Task 4 rule 4), which is the "once, in the generated index" the spec asks for.
- "keep disambiguation ('vulnerability vs posture vs patching') once, in the generated index" → Task 5.
- "Frozen baseline of offenders shrinks to zero across the wave" → Tasks 1, 3, 4a–4c (ratchet + stale checks).
- "Re-run A-W01 eval — accuracy must not drop" → Task 7 gate.
- Not in the spec but required to make the lint mean anything: the two description surfaces collapse into one (Task 2) — index decision D7.
