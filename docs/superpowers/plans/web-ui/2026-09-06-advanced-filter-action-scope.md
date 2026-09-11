# RMM-QA-153: complete advanced-filter action scope

Refs #4060. The closure brief predates merged #4783 (HTTP/network failures
already resolve to empty IDs) and #5058 (mutation refresh re-evaluates IDs).
Those fixes remain. Current-main residual gaps: loading retained the previous
scope, cancelled success responses could replace a newer scope, malformed
response bodies were accepted, and Alerts used an independent fail-open,
100-device preview. Existing design: device-group-filter-design (2026-04-07).

Use one discriminated inactive/loading/ready/error resolver for Devices and
Alerts. Only inactive returns null; changed filters, organization scopes and
retries synchronously return empty IDs. Validate complete deviceIds/totalCount
and ignore every cancelled settlement, including delayed JSON decoding. Returning
to a previous scope must request fresh IDs rather than revive an old snapshot.

Hide rows and block selection and bulk entry while unresolved. Revalidate
explicit selected IDs in parent bulk handlers and terminal confirmations; cancel
captured dialogs when the filter or organization changes. Cancel pending
maintenance proof continuation when its dialog unmounts. Active device filters
exclude device-less alerts. Error banners offer retry; a surviving 401 retains
closed state even when auth redirect owns the toast.

Acceptance: hook response/failure/race cases, real component stale selections,
parent dispatch guards and delayed confirmation cancellation, plus real-Postgres
idsOnly completeness beyond 100 matches and tenant isolation through breeze_app.
No schema or migration change. Implementation and open draft review do not imply
merge, production verification, candidate readiness, or formal QA closure.
