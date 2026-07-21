# Breeze → Weavestream Reconstruction Sync Delivery Roadmap

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement the linked plans task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Deliver a one-way Breeze-to-Weavestream integration that gives each mapped company a complete, native, exportable reconstruction dossier without copying monitoring state or secrets.

**Architecture:** Breeze exposes a versioned, read-only partner API authenticated by a partner-owned service principal. Weavestream consumes it through a built-in pull driver, maps Breeze organizations explicitly to Weavestream companies, and writes typed native targets through its existing integration workers. Asset/IPAM/article entities run before relationships, then a successful full reconciliation may mark unseen source-owned records stale and recalculate reconstruction completeness.

**Tech Stack:** Breeze: Hono, TypeScript, Drizzle ORM, PostgreSQL forced RLS, Redis, Vitest, Astro/React. Weavestream: NestJS, TypeScript, Prisma/PostgreSQL, BullMQ/Redis, Next.js/React, Jest, PDFKit.

## Plan Set

1. [Breeze Partner Integration API Implementation Plan](./2026-07-13-breeze-partner-integration-api.md)
   - General partner-owned service principals and lifecycle management.
   - Dedicated partner-machine authentication and forced-RLS context.
   - Stable `/api/v1/partner-api` DTOs, HMAC-bound cursors, scopes, audit, and secret safety.
   - Durable reconstruction data only: organizations, sites, devices, inventory, software, relationships, configuration, scripts, automations, backup configuration, and custom fields.

2. [Weavestream Native Reconstruction Sync Implementation Plan](./2026-07-13-weavestream-native-reconstruction-sync.md)
   - Generalize the existing asset-only integration framework into typed native targets.
   - Add the Breeze client/driver, recommended layouts, explicit organization mapping, schedules, and manual sync.
   - Write native assets, IPAM, relations, articles, provenance, stale state, and completeness gaps.
   - Extend ordinary company export and PDF output so the result stands alone without Breeze.

The approved product and security contract remains the [Breeze → Weavestream Reconstruction Sync Design](../specs/2026-07-13-weavestream-reconstruction-sync-design.md).

## Global Constraints

- Synchronization is one-way: Breeze to Weavestream. Weavestream never writes back to Breeze.
- Breeze is authoritative only for fields owned by the Breeze source binding. Manual Weavestream content and manual overrides are preserved.
- Include durable, non-secret facts needed to rebuild systems. Exclude status, uptime, metrics, alerts, vulnerabilities, patch posture, logs, sockets, sessions, commands, execution results, backup jobs/snapshots, and other monitoring/control-plane state.
- Never export or persist passwords, API keys, recovery keys, tokens, private keys, TOTP material, encryption keys, provider credentials, session material, or a raw source payload containing those values.
- One Breeze service credential discovers all organizations owned by its partner. Each Breeze organization UUID must be explicitly mapped to a Weavestream company UUID; no name-based tenant mapping or automatic company creation.
- Breeze sites become location assets, not child companies.
- Stable Breeze UUIDs determine identity. Hostnames, names, serials, IPs, and sites are mutable attributes, not identity keys.
- A missing source record is marked stale/archived only after a complete successful full reconciliation. Partial, cancelled, authentication-failed, rate-limited, or schema-incompatible runs preserve last-known-good data.
- Source disappearance never deletes manual notes, uploads, password references, manual relations, or history.
- Weavestream must contain essential reconstruction data natively. Breeze links are optional provenance/navigation only.
- Both repositories use red-green-refactor TDD, adjacent tests, bounded error persistence, and a commit after each green task.

## Resolved Contract Details

The repository review found source-model details that the implementation must handle explicitly:

- Breeze has partner-owned scripts, automations, configuration policies, backup profiles, and custom-field definitions whose `org_id` can be null. The partner API emits each applicable partner-owned definition once per effective organization, retaining the original source UUID and adding that organization UUID. Pagination identity is `(sourceId, orgId)`; Weavestream binding identity is `(externalOrgId, resourceKey, sourceId)`.
- Breeze does not currently model every desired reconstruction fact. Reserved-address semantics, DNS search domains, stable peripheral edges, installation media, license details, firewall rules, and full restore procedures may be absent. The connector must report those as completeness gaps rather than invent values.
- `backup_configs.providerConfig` and `backup_configs.encryptionKey` are never exported wholesale. Backup DTOs are explicit safe projections only.
- Weavestream has no standalone expiration model. Expirations remain expiry-marked asset fields consumed by its existing expiration aggregator.
- Weavestream’s existing `IntegrationFieldMapping.transform` is persisted but not consistently executed or fingerprinted. The native-target work must make transforms bounded, executed, and included in mapping fingerprints before relying on them.
- Weavestream’s present sync worker fans resources out in parallel and its sync record points only to assets. Dependency stages and typed native bindings must land before IPAM reservations and relationship resources are enabled.

