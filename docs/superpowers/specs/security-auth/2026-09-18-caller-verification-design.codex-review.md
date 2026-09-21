# Codex (gpt-6-astra, xhigh) review of caller-verification spec — 2026-09-19

I read the [full spec](docs/superpowers/specs/security-auth/2026-09-18-caller-verification-design.md) and checked the cited implementation paths. No files were modified.

1. **Blocker — Tiers / workstation verification: the responding session is not bound to the contact.**  
   **Claim:** Answering on the selected device and username establishes tier 3 verification of the selected contact.  
   **Evidence:** The technician supplies both independently; name/local-part suggestions establish no identity relationship. Existing [`SessionForUser`](agent/internal/sessionbroker/broker.go:929) selects by username, whereas the broker’s authenticated identity is SID/UID. Windows UID is always zero ([broker.go:978](agent/internal/sessionbroker/broker.go:978)). Consequently, a technician’s own or another employee’s session could verify the victim’s contact.  
   **Change:** Require an independently established contact-to-principal binding. Target and validate an immutable SID/UID plus OS session identity; reject ambiguous matches. Assign lower assurance to manually selected, unbound sessions.

2. **Blocker — Gate subject resolution / same-mailbox exclusion: the design lacks a canonical identity.**  
   **Claim:** Entra links or email matching identify the subject, and hashing the target UPN prevents verification through that subject’s mailbox.  
   **Evidence:** Contacts deliberately permit duplicate email addresses ([contacts.ts:86](apps/api/src/db/schema/contacts.ts:86)). Imports accept arbitrary external-system identifiers ([schemas.ts:79](apps/api/src/services/contacts/schemas.ts:79)); an `entra` link is not inherently authoritative. Existing tools resolve UPN to OID and discard the UPN before mutation ([aiToolsM365.ts:258](apps/api/src/services/aiToolsM365.ts:258)). Comparing strings also misses mailbox aliases.  
   **Change:** Establish a trusted `(Entra tenant ID, object ID)` binding, reject ambiguous contact matches, and distinguish directory-validated links from imported labels. Check destination ownership against authoritative mailbox identity, including aliases; fail closed when it cannot be established.

3. **Major — D5 / Graph enforcement: the proposed check does not necessarily guard the identity actually mutated.**  
   **Claim:** Checking `executeM365WriteActionByOrg` provides enforcement where the Graph call is made.  
   **Evidence:** That service forwards the original identifier to another service ([writeActionService.ts:159](apps/api/src/services/m365ControlPlane/writeActionService.ts:159)). The executor subsequently resolves it and performs the PATCH ([writeActions.ts:56](apps/m365-graph-actions-executor/src/microsoft/writeActions.ts:56)). UPN reassignment or connection changes can separate the verified identity from the executed target.  
   **Change:** Pin tenant/OID in the authorized intent and verification grant, pass that immutable target to the executor, and define expiry/revocation enforcement at dispatch. Test identity and connection changes between verification, release, and execution.

4. **Major — Establishment rule: existing contact audits cannot support the promised assurance.**  
   **Claim:** The audit trail proves that a particular destination remained unchanged and was established by a technician.  
   **Evidence:** Create events record roles/primary status; import updates record only source/link metadata ([audit.ts:60](apps/api/src/services/contacts/audit.ts:60), [audit.ts:96](apps/api/src/services/contacts/audit.ts:96)). CRUD updates record field names, not destination history ([orgContacts.ts:351](apps/api/src/routes/orgContacts.ts:351)). AI-created contacts also carry the technician’s user ID ([aiToolsOrgs.ts:518](apps/api/src/services/aiToolsOrgs.ts:518)); non-null ownership is insufficient.  
   **Change:** Add transactional, per-destination provenance: normalized value/version, changed-at, source, and explicit human attestation. Treat historical records without adequate evidence conservatively. Editing an unrelated contact field must not establish its phone or email.

