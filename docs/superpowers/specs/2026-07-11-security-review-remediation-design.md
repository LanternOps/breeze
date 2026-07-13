# Playbook #1 Security Remediation Design

**Date:** 2026-07-11
**Status:** Approved for planning
**Source:** `internal/security-findings/2026-07-11-playbook-01-multi-tenant-rls-authz.md`
**Reviewed baseline:** `origin/main` at `2a88b9a3a454db56cef5dc8b009bb1ec9e3dcd75`

## Objective

Remediate all 29 confirmed findings from security-review playbook #1 and resolve the one partial
finding, SR1-10, through an explicit product contract. Deliver the work as small, independently
reviewable security PRs with non-vacuous regression tests, reversible rollout boundaries, and no
unrelated refactoring.

## Scope decision

The remediation will ship in eight waves rather than one large PR or one PR per finding. Each wave
owns one security boundary and can be reviewed, deployed, and rolled back independently.

SR1-10 will be treated as a security contract change: partner-staff account-deletion requests are a
partner-global privacy workflow and therefore require full-partner authority. Selected/none partner
users may continue to administer organization-member requests only within their accessible
organizations if the route can express that distinction safely; otherwise the admin surface fails
closed to full-partner authority.

## Security invariants

The implementation must preserve these invariants across all waves:

1. Partner-axis RLS is tenant isolation, not proof of partner-global management authority.
2. Partner-global writes require system scope or partner scope with `partnerOrgAccess === 'all'`.
3. Site restrictions fail closed and are checked against every affected current and target object.
4. Sensitive credential or policy transitions require both a dedicated permission and MFA where
   the sibling administrative flows require MFA.
5. Background/system context is entered only after request authorization and with server-derived
   tenant identifiers.
6. Security-relevant mutations produce append-only audit events without secrets or raw tokens.
7. Every regression test proves the vulnerable pre-fix behavior fails and the fixed behavior passes.

## Wave 1 — Microsoft 365 ticket-mailbox security

**Findings:** SR1-01, SR1-08, SR1-25.

### Tenant ownership and consent binding

Replace the unsigned `tenant` callback trust with a two-stage verified flow:

1. An authenticated full-partner mailbox administrator initiates consent. Breeze creates a pending
   connection and signed browser-binding state.
2. Microsoft admin consent may return a tenant hint, but Breeze does not persist or probe that hint.
3. The callback transitions into a tenant-specific OpenID Connect authorization-code flow. Breeze
   validates the returned code using PKCE/nonce; validates token `iss`, `aud`, `exp`, and `tid`; and
   verifies that the Microsoft principal holds an accepted Entra administrative role capable of
   consenting to enterprise applications. The accepted role set is explicit and tested.
4. Breeze then proves the app-only consent is effective by acquiring a tenant-specific application
   token and probing only the requested mailbox.
5. The verified `tid` becomes the only tenant ID eligible for persistence and Graph polling.
6. A partner-to-Entra-tenant ownership record prevents the same verified tenant from being claimed
   by another partner. Tenant GUIDs are normalized before a database-enforced global unique
   constraint. Connections reference ownership through a same-partner composite relationship.

The implementation must not treat `admin_consent=True`, a browser query parameter, or successful
app-only token acquisition as tenant ownership proof.

### Existing connections

The migration marks non-disabled mailbox connections and disabled rows retaining legacy tenant or
cursor state `reauth_required`, clears their tenant and delta cursor, and records that ownership
verification is absent. Already-disabled clean rows remain disabled and are not resurrected. The
data-change block records its affected row count in PostgreSQL logs. Polling and outbound Graph
replies remain disabled until the connection completes the new verified flow. This is an
intentional operational breaking change and requires release-note and administrator re-consent
instructions.

### Authorization and response minimization

Add dedicated mailbox read/admin permissions. Lifecycle mutations require mailbox-admin permission,
MFA, and full-partner authority. Listing requires mailbox-read permission and returns a reduced DTO;
opaque Graph cursors, internal errors, and creator identifiers are not returned by default.

Seed Partner Admin with mailbox read/admin and appropriate viewer roles with mailbox read only.
Custom roles fail closed until explicitly granted the new permission.

### Audit

Emit append-only events for consent initiation, verified tenant binding, failed verification,
retest, and disable. The unauthenticated callback obtains its actor only from verified signed state.
Audit details include partner ID, connection ID, mailbox, verified tenant ID where appropriate, and
sanitized outcome; they never include codes, tokens, secrets, or delta links.

## Wave 2 — Effective request database role

**Finding:** SR1-02.

Resolve the canonical unprivileged connection URL before constructing the exported request pool.
Support the documented password-only configuration by deriving the `breeze_app` URL before pool
creation. In production, startup probes the exact request pool and refuses to serve traffic when
`current_user` is superuser or has `rolbypassrls`.

`DATABASE_URL` remains the migration/system connection. `DATABASE_URL_APP`, when supplied, remains
the explicit request connection. Unsafe configurations fail startup with an actionable error. This
is an intentional fail-closed configuration change, not a silent fallback.

## Wave 3 — Partner-global authorization

**Findings:** SR1-03, SR1-09, SR1-10, SR1-11, SR1-12, SR1-18, SR1-19, SR1-21, SR1-22, SR1-26,
SR1-30.

Use one authoritative shared capability helper for partner-global administration. Do not derive
completeness by querying organizations inside request RLS.

Add dedicated permissions where the operation represents a distinct administrative capability:

- mailbox permissions are owned by Wave 1;
- update-ring and patch-approval read/manage;
- integration read/manage;
- Client AI template management;
- partner billing-settings management where existing invoice permissions are too broad.

