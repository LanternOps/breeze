---
title: Verified Software Library — Breeze consumer side
status: approved-in-brainstorm, awaiting written review
date: 2026-09-07
owner: Todd Hebebrand
area: vuln-patch
related:
  - docs/superpowers/specs/vuln-patch/2026-09-07-software-library-hub-brief.md
  - docs/superpowers/specs/onboarding-signup/2026-09-07-zero-touch-onboarding-design.md
  - docs/superpowers/specs/billing/2026-09-07-partner-entitlements-design.md
  - docs/superpowers/specs/api-platform/2026-09-07-partner-api-execute-scope-design.md
  - docs/superpowers/specs/vuln-patch/2026-08-15-package-manager-software-library-design.md
  - docs/superpowers/specs/vuln-patch/2026-08-14-org-scoped-software-catalog-design.md
  - docs/superpowers/specs/vuln-patch/2026-08-04-third-party-update-ring-auto-approve-design.md
---

# Verified Software Library — Breeze consumer side

## 1. Summary

A Breeze-verified software library: every app version carries evidence that it silently installs, detects, upgrades in place, and uninstalls cleanly on a Windows build matrix, plus verified per-app configuration tasks. Partners subscribe apps into a partner library; update rings and onboarding plans then only ever install verified, pinned releases.

The library has two halves. The **hub** (authoring, AI drafting, human review, lab orchestration, feed signing) is a **separate service** with no tenant data that runs once in the world — see the companion brief. **This spec covers only what ships inside every Breeze instance**: a read-only replica of the published library fed by a signed feed, subscription and materialisation into the existing partner-wide catalog, ring gating through a pinned release resolver, onboarding step resolution, the partner lab ring, requests, and UI.

Free tier stays as today: raw winget/Homebrew through Breeze. The paid tier is gated by the `verified_library` entitlement (entitlements spec).

## 2. Decisions

| # | Question | Decision |
|---|---|---|
| C1 | Lab compute | Cloud Windows VMs on demand (Azure/AWS), warm pool + snapshot restore; partner lab ring as second stage (hub concern; recorded here for context) |
| C2 | Paid tier | Verified versions **+** managed rollout (rings admit only verified releases) **+** verified configuration tasks. Staged in that order |
| C3 | Lab assertions | Full lifecycle on a 2-build matrix (current Win11 + previous): silent install as SYSTEM, detect exact version, no reboot/prompt, upgrade in place from previous verified, uninstall leaves nothing, re-detect absent; config-task verify when present. Clean-install and upgrade are separate scenarios from separate snapshot restores |
| C4 | Publish gate | Human reviewer for **new content** (new app, new install recipe, new/changed config task); automatic publish on lab pass for new versions of already-published apps with an unchanged approved recipe |
| C5 | Adoption | Partner **subscribes** a global app into a partner-wide library entry that tracks the global source; deployments, rings, plans reference the partner entry |
| C6 | Intake | Breeze-seeded list + partner "request an app" + partner contributions, all through the hub pipeline; cross-tenant fleet-signal ranking deferred pending privacy review |
| C7 | Global tier shape | Separate global tables (not tri-state ownership on `software_catalog`, not `third_party_package_catalog`); partner entries = ordinary partner-wide catalog rows linked by `global_app_id`; version rows **materialised** per subscribed partner with `global_release_id` |
| C8 | Lab runner | Lab VMs are Breeze devices (lab-purpose, ephemeral) in a lab instance; a lab test is a run of verified lifecycle steps through the same runner/step contract as onboarding, with lab-specific scenario semantics; partner lab ring = same test on partner-tagged devices |
| C9 | Hub placement | **Separate service**, own repo/image/DB (like billing); drives lab devices through the partner API execute scope; publishes a signed feed. Breeze ships only the consumer side (this spec) |
| C10 | Multi-region / self-hosted | One hub, many replicas: EU and US regions and self-hosted instances all consume the same Ed25519-signed feed. No shared DB across regions. Upstream traffic (requests, contributions, ring counts) is scrubbed of tenant identifiers |
| C11 | Artifacts | Vendor URL + SHA-256 is the primary artifact model (winget-style, no redistribution); Breeze mirroring is a per-release flag where licence permits or the artifact is ours |
| C12 | Entitlement | Generic partner entitlement feature (own spec); this library uses key `verified_library` |

