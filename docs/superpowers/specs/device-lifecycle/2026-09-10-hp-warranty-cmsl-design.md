# HP warranty via HP CMSL (agent-collected)

Status: approved 2026-09-10. Not implemented.
Tracking: LanternOps/breeze#5511 (waves #5512-#5516).
Depends on: `vuln-patch/2026-09-10-desired-state-software-install-design.md`
(the `autoInstall` remediation half of software policies). Only wave 4 below
needs it; waves 1-3 and 5 are independent and can run in parallel with that work.

## Problem

HP devices sit at `status = 'unknown'` forever. Dell and Lenovo have working
server-side providers; HP does not, and cannot. `hpProvider.ts` is written,
unit-tested, and deliberately unregistered — the comment at
`apps/api/src/services/warrantyProviders/index.ts:7-11` records why: the
unofficial `support.hp.com` endpoint now returns the site's HTML shell (verified
2026-09-09) and HP's real backend is captcha-gated. HP's official Warranty API is
explicitly closed to IT service companies and third-party ISVs, so no amount of
credential work opens it.

That comment also names the intended fix: *"HP coverage is coming from the agent
instead. The module is kept (and unit-tested) until that lands."* This spec is
that.

## Approach

Collect on the device with HP's own Client Management Script Library (CMSL).
HP blesses this path; it needs no MSP API key because the device authenticates
as itself.

External facts, researched 2026-09-10, **all of which wave 1 must confirm on real
hardware before anything is built on them**:

- `Get-HPWarrantyInfo` takes no parameters and runs on the local HP device.
- It writes results to WMI classes `HP_Warranty` and `HP_Entitlements` in
  namespace `root/HP/InstrumentedServices/v1`.
- It self-caches for 30 days: a call inside that window returns the stored WMI
  data without a network round trip.
- HP rate-limits it to 300 requests / 5 minutes **per source IP** — which is a
  per-customer-NAT limit, not a per-device one.
- winget package id is `HP.HPCMSL` (1.8.6, 2026-04-01). Also installable via HP's
  InnoSetup `.exe /VERYSILENT` or `Install-Module HPCMSL -AcceptLicense -Scope AllUsers`.
- CMSL requires PowerShell 5.1+, the NuGet provider, and TLS 1.2 for the gallery
  path; it lands in `Program Files\WindowsPowerShell\Modules`.

### The EULA constrains the install channel

HP's CMSL licence states verbatim: *"You do not have the right to distribute the
Software Product."* This is a reading of the licence text, not legal advice, and
it should get a short legal skim before wave 3. Two consequences shape the design:

- **Breeze must never mirror or host the CMSL installer.** This rules out the
  `winget_bootstrap` pattern, where we serve pinned artifacts from
  `apps/api/src/routes/agents/wingetBootstrap.ts`. Installing via winget or HP's
  own URL satisfies this; both pull from HP.
- **Auto-accepting the licence is accepting it on the customer's behalf.** That
  is why this feature is opt-in with a recorded consent, not a default-on toggle.

The licence also permits HP to collect technical information including IP
address. An MSP is entitled to know that before HP software lands on their
customers' endpoints; say it plainly in the consent copy.

## Scope

HP Inc client hardware running Windows. Not HPE servers, not HP hardware running
Linux. Devices outside that set are untouched and keep whatever status they have.

## Design

### Layer 1 — Opt-in on the existing warranty config-policy feature