## Delivery Gates

### Gate 1 — Breeze machine contract

- [ ] Partner partner-service-principal tables have forced partner-axis RLS and pass the real-PostgreSQL cross-partner forge test.
- [ ] A one-time key can be issued, rotated, expired, disabled, and revoked without changing existing human `api_keys` behavior.
- [ ] Every partner API route requires exactly its documented read scope.
- [ ] Cursor tampering, resource/partner mismatch, expiry, and schema mismatch fail closed.
- [ ] DTO safety tests prove excluded columns and secret-like values cannot leave Breeze.
- [ ] A partner principal cannot enumerate or filter into another partner’s organization or partner-owned definitions.

### Gate 2 — Useful foundational integration

- [ ] Weavestream can store one encrypted Breeze credential, test it, discover source organizations, and map them explicitly to companies.
- [ ] Fifteen-minute scheduled and manual runs create/update site and device assets without copying live status.
- [ ] Stable UUID identity, manual-field preservation, run history, retry behavior, and unmapped-organization skipping are verified.
- [ ] This gate is deployable before advanced reconstruction targets are enabled.

### Gate 3 — Native reconstruction dossier

- [ ] Hardware, disks, interfaces, OS/build facts, software, warranty, network equipment, virtualization, and custom fields exist as native searchable records.
- [ ] Subnets and durable address assignments use Weavestream IPAM; dependency edges use native relations.
- [ ] Policies, assignments, scripts, automations, backup configuration, and procedures use versioned non-secret articles related to affected assets.
- [ ] Secret-blocked, missing dependency, unsupported, ambiguous, validation, stale, and synchronization-error gaps appear in completeness results.

### Gate 4 — Lifecycle and standalone export

- [ ] Incremental checkpoints resume safely and advance only after all pages succeed.
- [ ] Full reconciliation alone can mark unseen bindings stale; a returning record restores the same native target.
- [ ] Company export includes IPAM, relations, provenance age/state, reconstruction summaries, and sanitized gaps.
- [ ] The PDF includes essential assets, IPAM, topology/dependencies, and reconstruction procedures as content, not Breeze-only links.
- [ ] A seeded cross-stack scenario and 10,000-device run meet the correctness and cadence criteria.

## Integration Test Fixture

Use one deterministic cross-stack fixture for contract and end-to-end tests:

```text
Partner A
├── Org A1 → Weavestream Company A1
│   ├── Site HQ
│   ├── Hypervisor HV-01
│   ├── VM APP-01
│   ├── Subnet 10.20.30.0/24
│   ├── Static assignment 10.20.30.10 → APP-01
│   ├── Configuration policy + assignment
│   ├── Rebuild-safe script + automation dependency
│   └── Backup schedule + restore metadata
├── Org A2 → intentionally unmapped
└── Partner-owned policy applied to Org A1 and Org A2

Partner B
└── Org B1 → must remain invisible to Partner A credential and cursors
```

The fixture must also contain one manual Weavestream field edit, one manual article, one password reference, one blocked inline-secret source record, one unresolved relationship, one source record removed before a partial run, and the same source record removed before a successful full run.

## Recommended Pull-Request Sequence

1. Breeze partner-service-principal schema, RLS, issuance service, and lifecycle API/UI.
2. Breeze partner authentication, stable envelope/cursor, organizations/sites/devices.
3. Breeze inventory/software/relationship DTOs and safety tests.
4. Breeze configuration/scripts/automations/backups/custom-fields DTOs, audit, RLS integration, and load scenario.
5. Weavestream typed-target schema, writer registry, transform execution, and migration/backfill.
6. Weavestream Breeze client/driver, organization mapping, recommended site/device layouts, and foundational sync.
7. Weavestream IPAM/article/relation targets and dependency-staged workers.
8. Weavestream provenance, full reconciliation, stale/restore semantics, and completeness UI.
9. Company export/PDF sections, cross-stack E2E, scale/failure injection, and operator documentation.

Do not merge a PR that enables a resource before its target writer, dependency requirements, secret policy, and stale behavior are covered by tests. Feature flags or disabled resource descriptors may be used to land framework work safely before the source endpoint is available.

## Final Acceptance

- [ ] One credential synchronizes every explicitly mapped organization for one partner and no organization for another partner.
- [ ] Every in-scope durable Breeze fact has a documented source DTO and native Weavestream destination.
- [ ] Manual Weavestream documentation survives refresh, source removal, integration deletion, and re-creation.
- [ ] Failed/partial runs preserve last-known-good data.
- [ ] Secret and missing data become safe actionable gaps, never silent omissions or leaked values.
- [ ] A technician can rebuild the documented environment using Weavestream and its standalone PDF while Breeze is unavailable.
