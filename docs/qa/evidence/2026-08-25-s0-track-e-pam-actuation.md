# S0 Track E PAM actuation task report

## Task E3 transition-owner inventory

- Web approve/deny/revoke and PAM-rule disable/delete: `apps/api/src/routes/pam.ts`, routes `POST /elevation-requests/:id/respond`, `POST /elevation-requests/:id/revoke`, `PATCH /rules/:id`, and `DELETE /rules/:id`.
- Mobile approve/deny bridge: `apps/api/src/routes/approvals.ts`, route `POST /:id/:decision`.
- Agent ingest auto-approve/auto-deny: `apps/api/src/routes/agents/elevationRequests.ts`, route `POST /`.
- Active-window and stale-pending expiry: `apps/api/src/jobs/pamJobs.ts`, `enforceElevationExpiry` and `expireStaleRequests`.
- Executable software-policy disable/delete: `apps/api/src/routes/softwarePolicies.ts`, routes `PATCH /:id` and `DELETE /:id`; matches are identified by `elevation_requests.metadata.software_policy_match_id`.
- Entitlement cleanup boundary: `apps/api/src/services/pamEntitlementCleanup.ts`, `removePamEntitlement`.
- Legacy v1 elevation actuation producer (owned by Task E4 protocol reconciliation): `apps/api/src/routes/devices/actuateElevation.ts`, route `POST /:id/actuate-elevation`.

## Entitlement-owner disposition

Graph and targeted API-source searches found license operations for external products (for example Google Workspace and Pax8 subscriptions), billing cancellation, tenant teardown, and authentication/session revocation. None is a shipping owner for a Breeze PAM device/user entitlement or calls a PAM entitlement-removal transaction.

No valid `EntitlementOwnerDisposition` exists yet. In particular, absence of a caller is not a Product-owned `not_applicable` decision. Task E3 can be code-complete with the tested `removePamEntitlement` boundary, but Track E closure remains blocked until Product records:

```ts
{ kind: 'not_applicable', shippingSku: string, productDecisionRef: string }
```

or a real shipping caller is identified, integrated into its winning transaction, and covered by a real-Postgres integration test.

## Task E3 verification

- Focused API transitions: 251/251 passed across PAM web, mobile approvals, agent ingest, expiry, entitlement boundary, and software-policy removal suites.
- Real PostgreSQL transition matrix: 3/3 passed for monotonic cleanup/outbox commit, rollback atomicity, and cross-organization rejection.
- Real PostgreSQL exposed and drove fixes for two raw-SQL binding defects: explicit `timestamptz` expiry binding and explicit cleanup-cause text typing.

This evidence does not claim endpoint cleanup, deployment, hosted reachability, physical enforcement, customer rollout, or an entitlement disposition.