5. **Major — Data model / freshness gate: verification is reusable across unrelated calls and actions.**  
   **Claim:** Any fresh, sufficiently strong verification of the contact authorizes the action.  
   **Evidence:** Spec lines 211–218 select only by contact, tier, status, and age. There is no actor/request/action binding or consumption. An impersonator calling another technician shortly after a legitimate verification inherits that verification; one approval can authorize repeated resets and account disablement.  
   **Change:** Bind a grant to the canonical subject, initiating technician/request, and permitted action or action digest. Reserve/consume it idempotently for an intent. Define any permitted reuse explicitly, and invalidate grants when identity bindings or relevant trust conditions change.

6. **Major — D2 / reverse-verification UX: the anti-relay and technician-authentication claims are false.**  
   **Claim:** Number matching is not relayable, and reading the reverse code “proves I’m from Acme IT.”  
   **Evidence:** The attacker speaking to the real technician learns both numbers and can repeat them to the victim. Seeing the choices is unnecessary. The spec acknowledges this exact attack in “Threats this still does not stop,” contradicting D2 and the proposed script. A branded page supplied by the caller is also not an independent trust anchor.  
   **Change:** Remove the proof and non-relayability claims. Describe number matching as request confirmation. Show the exact action and target; use an independently opened helper/trusted portal or a callback to a previously known number for stronger reverse verification. The 32-byte bearer token has adequate entropy; the short displayed codes should not be treated as independent authentication factors.

7. **Major — Rejection / state transitions: cancellation authority and race semantics are incomplete.**  
   **Claim:** “Not me” cancels everything pending and prevents the action.  
   **Evidence:** [`cancelActionIntent`](apps/api/src/services/actionIntents/intentService.ts:2289) requires requester/approver authorization, which a public challenge response lacks. It cancels `pending_approval`/`approved`, while release claims `executing` before revalidation ([intentReleaseWorker.ts:904](apps/api/src/jobs/intentReleaseWorker.ts:904)). A separate cooling-off read cannot serialize against Graph dispatch. The spec also leaves cooldown override persistence and concurrent attempt-cap enforcement undefined.  
   **Change:** Define a trusted internal rejection operation, subject-level revocation fence, atomic attempt reservation, and explicit cooldown override state. Specify the irreversible dispatch boundary and report already-in-flight actions honestly. Make rejection side effects durable and idempotent.

8. **Major — D5 / contract tests: a third supported M365 backend is omitted.**  
   **Claim:** Two Graph execution paths cover the mutation boundary.  
   **Evidence:** [`aiToolsM365.ts:78`](apps/api/src/services/aiToolsM365.ts:78) also selects Delegant; [`call()`](apps/api/src/services/aiToolsM365.ts:102) dispatches mutations through `invokeDelegantTool`. Neither proposed low-level check covers it. Normal technician chat still passes intent revalidation, so this is an incomplete enforcement boundary rather than proof of an immediate chat bypass.  
   **Change:** Gate Delegant dispatch too, or explicitly disable those mutations. Replace source-reference-only assurance with behavioral tests proving that every backend issues zero mutation calls when verification is refused.

9. **Major — D9 / delivery and results: the proposed WS-only hook can lose decisions.**  
   **Claim:** Dispatch, record the command ID, and consume the result in `agentWs.processCommandResult`.  
   **Evidence:** The agent also submits HTTP results ([heartbeat.go:6084](agent/internal/heartbeat/heartbeat.go:6084)). REST dispatch uses an explicit command allowlist ([commands.ts:91](apps/api/src/routes/agents/commands.ts:91)); if HTTP wins terminalization, WS ignores the duplicate ([agentWs.ts:2107](apps/api/src/routes/agentWs.ts:2107)). Furthermore, `dispatchCommandToAgent` transmits rather than creating the persisted ownership record ([agentCommandRelay.ts:194](apps/api/src/services/agentCommandRelay.ts:194)). Recording correlation after sending creates an early-result race.  
   **Change:** Persist command ownership, a unique verification mapping, and delivery work before dispatch. Register one authenticated, idempotent handler for both transports, using expiry-aware verification CAS. Specify crash recovery and reconciliation, including “not me” fan-out.

