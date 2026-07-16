# Breeze → Weavestream Reconstruction Sync Design

**Date:** 2026-07-13

**Status:** Approved design, pre-implementation

**Systems:** Breeze RMM and Weavestream

**Direction:** One-way, Breeze to Weavestream

**Primary implementation location:** Weavestream, with a reusable partner API and partner-service-principal foundation in Breeze

## Objective

Synchronize every durable, rebuild-relevant fact available in Breeze into native Weavestream records so Weavestream contains a complete reconstruction dossier for each managed organization.

The integration is documentation infrastructure, not a monitoring mirror. A technician must be able to use Weavestream without Breeze being available and find the hardware, software, network, configuration, dependency, backup, and procedural information needed to rebuild a system. Breeze deep links may improve navigation, but no essential reconstruction detail may exist only behind a Breeze link.

Weavestream remains the documentation system of record. Breeze is authoritative only for fields synchronized from Breeze. Manually authored Weavestream documentation, relationships, credential records, diagrams, and custom fields remain authoritative in Weavestream.

## Product decisions

1. One partner-wide Breeze connection discovers every organization accessible to that partner. Operators do not create one credential per organization.
2. Breeze-owned fields are refreshed from Breeze. Manual Weavestream-owned fields are never overwritten by synchronization.
3. Records that disappear from Breeze are marked stale or archived only after a successful full reconciliation; they are never automatically deleted.
4. Incremental pulls run every 15 minutes and can also be triggered manually. Event-driven acceleration is deferred; periodic full reconciliation remains authoritative even if events are added later.
5. Secret values, recovery keys, authentication material, command output, logs, sessions, alerts, vulnerabilities, metrics, and other transient monitoring state are not synchronized.
6. The Breeze API is a general partner integration API, not a Weavestream-branded endpoint.
7. The systems retain separate databases, authentication, storage, queues, deployments, and release lifecycles. There is no shared database, iframe, or in-process embedding.
8. Weavestream data is normalized into its native concepts. A large opaque Breeze JSON document is not an acceptable destination model.

## Existing foundations

Weavestream already has the appropriate pull-integration shape:

- `IntegrationDriver` supports connection testing, external-organization discovery, source-field discovery, and cursor-paginated records.
- The Action1 and NinjaOne drivers demonstrate RMM inventory import and external-organization-to-company mapping.
- BullMQ workers provide manual and scheduled synchronization, retries, run history, and mapping-level jobs.
- Assets carry stable external-source and external-ID metadata.
- Company exports and the PDF worker already render companies, assets, articles, passwords, domains, uploads, and article images.

Breeze already has most source data and some required security primitives:

- Partner, organization, site, device, hardware, network, disk, software, warranty, configuration-policy, script, automation, backup, virtualization, and relationship data exist in tenant-scoped services and schemas.
- API keys already support validated scopes, hashing, expiry, rate limits, audit attribution, and an RLS request context, but current keys and device-list routes do not provide the required partner-wide machine contract.
- The approved core-authentication design introduces explicit non-human service principals. This integration consumes that general capability rather than creating a special integration credential.

## Architecture

```text
Breeze partner service principal
        │ HTTPS, read-only, cursor-paginated REST
        ▼
Breeze partner integration API
        │ explicit export DTOs; partner/RLS enforcement
        ▼
Weavestream BreezeDriver
        │ organization mapping + typed resource adapters
        ▼
Weavestream sync workers
        │ entity pass → relationship pass → completeness pass
        ▼
Native Weavestream companies, assets, IPAM, relations, and articles
        │
        └── normal Weavestream UI, search, audit, backup, and export/PDF flows
```

### System boundary

Breeze exposes versioned, read-only DTOs. Weavestream calls those endpoints and owns all transformation and documentation behavior. Breeze does not write into Weavestream, call Weavestream webhooks, or understand Weavestream layouts.

Weavestream stores the Breeze base URL and one-time service credential through its existing encrypted integration-secret service. The driver uses Weavestream's guarded outbound HTTP transport. A self-hosted Breeze URL on a private network requires an explicit administrator-configured egress CIDR allowlist; private-network access is never enabled globally by the connector.

## Breeze partner integration API

### Authentication

