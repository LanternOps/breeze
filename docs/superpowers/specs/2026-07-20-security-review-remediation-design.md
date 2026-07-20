# Security Review Remediation Design

## Scope

Resolve all 29 retained findings in `internal/security-review-2026-07-20.md` against branch base `8672b2b15628652bb5fc63ac3022741f3c3af0ec`. The five partially verified findings (#3, #16, #21, #24, and #25) are fixed according to their corrected mechanisms and severities, not the overstated original wording.

## Authorization model

- Partner-global resources use the existing `canManagePartnerWidePolicies(auth)` capability. Request-RLS-visible organization counts are never used to infer full-partner authority.
- Site-restricted users are authorized with `canAccessSite`/`allowedSiteIds` before a target is read, queued, or mutated. Bulk writes authorize the complete input set before performing any write.
- Portal unsafe cookie-authenticated requests pass the existing double-submit CSRF validation and reject non-JSON bodies where JSON is required. Bearer-token portal clients remain exempt from cookie CSRF.
- Quote accept/decline requires a persisted authorized recipient for that quote. Existing quotes without an authorization record fail closed for legal/billing actions until re-sent or explicitly authorized.
- Organization-scoped administrators may not change global `users.name` or `users.status`. This closes the shared-identity escalation without introducing a second identity-state model in this remediation.
- Main-agent telemetry routes require the main `agent` credential; watchdog credentials remain confined to watchdog-specific routes.

## Data and network safety

- UniFi requests use the existing `safeFetch` network policy with private/reserved-address rejection, redirect revalidation, DNS pinning, timeout, and response-size limits. Hosted UniFi behavior remains configurable without creating a second URL validator.
- Portal invoice responses use an explicit customer-safe DTO. Internal cost, margin, provenance, approval, and implementation identifiers are absent by construction.
- `network_known_guests` receives a fix-forward, idempotent flat partner-axis RLS migration and is added to the RLS contract allowlist.
- Quote recipient authorization uses a tenant-scoped, forced-RLS table created by a date-prefixed idempotent migration and covered by the RLS contract.

## Audit and failure behavior

- Ticket category/config, inbound disposition, and domain-mapping mutations emit actor-attributed append-only audit events after successful writes only. Audit metadata contains identifiers and changed field names, never mail bodies, tokens, or credentials.
- Authorization failures return 403 before database mutations, queue submission, vendor calls, or system-context entry. Cross-tenant or hidden-resource lookups retain the route's existing 404 semantics where appropriate.

## Testing strategy

Each domain follows red-green TDD in adjacent Vitest files. Security assertions cover unauthenticated/insufficient-scope access, selected/none partner access, denied-site access, cross-contact portal access, no-side-effect denial, and happy paths. New RLS shapes use the real-database contract tests. Final verification runs API typecheck, all affected Vitest files in bounded `vitest run` mode, RLS/drift checks when local services permit them, and a whole-branch independent review.

