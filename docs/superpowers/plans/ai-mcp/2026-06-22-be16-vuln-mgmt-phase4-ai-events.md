# BE-16 Vulnerability Management — Phase 4 (AI Tools + Events) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.
>
> **OPTIONAL PHASE.** Build only after Phases 1–3 ship and only if the curated CPE map proves insufficient (Task 5) or the brain/AI surface is wanted. The RMM is fully functional without this phase.

**Goal:** Expose vulnerability data to the AI/brain layer as governed tools, emit structured `vulnerability.*` domain events for automations/notifications, and (optionally) use AI to resolve the long tail of unmatched third-party software to CPEs — offline, cached, human-reviewable.

**Architecture:** Three AI tools register in the existing tier-based catalog (read tools = tier 1, remediation = tier 3 with approval). Events publish through the existing Redis-Streams `eventBus`. The optional AI CPE resolver runs against the *distinct unmatched* `software_inventory` names (small N, incremental), writing `software_products` rows at `cpeConfidence='ai'` for human review — never in a hot path.

**Tech Stack:** Hono (TS API), Drizzle ORM, Redis Streams event bus, the `aiTools*` registry, Anthropic tool schemas, Vitest.

**Source spec:** `internal/BE-16-vulnerability-management-v2.md`. **Predecessors:** Phases 1–3 plans.

> Revised 2026-06-23 per Codex review (corrections folded into tasks below).

## Global Constraints

- **Node:** prefix pnpm/vitest with `PATH=$HOME/.nvm/versions/node/v22.20.0/bin:$PATH`.
- **AI tool tiers** (not "low/high"): tier 1 = read-only auto-execute; tier 3 = high-risk mutation requiring explicit approval + audit. Register via `registerXxxTools(aiTools)` in a new `apps/api/src/services/aiToolsVulnerability.ts`, called from the `aiTools.ts` hub.
- **A new AI tool needs THREE wiring surfaces, not just tier + register.** The `tier` field on the registered `AiTool` feeds the approval gate (`getToolTier` at `aiTools.ts` → `aiGuardrails.ts:548`/`590`, `baseTier >= 3` ⇒ `requiresApproval`; blocking is enforced in `aiAgentSdk.ts:266` for `tier >= 2`). But registration alone is NOT enough — every tool ALSO requires:
  1. **A `TOOL_PERMISSIONS[toolName]` RBAC mapping** in `apps/api/src/services/aiGuardrails.ts` (the exported `const TOOL_PERMISSIONS` at line 87). `checkToolPermission` (line 626) hard-fails with `No RBAC permission mapping for tool "<name>"` when the entry is missing. Use `{ resource, action }` for single-permission tools (e.g. `{ resource: 'devices', action: 'read' }`).
  2. **A Zod input schema** registered in the `toolInputSchemas` record in `apps/api/src/services/aiToolSchemas.ts` (the exported `const toolInputSchemas` at line 93). `executeTool` calls `validateToolInput(toolName, input)` (`aiTools.ts:332` → `aiToolSchemas.ts:1052`) BEFORE the handler; a missing schema rejects every call with `No input schema registered for tool "<name>"`.
  3. **Registration** of the `AiTool` (definition + `tier` + `handler` + optional `deviceArgs`) via the group's `registerVulnerabilityTools(aiTools)` call, wired into the `aiTools.ts` hub alongside the existing `registerXxxTools(aiTools)` lines (~line 205+).
- **Events:** every new event name must be added to the `EventType` union in `apps/api/src/services/eventBus.ts`; emit via `publishEvent(type, orgId, payload, source, opts)`.
- **AI tool handlers** return a string (the model-facing result); reads must be RLS-correct (tenant context) — but SDK/stream paths run outside request context, so set context explicitly (`[[rls_silent_zero_row_read_sdk_poll]]`).

## Interfaces inherited from Phases 1–3

- `device_vulnerabilities`, `vulnerabilities`, `software_products`, `software_inventory`.
- `apps/api/src/services/vulnerabilityRemediation.ts` → `remediateVulnerabilities(orgId, deviceVulnerabilityIds, actorUserId, auth: AuthContext)` — **context-free** (takes an `AuthContext`, not a Hono `Context`), so this SDK/stream-path tool handler can call it directly (the AI-tool handler signature is `(input, auth: AuthContext)`, so it already holds the `auth` to pass through).
- `apps/api/src/services/vulnerabilityCorrelation.ts` → `correlateOrg`.
- `apps/api/src/services/aiTools.ts` (hub) + the `AiTool { definition, tier, handler, deviceArgs? }` shape.
- `apps/api/src/services/eventBus.ts` → `publishEvent`, `EventType`.

