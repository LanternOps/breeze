---
tracking_issue: LanternOps/breeze#8164
---
# EDR provider framework — Plan Index

**Spec:** `docs/superpowers/specs/integrations/2026-09-30-edr-provider-framework-spec.md`
(approved by Todd 2026-10-01, D1–D14 accepted as recommended; **re-sequenced the same day:
adapter order is Bitdefender GravityZone → Emsisoft → Sophos Central**, with GravityZone as the
lockstep first adapter under D1).

Anchor issues: #3136 (Bitdefender, now first), #7436 (Emsisoft), #3135 (Sophos). Cluster: #4620
(Defender, fits only), #6960 (Security agents auto-deploy, hook only), #7551 (agent detection),
#7653 / #7654 (CrowdStrike / ThreatDown roadmap).

One plan document per wave. **Only W01 has a full task plan today**; W02–W07 get detailed plans
when each wave starts (state on GitHub via `feature-lifecycle` is the source of truth, never this
index — `get_feature_status` before starting any wave). Branch per wave:
`feature/<parent#>-edr-provider-framework/wave-<sub-issue#>`; PR bodies carry
`Closes #<sub-issue#>`.

| Wave | Plan | PRs | Depends on |
|---|---|---|---|
| W01 | [Framework core + Bitdefender GravityZone read path](2026-10-01-edr-w01-framework-bitdefender.md) | 2 (W01a tenancy/migration, W01b framework + adapter + sync + routes) | — |
| W02 | Surfacing (plan written at wave start) | 2 (API, web) | W01 |
| W03 | Actions + AI + push hints (GravityZone first) | 2 (actions + AI, webhook/push) | W01 (W02 recommended first for the UI buttons) |
| W04 | Emsisoft cloud EMC adapter — **gated on #7436 confirmation** | 1 | W01 (+W03 for actions) |
| W05 | Sophos Central adapter | 1 | W01 (+W03 for actions) |
| W06 | Installer dispatch + #6960 hook | 1 | W01 + at least one adapter with `installer !== 'none'` |
| W07 | Agent detection signatures (absorbs #7551 / PR #7634) | 1 residual (after #7634) | none |

W01 → W02 / W03 (parallel after W01). W04 / W05 are adapter-only and can start any time after
W01; their action halves need W03. W06 after the GravityZone adapter (W01) and W03's actions
contract is stable. W07 is independent of every API wave.

**Stacked-PR CI trap:** `ci.yml` runs only on PRs targeting `main`. W01b stacked on W01a (or any
wave stacked on a sibling) runs no CI — dispatch `gh workflow run CI --ref <branch>` per branch
before merging, and re-run after the base lands.

---

## Spec corrections (found while verifying the spec against HEAD, 2026-10-01)

Recorded here rather than silently diverging. Items 1–5 change the W01 data model and are applied
by the W01 plan.

1. **D13 tombstones collide with two W01 constraints the spec also asks for.** (a) `edr_detections`
   / `edr_actions` carry a composite `(tenant_id, org_id) → edr_tenants(id, org_id)` FK; a remap
   changes `edr_tenants.org_id`, so every tombstoned child still pointing at
   `(tenant_id, old_org)` makes the remap fail with 23503 (Postgres has no column-list form for
   `ON UPDATE`). (b) The unique key `(connection_id, vendor_kind, vendor_detection_id)` is held by
   the tombstoned row, so the first sync after a remap would `ON CONFLICT DO UPDATE` **onto the
   tombstone and move it into the new org** — option B (cross-customer disclosure), which D13
   rejected. Applied fix: `tenant_id` is **nullable** on `edr_detections` / `edr_actions` and is
   nulled when the row is tombstoned (`detached_at` set); the detection unique index is
   **partial `WHERE detached_at IS NULL`** and the upsert names that predicate in its
   `ON CONFLICT` target. A W01 integration test proves remap → re-sync creates a fresh row under
   the new org and leaves the tombstone under the old one.
2. **`edr_detections.vendor_endpoint_id` is required** (not in §4.2). Detections and inventory are
   separate jobs (§4.4); a detection can arrive before its endpoint row exists, and endpoints are
   deleted/re-created on remap. The detection keeps the vendor id and `endpoint_id` is resolved at
   write time and back-filled by the inventory job.
3. **Per-stream sync state.** §4.2 lists one `last_sync_*` set on connections and tenants, but §4.4
   requires "each [job type] writing only its own `last_*_sync_*` columns so one healthy stream
   cannot mask a failing one". W01 splits them: `last_inventory_sync_{at,status,error}` and
   `last_detection_sync_{at,status,error}` on both `edr_connections` and `edr_tenants`; the
   connection also stores the scheduler's `effective_{inventory,detection}_interval_minutes`
   (§4.4 "shows the effective cadence on the connection card").
4. **`vendor_root_type` on `edr_connections`.** One credential can be a partner (MSP) key or a
   single-company key (GravityZone; Sophos partner/organization/tenant via `whoami.idType`).
   `listTenants` needs to know which; stored at `testConnection` time.
5. **`mcpCoverage` forbids new gaps.** `__tests__/mcp-coverage.test.ts` freezes `gap` entries
   ("gaps may only be burned down"), so a route file must ship with a tool or a real exemption.
   W01's admin routes (`connections`, `tenants`, `endpoints` link) take `vendor_console_admin`
   like `backup/provider*.ts`, but a **detection read route cannot honestly be exempt**. The
   detection list route therefore moves to **W02**, together with the two Tier-1 read tools
   (`get_edr_status`, `list_edr_detections`); W03 keeps the action tools and `sync_edr_data`.
   Spec §7 lists the detection route in W01 and all tools in W03.
6. **`bullmqUtils.ts:51` `addUniqueJob`** (§4.4) — the function is `enqueueOrReplaceStale`
   (`services/bullmqUtils.ts:43`; the reuse-without-merge branch is lines 51–54). The behaviour
   the spec describes (an in-flight job is returned, the new payload dropped) is correct.
7. **`logRedaction.ts` needs no new names** (§4.9). `SECRET_KEY_PATTERN` already matches
   `apiKey`, `clientSecret`, `client_secret=`, `token`, `authorization`. W01 adds a regression
   test pinning that the GravityZone and Sophos credential field names redact, instead of a code
   change.
8. **Host allowlist matching.** §4.3 calls `hostAllowlist` "hostname suffixes", and
   `ssrfGuard.checkSsrfSafe`'s `hostnameAllowlist` is a bare `endsWith`, so a non-dotted entry
   such as `id.sophos.com` also admits `xid.sophos.com`. The EDR guarded fetch uses its own
   matcher: an entry starting with `.` is a suffix, anything else is an exact host. (Low risk —
   `safeFetch` still refuses private/metadata IPs — but the semantics are now explicit and tested.)
9. **Serial tiebreak has no consumer in the first three adapters.** §4.6 adds a serial tiebreak, but
   §3.1 lists serial as absent/unconfirmed for GravityZone, Emsisoft and Sophos. Under the D1
   caveat ("W01 builds only what the adapter exercises") W01 extracts the matcher with the FQDN
   short-name rule (GravityZone reports FQDNs) and **defers the serial tiebreak** to the first
   adapter that lists `serial` in `endpointIdentifiers` (CrowdStrike / ESET / WithSecure).
10. **§4.14 is mostly delivered by open PR #7634** (for #7551): ESET `mgmtdetect` signature,
    Emsisoft / Webroot / ThreatDown / WithSecure in both `providerFromName` and `mgmtdetect`, and the
    `security_provider` enum migration (`2026-11-12-120000-security-provider-emsisoft-webroot-withsecure.sql`).
    W07 is now the residual: Trend Micro (signature + `providerFromName` + enum value) and the
    Huntress question below.
11. **Nullable `tenant_id` needs its own org↔partner FK** (consequence of correction 1, raised by the
    Codex plan review): once a detection/action is tombstoned nothing else ties its `org_id` to its
    connection's `partner_id`. W01 adds `(org_id, partner_id) → organizations(id, partner_id)
    DEFERRABLE INITIALLY IMMEDIATE` on `edr_detections`, `edr_actions` (and `edr_endpoints` for
    uniformity).
12. **D14 also applies to device hard delete.** The spec stamps `last_site_id` only on org moves, but
    `ON DELETE SET NULL (breeze_device_id)` on a deleted device produces the same "never linked"
    null-device row visible to every site. W01 snapshots `device_detached_at` + `last_site_id` in
    `services/deviceDeletion.ts` before the delete (the only device hard-delete path).
13. **Spec file:line refs re-checked at HEAD 2026-10-01** (all still accurate):
    `edrInstallerResolver.ts:60`, `incidents.helpers.ts:245` (site predicate),
    `aiGuardrails.ts:419-491`, `intentReleaseWorker.ts:893-897`, `builtinDeploymentPackages.ts:5`,
    `orgAccountReadinessIntegrations.ts:29`, `portalVisibility.ts:118`,
    `2026-07-02-builtin-catalog-partner-read-rls.sql:23` (CHECK), `mapping.ts:230-265`.

---

## W01 — Framework core + Bitdefender GravityZone read path

**Goal.** Ship the five `edr_*` tables with every tenancy registration, the provider-neutral
framework (types, registry, normalize, persist, mapping, device matching, limiter, guarded fetch,
credentials), the `edr-provider-sync` worker (inventory + detections streams, #1105-safe), the
partner-admin `/edr` routes (providers, connections, tenants/mapping, endpoint link), and the
GravityZone adapter read side. After W01 an MSP can connect a GravityZone partner key via the API,
map companies to orgs, and see endpoints linked to Breeze devices and detections persisted —
nothing user-facing beyond the API.

**PRs.**
- **W01a — tenancy foundation** (full rigor): migration, Drizzle schema, shared tuples, every
  registration list, `moveDeviceOrgInTransaction` detach, `edrProviderRls.integration.test.ts`.
  Ships dead tables; nothing reads them.
- **W01b — framework + adapter**: `services/edrProviders/**`, extracted
  `externalTenantMapping.ts` / `externalDeviceMatching/`, GravityZone client + adapter + fixtures,
  `jobs/edrProviderSync.ts` + worker registrations, `routes/edr/**`, contract-test allowlists.

**Gates.**
- Contract suites that only fail in **Integration Tests** run locally on `pnpm test-stack up`
  before W01a opens (cascade, export ×2, merge registry + merge contract, FK on-delete, RLS
  coverage via `test:rls-coverage`). `orgMerge.test.ts` only reds in the **full** Test API run.
- **Vendor sandbox gate (W01b, blocks registering the adapter in prod):** a live run against a
  GravityZone **partner (MSP) trial** with an API key scoped to Companies + Network (and Incidents
  / Quarantine read where available): connect, list companies, map one to a lab org, sync, see a
  lab VM's endpoint linked and an EICAR detection persisted. Record the run in the PR. Credentials
  come from Todd (Bitdefender partner portal trial); never commit them.
- No agent release.

**Acceptance criteria.**
- All five tables RLS-forced; cross-partner forge on connections/tenants → 42501; tenant mapped
  to another partner's org → 23503; org token reads no connection/tenant and no other org's
  endpoint/detection/action.
- Org erasure, org merge (merge contract), device org-move and device delete all succeed with
  linked EDR rows present; `confdelsetcols = {breeze_device_id}` pinned.
- Sync: vendor HTTP holds no pooled connection (tripwire-strict test), a failing company is
  skipped without touching its rows, a partial page throws (all-or-nothing), 401 → `reauth_required`
  (connection scope) vs a company-level permission error → that tenant only, rate limit honoured.
- Remap tombstones detections/actions under the old org; re-sync after remap never repoints them.
- Every write route refuses a selected-org partner user (403) and an org token (403).

## W02 — Surfacing

**Goal.** Make framework data visible everywhere the legacy vendors are: incidents feed, Security →
EDR, device panel, Integrations, portal, readiness, reports, events + alerts.

**PRs.** (1) **API**: generic incidents-feed leg + nested-ternary → leg-list fold (unit test
enumerates every include-combination) + `source` enum derived from the registry +
`incidents.source_type = 'edr_detection'` promotion; D14 predicate (detached findings keep
`last_site_id`'s restriction); `routes/edr/detections.ts` list route + **`get_edr_status` and
`list_edr_detections` Tier-1 tools** (moved from W03, correction 5) with every AI registry entry
(`aiTools.ts`, `aiToolSchemas.ts`, `aiGuardrails.ts`, `aiToolRateLimits.ts`,
`aiAgentSdkTools.ts`, `mcpCoverage.ts`, `agentToolCatalog.ts`, golden tasks; description budget
300/160; no `z.undefined()`); sync Phase 4 (events `edr.*` in `eventBus.ts`, alerts via
`createSourcedAlert` evaluated over persisted rows vs `notified_severity`; D10 24 h stale-tenant
alert); D11 retention job type (prune resolved/dismissed > 180 days); portal `portalVisibility.edr`
+ `securityReadModel`/`protection.ts`; readiness `ConnectorSystem`; `securityComplianceReport` /
`threatDetection` consumers. (2) **Web**: Integrations → Security "EDR providers" cards
(`BackupProviderConnectionCard.tsx` pattern), add-connection flow from `GET /edr/providers`, tenant
mapping table with name suggestions, unlinked/ambiguous endpoint list + link picker, "Other EDR"
tab on Security → EDR, generic `DeviceEdrPanel` section (read-only), all mutations via `runAction`.

**Gates.** Browser pass in the next pre-release sweep. Settings rule 9 statement in the PR (one
home: Integrations → Security). No agent release.

**Acceptance.** A GravityZone detection appears in the incidents feed under source
`bitdefender`, promotes to a tracked incident, respects site restriction (including after a device
org-move detach); portal shows a vendor-neutral EDR count; partial-coverage responses from the read
tools name the providers covered and flag stale tenants.

## W03 — Actions + AI + push hints (GravityZone first)

**Goal.** Response actions through `dispatchEdrAction` with the full audit ledger, AI tools keyed
by normalized action, and the webhook-hint path.

**PRs.** (1) **Actions + AI**: `routes/edr/actions.ts` (`devices.execute` + `requireMfa()`, site
ceiling), `services/edrProviders/actions.ts` (capability → `supportsAction` → `edr_actions` row +
audit, commit → `performAction` outside DB context → status), crash reconciliation (never re-send),
`sync-action-status` job type, GravityZone `isolate` / `unisolate` (restore) / `scan` (+
`quarantine_restore` / `quarantine_delete` if the sandbox proves the key's permissions allow
them), `supportsAction` honouring the incidents/EDR licence per company; tools
`edr_endpoint_action`, `edr_detection_action`, `sync_edr_data`; tier map keyed by `EDR_ACTIONS`
with a fail-closed unit test (isolate supervised; unisolate/rollback/resolve/mark-FP/quarantine
restore four-eyes; kill/quarantine delete supervised; scan/update Tier 2); user-owned release
entries in `jobs/intentReleaseWorker.ts`; `aiToolsActorParity.contract.test.ts` and the line-keyed
`SAFE_WRITE_SITES` contract; web action buttons from capabilities. (2) **Webhook / push**:
`POST /edr/webhook/:connectionId` (public, uuid-validated, mandatory secret, constant-time,
body cap, per-connection rate limit), durable hint set (Redis + `edr_tenants.pending_hint_at` —
a new column, so **export-policy row update** in the same PR), GravityZone `verifyWebhook` on our
generated `Authorization` secret (ignore `Event-Push-Service-Md5`), opt-in `setPushEventSettings`
registration, `getDetections` targeted re-fetch.

**Gates.** **Lab: GravityZone isolation and restore proven against a real GravityZone-managed
nested brzlab VM with the incidents/EDR licence active on the trial company** (never a host with an
installed Breeze agent); a company without the licence must show the action disabled-with-reason.
Push: a test event from GravityZone (`sendTestPushEvent`) reaches a tunnel-exposed lab stack. High
blast radius (remote actions, AI guardrails): full rigor, Sonnet/Opus review. No agent release.

**Acceptance.** Every action writes one `edr_actions` row per target with `requested_via` /
`ai_session_id` / `approval_id`; an AI-initiated action never lands an agent id in `requested_by`;
an unknown normalized action is refused by the guardrail; a forged-but-signed webhook can only
cause an extra poll.

## W04 — Emsisoft cloud EMC adapter (gated)

**Gate before starting:** the #7436 requester confirms they use the **cloud** EMC (D9). Ask via the
Discord thread (Discord-reporter rule — never block on a GitHub reply). **If the confirmation has
not landed when W04's turn comes, pull W05 (Sophos) ahead rather than block the train.**

**Content.** `emsisoft/{client,adapter,normalize}.ts`: `Api-Key` auth to `api.emsisoft.com` (single
host allowlist), `/v1/workspaces` → tenants (`tenantModel` per the sandbox key: partner if one key
lists workspaces, else `single` + many connections per D3), devices (name + domain only → FQDN
rule; same-org collisions stay ambiguous, surfaced), incidents with verdicts → detections; actions
(scan, quarantine restore/delete, mark false positive) only if the sandbox key proves them; no
isolation (`capabilities.actions` omits it); `installer: 'api_generated_link'` stub for W06.
Undocumented rate limits → conservative `requestBudget` and observed-header logging. Fixture-only
CI; sandbox gate like W01. 1 PR. Low–medium.

## W05 — Sophos Central adapter

**Content.** `sophos/{client,adapter,normalize}.ts`: OAuth2 client-credentials at `id.sophos.com`
(1 h JWT, token cache keyed `(connection, credential version, tenant)`), `whoami` →
`partner`/`organization`/`tenant`, `/partner/v1/tenants` (or `/organization/v1/tenants`) with the
per-tenant `apiHost` validated against `['.central.sophos.com', 'id.sophos.com']` before storage
and at dial time, `/endpoint/v1/endpoints` (hostname, IPs, MACs, health, isolation, tamper),
Common `alerts` → detections (**verify** whether acknowledged alerts disappear from the list; if so
the adapter declares an `open_set` status model and the framework resolves absent rows — never
trust SIEM `/events` for catch-up, 24 h horizon), `requestBudget: { perSecond: 10, perMinute: 100,
perHour: 1000 }` with the default 15 min detection / 60 min inventory cadence lengthened by the
scheduler; actions (W03 contract): isolate/unisolate (`PATCH …/isolation`), scan. Live sandbox
gate against a Sophos Central Partner trial. 1 PR. Medium. Must not need any framework change — if
it does, that is an interface bug to fix in the framework, not a Sophos special case.

## W06 — Installer dispatch + #6960 hook

**Content.** `BuiltinProvider` widened to `'huntress' | 'sentinelone' | EdrProviderKey` (installer-
capable subset); `edrInstallerResolver.ts` becomes a dispatch map with an **exhaustive switch that
throws** (closes today's "anything not Huntress resolves as S1" fall-through at `:60`);
`software_catalog_integration_provider_chk` replaced by an idempotent drop-and-re-add migration
listing the extended set; GravityZone `getInstaller` via `getInstallationLinks` (per company /
OS), then Emsisoft/Sophos as their waves land; tenant ambiguity error when an org maps to more than
one tenant of a provider (never `limit(1)`); `installer_secret_encrypted` written only through the
row-bound helper; registry ↔ shared type ↔ CHECK exhaustiveness unit test. #6960 itself is not
built here — only `listEdrProviders().filter(installer !== 'none')` is made available to it.

**Gates.** Ships to customer machines via deploy → lab install of the GravityZone agent on a nested
brzlab VM through a Breeze deployment. 1 PR. Medium.

## W07 — Agent detection signatures (absorbs #7551)

**Content.** First land **PR #7634** (open; delivers #7551: Emsisoft / Webroot / ThreatDown /
WithSecure in `providerFromName` + `mgmtdetect`, ESET `mgmtdetect`, enum migration). Residual PR:
Trend Micro (`mgmtdetect` signature, `providerFromName` `trend_micro`, `security_provider` value in
its **own** `ALTER TYPE … ADD VALUE IF NOT EXISTS` migration, `normalizeProvider`,
`PROVIDER_NAMES`), table tests for order-sensitive cases (Bitdefender-before-Defender, Trend vs
other). Huntress in `providerFromName` is a **decision** (see below), not assumed.

**Gates.** Agent-shipped → needs an agent release; Windows lab VM (.55, `make dev-push`) check
with Trend Micro installed. 1 residual PR.

---

## Needs Todd's decision

1. **Huntress in `providerFromName` (W07).** Huntress Managed AV manages Microsoft Defender rather
   than registering its own AV product in Windows Security Center, so adding `huntress` to the
   `security_provider` enum may make Defender-protected devices report as `huntress`.
   Recommend: leave it out of `providerFromName` (keep it in `mgmtdetect`, where it already is)
   unless a lab box shows Huntress registering in WSC.
2. **W02 now carries the two Tier-1 read AI tools** (correction 5). Recommend accepting: the
   alternative is a frozen-gap exception in `mcp-coverage.test.ts`, which that test exists to
   forbid.
3. **Sandbox credentials:** a GravityZone partner (MSP) trial with the incidents/EDR add-on on at
   least one company (W01 read gate, W03 isolation gate). Needs Todd to request it from the
   Bitdefender partner program; Emsisoft and Sophos partner trials follow for W04 / W05.
