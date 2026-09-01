# Authentication browser/native transition rollout

This runbook is the operator gate for issue #3852. The current code is **Phase 1 only**: deploy-safe native binding transport, pre-gate telemetry, bounded cleanup, and browser contracts. It does not authorize the Phase 2 compatibility removal.

## Current Phase 1 state

- Keep `AUTH_BROWSER_TRANSITIONS_ENFORCED=false`.
- Keep `AUTH_BROWSER_TERMINAL_PREPARATION_ENABLED=false`.
- Keep `issueUserSessionLegacyDuringTransition` and the one-argument `mintRefreshTokenFamily(userId)` overload.
- Keep the final zero-legacy source assertions skipped/inactive.
- Do not add or export `AUTH_BROWSER_TRANSITION_GUARD_COMPLETE = true`.
- Native issuer requests send `x-breeze-auth-transition: v1` plus the signed `x-breeze-native-auth-binding` value persisted as `breeze_native_auth_binding_v1`. The raw mobile-device ID selects native transport but grants no authority.
- A 428 response may install one replacement binding and retry once. Session-generation fencing prevents a response captured before logout from restoring token, CSRF, or binding state.
- The daily cleanup processes at most 500 expired `logout_pending` rows with `FOR UPDATE SKIP LOCKED`. It emits `retiredPending`; `deletedRetired` stays zero and retired binding digests remain permanent tombstones.

## Schema-first and fleet-first deployment

1. Apply the W07-A schema and RLS changes to every database. Verify migration drift and the unprivileged RLS forge tests.
2. Deploy W07-B through this Phase 1 build to every API replica with both flags false.
3. Release the native-capable mobile build. Confirm binding bootstrap, 428 retry, login/MFA/refresh, logout, and account-switch behavior on supported iOS and Android versions.
4. Confirm every API replica emits `auth_transition_legacy_issuer_total{issuer,client_class}`. Review all issuer labels (`password`, `cf_access`, `totp`, `sms`, `recovery`, `passkey`, `refresh`, `registration`, `invite`, `cf_access_redirect`) and both client classes (`web`, `native`).
5. Record the evidence below. The observation window starts only after the minimum supported native version is available in every required app store and the Phase 1 API is present on every replica.

## External rollout evidence — required before Phase 2

These fields are intentionally unfilled in Phase 1. Operators must attach immutable dashboard/release evidence; a code merge is not evidence.

| Gate evidence | Required record |
|---|---|
| Minimum supported mobile version | Not yet recorded — external release pending |
| iOS availability and release timestamp | Not yet recorded — external release pending |
| Android availability and release timestamp | Not yet recorded — external release pending |
| Every API replica on Phase 1 build | Not yet recorded — deployment pending |
| Configured `REFRESH_FAMILY_ABSOLUTE_TTL_DAYS` | Record deployed value; default is 30 days |
| Zero-supported-client observation start | Not yet started |
| Zero-supported-client observation end | Must be at least one full configured maximum refresh-family lifetime after the last availability/replica timestamp |
| `auth_transition_legacy_issuer_total` evidence | Attach per-replica, per-issuer, per-client-class query/export showing zero events from supported clients for the entire window |
| Unsupported-version UX verification | Attach iOS and Android evidence for stable HTTP 426 `auth_client_upgrade_required` upgrade handling |
| Gate approver and timestamp | Not yet approved |

Do not infer readiness from a shorter quiet period. Restarted counters, missing replicas, missing issuer labels, or an app store that has not completed rollout reset or delay the observation start. Dormant native clients below the recorded minimum are unsupported; when they return after enforcement they receive HTTP 426 with upgrade UX, not legacy issuance.

## Phase 1 monitoring and rollback

Monitor binding bootstrap success, 428 retry rate, issuer failures by status, issuance lease conflicts, SSO exchange outcomes, `retiredPending`, and `auth_transition_legacy_issuer_total` on every replica. Stop rollout on unexplained binding-rotation loops, session-generation restore reports, elevated authentication failures, cross-account binding reuse, or missing telemetry.

Phase 1 rollback is the application build only; leave the additive schema in place and keep both flags false. Never roll back by deleting transition rows or tombstones.

## Exact Phase 2 work deferred by the external gate

Only after every evidence field above is complete and approved:

1. Delete `issueUserSessionLegacyDuringTransition` and its branded legacy cookie boundary.
2. Delete the one-argument `mintRefreshTokenFamily(userId)` overload.
3. Activate the final source contracts proving `createTokenPair` is called only from `services/userSession.ts`, `setRefreshTokenCookie` only from `routes/auth/helpers.ts` and the authorized durable SSO exchange in `routes/sso.ts`, and the legacy issuer export is absent.
4. Export the build-owned `AUTH_BROWSER_TRANSITION_GUARD_COMPLETE = true` marker only in that post-gate build. Add startup refusal when enforcement is requested without the marker. Retain the existing rule that terminal preparation requires enforcement.
5. Deploy that final guarded build to every replica. Then enable `AUTH_BROWSER_TRANSITIONS_ENFORCED=true` in one controlled rollout. Roll back the flag, not schema, if bootstrap or upgrade failures exceed the approved threshold.
6. Enable `AUTH_BROWSER_TERMINAL_PREPARATION_ENABLED=true` only after every replica enforces guarded issuance.
7. Keep nullable legacy current-JTI classification until the same lifetime gate has elapsed; plan `NOT NULL` as a separate fix-forward migration with row-count warnings.
8. Keep retired transition tombstones indefinitely. Any deletion requires a separate fleet-authoritative binding-key retirement design.

Phase 1 closure means the additive foundation and evidence machinery are deployable. It does **not** mean zero legacy surface or completion of issue #3852's externally gated Phase 2.
