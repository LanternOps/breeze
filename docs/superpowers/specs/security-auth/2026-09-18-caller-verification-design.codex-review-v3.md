# Codex (gpt-6-astra, xhigh) third-pass review of caller-verification spec v3 — 2026-09-19

V3 resolves **15 of the 19 items; four remain partial**. I checked both prior reviews and the cited code. No files were modified; this was a static review.

| Item | Status | One-line reason |
|---|---|---|
| P1 | Resolved | D4’s authoritative release calculation assigns unbound workstations tier 1, below the default tier 2 requirement. |
| P2 | Resolved | Graph-backed binding provenance explicitly excludes uploaded identifiers, and W03 adds the missing `proxyAddresses` projection. |
| P3 | Resolved | Pinned tenant/OID and dispatch-time tenant equality address the [connection upsert that changes tenants without changing IDs](apps/api/src/routes/m365.ts:166). |
| P5 | Resolved | D13 explicitly adopts post-claim consumption, single-intent ownership, and failure semantics compatible with existing release ordering. |
| P7 | Partially | Revised incident wording is correct, but repeated fence reads still permit **check → rejection commits → Graph dispatch**; no serialized dispatch boundary is specified. |
| P9 | Partially | HTTP registration is covered, but replay after expiry cannot pass the [handler’s CAS](docs/superpowers/specs/security-auth/2026-09-18-caller-verification-design.md:339), while the expiry sweep excludes terminal commands—potentially losing a timely rejection. |
| P11 | Resolved | Release recomputes assurance using current methods, bindings, destination establishment and policy rather than trusting the frozen tier. |
| P14 | Resolved | Explicit merge classifications and custom collision handling address the prior finding; separate new FK lifecycle failures appear below. |
| P16 | Partially | Requester/target separation works conceptually, but administrative authorization still conflicts with the common grant contract; see N10. |
| P18 | Resolved | Both required allowlists are explicitly named, matching the test’s actual [XOR SELECT-coverage enumeration](apps/api/src/__tests__/integration/rls-coverage.integration.test.ts:1617). |
| N1 | Resolved | Separate requester/target bindings, target snapshots, challenge labels and authorization rechecks eliminate the identity conflation. |
| N2 | Partially | The [real step-up primitive](apps/api/src/services/mfaStepUpGrant.ts:63) binds session and epochs, but the durable row discards those bindings and proof time, preventing equivalent release-time revocation checks. |
| N3 | Resolved | Composite references enforce tenant/contact consistency, and [`action_intents_id_org_uq`](apps/api/src/db/schema/actionIntents.ts:437) exists as claimed. |
| N4 | Resolved | Canonical tenant/OID identity no longer depends on a connection FK; each backend supplies its own tenant for comparison. |
| N5 | Resolved | Post-claim consumption matches both the [worker](apps/api/src/jobs/intentReleaseWorker.ts:904) and [inline](apps/api/src/services/aiAgentSdk.ts:1388) paths, with explicit refusal and dispatch-failure outcomes. |
| N6 | Resolved | Partner baseline followed by org tightening fixes default precedence and specifies AND/intersection for previously ambiguous fields. |
| N7 | Resolved | Org-level scope and explicit roles replace site primacy as authority; the unsupported default role is a separate integration defect below. |
| N8 | Resolved | Explicit session-scoped Tauri selection matches the first branch of [`consentUISessionForTarget`](agent/internal/heartbeat/consent_gate.go:165), while deliberately excluding its native fallback. |
| N9 | Resolved | Active-only uniqueness plus revoking both colliding bindings before moving them fits the registry’s actual [`custom` kind](apps/api/src/services/orgMergeRegistry.ts:22). |

Four new plan-blocking findings follow, continuing the previous numbering.

**N10. Major — D15 / administrative disable: administrative rows cannot consistently pass the common gate.**

**Claim:** Consuming step-up creates an ordinary usable verification grant.

**Evidence:** Administration becomes a fifth method, but [`allowed_methods` still defaults to “all four”](docs/superpowers/specs/security-auth/2026-09-18-caller-verification-design.md:220), and excluded methods receive tier 0. The administrative endpoint supplies only a target contact, while [the schema says a null requester binding never satisfies M365](docs/superpowers/specs/security-auth/2026-09-18-caller-verification-design.md:111) and the common gate universally checks requester authorization.

**Concrete change:** Define an explicit administrative authorization variant: specify contact/requester fields, replace caller-identity checks with administrative eligibility checks, and state its method-policy defaults. Require a default-policy end-to-end administrative success test.

