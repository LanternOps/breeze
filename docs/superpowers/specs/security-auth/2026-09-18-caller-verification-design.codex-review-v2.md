# Codex (gpt-6-astra, xhigh) second-pass review of caller-verification spec v2 — 2026-09-19

Re-reviewed v2 and the cited implementation paths. No files were modified.

The 18 prior findings:

1. **Partially** — D11 establishes tier-3 bindings, but an unrelated, unbound workstation session still earns tier 2 and satisfies the default M365 gate.
2. **Partially** — OID bindings and alias checks are specified, but the cited [importer accepts uploaded identifiers](apps/api/src/services/contacts/import.ts:351), and the existing [Graph projection omits `proxyAddresses`](packages/shared/src/m365/readActions.ts:27); both need explicit changes.
3. **Partially** — OID pinning addresses UPN reassignment, but [connection IDs survive tenant changes](apps/api/src/routes/m365.ts:166); dispatch must also validate the pinned tenant.
4. **Resolved** — D12 supplies destination-specific provenance, distinguishes human/import/AI sources, and conservatively treats historical destinations as unestablished.
5. **Partially** — Technician/action binding and single-use consumption are specified, but the proposed revalidation hook cannot share the existing release-CAS transaction; see N5.
6. **Resolved** — D2 and the revised script correctly describe request confirmation and explicitly acknowledge relay attacks.
7. **Partially** — Internal revocation, attempt locking, fences and durable fan-out are added, but fence reads remain unsynchronized with dispatch, and [`executing` precedes revalidation](apps/api/src/jobs/intentReleaseWorker.ts:904), so it does not mean “already dispatched.”
8. **Resolved** — All three backends are named, with behavioral tests requiring zero mutation calls on refusal.
9. **Partially** — Command creation before delivery fixes correlation, but HTTP needs the separate [registry allowlist](apps/api/src/routes/agents/commands.ts:747), and reconciliation must recover terminal commands whose verification handler never completed.
10. **Resolved** — Console-only scope, capability negotiation and explicit timeout refusal address the original RDS/old-helper assumptions; the new helper-selection issue is N8.
11. **Partially** — Org tightening is specified, but frozen tiers plus the [candidate filter](docs/superpowers/specs/security-auth/2026-09-18-caller-verification-design.md:332) do not enforce subsequently disabled methods or stricter destination establishment rules.
12. **Resolved** — Every authenticated operation now requires contact site reach, with independent device/ticket ownership and access checks.
13. **Resolved** — Renamed snapshot columns avoid the move walkers, and D13 explicitly requires device-move invalidation.
14. **Partially** — Merge classifications, policy conflicts and revocation are addressed, but the new binding constraints make the prescribed merge operation unsafe; see N9.
15. **Resolved** — Durable ticket snapshots preserve asynchronous correlation, and `require_ticket` explicitly applies at initiation with org/requester validation.
16. **Partially** — Requester-based and administrative disable address the operational requirement, but their authorization contracts conflict with grant/dispatch requirements; see N1–N2.
17. **Resolved** — W01–W04 remain dark, and W05 enables the server-controlled readiness flag after enforcement and rejection handling ship.
18. **Partially** — Permissions, export classifications and refusal adapters are named, but `XOR_OWNERSHIP_DUAL_AXIS_TABLES` is still omitted; [the SELECT coverage test enumerates that set](apps/api/src/__tests__/integration/rls-coverage.integration.test.ts:1617).

New findings introduced by v2:

**N1. Major — D14/D15: requester identity and affected-account identity are conflated.**

**Claim:** A verified manager can authorize disabling another person’s account.  
**Evidence:** [D15](docs/superpowers/specs/security-auth/2026-09-18-caller-verification-design.md:88) verifies the requester, but dispatch requires the mutation OID to match the grant’s sole subject binding. The initiation API has no separate target identity. Existing [disable handling](apps/api/src/services/aiToolsM365.ts:225) carries only the affected user. A manager’s grant therefore cannot satisfy the target-OID invariant.  
**Concrete change:** Persist separate verified-requester and authorized-target identities, bind the challenge to the exact target/action, and validate both through dispatch. Test manager-to-other-user success and target-substitution denial.

