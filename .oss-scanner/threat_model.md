# Threat model — Breeze RMM

Breeze is a Remote Monitoring and Management (RMM) platform for managed service providers (MSPs)
and internal IT teams. An MSP ("partner") manages many customer organizations; each organization
has sites, device groups, and devices; a Go agent runs on each managed device with administrative
privileges and executes what the server tells it to. Because the product is designed to run
arbitrary commands as root/SYSTEM on fleets of customer machines, the security of the control plane
and of the agent trust chain is the whole product.

Please read `SECURITY.md` at the repository root first: it is the public policy (scope, out of
scope, how we disclose, response timelines). This file adds what an automated auditor needs.

## What is in the tree

| Path | What it is | Trust position |
|---|---|---|
| `apps/api` | Hono/TypeScript HTTP + WebSocket API, BullMQ workers, Postgres (Drizzle) + Redis | The control plane. Highest value. |
| `agent/` | Go agent, runs on managed Windows/macOS/Linux endpoints as root/SYSTEM | Ships to customer machines. Highest value. |
| `apps/web` | Astro + React technician dashboard (static, talks to the API) | Client-side; XSS/CSRF matter |
| `apps/portal` | Customer-facing self-service portal (static) | Client-side, lower-privilege users |
| `apps/helper`, `apps/viewer` | Per-user desktop helper and remote-desktop viewer | Ship to customer/technician machines |
| `apps/m365-*-executor` | Isolated executors for Microsoft Graph calls | Network-isolated sidecars |
| `apps/*-addin`, `packages/office-addin-core` | Office add-ins | Client-side |
| `packages/shared` | Zod validators, shared types/utils used by API and clients | Input validation lives here |
| `packages/extension-*`, `ee/workspace` | Extension SDK and the first-party `workspace` extension compiled into the API | Runs in the API process when enabled |
| `apps/mobile`, `apps/docs`, `load-tests`, `e2e-tests`, `scripts/` | Mobile app, documentation site, tooling | Low priority / out of scope |

## Who the attackers are

Grade every finding by the weakest position from which it works:

1. **Anonymous network caller**: no credential. Login, SSO/OIDC callbacks, signup, password
   reset, agent enrollment, public webhooks (billing, email, integrations), public pay/quote/
   short links, and any route that acts on a tenant from a token in the URL.
2. **Capability-link holder**: someone holding one emailed or shared link (invoice pay link,
   verification link, portal invite). They must reach exactly the object the link names.
3. **Customer-side user**: an organization admin, a site-restricted or device-group-scoped
   technician, or a contact-scoped portal user. They must not reach another organization, nor
   anything above their own ceiling inside their tenant.
4. **Partner-side user or key**: an MSP technician, a partner API key, or a service-principal
   key. A partner sees many organizations; a *stolen* partner credential is the most damaging
   single asset in the system, so controls that bound what one credential can do fleet-wide
   (step-up authentication, second-person approval) are in scope.
5. **Third-party OAuth or MCP client**: an integration or AI client granted a scope. It must
   not exceed the scope the granting user could give, nor outlive that user's access.
6. **Compromised enrolled agent**: a hostile endpoint holding valid agent credentials. It must
   not read or affect other devices, other tenants, or the server; must not impersonate another
   device; and must not write outside its own storage area.
7. **Local unprivileged endpoint user**: a non-admin user on a managed machine. Anything that
   lets them reach the agent's root/SYSTEM privileges (IPC, local sockets or named pipes, file
   and directory permissions, installer/update paths, the per-user helper, the remote-desktop
   path) is in scope.
8. **Integration counterparty or mail sender**: a third-party service (Microsoft 365, PSA,
   billing, EDR, SSO provider) or an inbound email. Their data is untrusted and their credentials
   must not be redirected.
9. **Lower-trust data reaching the AI features**: device-reported text (hostnames, inventory,
   event logs, script output), ticket and mail bodies, Office documents. Prompt injection that
   causes the model to invoke a privileged tool (run a script, open a session, change a monitor,
   read another tenant) is rated as the action it enables.
10. **Release and distribution identities** (supply chain): a repository writer or automation
    token must not be able to ship a malicious or downgraded agent update, and an
    agent must not accept an update, server, or command it cannot authenticate.

## Attacker outcomes we care about most

These are the goals a finding should be mapped to. Any single finding that achieves one of them
end to end is Critical.

- A billing action completes without the step-up authentication the design requires.
- One stolen MSP account or key runs commands on every device it can see.
- A malicious or downgraded agent update reaches the fleet, or an agent trusts a server it
  should not.
- A compromised enrolled agent reaches another device or another tenant.
- A local unprivileged endpoint user becomes SYSTEM or root through the agent, helper, or a
  backup restore.
- A customer-side user reads or writes another tenant's data, or escapes their site/device-group/
  role ceiling inside their own tenant.