10. **Major — Workstation implementation: RDS and older-helper behavior are incorrectly assumed.**  
    **Claim:** The Tauri consent seam provides the proposed UI across targeted sessions, and old helpers return an unknown-type error.  
    **Evidence:** Assist/Tauri helpers are console-bound ([broker.go:2715](agent/internal/sessionbroker/broker.go:2715)); existing consent uses a native fallback ([consent_gate.go:165](agent/internal/heartbeat/consent_gate.go:165)). Older Tauri helpers silently ignore unknown messages ([client.rs:365](apps/helper/src-tauri/src/ipc/client.rs:365)).  
    **Change:** Implement a targeted native RDS UI or declare those sessions unavailable. Advertise a dedicated protocol capability before offering the method. Explicitly prohibit timeout approval and test actual old-helper behavior.

11. **Major — Goal 5 / policy resolution: org overrides can defeat the partner’s security policy.**  
    **Claim:** Partner-wide policy decides assurance requirements.  
    **Evidence:** The spec allows an org settings writer to create a whole-row override with tier `0`. [`canManagePartnerWidePolicies`](apps/api/src/services/partnerWideAccess.ts:25) governs partner-owned rows, not those overrides. This is an authority-model issue, not an XOR/RLS defect.  
    **Change:** Decide whether partner policy is an enforced minimum or merely a default. For a minimum, require partner authority for weakening org overrides. Also define how disabling methods or strengthening policy affects already-issued grants.

12. **Major — API authorization: org RLS does not enforce existing site restrictions.**  
    **Claim:** Org scope plus contact permissions sufficiently authorizes the endpoints.  
    **Evidence:** Existing contact routes explicitly apply site authorization because RLS covers only the org axis ([orgContacts.ts:93](apps/api/src/routes/orgContacts.ts:93)). The proposed history, methods, initiation, cancellation, and suggestions routes omit it.  
    **Change:** Apply contact site checks on every authenticated operation. Independently validate device and ticket ownership and actor access, including same-org relationships. Add sibling-site denial tests and preserve the existing org-level-contact exception.

13. **Major — Data model / device moves: dropping the FK does not make `device_id` an inert snapshot.**  
    **Claim:** Device moves will leave verification rows unchanged because there is no device FK.  
    **Evidence:** The database discovers device children by UUID column names, regardless of FKs ([migration:582](apps/api/migrations/2026-10-14-100000-ai-operator-thin-slice.sql:582)), then rewrites their `org_id` ([migration:789](apps/api/migrations/2026-10-14-100000-ai-operator-thin-slice.sql:789)). This would conflict with the contact/org composite FK during a device-only move.  
    **Change:** Rename the snapshot column, or explicitly exclude the table through a forward migration. Test direct-SQL and route-driven moves; separately define revocation of pending challenges when a device moves.

14. **Major — Registrations / org merge: both new tables need explicit merge policies.**  
    **Claim:** Cascade/export/RLS registrations and a deferrable contact FK complete merge support.  
    **Evidence:** Every cascade table requires an [`orgMergeRegistry`](apps/api/src/services/orgMergeRegistry.ts:4) classification; missing entries cause a runtime error ([orgMerge.ts:1083](apps/api/src/services/orgMerge.ts:1083)).  
    **Change:** Specify singleton-policy conflict handling, history movement, and revocation of pending/fresh authorization during merge. Test two populated policies and both pending and verified loser-org records.

15. **Major — D7 / `require_ticket` / timeline: ticket correlation is discarded before asynchronous outcomes arrive.**  
    **Claim:** No ticket linkage is needed, all outcomes appear on the ticket, and policy can require a ticket.  
    **Evidence:** Spec line 297 discards `ticketId` after the initial comment. Later agent/public decisions cannot reliably identify the originating ticket, and the gate receives no ticket context. A contact can have multiple tickets.  
    **Change:** Persist durable correlation outside the problematic device/ticket child shape, such as a separate association or structured event linkage. Define whether `require_ticket` applies at initiation or release, and validate the ticket’s org, requester, and relationship to the authorized action.

16. **Major — Default policy / UX: requiring the target’s cooperation obstructs legitimate account disablement.**  
    **Claim:** Both password reset and disable-user should require verification of the affected contact.  
    **Evidence:** The existing disable tool blocks the target’s sign-in ([aiToolsM365.ts:217](apps/api/src/services/aiToolsM365.ts:217)). Offboarding and incident containment commonly originate with a manager/security operator; the target may be hostile or unavailable.  
    **Change:** Separate requester identity from affected-account identity. Define an explicitly authorized administrative/emergency workflow with its own assurance, reason, and audit requirements, avoiding a global gate-disable workaround.