The connection uses a partner-owned service principal with no interactive login, password, MFA, or recovery behavior. The principal has an active/disabled lifecycle, human creator and last-updater attribution for audit, independently assigned scopes, optional expiry and source-IP restrictions, and dedicated issuance, rotation, and revocation. Its database ownership axis is direct `partner_id` (tenancy shape 3), enforced with the flat `breeze_has_partner_access(partner_id)` policy rather than hierarchy traversal. Key rows use the same explicit partner ownership and forced-RLS contract.

The plaintext key is displayed once, stored only as a hash in Breeze, and encrypted at rest in Weavestream. Authentication establishes the owning partner and the set of organizations under that partner before opening the database access context. Forced RLS remains the final data boundary.

Required read scopes:

- `organizations:read`
- `sites:read`
- `devices:read`
- `inventory:read`
- `configuration:read`
- `scripts:read`
- `backup-configuration:read`
- `custom-fields:read`

The principal receives no device execution, remote access, user management, secret reading, log reading, or administration scopes.

### Routes

The initial stable contract is mounted below `/api/v1/partner-api`:

- `GET /organizations`
- `GET /sites`
- `GET /devices`
- `GET /device-inventory`
- `GET /device-software`
- `GET /device-relationships`
- `GET /configuration-policies`
- `GET /configuration-assignments`
- `GET /scripts`
- `GET /automations`
- `GET /backup-configurations`
- `GET /custom-fields`

The implementation may compose these routes from existing Breeze services, but it must not serialize ORM rows. Each response uses an explicit export schema and a common envelope:

```json
{
  "schemaVersion": "1",
  "snapshotAt": "2026-07-13T12:00:00.000Z",
  "data": [],
  "nextCursor": null,
  "hasMore": false
}
```

Every record includes a stable UUID, owning organization ID, site ID where applicable, source update timestamp, and a resource-specific revision or deterministic fingerprint. Collections use cursor pagination. Resources with reliable update timestamps accept `updatedSince`; full reconciliation does not depend on timestamps.

`snapshotAt` bounds a traversal so changes made during pagination do not cause false disappearance. Cursor values are opaque and bound to the resource, partner, sort order, and snapshot. A mismatched or expired cursor fails with a structured client error rather than restarting silently.

### Export safety

Export DTOs are allowlists. Sensitive database columns do not appear in the DTO types or queries. A recursive output guard additionally rejects or redacts secret-like field names and bounded secret patterns before serialization.

Script, automation, policy, and backup configuration exports contain complete non-secret desired state. If a definition contains an inline secret or cannot be safely separated from secret material, Breeze returns bounded metadata identifying the blocked record and reason, not a partially trustworthy reconstruction definition. Weavestream records the item as a documentation-completeness gap requiring manual remediation.

## Weavestream connector

### Driver and typed resources

Add a built-in `BreezeDriver` to the existing integration-driver registry. It retains the standard driver behavior for credentials, connection tests, organization discovery, field discovery, scheduling, mappings, and run history.

Extend the integration resource model so a driver resource declares one native destination kind:

- `asset`
- `ipam`
- `relationship`
- `article`
- `expiration`

Typed destination adapters own validation and writes for their native model. The Breeze driver produces normalized source records; it does not issue ad hoc Prisma writes across unrelated services.

The sync runner executes resources in dependency order:

1. companies and locations;
2. assets, IPAM entities, configuration articles, and procedures;
3. relationships and assignments;
4. completeness evaluation and export indexing.

### Organization mapping

One Breeze connection lists all source organizations. An administrator explicitly maps each Breeze organization UUID to one Weavestream company UUID. Names and slugs are display hints only and never become tenant keys.

Unmapped organizations are visible but skipped. Synchronization cannot auto-create or auto-map a company without an explicit administrator action. A source organization move between Breeze partners is treated as an authorization/mapping conflict, not an automatic reassignment.

Breeze sites become location assets related to their Weavestream company. They do not become nested companies because a Breeze site and a Weavestream child company have different authorization semantics.

## Reconstruction data model

### Companies and assets

| Breeze source | Weavestream representation |
|---|---|
| Organizations | Companies |
| Sites | Location assets |
| Managed endpoints | Server or workstation assets |
| Discovered network equipment | Firewall, switch, access point, printer, or appliance assets |
| Hypervisors, virtual machines, and database hosts | Specialized assets |
| Hardware, disks, interfaces, firmware | Structured asset fields |
| OS edition, architecture, roles, and install facts | Structured rebuild fields |
| Installed software and versions | Rebuild software inventory related to the asset |
| Groups, tags, and custom fields | Tags and mapped fields |
| Warranty, vendor, and lifecycle dates | Asset support and expiration fields |

