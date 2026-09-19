---
tracking_issue: LanternOps/breeze#5711
---

# AI Execution Plane — Wave 1: Artifact Store and Large-Result Capture Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Every oversized AI tool result on the hosted platform is persisted as an `ai_run_artifacts` row plus a tenant-blind blob, the model receives a handle with raw head/tail previews instead of losing the data, and technicians can list and download those artifacts with full tenancy ceremony, expiry, and erasure.

**Architecture:** A region-keyed `BlobStorage` helper (`services/artifacts/blobStorage.ts`, S3-compatible, keys `<region>/<yyyy>/<mm>/<uuid>` with no tenant id) sits under an `artifactService` that writes the blob first and the Shape-1 `ai_run_artifacts` row second (compensating delete on insert failure). `executeTool` (`services/aiTools.ts`) gains one hook after the handler and before any compaction: when a chat session or agent run is the caller and the tool is not `captureExempt`, `captureLargeToolResult` stores results above `MAX_TOOL_RESULT_CHARS` as `input_capture` artifacts and returns `{ artifact, compacted }`; `compactToolResultForChat` learns to compact the inner payload of that envelope with the existing tiers so the model's view is unchanged. A download route streams with `Content-Disposition: attachment` and a fixed safe content-type map; an hourly sweeper deletes expired blobs then rows; org erasure pre-clears blobs before the cascade.

**Tech Stack:** TypeScript, Hono, Drizzle ORM + hand-written SQL migrations (forced RLS), `@aws-sdk/client-s3` (already a dependency), BullMQ, Vitest (unit + `vitest.integration.config.ts` against real Postgres).

**Spec:** docs/superpowers/specs/ai-mcp/2026-09-13-ai-agent-execution-plane-design.md — §3 (artifact store scope), §5.2 (artifact store, capture hook, handles), §6 preamble + §6.1 (`ai_run_artifacts`), §6.3 (no columns in this wave — see Global Constraints), §8 (download/rendering rules, residency of blob keys, erasure), §9 (blob write fails → `artifact_store_unavailable`, never inline), §12 (registry guard, `artifactCapture.test.ts`, RLS forge integration).

**Feature tracking:** parent issue and wave sub-issue assigned by `register_feature` after all wave plans exist; branch `feature/<parent#>-execution-plane/wave-<subissue#>`.

## Global Constraints

- **Hosted-only gate:** capture fires only when `isHosted()` AND `BREEZE_AI_AGENTS_ENABLED` AND `BREEZE_AI_WORKSPACE_ENABLED` are all true (`aiWorkspaceEnabled()` in `apps/api/src/config/env.ts`, defined in this wave, read at call time). Self-hosters see the capability absent, never broken: with the flag off every tool result is byte-identical to today.
- **Flags/env introduced here:** `BREEZE_AI_WORKSPACE_ENABLED` (default false), `BREEZE_REGION` (`eu`|`us`, default `us`), `ARTIFACT_BLOB_BACKEND` (`s3` only in v1; `db` boot-refuses — see Task 4 header), `ARTIFACT_S3_ENDPOINT_EU/US`, `ARTIFACT_S3_BUCKET_EU/US`, `ARTIFACT_S3_REGION_EU/US`, `ARTIFACT_S3_ACCESS_KEY`, `ARTIFACT_S3_SECRET_KEY`, `ARTIFACT_S3_SSE`. Every one is documented in BOTH `.env.example` (repo root) and `deploy/.env.example` with generic placeholders and mapped in BOTH `docker-compose.yml` and `deploy/docker-compose.prod.yml` `api:` environment blocks (`envComposeParity.test.ts` fails otherwise). Never a real host or bucket name.
- **Tenancy ceremony (spec §6):** `ai_run_artifacts` is Shape 1 (direct NOT NULL `org_id`); RLS enable + force + four `breeze_has_org_access(org_id)` policies in the CREATING migration; composite FK `(run_id, org_id) → ai_agent_runs(id, org_id)` `ON DELETE CASCADE DEFERRABLE INITIALLY IMMEDIATE`; registered in `CORE_ORG_CASCADE_DELETE_ORDER` (alphabetical, between `ai_operator_tasks` and `ai_screenshots`), `CORE_TENANT_EXPORT_POLICY` (all 16 columns), `orgMergeRegistry.ts` `SPECIAL` (`leave-for-erasure`). No `BEFORE UPDATE` trigger, so nothing to classify in the trigger registry. Shape 1 is auto-discovered by `rls-coverage.integration.test.ts` — no allowlist entry.
- **Column naming (spec §6.1):** the device pointer is `source_device_id`, NEVER `device_id` — artifacts outlive the device and must not join the device cascade / move-org lists.
- **Blob keys carry no tenant identifier** (spec §5.2, §8): `<region>/<yyyy>/<mm>/<uuid>`. Blobs are deleted BEFORE rows everywhere (service delete, sweeper, org erasure) because the row is the only index to the key.
- **Previews are RAW bytes** (spec §5.2): head/tail are the first/last ≤ 2048 bytes of what the tool returned, decoded UTF-8, NUL-stripped (Postgres `text` rejects ``), secret-redacted with `redactAiToolOutputText` — never a compacted or rendered form.
- **Downloads** (spec §8): always `Content-Disposition: attachment`, `X-Content-Type-Options: nosniff`, content type from a fixed safe map else `application/octet-stream`. No HTML is ever served inline. Blob store fault → 503, never a silent 404.
- **Blob write failure during capture** (spec §9): the tool result becomes `{ error: 'artifact_store_unavailable' }`; the raw result is NOT returned inline (no fallback that bypasses the cap).
- **Migration:** `apps/api/migrations/2026-10-16-100000-ai-run-artifacts.sql`. Newest committed migration at planning time is `2026-10-15-160010-backup-snapshots-layout-manifest.sql`; Task 3 re-checks `ls apps/api/migrations/*.sql | sort | tail -1` and renames if something newer landed. Idempotent (`IF NOT EXISTS`, `DO $$ … EXCEPTION WHEN duplicate_object`, `DROP POLICY IF EXISTS` before `CREATE POLICY`), no inner `BEGIN`/`COMMIT`, DDL only (no DML, so no `set_config('breeze.scope', …)` is needed — `migrationRlsScope.test.ts` stays green). Never edit a shipped migration.
- **Tests:** Vitest, file beside source. One file: `cd apps/api && npx vitest run src/path/file.test.ts` (never `pnpm --filter … test -- --run`). Integration: `cd apps/api && npx vitest run --config vitest.integration.config.ts src/__tests__/integration/<file>` with a live stack (`pnpm test-stack up` at repo root writes `.env.test`; `pnpm test-stack down` when finished — nothing does this for you). Typecheck: `cd apps/api && NODE_OPTIONS=--max-old-space-size=8192 npx tsc --noEmit -p tsconfig.json`. A 0-test run is a stall, not green.
- **Scope of this wave:** ONLY `aiRunArtifacts` + `aiArtifactKind` in `db/schema/aiWorkspace.ts`. `aiRunWorkspaces` and the `aiWorkspaceBackend`/`aiWorkspaceStatus`/`aiWorkspaceRegion` enums are W02 (leave the marked export slot). No `ai_agent_runs` columns (W02), no workspace tools (W03), no profile/metering (W02/W04), no UI (W05).
- **Rigor: high.** Tenancy, RLS, migrations, auth, erasure. Red test first for every task; the integration suites in Task 12 are mandatory before the PR opens.
- **Commits:** end every commit message with `Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>` and `Claude-Session: https://claude.ai/code/session_01MwUHaGwobGHrTgu8TcCWqr`. Merge with bare `gh pr merge <N>` (merge queue); never `--admin`.

---

## Decisions recorded for the orchestrator (deviations / additions vs the shared contract)

1. **`run_id` is NULLABLE** (`ArtifactRecord.runId: string | null`, `CreateArtifactInput.runId: string | null`). The contract typed it `string`, but its own capture rule (`ctx.runId === null && ctx.sessionId === null → return raw`) means chat-session captures with no run DO happen (spec §5.4: "a technician gathers them in chat … each read becomes an artifact"). A composite FK on a nullable column is `MATCH SIMPLE` — unchecked when `run_id` is NULL — so the composite deferrable FK still holds for every run-anchored row. `session_id` is a plain `ai_sessions(id) ON DELETE SET NULL` FK (mirrors `ai_agent_runs.session_id`); there is deliberately NO "run or session" CHECK, so deleting a chat session cannot 23514 and an artifact can outlive both anchors until the sweeper expires it.
2. **`ArtifactRecord.blobKey: string`** is added (the contract omitted it; `openArtifactStream(record)` / `deleteArtifact(record)` need the key and a re-read per call would reopen the row). Routes project DTO fields explicitly (`toArtifactDto`) so `blobKey` never leaves the API.
3. **Additional exports** other waves can rely on: `findArtifactForAuth(handle, auth)` and `listArtifactsForAuth(runId, auth)` (route-side, `auth.orgCondition`-scoped; `resolveArtifact(handle, { orgId, runId? })` stays exactly as contracted for tool paths), `toArtifactDto`, `sanitizeArtifactName`, `createMemoryBlobStorage()` + `setBlobStorageForTests()` (`blobStorage.ts`), `captureContextFrom(auth, opts, toolName)` + `CaptureContext` + `CaptureScope` (`toolResultCapture.ts`), `ExecuteToolOptions.capture` (`aiTools.ts` — see reconciliation R2; `ToolExecutionContext` is NOT modified by this wave), `compactToolResultForChat(toolName, raw, maxChars?)` third optional parameter and exported `MAX_TOOL_RESULT_CHARS` (`aiToolOutput.ts`), `AiRunArtifactDto` + `AI_ARTIFACT_KINDS` (`packages/shared/src/types/aiArtifacts.ts`), `aiWorkspaceEnabled()` + `breezeRegion()` (`config/env.ts`).
4. **Capture envelope content type is detected**, not fixed: `application/json` when the raw result parses as JSON, else `text/plain; charset=utf-8` (a non-JSON stdout blob labelled JSON would mislead W03's staging step).
5. **Download streams through the API** (per the wave brief) rather than the spec §5.2 "short-lived signed redirect": streaming is the only way to force `attachment` + `nosniff` on every provider; a presigned redirect is a follow-up if bandwidth demands it.
6. **`ARTIFACT_BLOB_BACKEND=db` boot-refuses in v1.** There is no generic blob table — `ticket_attachments` is ticket-scoped (`ticket_id NOT NULL`) — and the feature is hosted-only where S3-compatible storage exists. Local dev uses MinIO through the same `s3` path (falls back to the platform `S3_*` vars when `ARTIFACT_S3_*` are unset).
7. **`ticketAttachmentStorage.ts` is left untouched.** Its per-row `'s3'|'db'` routing model cannot be expressed through the region-keyed `BlobStorage` interface without changing its call sites; converting it is a follow-up issue, not a small diff.
8. **Streaming puts buffer in memory** up to `maxBytes` (`collectBounded`). `@aws-sdk/lib-storage` (multipart `Upload`) is not a dependency; the capture path always has the whole string in memory anyway, and W03's per-file collect caps are far below the 64 MiB `CAPTURE_MAX_BYTES`. Adding `lib-storage` is the upgrade if a wave needs > 64 MiB single blobs.
9. **A fourth index** `ai_run_artifacts_expires_idx (expires_at)` is added beyond spec §6.1's three: the sweeper scans cross-org under system scope, which the `(org_id, expires_at)` index cannot serve.
10. **`compactToolResultForChat` learns the capture envelope.** Without it, `applyToolSpecificCompaction` (keyed by tool name on top-level fields like `stdout`/`alerts`) would see `{ artifact, compacted }` instead of the tool's native shape, and the model's view of the compacted half would differ from today. The five call sites are untouched (spec §5.2); the change is inside the single function.

---

## Cross-wave reconciliation (final — supersedes any earlier note or code block)

This is the single authoritative statement of the capture contract. Earlier drafts of this plan carried **three** competing generations of it: (1) `captureScopeFor(auth, session)` plus a memoized `sessionId → runId` lookup (`resolveCaptureContext`) behind a new partial `ai_agent_runs(session_id)` index, with an `auth.accessibleOrgIds` single-entry org fallback; (2) a named `ExecuteToolOptions.capture` bag; (3) new `orgId` / `chatSessionId` members on `ToolExecutionContext`. **Generations 1 and 3 are dead.** Generation 2 is the design, and the only one. Where a task body below still contradicts this section, the task body is wrong and the section wins.

**Why not `ToolExecutionContext`.** `toolExecutionContext.ts:39-65` documents that type as deliberately narrow — verified release material, and an argued prohibition on letting caller-identity-ish fields ride along. An `orgId` member is exactly the kind of field it argues against, and the W04 reviewer flagged it as contradicting the type's own header. Capture attribution therefore travels in its own named member on `ExecuteToolOptions`, which that file already documents (lines 472-479) as the NAMED BAG for unrelated per-invocation inputs. `ToolExecutionContext` is **not modified by this wave**.

### The final shape, verbatim

```ts
// apps/api/src/services/artifacts/toolResultCapture.ts

/** What a CHAT caller supplies. The only thing a call site ever constructs. */
export interface CaptureScope { orgId: string; sessionId: string }

export interface CaptureContext { orgId: string; runId: string | null; sessionId: string | null; region: BlobRegion; toolName: string }

export function captureContextFrom(
  auth: AuthContext,
  opts: { capture?: CaptureScope } | undefined,   // structurally satisfied by ExecuteToolOptions
  toolName: string,
): CaptureContext | null {
  const orgId = opts?.capture?.orgId ?? auth.orgId ?? null;                       // NEVER accessibleOrgIds
  const runId = auth.principal.kind === 'ai_agent' ? auth.principal.runId : null; // the run path needs no call-site change
  const sessionId = runId ? null : (opts?.capture?.sessionId ?? null);            // ai_sessions.id; a run-anchored capture stores no session
  if (!orgId) return null;                        // no org to attribute a tenant-scoped row to → passthrough
  if (!runId && !sessionId) return null;          // no anchor (MCP server, script builder, intent release) → passthrough
  return { orgId, runId, sessionId, region: breezeRegion(), toolName };
}

export async function captureLargeToolResult(raw: string, ctx: CaptureContext | null): Promise<string>; // null → return raw unchanged
```

```ts
// apps/api/src/services/aiTools.ts — ExecuteToolOptions gains exactly one member:
  capture?: CaptureScope;
```

`executeTool`'s **signature is unchanged** — `capture` rides in the options bag it already accepts. The hook inside `executeTool` is, in full:

```ts
const ctx = tool.captureExempt ? null : captureContextFrom(auth, opts, toolName);
return captureLargeToolResult(rawResult, ctx);
```

A `captureExempt` tool and an unattributable call take the SAME path — a null context — so there is exactly one passthrough branch to reason about, and `captureLargeToolResult(raw, null)` returning `raw` byte-identically is the single property both rest on.

- **R1 — `breezeRegion()` is the canonical artifact region resolver.** Every region decision in this wave (`createArtifact`'s `region`, `captureContextFrom`'s `region`, the blob key prefix) reads `breezeRegion()` from `apps/api/src/config/env.ts` (env `BREEZE_REGION`, added in Task 2). W03 provisionally wrote `resolveArtifactRegion()` in `services/artifacts/artifactRegion.ts` reading a separate `ARTIFACT_REGION` var; **that resolver re-points to `breezeRegion()` and `ARTIFACT_REGION` is not introduced.** A second region var would let the blob bucket and the sandbox disagree about which region an org is in — precisely the residency claim §8 rests on.

- **R2 — one named `capture` member, and nothing else.** No `ToolExecutionContext` members are added by W01 (see the header note above). No second `executeTool` parameter. No `captureScopeFor(auth, session)` helper and no `resolveCaptureContext` — **there is no run lookup at all.** Earlier drafts resolved `runId` from a chat session with an indexed, memoized `ai_agent_runs` query; the run id now arrives on the AUTH PRINCIPAL, which the agent run path already builds (`services/aiAgents/agentAuthContext.ts:78` sets `principal: { kind: 'ai_agent', agentId, runId }`, and `:89` sets `orgId: run.orgId`). So `resolveCaptureContext`, its module-level memo and the partial `ai_agent_runs(session_id)` index it needed are **removed, not deferred**. The capture path issues zero queries of its own.

- **R3 — a new tool needs SIX registration places, not four.** Spec §5.3 lists four; the real set is six: (1) the `aiTools` map via a `registerXTools()` call in `aiTools.ts`, (2) `TOOL_TIERS` in `aiAgentSdkTools.ts`, (3) `TOOL_CAPABILITY` + `AGENT_CAPABILITIES` in `aiAgents/agentToolCatalog.ts`, (4) the `tool()` declaration in `createBreezeMcpServer`, (5) `toolInputSchemas` in `aiToolSchemas.ts` (and its per-domain file), (6) `TOOL_PERMISSIONS` in `aiGuardrails.ts`. **W01 registers no new tool**, so this binds only in reverse, for Task 1's removal of the three orphan backup tools: Task 1 covers (2), (4), (5) and (6), and (1) is vacuous (they were never registered — that is the defect). **(3) is not covered by Task 1's written steps** — add a step there before Step 8: `grep -n "get_backup_health\|run_backup_verification\|get_recovery_readiness" apps/api/src/services/aiAgents/agentToolCatalog.ts`; delete any `TOOL_CAPABILITY` entry it finds, and if removing them empties a capability, drop that capability from `AGENT_CAPABILITIES` too. `agentToolCatalog.contract.test.ts` (already in Task 1's step-8 run list) fails on a stale entry, so a red there means this grep found something the steps did not.

- **R4 — the capture org, by path.**
  - **Run path:** `auth.orgId`. The `ai_agent` principal is built from the run row itself and always carries the run's org (`agentAuthContext.ts:89`, `orgId: run.orgId`), so there is nothing to supply and no call site to change.
  - **Chat path:** `capture.orgId`, taken from `ActiveSession.orgId` — the canonical org for a session, and the reason `auth.orgId` will not do: it is `null` for a partner-scope login (`aiAgentSdk.ts:1947-1948`).
  - **Never `auth.accessibleOrgIds`.** Picking the single entry of a one-org array is a guess, and a guessed org on a tenant-scoped row is a tenancy bug waiting for its second org. No org ⇒ no capture ⇒ raw passthrough, not an error.

- **R5 — the anchor, and only one per artifact.** `runId` (from the principal) wins; a run-anchored capture stores `session_id = NULL`, so the run page's list cannot double-count through a session join. A chat capture anchors on `capture.sessionId`, which is `ActiveSession.breezeSessionId` — the `ai_sessions.id` the artifact row's `session_id` FK points at, NOT W03's `ToolExecutionContext.sessionId` (an agent run's execution-ledger session). `runId == null && sessionId == null → passthrough`.

- **R6 — route ownership.** W01 owns `GET /ai/agents/runs/:runId/artifacts`. It is registered **inside `aiAgentsRoutes`** (`routes/aiAgents.ts`), immediately before that file's `get('/runs/:runId', …)`, NOT as a second Hono app mounted at the same `/ai/agents` prefix — see Task 10. W05 Task 5 must NOT re-add it; W05 only consumes the DTO.

### Which call sites change in W01

Exactly one.

| Call site | W01 change |
|---|---|
| `aiAgentSdkTools.ts` chat path (`makeHandler`) | **Yes** — pass `capture: { orgId: session.orgId, sessionId: session.breezeSessionId }` from `getActiveSession()`. Requires `makeHandler` to gain `getActiveSession` via the local alias (Task 9 step 6). |
| Agent run path | None — attribution is already on the `ai_agent` principal. |
| `makeSessionAwareHandler` (`aiAgentSdkTools.ts:632`) | None — **verified**: it dispatches to `sessionHandler`, not to `executeTool`, so there is no options bag to extend. Revisit only if that changes. |
| `routes/mcpServer.ts` | None — passes no `capture`, so capture is passthrough by design in W01. |
| `services/scriptBuilderTools.ts` | None — same; its existing `context` (verified release material) is untouched. |
| `jobs/intentReleaseWorker.ts` | None — same; its existing `context: { …verifiedContext, actionIntentId }` is untouched. |

Extending the three non-chat callers to attribute captures is later-wave work, and Task 9 pins their passthrough behaviour with a test so a later wave cannot enable them by accident.

---

## File Structure

**packages/shared**
- Create `src/types/aiArtifacts.ts` — `AI_ARTIFACT_KINDS`, `AiArtifactKind`, `AiRunArtifactDto`; export from `src/types/index.ts`.

**apps/api — config**
- Modify `src/config/env.ts` — `aiWorkspaceEnabled()`, `breezeRegion()`.
- Modify `src/config/validate.ts` — declare the new keys; boot rules.
- Modify `src/routes/mcpServer.ts:1736` — read region through `breezeRegion()`.
- Modify `.env.example`, `deploy/.env.example`, `docker-compose.yml`, `deploy/docker-compose.prod.yml`.

**apps/api — data**
- Create `migrations/2026-10-16-100000-ai-run-artifacts.sql`.
- Create `src/db/schema/aiWorkspace.ts`; modify `src/db/schema/index.ts`.
- Modify `src/services/tenantCascade.ts` (cascade order + blob pre-clear), `src/services/tenantExportPolicyRegistry.ts`, `src/services/orgMergeRegistry.ts`.
- Create `src/__tests__/integration/aiRunArtifacts.integration.test.ts`.

**apps/api — services/artifacts/** (new directory, one responsibility per file)
- `blobStorage.ts` — `BlobStorage` interface, S3 backend, memory backend, `getBlobStorage()`, errors.
- `artifactService.ts` — `createArtifact`, `resolveArtifact`, `findArtifactForAuth`, `listArtifactsForAuth`, `openArtifactStream`, `deleteArtifact`, `toArtifactDto`, previews.
- `toolResultCapture.ts` — `CaptureScope`, `CaptureContext`, `captureContextFrom`, `captureLargeToolResult`.

**apps/api — seams modified**
- `src/services/aiToolOutput.ts` — export `MAX_TOOL_RESULT_CHARS`; envelope-aware compaction with `maxChars`.
- `src/services/aiTools.ts` — `AiTool.captureExempt`, `ExecuteToolOptions.capture`, the hook.
- `src/services/aiAgentSdkTools.ts` — `makeToolHandler(…, getActiveSession)` + local `makeHandler` alias; orphan backup tool removal.
- `src/services/aiGuardrails.ts`, `src/services/aiToolSchemasBackup.ts`, `src/services/helperToolFilter.ts` — orphan backup tool removal.
- `src/routes/aiArtifacts.ts` (+ `.test.ts`) — download only; `src/index.ts` — ONE mount (`/ai/artifacts`).
- `src/routes/aiAgents.ts` (+ `.test.ts`) — `GET /runs/:runId/artifacts` registered inside `aiAgentsRoutes`, above `/runs/:runId` (R6).
- `src/jobs/aiArtifactSweeper.ts` (+ `.test.ts`); `src/jobs/scheduleRegistry.ts`; `src/services/workerRegistry.ts`; `src/jobs/workerReadinessManifest.ts`; `src/services/workerEntrypointClosure.contract.test.ts`.

---

### Task 1: Registry guard — every `makeHandler('<name>')` declaration has an executable handler; remove the three orphan backup tools

**Files:**
- Create: `apps/api/src/services/aiAgentSdkTools.handlerCoverage.contract.test.ts`
- Modify: `apps/api/src/services/aiAgentSdkTools.ts:200-202` (TOOL_TIERS), `:1594-1626` (three `tool()` blocks)
- Modify: `apps/api/src/services/aiGuardrails.ts:1027-1029` (TOOL_PERMISSIONS), `:1204` (rate limit), `:2418-2424` (approval description case)
- Modify: `apps/api/src/services/aiToolSchemasBackup.ts:313-329`
- Delete: `apps/api/src/services/aiToolSchemas.backup.test.ts`
- Modify: `apps/api/src/services/aiAgentSdkTools.registryParity.contract.test.ts:141-146`
- Modify: `apps/api/src/services/helperToolFilter.ts:44-46` (comment), `apps/api/src/services/helperToolFilter.test.ts:89-93,98-102`
- Modify: `apps/api/src/services/aiGuardrails.test.ts:34,548-556`

**Interfaces:**
- Consumes: `getAllRegisteredToolNames()` (`aiTools.ts`), source text of `aiAgentSdkTools.ts` (same technique as `aiAgentSdkTools.mcpCoverage.test.ts`).
- Produces: a contract test that fails the moment a `makeHandler('<x>', …)` declaration names a tool `executeTool` cannot dispatch. Decision recorded: `get_backup_health`, `run_backup_verification`, `get_recovery_readiness` have no handler under any name anywhere (`grep -rn "'get_backup_health'\|'get_recovery_readiness'\|'run_backup_verification'" apps/api/src/services/aiTools*.ts apps/api/src/services/aiToolsBackup*.ts` returns nothing; the real backup tools are `get_backup_status`, `query_backups`, `trigger_backup` in `aiToolsBackup.ts`). Every call has thrown `Unknown tool` since they shipped, so they are removed rather than stubbed.

- [ ] **Step 1: Write the failing contract test**

```ts
// apps/api/src/services/aiAgentSdkTools.handlerCoverage.contract.test.ts
/**
 * Spec 2026-09-13 execution-plane §12 "Registry contracts": every tool the
 * chat/agent MCP server declares through `makeHandler('<name>', …)` routes to
 * `executeTool(name, …)`, which throws `Unknown tool` unless the name is in
 * the core `aiTools` registry (or the session-aware M365/Google tier tables).
 * Three backup tools sat declared-but-unregistered for months: every call the
 * model made failed at execution and no suite noticed, because the existing
 * parity suites only compare `TOOL_TIERS` with the registry, never the
 * `tool()` declarations with the registry.
 *
 * Source-level on purpose (same technique as aiAgentSdkTools.mcpCoverage):
 * the declarations live inside a factory and are not importable. The extractor
 * throws if it finds NOTHING so a restructure cannot make this vacuously pass.
 *
 * NOTE: no vi.mock — this suite needs the REAL registry.
 */
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { getAllRegisteredToolNames } from './aiTools';

const SOURCE = readFileSync(new URL('./aiAgentSdkTools.ts', import.meta.url), 'utf8');

/** Every `makeHandler('<name>'` literal — the exact string executeTool receives. */
function makeHandlerNames(): string[] {
  const names = Array.from(SOURCE.matchAll(/\bmakeHandler\(\s*'([a-z0-9_]+)'/g), (m) => m[1]!);
  if (names.length < 50) {
    throw new Error(`extractor found only ${names.length} makeHandler declarations — aiAgentSdkTools.ts was restructured; fix the regex`);
  }
  return names;
}

/**
 * Frozen allowlist of declared names with no handler. Must stay EMPTY: a new
 * entry means a tool shipped that the model can see and can never run.
 */
const KNOWN_UNBACKED_DECLARATIONS: ReadonlySet<string> = new Set<string>([]);

describe('createBreezeMcpServer: every makeHandler declaration is executable (execution-plane §12)', () => {
  it('every makeHandler(name) has a registered handler executeTool can dispatch', () => {
    const registered = new Set(getAllRegisteredToolNames());
    const unbacked = [...new Set(makeHandlerNames())]
      .filter((name) => !registered.has(name))
      .filter((name) => !KNOWN_UNBACKED_DECLARATIONS.has(name))
      .sort();
    expect(
      unbacked,
      'These tools are declared on the Breeze MCP server via makeHandler(...) but no handler ' +
        'is registered under that name, so every model call throws "Unknown tool". Register ' +
        'the handler (registerXTools in aiTools.ts) or delete the declaration, its TOOL_TIERS ' +
        'entry, its TOOL_PERMISSIONS entry and its input schema.',
    ).toEqual([]);
  });

  it('KNOWN_UNBACKED_DECLARATIONS stays empty and never rots', () => {
    const registered = new Set(getAllRegisteredToolNames());
    const stale = [...KNOWN_UNBACKED_DECLARATIONS].filter((name) => registered.has(name));
    expect(stale).toEqual([]);
    expect(KNOWN_UNBACKED_DECLARATIONS.size).toBe(0);
  });
});
```

- [ ] **Step 2: Run it to verify it fails on the three orphans**

Run: `cd apps/api && npx vitest run src/services/aiAgentSdkTools.handlerCoverage.contract.test.ts`
Expected: FAIL — `expected [ 'get_backup_health', 'get_recovery_readiness', 'run_backup_verification' ] to deeply equal []`.

- [ ] **Step 3: Remove the three `tool()` declarations from `createBreezeMcpServer`**

In `apps/api/src/services/aiAgentSdkTools.ts` delete the three consecutive blocks between `delete_tenant` and `file_operations` (currently lines ~1594-1626):

```ts
    tool(
      'get_backup_health',
      'Get backup and verification health summary for an organization, with optional device focus.',
      { orgId: uuid.optional(), deviceId: backupEntityId.optional() },
      makeHandler('get_backup_health', getAuth, onPreToolUse, onPostToolUse)
    ),

    tool(
      'run_backup_verification',
      'Run integrity or restore verification for a device and return updated readiness data.',
      { /* … */ },
      makeHandler('run_backup_verification', getAuth, onPreToolUse, onPostToolUse)
    ),

    tool(
      'get_recovery_readiness',
      'Get per-device recovery readiness with estimated RTO/RPO and risk factors.',
      { /* … */ },
      makeHandler('get_recovery_readiness', getAuth, onPreToolUse, onPostToolUse)
    ),
```

Then check whether `backupEntityId` (declared at the top of `createBreezeMcpServer`) has any remaining user: `grep -n 'backupEntityId' apps/api/src/services/aiAgentSdkTools.ts`. If the only remaining line is its declaration, delete the declaration too (the `const backupEntityId = z.string().min(1)…` line) — an unused local fails lint.

- [ ] **Step 4: Remove the `TOOL_TIERS` entries**

In `apps/api/src/services/aiAgentSdkTools.ts` (~lines 200-202) delete:

```ts
  get_backup_health: 1,
  run_backup_verification: 2,
  get_recovery_readiness: 1,
```

- [ ] **Step 5: Remove the guardrail entries**

In `apps/api/src/services/aiGuardrails.ts`:

Delete from `TOOL_PERMISSIONS` (~lines 1027-1029):
```ts
  get_backup_health: { resource: 'devices', action: 'read' },
  run_backup_verification: { resource: 'devices', action: 'execute' },
  get_recovery_readiness: { resource: 'devices', action: 'read' },
```

Delete from the rate-limit map (~line 1204):
```ts
  run_backup_verification: { limit: 10, windowSeconds: 300 },
```

Delete the approval-description `case` (~lines 2418-2424):
```ts
    case 'run_backup_verification': {
      const verificationType = typeof input.verificationType === 'string' ? input.verificationType : 'integrity';
      parts.push(`Run ${verificationType} backup verification`);
      if (input.deviceId) parts.push(`on device ${String(input.deviceId).slice(0, 8)}...`);
      if (input.backupJobId) parts.push(`job ${String(input.backupJobId).slice(0, 8)}...`);
      break;
    }
```

- [ ] **Step 6: Remove the input schemas and their test**

In `apps/api/src/services/aiToolSchemasBackup.ts` delete the three entries at the end of `backupToolSchemas` (~lines 313-329: `get_backup_health`, `run_backup_verification`, `get_recovery_readiness`). Then check `backupEntityId` inside that file: `grep -n 'backupEntityId' apps/api/src/services/aiToolSchemasBackup.ts` — if the only remaining line is its declaration, delete it.

Delete the file `apps/api/src/services/aiToolSchemas.backup.test.ts` (its three tests exercise only the removed schemas):

```bash
git rm apps/api/src/services/aiToolSchemas.backup.test.ts
```

- [ ] **Step 7: Shrink the frozen parity allowlist and fix the two tests that named the orphans**

`apps/api/src/services/aiAgentSdkTools.registryParity.contract.test.ts` — `KNOWN_UNREGISTERED_TOOL_TIERS` (~lines 141-146) becomes:

```ts
const KNOWN_UNREGISTERED_TOOL_TIERS: ReadonlySet<string> = new Set([
  'propose_action_plan',
]);
```

`apps/api/src/services/helperToolFilter.test.ts` — replace the `run_backup_verification stays excluded` test (~lines 89-93) and the org-wide list entries (~lines 98-102):

```ts
  it('no level contains a tool that is not registered for execution', () => {
    // The three orphan backup tools used to be the example here; they were
    // removed (execution-plane W01, registry guard). Keep the invariant with a
    // real org-wide tool instead.
    for (const level of ['basic', 'standard', 'extended'] as const) {
      expect(getHelperAllowedTools(level)).not.toContain('get_backup_status');
    }
  });

  it('no level contains org-wide tools (the device-scope gate would deny them)', () => {
    for (const level of ['basic', 'standard', 'extended'] as const) {
      const tools = getHelperAllowedTools(level);
      for (const t of [
        ...ORG_WIDE,
        'get_backup_status',
        'get_cis_compliance',
      ]) {
        expect(tools, `${level} must not contain org-wide tool ${t}`).not.toContain(t);
      }
    }
  });
```

(`get_backup_status` is a real registered org-wide backup tool from `aiToolsBackup.ts`; confirm with `grep -n "'get_backup_status'" apps/api/src/services/aiToolsBackup.ts`.)

`apps/api/src/services/helperToolFilter.ts` (~lines 44-46) — replace the parenthetical comment:

```ts
// standard + device-pinned destructive tools — always PAM-governed.
// (Backup verification is not offered here: the only backup tools registered
// for execution are org-wide — get_backup_status / query_backups / trigger_backup
// — and the Helper gate denies org-wide tools.)
```

`apps/api/src/services/aiGuardrails.test.ts` — delete the `run_backup_verification: 2,` line in the mocked tiers (~line 34) and the test `does not require a special full recovery approval path for backup verification` (~lines 548-556).

- [ ] **Step 8: Run the guard, the parity suites, and the touched tests**

Run:
```bash
cd apps/api && npx vitest run \
  src/services/aiAgentSdkTools.handlerCoverage.contract.test.ts \
  src/services/aiAgentSdkTools.registryParity.contract.test.ts \
  src/services/aiAgentSdkTools.mcpCoverage.test.ts \
  src/services/aiAgents/agentToolCatalog.contract.test.ts \
  src/services/aiGuardrails.readonly.contract.test.ts \
  src/services/aiGuardrails.test.ts \
  src/services/helperToolFilter.test.ts \
  src/services/aiToolSchemas.test.ts
```
Expected: all PASS (the parity suite's "KNOWN_UNREGISTERED_TOOL_TIERS contains no stale entries" passes only because Step 7 shrank the list). If `aiToolSchemas.test.ts` does not exist the last path simply matches nothing — check the reported file count is 7.

- [ ] **Step 9: Typecheck and commit**

Run: `cd apps/api && NODE_OPTIONS=--max-old-space-size=8192 npx tsc --noEmit -p tsconfig.json`
Expected: no errors (an unused `backupEntityId` would surface here as well as in lint).

```bash
git add apps/api/src/services/aiAgentSdkTools.handlerCoverage.contract.test.ts \
  apps/api/src/services/aiAgentSdkTools.ts apps/api/src/services/aiGuardrails.ts \
  apps/api/src/services/aiToolSchemasBackup.ts apps/api/src/services/aiToolSchemas.backup.test.ts \
  apps/api/src/services/aiAgentSdkTools.registryParity.contract.test.ts \
  apps/api/src/services/helperToolFilter.ts apps/api/src/services/helperToolFilter.test.ts \
  apps/api/src/services/aiGuardrails.test.ts
git commit -m "test(ai): guard that every MCP makeHandler declaration is executable; drop three orphan backup tools

get_backup_health, run_backup_verification and get_recovery_readiness were declared
on the Breeze MCP server and tiered but had no aiTools handler under any name, so
every model call threw 'Unknown tool'. Execution-plane spec §12 asks for the guard
before the workspace tools add a fourth registration site.

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_01MwUHaGwobGHrTgu8TcCWqr"
```

Record in the PR body: "Removed three orphan backup tool declarations (never executable). If a backup-health tool is wanted, it needs a real handler in `aiToolsBackup.ts` — filed as a follow-up." Then file the follow-up: `gh issue create --title "AI: backup health / recovery readiness / verification tools need real handlers (declarations removed in execution-plane W01)" --body "See PR #<this PR>. The three tools were declared on the MCP server and in TOOL_TIERS/TOOL_PERMISSIONS/toolInputSchemas but had no aiTools handler; every call failed with 'Unknown tool'. Re-add only together with a handler in aiToolsBackup.ts and the four-site registration (aiTools map, TOOL_TIERS, TOOL_CAPABILITY, tool() declaration)." --label enhancement`.

---

### Task 2: Shared DTO, env flags (`aiWorkspaceEnabled`, `breezeRegion`), boot validation, env docs and compose mappings

**Files:**
- Create: `packages/shared/src/types/aiArtifacts.ts`; Modify: `packages/shared/src/types/index.ts` (append one export line)
- Modify: `apps/api/src/config/env.ts:100-114` (add after `policyDecideEnabled`)
- Create: `apps/api/src/config/env.aiWorkspace.test.ts`
- Modify: `apps/api/src/config/validate.ts:~626` (schema keys) and `:~1807-1822` (superRefine rules, after the POLICY_DECIDE rule)
- Modify: `apps/api/src/config/validate.test.ts` (append a describe block)
- Modify: `apps/api/src/routes/mcpServer.ts:1736`
- Modify: `.env.example` (after line ~1102), `deploy/.env.example` (after line ~431), `docker-compose.yml` (api `environment:` after line ~272), `deploy/docker-compose.prod.yml` (api `environment:` after line ~212)

**Interfaces:**
- Produces:
  ```ts
  // packages/shared/src/types/aiArtifacts.ts
  export const AI_ARTIFACT_KINDS = ['input_capture', 'step_script', 'step_stdout', 'output', 'report'] as const;
  export type AiArtifactKind = (typeof AI_ARTIFACT_KINDS)[number];
  export interface AiRunArtifactDto { id: string; runId: string | null; sessionId: string | null; kind: AiArtifactKind; name: string; contentType: string; bytes: number; sha256: string; headPreview: string; tailPreview: string; sourceDeviceId: string | null; createdByTool: string; expiresAt: string; createdAt: string; downloadPath: string }
  // apps/api/src/config/env.ts
  export type BreezeRegion = 'eu' | 'us';
  export function breezeRegion(): BreezeRegion;      // BREEZE_REGION, default 'us'
  export function aiWorkspaceEnabled(): boolean;     // isHosted() && AI_AGENTS_ENABLED && BREEZE_AI_WORKSPACE_ENABLED
  ```

- [ ] **Step 1: Write the failing env test**

```ts
// apps/api/src/config/env.aiWorkspace.test.ts
import { afterEach, describe, expect, it } from 'vitest';
import { aiWorkspaceEnabled, breezeRegion } from './env';

const ORIGINAL = { ...process.env };
afterEach(() => { process.env = { ...ORIGINAL }; });

describe('aiWorkspaceEnabled() — hosted-only sub-flag of BREEZE_AI_AGENTS_ENABLED (spec §8)', () => {
  it('is false by default', () => {
    delete process.env.BREEZE_AI_WORKSPACE_ENABLED;
    process.env.IS_HOSTED = 'true';
    expect(aiWorkspaceEnabled()).toBe(false);
  });

  it('is false on a self-hosted deployment even when the flag is on', () => {
    process.env.BREEZE_AI_WORKSPACE_ENABLED = 'true';
    process.env.IS_HOSTED = 'false';
    expect(aiWorkspaceEnabled()).toBe(false);
  });

  it('is true only when hosted AND the flag is on (parent flag read at module load)', () => {
    process.env.BREEZE_AI_WORKSPACE_ENABLED = 'true';
    process.env.IS_HOSTED = 'true';
    // AI_AGENTS_ENABLED is a module-load constant; assert the conjunction shape
    // rather than flipping it: with the parent off the result must be false,
    // with the parent on it must be true.
    const { AI_AGENTS_ENABLED } = require('./env') as { AI_AGENTS_ENABLED: boolean };
    expect(aiWorkspaceEnabled()).toBe(AI_AGENTS_ENABLED);
  });
});

describe('breezeRegion()', () => {
  it("defaults to 'us' when BREEZE_REGION is unset or empty", () => {
    delete process.env.BREEZE_REGION;
    expect(breezeRegion()).toBe('us');
    process.env.BREEZE_REGION = '';
    expect(breezeRegion()).toBe('us');
  });

  it("returns 'eu' for BREEZE_REGION=eu (case-insensitive, trimmed)", () => {
    process.env.BREEZE_REGION = ' EU ';
    expect(breezeRegion()).toBe('eu');
  });

  it("falls back to 'us' on an unrecognised value (validate.ts refuses it at boot)", () => {
    process.env.BREEZE_REGION = 'mars';
    expect(breezeRegion()).toBe('us');
  });
});
```

- [ ] **Step 2: Run it to verify it fails**

Run: `cd apps/api && npx vitest run src/config/env.aiWorkspace.test.ts`
Expected: FAIL — `aiWorkspaceEnabled` / `breezeRegion` are not exported from `./env`.

- [ ] **Step 3: Add the shared DTO type**

```ts
// packages/shared/src/types/aiArtifacts.ts
/**
 * AI run artifacts (execution-plane spec 2026-09-13 §5.2 / §6.1). An artifact
 * is bytes a tool or a workspace step produced, stored out of the model's
 * context and referenced by an opaque handle (`id`). The wire shape is what the
 * run page (W05) renders and what `GET /ai/agents/runs/:runId/artifacts`
 * returns; the API never exposes the blob key.
 */
export const AI_ARTIFACT_KINDS = ['input_capture', 'step_script', 'step_stdout', 'output', 'report'] as const;
export type AiArtifactKind = (typeof AI_ARTIFACT_KINDS)[number];

export interface AiRunArtifactDto {
  id: string;
  runId: string | null;
  sessionId: string | null;
  kind: AiArtifactKind;
  name: string;
  contentType: string;
  bytes: number;
  sha256: string;
  /** First ≤ 2048 bytes of the RAW content, UTF-8 decoded, secret-redacted. Text-escape before rendering. */
  headPreview: string;
  /** Last ≤ 2048 bytes, same treatment. */
  tailPreview: string;
  sourceDeviceId: string | null;
  createdByTool: string;
  expiresAt: string;
  createdAt: string;
  /** `/api/v1/ai/artifacts/<id>` — always served as an attachment. */
  downloadPath: string;
}
```

Append to `packages/shared/src/types/index.ts`:

```ts
export * from './aiArtifacts';
```

Run: `cd packages/shared && npx tsc --noEmit -p tsconfig.json` → expected: no errors. (If `index.ts` uses explicit named re-exports rather than `export *`, follow that file's convention instead — read its last 20 lines first.)

- [ ] **Step 4: Add the env readers**

In `apps/api/src/config/env.ts`, directly after `policyDecideEnabled()` (~line 114):

```ts
// Execution plane (spec docs/superpowers/specs/ai-mcp/2026-09-13-ai-agent-execution-plane-design.md §8).
// Sub-flag of BREEZE_AI_AGENTS_ENABLED AND hosted-only (D-I): the sandbox lane
// is the paid channel, and the artifact blob store it needs is S3-compatible
// object storage a self-hoster is not required to run. Read at CALL time so a
// test can flip it per case without vi.resetModules(). With this false, every
// AI tool result is byte-identical to today — the capture hook in
// services/aiTools.ts returns the raw string untouched.
export function aiWorkspaceEnabled(): boolean {
  return isHosted() && AI_AGENTS_ENABLED && envFlag('BREEZE_AI_WORKSPACE_ENABLED', false);
}

export type BreezeRegion = 'eu' | 'us';

// Deployment region. Hosted regions are single-region deployments (one API +
// worker per region), so the process knows its own region from env and every
// org it serves lives in it. Used to pick the artifact blob bucket and, later,
// the sandbox region (spec §8 "Residency"). Previously read inline by
// routes/mcpServer.ts for partner-trust bootstrap; that reader now calls this.
// Unrecognised values resolve to 'us' here; config/validate.ts refuses them at
// boot so a typo cannot reach production.
export function breezeRegion(): BreezeRegion {
  const raw = (process.env.BREEZE_REGION ?? '').trim().toLowerCase();
  return raw === 'eu' ? 'eu' : 'us';
}
```

`isHosted()` is declared further down the same file (~line 177) as a function, so referencing it here is fine (function declarations hoist; it is only called at runtime).

- [ ] **Step 5: Run the env test**

Run: `cd apps/api && npx vitest run src/config/env.aiWorkspace.test.ts`
Expected: PASS (6 tests).

- [ ] **Step 6: Point the existing region reader at the helper**

`apps/api/src/routes/mcpServer.ts:1736` — replace

```ts
    region: ((process.env.BREEZE_REGION as 'us' | 'eu') ?? 'us') as 'us' | 'eu',
```
with
```ts
    region: breezeRegion(),
```
and add `breezeRegion` to the existing `import { … } from '../config/env'` line in that file (grep `from '../config/env'` in `mcpServer.ts`; if there is none, add `import { breezeRegion } from '../config/env';`).

Run: `cd apps/api && npx vitest run src/routes/mcpServer` → expected: all mcpServer* files PASS (check the count matches the ten files listed by `ls src/routes/mcpServer*.test.ts`).

- [ ] **Step 7: Write the failing boot-validation tests**

Append to `apps/api/src/config/validate.test.ts`:

```ts
describe('execution-plane env (W01): BREEZE_REGION / BREEZE_AI_WORKSPACE_ENABLED / ARTIFACT_*', () => {
  const KEYS = [
    'BREEZE_REGION',
    'BREEZE_AI_WORKSPACE_ENABLED',
    'ARTIFACT_BLOB_BACKEND',
    'ARTIFACT_S3_ENDPOINT_EU', 'ARTIFACT_S3_ENDPOINT_US',
    'ARTIFACT_S3_BUCKET_EU', 'ARTIFACT_S3_BUCKET_US',
    'ARTIFACT_S3_REGION_EU', 'ARTIFACT_S3_REGION_US',
    'ARTIFACT_S3_ACCESS_KEY', 'ARTIFACT_S3_SECRET_KEY',
    'ARTIFACT_S3_SSE',
  ] as const;

  it.each(KEYS)('declares %s in the env schema', (key) => {
    expect(ENV_SCHEMA_KEYS).toContain(key);
    expect(buildEnvParseInput({ [key]: 'sentinel' })[key]).toBe('sentinel');
  });

  it('refuses an unrecognised BREEZE_REGION', () => {
    const result = validateWith({ ...validEnv, BREEZE_REGION: 'mars' });
    expect(result.ok).toBe(false);
    expect(result.errors.join('\n')).toMatch(/BREEZE_REGION/);
  });

  it('accepts BREEZE_REGION=eu and BREEZE_REGION=us', () => {
    expect(validateWith({ ...validEnv, BREEZE_REGION: 'eu' }).ok).toBe(true);
    expect(validateWith({ ...validEnv, BREEZE_REGION: 'us' }).ok).toBe(true);
  });

  it('refuses a non-boolean BREEZE_AI_WORKSPACE_ENABLED', () => {
    const result = validateWith({ ...validEnv, BREEZE_AI_WORKSPACE_ENABLED: 'ture' });
    expect(result.ok).toBe(false);
    expect(result.errors.join('\n')).toMatch(/BREEZE_AI_WORKSPACE_ENABLED/);
  });

  it('refuses ARTIFACT_BLOB_BACKEND=db (not available in v1) and any other non-s3 value', () => {
    expect(validateWith({ ...validEnv, ARTIFACT_BLOB_BACKEND: 'db' }).ok).toBe(false);
    expect(validateWith({ ...validEnv, ARTIFACT_BLOB_BACKEND: 'gcs' }).ok).toBe(false);
    expect(validateWith({ ...validEnv, ARTIFACT_BLOB_BACKEND: 's3' }).ok).toBe(true);
    expect(validateWith({ ...validEnv, ARTIFACT_BLOB_BACKEND: '' }).ok).toBe(true);
  });

  it('when the workspace flag is on and hosted, requires a bucket for the deployment region', () => {
    const base = { ...validEnv, IS_HOSTED: 'true', BREEZE_AI_AGENTS_ENABLED: 'true', BREEZE_AI_WORKSPACE_ENABLED: 'true', BREEZE_REGION: 'eu' };
    const noBucket = { ...base };
    delete (noBucket as Record<string, string>).S3_BUCKET;
    delete (noBucket as Record<string, string>).ARTIFACT_S3_BUCKET_EU;
    const result = validateWith(noBucket);
    expect(result.ok).toBe(false);
    expect(result.errors.join('\n')).toMatch(/ARTIFACT_S3_BUCKET_EU/);
    expect(validateWith({ ...noBucket, ARTIFACT_S3_BUCKET_EU: 'bucket', ARTIFACT_S3_ACCESS_KEY: 'k', ARTIFACT_S3_SECRET_KEY: 's' }).ok).toBe(true);
  });
});
```

Before writing this block, read the top ~120 lines of `validate.test.ts` to find the existing helper that runs `validateConfig()` against a supplied env object and returns `{ ok, errors }` (it is used by every other rule test in that file — the name is likely `validateWith`, `runValidation` or similar; `validEnv` is the shared baseline object). Use the file's actual helper name in place of `validateWith`. If the helper returns a different shape (e.g. throws), adapt the assertions to that shape exactly as the neighbouring tests do.

- [ ] **Step 8: Run to verify failure**

Run: `cd apps/api && npx vitest run src/config/validate.test.ts -t "execution-plane env"`
Expected: FAIL — the `declares %s` cases fail (`ENV_SCHEMA_KEYS` does not contain the keys) and the rule tests fail (result `ok` is true where false is expected).

- [ ] **Step 9: Declare the keys and add the rules**

In `apps/api/src/config/validate.ts`, inside `envObjectSchema` next to `BREEZE_AI_AGENTS_POLICY_DECIDE_ENABLED` (~line 626):

```ts
    // Execution plane W01 (spec 2026-09-13 §8). Validated for SHAPE here so a
    // typo boot-refuses instead of silently reading as off / 'us'.
    BREEZE_REGION: z.string().optional(),
    BREEZE_AI_WORKSPACE_ENABLED: z.string().optional(),
    ARTIFACT_BLOB_BACKEND: z.string().optional(),
    ARTIFACT_S3_ENDPOINT_EU: z.string().optional(),
    ARTIFACT_S3_ENDPOINT_US: z.string().optional(),
    ARTIFACT_S3_BUCKET_EU: z.string().optional(),
    ARTIFACT_S3_BUCKET_US: z.string().optional(),
    ARTIFACT_S3_REGION_EU: z.string().optional(),
    ARTIFACT_S3_REGION_US: z.string().optional(),
    ARTIFACT_S3_ACCESS_KEY: z.string().optional(),
    ARTIFACT_S3_SECRET_KEY: z.string().optional(),
    ARTIFACT_S3_SSE: z.string().optional(),
```

Inside the same `superRefine`, directly after the `BREEZE_AI_AGENTS_POLICY_DECIDE_ENABLED` rule (~line 1822):

```ts
    // Execution plane W01 (spec §8). Same class as the two flags above.
    const regionRaw = (data.BREEZE_REGION ?? '').trim().toLowerCase();
    if (regionRaw && regionRaw !== 'eu' && regionRaw !== 'us') {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['BREEZE_REGION'],
        message: 'BREEZE_REGION must be "eu" or "us" when set (hosted regions are single-region deployments). Defaults to "us".',
      });
    }
    const workspaceRaw = (data.BREEZE_AI_WORKSPACE_ENABLED ?? '').trim().toLowerCase();
    if (workspaceRaw && !boolValues.has(workspaceRaw)) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['BREEZE_AI_WORKSPACE_ENABLED'],
        message: 'BREEZE_AI_WORKSPACE_ENABLED must be a boolean (true/false, 1/0, yes/no, on/off) when set. Defaults to false (the workspace lane and artifact capture are dark).',
      });
    }
    const blobBackendRaw = (data.ARTIFACT_BLOB_BACKEND ?? '').trim().toLowerCase();
    if (blobBackendRaw && blobBackendRaw !== 's3') {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['ARTIFACT_BLOB_BACKEND'],
        message: blobBackendRaw === 'db'
          ? 'ARTIFACT_BLOB_BACKEND=db is not available in v1 — there is no generic blob table. Use "s3" (MinIO works locally through S3_ENDPOINT).'
          : 'ARTIFACT_BLOB_BACKEND must be "s3" when set.',
      });
    }
    // With the lane switched on for a hosted region, the blob store for THAT
    // region must be reachable, or the first oversized tool result becomes an
    // `artifact_store_unavailable` error for every technician (spec §9).
    const workspaceOn = boolValues.has(workspaceRaw) && ['true', '1', 'yes', 'on'].includes(workspaceRaw);
    const hostedOn = ['true', '1', 'yes', 'on'].includes((data.IS_HOSTED ?? '').trim().toLowerCase());
    if (workspaceOn && hostedOn) {
      const region = regionRaw === 'eu' ? 'EU' : 'US';
      const bucket = (data[`ARTIFACT_S3_BUCKET_${region}` as 'ARTIFACT_S3_BUCKET_EU' | 'ARTIFACT_S3_BUCKET_US'] ?? '').trim() || (data.S3_BUCKET ?? '').trim();
      const accessKey = (data.ARTIFACT_S3_ACCESS_KEY ?? '').trim() || (data.S3_ACCESS_KEY ?? '').trim();
      const secretKey = (data.ARTIFACT_S3_SECRET_KEY ?? '').trim() || (data.S3_SECRET_KEY ?? '').trim();
      if (!bucket || !accessKey || !secretKey) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: [`ARTIFACT_S3_BUCKET_${region}`],
          message: `BREEZE_AI_WORKSPACE_ENABLED=true on a hosted deployment requires an artifact blob store for region ${region.toLowerCase()}: set ARTIFACT_S3_BUCKET_${region} (or S3_BUCKET) plus ARTIFACT_S3_ACCESS_KEY/ARTIFACT_S3_SECRET_KEY (or S3_ACCESS_KEY/S3_SECRET_KEY).`,
        });
      }
    }