**N11. Major — D18 / consumed grants: verification repointing conflicts with immutable source-owned intents.**

**Claim:** Verification history moves to the surviving org while retaining its consumed-intent reference.

**Evidence:** V3 adds [(intent ID, org ID) as a composite FK](docs/superpowers/specs/security-auth/2026-09-18-caller-verification-design.md:140), but [`action_intents` explicitly remains under the losing org](apps/api/src/services/orgMergeRegistry.ts:194) because its org ID is immutable. Repointing any consumed verification therefore violates the FK, even if deferred.

**Concrete change:** Specify custom verification merge handling that preserves consumption history and safely detaches the source-intent reference before moving the row—or choose a coherent source-owned history model. Clearing the reference must never make the grant reusable. Add a consumed-grant merge fixture.

**N12. Major — Data model: the new composite FKs have incompatible merge and deletion behavior.**

**Claim:** The binding, destination and intent references support the stated lifecycle operations.

**Evidence:** Unlike the contact FK, [the new composite references](docs/superpowers/specs/security-auth/2026-09-18-caller-verification-design.md:110) omit deferrability, although [org merge moves related rows separately and relies on deferred constraints](apps/api/src/services/orgMerge.ts:1057). Bare `ON DELETE SET NULL` also clears mandatory owner columns; the existing schema documents [this exact `23502` failure](apps/api/src/db/schema/actionIntents.ts:440). Nulling the target binding additionally violates the required-target CHECK.

**Concrete change:** Make moving composite FKs `DEFERRABLE INITIALLY IMMEDIATE`; use column-specific nulling only where valid, and RESTRICT/soft deletion for required target bindings. Test referenced binding/intent deletion and populated verification merges.

**N13. Major — D15 / authorizer defaults: `it_admin` is not an assignable contact role.**

**Claim:** `{it_admin}` is an existing `contacts.roles` value that enables the default manager-authorizer flow.

**Evidence:** The [supported vocabulary contains `admin`, not `it_admin`](apps/api/src/services/contacts/types.ts:59), and [contact CRUD rejects unknown roles](apps/api/src/services/contacts/crud.ts:118). Consequently, normal contact creation cannot produce the specified default authorizer.

**Concrete change:** Select the supported `admin` role or explicitly include adding `it_admin` to validation and contact-editing workflows. Test assigning the default role through the normal API and authorizing another account’s disable.

**Verdict: rework.**
91,261
V3 resolves **15 of the 19 items; four remain partial**. I checked both prior reviews and the cited code. No files were modified; this was a static review.

| Item | Status | One-line reason |
|---|---|---|
| P1 | Resolved | D4’s authoritative release calculation assigns unbound workstations tier 1, below the default tier 2 requirement. |
| P2 | Resolved | Graph-backed binding provenance explicitly excludes uploaded identifiers, and W03 adds the missing `proxyAddresses` projection. |
| P3 | Resolved | Pinned tenant/OID and dispatch-time tenant equality address the [connection upsert that changes tenants without changing IDs](apps/api/src/routes/m365.ts:166). |
| P5 | Resolved | D13 explicitly adopts post-claim consumption, single-intent ownership, and failure semantics compatible with existing release ordering. |
| P7 | Partially | Revised incident wording is correct, but repeated fence reads still permit **check → rejection commits → Graph dispatch**; no serialized dispatch boundary is specified. |
| P9 | Partially | HTTP registration is covered, but replay after expiry cannot pass the [handler’s CAS](docs/superpowers/specs/security-auth/2026-09-18-caller-verification-design.md:339), while the expiry sweep excludes terminal commands—potentially losing a timely rejection. |
| P11 | Resolved | Release recomputes assurance using current methods, bindings, destination establishment and policy rather than trusting the frozen tier. |
| P14 | Resolved | Explicit merge classifications and custom collision handling address the prior finding; separate new FK lifecycle failures appear below. |
| P16 | Partially | Requester/target separation works conceptually, but administrative authorization still conflicts with the common grant contract; see N10. |
| P18 | Resolved | Both required allowlists are explicitly named, matching the test’s actual [XOR SELECT-coverage enumeration](apps/api/src/__tests__/integration/rls-coverage.integration.test.ts:1617). |
| N1 | Resolved | Separate requester/target bindings, target snapshots, challenge labels and authorization rechecks eliminate the identity conflation. |
| N2 | Partially | The [real step-up primitive](apps/api/src/services/mfaStepUpGrant.ts:63) binds session and epochs, but the durable row discards those bindings and proof time, preventing equivalent release-time revocation checks. |
| N3 | Resolved | Composite references enforce tenant/contact consistency, and [`action_intents_id_org_uq`](apps/api/src/db/schema/actionIntents.ts:437) exists as claimed. |
| N4 | Resolved | Canonical tenant/OID identity no longer depends on a connection FK; each backend supplies its own tenant for comparison. |
| N5 | Resolved | Post-claim consumption matches both the [worker](apps/api/src/jobs/intentReleaseWorker.ts:904) and [inline](apps/api/src/services/aiAgentSdk.ts:1388) paths, with explicit refusal and dispatch-failure outcomes. |
| N6 | Resolved | Partner baseline followed by org tightening fixes default precedence and specifies AND/intersection for previously ambiguous fields. |
| N7 | Resolved | Org-level scope and explicit roles replace site primacy as authority; the unsupported default role is a separate integration defect below. |
| N8 | Resolved | Explicit session-scoped Tauri selection matches the first branch of [`consentUISessionForTarget`](agent/internal/heartbeat/consent_gate.go:165), while deliberately excluding its native fallback. |
| N9 | Resolved | Active-only uniqueness plus revoking both colliding bindings before moving them fits the registry’s actual [`custom` kind](apps/api/src/services/orgMergeRegistry.ts:22). |

