# Current methodology authority

Read `~/breeze-security/security-code-review-methodology.md` and
`~/breeze-security/security-review-playbook.md` (or the user's explicit private workspace
location). These are canonical. For fixes/disclosure also read
`private-remediation-workflow.md`; for runtime work read `security-test-environment.md`.
The historical method is preserved in the private repository's
`reference/security-review-skill/`; do not edit that snapshot or apply its exclusion list.

Do not revert to blanket DoS, rate-limit, log-spoofing or language-based exclusions.
Retain unresolved leads instead of discarding by confidence. Independent static
verification and bounded authorized runtime reproduction are distinct stages. A helper
name, missing WHERE, comment or framework default alone does not establish exploitability.

If the private workspace is unavailable, report the missing methodology and finish only
independent preparatory work (scope/checkout metadata); request its location/access before
a full review. Never publish private methodology or findings into the product repo as
a workaround. Local active skill alignment must remain uncommitted unless explicitly
approved for a public destination.
