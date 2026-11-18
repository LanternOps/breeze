---
tracking_issue: LanternOps/breeze#11377
---

# Portal Registration W5: Domain Verification and Organization › Domains Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** An MSP can prove that a customer org owns an email domain by one of three methods: a DNS TXT record, the org's proven Entra tenant, or the org's Google Workspace directory. The proof is re-checked daily and cleared when it lapses, and a domain is verified for at most one org on the platform. Domains get one home, Organization › Domains. W6 (self-registration) and W7 (Google sign-in) consume the verified facts through a small read API.

**Architecture:**
- **No new table.** Verification state goes on the existing `customer_email_domains` rows (spec §5.4, index cross-wave table), in new columns. A `BEFORE UPDATE` trigger clears it when a row is repointed to another org or renamed. Org merge is exempt through a transaction-local GUC. A partial unique index on `lower(domain) WHERE verified_at IS NOT NULL` enforces "one verified org per domain, platform-wide".
- **Checkers.** `services/portalDomainVerification/checkers/` has one checker per method, all behind one `DomainVerificationChecker` interface. Each returns `pass`, `fail` (definitive) or `unavailable` (transient). Only `pass` and `fail` change state.
  - `dns_txt`: `_breeze-verify.<domain>` TXT `breeze-verification=<token>`, using the injectable resolver in `emailDomains/dnsOwnershipProof.ts`.
  - `entra_tenant`: the domain is in `verifiedDomains` of `GET /organization` for the org's **proven** tenant (W4), read through the org's identity-first `customer-graph-read` connection (`m365.org.get`).
  - `google_directory`: the domain is `verified` in the Directory API domains list (`domains.list`, `customer: 'my_customer'`) through the org's Google Workspace connection, with a token that asks **only** for the new domain scope.
- **Service.** `services/portalDomainVerification/service.ts` records, removes and re-checks verifications, applies the transfer rule (D5) and exposes the read API for W6/W7 (`isDomainVerifiedForOrg`, `findOrgByVerifiedDomain`, `listVerifiedDomainsForOrg`). Those re-validate the evidence at use, so a lost tenant proof or a removed Google connection stops dependent features on the next request.
- **Worker.** An hourly BullMQ repeatable job re-checks each verified row about once a day (23 h minimum age) and clears lapsed ones.
- **UI.** A new **Domains** tab in org settings. Ticketing › Inbound email becomes a read-only summary with links, and the Sign-in & registration card gains a Domains row.

**Tech Stack:** Hono, Drizzle (queries only), a hand-written SQL migration, PostgreSQL forced RLS, BullMQ, `node:dns` (injectable), `@googleapis/admin` + `google-auth-library`, the M365 Graph read executor client, Astro + React, Vitest (unit plus `vitest.integration.config.ts`).