The stable Breeze UUID is the external ID. Asset layout selection and source-field mapping remain configurable per resource. The connector ships recommended layouts and mappings but does not overwrite an administrator's customized layout.

### Network and IPAM

Synchronize durable network configuration needed to re-create connectivity:

- interfaces and MAC addresses;
- assigned static or reserved IP addresses;
- subnets and prefix lengths;
- VLAN identifiers and names;
- gateways, DNS servers, and search domains;
- device-to-interface and interface-to-IP relationships;
- known hypervisor, VM, host, peripheral, and network-device links.

Transient connection tables, current sockets, discovered clients without durable identity, and short-lived DHCP observations are excluded. A dynamic address may be retained as an informational asset field when it is the only known address, but it is not represented as an authoritative reservation.

### Desired configuration and procedures

Durable desired state is stored as versioned Weavestream articles/procedures related to the affected assets:

- configuration-policy definitions and assignments;
- rebuild-safe scripts and script parameters;
- automation definitions and dependencies;
- backup targets, schedules, retention, exclusions, and restore procedure metadata;
- installation sources, system roles, and ordered post-build validation steps when present in Breeze.

The synchronized article records retain a source revision and source fingerprint. Manual notes live in separate Weavestream-owned sections or related articles so a source refresh cannot erase them.

Credential requirements are represented as relations to manually managed Weavestream password records or as explicit missing-documentation requirements. Breeze never exports secret values, recovery keys, agent tokens, API keys, passwords, private keys, or session material.

### Relationships

Relationships are resolved only after all entity resources have been upserted. Each edge records its source, external relationship key, and last successful observation. Examples include:

- company → site;
- site → device;
- hypervisor → virtual machine;
- host → peripheral;
- device → interface → IP address;
- asset → configuration policy;
- asset → rebuild procedure;
- asset → backup configuration;
- asset → credential reference;
- service/application → dependent host or database.

An unresolved endpoint does not create a dangling cross-tenant edge. It becomes a bounded synchronization warning and completeness gap.

## Field ownership and provenance

Every synchronized entity, field, article, and relationship records:

- integration ID;
- source organization UUID;
- source resource and external ID;
- source revision or fingerprint;
- first-seen, last-seen, and last-synchronized timestamps;
- ownership (`breeze` or `weavestream`);
- stale/archive state where applicable.

Breeze-owned values update when their source fingerprint changes. Weavestream-owned values are not candidates for source writes. Where a layout intentionally permits a manual override of a Breeze field, the existing preserve-manual conflict behavior wins and the run records the conflict.

Source removal never deletes manual notes, related articles, password references, uploads, or relationships created by a user. Archiving a source asset preserves its reconstruction history and visibly distinguishes last-known configuration from current source data.

## Documentation completeness

Synchronization can fill only facts Breeze knows. Weavestream therefore evaluates each mapped company and asset against a reconstruction checklist defined by its layout and resource type.

Typical required items include:

- administrative credential reference;
- installation media or verified download source;
- license and activation information;
- rack, room, or physical location;
- IP allocation and required firewall rules;
- backup destination and restoration procedure;
- service and data dependencies;
- ordered rebuild procedure;
- post-restoration validation steps;
- vendor and escalation contact.

The completeness view separates:

- synchronized and current;
- manually documented;
- blocked because Breeze contained secret-like inline data;
- missing from Breeze and requiring a technician;
- stale because the source record disappeared;
- synchronization error.

Completeness is recalculated after a successful resource run. A failed synchronization does not downgrade previously complete documentation merely because the source was temporarily unavailable.

## Synchronization lifecycle

Each mapped company/resource pair has an independent job, cursor checkpoint, last-known-good completion marker, and run history.

### Incremental run

1. Validate the service principal, partner identity, API schema version, and organization mapping.
2. Read from the last committed `updatedSince` checkpoint.
3. Traverse cursor pages, validate and normalize each page, and stage its writes.
4. Commit valid records and the page checkpoint atomically.
5. Resolve relationships whose dependencies are available.
6. Recalculate affected completeness results.
7. Advance the incremental high-water mark only after all pages succeed.

### Full reconciliation

A scheduled full traversal periodically enumerates every included resource at a bounded `snapshotAt`. Only a fully successful traversal may mark unseen source-owned records stale. Partial, cancelled, authentication-failed, rate-limited, or schema-incompatible runs retain the prior last-known-good state.

