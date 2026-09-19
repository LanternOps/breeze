# MFA policy activation implementation

1. Add aggregate-only inventory preflight using actual settings inheritance and
   fresh system-scoped reads pinned to the authorized partner/organization.
2. Serialize partner and child-org settings writers; guard partner PATCH variants
   and shared organization PATCH/PUT before encryption/persistence.
3. Pin rejection/no-write and authorization behavior in route tests. Real DB
   acceptance covers TOTP/SMS/mixed/passkey/disabled-passkey/unenrolled/recovery,
   partner and org membership, inheritance replacement/removal, tenant isolation,
   newly-stranded semantics, aggregation bounds and concurrent settings writes.
4. Verify affected tests, full API, API typecheck with pinned runtime, independent
   exact-head review and draft PR CI. Stop before merge/candidate verification.

The closure brief's force override and configurable-passkey examples are stale:
this implementation preserves passkey availability and refuses unsafe changes.