## File Structure

| File | Responsibility |
|---|---|
| `apps/api/src/services/eventBus.ts` (modify) | Add `vulnerability.*` to `EventType` |
| `apps/api/src/services/vulnerabilityCorrelation.ts` (modify) | Emit `vulnerability.critical_detected` on new critical opens |
| `apps/api/src/services/vulnerabilityRemediation.ts` (modify) | Emit `vulnerability.remediation_scheduled` |
| `apps/api/src/services/aiToolsVulnerability.ts` (create) | 3 AI tools (definitions + handlers) |
| `apps/api/src/services/aiTools.ts` (modify) | Register the new tool group (`registerVulnerabilityTools(aiTools)`) |
| `apps/api/src/services/aiGuardrails.ts` (modify) | Add a `TOOL_PERMISSIONS` RBAC entry per new tool |
| `apps/api/src/services/aiToolSchemas.ts` (modify) | Add a Zod schema per new tool to `toolInputSchemas` |
| `apps/api/src/services/aiCpeResolver.ts` (create, optional) | AI CPE resolution for unmatched products |

---

### Task 1: Event types + critical-detected emission

**Files:**
- Modify: `apps/api/src/services/eventBus.ts`
- Modify: `apps/api/src/services/vulnerabilityCorrelation.ts`
- Test: `apps/api/src/services/vulnerabilityEvents.integration.test.ts`

**Interfaces:**
- Produces: `EventType` gains `'vulnerability.critical_detected'`, `'vulnerability.remediation_scheduled'`, `'vulnerability.remediated'`. `correlateOrg` emits `vulnerability.critical_detected` (payload `{ deviceId, cveId, cvssScore, riskScore }`) for each newly-created `device_vulnerabilities` row whose severity is `Critical`.

