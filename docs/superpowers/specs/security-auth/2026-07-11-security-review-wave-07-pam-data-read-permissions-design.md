# Security Review Wave 7: PAM and Data-Read Permissions Design

**Date:** 2026-07-11
**Status:** Approved for planning
**Findings:** SR1-13, SR1-14, SR1-20, SR1-28, SR1-29
**Source:** `internal/security-findings/2026-07-11-playbook-01-multi-tenant-rls-authz.md`
**Reviewed baseline:** `origin/main` at `0f05c1faa274f9c49b96ef57b829d9dbf2989477`

## Objective

Separate high-trust PAM decisions and cross-user/operational data reads from generic device or AI
permissions. Preserve current tenant/site isolation while adding the missing capability boundaries.

## Canonical permissions

Add the following permission literals and idempotent permission/role migrations:

| Capability | Permission |
|---|---|
| Approve/deny PAM elevation | `pam:approve` |
| Create/update/delete PAM rules | `pam:manage_policy` |
| Read another user's AI transcript | `ai:audit` |
| Read alert summary/counts | existing `alerts:read` |
| Read patch catalog/job metadata | `patches:read` |

Partner Admin retains full access through its administrative grant. PAM approver and policy-admin
permissions are assigned only to built-in roles whose product contract requires them. Ordinary
technicians with `devices:execute` or `devices:write` do not inherit PAM authority. Existing custom
roles receive no new permission automatically.

## PAM approval — SR1-13

Approval/denial routes require `pam:approve`, MFA, current request visibility, and the existing
approval-policy rules. The request creator cannot approve their own elevation where maker/checker
separation applies. The approver must remain distinct and authorized at the moment of decision.

Generic device execution may remain necessary to perform the eventual authorized elevation, but it
is neither sufficient nor a substitute for approver authority. Approval state transitions use an
expected-state predicate so concurrent decisions cannot both succeed.

Audit events record request, device/org, requester, approver, decision, policy reason, and bounded
duration without command secrets or credential material.

## PAM policy administration — SR1-14

PAM rules are organization-scoped. Create/update/delete requires `pam:manage_policy`, existing MFA,
and authoritative org/site access. This wave does not convert rules to partner scope or change their
RLS tenancy shape.

Rule changes retain validation and approval/review controls. Updates and deletes load the current
rule inside the mutation transaction, authorize its persisted org/site, and audit bounded
before/after conditions/actions. Request-supplied org IDs cannot move a rule across an unauthorized
axis.

## AI transcripts — SR1-20

AI session lists and transcript-by-ID reads are owner-readable by default:

```text
session.user_id = auth.user.id
```

Cross-user reads require `ai:audit` in addition to ordinary AI read access and current org/partner
scope. Query predicates include ownership unless the audited branch is active; checking after an
unscoped lookup is not acceptable. Missing/foreign sessions return the established not-found
response to avoid enumeration.

List DTOs do not expose other users' session IDs, prompts, tool payloads, or cost metadata to
owner-only callers. Cross-user audit reads emit a bounded audit event identifying reviewer, subject,
session ID, and reason/outcome without copying transcript content.

## Alert summary — SR1-28

The alert summary endpoint requires live `alerts:read` permission. Its counts and groupings use the
same organization/site/status predicate as the corresponding alert list for that caller. A summary
cannot be broader than the rows the caller could enumerate.

Missing permission denies before aggregate queries. Empty authorized scope returns zero-valued
counts rather than global data.

## Patch catalog and job metadata — SR1-29

Patch catalog and job/operation metadata require `patches:read`. Device-derived job rows additionally
join the authoritative device and apply current org/site visibility. Partner-global catalog facts
that contain no tenant/device state may be returned with `patches:read`; rollout/job counts and
device identifiers remain scope-narrowed.

Mutation permissions are unchanged by this finding. Read DTOs minimize command payloads, hidden
device identifiers, and provider/internal error text.

## Middleware and service defense

HTTP routes use live `requirePermission` middleware. Shared services accept subject/owner and
accessible-axis inputs or perform an equivalent defense when reachable from AI/MCP/background entry
points. Static route tests prove permission checks are live rather than comments or dead helper
branches.

## Rollout

Custom roles lacking the new permissions lose formerly implicit PAM/cross-user/patch read access.
Release notes must list the exact permission keys and recommended role review. Permission migrations
are additive; no table migration or RLS change is expected.

Rollback can broaden access again and should not remove additive permission rows. Role grants may be
adjusted independently after deployment.

## Verification

- Permission registry/seed tests prove uniqueness and conservative built-in assignments.
- PAM matrices cover generic device-only roles, approver/policy roles, MFA, maker/checker, wrong org,
  hidden site, concurrent decision, and success.
- AI tests cover owner list/read, foreign ID, audit permission, wrong org, and no ID enumeration.
- Alert summary tests prove permission denial and exact list/aggregate scope parity.
- Patch tests cover global catalog facts, device-derived jobs across visible/hidden sites, empty scope,
  and minimized DTOs.
- Audit tests assert exact event count and absence of transcript/credential/command secrets.
- API typecheck/build, route scans, permission migrations, focused integration tests, and
  `git diff --check` pass.

## Non-goals

- Changing PAM rule tenancy from organization to partner.
- Granting PAM authority to every role that can execute or edit devices.
- Making AI transcripts broadly readable inside an organization.
- Exposing hidden-device counts through alert or patch aggregates.
