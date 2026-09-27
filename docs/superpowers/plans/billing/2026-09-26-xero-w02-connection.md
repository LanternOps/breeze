---
spec: docs/superpowers/specs/billing/2026-09-26-xero-accounting-integration-design.md
index: docs/superpowers/plans/billing/2026-09-26-xero-accounting-integration-index.md
tracking_issue: LanternOps/breeze#7167
wave_issue: LanternOps/breeze#7169
---

# Xero W02: Connection Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A partner can connect exactly one Xero organisation to Breeze (OAuth, tenant picker, token refresh, organisation settings, pickers, targeted disconnect), with Xero registered as an `AccountingProvider` that declares only the `connect` capability.

**Architecture:** `xeroProvider.ts` implements the W01 provider seam. Its HTTP details (token endpoint, identity `/connections` API, tenant-scoped Accounting API, error translation, rate-limit slot) live in `xeroHttp.ts`. Providers whose callback has no realm id declare an optional `tenantSelection` member. The OAuth callback uses it to scope the grant to this flow's `authentication_event_id`. With one organisation it connects directly. With several it parks the row as `pending_tenant` until the user picks one. Unchosen links from the same auth event are removed on the Xero side, but only when no other `accounting_connections` row holds them. Disconnect removes Breeze's own Xero connection by id and never revokes the grant.

**Tech Stack:** TypeScript, Hono, Drizzle ORM on PostgreSQL (partner-axis RLS), BullMQ + ioredis, Vitest, React (Astro islands) + react-i18next.

**Spec:** `docs/superpowers/specs/billing/2026-09-26-xero-accounting-integration-design.md` (the "W02 — Xero connection" section, "Advisor quorum" findings 3 and 8, and "Open verification items" 3 and 4). W01 contract: `docs/superpowers/plans/billing/2026-09-26-xero-w01-core-neutralization.md`.

---

## Preconditions (hard gates, check before Task 0)