**N2. Major — Administrative disable: release-time authentication cannot prove fresh MFA.**

**Claim:** Administrative bypass requires the requester’s fresh MFA.  
**Evidence:** The [release context synthesizes `mfa: true`](apps/api/src/services/actionIntents/actorContext.ts:276). Existing [MFA enforcement](apps/api/src/middleware/auth.ts:911) checks a Boolean, without freshness, and passes when global 2FA is disabled. Meanwhile, [dispatch universally requires a consumed caller grant](docs/superpowers/specs/security-auth/2026-09-18-caller-verification-design.md:418), which administrative mode lacks.  
**Concrete change:** Define a durable administrative authorization alternative, bound to the interactive actor, intent, target, reason and actual MFA verification time. Specify maximum age and revocation checks in every backend; never derive this authorization from the reconstructed token.

**N3. Major — D11/data model: new references do not enforce tenant/contact consistency.**

**Claim:** Direct-org RLS and the contact composite FK preserve isolation across the new ledger.  
**Evidence:** [`subject_binding_id`, `destination_id` and `consumed_by_intent_id`](docs/superpowers/specs/security-auth/2026-09-18-caller-verification-design.md:110) reference IDs independently of the verification’s org/contact. An otherwise valid org-A row can therefore reference an org-B binding or destination. RLS on the owning row does not enforce that relationship. Existing [contact links use a composite contact/org FK](apps/api/src/db/schema/contacts.ts:125) for this reason.  
**Concrete change:** Use composite binding/destination references including contact and org, and an intent reference including org. Add cross-org and same-org/wrong-contact forge tests.

**N4. Major — D11: the canonical connection model cannot represent all supported backends.**

**Claim:** One `m365_connection_id` binding supports directory reads and all three mutation backends.  
**Evidence:** The [binding FK targets only `m365_connections`](docs/superpowers/specs/security-auth/2026-09-18-caller-verification-design.md:154), while Delegant uses [a separate connection table](apps/api/src/db/schema/delegant.ts:10). Control-plane reads/actions also use [distinct connection profiles](apps/api/src/db/schema/m365.ts:76), yet binding uniqueness permits only one row per org/tenant/OID and resolution requires connection equality.  
**Concrete change:** Separate canonical tenant/OID identity from typed backend connection references. Define and validate their trusted tenant relationship, with Delegant-only and multiple-profile tests.

**N5. Major — D13/Gate wiring: atomic release-and-consume cannot occur at the prescribed hook.**

**Claim:** Consumption occurs in the same transaction as the release CAS through `revalidateRelease`.  
**Evidence:** The worker [claims `executing` before revalidation](apps/api/src/jobs/intentReleaseWorker.ts:904). Inline release likewise [completes its claim](apps/api/src/services/aiAgentSdk.ts:1388) before [calling revalidation](apps/api/src/services/aiAgentSdk.ts:1455). Adding consumption inside that function cannot join the earlier transaction.  
**Concrete change:** Specify a shared transactional claim-and-consume operation for inline, worker and task-linked release, including rollback and same-intent idempotency. Alternatively, explicitly adopt post-claim consumption and document its failure semantics.

**N6. Major — D6: including defaults in strictest-wins prevents promised partner overrides.**

**Claim:** Partners may weaken defaults while org overrides only tighten them.  
**Evidence:** [D6](docs/superpowers/specs/security-auth/2026-09-18-caller-verification-design.md:79) includes defaults in the restrictive reduction. Consequently, `max(default tier 2, partner tier 0)` remains 2, and `min(default TTL 30, partner TTL 240)` remains 30. This contradicts the documented partner controls. Cross-technician permission and authorizer-role combination also lack explicit operators.  
**Concrete change:** Resolve the partner baseline with defaults only for missing values, then apply restrictive org overrides. Specify AND for cross-technician permission and intersection for authorizer roles.

**N7. Major — D15: site-primary contact metadata becomes org-wide disable authority.**