17. **Major — Waves: visible verification can ship before enforcement and rejection handling.**  
    **Claim:** W01–W04 ship independently while W05 later adds enforcement and rejection fan-out.  
    **Evidence:** W04 exposes green verification badges and challenge UI, while W05 supplies the actual gate, incident creation, cancellation, and notifications. Users could reasonably assume protections that are not active.  
    **Change:** Keep the feature inaccessible behind a server-controlled readiness flag until enforcement and rejection handling are deployed. Gate availability per method and supported agent/helper capability.

18. **Minor — Implementation contracts: permission, RLS/export, and refusal plumbing remain unspecified.**  
    **Claim:** The named grants, registrations, and structured refusal will work with existing infrastructure.  
    **Evidence:** Contacts currently use organization permissions plus MFA ([orgContacts.ts:176](apps/api/src/routes/orgContacts.ts:176)); the proposed contact/settings grants need explicit introduction. XOR SELECT coverage has a separate allowlist ([rls-coverage.integration.test.ts:564](apps/api/src/__tests__/integration/rls-coverage.integration.test.ts:564)). Export sensitivity matches `password`, requiring reviewed inclusion for the non-secret policy field ([tenantExportPolicy.ts:35](apps/api/src/services/tenantExportPolicy.ts:35)). Inline release currently reduces refusals to generic output ([aiAgentSdk.ts:1455](apps/api/src/services/aiAgentSdk.ts:1455)).  
    **Change:** Name permission migrations/default roles/MFA requirements, both RLS allowlists, explicit policy-column export classifications, and every adapter that must preserve refusal metadata. Test the actual modal-opening path and distinguish refusal from execution failure.

**Verdict: rework.** The delivery primitives, direct-org tenancy shape, XOR ownership, and separate partner-wide SELECT policy are sound foundations. Subject binding, grant scope, dispatch/rejection semantics, and lifecycle handling need concrete decisions before this can reliably function as an anti-vishing security boundary.
89,931
I read the [full spec](docs/superpowers/specs/security-auth/2026-09-18-caller-verification-design.md) and checked the cited implementation paths. No files were modified.

1. **Blocker — Tiers / workstation verification: the responding session is not bound to the contact.**  
   **Claim:** Answering on the selected device and username establishes tier 3 verification of the selected contact.  
   **Evidence:** The technician supplies both independently; name/local-part suggestions establish no identity relationship. Existing [`SessionForUser`](agent/internal/sessionbroker/broker.go:929) selects by username, whereas the broker’s authenticated identity is SID/UID. Windows UID is always zero ([broker.go:978](agent/internal/sessionbroker/broker.go:978)). Consequently, a technician’s own or another employee’s session could verify the victim’s contact.  
   **Change:** Require an independently established contact-to-principal binding. Target and validate an immutable SID/UID plus OS session identity; reject ambiguous matches. Assign lower assurance to manually selected, unbound sessions.

2. **Blocker — Gate subject resolution / same-mailbox exclusion: the design lacks a canonical identity.**  
   **Claim:** Entra links or email matching identify the subject, and hashing the target UPN prevents verification through that subject’s mailbox.  
   **Evidence:** Contacts deliberately permit duplicate email addresses ([contacts.ts:86](apps/api/src/db/schema/contacts.ts:86)). Imports accept arbitrary external-system identifiers ([schemas.ts:79](apps/api/src/services/contacts/schemas.ts:79)); an `entra` link is not inherently authoritative. Existing tools resolve UPN to OID and discard the UPN before mutation ([aiToolsM365.ts:258](apps/api/src/services/aiToolsM365.ts:258)). Comparing strings also misses mailbox aliases.  
   **Change:** Establish a trusted `(Entra tenant ID, object ID)` binding, reject ambiguous contact matches, and distinguish directory-validated links from imported labels. Check destination ownership against authoritative mailbox identity, including aliases; fail closed when it cannot be established.

