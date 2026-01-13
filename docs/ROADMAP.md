# Breeze RMM - Development Roadmap

> Last Updated: 2026-01-13
> Progress: Phase 1 (95%) | Overall: ~15%

---

## Quick Status

| Phase | Name | Status | Progress |
|-------|------|--------|----------|
| 1 | Foundation | 🟡 In Progress | 95% |
| 2 | Agent Core | ⬜ Not Started | 0% |
| 3 | Device Management | ⬜ Not Started | 0% |
| 4 | Scripting | ⬜ Not Started | 0% |
| 5 | Alerting | ⬜ Not Started | 0% |
| 6 | Remote Access | ⬜ Not Started | 0% |
| 7 | Automation | ⬜ Not Started | 0% |
| 8 | Enterprise | ⬜ Not Started | 0% |

**Legend:** ✅ Complete | 🟡 In Progress | ⬜ Not Started | ❌ Blocked

---

## Phase 1: Foundation

### 1.1 Project Scaffolding ✅
- [x] Monorepo structure (Turborepo + pnpm workspaces)
- [x] Astro web app with React islands
- [x] Hono API server structure
- [x] Shared packages (types, validators, constants)
- [x] Docker Compose configuration (PostgreSQL, Redis, MinIO)
- [x] Development setup scripts

### 1.2 Database Schema ✅
- [x] Drizzle ORM setup
- [x] Core tables: partners, organizations, sites
- [x] User tables: users, partner_users, organization_users, roles
- [x] Device tables: devices, device_hardware, device_network, device_metrics, device_software
- [x] Scripting tables: scripts, script_executions
- [x] Automation tables: automations, automation_runs, policies, policy_compliance
- [x] Alert tables: alert_rules, alerts, notification_channels
- [x] Audit tables: audit_logs, sessions

### 1.3 Authentication ✅
- [x] Password hashing (Argon2id)
- [x] JWT access/refresh tokens (jose)
- [x] Login/logout endpoints
- [x] Registration endpoint
- [x] Password reset flow (forgot + reset)
- [x] MFA/TOTP setup and verification (otplib)
- [x] Recovery codes generation
- [x] Rate limiting (Redis sliding window)
- [x] Auth middleware with scope checking
- [x] Auth store (Zustand + persist)
- [x] Auth UI components (LoginForm, RegisterForm, MFASetupForm, etc.)
- [x] Auth pages (login, register, forgot-password, reset-password)

### 1.4 Basic RBAC ✅
- [x] Role schema (system, partner, organization scopes)
- [x] Permission schema (resource + action)
- [x] Permission checking middleware (requirePermission, requireOrgAccess, requireSiteAccess)
- [x] Permission constants and helpers (services/permissions.ts)
- [x] Database seed for default roles and permissions
- [ ] Role assignment UI (component ready, needs integration)
- [x] Permission guards on routes

### 1.5 Organization Management ✅
- [x] Partner CRUD API (GET/POST/PATCH/DELETE /partners)
- [x] Organization CRUD API (GET/POST/PATCH/DELETE /organizations)
- [x] Site CRUD API (GET/POST/PATCH/DELETE /sites)
- [x] Organization list component (OrganizationList.tsx)
- [x] Organization form component (OrganizationForm.tsx)
- [x] Site list component (SiteList.tsx)
- [x] Site form component (SiteForm.tsx)
- [ ] Partner/Org switcher UI (needs integration)
- [ ] Organization settings page (Astro page)
- [x] User invitation flow (API ready)

### 1.6 User Management ✅
- [x] User list/detail API (GET /users, GET /users/:id)
- [x] User CRUD operations (PATCH/DELETE /users/:id)
- [x] User invitation API (POST /users/invite)
- [x] Role assignment API (POST /users/:id/role, GET /roles)
- [x] User list component (UserList.tsx)
- [x] User invite form component (UserInviteForm.tsx)
- [x] Role selector component (RoleSelector.tsx)
- [ ] User profile page (Astro page)
- [ ] User settings (password change, MFA management)
- [ ] Avatar upload

---

## Phase 2: Agent Core

### 2.1 Go Agent Skeleton ⬜
- [ ] CLI structure (cobra)
- [ ] Configuration management (viper)
- [ ] Logging setup
- [ ] Build scripts (Makefile)
- [ ] Cross-platform builds (Windows, macOS, Linux)

### 2.2 Enrollment Flow ⬜
- [ ] Enrollment key generation (API)
- [ ] Agent enrollment endpoint
- [ ] Agent authentication token
- [ ] Initial device registration
- [ ] Enrollment UI (generate keys, show status)

### 2.3 Heartbeat System ⬜
- [ ] Agent heartbeat loop (configurable interval)
- [ ] Heartbeat API endpoint
- [ ] Command queue in heartbeat response
- [ ] Config updates via heartbeat
- [ ] Agent version checking
- [ ] Device online/offline status tracking

