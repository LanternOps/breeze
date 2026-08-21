# Security Review Wave 3: Partner-Global Authorization Design

**Date:** 2026-07-11
**Status:** Approved for planning
**Findings:** SR1-03, SR1-09, SR1-10, SR1-11, SR1-12, SR1-18, SR1-19, SR1-21,
SR1-22, SR1-26, SR1-30
**Source:** `internal/security-findings/2026-07-11-playbook-01-multi-tenant-rls-authz.md`
**Reviewed baseline:** `origin/main` at `0f05c1faa274f9c49b96ef57b829d9dbf2989477`

## Objective

Make partner-global administration an explicit capability rather than an inference from rows visible
through request RLS. Partner members with `orgAccess='selected'` or `'none'` must not manage state
that applies to every present or future organization unless a route intentionally returns a
site/org-scoped projection.

## Shared authority contract

All partner-global operations use `canManagePartnerWidePolicies(auth)` from
`apps/api/src/services/partnerWideAccess.ts`. The capability is true only for system scope or partner
scope with `partnerOrgAccess === 'all'`. It is never derived by querying organizations, comparing
`accessibleOrgIds`, or treating an empty result as complete access.

The helper remains a dependency-free leaf and is the sole semantic source for full-partner
authority. Route-specific wrappers may supply a clearer denial message, but must not duplicate the
logic.

Partner-axis RLS continues to isolate different partners. It does not prove that a member may manage
partner-global state inside their own partner.

## Permission model

Add canonical permissions and additive seed/migration rows:

| Capability | Read permission | Manage permission |
|---|---|---|
| Update rings | `update_rings:read` | `update_rings:manage` |
| Patch approvals | `patch_approvals:read` | `patch_approvals:manage` |
| Connected apps and Huntress | `integrations:read` | `integrations:manage` |
| Client AI templates | `client_ai_templates:read` | `client_ai_templates:manage` |
| Partner ticket response templates | `ticket_response_templates:read` | `ticket_response_templates:manage` |
| Partner invoice settings | `billing_settings:read` | `billing_settings:manage` |

Partner Admin retains intended access. Read-only partner roles receive only the capabilities required
by their product contract. Existing custom roles receive no new grant automatically. Permission
migrations target system roles explicitly and idempotently.

Sensitive writes retain existing MFA requirements and add MFA where sibling credential/policy
administration already requires it. A dedicated permission never substitutes for full-partner
authority; both are required for partner-global writes.

## Route contracts

### Roles and access reviews — SR1-03

Role creation/update/deletion, partner-membership privilege changes, and access-review actions that
can revoke or modify partner administrators require full-partner authority. Remove organization-list
completeness checks. Denials occur before user/role queries that could mutate state.

### Authenticator enforcement — SR1-09

Partner-global authenticator-policy mutation requires the existing user-management permission, MFA
where currently required, and full-partner authority. Audit bounded before/after enforcement fields.
Organization-owned authenticator settings, if any, retain their organization contract.

### Account deletion — SR1-10 product decision

Partner-staff privacy requests are a partner-global workflow and require full-partner authority for
list, review, and processing. Organization-member requests remain accessible only when their
authoritative organization membership is within `accessibleOrgIds`. Mixed list responses are built
as the union of these two authorized populations; selected users never receive partner-staff rows.

### Update rings and patch approvals — SR1-11/SR1-12

Update-ring and patch-approval lists require their dedicated read permission. Partner-global lists
require full-partner authority unless the response is explicitly narrowed to authorized
organizations/sites. Create, modify, enable, target, approve, decline, and defer operations require
the manage permission, MFA, and full-partner authority. Derived counts use the same scope as returned
rows.

### Connected applications and integrations — SR1-18/SR1-21/SR1-30

Connected-app/Huntress listing requires `integrations:read`; revoke, credential, and mapping changes
require `integrations:manage`, MFA, and full-partner authority. Read DTOs minimize external tenant,
token, and mapping identifiers. Revocation never accepts a request-controlled partner ID.

### Client AI and response templates — SR1-19/SR1-22

Partner-owned templates require their dedicated read/manage permissions and full-partner authority
for mutation. Organization-owned templates remain org-scoped and must use authoritative org access.
Ownership axis is selected from the persisted parent/template record, not solely request input.

### Partner billing settings — SR1-26

Partner invoice configuration requires `billing_settings:read/manage`; mutations additionally require
full-partner authority and MFA when payment or credential-adjacent fields are affected. Invoice
document permissions do not implicitly grant partner billing-policy administration.

## Ordering and service defense

Authorization middleware runs before request validation that performs external work and before any
system-context transition. Services that mutate partner-global rows accept an explicit authority
capability or independently call the shared helper when they are reachable outside HTTP routes.
AI/MCP tools and background entry points use the same contract.

Every denial proves no database mutation, token revocation, external API call, or audit-success event
occurred. Security denials may emit a bounded denied audit event without sensitive payloads.

## Audit and response minimization

Write append-only audit events for role/admin revocation, authenticator-policy changes, update-ring
and patch decisions, integration credential/mapping changes, partner template changes, and billing
settings changes. Events identify actor, partner, resource, bounded changed fields, and outcome; they
exclude tokens, secrets, full external responses, and unrestricted user lists.

## Rollout

This wave intentionally removes formerly implicit authority from selected/none and custom-role
users. Release notes must list new permissions and explain that Partner Admin retains access while
custom roles require deliberate updates. Permission migrations are additive and remain safe for
older binaries, but rollback must not restore organization-query completeness checks.

The wave should be implemented as one PR because the shared capability and permission vocabulary are
reviewed together, but the implementation plan must use independently reviewed task groups for each
route family.

## Verification

- A shared capability matrix covers system, partner all/selected/none, org, agent, helper, and missing
  membership contexts.
- Each route family tests unauthenticated, wrong scope, missing permission, selected/none, missing MFA,
  and full-partner success with zero-side-effect denial assertions.
- Read tests prove counts, identifiers, and rows share the same scope.
- Mutation tests prove server-derived partner/ownership axes and append-only audit payloads.
- Static route scans verify every adopted endpoint has live permission middleware.
- API typecheck/build, permission seed consistency, focused integration tests, and `git diff --check`
  pass.

## Non-goals

- Replacing partner-axis RLS with application-only authorization.
- Automatically granting new capabilities to arbitrary custom roles.
- Making all selected-user reads full-partner-only when a safe scoped projection exists.
- Renaming the established shared capability helper as unrelated cleanup.