The full interval is configurable and defaults to daily. The 15-minute incremental schedule and manual `Sync now` action are independent of the full-reconciliation schedule.

### Moves and identity changes

Stable Breeze UUIDs, never hostname, IP address, serial number, or display name, determine identity.

A device moving between two mapped organizations is reassigned only after both mappings and the destination tenant authorization are validated. A move involving an unmapped organization is quarantined for review. Hostname, IP, site, or hardware changes update the existing asset and append normal provenance/audit history rather than creating duplicates.

## Failure handling

- Authentication or authorization failure pauses the connection and requires administrator action.
- HTTP 429 and transient 5xx/network failures use bounded exponential backoff with jitter and honor `Retry-After`.
- Page checkpoints make retries resumable without replaying an entire fleet.
- Invalid individual records are quarantined with bounded field errors while other valid records continue, unless the error proves the resource schema is incompatible.
- Unknown API schema versions fail visibly before writes.
- Relationship failures cannot roll back already valid entity records, but they keep the run in a warning state and create completeness gaps.
- No failed run overwrites or removes last-known-good reconstruction data.
- Error messages, rejected values, and audit details pass through secret redaction before persistence.

Run history records start/end time, partner and mapped company, resource, mode, schema version, page and record counts, creates/updates/conflicts/stale counts, quarantines, retries, warnings, and a bounded error summary.

## Audit and observability

Breeze audits partner-service-principal creation, scope changes, key rotation/revocation, authentication failures, and export requests. Request audit includes principal ID, partner, route/resource, result, record count, and duration, never credentials or response bodies.

Weavestream audits integration credential changes, organization mapping changes, manual and scheduled runs, field conflicts, archive transitions, relationship changes, and completeness changes. Metrics cover run duration, lag, pages, records, retry counts, quarantines, stale transitions, and consecutive failures.

## Export and PDF behavior

Native Weavestream data is authoritative; PDF is a downstream representation. The ordinary company export must include all synchronized reconstruction assets, articles, IPAM data, relationships, expirations, and provenance summaries needed to understand record age.

Extend the existing PDF builder where necessary so IPAM, dependency relationships, and reconstruction procedures are included in a standalone company PDF. Essential information is rendered as content, not as a Breeze hyperlink. Links may be included only as optional provenance/navigation aids.

PDF generation does not automatically include secret values. Existing Weavestream password-export controls remain explicit and independent from Breeze synchronization.

## Testing strategy

All implementation follows red-green-refactor TDD. New tests are placed alongside source files and use the conventions of each repository.

### Breeze unit and route tests

- Partner partner-service-principal issuance, one-time reveal, hashing, rotation, expiry, disablement, revocation, and audit.
- Each read scope independently permits its intended routes and denies every other scope.
- Unauthenticated, human-key, wrong-partner, inactive-partner, invalid-scope, and revoked-key requests fail closed.
- Cursor binding, pagination boundaries, `updatedSince`, `snapshotAt`, invalid cursor, rate limit, and schema-version behavior.
- Export DTO snapshot tests prove sensitive and internal-only fields cannot appear.
- Script/policy/backup exporters reject inline secret material and return bounded blocked-record metadata.
- Empty fleets, missing optional relations, large field collections, and source records changing during traversal.

### Breeze integration and RLS tests

- Real-Postgres tests prove a partner principal can read only organizations owned by its partner.
- Cross-partner reads and forged organization filters return no data or fail authorization as specified.
- Every new partner-service-principal table declares its tenancy shape, enables and forces RLS in its creating migration, and joins the RLS coverage contract in the same change.
- Export queries run under the unprivileged application role and never require bare/system database access after authentication.

### Weavestream driver and sync tests

- Connection testing and organization discovery.
- Explicit organization mapping and unmapped-organization skipping.
- Every resource transformation and recommended layout.
- Manual-field preservation and conflict reporting.
- Two-pass relationship creation with out-of-order source records.
- Incremental checkpoint resume, full reconciliation, and stale-only-after-complete behavior.
- Organization moves, source renames, duplicate display values, and stable UUID identity.
- Partial pages, 429/5xx retry, authentication pause, unknown schema version, and quarantined records.
- Secret-pattern rejection before storing articles or configuration.
- Completeness evaluation for synchronized, manual, missing, blocked, stale, and error states.

