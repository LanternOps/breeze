---
tracking_issue: LanternOps/breeze#5215
wave: W02 (#5217) — OpenAPI source kind (spec ingestion, operation → tool projection, HTTP executor, UI kind toggle) — one PR
---

# Tool Catalog — Wave 2: OpenAPI Source Kind Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A partner (or org) registers a vendor's OpenAPI 3.x document alongside an API base URL and a credential; Breeze fetches and parses the document, projects each operation into a `tool_source_tools` row with a translated JSON Schema and a fail-closed tier, and the enabled operations reach AI chat, Breeze's MCP server and the Tier-3 approval path through **exactly the same** resolver, descriptor, guardrail and action-intent machinery W01 built for MCP — no second code path for authorization, approvals, auditing or egress.

**Architecture:** W01 landed two tables whose `tool_source_kind` enum *already* contains `'openapi'` (`apps/api/migrations/2026-10-16-193500-tool-sources.sql`); the gap is entirely application-layer. W02 adds **one nullable column** (`tool_sources.spec_url`) and four new service modules under the existing `apps/api/src/services/toolSources/` directory: a spec fetcher/parser (`openapiSpec.ts`), an operation→tool projector (`openapiProjection.ts`), an HTTP request builder/executor (`openapiClient.ts`), and a shared auth-header builder (`authHeaders.ts`) extracted from `McpClient` so both transports pin credentials identically. Three existing seams gain a `kind` branch and nothing else changes: `discovery.ts` (which lister produces the listing array), `execute.ts` (which client dispatches the call), `resolver.ts` (`sourceKind` widens from the literal `'mcp'` to `'mcp' | 'openapi'` and is read from the joined row). Everything downstream of the listing array and the result string — tier proposal, revision hashing, removal/review flags, Ajv compilation, rate limits, redaction, truncation, the audit event, the `[External: <source>]` description prefix, the Tier-3 `action_intents` binding — is reused verbatim.

**Tech Stack:** TypeScript, Hono, Drizzle, Postgres (forced RLS), BullMQ, `js-yaml` ^5.2.2 (already an `apps/api` dependency), Ajv 8 + ajv-formats (already used by `resolver.ts`), Zod 4.4, `services/urlSafety.ts` `safeFetch`, Vitest, React + Astro + react-i18next (8 locales). **No new npm dependency** — the `$ref` dereferencer and the parameter serialiser are hand-rolled, deliberately (DECISION D14).

**Spec:** `docs/superpowers/specs/ai-mcp/2026-09-07-tool-catalog-and-flows-design.md` — §5.2 (`tool_sources` columns), §5.3 (OpenAPI discovery + tier proposal), §5.5 (execution, credential-origin pinning, egress), §5.6 (guardrails, generic permission policy), §8 (tenancy obligations), §9 (testing: "OpenAPI → tools generator on three fixture specs"), §10 W2 row.

**Predecessor plan (read it — W02 builds on as-built, not on the spec):** `docs/superpowers/plans/ai-mcp/2026-09-07-tool-catalog-w1-tool-sources-mcp.md`. W01 shipped as PRs #5222, #5223, #5964, #5974, #5983.

---

## Global Constraints

Copied verbatim from the W01 plan's Global Constraints except where W02 changes them. Every task's requirements implicitly include this section.

- **Tests:** `cd apps/api && npx vitest run <path>`; shared `cd packages/shared && npx vitest run <path>`; web `cd apps/web && npx vitest run <path>` plus `src/lib/i18n/localeParity.test.ts`, `src/lib/i18n/translationCoverage.test.ts`, `src/lib/__tests__/no-silent-mutations.test.ts`.
  - **Never write `pnpm --filter <pkg> test -- --run <path>`** — pnpm forwards the literal `--` into argv, vitest stops flag parsing there, `--run` becomes a positional filter, and the FULL suite runs in watch mode (CLAUDE.md, Testing Standards). Use `npx vitest run <path>` from inside the package.
  - **Vitest's path filter is a plain substring match, not a glob.** `npx vitest run src/services/toolSources/` matches only files inside that directory — which is what we want here — but `src/routes/toolSources` would also pull in unrelated matches. Always check the reported file count; a 0-test run is a stall, not green.
  - Add `--pool=threads --maxWorkers=2` when a dev stack is running.
- **Typecheck:** `cd apps/api && NODE_OPTIONS=--max-old-space-size=8192 npx tsc --noEmit -p tsconfig.json`; `cd packages/shared && npx tsc --noEmit -p tsconfig.json`; web `cd apps/web && npx astro check`. `pnpm lint` in every touched package.
- **Integration suites** (need a real Postgres; `pnpm test-stack up` for a per-worktree copy, `pnpm test-stack down` when finished — nothing reaps it for you):
  `cd apps/api && npx vitest run --config vitest.integration.config.ts src/__tests__/integration/<file>` with `DATABASE_URL` set.
- **Migration — exactly one, and it is additive (see DECISION D3).** `apps/api/migrations/2026-10-26-090000-tool-sources-openapi-spec-url.sql`.
  - It must sort after the newest **committed** migration. As of authoring that is `apps/api/migrations/2026-10-25-130100-recovery-tokens-negotiated-capabilities.sql` (verified via `git ls-tree -r --name-only origin/main apps/api/migrations | sort | tail -1`). **Re-check before committing** and rename to sort after whatever is newest then — the repo's migration names run weeks ahead of real time by a compounding ratchet, so "today's date" does **not** sort last (CLAUDE.md, Schema Migration Workflow). The pre-push hook re-checks against `origin/main` and will reject a stale name.
  - `2026-08-06` is a CLOSED date block; do not touch it.
  - Idempotent (`ADD COLUMN IF NOT EXISTS`, `DROP CONSTRAINT IF EXISTS` then re-add inside `DO $$`). No inner `BEGIN;`/`COMMIT;`. Never edit a shipped migration — `2026-10-16-193500-tool-sources.sql` is shipped and immutable.
  - The migration writes **no rows**, so no `set_config('breeze.scope','system', true)` is required. If you end up adding any `UPDATE`/`INSERT`, that call becomes mandatory as the first statement (`migrationRlsScope.test.ts`, **Test API** job, carries a frozen baseline of 122 offenders — never add to it).
- **Registries.** `tool_sources` and `tool_source_tools` are already in `DUAL_AXIS_TENANT_TABLES` (`rls-coverage.integration.test.ts`), `CORE_ORG_CASCADE_DELETE_ORDER` (`services/tenantCascade.ts`, `tool_source_tools` then `tool_sources`), `orgMergeRegistry.ts` / `orgMergeCustomExecutors.ts`, and `encryptedColumnRegistry.ts`. **W02 adds no table, so those five lists need no edit.** W02 **does** add a column, which fires the one registration row that triggers on a column: `CORE_TENANT_EXPORT_POLICY` in `services/tenantExportPolicyRegistry.ts` must classify `spec_url` or `tenant-export-policy.integration.test.ts` and `tenantExportErasureRoundtrip.integration.test.ts` go red under **Integration Tests** — a job that a unit-green PR does not exercise locally (Task 3).
- **Names.** Source slug `^[a-z][a-z0-9]{1,23}$` (`TOOL_SOURCE_SLUG_RE`), operation tool name `^[a-zA-Z0-9_-]{1,64}$` (`SOURCE_TOOL_NAME_RE`), qualified name `<slug>__<name>` ≤ 64 (`QUALIFIED_TOOL_NAME_MAX`), split at the FIRST `__`. All three constants and `qualifiedToolName` / `splitQualifiedToolName` / `isTenantToolName` live in `packages/shared/src/validators/toolSources.ts` and are reused unchanged.
- **Feature flag.** No new flag. `TOOL_SOURCES_ENABLED` already 404s the whole router and resolves zero tenant tools when off (DECISION D13).
- **Egress.** Every outbound call — the spec fetch AND every operation call — goes through `services/urlSafety.ts` `safeFetch`, never bare `fetch`. `allowPrivateNetwork` is `toolSourcesAllowPrivateEgress()` from `config/env.ts`, which `config/validate.ts` already refuses when `IS_HOSTED=true`.
- **Branch / PR.** Branch `feature/5215-tool-catalog-flows/wave-5217` off `main`. **One PR**, targeting `main`, so it gets normal CI including the blocking `integration-test` job — do NOT hand-dispatch CI for it. Body: `Closes #5217`. Merge with bare `gh pr merge <N>` (merge queue owns the strategy; never `--admin`).
- **Rigor: high.** Credentials, egress, approvals, multi-tenant reads. Red test first for every task. Before the PR opens: the RLS/contract suites in Task 11 must have run against a real database.
- **Feature-lifecycle.** `get_feature_status` for #5215 first, then `start_wave` for #5217 before the first commit; `complete_wave` after merge.

---

## DECISIONS taken in this plan

The spec leaves these open or predates the as-built code. Each is settled here; an executor does not re-litigate them.

| # | Decision | Why |
|---|---|---|
| **D1** | **No spec-document upload in W02.** The spec's `spec_document jsonb` column is **not** created. A source points at a spec **URL** only. | Uploading needs a multipart route, a 5 MB jsonb blob that must be classified `excludedOpen` (a vendor document can embed example credentials), and a re-upload story for refreshes. A URL refetches on every discovery for free. Deferred; not a design reversal — adding `spec_document` later is additive. |
| **D2** | **`tool_sources.endpoint_url` holds the API BASE URL for an `openapi` source**, and a new nullable column `spec_url` holds the document URL. | `credential_origin` is derived from `endpoint_url` by `createToolSourceRow` (`service.ts:275`) / `updateToolSourceRow` (`service.ts:317`), unconditionally. Keeping `endpoint_url` = "the origin we send credentials to" means **zero change** to the pinning path, and the existing `toolSourcesPartnerRls` + credential-origin tests keep their meaning. Inverting it (spec URL in `endpoint_url`) would silently pin credentials to the documentation host. |
| **D3** | **W02 adds exactly one migration**, additive: `ALTER TABLE tool_sources ADD COLUMN IF NOT EXISTS spec_url text`, plus a CHECK `tool_sources_spec_url_kind_chk`: `(kind <> 'openapi' OR spec_url IS NOT NULL) AND (kind <> 'mcp' OR spec_url IS NULL)`. No new table, no enum change (`tool_source_kind` already has `'openapi'`). | Every existing row is `kind='mcp'` with `spec_url IS NULL`, so the CHECK validates immediately with no backfill and no batched `UPDATE`. |
| **D4** | **Operations always route to `endpoint_url` + the operation path. The spec's `servers[]` is recorded per-operation and NEVER used for routing.** A `servers[]` entry whose origin differs from `credential_origin` produces a discovery warning on the source (`last_error`, status stays `active`), not a redirect. | Spec §5.5 requires `servers[]` to match the pinned origin. Following `servers[]` would let a vendor document move a tenant's credential to another host by editing a JSON file we re-fetch on every discovery — an SSRF-with-credentials primitive. Routing from a column the tech typed is the only fail-closed option. |
| **D5** | **Tier mapping is fail-closed and reuses `proposeTier` unchanged.** The projector emits `annotations.readOnlyHint = true` for `GET`/`HEAD` only, and `annotations.destructiveHint = true` for `DELETE`. Every other verb (`POST`, `PUT`, `PATCH`, `TRACE`, anything unrecognised) yields `readOnlyHint` absent ⇒ `proposeTier` returns **3**. | `proposeTier(annotations)` (`discovery.ts:46`) already returns 3 unless `readOnlyHint === true && destructiveHint !== true`. Expressing the HTTP-verb rule as annotations means one tier function, one set of tests, and the spec's "GET/HEAD → 1, everything else → 3" holds by construction. `OPTIONS` is **not** projected at all (D8). |
| **D6** | **Supported auth schemes in W02 = the five `tool_source_auth_kind` values already on the row** (`none`, `bearer`, `api_key_header`, `basic`, `oauth2_client_credentials`). The document's own `securitySchemes` are **not** a credential source — the tech's configured `authKind` is applied to every operation. | Honouring `securitySchemes` would mean storing N credentials per source and a per-operation selection UI. One source = one credential is the W01 model and the MCP model. |
| **D7** | **Operations whose effective security requirement resolves to an `apiKey` scheme with `in: query` or `in: cookie`, or to `openIdConnect`, are REFUSED at discovery** (`skipped`, reason `unsupported_security_location`) rather than silently called with a header credential. | Breeze never puts a credential in a URL (it lands in vendor access logs and in our own `last_error` strings) or a cookie (no jar, no scoping). Refusing loudly is better than calling unauthenticated and surfacing a 401 as a tool result. |
| **D8** | **Only `get`, `head`, `post`, `put`, `patch`, `delete` are projected.** `options`, `trace` and any vendor extension key under a path item are skipped (reason `unsupported_method`). | `OPTIONS`/`TRACE` are protocol plumbing; projecting them produces tools no model should call and inflates the operation count against the 2,000 cap. |
| **D9** | **Parameter serialisation support is the defaults only.** `in: path` → `style: simple`, `explode: false`; `in: query` → `style: form`, `explode: true`; `in: header` → `style: simple`. Any operation declaring `deepObject`, `spaceDelimited`, `pipeDelimited`, `matrix` or `label`, or a non-default `explode`, or a `in: cookie` parameter, is skipped (reason `unsupported_param_style`). Request bodies: **`application/json` only**; `multipart/form-data`, `application/x-www-form-urlencoded` and `application/octet-stream` are skipped (reason `unsupported_request_body`). | Fail closed and visible. A partially-correct serialiser produces requests that succeed against one vendor and corrupt data against another; a `skipped` row with a reason is readable in the UI and fixable in a later wave. |
| **D10** | **OpenAPI 3.0.x and 3.1.x only.** A `swagger: "2.0"` document, or an `openapi` field that is absent or not `3.`-prefixed, fails discovery with `status='error'` and `last_error='unsupported_openapi_version: <value>'`. | 2.0 has a different parameter model (`body` parameters, `formData`, global `consumes`). Converting it is a separate piece of work, not a branch inside the projector. |
| **D11** | **Remote `$ref` is rejected; local `$ref` is dereferenced with an explicit cycle and depth guard.** Any `$ref` not starting with `#/` fails the whole discovery (`status='error'`, `last_error='remote_ref_rejected: <ref>'`). Local dereferencing is capped at depth 20 and 5,000 resolutions; a cycle resolves to `{}` with a `skipped` note rather than hanging. | Spec §5.3 mandates local-only. A remote `$ref` is a second, unpinned egress target — the same primitive D4 closes. |
| **D12** | **Size and complexity caps:** spec body ≤ **5 MB** (enforced by `safeFetch`'s `maxBytes`, so an oversize body is `ResponseTooLargeError`, never buffered); ≤ **2,000 operations** (spec §5.3); each generated `input_schema` ≤ **64 KB** serialised (an operation over it is skipped, reason `schema_too_large`); ≤ **100 parameters** per operation. | The first two are the spec's. The last two stop one pathological operation from poisoning a whole source's resolve — every enabled tool's schema is Ajv-compiled per resolve and shipped to the model in the tool list. |
| **D13** | **Refresh cadence: manual only in W02.** No scheduled re-discovery. `POST /api/v1/tool-sources/:id/discover` (shipped in W01) is the only refresh, plus the automatic enqueue on create and on endpoint/credential change. No new flag; `TOOL_SOURCES_ENABLED` gates everything. | An unattended refresh can raise a tool's effective tier to 3 (the never-lower rule) or flip a source to `error` at 03:00 with no operator present. Cadence deserves its own design (nightly sweep, backoff, notification) and is out of the W02 row in the roadmap. |
| **D14** | **No new npm dependency.** The dereferencer, the projector and the parameter serialiser are hand-rolled against `js-yaml` (already in `apps/api/package.json`) and `ajv`/`ajv-formats` (already used by `resolver.ts`). | Adding `swagger-parser`/`json-schema-ref-parser` pulls a transitive tree into the API image for ~200 lines of logic we need to constrain anyway (D11's local-only rule is not that library's default). This is the agent-shipped/image-shipped surface; CLAUDE.md's supply-chain posture argues against it. |
| **D15** | **Non-2xx responses are tool errors, not exceptions.** An operation returning a non-2xx status yields `{ isError: true }` with text `HTTP <status>: <redacted first 2 KB of body>`. Timeout 30 s and response cap 1 MB are the MCP client's existing constants, re-declared once in `openapiClient.ts`. | `executeTenantToolDetailed` already treats `isError` as the authoritative signal for chat's post-tool-use hook, the MCP `isError` reply and the audit row. Throwing would be caught by its outer `catch` and reported as a dispatch failure, losing the status code. |
| **D16** | **Operation → tool name:** `operationId` when present and matching `SOURCE_TOOL_NAME_RE` after replacing `.` and `/` with `_`; otherwise synthesised as `<method>_<path>` with `/`→`_`, `{param}`→`by_param`, non-`[A-Za-z0-9_-]` stripped, collapsed underscores, lowercased, truncated to fit `QUALIFIED_TOOL_NAME_MAX` minus `<slug>__`. A collision after synthesis gets a `_2`, `_3` … suffix in document order; a name that still cannot fit is skipped (reason `name_not_addressable`). | W01's `tool_source_tools_source_name_uq` is a hard unique index on `(source_id, name)`; a collision would abort the whole discovery transaction. Deterministic ordering keeps a re-discovery from reshuffling suffixes and churning every revision. |

---

## File Structure

New files are small and single-responsibility, matching the `services/toolSources/` layout W01 established.

**packages/shared**
- Modify `src/validators/toolSources.ts` — widen `sourceCore.kind` to `z.enum(['mcp','openapi'])`, add `specUrl`, add the kind/specUrl cross-field refinement to all four exported source schemas.
- Modify `src/validators/toolSources.test.ts` — the W02 cases.
- Modify `src/types/toolSources.ts` — `ToolSourceDto.specUrl: string | null`.

**apps/api — data**
- Create `migrations/2026-10-26-090000-tool-sources-openapi-spec-url.sql`.
- Modify `src/db/schema/toolSources.ts` — `specUrl` column.
- Modify `src/db/schema/toolSources.test.ts` — assert the column and the CHECK name.
- Modify `src/services/tenantExportPolicyRegistry.ts` — classify `spec_url`.

**apps/api — services/toolSources/** (new)
- `authHeaders.ts` (+ `.test.ts`) — `buildToolSourceAuthHeaders()`, extracted from `McpClient.buildAuthHeaders` so both transports pin identically.
- `openapiSpec.ts` (+ `.test.ts`) — fetch, parse (JSON or YAML), version gate, local-only `$ref` dereference.
- `openapiProjection.ts` (+ `.test.ts`) — document → `ProjectedOperation[]` (+ skip reasons), naming, schema translation, annotations.
- `openapiClient.ts` (+ `.test.ts`) — `OpenApiClient.callOperation()`: input → HTTP request → result text.
- `__fixtures__/petstore.json`, `__fixtures__/halo-like.yaml`, `__fixtures__/remote-ref.json` — the three fixtures spec §9 names.

**apps/api — services/toolSources/** (modified)
- `mcpClient.ts` — `buildAuthHeaders` delegates to `authHeaders.ts` (pure refactor).
- `discovery.ts` — `kind` branch producing the listing array; everything after is untouched.
- `execute.ts` — `kind` branch choosing the client.
- `resolver.ts` — `sourceKind: 'mcp' | 'openapi'`, selected from the joined row.
- `service.ts` — `spec_url` through create/update/DTO; `ToolSourceDto.specUrl`.

**apps/api — routes**
- `src/routes/toolSources.ts` (+ `.test.ts`) — no new endpoint; the create/update validators now accept `openapi`.

**apps/web**
- Modify `src/components/toolSources/ToolSourceForm.tsx` (+ `.test.tsx`) — live `kind` state, conditional spec-URL field, kind-dependent labels.
- Modify `src/components/toolSources/api.ts` (+ `.test.ts`) — `specUrl` in the create/update bodies.
- Modify `src/components/toolSources/DiscoveredToolsTable.tsx` (+ `.test.tsx`) — method/path column for openapi tools.
- Modify `src/components/toolSources/ToolSourcesPage.tsx` — kind badge reads the real kind.
- Modify `src/locales/{en,de-DE,es-419,fr-CA,fr-FR,it-IT,pt-BR,tr-TR}/toolSources.json` — new keys, `form.kindOpenapiSoon` removed.

**apps/docs**
- Modify `src/content/docs/features/tool-sources.mdx` — an OpenAPI section.

**Do-not-touch list (every task).** These files are load-bearing for W01 and for waves W03–W06 and must not be edited by this wave: `services/toolSources/guardrails.ts`, `services/toolSources/sdkBridge.ts`, `services/aiGuardrails.ts`, `services/aiAgentSdk.ts`, `services/streamingSessionManager.ts`, `routes/mcpServer.ts`, `services/actionIntents/*`, `services/tenantCascade.ts`, `services/orgMergeRegistry.ts`, `services/orgMergeCustomExecutors.ts`, `services/encryptedColumnRegistry.ts`, `jobs/toolSourceDiscoveryWorker.ts`, `migrations/2026-10-16-193500-tool-sources.sql`, and `src/__tests__/integration/rls-coverage.integration.test.ts`. If a task appears to need one of them, stop and report — it means a decision above is wrong.

### File ownership (for a parallel wave)

Tasks 5, 6 and 7 are the only ones that could run concurrently after Task 4, and each owns disjoint files:

| Task | Owns exclusively | Consumes (read-only) |
|---|---|---|
| 5 | `openapiSpec.ts`, `openapiSpec.test.ts`, `__fixtures__/*` | `authHeaders.ts`, `urlSafety.ts` |
| 6 | `openapiProjection.ts`, `openapiProjection.test.ts` | `openapiSpec.ts` types, `__fixtures__/*` |
| 7 | `openapiClient.ts`, `openapiClient.test.ts` | `authHeaders.ts`, `openapiProjection.ts` types |
| 8 | `discovery.ts`, `execute.ts`, `resolver.ts` (+ their tests) | 5, 6, 7 |

Tasks 1–4 and 8–11 are strictly sequential. Nothing outside the table's "owns" column may be edited by that task.

---

## Task 1: Spec amendments

**Files:**
- Modify: `docs/superpowers/specs/ai-mcp/2026-09-07-tool-catalog-and-flows-design.md` (§5.2, §5.3, §5.5, §11)

The roadmap's W02 row and the `ai-mcp/` count in `docs/superpowers/plans/README.md` already link this plan — they landed with the plan's own docs PR. Do not touch them again.

- [ ] **Step 1: Add the W02 amendment call-outs to the spec.** In **§5.2**, under the `tool_sources` table, append:

```markdown
**Amendment (W2 plan, 2026-09-21):** the `spec_document jsonb` and `base_url_override text` rows above are superseded and are NOT created. An `openapi` source stores the **API base URL** in `endpoint_url` (so `credential_origin` derivation and pinning are unchanged from the MCP path) and the document URL in a new nullable column `spec_url text`, guarded by `tool_sources_spec_url_kind_chk` (`kind <> 'openapi' OR spec_url IS NOT NULL`, and `kind <> 'mcp' OR spec_url IS NULL`). Document upload is deferred; a URL re-fetches on every discovery.
```

In **§5.3**, under the OpenAPI bullet, append:

```markdown
**Amendment (W2 plan, 2026-09-21):** tier proposal is expressed as annotations rather than a second tier function — the projector emits `readOnlyHint: true` for `GET`/`HEAD` and `destructiveHint: true` for `DELETE`, so the existing `proposeTier(annotations)` returns 1 for reads and 3 for everything else with no change. `OPTIONS`/`TRACE` are not projected. Operations are skipped (recorded, disabled, with a reason) rather than approximated when they use a non-default parameter `style`/`explode`, a cookie parameter, a non-JSON request body, an `apiKey` security scheme `in: query`/`in: cookie`, `openIdConnect`, or a generated schema over 64 KB. OpenAPI 3.0.x/3.1.x only; Swagger 2.0 is refused. Re-discovery is manual in W2 — there is no scheduled refresh.
```

In **§5.5**, under the OpenAPI bullet, append:

```markdown
**Amendment (W2 plan, 2026-09-21):** `servers[]` is never used for routing. Every operation is sent to `endpoint_url` + the operation path; a `servers[]` entry whose origin differs from `credential_origin` is recorded as a discovery warning on the source and nothing more. Following `servers[]` would let a re-fetched vendor document redirect a tenant's credential to another host. The spec document itself is fetched through `safeFetch` and carries the source credential **only** when the spec URL's origin equals `credential_origin`; otherwise it is fetched anonymously (never with the credential attached). The auth-header builder is shared with the MCP client (`services/toolSources/authHeaders.ts`) so both transports pin identically.
```

In **§11**, append a row to the table:

```markdown
| — | Plan amendments (W2) | N/A — as-built decisions from the W2 plan (`docs/superpowers/plans/ai-mcp/2026-09-21-tool-catalog-w2-openapi-source-kind.md`), not a quorum question. | Accepted: `spec_url` column replaces `spec_document`/`base_url_override` (§5.2); `endpoint_url` is the API base URL for openapi sources so credential pinning is unchanged (§5.2, §5.5); `servers[]` never routes (§5.5); tier mapping via annotations reuses `proposeTier` (§5.3); unsupported parameter styles/bodies/security locations are skipped with a reason rather than approximated (§5.3); 3.0.x/3.1.x only; refresh is manual in W2 (§5.3). |
```

- [ ] **Step 2: Commit**

```bash
git add docs/superpowers/specs/ai-mcp/2026-09-07-tool-catalog-and-flows-design.md
git commit -m "docs(specs): W2 as-built amendments — spec_url column, servers[] never routes, annotation-driven tiers"
```

---

## Task 2: Shared validators, types

**Files:**
- Modify: `packages/shared/src/validators/toolSources.ts`
- Modify: `packages/shared/src/validators/toolSources.test.ts`
- Modify: `packages/shared/src/types/toolSources.ts`

**Interfaces:**
- Consumes: `TOOL_SOURCE_SLUG_RE`, `RESERVED_TOOL_SOURCE_SLUGS`, `toolSourceAuthConfigSchema`, `httpsUrl` (module-local) — all already in this file.
- Produces:
```ts
// validators/toolSources.ts — sourceCore gains two fields and a cross-field rule
//   kind: z.enum(['mcp', 'openapi'])
//   specUrl: z.string().url().optional()   // https-only in the default schemas
// Applied to all four exported source schemas via a shared refinement:
export const TOOL_SOURCE_KINDS: readonly ['mcp', 'openapi'];
// types/toolSources.ts
export interface ToolSourceDto { /* …existing fields… */ specUrl: string | null }
```

- [ ] **Step 1: Write the failing tests.** Append to `packages/shared/src/validators/toolSources.test.ts`:

```ts
describe('toolSources validators — openapi kind (W2)', () => {
  const openapiBase = {
    name: 'Halo',
    slug: 'halo',
    kind: 'openapi' as const,
    endpointUrl: 'https://api.halo.example/v1',
    specUrl: 'https://api.halo.example/v1/openapi.json',
    authKind: 'bearer' as const,
    authConfig: { token: 'abc' },
  };

  it('accepts an openapi source with an https spec URL', () => {
    expect(createToolSourceSchema.safeParse(openapiBase).success).toBe(true);
  });

  it('rejects an openapi source with no specUrl', () => {
    const { specUrl: _omitted, ...withoutSpec } = openapiBase;
    expect(createToolSourceSchema.safeParse(withoutSpec).success).toBe(false);
  });

  it('rejects an mcp source that supplies a specUrl', () => {
    expect(
      createToolSourceSchema.safeParse({
        name: 'Hudu', slug: 'hudu', kind: 'mcp',
        endpointUrl: 'https://mcp.hudu.example/mcp',
        specUrl: 'https://mcp.hudu.example/openapi.json',
        authKind: 'none',
      }).success,
    ).toBe(false);
  });

  it('rejects an http specUrl in the https-only schema and accepts it in the http variant', () => {
    const httpSpec = { ...openapiBase, endpointUrl: 'http://api.halo.local/v1', specUrl: 'http://api.halo.local/v1/openapi.json' };
    expect(createToolSourceSchema.safeParse(httpSpec).success).toBe(false);
    expect(createToolSourceSchemaWithHttp.safeParse(httpSpec).success).toBe(true);
  });

  it('still rejects an unknown kind', () => {
    expect(createToolSourceSchema.safeParse({ ...openapiBase, kind: 'graphql' }).success).toBe(false);
  });

  it('update schema omits kind but accepts a new specUrl', () => {
    expect(updateToolSourceSchema.safeParse({ specUrl: 'https://api.halo.example/v2/openapi.json' }).success).toBe(true);
    expect(updateToolSourceSchema.safeParse({ kind: 'mcp' }).success).toBe(false);
  });
});
```

Note the last case: `updateToolSourceSchema` is built from `sourceCore.omit({ slug, kind, ownerScope, orgId }).partial()`, and `z.object` strips unknown keys rather than rejecting them — so `{ kind: 'mcp' }` parses today. Make it fail by adding `.strict()` to the omitted-and-partialled object before the intersection; that is the assertion the test is buying.

- [ ] **Step 2: Run to verify failure**

Run: `cd packages/shared && npx vitest run src/validators/toolSources.test.ts`
Expected: FAIL — the first case fails on `kind: z.literal('mcp')`, the `specUrl` cases fail on the key being stripped.

- [ ] **Step 3: Implement.** In `packages/shared/src/validators/toolSources.ts`:

```ts
export const TOOL_SOURCE_KINDS = ['mcp', 'openapi'] as const;

const sourceCore = z.object({
  name: z.string().min(1).max(120),
  slug: z.string().regex(TOOL_SOURCE_SLUG_RE).refine((s) => !RESERVED_TOOL_SOURCE_SLUGS.has(s), 'reserved slug'),
  kind: z.enum(TOOL_SOURCE_KINDS),
  endpointUrl: httpsUrl,
  // W2: the OpenAPI document URL. `endpointUrl` stays the API BASE url, so
  // `credentialOriginFor(endpointUrl)` keeps pinning credentials to the API
  // host rather than to wherever the documentation happens to be served.
  specUrl: httpsUrl.optional(),
  rateLimitPerMinute: z.number().int().min(1).max(6000).default(120),
  ownerScope: z.enum(['organization', 'partner']).optional(),
  orgId: z.string().uuid().optional(),
});

/** `openapi` needs a document; `mcp` must not carry one. */
const kindSpecUrlRule = (v: { kind?: string; specUrl?: string }, ctx: z.RefinementCtx) => {
  if (v.kind === 'openapi' && !v.specUrl) {
    ctx.addIssue({ code: 'custom', path: ['specUrl'], message: 'an openapi source requires a spec URL' });
  }
  if (v.kind === 'mcp' && v.specUrl) {
    ctx.addIssue({ code: 'custom', path: ['specUrl'], message: 'an mcp source must not have a spec URL' });
  }
};
```

Apply `.superRefine(kindSpecUrlRule)` to `createToolSourceSchema` and `createToolSourceSchemaWithHttp` (the update schemas omit `kind`, so the rule cannot fire there — the route re-checks against the stored row instead, Task 9). Add `specUrl` to the `sourceCoreWithHttp` extension with the same http-or-https refinement `endpointUrl` uses there. Add `.strict()` to the omitted object inside both update schemas. In `packages/shared/src/types/toolSources.ts`, add `specUrl: string | null;` to `ToolSourceDto` directly after `endpointUrl`, and delete the stale `// 'openapi' arrives in W2; schema rejects it in W1` comment on `ToolSourceKind`.

- [ ] **Step 4: Run to verify it passes**

Run: `cd packages/shared && npx vitest run src/validators/toolSources.test.ts && npx tsc --noEmit -p tsconfig.json && pnpm lint`
Expected: PASS, clean.

- [ ] **Step 5: Commit**

```bash
git add packages/shared/src/validators/toolSources.ts packages/shared/src/validators/toolSources.test.ts packages/shared/src/types/toolSources.ts
git commit -m "feat(shared): accept the openapi tool-source kind and its spec URL"
```

---

## Task 3: Migration, Drizzle column, export-policy classification

**Files:**
- Create: `apps/api/migrations/2026-10-26-090000-tool-sources-openapi-spec-url.sql`
- Modify: `apps/api/src/db/schema/toolSources.ts`, `apps/api/src/db/schema/toolSources.test.ts`
- Modify: `apps/api/src/services/tenantExportPolicyRegistry.ts`

**Interfaces:**
- Produces: `toolSources.specUrl` (Drizzle column `spec_url`), consumed by Tasks 5, 8 and 9.

- [ ] **Step 1: Write the failing tests.** Append to `apps/api/src/db/schema/toolSources.test.ts`:

```ts
it('tool_sources carries the W2 spec_url column', () => {
  expect(toolSources.specUrl.name).toBe('spec_url');
  expect(toolSources.specUrl.notNull).toBe(false);
});
```

and add a red assertion to the export-policy registry's own guard by running the registry suite (Step 2) — the registry test derives the column list from the Drizzle schema, so adding the column is what makes it red.

- [ ] **Step 2: Run to verify failure**

Run: `cd apps/api && npx vitest run src/db/schema/toolSources.test.ts`
Expected: FAIL with "Property 'specUrl' does not exist".

- [ ] **Step 3: Write the migration.** `apps/api/migrations/2026-10-26-090000-tool-sources-openapi-spec-url.sql`:

```sql
-- Tool Catalog W02 (#5215 / #5217) — OpenAPI source kind.
-- Spec: docs/superpowers/specs/ai-mcp/2026-09-07-tool-catalog-and-flows-design.md §5.2 (W2 amendment).
--
-- `tool_source_kind` already contains 'openapi' (2026-10-16-193500-tool-sources.sql),
-- so this file is purely additive: the document URL for an openapi source.
-- `endpoint_url` keeps its W01 meaning — the origin credentials are pinned to —
-- and for an openapi source that is the API BASE url, never the document host.
--
-- No DML: every existing row is kind='mcp' with spec_url NULL, so the CHECK
-- validates immediately and no `set_config('breeze.scope','system')` is needed.

ALTER TABLE tool_sources ADD COLUMN IF NOT EXISTS spec_url text;

DO $$
BEGIN
  ALTER TABLE tool_sources DROP CONSTRAINT IF EXISTS tool_sources_spec_url_kind_chk;
  ALTER TABLE tool_sources ADD CONSTRAINT tool_sources_spec_url_kind_chk
    CHECK (
      (kind <> 'openapi' OR spec_url IS NOT NULL)
      AND (kind <> 'mcp' OR spec_url IS NULL)
    );
END $$;

COMMENT ON COLUMN tool_sources.spec_url IS
  'OpenAPI document URL (openapi kind only). Operations route to endpoint_url, never to the document''s servers[].';
```

**Before committing, re-check the sort position:**

```bash
git ls-tree -r --name-only origin/main apps/api/migrations | grep -v / | sort | tail -1
```

If anything newer than `2026-10-25-130100-…` has landed, rename this file to sort after it and update the two test references in Task 11.

- [ ] **Step 4: Add the Drizzle column.** In `apps/api/src/db/schema/toolSources.ts`, immediately after `credentialOrigin`:

```ts
    /** W2: OpenAPI document URL; NULL for mcp sources (tool_sources_spec_url_kind_chk). */
    specUrl: text('spec_url'),
```

- [ ] **Step 5: Classify the new column in the export policy.** In `apps/api/src/services/tenantExportPolicyRegistry.ts`, the `tool_sources` entry's `included` array gains `"spec_url"` immediately after `"endpoint_url"`. It is `included`, not `reviewedIncluded`: it is a URL with the same disclosure profile as `endpoint_url` (already `included`), its name matches no entry in `SUSPICIOUS_NAME_PARTS`, and it is `text`, not `json`/`jsonb`/`bytea`, so the `excludedOpen` rule does not apply.

**This is the step that gets missed.** CLAUDE.md's export-policy row is the only registration that fires on a **new column** of an already-registered table, and it fails only under **Integration Tests** — a unit-green PR goes red on main. `tool_sources` is in `CORE_ORG_CASCADE_DELETE_ORDER`, so it is in scope. Verify mechanically, do not eyeball:

```bash
grep -n 'spec_url' apps/api/src/services/tenantExportPolicyRegistry.ts
```

No other list changes: W02 adds no table, so `CORE_ORG_CASCADE_DELETE_ORDER`, `DUAL_AXIS_TENANT_TABLES`, `CORE_DEVICE_CASCADE_DELETE_TABLES`, `TICKET_ORG_DENORMALIZED_TABLES`, `AUDIT_ADMIN_REQUIRED_TABLES`, `orgMergeRegistry.ts` and `encryptedColumnRegistry.ts` are all untouched.

- [ ] **Step 6: Run to verify it passes**

```bash
cd apps/api && npx vitest run src/db/schema/toolSources.test.ts src/db/autoMigrate.test.ts src/db/migrationRlsScope.test.ts
export DATABASE_URL="postgresql://breeze:breeze@localhost:5432/breeze" && pnpm db:migrate && pnpm db:check-drift
```
Expected: PASS; `db:check-drift` reports no drift.

- [ ] **Step 7: Commit**

```bash
git add apps/api/migrations/2026-10-26-090000-tool-sources-openapi-spec-url.sql \
        apps/api/src/db/schema/toolSources.ts apps/api/src/db/schema/toolSources.test.ts \
        apps/api/src/services/tenantExportPolicyRegistry.ts
git commit -m "feat(api): tool_sources.spec_url for openapi sources + export-policy classification"
```

---

## Task 4: Shared auth-header builder (refactor `McpClient`)

**Files:**
- Create: `apps/api/src/services/toolSources/authHeaders.ts`, `apps/api/src/services/toolSources/authHeaders.test.ts`
- Modify: `apps/api/src/services/toolSources/mcpClient.ts` (`buildAuthHeaders`, ~line 207)

**Interfaces:**
- Consumes: `ToolSourceAuthConfig` from `./secrets`, `getOAuth2ClientCredentialsToken` from `./mcpClient`, `SafeFetchInit` from `../urlSafety`.
- Produces:
```ts
export type OriginMismatchBehaviour = 'throw' | 'omit';
export class ToolSourceAuthError extends Error { constructor(message: string, readonly code: 'origin_mismatch') }
export async function buildToolSourceAuthHeaders(
  auth: ToolSourceAuthConfig,
  targetUrl: string,
  credentialOrigin: string,
  opts?: {
    onOriginMismatch?: OriginMismatchBehaviour;   // default 'throw'
    fetchImpl?: (url: string, init: SafeFetchInit) => Promise<Response>;
  },
): Promise<Record<string, string>>;
```

Why this exists: `McpClient.buildAuthHeaders` is private, and W02's HTTP executor and spec fetcher need byte-identical pinning. Duplicating it is how the two transports drift apart, and drift here means a credential leaves for an origin it was never pinned to. The spec fetch is the one caller that passes `'omit'` — a spec served from a different host than the API is fetched anonymously rather than failing the whole discovery (DECISION D2/§5.5 amendment).

- [ ] **Step 1: Write the failing test.** `apps/api/src/services/toolSources/authHeaders.test.ts`:

```ts
import { describe, expect, it, vi } from 'vitest';
import { buildToolSourceAuthHeaders, ToolSourceAuthError } from './authHeaders';

const ORIGIN = 'https://api.example.com';
const URL_ON_ORIGIN = 'https://api.example.com/v1/pets';
const URL_OFF_ORIGIN = 'https://docs.example.net/openapi.json';

describe('buildToolSourceAuthHeaders', () => {
  it('returns no headers for authKind none', async () => {
    expect(await buildToolSourceAuthHeaders({ authKind: 'none' }, URL_ON_ORIGIN, ORIGIN)).toEqual({});
  });

  it('builds bearer, api-key-header and basic headers on a matching origin', async () => {
    expect(await buildToolSourceAuthHeaders({ authKind: 'bearer', token: 't' }, URL_ON_ORIGIN, ORIGIN))
      .toEqual({ Authorization: 'Bearer t' });
    expect(await buildToolSourceAuthHeaders({ authKind: 'api_key_header', headerName: 'X-Api-Key', value: 'k' }, URL_ON_ORIGIN, ORIGIN))
      .toEqual({ 'X-Api-Key': 'k' });
    expect(await buildToolSourceAuthHeaders({ authKind: 'basic', username: 'u', password: 'p' }, URL_ON_ORIGIN, ORIGIN))
      .toEqual({ Authorization: `Basic ${Buffer.from('u:p').toString('base64')}` });
  });

  it('throws origin_mismatch by default when the target is off-origin', async () => {
    await expect(buildToolSourceAuthHeaders({ authKind: 'bearer', token: 't' }, URL_OFF_ORIGIN, ORIGIN))
      .rejects.toBeInstanceOf(ToolSourceAuthError);
  });

  it('omits the credential instead of throwing when asked to', async () => {
    expect(
      await buildToolSourceAuthHeaders({ authKind: 'bearer', token: 't' }, URL_OFF_ORIGIN, ORIGIN, { onOriginMismatch: 'omit' }),
    ).toEqual({});
  });

  it('treats a port difference as a different origin', async () => {
    await expect(
      buildToolSourceAuthHeaders({ authKind: 'bearer', token: 't' }, 'https://api.example.com:8443/v1', ORIGIN),
    ).rejects.toBeInstanceOf(ToolSourceAuthError);
  });

  it('exchanges oauth2 client credentials and sends the access token', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(
      new Response(JSON.stringify({ access_token: 'at', expires_in: 3600 }), { status: 200, headers: { 'content-type': 'application/json' } }),
    );
    const headers = await buildToolSourceAuthHeaders(
      { authKind: 'oauth2_client_credentials', tokenUrl: 'https://id.example.com/token', clientId: 'a', clientSecret: 'b' },
      URL_ON_ORIGIN, ORIGIN, { fetchImpl },
    );
    expect(headers).toEqual({ Authorization: 'Bearer at' });
  });
});
```

Add a matching red case to `apps/api/src/services/toolSources/mcpClient.test.ts` asserting the existing `origin_mismatch` behaviour still surfaces as `McpClientError` with code `'origin_mismatch'` after the refactor — the refactor must not change the error type callers already branch on.

- [ ] **Step 2: Run to verify failure**

Run: `cd apps/api && npx vitest run src/services/toolSources/authHeaders.test.ts`
Expected: FAIL — "Failed to resolve import './authHeaders'".

- [ ] **Step 3: Implement.** `authHeaders.ts` holds the body of today's `McpClient.buildAuthHeaders` (`mcpClient.ts` ~207-240) verbatim, with the mismatch branch parameterised:

```ts
if (new URL(targetUrl).origin !== credentialOrigin) {
  if ((opts?.onOriginMismatch ?? 'throw') === 'omit') return {};
  throw new ToolSourceAuthError(
    `refusing to attach credentials: target origin does not match the credential's origin (${credentialOrigin})`,
    'origin_mismatch',
  );
}
```

Then `McpClient.buildAuthHeaders` becomes:

```ts
private async buildAuthHeaders(): Promise<Record<string, string>> {
  const { auth, endpointUrl, credentialOrigin } = this.opts;
  try {
    return await buildToolSourceAuthHeaders(auth, endpointUrl, credentialOrigin, { fetchImpl: this.fetchImpl });
  } catch (err) {
    if (err instanceof ToolSourceAuthError) throw new McpClientError(err.message, 'origin_mismatch');
    throw err;
  }
}
```

`getOAuth2ClientCredentialsToken` stays exported from `mcpClient.ts` (it owns the module-level token cache); `authHeaders.ts` imports it. Do **not** move the cache — moving it invalidates every cached token on deploy for no gain and touches a file this task does not own.

- [ ] **Step 4: Run to verify it passes**

Run: `cd apps/api && npx vitest run src/services/toolSources/authHeaders.test.ts src/services/toolSources/mcpClient.test.ts`
Expected: PASS, both files.

- [ ] **Step 5: Commit**

```bash
git add apps/api/src/services/toolSources/authHeaders.ts apps/api/src/services/toolSources/authHeaders.test.ts apps/api/src/services/toolSources/mcpClient.ts apps/api/src/services/toolSources/mcpClient.test.ts
git commit -m "refactor(api): share the tool-source auth header builder between transports"
```

---

## Task 5: OpenAPI spec fetcher, parser and local-only dereferencer

**Files:**
- Create: `apps/api/src/services/toolSources/openapiSpec.ts`, `apps/api/src/services/toolSources/openapiSpec.test.ts`
- Create: `apps/api/src/services/toolSources/__fixtures__/petstore.json`, `__fixtures__/halo-like.yaml`, `__fixtures__/remote-ref.json`

**Interfaces:**
- Consumes: `buildToolSourceAuthHeaders` (Task 4), `safeFetch`/`ResponseTooLargeError` from `../urlSafety`, `ToolSourceAuthConfig` from `./secrets`, `js-yaml`.
- Produces:
```ts
export const MAX_SPEC_BYTES = 5_242_880;          // 5 MB (spec §5.3)
export const MAX_DEREF_DEPTH = 20;
export const MAX_DEREF_RESOLUTIONS = 5_000;

