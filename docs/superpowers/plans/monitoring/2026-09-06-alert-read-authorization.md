# Alert read authorization and summary scope (RMM-QA-205)

Base: `0fc5464a858c9882d9c6ba138a2d79931d156720`. Refs #4060.

## Contract and implementation

Require `alerts:read` for summary, detail, escalation-policy list and linked-ticket
reads, matching the alert list and sibling rules/channels routes. Linked tickets
also retain `tickets:read`. Denial precedes alert queries and enrichment. Existing
permission middleware intentionally rejects AI-agent HTTP principals.

Use the permission middleware's resolved site scope consistently for list,
summary and read-by-id. Extract the existing list predicate: unrestricted has no
site filter, an empty site list admits only deviceless alerts, a nonempty list
admits deviceless alerts and devices in those sites. Partner fleet reads retain
their accessible organization filter and unrestricted site semantics. Policies
remain organization-wide because they have no site ownership. Preserve list's
default dismissed exclusion and summary's existing all-status total contract.

Inspect correlation enrichment and omit inaccessible group aggregates for
restricted readers if they expose broader membership. Preserve router mount
ordering. Failed summary reads must render unavailable counts in dashboard,
fleet and analytics; mobile must preserve a meaningful failure/unavailable
contract without manufacturing zero statistics.

This supplies RMM-QA-204's shared detail-read permission gate only. Notification
recipient authorization and read-time notification revocation remain outstanding.
No schema migration, alert mutation, deployment or QA closure is in scope.

## Executable verification plan

1. Add focused denied-read tests asserting 403 and no alert/enrichment queries;
   retain separate ticket permission and write-route tests.
2. Add real PostgreSQL integration acceptance using the private `pnpm test-stack
   up` database, unprivileged application connection and real permission lookup.
   Cover custom organization/partner roles with and without alert read, selected
   organization and fleet scope, cross-organization denial, site A/B and empty
   allowlists, deviceless visibility, and list/summary/detail count agreement.
3. Test mounted web consumers on summary 403 and successful scoped counts, plus
   mobile service denial behavior. Existing navigation permission tests remain
   applicable.
4. Run focused API/web/mobile suites and typechecks, then coordinated full API
   tests with at most two workers. Use command-scoped `caffeinate` for long runs.
5. Obtain independent exact-head review, fix findings, publish one draft PR,
   monitor exact-head CI and fix failures. Stop at a reviewed open PR; merge and
   candidate verification are separate tracker states.
