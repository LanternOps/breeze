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

## Where untrusted input enters

1. **Unauthenticated HTTP/WebSocket to the API**: login, SSO/OIDC callbacks, signup, password
   reset, agent enrollment, public webhooks (billing, email, integrations), the portal's
   anonymous surfaces. Treat every byte as attacker-controlled.
2. **Authenticated technician/customer traffic**: a legitimate user of one partner or organization
   is an attacker against every other partner/organization, and a low-role user is an attacker
   against higher roles. Cross-tenant reads or writes are the most important class of bug.
3. **The agent connection**: an enrolled agent is semi-trusted. A compromised endpoint holds that
   agent's credentials; it must not be able to read or affect other devices, other organizations,
   or the server, and must not be able to impersonate another device.
4. **Device-reported data**: inventory, logs, script output, file listings, process lists,
   metrics, event logs. All of it is attacker-controlled (a hostile endpoint) and flows into the
   database, the UI, AI tooling, alerting, and reports. Stored XSS, injection into queries or
   shell commands, and resource exhaustion from oversized or malformed payloads are in scope.
5. **Third-party integrations**: Microsoft 365/Graph, PSA/ticketing, billing, email, SSO
   providers, EDR vendors. Data from them is untrusted; secrets for them must not leak.
6. **AI features**: chat and automation backed by an LLM with tool access. Prompt injection
   through device-reported data or ticket text that causes the model to invoke a privileged tool
   (run a script, change a monitor, read another tenant) is in scope and rated as the action it
   enables.
7. **Server-to-agent commands**: scripts, remote shell, file transfer, software installation,
   remote desktop (WebRTC), backup/restore, patching. On the agent side, the server is trusted,
   but anything that lets a *local* unprivileged user on the endpoint reach the agent's
   privileges (IPC, named pipes/sockets, file permissions, temp files, update/install paths,
   helper process boundaries) is in scope.
8. **Self-update and software distribution**: agent updates, installer packages, release
   artifacts. Supply-chain and verification bypasses are in scope.

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

- **Critical**: unauthenticated remote code execution on the API or the agent; any cross-tenant
  read or write (one partner or organization reaching another's data, devices, or actions);
  authentication or authorization bypass that yields admin or technician capability; agent
  impersonation or enrollment forgery; anything that lets the server or a web user execute
  code on a device they are not authorized to manage; agent-update / installer verification
  bypass; local privilege escalation on an endpoint via the agent or helper.
- **High**: post-authentication vulnerabilities confined to the attacker's own tenant that cross
  a role boundary or reach another user's session; stored XSS in the technician dashboard;
  SQL or command injection reachable by an authenticated user or by a hostile agent; secret or
  credential disclosure (integration tokens, API keys, agent keys); SSRF from the API into
  internal networks; memory-safety bugs in the agent reachable from the network or from
  device-reported data.
- **Medium**: denial of service against the API or an agent from authenticated or agent-level
  input; CSRF on state-changing endpoints; information disclosure without secrets; missing rate
  limits on sensitive flows; logic bugs that let a user exceed their tenant's quota or plan.
- **Low**: anything requiring an already-compromised administrator; hardening gaps with no
  demonstrated impact.

Prefer a reproducer that shows the boundary crossing (a request from tenant A that returns tenant
B's row; an agent-scoped token that reads another device) over a theoretical argument. For
agent findings, a Go test or a small program that demonstrates the bug on Linux is ideal; we can
confirm Windows/macOS behaviour ourselves.

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
