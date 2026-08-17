# Security Policy

## Supported Versions

Security fixes ship in the latest release only. Breeze does not backport patches to older
versions — if you self-host, **staying current is the patch strategy**.

| Version | Supported          |
|---------|--------------------|
| latest  | :white_check_mark: |
| older   | :x:                |

## How we disclose (for self-hosters)

If you self-host, this is the section that matters to you. Hosted (`eu.2breeze.app` /
`us.2breeze.app`) customers are patched by us on deploy; **self-hosted installs stay vulnerable
until you upgrade.**

**Watch these two places:**

1. **[GitHub Security Advisories](https://github.com/LanternOps/breeze/security/advisories)** — the
   authoritative record. Every Critical and High vulnerability gets an advisory with affected and
   patched version ranges, impact, and workarounds. Use *Watch → Custom → Security alerts* on this
   repo to be notified.
2. **Release notes** — each release separates security content into two sections:
   - `### Security — action required` — **upgrade promptly**; states the affected version range and
     what an attacker could actually do.
   - `### Security — hardening` — routine defense-in-depth, no urgency.

**Timing.** We publish advisories only *after* a fix has shipped and rolled out, so the details are
never public while users are unpatched. After that we aim to publish within **72 hours** (Critical)
or **7 days** (High) of rollout.

**CVEs.** Critical and High advisories get a CVE. Note that because Breeze is distributed as
container images and binaries rather than through a package ecosystem, automated scanners and
Dependabot generally will **not** alert you — please watch the advisories directly rather than
relying on tooling to tell you.

**Running an old version?** Check the advisories page against your deployed version
(`GET /health` reports it). Anything published with a patched version newer than yours applies to
you.

## Reporting a Vulnerability

**Please do NOT open a public issue for security vulnerabilities.**

Instead, please report them responsibly:

1. **Email**: [security@lanternops.io](mailto:security@lanternops.io)
2. **Subject**: `[SECURITY] Brief description`
3. **Include**:
   - Description of the vulnerability
   - Steps to reproduce
   - Potential impact
   - Suggested fix (if any)

## Response Timeline

- **Acknowledgment**: Within 48 hours
- **Initial assessment**: Within 5 business days
- **Fix or mitigation**: Dependent on severity, but we aim for:
  - Critical: 7 days
  - High: 14 days
  - Medium: 30 days
  - Low: Next release cycle

## Scope

The following are in scope:

- Breeze API server (`apps/api`)
- Breeze web dashboard (`apps/web`)
- Breeze agent (`agent/`)
- Authentication and authorization flows
- Multi-tenant data isolation
- Agent-to-server communication
- Incident response workflows (`/api/v1/incidents/*`)

## Incident Response Workflow Security

Incident response automation is treated as a high-sensitivity workflow:

- High-risk containment actions require explicit approval references.
- Incident, evidence, and containment state changes are audit logged.
- Incident events (`incident.created`, `incident.contained`, `incident.escalated`, `incident.closed`) are emitted for downstream governance and monitoring.
- Evidence records include chain-of-custody metadata and integrity hash support.
- Incident data is tenant isolated with row-level security policies.

## Out of Scope

- Vulnerabilities in third-party dependencies (report upstream, but let us know)
- Social engineering attacks
- Denial of service attacks against development/staging environments

## Disclosure Policy

We follow coordinated disclosure. Once a fix is released, we will:

1. Credit the reporter (unless anonymity is requested)
2. Publish a security advisory via GitHub Security Advisories
3. Release a patched version

Thank you for helping keep Breeze and its users safe.

## Sensitive Data Discovery Safeguards

Sensitive data discovery (`/api/v1/sensitive-data/*`) is designed to avoid secret exfiltration:

- Agent scan results return metadata only (`filePath`, `patternId`, `matchCount`, classification/risk).
- Raw matched values are not stored in API responses, event payloads, or finding records.
- Findings are tenant-scoped with row-level security policies.
- Destructive remediation (`encrypt`, `quarantine`, `secure_delete`) requires explicit confirmation in API workflows.
- Compliance events emitted:
  - `compliance.sensitive_data_found`
  - `compliance.credential_exposed`
  - `compliance.sensitive_data_remediated`