## 3. Goals and non-goals

**Goals**

- A partner can subscribe a verified app and have rings, deployments, and onboarding plans install only admitted, pinned, hash-verified releases.
- The replica is a faithful, signed copy: identical in EU, US, and self-hosted.
- Tenant edits can never alter managed projections; withdrawals are honoured at delivery time.
- The partner lab ring lets a partner require a pass on their own hardware before adoption, using the same test the hub runs.

**Non-goals (this spec)**

- Authoring, AI drafting, reviewer UI, lab orchestration, VM pool, feed signing (hub brief).
- Cross-tenant fleet-signal ranking (privacy review first).
- macOS lab matrix (schema is platform-aware; hub decides when).
- Selling the feed to third parties (positioning; nothing technical here changes).

## 4. Data model

### 4.1 Replica tables (populated only by the feed client)

All replica tables: no tenant columns; **forced RLS** with a `FOR SELECT` policy `USING (state = 'published')` for any Breeze context and system-scope-only for all other commands; registered in the `rls-coverage` unscoped allowlist with a comment naming this spec. Rows carry `source` (`feed` \| `local`), `content_hash`, `feed_seq`, `withdrawn_at`. Local rows (self-host admin authored) are never touched by sync.

| table | key columns |
|---|---|
| `library_apps` | id (hub uuid), slug, name, vendor, category, platforms[], identity jsonb (winget id, brew name, msi upgrade codes, install-name patterns), state (`published` \| `deprecated` \| `withdrawn`), contributor_credit, icon_key, homepage |
| `library_recipe_revisions` | id, app_id, revision, platform, silent_install_args, silent_uninstall_args, detection_rules jsonb (same schema as `software_versions.detection_rules`), requires_reboot, pre/post script refs, approved_at (hub reviewer), content_hash |
| `library_releases` | id, app_id, recipe_revision_id, version, platform, arch, channel, artifact jsonb `{kind: vendor_url\|mirror\|winget\|brew, url, sha256, size, mirror_key?}`, predecessor_release_id, supersedes_release_id, state (`published` \| `withdrawn`), confidence (`high` only when published with lab pass), published_at, withdrawn_at, withdrawal_reason |
| `library_config_task_revisions` | id, app_id nullable, name, revision, platform, params_schema jsonb, test_script, set_script, verify_script, supported_release_range, approved_at, content_hash |
| `library_lab_evidence` | id, release_id or config_task_revision_id, matrix_image, scenario (`clean_install` \| `upgrade` \| `uninstall` \| `config_task`), result, assertions jsonb (bounded), agent_version, tested_at, evidence_digest |
| `library_feed_cursor` | singleton per instance: last_applied_seq, last_manifest_hash, last_applied_at, last_error |

Export policy: no `org_id`, so no entries required. Cascade: none.

### 4.2 Partner link (changes to existing tables)

| table | change |
|---|---|
| `software_catalog` | `global_app_id` uuid nullable → `library_apps.id`; `tracking_policy` jsonb `{ mode: 'latest_verified' \| 'pinned', pinnedReleaseId?, requireRingPass: boolean, ringPrefs? }`; CHECK `global_app_id IS NULL OR partner_id IS NOT NULL` (only partner-wide rows can be managed); `managed_at`, `unsubscribed_at` |
| `software_versions` | `global_release_id` uuid nullable → `library_releases.id`; `is_managed_projection` boolean default false; unique `(catalog_id, global_release_id) WHERE global_release_id IS NOT NULL`; `withdrawn_at` |
| `software_install_methods` | `global_release_id` nullable provenance (materialised winget/brew methods) |
| `scripts` | materialised config tasks land as system-library scripts (`is_system = true`) with `library_config_task_revision_id` nullable provenance; **published revisions only** — drafts never exist in-region |

