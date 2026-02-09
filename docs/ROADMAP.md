# Breeze RMM — Roadmap

> Last Updated: 2026-02-08
> Brain Connector: See `docs/plans/brain-connector-roadmap.md` (separate track)
> Historical docs: See `docs/archive/` for superseded planning documents

---

## Current State Summary

**Backend (API + Schema)**: Feature-complete. 99 route files, 34+ schema tables covering devices, patches, backup, security, discovery, SNMP, AI, integrations, PSA, automation, policies, reports, analytics.

**Agent (Go)**: Feature-complete. Collectors, patching (apt/yum/homebrew/apple), remote desktop/terminal/file transfer, security (Defender/WSC), discovery (ARP/SNMP/ports), backup (S3/Azure/GCP/local), SNMP polling, script execution.

**Frontend**: Structurally complete but significant mock-data-to-API wiring gaps. Many components render demo data instead of API responses.

**Security**: Observability pipeline done (WSC, Defender, threat detection, scan/quarantine commands). Code review in progress (53 findings, ~40 remediated).

**Testing**: Route tests exist for high-risk domains. Agent unit tests sparse. E2E test framework exists (YAML-driven). Frontend test coverage minimal.

---

## Priority Tiers

| Tier | Criteria | Timeline |
|------|----------|----------|
| **P0 — Ship Blockers** | Must work correctly for any real deployment | Now |
| **P1 — Core Value** | Features users expect from an RMM on day one | Next |
| **P2 — Competitive** | NinjaOne parity gaps that matter for sales | After P1 |
| **P3 — Differentiators** | Brain connector, AI, features competitors don't have | Parallel track |
| **P4 — Future** | Nice-to-have, enterprise-only, or aspirational | Later |

---

## P0: Ship Blockers

These must be verified working end-to-end before any real deployment. The code exists but hasn't been validated with real data/devices in many cases.

### P0.1 UI → API Wiring Audit

The single biggest risk. Backend routes exist but many frontend components use hardcoded/mock data.

| Module | UI Components | API Routes | Wiring Status | Priority |
|--------|--------------|------------|---------------|----------|
| **Device details** | Tabs (hardware, software, patches, alerts, metrics) | `devices/:id/*` | Partial — verify each tab | P0 |
| **Patches** | PatchList, PatchApproval, PatchDeployment, PatchCompliance | `patches/*` | Needs full audit | P0 |
| **Discovery** | DiscoveryProfiles, ScanResults, AssetList, TopologyMap | `discovery/*` | Needs full audit | P0 |
| **Backup** | BackupDashboard, ConfigEditor, JobList, RestoreWizard | `backup/*` | Needs full audit | P0 |
| **Security** | SecurityDashboard, ThreatList, ScanManager | `security/*` | Mostly done (per tracker) | P0 |
| **Monitoring** | MonitorList, MonitorResults, AlertRules | `monitors/*` | Needs audit | P0 |
| **Analytics** | MetricsCharts, TrendData, OSDistribution | `analytics/*` | Needs audit | P1 |
| **Integrations** | WebhookList, PSAConnections, PluginManager | `integrations/*` | Needs audit | P1 |
| **Reports** | ReportBuilder, ReportPreview, ScheduledReports | `reports/*` | Needs audit | P1 |

**Action**: Systematic page-by-page walkthrough. For each page: does it fetch from API? Does it display real data? Do mutations work?

### P0.2 Code Review Findings

53 findings logged in `CODEBASE_REVIEW_TRACKER.md`. ~40 remediated. Remaining:

| Finding | Severity | Status |
|---------|----------|--------|
| F-003: Frontend API contract drift | High | Partially mitigated |
| Agent unit tests (A5) | Medium | TODO |
| WSC live validation (B5) | Medium | TODO |
| Rollout checklist (E4) | Medium | TODO |
| Cross-tenant data exposure audit (3.2) | High | Pending |

**Action**: Close all High-severity findings before deployment.

### P0.3 Database Migrations

Currently using `pnpm db:push` (Drizzle push). Production needs proper migration files.

- [ ] Generate migration files for current schema state
- [ ] Test migration up/down on clean database
- [ ] Migration runner for production deployments
- [ ] Seed data for default roles, permissions, alert templates

### P0.4 Environment & Deployment

- [ ] Production docker-compose with proper secrets management
- [ ] Health check endpoints for load balancer
- [ ] Graceful shutdown handling (API, agent connections)
- [ ] Log levels and structured logging for production
- [ ] Redis persistence configuration
- [ ] PostgreSQL backup/restore procedures
- [ ] Agent auto-update flow (updater module exists, needs testing)

