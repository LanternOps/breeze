# MFA policy activation safety (RMM-QA-167)

Settings writers currently persist restrictions that remove an enrolled user's
last permitted factor. Login correctly intersects inventory with policy, so the
fix belongs at policy activation, not at authentication completion.

Reject changes with HTTP 409 `mfa_policy_would_lock_out_users`, a count capped at
1000 and no user identities. Require an already-enrolled permitted factor before
changing policy; recovery codes are finite emergency credentials and do not
satisfy this requirement. There is no force override or password-only recovery.
Passkeys remain always allowed, including when both TOTP and SMS are disabled.

Evaluate the actual post-merge/replacement settings for every affected partner
and organization membership. Partner security fields override organization
fields; `allowedMethods` is one field, not a recursively merged object. Protect
optional as well as required MFA: login challenges both. Only newly stranded
users block a change, so preexisting broken inventory does not prevent repairs
or unrelated settings changes. Fresh partner/org creation has no enrolled
members and needs no activation preflight.

Inventory is read in detached system DB context, explicitly bounded to the
authorized target memberships. SQL returns only the aggregate, without loading
factor secrets into the application. Query failure prevents persistence.
Participating settings writers hold a partner-keyed advisory transaction lock
before reading settings through the final write, serializing concurrent partner
and child-org policy changes. Whole-blob order, order-cleanup and risk-profile
writes use the same lock so stale cosmetic writes cannot restore old security
settings. The organization mTLS, helper, log-forwarding and software-download
settings writers also lock before reading their shared settings blob. This is not a guarantee against concurrent factor
removal: factor lifecycle operations do not acquire that lock. Auth's existing
live-policy/epoch checks continue to apply; coordinating every factor lifecycle
operation is a separate extension, not silently claimed by this change.

No schema/migration, enrollment-policy weakening, deployment, or formal QA
closure is part of this bounded implementation.