```

`S3_ACCESS_KEY` / `S3_SECRET_KEY` are already declared in the schema next to `S3_BUCKET` (~line 741); if either is not, declare it the same way (`z.string().optional()`), or the #3374 direct-read contract in `validate.test.ts` fails.

- [ ] **Step 10: Run the validate suite**

Run: `cd apps/api && npx vitest run src/config/validate.test.ts`
Expected: PASS, including the pre-existing `#2896` ("validateConfig() reads every declared key") and `#3374` (no undeclared `env.X` reads) contracts.

- [ ] **Step 11: Document every new var in both `.env.example` files and map them in both compose files**

Append to `.env.example` (repo root) directly after the `BREEZE_AI_AGENTS_POLICY_DECIDE_ENABLED` block (~line 1102):

```bash
# --- AI execution plane (hosted only) ---------------------------------------
# Sub-flag of BREEZE_AI_AGENTS_ENABLED. Gates artifact capture of oversized AI
# tool results and (later waves) sandboxed workspaces. Honoured only when
# IS_HOSTED=true; self-hosted deployments see the capability absent. Default off.
# BREEZE_AI_WORKSPACE_ENABLED=false

# Deployment region for the hosted platform: eu | us. Selects the artifact blob
# bucket below and, in later waves, the sandbox region. Default us.
# BREEZE_REGION=us

# Artifact blob store. v1 supports "s3" only (S3-compatible object storage —
# MinIO locally, any provider in production). "db" is refused at boot.
# ARTIFACT_BLOB_BACKEND=s3
# Per-region bucket/endpoint. Each falls back to the platform S3_* value above
# when unset, so a single-bucket dev stack needs nothing here. Keys never carry
# a tenant id; a bucket lifecycle rule of ~60 days on the eu/ and us/ prefixes is
# the operational backstop for blobs whose row insert rolled back.
# ARTIFACT_S3_ENDPOINT_EU=https://object-storage.example.com
# ARTIFACT_S3_ENDPOINT_US=https://object-storage.example.com
# ARTIFACT_S3_BUCKET_EU=breeze-ai-artifacts-eu
# ARTIFACT_S3_BUCKET_US=breeze-ai-artifacts-us
# ARTIFACT_S3_REGION_EU=us-east-1
# ARTIFACT_S3_REGION_US=us-east-1
# ARTIFACT_S3_ACCESS_KEY=
# ARTIFACT_S3_SECRET_KEY=
# Server-side encryption header to send on every put: AES256 | aws:kms | unset.
# Leave unset on providers that encrypt at rest and reject the header.
# ARTIFACT_S3_SSE=
```

Append the same block (identical text) to `deploy/.env.example` after the `S3_PRESIGN_TTL` line (~line 431).

Add to `docker-compose.yml` inside the `api:` service `environment:` block, directly after `BREEZE_AI_AGENTS_ENABLED: ${BREEZE_AI_AGENTS_ENABLED:-false}` (~line 272):

```yaml
  # AI execution plane (W01). Hosted-only; all optional. Empty strings are
  # treated as unset by the readers (config/env.ts, services/artifacts/blobStorage.ts).
  BREEZE_AI_WORKSPACE_ENABLED: ${BREEZE_AI_WORKSPACE_ENABLED:-false}
  BREEZE_REGION: ${BREEZE_REGION:-}
  ARTIFACT_BLOB_BACKEND: ${ARTIFACT_BLOB_BACKEND:-}
  ARTIFACT_S3_ENDPOINT_EU: ${ARTIFACT_S3_ENDPOINT_EU:-}
  ARTIFACT_S3_ENDPOINT_US: ${ARTIFACT_S3_ENDPOINT_US:-}
  ARTIFACT_S3_BUCKET_EU: ${ARTIFACT_S3_BUCKET_EU:-}
  ARTIFACT_S3_BUCKET_US: ${ARTIFACT_S3_BUCKET_US:-}
  ARTIFACT_S3_REGION_EU: ${ARTIFACT_S3_REGION_EU:-}
  ARTIFACT_S3_REGION_US: ${ARTIFACT_S3_REGION_US:-}
  ARTIFACT_S3_ACCESS_KEY: ${ARTIFACT_S3_ACCESS_KEY:-}
  ARTIFACT_S3_SECRET_KEY: ${ARTIFACT_S3_SECRET_KEY:-}
  ARTIFACT_S3_SSE: ${ARTIFACT_S3_SSE:-}
```

Add the identical twelve lines to `deploy/docker-compose.prod.yml` inside the `api:` service `environment:` block after `S3_PRESIGN_TTL: ${S3_PRESIGN_TTL:-900}` (~line 212). Match the indentation of the surrounding keys in each file exactly. If either compose file has a separate `worker:` service with its own `environment:` block that repeats the `S3_*` keys, add the same twelve lines there too (the sweeper and the run loop execute on the worker role).

- [ ] **Step 12: Run the parity and compose contracts**

Run: `cd apps/api && npx vitest run src/config/envComposeParity.test.ts src/config/composeBindMounts.test.ts src/config/composeSecretFileDefaults.test.ts`
Expected: PASS for both pairs (self-host and droplet).

- [ ] **Step 13: Commit**

```bash
git add packages/shared/src/types/aiArtifacts.ts packages/shared/src/types/index.ts \
  apps/api/src/config/env.ts apps/api/src/config/env.aiWorkspace.test.ts \
  apps/api/src/config/validate.ts apps/api/src/config/validate.test.ts \
  apps/api/src/routes/mcpServer.ts .env.example deploy/.env.example \
  docker-compose.yml deploy/docker-compose.prod.yml
git commit -m "feat(ai): execution-plane env — BREEZE_AI_WORKSPACE_ENABLED, BREEZE_REGION, ARTIFACT_* blob store config

Hosted-only sub-flag read at call time (aiWorkspaceEnabled), a single region reader
(breezeRegion) replacing the inline BREEZE_REGION read in mcpServer.ts, boot-time
shape validation, and the AiRunArtifactDto shared type. Every var documented in both
.env.example files and threaded through both compose api blocks.

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_01MwUHaGwobGHrTgu8TcCWqr"
```

---

### Task 3: `ai_run_artifacts` — Drizzle schema, migration, tenancy registrations, drift check, RLS forge integration test

**Files:**
- Create: `apps/api/src/db/schema/aiWorkspace.ts`; Modify: `apps/api/src/db/schema/index.ts:70` (add after `aiKillState`)
- Create: `apps/api/migrations/2026-10-16-100000-ai-run-artifacts.sql`
- Modify: `apps/api/src/services/tenantCascade.ts:298-299` (cascade order)
- Modify: `apps/api/src/services/tenantExportPolicyRegistry.ts:~92` (after `"ai_operator_tasks"`, before `"ai_screenshots"`)
- Modify: `apps/api/src/services/orgMergeRegistry.ts:~234` (`SPECIAL`, after `ai_operator_operations`)
- Create: `apps/api/src/__tests__/integration/aiRunArtifacts.integration.test.ts`
- Create: `apps/api/src/db/schema/aiWorkspace.test.ts`

**Interfaces:**
- Consumes: `AI_ARTIFACT_KINDS`, `AiArtifactKind` from `@breeze/shared` (Task 2); `aiAgentRuns` (`./aiAgents`), `aiSessions` (`./ai`), `devices`, `organizations`.
- Produces:
  ```ts
  export const aiArtifactKind = pgEnum('ai_artifact_kind', AI_ARTIFACT_KINDS);
  export const aiRunArtifacts = pgTable('ai_run_artifacts', { … });  // columns exactly as spec §6.1 (+ blobKey), camelCase
  export type AiRunArtifactRow = typeof aiRunArtifacts.$inferSelect;
  ```

- [ ] **Step 1: Write the failing schema test**

```ts
// apps/api/src/db/schema/aiWorkspace.test.ts
import { describe, expect, it } from 'vitest';
import { getTableColumns, getTableName } from 'drizzle-orm';
import { AI_ARTIFACT_KINDS } from '@breeze/shared';
import { aiArtifactKind, aiRunArtifacts } from './aiWorkspace';

describe('ai_run_artifacts Drizzle schema (spec §6.1)', () => {
  it('has exactly the spec columns in snake_case, plus blob_key', () => {
    expect(getTableName(aiRunArtifacts)).toBe('ai_run_artifacts');
    const names = Object.values(getTableColumns(aiRunArtifacts)).map((c) => c.name).sort();
    expect(names).toEqual([
      'blob_key', 'bytes', 'content_type', 'created_at', 'created_by_tool', 'expires_at',
      'head_preview', 'id', 'kind', 'name', 'org_id', 'run_id', 'session_id', 'sha256',
      'source_device_id', 'tail_preview',
    ]);
  });

  it('names the device pointer source_device_id, never device_id (must not join the device cascade lists)', () => {
    const names = Object.values(getTableColumns(aiRunArtifacts)).map((c) => c.name);
    expect(names).not.toContain('device_id');
    expect(names).toContain('source_device_id');
  });

  it('kind enum matches the shared AI_ARTIFACT_KINDS', () => {
    expect(aiArtifactKind.enumName).toBe('ai_artifact_kind');
    expect([...aiArtifactKind.enumValues]).toEqual([...AI_ARTIFACT_KINDS]);
  });

  it('run_id is nullable (chat-session captures have no run) and org_id is not', () => {
    const cols = getTableColumns(aiRunArtifacts);
    expect(cols.runId.notNull).toBe(false);
    expect(cols.orgId.notNull).toBe(true);
    expect(cols.sessionId.notNull).toBe(false);
  });
});
```

- [ ] **Step 2: Run it to verify it fails**

Run: `cd apps/api && npx vitest run src/db/schema/aiWorkspace.test.ts`
Expected: FAIL — `Cannot find module './aiWorkspace'`.

- [ ] **Step 3: Write the schema file**

