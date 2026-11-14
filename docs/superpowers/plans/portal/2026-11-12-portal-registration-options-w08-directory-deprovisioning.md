---
tracking_issue: LanternOps/breeze#11377
---

# Portal Registration W8: Directory Deprovisioning (Entra complete snapshots, Google Directory) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** When a customer disables or deletes a person in Microsoft Entra, or suspends or deletes them in Google Workspace, sign-in through that person's directory identity stops. If nothing else lets them into the portal, their account is disabled too. A partial, failed or odd directory read never disables anyone. Enforcement is report-only until an operator turns it on, and the first enforced batch for each directory is an MSP decision. Every disable is audited, and the MSP can reverse it.

**Architecture:**
- **Disable, never delete.** `portal_user_identities` gains a disabled state with independent **blockers** (`entra_directory`, `google_directory`, `scim`, `msp`). A disabled identity keeps its `(issuer, subject)` reserved, so the same person cannot come back as a "new person". Every reader that turns an identity into access refuses a disabled one, and it checks this under the account lock. One shared writer, `disablePortalIdentity`:
  - adds a blocker;
  - applies the spec §5.11 account rule (disable the account when it has no other usable credential);
  - bumps `auth_epoch`;
  - purges browser and add-in sessions;
  - audits.

  W9 (SCIM) reuses this writer.
- **Evidence, fenced at the source.**
  - **Entra.** The evidence is captured inside the M365 sync's post-completion hook, under the sync's own generation fence. That is the only moment the `m365_users` cache is exactly one complete snapshot. Only runs that the sync itself marks complete count, and only for the org's proven tenant.
  - **Google.** The evidence is a new daily Directory API pass that must page to the end. It is anchored on the impersonated admin's own record.
  - **Absence.** Absence counts only for an identity that an earlier complete snapshot of the **same directory incarnation** showed present. It needs two complete snapshots at least 4 h apart. A single complete snapshot that says "disabled" or "suspended" is enough.
- **Circuit breakers.**
  - A snapshot that shrank sharply is suspect until a second snapshot confirms it.
  - A run is held whole for MSP approval when it would disable too many accounts, too large a share, or most of a small org.
  - The first enforced run with actions in each directory chain is always held.
  - Apply carries an impact digest and an evidence-age limit.
- **Report-only first.** `PORTAL_DIRECTORY_DEPROVISION_ENFORCE` defaults to off, following the repo's retention `*_ENFORCE` pattern. In report mode every run is evaluated and recorded with its planned actions, which the MSP sees as a preview. Nothing is disabled.
- **Evaluation inline, application in a job.**
  - Entra evaluation (read evidence, update observations, record planned actions) runs in the sync hook. It is one short transaction, its throws are swallowed, and it is bounded by a 5 s lock timeout.
  - Applying disables, sending email and retrying purges run in a dedicated BullMQ queue, `portal-directory-deprovision`, with an hourly recovery sweep. Google evaluation runs in that queue too.
  - This is spec §10's builder's call. Evaluating anywhere other than the hook would read a cache that a later run is already rewriting (quorum D2).

**Tech Stack:** Hono, Drizzle (queries only), one hand-written SQL migration, PostgreSQL forced RLS, BullMQ + Redis, `googleapis` Admin SDK (domain-wide delegation), the M365 Graph read executor, Astro + React (web), Vitest (unit plus `vitest.integration.config.ts`), Playwright MCP for the browser check.

**Spec:** `docs/superpowers/specs/portal/2026-11-07-portal-registration-options-design.md`. Relevant sections:
- §1 ("Leavers matter just as much as new joiners") and §3 G7;
- §5.1, the transition table. Deprovisioning and SCIM move accounts `active ↔ disabled`. Reactivating an account with no credential returns it to `invited`;
- §5.2, the identity key and `linked_via`;
- §5.6 step 1, where a known identity resolves its account;
- **§5.11 "Directory deprovisioning (W8)", all of it**, and "SCIM (W9)" for the boundary;
- §6 invariants 4, 5, 9, 10 and **12**: "Deprovisioning acts only on complete snapshots, never reverses an MSP disable, and bumps epoch and purges sessions (browser and add-in)";
- §7, the W8 row;
- §10: "whether deprovisioning runs inline after sync or as its own BullMQ job" is left to the builder. See D10.

The wave index is `2026-11-08-portal-registration-options-index.md`. This wave owns feature Review Focus 5: "A partial or failed directory sync. It never disables anyone."

**Builds on (all merged on `main` at `e74da81df7`):**
- **W2/W3:**
  - `portal_user_identities` (`db/schema/portal.ts:213-229`):
    - columns `id, org_id, portal_user_id, provider, issuer, subject, entra_tenant_id, linked_via, last_used_at, created_at`;
    - uniques `(issuer, subject)` and `(portal_user_id, provider)`;
    - registered in `tenantCascade.ts:920`, `orgMergeRegistry.ts:1229` and `tenantExportPolicyRegistry.ts:790`.
  - `services/portalUserIdentities.ts`: `portalUserHasIdentitySql()`, `findPortalUserIdByIdentity`, `findPortalUserIdByEntraIdentity`, `insertEntraIdentity`, `ensureEntraIdentity` (`:188`; inserts the identity, or touches `last_used_at`), `linkPortalUserIdentity` and `reconcilePortalUserIdentities` (report-only).
  - `services/portalAccountState.ts`:
    - `PortalAccountWriter`, and `PortalAccountFacts { status, browserAccess, authMethod, hasPasswordHash, hasExternalIdentity }`;
    - `planPortalAccountTransition`: `msp_disable` gives `{ disabled, bumpEpoch: true }` at `:198`; `msp_reactivate` tests `hasPasswordHash || hasExternalIdentity` at `:214`.
  - The writer census `__tests__/portalAccountWriters.contract.test.ts`.
  - The daily drift job `jobs/portalIdentityReconcile.ts`.
- **W4:**
  - `services/portalEntraTenantProof.ts`: `findProvenEntraTenantForOrg(orgId) → { tenantId, provenAt } | null` (`:180`). It takes no lock. The approval path's `lockProvenEntraTenant` (`services/portalAccessRequests.ts:502`) is the `FOR SHARE` fence to copy.
  - `services/portalOidc/accountResolution.ts`: step 1 `resolveKnownIdentity` (`:290`) reads the identity in one transaction and locks the account later. The quorum found the race in this gap (D3).
  - The MSP disable in `routes/orgPortalUsers.ts:583-618`:
    1. `planOrRefuse(…, 'msp_disable')`;
    2. a route-local `stateSet` that applies `authEpoch + 1`;
    3. `purgePortalSessionsForUsers` (`routes/portal/helpers.ts:592`) and `purgeClientAiSessionsForUsers(redis, ids)` (`services/clientAiSessionStore.ts:12`).
  - Link status lives in `routes/portal/oidcShared.ts:280`. Add-in identity counts and pickers live in `routes/clientAi/adminOrgs.ts:110`.
- **W5:**
  - `checkers/googleDirectory.ts` maps errors this way: `unauthorized_client` → `google_scope_missing`; 401/403 → `google_access_denied`; anything else → `google_unavailable`.
  - `checkers/googleBinding.ts` computes `sha256(adminEmail \n serviceAccountEmail)`.
  - `notifyVerificationLost` emails partner admins after commit and never throws. It uses `listActivePartnerAdmins` and the mail purpose `partner.portal_domain_verification.lost` (lane `platform`).
- **W7:** Google identities use `PORTAL_GOOGLE_ISSUER`, with subject = `sub`. `signInProviders.ts` defines `PortalIdentityKey`.
- **M365 sync (outside the portal code):**
  - `m365_users` (`db/schema/m365Sync.ts:122-160`):
    - `graph_id` is the Entra object id; `account_enabled` is nullable.
    - `is_stale` and `stale_since` are set only by complete runs (`domains/persist.ts:48-56`). Persist commits **per 1 000-row chunk**.
    - Stale rows are hard-deleted after 30 days.
  - `m365_sync_state` holds one row per `(org_id, domain)`:
    - `run_generation` is incremented at claim (`m365Sync/claim.ts:129`);
    - `last_complete_snapshot_at`, `truncated`, `last_item_count`, `last_status`;
    - the completion writer is guarded on `run_generation` (`run.ts:387-426`).
  - A run is complete when `complete = primaryOk && !result.truncated` (`domains/users.ts:232`). The executor's users action reports `truncated` for the stop reasons `max_pages | max_items | paused | deadline | interrupted`. It **silently drops users with no string `id`** (`apps/m365-graph-read-executor/src/microsoft/syncActions.ts:270-277`) while still reporting complete.
  - `afterDomainPersisted(ctx & { domain, outcome, persisted })` (`m365Sync/hooks.ts:30`) runs after the completion commit, with no DB context held. `run.ts` swallows its throws. It is called on every terminal outcome, never on continuation pages.
  - Disconnect (`m365Sync/lifecycle.ts:104-115`) hard-deletes the org's `m365_users` and `m365_sync_state` rows. It **keeps the connection row** (`m365ControlPlane/connectionService.ts:1366`). Re-consent bumps `m365_connections.consent_generation` (`connectionService.ts:1182`).
  - Executable connections are `active` or `degraded` (`lifecycle.ts:33`). `customer-graph-read` holds `User.Read.All` as an application permission (`packages/shared/src/m365/profiles.ts:105-119`).
- **Google:**
  - `google_workspace_connections` has one row per org: a service account with domain-wide delegation, impersonating `admin_email`. It stores no Workspace customer id.
  - `DIRECTORY_SCOPES` (`packages/shared/src/constants/googleDwdScopes.ts:9`) already contains `https://www.googleapis.com/auth/admin.directory.user`.
  - `services/googleClient.ts` has `getDirectoryClient` (all six scopes) and W5's `getDirectoryDomainsClient` (one scope). A JWT that asks for a scope the grant lacks fails as a whole.
  - `loadGoogleConnection` and `decryptConnectionKey` live in `services/googleHelpers.ts`.
- **Patterns:**
  - Retention report/enforce: `jobs/retentionTarget.ts` and `jobs/retentionBatch.ts:154` (`retentionEnforceFromEnv`). A job payload can force report mode but never enforce.
  - Daily repeatable jobs: `jobs/scheduleRegistry.ts`, `services/workerRegistry.ts`, `jobs/workerReadinessManifest.ts`; template `jobs/portalIdentityReconcile.ts`.
  - Impact digests: `services/portalSsoOnly.ts:28`.
  - Background audit: `createAuditLog` (`services/auditService.ts:110`, `actorType: 'system'`).

**Rigor: high.** This wave disables real customers' access automatically. It touches:
- the auth readers and the account state machine;
- a migration on two org-cascade tables, plus two new org tables;
- background reads of customer directories;
- the M365 sync hook and its executor;
- the add-in exchange.

Full TDD, one independent review round per PR, and contract and integration suites before each PR. The advisor quorum is recorded below.

## PR split

| PR | Tasks | Branch | Body | Depends on |
|---|---|---|---|---|
| **W08a: API + jobs** | 1–9 | `feature/11377-portal-registration/wave-11385` | `Part of #11385` (never `Closes`) | W4, W5, W7 merged (they are) |
| **W08b: Web + docs + lab leg** | 10–12 | `feature/11377-portal-registration/wave-11385-b` | `Closes #11385` | W08a **merged to main**. Branch from fresh main; do not stack (a stacked PR runs no CI). |

**W08a ships report-only.** `PORTAL_DIRECTORY_DEPROVISION_ENFORCE` is unset in every region, so on deploy:
- Complete Entra users snapshots and the daily Google pass are evaluated and recorded as runs with `reported` actions. Nothing is disabled, no session is purged, and no email is sent.
- The reader changes (a disabled identity is refused) are inert, because nothing writes a disabled identity in report mode.
- The executor's malformed-item rule (Task 6) changes the M365 sync too: a users run with a malformed or duplicated id becomes `partial`, so it marks nobody stale. Say this in the PR.
- New outbound load: one paginated Workspace `users.list` plus one `users.get` per day, for each Google-connected org with at least one Google identity.

**Rollout (operator gate, not code).** ENFORCE is set per region only when all of these hold:
1. W08b is deployed, so the MSP preview and Restore exist.
2. The production deploy's version-parity check shows **every** serving API instance on a W08 build. An older reader could mint a current-epoch session for a disabled identity.
3. At least 14 days of report-mode runs have been reviewed (Task 12 Step 4).
4. The owed live checks pass. Google enforcement additionally needs G1.

Even then, the first enforced run with actions in each directory chain is held for the MSP (D8).

## Decisions taken in this plan (flag in each PR body)

