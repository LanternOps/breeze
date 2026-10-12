---
title: Reattach a Reinstalled Machine to Its Existing Device Record
status: proposed
date: 2026-10-12
owner: Lennon Fiuza
area: installer-enrollment
tracking_issue: LanternOps/breeze#8318
related:
  - docs/superpowers/specs/installer-enrollment/2026-08-02-enrollment-idempotency-design.md
  - docs/agents/tenancy-rls.md
---

# Reattach a Reinstalled Machine to Its Existing Device Record

> Wave 0 of #8318. The direction and decisions D1–D4 were approved on #8318 with conditions;
> this spec folds them in. Nothing is implemented until this spec is reviewed.

## 1. Summary

When a machine is reformatted and the agent reinstalled, it comes back as a **new device**. It
loses its history, groups, policies and tickets, and the old record is left orphaned. #2764
deliberately left "continuity of the existing record" open. This spec closes that gap with a
**human-authorized reattach**: a technician confirms that a newly enrolled install is the machine
behind an existing record, and the new install takes over that record (same `devices.id`, org,
site and history) with fresh credentials.

Four pieces, shippable in this order (§11):

1. **An install incarnation boundary** (§5). Breeze has no notion of an install today: everything
   that executes on a device is keyed by `device_id`, so a new install that takes over a row would
   inherit the old install's queued commands, grants and secret-bearing state. Every reattach
   advances the device's incarnation, and the boundary cancels, revokes or rebinds that state.
2. **A bounded, two-phase rebind** (§6). The new install receives the target identity through a
   server-directed exchange whose staged credential **can only confirm**. Nothing changes until the
   confirm, which revalidates everything atomically and is idempotent across crashes, lost
   responses and expiry.
3. **Hardware hints and the manual reattach action** (§7–§8). The SMBIOS UUID and a normalized
   serial suggest candidates; a human decides, with MFA step-up. A terminal `reattached` exit
   leaves the holding area (D4).
4. Three **independent tracks**, none of which gates the manual reattach:
   - deploy-key enrollment into the partner holding area, with a long-lived per-image key
     (§10, D2);
   - a partner switch that lets technicians limited to selected orgs triage the holding area into
     their own orgs (§9), a proposed change to #7397;
   - TPM endorsement-key collection, as a possession-proven continuity signal (§12, D3).

### Design constraints (from #8318, #2764, #914, #7397, #6050, #2621)

