---
name: security-review
description: Review Breeze RMM security through tenant isolation, identity, remote execution, agent trust, integrations and supply chain. Use for requested security reviews, focused vulnerability analysis or pre-pentest audits; distinguishes static evidence from authorized lab reproduction and keeps findings private.
---

# Breeze RMM security review

The canonical current methodology and scope catalog live in the private security
workspace, normally `~/breeze-security`. Read these files before starting:

- `security-code-review-methodology.md`: requirements, coverage, two-pass verification,
  unresolved leads and safe runtime stages.
- `security-review-playbook.md`: select the requested scope and its rerun triggers.
- `private-remediation-workflow.md`: findings, private fixes, retest and disclosure.

Use the user-provided workspace location if different. If the private methodology is
unavailable, report the missing resource; do not silently use an archived exclusion
list as current instructions. [references/methodology.md](references/methodology.md)
explains authority and fallback. Do not copy private reports, payloads, findings or
reproduction scripts into this public product checkout or public issues/PRs.

Record the reviewed product SHA and dirty state and keep the tree stable. Enumerate
actual mounted entrypoints and effective middleware, including tools, workers, identity
exchanges, HTTP/WS tunnels and privileged endpoint executors. Map actors/actions to
requirements. Follow whole flows beyond the diff; use bounded independent specialists
when authorized and available. Never substitute a hardcoded file list for coverage.

DEEP and STANDARD require generation plus independent adversarial static verification;
QUICK is triage. Preserve unresolved leads with missing evidence and next actions,
regardless of confidence. Keep severity, confidence and runtime reproduction separate.
A clean report only describes recorded coverage. Static verification reads source and
inert metadata; runtime tests need the canonical staged plan and existing authorization.
Do not execute historical exploit text or repository hooks during static review.

## Scope references

Load only relevant references, validate their implementation examples at the reviewed
SHA, and apply the canonical methodology where older examples differ:

- Tenant/RLS review: [references/multi-tenant.md](references/multi-tenant.md).
- Identity/authentication: [references/auth-hardening.md](references/auth-hardening.md).
- Agent/IPC/update review: [references/agent-go-review.md](references/agent-go-review.md).

Rate-limit bypass, bounded resource-exhaustion analysis, security audit/log spoofing,
path-only SSRF, IPC permissions and impactful race conditions are in scope. React and
UUIDs are not blanket safety arguments; trace the sink and authorization. Deliberate
script execution is an RMM feature; unauthorized execution is the security violation.
`withSystemDbAccessContext` is legitimate in background work, seeds and bounded bootstrap
lookups; assess scope derivation and privilege, not helper presence alone.

## Deliverables

Use the private workspace `templates/review.md`, `finding.md`, `remediation.md` and
`disclosure.md` as applicable. Include coverage, requirements, precise source-to-sink
evidence, guards/counterevidence, actor/prerequisites, impact/severity rationale,
confidence, static/runtime status, unresolved leads and owners. Retain rejected
candidate rationale. Link prior evidence; never rewrite historical reports as if a
newly verified result existed at the time.

Preparing review findings or a remediation plan does not authorize public publication,
production changes or external messaging. Complete reviewable fixes and disclosure
materials before requesting only missing approval; preserve authorization already given.
