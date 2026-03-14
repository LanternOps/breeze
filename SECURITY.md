# Security Policy

## Supported Versions

| Version | Supported          |
|---------|--------------------|
| latest  | :white_check_mark: |

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