export type OpenApiDocument = Record<string, unknown>;

export class OpenApiSpecError extends Error {
  constructor(message: string, readonly code:
    'transport' | 'too_large' | 'parse' | 'unsupported_version' | 'remote_ref' | 'deref_limit');
}

export interface FetchSpecOptions {
  specUrl: string;
  credentialOrigin: string;
  auth: ToolSourceAuthConfig;
  allowPrivateNetwork?: boolean;
  fetchImpl?: (url: string, init: SafeFetchInit) => Promise<Response>;   // default safeFetch
  timeoutMs?: number;                                                    // default 30_000
}

/** Fetches, parses (JSON or YAML), version-gates and fully dereferences. */
export async function fetchOpenApiDocument(opts: FetchSpecOptions): Promise<OpenApiDocument>;

/** Exported for tests and for a future upload path: parse + gate + deref, no I/O. */
export function parseOpenApiDocument(body: string): OpenApiDocument;
export function dereferenceLocal(doc: OpenApiDocument): OpenApiDocument;
```

Behaviour, in order:
1. `buildToolSourceAuthHeaders(auth, specUrl, credentialOrigin, { onOriginMismatch: 'omit' })` — an off-origin document is fetched anonymously (D2).
2. `fetchImpl(specUrl, { method: 'GET', headers: { Accept: 'application/json, application/yaml, text/yaml, text/plain' , ...authHeaders }, timeoutMs, maxBytes: MAX_SPEC_BYTES, allowPrivateNetwork })`. A `ResponseTooLargeError` becomes `code: 'too_large'`; any other throw becomes `'transport'`; a non-2xx becomes `'transport'` with the status in the message.
3. Parse: try `JSON.parse`; on failure `yaml.load` with `{ schema: yaml.FAILSAFE_SCHEMA, json: true }` — **content is sniffed, never trusted from `Content-Type`** (vendors serve YAML as `text/plain` and JSON as `application/octet-stream` routinely). A non-object result is `'parse'`.
4. Version gate: `doc.swagger` present, or `typeof doc.openapi !== 'string'`, or not `doc.openapi.startsWith('3.')` ⇒ `'unsupported_version'` with the offending value in the message (D10).
5. `dereferenceLocal`: walk the document; for every object with a `$ref` string, reject it as `'remote_ref'` unless it starts with `#/`; resolve the JSON pointer against the root (URI-decoding `~1`→`/`, `~0`→`~`); replace the node with the resolved value **merged with any sibling keys** (3.1 allows `$ref` siblings). Track a resolution counter and a recursion depth; exceeding either is `'deref_limit'`. A pointer already on the current resolution path (a cycle) resolves to `{}` rather than recursing.