Export policy: new jsonb `tracking_policy` = `excludedOpen`; the id/flag columns = `included`.

Write guard: `services/softwareCatalogWrite.ts` (or the existing write path) rejects tenant edits to `is_managed_projection` rows and to the managed fields of a linked catalog row (name/vendor/identity), allowing only the tracking policy and partner-local metadata.

### 4.3 Partner-axis tables (new)

| table | key columns | notes |
|---|---|---|
| `library_ring_results` | id, partner_id, release_id, device_id, scenario, result, assertions jsonb, run_id (onboarding-style run), tested_at, agent_version | shape 3 (`breeze_has_partner_access`); device_id FK; add to `PARTNER_TENANT_TABLES`; also `CORE_DEVICE_CASCADE_DELETE_TABLES` (has device_id, no org_id) — verify the device-cascade contract for partner-axis tables during implementation |
| `library_requests` | id, partner_id, kind (`app_request` \| `contribution`), payload jsonb (name, vendor, notes, script refs), hub_request_ref, status (`queued` \| `drafting` \| `lab` \| `review` \| `published` \| `rejected`), submitted_by, submitted_at, updated_at | mirror of hub status for the requester's UI; hub is source of truth |
| `library_lab_authorizations` | id, partner_id, device_id, authorized_by, authorized_at, revoked_at | explicit destructive-test consent per lab device |

Registration: `PARTNER_TENANT_TABLES`, export policy (jsonb → excludedOpen), device cascade where `device_id` present.

### 4.4 Entitlement

Key `verified_library` from the entitlements registry. Checked at: subscribe route, materialisation job (skip partners without it), delivery claim (managed projections refuse delivery when the partner lost the entitlement **and** the version was materialised after the loss — versions materialised while entitled remain installable).

## 5. Feed client

- Job `libraryFeedSync` (BullMQ, repeat every 15 min + admin force). Fetches the hub manifest (`GET {LIBRARY_FEED_URL}/manifest.json`) and entry pages by sequence.
- Verification: Ed25519 signature over the canonical manifest using `LIBRARY_FEED_PUBLIC_KEYS` (same key-list format and verifier as `RELEASE_ARTIFACT_MANIFEST_PUBLIC_KEYS`). Invalid signature, sequence gap, or hash mismatch ⇒ stop, record `last_error`, alert platform, keep serving last good state.
- Apply: idempotent upsert on `(id, content_hash)`; strictly increasing `feed_seq`; tombstones set `withdrawn_at` and cascade `withdrawn_at` onto materialised projections in the same transaction.
- Post-apply: enqueue `libraryMaterialize` for affected apps.
- Config: `LIBRARY_FEED_URL`, `LIBRARY_FEED_PUBLIC_KEYS`, `LIBRARY_FEED_ENABLED` (default off until the hub exists; fixture feed for tests).
- Admin: `GET /platform/library/feed-status`, `POST /platform/library/feed-sync` (platform admin + MFA).

## 6. Subscribe and materialise