```ts
// apps/api/src/db/schema/aiWorkspace.ts
import { sql } from 'drizzle-orm';
import {
  bigint,
  foreignKey,
  index,
  pgEnum,
  pgTable,
  text,
  timestamp,
  uuid,
} from 'drizzle-orm/pg-core';
import { AI_ARTIFACT_KINDS, type AiArtifactKind } from '@breeze/shared';
import { aiSessions } from './ai';
import { aiAgentRuns } from './aiAgents';
import { devices } from './devices';
import { organizations } from './orgs';

export type { AiArtifactKind };

/**
 * AI execution plane — artifact store (spec 2026-09-13 §5.2 / §6.1; SQL in
 * migrations/2026-10-16-100000-ai-run-artifacts.sql).
 *
 * `ai_run_artifacts` is Shape 1 (direct NOT NULL org_id, RLS forced). One row
 * per stored blob; `id` IS the handle the model and the UI hold. Rules that
 * must not drift:
 *
 *  - `run_id` is NULLABLE. A chat session can capture an oversized tool result
 *    with no run in flight (spec §5.4: technicians gather live reads in chat
 *    and hand the handles to workspace_launch_analysis). The composite
 *    `(run_id, org_id) -> ai_agent_runs(id, org_id)` FK is MATCH SIMPLE, so it
 *    is unchecked while run_id is NULL and binding otherwise. ON DELETE CASCADE
 *    + DEFERRABLE INITIALLY IMMEDIATE (org merge runs SET CONSTRAINTS ALL
 *    DEFERRED; a non-deferrable composite org FK aborts it with 23503).
 *  - The device pointer is `source_device_id`, deliberately NOT `device_id`:
 *    artifacts outlive the device and must not be enrolled in the device
 *    cascade / move-org lists, which key on a `device_id` column
 *    (routes/devices/core.ts, breeze_device_child_orgid_tables()).
 *  - `blob_key` is opaque (`<region>/<yyyy>/<mm>/<uuid>`) and carries no
 *    tenant id. It never leaves the API (toArtifactDto omits it).
 *  - `head_preview` / `tail_preview` hold ≤ 2048 chars of the RAW bytes
 *    (UTF-8 decoded, NUL-stripped, secret-redacted) — never a compacted view.
 *
 * Export policy: every column `included` (bounded text / ids / counters);
 * there is no jsonb here on purpose — anything open-ended lives in the blob.
 */
export const aiArtifactKind = pgEnum('ai_artifact_kind', AI_ARTIFACT_KINDS);

export const aiRunArtifacts = pgTable('ai_run_artifacts', {
  id: uuid('id').primaryKey().defaultRandom(),
  orgId: uuid('org_id').notNull().references(() => organizations.id),
  // Composite FK declared in the table extras below (Drizzle needs both columns).
  runId: uuid('run_id'),
  sessionId: uuid('session_id').references(() => aiSessions.id, { onDelete: 'set null' }),
  kind: aiArtifactKind('kind').notNull(),
  name: text('name').notNull(),
  contentType: text('content_type').notNull(),
  bytes: bigint('bytes', { mode: 'number' }).notNull(),
  sha256: text('sha256').notNull(),
  blobKey: text('blob_key').notNull(),
  headPreview: text('head_preview').notNull().default(''),
  tailPreview: text('tail_preview').notNull().default(''),
  sourceDeviceId: uuid('source_device_id').references(() => devices.id, { onDelete: 'set null' }),
  createdByTool: text('created_by_tool').notNull(),
  expiresAt: timestamp('expires_at', { withTimezone: true })
    .notNull()
    .default(sql`now() + interval '30 days'`),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
}, (t) => [
  foreignKey({
    name: 'ai_run_artifacts_run_org_fk',
    columns: [t.runId, t.orgId],
    foreignColumns: [aiAgentRuns.id, aiAgentRuns.orgId],
  }).onDelete('cascade'),
  index('ai_run_artifacts_org_run_idx').on(t.orgId, t.runId),
  index('ai_run_artifacts_org_expires_idx').on(t.orgId, t.expiresAt),
  index('ai_run_artifacts_org_source_device_idx').on(t.orgId, t.sourceDeviceId),
  // Sweeper scan is cross-org under system scope; the (org_id, expires_at)
  // index cannot serve `WHERE expires_at < now()` on its own.
  index('ai_run_artifacts_expires_idx').on(t.expiresAt),
]);

export type AiRunArtifactRow = typeof aiRunArtifacts.$inferSelect;

// ---------------------------------------------------------------------------
// W02 export slot — `aiRunWorkspaces` (spec §6.2) and the enums
// `aiWorkspaceBackend` ('vercel'|'gvisor_pool'|'agentcore'|'fake'),
// `aiWorkspaceStatus` ('creating'|'ready'|'destroying'|'destroyed'|'destroy_failed'),
// `aiWorkspaceRegion` ('eu'|'us') are added BELOW this line by wave W02. Do not
// add them here in W01.
// ---------------------------------------------------------------------------
```

Add to `apps/api/src/db/schema/index.ts` after `export * from './aiKillState';` (line 70):

```ts
export * from './aiWorkspace';
```

- [ ] **Step 4: Run the schema test**

Run: `cd apps/api && npx vitest run src/db/schema/aiWorkspace.test.ts`
Expected: PASS (4 tests). If `aiArtifactKind.enumName` is not the property name in this Drizzle version, use whichever of `enumName` / `name` the `pgEnum` object exposes (check `node_modules/drizzle-orm/pg-core/columns/enum.d.ts`) — the assertion is on the SQL type name `ai_artifact_kind`.

- [ ] **Step 5: Re-check the migration slot, then write the migration**

Run: `ls apps/api/migrations/*.sql | sort | tail -1`
Expected: `apps/api/migrations/2026-10-15-160010-backup-snapshots-layout-manifest.sql`. If anything newer than `2026-10-16-100000` is listed, rename this file so it sorts after it (keep the same slug) and use the new name everywhere below.

```sql
-- apps/api/migrations/2026-10-16-100000-ai-run-artifacts.sql
-- AI execution plane W01 — artifact store (spec
-- docs/superpowers/specs/ai-mcp/2026-09-13-ai-agent-execution-plane-design.md
-- §5.2, §6.1, §8). Drizzle mirror: src/db/schema/aiWorkspace.ts.
--
-- One new Shape-1 tenant table. DDL only: this file writes no rows, so it
-- elects no `breeze.scope` (any future DML here must
-- `SELECT set_config('breeze.scope','system',true)` FIRST — see
-- src/db/migrationRlsScope.test.ts).
--
-- Design points, each traceable to the spec:
--
--  1. `run_id` is NULLABLE (chat-session captures have no run, §5.4). The
--     composite FK `(run_id, org_id) -> ai_agent_runs(id, org_id)` is MATCH
--     SIMPLE — unchecked while run_id is NULL, binding otherwise — and is
--     DEFERRABLE INITIALLY IMMEDIATE because org merge runs `SET CONSTRAINTS
--     ALL DEFERRED` and re-points parent and child org_id in separate
--     statements (orgLifecycleFoundations.integration.test.ts). ON DELETE
--     CASCADE: an artifact is meaningless without its run.
--  2. Its target `ai_agent_runs_id_org_uq UNIQUE (id, org_id)` already
--     exists (src/db/schema/aiAgents.ts:185; shipped 2026-09-05-a, renamed by
--     2026-09-25), so section 0's guarded ADD CONSTRAINT is a defensive
--     no-op — it is there for a from-scratch replay, never for a live DB.
--  3. `source_device_id`, never `device_id` (§6.1): artifacts outlive the
--     device and must NOT be enrolled in the device cascade / move-org lists,
--     which key on a `device_id` column. ON DELETE SET NULL.
--  4. `kind` is a real ENUM: it is never an index column, so the
--     leakproof-operator concern that makes state columns text+CHECK
--     elsewhere (2026-10-14 header note 1) does not apply.
--  5. `blob_key` carries NO tenant identifier (§5.2, §8); the row is the only
--     index to the blob, so every delete path removes the blob FIRST.
--  6. Previews are bounded text (≤ 2048 chars), not jsonb — every column here
--     is exportable `included`; nothing open-ended lives in the row.
--
-- Idempotent throughout; autoMigrate wraps this file in one transaction —
-- no inner BEGIN/COMMIT.

-- ---------------------------------------------------------------------------
-- 0. Enum + composite FK target on ai_agent_runs
-- ---------------------------------------------------------------------------

DO $$ BEGIN
  CREATE TYPE ai_artifact_kind AS ENUM ('input_capture', 'step_script', 'step_stdout', 'output', 'report');
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conrelid = 'ai_agent_runs'::regclass
      AND conname IN ('ai_agent_runs_id_org_uq', 'ai_agent_runs_id_org_id_key')
  ) THEN
    ALTER TABLE ai_agent_runs ADD CONSTRAINT ai_agent_runs_id_org_uq UNIQUE (id, org_id);
  END IF;
END $$;

-- ---------------------------------------------------------------------------
-- 1. ai_run_artifacts
-- ---------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS ai_run_artifacts (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id uuid NOT NULL REFERENCES organizations(id),
  run_id uuid,
  session_id uuid REFERENCES ai_sessions(id) ON DELETE SET NULL,
  kind ai_artifact_kind NOT NULL,
  name text NOT NULL
    CONSTRAINT ai_run_artifacts_name_len_chk CHECK (length(name) BETWEEN 1 AND 200),
  content_type text NOT NULL
    CONSTRAINT ai_run_artifacts_content_type_len_chk CHECK (length(content_type) BETWEEN 1 AND 128),
  bytes bigint NOT NULL
    CONSTRAINT ai_run_artifacts_bytes_chk CHECK (bytes >= 0),
  sha256 text NOT NULL
    CONSTRAINT ai_run_artifacts_sha256_chk CHECK (sha256 ~ '^[0-9a-f]{64}$'),
  blob_key text NOT NULL
    CONSTRAINT ai_run_artifacts_blob_key_len_chk CHECK (length(blob_key) BETWEEN 1 AND 256),
  head_preview text NOT NULL DEFAULT ''
    CONSTRAINT ai_run_artifacts_head_preview_len_chk CHECK (length(head_preview) <= 2048),
  tail_preview text NOT NULL DEFAULT ''
    CONSTRAINT ai_run_artifacts_tail_preview_len_chk CHECK (length(tail_preview) <= 2048),
  source_device_id uuid REFERENCES devices(id) ON DELETE SET NULL,
  created_by_tool text NOT NULL
    CONSTRAINT ai_run_artifacts_created_by_tool_len_chk CHECK (length(created_by_tool) BETWEEN 1 AND 128),
  expires_at timestamptz NOT NULL DEFAULT (now() + interval '30 days'),
  created_at timestamptz NOT NULL DEFAULT now()
);

ALTER TABLE ai_run_artifacts DROP CONSTRAINT IF EXISTS ai_run_artifacts_run_org_fk;
ALTER TABLE ai_run_artifacts ADD CONSTRAINT ai_run_artifacts_run_org_fk
  FOREIGN KEY (run_id, org_id) REFERENCES ai_agent_runs (id, org_id)
  ON DELETE CASCADE DEFERRABLE INITIALLY IMMEDIATE;

CREATE INDEX IF NOT EXISTS ai_run_artifacts_org_run_idx ON ai_run_artifacts (org_id, run_id);
CREATE INDEX IF NOT EXISTS ai_run_artifacts_org_expires_idx ON ai_run_artifacts (org_id, expires_at);
CREATE INDEX IF NOT EXISTS ai_run_artifacts_org_source_device_idx ON ai_run_artifacts (org_id, source_device_id);
-- Sweeper scan is cross-org under system scope (jobs/aiArtifactSweeper.ts).
CREATE INDEX IF NOT EXISTS ai_run_artifacts_expires_idx ON ai_run_artifacts (expires_at);

-- ---------------------------------------------------------------------------
-- 2. RLS — Shape 1, same idiom as action_intents / ai_operator_tasks.
-- breeze_has_org_access() returns TRUE for system scope internally, so there
-- is no separate system branch.
-- ---------------------------------------------------------------------------

ALTER TABLE ai_run_artifacts ENABLE ROW LEVEL SECURITY;
ALTER TABLE ai_run_artifacts FORCE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS breeze_org_isolation_select ON ai_run_artifacts;
DROP POLICY IF EXISTS breeze_org_isolation_insert ON ai_run_artifacts;
DROP POLICY IF EXISTS breeze_org_isolation_update ON ai_run_artifacts;
DROP POLICY IF EXISTS breeze_org_isolation_delete ON ai_run_artifacts;

CREATE POLICY breeze_org_isolation_select ON ai_run_artifacts
  FOR SELECT USING (public.breeze_has_org_access(org_id));
CREATE POLICY breeze_org_isolation_insert ON ai_run_artifacts
  FOR INSERT WITH CHECK (public.breeze_has_org_access(org_id));
CREATE POLICY breeze_org_isolation_update ON ai_run_artifacts
  FOR UPDATE USING (public.breeze_has_org_access(org_id))
  WITH CHECK (public.breeze_has_org_access(org_id));
CREATE POLICY breeze_org_isolation_delete ON ai_run_artifacts
  FOR DELETE USING (public.breeze_has_org_access(org_id));

GRANT SELECT, INSERT, UPDATE, DELETE ON ai_run_artifacts TO breeze_app;
```

- [ ] **Step 6: Run the migration unit contracts**

Run: `cd apps/api && npx vitest run src/db/autoMigrate.test.ts src/db/migrationRlsScope.test.ts && bash ../../scripts/check-migration-naming.sh`
Expected: PASS; the naming guard prints nothing / exits 0 (the file sorts after the newest committed migration).

- [ ] **Step 7: Register the cascade order (children before parents is enforced at runtime by `topologicalCascadeOrder`, the ARRAY is alphabetical)**

In `apps/api/src/services/tenantCascade.ts` `CORE_ORG_CASCADE_DELETE_ORDER`, between `'ai_operator_tasks',` (line 298) and `'ai_screenshots',` (line 299) insert:

```ts
  // Execution plane W01 (spec §6.1): artifact rows. Child of ai_agent_runs via
  // the composite (run_id, org_id) FK, ON DELETE CASCADE — topologicalCascadeOrder()
  // reads that edge from pg_constraint and deletes these before the runs. Blob
  // bytes are pre-cleared in cascadeDeleteOrg step 1a-bis (Task 6) BEFORE any
  // row goes, because the row is the only index to the key.
  'ai_run_artifacts',
```

Verify: `grep -n "'ai_run_artifacts'" apps/api/src/services/tenantCascade.ts` → exactly one hit, and `sed -n '296,306p' apps/api/src/services/tenantCascade.ts` shows `ai_operator_tasks` < `ai_run_artifacts` < `ai_screenshots`.

- [ ] **Step 8: Classify every column in the export policy**