Fixtures: `petstore.json` is the canonical 3.0 Petstore trimmed to four operations (`GET /pets`, `POST /pets`, `GET /pets/{petId}`, `DELETE /pets/{petId}`) with a `#/components/schemas/Pet` `$ref` used from both a response and a request body. `halo-like.yaml` is a 3.1 YAML document with: two operations missing `operationId`, one operation with a `deepObject` query parameter, one with a `multipart/form-data` body, one with a cookie parameter, and an `apiKey`-`in: query` security scheme on one operation — i.e. one instance of every D7/D9 skip reason. `remote-ref.json` is a 3.0 document with a single `"$ref": "https://evil.example/schemas/Pet.json"`.

- [ ] **Step 1: Write the failing tests.** `openapiSpec.test.ts`:

```ts
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import {
  fetchOpenApiDocument, parseOpenApiDocument, dereferenceLocal, OpenApiSpecError, MAX_SPEC_BYTES,
} from './openapiSpec';

const fixture = (name: string) => readFileSync(join(__dirname, '__fixtures__', name), 'utf8');
const ok = (body: string) => new Response(body, { status: 200, headers: { 'content-type': 'application/json' } });

describe('parseOpenApiDocument', () => {
  it('parses JSON and YAML documents alike', () => {
    expect(parseOpenApiDocument(fixture('petstore.json')).openapi).toMatch(/^3\.0/);
    expect(parseOpenApiDocument(fixture('halo-like.yaml')).openapi).toMatch(/^3\.1/);
  });
  it('rejects swagger 2.0 and a missing version', () => {
    expect(() => parseOpenApiDocument('{"swagger":"2.0","paths":{}}')).toThrow(/unsupported_version|2\.0/);
    expect(() => parseOpenApiDocument('{"paths":{}}')).toThrow(OpenApiSpecError);
  });
  it('rejects a body that is neither JSON nor YAML object', () => {
    expect(() => parseOpenApiDocument('<html>nope</html>')).toThrow(OpenApiSpecError);
  });
});

describe('dereferenceLocal', () => {
  it('inlines a local $ref and keeps sibling keys', () => {
    const doc = dereferenceLocal({
      openapi: '3.1.0',
      components: { schemas: { Pet: { type: 'object', properties: { id: { type: 'string' } } } } },
      x: { $ref: '#/components/schemas/Pet', description: 'a pet' },
    });
    expect((doc.x as Record<string, unknown>).type).toBe('object');
    expect((doc.x as Record<string, unknown>).description).toBe('a pet');
  });
  it('rejects a remote $ref', () => {
    expect(() => dereferenceLocal(JSON.parse(fixture('remote-ref.json'))))
      .toThrow(/remote_ref/);
  });
  it('resolves a cycle to an empty schema instead of hanging', () => {
    const doc = dereferenceLocal({
      openapi: '3.0.3',
      components: { schemas: { Node: { type: 'object', properties: { next: { $ref: '#/components/schemas/Node' } } } } },
      x: { $ref: '#/components/schemas/Node' },
    });
    const next = ((doc.x as any).properties as any).next;
    expect(next).toEqual({});
  });
});

describe('fetchOpenApiDocument', () => {
  it('sends the credential when the spec is on the pinned origin', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(ok(fixture('petstore.json')));
    await fetchOpenApiDocument({
      specUrl: 'https://api.example.com/openapi.json', credentialOrigin: 'https://api.example.com',
      auth: { authKind: 'bearer', token: 'tok' }, fetchImpl,
    });
    expect(fetchImpl.mock.calls[0][1].headers.Authorization).toBe('Bearer tok');
    expect(fetchImpl.mock.calls[0][1].maxBytes).toBe(MAX_SPEC_BYTES);
  });

  it('omits the credential when the spec is served off-origin', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(ok(fixture('petstore.json')));
    await fetchOpenApiDocument({
      specUrl: 'https://docs.example.net/openapi.json', credentialOrigin: 'https://api.example.com',
      auth: { authKind: 'bearer', token: 'tok' }, fetchImpl,
    });
    expect(fetchImpl.mock.calls[0][1].headers.Authorization).toBeUndefined();
  });

  it('maps an oversize body and a non-2xx to typed errors', async () => {
    const tooBig = vi.fn().mockRejectedValue(Object.assign(new Error('too big'), { name: 'ResponseTooLargeError' }));
    await expect(fetchOpenApiDocument({ specUrl: 'https://api.example.com/o.json', credentialOrigin: 'https://api.example.com', auth: { authKind: 'none' }, fetchImpl: tooBig }))
      .rejects.toMatchObject({ code: 'too_large' });
    const notFound = vi.fn().mockResolvedValue(new Response('nope', { status: 404 }));
    await expect(fetchOpenApiDocument({ specUrl: 'https://api.example.com/o.json', credentialOrigin: 'https://api.example.com', auth: { authKind: 'none' }, fetchImpl: notFound }))
      .rejects.toMatchObject({ code: 'transport' });
  });
});
```