### P0.5 Agent Installation Flow

Agent builds exist. Installation needs to be smooth:

- [ ] Verify Windows MSI/EXE installer works end-to-end
- [ ] Verify macOS PKG installer works end-to-end
- [ ] Verify Linux DEB/RPM installer works end-to-end
- [ ] Enrollment key generation → agent install → enrollment → first heartbeat flow
- [ ] Agent uninstall/cleanup
- [ ] Agent upgrade path (existing enrolled agents)

---

## P1: Core Value

Features that define the RMM experience. Backend mostly exists — focus is on UX polish and E2E validation.

### P1.1 Editor Pages

These are the primary content-creation UIs that users interact with daily:

| Editor | Path | Exists | Wired to API | Polish |
|--------|------|--------|-------------|--------|
| Script Editor | `/scripts/[id]` | Monaco editor exists | Partial | Needs parameter UI, version history, test execution |
| Policy Editor | `/policies/[id]` | Form exists | Partial | Needs rule builder, compliance preview, target scope |
| Automation Editor | `/automations/[id]` | Form exists | Partial | Needs trigger config, action sequencing, test run |
| Alert Template Editor | `/settings/alert-templates/[id]` | Form exists | Partial | Needs condition builder, threshold config, escalation |

### P1.2 Remote Access Polish

Core remote features work. Polish needed:

- [ ] Terminal session stability under network disruption
- [ ] Desktop streaming adaptive quality (backend exists, frontend controls?)
- [ ] File manager breadcrumb navigation and path handling
- [ ] Session recording playback (schema exists, encoding partial)
- [ ] Multi-monitor selection UI

### P1.3 Alert Experience

- [ ] Alert noise reduction (correlation rules work? UI shows grouped alerts?)
- [ ] Alert → investigation workflow (click alert → see device → take action)
- [ ] Notification delivery verification (Slack, email, webhook actually send?)
- [ ] Escalation policy testing (multi-tier actually escalates?)

### P1.4 Patch Management E2E

Backend and agent modules exist. Needs validation:

- [ ] Windows patch scan → available patches populated in UI
- [ ] Patch approval workflow (approve → deploy → verify → report)
- [ ] Scheduled patch deployment via maintenance window
- [ ] Patch rollback flow
- [ ] Compliance dashboard with real data
- [ ] macOS/Linux patch flows

### P1.5 Dashboard & Navigation

- [ ] Dashboard widgets load real data (device count, alert count, patch compliance)
- [ ] Global search / command palette (Cmd+K)
- [ ] Sidebar navigation reflects available features
- [ ] Notification center (in-app notifications)
- [ ] Dark/light mode toggle

---

## P2: Competitive (NinjaOne Parity Gaps)

Overall NinjaOne parity: ~85%. Key gaps below.

### P2.1 IT Documentation (43% parity)
- [ ] Knowledge base / wiki system
- [ ] Credential vault (encrypted, per-org, access-controlled)
- [ ] Custom documentation templates
- [ ] Asset documentation linking (device → related docs)
- [ ] Runbook storage and retrieval

### P2.2 Third-Party Patching (82% parity)
- [ ] Chocolatey package catalog (200+ Windows apps)
- [ ] Homebrew cask catalog (macOS apps)
- [ ] Auto-detection of third-party software needing updates
- [ ] Formal patch ring deployment (test → pilot → production)

### P2.3 Visual Workflow Builder
- [ ] Drag-drop automation builder (currently form-based only)
- [ ] Visual flow editor with node connections
- [ ] Conditional branching visualization
- [ ] Execution path highlighting

### P2.4 Backup Enhancements (71% parity)
- [ ] Bare metal recovery
- [ ] Microsoft 365 backup (Exchange, OneDrive, SharePoint)
- [ ] Google Workspace backup (Gmail, Drive)
- [ ] Self-service restore portal for end users

### P2.5 Mobile App (83% parity)
- [ ] iOS/Android app build verification
- [ ] Push notification delivery testing
- [ ] Remote actions from mobile
- [ ] Alert management from mobile

### P2.6 Third-Party AV Integration
- [ ] SentinelOne API integration
- [ ] Bitdefender API integration
- [ ] Webroot API integration
- [ ] Unified security dashboard across AV vendors

---

## P3: Differentiators (Brain Connector)

**See `docs/plans/brain-connector-roadmap.md` for detailed plan.**
**See `docs/plans/phase1-brain-connector-implementation.md` for Phase 1 implementation guide.**