1. **W01 is fully merged:** W01a (#7182, merged as `cf0fe4756`), W01b, W01c and W01d. W02 builds on the symbols listed in "W01 interface assumptions" below. W01b–d were **not** merged when this plan was written, so every symbol from them is an assumption until Task 0 re-verifies it.
2. **Feature-lifecycle:** run `get_feature_status` for #7167, branch `feature/7167-xero/wave-7169-<suffix>`, then `start_wave` for #7169.

```bash
git fetch origin main
git log origin/main --oneline | grep -iE 'xero w01|#7168' | head
```

Expected: four W01 commits (a, b, c, d). Fewer means stop.

## W01 interface assumptions (re-verify every line in Task 0)

W02 calls these by the exact names below. W01a is merged and was read from real code. **B/C/D** come from the W01 plan text. If a name or shape differs on `main`, follow `main`: update this plan's code for that task and record the difference in the PR body. Do not rename the W01 symbol back.

| # | Symbol (file) | Shape W02 relies on | Source |
|---|---|---|---|
| A1 | `resolveActiveConnection(dbc, partnerId)` (`services/accounting/accountingConnectionService.ts`) | full decrypted row or null; single `eq(partnerId)` predicate + `limit(1)` | W01a, merged |
| A2 | `resolveActiveConnectionRef(dbc, partnerId)` (same) | `{ id, provider } \| null`; **its predicate duplicates A1's** (PR #7182 "Deferred") | W01a, merged |
| A3 | `resolveActiveConnectionId`, `resolveActiveConnectionFor(partnerId, capability)` (same) | both go through A2 | W01a, merged |
| A4 | `AccountingProviderConflictError(existing, requested)` (same) | `code 'accounting_provider_conflict'`, `status 409` | W01a, merged |
| A5 | `upsertConnection` (same) | `onConflictDoUpdate({ target: partnerId, setWhere: provider = excluded.provider })`; `!row` → conflict branch | W01a, merged |
| A6 | `findAccountingProvider`, `getAccountingProvider`, `providerSupports`, `accountingProviderDisplayName`, `listRegisteredAccountingProviders` (`providerRegistry.ts`) | as named; `providers` is a `Partial<Record<AccountingProviderId, AccountingProvider>>` | W01a, merged |
| A7 | `AccountingProvider.displayName`, `.capabilities`; `AccountingCapability`, `AccountingCapabilities` (`types.ts`) | as named | W01a, merged |
| A8 | `listReconcilableConnections` filters `status = 'connected'` | unchanged | W01a, merged |
| B1 | `AccountingProviderError` (`services/accounting/accountingProviderError.ts`) | `new AccountingProviderError({ kind, provider, operation, message?, httpStatus?, providerCode?, providerMessage?, retryAfterMs?, logBody?, telemetryTags?, cause? })`; `.kind`, `.status` | W01b Task 8 |
| B2 | `AccountingProviderErrorKind` | includes `'reauth' \| 'rate_limited' \| 'validation' \| 'not_found' \| 'transient'` | W01b Task 8 |
| B3 | `isAccountingProviderError(err)`, `providerErrorKindOf(err)` (same) | non-provider errors → `'transient'` | W01b Task 8 |
| B4 | `accountingTokens.ts` `isInvalidGrant(err)` | `providerErrorKindOf(err) === 'reauth'` | W01b Task 8 |
| B5 | `AccountingProvider.limits` | `{ readonly paymentRefMax: number; readonly rate: RateLimitSpec }` | W01b Task 9 |
| B6 | `RateLimitSpec` (`types.ts`) | `{ perConnection: { limit; windowSeconds }; maxConcurrentPerConnection: number \| null; appWide: { limit; windowSeconds } \| null; dailyPerConnection: { limit: () => number } \| null }` | W01b Task 9 |
| B7 | `AccountingProvider.paymentMarker` | `{ embed(reference: string \| null, marker: string): string; extract(text: string \| null \| undefined): string \| null }` | W01b Task 9 |
| B8 | `AccountingProvider.connectEnvironment()` | returns `AccountingEnvironment` | W01b Task 9 |
| B9 | `AccountingProvider.configError()` | `string \| null` | W01b Task 9 |
| B10 | Renamed payload fields (`RemoteRef.remoteVersion`, `InvoiceVoidResult.remoteVersion`, `AccountingDeletePaymentPayload.remoteVersion`, `AccountingPaymentPayload.marker`) | Xero stubs only name the types | W01b Task 9 |
| B11 | `AccountingMappingErrorCode` includes `'provider_error'` | used by Task 8's options service | W01b Task 8 |
| C1 | `withProviderCallSlot(provider, spec, connectionId, fn)` (`services/accounting/accountingRateLimit.ts`) | throws `AccountingProviderError{ kind: 'rate_limited' }` on refusal; fails open when Redis is null | W01c Task 12 |
| C2 | `noteDailyRemaining(provider, connectionId, remaining)` (same) | records the provider's calls-left-today | W01c Task 12 |
| C3 | `parseRetryAfterMs(header)` | exported from `quickbooksProvider.ts` by W01c Task 13. **Task 4 moves it to `accountingRateLimit.ts`** (a Xero module must not import the QuickBooks provider) | W01c Task 13 |
| C4 | Token endpoints stay **outside** the call slot | a convention, not a symbol | W01c Task 13 |
| D1 | Route param schema `z.enum(ACCOUNTING_PROVIDER_IDS)` (`routes/accounting/index.ts`) | `xero` passes the enum | W01d Task 15 |
| D2 | `providerGateResponse(c, provider, capability)` (`routes/accounting/providerGate.ts`) | `Response \| null`; unregistered or missing capability → 409 `capability_unavailable`; `configError()` → 400 `provider_not_configured` | W01d Task 15 |
| D3 | `listProvidersHandler(c, partnerId)` (same) and `GET /accounting/providers` | `{ data: [{ id, displayName, configured, capabilities }], activeConnection: { provider, status } \| null }`, read through `resolveActiveConnection` | W01d Task 15 |
| D4 | OAuth state carries `provider`; the callback rejects a state minted for another provider; `createState(partnerId, userId, provider)` | as named; may live in `routes/accounting/oauthState.ts` | W01d Task 15 |
| D5 | `/connect` refuses a cross-provider connect with 409 via `resolveActiveConnection` | **Task 2 switches it to `getPartnerConnectionRef`** | W01d Task 15 |
| D6 | Callback uses `providerClient.connectEnvironment()`, redirects `/integrations?accounting=${provider}&…#accounting`, and maps `AccountingProviderConflictError` to `error=provider_conflict` | as named | W01d Task 15 |
| D7 | `neutralCore.guard.test.ts` | scans `services/accounting`, `jobs`, `routes/accounting`; exempts `*Provider.ts`, `quickbooksFault.ts`, `providerRegistry.ts`; empty allowlist | W01d Task 17 |
| D8 | Web `lib/accountingProviders.ts` | exports `ACCOUNTING_PROVIDER_IDS`, `AccountingProviderId`, `AccountingCapability`, `ACCOUNTING_PROVIDER_NAMES`, `accountingPath(provider, suffix?)`, `fetchAccountingProviders()`, `AccountingProvidersResponse` | W01d Task 18 |
| D9 | Web `components/integrations/AccountingConnectionPanel.tsx` | `({ provider })`; test ids `` `${provider}-connect` ``, `` `${provider}-disconnect` ``, `` `${provider}-pushmode` ``, `` `${provider}-pullpayments` ``, `` `${provider}-pushpayments` ``, `` `${provider}-reconcile-now` ``, `` `${provider}-owed-operations` ``; the OAuth-return effect checks `params.get("accounting") === provider` | W01d Task 18 |
| D10 | Web `AccountingProviderCards` | renders only `configured` providers and greys out the other card while `activeConnection` is set | W01d Task 18 |
| D11 | i18n `integrations` namespace `accountingConnection.*` with `{{provider}}` | key names `connectToProvider`, `reconnectProvider`, `disconnect`, `failedToDisconnectProvider`, `mfaRequiredHint` | W01d Task 19 |
| D12 | `IntegrationsPage` hash routing | `#xero` selects the Xero panel | W01d Task 18 |

**That is 30 assumptions: 8 from W01a (A1–A8) and 22 from W01b–d.**

## Where this plan refines the spec (read before implementing)

Each item was checked against the code, or against Xero's own published sources, on 2026-09-26.

1. **The claim is `authentication_event_id`, and the query parameter is `authEventId`.** The spec says "the `authEventId` claim". Xero's decoded access token carries `authentication_event_id`, and `GET https://api.xero.com/connections?authEventId=<id>` filters by it. Each connection object has its own `authEventId` field. As defence in depth, `listXeroConnections` also filters client-side on `authEventId === <id>`, so a Xero that ignored the parameter could still never hand back another partner's links.
2. **Re-authorising a tenant that is already linked keeps that link's original `authEventId`.** Xero's developer forum and FAQ say the connection's `authEventId` reflects the **first** authorisation. So a *reconnect* (the `reauth_required` path, or a user who re-ticks an organisation that is already linked) returns an **empty** filtered list. The spec's "Zero → error" would then break every reconnect. The plan's rule is **a reconnect keeps the partner's own organisation.** When the partner's row already holds a tenant id, the callback looks up that exact tenant id in the unfiltered `/connections` list. That tenant is already bound to this partner, so the lookup can never select or touch another partner's organisation. To change organisation, disconnect first. This does not contradict open item 4: it is not a fallback for a missing claim, and it cannot pick up another partner's concurrent connect. Lab step X8 settles it.
3. **`pending_tenant` rows are never refreshed.** The picker has to finish inside the original access token's life (30 minutes, minus a 60-second margin). After that the UI offers "cancel and reconnect". So the stored access token is always the **original** one, and its `authentication_event_id` is decoded from it whenever needed. That needs no extra column (the spec allows exactly three). The 1-hour reaper refreshes only so it can remove the Xero-side links, and it discards the new tokens with the row.
4. **The one-provider conflict check must *see* `pending_tenant` rows.** W02 excludes `pending_tenant` from `resolveActiveConnection` and `resolveActiveConnectionRef` (A1/A2). But `upsertConnection`'s conflict branch, W01d's `/connect` check (D5) and `GET /accounting/providers` (D3) read through those resolvers. Without a change, a QuickBooks connect over a pending Xero row would fail as a generic "Failed to persist" instead of 409, and the Xero card would not grey out QuickBooks. Task 2 adds `getPartnerConnectionRef` (any status) and switches those three callers to it.
5. **A tenant held by another partner raises `AccountingTenantHeldError` (409 `accounting_tenant_held`).** Both `upsertConnection` and the pending-row claim translate the `accounting_connections_provider_realm_fp_idx` unique violation. **This also changes QuickBooks:** a QuickBooks realm held by another partner used to redirect with `error=persist_failed` and now redirects with `error=tenant_held`. That is intended. List it in the W02b PR body.
6. **The "held by another row" check runs in system scope.** Under a partner-scoped RLS context, other partners' rows are invisible, so the check would report "not held" and delete another partner's link. `listHeldTenantKeys` runs in its own short `withSystemDbAccessContext`, from routes registered as self-managed. It returns only fingerprints and connection refs.
7. **`IsDemoCompany` and the organisation name come from `GET /:provider/settings/options`**, not from the status route. The status route stays DB-only, so an Integrations page load costs no Xero calls against the 1,000/day Starter budget. The spec says "fetched with status". The badge shows on the settings step, which fetches `Organisation` anyway.
8. **Consent cancelled at Xero (`?error=access_denied`) redirects cleanly** with `error=consent_denied`, instead of failing `callbackQuerySchema` with a raw 400 JSON page. Certification tests this. QuickBooks gets the same improvement.
9. **Token and settings-refresh messages are labelled by provider.** `accountingTokens.ts` and `refreshRealmSettings` still hard-code "QuickBooks …" after W01. A Xero row would otherwise read "QuickBooks refresh token expired". QuickBooks strings stay byte-identical.
10. **Only `tenantType === 'ORGANISATION'` is connectable.** Other tenant types in the same auth event (practice-manager tenants and the like) are removed like any unchosen link.
11. **Export and erasure registries: verified, nothing to add.** `grep -n accounting_connections apps/api/src/services/{tenantCascade,tenantExportPolicyRegistry,orgMergeRegistry}.ts` finds nothing. `accounting_connections` is partner-axis (RLS shape 3), is not in `CORE_ORG_CASCADE_DELETE_ORDER`, and so needs no `CORE_TENANT_EXPORT_POLICY` entry. No partner-level export registry exists. The three new columns are plain varchar refs; `encryptedColumnRegistry.ts` is unchanged.
12. **Scope strings are pinned from Xero's own repositories** (`XeroAPI/xero-command-line` `src/lib/oauth.ts`, `XeroAPI/xero-prompt-library` `javascript/SKILL.md`, both current in 2026). The pinned strings are `offline_access accounting.contacts accounting.invoices accounting.payments accounting.settings.read`. `accounting.invoices` covers Invoices **and Items** (W03/W04). `accounting.payments` covers Payments (W05). `accounting.settings.read` covers Organisation, Currencies, Accounts and TaxRates. W02 requests the full set now, because Xero cannot widen a token's scope without the user consenting again. The broad `accounting.transactions` is not requested. Task 4 Step 1 has the executor confirm these strings at the Xero developer portal.
13. **`limits.paymentRefMax` for Xero is provisional (255).** The `paymentPush` capability is false until W05, which pins the value against the Payments API. `paymentMarker` throws until then.
14. **Refresh rotation race.** Xero rotates the refresh token on every refresh and honours the previous token for a 30-minute grace window. `getValidAccessToken` already compares the refresh token *value* under a row lock, keeps the peer's rotation and never overwrites a newer token. Task 4 pins both loser outcomes with Xero-shaped errors. Lab step X9 confirms Xero's grace behaviour.

## Global Constraints

- Xero registers with exactly `capabilities = { connect: true, mapping: false, customerImport: false, invoicePush: false, paymentPull: false, paymentPush: false }`.
- One accounting connection per partner (`accounting_connections_partner_idx`). A `pending_tenant` row **is** that connection for the index. It is excluded from `resolveActiveConnection` and `resolveActiveConnectionRef`, and both predicates change together.
- `pending_tenant` rows are reaped **1 hour** after `updated_at`.
- The authorize URL is `https://login.xero.com/identity/connect/authorize`. The token URL is `https://identity.xero.com/connect/token`, with HTTP Basic client auth (`base64(client_id:client_secret)`).
- Scopes are exactly `offline_access accounting.contacts accounting.invoices accounting.payments accounting.settings.read`.
- On every exchange and refresh, `refresh_token_expires_at = now + 60 days`. `invalid_grant` from the token endpoint is `AccountingProviderError{ kind: 'reauth' }`.
- Rate limits (`limits.rate`): 60 calls per 60 s and 5 concurrent per connection; 10,000 calls per 60 s app-wide; a daily budget of `XERO_DAILY_CALL_LIMIT` (default `1000`), refined by `X-DayLimit-Remaining`. The token and identity (`/connections`) calls run outside the slot.
- `/connections` is only ever read **filtered by the flow's `authentication_event_id`**. The single exception is the reconnect lookup in refinement item 2, which may only *select* the tenant id the partner's own row already holds. A missing claim fails closed with `error=auth_event_missing`. Diffing `/connections` before and after is never a fallback.
- `DELETE /connections/{id}` is called only for (a) unchosen links from the **same** auth event that no `accounting_connections` row holds (checked in system scope), and (b) the partner's own `provider_connection_ref` on disconnect. The token-revocation endpoint is **never** called.
- Environment: `environment = 'production'` for every Xero row. There is no Xero sandbox; testing uses the Demo Company.
- New env vars: `XERO_CLIENT_ID`, `XERO_CLIENT_SECRET`, `XERO_REDIRECT_URI`, `XERO_WEBHOOK_KEY` (read in W05; registered now), and `XERO_DAILY_CALL_LIMIT` (positive integer, default `1000`). All optional at boot. Each goes in `config/env.ts`, the `validate.ts` schema, `.env.example`, the `api` `environment:` block of **both** `docker-compose.yml` and `deploy/docker-compose.prod.yml`, `envComposeParity.test.ts`, and the system connections registry.
- New columns on `accounting_connections` (all nullable `varchar(64)`, none secret): `default_exempt_tax_code_ref`, `default_payment_account_ref`, `provider_connection_ref`.
- Migration: the filename sorts after the newest committed migration (`2026-11-02-110000-accounting-connections-one-per-partner.sql` on 2026-09-26; re-check with `git ls-tree --name-only origin/main apps/api/migrations/ | sed 's#.*/##' | grep '^20' | sort | tail -1`). The migration is idempotent and has no inner `BEGIN`/`COMMIT`. It writes no rows, so it needs no scope election.
- DB context: every provider HTTP call runs with no held DB context. Routes that make one are registered in `SELF_MANAGED_DB_CONTEXT_ROUTES` and take a `runInDbContext` runner (`(fn) => withAuthDbAccessContext(auth, fn)`).
- The neutral-core guard (D7) stays green. No core file gains a `'quickbooks'` literal. Xero specifics live only in `xeroProvider.ts` and `xeroHttp.ts`.
- `routes/accounting/index.ts` must not grow. `wc -l` at the end of each PR must be ≤ its count at Task 0. New handlers go in `routes/accounting/connectionSetupRoutes.ts`, and the callback's persist/capture tail moves to `routes/accounting/connectFinalize.ts`.
- New Sentry tags: none. Use only the existing allowlisted `service` tag (#5193).
- Web: every mutation goes through `runAction`. New mutating components go in `no-silent-mutations.test.ts` `TARGET_GLOBS`. Every QuickBooks `data-testid` and English string stays byte-identical.
- Tests: run one file with `cd apps/api && npx vitest run <path>`. Never use `pnpm … test -- --run`. Integration: `pnpm test-stack up`, then `cd apps/api && npx vitest run -c vitest.integration.config.ts <path>`, then `pnpm test-stack down`.
- Every PR runs, before opening: the full API unit suite, `npx tsc --noEmit -p apps/api`, `pnpm db:check-drift` (W02a), and the accounting integration set (W01 plan "Global Constraints", plus the W02 files). W02c also runs `cd apps/web && npx vitest run` and `npx tsc --noEmit -p apps/web`.

## Review Focus

These are the failure modes most likely to bite a real partner that no single task would test by itself, most likely first. Each has a pinned test in the task that owns the code.

1. **Two partners racing to connect the same Xero organisation.** Expected: exactly one row ends up holding the tenant. The loser gets 409 `accounting_tenant_held` ("This Xero organisation is connected to another Breeze account"). From the picker, its row stays `pending_tenant` so it can choose another organisation or cancel; from the callback, it is redirected with `error=tenant_held`. The winner's Xero link is never deleted. *(Task 10 integration "two partners racing for one tenant"; Task 7 callback "tenant held"; Task 8 route "select 409".)*
2. **An OAuth grant containing a tenant already connected to another partner.** Expected: that tenant is never selected, and its link is never removed (the held check runs in system scope). Other unchosen links from this auth event are removed. The user sees a specific error, not "connection failed". *(Task 6 `releaseUnchosenTenants` "keeps a held tenant"; Task 10 integration "held check sees another partner's row".)*
3. **A `pending_tenant` row going stale and blocking a QuickBooks connect.** Expected: a QuickBooks connect returns 409 with "Finish or cancel the Xero connection before connecting QuickBooks". The UI shows **Cancel connection**. With no action, the sweep reaps the row after 1 hour, and a QuickBooks connect then succeeds. *(Task 2 unit + integration; Task 9 sweep; Task 10 "stale pending row is reaped and QuickBooks can connect".)*
4. **A missing `authentication_event_id` claim.** Expected: fail closed. Nothing is persisted, `/connections` is never listed, nothing is deleted, and the redirect is `error=auth_event_missing` ("…please connect again"). *(Task 4 `decodeXeroAuthEventId`; Task 7 callback "auth_event_missing".)*
5. **A refresh that rotates the token while another worker refreshes.** Expected: no `reauth_required`. A loser whose refresh returns `invalid_grant` after a peer already rotated gets the peer's fresh access token. A loser whose refresh *succeeds* (Xero's 30-minute grace) discards its own rotation and uses the peer's. *(Task 4 `accountingTokens.test.ts` "Xero rotation race".)*

---

## PR split

| PR | Branch | Tasks | What ships | Stands alone because |
|---|---|---|---|---|
| **W02a** Foundation | `feature/7167-xero/wave-7169-a-foundation` | 0–5 (6 tasks) | migration + 3 columns, `pending_tenant` status + resolver exclusion + conflict lookup, env vars, `xeroHttp.ts`, `xeroProvider.ts` (**not registered**), token-message labels | Xero is not in the registry, so every Xero route still returns 409 `capability_unavailable`. The only behaviour visible elsewhere is the conflict message for a `pending_tenant` row, and no such row can exist yet. |
| **W02b** Connect flow | `…-b-connect` | 6–10 (5 tasks) | tenant-selection service, generalized callback + `connectFinalize.ts`, picker/cancel/options routes, disconnect release, settings fields, reaper, **registration** | The Xero card appears only when `XERO_CLIENT_ID` is set, and no environment sets it until W02c ships (state this in the PR body). Every capability except `connect` is false. |
| **W02c** Web + lab | `…-c-web` | 11–13 (3 tasks) | panel capability gating, branded connect/disconnect, tenant picker, settings step + demo badge, i18n, `docs/integrations/xero-demo-verification.md`, env docs | The server contract is complete. QuickBooks UI assertions are unchanged. |

Merge order is strictly a → b → c. Each PR targets `main` and is rebased after the previous one merges. **Do not stack**: a stacked PR runs no CI.

**W02c PR body must carry the settings-rule-9 statement** (it adds `AccountingSettingsStep`):
- **Home:** Integrations → Accounting → Xero panel.
- **Level:** partner (the accounting connection row).
- **Resolver:** the connection row itself. W04/W05 read `default_exempt_tax_code_ref` / `default_payment_account_ref` from `AccountingConnection`.
- **Count:** the concepts "exempt tax rate" and "payment bank account" go from **0 → 1** place. Xero's income account and taxable tax rate are also configured in **1** place (this step); QuickBooks keeps its existing single home in the mapping workbench.

---

## File structure

**Created**

| File | Responsibility | PR |
|---|---|---|
| `apps/api/migrations/2026-11-02-120000-accounting-connections-xero-columns.sql` | 3 nullable columns | a |
| `apps/api/src/__tests__/integration/accountingXeroColumns.integration.test.ts` | Real-DB proof of the columns, the `pending_tenant` exclusion and the conflict lookup | a |
| `apps/api/src/config/env.xero.test.ts` | Call-time Xero env readers | a |
| `apps/api/src/services/accounting/xeroHttp.ts` (+ `.test.ts`) | Token endpoint, identity `/connections`, tenant-scoped GET, error translation, JWT claim decode | a |
| `apps/api/src/services/accounting/xeroProvider.ts` (+ `.test.ts`) | `AccountingProvider` for Xero: connect-only capabilities, settings, tenant selection, release | a |
| `apps/api/src/services/accounting/accountingTenantSelectionStore.ts` | DB half of tenant selection: load, claim, delete pending, held keys, stale list | b |
| `apps/api/src/services/accounting/accountingTenantSelection.ts` (+ `.test.ts`) | Orchestration: choices, resolve pick, release unchosen links, discard pending, reap | b |
| `apps/api/src/services/accounting/accountingProviderRelease.ts` (+ `.test.ts`) | Best-effort provider-side release on disconnect | b |
| `apps/api/src/services/accounting/accountingSettingsOptions.ts` (+ `.test.ts`) | `listProviderSettingsOptions` for the pickers | b |
| `apps/api/src/routes/accounting/connectFinalize.ts` (+ `.test.ts`) | Persist, realm-change reset, settings capture (moved from the callback), redirect path | b |
| `apps/api/src/routes/accounting/tenantConnect.ts` (+ `.test.ts`) | Callback branch for tenant-selecting providers | b |
| `apps/api/src/routes/accounting/connectionSetupRoutes.ts` (+ `.test.ts`) | `GET /:provider/tenants`, `POST …/tenants/select`, `POST …/tenants/cancel`, `GET /:provider/settings/options` | b |
| `apps/api/src/__tests__/integration/accountingXeroConnection.integration.test.ts` | Races, held tenant, claim, reap, QuickBooks-after-reap | b |
| `apps/web/src/components/integrations/AccountingConnectButton.tsx` (+ test) | Provider-branded connect button | c |
| `apps/web/src/components/integrations/AccountingTenantPicker.tsx` (+ test) | Organisation picker for `pending_tenant` | c |
| `apps/web/src/components/integrations/AccountingSettingsStep.tsx` (+ test) | Pickers + demo badge, page Save | c |
| `docs/integrations/xero-demo-verification.md` | Lab checklist against the Xero Demo Company | c |

**Modified:** see each task's **Files** block.

---

## Task 0: Baseline and W01 re-verification (every PR starts here)

**Files:** none.

- [ ] **Step 1: Confirm the branch and preconditions**

```bash
cd <worktree>
git fetch origin main && git status -sb
git log origin/main --oneline | grep -iE 'xero w01' | head
```

Expected: a clean tree on the W02 branch, based on current `origin/main`, with all four W01 PRs listed.

- [ ] **Step 2: Re-verify every W01 assumption (A1–D12)**

```bash
cd apps/api/src
grep -n "export async function resolveActiveConnection\b\|export async function resolveActiveConnectionRef\|export class AccountingProviderConflictError" services/accounting/accountingConnectionService.ts
grep -n "export class AccountingProviderError\|export function isAccountingProviderError\|export function providerErrorKindOf\|export type AccountingProviderErrorKind" services/accounting/accountingProviderError.ts
grep -n "isInvalidGrant" -A3 services/accounting/accountingTokens.ts
grep -n "limits\|paymentMarker\|connectEnvironment\|configError\|export interface RateLimitSpec" services/accounting/types.ts
grep -n "export async function withProviderCallSlot\|export async function noteDailyRemaining\|parseRetryAfterMs" services/accounting/accountingRateLimit.ts services/accounting/quickbooksProvider.ts
grep -n "export function providerGateResponse\|export async function listProvidersHandler\|export function listProvidersHandler" routes/accounting/providerGate.ts
grep -n "provider: z.enum\|createState(\|stateProvider\|connectEnvironment()\|provider_conflict\|resolveActiveConnection(db" routes/accounting/index.ts routes/accounting/*.ts
grep -n "EXEMPT\|ALLOWLIST" services/accounting/neutralCore.guard.test.ts
cd ../../web/src
grep -n "export " lib/accountingProviders.ts
grep -n "provider}-connect\|provider}-disconnect\|provider}-pushmode\|params.get(\"accounting\") === provider" components/integrations/AccountingConnectionPanel.tsx
python3 -c "import json;d=json.load(open('locales/en/integrations.json'));print(sorted(d['accountingConnection'].keys()))"
```

Expected: every symbol is found. For each one that differs, note it in the PR body and adapt the code in the task that uses it.

- [ ] **Step 3: Record the baseline**

```bash
cd apps/api && npx vitest run src/services/accounting src/jobs/accountingSyncWorker.test.ts src/jobs/accountingReconcileWorker.test.ts src/routes/accounting src/routes/webhooks src/config src/system/connections src/middleware/selfManagedDbContextRoutes.test.ts src/__tests__/partner-wide-write-coverage.test.ts 2>&1 | tail -4
wc -l src/routes/accounting/index.ts
```

Expected: all tests pass. Write down the `Test Files` count and the `index.ts` line count. Later runs must report at least that many files (plus the new ones), and `index.ts` must never exceed that line count.

---

# PR W02a — Foundation (Xero not registered)

### Task 1: Three columns (migration, Drizzle schema, connection shape)

**Files:**
- Create: `apps/api/migrations/2026-11-02-120000-accounting-connections-xero-columns.sql`
- Create: `apps/api/src/__tests__/integration/accountingXeroColumns.integration.test.ts`
- Modify: `apps/api/src/db/schema/accounting.ts` (`accountingConnections`)
- Modify: `apps/api/src/services/accounting/accountingConnectionService.ts`: `AccountingConnection`, `UpsertConnectionFields`, `mapConnection` (and export it), `upsertConnection` `values` / `updateSet`
- Test: `accountingConnectionService.test.ts`, plus the fixture edits tsc lists (below)

**Interfaces:**
- Produces:
  ```ts
  // AccountingConnection gains (always present, nullable):
  defaultExemptTaxCodeRef: string | null;
  defaultPaymentAccountRef: string | null;
  /** Xero connection id (targeted DELETE /connections/{id}); null for QuickBooks and for pending_tenant rows. */
  providerConnectionRef: string | null;
  // UpsertConnectionFields gains (undefined = leave unchanged):
  defaultExemptTaxCodeRef?: string | null;
  defaultPaymentAccountRef?: string | null;
  providerConnectionRef?: string | null;
  // exported for accountingTenantSelectionStore.ts (Task 6):
  export function mapConnection(row: typeof accountingConnections.$inferSelect): AccountingConnection;
  ```

- [ ] **Step 1: Write the failing tests**

Append to `accountingConnectionService.test.ts`. Use its existing insert/select mocks and row factory; if the factory has a different name, use the file's own.

```ts
describe('Xero W02 columns', () => {
  it('maps the three new columns, defaulting absent values to null', async () => {
    const mapped = mapConnection({
      ...baseRow(),
      defaultExemptTaxCodeRef: 'EXEMPTOUTPUT',
      defaultPaymentAccountRef: '13918178-849a-4823-9a31-57b7eac713d7',
      providerConnectionRef: 'e1eede29-f875-4a5d-8470-17f6a29a88b1',
    } as any);
    expect(mapped.defaultExemptTaxCodeRef).toBe('EXEMPTOUTPUT');
    expect(mapped.defaultPaymentAccountRef).toBe('13918178-849a-4823-9a31-57b7eac713d7');
    expect(mapped.providerConnectionRef).toBe('e1eede29-f875-4a5d-8470-17f6a29a88b1');
    const bare = mapConnection({ ...baseRow(), defaultExemptTaxCodeRef: undefined, defaultPaymentAccountRef: undefined, providerConnectionRef: undefined } as any);
    expect([bare.defaultExemptTaxCodeRef, bare.defaultPaymentAccountRef, bare.providerConnectionRef]).toEqual([null, null, null]);
  });

  it('upsertConnection writes providerConnectionRef on insert AND on a same-provider reconnect', async () => {
    const { db, insertValues, updateSet } = capturingUpsertDb();
    await upsertConnection(db, 'p1', 'xero', { realmId: 't1', providerConnectionRef: 'conn-1' });
    expect(insertValues()).toMatchObject({ providerConnectionRef: 'conn-1' });
    expect(updateSet()).toMatchObject({ providerConnectionRef: 'conn-1' });
  });

  it('a token-only reconnect (field omitted) leaves providerConnectionRef untouched', async () => {
    const { db, updateSet } = capturingUpsertDb();
    await upsertConnection(db, 'p1', 'xero', { accessToken: 'a' });
    expect(updateSet()).not.toHaveProperty('providerConnectionRef');
    expect(updateSet()).not.toHaveProperty('defaultExemptTaxCodeRef');
    expect(updateSet()).not.toHaveProperty('defaultPaymentAccountRef');
  });
});
```

If the file has no `capturingUpsertDb` helper, add this one next to its existing mocks:

```ts
function capturingUpsertDb() {
  let values: Record<string, unknown> = {};
  let set: Record<string, unknown> = {};
  const row = { ...baseRow(), provider: 'xero' };
  const db = {
    insert: () => ({
      values: (v: Record<string, unknown>) => {
        values = v;
        return {
          onConflictDoUpdate: (opts: { set: Record<string, unknown> }) => {
            set = opts.set;
            return { returning: async () => [row] };
          },
        };
      },
    }),
    select: vi.fn(), update: vi.fn(), delete: vi.fn(),
  } as any;
  return { db, insertValues: () => values, updateSet: () => set };
}
```

Create `accountingXeroColumns.integration.test.ts`:

```ts
/**
 * Xero W02 Task 1: the three new accounting_connections columns exist, are
 * nullable varchar(64), and the migration re-runs as a no-op.
 */
import './setup';
import { afterAll, describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import postgres from 'postgres';
import { db, withSystemDbAccessContext } from '../../db';
import { createPartner } from './db-utils';
import { upsertConnection } from '../../services/accounting/accountingConnectionService';

const RUN = !!process.env.DATABASE_URL;
const MIGRATION = '2026-11-02-120000-accounting-connections-xero-columns.sql';
const migrationSql = readFileSync(join(__dirname, '../../../migrations', MIGRATION), 'utf8');
const adminSql = postgres(process.env.DATABASE_URL ?? '', { max: 1 });
afterAll(async () => { await adminSql.end({ timeout: 5 }); });

describe.skipIf(!RUN)('accounting_connections Xero columns (W02 Task 1)', () => {
  it('adds three nullable varchar(64) columns and re-runs as a no-op', async () => {
    await adminSql.unsafe(migrationSql);
    await adminSql.unsafe(migrationSql);
    const cols = await adminSql`
      select column_name, data_type, character_maximum_length, is_nullable
      from information_schema.columns
      where table_name = 'accounting_connections'
        and column_name in ('default_exempt_tax_code_ref', 'default_payment_account_ref', 'provider_connection_ref')
      order by column_name`;
    expect(cols.map((c) => [c.column_name, c.data_type, c.character_maximum_length, c.is_nullable])).toEqual([
      ['default_exempt_tax_code_ref', 'character varying', 64, 'YES'],
      ['default_payment_account_ref', 'character varying', 64, 'YES'],
      ['provider_connection_ref', 'character varying', 64, 'YES'],
    ]);
  });

  it('round-trips through upsertConnection', async () => {
    const partner = await createPartner();
    const conn = await withSystemDbAccessContext(() => upsertConnection(db, partner.id, 'xero', {
      realmId: 'tenant-cols-1', providerConnectionRef: 'conn-cols-1', environment: 'production',
    }));
    expect(conn.providerConnectionRef).toBe('conn-cols-1');
    expect(conn.defaultExemptTaxCodeRef).toBeNull();
    expect(conn.defaultPaymentAccountRef).toBeNull();
  });
});
```

- [ ] **Step 2: Run and confirm they fail**

```bash
cd apps/api && npx vitest run src/services/accounting/accountingConnectionService.test.ts -t "Xero W02 columns"
```

Expected: FAIL. `mapConnection` is not exported, and the properties are undefined.

- [ ] **Step 3: Write the migration**

```sql
-- Xero W02 (spec "Settings (new columns, nullable, provider-neutral)").
--   default_exempt_tax_code_ref  Xero TaxType for non-taxable lines (QBO: ignored)
--   default_payment_account_ref  Xero bank AccountID payments apply to (QBO: ignored)
--   provider_connection_ref      Xero connection id, for targeted
--                                DELETE /connections/{id} on disconnect (QBO: null)
-- None is a secret. accounting_connections is partner-axis (RLS shape 3) and is
-- in no org cascade / export-policy registry, so no registry entry is owed.
-- Idempotent; writes no rows (so no breeze.scope election is needed).

ALTER TABLE accounting_connections ADD COLUMN IF NOT EXISTS default_exempt_tax_code_ref varchar(64);
ALTER TABLE accounting_connections ADD COLUMN IF NOT EXISTS default_payment_account_ref varchar(64);
ALTER TABLE accounting_connections ADD COLUMN IF NOT EXISTS provider_connection_ref varchar(64);
```

Check the name still sorts last:

```bash
git ls-tree --name-only origin/main apps/api/migrations/ | sed 's#.*/##' | grep '^20' | sort | tail -1
```

If a newer file exists, rename this one so it sorts after it (keep `-120000-` or bump the time), and update `MIGRATION` in the integration test.

- [ ] **Step 4: Update the Drizzle schema**

In `accountingConnections`, after `defaultTaxCodeRef`:

```ts
  // Xero W02. Nullable, provider-neutral names; QuickBooks leaves them null.
  defaultExemptTaxCodeRef: varchar('default_exempt_tax_code_ref', { length: 64 }),
  defaultPaymentAccountRef: varchar('default_payment_account_ref', { length: 64 }),
  // The provider's id for Breeze's link to the tenant (Xero connection id),
  // used by the targeted DELETE /connections/{id} on disconnect. Not a secret.
  providerConnectionRef: varchar('provider_connection_ref', { length: 64 }),
```

- [ ] **Step 5: Update the service**

In `accountingConnectionService.ts`:

```ts
// AccountingConnection, after defaultTaxCodeRef:
  defaultExemptTaxCodeRef: string | null;
  defaultPaymentAccountRef: string | null;
  /** Xero connection id (targeted DELETE /connections/{id}); null for QuickBooks and pending_tenant rows. */
  providerConnectionRef: string | null;

// UpsertConnectionFields, after defaultTaxCodeRef:
  defaultExemptTaxCodeRef?: string | null;
  defaultPaymentAccountRef?: string | null;
  providerConnectionRef?: string | null;

// mapConnection: add `export`, and after defaultTaxCodeRef:
    defaultExemptTaxCodeRef: row.defaultExemptTaxCodeRef ?? null,
    defaultPaymentAccountRef: row.defaultPaymentAccountRef ?? null,
    providerConnectionRef: row.providerConnectionRef ?? null,

// upsertConnection `values` AND `updateSet`, after defaultTaxCodeRef:
    defaultExemptTaxCodeRef: fields.defaultExemptTaxCodeRef,
    defaultPaymentAccountRef: fields.defaultPaymentAccountRef,
    providerConnectionRef: fields.providerConnectionRef,
```

`stripUndefined` already drops omitted fields, so a token-only reconnect leaves them unchanged.

- [ ] **Step 6: Fix the fixtures tsc lists**

```bash
cd apps/api && npx tsc --noEmit -p . 2>&1 | grep -E "defaultExemptTaxCodeRef|providerConnectionRef|defaultPaymentAccountRef" | cut -d'(' -f1 | sort -u
```

Every listed file builds a full `AccountingConnection` literal. Add `defaultExemptTaxCodeRef: null, defaultPaymentAccountRef: null, providerConnectionRef: null,` next to `defaultTaxCodeRef` in each factory. On 2026-09-26 the candidates were `quickbooksProvider.test.ts`, `accountingPaymentPull.test.ts`, `accountingInvoicePush.test.ts`, `accountingReconcileWorker.test.ts`, `routes/accounting/index.test.ts` and `accountingConnectionService.test.ts`. A `toEqual` on a full mapped row also gains the three keys. These are wiring edits, not behaviour changes.

- [ ] **Step 7: Run and confirm they pass**

```bash
cd apps/api && npx vitest run src/services/accounting/accountingConnectionService.test.ts && npx tsc --noEmit -p .
pnpm test-stack up
cd apps/api && npx vitest run -c vitest.integration.config.ts src/__tests__/integration/accountingXeroColumns.integration.test.ts src/__tests__/integration/accounting-connections-rls.integration.test.ts
cd ../.. && DATABASE_URL="$(grep ^DATABASE_URL .env.test | cut -d= -f2-)" pnpm db:check-drift
```

Expected: PASS, tsc clean, no drift. Leave the test stack up for Task 2.

- [ ] **Step 8: Commit**

```bash
git add apps/api/migrations/2026-11-02-120000-accounting-connections-xero-columns.sql apps/api/src/db/schema/accounting.ts apps/api/src/services/accounting apps/api/src/__tests__/integration/accountingXeroColumns.integration.test.ts apps/api/src/jobs apps/api/src/routes/accounting
git commit -m "feat(accounting): Xero W02 connection columns (exempt tax, payment account, provider connection ref)

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 2: `pending_tenant` status, resolver exclusion, conflict lookup, tenant-held error

**Files:**
- Modify: `apps/api/src/services/accounting/accountingConnectionService.ts`: `AccountingConnectionStatus`, `resolveActiveConnection`, `resolveActiveConnectionRef`, new `getPartnerConnectionRef`, `AccountingProviderConflictError`, new `AccountingTenantHeldError`, `upsertConnection` (conflict branch + 23505 translation)
- Modify: `apps/api/src/routes/accounting/index.ts`: the `/connect` cross-provider check (D5)
- Modify: `apps/api/src/routes/accounting/providerGate.ts`: `listProvidersHandler` (D3)
- Modify: `apps/api/src/services/orgAccountReadinessIntegrations.ts`: `accountingConnectorState`
- Test: `accountingConnectionService.test.ts`, `providerGate.test.ts`, `routes/accounting/index.test.ts`, `orgAccountReadinessIntegrations.test.ts`, `accountingXeroColumns.integration.test.ts`

**Interfaces:**
- Consumes: A1, A2, A4, A5, D3, D5.
- Produces:
  ```ts
  export type AccountingConnectionStatus = 'connected' | 'disconnected' | 'reauth_required' | 'error' | 'pending_tenant';
  export const PENDING_TENANT_STATUS = 'pending_tenant' as const;
  /** The partner's row in ANY status, pending_tenant included; non-decrypting. For conflict checks only. */
  export async function getPartnerConnectionRef(dbc: DbExecutor, partnerId: string):
    Promise<{ id: string; provider: AccountingProviderId; status: AccountingConnectionStatus } | null>;
  export class AccountingProviderConflictError extends Error {
    constructor(existingProvider: AccountingProviderId, requestedProvider: AccountingProviderId, existingStatus?: AccountingConnectionStatus);
  } // message when existingStatus === 'pending_tenant': `Finish or cancel the ${A} connection before connecting ${B}`
  export class AccountingTenantHeldError extends Error {
    readonly code: 'accounting_tenant_held'; readonly status: 409; readonly provider: AccountingProviderId;
  } // message: `This ${label} organisation is connected to another Breeze account`
  ```

- [ ] **Step 1: Write the failing tests**

Append to `accountingConnectionService.test.ts`:

```ts
describe('pending_tenant (Xero W02)', () => {
  it('resolveActiveConnection and resolveActiveConnectionRef both exclude pending_tenant (the predicate is duplicated — PR #7182)', async () => {
    const whereSpy = vi.fn(() => ({ limit: async () => [] }));
    const dbc = { select: () => ({ from: () => ({ where: whereSpy }) }) } as any;
    await resolveActiveConnection(dbc, 'p1');
    await resolveActiveConnectionRef(dbc, 'p1');
    const rendered = whereSpy.mock.calls.map(([cond]) => new PgDialect().sqlToQuery(cond as SQL));
    for (const q of rendered) {
      expect(q.sql).toContain('"accounting_connections"."status" <>');
      expect(q.params).toContain('pending_tenant');
    }
  });

  it('getPartnerConnectionRef sees every status, pending_tenant included', async () => {
    const whereSpy = vi.fn(() => ({ limit: async () => [{ id: 'c1', provider: 'xero', status: 'pending_tenant' }] }));
    const dbc = { select: () => ({ from: () => ({ where: whereSpy }) }) } as any;
    await expect(getPartnerConnectionRef(dbc, 'p1')).resolves.toEqual({ id: 'c1', provider: 'xero', status: 'pending_tenant' });
    const q = new PgDialect().sqlToQuery(whereSpy.mock.calls[0]![0] as SQL);
    expect(q.params).not.toContain('pending_tenant');
  });

  it('conflict message tells the user to finish or cancel a pending connection', () => {
    expect(new AccountingProviderConflictError('xero', 'quickbooks', 'pending_tenant').message)
      .toBe('Finish or cancel the Xero connection before connecting QuickBooks');
    expect(new AccountingProviderConflictError('quickbooks', 'xero').message)
      .toBe('Disconnect QuickBooks before connecting Xero');
  });

  it('upsertConnection raises the pending-aware conflict when a pending_tenant row of another provider exists', async () => {
    const dbc = {
      insert: () => ({ values: () => ({ onConflictDoUpdate: () => ({ returning: async () => [] }) }) }),
      select: () => ({ from: () => ({ where: () => ({ limit: async () => [{ id: 'c1', provider: 'xero', status: 'pending_tenant' }] }) }) }),
      update: vi.fn(), delete: vi.fn(),
    } as any;
    await expect(upsertConnection(dbc, 'p1', 'quickbooks', { realmId: 'r1' })).rejects.toMatchObject({
      code: 'accounting_provider_conflict', message: 'Finish or cancel the Xero connection before connecting QuickBooks',
    });
  });

  it('upsertConnection turns the realm-fingerprint unique violation into AccountingTenantHeldError', async () => {
    const violation = Object.assign(new Error('dup'), { cause: { code: '23505', constraint_name: 'accounting_connections_provider_realm_fp_idx' } });
    const dbc = {
      insert: () => ({ values: () => ({ onConflictDoUpdate: () => ({ returning: async () => { throw violation; } }) }) }),
      select: vi.fn(), update: vi.fn(), delete: vi.fn(),
    } as any;
    const err = await upsertConnection(dbc, 'p1', 'xero', { realmId: 't1' }).catch((e) => e);
    expect(err).toBeInstanceOf(AccountingTenantHeldError);
    expect(err).toMatchObject({ code: 'accounting_tenant_held', status: 409, message: 'This Xero organisation is connected to another Breeze account' });
  });
});
```

(Import `PgDialect` from `drizzle-orm/pg-core` and `type SQL` from `drizzle-orm` if the file does not already. Check how `@breeze/shared/pgErrors` reads the constraint name (`pgErrorConstraint`), and shape `violation` to match: `constraint_name` or `constraint` on `.cause`.)

Append to `orgAccountReadinessIntegrations.test.ts`'s `accountingConnectorState` table:

```ts
    ['pending_tenant', 'disconnected'],
```

Append to `providerGate.test.ts`:

```ts
it('GET /accounting/providers reports a pending_tenant row as the active connection (so the other card greys out)', async () => {
  getPartnerConnectionRefMock.mockResolvedValue({ id: 'c1', provider: 'xero', status: 'pending_tenant' });
  const res = await callListProviders('p1');   // the file's existing harness for listProvidersHandler
  expect((await res.json()).activeConnection).toEqual({ provider: 'xero', status: 'pending_tenant' });
});
```

Append to `routes/accounting/index.test.ts` (use its helpers):

```ts
it('/connect refuses QuickBooks while a Xero pending_tenant row exists (409, pending wording)', async () => {
  getPartnerConnectionRefMock.mockResolvedValue({ id: 'c1', provider: 'xero', status: 'pending_tenant' });
  const res = await request('GET', '/accounting/quickbooks/connect');
  expect(res.status).toBe(409);
  expect(await res.json()).toMatchObject({ code: 'accounting_provider_conflict', error: 'Finish or cancel the Xero connection before connecting QuickBooks' });
});
```

Append to `accountingXeroColumns.integration.test.ts`:

```ts
import { eq } from 'drizzle-orm';
import { accountingConnections } from '../../db/schema';
import {
  AccountingProviderConflictError, getPartnerConnectionRef, resolveActiveConnection, resolveActiveConnectionRef,
} from '../../services/accounting/accountingConnectionService';

describe.skipIf(!RUN)('pending_tenant against real Postgres (W02 Task 2)', () => {
  it('is invisible to both resolvers, visible to getPartnerConnectionRef, and still holds the one-per-partner slot', async () => {
    const partner = await createPartner();
    const pending = await withSystemDbAccessContext(() => upsertConnection(db, partner.id, 'xero', {
      accessToken: 'a', refreshToken: 'r', status: 'pending_tenant', environment: 'production',
    }));
    await withSystemDbAccessContext(async () => {
      expect(await resolveActiveConnection(db, partner.id)).toBeNull();
      expect(await resolveActiveConnectionRef(db, partner.id)).toBeNull();
      expect(await getPartnerConnectionRef(db, partner.id)).toEqual({ id: pending.id, provider: 'xero', status: 'pending_tenant' });
    });
    const err = await withSystemDbAccessContext(() => upsertConnection(db, partner.id, 'quickbooks', { realmId: 'qbo-realm-pending' })).catch((e) => e);
    expect(err).toBeInstanceOf(AccountingProviderConflictError);
    expect(err.message).toBe('Finish or cancel the Xero connection before connecting QuickBooks');
    const rows = await withSystemDbAccessContext(() => db.select().from(accountingConnections).where(eq(accountingConnections.partnerId, partner.id)));
    expect(rows).toHaveLength(1);
    expect(rows[0]!.provider).toBe('xero');
  });
});
```

- [ ] **Step 2: Run and confirm they fail**

```bash
cd apps/api && npx vitest run src/services/accounting/accountingConnectionService.test.ts src/services/orgAccountReadinessIntegrations.test.ts src/routes/accounting/providerGate.test.ts src/routes/accounting/index.test.ts -t "pending"
```

Expected: FAIL. `getPartnerConnectionRef` and `AccountingTenantHeldError` do not exist, and the resolver predicates have no status filter.

- [ ] **Step 3: Implement in `accountingConnectionService.ts`**

```ts
import { and, eq, inArray, isNotNull, isNull, like, ne, or, sql, type SQL } from 'drizzle-orm';

export type AccountingConnectionStatus = 'connected' | 'disconnected' | 'reauth_required' | 'error' | 'pending_tenant';

/**
 * Xero W02: a connect whose grant authorised several organisations, waiting for
 * the user to pick one. It HOLDS the partner's one-connection slot (the unique
 * partner index counts it, so a half-finished connect blocks a QuickBooks
 * connect until cancelled or reaped) but is NOT an active connection: both
 * resolvers below exclude it, so no worker, producer or route ever acts on it.
 */
export const PENDING_TENANT_STATUS = 'pending_tenant' as const;

/** The resolvers' shared predicate. A1 and A2 MUST stay in lockstep (PR #7182 "Deferred"). */
function activeConnectionWhere(partnerId: string): SQL {
  return and(
    eq(accountingConnections.partnerId, partnerId),
    ne(accountingConnections.status, PENDING_TENANT_STATUS),
  ) as SQL;
}
```

In `resolveActiveConnection` and `resolveActiveConnectionRef`, replace `.where(eq(accountingConnections.partnerId, partnerId))` with `.where(activeConnectionWhere(partnerId))`. Then update the doc comments: replace "W02 adds the `pending_tenant` exclusion HERE" with "Excludes `pending_tenant` (Xero W02) via `activeConnectionWhere`, shared with `resolveActiveConnectionRef`."

```ts
/**
 * The partner's row in ANY status (pending_tenant included), non-decrypting.
 * For the one-provider CONFLICT checks only: upsertConnection's no-row branch,
 * the /connect pre-check and GET /accounting/providers. Those must see a
 * pending Xero row, or a QuickBooks connect over it fails as a generic persist
 * error instead of 409 and the UI never greys the other card out.
 */
export async function getPartnerConnectionRef(
  dbc: DbExecutor,
  partnerId: string,
): Promise<{ id: string; provider: AccountingProviderId; status: AccountingConnectionStatus } | null> {
  const [row] = await dbc
    .select({ id: accountingConnections.id, provider: accountingConnections.provider, status: accountingConnections.status })
    .from(accountingConnections)
    .where(eq(accountingConnections.partnerId, partnerId))
    .limit(1);
  return row
    ? { id: row.id, provider: row.provider as AccountingProviderId, status: row.status as AccountingConnectionStatus }
    : null;
}

/** 409 — the partner already has a connection to a DIFFERENT provider (spec D2). */
export class AccountingProviderConflictError extends Error {
  readonly code = 'accounting_provider_conflict' as const;
  readonly status = 409 as const;
  constructor(
    readonly existingProvider: AccountingProviderId,
    readonly requestedProvider: AccountingProviderId,
    readonly existingStatus?: AccountingConnectionStatus,
  ) {
    const existing = accountingProviderDisplayName(existingProvider);
    const requested = accountingProviderDisplayName(requestedProvider);
    super(existingStatus === PENDING_TENANT_STATUS
      ? `Finish or cancel the ${existing} connection before connecting ${requested}`
      : `Disconnect ${existing} before connecting ${requested}`);
    this.name = 'AccountingProviderConflictError';
  }
}

/**
 * 409 — the realm/tenant is already connected to ANOTHER partner (spec W02).
 * Raised from the `(provider, realm_id_fingerprint)` unique index, which Postgres
 * enforces regardless of RLS, so two partners racing for one tenant cannot both win.
 */
export class AccountingTenantHeldError extends Error {
  readonly code = 'accounting_tenant_held' as const;
  readonly status = 409 as const;
  constructor(readonly provider: AccountingProviderId) {
    super(`This ${accountingProviderDisplayName(provider)} organisation is connected to another Breeze account`);
    this.name = 'AccountingTenantHeldError';
  }
}

export const REALM_FINGERPRINT_UNIQUE_INDEX = 'accounting_connections_provider_realm_fp_idx';
```

In `upsertConnection`, wrap the insert and switch the conflict branch:

```ts
  let row: AccountingConnectionRow | undefined;
  try {
    [row] = await db
      .insert(accountingConnections)
      .values(values)
      .onConflictDoUpdate({ /* …unchanged… */ })
      .returning();
  } catch (err) {
    if (isPgUniqueViolation(err, REALM_FINGERPRINT_UNIQUE_INDEX)) throw new AccountingTenantHeldError(provider);
    throw err;
  }

  if (!row) {
    // Any status: a pending_tenant row of another provider must 409 too (W02).
    const existing = await getPartnerConnectionRef(db, partnerId);
    if (existing && existing.provider !== provider) {
      throw new AccountingProviderConflictError(existing.provider, provider, existing.status);
    }
    throw new Error('Failed to persist accounting connection');
  }
```

The existing `backfillRealmFingerprints` catch can use `REALM_FINGERPRINT_UNIQUE_INDEX` too; this is optional.

- [ ] **Step 4: Switch D3 and D5 to the any-status lookup**

In `routes/accounting/index.ts` `/connect` (W01d step 5):

```ts
const existing = await getPartnerConnectionRef(db, partner.partnerId);
if (existing && existing.provider !== provider) {
  const conflict = new AccountingProviderConflictError(existing.provider, provider, existing.status);
  return c.json({ error: conflict.message, code: conflict.code }, 409);
}
```

In `providerGate.ts` `listProvidersHandler`:

```ts
const active = await getPartnerConnectionRef(db, partnerId);
// …
activeConnection: active ? { provider: active.provider, status: active.status } : null,
```

Update the route test mocks of `accountingConnectionService` to export `getPartnerConnectionRef` (a wiring edit).

In `orgAccountReadinessIntegrations.ts` `accountingConnectorState`:

```ts
    case 'disconnected':
    case 'pending_tenant': // a half-finished connect is not a working connection
      return 'disconnected';
```

- [ ] **Step 5: Run and confirm they pass**

```bash
cd apps/api && npx vitest run src/services/accounting src/routes/accounting src/services/orgAccountReadinessIntegrations.test.ts src/jobs/accountingSyncWorker.test.ts src/jobs/accountingReconcileWorker.test.ts && npx tsc --noEmit -p .
cd apps/api && npx vitest run -c vitest.integration.config.ts src/__tests__/integration/accountingXeroColumns.integration.test.ts src/__tests__/integration/accountingOneConnectionPerPartner.integration.test.ts
```

Expected: PASS. The W01a one-per-partner suite still passes: the non-pending message is byte-identical.

- [ ] **Step 6: Commit**

```bash
git add -A apps/api/src
git commit -m "feat(accounting): pending_tenant status excluded by both resolvers; any-status conflict lookup; tenant-held 409 (Xero W02)

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 3: Xero env vars (env.ts, validate.ts, .env.example, compose, parity, registry, docs)

**Files:**
- Modify: `apps/api/src/config/env.ts`, `apps/api/src/config/validate.ts`, `.env.example`, `docker-compose.yml`, `deploy/docker-compose.prod.yml`
- Modify: `apps/api/src/config/envComposeParity.test.ts`, `apps/api/src/config/validate.test.ts`
- Modify: `apps/api/src/system/connections/registry.ts`, `apps/api/src/system/connections/registry.test.ts` (`REVIEWED_PUBLIC_VARS`)
- Modify: `apps/docs/src/content/docs/deploy/environment.mdx` (new section `## Accounting (Xero)`)
- Create: `apps/api/src/config/env.xero.test.ts`

**Interfaces:**
- Produces (`config/env.ts`, read at **call time** so tests can flip them without `vi.resetModules()`):
  ```ts
  export function xeroOAuthConfig(): { clientId: string; clientSecret: string; redirectUri: string };  // '' = unset
  export function xeroWebhookKey(): string;                                                          // '' = unset (W05)
  export const XERO_DEFAULT_DAILY_CALL_LIMIT = 1000;
  export function xeroDailyCallLimit(): number;   // positive integer from XERO_DAILY_CALL_LIMIT, else 1000
  ```

- [ ] **Step 1: Write the failing tests**

`config/env.xero.test.ts`:

```ts
import { afterEach, describe, expect, it } from 'vitest';
import { xeroDailyCallLimit, xeroOAuthConfig, xeroWebhookKey, XERO_DEFAULT_DAILY_CALL_LIMIT } from './env';

const KEYS = ['XERO_CLIENT_ID', 'XERO_CLIENT_SECRET', 'XERO_REDIRECT_URI', 'XERO_WEBHOOK_KEY', 'XERO_DAILY_CALL_LIMIT'] as const;
const saved = Object.fromEntries(KEYS.map((k) => [k, process.env[k]]));
afterEach(() => { for (const k of KEYS) { if (saved[k] === undefined) delete process.env[k]; else process.env[k] = saved[k]; } });

describe('Xero env readers (W02)', () => {
  it('reads OAuth credentials at call time, trimmed, empty when unset', () => {
    for (const k of KEYS) delete process.env[k];
    expect(xeroOAuthConfig()).toEqual({ clientId: '', clientSecret: '', redirectUri: '' });
    process.env.XERO_CLIENT_ID = '  abc  ';
    process.env.XERO_CLIENT_SECRET = 's';
    process.env.XERO_REDIRECT_URI = 'https://breeze.example.com/api/v1/accounting/xero/callback';
    expect(xeroOAuthConfig()).toEqual({ clientId: 'abc', clientSecret: 's', redirectUri: 'https://breeze.example.com/api/v1/accounting/xero/callback' });
  });

  it('webhook key is empty when unset', () => {
    delete process.env.XERO_WEBHOOK_KEY;
    expect(xeroWebhookKey()).toBe('');
  });

  it.each([
    [undefined, 1000], ['', 1000], ['5000', 5000], ['0', 1000], ['-3', 1000], ['lots', 1000], ['12.5', 1000],
  ])('XERO_DAILY_CALL_LIMIT=%s → %d', (raw, expected) => {
    if (raw === undefined) delete process.env.XERO_DAILY_CALL_LIMIT; else process.env.XERO_DAILY_CALL_LIMIT = raw;
    expect(xeroDailyCallLimit()).toBe(expected);
    expect(XERO_DEFAULT_DAILY_CALL_LIMIT).toBe(1000);
  });
});
```

Append to `validate.test.ts`:

```ts
describe('Xero env (W02)', () => {
  const KEYS = ['XERO_CLIENT_ID', 'XERO_CLIENT_SECRET', 'XERO_REDIRECT_URI', 'XERO_WEBHOOK_KEY', 'XERO_DAILY_CALL_LIMIT'] as const;
  it.each(KEYS)('declares %s in the env schema', (key) => {
    expect(ENV_SCHEMA_KEYS).toContain(key);
    expect(buildEnvParseInput({ [key]: 'sentinel' })[key]).toBe('sentinel');
  });
  it('boots with every Xero var unset (all optional)', () => {
    withEnv({ ...validEnv }, () => { expect(() => validateConfig()).not.toThrow(); });
  });
  it('refuses a non-integer XERO_DAILY_CALL_LIMIT', () => {
    withEnv({ ...validEnv, XERO_DAILY_CALL_LIMIT: 'unlimited' }, () => {
      expect(() => validateConfig()).toThrow(/XERO_DAILY_CALL_LIMIT/);
    });
  });
  it('refuses XERO_DAILY_CALL_LIMIT=0', () => {
    withEnv({ ...validEnv, XERO_DAILY_CALL_LIMIT: '0' }, () => {
      expect(() => validateConfig()).toThrow(/XERO_DAILY_CALL_LIMIT/);
    });
  });
});
```

Append to `envComposeParity.test.ts`, after the QuickBooks block:

```ts
/**
 * Xero (W02). Pinned on all four axes for the same reason QBO_* is: a var that
 * validate.ts accepts but no compose file maps is a silent no-op.
 */
describe('Xero XERO_* env plumbing (W02)', () => {
  const ROOT_COMPOSE = readFileSync(path.join(REPO_ROOT, 'docker-compose.yml'), 'utf8');
  const PROD_COMPOSE = readFileSync(path.join(REPO_ROOT, 'deploy/docker-compose.prod.yml'), 'utf8');
  const XERO_VARS = ['XERO_CLIENT_ID', 'XERO_CLIENT_SECRET', 'XERO_REDIRECT_URI', 'XERO_WEBHOOK_KEY', 'XERO_DAILY_CALL_LIMIT'] as const;

  it.each(XERO_VARS)('%s is declared in the validate.ts schema', (name) => {
    expect(ENV_SCHEMA_KEYS).toContain(name);
  });
  it.each(XERO_VARS)('%s is documented in the root .env.example', (name) => {
    expect(documentedEnvExampleVars('.env.example')).toContain(name);
  });
  it.each(XERO_VARS)('%s reaches the api container in docker-compose.yml', (name) => {
    expect(isReferencedInCompose(name, ROOT_COMPOSE)).toBe(true);
  });
  it.each(XERO_VARS)('%s reaches the api container in deploy/docker-compose.prod.yml', (name) => {
    expect(isReferencedInCompose(name, PROD_COMPOSE)).toBe(true);
  });
});
```

- [ ] **Step 2: Run and confirm they fail**

```bash
cd apps/api && npx vitest run src/config/env.xero.test.ts src/config/validate.test.ts src/config/envComposeParity.test.ts -t "Xero"
```

Expected: FAIL. The readers do not exist, and no Xero key is declared or mapped.

- [ ] **Step 3: Implement**

`config/env.ts`, after the QBO block:

```ts
// Xero (accounting integration, Xero W02). Read at CALL time (not module load)
// so tests can flip them without vi.resetModules(). '' = unset: the Xero card
// stays hidden and every Xero route answers provider_not_configured.
export function xeroOAuthConfig(): { clientId: string; clientSecret: string; redirectUri: string } {
  return {
    clientId: process.env.XERO_CLIENT_ID?.trim() ?? '',
    clientSecret: process.env.XERO_CLIENT_SECRET?.trim() ?? '',
    redirectUri: process.env.XERO_REDIRECT_URI?.trim() ?? '',
  };
}
// The Xero webhook signing key (x-xero-signature HMAC). Registered in W02 so the
// deploy plumbing lands once; only POST /webhooks/xero (W05) reads it.
export function xeroWebhookKey(): string {
  return process.env.XERO_WEBHOOK_KEY?.trim() ?? '';
}
// Per-organisation daily call budget. 1000 = Xero Starter tier; hosted sets its
// tier's value (spec "Commercial constraint"). validate.ts refuses a bad value at
// boot, so the fallback here only guards direct callers in tests.
export const XERO_DEFAULT_DAILY_CALL_LIMIT = 1000;
export function xeroDailyCallLimit(): number {
  const raw = process.env.XERO_DAILY_CALL_LIMIT?.trim();
  if (!raw || !/^\d+$/.test(raw)) return XERO_DEFAULT_DAILY_CALL_LIMIT;
  const value = Number(raw);
  return value > 0 ? value : XERO_DEFAULT_DAILY_CALL_LIMIT;
}
```

`config/validate.ts`: put these keys after `QBO_WEBHOOK_VERIFIER_TOKEN` in the object schema:

```ts
    // Xero accounting integration (W02). All optional at boot: the connect flow
    // validates the OAuth trio lazily (provider.configError()), the webhook key
    // is only read by POST /webhooks/xero (W05), and the daily limit defaults to
    // the Starter tier's 1000.
    XERO_CLIENT_ID: z.string().optional(),
    XERO_CLIENT_SECRET: z.string().optional(),
    XERO_REDIRECT_URI: z.string().optional(),
    XERO_WEBHOOK_KEY: z.string().optional(),
    XERO_DAILY_CALL_LIMIT: z.string().optional(),
```

Put this in the schema's `superRefine`, next to the `M365_SYNC_*` integer knobs:

```ts
    const xeroDailyRaw = (data.XERO_DAILY_CALL_LIMIT ?? '').trim();
    if (xeroDailyRaw && (!/^\d+$/.test(xeroDailyRaw) || Number(xeroDailyRaw) < 1)) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['XERO_DAILY_CALL_LIMIT'],
        message: 'XERO_DAILY_CALL_LIMIT must be a positive integer when set (your Xero tier\'s per-organisation daily call limit; Starter is 1000).',
      });
    }
```

`.env.example`, after the QuickBooks block:

```bash
# --------------------------------------------
# Xero (accounting integration)
# --------------------------------------------
# All optional — leave XERO_CLIENT_ID unset to keep the Xero integration dark
# (the Xero card is hidden). Register a Web app at developer.xero.com, then:
#   XERO_CLIENT_ID / XERO_CLIENT_SECRET  from the app's Configuration page.
#   XERO_REDIRECT_URI  must match a redirect URI registered on the app, and be
#                      the PUBLIC url of this deployment's API.
#   XERO_WEBHOOK_KEY   the app's webhook signing key (used once payment pull
#                      ships; harmless to set early).
#   XERO_DAILY_CALL_LIMIT  per-organisation daily API budget for your Xero tier
#                      (Starter = 1000, the default; Core/Plus/Advanced = 5000).
#
# XERO_CLIENT_ID=
# XERO_CLIENT_SECRET=
# XERO_REDIRECT_URI=https://your-domain.example.com/api/v1/accounting/xero/callback
# XERO_WEBHOOK_KEY=
# XERO_DAILY_CALL_LIMIT=1000
```

Both `docker-compose.yml` and `deploy/docker-compose.prod.yml`: after `QBO_WEBHOOK_VERIFIER_TOKEN` in the `api` environment anchor:

```yaml
  # Xero accounting integration (W02). All optional; unset keeps it dark.
  # Mapped explicitly: Compose only interpolates vars listed in this block.
  XERO_CLIENT_ID: ${XERO_CLIENT_ID:-}
  XERO_CLIENT_SECRET: ${XERO_CLIENT_SECRET:-}
  XERO_REDIRECT_URI: ${XERO_REDIRECT_URI:-}
  XERO_WEBHOOK_KEY: ${XERO_WEBHOOK_KEY:-}
  XERO_DAILY_CALL_LIMIT: ${XERO_DAILY_CALL_LIMIT:-}
```

`system/connections/registry.ts`, after the `quickbooks` entry:

```ts
  defineEntry({
    id: 'xero',
    group: 'billing',
    label: 'Xero',
    docsUrl: '/deploy/environment/#accounting-xero',
    vars: [
      { name: 'XERO_CLIENT_ID', secret: false, required: true },
      { name: 'XERO_CLIENT_SECRET', required: true },
      { name: 'XERO_REDIRECT_URI', secret: false },
      { name: 'XERO_WEBHOOK_KEY' },
      { name: 'XERO_DAILY_CALL_LIMIT', secret: false },
    ],
  }),
```

`registry.test.ts` `REVIEWED_PUBLIC_VARS`: add `'XERO_CLIENT_ID'`, `'XERO_DAILY_CALL_LIMIT'` and `'XERO_REDIRECT_URI'` in alphabetical position.

`apps/docs/src/content/docs/deploy/environment.mdx`, after the QuickBooks section:

```mdx
## Accounting (Xero)

| Variable | Default | Description |
|---|---|---|
| `XERO_CLIENT_ID` | — | Client ID of your Xero Web app (developer.xero.com → My Apps). The Xero card only appears when this is set. |
| `XERO_CLIENT_SECRET` | — | That app's client secret |
| `XERO_REDIRECT_URI` | — | OAuth callback registered on the app, e.g. `https://your-domain/api/v1/accounting/xero/callback` |
| `XERO_WEBHOOK_KEY` | — | The app's webhook signing key. Read once payment pull-back for Xero ships; safe to set now. |
| `XERO_DAILY_CALL_LIMIT` | `1000` | Per-organisation daily API budget for your Xero tier (Starter 1000; Core, Plus and Advanced 5000). Background sweeps pause below 20% of it; invoice and payment pushes keep priority. |

<Aside>
  Xero has no sandbox: connections are always "production", and testing uses Xero's Demo Company. Breeze connects to exactly one Xero organisation per partner. Disconnecting removes only Breeze's own connection in Xero — it never revokes the rest of your Xero app authorisations.
</Aside>
```

- [ ] **Step 4: Run and confirm they pass**

```bash
cd apps/api && npx vitest run src/config src/system/connections && npx tsc --noEmit -p .
```

Expected: PASS, including the existing parity allow-list checks and the registry `docsUrl` check for `#accounting-xero`.

- [ ] **Step 5: Commit**

```bash
git add apps/api/src/config apps/api/src/system/connections .env.example docker-compose.yml deploy/docker-compose.prod.yml apps/docs/src/content/docs/deploy/environment.mdx
git commit -m "feat(config): XERO_* env vars (OAuth trio, webhook key, daily call limit) plumbed end to end (Xero W02)

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 4: `xeroHttp.ts`: tokens, identity API, tenant-scoped GET, errors; token-message labels; rotation race

**Files:**
- Create: `apps/api/src/services/accounting/xeroHttp.ts`, `xeroHttp.test.ts`
- Modify: `apps/api/src/services/accounting/accountingRateLimit.ts` (receive `parseRetryAfterMs`), `quickbooksProvider.ts` (import it from there; keep a re-export)
- Modify: `apps/api/src/services/accounting/accountingTokens.ts` (provider-labelled messages)
- Modify: `apps/api/src/services/accounting/accountingConnectionService.ts` (`refreshRealmSettings` provider-labelled messages)
- Test: `accountingTokens.test.ts` (mock wiring and the rotation-race tests), `accountingConnectionService.test.ts`

**Interfaces:**
- Consumes: B1–B4, C1–C3, `xeroOAuthConfig()` (Task 3).
- Produces:
  ```ts
  export const XERO_AUTHORIZE_URL = 'https://login.xero.com/identity/connect/authorize';
  export const XERO_TOKEN_URL = 'https://identity.xero.com/connect/token';
  export const XERO_CONNECTIONS_URL = 'https://api.xero.com/connections';
  export const XERO_API_BASE = 'https://api.xero.com/api.xro/2.0';
  export const XERO_SCOPES: readonly string[];  // pinned, see Global Constraints
  export const XERO_REFRESH_TOKEN_LIFETIME_MS: number;   // 60 days
  export const XERO_REQUEST_TIMEOUT_MS = 15_000;
  export type XeroTokenGrant = { grantType: 'authorization_code'; code: string } | { grantType: 'refresh_token'; refreshToken: string };
  export async function requestXeroTokens(grant: XeroTokenGrant): Promise<ConnectionTokens>;         // realmId: ''
  export function decodeXeroAuthEventId(accessToken: string): string | null;
  export async function listXeroConnections(accessToken: string, authEventId: string | null): Promise<ProviderTenant[]>;
  export async function deleteXeroConnection(accessToken: string, connectionRef: string): Promise<void>; // 404 = already gone
  export interface XeroCallContext { connectionId: string; tenantId: string; accessToken: string; rate: RateLimitSpec; timeoutMs?: number }
  export async function xeroApiGet<T>(ctx: XeroCallContext, path: string, operation: string): Promise<T>;
  export function xeroApiError(operation: string, status: number, headers: Headers, text: string): AccountingProviderError;
  export function xeroTokenError(operation: string, status: number, headers: Headers, text: string): AccountingProviderError;
  // accountingRateLimit.ts
  export function parseRetryAfterMs(header: string | null): number | null;
  ```
- `ProviderTenant` is declared in `types.ts` by Task 5. Declare it **in this task** (Step 3) so `xeroHttp.ts` compiles, and Task 5 uses it as-is.

- [ ] **Step 1: Confirm the scope strings at the Xero developer portal (open verification item 3)**

Sign in to developer.xero.com with the hosted app's owner account. Open **My Apps → (the Breeze app) → Configuration**, check the scopes the app is offered, and compare them with:

```
offline_access accounting.contacts accounting.invoices accounting.payments accounting.settings.read
```

Record the result in the PR body.
- **The same strings are offered** (expected; Xero assigned granular scopes to every Web app by the end of April 2026): proceed.
- **Different granular names:** use the portal's names in `XERO_SCOPES` and in the pinned test below.
- **Fallback, only if the portal offers no granular scopes at all:** replace `accounting.invoices accounting.payments` with the broad `accounting.transactions` and file a follow-up. Broad scopes stop working in September 2027.
- **No portal access:** proceed with the pinned strings and make lab step X14 a merge blocker for W02c.

- [ ] **Step 2: Write the failing tests**

`xeroHttp.test.ts`:

```ts
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const { slotMock, noteMock } = vi.hoisted(() => ({
  slotMock: vi.fn((_p: unknown, _s: unknown, _c: unknown, fn: () => unknown) => fn()),
  noteMock: vi.fn(async () => {}),
}));
vi.mock('./accountingRateLimit', async (orig) => ({
  ...(await orig<typeof import('./accountingRateLimit')>()),
  withProviderCallSlot: slotMock,
  noteDailyRemaining: noteMock,
}));

import {
  decodeXeroAuthEventId, deleteXeroConnection, listXeroConnections, requestXeroTokens, xeroApiGet,
  XERO_CONNECTIONS_URL, XERO_REFRESH_TOKEN_LIFETIME_MS, XERO_SCOPES, XERO_TOKEN_URL,
} from './xeroHttp';
import { AccountingProviderError } from './accountingProviderError';

const SPEC = {
  perConnection: { limit: 60, windowSeconds: 60 }, maxConcurrentPerConnection: 5,
  appWide: { limit: 10_000, windowSeconds: 60 }, dailyPerConnection: { limit: () => 1000 },
};
const json = (body: unknown, status = 200, headers: Record<string, string> = {}) =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json', ...headers } });
const jwt = (claims: Record<string, unknown>) => {
  const enc = (o: unknown) => Buffer.from(JSON.stringify(o)).toString('base64url');
  return `${enc({ alg: 'RS256', typ: 'JWT' })}.${enc(claims)}.signature`;
};

beforeEach(() => {
  process.env.XERO_CLIENT_ID = 'client-abc';
  process.env.XERO_CLIENT_SECRET = 'secret-xyz';
  process.env.XERO_REDIRECT_URI = 'https://breeze.example.com/api/v1/accounting/xero/callback';
  vi.useFakeTimers();
  vi.setSystemTime(new Date('2026-10-01T00:00:00Z'));
});
afterEach(() => { vi.useRealTimers(); vi.restoreAllMocks(); slotMock.mockClear(); noteMock.mockClear(); });

describe('XERO_SCOPES (open verification item 3)', () => {
  it('is exactly the granular set, never the deprecated broad transactions scope', () => {
    expect(XERO_SCOPES.join(' ')).toBe('offline_access accounting.contacts accounting.invoices accounting.payments accounting.settings.read');
    expect(XERO_SCOPES).not.toContain('accounting.transactions');
  });
});

describe('requestXeroTokens', () => {
  it('exchanges a code with HTTP Basic client auth and stamps a sliding 60-day refresh expiry', async () => {
    const fetchMock = vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce(json({ access_token: 'at1', refresh_token: 'rt1', expires_in: 1800, token_type: 'Bearer' }));
    const tokens = await requestXeroTokens({ grantType: 'authorization_code', code: 'the-code' });
    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe(XERO_TOKEN_URL);
    expect((init.headers as Record<string, string>).Authorization).toBe(`Basic ${Buffer.from('client-abc:secret-xyz').toString('base64')}`);
    const body = new URLSearchParams(init.body as string);
    expect(Object.fromEntries(body)).toEqual({
      grant_type: 'authorization_code', code: 'the-code',
      redirect_uri: 'https://breeze.example.com/api/v1/accounting/xero/callback',
    });
    expect(tokens).toEqual({
      realmId: '', accessToken: 'at1', refreshToken: 'rt1',
      accessTokenExpiresAt: new Date('2026-10-01T00:30:00Z'),
      refreshTokenExpiresAt: new Date(Date.parse('2026-10-01T00:00:00Z') + XERO_REFRESH_TOKEN_LIFETIME_MS),
    });
    expect(XERO_REFRESH_TOKEN_LIFETIME_MS).toBe(60 * 24 * 60 * 60 * 1000);
    expect(slotMock).not.toHaveBeenCalled(); // token endpoint is outside the call slot (C4)
  });

  it('refresh re-stamps the sliding expiry from NOW', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce(json({ access_token: 'at2', refresh_token: 'rt2', expires_in: 1800 }));
    vi.setSystemTime(new Date('2026-11-15T12:00:00Z'));
    const tokens = await requestXeroTokens({ grantType: 'refresh_token', refreshToken: 'rt1' });
    expect(tokens.refreshTokenExpiresAt.getTime()).toBe(Date.parse('2026-11-15T12:00:00Z') + XERO_REFRESH_TOKEN_LIFETIME_MS);
  });

  it('invalid_grant is kind reauth and never echoes the token', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce(json({ error: 'invalid_grant' }, 400));
    const err = await requestXeroTokens({ grantType: 'refresh_token', refreshToken: 'rt-secret' }).catch((e) => e);
    expect(err).toBeInstanceOf(AccountingProviderError);
    expect(err).toMatchObject({ kind: 'reauth', provider: 'xero', providerCode: 'invalid_grant', httpStatus: 400 });
    expect(String(err.message)).not.toContain('rt-secret');
  });

  it.each([
    [500, {}, 'transient'],
    [429, { 'retry-after': '30' }, 'rate_limited'],
    [400, {}, 'validation'],
  ])('HTTP %d → %s', async (status, headers, kind) => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce(json({ error: status === 400 ? 'invalid_client' : 'x' }, status, headers as Record<string, string>));
    await expect(requestXeroTokens({ grantType: 'authorization_code', code: 'c' })).rejects.toMatchObject({ kind });
  });

  it('a 200 missing refresh_token is a transient failure, not a half-stored grant', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce(json({ access_token: 'at', expires_in: 1800 }));
    await expect(requestXeroTokens({ grantType: 'authorization_code', code: 'c' })).rejects.toMatchObject({ kind: 'transient' });
  });
});