The `warranty` feature type is pure JSONB inline settings on the feature link
(`apps/api/src/services/configurationPolicy.ts:1062` — "Pure JSONB — no
normalized table needed"), currently `{ enabled, warnDays, criticalDays }`
(`apps/web/src/components/configurationPolicies/featureTabs/WarrantyTab.tsx:9-13`).
No new table, no new tenancy shape, no cascade or export registration.

Add an `hpCmsl` block. Three things it must get right:

- **`enabled` on the existing block means expiry alerting, not collection.** The
  new block needs its own default-`false` enablement. Do not overload the
  existing flag.
- **Consent is server-stamped.** Generic inline-settings validation accepts
  arbitrary records (`packages/shared/src/validators/index.ts:595`), so a client
  could today persist fabricated consent attribution. Add warranty-specific
  validation and write the actor id, server timestamp and an explicit EULA
  identifier server-side from the authenticated session — never from the payload.
- **Authorization must match the deployment gate.** Feature-link writes require
  only `devices.write` and `warranty` is absent from `MFA_GATED_FEATURE_TYPES`,
  which is `{patch, maintenance}` (`apps/api/src/routes/configurationPolicies/featureLinks.ts:86`).
  Creating a deployment requires `devices.execute` **plus** MFA
  (`apps/api/src/routes/software.ts:1754`). Because enabling `hpCmsl` causes
  software installation, it must carry the stronger gate — otherwise it is a
  privilege-escalation path around the deployment gate. Add `warranty` to the
  MFA-gated set, or gate the `hpCmsl` sub-block specifically, and cover the
  assignment/inheritance transitions too, not just the checkbox.

**Inheritance footgun:** policy resolution selects a whole feature link, not a
deep merge. A nearer policy carrying only alert thresholds will replace an
inherited link and silently drop its `hpCmsl` block. The UI must make that
visible when authoring a child policy, and the plan should state the intended
semantics explicitly rather than leaving it to resolution order.

### Layer 2 — Delivery to the agent

Mirror `exclusiveWindowsUpdate` (#1872) exactly; it is the closest working
precedent and its revocation semantics are already correct.

| Location | Change |
|---|---|
| `apps/api/src/routes/agents/helpers.ts` | Add `buildWarrantyConfigUpdate(deviceId)` alongside `buildPatchSourceConfigUpdate` (`helpers.ts:2861`). Share effective-warranty resolution with the alert evaluator, whose private resolver currently returns only the three alert fields (`warrantyAlertEvaluator.ts:178`). |
| `apps/api/src/routes/agents/heartbeat.ts` | Extend `PolicyConfigUpdates` + defaults, invoke the builder in the existing post-org-transaction policy block (`heartbeat.ts:1905-1997`), merge `warranty_settings` into `policyConfigUpdate`. |
| `agent/internal/heartbeat/heartbeat.go` | `ConfigUpdate` is already a generic map; add warranty dispatch in `applyConfigUpdate` (`heartbeat.go:2699`), accepting both snake_case and camelCase as every other key does. |
| New `agent/internal/heartbeat/warranty_config.go` | Follow the replaceable-seam pattern of `patch_source.go`, whose header explains why: a key-name regression would otherwise silently disable the whole feature with no test able to catch it on a non-Windows CI runner. |

Copy `buildPatchSourceConfigUpdate`'s revocation contract verbatim
(`helpers.ts:2855-2860`): a **successfully resolved absent policy** returns
`false` and the agent stops HP activity; a **resolver error** omits the block
entirely so a transient failure never triggers an unintended revert. These are
different states and conflating them is how a fleet silently turns a feature off.

### Layer 3 — Getting CMSL onto the device

A built-in catalog package, installed and kept present by a partner-wide
allowlist software policy with `autoInstall` armed.

**Built-in package.** `apps/api/src/services/builtinDeploymentPackages.ts`
already provides the seam: a `BUILTIN_PACKAGES` registry and an idempotent
`ensureBuiltinPackage({ provider, partnerId })` running in system DB context.
Adding `hp_cmsl` touches more than the union:

| Boundary | Change |
|---|---|
| DB CHECK | `software_catalog_integration_provider_chk` permits only NULL/`huntress`/`sentinelone` (`apps/api/migrations/2026-07-02-builtin-catalog-partner-read-rls.sql:23`). Forward migration required — never edit the shipped one. |
| `BuiltinPackageDef` | The union is discriminated on `requiresBinaryUpload` into "derivable URL" (Huntress) and "partner uploads binary" (SentinelOne). A winget package is a **third arm** — no URL, no upload, just a package id. Extend the union; do not force HP into an existing arm. |
| `ensureBuiltinPackage` | Creates catalog and version rows, not install methods (`builtinDeploymentPackages.ts:99`). HP needs an install-method row instead of a version row. |
| Install-method API | `POST` rejects every non-null integration provider — *"Built-in packages cannot carry install methods"* (`apps/api/src/routes/softwareInstallMethods.ts:112`). The system provisioner must insert directly, or that rule needs a documented exception. Decide which in the plan. |
| Install-method validation | Already accepts the shape we need: `{ platform: 'windows', kind: 'winget', packageId: 'HP.HPCMSL' }`. Note the field is `kind`, not `manager` (`softwareInstallMethods.ts:39`). |
| Web UI | `useEdrReadiness` seeds state with only `{huntress, sentinelone}` (`useEdrReadiness.ts:132`) while `SoftwareCatalog.tsx:640` dereferences `readinessMap[provider].status` for **any** provider passing `isIntegrationProvider`. Adding `hp_cmsl` to that union without touching readiness **crashes the catalog page**. HP has no credential readiness concept and must be separated from EDR readiness, not folded into it. Branding also needs an entry (`providerBranding.ts:5`). |

Keep HP out of the EDR secret-resolution branch at
`softwareDeployment.ts:554-558` — that path injects Huntress/SentinelOne account
and site tokens and has nothing to do with HP.

**Keeping it present.** A built-in partner-wide `software_policies` row in
`allowlist` mode with one rule whose `catalogId` points at the HP CMSL catalog
item, `enforceMode` on and `autoInstall` armed. The compliance worker re-resolves
targets every 15 minutes, so devices that enrol later — or whose HP identity
arrives later, once hardware inventory reports a manufacturer — are picked up
without any re-dispatch machinery.

Targeting is expressible with existing filters: `osType` and
`hardware.manufacturer` are both supported by the filter engine
(`apps/api/src/services/filterEngine.ts:89`). Note `targetType: 'sites'` is
explicitly unimplemented (`apps/api/src/routes/software.ts:287`) — use filters or
resolved device IDs.

Because deployments are org-owned, a partner-wide policy produces one deployment
run per organisation. That is inherent to the schema, not a defect to work around.

### Layer 4 — Keeping CMSL current

**This layer is unproven and wave 1 must prove or kill it.**

The claim is that once CMSL is installed via winget, the agent's SYSTEM patch
scan sees it and updates flow through the normal third-party ring approval. The
generic half is real: heartbeat retains the package id and maps winget to
`third_party` (`agent/internal/heartbeat/heartbeat.go:3270,3429`), ingest creates
the shared patch row and upserts `device_patches`
(`apps/api/src/routes/agents/patches.ts:222,289`), and the approval evaluator
loads `patch_policies` rings (`apps/api/src/jobs/patchJobExecutor.ts:1130`).
No HP-specific registration is needed anywhere in that chain.

The unproven half is the first link. The SYSTEM scan runs
`winget upgrade --include-unknown --scope machine --source winget` and parses
that output (`agent/internal/patching/winget_system.go:73,97`). It enumerates
winget-tracked packages, **not** PowerShell modules. So this works only if winget
classifies HP's InnoSetup-based installer as a machine-scope package *and*
reports an available upgrade. `Install-Module -Scope AllUsers` establishes
neither condition, and the user-scope fallback does not rescue it — user-only
remediation is explicitly refused (`winget_system.go:186`).

Ring approval is also not automatic: third-party auto-approval requires the ring
to have auto-approval enabled, `sources` containing `third_party`,
`thirdPartyApps: true`, and the deferral elapsed
(`apps/api/src/services/patchApprovalEvaluator.ts:616`). CMSL being installed by
the warranty policy does not approve its updates.

**Wave 1 gate: perform a real old→new CMSL upgrade on an HP device through the
SYSTEM agent and a Breeze ring.** If winget does not surface it, treat CMSL as a
separate channel with its own update strategy — the agent enforcing a floor
version directly — and re-open that decision with Todd, since it bypasses the
customer's approval rings and that was explicitly not the chosen option.

### Layer 5 — Collection on the device

New files, independent of the Apple collector's build tags:
`agent/internal/collectors/hp_warranty_windows.go` (`//go:build windows`) and
`hp_warranty_other.go` (`//go:build !windows`). Do **not** retag
`warranty_other.go`, which is Apple's `!darwin` stub and already compiles on
Windows.

Tiered, cheapest first:

- **T0 — read WMI.** Query `HP_Warranty` / `HP_Entitlements` from
  `root/HP/InstrumentedServices/v1` directly. The agent already vendors
  `go-ole` v1.2.6 and `yusufpapurcu/wmi` v1.2.4, so this needs no PowerShell, no
  network and no install. **Wave 1 must determine whether that namespace exists
  without CMSL** — if HP's factory image populates it, some of the fleet yields
  warranty data at zero cost and zero EULA exposure, which would materially
  change how much of layer 3 is worth building.
- **T1 — refresh.** Run `Get-HPWarrantyInfo` only when the WMI data is missing or
  its own cache is genuinely stale, then re-read WMI.
- **T2 — absent.** CMSL not installed: report nothing and let the policy install it.

**Scheduling — two corrections that matter.** HP's cache is 30 days, so invoking
at day 25 returns cached data and refreshes nothing; the trigger must key off the
*actual HP cache timestamp* read from WMI, not an arbitrary interval. And the
Apple collector runs inside the 15-minute `sendInventory` fan-out
(`heartbeat.go:1977`); copying that lifecycle without persistent due/attempt
state would relaunch PowerShell every 15 minutes for days. The HP collector needs
its own persisted due time and bounded retries, with distinct
first-run/bootstrap behaviour.

Spreading uses deterministic per-device jitter — hash the device id into an
offset across the refresh window — so a site's HP fleet never bunches. Be honest
that this is statistical, not a guarantee: a fleet coming back from an outage can
re-bunch. The collector must also back off on an HP 429 rather than retry into
the limit.

### Layer 6 — Reporting and ingest

Reuse the Apple transport unchanged:
`sendInventoryData("warranty-info", payload)` → `PUT /agents/:id/warranty-info`.

`agentWarrantyInfoSchema` (`apps/api/src/routes/agents/schemas.ts:645`) already
accepts `source: 'agent_cmsl'` and `manufacturer: 'HP'` — both are free-form
bounded strings. But it has **no entitlements field**, so an entitlements array
is silently stripped by the object schema. Add validated, bounded entitlements to
the schema, the handler's explicit field selection (`inventory.ts:324`) and the
service interface, preserving HP's own dates.

**Two defects to fix in the same wave, both verified:**

1. `upsertAgentWarranty` hardcodes `provider: 'apple' as const` when synthesising
   an entitlement from `coverageType` (`warrantySync.ts:364`). Sending HP through
   it unchanged mislabels every HP entitlement as Apple. The entitlement type
   already includes `'hp'` (`warrantyProviders/types.ts:2`), so this is a code
   fix with no migration.
2. `syncWarrantyForSubject` preserves agent-written rows only when
   `dataSource === 'agent_plist'` (`warrantySync.ts:145`). An `agent_cmsl` row
   falls through to the unknown-result upsert, which **overwrites the agent's
   dates and entitlements and flips `data_source` back to `'provider'`**. The
   sweep selector has no manufacturer or provider exclusion
   (`warrantySync.ts:454`), so HP devices are selected. Frequent agent reports
   would keep pushing `nextSyncAt` out and mask this until reporting stopped —
   a latent data-loss bug, not a cosmetic one.

Fix by excluding HP from provider lookup in both candidate selection and direct
sync, and by generalising the preservation branch to any agent-owned source
rather than adding a second hardcoded string. Also stop the Apple branch's habit
of stamping `lastSyncAt` when nothing was fetched: HP needs its real fetch
timestamp distinguished from WMI observation time and report receipt time.

Manual refresh (`POST /devices/:id/warranty/refresh`, `devices/warranty.ts:63`)
currently queues a server-side sync. For an HP device that is meaningless — it
must either request agent collection or honestly report that refresh is not
available, never silently no-op.

`upsertAgentWarranty` already carries the correct
`targetWhere: sql\`${deviceWarranty.deviceId} IS NOT NULL\`` for the partial
unique index (`warrantySync.ts:395`). Dropping it during refactoring reintroduces
a 42P10 at runtime. There is an existing real-DB insert-then-update regression
test to extend (`deviceWarrantyManualSubject.integration.test.ts:225`).

No `device_warranty` migration is needed: `entitlements` is jsonb and
`data_source` is varchar.

### Layer 7 — UI and cleanup

- `DeviceWarrantyCard.tsx:59-66` gains an `agent_cmsl` → "Agent (HP CMSL)" label.
- `WarrantyTab.tsx` gains the `hpCmsl` block, the consent checkbox naming HP and
  its data collection, and the recorded acceptor/timestamp read-only.
- Delete `hpProvider.ts`, its references in
  `warrantyProviderThrottle.test.ts:19`, the `hpRateLimiter` if unused elsewhere,
  and the dead `HP_WARRANTY_ENABLED` flag — which appears in exactly one place in
  the repo (`hpProvider.ts:13`) and in no env example. Do this **when the new path
  lands**, not before; the module's own comment says it is kept until then.
- `apps/docs/src/content/docs/features/warranty-tracking.mdx:14` currently states
  "HP has no lookup yet, so HP devices stay `unknown`." Update it.

## Risks

- **Layer 4 is unproven** and is the stated reason for the wave 1 gate.
- **Coverage is unknowable in advance.** How many HP devices already have the
  WMI namespace populated is a wave 1 measurement, not an estimate.
- **The MSP may refuse.** CMSL is a ~100 MB HP module with HP telemetry rights on
  every HP endpoint. Some partners will decline, and that is a legitimate
  outcome, not a failure — the feature must degrade to "HP stays unknown"
  cleanly rather than half-installing.
- **PowerShell 5.1 and TLS 1.2 prerequisites** are not universal on older
  Windows builds. The collector must report *why* it could not collect rather
  than failing silently.

## Testing

- Go unit: T0 WMI parse from fixture rows; tier selection; due-time computation
  from an HP cache timestamp; jitter determinism and distribution; back-off on 429.
- Go unit: config dispatch through the `warranty_config.go` seam on a non-Windows
  runner, asserting both snake_case and camelCase keys — the regression
  `patch_source.go` exists to prevent.
- API unit: entitlements schema bounds; HP entitlement provider is `'hp'`, not
  `'apple'`.
- API integration (real DB): an `agent_cmsl` row survives a full sweep pass
  unchanged — this is the direct regression for defect 2 above, and it must be
  written red against current code first.
- API integration: consent fields are server-stamped and a forged payload cannot
  set them.
- Authorization: a `devices.write` user without MFA cannot enable `hpCmsl`.
- Web: catalog page renders with an `hp_cmsl` item present (the readiness-map
  crash regression).
- Lab, on real HP hardware: namespace presence without CMSL; a full
  install→collect→report cycle; an old→new CMSL upgrade through a Breeze ring.

## Wave sketch

1. **Lab probe + ingest hardening.** Answer the three hardware questions; fix the
   two `warrantySync` defects with red-first regression tests; add entitlements to
   the schema. Delivers value even if every later wave is cancelled.
2. **Opt-in surface.** `hpCmsl` block, server-stamped consent, MFA/execute gate,
   heartbeat delivery, agent config seam. No collection yet.
3. **Collector.** T0/T1/T2, scheduling off the HP cache timestamp, jitter,
   back-off, reporting. *(Independent of the desired-state work.)*
4. **Built-in package.** Third union arm, migration, provisioner, UI readiness
   separation and branding. *(Requires the desired-state feature for the policy
   that keeps it installed.)*
5. **Cleanup + docs.** Delete `hpProvider.ts` and the dead flag, update the docs
   page, UI labels.