Four new plan-blocking findings follow, continuing the previous numbering.

**N10. Major — D15 / administrative disable: administrative rows cannot consistently pass the common gate.**

**Claim:** Consuming step-up creates an ordinary usable verification grant.

**Evidence:** Administration becomes a fifth method, but [`allowed_methods` still defaults to “all four”](docs/superpowers/specs/security-auth/2026-09-18-caller-verification-design.md:220), and excluded methods receive tier 0. The administrative endpoint supplies only a target contact, while [the schema says a null requester binding never satisfies M365](docs/superpowers/specs/security-auth/2026-09-18-caller-verification-design.md:111) and the common gate universally checks requester authorization.

**Concrete change:** Define an explicit administrative authorization variant: specify contact/requester fields, replace caller-identity checks with administrative eligibility checks, and state its method-policy defaults. Require a default-policy end-to-end administrative success test.

**N11. Major — D18 / consumed grants: verification repointing conflicts with immutable source-owned intents.**

**Claim:** Verification history moves to the surviving org while retaining its consumed-intent reference.

**Evidence:** V3 adds [(intent ID, org ID) as a composite FK](docs/superpowers/specs/security-auth/2026-09-18-caller-verification-design.md:140), but [`action_intents` explicitly remains under the losing org](apps/api/src/services/orgMergeRegistry.ts:194) because its org ID is immutable. Repointing any consumed verification therefore violates the FK, even if deferred.

**Concrete change:** Specify custom verification merge handling that preserves consumption history and safely detaches the source-intent reference before moving the row—or choose a coherent source-owned history model. Clearing the reference must never make the grant reusable. Add a consumed-grant merge fixture.

**N12. Major — Data model: the new composite FKs have incompatible merge and deletion behavior.**

**Claim:** The binding, destination and intent references support the stated lifecycle operations.

**Evidence:** Unlike the contact FK, [the new composite references](docs/superpowers/specs/security-auth/2026-09-18-caller-verification-design.md:110) omit deferrability, although [org merge moves related rows separately and relies on deferred constraints](apps/api/src/services/orgMerge.ts:1057). Bare `ON DELETE SET NULL` also clears mandatory owner columns; the existing schema documents [this exact `23502` failure](apps/api/src/db/schema/actionIntents.ts:440). Nulling the target binding additionally violates the required-target CHECK.

**Concrete change:** Make moving composite FKs `DEFERRABLE INITIALLY IMMEDIATE`; use column-specific nulling only where valid, and RESTRICT/soft deletion for required target bindings. Test referenced binding/intent deletion and populated verification merges.

**N13. Major — D15 / authorizer defaults: `it_admin` is not an assignable contact role.**

**Claim:** `{it_admin}` is an existing `contacts.roles` value that enables the default manager-authorizer flow.

**Evidence:** The [supported vocabulary contains `admin`, not `it_admin`](apps/api/src/services/contacts/types.ts:59), and [contact CRUD rejects unknown roles](apps/api/src/services/contacts/crud.ts:118). Consequently, normal contact creation cannot produce the specified default authorizer.

**Concrete change:** Select the supported `admin` role or explicitly include adding `it_admin` to validation and contact-editing workflows. Test assigning the default role through the normal API and authorizing another account’s disable.

**Verdict: rework.**