**Claim:** `is_primary` identifies an org authorizer.  
**Evidence:** [D15](docs/superpowers/specs/security-auth/2026-09-18-caller-verification-design.md:88) accepts `is_primary`, but the [existing schema explicitly defines it as the headline contact for an org **or site**](apps/api/src/db/schema/contacts.ts:59), with separate uniqueness rules. A site’s primary contact would acquire authority over unrelated accounts elsewhere in the org.  
**Concrete change:** Introduce explicit authorizer assignments with scope, or at minimum restrict the primary-contact shortcut to org-level contacts and define site-target restrictions. Test that site primacy alone cannot authorize org-wide disablement.

**N8. Major — D17/workstation implementation: helper selection can reject an updated Tauri installation.**

**Claim:** Resolve the username’s user helper, check `callerVerify`, and render the new Tauri window.  
**Evidence:** [`SessionForUser`](agent/internal/sessionbroker/broker.go:929) prefers the native `user` helper. Tauri authenticates as [`assist`](apps/helper/src-tauri/src/ipc/client.rs:147). With both connected, the proposed selection can choose the native helper lacking the newly added Tauri capability and return `helper_outdated`. Existing [consent selection explicitly prefers the appropriate UI helper](agent/internal/heartbeat/consent_gate.go:159).  
**Concrete change:** Select a capability-bearing assist helper within the authenticated principal’s console session, or implement the protocol/UI in native helpers too. Test simultaneous native and Tauri connections.

**N9. Major — D18: binding uniqueness conflicts with plain org repointing.**

**Claim:** Subject bindings can use `repoint` followed by a custom post-step.  
**Evidence:** [The new schema](docs/superpowers/specs/security-auth/2026-09-18-caller-verification-design.md:155) makes principals unique within an org. Two merging orgs can contain the same principal, so repointing raises a uniqueness violation before a post-step. The existing [registry makes `repoint` and `custom` alternatives](apps/api/src/services/orgMergeRegistry.ts:22), and [plain repoint performs only the update](apps/api/src/services/orgMerge.ts:709).  
**Concrete change:** Define a custom merge executor that revokes affected grants, resolves binding collisions without silently choosing a contact, and handles connection deletion/rebinding before moving rows. Test colliding principals and populated M365 connections.

**Verdict: rework.** V2 makes substantial progress, but default unbound-session acceptance, incomplete identity guarantees, and the new authorization/dispatch contradictions still prevent approval.
91,100
Re-reviewed v2 and the cited implementation paths. No files were modified.

The 18 prior findings:

1. **Partially** — D11 establishes tier-3 bindings, but an unrelated, unbound workstation session still earns tier 2 and satisfies the default M365 gate.
2. **Partially** — OID bindings and alias checks are specified, but the cited [importer accepts uploaded identifiers](apps/api/src/services/contacts/import.ts:351), and the existing [Graph projection omits `proxyAddresses`](packages/shared/src/m365/readActions.ts:27); both need explicit changes.
3. **Partially** — OID pinning addresses UPN reassignment, but [connection IDs survive tenant changes](apps/api/src/routes/m365.ts:166); dispatch must also validate the pinned tenant.
4. **Resolved** — D12 supplies destination-specific provenance, distinguishes human/import/AI sources, and conservatively treats historical destinations as unestablished.
5. **Partially** — Technician/action binding and single-use consumption are specified, but the proposed revalidation hook cannot share the existing release-CAS transaction; see N5.
6. **Resolved** — D2 and the revised script correctly describe request confirmation and explicitly acknowledge relay attacks.
7. **Partially** — Internal revocation, attempt locking, fences and durable fan-out are added, but fence reads remain unsynchronized with dispatch, and [`executing` precedes revalidation](apps/api/src/jobs/intentReleaseWorker.ts:904), so it does not mean “already dispatched.”
8. **Resolved** — All three backends are named, with behavioral tests requiring zero mutation calls on refusal.
9. **Partially** — Command creation before delivery fixes correlation, but HTTP needs the separate [registry allowlist](apps/api/src/routes/agents/commands.ts:747), and reconciliation must recover terminal commands whose verification handler never completed.
10. **Resolved** — Console-only scope, capability negotiation and explicit timeout refusal address the original RDS/old-helper assumptions; the new helper-selection issue is N8.
11. **Partially** — Org tightening is specified, but frozen tiers plus the [candidate filter](docs/superpowers/specs/security-auth/2026-09-18-caller-verification-design.md:332) do not enforce subsequently disabled methods or stricter destination establishment rules.
12. **Resolved** — Every authenticated operation now requires contact site reach, with independent device/ticket ownership and access checks.
13. **Resolved** — Renamed snapshot columns avoid the move walkers, and D13 explicitly requires device-move invalidation.
14. **Partially** — Merge classifications, policy conflicts and revocation are addressed, but the new binding constraints make the prescribed merge operation unsafe; see N9.
15. **Resolved** — Durable ticket snapshots preserve asynchronous correlation, and `require_ticket` explicitly applies at initiation with org/requester validation.
16. **Partially** — Requester-based and administrative disable address the operational requirement, but their authorization contracts conflict with grant/dispatch requirements; see N1–N2.
17. **Resolved** — W01–W04 remain dark, and W05 enables the server-controlled readiness flag after enforcement and rejection handling ship.
18. **Partially** — Permissions, export classifications and refusal adapters are named, but `XOR_OWNERSHIP_DUAL_AXIS_TABLES` is still omitted; [the SELECT coverage test enumerates that set](apps/api/src/__tests__/integration/rls-coverage.integration.test.ts:1617).