3. **Major — D5 / Graph enforcement: the proposed check does not necessarily guard the identity actually mutated.**  
   **Claim:** Checking `executeM365WriteActionByOrg` provides enforcement where the Graph call is made.  
   **Evidence:** That service forwards the original identifier to another service ([writeActionService.ts:159](apps/api/src/services/m365ControlPlane/writeActionService.ts:159)). The executor subsequently resolves it and performs the PATCH ([writeActions.ts:56](apps/m365-graph-actions-executor/src/microsoft/writeActions.ts:56)). UPN reassignment or connection changes can separate the verified identity from the executed target.  
   **Change:** Pin tenant/OID in the authorized intent and verification grant, pass that immutable target to the executor, and define expiry/revocation enforcement at dispatch. Test identity and connection changes between verification, release, and execution.

4. **Major — Establishment rule: existing contact audits cannot support the promised assurance.**  
   **Claim:** The audit trail proves that a particular destination remained unchanged and was established by a technician.  
   **Evidence:** Create events record roles/primary status; import updates record only source/link metadata ([audit.ts:60](apps/api/src/services/contacts/audit.ts:60), [audit.ts:96](apps/api/src/services/contacts/audit.ts:96)). CRUD updates record field names, not destination history ([orgContacts.ts:351](apps/api/src/routes/orgContacts.ts:351)). AI-created contacts also carry the technician’s user ID ([aiToolsOrgs.ts:518](apps/api/src/services/aiToolsOrgs.ts:518)); non-null ownership is insufficient.  
   **Change:** Add transactional, per-destination provenance: normalized value/version, changed-at, source, and explicit human attestation. Treat historical records without adequate evidence conservatively. Editing an unrelated contact field must not establish its phone or email.

5. **Major — Data model / freshness gate: verification is reusable across unrelated calls and actions.**  
   **Claim:** Any fresh, sufficiently strong verification of the contact authorizes the action.  
   **Evidence:** Spec lines 211–218 select only by contact, tier, status, and age. There is no actor/request/action binding or consumption. An impersonator calling another technician shortly after a legitimate verification inherits that verification; one approval can authorize repeated resets and account disablement.  
   **Change:** Bind a grant to the canonical subject, initiating technician/request, and permitted action or action digest. Reserve/consume it idempotently for an intent. Define any permitted reuse explicitly, and invalidate grants when identity bindings or relevant trust conditions change.

6. **Major — D2 / reverse-verification UX: the anti-relay and technician-authentication claims are false.**  
   **Claim:** Number matching is not relayable, and reading the reverse code “proves I’m from Acme IT.”  
   **Evidence:** The attacker speaking to the real technician learns both numbers and can repeat them to the victim. Seeing the choices is unnecessary. The spec acknowledges this exact attack in “Threats this still does not stop,” contradicting D2 and the proposed script. A branded page supplied by the caller is also not an independent trust anchor.  
   **Change:** Remove the proof and non-relayability claims. Describe number matching as request confirmation. Show the exact action and target; use an independently opened helper/trusted portal or a callback to a previously known number for stronger reverse verification. The 32-byte bearer token has adequate entropy; the short displayed codes should not be treated as independent authentication factors.

7. **Major — Rejection / state transitions: cancellation authority and race semantics are incomplete.**  
   **Claim:** “Not me” cancels everything pending and prevents the action.  
   **Evidence:** [`cancelActionIntent`](apps/api/src/services/actionIntents/intentService.ts:2289) requires requester/approver authorization, which a public challenge response lacks. It cancels `pending_approval`/`approved`, while release claims `executing` before revalidation ([intentReleaseWorker.ts:904](apps/api/src/jobs/intentReleaseWorker.ts:904)). A separate cooling-off read cannot serialize against Graph dispatch. The spec also leaves cooldown override persistence and concurrent attempt-cap enforcement undefined.  
   **Change:** Define a trusted internal rejection operation, subject-level revocation fence, atomic attempt reservation, and explicit cooldown override state. Specify the irreversible dispatch boundary and report already-in-flight actions honestly. Make rejection side effects durable and idempotent.

