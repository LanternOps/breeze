---
tracking_issue: LanternOps/breeze#6154
wave_issue: LanternOps/breeze#6156
branch: feature/6154-mcp-modernization/wave-6156
---
# MCP server modernization B-W02: per-grant tool domains + scope UX — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: use `superpowers:subagent-driven-development` (recommended) or `superpowers:executing-plans` to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** An API key or OAuth grant can be limited to a set of tool domains (`AI_TOOL_DOMAINS`). The external MCP server lists and runs only the tools in those domains. "All domains" is the default and today's behaviour. Clients can call a `whoami` tool to learn their access. A bearer caller that lacks a tier scope gets a spec-shaped `insufficient_scope` challenge.

**Architecture:** A nullable `mcp_domains text[]` column on `api_keys` and `oauth_grants`. `NULL` means unrestricted. The three MCP auth middlewares put it on the `apiKey` request context. The OAuth path reads it in the per-request grant query it already makes. One pure predicate in `services/mcpDomains.ts` gates every tool and resource path in `mcpServer.ts`, after the tier, approval and MFA gates that already exist. It never replaces them. Domains are a second axis on the same filter, not OAuth scopes. The OAuth scope chain (`effectiveScopes.ts`, `provider.ts` scope config, `scopes_supported`) does not change. The new code lives in three leaf modules: `mcpDomains.ts`, `mcpWhoami.ts` and `mcpAuthChallenge.ts`. The 3,043-line route file only gets call sites.

**Tech Stack:** TypeScript, Hono, Drizzle (queries only), hand-written SQL migration, Zod (`@breeze/shared`), React (Astro islands), react-i18next (8 locales), Vitest.

**Spec:** `docs/superpowers/specs/ai-mcp/2026-09-17-agent-tool-efficiency-and-mcp-modernization-design.md`, which covers "Feature B → B-W02", "Domains", Principles 3, 4 and 6, and open decision 4 (the quorum, settled below). Sources are issues #6144 (step 2 "Domains on the grant"), #2550 (the `whoami` remainder) and #6156.

**Tracking:** `get_feature_status LanternOps/breeze#6154`, then `start_wave` on #6156. The implementation PR body says `Closes #6156` and `Refs #6144 #2550`. It must not close #2550 or #6144. #2550's tier-3 half already shipped in #3031, and #6144 still has its description-diet and Skills steps. Todd closes them by hand.