New findings introduced by v2:

**N1. Major — D14/D15: requester identity and affected-account identity are conflated.**

**Claim:** A verified manager can authorize disabling another person’s account.  
**Evidence:** [D15](docs/superpowers/specs/security-auth/2026-09-18-caller-verification-design.md:88) verifies the requester, but dispatch requires the mutation OID to match the grant’s sole subject binding. The initiation API has no separate target identity. Existing [disable handling](apps/api/src/services/aiToolsM365.ts:225) carries only the affected user. A manager’s grant therefore cannot satisfy the target-OID invariant.  
**Concrete change:** Persist separate verified-requester and authorized-target identities, bind the challenge to the exact target/action, and validate both through dispatch. Test manager-to-other-user success and target-substitution denial.

**N2. Major — Administrative disable: release-time authentication cannot prove fresh MFA.**

**Claim:** Administrative bypass requires the requester’s fresh MFA.  
**Evidence:** The [release context synthesizes `mfa: true`](apps/api/src/services/actionIntents/actorContext.ts:276). Existing [MFA enforcement](apps/api/src/middleware/auth.ts:911) checks a Boolean, without freshness, and passes when global 2FA is disabled. Meanwhile, [dispatch universally requires a consumed caller grant](docs/superpowers/specs/security-auth/2026-09-18-caller-verification-design.md:418), which administrative mode lacks.  
**Concrete change:** Define a durable administrative authorization alternative, bound to the interactive actor, intent, target, reason and actual MFA verification time. Specify maximum age and revocation checks in every backend; never derive this authorization from the reconstructed token.

**N3. Major — D11/data model: new references do not enforce tenant/contact consistency.**

**Claim:** Direct-org RLS and the contact composite FK preserve isolation across the new ledger.  
**Evidence:** [`subject_binding_id`, `destination_id` and `consumed_by_intent_id`](docs/superpowers/specs/security-auth/2026-09-18-caller-verification-design.md:110) reference IDs independently of the verification’s org/contact. An otherwise valid org-A row can therefore reference an org-B binding or destination. RLS on the owning row does not enforce that relationship. Existing [contact links use a composite contact/org FK](apps/api/src/db/schema/contacts.ts:125) for this reason.  
**Concrete change:** Use composite binding/destination references including contact and org, and an intent reference including org. Add cross-org and same-org/wrong-contact forge tests.

**N4. Major — D11: the canonical connection model cannot represent all supported backends.**

**Claim:** One `m365_connection_id` binding supports directory reads and all three mutation backends.  
**Evidence:** The [binding FK targets only `m365_connections`](docs/superpowers/specs/security-auth/2026-09-18-caller-verification-design.md:154), while Delegant uses [a separate connection table](apps/api/src/db/schema/delegant.ts:10). Control-plane reads/actions also use [distinct connection profiles](apps/api/src/db/schema/m365.ts:76), yet binding uniqueness permits only one row per org/tenant/OID and resolution requires connection equality.  
**Concrete change:** Separate canonical tenant/OID identity from typed backend connection references. Define and validate their trusted tenant relationship, with Delegant-only and multiple-profile tests.

