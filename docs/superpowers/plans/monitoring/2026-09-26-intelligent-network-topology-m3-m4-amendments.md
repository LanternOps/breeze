---
tracking_issue: LanternOps/breeze#5995
waves: W04 (#5999) M3, W05 (#6000) M4
amends: 2026-09-15-intelligent-network-topology-m3-operations.md, 2026-09-15-intelligent-network-topology-m4-ai.md
---

# M3 / M4 implementation amendments (binding)

The M3/M4 plans assume M2's original plan shapes and several M1 seams that do not exist. A code map of the W03
integration (M2 as built — see `2026-09-25-intelligent-network-topology-m2-amendments.md`) and an advisor quorum
(Fable + Codex `gpt-6-astra` xhigh; Codex's round-1 amendments adopted in full) resolved the design below.
**Where this document and the M3/M4 plans disagree, this document wins.**

## A. Name/path corrections
- Cross-language fixtures: `packages/shared/src/testing/`. `uint64Decimal` → reuse `topologySequenceSchema`.
- `AuthenticatedTopologyProducer` exists twice (collectionTypes.ts vs diagnosticResults.ts) — import the one for the seam.
- `createTopologyDiagnosticRun`'s 4th parameter is `options`; scheduled occurrence is a field of
  `CreateTopologyDiagnosticRunOptions`, coordinated with verified-plan options.
- Settings PATCH body is `{expectedRevision, overrides}`; policies use full upsert `/sites/:siteId/policies/:id`
  (no PATCH); the arm endpoint and interface-history route are new.
- `AiTool` requires `domain` (use `network`) and `searchHint`; `TOOL_PERMISSIONS` is one resource/action pair per tool;
  the `devices:read` floor comes from `requireTopologySiteAccess`.
- Precedent for frozen actors: `freezeApplicationActor`/`currentApplicationAuthority` (templateApplicationAuthority.ts),
  extended (it lacks the permission version).

## B. M3 decisions
**M3-D1 Telemetry source.** New `if_metrics` telemetry family under the existing target / controller-site authority
key. `snmp` producer kind registered via `registerTopologyProducerAuthority`, backed by a STANDING telemetry arm (not
the discovery job); `unifi` stays the controller producer. A telemetry sink shares producer authority, fencing and
atomic sequence acceptance; samples go to the partitioned samples table keyed by (interface id+generation, source,
sequence) — no per-poll collection runs. Metric sources are explicitly excluded from structural publication.
Admission: atomic sample/byte quotas per source, defined sequence/replay semantics, one in-flight batch per source.
**M3-D2 Poll authority.** New site-scoped arm (not legacy org-only `snmp_devices`). New command type
`topology_interface_poll` over the existing transport, registered in the mandatory delivery-revalidation set
(`commandClaimEligibility.ts`). Arm pins exact target binding/address, credential revision (own digest including
credential/enabled state — do not reuse discovery's generation digest unchanged), collector, interfaces, expiry.
Credentials encrypted via `sensitiveCommandPayload` with terminal erasure registered before shipping.
**M3-D3 Arm storage.** Dedicated `topology_telemetry_arms` table (org_id-direct RLS; full cascade/export/merge
registration) outside the settings digest. Actor = typed frozen actor + permission version + auth/MFA epochs + effect
digest. Settings writes preserve unaffected arms; material inherited-setting changes invalidate dependent arms.
SPEC AMENDMENT: telemetry opt-in moves out of site settings storage/API; portable defaults and provenance retained.
**M3-D4 Policy contexts/actor.** Site-local columns on `topology_monitoring_policies`: bounded `routing_contexts`
(excludedOpen) bound to observed source/interface generations, plus the same complete authority representation as D3.
Portable `definition` untouched.
**M3-D5 Monitor bindings.** In scope: one validator creates/verifies bindings (destination, port/path, protocol,
context, origin policy equivalence; refuse when evidence is absent; recheck monitor drift on reuse). Removing a
binding never deletes the external monitor.
**M3-D6 Alert ownership.** Topology policy alerts carry immutable topology org/site ownership and a unique
origin-independent source key (policy/subject/context/family); origin device = provenance only. Shared alert
authorization and dedupe extended so site access follows the topology site, not the origin device's current site.
(Coordinate with the alerting-consolidation feature #6367, which also changes `alerts`.)
**M3-D7 Diff-aware compile.** Preserve unchanged policy effects (authority stays policy-level; changing a required
target disarms its policy). Also fix blanket queued-run cancellation and settings-revision delivery rejection.
**M3-D8** Configured failure/recovery thresholds (bounded 1–100; new policies default 3/2); keep alertsEnabled,
continuity, cooldown.
**M3-D9 UniFi.** Link/speed only (PoE null until supported-version fixtures prove it); no per-port rates.
**M3-D10 Health.** New run/policy health path. Persisted health revision retained for evidence changes; freshness
expiry via projected content + `freshUntil` for validators/cache. Define multi-context aggregation (current subject
map overwrites).
**M3-D11** Intent store before result mapping; occurrence claim/run/outbox committed atomically.
**M3-D12 MCP.** Thin bounded read tools ship with M3; arming is a documented human-only exemption (spec forbids AI
scheduling).
**M3-D13 Live authority boundary (new).** One revalidation at enqueue, both delivery transports and current-health
publication: requester epochs, current permissions, flags/trust/capability, freshness, full subject/target
dependencies; revoked/expired results fenced independently of sweeper timing.
**M3-D14 Policy targets (new).** Scheduled planning restricted to the policy's pinned target set; execution unit =
policy (not per pair).
**M3-D15 Outbox consumers (new).** Typed consumers + retention protection for telemetry intents, monitoring gaps and
alert transitions (diagnostic intents bypass legacy replay by design).

## C. M4 decisions
**M4-D1** Tools registered globally (domain `network`); invocation requires a server-owned site-pinned session context
(reject unbound/multisite sessions initially; equivalent MCP confinement), org AI policy, resource permissions,
`flags.ai`, capability; `diagnose_connectivity` requires explicit approval.
**M4-D2** `ai_sessions.topology_site_id` (server-owned, immutable, required for topology sessions) + index + composite
FK `(topology_site_id, org_id) → sites(id, org_id)` DEFERRABLE INITIALLY IMMEDIATE; site filter applied before
list/search/count pagination; deletion never clears it; owner restrictions preserved; export classified.
**M4-D3** Deterministic effect digest: scoped loading → pure extraction → live authorization, separated. Pin origin,
dependency versions, immutable proposal expiry; atomic acceptance binding intent/actor/digest. Approver MFA must be
fresh proof — generic actor reconstruction synthesizes `mfa:true` and must not be used.
**M4-D4** Gates, not premises: M2 evidence/manual/UniFi and M3 Tasks 6/10 must be complete with authority/lifecycle
tests. AI readiness reflects server/provider/org policy, not `agentCapabilities.ai`.
**M4-D5** Replace the `topology/graphs.ts` + `topology/diagnostics.ts` MCP gaps with tools and remove their
FROZEN_GAPS entries in the same PR; no implicit parity claims.
**M4-D6 Artifacts (new).** Large tool results become org-only artifacts today — add immutable site provenance +
site authorization across artifacts/replay, or forbid capture for topology tools with strict bounded results. Output
validation precedes persistence and streaming.