- **D1: Disable the identity; never delete it.**
  - New columns on `portal_user_identities`:
    - `disabled_at timestamptz`;
    - `disabled_reason text`, the reason of the **first** blocker (`account_disabled | absent | suspended | archived | scim_deactivated | msp`);
    - `disabled_blockers text[] NOT NULL DEFAULT '{}'`, a subset of `{entra_directory, google_directory, scim, msp}`.
  - CHECK `(disabled_at IS NULL) = (cardinality(disabled_blockers) = 0) AND (disabled_at IS NULL) = (disabled_reason IS NULL)`.
  - `scim` and `msp` are reserved for W9 and a later MSP action. W8 writes only the directory blockers.
  - The row stays, which keeps `(issuer, subject)` reserved. The person cannot return through §5.6 step 4 as a new person, and the history stays readable.
  - **Blockers, not one source** (quorum D9). Suppose W8 disables an identity and SCIM later deactivates it too. With a single source column, SCIM's write would be an idempotent no-op, and a directory restore would silently lift SCIM's intent. With blockers, each source adds its own. MSP Restore is the only universal clear: its dialog lists every blocker, and it removes them all at once. A future SCIM `active: true` (W9's decision) can remove only the `scim` blocker.
  - Rejected: deleting the identity. That frees `(issuer, subject)`, so the leaver's next sign-in becomes a new-person request, or a fresh account in `instant` mode. It is also irreversible.
  - Rejected: deleting the account. That loses its contact binding and ticket history over a mistake that should be one click to undo.
  - **Disabling is not removing.** The W3 D4 legacy fence (identity-removing writers clear `portal_users.entra_*`) does not fire, so the columns stay until the cleanup wave drops them. A grep-based test in Task 2 pins that no production auth path reads them.
- **D2: The account rule, and who disabled the account** (spec §5.11 "Effect"; invariant 12; quorum D9).
  - After the identity is disabled, the account is disabled **only if** it has no other usable credential. That means both:
    - no other identity with `disabled_at IS NULL`, and
    - no usable password: a hash, `isPasswordEligible`, and an effective `password_mode = 'allowed'`.
  - New column `portal_users.disabled_by text` (`msp | directory | scim`), with CHECK `(status = 'disabled') = (disabled_by IS NOT NULL)`. The migration backfills `msp` for every existing `disabled` row, since only MSP writers disable today. The constraint is added `NOT VALID` and validated after the backfill. W9 needs this provenance to honour "an MSP disable beats a SCIM activate", and the MSP panel shows it.
  - New state-module writer `directory_deprovision`:
    - from `active` or `invited` → `{ status: 'disabled', disabledBy: 'directory', browserAccess unchanged, bumpEpoch: true }`;
    - from `disabled` it is a no-op. The account keeps its `disabled_by`, so an MSP-set disable stays the MSP's (spec).
  - `msp_disable` sets `disabledBy: 'msp'`. Every transition out of `disabled` clears it.
  - **Every** identity disable bumps `auth_epoch`, even when the account stays active through its password (the W4 rule). After commit come `purgePortalSessionsForUsers([id])` and `purgeClientAiSessionsForUsers(redis, [id])`. The epoch is authoritative; a purge failure is retried by the recovery sweep (D10).
  - **The password survives** under `allowed`. That is the spec's rule, and the quorum stresses what it means: a leaver whose identity is disabled can still sign in with that password. The preview tags such actions "keeps password access", the docs separate disabling a sign-in method from offboarding a person, and OD4 lets the operator change the rule.
- **D3: Readers refuse a disabled identity, under the account lock** (quorum D1).
  - **Lock order: account, then identity**, everywhere a decision depends on both. That covers sign-in, the add-in exchange, link, invite consume, `disablePortalIdentity` and Restore.
    - `disablePortalIdentity` takes the account `FOR UPDATE`, then the identity `FOR UPDATE`.
    - A sign-in that will mint a session holds the account `FOR SHARE`. In the same transaction it re-reads its identity's `disabled_at` and the account's `auth_epoch`.
    - Outcome either way: the sign-in sees the disable and refuses, or the disable waits for it and bumps the epoch, so the session it minted dies on its next request.
    - Two concurrent disables on one account serialize. The second re-reads the identities, and the first's disable now counts, so neither can count the other as usable.
  - §5.6 step 1 (`resolveKnownIdentity`) and the idempotent link branch: a disabled identity ⇒ new deny reason `identity_disabled`. The portal shows the generic `unavailable`, and the audit row names the reason. The flow never falls through to steps 2–4. The early check stays as a fast path; the authoritative check is the one under the lock.
  - The add-in exchange (`clientAiExchange.ts`), including its conflict recovery: a disabled identity ⇒ the same 401 as an unknown user, before any session is minted. `ensureEntraIdentity` returns `'disabled'` and writes nothing for a disabled row.
  - Invite-bound (step 2), link (step 3), approving an SSO access request and the add-in JIT insert all still treat **any** identity row as a reservation. The `(issuer, subject)` and `(portal_user_id, provider)` constraints keep refusing (`identity_conflict`).
  - Display readers say "disabled" instead of implying the method is usable: link status (`oidcShared.ts:280`), the profile's connected-accounts list, and the add-in admin counts and pickers (`adminOrgs.ts:110`, which counts enabled identities and shows disabled ones separately).
  - **Two identity facts, named apart:**
    - `portalUserHasIdentitySql()` keeps meaning "any identity row" (identity-managed). Bulk invite and password invites still never target a directory-managed account, disabled or not.
    - New `portalUserHasUsableIdentitySql()` means `disabled_at IS NULL`.
    - `PortalAccountFacts` gains `hasUsableExternalIdentity` and `passwordUsable` (hash, eligibility, and effective `allowed`).
    - `msp_reactivate` tests `passwordUsable || hasUsableExternalIdentity`. Without a usable credential the account returns to `invited` (spec §5.1). This also changes reactivation under `sso_only`, which the quorum accepted; a test pins it.
    - The account rule, the `sso_only` stranded list and `sso_only` hash clearing all use the usable fact. A hash is never cleared on an account whose only identity is disabled.
    - Task 2 classifies every call site with a contract test: `routes/portal/capabilityTokens.ts:334`; `routes/orgPortalUsers.ts:83, 521, 664, 667`; `services/portalSsoOnly.ts:163, 169`; `services/contacts/portalInvite.ts:287`; `services/portalAccountState.ts:135, 157, 214`.
- **D4: The Entra snapshot is captured at the one moment the cache is exact** (quorum D2, which disagreed with the draft and is resolved by adopting its fix).
  - **Why not a queued job reading `m365_users` later.** Persist commits each 1 000-row chunk separately. A later run can rewrite part of the cache and then fail, while `last_complete_snapshot_at` still names the earlier run. A job queued for run A would then read run B's partial data. `REPEATABLE READ` freezes the database, not the directory snapshot.
  - **Capture in the hook, fenced by generation.** `afterDomainPersisted` calls `captureEntraDirectoryRun(ctx)` for `domain === 'users'`, as its **last** step, with its own try/catch. In one `REPEATABLE READ` transaction, with `SET LOCAL lock_timeout = '5s'`, it takes `m365_sync_state(org, 'users')` `FOR SHARE` and requires `run_generation = ctx.generation` and `last_complete_snapshot_at = ctx.now`.
    - `run_generation` is incremented at claim (`claim.ts:129`), and the completion writer needs that row. A newer run therefore cannot have persisted a chunk (it would have bumped the generation) and cannot complete while the capture runs.
    - A mismatch ⇒ nothing recorded.
  - **The capture reads only what it needs.**
    - the org's in-scope identities;
    - their `m365_users` rows, by `graph_id = ANY(subjects)`;
    - `count(*) WHERE NOT is_stale` as the directory size.

    It then evaluates (D6) and writes the run, the observation updates and the planned actions in the same transaction. Applying, email and purges happen later in the job (D10), so the hook never sends mail or touches Redis.
  - **A complete run, as W8 counts it.** All of these hold:
    1. `persisted.complete`, which is the sync's own definition: primary source ok, no page or item cap, no pause, deadline or interruption.
    2. **The executor dropped nothing** (Task 6). The users action reports `malformedItems`, counting users with a non-string `id` and duplicate ids, and the API counts the run complete only when that is 0.
    3. The connection is the org's `customer-graph-read` connection, its status is `active` or `degraded`, and it is not revoked.
    4. Its `tenant_id` equals both `ctx.tenantId` and the org's **proven** tenant. Mismatch ⇒ run `skipped (tenant_mismatch)`; unproven ⇒ `skipped (tenant_not_proven)`. The sync tenant and the proven tenant live in different tables, and nothing else compares them.
    5. The org and its partner are active (`getActiveOrgTenant`); otherwise the run is `skipped (org_inactive)`.
  - A non-complete users run of an org with in-scope identities records an `incomplete` run. The reason is `directory_too_large` when `last_item_count >= M365_SYNC_MAX_ITEMS_USERS`, otherwise `sync_incomplete`. Above-cap tenants therefore show a visible "deprovisioning unavailable" state, and the docs name SCIM (W9) as the fallback.
  - **What each cache state means:**
    - Present = a row with `is_stale = false`.
    - Absent = no row, or `is_stale = true`. Only complete runs produce either, and a stale row hard-deleted after 30 days is still absent.
    - `account_enabled IS NULL` = present but unknown: no action, though it **does** reset the absence count (quorum D3).
  - **Disconnect never deprovisions.** It does not call the hook; it deletes the cache; and the chain's incarnation (D5) changes on re-consent.
- **D5: Membership before absence; two spaced complete snapshots; a real chain incarnation.**
  - Observation columns on `portal_user_identities`:
    - `directory_chain text`
    - `directory_seen_at timestamptz` (first time seen present in a complete snapshot of that chain)
    - `directory_absent_runs smallint NOT NULL DEFAULT 0`
    - `directory_absent_since timestamptz`
    - `directory_last_run_id uuid` (deduplication)
    - `directory_rearm_since timestamptz`
  - **Chain key** (quorum D3: disconnect keeps the connection row, so a connection id alone does not change on reconnect):
    - Entra: `entra:<tenantId>:<connectionId>:<consentGeneration>:<orgId>`.
    - Google: `google:<customerId>:<connectionId>:<binding>:<orgId>`. `binding` is W5's `googleBinding`; `customerId` comes from the admin anchor (D11).
    - Any change resets the observation (`seen_at`, `absent_*` cleared). That covers re-consent, a tenant change, a recreated or re-bound Google connection, a different Workspace, and an org merge (the org id is in the key).
  - **Per evaluated snapshot, for each in-scope identity whose `directory_last_run_id` is not this run:**
    - Present and **disabled** (Entra `account_enabled = false`; Google `suspended` or `archived`) ⇒ action, with reason `account_disabled`, `suspended` or `archived`. One snapshot suffices: it is the directory's affirmative statement about that object.
    - Present, any other value (enabled or unknown) ⇒ `seen_at` is set if null, and `absent_runs` and `absent_since` are cleared. `rearm_since` is cleared only if the person is **enabled** and the snapshot is newer than `rearm_since`.
    - Absent, and `seen_at` set for this chain ⇒ `absent_runs + 1`, with `absent_since` set on the first one.
    - Action, reason `absent`, when `absent_runs >= 2` and `snapshotAt − absent_since >= 4 h`. The spacing covers Graph replication delay and quick delete-and-restore.
    - Absent, and never seen present in this chain ⇒ never acted on for absence.
  - **Why membership first.** An org's identities need not all live in the directory being read. A Google identity whose `hd` was verified by DNS can belong to a different Workspace than the org's Google connection. An add-in Entra identity can predate the M365 connection. "Not in this directory" means "left" only for someone the directory once listed.
  - **In-scope identities:**
    - Entra: `provider = 'entra'`, `entra_tenant_id` equal to the run's tenant, `org_id` equal to the run's org, and `disabled_at IS NULL`.
    - Google: `provider = 'google'`, `org_id` equal to the run's org, and `disabled_at IS NULL`.
  - `directory_rearm_since` set ⇒ the identity is evaluated and listed, but never acted on (D9).
  - Skipped intermediate snapshots are not invented. A snapshot that was not captured simply does not exist. "Two consecutive" means two consecutive **captured** complete snapshots, with the spacing rule on top. The quorum's concern (an unseen present observation between two absences) only weakens evidence that already shows the object absent twice, at least 4 h apart.
- **D6: Impact guards** (quorum D4; the numbers are in OD2). These limit damage. They are not completeness proofs, which D4 and D5 carry.
  - **Shrink guard.** A complete snapshot whose directory size is below 80% of the previous **evaluated** snapshot in the chain is recorded `suspect_shrink`, with no actions and no observation changes. The next complete snapshot evaluates normally only if its size is within ±5% of the suspect one. Otherwise it is compared against the last evaluated snapshot again.
  - **Batch hold.** Count **distinct accounts affected** (`affected`) against the org's **currently usable in-scope identities** (`usable`; already-disabled identities never dilute it). The run is held whole when any of these is true:
    - `affected >= 3 && affected * 10 > usable`;
    - `affected > 25`;
    - `affected >= 2 && affected * 2 >= usable` (small orgs: two of two, two of three).
- **D7: Report mode** (the repo's retention pattern; quorum D5).
  - `PORTAL_DIRECTORY_DEPROVISION_ENFORCE` accepts `true | 1 | false | 0`. Unset means false. Any other value means **false** with a startup warning: fail toward report-only. It is read through `retentionEnforceFromEnv`, and `config/validate.ts` warns.
  - Report mode records the run and its actions (`status 'reported'`, disposition `reported`) and updates observations. It applies nothing and writes no per-action audit.
  - Reported runs are immutable. When enforcement turns on, nothing reported is applied: the next evaluated run decides afresh, and D8(c) holds it.
  - A job payload can force report mode, never enforce. Apply and Dismiss refuse in report mode (`409 PORTAL_DIRECTORY_ENFORCEMENT_OFF`), so the preview can never become a second enforcement path.
- **D8: Hold, apply, dismiss** (quorum D4).
  - (a) **Hold.** Over a D6 threshold in enforce mode ⇒ every action is `held` and the disposition is `held`. This writes one `portal.directory.run.held` audit row and sends one partner-admin email (D12).
  - (b) **Auto-apply.** Under the thresholds in enforce mode ⇒ disposition `applying`. The worker's `apply-run` job applies each action, and the recovery sweep re-enqueues any `applying` run older than 15 min.
  - (c) **First enforcement per chain.** In enforce mode, a run with at least one action is held when no earlier run **in the same chain** reached `applied` or `held_applied`. Microsoft's first batch never authorizes Google's, and a re-consented connection (a new incarnation) starts over.
  - (d) **Apply.** `POST …/runs/:runId/apply { impactDigest }`, accepted only while all of these hold, otherwise `409 PORTAL_DIRECTORY_RUN_STALE`:
    - the run is `held`;
    - no newer `evaluated` run exists in its chain;
    - it is at most **72 h** old;
    - its chain's org id equals the run's org (false after a merge);
    - `impactDigest` equals the stored digest. The digest is sha256 over the sorted `(actionId, identityId, effect, keepsPassword)` tuples, shown in the preview.
  - Each action then re-checks, under the D3 locks:
    - the connection incarnation, the proof (`FOR SHARE` on the tenant mapping, the `lockProvenEntraTenant` pattern) or the Google connection binding;
    - that the org is active;
    - that the identity is still enabled and still in the chain, and has no `rearm_since`;
    - that its observation still supports the action.

    A failure marks the action `skipped` with a reason. The disposition becomes `held_applied`.
  - (e) **Dismiss** rejects these observations; it is not a silent loop. Every held action becomes `skipped (dismissed)`, and each identity's `directory_rearm_since` is set to now. That person is reported, not proposed, until a newer snapshot shows them enabled. No repeat batch and no repeat email follow. The panel shows "dismissed by your team".
  - (f) **Supersede.** A newer evaluated run in the chain marks the previous run's still-held actions `superseded`.
  - (g) **Serialization.** Capture, evaluation, apply, dismiss and Restore serialize per `(org, source)` with `pg_advisory_xact_lock(hashtext('portal-directory:' || org_id || ':' || source))`, taken before the D3 row locks. Each action is its own transaction, so a crash mid-batch leaves the applied actions applied and the rest for the recovery sweep.
- **D9: Restore (reversibility; quorum D8).**
  - `POST /organizations/:id/portal-users/:portalUserId/identities/:identityId/restore { reactivateAccount: boolean, confirmMspDisabled?: boolean }`. One transaction, under the D3 lock order:
    1. Clear every blocker and `disabled_*`.
    2. Set `directory_rearm_since = now` and `directory_absent_runs = 0`.
    3. Mark the identity's latest applied action `restored`.
    4. With `reactivateAccount` and a `disabled` account, run `msp_reactivate`. It needs the revised usable-credential fact (D3), so with no usable credential the account returns to `invited`.
    5. An account with `disabled_by = 'msp'` is reactivated only with `reactivateAccount: true` **and** `confirmMspDisabled: true` (the dialog's second confirmation, which names the MSP disable); otherwise 409 `PORTAL_ACCOUNT_MSP_DISABLED_CONFIRM`.
    6. Audit `organization.portal_user.identity.restore`. Reactivation also writes the existing `organization.portal_user.update`.
  - **`rearm_since` is an explicit, possibly indefinite exemption** while the directory keeps reporting the person disabled or absent. The panel says so ("restored by your team; the directory still reports this person disabled"). Only a complete snapshot taken after `rearm_since` that shows the person enabled clears it. An older queued snapshot never re-arms.
  - Re-enabling the person in Entra or Google never restores anything (spec).
- **D10: Jobs** (spec §10's builder's call; quorum omissions 1 and 3).
  - **Entra evaluation is inline in the sync hook** (D4), because nowhere else is the cache exact. Its cost is bounded: one transaction, reads only in-scope rows, a 5 s lock timeout, and it is the hook's last step, with its own catch, so a throw cannot skip the posture rollup.
  - **Queue `portal-directory-deprovision`** (worker concurrency 2) carries:
    - `apply-run` (`jobId portal-dir-apply-<runId>`), enqueued after commit by any run with disposition `applying`, and by an MSP Apply;
    - `google-sweep` (daily repeatable, `scheduleRegistry` key `portal-directory-google`, a free minute in the daily ≡3 (mod 5) lane), which fans out `google-org` (`jobId portal-dir-google-<orgId>-<utcDate>`) for each org with an executable Google connection **and** at least one enabled Google identity;
    - `recover` (hourly repeatable, key `portal-directory-recover`), which does three things:
      - re-enqueues `applying` runs older than 15 min;
      - retries purges for applied actions whose `sessions_purged_at` is null within 24 h;
      - prunes old runs.
  - Job ids contain no colons. `attempts: 3`, backoff 1/5/15 min, `removeOnComplete: true`, `removeOnFail: { age: 7 * 86400 }`.
  - **Durability.** The run row is the outbox. An `applying` run whose enqueue failed is picked up by `recover`. A capture that failed (the hook swallowed it) loses only that snapshot. The next complete snapshot captures again, and D5 never invents the missing one.
  - Code lives under `services/portalDirectory/`, so it falls in the portal integration-suite glob (`services/portal*`).
- **D11: The Google directory read** (quorum D7).
  - New `getDirectoryUsersReader(decryptedKeyJson, adminEmail)` in `services/googleClient.ts`. Its JWT asks for **only** `https://www.googleapis.com/auth/admin.directory.user`, a scope already in `DIRECTORY_SCOPES` and in every connection's delegation grant, so no customer re-consents. The wrapper exposes only `getUser(userKey)` and `listUsersPage(pageToken)`; the write-capable client never leaves the module. See OD6.
  - Rejected: `admin.directory.user.readonly`. Every customer would have to edit the grant first, and until then every Google org reads `scope_missing` (the W5 D8 lesson).
  - Rejected: `getDirectoryClient`. It asks for six scopes, and one missing grant fails the read.
  - **The admin anchor.** First, `users.get({ userKey: adminEmail, fields: 'id,customerId,isAdmin,suspended' })`. It must return `isAdmin === true` and `suspended !== true`, otherwise `incomplete (admin_not_admin)`. Its `customerId` is the authenticated customer: the chain uses it, and every listed user must carry it. This gives an empty or odd listing a reference point.
  - **The listing.** `users.list({ customer: 'my_customer', maxResults: 500, projection: 'basic', fields: 'nextPageToken,users(id,customerId,suspended,archived)', pageToken })`, with 10 s per page (abortable), 10 min per pass and at most 400 pages. **Complete** only when all of these hold:
    - every page is 2xx;
    - no `pageToken` repeats (loop detection);
    - the last page has no `nextPageToken`;
    - every user has a non-empty string `id`, with no duplicates;
    - `suspended` and `archived` are booleans or absent (absent = false);
    - every `customerId` equals the anchor's;
    - the anchor admin's own `id` appears in the listing.

    Any failure ⇒ `incomplete` with a reason: `scope_missing`, `access_denied`, `unavailable`, `connection_invalid`, `admin_not_admin`, `mixed_customer` or `malformed`. No observation changes.
  - Deleted users are simply absent (no `showDeleted`). The listed ids live only in the job's memory; no Workspace user table is created.
  - **Matching.** The identity `subject` (OIDC `sub`) equals the Directory user `id`. Google documents this correspondence; owed live check G1 confirms it, and **Google enforcement is not turned on until it passes**.
  - Entra permission: `User.Read.All` (application) with an explicit `$select` that includes `accountEnabled`, which the sync already sends. No write permission is added. A missing value stays unknown (D4).
- **D12: Storage, audit, mail, metrics.**
  - **Two new org tables** (shape 1, `breeze_has_org_access(org_id)`, RLS enabled and forced in the creating migration, composite FKs `DEFERRABLE INITIALLY IMMEDIATE`):
    - `portal_directory_runs`, one row per captured or refused snapshot;
    - `portal_directory_actions`, one row per planned identity disable, unique on `(run_id, identity_id)`.
  - `org_id NOT NULL` with no `partner_id`. These rows are evidence about one org's directory, not configuration; state that in the PR, like W3 D9.
  - `portal_user_identities` gains `UNIQUE (id, org_id)` as an FK target.
  - Deleting an account or identity cascades its actions. The audit log keeps every applied disable.
  - **Registration:**
    - `CORE_ORG_CASCADE_DELETE_ORDER`: actions, then runs, then `portal_user_identities`.
    - `orgMergeRegistry.ts`: repoint both tables. The chain key carries the old org id, so the absorbed org's held actions refuse at Apply (D8d), its observations reset (D5), and the status view lists only runs whose chain names the org.
    - `CORE_TENANT_EXPORT_POLICY`: classify every new column of both tables, of `portal_user_identities` and `portal_users.disabled_by`. All of them are plain values (text, `text[]`, numbers, booleans, timestamps, uuids), so `included`.
    - `rls-coverage.integration.test.ts`.
  - **Retention** (in `recover`): runs older than 30 days with no actions are deleted; any other run is deleted after 365 days.
  - **Audit:**
    - `portal.directory.identity.disable`: system actor, resource `portal_user`, details `{ identityId, provider, blocker, reason, runId, accountDisabled, keepsPassword }`. One row per applied action, inserted **in the action's transaction**, so a crash cannot apply without auditing.
    - `portal.directory.run.held`: system actor, resource `portal_directory_run`, details `{ source, affected, usable, holdReason }`.
    - `organization.portal_directory.run.apply` and `.dismiss`: MSP actor, resource `portal_directory_run`, details include the digest.
    - `organization.portal_user.identity.restore`: MSP actor, resource `portal_user`, details `{ identityId, blockersCleared, reactivated }`.
    - The new resource type `portal_directory_run` gets a label in all 8 web locales.
  - **Mail.** New purpose `partner.portal_directory.held` (`{ lane: 'platform' }`). It goes to `listActivePartnerAdmins(partnerId)` from the job, after commit, once per held run, and never throws. The copy names the org, the directory and the count, and links to the org's Portal tab. It lists no people.
  - **Metrics.** One log line per run, with counts only: source, outcome, reason, mode, usable, affected and disposition. No subject, email or name appears in logs or Sentry. A Sentry message with the fixed fingerprint `portal_directory_held` fires on each hold, with counts only.
- **D13: The W9 (SCIM) boundary** (quorum Q4).
  - W8 builds what SCIM reuses:
    - the blockers and the disabled state;
    - `disablePortalIdentity` (the account rule, epoch, purge and audit);
    - `restorePortalIdentity`;
    - `portal_users.disabled_by`;
    - every reader's handling.
  - W9 calls `disablePortalIdentity({ blocker: 'scim', reason: 'scim_deactivated' })` with no run. W8 builds no push endpoint, no bearer tokens and no generic directory-connector abstraction.
  - **Snapshot evaluation keeps running when SCIM is on.** Google identities, Entra identities outside the SCIM assignment, and missed provisioning events all still matter. SCIM is the fast path; the snapshot is the backstop. An already-disabled identity gains the second blocker, and the account rule runs again.
  - W9 must not auto-restore anything W8 disabled (spec). Whether a SCIM `active: true` removes the `scim` blocker is W9's decision. It can never remove a directory or MSP blocker, and never reactivate an account whose `disabled_by` is `msp`.
- **D14: Scope.**
  - Deprovisioning acts whether or not the org has Microsoft or Google sign-in turned on. Add-in Entra identities are leavers too, and invariant 12 names add-in sessions.
  - It never acts for an inactive org or partner.
  - It never touches accounts with no identity. Password-only accounts have no directory evidence.
  - A person deleted and recreated in the directory gets a **new** subject. The old identity stays disabled and reserved, and it blocks a new identity of that provider on the same account (`unique (portal_user_id, provider)`). The W8 recovery is to delete the portal account and re-invite, which is documented. OD3 proposes an MSP "remove disabled sign-in" action instead.

## Advisor quorum

An independent `codex exec` (gpt-6-astra, `model_reasoning_effort="xhigh"`, `-s read-only`, stdin closed) reviewed the draft decisions on 2026-11-12. Its inputs were the spec, the W3, W4 and W7 plans, and the landed code: the M365 sync, the identities, account state, the add-in exchange, the Google client and the retention pattern. It returned **AGREE WITH CHANGES, with the snapshot proof blocking enforcement**. I verified each code claim it made before adopting it: chunked persist, generation bumped at claim, the executor dropping non-string ids, disconnect keeping the connection row, and `consent_generation` bumping on re-consent.

| Draft decision | Verdict | Resolution in this plan |
|---|---|---|
| Disable vs delete (D1) | AGREE WITH CHANGES | Kept. Added: the disabled check runs **under the account lock** at session mint, because a lookup → disable → mint interleaving could otherwise mint a session at the new epoch. Added the account-then-identity lock order and the display readers (link status, add-in counts). Reactivation uses a *usable* password (D3). |
| Entra completeness via a queued job reading the cache (D2) | **DISAGREE.** Chunked persist means a later failed run can rewrite part of the cache under the earlier snapshot's timestamp, and the executor drops malformed users while reporting complete. | **Resolved by adopting the fix.** Capture runs inside the sync hook under the generation fence, with `FOR SHARE` on the state row (D4). The executor reports `malformedItems`, and the API counts a run with any of them as incomplete. |
| Membership + two snapshots (D3 draft) | AGREE WITH CHANGES | The chain gains the connection's `consent_generation` (disconnect keeps the row). Any present observation, including unknown, resets absence. The two absences must be ≥ 4 h apart. Re-arm needs a snapshot newer than the restore (D5, D9). |
| Thresholds and holds (D4 draft) | AGREE WITH CHANGES | Count distinct affected accounts against usable identities. Added a small-org rule. First-enforcement hold is per chain, not per org. Apply carries an impact digest and a 72 h evidence-age limit and re-validates the proof, connection and identity. Dismiss sets re-arm instead of looping (D6, D8). |
| Report-only by default (D5 draft) | AGREE WITH CHANGES | Invalid env values fail toward report-only. Apply and Dismiss refuse in report mode. Reported runs stay immutable. No per-org setting is needed in W8 (D7). |
| Storage (D6 draft) | AGREE WITH CHANGES | Added `(run_id, identity_id)` uniqueness, incarnation in the chain, explicit `(org_id, source, snapshot_key)` uniqueness, export classification of the new identity and account columns, and merge invalidation through the chain's org id (D12). |
| Google read scope (D7 draft) | AGREE | Kept `admin.directory.user` alone, behind a read-only wrapper. Added the admin anchor (`users.get`: `isAdmin`, `customerId`, admin present in the listing), page-token loop detection, strict id and boolean validation, and abortable deadlines (D11). |
| Restore (D8 draft) | AGREE WITH CHANGES | One account-locked transaction. An MSP-disabled account needs explicit reactivation. Re-arm is shown as an exemption (D9). |
| SCIM boundary (D9 draft) | AGREE WITH CHANGES. One `disabled_source` loses concurrent intent; account-disable provenance is missing. | **Adopted.** Independent `disabled_blockers` (D1) and `portal_users.disabled_by` (D2). Snapshots keep running under SCIM (D13). |
| Scope (D10 draft) | AGREE WITH CHANGES | The proof is locked at action commit, `degraded` connections are executable, and above-cap tenants show `directory_too_large` (D4, D8). |
| Omission: durable enqueue / outbox | Adopted | The run row is the outbox, and the hourly `recover` job covers it (D10). |
| Omission: one lock order | Adopted | D3. |
| Omission: crash-safe audit and purge retry | Adopted | Audit in the action transaction. `sessions_purged_at` plus `recover` (D10, D12). |
| Omission: tests for mixed generations, reconnect id reuse, reordered jobs, unknown-present, stale approvals, concurrent SCIM/restore, old readers | Adopted | Named in Review Focus and Tasks 4, 6, 8 and 9. Old-reader safety is a rollout gate (version parity), not a test. |
| Omission: directory users recreated with a new subject | Adopted as an operator decision | D14 documents the recovery; OD3 proposes the action. |

No disagreement is left open.

## Open decisions for the operator

- **OD1: A per-org or partner on/off switch for deprovisioning.**
  - The spec's card has no deprovisioning control, so W8 adds no setting (rule 9 count unchanged). The deployment ENFORCE switch, the per-chain first-enforcement hold and Dismiss give the MSP control in practice.
  - (a) No setting in W8. **Recommended**, and the quorum agreed: there is no precedent, and a "keep leavers' access" switch works against G7.
  - (b) A policy field `directory_deprovisioning_mode: off | report | enforce` (partner default → org override), which needs a rule-9 statement and a W3 card row.
- **OD2: The numbers.**
  - Hold when `affected >= 3 && > 10%`, or `> 25`, or `>= 2 && >= 50%`.
  - Shrink guard: 80%, confirmed within ±5%.
  - Absence spacing: 4 h.
  - Apply evidence age: 72 h.
  - Report period before enforcement: 14 days.
  - Re-try budget: purges for 24 h.
  - **Recommend** these as defaults, tuned after the report period.
- **OD3: An MSP "Remove this disabled sign-in" action**, for a person deleted and recreated in the directory (D14).
  - Without it, the old disabled identity blocks linking the person's new directory account to the same portal account. The only recovery is deleting the portal account (losing its history) and re-inviting.
  - The action would delete one **disabled** identity row. It would be MSP-only and audited, and allowed only when the identity is disabled by a directory blocker and absent from the directory. The account could then be re-invited and linked through the invite-bound flow.
  - Spec §5.1 lists only grants for MSP actions, and W4 deferred "unlink identity", so this has no precedent.
  - **Recommend adding it in W8** (one route in W08a, one button in W08b) because the recovery is otherwise destructive. If approved, it becomes Task 8 Step 6 and a W08b button. The plan's tasks do not include it until then.
- **OD4: The leaver's password** (D2). The spec keeps a usable password working after the identity is disabled.
  - (a) Keep the spec's rule. Tag "keeps password access" in the preview, and tell MSPs in the docs to disable the account when the person has left. **Recommended**: some customers deliberately keep a password for break-glass access, and the spec chose this.
  - (b) Also disable the account when the identity was disabled by a directory blocker for reason `absent` (deleted), but not for `account_disabled` / `suspended`. Deleted people do not come back with the same object. This is a spec change.
  - (c) A per-apply checkbox, "also disable accounts that keep password access".
- **OD5: Google `archived` users** are treated like `suspended`: they cannot sign in, so they count as disabled in one snapshot.
  - The spec names only "suspended, deleted".
  - **Recommend** treating them as disabled. The alternative is to ignore `archived` until the person is deleted.
- **OD6: Google read scope.**
  - The plan mints a token with the existing write-capable `admin.directory.user` scope, behind a read-only wrapper, so customers do not re-consent (D11).
  - The alternative is `admin.directory.user.readonly`, which needs every customer to edit their delegation grant before Google deprovisioning works.
  - **Recommend** the plan's choice. Revisit if a security review asks for least-privilege tokens over zero-touch rollout.
- **OD7: Who gets the held-run email.**
  - Plan default: active partner admins, the W5 domain-verification-lost precedent.
  - The alternative is in-app only, through the panel and the existing notification service.
  - **Recommend** email, because a held batch means leavers keep access until someone acts.

## Settings rule 9 statement (copy into both PR bodies)

- **No new setting concept.** Directory deprovisioning has no per-org or partner setting in W8 (OD1). `PORTAL_DIRECTORY_DEPROVISION_ENFORCE` is deployment env, not a setting.
- **Home, level and resolver:** none, because there is no setting. The MSP surface is a status-and-preview panel under org settings › Portal › Sign-in & registration, plus a per-identity badge and Restore in the portal users list.
- **Places configured:** before 2, after 2 (the W3 card and the partner default, unchanged).
- **Nav:** no new settings page; `settingsPageRegistry.test.ts` passes unchanged.

## Global Constraints

- **Invariant 12:** deprovisioning acts only on complete snapshots (D4, D11). It never reverses an MSP disable (D2). Every applied disable bumps `auth_epoch` and purges browser **and** add-in sessions (D2).
- **Never delete** an identity or an account in W8 (D1).
- **Every `status` writer** goes through `planPortalAccountTransition`. `directory_deprovision` is a census `state-module` entry, and every writer keeps `disabled_by` consistent with `status`.
- **Lock order:** advisory `(org, source)` lock, then the account row, then the identity row (D3, D8g).
- **Report-only by default:** with the env unset or invalid, no code path disables an identity. Task 9 asserts it on the full pipeline.
- **Context rules:**
  - Jobs and the hook hold no request context and open `withSystemDbAccessContext` themselves.
  - Org routes call system-scope readers through `runOutsideDbContext`.
  - A route that catches a refusal around a query keeps the query inside the service's `withDbTransaction`, with the catch outside it.
  - Never `Promise.all` siblings that open transactions.
- **Error codes** (UPPER_SNAKE): `PORTAL_DIRECTORY_RUN_STALE` (409), `PORTAL_DIRECTORY_RUN_NOT_HELD` (409), `PORTAL_DIRECTORY_ENFORCEMENT_OFF` (409), `PORTAL_IDENTITY_NOT_DISABLED` (409), `PORTAL_IDENTITY_NOT_FOUND` (404), `PORTAL_ACCOUNT_MSP_DISABLED_CONFIRM` (409, Restore without explicit reactivation of an MSP-disabled account).
- **Migration:** `apps/api/migrations/2027-01-24-180000-portal-directory-deprovisioning.sql` (slot `2027-01-24-18xxxx`). It must sort after the newest file on `origin/main` at push time, so re-check before enqueue. Idempotent, no inner `BEGIN;`/`COMMIT;`, first statement `SELECT set_config('breeze.scope', 'system', true);` (the file backfills rows), then `pnpm db:check-drift`. Never rename a shipped migration.
- **PII:** logs and Sentry carry counts, org ids and run ids only. Tests use `example.com`, `*.example.com` or `.test` addresses (`scripts/security/check-customer-pii.sh`).
- **No network in tests:** inject the Google reader, seed `m365_users` and `m365_sync_state` by SQL, and stub the executor. No test reaches `googleapis.com` or Graph.
- **No infrastructure details** in code, docs or PR bodies.
- **Web:** mutations go through `runAction`. New locale keys go into all 8 locales (`en de-DE es-419 fr-CA fr-FR it-IT pt-BR tr-TR`). Dynamic keys use a static `Record` + `/* i18n-dynamic */`. Tests select by `data-testid`.
- **CPU budget:**
  - Vitest with `--pool=forks --poolOptions.forks.maxForks=4` on touched files; `--changed origin/main` for the sweep.
  - One `tsc` at a time, with `NODE_OPTIONS=--max-old-space-size=20480`. Check `echo "exit=$?"`, never `| tail`.
  - No background CI pollers.
- **Commits** end with `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>`.

## Review Focus

Numbering: "Review Focus n" (RFn in test comments) is this list. "Feature RFn" is the index's list.

1. **A partial, failed or odd directory read** (feature RF5). Cases:
   - a truncated or interrupted Entra run;
   - a run whose executor dropped a malformed user;
   - a later run that persisted some chunks and then failed;
   - an M365 disconnect (the cache is deleted), and a reconnect of the same connection row;
   - a throttled Google page, a repeated page token, the deadline or page cap;
   - a `customerId` different from the admin anchor, or a listing without the admin;
   - a snapshot that lost half its users.

   Expected: nobody is disabled and no observation counter moves. The run is recorded `incomplete`, `skipped` or `suspect_shrink` with its reason, or not recorded at all for a fenced-out capture, and the MSP panel shows it.

   *(Task 4: `suspect shrink changes nothing until a second snapshot agrees`. Task 6: `a truncated or malformed users run records incomplete and acts on nobody`, `a capture after a newer claim records nothing (generation fence)`, `disconnect never evaluates`, `re-consent of the same connection row starts a new chain`. Task 7: `a page error, token loop, deadline or page cap is incomplete`, `a customerId mismatch or missing admin is incomplete`. Task 9: `a newer run's partial chunks never reach an evaluation`, `half the tenant vanishes in one complete snapshot: nothing applied`.)*
2. **An identity the directory never listed.** Cases: an Entra identity whose tenant differs from the connection's; a Google identity from a Workspace other than the connection's (its `hd` verified by DNS); an add-in identity created before the M365 connection and never seen. Expected: never acted on for absence. An affirmative disabled or suspended state needs the object present in this directory, by id.

   *(Task 4: `absence never acts without prior membership in the chain`, `an unknown present observation resets absence`. Task 9: `a google identity from another workspace is never deprovisioned`, `an entra identity for another tenant is out of scope`.)*
3. **The account rule and its races.** The identity is disabled on each of these accounts:
   - an identity-only account → disabled;
   - a password account under `allowed` → identity disabled, account active, epoch bumped, sessions purged, password still signs in, tagged "keeps password access";
   - the same account under `sso_only` → disabled;
   - an account with a second enabled identity → active;
   - an already-disabled account → identity only, `disabled_by` unchanged;
   - an add-in-only account → disabled, add-in sessions purged.

   Also: two identities of one account disabled concurrently → the account ends disabled. A sign-in racing a disable never leaves a live session.

   *(Task 3: one test per case, plus `concurrent disables of both identities disable the account` and `a sign-in racing a disable cannot keep a session`.)*
4. **Precedence and reversibility.**
   - An MSP-disabled account is never re-enabled by anything in W8, and it keeps `disabled_by = 'msp'`.
   - Re-enabling the person in the IdP restores nothing.
   - A Restore is not undone by the next run while the directory still says disabled. It re-arms only after a snapshot newer than the restore shows the person enabled.
   - Dismiss does not loop.
   - A SCIM-style second blocker survives a directory-only change, and Restore clears both.

   *(Task 3: `directory_deprovision on a disabled account is a no-op that keeps disabled_by`, `a second blocker is added, not a no-op`. Task 4: `rearm blocks actions until a newer snapshot shows enabled`. Task 5: `dismiss sets rearm and the next run proposes nothing`. Task 8: `restore clears every blocker and needs explicit reactivation for an MSP-disabled account`.)*
5. **A disabled identity trying to come back.** Cases: Microsoft or Google sign-in with the disabled identity; the add-in exchange and its conflict recovery; an invite-bound or link flow; an approved access request with the same `(issuer, subject)`; the reconciliation job. Expected: denied (`identity_disabled`, the generic `unavailable` / 401). No request, no new account, no identity change, no session.

   *(Task 2: `step 1 denies a disabled identity and never reaches step 4`, `the add-in exchange and its conflict recovery refuse a disabled identity`, `approval with a disabled identity's subject is identity_conflict`, `reconcile does not report a disabled identity as drift`.)*

Invariants re-run as named tests:
- **4:** Task 9 `a run for org A never disables an identity in org B`.
- **5:** Review Focus 5.
- **9:** Task 3 `after deprovision the browser and add-in sessions are refused on the next request`.
- **10:** Task 2 `directory_deprovision is in the writer census and yields disabled + disabled_by directory + bumpEpoch`.
- **12:** Review Focus 1, 3, 4 and Task 9 `report mode never disables`.

---

## File structure

| File | Responsibility | PR |
|---|---|---|
| Create `apps/api/migrations/2027-01-24-180000-portal-directory-deprovisioning.sql`; modify `db/schema/portal.ts`; create `db/schema/portalDirectory.ts` (+ export from the schema index) | Identity and account columns, two tables, RLS, FKs, backfill | a |
| Modify `services/tenantCascade.ts`, `services/orgMergeRegistry.ts`, `services/tenantExportPolicyRegistry.ts`, `__tests__/integration/rls-coverage.integration.test.ts` | Registrations | a |
| Modify `services/portalAccountState.ts` (+ test), `__tests__/portalAccountWriters.contract.test.ts`, `routes/orgPortalUsers.ts`, `services/portalUserIdentities.ts` (+ test), `services/portalOidc/accountResolution.ts` (+ test), `services/clientAiExchange.ts` (+ test), `services/portalSsoOnly.ts` (+ test), `routes/portal/capabilityTokens.ts`, `routes/portal/oidcShared.ts`, `routes/clientAi/adminOrgs.ts`, `services/contacts/portalInvite.ts`; create `__tests__/portalIdentityFacts.contract.test.ts` | Writer, `disabled_by`, usable-identity fact, readers under lock (D2, D3) | a |
| Create `services/portalDirectory/{types,identityDisable,evaluate,runStore,mode,notify,entraCapture,googleSource,queue,worker,index}.ts` (+ tests) | Shared writer, evaluator, run store, sources, jobs | a |
| Modify `services/m365Sync/hooks.ts` (+ test), `services/m365Sync/domains/users.ts` (+ test); modify `apps/m365-graph-read-executor/src/microsoft/syncActions.ts` (+ test) | Capture in the hook; malformed-item completeness | a |
| Modify `services/googleClient.ts` (+ test) | `getDirectoryUsersReader` | a |
| Modify `services/email.ts` (+ test), `services/emailDomains/mailPurposes.ts` (+ test) | Held-run email | a |
| Modify `config/validate.ts`, `.env.example`, `docker-compose.yml`, `deploy/docker-compose.prod.yml` | ENFORCE env | a |
| Modify `services/workerRegistry.ts`, `jobs/workerReadinessManifest.ts`, `jobs/scheduleRegistry.ts`, `workerEntrypointClosure.contract.test.ts`, `workerRegistry.test.ts` | Worker and schedule registration | a |
| Create `routes/orgPortalDirectory.ts` (+ test); modify `routes/orgs.ts` (register), `routes/orgPortalUsers.ts` (list fields); modify `.github/scripts/integration-suites.txt`; `apps/web/src/locales/*/admin.json` (`audit.resourceTypes.portal_directory_run`) | MSP status, apply, dismiss, restore | a |
| Create `__tests__/integration/portalDirectoryDeprovisioning.integration.test.ts` | Real-DB proofs | a |
| Create `apps/web/src/components/settings/portalAccess/DirectoryDeprovisioningPanel.tsx` (+ test); modify `OrgSignInRegistrationCard.tsx`, `portalAccess/types.ts`, `OrgPortalUsersEditor.tsx` (+ test); locale files | MSP panel, badge, Restore dialog | b |
| Create `apps/docs/src/content/docs/features/portal-directory-deprovisioning.mdx`; modify `features/portal.mdx`, `deploy/environment.mdx`, `apps/docs/astro.config.mjs`; regenerate `apps/api/src/data/docsIndex.json` | Docs | b |

---

## W08a — API + jobs

Test commands:
- Unit: from `apps/api`, `npx vitest run --pool=forks --poolOptions.forks.maxForks=4 <file>`. Never `pnpm --filter <pkg> test -- --run <path>`.
- Integration: `pnpm test-stack up`, then `npx vitest run -c vitest.integration.config.ts <file>`. Tear down with `pnpm test-stack down` and say so.

### Task 1: Migration, Drizzle, registrations

**Files:**
- Create: `apps/api/migrations/2027-01-24-180000-portal-directory-deprovisioning.sql`.
- Modify: `db/schema/portal.ts` (identity and account columns). Create `db/schema/portalDirectory.ts` (`portalDirectoryRuns`, `portalDirectoryActions`) and export it from the schema index.
- Modify: `services/tenantCascade.ts`, `services/orgMergeRegistry.ts`, `services/tenantExportPolicyRegistry.ts`, `__tests__/integration/rls-coverage.integration.test.ts`.
- Test: `src/db/migrationRlsScope.test.ts`, `src/__tests__/orgMergeGucContract.test.ts`, `src/db/autoMigrate.test.ts`, and a new `services/tenantExportPolicyRegistry.portalDirectory.test.ts`.

**Interfaces — Produces.** The SQL is the spec of record; Drizzle mirrors it.

```sql
SELECT set_config('breeze.scope', 'system', true);

ALTER TABLE portal_user_identities
  ADD COLUMN IF NOT EXISTS disabled_at timestamptz,
  ADD COLUMN IF NOT EXISTS disabled_reason text,
  ADD COLUMN IF NOT EXISTS disabled_blockers text[] NOT NULL DEFAULT '{}',
  ADD COLUMN IF NOT EXISTS directory_chain text,
  ADD COLUMN IF NOT EXISTS directory_seen_at timestamptz,
  ADD COLUMN IF NOT EXISTS directory_absent_runs smallint NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS directory_absent_since timestamptz,
  ADD COLUMN IF NOT EXISTS directory_last_run_id uuid,
  ADD COLUMN IF NOT EXISTS directory_rearm_since timestamptz;
-- CHECKs, each guarded by a pg_constraint lookup:
--   portal_user_identities_disabled_chk:
--     (disabled_at IS NULL) = (cardinality(disabled_blockers) = 0) AND (disabled_at IS NULL) = (disabled_reason IS NULL)
--   portal_user_identities_blockers_chk:
--     disabled_blockers <@ ARRAY['entra_directory','google_directory','scim','msp']::text[]
--   portal_user_identities_disabled_reason_chk:
--     disabled_reason IN ('account_disabled','absent','suspended','archived','scim_deactivated','msp')
--   portal_user_identities_absent_runs_chk: directory_absent_runs >= 0
-- UNIQUE (id, org_id): portal_user_identities_id_org_uq (FK target).

ALTER TABLE portal_users ADD COLUMN IF NOT EXISTS disabled_by text;
UPDATE portal_users SET disabled_by = 'msp' WHERE status = 'disabled' AND disabled_by IS NULL;
-- portal_users_disabled_by_chk: disabled_by IS NULL OR disabled_by IN ('msp','directory','scim')
-- portal_users_disabled_by_status_chk: (status = 'disabled') = (disabled_by IS NOT NULL)  -- ADD … NOT VALID; then VALIDATE CONSTRAINT

CREATE TABLE IF NOT EXISTS portal_directory_runs (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id uuid NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  source text NOT NULL CHECK (source IN ('entra','google')),
  chain_key text,                  -- null when refused before a chain is known
  snapshot_key text NOT NULL,      -- entra: <connectionId>:<consentGeneration>:<generation>; google: <connectionId>:<utcDate>
  snapshot_at timestamptz NOT NULL,
  outcome text NOT NULL CHECK (outcome IN ('evaluated','incomplete','suspect_shrink','skipped')),
  reason text CHECK (reason IS NULL OR reason IN ('tenant_not_proven','tenant_mismatch','connection_inactive','org_inactive',
    'sync_incomplete','directory_too_large','scope_missing','access_denied','unavailable','connection_invalid',
    'admin_not_admin','mixed_customer','malformed')),
  mode text NOT NULL CHECK (mode IN ('report','enforce')),
  directory_user_count integer,
  usable_count integer NOT NULL DEFAULT 0,
  affected_count integer NOT NULL DEFAULT 0,
  disposition text NOT NULL CHECK (disposition IN ('none','reported','applying','applied','held','held_applied','held_dismissed','superseded')),
  hold_reason text CHECK (hold_reason IS NULL OR hold_reason IN ('threshold','first_enforcement')),
  impact_digest text,
  decided_by_user_id uuid REFERENCES users(id) ON DELETE SET NULL,
  decided_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT portal_directory_runs_snapshot_uq UNIQUE (org_id, source, snapshot_key),
  CONSTRAINT portal_directory_runs_id_org_uq UNIQUE (id, org_id)
);
CREATE INDEX IF NOT EXISTS portal_directory_runs_chain_idx ON portal_directory_runs (org_id, source, chain_key, created_at DESC);
CREATE INDEX IF NOT EXISTS portal_directory_runs_disposition_idx ON portal_directory_runs (disposition, created_at) WHERE disposition IN ('applying','held');

CREATE TABLE IF NOT EXISTS portal_directory_actions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id uuid NOT NULL,
  run_id uuid NOT NULL,
  identity_id uuid NOT NULL,
  portal_user_id uuid NOT NULL,
  provider text NOT NULL CHECK (provider IN ('entra','google')),
  reason text NOT NULL CHECK (reason IN ('account_disabled','absent','suspended','archived')),
  effect text NOT NULL CHECK (effect IN ('identity','identity_and_account')),
  keeps_password boolean NOT NULL DEFAULT false,
  status text NOT NULL CHECK (status IN ('reported','held','applied','skipped','superseded','restored')),
  skip_reason text,
  applied_at timestamptz,
  sessions_purged_at timestamptz,
  restored_at timestamptz,
  restored_by_user_id uuid REFERENCES users(id) ON DELETE SET NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT portal_directory_actions_run_fk FOREIGN KEY (run_id, org_id) REFERENCES portal_directory_runs (id, org_id) ON DELETE CASCADE DEFERRABLE INITIALLY IMMEDIATE,
  CONSTRAINT portal_directory_actions_identity_fk FOREIGN KEY (identity_id, org_id) REFERENCES portal_user_identities (id, org_id) ON DELETE CASCADE DEFERRABLE INITIALLY IMMEDIATE,
  CONSTRAINT portal_directory_actions_user_fk FOREIGN KEY (portal_user_id, org_id) REFERENCES portal_users (id, org_id) ON DELETE CASCADE DEFERRABLE INITIALLY IMMEDIATE,
  CONSTRAINT portal_directory_actions_run_identity_uq UNIQUE (run_id, identity_id),
  CONSTRAINT portal_directory_actions_applied_chk CHECK ((status IN ('applied','restored')) = (applied_at IS NOT NULL))
);
CREATE INDEX IF NOT EXISTS portal_directory_actions_identity_idx ON portal_directory_actions (identity_id, created_at DESC);
CREATE INDEX IF NOT EXISTS portal_directory_actions_purge_idx ON portal_directory_actions (applied_at) WHERE status = 'applied' AND sessions_purged_at IS NULL;
-- Both tables: ENABLE + FORCE ROW LEVEL SECURITY. Policies use breeze_has_org_access(org_id) for SELECT/INSERT/UPDATE/DELETE.
-- Copy the portal_access_requests policy block exactly, with DROP POLICY IF EXISTS first.
```

- [ ] **Step 1: Write the failing tests**

```ts
// migration (integration, on the test stack)
it('starts with the system-scope line and has no BEGIN/COMMIT');
it('is idempotent: applying it twice succeeds');
it('backfills disabled_by = msp for every disabled portal user and validates the status constraint');
it('refuses a half-set disabled state, an unknown blocker or reason (23514)');
it('refuses a disabled portal user without disabled_by and an active one with it');
it('portal_directory_actions refuses an identity or account from another org (composite FK)');
it('deleting a portal user cascades its actions; deleting a run cascades its actions');
it('both tables are RLS enabled + forced and invisible across orgs as breeze_app');              // rls-coverage
// tenantExportPolicyRegistry.portalDirectory.test.ts
it('every column of both tables, every new identity column and portal_users.disabled_by is classified');
// cascade / merge
it('CORE_ORG_CASCADE_DELETE_ORDER lists portal_directory_actions, then portal_directory_runs, before portal_user_identities');
it('org merge repoints both tables');
```

- [ ] **Step 2: Run them; verify they fail.**
- [ ] **Step 3: Implement** the migration, the Drizzle tables and the registrations. Then run `pnpm db:check-drift` and expect no drift.
- [ ] **Step 4: Run** the unit tests above plus `src/db/migrationRlsScope.test.ts`, `src/db/migrationPartnerExportLocks.test.ts` and `src/services/orgMerge.test.ts`. On the test stack, run `rls-coverage`, `tenant-export-policy`, `tenantExportErasureRoundtrip` and `orgCascade`. All PASS.
- [ ] **Step 5: Commit**: `feat(portal): directory deprovisioning schema — identity blockers, disabled_by, runs and actions (W8)`

### Task 2: Account state, the usable-identity fact, readers under lock

**Files:**
- Modify: `services/portalAccountState.ts` (+ test), `__tests__/portalAccountWriters.contract.test.ts`, `routes/orgPortalUsers.ts` (`msp_disable` and `msp_reactivate` write `disabled_by`; facts gain the usable fields).
- Modify: `services/portalUserIdentities.ts` (+ test). Readers return `identityId` and `disabledAt`. Add `portalUserHasUsableIdentitySql()` and `lockIdentityForAccount(exec, identityId)`. `ensureEntraIdentity` returns `'disabled'` and writes nothing.
- Modify: `services/portalOidc/accountResolution.ts` (+ test). Step 1 and the link branch take the account `FOR SHARE`, re-read the identity and epoch, and deny `identity_disabled`.
- Modify: `services/clientAiExchange.ts` (+ test). Refuse a disabled identity in the lookup and in conflict recovery, under the account lock.
- Modify: `services/portalSsoOnly.ts` (+ test), `routes/portal/capabilityTokens.ts`, `routes/portal/oidcShared.ts` (link status `disabled`), `routes/clientAi/adminOrgs.ts` (counts), `services/contacts/portalInvite.ts`.
- Create: `src/__tests__/portalIdentityFacts.contract.test.ts`.

**Interfaces — Produces:**

```ts
// portalAccountState.ts
type PortalAccountWriter = … | 'directory_deprovision';
interface PortalAccountFacts { …; hasExternalIdentity: boolean /* any row */; hasUsableExternalIdentity: boolean; passwordUsable: boolean }
interface PortalAccountTarget { …; disabledBy: 'msp' | 'directory' | 'scim' | null }
// directory_deprovision: active|invited → { status 'disabled', disabledBy 'directory', bumpEpoch true }; disabled → unchanged, bumpEpoch false
// msp_disable → disabledBy 'msp'; msp_reactivate: credential = passwordUsable || hasUsableExternalIdentity; disabledBy null
export function passwordUsableFor(facts: { hasPasswordHash: boolean; authMethod: string }, passwordMode: 'allowed' | 'sso_only'): boolean;
// portalUserIdentities.ts
export function portalUserHasUsableIdentitySql(): SQL;   // EXISTS … AND disabled_at IS NULL
export interface PortalIdentityOwner { portalUserId: string; orgId: string; identityId: string; disabledAt: Date | null }
findPortalUserIdByIdentity(exec, key): Promise<PortalIdentityOwner | null>;
findPortalUserIdByEntraIdentity(exec, { tid, oid }): Promise<PortalIdentityOwner | null>;
ensureEntraIdentity(…): Promise<'inserted' | 'present' | 'conflict' | 'disabled'>;
// accountResolution.ts
type PortalOidcDenyReason = … | 'identity_disabled';
```

- [ ] **Step 1: Write the failing tests**

```ts
// portalAccountState.test.ts + census
it('directory_deprovision is in the writer census and yields disabled + disabled_by directory + bumpEpoch');   // inv. 10
it('directory_deprovision on a disabled account is a no-op that keeps disabled_by');                          // RF4
it('msp_reactivate of an account whose only identity is disabled returns it to invited');                    // §5.1
it('msp_reactivate of an account with a hash under sso_only and no usable identity returns it to invited');  // quorum D1
it('every transition out of disabled clears disabled_by');
// accountResolution.test.ts
it('step 1 denies a disabled identity and never reaches step 4');                                             // RF5
it('a disabled identity with an invite state is denied and the invite is not consumed');                     // RF5
it('the identity is re-read under the account lock: a disable committed after the lookup is seen');          // quorum D1 (lock order)
it('a google disabled identity is denied the same way');
// clientAiExchange.test.ts
it('the add-in exchange and its conflict recovery refuse a disabled identity with the unknown-user 401');   // RF5
it('ensureEntraIdentity on a disabled row returns disabled and writes nothing');
// existing approve path
it('approval with a disabled identity\'s subject is identity_conflict');                                     // RF5
// portalUserIdentities.test.ts
it('reconcile does not report a disabled identity as drift');                                                 // RF5
// display readers
it('link status reports a disabled provider as disabled, not linked');
it('add-in admin counts exclude disabled identities and report them separately');
// portalIdentityFacts.contract.test.ts
it('every portalUserHasIdentitySql / portalUserHasUsableIdentitySql call site is classified');                 // scans api/ and ee/
// portalSsoOnly.test.ts
it('an account whose only identity is disabled is stranded and keeps its hash under sso_only');
it('bulk invite still skips an account whose only identity is disabled');
it('no production auth path reads portal_users.entra_oid');                                                  // grep-based, D1
```

- [ ] **Step 2: Run them; verify they fail.**
- [ ] **Step 3: Implement.** The contract test holds a `Record<'file#anchor', 'any' | 'usable'>` with a one-line reason per entry (the D3 classification). In `accountResolution.ts`, keep the early check as a fast path and add the authoritative check inside the account-locked transaction that reads the epoch for minting.
- [ ] **Step 4: Run** the files above plus the W4 and W7 suites: `accountResolution.test.ts`, `oidc.test.ts`, `oidcGoogle.test.ts`, `oidcShared.test.ts`, `clientAiExchange*.test.ts`, `orgPortalUsers.test.ts`. They must PASS **unchanged except for the added cases**.
- [ ] **Step 5: Commit**: `feat(portal): disabled identities refused under the account lock; usable-identity and disabled_by facts (W8)`

### Task 3: The shared writer — disable and restore

**Files:**
- Create: `services/portalDirectory/types.ts`, `services/portalDirectory/identityDisable.ts` (+ `identityDisable.test.ts`, which includes two-connection race tests on the test stack).

**Interfaces:**
- Consumes: `planPortalAccountTransition(…, 'directory_deprovision' | 'msp_reactivate')`, `passwordUsableFor` and `lockIdentityForAccount` (T2); `resolvePortalAccessPolicy(orgId)` (W3); `purgePortalSessionsForUsers`, `purgeClientAiSessionsForUsers`, `getRedis`; `createAuditLog`.
- Produces:

```ts
// types.ts
export type DirectorySource = 'entra' | 'google';
export type IdentityBlocker = 'entra_directory' | 'google_directory' | 'scim' | 'msp';
export type IdentityDisabledReason = 'account_disabled' | 'absent' | 'suspended' | 'archived' | 'scim_deactivated' | 'msp';
export interface DisableIdentityInput {
  orgId: string; identityId: string;
  blocker: IdentityBlocker; reason: IdentityDisabledReason;
  actionId?: string;                                          // directory runs only; W9 passes none
  expect?: { directoryChain: string };                        // the apply-time re-check (D8d); omitted by W9
  now?: Date;
}
export type DisableIdentityResult =
  | { kind: 'disabled'; portalUserId: string; accountDisabled: boolean; keepsPassword: boolean }
  | { kind: 'blocker_added'; portalUserId: string; accountDisabled: boolean }     // already disabled by another blocker
  | { kind: 'skipped'; reason: 'already_blocked' | 'not_found' | 'chain_changed' | 'rearmed' };
// identityDisable.ts: opens its own system transaction; the caller holds no context
export async function disablePortalIdentity(input: DisableIdentityInput): Promise<DisableIdentityResult>;
export async function restorePortalIdentity(input: { orgId: string; portalUserId: string; identityId: string; reactivateAccount: boolean; confirmMspDisabled: boolean; actorUserId: string }): Promise<{ accountStatus: 'active' | 'invited' | 'disabled'; blockersCleared: IdentityBlocker[] }>;
export function previewAccountEffect(facts: { otherUsableIdentities: number; passwordUsable: boolean; status: string }): { effect: 'identity' | 'identity_and_account'; keepsPassword: boolean };
export async function retryPendingPurges(now: Date): Promise<number>;   // recover job
```

Rules for `disablePortalIdentity`, in one transaction:
1. Take the advisory lock (D8g) when `actionId` is set.
2. Lock the account `FOR UPDATE`, then the identity `FOR UPDATE`.
3. Run the skip checks.
4. Append the blocker; set `disabled_at` and `disabled_reason` only if they are null.
5. Count the other usable identities under the lock.
6. Call `previewAccountEffect`.
7. Apply `auth_epoch + 1` (always, on the first blocker).
8. Run the `directory_deprovision` transition when the effect includes the account.
9. Mark the action `applied`.
10. Insert the audit row in the same transaction.

After commit, run both purges and set `sessions_purged_at`. A purge error is logged, not thrown: the epoch already killed the sessions, and `recover` retries.

`restorePortalIdentity` refuses with `PORTAL_IDENTITY_NOT_DISABLED`, `PORTAL_IDENTITY_NOT_FOUND` or `PORTAL_ACCOUNT_MSP_DISABLED_CONFIRM`. It is the only writer that clears blockers.

- [ ] **Step 1: Write the failing tests**

```ts
it('identity-only account: identity and account disabled, epoch bumped, both session stores purged');      // RF3
it('password account under allowed: identity disabled, account active, epoch bumped, keepsPassword true');   // RF3
it('password account under sso_only: account disabled');                                                    // RF3
it('a second enabled identity keeps the account active');                                                   // RF3
it('an already-disabled account: identity disabled, account untouched, disabled_by unchanged');             // RF4
it('an add-in-only account (browser_access none) is disabled and its add-in sessions purged');              // RF3
it('after deprovision the browser and add-in sessions are refused on the next request');                    // inv. 9
it('a second blocker is added, not a no-op; restore clears both');                                          // RF4, quorum D9
it('concurrent disables of both identities disable the account');                                           // RF3, quorum omission 2
it('a sign-in racing a disable cannot keep a session');                                                     // RF3, quorum D1
it('not found, chain changed and rearmed are skips that write nothing');
it('restore clears every blocker, sets rearm, and with reactivateAccount runs msp_reactivate');             // RF4
it('restore of an msp-disabled account without confirmMspDisabled is PORTAL_ACCOUNT_MSP_DISABLED_CONFIRM');
it('a purge failure leaves sessions_purged_at null; retryPendingPurges finishes it');
```

- [ ] **Step 2: Run them; verify they fail.**
- [ ] **Step 3: Implement.** Hoist the route-local `stateSet` (`orgPortalUsers.ts:123-129`) into an exported helper in `portalAccountState.ts` if both callers can share it unchanged. Otherwise keep a local copy and say why in the commit.
- [ ] **Step 4: Run** the file and the census → PASS.
- [ ] **Step 5: Commit**: `feat(portal): disablePortalIdentity / restorePortalIdentity with blockers (W8, reused by W9)`

### Task 4: The evaluator (pure)

**Files:**
- Create: `services/portalDirectory/evaluate.ts` (+ `evaluate.test.ts`).

**Interfaces — Produces:**

```ts
export type DirectoryObservation =
  | { present: false }
  | { present: true; state: 'enabled' | 'unknown' }
  | { present: true; state: 'disabled'; reason: 'account_disabled' | 'suspended' | 'archived' };
export interface InScopeIdentity {
  identityId: string; portalUserId: string; provider: DirectorySource; subject: string;
  directoryChain: string | null; directorySeenAt: Date | null; directoryAbsentRuns: number;
  directoryAbsentSince: Date | null; directoryLastRunId: string | null; directoryRearmSince: Date | null;
}
export interface EvaluateInput {
  runId: string; chainKey: string; snapshotAt: Date; directoryUserCount: number;
  previous: { evaluatedCount: number | null; suspectCount: number | null };
  identities: InScopeIdentity[];
  observe(subject: string): DirectoryObservation;
}
export interface ObservationUpdate { identityId: string; directoryChain: string; directorySeenAt: Date | null; directoryAbsentRuns: number; directoryAbsentSince: Date | null; directoryLastRunId: string; directoryRearmSince: Date | null }
export interface PlannedAction { identityId: string; portalUserId: string; reason: 'account_disabled' | 'absent' | 'suspended' | 'archived' }
export type EvaluateResult =
  | { outcome: 'suspect_shrink' }
  | { outcome: 'evaluated'; updates: ObservationUpdate[]; actions: PlannedAction[]; reportedOnly: PlannedAction[] /* rearmed: listed, never applied */ };
export function evaluateDirectorySnapshot(input: EvaluateInput): EvaluateResult;
export function holdReasonFor(p: { affectedAccounts: number; usableIdentities: number; firstInChain: boolean; enforce: boolean }): 'threshold' | 'first_enforcement' | null;
export const SHRINK_RATIO = 0.8, CONFIRM_TOLERANCE = 0.05, ABSENCE_SPACING_MS = 4 * 3600_000;
```

- [ ] **Step 1: Write the failing tests**

```ts
it('present and enabled: seen set, absence cleared, no action');
it('present and disabled acts on the first snapshot');                                           // D5
it('an unknown present observation resets absence and does not act');                           // RF2, quorum D3
it('absence never acts without prior membership in the chain');                                 // RF2
it('two absences at least 4 h apart act; two absences 1 h apart do not');                        // D5 spacing
it('the same run is never counted twice');                                                       // dedup
it('a chain change resets seen and absence');                                                    // re-consent / merge
it('rearm blocks actions until a newer snapshot shows enabled; an older snapshot never re-arms'); // RF4, quorum D8
it('suspect shrink changes nothing until a second snapshot agrees');                             // RF1
it('a second snapshot within 5% of the suspect count is evaluated');
it('holdReasonFor: 2/2 held, 2/5 not, 3/10 held, 3/40 not, 26/10000 held, first in chain held');  // D6, D8c
```

- [ ] **Step 2: Run them; verify they fail.**
- [ ] **Step 3: Implement**, with no I/O.
- [ ] **Step 4: Run → PASS.**
- [ ] **Step 5: Commit**: `feat(portal): directory snapshot evaluator — membership, spaced absence, shrink guard, holds (W8)`

### Task 5: Run store, mode, apply, dismiss, notify

**Files:**
- Create: `services/portalDirectory/mode.ts` (+ test), `runStore.ts` (+ test), `notify.ts` (+ test).
- Modify: `config/validate.ts` (a warning for an invalid value) and `.env.example`. Add `PORTAL_DIRECTORY_DEPROVISION_ENFORCE=` with one comment line: "Set to true to let directory deprovisioning disable customer-portal sign-ins; unset = report only". Also modify `docker-compose.yml` and `deploy/docker-compose.prod.yml` (pass-through).
- Modify: `services/email.ts` (+ test; add `sendPortalDirectoryHeld`) and `services/emailDomains/mailPurposes.ts` (+ test; add `partner.portal_directory.held`).

**Interfaces — Produces:**

```ts
// mode.ts
export function isDirectoryDeprovisionEnforced(): boolean;   // retentionEnforceFromEnv(…, 'PORTAL_DIRECTORY_DEPROVISION_ENFORCE', false); invalid → false + warn
// runStore.ts
export type RunRefusalReason = 'tenant_not_proven' | 'tenant_mismatch' | 'connection_inactive' | 'org_inactive' | 'sync_incomplete'
  | 'directory_too_large' | 'scope_missing' | 'access_denied' | 'unavailable' | 'connection_invalid' | 'admin_not_admin' | 'mixed_customer' | 'malformed';
export type RunDisposition = 'none' | 'reported' | 'applying' | 'applied' | 'held' | 'held_applied' | 'held_dismissed' | 'superseded';
/** Runs inside the caller's transaction (the Entra hook's fenced transaction, or the Google job's). */
export async function recordRefusedRun(tx, p: { orgId: string; source: DirectorySource; snapshotKey: string; snapshotAt: Date; outcome: 'incomplete' | 'skipped'; reason: RunRefusalReason }): Promise<void>;
export async function recordEvaluatedRun(tx, p: { orgId: string; source: DirectorySource; snapshotKey: string; snapshotAt: Date; chainKey: string;
  directoryUserCount: number; identities: InScopeIdentity[]; observe: EvaluateInput['observe']; forceReport?: boolean }): Promise<{ runId: string; disposition: RunDisposition; holdReason: 'threshold' | 'first_enforcement' | null }>;
export async function afterRunCommitted(r: { runId: string; orgId: string; disposition: RunDisposition; holdReason: … }): Promise<void>;   // enqueue apply-run, or notify + audit hold
export async function applyRun(p: { orgId: string; runId: string; actor: { userId: string; impactDigest: string } | 'system' }): Promise<{ applied: number; skipped: number }>;
export async function dismissHeldRun(p: { orgId: string; runId: string; actorUserId: string; impactDigest: string }): Promise<void>;
export async function pruneDirectoryRuns(now: Date): Promise<number>;
export function impactDigestOf(actions: Array<{ id: string; identityId: string; effect: string; keepsPassword: boolean }>): string;
// notify.ts: after commit; never throws
export async function notifyDirectoryRunHeld(p: { orgId: string; runId: string; source: DirectorySource; affected: number }): Promise<void>;
```

`recordEvaluatedRun` steps:
1. Insert the run. A duplicate `snapshot_key` returns the existing run and writes nothing.
2. Load the chain's previous evaluated and suspect counts, and whether the chain has an applied run.
3. Call `evaluateDirectorySnapshot`.
4. Write the observation updates.
5. Supersede the chain's previous held actions.
6. Compute each action's `effect` and `keeps_password` with `previewAccountEffect`.
7. Choose the disposition: report mode ⇒ `reported`; enforce mode ⇒ `holdReasonFor` gives `held`, or else `applying`.
8. Store `impact_digest`.

`applyRun` (system or MSP) follows D8d. Each action calls `disablePortalIdentity`, and the run ends `applied` or `held_applied`.

- [ ] **Step 1: Write the failing tests**

```ts
// mode.test.ts
it('unset, false, 0 and invalid values are report (invalid warns); true and 1 enforce');
// runStore.test.ts
it('report mode records reported actions and disables nothing');                              // inv. 12
it('forceReport keeps report even when enforced; nothing can force enforce');
it('a duplicate snapshot key is a no-op');                                                    // dedup
it('enforce: over the threshold holds every action; the email and held audit fire once after commit');
it('enforce: the first run with actions in a chain is held even under the threshold');        // D8c
it('enforce: a later run under the threshold is applying, and apply-run applies each action');
it('apply and dismiss refuse in report mode (PORTAL_DIRECTORY_ENFORCEMENT_OFF)');             // D7
it('apply refuses a stale run: newer evaluated run, older than 72 h, digest mismatch, or chain org ≠ run org'); // D8d
it('apply re-checks each action: proof gone, connection re-consented, identity restored or re-chained ⇒ skipped with a reason');
it('dismiss sets rearm on each identity and the next run proposes nothing');                  // RF4, D8e
it('a newer evaluated run supersedes the previous held actions');
it('prune deletes empty runs after 30 days and others after 365');
// notify / email / purposes
it('the held email names the org, directory and count, links to the Portal tab, and lists no people');
it('partner.portal_directory.held is registered on the platform lane');
```

- [ ] **Step 2: Run them; verify they fail.**
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run** the files plus `src/__tests__/dbTransactionPromiseAll.contract.test.ts` and `envReadComposeCoverage` → PASS.
- [ ] **Step 5: Commit**: `feat(portal): directory run store — report, hold, apply, dismiss, notify (W8)`

### Task 6: Entra capture in the M365 hook; executor completeness; worker

**Files:**
- Modify: `apps/m365-graph-read-executor/src/microsoft/syncActions.ts` (+ test). The users action counts `malformedItems` (a non-string `id`, or an `id` seen twice) and returns it beside `truncated`.
- Modify: `services/m365Sync/domains/users.ts` (+ test): `complete = primaryOk && !result.truncated && (result.malformedItems ?? 0) === 0`. An executor that predates the field reports `undefined`, which is treated as 0, so a rolling deploy cannot strand the sync. Note it in the PR.
- Modify: `services/m365Sync/hooks.ts` (+ `hooks.test.ts`). For `domain === 'users'`, call `captureEntraDirectoryRun(ctx)` as the hook's last step, inside its own try/catch.
- Create: `services/portalDirectory/entraCapture.ts` (+ test), `queue.ts`, `worker.ts` (+ test) and `index.ts`.
- Modify: `services/workerRegistry.ts` (`{ name: 'portalDirectoryWorker', placement: 'global', load }` → `{ init, shutdown }`), `jobs/workerReadinessManifest.ts` (`consumers('portalDirectoryWorker')`), `jobs/scheduleRegistry.ts` (`'portal-directory-google'` daily in the ≡3 (mod 5) lane, and `'portal-directory-recover'` hourly, both unique minutes), and the order-sensitive lists in `workerEntrypointClosure.contract.test.ts` and `workerRegistry.test.ts` (inserted in registry order).

**Interfaces — Produces:**

```ts
// entraCapture.ts: called from the hook with no context held; never throws to the caller
export async function captureEntraDirectoryRun(ctx: { orgId: string; tenantId: string; connectionId: string; generation: number; now: Date; persisted: { complete: boolean } }): Promise<
  { recorded: false; reason: 'fenced' | 'no_identities' | 'lock_timeout' } | { recorded: true; runId: string; disposition: RunDisposition }>;
// queue.ts
export const PORTAL_DIRECTORY_QUEUE = 'portal-directory-deprovision';
export async function enqueueApplyRun(runId: string, orgId: string): Promise<boolean>;
// worker.ts: job names 'apply-run' | 'google-sweep' | 'google-org' | 'recover'
export async function initializePortalDirectoryWorker(): Promise<void>;
export async function shutdownPortalDirectoryWorker(): Promise<void>;
```

`captureEntraDirectoryRun` runs these steps in order, in one system `REPEATABLE READ` transaction with `lock_timeout 5s`:
1. Take the advisory lock.
2. Lock `m365_sync_state(org,'users')` `FOR SHARE`. `run_generation ≠ ctx.generation` or `last_complete_snapshot_at ≠ ctx.now` (for a complete run) ⇒ `fenced`.
3. Load the in-scope identities. If there are none, return `no_identities`, write no run, and keep the table small.
4. If the run is not complete, call `recordRefusedRun(incomplete, sync_incomplete | directory_too_large)` and stop.
5. Check the connection (`customer-graph-read`, `active | degraded`, not revoked, `tenant_id = ctx.tenantId`), then the proven tenant with `FOR SHARE` (the `lockProvenEntraTenant` pattern), then the org and partner. A failure records the run as `skipped` with its reason.
6. Read the identities' `m365_users` rows and the non-stale count.
7. Call `recordEvaluatedRun`.

After commit: `afterRunCommitted`.

Step 0 of this task: confirm the two fence facts the design rests on, as tests:
- `claim.ts` increments `run_generation` at claim.
- The completion writer updates the state row under the generation guard.

If either has changed on main, stop and re-plan with the quorum.

- [ ] **Step 1: Write the failing tests**

```ts
// executor syncActions.test.ts
it('a user without a string id or a duplicated id is counted in malformedItems');
// users.test.ts
it('malformedItems > 0 makes the run not complete (no stale marking)');
it('an executor without the field is treated as 0');
// hooks.test.ts
it('a users run calls the capture last; a capture throw does not skip the posture rollup or throw');
it('other domains never capture');
// entraCapture.test.ts (test stack)
it('a capture after a newer claim records nothing (generation fence)');                     // RF1, quorum D2
it('a newer run\'s partial chunks never reach an evaluation');                             // RF1
it('a truncated or malformed users run records incomplete and acts on nobody');            // RF1
it('above the item cap records directory_too_large');
it('connection tenant different from the proven tenant: skipped tenant_mismatch');
it('unproven tenant: skipped tenant_not_proven');
it('a degraded connection is evaluated; a revoked one is skipped');                         // quorum D10
it('disconnect never evaluates');                                                          // RF1
it('re-consent of the same connection row starts a new chain');                            // RF1, quorum D3
it('present + account_enabled false yields an account_disabled action');
it('lock timeout records nothing and does not throw');
// worker.test.ts
it('the worker dispatches apply-run, google-sweep, google-org and recover');
it('recover re-enqueues applying runs older than 15 min and retries pending purges');
```

- [ ] **Step 2: Run them; verify they fail.**
- [ ] **Step 3: Implement**, plus the registry, manifest and schedule edits.
- [ ] **Step 4: Run** the files plus `workerRegistry.test.ts`, `workerEntrypointClosure.contract.test.ts`, `workerReadinessCoverage.test.ts`, `scheduleRegistry.contract.test.ts`, `src/__tests__/parkedFanout.contract.test.ts`, and the M365 sync suites (`run.test.ts`, `persist.test.ts`, the executor package tests) → PASS.
- [ ] **Step 5: Commit**: `feat(portal): Entra directory capture in the M365 users hook under the generation fence (W8)`

### Task 7: Google source and the daily pass

**Files:**
- Modify: `services/googleClient.ts` (+ test): add `getDirectoryUsersReader`.
- Create: `services/portalDirectory/googleSource.ts` (+ test).

**Interfaces — Produces:**

```ts
export interface DirectoryUsersReader {
  getUser(userKey: string, fields: string, signal: AbortSignal): Promise<{ id?: unknown; customerId?: unknown; isAdmin?: unknown; suspended?: unknown }>;
  listUsersPage(pageToken: string | undefined, signal: AbortSignal): Promise<{ users?: unknown[]; nextPageToken?: unknown }>;
}
export function getDirectoryUsersReader(decryptedKeyJson: string, adminEmail: string): DirectoryUsersReader;   // JWT scope: admin.directory.user only
export type GoogleListing =
  | { kind: 'complete'; customerId: string; users: Map<string, { suspended: boolean; archived: boolean }> }
  | { kind: 'incomplete'; reason: 'scope_missing' | 'access_denied' | 'unavailable' | 'connection_invalid' | 'admin_not_admin' | 'mixed_customer' | 'malformed' };
export async function listGoogleDirectoryUsers(reader: DirectoryUsersReader, adminEmail: string, deps?: { now?: () => number }): Promise<GoogleListing>;
export async function runGoogleSweep(now: Date): Promise<{ enqueued: number }>;
export async function evaluateGoogleOrg(orgId: string, utcDate: string): Promise<{ outcome: 'evaluated' | 'incomplete' | 'skipped' | 'no_identities'; reason?: RunRefusalReason }>;
```

Constants (D11): `GOOGLE_USERS_PAGE_TIMEOUT_MS = 10_000`, `GOOGLE_USERS_PASS_DEADLINE_MS = 600_000`, `GOOGLE_USERS_MAX_PAGES = 400`, `maxResults: 500`, and the `fields` masks exactly as written in D11.

`evaluateGoogleOrg` runs in this order:
1. Load the connection and decrypt its key.
2. List the users. This runs **outside** any DB transaction, since it involves network I/O.
3. In one system transaction, take the advisory lock, re-check the connection id and binding (`FOR SHARE`) and the org, then call `recordEvaluatedRun` or `recordRefusedRun`.
4. After commit, call `afterRunCommitted`.

- [ ] **Step 1: Write the failing tests**

```ts
it('the users reader requests only admin.directory.user, impersonates adminEmail, and exposes no write call');
it('DIRECTORY_SCOPES and GOOGLE_DWD_SCOPES_CSV are unchanged');
it('the admin anchor must be an admin and not suspended; its customerId becomes the chain\'s');
it('pages to the end and returns a complete listing');
it('a page error, token loop, deadline or page cap is incomplete');                     // RF1
it('a customerId mismatch or missing admin is incomplete');                             // RF1
it('a non-string id, a duplicate id or a non-boolean suspended is malformed');
it('unauthorized_client maps to scope_missing; 403 to access_denied; 503 to unavailable');
it('suspended and archived map to their reasons; a missing id is absent');
it('a re-bound connection (new admin or service account) starts a new chain');
it('the sweep enqueues one job per org with an executable connection and an enabled google identity, per day');
it('no subject, email or key reaches a log line');
```

- [ ] **Step 2: Run them; verify they fail.**
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run** the files plus `googleDwdScopes.test.ts` → PASS.
- [ ] **Step 5: Commit**: `feat(portal): Google Workspace directory deprovisioning daily pass (W8)`

### Task 8: MSP routes and the portal-users list

**Files:**
- Create: `routes/orgPortalDirectory.ts` (+ `orgPortalDirectory.test.ts`). Register it from `routes/orgs.ts` beside `registerPortalEntraTenantRoutes`.
- Modify: the `routes/orgPortalUsers.ts` list response (+ test).
- Modify: `.github/scripts/integration-suites.txt`, adding `suite portal sources apps/api/src/routes/orgPortalDirectory.ts` and any other line `test:integration-suite-coverage` names (`services/m365Sync/hooks.ts`, `services/googleClient.ts`).
- Modify: `apps/web/src/locales/*/admin.json`, adding `audit.resourceTypes.portal_directory_run` in all 8 locales. The API label test reads these files; the rest of the web work is W08b.

**Interfaces — Produces.** Gates: `requireScope('partner','system')`. Reads need `ORGS_READ`. Writes need `ORGS_WRITE` + `requireMfa`, the same as the portal-users routes.
- `GET /organizations/:id/portal-directory` returns `{ mode, sources, openActions }`:
  - `mode` is `'report' | 'enforce'`.
  - `sources` is an array of `{ source, lastRun: RunSummary | null, lastEvaluatedRun: RunSummary | null }`.
  - `RunSummary = { id, outcome, reason, disposition, holdReason, directoryUserCount, usableCount, affectedCount, impactDigest, createdAt }`.
  - `ActionRow = { id, runId, portalUserId, email, name, provider, reason, effect, keepsPassword, status, rearmed }`.
  - Open actions are those `reported` or `held` on the latest evaluated run per source, plus identities with `rearm_since` set (`rearmed: true`).
  - Only runs whose chain names this org are listed.
- `POST /organizations/:id/portal-directory/runs/:runId/apply { impactDigest }` returns `{ applied, skipped }`. Refusals: 409 `PORTAL_DIRECTORY_RUN_STALE`, `PORTAL_DIRECTORY_RUN_NOT_HELD` or `PORTAL_DIRECTORY_ENFORCEMENT_OFF`.
- `POST /organizations/:id/portal-directory/runs/:runId/dismiss { impactDigest }` returns 204.
- `POST /organizations/:id/portal-users/:portalUserId/identities/:identityId/restore { reactivateAccount: boolean, confirmMspDisabled?: boolean }` returns `{ accountStatus, blockersCleared }`.
- Portal-users list rows gain `disabledBy` and `identities: Array<{ id, provider, disabledAt, disabledBlockers, disabledReason, rearmSince }>`.

- [ ] **Step 1: Write the failing tests**

```ts
it('status lists mode, last runs per source, open actions, and rearmed identities');
it('status hides runs whose chain names an absorbed org');                                       // merge
it('apply and dismiss need ORGS_WRITE and MFA, carry the digest, and audit organization.portal_directory.run.*');
it('apply on another org\'s run is 404');
it('restore clears every blocker and needs explicit reactivation for an MSP-disabled account');  // RF4
it('restore of an enabled identity is PORTAL_IDENTITY_NOT_DISABLED');
it('the users list carries disabledBy and each identity\'s disabled state');
it('system-scope readers run through runOutsideDbContext; refusals are caught outside withDbTransaction');
```

- [ ] **Step 2: Run them; verify they fail.**
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run** the files plus `auditResourceTypeLabels.test.ts` and `dbTransactionPromiseAll.contract.test.ts` → PASS.
- [ ] **Step 5: Commit**: `feat(portal): MSP directory deprovisioning status, apply, dismiss and restore routes (W8)`

### Task 9: Integration proofs and the W08a gate

**Files:**
- Create: `apps/api/src/__tests__/integration/portalDirectoryDeprovisioning.integration.test.ts`. It runs against a real DB as `breeze_app`, with superuser seeding of `m365_connections`, `m365_sync_state`, `m365_users`, the tenant-proof mapping and identities. The Google reader is injected and the email transport mocked. The test drives the capture and the jobs by calling their functions directly.

- [ ] **Step 1: Write the failing tests**

```ts
it('report mode never disables: the full Entra and Google pipelines record reported actions only');    // inv. 12
it('enforce: an Entra user with account_enabled=false is disabled after the first-enforcement hold is applied');
it('enforce: absent in two complete snapshots ≥ 4 h apart after membership → disabled; one snapshot → not');
it('half the tenant vanishes in one complete snapshot: nothing applied (suspect_shrink)');           // RF1
it('a newer run\'s partial chunks never reach an evaluation');                                        // RF1
it('a truncated run, a disconnect and a re-consent change nothing');                                  // RF1
it('a google identity from another workspace is never deprovisioned');                               // RF2
it('an entra identity for another tenant is out of scope');                                          // RF2
it('a run for org A never disables an identity in org B');                                            // inv. 4
it('a disabled identity cannot sign in, exchange an add-in token, be re-linked or come back as a new person'); // RF5
it('restore + reactivate lets the person sign in again; the next run reports but does not re-disable'); // RF4
it('org merge: the absorbed org\'s held run refuses Apply and its identities restart membership');
it('deleting a portal user removes its actions; cascade and export registrations hold');
```

- [ ] **Step 2: Run them; verify they fail, then pass once Tasks 1–8 are in.**
- [ ] **Step 3: Typecheck and sweep**

```bash
NODE_OPTIONS=--max-old-space-size=20480 pnpm exec tsc --build apps/api/tsconfig.tests.json; echo "exit=$?"   # exit=0
cd packages/shared && npx tsc --noEmit; echo "exit=$?"
cd apps/m365-graph-read-executor && npx tsc --noEmit; echo "exit=$?"
cd apps/api && npx vitest run --pool=forks --poolOptions.forks.maxForks=4 --changed origin/main
cd apps/api && npx vitest run --pool=forks --poolOptions.forks.maxForks=4 src/__tests__/
```

- [ ] **Step 4: Integration and contract suites** on the test stack:
  - the new file;
  - `portalOidcSignIn`, `portalUserIdentities`, `portalAccessRequests`, `portalAccessPolicyEnforcement`, `loginContactLinking`, and the M365 sync integration files;
  - `DB_CONTEXTLESS_WRITE_STRICT=true pnpm --filter=@breeze/api test:rls-coverage`;
  - `tenant-export-policy`, `tenantExportErasureRoundtrip`, `orgCascade`;
  - `pnpm --filter @breeze/api test:integration-suite-coverage`.
- [ ] **Step 5: Review and PR.**
  - One independent review round (`superpowers:requesting-code-review`).
  - `pnpm test-stack down`, and say so.
  - PR body:
    - `Part of #11385`;
    - the rule-9 statement;
    - D1–D14 and the quorum table;
    - "ships report-only";
    - the M365 executor's malformed-item change;
    - the new outbound Google read;
    - the migration name;
    - the rollout gate (version parity before ENFORCE).

---

## W08b — Web + docs + lab leg

### Task 10: MSP panel, badge and Restore

**Files:**
- Create: `apps/web/src/components/settings/portalAccess/DirectoryDeprovisioningPanel.tsx` (+ test), rendered by `OrgSignInRegistrationCard.tsx` below the domains row. Types go in `portalAccess/types.ts`.
- Modify: `apps/web/src/components/settings/OrgPortalUsersEditor.tsx` (+ test) to add a per-identity badge and a Restore dialog.
- Add locale keys in all 8 locales under `portalDirectory.*`. Sonnet-eligible fan-out.

Behaviour:
- **Panel** (`data-testid="portal-directory-panel"`):
  - A mode line: "Report only: nobody is disabled automatically yet", or "On".
  - Per source (Microsoft, Google): the last run's time, outcome and reason in plain words. Examples:
    - `sync_incomplete` / `unavailable`: "The last directory read was incomplete, so nothing changed."
    - `directory_too_large`: "This directory is larger than the sync limit; deprovisioning is unavailable."
    - `scope_missing`: names the scope.
    - `tenant_not_proven`: links to the tenant panel.
  - An open-actions table: person, provider, reason, and "Disables the account" or "Turns off Microsoft/Google sign-in only". Rows can carry a "Keeps password access" tag, or the rearm tag ("Restored or dismissed by your team; the directory still reports this person disabled").
- **A held run** shows **Apply** (`data-testid="portal-directory-apply"`) and **Dismiss**. Each opens a confirm dialog that repeats the count and the hold reason ("first time for this directory" / "more people than usual") and sends the run's `impactDigest`. Both go through `runAction`.
- **Users list:** a "Sign-in disabled by directory" badge (`data-testid="identity-directory-disabled"`) that names every blocker. The account status shows "disabled by your team" or "disabled by directory". **Restore** opens a dialog with an "Also re-enable the account" checkbox. When `disabledBy` is `msp`, the dialog adds a second explicit confirmation.

- [ ] **Step 1: Write the failing tests**

```ts
it('report mode shows the report-only line and the planned actions, with no Apply button');
it('a held run shows Apply and Dismiss with the count, hold reason and digest');
it('an incomplete run explains that nothing changed and names the reason');
it('keeps-password and rearmed rows carry their tags');
it('the users list badges a directory-disabled identity with its blockers; Restore posts reactivateAccount');
it('restoring an msp-disabled account asks for the second confirmation');
it('apply, dismiss and restore go through runAction');
```

- [ ] **Step 2: Run them; verify they fail.**
- [ ] **Step 3: Implement; fan out the locale keys.**
- [ ] **Step 4: Run** the tests, `no-silent-mutations.test.ts`, locale parity, `translationCoverage.test.ts`, `keyUsage.test.ts` and `humanizedKeyRegression.test.ts` → PASS.
- [ ] **Step 5: Commit**: `feat(web): directory deprovisioning panel, badge and restore (W8)`

### Task 11: Docs

**Files:**
- Create: `apps/docs/src/content/docs/features/portal-directory-deprovisioning.mdx`. It covers:
  - what it does, and what it does **not** do: turning off a sign-in method is not offboarding a person, so cover "keeps password access" and how to disable such an account by hand;
  - the evidence rules in plain words: complete reads only; absence twice, hours apart, after the person was seen; disabled or suspended at once;
  - report-only mode and the first-enforcement hold per directory;
  - the hold thresholds;
  - Restore and Dismiss, and what "restored by your team" means over time;
  - what never happens: re-enabling in Entra or Google restores nothing, and disconnecting M365 deprovisions nobody;
  - a person deleted and recreated in the directory (D14 / OD3);
  - Entra requirements: a proven tenant equal to the M365 connection's tenant; users sync on; directories above the sync's user limit show "unavailable", with SCIM as the fallback;
  - Google requirements: the existing domain-wide-delegation grant, with the connection's admin still an admin; the pass runs daily;
  - for self-hosters: `PORTAL_DIRECTORY_DEPROVISION_ENFORCE` and the rollout advice (report first).
- Modify: `features/portal.mdx` (add the link), `deploy/environment.mdx` (the env row; Task 5's compose mapping exists, so `envReadComposeCoverage` passes), and the `apps/docs/astro.config.mjs` sidebar. Regenerate the index with `npx tsx scripts/build-docs-index.ts`.

- [ ] **Step 1:** Write the docs and regenerate the index. Sonnet-eligible; use generic placeholders only.
- [ ] **Step 2:** Run the API docs-index tests → PASS.
- [ ] **Step 3: Commit**: `docs(portal): directory deprovisioning for MSPs and self-hosters (W8)`

### Task 12: Browser check, lab leg, report review, W08b gate

- [ ] **Step 1: Browser check** with the `feature-testing` skill on a `worktree-stack`. Seed data by SQL: runs and actions in the report, held and applied states, and a rearmed identity. Check:
  - the report-only panel;
  - a held run's Apply and Dismiss;
  - the badge, and Restore with reactivation, including the MSP-disabled confirmation;
  - an incomplete run's explanation.

  Tear the stack down and say so.
- [ ] **Step 2: Gate.**
  - `astro check` and `tsc` exit 0 in `apps/web`.
  - `npx vitest run --pool=forks --poolOptions.forks.maxForks=4 --changed origin/main` is green in `apps/web`.
  - The API docs-index tests are green.
  - One independent review round.
  - PR body: `Closes #11385`, the rule-9 statement, screenshots, and the lab-leg results or "lab leg owed" with the list below.
- [ ] **Step 3: Lab leg — owed live checks.** This is the operator gate before `PORTAL_DIRECTORY_DEPROVISION_ENFORCE` is set anywhere. See **Owed live checks** below. Record each result in the W08b PR, or as a follow-up comment on #11385.
- [ ] **Step 4: Report review.** The operator runs this after at least 14 days of report mode in a region. Use a read-only SQL query over `portal_directory_runs` and `portal_directory_actions`, grouped by org, source, outcome, reason and disposition. Check that:
  - (a) no org shows planned actions for people who still work there (an MSP spot-checks a sample);
  - (b) the `suspect_shrink` and `incomplete` rates are explained;
  - (c) no run planned more than a threshold without a known cause.

  Record the counts (no names) on #11385.
- [ ] **Step 5: Commit** any doc fixes from the lab leg: `docs(portal): directory deprovisioning lab-leg corrections (W8)`.

---

## Owed live checks

None of these can be proven in CI or on a local stack. Each needs either a real Entra tenant with the `customer-graph-read` connection and a proven tenant, or a real Google Workspace with a domain-wide-delegation grant. Enforcement stays off in every region until they pass (Task 12 Step 3).

**Entra**
- E1. Disable a lab user in Entra. The next complete users sync stores `account_enabled = false` on the row whose `graph_id` equals the portal identity's `oid`.
- E2. A soft-deleted user drops out of `/users`, and the next complete run marks it stale. Restored from deleted items, it comes back with the **same** object id.
- E3. `User.Read.All` (application) returns a boolean `accountEnabled` for every member user on the sync's `$select`. Record any `null`.
- E4. A throttled or interrupted users run is recorded as truncated and produces no W8 run with actions. A users page with a malformed item (injected through the executor's test seam on the lab stack) produces `incomplete`.
- E5. Disconnecting and re-consenting M365 produces no action, and the chain restarts (a new `consent_generation`).
- E6. End to end on a lab tenant:
  1. A report run lists the disabled user.
  2. Enforcement is turned on, and the first-enforcement hold appears.
  3. Apply.
  4. The person's browser and add-in sessions end on the next request.
  5. Microsoft sign-in shows the generic refusal.
- E7. Graph replication: a user deleted and immediately listed. Record how long `/users` keeps returning it, and confirm the 4 h spacing covers it.

**Google**
- G1. The OIDC `sub` of a Workspace user equals the Admin SDK `users.id` of the same user. **Google enforcement is blocked until this passes.**
- G2. A JWT that asks only for `admin.directory.user` succeeds against a delegation grant listing the six `DIRECTORY_SCOPES` (a subset request is accepted).
- G3. A suspended user has `suspended: true` and an archived user `archived: true`. Record whether `false` values are returned or omitted. A deleted user is absent from `users.list`. Every user carries the anchor's `customerId`.
- G4. Pagination over more than 500 users completes inside the deadline. Record the page count and wall time for the largest lab Workspace.
- G5. A revoked delegation grant, or an admin demoted from admin, gives `scope_missing`, `access_denied` or `admin_not_admin`, a recorded `incomplete` run and no action.
- G6. An undeleted (restored) user comes back with the same `id`.

**Product**
- P1. The held-run email reaches partner admins and links to the right org tab.
- P2. Restore with reactivation lets the person sign in through the IdP again once they are re-enabled there.

## Execution split and parallelism

**W08a (API + jobs)**
- **SERIAL first:** T1. The schema gates every real-DB test.
- **PARALLEL GROUP A1 (file-disjoint):**
  - **T2**: identity readers, account state, sso-only, the add-in exchange, display readers.
  - **T4**: the pure `evaluate.ts`.
- **SERIAL:** T3 after T2. It uses the writer, the lock helper and the usable-identity facts.
- **SERIAL:** T5 after T3 and T4.
- **PARALLEL GROUP A2 (after T5):**
  - **T6**: the executor, `users.ts`, `hooks.ts`, `entraCapture.ts`, `queue.ts`, `worker.ts`, the registries.
  - **T7**: `googleClient.ts`, `googleSource.ts`.

  T7's job names go into T6's worker dispatcher by Interfaces. Land T6's `worker.ts` skeleton first, or merge the dispatcher at review.
- **SERIAL:** T8 after T5.
- **SERIAL last:** T9.
- **Sonnet-eligible:** T1's Drizzle mirror and export entries; T5's env, compose and validate plumbing and its email copy; T6's registry and schedule edits; T8's list-field plumbing and locale labels.
- **Opus:** T1's migration and RLS; T2, T3 and T4 entirely; T5's run store; T6's capture fence and executor change; T7's listing completeness; T8's apply and restore routes; T9; and review of all Sonnet output.

**W08b**, branched from fresh main after W08a merges
- **PARALLEL GROUP B1:** **T10** (`apps/web/**`, locales) and **T11** (`apps/docs/**`).
- **SERIAL last:** T12.
- **Sonnet-eligible:** T10's locale fan-out and table, and T11.
- **Opus:** T10's apply and restore dialogs, T12, and review of B1.

**CPU:** never more than one `tsc` at a time across a group. Each implementer runs only its own files, with `maxForks=4`. The `--changed origin/main` sweep runs once, in T9 / T12.

## CI traps

- **Premise.** Re-check every name in "Builds on" against main before T1; W7 may have renamed a reader. Re-check the two fence facts in T6 Step 0.
- **Stacked PRs get no CI.** W08b branches from main after W08a merges. If it must open early, run `gh workflow run CI --ref <branch>`.
- **Integration suites do not run under `pnpm test`.** `rls-coverage`, `tenant-export-policy`, `tenantExportErasureRoundtrip`, `orgCascade` and the new file run only under Integration Tests. Run them locally in T9.
- **Org-cascade registration is not implied by RLS.** Both new tables must be in `CORE_ORG_CASCADE_DELETE_ORDER`, `orgMergeRegistry.ts` and `CORE_TENANT_EXPORT_POLICY`. The new identity columns and `portal_users.disabled_by` need export classification. Grep, don't judge.
- **Integration-suite map.** `services/portalDirectory/**` matches `services/portal*`. `routes/orgPortalDirectory.ts`, `services/m365Sync/hooks.ts` and `services/googleClient.ts` need `suite portal sources` lines if `test:integration-suite-coverage` names them.
- **Writer census.** `identityDisable.ts` and `routes/orgPortalUsers.ts` write `portal_users.status` and `disabled_by`, so they are `state-module` entries. `runStore.ts` and `entraCapture.ts` write no `status`, so they are `no-state` entries with a reason, or the census fails.
- **Identity-fact contract.** A new call of `portalUserHasIdentitySql` or `portalUserHasUsableIdentitySql` without a classification entry fails `portalIdentityFacts.contract.test.ts`.
- **W4/W7 suites are a gate.** T2 edits `accountResolution.ts`, `oidcShared.ts` and `clientAiExchange.ts`. Their existing tests pass unchanged except for the added cases. A W4 test edited "to fit" is a review blocker.
- **The M365 hook.** `run.ts` swallows hook throws, but a throw inside `afterDomainPersisted` before the posture rollup would skip the rollup. The capture is the hook's **last** step, with its own catch. Its 5 s `lock_timeout` keeps a slow lock from stalling the sync worker.
- **Executor rolling deploy.** The API must treat a missing `malformedItems` as 0. An API that required the field would turn every run incomplete while old executors still serve.
- **Workers and schedules.**
  - A `workerRegistry` entry (`load` → `{ init, shutdown }`).
  - A `workerReadinessManifest` name equal to the `attachWorkerObservability` name.
  - The name in registry order in `workerEntrypointClosure.contract.test.ts` and `workerRegistry.test.ts`.
  - Unique minutes in `scheduleRegistry.contract.test.ts`.
  - BullMQ job ids contain no colons.
- **`.env.example`, config validation and compose.** `PORTAL_DIRECTORY_DEPROVISION_ENFORCE` goes into `.env.example`, `config/validate.ts`, `docker-compose.yml` and `deploy/docker-compose.prod.yml`. A doc row in `deploy/environment.mdx` without a compose mapping fails `envReadComposeCoverage`.
- **Audit.** Background rows are inserted in the action's transaction. There is no request context, so `markRequestAuditWritten()` does not apply. The new resource type `portal_directory_run` is labelled in all 8 locales (`auditResourceTypeLabels.test.ts`).
- **Mail purposes.** An unregistered purpose throws at send; `mailPurposes.test.ts` enumerates them.
- **Migration slot.** `2027-01-24-180000` must still sort after the newest file on `origin/main` at enqueue. A sibling migration landing first poisons the merge queue (Check Migrations). Run `pnpm db:check-drift`. The `disabled_by` backfill means the file writes rows, so the system-scope line is required (`migrationRlsScope.test.ts`).
- **No network in tests.** Inject the Google reader; seed `m365_users` and the sync state by SQL; stub the executor. A test that reaches Google or Graph hangs CI.
- **Customer-PII guard.** Test and doc addresses use `example.com`, `*.example.com` or `.test`.
- **Typecheck heap.** API `tsc` needs a 20 GB heap. Check `exit=$?`, never `| tail`.
- **Docs index.** Changing any `.mdx` without regenerating `docsIndex.json` fails the docs-index test.

## Out of scope

- **W9:** the SCIM endpoint, tokens and provisioning (D13).
- An MSP "unlink identity" or "remove disabled sign-in" action (OD3). The `msp` blocker is reserved for it.
- A per-org or partner deprovisioning setting (OD1).
- Notifying the deprovisioned person. They have left, and an email to their old address is noise or a leak.
- Caching Workspace users in a table; Google Groups or OU scoping.
- Deprovisioning password-only accounts. No directory evidence links them to a directory object.
- Entra tenants above the M365 sync's user limit. They get a visible "unavailable" state, with SCIM as the fallback (D4).
- An AI tool for directory deprovisioning.

## Self-review

1. **Spec coverage (§5.11 W8, §6 invariant 12, §7 W8 row):**
   - "Only from complete, current-tenant `m365_users` snapshots": D4. The sync's completeness, the malformed-item rule, the connection tenant equal to the proven tenant, and the generation fence → T6.
   - "Truncated runs never establish absence": D4, D5 → T6, T9.
   - "A disconnect never counts as deletion": D4, plus the incarnation in D5 → T6.
   - "Run deduplication": the `snapshot_key` unique, the generation fence and `directory_last_run_id` → T4, T5, T6.
   - "`account_enabled=false`, or absent from two consecutive complete snapshots": D5 → T4.
   - "Google: the same, from a daily Directory API pass (`suspended`, deleted)": D11 → T7. `archived` → OD5.
   - "Effect: the provider disables the identity; with no other usable credential the account is disabled (epoch bumped, sessions purged, audit with source)": D1, D2 → T3.
   - "An MSP-set `disabled` is never reversed by a provider": D2 (`disabled_by`, no-op) → T2, T3.
   - "Re-enabling in the IdP does not auto-reactivate": D9 → T4, T9.
   - Invariant 12 → named tests. §10 inline vs job → D10. §8 docs → T11.
   - SCIM boundary → D13.
2. **Step scan.** Every code step names its file and signature. The SQL is given in full as the spec of record. Bodies are left to the implementer, except the decision rules the tests do not determine on their own (D5, D6, D8d), which are stated as rules, not code.
3. **Type consistency.** These are used identically across T1–T12:
   - types: `DirectorySource`, `IdentityBlocker`, `IdentityDisabledReason`, `DisableIdentityInput`, `DisableIdentityResult`, `DirectoryObservation`, `InScopeIdentity`, `EvaluateInput`, `EvaluateResult`, `PlannedAction`, `RunRefusalReason`, `RunDisposition`, `GoogleListing`, `DirectoryUsersReader`, `PortalIdentityOwner`;
   - functions: `disablePortalIdentity`, `restorePortalIdentity`, `previewAccountEffect`, `retryPendingPurges`, `evaluateDirectorySnapshot`, `holdReasonFor`, `recordRefusedRun`, `recordEvaluatedRun`, `afterRunCommitted`, `applyRun`, `dismissHeldRun`, `pruneDirectoryRuns`, `impactDigestOf`, `notifyDirectoryRunHeld`, `isDirectoryDeprovisionEnforced`, `captureEntraDirectoryRun`, `enqueueApplyRun`, `getDirectoryUsersReader`, `listGoogleDirectoryUsers`, `runGoogleSweep`, `evaluateGoogleOrg`, `portalUserHasUsableIdentitySql`, `lockIdentityForAccount`, `passwordUsableFor`;
   - names and codes: `directory_deprovision`, `identity_disabled`, `disabled_by`, `disabled_blockers`, and the error codes in Global Constraints.
4. **Review Focus.** All five lines have named tests in their owning tasks (T2–T9).
5. **Proportion.** Decisions, interfaces, the migration and test names; no transcribed bodies. The plan is long because the wave has two sources, a new state on a security-critical table and a quorum that changed four decisions. The task bodies stay at signature level.
