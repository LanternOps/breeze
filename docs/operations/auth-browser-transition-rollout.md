# Durable Browser-Auth Transition Rollout

This runbook deploys the durable browser-auth transition authority without
creating a mixed-replica legacy issuance window. Both rollout flags default to
`false`; token issuers remain capability-guarded independently of the flags.

## Preconditions

- Deploy the additive transition schema before opening terminal logout.
- Confirm every production token issuer uses `beginAuthIssuance` and
  `finishAuthIssuance` and the legacy issuer export is absent.
- Confirm the scheduled `auth-browser-transition-cleanup` queue is healthy.
- Preserve the transition/user/session-family lock order documented in the
  approved design. Do not introduce an app-layer cleanup path.

## Fleet-safe sequence

1. Deploy the new build to every API replica with both flags `false`:

   ```dotenv
   AUTH_BROWSER_TRANSITIONS_ENFORCED=false
   AUTH_BROWSER_TERMINAL_PREPARATION_ENABLED=false
   ```

   This is the compatibility stage. Terminal preparation returns 503, while
   all normal issuers continue to enforce durable issuance capabilities.

2. Verify all replicas run the new build, normal authentication succeeds, and
   no legacy issuer export exists. Do not advance during a mixed-version fleet.

3. Set `AUTH_BROWSER_TRANSITIONS_ENFORCED=true` and keep terminal preparation
   `false`, then restart every API replica. Startup refuses enforcement if a
   legacy issuer export is present.

4. After the entire fleet is healthy under enforcement, set
   `AUTH_BROWSER_TERMINAL_PREPARATION_ENABLED=true` and restart the fleet.
   Startup rejects this flag ordering unless enforcement is also true.

5. Verify a terminal logout completes once, the predecessor generation remains
   retired, and the successor can issue. A legacy quarantine cookie is inert
   input and has no authority.

## Recovery and cleanup

- A live `logout_pending` row blocks issuance until its database expiry.
- After expiry, the client receives one binding-rotation response and retries
  with the successor; the predecessor never becomes active again.
- Expired issuance leases are replaceable, but the old capability cannot finish.
- The daily cleanup job runs at 04:17 UTC with a 500-row bound per phase. It
  retires expired pending rows and clears their leases. Retired rows are
  permanent security tombstones: one replica's process-local keyring cannot
  prove that every replica has stopped accepting the old binding. Active and
  live-pending rows are preserved. The `deletedRetired` counter therefore stays
  zero until a future fleet-authoritative key-retirement protocol exists.
- Monitor `[AuthBrowserTransitionCleanup]` logs. Each run reports
  `retiredPending`, `deletedRetired`, and `durationMs`; investigate failures or
  sustained full batches.

## Rollback

Disable terminal preparation first and restart the fleet:

```dotenv
AUTH_BROWSER_TRANSITIONS_ENFORCED=true
AUTH_BROWSER_TERMINAL_PREPARATION_ENABLED=false
```

This closes new terminal handoffs without weakening issuer enforcement. Do not
restore the legacy issuer, quarantine cookie authority, or roll back the
additive database migration. If necessary, keep enforcement true and deploy a
forward fix; only return to the initial compatibility flag state while all
replicas still run capability-guarded issuer code.
