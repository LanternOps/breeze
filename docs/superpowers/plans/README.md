# Implementation plans

Plan documents — ready-to-implement work orders (goal, architecture, tech stack,
`- [ ]` task checklist, linked spec). They're organized two ways:

- **`open/`** — the **work queue / inbox** (13 plans). Work that isn't finished:
  ready-to-grab, shipped-but-broken, design-only, blocked, or roadmap — each
  status-tagged. See [`open/README.md`](open/README.md) and the
  [Coding with Claude Code](https://docs.breezermm.com/contributing/coding-with-claude-code/)
  guide. When a plan's PR merges it moves into its domain folder below.
- **Domain folders** — the **archive** of completed/shipped work (256 plans),
  sorted by area. A 2026-07-21 completion audit (code-graph + memory cross-check)
  verified these as shipped.

Design specs for these plans live under `../specs/` in the same domain folders.

## Domain folders

| Folder | Plans | Covers |
|---|---|---|
| `agent/` | 13 | Go agent lifecycle: watchdog, autostart, auth backoff, systemd, diagnostics, change detection |
| `ai-mcp/` | 26 | AI agent tools & site-scoping, MCP server/OAuth, action-intents, AI-for-Office, ML, M365 graph tools |
| `backup/` | 8 | Backup & recovery, certification, incremental, key escrow |
| `billing/` | 26 | Invoicing, quotes, contracts, catalog, payments, and distributor/accounting connectors (Pax8, TD SYNNEX, QuickBooks) |
| `installer-enrollment/` | 11 | MSI/CLI installers, enrollment tokens/keys, macOS installer app, installer downloads, device approval |
| `integrations/` | 21 | M365 control-plane & partner API, UniFi, EDR vendors, Weavestream, OneDrive helper |
| `misc/` | 6 | Cross-cutting or one-off work that fits no single domain |
| `monitoring/` | 16 | Network topology/monitors, discovery, connections, event-log forwarding, process drill-down, reliability scoring |
| `onboarding-signup/` | 7 | Bootstrap signup flow, MCP activation UX, signup monitoring, portal onboarding |
| `pam/` | 14 | Privileged Access Management: control plane, dialogs, ETW, signer pinning, actuators |
| `platform-ci/` | 6 | Framework upgrades, E2E migration, worktree test stack, test stability |
| `remote-desktop/` | 17 | WebRTC/VNC, capture/encoders, viewer app, session/consent, macOS/Linux remote desktop |
| `reports/` | 4 | Report system: PDF enhancements, downloadable runs, posture report |
| `security-auth/` | 21 | Security reviews, Authenticator, SSO/MFA, auth lifecycle, API-key principals, trusted-IP, abuse detection |
| `tenancy-rls/` | 5 | RLS coverage, org-scope normalization, partner-wide ownership, DB-context architecture |
| `ticketing/` | 26 | Native ticketing (SLA, time-tracking), email-to-ticket, intake forms, autoreply |
| `vuln-patch/` | 16 | Vulnerability management (BE-16), patching, update rings, software deployment |
| `web-ui/` | 13 | Web console UI: i18n, UI polish, error pages, CSP guard, file browser |

_Counts are a snapshot; they drift as plans move in/out of `open/`. The `notes/`
subfolder holds a few non-plan working docs and isn't a domain._

> Files are referenced by path from `CLAUDE.md`, code comments, and other docs.
> When adding a plan, drop it in `open/`; when moving a completed plan into a
> domain folder, update any references to its path.