describe('decodeXeroAuthEventId (Review Focus 4)', () => {
  it('reads authentication_event_id from the access token', () => {
    expect(decodeXeroAuthEventId(jwt({ authentication_event_id: 'd0ddcf81-f942-4f4d-b3c7-f98045204db4' })))
      .toBe('d0ddcf81-f942-4f4d-b3c7-f98045204db4');
  });
  it.each([
    ['claim missing', jwt({ sub: 'x' })],
    ['claim empty', jwt({ authentication_event_id: '' })],
    ['claim not a string', jwt({ authentication_event_id: 42 })],
    ['claim with odd characters', jwt({ authentication_event_id: 'a b;c' })],
    ['not a JWT', 'opaque-token'],
    ['garbage payload', 'a.!!!.c'],
  ])('%s → null (fail closed)', (_label, token) => {
    expect(decodeXeroAuthEventId(token)).toBeNull();
  });
});

describe('listXeroConnections', () => {
  const rows = [
    { id: 'conn-A', authEventId: 'evt-1', tenantId: 'ten-A', tenantType: 'ORGANISATION', tenantName: 'Alpha Ltd' },
    { id: 'conn-B', authEventId: 'evt-OTHER', tenantId: 'ten-B', tenantType: 'ORGANISATION', tenantName: 'Other partner Ltd' },
    { id: 'conn-C', authEventId: 'evt-1', tenantId: 'ten-C', tenantType: 'PRACTICEMANAGER', tenantName: 'Practice' },
  ];

  it('filters by authEventId in the query AND client-side (never returns another auth event\'s links)', async () => {
    const fetchMock = vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce(json(rows));
    const out = await listXeroConnections('at', 'evt-1');
    expect(fetchMock.mock.calls[0]![0]).toBe(`${XERO_CONNECTIONS_URL}?authEventId=evt-1`);
    expect(out).toEqual([
      { tenantId: 'ten-A', connectionRef: 'conn-A', name: 'Alpha Ltd', tenantType: 'ORGANISATION', authEventId: 'evt-1' },
      { tenantId: 'ten-C', connectionRef: 'conn-C', name: 'Practice', tenantType: 'PRACTICEMANAGER', authEventId: 'evt-1' },
    ]);
  });

  it('unfiltered (reconnect lookup) returns every link', async () => {
    const fetchMock = vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce(json(rows));
    expect(await listXeroConnections('at', null)).toHaveLength(3);
    expect(fetchMock.mock.calls[0]![0]).toBe(XERO_CONNECTIONS_URL);
  });

  it('a non-2xx is a provider error', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce(json({ Title: 'Unauthorized' }, 401));
    await expect(listXeroConnections('at', 'evt-1')).rejects.toMatchObject({ provider: 'xero', httpStatus: 401 });
  });
});

describe('deleteXeroConnection', () => {
  it('DELETEs /connections/{id}; 204 and 404 both resolve', async () => {
    const fetchMock = vi.spyOn(globalThis, 'fetch')
      .mockResolvedValueOnce(new Response(null, { status: 204 }))
      .mockResolvedValueOnce(new Response(null, { status: 404 }));
    await deleteXeroConnection('at', 'conn-A');
    await deleteXeroConnection('at', 'conn-gone');
    expect(fetchMock.mock.calls[0]![0]).toBe(`${XERO_CONNECTIONS_URL}/conn-A`);
    expect((fetchMock.mock.calls[0]![1] as RequestInit).method).toBe('DELETE');
  });
  it('a 500 throws', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce(new Response('boom', { status: 500 }));
    await expect(deleteXeroConnection('at', 'conn-A')).rejects.toMatchObject({ kind: 'transient' });
  });
});

describe('xeroApiGet', () => {
  const ctx = { connectionId: 'c1', tenantId: 'ten-A', accessToken: 'at', rate: SPEC };

  it('sends the tenant header, takes a call slot, and records X-DayLimit-Remaining', async () => {
    const fetchMock = vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce(json({ Organisations: [] }, 200, { 'x-daylimit-remaining': '412' }));
    await xeroApiGet(ctx, 'Organisation', 'Xero organisation read');
    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe('https://api.xero.com/api.xro/2.0/Organisation');
    expect(init.headers).toMatchObject({ Authorization: 'Bearer at', 'xero-tenant-id': 'ten-A', Accept: 'application/json' });
    expect(slotMock).toHaveBeenCalledWith('xero', SPEC, 'c1', expect.any(Function));
    expect(noteMock).toHaveBeenCalledWith('xero', 'c1', 412);
  });

  it('429 is rate_limited with Retry-After', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce(json({}, 429, { 'retry-after': '30', 'x-rate-limit-problem': 'minute' }));
    await expect(xeroApiGet(ctx, 'Accounts', 'Xero account list')).rejects.toMatchObject({ kind: 'rate_limited', retryAfterMs: 30_000, providerCode: 'minute' });
  });

  it('400 is validation with the first ValidationErrors message', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce(json({ ErrorNumber: 10, Type: 'ValidationException', Message: 'A validation exception occurred', Elements: [{ ValidationErrors: [{ Message: 'Account code is invalid' }] }] }, 400));
    await expect(xeroApiGet(ctx, 'Accounts', 'Xero account list')).rejects.toMatchObject({ kind: 'validation', providerMessage: 'Account code is invalid' });
  });

  it('404 is not_found; 503 is transient', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce(json({}, 404)).mockResolvedValueOnce(json({}, 503));
    await expect(xeroApiGet(ctx, 'X', 'op')).rejects.toMatchObject({ kind: 'not_found' });
    await expect(xeroApiGet(ctx, 'X', 'op')).rejects.toMatchObject({ kind: 'transient' });
  });

  it('a 200 that is not JSON is transient and does not leak the body into the message', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce(new Response('<html>proxy error</html>', { status: 200 }));
    const err = await xeroApiGet(ctx, 'X', 'Xero organisation read').catch((e) => e);
    expect(err).toMatchObject({ kind: 'transient' });
    expect(err.message).not.toContain('proxy');
  });
});
```

Append to `accountingTokens.test.ts`. First the mock wiring: add `accountingProviderDisplayName: (id: string) => (id === 'xero' ? 'Xero' : 'QuickBooks')` to the `vi.mock('./providerRegistry', …)` factory. Then:

```ts
import { xeroTokenError } from './xeroHttp';

describe('Xero rotation race (Review Focus 5)', () => {
  it('a loser whose refresh gets invalid_grant after a peer rotated returns the PEER token and never marks reauth', async () => {
    const db = makeLockableDb(lockedRow());
    mocks.provider.refresh.mockImplementationOnce(async () => {
      db.state.row = lockedRow({
        refreshTokenEncrypted: encryptSecret('PEER-rt'),
        accessTokenEncrypted: encryptSecret('PEER-at'),
        accessTokenExpiresAt: new Date(Date.now() + 30 * 60_000),
      });
      throw xeroTokenError('Xero token refresh', 400, new Headers(), JSON.stringify({ error: 'invalid_grant' }));
    });
    const token = await getValidAccessToken(db.db, connection({ provider: 'xero', accessTokenExpiresAt: new Date(Date.now() + 60_000) }));
    expect(token).toBe('PEER-at');
    expect(mocks.markStatus).not.toHaveBeenCalled();
    expect(mocks.updateTokens).not.toHaveBeenCalled();
  });

  it('a loser whose refresh SUCCEEDS (Xero 30-minute grace) discards its own rotation for the peer\'s', async () => {
    const db = makeLockableDb(lockedRow());
    mocks.provider.refresh.mockImplementationOnce(async () => {
      db.state.row = lockedRow({
        refreshTokenEncrypted: encryptSecret('PEER-rt'),
        accessTokenEncrypted: encryptSecret('PEER-at'),
        accessTokenExpiresAt: new Date(Date.now() + 30 * 60_000),
      });
      return { realmId: '', accessToken: 'MINE-at', refreshToken: 'MINE-rt', accessTokenExpiresAt: new Date(Date.now() + 30 * 60_000), refreshTokenExpiresAt: new Date(Date.now() + 60 * 86_400_000) };
    });
    const token = await getValidAccessToken(db.db, connection({ provider: 'xero', accessTokenExpiresAt: new Date(Date.now() + 60_000) }));
    expect(token).toBe('PEER-at');
    expect(mocks.updateTokens).not.toHaveBeenCalled();
  });

  it('a genuine Xero invalid_grant (row still holds our token) marks reauth with a Xero-labelled message', async () => {
    const db = makeLockableDb(lockedRow());
    mocks.provider.refresh.mockRejectedValueOnce(xeroTokenError('Xero token refresh', 400, new Headers(), JSON.stringify({ error: 'invalid_grant' })));
    await expect(getValidAccessToken(db.db, connection({ provider: 'xero', accessTokenExpiresAt: new Date(Date.now() + 60_000) }))).rejects.toThrow(ReauthRequiredError);
    expect(mocks.markStatus).toHaveBeenCalledWith(expect.anything(), expect.any(String), expect.any(String), 'reauth_required', 'Xero refresh token is invalid or expired');
  });

  it('QuickBooks messages are byte-identical', async () => {
    const db = makeLockableDb(lockedRow({ refreshTokenExpiresAt: new Date(Date.now() - 1) }));
    await expect(getValidAccessToken(db.db, connection({ refreshTokenExpiresAt: new Date(Date.now() - 1) }))).rejects.toThrow(ReauthRequiredError);
    expect(mocks.markStatus).toHaveBeenCalledWith(expect.anything(), expect.any(String), expect.any(String), 'reauth_required', 'QuickBooks refresh token expired');
  });
});
```

(`makeLockableDb` returns `{ db, state }` in the current file; if its return shape differs, adapt the two property reads. The assertions are the contract.)

Append to `accountingConnectionService.test.ts` (use its `refreshRealmSettings` harness):

```ts
it('refreshRealmSettings labels its errors with the provider (QuickBooks byte-identical)', async () => {
  getConnectionMock.mockResolvedValueOnce(null);
  await expect(refreshRealmSettings('p1', 'xero', runner)).rejects.toMatchObject({ message: 'Xero is not connected for this partner' });
  getConnectionMock.mockResolvedValueOnce(null);
  await expect(refreshRealmSettings('p1', 'quickbooks', runner)).rejects.toMatchObject({ message: 'QuickBooks is not connected for this partner' });
});
```

- [ ] **Step 3: Run and confirm they fail**

```bash
cd apps/api && npx vitest run src/services/accounting/xeroHttp.test.ts src/services/accounting/accountingTokens.test.ts src/services/accounting/accountingConnectionService.test.ts
```

Expected: FAIL. `xeroHttp` is missing, and the messages still say "QuickBooks" for a Xero row.

- [ ] **Step 4: Move `parseRetryAfterMs` into `accountingRateLimit.ts`**

Cut the function (W01c put it in `quickbooksProvider.ts`) and paste it into `accountingRateLimit.ts` unchanged, exported. In `quickbooksProvider.ts`, write `import { parseRetryAfterMs } from './accountingRateLimit';` and add `export { parseRetryAfterMs };` so existing test imports keep working.

- [ ] **Step 5: Declare `ProviderTenant` in `types.ts`**

```ts
/** One tenant (organisation) an OAuth grant can reach (Xero W02). */
export interface ProviderTenant {
  tenantId: string;
  /** The provider's id for this user's link to the tenant (Xero: the connection id). */
  connectionRef: string;
  name: string;
  /** Provider tenant type (Xero: 'ORGANISATION', 'PRACTICEMANAGER', …). */
  tenantType: string;
  /** The auth event that FIRST linked this tenant (Xero connection.authEventId). */
  authEventId: string | null;
}
```

- [ ] **Step 6: Implement `xeroHttp.ts`**

```ts
/**
 * Xero HTTP boundary (Xero W02). Everything that speaks Xero's wire format lives
 * here: the OAuth token endpoint, the identity /connections API, tenant-scoped
 * Accounting API reads, and the translation of Xero failures into
 * AccountingProviderError. xeroProvider.ts composes these; the accounting core
 * never imports this module.
 *
 * Token and identity calls run OUTSIDE the rate-limit slot (W01c convention): they
 * are not tenant-scoped and a throttled refresh is retried by accountingTokens.
 * Every tenant-scoped call goes through withProviderCallSlot.
 */
import { runOutsideDbContext } from '../../db';
import { xeroOAuthConfig } from '../../config/env';
import { AccountingProviderError, type AccountingProviderErrorKind } from './accountingProviderError';
import { noteDailyRemaining, parseRetryAfterMs, withProviderCallSlot } from './accountingRateLimit';
import type { ConnectionTokens, ProviderTenant, RateLimitSpec } from './types';

export const XERO_AUTHORIZE_URL = 'https://login.xero.com/identity/connect/authorize';
export const XERO_TOKEN_URL = 'https://identity.xero.com/connect/token';
export const XERO_CONNECTIONS_URL = 'https://api.xero.com/connections';
export const XERO_API_BASE = 'https://api.xero.com/api.xro/2.0';

/**
 * Pinned granular scopes (spec open item 3; Xero moved apps to granular scopes on
 * 2026-03-02). Requested in full at W02 because Xero cannot widen a token's scope
 * without a fresh consent: contacts (W03), invoices + Items (W03/W04), payments
 * (W05), settings.read (Organisation, Currencies, Accounts, TaxRates — W02).
 * offline_access is what makes Xero issue a refresh token at all.
 */
export const XERO_SCOPES: readonly string[] = Object.freeze([
  'offline_access',
  'accounting.contacts',
  'accounting.invoices',
  'accounting.payments',
  'accounting.settings.read',
]);

/** Xero's refresh token lifetime is a sliding 60 days it does NOT return (spec W02 "Tokens"). */
export const XERO_REFRESH_TOKEN_LIFETIME_MS = 60 * 24 * 60 * 60 * 1000;
export const XERO_REQUEST_TIMEOUT_MS = 15_000;
const DEFAULT_RATE_LIMIT_RETRY_MS = 60_000;

export type XeroTokenGrant =
  | { grantType: 'authorization_code'; code: string }
  | { grantType: 'refresh_token'; refreshToken: string };

interface XeroTokenResponse {
  access_token?: string;
  refresh_token?: string;
  expires_in?: number;
  error?: string;
  error_description?: string;
}

interface XeroRawConnection {
  id?: string;
  authEventId?: string | null;
  tenantId?: string;
  tenantType?: string;
  tenantName?: string | null;
}

interface XeroRawError {
  Message?: string;
  Detail?: string;
  Title?: string;
  Elements?: Array<{ ValidationErrors?: Array<{ Message?: string }> }>;
}

function providerError(init: {
  kind: AccountingProviderErrorKind; operation: string; message: string; httpStatus?: number;
  providerCode?: string; providerMessage?: string; retryAfterMs?: number; logBody?: string;
}): AccountingProviderError {
  return new AccountingProviderError({ provider: 'xero', ...init });
}

/** The most specific human message in a Xero error body, or null. Never the whole body. */
export function xeroFaultMessage(text: string): string | null {
  try {
    const body = JSON.parse(text) as XeroRawError;
    const validation = body.Elements
      ?.flatMap((e) => e.ValidationErrors ?? [])
      .map((v) => v.Message)
      .find((m): m is string => typeof m === 'string' && m.length > 0);
    const message = validation ?? body.Message ?? body.Detail ?? body.Title ?? null;
    return typeof message === 'string' ? message.slice(0, 200) : null;
  } catch {
    return null;
  }
}

function apiKindFor(status: number): AccountingProviderErrorKind {
  if (status === 400) return 'validation';
  if (status === 404) return 'not_found';
  if (status === 429) return 'rate_limited';
  return 'transient'; // 401/403 (link removed or scope missing), 5xx, anything else
}

export function xeroApiError(operation: string, status: number, headers: Headers, text: string): AccountingProviderError {
  const kind = apiKindFor(status);
  return providerError({
    kind,
    operation,
    message: `${operation} failed with ${status}`,
    httpStatus: status,
    providerMessage: xeroFaultMessage(text) ?? undefined,
    // X-Rate-Limit-Problem: 'minute' | 'day' | 'appminute' | 'concurrent'.
    providerCode: kind === 'rate_limited' ? headers.get('x-rate-limit-problem') ?? undefined : undefined,
    retryAfterMs: kind === 'rate_limited' ? parseRetryAfterMs(headers.get('retry-after')) ?? DEFAULT_RATE_LIMIT_RETRY_MS : undefined,
    logBody: text.slice(0, 500),
  });
}

export function xeroTokenError(operation: string, status: number, headers: Headers, text: string): AccountingProviderError {
  let parsed: XeroTokenResponse = {};
  try { parsed = JSON.parse(text) as XeroTokenResponse; } catch { /* non-JSON error page */ }
  // Only an explicit invalid_grant is permanent reauth (accountingTokens re-checks
  // for a lost rotation race before acting on it).
  const kind: AccountingProviderErrorKind = parsed.error === 'invalid_grant'
    ? 'reauth'
    : status === 429 ? 'rate_limited'
      : status === 400 ? 'validation'
        : 'transient';
  return providerError({
    kind,
    operation,
    message: `${operation} failed with ${status}`,
    httpStatus: status,
    providerCode: parsed.error,
    providerMessage: parsed.error_description?.slice(0, 200),
    retryAfterMs: kind === 'rate_limited' ? parseRetryAfterMs(headers.get('retry-after')) ?? DEFAULT_RATE_LIMIT_RETRY_MS : undefined,
  });
}

export async function requestXeroTokens(grant: XeroTokenGrant): Promise<ConnectionTokens> {
  const { clientId, clientSecret, redirectUri } = xeroOAuthConfig();
  const operation = grant.grantType === 'authorization_code' ? 'Xero token exchange' : 'Xero token refresh';
  const body = new URLSearchParams();
  if (grant.grantType === 'authorization_code') {
    body.set('grant_type', 'authorization_code');
    body.set('code', grant.code);
    body.set('redirect_uri', redirectUri);
  } else {
    body.set('grant_type', 'refresh_token');
    body.set('refresh_token', grant.refreshToken);
  }

  const response = await runOutsideDbContext(() => fetch(XERO_TOKEN_URL, {
    method: 'POST',
    headers: {
      Authorization: `Basic ${Buffer.from(`${clientId}:${clientSecret}`).toString('base64')}`,
      'Content-Type': 'application/x-www-form-urlencoded',
      Accept: 'application/json',
    },
    body: body.toString(),
    signal: AbortSignal.timeout(XERO_REQUEST_TIMEOUT_MS),
  }));
  const text = await response.text();
  if (!response.ok) throw xeroTokenError(operation, response.status, response.headers, text);

  let parsed: XeroTokenResponse;
  try {
    parsed = JSON.parse(text) as XeroTokenResponse;
  } catch {
    throw providerError({ kind: 'transient', operation, message: `${operation} returned invalid JSON` });
  }
  if (!parsed.access_token || !parsed.refresh_token || !parsed.expires_in) {
    throw providerError({ kind: 'transient', operation, message: `${operation} response was missing required fields` });
  }
  const now = Date.now();
  return {
    // Xero's callback carries no realm: the tenant is chosen after the exchange
    // (spec W02 "OAuth"). The callback never reads this field for Xero.
    realmId: '',
    accessToken: parsed.access_token,
    refreshToken: parsed.refresh_token,
    accessTokenExpiresAt: new Date(now + parsed.expires_in * 1000),
    refreshTokenExpiresAt: new Date(now + XERO_REFRESH_TOKEN_LIFETIME_MS),
  };
}

/**
 * The access token's `authentication_event_id` claim, or null (fail closed —
 * spec open item 4). The token came straight from Xero's token endpoint over
 * TLS, so its payload is read, not verified; nothing here grants access, the
 * value only NARROWS which /connections rows this flow may touch.
 */
export function decodeXeroAuthEventId(accessToken: string): string | null {
  const parts = accessToken.split('.');
  if (parts.length !== 3 || !parts[1]) return null;
  try {
    const claims = JSON.parse(Buffer.from(parts[1], 'base64url').toString('utf8')) as Record<string, unknown>;
    const value = claims.authentication_event_id;
    return typeof value === 'string' && /^[A-Za-z0-9-]{8,64}$/.test(value) ? value : null;
  } catch {
    return null;
  }
}

/**
 * GET /connections. With `authEventId`, only links created by THAT auth event:
 * filtered by Xero (query param) AND here (defence in depth — a Xero that ignored
 * the parameter must still never hand back another Breeze partner's links; spec
 * quorum finding 3). `null` is the reconnect lookup ONLY (refinement item 2).
 */
export async function listXeroConnections(accessToken: string, authEventId: string | null): Promise<ProviderTenant[]> {
  const url = authEventId ? `${XERO_CONNECTIONS_URL}?authEventId=${encodeURIComponent(authEventId)}` : XERO_CONNECTIONS_URL;
  const operation = 'Xero connections list';
  const response = await runOutsideDbContext(() => fetch(url, {
    method: 'GET',
    headers: { Authorization: `Bearer ${accessToken}`, Accept: 'application/json' },
    signal: AbortSignal.timeout(XERO_REQUEST_TIMEOUT_MS),
  }));
  const text = await response.text();
  if (!response.ok) throw xeroApiError(operation, response.status, response.headers, text);
  let rows: XeroRawConnection[];
  try {
    rows = JSON.parse(text) as XeroRawConnection[];
  } catch {
    throw providerError({ kind: 'transient', operation, message: `${operation} returned invalid JSON` });
  }
  if (!Array.isArray(rows)) throw providerError({ kind: 'transient', operation, message: `${operation} returned an unexpected shape` });
  return rows
    .filter((r) => typeof r.id === 'string' && typeof r.tenantId === 'string')
    .filter((r) => authEventId === null || r.authEventId === authEventId)
    .map((r) => ({
      tenantId: r.tenantId as string,
      connectionRef: r.id as string,
      name: r.tenantName || (r.tenantId as string),
      tenantType: r.tenantType ?? '',
      authEventId: r.authEventId ?? null,
    }));
}

/** DELETE /connections/{id}: removes exactly one link. 404 = already gone = success. Never token revocation. */
export async function deleteXeroConnection(accessToken: string, connectionRef: string): Promise<void> {
  const operation = 'Xero connection delete';
  const response = await runOutsideDbContext(() => fetch(`${XERO_CONNECTIONS_URL}/${encodeURIComponent(connectionRef)}`, {
    method: 'DELETE',
    headers: { Authorization: `Bearer ${accessToken}`, Accept: 'application/json' },
    signal: AbortSignal.timeout(XERO_REQUEST_TIMEOUT_MS),
  }));
  if (response.ok || response.status === 404) {
    await response.body?.cancel().catch(() => {});
    return;
  }
  throw xeroApiError(operation, response.status, response.headers, await response.text());
}

export interface XeroCallContext {
  connectionId: string;
  tenantId: string;
  accessToken: string;
  rate: RateLimitSpec;
  timeoutMs?: number;
}

/** A tenant-scoped Accounting API GET through the rate-limit slot. */
export async function xeroApiGet<T>(ctx: XeroCallContext, path: string, operation: string): Promise<T> {
  const response = await withProviderCallSlot('xero', ctx.rate, ctx.connectionId, () => runOutsideDbContext(() => fetch(
    `${XERO_API_BASE}/${path}`,
    {
      method: 'GET',
      headers: {
        Authorization: `Bearer ${ctx.accessToken}`,
        'xero-tenant-id': ctx.tenantId,
        Accept: 'application/json',
      },
      signal: AbortSignal.timeout(ctx.timeoutMs ?? XERO_REQUEST_TIMEOUT_MS),
    },
  )));

  const remaining = Number(response.headers.get('x-daylimit-remaining'));
  if (response.headers.has('x-daylimit-remaining') && Number.isFinite(remaining)) {
    // Best-effort: the local daily counter is the primary budget; this only refines it.
    await noteDailyRemaining('xero', ctx.connectionId, remaining).catch(() => {});
  }

  const text = await response.text();
  if (!response.ok) {
    const err = xeroApiError(operation, response.status, response.headers, text);
    console.error(`[xeroHttp] ${operation} failed`, `status=${response.status}`, `kind=${err.kind}`);
    throw err;
  }
  try {
    return JSON.parse(text) as T;
  } catch {
    throw providerError({ kind: 'transient', operation, message: `${operation} returned invalid JSON` });
  }
}
```

- [ ] **Step 7: Label the token and settings-refresh messages by provider**

`accountingTokens.ts`: import `accountingProviderDisplayName` from `./providerRegistry`. Replace each hard-coded string:

```ts
// both "refresh token expired" markStatus calls:
`${accountingProviderDisplayName(connection.provider)} refresh token expired`
// handleRefreshFailure:
console.error(`[accounting] ${accountingProviderDisplayName(connection.provider)} refresh returned invalid_grant`, { … });
await markStatus(tx, connection.id, connection.partnerId, 'reauth_required',
  `${accountingProviderDisplayName(connection.provider)} refresh token is invalid or expired`);
```

`accountingConnectionService.ts` `refreshRealmSettings`: add `const label = accountingProviderDisplayName(provider);` at the top. Every `'QuickBooks is not connected for this partner'` becomes `` `${label} is not connected for this partner` ``, and every `'QuickBooks needs to be reconnected'` becomes `` `${label} needs to be reconnected` ``.

- [ ] **Step 8: Run and confirm they pass**

```bash
cd apps/api && npx vitest run src/services/accounting && npx tsc --noEmit -p .
```

Expected: PASS. Every pre-existing QuickBooks message assertion is unchanged.

- [ ] **Step 9: Commit**

```bash
git add -A apps/api/src/services/accounting
git commit -m "feat(accounting): Xero HTTP boundary (tokens, /connections, tenant GET, error kinds); provider-labelled token messages (Xero W02)

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 5: `xeroProvider.ts` (connect-only; not registered yet)

**Files:**
- Create: `apps/api/src/services/accounting/xeroProvider.ts`, `xeroProvider.test.ts`
- Modify: `apps/api/src/services/accounting/types.ts` (`ProviderTenantSelection`, `ProviderSettingsOption(s)`, three optional `AccountingProvider` members)
- Test: `types.test.ts` (new pins)

**Interfaces:**
- Consumes: Task 4 (`xeroHttp.ts`), B5–B10, `xeroOAuthConfig`, `xeroDailyCallLimit`.
- Produces (`types.ts`):
  ```ts
  export interface ProviderTenantSelection {
    readonly connectableTenantType: string;                                   // Xero: 'ORGANISATION'
    authEventIdOf(accessToken: string): string | null;
    listGrantTenants(accessToken: string, authEventId: string): Promise<ProviderTenant[]>;
    listAllTenants(accessToken: string): Promise<ProviderTenant[]>;          // reconnect lookup ONLY
    removeTenantConnection(accessToken: string, connectionRef: string): Promise<void>;
  }
  export interface ProviderSettingsOption { ref: string; label: string; detail: string | null }
  export interface ProviderSettingsOptions {
    organisation: { name: string | null; isDemoCompany: boolean | null };
    incomeAccounts: ProviderSettingsOption[];
    taxRates: ProviderSettingsOption[];
    bankAccounts: ProviderSettingsOption[];
  }
  // AccountingProvider gains (all OPTIONAL; QuickBooks declares none):
  readonly tenantSelection?: ProviderTenantSelection;
  listSettingsOptions?(conn: AccountingConnection): Promise<ProviderSettingsOptions>;
  /** Best-effort provider-side removal of Breeze's link before the row is deleted. NEVER token revocation. */
  releaseConnection?(conn: AccountingConnection): Promise<void>;
  ```
- Produces (`xeroProvider.ts`): `export const XERO_RATE_LIMIT: RateLimitSpec`, `export class XeroProvider implements AccountingProvider`, `export const xeroProvider`.

- [ ] **Step 1: Write the failing tests**

Append to `types.test.ts`:

```ts
describe('tenant selection and settings options (Xero W02)', () => {
  it('declares the optional tenant-selection seam', () => {
    expectTypeOf<AccountingProvider['tenantSelection']>().toEqualTypeOf<ProviderTenantSelection | undefined>();
    expectTypeOf<Parameters<ProviderTenantSelection['listGrantTenants']>>().toEqualTypeOf<[string, string]>();
    expectTypeOf<ReturnType<ProviderTenantSelection['authEventIdOf']>>().toEqualTypeOf<string | null>();
  });
  it('declares optional settings options and release', () => {
    expectTypeOf<AccountingProvider['listSettingsOptions']>().toEqualTypeOf<((conn: AccountingConnection) => Promise<ProviderSettingsOptions>) | undefined>();
    expectTypeOf<AccountingProvider['releaseConnection']>().toEqualTypeOf<((conn: AccountingConnection) => Promise<void>) | undefined>();
    expectTypeOf<ProviderSettingsOptions['organisation']['isDemoCompany']>().toEqualTypeOf<boolean | null>();
  });
});
```

`xeroProvider.test.ts`:

