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

## Corrections after ground-truth verification (2026-09-10)

Every file this spec cites was re-opened after approval. The design holds, with
one substantive correction (T0's transport) and a set of citation fixes. Wave
plans carry the corrected citations — prefer this section where they disagree.

### Substantive: the agent has no WMI binding, so T0 uses PowerShell

Layer 5 claims "the agent already vendors `go-ole` v1.2.6 and
`yusufpapurcu/wmi` v1.2.4, so this needs no PowerShell". That is wrong:

- `yusufpapurcu/wmi` is an **indirect** dependency (`agent/go.mod:112`), pulled
  in by gopsutil. Zero agent files import it — `wmi.Query` / `wmi.QueryNamespace`
  appear nowhere outside `go.mod`/`go.sum`.
- `go-ole` is direct (`agent/go.mod:18`) but drives only the Windows Update
  Agent COM API (`agent/internal/patching/windows.go:11-12,240`) and VSS
  (`agent/internal/backup/vss/vss_windows.go:16,358,767`). Neither does WMI.
- **Every WMI read in the agent today goes through PowerShell
  `Get-CimInstance`.** The canonical precedent batches four classes into one
  spawn: `agent/internal/collectors/hardware_windows.go:82-121`, with its
  `Get-WmiSafe` fallback helper (`:89-98`), `wmicTimeout = 15s` (`:14`), and
  invocation via `runCollectorOutput(...)` + `utf8PowerShellCommand(...)`
  (`agent/internal/collectors/command_limits.go:30,34,41`). Eight more
  `Get-CimInstance` call sites exist across collectors, security and backup.

Decision: **T0 reads `root/HP/InstrumentedServices/v1` with
`Get-CimInstance -Namespace`, through `runCollectorOutput` +
`utf8PowerShellCommand`, matching `hardware_windows.go`.** Promoting
`yusufpapurcu/wmi` to a direct dependency to avoid the spawn is rejected: it
would be the agent's only Go-side WMI call, with its own COM-threading
behaviour and no existing test seam, to save a few hundred milliseconds on a
collection that runs at most daily. The tiering is unaffected — T0 is still the
cheap local read (no network, no CMSL invocation, no 30-day cache write); only
its transport changes.

### Citation corrections

- Apple warranty: collector entry `CollectAppleWarranty()` in
  `agent/internal/collectors/warranty_darwin.go:45` (stub
  `warranty_other.go:20`); sender `sendAppleWarrantyInfo` at
  `agent/internal/heartbeat/heartbeat.go:2405-2435`, registered in the 15-minute
  `sendInventory` fan-out at `:2129`. `sendInventoryData` is at `:2154-2185`
  and takes the endpoint as its FIRST argument plus a label as its third.
- **`applyConfigUpdate` is at `heartbeat.go:2851`, and a new key MUST be
  dispatched above line 2918.** Everything from `:2918` is the policy-probe
  path, which hits an unconditional `return` at `:2928-2930` when no probes are
  present — a warranty key added below that line is silently unreachable on
  most heartbeats. Every existing key checks snake_case first, then camelCase
  (`:2857`, `:2867`, `:2879`, `:2889`, `:2901`, `:2910`).
- `patch_source.go` has no file header comment; the doc comments sit on the two
  symbols, and **neither is exported**: `var applyWinUpdate = winupdate.Apply`
  (`:12`, a package-level var — the swap point tests override) and
  `func (h *Heartbeat) applyPatchSourceConfig(raw any)` (`:18`). The dual-key
  parse is `:26-29`; note it checks **camelCase first**, the reverse of
  `applyConfigUpdate`'s outer keys.
- `buildPatchSourceConfigUpdate` is `helpers.ts:2860-2863`, its revocation
  contract comment `:2852-2859`, its settings type `:2841-2850`.
- `PolicyConfigUpdates` is `heartbeat.ts:1921-1926` and is **function-local, not
  exported**; the four builders share one `withSystemDbAccessContext` at `:1934`
  with per-builder try/catch (`:1944-1982`); the camelCase→snake_case wire
  assembly is `:1993-2004`. `pamSettings` is resolved but deliberately not
  merged there.
- `MFA_GATED_FEATURE_TYPES` is `featureLinks.ts:91`, not `:86`. Its in-handler
  MFA checks are at `:145-147` (create), `:340-341` (update), `:525-526`
  (delete) — so a feature-type-conditional, in-handler gate is the established
  pattern here, not a new one. All four link routes require only
  `requireConfigPolicyWrite` = `devices.write` (`:47-48`).
- The warranty alert resolver is `resolveWarrantySettings` at
  `warrantyAlertEvaluator.ts:58-186` (not exported); its level-priority sort is
  `:158-172` and it returns `DISABLED_SETTINGS` when no policy resolves (`:156`),
  so alerting is opt-in.
- `configFeatureInlineSettingsSchema` is
  `packages/shared/src/validators/index.ts:595-604`; its only rule is a
  reserved-key scan. `warranty` is absent from
  `assertDecomposableInlineSettings`, so warranty inline settings receive **no**
  server-side shape validation today.
- `useEdrReadiness` lives at `apps/web/src/components/software/useEdrReadiness.ts`
  (not `src/hooks/`); the hardcoded two-key seed is `:132-135`. The unguarded
  dereference is `SoftwareCatalog.tsx:637-640` and again at `:828`.
  `providerBranding.ts:5` is `INTEGRATION_PROVIDERS` (the single source the
  union and type guard both derive from); the `BRANDING` map is `:18` and is not
  exported — `getProviderBranding` (`:35`) is the accessor.
- `software_catalog_integration_provider_chk` is
  `apps/api/migrations/2026-07-02-builtin-catalog-partner-read-rls.sql:13-25`.
  `installMethodBodySchema` is `softwareInstallMethods.ts:39-53` (fields
  `platform`, `kind`, `packageId`, `enabled`; no `linux` platform); the built-in
  rejection is `:112-114`.
- winget SYSTEM scan args are `winget_system.go:73-76`; the **parse lives in a
  different file**, `agent/internal/patching/winget_parse.go:66-115`, and is a
  fixed-width parse of the English headers `Name`/`Id`/`Version`/`Available` —
  localized output yields `errWingetNoTable` → `ErrScanSkipped`. The user-scope
  refusal is `winget_system.go:186-194`, called from `Install` (`:208`) and
  `Uninstall` (`:227`). Package id retention is `heartbeat.go:3437`; the
  winget→`third_party` mapping is `:3581-3582`; note `default: "custom"`
  (`:3586`), and `custom` does NOT qualify for ring third-party auto-approval.
  The dual-consent condition is `patchApprovalEvaluator.ts:616-629`.
- `device_warranty` is `apps/api/src/db/schema/warranty.ts:29-69`. Confirmed:
  `entitlements` is jsonb NOT NULL default `[]` (`:49`); `data_source` is
  `varchar(50)` nullable default `'provider'` (`:50`) with **no CHECK or enum**;
  there are TWO partial unique indexes (`:60-65`), so every upsert needs its
  `targetWhere`.
- `agentWarrantyInfoSchema` is `schemas.ts:658-675`; the handler is
  `inventory.ts:306-343` with explicit field selection at `:331-339`. Note the
  serial number is taken from `device_hardware` (`:334`), never from the agent
  payload, and `deviceName` is accepted then discarded.
- `AgentWarrantyData` is `warrantySync.ts:315-331` — a **single coverage
  window**, with no entitlements, service-level or product-number field. An HP
  payload with N entitlements cannot be expressed without widening it.
- The two verified defects are confirmed at `warrantySync.ts:153` (the
  preservation branch is string-keyed to `'agent_plist'`) and `:367`
  (`provider: 'apple' as const`). `upsertAgentWarranty` is `:341-423`; the sweep
  selector is `:454-484`; the `targetWhere` guard is `:399`.
- Manual refresh is `devices/warranty.ts:42-67`. It already requires
  `devices.write` + `requireMfa()` and always passes `force: true`; it enqueues
  a BullMQ job and never reaches the agent.
- `DeviceWarrantyCard.tsx:60-67` is the label map; unknown sources render as the
  raw string, so `agent_cmsl` would display literally until extended.
- `filterEngine.ts` confirms `osType` (`:88`) and `hardware.manufacturer`
  (`:94`). There is no warranty-related filter field at all.

### Two additional defects found while verifying (both in scope)

1. **CSV import can stomp agent-owned warranty rows.**
   `apps/api/src/services/customFields/import/warrantyTarget.ts` guards only
   against `'provider'` rows (`:181`, `:238` —
   `data_source IS DISTINCT FROM 'provider'`), so an import overwrites an
   `agent_plist` row today and would overwrite `agent_cmsl` too. The
   `isAgentOwnedWarrantySource` generalisation must be applied here as well, not
   only in `warrantySync.ts`. Owner: W01.
2. **A `warranty` feature link sent with a `featurePolicyId` yields a 500, not a
   400.** `warranty` is missing from the inline-only guard list at
   `configurationPolicy.ts:2656-2662`, so it falls through to the generic
   whole-policy path and is rejected by the
   `config_policy_feature_links_reference_integrity` trigger. The code's own
   comment (`:2665-2669`) describes exactly this failure. The UI never sends one
   (`WarrantyTab.tsx:51,65` hardcode `featurePolicyId: null`), so this is
   API-surface only. Verified by reading, not reproduced at runtime. Owner: W02.

### Also noted, not blocking

`ensureBuiltinPackage` hardcodes `originalFileName: 'HuntressInstaller.exe'`
(`builtinDeploymentPackages.ts:112`) inside an otherwise provider-generic
branch. HP takes the winget path and creates no version row, so it is not hit —
but W04 should guard or fix it rather than leave the trap for the next
derivable-URL package.
