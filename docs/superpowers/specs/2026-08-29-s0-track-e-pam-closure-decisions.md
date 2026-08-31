---
tracking_issue: https://github.com/LanternOps/breeze/issues/4060
---

# S0 Track E PAM closure decisions

**Date:** 2026-08-29
**Decision owner:** Todd Hebebrand, S0 program owner
**Applies to:** RMM-QA-445 / Track E, candidate `a11d432a6e68288eceef050933483c231f5d40dc`, branch `fix/s0-pam-actuation-lifecycle`

This record closes the two decision gates left after the rc.3 exact-candidate
matrix. It does not authorize production deployment, hosted admission changes,
customer-device mutation, a canary, or rollout expansion.

## Decision 1: production cleanup SLO

Adopt **2 seconds p95 and 5 seconds maximum** as the PAM cleanup production
SLO. The measurement remains the Track E definition: durable endpoint cleanup
receipt through acceptance of the current-generation `cleaned` observation.

The rc.3 disposable signed-Windows matrix measured 21 accepted cleanup cases at
p95 442.75 ms and maximum 612.007 ms. Those results provide approximately 4.5x
p95 and 8x maximum margin. The cases included agent restart, both endpoint
reboot cases, and crash during cleanup.

The evidence is deliberately bounded: it is one endpoint pair on a lab LAN,
not a fleet measurement. Before any rollout expansion, the separately
authorized hosted 5-device and 25-device canaries must re-measure this SLO and
pass the adopted operational gates. The existing pause rule remains in force:
pause expansion on any cleanup timeout, foreign-scope rejection,
digest/identity equivocation, unverified state, legacy command claim, or
material queue backlog.

**Decision reference:**
`docs/superpowers/specs/2026-08-29-s0-track-e-pam-closure-decisions.md#decision-1-production-cleanup-slo`

## Decision 2: shipping entitlement disposition

Product records this disposition:

```ts
{
  kind: 'not_applicable',
  shippingSku: 'breeze-rmm v0.109 — PAM available on all plan tiers; not a separately entitled SKU',
  productDecisionRef: 'docs/superpowers/specs/2026-08-29-s0-track-e-pam-closure-decisions.md#decision-2-shipping-entitlement-disposition',
}
```

This is a product statement, not an inference from an absent caller. In v0.109,
PAM is available through configuration policy on every shipping plan tier and
is not separately entitled. Policy removal is already wired to durable PAM
cleanup with cause `policy_removed`; therefore no separate plan- or
billing-entitlement removal producer exists for this release.

This disposition **reopens immediately** if PAM becomes plan- or billing-gated.
The new producer must call `removePamEntitlement` inside its winning database
transaction and must be covered by the real-PostgreSQL transition contract
before that gated SKU ships.

## Evidence and non-claims

- Exact candidate: `a11d432a6e68288eceef050933483c231f5d40dc` (`v0.109.0-rc.3`).
- Core CI run `33231300371`: 41 successful jobs and the expected skipped Main Red Alert.
- Matrix: 25/25 executed, zero invariant failures, zero missing `received` receipts, two fixture organizations.
- Cleanup latency: 21 samples, p95 442.75 ms, maximum 612.007 ms.
- Branch HEAD at decision time is a documentation-only descendant of the exact candidate; the candidate-to-HEAD delta does not change a shipping artifact.
- No production deployment, hosted canary, customer mutation, or rollout is claimed.

With these two decisions recorded, every closure input named by Track E Task 8
Step 7 is present. RMM-QA-445 is exact-candidate verified and may leave
`fixed-unverified`; integration and rollout remain governed separately by the
stacked S0 merge order and explicit deployment authorization.
