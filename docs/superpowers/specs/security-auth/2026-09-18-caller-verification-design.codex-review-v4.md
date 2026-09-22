# Codex (gpt-6-astra, xhigh) fourth-pass review of caller-verification spec v4 — 2026-09-19

**Verdict: rework.** Three items are resolved; four remain partially resolved.

| Item | Status | One-line reason |
|---|---|---|
| P7 | Partially | The [target-only lock](docs/superpowers/specs/security-auth/2026-09-18-caller-verification-design.md:386) does not serialize requester A’s rejection for target C against A-authorized dispatch for target B; both paths must lock the shared requester identity. |
| P9 | Partially | The handler accepts late `not_me`, but [reconciliation remains pending-only](docs/superpowers/specs/security-auth/2026-09-18-caller-verification-design.md:353) and the [public POST still requires pending/unexpired](docs/superpowers/specs/security-auth/2026-09-18-caller-verification-design.md:545), leaving rejection loss possible. |
| P16/N10 | Resolved | [D15](docs/superpowers/specs/security-auth/2026-09-18-caller-verification-design.md:88) defines an administrative branch with its own policy switch and eligibility checks, exempt from challenge-method and requester-binding requirements. |
| N2 | Partially | V4 omits `authEpoch`; the [actual grant fields](apps/api/src/services/mfaStepUpGrant.ts:47) contain no proof timestamp, [consumption returns only Boolean](apps/api/src/services/mfaStepUpGrant.ts:163), and release still ages `decided_at` rather than actual proof time. |
| N11 | Resolved | The non-FK intent snapshot plus independent `consumed_at` preserves consumption across merge, consistent with [action_intents remaining source-owned](apps/api/src/services/orgMergeRegistry.ts:203). |
| N12 | Partially | Deferral fixes merge ordering, but [the requester FK still specifies conflicting delete actions](docs/superpowers/specs/security-auth/2026-09-18-caller-verification-design.md:110), and [hard-deleting target B](apps/api/src/services/contacts/crud.ts:646) leaves requester A’s verification blocking B’s binding cascade. |
| N13 | Resolved | Default `admin` matches the supported [CONTACT_ROLES vocabulary](apps/api/src/services/contacts/types.ts:59). |

**New plan-writing blockers: none.** The remaining blockers above are continuations of previously reported items.

Static review; no files modified.
70,803
