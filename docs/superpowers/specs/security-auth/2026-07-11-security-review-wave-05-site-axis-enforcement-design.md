# Security Review Wave 5: Site-Axis Enforcement Design

**Date:** 2026-07-11
**Status:** Approved for planning
**Findings:** SR1-05, SR1-06, SR1-07, SR1-23
**Source:** `internal/security-findings/2026-07-11-playbook-01-multi-tenant-rls-authz.md`
**Reviewed baseline:** `origin/main` at `0f05c1faa274f9c49b96ef57b829d9dbf2989477`

## Objective

Apply current site restrictions to every object read or mutated by onboarding, device link/group,
legacy group, and ticket-triage workflows. Organization access alone must not authorize effects on a
hidden site.

## Shared site-authorization model

Introduce a shared fail-closed service that resolves authoritative sites and evaluates them against
the authenticated context:

```ts
interface SiteAuthorizationTarget {
  siteId: string;
  orgId: string;
}

function assertSiteTargetsAccessible(
  auth: Pick<AuthContext, 'scope' | 'orgId' | 'accessibleOrgIds' | 'accessibleSiteIds'>,
  targets: readonly SiteAuthorizationTarget[],
): void;
```

The helper treats system scope and explicit all-site access according to the existing auth contract.
An empty selected-site list means no site access, not all sites. Callers pass targets loaded from the
database; request-supplied org/site relationships are never trusted without authoritative lookup.

For multi-row mutations, resolution, authorization, row locking, and mutation occur in one
transaction so membership cannot change between the check and write. Helpers return bounded IDs or
throw a stable denied/not-found error; they do not enter system scope on behalf of an unauthorized
request.

## Onboarding token contract — SR1-05

Onboarding token creation requires an explicit `siteId`. The route verifies that the site belongs to
the authorized target organization and that the caller currently has site access. It no longer
chooses an unordered first site.

The web UI and API clients must supply the site selected by the administrator. Missing `siteId`
returns a validation error with migration guidance. Public enrollment continues to consume the
server-bound token site and cannot override it.

Token records retain the authoritative org/site pair, and the enrollment transaction revalidates
that the site still belongs to an active organization before creating the device. It does not need
to re-evaluate the creating user's later permissions because the token is the delegated enrollment
capability, but revocation/expiry behavior remains unchanged.

## Device link groups — SR1-06

List/read behavior follows these rules:

- A group with no visible member is omitted.
- A partially visible group returns only visible members and a bounded indicator that additional
  hidden members exist; hidden device/site identifiers and total hidden count are not exposed.
- Group metadata that would identify a hidden-only group is not returned.

Rename, delete, dissolve, membership add/remove, and any operation that unlinks devices resolve and
lock every current and target member. The mutation succeeds only when all affected sites are
accessible. Partial mutation is forbidden.

## Legacy device groups — SR1-07

Create/update/delete/parent/membership operations use the shared helper for:

- the group's current site;
- the requested target site;
- the current and requested parent group sites;
- every device whose membership will be added, removed, or deleted;
- descendants or inherited memberships affected by a destructive operation.

Moving a group across sites requires access to both source and target. Setting a parent requires the
child and parent to belong to compatible authorized organization/site axes. Delete/dissolve locks
the group hierarchy and affected memberships before authorization.

Read endpoints suppress inaccessible groups and do not leak parent names/counts derived from hidden
sites. Existing full-site callers retain their current response shape.

## Ticket triage metrics — SR1-23

Triage feedback is not scoped by its own foreign key alone. Evaluation joins each feedback row to
the authoritative ticket and, where present, device/site relationship, then reuses the same ticket
site predicate as ticket listing.

- Device-backed tickets are visible only when the device site is accessible.
- Deviceless tickets follow established org-visible ticket semantics; they are not assigned an
  arbitrary site.
- Summary counts, override rate, numerator, and denominator use the identical predicate.
- Empty visible populations return zero-valued metrics without falling back to org-wide data.

## Transaction and error behavior

All multi-object mutations authorize inside their write transaction using locked authoritative
rows. A concurrent move or membership change either completes before the check and is included, or
waits until the mutation finishes. No check-then-write gap is permitted.

Denied objects use the existing 404/403 convention without disclosing hidden site existence. Lists
filter rather than fail when their contract is visibility-oriented; mutations fail atomically when
any affected target is hidden.

## Audit

Onboarding token creation and group mutations emit append-only events containing actor, org, visible
site IDs, group/token ID, operation, and outcome. Events do not enumerate hidden members in a denied
request. Triage reads do not require per-request audit unless existing analytics policy requires it.

## Rollout

This wave intentionally removes cross-site behavior from restricted users and makes `siteId`
mandatory for onboarding-token creation. Update web/API clients in the same PR. Full-access partner
and org administrators retain intended behavior after selecting a site.

No schema migration is expected unless a missing authoritative site relationship must be added. Any
new tenant column or table must follow the repository RLS workflow in the same migration.

## Verification

- Shared-helper matrix covers system, all sites, one selected site, empty selection, wrong org, and
  stale/missing site.
- Onboarding tests prove explicit accessible site success and missing/hidden/wrong-org rejection.
- Link/group tests use one visible and one hidden site and prove list suppression/partial DTO plus
  atomic mutation denial with zero membership changes.
- Concurrency tests pause after row locking and prove member/site changes cannot bypass authorization.
- Triage tests cover visible device tickets, hidden device tickets, deviceless tickets, mixed counts,
  and empty populations with row/count parity.
- Existing device/ticket RLS integrations, API typecheck/build, web client tests, and
  `git diff --check` pass.

## Non-goals

- Adding site-axis RLS to every organization-scoped table.
- Assigning synthetic sites to deviceless tickets.
- Returning hidden member counts to make partial groups look complete.
- Changing device enrollment wire formats beyond the authenticated token-creation request.