- A third-party OAuth/MCP client reaches a device action beyond its grant.
- Untrusted data steers the AI agent into a privileged tool.
- A remote-desktop or remote-shell session starts without the consent or the human approver the
  design requires.
- Backup tamper leads to a privileged restore, or backups are destroyed ahead of an attack.
- A server-side fetch reaches internal hosts, cloud metadata, or an attacker's listener (SSRF),
  or a stored credential is sent to an attacker-chosen destination.
- An anonymous caller causes a tenant action or cost, or resource exhaustion.
- Portal, ticket, or inbound-mail content leads to staff phishing or ticket takeover.
- A privileged action is approved without the second person or second factor the design requires.
- Revoked or reduced access keeps working somewhere.

## How to exercise it

- The image has the workspace installed and the API, workspace extension, and agent built.
  `apps/api/dist/index.cjs` is the server entrypoint; `agent/bin/breeze-agent` is the agent.
- Unit tests: `pnpm --filter @breeze/api exec vitest run <path-substring>` (the whole suite is
  large; narrow it), `pnpm --filter @breeze/shared exec vitest run`, and `cd agent && go test ./...`.
- Route handlers are under `apps/api/src/routes/`, mounted from `apps/api/src/index.ts`; schema is
  under `apps/api/src/db/schema/`; migrations are hand-written SQL in `apps/api/migrations/`.
- Tenant isolation is enforced by Postgres row-level security. The API connects as an
  unprivileged role and sets a per-request context; the contract and the helper names are
  documented in `docs/agents/tenancy-rls.md`. Code that bypasses that context, or a table that
  lacks the policies, is a finding even without a runnable end-to-end reproducer.
- Suites that need Postgres and Redis (RLS contract tests, integration tests) are described in
  `docs/agents/testing.md` and `docker-compose.test.yml`; they will not run in the offline image.

## How we rate severity

Severity is the *self-hoster's* exposure. Hosted tenants are patched on deploy; a self-hosted
install stays vulnerable until its operator upgrades, so grade for them.

- **Critical**: exploitable without insider access and yields unauthenticated remote code
  execution (API or agent), cross-tenant data access or action, authentication bypass, or
  fleet-wide agent compromise (including update/manifest verification bypass). Any end-to-end
  realization of an outcome in the list above.
- **High**: requires a credential, an adjacent network position, or insider access, but yields a
  tenant-boundary break, privilege escalation (role ceiling escape, local user to root/SYSTEM),
  or code execution on the agent or server. Also: stored XSS in the technician dashboard; SQL or
  command injection reachable by an authenticated user or a hostile agent; disclosure of
  secrets (integration tokens, API keys, agent or signing keys, recovery keys); SSRF into
  internal networks; memory-safety bugs in the agent reachable from the network or from
  device-reported data; a step-up or second-person control that can be skipped on a money or
  destructive-restore action.
- **Medium**: defense-in-depth gaps, audit or containment weaknesses, information disclosure
  without direct escalation, CSRF on state-changing endpoints, denial of service of the API or an
  agent from authenticated or agent-level input, missing rate limits on sensitive flows, quota or
  plan bypass within the attacker's own tenant.
- **Low**: best-practice hardening with no realistic attack, or anything requiring an already-
  compromised administrator or hosting operator.

Reachability moves severity more than defect class: the same defect is graded by the weakest
position from which an attacker can actually trigger it. When severity depends on deployment or configuration, say "<base>, <raised> if <fact>" rather
than picking one silently.

Prefer a reproducer that shows the boundary crossing (a request from tenant A that returns tenant
B's row; an agent-scoped token that reads another device) over a theoretical argument. For agent
findings, a Go test or a small program that demonstrates the bug on Linux is ideal; we can confirm
Windows/macOS behaviour ourselves.

## Reports and patches

- One vulnerability per report. Say which component, which entry point, the minimal request or
  input, and the observed versus expected behaviour.
- A proposed patch is welcome; keep it minimal and in the style of the surrounding code. For the
  API, include or sketch a regression test (Vitest). For the agent, a Go test.
- Do not include real customer data, hostnames, or infrastructure details in reports.

## Out of scope / leave alone

- Vulnerabilities whose root cause is solely in a third-party dependency (tell us, but report
  upstream). Dependency version advisories alone are not findings.
- `apps/docs`, `apps/mobile`, `load-tests`, `e2e-tests`, `scripts/`, and anything under
  `internal/` or `docs/`.
- Denial of service that only affects development or staging tooling (docker-compose files,
  dev scripts, test fixtures).
- Findings that require a compromised Breeze operator (the hosting provider) rather than a
  compromised tenant, endpoint, or user.
- Intentional behaviour: the agent runs scripts and commands as root/SYSTEM when told to by an
  authorized technician. That is the product, not a bug. The bug is when an *unauthorized* party
  can cause it.