**N5. Major — D13/Gate wiring: atomic release-and-consume cannot occur at the prescribed hook.**

**Claim:** Consumption occurs in the same transaction as the release CAS through `revalidateRelease`.  
**Evidence:** The worker [claims `executing` before revalidation](apps/api/src/jobs/intentReleaseWorker.ts:904). Inline release likewise [completes its claim](apps/api/src/services/aiAgentSdk.ts:1388) before [calling revalidation](apps/api/src/services/aiAgentSdk.ts:1455). Adding consumption inside that function cannot join the earlier transaction.  
**Concrete change:** Specify a shared transactional claim-and-consume operation for inline, worker and task-linked release, including rollback and same-intent idempotency. Alternatively, explicitly adopt post-claim consumption and document its failure semantics.

**N6. Major — D6: including defaults in strictest-wins prevents promised partner overrides.**

**Claim:** Partners may weaken defaults while org overrides only tighten them.  
**Evidence:** [D6](docs/superpowers/specs/security-auth/2026-09-18-caller-verification-design.md:79) includes defaults in the restrictive reduction. Consequently, `max(default tier 2, partner tier 0)` remains 2, and `min(default TTL 30, partner TTL 240)` remains 30. This contradicts the documented partner controls. Cross-technician permission and authorizer-role combination also lack explicit operators.  
**Concrete change:** Resolve the partner baseline with defaults only for missing values, then apply restrictive org overrides. Specify AND for cross-technician permission and intersection for authorizer roles.

**N7. Major — D15: site-primary contact metadata becomes org-wide disable authority.**

**Claim:** `is_primary` identifies an org authorizer.  
**Evidence:** [D15](docs/superpowers/specs/security-auth/2026-09-18-caller-verification-design.md:88) accepts `is_primary`, but the [existing schema explicitly defines it as the headline contact for an org **or site**](apps/api/src/db/schema/contacts.ts:59), with separate uniqueness rules. A site’s primary contact would acquire authority over unrelated accounts elsewhere in the org.  
**Concrete change:** Introduce explicit authorizer assignments with scope, or at minimum restrict the primary-contact shortcut to org-level contacts and define site-target restrictions. Test that site primacy alone cannot authorize org-wide disablement.

**N8. Major — D17/workstation implementation: helper selection can reject an updated Tauri installation.**

**Claim:** Resolve the username’s user helper, check `callerVerify`, and render the new Tauri window.  
**Evidence:** [`SessionForUser`](agent/internal/sessionbroker/broker.go:929) prefers the native `user` helper. Tauri authenticates as [`assist`](apps/helper/src-tauri/src/ipc/client.rs:147). With both connected, the proposed selection can choose the native helper lacking the newly added Tauri capability and return `helper_outdated`. Existing [consent selection explicitly prefers the appropriate UI helper](agent/internal/heartbeat/consent_gate.go:159).  
**Concrete change:** Select a capability-bearing assist helper within the authenticated principal’s console session, or implement the protocol/UI in native helpers too. Test simultaneous native and Tauri connections.

**N9. Major — D18: binding uniqueness conflicts with plain org repointing.**

**Claim:** Subject bindings can use `repoint` followed by a custom post-step.  
**Evidence:** [The new schema](docs/superpowers/specs/security-auth/2026-09-18-caller-verification-design.md:155) makes principals unique within an org. Two merging orgs can contain the same principal, so repointing raises a uniqueness violation before a post-step. The existing [registry makes `repoint` and `custom` alternatives](apps/api/src/services/orgMergeRegistry.ts:22), and [plain repoint performs only the update](apps/api/src/services/orgMerge.ts:709).  
**Concrete change:** Define a custom merge executor that revokes affected grants, resolves binding collisions without silently choosing a contact, and handles connection deletion/rebinding before moving rows. Test colliding principals and populated M365 connections.

**Verdict: rework.** V2 makes substantial progress, but default unbound-session acceptance, incomplete identity guarantees, and the new authorization/dispatch contradictions still prevent approval.