- [ ] **Step 1: Add the event types** — append the three string literals to the `EventType` union in `eventBus.ts` (keep the file's grouping/comments).

- [ ] **Step 2: Write the failing integration test**

```ts
it('emits vulnerability.critical_detected for a new critical vuln', async () => {
  const events: any[] = [];
  const unsub = eventBus.on('vulnerability.critical_detected', (e) => events.push(e));
  const { orgId } = await seedCriticalDeviceVulnPrereqs(); // facts + inventory, CVSS 9.8
  await correlateOrg(orgId);
  await waitFor(() => expect(events.length).toBeGreaterThanOrEqual(1));
  expect(events[0].payload.cveId).toMatch(/^CVE-/);
  unsub();
});
it('does not emit for a Medium severity vuln', async () => {
  const events: any[] = [];
  const unsub = eventBus.on('vulnerability.critical_detected', (e) => events.push(e));
  const { orgId } = await seedMediumDeviceVulnPrereqs();
  await correlateOrg(orgId);
  expect(events.length).toBe(0);
  unsub();
});
```

- [ ] **Step 3: Run to verify failure**

Run: `PATH=$HOME/.nvm/versions/node/v22.20.0/bin:$PATH pnpm --filter @breeze/api exec vitest run --config vitest.integration.config.ts src/services/vulnerabilityEvents.integration.test.ts`
Expected: FAIL.

- [ ] **Step 4: Implement emission** — in `correlateOrg`, after inserting new open rows, for each insert where the joined `vulnerabilities.severity === 'Critical'`, `await publishEvent('vulnerability.critical_detected', orgId, { deviceId, cveId, cvssScore, riskScore }, 'vulnerabilityCorrelation', { priority: 'high', siteId })`.

- [ ] **Step 5: Run to verify pass**

Run: `PATH=$HOME/.nvm/versions/node/v22.20.0/bin:$PATH pnpm --filter @breeze/api exec vitest run --config vitest.integration.config.ts src/services/vulnerabilityEvents.integration.test.ts`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add apps/api/src/services/eventBus.ts apps/api/src/services/vulnerabilityCorrelation.ts apps/api/src/services/vulnerabilityEvents.integration.test.ts
git commit -m "feat(vuln): vulnerability.* event types + critical-detected emission"
```

---

### Task 2: Remediation-scheduled + remediated events

**Files:**
- Modify: `apps/api/src/services/vulnerabilityRemediation.ts`
- Test: `apps/api/src/services/vulnerabilityRemediationEvents.integration.test.ts`

**Interfaces:**
- Produces: `remediateVulnerabilities` emits `vulnerability.remediation_scheduled` per scheduled item; a patch-completion hook emits `vulnerability.remediated` when a remediation's patch job completes (and flips the `device_vulnerabilities.status` to `patched` — wire into the existing patch-result path or the next `correlateOrg`).

- [ ] **Step 1: Write the failing test** — assert `vulnerability.remediation_scheduled` fires on remediate with payload `{ deviceVulnerabilityId, cveId, patchId }`.

```ts
it('emits remediation_scheduled when a patch job is enqueued', async () => {
  const events: any[] = [];
  const unsub = eventBus.on('vulnerability.remediation_scheduled', (e) => events.push(e));
  const { orgId, dvId, userId, auth } = await seedDeviceVulnWithMatchingPatch({ cveId: 'CVE-2025-50165' });
  // remediateVulnerabilities(orgId, deviceVulnerabilityIds, actorUserId, auth) —
  // context-free core; `auth` is an org-scoped AuthContext for `orgId`/`userId`.
  await remediateVulnerabilities(orgId, [dvId], userId, auth);
  await waitFor(() => expect(events.length).toBe(1));
  unsub();
});
```

- [ ] **Step 2: Run to verify failure**

Run: `PATH=$HOME/.nvm/versions/node/v22.20.0/bin:$PATH pnpm --filter @breeze/api exec vitest run --config vitest.integration.config.ts src/services/vulnerabilityRemediationEvents.integration.test.ts`
Expected: FAIL.

- [ ] **Step 3: Implement** — emit `vulnerability.remediation_scheduled` inside `remediateVulnerabilities` for each scheduled id. For `vulnerability.remediated`: in the patch-result handler (or the correlation resolve-patched step), emit when a previously-open vuln transitions to `patched`.

- [ ] **Step 4: Run to verify pass** (same command) — Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add apps/api/src/services/vulnerabilityRemediation.ts apps/api/src/services/vulnerabilityRemediationEvents.integration.test.ts
git commit -m "feat(vuln): remediation_scheduled + remediated events"
```

---

### Task 3: AI read tools (tier 1)

> **Three wiring surfaces (see Global Constraints):** for EACH tool added below you must (a) register the `AiTool`, (b) add a `TOOL_PERMISSIONS[toolName]` RBAC entry in `aiGuardrails.ts`, and (c) add a Zod schema to `toolInputSchemas` in `aiToolSchemas.ts`. Skipping (b) hard-fails execution with `No RBAC permission mapping`; skipping (c) rejects every call with `No input schema registered`.

**Files:**
- Create: `apps/api/src/services/aiToolsVulnerability.ts`
- Modify: `apps/api/src/services/aiTools.ts` (register the group)
- Modify: `apps/api/src/services/aiGuardrails.ts` (`TOOL_PERMISSIONS` entries)
- Modify: `apps/api/src/services/aiToolSchemas.ts` (`toolInputSchemas` entries)
- Test: `apps/api/src/services/aiToolsVulnerability.test.ts`

**Interfaces:**
- Produces: `registerVulnerabilityTools(aiTools: Map<string, AiTool>): void` registering:
  - `get_vulnerability_report` (tier 1) — args `{ severity?, status? }`; returns a fleet summary string.
  - `get_device_vulnerabilities` (tier 1, `deviceArgs: ['deviceId']`) — args `{ deviceId }`; returns that device's open vulns.
- Adds `TOOL_PERMISSIONS` entries: `get_vulnerability_report: { resource: 'devices', action: 'read' }`, `get_device_vulnerabilities: { resource: 'devices', action: 'read' }`.
- Adds `toolInputSchemas` entries for both tools.

- [ ] **Step 1: Write the failing test** — assert tier, RBAC mapping, schema, and handler output. (`fakeAuthCtx` is a minimal `AuthContext`: `{ orgId: 'org1', accessibleOrgIds: ['org1'], token: { roleId: null } } as any` — `roleId: null` short-circuits RBAC in `checkToolPermission` for the registration tests.)

```ts
import { describe, it, expect, vi } from 'vitest';
import { registerVulnerabilityTools } from './aiToolsVulnerability';
import { TOOL_PERMISSIONS } from './aiGuardrails';
import { toolInputSchemas } from './aiToolSchemas';
import type { AiTool } from './aiTools';
import type { AuthContext } from '../middleware/auth';

const fakeAuthCtx = { orgId: 'org1', accessibleOrgIds: ['org1'], token: { roleId: null } } as unknown as AuthContext;

it('registers the two read tools as tier 1', () => {
  const map = new Map<string, AiTool>();
  registerVulnerabilityTools(map);
  expect(map.get('get_vulnerability_report')!.tier).toBe(1);
  expect(map.get('get_device_vulnerabilities')!.tier).toBe(1);
});

it('every registered vulnerability tool has a TOOL_PERMISSIONS entry and a Zod schema', () => {
  const map = new Map<string, AiTool>();
  registerVulnerabilityTools(map);
  for (const name of map.keys()) {
    expect(TOOL_PERMISSIONS[name], `missing TOOL_PERMISSIONS["${name}"]`).toBeDefined();
    expect(toolInputSchemas[name], `missing toolInputSchemas["${name}"]`).toBeDefined();
  }
});

it('get_device_vulnerabilities returns the device summary', async () => {
  const map = new Map<string, AiTool>();
  registerVulnerabilityTools(map);
  const out = await map.get('get_device_vulnerabilities')!.handler({ deviceId: 'd1' }, fakeAuthCtx);
  expect(out).toContain('CVE-');
});
```

- [ ] **Step 2: Run to verify failure**

Run: `PATH=$HOME/.nvm/versions/node/v22.20.0/bin:$PATH pnpm --filter @breeze/api exec vitest run src/services/aiToolsVulnerability.test.ts`
Expected: FAIL.

- [ ] **Step 3: Implement** — follow the `aiToolsAgentLogs.ts` shape:
  - Import the request-context proxy `db` from `../db` (`import { db } from '../db';`). Handlers run on SDK/stream paths OUTSIDE the request's AsyncLocalStorage DB context, so each handler must establish RLS context explicitly or RLS silently returns 0 rows (`[[rls_silent_zero_row_read_sdk_poll]]`). Resolve the org via a `getOrgId(auth)` helper (`auth.orgId ?? auth.accessibleOrgIds?.[0] ?? null`) and wrap the query in `withDbAccessContext({ scope: 'organization', orgId, accessibleOrgIds: [orgId] }, async () => { ... use db ... })`. Both helpers are imported from `../db`:
    ```ts
    import { db, withDbAccessContext } from '../db';
    ```
    (Note: `withSystemDbAccessContext(fn)` is ARGLESS — callback only — and would over-broaden to a cross-tenant scope, so use the org-scoped `withDbAccessContext(ctx, fn)` here.)
  - Register the group in `aiTools.ts`: add `import { registerVulnerabilityTools } from './aiToolsVulnerability';` near the other tool-group imports (~line 16) and `registerVulnerabilityTools(aiTools);` alongside the other `registerXxxTools(aiTools)` calls (~line 205+).
  - Add the `TOOL_PERMISSIONS` entries in `aiGuardrails.ts` (inside the exported `const TOOL_PERMISSIONS`, ~line 87):
    ```ts
    get_vulnerability_report: { resource: 'devices', action: 'read' },
    get_device_vulnerabilities: { resource: 'devices', action: 'read' },
    ```
  - Add the Zod schemas in `aiToolSchemas.ts` (inside the exported `const toolInputSchemas`, ~line 93):
    ```ts
    get_vulnerability_report: z.object({
      severity: z.enum(['Critical', 'High', 'Medium', 'Low']).optional(),
      status: z.enum(['open', 'patched', 'mitigated', 'accepted']).optional(),
    }),
    get_device_vulnerabilities: z.object({ deviceId: uuid }),
    ```
    (`uuid` is the reusable `z.string().guid()` validator already defined at the top of the file.)

- [ ] **Step 4: Run to verify pass** (same command) — Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add apps/api/src/services/aiToolsVulnerability.ts apps/api/src/services/aiTools.ts apps/api/src/services/aiGuardrails.ts apps/api/src/services/aiToolSchemas.ts apps/api/src/services/aiToolsVulnerability.test.ts
git commit -m "feat(ai): tier-1 vulnerability read tools (RBAC + schema wired)"
```

---

### Task 4: AI remediation tool (tier 3, approval)

> **Three wiring surfaces (see Global Constraints):** the new `remediate_vulnerability` tool needs (a) registration with `tier: 3`, (b) a `TOOL_PERMISSIONS` entry, AND (c) a Zod schema. The `tier: 3` registration is what drives `requiresApproval` (`aiGuardrails.ts:590`, blocked in `aiAgentSdk.ts:266`), but WITHOUT (b) the tool hard-fails `No RBAC permission mapping` and WITHOUT (c) it's rejected by `validateToolInput` before the handler runs — so a `tier`-only change leaves the tool non-functional.

**Files:**
- Modify: `apps/api/src/services/aiToolsVulnerability.ts`
- Modify: `apps/api/src/services/aiGuardrails.ts` (`TOOL_PERMISSIONS` entry)
- Modify: `apps/api/src/services/aiToolSchemas.ts` (`toolInputSchemas` entry)
- Test: `apps/api/src/services/aiToolsVulnerability.test.ts` (extend)

**Interfaces:**
- Produces: `remediate_vulnerability` (tier 3) — args `{ deviceVulnerabilityIds: string[] }`; handler resolves `orgId` and `actorUserId` from `auth`, calls `remediateVulnerabilities(orgId, ids, actorUserId, auth)` (the context-free Phase 3 core — `auth` is the tool handler's own `AuthContext` param, which carries the org+site closures the core needs) and returns a result string. Tier 3 ⇒ the approval gate fires; the handler assumes approval already granted.
- Adds `TOOL_PERMISSIONS['remediate_vulnerability'] = { resource: 'patches', action: 'execute' }` (precedent: `manage_patches.install`/`scan`).
- Adds a `toolInputSchemas['remediate_vulnerability']` Zod schema.

- [ ] **Step 1: Write the failing test** — the registration-coverage test from Task 3 (`every registered vulnerability tool has a TOOL_PERMISSIONS entry and a Zod schema`) now also covers `remediate_vulnerability`. Add:

```ts
import * as remediation from './vulnerabilityRemediation';

it('registers remediate_vulnerability as tier 3', () => {
  const map = new Map<string, AiTool>();
  registerVulnerabilityTools(map);
  expect(map.get('remediate_vulnerability')!.tier).toBe(3);
});

it('invokes the remediation service', async () => {
  // remediateVulnerabilities(orgId, deviceVulnerabilityIds, actorUserId, auth) —
  // verified Phase 3 signature (context-free: takes AuthContext, not Hono Context)
  const spy = vi.spyOn(remediation, 'remediateVulnerabilities').mockResolvedValue({ scheduled: 1, skipped: [] });
  const map = new Map<string, AiTool>();
  registerVulnerabilityTools(map);
  await map.get('remediate_vulnerability')!.handler({ deviceVulnerabilityIds: ['dv1'] }, fakeAuthCtx);
  // 4-arg shape: orgId, ids, actorUserId, auth — the handler forwards its own auth.
  expect(spy).toHaveBeenCalledWith('org1', ['dv1'], expect.anything(), fakeAuthCtx);
});
```

- [ ] **Step 2: Run to verify failure**

Run: `PATH=$HOME/.nvm/versions/node/v22.20.0/bin:$PATH pnpm --filter @breeze/api exec vitest run src/services/aiToolsVulnerability.test.ts`
Expected: FAIL (tool not registered).

- [ ] **Step 3: Implement** the tier-3 tool:
  - Register the `AiTool` with `tier: 3` whose handler resolves `orgId` via the `getOrgId(auth)` helper and `actorUserId` from `auth.token?.userId ?? auth.userId` (match the field your `AuthContext` exposes — see `aiToolsAlerts.ts` for the local convention), then calls `remediateVulnerabilities(orgId, ids, actorUserId, auth)` — forwarding the handler's own `auth` (the 4th arg the context-free Phase 3 core needs for its org+site check, since there is no Hono `Context` on the SDK path) — and returns a summary string. `remediateVulnerabilities` already establishes its own DB context internally (Phase 3), so the handler does not re-wrap it.
  - Add `remediate_vulnerability: { resource: 'patches', action: 'execute' }` to `TOOL_PERMISSIONS` in `aiGuardrails.ts`.
  - Add to `toolInputSchemas` in `aiToolSchemas.ts`:
    ```ts
    remediate_vulnerability: z.object({
      deviceVulnerabilityIds: z.array(uuid).min(1).max(100),
    }),
    ```

- [ ] **Step 4: Run to verify pass** (same command) — Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add apps/api/src/services/aiToolsVulnerability.ts apps/api/src/services/aiGuardrails.ts apps/api/src/services/aiToolSchemas.ts apps/api/src/services/aiToolsVulnerability.test.ts
git commit -m "feat(ai): tier-3 remediate_vulnerability tool (approval + RBAC + schema)"
```

---

### Task 5: (Optional) AI CPE resolver for the long tail

> Build only if, after Phases 1–3, a meaningful share of `software_inventory` remains unmatched (no curated CPE, no MSRC/SOFA fact). Measure first.

**Files:**
- Create: `apps/api/src/services/aiCpeResolver.ts`
- Test: `apps/api/src/services/aiCpeResolver.test.ts`

**Interfaces:**
- Produces: `resolveUnmatchedCpes(limit = 50): Promise<{ proposed: number }>` — selects DISTINCT `software_inventory.(name, vendor)` with no `software_products` match, asks the model to propose a CPE per product (batched), and upserts `software_products` rows at `cpeConfidence='ai'` (NOT auto-trusted — surfaced for human review before facts are generated from them).

- [ ] **Step 1: Write the failing test** — mock the model client; assert it proposes CPEs and writes `cpeConfidence='ai'` rows, and that an empty unmatched set yields `{ proposed: 0 }`.

- [ ] **Step 2: Run to verify failure**

Run: `PATH=$HOME/.nvm/versions/node/v22.20.0/bin:$PATH pnpm --filter @breeze/api exec vitest run src/services/aiCpeResolver.test.ts`
Expected: FAIL.

- [ ] **Step 3: Implement** — distinct unmatched query → batched model prompt (return strict `{name, vendor, cpe|null}`) → upsert `cpeConfidence='ai'`. Never generate match facts directly from `ai` confidence rows without a promotion step (curated review flips them to `curated`).

- [ ] **Step 4: Run to verify pass** (same command) — Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add apps/api/src/services/aiCpeResolver.ts apps/api/src/services/aiCpeResolver.test.ts
git commit -m "feat(vuln): optional AI CPE resolver (human-review gated)"
```

---

## Self-Review

**Spec coverage (v2 Phase 4):**
- Tier 1/3 AI tools → Task 3, 4. ✅
- `vulnerability.*` events (3) → Task 1, 2. ✅
- AI-assisted CPE resolution (optional) → Task 5. ✅

**Three wiring surfaces per AI tool:** each of `get_vulnerability_report`, `get_device_vulnerabilities`, `remediate_vulnerability` has (a) an `AiTool` registration, (b) a `TOOL_PERMISSIONS` RBAC entry, and (c) a `toolInputSchemas` Zod schema — Tasks 3 and 4 modify all three files (`aiToolsVulnerability.ts`, `aiGuardrails.ts`, `aiToolSchemas.ts`). The Task 3 coverage test asserts every registered vuln tool has both a `TOOL_PERMISSIONS` entry and a schema, so a future-added tool that forgets a surface fails the suite instead of silently hard-failing at runtime. ✅

**Placeholder scan:** real code in code steps; commands have expected output. ✅
**Type consistency:** `remediateVulnerabilities(orgId, deviceVulnerabilityIds, actorUserId, auth: AuthContext)` signature matches Task 4's tool handler (which forwards its own `auth`), Task 2's events test, and Phase 3 Task 3's context-free core — the AI tool runs on the SDK/stream path with no Hono `Context`, so the 4th arg is the `AuthContext` both call sites possess; event payload fields consistent between emit (Task 1/2) and tests. `withDbAccessContext(ctx, fn)` takes a context object; `withSystemDbAccessContext(fn)` is argless — Task 3 handlers use the org-scoped `withDbAccessContext` form. ✅

## Notes for the implementer

- **AI never in the hot path:** Task 5 runs against the *distinct unmatched* set (small, incremental, cached), and its output is review-gated (`cpeConfidence='ai'` → promote to `curated`). Match facts are only generated from `curated`/`authoritative` rows.
- **SDK context trap:** AI tool handlers run outside request context — set the DB access context explicitly or reads return 0 rows silently (`[[rls_silent_zero_row_read_sdk_poll]]`).
- **Events are fire-and-forget** for the emitter; consumers (automations/notifications) are out of scope here.
```