### 2.4 System Collectors ⬜
- [ ] Hardware info collector (gopsutil)
- [ ] Software inventory collector
- [ ] Network interface collector
- [ ] Real-time metrics collector (CPU, RAM, disk)
- [ ] Process list collector

### 2.5 Metrics Pipeline ⬜
- [ ] Metrics ingestion endpoint
- [ ] Time-series storage (partitioned tables)
- [ ] Metrics aggregation jobs
- [ ] Metrics retention policy

---

## Phase 3: Device Management

### 3.1 Device List & Details ⬜
- [ ] Device list API (paginated, filtered, sorted)
- [ ] Device detail API
- [ ] Device list page (table with search/filter)
- [ ] Device detail page (tabs: overview, hardware, software, metrics)
- [ ] Device status indicators

### 3.2 Device Groups ⬜
- [ ] Static device groups CRUD
- [ ] Dynamic groups (rule-based membership)
- [ ] Group membership management
- [ ] Bulk operations on groups

### 3.3 Inventory Views ⬜
- [ ] Hardware inventory page
- [ ] Software inventory page (searchable, sortable)
- [ ] Software version tracking
- [ ] Export to CSV/Excel

### 3.4 Real-time Dashboard ⬜
- [ ] Dashboard widgets (device count, status breakdown)
- [ ] Live metrics charts
- [ ] Recent alerts widget
- [ ] Activity feed
- [ ] Customizable dashboard layout

### 3.5 Device Actions ⬜
- [ ] Device rename/tag
- [ ] Device site reassignment
- [ ] Device decommission
- [ ] Pending reboot indicator
- [ ] Force check-in

---

## Phase 4: Scripting

### 4.1 Script Library ⬜
- [ ] Script CRUD API
- [ ] Script library page
- [ ] Script categories
- [ ] Built-in system scripts
- [ ] Script import/export

### 4.2 Script Editor ⬜
- [ ] Monaco editor integration
- [ ] Syntax highlighting (PowerShell, Bash, Python, CMD)
- [ ] Script parameters schema
- [ ] Script validation
- [ ] Version history

### 4.3 Script Execution ⬜
- [ ] Execute on single device
- [ ] Execute on device group
- [ ] Parameter input UI
- [ ] Execution scheduling
- [ ] Real-time output streaming

### 4.4 Execution Management ⬜
- [ ] Execution history (paginated, filtered)
- [ ] Execution detail view (output, timing)
- [ ] Cancel running execution
- [ ] Re-run previous execution
- [ ] Execution notifications

---

## Phase 5: Alerting

### 5.1 Alert Rules ⬜
- [ ] Alert rule CRUD API
- [ ] Rule builder UI (conditions, thresholds)
- [ ] Metric-based alerts
- [ ] Status alerts (offline detection)
- [ ] Software change alerts
- [ ] Custom metric alerts

### 5.2 Alert Processing ⬜
- [ ] Alert evaluation job (BullMQ)
- [ ] Alert creation/resolution logic
- [ ] Cooldown period handling
- [ ] Alert severity levels
- [ ] Alert suppression

### 5.3 Notifications ⬜
- [ ] Notification channel CRUD
- [ ] Email notifications
- [ ] Slack integration
- [ ] Microsoft Teams integration
- [ ] Webhook notifications
- [ ] PagerDuty integration

### 5.4 Alert UI ⬜
- [ ] Active alerts dashboard
- [ ] Alert detail page
- [ ] Acknowledge/resolve actions
- [ ] Alert history
- [ ] Alert statistics

### 5.5 Escalation ⬜
- [ ] Escalation policy CRUD
- [ ] Multi-tier escalation
- [ ] On-call schedules
- [ ] Escalation notifications

---

## Phase 6: Remote Access

### 6.1 WebRTC Infrastructure ⬜
- [ ] Signaling server (WebSocket)
- [ ] ICE candidate exchange
- [ ] TURN server setup (optional)
- [ ] Session management

### 6.2 Agent WebRTC ⬜
- [ ] pion/webrtc integration
- [ ] Terminal PTY (creack/pty)
- [ ] Desktop capture (cross-platform)
- [ ] Data channel handling

### 6.3 Web Terminal ⬜
- [ ] xterm.js integration
- [ ] Terminal session UI
- [ ] Session resize handling
- [ ] Copy/paste support
- [ ] Session recording (optional)

### 6.4 File Transfer ⬜
- [ ] File browser UI
- [ ] Upload to device
- [ ] Download from device
- [ ] Transfer progress
- [ ] Transfer history

### 6.5 Desktop Sharing ⬜
- [ ] Desktop view component
- [ ] Mouse/keyboard input
- [ ] Quality/bandwidth settings
- [ ] Multi-monitor support

---

## Phase 7: Automation