- [ ] **Step 2: Run to verify failure**

Run: `cd apps/api && npx vitest run src/services/toolSources/openapiSpec.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement** `openapiSpec.ts` and the three fixtures exactly as specified above.

- [ ] **Step 4: Run to verify it passes**

Run: `cd apps/api && npx vitest run src/services/toolSources/openapiSpec.test.ts`
Expected: PASS (11 tests).

- [ ] **Step 5: Commit**

```bash
git add apps/api/src/services/toolSources/openapiSpec.ts apps/api/src/services/toolSources/openapiSpec.test.ts apps/api/src/services/toolSources/__fixtures__
git commit -m "feat(api): OpenAPI spec fetch, parse and local-only dereference"
```

---

## Task 6: Operation → tool projection

**Files:**
- Create: `apps/api/src/services/toolSources/openapiProjection.ts`, `apps/api/src/services/toolSources/openapiProjection.test.ts`

**Interfaces:**
- Consumes: `OpenApiDocument` (Task 5), `SOURCE_TOOL_NAME_RE`, `QUALIFIED_TOOL_NAME_MAX`, `qualifiedToolName` from `@breeze/shared`.
- Produces:
```ts
export const PROJECTABLE_METHODS = ['get', 'head', 'post', 'put', 'patch', 'delete'] as const;
export type ProjectableMethod = (typeof PROJECTABLE_METHODS)[number];
export const MAX_OPERATIONS = 2_000;
export const MAX_SCHEMA_BYTES = 65_536;
export const MAX_PARAMETERS = 100;