This runs as a parallel track. Summary:

| Phase | Scope | Depends On |
|-------|-------|-----------|
| Brain Phase 1: Foundation | Tool catalog, risk engine, approvals, auth, events | P0 complete |
| Brain Phase 2: BYOK | Free-tier AI agent loop | Brain Phase 1 |
| Brain Phase 3: LanternOps RMM | Connection interface for commercial brain | Brain Phase 1 |
| Brain Phase 4: LanternOps Cloud | Commercial multi-agent orchestration | Brain Phase 3, separate repo |
| Brain Phase 5: Intelligence | Memory, cross-tenant, playbooks | Brain Phase 4 |
| Brain Phase 6: Polish | Token optimization, tech routing, client portal | Brain Phase 4 |

---

## P4: Future

### P4.1 Mobile Device Management (MDM)
- iOS/iPadOS management via Apple Push Notification Service
- Android Enterprise enrollment
- Configuration profiles
- Remote lock/wipe
- App deployment

### P4.2 Multi-Region
- Regional deployment support
- Data residency compliance
- Cross-region failover
- Edge caching for agent communication

### P4.3 Observability
- Log aggregation (ELK or Loki)
- Error tracking (Sentry integration)
- Distributed tracing (APM)
- Uptime monitoring

### P4.4 Advanced Security
- Full EDR capabilities
- CVE-based vulnerability scanning
- Hardware warranty tracking
- License management

---

## Execution Strategy

### Phase A: Stabilize (P0 items)
1. UI wiring audit — page-by-page verification
2. Close remaining code review findings
3. Database migration tooling
4. Production deployment configuration
5. Agent installation E2E verification

### Phase B: Polish (P1 items)
1. Editor pages (script, policy, automation, alert template)
2. Remote access UX polish
3. Alert experience end-to-end
4. Patch management E2E validation
5. Dashboard real data

### Phase C: Compete (P2 items)
1. IT documentation system
2. Third-party patch catalog
3. Visual workflow builder
4. Backup enhancements
5. Mobile app verification

### Phase D: Differentiate (P3 items — parallel)
Brain connector foundation → BYOK → LanternOps
(See `docs/plans/brain-connector-roadmap.md`)

---

## E2E Verification Status

"Code exists" ≠ "feature works."

| Category | Code Exists | Wired E2E | Verified Working | Confidence |
|----------|-------------|-----------|------------------|------------|
| Auth (login, MFA, SSO) | 100% | 100% | High | Tested |
| RBAC & Permissions | 100% | 95% | High | Tested |
| Device Monitoring | 100% | 90% | High | Agent verified |
| Script Execution | 100% | 90% | High | Agent verified |
| Terminal/Desktop | 100% | 85% | High | Known fixes applied |
| Alerting | 100% | 75% | Medium | Notification delivery? |
| Patching | 100% | 60% | Medium | Agent modules built, E2E? |
| Discovery | 100% | 70% | Medium | Fixed bugs, non-root limits |
| Security | 100% | 85% | Medium-High | Per tracker, mostly done |
| Backup | 100% | 50% | Low | Agent module built, UI wiring? |
| Integrations/PSA | 100% | 40% | Low | Schema+routes exist, UI? |
| Reports | 100% | 50% | Low | Builder exists, real data? |
| Analytics | 100% | 40% | Low | Schema exists, charts mock? |
| SNMP Monitoring | 100% | 60% | Medium | Agent poller built, UI? |
| AI/Brain | 100% | 80% | Medium-High | Chat works, tools work |

**Honest overall: ~65-70% verified working E2E** despite 100% code existing.

The gap is almost entirely **UI wiring** and **E2E validation**, not missing functionality.

---

## Related Documents

| Document | Purpose |
|----------|---------|
| `docs/CODEBASE_REVIEW_TRACKER.md` | Active code review findings (P0.2) |
| `docs/SECURITY_IMPLEMENTATION_TRACKER.md` | Security workstream status |
| `docs/plans/brain-connector-roadmap.md` | Brain connector detailed roadmap (P3) |
| `docs/plans/phase1-brain-connector-implementation.md` | Brain Phase 1 implementation guide |
| `docs/plans/brain-connector-deep-dive.md` | Architecture deep dive |
| `docs/plans/rmm-lanternops-architecture.md` | LanternOps integration design |
| `docs/archive/` | Superseded planning docs (Phases 1-8, Phase 9, Phase 11, etc.) |