- `POST /software/library/apps/:id/subscribe` (partner admin, entitlement, `canManagePartnerWidePolicies`): creates the partner-wide `software_catalog` row linked to the app with default tracking policy `{mode: 'latest_verified', requireRingPass: false}`; triggers materialisation for that entry. Idempotent: re-subscribe re-links a previously unsubscribed row.
- `PATCH .../tracking-policy`; `POST .../unsubscribe` (detaches; existing versions remain; managed flags cleared on the catalog row only, projections stay immutable).
- Job `libraryMaterialize(appId | catalogId)`: for each linked, entitled entry and each published release admitted by its policy (`latest_verified` ⇒ newest published release for the entry's platform(s), or the ring-passed newest when `requireRingPass`; `pinned` ⇒ that release only), upsert `software_versions` (+ install methods, detection rules, artifact URL/hash) as managed projections; set `is_latest` per existing partial-unique contract; skip withdrawn.
- Config tasks: materialise the published revision into a system-library script per task revision (idempotent on revision id) and link from the entry (`software_catalog.config_task_script_ids` or a small join table — implementer's choice, documented in the plan).

## 7. Rollout gating (rings) and pinned release resolver

- Problem (verified): third-party rings dispatch package-manager "latest" (`install_patches` without an exact release) via `patchJobExecutor`. For managed entries this is forbidden.
- `services/library/pinnedReleaseResolver.ts`: `resolveAdmittedRelease(catalogId)` → the entry's admitted release (policy + ring pass + not withdrawn + entitlement), or `null`.
- `patchApprovalEvaluator`: the spec'd-but-unbuilt `requireBreezeTested` hook is implemented as `requireVerifiedRelease` for managed entries: a third-party patch for a managed app is auto-approvable only if it maps (by identity) to the entry's admitted release; execution for managed entries routes through `softwareDeployment` with the pinned `software_versions` row, never through `winget upgrade`.
- Deferral days and ring semantics unchanged. Non-managed entries keep today's behaviour.

## 8. Onboarding integration

- `install_software` steps reference a partner entry + version intent (onboarding spec §5.9). Compile: `latest` ⇒ `resolveAdmittedRelease` at compile time, pinned into the manifest with digest and detection rules; `exact` ⇒ must be a materialised, non-withdrawn version. Missing ⇒ compile error ⇒ run `escalated` (onboarding §6.4).
- The entry's config task (if any) is attached as a `config_task` step immediately after the install step when the plan author enables "apply verified configuration" (default on for managed entries).
- The plan editor's software picker filters to managed entries by default with a toggle.

## 9. Partner lab ring

- Devices are tagged `lab` and require an explicit authorization row (destructive test consent).
- Trigger: materialisation of a new release for an entry with `requireRingPass`. The runner dispatches the hub's lifecycle test as a run (`kind = 'library_lab'`, distinct from onboarding runs but the same runner/step machinery): clean install (snapshot-less: uninstall-if-present first) → detect → upgrade scenario when a previous admitted release is present → uninstall → detect absent → config task verify when present.
- Results → `library_ring_results`; adoption for that partner flips when `N` devices pass (policy, default 1). Failures block adoption for that partner only and show on the entry.
- Upstream: scrubbed `{releaseId, pass, fail}` counts posted to the hub (no device or partner identifiers).
- Only **published** releases are ever tested on partner devices.

## 10. UI and API

- **Marketplace** (Software → Library): browse/search published apps; verification status, matrix coverage, last pass, config tasks; Subscribe / Request an app / Contribute. Locked-visible when unentitled.
- **Partner library**: subscribed entries, tracking policy, admitted vs pending releases, withdrawn notices, ring status, config-task settings.
- **Lab ring**: tab on entry and device group; lab devices, authorization, per-release results.
- **Requests**: submitted requests/contributions with hub status; notify on publish.
- **Badges**: "verified" on deployments and rings for managed entries; onboarding picker default filter.
- **API** (`routes/software/library/*.ts`, resource per file): `apps` (replica read), `releases`, `subscriptions`, `tracking-policy`, `requests`, `ring-results`, `lab-authorizations`. Partner API: read-only `library/apps`, `library/subscriptions`. All web mutations via `runAction`.

## 11. Security and tenancy

- Replica: forced RLS, published-only SELECT, system-only writes; never elevate ordinary reads to system context.
- Managed projections immutable to tenants (write guard + test).
- Delivery re-checks: withdrawn, entitlement, digest present (SHA verification is **mandatory** for managed versions — the agent path currently verifies only when a checksum is supplied; managed versions always supply one).
- Config tasks execute only from published revisions materialised as system scripts; no draft ever reaches a tenant instance.
- Ring tests need explicit per-device authorization; a lab pass is compatibility evidence, not proof the software is benign — the marketplace copy says so.
- Upstream submissions carry no tenant identifiers; the hub request ref is opaque.
- Feed keys rotate like release-manifest keys (list of public keys, overlap window).

## 12. Failure handling

| failure | behaviour |
|---|---|
| feed signature invalid / sequence gap / hash mismatch | stop applying; last good state served; platform alert; `feed-status` shows error |
| release withdrawn after materialisation | projections `withdrawn_at`; delivery refuses at claim; entry shows notice; rings skip |
| entitlement lost | no new materialisation; existing versions installable; marketplace locked-visible |
| ring test fails | adoption blocked for that partner; visible; counts upstream |
| hub unreachable | nothing degrades; replica serves; requests queue locally until reachable |
| tenant edits a managed projection | 409 with stable error code; UI hides the edit affordance |
| compile finds no admitted release | onboarding run escalated at admission |

## 13. Testing

- Feed client unit tests: signature (valid/invalid/rotated key), sequence gap, idempotent re-apply, tombstones cascade.
- Materialisation integration (real Postgres): idempotency on the unique key, policy admission (`latest_verified`, `pinned`, `requireRingPass`), withdrawal cascade, projection immutability guard, entitlement skip, `is_latest` contract.
- Pinned resolver + evaluator tests: managed entry never resolves to package-manager latest; withdrawn/unentitled ⇒ null.
- Tenancy: replica read policy (published only, drafts absent by construction); partner-axis suites for the three new tables (cross-partner forge 42501); export-policy and cascade registration; composite/deferrable FK checks where `org_id` is involved (none expected).
- Ring: authorization required; only published releases; results scoped to partner; upstream payload contains no identifiers (assert on the serializer).
- Playwright: marketplace subscribe, library tracking policy, requests, locked-visible state.

## 14. Rollout (waves; `LIBRARY_FEED_ENABLED` off until the hub feed exists; fixture feed in tests)

1. Replica tables, feed client, entitlement hook, platform feed-status/sync endpoints.
2. Subscribe/unsubscribe, tracking policy, materialisation, marketplace + partner library UI, write guard.
3. Pinned release resolver, ring gating (`requireVerifiedRelease`), managed-entry execution via deployments.
4. Config-task materialisation as system scripts; onboarding compile integration and picker filter.
5. Partner lab ring: authorizations, `library_lab` runs, results, adoption gate, upstream counts.
6. Requests and contributions, partner API reads, docs, badges.

Dependencies: entitlements spec before wave 1; onboarding runner (onboarding wave 2) before wave 5; hub feed before anything is visible to real partners.

## 15. Open questions

1. Materialised config tasks as `scripts.is_system` rows vs a dedicated `library_config_tasks_materialized` table — default: system scripts with provenance column, because execution and admission already exist for them.
2. Device-cascade contract for partner-axis tables carrying `device_id` (`library_ring_results`) — confirm against `cascadeDelete.test.ts` in wave 5.
3. Ring pass threshold semantics (N devices vs N% of lab devices) — default N=1, plan-overrideable.

## Appendix A. Codex advisor quorum (2026-09-07)

Agreed on C7 (separate global tables, materialised projections with `global_release_id`) and C8 (lab VMs as agent-enrolled devices) with qualifications adopted here: recipes as immutable revisions separate from releases; per-assertion lab evidence; clean-install vs upgrade as separate snapshot scenarios; managed rings must route through a pinned release resolver (verified: today's rings dispatch package-manager latest); partner lab stages only after publication; drafts never staged as system scripts; enforce publication/entitlement/digest/revocation at resolution, dispatch **and** claim; keep AI research confidence (medium cap) separate from lab evidence and publication authority; deprecated ≠ withdrawn, tombstones; requests are quota-limited untrusted metadata; a lab pass is not proof of benign software.