```ts
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const { slotMock } = vi.hoisted(() => ({
  slotMock: vi.fn((_p: unknown, _s: unknown, _c: unknown, fn: () => unknown) => fn()),
}));
vi.mock('./accountingRateLimit', async (orig) => ({
  ...(await orig<typeof import('./accountingRateLimit')>()),
  withProviderCallSlot: slotMock,
  noteDailyRemaining: vi.fn(async () => {}),
}));

import { xeroProvider, XERO_RATE_LIMIT } from './xeroProvider';
import type { AccountingConnection } from './accountingConnectionService';

function conn(overrides: Partial<AccountingConnection> = {}): AccountingConnection {
  return {
    id: 'c1', partnerId: 'p1', provider: 'xero',
    realmId: 'ten-A', accessToken: 'at', refreshToken: 'rt',
    accessTokenExpiresAt: new Date(Date.now() + 1_800_000), refreshTokenExpiresAt: new Date(Date.now() + 86_400_000),
    environment: 'production', homeCurrency: null, multiCurrencyEnabled: null,
    defaultIncomeAccountRef: null, defaultTaxCodeRef: null,
    defaultExemptTaxCodeRef: null, defaultPaymentAccountRef: null, providerConnectionRef: 'conn-A',
    pushMode: 'auto', status: 'connected', createdAt: null, updatedAt: null, lastError: null,
    realmIdFingerprint: null, pullPayments: true, pushPayments: true, lastReconcileAt: null, cdcCursor: null,
    ...overrides,
  };
}
const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status });

beforeEach(() => {
  process.env.XERO_CLIENT_ID = 'client-abc';
  process.env.XERO_CLIENT_SECRET = 'secret-xyz';
  process.env.XERO_REDIRECT_URI = 'https://breeze.example.com/api/v1/accounting/xero/callback';
  delete process.env.XERO_DAILY_CALL_LIMIT;
});
afterEach(() => { vi.restoreAllMocks(); slotMock.mockClear(); });

describe('xeroProvider identity and limits', () => {
  it('declares only the connect capability', () => {
    expect(xeroProvider.provider).toBe('xero');
    expect(xeroProvider.displayName).toBe('Xero');
    expect(xeroProvider.capabilities).toEqual({ connect: true, mapping: false, customerImport: false, invoicePush: false, paymentPull: false, paymentPush: false });
  });

  it('rate spec: 60/min + 5 concurrent per tenant, 10k/min app-wide, tier-aware daily budget', () => {
    expect(XERO_RATE_LIMIT.perConnection).toEqual({ limit: 60, windowSeconds: 60 });
    expect(XERO_RATE_LIMIT.maxConcurrentPerConnection).toBe(5);
    expect(XERO_RATE_LIMIT.appWide).toEqual({ limit: 10_000, windowSeconds: 60 });
    expect(XERO_RATE_LIMIT.dailyPerConnection!.limit()).toBe(1000);
    process.env.XERO_DAILY_CALL_LIMIT = '5000';
    expect(XERO_RATE_LIMIT.dailyPerConnection!.limit()).toBe(5000); // read at call time
    expect(xeroProvider.limits.rate).toBe(XERO_RATE_LIMIT);
  });

  it('connectEnvironment is always production (no Xero sandbox)', () => {
    expect(xeroProvider.connectEnvironment()).toBe('production');
  });

  it('configError reports a missing OAuth trio, null when configured', () => {
    expect(xeroProvider.configError()).toBeNull();
    delete process.env.XERO_REDIRECT_URI;
    expect(xeroProvider.configError()).toBe('Xero OAuth is not configured on this instance');
  });
});

describe('buildAuthUrl', () => {
  it('targets login.xero.com with the pinned scopes and the state', () => {
    const url = new URL(xeroProvider.buildAuthUrl('signed-state'));
    expect(`${url.origin}${url.pathname}`).toBe('https://login.xero.com/identity/connect/authorize');
    expect(Object.fromEntries(url.searchParams)).toEqual({
      response_type: 'code',
      client_id: 'client-abc',
      redirect_uri: 'https://breeze.example.com/api/v1/accounting/xero/callback',
      scope: 'offline_access accounting.contacts accounting.invoices accounting.payments accounting.settings.read',
      state: 'signed-state',
    });
  });
});

describe('exchangeCode / refresh', () => {
  it('exchangeCode ignores the (absent) realmId and returns realmId ""', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce(json({ access_token: 'at', refresh_token: 'rt', expires_in: 1800 }));
    await expect(xeroProvider.exchangeCode('code', 'ignored')).resolves.toMatchObject({ realmId: '', accessToken: 'at' });
  });
});

describe('fetchRealmSettings', () => {
  it('reads BaseCurrency from Organisation and multi-currency from Currencies (count > 1)', async () => {
    const fetchMock = vi.spyOn(globalThis, 'fetch')
      .mockResolvedValueOnce(json({ Organisations: [{ Name: 'Demo Company (NZ)', BaseCurrency: 'nzd', IsDemoCompany: true }] }))
      .mockResolvedValueOnce(json({ Currencies: [{ Code: 'NZD' }, { Code: 'AUD' }] }));
    await expect(xeroProvider.fetchRealmSettings(conn())).resolves.toEqual({ homeCurrency: 'NZD', multiCurrencyEnabled: true });
    expect(fetchMock.mock.calls.map((c) => c[0])).toEqual([
      'https://api.xero.com/api.xro/2.0/Organisation',
      'https://api.xero.com/api.xro/2.0/Currencies',
    ]);
    expect((fetchMock.mock.calls[0]![1] as RequestInit).headers).toMatchObject({ 'xero-tenant-id': 'ten-A' });
  });

  it('single currency → false; malformed BaseCurrency → null', async () => {
    vi.spyOn(globalThis, 'fetch')
      .mockResolvedValueOnce(json({ Organisations: [{ BaseCurrency: 'dollars' }] }))
      .mockResolvedValueOnce(json({ Currencies: [{ Code: 'USD' }] }));
    await expect(xeroProvider.fetchRealmSettings(conn())).resolves.toEqual({ homeCurrency: null, multiCurrencyEnabled: false });
  });

  it('refuses a connection with no tenant', async () => {
    await expect(xeroProvider.fetchRealmSettings(conn({ realmId: null }))).rejects.toThrow('Xero connection is missing a tenant id');
  });
});

describe('listSettingsOptions', () => {
  it('returns organisation, ACTIVE revenue accounts by code, ACTIVE bank accounts by id, revenue tax rates by TaxType', async () => {
    vi.spyOn(globalThis, 'fetch')
      .mockResolvedValueOnce(json({ Organisations: [{ Name: 'Demo Company (UK)', IsDemoCompany: true }] }))
      .mockResolvedValueOnce(json({ Accounts: [
        { AccountID: 'a-200', Code: '200', Name: 'Sales', Type: 'REVENUE', Status: 'ACTIVE' },
        { AccountID: 'a-201', Code: '201', Name: 'Old sales', Type: 'SALES', Status: 'ARCHIVED' },
        { AccountID: 'a-260', Code: '260', Name: 'Other Revenue', Type: 'SALES', Status: 'ACTIVE' },
        { AccountID: 'a-400', Code: '400', Name: 'Advertising', Type: 'EXPENSE', Status: 'ACTIVE' },
        { AccountID: 'bank-1', Name: 'Business Bank Account', Type: 'BANK', Status: 'ACTIVE', BankAccountNumber: '12-3456' },
        { AccountID: 'rev-nocode', Name: 'No code', Type: 'REVENUE', Status: 'ACTIVE' },
      ] }))
      .mockResolvedValueOnce(json({ TaxRates: [
        { Name: '20% (VAT on Income)', TaxType: 'OUTPUT2', Status: 'ACTIVE', CanApplyToRevenue: true, DisplayTaxRate: 20 },
        { Name: 'No VAT', TaxType: 'NONE', Status: 'ACTIVE', CanApplyToRevenue: true, DisplayTaxRate: 0 },
        { Name: '20% (VAT on Expenses)', TaxType: 'INPUT2', Status: 'ACTIVE', CanApplyToRevenue: false, DisplayTaxRate: 20 },
        { Name: 'Retired', TaxType: 'OLD', Status: 'DELETED', CanApplyToRevenue: true, DisplayTaxRate: 5 },
      ] }));
    await expect(xeroProvider.listSettingsOptions!(conn())).resolves.toEqual({
      organisation: { name: 'Demo Company (UK)', isDemoCompany: true },
      incomeAccounts: [
        { ref: '200', label: '200 · Sales', detail: 'REVENUE' },
        { ref: '260', label: '260 · Other Revenue', detail: 'SALES' },
      ],
      bankAccounts: [{ ref: 'bank-1', label: 'Business Bank Account', detail: '12-3456' }],
      taxRates: [
        { ref: 'OUTPUT2', label: '20% (VAT on Income)', detail: '20%' },
        { ref: 'NONE', label: 'No VAT', detail: '0%' },
      ],
    });
  });
});

describe('tenantSelection', () => {
  it('scopes grant tenants to the auth event and removes a single link', async () => {
    const fetchMock = vi.spyOn(globalThis, 'fetch')
      .mockResolvedValueOnce(json([{ id: 'conn-A', authEventId: 'evt-1', tenantId: 'ten-A', tenantType: 'ORGANISATION', tenantName: 'Alpha' }]))
      .mockResolvedValueOnce(new Response(null, { status: 204 }));
    const ts = xeroProvider.tenantSelection!;
    expect(ts.connectableTenantType).toBe('ORGANISATION');
    await expect(ts.listGrantTenants('at', 'evt-1')).resolves.toHaveLength(1);
    await ts.removeTenantConnection('at', 'conn-A');
    expect(fetchMock.mock.calls[1]![0]).toBe('https://api.xero.com/connections/conn-A');
  });
});

describe('releaseConnection (disconnect)', () => {
  it('DELETEs exactly the stored provider_connection_ref', async () => {
    const fetchMock = vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce(new Response(null, { status: 204 }));
    await xeroProvider.releaseConnection!(conn());
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(fetchMock.mock.calls[0]![0]).toBe('https://api.xero.com/connections/conn-A');
    expect(String(fetchMock.mock.calls[0]![0])).not.toContain('revoke');
  });
  it('does nothing without a stored ref', async () => {
    const fetchMock = vi.spyOn(globalThis, 'fetch');
    await xeroProvider.releaseConnection!(conn({ providerConnectionRef: null }));
    expect(fetchMock).not.toHaveBeenCalled();
  });
});

describe('methods behind later waves', () => {
  it.each([
    ['listRemoteCustomers', () => xeroProvider.listRemoteCustomers(conn())],
    ['listRemoteItems', () => xeroProvider.listRemoteItems(conn())],
    ['listRemoteIncomeAccounts', () => xeroProvider.listRemoteIncomeAccounts(conn())],
    ['upsertCustomer', () => xeroProvider.upsertCustomer(conn(), {} as any, null)],
    ['upsertItem', () => xeroProvider.upsertItem(conn(), {} as any, null)],
    ['pushInvoice', () => xeroProvider.pushInvoice(conn(), {} as any, [])],
    ['voidInvoice', () => xeroProvider.voidInvoice(conn(), {} as any, {} as any)],
    ['createPayment', () => xeroProvider.createPayment(conn(), {} as any)],
    ['deletePayment', () => xeroProvider.deletePayment(conn(), {} as any)],
    ['reconcileChanges', () => xeroProvider.reconcileChanges(conn(), null)],
  ])('%s refuses with capability_unavailable and makes no HTTP call', async (_name, call) => {
    const fetchMock = vi.spyOn(globalThis, 'fetch');
    await expect(call()).rejects.toMatchObject({ kind: 'validation', provider: 'xero', providerCode: 'capability_unavailable' });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('paymentMarker throws until W05; verifyWebhook fails closed until W05', () => {
    expect(() => xeroProvider.paymentMarker.embed(null, 'm')).toThrow(/W05/);
    expect(xeroProvider.verifyWebhook('sig', '{}', 'key')).toBe(false);
  });
});
```

- [ ] **Step 2: Run and confirm they fail**

```bash
cd apps/api && npx vitest run src/services/accounting/types.test.ts src/services/accounting/xeroProvider.test.ts
```

Expected: FAIL. The module and the types are missing.

- [ ] **Step 3: Add the types**

In `types.ts`, after `ProviderTenant` (added in Task 4), add `ProviderTenantSelection`, `ProviderSettingsOption` and `ProviderSettingsOptions` exactly as in **Interfaces**, each with the doc comment from there. Then add the three optional members at the end of `AccountingProvider`:

```ts
  /**
   * Providers whose OAuth grant can reach several tenants and whose callback
   * carries no realm id (Xero W02). Absent = the callback's realmId IS the tenant (QuickBooks).
   */
  readonly tenantSelection?: ProviderTenantSelection;
  /** Pickers for the connection's default refs (Xero W02). Absent = the provider has its own settings UI. */
  listSettingsOptions?(conn: AccountingConnection): Promise<ProviderSettingsOptions>;
  /**
   * Best-effort provider-side removal of Breeze's link before the row is deleted
   * (Xero: DELETE /connections/{provider_connection_ref}). NEVER token
   * revocation — that removes every link the authorising user has to the app,
   * which can include another Breeze partner's connection (spec quorum finding 3).
   */
  releaseConnection?(conn: AccountingConnection): Promise<void>;
```

- [ ] **Step 4: Implement `xeroProvider.ts`**

```ts
/**
 * Xero AccountingProvider (spec Phase E). W02 ships CONNECT only: OAuth,
 * tokens, tenant selection, organisation settings, pickers and targeted
 * disconnect. Every other method refuses with capability_unavailable until its
 * wave flips the capability (W03 mapping/customerImport, W04 invoicePush,
 * W05 paymentPull/paymentPush). The capability gates in routes, producers and
 * workers mean none of them is reachable today; the refusal is the backstop.
 */
import { xeroDailyCallLimit, xeroOAuthConfig } from '../../config/env';
import { AccountingProviderError } from './accountingProviderError';
import {
  decodeXeroAuthEventId, deleteXeroConnection, listXeroConnections, requestXeroTokens, xeroApiGet,
  XERO_AUTHORIZE_URL, XERO_SCOPES, type XeroCallContext,
} from './xeroHttp';
import type { AccountingConnection, AccountingEnvironment } from './accountingConnectionService';
import type {
  AccountingProvider, ChangeSet, ConnectionTokens, InvoicePushResult, InvoiceVoidResult, PaymentDeleteResult,
  ProviderSettingsOption, ProviderSettingsOptions, ProviderTenantSelection, RateLimitSpec, RealmSettings,
  RemoteCustomer, RemoteIncomeAccount, RemoteItem, RemoteRef,
} from './types';

/** Xero-published limits (spec W01 "Rate limiting"): per tenant 60/min + 5 concurrent; app-wide 10k/min; tier-aware day. */
export const XERO_RATE_LIMIT: RateLimitSpec = {
  perConnection: { limit: 60, windowSeconds: 60 },
  maxConcurrentPerConnection: 5,
  appWide: { limit: 10_000, windowSeconds: 60 },
  dailyPerConnection: { limit: () => xeroDailyCallLimit() },
};

/** The callback awaits settings capture inline, so it must fail fast (same rationale as QBO_PREFERENCES_TIMEOUT_MS). */
const XERO_SETTINGS_TIMEOUT_MS = 8_000;

interface XeroOrganisation { Name?: string; BaseCurrency?: string; IsDemoCompany?: boolean }
interface XeroAccount { AccountID?: string; Code?: string; Name?: string; Type?: string; Status?: string; BankAccountNumber?: string }
interface XeroTaxRate { Name?: string; TaxType?: string; Status?: string; CanApplyToRevenue?: boolean; DisplayTaxRate?: number }

function notYet(operation: string, wave: string): never {
  throw new AccountingProviderError({
    kind: 'validation',
    provider: 'xero',
    operation,
    message: `Xero ${operation} is not available yet (ships in ${wave})`,
    providerCode: 'capability_unavailable',
  });
}

function normalizeCurrency(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const code = value.trim().toUpperCase();
  return /^[A-Z]{3}$/.test(code) ? code : null;
}

function callContext(conn: AccountingConnection, timeoutMs?: number): XeroCallContext {
  if (!conn.realmId) throw new Error('Xero connection is missing a tenant id');
  if (!conn.accessToken) throw new Error('Xero connection is missing an access token');
  return { connectionId: conn.id, tenantId: conn.realmId, accessToken: conn.accessToken, rate: XERO_RATE_LIMIT, timeoutMs };
}

export class XeroProvider implements AccountingProvider {
  readonly provider = 'xero' as const;
  readonly displayName = 'Xero';
  readonly capabilities = {
    connect: true, mapping: false, customerImport: false, invoicePush: false, paymentPull: false, paymentPush: false,
  } as const;
  // paymentRefMax is PROVISIONAL: paymentPush is false until W05, which pins it
  // against the Payments API `Reference` field.
  readonly limits = { paymentRefMax: 255, rate: XERO_RATE_LIMIT };
  readonly paymentMarker = {
    embed: (_reference: string | null, _marker: string): string => notYet('payment marker', 'W05'),
    extract: (_text: string | null | undefined): string | null => notYet('payment marker', 'W05'),
  };

  readonly tenantSelection: ProviderTenantSelection = {
    connectableTenantType: 'ORGANISATION',
    authEventIdOf: (accessToken) => decodeXeroAuthEventId(accessToken),
    listGrantTenants: (accessToken, authEventId) => listXeroConnections(accessToken, authEventId),
    listAllTenants: (accessToken) => listXeroConnections(accessToken, null),
    removeTenantConnection: (accessToken, connectionRef) => deleteXeroConnection(accessToken, connectionRef),
  };

  connectEnvironment(): AccountingEnvironment {
    return 'production'; // Xero has no sandbox; testing uses the Demo Company.
  }

  configError(): string | null {
    const { clientId, clientSecret, redirectUri } = xeroOAuthConfig();
    return clientId && clientSecret && redirectUri ? null : 'Xero OAuth is not configured on this instance';
  }

  buildAuthUrl(state: string): string {
    const { clientId, redirectUri } = xeroOAuthConfig();
    const url = new URL(XERO_AUTHORIZE_URL);
    url.searchParams.set('response_type', 'code');
    url.searchParams.set('client_id', clientId);
    url.searchParams.set('redirect_uri', redirectUri);
    url.searchParams.set('scope', XERO_SCOPES.join(' '));
    url.searchParams.set('state', state);
    return url.toString();
  }

  async exchangeCode(code: string, _realmId: string): Promise<ConnectionTokens> {
    return requestXeroTokens({ grantType: 'authorization_code', code });
  }

  async refresh(refreshToken: string): Promise<ConnectionTokens> {
    return requestXeroTokens({ grantType: 'refresh_token', refreshToken });
  }

  // Assumes conn.accessToken is valid (getValidAccessToken first); issues no DB queries.
  async fetchRealmSettings(conn: AccountingConnection): Promise<RealmSettings> {
    const ctx = callContext(conn, XERO_SETTINGS_TIMEOUT_MS);
    const org = await xeroApiGet<{ Organisations?: XeroOrganisation[] }>(ctx, 'Organisation', 'Xero organisation read');
    const currencies = await xeroApiGet<{ Currencies?: Array<{ Code?: string }> }>(ctx, 'Currencies', 'Xero currency list');
    const count = currencies.Currencies?.length;
    return {
      homeCurrency: normalizeCurrency(org.Organisations?.[0]?.BaseCurrency),
      multiCurrencyEnabled: typeof count === 'number' ? count > 1 : null,
    };
  }

  async listSettingsOptions(conn: AccountingConnection): Promise<ProviderSettingsOptions> {
    const ctx = callContext(conn);
    const org = await xeroApiGet<{ Organisations?: XeroOrganisation[] }>(ctx, 'Organisation', 'Xero organisation read');
    const accounts = (await xeroApiGet<{ Accounts?: XeroAccount[] }>(ctx, 'Accounts', 'Xero account list')).Accounts ?? [];
    const taxRates = (await xeroApiGet<{ TaxRates?: XeroTaxRate[] }>(ctx, 'TaxRates', 'Xero tax rate list')).TaxRates ?? [];
    const active = accounts.filter((a) => a.Status === 'ACTIVE');
    const organisation = org.Organisations?.[0];
    return {
      organisation: {
        name: organisation?.Name ?? null,
        isDemoCompany: typeof organisation?.IsDemoCompany === 'boolean' ? organisation.IsDemoCompany : null,
      },
      // Invoice lines reference an AccountCode (W04), so a revenue account without a code is not selectable.
      incomeAccounts: active
        .filter((a) => (a.Type === 'REVENUE' || a.Type === 'SALES') && a.Code)
        .map((a): ProviderSettingsOption => ({ ref: a.Code as string, label: `${a.Code} · ${a.Name ?? ''}`.trim(), detail: a.Type ?? null })),
      // Bank accounts may have no Code; payments accept Account.AccountID (W05).
      bankAccounts: active
        .filter((a) => a.Type === 'BANK' && a.AccountID)
        .map((a): ProviderSettingsOption => ({ ref: a.AccountID as string, label: a.Name ?? (a.AccountID as string), detail: a.BankAccountNumber ?? null })),
      taxRates: taxRates
        .filter((r) => r.Status === 'ACTIVE' && r.CanApplyToRevenue === true && r.TaxType)
        .map((r): ProviderSettingsOption => ({
          ref: r.TaxType as string,
          label: r.Name ?? (r.TaxType as string),
          detail: typeof r.DisplayTaxRate === 'number' ? `${r.DisplayTaxRate}%` : null,
        })),
    };
  }

  async releaseConnection(conn: AccountingConnection): Promise<void> {
    if (!conn.providerConnectionRef || !conn.accessToken) return;
    await deleteXeroConnection(conn.accessToken, conn.providerConnectionRef);
  }

  // --- later waves (capability false; unreachable behind the gates) ---
  async listRemoteCustomers(_conn: AccountingConnection, _query?: string): Promise<RemoteCustomer[]> { return notYet('contact listing', 'W03'); }
  async listRemoteItems(_conn: AccountingConnection, _query?: string): Promise<RemoteItem[]> { return notYet('item listing', 'W03'); }
  async listRemoteIncomeAccounts(_conn: AccountingConnection): Promise<RemoteIncomeAccount[]> { return notYet('income account listing', 'W03'); }
  async upsertCustomer(): Promise<RemoteRef> { return notYet('contact sync', 'W03'); }
  async upsertItem(): Promise<RemoteRef> { return notYet('item sync', 'W03'); }
  async pushInvoice(): Promise<InvoicePushResult> { return notYet('invoice push', 'W04'); }
  async voidInvoice(): Promise<InvoiceVoidResult> { return notYet('invoice void', 'W04'); }
  async createPayment(): Promise<RemoteRef> { return notYet('payment push', 'W05'); }
  async deletePayment(): Promise<PaymentDeleteResult> { return notYet('payment delete', 'W05'); }
  async reconcileChanges(_conn: AccountingConnection, _since: Date | null): Promise<ChangeSet> { return notYet('payment pull', 'W05'); }
  /** Fails closed until W05 ships POST /webhooks/xero (which uses XERO_WEBHOOK_KEY). */
  verifyWebhook(_signatureHeader: string, _rawBody: string, _verifierToken: string): boolean { return false; }
}

export const xeroProvider = new XeroProvider();
```

If tsc rejects a zero-parameter stub against the interface's parameter list, restore the parameters with `_`-prefixed names and the exact types from `AccountingProvider`.

- [ ] **Step 5: Run and confirm they pass**

```bash
cd apps/api && npx vitest run src/services/accounting && npx tsc --noEmit -p .
```

Expected: PASS. The neutral-core guard passes (`xeroProvider.ts` is exempt by the `*Provider.ts` rule, and `xeroHttp.ts` contains no `'quickbooks'`).

- [ ] **Step 6: Commit, then open PR W02a**

```bash
git add -A apps/api/src/services/accounting
git commit -m "feat(accounting): Xero provider (connect-only, unregistered) with settings, pickers, tenant selection, targeted release (Xero W02)

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

Run the full W02a gate (Global Constraints). Push and open the PR titled `feat(accounting): Xero W02a — connection foundation (columns, pending_tenant, env, provider)`, with `Part of #7169`. In the body, state that Xero is **not registered** and list the refinement items 4, 9, 11 and 12.

---

# PR W02b — Connect flow and registration

### Task 6: Tenant-selection store and service

**Files:**
- Create: `apps/api/src/services/accounting/accountingTenantSelectionStore.ts`
- Create: `apps/api/src/services/accounting/accountingTenantSelection.ts`, `accountingTenantSelection.test.ts`
- Modify: `apps/api/src/__tests__/partner-wide-write-coverage.test.ts` (`ALLOWED_WITHOUT_CAPABILITY_CHECK`)

**Interfaces:**
- Consumes: Task 1 (`mapConnection`), Task 2 (`PENDING_TENANT_STATUS`, `AccountingTenantHeldError`, `REALM_FINGERPRINT_UNIQUE_INDEX`), Task 5 (`ProviderTenantSelection`), `DbContextRunner`, `assertNoAmbientDbContext`.
- Produces:
  ```ts
  // accountingTenantSelectionStore.ts (DB only, no HTTP)
  export async function loadPendingTenantRow(dbc: DbExecutor, partnerId: string, provider: AccountingProviderId): Promise<AccountingConnection | null>;
  export async function claimPendingTenant(dbc: DbExecutor, input: {
    connectionId: string; partnerId: string; provider: AccountingProviderId;
    realmId: string; providerConnectionRef: string; resetRealmFacts: boolean;
  }): Promise<AccountingConnection | null>;                         // null = no longer pending; throws AccountingTenantHeldError
  export interface DeletedPendingRow { id: string; accessToken: string | null; refreshToken: string | null; accessTokenExpiresAt: Date | null }
  export async function deletePendingTenantRow(dbc: DbExecutor, input: {
    partnerId: string; provider: AccountingProviderId; connectionId?: string; olderThan?: Date;
  }): Promise<DeletedPendingRow | null>;
  export async function listHeldTenantKeys(dbc: DbExecutor, provider: AccountingProviderId, tenants: readonly ProviderTenant[]):
    Promise<{ heldTenantIds: Set<string>; heldConnectionRefs: Set<string> }>;
  export async function listStalePendingTenantConnections(dbc: DbExecutor, cutoff: Date):
    Promise<Array<{ id: string; partnerId: string; provider: AccountingProviderId }>>;
  // accountingTenantSelection.ts (orchestration)
  export const PENDING_TENANT_TTL_MS = 60 * 60 * 1000;
  export const TENANT_PICK_TOKEN_MARGIN_MS = 60_000;
  export type TenantSelectionErrorCode = 'no_pending_selection' | 'tenant_selection_expired' | 'tenant_not_in_grant' | 'selection_unsupported' | 'auth_event_missing';
  export class AccountingTenantSelectionError extends Error { readonly code: TenantSelectionErrorCode; readonly status: 400 | 404 | 409 }
  export interface PendingGrant { row: AccountingConnection; selection: ProviderTenantSelection; accessToken: string; authEventId: string; tenants: ProviderTenant[] }
  export async function loadPendingGrant(partnerId: string, provider: AccountingProviderId, runInDbContext: DbContextRunner): Promise<PendingGrant>;
  export function connectableTenants(grant: Pick<PendingGrant, 'selection' | 'tenants'>): ProviderTenant[];
  export async function releaseUnchosenTenants(input: {
    provider: AccountingProviderId; accessToken: string; tenants: readonly ProviderTenant[];
    keepConnectionRef: string | null; context: 'callback' | 'select' | 'cancel' | 'reaped';
  }): Promise<{ removed: number; kept: number; failed: number }>;
  export async function discardPendingTenantSelection(input: {
    partnerId: string; provider: AccountingProviderId; connectionId?: string; olderThan?: Date;
    reason: 'cancel' | 'reaped'; runInDbContext: DbContextRunner;
  }): Promise<{ discarded: boolean }>;
  export async function reapStalePendingTenants(now?: Date): Promise<{ stale: number; reaped: number }>;
  ```

- [ ] **Step 1: Write the failing tests**

`accountingTenantSelection.test.ts`:

```ts
import { beforeEach, describe, expect, it, vi } from 'vitest';

const m = vi.hoisted(() => ({
  store: {
    loadPendingTenantRow: vi.fn(),
    deletePendingTenantRow: vi.fn(),
    listHeldTenantKeys: vi.fn(),
    listStalePendingTenantConnections: vi.fn(),
  },
  selection: {
    connectableTenantType: 'ORGANISATION',
    authEventIdOf: vi.fn(),
    listGrantTenants: vi.fn(),
    listAllTenants: vi.fn(),
    removeTenantConnection: vi.fn(),
  },
  refresh: vi.fn(),
  systemCtxCalls: [] as string[],
}));
vi.mock('./accountingTenantSelectionStore', () => m.store);
vi.mock('./providerRegistry', () => ({
  getAccountingProvider: () => ({ provider: 'xero', displayName: 'Xero', tenantSelection: m.selection, refresh: m.refresh }),
  findAccountingProvider: () => ({ provider: 'xero', displayName: 'Xero', tenantSelection: m.selection, refresh: m.refresh }),
}));
vi.mock('../../db', () => ({
  db: {},
  hasDbAccessContext: () => false,
  withSystemDbAccessContext: async (fn: () => unknown, label?: string) => { m.systemCtxCalls.push(label ?? ''); return fn(); },
}));
vi.mock('../sentry', () => ({ captureException: vi.fn() }));

import {
  AccountingTenantSelectionError, discardPendingTenantSelection, loadPendingGrant, reapStalePendingTenants, releaseUnchosenTenants,
} from './accountingTenantSelection';

const runner = async <T>(fn: () => Promise<T>) => fn();
const tenant = (id: string, type = 'ORGANISATION') => ({ tenantId: `ten-${id}`, connectionRef: `conn-${id}`, name: id, tenantType: type, authEventId: 'evt-1' });
const pendingRow = (over: Record<string, unknown> = {}) => ({
  id: 'row-1', partnerId: 'p1', provider: 'xero', status: 'pending_tenant', realmId: null,
  accessToken: 'ORIGINAL-at', refreshToken: 'rt', accessTokenExpiresAt: new Date(Date.now() + 20 * 60_000), ...over,
});

beforeEach(() => {
  vi.clearAllMocks();
  m.systemCtxCalls.length = 0;
  m.store.listHeldTenantKeys.mockResolvedValue({ heldTenantIds: new Set(), heldConnectionRefs: new Set() });
  m.selection.authEventIdOf.mockReturnValue('evt-1');
  m.selection.removeTenantConnection.mockResolvedValue(undefined);
});

describe('releaseUnchosenTenants (spec W02: only same-authEvent links no row holds)', () => {
  it('removes every unchosen link, keeps the chosen one', async () => {
    const out = await releaseUnchosenTenants({ provider: 'xero', accessToken: 'at', tenants: [tenant('A'), tenant('B'), tenant('C')], keepConnectionRef: 'conn-A', context: 'callback' });
    expect(m.selection.removeTenantConnection.mock.calls.map((c) => c[1])).toEqual(['conn-B', 'conn-C']);
    expect(out).toEqual({ removed: 2, kept: 0, failed: 0 });
  });

  it('keeps a tenant another partner holds — Review Focus 2 — and checks in SYSTEM scope', async () => {
    m.store.listHeldTenantKeys.mockResolvedValue({ heldTenantIds: new Set(['ten-B']), heldConnectionRefs: new Set() });
    const out = await releaseUnchosenTenants({ provider: 'xero', accessToken: 'at', tenants: [tenant('A'), tenant('B')], keepConnectionRef: null, context: 'callback' });
    expect(m.selection.removeTenantConnection.mock.calls.map((c) => c[1])).toEqual(['conn-A']);
    expect(out).toEqual({ removed: 1, kept: 1, failed: 0 });
    expect(m.systemCtxCalls).toContain('accountingTenantSelection.heldCheck');
  });

  it('keeps a link whose connection id another row stores', async () => {
    m.store.listHeldTenantKeys.mockResolvedValue({ heldTenantIds: new Set(), heldConnectionRefs: new Set(['conn-A']) });
    await releaseUnchosenTenants({ provider: 'xero', accessToken: 'at', tenants: [tenant('A')], keepConnectionRef: null, context: 'cancel' });
    expect(m.selection.removeTenantConnection).not.toHaveBeenCalled();
  });

  it('removes NOTHING when the held check itself fails (fail closed)', async () => {
    m.store.listHeldTenantKeys.mockRejectedValue(new Error('db down'));
    const out = await releaseUnchosenTenants({ provider: 'xero', accessToken: 'at', tenants: [tenant('A'), tenant('B')], keepConnectionRef: null, context: 'cancel' });
    expect(m.selection.removeTenantConnection).not.toHaveBeenCalled();
    expect(out).toEqual({ removed: 0, kept: 2, failed: 0 });
  });

  it('a failed DELETE is counted and never thrown', async () => {
    m.selection.removeTenantConnection.mockRejectedValueOnce(new Error('503'));
    await expect(releaseUnchosenTenants({ provider: 'xero', accessToken: 'at', tenants: [tenant('A'), tenant('B')], keepConnectionRef: null, context: 'cancel' }))
      .resolves.toEqual({ removed: 1, kept: 0, failed: 1 });
  });
});

describe('loadPendingGrant', () => {
  it('lists this auth event\'s tenants with the ORIGINAL token', async () => {
    m.store.loadPendingTenantRow.mockResolvedValue(pendingRow());
    m.selection.listGrantTenants.mockResolvedValue([tenant('A'), tenant('P', 'PRACTICEMANAGER')]);
    const grant = await loadPendingGrant('p1', 'xero', runner);
    expect(m.selection.authEventIdOf).toHaveBeenCalledWith('ORIGINAL-at');
    expect(m.selection.listGrantTenants).toHaveBeenCalledWith('ORIGINAL-at', 'evt-1');
    expect(grant.tenants).toHaveLength(2);
  });

  it.each([
    ['no pending row', () => m.store.loadPendingTenantRow.mockResolvedValue(null), 'no_pending_selection', 404],
    ['token inside the 60s margin', () => m.store.loadPendingTenantRow.mockResolvedValue(pendingRow({ accessTokenExpiresAt: new Date(Date.now() + 30_000) })), 'tenant_selection_expired', 409],
    ['claim missing', () => { m.store.loadPendingTenantRow.mockResolvedValue(pendingRow()); m.selection.authEventIdOf.mockReturnValue(null); }, 'auth_event_missing', 409],
  ])('%s → %s', async (_label, arrange, code, status) => {
    arrange();
    const err = await loadPendingGrant('p1', 'xero', runner).catch((e) => e);
    expect(err).toBeInstanceOf(AccountingTenantSelectionError);
    expect(err).toMatchObject({ code, status });
    expect(m.selection.listGrantTenants).not.toHaveBeenCalled();
  });
});

describe('discardPendingTenantSelection (cancel + reaper)', () => {
  it('deletes the row FIRST, then removes every same-authEvent link not held', async () => {
    const order: string[] = [];
    m.store.deletePendingTenantRow.mockImplementation(async () => { order.push('delete-row'); return { id: 'row-1', accessToken: 'ORIGINAL-at', refreshToken: 'rt', accessTokenExpiresAt: new Date(Date.now() + 20 * 60_000) }; });
    m.selection.listGrantTenants.mockImplementation(async () => { order.push('list'); return [tenant('A'), tenant('B')]; });
    await expect(discardPendingTenantSelection({ partnerId: 'p1', provider: 'xero', reason: 'cancel', runInDbContext: runner })).resolves.toEqual({ discarded: true });
    expect(order).toEqual(['delete-row', 'list']);
    expect(m.selection.removeTenantConnection).toHaveBeenCalledTimes(2);
  });

  it('refreshes an expired token for cleanup but decodes the auth event from the ORIGINAL token', async () => {
    m.store.deletePendingTenantRow.mockResolvedValue({ id: 'row-1', accessToken: 'ORIGINAL-at', refreshToken: 'rt', accessTokenExpiresAt: new Date(Date.now() - 1) });
    m.refresh.mockResolvedValue({ accessToken: 'FRESH-at' });
    m.selection.listGrantTenants.mockResolvedValue([tenant('A')]);
    await discardPendingTenantSelection({ partnerId: 'p1', provider: 'xero', reason: 'reaped', runInDbContext: runner });
    expect(m.selection.authEventIdOf).toHaveBeenCalledWith('ORIGINAL-at');
    expect(m.selection.listGrantTenants).toHaveBeenCalledWith('FRESH-at', 'evt-1');
  });

  it('nothing to discard → discarded false, no HTTP', async () => {
    m.store.deletePendingTenantRow.mockResolvedValue(null);
    await expect(discardPendingTenantSelection({ partnerId: 'p1', provider: 'xero', reason: 'cancel', runInDbContext: runner })).resolves.toEqual({ discarded: false });
    expect(m.selection.listGrantTenants).not.toHaveBeenCalled();
  });

  it('a remote failure never undoes the discard', async () => {
    m.store.deletePendingTenantRow.mockResolvedValue({ id: 'row-1', accessToken: 'ORIGINAL-at', refreshToken: 'rt', accessTokenExpiresAt: new Date(Date.now() + 20 * 60_000) });
    m.selection.listGrantTenants.mockRejectedValue(new Error('xero down'));
    await expect(discardPendingTenantSelection({ partnerId: 'p1', provider: 'xero', reason: 'cancel', runInDbContext: runner })).resolves.toEqual({ discarded: true });
  });
});

describe('reapStalePendingTenants', () => {
  it('discards every row older than 1 hour, each in its own system context, and survives one failure', async () => {
    const now = new Date('2026-10-01T12:00:00Z');
    m.store.listStalePendingTenantConnections.mockResolvedValue([
      { id: 'r1', partnerId: 'p1', provider: 'xero' }, { id: 'r2', partnerId: 'p2', provider: 'xero' },
    ]);
    m.store.deletePendingTenantRow
      .mockRejectedValueOnce(new Error('boom'))
      .mockResolvedValueOnce({ id: 'r2', accessToken: null, refreshToken: null, accessTokenExpiresAt: null });
    await expect(reapStalePendingTenants(now)).resolves.toEqual({ stale: 2, reaped: 1 });
    expect(m.store.listStalePendingTenantConnections).toHaveBeenCalledWith(expect.anything(), new Date('2026-10-01T11:00:00Z'));
    expect(m.store.deletePendingTenantRow).toHaveBeenLastCalledWith(expect.anything(), expect.objectContaining({ connectionId: 'r2', olderThan: new Date('2026-10-01T11:00:00Z') }));
  });
});
```

- [ ] **Step 2: Run and confirm they fail**

```bash
cd apps/api && npx vitest run src/services/accounting/accountingTenantSelection.test.ts
```

Expected: FAIL (modules missing).

- [ ] **Step 3: Implement the store**