**Spec:** `docs/superpowers/specs/portal/2026-11-07-portal-registration-options-design.md`. Relevant sections: §2 F7 and F9, §3 anti-goals ("a second home for customer domains"), §4 (the card's Domains row), §5.4 (domain verification, the requirements table, UI home), §6 invariants 2 and 3, the §7 W5 row, §9 Q3 and §10 ("re-check cadence for DNS"). The index is `2026-11-08-portal-registration-options-index.md`.

**Builds on (all merged on `main` at `25c4af12f2`):**
- **W4a #11557 and W4b #11568:**
  - `services/portalEntraTenantProof.ts`: `findProvenEntraTenantForOrg(orgId): Promise<{ tenantId: string; provenAt: Date } | null>` (reads under a held context, otherwise opens a system context);
  - the `organization.portal_identity_proof.*` audit family and the `notifyDisplacedPartner` / `listActivePartnerAdmins` after-commit email pattern;
  - `partner.portal_entra_tenant.displaced` in `services/emailDomains/mailPurposes.ts`, the template for W5's one new mail purpose;
  - `routes/orgPortalEntraTenant.ts` (`registerPortalEntraTenantRoutes(orgRoutes)` in `routes/orgs.ts:117`), the template for W5's org-scoped routes;
  - `apps/web/src/components/settings/portalAccess/OrgSignInRegistrationCard.tsx` (W5 adds the Domains row).
- **W3a #11528 / W3b #11523:** `resolvePortalAccessPolicy` (`services/portalAccessPolicy.ts:231`). It has **no cache and no invalidation hook** (plan D1 of W3). W5 therefore adds no invalidation call. W6 and W7 read domain facts at use.
- **Existing code W5 extends:**
  - `customer_email_domains` (`db/schema/emailInbound.ts:50-63`; migration `2026-06-20-a-customer-email-domains.sql`). It is **shape 3, partner-axis**: one RLS policy `customer_email_domains_partner_access` on `breeze_has_partner_access(partner_id)`, with a denormalized `org_id` and the composite FK `(org_id, partner_id) → organizations(id, partner_id) ON DELETE CASCADE`. It is unique on `(partner_id, domain)`.
  - CRUD in `services/ticketConfigService.ts:917-1010` (`list/create/update/deleteCustomerEmailDomain`). `update` can repoint `orgId`; nothing can change `domain`.
  - Routes `GET/POST/PATCH/DELETE /ticket-config/inbound-domains` (`routes/ticketConfig.ts:163-230`) and the AI tool `manage_ticket_config` (`services/aiToolsTicketConfig.ts:170-215`). Both stay, unchanged in shape (D9).
  - Validators `customerDomainSchema`, `createCustomerEmailDomainSchema`, `updateCustomerEmailDomainSchema` (`packages/shared/src/validators/ticketConfig.ts:73-100`).
  - `services/emailDomains/dnsOwnershipProof.ts`: `DnsTxtResolver`, `setDnsTxtResolverForTest`, `ownershipTxtRecordName(domain)` (= `_breeze-verify.<domain>`).
  - `services/m365ControlPlane/readActionService.ts:454` `executeM365ReadActionByOrg` and the `m365.org.get` action (`packages/shared/src/m365/readActions.ts:75`, projecting `id, displayName, verifiedDomains, …`). The `customer-graph-read` profile already holds `Organization.Read.All`.
  - `services/googleClient.ts:81` `getDirectoryClient`, `googleHelpers.ts` `loadGoogleConnection(orgId)` / `decryptConnectionKey(conn)`, and `packages/shared/src/constants/googleDwdScopes.ts`.
  - `services/ssoDomainRecheckWorker.ts`, the worker template (queue, repeatable, `jobSchedule`, `workerRegistry.ts:1405`, `workerReadinessManifest.ts:200`).

**Rigor: high.** This wave adds a migration to an org-cascade table, cross-partner transfer of a proof, a trigger that must survive org merge, and the proof that W6's public self-registration and W7's sign-in will trust. Full TDD, one independent review round per PR, contract suites before each PR. The advisor quorum (`codex exec`, xhigh, read-only) reviews D1–D12 before the W05a PR opens.

## PR split

| PR | Tasks | Branch | Body | Depends on |
|---|---|---|---|---|
| **W05a: API** | 1–8 | `feature/11377-portal-registration/wave-11382` | `Part of #11382` (never `Closes`) | W4a + W4b merged (they are) |
| **W05b: Web + docs** | 9–11 | `feature/11377-portal-registration/wave-11382-b` | `Closes #11382` | W05a **merged to main**. Branch from fresh main; do not stack, because a stacked PR runs no CI. |

**W05a's visible surface.** The API is complete, but no user-facing feature trusts a verified domain until W6/W7 ship. Visible changes in W05a:
- `/ticket-config/inbound-domains` list rows gain verification fields (additive).
- A PATCH that moves a verified domain to another org now clears its verification (no row is verified before W05a, so nothing changes on deploy).
- The Google Workspace setup scope CSV gains one scope (D8). Existing connections keep working unchanged.

## Decisions taken in this plan (flag in each PR body)

- **D1: Verification lives on `customer_email_domains`. There is no new table.**
  - Spec §5.4 names the columns on this table, the index's cross-wave table says "domain verification state on `customer_email_domains`", and the spec's anti-goals forbid "a second home for customer domains".
  - **Tenancy shape is unchanged: shape 3 (partner-axis), `partner_id NOT NULL` and `org_id NOT NULL`.** The partner-wide-first `org_id XOR partner_id` rule (#2135) is for config and policy tables. A domain is evidence about one customer org, not a setting with a partner default, so a partner-owned row has no meaning. The existing shape is kept.
  - The four registrations already exist. Only the export policy changes (new columns classified). Cascade, merge (`REPOINT_TABLES`, `orgMergeRegistry.ts:984`) and RLS coverage (`rls-coverage.integration.test.ts:198,373`) stay as they are.
- **D2: Columns** (all nullable except `check_failures`):
  - `verification_token text`: 24 random bytes, hex (`generateOwnershipToken`). Issued when the MSP starts DNS verification, not at row creation.
  - `verified_at timestamptz`, `verified_method text` (`dns_txt | entra_tenant | google_directory`), `verified_evidence jsonb`, `verified_by_user_id uuid → users ON DELETE SET NULL`.
  - `last_checked_at`, `last_passed_at timestamptz`, `last_check_status text` (`pass | fail | unavailable`), `check_failures integer NOT NULL DEFAULT 0`.
  - `cleared_at timestamptz`, `cleared_reason text`, so the UI can say why a domain is no longer verified.
  - CHECKs tie the verified columns together, constrain the enums and require the evidence keys per method (Task 1 SQL).
- **D3: Clear on repoint, by trigger** (inv. 3).
  - `BEFORE UPDATE`: when `org_id` changes or `lower(domain)` changes, null the verification columns and the token. If the row was verified, set `cleared_at = now()` and `cleared_reason = 'repointed'`.
  - **The token rotates too.** The customer's DNS admin must publish a new record for the new org. Otherwise an old record would re-verify a domain the MSP moved to a different customer org.
  - **Org merge is exempt.** `executeOrgMerge`'s Phase B transaction runs `SELECT set_config('breeze.org_merge', 'on', true)` first, and the trigger skips while it is `on`. The merge is one system transaction (`orgMerge.ts:1416-1418`), so the flag ends with it. Merge is the same partner saying "these are one customer", like W4 D8's adoption of a proven tenant mapping. Per-method checks at use (D6) catch evidence that does not survive the merge, such as a dropped Google connection.
  - A contract test pins that `breeze.org_merge` is set only in `services/orgMerge.ts`.
- **D4: One verified org per domain, platform-wide.** A partial unique index `customer_email_domains_verified_domain_uq ON (lower(domain)) WHERE verified_at IS NOT NULL`. Within one partner the existing `(partner_id, domain)` unique already prevents two rows, so a conflict is always cross-partner.
- **D5: Transfer rule. The incumbent keeps the domain while its own evidence still checks out live** (OD1).
  - When org B's check passes for a domain verified for org A (another partner), the service re-checks A's evidence **live**, with A's method:
    - A `fail` → A is cleared (`cleared_reason = 'displaced'`), B is verified, both orgs are audited, and A's partner admins are emailed after commit.
    - A `pass` or `unavailable` → B gets 409 `DOMAIN_VERIFIED_ELSEWHERE` and nothing changes. The message: "This domain is verified for another organization. Its owner must remove the other verification (DNS record or directory connection) first."
  - Why not "newest proof wins" (W4 D7)? A tenant proof run needs a live admin sign-in, so it cannot be stale. A DNS TXT record or an old Workspace DWD grant can outlive the MSP relationship. "Newest wins" would let a former MSP take a domain back with a record the customer forgot to delete.
  - **Displacement is deliberately single-shot**, unlike the worker's two-miss rule (D10). The worker's grace protects a holder whose evidence blips with nobody else claiming the domain. Here a challenger has shown live control at the same moment the incumbent cannot, which is the transfer case. A one-off blip on the incumbent's own record while the challenger's record in the same zone resolves is not a realistic DNS failure mode; for the directory methods the two sources are independent.
  - The 409 tells B that the domain is verified elsewhere. B learns that only after B's own live check passed, so B has already shown current control of the domain.
  - **Concurrency.** The challenger's and the incumbent's checks run **before** the transaction (network I/O never runs inside a DB transaction). The write transaction then takes `pg_advisory_xact_lock(hashtext('portal-domain:' || lower($domain)))`, re-reads both rows `FOR UPDATE`, and proceeds only if the incumbent's `verified_at` is unchanged since its check. Otherwise it returns 409 `DOMAIN_VERIFICATION_CONFLICT_RETRY` with no write. A stray 23505 on `customer_email_domains_verified_domain_uq` maps to `DOMAIN_VERIFIED_ELSEWHERE` without a live check (the row that won the race has just passed its own), never a 500.
  - The transaction runs under `withSystemDbAccessContext` (via `runOutsideDbContext` from routes). That is justified: the incumbent row belongs to another partner, and the write is backed by live evidence, not MSP input.
- **D6: The read API re-validates evidence at use** (inv. 3, "features stop on the next request").
  - A row counts as verified only when **all** of these hold: `verified_at IS NOT NULL`, `is_active = true` (OD5), and the method's structural check:
    - `dns_txt`: nothing more. DNS cannot be looked up per request; the worker owns it.
    - `entra_tenant`: `findProvenEntraTenantForOrg(row.org_id)?.tenantId === evidence.tenantId`.
    - `google_directory`: the org's `google_workspace_connections` row exists and its `id === evidence.connectionId`.
  - A recreated Google connection (new id) therefore drops the verification at use. The worker then clears it with `connection_missing`.
- **D7: The Entra checker reads `GET /organization` through the identity-first connection, and binds the result to the proven tenant.**
  - Steps: `findProvenEntraTenantForOrg(orgId)` (null → `fail tenant_not_proven`); the org's `m365_connections` row with `profile = 'customer-graph-read'`, `user_id IS NULL` and `tenant_id = <proven tenant>` (none → `fail connection_missing`); then `m365.org.get`.
  - The response's `id` must equal the proven tenant id, or the result is `unavailable` (`graph_tenant_mismatch`, logged at error level). Then the domain must equal one of `verifiedDomains[].name`, case-insensitively and exactly (no subdomain match).
  - **Initial domains are never verifiable:** `*.onmicrosoft.com` (and any entry with `isInitial: true`) is excluded. It is Microsoft's routing name for the tenant, not a customer domain, and W6 must not treat it as a self-registration domain. `customerDomainSchema` already accepts it as a declared row for mail routing; the checker returns `fail not_in_directory` for it.
  - **Not through the AI tools gate** (OD3). `executeM365ReadActionByOrg` refuses unless the env allowlist `M365_GRAPH_READ_TOOLS_ENABLED` / org allowlist (`runtimeConfig.ts:258`) admits the org, because it serves AI tools. Task 3 adds `readM365OrganizationForVerification(orgId)` to `readActionService.ts`. It shares the connection gates (`connectionNotReadyState`, `connectionExecutionSnapshot`) and runs only `m365.org.get`, but skips `toolsGateRefusal`.
  - **Orgs proven by proof run with no M365 connection** cannot use this method (OD2). The UI tells the MSP to connect Microsoft 365 or use DNS.
- **D8: The Google checker asks only for the domain scope.**
  - New `DIRECTORY_DOMAIN_SCOPES = ['https://www.googleapis.com/auth/admin.directory.domain.readonly']` in `googleDwdScopes.ts`, appended to `GOOGLE_DWD_SCOPES_CSV` (the list admins paste into the DWD grant), and **not** added to `DIRECTORY_SCOPES`.
  - New `getDirectoryDomainsClient(decryptedKeyJson, adminEmail)` in `googleClient.ts` mints a JWT with only that scope.
  - Why: a JWT that asks for a scope the customer has not granted fails as a whole (`unauthorized_client`). Adding the scope to `DIRECTORY_SCOPES` would break every existing Google feature for every customer until they re-authorize.
  - Token storage: none new. The existing encrypted `service_account_key` (`encryptSecret` / `decryptForColumn`) is the only credential. No secret, key or token is logged, audited or stored in evidence. `customer_domain` is never read (inv. 2, F9).
  - Mapping: `unauthorized_client` → `unavailable google_scope_missing`; other 401/403 → `unavailable google_access_denied`; 5xx/timeout → `unavailable google_unavailable`; no connection row → `fail connection_missing`; listed but `verified: false`, or absent → `fail not_in_directory`. Verified `domainAliases[]` count, matched exactly.
- **D9: One home for domains, with no API break.**
  - New org-scoped routes under `/organizations/:id/customer-domains` serve the Domains tab.
  - `/ticket-config/inbound-domains` and the `manage_ticket_config` AI tool stay for API compatibility. They call the same `ticketConfigService` functions, so the trigger covers them.
  - **Governance is unchanged** (spec §5.4, OD7): the org routes use the same gate as ticket-config: `requireScope('partner','system')`, `TICKETS_READ` / `TICKETS_WRITE`, and `canManagePartnerWidePolicies` + platform admin or `*:*` (`ticketConfig.ts:67-76`). Task 7 moves that `adminMiddleware` to `middleware/customerDomainGovernance.ts` and both route files import it.
- **D10: Re-check cadence and revocation** (spec §10 leaves the cadence to the builder; OD4):
  - The worker runs hourly and re-checks verified rows whose `last_checked_at` is older than 23 h, oldest first, at most 100 per run. So each verified row is checked about once a day. The worker has concurrency 1 and rows are checked sequentially; with the 5–10 s timeouts a worst-case run stays under ~17 min, inside the hourly slot.
  - `fail` with a **structural** reason (`tenant_not_proven`, `connection_missing`) clears at once.
  - `fail` with `record_missing` or `not_in_directory` clears on the **second** consecutive failure, so a single DNS blip never revokes.
  - `unavailable` never counts as a failure. But a row with no `pass` for 7 days is cleared with `stale`, so evidence that can no longer be checked does not live forever.
  - `pass` resets `check_failures`, sets `last_passed_at`, and clears nothing.
  - The MSP's "Check now" on a verified row refreshes `last_passed_at` on a pass. A failed manual check is reported but changes no state; the MSP has an explicit **Remove verification** action.
  - Every worker clear writes `organization.portal_identity_proof.domain_cleared` and emails the partner's active admins (one mail purpose, D11).
- **D11: Audit and mail.**
  - Audit (resource type `customer_email_domain`, spec §5.10 `organization.portal_identity_proof.*`):
    - `organization.portal_identity_proof.domain_verified` (`details: { domain, method }`);
    - `organization.portal_identity_proof.domain_displaced` (on the displaced org; `details: { domain, displacedByOrgId }`);
    - `organization.portal_identity_proof.domain_cleared` (`details: { domain, method, reason }`);
    - `organization.portal_identity_proof.domain_removed` (MSP action);
    - `organization.portal_identity_proof.domain_check_failed` (manual check, `details: { domain, method, status, reason }`).
  - The org-scoped CRUD routes keep the existing actions `ticket_customer_email_domain.{create,update,delete}`, now with `orgId` set.
  - Mail purpose `partner.portal_domain_verification.lost`, sent for `domain_cleared` (worker) and `domain_displaced`, through `sendPortalDomainVerificationLost({ to, partnerName, orgName, domain, reason })`. Best effort after commit, like `notifyDisplacedPartner`.
- **D12: DNS record format.**
  - Host `_breeze-verify.<domain>` (`ownershipTxtRecordName`, the same host staff SSO and sending domains use; several TXT records at one name coexist).
  - Value `breeze-verification=<token>` (spec §5.4), distinct from SSO's `breeze-domain-verify=` and the sending-domain raw token.
  - TXT chunks are joined and trimmed before an exact comparison.
  - `ENOTFOUND` / `ENODATA` / an answer without the value → `fail record_missing`. Any other resolver error or the 5 s timeout → `unavailable dns_error|timeout`.

## Open decisions (Todd)

- **OD1: Transfer rule** (D5). Plan default: the incumbent keeps the domain while its live re-check passes. A customer who changes MSP removes the old DNS record or revokes the old Workspace grant. Alternative: newest successful verification wins (W4 D7 style), which makes a stale record a take-back path for a former MSP.
- **OD2: `entra_tenant` for an org proven by proof run with no M365 connection** (D7). Plan default: not available; use DNS or connect M365. Alternative: accept Microsoft's public tenant discovery (`resolveEntraTenantIdFromDomain`, `portalOidc/tenantHint.ts`) returning the proven tenant. Microsoft only resolves a tenant from a domain verified in it, but W4 treated that lookup as a hint, not proof, and spec §5.4 says "read via Graph".
- **OD3: The Entra checker skips the AI Graph-read tools env gate** (D7) for one fixed read, `m365.org.get`. Alternative: keep the gate, so the method is `unavailable` wherever AI Graph tools are not rolled out.
- **OD4: Cadence and thresholds** (D10): daily, two consecutive definitive failures, 7 days without a pass → clear.
- **OD5: `is_active = false` suspends sign-in use too** (D6). The row keeps its verification, so turning it back on needs no re-verify. Alternative: `is_active` governs mail routing only.
- **OD6: The add-in contact-linking rule** (`clientAiEntraAddress.ts:91-103`) keeps accepting declared (unverified) domains, as today. Spec §5.4 says a declared row stays usable "for mail routing only", but that rule links contacts, not accounts, and changing it would break existing add-in contact links. Alternative: require a verified domain there (a separate PR).
- **OD7: Governance gate** (D9). Plan default: unchanged ticket-config gate, including `TICKETS_*` permissions, now on an org settings tab. Alternative: `ORGS_WRITE` + `canManagePartnerWidePolicies`.

## Settings rule 9 statement (copy into both PR bodies)

- **Concept:** customer email domains (declared for mail routing, and verified as proof of ownership).
- **Home:** org settings › **Domains** (new tab, `#domains`). Ticketing › Inbound email keeps a read-only summary that links to each org's tab (spec §5.4, §9 Q3). The Sign-in & registration card shows a read-only Domains row with the same link.
- **Level:** org only. A domain belongs to one customer org; there is no partner default or inheritance.
- **Resolver:** none for settings. Verification facts are read through `listVerifiedDomainsForOrg` / `isDomainVerifiedForOrg` / `findOrgByVerifiedDomain`.
- **Places configured:** before 1 (Ticketing › Inbound email, partner-wide list), after 1 (Organization › Domains). The `/ticket-config/inbound-domains` API and the AI tool are API surfaces, not UI homes.
- **Nav:** no new settings page (a tab inside `pages/settings/organizations/[id].astro`), so `settingsPageRegistry.test.ts` passes unchanged.

## Global Constraints

- **Proof** (inv. 2): no MSP-entered value is proof. The domain string, `customer_domain` (F9) and a tenant hint are claims. Only a live `pass` from a checker writes `verified_at`.
- **Methods and requirements** (spec §5.4 table, consumed by W6/W7): self-registration (approval or instant) needs a verified domain; Sign in with Google needs a verified domain equal to the `hd` claim. Sign in with Microsoft needs a proven tenant (W4) and does **not** read domains.
- **Matching:** domains are compared lowercase and exactly. No suffix or subdomain match anywhere (the existing `resolveOrg.ts` comment says the same).
- **Declared rows:** a row without `verified_at` stays usable for mail routing and the existing contact rule (OD6), and for nothing new.
- **Rate limits** (through `checkRateLimit`, `services/portal/rateLimit.ts`, the Redis limiter W4 uses): `portal-domain-verify:{orgId}:{domainId}`: 10 per hour, block 1 h. They cover both `verification/dns` and `verification/check`.
- **Timeouts:** DNS 5 s; Graph read and Google `domains.list` 10 s. A timeout is `unavailable`.
- **Error codes** (UPPER_SNAKE, `DomainVerificationError`):
  - 404 `CUSTOMER_DOMAIN_NOT_FOUND` (also for a row in another org: no existence oracle);
  - 409 `DOMAIN_VERIFIED_ELSEWHERE`, `DOMAIN_VERIFICATION_CONFLICT_RETRY`, `DOMAIN_INACTIVE`, `DOMAIN_DNS_NOT_STARTED`, `DOMAIN_ALREADY_VERIFIED`.
  - A check that ran but did not pass is **not** an error: it returns 200 `{ result: 'failed' | 'unavailable', reason }`, and the UI renders it inline. Only refusals use 4xx.
- **Migration:** `apps/api/migrations/2027-01-22-2337xx-portal-domain-verification.sql`.
  - **The `xx` is assigned at enqueue.** The file must sort after the newest file on `origin/main`. Today that is `2027-01-22-233500-portal-entra-tenant-proof.sql`.
  - Re-run the `localeCompare` check from `apps/api/migrations/README.md` before every push. If overtaken, rename the file and the test's path constant. Never rename a shipped migration.
  - Idempotent, no inner `BEGIN;/COMMIT;`, first statement `SELECT set_config('breeze.scope', 'system', true);`. Then `pnpm db:check-drift`.
- **Tenancy:** no new table (D1). Export classification for every new column. `verification_token` → `excludedSensitive`; `verified_evidence` (jsonb) → `excludedOpen`; the rest → `included`.
- **Context:** request routes read and write under the caller's context. Anything that touches another partner's row (D5) or runs in the worker uses `withSystemDbAccessContext`, entered from a route via `runOutsideDbContext`. A route that catches `DomainVerificationError` around a query wraps the query in `withDbTransaction` with the catch outside. Never `Promise.all` siblings that open transactions.
- **Web:**
  - Mutations go through `runAction`; new components join `TARGET_GLOBS` in `lib/__tests__/no-silent-mutations.test.ts`.
  - Locale keys go into all 8 locales: `en de-DE es-419 fr-CA fr-FR it-IT pt-BR tr-TR`.
  - Tab state is `window.location.hash` (`#domains`). Tests select by `data-testid`.
- **No infrastructure details** in code, docs or PR bodies. Examples use `contoso.com` and `<your-breeze-domain>`.
- **CPU budget** (host shared with other sessions):
  - Vitest with `--pool=forks --poolOptions.forks.maxForks=4`, on touched files only. For a sweep use `--changed origin/main`.
  - One `tsc` at a time with `NODE_OPTIONS=--max-old-space-size=20480`. Check `echo "exit=$?"`, never `| tail`.
  - No background CI pollers.
- **Commits** end with `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>`.

## Review Focus

1. **The domain changes hands** (feature RF2). Org A (partner P1) verified `contoso.com` by DNS. The customer moves to partner P2 and org B. Expected:
   - If the customer removed A's record, B's verify displaces A: A cleared with `displaced`, B verified, P1's admins emailed, and `findOrgByVerifiedDomain('contoso.com')` returns B on the next call.
   - If A's record is still there, B gets 409 `DOMAIN_VERIFIED_ELSEWHERE` and A keeps it.
   - If A's re-check is `unavailable`, B gets 409 and A keeps it.

   *(Task 5: `displaces an incumbent whose live re-check fails`, `refuses while the incumbent still passes`, `refuses while the incumbent check is unavailable`, `two partners verifying one domain concurrently: one verified, the other 409`.)*
2. **A verified domain is moved to another org of the same partner.** Expected: the PATCH (either route, or the AI tool) clears verification and rotates the token; neither org is verified until the customer publishes the new record. A merge of the two orgs keeps it. *(Task 1: `repointing org_id clears verification and the token`, `org merge keeps verification`. Task 7: `PATCH orgId through /ticket-config clears verification`.)*
3. **A DNS blip.** A single SERVFAIL, timeout or one-off empty answer never revokes. Two consecutive definitive misses do; seven days with no pass does. *(Task 2: `SERVFAIL is unavailable, not fail`. Task 6: `one record_missing keeps verification and counts 1`, `second consecutive record_missing clears with record_missing`, `unavailable for 7 days clears with stale`, `pass resets the failure count`.)*
4. **The evidence source goes away.** The org's Entra tenant proof is removed or displaced, or the Google connection is deleted or recreated. Expected: `isDomainVerifiedForOrg` is false on the next call, and the worker clears the row with `tenant_not_proven` / `connection_missing` on its next pass. *(Task 5: `entra_tenant verification is not current once the tenant proof is removed`, `google_directory verification is not current after the connection is recreated`. Task 6: `structural fail clears at once`.)*
5. **An existing Google connection without the new scope.** Expected: other Google features keep working (they never request the domain scope); the domain check returns `unavailable google_scope_missing` and the UI names the scope to add. *(Task 4: `the domains client requests only the domain scope`, `unauthorized_client maps to google_scope_missing`. Task 8: `DIRECTORY_SCOPES is unchanged`.)*

Invariants re-run as named tests: **2** (Task 5 `customer_domain and tenant hints are never evidence`), **3** (Review Focus 2 and 4), and the spec's "verified for at most one org" (Task 1 `partial unique index refuses a second verified row for the same domain in another partner`).

---

## File structure

| File | Responsibility | PR |
|---|---|---|
| Create `apps/api/migrations/2027-01-22-2337xx-portal-domain-verification.sql`; modify `apps/api/src/db/schema/emailInbound.ts` | Columns, CHECKs, partial unique index, clear-on-repoint trigger | a |
| Modify `services/orgMerge.ts` (GUC in Phase B); create `__tests__/orgMergeGucContract.test.ts` | Merge exemption | a |
| Modify `services/tenantExportPolicyRegistry.ts:384`; create `services/tenantExportPolicyRegistry.portalDomainVerification.test.ts` | Export classification | a |
| Create `services/portalDomainVerification/types.ts` | Methods, evidence, check results, checker interface | a |
| Modify `services/emailDomains/dnsOwnershipProof.ts` (+ test); create `services/portalDomainVerification/checkers/dnsTxt.ts` (+ test) | DNS lookup classification, DNS checker | a |
| Modify `services/m365ControlPlane/readActionService.ts` (+ test); create `checkers/entraTenant.ts` (+ test) | Graph `/organization` read without the AI gate, Entra checker | a |
| Modify `packages/shared/src/constants/googleDwdScopes.ts` (+ test), `services/googleClient.ts` (+ test); create `checkers/googleDirectory.ts` (+ test) | Domain scope, domains client, Google checker | a |
| Create `services/portalDomainVerification/service.ts` (+ `.test.ts`), `services/portalDomainVerification/index.ts`; modify `services/email.ts`, `services/emailDomains/mailPurposes.ts` (+ test) | Record, transfer, remove, re-check, read API, loss email | a |
| Create `services/portalDomainRecheckWorker.ts` (+ test); modify `jobs/scheduleRegistry.ts`, `services/workerRegistry.ts`, `jobs/workerReadinessManifest.ts`, the worker name lists in `workerEntrypointClosure.contract.test.ts` and `workerRegistry.test.ts` | Daily re-check | a |
| Create `middleware/customerDomainGovernance.ts`, `routes/orgCustomerDomains.ts` (+ test); modify `routes/ticketConfig.ts`, `routes/orgs.ts`, `services/ticketConfigService.ts`; modify `packages/shared/src/validators/ticketConfig.ts` (+ test); create `packages/shared/src/types/customerDomains.ts` | Org-scoped CRUD + verification routes, shared types | a |
| Create integration tests `portalDomainVerificationMigration`, `portalDomainVerification`, `portalDomainRecheck` (`*.integration.test.ts`, matched by the `portal[!a-z0-9]*` glob in `.github/scripts/integration-suites.txt`); add `suite portal sources <file>` lines for new imported sources | Real-DB proofs | a |
| Create `apps/web/src/components/settings/orgDomains/{OrgDomainsTab,DomainVerificationPanel,AddDomainForm}.tsx` (+ tests), `orgDomains/types.ts`; modify `components/settings/OrgSettingsPage.tsx`; locale keys | Organization › Domains | b |
| Modify `components/settings/CustomerDomainsCard.tsx`, `InboundEmailCard.tsx`, `portalAccess/OrgSignInRegistrationCard.tsx` (+ tests); `integrations/GoogleWorkspaceIntegration.test.tsx` if it pins the CSV | Read-only summary, card row | b |
| Create `apps/docs/src/content/docs/features/portal-domain-verification.mdx`; modify `features/portal.mdx`, the Google Workspace integration doc; regenerate `apps/api/src/data/docsIndex.json` | Docs | b |

---

## W05a — API

Test commands:
- Unit: from `apps/api`, `npx vitest run --pool=forks --poolOptions.forks.maxForks=4 <file>`. Never `pnpm --filter <pkg> test -- --run <path>`.
- Integration: `pnpm test-stack up`, then `npx vitest run -c vitest.integration.config.ts <file>`. Tear down with `pnpm test-stack down` and say so.
- Shared: from `packages/shared`, `npx vitest run --pool=forks --poolOptions.forks.maxForks=4 <file>`.

### Task 1: Migration, Drizzle columns, merge exemption, export classification, shared types

**Files:**
- Create: `apps/api/migrations/2027-01-22-2337xx-portal-domain-verification.sql`
- Modify: `apps/api/src/db/schema/emailInbound.ts:50-63`. Add the D2 columns: `verificationToken`, `verifiedAt`, `verifiedMethod` (`$type<DomainVerificationMethod>()`), `verifiedEvidence` (`jsonb().$type<DomainVerificationEvidence>()`), `verifiedByUserId`, `lastCheckedAt`, `lastPassedAt`, `lastCheckStatus`, `checkFailures`, `clearedAt`, `clearedReason`. Declare the partial unique index in Drizzle so `db:check-drift` agrees: `uniqueIndex('customer_email_domains_verified_domain_uq').on(sql\`lower(${t.domain})\`).where(sql\`verified_at IS NOT NULL\`)` (`.where` precedent: `db/schema/m365.ts:83`). If drift reports the expression index anyway, follow the README's documented-exception path rather than dropping it from Drizzle.
- Modify: `services/orgMerge.ts`. First statement inside the Phase B `withSystemDbAccessContext` callback (`:1416-1418`, before lock step 0): `await db.execute(sql\`SELECT set_config('breeze.org_merge', 'on', true)\`)`.
- Modify: `services/tenantExportPolicyRegistry.ts:384` per Global Constraints.
- Create: `services/tenantExportPolicyRegistry.portalDomainVerification.test.ts` (the W4 pattern that moves the classification failure into Test API).
- Create: `services/portalDomainVerification/types.ts`.
- Create: `apps/api/src/__tests__/orgMergeGucContract.test.ts`: a source scan that `breeze.org_merge` appears only in `services/orgMerge.ts` and the migration.
- Test: `apps/api/src/__tests__/integration/portalDomainVerificationMigration.integration.test.ts`. Template: `portalEntraTenantProofMigration.integration.test.ts` (replay in a rolled-back superuser transaction).

**Interfaces — Produces** (`services/portalDomainVerification/types.ts`; the schema file imports the first two):

```ts
export type DomainVerificationMethod = 'dns_txt' | 'entra_tenant' | 'google_directory';
export type DomainVerificationEvidence =
  | { via: 'dns_txt'; recordName: string }
  | { via: 'entra_tenant'; tenantId: string; connectionId: string }
  | { via: 'google_directory'; connectionId: string };
export type DomainCheckFailReason = 'record_missing' | 'not_in_directory' | 'tenant_not_proven' | 'connection_missing';
export type DomainCheckUnavailableReason = 'dns_error' | 'timeout' | 'graph_unavailable' | 'graph_tenant_mismatch'
  | 'google_scope_missing' | 'google_access_denied' | 'google_unavailable';
export type DomainCheckResult =
  | { status: 'pass'; evidence: DomainVerificationEvidence }
  | { status: 'fail'; reason: DomainCheckFailReason }
  | { status: 'unavailable'; reason: DomainCheckUnavailableReason };
export type DomainVerificationClearedReason = DomainCheckFailReason | 'stale' | 'repointed' | 'msp_removed' | 'displaced';
export const STRUCTURAL_FAIL_REASONS: ReadonlySet<DomainCheckFailReason>; // tenant_not_proven, connection_missing
export interface DomainCheckTarget { rowId: string; orgId: string; partnerId: string; domain: string; verificationToken: string | null }
export interface DomainVerificationChecker { readonly method: DomainVerificationMethod; check(target: DomainCheckTarget): Promise<DomainCheckResult> }
export type DomainVerificationCheckers = Record<DomainVerificationMethod, DomainVerificationChecker>;
```

- [ ] **Step 1: Write the failing tests**

```ts
describe('2027-01-22-2337xx-portal-domain-verification.sql', () => {
  it('starts with the system-scope line');
  it('refuses verified_method "manual" (23514 customer_email_domains_verified_method_chk)');
  it('refuses verified_at set with verified_method, verified_evidence or last_passed_at NULL, and the reverse (23514 customer_email_domains_verification_shape_chk)');
  it('refuses dns_txt evidence without recordName, entra_tenant without tenantId/connectionId, google_directory without connectionId (23514 customer_email_domains_evidence_chk)');
  it('refuses cleared_at on a verified row (23514 customer_email_domains_cleared_shape_chk)');
  it('partial unique index refuses a second verified row for the same domain in another partner, case-insensitively (23505 customer_email_domains_verified_domain_uq)');
  it('allows two unverified rows for the same domain in different partners');                         // today's behaviour
  it('repointing org_id clears verification and the token, and records cleared_reason repointed');      // inv. 3
  it('repointing an unverified row clears the token and nulls any earlier cleared_at/cleared_reason');
  it('changing only is_active, auto_create_contact or updated_at keeps verification');
  it('org merge keeps verification: an UPDATE of org_id with breeze.org_merge=on in the same transaction');
  it('breeze.org_merge does not leak past the transaction');
  it('deleting the verifying user nulls verified_by_user_id and keeps verification');
  it('is idempotent: a second replay changes nothing');
});
// tenantExportPolicyRegistry.portalDomainVerification.test.ts
it('classifies every customer_email_domains column; verification_token is excludedSensitive, verified_evidence is excludedOpen');
// orgMergeGucContract.test.ts
it('only services/orgMerge.ts sets breeze.org_merge');
```

- [ ] **Step 2: Run them and verify they fail** (ENOENT on the migration path; unclassified columns).
- [ ] **Step 3: Write the migration** (spec of record)

```sql
-- Portal registration W5: domain verification on customer_email_domains (spec §5.4, plan D1–D4).
-- DDL only; system scope first per migrations/README. autoMigrate wraps the file: no BEGIN/COMMIT.
SELECT set_config('breeze.scope', 'system', true);

ALTER TABLE public.customer_email_domains
  ADD COLUMN IF NOT EXISTS verification_token text,
  ADD COLUMN IF NOT EXISTS verified_at timestamptz,
  ADD COLUMN IF NOT EXISTS verified_method text,
  ADD COLUMN IF NOT EXISTS verified_evidence jsonb,
  ADD COLUMN IF NOT EXISTS verified_by_user_id uuid REFERENCES public.users(id) ON DELETE SET NULL,
  ADD COLUMN IF NOT EXISTS last_checked_at timestamptz,
  ADD COLUMN IF NOT EXISTS last_passed_at timestamptz,
  ADD COLUMN IF NOT EXISTS last_check_status text,
  ADD COLUMN IF NOT EXISTS check_failures integer NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS cleared_at timestamptz,
  ADD COLUMN IF NOT EXISTS cleared_reason text;

DO $$
DECLARE t regclass := 'public.customer_email_domains'::regclass;
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conrelid = t AND conname = 'customer_email_domains_verified_method_chk') THEN
    ALTER TABLE public.customer_email_domains ADD CONSTRAINT customer_email_domains_verified_method_chk
      CHECK (verified_method IS NULL OR verified_method IN ('dns_txt','entra_tenant','google_directory'));
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conrelid = t AND conname = 'customer_email_domains_verification_shape_chk') THEN
    ALTER TABLE public.customer_email_domains ADD CONSTRAINT customer_email_domains_verification_shape_chk
      CHECK ((verified_at IS NULL) = (verified_method IS NULL)
         AND (verified_at IS NULL) = (verified_evidence IS NULL)
         AND (verified_at IS NULL) = (last_passed_at IS NULL));
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conrelid = t AND conname = 'customer_email_domains_evidence_chk') THEN
    ALTER TABLE public.customer_email_domains ADD CONSTRAINT customer_email_domains_evidence_chk
      CHECK (verified_method IS NULL
         OR (verified_method = 'dns_txt' AND verified_evidence ? 'recordName')
         OR (verified_method = 'entra_tenant' AND verified_evidence ? 'tenantId' AND verified_evidence ? 'connectionId')
         OR (verified_method = 'google_directory' AND verified_evidence ? 'connectionId'));
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conrelid = t AND conname = 'customer_email_domains_check_status_chk') THEN
    ALTER TABLE public.customer_email_domains ADD CONSTRAINT customer_email_domains_check_status_chk
      CHECK ((last_check_status IS NULL OR last_check_status IN ('pass','fail','unavailable')) AND check_failures >= 0);
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conrelid = t AND conname = 'customer_email_domains_cleared_shape_chk') THEN
    ALTER TABLE public.customer_email_domains ADD CONSTRAINT customer_email_domains_cleared_shape_chk
      CHECK ((cleared_at IS NULL) = (cleared_reason IS NULL)
         AND (cleared_at IS NULL OR verified_at IS NULL)
         AND (cleared_reason IS NULL OR cleared_reason IN
              ('record_missing','not_in_directory','tenant_not_proven','connection_missing','stale','repointed','msp_removed','displaced')));
  END IF;
END $$;

-- D4: a domain is verified for at most one org, platform-wide (crosses partners; RLS does not apply to uniqueness).
CREATE UNIQUE INDEX IF NOT EXISTS customer_email_domains_verified_domain_uq
  ON public.customer_email_domains (lower(domain)) WHERE verified_at IS NOT NULL;

-- D3 / inv. 3: a proof is about ONE org and ONE domain. Any writer that repoints the row
-- (ticket-config PATCH, the AI tool, a future writer) drops it and rotates the DNS token.
-- Org merge sets breeze.org_merge=on for its single Phase B transaction and is exempt.
CREATE OR REPLACE FUNCTION public.customer_email_domains_clear_verification_on_repoint()
RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF (NEW.org_id IS DISTINCT FROM OLD.org_id OR lower(NEW.domain) IS DISTINCT FROM lower(OLD.domain))
     AND coalesce(current_setting('breeze.org_merge', true), '') <> 'on' THEN
    IF OLD.verified_at IS NOT NULL THEN
      NEW.cleared_at := now(); NEW.cleared_reason := 'repointed';
    ELSE
      -- an old org's "verification lost" note must not follow the row to a new org
      NEW.cleared_at := NULL; NEW.cleared_reason := NULL;
    END IF;
    NEW.verification_token := NULL;
    NEW.verified_at := NULL; NEW.verified_method := NULL; NEW.verified_evidence := NULL;
    NEW.verified_by_user_id := NULL; NEW.last_passed_at := NULL;
    NEW.last_check_status := NULL; NEW.check_failures := 0;
  END IF;
  RETURN NEW;
END $$;
DROP TRIGGER IF EXISTS customer_email_domains_clear_verification_on_repoint ON public.customer_email_domains;
CREATE TRIGGER customer_email_domains_clear_verification_on_repoint
  BEFORE UPDATE ON public.customer_email_domains
  FOR EACH ROW EXECUTE FUNCTION public.customer_email_domains_clear_verification_on_repoint();
```

- [ ] **Step 4: Update the Drizzle columns, the export entry, the merge GUC line and `types.ts`.**
- [ ] **Step 5: Run the tests, the migration guards and the drift check**
  - The integration file → PASS.
  - `cd apps/api && npx vitest run --pool=forks --poolOptions.forks.maxForks=4 src/services/tenantExportPolicyRegistry.portalDomainVerification.test.ts src/__tests__/orgMergeGucContract.test.ts src/db/autoMigrate.test.ts src/db/migrationRlsScope.test.ts src/db/migrationPartnerExportLocks.test.ts src/services/orgMerge.test.ts` → PASS. If `migrationPartnerExportLocks` names `customer_email_domains`, add the pre-locks it asks for.
  - `DATABASE_URL=<test-stack url> pnpm db:check-drift` → exit 0.
- [ ] **Step 6: Commit**: `feat(portal): domain verification columns on customer_email_domains, cleared on repoint (W5)`

### Task 2: DNS TXT checker

**Files:**
- Modify: `services/emailDomains/dnsOwnershipProof.ts` (+ `dnsOwnershipProof.test.ts`). Add a classifying lookup next to `verifyDnsOwnershipToken`, using the same injectable resolver. `verifyDnsOwnershipToken` keeps its behaviour.
- Create: `services/portalDomainVerification/checkers/dnsTxt.ts` (+ `dnsTxt.test.ts`).

**Interfaces:**
- Consumes: `DomainVerificationChecker`, `DomainCheckTarget` (Task 1); `ownershipTxtRecordName`, `setDnsTxtResolverForTest`.
- Produces:

```ts
// dnsOwnershipProof.ts
export type TxtLookup = { kind: 'answer'; values: string[] } | { kind: 'absent' } | { kind: 'unavailable'; reason: 'dns_error' | 'timeout' };
/** Joins each record's chunks and trims. ENOTFOUND/ENODATA → absent. Other errors → dns_error. Never throws. */
export async function lookupTxtValues(host: string, timeoutMs?: number /* 5000 */): Promise<TxtLookup>;
// checkers/dnsTxt.ts
export const PORTAL_DOMAIN_TXT_PREFIX = 'breeze-verification=';
export function portalDomainTxtRecord(domain: string, token: string): { recordName: string; recordValue: string };
export const dnsTxtChecker: DomainVerificationChecker; // method 'dns_txt'
```

Rules: a target with `verificationToken === null` → `fail record_missing` (no lookup). Answer containing exactly `breeze-verification=<token>` → `pass { via: 'dns_txt', recordName }`. Absent, or an answer without it → `fail record_missing`.

- [ ] **Step 1: Write the failing tests**

```ts
it('lookupTxtValues joins chunks and trims');
it('ENOTFOUND and ENODATA are absent');
it('SERVFAIL is unavailable dns_error, not absent');                 // Review Focus 3
it('a lookup slower than the timeout is unavailable timeout');
it('passes on breeze-verification=<token> among other TXT records at _breeze-verify.<domain>');
it('fails record_missing on another org\'s token, SSO\'s breeze-domain-verify=<token>, or a raw token');
it('fails record_missing without a lookup when the row has no token');
it('compares the token exactly (case and whitespace inside the value matter)');
```

- [ ] **Step 2: Run them; verify they fail.**
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run both test files → PASS.**
- [ ] **Step 5: Commit**: `feat(portal): DNS TXT checker for customer domain verification (W5)`

### Task 3: Entra tenant checker

**Files:**
- Modify: `services/m365ControlPlane/readActionService.ts` (+ its test). Add `readM365OrganizationForVerification`, sharing the private connection-gate code with `executeM365ReadActionByOrg` (extract a helper; do not copy it).
- Create: `services/portalDomainVerification/checkers/entraTenant.ts` (+ `entraTenant.test.ts`).

**Interfaces:**
- Consumes: `findProvenEntraTenantForOrg` (W4); `m365Connections` schema; Task 1 types.
- Produces:

```ts
// readActionService.ts
export type M365OrganizationRead =
  | { ok: true; tenantId: string; verifiedDomains: string[] }           // names lowercased
  | { ok: false; code: 'no_connection' | 'connection_not_ready' | 'executor_error' | 'timeout' };
/** m365.org.get for the org's customer-graph-read connection bound to `expectedTenantId`. Skips the AI tools env gate (plan D7, OD3); keeps every connection gate. Reads under the ambient context. */
export async function readM365OrganizationForVerification(orgId: string, expectedTenantId: string): Promise<M365OrganizationRead>;
// checkers/entraTenant.ts
export const entraTenantChecker: DomainVerificationChecker; // method 'entra_tenant'
```

Mapping: no proven tenant → `fail tenant_not_proven`; `no_connection` → `fail connection_missing`; `connection_not_ready` / `executor_error` → `unavailable graph_unavailable`; `timeout` → `unavailable timeout`; `tenantId !== proven` → `unavailable graph_tenant_mismatch` (logged at error level); domain in `verifiedDomains` → `pass { via: 'entra_tenant', tenantId, connectionId }`; otherwise `fail not_in_directory`.

- [ ] **Step 1: Write the failing tests**

```ts
it('readM365OrganizationForVerification runs m365.org.get even when M365_GRAPH_READ_TOOLS_ENABLED is off');   // OD3
it('readM365OrganizationForVerification refuses a connection bound to a different tenant (no_connection)');
it('readM365OrganizationForVerification never runs another action type');
it('executeM365ReadActionByOrg still refuses with tools_disabled when the gate is off');                     // unchanged
it('fails tenant_not_proven when the org has an unproven mapping only');                                   // inv. 2
it('fails connection_missing for a tenant proven by proof run with no M365 connection');                   // OD2
it('passes when the domain is in verifiedDomains, case-insensitively');
it('fails not_in_directory for a subdomain of a verified domain');
it('fails not_in_directory for the tenant\'s initial *.onmicrosoft.com domain even though it is in verifiedDomains');
it('is unavailable graph_tenant_mismatch when /organization returns another tenant id');
it('is unavailable on executor error and on timeout');
```

- [ ] **Step 2: Run them; verify they fail.**
- [ ] **Step 3: Implement.** Inject the executor client the same way `readActionService.test.ts` does. No test reaches `graph.microsoft.com`.
- [ ] **Step 4: Run both test files → PASS.**
- [ ] **Step 5: Commit**: `feat(portal): Entra tenant checker reads verified domains of the proven tenant (W5)`

### Task 4: Google directory checker

**Files:**
- Modify: `packages/shared/src/constants/googleDwdScopes.ts` (+ `googleDwdScopes.test.ts`). Add `DIRECTORY_DOMAIN_SCOPES`; append it to `GOOGLE_DWD_SCOPES_CSV`; do **not** touch `DIRECTORY_SCOPES`.
- Modify: `services/googleClient.ts` (+ `googleClient.test.ts`). Add `getDirectoryDomainsClient`.
- Create: `services/portalDomainVerification/checkers/googleDirectory.ts` (+ `googleDirectory.test.ts`).

**Interfaces:**
- Consumes: `loadGoogleConnection(orgId)`, `decryptConnectionKey(conn)`, `normalizeGoogleError(err)`; Task 1 types.
- Produces:

```ts
export const DIRECTORY_DOMAIN_SCOPES: readonly ['https://www.googleapis.com/auth/admin.directory.domain.readonly'];
export function getDirectoryDomainsClient(decryptedKeyJson: string, adminEmail: string): admin_directory_v1.Admin; // JWT scopes = DIRECTORY_DOMAIN_SCOPES only
export const googleDirectoryChecker: DomainVerificationChecker; // method 'google_directory'
```

Rules (D8): call `domains.list({ customer: 'my_customer' })` with a 10 s timeout. Match `domainName` with `verified === true`, or any `domainAliases[]` entry with `verified === true`, exactly and lowercase. `pass` evidence is `{ via: 'google_directory', connectionId }`. Never read or log `customer_domain`, the key or the token.

- [ ] **Step 1: Write the failing tests**

```ts
// shared
it('DIRECTORY_SCOPES is unchanged (six scopes, no domain scope)');                     // Review Focus 5
it('GOOGLE_DWD_SCOPES_CSV includes admin.directory.domain.readonly exactly once');
// googleClient
it('the domains client requests only the domain scope and impersonates adminEmail');
// checker
it('passes on a verified primary or secondary domain');
it('passes on a verified domain alias');
it('fails not_in_directory on verified: false, and on an absent domain');
it('fails connection_missing when the org has no Google connection');
it('ignores customer_domain: a connection whose customer_domain equals the domain still fails when the directory omits it'); // inv. 2
it('unauthorized_client maps to unavailable google_scope_missing');
it('403 maps to google_access_denied; 5xx and timeout map to google_unavailable');
```

- [ ] **Step 2: Run them; verify they fail.**
- [ ] **Step 3: Implement.** Mock `@googleapis/admin` as `googleClient.test.ts` does. No test reaches Google.
- [ ] **Step 4: Run the shared and API test files → PASS. If `GoogleWorkspaceIntegration.test.tsx` pins the CSV, update it in this task.**
- [ ] **Step 5: Commit**: `feat(portal): Google Directory domains checker with a domain-only DWD scope (W5)`

### Task 5: Verification service, transfer rule, read API, loss email

**Files:**
- Create: `services/portalDomainVerification/service.ts`, `service.test.ts` (unit, fake checkers + mocked db), `services/portalDomainVerification/index.ts` (re-exports the public API; the checkers stay internal).
- Modify: `services/email.ts`. Add `sendPortalDomainVerificationLost(params)`. Template: `sendPortalEntraTenantDisplaced` (`email.ts:702`).
- Modify: `services/emailDomains/mailPurposes.ts` (+ test). Register `'partner.portal_domain_verification.lost'` on the lane `'partner.portal_entra_tenant.displaced'` uses.
- Test (real DB): `__tests__/integration/portalDomainVerification.integration.test.ts`.

**Interfaces:**
- Consumes: Task 1 types and columns; `dnsTxtChecker`, `entraTenantChecker`, `googleDirectoryChecker` (Tasks 2–4) as the default `DomainVerificationCheckers`; `findProvenEntraTenantForOrg`; `listActivePartnerAdmins`; `generateOwnershipToken`; `portalDomainTxtRecord`.
- Produces (`services/portalDomainVerification/index.ts`):

```ts
export type CustomerDomainState = 'declared' | 'pending_dns' | 'verified';
export interface CustomerDomainView {
  id: string; orgId: string; domain: string; isActive: boolean; autoCreateContact: boolean;
  state: CustomerDomainState; method: DomainVerificationMethod | null; verifiedAt: string | null;
  lastCheckedAt: string | null; lastPassedAt: string | null; lastCheckStatus: 'pass' | 'fail' | 'unavailable' | null;
  clearedAt: string | null; clearedReason: DomainVerificationClearedReason | null;
  dnsRecord: { recordName: string; recordValue: string } | null;   // set while a token exists
  usableForSignIn: boolean;                                         // = isVerificationCurrent (D6)
}
export type DomainVerificationErrorCode = 'CUSTOMER_DOMAIN_NOT_FOUND' | 'DOMAIN_VERIFIED_ELSEWHERE'
  | 'DOMAIN_VERIFICATION_CONFLICT_RETRY' | 'DOMAIN_INACTIVE' | 'DOMAIN_DNS_NOT_STARTED' | 'DOMAIN_ALREADY_VERIFIED';
export class DomainVerificationError extends Error { constructor(readonly code: DomainVerificationErrorCode, readonly httpStatus: 404 | 409, message: string); }
export type VerifyCustomerDomainOutcome =
  | { result: 'verified'; method: DomainVerificationMethod; displacedOrgId: string | null }
  | { result: 'failed'; reason: DomainCheckFailReason }
  | { result: 'unavailable'; reason: DomainCheckUnavailableReason };

/** Request context (partner-axis RLS). */
export async function listOrgCustomerDomains(orgId: string): Promise<CustomerDomainView[]>;
/** Issues the token if null (idempotent); request context. */
export async function startDnsVerification(orgId: string, domainId: string): Promise<{ recordName: string; recordValue: string }>;
/** Runs checks outside any transaction, then writes under system scope (D5). Call from a route via runOutsideDbContext. */
export async function verifyCustomerDomain(
  input: { orgId: string; partnerId: string; domainId: string; method: DomainVerificationMethod; actorUserId: string },
  deps?: { checkers?: DomainVerificationCheckers; now?: Date },
): Promise<VerifyCustomerDomainOutcome>;
export async function removeCustomerDomainVerification(orgId: string, domainId: string, actorUserId: string): Promise<{ removed: boolean }>;
/** Worker entry; system scope. Applies D10. */
export async function recheckCustomerDomain(rowId: string, deps?: { checkers?: DomainVerificationCheckers; now?: Date }):
  Promise<{ status: 'pass' | 'fail' | 'unavailable'; cleared: DomainVerificationClearedReason | null }>;

// ---- Read API for W6/W7 (index cross-wave table). All re-check evidence at use (D6). System scope; never inside a request transaction. ----
export interface VerifiedDomainFact { domain: string; orgId: string; partnerId: string; method: DomainVerificationMethod; verifiedAt: Date }
export async function isDomainVerifiedForOrg(domain: string, orgId: string): Promise<boolean>;
export async function findOrgByVerifiedDomain(domain: string): Promise<VerifiedDomainFact | null>;
export async function listVerifiedDomainsForOrg(orgId: string): Promise<VerifiedDomainFact[]>;
```

Rules for `verifyCustomerDomain`:
1. Load the row by `id`, `org_id` and `partner_id` (any mismatch → `CUSTOMER_DOMAIN_NOT_FOUND`). `is_active = false` → `DOMAIN_INACTIVE`. Verified with a **different** method → `DOMAIN_ALREADY_VERIFIED` (remove the verification first). `dns_txt` with no token → `DOMAIN_DNS_NOT_STARTED`.
   - **Refresh path (D10 "Check now").** Verified with the **same** method: run the checker; `pass` sets `last_checked_at = last_passed_at = now`, `last_check_status 'pass'`, `check_failures 0` and returns `verified` with `displacedOrgId: null`; `fail` / `unavailable` sets only `last_checked_at` / `last_check_status`, audits `domain_check_failed` and returns the result. No incumbent lookup, no transfer logic.
2. Run the chosen checker. `fail` → audit `domain_check_failed`, set `last_checked_at` / `last_check_status`, return `failed`. `unavailable` → the same with `unavailable`. Neither touches `check_failures` or a verified row's state (D10).
3. `pass`: look up an incumbent (system scope): a verified row for `lower(domain)` with a different `id`. If one exists, run **its** checker live (no transaction).
4. Transaction (system scope): advisory lock (D5), re-read both rows `FOR UPDATE`.
   - Incumbent present, `verified_at` unchanged, its check `pass` or `unavailable` → `DOMAIN_VERIFIED_ELSEWHERE`.
   - Incumbent `verified_at` changed since step 3, **or** no incumbent existed at step 3 but one exists now → `DOMAIN_VERIFICATION_CONFLICT_RETRY` (no write; the next click re-runs both checks).
   - Incumbent check `fail` → clear it (`cleared_reason 'displaced'`), audit `domain_displaced` on its org.
   - Write this row: `verified_at = now`, `verified_method`, `verified_evidence`, `verified_by_user_id`, `last_checked_at = last_passed_at = now`, `last_check_status 'pass'`, `check_failures 0`, `cleared_* NULL`. Audit `domain_verified`.
   - 23505 on `customer_email_domains_verified_domain_uq` → `DOMAIN_VERIFIED_ELSEWHERE`.
5. After commit, for a displacement: email the displaced partner's active admins (reason `displaced`). A send failure is logged and never undoes anything.

`removeCustomerDomainVerification` clears the verification columns (`cleared_reason 'msp_removed'`), keeps the token, and audits `domain_removed`.

- [ ] **Step 1: Write the failing tests**

```ts
// unit (fake checkers)
it('a fail never writes verified_at and audits domain_check_failed');
it('unavailable leaves a verified row verified and check_failures unchanged');
it('DOMAIN_DNS_NOT_STARTED for dns_txt without a token; DOMAIN_INACTIVE for an inactive row');
it('a row in another org of the same partner is CUSTOMER_DOMAIN_NOT_FOUND');
it('customer_domain and tenant hints are never evidence: no checker reads them');                 // inv. 2 (source scan of checkers/)
// integration (real DB, breeze_app + superuser seeding)
it('dns_txt pass verifies the row with evidence and audits domain_verified');
it('startDnsVerification is idempotent and returns _breeze-verify.<domain> / breeze-verification=<token>');
it('displaces an incumbent whose live re-check fails: cleared displaced, audits on both orgs, P1 admins emailed after commit'); // RF1
it('refuses while the incumbent still passes (409 DOMAIN_VERIFIED_ELSEWHERE), nothing written');              // RF1
it('refuses while the incumbent check is unavailable');                                                      // RF1
it('two partners verifying one domain concurrently: one verified, the other 409');                           // RF1, D5
it('an email failure after displacement keeps both writes');
it('removeCustomerDomainVerification clears with msp_removed and keeps the token');
it('isDomainVerifiedForOrg is false for a declared row, an inactive verified row and another org');
it('findOrgByVerifiedDomain matches case-insensitively and never matches a subdomain');
it('entra_tenant verification is not current once the tenant proof is removed');                            // RF4
it('google_directory verification is not current after the connection is recreated');                       // RF4
it('listVerifiedDomainsForOrg returns only current verifications');
```

- [ ] **Step 2: Run them; verify they fail.**
- [ ] **Step 3: Implement the service, the email method and the mail purpose.**
- [ ] **Step 4: Run** the unit file, the integration file, `src/services/emailDomains/mailPurposes.test.ts`, `src/__tests__/dbTransactionPromiseAll.contract.test.ts` and `src/__tests__/parkedFanout.contract.test.ts` → PASS.
- [ ] **Step 5: Commit**: `feat(portal): customer domain verification service, transfer rule and read API (W5)`

### Task 6: Re-check worker

**Files:**
- Create: `services/portalDomainRecheckWorker.ts` (+ `portalDomainRecheckWorker.test.ts`, template `warrantyWorker.test.ts`).
- Modify: `jobs/scheduleRegistry.ts` (new key `'portal-domain-recheck'`, hourly, a free minute slot that `scheduleRegistry.contract.test.ts` accepts), `services/workerRegistry.ts` (a `placement: 'global'` entry next to `ssoDomainRecheckWorker`), `jobs/workerReadinessManifest.ts`, and the name lists in `workerEntrypointClosure.contract.test.ts` and `workerRegistry.test.ts`.
- Test (real DB): `__tests__/integration/portalDomainRecheck.integration.test.ts`.

**Interfaces:**
- Consumes: `recheckCustomerDomain` (Task 5).
- Produces:

```ts
export const PORTAL_DOMAIN_RECHECK_QUEUE = 'portal-domain-recheck';
export const PORTAL_DOMAIN_RECHECK_BATCH = 100;
export const PORTAL_DOMAIN_RECHECK_MIN_AGE_HOURS = 23;
export const PORTAL_DOMAIN_STALE_DAYS = 7;
export async function runPortalDomainRecheck(deps?: { now?: Date; checkers?: DomainVerificationCheckers }): Promise<{ checked: number; cleared: number }>;
export async function initializePortalDomainRecheckWorker(): Promise<void>;
export async function shutdownPortalDomainRecheckWorker(): Promise<void>;
```

`recheckCustomerDomain` applies D10 (in Task 5's file, tested here end to end): `pass` → reset; structural `fail` → clear at once; other `fail` → increment, clear at 2; `unavailable` → no count; then, if not cleared and `last_passed_at < now − 7 d` → clear `stale`. Each clear audits `domain_cleared` and emails the partner's admins after commit. Rows are processed one at a time; one row's error is logged and does not stop the batch.

- [ ] **Step 1: Write the failing tests**

```ts
it('selects only verified rows last checked more than 23 h ago, oldest first, at most 100');
it('one record_missing keeps verification and counts 1');                          // RF3
it('second consecutive record_missing clears with record_missing and emails the partner admins'); // RF3
it('structural fail (tenant_not_proven, connection_missing) clears at once');      // RF4
it('unavailable for 7 days clears with stale');                                   // RF3
it('pass resets the failure count and refreshes last_passed_at');                 // RF3
it('an error on one row does not stop the batch');
it('registers a repeatable job with jobSchedule("portal-domain-recheck")');
```

- [ ] **Step 2: Run them; verify they fail.**
- [ ] **Step 3: Implement the worker and the registrations.**
- [ ] **Step 4: Run** the worker test, the integration file, `scheduleRegistry.contract.test.ts`, `workerEntrypointClosure.contract.test.ts`, `workerRegistry.test.ts` → PASS.
- [ ] **Step 5: Commit**: `feat(portal): daily re-check of verified customer domains (W5)`

### Task 7: Org-scoped domain routes, governance middleware, shared types

**Files:**
- Create: `middleware/customerDomainGovernance.ts`. Move `adminMiddleware` from `routes/ticketConfig.ts:67-76` here as `requireCustomerDomainGovernance`; `ticketConfig.ts` imports it (behaviour unchanged).
- Create: `routes/orgCustomerDomains.ts` (+ `orgCustomerDomains.test.ts`), exporting `registerOrgCustomerDomainRoutes(orgRoutes)`; call it in `routes/orgs.ts` next to `registerPortalEntraTenantRoutes`.
- Modify: `services/ticketConfigService.ts`. `listCustomerEmailDomains` returns the verification view fields (additive); add an `orgId` filter parameter used by the org route. **`create` / `update` / `list` return an explicit column projection** (the `CustomerDomainView` shape), never the whole row: today's `.returning()` (`~:960`, `~:996`) would hand `verification_token` and `verified_evidence` to the ticket-config API and to the `manage_ticket_config` AI tool.
- Modify: `packages/shared/src/validators/ticketConfig.ts` (+ test). Add `verifyCustomerDomainSchema = z.object({ method: z.enum(['dns_txt','entra_tenant','google_directory']) }).strict()`.
- Create: `packages/shared/src/types/customerDomains.ts`. Move `CustomerDomainView` and the method/reason unions here and re-export from the API types file, so web and API share them.

**Interfaces — Produces** (all under `/api/v1/organizations/:id/customer-domains`; gate per D9, plus "the org belongs to the caller's partner"):

| Method + path | Body | Response |
|---|---|---|
| `GET /` | — | `{ data: CustomerDomainView[] }` |
| `POST /` | `{ domain, autoCreateContact? }` (`createCustomerEmailDomainSchema` minus `orgId`, which comes from the path) | 201 `{ data: CustomerDomainView }`; 409 `DOMAIN_ALREADY_MAPPED` (existing) |
| `PATCH /:domainId` | `updateCustomerEmailDomainSchema` (may move `orgId`; D3 clears) | `{ data: CustomerDomainView }` |
| `DELETE /:domainId` | — | 204 |
| `POST /:domainId/verification/dns` | — | `{ data: { recordName, recordValue } }` |
| `POST /:domainId/verification/check` | `verifyCustomerDomainSchema` | `{ data: VerifyCustomerDomainOutcome }`; 404 / 409 per `DomainVerificationError` |
| `DELETE /:domainId/verification` | — | `{ data: { removed } }` |

The two verification POSTs apply the rate limit. `verification/check` calls `verifyCustomerDomain` through `runOutsideDbContext`, after the request-context read that proves the row belongs to this org.

- [ ] **Step 1: Write the failing tests**

```ts
it('every route returns 403 without canManagePartnerWidePolicies and for org-scoped callers');   // governance unchanged
it('GET lists only this org\'s domains with verification state');
it('POST takes orgId from the path, never the body');
it('PATCH orgId on a verified row clears verification (via the trigger)');                          // RF2
it('PATCH orgId through /ticket-config clears verification');                                      // RF2, D9
it('a domain id from another org of the same partner is 404 CUSTOMER_DOMAIN_NOT_FOUND');
it('verification/check returns 200 result failed/unavailable without a 4xx');
it('verification/check maps DomainVerificationError to its status and code, never a 500');
it('verification/check is rate limited per org and domain');
it('/ticket-config/inbound-domains list rows carry the verification fields (additive)');
it('no CRUD response (org route, /ticket-config, manage_ticket_config) contains verification_token or verified_evidence');
it('a PATCH body carrying verifiedAt, verifiedMethod or verificationToken writes none of them');   // inv. 2
```

- [ ] **Step 2: Run them; verify they fail.**
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run** the route test, `routes/ticketConfig.test.ts`, `services/aiToolsTicketConfig.test.ts`, the shared validator test → PASS.
- [ ] **Step 5: Commit**: `feat(portal): org-scoped customer domain and verification routes (W5)`

### Task 8: W05a gate

- [ ] **Step 1: Typecheck and sweep**

```bash
NODE_OPTIONS=--max-old-space-size=20480 pnpm exec tsc --build apps/api/tsconfig.tests.json; echo "exit=$?"   # exit=0
cd packages/shared && npx tsc --noEmit; echo "exit=$?"
cd apps/api && npx vitest run --pool=forks --poolOptions.forks.maxForks=4 --changed origin/main
cd apps/api && npx vitest run --pool=forks --poolOptions.forks.maxForks=4 src/services/orgMerge.test.ts src/__tests__/
```

- [ ] **Step 2: Integration and contract suites.** Run every integration file from Tasks 1–7, plus:
  - `customerEmailDomainsRls`, `resolveOrg`, `loginContactLinking`, `portalOidcSignIn` (they seed this table; new NOT NULL columns have defaults, so they must pass unchanged);
  - `tenantCascade`, `orgMergeRegistry`, `orgLifecycleFoundations`;
  - `tenant-export-policy`, `tenantExportErasureRoundtrip`;
  - `DB_CONTEXTLESS_WRITE_STRICT=true pnpm --filter=@breeze/api test:rls-coverage`;
  - `pnpm --filter @breeze/api test:integration-suite-coverage`. Add `suite portal sources <file>` lines for each newly imported source it names (likely `services/portalDomainVerification/*`, `services/portalDomainRecheckWorker.ts`, `routes/orgCustomerDomains.ts`, `middleware/customerDomainGovernance.ts`, `services/emailDomains/dnsOwnershipProof.ts`).
- [ ] **Step 3: Migration slot.** `git fetch origin main` and the `localeCompare` check from the migrations README. Rename if overtaken.
- [ ] **Step 4: Review.** One independent review round (`superpowers:requesting-code-review`) and the advisor quorum on D1–D12. Then `pnpm test-stack down` and say so.
- [ ] **Step 5: Open the PR.** Body: `Part of #11382`; the rule-9 statement; D1–D12; OD1–OD7 as resolved; the note that existing Google connections need the new scope only for the `google_directory` method.

---

## W05b — Web + docs

### Task 9: Organization › Domains tab

**Files:**
- Create: `apps/web/src/components/settings/orgDomains/OrgDomainsTab.tsx`, `DomainVerificationPanel.tsx`, `AddDomainForm.tsx`, `types.ts` (re-exports from `@breeze/shared` `types/customerDomains`), with `*.test.tsx` for each component.
- Modify: `components/settings/OrgSettingsPage.tsx`. Add `'domains'` to `TabKey` (`:61`), an item in the `organization` group of `TAB_GROUPS` (`:68`, after `contacts`), and a `case 'domains'` in `renderContent` (`:646`). Show the tab only to callers who pass the governance gate; use the same signal `TicketingSettingsTabs.tsx:39-43` uses for its partner-only tab, and hide it otherwise.
- Locale keys in all 8 locales: `orgSettingsPage.nav.domains`, `orgSettingsPage.nav.domainsDescription`, and an `orgDomains.*` block.

**Interfaces:**
- Consumes: the Task 7 routes and `CustomerDomainView`.
- Produces: `OrgDomainsTab({ orgId }: { orgId: string })`; `DomainVerificationPanel({ orgId, domain, onChanged }: { orgId: string; domain: CustomerDomainView; onChanged(): void })`.

Behaviour:
- A table: domain, state badge (`declared — mail routing only` / `pending DNS` / `verified · DNS|Microsoft|Google`), last checked, active toggle, auto-create-contact toggle, row actions (verify, remove verification, move to another org, delete).
- The verify panel offers the three methods:
  - DNS shows the record name and value with copy buttons (`data-testid="domain-dns-record-name"`, `"domain-dns-record-value"`) and a **Check now** button;
  - Microsoft is disabled with the reason when the org has no proven tenant or no M365 connection (OD2), linking to `#portal`;
  - Google is disabled when the org has no Google connection; a `google_scope_missing` result names the scope to add.
- A cleared row shows `clearedReason` in words ("Verification lost: record not found", "…: verified by another organization", …).
- Moving a verified domain to another org asks for confirmation that names the loss of verification.
- Every mutation goes through `runAction`. A `failed` / `unavailable` result renders inline in the panel, not as a toast error.

- [ ] **Step 1: Write the failing tests**

```ts
it('lists domains with state badges');
it('DNS method shows record name/value and Check now posts verification/check with method dns_txt');
it('a failed check renders the reason inline and no error toast');
it('Microsoft is disabled with a link to #portal when the org has no proven tenant');
it('moving a verified domain asks for confirmation naming the verification loss');
it('#domains selects the tab; the tab is hidden for callers without domain governance');
```

- [ ] **Step 2: Run them; verify they fail.**
- [ ] **Step 3: Implement; add the components to `TARGET_GLOBS`; fan the locale keys out (Sonnet-eligible).**
- [ ] **Step 4: Run** the new tests, `no-silent-mutations.test.ts`, the locale parity tests, `keyUsage.test.ts`, `humanizedKeyRegression.test.ts`, `OrgSettingsPage` tests → PASS.
- [ ] **Step 5: Commit**: `feat(web): Organization › Domains tab with DNS, Microsoft and Google verification (W5)`

### Task 10: Read-only Ticketing summary and the card's Domains row

**Files:**
- Modify: `components/settings/CustomerDomainsCard.tsx` (+ test). Remove the create/edit/delete UI. Keep a read-only list (domain, org, state badge), each row linking to `/settings/organizations/{orgId}#domains`, plus one sentence: "Domains are managed per organization."
- Modify: `components/settings/InboundEmailCard.tsx` if its copy refers to editing domains here.
- Modify: `components/settings/portalAccess/OrgSignInRegistrationCard.tsx` (+ test). Add the spec §4 Domains row: verified domains with their method, declared ones marked "declared — mail routing only", and a link to `#domains`. It reads `GET /organizations/:id/customer-domains`. That route has the domain-governance gate (D9), stricter than the card's `ORGS_READ` routes, so **on 403 the row is hidden** (no error toast) and the rest of the card renders.
- Locale keys in all 8 locales.

- [ ] **Step 1: Write the failing tests**

```ts
it('CustomerDomainsCard renders no add, edit or delete controls');
it('each summary row links to the org\'s #domains tab');
it('the Sign-in & registration card lists verified and declared domains and links to #domains');
it('the card hides the Domains row without a toast when customer-domains returns 403');
```

- [ ] **Step 2: Run them; verify they fail.**
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run** the tests plus `no-silent-mutations.test.ts` and the locale tests → PASS.
- [ ] **Step 5: Commit**: `feat(web): Ticketing inbound domains become a read-only summary; card Domains row (W5)`

### Task 11: Docs, browser check, W05b gate

**Files:**
- Create: `apps/docs/src/content/docs/features/portal-domain-verification.mdx`: why verify, the three methods (DNS record format; Microsoft needs a proven tenant and an M365 connection; Google needs the `admin.directory.domain.readonly` scope in the DWD grant), re-check and what clears a verification, moving domains, and "a domain is verified for one organization; ask the previous provider to remove theirs" (D5).
- Modify: `features/portal.mdx` (link it), the Google Workspace integration doc (the new scope), and any doc that says domains are edited under Ticketing.
- Regenerate the index from the repo root with `npx tsx scripts/build-docs-index.ts`.

Steps:
- [ ] **Step 1:** Write the docs and regenerate the index. Sonnet-eligible.
- [ ] **Step 2: Browser check** with the `feature-testing` skill on a `worktree-stack`. Use a test DNS resolver override or seed `verified_at` by SQL for the verified states. Check: the Domains tab lists, adds and deletes; DNS start shows the record; the Ticketing summary is read-only and links to the tab; the card shows the Domains row. Tear the stack down and say so.
- [ ] **Step 3: Lab leg (optional, Todd's call).** A real `_breeze-verify` TXT record on a lab domain verifies and, once removed, clears after two worker passes. A lab Workspace with the new scope verifies its primary domain.
- [ ] **Step 4: Gate.** `astro check` and web `tsc` exit 0; `npx vitest run --pool=forks --poolOptions.forks.maxForks=4 --changed origin/main` green in `apps/web`; API docs-index tests green; one independent review round. PR body: `Closes #11382`, the rule-9 statement, screenshots of the tab, the panel and the read-only summary.
- [ ] **Step 5: Commit**: `docs(portal): verifying customer domains (W5)`

---

## Execution split and parallelism

**W05a (API)**
- **SERIAL first:** T1. The migration and `types.ts` gate everything else.
- **PARALLEL GROUP A1 (file-disjoint):**
  - **T2** (`dnsOwnershipProof.ts`, `checkers/dnsTxt.ts`);
  - **T3** (`readActionService.ts`, `checkers/entraTenant.ts`);
  - **T4** (`googleDwdScopes.ts`, `googleClient.ts`, `checkers/googleDirectory.ts`);
  - **T5** (`service.ts`, `index.ts`, `email.ts`, `mailPurposes.ts`). Its unit and integration tests use fake checkers, so it does not wait for T2–T4. It wires the real checkers as defaults once they land (a one-line import each).
- **PARALLEL GROUP A2** (after A1):
  - **T6** (worker + registrations);
  - **T7** (middleware, routes, `ticketConfigService.ts`, shared validators and types).
- **SERIAL last:** T8 gate.
- **Sonnet-eligible:** T2; T4's scope constant and test; T5's email template and mail purpose; T6's schedule/registry/manifest edits; T7's CRUD routes and the middleware move.
- **Opus:** T1 (migration, trigger, merge GUC), T3, T4's checker mapping, T5's transfer rule and read API, T6's D10 logic, T7's verification routes, review of all Sonnet output.

**W05b (Web + docs)**, branched from fresh main after W05a merges
- **SERIAL first:** T9. It holds the shared-type import and most locale keys.
- **SERIAL:** T10 after T9 (both touch locale files).
- **SERIAL last:** T11.
- **Sonnet-eligible:** T9's locale fan-out, T10, T11 docs.
- **Opus:** T9's verification panel, review of T10.

## CI traps

- **Premise:** W4a and W4b are on main (`findProvenEntraTenantForOrg`, `organization.portal_identity_proof.*`, the card). Re-check every W4 name in the Interfaces blocks against main before T1.
- **Export policy.** All 11 new `customer_email_domains` columns must be classified. `tenant-export-policy` and `tenantExportErasureRoundtrip` fail only under Integration Tests, never Test API; the Task 1 unit test moves the failure earlier.
- **Merge.** The trigger exemption is proven only by the real-DB merge path. Run `orgMerge.test.ts` and the merge integration suite (T8). If Phase B ever splits into two transactions, the GUC must be set in each.
- **Google scopes.** Adding the domain scope to `DIRECTORY_SCOPES` instead of a separate client breaks every Google feature for existing customers (`unauthorized_client` on the whole token request). T4's shared test pins `DIRECTORY_SCOPES`.
- **M365 tools gate.** `executeM365ReadActionByOrg` is gated by an env allowlist that is off in tests and in most deployments. The new function must not route through `toolsGateRefusal` (OD3), and the existing function must keep refusing.
- **System context inside a request.** `verifyCustomerDomain` and the read API use system scope. Call them through `runOutsideDbContext`; a nested `withSystemDbAccessContext` inside the request transaction stalls or throws "context already held".
- **Caught queries.** A route that catches `DomainVerificationError` around a query needs the query inside `withDbTransaction` with the catch outside, or a 409 becomes a 500 at commit. Never `Promise.all` (`dbTransactionPromiseAll.contract.test.ts`).
- **Network I/O in transactions.** Checkers run before the write transaction (D5). A checker call inside `withDbTransaction` holds the advisory lock across a 10 s timeout.
- **No network in tests.** Inject the DNS resolver (`setDnsTxtResolverForTest`), the Graph executor client and the Google client. A test that reaches a real resolver or API hangs CI.
- **Workers.** A new worker needs `scheduleRegistry` (unique slot), `workerRegistry`, `workerReadinessManifest`, and the name lists in `workerEntrypointClosure.contract.test.ts` and `workerRegistry.test.ts`.
- **New service files.** `parkedFanout.contract.test.ts` must not discover them (none reads `devices`). Run `src/__tests__/` in T8.
- **Integration suite map.** New `portal*.integration.test.ts` files match the existing glob; newly imported sources need `suite portal sources <file>` lines, or `test:integration-suite-coverage` fails.
- **Seeded tests.** Several integration files insert `customer_email_domains` rows. The new columns are nullable or defaulted, so inserts stay valid; a test that asserts the full row shape needs the new keys.
- **Migration slot.** The slot is assigned at enqueue. A sibling migration landing first poisons the merge queue (Check Migrations). Run `pnpm db:check-drift`.
- **Typecheck heap.** API `tsc` needs a 20 GB heap. Check `exit=$?`, never `| tail`.
- **Web.** `no-silent-mutations` `TARGET_GLOBS`, 8-locale parity, `keyUsage.test.ts` (dynamic keys such as cleared reasons need a static `Record` + `/* i18n-dynamic */`), `humanizedKeyRegression.test.ts`.
- **Docs index.** Changing any `.mdx` without regenerating `docsIndex.json` fails the docs-index test.
- **No infrastructure details** in docs or PR bodies.

## W6 and W7 consumption (interface only)

W6 (self-registration) and W7 (Google sign-in) must use only the Task 5 read API. They never query `customer_email_domains` directly, and never read `verified_at` without D6's evidence check.
- **W6, async match (spec §5.9 step 3):** `findOrgByVerifiedDomain(emailDomain)` → `null` means "not eligible", with the same response and timing as eligible (inv. 8). A hit is eligible only if `resolvePortalAccessPolicy(fact.orgId).effective.selfRegistrationMode !== 'off'`.
- **W6, link consume (§5.9 "the policy is re-checked"):** `isDomainVerifiedForOrg(emailDomain, token.orgId)` again at consume time, so a domain cleared between email and click fails.
- **W6, custom-domain host (§5.9):** show **Request access** only if the host org has self-registration on **and** `listVerifiedDomainsForOrg(hostOrgId).length > 0`.
- **W6/W7, policy masking:** if W6 or W7 mask `selfRegistrationMode` / `googleEnabled` by "has a verified domain" (like W4 D2's tenant mask), they add a `facts.verifiedDomainCount` from `listVerifiedDomainsForOrg`. The W3 resolver has no cache, so no invalidation hook is needed.
- **W7 (§5.8):** `findOrgByVerifiedDomain(hd)` must return an org with `googleEnabled`. The verification method does not matter: a DNS-verified domain proves the `hd` as well as a directory-verified one.

## Out of scope

- **W6:** self-registration and the public request form.
- **W7:** Google OIDC sign-in and the Google OAuth web client env.
- **OD6:** making add-in contact linking require a verified domain.
- Automatic verification of pending DNS rows by the worker (the MSP clicks **Check now**).
- AI tool actions for verification (`manage_ticket_config` keeps CRUD only).
- IDN / punycode domains beyond what `customerDomainSchema` already accepts.

## Self-review

1. **Spec coverage (§7 W5 row, §5.4):**
   - Verification columns → T1.
   - DNS method → T2/T5; Entra method on the proven tenant → T3/T5; Google directory method (not `customer_domain`) → T4/T5.
   - Re-check job → T6. Clear on repoint/delete/failure → T1 (trigger), T5 (remove, displacement), T6 (lapse).
   - At most one org platform-wide → T1 (index), T5 (transfer).
   - Declared rows stay mail-routing-only → Global Constraints, D6 (the read API ignores them).
   - UI home Organization › Domains, Ticketing read-only summary → T9/T10. Governance unchanged → D9/T7.
   - Card Domains row (§4) → T10. Docs (§8) → T11. Invariants 2 and 3 → named tests in T3/T4/T5/T1/T7.
2. **Step scan:** every code step names its file and signature; the migration SQL is given in full as the spec of record; route, service, worker and component bodies are left to the implementer.
3. **Type consistency.** Used identically across T1–T11:
   - types: `DomainVerificationMethod`, `DomainVerificationEvidence`, `DomainCheckResult`, `DomainCheckFailReason`, `DomainCheckUnavailableReason`, `DomainVerificationClearedReason`, `DomainVerificationChecker`, `DomainVerificationCheckers`, `CustomerDomainView`, `VerifyCustomerDomainOutcome`, `VerifiedDomainFact`, `DomainVerificationError`;
   - functions: `lookupTxtValues`, `portalDomainTxtRecord`, `readM365OrganizationForVerification`, `getDirectoryDomainsClient`, `listOrgCustomerDomains`, `startDnsVerification`, `verifyCustomerDomain`, `removeCustomerDomainVerification`, `recheckCustomerDomain`, `isDomainVerifiedForOrg`, `findOrgByVerifiedDomain`, `listVerifiedDomainsForOrg`, `runPortalDomainRecheck`.
4. **Review Focus:** all five lines have named tests in their owning tasks (T1, T2, T4, T5, T6, T7).
5. **Proportion:** decisions, interfaces, the migration and test names; no transcribed bodies.
