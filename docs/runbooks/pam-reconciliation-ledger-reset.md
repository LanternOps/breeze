# PAM Reconciliation Ledger Reset

This is the only approved manual procedure for clearing a persistent PAM
reconciliation quarantine. There is no remote administrative reset API. This
branch does not perform this procedure in production or on customer devices.

Use this runbook only under an approved incident or change record. Record the
incident/change reference in every captured artifact and command transcript.

## Stop conditions

Do not reset anything when any of the following is true:

- the server's current PAM actuation desired state is `active`;
- independent endpoint proof is missing, stale, or contradictory;
- device, organization, actuation, or command ownership is ambiguous;
- the endpoint is foreign, customer-owned without explicit authorization, or
  outside the incident/change scope;
- the reset is proposed to bypass a persistent same-command rejection; or
- the API resolver and PAM result acknowledgement versions have not been
  verified server-first.

A stop condition requires escalation to the PAM/control-plane owner. Do not
delete, edit, synthesize, or replace ledger/outbox JSON to make the check pass.

## Required evidence before the service is stopped

1. Record the incident/change reference, operator, UTC start time, authorized
   device ID, organization ID, actuation ID, and current server SHA/version.
2. Verify the deployed server exposes the authenticated primary-agent binding
   resolver and returns protocol-v1 PAM result acknowledgements with an exact
   `applied`, `duplicate`, `stale`, or `rejected` classification.
3. Using an independently authorized server view, prove that the actuation is
   current for this exact device and organization and that its desired state is
   already `cleanup`. Capture the generation and current command binding.
4. Using an independent endpoint inspection method, capture proof that all of
   these are true at the same time:

   - the PAM Job has zero members;
   - no privileged token is present;
   - the managed account is disabled; and
   - the managed account is not a member of Administrators.

5. Locate, without modifying, the agent's actual data directory and record the
   exact paths of:

   - `pam-lifetime-ledger.json`;
   - `pam-reconciliation/pending`; and
   - `pam-reconciliation/quarantine`.

6. Create an incident archive on the same filesystem. Copy the ledger and both
   PAM reconciliation directories into a read-only evidence area, preserving
   timestamps and permissions. Record cryptographic hashes for every file and
   an inventory showing relative path, size, mode, and modification time.

If any required file cannot be read or hashed, stop. An unreadable file is
blocking evidence, not permission to discard it.

## Controlled reset

1. Explicitly stop the Breeze agent service using the platform service manager.
   Record the exact service name, command, UTC time, and proof the process has
   exited. Do not proceed while any Breeze agent process can write the ledger or
   outbox.
2. Recompute hashes and compare them with the pre-stop capture. If content
   changed, archive the new state and repeat the independent server/endpoint
   verification before proceeding.
3. Within the same filesystem, atomically move the original
   `pam-lifetime-ledger.json` and the complete `pam-reconciliation` directory
   into an incident-specific quarantine inside the archive. Do not copy-then-
   delete, edit files in place, or move only selected observations.
4. Confirm the original paths are absent and the archived originals retain
   their hashes, ownership, permissions, and relative layout.
5. Start the Breeze agent service and record its UTC start time and service
   status.

## Post-reset verification

1. Confirm the agent recreates only its expected local state and remains
   fail-closed until startup reconciliation completes.
2. Verify the primary-agent binding resolver is reachable and ownership-scoped
   for this exact agent/device/organization.
3. Verify the next heartbeat reports the expected
   `securityCapabilities.pamReconciliation` counts and reason, and that PAM
   capability remains zero for any unresolved or quarantined evidence.
4. Verify no `pam_apply_v2` work was admitted during the reset and no server PAM
   state changed outside the already-current `cleanup` actuation.
5. Attach the server SHA/version proof, endpoint proof, service stop/start
   transcript, before/after inventories, hashes, archived originals, resolver
   result, heartbeat telemetry, and operator sign-off to the incident/change
   record.

Retain the incident archive under the applicable evidence-retention policy. Do
not restore, purge, or reuse it without a separately reviewed recovery action.
