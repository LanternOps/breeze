# Authentication browser/native transition rollout

This runbook is the operator gate for issue #3852. The current source is a **local Phase 2 candidate** with guarded user-session issuance enforced unconditionally. That code state does not authorize a merge, release, deployment, or compatibility cutoff: the external fleet evidence and explicit approval below remain mandatory.

## Current candidate state

- Keep `AUTH_BROWSER_TERMINAL_PREPARATION_ENABLED=false`.
- `issueUserSessionLegacyDuringTransition`, its legacy cookie installer, and the request-header/environment downgrade dispatch are removed. The zero-legacy source assertions are active.
- The one-argument `mintRefreshTokenFamily(userId)` overload remains only for test/fixture and non-issuer compatibility; no production session issuer calls it. Removing that dormant overload remains hardening work.
- Native issuer requests send `x-breeze-auth-transition: v1` plus the signed `x-breeze-native-auth-binding` value persisted as `breeze_native_auth_binding_v1`. The raw mobile-device ID selects native transport but grants no authority.
- A 428 response may install one replacement binding and retry once. Session-generation fencing prevents a response captured before logout from restoring token, CSRF, or binding state.
- The daily cleanup processes at most 500 expired `logout_pending` rows with `FOR UPDATE SKIP LOCKED`. It emits `retiredPending`; `deletedRetired` stays zero and retired binding digests remain permanent tombstones.

## Schema-first and fleet-first deployment

1. Apply the W07-A schema and RLS changes to every database. Verify migration drift and the unprivileged RLS forge tests.
2. Before deploying this candidate, obtain the explicit compatibility approval below. The removed enforcement flag cannot be used as a staged rollback control.
3. Release the native-capable mobile build. Confirm binding bootstrap, 428 retry, login/MFA/refresh, logout, and account-switch behavior on supported iOS and Android versions.
4. Use evidence retained from the Phase 1 build's `auth_transition_legacy_issuer_total{issuer,client_class}` metric for every issuer and both client classes. The candidate no longer emits new legacy-issuer events because no legacy issuer exists.
5. Record the evidence below. The observation window starts only after the minimum supported native version is available in every required app store and the Phase 1 telemetry build is present on every replica.

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
| Unsupported-version UX verification | Attach iOS and Android evidence that clients below the supported binding protocol fail safely without a retry loop, including 428 replacement-binding behavior |
| Gate approver and timestamp | Not yet approved |

Do not infer readiness from a shorter quiet period. Restarted counters, missing replicas, missing issuer labels, or an app store that has not completed rollout reset or delay the observation start. Dormant native clients below the recorded minimum are unsupported. They must fail safely and present approved upgrade UX; they can no longer select legacy issuance and the removed 426 response is not available as a server-side compatibility signal.

## Candidate monitoring and rollback

Monitor binding bootstrap success, 428 retry rate, issuer failures by status, issuance lease conflicts, SSO exchange outcomes, `retiredPending`, and `auth_transition_legacy_issuer_total` on every replica. Stop rollout on unexplained binding-rotation loops, session-generation restore reports, elevated authentication failures, cross-account binding reuse, or missing telemetry.

Rollback is the application build only and reopens the legacy-issuance race; leave the additive schema in place and keep terminal preparation disabled. There is no enforcement flag rollback. Never roll back by deleting transition rows or tombstones.

## Candidate release work gated by external evidence

Only after every evidence field above is complete and approved:

1. Verify the active source contracts proving `createTokenPair` is called only from `services/userSession.ts`, `setRefreshTokenCookie` only from `routes/auth/helpers.ts` and the authorized durable SSO exchange in `routes/sso.ts`, and the legacy issuer and downgrade selectors are absent.
2. Decide whether removal of the dormant one-argument `mintRefreshTokenFamily(userId)` fixture-compatible overload is required in the release or tracked as post-release hardening.
3. Complete supported-version iOS and Android bootstrap, 428 retry, login/MFA/refresh, logout, account-switch, offline-return, and unsupported-version UX validation.
4. Deploy the approved guarded build to every replica in a coordinated rollout. If authentication failures or binding loops exceed the approved threshold, roll back the application build—not the schema—and use the documented broad session-revocation mitigation until a corrected build is ready.
5. Enable `AUTH_BROWSER_TERMINAL_PREPARATION_ENABLED=true` only after every replica runs guarded issuance and its separate completion protocol is approved.
6. Keep nullable legacy current-JTI classification until the same lifetime gate has elapsed; plan `NOT NULL` as a separate fix-forward migration with row-count warnings.
7. Keep retired transition tombstones indefinitely. Any deletion requires a separate fleet-authoritative binding-key retirement design.

Local candidate completion means the product patch and regression evidence are ready for an owner decision. It does **not** establish fleet compatibility, authorize public product action, or complete the external rollout gate.
