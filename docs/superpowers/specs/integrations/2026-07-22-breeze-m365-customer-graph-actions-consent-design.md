# Breeze M365 Customer Graph Actions — Consent & Onboarding — Design Spec

## 1. Summary

The `customer-graph-actions` mutation path is fully built (executor sidecar on port 3004,
headless worker dispatch, sealed reset-password reveal — PRs #2628, #2693) but **cannot be
turned on for a real customer tenant**: there is no way for a customer admin to grant the
actions app its Graph permissions. This phase adds the missing onboarding layer — admin
consent, PKCE identity verification, exact grant reconciliation, connection lifecycle, and a
management UI card — for the `customer-graph-actions` profile, reusing the shipped
`customer-graph-read` consent machinery (hybrid: share the risky internals, thin per-profile
seams on top). It also folds in the two security follow-ups that gate safe enablement (seal
parity on the inline result path; a boot-time key-id assertion) and the deploy plumbing
(executor compose service block + runbook) that #2628 deferred.

When this ships, a customer admin can consent the actions app for one allowlisted org,
reconciliation confirms exactly the granted scopes, the connection goes active, and an
approved `m365_reset_password` / `m365_disable_user` intent executes headless against that
tenant.

## 2. Goals

- Customer admins can grant the `customer-graph-actions` app its least-privilege Graph
  application permissions via a two-phase admin-consent + identity-verification flow that
  mirrors the shipped read flow.
- Grant reconciliation is **exact**: only the two in-use scopes are requested, and any
  divergence (missing or extra grants) is surfaced as connection health, not silently
  tolerated.
- The consent orchestration is shared with the read profile so a bug fix or hardening in the
  session/reconciliation logic applies to both — no drift in an auth surface.
- Ships dark, per-org allowlisted, with a real-tenant acceptance runbook, and is safe to
  enable in prod (encryption key-id present, executor deployable via compose).

## 3. Non-goals

- **No new write actions.** The catalog stays the two shipped tools (`m365.user.disable`,
  `m365.user.reset_password`). Group / Intune / Sites actions are future work and require a
  manifest version bump + re-consent (see §4).
- **No change to the executor, headless dispatch, intent, or reveal paths** — those shipped
  and are untouched here except the seal-parity fix in §11.
- **No consolidation of the other Microsoft token paths** (legacy-direct, c2c, ticket-mailbox,
  add-in, sso). That is the separate consumer-migration phase.
- **No delegated / user-owner flow.** The actions profile is organization-owner,
  application-certificate auth only.

## 4. Locked decisions

Inherited invariants (not re-litigated here):

- **Credential-domain separation is locked.** The actions profile has its own Azure app
  registration (`M365_CUSTOMER_GRAPH_ACTIONS_CLIENT_ID`), its own certificate / AKV secret
  (`m365-customer-graph-actions`), and its own executor (port 3004, audience
  `m365-graph-actions-executor`). Consent targets the **actions app registration**, never the
  read app. An org may onboard actions independently of read (neither requires the other).
- **Organization-owner, application-certificate** auth mode, `graph-actions` executor kind.

Decided this session:

- **Least-privilege consent.** The consent manifest and reconciliation enforce exactly the two
  scopes the executor uses today: `User.ReadWrite.All` and
  `User-PasswordProfile.ReadWrite.All`. The four other scopes currently declared on the
  profile (`Group.ReadWrite.All`, `DeviceManagementManagedDevices.PrivilegedOperations.All`,
  `DeviceManagementConfiguration.ReadWrite.All`, `Sites.ReadWrite.All`) are removed from the
  requested/enforced set and recorded as a `// roadmap` comment. Adding a future action =
  manifest `version` bump + customers re-run admin consent.
- **Hybrid share-vs-copy.** Parameterize the risky shared internals (consent-session
  lifecycle, grant reconciliation) by profile; keep a thin per-profile route + UI card.

## 5. Trust boundaries and flow

The control-plane boundary and executor boundary are identical in shape to the read flow
(design: `2026-07-14-breeze-m365-customer-graph-read-consent-design.md` §5). The only
differences are the target app registration, credential domain, and executor endpoint — all
resolved from the profile manifest + profile-keyed config rather than hardcoded.

Two-phase flow (unchanged in shape from read):

1. **Initiate.** `POST /connections/customer-graph-actions/consent` creates an
   `m365_consent_sessions` row (`profile='customer-graph-actions'`), returns the Microsoft
   admin-consent URL built for the actions app `client_id`.
2. **Admin-consent callback.** Microsoft redirects back after the customer admin grants the
   app-level permissions; the callback records the tenant id and advances the session.
3. **Identity callback + executor verification.** A PKCE-bound identity redirect proves the
   consenting admin's identity; the **actions executor** (not read) is asked to acquire an
   app token for the customer tenant using the actions certificate and to reconcile granted
   app-roles against the manifest.
4. **State outcome.** On exact match → connection `active`; on missing grants →
   `degraded`/`pending` with the specific gap; on identity mismatch → failed.

## 6. Credential model

Unchanged from the shipped actions executor: the actions certificate lives only in the
executor's AKV domain (`m365-customer-graph-actions`); the API never holds it. The API's role
in consent is orchestration and reconciliation-result recording only. Token acquisition for
reconciliation happens **inside the actions executor** via `graphActionsExecutorClient` (EdDSA
body-hash internal auth, already shipped).

## 7. Data model and profile manifest

**No new tables**, but **one migration is required**:

- `m365_consent_sessions.profile` today carries a Postgres `CHECK (profile =
  'customer-graph-read')` and a Drizzle `.$type<'customer-graph-read'>()`. Reusing the table
  for actions requires an idempotent migration to widen the CHECK to
  `profile IN ('customer-graph-read','customer-graph-actions')` and a schema type change to
  the union. (`m365_connections` already permits `customer-graph-actions` — its
  `verifiedTenantProfileUniq` lists it — so no change there.) Actions rows use
  `profile='customer-graph-actions'`.
- `m365_connections` — profile-discriminated, dual-axis RLS; actions rows are org-owner,
  `profile='customer-graph-actions'`, `credential_domain='customer-graph-actions'`.

The two app-role assignments added to the actions manifest (§7 below), for reference:
`User.ReadWrite.All` → `204e0828-b5ca-4ad8-b9f3-f32a958e7cc4`;
`User-PasswordProfile.ReadWrite.All` → `56760768-b641-451f-8906-e1b8ab31bca7` (resource =
Microsoft Graph `00000003-0000-0000-c000-000000000000`). These are asserted in
`profiles.test.ts` and re-verified against the tenant's Graph service-principal `appRoles`
during real-tenant acceptance.

**`packages/shared/src/m365/profiles.ts`** — the only shared change:

- Trim `customer-graph-actions.applicationPermissions` to the two in-use scopes; move the
  other four to a `// roadmap (needs version bump + re-consent):` comment.
- Add `customer-graph-actions.applicationPermissionAssignments` with the two Microsoft Graph
  app-role assignments (resource application id `00000003-0000-0000-c000-000000000000`):
  - `User.ReadWrite.All` → app-role id sourced from the Graph service principal and asserted
    in `profiles.test.ts` (do not invent the GUID; verify against the Graph app-role catalog
    the read profile was built from).
  - `User-PasswordProfile.ReadWrite.All` → likewise.
- `version` stays `1` (the profile has never been consented in any environment, so there is no
  expand-phase compatibility concern; a value change here is not a migration event).

`profiles.test.ts` gains assertions that the actions profile's requested scopes,
`applicationPermissionAssignments`, and `canonicalGrantKey` set are exactly the two, matching
the read-profile test pattern.

## 8. Consent protocol (hybrid implementation)

**Parameterize the shared internals by profile.** Investigation showed the read internals are
hardcoded more deeply than a single constant — `connectionService.ts` closes over `PROFILE =
'customer-graph-read'`, the read executor client, the read config loader, and read-named
metrics; the callback is single-profile by construction (its browser-binding cookie has no
profile field). The hybrid is therefore a **factory**, not an in-place edit:

- `services/m365ControlPlane/consentSessionService.ts` — replace the module-level
  `CUSTOMER_GRAPH_READ_PROFILE` constant with a `profile: M365ConnectionProfile` field on the
  input interfaces (`ConsentSessionOwnerInput`, `ConsentSessionAttemptInput`,
  `ConsumeConsentSessionInput`), threaded to all five query sites. Read call sites pass
  `'customer-graph-read'`; the read test suite is the regression guard.
- `services/m365ControlPlane/connectionService.ts` — extract a
  `createConnectionService({ profile, manifest, loadRuntimeConfig, createExecutorClient,
  recordEvent, recordMetric })` factory returning the existing export set
  (`initiateConsent`, `markAdminConsentReturned`, `transitionAdminConsentToIdentity`,
  `applyIdentityVerificationResult`, `retestConnection`, `disconnectConnection`,
  `listConnections`). `deriveGrantHealth` is already manifest-parameterized — no change.
  `connectionService.ts` (read) becomes a thin instantiation; a new
  `writeActionConnectionService.ts` is the actions instantiation.
- **Executor consent endpoints (new work — not in the shipped actions executor).** The actions
  executor (`apps/m365-graph-actions-executor/`) currently exposes only `execute-action`; the
  consent flow calls `completeIdentityVerification` and `retest` on the executor client. Add
  `POST /v1/complete-consent` and `POST /v1/retest` to the actions executor app (mirroring the
  read executor's handlers + `reconcile.ts`, re-keyed to the actions certificate/audience), and
  add `completeIdentityVerification(...)` + `retestCustomerGraphActions(...)` to
  `graphActionsExecutorClient.ts`. The shared request/result types
  (`CompleteConsentRequest/Result`, `RetestRequest/Result`) already exist and are
  profile-agnostic.
- `routes/m365ConsentCallback.ts` — the callback is a factory `createM365ConsentCallbackRoutes(
  overrides)`. Instantiate a second, actions-profile instance (profile override +
  actions redirect path `/integrations#m365/customer-graph-actions/<outcome>` + actions config
  loader + actions executor client) rather than widening the read binding cookie. Mount it on
  its own callback path.
- `services/m365ControlPlane/metrics.ts` — read-named (`m365.customer_graph_read.*`); add an
  actions metrics surface (or parameterize by profile) so consent/reconcile/disconnect events
  emit under an actions-scoped name.
- `services/m365ControlPlane/microsoftAuthorization.ts` — already takes `clientId`; no change.

**Thin per-profile route** `routes/m365CustomerGraphActions.ts` (mirror of
`m365CustomerGraphRead.ts`, ~parallel structure):

- `POST /connections/customer-graph-actions/consent` — initiate.
- `GET /connections/customer-graph-actions` — management view (state, grant health, required
  vs granted).
- disconnect / reconcile endpoints matching the read route's verbs.
- Mounts the shared services with `PROFILE_ID = 'customer-graph-actions'` and the actions
  manifest.

**Dark gating:** every actions onboarding endpoint is gated on
`M365_CUSTOMER_GRAPH_ACTIONS_ONBOARDING_ENABLED` **and** org membership in
`M365_CUSTOMER_GRAPH_ACTIONS_ONBOARDING_ORG_IDS`, exactly like the read pair. Both are
boot-validated (see §10).

## 9. Grant reconciliation and health

The read executor's `reconcile.ts` diffs granted app-roles against a manifest's
`applicationPermissionAssignments`. That logic is re-keyed into the actions executor's new
`complete-consent`/`retest` handlers (§8) against the actions certificate/audience; once the
actions manifest carries its two assignments, reconciliation runs the same exact diff.
Reconciliation is **exact** — a granted role beyond the two required is reported as drift, and
a missing role blocks `active`. Health is surfaced on the management view and drives the
connection lifecycle state (§10), reusing the profile-agnostic `deriveGrantHealth`.

## 10. Lifecycle, config, and boot validation

- Connection lifecycle reuses the read state machine (pending → verifying → active →
  degraded/revoked) with no new states.
- New config keys (mirroring the read onboarding pair; the executor/credential keys —
  `M365_CUSTOMER_GRAPH_ACTIONS_CLIENT_ID`, `_VAULT_REF`, `_CREDENTIAL_VERSION`,
  `M365_GRAPH_ACTIONS_EXECUTOR_*` — already exist from #2628):
  - `M365_CUSTOMER_GRAPH_ACTIONS_ONBOARDING_ENABLED` (default `false`).
  - `M365_CUSTOMER_GRAPH_ACTIONS_ONBOARDING_ORG_IDS` (allowlist).
- **Boot validation** (`config/validate.ts` + `config/env.ts`), mirroring read:
  - When onboarding is enabled, require `M365_CUSTOMER_GRAPH_ACTIONS_CLIENT_ID` (uuid) and the
    actions executor signing config to be present and well-formed.
  - **New key-id assertion (security follow-up):** when
    `M365_GRAPH_ACTIONS_TOOLS_ENABLED=true`, require `APP_ENCRYPTION_KEY_ID` (and
    `APP_ENCRYPTION_KEY`) to be present — otherwise the reset-password reveal fails closed
    silently at runtime (the seal guard refuses non-v3 ciphertext). This turns a latent
    runtime failure into a boot error. Covered by a `validate.test.ts` case.

## 11. Security follow-ups (in scope this phase)

- **Seal parity on the inline result path.** The reset-password temporary credential must be
  stored sealed at rest identically regardless of which dispatch path produced it, so that
  both paths present the same sealed shape to the reveal endpoint and reaper sweep. This is a
  narrow, self-contained change kept as its own commit. (Described at this altitude
  deliberately — the spec lives in the public repo; implementation detail and the pre-fix
  window belong in the internal notes, not here.)
- **Boot-validator key-id assertion** — see §10.

Both items are gated by / paired with enablement, which is why they ride in this phase rather
than being left as open follow-ups when the feature is turned on.

## 12. Management UI

- New `apps/web/src/components/integrations/M365CustomerGraphActionsCard.tsx`, mirroring
  `M365CustomerGraphReadCard.tsx`: connect (initiate consent), reconcile, disconnect,
  grant-health display (required vs granted, the two scopes), and dark-flag/allowlist gating
  so the card only renders for enabled orgs.
- All mutations go through `runAction` per the web mutation-handler contract.
- i18n keys added across all five locales (key parity is CI-enforced).

## 13. Audit and observability

- Reuse the read flow's audit events and the `metrics.ts` counters, parameterized by profile
  (`M365_CUSTOMER_GRAPH_*_EVENTS/_OUTCOMES` gain the actions profile label rather than a new
  metric family where the existing one is profile-tagged; add actions-specific counters only
  where the read counter name is literally read-scoped).
- Consent initiation, admin-consent callback, identity verification result, reconciliation
  outcome, and disconnect each emit an audit row scoped to the org. No secret material is ever
  logged.

## 14. Failure and concurrency behavior

Inherit the read flow's guarantees: consent-session single-use, callback idempotency, exact
grant reconciliation, uniform not-found responses on management lookups for un-onboarded /
un-allowlisted orgs, and org-scoped RLS on all reads/writes. Cross-org and cross-profile
access must fail closed — an actions consent session for org A must never be advanceable under
org B, and a read connection must never satisfy an actions reconciliation.

## 15. Verification strategy

### 15.1 Automated tests

- **Unit:** `profiles.test.ts` (actions manifest = exactly two scopes + two assignments);
  parameterized `consentSessionService.test.ts` (read + actions both green — proves the shared
  refactor did not regress read); `m365CustomerGraphActions.test.ts` route authz + dark
  gating; `validate.test.ts` boot cases (onboarding-enabled requires client id; tools-enabled
  requires `APP_ENCRYPTION_KEY_ID`).
- **Integration (real Postgres :5433):** actions consent-session lifecycle end-to-end;
  reconciliation happy path + missing-grant + extra-grant drift; **cross-org fail-closed**;
  **cross-profile fail-closed** (read connection cannot satisfy actions); dark-flag off →
  endpoints 404.
- **Web:** `M365CustomerGraphActionsCard` render/gating + `runAction` success/failure; i18n
  parity.

### 15.2 Real-tenant verification

New runbook `docs/runbooks/m365-customer-graph-actions-real-tenant.md` (companion to the read
runbook): onboard one allowlisted org against a real customer tenant, confirm reconciliation
shows exactly the two grants, drive an approved `m365_reset_password` intent through headless
execution, and confirm the one-time reveal.

## 16. Deploy plumbing and rollout

- **Executor deployment = standalone, NOT the generic compose stack** (decision, revised from
  the original "add a compose service block" plan). Implementation surfaced that the shipped
  **read** executor is *not* in the repo's generic `docker-compose.yml` either — it is deployed
  standalone per its own runbook, and the compose files carry a comment that the credential-bearing
  executors are intentionally excluded from the generic stack. Adding the actions executor to the
  generic compose would (a) diverge from the read executor's model and (b) place a credential-bearing
  service into the generic stack while it still lacks CI build / Trivy / digest-pinning coverage —
  strictly worse. So the actions executor deploys standalone (private-bind, port 3004, AKV secret
  `m365-customer-graph-actions`, signing JWK, audience `m365-graph-actions-executor`), documented in
  its deploy runbook — mirroring the read executor. What the generic compose DOES need, and now has,
  is the **API-side** env threaded through the `api` service `environment:` block on both compose
  files (`APP_ENCRYPTION_KEY_ID`, `M365_CUSTOMER_GRAPH_ACTIONS_ONBOARDING_ENABLED`/`_ORG_IDS`) —
  previously present in `.env.example` but unmapped, which would have made the feature un-enable-able.
  Follow-up (out of scope here): give the actions executor the same CI/release/hardening coverage the
  read executor has.
- **Runbook** `docs/deploy/m365-customer-graph-actions-executor.md` (companion to the read
  deploy runbook) documenting the required droplet env vars, explicitly including
  `APP_ENCRYPTION_KEY_ID` / `APP_ENCRYPTION_KEY` mapped through both `/opt/breeze/.env` and the
  compose `environment:` block (necessary-but-not-sufficient rule), and the enablement order.
- **Rollout:** ships dark (`_ONBOARDING_ENABLED=false`). Enable per-org via the allowlist only
  after real-tenant acceptance. `M365_GRAPH_ACTIONS_TOOLS_ENABLED` (execution gate) stays
  independently controlled and is turned on only once at least one org has an active actions
  connection.
- **Rollback:** flip `_ONBOARDING_ENABLED=false` and/or empty the allowlist; existing
  connection rows remain but no new consent can be initiated. Execution is separately
  disable-able via the tools flag.

## 17. Acceptance criteria

1. A customer admin, for one allowlisted org, completes admin-consent + identity verification
   against the **actions** app and the connection reconciles to `active` with exactly the two
   grants.
2. Requesting a third scope (or missing one) is reported as drift and blocks `active`.
3. The shared `consentSessionService` refactor leaves the read flow's test suite fully green.
4. With onboarding disabled or the org not allowlisted, all actions onboarding endpoints 404
   and the UI card does not render.
5. Boot fails fast if `M365_GRAPH_ACTIONS_TOOLS_ENABLED=true` without `APP_ENCRYPTION_KEY_ID`.
6. Cross-org and cross-profile reconciliation attempts fail closed (proven against real PG).
7. An approved `m365_reset_password` intent for the onboarded org executes headless and the
   temporary password is revealable exactly once.