8. **Major — D5 / contract tests: a third supported M365 backend is omitted.**  
   **Claim:** Two Graph execution paths cover the mutation boundary.  
   **Evidence:** [`aiToolsM365.ts:78`](apps/api/src/services/aiToolsM365.ts:78) also selects Delegant; [`call()`](apps/api/src/services/aiToolsM365.ts:102) dispatches mutations through `invokeDelegantTool`. Neither proposed low-level check covers it. Normal technician chat still passes intent revalidation, so this is an incomplete enforcement boundary rather than proof of an immediate chat bypass.  
   **Change:** Gate Delegant dispatch too, or explicitly disable those mutations. Replace source-reference-only assurance with behavioral tests proving that every backend issues zero mutation calls when verification is refused.

9. **Major — D9 / delivery and results: the proposed WS-only hook can lose decisions.**  
   **Claim:** Dispatch, record the command ID, and consume the result in `agentWs.processCommandResult`.  
   **Evidence:** The agent also submits HTTP results ([heartbeat.go:6084](agent/internal/heartbeat/heartbeat.go:6084)). REST dispatch uses an explicit command allowlist ([commands.ts:91](apps/api/src/routes/agents/commands.ts:91)); if HTTP wins terminalization, WS ignores the duplicate ([agentWs.ts:2107](apps/api/src/routes/agentWs.ts:2107)). Furthermore, `dispatchCommandToAgent` transmits rather than creating the persisted ownership record ([agentCommandRelay.ts:194](apps/api/src/services/agentCommandRelay.ts:194)). Recording correlation after sending creates an early-result race.  
   **Change:** Persist command ownership, a unique verification mapping, and delivery work before dispatch. Register one authenticated, idempotent handler for both transports, using expiry-aware verification CAS. Specify crash recovery and reconciliation, including “not me” fan-out.

10. **Major — Workstation implementation: RDS and older-helper behavior are incorrectly assumed.**  
    **Claim:** The Tauri consent seam provides the proposed UI across targeted sessions, and old helpers return an unknown-type error.  
    **Evidence:** Assist/Tauri helpers are console-bound ([broker.go:2715](agent/internal/sessionbroker/broker.go:2715)); existing consent uses a native fallback ([consent_gate.go:165](agent/internal/heartbeat/consent_gate.go:165)). Older Tauri helpers silently ignore unknown messages ([client.rs:365](apps/helper/src-tauri/src/ipc/client.rs:365)).  
    **Change:** Implement a targeted native RDS UI or declare those sessions unavailable. Advertise a dedicated protocol capability before offering the method. Explicitly prohibit timeout approval and test actual old-helper behavior.

11. **Major — Goal 5 / policy resolution: org overrides can defeat the partner’s security policy.**  
    **Claim:** Partner-wide policy decides assurance requirements.  
    **Evidence:** The spec allows an org settings writer to create a whole-row override with tier `0`. [`canManagePartnerWidePolicies`](apps/api/src/services/partnerWideAccess.ts:25) governs partner-owned rows, not those overrides. This is an authority-model issue, not an XOR/RLS defect.  
    **Change:** Decide whether partner policy is an enforced minimum or merely a default. For a minimum, require partner authority for weakening org overrides. Also define how disabling methods or strengthening policy affects already-issued grants.

12. **Major — API authorization: org RLS does not enforce existing site restrictions.**  
    **Claim:** Org scope plus contact permissions sufficiently authorizes the endpoints.  
    **Evidence:** Existing contact routes explicitly apply site authorization because RLS covers only the org axis ([orgContacts.ts:93](apps/api/src/routes/orgContacts.ts:93)). The proposed history, methods, initiation, cancellation, and suggestions routes omit it.  
    **Change:** Apply contact site checks on every authenticated operation. Independently validate device and ticket ownership and actor access, including same-org relationships. Add sibling-site denial tests and preserve the existing org-level-contact exception.

13. **Major — Data model / device moves: dropping the FK does not make `device_id` an inert snapshot.**  
    **Claim:** Device moves will leave verification rows unchanged because there is no device FK.  
    **Evidence:** The database discovers device children by UUID column names, regardless of FKs ([migration:582](apps/api/migrations/2026-10-14-100000-ai-operator-thin-slice.sql:582)), then rewrites their `org_id` ([migration:789](apps/api/migrations/2026-10-14-100000-ai-operator-thin-slice.sql:789)). This would conflict with the contact/org composite FK during a device-only move.  
    **Change:** Rename the snapshot column, or explicitly exclude the table through a forward migration. Test direct-SQL and route-driven moves; separately define revocation of pending challenges when a device moves.