### End-to-end and scale tests

- Run both stacks with seeded partner, organizations, sites, devices, network topology, policies, scripts, and backup configurations; verify native Weavestream records and relationships.
- Modify and remove source data, run incremental and full reconciliation, and verify ownership and stale semantics.
- Generate and visually inspect a company PDF to confirm that reconstruction data is understandable without Breeze access.
- Exercise at least 10,000 devices with realistic software and network cardinality; the 15-minute incremental cycle must not overlap itself indefinitely or exhaust either system's normal connection pool.

## Delivery sequence

### Phase 1: Breeze machine-auth foundation

Deliver general partner-owned service principals, lifecycle UI/API, validated read scopes, RLS context, audit, and the versioned partner API envelope.

### Phase 2: Weavestream foundational connector

Deliver the Breeze driver, encrypted credential configuration, connection test, organization discovery/mapping, schedules, manual sync, companies, sites, and foundational device assets.

### Phase 3: Reconstruction inventory

Add hardware, disks, OS facts, software, warranty, vendors, network interfaces, IPAM, network equipment, virtualization, and dependency relations.

### Phase 4: Desired configuration

Add configuration policies and assignments, rebuild-safe scripts, automation definitions, backup configuration, reconstruction articles, and secret-blocked gap handling.

### Phase 5: Completeness and lifecycle

Add provenance, manual/source ownership, incremental checkpoints, full reconciliation, archive semantics, moves, completeness views, audit, and operator diagnostics.

### Phase 6: Standalone export and hardening

Extend exports/PDF for IPAM and dependency relationships, verify 10,000-device scale, complete failure-injection testing, and publish setup, scope, rotation, backup, and recovery documentation.

Each phase is independently deployable. Phase 2 provides a useful basic integration; later phases deepen reconstruction completeness without changing the source-of-truth or security model.

## Explicitly out of scope

- Bidirectional synchronization or Weavestream writes into Breeze.
- Live status, uptime, metrics, alerts, incidents, vulnerabilities, patch posture, raw logs, current sockets, sessions, or command history.
- Remote desktop, terminal, scripts execution, device commands, or other control-plane actions.
- Copying passwords, recovery keys, API keys, agent tokens, private keys, session material, or other secret values from Breeze.
- Shared authentication, SSO, iframe embedding, shared database tables, or direct database reads.
- Event/webhook delivery in the first release.
- Automatic company creation or name-based tenant mapping.
- Automatic deletion of documentation when a Breeze source disappears.

## Success criteria

The design is successfully implemented when:

1. One partner service principal can synchronize every explicitly mapped organization without accessing another partner's data.
2. Every durable, non-secret, rebuild-relevant Breeze resource in scope has a native Weavestream representation and documented mapping.
3. A source refresh updates Breeze-owned values without overwriting manual Weavestream documentation.
4. Partial and failed runs preserve the last-known-good reconstruction dossier.
5. Missing or secret-blocked information appears as an actionable completeness gap.
6. Source removals archive records only after successful full reconciliation and never delete manual content.
7. A technician can use Weavestream, including its standalone company export/PDF, to understand how to rebuild the documented environment without Breeze being available.
8. Cross-partner integration tests prove tenant isolation under Breeze's unprivileged application role and forced RLS.
9. A 10,000-device partner completes incremental synchronization within the configured cadence under the agreed deployment envelope.

## References

- Weavestream repository: <https://github.com/Weavestream/Weavestream>
- Weavestream driver contract: `apps/api/src/integrations/drivers/integration-driver.ts`
- Weavestream driver registry: `apps/api/src/integrations/drivers/integration-driver.registry.ts`
- Weavestream sync runner: `apps/api/src/integrations/integration-sync-runner.service.ts`
- Weavestream worker orchestration: `apps/worker/src/integration-sync/`
- Weavestream company export data: `apps/api/src/exports/company-export-data.service.ts`
- Weavestream PDF builder: `apps/worker/src/company-pdf-export/pdf-builder.ts`
- Breeze API-key authentication: `apps/api/src/middleware/apiKeyAuth.ts`
- Breeze API-key scopes: `apps/api/src/services/apiKeyScopes.ts`
- Breeze device routes: `apps/api/src/routes/devices/`
- Breeze extension/RLS contract: `extensions/README.md`
- Breeze partner-service-principal design foundation: `docs/superpowers/specs/2026-07-11-core-authentication-hardening-design.md`