export type SkipReason =
  | 'unsupported_method' | 'unsupported_param_style' | 'unsupported_request_body'
  | 'unsupported_security_location' | 'schema_too_large' | 'too_many_parameters'
  | 'name_not_addressable';

/** The routing contract stored on `tool_source_tools.annotations.operation`. */
export interface OperationBinding {
  method: ProjectableMethod;
  /** Template path exactly as written in the document, e.g. `/pets/{petId}`. */
  path: string;
  operationId: string | null;
  /** Where each input property goes. Keys are input-schema property names. */
  params: Array<{ name: string; in: 'path' | 'query' | 'header'; property: string; required: boolean }>;
  /** Present when the operation takes an application/json body. */
  body: { property: string; required: boolean } | null;
  /** Recorded for the servers[] cross-check only; never used for routing. */
  declaredServer: string | null;
}

export interface ProjectedOperation {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
  outputSchema?: Record<string, unknown>;
  annotations: Record<string, unknown>;   // { readOnlyHint?, destructiveHint?, operation: OperationBinding }
}

export interface ProjectionResult {
  operations: ProjectedOperation[];
  skipped: Array<{ name: string; reason: SkipReason }>;
  /** servers[] origins that do not match the pinned credential origin (D4). */
  serverOriginWarnings: string[];
}

export function projectOpenApiDocument(
  doc: OpenApiDocument,
  ctx: { sourceSlug: string; credentialOrigin: string },
): ProjectionResult;

/** Exported for direct testing. */
export function operationToolName(method: string, path: string, operationId: unknown, slug: string): string | null;