14. **Major — Registrations / org merge: both new tables need explicit merge policies.**  
    **Claim:** Cascade/export/RLS registrations and a deferrable contact FK complete merge support.  
    **Evidence:** Every cascade table requires an [`orgMergeRegistry`](apps/api/src/services/orgMergeRegistry.ts:4) classification; missing entries cause a runtime error ([orgMerge.ts:1083](apps/api/src/services/orgMerge.ts:1083)).  
    **Change:** Specify singleton-policy conflict handling, history movement, and revocation of pending/fresh authorization during merge. Test two populated policies and both pending and verified loser-org records.

15. **Major — D7 / `require_ticket` / timeline: ticket correlation is discarded before asynchronous outcomes arrive.**  
    **Claim:** No ticket linkage is needed, all outcomes appear on the ticket, and policy can require a ticket.  
    **Evidence:** Spec line 297 discards `ticketId` after the initial comment. Later agent/public decisions cannot reliably identify the originating ticket, and the gate receives no ticket context. A contact can have multiple tickets.  
    **Change:** Persist durable correlation outside the problematic device/ticket child shape, such as a separate association or structured event linkage. Define whether `require_ticket` applies at initiation or release, and validate the ticket’s org, requester, and relationship to the authorized action.

16. **Major — Default policy / UX: requiring the target’s cooperation obstructs legitimate account disablement.**  
    **Claim:** Both password reset and disable-user should require verification of the affected contact.  
    **Evidence:** The existing disable tool blocks the target’s sign-in ([aiToolsM365.ts:217](apps/api/src/services/aiToolsM365.ts:217)). Offboarding and incident containment commonly originate with a manager/security operator; the target may be hostile or unavailable.  
    **Change:** Separate requester identity from affected-account identity. Define an explicitly authorized administrative/emergency workflow with its own assurance, reason, and audit requirements, avoiding a global gate-disable workaround.

17. **Major — Waves: visible verification can ship before enforcement and rejection handling.**  
    **Claim:** W01–W04 ship independently while W05 later adds enforcement and rejection fan-out.  
    **Evidence:** W04 exposes green verification badges and challenge UI, while W05 supplies the actual gate, incident creation, cancellation, and notifications. Users could reasonably assume protections that are not active.  
    **Change:** Keep the feature inaccessible behind a server-controlled readiness flag until enforcement and rejection handling are deployed. Gate availability per method and supported agent/helper capability.

18. **Minor — Implementation contracts: permission, RLS/export, and refusal plumbing remain unspecified.**  
    **Claim:** The named grants, registrations, and structured refusal will work with existing infrastructure.  
    **Evidence:** Contacts currently use organization permissions plus MFA ([orgContacts.ts:176](apps/api/src/routes/orgContacts.ts:176)); the proposed contact/settings grants need explicit introduction. XOR SELECT coverage has a separate allowlist ([rls-coverage.integration.test.ts:564](apps/api/src/__tests__/integration/rls-coverage.integration.test.ts:564)). Export sensitivity matches `password`, requiring reviewed inclusion for the non-secret policy field ([tenantExportPolicy.ts:35](apps/api/src/services/tenantExportPolicy.ts:35)). Inline release currently reduces refusals to generic output ([aiAgentSdk.ts:1455](apps/api/src/services/aiAgentSdk.ts:1455)).  
    **Change:** Name permission migrations/default roles/MFA requirements, both RLS allowlists, explicit policy-column export classifications, and every adapter that must preserve refusal metadata. Test the actual modal-opening path and distinguish refusal from execution failure.

**Verdict: rework.** The delivery primitives, direct-org tenancy shape, XOR ownership, and separate partner-wide SELECT policy are sound foundations. Subject binding, grant scope, dispatch/rejection semantics, and lifecycle handling need concrete decisions before this can reliably function as an anti-vishing security boundary.
