---
tracking_issue: LanternOps/breeze#7598
---

# AI Model Registry W01: Platform Model Catalog Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

Closes #7599 (wave W01 of feature #7598).

**Goal:** Replace the hard-coded Claude model lists with a system-wide `ai_platform_models` registry that is seeded from today's constants, kept current by daily Anthropic Models API discovery, edited by platform operators at `/admin/ai-models`, and read by every thinking/effort decision and every token-based price lookup. With the registry equal to its seed, no surface changes behaviour.

**Architecture:** One new system-wide table, `ai_platform_models` (no tenant column, no RLS; same posture as `llm_provider_catalog`). It is seeded by migration and upserted by a BullMQ discovery job (`ai-model-discovery`). Discovery never enables, prices or deletes anything.

Two pure modules own the derivation:
- `capabilities.ts` turns the raw Models API `capabilities` tree into a `ThinkingMode`.
- `wireParams.ts` (`buildWireParams`) turns mode + option support + requested options into wire params. It replaces W00's `aiModelThinking.ts`.

Synchronous hot paths read an in-process snapshot of the registry:
- the Agent SDK `query()` options;
- the cost tracker's token fallback.

The snapshot is refreshed every 60 s and after every admin write or sync. A cold snapshot, a missing row, or a row whose capabilities derive to `unknown` falls back to W00's exact behaviour.

Validation paths read the database directly:
- the session model check;
- the partner default;
- catalog `model_map` keys.

**Tech Stack:** Hono, Drizzle ORM on PostgreSQL (hand-written SQL migrations), BullMQ + Redis, `@anthropic-ai/sdk` 0.128 (`client.models.list()`), `@anthropic-ai/claude-agent-sdk` 0.3.286 (pinned by #7593), zod v4 in `@breeze/shared`, Vitest (unit + real-Postgres integration), React (Astro island) + `runAction` + the shared `Drawer`.

**Spec:** `docs/superpowers/specs/ai-mcp/2026-09-30-ai-model-registry-design.md` (v3). This wave covers §5.1, §6 (platform key only), §7, §8 (platform rates) and the `/admin/ai-models` row of §11.

**Names:** `docs/superpowers/plans/ai-mcp/2026-09-30-ai-model-registry-index.md` is authoritative for every identifier. Names this plan adds are listed under "Index additions" at the end.

## Global Constraints

- **Precondition:** PR #7593 (W00, issue #7587) is merged. Branch from `main` after it lands. Until then its code is on `origin/feat/7587-sonnet55-adaptive-thinking`, and this plan describes the post-merge tree. In particular, these files exist:
  - `services/aiModelThinking.ts`
  - `services/aiOfferableModels.ts`
  - migration `2026-11-12-110000-partner-llm-catalog-pin-default-model.sql`
- **Workflow:**
  - Run `get_feature_status` for #7598, then `start_wave` for #7599.
  - Branch: `feature/7598-ai-model-registry/wave-7599`.
  - The PR body contains `Closes #7599`.
- **Migrations:** exactly two new files. Both must sort after the newest committed migration, which is `2026-11-12-110000-partner-llm-catalog-pin-default-model.sql` once #7593 lands. Re-run `git ls-tree --name-only origin/main apps/api/migrations | sort | tail -3` before each commit, and rename if `main` moved past them.
  - `apps/api/migrations/2026-11-13-100000-ai-platform-models.sql`: DDL only.
  - `apps/api/migrations/2026-11-13-100100-ai-platform-models-seed.sql`: writes rows, so it elects system scope first.
- **Migration rules:**
  - Idempotent: `CREATE TABLE IF NOT EXISTS`, `CREATE UNIQUE INDEX IF NOT EXISTS`, `INSERT … ON CONFLICT (model_id) DO NOTHING`.
  - No `BEGIN`/`COMMIT`.
  - Never edit a shipped migration.
  - The seed reports its row count with `RAISE NOTICE`.
- **Tenancy:** `ai_platform_models` has no tenant column and no RLS. It goes in `INTENTIONAL_UNSCOPED` in `rls-coverage.integration.test.ts`, with the same justification as `llm_provider_catalog`; this plan is its plan-doc entry. It has no `org_id`, `partner_id`, `device_id`, `ticket_id` or user FK, so **no** cascade, merge, device, ticket or export-policy registration applies. Task 6 verifies that by grep, not by assumption.
- **Write gates:** only two paths write the table, and both run in system scope:
  - the discovery worker;
  - `updatePlatformModelAdmin`, reached only through `/admin/ai-models` (platform admin + `requireMfa`).
- **Parity:** with the registry equal to its seed, every surface's thinking/effort params and every token-priced cost equal W00's. Tasks 10 and 11 pin this per seeded id, against frozen copies of W00's `MODEL_PRICING` and `OFFERABLE_AI_MODELS`.
- **Bootstrap fallback:** any of the following uses W00's exact rules, which move verbatim into `services/aiModel.ts`:
  - a cold snapshot;
  - a model id with no registry row;
  - a row whose capabilities derive to `unknown`.
- **No routing or funding change in W01** (that is W03). These stay as they are:
  - `resolveDefaultModel()`;
  - `resolveLlmConfig`;
  - `getLlmBillingSourceForOrg`;
  - the SDK `total_cost_usd` preference.

  `is_platform_default` is stored and editable, but nothing routes on it until W03's `resolveModel`.
- **Index invariant 2:** `buildWireParams` is the only builder of thinking/effort/speed params. That covers production surfaces and the fidelity harness probe. The two `__scripts__` spike tools are the only exception, because they exist to send raw variants.
- **Index invariant 1:** no new `'claude-` model literal outside these places:
  - the seed migration;
  - `__fixtures__/`;
  - test files;
  - `services/aiModel.ts`.

  W01 keeps this by construction. W03 adds the contract test.
- **Discovery:**
  - Platform key (`ANTHROPIC_API_KEY`) only, against `https://api.anthropic.com` only.
  - It skips when `ANTHROPIC_BASE_URL` points anywhere else (the self-host gateway case).
  - It never enables, prices, deletes, or changes an assignment.
  - A failed or skipped sync changes no lifecycle.
- **Fidelity harness:** `FIDELITY_HARNESS_VERSION` stays `'1'`. A bump would invalidate every listed catalog revision's verifications in production. The new probe is recorded, never gating.
- **DB contexts:**
  - Service reads and writes use `withSystemDbAccessContext`, which joins an ambient request context.
  - Network calls (the Models API, ops alerts) run outside any DB context.
  - The snapshot refresher runs on a boot timer, or via `runAfterDbContextExit` after a write.
- **Web:**
  - Every mutation goes through `runAction`.
  - Every interactive element has a `data-testid`.
  - New strings go in all 8 locales (`localeParity.test.ts`). The pt-BR strings are machine-drafted pending native review, and the PR body says so.
  - `AiModels.tsx` joins the `no-silent-mutations` list from birth.
- **Tests:**
  - Placed alongside source. Real-Postgres suites go under `apps/api/src/__tests__/integration/`.
  - Unit: `cd apps/api && npx vitest run <path>` (never `pnpm --filter x test -- --run`).
  - Integration: `pnpm test-stack up`, then `cd apps/api && npx vitest run --config vitest.integration.config.ts <path>`.
  - RLS coverage: `DB_CONTEXTLESS_WRITE_STRICT=true pnpm --filter=@breeze/api test:rls-coverage`.
  - Drift: `pnpm db:check-drift`.
- **Commits:** one per task, conventional message, ending with `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>`. Never commit on `main`.
- **Public repo:** no IPs, hostnames or infrastructure details in code, comments, findings, commits or the PR.

## Review Focus

These are the five input classes most likely to bite. Each has a pinning test in the named task.

1. **A self-host on a gateway, or with no platform key.**
   - Expected behaviour:
     - Discovery reports `skipped` and touches nothing.
     - The seeded rows stay `available`.
     - Chat keeps sending W00's params.
   - Pinned by:
     - Task 13: `syncPlatformModels` skip cases, and the integration test "a skipped sync changes no row".
     - Task 10: cold-snapshot parity.
2. **The Models API omits an id we seeded, or an operator clicks Refresh repeatedly.**
   - Example: it lists only `claude-haiku-4-5-20251001` and not the alias.
   - Expected behaviour:
     - A row no sync has ever seen (`last_seen_at IS NULL`) never changes lifecycle.
     - `missing` needs 3 consecutive successful syncs **and** 48 h absent.
     - `retired` needs 14 days absent.
   - Pinned by Task 13 (`computeLifecycleAfterSync` table, plus the integration "never-seen alias survives" and "three quick refreshes do not mark missing").
3. **A registry row with null or garbage capabilities, or a cold snapshot at boot.**
   - Sonnet 5.5, Opus 5.5 and Fable must never receive `thinking: {type:'disabled'}`, because they return a 400.
   - Pinned by Task 10 ("a row whose capabilities derive to unknown falls back to the W00 rules", "cold snapshot = W00 table").
4. **Operator edits that break invariants.** Each of these must be rejected with a clear 400/409, with a DB CHECK behind it:
   - un-offering or un-defaulting the current default;
   - offering an unpriced or retired model;
   - a second default;
   - effort levels the model lacks;
   - `updates` on a non-adaptive model.

   Pinned by:
   - Task 8 (`validatePlatformModelAdminPatch` table);
   - Task 6 (raw-SQL CHECK and unique backstops);
   - Task 9 (atomic default swap).
5. **Existing catalog verifications and the new probe.**
   - W01 must not invalidate a single verification.
   - A provider that rejects adaptive thinking must still pass verification. It is merely recorded as `adaptiveEffort: false`.
   - Pinned by Task 17 ("probe failure keeps `passed`", "harness version unchanged", "every request uses `max_tokens ≥ 2048`").

---

## File Structure

**Create**

| Path | Responsibility |
|---|---|
| `docs/superpowers/specs/ai-mcp/2026-09-30-ai-model-registry-w01-spike-findings.md` | Spike answers Q1–Q7 and the decisions D1–D5 they gate |
| `apps/api/src/services/aiModels/__scripts__/sdkOptionPassthroughSpike.ts` | Agent SDK `query()` against a local capture server: which options reach the wire |
| `apps/api/src/services/aiModels/__scripts__/modelsApiProbe.ts` | Models API capability dump plus optional `inference_geo` and fast-mode probes |
| `packages/shared/src/validators/aiModelOptions.ts` (+ `.test.ts`) | `OfferingOptions`, `OptionSupport`, `OptionRates`, `ModelRates`, literal sets |
| `packages/shared/src/constants/aiSurfaces.ts` (+ `.test.ts`) | `AI_SURFACES`, `AI_SURFACE_ROLES`, `TOOL_REQUIRING_SURFACES` |
| `apps/api/src/services/aiModels/capabilities.ts` (+ `.test.ts`) | `deriveCapabilities`, `deriveOptionSupport`, `mergeDiscoveredOptionSupport`, `optionSupportErrors` |
| `apps/api/src/services/aiModels/wireParams.ts` (+ `.test.ts`) | `buildWireParams` plus the two transport adapters |
| `apps/api/src/services/aiModels/pricing.ts` (+ `.test.ts`) | `RateSnapshot`, `priceInvocation`, `computeInvocationCents`, `platformRateSnapshot` |
| `apps/api/migrations/2026-11-13-100000-ai-platform-models.sql` | Table, CHECKs, partial unique default index |
| `apps/api/migrations/2026-11-13-100100-ai-platform-models-seed.sql` | Seed from W00 `MODEL_PRICING` / `OFFERABLE_AI_MODELS` |
| `apps/api/src/db/schema/aiPlatformModels.ts` | Drizzle definition |
| `apps/api/src/db/schema/aiPlatformModels.contract.test.ts` | CHECK literals ↔ shared sets; no tenant column |
| `apps/api/src/services/aiModels/__fixtures__/seededPlatformModels.ts` | Seed rows as `PlatformModel` objects plus frozen W00 oracles |
| `apps/api/src/services/aiModels/__fixtures__/seededPlatformModels.test.ts` | Fixture self-consistency (profiles, derived support) |
| `apps/api/src/services/aiModels/platformModelSnapshot.ts` (+ `.test.ts`) | Dependency-free in-process snapshot |
| `apps/api/src/services/aiModels/platformModelAdmin.ts` (+ `.test.ts`) | Pure admin-patch validation, `PlatformModelError` |
| `apps/api/src/services/aiModels/platformModels.ts` (+ `.test.ts`) | DB access, upsert, admin update, snapshot refresh/refresher |
| `apps/api/src/services/aiModels/modelWireOptions.ts` (+ `.test.ts`) | Sync per-model wire options for the eight existing call sites (registry, else W00 fallback) |
| `apps/api/src/services/aiModels/discovery.ts` (+ `.test.ts`) | `discoverAnthropicModels`, `computeLifecycleAfterSync`, `syncPlatformModels` |
| `apps/api/src/services/aiModels/index.ts` | Thin re-export hub (index contract) |
| `apps/api/src/jobs/aiModelDiscoveryWorker.ts` (+ `.test.ts`) | Queue `ai-model-discovery`, daily + manual + boot `sync-platform` |
| `apps/api/src/routes/admin/aiModels.ts` (+ `.test.ts`) | `/admin/ai-models` list / refresh / patch |
| `apps/api/src/__tests__/integration/aiPlatformModels.integration.test.ts` | Posture, CHECKs, seed parity, service ops |
| `apps/api/src/__tests__/integration/aiModelDiscovery.integration.test.ts` | Sync upsert / lifecycle / notification against real Postgres |
| `apps/web/src/pages/admin/ai-models.astro` | Page |
| `apps/web/src/components/admin/AiModels.tsx` (+ `.test.tsx`) | Table + row drawer Save |

**Modify**

| Path | Change |
|---|---|
| `packages/shared/src/validators/index.ts`, `packages/shared/src/constants/index.ts` | Barrel exports |
| `apps/api/src/db/schema/index.ts` | `export * from './aiPlatformModels'` |
| `apps/api/src/db/schema/llmProviderCatalog.ts` | Comment: keys are `ai_platform_models.model_id` |
| `apps/api/src/__tests__/integration/rls-coverage.integration.test.ts` | `INTENTIONAL_UNSCOPED` entry |
| `apps/api/src/services/aiModel.ts` | W00 rules moved here: `legacyWireProfile`, `legacyThinksWhenOmitted`; plus `derivePromptProfile` |
| `apps/api/src/services/aiModelThinking.ts`, `aiModelThinking.test.ts` | **Deleted** |
| `apps/api/src/services/streamingSessionManager.ts`, `aiAgents/runLoop.ts`, `llm/providerFidelityHarness.ts`, `llm/toolCapture/runSurface.ts` | `agentSdkWireOptions(...)` |
| `apps/api/src/services/scriptProposals/reviewer.ts`, `aiTicketDraft.ts`, `officeAddin/aiEmailDraft.ts`, `aiPatchTestRunner.ts` | `messagesApiWireOptions(...)` |
| `apps/api/src/services/aiAgents/runLoop.test.ts` | Test title only |
| `apps/api/src/services/aiCostTracker.ts` (+ `.test.ts`) | Token rate from the snapshot; `isPricedModel` from the snapshot |
| `apps/api/src/index.ts`, `apps/api/src/worker.ts` | `startPlatformModelSnapshotRefresher()` |
| `apps/api/src/routes/aiProvider.ts` (+ test) | `supportedModels` from `listOfferableModelIds()` |
| `apps/api/src/services/aiAgent.ts` (+ `aiAgent.sessionModel.test.ts`) | Session model check reads `isOfferablePlatformModel` |
| `apps/api/src/services/partnerLlmConfig.ts` (+ test) | Default-model check reads `isOfferablePlatformModel` |
| `apps/api/src/services/llmProviderCatalog.ts` (+ test) | `model_map` keys checked against `listCatalogMappableModelIds()` |
| `apps/api/src/jobs/scheduleRegistry.ts`, `services/workerRegistry.ts` (+ `.test.ts`), `services/workerEntrypointClosure.contract.test.ts`, `jobs/workerReadinessManifest.ts` | Worker registration |
| `apps/api/src/routes/admin/index.ts`, `apps/api/src/services/mcpCoverage.ts` | Mount + `platform_admin` exemption |
| `apps/api/src/routes/admin/llmProviderCatalog.ts` (+ test) | Persist the harness probe result |
| `apps/api/src/services/llm/providerFidelityHarness.ts` (+ test) | Adaptive + effort probe; `max_tokens` 2048 |
| `apps/web/src/components/admin/LlmProviderCatalog.tsx` (+ test) | Model list read from `/admin/ai-models` |
| `apps/web/src/components/layout/Sidebar.tsx` | Administration entry |
| `apps/web/src/locales/*/admin.json`, `common.json`, `pages.json` | Strings (8 locales) |
| `apps/web/src/lib/__tests__/no-silent-mutations.test.ts` | Add `AiModels.tsx`, bump the count |

---

## Task 1: Spike: SDK option passthrough, Models API capabilities, inference geo (findings doc)

This task produces evidence, not product code. Its findings doc is the reference that later decisions cite:
- Task 3 (`supportsTools` derivation, D4);
- Task 4 (the adapters throw for display `updates`, `speed` and `inferenceGeo` until D1/D2/D3 say otherwise);
- Task 7 (the seed leaves `inferenceGeo` empty, D3);
- Task 13 (the never-seen lifecycle guard, D5);
- waves W03 and W05.

Nothing later in **this** plan changes shape based on the outcome. The code in Tasks 3, 4, 7 and 13 is correct for either answer. The doc decides what W03/W05 build.

**Files:**
- Create: `apps/api/src/services/aiModels/__scripts__/sdkOptionPassthroughSpike.ts`
- Create: `apps/api/src/services/aiModels/__scripts__/modelsApiProbe.ts`
- Create: `docs/superpowers/specs/ai-mcp/2026-09-30-ai-model-registry-w01-spike-findings.md`

**Interfaces:**
- Consumes: nothing from this plan.
- Produces: a findings doc with rows `Q1`–`Q7` (answers) and `D1`–`D5` (gated decisions), referenced by id from Tasks 3, 4, 7 and 13 and from W03/W05 plans.

- [ ] **Step 1: Static inspection of the pinned Agent SDK**

Run:
```bash
cd apps/api
node -p "require('./node_modules/@anthropic-ai/claude-agent-sdk/package.json').version"
SDK=node_modules/@anthropic-ai/claude-agent-sdk
grep -n "display?:" "$SDK/sdk.d.ts"
grep -n "fastMode\|speed?:\|inference_geo\|inferenceGeo\|export declare type SdkBeta" "$SDK/sdk.d.ts"
grep -raoh "inference_geo\|thinking-display-updates-2026-08-18\|fast-mode-2026-02-01\|ANTHROPIC_BETAS\|ANTHROPIC_CUSTOM_HEADERS\|CLAUDE_CODE_EXTRA_BODY" -- "$SDK" "$(dirname "$SDK")" 2>/dev/null | sort | uniq -c
```

Expected:
- The version prints `0.3.286`. If it doesn't, stop: #7593 is not on this branch.
- Record every line printed, verbatim, for the findings doc's "Static evidence" section.

Pre-read on 0.3.282, labelled **inferred** until re-checked on 0.3.286:
- `ThinkingAdaptive.display` is typed `'summarized' | 'omitted'` only.
- `SdkBeta` is `'context-1m-2025-08-07'` only.
- Fast mode exists only as `Settings.fastMode?: boolean`.
- `sdk.d.ts` has no `inference_geo`.

- [ ] **Step 2: Write the passthrough spike (a local capture server, no Anthropic traffic, no key, no cost)**

```ts
#!/usr/bin/env tsx
// apps/api/src/services/aiModels/__scripts__/sdkOptionPassthroughSpike.ts (the shebang must stay on line 1)
/**
 * AI model registry W01 spike (#7599): which per-call options does the pinned
 * Agent SDK `query()` actually put on the wire?
 *
 * Runs `query()` once per variant against a local capture server that speaks
 * just enough of the Messages API to end the turn. No request reaches
 * Anthropic, no real key is used, nothing is billed. For every request the CLI
 * sends, it records the body's `thinking`, `output_config`, `speed` and
 * `inference_geo`, plus the `anthropic-beta` header. It never records
 * auth headers or prompt text.
 *
 * Re-run after every Agent SDK bump. The findings doc
 * (docs/superpowers/specs/ai-mcp/2026-09-30-ai-model-registry-w01-spike-findings.md)
 * cites its output.
 *
 *   cd apps/api && npx tsx src/services/aiModels/__scripts__/sdkOptionPassthroughSpike.ts \
 *     --model <adaptive model id> --fast-model <fast-capable model id> [--out file.json]
 *
 * Model ids are arguments, not literals: index invariant 1 keeps model ids
 * out of source outside the registry seed, fixtures and aiModel.ts.
 */
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { AddressInfo } from 'node:net';
import { query, type Options } from '@anthropic-ai/claude-agent-sdk';

interface ObservedRequest {
  variant: string;
  path: string;
  model: unknown;
  thinking: unknown;
  outputConfig: unknown;
  speed: unknown;
  inferenceGeo: unknown;
  betaHeader: string | null;
}

interface Variant {
  name: string;
  model: string;
  options: Partial<Options>;
  env?: Record<string, string>;
}

const observed: ObservedRequest[] = [];
let currentVariant = '';

function writeSse(res: ServerResponse, model: string): void {
  res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache' });
  const events: Array<[string, unknown]> = [
    ['message_start', {
      type: 'message_start',
      message: {
        id: 'msg_spike', type: 'message', role: 'assistant', model, content: [],
        stop_reason: null, stop_sequence: null, usage: { input_tokens: 1, output_tokens: 0 },
      },
    }],
    ['content_block_start', { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } }],
    ['content_block_delta', { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'OK' } }],
    ['content_block_stop', { type: 'content_block_stop', index: 0 }],
    ['message_delta', { type: 'message_delta', delta: { stop_reason: 'end_turn', stop_sequence: null }, usage: { output_tokens: 1 } }],
    ['message_stop', { type: 'message_stop' }],
  ];
  for (const [event, data] of events) res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
  res.end();
}

function handleRequest(req: IncomingMessage, res: ServerResponse): void {
  const chunks: Buffer[] = [];
  req.on('data', (chunk: Buffer) => chunks.push(chunk));
  req.on('end', () => {
    const path = req.url ?? '';
    if (req.method !== 'POST' || !path.startsWith('/v1/messages')) {
      res.writeHead(404, { 'content-type': 'application/json' });
      res.end('{"type":"error","error":{"type":"not_found_error","message":"spike capture server"}}');
      return;
    }
    let body: Record<string, unknown> = {};
    try {
      body = JSON.parse(Buffer.concat(chunks).toString('utf8')) as Record<string, unknown>;
    } catch {
      // A non-JSON body is recorded with every field undefined.
    }
    const beta = req.headers['anthropic-beta'];
    observed.push({
      variant: currentVariant,
      path,
      model: body.model,
      thinking: body.thinking,
      outputConfig: body.output_config,
      speed: body.speed,
      inferenceGeo: body.inference_geo,
      betaHeader: Array.isArray(beta) ? beta.join(',') : beta ?? null,
    });
    const model = typeof body.model === 'string' ? body.model : 'spike';
    if (path.startsWith('/v1/messages/count_tokens')) {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end('{"input_tokens":1}');
      return;
    }
    if (body.stream === true) {
      writeSse(res, model);
      return;
    }
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({
      id: 'msg_spike', type: 'message', role: 'assistant', model,
      content: [{ type: 'text', text: 'OK' }], stop_reason: 'end_turn', stop_sequence: null,
      usage: { input_tokens: 1, output_tokens: 1 },
    }));
  });
}

function buildVariants(model: string, fastModel: string): Variant[] {
  return [
    { name: 'control-adaptive-medium', model, options: { thinking: { type: 'adaptive' }, effort: 'medium' } },
    { name: 'display-summarized', model, options: { thinking: { type: 'adaptive', display: 'summarized' } } },
    {
      name: 'display-updates-cast',
      model,
      options: { thinking: { type: 'adaptive', display: 'updates' } as unknown as Options['thinking'] },
    },
    {
      name: 'display-updates-extra-arg',
      model,
      options: { thinking: { type: 'adaptive' }, extraArgs: { 'thinking-display': 'updates' } },
    },
    {
      name: 'fast-mode-settings',
      model: fastModel,
      options: { thinking: { type: 'adaptive' }, settings: { fastMode: true } as unknown as Options['settings'] },
    },
    {
      name: 'betas-env',
      model,
      options: { thinking: { type: 'adaptive' } },
      env: { ANTHROPIC_BETAS: 'thinking-display-updates-2026-08-18' },
    },
    {
      name: 'custom-headers-env',
      model: fastModel,
      options: { thinking: { type: 'adaptive' } },
      env: { ANTHROPIC_CUSTOM_HEADERS: 'anthropic-beta: fast-mode-2026-02-01' },
    },
    {
      name: 'extra-body-env-geo',
      model,
      options: { thinking: { type: 'adaptive' } },
      env: { CLAUDE_CODE_EXTRA_BODY: JSON.stringify({ inference_geo: 'us' }) },
    },
  ];
}

async function runVariant(baseUrl: string, configDir: string, variant: Variant): Promise<string | null> {
  currentVariant = variant.name;
  const abortController = new AbortController();
  const timer = setTimeout(() => abortController.abort(), 60_000);
  try {
    const session = query({
      prompt: 'Reply with OK.',
      options: {
        model: variant.model,
        maxTurns: 1,
        tools: [],
        settingSources: [],
        persistSession: false,
        abortController,
        env: {
          PATH: process.env.PATH ?? '',
          HOME: process.env.HOME ?? '',
          CLAUDE_CONFIG_DIR: configDir,
          DISABLE_TELEMETRY: '1',
          CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: '1',
          ANTHROPIC_BASE_URL: baseUrl,
          ANTHROPIC_API_KEY: 'spike-not-a-real-key',
          ...variant.env,
        },
        ...variant.options,
      },
    });
    for await (const _message of session) {
      // drain
    }
    return null;
  } catch (error) {
    return error instanceof Error ? error.message.slice(0, 300) : String(error).slice(0, 300);
  } finally {
    clearTimeout(timer);
  }
}

function argValue(flag: string): string | undefined {
  const index = process.argv.indexOf(flag);
  return index >= 0 ? process.argv[index + 1] : undefined;
}

async function main(): Promise<void> {
  const model = argValue('--model');
  const fastModel = argValue('--fast-model');
  if (!model || !fastModel) throw new Error('usage: --model <id> --fast-model <id> [--out file.json]');
  const server = createServer(handleRequest);
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', () => resolve()));
  const { port } = server.address() as AddressInfo;
  const configDir = await mkdtemp(join(tmpdir(), 'w01-sdk-spike-'));
  const errors: Record<string, string | null> = {};
  try {
    for (const variant of buildVariants(model, fastModel)) {
      errors[variant.name] = await runVariant(`http://127.0.0.1:${port}`, configDir, variant);
    }
  } finally {
    server.close();
    await rm(configDir, { recursive: true, force: true });
  }
  const sdkVersion = (await import('@anthropic-ai/claude-agent-sdk/package.json', { with: { type: 'json' } })
    .then((m) => (m as { default: { version: string } }).default.version)
    .catch(() => 'unknown'));
  const report = { at: new Date().toISOString(), sdkVersion, errors, requests: observed };
  console.table(observed.map((row) => ({
    variant: row.variant,
    path: row.path,
    thinking: JSON.stringify(row.thinking),
    output_config: JSON.stringify(row.outputConfig),
    speed: JSON.stringify(row.speed),
    inference_geo: JSON.stringify(row.inferenceGeo),
    beta: row.betaHeader,
  })));
  const out = argValue('--out');
  if (out) await writeFile(out, JSON.stringify(report, null, 2));
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
```

If the `package.json` JSON import is refused by the package `exports` map, replace that expression with the literal version printed in Step 1. The report only labels the run.

- [ ] **Step 3: Run the passthrough spike**

Run:
```bash
cd apps/api && npx tsx src/services/aiModels/__scripts__/sdkOptionPassthroughSpike.ts \
  --model claude-sonnet-5-5 --fast-model claude-opus-5-5 --out "$TMPDIR/w01-sdk-passthrough.json"
```

Expected:
- A table with at least one `/v1/messages` row per variant, and the control row showing `thinking: {"type":"adaptive"}` and `output_config: {"effort":"medium"}`.
- If the control row is missing or its thinking differs, the capture harness is wrong, not the SDK. Fix the harness (check `errors` in the JSON) before reading any other row.

- [ ] **Step 4: Write the Models API probe (needs a real key; `--probe-geo` / `--probe-fast` cost a few tokens)**

```ts
#!/usr/bin/env tsx
// apps/api/src/services/aiModels/__scripts__/modelsApiProbe.ts (the shebang must stay on line 1)
/**
 * AI model registry W01 spike (#7599): what the Anthropic Models API returns
 * for this key, and which per-call options the Messages API accepts.
 *
 *   ANTHROPIC_API_KEY=… npx tsx src/services/aiModels/__scripts__/modelsApiProbe.ts \
 *     [--probe-geo --geo-model <id>] [--probe-fast --fast-model <id>] [--out file.json]
 *
 * Costs:
 * - Listing models is free.
 * - `--probe-geo` sends three 16-token requests.
 * - `--probe-fast` sends one 16-token fast-mode request at premium rates.
 *
 * Output holds model metadata and API error text only. Never the key.
 */
import Anthropic from '@anthropic-ai/sdk';
import { writeFile } from 'node:fs/promises';

function supportedLeaves(value: unknown, prefix = ''): Array<{ path: string; supported: boolean }> {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return [];
  const record = value as Record<string, unknown>;
  const out: Array<{ path: string; supported: boolean }> = [];
  if (typeof record.supported === 'boolean') out.push({ path: prefix || '(root)', supported: record.supported });
  for (const [key, child] of Object.entries(record)) {
    if (key === 'supported') continue;
    out.push(...supportedLeaves(child, prefix ? `${prefix}.${key}` : key));
  }
  return out;
}

function argValue(flag: string): string | undefined {
  const index = process.argv.indexOf(flag);
  return index >= 0 ? process.argv[index + 1] : undefined;
}

function describeError(error: unknown): { status: number | null; message: string } {
  return {
    status: error instanceof Anthropic.APIError ? (error.status ?? null) : null,
    message: error instanceof Error ? error.message.slice(0, 300) : String(error).slice(0, 300),
  };
}

async function main(): Promise<void> {
  const apiKey = process.env.ANTHROPIC_API_KEY?.trim();
  if (!apiKey) throw new Error('ANTHROPIC_API_KEY is required');
  // Forced origin and no auth token: the probe answers questions about the
  // Anthropic API itself, never about a gateway named in ANTHROPIC_BASE_URL.
  const client = new Anthropic({ apiKey, authToken: null, baseURL: 'https://api.anthropic.com' });

  const models: Array<Record<string, unknown>> = [];
  for await (const model of client.models.list({ limit: 100 })) {
    models.push({
      id: model.id,
      displayName: model.display_name,
      maxInputTokens: model.max_input_tokens,
      maxOutputTokens: model.max_tokens,
      topLevelCapabilityKeys: Object.keys(model.capabilities ?? {}).sort(),
      leaves: supportedLeaves(model.capabilities),
    });
  }
  const report: Record<string, unknown> = { at: new Date().toISOString(), models };

  if (process.argv.includes('--probe-geo')) {
    const geoModel = argValue('--geo-model');
    if (!geoModel) throw new Error('--probe-geo needs --geo-model <id>');
    const geo: Array<Record<string, unknown>> = [];
    for (const value of ['us', 'global', 'eu']) {
      try {
        const response = await client.messages.create({
          model: geoModel,
          max_tokens: 16,
          inference_geo: value,
          messages: [{ role: 'user', content: 'Reply OK.' }],
        });
        geo.push({ geo: value, accepted: true, servedGeo: (response.usage as { inference_geo?: unknown }).inference_geo ?? null });
      } catch (error) {
        geo.push({ geo: value, accepted: false, ...describeError(error) });
      }
    }
    report.geo = geo;
  }

  if (process.argv.includes('--probe-fast')) {
    const fastModel = argValue('--fast-model');
    if (!fastModel) throw new Error('--probe-fast needs --fast-model <id>');
    try {
      const response = await client.beta.messages.create({
        model: fastModel,
        max_tokens: 16,
        speed: 'fast',
        betas: ['fast-mode-2026-02-01'],
        messages: [{ role: 'user', content: 'Reply OK.' }],
      });
      report.fast = { accepted: true, servedSpeed: (response.usage as { speed?: unknown }).speed ?? null };
    } catch (error) {
      report.fast = { accepted: false, ...describeError(error) };
    }
  }

  console.log(JSON.stringify(report, null, 2));
  const out = argValue('--out');
  if (out) await writeFile(out, JSON.stringify(report, null, 2));
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
```

If the 0.128 SDK types reject `inference_geo` on the non-beta `messages.create` or `speed` on `beta.messages.create`, check `node_modules/@anthropic-ai/sdk/resources/messages/messages.d.ts` and `.../beta/messages/messages.d.ts`. Both carried those fields on 0.128.0 when this plan was written. Adjust only the call shape, never by adding `as any`.

- [ ] **Step 5: Run the probe with a developer key**

Run:
```bash
cd apps/api && ANTHROPIC_API_KEY="$YOUR_DEV_KEY" npx tsx src/services/aiModels/__scripts__/modelsApiProbe.ts \
  --probe-geo --geo-model claude-sonnet-5-5 --probe-fast --fast-model claude-opus-5-5 \
  --out "$TMPDIR/w01-models-api.json"
```

Expected: JSON listing every model with its capability leaves, then a `geo` array and a `fast` object.

If no key is available, skip this step. Label Q4–Q7 **not checked** in the findings doc, and say so in the PR body. Do not guess the answers.

- [ ] **Step 6: Write the findings doc**

Write `docs/superpowers/specs/ai-mcp/2026-09-30-ai-model-registry-w01-spike-findings.md` with exactly this structure, filling every `Answer`, `Label`, `Evidence` and `Outcome` cell from Steps 1, 3 and 5.

Labels:
- **verified**: observed in this run's output.
- **inferred**: read from types or docs, not observed.
- **not checked**.

Paste the relevant JSON rows (not the full dump) under each answer. Never paste a key, a hostname of any Breeze deployment, or prompt text.

```markdown
# AI model registry W01: spike findings (#7599)

Run on <date> by <name>. `@anthropic-ai/claude-agent-sdk` <version>, `@anthropic-ai/sdk` <version>.
Scripts: `apps/api/src/services/aiModels/__scripts__/sdkOptionPassthroughSpike.ts`, `modelsApiProbe.ts`.
Labels: **verified** = observed in this run · **inferred** = from types/docs only · **not checked**.

## Static evidence (Step 1)
<verbatim grep output>

## Answers
| # | Question | Answer | Label | Evidence |
|---|---|---|---|---|
| Q1 | Does `query()` put `thinking.display: "updates"` on the wire: typed option, `extraArgs['thinking-display']`, or `ANTHROPIC_BETAS`? Which beta header accompanies it? | | | rows `display-updates-cast`, `display-updates-extra-arg`, `betas-env` |
| Q2 | Does `query()` send `speed: "fast"` and the `fast-mode-2026-02-01` beta (`settings.fastMode`, `ANTHROPIC_CUSTOM_HEADERS`)? | | | rows `fast-mode-settings`, `custom-headers-env` |
| Q3 | Can `query()` send `inference_geo` by any option or env var? | | | row `extra-body-env-geo` + static grep |
| Q4 | Top-level `capabilities` keys for current models. Is there any leaf for fast mode / speed, inference geo, tool use, or disabling thinking? | | | `topLevelCapabilityKeys`, `leaves` |
| Q5 | Does `models.list()` return dated ids, aliases, or both for older models? Which of the 10 seeded ids (Task 7) are absent from the listing? | | | `models[].id` |
| Q6 | Which `inference_geo` values does the Messages API accept for this org: `us` / `global` / `eu`? What does `usage.inference_geo` report? | | | `geo` |
| Q7 | Is fast mode accepted for this org (research-preview access)? | | | `fast` |

## Decisions this gates
| # | Decision (owner wave) | If yes | If no | Outcome |
|---|---|---|---|---|
| D1 | Chat's default `thinkingDisplay` (spec §7) (W05) | W05 extends `toAgentSdkOptions` to map `display: "updates"` by the Q1 mechanism; the chat assignment defaults `options.thinkingDisplay = "updates"` where supported | Chat shows a "thinking…" indicator; `updates` stays in `option_support` (a model fact) but `toAgentSdkOptions` keeps refusing it | |
| D2 | Fast mode on Agent SDK surfaces (chat, agents) (W03/W05) | `toAgentSdkOptions` maps `speed: "fast"` by the Q2 mechanism | Fast mode is reachable only from Messages-API one-shots until the SDK carries it; the chat picker hides it | |
| D3 | `inference_geo` values in `option_support` and the EU platform geo (§15 #5) (W03) | The operator enters the values Q6 confirmed on `/admin/ai-models`; W03 sends them where supported | `option_support.inferenceGeo` stays `[]`; EU residency stays open in W03 planning | |
| D4 | `supportsTools` derivation (W01 Task 3) | An explicit tools leaf exists and `deriveCapabilities` reads it (already coded) | No leaf: Anthropic trees default to `supportsTools: true` (already coded) | |
| D5 | Lifecycle never-seen guard (W01 Task 13) | Aliases are listed: the guard is defensive only | Aliases absent: the guard is load-bearing for the seeded alias rows | |
```

- [ ] **Step 7: Commit**

```bash
git add apps/api/src/services/aiModels/__scripts__/sdkOptionPassthroughSpike.ts \
  apps/api/src/services/aiModels/__scripts__/modelsApiProbe.ts \
  docs/superpowers/specs/ai-mcp/2026-09-30-ai-model-registry-w01-spike-findings.md
git commit -m "docs(ai): W01 spike: Agent SDK option passthrough, Models API capabilities, inference geo (#7599)

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

## Task 2: Shared option schemas and surface constants (`@breeze/shared`)

**Files:**
- Create: `packages/shared/src/validators/aiModelOptions.ts`
- Create: `packages/shared/src/validators/aiModelOptions.test.ts`
- Create: `packages/shared/src/constants/aiSurfaces.ts`
- Create: `packages/shared/src/constants/aiSurfaces.test.ts`
- Modify: `packages/shared/src/validators/index.ts` (append at end)
- Modify: `packages/shared/src/constants/index.ts` (append at end)

**Interfaces:**
- Consumes: `zod` only (leaf modules; the root barrel ships to the browser).
- Produces (index names in **bold**; the rest are index additions):
  ```ts
  export const **EFFORT_LEVELS**: readonly ['low','medium','high','xhigh','max']; export type **EffortLevel**;
  export const THINKING_DISPLAYS: readonly ['omitted','summarized','updates']; export type ThinkingDisplay;
  export const MODEL_SPEEDS: readonly ['standard','fast']; export type ModelSpeed;
  export const PROMPT_PROFILES: readonly ['claude-frontier','claude-standard','claude-small','generic']; export type PromptProfile;
  export const MODEL_LIFECYCLES: readonly ['available','missing','retired']; export type ModelLifecycle;
  export const INFERENCE_GEO_PATTERN: RegExp;
  export const modelRatesSchema; export type **ModelRates** = { inputCentsPerM; outputCentsPerM; cacheReadCentsPerM; cacheWriteCentsPerM };
  export const **offeringOptionsSchema**; export type **OfferingOptions** = { effort?; thinkingDisplay?; speed? };
  export const **optionSupportSchema**; export type **OptionSupport** = { effort: EffortLevel[]; thinkingDisplay: ThinkingDisplay[]; speed: ModelSpeed[]; inferenceGeo: string[] };
  export const OPTION_RATE_KEYS: readonly ['speed:fast']; export type OptionRateKey;
  export const **optionRatesSchema**; export type **OptionRates** = { 'speed:fast'?: ModelRates };
  export function emptyOptionSupport(): OptionSupport;
  export const **AI_SURFACES**; export type **AiSurface**; export const **AI_SURFACE_ROLES**: Readonly<Record<AiSurface, readonly string[]>>;
  export const **TOOL_REQUIRING_SURFACES**: readonly ['chat','helper','script_builder','ai_agents','office_chat'];
  ```

- [ ] **Step 1: Write the failing tests**

```ts
// packages/shared/src/validators/aiModelOptions.test.ts
import { describe, expect, it } from 'vitest';
import {
  EFFORT_LEVELS,
  MODEL_LIFECYCLES,
  MODEL_SPEEDS,
  OPTION_RATE_KEYS,
  PROMPT_PROFILES,
  THINKING_DISPLAYS,
  emptyOptionSupport,
  modelRatesSchema,
  offeringOptionsSchema,
  optionRatesSchema,
  optionSupportSchema,
} from '../index';

const RATES = { inputCentsPerM: 200, outputCentsPerM: 1000, cacheReadCentsPerM: 20, cacheWriteCentsPerM: 250 };

describe('aiModelOptions literal sets', () => {
  it('pins the index contract literals', () => {
    expect(EFFORT_LEVELS).toEqual(['low', 'medium', 'high', 'xhigh', 'max']);
    expect(THINKING_DISPLAYS).toEqual(['omitted', 'summarized', 'updates']);
    expect(MODEL_SPEEDS).toEqual(['standard', 'fast']);
    expect(PROMPT_PROFILES).toEqual(['claude-frontier', 'claude-standard', 'claude-small', 'generic']);
    expect(MODEL_LIFECYCLES).toEqual(['available', 'missing', 'retired']);
    expect(OPTION_RATE_KEYS).toEqual(['speed:fast']);
  });
});

describe('offeringOptionsSchema', () => {
  it('accepts the empty object and every single knob', () => {
    expect(offeringOptionsSchema.parse({})).toEqual({});
    expect(offeringOptionsSchema.parse({ effort: 'xhigh', thinkingDisplay: 'updates', speed: 'fast' }))
      .toEqual({ effort: 'xhigh', thinkingDisplay: 'updates', speed: 'fast' });
  });
  it('rejects unknown keys and unknown values', () => {
    expect(offeringOptionsSchema.safeParse({ effort: 'extreme' }).success).toBe(false);
    expect(offeringOptionsSchema.safeParse({ budgetTokens: 2048 }).success).toBe(false);
  });
});

describe('optionSupportSchema', () => {
  it('accepts the empty default', () => {
    expect(optionSupportSchema.parse(emptyOptionSupport())).toEqual({
      effort: [], thinkingDisplay: [], speed: ['standard'], inferenceGeo: [],
    });
  });
  it('requires standard speed, unique values and lowercase geo tokens', () => {
    expect(optionSupportSchema.safeParse({ effort: [], thinkingDisplay: [], speed: ['fast'], inferenceGeo: [] }).success).toBe(false);
    expect(optionSupportSchema.safeParse({ effort: ['low', 'low'], thinkingDisplay: [], speed: ['standard'], inferenceGeo: [] }).success).toBe(false);
    expect(optionSupportSchema.safeParse({ effort: [], thinkingDisplay: [], speed: ['standard'], inferenceGeo: ['EU West'] }).success).toBe(false);
    expect(optionSupportSchema.safeParse({ effort: [], thinkingDisplay: [], speed: ['standard'], inferenceGeo: ['us', 'global'] }).success).toBe(true);
  });
  it('emptyOptionSupport returns a fresh object each call', () => {
    const a = emptyOptionSupport();
    a.effort.push('low');
    expect(emptyOptionSupport().effort).toEqual([]);
  });
});

describe('modelRatesSchema / optionRatesSchema', () => {
  it('accepts non-negative finite rates, including fractional cents and 0', () => {
    expect(modelRatesSchema.parse({ ...RATES, cacheReadCentsPerM: 2.5 })).toEqual({ ...RATES, cacheReadCentsPerM: 2.5 });
    expect(modelRatesSchema.parse({ inputCentsPerM: 0, outputCentsPerM: 0, cacheReadCentsPerM: 0, cacheWriteCentsPerM: 0 })).toBeTruthy();
  });
  it('rejects a missing component, a negative rate, and an unknown option key', () => {
    expect(modelRatesSchema.safeParse({ inputCentsPerM: 1, outputCentsPerM: 1, cacheReadCentsPerM: 1 }).success).toBe(false);
    expect(modelRatesSchema.safeParse({ ...RATES, inputCentsPerM: -1 }).success).toBe(false);
    expect(optionRatesSchema.safeParse({ 'speed:turbo': RATES }).success).toBe(false);
    expect(optionRatesSchema.parse({ 'speed:fast': RATES })).toEqual({ 'speed:fast': RATES });
  });
});
```

```ts
// packages/shared/src/constants/aiSurfaces.test.ts
import { describe, expect, it } from 'vitest';
import { AI_SURFACES, AI_SURFACE_ROLES, TOOL_REQUIRING_SURFACES } from '../index';

describe('AI surfaces (index contract)', () => {
  it('pins the surface list', () => {
    expect(AI_SURFACES).toEqual([
      'chat', 'helper', 'script_builder', 'script_reviewer', 'office_chat',
      'office_ticket', 'ai_agents', 'catalog_enrichment', 'extension_content', 'patch_test',
    ]);
  });
  it('gives every surface a default role, and ai_agents the escalation roles', () => {
    for (const surface of AI_SURFACES) expect(AI_SURFACE_ROLES[surface]).toContain('default');
    expect(AI_SURFACE_ROLES.ai_agents).toEqual(['default', 'triage', 'analysis', 'remediation']);
    expect(Object.keys(AI_SURFACE_ROLES).sort()).toEqual([...AI_SURFACES].sort());
  });
  it('tool-requiring surfaces are a subset of the surfaces', () => {
    expect(TOOL_REQUIRING_SURFACES).toEqual(['chat', 'helper', 'script_builder', 'ai_agents', 'office_chat']);
    for (const surface of TOOL_REQUIRING_SURFACES) expect(AI_SURFACES).toContain(surface);
  });
});
```

- [ ] **Step 2: Run them and watch them fail**

Run: `cd packages/shared && npx vitest run src/validators/aiModelOptions.test.ts src/constants/aiSurfaces.test.ts`

Expected: FAIL. The imports resolve to `undefined` (for example, `EFFORT_LEVELS` is not exported from `../index`), so `toEqual` receives `undefined`.

- [ ] **Step 3: Implement**

```ts
// packages/shared/src/validators/aiModelOptions.ts
/**
 * AI model registry (#7598) option contract. Shared by the API (registry,
 * wire-param derivation, pricing) and the web (/admin/ai-models). Leaf module:
 * zod only, because the package root barrel is bundled into the browser.
 *
 * MODEL_LIFECYCLES and PROMPT_PROFILES are mirrored 1:1 by CHECK constraints in
 * apps/api/migrations/2026-11-13-100000-ai-platform-models.sql. Edit both sides
 * together; aiPlatformModels.contract.test.ts fails otherwise.
 */
import { z } from 'zod';

export const EFFORT_LEVELS = ['low', 'medium', 'high', 'xhigh', 'max'] as const;
export type EffortLevel = (typeof EFFORT_LEVELS)[number];

export const THINKING_DISPLAYS = ['omitted', 'summarized', 'updates'] as const;
export type ThinkingDisplay = (typeof THINKING_DISPLAYS)[number];

export const MODEL_SPEEDS = ['standard', 'fast'] as const;
export type ModelSpeed = (typeof MODEL_SPEEDS)[number];

/** Prompt-variant family (spec §7). Profile names, not model ids. */
export const PROMPT_PROFILES = ['claude-frontier', 'claude-standard', 'claude-small', 'generic'] as const;
export type PromptProfile = (typeof PROMPT_PROFILES)[number];

export const MODEL_LIFECYCLES = ['available', 'missing', 'retired'] as const;
export type ModelLifecycle = (typeof MODEL_LIFECYCLES)[number];

/** Anthropic `inference_geo` tokens are short lowercase identifiers ("us", "global"). */
export const INFERENCE_GEO_PATTERN = /^[a-z][a-z0-9_-]{0,31}$/;

function uniqueArray<T extends z.ZodTypeAny>(item: T) {
  return z.array(item).refine((values) => new Set(values).size === values.length, {
    message: 'values must be unique',
  });
}

const centsPerMillion = z.number().finite().min(0).max(1_000_000);

/** Cents per million tokens. All four are required: there is no "partly priced" model. */
export const modelRatesSchema = z.object({
  inputCentsPerM: centsPerMillion,
  outputCentsPerM: centsPerMillion,
  cacheReadCentsPerM: centsPerMillion,
  cacheWriteCentsPerM: centsPerMillion,
}).strict();
export type ModelRates = z.infer<typeof modelRatesSchema>;

/** Per-call knobs (spec §4). Every key is optional: absent = inherit / provider default. */
export const offeringOptionsSchema = z.object({
  effort: z.enum(EFFORT_LEVELS).optional(),
  thinkingDisplay: z.enum(THINKING_DISPLAYS).optional(),
  speed: z.enum(MODEL_SPEEDS).optional(),
}).strict();
export type OfferingOptions = z.infer<typeof offeringOptionsSchema>;

/** What a model accepts for each knob, plus the inference geographies it can serve. */
export const optionSupportSchema = z.object({
  effort: uniqueArray(z.enum(EFFORT_LEVELS)),
  thinkingDisplay: uniqueArray(z.enum(THINKING_DISPLAYS)),
  speed: uniqueArray(z.enum(MODEL_SPEEDS)).refine((speeds) => speeds.includes('standard'), {
    message: "speed must include 'standard'",
  }),
  inferenceGeo: uniqueArray(z.string().regex(INFERENCE_GEO_PATTERN)).refine((geos) => geos.length <= 16, {
    message: 'at most 16 inference geographies',
  }),
}).strict();
export type OptionSupport = z.infer<typeof optionSupportSchema>;

/** Rate keys for non-standard option variants. A variant without a rate is not selectable (spec §8). */
export const OPTION_RATE_KEYS = ['speed:fast'] as const;
export type OptionRateKey = (typeof OPTION_RATE_KEYS)[number];

export const optionRatesSchema = z.object({
  'speed:fast': modelRatesSchema.optional(),
}).strict();
export type OptionRates = z.infer<typeof optionRatesSchema>;

export function emptyOptionSupport(): OptionSupport {
  return { effort: [], thinkingDisplay: [], speed: ['standard'], inferenceGeo: [] };
}
```

```ts
// packages/shared/src/constants/aiSurfaces.ts
/**
 * AI model registry (#7598): the features that call a model (spec §4). The
 * W02 `ai_model_assignments.surface` / `role` CHECKs mirror these. Leaf module.
 */
export const AI_SURFACES = [
  'chat',
  'helper',
  'script_builder',
  'script_reviewer',
  'office_chat',
  'office_ticket',
  'ai_agents',
  'catalog_enrichment',
  'extension_content',
  'patch_test',
] as const;
export type AiSurface = (typeof AI_SURFACES)[number];

/** Every surface resolves `default`. `ai_agents` also has the W09 escalation stages. */
export const AI_SURFACE_ROLES: Readonly<Record<AiSurface, readonly string[]>> = Object.freeze({
  chat: ['default'],
  helper: ['default'],
  script_builder: ['default'],
  script_reviewer: ['default'],
  office_chat: ['default'],
  office_ticket: ['default'],
  ai_agents: ['default', 'triage', 'analysis', 'remediation'],
  catalog_enrichment: ['default'],
  extension_content: ['default'],
  patch_test: ['default'],
});

/** An offering without verified tool support can't be assigned or permitted here (spec §7). */
export const TOOL_REQUIRING_SURFACES = [
  'chat',
  'helper',
  'script_builder',
  'ai_agents',
  'office_chat',
] as const satisfies readonly AiSurface[];
```

Append to `packages/shared/src/validators/index.ts`:
```ts

// AI model registry W01 (#7599): option / support / rate schemas.
export * from './aiModelOptions';
```

Append to `packages/shared/src/constants/index.ts`:
```ts

// AI model registry W01 (#7599): AI surfaces and roles. Leaf module.
export * from './aiSurfaces';
```

- [ ] **Step 4: Run them and watch them pass, then confirm the browser barrel stays clean**

Run: `cd packages/shared && npx vitest run src/validators/aiModelOptions.test.ts src/constants/aiSurfaces.test.ts src/browserSafeBarrel.test.ts`

Expected: PASS (all three files).

- [ ] **Step 5: Commit**

```bash
git add packages/shared/src/validators/aiModelOptions.ts packages/shared/src/validators/aiModelOptions.test.ts \
  packages/shared/src/constants/aiSurfaces.ts packages/shared/src/constants/aiSurfaces.test.ts \
  packages/shared/src/validators/index.ts packages/shared/src/constants/index.ts
git commit -m "feat(shared): AI model option, support and rate schemas plus surface constants (#7599)

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

## Task 3: `deriveCapabilities` and option-support derivation (pure)

**Files:**
- Create: `apps/api/src/services/aiModels/capabilities.ts`
- Create: `apps/api/src/services/aiModels/capabilities.test.ts`

**Interfaces:**
- Consumes: `EFFORT_LEVELS`, `THINKING_DISPLAYS`, `MODEL_SPEEDS`, `EffortLevel`, `OptionSupport` (Task 2).
- Produces:
  ```ts
  export type ThinkingMode = 'adaptive' | 'budget' | 'none' | 'unknown';               // index
  export interface DerivedCapabilities { thinkingMode: ThinkingMode; effortLevels: EffortLevel[]; supportsTools: boolean; supportsVision: boolean } // index
  export function deriveCapabilities(raw: unknown): DerivedCapabilities;               // index
  export function deriveOptionSupport(derived: DerivedCapabilities): OptionSupport;    // addition
  export function mergeDiscoveredOptionSupport(existing: OptionSupport, derived: DerivedCapabilities): OptionSupport; // addition
  export function optionSupportErrors(derived: DerivedCapabilities, support: OptionSupport): string[];             // addition
  ```

- [ ] **Step 1: Write the failing test**

```ts
// apps/api/src/services/aiModels/capabilities.test.ts
import { describe, expect, it } from 'vitest';
import type { OptionSupport } from '@breeze/shared';
import {
  deriveCapabilities,
  deriveOptionSupport,
  mergeDiscoveredOptionSupport,
  optionSupportErrors,
} from './capabilities';

const yes = { supported: true };
const no = { supported: false };
const effortTree = (levels: Record<string, boolean>) => ({
  supported: Object.values(levels).some(Boolean),
  low: { supported: !!levels.low },
  medium: { supported: !!levels.medium },
  high: { supported: !!levels.high },
  xhigh: { supported: !!levels.xhigh },
  max: { supported: !!levels.max },
});
const ADAPTIVE_FULL = {
  thinking: { supported: true, types: { adaptive: yes, enabled: no } },
  effort: effortTree({ low: true, medium: true, high: true, xhigh: true, max: true }),
  image_input: yes,
};
const ADAPTIVE_NO_XHIGH = {
  thinking: { supported: true, types: { adaptive: yes, enabled: yes } },
  effort: effortTree({ low: true, medium: true, high: true, xhigh: false, max: true }),
  image_input: yes,
};
const BUDGET_ONLY = {
  thinking: { supported: true, types: { adaptive: no, enabled: yes } },
  effort: effortTree({}),
  image_input: yes,
};
const NO_THINKING = {
  thinking: { supported: false, types: { adaptive: no, enabled: no } },
  effort: effortTree({}),
  image_input: no,
};

describe('deriveCapabilities', () => {
  it.each([
    ['adaptive, every effort level', ADAPTIVE_FULL, 'adaptive', ['low', 'medium', 'high', 'xhigh', 'max'], true],
    ['adaptive wins over enabled (Sonnet 4.6 shape), no xhigh', ADAPTIVE_NO_XHIGH, 'adaptive', ['low', 'medium', 'high', 'max'], true],
    ['enabled only (Haiku 4.5 shape)', BUDGET_ONLY, 'budget', [], true],
    ['neither', NO_THINKING, 'none', [], false],
  ] as const)('%s', (_label, raw, mode, effort, vision) => {
    expect(deriveCapabilities(raw)).toEqual({
      thinkingMode: mode,
      effortLevels: effort,
      supportsTools: true,
      supportsVision: vision,
    });
  });

  it.each([
    ['null', null],
    ['a string', 'adaptive'],
    ['an array', []],
    ['a tree without thinking', { effort: effortTree({ low: true }) }],
    ['thinking supported but no types', { thinking: { supported: true } }],
  ])('%s → unknown with no tools, no effort and no vision', (_label, raw) => {
    expect(deriveCapabilities(raw)).toEqual({
      thinkingMode: 'unknown',
      effortLevels: [],
      supportsTools: false,
      supportsVision: false,
    });
  });

  it('thinking.supported=false with no types → none', () => {
    expect(deriveCapabilities({ thinking: { supported: false } }).thinkingMode).toBe('none');
  });

  // Spike D4: an explicit tools leaf, should the Models API ever add one, wins.
  it('an explicit tool_use leaf overrides the default', () => {
    expect(deriveCapabilities({ ...ADAPTIVE_FULL, tool_use: no }).supportsTools).toBe(false);
  });

  it('only reports effort levels whose leaf is supported:true, and none when effort.supported is false', () => {
    expect(deriveCapabilities({ ...ADAPTIVE_FULL, effort: { ...effortTree({ low: true }), supported: false } }).effortLevels).toEqual([]);
    expect(deriveCapabilities({ ...ADAPTIVE_FULL, effort: { supported: true, low: yes, medium: 'yes' } }).effortLevels).toEqual(['low']);
  });

  it('returns a fresh object per call', () => {
    const a = deriveCapabilities(ADAPTIVE_FULL);
    a.effortLevels.push('low');
    expect(deriveCapabilities(ADAPTIVE_FULL).effortLevels).toEqual(['low', 'medium', 'high', 'xhigh', 'max']);
  });
});

describe('deriveOptionSupport', () => {
  it('adaptive → effort levels + omitted/summarized; budget → display only; none/unknown → nothing', () => {
    expect(deriveOptionSupport(deriveCapabilities(ADAPTIVE_NO_XHIGH))).toEqual({
      effort: ['low', 'medium', 'high', 'max'], thinkingDisplay: ['omitted', 'summarized'], speed: ['standard'], inferenceGeo: [],
    });
    expect(deriveOptionSupport(deriveCapabilities(BUDGET_ONLY))).toEqual({
      effort: [], thinkingDisplay: ['omitted', 'summarized'], speed: ['standard'], inferenceGeo: [],
    });
    expect(deriveOptionSupport(deriveCapabilities(NO_THINKING))).toEqual({
      effort: [], thinkingDisplay: [], speed: ['standard'], inferenceGeo: [],
    });
    expect(deriveOptionSupport(deriveCapabilities(null))).toEqual({
      effort: [], thinkingDisplay: [], speed: ['standard'], inferenceGeo: [],
    });
  });
});

describe('mergeDiscoveredOptionSupport', () => {
  const operatorSet: OptionSupport = {
    effort: ['medium'],
    thinkingDisplay: ['omitted', 'summarized', 'updates'],
    speed: ['standard', 'fast'],
    inferenceGeo: ['us'],
  };

  it('takes effort from the API and keeps operator-set updates, fast and geo on an adaptive model', () => {
    expect(mergeDiscoveredOptionSupport(operatorSet, deriveCapabilities(ADAPTIVE_FULL))).toEqual({
      effort: ['low', 'medium', 'high', 'xhigh', 'max'],
      thinkingDisplay: ['omitted', 'summarized', 'updates'],
      speed: ['standard', 'fast'],
      inferenceGeo: ['us'],
    });
  });

  it('drops updates when the model is no longer adaptive', () => {
    expect(mergeDiscoveredOptionSupport(operatorSet, deriveCapabilities(BUDGET_ONLY)).thinkingDisplay)
      .toEqual(['omitted', 'summarized']);
  });
});

describe('optionSupportErrors', () => {
  const support = (over: Partial<OptionSupport>): OptionSupport => ({
    effort: [], thinkingDisplay: [], speed: ['standard'], inferenceGeo: [], ...over,
  });

  it('accepts a subset of the derived support', () => {
    expect(optionSupportErrors(deriveCapabilities(ADAPTIVE_NO_XHIGH), support({ effort: ['low', 'max'], thinkingDisplay: ['updates'] }))).toEqual([]);
  });

  it.each([
    ['an effort level the model lacks', ADAPTIVE_NO_XHIGH, { effort: ['xhigh'] }, 'Effort "xhigh" is not supported by this model.'],
    ['effort on a budget model', BUDGET_ONLY, { effort: ['low'] }, 'Effort applies only to models with adaptive thinking.'],
    ['updates on a budget model', BUDGET_ONLY, { thinkingDisplay: ['updates'] }, 'Thinking display "updates" needs adaptive thinking.'],
    ['display on a model that does not think', NO_THINKING, { thinkingDisplay: ['omitted'] }, 'Thinking display applies only to models that think.'],
  ] as const)('rejects %s', (_label, raw, over, message) => {
    expect(optionSupportErrors(deriveCapabilities(raw), support(over as Partial<OptionSupport>))).toEqual([message]);
  });
});
```

- [ ] **Step 2: Run it and watch it fail**

Run: `cd apps/api && npx vitest run src/services/aiModels/capabilities.test.ts`

Expected: FAIL with `Failed to resolve import "./capabilities"`.

- [ ] **Step 3: Implement**

```ts
// apps/api/src/services/aiModels/capabilities.ts
/**
 * AI model registry (spec §7): turn the raw Anthropic Models API
 * `capabilities` tree into the facts the wire layer needs. Pure; no I/O.
 *
 * Leaves used: `thinking.types.{adaptive,enabled}.supported`,
 * `effort.{low..max}.supported`, `image_input.supported`. A leaf counts
 * only when it is literally `{ supported: true }`. Anything not
 * recognisably a Models API tree derives to `unknown`. The wire layer then
 * sends nothing, and the W01 bootstrap applies the W00 rules instead
 * (modelWireOptions.ts).
 */
import {
  EFFORT_LEVELS,
  MODEL_SPEEDS,
  THINKING_DISPLAYS,
  type EffortLevel,
  type OptionSupport,
  type ThinkingDisplay,
} from '@breeze/shared';

export type ThinkingMode = 'adaptive' | 'budget' | 'none' | 'unknown';

export interface DerivedCapabilities {
  thinkingMode: ThinkingMode;
  effortLevels: EffortLevel[];
  supportsTools: boolean;
  supportsVision: boolean;
}

type JsonRecord = Record<string, unknown>;

function isRecord(value: unknown): value is JsonRecord {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function supported(value: unknown): boolean {
  return isRecord(value) && value.supported === true;
}

function explicitlyUnsupported(value: unknown): boolean {
  return isRecord(value) && value.supported === false;
}

function unknownCapabilities(): DerivedCapabilities {
  return { thinkingMode: 'unknown', effortLevels: [], supportsTools: false, supportsVision: false };
}

export function deriveCapabilities(raw: unknown): DerivedCapabilities {
  if (!isRecord(raw) || !isRecord(raw.thinking)) return unknownCapabilities();
  const thinking = raw.thinking;
  const types = isRecord(thinking.types) ? thinking.types : null;

  let thinkingMode: ThinkingMode;
  if (types && supported(types.adaptive)) {
    thinkingMode = 'adaptive';
  } else if (types && supported(types.enabled)) {
    thinkingMode = 'budget';
  } else if (
    thinking.supported === false
    || (types && explicitlyUnsupported(types.adaptive) && explicitlyUnsupported(types.enabled))
  ) {
    thinkingMode = 'none';
  } else {
    thinkingMode = 'unknown';
  }

  const effort = isRecord(raw.effort) ? raw.effort : null;
  const effortLevels = effort && effort.supported === true
    ? EFFORT_LEVELS.filter((level) => supported(effort[level]))
    : [];

  // Spike D4: the Models API (`ModelCapabilities` in @anthropic-ai/sdk 0.128)
  // has no tool-use leaf, and every Claude model it lists supports tool use.
  // An explicit leaf, should one appear, wins.
  const toolsLeaf = raw.tool_use ?? raw.tools;
  const supportsTools = isRecord(toolsLeaf) && typeof toolsLeaf.supported === 'boolean'
    ? toolsLeaf.supported
    : true;

  return { thinkingMode, effortLevels: [...effortLevels], supportsTools, supportsVision: supported(raw.image_input) };
}

/** Support derivable from the API alone. `speed: fast`, `updates` and geos are operator-set (spec §5.1). */
export function deriveOptionSupport(derived: DerivedCapabilities): OptionSupport {
  const thinks = derived.thinkingMode === 'adaptive' || derived.thinkingMode === 'budget';
  return {
    effort: derived.thinkingMode === 'adaptive' ? [...derived.effortLevels] : [],
    thinkingDisplay: thinks ? ['omitted', 'summarized'] : [],
    speed: ['standard'],
    inferenceGeo: [],
  };
}

function ordered<T extends string>(order: readonly T[], values: Iterable<T>): T[] {
  const set = new Set(values);
  return order.filter((value) => set.has(value));
}

/**
 * Discovery refresh: the API owns effort and the base thinking displays; the
 * operator owns `updates`, `fast` and inference geos, which are kept only while
 * the model can still use them.
 */
export function mergeDiscoveredOptionSupport(existing: OptionSupport, derived: DerivedCapabilities): OptionSupport {
  const base = deriveOptionSupport(derived);
  const displays: ThinkingDisplay[] = [...base.thinkingDisplay];
  if (derived.thinkingMode === 'adaptive' && existing.thinkingDisplay.includes('updates')) displays.push('updates');
  return {
    effort: base.effort,
    thinkingDisplay: ordered(THINKING_DISPLAYS, displays),
    speed: ordered(MODEL_SPEEDS, ['standard', ...existing.speed]),
    inferenceGeo: [...existing.inferenceGeo],
  };
}

/** Operator-entered support must stay inside what the model can do. Empty array = valid. */
export function optionSupportErrors(derived: DerivedCapabilities, support: OptionSupport): string[] {
  const errors: string[] = [];
  if (derived.thinkingMode !== 'adaptive') {
    if (support.effort.length > 0) errors.push('Effort applies only to models with adaptive thinking.');
  } else {
    for (const level of support.effort) {
      if (!derived.effortLevels.includes(level)) errors.push(`Effort "${level}" is not supported by this model.`);
    }
  }
  if (derived.thinkingMode === 'none' || derived.thinkingMode === 'unknown') {
    if (support.thinkingDisplay.length > 0) errors.push('Thinking display applies only to models that think.');
  } else if (derived.thinkingMode !== 'adaptive' && support.thinkingDisplay.includes('updates')) {
    errors.push('Thinking display "updates" needs adaptive thinking.');
  }
  return errors;
}
```

- [ ] **Step 4: Run it and watch it pass**

Run: `cd apps/api && npx vitest run src/services/aiModels/capabilities.test.ts`

Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add apps/api/src/services/aiModels/capabilities.ts apps/api/src/services/aiModels/capabilities.test.ts
git commit -m "feat(ai): derive thinking mode and option support from Models API capabilities (#7599)

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

## Task 4: `buildWireParams` and the transport adapters (pure)

`buildWireParams` is the single place a thinking/effort/speed param is built (index invariant 2). It says what the Claude API should receive. Two small adapters spell that for each transport:

- **`toAgentSdkOptions`** (Agent SDK `query()`). "Send nothing" becomes an explicit `{ type: 'disabled' }`. With no `thinking` option, the SDK CLI turns extended thinking **on** for Haiku 4.5. W00 live-checked this: ~11× output tokens. Every id W00 sent `disabled` to, therefore, still gets `disabled`.
- **`toMessagesApiParams`** (raw `messages.create` one-shots). It keeps W00's "only ever reduce thinking" rule: params are sent only for models that already think when the param is omitted.

Both adapters refuse `display: 'updates'`, `speed` and `inferenceGeo` with `UnsupportedWireOptionError`. The spike decides how those travel (findings D1–D3), and no W01 caller requests them. The refusal is loud so W03/W05 can't silently bill a fast-mode rate for a standard request.

**Files:**
- Create: `apps/api/src/services/aiModels/wireParams.ts`
- Create: `apps/api/src/services/aiModels/wireParams.test.ts`

**Interfaces:**
- Consumes: `ThinkingMode` (Task 3); `EffortLevel`, `OfferingOptions`, `OptionSupport`, `ThinkingDisplay` (Task 2); `Options` type from `@anthropic-ai/claude-agent-sdk`.
- Produces:
  ```ts
  export const THINKING_DISPLAY_UPDATES_BETA = 'thinking-display-updates-2026-08-18';
  export const FAST_MODE_BETA = 'fast-mode-2026-02-01';
  export type WireThinking = { type: 'adaptive'; display?: ThinkingDisplay } | { type: 'enabled'; budget_tokens: number } | { type: 'disabled' };
  export interface WireParams { thinking?: WireThinking; effort?: EffortLevel; speed?: 'fast'; inferenceGeo?: string; betas: string[]; applied: OfferingOptions } // index
  export interface BuildWireParamsInput { thinkingMode: ThinkingMode; optionSupport: OptionSupport; requested: OfferingOptions; inferenceGeo?: string | null; maxTokens: number } // index
  export function buildWireParams(input: BuildWireParamsInput): WireParams; // index
  export type AgentSdkThinkingOptions = Pick<Options, 'thinking' | 'effort'>;
  export function toAgentSdkOptions(wire: WireParams): AgentSdkThinkingOptions;
  export interface MessagesApiThinkingParams { thinking?: { type: 'adaptive'; display?: 'omitted' | 'summarized' }; output_config?: { effort: EffortLevel } }
  export function toMessagesApiParams(wire: WireParams, opts: { thinksWhenOmitted: boolean }): MessagesApiThinkingParams;
  export class UnsupportedWireOptionError extends Error { readonly option: 'thinkingDisplay:updates' | 'speed' | 'inferenceGeo' }
  ```

- [ ] **Step 1: Write the failing test**

```ts
// apps/api/src/services/aiModels/wireParams.test.ts
import { describe, expect, it } from 'vitest';
import type { OptionSupport } from '@breeze/shared';
import {
  FAST_MODE_BETA,
  THINKING_DISPLAY_UPDATES_BETA,
  UnsupportedWireOptionError,
  buildWireParams,
  toAgentSdkOptions,
  toMessagesApiParams,
} from './wireParams';

const FULL: OptionSupport = {
  effort: ['low', 'medium', 'high', 'xhigh', 'max'],
  thinkingDisplay: ['omitted', 'summarized', 'updates'],
  speed: ['standard', 'fast'],
  inferenceGeo: ['us', 'global'],
};
const NOTHING: OptionSupport = { effort: [], thinkingDisplay: [], speed: ['standard'], inferenceGeo: [] };
const base = { optionSupport: FULL, requested: {}, maxTokens: 4096 } as const;

describe('buildWireParams', () => {
  it('adaptive + supported effort → adaptive thinking with that effort, never disabled', () => {
    expect(buildWireParams({ ...base, thinkingMode: 'adaptive', requested: { effort: 'medium' } })).toEqual({
      thinking: { type: 'adaptive' },
      effort: 'medium',
      betas: [],
      applied: { effort: 'medium' },
    });
  });

  it('adaptive + an effort the model lacks → effort omitted and not applied', () => {
    const wire = buildWireParams({ ...base, thinkingMode: 'adaptive', optionSupport: { ...FULL, effort: ['low', 'high'] }, requested: { effort: 'medium' } });
    expect(wire.thinking).toEqual({ type: 'adaptive' });
    expect('effort' in wire).toBe(false);
    expect(wire.applied).toEqual({});
  });

  it('display summarized is sent without a beta; updates adds the updates beta', () => {
    expect(buildWireParams({ ...base, thinkingMode: 'adaptive', requested: { thinkingDisplay: 'summarized' } }))
      .toMatchObject({ thinking: { type: 'adaptive', display: 'summarized' }, betas: [], applied: { thinkingDisplay: 'summarized' } });
    expect(buildWireParams({ ...base, thinkingMode: 'adaptive', requested: { thinkingDisplay: 'updates' } }))
      .toMatchObject({ thinking: { type: 'adaptive', display: 'updates' }, betas: [THINKING_DISPLAY_UPDATES_BETA] });
  });

  it('a display the model does not support is omitted', () => {
    const wire = buildWireParams({ ...base, thinkingMode: 'adaptive', optionSupport: NOTHING, requested: { thinkingDisplay: 'updates', effort: 'low' } });
    expect(wire).toEqual({ thinking: { type: 'adaptive' }, betas: [], applied: {} });
  });

  it('budget → thinking disabled and no effort, even when effort is requested (spec §7: separate concepts)', () => {
    expect(buildWireParams({ ...base, thinkingMode: 'budget', requested: { effort: 'medium' } })).toEqual({
      thinking: { type: 'disabled' },
      betas: [],
      applied: {},
    });
  });

  it.each(['none', 'unknown'] as const)('%s → no thinking param and no effort', (thinkingMode) => {
    expect(buildWireParams({ ...base, thinkingMode, requested: { effort: 'medium' } })).toEqual({ betas: [], applied: {} });
  });

  it('speed fast only where supported; adds the fast-mode beta and records it as applied', () => {
    expect(buildWireParams({ ...base, thinkingMode: 'adaptive', requested: { speed: 'fast' } }))
      .toMatchObject({ speed: 'fast', betas: [FAST_MODE_BETA], applied: { speed: 'fast' } });
    const unsupported = buildWireParams({ ...base, thinkingMode: 'adaptive', optionSupport: NOTHING, requested: { speed: 'fast' } });
    expect('speed' in unsupported).toBe(false);
    expect(unsupported.applied).toEqual({});
    expect(buildWireParams({ ...base, thinkingMode: 'adaptive', requested: { speed: 'standard' } }).applied).toEqual({ speed: 'standard' });
  });

  it('inference geo only when the model supports that value', () => {
    expect(buildWireParams({ ...base, thinkingMode: 'adaptive', inferenceGeo: 'us' }).inferenceGeo).toBe('us');
    expect('inferenceGeo' in buildWireParams({ ...base, thinkingMode: 'adaptive', inferenceGeo: 'eu' })).toBe(false);
    expect('inferenceGeo' in buildWireParams({ ...base, thinkingMode: 'adaptive', inferenceGeo: null })).toBe(false);
  });

  it.each([0, -1, 1.5, Number.NaN])('rejects maxTokens %s', (maxTokens) => {
    expect(() => buildWireParams({ ...base, thinkingMode: 'adaptive', maxTokens })).toThrow(RangeError);
  });

  it('returns fresh objects (callers may spread and mutate)', () => {
    const a = buildWireParams({ ...base, thinkingMode: 'adaptive', requested: { effort: 'low' } });
    const b = buildWireParams({ ...base, thinkingMode: 'adaptive', requested: { effort: 'low' } });
    expect(a).not.toBe(b);
    expect(a.betas).not.toBe(b.betas);
  });
});

describe('toAgentSdkOptions', () => {
  it('adaptive + effort → exactly the W00 shape', () => {
    const wire = buildWireParams({ ...base, thinkingMode: 'adaptive', requested: { effort: 'medium' } });
    expect(toAgentSdkOptions(wire)).toEqual({ thinking: { type: 'adaptive' }, effort: 'medium' });
  });

  it('adaptive without effort → no effort key', () => {
    const out = toAgentSdkOptions(buildWireParams({ ...base, thinkingMode: 'adaptive' }));
    expect(out).toEqual({ thinking: { type: 'adaptive' } });
    expect('effort' in out).toBe(false);
  });

  it('carries display summarized through', () => {
    const wire = buildWireParams({ ...base, thinkingMode: 'adaptive', requested: { thinkingDisplay: 'summarized' } });
    expect(toAgentSdkOptions(wire)).toEqual({ thinking: { type: 'adaptive', display: 'summarized' } });
  });

  // #7587: with NO thinking option the SDK CLI turns extended thinking ON for
  // Haiku 4.5 (~11x output tokens). Every non-adaptive mode is an explicit off.
  it.each(['budget', 'none', 'unknown'] as const)('%s → explicit thinking disabled, never omitted', (thinkingMode) => {
    const out = toAgentSdkOptions(buildWireParams({ ...base, thinkingMode, requested: { effort: 'medium' } }));
    expect(out).toEqual({ thinking: { type: 'disabled' } });
    expect('effort' in out).toBe(false);
  });

  it.each([
    ['thinkingDisplay:updates', { thinkingDisplay: 'updates' as const }, undefined],
    ['speed', { speed: 'fast' as const }, undefined],
    ['inferenceGeo', {}, 'us'],
  ])('refuses %s until the spike findings say the SDK carries it', (option, requested, inferenceGeo) => {
    const wire = buildWireParams({ ...base, thinkingMode: 'adaptive', requested, inferenceGeo });
    expect(() => toAgentSdkOptions(wire)).toThrow(UnsupportedWireOptionError);
    try {
      toAgentSdkOptions(wire);
    } catch (error) {
      expect((error as UnsupportedWireOptionError).option).toBe(option);
    }
  });
});

describe('toMessagesApiParams', () => {
  const adaptiveMedium = () => buildWireParams({ ...base, thinkingMode: 'adaptive', requested: { effort: 'medium' } });

  it('a model that thinks when the param is omitted → adaptive + output_config.effort (caps it)', () => {
    expect(toMessagesApiParams(adaptiveMedium(), { thinksWhenOmitted: true })).toEqual({
      thinking: { type: 'adaptive' },
      output_config: { effort: 'medium' },
    });
  });

  // #7587: one-shots never sent a thinking param before; a model that does not
  // think by default (Opus/Sonnet 4.6–4.8) is never switched on here.
  it('a model that does not think when omitted → nothing', () => {
    expect(toMessagesApiParams(adaptiveMedium(), { thinksWhenOmitted: false })).toEqual({});
  });

  it('adaptive with no effort and no display → nothing (nothing to cap)', () => {
    expect(toMessagesApiParams(buildWireParams({ ...base, thinkingMode: 'adaptive' }), { thinksWhenOmitted: true })).toEqual({});
  });

  it.each(['budget', 'none', 'unknown'] as const)('%s → nothing (a one-shot never sends disabled)', (thinkingMode) => {
    expect(toMessagesApiParams(buildWireParams({ ...base, thinkingMode }), { thinksWhenOmitted: true })).toEqual({});
  });

  it('refuses speed like the Agent SDK adapter', () => {
    const wire = buildWireParams({ ...base, thinkingMode: 'adaptive', requested: { speed: 'fast' } });
    expect(() => toMessagesApiParams(wire, { thinksWhenOmitted: true })).toThrow(UnsupportedWireOptionError);
  });
});
```

- [ ] **Step 2: Run it and watch it fail**

Run: `cd apps/api && npx vitest run src/services/aiModels/wireParams.test.ts`

Expected: FAIL with `Failed to resolve import "./wireParams"`.

- [ ] **Step 3: Implement**

```ts
// apps/api/src/services/aiModels/wireParams.ts
/**
 * AI model registry (spec §7): the ONLY place a thinking / effort / speed /
 * inference-geo request param is built (index invariant 2). Pure; no I/O.
 *
 * `buildWireParams` states what the Claude API should receive. The two
 * adapters spell that for a transport:
 * - `toAgentSdkOptions` for `query()`;
 * - `toMessagesApiParams` for raw `messages.create` one-shots.
 *
 * Neither adapter carries `display: 'updates'`, `speed` or `inferenceGeo`
 * yet. The W01 spike (docs/superpowers/specs/ai-mcp/2026-09-30-ai-model-registry-w01-spike-findings.md,
 * D1–D3) decides how they travel, and W03/W05 extend the adapters accordingly.
 */
import type { Options } from '@anthropic-ai/claude-agent-sdk';
import type { EffortLevel, OfferingOptions, OptionSupport, ThinkingDisplay } from '@breeze/shared';
import type { ThinkingMode } from './capabilities';

export const THINKING_DISPLAY_UPDATES_BETA = 'thinking-display-updates-2026-08-18';
export const FAST_MODE_BETA = 'fast-mode-2026-02-01';

export type WireThinking =
  | { type: 'adaptive'; display?: ThinkingDisplay }
  | { type: 'enabled'; budget_tokens: number }
  | { type: 'disabled' };

export interface WireParams {
  thinking?: WireThinking;
  effort?: EffortLevel;
  speed?: 'fast';
  inferenceGeo?: string;
  betas: string[];
  /** What was actually requested on the wire: the input to pricing (option rates) and the ledger. */
  applied: OfferingOptions;
}

export interface BuildWireParamsInput {
  thinkingMode: ThinkingMode;
  optionSupport: OptionSupport;
  requested: OfferingOptions;
  inferenceGeo?: string | null;
  maxTokens: number;
}

export function buildWireParams(input: BuildWireParamsInput): WireParams {
  if (!Number.isInteger(input.maxTokens) || input.maxTokens < 1) {
    throw new RangeError(`buildWireParams: maxTokens must be a positive integer, got ${String(input.maxTokens)}`);
  }
  const { thinkingMode, optionSupport: support, requested } = input;
  const applied: OfferingOptions = {};
  const betas: string[] = [];
  const wire: WireParams = { betas, applied };

  if (thinkingMode === 'adaptive') {
    // Never `disabled` on an adaptive model: Sonnet 5.5 / Opus 5.5 / Fable 400 on it.
    const thinking: { type: 'adaptive'; display?: ThinkingDisplay } = { type: 'adaptive' };
    if (requested.thinkingDisplay && support.thinkingDisplay.includes(requested.thinkingDisplay)) {
      thinking.display = requested.thinkingDisplay;
      applied.thinkingDisplay = requested.thinkingDisplay;
      if (requested.thinkingDisplay === 'updates') betas.push(THINKING_DISPLAY_UPDATES_BETA);
    }
    wire.thinking = thinking;
    if (requested.effort && support.effort.includes(requested.effort)) {
      wire.effort = requested.effort;
      applied.effort = requested.effort;
    }
  } else if (thinkingMode === 'budget') {
    // v1: budget-mode models run with thinking off. This is W00 parity for
    // Haiku 4.5. OfferingOptions has no on/off knob yet; the chat picker
    // (W05) adds it, and only then does this branch emit `enabled` with a
    // budget below `maxTokens`. Until then `maxTokens` is only validated.
    wire.thinking = { type: 'disabled' };
  }
  // 'none' and 'unknown': no thinking param, no effort (spec §7 table).

  if (requested.speed === 'fast' && support.speed.includes('fast')) {
    wire.speed = 'fast';
    applied.speed = 'fast';
    betas.push(FAST_MODE_BETA);
  } else if (requested.speed === 'standard') {
    applied.speed = 'standard';
  }

  if (input.inferenceGeo && support.inferenceGeo.includes(input.inferenceGeo)) {
    wire.inferenceGeo = input.inferenceGeo;
  }

  return wire;
}

export class UnsupportedWireOptionError extends Error {
  constructor(
    readonly option: 'thinkingDisplay:updates' | 'speed' | 'inferenceGeo',
    transport: 'agent_sdk' | 'messages_api',
  ) {
    super(
      `${option} cannot be sent over ${transport} yet. See `
      + 'docs/superpowers/specs/ai-mcp/2026-09-30-ai-model-registry-w01-spike-findings.md (D1-D3).',
    );
    this.name = 'UnsupportedWireOptionError';
  }
}

function assertCarriable(wire: WireParams, transport: 'agent_sdk' | 'messages_api'): void {
  if (wire.thinking?.type === 'adaptive' && wire.thinking.display === 'updates') {
    throw new UnsupportedWireOptionError('thinkingDisplay:updates', transport);
  }
  if (wire.speed) throw new UnsupportedWireOptionError('speed', transport);
  if (wire.inferenceGeo) throw new UnsupportedWireOptionError('inferenceGeo', transport);
}

export type AgentSdkThinkingOptions = Pick<Options, 'thinking' | 'effort'>;

/**
 * Agent SDK `query()` options. "Send nothing" is spelled `{ type: 'disabled' }`
 * because an omitted option lets the SDK CLI turn extended thinking ON
 * (#7587: Haiku 4.5, ~11x output tokens).
 */
export function toAgentSdkOptions(wire: WireParams): AgentSdkThinkingOptions {
  assertCarriable(wire, 'agent_sdk');
  const thinking = wire.thinking;
  if (!thinking || thinking.type === 'disabled') return { thinking: { type: 'disabled' } };
  if (thinking.type === 'enabled') return { thinking: { type: 'enabled', budgetTokens: thinking.budget_tokens } };
  const adaptive = thinking.display
    ? { type: 'adaptive' as const, display: thinking.display as 'omitted' | 'summarized' }
    : { type: 'adaptive' as const };
  return wire.effort ? { thinking: adaptive, effort: wire.effort } : { thinking: adaptive };
}

export interface MessagesApiThinkingParams {
  thinking?: { type: 'adaptive'; display?: 'omitted' | 'summarized' };
  output_config?: { effort: EffortLevel };
}

/**
 * Raw `messages.create` one-shots (#7587): params only ever REDUCE thinking.
 * They are sent only for an adaptive model that already thinks when the
 * param is omitted, to cap it at the requested effort. Everything else
 * sends nothing, so no new field reaches a catalog or BYO gateway.
 */
export function toMessagesApiParams(
  wire: WireParams,
  opts: { thinksWhenOmitted: boolean },
): MessagesApiThinkingParams {
  assertCarriable(wire, 'messages_api');
  if (wire.thinking?.type !== 'adaptive' || !opts.thinksWhenOmitted) return {};
  if (!wire.effort && !wire.thinking.display) return {};
  const thinking = wire.thinking.display
    ? { type: 'adaptive' as const, display: wire.thinking.display as 'omitted' | 'summarized' }
    : { type: 'adaptive' as const };
  return wire.effort ? { thinking, output_config: { effort: wire.effort } } : { thinking };
}
```

- [ ] **Step 4: Run it and watch it pass, then typecheck**

Run: `cd apps/api && npx vitest run src/services/aiModels/wireParams.test.ts && npx tsc --noEmit -p tsconfig.json`

Expected:
- vitest: PASS.
- tsc: exits 0. If `Options['thinking']` rejects `display: 'summarized'` on 0.3.286, read `ThinkingAdaptive` in `node_modules/@anthropic-ai/claude-agent-sdk/sdk.d.ts` and narrow the cast to its declared union.

- [ ] **Step 5: Commit**

```bash
git add apps/api/src/services/aiModels/wireParams.ts apps/api/src/services/aiModels/wireParams.test.ts
git commit -m "feat(ai): buildWireParams: one owner of thinking/effort/speed wire params (#7599)

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

## Task 5: `RateSnapshot` and `priceInvocation` (pure)

**Files:**
- Create: `apps/api/src/services/aiModels/pricing.ts`
- Create: `apps/api/src/services/aiModels/pricing.test.ts`

**Interfaces:**
- Consumes: `ModelRates`, `OfferingOptions`, `OptionRates` (Task 2).
- Produces:
  ```ts
  export type RateSnapshot = { source: 'platform' | 'offering' | 'catalog' | 'linked_platform'; standard: ModelRates; option?: { key: 'speed:fast'; rates: ModelRates } }; // index
  export type TokenComponents = { input: number; output: number; cacheRead: number; cacheWrite: number };                                     // index
  export function priceInvocation(rate: RateSnapshot, tokens: TokenComponents, applied: OfferingOptions): number; // index: cents, 6 dp
  export function computeInvocationCents(rate: RateSnapshot, tokens: TokenComponents, applied: OfferingOptions): number; // addition: unrounded
  export function platformRateSnapshot(model: { rates: ModelRates | null; optionRates: OptionRates | null }): RateSnapshot | null; // addition
  export class UnpricedOptionError extends Error {}                                                                       // addition
  ```

`computeInvocationCents` exists so `aiCostTracker.calculateCostCents` (Task 11) can keep W00's single 2-dp rounding. Rounding to 6 dp first and then to 2 dp would differ from W00 at half-cent boundaries.

- [ ] **Step 1: Write the failing test**

```ts
// apps/api/src/services/aiModels/pricing.test.ts
import { describe, expect, it } from 'vitest';
import { UnpricedOptionError, computeInvocationCents, platformRateSnapshot, priceInvocation, type RateSnapshot } from './pricing';

const STANDARD = { inputCentsPerM: 400, outputCentsPerM: 2000, cacheReadCentsPerM: 20, cacheWriteCentsPerM: 500 };
const FAST = { inputCentsPerM: 800, outputCentsPerM: 4000, cacheReadCentsPerM: 40, cacheWriteCentsPerM: 1000 };
const RATE: RateSnapshot = { source: 'platform', standard: STANDARD, option: { key: 'speed:fast', rates: FAST } };
const ONE_M = { input: 1_000_000, output: 1_000_000, cacheRead: 1_000_000, cacheWrite: 1_000_000 };

describe('priceInvocation', () => {
  it('prices every token component at the standard rate', () => {
    expect(priceInvocation(RATE, ONE_M, {})).toBe(400 + 2000 + 20 + 500);
    expect(priceInvocation(RATE, ONE_M, { speed: 'standard' })).toBe(2920);
  });

  it('prices a fast-mode call from the option rate', () => {
    expect(priceInvocation(RATE, ONE_M, { speed: 'fast' })).toBe(800 + 4000 + 40 + 1000);
  });

  it('never prices fast at the standard rate: an unpriced variant throws', () => {
    expect(() => priceInvocation({ source: 'platform', standard: STANDARD }, ONE_M, { speed: 'fast' }))
      .toThrow(UnpricedOptionError);
  });

  it('rounds to 6 decimal places of a cent', () => {
    const tiny: RateSnapshot = {
      source: 'platform',
      standard: { inputCentsPerM: 0.4, outputCentsPerM: 1.6, cacheReadCentsPerM: 0, cacheWriteCentsPerM: 0 },
    };
    expect(priceInvocation(tiny, { input: 1, output: 0, cacheRead: 0, cacheWrite: 0 }, {})).toBe(0); // 0.0000004
    expect(priceInvocation(tiny, { input: 0, output: 1, cacheRead: 0, cacheWrite: 0 }, {})).toBe(0.000002); // 0.0000016
    expect(priceInvocation(RATE, { input: 3, output: 7, cacheRead: 11, cacheWrite: 13 }, {})).toBe(0.02192);
  });

  it.each([-1, Number.NaN, Number.POSITIVE_INFINITY])('rejects a %s token count', (bad) => {
    expect(() => priceInvocation(RATE, { ...ONE_M, output: bad }, {})).toThrow(RangeError);
  });

  it('computeInvocationCents is the unrounded value', () => {
    expect(computeInvocationCents(RATE, { input: 1, output: 0, cacheRead: 0, cacheWrite: 0 }, {})).toBeCloseTo(0.0004, 12);
  });
});

describe('platformRateSnapshot', () => {
  it('is null for an unpriced row', () => {
    expect(platformRateSnapshot({ rates: null, optionRates: null })).toBeNull();
  });
  it('carries the fast rate only when one is set', () => {
    expect(platformRateSnapshot({ rates: STANDARD, optionRates: null })).toEqual({ source: 'platform', standard: STANDARD });
    expect(platformRateSnapshot({ rates: STANDARD, optionRates: { 'speed:fast': FAST } })).toEqual(RATE);
  });
});
```

- [ ] **Step 2: Run it and watch it fail**

Run: `cd apps/api && npx vitest run src/services/aiModels/pricing.test.ts`

Expected: FAIL with `Failed to resolve import "./pricing"`.

- [ ] **Step 3: Implement**

```ts
// apps/api/src/services/aiModels/pricing.ts
/**
 * AI model registry (spec §8): one cost function over one resolved rate
 * snapshot. W01 introduces it; aiCostTracker's token-based fallback reads it.
 * W03 makes it the only cost path. Pure; no I/O.
 */
import type { ModelRates, OfferingOptions, OptionRates } from '@breeze/shared';

export type RateSnapshot = {
  source: 'platform' | 'offering' | 'catalog' | 'linked_platform';
  standard: ModelRates;
  option?: { key: 'speed:fast'; rates: ModelRates };
};

export type TokenComponents = { input: number; output: number; cacheRead: number; cacheWrite: number };

/** A non-standard variant was used but the snapshot has no rate for it (spec §8: never guess). */
export class UnpricedOptionError extends Error {
  constructor(readonly optionKey: 'speed:fast') {
    super(`No rate for option variant "${optionKey}"; the call can't be priced.`);
    this.name = 'UnpricedOptionError';
  }
}

function assertTokens(tokens: TokenComponents): void {
  for (const [name, value] of Object.entries(tokens)) {
    if (!Number.isFinite(value) || value < 0) {
      throw new RangeError(`priceInvocation: ${name} tokens must be a non-negative finite number, got ${String(value)}`);
    }
  }
}

/** Unrounded cents. Summed in W00's order (input, output, cache read, cache write) for bit parity. */
export function computeInvocationCents(rate: RateSnapshot, tokens: TokenComponents, applied: OfferingOptions): number {
  assertTokens(tokens);
  let rates = rate.standard;
  if (applied.speed === 'fast') {
    if (rate.option?.key !== 'speed:fast') throw new UnpricedOptionError('speed:fast');
    rates = rate.option.rates;
  }
  return (tokens.input / 1_000_000) * rates.inputCentsPerM
    + (tokens.output / 1_000_000) * rates.outputCentsPerM
    + (tokens.cacheRead / 1_000_000) * rates.cacheReadCentsPerM
    + (tokens.cacheWrite / 1_000_000) * rates.cacheWriteCentsPerM;
}

/** Cents, rounded to 6 decimal places (the precision of `ai_sessions.total_cost_cents`). */
export function priceInvocation(rate: RateSnapshot, tokens: TokenComponents, applied: OfferingOptions): number {
  return Math.round(computeInvocationCents(rate, tokens, applied) * 1_000_000) / 1_000_000;
}

/** A platform row's snapshot, or null when the row is unpriced. */
export function platformRateSnapshot(model: { rates: ModelRates | null; optionRates: OptionRates | null }): RateSnapshot | null {
  if (!model.rates) return null;
  const fast = model.optionRates?.['speed:fast'];
  return fast
    ? { source: 'platform', standard: model.rates, option: { key: 'speed:fast', rates: fast } }
    : { source: 'platform', standard: model.rates };
}
```

- [ ] **Step 4: Run it and watch it pass**

Run: `cd apps/api && npx vitest run src/services/aiModels/pricing.test.ts`

Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add apps/api/src/services/aiModels/pricing.ts apps/api/src/services/aiModels/pricing.test.ts
git commit -m "feat(ai): RateSnapshot and priceInvocation (#7599)

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

## Task 6: `ai_platform_models` table, Drizzle schema, RLS classification and constraint backstops

**Files:**
- Create: `apps/api/migrations/2026-11-13-100000-ai-platform-models.sql`
- Create: `apps/api/src/db/schema/aiPlatformModels.ts`
- Create: `apps/api/src/db/schema/aiPlatformModels.contract.test.ts`
- Create: `apps/api/src/__tests__/integration/aiPlatformModels.integration.test.ts` (created here; extended in Tasks 8 and 9)
- Modify: `apps/api/src/db/schema/index.ts`. After `export * from './llmProviderCatalog';` (~L141), add `export * from './aiPlatformModels';`.
- Modify: `apps/api/src/__tests__/integration/rls-coverage.integration.test.ts`. In `INTENTIONAL_UNSCOPED`, after the `'llm_provider_verifications'` entry (~L103), add the entry from Step 3.

**Interfaces:**
- Consumes: `MODEL_LIFECYCLES`, `PROMPT_PROFILES` and the shared types (Task 2).
- Produces:
  - `aiPlatformModels` (Drizzle table);
  - `type AiPlatformModelRow = typeof aiPlatformModels.$inferSelect`;
  - constraint names `ai_platform_models_model_id_uq`, `_provider_chk`, `_lifecycle_chk`, `_prompt_profile_chk`, `_prices_nonneg_chk`, `_offered_priced_chk`, `_default_offered_chk`, `_missed_nonneg_chk`, `_option_support_obj_chk`, `_option_rates_obj_chk`, and the index `ai_platform_models_one_default_uq`.

Columns beyond spec §5.1 (index additions):
- `missed_sync_count`: the spec §6 "3 consecutive syncs" counter.
- `operator_notified_at`: so a failed ops alert is retried rather than lost.

- [ ] **Step 1: Write the failing contract test**

```ts
// apps/api/src/db/schema/aiPlatformModels.contract.test.ts
// AI model registry W01 (#7599): mechanical contract for ai_platform_models.
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { getTableColumns } from 'drizzle-orm';
import { MODEL_LIFECYCLES, PROMPT_PROFILES } from '@breeze/shared';
import { checkConstraintLiterals } from './checkConstraintTestHelpers';
import { aiPlatformModels } from './aiPlatformModels';

const DDL = readFileSync(
  new URL('../../../migrations/2026-11-13-100000-ai-platform-models.sql', import.meta.url),
  'utf8',
);

describe('ai_platform_models schema contract', () => {
  it('lifecycle and prompt_profile CHECKs match @breeze/shared exactly', () => {
    expect(checkConstraintLiterals(DDL, 'ai_platform_models_lifecycle_chk', 'lifecycle')).toEqual([...MODEL_LIFECYCLES]);
    expect(checkConstraintLiterals(DDL, 'ai_platform_models_prompt_profile_chk', 'prompt_profile')).toEqual([...PROMPT_PROFILES]);
    expect(checkConstraintLiterals(DDL, 'ai_platform_models_provider_chk', 'provider')).toEqual(['anthropic']);
  });

  it('offering requires all four prices, and the default must be offered', () => {
    const offered = /ai_platform_models_offered_priced_chk\s+CHECK\s*\(([\s\S]*?)\)\s*,\s*\n/.exec(DDL)?.[1] ?? '';
    for (const column of ['input_cents_per_m', 'output_cents_per_m', 'cache_read_cents_per_m', 'cache_write_cents_per_m']) {
      expect(offered).toContain(`${column} IS NOT NULL`);
    }
    expect(DDL).toMatch(/ai_platform_models_default_offered_chk\s+CHECK\s*\(\s*NOT is_platform_default OR platform_offered\s*\)/);
    expect(DDL).toMatch(/CREATE UNIQUE INDEX IF NOT EXISTS ai_platform_models_one_default_uq[\s\S]*WHERE is_platform_default/);
  });

  // CLAUDE.md cascade table: registration is triggered by these columns. None
  // exists, so no cascade / merge / device / ticket / export entry applies.
  it('has no tenant, device, ticket or user axis', () => {
    const columns = Object.values(getTableColumns(aiPlatformModels)).map((column) => column.name);
    for (const axis of ['org_id', 'partner_id', 'device_id', 'ticket_id', 'user_id']) {
      expect(columns).not.toContain(axis);
    }
  });

  it('the DDL migration writes no rows', () => {
    expect(DDL).not.toMatch(/\b(INSERT|UPDATE|DELETE)\b/i);
  });
});
```

- [ ] **Step 2: Run it and watch it fail**

Run: `cd apps/api && npx vitest run src/db/schema/aiPlatformModels.contract.test.ts`

Expected: FAIL with `ENOENT … 2026-11-13-100000-ai-platform-models.sql` (and `./aiPlatformModels` does not resolve).

- [ ] **Step 3: Implement the migration, the schema and the RLS classification**

Before naming the file, run `git ls-tree --name-only origin/main apps/api/migrations | sort | tail -3`. If anything sorts after `2026-11-13-100000`, rename both W01 migrations (this one and Task 8's) to sort after it, keeping the `-100000` / `-100100` pair order. Update every reference to the old name in this plan's tests.

```sql
-- apps/api/migrations/2026-11-13-100000-ai-platform-models.sql
-- AI model registry W01 (#7599, spec §5.1): system-wide platform model catalog.
--
-- One row per Anthropic model the platform knows. Each row holds:
--   * id, display name and token limits from the Models API;
--   * the raw `capabilities` tree, stored verbatim;
--   * operator prices (NULL = unpriced) and option-variant rates;
--   * option support (derived plus operator-set);
--   * the hosted plan gate, the prompt profile, the platform offer flag,
--     the single platform default, and the discovery lifecycle.
--
-- System-wide: no org_id or partner_id, NO RLS. This mirrors
-- llm_provider_catalog (2026-09-12-llm-provider-catalog.sql). Every request
-- context reads it (pricing, capability lookups). Writes are gated at the
-- application layer to the discovery worker and the platform-admin + MFA
-- /admin/ai-models routes. Classified INTENTIONAL_UNSCOPED in
-- rls-coverage.integration.test.ts.
--
-- DDL only (no rows written), so no breeze.scope election is needed; the
-- seed lives in 2026-11-13-100100-ai-platform-models-seed.sql. Idempotent;
-- autoMigrate wraps the file in a transaction (no BEGIN/COMMIT here).

CREATE TABLE IF NOT EXISTS ai_platform_models (
  id                       uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  provider                 text NOT NULL DEFAULT 'anthropic',
  model_id                 text NOT NULL,
  display_name             text NOT NULL,
  max_input_tokens         integer,
  max_output_tokens        integer,
  capabilities             jsonb,
  input_cents_per_m        numeric(12,4),
  output_cents_per_m       numeric(12,4),
  cache_read_cents_per_m   numeric(12,4),
  cache_write_cents_per_m  numeric(12,4),
  option_rates             jsonb,
  option_support           jsonb NOT NULL DEFAULT '{"effort":[],"thinkingDisplay":[],"speed":["standard"],"inferenceGeo":[]}'::jsonb,
  min_plan                 text,
  prompt_profile           text NOT NULL DEFAULT 'generic',
  platform_offered         boolean NOT NULL DEFAULT false,
  is_platform_default      boolean NOT NULL DEFAULT false,
  lifecycle                text NOT NULL DEFAULT 'available',
  missed_sync_count        integer NOT NULL DEFAULT 0,
  operator_notified_at     timestamptz,
  first_seen_at            timestamptz NOT NULL DEFAULT now(),
  last_seen_at             timestamptz,
  updated_at               timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT ai_platform_models_model_id_uq UNIQUE (model_id),
  CONSTRAINT ai_platform_models_provider_chk CHECK (provider IN ('anthropic')),
  CONSTRAINT ai_platform_models_lifecycle_chk CHECK (lifecycle IN ('available', 'missing', 'retired')),
  CONSTRAINT ai_platform_models_prompt_profile_chk CHECK (prompt_profile IN ('claude-frontier', 'claude-standard', 'claude-small', 'generic')),
  CONSTRAINT ai_platform_models_prices_nonneg_chk CHECK (
    (input_cents_per_m IS NULL OR input_cents_per_m >= 0)
    AND (output_cents_per_m IS NULL OR output_cents_per_m >= 0)
    AND (cache_read_cents_per_m IS NULL OR cache_read_cents_per_m >= 0)
    AND (cache_write_cents_per_m IS NULL OR cache_write_cents_per_m >= 0)
  ),
  CONSTRAINT ai_platform_models_offered_priced_chk CHECK (
    NOT platform_offered OR (
      input_cents_per_m IS NOT NULL
      AND output_cents_per_m IS NOT NULL
      AND cache_read_cents_per_m IS NOT NULL
      AND cache_write_cents_per_m IS NOT NULL
    )
  ),
  CONSTRAINT ai_platform_models_default_offered_chk CHECK (NOT is_platform_default OR platform_offered),
  CONSTRAINT ai_platform_models_missed_nonneg_chk CHECK (missed_sync_count >= 0),
  CONSTRAINT ai_platform_models_option_support_obj_chk CHECK (jsonb_typeof(option_support) = 'object'),
  CONSTRAINT ai_platform_models_option_rates_obj_chk CHECK (option_rates IS NULL OR jsonb_typeof(option_rates) = 'object')
);

-- At most one platform default (spec §5.1).
CREATE UNIQUE INDEX IF NOT EXISTS ai_platform_models_one_default_uq
  ON ai_platform_models (is_platform_default)
  WHERE is_platform_default;
```

```ts
// apps/api/src/db/schema/aiPlatformModels.ts
import { sql } from 'drizzle-orm';
import { boolean, check, integer, jsonb, numeric, pgTable, text, timestamp, uniqueIndex, uuid } from 'drizzle-orm/pg-core';
import type { ModelLifecycle, OptionRates, OptionSupport, PromptProfile } from '@breeze/shared';

/**
 * AI model registry W01 (#7599): system-wide platform model catalog.
 * No tenant column and no RLS (INTENTIONAL_UNSCOPED, same posture as
 * llm_provider_catalog). Writes: the ai-model-discovery worker and
 * /admin/ai-models (platform admin + MFA) only. Prices are cents per million
 * tokens; NULL = unpriced. Migration: 2026-11-13-100000-ai-platform-models.sql.
 */
export const aiPlatformModels = pgTable('ai_platform_models', {
  id: uuid('id').primaryKey().defaultRandom(),
  provider: text('provider').$type<'anthropic'>().notNull().default('anthropic'),
  modelId: text('model_id').notNull(),
  displayName: text('display_name').notNull(),
  maxInputTokens: integer('max_input_tokens'),
  maxOutputTokens: integer('max_output_tokens'),
  /** Raw Models API `capabilities` tree, verbatim (spec §5.1). */
  capabilities: jsonb('capabilities').$type<unknown>(),
  inputCentsPerM: numeric('input_cents_per_m', { precision: 12, scale: 4, mode: 'number' }),
  outputCentsPerM: numeric('output_cents_per_m', { precision: 12, scale: 4, mode: 'number' }),
  cacheReadCentsPerM: numeric('cache_read_cents_per_m', { precision: 12, scale: 4, mode: 'number' }),
  cacheWriteCentsPerM: numeric('cache_write_cents_per_m', { precision: 12, scale: 4, mode: 'number' }),
  optionRates: jsonb('option_rates').$type<OptionRates>(),
  optionSupport: jsonb('option_support').$type<OptionSupport>().notNull()
    .default(sql`'{"effort":[],"thinkingDisplay":[],"speed":["standard"],"inferenceGeo":[]}'::jsonb`),
  minPlan: text('min_plan'),
  promptProfile: text('prompt_profile').$type<PromptProfile>().notNull().default('generic'),
  platformOffered: boolean('platform_offered').notNull().default(false),
  isPlatformDefault: boolean('is_platform_default').notNull().default(false),
  lifecycle: text('lifecycle').$type<ModelLifecycle>().notNull().default('available'),
  missedSyncCount: integer('missed_sync_count').notNull().default(0),
  operatorNotifiedAt: timestamp('operator_notified_at', { withTimezone: true }),
  firstSeenAt: timestamp('first_seen_at', { withTimezone: true }).notNull().defaultNow(),
  lastSeenAt: timestamp('last_seen_at', { withTimezone: true }),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
}, (t) => [
  uniqueIndex('ai_platform_models_model_id_uq').on(t.modelId),
  uniqueIndex('ai_platform_models_one_default_uq').on(t.isPlatformDefault).where(sql`is_platform_default`),
  check('ai_platform_models_provider_chk', sql`${t.provider} IN ('anthropic')`),
  check('ai_platform_models_lifecycle_chk', sql`${t.lifecycle} IN ('available', 'missing', 'retired')`),
  check('ai_platform_models_prompt_profile_chk', sql`${t.promptProfile} IN ('claude-frontier', 'claude-standard', 'claude-small', 'generic')`),
  check('ai_platform_models_offered_priced_chk', sql`NOT ${t.platformOffered} OR (${t.inputCentsPerM} IS NOT NULL AND ${t.outputCentsPerM} IS NOT NULL AND ${t.cacheReadCentsPerM} IS NOT NULL AND ${t.cacheWriteCentsPerM} IS NOT NULL)`),
  check('ai_platform_models_default_offered_chk', sql`NOT ${t.isPlatformDefault} OR ${t.platformOffered}`),
  check('ai_platform_models_missed_nonneg_chk', sql`${t.missedSyncCount} >= 0`),
]);

export type AiPlatformModelRow = typeof aiPlatformModels.$inferSelect;
```

Add to `apps/api/src/db/schema/index.ts` after `export * from './llmProviderCatalog';`:
```ts
export * from './aiPlatformModels';
```

Add to `INTENTIONAL_UNSCOPED` in `rls-coverage.integration.test.ts`, directly after the `'llm_provider_verifications'` line:
```ts
  'ai_platform_models', // AI model registry W01 (#7599): system-wide platform model catalog (Anthropic model ids, capabilities, operator prices, option support). No tenant column and NO RLS — same posture as llm_provider_catalog; every request context reads it for pricing and capabilities. Writes are gated to the ai-model-discovery worker and the platform-admin + MFA /admin/ai-models routes. No org_id / device_id, so no cascade, merge or export registration applies. Plan: docs/superpowers/plans/ai-mcp/2026-09-30-ai-model-registry-w01-platform-catalog.md.
```

- [ ] **Step 4: Run the contract test and watch it pass**

Run: `cd apps/api && npx vitest run src/db/schema/aiPlatformModels.contract.test.ts src/db/autoMigrate.test.ts`

Expected: PASS (both files).

- [ ] **Step 5: Write the failing integration test (posture + CHECK backstops)**

```ts
// apps/api/src/__tests__/integration/aiPlatformModels.integration.test.ts
import './setup';
import { randomUUID } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { sql } from 'drizzle-orm';
import { db, withDbAccessContext, withSystemDbAccessContext, type DbAccessContext } from '../../db';
import { aiPlatformModels } from '../../db/schema';
import { pgErrorCode, pgErrorConstraint } from '../../utils/pgErrors';
import { createOrganization, createPartner } from './db-utils';

const runDb = it.runIf(!!process.env.DATABASE_URL);

const RATES = { inputCentsPerM: 100, outputCentsPerM: 500, cacheReadCentsPerM: 10, cacheWriteCentsPerM: 125 };

function testModelId(): string {
  return `w01-test-${randomUUID()}`;
}

function orgContext(orgId: string): DbAccessContext {
  return { scope: 'organization', orgId, accessibleOrgIds: [orgId], accessiblePartnerIds: [], userId: null };
}

/** Runs `fn` in its own system transaction and returns the Postgres error it raised. The failure rolls the transaction back. */
async function pgFailure(fn: () => Promise<unknown>): Promise<{ code: string | undefined; constraint: string | undefined }> {
  try {
    await withSystemDbAccessContext(async () => {
      await fn();
    });
  } catch (error) {
    return { code: pgErrorCode(error), constraint: pgErrorConstraint(error) };
  }
  throw new Error('expected a Postgres error');
}

describe('ai_platform_models: posture and constraint backstops (W01 #7599)', () => {
  runDb('carries no RLS: the route layer is the only gate (mirrors llm_provider_catalog)', async () => {
    const rows = (await withSystemDbAccessContext(() => db.execute(sql`
      SELECT c.relrowsecurity AS rls_on, c.relforcerowsecurity AS force_on
      FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
      WHERE n.nspname = 'public' AND c.relname = 'ai_platform_models'
    `))) as unknown as Array<{ rls_on: boolean; force_on: boolean }>;
    expect(rows).toEqual([{ rls_on: false, force_on: false }]);
  });

  runDb('an org-scoped request context can read it (hot-path price and capability lookups)', async () => {
    const org = await withSystemDbAccessContext(async () => {
      const partner = await createPartner();
      return createOrganization({ partnerId: partner.id });
    });
    const rows = await withDbAccessContext(orgContext(org.id), () =>
      db.select({ n: sql<number>`count(*)::int` }).from(aiPlatformModels),
    );
    expect(typeof rows[0]?.n).toBe('number');
  });

  runDb('rejects platform_offered without all four prices (23514)', async () => {
    expect(await pgFailure(() => db.insert(aiPlatformModels).values({
      modelId: testModelId(), displayName: 'unpriced', platformOffered: true, inputCentsPerM: 100,
    }))).toEqual({ code: '23514', constraint: 'ai_platform_models_offered_priced_chk' });
  });

  runDb('rejects a platform default that is not offered (23514)', async () => {
    expect(await pgFailure(async () => {
      await db.update(aiPlatformModels).set({ isPlatformDefault: false }).where(sql`is_platform_default`);
      await db.insert(aiPlatformModels).values({
        modelId: testModelId(), displayName: 'default not offered', isPlatformDefault: true, ...RATES,
      });
    })).toEqual({ code: '23514', constraint: 'ai_platform_models_default_offered_chk' });
  });

  runDb('allows at most one platform default (23505)', async () => {
    expect(await pgFailure(async () => {
      await db.update(aiPlatformModels).set({ isPlatformDefault: false }).where(sql`is_platform_default`);
      for (let i = 0; i < 2; i += 1) {
        await db.insert(aiPlatformModels).values({
          modelId: testModelId(), displayName: `default ${i}`, platformOffered: true, isPlatformDefault: true, ...RATES,
        });
      }
    })).toEqual({ code: '23505', constraint: 'ai_platform_models_one_default_uq' });
  });

  runDb.each([
    ['a negative price', { inputCentsPerM: -1 }, 'ai_platform_models_prices_nonneg_chk'],
    ['an unknown lifecycle', { lifecycle: 'gone' }, 'ai_platform_models_lifecycle_chk'],
    ['an unknown prompt profile', { promptProfile: 'tiny' }, 'ai_platform_models_prompt_profile_chk'],
    ['a non-object option_support', { optionSupport: sql`'[]'::jsonb` }, 'ai_platform_models_option_support_obj_chk'],
  ] as const)('rejects %s (23514)', async (_label, values, constraint) => {
    expect(await pgFailure(() => db.insert(aiPlatformModels).values({
      modelId: testModelId(), displayName: 'bad', ...(values as Record<string, unknown>),
    } as typeof aiPlatformModels.$inferInsert))).toEqual({ code: '23514', constraint });
  });

  runDb('rejects a duplicate model_id (23505)', async () => {
    const modelId = testModelId();
    expect(await pgFailure(async () => {
      await db.insert(aiPlatformModels).values({ modelId, displayName: 'one' });
      await db.insert(aiPlatformModels).values({ modelId, displayName: 'two' });
    })).toEqual({ code: '23505', constraint: 'ai_platform_models_model_id_uq' });
  });
});
```

`runDb.each` is `it.runIf(...).each`, which vitest supports. If the installed vitest rejects chaining, replace that block with a `for … of` loop of `runDb(...)` calls; the assertions stay the same.

- [ ] **Step 6: Run the integration test, RLS coverage and drift**

Run:
```bash
pnpm test-stack up
cd apps/api && npx vitest run --config vitest.integration.config.ts src/__tests__/integration/aiPlatformModels.integration.test.ts
cd ../.. && DB_CONTEXTLESS_WRITE_STRICT=true pnpm --filter=@breeze/api test:rls-coverage
pnpm db:check-drift
```

Expected:
- The integration file passes. The org-context read returns `0` until Task 8 seeds rows; that's fine.
- RLS coverage passes, including "every public base table is classified by exactly one tenancy bucket". Without the Step 3 entry that test reports `unclassified: ['ai_platform_models']`.
- Drift reports no differences. If it flags a CHECK or index rendering difference, change the Drizzle side to match the SQL text, never the migration.

- [ ] **Step 7: Confirm no cascade registration applies (mechanical, per CLAUDE.md)**

Run:
```bash
git grep -n "ai_platform_models" -- apps/api/src/services/tenantCascade.ts apps/api/src/services/orgMergeRegistry.ts \
  apps/api/src/services/tenantExportPolicyRegistry.ts apps/api/src/routes/devices/core.ts apps/api/src/services/ticketOrgMoveLockOrder.ts
```

Expected: no output. The table has no `org_id`, `device_id` or `ticket_id`; the Step 1 contract test pins that.

- [ ] **Step 8: Commit**

```bash
git add apps/api/migrations/2026-11-13-100000-ai-platform-models.sql apps/api/src/db/schema/aiPlatformModels.ts \
  apps/api/src/db/schema/aiPlatformModels.contract.test.ts apps/api/src/db/schema/index.ts \
  apps/api/src/__tests__/integration/aiPlatformModels.integration.test.ts \
  apps/api/src/__tests__/integration/rls-coverage.integration.test.ts
git commit -m "feat(ai): ai_platform_models table: system-wide platform model catalog (#7599)

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

## Task 7: `PlatformModel` type, row mapper, in-process snapshot and admin-patch validation (pure)

**Files:**
- Create: `apps/api/src/services/aiModels/platformModels.ts` (type + mapper only here; Task 9 adds the DB functions)
- Create: `apps/api/src/services/aiModels/platformModels.test.ts`
- Create: `apps/api/src/services/aiModels/platformModelSnapshot.ts`
- Create: `apps/api/src/services/aiModels/platformModelSnapshot.test.ts`
- Create: `apps/api/src/services/aiModels/platformModelAdmin.ts`
- Create: `apps/api/src/services/aiModels/platformModelAdmin.test.ts`

**Interfaces:**
- Consumes:
  - `AiPlatformModelRow` (Task 6);
  - `deriveCapabilities`, `optionSupportErrors` (Task 3);
  - shared schemas (Task 2).
- Produces:
  ```ts
  // platformModels.ts
  export interface PlatformModel {           // index name
    id: string; provider: 'anthropic'; modelId: string; displayName: string;
    maxInputTokens: number | null; maxOutputTokens: number | null; capabilities: unknown;
    rates: ModelRates | null; optionRates: OptionRates | null; optionSupport: OptionSupport;
    minPlan: string | null; promptProfile: PromptProfile; platformOffered: boolean; isPlatformDefault: boolean;
    lifecycle: ModelLifecycle; missedSyncCount: number; operatorNotifiedAt: Date | null;
    firstSeenAt: Date; lastSeenAt: Date | null; updatedAt: Date;
  }
  export function toPlatformModel(row: AiPlatformModelRow): PlatformModel;
  // platformModelSnapshot.ts (dependency-free; safe to import from aiModel.ts and aiCostTracker.ts)
  export function setPlatformModelSnapshot(models: readonly PlatformModel[], loadedAt?: number): void;
  export function clearPlatformModelSnapshot(): void;
  export function isPlatformModelSnapshotLoaded(): boolean;
  export function peekPlatformModel(modelId: string): PlatformModel | undefined;
  export function peekPlatformDefaultModelId(): string | null;
  // platformModelAdmin.ts
  export class PlatformModelError extends Error { readonly status: 400 | 404 | 409 }
  export interface PlatformModelAdminPatch { rates?: ModelRates | null; optionRates?: OptionRates | null; optionSupport?: OptionSupport; minPlan?: string | null; promptProfile?: PromptProfile; platformOffered?: boolean; isPlatformDefault?: boolean }
  export interface PlatformModelAdminState { rates: ModelRates | null; optionRates: OptionRates | null; optionSupport: OptionSupport; minPlan: string | null; promptProfile: PromptProfile; platformOffered: boolean; isPlatformDefault: boolean }
  export function validatePlatformModelAdminPatch(current: PlatformModel, patch: PlatformModelAdminPatch): PlatformModelAdminState;
  ```

- [ ] **Step 1: Write the failing tests**

```ts
// apps/api/src/services/aiModels/platformModels.test.ts
import { describe, expect, it, vi } from 'vitest';
import type { AiPlatformModelRow } from '../../db/schema';
import { toPlatformModel } from './platformModels';

const NOW = new Date('2026-11-13T00:00:00.000Z');

function row(over: Partial<AiPlatformModelRow> = {}): AiPlatformModelRow {
  return {
    id: '00000000-0000-4000-8000-000000000001',
    provider: 'anthropic',
    modelId: 'model-a',
    displayName: 'Model A',
    maxInputTokens: 1000,
    maxOutputTokens: 100,
    capabilities: null,
    inputCentsPerM: 100,
    outputCentsPerM: 500,
    cacheReadCentsPerM: 10,
    cacheWriteCentsPerM: 125,
    optionRates: null,
    optionSupport: { effort: [], thinkingDisplay: [], speed: ['standard'], inferenceGeo: [] },
    minPlan: null,
    promptProfile: 'generic',
    platformOffered: false,
    isPlatformDefault: false,
    lifecycle: 'available',
    missedSyncCount: 0,
    operatorNotifiedAt: null,
    firstSeenAt: NOW,
    lastSeenAt: null,
    updatedAt: NOW,
    ...over,
  };
}

describe('toPlatformModel', () => {
  it('groups the four prices into rates', () => {
    expect(toPlatformModel(row()).rates).toEqual({ inputCentsPerM: 100, outputCentsPerM: 500, cacheReadCentsPerM: 10, cacheWriteCentsPerM: 125 });
  });

  it('a row missing any price is unpriced (rates null)', () => {
    expect(toPlatformModel(row({ cacheWriteCentsPerM: null })).rates).toBeNull();
  });

  it('accepts numeric columns delivered as strings', () => {
    expect(toPlatformModel(row({ inputCentsPerM: '2.5000' as unknown as number })).rates?.inputCentsPerM).toBe(2.5);
  });

  it('falls back to empty option support (and warns) when the stored value is malformed', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    expect(toPlatformModel(row({ optionSupport: { effort: ['huge'] } as never })).optionSupport)
      .toEqual({ effort: [], thinkingDisplay: [], speed: ['standard'], inferenceGeo: [] });
    expect(warn).toHaveBeenCalled();
    warn.mockRestore();
  });

  it('drops malformed option rates to null', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    expect(toPlatformModel(row({ optionRates: { 'speed:turbo': {} } as never })).optionRates).toBeNull();
    warn.mockRestore();
  });
});
```

```ts
// apps/api/src/services/aiModels/platformModelSnapshot.test.ts
import { afterEach, describe, expect, it } from 'vitest';
import type { PlatformModel } from './platformModels';
import {
  clearPlatformModelSnapshot,
  isPlatformModelSnapshotLoaded,
  peekPlatformDefaultModelId,
  peekPlatformModel,
  setPlatformModelSnapshot,
} from './platformModelSnapshot';

function model(modelId: string, over: Partial<PlatformModel> = {}): PlatformModel {
  const at = new Date('2026-11-13T00:00:00.000Z');
  return {
    id: `id-${modelId}`, provider: 'anthropic', modelId, displayName: modelId, maxInputTokens: null, maxOutputTokens: null,
    capabilities: null, rates: null, optionRates: null,
    optionSupport: { effort: [], thinkingDisplay: [], speed: ['standard'], inferenceGeo: [] },
    minPlan: null, promptProfile: 'generic', platformOffered: false, isPlatformDefault: false, lifecycle: 'available',
    missedSyncCount: 0, operatorNotifiedAt: null, firstSeenAt: at, lastSeenAt: null, updatedAt: at, ...over,
  };
}

afterEach(() => clearPlatformModelSnapshot());

describe('platform model snapshot', () => {
  it('starts cold', () => {
    expect(isPlatformModelSnapshotLoaded()).toBe(false);
    expect(peekPlatformModel('a')).toBeUndefined();
    expect(peekPlatformDefaultModelId()).toBeNull();
  });

  it('indexes by model id and reports the default', () => {
    setPlatformModelSnapshot([model('a'), model('b', { platformOffered: true, isPlatformDefault: true })]);
    expect(isPlatformModelSnapshotLoaded()).toBe(true);
    expect(peekPlatformModel('a')?.modelId).toBe('a');
    expect(peekPlatformDefaultModelId()).toBe('b');
  });

  it('a retired default is not reported', () => {
    setPlatformModelSnapshot([model('b', { platformOffered: true, isPlatformDefault: true, lifecycle: 'retired' })]);
    expect(peekPlatformDefaultModelId()).toBeNull();
  });

  it('an empty load is still "loaded" (registry reachable, nothing in it)', () => {
    setPlatformModelSnapshot([]);
    expect(isPlatformModelSnapshotLoaded()).toBe(true);
  });

  it('replacing the snapshot drops rows that disappeared', () => {
    setPlatformModelSnapshot([model('a')]);
    setPlatformModelSnapshot([model('b')]);
    expect(peekPlatformModel('a')).toBeUndefined();
  });
});
```

```ts
// apps/api/src/services/aiModels/platformModelAdmin.test.ts
import { describe, expect, it } from 'vitest';
import type { PlatformModel } from './platformModels';
import { PlatformModelError, validatePlatformModelAdminPatch, type PlatformModelAdminPatch } from './platformModelAdmin';

const RATES = { inputCentsPerM: 400, outputCentsPerM: 2000, cacheReadCentsPerM: 20, cacheWriteCentsPerM: 500 };
const ADAPTIVE = {
  thinking: { supported: true, types: { adaptive: { supported: true }, enabled: { supported: false } } },
  effort: { supported: true, low: { supported: true }, medium: { supported: true }, high: { supported: true }, xhigh: { supported: false }, max: { supported: true } },
};

function model(over: Partial<PlatformModel> = {}): PlatformModel {
  const at = new Date('2026-11-13T00:00:00.000Z');
  return {
    id: 'id-a', provider: 'anthropic', modelId: 'model-a', displayName: 'A', maxInputTokens: null, maxOutputTokens: null,
    capabilities: ADAPTIVE, rates: RATES, optionRates: null,
    optionSupport: { effort: ['low', 'medium', 'high', 'max'], thinkingDisplay: ['omitted', 'summarized'], speed: ['standard'], inferenceGeo: [] },
    minPlan: null, promptProfile: 'claude-standard', platformOffered: true, isPlatformDefault: false, lifecycle: 'available',
    missedSyncCount: 0, operatorNotifiedAt: null, firstSeenAt: at, lastSeenAt: at, updatedAt: at, ...over,
  };
}

function rejection(current: PlatformModel, patch: PlatformModelAdminPatch): { status: number; message: string } {
  try {
    validatePlatformModelAdminPatch(current, patch);
  } catch (error) {
    if (error instanceof PlatformModelError) return { status: error.status, message: error.message };
    throw error;
  }
  throw new Error('expected a PlatformModelError');
}

describe('validatePlatformModelAdminPatch', () => {
  it('applies a partial patch over the current state', () => {
    expect(validatePlatformModelAdminPatch(model(), { minPlan: 'pro', promptProfile: 'claude-frontier' })).toEqual({
      rates: RATES,
      optionRates: null,
      optionSupport: model().optionSupport,
      minPlan: 'pro',
      promptProfile: 'claude-frontier',
      platformOffered: true,
      isPlatformDefault: false,
    });
  });

  it('allows promoting an offered, available model to default', () => {
    expect(validatePlatformModelAdminPatch(model(), { isPlatformDefault: true }).isPlatformDefault).toBe(true);
  });

  it.each([
    ['offering an unpriced model', model({ rates: null, platformOffered: false }), { platformOffered: true }, 400, 'Set all four prices before offering this model.'],
    ['clearing the prices of an offered model', model(), { rates: null }, 400, 'Set all four prices before offering this model.'],
    ['offering a retired model', model({ platformOffered: false, lifecycle: 'retired' }), { platformOffered: true }, 400, 'A retired model cannot be offered.'],
    ['un-defaulting the current default', model({ isPlatformDefault: true }), { isPlatformDefault: false }, 409, 'This model is the platform default. Make another model the default first.'],
    ['un-offering the current default', model({ isPlatformDefault: true }), { platformOffered: false }, 409, 'The platform default must stay offered. Make another model the default first.'],
    ['defaulting an unoffered model', model({ platformOffered: false }), { isPlatformDefault: true }, 400, 'Only an offered, available model can be the platform default.'],
    ['defaulting a missing model', model({ lifecycle: 'missing' }), { isPlatformDefault: true }, 400, 'Only an offered, available model can be the platform default.'],
    ['an effort level the model lacks', model(), { optionSupport: { effort: ['xhigh'], thinkingDisplay: [], speed: ['standard'], inferenceGeo: [] } }, 400, 'Effort "xhigh" is not supported by this model.'],
  ] as const)('rejects %s', (_label, current, patch, status, message) => {
    expect(rejection(current, patch as PlatformModelAdminPatch)).toEqual({ status, message });
  });

  it('allows a fast rate without fast support and fast support without a rate (an unpriced variant is simply unselectable, spec §8)', () => {
    expect(() => validatePlatformModelAdminPatch(model(), { optionRates: { 'speed:fast': RATES } })).not.toThrow();
    expect(() => validatePlatformModelAdminPatch(model(), {
      optionSupport: { ...model().optionSupport, speed: ['standard', 'fast'] },
    })).not.toThrow();
  });
});
```

- [ ] **Step 2: Run them and watch them fail**

Run: `cd apps/api && npx vitest run src/services/aiModels/platformModels.test.ts src/services/aiModels/platformModelSnapshot.test.ts src/services/aiModels/platformModelAdmin.test.ts`

Expected: FAIL. The three modules don't resolve yet.

- [ ] **Step 3: Implement**

```ts
// apps/api/src/services/aiModels/platformModels.ts
/**
 * AI model registry W01 (#7599): the platform model catalog
 * (`ai_platform_models`). Task 7 adds the type and the row mapper; Task 9 adds
 * the database functions to this file.
 */
import {
  emptyOptionSupport,
  optionRatesSchema,
  optionSupportSchema,
  type ModelLifecycle,
  type ModelRates,
  type OptionRates,
  type OptionSupport,
  type PromptProfile,
} from '@breeze/shared';
import type { AiPlatformModelRow } from '../../db/schema';

export interface PlatformModel {
  id: string;
  provider: 'anthropic';
  modelId: string;
  displayName: string;
  maxInputTokens: number | null;
  maxOutputTokens: number | null;
  /** Raw Models API capabilities tree (or the seed's stand-in until the first sync sees the model). */
  capabilities: unknown;
  /** All four standard rates, or null when any is unset (unpriced). */
  rates: ModelRates | null;
  optionRates: OptionRates | null;
  optionSupport: OptionSupport;
  minPlan: string | null;
  promptProfile: PromptProfile;
  platformOffered: boolean;
  isPlatformDefault: boolean;
  lifecycle: ModelLifecycle;
  missedSyncCount: number;
  operatorNotifiedAt: Date | null;
  firstSeenAt: Date;
  /** Null until a discovery sync has seen the model (seeded rows start null). */
  lastSeenAt: Date | null;
  updatedAt: Date;
}

function toNumber(value: number | string | null): number | null {
  if (value === null) return null;
  const n = typeof value === 'number' ? value : Number(value);
  return Number.isFinite(n) ? n : null;
}

export function toPlatformModel(row: AiPlatformModelRow): PlatformModel {
  const input = toNumber(row.inputCentsPerM);
  const output = toNumber(row.outputCentsPerM);
  const cacheRead = toNumber(row.cacheReadCentsPerM);
  const cacheWrite = toNumber(row.cacheWriteCentsPerM);
  const rates = input !== null && output !== null && cacheRead !== null && cacheWrite !== null
    ? { inputCentsPerM: input, outputCentsPerM: output, cacheReadCentsPerM: cacheRead, cacheWriteCentsPerM: cacheWrite }
    : null;

  const support = optionSupportSchema.safeParse(row.optionSupport);
  if (!support.success) {
    console.warn(`[aiModels] ai_platform_models.option_support for "${row.modelId}" is malformed; treating it as empty`);
  }
  let optionRates: OptionRates | null = null;
  if (row.optionRates !== null) {
    const parsed = optionRatesSchema.safeParse(row.optionRates);
    if (parsed.success) optionRates = parsed.data;
    else console.warn(`[aiModels] ai_platform_models.option_rates for "${row.modelId}" is malformed; ignoring it`);
  }

  return {
    id: row.id,
    provider: 'anthropic',
    modelId: row.modelId,
    displayName: row.displayName,
    maxInputTokens: row.maxInputTokens,
    maxOutputTokens: row.maxOutputTokens,
    capabilities: row.capabilities ?? null,
    rates,
    optionRates,
    optionSupport: support.success ? support.data : emptyOptionSupport(),
    minPlan: row.minPlan,
    promptProfile: row.promptProfile,
    platformOffered: row.platformOffered,
    isPlatformDefault: row.isPlatformDefault,
    lifecycle: row.lifecycle,
    missedSyncCount: row.missedSyncCount,
    operatorNotifiedAt: row.operatorNotifiedAt,
    firstSeenAt: row.firstSeenAt,
    lastSeenAt: row.lastSeenAt,
    updatedAt: row.updatedAt,
  };
}
```

```ts
// apps/api/src/services/aiModels/platformModelSnapshot.ts
/**
 * In-process snapshot of ai_platform_models for synchronous hot paths: the
 * Agent SDK wire options and the cost tracker's token-rate lookup.
 *
 * Dependency-free on purpose: aiModel.ts and aiCostTracker.ts import it, and
 * hundreds of tests import those without mocking the database.
 *
 * Loaded by refreshPlatformModelSnapshot() (platformModels.ts):
 * - on a 60 s boot timer in the API and worker processes;
 * - after every admin write;
 * - after every discovery sync.
 *
 * Cold (never loaded) means callers apply the W00 bootstrap rules.
 */
import type { PlatformModel } from './platformModels';

interface Snapshot {
  byModelId: ReadonlyMap<string, PlatformModel>;
  defaultModelId: string | null;
  loadedAt: number;
}

let current: Snapshot | null = null;

export function setPlatformModelSnapshot(models: readonly PlatformModel[], loadedAt: number = Date.now()): void {
  const byModelId = new Map(models.map((model) => [model.modelId, model] as const));
  const defaultModel = models.find((model) => model.isPlatformDefault && model.lifecycle !== 'retired');
  current = { byModelId, defaultModelId: defaultModel?.modelId ?? null, loadedAt };
}

export function clearPlatformModelSnapshot(): void {
  current = null;
}

export function isPlatformModelSnapshotLoaded(): boolean {
  return current !== null;
}

export function peekPlatformModel(modelId: string): PlatformModel | undefined {
  return current?.byModelId.get(modelId);
}

export function peekPlatformDefaultModelId(): string | null {
  return current?.defaultModelId ?? null;
}
```

```ts
// apps/api/src/services/aiModels/platformModelAdmin.ts
/**
 * Pure validation of a /admin/ai-models patch (spec §5.1, §8, §11). The DB
 * CHECKs (offered ⇒ priced, default ⇒ offered, one default) are the backstop.
 * These rules exist to give the operator a clear message first.
 */
import type { ModelRates, OptionRates, OptionSupport, PromptProfile } from '@breeze/shared';
import { deriveCapabilities, optionSupportErrors } from './capabilities';
import type { PlatformModel } from './platformModels';

export class PlatformModelError extends Error {
  constructor(message: string, readonly status: 400 | 404 | 409) {
    super(message);
    this.name = 'PlatformModelError';
  }
}

export interface PlatformModelAdminPatch {
  rates?: ModelRates | null;
  optionRates?: OptionRates | null;
  optionSupport?: OptionSupport;
  minPlan?: string | null;
  promptProfile?: PromptProfile;
  platformOffered?: boolean;
  isPlatformDefault?: boolean;
}

export interface PlatformModelAdminState {
  rates: ModelRates | null;
  optionRates: OptionRates | null;
  optionSupport: OptionSupport;
  minPlan: string | null;
  promptProfile: PromptProfile;
  platformOffered: boolean;
  isPlatformDefault: boolean;
}

export function validatePlatformModelAdminPatch(current: PlatformModel, patch: PlatformModelAdminPatch): PlatformModelAdminState {
  const next: PlatformModelAdminState = {
    rates: patch.rates !== undefined ? patch.rates : current.rates,
    optionRates: patch.optionRates !== undefined ? patch.optionRates : current.optionRates,
    optionSupport: patch.optionSupport ?? current.optionSupport,
    minPlan: patch.minPlan !== undefined ? patch.minPlan : current.minPlan,
    promptProfile: patch.promptProfile ?? current.promptProfile,
    platformOffered: patch.platformOffered ?? current.platformOffered,
    isPlatformDefault: patch.isPlatformDefault ?? current.isPlatformDefault,
  };

  if (current.isPlatformDefault && patch.isPlatformDefault === false) {
    throw new PlatformModelError('This model is the platform default. Make another model the default first.', 409);
  }
  if (current.isPlatformDefault && !next.platformOffered) {
    throw new PlatformModelError('The platform default must stay offered. Make another model the default first.', 409);
  }
  if (next.platformOffered && next.rates === null) {
    throw new PlatformModelError('Set all four prices before offering this model.', 400);
  }
  if (next.platformOffered && !current.platformOffered && current.lifecycle === 'retired') {
    throw new PlatformModelError('A retired model cannot be offered.', 400);
  }
  if (next.isPlatformDefault && !current.isPlatformDefault
    && (!next.platformOffered || current.lifecycle !== 'available')) {
    throw new PlatformModelError('Only an offered, available model can be the platform default.', 400);
  }

  const supportErrors = optionSupportErrors(deriveCapabilities(current.capabilities), next.optionSupport);
  if (supportErrors.length > 0) throw new PlatformModelError(supportErrors.join(' '), 400);

  return next;
}
```

- [ ] **Step 4: Run them and watch them pass**

Run: `cd apps/api && npx vitest run src/services/aiModels/platformModels.test.ts src/services/aiModels/platformModelSnapshot.test.ts src/services/aiModels/platformModelAdmin.test.ts`

Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add apps/api/src/services/aiModels/platformModels.ts apps/api/src/services/aiModels/platformModels.test.ts \
  apps/api/src/services/aiModels/platformModelSnapshot.ts apps/api/src/services/aiModels/platformModelSnapshot.test.ts \
  apps/api/src/services/aiModels/platformModelAdmin.ts apps/api/src/services/aiModels/platformModelAdmin.test.ts
git commit -m "feat(ai): PlatformModel type, registry snapshot and admin patch rules (#7599)

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

## Task 8: Seed migration, seed fixture and W00 parity oracles

The seed makes a fresh self-host work before its first sync (spec §5.1). It is copied from #7593's `MODEL_PRICING` / `OFFERABLE_AI_MODELS`:
- All 10 priced ids become rows.
- The 7 offerable ids are `platform_offered`.
- `claude-sonnet-5-5` is the platform default.

`capabilities` is seeded with a stand-in Models API tree per model. Thinking/effort derivation then works before any sync, and on gateway self-hosts where sync never runs. The first successful sync replaces it with the real tree.

`option_support` follows spec §7:
- `updates` on Fable 5.1 / Opus 5.5 / Sonnet 5.5;
- `fast` on Opus 5.5 and Opus 4.8. Opus 5 is not in W00's tables; it arrives through discovery and the operator adds `fast` there.

`inferenceGeo` stays `[]` on every row until spike Q6/D3 confirms values.

`option_rates` stays NULL. Spec §15 #3 and #7: no variant is billed at a guessed rate, and the operator enters fast-mode rates.

**Files:**
- Create: `apps/api/migrations/2026-11-13-100100-ai-platform-models-seed.sql`
- Create: `apps/api/src/services/aiModels/__fixtures__/seededPlatformModels.ts`
- Create: `apps/api/src/services/aiModels/__fixtures__/seededPlatformModels.test.ts`
- Modify: `apps/api/src/__tests__/integration/aiPlatformModels.integration.test.ts` (append a describe block)

**Interfaces:**
- Consumes: `PlatformModel` (Task 7), `deriveCapabilities` / `deriveOptionSupport` / `optionSupportErrors` (Task 3), `computeInvocationCents` / `platformRateSnapshot` (Task 5).
- Produces (test fixtures; index invariant 1 allows model literals here):
  ```ts
  export const SEEDED_PLATFORM_MODELS: readonly PlatformModel[];
  export function seededPlatformModel(modelId: string): PlatformModel;
  export const W00_MODEL_PRICING: Readonly<Record<string, { inputPerMillion: number; outputPerMillion: number; cacheReadPerMillion?: number }>>;
  export const W00_OFFERABLE_AI_MODELS: readonly string[];
  export function w00CalculateCostCents(model: string, input: number, output: number, cacheRead?: number, cacheWrite?: number): number;
  export const PARITY_TOKEN_VECTORS: ReadonlyArray<readonly [number, number, number, number]>;
  ```

- [ ] **Step 1: Write the fixture and its failing self-test**

```ts
// apps/api/src/services/aiModels/__fixtures__/seededPlatformModels.ts
/**
 * AI model registry W01 (#7599) test oracles.
 *
 * - SEEDED_PLATFORM_MODELS mirrors 2026-11-13-100100-ai-platform-models-seed.sql
 *   row for row. aiPlatformModels.integration.test.ts proves the DB matches.
 * - W00_* are FROZEN copies of #7593's MODEL_PRICING / OFFERABLE_AI_MODELS /
 *   calculateCostCents. Parity tests compare the registry against them, so
 *   they must never be "updated" to match new behaviour.
 */
import type { OptionSupport, PromptProfile } from '@breeze/shared';
import type { PlatformModel } from '../platformModels';

const SEEDED_AT = new Date('2026-11-13T10:01:00.000Z');

const yes = { supported: true } as const;
const no = { supported: false } as const;
export const SEED_CAPS_ADAPTIVE_FULL = {
  thinking: { supported: true, types: { adaptive: yes, enabled: no } },
  effort: { supported: true, low: yes, medium: yes, high: yes, xhigh: yes, max: yes },
  image_input: yes,
};
export const SEED_CAPS_ADAPTIVE_NO_XHIGH = {
  thinking: { supported: true, types: { adaptive: yes, enabled: yes } },
  effort: { supported: true, low: yes, medium: yes, high: yes, xhigh: no, max: yes },
  image_input: yes,
};
export const SEED_CAPS_BUDGET_ONLY = {
  thinking: { supported: true, types: { adaptive: no, enabled: yes } },
  effort: { supported: false, low: no, medium: no, high: no, xhigh: no, max: no },
  image_input: yes,
};

const EFFORT_ALL = ['low', 'medium', 'high', 'xhigh', 'max'] as OptionSupport['effort'];
const support = (over: Partial<OptionSupport>): OptionSupport => ({
  effort: [], thinkingDisplay: ['omitted', 'summarized'], speed: ['standard'], inferenceGeo: [], ...over,
});

function seeded(input: {
  modelId: string;
  displayName: string;
  maxInputTokens: number;
  maxOutputTokens: number;
  capabilities: unknown;
  rates: [number, number, number, number];
  optionSupport: OptionSupport;
  promptProfile: PromptProfile;
  platformOffered: boolean;
  isPlatformDefault?: boolean;
}): PlatformModel {
  const [inputCentsPerM, outputCentsPerM, cacheReadCentsPerM, cacheWriteCentsPerM] = input.rates;
  return {
    id: `seed:${input.modelId}`,
    provider: 'anthropic',
    modelId: input.modelId,
    displayName: input.displayName,
    maxInputTokens: input.maxInputTokens,
    maxOutputTokens: input.maxOutputTokens,
    capabilities: input.capabilities,
    rates: { inputCentsPerM, outputCentsPerM, cacheReadCentsPerM, cacheWriteCentsPerM },
    optionRates: null,
    optionSupport: input.optionSupport,
    minPlan: null,
    promptProfile: input.promptProfile,
    platformOffered: input.platformOffered,
    isPlatformDefault: input.isPlatformDefault ?? false,
    lifecycle: 'available',
    missedSyncCount: 0,
    operatorNotifiedAt: SEEDED_AT,
    firstSeenAt: SEEDED_AT,
    lastSeenAt: null,
    updatedAt: SEEDED_AT,
  };
}

export const SEEDED_PLATFORM_MODELS: readonly PlatformModel[] = Object.freeze([
  seeded({ modelId: 'claude-sonnet-5-5', displayName: 'Claude Sonnet 5.5', maxInputTokens: 1_000_000, maxOutputTokens: 128_000, capabilities: SEED_CAPS_ADAPTIVE_FULL, rates: [200, 1000, 20, 250], optionSupport: support({ effort: EFFORT_ALL, thinkingDisplay: ['omitted', 'summarized', 'updates'] }), promptProfile: 'claude-standard', platformOffered: true, isPlatformDefault: true }),
  seeded({ modelId: 'claude-opus-5-5', displayName: 'Claude Opus 5.5', maxInputTokens: 1_000_000, maxOutputTokens: 128_000, capabilities: SEED_CAPS_ADAPTIVE_FULL, rates: [400, 2000, 20, 500], optionSupport: support({ effort: EFFORT_ALL, thinkingDisplay: ['omitted', 'summarized', 'updates'], speed: ['standard', 'fast'] }), promptProfile: 'claude-frontier', platformOffered: true }),
  seeded({ modelId: 'claude-fable-5-1', displayName: 'Claude Fable 5.1', maxInputTokens: 1_000_000, maxOutputTokens: 128_000, capabilities: SEED_CAPS_ADAPTIVE_FULL, rates: [1000, 5000, 25, 1250], optionSupport: support({ effort: EFFORT_ALL, thinkingDisplay: ['omitted', 'summarized', 'updates'] }), promptProfile: 'claude-frontier', platformOffered: true }),
  seeded({ modelId: 'claude-opus-4-8', displayName: 'Claude Opus 4.8', maxInputTokens: 1_000_000, maxOutputTokens: 128_000, capabilities: SEED_CAPS_ADAPTIVE_FULL, rates: [500, 2500, 50, 625], optionSupport: support({ effort: EFFORT_ALL, speed: ['standard', 'fast'] }), promptProfile: 'claude-standard', platformOffered: true }),
  seeded({ modelId: 'claude-sonnet-4-6', displayName: 'Claude Sonnet 4.6', maxInputTokens: 1_000_000, maxOutputTokens: 128_000, capabilities: SEED_CAPS_ADAPTIVE_NO_XHIGH, rates: [300, 1500, 30, 375], optionSupport: support({ effort: ['low', 'medium', 'high', 'max'] }), promptProfile: 'claude-standard', platformOffered: true }),
  seeded({ modelId: 'claude-haiku-4-5', displayName: 'Claude Haiku 4.5', maxInputTokens: 200_000, maxOutputTokens: 64_000, capabilities: SEED_CAPS_BUDGET_ONLY, rates: [100, 500, 10, 125], optionSupport: support({}), promptProfile: 'claude-small', platformOffered: true }),
  seeded({ modelId: 'claude-haiku-4-5-20251001', displayName: 'Claude Haiku 4.5 (2025-10-01)', maxInputTokens: 200_000, maxOutputTokens: 64_000, capabilities: SEED_CAPS_BUDGET_ONLY, rates: [100, 500, 10, 125], optionSupport: support({}), promptProfile: 'claude-small', platformOffered: false }),
  seeded({ modelId: 'claude-fable-5', displayName: 'Claude Fable 5', maxInputTokens: 1_000_000, maxOutputTokens: 128_000, capabilities: SEED_CAPS_ADAPTIVE_FULL, rates: [1000, 5000, 100, 1250], optionSupport: support({ effort: EFFORT_ALL }), promptProfile: 'claude-frontier', platformOffered: true }),
  seeded({ modelId: 'claude-sonnet-4-5', displayName: 'Claude Sonnet 4.5', maxInputTokens: 200_000, maxOutputTokens: 64_000, capabilities: SEED_CAPS_BUDGET_ONLY, rates: [300, 1500, 30, 375], optionSupport: support({}), promptProfile: 'claude-standard', platformOffered: false }),
  seeded({ modelId: 'claude-sonnet-4-5-20250929', displayName: 'Claude Sonnet 4.5 (2025-09-29)', maxInputTokens: 200_000, maxOutputTokens: 64_000, capabilities: SEED_CAPS_BUDGET_ONLY, rates: [300, 1500, 30, 375], optionSupport: support({}), promptProfile: 'claude-standard', platformOffered: false }),
]);

export function seededPlatformModel(modelId: string): PlatformModel {
  const model = SEEDED_PLATFORM_MODELS.find((m) => m.modelId === modelId);
  if (!model) throw new Error(`no seeded platform model "${modelId}"`);
  return model;
}

/** FROZEN: #7593 aiCostTracker.ts MODEL_PRICING (cents per MTok). */
export const W00_MODEL_PRICING: Readonly<Record<string, { inputPerMillion: number; outputPerMillion: number; cacheReadPerMillion?: number }>> = Object.freeze({
  'claude-sonnet-5-5': { inputPerMillion: 200, outputPerMillion: 1000 },
  'claude-opus-5-5': { inputPerMillion: 400, outputPerMillion: 2000, cacheReadPerMillion: 20 },
  'claude-fable-5-1': { inputPerMillion: 1000, outputPerMillion: 5000, cacheReadPerMillion: 25 },
  'claude-opus-4-8': { inputPerMillion: 500, outputPerMillion: 2500 },
  'claude-sonnet-4-6': { inputPerMillion: 300, outputPerMillion: 1500 },
  'claude-haiku-4-5': { inputPerMillion: 100, outputPerMillion: 500 },
  'claude-haiku-4-5-20251001': { inputPerMillion: 100, outputPerMillion: 500 },
  'claude-fable-5': { inputPerMillion: 1000, outputPerMillion: 5000 },
  'claude-sonnet-4-5': { inputPerMillion: 300, outputPerMillion: 1500 },
  'claude-sonnet-4-5-20250929': { inputPerMillion: 300, outputPerMillion: 1500 },
});

/** FROZEN: #7593 aiOfferableModels.ts OFFERABLE_AI_MODELS. */
export const W00_OFFERABLE_AI_MODELS: readonly string[] = Object.freeze([
  'claude-opus-5-5',
  'claude-sonnet-5-5',
  'claude-fable-5-1',
  'claude-opus-4-8',
  'claude-sonnet-4-6',
  'claude-haiku-4-5',
  'claude-fable-5',
]);

/** FROZEN: #7593 calculateCostCents, including the DEFAULT_PRICING fallback. */
export function w00CalculateCostCents(model: string, input: number, output: number, cacheRead = 0, cacheWrite = 0): number {
  const pricing = W00_MODEL_PRICING[model] ?? { inputPerMillion: 500, outputPerMillion: 2500 };
  const inputCost = (input / 1_000_000) * pricing.inputPerMillion;
  const outputCost = (output / 1_000_000) * pricing.outputPerMillion;
  const cacheReadCost = (cacheRead / 1_000_000) * (pricing.cacheReadPerMillion ?? pricing.inputPerMillion * 0.1);
  const cacheWriteCost = (cacheWrite / 1_000_000) * pricing.inputPerMillion * 1.25;
  return Math.round((inputCost + outputCost + cacheReadCost + cacheWriteCost) * 100) / 100;
}

/** [input, output, cacheRead, cacheWrite] vectors used by every price-parity test. */
export const PARITY_TOKEN_VECTORS: ReadonlyArray<readonly [number, number, number, number]> = Object.freeze([
  [0, 0, 0, 0],
  [1_000_000, 0, 0, 0],
  [0, 1_000_000, 0, 0],
  [0, 0, 1_000_000, 0],
  [0, 0, 0, 1_000_000],
  [1_234, 567, 89_000, 4_321],
  [250_000, 12_345, 3_000_000, 50_000],
  [7, 13, 0, 0],
]);
```

```ts
// apps/api/src/services/aiModels/__fixtures__/seededPlatformModels.test.ts
import { describe, expect, it } from 'vitest';
import { deriveCapabilities, deriveOptionSupport, optionSupportErrors } from '../capabilities';
import { computeInvocationCents, platformRateSnapshot } from '../pricing';
import {
  PARITY_TOKEN_VECTORS,
  SEEDED_PLATFORM_MODELS,
  W00_MODEL_PRICING,
  W00_OFFERABLE_AI_MODELS,
  w00CalculateCostCents,
} from './seededPlatformModels';

describe('seeded platform models (fixture self-consistency)', () => {
  it('seeds exactly the W00 priced ids', () => {
    expect(SEEDED_PLATFORM_MODELS.map((m) => m.modelId).sort()).toEqual(Object.keys(W00_MODEL_PRICING).sort());
  });

  it('offers exactly the W00 offerable ids, with Sonnet 5.5 the only default', () => {
    expect(SEEDED_PLATFORM_MODELS.filter((m) => m.platformOffered).map((m) => m.modelId).sort())
      .toEqual([...W00_OFFERABLE_AI_MODELS].sort());
    expect(SEEDED_PLATFORM_MODELS.filter((m) => m.isPlatformDefault).map((m) => m.modelId)).toEqual(['claude-sonnet-5-5']);
  });

  it('every seeded rate prices every parity vector exactly as W00 did', () => {
    for (const model of SEEDED_PLATFORM_MODELS) {
      const rate = platformRateSnapshot(model);
      expect(rate, model.modelId).not.toBeNull();
      for (const [input, output, cacheRead, cacheWrite] of PARITY_TOKEN_VECTORS) {
        const cents = Math.round(computeInvocationCents(rate!, { input, output, cacheRead, cacheWrite }, {}) * 100) / 100;
        expect(cents, `${model.modelId} ${[input, output, cacheRead, cacheWrite].join('/')}`)
          .toBe(w00CalculateCostCents(model.modelId, input, output, cacheRead, cacheWrite));
      }
    }
  });

  it('seeded option support stays within what the seeded capabilities allow', () => {
    for (const model of SEEDED_PLATFORM_MODELS) {
      const derived = deriveCapabilities(model.capabilities);
      expect(optionSupportErrors(derived, model.optionSupport), model.modelId).toEqual([]);
      expect(model.optionSupport.effort, model.modelId).toEqual(deriveOptionSupport(derived).effort);
      expect(model.optionSupport.inferenceGeo, model.modelId).toEqual([]);
    }
  });

  it('seeded capabilities derive to the W00 thinking classes (adaptive for Fable and Opus/Sonnet 4.6+, budget otherwise)', () => {
    const modes = Object.fromEntries(SEEDED_PLATFORM_MODELS.map((m) => [m.modelId, deriveCapabilities(m.capabilities).thinkingMode]));
    expect(modes).toEqual({
      'claude-sonnet-5-5': 'adaptive',
      'claude-opus-5-5': 'adaptive',
      'claude-fable-5-1': 'adaptive',
      'claude-opus-4-8': 'adaptive',
      'claude-sonnet-4-6': 'adaptive',
      'claude-haiku-4-5': 'budget',
      'claude-haiku-4-5-20251001': 'budget',
      'claude-fable-5': 'adaptive',
      'claude-sonnet-4-5': 'budget',
      'claude-sonnet-4-5-20250929': 'budget',
    });
  });
});
```

- [ ] **Step 2: Run the fixture test**

Run: `cd apps/api && npx vitest run src/services/aiModels/__fixtures__/seededPlatformModels.test.ts`

Expected: PASS. It pins the fixture against the frozen oracles; the SQL comes next. If the price-parity case fails for one vector, the seeded `cache_read` / `cache_write` for that id is wrong. Fix the fixture and the SQL together; never the oracle.

- [ ] **Step 3: Write the failing seed-parity integration test**

Append to `apps/api/src/__tests__/integration/aiPlatformModels.integration.test.ts`. Add these imports at the top of the file:
```ts
import { readFileSync } from 'node:fs';
import { inArray } from 'drizzle-orm';
import { toPlatformModel } from '../../services/aiModels/platformModels';
import { SEEDED_PLATFORM_MODELS, W00_OFFERABLE_AI_MODELS } from '../../services/aiModels/__fixtures__/seededPlatformModels';
```

Then the block:
```ts
const SEED_SQL_PATH = new URL('../../../migrations/2026-11-13-100100-ai-platform-models-seed.sql', import.meta.url);
const SEEDED_IDS = SEEDED_PLATFORM_MODELS.map((m) => m.modelId);
class Rollback extends Error {}

function comparable(model: ReturnType<typeof toPlatformModel>) {
  return {
    provider: model.provider,
    modelId: model.modelId,
    displayName: model.displayName,
    maxInputTokens: model.maxInputTokens,
    maxOutputTokens: model.maxOutputTokens,
    capabilities: model.capabilities,
    rates: model.rates,
    optionRates: model.optionRates,
    optionSupport: model.optionSupport,
    minPlan: model.minPlan,
    promptProfile: model.promptProfile,
    platformOffered: model.platformOffered,
    isPlatformDefault: model.isPlatformDefault,
    lifecycle: model.lifecycle,
    missedSyncCount: model.missedSyncCount,
    lastSeenAt: model.lastSeenAt,
  };
}

async function seededRows() {
  return withSystemDbAccessContext(async () =>
    (await db.select().from(aiPlatformModels).where(inArray(aiPlatformModels.modelId, SEEDED_IDS))).map(toPlatformModel),
  );
}

describe('ai_platform_models seed (W01 #7599)', () => {
  runDb('matches the fixture row for row (W00 MODEL_PRICING / OFFERABLE_AI_MODELS)', async () => {
    const rows = await seededRows();
    expect(rows.map(comparable).sort((a, b) => a.modelId.localeCompare(b.modelId)))
      .toEqual(SEEDED_PLATFORM_MODELS.map(comparable).sort((a, b) => a.modelId.localeCompare(b.modelId)));
    for (const row of rows) expect(row.operatorNotifiedAt, row.modelId).not.toBeNull();
  });

  runDb('offers exactly the W00 offerable ids, and Sonnet 5.5 is the only platform default', async () => {
    const rows = await seededRows();
    expect(rows.filter((r) => r.platformOffered).map((r) => r.modelId).sort()).toEqual([...W00_OFFERABLE_AI_MODELS].sort());
    const defaults = await withSystemDbAccessContext(() =>
      db.select({ modelId: aiPlatformModels.modelId }).from(aiPlatformModels).where(sql`is_platform_default`),
    );
    expect(defaults).toEqual([{ modelId: 'claude-sonnet-5-5' }]);
  });

  runDb('re-running the seed is a no-op that never overwrites operator edits', async () => {
    await expect(withSystemDbAccessContext(async () => {
      await db.update(aiPlatformModels).set({ inputCentsPerM: 999 }).where(sql`model_id = 'claude-opus-4-8'`);
      await db.execute(sql.raw(readFileSync(SEED_SQL_PATH, 'utf8')));
      const [row] = await db.select().from(aiPlatformModels).where(sql`model_id = 'claude-opus-4-8'`);
      expect(toPlatformModel(row!).rates?.inputCentsPerM).toBe(999);
      const [{ n }] = (await db.execute(sql`SELECT count(*)::int AS n FROM ai_platform_models WHERE model_id IN ${SEEDED_IDS}`)) as unknown as Array<{ n: number }>;
      expect(n).toBe(SEEDED_IDS.length);
      throw new Rollback();
    })).rejects.toBeInstanceOf(Rollback);
  });
});
```

Run: `cd apps/api && npx vitest run --config vitest.integration.config.ts src/__tests__/integration/aiPlatformModels.integration.test.ts`

Expected: FAIL. The seed file doesn't exist (`ENOENT`), and the row comparison finds `[]`.

If drizzle refuses to bind the `SEEDED_IDS` array inside the raw `sql` IN clause, replace that count query with `db.select({ n: sql<number>\`count(*)::int\` }).from(aiPlatformModels).where(inArray(aiPlatformModels.modelId, SEEDED_IDS))`.

- [ ] **Step 4: Write the seed migration**

```sql
-- apps/api/migrations/2026-11-13-100100-ai-platform-models-seed.sql
-- AI model registry W01 (#7599): seed ai_platform_models from the constants
-- W00 (#7593) shipped: aiCostTracker.ts MODEL_PRICING (prices) and
-- aiOfferableModels.ts OFFERABLE_AI_MODELS (platform_offered). A fresh
-- self-host therefore prices and offers exactly what it did before W01,
-- even if discovery never runs (no key, or a gateway ANTHROPIC_BASE_URL).
--
-- capabilities: a stand-in Models API tree per model, so thinking/effort
-- derivation works before the first sync. The first successful sync
-- replaces it with the real tree (last_seen_at stays NULL until then).
-- cache_read = MODEL_PRICING.cacheReadPerMillion, or input x 0.1;
-- cache_write = input x 1.25 (aiCostTracker CACHE_*_INPUT_MULTIPLIER).
-- option_support per spec §7: 'updates' on Fable 5.1 / Opus 5.5 / Sonnet 5.5,
-- 'fast' on Opus 5.5 and Opus 4.8. inferenceGeo stays [] until the W01 spike
-- (findings D3) confirms values. option_rates stays NULL: the operator
-- enters fast-mode rates; nothing is billed at a guessed rate (§15 #3, #7).
-- operator_notified_at = now(): seeded ids are not "new models" to alert on.
--
-- WRITES ROWS: system scope is elected first (FORCE RLS is irrelevant to this
-- table, but the repo rule and migrationRlsScope.test.ts apply to every
-- writing migration). Idempotent: ON CONFLICT (model_id) DO NOTHING never
-- overwrites operator edits. The inserted count is reported.
DO $$
DECLARE
  caps_adaptive_full jsonb := '{"thinking":{"supported":true,"types":{"adaptive":{"supported":true},"enabled":{"supported":false}}},"effort":{"supported":true,"low":{"supported":true},"medium":{"supported":true},"high":{"supported":true},"xhigh":{"supported":true},"max":{"supported":true}},"image_input":{"supported":true}}';
  caps_adaptive_no_xhigh jsonb := '{"thinking":{"supported":true,"types":{"adaptive":{"supported":true},"enabled":{"supported":true}}},"effort":{"supported":true,"low":{"supported":true},"medium":{"supported":true},"high":{"supported":true},"xhigh":{"supported":false},"max":{"supported":true}},"image_input":{"supported":true}}';
  caps_budget_only jsonb := '{"thinking":{"supported":true,"types":{"adaptive":{"supported":false},"enabled":{"supported":true}}},"effort":{"supported":false,"low":{"supported":false},"medium":{"supported":false},"high":{"supported":false},"xhigh":{"supported":false},"max":{"supported":false}},"image_input":{"supported":true}}';
  support_updates jsonb := '{"effort":["low","medium","high","xhigh","max"],"thinkingDisplay":["omitted","summarized","updates"],"speed":["standard"],"inferenceGeo":[]}';
  support_updates_fast jsonb := '{"effort":["low","medium","high","xhigh","max"],"thinkingDisplay":["omitted","summarized","updates"],"speed":["standard","fast"],"inferenceGeo":[]}';
  support_full_fast jsonb := '{"effort":["low","medium","high","xhigh","max"],"thinkingDisplay":["omitted","summarized"],"speed":["standard","fast"],"inferenceGeo":[]}';
  support_full jsonb := '{"effort":["low","medium","high","xhigh","max"],"thinkingDisplay":["omitted","summarized"],"speed":["standard"],"inferenceGeo":[]}';
  support_no_xhigh jsonb := '{"effort":["low","medium","high","max"],"thinkingDisplay":["omitted","summarized"],"speed":["standard"],"inferenceGeo":[]}';
  support_budget jsonb := '{"effort":[],"thinkingDisplay":["omitted","summarized"],"speed":["standard"],"inferenceGeo":[]}';
  n integer;
BEGIN
  PERFORM set_config('breeze.scope', 'system', true);

  INSERT INTO ai_platform_models (
    provider, model_id, display_name, max_input_tokens, max_output_tokens, capabilities,
    input_cents_per_m, output_cents_per_m, cache_read_cents_per_m, cache_write_cents_per_m,
    option_support, prompt_profile, platform_offered, is_platform_default, lifecycle, operator_notified_at
  ) VALUES
    ('anthropic', 'claude-sonnet-5-5', 'Claude Sonnet 5.5', 1000000, 128000, caps_adaptive_full, 200, 1000, 20, 250, support_updates, 'claude-standard', true, true, 'available', now()),
    ('anthropic', 'claude-opus-5-5', 'Claude Opus 5.5', 1000000, 128000, caps_adaptive_full, 400, 2000, 20, 500, support_updates_fast, 'claude-frontier', true, false, 'available', now()),
    ('anthropic', 'claude-fable-5-1', 'Claude Fable 5.1', 1000000, 128000, caps_adaptive_full, 1000, 5000, 25, 1250, support_updates, 'claude-frontier', true, false, 'available', now()),
    ('anthropic', 'claude-opus-4-8', 'Claude Opus 4.8', 1000000, 128000, caps_adaptive_full, 500, 2500, 50, 625, support_full_fast, 'claude-standard', true, false, 'available', now()),
    ('anthropic', 'claude-sonnet-4-6', 'Claude Sonnet 4.6', 1000000, 128000, caps_adaptive_no_xhigh, 300, 1500, 30, 375, support_no_xhigh, 'claude-standard', true, false, 'available', now()),
    ('anthropic', 'claude-haiku-4-5', 'Claude Haiku 4.5', 200000, 64000, caps_budget_only, 100, 500, 10, 125, support_budget, 'claude-small', true, false, 'available', now()),
    ('anthropic', 'claude-haiku-4-5-20251001', 'Claude Haiku 4.5 (2025-10-01)', 200000, 64000, caps_budget_only, 100, 500, 10, 125, support_budget, 'claude-small', false, false, 'available', now()),
    ('anthropic', 'claude-fable-5', 'Claude Fable 5', 1000000, 128000, caps_adaptive_full, 1000, 5000, 100, 1250, support_full, 'claude-frontier', true, false, 'available', now()),
    ('anthropic', 'claude-sonnet-4-5', 'Claude Sonnet 4.5', 200000, 64000, caps_budget_only, 300, 1500, 30, 375, support_budget, 'claude-standard', false, false, 'available', now()),
    ('anthropic', 'claude-sonnet-4-5-20250929', 'Claude Sonnet 4.5 (2025-09-29)', 200000, 64000, caps_budget_only, 300, 1500, 30, 375, support_budget, 'claude-standard', false, false, 'available', now())
  ON CONFLICT (model_id) DO NOTHING;

  GET DIAGNOSTICS n = ROW_COUNT;
  RAISE NOTICE 'ai_platform_models: seeded % platform model row(s)', n;
END $$;
```

- [ ] **Step 5: Run the seed tests, the migration contract tests and the integration file**

Run:
```bash
cd apps/api && npx vitest run src/db/migrationRlsScope.test.ts src/db/autoMigrate.test.ts src/services/aiModels/__fixtures__/seededPlatformModels.test.ts
pnpm test-stack up && npx vitest run --config vitest.integration.config.ts src/__tests__/integration/aiPlatformModels.integration.test.ts
```

Expected:
- PASS for all of them.
- `migrationRlsScope.test.ts` passes without a baseline entry, because the file elects system scope before its first write. **Never** add this file to that test's frozen baseline.

- [ ] **Step 6: Commit**

```bash
git add apps/api/migrations/2026-11-13-100100-ai-platform-models-seed.sql \
  apps/api/src/services/aiModels/__fixtures__/seededPlatformModels.ts \
  apps/api/src/services/aiModels/__fixtures__/seededPlatformModels.test.ts \
  apps/api/src/__tests__/integration/aiPlatformModels.integration.test.ts
git commit -m "feat(ai): seed ai_platform_models from the W00 price and offer tables (#7599)

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

## Task 9: Platform model service: reads, discovery upsert, admin update, snapshot refresher

**Files:**
- Modify: `apps/api/src/services/aiModels/platformModels.ts` (add the DB functions below the Task 7 mapper)
- Modify: `apps/api/src/services/aiModels/platformModels.test.ts` (refresher unit tests)
- Modify: `apps/api/src/services/aiModel.ts` (add `derivePromptProfile`)
- Create: `apps/api/src/services/aiModel.registry.test.ts`
- Modify: `apps/api/src/index.ts`. Right after the `startRegularMsiCacheWarmer();` call, add the refresher start.
- Modify: `apps/api/src/worker.ts`. Right after the `auditRetryInterval.unref?.();` line, add the refresher start.
- Modify: `apps/api/src/__tests__/integration/aiPlatformModels.integration.test.ts` (service block)

**Interfaces:**
- Consumes:
  - `aiPlatformModels` (Task 6);
  - `PlatformModel`, `toPlatformModel` (Task 7);
  - `setPlatformModelSnapshot` (Task 7);
  - `validatePlatformModelAdminPatch`, `PlatformModelError`, `PlatformModelAdminPatch` (Task 7);
  - `deriveCapabilities`, `deriveOptionSupport`, `mergeDiscoveredOptionSupport` (Task 3);
  - `db`, `withSystemDbAccessContext`, `runOutsideDbContext`, `runAfterDbContextExit` from `../../db`.
- Produces:
  ```ts
  // platformModels.ts — index names in bold
  export async function **listPlatformModels**(): Promise<PlatformModel[]>;
  export async function getPlatformModelById(id: string): Promise<PlatformModel | null>;
  export async function **getPlatformModelByModelId**(modelId: string): Promise<PlatformModel | null>;
  export async function **getPlatformDefaultModel**(): Promise<PlatformModel | null>;
  export async function listOfferableModelIds(): Promise<string[]>;            // platform_offered AND lifecycle = 'available'
  export async function isOfferablePlatformModel(modelId: string): Promise<boolean>;
  export async function listCatalogMappableModelIds(): Promise<string[]>;      // lifecycle <> 'retired'
  export interface DiscoveredModelInput { id: string; displayName: string; maxInputTokens: number | null; maxOutputTokens: number | null; capabilities: unknown }
  export async function **upsertDiscoveredPlatformModel**(apiModel: DiscoveredModelInput, now?: Date): Promise<{ row: PlatformModel; inserted: boolean; previousLifecycle: ModelLifecycle | null }>;
  export async function **updatePlatformModelAdmin**(id: string, patch: PlatformModelAdminPatch, now?: Date): Promise<{ before: PlatformModel; after: PlatformModel }>;
  export async function refreshPlatformModelSnapshot(): Promise<void>;
  export const PLATFORM_MODEL_SNAPSHOT_REFRESH_MS = 60_000;
  export function startPlatformModelSnapshotRefresher(opts?: { intervalMs?: number; load?: () => Promise<PlatformModel[]> }): () => void;
  export { PlatformModelError } from './platformModelAdmin';
  // aiModel.ts
  export function derivePromptProfile(modelId: string): PromptProfile;
  ```
  `DiscoveredModelInput` is structurally the `AnthropicModelInfo` that Task 13's `discoverAnthropicModels` returns.

- [ ] **Step 1: Write the failing unit tests (refresher + prompt profile)**

Append to `apps/api/src/services/aiModels/platformModels.test.ts`. Merge the import lines into the file's existing import block (add `afterEach`, `beforeEach` to the `vitest` import):
```ts
import { afterEach, beforeEach } from 'vitest';
import { startPlatformModelSnapshotRefresher } from './platformModels';
import { clearPlatformModelSnapshot, isPlatformModelSnapshotLoaded, peekPlatformModel } from './platformModelSnapshot';
import { SEEDED_PLATFORM_MODELS } from './__fixtures__/seededPlatformModels';

describe('startPlatformModelSnapshotRefresher', () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => {
    vi.useRealTimers();
    clearPlatformModelSnapshot();
  });

  it('loads immediately, then on every interval, and stops when told', async () => {
    const load = vi.fn(async () => [...SEEDED_PLATFORM_MODELS]);
    const stop = startPlatformModelSnapshotRefresher({ intervalMs: 1_000, load });
    await vi.advanceTimersByTimeAsync(0);
    expect(load).toHaveBeenCalledTimes(1);
    expect(peekPlatformModel('claude-sonnet-5-5')?.isPlatformDefault).toBe(true);
    await vi.advanceTimersByTimeAsync(2_000);
    expect(load).toHaveBeenCalledTimes(3);
    stop();
    await vi.advanceTimersByTimeAsync(5_000);
    expect(load).toHaveBeenCalledTimes(3);
  });

  it('keeps the previous snapshot when a refresh fails', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const load = vi.fn()
      .mockResolvedValueOnce([...SEEDED_PLATFORM_MODELS])
      .mockRejectedValueOnce(new Error('db down'));
    const stop = startPlatformModelSnapshotRefresher({ intervalMs: 1_000, load });
    await vi.advanceTimersByTimeAsync(1_000);
    expect(load).toHaveBeenCalledTimes(2);
    expect(isPlatformModelSnapshotLoaded()).toBe(true);
    expect(peekPlatformModel('claude-opus-4-8')).toBeDefined();
    expect(warn).toHaveBeenCalled();
    stop();
    warn.mockRestore();
  });

  it('a second start while running is a no-op that returns the same stop', async () => {
    const load = vi.fn(async () => []);
    const stopA = startPlatformModelSnapshotRefresher({ intervalMs: 1_000, load });
    const stopB = startPlatformModelSnapshotRefresher({ intervalMs: 1_000, load });
    await vi.advanceTimersByTimeAsync(0);
    expect(load).toHaveBeenCalledTimes(1);
    expect(stopB).toBe(stopA);
    stopA();
  });
});
```

`platformModels.ts` imports `../../db`, which is safe to import in unit tests without a database: the pool is lazy, and these tests inject `load`. If the test runner complains that `DATABASE_URL` is required at import, add `vi.mock('../../db', () => ({ db: {}, withSystemDbAccessContext: vi.fn(), runOutsideDbContext: (fn: () => unknown) => fn(), runAfterDbContextExit: vi.fn() }))` at the top of the file.

```ts
// apps/api/src/services/aiModel.registry.test.ts
import { describe, expect, it } from 'vitest';
import { derivePromptProfile } from './aiModel';
import { SEEDED_PLATFORM_MODELS } from './aiModels/__fixtures__/seededPlatformModels';

describe('derivePromptProfile', () => {
  it.each([
    ['claude-opus-5-5', 'claude-frontier'],
    ['claude-opus-5', 'claude-frontier'],
    ['claude-fable-5-1', 'claude-frontier'],
    ['claude-mythos-5-1', 'claude-frontier'],
    ['claude-opus-4-8', 'claude-standard'],
    ['claude-sonnet-5-5', 'claude-standard'],
    ['claude-sonnet-4-5-20250929', 'claude-standard'],
    ['claude-haiku-4-5', 'claude-small'],
    ['claude-haiku-4-5-20251001', 'claude-small'],
    ['gpt-5', 'generic'],
    ['anthropic/claude-sonnet-5-5', 'generic'],
    ['', 'generic'],
  ] as const)('%j → %s', (modelId, profile) => {
    expect(derivePromptProfile(modelId)).toBe(profile);
  });

  it('agrees with every seeded row', () => {
    for (const model of SEEDED_PLATFORM_MODELS) expect(derivePromptProfile(model.modelId), model.modelId).toBe(model.promptProfile);
  });
});
```

- [ ] **Step 2: Run them and watch them fail**

Run: `cd apps/api && npx vitest run src/services/aiModels/platformModels.test.ts src/services/aiModel.registry.test.ts`

Expected: FAIL. `startPlatformModelSnapshotRefresher` and `derivePromptProfile` are not exported.

- [ ] **Step 3: Implement**

Add to `apps/api/src/services/aiModel.ts`, below `resolveDefaultModel`:
```ts
import type { PromptProfile } from '@breeze/shared';

// AI model registry (spec §5.1 prompt_profile): derived from the id family
// for newly discovered models. The operator can override it on
// /admin/ai-models. aiModel.ts is the one file allowed to hold model-family
// knowledge (index invariant 1).
const CLAUDE_FAMILY_ID = /^claude-(opus|sonnet|haiku|fable|mythos)-(\d{1,2})(?:-|$)/;

export function derivePromptProfile(modelId: string): PromptProfile {
  const match = CLAUDE_FAMILY_ID.exec(modelId);
  if (!match) return 'generic';
  const family = match[1];
  if (family === 'haiku') return 'claude-small';
  if (family === 'fable' || family === 'mythos' || (family === 'opus' && Number(match[2]) >= 5)) return 'claude-frontier';
  return 'claude-standard';
}
```
(The `import type` goes at the top of the file with any other imports.)

Append to `apps/api/src/services/aiModels/platformModels.ts`. Merge these imports into the file's existing import block:
```ts
import { and, asc, eq, ne, sql } from 'drizzle-orm';
import { db, runAfterDbContextExit, runOutsideDbContext, withSystemDbAccessContext } from '../../db';
import { aiPlatformModels } from '../../db/schema';
import { derivePromptProfile } from '../aiModel';
import { deriveCapabilities, deriveOptionSupport, mergeDiscoveredOptionSupport } from './capabilities';
import { validatePlatformModelAdminPatch, type PlatformModelAdminPatch } from './platformModelAdmin';
import { setPlatformModelSnapshot } from './platformModelSnapshot';

export { PlatformModelError } from './platformModelAdmin';
```

Then the functions:
```ts
// ---------------------------------------------------------------------------
// Reads. withSystemDbAccessContext JOINS an ambient request context (no
// second pooled connection) and opens a system one otherwise. The table has
// no RLS, so either scope reads it.
// ---------------------------------------------------------------------------

export async function listPlatformModels(): Promise<PlatformModel[]> {
  return withSystemDbAccessContext(async () => {
    const rows = await db.select().from(aiPlatformModels).orderBy(asc(aiPlatformModels.displayName));
    return rows.map(toPlatformModel);
  }, 'aiModels.list');
}

export async function getPlatformModelById(id: string): Promise<PlatformModel | null> {
  return withSystemDbAccessContext(async () => {
    const [row] = await db.select().from(aiPlatformModels).where(eq(aiPlatformModels.id, id)).limit(1);
    return row ? toPlatformModel(row) : null;
  }, 'aiModels.getById');
}

export async function getPlatformModelByModelId(modelId: string): Promise<PlatformModel | null> {
  return withSystemDbAccessContext(async () => {
    const [row] = await db.select().from(aiPlatformModels).where(eq(aiPlatformModels.modelId, modelId)).limit(1);
    return row ? toPlatformModel(row) : null;
  }, 'aiModels.getByModelId');
}

export async function getPlatformDefaultModel(): Promise<PlatformModel | null> {
  return withSystemDbAccessContext(async () => {
    const [row] = await db.select().from(aiPlatformModels).where(eq(aiPlatformModels.isPlatformDefault, true)).limit(1);
    return row ? toPlatformModel(row) : null;
  }, 'aiModels.getDefault');
}

/** Replaces OFFERABLE_AI_MODELS: offered on the platform key and currently served (spec §8). */
export async function listOfferableModelIds(): Promise<string[]> {
  return withSystemDbAccessContext(async () => {
    const rows = await db
      .select({ modelId: aiPlatformModels.modelId })
      .from(aiPlatformModels)
      .where(and(eq(aiPlatformModels.platformOffered, true), eq(aiPlatformModels.lifecycle, 'available')))
      .orderBy(asc(aiPlatformModels.modelId));
    return rows.map((row) => row.modelId);
  }, 'aiModels.listOfferable');
}

export async function isOfferablePlatformModel(modelId: string): Promise<boolean> {
  return withSystemDbAccessContext(async () => {
    const rows = await db
      .select({ id: aiPlatformModels.id })
      .from(aiPlatformModels)
      .where(and(
        eq(aiPlatformModels.modelId, modelId),
        eq(aiPlatformModels.platformOffered, true),
        eq(aiPlatformModels.lifecycle, 'available'),
      ))
      .limit(1);
    return rows.length > 0;
  }, 'aiModels.isOfferable');
}

/** Logical ids a catalog revision's model_map may key (spec §6): any registry model that is not retired. */
export async function listCatalogMappableModelIds(): Promise<string[]> {
  return withSystemDbAccessContext(async () => {
    const rows = await db
      .select({ modelId: aiPlatformModels.modelId })
      .from(aiPlatformModels)
      .where(ne(aiPlatformModels.lifecycle, 'retired'))
      .orderBy(asc(aiPlatformModels.modelId));
    return rows.map((row) => row.modelId);
  }, 'aiModels.listCatalogMappable');
}

// ---------------------------------------------------------------------------
// Writes: discovery (system scope) and /admin/ai-models (platform admin + MFA).
// ---------------------------------------------------------------------------

export interface DiscoveredModelInput {
  id: string;
  displayName: string;
  maxInputTokens: number | null;
  maxOutputTokens: number | null;
  capabilities: unknown;
}

/**
 * Discovery upsert (spec §6). Never touches prices, option rates,
 * platform_offered, is_platform_default, min_plan or prompt_profile on an
 * existing row. A new row lands unpriced and unoffered. Marks the row seen
 * now: lifecycle 'available', missed counter reset.
 */
export async function upsertDiscoveredPlatformModel(
  apiModel: DiscoveredModelInput,
  now: Date = new Date(),
): Promise<{ row: PlatformModel; inserted: boolean; previousLifecycle: ModelLifecycle | null }> {
  return withSystemDbAccessContext(async () => {
    const [existingRow] = await db
      .select()
      .from(aiPlatformModels)
      .where(eq(aiPlatformModels.modelId, apiModel.id))
      .for('update')
      .limit(1);

    if (!existingRow) {
      const derived = deriveCapabilities(apiModel.capabilities);
      const [inserted] = await db.insert(aiPlatformModels).values({
        provider: 'anthropic',
        modelId: apiModel.id,
        displayName: apiModel.displayName.trim() || apiModel.id,
        maxInputTokens: apiModel.maxInputTokens,
        maxOutputTokens: apiModel.maxOutputTokens,
        capabilities: apiModel.capabilities ?? null,
        optionSupport: deriveOptionSupport(derived),
        promptProfile: derivePromptProfile(apiModel.id),
        lifecycle: 'available',
        missedSyncCount: 0,
        firstSeenAt: now,
        lastSeenAt: now,
        updatedAt: now,
      }).returning();
      return { row: toPlatformModel(inserted!), inserted: true, previousLifecycle: null };
    }

    const existing = toPlatformModel(existingRow);
    // A listing without capabilities never erases a tree we already hold.
    const capabilities = apiModel.capabilities ?? existing.capabilities;
    const [updated] = await db.update(aiPlatformModels).set({
      displayName: apiModel.displayName.trim() || existing.displayName,
      maxInputTokens: apiModel.maxInputTokens ?? existing.maxInputTokens,
      maxOutputTokens: apiModel.maxOutputTokens ?? existing.maxOutputTokens,
      capabilities,
      optionSupport: mergeDiscoveredOptionSupport(existing.optionSupport, deriveCapabilities(capabilities)),
      lifecycle: 'available',
      missedSyncCount: 0,
      lastSeenAt: now,
      updatedAt: now,
    }).where(eq(aiPlatformModels.id, existing.id)).returning();
    return { row: toPlatformModel(updated!), inserted: false, previousLifecycle: existing.lifecycle };
  }, 'aiModels.upsertDiscovered');
}

/**
 * /admin/ai-models patch. Validates against the locked current row, swaps
 * the platform default atomically (clear the old one, then set the new one,
 * in one transaction), and refreshes this process's snapshot once the
 * transaction settles.
 */
export async function updatePlatformModelAdmin(
  id: string,
  patch: PlatformModelAdminPatch,
  now: Date = new Date(),
): Promise<{ before: PlatformModel; after: PlatformModel }> {
  return withSystemDbAccessContext(async () => {
    const [row] = await db.select().from(aiPlatformModels).where(eq(aiPlatformModels.id, id)).for('update').limit(1);
    if (!row) throw new PlatformModelError('Platform model not found.', 404);
    const before = toPlatformModel(row);
    const next = validatePlatformModelAdminPatch(before, patch);

    if (next.isPlatformDefault && !before.isPlatformDefault) {
      await db.update(aiPlatformModels)
        .set({ isPlatformDefault: false, updatedAt: now })
        .where(and(eq(aiPlatformModels.isPlatformDefault, true), ne(aiPlatformModels.id, id)));
    }

    const [updated] = await db.update(aiPlatformModels).set({
      inputCentsPerM: next.rates?.inputCentsPerM ?? null,
      outputCentsPerM: next.rates?.outputCentsPerM ?? null,
      cacheReadCentsPerM: next.rates?.cacheReadCentsPerM ?? null,
      cacheWriteCentsPerM: next.rates?.cacheWriteCentsPerM ?? null,
      optionRates: next.optionRates,
      optionSupport: next.optionSupport,
      minPlan: next.minPlan,
      promptProfile: next.promptProfile,
      platformOffered: next.platformOffered,
      isPlatformDefault: next.isPlatformDefault,
      updatedAt: now,
    }).where(eq(aiPlatformModels.id, id)).returning();

    runAfterDbContextExit('aiModels.snapshotRefresh', () => refreshPlatformModelSnapshot());
    return { before, after: toPlatformModel(updated!) };
  }, 'aiModels.updateAdmin');
}

// ---------------------------------------------------------------------------
// In-process snapshot (platformModelSnapshot.ts) for synchronous hot paths.
// ---------------------------------------------------------------------------

export const PLATFORM_MODEL_SNAPSHOT_REFRESH_MS = 60_000;

export async function refreshPlatformModelSnapshot(): Promise<void> {
  setPlatformModelSnapshot(await listPlatformModels());
}

let refresher: { timer: ReturnType<typeof setInterval>; stop: () => void } | null = null;

/**
 * Started once at boot by index.ts and worker.ts. Loads immediately, then
 * every interval. A failed load keeps the previous snapshot. Ticks run
 * outside any DB context.
 */
export function startPlatformModelSnapshotRefresher(
  opts: { intervalMs?: number; load?: () => Promise<PlatformModel[]> } = {},
): () => void {
  if (refresher) return refresher.stop;
  const load = opts.load ?? listPlatformModels;
  const tick = (): void => {
    void runOutsideDbContext(async () => {
      try {
        setPlatformModelSnapshot(await load());
      } catch (error) {
        console.warn('[aiModels] platform model snapshot refresh failed; keeping the previous snapshot:', error);
      }
    });
  };
  const timer = setInterval(tick, opts.intervalMs ?? PLATFORM_MODEL_SNAPSHOT_REFRESH_MS);
  timer.unref?.();
  const stop = (): void => {
    clearInterval(timer);
    refresher = null;
  };
  refresher = { timer, stop };
  tick();
  return stop;
}
```

Wire the refresher at boot:

`apps/api/src/index.ts`. Add the import next to the other service imports:
```ts
import { startPlatformModelSnapshotRefresher } from './services/aiModels/platformModels';
```
Directly after `startRegularMsiCacheWarmer();`:
```ts
  // AI model registry W01 (#7599): keep the in-process ai_platform_models
  // snapshot warm for the synchronous hot paths (Agent SDK thinking options,
  // token-price fallback). Not awaited; until the first load lands, those
  // paths use the W00 bootstrap rules.
  startPlatformModelSnapshotRefresher();
```

`apps/api/src/worker.ts`. Add the same import. Directly after `auditRetryInterval.unref?.();`:
```ts
  // AI model registry W01 (#7599): same snapshot as the API process. Agent
  // runs and the cost tracker run here too.
  startPlatformModelSnapshotRefresher();
```

- [ ] **Step 4: Run the unit tests and watch them pass**

Run: `cd apps/api && npx vitest run src/services/aiModels/platformModels.test.ts src/services/aiModel.registry.test.ts`

Expected: PASS.

- [ ] **Step 5: Write the failing service integration test**

Append to `apps/api/src/__tests__/integration/aiPlatformModels.integration.test.ts`. Extend the imports:
```ts
import {
  PlatformModelError,
  getPlatformDefaultModel,
  getPlatformModelByModelId,
  isOfferablePlatformModel,
  listCatalogMappableModelIds,
  listOfferableModelIds,
  refreshPlatformModelSnapshot,
  updatePlatformModelAdmin,
  upsertDiscoveredPlatformModel,
} from '../../services/aiModels/platformModels';
import { clearPlatformModelSnapshot, peekPlatformDefaultModelId, peekPlatformModel } from '../../services/aiModels/platformModelSnapshot';
```

Then the block (it reuses `Rollback` and `SEEDED_IDS` from the Task 8 block):
```ts
describe('platform model service (W01 #7599)', () => {
  const ADAPTIVE_CAPS = {
    thinking: { supported: true, types: { adaptive: { supported: true }, enabled: { supported: false } } },
    effort: { supported: true, low: { supported: true }, medium: { supported: true }, high: { supported: true }, xhigh: { supported: false }, max: { supported: true } },
  };

  runDb('offerable ids equal W00 OFFERABLE_AI_MODELS on a seeded database', async () => {
    expect((await listOfferableModelIds()).filter((id) => SEEDED_IDS.includes(id)).sort())
      .toEqual([...W00_OFFERABLE_AI_MODELS].sort());
    expect(await isOfferablePlatformModel('claude-sonnet-5-5')).toBe(true);
    expect(await isOfferablePlatformModel('claude-sonnet-4-5')).toBe(false); // priced, never offered
    expect(await isOfferablePlatformModel('no-such-model')).toBe(false);
  });

  runDb('catalog-mappable ids include every seeded id, and the default is Sonnet 5.5', async () => {
    expect(await listCatalogMappableModelIds()).toEqual(expect.arrayContaining(SEEDED_IDS));
    expect((await getPlatformDefaultModel())?.modelId).toBe('claude-sonnet-5-5');
  });

  runDb('a newly discovered model lands unpriced, unoffered, with derived support', async () => {
    const modelId = `w01-test-${randomUUID()}`;
    await expect(withSystemDbAccessContext(async () => {
      const result = await upsertDiscoveredPlatformModel({ id: modelId, displayName: 'New', maxInputTokens: 1000, maxOutputTokens: 100, capabilities: ADAPTIVE_CAPS });
      expect(result.inserted).toBe(true);
      expect(result.row).toMatchObject({
        rates: null, platformOffered: false, isPlatformDefault: false, lifecycle: 'available', promptProfile: 'generic',
        optionSupport: { effort: ['low', 'medium', 'high', 'max'], thinkingDisplay: ['omitted', 'summarized'], speed: ['standard'], inferenceGeo: [] },
      });
      expect(result.row.lastSeenAt).not.toBeNull();
      throw new Rollback();
    })).rejects.toBeInstanceOf(Rollback);
  });

  runDb('rediscovering a seeded model never changes its price, offer, default or operator-set options', async () => {
    await expect(withSystemDbAccessContext(async () => {
      const before = (await getPlatformModelByModelId('claude-opus-5-5'))!;
      const result = await upsertDiscoveredPlatformModel({
        id: 'claude-opus-5-5', displayName: 'Claude Opus 5.5', maxInputTokens: 1_000_000, maxOutputTokens: 128_000, capabilities: ADAPTIVE_CAPS,
      });
      expect(result.inserted).toBe(false);
      expect(result.row.rates).toEqual(before.rates);
      expect(result.row.platformOffered).toBe(true);
      expect(result.row.isPlatformDefault).toBe(false);
      expect(result.row.promptProfile).toBe('claude-frontier');
      expect(result.row.capabilities).toEqual(ADAPTIVE_CAPS);
      // API owns effort (xhigh dropped by the new tree); the operator's updates + fast survive.
      expect(result.row.optionSupport).toEqual({
        effort: ['low', 'medium', 'high', 'max'], thinkingDisplay: ['omitted', 'summarized', 'updates'], speed: ['standard', 'fast'], inferenceGeo: [],
      });
      throw new Rollback();
    })).rejects.toBeInstanceOf(Rollback);
  });

  runDb('making another model the default swaps atomically, leaving exactly one', async () => {
    await expect(withSystemDbAccessContext(async () => {
      const opus = (await getPlatformModelByModelId('claude-opus-5-5'))!;
      const { after } = await updatePlatformModelAdmin(opus.id, { isPlatformDefault: true });
      expect(after.isPlatformDefault).toBe(true);
      const defaults = await db.select({ modelId: aiPlatformModels.modelId }).from(aiPlatformModels).where(sql`is_platform_default`);
      expect(defaults).toEqual([{ modelId: 'claude-opus-5-5' }]);
      throw new Rollback();
    })).rejects.toBeInstanceOf(Rollback);
  });

  runDb('rejects un-defaulting the current default with a 409 and changes nothing', async () => {
    const sonnet = (await getPlatformModelByModelId('claude-sonnet-5-5'))!;
    await expect(updatePlatformModelAdmin(sonnet.id, { isPlatformDefault: false }))
      .rejects.toMatchObject({ name: 'PlatformModelError', status: 409 });
    expect((await getPlatformDefaultModel())?.modelId).toBe('claude-sonnet-5-5');
  });

  runDb('a price edit persists and refreshes the snapshot', async () => {
    clearPlatformModelSnapshot();
    await expect(withSystemDbAccessContext(async () => {
      const haiku = (await getPlatformModelByModelId('claude-haiku-4-5'))!;
      const { after } = await updatePlatformModelAdmin(haiku.id, {
        rates: { inputCentsPerM: 80, outputCentsPerM: 400, cacheReadCentsPerM: 8, cacheWriteCentsPerM: 100 },
      });
      expect(after.rates?.inputCentsPerM).toBe(80);
      throw new Rollback();
    })).rejects.toBeInstanceOf(Rollback);
    await refreshPlatformModelSnapshot();
    expect(peekPlatformModel('claude-haiku-4-5')?.rates?.inputCentsPerM).toBe(100); // rolled back
    expect(peekPlatformDefaultModelId()).toBe('claude-sonnet-5-5');
    clearPlatformModelSnapshot();
  });

  runDb('PlatformModelError is a 404 for an unknown id', async () => {
    await expect(updatePlatformModelAdmin(randomUUID(), { minPlan: null })).rejects.toBeInstanceOf(PlatformModelError);
  });
});
```

- [ ] **Step 6: Run the integration file and watch the new block pass**

Run: `cd apps/api && npx vitest run --config vitest.integration.config.ts src/__tests__/integration/aiPlatformModels.integration.test.ts`

Expected: PASS (all three describe blocks). If "rediscovering a seeded model" fails on `optionSupport`, compare against `mergeDiscoveredOptionSupport` (Task 3). That function is the contract; the test is not.

- [ ] **Step 7: Commit**

```bash
git add apps/api/src/services/aiModels/platformModels.ts apps/api/src/services/aiModels/platformModels.test.ts \
  apps/api/src/services/aiModel.ts apps/api/src/services/aiModel.registry.test.ts \
  apps/api/src/index.ts apps/api/src/worker.ts \
  apps/api/src/__tests__/integration/aiPlatformModels.integration.test.ts
git commit -m "feat(ai): platform model service: reads, discovery upsert, admin update, snapshot refresher (#7599)

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

## Task 10: Registry-driven wire options; delete `aiModelThinking.ts` and repoint its eight callers

W00 decided thinking/effort from the model id's name. W01 decides them from the platform row's capabilities and `option_support`, read from the in-process snapshot, which is synchronous like the code it replaces. W00's exact rules move into `services/aiModel.ts` as the bootstrap fallback, used for any of:
- a cold snapshot;
- an id with no row (catalog wire ids such as `anthropic/…`, BYO gateways, `ANTHROPIC_MODEL` overrides);
- a row whose capabilities derive to `unknown`.

The surface default stays W00's effort `medium`. W03 replaces it with the assignment's options.

Callers (all from #7593):

| Transport | File | W00 call | W01 call |
|---|---|---|---|
| Agent SDK `query()` | `services/streamingSessionManager.ts` (~L1319) | `...resolveModelThinking(wire.model)` | `...agentSdkWireOptions(wire.model)` |
| Agent SDK `query()` | `services/aiAgents/runLoop.ts` (~L2133) | `...resolveModelThinking(model)` | `...agentSdkWireOptions(model)` |
| Agent SDK `query()` | `services/llm/providerFidelityHarness.ts` (~L474) | `...resolveModelThinking(input.providerModel)` | `...agentSdkWireOptions(input.providerModel)` |
| Agent SDK `query()` | `services/llm/toolCapture/runSurface.ts` (~L206) | `...resolveModelThinking(opts.model)` | `...agentSdkWireOptions(opts.model)` |
| Messages API one-shot | `services/scriptProposals/reviewer.ts` (~L423) | `...resolveMessagesApiThinking(wireModel)` | `...messagesApiWireOptions(wireModel, SCRIPT_REVIEW_MAX_OUTPUT_TOKENS)` |
| Messages API one-shot | `services/aiTicketDraft.ts` (~L125) | `...resolveMessagesApiThinking(wireModel)` | `...messagesApiWireOptions(wireModel, maxTokens)` |
| Messages API one-shot | `services/officeAddin/aiEmailDraft.ts` (~L150) | `...resolveMessagesApiThinking(wireModel)` | `...messagesApiWireOptions(wireModel, maxTokens)` |
| Messages API one-shot | `services/aiPatchTestRunner.ts` (~L119) | `...resolveMessagesApiThinking(model)` | `...messagesApiWireOptions(model, PATCH_ANALYSIS_MAX_TOKENS)` |

**Files:**
- Create: `apps/api/src/services/aiModels/modelWireOptions.ts`
- Create: `apps/api/src/services/aiModels/modelWireOptions.test.ts`
- Modify: `apps/api/src/services/aiModel.ts` (W00 rules → `legacyWireProfile`, `legacyThinksWhenOmitted`; header comment)
- Modify: the eight call-site files in the table above
- Modify: `apps/api/src/services/aiAgents/runLoop.test.ts` (~L1775, test title only)
- Modify: `apps/api/src/services/llm/__scripts__/tool-eval.test.ts`, `apps/api/src/services/llm/llmConfigResolver.test.ts`, `apps/api/src/services/partnerLlmConfig.test.ts` (their partial `aiModel` mocks spread the real module)
- Delete: `apps/api/src/services/aiModelThinking.ts`, `apps/api/src/services/aiModelThinking.test.ts`

**Interfaces:**
- Consumes:
  - `buildWireParams`, `toAgentSdkOptions`, `toMessagesApiParams`, `AgentSdkThinkingOptions`, `MessagesApiThinkingParams` (Task 4);
  - `deriveCapabilities`, `ThinkingMode` (Task 3);
  - `peekPlatformModel` (Task 7);
  - `SEEDED_PLATFORM_MODELS`, `seededPlatformModel` (Task 8, tests).
- Produces:
  ```ts
  // aiModel.ts (bootstrap; W03 replaces the callers)
  export function legacyWireProfile(modelId: string): { thinkingMode: ThinkingMode; optionSupport: OptionSupport };
  export function legacyThinksWhenOmitted(modelId: string): boolean;
  // aiModels/modelWireOptions.ts
  export const W01_SURFACE_DEFAULT_OPTIONS: Readonly<OfferingOptions>; // { effort: 'medium' }
  export interface ModelWireProfile { thinkingMode: ThinkingMode; optionSupport: OptionSupport; source: 'registry' | 'legacy' }
  export function modelWireProfile(modelId: string): ModelWireProfile;
  export function agentSdkWireOptions(modelId: string, requested?: OfferingOptions): AgentSdkThinkingOptions;
  export function messagesApiWireOptions(modelId: string, maxTokens: number, requested?: OfferingOptions): MessagesApiThinkingParams;
  ```

- [ ] **Step 1: Write the failing test (every W00 row, cold and registry-backed, plus the registry-only cases)**

```ts
// apps/api/src/services/aiModels/modelWireOptions.test.ts
import { afterEach, describe, expect, it, vi } from 'vitest';
import { clearPlatformModelSnapshot, setPlatformModelSnapshot } from './platformModelSnapshot';
import { SEEDED_PLATFORM_MODELS, seededPlatformModel } from './__fixtures__/seededPlatformModels';
import { agentSdkWireOptions, messagesApiWireOptions, modelWireProfile } from './modelWireOptions';

const ADAPTIVE_MEDIUM = { thinking: { type: 'adaptive' }, effort: 'medium' };
const DISABLED = { thinking: { type: 'disabled' } };
const ONE_SHOT_CAPPED = { thinking: { type: 'adaptive' }, output_config: { effort: 'medium' } };
const ADAPTIVE_CAPS = {
  thinking: { supported: true, types: { adaptive: { supported: true }, enabled: { supported: false } } },
  effort: { supported: true, low: { supported: true }, medium: { supported: true }, high: { supported: true }, xhigh: { supported: true }, max: { supported: true } },
};

// Every row of W00's aiModelThinking.test.ts (#7587), unchanged.
const W00_AGENT_ADAPTIVE = [
  'claude-sonnet-5-5', 'claude-opus-5-5', 'claude-fable-5-1', 'claude-fable-5', 'claude-opus-5', 'claude-sonnet-5',
  'claude-opus-4-8', 'claude-opus-4-7', 'claude-opus-4-6', 'claude-sonnet-4-6', 'claude-opus-4-6-20260101',
];
const W00_AGENT_DISABLED = [
  'claude-haiku-4-5', 'claude-haiku-4-5-20251001',
  'claude-sonnet-4-5', 'claude-sonnet-4-5-20250929', 'claude-opus-4-5', 'claude-opus-4-1', 'claude-sonnet-4-0',
  'my-vllm-model', 'anthropic/claude-sonnet-5-5', 'us.anthropic.claude-sonnet-5-5', 'claude-sonnet-5-5-custom', 'gpt-5', '',
];
const W00_ONE_SHOT_CAPPED = ['claude-sonnet-5-5', 'claude-opus-5-5', 'claude-fable-5-1', 'claude-fable-5', 'claude-opus-5'];
const W00_ONE_SHOT_NOTHING = [
  'claude-sonnet-4-6', 'claude-opus-4-8', 'claude-opus-4-6', 'claude-haiku-4-5', 'claude-sonnet-4-5',
  'anthropic/claude-sonnet-5-5', 'my-vllm-model',
];

afterEach(() => clearPlatformModelSnapshot());

describe.each([
  ['cold snapshot (W00 bootstrap rules)', () => clearPlatformModelSnapshot()],
  ['registry = seed', () => setPlatformModelSnapshot(SEEDED_PLATFORM_MODELS)],
] as const)('W00 parity: %s', (_label, arrange) => {
  it.each(W00_AGENT_ADAPTIVE)('agentSdkWireOptions(%s) → adaptive + effort medium, never disabled', (model) => {
    arrange();
    expect(agentSdkWireOptions(model)).toEqual(ADAPTIVE_MEDIUM);
  });

  // Haiku 4.5: an omitted thinking option lets the SDK CLI turn thinking ON (~11x tokens, #7587).
  it.each(W00_AGENT_DISABLED)('agentSdkWireOptions(%j) → thinking disabled, never omitted, no effort', (model) => {
    arrange();
    const out = agentSdkWireOptions(model);
    expect(out).toEqual(DISABLED);
    expect('effort' in out).toBe(false);
  });

  it.each(W00_ONE_SHOT_CAPPED)('messagesApiWireOptions(%s) → adaptive + output_config.effort medium', (model) => {
    arrange();
    expect(messagesApiWireOptions(model, 512)).toEqual(ONE_SHOT_CAPPED);
  });

  it.each(W00_ONE_SHOT_NOTHING)('messagesApiWireOptions(%s) → nothing (one-shots only ever reduce thinking)', (model) => {
    arrange();
    expect(messagesApiWireOptions(model, 512)).toEqual({});
  });
});

describe('registry-driven behaviour (W01)', () => {
  it('the registry decides for an id the W00 name rules do not know', () => {
    setPlatformModelSnapshot([{ ...seededPlatformModel('claude-sonnet-5-5'), modelId: 'vendor-model-x', isPlatformDefault: false, capabilities: ADAPTIVE_CAPS }]);
    expect(modelWireProfile('vendor-model-x').source).toBe('registry');
    expect(agentSdkWireOptions('vendor-model-x')).toEqual(ADAPTIVE_MEDIUM);
  });

  it('the registry beats the name rules (capabilities, not names, decide)', () => {
    setPlatformModelSnapshot([{ ...seededPlatformModel('claude-haiku-4-5'), capabilities: ADAPTIVE_CAPS,
      optionSupport: { effort: ['low', 'medium', 'high', 'xhigh', 'max'], thinkingDisplay: ['omitted', 'summarized'], speed: ['standard'], inferenceGeo: [] } }]);
    expect(agentSdkWireOptions('claude-haiku-4-5')).toEqual(ADAPTIVE_MEDIUM);
  });

  it('an operator-narrowed effort list drops effort (adaptive stays; warns once)', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    setPlatformModelSnapshot([{ ...seededPlatformModel('claude-sonnet-5-5'),
      optionSupport: { effort: ['low', 'high'], thinkingDisplay: ['omitted'], speed: ['standard'], inferenceGeo: [] } }]);
    expect(agentSdkWireOptions('claude-sonnet-5-5')).toEqual({ thinking: { type: 'adaptive' } });
    agentSdkWireOptions('claude-sonnet-5-5');
    expect(warn).toHaveBeenCalledTimes(1);
    warn.mockRestore();
  });

  it('a row whose capabilities derive to unknown falls back to the W00 rules: Sonnet 5.5 never receives disabled', () => {
    setPlatformModelSnapshot([{ ...seededPlatformModel('claude-sonnet-5-5'), capabilities: null }]);
    expect(modelWireProfile('claude-sonnet-5-5').source).toBe('legacy');
    expect(agentSdkWireOptions('claude-sonnet-5-5')).toEqual(ADAPTIVE_MEDIUM);
  });

  it('an explicit request overrides the surface default', () => {
    setPlatformModelSnapshot(SEEDED_PLATFORM_MODELS);
    expect(agentSdkWireOptions('claude-opus-5-5', { effort: 'xhigh' })).toEqual({ thinking: { type: 'adaptive' }, effort: 'xhigh' });
  });

  it('returns a fresh object per call (callers spread it)', () => {
    expect(agentSdkWireOptions('claude-sonnet-5-5')).not.toBe(agentSdkWireOptions('claude-sonnet-5-5'));
  });
});
```

- [ ] **Step 2: Run it and watch it fail**

Run: `cd apps/api && npx vitest run src/services/aiModels/modelWireOptions.test.ts`

Expected: FAIL with `Failed to resolve import "./modelWireOptions"`.

- [ ] **Step 3: Move the W00 rules into `aiModel.ts`**

Replace the header comment of `apps/api/src/services/aiModel.ts`, which references `resolveModelThinking (aiModelThinking.ts)`, with:
```ts
// Platform default model and the W01 bootstrap rules for models the registry
// (ai_platform_models) does not describe. A stale id makes the Claude Agent
// SDK report total_cost_usd: 0 (issue #1326). #7587 moved the default to
// Sonnet 5.5, which rejects `thinking: disabled`; thinking params are now
// built by services/aiModels/wireParams.ts.
//
// This is the ONE file outside the registry seed and test fixtures that may
// hold model-family knowledge (index invariant 1).
```

Append, merging the two `import type` lines into the top of the file:
```ts
import type { OptionSupport } from '@breeze/shared';
import type { ThinkingMode } from './aiModels/capabilities';

// ---------------------------------------------------------------------------
// W00 (#7587) bootstrap rules, moved verbatim from the deleted
// aiModelThinking.ts. Used only when the registry can't answer:
// - a cold snapshot;
// - an unregistered id (catalog wire ids, BYO gateways, ANTHROPIC_MODEL);
// - a row whose capabilities derive to 'unknown'.
// W03's resolveModel removes the remaining callers.
// ---------------------------------------------------------------------------

// `claude-<family>-<major>[-<minor>][-<YYYYMMDD>]`: the minor is 1–2 digits and
// a dated snapshot suffix is exactly 8, so `claude-opus-4-6-20260101` parses as
// Opus 4.6 and nothing else can ride in on a trailing segment.
const FIRST_PARTY_MODEL_ID = /^claude-(opus|sonnet|haiku|fable)-(\d{1,2})(?:-(\d{1,2}))?(?:-\d{8})?$/;

/**
 * Fable 5.x, Opus/Sonnet 5+, Opus 4.6–4.8 and Sonnet 4.6 run adaptive thinking.
 * Effort excludes `xhigh`, which 4.6 rejects. Every other first-party id
 * (Haiku 4.5, Opus/Sonnet ≤ 4.5) is `budget`, so thinking is explicitly
 * off. Anything else is `unknown`, which also becomes an explicit off on the
 * Agent SDK, exactly as W00 sent.
 */
export function legacyWireProfile(modelId: string): { thinkingMode: ThinkingMode; optionSupport: OptionSupport } {
  const match = FIRST_PARTY_MODEL_ID.exec(modelId);
  if (!match) {
    return { thinkingMode: 'unknown', optionSupport: { effort: [], thinkingDisplay: [], speed: ['standard'], inferenceGeo: [] } };
  }
  const family = match[1];
  const major = Number(match[2]);
  const minor = match[3] === undefined ? 0 : Number(match[3]);
  const adaptive = family === 'fable'
    || ((family === 'opus' || family === 'sonnet') && (major >= 5 || (major === 4 && minor >= 6)));
  return adaptive
    ? {
      thinkingMode: 'adaptive',
      optionSupport: { effort: ['low', 'medium', 'high', 'max'], thinkingDisplay: ['omitted', 'summarized'], speed: ['standard'], inferenceGeo: [] },
    }
    : { thinkingMode: 'budget', optionSupport: { effort: [], thinkingDisplay: [], speed: ['standard'], inferenceGeo: [] } };
}

/**
 * Whether the Messages API thinks when the `thinking` param is omitted:
 * Fable and Opus/Sonnet 5+ do; Opus/Sonnet 4.6–4.8 do not. The Models API
 * doesn't expose this, so W01 keeps W00's rule for the one-shot "only
 * reduce thinking" gate. W03 replaces it with per-surface assignment options.
 */
export function legacyThinksWhenOmitted(modelId: string): boolean {
  const match = FIRST_PARTY_MODEL_ID.exec(modelId);
  if (!match) return false;
  const family = match[1];
  return family === 'fable' || ((family === 'opus' || family === 'sonnet') && Number(match[2]) >= 5);
}
```

- [ ] **Step 4: Implement `modelWireOptions.ts`**

```ts
// apps/api/src/services/aiModels/modelWireOptions.ts
/**
 * AI model registry W01 (#7599): per-model thinking/effort options for the
 * eight call sites that used W00's aiModelThinking.ts. Synchronous, because
 * those call sites build `query()` / `messages.create()` options inline. It
 * reads the in-process registry snapshot (platformModelSnapshot.ts).
 *
 * A row with known capabilities decides. Otherwise the W00 rules in
 * aiModel.ts apply: cold snapshot, unregistered id, or capabilities that
 * derive to `unknown`. The params themselves are always built by
 * buildWireParams (index invariant 2).
 *
 * W03's resolveModel supersedes this with assignment options and per-offering
 * capabilities.
 */
import type { OfferingOptions, OptionSupport } from '@breeze/shared';
import { legacyThinksWhenOmitted, legacyWireProfile } from '../aiModel';
import { deriveCapabilities, type ThinkingMode } from './capabilities';
import { peekPlatformModel } from './platformModelSnapshot';
import {
  buildWireParams,
  toAgentSdkOptions,
  toMessagesApiParams,
  type AgentSdkThinkingOptions,
  type MessagesApiThinkingParams,
} from './wireParams';

/** W00's per-surface default, kept until W03 assignments carry options. */
export const W01_SURFACE_DEFAULT_OPTIONS: Readonly<OfferingOptions> = Object.freeze({ effort: 'medium' });

/** `query()` takes no max_tokens; budget thinking (the only consumer) is off in v1. Validation only. */
const AGENT_SDK_NOMINAL_MAX_TOKENS = 32_000;

export interface ModelWireProfile {
  thinkingMode: ThinkingMode;
  optionSupport: OptionSupport;
  source: 'registry' | 'legacy';
}

export function modelWireProfile(modelId: string): ModelWireProfile {
  const row = peekPlatformModel(modelId);
  if (row) {
    const { thinkingMode } = deriveCapabilities(row.capabilities);
    if (thinkingMode !== 'unknown') return { thinkingMode, optionSupport: row.optionSupport, source: 'registry' };
  }
  const legacy = legacyWireProfile(modelId);
  return { thinkingMode: legacy.thinkingMode, optionSupport: legacy.optionSupport, source: 'legacy' };
}

const warnedDrops = new Set<string>();

/** Spec §7: an empty intersection at runtime omits the param and logs a warning (once per model + value). */
function warnOnDroppedEffort(modelId: string, profile: ModelWireProfile, requested: OfferingOptions, applied: OfferingOptions): void {
  if (profile.thinkingMode !== 'adaptive' || !requested.effort || applied.effort === requested.effort) return;
  const key = `${modelId}:${requested.effort}`;
  if (warnedDrops.has(key)) return;
  warnedDrops.add(key);
  console.warn(`[aiModels] ${modelId} does not support effort "${requested.effort}"; sending no effort`);
}

export function agentSdkWireOptions(
  modelId: string,
  requested: OfferingOptions = W01_SURFACE_DEFAULT_OPTIONS,
): AgentSdkThinkingOptions {
  const profile = modelWireProfile(modelId);
  const wire = buildWireParams({
    thinkingMode: profile.thinkingMode,
    optionSupport: profile.optionSupport,
    requested,
    maxTokens: AGENT_SDK_NOMINAL_MAX_TOKENS,
  });
  warnOnDroppedEffort(modelId, profile, requested, wire.applied);
  return toAgentSdkOptions(wire);
}

export function messagesApiWireOptions(
  modelId: string,
  maxTokens: number,
  requested: OfferingOptions = W01_SURFACE_DEFAULT_OPTIONS,
): MessagesApiThinkingParams {
  const profile = modelWireProfile(modelId);
  const wire = buildWireParams({
    thinkingMode: profile.thinkingMode,
    optionSupport: profile.optionSupport,
    requested,
    maxTokens,
  });
  warnOnDroppedEffort(modelId, profile, requested, wire.applied);
  return toMessagesApiParams(wire, { thinksWhenOmitted: legacyThinksWhenOmitted(modelId) });
}
```

- [ ] **Step 5: Run the new test and watch it pass**

Run: `cd apps/api && npx vitest run src/services/aiModels/modelWireOptions.test.ts`

Expected: PASS (every W00 row, in both describe arms).

- [ ] **Step 6: Repoint the eight callers and delete `aiModelThinking.ts`**

In each file below, replace the import line and the spread exactly as shown, then update the adjacent `#7587` comment to name `agentSdkWireOptions` / `messagesApiWireOptions`.

- `services/streamingSessionManager.ts`:
  - import: `import { resolveModelThinking } from './aiModelThinking';` → `import { agentSdkWireOptions } from './aiModels/modelWireOptions';`
  - spread: `...resolveModelThinking(wire.model),` → `...agentSdkWireOptions(wire.model),`
- `services/aiAgents/runLoop.ts`:
  - import: `import { resolveModelThinking } from '../aiModelThinking';` → `import { agentSdkWireOptions } from '../aiModels/modelWireOptions';`
  - spread: `...resolveModelThinking(model),` → `...agentSdkWireOptions(model),`
- `services/llm/providerFidelityHarness.ts`:
  - import: `import { resolveModelThinking } from '../aiModelThinking';` → `import { agentSdkWireOptions } from '../aiModels/modelWireOptions';`
  - spread: `...resolveModelThinking(input.providerModel),` → `...agentSdkWireOptions(input.providerModel),`
- `services/llm/toolCapture/runSurface.ts`:
  - import: `import { resolveModelThinking } from '../../aiModelThinking';` → `import { agentSdkWireOptions } from '../../aiModels/modelWireOptions';`
  - spread: `...resolveModelThinking(opts.model),` → `...agentSdkWireOptions(opts.model),`
- `services/scriptProposals/reviewer.ts`:
  - import: `import { resolveMessagesApiThinking } from '../aiModelThinking';` → `import { messagesApiWireOptions } from '../aiModels/modelWireOptions';`
  - spread: `...resolveMessagesApiThinking(wireModel),` → `...messagesApiWireOptions(wireModel, SCRIPT_REVIEW_MAX_OUTPUT_TOKENS),`
- `services/aiTicketDraft.ts`:
  - import: `import { resolveMessagesApiThinking } from './aiModelThinking';` → `import { messagesApiWireOptions } from './aiModels/modelWireOptions';`
  - spread: `...resolveMessagesApiThinking(wireModel), // #7587` → `...messagesApiWireOptions(wireModel, maxTokens), // #7587, #7599`
- `services/officeAddin/aiEmailDraft.ts`:
  - import: `import { resolveMessagesApiThinking } from '../aiModelThinking';` → `import { messagesApiWireOptions } from '../aiModels/modelWireOptions';`
  - spread: `...resolveMessagesApiThinking(wireModel), // #7587` → `...messagesApiWireOptions(wireModel, maxTokens), // #7587, #7599`
- `services/aiPatchTestRunner.ts`:
  - import: `import { resolveMessagesApiThinking } from './aiModelThinking';` → `import { messagesApiWireOptions } from './aiModels/modelWireOptions';`
  - Add `const PATCH_ANALYSIS_MAX_TOKENS = 512;` at module scope.
  - Change `max_tokens: 512,` to `max_tokens: PATCH_ANALYSIS_MAX_TOKENS,`.
  - Change `...resolveMessagesApiThinking(model),` to `...messagesApiWireOptions(model, PATCH_ANALYSIS_MAX_TOKENS),`.
- `services/aiAgents/runLoop.test.ts` (~L1775): in the test title, replace `via resolveModelThinking (#7587)` with `via agentSdkWireOptions (#7587, #7599)`. The assertions stay unchanged.

Three existing tests mock `aiModel` with a partial factory that only defines `resolveDefaultModel`:
- `services/llm/__scripts__/tool-eval.test.ts`
- `services/llm/llmConfigResolver.test.ts`
- `services/partnerLlmConfig.test.ts`

Vitest throws on access to an export a mock factory doesn't define. Any path those suites drive into `modelWireOptions` / `derivePromptProfile` would therefore fail. Make each mock keep the real module and override only the default:
```ts
vi.mock('../../aiModel', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../aiModel')>()),
  resolveDefaultModel: () => 'default-model',
}));
```
Use each file's own relative path and its existing return value: `'default-model'`, or `'claude-sonnet-4-6'` in `partnerLlmConfig.test.ts`. For `llmConfigResolver.test.ts`, keep whatever its current factory returns for `resolveDefaultModel`.

Then delete the interim module:
```bash
git rm apps/api/src/services/aiModelThinking.ts apps/api/src/services/aiModelThinking.test.ts
```

- [ ] **Step 7: Prove nothing references the deleted module and no other code builds thinking params**

Run:
```bash
git grep -n "aiModelThinking\|resolveModelThinking\|resolveMessagesApiThinking" -- apps ee packages
git grep -nE "thinking: \{ ?type:|budgetTokens:|output_config: \{" -- apps/api/src ee ':!*.test.ts' ':!**/__scripts__/**'
```

Expected:
- The first command prints nothing.
- The second prints only lines in `apps/api/src/services/aiModels/wireParams.ts` (index invariant 2).

- [ ] **Step 8: Run every touched surface's tests and typecheck**

Run:
```bash
cd apps/api && npx vitest run src/services/aiModels/ src/services/aiAgents/runLoop.test.ts \
  src/services/streamingSessionManager.catalog.test.ts src/services/streamingSessionManager.usage.test.ts \
  src/services/llm/providerFidelityHarness.test.ts src/services/llm/toolCapture/runSurface.test.ts \
  src/services/aiTicketDraft.test.ts src/services/officeAddin/aiEmailDraft.test.ts \
  src/services/scriptProposals/runScriptReview.test.ts src/services/aiPatchTestRunner \
  src/services/llm/__scripts__/tool-eval.test.ts src/services/llm/llmConfigResolver.test.ts src/services/partnerLlmConfig.test.ts
npx tsc --noEmit -p tsconfig.json
```

Expected:
- PASS. These suites ran W00's assertions on the same model ids; the snapshot is cold in unit tests, so the bootstrap rules give W00's exact output.
- Check the reported file count includes every listed file. The last filter is a substring; if it matches nothing, drop it.
- tsc exits 0.

- [ ] **Step 9: Commit**

```bash
git add apps/api/src/services/aiModels/modelWireOptions.ts apps/api/src/services/aiModels/modelWireOptions.test.ts \
  apps/api/src/services/aiModel.ts apps/api/src/services/streamingSessionManager.ts apps/api/src/services/aiAgents/runLoop.ts \
  apps/api/src/services/aiAgents/runLoop.test.ts apps/api/src/services/llm/providerFidelityHarness.ts \
  apps/api/src/services/llm/toolCapture/runSurface.ts apps/api/src/services/scriptProposals/reviewer.ts \
  apps/api/src/services/aiTicketDraft.ts apps/api/src/services/officeAddin/aiEmailDraft.ts apps/api/src/services/aiPatchTestRunner.ts \
  apps/api/src/services/llm/__scripts__/tool-eval.test.ts apps/api/src/services/llm/llmConfigResolver.test.ts \
  apps/api/src/services/partnerLlmConfig.test.ts
git commit -m "feat(ai): thinking/effort from registry capabilities; delete the W00 interim resolver (#7599)

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

## Task 11: Cost tracker reads token rates and "is priced" from the registry

In W01, `aiCostTracker.calculateCostCents` (the token-based fallback) and `isPricedModel` read the registry snapshot. `MODEL_PRICING`, `DEFAULT_PRICING` and `OFFERABLE_AI_MODELS` stay as bootstrap until W03 deletes them, and so does the SDK-cost preference (`recordUsageFromSdkResult` ~L1008). With the registry equal to its seed, every price is W00's.

Lookup order in `resolveTokenRate(model)`:
1. Snapshot loaded and a row exists for the id: the row's rates, or none if the row is unpriced.
2. Snapshot cold, or no row: W00's `MODEL_PRICING` entry.
3. Otherwise none.

"None" → `isPricedModel` is false, and `calculateCostCents` prices at `DEFAULT_PRICING` with its existing warning (W00 behaviour for unknown ids).

**Files:**
- Modify: `apps/api/src/services/aiCostTracker.ts` (~L91–152 and ~L606–638)
- Modify: `apps/api/src/services/aiCostTracker.test.ts` (append a describe block after `describe('calculateCatalogCostCents', …)`)

**Interfaces:**
- Consumes: `isPlatformModelSnapshotLoaded`, `peekPlatformModel`, `setPlatformModelSnapshot`, `clearPlatformModelSnapshot` (Task 7); `computeInvocationCents`, `platformRateSnapshot`, `RateSnapshot` (Task 5); fixtures (Task 8).
- Produces: unchanged signatures `calculateCostCents(model, input, output, cacheRead?, cacheWrite?): number` and `isPricedModel(model): boolean`, now registry-backed.

- [ ] **Step 1: Write the failing parity test**

Append to `apps/api/src/services/aiCostTracker.test.ts`. Add these imports at the top of the file:
```ts
import { clearPlatformModelSnapshot, setPlatformModelSnapshot } from './aiModels/platformModelSnapshot';
import {
  PARITY_TOKEN_VECTORS,
  SEEDED_PLATFORM_MODELS,
  W00_MODEL_PRICING,
  seededPlatformModel,
  w00CalculateCostCents,
} from './aiModels/__fixtures__/seededPlatformModels';
```

Then:
```ts
describe('token pricing reads the platform model registry (W01 #7599)', () => {
  afterEach(() => clearPlatformModelSnapshot());

  describe.each([
    ['cold snapshot (bootstrap MODEL_PRICING)', () => clearPlatformModelSnapshot()],
    ['registry = seed', () => setPlatformModelSnapshot(SEEDED_PLATFORM_MODELS)],
  ] as const)('%s', (_label, arrange) => {
    it('prices every W00 id exactly as W00 did, for every parity vector', () => {
      arrange();
      for (const model of Object.keys(W00_MODEL_PRICING)) {
        for (const [input, output, cacheRead, cacheWrite] of PARITY_TOKEN_VECTORS) {
          expect(calculateCostCents(model, input, output, cacheRead, cacheWrite), `${model} ${input}/${output}/${cacheRead}/${cacheWrite}`)
            .toBe(w00CalculateCostCents(model, input, output, cacheRead, cacheWrite));
        }
      }
    });

    it('isPricedModel matches W00 for every W00 id and an unknown id', () => {
      arrange();
      for (const model of Object.keys(W00_MODEL_PRICING)) expect(isPricedModel(model), model).toBe(true);
      expect(isPricedModel('some-unreleased-model')).toBe(false);
    });
  });

  it('an operator price edit is what the fallback charges', () => {
    setPlatformModelSnapshot([{ ...seededPlatformModel('claude-opus-4-8'),
      rates: { inputCentsPerM: 450, outputCentsPerM: 2250, cacheReadCentsPerM: 45, cacheWriteCentsPerM: 560 } }]);
    expect(calculateCostCents('claude-opus-4-8', 1_000_000, 1_000_000, 1_000_000, 1_000_000)).toBe(450 + 2250 + 45 + 560);
  });

  it('a newly discovered model the operator priced is priced (no release needed)', () => {
    setPlatformModelSnapshot([{ ...seededPlatformModel('claude-sonnet-5-5'), modelId: 'vendor-new-model', isPlatformDefault: false }]);
    expect(isPricedModel('vendor-new-model')).toBe(true);
    expect(calculateCostCents('vendor-new-model', 1_000_000, 0)).toBe(200);
  });

  it('a registry row with no price is unpriced: isPricedModel false, DEFAULT_PRICING charged with the warning', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    setPlatformModelSnapshot([{ ...seededPlatformModel('claude-haiku-4-5'), rates: null, platformOffered: false }]);
    expect(isPricedModel('claude-haiku-4-5')).toBe(false);
    expect(calculateCostCents('claude-haiku-4-5', 1_000_000, 1_000_000)).toBe(3000);
    expect(warn).toHaveBeenCalled();
    warn.mockRestore();
  });

  it('a loaded snapshot without a row for a W00 id still prices it from bootstrap MODEL_PRICING', () => {
    setPlatformModelSnapshot([]);
    expect(isPricedModel('claude-sonnet-4-6')).toBe(true);
    expect(calculateCostCents('claude-sonnet-4-6', 1_000_000, 1_000_000)).toBe(1800);
  });
});
```

- [ ] **Step 2: Run it and watch it fail**

Run: `cd apps/api && npx vitest run src/services/aiCostTracker.test.ts -t "platform model registry"`

Expected: FAIL. The cold and seed parity cases already pass, because the code still reads `MODEL_PRICING`. The operator-edit case fails (`expected 3675 to be 3305`), as do the new-model and unpriced-row cases. Those failures prove the tracker ignores the registry.

- [ ] **Step 3: Implement**

In `apps/api/src/services/aiCostTracker.ts`, add the imports:
```ts
import { isPlatformModelSnapshotLoaded, peekPlatformModel } from './aiModels/platformModelSnapshot';
import { computeInvocationCents, platformRateSnapshot, type RateSnapshot } from './aiModels/pricing';
```

Replace `isPricedModel` with:
```ts
/**
 * W01 (#7599): the platform model registry decides; MODEL_PRICING is the
 * bootstrap for a cold snapshot or an id the registry doesn't hold. W03
 * deletes MODEL_PRICING / DEFAULT_PRICING / isPricedModel.
 */
function legacyRateSnapshot(model: string): RateSnapshot | null {
  const pricing = MODEL_PRICING[model];
  if (!pricing) return null;
  return {
    source: 'platform',
    standard: {
      inputCentsPerM: pricing.inputPerMillion,
      outputCentsPerM: pricing.outputPerMillion,
      cacheReadCentsPerM: pricing.cacheReadPerMillion ?? pricing.inputPerMillion * CACHE_READ_INPUT_MULTIPLIER,
      cacheWriteCentsPerM: pricing.inputPerMillion * CACHE_WRITE_INPUT_MULTIPLIER,
    },
  };
}

function resolveTokenRate(model: string): RateSnapshot | null {
  if (isPlatformModelSnapshotLoaded()) {
    const row = peekPlatformModel(model);
    if (row) return platformRateSnapshot(row);
  }
  return legacyRateSnapshot(model);
}

export function isPricedModel(model: string): boolean {
  return resolveTokenRate(model) !== null;
}
```

`legacyRateSnapshot` uses `CACHE_READ_INPUT_MULTIPLIER` / `CACHE_WRITE_INPUT_MULTIPLIER`, which are declared further down the file. No reorder is needed: both functions run only after module initialisation, so there is no temporal-dead-zone access.

Replace the body of `calculateCostCents` with:
```ts
export function calculateCostCents(
  model: string,
  inputTokens: number,
  outputTokens: number,
  // Cache tokens are reported separately from `input_tokens` by the SDK usage
  // object and are billed at different rates. Default to 0 so callers that
  // don't care about caching are unaffected.
  cacheReadInputTokens = 0,
  cacheCreationInputTokens = 0
): number {
  let rate = resolveTokenRate(model);
  if (!rate) {
    // Surface unpriced models: price them in the registry (/admin/ai-models)
    // rather than silently billing at the conservative default rate.
    console.warn(
      `[AI] No price for model "${model}" — falling back to DEFAULT_PRICING ` +
      `($${(DEFAULT_PRICING.inputPerMillion / 100).toFixed(2)}/$${(DEFAULT_PRICING.outputPerMillion / 100).toFixed(2)} per MTok). ` +
      'Set its price on /admin/ai-models.'
    );
    rate = {
      source: 'platform',
      standard: {
        inputCentsPerM: DEFAULT_PRICING.inputPerMillion,
        outputCentsPerM: DEFAULT_PRICING.outputPerMillion,
        cacheReadCentsPerM: DEFAULT_PRICING.inputPerMillion * CACHE_READ_INPUT_MULTIPLIER,
        cacheWriteCentsPerM: DEFAULT_PRICING.inputPerMillion * CACHE_WRITE_INPUT_MULTIPLIER,
      },
    };
  }
  // One rounding to 2 dp, exactly as W00 (#7593) rounded. computeInvocationCents
  // sums in W00's order, so the cold path is bit-identical to W00.
  const cents = computeInvocationCents(
    rate,
    { input: inputTokens, output: outputTokens, cacheRead: cacheReadInputTokens, cacheWrite: cacheCreationInputTokens },
    {},
  );
  return Math.round(cents * 100) / 100;
}
```

`computeInvocationCents` throws `RangeError` on a negative or non-finite token count. W00 silently produced a negative or `NaN` cost for those inputs. Check the existing `calculateCostCents` tests (~L317–417) for any case feeding such values. None did at #7593; if one exists, keep W00 behaviour by clamping at the call. Never by removing the guard from `pricing.ts`.

- [ ] **Step 4: Run the cost tracker suites and watch them pass**

Run: `cd apps/api && npx vitest run src/services/aiCostTracker.test.ts src/services/aiBudgetReservations.test.ts src/services/streamingSessionManager.usage.test.ts src/services/aiAgents/runLoop.test.ts`

Expected: PASS, including the pre-existing `calculateCostCents` cases (they run with a cold snapshot).

- [ ] **Step 5: Commit**

```bash
git add apps/api/src/services/aiCostTracker.ts apps/api/src/services/aiCostTracker.test.ts
git commit -m "feat(ai): token-based cost fallback and isPricedModel read the model registry (#7599)

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

## Task 12: `OFFERABLE_AI_MODELS` consumers and catalog `model_map` keys read the registry

| Consumer | W00 | W01 |
|---|---|---|
| `routes/aiProvider.ts` GET `/ai/provider` `supportedModels` | `[...OFFERABLE_AI_MODELS]` | `await listOfferableModelIds()` |
| `services/aiAgent.ts` `assertSessionModelAllowed` (platform key / partner Anthropic key) | `OFFERABLE_AI_MODELS.includes(model)` | `await isOfferablePlatformModel(model)` |
| `services/partnerLlmConfig.ts` `updatePartnerLlmConfig` default-model check | `OFFERABLE_AI_MODELS.includes(...)` | `await isOfferablePlatformModel(...)` |
| `services/llmProviderCatalog.ts` `assertOfferableModelMap` (spec §6) | keys ⊆ `OFFERABLE_AI_MODELS` | keys ⊆ `listCatalogMappableModelIds()` (registry ids not `retired`) |

The constant itself stays exported from `aiOfferableModels.ts` (and re-exported by `aiCostTracker.ts`) until W03 deletes it (spec §8). After this task it has no production consumer.

**Files:**
- Modify: `apps/api/src/routes/aiProvider.ts` (~L7 import, ~L95–98) + `apps/api/src/routes/aiProvider.test.ts`
- Modify: `apps/api/src/services/aiAgent.ts` (~L31 import, ~L53–64) + `apps/api/src/services/aiAgent.sessionModel.test.ts`
- Modify: `apps/api/src/services/partnerLlmConfig.ts` (~L7 import, ~L351) + `apps/api/src/services/partnerLlmConfig.test.ts`
- Modify: `apps/api/src/services/llmProviderCatalog.ts` (~L9 import, ~L107–125, the `createRevision` call ~L368) + `apps/api/src/services/llmProviderCatalog.test.ts`
- Modify: `apps/api/src/db/schema/llmProviderCatalog.ts` (L13 comment)
- Modify: `apps/api/src/services/aiOfferableModels.ts` (header comment only)

**Interfaces:**
- Consumes: `listOfferableModelIds`, `isOfferablePlatformModel`, `listCatalogMappableModelIds` (Task 9).
- Produces: no new exports. `assertSessionModelAllowed` and `assertOfferableModelMap` (renamed `assertMappableModelMap`) become `async`; both are module-private.

- [ ] **Step 1: Write the failing tests**

`apps/api/src/services/aiAgent.sessionModel.test.ts`. Add a mock next to the other mock declarations at the top:
```ts
const isOfferablePlatformModelMock = vi.fn();
vi.mock('./aiModels/platformModels', () => ({
  isOfferablePlatformModel: (...args: unknown[]) => isOfferablePlatformModelMock(...args),
}));
```
In the existing `beforeEach`, add a default that reproduces W00's list:
```ts
    isOfferablePlatformModelMock.mockImplementation(async (model: string) =>
      ['claude-opus-5-5', 'claude-sonnet-5-5', 'claude-fable-5-1', 'claude-opus-4-8', 'claude-sonnet-4-6', 'claude-haiku-4-5', 'claude-fable-5'].includes(model));
```
Then add two cases inside `describe('createSession validates the requested model (#7587)', …)`:
```ts
  it('platform key: accepts a model the registry offers that W00 never listed (W01 #7599)', async () => {
    isOfferablePlatformModelMock.mockImplementation(async (model: string) => model === 'vendor-new-model');
    resolveLlmConfigForOrgMock.mockResolvedValue(PLATFORM);
    armInsert();
    await expect(createSession(orgAuth(), { model: 'vendor-new-model' })).resolves.toMatchObject({ id: 'sess-1' });
    expect(isOfferablePlatformModelMock).toHaveBeenCalledWith('vendor-new-model');
  });

  it('platform key: rejects a W00 id the operator stopped offering (W01 #7599)', async () => {
    isOfferablePlatformModelMock.mockResolvedValue(false);
    resolveLlmConfigForOrgMock.mockResolvedValue(PLATFORM);
    await expect(createSession(orgAuth(), { model: 'claude-opus-4-8' })).rejects.toBeInstanceOf(InvalidSessionModelError);
    expect(insertMock).not.toHaveBeenCalled();
  });
```

`apps/api/src/services/partnerLlmConfig.test.ts`. Add near the other mocks:
```ts
const { isOfferablePlatformModelMock } = vi.hoisted(() => ({ isOfferablePlatformModelMock: vi.fn() }));
vi.mock('./aiModels/platformModels', () => ({
  isOfferablePlatformModel: (...args: unknown[]) => isOfferablePlatformModelMock(...args),
}));
```
Add to `describe('updatePartnerLlmConfig', …)`:
```ts
  beforeEach(() => {
    isOfferablePlatformModelMock.mockImplementation(async (model: string) =>
      ['claude-opus-5-5', 'claude-sonnet-5-5', 'claude-fable-5-1', 'claude-opus-4-8', 'claude-sonnet-4-6', 'claude-haiku-4-5', 'claude-fable-5'].includes(model));
  });

  it('accepts a default the registry offers that W00 never listed (W01 #7599)', async () => {
    isOfferablePlatformModelMock.mockResolvedValue(true);
    dbState.updateResults.push([{ configVersion: 3 }]);
    await expect(updatePartnerLlmConfig({ partnerId: PARTNER_ID, defaultModel: 'vendor-new-model' }))
      .resolves.toEqual({ defaultModel: 'vendor-new-model', configVersion: 3 });
  });

  it('rejects a W00 id the operator stopped offering, without writing (W01 #7599)', async () => {
    isOfferablePlatformModelMock.mockResolvedValue(false);
    await expect(updatePartnerLlmConfig({ partnerId: PARTNER_ID, defaultModel: 'claude-haiku-4-5' }))
      .rejects.toMatchObject({ name: 'PartnerLlmError', status: 400 });
    expect(dbState.updateSets).toHaveLength(0);
  });
```
(Add `beforeEach` to the file's `vitest` import if it isn't there.)

`apps/api/src/routes/aiProvider.test.ts`. Add next to the existing `vi.mock('../services/aiCostTracker', …)`:
```ts
const { listOfferableModelIdsMock } = vi.hoisted(() => ({ listOfferableModelIdsMock: vi.fn() }));
vi.mock('../services/aiModels/platformModels', () => ({
  listOfferableModelIds: (...args: unknown[]) => listOfferableModelIdsMock(...args),
}));
```
In the file's top-level `beforeEach`, add `listOfferableModelIdsMock.mockResolvedValue(['claude-sonnet-4-6', 'claude-haiku-4-5']);`. Then replace the test at ~L420:
```ts
  it('GET / returns supportedModels from the platform model registry for the model select', async () => {
    listOfferableModelIdsMock.mockResolvedValue(['claude-sonnet-4-6', 'claude-haiku-4-5', 'vendor-new-model']);
```
Keep its existing request lines, and change its final assertion to:
```ts
    expect(body.supportedModels).toEqual(['claude-sonnet-4-6', 'claude-haiku-4-5', 'vendor-new-model']);
```

`apps/api/src/services/llmProviderCatalog.test.ts`. Replace the whole `vi.mock('./aiCostTracker', …)` block with:
```ts
const { listCatalogMappableModelIdsMock } = vi.hoisted(() => ({ listCatalogMappableModelIdsMock: vi.fn() }));
vi.mock('./aiModels/platformModels', () => ({
  listCatalogMappableModelIds: (...args: unknown[]) => listCatalogMappableModelIdsMock(...args),
}));
```
In the file's top-level `beforeEach`, add `listCatalogMappableModelIdsMock.mockResolvedValue(['claude-opus-4-8', 'claude-sonnet-4-6', 'claude-haiku-4-5', 'claude-fable-5']);`. Rename the test `'rejects model-map keys outside OFFERABLE_AI_MODELS before writing'` to `'rejects model-map keys that are not registry models before writing'`. Then add:
```ts
  it('rejects a model id the registry has retired (spec §6, W01 #7599)', async () => {
    listCatalogMappableModelIdsMock.mockResolvedValue(['claude-opus-4-8', 'claude-sonnet-4-6', 'claude-fable-5']);
    await expect(createRevision({
      entryId: ENTRY_ID,
      baseUrl: 'https://llm.example.test/v1',
      authMode: 'x-api-key',
      modelMap,
      createdBy: ADMIN_ID,
    })).rejects.toThrow(/claude-haiku-4-5/);
    expect(db.insert).not.toHaveBeenCalled();
  });
```

- [ ] **Step 2: Run them and watch the new cases fail**

Run: `cd apps/api && npx vitest run src/services/aiAgent.sessionModel.test.ts src/services/partnerLlmConfig.test.ts src/routes/aiProvider.test.ts src/services/llmProviderCatalog.test.ts`

Expected: FAIL in each file, and only in the new cases:
- `vendor-new-model` is refused, because the code still checks `OFFERABLE_AI_MODELS`;
- the un-offered Opus 4.8 / Haiku 4.5 is accepted;
- `supportedModels` lacks `vendor-new-model`;
- the retired Haiku 4.5 passes validation.

- [ ] **Step 3: Implement**

`apps/api/src/services/aiAgent.ts`:
- Change the import `import { InvalidSessionModelError, OFFERABLE_AI_MODELS } from './aiOfferableModels';` to `import { InvalidSessionModelError } from './aiOfferableModels';`.
- Add `import { isOfferablePlatformModel } from './aiModels/platformModels';`.
- Make the guard async:
```ts
/**
 * #7587: the client-supplied session `model` is validated server-side.
 * - Catalog endpoint: the fail-closed `resolveWireModel` gate (the pinned
 *   revision must map AND have verified the model).
 * - Platform key or a partner's own Anthropic key: the platform model
 *   registry (W01 #7599). The model must be `platform_offered` and
 *   `available`. The configured default itself is always allowed, so a
 *   client echoing a self-host `ANTHROPIC_MODEL` id is not refused.
 */
async function assertSessionModelAllowed(resolved: UsableLlmConfig, model: string): Promise<void> {
  if (resolved.source === 'partner' && resolved.endpoint.kind === 'catalog') {
    try {
      resolveWireModel(resolved, model);
      return;
    } catch (err) {
      if (err instanceof LlmUnavailableError) throw new InvalidSessionModelError(model);
      throw err;
    }
  }
  if (model === resolved.model || (await isOfferablePlatformModel(model))) return;
  throw new InvalidSessionModelError(model);
}
```
- At the call site (~L251), change `if (options.model !== undefined) assertSessionModelAllowed(resolved, options.model);` to `if (options.model !== undefined) await assertSessionModelAllowed(resolved, options.model);`.

`apps/api/src/services/partnerLlmConfig.ts`:
- Replace `import { OFFERABLE_AI_MODELS } from './aiCostTracker';` with `import { isOfferablePlatformModel } from './aiModels/platformModels';`.
- Replace `if (input.defaultModel !== null && !OFFERABLE_AI_MODELS.includes(input.defaultModel)) {` with `if (input.defaultModel !== null && !(await isOfferablePlatformModel(input.defaultModel))) {`.

`apps/api/src/routes/aiProvider.ts`:
- Replace `import { OFFERABLE_AI_MODELS } from '../services/aiCostTracker';` with `import { listOfferableModelIds } from '../services/aiModels/platformModels';`.
- Replace the `supportedModels` lines with:
```ts
      // Options for the web UI's default-model select: the platform model
      // registry's offered, available models (W01 #7599). Offered implies
      // priced, so the UI can never offer a model we can't meter.
      supportedModels: await listOfferableModelIds(),
```

`apps/api/src/services/llmProviderCatalog.ts`:
- Replace `import { OFFERABLE_AI_MODELS } from './aiCostTracker';` with `import { listCatalogMappableModelIds } from './aiModels/platformModels';`.
- Replace `assertOfferableModelMap` with:
```ts
async function assertMappableModelMap(modelMap: LlmProviderModelMap): Promise<void> {
  const modelIds = Object.keys(modelMap);
  // An empty map trivially satisfies the "every mapped model is verified" gate,
  // so a revision with no models could be created, activated and listed having
  // never passed a single fidelity check.
  if (modelIds.length === 0) {
    throw new LlmProviderCatalogError('A catalog revision must map at least one model.', 400);
  }
  // Spec §6: model_map keys are ai_platform_models.model_id values (any model
  // the registry holds that is not retired), not a hard-coded list (W01 #7599).
  const mappable = new Set(await listCatalogMappableModelIds());
  const unsupported = modelIds.filter((modelId) => !mappable.has(modelId));
  if (unsupported.length > 0) {
    throw new LlmProviderCatalogError(`Unsupported catalog model ids: ${unsupported.join(', ')}`, 400);
  }
}
```
- In `createRevision`, change `assertOfferableModelMap(input.modelMap);` to `await assertMappableModelMap(input.modelMap);`.

`apps/api/src/db/schema/llmProviderCatalog.ts` L13: replace the comment with:
```ts
/** Keyed by ai_platform_models.model_id (any non-retired registry model; W01 #7599). Only mapped models are selectable. */
```

`apps/api/src/services/aiOfferableModels.ts`: replace the comment block above `OFFERABLE_AI_MODELS` with:
```ts
// W00 (#7587) offerable-model list. Since W01 (#7599) no production code reads
// it: offerability is `ai_platform_models.platform_offered` (see
// services/aiModels/platformModels.ts listOfferableModelIds /
// isOfferablePlatformModel). It stays exported, and re-exported by
// aiCostTracker.ts, only until W03 deletes it with MODEL_PRICING (spec §8).
```

- [ ] **Step 4: Run them and watch them pass, then confirm no production consumer is left**

Run:
```bash
cd apps/api && npx vitest run src/services/aiAgent.sessionModel.test.ts src/services/partnerLlmConfig.test.ts \
  src/routes/aiProvider.test.ts src/services/llmProviderCatalog.test.ts src/routes/admin/llmProviderCatalog.test.ts \
  src/routes/ai_sessions_crud.test.ts src/services/aiAgent.model.test.ts
git grep -n "OFFERABLE_AI_MODELS" -- apps/api/src ':!*.test.ts' ':!**/__fixtures__/**'
```

Expected:
- vitest: PASS.
- grep: only the definition in `services/aiOfferableModels.ts` and the re-export in `services/aiCostTracker.ts`.
- If `ai_sessions_crud.test.ts` or `aiAgent.model.test.ts` now reach the real `isOfferablePlatformModel` through `createSession` and fail on an unmocked DB call, add the same `vi.mock('…/aiModels/platformModels', …)` with the W00 list to that file.

- [ ] **Step 5: Commit**

```bash
git add apps/api/src/routes/aiProvider.ts apps/api/src/routes/aiProvider.test.ts apps/api/src/services/aiAgent.ts \
  apps/api/src/services/aiAgent.sessionModel.test.ts apps/api/src/services/partnerLlmConfig.ts \
  apps/api/src/services/partnerLlmConfig.test.ts apps/api/src/services/llmProviderCatalog.ts \
  apps/api/src/services/llmProviderCatalog.test.ts apps/api/src/db/schema/llmProviderCatalog.ts \
  apps/api/src/services/aiOfferableModels.ts
git commit -m "feat(ai): offerable models and catalog model_map keys come from the model registry (#7599)

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

## Task 13: Anthropic discovery: `discoverAnthropicModels`, lifecycle rules, `syncPlatformModels`, operator alert

The operator notification uses the existing operator channel, `sendOpsAlert` (`services/opsAlerts.ts`):
- It posts to `OPS_ALERT_WEBHOOK_URL` and/or emails `OPS_ALERT_EMAIL`.
- It never throws, and returns `true` if any channel delivered.
- It is already called from workers: `sendingDomainsWorker`, `abuseSignals`.

No in-app channel targets platform admins:
- `createNotification` requires an `orgId`.
- Platform admins have no platform org.

So W01 uses `sendOpsAlert`, plus the "new" badge on `/admin/ai-models` (Task 16). The badge is the durable signal on deployments without ops alerting configured. A new id is marked notified (`operator_notified_at`) only after a successful send, so an undelivered alert is retried on the next sync, the same pattern as `abuseSignals` (deliver, then mark).

Lifecycle (spec §6, with two guards this plan adds):
- A model absent from a successful sync increments `missed_sync_count`.
- It becomes `missing` once it has been absent from **3 consecutive successful syncs AND 48 h**. The 48 h floor stops three quick admin "Refresh" clicks from hiding a model.
- It becomes `retired` once absent **14 days**.
- A row no sync has ever seen (`last_seen_at IS NULL`) never moves. This protects seeded aliases (for example `claude-haiku-4-5`) if the Models API lists only dated ids. See spike Q5/D5.
- A failed or skipped sync changes nothing. An empty listing counts as failed.
- Discovery runs only with the platform key against `https://api.anthropic.com`. A self-host pointing `ANTHROPIC_BASE_URL` at a gateway is `skipped`.
- Concurrent syncs serialise on a transaction advisory lock.

**Files:**
- Create: `apps/api/src/services/aiModels/discovery.ts`
- Create: `apps/api/src/services/aiModels/discovery.test.ts`
- Create: `apps/api/src/__tests__/integration/aiModelDiscovery.integration.test.ts`

**Interfaces:**
- Consumes:
  - `upsertDiscoveredPlatformModel`, `refreshPlatformModelSnapshot`, `DiscoveredModelInput` (Task 9);
  - `aiPlatformModels` (Task 6);
  - `sendOpsAlert` from `../opsAlerts`;
  - `captureException` from `../sentry`.
- Produces:
  ```ts
  export const ANTHROPIC_API_ORIGIN = 'https://api.anthropic.com';
  export type AnthropicModelInfo = DiscoveredModelInput;
  export async function discoverAnthropicModels(apiKey: string | undefined): Promise<AnthropicModelInfo[]>;           // index
  export const LIFECYCLE_MISSING_AFTER_SYNCS = 3;
  export const LIFECYCLE_MISSING_MIN_ABSENT_MS = 48 * 3_600_000;
  export const LIFECYCLE_RETIRED_AFTER_MS = 14 * 86_400_000;
  export function computeLifecycleAfterSync(row: { lifecycle: ModelLifecycle; missedSyncCount: number; lastSeenAt: Date | null }, seen: boolean, now: Date): { lifecycle: ModelLifecycle; missedSyncCount: number };
  export type SyncReport =
    | { status: 'skipped'; reason: 'no_platform_key' | 'custom_base_url' }
    | { status: 'failed'; error: string }
    | { status: 'ok'; discovered: number; inserted: string[]; restored: string[]; markedMissing: string[]; retired: string[]; operatorNotified: boolean };
  export interface SyncPlatformModelsOptions { env?: NodeJS.ProcessEnv; discover?: (apiKey: string) => Promise<AnthropicModelInfo[]>; now?: () => Date }
  export async function syncPlatformModels(options?: SyncPlatformModelsOptions): Promise<SyncReport>;                // index
  ```

- [ ] **Step 1: Write the failing unit tests**

```ts
// apps/api/src/services/aiModels/discovery.test.ts
import { beforeEach, describe, expect, it, vi } from 'vitest';

const { listMock, constructorOptions, withSystemDbAccessContextMock, sendOpsAlertMock } = vi.hoisted(() => ({
  listMock: vi.fn(),
  constructorOptions: [] as Array<Record<string, unknown>>,
  withSystemDbAccessContextMock: vi.fn(),
  sendOpsAlertMock: vi.fn(),
}));

vi.mock('@anthropic-ai/sdk', () => {
  class MockAnthropic {
    models = { list: (...args: unknown[]) => listMock(...args) };
    constructor(options: Record<string, unknown>) {
      constructorOptions.push(options);
    }
  }
  return { default: MockAnthropic };
});
vi.mock('../../db', () => ({
  db: {},
  withSystemDbAccessContext: withSystemDbAccessContextMock,
  runOutsideDbContext: (fn: () => unknown) => fn(),
}));
vi.mock('../opsAlerts', () => ({ sendOpsAlert: sendOpsAlertMock }));
vi.mock('../sentry', () => ({ captureException: vi.fn() }));
vi.mock('./platformModels', () => ({
  upsertDiscoveredPlatformModel: vi.fn(),
  refreshPlatformModelSnapshot: vi.fn(async () => undefined),
}));

import {
  ANTHROPIC_API_ORIGIN,
  computeLifecycleAfterSync,
  discoverAnthropicModels,
  syncPlatformModels,
} from './discovery';

const NOW = new Date('2026-11-20T06:38:00.000Z');
const HOURS = 3_600_000;
const DAYS = 24 * HOURS;

async function* pages(items: unknown[]) {
  for (const item of items) yield item;
}

beforeEach(() => {
  vi.clearAllMocks();
  constructorOptions.length = 0;
});

describe('discoverAnthropicModels', () => {
  it('lists with the given key against the Anthropic API only, never ANTHROPIC_BASE_URL or an auth token', async () => {
    listMock.mockReturnValue(pages([
      { id: 'model-a', display_name: 'Model A', max_input_tokens: 1000, max_tokens: 100, capabilities: { thinking: {} } },
    ]));
    const models = await discoverAnthropicModels(' key-1 ');
    expect(constructorOptions[0]).toMatchObject({ apiKey: 'key-1', authToken: null, baseURL: ANTHROPIC_API_ORIGIN });
    expect(models).toEqual([{ id: 'model-a', displayName: 'Model A', maxInputTokens: 1000, maxOutputTokens: 100, capabilities: { thinking: {} } }]);
  });

  it('skips ids that are not plain model identifiers and maps missing fields to null', async () => {
    listMock.mockReturnValue(pages([
      { id: 'bad id with spaces', display_name: 'x' },
      { id: 'model-b', display_name: '', max_input_tokens: null, max_tokens: null, capabilities: null },
    ]));
    expect(await discoverAnthropicModels('k')).toEqual([
      { id: 'model-b', displayName: '', maxInputTokens: null, maxOutputTokens: null, capabilities: null },
    ]);
  });

  it('refuses to run without a key', async () => {
    await expect(discoverAnthropicModels(undefined)).rejects.toThrow(/API key/);
    await expect(discoverAnthropicModels('  ')).rejects.toThrow(/API key/);
  });
});

describe('computeLifecycleAfterSync', () => {
  const seenAgo = (ms: number) => new Date(NOW.getTime() - ms);

  it.each([
    ['seen → available, counter reset', { lifecycle: 'missing', missedSyncCount: 5, lastSeenAt: seenAgo(3 * DAYS) }, true, { lifecycle: 'available', missedSyncCount: 0 }],
    ['never seen by any sync (seeded alias) → untouched', { lifecycle: 'available', missedSyncCount: 0, lastSeenAt: null }, false, { lifecycle: 'available', missedSyncCount: 0 }],
    ['first and second miss → still available', { lifecycle: 'available', missedSyncCount: 1, lastSeenAt: seenAgo(3 * DAYS) }, false, { lifecycle: 'available', missedSyncCount: 2 }],
    ['third miss after 48 h → missing', { lifecycle: 'available', missedSyncCount: 2, lastSeenAt: seenAgo(49 * HOURS) }, false, { lifecycle: 'missing', missedSyncCount: 3 }],
    ['third miss within 48 h (refresh spam) → still available', { lifecycle: 'available', missedSyncCount: 2, lastSeenAt: seenAgo(2 * HOURS) }, false, { lifecycle: 'available', missedSyncCount: 3 }],
    ['missing for 14 days → retired', { lifecycle: 'missing', missedSyncCount: 13, lastSeenAt: seenAgo(14 * DAYS) }, false, { lifecycle: 'retired', missedSyncCount: 14 }],
    ['retired stays retired while absent', { lifecycle: 'retired', missedSyncCount: 20, lastSeenAt: seenAgo(30 * DAYS) }, false, { lifecycle: 'retired', missedSyncCount: 21 }],
  ] as const)('%s', (_label, row, seen, expected) => {
    expect(computeLifecycleAfterSync(row, seen, NOW)).toEqual(expected);
  });
});

describe('syncPlatformModels guards (no database touched)', () => {
  it('skips without a platform key', async () => {
    expect(await syncPlatformModels({ env: {} })).toEqual({ status: 'skipped', reason: 'no_platform_key' });
    expect(withSystemDbAccessContextMock).not.toHaveBeenCalled();
  });

  it('skips a self-host pointed at a gateway (ANTHROPIC_BASE_URL elsewhere)', async () => {
    const discover = vi.fn();
    expect(await syncPlatformModels({ env: { ANTHROPIC_API_KEY: 'k', ANTHROPIC_BASE_URL: 'http://localhost:8000' }, discover }))
      .toEqual({ status: 'skipped', reason: 'custom_base_url' });
    expect(discover).not.toHaveBeenCalled();
  });

  it('runs when ANTHROPIC_BASE_URL is the Anthropic API itself', async () => {
    const discover = vi.fn().mockRejectedValue(new Error('network down'));
    const report = await syncPlatformModels({ env: { ANTHROPIC_API_KEY: 'k', ANTHROPIC_BASE_URL: 'https://api.anthropic.com/' }, discover });
    expect(discover).toHaveBeenCalledWith('k');
    expect(report).toEqual({ status: 'failed', error: 'network down' });
  });

  it('a failed listing changes nothing', async () => {
    const report = await syncPlatformModels({ env: { ANTHROPIC_API_KEY: 'k' }, discover: vi.fn().mockRejectedValue(new Error('401 invalid x-api-key')) });
    expect(report.status).toBe('failed');
    expect(withSystemDbAccessContextMock).not.toHaveBeenCalled();
    expect(sendOpsAlertMock).not.toHaveBeenCalled();
  });

  it('an empty listing is treated as a failure, never as "every model vanished"', async () => {
    expect(await syncPlatformModels({ env: { ANTHROPIC_API_KEY: 'k' }, discover: vi.fn().mockResolvedValue([]) }))
      .toEqual({ status: 'failed', error: 'the Models API returned no models' });
    expect(withSystemDbAccessContextMock).not.toHaveBeenCalled();
  });
});
```

- [ ] **Step 2: Run them and watch them fail**

Run: `cd apps/api && npx vitest run src/services/aiModels/discovery.test.ts`

Expected: FAIL with `Failed to resolve import "./discovery"`.

- [ ] **Step 3: Implement**

```ts
// apps/api/src/services/aiModels/discovery.ts
/**
 * AI model registry (spec §6): Anthropic model discovery. W01 covers the
 * platform key (`syncPlatformModels`); W03 adds `syncConnectionModels` for
 * BYOK.
 *
 * Discovery NEVER enables, prices, deletes, or changes an assignment. New ids
 * land unpriced and unoffered, and the operator is alerted.
 */
import Anthropic from '@anthropic-ai/sdk';
import { and, eq, inArray, isNotNull, isNull, sql } from 'drizzle-orm';
import type { ModelLifecycle } from '@breeze/shared';
import { db, runOutsideDbContext, withSystemDbAccessContext } from '../../db';
import { aiPlatformModels } from '../../db/schema';
import { sendOpsAlert } from '../opsAlerts';
import { captureException } from '../sentry';
import { refreshPlatformModelSnapshot, upsertDiscoveredPlatformModel, type DiscoveredModelInput } from './platformModels';

export const ANTHROPIC_API_ORIGIN = 'https://api.anthropic.com';
export type AnthropicModelInfo = DiscoveredModelInput;

/** A plain model identifier; anything else is skipped rather than shown to operators. */
const MODEL_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:@-]{0,127}$/;

export async function discoverAnthropicModels(apiKey: string | undefined): Promise<AnthropicModelInfo[]> {
  const key = apiKey?.trim();
  if (!key) throw new Error('discoverAnthropicModels: an API key is required');
  // Forced origin and no auth token: the SDK would otherwise pick up
  // ANTHROPIC_BASE_URL / ANTHROPIC_AUTH_TOKEN from the environment.
  const client = new Anthropic({ apiKey: key, authToken: null, baseURL: ANTHROPIC_API_ORIGIN, timeout: 30_000, maxRetries: 2 });
  const models: AnthropicModelInfo[] = [];
  for await (const model of client.models.list({ limit: 100 })) {
    if (typeof model.id !== 'string' || !MODEL_ID_PATTERN.test(model.id)) continue;
    models.push({
      id: model.id,
      displayName: typeof model.display_name === 'string' ? model.display_name : '',
      maxInputTokens: model.max_input_tokens ?? null,
      maxOutputTokens: model.max_tokens ?? null,
      capabilities: model.capabilities ?? null,
    });
  }
  return models;
}

export const LIFECYCLE_MISSING_AFTER_SYNCS = 3;
export const LIFECYCLE_MISSING_MIN_ABSENT_MS = 48 * 3_600_000;
export const LIFECYCLE_RETIRED_AFTER_MS = 14 * 86_400_000;

export function computeLifecycleAfterSync(
  row: { lifecycle: ModelLifecycle; missedSyncCount: number; lastSeenAt: Date | null },
  seen: boolean,
  now: Date,
): { lifecycle: ModelLifecycle; missedSyncCount: number } {
  if (seen) return { lifecycle: 'available', missedSyncCount: 0 };
  // Never observed by a sync (seeded row, e.g. an alias the listing omits): leave it alone.
  if (row.lastSeenAt === null) return { lifecycle: row.lifecycle, missedSyncCount: row.missedSyncCount };
  const missedSyncCount = row.missedSyncCount + 1;
  if (row.lifecycle === 'retired') return { lifecycle: 'retired', missedSyncCount };
  const absentMs = now.getTime() - row.lastSeenAt.getTime();
  if (missedSyncCount >= LIFECYCLE_MISSING_AFTER_SYNCS && absentMs >= LIFECYCLE_RETIRED_AFTER_MS) {
    return { lifecycle: 'retired', missedSyncCount };
  }
  if (missedSyncCount >= LIFECYCLE_MISSING_AFTER_SYNCS && absentMs >= LIFECYCLE_MISSING_MIN_ABSENT_MS) {
    return { lifecycle: 'missing', missedSyncCount };
  }
  return { lifecycle: row.lifecycle, missedSyncCount };
}

export type SyncReport =
  | { status: 'skipped'; reason: 'no_platform_key' | 'custom_base_url' }
  | { status: 'failed'; error: string }
  | {
    status: 'ok';
    discovered: number;
    inserted: string[];
    restored: string[];
    markedMissing: string[];
    retired: string[];
    operatorNotified: boolean;
  };

export interface SyncPlatformModelsOptions {
  env?: NodeJS.ProcessEnv;
  discover?: (apiKey: string) => Promise<AnthropicModelInfo[]>;
  now?: () => Date;
}

function isAnthropicApiOrigin(url: string): boolean {
  try {
    return new URL(url).origin === ANTHROPIC_API_ORIGIN;
  } catch {
    return false;
  }
}

function describeError(error: unknown): string {
  return error instanceof Error ? error.message.slice(0, 300) : String(error).slice(0, 300);
}

interface SyncWrite {
  inserted: string[];
  restored: string[];
  markedMissing: string[];
  retired: string[];
  toNotify: Array<{ id: string; modelId: string }>;
  defaultProblem: { modelId: string; lifecycle: ModelLifecycle } | null;
}

function formatSyncAlert(write: SyncWrite): { title: string; body: string } {
  const lines: string[] = [];
  if (write.toNotify.length > 0) {
    lines.push(
      `New Anthropic model(s) discovered: ${write.toNotify.map((m) => m.modelId).join(', ')}.`,
      'They are unpriced and not offered to anyone until a platform admin sets a price and offers them on /admin/ai-models.',
    );
  }
  if (write.markedMissing.length > 0) lines.push(`No longer listed by the Models API (missing): ${write.markedMissing.join(', ')}.`);
  if (write.retired.length > 0) lines.push(`Retired after 14 days unlisted: ${write.retired.join(', ')}.`);
  if (write.defaultProblem) {
    lines.push(`The platform default model ${write.defaultProblem.modelId} is ${write.defaultProblem.lifecycle}; choose another default on /admin/ai-models.`);
  }
  const title = write.toNotify.length > 0
    ? `${write.toNotify.length} new Anthropic model(s) awaiting pricing`
    : 'Anthropic model availability changed';
  return { title, body: lines.join('\n') };
}

export async function syncPlatformModels(options: SyncPlatformModelsOptions = {}): Promise<SyncReport> {
  const env = options.env ?? process.env;
  const apiKey = env.ANTHROPIC_API_KEY?.trim();
  if (!apiKey) return { status: 'skipped', reason: 'no_platform_key' };
  const baseUrl = env.ANTHROPIC_BASE_URL?.trim();
  if (baseUrl && !isAnthropicApiOrigin(baseUrl)) return { status: 'skipped', reason: 'custom_base_url' };

  // Network call: never inside a DB context (#1105).
  let discovered: AnthropicModelInfo[];
  try {
    discovered = await runOutsideDbContext(() => (options.discover ?? discoverAnthropicModels)(apiKey));
  } catch (error) {
    captureException(error instanceof Error ? error : new Error(String(error)));
    return { status: 'failed', error: describeError(error) };
  }
  if (discovered.length === 0) return { status: 'failed', error: 'the Models API returned no models' };

  const now = (options.now ?? (() => new Date()))();
  const seenIds = new Set(discovered.map((model) => model.id));

  const write = await runOutsideDbContext(() => withSystemDbAccessContext(async (): Promise<SyncWrite> => {
    // Serialise concurrent syncs (daily + manual + boot across replicas) so
    // missed-sync counts are never double-incremented by overlapping runs.
    await db.execute(sql`SELECT pg_advisory_xact_lock(hashtextextended('ai-model-discovery:sync-platform', 0))`);

    const inserted: string[] = [];
    const restored: string[] = [];
    for (const model of discovered) {
      const result = await upsertDiscoveredPlatformModel(model, now);
      if (result.inserted) inserted.push(model.id);
      else if (result.previousLifecycle && result.previousLifecycle !== 'available') restored.push(model.id);
    }

    const rows = await db
      .select({
        id: aiPlatformModels.id,
        modelId: aiPlatformModels.modelId,
        lifecycle: aiPlatformModels.lifecycle,
        missedSyncCount: aiPlatformModels.missedSyncCount,
        lastSeenAt: aiPlatformModels.lastSeenAt,
        isPlatformDefault: aiPlatformModels.isPlatformDefault,
      })
      .from(aiPlatformModels)
      .where(eq(aiPlatformModels.provider, 'anthropic'));

    const markedMissing: string[] = [];
    const retired: string[] = [];
    let defaultProblem: SyncWrite['defaultProblem'] = null;
    for (const row of rows) {
      if (seenIds.has(row.modelId)) continue;
      const next = computeLifecycleAfterSync(row, false, now);
      if (next.lifecycle !== row.lifecycle || next.missedSyncCount !== row.missedSyncCount) {
        await db.update(aiPlatformModels)
          .set({ lifecycle: next.lifecycle, missedSyncCount: next.missedSyncCount, updatedAt: now })
          .where(eq(aiPlatformModels.id, row.id));
      }
      if (next.lifecycle !== row.lifecycle) (next.lifecycle === 'missing' ? markedMissing : retired).push(row.modelId);
      if (row.isPlatformDefault && next.lifecycle !== 'available') defaultProblem = { modelId: row.modelId, lifecycle: next.lifecycle };
    }

    // New-to-the-operator ids: discovered by a sync (not seeded), not offered,
    // never successfully alerted. Includes earlier syncs' undelivered alerts.
    const toNotify = await db
      .select({ id: aiPlatformModels.id, modelId: aiPlatformModels.modelId })
      .from(aiPlatformModels)
      .where(and(
        eq(aiPlatformModels.platformOffered, false),
        isNull(aiPlatformModels.operatorNotifiedAt),
        isNotNull(aiPlatformModels.lastSeenAt),
      ));

    return { inserted, restored, markedMissing, retired, toNotify, defaultProblem };
  }, 'aiModels.syncPlatform'));

  let operatorNotified = false;
  if (write.toNotify.length > 0 || write.markedMissing.length > 0 || write.retired.length > 0 || write.defaultProblem) {
    operatorNotified = await sendOpsAlert(formatSyncAlert(write));
    if (!operatorNotified) {
      console.warn('[aiModels] model discovery alert was not delivered (ops alerting unconfigured or failing); new models are flagged on /admin/ai-models');
    }
    if (operatorNotified && write.toNotify.length > 0) {
      await runOutsideDbContext(() => withSystemDbAccessContext(() =>
        db.update(aiPlatformModels)
          .set({ operatorNotifiedAt: now })
          .where(inArray(aiPlatformModels.id, write.toNotify.map((row) => row.id))),
      'aiModels.markNotified'));
    }
  }

  try {
    await refreshPlatformModelSnapshot();
  } catch (error) {
    console.warn('[aiModels] snapshot refresh after sync failed; the boot timer will retry:', error);
  }

  return {
    status: 'ok',
    discovered: discovered.length,
    inserted: write.inserted,
    restored: write.restored,
    markedMissing: write.markedMissing,
    retired: write.retired,
    operatorNotified,
  };
}
```

- [ ] **Step 4: Run the unit tests and watch them pass**

Run: `cd apps/api && npx vitest run src/services/aiModels/discovery.test.ts`

Expected: PASS.

- [ ] **Step 5: Write the failing integration test (real Postgres; injected listing; mocked ops alert)**

```ts
// apps/api/src/__tests__/integration/aiModelDiscovery.integration.test.ts
import './setup';
import { randomUUID } from 'node:crypto';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { inArray, like, sql } from 'drizzle-orm';

const { sendOpsAlertMock } = vi.hoisted(() => ({ sendOpsAlertMock: vi.fn() }));
vi.mock('../../services/opsAlerts', () => ({ sendOpsAlert: sendOpsAlertMock }));

import { db, withSystemDbAccessContext } from '../../db';
import { aiPlatformModels } from '../../db/schema';
import { syncPlatformModels, type AnthropicModelInfo } from '../../services/aiModels/discovery';
import { getPlatformModelByModelId } from '../../services/aiModels/platformModels';
import { SEEDED_PLATFORM_MODELS } from '../../services/aiModels/__fixtures__/seededPlatformModels';

const runDb = it.runIf(!!process.env.DATABASE_URL);
const ENV = { ANTHROPIC_API_KEY: 'test-key' };
const HOURS = 3_600_000;
const CAPS = {
  thinking: { supported: true, types: { adaptive: { supported: true }, enabled: { supported: false } } },
  effort: { supported: true, low: { supported: true }, medium: { supported: true }, high: { supported: true }, xhigh: { supported: true }, max: { supported: true } },
};
const PREFIX = `w01-disc-${randomUUID().slice(0, 8)}`;

function listed(...ids: string[]): AnthropicModelInfo[] {
  return ids.map((id) => ({ id, displayName: id, maxInputTokens: 1000, maxOutputTokens: 100, capabilities: CAPS }));
}

async function sync(ids: string[], at: Date) {
  return syncPlatformModels({ env: ENV, discover: async () => listed(...ids), now: () => at });
}

beforeEach(() => {
  sendOpsAlertMock.mockReset();
  sendOpsAlertMock.mockResolvedValue(true);
});

afterEach(async () => {
  await withSystemDbAccessContext(() => db.delete(aiPlatformModels).where(like(aiPlatformModels.modelId, `${PREFIX}%`)));
});

describe('syncPlatformModels against real Postgres (W01 #7599)', () => {
  runDb('a new id lands unpriced and unoffered, alerts the operator once, and is marked notified', async () => {
    const id = `${PREFIX}-new`;
    const t0 = new Date('2026-11-20T06:38:00.000Z');
    const first = await sync([id], t0);
    expect(first).toMatchObject({ status: 'ok', inserted: [id], operatorNotified: true });
    expect(sendOpsAlertMock).toHaveBeenCalledWith(expect.objectContaining({ body: expect.stringContaining(id) }));
    const row = (await getPlatformModelByModelId(id))!;
    expect(row).toMatchObject({ rates: null, platformOffered: false, isPlatformDefault: false, lifecycle: 'available' });
    expect(row.operatorNotifiedAt).not.toBeNull();

    sendOpsAlertMock.mockClear();
    await sync([id], new Date(t0.getTime() + 24 * HOURS));
    expect(sendOpsAlertMock).not.toHaveBeenCalled();
  });

  runDb('an undelivered alert is retried on the next sync', async () => {
    const id = `${PREFIX}-retry`;
    sendOpsAlertMock.mockResolvedValueOnce(false);
    const t0 = new Date('2026-11-20T06:38:00.000Z');
    expect(await sync([id], t0)).toMatchObject({ operatorNotified: false });
    expect((await getPlatformModelByModelId(id))!.operatorNotifiedAt).toBeNull();
    await sync([id], new Date(t0.getTime() + 24 * HOURS));
    expect((await getPlatformModelByModelId(id))!.operatorNotifiedAt).not.toBeNull();
  });

  runDb('missing needs 3 successful syncs AND 48 h; three quick refreshes do not hide a model', async () => {
    const keep = `${PREFIX}-keep`;
    const gone = `${PREFIX}-gone`;
    const t0 = new Date('2026-11-20T06:38:00.000Z');
    await sync([keep, gone], t0);
    for (let i = 1; i <= 3; i += 1) await sync([keep], new Date(t0.getTime() + i * 60_000)); // refresh spam
    expect((await getPlatformModelByModelId(gone))!.lifecycle).toBe('available');
    const report = await sync([keep], new Date(t0.getTime() + 49 * HOURS));
    expect(report).toMatchObject({ status: 'ok', markedMissing: [gone] });
    expect((await getPlatformModelByModelId(gone))!.lifecycle).toBe('missing');
    expect(sendOpsAlertMock).toHaveBeenLastCalledWith(expect.objectContaining({ body: expect.stringContaining(gone) }));
  });

  runDb('a model that reappears is restored to available', async () => {
    const id = `${PREFIX}-back`;
    const t0 = new Date('2026-11-20T06:38:00.000Z');
    await sync([id], t0);
    await withSystemDbAccessContext(() => db.update(aiPlatformModels).set({ lifecycle: 'missing', missedSyncCount: 3 }).where(inArray(aiPlatformModels.modelId, [id])));
    expect(await sync([id], new Date(t0.getTime() + 72 * HOURS))).toMatchObject({ restored: [id] });
    expect((await getPlatformModelByModelId(id))!).toMatchObject({ lifecycle: 'available', missedSyncCount: 0 });
  });

  runDb('seeded rows no sync has seen are never marked missing, however often they are absent', async () => {
    const t0 = new Date('2026-11-20T06:38:00.000Z');
    for (let i = 0; i < 4; i += 1) await sync([`${PREFIX}-only`], new Date(t0.getTime() + i * 72 * HOURS));
    for (const seeded of SEEDED_PLATFORM_MODELS) {
      const row = (await getPlatformModelByModelId(seeded.modelId))!;
      expect(row.lifecycle, seeded.modelId).toBe('available');
      expect(row.missedSyncCount, seeded.modelId).toBe(0);
    }
  });

  runDb('a skipped sync (gateway base URL) changes no row', async () => {
    const before = await withSystemDbAccessContext(() => db.select({ n: sql<number>`count(*)::int` }).from(aiPlatformModels));
    expect(await syncPlatformModels({ env: { ...ENV, ANTHROPIC_BASE_URL: 'http://localhost:8000' }, discover: async () => listed(`${PREFIX}-x`) }))
      .toEqual({ status: 'skipped', reason: 'custom_base_url' });
    const after = await withSystemDbAccessContext(() => db.select({ n: sql<number>`count(*)::int` }).from(aiPlatformModels));
    expect(after).toEqual(before);
  });
});
```

The seeded-rows test syncs a listing that omits every seeded id. It then asserts they are untouched: their `last_seen_at` is NULL, because no sync in this database has seen them. It must not run against a database where a real sync has run; the integration stack never has a real key.

- [ ] **Step 6: Run the integration test and watch it pass**

Run: `cd apps/api && npx vitest run --config vitest.integration.config.ts src/__tests__/integration/aiModelDiscovery.integration.test.ts`

Expected: PASS. Before Step 3 existed it failed at import; now every case passes.

- [ ] **Step 7: Commit**

```bash
git add apps/api/src/services/aiModels/discovery.ts apps/api/src/services/aiModels/discovery.test.ts \
  apps/api/src/__tests__/integration/aiModelDiscovery.integration.test.ts
git commit -m "feat(ai): Anthropic model discovery for the platform key with lifecycle and operator alert (#7599)

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

## Task 14: BullMQ queue `ai-model-discovery` and worker registration

Following the existing convention, the worker lives in `apps/api/src/jobs/`. The index says `workers/aiModelDiscoveryWorker.ts`, but it also says to follow the existing pattern, and `src/workers/` holds only the legacy webhook worker. The model is `jobs/pax8SyncWorker.ts` (daily cron plus an enqueue helper), with the stable repeat `jobId` from `jobs/exchangeRateSync.ts`.

Jobs, all named `sync-platform` per the index:
- the daily repeatable;
- the manual "Refresh" from `/admin/ai-models`;
- a boot-time one, delayed 60 s, so a fresh deployment learns its models without waiting up to a day.

Fixed job ids go through `enqueueOrReplaceStale`, so a settled job never silently swallows the next request. BullMQ forbids `:` in a custom `jobId`, so the ids use `-`.

**Files:**
- Create: `apps/api/src/jobs/aiModelDiscoveryWorker.ts`
- Create: `apps/api/src/jobs/aiModelDiscoveryWorker.test.ts`
- Modify: `apps/api/src/jobs/scheduleRegistry.ts`: add `'ai-model-discovery-sync': '38 6 * * *',` to `JOB_SCHEDULES` (daily lane, minute ≡ 3 mod 5)
- Modify: `apps/api/src/services/workerRegistry.ts`: append an entry to `WORKER_REGISTRY`
- Modify: `apps/api/src/services/workerRegistry.test.ts`: append `'aiModelDiscoveryWorker'` to `EXPECTED_WORKER_NAMES` (last position, matching the registry order)
- Modify: `apps/api/src/services/workerEntrypointClosure.contract.test.ts`: add `'aiModelDiscoveryWorker'` to `EXPECTED_NAMES`
- Modify: `apps/api/src/jobs/workerReadinessManifest.ts`: add `consumers('aiModelDiscoveryWorker'),` next to `consumers('pax8SyncWorker'),`

**Interfaces:**
- Consumes: `syncPlatformModels`, `SyncReport` (Task 13); `getBullMQConnection` (`services/redis`); `enqueueOrReplaceStale` (`services/bullmqUtils`); `jobSchedule` (`./scheduleRegistry`); `attachWorkerObservability` (`./workerObservability`).
- Produces:
  ```ts
  export const AI_MODEL_DISCOVERY_QUEUE = 'ai-model-discovery';   // index
  export const SYNC_PLATFORM_JOB = 'sync-platform';               // index
  export type AiModelDiscoveryJobData = { type: 'sync-platform'; trigger: 'schedule' | 'manual' | 'boot' };
  export function getAiModelDiscoveryQueue(): Queue<AiModelDiscoveryJobData>;
  export async function processAiModelDiscoveryJob(job: Pick<Job<AiModelDiscoveryJobData>, 'data'>): Promise<SyncReport>;
  export async function enqueuePlatformModelSync(trigger?: 'manual' | 'boot'): Promise<{ id: string }>;
  export async function scheduleAiModelDiscoveryJobs(): Promise<void>;
  export async function initializeAiModelDiscoveryWorker(): Promise<void>;
  export async function shutdownAiModelDiscoveryWorker(): Promise<void>;
  ```

- [ ] **Step 1: Write the failing test**

```ts
// apps/api/src/jobs/aiModelDiscoveryWorker.test.ts
import { beforeEach, describe, expect, it, vi } from 'vitest';

const { addMock, getJobMock, getRepeatableJobsMock, removeRepeatableByKeyMock, syncMock, capturedProcessor } = vi.hoisted(() => ({
  addMock: vi.fn(),
  getJobMock: vi.fn(),
  getRepeatableJobsMock: vi.fn(),
  removeRepeatableByKeyMock: vi.fn(),
  syncMock: vi.fn(),
  capturedProcessor: { current: null as null | ((job: unknown) => Promise<unknown>) },
}));

vi.mock('bullmq', () => ({
  Queue: class {
    name: string;
    constructor(name: string) { this.name = name; }
    add = (...args: unknown[]) => addMock(...args);
    getJob = (...args: unknown[]) => getJobMock(...args);
    getRepeatableJobs = () => getRepeatableJobsMock();
    removeRepeatableByKey = (...args: unknown[]) => removeRepeatableByKeyMock(...args);
    close = vi.fn();
  },
  Worker: class {
    name: string;
    constructor(name: string, processor: (job: unknown) => Promise<unknown>) {
      this.name = name;
      capturedProcessor.current = processor;
    }
    on = vi.fn();
    close = vi.fn();
  },
  Job: class {},
}));
vi.mock('../services/redis', () => ({ getBullMQConnection: vi.fn(() => ({ host: 'localhost', port: 6379 })) }));
vi.mock('./workerObservability', () => ({ attachWorkerObservability: vi.fn() }));
vi.mock('../services/sentry', () => ({ captureException: vi.fn() }));
vi.mock('../services/aiModels/discovery', () => ({ syncPlatformModels: (...args: unknown[]) => syncMock(...args) }));

import {
  AI_MODEL_DISCOVERY_QUEUE,
  SYNC_PLATFORM_JOB,
  __testOnly,
  enqueuePlatformModelSync,
  initializeAiModelDiscoveryWorker,
  processAiModelDiscoveryJob,
  scheduleAiModelDiscoveryJobs,
  shutdownAiModelDiscoveryWorker,
} from './aiModelDiscoveryWorker';

beforeEach(() => {
  vi.clearAllMocks();
  addMock.mockImplementation(async (_name: string, _data: unknown, opts: { jobId?: string }) => ({ id: opts.jobId ?? 'job-1' }));
  getJobMock.mockResolvedValue(null);
  getRepeatableJobsMock.mockResolvedValue([]);
});

describe('ai-model-discovery queue', () => {
  it('uses the index names', () => {
    expect(AI_MODEL_DISCOVERY_QUEUE).toBe('ai-model-discovery');
    expect(SYNC_PLATFORM_JOB).toBe('sync-platform');
  });

  it('schedules exactly one daily sync-platform repeatable with a stable job id', async () => {
    getRepeatableJobsMock.mockResolvedValue([{ key: 'old-key' }]);
    await scheduleAiModelDiscoveryJobs();
    expect(removeRepeatableByKeyMock).toHaveBeenCalledWith('old-key');
    expect(addMock).toHaveBeenCalledWith(
      'sync-platform',
      { type: 'sync-platform', trigger: 'schedule' },
      expect.objectContaining({ jobId: __testOnly.DAILY_REPEAT_JOB_ID, repeat: { pattern: __testOnly.DAILY_CRON }, attempts: 3 }),
    );
    expect(__testOnly.DAILY_REPEAT_JOB_ID).not.toContain(':');
  });

  it('a manual refresh enqueues sync-platform under the manual job id and reuses a waiting one', async () => {
    expect(await enqueuePlatformModelSync('manual')).toEqual({ id: __testOnly.MANUAL_JOB_ID });
    expect(addMock).toHaveBeenLastCalledWith('sync-platform', { type: 'sync-platform', trigger: 'manual' }, expect.objectContaining({ jobId: __testOnly.MANUAL_JOB_ID }));
    getJobMock.mockResolvedValue({ id: __testOnly.MANUAL_JOB_ID, getState: async () => 'waiting' });
    addMock.mockClear();
    expect(await enqueuePlatformModelSync('manual')).toEqual({ id: __testOnly.MANUAL_JOB_ID });
    expect(addMock).not.toHaveBeenCalled();
  });

  it('init starts the worker, schedules the daily job, and enqueues a delayed boot sync', async () => {
    await initializeAiModelDiscoveryWorker();
    expect(capturedProcessor.current).toBeTypeOf('function');
    expect(addMock).toHaveBeenCalledWith('sync-platform', { type: 'sync-platform', trigger: 'boot' }, expect.objectContaining({ jobId: __testOnly.BOOT_JOB_ID, delay: 60_000 }));
    await shutdownAiModelDiscoveryWorker();
  });

  it('a failed sync throws so BullMQ retries; ok and skipped reports are returned', async () => {
    syncMock.mockResolvedValueOnce({ status: 'failed', error: 'network down' });
    await expect(processAiModelDiscoveryJob({ data: { type: 'sync-platform', trigger: 'schedule' } })).rejects.toThrow(/network down/);
    syncMock.mockResolvedValueOnce({ status: 'skipped', reason: 'no_platform_key' });
    await expect(processAiModelDiscoveryJob({ data: { type: 'sync-platform', trigger: 'manual' } }))
      .resolves.toEqual({ status: 'skipped', reason: 'no_platform_key' });
  });

  it('rejects an unknown job type', async () => {
    await expect(processAiModelDiscoveryJob({ data: { type: 'sync-connection' } as never })).rejects.toThrow(/Unknown/);
  });
});
```

- [ ] **Step 2: Run it and watch it fail**

Run: `cd apps/api && npx vitest run src/jobs/aiModelDiscoveryWorker.test.ts`

Expected: FAIL with `Failed to resolve import "./aiModelDiscoveryWorker"`.

- [ ] **Step 3: Implement the worker and register it**

```ts
// apps/api/src/jobs/aiModelDiscoveryWorker.ts
/**
 * AI model registry (#7598) discovery queue. W01: `sync-platform` (daily,
 * manual "Refresh", and once shortly after boot). W03 adds
 * `sync-connection:{id}` for BYOK keys.
 */
import { Queue, Worker, type Job } from 'bullmq';
import { enqueueOrReplaceStale } from '../services/bullmqUtils';
import { getBullMQConnection } from '../services/redis';
import { captureException } from '../services/sentry';
import { syncPlatformModels, type SyncReport } from '../services/aiModels/discovery';
import { jobSchedule } from './scheduleRegistry';
import { attachWorkerObservability } from './workerObservability';

export const AI_MODEL_DISCOVERY_QUEUE = 'ai-model-discovery';
export const SYNC_PLATFORM_JOB = 'sync-platform';

// BullMQ 5 rejects ':' in a custom jobId.
const DAILY_REPEAT_JOB_ID = 'ai-model-discovery-sync-platform-daily';
const MANUAL_JOB_ID = 'ai-model-discovery-sync-platform-manual';
const BOOT_JOB_ID = 'ai-model-discovery-sync-platform-boot';
const DAILY_CRON = jobSchedule('ai-model-discovery-sync');
const BOOT_DELAY_MS = 60_000;

export type AiModelDiscoveryJobData = { type: 'sync-platform'; trigger: 'schedule' | 'manual' | 'boot' };

let queue: Queue<AiModelDiscoveryJobData> | null = null;
let worker: Worker<AiModelDiscoveryJobData> | null = null;

export function getAiModelDiscoveryQueue(): Queue<AiModelDiscoveryJobData> {
  if (!queue) queue = new Queue<AiModelDiscoveryJobData>(AI_MODEL_DISCOVERY_QUEUE, { connection: getBullMQConnection() });
  return queue;
}

export async function processAiModelDiscoveryJob(job: Pick<Job<AiModelDiscoveryJobData>, 'data'>): Promise<SyncReport> {
  if (job.data.type !== 'sync-platform') {
    throw new Error(`Unknown ai-model-discovery job type: ${String((job.data as { type?: unknown }).type)}`);
  }
  const report = await syncPlatformModels();
  // A failed listing changed nothing (spec §6). Throwing lets BullMQ retry with backoff.
  if (report.status === 'failed') throw new Error(`Platform model sync failed: ${report.error}`);
  if (report.status === 'skipped') console.info(`[aiModelDiscovery] platform sync skipped: ${report.reason}`);
  return report;
}

export async function enqueuePlatformModelSync(trigger: 'manual' | 'boot' = 'manual'): Promise<{ id: string }> {
  return enqueueOrReplaceStale(
    getAiModelDiscoveryQueue() as unknown as Queue,
    SYNC_PLATFORM_JOB,
    trigger === 'manual' ? MANUAL_JOB_ID : BOOT_JOB_ID,
    { type: 'sync-platform', trigger } satisfies AiModelDiscoveryJobData,
    {
      attempts: 3,
      backoff: { type: 'exponential', delay: 60_000 },
      removeOnComplete: { count: 20 },
      removeOnFail: { count: 50 },
      ...(trigger === 'boot' ? { delay: BOOT_DELAY_MS } : {}),
    },
    '[aiModelDiscovery]',
  );
}

export async function scheduleAiModelDiscoveryJobs(): Promise<void> {
  const q = getAiModelDiscoveryQueue();
  for (const job of await q.getRepeatableJobs()) await q.removeRepeatableByKey(job.key);
  await q.add(SYNC_PLATFORM_JOB, { type: 'sync-platform', trigger: 'schedule' }, {
    jobId: DAILY_REPEAT_JOB_ID,
    repeat: { pattern: DAILY_CRON },
    attempts: 3,
    backoff: { type: 'exponential', delay: 60_000 },
    removeOnComplete: { count: 10 },
    removeOnFail: { count: 25 },
  });
}

export async function initializeAiModelDiscoveryWorker(): Promise<void> {
  worker = new Worker<AiModelDiscoveryJobData>(AI_MODEL_DISCOVERY_QUEUE, processAiModelDiscoveryJob, {
    connection: getBullMQConnection(),
    concurrency: 1,
  });
  attachWorkerObservability(worker, 'aiModelDiscoveryWorker');
  worker.on('error', (error) => {
    console.error('[aiModelDiscovery] worker error:', error);
    captureException(error);
  });
  worker.on('failed', (job, error) => {
    console.error(`[aiModelDiscovery] job ${job?.id ?? '?'} failed:`, error);
    captureException(error);
  });
  await scheduleAiModelDiscoveryJobs();
  await enqueuePlatformModelSync('boot');
}

export async function shutdownAiModelDiscoveryWorker(): Promise<void> {
  if (worker) {
    await worker.close();
    worker = null;
  }
  if (queue) {
    await queue.close();
    queue = null;
  }
}

export const __testOnly = { DAILY_REPEAT_JOB_ID, MANUAL_JOB_ID, BOOT_JOB_ID, DAILY_CRON };
```

Registry entries:

`apps/api/src/jobs/scheduleRegistry.ts`, inside `JOB_SCHEDULES`:
```ts
  // AI model registry W01 (#7599): daily Anthropic model discovery for the platform key.
  'ai-model-discovery-sync': '38 6 * * *',
```

`apps/api/src/services/workerRegistry.ts`, append to `WORKER_REGISTRY`:
```ts
  // AI model registry W01 (#7599): platform model discovery (ai-model-discovery queue).
  {
    name: 'aiModelDiscoveryWorker',
    placement: 'global',
    load: async () => {
      const m = await import('../jobs/aiModelDiscoveryWorker');
      return { init: m.initializeAiModelDiscoveryWorker, shutdown: m.shutdownAiModelDiscoveryWorker };
    },
  },
```

`apps/api/src/services/workerRegistry.test.ts`, append to `EXPECTED_WORKER_NAMES` (same position as the registry):
```ts
  // AI model registry W01 (#7599).
  'aiModelDiscoveryWorker',
```

`apps/api/src/services/workerEntrypointClosure.contract.test.ts`, add to `EXPECTED_NAMES`:
```ts
  'aiModelDiscoveryWorker',
```

`apps/api/src/jobs/workerReadinessManifest.ts`, next to `consumers('pax8SyncWorker'),`:
```ts
  consumers('aiModelDiscoveryWorker'),
```

- [ ] **Step 4: Run the worker test and every registration contract**

Run:
```bash
cd apps/api && npx vitest run src/jobs/aiModelDiscoveryWorker.test.ts src/jobs/scheduleRegistry.contract.test.ts \
  src/services/workerRegistry.test.ts src/services/workerEntrypointClosure.contract.test.ts \
  src/jobs/workerReadinessManifest.test.ts src/jobs/workerReadinessCoverage.test.ts
```

Expected: PASS.
- If `scheduleRegistry.contract.test.ts` reports a minute clash for `38 6`, pick another free minute ≡ 3 (mod 5), for example `53 6` or `13 6`, and re-run.
- If `workerEntrypointClosure` says the entry's import closure reaches socket-local dispatch, change `placement` to what the test names and record why in the entry's comment. `discovery.ts` imports only `db`, `opsAlerts`, `sentry` and `platformModels`, so `global` is expected.

- [ ] **Step 5: Commit**

```bash
git add apps/api/src/jobs/aiModelDiscoveryWorker.ts apps/api/src/jobs/aiModelDiscoveryWorker.test.ts \
  apps/api/src/jobs/scheduleRegistry.ts apps/api/src/services/workerRegistry.ts apps/api/src/services/workerRegistry.test.ts \
  apps/api/src/services/workerEntrypointClosure.contract.test.ts apps/api/src/jobs/workerReadinessManifest.ts
git commit -m "feat(ai): ai-model-discovery queue: daily, manual and boot platform model sync (#7599)

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

## Task 15: `/admin/ai-models` API (platform admin + MFA)

This mirrors `routes/admin/llmProviderCatalog.ts`:
- `GET /` is open to any platform admin (via `platformAdminMiddleware` in `admin/index.ts`).
- Mutating verbs add `requireMfa()`.
- Every mutation writes a decisive audit row (`platform_admin.ai_models.*`) on top of the middleware's method+path row.

**Files:**
- Create: `apps/api/src/routes/admin/aiModels.ts`
- Create: `apps/api/src/routes/admin/aiModels.test.ts`
- Modify: `apps/api/src/routes/admin/index.ts`. Import, then mount `adminRoutes.route('/ai-models', aiModelsAdminRoutes);` after the `/llm-provider-catalog` mount.
- Modify: `apps/api/src/services/mcpCoverage.ts`. Add `'admin/aiModels.ts': { exempt: 'platform_admin' },` (alphabetically, after `'admin/abuse.ts'`).

**Interfaces:**
- Consumes:
  - `listPlatformModels`, `getPlatformModelById`, `updatePlatformModelAdmin`, `PlatformModelError`, `PlatformModel` (Tasks 7, 9);
  - `deriveCapabilities` (Task 3);
  - `enqueuePlatformModelSync` (Task 14);
  - `modelRatesSchema`, `optionRatesSchema`, `optionSupportSchema`, `PROMPT_PROFILES` (Task 2);
  - `planTypeEnum` (`db/schema/orgs.ts`).
- Produces:
  - `export const aiModelsAdminRoutes: Hono`;
  - `export interface AdminPlatformModelDto`;
  - HTTP contract:
    - `GET /admin/ai-models` → `{ models: AdminPlatformModelDto[], planOptions: string[] }`
    - `POST /admin/ai-models/refresh` → `202 { queued: true, jobId }`
    - `PATCH /admin/ai-models/:id` with a strict body `{ rates?, optionRates?, optionSupport?, minPlan?, promptProfile?, platformOffered?, isPlatformDefault? }` → `200 { model: AdminPlatformModelDto }`; `400` / `404` / `409` → `{ error }`.
  ```ts
  export interface AdminPlatformModelDto {
    id: string; modelId: string; displayName: string; maxInputTokens: number | null; maxOutputTokens: number | null;
    derived: { thinkingMode: ThinkingMode; effortLevels: EffortLevel[]; supportsTools: boolean; supportsVision: boolean };
    rates: ModelRates | null; optionRates: OptionRates | null; optionSupport: OptionSupport;
    minPlan: string | null; promptProfile: PromptProfile; platformOffered: boolean; isPlatformDefault: boolean;
    lifecycle: ModelLifecycle; firstSeenAt: string; lastSeenAt: string | null; updatedAt: string;
  }
  ```

- [ ] **Step 1: Write the failing test**

```ts
// apps/api/src/routes/admin/aiModels.test.ts
import { beforeEach, describe, expect, it, vi } from 'vitest';

const MODEL_ID = '11111111-1111-4111-8111-111111111111';
const ADMIN_ID = '33333333-3333-4333-8333-333333333333';

const { serviceMocks, enqueueMock, createAuditLogAsyncMock } = vi.hoisted(() => ({
  serviceMocks: {
    listPlatformModels: vi.fn(),
    getPlatformModelById: vi.fn(),
    updatePlatformModelAdmin: vi.fn(),
  },
  enqueueMock: vi.fn(),
  createAuditLogAsyncMock: vi.fn(async () => undefined),
}));

vi.mock('../../services/aiModels/platformModels', () => ({
  ...serviceMocks,
  PlatformModelError: class PlatformModelError extends Error {
    constructor(message: string, readonly status: number) { super(message); }
  },
}));
vi.mock('../../jobs/aiModelDiscoveryWorker', () => ({ enqueuePlatformModelSync: enqueueMock }));
vi.mock('../../services/auditService', () => ({ createAuditLog: vi.fn(async () => undefined), createAuditLogAsync: createAuditLogAsyncMock }));
vi.mock('../../services/clientIp', () => ({ getTrustedClientIpOrUndefined: vi.fn(() => '127.0.0.1') }));
vi.mock('../../middleware/auth', async () => {
  const actual = await vi.importActual<typeof import('../../middleware/auth')>('../../middleware/auth');
  const { HTTPException } = await import('hono/http-exception');
  return {
    ...actual,
    authMiddleware: vi.fn(async (c: any, next: () => Promise<void>) => {
      if (!c.get('auth')) throw new HTTPException(401, { message: 'Not authenticated' });
      await next();
    }),
  };
});

import { Hono } from 'hono';
import { adminRoutes } from './index';
import { PlatformModelError } from '../../services/aiModels/platformModels';

type FakeAuth = { user: { id: string; email: string; name: string; isPlatformAdmin: boolean }; token: { mfa: boolean } };
const admin: FakeAuth = { user: { id: ADMIN_ID, email: 'admin@breeze.test', name: 'Admin', isPlatformAdmin: true }, token: { mfa: true } };
const adminNoMfa: FakeAuth = { ...admin, token: { mfa: false } };
const partnerUser: FakeAuth = { user: { ...admin.user, id: '44444444-4444-4444-8444-444444444444', isPlatformAdmin: false }, token: { mfa: true } };

const RATES = { inputCentsPerM: 400, outputCentsPerM: 2000, cacheReadCentsPerM: 20, cacheWriteCentsPerM: 500 };
const AT = new Date('2026-11-13T00:00:00.000Z');
const MODEL = {
  id: MODEL_ID, provider: 'anthropic', modelId: 'claude-opus-5-5', displayName: 'Claude Opus 5.5',
  maxInputTokens: 1_000_000, maxOutputTokens: 128_000,
  capabilities: { thinking: { supported: true, types: { adaptive: { supported: true }, enabled: { supported: false } } }, effort: { supported: true, low: { supported: true }, medium: { supported: true }, high: { supported: true }, xhigh: { supported: true }, max: { supported: true } }, image_input: { supported: true } },
  rates: RATES, optionRates: null,
  optionSupport: { effort: ['low', 'medium'], thinkingDisplay: ['omitted'], speed: ['standard'], inferenceGeo: [] },
  minPlan: null, promptProfile: 'claude-frontier', platformOffered: true, isPlatformDefault: false, lifecycle: 'available',
  missedSyncCount: 0, operatorNotifiedAt: AT, firstSeenAt: AT, lastSeenAt: null, updatedAt: AT,
};

function buildApp(auth: FakeAuth | null) {
  const app = new Hono();
  app.use('*', async (c, next) => {
    if (auth) c.set('auth', auth as never);
    await next();
  });
  app.route('/admin', adminRoutes);
  return app;
}

function send(app: Hono, path: string, method: 'POST' | 'PATCH', body?: unknown) {
  return app.request(path, { method, headers: { 'content-type': 'application/json' }, body: body === undefined ? undefined : JSON.stringify(body) });
}

beforeEach(() => {
  vi.clearAllMocks();
  serviceMocks.listPlatformModels.mockResolvedValue([MODEL]);
  serviceMocks.updatePlatformModelAdmin.mockResolvedValue({ before: MODEL, after: { ...MODEL, minPlan: 'pro' } });
  enqueueMock.mockResolvedValue({ id: 'ai-model-discovery-sync-platform-manual' });
});

describe('/admin/ai-models', () => {
  it('lists models with derived capabilities and the plan options; never the raw capabilities tree', async () => {
    const res = await buildApp(admin).request('/admin/ai-models');
    expect(res.status).toBe(200);
    const body = await res.json() as { models: Array<Record<string, unknown>>; planOptions: string[] };
    expect(body.models[0]).toMatchObject({
      id: MODEL_ID, modelId: 'claude-opus-5-5', rates: RATES, lifecycle: 'available', lastSeenAt: null,
      derived: { thinkingMode: 'adaptive', effortLevels: ['low', 'medium', 'high', 'xhigh', 'max'], supportsTools: true, supportsVision: true },
    });
    expect(body.models[0]).not.toHaveProperty('capabilities');
    expect(body.planOptions).toEqual(['free', 'starter', 'community', 'pro', 'enterprise', 'unlimited']);
  });

  it('403s a non-platform-admin', async () => {
    expect((await buildApp(partnerUser).request('/admin/ai-models')).status).toBe(403);
  });

  it('requires MFA for mutations', async () => {
    const res = await send(buildApp(adminNoMfa), `/admin/ai-models/${MODEL_ID}`, 'PATCH', { minPlan: 'pro' });
    expect(res.status).toBe(403);
    expect((await res.json() as { code: string }).code).toBe('MFA_REQUIRED');
    expect(serviceMocks.updatePlatformModelAdmin).not.toHaveBeenCalled();
  });

  it('PATCH applies a validated patch and audits the decisive values', async () => {
    const res = await send(buildApp(admin), `/admin/ai-models/${MODEL_ID}`, 'PATCH', { minPlan: 'pro' });
    expect(res.status).toBe(200);
    expect(serviceMocks.updatePlatformModelAdmin).toHaveBeenCalledWith(MODEL_ID, { minPlan: 'pro' });
    expect((await res.json() as { model: { minPlan: string } }).model.minPlan).toBe('pro');
    expect(createAuditLogAsyncMock).toHaveBeenCalledWith(expect.objectContaining({
      action: 'platform_admin.ai_models.updated',
      resourceType: 'ai_platform_model',
      resourceId: MODEL_ID,
      details: expect.objectContaining({ modelId: 'claude-opus-5-5', changed: ['minPlan'] }),
    }));
  });

  it.each([
    ['an unknown key', { price: 1 }],
    ['an empty body', {}],
    ['a negative rate', { rates: { ...RATES, inputCentsPerM: -1 } }],
    ['a partial rate set', { rates: { inputCentsPerM: 1 } }],
    ['an unknown plan', { minPlan: 'gold' }],
    ['speed without standard', { optionSupport: { effort: [], thinkingDisplay: [], speed: ['fast'], inferenceGeo: [] } }],
  ])('400s %s without calling the service', async (_label, body) => {
    const res = await send(buildApp(admin), `/admin/ai-models/${MODEL_ID}`, 'PATCH', body);
    expect(res.status).toBe(400);
    expect(serviceMocks.updatePlatformModelAdmin).not.toHaveBeenCalled();
  });

  it('maps a PlatformModelError to its status and message', async () => {
    serviceMocks.updatePlatformModelAdmin.mockRejectedValue(new PlatformModelError('Make another model the default first.', 409));
    const res = await send(buildApp(admin), `/admin/ai-models/${MODEL_ID}`, 'PATCH', { isPlatformDefault: false });
    expect(res.status).toBe(409);
    expect(await res.json()).toEqual({ error: 'Make another model the default first.' });
  });

  it('POST /refresh enqueues a manual sync and audits it', async () => {
    const res = await send(buildApp(admin), '/admin/ai-models/refresh', 'POST');
    expect(res.status).toBe(202);
    expect(await res.json()).toEqual({ queued: true, jobId: 'ai-model-discovery-sync-platform-manual' });
    expect(enqueueMock).toHaveBeenCalledWith('manual');
    expect(createAuditLogAsyncMock).toHaveBeenCalledWith(expect.objectContaining({ action: 'platform_admin.ai_models.refresh_requested' }));
  });
});
```

- [ ] **Step 2: Run it and watch it fail**

Run: `cd apps/api && npx vitest run src/routes/admin/aiModels.test.ts`

Expected: FAIL. `GET /admin/ai-models` returns 404 because the route isn't mounted.

- [ ] **Step 3: Implement**

```ts
// apps/api/src/routes/admin/aiModels.ts
/**
 * AI model registry W01 (#7599): /admin/ai-models, the platform model
 * catalog's operator surface (spec §11). Mounted under platformAdminMiddleware
 * (admin/index.ts); mutations add requireMfa(). Writes go only through
 * updatePlatformModelAdmin, whose rules and DB CHECKs keep:
 * - offered ⇒ priced;
 * - exactly one default, and the default stays offered.
 */
import { Hono } from 'hono';
import type { Context } from 'hono';
import { z } from 'zod';
import {
  PROMPT_PROFILES,
  modelRatesSchema,
  optionRatesSchema,
  optionSupportSchema,
  type EffortLevel,
  type ModelLifecycle,
  type ModelRates,
  type OptionRates,
  type OptionSupport,
  type PromptProfile,
} from '@breeze/shared';
import { zValidator } from '../../lib/validation';
import { requireMfa } from '../../middleware/auth';
import { planTypeEnum } from '../../db/schema';
import {
  PlatformModelError,
  listPlatformModels,
  updatePlatformModelAdmin,
  type PlatformModel,
} from '../../services/aiModels/platformModels';
import { deriveCapabilities, type ThinkingMode } from '../../services/aiModels/capabilities';
import { enqueuePlatformModelSync } from '../../jobs/aiModelDiscoveryWorker';
import { createAuditLogAsync } from '../../services/auditService';
import { getTrustedClientIpOrUndefined } from '../../services/clientIp';

export interface AdminPlatformModelDto {
  id: string;
  modelId: string;
  displayName: string;
  maxInputTokens: number | null;
  maxOutputTokens: number | null;
  derived: { thinkingMode: ThinkingMode; effortLevels: EffortLevel[]; supportsTools: boolean; supportsVision: boolean };
  rates: ModelRates | null;
  optionRates: OptionRates | null;
  optionSupport: OptionSupport;
  minPlan: string | null;
  promptProfile: PromptProfile;
  platformOffered: boolean;
  isPlatformDefault: boolean;
  lifecycle: ModelLifecycle;
  firstSeenAt: string;
  lastSeenAt: string | null;
  updatedAt: string;
}

function toDto(model: PlatformModel): AdminPlatformModelDto {
  return {
    id: model.id,
    modelId: model.modelId,
    displayName: model.displayName,
    maxInputTokens: model.maxInputTokens,
    maxOutputTokens: model.maxOutputTokens,
    derived: deriveCapabilities(model.capabilities),
    rates: model.rates,
    optionRates: model.optionRates,
    optionSupport: model.optionSupport,
    minPlan: model.minPlan,
    promptProfile: model.promptProfile,
    platformOffered: model.platformOffered,
    isPlatformDefault: model.isPlatformDefault,
    lifecycle: model.lifecycle,
    firstSeenAt: model.firstSeenAt.toISOString(),
    lastSeenAt: model.lastSeenAt?.toISOString() ?? null,
    updatedAt: model.updatedAt.toISOString(),
  };
}

const idParamSchema = z.object({ id: z.string().uuid() });

const patchSchema = z.object({
  rates: modelRatesSchema.nullable().optional(),
  optionRates: optionRatesSchema.nullable().optional(),
  optionSupport: optionSupportSchema.optional(),
  minPlan: z.enum(planTypeEnum.enumValues).nullable().optional(),
  promptProfile: z.enum(PROMPT_PROFILES).optional(),
  platformOffered: z.boolean().optional(),
  isPlatformDefault: z.boolean().optional(),
}).strict().refine((patch) => Object.keys(patch).length > 0, { message: 'Nothing to update' });

function audit(c: Context, action: string, resourceId: string | null, details: Record<string, unknown>): void {
  const auth = c.get('auth');
  void createAuditLogAsync({
    orgId: null,
    actorType: 'user',
    actorId: auth.user.id,
    actorEmail: auth.user.email,
    action: `platform_admin.ai_models.${action}`,
    resourceType: 'ai_platform_model',
    ...(resourceId ? { resourceId } : {}),
    details,
    ipAddress: getTrustedClientIpOrUndefined(c),
    userAgent: c.req.header('user-agent'),
    result: 'success',
  });
}

export const aiModelsAdminRoutes = new Hono();
const mutationRoutes = new Hono();

aiModelsAdminRoutes.get('/', async (c) => {
  const models = await listPlatformModels();
  return c.json({ models: models.map(toDto), planOptions: [...planTypeEnum.enumValues] });
});

mutationRoutes.use('*', requireMfa());

mutationRoutes.post('/refresh', async (c) => {
  // Redis round trip only (no DB, no outbound HTTP), so it runs inline like
  // enqueuePax8Sync in routes/pax8.ts.
  const job = await enqueuePlatformModelSync('manual');
  audit(c, 'refresh_requested', null, { jobId: job.id });
  return c.json({ queued: true, jobId: job.id }, 202);
});

mutationRoutes.patch(
  '/:id',
  zValidator('param', idParamSchema),
  zValidator('json', patchSchema),
  async (c) => {
    const { id } = c.req.valid('param');
    const patch = c.req.valid('json');
    try {
      const { before, after } = await updatePlatformModelAdmin(id, patch);
      // Prices, offer and default are decisive (they move hosted billing), so
      // their before/after values go into the trail.
      audit(c, 'updated', id, {
        modelId: after.modelId,
        changed: Object.keys(patch).sort(),
        before: { rates: before.rates, optionRates: before.optionRates, platformOffered: before.platformOffered, isPlatformDefault: before.isPlatformDefault, minPlan: before.minPlan },
        after: { rates: after.rates, optionRates: after.optionRates, platformOffered: after.platformOffered, isPlatformDefault: after.isPlatformDefault, minPlan: after.minPlan },
      });
      return c.json({ model: toDto(after) });
    } catch (error) {
      if (error instanceof PlatformModelError) return c.json({ error: error.message }, error.status as 400 | 404 | 409);
      throw error;
    }
  },
);

aiModelsAdminRoutes.route('/', mutationRoutes);
```

`apps/api/src/routes/admin/index.ts`. Add the import after the `llmProviderCatalogAdminRoutes` import:
```ts
import { aiModelsAdminRoutes } from './aiModels';
```
Mount after `adminRoutes.route('/llm-provider-catalog', llmProviderCatalogAdminRoutes);`:
```ts
// AI model registry W01 (#7599): platform model catalog: prices, option
// support, plan gate, prompt profile, platform offer/default. Global rows, so
// platform-admin (gate above) + MFA on mutations, like the provider catalog.
adminRoutes.route('/ai-models', aiModelsAdminRoutes);
```

`apps/api/src/services/mcpCoverage.ts`, after `'admin/abuse.ts': { exempt: 'platform_admin' },`:
```ts
  'admin/aiModels.ts': { exempt: 'platform_admin' },
```

- [ ] **Step 4: Run it and the route-scan contracts and watch them pass**

Run: `cd apps/api && npx vitest run src/routes/admin/aiModels.test.ts src/routes/admin/llmProviderCatalog.test.ts src/__tests__/mcp-coverage.test.ts src/__tests__/helpers/routeScan.test.ts`

Expected: PASS.

If `zValidator` turns a schema refine failure into a response other than 400, compare with `lib/validation.ts`. Every route in the repo relies on it returning 400; adjust only the test's expectation text, never the status.

- [ ] **Step 5: Commit**

```bash
git add apps/api/src/routes/admin/aiModels.ts apps/api/src/routes/admin/aiModels.test.ts \
  apps/api/src/routes/admin/index.ts apps/api/src/services/mcpCoverage.ts
git commit -m "feat(ai): /admin/ai-models: platform model prices, options, gates, offer and default (#7599)

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

## Task 16: `/admin/ai-models` web page; the provider catalog reads its model list from it

Settings-rules note (2026-09-17 audit): platform model prices now have one home, this page. Before W01 they lived in two places, `MODEL_PRICING` in code and a hard-coded copy of the offerable list in `LlmProviderCatalog.tsx`. After W01, `/admin/ai-models` is the only place they are set; the provider catalog reads its list from here (spec §11). The save pattern is row drawer Save. "Refresh models" is an action, not a setting.

**Files:**
- Create: `apps/web/src/pages/admin/ai-models.astro`
- Create: `apps/web/src/components/admin/AiModels.tsx`
- Create: `apps/web/src/components/admin/AiModels.test.tsx`
- Modify: `apps/web/src/components/admin/LlmProviderCatalog.tsx` (remove the `OFFERABLE_AI_MODELS` copy; load ids from `/admin/ai-models`) + `LlmProviderCatalog.test.tsx`
- Modify: `apps/web/src/components/layout/Sidebar.tsx`. In the `administration` section, after the `LLM Provider Catalog` item (~L405), add the entry.
- Modify: `apps/web/src/locales/<locale>/admin.json` (`admin.aiModels.*`), `common.json` (`nav.aiModels`), `pages.json` (`titles.adminAiModels`) for all 8 locales: `en`, `pt-BR`, `es-419`, `fr-FR`, `fr-CA`, `de-DE`, `it-IT`, `tr-TR`.
- Modify: `apps/web/src/lib/__tests__/no-silent-mutations.test.ts`. Add `'src/components/admin/AiModels.tsx'` to `TARGET_GLOBS` and bump the expected file count by one.

**Interfaces:**
- Consumes: the Task 15 HTTP contract; `EFFORT_LEVELS`, `THINKING_DISPLAYS`, `PROMPT_PROFILES` and the shared types (Task 2); `fetchWithAuth` (`@/stores/auth`); `runAction`, `ActionError` (`@/lib/runAction`); `showToast` (`../shared/Toast`); `Drawer` (`../shared/Drawer`); `useStableT`.
- Produces: `export default function AiModels()` and `export interface AdminPlatformModel` (the web mirror of `AdminPlatformModelDto`).

- [ ] **Step 1: Write the failing component test**

```tsx
// apps/web/src/components/admin/AiModels.test.tsx
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const fetchWithAuth = vi.fn();
vi.mock('../../stores/auth', () => ({ fetchWithAuth: (...a: unknown[]) => fetchWithAuth(...a) }));
const showToast = vi.fn();
vi.mock('../shared/Toast', () => ({ showToast: (...a: unknown[]) => showToast(...a) }));

// Deliberately NOT mocking runAction: the real wrapper must surface the API's error text.
import AiModels, { type AdminPlatformModel } from './AiModels';

function jsonRes(body: unknown, status = 200) {
  return { ok: status >= 200 && status < 300, status, json: async () => body } as unknown as Response;
}

const RATES = { inputCentsPerM: 400, outputCentsPerM: 2000, cacheReadCentsPerM: 20, cacheWriteCentsPerM: 500 };
const OPUS: AdminPlatformModel = {
  id: 'id-opus', modelId: 'claude-opus-5-5', displayName: 'Claude Opus 5.5', maxInputTokens: 1_000_000, maxOutputTokens: 128_000,
  derived: { thinkingMode: 'adaptive', effortLevels: ['low', 'medium', 'high', 'xhigh', 'max'], supportsTools: true, supportsVision: true },
  rates: RATES, optionRates: null,
  optionSupport: { effort: ['low', 'medium', 'high', 'xhigh', 'max'], thinkingDisplay: ['omitted', 'summarized', 'updates'], speed: ['standard', 'fast'], inferenceGeo: [] },
  minPlan: null, promptProfile: 'claude-frontier', platformOffered: true, isPlatformDefault: false, lifecycle: 'available',
  firstSeenAt: '2026-11-13T00:00:00.000Z', lastSeenAt: null, updatedAt: '2026-11-13T00:00:00.000Z',
};
const NEW_MODEL: AdminPlatformModel = {
  ...OPUS, id: 'id-new', modelId: 'vendor-new-model', displayName: 'New model', rates: null, platformOffered: false,
  promptProfile: 'generic', lastSeenAt: '2026-11-20T06:38:00.000Z',
  optionSupport: { effort: ['low', 'medium', 'high', 'xhigh', 'max'], thinkingDisplay: ['omitted', 'summarized'], speed: ['standard'], inferenceGeo: [] },
};
const LIST = { models: [OPUS, NEW_MODEL], planOptions: ['free', 'starter', 'community', 'pro', 'enterprise', 'unlimited'] };

function mockApi(handlers: Record<string, () => Response> = {}) {
  fetchWithAuth.mockImplementation((url: string, options?: RequestInit) => {
    const method = options?.method ?? 'GET';
    const handler = handlers[`${method} ${url}`];
    if (handler) return Promise.resolve(handler());
    if (method === 'GET' && url === '/admin/ai-models') return Promise.resolve(jsonRes(LIST));
    throw new Error(`Unexpected request: ${method} ${url}`);
  });
}

function patchBody(): Record<string, unknown> {
  const call = fetchWithAuth.mock.calls.find(([, opts]) => (opts as RequestInit | undefined)?.method === 'PATCH');
  return JSON.parse(String((call?.[1] as RequestInit).body));
}

beforeEach(() => {
  fetchWithAuth.mockReset();
  showToast.mockReset();
});

describe('AiModels admin page', () => {
  it('lists models with price, lifecycle and a New badge on unpriced discoveries', async () => {
    mockApi();
    render(<AiModels />);
    expect(await screen.findByTestId('ai-models-row-id-opus')).toBeTruthy();
    expect(screen.getByTestId('ai-models-row-id-opus-price').textContent).toBe('$4.00 / $20.00');
    expect(screen.getByTestId('ai-models-row-id-new-price').textContent).toBe('Unpriced');
    expect(screen.getByTestId('ai-models-row-id-new-new')).toBeTruthy();
    expect(screen.queryByTestId('ai-models-row-id-opus-new')).toBeNull();
  });

  it('shows the platform-admin panel on 403', async () => {
    fetchWithAuth.mockResolvedValue(jsonRes({ error: 'forbidden' }, 403));
    render(<AiModels />);
    expect(await screen.findByTestId('ai-models-requires-platform-admin')).toBeTruthy();
  });

  it('saves a priced, offered model through the row drawer with PATCH', async () => {
    mockApi({ 'PATCH /admin/ai-models/id-new': () => jsonRes({ model: { ...NEW_MODEL, rates: RATES, platformOffered: true } }) });
    render(<AiModels />);
    fireEvent.click(await screen.findByTestId('ai-models-row-id-new-edit'));
    expect(await screen.findByTestId('ai-models-drawer')).toBeTruthy();
    fireEvent.change(screen.getByTestId('ai-models-rate-inputCentsPerM'), { target: { value: '400' } });
    fireEvent.change(screen.getByTestId('ai-models-rate-outputCentsPerM'), { target: { value: '2000' } });
    fireEvent.change(screen.getByTestId('ai-models-rate-cacheReadCentsPerM'), { target: { value: '20' } });
    fireEvent.change(screen.getByTestId('ai-models-rate-cacheWriteCentsPerM'), { target: { value: '500' } });
    fireEvent.click(screen.getByTestId('ai-models-offered'));
    fireEvent.change(screen.getByTestId('ai-models-min-plan'), { target: { value: 'pro' } });
    fireEvent.click(screen.getByTestId('ai-models-save'));
    await waitFor(() => expect(patchBody()).toEqual({
      rates: RATES,
      optionRates: null,
      optionSupport: { effort: ['low', 'medium', 'high', 'xhigh', 'max'], thinkingDisplay: ['omitted', 'summarized'], speed: ['standard'], inferenceGeo: [] },
      minPlan: 'pro',
      promptProfile: 'generic',
      platformOffered: true,
      isPlatformDefault: false,
    }));
    await waitFor(() => expect(showToast).toHaveBeenCalledWith(expect.objectContaining({ type: 'success' })));
  });

  it('refuses a partial price set before calling the API', async () => {
    mockApi();
    render(<AiModels />);
    fireEvent.click(await screen.findByTestId('ai-models-row-id-new-edit'));
    fireEvent.change(await screen.findByTestId('ai-models-rate-inputCentsPerM'), { target: { value: '400' } });
    fireEvent.click(screen.getByTestId('ai-models-save'));
    await waitFor(() => expect(showToast).toHaveBeenCalledWith(expect.objectContaining({ type: 'error' })));
    expect(fetchWithAuth.mock.calls.some(([, opts]) => (opts as RequestInit | undefined)?.method === 'PATCH')).toBe(false);
  });

  it('toasts the API error text when a save is refused', async () => {
    mockApi({ 'PATCH /admin/ai-models/id-opus': () => jsonRes({ error: 'Set all four prices before offering this model.' }, 400) });
    render(<AiModels />);
    fireEvent.click(await screen.findByTestId('ai-models-row-id-opus-edit'));
    fireEvent.click(await screen.findByTestId('ai-models-save'));
    await waitFor(() => expect(showToast).toHaveBeenCalledWith(expect.objectContaining({
      type: 'error', message: 'Set all four prices before offering this model.',
    })));
  });

  it('queues a refresh', async () => {
    mockApi({ 'POST /admin/ai-models/refresh': () => jsonRes({ queued: true, jobId: 'j' }, 202) });
    render(<AiModels />);
    await screen.findByTestId('ai-models-table');
    fireEvent.click(screen.getByTestId('ai-models-refresh'));
    await waitFor(() => expect(showToast).toHaveBeenCalledWith(expect.objectContaining({ type: 'success', message: 'Model refresh queued.' })));
  });

  it('locks the offered and default toggles on the current platform default', async () => {
    mockApi();
    const defaultModel = { ...OPUS, isPlatformDefault: true };
    fetchWithAuth.mockImplementation(() => Promise.resolve(jsonRes({ ...LIST, models: [defaultModel] })));
    render(<AiModels />);
    fireEvent.click(await screen.findByTestId('ai-models-row-id-opus-edit'));
    expect((await screen.findByTestId('ai-models-offered') as HTMLInputElement).disabled).toBe(true);
    expect((screen.getByTestId('ai-models-default') as HTMLInputElement).disabled).toBe(true);
  });
});
```

- [ ] **Step 2: Run it and watch it fail**

Run: `cd apps/web && npx vitest run src/components/admin/AiModels.test.tsx`

Expected: FAIL with `Failed to resolve import "./AiModels"`.

- [ ] **Step 3: Implement the component and the page**

```tsx
// apps/web/src/components/admin/AiModels.tsx
import { useCallback, useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Loader2, Pencil, RefreshCw, Sparkles, Star } from 'lucide-react';
import {
  EFFORT_LEVELS,
  PROMPT_PROFILES,
  THINKING_DISPLAYS,
  type EffortLevel,
  type ModelLifecycle,
  type ModelRates,
  type OptionRates,
  type OptionSupport,
  type PromptProfile,
  type ThinkingDisplay,
} from '@breeze/shared';
import { fetchWithAuth } from '@/stores/auth';
import { runAction, ActionError } from '@/lib/runAction';
import { showToast } from '../shared/Toast';
import { Drawer } from '../shared/Drawer';
// Initializes the shared i18next singleton before any island renders translated text.
import '../../lib/i18n';
import { useStableT } from '@/lib/i18n/useStableT';

type ThinkingMode = 'adaptive' | 'budget' | 'none' | 'unknown';

/** Mirror of the API's AdminPlatformModelDto (apps/api/src/routes/admin/aiModels.ts). */
export interface AdminPlatformModel {
  id: string;
  modelId: string;
  displayName: string;
  maxInputTokens: number | null;
  maxOutputTokens: number | null;
  derived: { thinkingMode: ThinkingMode; effortLevels: EffortLevel[]; supportsTools: boolean; supportsVision: boolean };
  rates: ModelRates | null;
  optionRates: OptionRates | null;
  optionSupport: OptionSupport;
  minPlan: string | null;
  promptProfile: PromptProfile;
  platformOffered: boolean;
  isPlatformDefault: boolean;
  lifecycle: ModelLifecycle;
  firstSeenAt: string;
  lastSeenAt: string | null;
  updatedAt: string;
}

const RATE_KEYS = ['inputCentsPerM', 'outputCentsPerM', 'cacheReadCentsPerM', 'cacheWriteCentsPerM'] as const;
type RateKey = (typeof RATE_KEYS)[number];
type RateDraft = Record<RateKey, string>;

interface Draft {
  rates: RateDraft;
  fastRates: RateDraft;
  effort: EffortLevel[];
  thinkingDisplay: ThinkingDisplay[];
  fast: boolean;
  inferenceGeo: string;
  minPlan: string;
  promptProfile: PromptProfile;
  platformOffered: boolean;
  isPlatformDefault: boolean;
}

function ratesToDraft(rates: ModelRates | null | undefined): RateDraft {
  return {
    inputCentsPerM: rates ? String(rates.inputCentsPerM) : '',
    outputCentsPerM: rates ? String(rates.outputCentsPerM) : '',
    cacheReadCentsPerM: rates ? String(rates.cacheReadCentsPerM) : '',
    cacheWriteCentsPerM: rates ? String(rates.cacheWriteCentsPerM) : '',
  };
}

/** All four blank → null (unpriced); all four valid → rates; anything else → 'invalid'. */
function draftToRates(draft: RateDraft): ModelRates | null | 'invalid' {
  const raw = RATE_KEYS.map((key) => draft[key].trim());
  if (raw.every((value) => value === '')) return null;
  const numbers = raw.map(Number);
  if (raw.some((value) => value === '') || numbers.some((n) => !Number.isFinite(n) || n < 0)) return 'invalid';
  const [inputCentsPerM, outputCentsPerM, cacheReadCentsPerM, cacheWriteCentsPerM] = numbers as [number, number, number, number];
  return { inputCentsPerM, outputCentsPerM, cacheReadCentsPerM, cacheWriteCentsPerM };
}

function draftFrom(model: AdminPlatformModel): Draft {
  return {
    rates: ratesToDraft(model.rates),
    fastRates: ratesToDraft(model.optionRates?.['speed:fast']),
    effort: [...model.optionSupport.effort],
    thinkingDisplay: [...model.optionSupport.thinkingDisplay],
    fast: model.optionSupport.speed.includes('fast'),
    inferenceGeo: model.optionSupport.inferenceGeo.join(', '),
    minPlan: model.minPlan ?? '',
    promptProfile: model.promptProfile,
    platformOffered: model.platformOffered,
    isPlatformDefault: model.isPlatformDefault,
  };
}

function withValue<T>(list: T[], value: T, on: boolean): T[] {
  if (on) return list.includes(value) ? list : [...list, value];
  return list.filter((item) => item !== value);
}

function dollarsPerM(cents: number): string {
  return `$${(cents / 100).toFixed(2)}`;
}

function displayChoices(mode: ThinkingMode): readonly ThinkingDisplay[] {
  if (mode === 'adaptive') return THINKING_DISPLAYS;
  if (mode === 'budget') return ['omitted', 'summarized'];
  return [];
}

export default function AiModels() {
  const { t } = useTranslation('admin');
  const stableT = useStableT(t); // effect-safe translator; JSX keeps `t`
  const [models, setModels] = useState<AdminPlatformModel[]>([]);
  const [planOptions, setPlanOptions] = useState<string[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string>();
  const [requiresPlatformAdmin, setRequiresPlatformAdmin] = useState(false);
  const [refreshing, setRefreshing] = useState(false);
  const [editing, setEditing] = useState<AdminPlatformModel | null>(null);
  const [draft, setDraft] = useState<Draft | null>(null);
  const [saving, setSaving] = useState(false);

  const fetchModels = useCallback(async () => {
    setLoading(true);
    setError(undefined);
    try {
      const response = await fetchWithAuth('/admin/ai-models');
      if (!response.ok) {
        if (response.status === 403) {
          setRequiresPlatformAdmin(true);
          setModels([]);
          return;
        }
        throw new Error(stableT('admin.aiModels.errors.load'));
      }
      setRequiresPlatformAdmin(false);
      const data = (await response.json()) as { models?: AdminPlatformModel[]; planOptions?: string[] };
      setModels(Array.isArray(data.models) ? data.models : []);
      setPlanOptions(Array.isArray(data.planOptions) ? data.planOptions : []);
    } catch (err) {
      setError(err instanceof Error ? err.message : stableT('admin.aiModels.errors.load'));
    } finally {
      setLoading(false);
    }
  }, [stableT]);

  useEffect(() => {
    void fetchModels();
  }, [fetchModels]);

  const openEditor = (model: AdminPlatformModel) => {
    setEditing(model);
    setDraft(draftFrom(model));
  };

  const closeEditor = () => {
    if (saving) return;
    setEditing(null);
    setDraft(null);
  };

  const updateDraft = (patch: Partial<Draft>) => setDraft((current) => (current ? { ...current, ...patch } : current));

  const handleRefresh = async () => {
    if (refreshing) return;
    setRefreshing(true);
    try {
      await runAction({
        request: () => fetchWithAuth('/admin/ai-models/refresh', { method: 'POST' }),
        successMessage: t('admin.aiModels.notice.refreshQueued'),
        errorFallback: t('admin.aiModels.errors.refresh'),
      });
    } catch (err) {
      if (err instanceof ActionError && err.status === 401) return;
      if (!(err instanceof ActionError)) showToast({ type: 'error', message: t('admin.aiModels.errors.refresh') });
    } finally {
      setRefreshing(false);
    }
  };

  const handleSave = async () => {
    if (!editing || !draft || saving) return;
    const rates = draftToRates(draft.rates);
    const fastRates = draftToRates(draft.fastRates);
    if (rates === 'invalid' || fastRates === 'invalid') {
      showToast({ type: 'error', message: t('admin.aiModels.errors.invalidRates') });
      return;
    }
    const patch = {
      rates,
      optionRates: fastRates ? { 'speed:fast': fastRates } : null,
      optionSupport: {
        effort: EFFORT_LEVELS.filter((level) => draft.effort.includes(level)),
        thinkingDisplay: THINKING_DISPLAYS.filter((display) => draft.thinkingDisplay.includes(display)),
        speed: draft.fast ? ['standard', 'fast'] : ['standard'],
        inferenceGeo: draft.inferenceGeo.split(',').map((geo) => geo.trim().toLowerCase()).filter(Boolean),
      },
      minPlan: draft.minPlan === '' ? null : draft.minPlan,
      promptProfile: draft.promptProfile,
      platformOffered: draft.platformOffered,
      isPlatformDefault: draft.isPlatformDefault,
    };
    setSaving(true);
    try {
      await runAction({
        request: () => fetchWithAuth(`/admin/ai-models/${editing.id}`, {
          method: 'PATCH',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(patch),
        }),
        successMessage: t('admin.aiModels.notice.saved'),
        errorFallback: t('admin.aiModels.errors.save'),
      });
      setEditing(null);
      setDraft(null);
      await fetchModels();
    } catch (err) {
      if (err instanceof ActionError && err.status === 401) return;
      if (!(err instanceof ActionError)) showToast({ type: 'error', message: t('admin.aiModels.errors.save') });
    } finally {
      setSaving(false);
    }
  };

  if (requiresPlatformAdmin) {
    return (
      <div data-testid="ai-models-requires-platform-admin" className="rounded-lg border bg-white p-6 text-sm text-gray-600">
        {t('admin.aiModels.requiresPlatformAdmin')}
      </div>
    );
  }

  const locked = editing?.isPlatformDefault === true;

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-start justify-between gap-4">
        <div>
          <h1 className="flex items-center gap-2 text-xl font-semibold">
            <Sparkles className="h-5 w-5" aria-hidden="true" />
            {t('admin.aiModels.title')}
          </h1>
          <p className="mt-1 max-w-2xl text-sm text-gray-600">{t('admin.aiModels.subtitle')}</p>
        </div>
        <button
          type="button"
          data-testid="ai-models-refresh"
          onClick={() => void handleRefresh()}
          disabled={refreshing}
          className="inline-flex items-center gap-2 rounded-md border px-3 py-2 text-sm disabled:opacity-50"
        >
          {refreshing ? <Loader2 className="h-4 w-4 animate-spin" aria-hidden="true" /> : <RefreshCw className="h-4 w-4" aria-hidden="true" />}
          {t('admin.aiModels.refresh')}
        </button>
      </div>

      {error && (
        <div data-testid="ai-models-error" role="alert" className="rounded-md border border-red-200 bg-red-50 p-3 text-sm text-red-700">
          {error}
        </div>
      )}

      {loading ? (
        <div data-testid="ai-models-loading" className="flex justify-center p-8">
          <Loader2 className="h-6 w-6 animate-spin text-gray-400" aria-hidden="true" />
        </div>
      ) : models.length === 0 ? (
        <div data-testid="ai-models-empty" className="rounded-lg border bg-white p-6 text-sm text-gray-600">
          {t('admin.aiModels.empty')}
        </div>
      ) : (
        <div className="overflow-x-auto rounded-lg border bg-white">
          <table data-testid="ai-models-table" className="min-w-full text-sm">
            <thead className="bg-gray-50 text-left text-xs uppercase text-gray-500">
              <tr>
                <th className="px-3 py-2">{t('admin.aiModels.columns.model')}</th>
                <th className="px-3 py-2">{t('admin.aiModels.columns.status')}</th>
                <th className="px-3 py-2">{t('admin.aiModels.columns.thinking')}</th>
                <th className="px-3 py-2">{t('admin.aiModels.columns.price')}</th>
                <th className="px-3 py-2">{t('admin.aiModels.columns.offered')}</th>
                <th className="px-3 py-2">{t('admin.aiModels.columns.default')}</th>
                <th className="px-3 py-2 text-right">{t('admin.aiModels.columns.actions')}</th>
              </tr>
            </thead>
            <tbody>
              {models.map((model) => {
                const isNew = !model.platformOffered && model.rates === null && model.lastSeenAt !== null;
                return (
                  <tr key={model.id} data-testid={`ai-models-row-${model.id}`} className="border-t">
                    <td className="px-3 py-2">
                      <div className="font-medium">{model.displayName}</div>
                      <div className="font-mono text-xs text-gray-500">{model.modelId}</div>
                    </td>
                    <td className="px-3 py-2">
                      <span data-testid={`ai-models-row-${model.id}-lifecycle`}>
                        {t(/* i18n-dynamic */ `admin.aiModels.lifecycle.${model.lifecycle}`)}
                      </span>
                      {isNew && (
                        <span data-testid={`ai-models-row-${model.id}-new`} className="ml-2 rounded bg-amber-100 px-1.5 py-0.5 text-xs text-amber-800">
                          {t('admin.aiModels.newBadge')}
                        </span>
                      )}
                      {model.lastSeenAt === null && (
                        <div className="text-xs text-gray-500">{t('admin.aiModels.notSeen')}</div>
                      )}
                    </td>
                    <td className="px-3 py-2">{t(/* i18n-dynamic */ `admin.aiModels.thinkingMode.${model.derived.thinkingMode}`)}</td>
                    <td className="px-3 py-2" data-testid={`ai-models-row-${model.id}-price`}>
                      {model.rates
                        ? `${dollarsPerM(model.rates.inputCentsPerM)} / ${dollarsPerM(model.rates.outputCentsPerM)}`
                        : t('admin.aiModels.unpriced')}
                    </td>
                    <td className="px-3 py-2">{model.platformOffered ? t('admin.aiModels.yes') : t('admin.aiModels.no')}</td>
                    <td className="px-3 py-2">
                      {model.isPlatformDefault && (
                        <Star data-testid={`ai-models-row-${model.id}-default`} aria-label={t('admin.aiModels.columns.default')} className="h-4 w-4 text-amber-500" />
                      )}
                    </td>
                    <td className="px-3 py-2 text-right">
                      <button
                        type="button"
                        data-testid={`ai-models-row-${model.id}-edit`}
                        onClick={() => openEditor(model)}
                        className="inline-flex items-center gap-1 rounded border px-2 py-1 text-xs"
                      >
                        <Pencil className="h-3 w-3" aria-hidden="true" />
                        {t('admin.aiModels.edit')}
                      </button>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}

      <Drawer
        open={editing !== null}
        onClose={closeEditor}
        title={editing ? t('admin.aiModels.drawer.title', { name: editing.displayName }) : ''}
        width="max-w-lg"
        dataTestId="ai-models-drawer"
        closeDisabled={saving}
      >
        {editing && draft && (
          <div className="space-y-5 overflow-y-auto p-5 text-sm">
            <fieldset className="space-y-2">
              <legend className="font-medium">{t('admin.aiModels.drawer.prices')}</legend>
              <div className="grid grid-cols-2 gap-2">
                {RATE_KEYS.map((key) => (
                  <label key={key} className="space-y-1">
                    <span className="text-xs text-gray-600">{t(/* i18n-dynamic */ `admin.aiModels.drawer.${key}`)}</span>
                    <input
                      data-testid={`ai-models-rate-${key}`}
                      type="number"
                      min={0}
                      step="any"
                      value={draft.rates[key]}
                      onChange={(e) => updateDraft({ rates: { ...draft.rates, [key]: e.target.value } })}
                      className="w-full rounded border px-2 py-1"
                    />
                  </label>
                ))}
              </div>
            </fieldset>

            <fieldset className="space-y-2">
              <legend className="font-medium">{t('admin.aiModels.drawer.fastPrices')}</legend>
              <p className="text-xs text-gray-500">{t('admin.aiModels.drawer.fastPricesHint')}</p>
              <div className="grid grid-cols-2 gap-2">
                {RATE_KEYS.map((key) => (
                  <label key={key} className="space-y-1">
                    <span className="text-xs text-gray-600">{t(/* i18n-dynamic */ `admin.aiModels.drawer.${key}`)}</span>
                    <input
                      data-testid={`ai-models-fast-rate-${key}`}
                      type="number"
                      min={0}
                      step="any"
                      value={draft.fastRates[key]}
                      onChange={(e) => updateDraft({ fastRates: { ...draft.fastRates, [key]: e.target.value } })}
                      className="w-full rounded border px-2 py-1"
                    />
                  </label>
                ))}
              </div>
            </fieldset>

            {editing.derived.thinkingMode === 'adaptive' && (
              <fieldset className="space-y-1">
                <legend className="font-medium">{t('admin.aiModels.drawer.effort')}</legend>
                <div className="flex flex-wrap gap-3">
                  {editing.derived.effortLevels.map((level) => (
                    <label key={level} className="inline-flex items-center gap-1">
                      <input
                        data-testid={`ai-models-effort-${level}`}
                        type="checkbox"
                        checked={draft.effort.includes(level)}
                        onChange={(e) => updateDraft({ effort: withValue(draft.effort, level, e.target.checked) })}
                      />
                      {level}
                    </label>
                  ))}
                </div>
              </fieldset>
            )}

            {displayChoices(editing.derived.thinkingMode).length > 0 && (
              <fieldset className="space-y-1">
                <legend className="font-medium">{t('admin.aiModels.drawer.thinkingDisplay')}</legend>
                <div className="flex flex-wrap gap-3">
                  {displayChoices(editing.derived.thinkingMode).map((display) => (
                    <label key={display} className="inline-flex items-center gap-1">
                      <input
                        data-testid={`ai-models-display-${display}`}
                        type="checkbox"
                        checked={draft.thinkingDisplay.includes(display)}
                        onChange={(e) => updateDraft({ thinkingDisplay: withValue(draft.thinkingDisplay, display, e.target.checked) })}
                      />
                      {t(/* i18n-dynamic */ `admin.aiModels.thinkingDisplay.${display}`)}
                    </label>
                  ))}
                </div>
              </fieldset>
            )}

            <label className="flex items-center gap-2">
              <input data-testid="ai-models-fast" type="checkbox" checked={draft.fast} onChange={(e) => updateDraft({ fast: e.target.checked })} />
              {t('admin.aiModels.drawer.fast')}
            </label>

            <label className="block space-y-1">
              <span className="font-medium">{t('admin.aiModels.drawer.inferenceGeo')}</span>
              <input
                data-testid="ai-models-geo"
                type="text"
                value={draft.inferenceGeo}
                onChange={(e) => updateDraft({ inferenceGeo: e.target.value })}
                className="w-full rounded border px-2 py-1"
              />
              <span className="block text-xs text-gray-500">{t('admin.aiModels.drawer.inferenceGeoHint')}</span>
            </label>

            <div className="grid grid-cols-2 gap-3">
              <label className="space-y-1">
                <span className="font-medium">{t('admin.aiModels.drawer.minPlan')}</span>
                <select data-testid="ai-models-min-plan" value={draft.minPlan} onChange={(e) => updateDraft({ minPlan: e.target.value })} className="w-full rounded border px-2 py-1">
                  <option value="">{t('admin.aiModels.drawer.allPlans')}</option>
                  {planOptions.map((plan) => <option key={plan} value={plan}>{plan}</option>)}
                </select>
              </label>
              <label className="space-y-1">
                <span className="font-medium">{t('admin.aiModels.drawer.promptProfile')}</span>
                <select
                  data-testid="ai-models-prompt-profile"
                  value={draft.promptProfile}
                  onChange={(e) => updateDraft({ promptProfile: e.target.value as PromptProfile })}
                  className="w-full rounded border px-2 py-1"
                >
                  {PROMPT_PROFILES.map((profile) => (
                    <option key={profile} value={profile}>{t(/* i18n-dynamic */ `admin.aiModels.promptProfile.${profile}`)}</option>
                  ))}
                </select>
              </label>
            </div>

            <label className="flex items-start gap-2">
              <input
                data-testid="ai-models-offered"
                type="checkbox"
                checked={draft.platformOffered}
                disabled={locked}
                onChange={(e) => updateDraft({ platformOffered: e.target.checked })}
              />
              <span>
                {t('admin.aiModels.drawer.offered')}
                <span className="block text-xs text-gray-500">{t('admin.aiModels.drawer.offeredHint')}</span>
              </span>
            </label>

            <label className="flex items-start gap-2">
              <input
                data-testid="ai-models-default"
                type="checkbox"
                checked={draft.isPlatformDefault}
                disabled={locked}
                onChange={(e) => updateDraft({ isPlatformDefault: e.target.checked })}
              />
              <span>
                {t('admin.aiModels.drawer.isDefault')}
                <span className="block text-xs text-gray-500">
                  {locked ? t('admin.aiModels.drawer.defaultLocked') : t('admin.aiModels.drawer.defaultHint')}
                </span>
              </span>
            </label>

            <div className="flex justify-end gap-2 border-t pt-4">
              <button type="button" data-testid="ai-models-cancel" onClick={closeEditor} disabled={saving} className="rounded border px-3 py-1.5">
                {t('admin.aiModels.drawer.cancel')}
              </button>
              <button
                type="button"
                data-testid="ai-models-save"
                onClick={() => void handleSave()}
                disabled={saving}
                className="inline-flex items-center gap-2 rounded bg-blue-600 px-3 py-1.5 text-white disabled:opacity-50"
              >
                {saving && <Loader2 className="h-4 w-4 animate-spin" aria-hidden="true" />}
                {t('admin.aiModels.drawer.save')}
              </button>
            </div>
          </div>
        )}
      </Drawer>
    </div>
  );
}
```

```astro
---
// apps/web/src/pages/admin/ai-models.astro
import DashboardLayout from '../../layouts/DashboardLayout.astro';
import AiModels from '../../components/admin/AiModels';
---

<DashboardLayout titleKey="titles.adminAiModels">
  <AiModels client:load />
</DashboardLayout>
```

Sidebar entry (`apps/web/src/components/layout/Sidebar.tsx`, `administration` section, after the LLM Provider Catalog item). Add `Sparkles` to the `lucide-react` import if it isn't there:
```ts
  { name: 'AI Models', labelKey: 'nav.aiModels', href: '/admin/ai-models', icon: Sparkles, platformAdminOnly: true },
```

English strings: add `"aiModels"` inside the top-level `"admin"` object of `apps/web/src/locales/en/admin.json`:
```json
"aiModels": {
  "title": "AI models",
  "subtitle": "Models the platform knows from Anthropic discovery. New models arrive unpriced and are offered to no one until you price and offer them.",
  "refresh": "Refresh models",
  "requiresPlatformAdmin": "Platform administrator access is required to manage AI models.",
  "empty": "No models yet. Refresh to discover models with the platform key.",
  "newBadge": "New",
  "notSeen": "Not yet seen by discovery",
  "unpriced": "Unpriced",
  "yes": "Yes",
  "no": "No",
  "edit": "Edit",
  "columns": {
    "model": "Model",
    "status": "Status",
    "thinking": "Thinking",
    "price": "Input / output per MTok",
    "offered": "Offered",
    "default": "Platform default",
    "actions": "Actions"
  },
  "lifecycle": { "available": "Available", "missing": "Missing", "retired": "Retired" },
  "thinkingMode": { "adaptive": "Adaptive", "budget": "Budget", "none": "None", "unknown": "Unverified" },
  "thinkingDisplay": { "omitted": "Omitted", "summarized": "Summarized", "updates": "Progress updates" },
  "promptProfile": { "claude-frontier": "Frontier", "claude-standard": "Standard", "claude-small": "Small", "generic": "Generic" },
  "drawer": {
    "title": "Edit {{name}}",
    "prices": "Prices (US cents per million tokens)",
    "fastPrices": "Fast mode prices (optional)",
    "fastPricesHint": "Fast mode can't be selected until all four fast prices are set.",
    "inputCentsPerM": "Input",
    "outputCentsPerM": "Output",
    "cacheReadCentsPerM": "Cache read",
    "cacheWriteCentsPerM": "Cache write",
    "effort": "Effort levels",
    "thinkingDisplay": "Thinking display",
    "fast": "Fast mode supported",
    "inferenceGeo": "Inference geographies",
    "inferenceGeoHint": "Comma-separated values confirmed against the Anthropic API, for example us, global.",
    "minPlan": "Minimum plan",
    "allPlans": "All plans",
    "promptProfile": "Prompt profile",
    "offered": "Offered on the platform key",
    "offeredHint": "Requires all four prices.",
    "isDefault": "Platform default",
    "defaultHint": "Recorded for the upcoming per-feature model resolver. Until it ships, the deployment default comes from ANTHROPIC_MODEL or the built-in default.",
    "defaultLocked": "This is the platform default. Make another model the default to change it.",
    "save": "Save",
    "cancel": "Cancel"
  },
  "notice": { "saved": "Model saved.", "refreshQueued": "Model refresh queued." },
  "errors": {
    "load": "Couldn't load AI models.",
    "save": "Couldn't save the model.",
    "refresh": "Couldn't queue a model refresh.",
    "invalidRates": "Enter all four prices as non-negative numbers, or leave all four blank."
  }
}
```

`apps/web/src/locales/en/common.json`: `"nav": { …, "aiModels": "AI Models" }`. `apps/web/src/locales/en/pages.json`: `"titles": { …, "adminAiModels": "AI Models" }`.

For the other 7 locales, add the same keys with translated values:
- Keep every key, and `{{name}}`, identical.
- Keep `ANTHROPIC_MODEL`, `Anthropic`, `MTok` and the example tokens `us, global` untranslated.
- The pt-BR values are machine-drafted pending native review; say so in the PR body.

- [ ] **Step 4: Repoint the provider catalog's model list**

In `apps/web/src/components/admin/LlmProviderCatalog.tsx`:
- Delete the `OFFERABLE_AI_MODELS` constant and its comment (~L23–35).
- Change `function emptyModelMapDraft(): Record<string, ModelMapDraftRow> {` to take the ids: `function emptyModelMapDraft(modelIds: readonly string[]): Record<string, ModelMapDraftRow> {`, and map over `modelIds` instead of `OFFERABLE_AI_MODELS`.
- Add state: `const [mappableModelIds, setMappableModelIds] = useState<string[]>([]);`
- Change `useState<Record<string, ModelMapDraftRow>>(emptyModelMapDraft())` to `useState<Record<string, ModelMapDraftRow>>({})`.
- In `fetchCatalog`, after `setEntries(...)`, add:
```tsx
      // Mappable logical ids come from the platform model registry (W01 #7599,
      // spec §6/§11): any model it holds that is not retired. The API checks
      // the same rule on save.
      const modelsResponse = await fetchWithAuth('/admin/ai-models');
      if (modelsResponse.ok) {
        const modelsData = (await modelsResponse.json()) as { models?: Array<{ modelId: string; lifecycle: string }> };
        setMappableModelIds(
          (Array.isArray(modelsData.models) ? modelsData.models : [])
            .filter((model) => model.lifecycle !== 'retired')
            .map((model) => model.modelId)
            .sort(),
        );
      }
```
- In `openRevisionForm`, change `setModelMapDraft(emptyModelMapDraft());` to `setModelMapDraft(emptyModelMapDraft(mappableModelIds));`.
- In the revision form (~L730):
  - Change `{OFFERABLE_AI_MODELS.map((modelId) => {` to `{mappableModelIds.map((modelId) => {`.
  - Change `const row = modelMapDraft[modelId];` to `const row = modelMapDraft[modelId] ?? emptyModelMapDraft([modelId])[modelId]!;`. A list refresh while the form is open must not crash a row that has no draft yet.

In `apps/web/src/components/admin/LlmProviderCatalog.test.tsx`, make `mockApi` answer the registry list. Add before its final `throw`:
```ts
    if (method === 'GET' && url === '/admin/ai-models') {
      return Promise.resolve(jsonRes({
        models: [
          { modelId: 'claude-sonnet-4-6', lifecycle: 'available' },
          { modelId: 'vendor-new-model', lifecycle: 'available' },
          { modelId: 'vendor-retired-model', lifecycle: 'retired' },
        ],
        planOptions: [],
      }));
    }
```
Then add:
```tsx
  it('offers every non-retired registry model in the revision model map (W01 #7599)', async () => {
    mockApi([{
      entryId: 'e1', slug: 'gw', name: 'Gateway', status: 'draft', activeRevisionId: null, notes: null,
      createdAt: '2026-11-13T00:00:00.000Z', updatedAt: '2026-11-13T00:00:00.000Z', revisions: [],
    }]);
    render(<LlmProviderCatalog />);
    await screen.findByTestId('llm-catalog-row-e1');
    fireEvent.click(screen.getByTestId('llm-catalog-row-e1-toggle'));
    fireEvent.click(await screen.findByTestId('llm-catalog-row-e1-add-revision'));
    expect(await screen.findByTestId('llm-catalog-modelmap-vendor-new-model')).toBeTruthy();
    expect(screen.getByTestId('llm-catalog-modelmap-claude-sonnet-4-6')).toBeTruthy();
    expect(screen.queryByTestId('llm-catalog-modelmap-vendor-retired-model')).toBeNull();
  });
```
If `llm-catalog-row-e1-add-revision` renders without expanding the row, drop the toggle click. The assertion is about the model list, not the expansion.

- [ ] **Step 5: Register the component with the no-silent-mutations guard**

In `apps/web/src/lib/__tests__/no-silent-mutations.test.ts`:
- Add `'src/components/admin/AiModels.tsx', // W01 #7599: /admin/ai-models (PATCH + refresh via runAction)` to `TARGET_GLOBS` next to the other `src/components/admin/*` entries.
- Increment the `expect(absoluteFiles.length).toBe(N)` count by one, and add a line to its running-count comment.

- [ ] **Step 6: Run the web suites and watch them pass**

Run:
```bash
cd apps/web && npx vitest run src/components/admin/AiModels.test.tsx src/components/admin/LlmProviderCatalog.test.tsx \
  src/lib/__tests__/no-silent-mutations.test.ts src/lib/i18n/localeParity.test.ts src/lib/i18n/keyUsage.test.ts \
  src/lib/i18n/titleKeyUsage.test.ts src/lib/i18n/translationCoverage.test.ts \
  src/components/layout/Sidebar.nav.test.tsx src/components/layout/Sidebar.rbac.test.tsx
npx tsc --noEmit -p tsconfig.json
```

Expected: PASS, and tsc exits 0.

If `translationCoverage.test.ts` reports more identical-to-English values in a locale's `admin.json` than its baseline allows, raise that locale's baseline by the exact excess, with a comment naming W01 #7599 and the identical strings. Typical identical strings are `Standard`, `Generic`, `MTok` and `Status`. Never loosen a translation to dodge the cap.

- [ ] **Step 7: Commit**

```bash
git add apps/web/src/pages/admin/ai-models.astro apps/web/src/components/admin/AiModels.tsx apps/web/src/components/admin/AiModels.test.tsx \
  apps/web/src/components/admin/LlmProviderCatalog.tsx apps/web/src/components/admin/LlmProviderCatalog.test.tsx \
  apps/web/src/components/layout/Sidebar.tsx apps/web/src/locales apps/web/src/lib/__tests__/no-silent-mutations.test.ts \
  apps/web/src/lib/i18n/translationCoverage.test.ts
git commit -m "feat(web): /admin/ai-models page; provider catalog reads models from the registry (#7599)

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

## Task 17: Fidelity harness: adaptive + effort probe, `max_tokens` ≥ 2048

Spec §7 says catalog and BYO endpoints send thinking/effort only if the harness verified them. W01 adds that verification as a **recorded probe**, not a gating step:
- `passed` stays `steps.every(ok)` over the existing three steps.
- A gateway that rejects adaptive thinking still verifies for tool calling; it is recorded `verifiedCapabilities.adaptiveEffort: false`.
- W03 reads that flag from the latest passing verification before sending adaptive/effort to a catalog endpoint.

`FIDELITY_HARNESS_VERSION` stays `'1'`. A bump would invalidate every existing pass and take every listed catalog revision unverified the moment W01 deploys. All harness requests move to `max_tokens: 2048`; manual thinking needs ≥ 1024, and the old 512 left no headroom. The probe builds its params with `buildWireParams` (index invariant 2).

**Files:**
- Modify: `apps/api/src/services/llm/providerFidelityHarness.ts`
- Modify: `apps/api/src/services/llm/providerFidelityHarness.test.ts`
- Modify: `apps/api/src/routes/admin/llmProviderCatalog.ts` (~L262–316: carry and persist the probes)
- Modify: `apps/api/src/routes/admin/llmProviderCatalog.test.ts` (default `runFidelityCheckMock` result gains the new fields; one new assertion)

**Interfaces:**
- Consumes: `buildWireParams`, `toMessagesApiParams` (Task 4).
- Produces:
  ```ts
  export const FIDELITY_HARNESS_MAX_TOKENS = 2048;
  export const FIDELITY_PROBE_NAMES = { adaptiveEffort: 'direct_adaptive_effort' } as const;
  export interface FidelityCheckResult { passed: boolean; steps: FidelityCheckStep[]; probes: FidelityCheckStep[]; verifiedCapabilities: { adaptiveEffort: boolean }; harnessVersion: string }
  ```
  `llm_provider_verifications.detail` gains `{ probes, verifiedCapabilities }` next to `{ steps, harnessVersion }`. That is W03's read contract.

- [ ] **Step 1: Write the failing tests**

Append inside `describe('runFidelityCheck', …)` in `providerFidelityHarness.test.ts`. Extend the import from `./providerFidelityHarness` with `FIDELITY_HARNESS_MAX_TOKENS` and `FIDELITY_PROBE_NAMES`.
```ts
  it('every direct request asks for at least 2048 output tokens (manual thinking needs >= 1024)', async () => {
    stageOkAnthropic();
    anthropicState.create.mockResolvedValueOnce(finalReply('FIDELITY-OK'));
    await runFidelityCheck(INPUT);
    expect(anthropicState.create.mock.calls.length).toBe(3);
    for (const [params] of anthropicState.create.mock.calls) {
      expect((params as { max_tokens: number }).max_tokens).toBeGreaterThanOrEqual(2048);
    }
    expect(FIDELITY_HARNESS_MAX_TOKENS).toBe(2048);
  });

  it('probes adaptive thinking + effort with the wire-param builder and records success', async () => {
    stageOkAnthropic();
    anthropicState.create.mockResolvedValueOnce(finalReply('FIDELITY-OK'));
    const result = await runFidelityCheck(INPUT);
    const probeParams = anthropicState.create.mock.calls[2]![0] as Record<string, unknown>;
    expect(probeParams.thinking).toEqual({ type: 'adaptive' });
    expect(probeParams.output_config).toEqual({ effort: 'low' });
    expect(result.probes).toEqual([{ name: FIDELITY_PROBE_NAMES.adaptiveEffort, ok: true, detail: expect.any(String) }]);
    expect(result.verifiedCapabilities).toEqual({ adaptiveEffort: true });
    expect(result.passed).toBe(true);
  });

  it('a provider that rejects adaptive thinking still passes verification; the probe records false', async () => {
    stageOkAnthropic();
    anthropicState.create.mockRejectedValueOnce(new Error(`400 thinking.type adaptive not supported ${TEST_API_KEY}`));
    const result = await runFidelityCheck(INPUT);
    expect(result.passed).toBe(true);
    expect(result.verifiedCapabilities).toEqual({ adaptiveEffort: false });
    expect(result.probes[0]!.detail).not.toContain(TEST_API_KEY);
  });

  it('skips the probe when the direct stage fails', async () => {
    anthropicState.create.mockResolvedValueOnce(finalReply('It is sunny in Berlin.'));
    const result = await runFidelityCheck(INPUT);
    expect(anthropicState.create).toHaveBeenCalledTimes(1);
    expect(result.probes[0]).toMatchObject({ ok: false, detail: expect.stringMatching(/^skipped/) });
  });

  // A bump would invalidate every listed revision's verifications on deploy.
  it('keeps FIDELITY_HARNESS_VERSION at 1 (the probe is recorded, never gating)', () => {
    expect(FIDELITY_HARNESS_VERSION).toBe('1');
  });
```

In `apps/api/src/routes/admin/llmProviderCatalog.test.ts`, change the `runFidelityCheckMock.mockResolvedValue({...})` default in `beforeEach` to also return `probes: [{ name: 'direct_adaptive_effort', ok: true }]` and `verifiedCapabilities: { adaptiveEffort: true }`. Then, in the existing successful-verify test, assert that `serviceMocks.recordVerification` was called with `detail` containing them:
```ts
    expect(serviceMocks.recordVerification).toHaveBeenCalledWith(expect.objectContaining({
      detail: expect.objectContaining({
        probes: [{ name: 'direct_adaptive_effort', ok: true }],
        verifiedCapabilities: { adaptiveEffort: true },
      }),
    }));
```

- [ ] **Step 2: Run them and watch them fail**

Run: `cd apps/api && npx vitest run src/services/llm/providerFidelityHarness.test.ts src/routes/admin/llmProviderCatalog.test.ts`

Expected: FAIL.
- `FIDELITY_HARNESS_MAX_TOKENS` is undefined, and `max_tokens` is 512.
- `result.probes` is undefined.
- `recordVerification`'s `detail` lacks `probes`.

- [ ] **Step 3: Implement**

In `providerFidelityHarness.ts`:
- Add the import `import { buildWireParams, toMessagesApiParams } from '../aiModels/wireParams';`.
- Add the exports below `FIDELITY_STEP_NAMES`:
```ts
/** Every direct request. Manual (budget) thinking needs >= 1024 and < max_tokens; 512 left no room (spec §7). */
export const FIDELITY_HARNESS_MAX_TOKENS = 2048;

/** Recorded capability probes. They never affect `passed` (spec §7: params are sent only where verified). */
export const FIDELITY_PROBE_NAMES = {
  adaptiveEffort: 'direct_adaptive_effort',
} as const;

const ADAPTIVE_PROBE_SENTINEL = 'FIDELITY-OK';
const ADAPTIVE_PROBE_PROMPT = `Reply with exactly ${ADAPTIVE_PROBE_SENTINEL} and nothing else.`;
```
- Extend the result type:
```ts
export interface FidelityCheckResult {
  passed: boolean;
  steps: FidelityCheckStep[];
  /** Recorded capability probes; never part of `passed`. */
  probes: FidelityCheckStep[];
  /** What W03 may send to this endpoint/model beyond plain tool calling. */
  verifiedCapabilities: { adaptiveEffort: boolean };
  harnessVersion: string;
}
```
- In `runDirectStage`, change both `max_tokens: 512,` to `max_tokens: FIDELITY_HARNESS_MAX_TOKENS,`.
- Add the probe:
```ts
async function runAdaptiveEffortProbe(input: FidelityCheckInput): Promise<FidelityCheckStep> {
  const name = FIDELITY_PROBE_NAMES.adaptiveEffort;
  // Built by the one wire-param owner (index invariant 2): adaptive thinking
  // at the lowest effort. thinksWhenOmitted:true so the adapter always emits
  // the params, because sending them is the point of the probe.
  const params = toMessagesApiParams(buildWireParams({
    thinkingMode: 'adaptive',
    optionSupport: { effort: ['low'], thinkingDisplay: [], speed: ['standard'], inferenceGeo: [] },
    requested: { effort: 'low' },
    maxTokens: FIDELITY_HARNESS_MAX_TOKENS,
  }), { thinksWhenOmitted: true });
  const client = buildAnthropicClient(input);
  try {
    const response = await client.messages.create({
      model: input.providerModel,
      max_tokens: FIDELITY_HARNESS_MAX_TOKENS,
      ...params,
      messages: [{ role: 'user' as const, content: ADAPTIVE_PROBE_PROMPT }],
    }) as { content?: unknown; stop_reason?: unknown };
    if (response.stop_reason !== 'end_turn') {
      return { name, ok: false, detail: `expected stop_reason 'end_turn', got '${String(response.stop_reason)}'` };
    }
    if (!textOf(response.content).includes(ADAPTIVE_PROBE_SENTINEL)) {
      return { name, ok: false, detail: 'the answer did not contain the probe sentinel' };
    }
    return { name, ok: true, detail: 'adaptive thinking with output_config.effort accepted' };
  } catch (error) {
    return { name, ok: false, detail: `request rejected: ${describeError(error)}` };
  }
}
```
- Replace the tail of `runFidelityCheck`, after `const steps = …`, with:
```ts
  const probe: FidelityCheckStep = directPassed
    ? await runAdaptiveEffortProbe(input)
    : { name: FIDELITY_PROBE_NAMES.adaptiveEffort, ok: false, detail: 'skipped: the direct SDK stage did not pass' };
  const probes = [sanitizeStep(probe, input.apiKey)];

  return {
    passed: steps.every((step) => step.ok),
    steps,
    probes,
    verifiedCapabilities: { adaptiveEffort: probes[0]!.ok },
    harnessVersion: FIDELITY_HARNESS_VERSION,
  };
```
(The probe runs after the subprocess stage, so the existing per-test `create` mock ordering for stages 1–2 is untouched.)

In `apps/api/src/routes/admin/llmProviderCatalog.ts`, in the verify handler:
- Add to `safeResult` (built after `runFidelityCheck`):
```ts
        probes: result.probes.map((probe) => ({
          ...probe,
          name: redactSecret(probe.name, apiKey),
          ...(probe.detail === undefined ? {} : { detail: redactSecret(probe.detail, apiKey) }),
        })),
        verifiedCapabilities: result.verifiedCapabilities,
```
- Extend the `recordVerification` detail:
```ts
        detail: {
          steps: safeResult.steps,
          probes: safeResult.probes,
          verifiedCapabilities: safeResult.verifiedCapabilities,
          harnessVersion: safeResult.harnessVersion,
        },
```
- If `safeResult` has an explicit type annotation, add the two fields to it.

- [ ] **Step 4: Run them and watch them pass**

Run: `cd apps/api && npx vitest run src/services/llm/providerFidelityHarness.test.ts src/routes/admin/llmProviderCatalog.test.ts src/services/llmProviderCatalog.test.ts`

Expected: PASS. Existing tests that asserted `anthropicState.create` call counts on a fully passing run now see one extra probe call. Update those counts from 2 to 3 and explain the change in a one-line comment. A failing-direct-stage test keeps its count, because the probe is skipped.

- [ ] **Step 5: Commit**

```bash
git add apps/api/src/services/llm/providerFidelityHarness.ts apps/api/src/services/llm/providerFidelityHarness.test.ts \
  apps/api/src/routes/admin/llmProviderCatalog.ts apps/api/src/routes/admin/llmProviderCatalog.test.ts
git commit -m "feat(ai): fidelity harness records an adaptive + effort probe; max_tokens 2048 (#7599)

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

## Task 18: Whole-branch verification and PR

**Files:**
- Create: `apps/api/src/services/aiModels/index.ts` (thin hub, index contract)

- [ ] **Step 1: Add the re-export hub**

```ts
// apps/api/src/services/aiModels/index.ts
// AI model registry (#7598) hub. Import from the specific module in hot or
// pure code (aiModel.ts, aiCostTracker.ts, wire-option call sites): this hub
// also re-exports platformModels.ts, which loads the database module.
export * from './capabilities';
export * from './wireParams';
export * from './pricing';
export * from './platformModelSnapshot';
export * from './platformModelAdmin';
export * from './platformModels';
export * from './modelWireOptions';
export * from './discovery';
```

`platformModels.ts` re-exports `PlatformModelError` from `platformModelAdmin.ts`, which the hub also re-exports. If TypeScript reports `TS2308 Module './platformModelAdmin' has already exported a member named 'PlatformModelError'`, drop `export * from './platformModelAdmin';` and add `export { validatePlatformModelAdminPatch, type PlatformModelAdminPatch, type PlatformModelAdminState } from './platformModelAdmin';`.

- [ ] **Step 2: Full unit suites, typecheck, lint**

Run:
```bash
cd apps/api && npx vitest run && npx tsc --noEmit -p tsconfig.json
cd ../web && npx vitest run && npx tsc --noEmit -p tsconfig.json
cd ../../packages/shared && npx vitest run
cd ../.. && pnpm lint
```

Expected:
- All green.
- The API run reports the full file count, including `orgMerge.test.ts` and `cascadeDelete.test.ts`. CLAUDE.md: some contracts red only in the full suite. W01 adds no `org_id` table, so neither should move.

- [ ] **Step 3: Contract suites that need Postgres**

Run:
```bash
pnpm test-stack up
cd apps/api && npx vitest run --config vitest.integration.config.ts src/__tests__/integration/aiPlatformModels.integration.test.ts \
  src/__tests__/integration/aiModelDiscovery.integration.test.ts src/__tests__/integration/llmCatalogSelection.integration.test.ts \
  src/__tests__/integration/tenantCascade.integration.test.ts src/__tests__/integration/tenant-export-policy.integration.test.ts
cd ../.. && DB_CONTEXTLESS_WRITE_STRICT=true pnpm --filter=@breeze/api test:rls-coverage
pnpm db:check-drift
pnpm test-stack down
```

Expected: every suite passes and drift is clean.
- The cascade and export-policy suites must pass untouched. They auto-discover `org_id` tables, and `ai_platform_models` has none.
- Bring the stack down even on failure.

- [ ] **Step 4: Invariant greps**

Run:
```bash
git grep -n "aiModelThinking\|resolveModelThinking\|resolveMessagesApiThinking" -- apps ee packages
git grep -nE "thinking: \{ ?type:|budgetTokens:|output_config: \{" -- apps/api/src ee ':!*.test.ts' ':!**/__scripts__/**'
git grep -n "OFFERABLE_AI_MODELS" -- apps/api/src apps/web/src ':!*.test.ts' ':!*.test.tsx' ':!**/__fixtures__/**'
git diff origin/main --stat -- apps/api/src | grep -v test | grep -c "claude-" || true
git diff origin/main -U0 -- apps/api/src apps/web/src ee ':!*.test.ts' ':!*.test.tsx' ':!**/__fixtures__/**' ':!apps/api/src/services/aiModel.ts' | grep -E "^\+.*'claude-(opus|sonnet|haiku|fable|mythos)" || echo "no new model literals"
```

Expected:
- (1) prints nothing.
- (2) prints only `services/aiModels/wireParams.ts` lines.
- (3) prints only the definition in `services/aiOfferableModels.ts` and the re-export in `services/aiCostTracker.ts`.
- (5) prints `no new model literals`. Index invariant 1 holds by construction; W03 adds the contract test.

- [ ] **Step 5: Live smoke (optional, needs a platform key; never with production credentials)**

With `pnpm wt-stack up` and `ANTHROPIC_API_KEY` set to a developer key:
1. Sign in as a platform admin.
2. Open `/admin/ai-models` and click "Refresh models".
3. Within a minute, the table shows every model the key can list. Seeded rows now have a `lastSeenAt`; models absent from the seed show **New** and **Unpriced**.
4. Price and offer one new model.
5. Check that `GET /ai/provider` → `supportedModels` includes it.
6. Start a chat session on it, and confirm the session is accepted (`POST /ai/sessions` with `model`).

Record the result in the PR body. Bring the stack down afterwards (`pnpm wt-stack down`).

- [ ] **Step 6: Commit, push and open the PR**

```bash
git add apps/api/src/services/aiModels/index.ts
git commit -m "chore(ai): aiModels re-export hub (#7599)

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
git push -u origin feature/7598-ai-model-registry/wave-7599
gh pr create --title "feat(ai): AI model registry W01: platform model catalog, discovery, /admin/ai-models" --body-file - <<'EOF'
Closes #7599 (wave W01 of #7598).

## What
- `ai_platform_models`: a system-wide catalog. No RLS, `INTENTIONAL_UNSCOPED`, same posture as `llm_provider_catalog`. It is seeded from the W00 `MODEL_PRICING` / `OFFERABLE_AI_MODELS`.
- Daily Anthropic discovery for the platform key (BullMQ `ai-model-discovery`):
  - It never enables, prices or deletes anything.
  - New ids alert the operator via `sendOpsAlert` and show as **New** on `/admin/ai-models`.
- `deriveCapabilities` + `buildWireParams` replace the W00 interim resolver (`aiModelThinking.ts` is deleted). Thinking and effort follow the registry's capabilities, with the W00 rules as the bootstrap fallback.
- Token-based cost fallback, `isPricedModel`, the session model check, the partner default and catalog `model_map` keys all read the registry.
- `/admin/ai-models` (platform admin + MFA): prices, fast-mode rates, option support, plan gate, prompt profile, offer and default.
- Fidelity harness: a recorded adaptive + effort probe, and `max_tokens` 2048. The harness version is unchanged.

## Parity
With the registry equal to its seed, every surface sends W00's thinking/effort params and prices every call as W00 did. Pinned per seeded id against frozen W00 oracles.

## Not in W01
- No routing or funding change: `resolveDefaultModel`, `resolveLlmConfig`, `getLlmBillingSourceForOrg` and the SDK-cost preference are untouched (W03).
- `is_platform_default` is recorded but not routed on until W03.

## Spike
Findings: `docs/superpowers/specs/ai-mcp/2026-09-30-ai-model-registry-w01-spike-findings.md` (Q1–Q7, D1–D5). <one-line summary of D1–D3 outcomes>

## Settings
- **Home:** platform model prices / offer → `/admin/ai-models` (platform level, row drawer Save).
- **Places configured:** before, 2 (the `MODEL_PRICING` code constant + the hard-coded list in `LlmProviderCatalog.tsx`); after, 1.

## Notes
- pt-BR strings are machine-drafted pending native review.
- Live smoke: <result or "not run (no key)">.

🤖 Generated with [Claude Code](https://claude.com/claude-code)
EOF
```

Fill the two `<…>` lines from Task 1's findings and Step 5 before creating the PR. Then run `/pr-review-toolkit:review-pr` once, act on confirmed consequential findings only, and enqueue with `gh pr merge <N>` when green. Never use `--admin`.

---

## Self-review

**Spec coverage (W01 rows of spec §13 and the orchestrator brief):**

| Requirement | Task |
|---|---|
| Shared `aiModelOptions.ts`, `aiSurfaces.ts` with index names | 2 |
| `ai_platform_models`: all §5.1 columns, CHECK offered ⇒ four prices, partial-unique default, lifecycle, no RLS, rls-coverage allowlist, Drizzle | 6 |
| Seed from #7593 `MODEL_PRICING` / `OFFERABLE_AI_MODELS`; Sonnet 5.5 default; `option_support` per spec (effort, updates, fast on Opus 5.5/4.8, geo empty) | 8 |
| `deriveCapabilities` (§7 leaves) | 3 |
| `buildWireParams`; delete `aiModelThinking.ts`; repoint every caller; bootstrap = W00 exact; Haiku `disabled`, unknown `disabled`, one-shot effort `medium` | 4, 10 |
| `platformModels.ts` (list/get/upsert/updateAdmin/default) | 7, 9 |
| `discovery.ts` `syncPlatformModels` (`models.list()`, upsert, §6 lifecycle, never enables or prices) | 13 |
| BullMQ `ai-model-discovery`: daily `sync-platform` + on-demand | 14 |
| Operator notification on a new model id (existing mechanism: `sendOpsAlert`) | 13 |
| `RateSnapshot`, `priceInvocation`; cost fallback, `isPricedModel`, `OFFERABLE` consumers on the registry with parity tests per seeded id; SDK-cost preference kept | 5, 8, 11, 12 |
| Catalog `model_map` keys checked against `ai_platform_models.model_id` | 12 |
| `/admin/ai-models` route (platform admin + MFA, list / refresh / patch / audit) + page (table, row drawer, `runAction`, `data-testid`) | 15, 16 |
| Harness adaptive + effort probe; `max_tokens` ≥ 2048 | 17 |
| Spike with committed findings (SDK `display: 'updates'`, `speed`, `inference_geo`; Models API capability leaves; EU geo) | 1 |

**Placeholder scan:** the only fill-ins are the spike findings cells (Task 1 Step 6) and the two PR-body lines (Task 18 Step 6). Both are data an earlier step produces; every code step contains complete code.

**Type consistency:** names were checked across tasks:
- `PlatformModel`, `toPlatformModel`;
- `setPlatformModelSnapshot`, `peekPlatformModel`, `peekPlatformDefaultModelId`, `isPlatformModelSnapshotLoaded`, `clearPlatformModelSnapshot`;
- `validatePlatformModelAdminPatch`, `PlatformModelError`;
- `upsertDiscoveredPlatformModel(apiModel, now?)` → `{ row, inserted, previousLifecycle }`;
- `updatePlatformModelAdmin(id, patch, now?)` → `{ before, after }`;
- `listOfferableModelIds`, `isOfferablePlatformModel`, `listCatalogMappableModelIds`;
- `agentSdkWireOptions(modelId, requested?)`, `messagesApiWireOptions(modelId, maxTokens, requested?)`;
- `computeInvocationCents`, `priceInvocation`, `platformRateSnapshot`;
- `syncPlatformModels(options?)` → `SyncReport`;
- `enqueuePlatformModelSync(trigger?)`;
- `AdminPlatformModelDto` ↔ web `AdminPlatformModel`.

**Review Focus:** all five classes have pinning tests in the named tasks:
1. gateway / no key: 13, 10;
2. aliases and refresh spam: 13;
3. unknown capabilities and cold start: 10;
4. operator invariants: 7, 6, 9;
5. harness: 17.

---

## Index additions

These names are not in the plan index; W02/W03 plans must use them as written.

- **Shared** (`validators/aiModelOptions.ts`):
  - `THINKING_DISPLAYS`, `ThinkingDisplay`;
  - `MODEL_SPEEDS`, `ModelSpeed`;
  - `PROMPT_PROFILES`, `PromptProfile`;
  - `MODEL_LIFECYCLES`, `ModelLifecycle`;
  - `INFERENCE_GEO_PATTERN`;
  - `modelRatesSchema`;
  - `OPTION_RATE_KEYS`, `OptionRateKey`;
  - `emptyOptionSupport()`.
- **`ai_platform_models` columns beyond §5.1:**
  - `missed_sync_count` (the §6 "3 consecutive syncs" counter);
  - `operator_notified_at` (alert delivered-then-marked).
- **`ai_platform_models` constraint names:** `ai_platform_models_{model_id_uq, provider_chk, lifecycle_chk, prompt_profile_chk, prices_nonneg_chk, offered_priced_chk, default_offered_chk, missed_nonneg_chk, option_support_obj_chk, option_rates_obj_chk}` and the index `ai_platform_models_one_default_uq`.
- **`capabilities.ts`:** `DerivedCapabilities` (the index names its fields), `deriveOptionSupport`, `mergeDiscoveredOptionSupport`, `optionSupportErrors`.
- **`wireParams.ts`:**
  - `WireThinking`, `BuildWireParamsInput`;
  - `toAgentSdkOptions`, `AgentSdkThinkingOptions`;
  - `toMessagesApiParams`, `MessagesApiThinkingParams`;
  - `UnsupportedWireOptionError`;
  - `THINKING_DISPLAY_UPDATES_BETA`, `FAST_MODE_BETA`.
- **`pricing.ts`:** `computeInvocationCents` (unrounded), `platformRateSnapshot`, `UnpricedOptionError`.
- **`platformModelSnapshot.ts`** (new file): `setPlatformModelSnapshot`, `clearPlatformModelSnapshot`, `isPlatformModelSnapshotLoaded`, `peekPlatformModel`, `peekPlatformDefaultModelId`.
- **`platformModelAdmin.ts`** (new file): `PlatformModelError`, `PlatformModelAdminPatch`, `PlatformModelAdminState`, `validatePlatformModelAdminPatch`.
- **`platformModels.ts`:**
  - `toPlatformModel`, `getPlatformModelById`;
  - `listOfferableModelIds`, `isOfferablePlatformModel`, `listCatalogMappableModelIds`;
  - `DiscoveredModelInput`;
  - `refreshPlatformModelSnapshot`, `startPlatformModelSnapshotRefresher`, `PLATFORM_MODEL_SNAPSHOT_REFRESH_MS`.
- **`modelWireOptions.ts`** (new file, the W01 bridge W03 retires): `W01_SURFACE_DEFAULT_OPTIONS`, `ModelWireProfile`, `modelWireProfile`, `agentSdkWireOptions`, `messagesApiWireOptions`.
- **`discovery.ts`:**
  - `ANTHROPIC_API_ORIGIN`;
  - `AnthropicModelInfo` (= `DiscoveredModelInput`);
  - `computeLifecycleAfterSync`, `LIFECYCLE_MISSING_AFTER_SYNCS`, `LIFECYCLE_MISSING_MIN_ABSENT_MS`, `LIFECYCLE_RETIRED_AFTER_MS`;
  - `SyncReport`, `SyncPlatformModelsOptions`.
- **`services/aiModel.ts`** (bootstrap home per invariant 1): `legacyWireProfile`, `legacyThinksWhenOmitted`, `derivePromptProfile`.
- **Worker file and exports:**
  - The worker lives at `jobs/aiModelDiscoveryWorker.ts`, not `workers/`. The index defers to the existing registration pattern, which is `jobs/`.
  - Exports: `AI_MODEL_DISCOVERY_QUEUE`, `SYNC_PLATFORM_JOB`, `AiModelDiscoveryJobData` (with `trigger: 'schedule' | 'manual' | 'boot'`), `enqueuePlatformModelSync`, `processAiModelDiscoveryJob`.
  - Schedule key `'ai-model-discovery-sync'`; worker registry name `'aiModelDiscoveryWorker'`.
- **Route / web:**
  - `AdminPlatformModelDto`;
  - `GET /admin/ai-models` returns `{ models, planOptions }`;
  - `POST /admin/ai-models/refresh`;
  - `PATCH /admin/ai-models/:id`;
  - web `AdminPlatformModel`.
- **Harness:**
  - `FIDELITY_HARNESS_MAX_TOKENS`, `FIDELITY_PROBE_NAMES`;
  - `FidelityCheckResult.probes`, `FidelityCheckResult.verifiedCapabilities`;
  - `llm_provider_verifications.detail.verifiedCapabilities.adaptiveEffort` (W03 reads it).
- **Invariant 1 note for W03's contract test:** match model-id literals (`'claude-(opus|sonnet|haiku|fable|mythos)…`), not the bare `'claude-` prefix. `PROMPT_PROFILES` (`'claude-frontier'`, …) are profile names, not model ids.

## Interpretations and deviations (for the orchestrator)

1. **The one-shot "only reduce thinking" rule is kept** via `legacyThinksWhenOmitted`.
   - Spec §7 says adaptive models always get adaptive + effort. W00 deliberately sends nothing on Messages-API one-shots for Opus/Sonnet 4.6–4.8, because they don't think by default there.
   - The Models API doesn't expose "thinks when omitted", so W01 keeps W00's rule (parity) and W03 retires it with per-surface assignment options.
2. **`unknown` / `none` / `budget` become an explicit `{type:'disabled'}` on the Agent SDK**, not "nothing sent" as spec §7 states. That is W00 parity, as the brief requires: an omitted option lets the SDK CLI turn thinking on. Messages-API one-shots do send nothing for these modes.
3. **Budget-mode thinking is always off in v1.** `OfferingOptions` has no on/off knob, so W05 adds one with the chat picker. `buildWireParams` validates `maxTokens` but cannot yet emit `enabled`.
4. **Adapters refuse `display:'updates'`, `speed` and `inferenceGeo`** (`UnsupportedWireOptionError`) until the spike's D1–D3 outcomes are implemented in W03/W05. `option_support` still records these as model facts.
5. **No routing change from `is_platform_default` in W01.** `resolveDefaultModel()` stays env → constant, and the admin page says so.
6. **Lifecycle guards added to spec §6:**
   - Rows no sync has seen never change.
   - `missing` also needs 48 h absent.
   - An empty listing is a failure.
   - Discovery skips non-Anthropic `ANTHROPIC_BASE_URL`.
7. **Two new columns:** `missed_sync_count`, `operator_notified_at`.
8. **Seed `option_support` follows the spec's three `updates` models.** Anthropic's docs also list Fable 5; the operator can add it, and spike Q4 may show it.
9. **The harness probe is recorded, not gating, and the harness version is not bumped.** A bump would unverify every listed catalog revision on deploy.
10. **The worker lives in `jobs/`, not `workers/`** (repo convention).