### 7.1 Automation Builder ⬜
- [ ] Automation CRUD API
- [ ] Visual workflow builder
- [ ] Trigger configuration
- [ ] Condition builder
- [ ] Action sequencing

### 7.2 Triggers ⬜
- [ ] Schedule triggers (cron)
- [ ] Event triggers (device.enrolled, alert.triggered, etc.)
- [ ] Webhook triggers
- [ ] Manual triggers

### 7.3 Workflow Engine ⬜
- [ ] Workflow execution job
- [ ] Action runners (script, notify, wait, condition)
- [ ] Error handling (stop/continue/notify)
- [ ] Parallel execution
- [ ] Execution logging

### 7.4 Policy Engine ⬜
- [ ] Policy CRUD API
- [ ] Desired state rules
- [ ] Compliance checking job
- [ ] Compliance dashboard
- [ ] Auto-remediation

### 7.5 Automation UI ⬜
- [ ] Automation list page
- [ ] Workflow editor
- [ ] Execution history
- [ ] Policy management page
- [ ] Compliance reports

---

## Phase 8: Enterprise

### 8.1 SSO Integration ⬜
- [ ] SAML 2.0 support
- [ ] OIDC support
- [ ] Azure AD integration
- [ ] Okta integration
- [ ] Google Workspace integration

### 8.2 Advanced RBAC ⬜
- [ ] Custom role creation
- [ ] Resource-level permissions
- [ ] Permission templates
- [ ] Role inheritance
- [ ] Access reviews

### 8.3 Audit & Compliance ⬜
- [ ] Comprehensive audit logging
- [ ] Audit log search/filter
- [ ] Audit log export (CSV, JSON)
- [ ] Log retention policies
- [ ] Integrity verification (checksums)

### 8.4 API Keys ⬜
- [ ] API key generation
- [ ] Scoped permissions
- [ ] Usage tracking
- [ ] Key rotation
- [ ] Rate limiting per key

### 8.5 Multi-Region ⬜
- [ ] Regional deployment support
- [ ] Data residency compliance
- [ ] Cross-region sync
- [ ] Regional failover

---

## Infrastructure & DevOps

### CI/CD ⬜
- [ ] GitHub Actions workflow
- [ ] Automated testing
- [ ] Build pipeline
- [ ] Deployment automation
- [ ] Release management

### Monitoring ⬜
- [ ] Application metrics (Prometheus)
- [ ] Log aggregation
- [ ] Error tracking (Sentry)
- [ ] Performance monitoring
- [ ] Uptime monitoring

### Documentation ⬜
- [ ] API documentation (OpenAPI/Swagger)
- [ ] User documentation
- [ ] Admin documentation
- [ ] Agent installation guides
- [ ] Developer documentation

---

## Recently Completed

### 2026-01-13 (Session 2)
- ✅ RBAC Permission System
  - Permission checking middleware (requirePermission, requireOrgAccess, requireSiteAccess)
  - Permission service with caching (services/permissions.ts)
  - Database seed for 6 default roles and all permissions
- ✅ Organization Management APIs
  - Partner CRUD with soft delete (routes/orgs.ts)
  - Organization CRUD scoped to partner
  - Site CRUD with access control
- ✅ User Management APIs
  - User list/detail endpoints (routes/users.ts)
  - User invitation with transaction support
  - Role assignment endpoints
- ✅ Settings UI Components (via Codex delegation)
  - OrganizationList.tsx, OrganizationForm.tsx
  - SiteList.tsx, SiteForm.tsx
  - UserList.tsx, UserInviteForm.tsx, RoleSelector.tsx
- ✅ TypeScript compilation verified

### 2026-01-13 (Session 1)
- ✅ Complete authentication system implementation
  - Backend: password.ts, jwt.ts, mfa.ts, session.ts, rate-limit.ts, redis.ts
  - Routes: auth.ts (login, logout, register, refresh, MFA, password reset)
  - Middleware: auth.ts (JWT verification, scope checking)
  - Frontend: Auth store, all auth components, auth pages
  - Verified TypeScript compilation

---

## Up Next (Priority Order)

1. **Astro Pages** - Wire settings components into pages (/settings/organizations, /settings/users)
2. **Partner/Org Switcher** - Context switching UI
3. **User Profile Page** - Password change, MFA management
4. **Go Agent Skeleton** - Start Phase 2 with agent foundation
5. **Enrollment Flow** - Connect agents to platform

---

## Notes

### Codex Delegation Strategy
Based on testing, delegate to Codex:
- Mechanical UI components (forms, lists, modals)
- Type definitions and validators
- Test boilerplate
- Data transformation utilities

Keep in Claude:
- Security-critical code (auth, encryption)
- Architecture decisions
- Complex business logic
- Integration work

### Performance Targets
- Support 10,000+ agents
- Sub-second dashboard load
- Real-time metrics (<5s delay)
- 99.9% uptime target