```ts
// apps/api/src/services/accounting/accountingTenantSelectionStore.ts
/**
 * DB half of Xero W02 tenant selection. No HTTP here. Every function takes the
 * executor it is handed: request paths pass the caller's partner-scoped runner,
 * EXCEPT listHeldTenantKeys, which the orchestration always runs in SYSTEM scope
 * (other partners' rows are invisible under partner RLS, and "not visible" must
 * never read as "not held").
 */
import { and, eq, inArray, lt, or } from 'drizzle-orm';
import { accountingConnections } from '../../db/schema';
import { decryptSecret, encryptSecret, hmacFingerprint } from '../secretCrypto';
import { isPgUniqueViolation } from '../../utils/pgErrors';
import {
  AccountingTenantHeldError, mapConnection, PENDING_TENANT_STATUS, REALM_FINGERPRINT_UNIQUE_INDEX,
  type AccountingConnection, type DbExecutor,
} from './accountingConnectionService';
import type { AccountingProviderId, ProviderTenant } from './types';

export async function loadPendingTenantRow(dbc: DbExecutor, partnerId: string, provider: AccountingProviderId): Promise<AccountingConnection | null> {
  const [row] = await dbc.select().from(accountingConnections).where(and(
    eq(accountingConnections.partnerId, partnerId),
    eq(accountingConnections.provider, provider),
    eq(accountingConnections.status, PENDING_TENANT_STATUS),
  )).limit(1);
  return row ? mapConnection(row) : null;
}

/**
 * The picker's commit. A conditional UPDATE (status must still be pending), so a
 * select racing a cancel / the reaper / a second select has exactly one winner;
 * the loser gets null. A tenant another partner holds trips the global
 * (provider, realm_id_fingerprint) unique index → AccountingTenantHeldError, and
 * the row stays pending so the user can pick again (Review Focus 1).
 */
export async function claimPendingTenant(dbc: DbExecutor, input: {
  connectionId: string; partnerId: string; provider: AccountingProviderId;
  realmId: string; providerConnectionRef: string; resetRealmFacts: boolean;
}): Promise<AccountingConnection | null> {
  try {
    const [row] = await dbc.update(accountingConnections).set({
      realmIdEncrypted: encryptSecret(input.realmId),
      realmIdFingerprint: hmacFingerprint(input.realmId),
      providerConnectionRef: input.providerConnectionRef,
      status: 'connected',
      lastError: null,
      // A different tenant than the row last held: its captured facts are the
      // old tenant's and must not survive (same rule as the callback's realm change).
      ...(input.resetRealmFacts ? { homeCurrency: null, multiCurrencyEnabled: null } : {}),
      updatedAt: new Date(),
    }).where(and(
      eq(accountingConnections.id, input.connectionId),
      eq(accountingConnections.partnerId, input.partnerId),
      eq(accountingConnections.status, PENDING_TENANT_STATUS),
    )).returning();
    return row ? mapConnection(row) : null;
  } catch (err) {
    if (isPgUniqueViolation(err, REALM_FINGERPRINT_UNIQUE_INDEX)) throw new AccountingTenantHeldError(input.provider);
    throw err;
  }
}

export interface DeletedPendingRow {
  id: string;
  accessToken: string | null;
  refreshToken: string | null;
  accessTokenExpiresAt: Date | null;
}

function decryptOrNull(value: string | null): string | null {
  if (!value) return null;
  try { return decryptSecret(value); } catch { return null; }
}

/** Deletes the partner's pending row (optionally only if older than `olderThan`) and hands back its tokens for remote cleanup. */
export async function deletePendingTenantRow(dbc: DbExecutor, input: {
  partnerId: string; provider: AccountingProviderId; connectionId?: string; olderThan?: Date;
}): Promise<DeletedPendingRow | null> {
  const conditions = [
    eq(accountingConnections.partnerId, input.partnerId),
    eq(accountingConnections.provider, input.provider),
    eq(accountingConnections.status, PENDING_TENANT_STATUS),
  ];
  if (input.connectionId) conditions.push(eq(accountingConnections.id, input.connectionId));
  if (input.olderThan) conditions.push(lt(accountingConnections.updatedAt, input.olderThan));
  const [row] = await dbc.delete(accountingConnections).where(and(...conditions)).returning({
    id: accountingConnections.id,
    accessTokenEncrypted: accountingConnections.accessTokenEncrypted,
    refreshTokenEncrypted: accountingConnections.refreshTokenEncrypted,
    accessTokenExpiresAt: accountingConnections.accessTokenExpiresAt,
  });
  if (!row) return null;
  return {
    id: row.id,
    accessToken: decryptOrNull(row.accessTokenEncrypted),
    refreshToken: decryptOrNull(row.refreshTokenEncrypted),
    accessTokenExpiresAt: row.accessTokenExpiresAt ?? null,
  };
}

/** Which of these tenants / links ANY accounting_connections row holds. SYSTEM scope only (see file header). */
export async function listHeldTenantKeys(
  dbc: DbExecutor,
  provider: AccountingProviderId,
  tenants: readonly ProviderTenant[],
): Promise<{ heldTenantIds: Set<string>; heldConnectionRefs: Set<string> }> {
  if (tenants.length === 0) return { heldTenantIds: new Set(), heldConnectionRefs: new Set() };
  const fingerprintToTenant = new Map(tenants.map((t) => [hmacFingerprint(t.tenantId), t.tenantId]));
  const refs = tenants.map((t) => t.connectionRef);
  const rows = await dbc.select({
    fingerprint: accountingConnections.realmIdFingerprint,
    ref: accountingConnections.providerConnectionRef,
  }).from(accountingConnections).where(and(
    eq(accountingConnections.provider, provider),
    or(
      inArray(accountingConnections.realmIdFingerprint, [...fingerprintToTenant.keys()]),
      inArray(accountingConnections.providerConnectionRef, refs),
    ),
  ));
  const heldTenantIds = new Set<string>();
  const heldConnectionRefs = new Set<string>();
  for (const r of rows as Array<{ fingerprint: string | null; ref: string | null }>) {
    const tenantId = r.fingerprint ? fingerprintToTenant.get(r.fingerprint) : undefined;
    if (tenantId) heldTenantIds.add(tenantId);
    if (r.ref) heldConnectionRefs.add(r.ref);
  }
  return { heldTenantIds, heldConnectionRefs };
}

export async function listStalePendingTenantConnections(dbc: DbExecutor, cutoff: Date): Promise<Array<{ id: string; partnerId: string; provider: AccountingProviderId }>> {
  const rows = await dbc.select({
    id: accountingConnections.id, partnerId: accountingConnections.partnerId, provider: accountingConnections.provider,
  }).from(accountingConnections).where(and(
    eq(accountingConnections.status, PENDING_TENANT_STATUS),
    lt(accountingConnections.updatedAt, cutoff),
  ));
  return (rows as Array<{ id: string; partnerId: string; provider: string }>)
    .map((r) => ({ id: r.id, partnerId: r.partnerId, provider: r.provider as AccountingProviderId }));
}
```

- [ ] **Step 4: Implement the orchestration**

```ts
// apps/api/src/services/accounting/accountingTenantSelection.ts
/**
 * Xero W02 tenant selection: the picker, cancel, the 1-hour reaper, and the
 * removal of unchosen links. Rules (spec W02 + quorum finding 3):
 *  - Only links from THIS flow's auth event are ever listed (listGrantTenants).
 *  - A link is removed only if no accounting_connections row holds its tenant
 *    or its connection id, checked in SYSTEM scope.
 *  - Never token revocation.
 *  - A pending row is never refreshed: the pick must happen inside the ORIGINAL
 *    access token's life, which is also what lets us decode its auth event.
 * Every entry point makes outbound HTTP, so none may hold a DB context.
 */
import { db, withSystemDbAccessContext } from '../../db';
import { captureException } from '../sentry';
import { assertNoAmbientDbContext, type DbContextRunner } from './dbContextGuard';
import { findAccountingProvider, getAccountingProvider } from './providerRegistry';
import {
  deletePendingTenantRow, listHeldTenantKeys, listStalePendingTenantConnections, loadPendingTenantRow,
} from './accountingTenantSelectionStore';
import type { AccountingConnection } from './accountingConnectionService';
import type { AccountingProviderId, ProviderTenant, ProviderTenantSelection } from './types';

export const PENDING_TENANT_TTL_MS = 60 * 60 * 1000;
export const TENANT_PICK_TOKEN_MARGIN_MS = 60_000;

export type TenantSelectionErrorCode =
  | 'no_pending_selection' | 'tenant_selection_expired' | 'tenant_not_in_grant' | 'selection_unsupported' | 'auth_event_missing';

export class AccountingTenantSelectionError extends Error {
  constructor(readonly code: TenantSelectionErrorCode, readonly status: 400 | 404 | 409, message: string) {
    super(message);
    this.name = 'AccountingTenantSelectionError';
  }
}

export interface PendingGrant {
  row: AccountingConnection;
  selection: ProviderTenantSelection;
  accessToken: string;
  authEventId: string;
  tenants: ProviderTenant[];
}

function selectionFor(provider: AccountingProviderId): ProviderTenantSelection {
  const selection = getAccountingProvider(provider).tenantSelection;
  if (!selection) {
    throw new AccountingTenantSelectionError('selection_unsupported', 409, 'This accounting provider does not use organisation selection');
  }
  return selection;
}

export function connectableTenants(grant: Pick<PendingGrant, 'selection' | 'tenants'>): ProviderTenant[] {
  return grant.tenants.filter((t) => t.tenantType === grant.selection.connectableTenantType);
}

export async function loadPendingGrant(partnerId: string, provider: AccountingProviderId, runInDbContext: DbContextRunner): Promise<PendingGrant> {
  assertNoAmbientDbContext('loadPendingGrant');
  const label = getAccountingProvider(provider).displayName;
  const selection = selectionFor(provider);
  const row = await runInDbContext(() => loadPendingTenantRow(db, partnerId, provider));
  if (!row) throw new AccountingTenantSelectionError('no_pending_selection', 404, `There is no ${label} connection waiting for an organisation`);
  const expiresAt = row.accessTokenExpiresAt?.getTime() ?? 0;
  if (!row.accessToken || expiresAt <= Date.now() + TENANT_PICK_TOKEN_MARGIN_MS) {
    throw new AccountingTenantSelectionError('tenant_selection_expired', 409, `This ${label} sign-in has expired. Cancel and connect again.`);
  }
  const authEventId = selection.authEventIdOf(row.accessToken);
  if (!authEventId) {
    throw new AccountingTenantSelectionError('auth_event_missing', 409, `${label} did not identify this sign-in. Cancel and connect again.`);
  }
  const tenants = await selection.listGrantTenants(row.accessToken, authEventId);
  return { row, selection, accessToken: row.accessToken, authEventId, tenants };
}

export async function releaseUnchosenTenants(input: {
  provider: AccountingProviderId; accessToken: string; tenants: readonly ProviderTenant[];
  keepConnectionRef: string | null; context: 'callback' | 'select' | 'cancel' | 'reaped';
}): Promise<{ removed: number; kept: number; failed: number }> {
  assertNoAmbientDbContext('releaseUnchosenTenants');
  const selection = findAccountingProvider(input.provider)?.tenantSelection;
  const candidates = input.tenants.filter((t) => t.connectionRef !== input.keepConnectionRef);
  if (!selection || candidates.length === 0) return { removed: 0, kept: 0, failed: 0 };

  let held: { heldTenantIds: Set<string>; heldConnectionRefs: Set<string> };
  try {
    held = await withSystemDbAccessContext(
      () => listHeldTenantKeys(db, input.provider, candidates),
      'accountingTenantSelection.heldCheck',
    );
  } catch (err) {
    // Fail CLOSED: without the held check we cannot prove a link is ours to remove.
    captureException(err instanceof Error ? err : new Error(String(err)), undefined, { service: 'accountingTenantSelection' });
    console.warn('[accountingTenantSelection] held check failed; removing no links', { provider: input.provider, context: input.context });
    return { removed: 0, kept: candidates.length, failed: 0 };
  }

  let removed = 0; let kept = 0; let failed = 0;
  for (const t of candidates) {
    if (held.heldTenantIds.has(t.tenantId) || held.heldConnectionRefs.has(t.connectionRef)) { kept++; continue; }
    try {
      await selection.removeTenantConnection(input.accessToken, t.connectionRef);
      removed++;
    } catch (err) {
      failed++;
      console.warn('[accountingTenantSelection] unchosen link removal failed (best-effort)', {
        provider: input.provider, context: input.context, error: err instanceof Error ? err.message : String(err),
      });
    }
  }
  console.info('[accountingTenantSelection] unchosen links released', { provider: input.provider, context: input.context, removed, kept, failed });
  return { removed, kept, failed };
}

export async function discardPendingTenantSelection(input: {
  partnerId: string; provider: AccountingProviderId; connectionId?: string; olderThan?: Date;
  reason: 'cancel' | 'reaped'; runInDbContext: DbContextRunner;
}): Promise<{ discarded: boolean }> {
  assertNoAmbientDbContext('discardPendingTenantSelection');
  // Row FIRST: a select racing this cancel/reap then finds nothing to claim,
  // rather than claiming a tenant whose link we are about to remove.
  const deleted = await input.runInDbContext(() => deletePendingTenantRow(db, {
    partnerId: input.partnerId, provider: input.provider, connectionId: input.connectionId, olderThan: input.olderThan,
  }));
  if (!deleted) return { discarded: false };

  const impl = findAccountingProvider(input.provider);
  const selection = impl?.tenantSelection;
  if (!impl || !selection || !deleted.accessToken) return { discarded: true };
  // The ORIGINAL token: pending rows are never refreshed, so its claim is this flow's.
  const authEventId = selection.authEventIdOf(deleted.accessToken);
  if (!authEventId) return { discarded: true };

  try {
    let accessToken = deleted.accessToken;
    const expiresAt = deleted.accessTokenExpiresAt?.getTime() ?? 0;
    if (expiresAt <= Date.now() + TENANT_PICK_TOKEN_MARGIN_MS) {
      if (!deleted.refreshToken) return { discarded: true };
      // The row is gone; the rotated tokens are used once for cleanup and dropped.
      accessToken = (await impl.refresh(deleted.refreshToken)).accessToken;
    }
    const tenants = await selection.listGrantTenants(accessToken, authEventId);
    await releaseUnchosenTenants({ provider: input.provider, accessToken, tenants, keepConnectionRef: null, context: input.reason });
  } catch (err) {
    console.warn('[accountingTenantSelection] remote cleanup after discard failed (best-effort)', {
      provider: input.provider, reason: input.reason, error: err instanceof Error ? err.message : String(err),
    });
  }
  return { discarded: true };
}

export async function reapStalePendingTenants(now: Date = new Date()): Promise<{ stale: number; reaped: number }> {
  assertNoAmbientDbContext('reapStalePendingTenants');
  const cutoff = new Date(now.getTime() - PENDING_TENANT_TTL_MS);
  const stale = await withSystemDbAccessContext(
    () => listStalePendingTenantConnections(db, cutoff),
    'accountingTenantSelection.reap.list',
  );
  let reaped = 0;
  for (const row of stale) {
    try {
      const result = await discardPendingTenantSelection({
        partnerId: row.partnerId, provider: row.provider, connectionId: row.id, olderThan: cutoff, reason: 'reaped',
        runInDbContext: (fn) => withSystemDbAccessContext(fn, 'accountingTenantSelection.reap'),
      });
      if (result.discarded) reaped++;
    } catch (err) {
      captureException(err instanceof Error ? err : new Error(String(err)), undefined, { service: 'accountingTenantSelection' });
    }
  }
  return { stale: stale.length, reaped };
}
```

- [ ] **Step 5: Register the new writer**

`partner-wide-write-coverage.test.ts` `ALLOWED_WITHOUT_CAPABILITY_CHECK`, next to `accountingConnectionService.ts`:

```ts
  'services/accounting/accountingTenantSelectionStore.ts': 'Xero W02 tenant selection: claims/deletes the partner\'s OWN pending_tenant accounting_connections row. Every caller route passes requireScope(partner,system) + requireAccountingPartnerAuthority (which calls canManagePartnerWidePolicies) + accounting:manage + MFA; the reaper runs in system context. Same recorded exemption as accountingConnectionService.ts',
```

- [ ] **Step 6: Run and confirm they pass**

```bash
cd apps/api && npx vitest run src/services/accounting/accountingTenantSelection.test.ts src/__tests__/partner-wide-write-coverage.test.ts src/services/accounting/neutralCore.guard.test.ts && npx tsc --noEmit -p .
```

Expected: PASS.

- [ ] **Step 7: Commit**

```bash
git add -A apps/api/src/services/accounting apps/api/src/__tests__/partner-wide-write-coverage.test.ts
git commit -m "feat(accounting): tenant-selection store + orchestration (auth-event scoped, held-checked release, discard, reaper) (Xero W02)

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 7: Generalized OAuth callback (`connectFinalize.ts`, `tenantConnect.ts`)

**Files:**
- Create: `apps/api/src/routes/accounting/connectFinalize.ts`, `connectFinalize.test.ts`
- Create: `apps/api/src/routes/accounting/tenantConnect.ts`, `tenantConnect.test.ts`
- Modify: `apps/api/src/routes/accounting/index.ts`: `callbackQuerySchema`, the `/:provider/callback` handler (its persist/realm-change/capture tail moves out)
- Test: `routes/accounting/index.test.ts` (consent-denied and missing-realmId cases; mock wiring for the moved code)

**Interfaces:**
- Consumes: Tasks 2 and 6, D4, D6, `writeRouteAudit`, `captureException`, `captureMessage`.
- Produces:
  ```ts
  // connectFinalize.ts
  export type RouteCtx = Parameters<typeof writeRouteAudit>[0];
  export interface PriorRealm { known: boolean; realmId: string | null }
  export type FinalizeFailure = 'provider_conflict' | 'tenant_held' | 'persist_failed';
  export type FinalizeResult = { ok: true; connection: AccountingConnection } | { ok: false; error: FinalizeFailure };
  export async function readPriorRealm(c: RouteCtx, partnerId: string, provider: AccountingProviderId): Promise<PriorRealm>;
  export function homeCurrencyField(prior: PriorRealm, realmId: string): null | undefined;
  export async function finalizeConnection(c: RouteCtx, input: {
    provider: AccountingProviderId; partnerId: string; realmId: string; prior: PriorRealm;
    persist: () => Promise<AccountingConnection>;
  }): Promise<FinalizeResult>;
  export type ConnectOutcome = { kind: 'connected' } | { kind: 'select_tenant' } | { kind: 'error'; error: string };
  export function connectRedirectPath(provider: AccountingProviderId, outcome: ConnectOutcome): string;
  // tenantConnect.ts
  export type TenantCallbackError = FinalizeFailure | 'auth_event_missing' | 'no_organisation' | 'tenant_lookup_failed';
  export async function completeTenantSelectingCallback(c: RouteCtx, input: {
    provider: AccountingProviderId; tokens: ConnectionTokens; partnerId: string; userId: string | null;
  }): Promise<ConnectOutcome>;
  ```
- Redirect codes (the web maps each one to a message in Task 11): `connected=1`, `select_tenant=1`, `error=` one of `exchange_failed | persist_failed | provider_conflict | tenant_held | auth_event_missing | no_organisation | tenant_lookup_failed | consent_denied`.

- [ ] **Step 1: Write the failing tests**

`connectFinalize.test.ts`:

```ts
import { beforeEach, describe, expect, it, vi } from 'vitest';

const m = vi.hoisted(() => ({
  resetConnectionForRealmChange: vi.fn(async () => ({ mappingsDeleted: 3, owedPaymentDeletes: { count: 0, remoteEntityIds: [] } })),
  updateHomeCurrency: vi.fn(async () => new Date()),
  updateMultiCurrencyEnabled: vi.fn(async () => undefined),
  fetchRealmSettings: vi.fn(async () => ({ homeCurrency: 'NZD', multiCurrencyEnabled: false })),
  writeRouteAudit: vi.fn(),
}));
vi.mock('../../db', () => ({ db: {}, runOutsideDbContext: (fn: () => unknown) => fn(), withSystemDbAccessContext: (fn: () => unknown) => fn() }));
vi.mock('../../services/accounting/accountingConnectionService', async (orig) => ({
  ...(await orig<typeof import('../../services/accounting/accountingConnectionService')>()),
  getConnection: vi.fn(), resetConnectionForRealmChange: m.resetConnectionForRealmChange,
  updateHomeCurrency: m.updateHomeCurrency, updateMultiCurrencyEnabled: m.updateMultiCurrencyEnabled,
}));
vi.mock('../../services/accounting/providerRegistry', () => ({
  getAccountingProvider: () => ({ displayName: 'Xero', fetchRealmSettings: m.fetchRealmSettings }),
}));
vi.mock('../../services/auditEvents', () => ({ writeRouteAudit: m.writeRouteAudit }));
vi.mock('../../services/sentry', () => ({ captureException: vi.fn(), captureMessage: vi.fn() }));

import { connectRedirectPath, finalizeConnection, homeCurrencyField } from './connectFinalize';
import { AccountingProviderConflictError, AccountingTenantHeldError } from '../../services/accounting/accountingConnectionService';

const c = {} as any;
const conn = { id: 'c1', partnerId: 'p1', provider: 'xero', updatedAt: new Date() } as any;
beforeEach(() => vi.clearAllMocks());

describe('connectRedirectPath (QuickBooks strings byte-identical)', () => {
  it.each([
    [{ kind: 'connected' }, '/integrations?accounting=quickbooks&connected=1#accounting'],
    [{ kind: 'error', error: 'exchange_failed' }, '/integrations?accounting=quickbooks&error=exchange_failed#accounting'],
    [{ kind: 'error', error: 'persist_failed' }, '/integrations?accounting=quickbooks&error=persist_failed#accounting'],
  ] as const)('%j', (outcome, path) => { expect(connectRedirectPath('quickbooks', outcome)).toBe(path); });
  it('select_tenant for Xero', () => {
    expect(connectRedirectPath('xero', { kind: 'select_tenant' })).toBe('/integrations?accounting=xero&select_tenant=1#accounting');
  });
});

describe('homeCurrencyField', () => {
  it('keeps (undefined) on a known same-realm reconnect, clears (null) otherwise', () => {
    expect(homeCurrencyField({ known: true, realmId: 't1' }, 't1')).toBeUndefined();
    expect(homeCurrencyField({ known: true, realmId: 't1' }, 't2')).toBeNull();
    expect(homeCurrencyField({ known: false, realmId: null }, 't1')).toBeNull();
  });
});

describe('finalizeConnection', () => {
  it.each([
    [new AccountingProviderConflictError('quickbooks', 'xero'), 'provider_conflict'],
    [new AccountingTenantHeldError('xero'), 'tenant_held'],
    [new Error('db'), 'persist_failed'],
  ])('maps a persist failure %s → %s and does no capture', async (err, code) => {
    await expect(finalizeConnection(c, { provider: 'xero', partnerId: 'p1', realmId: 't1', prior: { known: true, realmId: null }, persist: async () => { throw err; } }))
      .resolves.toEqual({ ok: false, error: code });
    expect(m.fetchRealmSettings).not.toHaveBeenCalled();
  });

  it('a known realm change resets mappings and audits it; then captures settings', async () => {
    const result = await finalizeConnection(c, { provider: 'xero', partnerId: 'p1', realmId: 't2', prior: { known: true, realmId: 't1' }, persist: async () => conn });
    expect(result).toEqual({ ok: true, connection: conn });
    expect(m.resetConnectionForRealmChange).toHaveBeenCalledWith(expect.anything(), 'c1', 'p1');
    expect(m.writeRouteAudit).toHaveBeenCalledWith(c, expect.objectContaining({ action: 'accounting.connection.realm_changed' }));
    expect(m.updateHomeCurrency).toHaveBeenCalledWith(expect.anything(), 'c1', 'p1', expect.objectContaining({ realmId: 't2' }), 'NZD');
  });

  it('a pending→connected first pick (prior realm null) does not reset', async () => {
    await finalizeConnection(c, { provider: 'xero', partnerId: 'p1', realmId: 't1', prior: { known: true, realmId: null }, persist: async () => conn });
    expect(m.resetConnectionForRealmChange).not.toHaveBeenCalled();
  });
});
```

`tenantConnect.test.ts`:

```ts
import { beforeEach, describe, expect, it, vi } from 'vitest';

const m = vi.hoisted(() => ({
  selection: { connectableTenantType: 'ORGANISATION', authEventIdOf: vi.fn(), listGrantTenants: vi.fn(), listAllTenants: vi.fn(), removeTenantConnection: vi.fn() },
  finalizeConnection: vi.fn(),
  readPriorRealm: vi.fn(),
  upsertConnection: vi.fn(),
  releaseUnchosenTenants: vi.fn(async () => ({ removed: 0, kept: 0, failed: 0 })),
}));
vi.mock('../../db', () => ({ db: {}, runOutsideDbContext: (fn: () => unknown) => fn(), withSystemDbAccessContext: (fn: () => unknown) => fn() }));
vi.mock('../../services/accounting/providerRegistry', () => ({
  getAccountingProvider: () => ({ provider: 'xero', displayName: 'Xero', tenantSelection: m.selection, connectEnvironment: () => 'production' }),
}));
vi.mock('./connectFinalize', async (orig) => ({
  ...(await orig<typeof import('./connectFinalize')>()),
  finalizeConnection: m.finalizeConnection, readPriorRealm: m.readPriorRealm,
}));
vi.mock('../../services/accounting/accountingConnectionService', async (orig) => ({
  ...(await orig<typeof import('../../services/accounting/accountingConnectionService')>()),
  upsertConnection: m.upsertConnection,
}));
vi.mock('../../services/accounting/accountingTenantSelection', () => ({ releaseUnchosenTenants: m.releaseUnchosenTenants }));
vi.mock('../../services/sentry', () => ({ captureException: vi.fn() }));

import { completeTenantSelectingCallback } from './tenantConnect';
import { AccountingProviderConflictError } from '../../services/accounting/accountingConnectionService';

const tokens = { realmId: '', accessToken: 'at', refreshToken: 'rt', accessTokenExpiresAt: new Date(Date.now() + 1_800_000), refreshTokenExpiresAt: new Date(Date.now() + 86_400_000) };
const t = (id: string, type = 'ORGANISATION') => ({ tenantId: `ten-${id}`, connectionRef: `conn-${id}`, name: id, tenantType: type, authEventId: 'evt-1' });
const input = { provider: 'xero' as const, tokens, partnerId: 'p1', userId: 'u1' };
const c = {} as any;

beforeEach(() => {
  vi.clearAllMocks();
  m.selection.authEventIdOf.mockReturnValue('evt-1');
  m.readPriorRealm.mockResolvedValue({ known: true, realmId: null });
  m.finalizeConnection.mockImplementation(async (_c: unknown, i: { persist: () => Promise<unknown> }) => ({ ok: true, connection: await i.persist() }));
  m.upsertConnection.mockResolvedValue({ id: 'c1' });
});

describe('completeTenantSelectingCallback', () => {
  it('Review Focus 4: a missing auth-event claim fails closed — no /connections call, no persist, no release', async () => {
    m.selection.authEventIdOf.mockReturnValue(null);
    await expect(completeTenantSelectingCallback(c, input)).resolves.toEqual({ kind: 'error', error: 'auth_event_missing' });
    expect(m.selection.listGrantTenants).not.toHaveBeenCalled();
    expect(m.selection.listAllTenants).not.toHaveBeenCalled();
    expect(m.upsertConnection).not.toHaveBeenCalled();
    expect(m.releaseUnchosenTenants).not.toHaveBeenCalled();
  });

  it('exactly one organisation auto-selects, stores the connection ref, and releases the other links', async () => {
    m.selection.listGrantTenants.mockResolvedValue([t('A'), t('P', 'PRACTICEMANAGER')]);
    await expect(completeTenantSelectingCallback(c, input)).resolves.toEqual({ kind: 'connected' });
    expect(m.upsertConnection).toHaveBeenCalledWith(expect.anything(), 'p1', 'xero', expect.objectContaining({
      realmId: 'ten-A', providerConnectionRef: 'conn-A', status: 'connected', environment: 'production',
    }));
    expect(m.releaseUnchosenTenants).toHaveBeenCalledWith(expect.objectContaining({ keepConnectionRef: 'conn-A', tenants: [t('A'), t('P', 'PRACTICEMANAGER')] }));
    expect(m.selection.listAllTenants).not.toHaveBeenCalled(); // no prior realm → no unfiltered read
  });

  it('several organisations park the row as pending_tenant with no realm and release nothing', async () => {
    m.selection.listGrantTenants.mockResolvedValue([t('A'), t('B')]);
    await expect(completeTenantSelectingCallback(c, input)).resolves.toEqual({ kind: 'select_tenant' });
    const fields = m.upsertConnection.mock.calls[0]![3];
    expect(fields).toMatchObject({ status: 'pending_tenant', providerConnectionRef: null, accessToken: 'at' });
    expect(fields).not.toHaveProperty('realmId');
    expect(m.releaseUnchosenTenants).not.toHaveBeenCalled();
  });

  it('zero organisations → no_organisation, and every link from this flow is released', async () => {
    m.selection.listGrantTenants.mockResolvedValue([t('P', 'PRACTICEMANAGER')]);
    await expect(completeTenantSelectingCallback(c, input)).resolves.toEqual({ kind: 'error', error: 'no_organisation' });
    expect(m.releaseUnchosenTenants).toHaveBeenCalledWith(expect.objectContaining({ keepConnectionRef: null }));
    expect(m.upsertConnection).not.toHaveBeenCalled();
  });

  it('refinement 2: a reconnect keeps the partner\'s OWN tenant even when the filtered list is empty', async () => {
    m.readPriorRealm.mockResolvedValue({ known: true, realmId: 'ten-OWN' });
    m.selection.listGrantTenants.mockResolvedValue([]);
    m.selection.listAllTenants.mockResolvedValue([t('OTHER'), { ...t('OWN'), authEventId: 'evt-OLD' }]);
    await expect(completeTenantSelectingCallback(c, input)).resolves.toEqual({ kind: 'connected' });
    expect(m.upsertConnection).toHaveBeenCalledWith(expect.anything(), 'p1', 'xero', expect.objectContaining({ realmId: 'ten-OWN', providerConnectionRef: 'conn-OWN' }));
    // Only this flow's (empty) links are candidates for removal — never the unfiltered list.
    expect(m.releaseUnchosenTenants).toHaveBeenCalledWith(expect.objectContaining({ tenants: [] }));
  });

  it('Review Focus 1/2: a single-org grant whose tenant another partner holds → tenant_held; nothing kept for it', async () => {
    m.selection.listGrantTenants.mockResolvedValue([t('HELD')]);
    m.finalizeConnection.mockResolvedValue({ ok: false, error: 'tenant_held' });
    await expect(completeTenantSelectingCallback(c, input)).resolves.toEqual({ kind: 'error', error: 'tenant_held' });
    // keep=null: the held check (system scope) is what spares the other partner's tenant.
    expect(m.releaseUnchosenTenants).toHaveBeenCalledWith(expect.objectContaining({ keepConnectionRef: null }));
  });

  it('a pending park that hits another provider\'s row → provider_conflict, links released', async () => {
    m.selection.listGrantTenants.mockResolvedValue([t('A'), t('B')]);
    m.upsertConnection.mockRejectedValue(new AccountingProviderConflictError('quickbooks', 'xero'));
    await expect(completeTenantSelectingCallback(c, input)).resolves.toEqual({ kind: 'error', error: 'provider_conflict' });
    expect(m.releaseUnchosenTenants).toHaveBeenCalledWith(expect.objectContaining({ keepConnectionRef: null }));
  });

  it('a /connections failure → tenant_lookup_failed, nothing persisted', async () => {
    m.selection.listGrantTenants.mockRejectedValue(new Error('503'));
    await expect(completeTenantSelectingCallback(c, input)).resolves.toEqual({ kind: 'error', error: 'tenant_lookup_failed' });
    expect(m.upsertConnection).not.toHaveBeenCalled();
  });
});
```

Append to `routes/accounting/index.test.ts` (use its helpers):

```ts
describe('callback generalisation (Xero W02)', () => {
  it('consent cancelled at the provider redirects cleanly, with no state work', async () => {
    const res = await request('GET', '/accounting/quickbooks/callback?error=access_denied&state=anything');
    expect(res.status).toBe(302);
    expect(res.headers.get('location')).toBe('/integrations?accounting=quickbooks&error=consent_denied#accounting');
  });
  it('QuickBooks still requires realmId (400)', async () => {
    const { state, cookie } = await startConnect('quickbooks');
    const res = await request('GET', `/accounting/quickbooks/callback?code=c&state=${state}`, { cookie });
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({ error: 'Missing realmId' });
  });
  it('a QuickBooks realm held by another partner now redirects with error=tenant_held', async () => {
    upsertConnectionMock.mockRejectedValueOnce(new AccountingTenantHeldErrorClass('quickbooks'));
    const res = await completeCallback('quickbooks');
    expect(res.headers.get('location')).toBe('/integrations?accounting=quickbooks&error=tenant_held#accounting');
  });
});
```

- [ ] **Step 2: Run and confirm they fail**

```bash
cd apps/api && npx vitest run src/routes/accounting/connectFinalize.test.ts src/routes/accounting/tenantConnect.test.ts src/routes/accounting/index.test.ts -t "callback generalisation|finalizeConnection|connectRedirectPath|homeCurrencyField|completeTenantSelectingCallback"
```

Expected: FAIL (modules missing; the callback 400s on `error=` because `code` is required).

- [ ] **Step 3: Implement `connectFinalize.ts`**

The body of `finalizeConnection` below is the callback's current tail (from `let priorRealmId` through the multi-currency block), moved. The only changes: `tokens.realmId` becomes `input.realmId`, `state.partnerId` becomes `input.partnerId`, the upsert becomes `input.persist()`, and the redirects become return values. Keep every original comment when moving.

```ts
/**
 * The provider-neutral tail of an accounting OAuth connect, shared by the
 * callback (QuickBooks, and Xero's single-organisation path) and the Xero tenant
 * picker (POST /:provider/tenants/select): persist, realm-change reset, and the
 * non-fatal home-currency / multi-currency capture. Moved out of
 * routes/accounting/index.ts's callback unchanged (Xero W02); see the original
 * comments below for every rule.
 */
import { db, runOutsideDbContext, withSystemDbAccessContext } from '../../db';
import {
  AccountingProviderConflictError, AccountingTenantHeldError, getConnection, isHomeCurrencyCasAbort,
  resetConnectionForRealmChange, updateHomeCurrency, updateMultiCurrencyEnabled, type AccountingConnection,
} from '../../services/accounting/accountingConnectionService';
import { AccountingTenantSelectionError } from '../../services/accounting/accountingTenantSelection';
import { getAccountingProvider } from '../../services/accounting/providerRegistry';
import type { AccountingProviderId } from '../../services/accounting/types';
import { writeRouteAudit } from '../../services/auditEvents';
import { captureException, captureMessage } from '../../services/sentry';

export type RouteCtx = Parameters<typeof writeRouteAudit>[0];
export interface PriorRealm { known: boolean; realmId: string | null }
export type FinalizeFailure = 'provider_conflict' | 'tenant_held' | 'persist_failed';
export type FinalizeResult = { ok: true; connection: AccountingConnection } | { ok: false; error: FinalizeFailure };
export type ConnectOutcome = { kind: 'connected' } | { kind: 'select_tenant' } | { kind: 'error'; error: string };

function asError(err: unknown): Error { return err instanceof Error ? err : new Error(String(err)); }

export function connectRedirectPath(provider: AccountingProviderId, outcome: ConnectOutcome): string {
  const base = `/integrations?accounting=${provider}`;
  if (outcome.kind === 'connected') return `${base}&connected=1#accounting`;
  if (outcome.kind === 'select_tenant') return `${base}&select_tenant=1#accounting`;
  return `${base}&error=${outcome.error}#accounting`;
}

/** The pre-connect realm, read so a SAME-realm reconnect keeps its captured currency. A failed read is "unknown" (fail closed). */
export async function readPriorRealm(c: RouteCtx, partnerId: string, provider: AccountingProviderId): Promise<PriorRealm> {
  try {
    const existing = await withSystemDbAccessContext(() => getConnection(db, partnerId, provider));
    return { known: true, realmId: existing?.realmId ?? null };
  } catch (err) {
    captureException(asError(err), c);
    console.warn(`[accounting] ${getAccountingProvider(provider).displayName} pre-reconnect realm read failed; clearing home currency`, { partnerId, provider });
    return { known: false, realmId: null };
  }
}

/** `undefined` (keep) only on a positively known same-realm reconnect; `null` (clear) otherwise. */
export function homeCurrencyField(prior: PriorRealm, realmId: string): null | undefined {
  return prior.known && prior.realmId !== null && prior.realmId === realmId ? undefined : null;
}

