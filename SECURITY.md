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
- Network configuration backup, diff, and firmware posture workflows

## Out of Scope

- Vulnerabilities in third-party dependencies (report upstream, but let us know)
- Social engineering attacks
- Denial of service attacks against development/staging environments

## Disclosure Policy

We follow coordinated disclosure. Once a fix is released, we will:

1. Credit the reporter (unless anonymity is requested)
2. Publish a security advisory via GitHub Security Advisories
3. Release a patched version

## Network Config Governance

For network device configuration management features:

- Config snapshots are encrypted at rest before persistence.
- Diff views redact obvious shared secrets and credential tokens.
- High-risk config changes should be approval-gated before remediation actions.
- Firmware vulnerability indicators (CVE/EOL/version lag) should be treated as security posture inputs, not standalone exploit confirmation.

Thank you for helping keep Breeze and its users safe.
