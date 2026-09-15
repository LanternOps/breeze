---
title: Software Library Hub — project brief (separate service)
status: brief; seeds the hub project's own spec in its own repo
date: 2026-09-07
owner: Todd Hebebrand
area: vuln-patch
related:
  - docs/superpowers/specs/vuln-patch/2026-09-07-verified-software-library-consumer-design.md
  - docs/superpowers/specs/api-platform/2026-09-07-partner-api-execute-scope-design.md
  - docs/superpowers/specs/onboarding-signup/2026-09-07-zero-touch-onboarding-design.md
---

# Software Library Hub — project brief

The hub is the authoring, verification, and publishing half of the Breeze-verified software library. It is a **separate service** (own repo, image, database, release cadence — like `breeze-billing`), runs once in the world, holds no tenant data, and publishes a signed feed that every Breeze region and self-hosted instance replicates. Decision rationale: it is an extra surface that only one root needs; shipping it inside every API image would carry hub code and system tables everywhere and would put publisher authority and tenant execution in one process.

This brief records what was decided in the Breeze brainstorm so the hub's own spec starts from it rather than re-deriving it.

## 1. Responsibilities

1. **Intake**: Breeze-seeded app list; partner app requests and contributions arriving from regions as scrubbed submissions (quota-limited, untrusted metadata).
2. **Authoring**: a platform-scoped **catalog author** AI agent drafts app identity, install recipes (silent install/uninstall args, detection rules, reboot flag), and configuration tasks (test/set/verify) from winget manifests, Homebrew, vendor documentation, and web research; iterates on lab failures within a budget. Draft-only capability — it can never publish.
3. **Lab**: cloud Windows VMs on demand (Azure/AWS), warm pool, snapshot restore, 2-build matrix (current Win11 + previous). **Lab VMs are Breeze devices**: each VM runs the Breeze agent enrolled with lab purpose into a dedicated lab Breeze instance; the hub drives tests through the partner API execute scope. A lab test is a run of lifecycle steps: clean install → detect exact version → (separate snapshot) install previous verified → upgrade → detect → uninstall → detect absent (declared residue contract) → config task verify when present. Assertions are deterministic and evidence-backed (detection performed, exact version, reboot/prompt evidence, residue checks); SHA verification mandatory.
4. **Review & publish**: human reviewer gate for new content (new app, new/changed recipe, new/changed config task); automatic publish on lab pass for new versions of published apps with an unchanged approved recipe. Publication is an atomic, restricted operation that checks matrix completeness and approval state. Trust ladder: `draft → candidate → lab_passed → published`; `deprecated` ≠ `withdrawn`; tombstones; withdrawal propagates through the feed.
5. **Feed**: Ed25519-signed manifest + sequenced entries (apps, recipe revisions, releases, config-task revisions, lab evidence summaries, tombstones). Same key-list/rotation model as Breeze release-artifact manifests. Feed is the product boundary (regions, self-hosters, potentially third parties).
6. **Telemetry back**: scrubbed partner lab-ring counts per release; request status updates routed by opaque refs.

## 2. Data model (hub-authoritative)

- `apps` — canonical identity (winget id, brew name, MSI upgrade codes, install-name patterns), lifecycle, contributor credit.
- `recipe_revisions` — immutable, content-hashed install recipes; reviewer approval attaches here; any change invalidates approval and lab results.
- `releases` — app × version × platform × arch × channel → one recipe revision, artifact `{vendor_url | mirror, sha256, size}`, provenance, predecessor, supersession, state, withdrawal reason. Vendor URL + hash is the primary artifact model; mirroring is a per-release flag.
- `config_task_revisions` — immutable; params schema; test/set/verify bodies; supported release range; tested fixtures.
- `lab_runs`, `lab_attempts`, `lab_assertions` — per release/task revision, matrix image, agent version, scenario, VM lease/incarnation, expected/observed, evidence digest; evidence retained after VM cleanup.
- `requests` — kind, payload, origin region, opaque requester ref, pipeline status.
- `review_events`, `publication_events` — audit.
- `feed_entries` — sequenced, signed batches.

## 3. Security posture

- Author agent: draft-only; no publish capability; budgets; web research capped at medium confidence per the existing Breeze research design; lab evidence — not AI — establishes behaviour; publication grants deployment authority.
- Lab guests isolated from production networks and pool credentials; every VM lease fenced (incarnation id, rotated enrollment credentials, stale commands cancelled, late results rejected); SYSTEM installers can falsify guest evidence, so evidence is collected by the agent/harness, not self-reported by the installer.
- Requests are untrusted metadata: constrained fetching, quotas, no arbitrary URLs executed outside the lab.
- A lab pass is compatibility evidence, not proof of benign software; malware scanning and vendor signature checks are separate gates before publication.
- Redistribution: never mirror without licence; record EULA acceptance requirements per app for the consumer UI.

## 4. Dependencies on Breeze

- Partner API execute scope (spec in this repo) — to run lab steps on lab devices.
- A lab Breeze instance (hosted, internal) with a lab org; devices carry an explicit lab purpose/lifecycle (not `isEphemeral`, which means Quick Support).
- The onboarding runner's step contract (onboarding spec §5.9) extended with lab scenario semantics (uninstall / detect-absent, per-scenario snapshot boundaries).

## 5. Open items for the hub spec

- Provider choice (Azure vs AWS), image pipeline for the 2-build matrix, warm-pool sizing, per-test cost target.
- Reviewer UI scope (queue, diff of recipe revisions, evidence viewer).
- Feed hosting (object storage + CDN), manifest format, rotation runbook.
- Self-hosted licence check on feed fetch (ties to the entitlements spec).
- Contribution licence/attribution terms.