export async function finalizeConnection(c: RouteCtx, input: {
  provider: AccountingProviderId; partnerId: string; realmId: string; prior: PriorRealm;
  persist: () => Promise<AccountingConnection>;
}): Promise<FinalizeResult> {
  const { provider, partnerId, realmId, prior } = input;
  const providerClient = getAccountingProvider(provider);
  const label = providerClient.displayName;

  let connection: AccountingConnection;
  try {
    connection = await input.persist();
  } catch (err) {
    if (err instanceof AccountingTenantSelectionError) throw err; // the picker route answers these itself
    if (err instanceof AccountingProviderConflictError) return { ok: false, error: 'provider_conflict' };
    if (err instanceof AccountingTenantHeldError) return { ok: false, error: 'tenant_held' };
    captureException(asError(err), c);
    console.error(`[accounting] ${label} connection persist failed`, { partnerId, provider });
    return { ok: false, error: 'persist_failed' };
  }

  // --- realm change: MOVED from the callback (finding C). Keep its comment block. ---
  const realmChanged = prior.known && prior.realmId !== null && prior.realmId !== realmId;
  if (realmChanged) {
    try {
      const { mappingsDeleted, owedPaymentDeletes } = await withSystemDbAccessContext(
        () => resetConnectionForRealmChange(db, connection.id, partnerId),
      );
      if (owedPaymentDeletes.count > 0) {
        writeRouteAudit(c, {
          orgId: null,
          action: 'accounting.connection.owed_deletes_discarded',
          resourceType: 'accounting_connection',
          resourceId: connection.id,
          result: 'failure',
          details: { provider, reason: 'realm_changed', count: owedPaymentDeletes.count, remoteEntityIds: owedPaymentDeletes.remoteEntityIds },
        });
      }
      console.warn(`[accounting] ${label} realm changed on reconnect; mappings and CDC cursor cleared`, { partnerId, provider, mappingsDeleted });
      writeRouteAudit(c, {
        orgId: null,
        action: 'accounting.connection.realm_changed',
        resourceType: 'accounting_connection',
        resourceId: connection.id,
        details: { provider, mappingsDeleted },
      });
    } catch (err) {
      captureException(asError(err), c);
      console.error(`[accounting] ${label} realm-change cleanup failed`, { partnerId, provider });
    }
  }

  // --- settings capture: MOVED from the callback (multi-currency §11). Keep its comment blocks. ---
  let capturedSettings: { homeCurrency: string | null; multiCurrencyEnabled: boolean | null } | null = null;
  let generation: Date | null = connection.updatedAt;
  try {
    capturedSettings = await runOutsideDbContext(() => providerClient.fetchRealmSettings(connection));
    const { homeCurrency } = capturedSettings;
    if (homeCurrency && generation) {
      generation = await withSystemDbAccessContext(() => updateHomeCurrency(
        db, connection.id, partnerId, { updatedAt: generation as Date, realmId }, homeCurrency,
      ));
    } else if (!homeCurrency) {
      console.warn(`[accounting] ${label} home currency unavailable`, { partnerId, provider });
    } else {
      captureException(new Error('Accounting home currency captured but the persisted connection carried no updatedAt to compare-and-set against'), c);
      console.error(`[accounting] ${label} home currency captured but the persisted row has no updatedAt`, { partnerId, provider });
    }
  } catch (err) {
    if (isHomeCurrencyCasAbort(err)) {
      generation = null;
      captureMessage(`[accounting] ${label} home currency capture lost the compare-and-set`, { eventCode: 'accounting_home_currency_cas_lost' });
      console.warn(`[accounting] ${label} home currency capture lost the compare-and-set`, { partnerId, provider });
    } else {
      captureException(asError(err), c);
      console.warn(`[accounting] ${label} home currency capture failed`, { partnerId, provider });
    }
  }

  if (typeof capturedSettings?.multiCurrencyEnabled === 'boolean' && generation) {
    try {
      await withSystemDbAccessContext(() => updateMultiCurrencyEnabled(
        db, connection.id, partnerId, { updatedAt: generation as Date, realmId }, capturedSettings!.multiCurrencyEnabled as boolean,
      ));
    } catch (err) {
      if (isHomeCurrencyCasAbort(err)) {
        console.warn(`[accounting] ${label} multi-currency flag capture lost the compare-and-set`, { partnerId, provider });
      } else {
        captureException(asError(err), c);
        console.warn(`[accounting] ${label} multi-currency flag capture failed`, { partnerId, provider });
      }
    }
  }

  return { ok: true, connection };
}
```

The `captureMessage` text for QuickBooks must stay byte-identical to what W01d left. If W01d kept a literal `'[accounting] QuickBooks home currency capture lost the compare-and-set'`, the template above renders the same string for `label === 'QuickBooks'`.

- [ ] **Step 4: Implement `tenantConnect.ts`**

```ts
/**
 * OAuth callback branch for providers whose grant can reach several tenants
 * (provider.tenantSelection — Xero W02). Rules:
 *  - The flow's auth event (from the access token) scopes EVERYTHING; missing → fail closed.
 *  - A reconnect keeps the partner's OWN tenant (plan refinement 2): looked up by
 *    the tenant id the partner's row already holds, never chosen from others.
 *  - One connectable tenant → connect; several → pending_tenant + picker; none → error.
 *  - Unchosen links from THIS auth event are released (held-checked, best-effort).
 */
import { db, runOutsideDbContext, withSystemDbAccessContext } from '../../db';
import { AccountingProviderConflictError, upsertConnection } from '../../services/accounting/accountingConnectionService';
import { releaseUnchosenTenants } from '../../services/accounting/accountingTenantSelection';
import { getAccountingProvider } from '../../services/accounting/providerRegistry';
import type { AccountingProviderId, ConnectionTokens, ProviderTenant } from '../../services/accounting/types';
import { captureException } from '../../services/sentry';
import {
  finalizeConnection, homeCurrencyField, readPriorRealm, type ConnectOutcome, type FinalizeFailure, type RouteCtx,
} from './connectFinalize';

export type TenantCallbackError = FinalizeFailure | 'auth_event_missing' | 'no_organisation' | 'tenant_lookup_failed';

export async function completeTenantSelectingCallback(c: RouteCtx, input: {
  provider: AccountingProviderId; tokens: ConnectionTokens; partnerId: string; userId: string | null;
}): Promise<ConnectOutcome> {
  const { provider, tokens, partnerId, userId } = input;
  const providerClient = getAccountingProvider(provider);
  const selection = providerClient.tenantSelection!;
  const label = providerClient.displayName;
  const fail = (error: TenantCallbackError): ConnectOutcome => ({ kind: 'error', error });

  const authEventId = selection.authEventIdOf(tokens.accessToken);
  if (!authEventId) {
    // Spec open item 4: never fall back to an unfiltered /connections diff.
    console.error(`[accounting] ${label} access token carried no auth-event claim; refusing to guess the organisation`, { partnerId, provider });
    return fail('auth_event_missing');
  }

  const prior = await readPriorRealm(c, partnerId, provider);
  let grant: ProviderTenant[];
  let own: ProviderTenant | null = null;
  try {
    grant = await runOutsideDbContext(() => selection.listGrantTenants(tokens.accessToken, authEventId));
    if (prior.realmId) {
      const all = await runOutsideDbContext(() => selection.listAllTenants(tokens.accessToken));
      own = all.find((t) => t.tenantId === prior.realmId && t.tenantType === selection.connectableTenantType) ?? null;
    }
  } catch (err) {
    captureException(err instanceof Error ? err : new Error(String(err)), c);
    console.error(`[accounting] ${label} organisation lookup failed`, { partnerId, provider });
    return fail('tenant_lookup_failed');
  }

  const connectable = grant.filter((t) => t.tenantType === selection.connectableTenantType);
  const chosen = own ?? (connectable.length === 1 ? connectable[0]! : null);
  const tokenFields = {
    accessToken: tokens.accessToken,
    refreshToken: tokens.refreshToken,
    accessTokenExpiresAt: tokens.accessTokenExpiresAt,
    refreshTokenExpiresAt: tokens.refreshTokenExpiresAt,
    environment: providerClient.connectEnvironment(),
    lastError: null,
    connectedBy: userId,
  };

  if (chosen) {
    const result = await finalizeConnection(c, {
      provider, partnerId, realmId: chosen.tenantId, prior,
      persist: () => withSystemDbAccessContext(() => upsertConnection(db, partnerId, provider, {
        ...tokenFields,
        realmId: chosen.tenantId,
        providerConnectionRef: chosen.connectionRef,
        homeCurrency: homeCurrencyField(prior, chosen.tenantId),
        status: 'connected',
      })),
    });
    await releaseUnchosenTenants({
      provider, accessToken: tokens.accessToken, tenants: grant,
      keepConnectionRef: result.ok ? chosen.connectionRef : null, context: 'callback',
    });
    return result.ok ? { kind: 'connected' } : fail(result.error);
  }

  if (connectable.length === 0) {
    await releaseUnchosenTenants({ provider, accessToken: tokens.accessToken, tenants: grant, keepConnectionRef: null, context: 'callback' });
    return fail('no_organisation');
  }

  // Several organisations: park the grant. realmId is deliberately OMITTED so a
  // reconnect keeps the old tenant id for the picker's realm-change detection.
  try {
    await withSystemDbAccessContext(() => upsertConnection(db, partnerId, provider, {
      ...tokenFields,
      providerConnectionRef: null,
      status: 'pending_tenant',
    }));
  } catch (err) {
    await releaseUnchosenTenants({ provider, accessToken: tokens.accessToken, tenants: grant, keepConnectionRef: null, context: 'callback' });
    if (err instanceof AccountingProviderConflictError) return fail('provider_conflict');
    captureException(err instanceof Error ? err : new Error(String(err)), c);
    console.error(`[accounting] ${label} pending connection persist failed`, { partnerId, provider });
    return fail('persist_failed');
  }
  return { kind: 'select_tenant' };
}
```

- [ ] **Step 5: Rewire the callback in `routes/accounting/index.ts`**

```ts
const callbackQuerySchema = z.object({
  code: z.string().min(1).optional(),
  // QuickBooks sends realmId; Xero does not (its tenant is chosen after the exchange).
  realmId: z.string().min(1).optional(),
  state: z.string().min(1).optional(),
  // The provider's own OAuth error (e.g. access_denied when the user cancels consent).
  error: z.string().max(100).optional(),
});
```

The handler body after the W01d gate / state / cookie checks:

```ts
  const { provider } = c.req.valid('param');
  const query = c.req.valid('query');
  // …W01d gate…
  if (query.error) {
    // Consent cancelled or refused at the provider: no grant exists, nothing to verify or clean up.
    deleteCookie(c, ACCOUNTING_STATE_COOKIE, { path: '/' });
    return c.redirect(connectRedirectPath(provider, { kind: 'error', error: 'consent_denied' }));
  }
  if (!query.code || !query.state) return c.json({ error: 'Missing code or state' }, 400);
  // …W01d verifyState(query.state) + provider match + binding-cookie check, unchanged…

  const providerClient = getAccountingProvider(provider);
  if (!providerClient.tenantSelection && !query.realmId) return c.json({ error: 'Missing realmId' }, 400);

  let tokens;
  try {
    tokens = await runOutsideDbContext(() => providerClient.exchangeCode(query.code!, query.realmId ?? ''));
  } catch (err) {
    captureException(err instanceof Error ? err : new Error(String(err)), c);
    console.error(`[accounting] ${providerClient.displayName} code exchange failed`, { partnerId: state.partnerId, provider });
    deleteCookie(c, ACCOUNTING_STATE_COOKIE, { path: '/' });
    return c.redirect(connectRedirectPath(provider, { kind: 'error', error: 'exchange_failed' }));
  }

  if (providerClient.tenantSelection) {
    const outcome = await completeTenantSelectingCallback(c, { provider, tokens, partnerId: state.partnerId, userId: state.userId });
    deleteCookie(c, ACCOUNTING_STATE_COOKIE, { path: '/' });
    return c.redirect(connectRedirectPath(provider, outcome));
  }

  const prior = await readPriorRealm(c, state.partnerId, provider);
  const result = await finalizeConnection(c, {
    provider, partnerId: state.partnerId, realmId: tokens.realmId, prior,
    persist: () => withSystemDbAccessContext(() => upsertConnection(db, state.partnerId, provider, {
      realmId: tokens.realmId,
      accessToken: tokens.accessToken,
      refreshToken: tokens.refreshToken,
      accessTokenExpiresAt: tokens.accessTokenExpiresAt,
      refreshTokenExpiresAt: tokens.refreshTokenExpiresAt,
      environment: providerClient.connectEnvironment(),
      homeCurrency: homeCurrencyField(prior, tokens.realmId),
      status: 'connected',
      lastError: null,
      connectedBy: state.userId,
    })),
  });
  deleteCookie(c, ACCOUNTING_STATE_COOKIE, { path: '/' });
  return c.redirect(connectRedirectPath(provider, result.ok ? { kind: 'connected' } : { kind: 'error', error: result.error }));
```

Delete the moved tail (the prior-realm read through the multi-currency block) and any imports that are now unused. Then check the size:

```bash
wc -l apps/api/src/routes/accounting/index.ts
```

Expected: well below the Task 0 count (about 150 lines moved out).

- [ ] **Step 6: Run and confirm they pass**

```bash
cd apps/api && npx vitest run src/routes/accounting src/services/accounting && npx tsc --noEmit -p .
```

Expected: PASS. Every existing QuickBooks callback assertion (redirect strings, audits, currency capture, realm-change reset) passes unchanged against the moved code.

- [ ] **Step 7: Commit**

```bash
git add -A apps/api/src/routes/accounting
git commit -m "feat(accounting): provider-neutral connect tail + tenant-selecting callback (auth-event scoped, reconnect keeps own tenant, fail closed) (Xero W02)

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 8: Picker, cancel and options routes; disconnect release; settings fields; status shape

**Files:**
- Create: `apps/api/src/routes/accounting/connectionSetupRoutes.ts`, `connectionSetupRoutes.test.ts`
- Create: `apps/api/src/services/accounting/accountingProviderRelease.ts`, `accountingProviderRelease.test.ts`
- Create: `apps/api/src/services/accounting/accountingSettingsOptions.ts`, `accountingSettingsOptions.test.ts`
- Modify: `apps/api/src/routes/accounting/index.ts`: register the setup routes; `POST /:provider/disconnect`; `settingsSchema` + PATCH `/:provider/settings` (`.set` / `.returning`); `GET /:provider` (status shape)
- Modify: `apps/api/src/middleware/selfManagedDbContextRoutes.ts` (+ `.test.ts`)
- Test: `routes/accounting/index.test.ts`

**Interfaces:**
- Consumes: Tasks 5, 6 and 7, D2, `getValidAccessToken`, `resolveConnectionAndToken`, `AccountingMappingError`.
- Produces:
  ```ts
  // connectionSetupRoutes.ts
  export interface ConnectionSetupDeps {
    auth: MiddlewareHandler[];            // [authMiddleware, partnerScopes, requireAccountingPartnerAuthority, requireAccountingManage]
    mfa: MiddlewareHandler;               // requireMfa()
    resolvePartnerId: (auth: AuthContext, requested?: string) => { partnerId: string } | { error: string; status: 400 | 403 };
  }
  export function registerConnectionSetupRoutes(router: Hono, deps: ConnectionSetupDeps): void;
  //   GET  /:provider/tenants            → 200 { data: [{ tenantId, name }], expiresAt }        (connect, manage)
  //   POST /:provider/tenants/select     { tenantId } → 200 { connected: true }                  (connect, manage, MFA)
  //   POST /:provider/tenants/cancel     → 200 { cancelled: true } | 404                          (connect, manage, MFA)
  //   GET  /:provider/settings/options   → 200 { data: ProviderSettingsOptions }                 (connect, manage)
  //   errors: AccountingTenantSelectionError → { error, code } at its status; tenant_held → 409 { error, code: 'accounting_tenant_held' };
  //           rate_limited → 429 { error, code: 'rate_limited', retryAfterMs }
  // accountingProviderRelease.ts
  export async function releaseProviderConnection(conn: AccountingConnection): Promise<'released' | 'skipped' | 'failed'>;
  // accountingSettingsOptions.ts
  export async function listProviderSettingsOptions(input: { partnerId: string; provider: AccountingProviderId }, runInDbContext: DbContextRunner): Promise<ProviderSettingsOptions>;
  // GET /:provider gains, on BOTH branches:
  //   capabilities: AccountingCapabilities; features: { tenantSelection: boolean; settingsOptions: boolean }
  // and on the connected branch: defaultExemptTaxCodeRef, defaultPaymentAccountRef
  // PATCH /:provider/settings accepts + returns defaultExemptTaxCodeRef, defaultPaymentAccountRef (varchar 64, nullable)
  ```

- [ ] **Step 1: Write the failing tests**

`accountingProviderRelease.test.ts`:

```ts
import { beforeEach, describe, expect, it, vi } from 'vitest';
const m = vi.hoisted(() => ({ release: vi.fn(), getValidAccessToken: vi.fn(), capture: vi.fn(), impl: null as any }));
vi.mock('../../db', () => ({ db: {}, hasDbAccessContext: () => false }));
vi.mock('./accountingTokens', () => ({ getValidAccessToken: m.getValidAccessToken }));
vi.mock('./providerRegistry', () => ({ findAccountingProvider: () => m.impl }));
vi.mock('../sentry', () => ({ captureException: m.capture }));
import { releaseProviderConnection } from './accountingProviderRelease';

const conn = (over = {}) => ({ id: 'c1', partnerId: 'p1', provider: 'xero', providerConnectionRef: 'conn-A', accessToken: 'old', ...over }) as any;
beforeEach(() => { vi.clearAllMocks(); m.impl = { releaseConnection: m.release }; m.getValidAccessToken.mockResolvedValue('fresh'); });

describe('releaseProviderConnection', () => {
  it('releases with a live token', async () => {
    await expect(releaseProviderConnection(conn())).resolves.toBe('released');
    expect(m.release).toHaveBeenCalledWith(expect.objectContaining({ accessToken: 'fresh', providerConnectionRef: 'conn-A' }));
  });
  it('skips a provider with no release hook (QuickBooks) or no stored ref', async () => {
    m.impl = { };
    await expect(releaseProviderConnection(conn())).resolves.toBe('skipped');
    m.impl = { releaseConnection: m.release };
    await expect(releaseProviderConnection(conn({ providerConnectionRef: null }))).resolves.toBe('skipped');
    expect(m.getValidAccessToken).not.toHaveBeenCalled();
  });
  it('never throws: a token or HTTP failure is "failed" and reported', async () => {
    m.getValidAccessToken.mockRejectedValueOnce(new Error('reauth'));
    await expect(releaseProviderConnection(conn())).resolves.toBe('failed');
    m.release.mockRejectedValueOnce(new Error('503'));
    await expect(releaseProviderConnection(conn())).resolves.toBe('failed');
    expect(m.capture).toHaveBeenCalledTimes(2);
  });
});
```

`accountingSettingsOptions.test.ts`:

```ts
import { describe, expect, it, vi } from 'vitest';
const m = vi.hoisted(() => ({ resolve: vi.fn(), options: vi.fn(), impl: null as any }));
vi.mock('./accountingMappingService', async (orig) => ({ ...(await orig<typeof import('./accountingMappingService')>()), resolveConnectionAndToken: m.resolve }));
vi.mock('./providerRegistry', () => ({ getAccountingProvider: () => m.impl, accountingProviderDisplayName: () => 'Xero' }));
vi.mock('../sentry', () => ({ captureException: vi.fn() }));
import { listProviderSettingsOptions } from './accountingSettingsOptions';
import { AccountingProviderError } from './accountingProviderError';

const runner = async <T>(fn: () => Promise<T>) => fn();

describe('listProviderSettingsOptions', () => {
  it('returns the provider options with a live connection', async () => {
    m.impl = { listSettingsOptions: m.options };
    m.resolve.mockResolvedValue({ conn: { provider: 'xero' }, liveConn: { provider: 'xero', accessToken: 'at' } });
    m.options.mockResolvedValue({ organisation: { name: 'Demo', isDemoCompany: true }, incomeAccounts: [], taxRates: [], bankAccounts: [] });
    await expect(listProviderSettingsOptions({ partnerId: 'p1', provider: 'xero' }, runner)).resolves.toMatchObject({ organisation: { isDemoCompany: true } });
    expect(m.resolve).toHaveBeenCalledWith('p1', { provider: 'xero' }, runner);
  });
  it('a provider without options is 409 capability_unavailable', async () => {
    m.impl = {};
    await expect(listProviderSettingsOptions({ partnerId: 'p1', provider: 'xero' }, runner)).rejects.toMatchObject({ status: 409, code: 'capability_unavailable' });
  });
  it('rate_limited passes through untouched; anything else is a 502 provider_error', async () => {
    m.impl = { listSettingsOptions: m.options };
    m.resolve.mockResolvedValue({ conn: { provider: 'xero' }, liveConn: {} });
    const limited = new AccountingProviderError({ kind: 'rate_limited', provider: 'xero', operation: 'x', message: 'x', retryAfterMs: 5000 });
    m.options.mockRejectedValueOnce(limited);
    await expect(listProviderSettingsOptions({ partnerId: 'p1', provider: 'xero' }, runner)).rejects.toBe(limited);
    m.options.mockRejectedValueOnce(new Error('boom'));
    await expect(listProviderSettingsOptions({ partnerId: 'p1', provider: 'xero' }, runner)).rejects.toMatchObject({ status: 502, code: 'provider_error' });
  });
});
```

`connectionSetupRoutes.test.ts`:

```ts
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { Hono } from 'hono';

const m = vi.hoisted(() => ({
  gate: vi.fn(() => null),
  loadPendingGrant: vi.fn(),
  discard: vi.fn(),
  release: vi.fn(async () => ({ removed: 1, kept: 0, failed: 0 })),
  finalize: vi.fn(),
  claim: vi.fn(),
  options: vi.fn(),
  audit: vi.fn(),
}));
vi.mock('./providerGate', () => ({ providerGateResponse: m.gate }));
vi.mock('../../middleware/auth', () => ({ withAuthDbAccessContext: (_a: unknown, fn: () => unknown) => fn() }));
vi.mock('../../db', () => ({ db: {} }));
vi.mock('../../services/accounting/accountingTenantSelection', async (orig) => ({
  ...(await orig<typeof import('../../services/accounting/accountingTenantSelection')>()),
  loadPendingGrant: m.loadPendingGrant, discardPendingTenantSelection: m.discard, releaseUnchosenTenants: m.release,
}));
vi.mock('../../services/accounting/accountingTenantSelectionStore', () => ({ claimPendingTenant: m.claim }));
vi.mock('./connectFinalize', async (orig) => ({ ...(await orig<typeof import('./connectFinalize')>()), finalizeConnection: m.finalize }));
vi.mock('../../services/accounting/accountingSettingsOptions', () => ({ listProviderSettingsOptions: m.options }));
vi.mock('../../services/auditEvents', () => ({ writeRouteAudit: m.audit }));

import { registerConnectionSetupRoutes } from './connectionSetupRoutes';
import { AccountingTenantSelectionError } from '../../services/accounting/accountingTenantSelection';
import { AccountingProviderError } from '../../services/accounting/accountingProviderError';

const pass = async (_c: unknown, next: () => Promise<void>) => next();
function app() {
  const router = new Hono();
  router.use('*', async (c, next) => { c.set('auth' as never, { scope: 'partner', partnerId: 'p1', user: { id: 'u1' } } as never); await next(); });
  registerConnectionSetupRoutes(router, { auth: [pass as any], mfa: pass as any, resolvePartnerId: () => ({ partnerId: 'p1' }) });
  return router;
}
const t = (id: string, type = 'ORGANISATION') => ({ tenantId: `ten-${id}`, connectionRef: `conn-${id}`, name: id, tenantType: type, authEventId: 'evt-1' });
const grant = () => ({
  row: { id: 'row-1', realmId: null }, selection: { connectableTenantType: 'ORGANISATION' },
  accessToken: 'at', authEventId: 'evt-1', tenants: [t('A'), t('B'), t('P', 'PRACTICEMANAGER')],
});
const post = (path: string, body?: unknown) => app().request(path, { method: 'POST', headers: { 'content-type': 'application/json' }, body: body ? JSON.stringify(body) : undefined });

beforeEach(() => { vi.clearAllMocks(); m.gate.mockReturnValue(null); m.loadPendingGrant.mockResolvedValue(grant()); });

describe('GET /:provider/tenants', () => {
  it('lists only connectable organisations from this auth event', async () => {
    const res = await app().request('/xero/tenants');
    expect(res.status).toBe(200);
    expect((await res.json()).data).toEqual([{ tenantId: 'ten-A', name: 'A' }, { tenantId: 'ten-B', name: 'B' }]);
  });
  it('maps selection errors to their status and code', async () => {
    m.loadPendingGrant.mockRejectedValueOnce(new AccountingTenantSelectionError('tenant_selection_expired', 409, 'expired'));
    const res = await app().request('/xero/tenants');
    expect(res.status).toBe(409);
    expect(await res.json()).toEqual({ error: 'expired', code: 'tenant_selection_expired' });
  });
  it('the provider gate runs first (unregistered / no connect capability → its response)', async () => {
    m.gate.mockReturnValueOnce(new Response(JSON.stringify({ code: 'capability_unavailable' }), { status: 409 }) as any);
    expect((await app().request('/xero/tenants')).status).toBe(409);
    expect(m.loadPendingGrant).not.toHaveBeenCalled();
  });
});

describe('POST /:provider/tenants/select', () => {
  it('claims the chosen tenant, then releases the rest of THIS auth event\'s links keeping the chosen one', async () => {
    m.finalize.mockImplementation(async (_c: unknown, i: { persist: () => Promise<unknown> }) => ({ ok: true, connection: await i.persist() }));
    m.claim.mockResolvedValue({ id: 'row-1' });
    const res = await post('/xero/tenants/select', { tenantId: 'ten-B' });
    expect(res.status).toBe(200);
    expect(m.claim).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({ connectionId: 'row-1', realmId: 'ten-B', providerConnectionRef: 'conn-B', resetRealmFacts: true }));
    expect(m.release).toHaveBeenCalledWith(expect.objectContaining({ keepConnectionRef: 'conn-B', context: 'select' }));
    expect(m.audit).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({ action: 'accounting.connection.tenant_selected' }));
  });

  it('refuses a tenant outside the grant, and a non-organisation tenant', async () => {
    expect((await post('/xero/tenants/select', { tenantId: 'ten-ELSEWHERE' })).status).toBe(400);
    expect((await post('/xero/tenants/select', { tenantId: 'ten-P' })).status).toBe(400);
    expect(m.finalize).not.toHaveBeenCalled();
  });

  it('Review Focus 1: a tenant another partner holds → 409 accounting_tenant_held, no release, row stays pending', async () => {
    m.finalize.mockResolvedValue({ ok: false, error: 'tenant_held' });
    const res = await post('/xero/tenants/select', { tenantId: 'ten-A' });
    expect(res.status).toBe(409);
    expect(await res.json()).toEqual({ error: 'This Xero organisation is connected to another Breeze account', code: 'accounting_tenant_held' });
    expect(m.release).not.toHaveBeenCalled();
  });

  it('a claim that lost the race (row no longer pending) → 409 no_pending_selection', async () => {
    m.finalize.mockImplementation(async (_c: unknown, i: { persist: () => Promise<unknown> }) => ({ ok: true, connection: await i.persist() }));
    m.claim.mockResolvedValue(null);
    const res = await post('/xero/tenants/select', { tenantId: 'ten-A' });
    expect(res.status).toBe(409);
    expect((await res.json()).code).toBe('no_pending_selection');
  });
});

describe('POST /:provider/tenants/cancel', () => {
  it('discards the pending selection', async () => {
    m.discard.mockResolvedValue({ discarded: true });
    const res = await post('/xero/tenants/cancel');
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ cancelled: true });
    expect(m.discard).toHaveBeenCalledWith(expect.objectContaining({ partnerId: 'p1', provider: 'xero', reason: 'cancel' }));
  });
  it('404 when nothing is pending', async () => {
    m.discard.mockResolvedValue({ discarded: false });
    expect((await post('/xero/tenants/cancel')).status).toBe(404);
  });
});

describe('GET /:provider/settings/options', () => {
  it('returns options; rate_limited becomes 429 with retryAfterMs', async () => {
    m.options.mockResolvedValueOnce({ organisation: { name: 'Demo', isDemoCompany: true }, incomeAccounts: [], taxRates: [], bankAccounts: [] });
    expect((await app().request('/xero/settings/options')).status).toBe(200);
    m.options.mockRejectedValueOnce(new AccountingProviderError({ kind: 'rate_limited', provider: 'xero', operation: 'x', message: 'x', retryAfterMs: 9000 }));
    const res = await app().request('/xero/settings/options');
    expect(res.status).toBe(429);
    expect(await res.json()).toMatchObject({ code: 'rate_limited', retryAfterMs: 9000 });
  });
});
```

Append to `routes/accounting/index.test.ts` (use its helpers and mocks):

```ts
describe('disconnect, settings and status (Xero W02)', () => {
  it('disconnect releases the provider link BEFORE deleting, and never blocks on a release failure', async () => {
    getPartnerConnectionRefMock.mockResolvedValue({ id: 'c1', provider: 'xero', status: 'connected' });
    getConnectionMock.mockResolvedValue(xeroConnectionFixture({ providerConnectionRef: 'conn-A' }));
    const order: string[] = [];
    releaseProviderConnectionMock.mockImplementation(async () => { order.push('release'); return 'failed'; });
    deleteConnectionMock.mockImplementation(async () => { order.push('delete'); return { removed: true, connectionId: 'c1', owedPaymentDeletes: { count: 0, remoteEntityIds: [] } }; });
    const res = await request('POST', '/accounting/xero/disconnect');
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ disconnected: true });
    expect(order).toEqual(['release', 'delete']);
  });

  it('disconnect of a pending_tenant row is a cancel (no release, no plain delete)', async () => {
    getPartnerConnectionRefMock.mockResolvedValue({ id: 'c1', provider: 'xero', status: 'pending_tenant' });
    discardPendingTenantSelectionMock.mockResolvedValue({ discarded: true });
    const res = await request('POST', '/accounting/xero/disconnect');
    expect(res.status).toBe(200);
    expect(releaseProviderConnectionMock).not.toHaveBeenCalled();
    expect(deleteConnectionMock).not.toHaveBeenCalled();
  });

  it('a token that cannot be decrypted still disconnects (release skipped)', async () => {
    getPartnerConnectionRefMock.mockResolvedValue({ id: 'c1', provider: 'xero', status: 'connected' });
    getConnectionMock.mockRejectedValue(new Error('decrypt failed'));
    deleteConnectionMock.mockResolvedValue({ removed: true, connectionId: 'c1', owedPaymentDeletes: { count: 0, remoteEntityIds: [] } });
    expect((await request('POST', '/accounting/xero/disconnect')).status).toBe(200);
    expect(releaseProviderConnectionMock).not.toHaveBeenCalled();
  });

  it('PATCH settings accepts and returns the two new refs', async () => {
    const res = await request('PATCH', '/accounting/xero/settings', { json: { defaultExemptTaxCodeRef: 'NONE', defaultPaymentAccountRef: 'bank-1' } });
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ defaultExemptTaxCodeRef: 'NONE', defaultPaymentAccountRef: 'bank-1' });
  });

  it('GET /:provider exposes capabilities and features on both branches', async () => {
    getConnectionMock.mockResolvedValue(null);
    const body = await (await request('GET', '/accounting/xero')).json();
    expect(body.capabilities).toEqual({ connect: true, mapping: false, customerImport: false, invoicePush: false, paymentPull: false, paymentPush: false });
    expect(body.features).toEqual({ tenantSelection: true, settingsOptions: true });
  });
});
```