/** Type guard used by the executor to read a binding back out of stored jsonb. */
export function asOperationBinding(annotations: unknown): OperationBinding | null;
```

Rules:
- Iterate `doc.paths` in document order; for each path item iterate `PROJECTABLE_METHODS` in the order above (D8). Anything else under a path item (including `options`, `trace`, `$ref`, `x-*`) is skipped with `unsupported_method` — except `parameters`, `summary`, `description` and `servers`, which are path-item metadata and merged into each operation.
- **Naming (D16):** `operationToolName` returns `operationId` with `.` and `/` replaced by `_` when the result matches `SOURCE_TOOL_NAME_RE` and `qualifiedToolName(slug, name).length <= QUALIFIED_TOOL_NAME_MAX`; else the synthesised `<method>_<path>` form; else `null` ⇒ `name_not_addressable`. De-duplicate against names already emitted in this run with `_2`, `_3`, …; if the suffix pushes it over the length cap, truncate the stem before the suffix.
- **Description:** `operation.summary ?? operation.description ?? ''`, then `` `${method.toUpperCase()} ${path}` `` appended when the text is empty, truncated to 2,000 characters (spec §5.2). Vendor text is **data**: it is stored and later shown to the model behind the `[External: <source>]` prefix `sdkBridge.ts` already adds, never interpreted as an instruction.
- **Input schema:** a JSON-Schema `object` whose `properties` are one entry per supported parameter (property name = the parameter name, sanitised to `[A-Za-z0-9_]` with a `p_` prefix if it would start with a digit; collisions get `_2`) carrying the parameter's `schema` plus its `description`, and — when the operation has an `application/json` request body — one property named `body` (or `body_2` on collision) carrying the body schema. `required` lists every required parameter plus `body` when the request body is required. `additionalProperties: false`. Serialised size over `MAX_SCHEMA_BYTES` ⇒ `schema_too_large`; more than `MAX_PARAMETERS` parameters ⇒ `too_many_parameters`.
- **Output schema:** the first `2xx` response's `application/json` schema when present, else omitted.
- **Annotations:** `{ readOnlyHint: true }` for `get`/`head`; `{ destructiveHint: true }` for `delete`; nothing for the rest (D5) — so `proposeTier` yields 1, 3 and 3 respectively. Always plus `operation: OperationBinding`.
- **Security (D7):** resolve the operation's effective `security` (operation-level overrides document-level; `[]` means none). If any scheme it names is `type: 'apiKey'` with `in: 'query'` or `in: 'cookie'`, or `type: 'openIdConnect'`, skip with `unsupported_security_location`.
- **Parameter styles (D9):** any parameter with `in: 'cookie'`, or a `style`/`explode` other than the default for its location, ⇒ `unsupported_param_style` for the whole operation. Request body `content` with no `application/json` key ⇒ `unsupported_request_body`.
- **Server warnings (D4):** for every `servers[].url` at document, path-item or operation level, resolve it against the spec URL's own base when relative and compare `origin` to `ctx.credentialOrigin`; collect the mismatches, de-duplicated, into `serverOriginWarnings`. Never act on them.
- **Operation cap:** spec §5.3 says a document over 2,000 operations is *rejected with a message*, not truncated — a truncated catalog is worse than none, because the missing half is invisible. So `projectOpenApiDocument` counts the projectable operations first and, if the count exceeds `MAX_OPERATIONS`, **throws** `new OpenApiSpecError(\`too_many_operations: ${count}\`, 'parse')` before projecting anything. Task 8 lands that on the same `status='error'` + `last_error` path as every other spec failure.

- [ ] **Step 1: Write the failing tests.** `openapiProjection.test.ts` — against the fixtures from Task 5:

```ts
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { parseOpenApiDocument, dereferenceLocal } from './openapiSpec';
import { projectOpenApiDocument, operationToolName } from './openapiProjection';
import { proposeTier } from './discovery';

const load = (f: string) => dereferenceLocal(parseOpenApiDocument(readFileSync(join(__dirname, '__fixtures__', f), 'utf8')));
const CTX = { sourceSlug: 'petsvc', credentialOrigin: 'https://api.example.com' };

describe('projectOpenApiDocument — petstore', () => {
  const result = projectOpenApiDocument(load('petstore.json'), CTX);

  it('projects one tool per supported operation, named from operationId', () => {
    expect(result.operations.map((o) => o.name).sort())
      .toEqual(['createPets', 'deletePet', 'listPets', 'showPetById']);
  });

  it('maps HTTP verbs to tiers fail-closed through proposeTier', () => {
    const tierOf = (n: string) => proposeTier(result.operations.find((o) => o.name === n)!.annotations);
    expect(tierOf('listPets')).toBe(1);        // GET
    expect(tierOf('showPetById')).toBe(1);     // GET
    expect(tierOf('createPets')).toBe(3);      // POST
    expect(tierOf('deletePet')).toBe(3);       // DELETE
  });

  it('records the routing binding without any server URL', () => {
    const show = result.operations.find((o) => o.name === 'showPetById')!;
    const binding = (show.annotations as any).operation;
    expect(binding.method).toBe('get');
    expect(binding.path).toBe('/pets/{petId}');
    expect(binding.params).toContainEqual({ name: 'petId', in: 'path', property: 'petId', required: true });
    expect(binding.body).toBeNull();
  });

  it('turns path and query parameters into a strict object schema', () => {
    const list = result.operations.find((o) => o.name === 'listPets')!;
    expect(list.inputSchema).toMatchObject({ type: 'object', additionalProperties: false });
    expect(Object.keys((list.inputSchema as any).properties)).toContain('limit');
  });

  it('gives a JSON request body a `body` property and marks it required', () => {
    const create = result.operations.find((o) => o.name === 'createPets')!;
    expect((create.inputSchema as any).properties.body).toBeDefined();
    expect((create.inputSchema as any).required).toContain('body');
    expect((create.annotations as any).operation.body).toEqual({ property: 'body', required: true });
  });

  it('warns about an off-origin servers[] entry without routing to it', () => {
    expect(result.serverOriginWarnings).toEqual([]);   // petstore's server matches CTX
  });
});

describe('projectOpenApiDocument — halo-like (every skip reason)', () => {
  const result = projectOpenApiDocument(load('halo-like.yaml'), CTX);

  it('skips each unsupported shape with its own reason and keeps the rest', () => {
    const reasons = new Set(result.skipped.map((s) => s.reason));
    expect(reasons).toEqual(new Set([
      'unsupported_param_style', 'unsupported_request_body', 'unsupported_security_location',
    ]));
    expect(result.operations.length).toBeGreaterThan(0);
  });

  it('synthesises a name for operations with no operationId', () => {
    expect(result.operations.some((o) => /^get_/.test(o.name))).toBe(true);
  });
});

describe('operationToolName', () => {
  it('prefers a sanitised operationId', () => {
    expect(operationToolName('get', '/pets', 'pets.list', 'petsvc')).toBe('pets_list');
  });
  it('synthesises from method and path when operationId is absent', () => {
    expect(operationToolName('get', '/pets/{petId}/toys', undefined, 'petsvc')).toBe('get_pets_by_petid_toys');
  });
  it('returns null when the qualified name cannot fit 64 characters', () => {
    expect(operationToolName('get', `/${'x'.repeat(200)}`, undefined, 'averylongsourceslughere')).toBeNull();
  });
});
```

- [ ] **Step 2: Run to verify failure**

Run: `cd apps/api && npx vitest run src/services/toolSources/openapiProjection.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement** `openapiProjection.ts` per the rules above.

- [ ] **Step 4: Run to verify it passes**

Run: `cd apps/api && npx vitest run src/services/toolSources/openapiProjection.test.ts`
Expected: PASS (11 tests).

- [ ] **Step 5: Commit**

```bash
git add apps/api/src/services/toolSources/openapiProjection.ts apps/api/src/services/toolSources/openapiProjection.test.ts
git commit -m "feat(api): project OpenAPI operations into tool descriptors with fail-closed tiers"
```

---

## Task 7: OpenAPI HTTP client

**Files:**
- Create: `apps/api/src/services/toolSources/openapiClient.ts`, `apps/api/src/services/toolSources/openapiClient.test.ts`

**Interfaces:**
- Consumes: `OperationBinding` (Task 6), `buildToolSourceAuthHeaders` (Task 4), `safeFetch`/`SafeFetchInit` from `../urlSafety`, `ToolSourceAuthConfig` from `./secrets`.
- Produces:
```ts
export const OPENAPI_TIMEOUT_MS = 30_000;
export const OPENAPI_MAX_RESPONSE_BYTES = 1_048_576;
export const OPENAPI_ERROR_BODY_CHARS = 2_048;

export interface OpenApiClientOptions {
  /** `tool_sources.endpoint_url` — the API base URL. Never `servers[]`. */
  baseUrl: string;
  credentialOrigin: string;
  auth: ToolSourceAuthConfig;
  fetchImpl?: (url: string, init: SafeFetchInit) => Promise<Response>;   // default safeFetch
  timeoutMs?: number;
  maxResponseBytes?: number;
  allowPrivateNetwork?: boolean;
}

export interface OpenApiCallResult { isError: boolean; text: string }

export class OpenApiClient {
  constructor(opts: OpenApiClientOptions);
  callOperation(binding: OperationBinding, input: Record<string, unknown>): Promise<OpenApiCallResult>;
}

/** Exported for direct testing — builds the URL and headers, performs no I/O. */
export function buildOperationRequest(
  baseUrl: string, binding: OperationBinding, input: Record<string, unknown>,
): { url: string; body: string | undefined };
```

Behaviour:
- **URL:** `baseUrl` with any trailing `/` stripped, plus `binding.path` with each `{name}` replaced by `encodeURIComponent(String(value))` for the `in: 'path'` parameter bound to it. A missing **required** path parameter is a caller error ⇒ `{ isError: true, text: 'missing required path parameter: <name>' }` (the descriptor's Ajv validator should already have caught it; this is depth, not duplication).
- **Query:** `in: 'query'` parameters appended with `URLSearchParams`; an array value produces one repeated key per element (`style: form, explode: true`); `undefined`/`null` values are omitted entirely, never sent as empty.
- **Headers:** `in: 'header'` parameters, plus `Accept: application/json`, plus `Content-Type: application/json` when there is a body, plus `await buildToolSourceAuthHeaders(auth, url, credentialOrigin)` — **with the default `'throw'`**, so a base URL that has drifted off the pinned origin refuses the call instead of leaking the credential.
- **Body:** `JSON.stringify(input[binding.body.property])` when `binding.body` is set and the property is present.
- **Send:** `fetchImpl(url, { method: binding.method.toUpperCase(), headers, body, timeoutMs, maxBytes, allowPrivateNetwork })`. `safeFetch` does not follow redirects, so a 3xx is reported as `isError: true` with `HTTP <status>` — a redirect is exactly the credential-moving case D4 closes.
- **Result:** 2xx ⇒ `{ isError: false, text }` where `text` is the raw body (the caller truncates and redacts); non-2xx ⇒ `{ isError: true, text: \`HTTP ${status}: ${body.slice(0, OPENAPI_ERROR_BODY_CHARS)}\` }` (D15). A throw from `fetchImpl` ⇒ `{ isError: true, text: <message> }`; `ResponseTooLargeError` and timeouts are named in the message.

- [ ] **Step 1: Write the failing tests.** `openapiClient.test.ts`:

```ts
import { describe, expect, it, vi } from 'vitest';
import { OpenApiClient, buildOperationRequest } from './openapiClient';
import type { OperationBinding } from './openapiProjection';

const BASE = 'https://api.example.com/v1';
const ORIGIN = 'https://api.example.com';

const showPet: OperationBinding = {
  method: 'get', path: '/pets/{petId}', operationId: 'showPetById',
  params: [
    { name: 'petId', in: 'path', property: 'petId', required: true },
    { name: 'fields', in: 'query', property: 'fields', required: false },
    { name: 'X-Trace', in: 'header', property: 'X_Trace', required: false },
  ],
  body: null, declaredServer: null,
};
const createPet: OperationBinding = {
  method: 'post', path: '/pets', operationId: 'createPets', params: [],
  body: { property: 'body', required: true }, declaredServer: null,
};

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

describe('buildOperationRequest', () => {
  it('substitutes path params, encodes them, and appends query params', () => {
    const { url } = buildOperationRequest(BASE, showPet, { petId: 'a/b', fields: ['name', 'age'] });
    expect(url).toBe('https://api.example.com/v1/pets/a%2Fb?fields=name&fields=age');
  });
  it('omits undefined and null query values entirely', () => {
    const { url } = buildOperationRequest(BASE, showPet, { petId: '1', fields: undefined });
    expect(url).toBe('https://api.example.com/v1/pets/1');
  });
  it('serialises a JSON body', () => {
    const { body } = buildOperationRequest(BASE, createPet, { body: { name: 'Rex' } });
    expect(body).toBe('{"name":"Rex"}');
  });
});

describe('OpenApiClient.callOperation', () => {
  const client = (fetchImpl: any) =>
    new OpenApiClient({ baseUrl: BASE, credentialOrigin: ORIGIN, auth: { authKind: 'bearer', token: 'tok' }, fetchImpl });

  it('attaches the credential, the method and the headers', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(json({ id: '1' }));
    const result = await client(fetchImpl).callOperation(showPet, { petId: '1', X_Trace: 'abc' });
    const init = fetchImpl.mock.calls[0][1];
    expect(init.method).toBe('GET');
    expect(init.headers.Authorization).toBe('Bearer tok');
    expect(init.headers['X-Trace']).toBe('abc');
    expect(result).toEqual({ isError: false, text: '{"id":"1"}' });
  });

  it('reports a non-2xx as isError with the status and a truncated body', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(new Response('x'.repeat(5000), { status: 422 }));
    const result = await client(fetchImpl).callOperation(showPet, { petId: '1' });
    expect(result.isError).toBe(true);
    expect(result.text.startsWith('HTTP 422: ')).toBe(true);
    expect(result.text.length).toBeLessThan(2100);
  });

  it('reports a redirect as an error rather than following it', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(new Response(null, { status: 302, headers: { location: 'https://evil.example/' } }));
    const result = await client(fetchImpl).callOperation(showPet, { petId: '1' });
    expect(result.isError).toBe(true);
    expect(result.text).toContain('HTTP 302');
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it('refuses to call when the base URL has drifted off the pinned origin', async () => {
    const fetchImpl = vi.fn();
    const drifted = new OpenApiClient({ baseUrl: 'https://other.example/v1', credentialOrigin: ORIGIN, auth: { authKind: 'bearer', token: 'tok' }, fetchImpl });
    const result = await drifted.callOperation(showPet, { petId: '1' });
    expect(result.isError).toBe(true);
    expect(result.text).toMatch(/origin/i);
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it('reports a missing required path parameter without calling out', async () => {
    const fetchImpl = vi.fn();
    const result = await client(fetchImpl).callOperation(showPet, {});
    expect(result).toEqual({ isError: true, text: 'missing required path parameter: petId' });
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it('turns a transport throw into an error result, never a rejection', async () => {
    const fetchImpl = vi.fn().mockRejectedValue(new Error('socket hang up'));
    await expect(client(fetchImpl).callOperation(showPet, { petId: '1' })).resolves.toMatchObject({ isError: true });
  });
});
```

- [ ] **Step 2: Run to verify failure**

Run: `cd apps/api && npx vitest run src/services/toolSources/openapiClient.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement** `openapiClient.ts` per the behaviour above.

- [ ] **Step 4: Run to verify it passes**

Run: `cd apps/api && npx vitest run src/services/toolSources/openapiClient.test.ts`
Expected: PASS (9 tests).

- [ ] **Step 5: Commit**

```bash
git add apps/api/src/services/toolSources/openapiClient.ts apps/api/src/services/toolSources/openapiClient.test.ts
git commit -m "feat(api): OpenAPI operation HTTP client with pinned-origin credentials"
```

---

## Task 8: Wire the kind branches — discovery, executor, resolver

**Files:**
- Modify: `apps/api/src/services/toolSources/discovery.ts` (+ `discovery.test.ts`)
- Modify: `apps/api/src/services/toolSources/execute.ts` (+ `execute.test.ts`)
- Modify: `apps/api/src/services/toolSources/resolver.ts` (+ `resolver.test.ts`)

**Interfaces:**
- Consumes: `fetchOpenApiDocument` (Task 5), `projectOpenApiDocument` (Task 6), `OpenApiClient` (Task 7).
- Produces: `TenantToolDescriptor.sourceKind: 'mcp' | 'openapi'` — consumed by Task 9's DTO and by W03+ (the flow validator surfaces the kind in step review).

**discovery.ts.** Extract the listing step behind one function and branch on `source.kind`. Everything from `const existingRows = ...` onwards (the reconcile loop, revision bumps, removals, review flags, `name_not_addressable`, the source status write) is **untouched** — that is the whole point of matching `McpToolListing`'s shape:

```ts
/** Produces the kind-agnostic listing the reconcile loop consumes. */
async function listRemoteTools(
  source: ToolSourceRow,
  auth: ToolSourceAuthConfig,
  deps?: { clientFactory?: (opts: McpClientOptions) => McpClient },
): Promise<{ listing: McpToolListing[]; warning: string | null }> {
  if (source.kind === 'openapi') {
    if (!source.specUrl) throw new Error('openapi source has no spec_url');   // CHECK-guaranteed
    const doc = await fetchOpenApiDocument({
      specUrl: source.specUrl,
      credentialOrigin: source.credentialOrigin,
      auth,
      allowPrivateNetwork: toolSourcesAllowPrivateEgress(),
    });
    const projected = projectOpenApiDocument(doc, {
      sourceSlug: source.slug,
      credentialOrigin: source.credentialOrigin,
    });
    const warning = projected.serverOriginWarnings.length
      ? `spec declares server origins that do not match the pinned credential origin and were ignored: ${projected.serverOriginWarnings.join(', ')}`
      : null;
    return { listing: projected.operations, warning };
  }
  const clientFactory = deps?.clientFactory ?? ((opts: McpClientOptions) => new McpClient(opts));
  const client = clientFactory({
    endpointUrl: source.endpointUrl,
    credentialOrigin: source.credentialOrigin,
    auth,
    allowPrivateNetwork: toolSourcesAllowPrivateEgress(),
  });
  await client.initialize();
  return { listing: await client.listTools(), warning: null };
}
```

`discoverSource` calls it inside the existing `try` (so an `OpenApiSpecError` lands on the same `status='error'` + `redactSecrets(message)` path as an `McpClientError` — no new error handling), adds `deps.specFetcher?` and `deps.projector?` overrides alongside `clientFactory` for tests, and carries `warning` into the success write: `lastError: warning` with `status: 'active'` (a warning is not a failure; it must be visible in the UI, and `last_error` is the only field the detail page already renders). Projection `skipped` entries merge into the returned `DiscoveryOutcome.skipped` — the field already exists and is already surfaced.

**execute.ts.** Replace the unconditional `new McpClient({...})` block with a branch on `loaded.source.kind`; nothing else in the function moves:

```ts
let rawResultText: string;
try {
  if (source.kind === 'openapi') {
    const binding = asOperationBinding(loaded.tool.annotations);   // see below
    if (!binding) {
      isError = true;
      rawResultText = 'this tool is missing its operation binding; re-discover the source';
    } else {
    const openApi = new OpenApiClient({
      baseUrl: source.endpointUrl,
      credentialOrigin: source.credentialOrigin,
      auth: authConfig,
      allowPrivateNetwork: toolSourcesAllowPrivateEgress(),
    });
    const callResult = await openApi.callOperation(binding, input);
    isError = callResult.isError;
    rawResultText = callResult.text;
    }
  } else {
    const client = new McpClient({ /* unchanged */ });
    const callResult = await client.callTool(d.name, input);
    isError = callResult.isError === true;
    rawResultText = buildResultText(callResult);
  }
} catch (err) { /* unchanged */ }
```

The binding comes from the stored row, not from the descriptor's trimmed fields: `loadTenantToolForExecution` already returns both the source row and the `tool_source_tools` row, so read `tool.annotations.operation` through a small type guard defined in `openapiProjection.ts`:

```ts
export function asOperationBinding(annotations: unknown): OperationBinding | null;
// null unless `annotations.operation` has a PROJECTABLE_METHODS method, a string
// path starting with '/', an array `params` of {name,in,property,required}, and a
// `body` that is null or {property,required}.
```

A row whose annotations do not carry a valid binding (a hand-edited jsonb, a row written before this wave) never produces a call with guessed routing — it returns the `isError` text above and the audit event still fires.

**resolver.ts.** Three edits: `sourceKind: 'mcp' | 'openapi'` on `TenantToolDescriptor`; `toolSources.kind` added to `RESOLVE_TOOL_ROW_SELECTION` and to `ResolvedToolRow`; `compileToolDescriptor` sets `sourceKind: row.sourceKind` instead of the `'mcp'` literal. Nothing about visibility, owner predicates, Ajv compilation or the partner-wide read branch changes.

- [ ] **Step 1: Write the failing tests.**

In `discovery.test.ts`, add a describe block using the Drizzle mock pattern already in that file:

```ts
describe('discoverSource — openapi kind (W2)', () => {
  it('fetches and projects the document instead of speaking MCP', async () => { /* source row kind: 'openapi', specUrl set; inject specFetcher + projector; assert the MCP clientFactory is NEVER called and N tools are inserted with proposedTier 1 for GETs */ });
  it('records a servers[] origin mismatch as a warning while staying active', async () => { /* projector returns serverOriginWarnings; assert status 'active' and lastError contains "ignored" */ });
  it('sets status error with a redacted message when the spec cannot be parsed', async () => { /* specFetcher throws OpenApiSpecError('unsupported_version: 2.0','unsupported_version'); assert status 'error' */ });
  it('never lowers an effective tier on re-discovery', async () => { /* existing row tier 3 for a GET now proposing 1 → tier stays 3, reviewNeeded true */ });
});
```

In `execute.test.ts`:

```ts
describe('executeTenantToolDetailed — openapi kind (W2)', () => {
  it('dispatches through OpenApiClient with the source endpoint as the base URL', async () => { /* mock loadTenantToolForExecution to return kind 'openapi' + an operation binding; assert OpenApiClient constructed with baseUrl = source.endpointUrl */ });
  it('reports a missing operation binding without calling out', async () => { /* annotations: {} → isError true, text mentions re-discover, fetch never called */ });
  it('redacts the source credential out of an OpenAPI error body', async () => { /* client returns isError with the bearer token echoed; assert the token is absent from text */ });
  it('writes the same audit event shape as the mcp path', async () => { /* action 'ai.external_tool.call', inputKeys only, no values */ });
});
```

In `resolver.test.ts`:

```ts
it('carries the source kind onto the descriptor', () => {
  expect(compileToolDescriptor({ ...row, sourceKind: 'openapi' }, ajv)!.sourceKind).toBe('openapi');
});
```

- [ ] **Step 2: Run to verify failure**

Run: `cd apps/api && npx vitest run src/services/toolSources/discovery.test.ts src/services/toolSources/execute.test.ts src/services/toolSources/resolver.test.ts`
Expected: FAIL in all three.

- [ ] **Step 3: Implement** the three branches exactly as specified. Do not touch `guardrails.ts`, `sdkBridge.ts` or anything on the do-not-touch list: an OpenAPI tool is authorised, rate-limited, approved and rendered by the same code as an MCP tool, and that is the wave's central claim.

- [ ] **Step 4: Run to verify it passes**

Run: `cd apps/api && npx vitest run src/services/toolSources/ && NODE_OPTIONS=--max-old-space-size=8192 npx tsc --noEmit -p tsconfig.json`
Expected: PASS (every file under `services/toolSources/`, count reported and non-zero), tsc clean.

- [ ] **Step 5: Commit**

```bash
git add apps/api/src/services/toolSources/discovery.ts apps/api/src/services/toolSources/discovery.test.ts \
        apps/api/src/services/toolSources/execute.ts apps/api/src/services/toolSources/execute.test.ts \
        apps/api/src/services/toolSources/resolver.ts apps/api/src/services/toolSources/resolver.test.ts
git commit -m "feat(api): dispatch discovery and execution by tool-source kind"
```

---

## Task 9: Service and routes accept the openapi kind

**Files:**
- Modify: `apps/api/src/services/toolSources/service.ts` (+ `service.test.ts`)
- Modify: `apps/api/src/routes/toolSources.ts` (+ `toolSources.test.ts`)

No new endpoint. The ten routes W01 shipped are unchanged in shape; only the payloads widen.

**service.ts:**
- `ToolSourceDto` gains `specUrl: string | null`; `toToolSourceDto` copies `row.specUrl`.
- `createToolSourceRow` writes `specUrl: input.kind === 'openapi' ? input.specUrl : null` and keeps `credentialOrigin = credentialOriginFor(input.endpointUrl)` **unchanged** — that is the whole reason for D2.
- `updateToolSourceRow`: a supplied `specUrl` is written **only** when the stored row's `kind === 'openapi'`; on an `mcp` row it is a `ServiceError` (`400`, code `spec_url_not_applicable`). Kind itself remains create-only. A changed `specUrl` re-enqueues discovery on the same code path a changed `endpointUrl` already does.

**routes/toolSources.ts:**
- `toolSourceValidator()` (route file ~line 87) keeps selecting between the https-only and the `WithHttp` schema pair on `toolSourcesAllowPrivateEgress()`; both pairs now accept `openapi`, so this function does not change.
- `POST /` — no change beyond the schema; the slug-shadowing check, MFA, partner-wide gate (`canManagePartnerWidePolicies`) and `enqueueToolSourceDiscovery` are kind-agnostic.
- `POST /:id/tools/:toolId/test` — unchanged, still Tier 1 only, still routed through `executeTenantTool`, which now dispatches by kind.

- [ ] **Step 1: Write the failing tests.** In `apps/api/src/routes/toolSources.test.ts`, following the existing mock pattern in that file:

```ts
describe('POST /tool-sources — openapi kind (W2)', () => {
  it('creates an openapi source and pins the credential origin to the API base URL, not the spec host', async () => {
    // body: kind 'openapi', endpointUrl 'https://api.halo.example/v1',
    //       specUrl 'https://docs.halo.example/openapi.json'
    // assert: insert called with credentialOrigin 'https://api.halo.example' and specUrl the docs URL
  });
  it('rejects an openapi source with no specUrl (400)', async () => { /* … */ });
  it('rejects an mcp source that supplies a specUrl (400)', async () => { /* … */ });
  it('enqueues discovery for an openapi source exactly as for mcp', async () => { /* assert enqueueToolSourceDiscovery called with the new id */ });
  it('returns specUrl in the DTO and still omits authConfigEncrypted', async () => { /* … */ });
  it('still requires canManagePartnerWidePolicies for a partner-wide openapi source', async () => { /* 403 for a selected-access partner admin */ });
});

describe('PATCH /tool-sources/:id — openapi kind (W2)', () => {
  it('re-enqueues discovery when specUrl changes', async () => { /* … */ });
  it('refuses a specUrl on an mcp row (400 spec_url_not_applicable)', async () => { /* … */ });
  it('still refuses a kind change', async () => { /* 400 */ });
});
```

- [ ] **Step 2: Run to verify failure**

Run: `cd apps/api && npx vitest run src/routes/toolSources.test.ts src/services/toolSources/service.test.ts`
Expected: FAIL.

- [ ] **Step 3: Implement** the service and route changes above.

- [ ] **Step 4: Run to verify it passes**

Run:
```bash
cd apps/api && npx vitest run src/routes/toolSources.test.ts src/services/toolSources/service.test.ts \
  src/__tests__/partner-wide-write-coverage.test.ts src/__tests__/mcp-coverage.test.ts
```
Expected: PASS. `partner-wide-write-coverage` and `mcp-coverage` are contract tests W01 already registered this router with; they must stay green.

- [ ] **Step 5: Commit**

```bash
git add apps/api/src/services/toolSources/service.ts apps/api/src/services/toolSources/service.test.ts \
        apps/api/src/routes/toolSources.ts apps/api/src/routes/toolSources.test.ts
git commit -m "feat(api): /tool-sources accepts openapi sources and their spec URL"
```

---

## Task 10: Web — live kind selector, spec URL field, method/path column

**Files:**
- Modify: `apps/web/src/components/toolSources/ToolSourceForm.tsx` (+ `.test.tsx`)
- Modify: `apps/web/src/components/toolSources/api.ts` (+ `.test.ts`)
- Modify: `apps/web/src/components/toolSources/DiscoveredToolsTable.tsx` (+ `.test.tsx`)
- Modify: `apps/web/src/components/toolSources/ToolSourcesPage.tsx`
- Modify: `apps/web/src/locales/{en,de-DE,es-419,fr-CA,fr-FR,it-IT,pt-BR,tr-TR}/toolSources.json`

**i18n.** In `en/toolSources.json`: **remove** `form.kindOpenapiSoon`; **add** `form.kindOpenapi` (`"OpenAPI (REST)"`), `form.specUrl` (`"OpenAPI document URL"`), `form.specUrlHelp` (`"Where Breeze fetches the spec. The credential is sent with this request only when the document is served from the same origin as the API base URL."`), `form.endpointMcp` (`"MCP server URL"`), `form.endpointOpenapi` (`"API base URL"`), `form.endpointHelpOpenapi` (`"Every operation is called against this URL. The servers[] list inside the document is ignored — a document can be edited by the vendor at any time, and a credential must never follow it."`), `tools.method` (`"Method"`), `tools.path` (`"Path"`), `tools.skipped` (`"Skipped"`), `toasts.serverOriginWarning` (`"Some server URLs in this document point elsewhere and were ignored."`). Copy the English file verbatim into the other seven locales — that is the repo's convention and what `localeParity.test.ts` enforces.

**ToolSourceForm.tsx.** Today the kind `<select>` at ~line 246 is inert (`value="mcp"`, `onChange={() => {}}`, the `openapi` option `disabled`), and the submit body hardcodes `kind: 'mcp'` (~line 165). Make it real:
- `const [kind, setKind] = useState<ToolSourceKind>('mcp')` (create only; the edit branch keeps reading `source.kind` and renders the kind as static text, because kind is create-only server-side).
- The select's `value={kind}`, `onChange` sets it, and the `openapi` option loses `disabled` and uses `form.kindOpenapi`.
- The endpoint field's label switches on kind (`form.endpointMcp` / `form.endpointOpenapi`) and its help text likewise.
- A `specUrl` input (`data-testid="tool-source-spec-url"`, `type="url"`, `required`) renders **only** when `kind === 'openapi'`, with `form.specUrlHelp` beneath it. On edit it renders when `source.kind === 'openapi'`.
- Submit: `kind`, and `...(kind === 'openapi' ? { specUrl: specUrl.trim() } : {})`. The edit body adds `specUrl` only when the source is openapi.
- No change to the mutation plumbing: both branches already go through `runClientAction` → `runAction`, and the `ActionError`/`handleActionError` catch pattern at ~line 180 stays exactly as it is. `no-silent-mutations.test.ts` must stay green.

**api.ts.** `CreateToolSourceBody` gains `kind: ToolSourceKind` (it is currently typed to the literal) and `specUrl?: string`; `UpdateToolSourceBody` gains `specUrl?: string`. No new fetcher.

**DiscoveredToolsTable.tsx.** When the source is `openapi`, render two extra columns between name and description — `tools.method` (the verb, upper-cased, from `annotations.operation.method`) and `tools.path` (`annotations.operation.path`, monospace, truncated with a `title`). Guard on the binding being present so an MCP source and a stale row render unchanged.

**ToolSourcesPage.tsx.** The kind badge currently reads a hardcoded MCP label; read `source.kind` and render `form.kindMcp` / `form.kindOpenapi`.

- [ ] **Step 1: Write the failing tests.** In `ToolSourceForm.test.tsx`:

```tsx
it('offers openapi as a selectable kind', async () => { /* the option is not disabled */ });
it('shows the spec URL field only for the openapi kind', async () => { /* absent for mcp, present after selecting openapi */ });
it('relabels the endpoint field per kind', async () => { /* "MCP server URL" → "API base URL" */ });
it('posts kind and specUrl for an openapi source', async () => {
  // assert createToolSource called with { kind: 'openapi', endpointUrl, specUrl, ownerScope, ... }
});
it('does not post specUrl for an mcp source', async () => { /* key absent, not null */ });
```

In `DiscoveredToolsTable.test.tsx`:

```tsx
it('renders method and path columns for an openapi source', () => { /* GET + /pets/{petId} visible */ });
it('renders neither column for an mcp source', () => { /* … */ });
it('renders an openapi row with no operation binding without crashing', () => { /* annotations: {} */ });
```

In `api.test.ts`: `createToolSource` forwards `specUrl`.

- [ ] **Step 2: Run to verify failure**

Run: `cd apps/web && npx vitest run src/components/toolSources`
Expected: FAIL.

- [ ] **Step 3: Implement** the component, api and locale changes above.

- [ ] **Step 4: Run to verify it passes**

```bash
cd apps/web && npx vitest run src/components/toolSources src/lib/i18n/localeParity.test.ts \
  src/lib/i18n/translationCoverage.test.ts src/lib/__tests__/no-silent-mutations.test.ts \
  && npx astro check && pnpm lint
```
Expected: PASS, `astro check` clean.

- [ ] **Step 5: Commit**

```bash
git add apps/web/src/components/toolSources apps/web/src/locales
git commit -m "feat(web): add an OpenAPI source kind to the Tool Sources form and tools table"
```

---

## Task 11: Contract suites, docs, and PR wrap-up

**Files:**
- Modify: `apps/api/src/__tests__/integration/toolSourcesPartnerRls.integration.test.ts`
- Modify: `apps/docs/src/content/docs/features/tool-sources.mdx`

- [ ] **Step 1: Extend the RLS suite with an openapi row.** Append to `toolSourcesPartnerRls.integration.test.ts`, reusing the file's existing setup helpers verbatim:

```ts
describe('openapi sources (W2)', () => {
  it('refuses an openapi row with no spec_url (23514)', async () => { /* tool_sources_spec_url_kind_chk */ });
  it('refuses an mcp row carrying a spec_url (23514)', async () => { /* same CHECK, other direction */ });
  it('forges partner A\'s partner_id on an openapi source as partner B → 42501', async () => { /* … */ });
  it('resolves a partner-wide openapi tool for an org-scoped caller and never another partner\'s', async () => {
    // insert an enabled openapi tool_source_tools row owned partner-wide;
    // resolveTenantTools(orgAuth) returns it with sourceKind 'openapi'
  });
});
```

The fourth case is the one that matters: it proves the partner-wide SELECT branch (`org_id IS NULL AND partner_id = public.breeze_current_partner_id()`) reaches an openapi row the same way it reaches an MCP one. Dropping that branch silently stops partner-wide config reaching agents with no error (CLAUDE.md, Partner-Wide First step 3).

- [ ] **Step 2: Run the contract suites against a real database.**

```bash
pnpm test-stack up
cd apps/api && export DATABASE_URL=<the test-stack URL> && pnpm db:migrate
npx vitest run --config vitest.integration.config.ts \
  src/__tests__/integration/toolSourcesPartnerRls.integration.test.ts \
  src/__tests__/integration/rls-coverage.integration.test.ts \
  src/__tests__/integration/tenantCascade.integration.test.ts \
  src/__tests__/integration/tenant-export-policy.integration.test.ts \
  src/__tests__/integration/tenantExportErasureRoundtrip.integration.test.ts \
  src/__tests__/integration/orgLifecycleFoundations.integration.test.ts
```
Expected: PASS, every file, with a non-zero test count each. The two export-policy suites are the ones the `spec_url` column can redden; the org-lifecycle suite is the merge contract. **Tear the stack down when finished — `pnpm test-stack down`. Nothing does it for you.**

- [ ] **Step 3: Verify the CHECK as `breeze_app`, by hand.**

```bash
docker exec -it breeze-postgres psql -U breeze_app -d breeze \
  -c "INSERT INTO tool_sources (org_id, slug, name, kind, endpoint_url, credential_origin) VALUES (NULL,'x','x','openapi','https://a.example','https://a.example');"
```
Expected: `new row for relation "tool_sources" violates check constraint "tool_sources_spec_url_kind_chk"` (or an RLS refusal first — either is a pass; a successful insert is a fail). Paste the output into the PR body.

- [ ] **Step 4: Document it.** In `apps/docs/src/content/docs/features/tool-sources.mdx`, add an "OpenAPI sources" section after the MCP one covering: the two URLs and why they are separate (the API base URL is where credentials go; the document URL is only read); that `servers[]` is ignored on purpose; the verb→tier rule (GET/HEAD start at Tier 1, everything else at Tier 3, and a tech can raise but re-discovery never lowers); what gets skipped and why (non-default parameter styles, non-JSON bodies, query/cookie API keys, OpenAPI 2.0); the 5 MB / 2,000-operation caps; and that refreshing is manual via "Re-discover tools". Do not repeat the MCP tier/approval material — link to it.

```bash
cd apps/docs && pnpm build
```
Expected: clean.

- [ ] **Step 5: Full local gate.**

```bash
cd packages/shared && npx vitest run src/validators/toolSources.test.ts && npx tsc --noEmit -p tsconfig.json && pnpm lint
cd apps/api && npx vitest run src/services/toolSources/ src/routes/toolSources.test.ts src/db/schema/toolSources.test.ts \
  src/db/autoMigrate.test.ts src/db/migrationRlsScope.test.ts src/services/aiToolsRegistryParity.test.ts \
  && NODE_OPTIONS=--max-old-space-size=8192 npx tsc --noEmit -p tsconfig.json && pnpm lint
cd apps/web && npx vitest run src/components/toolSources src/lib/i18n src/lib/__tests__/no-silent-mutations.test.ts \
  && npx astro check && pnpm lint
```

- [ ] **Step 6: Manual proof on a worktree stack.** Bring the stack up (`worktree-stack` skill) with `TOOL_SOURCES_ENABLED=true`, register an OpenAPI source against a public spec the stack's egress can reach, confirm: discovery lands N tools with GETs at Tier 1 and writes at Tier 3; the skipped operations and their reasons are visible; enabling a Tier 1 read makes it appear in AI chat's tool list under `<slug>__<name>`; the test drawer returns a real response; a Tier 3 operation is refused over Breeze's own MCP server (`isMcpApprovalRequired`, unchanged from W01). Screenshots into the PR. Tear the stack down.

- [ ] **Step 7: Commit and open the PR.**

```bash
git add apps/api/src/__tests__/integration/toolSourcesPartnerRls.integration.test.ts apps/docs/src/content/docs/features/tool-sources.mdx
git commit -m "test(api): openapi RLS cases; docs(features): OpenAPI tool sources"
gh pr create --base main --title "feat(ai): Tool Catalog W02 — OpenAPI source kind (#5217)" --body "…Closes #5217…"
```

PR body must state: the migration slot and why it sorts last; the export-policy classification of `spec_url`; the forge output from Step 3; the D4 routing decision in one sentence (reviewers will ask why `servers[]` is ignored); and the screenshots from Step 6. Run `/pr-review-toolkit:review-pr` once, act on confirmed findings only. Merge with bare `gh pr merge <N>`; then `complete_wave` for #5217.

---

## Self-review (done at authoring)

**1. Spec coverage (W2 row, §5.3 OpenAPI bullet, §5.5 executor, §9 testing).**
- Parse + dereference + version gate + remote-`$ref` rejection: Task 5.
- One tool per operation, `operationId` gaps synthesised, 5 MB / 2,000-operation caps: Task 6 (D12, D16).
- `GET`/`HEAD` → 1, everything else → 3, Tier 2 never proposed: Task 6 via annotations + the untouched `proposeTier` (D5).
- Tools start disabled, never-lower-tier on re-discovery, untrusted descriptions: inherited unchanged from W01's reconcile loop; asserted in Task 8's re-discovery test.
- Parameter/body serialisation and execution: Task 7 (D9).
- Credential-origin pinning, egress guard, redaction, 30 s / 1 MB caps, audit: Tasks 4, 7, 8 — all reusing W01's paths.
- UI kind toggle and refresh: Task 10 + the existing `POST /:id/discover`.
- Three fixture specs (petstore, `operationId` gaps, remote `$ref`): Task 5's `__fixtures__`, exercised in Tasks 5 and 6.

**2. Repo contracts encoded.** Partner-Wide First: no new config table, and the existing org-XOR-partner shape plus its partner-wide SELECT branch are re-proved for an openapi row (Task 11 Step 1). Tenancy/RLS + cascade/export checklist: **one migration, additive, one column** — no table, so only the export-policy row fires, and it is Task 3 Step 5 with a `grep` verification. Migration slot named above the newest on `origin/main` with a re-check command. `runAction`: Task 10 keeps both mutation branches on `runClientAction`/`runAction` and re-runs `no-silent-mutations.test.ts`. `breeze-testing`: every task's tests cover the six-point contract — happy path, auth/authz (Task 9's partner-wide 403), validation (Tasks 2, 9), multi-tenant isolation (Task 11), error cases (Tasks 5, 7, 8), edge cases (cycles, empty query values, missing bindings, oversize schemas).

**3. Placeholders.** None. The two places a judgement is deferred are named, not hidden: the exact contents of the three fixtures (Task 5 specifies what each must contain, operation by operation) and the `ToolSourcesPage` kind badge's current markup (Task 10 says read `source.kind`, the component is four lines of JSX).

**4. Type consistency.** `buildToolSourceAuthHeaders`, `ToolSourceAuthError`, `fetchOpenApiDocument`, `parseOpenApiDocument`, `dereferenceLocal`, `OpenApiSpecError`, `projectOpenApiDocument`, `operationToolName`, `ProjectedOperation`, `OperationBinding`, `SkipReason`, `asOperationBinding`, `OpenApiClient`, `buildOperationRequest`, `OpenApiCallResult`, `specUrl`/`spec_url`, `sourceKind` are each introduced once and used with the same name and shape everywhere after. `ProjectedOperation` is deliberately assignable to `McpToolListing` so Task 8's `listRemoteTools` has one return type.

**5. Verified against `origin/main`.** Every path, identifier, line reference, constant, migration filename, registry entry and i18n key cited above was read out of `origin/main` at authoring: the `tool_source_kind` enum already contains `'openapi'`; `endpoint_url` is `NOT NULL` and `credentialOriginFor` is called unconditionally at `service.ts:275`/`:317`; `TenantToolDescriptor.sourceKind` is the hardcoded literal `'mcp'` at `resolver.ts:33` and `:203`; `RESOLVE_TOOL_ROW_SELECTION` does not select `toolSources.kind`; `proposeTier` is `discovery.ts:46`; `discoverSource` builds an `McpClient` unconditionally at `discovery.ts:~140`; `execute.ts:106` does the same; the form's kind select is inert at `ToolSourceForm.tsx:~246` with `kind: 'mcp'` hardcoded at `:~165`; `form.kindOpenapiSoon` exists in all eight locales; `js-yaml`, `ajv` and `ajv-formats` are already `apps/api` dependencies and no OpenAPI parser is; the newest committed migration is `2026-10-25-130100-recovery-tokens-negotiated-capabilities.sql`; and both tables' `CORE_TENANT_EXPORT_POLICY` entries list every column explicitly, which is why `spec_url` must be added to one of them.