Seed permissions into system roles conservatively. Partner Admin retains intended access. Existing
custom roles do not inherit new global authority automatically. Reads that legitimately serve
selected users must return only data derived from accessible organizations; otherwise they require
full-partner authority.

## Wave 4 — Atomic provisioning quota

**Finding:** SR1-04.

After ordinary org/site authorization, reserve partner capacity and insert the device atomically
through a narrowly scoped database operation. The operation uses the authoritative partner ID from
the authorized target organization, locks or otherwise serializes quota consumption, counts all
non-decommissioned partner devices outside request RLS, and rejects when capacity is exhausted.

Already-over-limit partners may manage existing devices but cannot provision another device. This
is an intentional behavior change. The implementation must not split the privileged count and
insert into separate transactions.

## Wave 5 — Site-axis enforcement

**Findings:** SR1-05, SR1-06, SR1-07, SR1-23.

- Onboarding tokens require an explicit accessible site, or select only from the caller's allowed
  sites and fail when none exist.
- Link-group reads suppress groups with no visible members. Rename/delete/dissolve checks every
  affected member site inside the mutation transaction.
- Legacy device-group create/update/delete/parent/membership routes validate current, target,
  parent, and affected device sites with a shared fail-closed helper.
- Ticket triage evaluation joins feedback to authoritative ticket/device relationships and reuses
  the established ticket site-scope semantics, including deviceless tickets.

These changes intentionally remove existing cross-site behavior from selected-site users.

## Wave 6 — Helper, remote, and tunnel authorization

**Findings:** SR1-15, SR1-16, SR1-17, SR1-27.

- Helper authentication applies the same active partner/org lifecycle check as main agent auth.
- Every remote/tunnel credential mint re-evaluates current permission, MFA, session ownership, and
  device site scope rather than trusting stale session authorization.
- Tunnel close applies the same current authorization contract as tunnel creation.

Suspended tenants and users whose access was reduced mid-session lose access immediately. Existing
agent and viewer wire formats remain unchanged.

## Wave 7 — PAM and data-read permissions

**Findings:** SR1-13, SR1-14, SR1-20, SR1-28, SR1-29.

Add dedicated PAM approver and PAM policy-admin permissions. Preserve maker/checker rules and MFA.
The PAM-rule finding is org-scoped; the fix changes permission granularity, not tenancy shape.

AI transcripts are owner-readable by default. Cross-user access requires a dedicated AI audit/admin
permission. Alert summaries require alert-read permission. Patch catalog/job metadata requires the
appropriate patch/device-read permission and site narrowing for device-derived values.

Custom roles without the new permissions lose the formerly implicit access until explicitly
updated. Default role seeds preserve the intended Partner Admin and security-approver workflows.

## Wave 8 — Ticket financial audit coverage

**Finding:** SR1-24.

Ticket-part create, update, and delete write append-only audit events. Update/delete capture bounded
before/after financial fields and the actor before destructive mutation. Mutation and audit use one
transaction or a durable outbox so a successful financial mutation cannot silently lose its audit.

This wave is additive and should not change the ticket-part API contract.

## Migration and rollout contract

- All schema migrations are hand-written, date-prefixed, idempotent, and ordered explicitly when
  same-day dependencies exist.
- New tenant-scoped tables receive ENABLE/FORCE RLS and policies in their creation migration, plus
  the matching RLS coverage allowlist entry and real-database forge test.
- Permission migrations are additive. System-role assignments are explicit and idempotent.
- No shipped migration is edited.
- Each behavior-changing wave includes a release-note entry and operator guidance.
- Wave 1 deploys migration and API together; polling remains fail-closed until re-verification.
- Wave 2 should ship immediately after Wave 1 or independently as an emergency hardening release.

## Test strategy

Every wave follows TDD and the Breeze testing contract.

### Required authorization matrix

Test unauthenticated, wrong scope, missing permission, missing MFA, `orgAccess='all'`,
`orgAccess='selected'`, `orgAccess='none'`, wrong org, and selected/empty site allowlists where
applicable. Tests must use valid UUIDs and prove the protected service/database mutation was not
called on denial.

### Mailbox-specific tests

- Reject direct callback tenant injection even with valid Breeze state/cookie.
- Reject invalid issuer, audience, nonce, PKCE exchange, expired token, and mismatched `tid`.
- Reject claiming a tenant already owned by another partner.
- Mark legacy rows `reauth_required`; poll and outbound reply paths skip them.
- Verify reduced list DTO, permission gates, full-partner gate, and exactly-once audit emission.

### Database-role tests

- Password-only supported configuration constructs the request pool as `breeze_app`.
- Explicit app URL is honored.
- Superuser/BYPASSRLS effective pool fails startup, including `AUTO_MIGRATE=false`.
- The real-Postgres RLS contract remains green.

### Verification per wave

Run focused unit/integration suites, API typecheck/build, relevant static authorization coverage,
`test:rls-coverage` for RLS/schema waves, and `git diff --check`. Security-sensitive regression
tests must be demonstrated red before the production fix and green afterward.

## Delivery and rollback

Each wave uses its own clean worktree and branch. PR titles use the repository's `fix(scope): ...`
convention and disclose behavior changes without publishing exploit instructions. No wave is merged
until focused tests, required CI, and security/code review are complete.

Rollback never re-enables an unsafe path silently. For example, rolling back Wave 1 leaves legacy
mailbox connections disabled; rolling back Wave 2 requires an explicitly safe app-role
configuration. Additive permission and audit migrations remain compatible with older binaries.

## Non-goals

- Re-running the full playbook #1 discovery sweep.
- Unrelated route refactoring or file splitting.
- Changing the agent or viewer wire protocols.
- Automatically granting new global permissions to arbitrary custom roles.
- Publishing exploit details in public issues or PR descriptions before fixes are deployed.