(Add `releaseProviderConnectionMock`, `discardPendingTenantSelectionMock` and a `xeroConnectionFixture` helper to the file's existing hoisted mocks. The QuickBooks status-route `toEqual` assertions gain `capabilities` and `features`; these are wiring edits.)

Append to `selfManagedDbContextRoutes.test.ts` `MATCH`:

```ts
    ['GET', '/api/v1/accounting/xero/tenants'],
    ['POST', '/api/v1/accounting/xero/tenants/select'],
    ['POST', '/api/v1/accounting/xero/tenants/cancel'],
    ['GET', '/api/v1/accounting/xero/settings/options'],
    ['POST', '/api/v1/accounting/xero/disconnect'],
    ['POST', '/api/v1/accounting/quickbooks/disconnect'],
```

and to its no-match list (whatever the file calls it): `['PATCH', '/api/v1/accounting/xero/settings']`, `['GET', '/api/v1/accounting/xero']`.

- [ ] **Step 2: Run and confirm they fail**

```bash
cd apps/api && npx vitest run src/services/accounting/accountingProviderRelease.test.ts src/services/accounting/accountingSettingsOptions.test.ts src/routes/accounting/connectionSetupRoutes.test.ts src/routes/accounting/index.test.ts src/middleware/selfManagedDbContextRoutes.test.ts -t "Xero|tenants|releaseProviderConnection|listProviderSettingsOptions|options|isSelfManaged"
```

Expected: FAIL.

- [ ] **Step 3: Implement the two services**

```ts
// apps/api/src/services/accounting/accountingProviderRelease.ts
/**
 * Best-effort provider-side release on disconnect (spec W02 "Disconnect"):
 * Xero → DELETE /connections/{provider_connection_ref}. Runs BEFORE the row
 * (and its tokens) is deleted, and never blocks the disconnect. Never token
 * revocation (quorum finding 3).
 */
import { db } from '../../db';
import { captureException } from '../sentry';
import { assertNoAmbientDbContext } from './dbContextGuard';
import { getValidAccessToken } from './accountingTokens';
import { findAccountingProvider } from './providerRegistry';
import type { AccountingConnection } from './accountingConnectionService';

export async function releaseProviderConnection(conn: AccountingConnection): Promise<'released' | 'skipped' | 'failed'> {
  assertNoAmbientDbContext('releaseProviderConnection');
  const impl = findAccountingProvider(conn.provider);
  if (!impl?.releaseConnection || !conn.providerConnectionRef) return 'skipped';
  try {
    const accessToken = await getValidAccessToken(db, conn);
    await impl.releaseConnection({ ...conn, accessToken });
    return 'released';
  } catch (err) {
    captureException(err instanceof Error ? err : new Error(String(err)), undefined, { service: 'accountingProviderRelease' });
    console.warn('[accountingProviderRelease] provider-side release failed; disconnecting anyway', {
      connectionId: conn.id, provider: conn.provider, error: err instanceof Error ? err.message : String(err),
    });
    return 'failed';
  }
}
```

```ts
// apps/api/src/services/accounting/accountingSettingsOptions.ts
/** Pickers for the connection's default refs (Xero W02). Live provider reads; no DB context held across them. */
import { captureException } from '../sentry';
import { isAccountingProviderError } from './accountingProviderError';
import { AccountingMappingError, resolveConnectionAndToken } from './accountingMappingService';
import type { DbContextRunner } from './dbContextGuard';
import { accountingProviderDisplayName, getAccountingProvider } from './providerRegistry';
import type { AccountingProviderId, ProviderSettingsOptions } from './types';

export async function listProviderSettingsOptions(
  input: { partnerId: string; provider: AccountingProviderId },
  runInDbContext: DbContextRunner,
): Promise<ProviderSettingsOptions> {
  const impl = getAccountingProvider(input.provider);
  if (!impl.listSettingsOptions) {
    throw new AccountingMappingError('capability_unavailable', 409, `${accountingProviderDisplayName(input.provider)} has no settings pickers`);
  }
  const { liveConn } = await resolveConnectionAndToken(input.partnerId, { provider: input.provider }, runInDbContext);
  try {
    return await impl.listSettingsOptions(liveConn);
  } catch (err) {
    if (isAccountingProviderError(err) && err.kind === 'rate_limited') throw err;
    captureException(err instanceof Error ? err : new Error(String(err)), undefined, { service: 'accountingSettingsOptions' });
    throw new AccountingMappingError('provider_error', 502, `${accountingProviderDisplayName(input.provider)} returned an error while loading settings options`);
  }
}
```

Before this compiles, add `'capability_unavailable'` to `AccountingMappingErrorCode` and make sure `409` is in `AccountingMappingError`'s status union. It already carries 404/409/502. The route error helpers forward `code` and `status` unchanged, so no route edit is needed.

- [ ] **Step 4: Implement `connectionSetupRoutes.ts`**

```ts
/**
 * Connection-setup routes (Xero W02): the organisation picker, cancel, and the
 * settings pickers. Split out of index.ts (which must not grow). Every route
 * makes a live provider call, so each is registered in
 * SELF_MANAGED_DB_CONTEXT_ROUTES and uses a runInDbContext runner.
 */
import type { Hono, MiddlewareHandler } from 'hono';
import { z } from 'zod';
import { zValidator } from '../../lib/validation';
import { db } from '../../db';
import { withAuthDbAccessContext, type AuthContext } from '../../middleware/auth';
import { ACCOUNTING_PROVIDER_IDS, type AccountingProviderId } from '../../services/accounting/types';
import { AccountingTenantHeldError } from '../../services/accounting/accountingConnectionService';
import {
  AccountingTenantSelectionError, connectableTenants, discardPendingTenantSelection, loadPendingGrant, releaseUnchosenTenants,
} from '../../services/accounting/accountingTenantSelection';
import { claimPendingTenant } from '../../services/accounting/accountingTenantSelectionStore';
import { listProviderSettingsOptions } from '../../services/accounting/accountingSettingsOptions';
import { AccountingMappingError } from '../../services/accounting/accountingMappingService';
import { isAccountingProviderError } from '../../services/accounting/accountingProviderError';
import type { DbContextRunner } from '../../services/accounting/dbContextGuard';
import { writeRouteAudit } from '../../services/auditEvents';
import { providerGateResponse } from './providerGate';
import { finalizeConnection } from './connectFinalize';

export interface ConnectionSetupDeps {
  auth: MiddlewareHandler[];
  mfa: MiddlewareHandler;
  resolvePartnerId: (auth: AuthContext, requested?: string) => { partnerId: string } | { error: string; status: 400 | 403 };
}

const paramSchema = z.object({ provider: z.enum(ACCOUNTING_PROVIDER_IDS) });
const querySchema = z.object({ partnerId: z.string().guid().optional() });
const selectSchema = z.object({ tenantId: z.string().min(1).max(100) });

type Json = (body: unknown, status?: number) => Response;
function handleSetupError(json: Json, err: unknown): Response {
  if (err instanceof AccountingTenantSelectionError) return json({ error: err.message, code: err.code }, err.status);
  if (err instanceof AccountingTenantHeldError) return json({ error: err.message, code: err.code }, 409);
  if (err instanceof AccountingMappingError) return json({ error: err.message, code: err.code }, err.status);
  if (isAccountingProviderError(err) && err.kind === 'rate_limited') {
    return json({ error: 'The accounting provider is rate limiting requests; try again shortly', code: 'rate_limited', retryAfterMs: err.retryAfterMs ?? null }, 429);
  }
  throw err;
}

export function registerConnectionSetupRoutes(router: Hono, deps: ConnectionSetupDeps): void {
  const setup = (c: Parameters<MiddlewareHandler>[0], provider: AccountingProviderId) => {
    const gate = providerGateResponse(c as never, provider, 'connect');
    if (gate) return { gate } as const;
    const auth = c.get('auth') as AuthContext;
    const partner = deps.resolvePartnerId(auth, c.req.query('partnerId'));
    if ('error' in partner) return { gate: c.json({ error: partner.error }, partner.status) } as const;
    const runInDb: DbContextRunner = (fn) => withAuthDbAccessContext(auth, fn);
    return { auth, partnerId: partner.partnerId, runInDb } as const;
  };

  router.get('/:provider/tenants', ...deps.auth, zValidator('param', paramSchema), zValidator('query', querySchema), async (c) => {
    const { provider } = c.req.valid('param');
    const s = setup(c, provider);
    if ('gate' in s) return s.gate;
    try {
      const grant = await loadPendingGrant(s.partnerId, provider, s.runInDb);
      return c.json({
        data: connectableTenants(grant).map((t) => ({ tenantId: t.tenantId, name: t.name })),
        expiresAt: grant.row.accessTokenExpiresAt,
      });
    } catch (err) {
      return handleSetupError(c.json.bind(c) as Json, err);
    }
  });

  router.post('/:provider/tenants/select', ...deps.auth, deps.mfa, zValidator('param', paramSchema), zValidator('query', querySchema), zValidator('json', selectSchema), async (c) => {
    const { provider } = c.req.valid('param');
    const { tenantId } = c.req.valid('json');
    const s = setup(c, provider);
    if ('gate' in s) return s.gate;
    try {
      const grant = await loadPendingGrant(s.partnerId, provider, s.runInDb);
      const chosen = connectableTenants(grant).find((t) => t.tenantId === tenantId);
      if (!chosen) return c.json({ error: 'That organisation was not authorised in this sign-in', code: 'tenant_not_in_grant' }, 400);
      const prior = { known: true, realmId: grant.row.realmId };
      const result = await finalizeConnection(c as never, {
        provider, partnerId: s.partnerId, realmId: chosen.tenantId, prior,
        persist: async () => {
          const row = await s.runInDb(() => claimPendingTenant(db, {
            connectionId: grant.row.id, partnerId: s.partnerId, provider,
            realmId: chosen.tenantId, providerConnectionRef: chosen.connectionRef,
            resetRealmFacts: prior.realmId !== chosen.tenantId,
          }));
          if (!row) throw new AccountingTenantSelectionError('no_pending_selection', 409, 'This connection is no longer waiting for an organisation');
          return row;
        },
      });
      if (!result.ok) {
        if (result.error === 'tenant_held') {
          const held = new AccountingTenantHeldError(provider);
          return c.json({ error: held.message, code: held.code }, 409);
        }
        return c.json({ error: 'Could not connect that organisation', code: result.error }, result.error === 'provider_conflict' ? 409 : 500);
      }
      await releaseUnchosenTenants({ provider, accessToken: grant.accessToken, tenants: grant.tenants, keepConnectionRef: chosen.connectionRef, context: 'select' });
      writeRouteAudit(c as never, {
        orgId: null,
        action: 'accounting.connection.tenant_selected',
        resourceType: 'accounting_connection',
        resourceId: result.connection.id,
        details: { provider },
      });
      return c.json({ connected: true });
    } catch (err) {
      return handleSetupError(c.json.bind(c) as Json, err);
    }
  });

  router.post('/:provider/tenants/cancel', ...deps.auth, deps.mfa, zValidator('param', paramSchema), zValidator('query', querySchema), async (c) => {
    const { provider } = c.req.valid('param');
    const s = setup(c, provider);
    if ('gate' in s) return s.gate;
    const { discarded } = await discardPendingTenantSelection({ partnerId: s.partnerId, provider, reason: 'cancel', runInDbContext: s.runInDb });
    if (!discarded) return c.json({ error: 'There is no connection waiting for an organisation', code: 'no_pending_selection' }, 404);
    writeRouteAudit(c as never, { orgId: null, action: 'accounting.connection.tenant_selection_cancelled', resourceType: 'accounting_connection', resourceId: null, details: { provider } });
    return c.json({ cancelled: true });
  });

  router.get('/:provider/settings/options', ...deps.auth, zValidator('param', paramSchema), zValidator('query', querySchema), async (c) => {
    const { provider } = c.req.valid('param');
    const s = setup(c, provider);
    if ('gate' in s) return s.gate;
    try {
      return c.json({ data: await listProviderSettingsOptions({ partnerId: s.partnerId, provider }, s.runInDb) });
    } catch (err) {
      return handleSetupError(c.json.bind(c) as Json, err);
    }
  });
}
```

If spreading `...deps.auth` hits Hono's variadic type-inference limit (`c.req.valid` becoming `never`), compose `deps.auth` into one middleware with a small `compose()` helper, as `partnerScopedPermission` does in `index.ts`.

- [ ] **Step 5: Wire `index.ts`**

1. Register the setup routes **before** `accountingRoutes.get('/:provider', …)`:

   ```ts
   registerConnectionSetupRoutes(accountingRoutes, {
     auth: [authMiddleware, partnerScopes, requireAccountingPartnerAuthority, requireAccountingManage],
     mfa: requireMfa(),
     resolvePartnerId,
   });
   ```

2. The disconnect handler body becomes:

   ```ts
     const { provider } = c.req.valid('param');
     // …W01d gate unchanged…
     const auth = c.get('auth');
     const partner = resolvePartnerId(auth, c.req.valid('query').partnerId);
     if ('error' in partner) return c.json({ error: partner.error }, partner.status);
     const runInDb: DbContextRunner = (fn) => withAuthDbAccessContext(auth, fn);
     const ref = await runInDb(() => getPartnerConnectionRef(db, partner.partnerId));
     if (!ref || ref.provider !== provider) return c.json({ error: 'Accounting connection not found' }, 404);
     if (ref.status === PENDING_TENANT_STATUS) {
       await discardPendingTenantSelection({ partnerId: partner.partnerId, provider, reason: 'cancel', runInDbContext: runInDb });
       return c.json({ disconnected: true });
     }
     // Best-effort provider-side release BEFORE the row and its tokens are gone
     // (spec W02 "Disconnect"; never token revocation). A row whose tokens cannot
     // be decrypted skips the release but still disconnects.
     let full: AccountingConnection | null = null;
     try { full = await runInDb(() => getConnection(db, partner.partnerId, provider)); } catch { full = null; }
     if (full) {
       const release = await releaseProviderConnection(full);
       console.info(`[accounting] ${getAccountingProvider(provider).displayName} disconnect provider release: ${release}`, { partnerId: partner.partnerId });
     }
     const { removed, connectionId, owedPaymentDeletes } = await runInDb(() => deleteConnection(db, partner.partnerId, provider));
     // …existing 404 + owed-deletes audit + `return c.json({ disconnected: true })` unchanged…
   ```

3. `settingsSchema` gains:

   ```ts
     defaultExemptTaxCodeRef: z.string().max(64).nullable().optional(),
     defaultPaymentAccountRef: z.string().max(64).nullable().optional(),
   ```

   PATCH `.set` gains `...('defaultExemptTaxCodeRef' in body ? { defaultExemptTaxCodeRef: body.defaultExemptTaxCodeRef } : {})` and the same for `defaultPaymentAccountRef`. `.returning` gains both columns.

4. `GET /:provider`: before the `if (!connection)` branch:

   ```ts
     const impl = getAccountingProvider(provider);
     const providerShape = {
       capabilities: impl.capabilities,
       features: { tenantSelection: !!impl.tenantSelection, settingsOptions: typeof impl.listSettingsOptions === 'function' },
     };
   ```

   Spread `...providerShape` into both response objects, and add `defaultExemptTaxCodeRef: connection.defaultExemptTaxCodeRef, defaultPaymentAccountRef: connection.defaultPaymentAccountRef,` to the connected branch.

`selfManagedDbContextRoutes.ts`: after the settings-refresh entry, add:

```ts
  // Xero W02 — organisation picker, cancel and settings pickers call Xero live
  // (identity /connections and the Accounting API), and disconnect makes a
  // best-effort DELETE /connections/{id} before deleting the row. Each takes a
  // runInDbContext runner (same treatment as the mapping routes above).
  { method: 'GET', pattern: /^\/api\/v1\/accounting\/[^/]+\/tenants\/?$/ },
  { method: 'POST', pattern: /^\/api\/v1\/accounting\/[^/]+\/tenants\/select\/?$/ },
  { method: 'POST', pattern: /^\/api\/v1\/accounting\/[^/]+\/tenants\/cancel\/?$/ },
  { method: 'GET', pattern: /^\/api\/v1\/accounting\/[^/]+\/settings\/options\/?$/ },
  { method: 'POST', pattern: /^\/api\/v1\/accounting\/[^/]+\/disconnect\/?$/ },
```

- [ ] **Step 6: Run and confirm they pass**

```bash
cd apps/api && npx vitest run src/routes/accounting src/services/accounting src/middleware/selfManagedDbContextRoutes.test.ts src/__tests__/partner-wide-write-coverage.test.ts && npx tsc --noEmit -p .
wc -l src/routes/accounting/index.ts
```

Expected: PASS, and `index.ts` is at or below the Task 0 count.

- [ ] **Step 7: Commit**

```bash
git add -A apps/api/src
git commit -m "feat(accounting): organisation picker, cancel, settings pickers; disconnect releases the provider link; new settings refs (Xero W02)

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 9: The 1-hour reaper in the reconcile sweep

**Files:**
- Modify: `apps/api/src/jobs/accountingReconcileWorker.ts` (`processReconcileSweep`, pass 3)
- Test: `apps/api/src/jobs/accountingReconcileWorker.test.ts`

**Interfaces:**
- Consumes: `reapStalePendingTenants` (Task 6).
- Produces: `processReconcileSweep` returns `{ …existing…, pendingTenantsReaped: number }`. A reap failure is logged and reported, but it neither fails nor retries the sweep.

- [ ] **Step 1: Write the failing test**

In `accountingReconcileWorker.test.ts`, add `vi.mock('../services/accounting/accountingTenantSelection', () => ({ reapStalePendingTenants: reapMock }))` with `reapMock` hoisted. Then:

```ts
describe('pending_tenant reaper (Xero W02)', () => {
  it('reaps stale pending rows on every sweep and reports the count', async () => {
    reapMock.mockResolvedValueOnce({ stale: 2, reaped: 2 });
    const out = await processReconcileSweep();
    expect(reapMock).toHaveBeenCalledTimes(1);
    expect(out.pendingTenantsReaped).toBe(2);
  });

  it('a reap failure never fails the sweep or blocks the other passes', async () => {
    reapMock.mockRejectedValueOnce(new Error('db down'));
    const out = await processReconcileSweep();
    expect(out.pendingTenantsReaped).toBe(0);
    expect(out).toHaveProperty('enqueued');
  });
});
```

- [ ] **Step 2: Run and confirm it fails**

```bash
cd apps/api && npx vitest run src/jobs/accountingReconcileWorker.test.ts -t "reaper"
```

Expected: FAIL (`pendingTenantsReaped` is undefined).

- [ ] **Step 3: Implement**

In `processReconcileSweep`, after pass 2's enqueue loop and before the summary log:

```ts
    // Pass 3 (Xero W02): reap pending_tenant rows older than 1 hour. They hold the
    // partner's one-connection slot (a half-finished Xero connect blocks a
    // QuickBooks connect), so they must not live forever. Best-effort: a failure
    // here is logged and never fails or retries the sweep — the next tick retries.
    let pendingTenantsReaped = 0;
    try {
      pendingTenantsReaped = (await reapStalePendingTenants()).reaped;
    } catch (err) {
      console.error('[AccountingReconcileWorker] sweep pass 3 (reap pending tenants) failed', err instanceof Error ? err.message : err);
      captureException(err instanceof Error ? err : new Error(String(err)), undefined, {
        service: 'accountingReconcileWorker', accounting_reconcile_phase: 'sweep.reapPendingTenants',
      });
    }
```

Add `` `pendingTenantsReaped=${pendingTenantsReaped}` `` to the summary log line, and `pendingTenantsReaped` to both the return type and the returned object. If `accounting_reconcile_phase` validates its values against an allowlist, add `'sweep.reapPendingTenants'` next to `'sweep.list'`.

- [ ] **Step 4: Run and confirm it passes**

```bash
cd apps/api && npx vitest run src/jobs/accountingReconcileWorker.test.ts && npx tsc --noEmit -p .
```

- [ ] **Step 5: Commit**

```bash
git add apps/api/src/jobs/accountingReconcileWorker.ts apps/api/src/jobs/accountingReconcileWorker.test.ts
git commit -m "feat(accounting): reap pending_tenant rows older than 1 hour in the reconcile sweep (Xero W02)

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 10: Register Xero; real-DB proof of the races

**Files:**
- Modify: `apps/api/src/services/accounting/providerRegistry.ts`, `providerRegistry.test.ts`
- Create: `apps/api/src/__tests__/integration/accountingXeroConnection.integration.test.ts`

**Interfaces:**
- Consumes: everything above.
- Produces: `providers.xero = xeroProvider`. `GET /accounting/providers` lists Xero, with `configured` following `XERO_CLIENT_ID`/`SECRET`/`REDIRECT_URI`.

- [ ] **Step 1: Write the failing tests**

Append to `providerRegistry.test.ts`:

```ts
it('registers Xero with only the connect capability (W02)', () => {
  expect(findAccountingProvider('xero')?.displayName).toBe('Xero');
  expect(providerSupports('xero', 'connect')).toBe(true);
  for (const cap of ['mapping', 'customerImport', 'invoicePush', 'paymentPull', 'paymentPush'] as const) {
    expect(providerSupports('xero', cap)).toBe(false);
  }
  expect(listRegisteredAccountingProviders().map((p) => p.provider).sort()).toEqual(['quickbooks', 'xero']);
});
```

`accountingXeroConnection.integration.test.ts`:

```ts
/**
 * Xero W02 against real Postgres: the races and the held-tenant rules that the
 * mocked suites can only simulate. Review Focus 1, 2 and 3.
 */
import './setup';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { eq } from 'drizzle-orm';
import { db, withDbAccessContext, withSystemDbAccessContext } from '../../db';
import { accountingConnections } from '../../db/schema';
import { createPartner } from './db-utils';
import {
  AccountingTenantHeldError, upsertConnection,
} from '../../services/accounting/accountingConnectionService';
import {
  claimPendingTenant, listHeldTenantKeys, listStalePendingTenantConnections,
} from '../../services/accounting/accountingTenantSelectionStore';
import { reapStalePendingTenants } from '../../services/accounting/accountingTenantSelection';

const RUN = !!process.env.DATABASE_URL;
const tenant = (id: string) => ({ tenantId: id, connectionRef: `conn-${id}`, name: id, tenantType: 'ORGANISATION', authEventId: 'evt' });
afterEach(() => vi.restoreAllMocks());

describe.skipIf(!RUN)('Xero W02 connection races (real DB)', () => {
  it('Review Focus 1: two partners racing for one tenant — exactly one wins, the other is tenant-held', async () => {
    const [a, b] = [await createPartner(), await createPartner()];
    const results = await Promise.allSettled([a, b].map((p) => withSystemDbAccessContext(() => upsertConnection(db, p.id, 'xero', {
      realmId: 'race-tenant-1', providerConnectionRef: `conn-${p.id}`, status: 'connected', environment: 'production',
    }))));
    expect(results.filter((r) => r.status === 'fulfilled')).toHaveLength(1);
    const loser = results.find((r) => r.status === 'rejected') as PromiseRejectedResult;
    expect(loser.reason).toBeInstanceOf(AccountingTenantHeldError);
  });

  it('a picker claim of a tenant another partner holds is refused, and the row STAYS pending', async () => {
    const [holder, picker] = [await createPartner(), await createPartner()];
    await withSystemDbAccessContext(() => upsertConnection(db, holder.id, 'xero', { realmId: 'held-tenant-1', status: 'connected' }));
    const pending = await withSystemDbAccessContext(() => upsertConnection(db, picker.id, 'xero', { accessToken: 'a', refreshToken: 'r', status: 'pending_tenant' }));
    await expect(withSystemDbAccessContext(() => claimPendingTenant(db, {
      connectionId: pending.id, partnerId: picker.id, provider: 'xero', realmId: 'held-tenant-1', providerConnectionRef: 'conn-x', resetRealmFacts: true,
    }))).rejects.toBeInstanceOf(AccountingTenantHeldError);
    const [row] = await withSystemDbAccessContext(() => db.select().from(accountingConnections).where(eq(accountingConnections.id, pending.id)));
    expect(row!.status).toBe('pending_tenant');
  });

  it('two concurrent claims of one pending row — exactly one succeeds, the other gets null', async () => {
    const partner = await createPartner();
    const pending = await withSystemDbAccessContext(() => upsertConnection(db, partner.id, 'xero', { accessToken: 'a', refreshToken: 'r', status: 'pending_tenant' }));
    const claims = await Promise.all(['claim-t-A', 'claim-t-B'].map((t) => withSystemDbAccessContext(() => claimPendingTenant(db, {
      connectionId: pending.id, partnerId: partner.id, provider: 'xero', realmId: t, providerConnectionRef: `conn-${t}`, resetRealmFacts: true,
    }))));
    expect(claims.filter(Boolean)).toHaveLength(1);
  });

  it('Review Focus 2: the held check sees ANOTHER partner\'s row only because it runs in system scope', async () => {
    const [holder, viewer] = [await createPartner(), await createPartner()];
    await withSystemDbAccessContext(() => upsertConnection(db, holder.id, 'xero', { realmId: 'scope-tenant-1', providerConnectionRef: 'conn-scope-1', status: 'connected' }));
    const system = await withSystemDbAccessContext(() => listHeldTenantKeys(db, 'xero', [tenant('scope-tenant-1')]));
    expect(system.heldTenantIds.has('scope-tenant-1')).toBe(true);
    // Control: the same query under the viewer partner's RLS context is blind to it —
    // which is exactly why releaseUnchosenTenants must not run it there.
    const partnerScoped = await withDbAccessContext(
      { scope: 'partner', orgId: null, accessibleOrgIds: [], accessiblePartnerIds: [viewer.id], userId: null, currentPartnerId: viewer.id } as never,
      () => listHeldTenantKeys(db, 'xero', [tenant('scope-tenant-1')]),
    );
    expect(partnerScoped.heldTenantIds.has('scope-tenant-1')).toBe(false);
  });

  it('Review Focus 3: a stale pending row is reaped, and QuickBooks can then connect', async () => {
    const partner = await createPartner();
    const pending = await withSystemDbAccessContext(() => upsertConnection(db, partner.id, 'xero', { accessToken: 'not-a-jwt', refreshToken: 'r', status: 'pending_tenant' }));
    await withSystemDbAccessContext(() => db.update(accountingConnections)
      .set({ updatedAt: new Date(Date.now() - 2 * 60 * 60 * 1000) }).where(eq(accountingConnections.id, pending.id)));
    const fetchSpy = vi.spyOn(globalThis, 'fetch'); // the token has no auth-event claim → no HTTP at all
    const stale = await withSystemDbAccessContext(() => listStalePendingTenantConnections(db, new Date(Date.now() - 60 * 60 * 1000)));
    expect(stale.map((s) => s.id)).toContain(pending.id);
    const out = await reapStalePendingTenants();
    expect(out.reaped).toBeGreaterThanOrEqual(1);
    expect(fetchSpy).not.toHaveBeenCalled();
    const qbo = await withSystemDbAccessContext(() => upsertConnection(db, partner.id, 'quickbooks', { realmId: `qbo-after-reap-${partner.id}` }));
    expect(qbo.provider).toBe('quickbooks');
  });

  it('a FRESH pending row is not reaped', async () => {
    const partner = await createPartner();
    const pending = await withSystemDbAccessContext(() => upsertConnection(db, partner.id, 'xero', { accessToken: 'x', refreshToken: 'r', status: 'pending_tenant' }));
    await reapStalePendingTenants();
    const [row] = await withSystemDbAccessContext(() => db.select().from(accountingConnections).where(eq(accountingConnections.id, pending.id)));
    expect(row?.status).toBe('pending_tenant');
  });
});
```

Build the partner-scoped context argument for `withDbAccessContext` exactly as the existing RLS integration suites do (`grep -rn "withDbAccessContext(" apps/api/src/__tests__/integration | head`). The shape above is illustrative; the assertion is the contract.

- [ ] **Step 2: Run and confirm they fail**

```bash
cd apps/api && npx vitest run src/services/accounting/providerRegistry.test.ts
cd apps/api && npx vitest run -c vitest.integration.config.ts src/__tests__/integration/accountingXeroConnection.integration.test.ts
```

Expected: the registry test FAILS (Xero is not registered). The integration suite may pass on the DB parts; if the reap test fails because `findAccountingProvider('xero')` is null, that is the red.

- [ ] **Step 3: Register**

```ts
import { quickbooksProvider } from './quickbooksProvider';
import { xeroProvider } from './xeroProvider';

const providers: Partial<Record<AccountingProviderId, AccountingProvider>> = {
  quickbooks: quickbooksProvider,
  // Xero W02: connect only. W03–W05 flip capabilities as they land.
  xero: xeroProvider,
};
```

Update the `FALLBACK_DISPLAY_NAMES` comment ("ids with no registered implementation"): the table stays, for any future id.

- [ ] **Step 4: Run the W02b gate**

```bash
cd apps/api && npx vitest run && npx tsc --noEmit -p .
pnpm test-stack up
cd apps/api && npx vitest run -c vitest.integration.config.ts \
  src/__tests__/integration/accountingXeroConnection.integration.test.ts \
  src/__tests__/integration/accountingXeroColumns.integration.test.ts \
  src/__tests__/integration/accountingOneConnectionPerPartner.integration.test.ts \
  src/__tests__/integration/accounting-connections-rls.integration.test.ts \
  src/__tests__/integration/accountingRealmFingerprint.integration.test.ts \
  src/__tests__/integration/accountingConnectionHomeCurrency.integration.test.ts \
  src/__tests__/integration/accountingPartnerAuthority.integration.test.ts \
  src/__tests__/integration/orgAccountReadinessIntegrations.integration.test.ts
cd ../.. && DB_CONTEXTLESS_WRITE_STRICT=true pnpm --filter=@breeze/api test:rls-coverage
pnpm test-stack down
```

Expected: every file passes. If an integration filename no longer exists, re-list with `ls apps/api/src/__tests__/integration | grep -iE 'accounting|orgAccountReadiness'`. Do not skip a file silently.

- [ ] **Step 5: Commit, then open PR W02b**

```bash
git add -A apps/api/src
git commit -m "feat(accounting): register Xero (connect only) + real-DB proof of connect races, held tenants and the reaper (Xero W02)

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

Open the PR titled `feat(accounting): Xero W02b — OAuth connect, organisation picker, targeted disconnect`, with `Part of #7169`. The body lists: refinement items 2, 3, 5 (the QuickBooks `tenant_held` redirect change), 6, 7 and 8; "do not set `XERO_*` in any environment until W02c merges"; and the five Review Focus lines with the tests that pin each one.

---

# PR W02c — Web, docs and lab

### Task 11: Panel capability gating, tenant picker, branded connect/disconnect, OAuth-return messages

**Files:**
- Create: `apps/web/src/components/integrations/AccountingConnectButton.tsx`, `AccountingConnectButton.test.tsx`
- Create: `apps/web/src/components/integrations/AccountingTenantPicker.tsx`, `AccountingTenantPicker.test.tsx`
- Modify: `apps/web/src/lib/accountingProviders.ts` (`ACCOUNTING_PROVIDER_UI`)
- Modify: `apps/web/src/components/integrations/AccountingConnectionPanel.tsx` (+ `.test.tsx`)
- Modify: `apps/web/src/lib/__tests__/no-silent-mutations.test.ts` (`TARGET_GLOBS`)
- Modify: `apps/web/src/locales/{en,de-DE,es-419,fr-CA,fr-FR,it-IT,pt-BR,tr-TR}/integrations.json`

**Interfaces:**
- Consumes: D8–D13; API status shape `{ status, capabilities?, features?, … }` (Task 8); routes `/tenants`, `/tenants/select`, `/tenants/cancel`.
- Produces:
  ```ts
  // lib/accountingProviders.ts
  export interface AccountingProviderUi { brandedConnect: boolean; confirmDisconnect: boolean }
  export const ACCOUNTING_PROVIDER_UI: Record<AccountingProviderId, AccountingProviderUi>;  // quickbooks {false,false}, xero {true,true}
  export const ALL_CAPABILITIES: Record<AccountingCapability, boolean>;                     // every capability true (older API fallback)
  export function connectErrorKey(code: string | null): string;                            // → an accountingConnection.connectErrors.* key
  // components
  export default function AccountingConnectButton(props: { provider: AccountingProviderId; reconnect: boolean; busy: boolean; disabled: boolean; onClick: () => void }): JSX.Element;
  export default function AccountingTenantPicker(props: { provider: AccountingProviderId; onUnauthorized: () => void; onDone: () => void }): JSX.Element;
  ```
- Test ids: `` `${provider}-connect` `` (unchanged), `` `${provider}-tenant-picker` ``, `` `${provider}-tenant-option-${tenantId}` ``, `` `${provider}-tenant-select` ``, `` `${provider}-tenant-cancel` ``, `` `${provider}-tenant-expired` ``, `` `${provider}-disconnect-confirm` ``.

- [ ] **Step 1: Add the English strings (the i18n tests are the first red)**

`locales/en/integrations.json`, inside `accountingConnection`:

```json
"tenantPicker": {
  "title": "Choose your {{provider}} organisation",
  "description": "You authorised more than one organisation. Breeze connects to exactly one; the others are removed from this connection.",
  "loadFailed": "Couldn't load your organisations from {{provider}}.",
  "expired": "This {{provider}} sign-in has expired. Cancel and connect again.",
  "connect": "Connect organisation",
  "cancel": "Cancel connection",
  "selectFailed": "Couldn't connect that organisation.",
  "cancelFailed": "Couldn't cancel the connection.",
  "connected": "{{provider}} organisation connected",
  "cancelled": "{{provider}} connection cancelled",
  "chooseFirst": "Choose an organisation first"
},
"connectErrors": {
  "generic": "The {{provider}} connection failed. Please try again.",
  "tenantHeld": "This {{provider}} organisation is connected to another Breeze account.",
  "providerConflict": "Disconnect your other accounting system before connecting {{provider}}.",
  "authEventMissing": "{{provider}} didn't confirm which organisations you authorised. Please connect again.",
  "noOrganisation": "No {{provider}} organisation was authorised. Choose an organisation on the {{provider}} consent screen.",
  "tenantLookupFailed": "Couldn't read your {{provider}} organisations. Please try again.",
  "consentDenied": "You cancelled the {{provider}} sign-in. Nothing was connected.",
  "selectTenant": "Choose which {{provider}} organisation to connect."
},
"disconnectConfirm": {
  "title": "Disconnect from {{provider}}?",
  "message": "Breeze will stop syncing with {{provider}} and remove its connection in {{provider}}. You can reconnect at any time.",
  "confirm": "Disconnect"
}
```

Add the same keys to the other seven locales as machine-drafted translations. Keep `{{provider}}` verbatim, and hand-check grammar around it in `de-DE` and `tr-TR`. The W02c PR description must include the two review-flag lines from `locales/README.md`.

```bash
cd apps/web && npx vitest run src/lib/i18n
```

Expected: PASS once all 8 locales have the keys. `keyUsage` may report the keys as unused until Step 4; that is expected and clears then.

- [ ] **Step 2: Write the failing component tests**

`AccountingConnectButton.test.tsx`:

```tsx
import { render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import AccountingConnectButton from './AccountingConnectButton';

describe('AccountingConnectButton', () => {
  it('QuickBooks renders the existing primary button (test id and label unchanged)', () => {
    render(<AccountingConnectButton provider="quickbooks" reconnect={false} busy={false} disabled={false} onClick={vi.fn()} />);
    const btn = screen.getByTestId('quickbooks-connect');
    expect(btn.className).toContain('bg-primary');
    expect(btn.textContent).toContain('Connect to QuickBooks');
  });

  it('Xero renders the certification-style branded button', () => {
    render(<AccountingConnectButton provider="xero" reconnect={false} busy={false} disabled={false} onClick={vi.fn()} />);
    const btn = screen.getByTestId('xero-connect');
    expect(btn.getAttribute('data-brand')).toBe('xero');
    expect(btn.textContent).toContain('Connect to Xero');
  });

  it('reconnect wording', () => {
    render(<AccountingConnectButton provider="xero" reconnect busy={false} disabled={false} onClick={vi.fn()} />);
    expect(screen.getByTestId('xero-connect').textContent).toContain('Reconnect Xero');
  });
});
```

(If W01d's value for `reconnectProvider` is not "Reconnect {{provider}}", assert the rendered English value it has.)

`AccountingTenantPicker.test.tsx`:

```tsx
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
const m = vi.hoisted(() => ({ fetchWithAuth: vi.fn() }));
vi.mock('../../stores/auth', () => ({ fetchWithAuth: m.fetchWithAuth }));
vi.mock('../shared/Toast', () => ({ showToast: vi.fn() }));
import AccountingTenantPicker from './AccountingTenantPicker';

const ok = (body: unknown, status = 200) => Promise.resolve(new Response(JSON.stringify(body), { status }));
beforeEach(() => m.fetchWithAuth.mockReset());

describe('AccountingTenantPicker', () => {
  it('lists the organisations and connects the chosen one', async () => {
    m.fetchWithAuth.mockImplementation((url: string) => url.endsWith('/tenants')
      ? ok({ data: [{ tenantId: 't-A', name: 'Alpha Ltd' }, { tenantId: 't-B', name: 'Beta Ltd' }], expiresAt: null })
      : ok({ connected: true }));
    const onDone = vi.fn();
    render(<AccountingTenantPicker provider="xero" onUnauthorized={vi.fn()} onDone={onDone} />);
    fireEvent.click(await screen.findByTestId('xero-tenant-option-t-B'));
    fireEvent.click(screen.getByTestId('xero-tenant-select'));
    await waitFor(() => expect(onDone).toHaveBeenCalled());
    const [url, init] = m.fetchWithAuth.mock.calls.find(([u]) => String(u).endsWith('/tenants/select'))!;
    expect(url).toBe('/accounting/xero/tenants/select');
    expect(JSON.parse(String((init as RequestInit).body))).toEqual({ tenantId: 't-B' });
  });

  it('shows the expired state with only Cancel available', async () => {
    m.fetchWithAuth.mockImplementation((url: string) => url.endsWith('/tenants')
      ? ok({ error: 'expired', code: 'tenant_selection_expired' }, 409)
      : ok({ cancelled: true }));
    const onDone = vi.fn();
    render(<AccountingTenantPicker provider="xero" onUnauthorized={vi.fn()} onDone={onDone} />);
    expect(await screen.findByTestId('xero-tenant-expired')).toBeTruthy();
    expect(screen.queryByTestId('xero-tenant-select')).toBeNull();
    fireEvent.click(screen.getByTestId('xero-tenant-cancel'));
    await waitFor(() => expect(onDone).toHaveBeenCalled());
  });

  it('a 409 tenant_held on select keeps the picker open (the user can choose another)', async () => {
    m.fetchWithAuth.mockImplementation((url: string) => url.endsWith('/tenants')
      ? ok({ data: [{ tenantId: 't-A', name: 'Alpha Ltd' }], expiresAt: null })
      : ok({ error: 'This Xero organisation is connected to another Breeze account', code: 'accounting_tenant_held' }, 409));
    const onDone = vi.fn();
    render(<AccountingTenantPicker provider="xero" onUnauthorized={vi.fn()} onDone={onDone} />);
    fireEvent.click(await screen.findByTestId('xero-tenant-option-t-A'));
    fireEvent.click(screen.getByTestId('xero-tenant-select'));
    await waitFor(() => expect(m.fetchWithAuth).toHaveBeenCalledTimes(2));
    expect(onDone).not.toHaveBeenCalled();
    expect(screen.getByTestId('xero-tenant-picker')).toBeTruthy();
  });
});
```

Append to `AccountingConnectionPanel.test.tsx`, using its `fetchWithAuth` mock-by-URL helper:

```tsx
describe('Xero W02 panel behaviour', () => {
  const xeroStatus = (over = {}) => ({
    status: 'connected', environment: 'production', pushMode: 'auto', connectedAt: null, lastError: null,
    pullPayments: true, pushPayments: true, lastReconcileAt: null,
    capabilities: { connect: true, mapping: false, customerImport: false, invoicePush: false, paymentPull: false, paymentPush: false },
    features: { tenantSelection: true, settingsOptions: false }, ...over,
  });

  it('hides every control whose capability is false (Xero W02: connect only)', async () => {
    mockStatus('/accounting/xero', xeroStatus());
    render(<AccountingConnectionPanel provider="xero" />);
    await screen.findByTestId('xero-disconnect');
    for (const id of ['xero-pushmode', 'xero-pullpayments', 'xero-pushpayments', 'xero-reconcile-now', 'xero-owed-operations']) {
      expect(screen.queryByTestId(id)).toBeNull();
    }
  });

  it('QuickBooks without a capabilities field (older API) still shows every control', async () => {
    render(<AccountingConnectionPanel provider="quickbooks" />);
    expect(await screen.findByTestId('quickbooks-pushmode')).toBeTruthy();
  });

  it('pending_tenant renders the organisation picker instead of the connect card', async () => {
    mockStatus('/accounting/xero', xeroStatus({ status: 'pending_tenant' }));
    mockJson('/accounting/xero/tenants', { data: [{ tenantId: 't-A', name: 'Alpha' }], expiresAt: null });
    render(<AccountingConnectionPanel provider="xero" />);
    expect(await screen.findByTestId('xero-tenant-picker')).toBeTruthy();
    expect(screen.queryByTestId('xero-connect')).toBeNull();
  });

  it('Xero disconnect asks for confirmation; QuickBooks does not', async () => {
    mockStatus('/accounting/xero', xeroStatus());
    render(<AccountingConnectionPanel provider="xero" />);
    fireEvent.click(await screen.findByTestId('xero-disconnect'));
    expect(await screen.findByTestId('xero-disconnect-confirm')).toBeTruthy();
    expect(fetchWithAuthMock).not.toHaveBeenCalledWith('/accounting/xero/disconnect', expect.anything());
  });

  it.each([
    ['tenant_held', 'This Xero organisation is connected to another Breeze account.'],
    ['consent_denied', 'You cancelled the Xero sign-in. Nothing was connected.'],
    ['auth_event_missing', 'Xero didn\'t confirm which organisations you authorised. Please connect again.'],
  ])('OAuth return error=%s shows its specific message', async (code, message) => {
    window.history.replaceState({}, '', `/integrations?accounting=xero&error=${code}#xero`);
    mockStatus('/accounting/xero', xeroStatus({ status: 'disconnected' }));
    render(<AccountingConnectionPanel provider="xero" />);
    await waitFor(() => expect(showToastMock).toHaveBeenCalledWith(expect.objectContaining({ type: 'error', message })));
  });
});
```

(`mockStatus`, `mockJson`, `fetchWithAuthMock` and `showToastMock` stand for the renamed test file's existing helpers. Use its real names.)

- [ ] **Step 3: Run and confirm they fail**

```bash
cd apps/web && npx vitest run src/components/integrations/AccountingConnectButton.test.tsx src/components/integrations/AccountingTenantPicker.test.tsx src/components/integrations/AccountingConnectionPanel.test.tsx
```

Expected: FAIL (the components are missing, and the panel ignores capabilities and `pending_tenant`).

- [ ] **Step 4: Implement**

`lib/accountingProviders.ts`, appended:

```ts
/** Per-provider UI treatment. Xero follows its app-certification rules (branded connect, confirmed disconnect). */
export interface AccountingProviderUi { brandedConnect: boolean; confirmDisconnect: boolean }
export const ACCOUNTING_PROVIDER_UI: Record<AccountingProviderId, AccountingProviderUi> = {
  quickbooks: { brandedConnect: false, confirmDisconnect: false },
  xero: { brandedConnect: true, confirmDisconnect: true },
};