**Depends on:** B-W01 (#6155, merged as #6406), which provides `buildMcpToolPresentation`, `getToolDomain` and the conformance contract. A-W02 (`domain` on every `AiTool`) is merged.

**Verified against `origin/main` `0b146d32d7`** (2026-10-17). Line numbers drift, so re-grep before editing.

---

## Advisor quorum (spec open decision 4), 2026-10-17

**Procedure.** I formed a position first: P1–P11, recorded verbatim in the PR that adds this plan. Codex `gpt-6-astra` at `xhigh`, read-only, then critiqued it against `origin/main` `0b146d32d7`. The verdicts were Q1 agree-with-changes, Q2 agree-with-changes (with a preferred alternative), Q3 agree-with-changes, Q4 agree, Q5 agree-with-changes, Q6 agree-with-changes and Q7 agree-with-changes. Each item below is labelled **adopted** (both agree, or the change was taken) or **open** (still disagreed, with both arguments and a recommendation).

## Decisions

- **D-B1 — OAuth domains go in a real column, not the grant `payload`, and the column is `text[]`, not `jsonb`.** *Adopted.*
  - oidc-provider owns `payload`. `Grant.IN_PAYLOAD` drops unknown keys on save (`oauth/adapter.ts:29-38`, `oauth/provider.ts:214-217`), which is why partner/org tenancy already lives in columns.
  - Bearer admission already reads the grant row once per request in `assertLiveOAuthUser` (`middleware/bearerTokenAuth.ts:~105`). Selecting one more column there is free, and it makes domains live: editable and revocable without re-minting a token.
  - The JWT never carries domains as authority.
  - `text[]` fits a homogeneous string set, following the `partner_service_principals.scopes` precedent. `jsonb` would add nothing.
  - The vocabulary is validated in the app. A DB CHECK that lists the 14 values would need a migration for every domain change.
  - The DB CHECK covers shape only: not empty, no `core`, no NULL element (quorum change: a NULL element makes `'core' = ANY(...)` UNKNOWN, which a CHECK accepts).
  - Unknown stored values grant nothing and never widen.
- **D-B2 — `NULL` = unrestricted, with no backfill.** *Adopted.* The column is added nullable, so every existing key and grant stays unrestricted, which is exactly today's behaviour. "Unrestricted" includes domains added later and unclassified tools. API and UI expose `mcpDomains: McpGrantableDomain[] | null`. The UI uses an explicit "All tools (including areas added later)" radio and never "nothing checked means all". This amends the spec's "empty = all" wording: no selection is no longer a storable state. **How a restricted grant is represented is Open Decision 1.**
- **D-B3 — `core` is always *domain-eligible*. It is never stored and is shown checked and disabled.** *Adopted, with the quorum's wording.* Eligibility is not authority. `resolve_device_context` is a tier-2 core tool (`services/aiToolsDevice.ts:693`), and an `ai:read`-only principal is still refused it by the existing write gate (`routes/mcpServer.ts:1648`). The domain predicate runs in addition to the scope, approval, MFA, allowlist, RBAC and rate-limit gates, never instead of them. Task 5 pins this with `'domain gate never loosens the tier gate'`.
- **D-B4 — Tier-3 over OAuth stays as it is: wholly gated is hidden, mixed is labelled.** *Adopted.* #3031 already shipped both halves of #2550's fix (`isToolWhollyGatedOverMcp` `:1174`, `gatedActionsForTool` `:1214`), and since then every effective tier 3 is `MCP_APPROVAL_REQUIRED` regardless of auth kind. B-W02 adds only #2550's optional `whoami`. B-W04 (#6158) changes tier-3 behaviour. #2550 can be closed by Todd after the implementation merges. The implementation PR uses `Refs`, not `Closes`.
- **D-B5 — API keys get domain selection; partner service principal keys stay unrestricted this wave.** *Adopted, with quorum changes.*
  - The create form gets a picker (Task 10). Editing is via REST `PATCH` (Task 8), because there is no edit dialog today.
  - **Widening** a key's domains (to `NULL`, or to a superset) runs the same delegation check the route uses for `scopes` (`validateApiKeyScopeDelegation`, `routes/apiKeys.ts:~205-228`) against the key's **current** scopes for the updater. That proves the updater could have granted the authority being restored. Narrowing needs no extra check.
  - **Org service-principal keys** live in `api_keys`, and rotation inserts a fresh row (`services/servicePrincipals.ts:118`). Rotation must carry `mcp_domains` from the key it revokes, or a rotation would silently widen it.
  - Partner service principal keys (`brz_sp_`, a separate table) are set to `mcpDomains: null` explicitly in their middleware. Their domain least privilege is a filed follow-up.
- **D-B6 — Domains are not OAuth scopes this wave.** *Adopted.* Making them scopes would touch issuance, consent and the partner-policy intersection (`oauth/effectiveScopes.ts:140`) in the hardened MCP-OAUTH-01/02 chain. Client-requested preselection and scope-driven step-up for domains are deferred. `scopes_supported` stays `mcp:read mcp:write mcp:execute`.
- **D-B7 — Step-up sends a 401 challenge always and an OAuth-only 403 behind a default-off flag.** *Adopted, with quorum changes.*
  - Every 401 carries `WWW-Authenticate: Bearer realm="breeze", resource_metadata="…", scope="mcp:read mcp:write mcp:execute"`. That includes bearer-path 401s, which today carry no challenge. All three scopes are a deliberate compatibility choice that the MCP 2025-11-25 authorization spec permits. It keeps client requests identical to today's while step-up is dormant. When the 403 is enabled by default (follow-up), revisit narrowing the 401 to `mcp:read`.
  - The existing preflight 403 for a principal without `ai:read` (`mcpServer.ts:592`) gains `error="insufficient_scope", scope="mcp:read"`. This is additive, with no status change.
  - When `MCP_INSUFFICIENT_SCOPE_HTTP_403=true`, a bearer `tools/call` refused **only** for a missing tier scope gets HTTP 403 with an `insufficient_scope` challenge naming the current ∪ required mcp scopes. The JSON-RPC error stays in the body.
  - X-API-Key callers, `domain_not_granted`, approval, MFA, RBAC, allowlist and `ai:execute_admin` denials **never** produce a scope challenge.
- **D-B8 — `whoami` is a server-intrinsic MCP tool.** *Adopted.* It needs the MCP principal context (scopes, domains, principal kind), which registry handlers do not receive. It is tier 1 and domain `core`, so it is listed for every principal. Its name is **reserved** through `registerReservedAiToolNamePredicate` (`services/aiToolNames.ts:53`), so an extension cannot register `whoami` (quorum change). `domains.available` is described as "selectable areas", not guaranteed permissions.
- **D-B9 — The domain gate covers every tool and resource path.** *Adopted, with quorum changes.*
  - It applies to `tools/list` (filtered before the catalog fingerprint at `:1439`, so stale cursors are detected), `tools/call` (after alias canonicalisation, covering core, bootstrap, tenant and extension tools), `resources/list` and `resources/read`.
  - Resource domains: `breeze://devices` is `core`, but **`breeze://devices/{id}` is `devices`**, because it exposes detail. That is a quorum change. `breeze://alerts` is `monitoring`, and `breeze://scripts` and `breeze://automations` are `scripts`.
  - Tenant tools are `integrations`. Extension and bootstrap tools are unclassified, and therefore available only to an unrestricted principal.
  - A missing `mcpDomains` field on the request context **fails closed** (core-only, logged), not open. All three middlewares set it explicitly, and the context type makes it required (quorum change).
- **D-B10 — Re-consent creates a new grant; predecessor grants are untouched.** *Adopted. The quorum asked for the semantics to be defined.* The consent route always constructs a new Grant (`routes/oauthInteraction.ts:~317`). Older refresh tokens keep their own grant and its domains (`oauth/adapter.ts:~394`).
  - The consent screen says the selection applies to *this* connection. To narrow an existing connection, the user revokes the app under Connected apps (`POST /me/oauth-clients/:clientId/revoke`, which revokes every grant for that user and client) and then reconnects.
  - Revoking predecessors automatically on re-consent would sign out the same client on the user's other devices, which is a behaviour change outside this wave.
  - Live domain edits (API keys) need no revocation-cache invalidation, because the column is read per request.
- **D-B11 — Denials and changes are audited.** *Adopted (quorum change).*
  - The `mcp_request` audit details gain `{ canonicalTool, domain, deniedReason: 'domain_not_granted' }` on a domain denial.
  - API-key create, update and rotate audit rows gain `mcpDomains` (previous and new on update).
  - The consent route's grant creation records `mcpDomains` wherever it already records the consent. If no audit event exists there, add `oauth.consent.granted` with `{ clientId, grantId, partnerId, orgId, mcpDomains }`.
- **D-B12 — Tenancy needs no new table.** *Adopted.* Both columns are `excludedOpen` in `CORE_TENANT_EXPORT_POLICY`. The existing cascade and merge registrations are sufficient (see "Tenancy contract").

## Open Decisions

1. **How is a "core-only" restriction represented?**
   - **(A) Plan default:** a restricted grant is a non-empty array of grantable domains. `[]` is rejected by CHECK and by Zod. Core-only cannot be expressed.
     - Pro: a zero-box selection is far more likely a mistake than intent, and a loud 400 beats a silently near-useless connection.
     - Pro: `[]` stays free for later.
     - Pro: the spec's "empty" never quietly means its opposite.
   - **(B) Codex preferred:** `NULL` = unrestricted and `[]` = core-only.
     - Pro: every representable state is meaningful.
     - Pro: a code path that accidentally writes `[]` lands on least privilege (fail-closed) instead of an error.
     - Pro: a "discovery only" connection (`query_devices`, `list_organizations`, `search_documentation`, `whoami`) becomes possible.
   - **Recommend A.** Core-only has no demonstrated user, A is fail-closed too (it errors), and A can migrate to B later without data change. B cannot migrate back if core-only rows exist.
   - If Todd picks B, the deltas are: drop `cardinality > 0` from both CHECKs, change `.min(1)` to `.min(0)` in `mcpDomainsInputSchema`, let the picker allow zero boxes, and add one test row per layer.
2. **Does the insufficient-scope 403 apply to the legacy HTTP+SSE transport?**
   - **(A) Plan default:** no. A legacy `/message` request with a verified session keeps 202, and its JSON-RPC error is queued to the stream.
     - Reason: that transport belongs to protocol `2024-11-05`, which predates the MCP authorization spec.
     - Reason: answering the POST with 403 would mean the stream never receives a response for that request id.
     - Reason: the 403 is dormant anyway.
   - **(B) Codex:** intercept before enqueueing, so both transports return the 403 challenge.
   - **Recommend A.** Revisit only if a client on the legacy transport is shown to implement step-up.
   - The B delta is to call `applyInsufficientScopeChallenge` before the `session.queue.push` at `mcpServer.ts:~746` and return early.

---

## Global Constraints

- **Commands.** Run API unit tests with `cd apps/api && npx vitest run <path>`. The path is a substring match, so check the file count in the output. Never use `pnpm --filter <pkg> test -- --run <path>`. Typecheck with `cd apps/api && NODE_OPTIONS=--max-old-space-size=12288 npx tsc --noEmit -p tsconfig.json; echo "exit=$?"`. Read the exit code and never pipe it to `tail`. Do the same for `apps/web` and `packages/shared`. Web tests: `cd apps/web && npx vitest run <path>`.
- **Integration suites do not run under `pnpm test`.** The export-policy, erasure-roundtrip, org-merge and RLS-coverage suites run only under the integration and RLS configs (`docs/agents/testing.md:41`). Run them on a per-worktree stack before the PR (Task 11). CI's 16-shard `integration-test` job is what blocks the PR.
- **Never weaker than today.** The domain gate is evaluated in addition to the existing gates and never instead of them: scope tier, `isMcpApprovalRequired`, the MFA gate, the production allowlist, RBAC (`checkToolPermission`), rate limits and the site axis. An unrestricted principal (`mcp_domains IS NULL`) must produce byte-identical `tools/list` output to `main`. The conformance contract and a snapshot test pin this.
- **Listed ⇒ callable** (#3031, #6401). Anything `tools/list` or `resources/list` hides for a domain reason is refused by `tools/call` or `resources/read` for the same principal. Anything listed passes the domain gate. A contract test enumerates this (Task 5).
- **Never rename a tool** (spec principle 6). The domain gate runs on the canonical name, after `resolveDeprecatedToolAlias`.
- **No secrets in `whoami`.** It never returns the key hash, the raw key prefix, the JWT, refresh-token ids or the grant `payload`. It may return the key/grant display name and ids that `MyConnectedAppsPage` / `ApiKeyList` already show the same user.
- **REST is untouched.** `mcp_domains` affects `/api/v1/mcp/*` only. An API key with `devices:read` keeps its full REST behaviour whatever its domains are. The docs say so.
- **The in-app agent is untouched.** Web chat, Helper and agent runs do not read `mcp_domains`.
- **Public repo.** No customer names, hostnames or IPs in code, tests, docs or the PR.
- **Commit after every task.** Trailer:
  ```
  Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>
  ```

## Tenancy contract (read `docs/agents/tenancy-rls.md` first)

| Item | Decision |
|---|---|
| New tables | **None.** |
| New columns | `api_keys.mcp_domains text[] NULL` and `oauth_grants.mcp_domains text[] NULL` |
| `api_keys` shape | Shape 1, org-scoped. The `breeze_has_org_access(org_id)` per-command policies (`0001-baseline.sql`) are unchanged. A new column needs no policy change. |
| `oauth_grants` shape | Shape 6, user-id scoped. The `oauth_grants_partner_access` policy (`2026-05-03-oauth-token-user-rls.sql:35-47`) is unchanged. The table has `org_id`, so it is in the cascade and export registries. |
| `CORE_TENANT_EXPORT_POLICY` (`services/tenantExportPolicyRegistry.ts`) | Add `"mcp_domains"` to **`excludedOpen`** for both `api_keys` (`:209`) and `oauth_grants` (`:658`). A domain list is a capability list (tenancy-rls.md:47-51). It travels with the key/grant it restricts, and both of those are already excluded or recreated on import, never round-tripped. |
| `CORE_ORG_CASCADE_DELETE_ORDER` (`services/tenantCascade.ts:408,766`) | No change. A column add on tables that are already registered. |
| `orgMergeRegistry.ts` (`:748` custom `api_keys`, `:1079` `oauth_grants` repoint) | No change. Repoint and revoke carry the column with the row. Verify `orgMergeCustomExecutors.ts:1149` `buildRepoint('api_keys', …)` does not enumerate columns. It does not on `0b146d32d7`. |
| Device / ticket lists | Not applicable (no `device_id` / `ticket_id`). |
| RLS coverage | Fires only on table-level policy changes, so nothing new is expected. Run it anyway (Task 11). |

## Migration

`apps/api/migrations/2026-12-30-180000-mcp-tool-domains.sql` is free on `0b146d32d7` and sorts after the newest migration, `2026-12-30-120700-portal-branding-trust-page-editing.sql`. Re-check before committing with `bash scripts/check-migration-naming.sh --staged --against-ref origin/main`. If the hook rejects the slot, keep the `2026-12-30-` prefix, take the next free `HHMMSS` and say so in the PR body.

```sql
-- B-W02 (#6156): per-grant MCP tool domains. NULL = unrestricted (every
-- domain, including domains added later and unclassified tools). A restricted
-- principal stores a non-empty set of grantable domains; 'core' is implicit
-- and never stored. Vocabulary is validated in the app (AI_TOOL_DOMAINS);
-- unknown stored values grant nothing at read time.
ALTER TABLE api_keys     ADD COLUMN IF NOT EXISTS mcp_domains text[];
ALTER TABLE oauth_grants ADD COLUMN IF NOT EXISTS mcp_domains text[];

DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'api_keys_mcp_domains_shape_check') THEN
    ALTER TABLE api_keys ADD CONSTRAINT api_keys_mcp_domains_shape_check CHECK (
      mcp_domains IS NULL OR (cardinality(mcp_domains) > 0 AND NOT ('core' = ANY (mcp_domains)) AND array_position(mcp_domains, NULL) IS NULL)
    );
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'oauth_grants_mcp_domains_shape_check') THEN
    ALTER TABLE oauth_grants ADD CONSTRAINT oauth_grants_mcp_domains_shape_check CHECK (
      mcp_domains IS NULL OR (cardinality(mcp_domains) > 0 AND NOT ('core' = ANY (mcp_domains)) AND array_position(mcp_domains, NULL) IS NULL)
    );
  END IF;
END $$;
```

The migration writes no rows, so there is no `set_config('breeze.scope','system',true)` and `migrationRlsScope.test.ts` stays green. There is no backfill: every existing key and grant stays `NULL`, which means unrestricted and is today's behaviour. There is no inner `BEGIN`/`COMMIT`. Then run `pnpm db:check-drift`.

## Review Focus

These are the five inputs the spec implies but no happy-path test hits. Each one has a pinned test in the task that owns it.

1. **Deprecated alias against a restricted grant.** A `tools/call` that uses an old tool name whose canonical tool is outside the grant must be refused as `domain_not_granted`, not dispatched. Pinned in Task 5: `'a deprecated alias is gated on its canonical tool's domain'`.
2. **A stored domain that is no longer in `AI_TOOL_DOMAINS`.** This happens after a future rename or removal, or a hand-edited row. It must grant nothing, and it must not crash or turn into "unrestricted". `['tickets','legacy_x']` behaves as `['tickets']`, and `['legacy_x']` behaves as core-only. Pinned in Task 3: `'unknown stored values grant nothing and never widen'`.
3. **Re-consent for the same client.** The consent route always constructs a new Grant (`oauthInteraction.ts:~317`). Tokens minted from the older grant keep the older grant's domains until it expires or is revoked. Neither token may see the other's set. Pinned in Task 4: `'two grants for one client resolve their own domains'`.
4. **Legacy HTTP+SSE transport.** A `/message` request with a verified session pushes its JSON-RPC response into the stream and returns 202 (`mcpServer.ts:~746`). A domain denial must arrive in that stream as a JSON-RPC error. The step-up 403 must never replace the 202. Pinned in Task 7: `'legacy SSE path keeps 202 and queues the error'`.
5. **Tenant (BYO MCP) and unclassified tools under a restricted grant.** Tenant tools count as `integrations`. Extension tools (no `domain` in `ExtensionAiTool`) and bootstrap auth tools are unclassified and appear only for an unrestricted principal. Pinned in Task 5: `'tenant tools follow integrations; unclassified tools need an unrestricted grant'`.

---

## File Structure

| File | Responsibility |
|---|---|
| `packages/shared/src/types/aiToolDomains.ts` (modify) | `MCP_GRANTABLE_DOMAINS` (the 13 non-core domains) and `McpGrantableDomain` |
| `packages/shared/src/validators/mcpDomains.ts` (create) + `validators/index.ts` export | `mcpDomainsInputSchema` (Zod) and `normalizeMcpDomainsInput` |
| `apps/api/migrations/2026-12-30-180000-mcp-tool-domains.sql` (create) | The two columns and their shape checks |
| `apps/api/src/db/schema/apiKeys.ts`, `schema/oauth.ts` (modify) | `mcpDomains: text('mcp_domains').array()` |
| `apps/api/src/services/tenantExportPolicyRegistry.ts` (modify) | `excludedOpen += mcp_domains` on both tables |
| `apps/api/src/services/mcpDomains.ts` (create) | Parses the stored value into a grant, holds the predicate, maps resources to domains and builds the denial payload |
| `apps/api/src/middleware/apiKeyAuth.ts`, `bearerTokenAuth.ts`, `partnerServicePrincipalMcpAuth.ts` (modify) | Put `mcpDomains` on the `apiKey` context |
| `apps/api/src/routes/mcpServer.ts` (modify) | Call sites: list/call/tenant/bootstrap/resources, the `whoami` dispatch and the challenge headers |
| `apps/api/src/services/mcpWhoami.ts` (create) | Pure builder for the `whoami` result, plus its tool definition |
| `apps/api/src/services/mcpAuthChallenge.ts` (create) | `WWW-Authenticate` builders and the insufficient-scope classifier |
| `apps/api/src/routes/apiKeys.ts` (modify) | `mcpDomains` on create/patch/list/get, plus the widening delegation check |
| `apps/api/src/services/servicePrincipals.ts` (modify) | Org service-principal key rotation carries `mcp_domains` |
| `apps/api/src/oauth/adapter.ts`, `routes/oauthInteraction.ts` (modify) | The consent body carries `mcp_domains`, and `setGrantBreezeMeta` persists it |
| `apps/web/src/components/oauth/ConsentForm.tsx` (modify) | The "Tool access" section |
| `apps/web/src/components/shared/McpDomainPicker.tsx` (create) | A radio (all or selected) plus 13 checkboxes, used by consent and the API-key form |
| `apps/web/src/components/settings/ApiKeyForm.tsx`, `ApiKeyList.tsx` (modify) | Domain picker when an `ai:*` scope is checked, and a list badge |
| `apps/web/src/locales/*/common.json` (8 files, modify) | New keys, kept in locale parity |
| `apps/docs/src/content/docs/features/mcp-server.mdx`, `reference/api-keys.mdx` (modify) | User docs |
| `docs/superpowers/plans/ai-mcp/2026-09-17-agent-tool-efficiency-and-mcp-modernization.md` (modify) | Index row status |

---

### Task 1: Shared vocabulary and validator

**Files:**
- Modify: `packages/shared/src/types/aiToolDomains.ts`
- Create: `packages/shared/src/validators/mcpDomains.ts`, `packages/shared/src/validators/mcpDomains.test.ts`
- Modify: `packages/shared/src/validators/index.ts` (one `export * from './mcpDomains'`)

**Interfaces:**
- Produces:
  - `MCP_GRANTABLE_DOMAINS: readonly McpGrantableDomain[]`, which is `AI_TOOL_DOMAINS` minus `'core'`, in `AI_TOOL_DOMAINS` order
  - `type McpGrantableDomain = Exclude<AiToolDomain, 'core'>`
  - `mcpDomainsInputSchema: z.ZodType<McpGrantableDomain[] | null>`
  - `normalizeMcpDomainsInput(v: McpGrantableDomain[] | null): McpGrantableDomain[] | null`. It dedupes, sorts in `MCP_GRANTABLE_DOMAINS` order, and maps a list that contains every grantable domain to `null`. The reason: "all 13 today" and "all, including future ones" must not silently differ.

- [ ] **Step 1: Write the failing tests** in `mcpDomains.test.ts`:
  - `'grantable domains are the 13 non-core domains'`: `expect(MCP_GRANTABLE_DOMAINS).toHaveLength(13); expect(MCP_GRANTABLE_DOMAINS).not.toContain('core')`.
  - `'accepts null and a non-empty grantable list'`: `parse(null) === null`, and `parse(['tickets'])` equals `['tickets']`.
  - `'rejects [], core, unknown values and over-long input'`: `safeParse([]).success === false`, `safeParse(['core']).success === false`, `safeParse(['psa']).success === false`, and `safeParse(Array(14).fill('tickets')).success === false` (max 13 before dedupe is enough).
  - `'normalizes order and duplicates; every-domain collapses to null'`: `normalizeMcpDomainsInput(['tickets','devices','tickets'])` equals `['devices','tickets']`, and `normalizeMcpDomainsInput([...MCP_GRANTABLE_DOMAINS])` is `null`.
- [ ] **Step 2: Run them and watch them fail.** Run `cd packages/shared && npx vitest run src/validators/mcpDomains`. Expected: FAIL (module not found).
- [ ] **Step 3: Implement.** The schema is `z.array(z.enum(MCP_GRANTABLE_DOMAINS)).min(1).max(13).nullable()`.
- [ ] **Step 4: Run them again.** Expected: PASS. Then typecheck `packages/shared` and read the exit code.
- [ ] **Step 5: Commit** with `feat(shared): MCP grantable tool domains + validator (#6156)`.

---

### Task 2: Migration, Drizzle columns, export-policy classification

**Files:**
- Create: `apps/api/migrations/2026-12-30-180000-mcp-tool-domains.sql` (text in "Migration" above)
- Modify: `apps/api/src/db/schema/apiKeys.ts`, `apps/api/src/db/schema/oauth.ts`, `apps/api/src/services/tenantExportPolicyRegistry.ts`
- Create: `apps/api/src/__tests__/integration/mcpDomainsColumns.integration.test.ts`

**Interfaces:**
- Produces: `apiKeys.mcpDomains` and `oauthGrants.mcpDomains`, both typed `string[] | null`, via `text('mcp_domains').array().$type<string[] | null>()`. The schema declares no Drizzle `check()`, because the migration owns it. That follows the `partnerServicePrincipals.ts` precedent only if drift tooling needs it, so re-check `pnpm db:check-drift`.

- [ ] **Step 1: Write the failing integration test.** Use the integration harness (`setup.ts`) and system context. Its cases:
  - `'api_keys accepts NULL and a non-empty set'`
  - `'api_keys rejects an empty array'`, which expects the error to match `/api_keys_mcp_domains_shape_check/`
  - `'api_keys rejects core'`
  - `'api_keys rejects a NULL element'`
  - The same four cases for `oauth_grants`, inserting a grant with a seeded user and client
- [ ] **Step 2: Add the export-policy entries first.** Add `"mcp_domains"` to `excludedOpen` on both tables. This is how an implementer sees the export suite go red: on a stack migrated *with* the new file and *without* the registry edit, `tenant-export-policy.integration.test.ts` reports `mcp_domains` as unclassified. Reproduce that red once and note it in the commit body. Then add the entries.
- [ ] **Step 3: Write the migration and Drizzle columns.**
- [ ] **Step 4: Run the checks.** Run `bash scripts/check-migration-naming.sh --staged --against-ref origin/main` and `pnpm db:check-drift`, then the new integration test plus `tenant-export-policy` and `tenantExportErasureRoundtrip` on the worktree stack (Task 11 has the commands). Expected: all PASS.
- [ ] **Step 5: Commit** with `feat(db): mcp_domains on api_keys and oauth_grants (#6156)`.

---

### Task 3: `services/mcpDomains.ts`, the one predicate

**Files:**
- Create: `apps/api/src/services/mcpDomains.ts`, `apps/api/src/services/mcpDomains.test.ts`
- Modify: `apps/api/src/services/aiToolNames.ts` (the `MCP_WHOAMI_TOOL_NAME` constant and its reserved-name predicate)

**Interfaces:**
- Consumes: `MCP_GRANTABLE_DOMAINS`, `isAiToolDomain` and `AiToolDomain` from `@breeze/shared`, and `getToolDomain` from `services/aiTools.ts`.
- Produces:
  - `type McpDomainGrant = { restricted: false } | { restricted: true; domains: ReadonlySet<McpGrantableDomain> }`
  - `parseStoredMcpDomains(raw: unknown): McpDomainGrant`. Only `null` means unrestricted. `undefined` (a middleware forgot the field) **fails closed** to `{ restricted: true, domains: ∅ }`, which is core-only, and logs `console.error('[MCP] principal context missing mcpDomains')` (D-B9). So does any non-array value. An array keeps only known grantable values. An array that held only unknown values is `{ restricted: true, domains: ∅ }`.
  - `isDomainGranted(grant: McpDomainGrant, domain: AiToolDomain | undefined): boolean`. `'core'` always passes. `undefined` (unclassified) passes only when unrestricted.
  - `MCP_WHOAMI_TOOL_NAME = 'whoami'` is declared in `services/aiToolNames.ts`, a leaf already imported by `aiTools.ts`. In the same file, call `registerReservedAiToolNamePredicate((n) => n === MCP_WHOAMI_TOOL_NAME)` at module load, so extensions can never claim the name (D-B8). Putting it here avoids an `aiTools` ↔ `mcpDomains` / `mcpWhoami` import cycle.
  - `mcpToolDomain(toolName: string): AiToolDomain | undefined`. This is `MCP_WHOAMI_TOOL_NAME` mapped to `'core'`, otherwise `getToolDomain(toolName)`.
  - `MCP_TENANT_TOOL_DOMAIN: AiToolDomain = 'integrations'`
  - `mcpResourceDomain(uri: string): AiToolDomain | undefined` maps:
    - `breeze://devices` → `'core'` (the list is already core via `query_devices`)
    - `breeze://devices/<id>` → `'devices'` (detail, D-B9)
    - `breeze://alerts` → `'monitoring'`
    - `breeze://scripts` and `breeze://automations` → `'scripts'`
    - Any other URI returns `undefined`.
  - `buildDomainNotGrantedError(toolOrUri: string, domain: AiToolDomain | undefined): { code: -32003; message: string; data: { reason: 'domain_not_granted'; domain: AiToolDomain | 'unclassified'; hint: string } }`. The message is `Tool "<name>" is in the "<domain>" domain, which this connection was not granted. Call whoami to see granted domains; reconnect or edit the API key to add it.`

- [ ] **Step 1: Write the failing tests.**
  - `'null is unrestricted; undefined and non-arrays fail closed to core-only'`
  - `'device detail resource is devices, device list is core'`
  - `'core is always granted'`: `isDomainGranted(parseStoredMcpDomains(['tickets']), 'core') === true`
  - `'a restricted grant passes only its domains'`: tickets passes and devices fails
  - `'unclassified passes only when unrestricted'`
  - `'unknown stored values grant nothing and never widen'`: `['tickets','legacy_x']` behaves as `{tickets}`, and `['legacy_x']` behaves as core-only, not unrestricted
  - `'every MCP resource URI family has a domain'`: iterate the URIs `handleResourcesList` returns plus a `breeze://devices/<uuid>`, and expect each to be defined
  - `'every registered core tool resolves a domain'`: for each `getAllRegisteredToolNames()`, `mcpToolDomain(name)` is defined. This protects the "unclassified ⇒ unrestricted only" rule from swallowing a core tool.
- [ ] **Step 2: Run** `cd apps/api && npx vitest run src/services/mcpDomains`. Expected: FAIL.
- [ ] **Step 3: Implement.** The module is pure apart from the `getToolDomain` import, with no DB access.
- [ ] **Step 4: Run again.** Expected: PASS.
- [ ] **Step 5: Commit** with `feat(mcp): mcpDomains predicate (#6156)`.

---

### Task 4: Carry `mcpDomains` on every MCP principal

**Files:**
- Modify: `apps/api/src/middleware/apiKeyAuth.ts` (select `apiKeys.mcpDomains` at `:117-133`, `c.set('apiKey', { …, mcpDomains })` at `:309`)
- Modify: `apps/api/src/middleware/bearerTokenAuth.ts`. `assertLiveOAuthUser` (`:79-163`) adds `mcpDomains: oauthGrants.mcpDomains` to its existing single select, and the success result gains `grantMcpDomains: string[] | null`. The middleware's `c.set('apiKey', …)` (`:~497`) passes it on, and `OAuthApiKeyContext` gains the field.
- Modify: `apps/api/src/middleware/partnerServicePrincipalMcpAuth.ts` (`:225`, `mcpDomains: null`; see Decisions)
- Modify: `apps/api/src/routes/mcpServer.ts`. `McpApiKeyContext` (`:355`) gains a **required** `mcpDomains: readonly string[] | null`. Typecheck then lists every construction site. Fix each test fixture to pass `mcpDomains: null` explicitly, because a missing field now fails closed (D-B9). Expect fixture churn across the `mcpServer.*.test.ts` files, and keep it in this task's commit.
- Test: `apiKeyAuth.test.ts`, `bearerTokenAuth.test.ts`, `partnerServicePrincipalMcpAuth.test.ts` (if absent, add the case to the nearest existing SP auth test)

**Interfaces:**
- Produces: `c.get('apiKey').mcpDomains: readonly string[] | null`, always present (never `undefined`) after any of the three middlewares. `mcpServer.ts` calls `parseStoredMcpDomains(apiKey?.mcpDomains)` once per request.

- [ ] **Step 1: Write the failing tests.**
  - apiKeyAuth: `'sets mcpDomains from the key row'` (row `['tickets']` gives the context `['tickets']`) and `'NULL row sets mcpDomains null'`.
  - bearerTokenAuth: `'mcpDomains comes from the grant row in the same live query'`. The mocked select chain returns `{ …, grantActive: true, mcpDomains: ['devices'] }`, and the test asserts that the context has `['devices']` and that the select ran exactly once. That second assertion guards the "one round-trip" invariant in `assertLiveOAuthUser`'s comment.
  - bearerTokenAuth: `'two grants for one client resolve their own domains'`. Two tokens with the same `client_id` and different `grant_id` get mocked rows `['devices']` and `null`, and each context carries its own grant's value.
  - SP auth: `'partner service principal keys are unrestricted'` (`mcpDomains === null`, present rather than `undefined`).
- [ ] **Step 2: Run** `cd apps/api && npx vitest run src/middleware/apiKeyAuth src/middleware/bearerTokenAuth src/middleware/partnerServicePrincipalMcpAuth`. Expected: the new cases FAIL.
- [ ] **Step 3: Implement.** Do not add a second query on the bearer path.
- [ ] **Step 4: Run again.** Expected: PASS. Run the whole `src/middleware` folder, because the select-chain mocks are shared.
- [ ] **Step 5: Commit** with `feat(mcp): carry mcp_domains on the MCP principal context (#6156)`.

---

### Task 5: Enforce in `tools/list`, `tools/call`, tenant, bootstrap and resources

**Files:**
- Modify: `apps/api/src/routes/mcpServer.ts`
  - `handleJsonRpc` (`:1036`) computes `const domainGrant = parseStoredMcpDomains(apiKey?.mcpDomains)` once and passes it to the handlers.
  - `handleToolsList` (`:1305`): in the `scopedTools.filter`, after the existing gates, `&& isDomainGranted(domainGrant, mcpToolDomain(tool.name))`. On the tenant list (`:1418`), `.filter(… && isDomainGranted(domainGrant, MCP_TENANT_TOOL_DOMAIN))`.
  - `handleToolsCall` (`:1509`): call the gate immediately after `resolveDeprecatedToolAlias` (`:1540`) and before the bootstrap branch. A bootstrap tool is unclassified (`mcpToolDomain` returns `undefined`), so it is denied for a restricted principal before its own approval deny. If the domain is not granted, return `jsonRpcError(id, err.code, err.message, err.data)` with `err = buildDomainNotGrantedError(...)`. For a name that is unknown to every registry, keep today's `Unknown tool` (-32602) response. Never reply with "not granted" for a name that does not exist, since that would let a caller enumerate tool names.
  - `handleTenantToolCall` (`:1843`): the same gate, with `MCP_TENANT_TOOL_DOMAIN`, at its top.
  - `handleResourcesList` (`:2463`): becomes `handleResourcesList(id, domainGrant)` and filters by `mcpResourceDomain`.
  - `handleResourcesRead` (`:2649`): runs the gate before `findMcpResourcePermission`. A denial returns -32003 with the same `data` shape.
  - `dispatchAndAudit` (`:653`): when `response.error?.data?.reason === 'domain_not_granted'`, merge `{ canonicalTool, domain, deniedReason }` into the audit `details` (D-B11).
- Create: `apps/api/src/routes/mcpServer.domains.test.ts` (the `__handleJsonRpcForTests` / `__handleToolsListForTests` harness, mocked like `mcpServer.test.ts`)
- Modify: `apps/api/src/routes/mcpServer.conformance.contract.test.ts` (add one unrestricted-equivalence case)

**Interfaces:**
- Consumes: Task 3 (`parseStoredMcpDomains`, `isDomainGranted`, `mcpToolDomain`, `MCP_TENANT_TOOL_DOMAIN`, `mcpResourceDomain`, `buildDomainNotGrantedError`) and Task 4 (`apiKey.mcpDomains`).
- Produces: JSON-RPC error code **-32003** with `data.reason === 'domain_not_granted'`. Task 7 checks that this is not reclassified as a scope error.

- [ ] **Step 1: Write the failing tests** in `mcpServer.domains.test.ts`:
  - `'unrestricted principal lists exactly what main lists'`: the names from `mcpDomains: null` equal a frozen fixture captured from `main` with the same mocks. Capture it in Step 1, before any production edit.
  - `'missing mcpDomains on the context fails closed to core'`
  - `'a cursor issued before a domain edit is rejected as stale'`: with `MCP_TOOLS_LIST_PAGE_SIZE=20`, page 1 is fetched under `null`, then page 2 is requested under `['tickets']` with the same principal id, and the result is -32602 "Tools list changed…".
  - `'domain denial is audited with canonical tool and domain'`: the `writeAuditEvent` mock receives `details.deniedReason === 'domain_not_granted'`, together with `canonicalTool` and `domain`.
  - `'restricted principal lists only granted domains plus core'`: with `['tickets']`, every listed name has `mcpToolDomain ∈ {core, tickets}`, `query_devices` is present, and at least one `devices`-domain tool is absent.
  - `'listed ⇒ callable, unlisted ⇒ domain_not_granted'`: for each single grantable domain `d`, list with `[d]`. For **every** name in `getToolDefinitions()`, call it with minimal args. A listed name must never get -32003. An unlisted name whose domain is outside `{core, d}` must get -32003 when every other gate would pass (use an `ai:execute` scope and mock `checkToolPermission` to allow, so the domain gate is the reason).
  - `'a deprecated alias is gated on its canonical tool's domain'`: pick an entry from `services/aiToolAliases.ts` whose canonical domain is not `tickets`, and expect -32003 under `['tickets']`.
  - `'unknown tool names stay Unknown tool, never domain_not_granted'`
  - `'tenant tools follow integrations; unclassified tools need an unrestricted grant'`: mock `liveResolveTenantTools` to return a tier-1 descriptor. Under `['tickets']` it is absent and the call is -32003. Under `['integrations']` it is present. A bootstrap auth tool called under `['accounts']` is -32003, and under `null` it is still `MCP_APPROVAL_REQUIRED`, which is unchanged.
  - `'resources/list and resources/read follow resource domains'`: under `['tickets']`, `resources/list` returns only `breeze://devices`, and reading `breeze://alerts` is -32003.
  - `'domain gate never loosens the tier gate'`: under `['devices']` with `ai:read` only, a tier-2 devices tool is still absent and still refused with the existing `requires ai:write scope`.
- [ ] **Step 2: Run** `cd apps/api && npx vitest run src/routes/mcpServer.domains`. Expected: FAIL.
- [ ] **Step 3: Implement** the call sites listed above. The order inside `handleToolsCall` is: name present → tenant dispatch → alias resolve → **domain gate** → bootstrap → unknown-tool → guardrails → approval gate → scope gates → allowlist → RBAC → rate limit. The domain gate returns before `checkGuardrails` runs. That is safe because guardrails are pure, and it means a restricted principal learns nothing about action-level tiers of tools it cannot use.
- [ ] **Step 4: Run** `cd apps/api && npx vitest run src/routes/mcpServer`, which runs all `mcpServer.*` files (about 23; check the count). Expected: PASS.
- [ ] **Step 5: Commit** with `feat(mcp): enforce per-grant tool domains on list, call and resources (#6156)`.

---

### Task 6: `whoami`

**Files:**
- Create: `apps/api/src/services/mcpWhoami.ts`, `apps/api/src/services/mcpWhoami.test.ts`
- Modify: `apps/api/src/routes/mcpServer.ts`. `handleToolsList` appends the `whoami` definition with `buildMcpToolPresentation(def, 1, 'core')`, sorted with the core tools. `handleToolsCall` dispatches `MCP_WHOAMI_TOOL_NAME` right after alias resolution, before the domain gate (it is core) and before the registry lookup.
- Modify: `apps/api/src/routes/mcpServer.conformance.contract.test.ts` (whoami appears and carries title, annotations and `_meta`)

**Interfaces:**
- Consumes: `McpDomainGrant`, `MCP_GRANTABLE_DOMAINS`, `AI_TOOL_DOMAIN_LABELS`, `shouldRequireExecuteAdminInProd`, `isUnattendedTier3PrincipalOverMcp`, `mfaGateRefusesCaller`. Export the two route-local helpers as `__…ForWhoami` only if needed; prefer passing their results in.
- Consumes also: `MCP_WHOAMI_TOOL_NAME` (Task 3, `aiToolNames.ts`).
- Produces:
  - `MCP_WHOAMI_TOOL_DEFINITION: { name; description; input_schema: { type: 'object', properties: {}, additionalProperties: false } }`. The description, at most 200 characters, is `Describe this connection's Breeze access: who it acts as, tenant scope, granted scopes and tool domains, and which actions need the Breeze web app. Call it before assuming a tool is missing.`
  - `buildWhoamiResult(input: WhoamiInput): WhoamiResult`, where
    ```ts
    type WhoamiInput = {
      principal: { kind: 'api_key' | 'oauth' | 'partner_service_principal'; id: string; name: string | null; clientId: string | null };
      tenant: { scope: 'organization' | 'partner'; partnerId: string | null; orgId: string | null };
      scopes: string[];                 // effective ai:* and mcp:* as the server sees them
      domainGrant: McpDomainGrant;
      approvalGate: { tier3RequiresWebApp: boolean; unattendedPrincipal: boolean };
      mfaGatedActionsUnavailable: boolean;
    };
    type WhoamiResult = WhoamiInput['principal'] & {
      tenant: WhoamiInput['tenant'];
      capability: 'read' | 'write' | 'execute';
      scopes: string[];
      domains: { restricted: boolean; granted: AiToolDomain[]; available: AiToolDomain[] }; // granted includes 'core'; unrestricted ⇒ granted = all 14
      notes: string[];                  // e.g. tier-3 needs the web app; MFA-gated actions unavailable; how to widen
    };
    ```
  - `capability` is `'execute'` if `ai:execute` is held, otherwise `'write'` if `ai:write`, otherwise `'read'`. `principal.kind` comes from `apiKey`: `oauthGrantId` set means `'oauth'`, `partnerServicePrincipalId` set means `'partner_service_principal'`, anything else is `'api_key'`. For OAuth, `id` is the grant id and `name` is the client name if it is already on the context, otherwise `null`. The tool does no extra DB read.

- [ ] **Step 1: Write the failing tests** (`mcpWhoami.test.ts`):
  - `'capability ladder'`
  - `'unrestricted grant reports all 14 domains'`
  - `'restricted grant reports granted + core, available = 14'`
  - `'notes mention the web app when tier-3 is gated'`
  - `'never contains secret-shaped fields'`: `JSON.stringify(result)` has none of `keyHash|key_hash|payload|refresh|jwt|token`, as a regex on keys
  - In `mcpServer.domains.test.ts`: `'whoami is listed and callable for every principal kind, including a core-only grant'`, and `'whoami result matches the live gate'`. For a `['tickets']` grant, `domains.granted` equals the set of domains that appear in that principal's `tools/list`, minus domains with zero listed tools.
- [ ] **Step 2: Run** `cd apps/api && npx vitest run src/services/mcpWhoami src/routes/mcpServer.domains src/routes/mcpServer.conformance`. Expected: FAIL.
- [ ] **Step 3: Implement.**
  - The name is already reserved by Task 3 (`aiToolNames.ts`).
  - Test `'an extension cannot register whoami'`: `extensionContributionRegistry` rejects it.
  - Test `'no registry tool is named whoami'`: `getToolTier('whoami') === undefined`.
  - `notes` describe `domains.available` as "areas you can ask to be granted", not as permissions (D-B8).
- [ ] **Step 4: Run again.** Expected: PASS.
- [ ] **Step 5: Commit** with `feat(mcp): whoami capability tool (#6156, #2550)`.

---

### Task 7: `WWW-Authenticate` scope and the `insufficient_scope` step-up

**Files:**
- Create: `apps/api/src/services/mcpAuthChallenge.ts`, `apps/api/src/services/mcpAuthChallenge.test.ts`
- Modify: `apps/api/src/routes/mcpServer.ts`
  - `setWwwAuthenticate` (`:152`) uses `buildBearerChallenge()`.
  - The scope-gate denials in `handleToolsCall` (`:1642-1650`) and `handleTenantToolCall` (`:~1921-1930`) attach `data: { reason: 'insufficient_scope', requiredScope }` to the existing -32603 errors. The message text does not change, because existing tests pin it.
  - The two HTTP response sites (`:~754` legacy `/message` without a session, and `:~1006` streamable) call `applyInsufficientScopeChallenge(c, apiKey, response)` before `c.json(response)`. The queued legacy-session branch (`:~746`) does not; see Open Decision 2.
  - The preflight 403 for a missing `ai:read` (`:592`) always adds `WWW-Authenticate: buildBearerChallenge({ error: 'insufficient_scope', scope: ['mcp:read'] })` when the caller is a bearer. This is additive (the status is already 403) and not flagged.
- Modify: `apps/api/src/middleware/bearerTokenAuth.ts`. Bearer-path 401s gain the same challenge header via the shared builder. They have none today, so a client that sends an expired token learns nothing about where to re-authorize.
- Test: `mcpServer.stepUp.test.ts` (create), `bearerTokenAuth.test.ts`

**Interfaces:**
- Produces:
  - `buildBearerChallenge(opts?: { error?: 'invalid_token' | 'insufficient_scope'; scope?: string[] }): string`. It always includes `realm="breeze"` and `resource_metadata="<OAUTH_ISSUER>/.well-known/oauth-protected-resource"`. With no `scope` given, it uses `scope="mcp:read mcp:write mcp:execute"`, which is today's `scopes_supported`, so clients request the same thing they request now.
  - `requiredMcpScopesFor(aiScope: 'ai:write' | 'ai:execute'): string[]` maps `ai:write` to `['mcp:write']` and `ai:execute` to `['mcp:execute']`. There is no mapping for `ai:execute_admin`, which OAuth can never grant (`bearerTokenAuth.ts:188`), so it never produces a step-up.
  - `applyInsufficientScopeChallenge(c: Context, apiKey: McpApiKeyContext | undefined, response: JsonRpcResponse): void`. It does nothing unless **all** of these hold: env `MCP_INSUFFICIENT_SCOPE_HTTP_403 === 'true'` (read per call, default off), the principal is an OAuth bearer (`apiKey.oauthGrantId`), `response.error?.data?.reason === 'insufficient_scope'`, and `requiredScope` maps to an mcp scope. When all hold, it sets HTTP status 403 and `WWW-Authenticate: buildBearerChallenge({ error: 'insufficient_scope', scope: current mcp scopes ∪ required })`. The body stays the JSON-RPC error. A `domain_not_granted` error is never turned into a 403.

- [ ] **Step 1: Write the failing tests.**
  - `mcpAuthChallenge.test.ts`: `'default challenge carries realm, resource_metadata and the three mcp scopes'`, `'insufficient_scope challenge names current ∪ required'`, `'execute_admin never maps to a step-up scope'`.
  - `mcpServer.stepUp.test.ts`:
    - `'flag off: bearer tier-scope denial stays HTTP 200 with JSON-RPC error'`
    - `'flag on: bearer missing mcp:write gets 403 + insufficient_scope challenge, body unchanged'`
    - `'flag on: X-API-Key callers never get 403'`
    - `'flag on: domain_not_granted never becomes 403'`
    - `'legacy SSE path keeps 202 and queues the error'`
    - `'401 without credentials carries scope="mcp:read mcp:write mcp:execute"'`
    - `'bearer without mcp:read gets the preflight 403 with an insufficient_scope mcp:read challenge (flag-independent)'`
    - `'approval, MFA, RBAC and execute_admin denials never carry insufficient_scope'`
  - `bearerTokenAuth.test.ts`: `'expired-token 401 carries the bearer challenge'`.
- [ ] **Step 2: Run** `cd apps/api && npx vitest run src/services/mcpAuthChallenge src/routes/mcpServer.stepUp src/middleware/bearerTokenAuth`. Expected: FAIL.
- [ ] **Step 3: Implement.** Bearer 401s are thrown as `HTTPException`. Attach the header via `new HTTPException(401, { message, res })` or the app's existing error-to-response mapping. Check which pattern `apps/api/src/index.ts`'s `onError` honours before choosing.
- [ ] **Step 4: Run again, then all of `src/routes/mcpServer`.** Expected: PASS.
- [ ] **Step 5: Commit** with `feat(mcp): WWW-Authenticate scope + dormant insufficient_scope step-up (#6156)`.

---

### Task 8: API keys REST, `mcpDomains` on create, patch, list and get

**Files:**
- Modify: `apps/api/src/routes/apiKeys.ts`. `createApiKeySchema` (`:258`) and `updateApiKeySchema` (`:266`) gain `mcpDomains: mcpDomainsInputSchema.optional()`. The insert (`:~450`) and update (`:548`) write `normalizeMcpDomainsInput(...)`. The list select (`:340`) and the single-get and create responses include `mcpDomains`.
- Modify: `apps/api/src/services/servicePrincipals.ts`. `rotateServicePrincipalKey` (`:97`) selects the `mcp_domains` of the active key it is about to revoke and inserts the new row with it (D-B5).
- Test: `apps/api/src/routes/apiKeys.test.ts`, `apps/api/src/services/servicePrincipals.test.ts` (create it if absent, next to the existing SP tests)

**Interfaces:**
- Consumes: `mcpDomainsInputSchema` and `normalizeMcpDomainsInput` (Task 1), and the route's existing `validateRequestedScopes` / `validateApiKeyScopeDelegation`.
- Produces: `isMcpDomainsWidening(prev: string[] | null, next: string[] | null): boolean`, local to `routes/apiKeys.ts`. It is true when `next === null && prev !== null`, or when `next` has an element missing from `prev`.
- Produces: the REST shape `mcpDomains: McpGrantableDomain[] | null` on every api-key response. Omitting it on create gives `null`. Omitting it on PATCH leaves it unchanged. An explicit `null` on PATCH clears it to unrestricted.

- [ ] **Step 1: Write the failing tests.**
  - `'create without mcpDomains stores null'`
  - `'create with ["tickets","devices"] stores the normalized order'`
  - `'create rejects core / [] / unknown with 400'`
  - `'patch null widens to unrestricted; patch omitted leaves it'`
  - `'list and get return mcpDomains'`
  - `'rotate keeps mcpDomains'`. Rotation updates in place (`:805`), so this pins it.
  - `'mcpDomains is accepted without ai:* scopes but is inert'`. Decide in review whether to reject instead. The default is to accept and store it, because domains only narrow and the UI hides the picker. Record the choice in the PR body.
  - `'widening domains runs scope delegation for the updater against the key's current scopes'`: an updater who could not delegate `ai:execute` gets a 403 when widening an `ai:execute` key from `['tickets']` to `null`, and a 200 when narrowing it to a subset.
  - `'update audit carries previous and new mcpDomains'`
  - `servicePrincipals.test.ts`: `'rotation carries mcp_domains from the revoked key'`.
- [ ] **Step 2: Run** `cd apps/api && npx vitest run src/routes/apiKeys`. Expected: the new cases FAIL.
- [ ] **Step 3: Implement.**
  - Narrowing needs nothing beyond the route's existing `requirePermission(ORGS_WRITE)` + `requireMfa()`.
  - Widening (`isMcpDomainsWidening`) re-runs the route's scope-delegation validation on the key's **stored** scopes as if the updater were granting them, and returns that validation's 403 unchanged. No change to `validateApiKeyScopeDelegation` itself.
  - The existing update audit gains `mcpDomains: { previous, next }`.
- [ ] **Step 4: Run again.** Expected: PASS (`apiKeys.test.ts`, `apiKeys.mutationCeiling.test.ts`, `apiKeys.rotateCeiling.test.ts`).
- [ ] **Step 5: Commit** with `feat(api-keys): mcpDomains on API keys (#6156)`.

---

### Task 9: OAuth consent, the domain picker and persistence

**Files:**
- Modify: `apps/api/src/oauth/adapter.ts`. `GrantBreezeMeta` (`:47`) gains `mcp_domains: McpGrantableDomain[] | null`, and `setGrantBreezeMeta` (`:49`) writes it in the same `update(oauthGrants).set({...})`.
- Modify: `apps/api/src/routes/oauthInteraction.ts`. `parseConsentBody` (`:83`) parses an optional `mcp_domains` with `mcpDomainsInputSchema`. If the key is absent the value is `null`. An invalid value gets a 400 with the existing error shape. The value is passed to `setGrantBreezeMeta` at `:437`.
- Create: `apps/web/src/components/shared/McpDomainPicker.tsx`, `McpDomainPicker.test.tsx`
- Modify: `apps/web/src/components/oauth/ConsentForm.tsx`. Add a "Tool access" section under the scope list. The POST body (`:159`) becomes `{ partner_id, approve, mcp_domains }`.
- Modify: `apps/web/src/locales/{en,de-DE,es-419,fr-CA,fr-FR,it-IT,pt-BR,tr-TR}/common.json`
- Test: `oauthInteraction.test.ts`, `ConsentForm.test.tsx`, `apps/web/src/lib/i18n/localeParity.test.ts`

**Interfaces:**
- Consumes: Task 1. It also consumes `AI_TOOL_DOMAINS` order for display, with i18n labels under `longTail.mcpDomains.labels.<domain>`. `AI_TOOL_DOMAIN_LABELS` is the English source.
- Produces: `<McpDomainPicker value: McpGrantableDomain[] | null; onChange(v): void; disabled?: boolean; idPrefix: string />`
  - Radio `data-testid="mcp-domains-all"`: "All tools (including areas added later)". This is the default.
  - Radio `data-testid="mcp-domains-selected"`: "Only these areas".
  - 13 checkboxes `data-testid="mcp-domain-<domain>"`, plus one disabled, checked "Core (always included)".
  - With "selected" and zero boxes checked, it shows an inline error `data-testid="mcp-domains-error"`, and the parent's submit is disabled (Open Decision 1 default).
  - The consent variant renders one line under the picker, `data-testid="mcp-domains-reconnect-note"`: "Applies to this connection. To narrow an existing connection, revoke it under Connected apps, then reconnect." (D-B10)
- The consent route records `mcpDomains` in the consent audit event, or adds `oauth.consent.granted` if none exists (D-B11). Test: `'consent audit records mcpDomains'`.

- [ ] **Step 1: Write the failing tests.**
  - `oauthInteraction.test.ts`: `'consent without mcp_domains persists null'`, `'consent with ["tickets"] persists it via setGrantBreezeMeta'`, `'consent with ["core"] or [] is a 400 and saves no grant meta'`. For the last one, the check must run before `grant.save()`, so assert that `save` was not called.
  - `McpDomainPicker.test.tsx`: `'defaults to all'`, `'selected + boxes emits the list'`, `'selected + none shows the error'`, `'selecting every box emits null'` (via `normalizeMcpDomainsInput`).
  - `ConsentForm.test.tsx`: `'posts mcp_domains null by default'`, `'posts the selected list'`.
  - `localeParity.test.ts` stays green, because every new key is present in all 8 locales. Machine-translate the non-en files and mark nothing as untranslated, following the repo convention.
- [ ] **Step 2: Run** `cd apps/api && npx vitest run src/routes/oauthInteraction`, then `cd apps/web && npx vitest run src/components/oauth src/components/shared/McpDomainPicker src/lib/i18n/localeParity`. Expected: FAIL.
- [ ] **Step 3: Implement.** Validate `mcp_domains` **before** `grant.save()`, so a bad body never leaves a grant with NULL tenancy. `setGrantBreezeMeta` already fails closed. If the persist fails, the grant has NULL `partner_id` and is unusable (`resolveGrantContext` throws), so a half-written domain set is impossible.
- [ ] **Step 4: Run again, plus `apps/web` typecheck (exit code).** Expected: PASS.
- [ ] **Step 5: Commit** with `feat(oauth): tool-domain selection on the MCP consent screen (#6156)`.

---

### Task 10: API-key UI

**Files:**
- Modify: `apps/web/src/components/settings/ApiKeyForm.tsx`. `ApiKeyFormValues` (`:29`) gains `mcpDomains: McpGrantableDomain[] | null`. The form renders `<McpDomainPicker>` only when any `ai:*` scope is checked, and submits it. When no `ai:*` scope is checked it submits `null`.
- Modify: `apps/web/src/components/settings/ApiKeysPage.tsx` (the POST body at `:112` carries `mcpDomains`) and `ApiKeyList.tsx`. The list shows a badge for keys with an `ai:*` scope: "All tools" or "N areas", with `data-testid="api-key-mcp-domains-<id>"`.
- Modify: locales (8 files)
- Test: `ApiKeyForm.test.tsx`, `ApiKeyList.test.tsx`, `ApiKeysPage.test.tsx`

**Interfaces:**
- Consumes: Task 8 (REST shape) and Task 9 (`McpDomainPicker`).

- [ ] **Step 1: Write the failing tests.**
  - `'picker hidden without ai:* scopes'`
  - `'picker shown after checking ai:read'`
  - `'submits mcpDomains null by default and the list when selected'`
  - `'list badge renders All tools / N areas'`
  - `'create POST body carries mcpDomains'`
- [ ] **Step 2: Run** `cd apps/web && npx vitest run src/components/settings/ApiKey`. Expected: FAIL.
- [ ] **Step 3: Implement.** There is no edit dialog today (`ApiKeysPage` only creates), so editing is REST-only this wave. See Deferred.
- [ ] **Step 4: Run again, plus `no-silent-mutations.test.ts`** (the create already uses `runAction`, so keep it that way). Expected: PASS.
- [ ] **Step 5: Commit** with `feat(web): tool-domain picker on API key create (#6156)`.

---

### Task 11: Docs, index, verification, PR

**Files:**
- Modify: `apps/docs/src/content/docs/features/mcp-server.mdx` (new "Limit a connection to tool areas" section; `whoami`; the step-up flag), `reference/api-keys.mdx` (the `mcpDomains` field; REST unaffected), `deploy/environment.mdx` (`MCP_INSUFFICIENT_SCOPE_HTTP_403`, default `false`)
- Modify: `docs/superpowers/plans/ai-mcp/2026-09-17-agent-tool-efficiency-and-mcp-modernization.md` (B-W02 row: **implemented**, with the PR number)

- [ ] **Step 1: Run the unit suites.**
  - `cd apps/api && npx vitest run src/routes/mcpServer src/services/mcp src/middleware src/routes/apiKeys src/routes/oauthInteraction src/oauth`
  - Then the whole API unit suite.
  - `cd apps/web && npx vitest run` and `cd packages/shared && npx vitest run`.
- [ ] **Step 2: Typecheck** `apps/api`, `apps/web` and `packages/shared` with a 12 GB heap. Record each exit code, and each must be 0.
- [ ] **Step 3: Run the integration and contract suites on a worktree stack** (`worktree-stack` skill; `docs/agents/local-stacks.md`):
  1. Copy the root `.env` and blank the AI keys.
  2. Set `BREEZE_WORKSPACE_ENABLED=false` and pick a free `BREEZE_DOCKER_SUBNET=172.31.N.0/24`.
  3. Run `pnpm test-stack up`, then `pnpm --filter @breeze/api test:integration -- mcpDomainsColumns tenant-export-policy tenantExportErasureRoundtrip orgMergeRegistry tenantCascade` and `DB_CONTEXTLESS_WRITE_STRICT=true pnpm --filter=@breeze/api test:rls-coverage`.
  4. Run `pnpm test-stack down` and say in the PR that the stack is down.
- [ ] **Step 4: Run** `pnpm db:check-drift`, `bash scripts/check-migration-naming.sh --staged --against-ref origin/main` and `cd apps/docs && pnpm astro check`.
- [ ] **Step 5: Do a manual smoke test against the stack.**
  1. Mint an `ai:read` key restricted to `['tickets']`.
  2. Run `tools/list` with `curl` and check that every `_meta['app.breeze/domain']` is in `{core, tickets}`.
  3. Run `tools/call` on a devices tool and check for -32003.
  4. Run `whoami` and check its domains.
  5. Repeat with an unrestricted key and diff the name list against `main`'s.
- [ ] **Step 6: Open the PR.**
  - Title: `feat(mcp): B-W02 per-grant tool domains, whoami, insufficient_scope step-up`.
  - Body:
    - `Closes #6156`, `Refs #6144 #2550 #6154`. No other closing keyword.
    - The tenancy table from this plan.
    - The migration name.
    - The gates with counts from real output.
    - "Settings rule 9": home = API key and OAuth grant, level = per principal, resolver = `parseStoredMcpDomains`. The concept was configured in 0 places before and 2 after (the key form and the consent screen).
  - Run one `/pr-review-toolkit:review-pr` round, because auth and migration make this high blast radius.

---

## Exit checklist

- [ ] Migration `2026-12-30-180000-mcp-tool-domains.sql` is idempotent. Applying it twice is a no-op, verified by re-running `db:migrate` on the stack. It writes no rows. The naming hook and `db:check-drift` are green.
- [ ] `mcp_domains` is classified as `excludedOpen` on `api_keys` and `oauth_grants`, and `tenant-export-policy` plus `tenantExportErasureRoundtrip` are green under the integration config.
- [ ] No cascade, merge, device-list or ticket-list change was needed. That is confirmed by `tenantCascade`, `orgMergeRegistry` and `rls-coverage` being green, not by judgement.
- [ ] An unrestricted principal's `tools/list` is identical to `main`'s, pinned by the test.
- [ ] Listed ⇒ callable holds for every single-domain grant (the contract test).
- [ ] The domain gate covers `tools/list`, `tools/call` (core, alias, bootstrap, tenant), `resources/list` and `resources/read`.
- [ ] A missing `mcpDomains` on the context fails closed. All three middlewares set it explicitly.
- [ ] API-key rotation (in place) and org service-principal rotation (new row) both preserve `mcp_domains`. Widening runs the scope-delegation check for the updater.
- [ ] Domain denials, API-key domain changes and consent selections are audited (D-B11).
- [ ] `whoami` is listed for every principal, its name is reserved against extensions, and it leaks no secrets.
- [ ] Open Decisions 1 and 2 are resolved by Todd, or the plan defaults (A, A) are recorded in the PR body.
- [ ] The 401 challenge carries `scope`. The 403 step-up is dormant by default and never fires for API keys, domain denials or the legacy 202 path.
- [ ] The consent screen and the API-key create form have the picker, and every locale is in parity.
- [ ] Docs are updated, and the index row is marked implemented.
- [ ] The PR closes only #6156. #2550 and #6144 are left for Todd.
- [ ] The test stack is torn down.

## Deferred (file as follow-ups when the PR merges)

- Domain edit UI for existing API keys (REST `PATCH` already supports it).
- Domain restriction for partner service principal (`brz_sp_`) keys, and a domain picker for org service principals (D-B5).
- Domains as OAuth scopes: client-requested preselection and scope-driven domain step-up (D-B6).
- Show, and narrow, a grant's domains in `MyConnectedAppsPage` / `OrgConnectedAppsPage`.
- Partner-wide domain policy (`oauth_scope_policy.mcp_allowed_domains`), analogous to `mcp_allowed_scopes`.
- `domain` on `ExtensionAiTool`, so extension tools can join restricted grants.
- Flip `MCP_INSUFFICIENT_SCOPE_HTTP_403` on once a client matrix shows Claude, ChatGPT and Cursor handle a mid-session 403 with re-authorization.