1. **A human authorizes every reattach.** Hardware identifiers are hints and never authorize
   adoption (#2764). A TPM proof upgrades the evidence the technician sees; it does not replace the
   decision.
2. **Nothing changes until confirm** (#8318). The new install cannot act as the target before the
   confirm, and a crash, lost response or expiry at any point leaves either the old state or the
   new one, never a mix.
3. **Preserved history is not executable authority** (#8318). Keeping the id keeps history, groups,
   policies, tickets and schedules as configuration. It must not keep work, grants or secrets
   intended for the previous installation.
4. **Never write an existing row at enrollment** (#2764). Enrollment still only creates rows.
   Reattach is a separate, later, human-authorized step.
5. **A decommissioned record is not adopted silently** (#914). Reattaching to a decommissioned
   target requires an explicit flag, audited and admitted against the partner's device capacity.
6. **The holding area is one-way and hidden** (#7397). A parked device leaves only through an
   explicit, partner-side, step-up-bound exit (who may act is §9); `reattached` is a second such exit beside
   `assigned`.
7. **No partner-wide key mints tenants** (#6050). The deploy key parks devices only; it never
   creates orgs or sites, never reveals candidate records and never carries assignment authority.
8. **Crash safety of credentials** (#2621). The agent never holds only credentials the server has
   not accepted; at every instant at least one credential set on disk authenticates.

## 2. Repo facts this design is built on (verified 2026-10-12 against `origin/main` 3c05066d7)

Paths are under `apps/api/src/` unless they start with `agent/` or `apps/web/`; `migrations/` is `apps/api/migrations/`.

| # | Fact | Evidence |
|---|---|---|
| F1 | The only install identifier is `devices.agent_id` plus the token hashes. Agent auth looks the row up by `agent_id`; `agent_id` is regenerated on every enroll. There is no install epoch or generation, only `token_issued_at` columns. `ownership_epoch` is an org-move epoch (PAM). | `db/schema/devices.ts:18-37,250-253`; `middleware/agentAuth.ts:626-660`; `routes/agents/enrollment.ts:443` |
| F2 | A staged pending token authenticates fully, on REST, the agent WebSocket and helper auth (#2621 crash safety). It is promoted to current by `/rotate-token/confirm` **or implicitly by any heartbeat** that presents it. | `middleware/agentAuth.ts:178-190`; `routes/agentWs.ts:1004`; `middleware/helperAuth.ts:101`; `services/agentTokenPromotion.ts:60-88`; `routes/agents/heartbeatCredentialMaintenance.ts:74-111` |
| F3 | Token-authenticated re-enroll already rewrites an existing row in place: new `agent_id` and hashes, staged rotation cleared, `status='pending'`, `backup*ProtocolVersion` reset to null, old socket closed. It touches no commands, grants or recovery state, and publishes revocation only for the agent hashes, not watchdog/helper. | `routes/agents/enrollment.ts:827-871,863-865,1164-1170,1218-1231` |
| F4 | mTLS certificates carry no device identity (empty CSR). The binding is the serial in `device_mtls_certificates(org_id, device_id, …)` with one active row per device. A new certificate supersedes the old (`pending_revocation` → provider revoke). Binding mode defaults to `off`, and a device without certificate history passes as `legacy_identity`. | `services/cloudflareMtls.ts:143-153`; `db/schema/deviceMtlsCertificates.ts:37-81`; `services/deviceMtlsCertificateIssuance.ts:9-22`; `services/agentCertificateBinding.ts:46-49,92-94` |
| F5 | The WS lease re-check (keyed by `agentId`) re-validates status, suspension, holding-org membership and the socket's token hash, but **does not compare the row's `id`, `org_id` or partner** against the socket's cached context. The cached `AgentDbContext` holds `deviceId`, `orgId` and `partnerId` but no `siteId`. | `routes/agentWs.ts:944-962,987-1043` |
| F6 | `device_commands` has no credential or install column, and no `org_id` on purpose: it is system-scoped, cleared on erasure through `ASSOCIATED_SYSTEM_SCOPED_TABLES`, and carries `submitted_org_id` as provenance only. Pending commands are delivered by heartbeat, REST poll and live WS push for up to 168 h (the `standard` class; others 24 h or 15 min); secrets are decrypted at delivery. Results are accepted for `pending`/`sent` rows matched on `(id, device_id, target_role)`, and three kinds of terminal row are reopened by a late result: server timeouts, completed backup-queue acks and processing failures. | `db/schema/devices.ts:701-745,731-735`; `services/tenantCascade.ts:1058-1086`; `services/commandOfflinePolicy.ts:57-70`; `routes/agents/commands.ts:241,288,490-493`; `services/commandResultAcceptance.ts:54,121-148` |
| F7 | PAM actuations bind to `devices.agent_id = caller`, which shuts out old credentials but accepts whoever holds the row. Cleanup bypasses claim-time cancel checks. The agent's PAM ledger is keyed by actuation id, and each entry carries the deviceId and orgId it was written under. | `services/pamActuationResult.ts:86`; `services/pamReconciliationBinding.ts:75`; `services/commandClaimEligibility.ts:153-164`; `agent/internal/pamlifetime/store.go:44-45,121,352` |
| F8 | Diagnostic access grants (`diagnostic_access_grants`) bind to `device_id` + beneficiary. They expire on their own and are revoked on org move, org merge, a "reported as suspicious" decision or by hand; nothing revokes them on reinstall. | `db/schema/diagnosticAccess.ts:27-67`; `services/diagnosticAccess/deviceMove.ts:20-31`; `services/orgMergeCustomExecutors.ts:660-694`; `routes/approvals.ts:1329` |
| F9 | Recovery tokens, bare-metal recoveries and restore authorizations bind to `device_id`. An attested snapshot with producer-only trust restores without extra approval when `sourceDeviceId === target`; `server_verified` snapshots pass for any target; unattested ones always need authorization. The next backup continues the device's chain (`stampDispatchPinAndIdentity({ deviceId, configId })`). | `db/schema/recoveryTokens.ts:21-43`; `services/backupRestoreGate.ts:134-149`; `jobs/backupWorker.ts:1141,1551` |
| F10 | Rollback directives are signed over deviceId/orgId/version/expiry without an agentId. | `services/rollbackDirectiveSigning.ts:84-103` |
| F11 | Peripheral policy reconciliation skips a device whose stored digest is unchanged. The agent reports a digest only in a policy command's result, never its current state on heartbeat, so a new install behind an unchanged stored digest would never receive the policy (fail-open). | `services/peripheralPolicyState.ts:130-136,385`; `agent/internal/peripheral/types.go:86`; `jobs/peripheralJobs.ts:516` |
| F12 | Parked devices are confined to an allow-list (heartbeat, commands, rotate-token, uninstall-intent), command claims are narrowed to `self_uninstall`, and enqueue is refused. A classification test reads the real route table. The parked heartbeat reads only `agentVersion`, `role` and `watchdogState`, so it records no capabilities. | `middleware/agentAuthParked.ts:33-68`; `services/drainClaimAllowlist.ts:17`; `middleware/agentAuth.ts:1086`; `routes/agents/parkedRouteClassification.test.ts:13-17`; `routes/agents/heartbeatParked.ts:12-16` |
| F13 | Leaving the pool is one-way through `assignParkedDevice` (`via:'pool_assignment'`), with `possessionConfirmed`, step-up and full partner access. The move guard refuses moving any row **into** the pool. The ledger `device_pool_assignment_events` CHECKs `event_type IN ('enrolled','assigned','expired','purged')` plus a per-type shape CHECK, blocks UPDATE by trigger (DELETE stays granted for partner erasure) and refuses non-system writes with a RESTRICTIVE policy. Every holding-area change takes a per-partner advisory lock first, then the device row, then the `partners` row. | `services/unassignedPool/assignParkedDevice.ts:5-19,292`; `migrations/2026-11-08-190100-unassigned-pool-org-guards.sql:81-112`; `migrations/2026-11-08-190200-device-pool-assignment-events.sql:36-50,77-91`; `migrations/2026-11-08-190300-device-pool-assignment-events-system-only.sql:39`; `services/unassignedPool/holdingAreaLock.ts:9-18` |
| F14 | **Deploy keys do not exist yet.** There is no table, hash or mint route. What exists around them: snapshot columns on the ledger, the partner switch `partners.deploy_key_enrollment_enabled`, the platform env flag, the incident route `POST /pre-assignment/deploy-keys/:id/expire-devices`, and fixed limits (14 days, 50 uses, parked cap 50, `DEPLOY_KEY_RATE` 10/600 s per key and 25/600 s per partner). Pool enrollment is dark: `enrollment.ts` passes `{ preAssignment: false }`. | `services/unassignedPool/limits.ts:7-31`; `services/unassignedPool/enrollmentRateBuckets.ts:1-58`; `db/schema/orgs.ts:63`; `config/env.ts:172`; `routes/preAssignment.ts:357`; `routes/agents/enrollment.ts:1207` |
| F15 | Org enrollment keys already allow a 365-day TTL (`MAX_TTL_MINUTES = 525_600`) and up to 100 000 uses (or unlimited, `maxUsage: null`); keys are stored peppered-hashed. | `routes/enrollmentKeys.ts:750,764-777`; `services/enrollmentKeySecurity.ts:51-56` |
| F16 | The agent collects serial, manufacturer and model, but **no system UUID** on any OS; Linux `product_serial`/`sys_vendor` are not run through the placeholder cleaner. | `agent/internal/collectors/hardware.go:15-30,156-199`; `hardware_linux.go:35-41` |
| F17 | `possible_replacement_of_device_id` is set only on the #2764 collision path (hostname + org + site) and cleared by the offline detector. The banner offers "View old device" and "Decommission old device"; no adopt or reattach. | `routes/agents/enrollment.ts:461-488,900`; `jobs/offlineDetector.ts:721-732`; `apps/web/src/components/devices/PossibleReplacementBanner.tsx:170-187` |
| F18 | The #8320 identity assertion is a server-signed (Ed25519 deployment key), nonce-bound statement of `agentId, deviceId, orgId, siteId`, verified by the agent against pinned keys. It never changes the deviceId. | `services/agentIdentityAssertion.ts:28,83-135`; `agent/internal/heartbeat/identity_sync.go:140-176` |
| F19 | There is no TPM code. `services/attestation/*` serves the mobile authenticator only. | `routes/security/compliance.ts:191`; `services/authenticatorAttestation.ts:11-16` |
| F20 | Step-up grants are bound to an operation and, for resource-bound operations, a resource digest. They live in Redis and are consumed by `GETDEL`, outside the DB transaction, so a rollback after the consume does not restore the grant. The actor and session are locked (`lockActorAssurance`, `lockLiveUserSession`) inside the write transaction. | `services/mfaStepUpGrant.ts:567-577`; `services/stepUpActorAssurance.ts:19-32`; `services/unassignedPool/assignParkedDeviceSteps.ts:128`; `services/unassignedPool/incidentActions.ts:30-55` |

## 3. Threat model

| Actor | Can | Must not be able to |
|---|---|---|
| Holder of a leaked image deploy key | Park devices in the holding area, up to the key's sub-cap, the partner cap and the rate buckets | Create orgs/sites, see candidate records, assign or reattach, learn anything about existing devices, starve the partner's other keys (§10) |
| Device that forges hints (a known serial is printed on the chassis) | Appear as a candidate for an existing record | Reattach without a human, or receive anything before confirm |
| The old install, still alive | Keep working until confirm | Be displaced: any use of any of its credentials since the intent was requested, or within the quiet period, aborts the reattach (§6.5) |
| A request the old install authenticated just before confirm commits | Finish its request | Write to the row, claim work or deliver a result after the commit (§6.4, stale callers) |
| Holder of the old install's credentials (copied disk image) | Nothing after confirm | Authenticate as the target after confirm; deliver results for the old install's work |
| A technician acting in haste | Confirm a wrong match | Do so without seeing the evidence level, typing the target's name for hint-only matches and passing step-up |
| Two technicians at once | Request reattaches | Have both succeed, or chain a device into two open intents (§6.5) |
| A partner technician limited to selected orgs | Reattach into an org they manage. Where the partner turned on technician triage (§9): see the holding area and assign or reattach parked devices into their orgs | Expire, purge or manage deploy keys; flip either switch; assign or reattach into or out of an org they lack (§8, §9) |
| A customer-org user | Nothing | Start or confirm a reattach |

What a reattach **asserts**: a partner user with access to the target's org (§8), holding the
device, decided that this install replaces that record. The evidence levels shown are `hint`
(hardware identifiers, self-reported) and `tpm_continuity` (the same endorsement key that the old
install proved possession of, §12). TOFU on the EK proves key continuity, not the same physical
TPM; cloned vTPMs share EKs. The UI says exactly that.

## 4. Data model

### 4.1 `devices` additions

`devices` is an org-cascade table, so every new column has an export classification.

| Column | Purpose | Export |
|---|---|---|
| `install_incarnation integer NOT NULL DEFAULT 1` | The current install's incarnation. Advanced by one at every reattach confirm, never otherwise. | `included` |
| `incarnation_started_at timestamptz` | When the current incarnation took over (null for the first). The command, backup and restore checks compare against it (§5). | `included` |
| `last_reattached_at timestamptz` | The "Reinstalled on" badge. | `included` |
| `rebind_protocol_version integer NOT NULL DEFAULT 0` | The agent's declared rebind capability. Written by enroll, the full heartbeat and the parked heartbeat (§6.2). Not reset at the boundary, since the new install reports it at enroll. | `included` |
| `possible_replacement_reason text`, `possible_replacement_detected_at timestamptz` | Why and when §7.3 flagged the source. | `included` |

Token-authenticated re-enroll (F3) **does not** advance the incarnation: it is the same install
proving its own credentials.

### 4.2 `device_commands.device_incarnation integer`

- **Stamping:** a `BEFORE INSERT` trigger stamps every new row from `devices.install_incarnation`
  (read `FOR KEY SHARE`). There are a dozen insert sites, and a trigger cannot be forgotten by the
  next one. A row inserted while a confirm is in flight reads the old incarnation and is refused
  at claim, so the race fails closed.
- **Refusals:** claim and result acceptance refuse a row whose stamp differs from the device's
  current incarnation (§5.2).
- **Legacy rows:** rows from before the migration keep null. A null-stamped row created before
  `incarnation_started_at` is refused like a mismatch. Once the longest command TTL (168 h) has
  passed after the trigger ships, a follow-up migration sets the column `NOT NULL`.
- **Tenancy:** `device_commands` stays system-scoped (F6). The new column is not named `org_id`,
  so the RLS and cascade auto-discovery still skip the table, and it needs no export
  classification.

### 4.3 `device_reattach_intents` (partner-axis, shape 3)

```
id uuid PK,
partner_id uuid NOT NULL → partners ON DELETE CASCADE,
source_device_id uuid NOT NULL → devices ON DELETE CASCADE,
target_device_id uuid NOT NULL → devices ON DELETE CASCADE,
state text NOT NULL CHECK (state IN ('requested','staged','confirmed','expired','cancelled')),
cancel_reason text,               -- 'target_alive' | 'source_changed' | 'target_changed' | 'admin' | …
evidence_level text NOT NULL CHECK (evidence_level IN ('hint','tpm_continuity')),
restore_decommissioned boolean NOT NULL DEFAULT false,
requested_by uuid → users ON DELETE SET NULL,
requested_at timestamptz NOT NULL DEFAULT now(),
expires_at timestamptz NOT NULL,
-- the versions the human authorized; confirm refuses if any moved
source_agent_id text NOT NULL, source_org_id uuid NOT NULL,
target_agent_id text NOT NULL, target_incarnation integer NOT NULL, target_org_id uuid NOT NULL,
-- phase 1: hashes of credentials the AGENT generated; never copied into devices.* before confirm
staged_agent_id text,
staged_token_hash varchar(64), staged_watchdog_token_hash varchar(64), staged_helper_token_hash varchar(64),
confirmation_token_hash varchar(64),
superseded_confirmation_token_hash varchar(64),
staged_mtls_certificate_id uuid,  -- the target's pending_activation certificate row (no FK)
staged_at timestamptz, confirmed_at timestamptz,
UNIQUE partial (source_device_id) WHERE state IN ('requested','staged'),
UNIQUE partial (target_device_id) WHERE state IN ('requested','staged')
```

- **Policy:** `system OR breeze_has_partner_access(partner_id)`, in the creating migration, and
  `PARTNER_TENANT_TABLES`. Partner-axis RLS admits every partner-scope user, including technicians
  limited to selected orgs (`computeAccessiblePartnerIds`, `middleware/auth.ts:522-529`). The
  service therefore applies the §8 org rule to every read and write of an intent, and a
  technician lists only the intents whose target org, and real source org, they can access.
- **No `org_id` column:** device FKs cascade, so org erasure reaches it through its devices. The
  `users` FK is `ON DELETE SET NULL` (the `orgCascadeFkOnDelete` contract).
- **One open intent per device:** the indexes stop a device being the source of two intents or
  the target of two. The rule that a device is in at most one open intent **in either role** is
  checked at creation under the partner's holding-area lock (§6.5), which every creation takes.
- **Retention:** terminal intents are pruned after 30 days. Idempotent confirm replay does not
  depend on them (§4.4).

### 4.4 `device_reattachments` (append-only ledger, partner-axis)

One row per confirmed reattach. It is modelled exactly on `device_pool_assignment_events` (F13),
which is itself modelled on `org_merge_events`:

- **Columns:**
  - `partner_id`: a FK, `ON DELETE CASCADE`.
  - **Snapshots with no FK** (the record must outlive the devices, orgs and user):
    - source and target device ids, both orgs and the actor;
    - the target's previous and new `agent_id` and incarnation;
    - the evidence level and the step-up reference.
  - The counts of what the boundary invalidated (§5).
  - `confirmation_token_hash` and the confirmed identity, which holds no secrets (§6.6).
- **Append-only:** a `BEFORE UPDATE` trigger blocks UPDATE. `DELETE` stays granted for the partner
  erasure sweep, and there are no device FKs, so a device purge or org erasure never fires a
  cascading `SET NULL` that the trigger would refuse.
- **Writes:** a RESTRICTIVE policy refuses writes outside system scope.
- **Tenancy:** with no `org_id` column, the table needs no org cascade, merge or export
  registration, only `PARTNER_TENANT_TABLES`. A `source_device_id` index serves the "never target
  a retired source" check (§6.5).

### 4.5 `device_pool_assignment_events`

Both CHECKs change (D4):

- `event_type_chk` gains `'reattached'`;
- `shape_chk` gains a `reattached` arm:
  - `from_org_id` is the holding org;
  - `to_org_id` is the target's org;
  - there is an acting user;
  - `parked_duration_seconds` is set;
  - `assignment_method` is null.

The parked source row is retired **in place** (§6.4): it is decommissioned with the `reattached`
exit, so no org-membership exception is needed. The change ships in wave 1b, which is the first
wave to write it.

## 5. The incarnation boundary (execution invalidation)

At confirm (§6.4), inside the same transaction, the target's incarnation goes from `n` to `n+1`
and every item below is handled. The rule is: **configuration survives, instances of work and
grants do not.** Org move (`moveDeviceOrgInTransaction`) already drops several kinds of
device-bound authority. The boundary starts from that set and adds what is specific to a new
install.

### 5.1 Survives (configuration and history)

- **History:** alerts, tickets, audit and metrics.
- **Membership:** groups, tags, custom fields, site and maintenance-window membership.
- **Configuration:** policy and automation **assignments**, patch approvals as policy, and
  scheduled patch jobs as schedules.

Automations, policies and schedules select their targets when they fire, so they reach the new
install as fresh work, not as replays.

### 5.2 Commands

- **Cancel.** Every non-terminal `device_commands` row of the target (`pending`, `sent`) becomes
  `cancelled` with reason `superseded_by_reattach`. That covers:
  - scripts with decrypted secrets and `encryption_rotate_key`;
  - `pam_apply_v2`/`pam_cleanup_v2`;
  - diagnostic reads, restores and rollbacks;
  - watchdog-role commands.
- **Settle owners.** `propagateCancelledDeviceCommands` then settles the records that own those
  commands (`patch_jobs.devices_queued`, script executions, …), as decommission and org move do.
- **Refuse stale work.** Claim (heartbeat, REST poll, WS push) and **result acceptance** refuse a
  row whose `device_incarnation` differs from the device's current incarnation (§4.2), and require
  the caller's `agent_id` (§6.4, stale callers). This closes the late-result path of F6:
  - none of the three reopen paths (server timeout, completed backup-queue ack, processing
    failure) can reopen a row from an earlier incarnation;
  - a replayed agent outbox from the old install can no longer write a result.
- **Agent side.** The agent's own outbox and command journal gain the `deviceId` and `agentId` they
  were produced under, and drop entries from another identity before sending. This is belt and
  braces; the server checks above are the guarantee.

### 5.3 PAM

- **Non-terminal actuations of the target** (any `desired_state`) get `observed_state = 'failed'`,
  an existing terminal state, with reason `superseded_by_reinstall`, so the state enum needs no
  new value. Pending elevation requests are expired.
- **No cleanup command goes to the new install.** The elevated account lived on the old OS, which
  is gone.
- **Results and reconciliation** for those actuations are refused (they bind to the old
  `agent_id`, F7).
- **The source**, if it was parked, never ran PAM (F12).

### 5.4 Backup and recovery

- **Recovery state:** active `recovery_tokens` are revoked, in-flight `bare_metal_recoveries` are
  cancelled, and unused `backup_restore_authorizations` are invalidated.
- **In-flight backups:** running backup jobs are cancelled and open `backup_storage_sessions` are
  revoked. A session also needs agent credentials, so this is defence in depth.
- **The backup chain:** the active chain is closed, so the next backup is a full one. Snapshots and
  recovery keys are kept as history.
- **Restoring a snapshot taken before `incarnation_started_at`** loses the producer-only-trust free
  pass that `sourceDeviceId === target` gives today (F9). The old install produced it, not this
  one, so the restore goes through the existing approval (`backup_unattested_restore` step-up).
  `server_verified` snapshots are unchanged, since their trust does not depend on the producer.
- **The `backup*ProtocolVersion` columns** are reset to null until the new install heartbeats, as
  F3 already does.

### 5.5 Grants, authorizations, sessions, directives

- **Diagnostic access grants:** active grants on the target are revoked (F8).
- **Caller verifications:** workstation grants keyed by `workstation_device_ref` are revoked, as
  `services/callerVerification/deviceMove.ts:17-28` does on a move.
- **Software remediation:** unused MFA-gated authorizations in `software_remediation_requests` for
  the target are invalidated.
- **Remote sessions:** live remote, terminal, tunnel and support sessions on the target are
  terminated.
- **Rollback directives:** `requested`/`in_progress` rows in `agent_rollback_directives` become
  `expired`, a state the CHECK already allows, so no constraint change is needed. Their signed
  payload gains `agentId` in a later protocol version (F10), out of scope here.
- **Capability columns:** the server assumes nothing about the new install until its first
  heartbeat. Script-secret, PAM, rollback and peripheral protocol versions go back to `0` (they are
  `NOT NULL DEFAULT 0`), and the backup protocol versions go to null, as F3 does.

### 5.6 AI and automation work in flight

- **AI action intents:** pending, approved or executing `action_intents` scoped to the target are
  detached (`scope_device_id = NULL`), as org move does (`moveDeviceOrgInTransaction.ts:738-742`).
- **AI operator tasks:** `ai_operator_tasks` / `ai_operator_task_targets` that name the target are
  detached from it and live tasks go to `stopping`, as org move does
  (`moveDeviceOrgInTransaction.ts:610-650`), with detach reason `device_reinstalled`.
- **Playbooks:** running `playbook_executions` on the target are cancelled.
- **Topology telemetry:** `topology_telemetry_arms` that use the target as collector are disarmed.
  The arm holds an SNMP credential plan made for the old install, so a human re-arms it.
- **Filesystem cleanup:** approved `device_filesystem_cleanup_runs` are cancelled. Their path plan
  was built from the old OS.
- **Patch work:** the target's pending `patch_job_results` and `patch_rollbacks` are cancelled.
  The job itself stays as a schedule (§5.1).

### 5.7 Install-specific state

- **Patch inventory:** `device_patches` is cleared, so the new install's inventory drives
  `install_patches` (no stale "missing patch" targets).
- **Deployments:** the target's `running` `deployment_devices` rows go back to `pending`. Their
  command was cancelled in §5.2, so the deployment runs again as fresh work on the new install.
- **CIS:** `queued`/`in_progress` `cis_remediation_actions` become `cancelled`. They answered
  findings on the old OS, and the new install's first scan raises its own findings, which need
  approval again.
- **Edition migration:** `editionMigrationDispatchedAt` is cleared.
- **Peripheral and config-policy observed state:** applied revision and digest are cleared, so
  reconciliation resends policy. This makes it fail-closed instead of F11's silent fail-open.
- **BitLocker escrow:** the new install's escrow supersedes the old keys as it does today. The old
  keys stay as history, labelled with the incarnation they belonged to.

### 5.8 Enforcement

- **Contract test.** It discovers every table that references `devices(id)` by FK
  (`information_schema`), plus a curated list of FK-less device references
  (`caller_verifications.workstation_device_ref`, `action_intents.scope_device_id`, …). It fails
  when one of them is not classified as `boundary handler`, `configuration` or `history`. Discovery
  by FK, not by the column name `device_id`, is what catches tables like
  `topology_telemetry_arms.collector_device_id`.
- **Org-move parity.** A test asserts that every device-bound invalidation in
  `moveDeviceOrgInTransaction` has a counterpart in the boundary, or is listed as move-only.
- **Integration test.** It seeds an item of every handled category on a target, confirms a
  reattach, and asserts that each item was cancelled, revoked or reset, and that none of them
  reaches the new install's first heartbeat.

## 6. The bounded rebind

### 6.1 Overview

```
human (step-up)            source agent (new install)                      server
  POST /devices/:src/reattach ───────────────────────────────────▶ intent: requested
                      heartbeat ◀── rebind { intentId, nonce } (signed)
       generate tokens + confirmation token, persist (fsync)
                      POST /agents/:id/rebind (source creds, hashes only) ─▶ intent: staged
                      ◀── staged agentId + pending_activation certificate  (target unchanged)
       persist the certificate with the staged set
                      POST /agents/:id/rebind-confirm (confirmation token) ─▶ atomic confirm (§6.4)
                      ◀── confirmed identity (no secrets)                   intent: confirmed
       swap identity, RestartSelf
                      heartbeat as target (incarnation n+1) ──────────────▶ target online
```

### 6.2 Delivery to the source

- **The heartbeat directive:** a source with `rebind_protocol_version ≥ 1` receives
  `rebind: { intentId, nonce, signature }` on every heartbeat while its intent is `requested` or
  `staged`, so a crashed agent picks it up again.
- **Parked sources:** parked heartbeats get the directive too. The parked beat reads no
  capabilities today (F12), so wave 1b makes it read and store `rebindProtocolVersion` (only that
  field). Enroll records it as well.
- **The signature:** made with the deployment key, like the #8320 assertion (F18), under a new
  domain `breeze-agent-rebind-v1` over `intentId, sourceAgentId, targetDeviceId, targetOrgId,
  targetSiteId, nonce, expiresAt`. The agent verifies it against its pinned keys before acting.
- **Old agents:** a source without the capability cannot be reattached, and the action says so.

### 6.3 Phase 1 — `POST /agents/:id/rebind` (source credentials)

- **The agent generates the secrets.** The agent, watchdog and helper tokens and the confirmation
  token (prefix `brz_rbc_`) are generated from `crypto/rand`, and persisted durably, **before** the
  first call. There is one staged set per intent: retries and re-delivered directives resend the
  same hashes and never generate a second set. Only the hashes go over the wire.
- **Access:** the route is added to the parked allow-list (F12) and classified in the route test.
- **What the server does:**
  1. It re-validates the intent, with the §6.4 checks except liveness, and stores the hashes on
     the intent.
  2. It assigns `staged_agent_id`, kept across retries.
  3. It issues the target's next mTLS certificate as a `pending_activation` row on the target, with
     `activation_expires_at` set to the intent's expiry. A retry issues a fresh pending certificate
     and revokes the previous one, because the provider's private key is never stored.
  4. It moves the intent to `staged`.
- **What it returns:** `staged_agent_id`, the target identity (`deviceId`, `orgId`, `siteId`) and
  the pending certificate.
- **What does not change:** nothing is written to the target's credentials. The staged hashes are
  not in `devices.pending_*`, so agent auth (F2) can never match them, and the source's own
  credentials stay valid.
- **Lost agent state:** different hashes for a `staged` intent mean the agent lost its persisted
  set, for example after a disk restore. The server replaces the set and keeps the old
  confirmation hash in `superseded_confirmation_token_hash`, so a later confirm with it gets a typed
  `superseded` answer and not a bare 401 (§6.6).

### 6.4 Phase 2 — `POST /agents/:id/rebind-confirm` (confirmation token only)

**Routing and authentication.**

- **Routing:** `rebind-confirm` joins `AGENT_AUTH_SKIP_ID_SEGMENTS` (`routes/agents/index.ts:38`),
  because a path outside `/:id/*` would be captured by that mount.
- **Authentication:** the route's own middleware compares the `brz_rbc_…` token in constant time
  with the intent's `confirmation_token_hash` (or the ledger's, §4.4). The token reaches **this
  route only**, and agent auth never matches it.
- **Rate limits:** per source agent id and per IP.
- **mTLS binding:** the route accepts the source's active certificate or the target's
  pending/active one.

**Answers before any lock.**

- **Already confirmed:** a token that matches a confirmed intent, or a ledger row once the intent
  is pruned, gets the stored identity back, with no time limit. It holds no secrets.
- **Superseded:** a token that matches `superseded_confirmation_token_hash` gets `409 superseded`.

**Locks.** Confirm follows the holding-area lock order (F13). The intent is read first without a
lock, to learn the device ids. Then:

1. the partner's holding-area advisory lock (`lockPartnerHoldingArea`), unconditionally;
2. the two device rows, `FOR UPDATE`, in ascending id order;
3. the intent row, `FOR UPDATE`. It is re-read and must still name the same devices;
4. the `partners` row, last, through `admitPartnerDeviceCapacity`, and only when
   `restore_decommissioned` is set.

Nothing that writes an intent takes a device lock after the intent's, so there is no inversion.
The target-revival path does not write the intent at all (§6.5).

**Atomic revalidation**, any failure → 409 with a reason and the intent `cancelled`:

- **Authorization:**
  - the intent is `staged` and unexpired;
  - the requester is still an active partner user who satisfies the §8 access rule for both
    devices;
  - the step-up was already consumed at intent creation.
- **Target liveness:** the §6.5 rule, read under the device row lock. Also:
  - the target is not quarantined, suspended or ephemeral;
  - the target is decommissioned only if `restore_decommissioned`;
  - the target has never been the source of a confirmed reattach.
- **Row versions:**
  - `target.agent_id = target_agent_id`;
  - `target.install_incarnation = target_incarnation`;
  - `target.org_id = target_org_id`;
  - `source.agent_id = source_agent_id`;
  - `source.org_id = source_org_id`;
  - the source is not quarantined or decommissioned.

**Effects, in one transaction:**

1. **Target identity.** The target gets:
   - `agent_id = staged_agent_id`;
   - the staged hashes as **current** (agent, watchdog, helper), with every previous and pending
     hash cleared;
   - `install_incarnation + 1`, `incarnation_started_at = now()` and `last_reattached_at = now()`;
   - `status = 'pending'`. The first heartbeat makes it online, as after any enroll
     (`routes/agents/heartbeat.ts:988`).
2. **Certificates.** The staged certificate becomes `active`, and the target's previous one goes to
   `pending_revocation`. The target always has an active certificate, so `enforce` mode never sees
   history without one (`services/agentCertificateBinding.ts:96-101`).
3. **The boundary.** §5, against the target.
4. **The source.** It is retired through `decommissionDeviceInTransaction` with
   **`queueUninstall: false`**: the machine that would run the uninstall is the one becoming the
   target. Its token hashes are cleared. If it was parked, a `reattached` event goes into
   `device_pool_assignment_events`.
5. **Records.**
   - A `device_reattachments` ledger row.
   - Audit `device.reinstall.reattached` in both orgs, with the requester as actor.
   - The outbox event `device.reinstalled`.
6. **The intent.** It becomes `confirmed`.

**After commit:**

- **Revocation:** `publishAgentCredentialRevocation` for **every** hash of both rows, watchdog and
  helper included. F3's re-enroll publishes the agent hash only; that gap is fixed in the same
  wave.
- **The source's certificate** is revoked once the target certificate is first presented, or after
  24 h. Until then the agent can still reach the confirm route through an edge that gates on
  client certificates.
- **Live sockets:** the WS lease re-check compares the row's `id`, `org_id`, `site_id` and partner
  against the socket's cached context (F5), so any socket cached under either identity closes at
  its next re-check. `AgentDbContext` gains `siteId` for this. This is the gap #8318 asked to fold
  into this wave.

**Stale callers.** A request that the old install authenticated just before the commit still runs
after it. Every write it could make that matters carries `devices.agent_id = ctx.agentId`, and
`agent_id` changes at confirm, so these writes match 0 rows:

- the heartbeat, watchdog-beat and parked-beat `devices` updates (`heartbeat.ts:746-759,1443-1449`);
- the credential-maintenance writes;
- the command claim (`commandDispatch.ts:299-317`);
- result acceptance.

Claims and results also compare the command stamp with the incarnation loaded at auth time. A
source-scan test pins the predicate on agent-authenticated `devices` updates. Inventory writes to
other tables are not guarded: a late inventory report from the old install is overwritten by the
new install's first report, and §14 records that.

### 6.5 Liveness, competition, expiry

**Liveness.** The target is live if **any** of its credentials was used recently. The signals are:

- **`devices.last_seen_at`:** agent heartbeats;
- **`devices.watchdog_last_seen`:** watchdog beats. The watchdog claims watchdog-role commands,
  `heartbeat.ts:826-831`;
- **the agent WS presence lease;**
- **a new Redis marker `agent-cred-use:<deviceId>`:** written by agent auth, helper auth and the WS
  handshake on every successful authentication, at most once per 30 s per process. It covers the
  REST poll, which claims work without touching `last_seen_at` (`commands.ts:189-211`).

The target counts as silent only when the newest signal is older than
`min(intent.requested_at, now − 10 min)`. If Redis is unavailable, confirm refuses with
`liveness_unknown` (fail closed). The residual window, a request authenticated after the read and
before the commit, is closed by the stale-caller predicates (§6.4).

**Target revival.** If the target turns out to be live, confirm cancels the intent with
`target_alive`, and the web dialog shows it. No heartbeat path writes the intent, which keeps the
lock order one-way. Test: the target heartbeats (and, separately, only the watchdog beats, and,
separately, only the REST poll runs) between phase 1 and confirm. Confirm answers 409, nothing is
written, and the source keeps working.

**Competing reattachments.**

- **At creation:** an intent is created under the partner's holding-area lock and refuses a device
  already in an open intent in either role, or a target that was ever the source of a confirmed
  reattach. The partial unique indexes are the backstop.
- **At confirm:** confirm locks both device rows.
- **Tests:**
  - two requests for one target → the second gets 409 at creation;
  - a device requested as a target while it is the source of an open intent → 409;
  - two confirms racing over the same pair → exactly one commits;
  - a confirm racing parked expiry → one wins, never both.

**Holding-area housekeeping.** Parked expiry and purge skip a device in an open intent. They take
the same advisory lock, so the check is race-free, and the intent's own expiry bounds the delay.

**Expiry.**

- `requested` expires after 60 minutes if phase 1 never comes; parked agents heartbeat every 60 s.
- `staged` expires 15 minutes after `staged_at`.
- A sweep marks expired intents, discards their staged hashes and revokes the pending certificate.
  A staged set is never activated after expiry.

**Source changes.** If the source's own credentials rotate, it moves org, or it is quarantined after
the intent, the version check fails at confirm.

### 6.6 Crash safety and idempotency (agent side)

The agent follows the #2621 and #2773 discipline (F2; `agent/internal/heartbeat/heartbeat.go:6266-6276`):

- **It persists before it calls.** The staged set is on disk before phase 1 and before confirm.
- **It never discards on a bare rejection.** The agent deletes a staged set only once its source
  credentials are proven current, by a 2xx on a call authenticated with them.
- **It probes when the source is rejected.** If the source credentials are rejected while a staged
  set exists, it probes with the staged set (a heartbeat as the target). A confirm whose response
  was lost then succeeds through the probe.

| Crash or loss | State after | Recovery |
|---|---|---|
| Before the first phase 1 call | Staged set on disk, or nothing | Server knows nothing; the next directive resends phase 1 with the same hashes |
| Phase 1 response lost | Intent `staged` with the agent's hashes; agent lacks `staged_agent_id` and certificate | Retry phase 1 with the same hashes: same `staged_agent_id`, fresh pending certificate |
| After phase 1, before confirm | Source creds + staged set + certificate | Retry confirm. On `expired`/`cancelled`/`superseded`: keep the staged set until the source credentials are proven current, then discard it |
| Confirm committed, response lost | Target active with the agent's staged hashes; source creds dead | Retry confirm: answered `confirmed` from the intent or the ledger, at any later time. Or the source gets 401 → probe with the staged set → success → swap |
| Crash during the local swap | Old identity file + staged set | The swap is write-new-then-rename (`SaveEnrollment`, `atomicWriteFile`); on restart, confirm or probe, then finish |
| Server crash mid-confirm | Transaction rolled back | Retry confirm; the revalidation runs again |

After the swap the agent restarts through the updater path (`RestartSelf`), because several
components capture the device id at start. This is the same path #8320 uses.

## 7. Hardware hints

### 7.1 Agent

- **Windows:** `Win32_ComputerSystemProduct.UUID`. Not `HostID`/MachineGuid, which changes on
  reinstall.
- **Linux:** `/sys/class/dmi/id/product_uuid`, and run `product_serial`/`sys_vendor` through
  `cleanHardwareIdentityValue` (F16).
- **macOS:** `IOPlatformUUID`. Macs get the complete manual path with hints only (no TPM, §12).

`normalizeSystemUUID` rejects all-zero, all-F and known OEM placeholders. The value is sent at
enroll and in the hardware report.

### 7.2 API

- **Storage:** `device_hardware.system_uuid`, with partial indexes on `system_uuid` and on
  `(serial_number, manufacturer)`. Export: `included`.
- **Matching:** compares both the raw and the byte-swapped UUID forms (SMBIOS < 2.6).

### 7.3 Candidates

- **The service:** `services/reinstallCandidates.ts` ranks candidates **within the source's partner
  only**, by UUID, by serial + manufacturer, then by hostname.
- **Who qualifies as a target:** an older record whose newest §6.5 liveness signal is older than
  `source.enrolled_at`, that is not ephemeral, not parked, never the source of a confirmed
  reattach, and not in the source's dual-boot link group. Records with the same OS rank first.
- **What it writes:** it runs after enroll and after a hardware report, and writes **only on the
  source**: `possible_replacement_of_device_id` (F17), `possible_replacement_reason`
  (`hostname`|`hardware`|`tpm`) and `possible_replacement_detected_at`.
- **Notification:** an alert on the **target** (a real org; parked devices raise no alerts) and the
  event `device.reinstall_suspected`. For a parked source, the alert says only that a possible
  reinstall awaits partner review. It never names the parked device or its hostname (#7397).
- **No leaks:** a parked source never sees candidates, and the deploy key never reveals them (§10).
  - **Who sees parked candidates:** the people who see the holding area (§9). That is full
    partner admins always, and technicians limited to selected orgs where the partner turned on
    technician triage, for targets in their own orgs.
  - **Everyone else** sees only that a possible reinstall awaits partner review.

## 8. The reattach action

`POST /devices/:sourceId/reattach`

```json
{ "targetDeviceId": "…", "possessionConfirmed": true, "confirmTargetName": "…",
  "restoreDecommissioned": false, "acknowledgeOsChange": false, "stepUpGrant": "…" }
```

**Gates:**

- `requireInteractiveSession`, `requireMfa`, `devices:write` + `devices:delete`.
- **Only the partner reattaches.** A customer-org user never can. Among partner users:
  - **Full partner admins** (`org_access = 'all'`, `canManagePartnerWidePolicies`) may reattach any
    source to any target in the partner.
  - **Technicians limited to selected orgs** may reattach when the **target's org is one of
    theirs**, with `devices:write` + `devices:delete` there:
    - **Source in a real org:** that org must be one of theirs too, because its row is retired.
    - **Parked source:** allowed where the partner turned on technician triage (§9).
  - **Re-check:** confirm verifies again that the requester still satisfies this rule (§6.4).
- Step-up `device_reattach`, bound to `{ sourceDeviceId, targetDeviceId, targetAgentId,
  targetIncarnation, evidenceLevel, restoreDecommissioned }`:
  - It is consumed inside the intent's creating transaction, after the locks and every refusal
    check, following the `setDeployKeyEnrollmentSwitch` pattern, so a refusal never burns it.
  - The consume is a Redis `GETDEL` (F20): if the transaction fails after it, the grant is gone
    and the technician steps up again.

**Confirmation:**

- For `evidenceLevel = 'hint'`, `confirmTargetName` must equal the target's hostname: typed
  confirmation for the weaker evidence.
- The dialog shows the evidence honestly:
  - "Hardware identifiers reported by the device. Not verified."
  - for TPM: "Same TPM endorsement key the old install proved possession of. This proves key
    continuity, not the same physical TPM; cloned virtual TPMs share keys."
- It also says that the new install rebuilds the inventory, and that queued work, grants and
  sessions of the old install are cancelled (§5).

**Refusals (409, each with a code):**

- `target_alive` or `liveness_unknown` (§6.5);
- either side is quarantined or suspended;
- the target is ephemeral, or was the source of a confirmed reattach;
- either org is draining;
- the OS differs without `acknowledgeOsChange`;
- the source agent lacks `rebind_protocol_version`;
- either device is already in an open intent, in either role.

**Web:**

- **`AssignParkedDeviceDialog`:** gains **Reattach to X** beside "Assign as new", with a
  side-by-side comparison.
- **`PossibleReplacementBanner`:** gains **Reattach** for the same-org case.
- **The target:** shows a **Reinstalled on <date>** badge, and `device.reinstall` joins the
  activity feed allow-list.
- **Conventions:** every mutation goes through `runAction`, and every element the E2E tests touch
  has a `data-testid`.

## 9. Holding-area triage by technicians limited to selected orgs

Today the holding area is a full-partner-admin surface: listing, assigning, the deploy-key switch
and `expire-devices` all require `canManagePartnerWidePolicies` (`routes/preAssignment.ts:1-25`,
`services/unassignedPool/assignParkedDevice.ts:22-23`). In an MSP that does not fit how the work is
split. A technician usually serves several customers (orgs) without access to all of them. The
machines they image land in the holding area, and they need to see what arrives and send it to
their customers without waiting for a full admin. This section proposes that change to #7397. It
is separable from reattach and ships as wave H (§11).

### 9.1 A partner switch

- **The column:** `partners.holding_area_technician_access boolean NOT NULL DEFAULT false`.
- **Who flips it:** full partner admins, with step-up, following the deploy-key switch
  (`setDeployKeyEnrollmentSwitch`).
- **Off:** today's rule. Partners that keep strict separation between customers leave it off.
- **On:** technicians limited to selected orgs get the rights in §9.2.
- **Settings rule 9:**
  - home: the holding-area settings, beside the deploy-key switch;
  - level: partner;
  - resolver: the column;
  - the concept is configured in 0 places today and 1 after.

### 9.2 What a technician limited to selected orgs can do with the switch on

- **See the holding area:** the parked-device list and each device's details (hostname, hardware
  identifiers, OS, enroll time, the image key that parked it, reattach candidates). The whole
  partner's park is visible, because recognizing their own machines is the point.
- **Assign as new** into an org they manage, with `devices:write` there, through the existing
  assignment (step-up, `possessionConfirmed`, capacity admission).
- **Reattach** a parked device to a target in an org they manage (§8).

What stays with full partner admins:

- expiring and purging parked devices;
- `expire-devices` and every deploy-key action (§10);
- both partner switches.

### 9.3 Cost and controls

- **What it exposes:** before assignment, a parked machine's hostname and hardware can hint at
  which customer it belongs to. With the switch on, every technician of the partner sees them.
- **More people can admit a rogue device:** a device parked with a leaked image key is offered to
  more people who can assign or reattach it.
- **The controls:**
  - the switch is off by default;
  - every exit needs step-up and `possessionConfirmed`;
  - every parked device shows "Parked via image key X";
  - the actor is audited on every exit;
  - the destination is always limited to the technician's own orgs.

### 9.4 Enforcement

- **The access rule:** `resolvePartner` in `routes/preAssignment.ts` and the check inside
  `assignParkedDevice` both become "full partner admin, **or** switch on and the destination org
  in the actor's accessible orgs with `devices:write`". The service repeats it, as today.
- **The list route** reads the switch for technicians.
- **Contract tests:**
  - switch off: a technician limited to selected orgs gets 403 on every pre-assignment route,
    which is today's behavior;
  - switch on: the list works; assigning into their own org works, into another org gives 403;
    expire, purge, deploy-key actions and both switches give 403.

## 10. Deploy keys for the holding area (D2, independent track)

### 10.1 Table `partner_deploy_keys` (partner-axis, shape 3)

`id, partner_id, name, image_label, key_hash (peppered, as F15), created_by (SET NULL), created_at,
expires_at, max_usage, usage_count, max_parked, status ('active','revoked'), revoked_at,
revoked_by (SET NULL), rotated_from_id, last_used_at, last_used_ip, source_cidrs text[] (optional)`.

Mint and rotate take the partner's holding-area lock and refuse a third active key for the same
`(partner_id, image_label)`, with a contract test.

### 10.2 Limits proposed (the concrete ceiling #8318 asked for)

| Limit | Proposed | Why |
|---|---|---|
| Lifetime | **at most 365 days**; the admin picks a shorter one | Images are rebuilt on a 6–12-month cycle, and redistributing an image only to replace its key is costly; a year covers an annual rebuild. Org enrollment keys already allow 365 days (F15). |
| Uses | at most **1000 per key**; the admin picks fewer | An image enrolls a fleet; the current 50 would make a long-lived key useless. |
| Parked at once, per key (`max_parked`) | at most **20**, and never above the partner cap | A leaked key cannot fill the partner's holding area and starve its other keys. |
| Parked cap, `DEPLOY_KEY_RATE` | **unchanged** (50; 10 and 25 per 600 s) | #8318 condition. |
| Active keys per image | 2 (the current one and its rotation successor) | Rotation without breaking images already in the field. |

### 10.3 Terms (from #8318)

- **Parking only.** The key never creates orgs/sites, reveals no candidates and carries no
  assignment authority. The parked device's routes stay on the allow-list (F12).
- **One key per image**, enforced (§10.1), revocable and rotatable from the UI.
- **Revocation expires everything the key parked.** This is not optional: revoke runs the existing
  `expire-devices` path (F14) for the key in the same request.
- **Eligibility gate.** Verified or paid partner status is a gate for issuing **any** deploy key,
  not evidence that any enrollment is legitimate. The predicate is §13 question 10.

### 10.4 Certificates for parked devices

Edge certificates are optional: they exist only where Cloudflare mTLS is configured, and the
edge refuses agent traffic without one only after the WAF phase is enabled
(`docs/operations/cloudflare-mtls-setup.md`). A certificate authorizes nothing by itself, because
every agent route still needs a bearer token. It is a perimeter filter that keeps unauthenticated
traffic from reaching the API.

Where it is configured, every enroll issues one (`routes/agents/enrollment.ts:1066`), and a parked
device can renew it (`/renew-cert` skips agent auth, `middleware/agentAuthParked.ts:20-27`). The
image is effectively public, so the edge filter would be open to anyone holding the image.

Proposed:

- **Lifetime:** a pool-enrolled certificate lives no longer than the device's parked expiry.
- **Revocation:** it is revoked on expiry, purge or key revocation.
- **Renewal:** parked renewal is refused; assignment or reattach issues the device's real
  certificate.
- **Bound:** a leaked key yields at most `max_parked` live certificates at a time, which only reach
  routes that still require a bearer token, and the parked allow-list confines those.

The alternative, no certificate at pool enrollment, works only where the edge does not gate agent
routes on certificates. §13 question 9.

### 10.5 Compensating controls for the long lifetime

- **Treat the key as public.** It is embedded in an image, so anyone holding a copy has it. The
  risk lives in what follows parking (§3), and the controls are aimed there.
- **Visibility.** Every parked device shows "Parked via image key X". Each key shows its use count,
  last use and source.
- **Anomaly alert.** The partner is alerted when a key's enrollments exceed its expected rate, or
  when the key's sub-cap or the partner cap is reached.
- **Expiry.** A warning goes out 30 days before a key expires.
- **Optional source CIDRs.** These are for imaging that runs inside the partner's own network.
- **Hint-only reattach of a key-parked device** always needs the typed confirmation (§8).

### 10.6 Enrollment branch

1. Resolve the deploy key and check `checkDeployKeyRateBuckets` **outside** any DB transaction
   (fail-closed).
2. Check `isDeployKeyEnrollmentEnabled` (env + partner switch) and the eligibility predicate.
3. Inside the transaction:
   - `getOrCreateUnassignedPoolOrg`;
   - `admitParkedEnrollment` in place of `admitPartnerDeviceCapacity`, extended with the key's
     `max_parked`;
   - claim one use with a compare-and-swap on `usage_count`;
   - write the `enrolled` ledger row with `deploy_key_id`.
4. Respond with `{ preAssignment: true }` and a certificate bounded as in §10.4.

Collision lookup stays scoped to the key's own org and site, so a pool enrollment can never see a
customer row. Install: `breeze-agent enroll <deploy-key>` for images and scripts.

## 11. Waves (reordered per #8318)

| Wave | Contents | Depends on |
|---|---|---|
| **0 — spec** | This document | — |
| **1a — incarnation boundary** | §4.1 incarnation columns; §4.2 stamping trigger and the claim/result refusals; the §5 handlers as a service; the §5.8 contract, parity and all-category integration tests (driven directly, no external trigger yet) | 0 |
| **1b — bounded rebind** | §4.3–§4.5 tables and CHECKs (the `reattached` exit, D4); `rebind_protocol_version` at enroll and in both beats; §6 protocol, server and agent: the signed directive, agent-generated staged set, pending certificate, `rebind-confirm`, idempotent replay and the #2773 discard rule; the liveness marker; the stale-caller predicates; the WS lease identity comparison (F5); full-hash revocation on F3's re-enroll; the §6.5 tests | 1a |
| **2 — hints + manual reattach** | §7 agent and API; candidates; §8 action and step-up `device_reattach`; web; E2E | 1b |
| **H — technician triage** (independent) | §9: the partner switch, the access rule in the pre-assignment routes and `assignParkedDevice`, the list and assign UI for technicians, the contract tests. Reattach from a parked source by technicians lands with wave 2 | — |
| **D — deploy keys** (independent) | §10 table, routes, UI, enrollment branch, limits, parked certificates, controls | — |
| **T1 — TPM EK collection** (independent, early) | §12.1–§12.2: possession-proven EK baselines recorded before anyone reformats | — |
| **T2 — TPM evidence** | `tpm_continuity` evidence level in candidates and the dialog; the attestation routes join the parked allow-list, so a parked source can prove continuity; independent review of `MakeCredential` before merge | T1, 2 |

Manual reattach (wave 2) does not depend on D or T: a source enrolled with an ordinary org key and
flagged by the #2764 collision path can be reattached from the banner.

## 12. TPM (D3, independent track)

### 12.1 Agent

- **Library and build:** `github.com/google/go-tpm`, pinned, with `CGO_ENABLED=0` verified on
  Windows, Linux and macOS builds.
- **Access:** TBS on Windows, `/dev/tpmrm0` on Linux.
- **What it reads and creates:** it reads the EK public key (RSA-2048 default template) and the EK
  certificate when present, and creates a restricted signing AK.
- **Simulator:** tests that use a simulator sit behind the `tpmsim` build tag (the simulator needs
  cgo).
- **Fallback:** without a TPM, or with TBS unavailable, the agent reports `tpmAvailable=false` and
  moves on.
- **Separate from #7433:** this does not deliver non-exportable agent keys.

### 12.2 API (collection)

- **Challenge:** `POST /agents/:id/attestation/challenge` validates the AK attributes (restricted,
  sign, fixedTPM, fixedParent, sensitiveDataOrigin). It then computes `MakeCredential(EKpub,
  AKname, secret)` and stores a single-use challenge (300 s).
- **Complete:** `POST /agents/:id/attestation/complete` checks the secret in constant time, then
  records `device_hardware.tpm_ek_pub_sha256` and `tpm_attested_at`. The export classifications
  are `excludedSensitive` and `included`. The inventory writer cannot overwrite either.
- **Never logged:** challenges, secrets and EKs.
- **Coverage metric:** the share of a partner's devices with a baseline, which is the share
  "ready for reinstall".

**Review gate.** `MakeCredential` (KDFa, RSA-OAEP with label `IDENTITY`, AES-CFB, HMAC) gets
Go-generated test vectors and an **independent review before merge** (#8318).

## 13. Decisions to confirm in review

1. **Install incarnation scope.** A device-level `install_incarnation`, stamped on commands by a
   trigger, plus explicit handlers for the rest (§5). The alternative is an incarnation column on
   every device-keyed table.
2. **PAM at the boundary.** Non-terminal actuations become `failed` with reason
   `superseded_by_reinstall`, and no cleanup is sent to the new install (§5.3).
3. **Pre-reattach snapshots.** They lose the producer-only free pass and go through the
   unattested-restore approval (§5.4).
4. **The staged set.** The agent generates its staged credentials and sends only hashes. They are
   staged on the intent, not in `devices.pending_*`, and confirmed with a separate, confirm-only
   credential (§6.3–§6.4).
5. **Liveness.** A 10-minute quiet period over every credential signal, including a new Redis
   credential-use marker. It fails closed without Redis (§6.5).
6. **Who may reattach.** Only the partner, never a customer-org user. Full partner admins can
   reattach anything in the partner. Technicians limited to selected orgs can reattach into an org
   they manage, and from a parked source where technician triage is on (§8).
7. **Technician triage of the holding area.** This changes #7397: a partner switch, off by
   default, lets technicians limited to selected orgs see the holding area and assign or reattach
   parked devices into their own orgs. Expiry, purge, deploy keys and both switches stay with full
   partner admins (§9).
8. **Deploy-key ceilings.** 365 days, 1000 uses, 20 parked at once per key, 2 active keys per
   image (§10.2).
9. **Parked certificates** (only where mTLS is configured). The proposal is bounded to the parked
   lifetime, with no renewal. The alternative is none at all, which strands parked devices behind
   an enforcing edge (§10.4).
10. **The eligibility predicate.** Which existing partner field means "verified or paid"?
11. **Intent TTLs.** 60 minutes `requested`, 15 minutes `staged` (§6.5).

## 14. Risks

- **Old agents.** An agent cannot be reattached until it upgrades to `rebind_protocol_version`.
  Machines that reinstall a pre-capability image still enroll as new devices.
- **TPM coverage.** EK continuity helps only if the old install recorded a baseline before the
  reformat, hence T1 early. EK changes (fTPM reset, board swap) fall back to hints.
- **Forgeable hints.** Hint-only matches stay forgeable, which is why a human, a typed
  confirmation and a step-up are required.
- **The boundary list must keep up.** A new device-referencing table holding work or grants that
  is not classified would carry over. The §5.8 contract test makes that a red suite.
- **Late inventory from the old install.** A request authenticated just before confirm can still
  write inventory rows. The new install's first report overwrites them (§6.4).
- **Deploy-key availability.** A leaked key can burn its uses (about 17 h at 10 per 600 s) and its
  sub-cap, so new installs from that image fail until the key is rotated. It cannot fill the
  partner cap or touch other keys, but it does take up to 40% of the partner-wide rate bucket
  while it runs. The anomaly alert and the two-key rotation are the answer.
- **Technician triage widens who sees the park.** With the §9 switch on, every technician of the
  partner sees parked hostnames and hardware before assignment. It is off by default, and every
  exit is step-up-bound and audited.
- **Data the parked source accumulated** stays on the retired row. The target's inventory is
  rebuilt by the new install, and the dialog says so.