/** Status responses from an API older than Xero W02 carry no capabilities: treat every control as available. */
export const ALL_CAPABILITIES: Record<AccountingCapability, boolean> = {
  connect: true, mapping: true, customerImport: true, invoicePush: true, paymentPull: true, paymentPush: true,
};

const CONNECT_ERROR_KEYS: Record<string, string> = {
  tenant_held: 'tenantHeld',
  provider_conflict: 'providerConflict',
  auth_event_missing: 'authEventMissing',
  no_organisation: 'noOrganisation',
  tenant_lookup_failed: 'tenantLookupFailed',
  consent_denied: 'consentDenied',
};
export function connectErrorKey(code: string | null): string {
  return `accountingConnection.connectErrors.${(code && CONNECT_ERROR_KEYS[code]) || 'generic'}`;
}
```

`AccountingConnectButton.tsx`:

```tsx
import { Loader2, Plug } from "lucide-react";
import { useTranslation } from "react-i18next";
import "@/lib/i18n";
import { ACCOUNTING_PROVIDER_NAMES, ACCOUNTING_PROVIDER_UI, type AccountingProviderId } from "../../lib/accountingProviders";

interface Props { provider: AccountingProviderId; reconnect: boolean; busy: boolean; disabled: boolean; onClick: () => void }

/**
 * The connect/reconnect button. QuickBooks keeps the exact pre-W02 markup.
 * Xero uses a branded treatment in line with Xero's app-certification guidance
 * ("Connect to Xero", Xero blue #13B5EA on white text); lab step X15 checks it
 * against Xero's current brand guidelines before certification.
 */
export default function AccountingConnectButton({ provider, reconnect, busy, disabled, onClick }: Props) {
  const { t } = useTranslation("integrations");
  const providerName = ACCOUNTING_PROVIDER_NAMES[provider];
  const label = reconnect
    ? t("accountingConnection.reconnectProvider", { provider: providerName })
    : t("accountingConnection.connectToProvider", { provider: providerName });
  const branded = ACCOUNTING_PROVIDER_UI[provider].brandedConnect;
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={busy || disabled}
      data-testid={`${provider}-connect`}
      data-brand={branded ? provider : undefined}
      className={branded
        ? "mt-4 inline-flex h-10 items-center gap-2 rounded-md bg-[#13B5EA] px-4 text-sm font-semibold text-white hover:bg-[#0f9fcd] focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[#13B5EA] disabled:opacity-50"
        : "mt-4 inline-flex h-10 items-center gap-2 rounded-md bg-primary px-4 text-sm font-medium text-primary-foreground hover:opacity-90 disabled:opacity-50"}
    >
      {busy ? <Loader2 className="h-4 w-4 animate-spin" /> : <Plug className="h-4 w-4" />}
      {label}
    </button>
  );
}
```

`AccountingTenantPicker.tsx`:

```tsx
import { useCallback, useEffect, useState } from "react";
import { Loader2 } from "lucide-react";
import { useTranslation } from "react-i18next";
import "@/lib/i18n";
import { fetchWithAuth } from "../../stores/auth";
import { runAction, ActionError, handleActionError } from "../../lib/runAction";
import { ACCOUNTING_PROVIDER_NAMES, accountingPath, type AccountingProviderId } from "../../lib/accountingProviders";

interface Props { provider: AccountingProviderId; onUnauthorized: () => void; onDone: () => void }
interface Choice { tenantId: string; name: string }
type LoadState = { kind: "loading" } | { kind: "ready"; choices: Choice[] } | { kind: "expired" } | { kind: "error" };

export default function AccountingTenantPicker({ provider, onUnauthorized, onDone }: Props) {
  const { t } = useTranslation("integrations");
  const providerName = ACCOUNTING_PROVIDER_NAMES[provider];
  const [state, setState] = useState<LoadState>({ kind: "loading" });
  const [chosen, setChosen] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    let live = true;
    void (async () => {
      try {
        const res = await fetchWithAuth(accountingPath(provider, "/tenants"));
        if (res.status === 401) { onUnauthorized(); return; }
        const body = await res.json().catch(() => ({}));
        if (!live) return;
        if (res.ok) setState({ kind: "ready", choices: (body as { data: Choice[] }).data ?? [] });
        else if ((body as { code?: string }).code === "tenant_selection_expired" || (body as { code?: string }).code === "auth_event_missing") setState({ kind: "expired" });
        else setState({ kind: "error" });
      } catch {
        if (live) setState({ kind: "error" });
      }
    })();
    return () => { live = false; };
  }, [provider, onUnauthorized]);

  const friendly = useCallback((code: string) => (code === "accounting_tenant_held"
    ? t("accountingConnection.connectErrors.tenantHeld", { provider: providerName })
    : undefined), [t, providerName]);

  const handleSelect = useCallback(async () => {
    if (!chosen) return;
    setBusy(true);
    try {
      await runAction({
        request: () => fetchWithAuth(accountingPath(provider, "/tenants/select"), {
          method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ tenantId: chosen }),
        }),
        errorFallback: t("accountingConnection.tenantPicker.selectFailed"),
        successMessage: t("accountingConnection.tenantPicker.connected", { provider: providerName }),
        friendly,
        onUnauthorized,
      });
      onDone();
    } catch (err) {
      if (!(err instanceof ActionError)) handleActionError(err, t("accountingConnection.tenantPicker.selectFailed"));
    } finally {
      setBusy(false);
    }
  }, [chosen, provider, providerName, friendly, onUnauthorized, onDone, t]);

  const handleCancel = useCallback(async () => {
    setBusy(true);
    try {
      await runAction({
        request: () => fetchWithAuth(accountingPath(provider, "/tenants/cancel"), { method: "POST" }),
        errorFallback: t("accountingConnection.tenantPicker.cancelFailed"),
        successMessage: t("accountingConnection.tenantPicker.cancelled", { provider: providerName }),
        onUnauthorized,
      });
      onDone();
    } catch (err) {
      if (!(err instanceof ActionError)) handleActionError(err, t("accountingConnection.tenantPicker.cancelFailed"));
    } finally {
      setBusy(false);
    }
  }, [provider, providerName, onUnauthorized, onDone, t]);

  return (
    <section className="space-y-4 rounded-lg border bg-card p-5" data-testid={`${provider}-tenant-picker`} aria-labelledby={`${provider}-tenant-picker-title`}>
      <h2 id={`${provider}-tenant-picker-title`} className="font-semibold">{t("accountingConnection.tenantPicker.title", { provider: providerName })}</h2>
      {state.kind === "loading" && <Loader2 className="h-5 w-5 animate-spin" />}
      {state.kind === "error" && <p role="alert" className="text-sm text-destructive">{t("accountingConnection.tenantPicker.loadFailed", { provider: providerName })}</p>}
      {state.kind === "expired" && (
        <p role="alert" className="text-sm text-amber-700" data-testid={`${provider}-tenant-expired`}>
          {t("accountingConnection.tenantPicker.expired", { provider: providerName })}
        </p>
      )}
      {state.kind === "ready" && (
        <>
          <p className="text-sm text-muted-foreground">{t("accountingConnection.tenantPicker.description")}</p>
          <fieldset className="space-y-2">
            <legend className="sr-only">{t("accountingConnection.tenantPicker.title", { provider: providerName })}</legend>
            {state.choices.map((choice) => (
              <label key={choice.tenantId} className="flex items-center gap-2 rounded-md border p-3 text-sm">
                <input
                  type="radio"
                  name={`${provider}-tenant`}
                  value={choice.tenantId}
                  checked={chosen === choice.tenantId}
                  onChange={() => setChosen(choice.tenantId)}
                  data-testid={`${provider}-tenant-option-${choice.tenantId}`}
                />
                {choice.name}
              </label>
            ))}
          </fieldset>
        </>
      )}
      <div className="flex flex-wrap gap-2">
        {state.kind === "ready" && (
          <button
            type="button"
            onClick={() => void handleSelect()}
            disabled={busy || !chosen}
            title={!chosen ? t("accountingConnection.tenantPicker.chooseFirst") : undefined}
            className="inline-flex h-9 items-center gap-2 rounded-md bg-primary px-3 text-sm font-medium text-primary-foreground disabled:opacity-50"
            data-testid={`${provider}-tenant-select`}
          >
            {t("accountingConnection.tenantPicker.connect")}
          </button>
        )}
        <button
          type="button"
          onClick={() => void handleCancel()}
          disabled={busy}
          className="inline-flex h-9 items-center gap-2 rounded-md border px-3 text-sm font-medium disabled:opacity-50"
          data-testid={`${provider}-tenant-cancel`}
        >
          {t("accountingConnection.tenantPicker.cancel")}
        </button>
      </div>
    </section>
  );
}
```

`AccountingConnectionPanel.tsx`: each change is anchored to the markup W01d produced.

1. The status interface: `status` gains `"pending_tenant"`. Add these fields:
   - `capabilities?: Record<AccountingCapability, boolean>`
   - `features?: { tenantSelection: boolean; settingsOptions: boolean }`
   - `defaultExemptTaxCodeRef?: string | null`
   - `defaultPaymentAccountRef?: string | null`
2. After `status` is loaded:
   ```tsx
   const caps = status?.capabilities ?? ALL_CAPABILITIES;
   const isPending = status?.status === "pending_tenant";
   const ui = ACCOUNTING_PROVIDER_UI[provider];
   const [confirmingDisconnect, setConfirmingDisconnect] = useState(false);
   ```
3. Wrap each capability-gated element in `{condition && (…)}`, keeping the element itself unchanged:
   - push-mode block (`` `${provider}-pushmode` ``): `caps.invoicePush`
   - pull-payments switch: `caps.paymentPull`
   - push-payments switch: `caps.paymentPush`
   - "Sync now" button, last-reconcile line and reconcile error: `(caps.paymentPull || caps.paymentPush)`
   - owed-operations section: `caps.paymentPush`. Also skip the owed-operations **fetch** when `!caps.paymentPush`, so no 409 is logged.
   - mapping workbench: `caps.mapping`
   - customer import: `caps.customerImport`
4. Replace the inline connect `<button>` with `<AccountingConnectButton provider={provider} reconnect={needsReauth} busy={connecting} disabled={!canManageAccounting} onClick={() => void handleConnect()} />`. Change the connect card's condition from `!isConnected` to `!isConnected && !isPending`. After it, render `{isPending && <AccountingTenantPicker provider={provider} onUnauthorized={onUnauthorized} onDone={() => void load()} />}`.
5. Disconnect: the button's `onClick` becomes `() => (ui.confirmDisconnect ? setConfirmingDisconnect(true) : void handleDisconnect())`. Add:
   ```tsx
   <ConfirmDialog
     open={confirmingDisconnect}
     onClose={() => setConfirmingDisconnect(false)}
     onConfirm={() => { setConfirmingDisconnect(false); void handleDisconnect(); }}
     title={t("accountingConnection.disconnectConfirm.title", { provider: providerName })}
     message={t("accountingConnection.disconnectConfirm.message", { provider: providerName })}
     confirmLabel={t("accountingConnection.disconnectConfirm.confirm")}
     variant="destructive"
     isLoading={disconnecting}
     confirmTestId={`${provider}-disconnect-confirm`}
   />
   ```
6. The OAuth-return effect: replace the single generic error toast with `t(connectErrorKey(params.get("error")), { provider: providerName })`. Add:
   ```tsx
   } else if (params.get("select_tenant") === "1") {
     showToast({ type: "warning", message: t("accountingConnection.connectErrors.selectTenant", { provider: providerName }) });
   }
   ```
   Also add `params.delete("select_tenant")`. QuickBooks still gets the same generic message for `exchange_failed` / `persist_failed`, because `connectErrorKey` falls back to `generic`. **Check that W01d's generic string equals the old `quickbooksConnectionFailedPleaseTryAgain` value.** If it does, point `generic` at that existing key instead of adding a duplicate.

`no-silent-mutations.test.ts` `TARGET_GLOBS`: add `src/components/integrations/AccountingTenantPicker.tsx`.

- [ ] **Step 5: Run and confirm they pass**

```bash
cd apps/web && npx vitest run src/components/integrations src/lib/accountingProviders.test.ts src/lib/i18n src/lib/__tests__/no-silent-mutations.test.ts && npx tsc --noEmit -p .
```

Expected: PASS. Every pre-existing QuickBooks panel assertion is unchanged.

- [ ] **Step 6: Commit**

```bash
git add -A apps/web/src
git commit -m "feat(web): Xero connect UI — capability-gated panel, organisation picker, branded connect, confirmed disconnect, specific OAuth errors (Xero W02)

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 12: Settings step (pickers and demo badge); connections-tab copy

**Files:**
- Create: `apps/web/src/components/integrations/AccountingSettingsStep.tsx`, `AccountingSettingsStep.test.tsx`
- Modify: `apps/web/src/components/integrations/AccountingConnectionPanel.tsx` (render the step)
- Modify: `apps/web/src/locales/*/integrations.json` (`accountingConnection.settingsStep.*`), `apps/web/src/locales/*/billing.json` (`billingConnectionsTab.accounting.description`)
- Modify: `apps/web/src/lib/__tests__/no-silent-mutations.test.ts` (`TARGET_GLOBS`)

**Interfaces:**
- Consumes: `GET /:provider/settings/options`, `PATCH /:provider/settings` (Task 8).
- Produces: `export default function AccountingSettingsStep(props: { provider: AccountingProviderId; values: SettingsValues; onSaved: (v: SettingsValues) => void; onUnauthorized: () => void }): JSX.Element`, where `type SettingsValues = { defaultIncomeAccountRef: string | null; defaultTaxCodeRef: string | null; defaultExemptTaxCodeRef: string | null; defaultPaymentAccountRef: string | null }`.
- Test ids: `` `${provider}-settings-step` ``, `` `${provider}-demo-badge` ``, `` `${provider}-organisation-name` ``, `` `${provider}-setting-${field}` `` (four selects), `` `${provider}-settings-save` ``.

- [ ] **Step 1: Add the strings**

`locales/en/integrations.json`, inside `accountingConnection`:

```json
"settingsStep": {
  "title": "{{provider}} settings",
  "organisation": "Organisation",
  "demoBadge": "Demo company",
  "incomeAccount": "Default revenue account",
  "taxRate": "Tax rate for taxable lines",
  "exemptTaxRate": "Tax rate for non-taxable lines",
  "paymentAccount": "Bank account for payments",
  "notSet": "Not set",
  "save": "Save settings",
  "saved": "{{provider}} settings saved",
  "saveFailed": "Couldn't save {{provider}} settings.",
  "loadFailed": "Couldn't load settings from {{provider}}."
}
```

`locales/en/billing.json` `billingConnectionsTab.accounting.description` becomes `"Stripe, QuickBooks and Xero connect under Integrations — manage them there."` (W01 left this as a W02 follow-up). Add or translate both changes in all 8 locales.

- [ ] **Step 2: Write the failing test**

```tsx
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
const m = vi.hoisted(() => ({ fetchWithAuth: vi.fn() }));
vi.mock('../../stores/auth', () => ({ fetchWithAuth: m.fetchWithAuth }));
vi.mock('../shared/Toast', () => ({ showToast: vi.fn() }));
import AccountingSettingsStep from './AccountingSettingsStep';

const ok = (body: unknown, status = 200) => Promise.resolve(new Response(JSON.stringify(body), { status }));
const options = {
  organisation: { name: 'Demo Company (UK)', isDemoCompany: true },
  incomeAccounts: [{ ref: '200', label: '200 · Sales', detail: 'REVENUE' }],
  taxRates: [{ ref: 'OUTPUT2', label: '20% (VAT on Income)', detail: '20%' }, { ref: 'NONE', label: 'No VAT', detail: '0%' }],
  bankAccounts: [{ ref: 'bank-1', label: 'Business Bank Account', detail: '12-3456' }],
};
const empty = { defaultIncomeAccountRef: null, defaultTaxCodeRef: null, defaultExemptTaxCodeRef: null, defaultPaymentAccountRef: null };

describe('AccountingSettingsStep', () => {
  it('shows the organisation with a demo badge and the four pickers', async () => {
    m.fetchWithAuth.mockReturnValue(ok({ data: options }));
    render(<AccountingSettingsStep provider="xero" values={empty} onSaved={vi.fn()} onUnauthorized={vi.fn()} />);
    expect((await screen.findByTestId('xero-organisation-name')).textContent).toContain('Demo Company (UK)');
    expect(screen.getByTestId('xero-demo-badge')).toBeTruthy();
    for (const f of ['defaultIncomeAccountRef', 'defaultTaxCodeRef', 'defaultExemptTaxCodeRef', 'defaultPaymentAccountRef']) {
      expect(screen.getByTestId(`xero-setting-${f}`)).toBeTruthy();
    }
  });

  it('no badge for a real organisation', async () => {
    m.fetchWithAuth.mockReturnValue(ok({ data: { ...options, organisation: { name: 'Acme Ltd', isDemoCompany: false } } }));
    render(<AccountingSettingsStep provider="xero" values={empty} onSaved={vi.fn()} onUnauthorized={vi.fn()} />);
    await screen.findByTestId('xero-organisation-name');
    expect(screen.queryByTestId('xero-demo-badge')).toBeNull();
  });

  it('saves all four refs with one page Save ("" → null)', async () => {
    m.fetchWithAuth.mockImplementation((_url: string, init?: RequestInit) => init?.method === 'PATCH'
      ? ok({ ...empty, defaultTaxCodeRef: 'OUTPUT2', defaultExemptTaxCodeRef: 'NONE' })
      : ok({ data: options }));
    const onSaved = vi.fn();
    render(<AccountingSettingsStep provider="xero" values={empty} onSaved={onSaved} onUnauthorized={vi.fn()} />);
    fireEvent.change(await screen.findByTestId('xero-setting-defaultTaxCodeRef'), { target: { value: 'OUTPUT2' } });
    fireEvent.change(screen.getByTestId('xero-setting-defaultExemptTaxCodeRef'), { target: { value: 'NONE' } });
    fireEvent.click(screen.getByTestId('xero-settings-save'));
    await waitFor(() => expect(onSaved).toHaveBeenCalled());
    const [url, init] = m.fetchWithAuth.mock.calls.find(([, i]) => (i as RequestInit | undefined)?.method === 'PATCH')!;
    expect(url).toBe('/accounting/xero/settings');
    expect(JSON.parse(String((init as RequestInit).body))).toEqual({
      defaultIncomeAccountRef: null, defaultTaxCodeRef: 'OUTPUT2', defaultExemptTaxCodeRef: 'NONE', defaultPaymentAccountRef: null,
    });
  });
});
```

- [ ] **Step 3: Run and confirm it fails**

```bash
cd apps/web && npx vitest run src/components/integrations/AccountingSettingsStep.test.tsx
```

Expected: FAIL (module missing).

- [ ] **Step 4: Implement**

```tsx
import { useCallback, useEffect, useState } from "react";
import { Loader2 } from "lucide-react";
import { useTranslation } from "react-i18next";
import "@/lib/i18n";
import { fetchWithAuth } from "../../stores/auth";
import { runAction, ActionError, handleActionError } from "../../lib/runAction";
import { ACCOUNTING_PROVIDER_NAMES, accountingPath, type AccountingProviderId } from "../../lib/accountingProviders";

export type SettingsValues = {
  defaultIncomeAccountRef: string | null;
  defaultTaxCodeRef: string | null;
  defaultExemptTaxCodeRef: string | null;
  defaultPaymentAccountRef: string | null;
};
interface Option { ref: string; label: string; detail: string | null }
interface Options {
  organisation: { name: string | null; isDemoCompany: boolean | null };
  incomeAccounts: Option[]; taxRates: Option[]; bankAccounts: Option[];
}
interface Props { provider: AccountingProviderId; values: SettingsValues; onSaved: (v: SettingsValues) => void; onUnauthorized: () => void }

const FIELDS: Array<{ field: keyof SettingsValues; labelKey: string; source: keyof Omit<Options, "organisation"> }> = [
  { field: "defaultIncomeAccountRef", labelKey: "incomeAccount", source: "incomeAccounts" },
  { field: "defaultTaxCodeRef", labelKey: "taxRate", source: "taxRates" },
  { field: "defaultExemptTaxCodeRef", labelKey: "exemptTaxRate", source: "taxRates" },
  { field: "defaultPaymentAccountRef", labelKey: "paymentAccount", source: "bankAccounts" },
];

/** Connection defaults for providers that declare settings pickers (Xero W02). Form screen → one page Save (settings rule 7). */
export default function AccountingSettingsStep({ provider, values, onSaved, onUnauthorized }: Props) {
  const { t } = useTranslation("integrations");
  const providerName = ACCOUNTING_PROVIDER_NAMES[provider];
  const [options, setOptions] = useState<Options | null>(null);
  const [loadFailed, setLoadFailed] = useState(false);
  const [draft, setDraft] = useState<SettingsValues>(values);
  const [saving, setSaving] = useState(false);

  useEffect(() => { setDraft(values); }, [values]);
  useEffect(() => {
    let live = true;
    void (async () => {
      try {
        const res = await fetchWithAuth(accountingPath(provider, "/settings/options"));
        if (res.status === 401) { onUnauthorized(); return; }
        if (!res.ok) { if (live) setLoadFailed(true); return; }
        const body = (await res.json()) as { data: Options };
        if (live) setOptions(body.data);
      } catch {
        if (live) setLoadFailed(true);
      }
    })();
    return () => { live = false; };
  }, [provider, onUnauthorized]);

  const handleSave = useCallback(async () => {
    setSaving(true);
    try {
      const updated = await runAction<SettingsValues>({
        request: () => fetchWithAuth(accountingPath(provider, "/settings"), {
          method: "PATCH", headers: { "Content-Type": "application/json" }, body: JSON.stringify(draft),
        }),
        errorFallback: t("accountingConnection.settingsStep.saveFailed", { provider: providerName }),
        successMessage: t("accountingConnection.settingsStep.saved", { provider: providerName }),
        onUnauthorized,
      });
      onSaved({
        defaultIncomeAccountRef: updated.defaultIncomeAccountRef ?? null,
        defaultTaxCodeRef: updated.defaultTaxCodeRef ?? null,
        defaultExemptTaxCodeRef: updated.defaultExemptTaxCodeRef ?? null,
        defaultPaymentAccountRef: updated.defaultPaymentAccountRef ?? null,
      });
    } catch (err) {
      if (!(err instanceof ActionError)) handleActionError(err, t("accountingConnection.settingsStep.saveFailed", { provider: providerName }));
    } finally {
      setSaving(false);
    }
  }, [draft, provider, providerName, onSaved, onUnauthorized, t]);

  return (
    <section className="space-y-4 rounded-lg border bg-card p-5" data-testid={`${provider}-settings-step`} aria-labelledby={`${provider}-settings-title`}>
      <h2 id={`${provider}-settings-title`} className="font-semibold">{t("accountingConnection.settingsStep.title", { provider: providerName })}</h2>
      {loadFailed && <p role="alert" className="text-sm text-destructive">{t("accountingConnection.settingsStep.loadFailed", { provider: providerName })}</p>}
      {!options && !loadFailed && <Loader2 className="h-5 w-5 animate-spin" />}
      {options && (
        <>
          <p className="text-sm">
            <span className="text-muted-foreground">{t("accountingConnection.settingsStep.organisation")}: </span>
            <span className="font-medium" data-testid={`${provider}-organisation-name`}>{options.organisation.name ?? "—"}</span>
            {options.organisation.isDemoCompany === true && (
              <span className="ml-2 inline-flex rounded-full border border-amber-200 bg-amber-50 px-2 py-0.5 text-xs text-amber-800" data-testid={`${provider}-demo-badge`}>
                {t("accountingConnection.settingsStep.demoBadge")}
              </span>
            )}
          </p>
          <div className="grid gap-4 sm:grid-cols-2">
            {FIELDS.map(({ field, labelKey, source }) => (
              <label key={field} className="space-y-1 text-sm">
                <span className="text-muted-foreground">{t(`accountingConnection.settingsStep.${labelKey}`)}</span>
                <select
                  className="h-9 w-full rounded-md border bg-background px-2"
                  value={draft[field] ?? ""}
                  onChange={(e) => setDraft((prev) => ({ ...prev, [field]: e.target.value || null }))}
                  data-testid={`${provider}-setting-${field}`}
                >
                  <option value="">{t("accountingConnection.settingsStep.notSet")}</option>
                  {options[source].map((o) => (
                    <option key={o.ref} value={o.ref}>{o.detail ? `${o.label} (${o.detail})` : o.label}</option>
                  ))}
                </select>
              </label>
            ))}
          </div>
          <button
            type="button"
            onClick={() => void handleSave()}
            disabled={saving}
            className="inline-flex h-9 items-center gap-2 rounded-md bg-primary px-3 text-sm font-medium text-primary-foreground disabled:opacity-50"
            data-testid={`${provider}-settings-save`}
          >
            {saving && <Loader2 className="h-4 w-4 animate-spin" />}
            {t("accountingConnection.settingsStep.save")}
          </button>
        </>
      )}
    </section>
  );
}
```

In `AccountingConnectionPanel.tsx`, inside the connected block, before the push-mode block:

```tsx
{isConnected && status?.features?.settingsOptions && (
  <AccountingSettingsStep
    provider={provider}
    values={{
      defaultIncomeAccountRef: status.defaultIncomeAccountRef ?? null,
      defaultTaxCodeRef: status.defaultTaxCodeRef ?? null,
      defaultExemptTaxCodeRef: status.defaultExemptTaxCodeRef ?? null,
      defaultPaymentAccountRef: status.defaultPaymentAccountRef ?? null,
    }}
    onSaved={(v) => setStatus((prev) => (prev ? { ...prev, ...v } : prev))}
    onUnauthorized={onUnauthorized}
  />
)}
```

`no-silent-mutations.test.ts` `TARGET_GLOBS`: add `src/components/integrations/AccountingSettingsStep.tsx`.

- [ ] **Step 5: Run and confirm it passes**

```bash
cd apps/web && npx vitest run src/components/integrations src/components/billing src/lib && npx tsc --noEmit -p .
cd apps/web && npx vitest run src/lib/__tests__/settingsPageRegistry.test.ts
```

Expected: PASS. The settings-page registry is unaffected: no new settings *page* or URL, only a card inside the existing Integrations panel.

- [ ] **Step 6: Commit**

```bash
git add -A apps/web/src
git commit -m "feat(web): Xero settings step — revenue/tax/exempt/bank pickers with page Save and demo-company badge (Xero W02)

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 13: `docs/integrations/xero-demo-verification.md` (lab checklist)

**Files:**
- Create: `docs/integrations/xero-demo-verification.md`

**Interfaces:**
- Produces: the living lab document the index names. W03–W05 append their own sections. This task settles open verification items 3 and 4 (X14, X7), plus refinement items 2 and 14 (X8, X9).

- [ ] **Step 1: Write the document**

````markdown
# Xero Demo Company Verification

The Xero counterpart of `quickbooks-sandbox-verification.md`. Xero has no
sandbox: every run uses the **Xero Demo Company** (My Xero → Try the Demo
Company), which Xero resets periodically. This is a **living document**:
re-run the relevant section before every release that touches Xero code, and
append a new evidence block rather than overwriting.

Spec: `docs/superpowers/specs/billing/2026-09-26-xero-accounting-integration-design.md`
("Open verification items"). Plans: `docs/superpowers/plans/billing/2026-09-26-xero-*.md`.

---

## 0. Setup

1. A Xero developer account with a **Web app** (developer.xero.com → New app):
   - Redirect URI: `https://<stack-host>/api/v1/accounting/xero/callback`
   - Note the client id / secret; generate a webhook key (W05).
2. Stack: `pnpm wt-stack up` from the W02 branch (see `.claude/skills/worktree-stack`).
   Set in the stack's `.env` **and** confirm the api container sees them
   (`docker exec <api> printenv | grep ^XERO_`):
   `XERO_CLIENT_ID`, `XERO_CLIENT_SECRET`, `XERO_REDIRECT_URI`, `XERO_DAILY_CALL_LIMIT=1000`.
3. Two Breeze partners (P1, P2), each with a full-partner admin that has MFA
   enrolled. One Xero login (U1) with access to **two** organisations: the
   Demo Company and one real trial organisation (T2). A second Xero login (U2)
   with access to T2 only.

## 1. Automated gate (record the result)

```bash
cd apps/api && npx vitest run src/services/accounting src/routes/accounting src/jobs/accountingReconcileWorker.test.ts \
  src/middleware/selfManagedDbContextRoutes.test.ts src/config src/system/connections
cd apps/web && npx vitest run src/components/integrations src/lib/i18n src/lib/__tests__/no-silent-mutations.test.ts
pnpm test-stack up
cd apps/api && npx vitest run -c vitest.integration.config.ts src/__tests__/integration/accountingXeroConnection.integration.test.ts \
  src/__tests__/integration/accountingXeroColumns.integration.test.ts
pnpm test-stack down
```

## 2. W02 checklist — connection

Record PASS / FAIL and the visible Breeze state after each step. "Connected
apps" means Xero → Settings → Connected apps for that organisation.

| # | Step | Expected |
|---|---|---|
| X1 | P1: Integrations → Accounting → **Connect to Xero**; tick **only** Demo Company | Returns connected; card shows Demo Company + **Demo company** badge; Connected apps lists the Breeze app once |
| X2 | P1 disconnect; connect again ticking Demo Company **and** T2 | Picker lists both; choose Demo Company → connected; **T2 no longer lists the Breeze app** (unchosen link removed) |
| X3 | P1 disconnect; connect ticking both; on the picker press **Cancel connection** | Card returns to "Connect"; neither organisation lists the Breeze app |
| X4 | Connect ticking both, leave the picker; in psql `update accounting_connections set updated_at = now() - interval '2 hours' where status='pending_tenant'`; wait for the 15-min sweep (or trigger `sweep`) | Row gone; both links removed in Xero; QuickBooks card is clickable again |
| X5 | P1 connected to Demo Company. P2 (as U1) connects ticking Demo Company only | Redirect shows "This Xero organisation is connected to another Breeze account"; **P1 still connected and syncing**; Demo Company still lists the Breeze app |
| X6 | P1 and P2 open the picker in two browsers for the same organisation and click Connect within ~1 s | Exactly one connects; the other gets the tenant-held message and stays on the picker |
| X7 | During X1, decode the access token (dev-only: set a breakpoint or temporary log in a local branch, never commit) | Token payload carries `authentication_event_id`; `/connections?authEventId=` returns only this flow's links — **settles open item 4** |
| X8 | P1 connected. Force reauth (`update accounting_connections set status='reauth_required' where partner_id=…`); click **Reconnect Xero**, tick Demo Company | Reconnects to the **same** organisation with no picker, mappings intact (no `realm_changed` audit). Record whether the filtered `/connections` list was empty (expected: yes — the link keeps its first authEventId) — **settles refinement 2** |
| X9 | Set `access_token_expires_at = now()` and trigger two concurrent refreshes (two Sync-style calls, or two `settings/refresh` requests) | Both succeed, status stays connected, exactly one refresh token persisted; record whether Xero's second refresh with the old token returned tokens (grace) or `invalid_grant` — **settles refinement 14** |
| X10 | P1 and P2 both connected via the SAME Xero user U1 (to different orgs). P1 disconnects | P1's organisation drops the Breeze app; **P2 stays connected** and its next refresh succeeds (proves no revocation) |
| X11 | Settings step: pick revenue account, taxable rate, exempt rate, bank account; Save; reload | Values persist; lists show only ACTIVE revenue accounts, revenue-capable tax rates, BANK accounts |
| X12 | Xero-side: in Connected apps, disconnect Breeze manually; in Breeze click Refresh settings | A clear error (not a 500); after token expiry the card shows **Reconnect Xero** |
| X13 | Load the settings step 3× and check Redis `acct-rl:xero:day-remaining:<connectionId>` | Present and decreasing (X-DayLimit-Remaining recorded) |
| X14 | On the consent screen, read the requested permissions | Contacts, invoices (incl. items), payments, settings (read) + offline access; **no "transactions" broad scope** — **settles open item 3** |
| X15 | Certification UI pass against Xero's current app-partner checklist: branded **Connect to Xero** button, org name shown when connected, **Disconnect** with confirmation, clear error on consent cancel (press Cancel on Xero's consent screen → "You cancelled the Xero sign-in"), no dead ends | All pass; screenshot each |

### Evidence header (fill in per run)

| Field | Value |
|---|---|
| Date | |
| Breeze build SHA | |
| Tester | |
| Xero app (client id prefix) | |
| Organisations used | |

### Results

| # | Result | Notes |
|---|---|---|
| X1 | | |
| X2 | | |
| X3 | | |
| X4 | | |
| X5 | | |
| X6 | | |
| X7 | | |
| X8 | | |
| X9 | | |
| X10 | | |
| X11 | | |
| X12 | | |
| X13 | | |
| X14 | | |
| X15 | | |

## Change log

- W02 — initial checklist (X1–X15).
````

- [ ] **Step 2: Check the links and markdown**

```bash
grep -n "quickbooks-sandbox-verification.md" docs/integrations/xero-demo-verification.md
ls docs/integrations/quickbooks-sandbox-verification.md
```

Expected: the referenced file exists.

- [ ] **Step 3: Commit, then open PR W02c**

```bash
git add docs/integrations/xero-demo-verification.md
git commit -m "docs(accounting): Xero Demo Company verification checklist (Xero W02)

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

Run the full W02c gate. Open the PR titled `feat(web): Xero W02c — connect UI, organisation picker, settings step, lab checklist`, with `Closes #7169`. The body must include:
- the settings-rule-9 statement from "PR split";
- the two machine-translation review lines;
- the X1–X15 results, **or** "lab pending" with the owner named. X14 (and X7, if the portal check in Task 4 Step 1 was skipped) block merge.

After merge, run `complete_wave` for #7169.

---

## Self-review (done while writing; kept for the executor)

**Spec coverage (§W02):** OAuth URLs + Basic auth (Task 4). Pinned scopes (Task 4 Step 1). `realmId`-less callback (Task 7). `authEventId`-filtered `/connections` + fail closed (Tasks 4, 7). One organisation → auto-select, several → `pending_tenant` + picker, zero → error (Task 7). `pending_tenant` excluded from both resolvers, counted by the index, cancel, 1-hour reaper (Tasks 2, 6, 8, 9). `realm_id_encrypted` + fingerprint + `provider_connection_ref` on selection (Tasks 6, 7). Unchosen same-authEvent links removed only when not held (Task 6). Tenant held by another partner → 409 (Tasks 2, 6, 8, 10). 30-minute access token with a sliding 60-day refresh (Task 4). Row-lock rotation unchanged, `invalid_grant` → reauth (Task 4). `fetchRealmSettings` from Organisation / Currencies, IsDemoCompany badge (Tasks 5, 12). `environment = production` (Task 5). The three columns (Task 1). Pickers from Accounts / TaxRates (Tasks 5, 8, 12). Disconnect via `DELETE /connections/{id}`, never revocation (Tasks 5, 8). The export/erasure confirmation (refinement 11). Env vars + compose + parity + registry (Task 3). `XERO_DAILY_CALL_LIMIT` → limiter (Tasks 3, 5). `limits.rate` (Task 5). The web card appears only when configured (D10, inherited). Picker, settings step and certification UI (Tasks 11, 12). Lab doc (Task 13).

**Placeholder scan:** no TBD or "similar to". Where a test uses a helper from an existing test file (`request`, `mockStatus`, `makeLockableDb`), the task names it and says to use the file's real name. That is a W01d dependency, and the assertions are fixed.

**Type consistency:** `ProviderTenant` (Task 4) is used unchanged in Tasks 5–8. `AccountingTenantHeldError`, `getPartnerConnectionRef`, `PENDING_TENANT_STATUS` and `REALM_FINGERPRINT_UNIQUE_INDEX` (Task 2) are used in Tasks 6–8. `finalizeConnection` / `ConnectOutcome` / `connectRedirectPath` (Task 7) are used in Task 8. `DeletedPendingRow` (Task 6) is used only in Task 6. `SettingsValues` (Task 12) matches the PATCH body fields (Task 8).

**Review Focus → tests:** 1 → Task 10 "two partners racing", Task 8 "select 409", Task 7 "tenant held". 2 → Task 6 "keeps a tenant another partner holds", Task 10 "held check … system scope". 3 → Task 2 unit + integration, Task 9, Task 10 "stale pending row is reaped". 4 → Task 4 `decodeXeroAuthEventId`, Task 7 "missing auth-event claim". 5 → Task 4 "Xero rotation race".

**Deliberately not in W02:**
- contact/item upsert, import, workbench (W03);
- invoice push, tax allocation, variant keys (W04);
- `/webhooks/xero`, reconcile, payment push, the final `paymentRefMax` and `paymentMarker` (W05);
- the Xero apps/docs feature page (spec "Rollout");
- dropping `accounting_connections_partner_provider_idx` (the W01 follow-up);
- hosted app registration and tier choice (owner actions).