In `apps/api/src/services/tenantExportPolicyRegistry.ts`, directly after the `"ai_operator_tasks": tablePolicy(...)` line (~92) and before `"ai_screenshots"`, add (one line, matching the file's compact style):

```ts
  "ai_run_artifacts": tablePolicy("org_id", {"included":["id","org_id","run_id","session_id","kind","name","content_type","bytes","sha256","blob_key","head_preview","tail_preview","source_device_id","created_by_tool","expires_at","created_at"],"reviewedIncluded":[],"excludedSensitive":[],"excludedOpen":[]}),
```

Rationale (record in the PR body, not the file): `blob_key` follows the `ticket_attachments.storage_key` precedent (an opaque locator, useless without credentials, and the customer's own data index); `sha256` follows `ticket_attachments.sha256`; previews are bounded, redacted text of the customer's own tool output. No jsonb column exists.

Verify: `grep -c '"ai_run_artifacts"' apps/api/src/services/tenantExportPolicyRegistry.ts` → `1`. Then run the static checker: `cd apps/api && npx tsx scripts/check-tenant-export-policy.ts` → expected exit 0 (if the script needs `DATABASE_URL`, defer to Task 12's integration run and note it).

- [ ] **Step 9: Classify the table for org merge**

In `apps/api/src/services/orgMergeRegistry.ts` `SPECIAL`, directly after the `ai_operator_operations:` entry (~line 234):

```ts
  ai_run_artifacts: { kind: 'leave-for-erasure', note: 'artifacts hang off ai_agent_runs (leave-for-erasure) via the composite (run_id, org_id) FK ON DELETE CASCADE, or off a chat session whose org is likewise immutable history; blobs are region-keyed with no tenant id, so nothing is re-pointed — rows die with the loser shell and the sweeper/erasure pre-clear removes the bytes' },
```

Verify: `grep -n 'ai_run_artifacts' apps/api/src/services/orgMergeRegistry.ts` → one hit inside `SPECIAL`. No `BEFORE UPDATE` trigger exists on the table, so there is nothing to add to a trigger classification (confirm: `grep -n 'CREATE TRIGGER' apps/api/migrations/2026-10-16-100000-ai-run-artifacts.sql` → no output).

- [ ] **Step 10: Write the RLS forge integration test**

```ts
// apps/api/src/__tests__/integration/aiRunArtifacts.integration.test.ts
import './setup';
import { afterEach, describe, expect, it } from 'vitest';
import { eq, inArray } from 'drizzle-orm';
import { db, withDbAccessContext, withSystemDbAccessContext, type DbAccessContext } from '../../db';
import { aiAgentRuns, aiAgents, aiRunArtifacts } from '../../db/schema';
import { createOrganization, createPartner, createUser } from './db-utils';

/**
 * Execution-plane W01 (spec §6.1, §12 "Integration (live DB)"): RLS forge on
 * ai_run_artifacts (42501), the composite tenant FK (23503), org isolation on
 * SELECT, and the ON DELETE CASCADE from ai_agent_runs. `rls-coverage`
 * auto-discovers the table's policy set; this file proves the predicates bite.
 */

const SYSTEM_CTX: DbAccessContext = { scope: 'system', orgId: null, accessibleOrgIds: null, accessiblePartnerIds: null, userId: null };
const createdArtifacts: string[] = [];
const createdRuns: string[] = [];
const createdAgents: string[] = [];

afterEach(async () => {
  await withDbAccessContext(SYSTEM_CTX, async () => {
    if (createdArtifacts.length) await db.delete(aiRunArtifacts).where(inArray(aiRunArtifacts.id, createdArtifacts));
    if (createdRuns.length) await db.delete(aiAgentRuns).where(inArray(aiAgentRuns.id, createdRuns));
    if (createdAgents.length) await db.delete(aiAgents).where(inArray(aiAgents.id, createdAgents));
  });
  createdArtifacts.length = 0; createdRuns.length = 0; createdAgents.length = 0;
});

function orgContext(orgId: string, currentPartnerId: string | null): DbAccessContext {
  return { scope: 'organization', orgId, accessibleOrgIds: [orgId], accessiblePartnerIds: [], userId: null, currentPartnerId };
}

async function expectSqlState(fn: () => Promise<unknown>, code: string): Promise<void> {
  let raised: unknown;
  try { await fn(); } catch (err) { raised = err; }
  expect(raised, `expected SQLSTATE ${code}, but the statement succeeded`).toBeDefined();
  const cause = (raised as { cause?: { code?: string } })?.cause;
  expect(cause?.code ?? (raised as { code?: string })?.code).toBe(code);
}

/** An org with a live agent and one run. */
async function orgWithRun() {
  const partner = await createPartner();
  const org = await createOrganization({ partnerId: partner.id });
  const user = await createUser({ partnerId: partner.id });
  const [agent] = await withDbAccessContext(SYSTEM_CTX, () =>
    db.insert(aiAgents).values({ orgId: org.id, partnerId: null, kind: 'triage', name: 'Triage', createdBy: user.id }).returning(),
  );
  createdAgents.push(agent!.id);
  const [run] = await withDbAccessContext(SYSTEM_CTX, () =>
    db.insert(aiAgentRuns).values({
      agentId: agent!.id, orgId: org.id, triggerKind: 'manual', dedupeKey: `art-${crypto.randomUUID()}`,
      modeAtStart: 'shadow', policySnapshot: { schemaVersion: 1 } as never,
    }).returning(),
  );
  createdRuns.push(run!.id);
  return { partner, org, agent: agent!, run: run! };
}

function artifactValues(orgId: string, runId: string | null) {
  return {
    orgId, runId, kind: 'input_capture' as const, name: 'search_logs.json', contentType: 'application/json',
    bytes: 12_345, sha256: 'a'.repeat(64), blobKey: `us/2026/10/${crypto.randomUUID()}`,
    headPreview: '{"rows":[', tailPreview: ']}', createdByTool: 'search_logs',
  };
}

describe('ai_run_artifacts — RLS forge, composite tenant FK, isolation, cascade', () => {
  it('rejects a cross-org forge under the attacker org context (42501)', async () => {
    const victim = await orgWithRun();
    const attacker = await orgWithRun();
    await expectSqlState(
      () => withDbAccessContext(orgContext(attacker.org.id, attacker.partner.id), () =>
        db.insert(aiRunArtifacts).values(artifactValues(victim.org.id, attacker.run.id)).returning()),
      '42501',
    );
  });

  it("rejects a row whose run belongs to another org even under system context (23503, composite FK)", async () => {
    const a = await orgWithRun();
    const b = await orgWithRun();
    await expectSqlState(
      () => withSystemDbAccessContext(() =>
        db.insert(aiRunArtifacts).values(artifactValues(a.org.id, b.run.id)).returning()),
      '23503',
    );
  });

  it('accepts a run-anchored row in its own org and a chat-only row with run_id NULL', async () => {
    const t = await orgWithRun();
    const ctx = orgContext(t.org.id, t.partner.id);
    const [withRun] = await withDbAccessContext(ctx, () =>
      db.insert(aiRunArtifacts).values(artifactValues(t.org.id, t.run.id)).returning());
    const [chatOnly] = await withDbAccessContext(ctx, () =>
      db.insert(aiRunArtifacts).values(artifactValues(t.org.id, null)).returning());
    createdArtifacts.push(withRun!.id, chatOnly!.id);
    expect(withRun!.runId).toBe(t.run.id);
    expect(chatOnly!.runId).toBeNull();
    // Default TTL lands ~30 days out.
    const days = (withRun!.expiresAt.getTime() - Date.now()) / 86_400_000;
    expect(days).toBeGreaterThan(29.9);
    expect(days).toBeLessThan(30.1);
  });

  it("org B cannot SELECT org A's artifact", async () => {
    const a = await orgWithRun();
    const b = await orgWithRun();
    const [row] = await withSystemDbAccessContext(() =>
      db.insert(aiRunArtifacts).values(artifactValues(a.org.id, a.run.id)).returning());
    createdArtifacts.push(row!.id);
    const visible = await withDbAccessContext(orgContext(b.org.id, b.partner.id), () =>
      db.select({ id: aiRunArtifacts.id }).from(aiRunArtifacts).where(eq(aiRunArtifacts.id, row!.id)));
    expect(visible).toEqual([]);
    const own = await withDbAccessContext(orgContext(a.org.id, a.partner.id), () =>
      db.select({ id: aiRunArtifacts.id }).from(aiRunArtifacts).where(eq(aiRunArtifacts.id, row!.id)));
    expect(own).toHaveLength(1);
  });

  it('deleting the run cascades its artifacts (ON DELETE CASCADE on the composite FK)', async () => {
    const t = await orgWithRun();
    const [row] = await withSystemDbAccessContext(() =>
      db.insert(aiRunArtifacts).values(artifactValues(t.org.id, t.run.id)).returning());
    await withSystemDbAccessContext(() => db.delete(aiAgentRuns).where(eq(aiAgentRuns.id, t.run.id)));
    createdRuns.splice(createdRuns.indexOf(t.run.id), 1);
    const left = await withSystemDbAccessContext(() =>
      db.select({ id: aiRunArtifacts.id }).from(aiRunArtifacts).where(eq(aiRunArtifacts.id, row!.id)));
    expect(left).toEqual([]);
  });
});
```

(`aiAgentRuns.triggerKind` accepts `'manual'` — see the CHECK in `2026-09-02-ai-agents.sql`. If `createPartner`/`createOrganization` signatures differ, mirror `aiAgentRuns.integration.test.ts` lines 55-67 exactly.)

- [ ] **Step 11: Bring up a private stack, apply migrations, run the drift check and the integration suites**

```bash
pnpm test-stack up                       # writes .env.test for this worktree
set -a; . ./.env.test; set +a
cd apps/api
DATABASE_URL="$DATABASE_URL" pnpm db:check-drift
npx vitest run --config vitest.integration.config.ts \
  src/__tests__/integration/aiRunArtifacts.integration.test.ts \
  src/__tests__/integration/rls-coverage.integration.test.ts \
  src/__tests__/integration/tenantCascade.integration.test.ts \
  src/__tests__/integration/tenant-export-policy.integration.test.ts \
  src/__tests__/integration/orgMergeRegistry.integration.test.ts \
  src/__tests__/integration/orgCascadeFkOnDelete.integration.test.ts \
  src/__tests__/integration/orgLifecycleFoundations.integration.test.ts
```
Expected: drift check `OK` (one ledger row per migration file); every listed suite PASS. The rls-coverage suite auto-discovers `ai_run_artifacts` as Shape 1 with all four commands covered; `tenantCascade` asserts alphabetised + present + FK-children-first; `tenant-export-policy` asserts all 16 columns classified; `orgMergeRegistry` asserts exactly one policy; `orgCascadeFkOnDelete` sees CASCADE / SET NULL on every new edge; `orgLifecycleFoundations` "merge contract" sees the composite FK is deferrable.

Leave the stack up for Task 6 and Task 12 (or `pnpm test-stack down` now and bring it up again later — say which in the PR notes).

- [ ] **Step 12: Commit**

```bash
git add apps/api/src/db/schema/aiWorkspace.ts apps/api/src/db/schema/aiWorkspace.test.ts \
  apps/api/src/db/schema/index.ts apps/api/migrations/2026-10-16-100000-ai-run-artifacts.sql \
  apps/api/src/services/tenantCascade.ts apps/api/src/services/tenantExportPolicyRegistry.ts \
  apps/api/src/services/orgMergeRegistry.ts \
  apps/api/src/__tests__/integration/aiRunArtifacts.integration.test.ts
git commit -m "feat(db): ai_run_artifacts — Shape-1 artifact table with forced RLS, composite deferrable run FK, tenancy registrations

Spec §6.1. run_id nullable (chat-session captures), source_device_id (never device_id),
blob_key without tenant id, bounded raw previews. Registered in the org cascade order,
export policy (16 columns) and org-merge registry; RLS forge integration test proves
42501 / 23503 / isolation / cascade.

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_01MwUHaGwobGHrTgu8TcCWqr"
```

---

### Task 4: `blobStorage.ts` — region-keyed S3 blob helper, opaque keys, `maxBytes`-bounded streaming put

**Files:**
- Create: `apps/api/src/services/artifacts/blobStorage.ts`
- Create: `apps/api/src/services/artifacts/blobStorage.test.ts`

**Interfaces:**
- Consumes (from `apps/api/src/services/s3Storage.ts`, read in full first — 591 lines): `S3ConfigError`, `S3OperationError`, `classifyS3Failure`, `isS3NotFound`. `coerceS3EndpointUrl` from `@breeze/shared`. `S3Client`, `PutObjectCommand`, `GetObjectCommand`, `DeleteObjectCommand` from `@aws-sdk/client-s3` (`^3.1100.0`, already a dependency). `breezeRegion` from `../../config/env` (Task 2).
- Produces:
  ```ts
  export type BlobRegion = 'eu' | 'us';
  export interface BlobPutResult { key: string; bytes: number; sha256: string }
  export interface BlobStorage {
    put(input: { region: BlobRegion; contentType: string; body: Buffer | NodeJS.ReadableStream; maxBytes: number }): Promise<BlobPutResult>;
    openStream(key: string): Promise<NodeJS.ReadableStream>;   // throws BlobNotFoundError when absent
    delete(key: string): Promise<void>;                        // idempotent
  }
  export function getBlobStorage(): BlobStorage;
  export function createMemoryBlobStorage(): BlobStorage & { readonly objects: Map<string, { body: Buffer; contentType: string }> };
  export function setBlobStorageForTests(storage: BlobStorage | null): void;
  export function blobKeyFor(region: BlobRegion, now?: Date): string;   // `<region>/<yyyy>/<mm>/<uuid>`
  export class BlobStorageUnavailableError extends Error { readonly code: 'artifact_store_unavailable'; readonly status: 503 }
  export class BlobTooLargeError extends Error { readonly code: 'artifact_too_large'; readonly limitBytes: number }
  export class BlobNotFoundError extends Error { readonly code: 'artifact_blob_missing' }
  ```

**Why a new module rather than widening `ticketAttachmentStorage.ts`** (decision 7 above): that module routes on a PER-ROW `'s3' | 'db'` backend recorded at upload time and reads a single platform bucket through `s3Storage.ts`'s module-singleton client. The artifact store needs a PER-REGION bucket and client and has no `db` backend at all. Widening it would change every ticket-attachment call site. `blobStorage.ts` therefore keeps its own client cache and reuses only the error classification helpers `s3Storage.ts` already exports. **`ticketAttachmentStorage.ts` and `s3Storage.ts` are not modified by this wave** — a step below asserts that with `git diff --stat`.

- [ ] **Step 1: Read the two files this task builds on, in full**

```bash
cd /Users/toddhebebrand/.herdr/worktrees/breeze/worktree-rapid-cloud-904e
sed -n '1,120p'  apps/api/src/services/ticketAttachmentStorage.ts
sed -n '1,140p'  apps/api/src/services/s3Storage.ts
grep -n 'export ' apps/api/src/services/s3Storage.ts
```

Confirm before writing any code: `s3Storage.ts` exports `S3ConfigError`, `S3OperationError`, `classifyS3Failure`, `isS3NotFound`, and builds its client with `{ endpoint, region, credentials, forcePathStyle: true }`. If any name differs, use the real one.

- [ ] **Step 2: Write the failing blob test**

```ts
// apps/api/src/services/artifacts/blobStorage.test.ts
/**
 * Execution-plane W01 (spec §5.2, §8, §9). The S3 wire path is covered by the
 * ticket-attachment suites; what is unique here and MUST hold is:
 *   - keys carry no tenant identifier and are region/date/uuid shaped,
 *   - `maxBytes` aborts a stream mid-flight rather than buffering past the cap,
 *   - sha256 and byte count are computed from the SAME bytes that were stored,
 *   - delete is idempotent,
 *   - a missing object is BlobNotFoundError, never an empty stream.
 */
import { Readable } from 'node:stream';
import { createHash } from 'node:crypto';
import { afterEach, describe, expect, it } from 'vitest';
import {
  BlobNotFoundError,
  BlobTooLargeError,
  blobKeyFor,
  createMemoryBlobStorage,
  getBlobStorage,
  setBlobStorageForTests,
} from './blobStorage';

afterEach(() => setBlobStorageForTests(null));

async function drain(stream: NodeJS.ReadableStream): Promise<Buffer> {
  const chunks: Buffer[] = [];
  for await (const chunk of stream) chunks.push(Buffer.from(chunk as Buffer));
  return Buffer.concat(chunks);
}

describe('blobKeyFor', () => {
  it('is <region>/<yyyy>/<mm>/<uuid> and carries no tenant identifier', () => {
    const key = blobKeyFor('eu', new Date('2026-10-16T12:00:00Z'));
    expect(key).toMatch(/^eu\/2026\/10\/[0-9a-f-]{36}$/);
  });

  it('zero-pads the month', () => {
    expect(blobKeyFor('us', new Date('2026-03-04T00:00:00Z')).startsWith('us/2026/03/')).toBe(true);
  });

  it('never repeats a key', () => {
    const now = new Date('2026-10-16T12:00:00Z');
    expect(blobKeyFor('us', now)).not.toBe(blobKeyFor('us', now));
  });
});

describe('memory blob storage (the test double every other suite injects)', () => {
  it('round-trips a buffer and reports bytes + sha256 of the stored bytes', async () => {
    const store = createMemoryBlobStorage();
    const body = Buffer.from('{"rows":[1,2,3]}', 'utf8');
    const put = await store.put({ region: 'us', contentType: 'application/json', body, maxBytes: 1024 });
    expect(put.bytes).toBe(body.length);
    expect(put.sha256).toBe(createHash('sha256').update(body).digest('hex'));
    expect(await drain(await store.openStream(put.key))).toEqual(body);
  });

  it('accepts a readable stream and hashes what it actually read', async () => {
    const store = createMemoryBlobStorage();
    const body = Buffer.from('a'.repeat(5000), 'utf8');
    const put = await store.put({
      region: 'eu',
      contentType: 'text/plain; charset=utf-8',
      body: Readable.from([body.subarray(0, 2000), body.subarray(2000)]),
      maxBytes: 10_000,
    });
    expect(put.bytes).toBe(5000);
    expect(put.sha256).toBe(createHash('sha256').update(body).digest('hex'));
  });

  it('throws BlobTooLargeError and stores NOTHING when the body exceeds maxBytes', async () => {
    const store = createMemoryBlobStorage();
    await expect(
      store.put({
        region: 'us',
        contentType: 'text/plain',
        body: Readable.from([Buffer.alloc(600), Buffer.alloc(600)]),
        maxBytes: 1000,
      }),
    ).rejects.toBeInstanceOf(BlobTooLargeError);
    expect(store.objects.size).toBe(0);
  });

  it('throws BlobNotFoundError for an unknown key and delete is idempotent', async () => {
    const store = createMemoryBlobStorage();
    await expect(store.openStream('us/2026/10/missing')).rejects.toBeInstanceOf(BlobNotFoundError);
    await store.delete('us/2026/10/missing');
    await store.delete('us/2026/10/missing');
  });
});

describe('getBlobStorage()', () => {
  it('returns the injected double while one is set, and forgets it afterwards', () => {
    const store = createMemoryBlobStorage();
    setBlobStorageForTests(store);
    expect(getBlobStorage()).toBe(store);
    setBlobStorageForTests(null);
    expect(getBlobStorage()).not.toBe(store);
  });

  it('refuses ARTIFACT_BLOB_BACKEND=db — there is no generic blob table in v1', () => {
    const prev = process.env.ARTIFACT_BLOB_BACKEND;
    process.env.ARTIFACT_BLOB_BACKEND = 'db';
    try {
      expect(() => getBlobStorage()).toThrowError(/ARTIFACT_BLOB_BACKEND=db/);
    } finally {
      if (prev === undefined) delete process.env.ARTIFACT_BLOB_BACKEND;
      else process.env.ARTIFACT_BLOB_BACKEND = prev;
    }
  });
});
```

- [ ] **Step 3: Run it to verify it fails**

Run: `cd apps/api && npx vitest run src/services/artifacts/blobStorage.test.ts`
Expected: FAIL — `Failed to resolve import "./blobStorage"`.

- [ ] **Step 4: Write `blobStorage.ts`**

```ts
// apps/api/src/services/artifacts/blobStorage.ts
import { randomUUID, createHash } from 'node:crypto';
import { Readable } from 'node:stream';
import {
  DeleteObjectCommand,
  GetObjectCommand,
  PutObjectCommand,
  S3Client,
} from '@aws-sdk/client-s3';
import { coerceS3EndpointUrl } from '@breeze/shared';
import { breezeRegion } from '../../config/env';
import { classifyS3Failure, isS3NotFound } from '../s3Storage';

/**
 * Artifact blob store (execution-plane spec 2026-09-13 §5.2, §8, §9).
 *
 * Separate from `ticketAttachmentStorage.ts` on purpose: that module routes on
 * a PER-ROW `'s3' | 'db'` backend chosen at upload time and reads ONE platform
 * bucket through `s3Storage.ts`'s module-singleton client. Artifacts need a
 * PER-REGION bucket and client and have no `db` backend. Only the error
 * CLASSIFICATION helpers are shared; the ticket path is untouched by this wave.
 *
 * Invariants that must not drift:
 *
 *  - **Keys carry no tenant identifier** (§5.2, §8): `<region>/<yyyy>/<mm>/<uuid>`.
 *    An org merge or device move re-stamps rows only; objects never move. The
 *    row is the ONLY index to a key, so every delete path removes the blob
 *    BEFORE the row.
 *  - **`maxBytes` aborts the stream** rather than truncating: a truncated blob
 *    whose sha256 was computed over the truncated bytes would look intact
 *    forever. Over-cap is a typed error the caller turns into a tool error.
 *  - **A put failure is never a silent fallback** (§9). It throws
 *    `BlobStorageUnavailableError`; the capture path turns that into
 *    `{ error: 'artifact_store_unavailable' }` and does NOT return the raw
 *    result inline (which would bypass the context cap the capture exists for).
 *  - Per-region config falls back to the platform `S3_*` vars so a single-bucket
 *    dev stack (MinIO) works with no extra env.
 */

export type BlobRegion = 'eu' | 'us';

export interface BlobPutResult {
  key: string;
  bytes: number;
  sha256: string;
}

export interface BlobStorage {
  put(input: {
    region: BlobRegion;
    contentType: string;
    body: Buffer | NodeJS.ReadableStream;
    maxBytes: number;
  }): Promise<BlobPutResult>;
  openStream(key: string): Promise<NodeJS.ReadableStream>;
  /** Idempotent: deleting an absent key resolves. */
  delete(key: string): Promise<void>;
}

/** The provider is unreachable/misconfigured. Callers map this to §9's `artifact_store_unavailable` / HTTP 503. */
export class BlobStorageUnavailableError extends Error {
  readonly code = 'artifact_store_unavailable' as const;
  readonly status = 503 as const;
  constructor(message: string, options?: { cause?: unknown }) {
    super(message, options);
    this.name = 'BlobStorageUnavailableError';
  }
}

/** The body exceeded the caller's cap. Nothing was stored. */
export class BlobTooLargeError extends Error {
  readonly code = 'artifact_too_large' as const;
  constructor(readonly limitBytes: number) {
    super(`Artifact body exceeds the ${limitBytes}-byte cap`);
    this.name = 'BlobTooLargeError';
  }
}

/** The key is genuinely absent (swept, or a failed compensating delete left the row). */
export class BlobNotFoundError extends Error {
  readonly code = 'artifact_blob_missing' as const;
  constructor(key: string) {
    super(`Artifact blob not found: ${key.slice(0, 64)}`);
    this.name = 'BlobNotFoundError';
  }
}

/** `<region>/<yyyy>/<mm>/<uuid>` — no org id, no run id, no filename (§5.2). */
export function blobKeyFor(region: BlobRegion, now: Date = new Date()): string {
  const yyyy = String(now.getUTCFullYear());
  const mm = String(now.getUTCMonth() + 1).padStart(2, '0');
  return `${region}/${yyyy}/${mm}/${randomUUID()}`;
}

/**
 * Read a body into memory, hashing as we go, and REFUSE at `maxBytes`.
 *
 * In-memory rather than a multipart `@aws-sdk/lib-storage` upload (decision 8):
 * the capture path already holds the whole string in memory, and every W01/W03
 * cap is far below `CAPTURE_MAX_BYTES`. If a later wave needs > 64 MiB single
 * blobs, add `lib-storage` and stream through it — the interface does not change.
 */
async function collectBounded(
  body: Buffer | NodeJS.ReadableStream,
  maxBytes: number,
): Promise<{ buffer: Buffer; sha256: string }> {
  if (Buffer.isBuffer(body)) {
    if (body.length > maxBytes) throw new BlobTooLargeError(maxBytes);
    return { buffer: body, sha256: createHash('sha256').update(body).digest('hex') };
  }
  const hash = createHash('sha256');
  const chunks: Buffer[] = [];
  let total = 0;
  for await (const raw of body) {
    const chunk = Buffer.isBuffer(raw) ? raw : Buffer.from(raw as string);
    total += chunk.length;
    if (total > maxBytes) {
      // Stop pulling immediately; a partially-read source must not be stored.
      (body as Readable).destroy?.();
      throw new BlobTooLargeError(maxBytes);
    }
    hash.update(chunk);
    chunks.push(chunk);
  }
  return { buffer: Buffer.concat(chunks, total), sha256: hash.digest('hex') };
}

// ---------------------------------------------------------------------------
// S3 backend
// ---------------------------------------------------------------------------

function envFor(region: BlobRegion, suffix: string): string | undefined {
  const scoped = process.env[`ARTIFACT_S3_${suffix}_${region.toUpperCase()}`];
  return scoped && scoped.trim() !== '' ? scoped.trim() : undefined;
}

function platformEnv(name: string): string | undefined {
  const value = process.env[name];
  return value && value.trim() !== '' ? value.trim() : undefined;
}

function bucketFor(region: BlobRegion): string {
  const bucket = envFor(region, 'BUCKET') ?? platformEnv('S3_BUCKET');
  if (!bucket) {
    throw new BlobStorageUnavailableError(
      `No artifact bucket configured for region ${region}: set ARTIFACT_S3_BUCKET_${region.toUpperCase()} or S3_BUCKET`,
    );
  }
  return bucket;
}

const clients = new Map<BlobRegion, S3Client>();

function clientFor(region: BlobRegion): S3Client {
  const cached = clients.get(region);
  if (cached) return cached;

  const accessKeyId = platformEnv('ARTIFACT_S3_ACCESS_KEY') ?? platformEnv('S3_ACCESS_KEY');
  const secretAccessKey = platformEnv('ARTIFACT_S3_SECRET_KEY') ?? platformEnv('S3_SECRET_KEY');
  if (!accessKeyId || !secretAccessKey) {
    throw new BlobStorageUnavailableError(
      'No artifact storage credentials: set ARTIFACT_S3_ACCESS_KEY/ARTIFACT_S3_SECRET_KEY (or S3_ACCESS_KEY/S3_SECRET_KEY)',
    );
  }

  let endpoint: string | undefined;
  try {
    endpoint = coerceS3EndpointUrl(envFor(region, 'ENDPOINT') ?? platformEnv('S3_ENDPOINT'));
  } catch (err) {
    // Never echo the value — an endpoint can carry inline credentials
    // (s3Storage.ts redactUrlCredentials, same reasoning).
    throw new BlobStorageUnavailableError(
      `ARTIFACT_S3_ENDPOINT_${region.toUpperCase()} (or S3_ENDPOINT) is not a valid URL`,
      { cause: err },
    );
  }

  const client = new S3Client({
    endpoint,
    region: envFor(region, 'REGION') ?? platformEnv('S3_REGION') ?? 'us-east-1',
    credentials: { accessKeyId, secretAccessKey },
    // Required for MinIO and other path-style S3-compatible providers.
    forcePathStyle: true,
  });
  clients.set(region, client);
  return client;
}

/** Drop the cached clients so a test (or a config reload) rebuilds them. */
export function resetBlobClientsForTests(): void {
  clients.clear();
}

function unavailable(operation: string, err: unknown): BlobStorageUnavailableError {
  const classification = classifyS3Failure(err);
  console.error(`[artifacts/blobStorage] ${operation} failed: reason=${classification.code}`);
  return new BlobStorageUnavailableError(classification.message, { cause: err });
}

function createS3BlobStorage(): BlobStorage {
  return {
    async put({ region, contentType, body, maxBytes }) {
      // Bound + hash BEFORE touching the provider, so an over-cap body costs no
      // request and leaves no partial object.
      const { buffer, sha256 } = await collectBounded(body, maxBytes);
      const key = blobKeyFor(region);
      const sse = platformEnv('ARTIFACT_S3_SSE');
      try {
        await clientFor(region).send(
          new PutObjectCommand({
            Bucket: bucketFor(region),
            Key: key,
            Body: buffer,
            ContentLength: buffer.length,
            ContentType: contentType,
            Metadata: { sha256 },
            ...(sse ? { ServerSideEncryption: sse as 'AES256' } : {}),
          }),
        );
      } catch (err) {
        if (err instanceof BlobStorageUnavailableError) throw err;
        throw unavailable('put', err);
      }
      return { key, bytes: buffer.length, sha256 };
    },

    async openStream(key) {
      const region = regionOfKey(key);
      try {
        const resp = await clientFor(region).send(
          new GetObjectCommand({ Bucket: bucketFor(region), Key: key }),
        );
        const stream = resp.Body as unknown as Readable | undefined;
        if (!stream) throw new BlobNotFoundError(key);
        return stream;
      } catch (err) {
        if (err instanceof BlobNotFoundError || err instanceof BlobStorageUnavailableError) throw err;
        // A genuinely absent key is NOT a transport fault — the route 404s it,
        // never a 503, and never the other way round (#1807/#1808 lesson).
        if (isS3NotFound(err)) throw new BlobNotFoundError(key);
        throw unavailable('openStream', err);
      }
    },

    async delete(key) {
      const region = regionOfKey(key);
      try {
        await clientFor(region).send(
          new DeleteObjectCommand({ Bucket: bucketFor(region), Key: key }),
        );
      } catch (err) {
        if (err instanceof BlobStorageUnavailableError) throw err;
        // S3 DeleteObject is already idempotent for a missing key; this arm
        // exists for providers that 404 instead.
        if (isS3NotFound(err)) return;
        throw unavailable('delete', err);
      }
    },
  };
}

/**
 * The region prefix of a key. An unknown or missing prefix falls back to the
 * DEPLOYMENT region (`breezeRegion()`, R1) rather than to a hard-coded 'us':
 * hard-coding would send an EU deployment's malformed-key lookups at the US
 * bucket, which is a residency violation dressed as a 404.
 */
function regionOfKey(key: string): BlobRegion {
  const prefix = key.split('/', 1)[0];
  if (prefix === 'eu' || prefix === 'us') return prefix;
  return breezeRegion();
}

// ---------------------------------------------------------------------------
// Memory backend (tests only — never selectable from env)
// ---------------------------------------------------------------------------

export function createMemoryBlobStorage(): BlobStorage & {
  readonly objects: Map<string, { body: Buffer; contentType: string }>;
} {
  const objects = new Map<string, { body: Buffer; contentType: string }>();
  return {
    objects,
    async put({ region, contentType, body, maxBytes }) {
      const { buffer, sha256 } = await collectBounded(body, maxBytes);
      const key = blobKeyFor(region);
      objects.set(key, { body: buffer, contentType });
      return { key, bytes: buffer.length, sha256 };
    },
    async openStream(key) {
      const found = objects.get(key);
      if (!found) throw new BlobNotFoundError(key);
      return Readable.from([found.body]);
    },
    async delete(key) {
      objects.delete(key);
    },
  };
}

let override: BlobStorage | null = null;
let s3Singleton: BlobStorage | null = null;

/** Inject a double for the duration of a test; pass `null` in `afterEach`. */
export function setBlobStorageForTests(storage: BlobStorage | null): void {
  override = storage;
}

export function getBlobStorage(): BlobStorage {
  if (override) return override;
  const backend = (process.env.ARTIFACT_BLOB_BACKEND ?? 's3').trim().toLowerCase() || 's3';
  if (backend === 'db') {
    // config/validate.ts already refuses this at boot; this is the second line
    // of defence for a process that skipped validation (a script, a test env).
    throw new Error(
      'ARTIFACT_BLOB_BACKEND=db is not available in v1 — there is no generic blob table. Use "s3" (MinIO works locally through S3_ENDPOINT).',
    );
  }
  if (backend !== 's3') {
    throw new Error(`ARTIFACT_BLOB_BACKEND must be "s3" when set (got "${backend}")`);
  }
  s3Singleton ??= createS3BlobStorage();
  return s3Singleton;
}
```

- [ ] **Step 5: Run the blob test**

Run: `cd apps/api && npx vitest run src/services/artifacts/blobStorage.test.ts`
Expected: PASS (10 tests).

- [ ] **Step 6: Prove the ticket path is untouched, then typecheck and commit**

```bash
cd /Users/toddhebebrand/.herdr/worktrees/breeze/worktree-rapid-cloud-904e
git diff --stat -- apps/api/src/services/ticketAttachmentStorage.ts apps/api/src/services/s3Storage.ts
```
Expected: NO output (decision 7 — neither file is modified by this wave).

```bash
cd apps/api && npx vitest run src/routes/tickets/attachments.test.ts
NODE_OPTIONS=--max-old-space-size=8192 npx tsc --noEmit -p tsconfig.json
```
Expected: attachments suite PASS; tsc no errors.

```bash
git add apps/api/src/services/artifacts/blobStorage.ts apps/api/src/services/artifacts/blobStorage.test.ts
git commit -m "feat(ai): artifact blob storage — region-keyed S3 helper with opaque keys and a hard byte cap

Keys are <region>/<yyyy>/<mm>/<uuid> and carry no tenant identifier (spec §5.2, §8).
maxBytes aborts the stream instead of truncating, so a stored sha256 always covers
the stored bytes. Put failure throws rather than degrading (spec §9). Reuses
s3Storage.ts's failure classification; ticketAttachmentStorage.ts is untouched.

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_01MwUHaGwobGHrTgu8TcCWqr"
```

---

### Task 5: `artifactService.ts` — create (blob-then-row, compensating delete), resolve, stream, delete, raw previews

**Files:**
- Create: `apps/api/src/services/artifacts/artifactService.ts`
- Create: `apps/api/src/services/artifacts/artifactService.test.ts`

**Interfaces:**
- Consumes: `getBlobStorage`, `BlobRegion`, `BlobStorageUnavailableError`, `BlobTooLargeError` (Task 4); `aiRunArtifacts` (Task 3); `db` from `../../db`; `redactAiToolOutputText` (`../aiToolOutput`, already exported at line 116); `AiArtifactKind`, `AiRunArtifactDto` from `@breeze/shared` (Task 2); `AuthContext` from `../../middleware/auth`.
- Produces (the contract's names verbatim, plus the three additions recorded in decision 3):
  ```ts
  export interface ArtifactRecord {
    id: string; orgId: string; runId: string | null; sessionId: string | null;
    kind: AiArtifactKind; name: string; contentType: string; bytes: number; sha256: string;
    blobKey: string; headPreview: string; tailPreview: string;
    sourceDeviceId: string | null; createdByTool: string; expiresAt: Date; createdAt: Date;
  }
  export interface CreateArtifactInput {
    orgId: string; runId: string | null; sessionId?: string | null; kind: AiArtifactKind;
    name: string; contentType: string; body: Buffer | NodeJS.ReadableStream; maxBytes: number;
    sourceDeviceId?: string | null; createdByTool: string; region: BlobRegion; ttlDays?: number;
  }
  export async function createArtifact(input: CreateArtifactInput): Promise<ArtifactRecord>;
  export async function resolveArtifact(handle: string, scope: { orgId: string; runId?: string }): Promise<ArtifactRecord | null>;
  export async function findArtifactForAuth(handle: string, auth: AuthContext): Promise<ArtifactRecord | null>;
  export async function listArtifactsForAuth(runId: string, auth: AuthContext): Promise<ArtifactRecord[]>;
  export async function openArtifactStream(record: ArtifactRecord): Promise<NodeJS.ReadableStream>;
  export async function deleteArtifact(record: ArtifactRecord): Promise<void>;
  export function toArtifactDto(record: ArtifactRecord): AiRunArtifactDto;
  export function sanitizeArtifactName(raw: string): string;
  export function buildPreviews(raw: Buffer | string): { headPreview: string; tailPreview: string };
  export const ARTIFACT_PREVIEW_BYTES = 2048;
  export const ARTIFACT_DEFAULT_TTL_DAYS = 30;
  ```

`resolveArtifact` returns `null` for BOTH "no such row" and "wrong org/run" and NEVER distinguishes them (spec §5.2 handles are opaque; §9 `artifact_forbidden` is the tool-layer label the CALLER produces, after `resolveArtifact` has already told it nothing). RLS is the real boundary; the `org_id` predicate here is defence-in-depth for the mocked-db unit path, exactly as `GET /runs/:runId` documents at `routes/aiAgents.ts:1206-1210`.

- [ ] **Step 1: Write the failing service test**

```ts
// apps/api/src/services/artifacts/artifactService.test.ts
/**
 * Execution-plane W01 (spec §5.2, §8, §9, §12). Proves the properties that are
 * NOT visible from the route or the capture hook:
 *   - blob is written BEFORE the row, and a row-insert failure compensates by
 *     deleting the blob (the key would otherwise be unreachable forever),
 *   - delete removes the blob BEFORE the row (the row is the only key index),
 *   - previews are RAW head/tail bytes, redacted, NUL-stripped, ≤ 2048 chars,
 *   - resolveArtifact returns null for the wrong org — never a distinguishable
 *     "forbidden",
 *   - toArtifactDto never leaks blobKey.
 */
import { Readable } from 'node:stream';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  insertValues: [] as Record<string, unknown>[],
  insertRows: [] as unknown[],
  insertError: null as unknown,
  selectRows: [] as unknown[][],
  deleteWheres: [] as unknown[],
  calls: [] as string[],
}));

vi.mock('../../db', () => ({
  db: {
    insert: vi.fn(() => ({
      values: vi.fn((v: Record<string, unknown>) => {
        mocks.insertValues.push(v);
        mocks.calls.push('row:insert');
        return {
          returning: vi.fn(async () => {
            if (mocks.insertError) throw mocks.insertError;
            return mocks.insertRows.shift() ?? [];
          }),
        };
      }),
    })),
    select: vi.fn(() => ({
      from: vi.fn(() => ({
        where: vi.fn(() => ({
          limit: vi.fn(async () => mocks.selectRows.shift() ?? []),
          orderBy: vi.fn(async () => mocks.selectRows.shift() ?? []),
        })),
      })),
    })),
    delete: vi.fn(() => ({
      where: vi.fn(async (w: unknown) => {
        mocks.deleteWheres.push(w);
        mocks.calls.push('row:delete');
        return undefined;
      }),
    })),
  },
}));

import {
  ARTIFACT_PREVIEW_BYTES,
  buildPreviews,
  createArtifact,
  deleteArtifact,
  listArtifactsForAuth,
  resolveArtifact,
  sanitizeArtifactName,
  toArtifactDto,
  type ArtifactRecord,
} from './artifactService';
import { createMemoryBlobStorage, setBlobStorageForTests } from './blobStorage';

const ORG = '00000000-0000-4000-8000-0000000000a1';
const OTHER_ORG = '00000000-0000-4000-8000-0000000000a2';
const RUN = '00000000-0000-4000-8000-0000000000a3';
const ART = '00000000-0000-4000-8000-0000000000a4';

let blobs: ReturnType<typeof createMemoryBlobStorage>;

beforeEach(() => {
  mocks.insertValues.length = 0;
  mocks.insertRows.length = 0;
  mocks.selectRows.length = 0;
  mocks.deleteWheres.length = 0;
  mocks.calls.length = 0;
  mocks.insertError = null;
  blobs = createMemoryBlobStorage();
  // Trace blob ops into the SAME ordered list as the row ops, so
  // "blob before row" is provable rather than assumed.
  const realPut = blobs.put.bind(blobs);
  const realDelete = blobs.delete.bind(blobs);
  blobs.put = async (input) => { mocks.calls.push('blob:put'); return realPut(input); };
  blobs.delete = async (key) => { mocks.calls.push('blob:delete'); return realDelete(key); };
  setBlobStorageForTests(blobs);
});
afterEach(() => { setBlobStorageForTests(null); vi.clearAllMocks(); });

function row(over: Partial<Record<string, unknown>> = {}) {
  return {
    id: ART, orgId: ORG, runId: RUN, sessionId: null, kind: 'input_capture',
    name: 'search_logs.json', contentType: 'application/json', bytes: 20, sha256: 'a'.repeat(64),
    blobKey: 'us/2026/10/abc', headPreview: '{"rows"', tailPreview: ']}',
    sourceDeviceId: null, createdByTool: 'search_logs',
    expiresAt: new Date('2026-11-15T00:00:00Z'), createdAt: new Date('2026-10-16T00:00:00Z'),
    ...over,
  };
}

describe('sanitizeArtifactName', () => {
  it('keeps a basename, strips separators, control chars and quotes, caps at 200', () => {
    expect(sanitizeArtifactName('../../etc/passwd')).toBe('passwd');
    expect(sanitizeArtifactName('a"b\\c\u0000d')).toBe('abcd');
    expect(sanitizeArtifactName('x'.repeat(500))).toHaveLength(200);
  });

  it('falls back to a constant when nothing survives', () => {
    expect(sanitizeArtifactName('   ')).toBe('artifact');
    expect(sanitizeArtifactName('/')).toBe('artifact');
  });
});

describe('buildPreviews (spec §5.2 — RAW bytes, never a rendered form)', () => {
  it('returns the whole content in head and tail when it is short', () => {
    const { headPreview, tailPreview } = buildPreviews('{"a":1}');
    expect(headPreview).toBe('{"a":1}');
    expect(tailPreview).toBe('{"a":1}');
  });

  it('caps each side at ARTIFACT_PREVIEW_BYTES and takes head from the start, tail from the end', () => {
    const raw = `HEAD${'x'.repeat(10_000)}TAIL`;
    const { headPreview, tailPreview } = buildPreviews(raw);
    expect(headPreview.startsWith('HEAD')).toBe(true);
    expect(tailPreview.endsWith('TAIL')).toBe(true);
    expect(headPreview.length).toBeLessThanOrEqual(ARTIFACT_PREVIEW_BYTES);
    expect(tailPreview.length).toBeLessThanOrEqual(ARTIFACT_PREVIEW_BYTES);
  });

  it('strips NUL (Postgres text rejects it) and redacts bare secrets', () => {
    const { headPreview } = buildPreviews('tok=sk-ant-abcdefghijklmnopqrstuv\u0000end');
    expect(headPreview).not.toContain('\u0000');
    expect(headPreview).not.toContain('sk-ant-abcdefghijklmnopqrstuv');
    expect(headPreview).toContain('[REDACTED]');
  });
});

describe('createArtifact', () => {
  it('writes the blob BEFORE the row and returns the stored bytes/sha256', async () => {
    mocks.insertRows.push([row()]);
    const record = await createArtifact({
      orgId: ORG, runId: RUN, kind: 'input_capture', name: 'search_logs.json',
      contentType: 'application/json', body: Buffer.from('{"rows":[1,2,3,4,5]}'),
      maxBytes: 1024, createdByTool: 'search_logs', region: 'us',
    });
    expect(mocks.calls).toEqual(['blob:put', 'row:insert']);
    expect(record.id).toBe(ART);
    const written = mocks.insertValues[0]!;
    expect(written.bytes).toBe(20);
    expect(String(written.sha256)).toMatch(/^[0-9a-f]{64}$/);
    expect(String(written.blobKey)).toMatch(/^us\/\d{4}\/\d{2}\//);
  });

  it('compensates by deleting the blob when the row insert fails, and rethrows', async () => {
    mocks.insertError = Object.assign(new Error('insert boom'), { code: '23503' });
    await expect(createArtifact({
      orgId: ORG, runId: RUN, kind: 'output', name: 'out.txt', contentType: 'text/plain',
      body: Buffer.from('hello'), maxBytes: 1024, createdByTool: 'workspace_collect', region: 'eu',
    })).rejects.toThrow('insert boom');
    expect(mocks.calls).toEqual(['blob:put', 'row:insert', 'blob:delete']);
    expect(blobs.objects.size).toBe(0);
  });

  it('accepts a stream body and defaults expiry to 30 days', async () => {
    mocks.insertRows.push([row()]);
    await createArtifact({
      orgId: ORG, runId: null, kind: 'step_stdout', name: 'step-1.out',
      contentType: 'text/plain; charset=utf-8',
      body: Readable.from([Buffer.from('abc'), Buffer.from('def')]),
      maxBytes: 1024, createdByTool: 'workspace_run', region: 'us',
    });
    const written = mocks.insertValues[0]!;
    expect(written.bytes).toBe(6);
    const days = ((written.expiresAt as Date).getTime() - Date.now()) / 86_400_000;
    expect(days).toBeGreaterThan(29.9);
    expect(days).toBeLessThan(30.1);
  });
});

describe('resolveArtifact (spec §5.2 — null covers both not-found and forbidden)', () => {
  it('returns the record for the owning org', async () => {
    mocks.selectRows.push([row()]);
    expect((await resolveArtifact(ART, { orgId: ORG }))?.id).toBe(ART);
  });

  it('returns null — not a distinguishable error — when the row belongs to another org', async () => {
    mocks.selectRows.push([]); // the org predicate excluded it
    expect(await resolveArtifact(ART, { orgId: OTHER_ORG })).toBeNull();
  });

  it('returns null for a handle that is not a uuid, without querying', async () => {
    expect(await resolveArtifact('not-a-uuid', { orgId: ORG })).toBeNull();
    expect(mocks.calls).toEqual([]);
  });

  it('returns null when a runId scope is supplied and the row belongs to another run', async () => {
    mocks.selectRows.push([]);
    expect(await resolveArtifact(ART, { orgId: ORG, runId: '00000000-0000-4000-8000-0000000000ff' })).toBeNull();
  });
});

describe('deleteArtifact — blob first, then row (the row is the only key index)', () => {
  it('deletes in that order', async () => {
    const record = { ...row(), blobKey: 'us/2026/10/k1' } as unknown as ArtifactRecord;
    await blobs.put({ region: 'us', contentType: 'text/plain', body: Buffer.from('x'), maxBytes: 10 });
    await deleteArtifact(record);
    expect(mocks.calls).toEqual(['blob:delete', 'row:delete']);
  });

  it('leaves the row in place when the blob delete throws, so the erasure is rerunnable', async () => {
    blobs.delete = async () => { mocks.calls.push('blob:delete'); throw new Error('bucket down'); };
    await expect(deleteArtifact(row() as unknown as ArtifactRecord)).rejects.toThrow('bucket down');
    expect(mocks.calls).toEqual(['blob:delete']);
  });
});

describe('listArtifactsForAuth / toArtifactDto', () => {
  it('never exposes blobKey and renders the download path', async () => {
    mocks.selectRows.push([row()]);
    const auth = { orgCondition: () => undefined } as never;
    const [dto] = (await listArtifactsForAuth(RUN, auth)).map(toArtifactDto);
    expect(dto).toBeDefined();
    expect(Object.keys(dto!)).not.toContain('blobKey');
    expect(dto!.downloadPath).toBe(`/api/v1/ai/artifacts/${ART}`);
    expect(dto!.expiresAt).toBe('2026-11-15T00:00:00.000Z');
  });
});
```

- [ ] **Step 2: Run it to verify it fails**

Run: `cd apps/api && npx vitest run src/services/artifacts/artifactService.test.ts`
Expected: FAIL — `Failed to resolve import "./artifactService"`.

- [ ] **Step 3: Write `artifactService.ts`**

```ts
// apps/api/src/services/artifacts/artifactService.ts
import { and, desc, eq } from 'drizzle-orm';
import { z } from 'zod';
import type { AiArtifactKind, AiRunArtifactDto } from '@breeze/shared';
import { db } from '../../db';
import { aiRunArtifacts } from '../../db/schema';
import type { AuthContext } from '../../middleware/auth';
import { redactAiToolOutputText } from '../aiToolOutput';
import { getBlobStorage, type BlobRegion } from './blobStorage';

/**
 * Artifact records (execution-plane spec 2026-09-13 §5.2, §6.1, §8, §9).
 *
 * ORDER IS THE CONTRACT, in both directions:
 *
 *   create — blob FIRST, row SECOND. A row pointing at a key that was never
 *     written would 404 on download forever; a key with no row is merely
 *     orphaned bytes, which the bucket lifecycle rule reaps. An insert failure
 *     therefore compensates with a blob delete and rethrows.
 *   delete — blob FIRST, row SECOND. The row is the ONLY index to the key, so
 *     a row deleted before its blob strands customer bytes with nothing left to
 *     find them by — the precise GDPR failure erasure exists to prevent. A blob
 *     fault therefore leaves the row and rethrows, which is what makes the
 *     sweeper and org erasure rerunnable (same reasoning as the ticket-attachment
 *     pre-clear in tenantCascade.ts step 1a).
 *
 * `resolveArtifact` returns `null` for a missing row AND for a row outside the
 * caller's org or run, and never distinguishes them: a handle is opaque (§5.2),
 * so "this exists but is not yours" is itself a disclosure. RLS is the real
 * boundary; the org predicate here is defence-in-depth for the mocked-db unit
 * path (same posture as GET /runs/:runId, routes/aiAgents.ts).
 */

export const ARTIFACT_PREVIEW_BYTES = 2048;
export const ARTIFACT_DEFAULT_TTL_DAYS = 30;

const UUID = z.string().guid();

export interface ArtifactRecord {
  id: string;
  orgId: string;
  runId: string | null;
  sessionId: string | null;
  kind: AiArtifactKind;
  name: string;
  contentType: string;
  bytes: number;
  sha256: string;
  /** Opaque `<region>/<yyyy>/<mm>/<uuid>`. NEVER leaves the API — see toArtifactDto. */
  blobKey: string;
  headPreview: string;
  tailPreview: string;
  sourceDeviceId: string | null;
  createdByTool: string;
  expiresAt: Date;
  createdAt: Date;
}

export interface CreateArtifactInput {
  orgId: string;
  /** Null for a chat capture with no agent run in flight (spec §5.4). */
  runId: string | null;
  sessionId?: string | null;
  kind: AiArtifactKind;
  name: string;
  contentType: string;
  body: Buffer | NodeJS.ReadableStream;
  maxBytes: number;
  sourceDeviceId?: string | null;
  createdByTool: string;
  region: BlobRegion;
  ttlDays?: number;
}

const ARTIFACT_COLUMNS = {
  id: aiRunArtifacts.id,
  orgId: aiRunArtifacts.orgId,
  runId: aiRunArtifacts.runId,
  sessionId: aiRunArtifacts.sessionId,
  kind: aiRunArtifacts.kind,
  name: aiRunArtifacts.name,
  contentType: aiRunArtifacts.contentType,
  bytes: aiRunArtifacts.bytes,
  sha256: aiRunArtifacts.sha256,
  blobKey: aiRunArtifacts.blobKey,
  headPreview: aiRunArtifacts.headPreview,
  tailPreview: aiRunArtifacts.tailPreview,
  sourceDeviceId: aiRunArtifacts.sourceDeviceId,
  createdByTool: aiRunArtifacts.createdByTool,
  expiresAt: aiRunArtifacts.expiresAt,
  createdAt: aiRunArtifacts.createdAt,
} as const;

/**
 * Reduce a model- or tool-supplied name to a safe BASENAME (≤ 200, matching the
 * column CHECK). This value is echoed in `Content-Disposition`, so a quote,
 * backslash, CR or LF here is a header-injection vector — removed outright, not
 * escaped, exactly as `sanitizeAttachmentFilename` does for ticket attachments.
 */
export function sanitizeArtifactName(raw: string): string {
  const base = raw.split(/[\\/]/).pop() ?? '';
  // eslint-disable-next-line no-control-regex
  const cleaned = base.replace(/[\u0000-\u001f\u007f"\\]/g, '').trim();
  return cleaned.slice(0, 200).trim() || 'artifact';
}

/**
 * Head/tail of the RAW content (spec §5.2), NOT a compacted or rendered form —
 * the whole point is that the technician can see what the model saw. NUL is
 * stripped because Postgres `text` rejects it outright, and bare secrets are
 * redacted with the same patterns the chat path already applies.
 */
export function buildPreviews(raw: Buffer | string): { headPreview: string; tailPreview: string } {
  const text = (typeof raw === 'string' ? raw : raw.toString('utf8')).replace(/\u0000/g, '');
  const head = redactAiToolOutputText(text.slice(0, ARTIFACT_PREVIEW_BYTES));
  const tail = redactAiToolOutputText(text.slice(-ARTIFACT_PREVIEW_BYTES));
  // Redaction can only ever lengthen a slice ([REDACTED] vs a short token), so
  // re-clamp rather than trusting the slice width.
  return {
    headPreview: head.slice(0, ARTIFACT_PREVIEW_BYTES),
    tailPreview: tail.slice(-ARTIFACT_PREVIEW_BYTES),
  };
}

export async function createArtifact(input: CreateArtifactInput): Promise<ArtifactRecord> {
  const blobs = getBlobStorage();
  // Buffer the body once when it is already a Buffer so the previews describe
  // exactly the bytes that were stored. A stream body is previewed from the
  // head/tail the blob layer read back (see below).
  const put = await blobs.put({
    region: input.region,
    contentType: input.contentType,
    body: input.body,
    maxBytes: input.maxBytes,
  });

  const previewSource = Buffer.isBuffer(input.body)
    ? input.body
    // A stream was consumed by `put`; re-read the head/tail from the stored
    // object rather than guessing. Small and bounded: two 2 KiB slices.
    : await readPreviewSlice(put.key, put.bytes);

  const { headPreview, tailPreview } = buildPreviews(previewSource);
  const ttlDays = input.ttlDays ?? ARTIFACT_DEFAULT_TTL_DAYS;

  try {
    const [row] = await db
      .insert(aiRunArtifacts)
      .values({
        orgId: input.orgId,
        runId: input.runId,
        sessionId: input.sessionId ?? null,
        kind: input.kind,
        name: sanitizeArtifactName(input.name),
        contentType: input.contentType.slice(0, 128),
        bytes: put.bytes,
        sha256: put.sha256,
        blobKey: put.key,
        headPreview,
        tailPreview,
        sourceDeviceId: input.sourceDeviceId ?? null,
        createdByTool: input.createdByTool.slice(0, 128),
        expiresAt: new Date(Date.now() + ttlDays * 86_400_000),
      })
      .returning(ARTIFACT_COLUMNS);
    if (!row) throw new Error('artifact insert returned no row');
    return row as ArtifactRecord;
  } catch (err) {
    // Compensating delete: without it the key is unreachable forever (no row
    // indexes it) and only the bucket lifecycle rule would ever reap it.
    // Best-effort — a failure here must not mask the real insert error.
    try {
      await blobs.delete(put.key);
    } catch (cleanupErr) {
      console.error('[artifacts] compensating blob delete failed after a failed row insert', cleanupErr);
    }
    throw err;
  }
}

/** Two bounded reads used only when the caller handed us a stream. */
async function readPreviewSlice(key: string, bytes: number): Promise<Buffer> {
  if (bytes === 0) return Buffer.alloc(0);
  const stream = await getBlobStorage().openStream(key);
  const chunks: Buffer[] = [];
  let total = 0;
  const wanted = Math.min(bytes, ARTIFACT_PREVIEW_BYTES * 2);
  for await (const raw of stream) {
    const chunk = Buffer.isBuffer(raw) ? raw : Buffer.from(raw as string);
    chunks.push(chunk);
    total += chunk.length;
    if (total >= wanted) break;
  }
  return Buffer.concat(chunks, total);
}

export async function resolveArtifact(
  handle: string,
  scope: { orgId: string; runId?: string },
): Promise<ArtifactRecord | null> {
  // A non-uuid must never reach the query: Postgres raises 22P02 on the cast
  // and that poisons the whole request transaction, turning a 404 into a 500
  // at COMMIT (the trap `uuidParam` in routes/aiAgents.ts documents).
  if (!UUID.safeParse(handle).success || !UUID.safeParse(scope.orgId).success) return null;
  if (scope.runId !== undefined && !UUID.safeParse(scope.runId).success) return null;

  const [row] = await db
    .select(ARTIFACT_COLUMNS)
    .from(aiRunArtifacts)
    .where(and(
      eq(aiRunArtifacts.id, handle),
      eq(aiRunArtifacts.orgId, scope.orgId),
      ...(scope.runId ? [eq(aiRunArtifacts.runId, scope.runId)] : []),
    ))
    .limit(1);
  return (row as ArtifactRecord | undefined) ?? null;
}

/** Route-side resolve: scoped by `auth.orgCondition`, which is `undefined` (no filter) for system scope. */
export async function findArtifactForAuth(handle: string, auth: AuthContext): Promise<ArtifactRecord | null> {
  if (!UUID.safeParse(handle).success) return null;
  const [row] = await db
    .select(ARTIFACT_COLUMNS)
    .from(aiRunArtifacts)
    .where(and(eq(aiRunArtifacts.id, handle), auth.orgCondition(aiRunArtifacts.orgId)))
    .limit(1);
  return (row as ArtifactRecord | undefined) ?? null;
}

export async function listArtifactsForAuth(runId: string, auth: AuthContext): Promise<ArtifactRecord[]> {
  if (!UUID.safeParse(runId).success) return [];
  const rows = await db
    .select(ARTIFACT_COLUMNS)
    .from(aiRunArtifacts)
    .where(and(eq(aiRunArtifacts.runId, runId), auth.orgCondition(aiRunArtifacts.orgId)))
    .orderBy(desc(aiRunArtifacts.createdAt));
  return rows as ArtifactRecord[];
}

export async function openArtifactStream(record: ArtifactRecord): Promise<NodeJS.ReadableStream> {
  return getBlobStorage().openStream(record.blobKey);
}

export async function deleteArtifact(record: ArtifactRecord): Promise<void> {
  // Blob FIRST. A throw here leaves the row — and therefore the key — findable,
  // which is exactly what makes the sweeper and org erasure rerunnable.
  await getBlobStorage().delete(record.blobKey);
  await db.delete(aiRunArtifacts).where(eq(aiRunArtifacts.id, record.id));
}

/** Wire projection. `blobKey` is omitted BY CONSTRUCTION, not by deletion. */
export function toArtifactDto(record: ArtifactRecord): AiRunArtifactDto {
  return {
    id: record.id,
    runId: record.runId,
    sessionId: record.sessionId,
    kind: record.kind,
    name: record.name,
    contentType: record.contentType,
    bytes: record.bytes,
    sha256: record.sha256,
    headPreview: record.headPreview,
    tailPreview: record.tailPreview,
    sourceDeviceId: record.sourceDeviceId,
    createdByTool: record.createdByTool,
    expiresAt: record.expiresAt.toISOString(),
    createdAt: record.createdAt.toISOString(),
    downloadPath: `/api/v1/ai/artifacts/${record.id}`,
  };
}
```

- [ ] **Step 4: Run the service test**

Run: `cd apps/api && npx vitest run src/services/artifacts/artifactService.test.ts`
Expected: PASS (15 tests). If the Drizzle mock's `.returning(cols)` arity differs from the shape above, mirror the `db` mock in `src/services/aiAgents/runService.test.ts` (read its `vi.mock('../../db', …)` block, roughly lines 62-140) rather than inventing another one.

- [ ] **Step 5: Typecheck and commit**

Run: `cd apps/api && NODE_OPTIONS=--max-old-space-size=8192 npx tsc --noEmit -p tsconfig.json`
Expected: no errors.

```bash
git add apps/api/src/services/artifacts/artifactService.ts apps/api/src/services/artifacts/artifactService.test.ts
git commit -m "feat(ai): artifact service — blob-then-row create with compensating delete, raw previews, opaque resolve

createArtifact writes the blob first and compensates on insert failure; deleteArtifact
removes the blob first so a fault leaves the row (and the key) findable and the sweep
rerunnable. resolveArtifact returns null for both not-found and wrong-org, never
distinguishing them (spec §5.2). Previews are raw head/tail bytes, NUL-stripped and
secret-redacted. toArtifactDto omits blob_key by construction.

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_01MwUHaGwobGHrTgu8TcCWqr"
```

---

### Task 6: Org erasure pre-clears artifact blobs before any row is deleted

**Files:**
- Modify: `apps/api/src/services/tenantCascade.ts:1111-1148` (insert a step "1a-bis" directly after the ticket-attachment pre-clear, before the step 1b loop at ~1150)
- Modify: `apps/api/src/services/tenantCascade.test.ts` (append a describe block)
- Modify: `apps/api/src/__tests__/integration/aiRunArtifacts.integration.test.ts` (append one case)

**Interfaces:**
- Consumes: `dbModule.withSystemDbAccessContext`, `dbModule.db.execute` (already imported in `tenantCascade.ts`), `getBlobStorage` (Task 4), `writeErasureFailedAudit` + `isUndefinedTable` (module-private, lines 1265-1322).
- Produces: no new export — one more pre-clear step inside `cascadeDeleteOrg`.

**Why this step exists and why it must ABORT rather than log:** the ticket-attachment pre-clear's own comment (lines 1111-1118) states the rule — the rows are the only index to the object keys, so deleting rows first strands customer bytes in the bucket with nothing to find them by, "which is exactly the GDPR failure erasure exists to prevent". Artifacts are in the identical position. Best-effort deletion with a logged count is deliberately rejected; a storage fault aborts the erasure BEFORE anything is removed so the operator re-runs it once the bucket is back.

- [ ] **Step 1: Read the existing pre-clear so the new block matches it exactly**

```bash
cd /Users/toddhebebrand/.herdr/worktrees/breeze/worktree-rapid-cloud-904e
sed -n '1105,1190p' apps/api/src/services/tenantCascade.ts
sed -n '1259,1330p' apps/api/src/services/tenantCascade.ts   # writeErasureFailedAudit, isUndefinedTable
grep -n "^import" apps/api/src/services/tenantCascade.ts | tail -12
```

Confirm the local names before editing: `dbModule`, `writeErasureFailedAudit(orgId, performedBy, performedByEmail, step, stats, err)`, `isUndefinedTable(err)`, and that `deleteObjectKeys` is imported at line 50. Use whatever the file actually calls them.

- [ ] **Step 2: Write the failing unit test**

Append to `apps/api/src/services/tenantCascade.test.ts` (read its existing mock setup first — it already mocks `../db` and `./ticketAttachmentStorage`; add `./artifacts/blobStorage` to the same style):

```ts
describe('cascadeDeleteOrg — artifact blob pre-clear (execution-plane W01, spec §8)', () => {
  it('deletes every ai_run_artifacts blob BEFORE any row is deleted', async () => {
    queueArtifactKeys(['us/2026/10/k1', 'eu/2026/10/k2']);
    await cascadeDeleteOrg(ORG_ID, USER_ID);
    // The ordered call trace must show both blob deletes ahead of the first
    // row delete of ANY table — the row is the only index to the key.
    const firstRowDelete = callTrace.findIndex((c) => c.startsWith('delete:'));
    const lastBlobDelete = callTrace.map((c, i) => (c === 'blob:delete' ? i : -1)).filter((i) => i >= 0).pop();
    expect(lastBlobDelete).toBeGreaterThanOrEqual(0);
    expect(lastBlobDelete!).toBeLessThan(firstRowDelete);
  });

  it('aborts the erasure with a rerunnable message when a blob delete fails, deleting no rows', async () => {
    queueArtifactKeys(['us/2026/10/k1']);
    failNextBlobDelete(new Error('bucket down'));
    await expect(cascadeDeleteOrg(ORG_ID, USER_ID)).rejects.toThrow(/artifact blob pre-clear failed.*rerunnable/s);
    expect(callTrace.some((c) => c.startsWith('delete:'))).toBe(false);
  });

  it('tolerates the table not existing yet (a DB behind this migration)', async () => {
    failArtifactKeyQuery(Object.assign(new Error('relation does not exist'), { code: '42P01' }));
    await expect(cascadeDeleteOrg(ORG_ID, USER_ID)).resolves.toBeDefined();
  });
});
```

`queueArtifactKeys`, `failNextBlobDelete`, `failArtifactKeyQuery` and `callTrace` are helpers you add beside the file's existing ones — model them on however the suite already queues `ticket_attachments` storage keys and traces deletes (`grep -n "ticket_attachments\|deleteObjectKeys\|storage_key" apps/api/src/services/tenantCascade.test.ts`). If the suite has no call trace yet, add one by recording each mocked `db.execute`/`deleteObjectKeys`/blob call into a shared array in the order it fires.

- [ ] **Step 3: Run it to verify it fails**

Run: `cd apps/api && npx vitest run src/services/tenantCascade.test.ts -t "artifact blob pre-clear"`
Expected: FAIL — no blob delete happens at all (`lastBlobDelete` is `undefined`).

- [ ] **Step 4: Add step 1a-bis to `cascadeDeleteOrg`**

In `apps/api/src/services/tenantCascade.ts`, immediately after the ticket-attachment `try/catch` that ends at line 1148 and before the step 1b comment at ~1150:

```ts
  // 1a-bis. Clear AI ARTIFACT blobs, same rule and same reasoning as 1a
  //     (execution-plane spec §8: "erasure deletes blobs via the helper before
  //     the rows cascade"). `ai_run_artifacts.blob_key` is the only index to the
  //     object — the key deliberately carries no tenant id, so a bucket listing
  //     cannot reconstruct which objects belonged to this org once the rows are
  //     gone. A storage fault therefore ABORTS the erasure before anything is
  //     removed; the same keys are re-read on the re-run.
  //
  //     Batched: an org with a long agent history can hold tens of thousands of
  //     artifacts, and the blob helper deletes one key per request.
  try {
    const keys = await dbModule.withSystemDbAccessContext(async () => {
      const result = await dbModule.db.execute(sql`
        SELECT blob_key
        FROM ai_run_artifacts
        WHERE org_id = ${orgId}::uuid
      `);
      const rows = (result as unknown as { rows?: Array<{ blob_key: string }> }).rows
        ?? (result as unknown as Array<{ blob_key: string }>);
      return Array.isArray(rows) ? rows.map((r) => r.blob_key).filter(Boolean) : [];
    }, 'tenantCascade.artifactBlobPreClear');
    const blobs = getBlobStorage();
    for (const key of keys) {
      await blobs.delete(key);
    }
  } catch (err) {
    if (!isUndefinedTable(err)) {
      await writeErasureFailedAudit(
        orgId, performedBy, performedByEmail, 'ai_run_artifacts_blobs', stats, err,
      );
      throw new Error(
        `[tenantCascade] artifact blob pre-clear failed for org=${orgId}; erasure aborted before any row was deleted and is rerunnable: ${
          err instanceof Error ? err.message : String(err)
        }`,
      );
    }
  }
```

Add the import beside line 50-51:

```ts
import { getBlobStorage } from './artifacts/blobStorage';
```

If `withSystemDbAccessContext` in this file is called with a single argument at line 1122, drop the `'tenantCascade.artifactBlobPreClear'` label here too — match the file, do not introduce a second convention.

- [ ] **Step 5: Run the unit test and the cascade suite**

Run: `cd apps/api && npx vitest run src/services/tenantCascade.test.ts`
Expected: PASS, including the three new cases and every pre-existing one.

- [ ] **Step 6: Add the integration case proving blobs go before rows against a real DB**

Append to `apps/api/src/__tests__/integration/aiRunArtifacts.integration.test.ts`:

```ts
describe('org erasure pre-clears artifact blobs before rows (spec §8)', () => {
  it('removes the blob and the row, in that order, and is rerunnable', async () => {
    const { createMemoryBlobStorage, setBlobStorageForTests } = await import('../../services/artifacts/blobStorage');
    const { cascadeDeleteOrg } = await import('../../services/tenantCascade');
    const blobs = createMemoryBlobStorage();
    setBlobStorageForTests(blobs);
    try {
      const t = await orgWithRun();
      const put = await blobs.put({ region: 'us', contentType: 'application/json', body: Buffer.from('{"a":1}'), maxBytes: 1024 });
      const [row] = await withSystemDbAccessContext(() =>
        db.insert(aiRunArtifacts).values({ ...artifactValues(t.org.id, t.run.id), blobKey: put.key }).returning());
      expect(blobs.objects.has(put.key)).toBe(true);

      await cascadeDeleteOrg(t.org.id, '00000000-0000-4000-8000-00000000ffff');

      expect(blobs.objects.has(put.key)).toBe(false);
      const left = await withSystemDbAccessContext(() =>
        db.select({ id: aiRunArtifacts.id }).from(aiRunArtifacts).where(eq(aiRunArtifacts.id, row!.id)));
      expect(left).toEqual([]);
      // The org and its run went with it, so nothing needs afterEach cleanup.
      createdRuns.splice(createdRuns.indexOf(t.run.id), 1);
      createdAgents.splice(createdAgents.indexOf(t.agent.id), 1);
    } finally {
      setBlobStorageForTests(null);
    }
  });
});
```

- [ ] **Step 7: Run the integration suites (stack from Task 3 step 11)**

```bash
pnpm test-stack up          # if it was torn down
set -a; . ./.env.test; set +a
cd apps/api && npx vitest run --config vitest.integration.config.ts \
  src/__tests__/integration/aiRunArtifacts.integration.test.ts \
  src/__tests__/integration/tenantCascade.integration.test.ts
```
Expected: both PASS. If `cascadeDeleteOrg` refuses an org that still has a partner/user, mirror whatever `tenantCascade.integration.test.ts` already does to build an erasable org rather than inventing a fixture.

- [ ] **Step 8: Typecheck and commit**

```bash
cd apps/api && NODE_OPTIONS=--max-old-space-size=8192 npx tsc --noEmit -p tsconfig.json
git add apps/api/src/services/tenantCascade.ts apps/api/src/services/tenantCascade.test.ts \
  apps/api/src/__tests__/integration/aiRunArtifacts.integration.test.ts
git commit -m "feat(ai): org erasure pre-clears artifact blobs before any row is deleted

Spec §8. ai_run_artifacts.blob_key is the only index to the object (the key carries
no tenant id by design), so a row deleted before its blob strands customer bytes
permanently. Same rule and same abort-and-rerun posture as the ticket-attachment
pre-clear in step 1a.

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_01MwUHaGwobGHrTgu8TcCWqr"
```

---

### Task 7: `aiToolOutput.ts` — export `MAX_TOOL_RESULT_CHARS`, teach `compactToolResultForChat` the capture envelope

**Files:**
- Modify: `apps/api/src/services/aiToolOutput.ts:50` (export the constant), `:642-709` (`compactToolResultForChat`)
- Modify: `apps/api/src/services/aiToolOutput.test.ts` (append a describe block)

**Interfaces:**
- Produces:
  ```ts
  export const MAX_TOOL_RESULT_CHARS = 8_000;               // was module-private at line 50
  export function compactToolResultForChat(toolName: string, rawResult: string, maxChars?: number): string;
  ```
- The five call sites are UNCHANGED (spec §5.2: "the five compaction call sites are untouched"). The third parameter is optional and defaulted; only this function's internals change.

**Why (decision 10).** Once the capture hook exists, an oversized result reaching a compaction call site is the envelope `{"artifact":{…},"compacted":"<raw json string>"}`, not the tool's native shape. `applyToolSpecificCompaction` (line 521) branches on top-level fields — `stdout`/`exitCode` for command results, `alerts`/`logs` for fleet lists — so it would see `artifact` and `compacted` instead, fall through to the generic path, and the model's view of the compacted half would silently differ from today's. Teaching the single function the envelope keeps every call site and every downstream `summarized`/`_chat` contract intact.

**The two module-private constants this touches:** `MAX_TOOL_RESULT_CHARS = 8_000` (line 50) and `RAW_PREVIEW_CHARS = 2_000` (line 51). Only the first is exported — the capture hook fires on exactly the same threshold, and a duplicated `8_000` in `toolResultCapture.ts` would drift the first time someone tuned it.

- [ ] **Step 1: Write the failing test**

Append to `apps/api/src/services/aiToolOutput.test.ts`:

```ts
import { MAX_TOOL_RESULT_CHARS } from './aiToolOutput';

describe('compactToolResultForChat — capture envelope (execution-plane W01, spec §5.2)', () => {
  const bigStdout = 'L'.repeat(30_000);
  const nativeResult = JSON.stringify({ status: 'success', exitCode: 0, stdout: bigStdout });
  const envelope = JSON.stringify({
    artifact: { handle: '00000000-0000-4000-8000-0000000000a4', bytes: 30_120, contentType: 'application/json', head: '{"status"', tail: '"}' },
    compacted: nativeResult,
  });

  it('is exported so the capture hook fires on exactly the same threshold', () => {
    expect(MAX_TOOL_RESULT_CHARS).toBe(8_000);
  });

  it('keeps the artifact block verbatim and compacts ONLY the inner payload', () => {
    const out = compactToolResultForChat('execute_command', envelope);
    const parsed = JSON.parse(out) as { artifact: Record<string, unknown>; compacted: unknown };
    expect(parsed.artifact).toEqual({
      handle: '00000000-0000-4000-8000-0000000000a4',
      bytes: 30_120,
      contentType: 'application/json',
      head: '{"status"',
      tail: '"}',
    });
    expect(out.length).toBeLessThanOrEqual(MAX_TOOL_RESULT_CHARS);
  });

  it('applies the SAME tool-specific compaction the native shape would have got', () => {
    const viaEnvelope = JSON.parse(compactToolResultForChat('execute_command', envelope)) as { compacted: unknown };
    const direct = JSON.parse(compactToolResultForChat('execute_command', nativeResult)) as Record<string, unknown>;
    // The command-shaped compaction marks its stdout truncation; the envelope
    // path must produce the same inner object, not a generically-trimmed one.
    expect(viaEnvelope.compacted).toEqual(direct);
  });

  it('leaves a non-envelope result byte-identical to today', () => {
    const plain = JSON.stringify({ status: 'success', rows: [1, 2, 3] });
    expect(compactToolResultForChat('query_devices', plain)).toBe(plain);
  });

  it('does not treat a tool payload that merely HAS an `artifact` key as an envelope', () => {
    // `compacted` must be a string AND `artifact.handle` a string — a report
    // tool returning { artifact: { reportId } } is not a capture envelope.
    const lookalike = JSON.stringify({ artifact: { reportId: 'r1' }, rows: [1] });
    expect(compactToolResultForChat('generate_report', lookalike)).toBe(lookalike);
  });

  it('honours an explicit maxChars', () => {
    const out = compactToolResultForChat('query_devices', JSON.stringify({ rows: Array.from({ length: 400 }, (_, i) => ({ i, pad: 'p'.repeat(40) })) }), 1_000);
    expect(out.length).toBeLessThanOrEqual(1_000);
  });
});
```

- [ ] **Step 2: Run it to verify it fails**

Run: `cd apps/api && npx vitest run src/services/aiToolOutput.test.ts -t "capture envelope"`
Expected: FAIL — `MAX_TOOL_RESULT_CHARS` is not exported (the import is a compile error), and the envelope cases fail once it is.

- [ ] **Step 3: Export the constant**

`apps/api/src/services/aiToolOutput.ts:50` — change

```ts
const MAX_TOOL_RESULT_CHARS = 8_000;
```
to
```ts
/**
 * The single chat-context budget for one tool result. EXPORTED because the
 * artifact capture hook (services/artifacts/toolResultCapture.ts) must fire on
 * exactly this threshold: a duplicated literal would drift the first time this
 * is tuned, and the capture would then either never fire or fire on results
 * that still fit.
 */
export const MAX_TOOL_RESULT_CHARS = 8_000;
```

- [ ] **Step 4: Teach `compactToolResultForChat` the envelope**

`apps/api/src/services/aiToolOutput.ts` — change the signature at line 642 and insert the envelope branch immediately after `const parsed = tryParseJson(rawResult);` (line 643), leaving everything below untouched apart from threading `maxChars`:

```ts
/**
 * The shape `captureLargeToolResult` returns for an oversized result
 * (execution-plane spec §5.2): an opaque handle with raw previews, plus the
 * tool's own result, which is then compacted here exactly as it would have been
 * without the capture. Recognised STRUCTURALLY (handle + compacted string), not
 * by the presence of an `artifact` key, so a tool that legitimately returns
 * `{ artifact: … }` is untouched.
 */
function asCaptureEnvelope(value: unknown): { artifact: Record<string, unknown>; compacted: string } | null {
  if (!isRecord(value)) return null;
  const { artifact, compacted } = value as Record<string, unknown>;
  if (typeof compacted !== 'string') return null;
  if (!isRecord(artifact) || typeof artifact.handle !== 'string') return null;
  if (Object.keys(value).length !== 2) return null;
  return { artifact, compacted };
}

export function compactToolResultForChat(
  toolName: string,
  rawResult: string,
  maxChars: number = MAX_TOOL_RESULT_CHARS,
): string {
  const parsed = tryParseJson(rawResult);

  // Capture envelope: the artifact block is small, fixed and must survive
  // verbatim (it is the model's only route back to the bytes). Compact the
  // INNER payload with the remaining budget so `applyToolSpecificCompaction`
  // still sees the tool's native shape — keyed on `stdout`/`alerts`/… — rather
  // than `artifact`/`compacted`, and the model's view of the compacted half is
  // byte-identical to what it would have got with capture switched off.
  const envelope = asCaptureEnvelope(parsed);
  if (envelope) {
    const artifactJson = JSON.stringify({ artifact: envelope.artifact, compacted: '' });
    const innerBudget = Math.max(512, maxChars - artifactJson.length - 8);
    const inner = compactToolResultForChat(toolName, envelope.compacted, innerBudget);
    return safeStringify({ artifact: envelope.artifact, compacted: tryParseJson(inner) ?? inner });
  }

  if (parsed === null) {
    // … unchanged …
    const redactedRaw = redactAiToolOutputText(rawResult);
    if (redactedRaw.length <= maxChars) {
      return redactedRaw;
    }
    // … unchanged …
  }
  // … unchanged, except every remaining `MAX_TOOL_RESULT_CHARS` comparison
  //    becomes `maxChars` (there is exactly one, at line 691).
}
```

Concretely, three edits inside the existing body: line 652 `redactedRaw.length <= MAX_TOOL_RESULT_CHARS` → `<= maxChars`; line 691 `serialized.length <= MAX_TOOL_RESULT_CHARS` → `<= maxChars`; and the new branch above. Nothing else in the function changes, and the `summarized: true` / `_chat` contracts documented at lines 624-641 are untouched.

- [ ] **Step 5: Run the full aiToolOutput suite**

Run: `cd apps/api && npx vitest run src/services/aiToolOutput.test.ts`
Expected: PASS — the six new cases AND every pre-existing one (the `summarized`/`_chat` outcome contracts in particular; if any of those went red, the `maxChars` threading is wrong, not the test).

- [ ] **Step 6: Run the five compaction call sites' suites unchanged**

```bash
cd apps/api && npx vitest run \
  src/services/aiAgentSdkTools \
  src/services/scriptBuilderTools \
  src/services/aiAgentSdk \
  src/routes/mcpServer
```
Expected: all PASS with no source edit at any call site (spec §5.2).

- [ ] **Step 7: Typecheck and commit**

```bash
cd apps/api && NODE_OPTIONS=--max-old-space-size=8192 npx tsc --noEmit -p tsconfig.json
git add apps/api/src/services/aiToolOutput.ts apps/api/src/services/aiToolOutput.test.ts
git commit -m "feat(ai): compactToolResultForChat understands the artifact capture envelope

Exports MAX_TOOL_RESULT_CHARS so the capture hook fires on exactly the same
threshold, and adds an optional maxChars. An { artifact, compacted } envelope keeps
its artifact block verbatim and has only the inner payload compacted, so
applyToolSpecificCompaction still sees the tool's native shape and the model's view
of the compacted half is unchanged. The five call sites are untouched (spec §5.2).

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_01MwUHaGwobGHrTgu8TcCWqr"
```

---

### Task 8: `toolResultCapture.ts` — `CaptureScope`, `CaptureContext`, `captureContextFrom`, threshold, opt-out, `artifact_store_unavailable`

**Files:**
- Create: `apps/api/src/services/artifacts/toolResultCapture.ts`
- Create: `apps/api/src/services/artifacts/toolResultCapture.test.ts` (the spec's `artifactCapture.test.ts`; named for its source file per the repo convention)

**Interfaces:**
- Consumes: `MAX_TOOL_RESULT_CHARS` (Task 7), `createArtifact`, `buildPreviews`, `ARTIFACT_PREVIEW_BYTES` (Task 5), `BlobStorageUnavailableError`, `BlobRegion` (Task 4), `aiWorkspaceEnabled`, `breezeRegion` (Task 2), `AuthContext` (`../../middleware/auth`).
- Produces — **exactly the final shape from the reconciliation section, nothing else**:
  ```ts
  export interface CaptureScope { orgId: string; sessionId: string }
  export interface CaptureContext { orgId: string; runId: string | null; sessionId: string | null; region: BlobRegion; toolName: string }
  export function captureContextFrom(auth: AuthContext, opts: { capture?: CaptureScope } | undefined, toolName: string): CaptureContext | null;
  export async function captureLargeToolResult(raw: string, ctx: CaptureContext | null): Promise<string>;
  export const CAPTURE_MAX_BYTES = 64 * 1024 * 1024;
  ```
  Nothing else is exported. In particular there is no separate scope-builder helper and no run-resolution helper (generation 1, deleted — see the reconciliation section), and **no** `ToolExecutionContext` member is read here.

**Four decisions this task records.**

1. **No run lookup, no memo, no new index.** The run id is not discovered, it is already on the caller's identity: the agent run path builds `principal: { kind: 'ai_agent', agentId, runId }` and `orgId: run.orgId` (`services/aiAgents/agentAuthContext.ts:78, :89`). Earlier drafts queried `ai_agent_runs.session_id` behind a module-level memo and added a partial `ai_agent_runs_session_idx` to pay for it; that whole apparatus is **removed**. The capture path issues no queries of its own beyond `createArtifact`'s own insert.
2. **`runId` wins over `capture.sessionId`.** A run-anchored capture stores `session_id = NULL`, so an artifact has exactly one anchor and the run page's list is not double-counted through a session join.
3. **The org is never guessed** (R4). `capture.orgId ?? auth.orgId`, full stop — `auth.accessibleOrgIds` is not consulted even when it holds exactly one entry. No org ⇒ no capture ⇒ raw passthrough.
4. **Content type is detected, not fixed** (decision 4): `application/json` when the raw result parses as JSON, else `text/plain; charset=utf-8`. W03's staging step reads this to decide how to write the file; mislabelling stdout as JSON would break it. And **a blob failure is a typed tool error, never the raw result inline** (spec §9) — returning the raw string on failure would hand the model the exact 30 000-character payload the cap exists to keep out.

**One structural note.** `captureContextFrom`'s second parameter is typed **structurally** as `{ capture?: CaptureScope } | undefined`, not as `ExecuteToolOptions`. `ExecuteToolOptions` satisfies it, so the hook passes `opts` straight through, and this file never imports from `aiTools.ts` — which would be an import cycle, since `aiTools.ts` value-imports this file.

- [ ] **Step 1: Write the failing capture test**

```ts
// apps/api/src/services/artifacts/toolResultCapture.test.ts
/**
 * Execution-plane W01, spec §12 "artifactCapture.test.ts": raw bytes persisted,
 * previews raw, threshold boundary, opt-out honoured — plus §9's rule that a
 * blob failure NEVER returns the raw result inline.
 *
 * The capture path has NO database access of its own: `captureContextFrom` is
 * pure and `captureLargeToolResult` only calls `createArtifact`. There is
 * deliberately no db mock here — if one becomes necessary, a run lookup has
 * crept back in and the reconciliation section was violated.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  createArtifact: vi.fn(),
  aiWorkspaceEnabled: vi.fn(() => true),
  breezeRegion: vi.fn(() => 'us' as const),
}));

vi.mock('./artifactService', async (orig) => ({
  ...(await orig<Record<string, unknown>>()),
  createArtifact: mocks.createArtifact,
}));
vi.mock('../../config/env', () => ({
  aiWorkspaceEnabled: mocks.aiWorkspaceEnabled,
  breezeRegion: mocks.breezeRegion,
}));

import { MAX_TOOL_RESULT_CHARS } from '../aiToolOutput';
import { BlobStorageUnavailableError } from './blobStorage';
import {
  captureContextFrom,
  captureLargeToolResult,
  type CaptureContext,
} from './toolResultCapture';

const ORG = '00000000-0000-4000-8000-0000000000a1';
const OTHER_ORG = '00000000-0000-4000-8000-0000000000a2';
const RUN = '00000000-0000-4000-8000-0000000000a3';
const SESSION = '00000000-0000-4000-8000-0000000000a5';
const HANDLE = '00000000-0000-4000-8000-0000000000a4';

const ctx = (over: Partial<CaptureContext> = {}): CaptureContext => ({
  orgId: ORG, runId: RUN, sessionId: null, region: 'us', toolName: 'search_logs', ...over,
});

/** An org-scoped human login. */
const orgAuth = { principal: { kind: 'user_session' }, orgId: ORG, accessibleOrgIds: [ORG] } as never;
/** A partner-scope login: `auth.orgId` is null even though orgs are reachable. */
const partnerAuth = { principal: { kind: 'user_session' }, orgId: null, accessibleOrgIds: [ORG] } as never;
/** The agent run path: agentAuthContext.ts builds exactly this. */
const runAuth = {
  principal: { kind: 'ai_agent', agentId: 'ag1', runId: RUN },
  orgId: ORG, accessibleOrgIds: [ORG],
} as never;

beforeEach(() => {
  mocks.createArtifact.mockReset().mockResolvedValue({
    id: HANDLE, bytes: 30_000, contentType: 'application/json',
  });
  mocks.aiWorkspaceEnabled.mockReturnValue(true);
  mocks.breezeRegion.mockReturnValue('us');
});
afterEach(() => vi.clearAllMocks());

const big = (chars: number) => JSON.stringify({ rows: 'r'.repeat(chars) });

describe('captureContextFrom — run path attributes from the principal (reconciliation R4/R5)', () => {
  it('anchors on the run and takes the org from auth, with no call-site input at all', () => {
    expect(captureContextFrom(runAuth, undefined, 'search_logs'))
      .toEqual({ orgId: ORG, runId: RUN, sessionId: null, region: 'us', toolName: 'search_logs' });
  });

  it('keeps the RUN anchor and stores no session even when a chat scope is also supplied', () => {
    const resolved = captureContextFrom(runAuth, { capture: { orgId: OTHER_ORG, sessionId: SESSION } }, 't');
    expect(resolved).toMatchObject({ runId: RUN, sessionId: null });
  });
});

describe('captureContextFrom — chat path attributes from ExecuteToolOptions.capture', () => {
  it('anchors on the session, with the session org, when auth.orgId is null (partner-scope login)', () => {
    expect(captureContextFrom(partnerAuth, { capture: { orgId: ORG, sessionId: SESSION } }, 'get_event_logs'))
      .toEqual({ orgId: ORG, runId: null, sessionId: SESSION, region: 'us', toolName: 'get_event_logs' });
  });

  it("prefers the session's org over auth.orgId when the two disagree", () => {
    expect(captureContextFrom({ principal: { kind: 'user_session' }, orgId: OTHER_ORG } as never,
      { capture: { orgId: ORG, sessionId: SESSION } }, 't')?.orgId).toBe(ORG);
  });

  it('returns null for a partner-scope call with no capture scope — NEVER guesses from accessibleOrgIds', () => {
    expect(captureContextFrom(partnerAuth, undefined, 't')).toBeNull();
    // Even a single accessible org is a guess, and a guessed org on a
    // tenant-scoped row is a tenancy bug waiting for its second org (R4).
    expect(captureContextFrom({ principal: { kind: 'user_session' }, orgId: null, accessibleOrgIds: [ORG] } as never,
      undefined, 't')).toBeNull();
  });

  it('returns null when there is an org but no anchor — mcpServer / scriptBuilder / intentRelease pass through', () => {
    expect(captureContextFrom(orgAuth, undefined, 't')).toBeNull();
    expect(captureContextFrom(orgAuth, {}, 't')).toBeNull();
  });

  it('reads the region through breezeRegion()', () => {
    mocks.breezeRegion.mockReturnValue('eu' as never);
    expect(captureContextFrom(runAuth, undefined, 't')?.region).toBe('eu');
  });
});

describe('captureLargeToolResult — threshold boundary (spec §5.2)', () => {
  it('returns the raw string UNCHANGED at exactly MAX_TOOL_RESULT_CHARS', async () => {
    const raw = 'x'.repeat(MAX_TOOL_RESULT_CHARS);
    expect(await captureLargeToolResult(raw, ctx())).toBe(raw);
    expect(mocks.createArtifact).not.toHaveBeenCalled();
  });

  it('captures at MAX_TOOL_RESULT_CHARS + 1', async () => {
    const raw = 'x'.repeat(MAX_TOOL_RESULT_CHARS + 1);
    const out = await captureLargeToolResult(raw, ctx());
    expect(mocks.createArtifact).toHaveBeenCalledTimes(1);
    const parsed = JSON.parse(out) as { artifact: { handle: string }; compacted: string };
    expect(parsed.artifact.handle).toBe(HANDLE);
    expect(parsed.compacted).toBe(raw);
  });
});

describe('captureLargeToolResult — passthrough cases', () => {
  it('returns raw for a NULL context — the path both an unattributable call and a captureExempt tool take', async () => {
    // The hook in executeTool (Task 9) passes null for a captureExempt tool and
    // whatever captureContextFrom returned otherwise, so this one branch is the
    // whole passthrough surface.
    const raw = big(30_000);
    expect(await captureLargeToolResult(raw, null)).toBe(raw);
    expect(mocks.createArtifact).not.toHaveBeenCalled();
  });

  it("returns raw when the workspace flag is off — self-hosters see today's bytes exactly", async () => {
    mocks.aiWorkspaceEnabled.mockReturnValue(false);
    const raw = big(30_000);
    expect(await captureLargeToolResult(raw, ctx())).toBe(raw);
    expect(mocks.createArtifact).not.toHaveBeenCalled();
  });

  it('captures a session-anchored context (a plain chat with no run)', async () => {
    await captureLargeToolResult(big(30_000), ctx({ runId: null, sessionId: SESSION }));
    expect(mocks.createArtifact).toHaveBeenCalledTimes(1);
    expect((mocks.createArtifact.mock.calls[0]![0] as Record<string, unknown>).runId).toBeNull();
  });
});

describe('captureLargeToolResult — what is persisted (spec §5.2)', () => {
  it('persists the RAW bytes as kind input_capture with the calling tool recorded', async () => {
    const raw = big(30_000);
    await captureLargeToolResult(raw, ctx({ toolName: 'get_event_logs' }));
    const arg = mocks.createArtifact.mock.calls[0]![0] as Record<string, unknown>;
    expect(arg.kind).toBe('input_capture');
    expect(arg.createdByTool).toBe('get_event_logs');
    expect(arg.orgId).toBe(ORG);
    expect(arg.runId).toBe(RUN);
    expect(arg.sessionId).toBeNull();
    expect(arg.region).toBe('us');
    expect((arg.body as Buffer).toString('utf8')).toBe(raw);   // RAW, not compacted
  });

  it('labels JSON as application/json and non-JSON as text/plain', async () => {
    await captureLargeToolResult(big(30_000), ctx());
    expect((mocks.createArtifact.mock.calls[0]![0] as Record<string, unknown>).contentType).toBe('application/json');
    mocks.createArtifact.mockClear();
    await captureLargeToolResult('n'.repeat(30_000), ctx());
    expect((mocks.createArtifact.mock.calls[0]![0] as Record<string, unknown>).contentType).toBe('text/plain; charset=utf-8');
  });

  it('names the artifact after the tool, and the envelope carries raw head/tail previews', async () => {
    const raw = `HEAD${'m'.repeat(30_000)}TAIL`;
    const out = await captureLargeToolResult(raw, ctx({ toolName: 'search_logs' }));
    expect((mocks.createArtifact.mock.calls[0]![0] as Record<string, unknown>).name).toBe('search_logs.txt');
    const parsed = JSON.parse(out) as { artifact: { head: string; tail: string; bytes: number; contentType: string } };
    expect(parsed.artifact.head.startsWith('HEAD')).toBe(true);
    expect(parsed.artifact.tail.endsWith('TAIL')).toBe(true);
    expect(parsed.artifact.head.length).toBeLessThanOrEqual(2048);
  });
});

describe('captureLargeToolResult — failure (spec §9)', () => {
  it('returns a typed error and NEVER the raw result inline when the blob store is down', async () => {
    const raw = big(30_000);
    mocks.createArtifact.mockRejectedValue(new BlobStorageUnavailableError('bucket down'));
    const out = await captureLargeToolResult(raw, ctx());
    expect(JSON.parse(out)).toEqual({
      error: 'artifact_store_unavailable',
      message: expect.stringContaining('too large'),
    });
    expect(out).not.toContain('rrrrr');
    expect(out.length).toBeLessThan(500);
  });

  it('does the same for any other artifact failure — no fallback bypasses the cap', async () => {
    mocks.createArtifact.mockRejectedValue(new Error('insert boom'));
    const out = await captureLargeToolResult(big(30_000), ctx());
    expect((JSON.parse(out) as { error: string }).error).toBe('artifact_store_unavailable');
  });
});
```

- [ ] **Step 2: Run it to verify it fails**

Run: `cd apps/api && npx vitest run src/services/artifacts/toolResultCapture.test.ts`
Expected: FAIL — `Failed to resolve import "./toolResultCapture"`.

- [ ] **Step 3: Write `toolResultCapture.ts`**

```ts
// apps/api/src/services/artifacts/toolResultCapture.ts
import { aiWorkspaceEnabled, breezeRegion } from '../../config/env';
import type { AuthContext } from '../../middleware/auth';
import { MAX_TOOL_RESULT_CHARS } from '../aiToolOutput';
import { ARTIFACT_PREVIEW_BYTES, buildPreviews, createArtifact } from './artifactService';
import type { BlobRegion } from './blobStorage';

/**
 * Large tool-result capture (execution-plane spec §5.2, §9).
 *
 * Called from INSIDE `executeTool`, after the handler and before any compaction
 * (services/aiTools.ts). When the raw serialized result exceeds the same
 * `MAX_TOOL_RESULT_CHARS` the chat compaction uses, the raw bytes are persisted
 * as an `input_capture` artifact and the result becomes
 *
 *     { artifact: { handle, bytes, contentType, head, tail }, compacted: <raw> }
 *
 * which `compactToolResultForChat` then compacts in place (Task 7). The model
 * keeps exactly the view it has today PLUS a handle it can stage.
 *
 * PASSTHROUGH IS THE DEFAULT. With a null context — no org, no anchor, or a
 * `captureExempt` tool — with the flag off, or at or below the threshold, the
 * raw string is returned byte-identically. A self-hoster's tool results are
 * unchanged by this wave.
 *
 * NO DATABASE ACCESS OF ITS OWN. Attribution is already present at the call:
 * the agent run path carries it on the auth PRINCIPAL, and the chat path hands
 * in a `CaptureScope`. An earlier draft resolved the run from the session with
 * a memoized query behind a dedicated partial index; that is gone. If this file
 * ever needs `db` again, the contract has been broken.
 *
 * FAILURE IS NEVER A FALLBACK (§9). A blob or row failure yields
 * `{ error: 'artifact_store_unavailable' }`; returning the raw result inline
 * would hand the model the exact payload the context cap exists to keep out.
 */

/** Refuse to buffer more than this into one artifact. Far above any tool result. */
export const CAPTURE_MAX_BYTES = 64 * 1024 * 1024;

/**
 * What a CHAT caller supplies through `ExecuteToolOptions.capture` — the only
 * thing any call site ever constructs. Both fields come from the active session
 * (`ActiveSession.orgId` / `.breezeSessionId`), because `auth.orgId` is null for
 * a partner-scope login and a chat call has no run to anchor to.
 */
export interface CaptureScope {
  orgId: string;
  /** `ai_sessions.id` — what the artifact row's `session_id` FK points at. */
  sessionId: string;
}

export interface CaptureContext {
  orgId: string;
  /** The agent run this capture belongs to, or null for a plain chat capture. */
  runId: string | null;
  /** `ai_sessions.id`. Always null when `runId` is set — one anchor per artifact. */
  sessionId: string | null;
  region: BlobRegion;
  toolName: string;
}

/**
 * Derive the capture attribution for one `executeTool` invocation, or null for
 * "do not capture" (which is passthrough, never an error).
 *
 * TWO PATHS, ONE FUNCTION (reconciliation R4/R5):
 *
 *   - The AGENT RUN path needs no call-site change at all. Its auth context is
 *     built from the run row itself, so `auth.principal` already carries
 *     `runId` and `auth.orgId` already IS `run.orgId`
 *     (services/aiAgents/agentAuthContext.ts:78, :89).
 *   - The CHAT path supplies `opts.capture` from its active session, because
 *     `auth.orgId` is null for a partner-scope login and there is no run.
 *
 * THE ORG IS NEVER GUESSED. `auth.accessibleOrgIds` is deliberately NOT
 * consulted: picking the single entry of a one-org array is a guess, and a
 * guessed org on a tenant-scoped row is a tenancy bug waiting for its second
 * org. No org means no capture.
 *
 * ONE ANCHOR. `runId` wins; a run-anchored artifact stores no session, so the
 * run page's list cannot double-count through a session join.
 *
 * The options parameter is typed STRUCTURALLY rather than as
 * `ExecuteToolOptions`: `aiTools.ts` value-imports this module, so importing
 * its type back would be a cycle. `ExecuteToolOptions` satisfies this shape.
 */
export function captureContextFrom(
  auth: AuthContext,
  opts: { capture?: CaptureScope } | undefined,
  toolName: string,
): CaptureContext | null {
  const orgId = opts?.capture?.orgId ?? auth.orgId ?? null;
  const runId = auth.principal.kind === 'ai_agent' ? auth.principal.runId : null;
  const sessionId = runId ? null : (opts?.capture?.sessionId ?? null);
  if (!orgId) return null;
  if (!runId && !sessionId) return null;
  return { orgId, runId, sessionId, region: breezeRegion(), toolName };
}

function looksLikeJson(raw: string): boolean {
  const trimmed = raw.trimStart();
  if (!trimmed.startsWith('{') && !trimmed.startsWith('[')) return false;
  try {
    JSON.parse(raw);
    return true;
  } catch {
    return false;
  }
}

export async function captureLargeToolResult(
  raw: string,
  ctx: CaptureContext | null,
): Promise<string> {
  if (ctx === null) return raw;
  if (raw.length <= MAX_TOOL_RESULT_CHARS) return raw;
  if (!aiWorkspaceEnabled()) return raw;

  const isJson = looksLikeJson(raw);
  const contentType = isJson ? 'application/json' : 'text/plain; charset=utf-8';
  const body = Buffer.from(raw, 'utf8');
  if (body.length > CAPTURE_MAX_BYTES) {
    return JSON.stringify({
      error: 'artifact_store_unavailable',
      message: `This tool result is too large to store (${body.length} bytes). Narrow the query and try again.`,
    });
  }

  try {
    const record = await createArtifact({
      orgId: ctx.orgId,
      runId: ctx.runId,
      sessionId: ctx.sessionId,
      kind: 'input_capture',
      name: `${ctx.toolName}.${isJson ? 'json' : 'txt'}`,
      contentType,
      body,
      maxBytes: CAPTURE_MAX_BYTES,
      createdByTool: ctx.toolName,
      region: ctx.region,
    });
    const { headPreview, tailPreview } = buildPreviews(body);
    return JSON.stringify({
      artifact: {
        handle: record.id,
        bytes: record.bytes,
        contentType: record.contentType,
        head: headPreview.slice(0, ARTIFACT_PREVIEW_BYTES),
        tail: tailPreview.slice(-ARTIFACT_PREVIEW_BYTES),
      },
      compacted: raw,
    });
  } catch (err) {
    // §9: typed tool error, raw result NOT returned inline. The message tells
    // the model what to do differently — it cannot retry its way out of this.
    console.error('[artifacts] capture failed; returning artifact_store_unavailable', err);
    return JSON.stringify({
      error: 'artifact_store_unavailable',
      message: 'This tool result was too large for the conversation and could not be stored. Narrow the query (fewer devices, a shorter time range, or a filter) and try again.',
    });
  }
}
```

- [ ] **Step 4: Run the capture test**

```bash
cd apps/api && npx vitest run src/services/artifacts/toolResultCapture.test.ts
```
Expected: PASS (19 tests). No migration or Drizzle-schema change belongs to this task — if you find yourself adding an `ai_agent_runs(session_id)` index, a run lookup has crept back in; re-read the reconciliation section.

- [ ] **Step 5: Typecheck and commit**

```bash
cd apps/api && NODE_OPTIONS=--max-old-space-size=8192 npx tsc --noEmit -p tsconfig.json
git add apps/api/src/services/artifacts/toolResultCapture.ts \
  apps/api/src/services/artifacts/toolResultCapture.test.ts
git commit -m "feat(ai): capture oversized tool results as input_capture artifacts

Spec §5.2/§9. Fires on the same MAX_TOOL_RESULT_CHARS the chat compaction uses,
persists the RAW bytes, and returns { artifact, compacted } so the model keeps its
current view plus a stageable handle. The agent run path attributes from the auth
principal (agentAuthContext already carries runId and run.orgId); the chat path hands
in a CaptureScope from its active session. The org is never guessed from
accessibleOrgIds, and the capture path makes no database read of its own. A null
context (no org, no anchor, or a captureExempt tool), the flag off, or a result at or
below the threshold all pass the raw string through byte-identically. A store failure
returns artifact_store_unavailable and never the raw result inline.

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_01MwUHaGwobGHrTgu8TcCWqr"
```

---

### Task 9: `ExecuteToolOptions.capture`, `AiTool.captureExempt`, the hook inside `executeTool`, and the ONE call site that supplies a scope

**Files:**
- Modify: `apps/api/src/services/aiTools.ts:97-134` (`AiTool.captureExempt`), `:480-491` (`ExecuteToolOptions.capture`), `:548-554` (the hook on the two handler returns)
- Create: `apps/api/src/services/aiTools.capture.test.ts`
- Modify: `apps/api/src/services/aiAgentSdkTools.ts:434-442` (`makeHandler` → `makeToolHandler(…, getActiveSession)` + local alias), `:518-531` (supply the scope)
- **NOT modified:** `apps/api/src/services/toolExecutionContext.ts` (see below), `apps/api/src/routes/mcpServer.ts`, `apps/api/src/services/scriptBuilderTools.ts`, `apps/api/src/jobs/intentReleaseWorker.ts` (see step 7).

**Interfaces:**
- Consumes: `captureContextFrom`, `captureLargeToolResult`, `CaptureScope` (Task 8). Those three are the whole surface — the generation-1 scope-builder and run-resolution helpers do not exist.
- Produces:
  ```ts
  // AiTool gains, as its LAST optional field:
  captureExempt?: boolean;          // default false — structured tools stay inline (spec §5.2)

  // ExecuteToolOptions gains exactly one member:
  capture?: CaptureScope;           // chat-path attribution; the run path needs none
  ```
  `executeTool`'s **signature is unchanged** — `capture` rides in the options bag it already accepts.

**Where exactly the hook goes and why.** `executeTool` (lines 493-555) is the single dispatch point every core and extension handler result passes through, and it does NOT import `aiToolOutput.ts` — compaction happens at the four callers, immediately after the `await`. So the hook sits on the two `return` statements at lines 553-554, which is "after the handler, before any compaction" exactly as the spec requires. The early returns above it (lines 529, 539, 546) are the tool's own error envelopes — short by construction, never captured, and a capture there would be nonsense.

**Why a named `capture` member on `ExecuteToolOptions`, and NOT `ToolExecutionContext` or `AuthContext`.** `toolExecutionContext.ts:39-65` documents `ToolExecutionContext` as deliberately narrow — verified release material — and argues explicitly against letting caller-identity-ish fields ride along; an `orgId` member there is precisely what it argues against, and the W04 reviewer flagged an earlier draft of this plan for proposing one. The same file's argument rules out `AuthContext` even more strongly: it is a caller IDENTITY read by every tenancy gate, and a per-invocation execution input must not extend it. `ExecuteToolOptions` is already documented (lines 472-479) as the NAMED BAG for exactly this class of unrelated per-invocation member. **`ToolExecutionContext` is not modified by this wave.** `capture` is optional everywhere, so a caller that omits it gets today's behaviour with no branch taken.

**The run path needs no call-site change at all.** `services/aiAgents/agentAuthContext.ts` builds the run's auth context from the run row: `principal: { kind: 'ai_agent', agentId, runId }` (line 78) and `orgId: run.orgId` (line 89). `captureContextFrom` reads both, so every agent-run tool call is attributed without anyone passing anything.

**The `makeHandler` gap.** `makeSessionAwareHandler` (line 632) takes `getActiveSession`; its sibling `makeHandler` (line 434) — the MAIN chat path and the only one of the two that actually calls `executeTool` — does not. Without the session it has no org it can trust (`auth.orgId` is null for a partner-scope login) and no `ai_sessions.id` to anchor on, so the hook would be permanently inert on the path that matters most. Capture cannot instead move to `createSessionPostToolUse` (`aiAgentSdk.ts:1944`): the `output` string has ALREADY been compacted once by the time it arrives there, so the oversized original is gone. And note `makeSessionAwareHandler` itself needs no change — **verified**: it dispatches to `sessionHandler`, not to `executeTool`, so it has no options bag to extend.

- [ ] **Step 1: Write the failing hook test**

```ts
// apps/api/src/services/aiTools.capture.test.ts
/**
 * Execution-plane W01 (spec §5.2, §12). The hook sits inside executeTool, after
 * the handler and BEFORE any compaction. It is inert unless the call is
 * attributable — an ai_agent principal (run path) or an ExecuteToolOptions
 * `capture` scope (chat path). `captureExempt` opts a structured tool out by
 * taking the same null-context path.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  capture: vi.fn(async (raw: string) => raw),
}));

vi.mock('./artifacts/toolResultCapture', async (orig) => ({
  ...(await orig<Record<string, unknown>>()),
  captureLargeToolResult: mocks.capture,
}));

import { aiTools, executeTool, type AiTool } from './aiTools';

const ORG = '00000000-0000-4000-8000-0000000000a1';
const RUN = '00000000-0000-4000-8000-0000000000a3';
const SESSION = '00000000-0000-4000-8000-0000000000a5';

const auth = {
  principal: { kind: 'user_session' },
  user: { id: 'u1', email: 'u@example.com', name: 'U', isPlatformAdmin: false },
  token: null, partnerId: null, orgId: ORG, scope: 'organization',
  accessibleOrgIds: [ORG], orgCondition: () => undefined, canAccessOrg: () => true,
} as never;

/** What services/aiAgents/agentAuthContext.ts builds for an agent run. */
const runAuth = { ...(auth as object), principal: { kind: 'ai_agent', agentId: 'ag1', runId: RUN } } as never;

const BIG = JSON.stringify({ rows: 'r'.repeat(30_000) });

function register(name: string, result: string, extra: Partial<AiTool> = {}): () => void {
  const tool = {
    definition: { name, description: 'test', input_schema: { type: 'object', properties: {} } },
    tier: 1 as const,
    handler: async () => result,
    ...extra,
  } as AiTool;
  aiTools.set(name, tool);
  return () => aiTools.delete(name);
}

let cleanup: Array<() => void> = [];
beforeEach(() => { mocks.capture.mockClear(); });
afterEach(() => { cleanup.forEach((fn) => fn()); cleanup = []; });

describe('executeTool capture hook', () => {
  it('is INERT for an ordinary chat call with no scope — result is byte-identical', async () => {
    cleanup.push(register('cap_plain', BIG));
    expect(await executeTool('cap_plain', {}, auth)).toBe(BIG);
    expect(mocks.capture).toHaveBeenCalledWith(BIG, null);
  });

  it('routes the RAW handler result through capture for an agent RUN, with no caller input', async () => {
    cleanup.push(register('cap_run', BIG));
    mocks.capture.mockResolvedValueOnce('{"artifact":{"handle":"h"},"compacted":"x"}');
    const out = await executeTool('cap_run', {}, runAuth);
    expect(mocks.capture).toHaveBeenCalledTimes(1);
    expect(mocks.capture.mock.calls[0]![0]).toBe(BIG);              // RAW, uncompacted
    expect(mocks.capture.mock.calls[0]![1]).toMatchObject({ orgId: ORG, runId: RUN, sessionId: null });
    expect(out).toBe('{"artifact":{"handle":"h"},"compacted":"x"}');
  });

  it('routes a CHAT call through when a capture scope is supplied', async () => {
    cleanup.push(register('cap_chat', BIG));
    await executeTool('cap_chat', {}, auth, { capture: { orgId: ORG, sessionId: SESSION } });
    expect(mocks.capture.mock.calls[0]![1]).toMatchObject({ orgId: ORG, runId: null, sessionId: SESSION });
  });

  it('honours captureExempt — a structured tool takes the null-context path and stays inline', async () => {
    cleanup.push(register('cap_exempt', BIG, { captureExempt: true }));
    const out = await executeTool('cap_exempt', {}, auth, { capture: { orgId: ORG, sessionId: SESSION } });
    expect(out).toBe(BIG);
    expect(mocks.capture).toHaveBeenCalledWith(BIG, null);
  });

  it('does not capture the tool-error envelopes executeTool returns before the handler', async () => {
    cleanup.push(register('cap_gated', BIG, { deviceArgs: ['deviceId'] }));
    const out = await executeTool('cap_gated', { deviceId: 'not-a-uuid' }, auth, {
      capture: { orgId: ORG, sessionId: SESSION },
    });
    expect(JSON.parse(out)).toHaveProperty('error');
    expect(mocks.capture).not.toHaveBeenCalled();
  });

  it('never lets a capture fault fail the tool call — the raw result still returns', async () => {
    cleanup.push(register('cap_boom', BIG));
    mocks.capture.mockRejectedValueOnce(new Error('unexpected'));
    expect(await executeTool('cap_boom', {}, auth, { capture: { orgId: ORG, sessionId: SESSION } })).toBe(BIG);
  });
});

describe('the three non-chat call sites are passthrough by design in W01 (reconciliation R2)', () => {
  // Each case builds the EXACT options bag its call site builds today: none of
  // them supplies `capture`. If a later wave starts attributing one of these,
  // this suite goes red and the change becomes a decision rather than an accident.
  it('routes/mcpServer.ts passes no options at all', async () => {
    cleanup.push(register('cap_mcp', BIG));
    expect(await executeTool('cap_mcp', {}, auth)).toBe(BIG);
    expect(mocks.capture).toHaveBeenCalledWith(BIG, null);
  });

  it('services/scriptBuilderTools.ts passes only verified release material', async () => {
    cleanup.push(register('cap_sb', BIG));
    const context = { verifiedRunScript: undefined } as never;
    expect(await executeTool('cap_sb', {}, auth, { context })).toBe(BIG);
    expect(mocks.capture).toHaveBeenCalledWith(BIG, null);
  });

  it('jobs/intentReleaseWorker.ts passes an actionIntentId and no capture scope', async () => {
    cleanup.push(register('cap_intent', BIG));
    expect(await executeTool('cap_intent', {}, auth, { context: { actionIntentId: 'i1' } })).toBe(BIG);
    expect(mocks.capture).toHaveBeenCalledWith(BIG, null);
  });
});
```

If `aiTools` (the Map) is not exported from `aiTools.ts`, register through whatever the file's existing tests use (`grep -n "aiTools\.set\|registerTestTool" apps/api/src/services/aiTools*.test.ts`) rather than adding a new export just for the test.

- [ ] **Step 2: Run it to verify it fails**

Run: `cd apps/api && npx vitest run src/services/aiTools.capture.test.ts`
Expected: FAIL — `capture` is not a known member of `ExecuteToolOptions` (compile error), and `captureExempt` is not on `AiTool`.

- [ ] **Step 3: Add `captureExempt` to `AiTool`**

`apps/api/src/services/aiTools.ts`, after `deviceArgs?: readonly string[];` (line 133):

```ts
  /**
   * Opt this tool OUT of large-result artifact capture (execution-plane spec
   * §5.2). Default false: an oversized result is persisted and replaced with
   * `{ artifact, compacted }`. Set it only for a tool whose value IS its
   * structure — the workspace tools (W03) and `export_dataset` (W04), which
   * already return a handle and would otherwise be captured recursively.
   * A tool that returns bulk DATA must never set this: that is the case the
   * capture exists for.
   */
  captureExempt?: boolean;
```

- [ ] **Step 4: Add `capture` to `ExecuteToolOptions` and write the hook**

In the same file, inside `ExecuteToolOptions` (after `context?: ToolExecutionContext;`, line 490):

```ts
  /**
   * Where an oversized result should be attributed if it has to be captured
   * (execution-plane spec §5.2). Supplied by the CHAT path only, from its
   * active session: `auth.orgId` is null for a partner-scope login, and a chat
   * call has no run to anchor to. The AGENT RUN path supplies nothing — its
   * auth context is built from the run row and already carries both the org and
   * the run id (services/aiAgents/agentAuthContext.ts).
   *
   * OPTIONAL AND ABSENT BY DEFAULT: a caller that omits it gets today's
   * behaviour with no branch taken. It rides here rather than on
   * `ToolExecutionContext` (documented as deliberately narrow, verified-release
   * material) or on `AuthContext` (a caller identity read by every tenancy
   * gate) — this bag is what toolExecutionContext.ts's own argument points at
   * for unrelated per-invocation inputs.
   */
  capture?: CaptureScope;
```

Add the imports beside the other service imports at the top of `aiTools.ts`:

```ts
import type { CaptureScope } from './artifacts/toolResultCapture';
import { captureContextFrom, captureLargeToolResult } from './artifacts/toolResultCapture';
```

Then replace the two final returns (lines 548-554) with:

```ts
  // Only CORE handlers receive the execution context. Extension handlers are
  // third-party code and are called with exactly two arguments — not merely
  // typed without a third one, since a handler written `(input, auth, ...rest)`
  // or reading `arguments` would otherwise capture pre-verified release
  // material the host never intended to hand out.
  const rawResult = coreTool
    ? await coreTool.handler(effectiveInput, auth, opts?.context)
    : await (tool as RegistryAiTool).handler(effectiveInput, auth);

  // Large-result capture (execution-plane spec §5.2). HERE, after the handler
  // and BEFORE any compaction — the four callers all compact immediately after
  // this await, and by then the oversized bytes are gone. Deliberately NOT
  // applied to the tool-error envelopes returned above: they are short by
  // construction and an artifact of an error string is nonsense.
  //
  // A captureExempt tool and an unattributable call take the SAME null-context
  // path, so there is exactly one passthrough branch. `captureLargeToolResult`
  // returns the raw string unchanged for a null context, below the threshold,
  // and with the workspace flag off, and turns a STORE failure into a typed
  // tool error (§9) rather than the raw result inline. This catch is only for
  // the genuinely unexpected: capture is an enhancement, never a reason a tool
  // call fails.
  const captureCtx = tool.captureExempt ? null : captureContextFrom(auth, opts, toolName);
  try {
    return await captureLargeToolResult(rawResult, captureCtx);
  } catch (err) {
    console.error(`[aiTools] artifact capture failed for ${toolName}; returning the raw result`, err);
    return rawResult;
  }
}
```

Note `tool.captureExempt` reads from the resolved tool (core OR extension) — an extension-contributed tool can set it too, and `RegistryAiTool` already structurally allows an extra optional boolean. If it does not, gate on `coreTool?.captureExempt` instead and say so in the PR.

- [ ] **Step 5: Run the hook test and the whole aiTools suite**

```bash
cd apps/api && npx vitest run src/services/aiTools.capture.test.ts src/services/aiTools.test.ts
```
Expected: both PASS. `aiTools.test.ts` must be green WITHOUT edits — that is the proof the hook is inert for every existing caller.

- [ ] **Step 6: Give `makeHandler` a session and supply the scope (the ONE call site that changes)**

`apps/api/src/services/aiAgentSdkTools.ts` — change the signature at line 434 to mirror its sibling at 632, renaming it so a local alias can keep the ~90 declaration sites unchanged:

```ts
function makeToolHandler(
  toolName: string,
  getAuth: () => AuthContext,
  getActiveSession: (() => ActiveSession | undefined) | undefined,
  onPreToolUse?: PreToolUseCallback,
  onPostToolUse?: PostToolUseCallback,
) {
```

and at the top of `createBreezeMcpServer`, where `makeHandler` is currently referenced by every `tool()` declaration, add the alias:

```ts
  // One alias so the tool() declarations below keep their four-argument shape
  // while the underlying handler also receives the session. W01 capture needs
  // the session's org (auth.orgId is null for a partner-scope login) and its
  // ai_sessions id. getActiveSession is undefined for the headless/agent
  // server, where the ai_agent principal already carries the run and org.
  const makeHandler = (
    toolName: string,
    auth: () => AuthContext,
    pre?: PreToolUseCallback,
    post?: PostToolUseCallback,
  ) => makeToolHandler(toolName, auth, getActiveSession, pre, post);
```

(`getActiveSession` is already a parameter of `createBreezeMcpServer` — it is what `makeSessionAwareHandler` is given at line 635. Confirm with `grep -n 'getActiveSession' apps/api/src/services/aiAgentSdkTools.ts` before editing.)

Then at the call site (lines 518-531):

```ts
      const dbContext: DbAccessContext = dbAccessContextFromAuth(auth);
      // W01: attribute an oversized result to this session's org and session.
      // `session.orgId` is the canonical org — `auth.orgId` is null for a
      // partner-scope login (aiAgentSdk.ts:1947-1948) — and
      // `session.breezeSessionId` IS the ai_sessions.id the artifact row's
      // session_id FK points at.
      const session = getActiveSession?.();
      const capture: CaptureScope | undefined = session
        ? { orgId: session.orgId, sessionId: session.breezeSessionId }
        : undefined;
      const result = await withToolTimeout(
        withDbAccessContext(dbContext, () =>
          executeTool(toolName, args, auth, {
            ...(verifiedContext ? { context: verifiedContext } : {}),
            ...(capture ? { capture } : {}),
          }),
        ),
        toolTimeout,
        toolName,
      );
```

This replaces the `verifiedContext ? … : …` ternary at 524-526. The comment at 521-523 explained that a bag carrying `context: undefined` would be a behaviour change for every ordinary chat tool call — the spread form preserves that property for both members: an absent scope means no `capture` key at all, and an absent verified context means no `context` key at all.

Add the import: `import type { CaptureScope } from './artifacts/toolResultCapture';`

- [ ] **Step 7: Confirm the other three call sites are genuinely untouched**

`routes/mcpServer.ts`, `services/scriptBuilderTools.ts` and `jobs/intentReleaseWorker.ts` supply no `capture` in W01 and therefore pass through (R2). This is a decision, not an oversight — attributing them is later-wave work — and step 1's second `describe` block pins it. Verify nothing crept in:

```bash
cd apps/api && grep -n 'capture:\|CaptureScope\|captureContextFrom\|captureLargeToolResult' \
  src/routes/mcpServer.ts src/services/scriptBuilderTools.ts src/jobs/intentReleaseWorker.ts \
  || echo 'OK: the three non-chat call sites are unchanged'
```
Expected: the `echo` fires. Record in the PR body that MCP-server, script-builder and intent-release tool results are not captured in W01.

- [ ] **Step 8: Run every touched call site's suite**

```bash
cd apps/api && npx vitest run \
  src/services/aiAgentSdkTools \
  src/services/scriptBuilderTools \
  src/routes/mcpServer \
  src/jobs/intentReleaseWorker \
  src/services/aiAgentSdkTools.handlerCoverage.contract.test.ts \
  src/services/aiAgentSdkTools.registryParity.contract.test.ts \
  src/services/aiAgentSdkTools.mcpCoverage.test.ts
```
Expected: all PASS. The `makeToolHandler` rename plus the `makeHandler` alias must leave `mcpCoverage` and `handlerCoverage` green — both extract `makeHandler('<name>'` from the SOURCE, and the alias keeps that literal shape at every declaration. **If `handlerCoverage`'s extractor now finds 0 declarations it throws by design (Task 1, step 1) — that is the guard working; fix the alias, not the regex.**

- [ ] **Step 9: Typecheck and commit**

```bash
cd apps/api && NODE_OPTIONS=--max-old-space-size=8192 npx tsc --noEmit -p tsconfig.json
git add apps/api/src/services/aiTools.ts apps/api/src/services/aiTools.capture.test.ts \
  apps/api/src/services/aiAgentSdkTools.ts
git commit -m "feat(ai): hook large-result capture into executeTool, before any compaction

Spec §5.2. ExecuteToolOptions.capture carries the chat path's per-invocation
attribution — never AuthContext (a caller identity) and never ToolExecutionContext
(documented as deliberately narrow, verified-release material). The agent run path
supplies nothing: its auth context is built from the run row and already carries the
run id and org. AiTool.captureExempt opts a structured tool out by taking the same
null-context path an unattributable call takes, so there is one passthrough branch.
The hook sits on executeTool's handler return, so all four callers are covered by one
edit, and it fails open. makeHandler now receives the session its sibling
makeSessionAwareHandler already had; the MCP-server, script-builder and intent-release
paths stay passthrough in W01 and a test pins that.

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_01MwUHaGwobGHrTgu8TcCWqr"
```

---

### Task 10: Routes — `GET /ai/artifacts/:id` (attachment download) and `GET /ai/agents/runs/:runId/artifacts` (inside `aiAgentsRoutes`)

**Files:**
- Create: `apps/api/src/routes/aiArtifacts.ts`, `apps/api/src/routes/aiArtifacts.test.ts`
- Modify: `apps/api/src/routes/aiAgents.ts` — add `aiAgentsRoutes.get('/runs/:runId/artifacts', …)` **immediately before** the existing `aiAgentsRoutes.get('/runs/:runId', …)` at line 1198
- Modify: `apps/api/src/routes/aiAgents.test.ts` — route-precedence test
- Modify: `apps/api/src/index.ts:~142` (import) and the mount block at `:979-987` — **one** new mount, `/ai/artifacts`, immediately before `api.route('/ai', aiRoutes)`

**Interfaces:**
- Consumes: `findArtifactForAuth`, `listArtifactsForAuth`, `openArtifactStream`, `toArtifactDto` (Task 5); `BlobNotFoundError`, `BlobStorageUnavailableError` (Task 4); `authMiddleware`, `requirePermission`, `requireScope` (`../middleware/auth`); `PERMISSIONS.AI_AGENTS_READ` (`../services/permissions`); `safeContentDispositionFilename` (`../utils/httpHeaders`); `captureException` (`../services/sentry`).
- Produces:
  ```ts
  // apps/api/src/routes/aiArtifacts.ts
  export const aiArtifactRoutes: Hono;                                  // mounted at /ai/artifacts -> GET /:id
  export function artifactDownloadContentType(stored: string): string;  // fixed safe map
  // apps/api/src/routes/aiAgents.ts — no new export; the list route joins the existing router.
  ```
  There is deliberately **no** `aiRunArtifactRoutes` export and **no** second mount.

**Why the list route lives inside `aiAgentsRoutes` (reconciliation R6).** `index.ts:979-982` already mounts `aiAgentsRoutes` at `/ai/agents`, and that router owns `GET /runs/:runId` (`routes/aiAgents.ts:1198`) as well as the `/:id` pattern behind the #4189 capture bug. Mounting a **second** Hono app at the same `/ai/agents` prefix would put two independent routers in a precedence relationship that is decided by mount order in a third file, invisible from either router — exactly the failure mode #4189 was. It would also give the run-artifact list a different RBAC declaration site from the run detail it belongs to, free to drift. Registering the route in the SAME router, one line above `get('/runs/:runId', …)`, makes the precedence local, greppable and testable in the file that owns both paths, and it reuses that file's already-declared `scopes` / `requireAiRead` / `uuidParam` verbatim.

Hono matches in registration order, and `/runs/:runId` would otherwise match `/runs/<id>/artifacts` only if the param pattern were greedy — it is not — so this ordering is belt-and-braces rather than strictly required. It is still mandatory here: it costs nothing, it is the convention the `/ai/agents/schedules` mount comment already records, and step 5's test pins it so a future reorder cannot quietly break it.

**RBAC — identical to the AI run detail route** (`routes/aiAgents.ts:99-101, 1198`): `requireScope('organization','partner','system')` + `requirePermission(PERMISSIONS.AI_AGENTS_READ…)`, org scoping by `auth.orgCondition(...)` AND-ed into the WHERE, and a **bare 404 on every miss** for the download — a wrong-org artifact must be indistinguishable from a non-existent one (spec §5.2: handles are opaque). There is no 403 branch in either handler; the only 403s come from the two middlewares.

**Rendering (spec §8):** always `Content-Disposition: attachment`, always `X-Content-Type-Options: nosniff`, and the content type comes from a FIXED SAFE MAP, never from the stored string. This differs deliberately from `contentDispositionFor` in `routes/tickets/attachments.ts:262`, which serves `inline` for images: an artifact is model- or sandbox-produced content and **no artifact is ever rendered inline**, image or not. A stored type outside the map becomes `application/octet-stream`.

- [ ] **Step 1: Write the failing download-route test**

```ts
// apps/api/src/routes/aiArtifacts.test.ts
/**
 * Execution-plane W01 (spec §8, §12). Proves: attachment + nosniff on every
 * response, a fixed safe content-type map (an HTML artifact is NEVER served as
 * text/html), a bare 404 for another org's handle (not 403), 503 — never a
 * silent 404 — for a storage fault, and 404 for a genuinely missing object.
 *
 * The per-run LIST route is not here: it lives in routes/aiAgents.ts, beside
 * the run detail it shares a prefix with, and is tested in aiAgents.test.ts
 * where its route precedence can actually be observed.
 */
import { Hono } from 'hono';
import { Readable } from 'node:stream';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  find: vi.fn(),
  open: vi.fn(),
  captureException: vi.fn(),
}));

vi.mock('../services/artifacts/artifactService', async (orig) => ({
  ...(await orig<Record<string, unknown>>()),
  findArtifactForAuth: mocks.find,
  openArtifactStream: mocks.open,
}));
vi.mock('../middleware/auth', () => ({
  authMiddleware: async (c: { set: (k: string, v: unknown) => void }, next: () => Promise<void>) => {
    c.set('auth', { orgId: ORG, scope: 'organization', accessibleOrgIds: [ORG], orgCondition: () => undefined });
    await next();
  },
  requirePermission: () => async (_c: unknown, next: () => Promise<void>) => next(),
  requireScope: () => async (_c: unknown, next: () => Promise<void>) => next(),
}));
vi.mock('../services/sentry', () => ({ captureException: mocks.captureException }));

const ORG = '00000000-0000-4000-8000-0000000000a1';
const ART = '00000000-0000-4000-8000-0000000000a4';
const RUN = '00000000-0000-4000-8000-0000000000a3';

import { BlobNotFoundError, BlobStorageUnavailableError } from '../services/artifacts/blobStorage';
import { aiArtifactRoutes, artifactDownloadContentType } from './aiArtifacts';

function app() {
  const a = new Hono();
  a.route('/api/v1/ai/artifacts', aiArtifactRoutes);
  return a;
}

function record(over: Record<string, unknown> = {}) {
  return {
    id: ART, orgId: ORG, runId: RUN, sessionId: null, kind: 'input_capture',
    name: 'search_logs.json', contentType: 'application/json', bytes: 7, sha256: 'a'.repeat(64),
    blobKey: 'us/2026/10/k1', headPreview: '{"a":1}', tailPreview: '{"a":1}',
    sourceDeviceId: null, createdByTool: 'search_logs',
    expiresAt: new Date('2026-11-15T00:00:00Z'), createdAt: new Date('2026-10-16T00:00:00Z'),
    ...over,
  };
}

beforeEach(() => { mocks.find.mockReset(); mocks.open.mockReset(); });

describe('artifactDownloadContentType — fixed safe map (spec §8)', () => {
  it('passes the handful of safe types through', () => {
    expect(artifactDownloadContentType('application/json')).toBe('application/json');
    expect(artifactDownloadContentType('text/plain; charset=utf-8')).toBe('text/plain; charset=utf-8');
    expect(artifactDownloadContentType('text/csv')).toBe('text/csv');
  });

  it('NEVER echoes an active type — html, svg and js all become octet-stream', () => {
    for (const t of ['text/html', 'image/svg+xml', 'application/javascript', 'application/xhtml+xml']) {
      expect(artifactDownloadContentType(t)).toBe('application/octet-stream');
    }
  });

  it('falls back to octet-stream for anything unknown or malformed', () => {
    expect(artifactDownloadContentType('application/x-made-up')).toBe('application/octet-stream');
    expect(artifactDownloadContentType('')).toBe('application/octet-stream');
  });
});

describe('GET /api/v1/ai/artifacts/:id', () => {
  it('streams with attachment + nosniff and the mapped content type', async () => {
    mocks.find.mockResolvedValue(record());
    mocks.open.mockResolvedValue(Readable.from([Buffer.from('{"a":1}')]));
    const res = await app().request(`/api/v1/ai/artifacts/${ART}`);
    expect(res.status).toBe(200);
    expect(res.headers.get('Content-Disposition')).toContain('attachment;');
    expect(res.headers.get('Content-Disposition')).toContain('search_logs.json');
    expect(res.headers.get('X-Content-Type-Options')).toBe('nosniff');
    expect(res.headers.get('Content-Type')).toBe('application/json');
    expect(await res.text()).toBe('{"a":1}');
  });

  it('serves an HTML artifact as an octet-stream ATTACHMENT, never inline', async () => {
    mocks.find.mockResolvedValue(record({ contentType: 'text/html', name: 'report.html' }));
    mocks.open.mockResolvedValue(Readable.from([Buffer.from('<script>x</script>')]));
    const res = await app().request(`/api/v1/ai/artifacts/${ART}`);
    expect(res.headers.get('Content-Type')).toBe('application/octet-stream');
    expect(res.headers.get('Content-Disposition')?.startsWith('attachment;')).toBe(true);
  });

  it("404s — not 403 — for another org's handle, so a handle discloses nothing", async () => {
    mocks.find.mockResolvedValue(null);      // the org predicate excluded it
    const res = await app().request(`/api/v1/ai/artifacts/${ART}`);
    expect(res.status).toBe(404);
    expect(await res.json()).toEqual({ error: 'Artifact not found', code: 'ARTIFACT_NOT_FOUND' });
  });

  it('404s for a non-uuid without querying', async () => {
    const res = await app().request('/api/v1/ai/artifacts/not-a-uuid');
    expect(res.status).toBe(404);
    expect(mocks.find).not.toHaveBeenCalled();
  });

  it('503s — never a silent 404 — when the blob store is unavailable', async () => {
    mocks.find.mockResolvedValue(record());
    mocks.open.mockRejectedValue(new BlobStorageUnavailableError('bucket down'));
    const res = await app().request(`/api/v1/ai/artifacts/${ART}`);
    expect(res.status).toBe(503);
    expect((await res.json() as { code: string }).code).toBe('ARTIFACT_STORAGE_UNAVAILABLE');
    expect(mocks.captureException).toHaveBeenCalled();
  });

  it('404s when the object is genuinely gone (swept between row read and open)', async () => {
    mocks.find.mockResolvedValue(record());
    mocks.open.mockRejectedValue(new BlobNotFoundError('us/2026/10/k1'));
    expect((await app().request(`/api/v1/ai/artifacts/${ART}`)).status).toBe(404);
  });

  it('sanitises the filename so a stored name cannot inject a header', async () => {
    mocks.find.mockResolvedValue(record({ name: 'a"b\r\nX-Evil: 1' }));
    mocks.open.mockResolvedValue(Readable.from([Buffer.from('x')]));
    const res = await app().request(`/api/v1/ai/artifacts/${ART}`);
    expect(res.headers.get('X-Evil')).toBeNull();
    expect(res.headers.get('Content-Disposition')).not.toContain('\n');
  });
});
```

- [ ] **Step 2: Run it to verify it fails**

Run: `cd apps/api && npx vitest run src/routes/aiArtifacts.test.ts`
Expected: FAIL — `Failed to resolve import "./aiArtifacts"`.

- [ ] **Step 3: Write `aiArtifacts.ts` (download only)**

```ts
// apps/api/src/routes/aiArtifacts.ts
import { Hono } from 'hono';
import { Readable } from 'node:stream';
import { z } from 'zod';
import { authMiddleware, requirePermission, requireScope } from '../middleware/auth';
import { PERMISSIONS } from '../services/permissions';
import { captureException } from '../services/sentry';
import { safeContentDispositionFilename } from '../utils/httpHeaders';
import { findArtifactForAuth, openArtifactStream } from '../services/artifacts/artifactService';
import { BlobNotFoundError } from '../services/artifacts/blobStorage';

/**
 * AI artifact DOWNLOAD (execution-plane spec §5.2, §8).
 *
 * The per-run LISTING is deliberately NOT here: it is
 * `GET /ai/agents/runs/:runId/artifacts`, and it is registered inside
 * `aiAgentsRoutes` (routes/aiAgents.ts) beside the run detail it shares a
 * prefix with. Mounting a second Hono app at `/ai/agents` would make the
 * precedence between the two depend on mount order in index.ts, invisible from
 * either router — the shape of #4189.
 *
 * RBAC is identical to `GET /ai/agents/runs/:runId`: the same scope set, the
 * same ai_agents:read permission, org scoping through `auth.orgCondition`, and
 * a BARE 404 on every miss. A handle is opaque, so "exists but not yours" must
 * be indistinguishable from "does not exist" — there is deliberately no 403
 * branch in this handler.
 *
 * RENDERING (§8): every response is `Content-Disposition: attachment` plus
 * `X-Content-Type-Options: nosniff`, and the content type comes from the fixed
 * map below — NEVER from the stored string. This is stricter than the ticket
 * attachment route, which serves images inline: an artifact is model- or
 * sandbox-produced content, and no artifact is ever rendered by a browser in a
 * Breeze origin. Bytes are streamed through the API rather than handed out as a
 * presigned redirect, because streaming is the only way to force these two
 * headers on every storage provider.
 */

export const aiArtifactRoutes = new Hono();
aiArtifactRoutes.use('*', authMiddleware);

const requireAiRead = requirePermission(PERMISSIONS.AI_AGENTS_READ.resource, PERMISSIONS.AI_AGENTS_READ.action);
const scopes = requireScope('organization', 'partner', 'system');

const UUID = z.string().guid();

/**
 * The ONLY content types an artifact download may echo. Everything else —
 * html, svg, xml, any script type, anything unrecognised — becomes
 * octet-stream. An allowlist, never a denylist: a new active type must not
 * become renderable by default.
 */
const SAFE_DOWNLOAD_CONTENT_TYPES = new Set([
  'application/json',
  'application/jsonl',
  'text/plain; charset=utf-8',
  'text/plain',
  'text/csv',
  'text/tab-separated-values',
  'application/gzip',
  'application/zip',
  'application/pdf',
]);

export function artifactDownloadContentType(stored: string): string {
  const normalised = stored.trim().toLowerCase();
  return SAFE_DOWNLOAD_CONTENT_TYPES.has(normalised) ? normalised : 'application/octet-stream';
}

function notFound(c: { json: (b: unknown, s: 404) => Response }): Response {
  return c.json({ error: 'Artifact not found', code: 'ARTIFACT_NOT_FOUND' }, 404);
}

// GET /ai/artifacts/:id — authenticated bytes, always an attachment.
aiArtifactRoutes.get('/:id', scopes, requireAiRead, async (c) => {
  const id = c.req.param('id');
  // A non-uuid must never reach the query: Postgres raises 22P02 on the cast
  // and poisons the request transaction, turning a 404 into a 500 at COMMIT.
  if (!UUID.safeParse(id).success) return notFound(c);

  const auth = c.get('auth');
  const record = await findArtifactForAuth(id, auth);
  if (!record) return notFound(c);

  let stream: NodeJS.ReadableStream;
  try {
    stream = await openArtifactStream(record);
  } catch (err) {
    if (err instanceof BlobNotFoundError) {
      // The row outlived its object (a partially-completed sweep, or a
      // compensating delete that raced). A 404 is honest here.
      console.error('[ai-artifacts] object missing for row', { artifactId: record.id });
      return notFound(c);
    }
    // A transport/auth fault is 503, NEVER a silent 404 — masking it would make
    // a bucket outage look like mass data loss to the technician (#1807/#1808).
    captureException(err);
    return c.json(
      { error: 'Artifact storage is unavailable — try again shortly', code: 'ARTIFACT_STORAGE_UNAVAILABLE' },
      503,
    );
  }

  // Re-sanitised on the way OUT as well as in: a CR/LF or quote reaching this
  // header is response splitting, and the defence must not depend on every row
  // having been written by the current capture path.
  const filename = safeContentDispositionFilename(record.name).replace(/[^\x20-\x7e]/g, '_') || 'artifact';
  return c.body(Readable.toWeb(stream as Readable) as ReadableStream, 200, {
    'Content-Type': artifactDownloadContentType(record.contentType),
    'Content-Disposition': `attachment; filename="${filename}"`,
    'X-Content-Type-Options': 'nosniff',
    'Content-Length': String(record.bytes),
    'Cache-Control': 'private, no-store',
  });
});
```

- [ ] **Step 4: Write the failing route-precedence test in `aiAgents.test.ts`**

Append to `apps/api/src/routes/aiAgents.test.ts`, following that file's existing mocking conventions (read its top ~80 lines first — it already mocks `../middleware/auth` and the db; add `listArtifactsForAuth` / `toArtifactDto` to the mocks the same way, and reuse its existing `app()`/request helper rather than building a new one):

```ts
describe('GET /ai/agents/runs/:runId/artifacts (execution-plane W01, reconciliation R6)', () => {
  it('returns DTOs with no blobKey and a download path each', async () => {
    mockListArtifactsForAuth.mockResolvedValue([artifactRecord()]);
    const res = await request(`/api/v1/ai/agents/runs/${RUN}/artifacts`);
    expect(res.status).toBe(200);
    const body = await res.json() as { data: Array<Record<string, unknown>> };
    expect(body.data).toHaveLength(1);
    expect(Object.keys(body.data[0]!)).not.toContain('blobKey');
    expect(body.data[0]!.downloadPath).toBe(`/api/v1/ai/artifacts/${ART}`);
  });

  it("returns an empty list — not a 404 — for a run with no artifacts or another org's run", async () => {
    mockListArtifactsForAuth.mockResolvedValue([]);
    const res = await request(`/api/v1/ai/agents/runs/${RUN}/artifacts`);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ data: [] });
  });

  it('400s a non-uuid runId without querying', async () => {
    const res = await request('/api/v1/ai/agents/runs/nope/artifacts');
    expect(res.status).toBe(400);
    expect(mockListArtifactsForAuth).not.toHaveBeenCalled();
  });

  // THE PRECEDENCE ASSERTION. Both paths live in one router, so registration
  // order inside this file is the only thing that separates them — and that
  // order is what #4189 got wrong when a sibling path was owned by a different
  // app. If /runs/:runId ever moves above /runs/:runId/artifacts, the first
  // case here still passes only if Hono's param matching stays non-greedy;
  // the second is what actually breaks, and it must not.
  it('routes /runs/<uuid>/artifacts to the LIST and /runs/<uuid> to the run DETAIL', async () => {
    mockListArtifactsForAuth.mockResolvedValue([]);
    const list = await request(`/api/v1/ai/agents/runs/${RUN}/artifacts`);
    expect(list.status).toBe(200);
    expect(await list.json()).toEqual({ data: [] });
    expect(mockListArtifactsForAuth).toHaveBeenCalledTimes(1);

    const detail = await request(`/api/v1/ai/agents/runs/${RUN}`);
    expect(detail.status).toBe(200);
    // The run-detail body, NOT an artifact list: `data` is the list route's
    // envelope and must not appear here.
    expect(await detail.json()).not.toHaveProperty('data');
    expect(mockListArtifactsForAuth).toHaveBeenCalledTimes(1);   // detail did not hit the list
  });
});
```

Run: `cd apps/api && npx vitest run src/routes/aiAgents.test.ts -t 'artifacts'`
Expected: FAIL — 404 on `/runs/<uuid>/artifacts` (the route does not exist yet).

- [ ] **Step 5: Register the list route inside `aiAgentsRoutes`, above `/runs/:runId`**

`apps/api/src/routes/aiAgents.ts` — insert immediately BEFORE the `aiAgentsRoutes.get('/runs/:runId', …)` declaration at line 1198:

```ts
/**
 * The run's artifacts (execution-plane spec §5.2/§8, W01). Registered HERE, in
 * the router that already owns `/runs/:runId`, rather than in its own app
 * mounted at the same `/ai/agents` prefix: two routers behind one prefix put
 * their precedence in index.ts's mount order, invisible from either file, which
 * is the shape of #4189. Keep this ABOVE `/runs/:runId`.
 *
 * An empty list rather than a 404 for another org's run: the run-detail route
 * below already owns the exists/not-exists answer, and duplicating it here
 * would add a second, independently-driftable disclosure surface. `blobKey`
 * never leaves the API — `toArtifactDto` projects fields explicitly.
 */
aiAgentsRoutes.get('/runs/:runId/artifacts', scopes, requireAiRead, async (c) => {
  const runId = uuidParam(c, 'runId');
  if (!runId) return c.json({ error: 'Invalid run id', code: 'INVALID_RUN_ID' }, 400);

  const auth = c.get('auth');
  const records = await listArtifactsForAuth(runId, auth);
  return c.json({ data: records.map(toArtifactDto) });
});
```

and add to that file's imports:

```ts
import { listArtifactsForAuth, toArtifactDto } from '../services/artifacts/artifactService';
```

`scopes`, `requireAiRead` (both declared at `:99-101`) and `uuidParam` (`:125`) are reused verbatim — that reuse is the point of putting the route here, since the run detail and its artifact list cannot drift apart on authorization or id validation.

- [ ] **Step 6: Mount the download router in `index.ts` — ONE new mount**

`apps/api/src/index.ts` — add beside the other AI imports (~line 142):

```ts
import { aiArtifactRoutes } from './routes/aiArtifacts';
```

and in the mount block (lines 978-987), immediately BEFORE `api.route('/ai', aiRoutes)` (line 986):

```ts
// BEFORE /ai: aiRoutes owns broad paths. There is no /ai/agents mount here —
// the per-run artifact LIST lives inside aiAgentsRoutes itself (see
// routes/aiAgents.ts, above its /runs/:runId), so no second router shares
// that prefix.
api.route('/ai/artifacts', aiArtifactRoutes);
```

Leave `api.route('/ai/agents', aiAgentsRoutes)` and the `/ai/agents/schedules` mount above it exactly as they are.

- [ ] **Step 7: Run the route tests and the route-registration contracts**

```bash
cd apps/api && npx vitest run src/routes/aiArtifacts.test.ts src/routes/aiAgents.test.ts
npx vitest run src/index.test.ts src/routes/routeRegistration 2>/dev/null || true
grep -n "aiArtifactRoutes" src/index.ts
grep -n "runs/:runId" src/routes/aiAgents.ts
```
Expected: both route suites PASS (the download suite 11 tests; `aiAgents.test.ts` green including the four new cases). `grep` shows one import and one mount for `aiArtifactRoutes`, and `/runs/:runId/artifacts` appearing on a LOWER line number than `/runs/:runId`. If this repo has a route-inventory or permission-coverage contract test (`ls src/__tests__ | grep -i route`, `grep -rln "api.route(" src/*.test.ts`), run it and add the new paths wherever it expects an entry.

- [ ] **Step 8: Decide the self-managed-DB-context question explicitly**

The download route holds a pooled connection for the duration of a blob stream, which is exactly the #1448 shape `selfManagedDbContextRoutes.ts` exists for. **Do not add an entry yet** — the row read completes before `openArtifactStream` is called, and Hono's `c.body(stream)` returns before the bytes flow, so the handler itself is short. Record this in the PR body as a watch item: if `ai-artifacts` shows up in a pool-hold investigation, the fix is one entry:

```ts
  { method: 'GET', pattern: /^\/api\/v1\/ai\/artifacts\/[^/]+\/?$/ },
```

- [ ] **Step 9: Typecheck and commit**

```bash
cd apps/api && NODE_OPTIONS=--max-old-space-size=8192 npx tsc --noEmit -p tsconfig.json
git add apps/api/src/routes/aiArtifacts.ts apps/api/src/routes/aiArtifacts.test.ts \
  apps/api/src/routes/aiAgents.ts apps/api/src/routes/aiAgents.test.ts apps/api/src/index.ts
git commit -m "feat(ai): artifact download and per-run listing routes

Spec §8. Every download is Content-Disposition: attachment + nosniff with the content
type from a fixed allowlist — an HTML artifact is served as octet-stream, never inline.
A wrong-org handle 404s exactly like a missing one (handles are opaque, §5.2); a storage
fault is 503, never a silent 404. RBAC matches GET /ai/agents/runs/:runId because the
per-run listing is registered in aiAgentsRoutes itself, one line above that route,
reusing its scopes/permission/uuidParam — not as a second app behind the same /ai/agents
prefix, whose precedence would live in index.ts's mount order (#4189). A precedence test
pins both paths.

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_01MwUHaGwobGHrTgu8TcCWqr"
```

---

### Task 11: Hourly expiry sweeper — `apps/api/src/jobs/aiArtifactSweeper.ts`

**Files:**
- Create: `apps/api/src/jobs/aiArtifactSweeper.ts`, `apps/api/src/jobs/aiArtifactSweeper.test.ts`
- Modify: `apps/api/src/jobs/scheduleRegistry.ts:~159` (allocate the `:2` slot)
- Modify: `apps/api/src/services/workerRegistry.ts:~117-124` (a `placement: 'global'` entry beside `aiBudgetAlertDeliveryWorker`)
- Modify: `apps/api/src/jobs/workerReadinessManifest.ts:~186` (a `consumers(...)` row)
- Modify: `apps/api/src/services/workerEntrypointClosure.contract.test.ts:~272` and `apps/api/src/services/workerRegistry.test.ts` and `apps/api/src/jobs/workerReadinessCoverage.test.ts` (the duplicated name lists)

**Interfaces:**
- Consumes: `db`, `runOutsideDbContext`, `withSystemDbAccessContext` (`../db`); `getBullMQConnection` (`../services/redis`); `attachWorkerObservability` (`./workerObservability`); `jobSchedule` (`./scheduleRegistry`); `getBlobStorage` (Task 4); `aiRunArtifacts` (Task 3).
- Produces:
  ```ts
  export const AI_ARTIFACT_SWEEPER_QUEUE = 'ai-artifact-expiry-sweeper';
  export const AI_ARTIFACT_SWEEP_BATCH = 200;
  export async function sweepExpiredArtifacts(): Promise<{ blobsDeleted: number; rowsDeleted: number; failed: number }>;
  export async function initializeAiArtifactSweeper(): Promise<void>;
  export async function shutdownAiArtifactSweeper(): Promise<void>;
  ```

**Template is `ticketAttachmentReaper.ts`, not `aiBudgetAlertDelivery.ts`.** The budget-alert job is sub-hourly (15 min) and explicitly EXEMPT from `scheduleRegistry` — its own comment at lines 383-387 says so. An hourly job is coarse (`COARSE_REPEAT_INTERVAL_MS = 3_600_000`) and MUST take an allocated slot. **Minute `:2` is the last free minute in the ≡2 (mod 5) lane** (the ticket reaper took `:32` and its comment at line 158 says those were the two remaining) — verify with `grep -n "'2 \* \* \* \*'" apps/api/src/jobs/scheduleRegistry.ts` returning nothing before claiming it.

**Two traps the reaper's own comments record:** (1) `repeat: { pattern: jobSchedule('<string literal>') }` — the contract test statically resolves a LITERAL argument, so passing the exported key constant breaks it; (2) do not nest `withSystemDbAccessContext` (#1105) — the worker handler must not wrap the sweep if the sweep opens its own.

- [ ] **Step 1: Read the template and confirm the free slot**

```bash
cd /Users/toddhebebrand/.herdr/worktrees/breeze/worktree-rapid-cloud-904e
sed -n '40,218p' apps/api/src/jobs/ticketAttachmentReaper.ts
grep -n "'2 \* \* \* \*'" apps/api/src/jobs/scheduleRegistry.ts     # must print NOTHING
sed -n '140,162p' apps/api/src/jobs/scheduleRegistry.ts
```
If `:2` is taken by then, pick another minute ≡ 2 (mod 5) that is free and update the comment.

- [ ] **Step 2: Write the failing sweeper test**

```ts
// apps/api/src/jobs/aiArtifactSweeper.test.ts
/**
 * Execution-plane W01 (spec §6.1 "sweeper deletes blob then row", §12). The
 * order is the whole contract: the row is the only index to the blob key, so a
 * row deleted first strands the bytes permanently.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  rows: [] as unknown[][],
  deleted: [] as unknown[],
  calls: [] as string[],
  blobDelete: vi.fn(async (key: string) => { mocks.calls.push(`blob:${key}`); }),
  withSystem: vi.fn(),
  runOutside: vi.fn(),
  attach: vi.fn(),
  scheduleAdd: vi.fn(),
}));

vi.mock('bullmq', () => ({
  Queue: class { add = mocks.scheduleAdd; getRepeatableJobs = async () => []; close = async () => {}; },
  Worker: class { close = async () => {}; },
  Job: class {},
}));
vi.mock('../db', () => ({
  db: {
    select: vi.fn(() => ({ from: vi.fn(() => ({ where: vi.fn(() => ({ limit: vi.fn(async () => mocks.rows.shift() ?? []) })) })) })),
    delete: vi.fn(() => ({ where: vi.fn(async (w: unknown) => { mocks.calls.push('row:delete'); mocks.deleted.push(w); }) })),
  },
  withSystemDbAccessContext: mocks.withSystem,
  runOutsideDbContext: mocks.runOutside,
}));
vi.mock('../services/redis', () => ({ getBullMQConnection: () => ({}) }));
vi.mock('../services/sentry', () => ({ captureException: vi.fn() }));
vi.mock('./workerObservability', () => ({ attachWorkerObservability: mocks.attach }));
vi.mock('../services/artifacts/blobStorage', () => ({ getBlobStorage: () => ({ delete: mocks.blobDelete }) }));

import {
  AI_ARTIFACT_SWEEP_BATCH,
  AI_ARTIFACT_SWEEPER_QUEUE,
  initializeAiArtifactSweeper,
  sweepExpiredArtifacts,
} from './aiArtifactSweeper';

beforeEach(() => {
  mocks.rows.length = 0; mocks.deleted.length = 0; mocks.calls.length = 0;
  mocks.blobDelete.mockClear().mockImplementation(async (key: string) => { mocks.calls.push(`blob:${key}`); });
  mocks.scheduleAdd.mockClear();
  mocks.withSystem.mockImplementation(async (fn: () => Promise<unknown>) => fn());
  mocks.runOutside.mockImplementation(async (fn: () => Promise<unknown>) => fn());
});

const row = (id: string, key: string) => ({ id, blobKey: key });

describe('sweepExpiredArtifacts', () => {
  it('deletes the BLOB before the ROW for each expired artifact', async () => {
    mocks.rows.push([row('a1', 'us/2026/09/k1')], []);
    const stats = await sweepExpiredArtifacts();
    expect(mocks.calls).toEqual(['blob:us/2026/09/k1', 'row:delete']);
    expect(stats).toEqual({ blobsDeleted: 1, rowsDeleted: 1, failed: 0 });
  });

  it('pages in batches of 200 until a short page ends the sweep', async () => {
    const full = Array.from({ length: AI_ARTIFACT_SWEEP_BATCH }, (_, i) => row(`f${i}`, `us/2026/09/k${i}`));
    mocks.rows.push(full, [row('last', 'us/2026/09/kl')], []);
    const stats = await sweepExpiredArtifacts();
    expect(stats.rowsDeleted).toBe(AI_ARTIFACT_SWEEP_BATCH + 1);
  });

  it('LEAVES the row when its blob delete fails, counts it, and keeps sweeping', async () => {
    mocks.rows.push([row('bad', 'us/2026/09/boom'), row('good', 'us/2026/09/ok')], []);
    mocks.blobDelete.mockImplementation(async (key: string) => {
      mocks.calls.push(`blob:${key}`);
      if (key.endsWith('boom')) throw new Error('bucket down');
    });
    const stats = await sweepExpiredArtifacts();
    expect(stats).toEqual({ blobsDeleted: 1, rowsDeleted: 1, failed: 1 });
    // One row delete only — the failed artifact keeps its row so the NEXT
    // sweep can find the key again. That is what makes the sweep rerunnable.
    expect(mocks.calls.filter((c) => c === 'row:delete')).toHaveLength(1);
  });

  it('runs under a SYSTEM context (the scan is deliberately cross-org)', async () => {
    mocks.rows.push([], []);
    await sweepExpiredArtifacts();
    expect(mocks.withSystem).toHaveBeenCalled();
  });

  it('is a no-op when nothing has expired', async () => {
    mocks.rows.push([]);
    expect(await sweepExpiredArtifacts()).toEqual({ blobsDeleted: 0, rowsDeleted: 0, failed: 0 });
    expect(mocks.blobDelete).not.toHaveBeenCalled();
  });
});

describe('initializeAiArtifactSweeper', () => {
  it('registers the repeatable job on its allocated hourly slot', async () => {
    await initializeAiArtifactSweeper();
    const opts = mocks.scheduleAdd.mock.calls[0]![2] as { repeat: { pattern: string }; jobId: string };
    expect(opts.repeat.pattern).toBe('2 * * * *');
    expect(opts.jobId).toBe(AI_ARTIFACT_SWEEPER_QUEUE);
  });
});
```

- [ ] **Step 3: Run it to verify it fails**

Run: `cd apps/api && npx vitest run src/jobs/aiArtifactSweeper.test.ts`
Expected: FAIL — `Failed to resolve import "./aiArtifactSweeper"`.

- [ ] **Step 4: Allocate the schedule slot**

`apps/api/src/jobs/scheduleRegistry.ts`, in the sub-daily tier beside `'ticket-attachment-pending-reaper'` (~line 159):

```ts
  // Execution plane W01 (spec §6.1) — hourly expiry sweep of ai_run_artifacts,
  // blob then row. :2 is the last free minute in the ≡2 (mod 5) lane.
  'ai-artifact-expiry-sweeper': '2 * * * *',
```

- [ ] **Step 5: Write the sweeper**

```ts
// apps/api/src/jobs/aiArtifactSweeper.ts
import { Job, Queue, Worker } from 'bullmq';
import { lt } from 'drizzle-orm';
import { db, runOutsideDbContext, withSystemDbAccessContext } from '../db';
import { aiRunArtifacts } from '../db/schema';
import { getBullMQConnection } from '../services/redis';
import { captureException } from '../services/sentry';
import { getBlobStorage } from '../services/artifacts/blobStorage';
import { attachWorkerObservability } from './workerObservability';
import { jobSchedule } from './scheduleRegistry';
import { eq } from 'drizzle-orm';

/**
 * AI artifact expiry sweep (execution-plane spec §6.1: "sweeper deletes blob
 * then row"; §8 residency).
 *
 * ORDER IS THE CONTRACT. `blob_key` carries no tenant id by design, so the row
 * is the ONLY index to the object. A row deleted before its blob strands
 * customer bytes in the bucket permanently — the exact GDPR failure the
 * erasure pre-clear in tenantCascade.ts step 1a-bis also guards. A blob delete
 * that fails therefore LEAVES its row, is counted, and the next hourly sweep
 * retries it; the sweep is rerunnable by construction.
 *
 * CROSS-ORG BY DESIGN: this is the one artifact path that legitimately runs
 * under a system context, which is why the table carries a plain
 * `(expires_at)` index alongside the tenant-scoped `(org_id, expires_at)` one.
 *
 * Batched (200) so a large backlog does not hold one pooled connection or one
 * job for minutes; each batch re-queries, so rows the previous batch left
 * behind (failed blob deletes) are naturally retried next hour rather than
 * spinning inside this run.
 */

export const AI_ARTIFACT_SWEEPER_QUEUE = 'ai-artifact-expiry-sweeper';
const JOB_NAME = 'sweep-expired-ai-artifacts';
export const AI_ARTIFACT_SWEEP_BATCH = 200;
/** Guard against an unbounded run if every blob delete is failing. */
const MAX_BATCHES_PER_RUN = 50;

let queue: Queue | null = null;
let worker: Worker | null = null;

function getQueue(): Queue {
  if (!queue) queue = new Queue(AI_ARTIFACT_SWEEPER_QUEUE, { connection: getBullMQConnection() });
  return queue;
}

export async function sweepExpiredArtifacts(): Promise<{ blobsDeleted: number; rowsDeleted: number; failed: number }> {
  const blobs = getBlobStorage();
  const stats = { blobsDeleted: 0, rowsDeleted: 0, failed: 0 };
  // Ids already tried and failed this run, so a short page does not loop on
  // the same rows (each batch re-queries from the top of the expiry order).
  const skip = new Set<string>();

  for (let batch = 0; batch < MAX_BATCHES_PER_RUN; batch += 1) {
    const rows = await runOutsideDbContext(() => withSystemDbAccessContext(() =>
      db
        .select({ id: aiRunArtifacts.id, blobKey: aiRunArtifacts.blobKey })
        .from(aiRunArtifacts)
        .where(lt(aiRunArtifacts.expiresAt, new Date()))
        .limit(AI_ARTIFACT_SWEEP_BATCH + skip.size),
    ), 'aiArtifactSweeper.scan'));

    const pending = rows.filter((r) => !skip.has(r.id)).slice(0, AI_ARTIFACT_SWEEP_BATCH);
    if (pending.length === 0) break;

    for (const artifact of pending) {
      try {
        // Blob FIRST — always.
        await blobs.delete(artifact.blobKey);
        stats.blobsDeleted += 1;
      } catch (err) {
        // Leave the row so the key stays findable; the next sweep retries it.
        stats.failed += 1;
        skip.add(artifact.id);
        captureException(err);
        console.error('[aiArtifactSweeper] blob delete failed; row kept for the next sweep', { artifactId: artifact.id });
        continue;
      }
      await runOutsideDbContext(() => withSystemDbAccessContext(() =>
        db.delete(aiRunArtifacts).where(eq(aiRunArtifacts.id, artifact.id)),
      'aiArtifactSweeper.delete'));
      stats.rowsDeleted += 1;
    }

    if (pending.length < AI_ARTIFACT_SWEEP_BATCH) break;
  }

  if (stats.rowsDeleted > 0 || stats.failed > 0) {
    console.log(`[aiArtifactSweeper] swept ${stats.rowsDeleted} expired artifact(s), ${stats.failed} deferred`);
  }
  return stats;
}

async function processJob(_job: Job): Promise<unknown> {
  // Deliberately NOT wrapped in withSystemDbAccessContext here — the sweep
  // opens its own short contexts per statement, and nesting them is the #1105
  // double-connection-hold trap the ticket reaper's handler documents.
  return sweepExpiredArtifacts();
}

async function scheduleRepeatableJob(): Promise<void> {
  const q = getQueue();
  for (const job of await q.getRepeatableJobs()) {
    if (job.name === JOB_NAME) await q.removeRepeatableByKey(job.key);
  }
  await q.add(
    JOB_NAME,
    { type: JOB_NAME, queuedAt: new Date().toISOString() },
    {
      jobId: AI_ARTIFACT_SWEEPER_QUEUE,
      // String literal, not the exported const: the schedule contract test
      // statically resolves `jobSchedule('<literal>')` only.
      repeat: { pattern: jobSchedule('ai-artifact-expiry-sweeper') },
      removeOnComplete: { count: 20 },
      removeOnFail: { count: 200 },
    },
  );
}

export async function initializeAiArtifactSweeper(): Promise<void> {
  if (worker) return;
  worker = new Worker(AI_ARTIFACT_SWEEPER_QUEUE, processJob, {
    connection: getBullMQConnection(),
    concurrency: 1,
  });
  attachWorkerObservability(worker, 'aiArtifactSweeper');
  try {
    await scheduleRepeatableJob();
  } catch (err) {
    await worker.close();
    worker = null;
    throw err;
  }
  console.log('[aiArtifactSweeper] Initialized');
}

export async function shutdownAiArtifactSweeper(): Promise<void> {
  await worker?.close();
  worker = null;
  await queue?.close();
  queue = null;
}
```

Check the arity of `withSystemDbAccessContext` in this repo before committing: `aiBudgetAlertDelivery.ts:279` passes a `(fn, label)` pair (the #4276 diagnostic label). If the signature takes only `fn`, drop the labels above — match the file, do not introduce a second convention.

- [ ] **Step 6: Register the worker in all four places**

`apps/api/src/services/workerRegistry.ts`, beside `aiBudgetAlertDeliveryWorker` (~line 124):

```ts
  {
    name: 'aiArtifactSweeper',
    placement: 'global',
    load: async () => {
      const m = await import('../jobs/aiArtifactSweeper');
      return { init: m.initializeAiArtifactSweeper, shutdown: m.shutdownAiArtifactSweeper };
    },
  },
```

`apps/api/src/jobs/workerReadinessManifest.ts`, beside the `ticketAttachmentReaper` row (~line 167). The worker attaches under the name `'aiArtifactSweeper'`, which MATCHES its registry key, so the one-argument form is correct:

```ts
  consumers('aiArtifactSweeper'),
```

`apps/api/src/services/workerEntrypointClosure.contract.test.ts` — add `'aiArtifactSweeper'` to `EXPECTED_NAMES` (~line 300, beside `'ticketAttachmentReaper'`). Then find every OTHER duplicated copy of that list and add it there too:

```bash
grep -rln "ticketAttachmentReaper" apps/api/src --include=*.test.ts
```
Expected hits include `apps/api/src/services/workerRegistry.test.ts` and `apps/api/src/jobs/workerReadinessCoverage.test.ts`. The lists are deliberately duplicated rather than imported (see the comment at `workerEntrypointClosure.contract.test.ts:267-271`), so each one needs the entry.

- [ ] **Step 7: Run the sweeper test and every registration contract**

```bash
cd apps/api && npx vitest run \
  src/jobs/aiArtifactSweeper.test.ts \
  src/jobs/scheduleRegistry.contract.test.ts \
  src/services/workerEntrypointClosure.contract.test.ts \
  src/services/workerRegistry.test.ts \
  src/jobs/workerReadinessCoverage.test.ts
```
Expected: all PASS. A red `scheduleRegistry.contract.test.ts` almost always means the `jobSchedule(...)` argument is not a string literal, or the minute collides with an allocated slot.

- [ ] **Step 8: Typecheck and commit**

```bash
cd apps/api && NODE_OPTIONS=--max-old-space-size=8192 npx tsc --noEmit -p tsconfig.json
git add apps/api/src/jobs/aiArtifactSweeper.ts apps/api/src/jobs/aiArtifactSweeper.test.ts \
  apps/api/src/jobs/scheduleRegistry.ts apps/api/src/services/workerRegistry.ts \
  apps/api/src/jobs/workerReadinessManifest.ts \
  apps/api/src/services/workerEntrypointClosure.contract.test.ts \
  apps/api/src/services/workerRegistry.test.ts apps/api/src/jobs/workerReadinessCoverage.test.ts
git commit -m "feat(ai): hourly ai_run_artifacts expiry sweeper — blob then row, batches of 200

Spec §6.1. Runs under a system context because the scan is cross-org by design; a blob
delete that fails leaves its row so the key stays findable and the next sweep retries it.
Takes the last free :2 slot in the sub-daily lane and registers in all four worker lists.

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_01MwUHaGwobGHrTgu8TcCWqr"
```

---

### Task 12: Full verification sweep — contracts, integration, registration greps, PR

**Files:** none created. This task RUNS things and opens the PR. Any red here is a defect in an earlier task, fixed there.

**Why a whole task for it.** Every failure mode this wave can ship is invisible to a touched-file test run. The org cascade list, both export-policy suites and the org-merge registry only fail under **Integration Tests** (a live DB), so a unit-green PR on a stale base goes red on main after merge — that has happened five times (#1359, #1351, #1365, #2179, #2514), and code review caught it 0/5 while the contract tests caught it 5/5. A fixer's touched-file sweep is not CI.

- [ ] **Step 1: Grep every registration list by hand — mechanical, not a judgement call**

```bash
cd /Users/toddhebebrand/.herdr/worktrees/breeze/worktree-rapid-cloud-904e

# Tenancy: the five lists a new org_id table must appear in (or be provably exempt from).
grep -n "'ai_run_artifacts'"  apps/api/src/services/tenantCascade.ts                  # expect 2: cascade order + the blob pre-clear SQL
grep -n '"ai_run_artifacts"'  apps/api/src/services/tenantExportPolicyRegistry.ts     # expect 1
grep -n 'ai_run_artifacts'    apps/api/src/services/orgMergeRegistry.ts               # expect 1, inside SPECIAL
grep -n 'ai_run_artifacts'    apps/api/src/routes/devices/core.ts                     # expect 0 — source_device_id is NOT device_id
grep -n 'ai_run_artifacts'    apps/api/src/__tests__/integration/rls-coverage.integration.test.ts  # expect 0 — Shape 1 is auto-discovered

# Worker: the four lists a new job must appear in.
for f in apps/api/src/jobs/scheduleRegistry.ts apps/api/src/services/workerRegistry.ts \
         apps/api/src/jobs/workerReadinessManifest.ts \
         apps/api/src/services/workerEntrypointClosure.contract.test.ts \
         apps/api/src/services/workerRegistry.test.ts \
         apps/api/src/jobs/workerReadinessCoverage.test.ts; do
  printf '%-70s %s\n' "$f" "$(grep -c 'aiArtifactSweeper\|ai-artifact-expiry-sweeper' "$f")"
done   # every line must be >= 1

# Routes: ONE new mount in index.ts, and the per-run listing inside aiAgentsRoutes.
grep -n 'aiArtifactRoutes' apps/api/src/index.ts          # expect 2: one import + one mount
grep -c "api.route('/ai/agents'" apps/api/src/index.ts    # expect 1 — no second router on that prefix
grep -n "runs/:runId" apps/api/src/routes/aiAgents.ts     # /runs/:runId/artifacts on the LOWER line (R6)

# Env: every new var in both .env.example files and both compose api blocks.
for v in BREEZE_AI_WORKSPACE_ENABLED BREEZE_REGION ARTIFACT_BLOB_BACKEND \
         ARTIFACT_S3_BUCKET_EU ARTIFACT_S3_BUCKET_US ARTIFACT_S3_ACCESS_KEY ARTIFACT_S3_SECRET_KEY; do
  printf '%-34s root=%s deploy=%s compose=%s prod=%s\n' "$v" \
    "$(grep -c "$v" .env.example)" "$(grep -c "$v" deploy/.env.example)" \
    "$(grep -c "$v" docker-compose.yml)" "$(grep -c "$v" deploy/docker-compose.prod.yml)"
done   # every column must be >= 1

# R1: no second region variable was introduced anywhere.
grep -rn 'ARTIFACT_REGION' apps/api/src packages .env.example || echo 'OK: no ARTIFACT_REGION (breezeRegion is canonical)'

# R2: exactly one capture channel survived the reconciliation.
grep -rn 'captureScopeFor\|resolveCaptureContext' apps/api/src packages \
  || echo 'OK: no generation-1 capture helpers anywhere'
git diff --stat origin/main -- apps/api/src/services/toolExecutionContext.ts \
  | grep . && echo 'FAIL: ToolExecutionContext must not be modified by W01' \
  || echo 'OK: ToolExecutionContext untouched'
grep -n 'capture?: CaptureScope' apps/api/src/services/aiTools.ts   # exactly one hit
grep -rn 'accessibleOrgIds' apps/api/src/services/artifacts/ \
  | grep -v 'NEVER\|never\|NOT consulted' \
  && echo 'FAIL: the capture org must never be derived from accessibleOrgIds' \
  || echo 'OK: no accessibleOrgIds org fallback'

# R6: the per-run listing lives INSIDE aiAgentsRoutes, above /runs/:runId, and
# there is no second router mounted at /ai/agents.
grep -n "runs/:runId" apps/api/src/routes/aiAgents.ts    # /artifacts must be the LOWER line number
grep -c "api.route('/ai/agents'" apps/api/src/index.ts   # must be exactly 1
```

Any line whose count is 0 where a count was expected is a missing registration — go back to the owning task. **Do not proceed on a judgement call that an entry "is not needed"**; the only exempt list is the device cascade, and that exemption is what `source_device_id` buys.

- [ ] **Step 2: Migration naming and ordering, re-checked against `origin/main`**

```bash
git fetch origin main
bash scripts/check-migration-naming.sh --against-ref origin/main
ls apps/api/migrations/*.sql | sort | tail -3
```
Expected: exit 0, and `2026-10-16-100000-ai-run-artifacts.sql` sorts last. The pre-push hook re-checks this against `origin/main`, so a migration that was fine when written can fail here if main gained a later-sorting file meanwhile — rename (the file is unshipped) and sweep every reference to the old path, including any integration suite that reads it with `readFileSync`.

- [ ] **Step 3: Full API unit suite — not the touched files**

```bash
cd apps/api && NODE_OPTIONS=--max-old-space-size=8192 npx vitest run
```
Expected: green. A 0-file or 0-test result is a stall, not a pass — check the reported counts. Pay attention to suites this wave did not touch but does affect: `aiToolOutput.test.ts` (the `maxChars` threading), everything under `src/services/aiAgentSdkTools*` (the `makeToolHandler` rename), `src/config/validate.test.ts` (#2896 and #3374 read-every-declared-key contracts), `src/config/envComposeParity.test.ts`, `src/db/autoMigrate.test.ts` and `src/db/migrationRlsScope.test.ts`.

- [ ] **Step 4: Shared package and typecheck across the workspace**

```bash
cd /Users/toddhebebrand/.herdr/worktrees/breeze/worktree-rapid-cloud-904e
pnpm --filter @breeze/shared test --run
cd apps/api && NODE_OPTIONS=--max-old-space-size=8192 npx tsc --noEmit -p tsconfig.json
cd ../../packages/shared && npx tsc --noEmit -p tsconfig.json
```
Expected: all green.

- [ ] **Step 5: The integration contracts — the ones CI runs in a different job than Test API**

```bash
cd /Users/toddhebebrand/.herdr/worktrees/breeze/worktree-rapid-cloud-904e
pnpm test-stack up
set -a; . ./.env.test; set +a
cd apps/api && pnpm db:check-drift
npx vitest run --config vitest.integration.config.ts \
  src/__tests__/integration/aiRunArtifacts.integration.test.ts \
  src/__tests__/integration/rls-coverage.integration.test.ts \
  src/__tests__/integration/tenantCascade.integration.test.ts \
  src/__tests__/integration/tenant-export-policy.integration.test.ts \
  src/__tests__/integration/tenantExportErasureRoundtrip.integration.test.ts \
  src/__tests__/integration/orgMergeRegistry.integration.test.ts \
  src/__tests__/integration/orgCascadeFkOnDelete.integration.test.ts \
  src/__tests__/integration/orgLifecycleFoundations.integration.test.ts
```
Expected: drift check OK; every suite PASS. Specifically: `rls-coverage` auto-discovers `ai_run_artifacts` as Shape 1 with all four commands policied; `tenantCascade` asserts alphabetised + present + FK-children-before-parents; both export-policy suites assert all sixteen columns are classified; `orgLifecycleFoundations`'s "merge contract" asserts the composite `(run_id, org_id)` FK is `DEFERRABLE`.

- [ ] **Step 6: Forge a cross-tenant insert by hand, as `breeze_app`**

RLS is the boundary; a green test suite that ran as a superuser proves nothing about it. Against the test stack:

```bash
docker exec -it $(docker compose -p "$(grep -m1 COMPOSE_PROJECT_NAME .env.test | cut -d= -f2)" ps -q postgres) \
  psql -U breeze_app -d breeze -c "
    SELECT set_config('breeze.scope','organization',false);
    SELECT set_config('breeze.org_id','<some-org-uuid>',false);
    INSERT INTO ai_run_artifacts (org_id, kind, name, content_type, bytes, sha256, blob_key, created_by_tool)
    VALUES ('<a DIFFERENT org uuid>', 'input_capture', 'forged.json', 'application/json', 1,
            repeat('a',64), 'us/2026/10/forged', 'forge');"
```
Expected: `ERROR: new row violates row-level security policy for table "ai_run_artifacts"`. **A successful insert means the policies are not forced** — stop and fix Task 3's migration. (Read the real connection details out of `.env.test`; the container name above is a template.)

- [ ] **Step 7: Prove the flag-off path is byte-identical**

The wave's central safety claim is that a self-hoster sees no change. With `BREEZE_AI_WORKSPACE_ENABLED` unset:

```bash
cd apps/api && BREEZE_AI_WORKSPACE_ENABLED= IS_HOSTED=false npx vitest run \
  src/services/aiToolOutput.test.ts src/services/aiTools.capture.test.ts src/services/aiTools.test.ts
```
Expected: PASS. Then confirm by inspection that `captureLargeToolResult`'s `if (!aiWorkspaceEnabled()) return raw;` sits BEFORE any `createArtifact` call and before any blob construction — with the flag off, no artifact code runs at all and no S3 client is ever built.

- [ ] **Step 8: Tear down the stack**

```bash
cd /Users/toddhebebrand/.herdr/worktrees/breeze/worktree-rapid-cloud-904e && pnpm test-stack down
docker compose ls -a --format json | jq -r '.[] | select(.ConfigFiles|test("breeze")) | "\(.Name)\t\(.Status)"'
```
Nothing reaps a local stack for you. Leave nothing running, and say in the final summary what (if anything) you left up.

- [ ] **Step 9: Open the PR**

```bash
git push -u origin feature/<parent#>-execution-plane/wave-<subissue#>
gh pr create --title "AI execution plane W01: artifact store and large-result capture" --body "$(cat <<'EOF'
Wave 1 of the AI agent execution plane (spec `docs/superpowers/specs/ai-mcp/2026-09-13-ai-agent-execution-plane-design.md` §5.2, §6.1, §8, §9, §12).

Oversized AI tool results are no longer silently thrown away by compaction: they are persisted as `ai_run_artifacts` rows plus tenant-blind blobs, and the model gets a stageable handle with raw head/tail previews alongside exactly the compacted view it gets today. Technicians can list a run's artifacts and download them as attachments. Everything is behind `BREEZE_AI_WORKSPACE_ENABLED` (hosted-only, default off) — with the flag off, every tool result is byte-identical to today.

## What is in here
- **Registry guard** — every `makeHandler('<name>')` MCP declaration must have an executable handler. Three backup tools (`get_backup_health`, `run_backup_verification`, `get_recovery_readiness`) were declared and tiered but had NO handler, so every model call has thrown `Unknown tool` since they shipped; they are removed and a contract test stops it recurring. Follow-up issue filed for real handlers.
- **`ai_run_artifacts`** — Shape 1, RLS enabled + forced + four policies in the creating migration, composite `(run_id, org_id) → ai_agent_runs(id, org_id)` FK `ON DELETE CASCADE DEFERRABLE INITIALLY IMMEDIATE`. `run_id` is nullable (a chat capture has no run). The device pointer is `source_device_id`, deliberately not `device_id`, so artifacts stay out of the device cascade and move-org lists.
- **Blob store** — region-keyed S3 helper; keys are `<region>/<yyyy>/<mm>/<uuid>` and carry no tenant identifier. `maxBytes` aborts a stream rather than truncating. `ARTIFACT_BLOB_BACKEND=db` boot-refuses (there is no generic blob table in v1).
- **Capture** — inside `executeTool`, after the handler and before any compaction; fires on the same `MAX_TOOL_RESULT_CHARS` the chat compaction uses. `AiTool.captureExempt` opts a structured tool out. A store failure returns `artifact_store_unavailable` and **never** the raw result inline.
- **Routes** — `GET /api/v1/ai/artifacts/:id` (always `attachment` + `nosniff`, content type from a fixed allowlist, so an HTML artifact downloads as octet-stream and is never rendered) and `GET /api/v1/ai/agents/runs/:runId/artifacts`.
- **Lifecycle** — hourly sweeper and org erasure both delete the blob BEFORE the row, because the row is the only index to the key.

## Tenancy registrations (all five checked by grep, not by eye)
`CORE_ORG_CASCADE_DELETE_ORDER` ✓ · `CORE_TENANT_EXPORT_POLICY` (all 16 columns) ✓ · `orgMergeRegistry` SPECIAL ✓ · device cascade lists: intentionally absent (`source_device_id`) ✓ · `rls-coverage` allowlists: not needed, Shape 1 is auto-discovered ✓

## Verification
Full `apps/api` unit suite; the RLS/cascade/export-policy/org-merge integration suites against a live Postgres; `pnpm db:check-drift`; a hand-forged cross-tenant insert as `breeze_app` rejected with `new row violates row-level security policy`; and the flag-off path re-run to confirm byte-identical tool results.

## Follow-ups filed, not fixed here
- Real handlers for the three removed backup tools.
- MCP-server, script-builder and intent-release tool results are not captured in W01: those call sites supply no `capture` scope, so they pass through by design. Attributing them is later-wave work. (The partner-scope chat gap is CLOSED here, not deferred — the chat path supplies `capture.orgId` from `ActiveSession.orgId`, and the agent run path attributes from the `ai_agent` principal.)
- `ticketAttachmentStorage.ts` is untouched; converting its per-row `s3|db` model onto the region-keyed `BlobStorage` is its own change.
- Presigned-redirect downloads, if API-streamed bandwidth becomes a problem.

Closes #<wave sub-issue>

🤖 Generated with [Claude Code](https://claude.com/claude-code)

https://claude.ai/code/session_01MwUHaGwobGHrTgu8TcCWqr
EOF
)"
```

- [ ] **Step 10: Review, then enqueue**

Run `/pr-review-toolkit:review-pr` on the PR and record the pass as a comment. Act on confirmed, consequential findings only; at most one independent review round unless a fix itself touches tenancy, RLS, auth or the migration. Then `gh pr merge <N>` — bare, no strategy flag, **never `--admin`**: the merge queue rebuilds the PR on whatever is ahead of it and runs the full `CI Success` gate on the merge ref. This PR targets `main`, so its integration run already happened on the PR — do not hand-dispatch CI for it.

---
