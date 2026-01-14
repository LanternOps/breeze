# Breeze RMM - UI Completion Tasks

Complete list of UI work remaining, organized by priority and complexity.

---

## Phase 1: Editor Pages (High Priority)

### 1.1 Script Editor (`/scripts/[id]`)
- [ ] Monaco code editor with PowerShell/Bash syntax highlighting
- [ ] Script metadata form (name, description, category, OS targets)
- [ ] Parameter definition UI (add/edit/remove parameters)
- [ ] Parameter types (string, number, boolean, dropdown, file path)
- [ ] Test execution panel with device selector
- [ ] Execution output console
- [ ] Version history sidebar
- [ ] Save/Save As/Revert functionality
- [ ] Script templates/snippets library

### 1.2 Policy Editor (`/policies/[id]`)
- [ ] Policy metadata form (name, description, severity)
- [ ] Rule builder with conditions (AND/OR logic)
- [ ] Condition types (registry, file, service, process, WMI)
- [ ] Remediation action configuration
- [ ] Target scope selector (orgs, sites, device groups)
- [ ] Schedule configuration
- [ ] Preview/test against sample device
- [ ] Enable/disable toggle
- [ ] Compliance threshold settings

### 1.3 Automation Editor (`/automations/[id]`)
- [ ] Trigger configuration (schedule, event, alert, webhook)
- [ ] Condition builder (device filters, time windows)
- [ ] Action sequence builder (drag-drop reorder)
- [ ] Action types (run script, send alert, ticket, email, webhook)
- [ ] Variable/parameter passing between actions
- [ ] Error handling configuration (retry, fallback)
- [ ] Test run capability
- [ ] Execution history panel
- [ ] Enable/disable with schedule preview

### 1.4 Alert Template Editor (`/settings/alert-templates/[id]`)
- [ ] Template metadata (name, severity, category)
- [ ] Condition builder for alert triggers
- [ ] Threshold configuration (value, duration, frequency)
- [ ] Notification routing (email, SMS, webhook, ticket)
- [ ] Escalation rules (time-based, severity-based)
- [ ] Auto-remediation action linking
- [ ] Suppression rules
- [ ] Target scope assignment

---

## Phase 2: Replace Mock Data with API Integration

### 2.1 Patches Module
- [ ] Fetch available patches from API (`/api/patches`)
- [ ] Implement patch scan trigger
- [ ] Patch approval workflow with API
- [ ] Deployment job creation via API
- [ ] Real-time job status polling
- [ ] Device patch compliance from API
- [ ] Patch history/audit trail

### 2.2 Discovery Module
- [ ] Create discovery profile via API (`/api/discovery/profiles`)
- [ ] Trigger discovery scan via API
- [ ] Poll discovery job status
- [ ] Fetch discovered assets from API
- [ ] Link discovered asset to device via API
- [ ] Network topology data from API
- [ ] Discovery schedule management

### 2.3 Analytics Module
- [ ] Fetch device metrics from API (`/api/metrics`)
- [ ] Real performance trend data
- [ ] Dynamic OS distribution stats
- [ ] Alert statistics from API
- [ ] Compliance metrics from API
- [ ] Custom date range queries
- [ ] Export data functionality

### 2.4 Backup Module
- [ ] Fetch backup jobs from API (`/api/backup/jobs`)
- [ ] Fetch backup policies from API
- [ ] Create/edit backup configurations via API
- [ ] Trigger manual backup via API
- [ ] Restore wizard with API integration
- [ ] Backup storage statistics
- [ ] Snapshot browsing from API

---

## Phase 3: Integrations & Connectors

### 3.1 PSA Integration (`/settings/integrations/psa`)
- [ ] ConnectWise Manage configuration
- [ ] Datto Autotask configuration
- [ ] HaloPSA configuration
- [ ] Ticket sync settings
- [ ] Company/contact mapping
- [ ] Asset sync configuration
- [ ] Test connection button
- [ ] Sync status dashboard

### 3.2 Ticketing Integration (`/settings/integrations/ticketing`)
- [ ] Zendesk configuration
- [ ] Freshdesk configuration
- [ ] ServiceNow configuration
- [ ] Ticket field mapping
- [ ] Auto-ticket creation rules
- [ ] Bi-directional sync settings

### 3.3 Communication Integration (`/settings/integrations/communication`)
- [ ] Slack workspace connection
- [ ] Microsoft Teams connection
- [ ] Discord webhook configuration
- [ ] Channel/alert routing rules
- [ ] Message template customization
- [ ] Test notification button

### 3.4 Monitoring Integration (`/settings/integrations/monitoring`)
- [ ] Prometheus endpoint configuration
- [ ] Grafana dashboard linking
- [ ] PagerDuty configuration
- [ ] OpsGenie configuration
- [ ] Custom webhook endpoints

### 3.5 Webhooks (`/settings/webhooks`)
- [ ] Webhook list with status
- [ ] Create webhook form (URL, events, secret)
- [ ] Event type selector (device, alert, ticket, script)
- [ ] Payload template editor
- [ ] Test webhook button
- [ ] Delivery history log
- [ ] Retry failed deliveries
- [ ] Webhook authentication options

---

## Phase 4: Enhanced Device Views

### 4.1 Device Detail Enhancements (`/devices/[id]`)
- [ ] Hardware inventory tab (CPU, RAM, disks, NICs)
- [ ] Software inventory tab with versions
- [ ] Patch status tab
- [ ] Alert history tab
- [ ] Script execution history tab
- [ ] Performance graphs (24h, 7d, 30d)
- [ ] Event log viewer
- [ ] Network connections
- [ ] Installed services list
- [ ] Scheduled tasks list
- [ ] User sessions/logins

### 4.2 Device Comparison View
- [ ] Select multiple devices
- [ ] Side-by-side specs comparison
- [ ] Software diff view
- [ ] Patch status diff
- [ ] Configuration diff

### 4.3 Device Groups Management (`/devices/groups`)
- [ ] Group list with device counts
- [ ] Create/edit group form
- [ ] Dynamic group rules (auto-membership)
- [ ] Static group device assignment
- [ ] Bulk operations on groups
- [ ] Group-based policy assignment

---

## Phase 5: Reporting Enhancements

### 5.1 Report Builder (`/reports/builder`)
- [ ] Report type selector
- [ ] Data source configuration
- [ ] Column/field picker
- [ ] Filter builder
- [ ] Grouping/aggregation options
- [ ] Chart type selection
- [ ] Preview pane
- [ ] Schedule configuration
- [ ] Export format options (PDF, CSV, Excel)
- [ ] Email distribution list

### 5.2 Report Templates
- [ ] Executive summary template
- [ ] Device health template
- [ ] Patch compliance template
- [ ] Alert summary template
- [ ] Technician activity template
- [ ] SLA compliance template
- [ ] Billing/usage template
- [ ] Custom template builder

### 5.3 Scheduled Reports
- [ ] Schedule list view
- [ ] Create schedule form
- [ ] Recipient management
- [ ] Run history
- [ ] Pause/resume schedules

---

## Phase 6: Security & Compliance

### 6.1 Security Dashboard (`/security`)
- [ ] Security score overview
- [ ] Vulnerability summary
- [ ] Antivirus status across fleet
- [ ] Firewall status across fleet
- [ ] Encryption status (BitLocker/FileVault)
- [ ] Password policy compliance
- [ ] Admin account audit
- [ ] Security recommendations

### 6.2 Compliance Dashboard (`/compliance`)
- [ ] Compliance framework selector (CIS, NIST, HIPAA)
- [ ] Control checklist with status
- [ ] Evidence collection
- [ ] Remediation tracking
- [ ] Compliance trend over time
- [ ] Export compliance report

### 6.3 Access Reviews (`/settings/access-reviews`)
- [ ] Review campaign creation
- [ ] User access list for review
- [ ] Approve/revoke actions
- [ ] Review history
- [ ] Certification reports

---

## Phase 7: Mobile & Notifications

### 7.1 Mobile Push Configuration
- [ ] Push notification settings
- [ ] Device token management
- [ ] Notification categories
- [ ] Quiet hours configuration
- [ ] Per-user preferences

### 7.2 Notification Center
- [ ] In-app notification panel
- [ ] Notification history
- [ ] Mark read/unread
- [ ] Notification preferences
- [ ] Filter by type

---

## Phase 8: Multi-Tenant & Branding

### 8.1 Partner Portal (`/partner`)
- [ ] Customer list dashboard
- [ ] Customer health scores
- [ ] Cross-customer device view
- [ ] Billing summary
- [ ] White-label settings
- [ ] Customer onboarding wizard

### 8.2 Branding Editor (`/settings/branding`)
- [ ] Logo upload (light/dark)
- [ ] Primary/secondary colors
- [ ] Custom CSS injection
- [ ] Email template branding
- [ ] Portal branding
- [ ] Favicon upload
- [ ] Preview mode

---

## Phase 9: Quality of Life

### 9.1 Global Search
- [ ] Command palette (Cmd+K)
- [ ] Search across devices, scripts, alerts
- [ ] Recent items
- [ ] Quick actions
- [ ] Keyboard navigation

### 9.2 Dashboard Customization
- [ ] Widget library
- [ ] Drag-drop layout
- [ ] Widget resize
- [ ] Save custom dashboards
- [ ] Share dashboards
- [ ] Default dashboard per role

### 9.3 Bulk Operations
- [ ] Bulk device actions modal
- [ ] Progress tracking
- [ ] Failure handling
- [ ] Rollback capability
- [ ] Operation history

### 9.4 Keyboard Shortcuts
- [ ] Shortcut help modal
- [ ] Navigation shortcuts
- [ ] Action shortcuts
- [ ] Custom shortcut binding

---

## Estimated Effort Summary

| Phase | Items | Complexity |
|-------|-------|------------|
| Phase 1: Editor Pages | 4 editors | High |
| Phase 2: API Integration | 4 modules | Medium |
| Phase 3: Integrations | 5 areas | Medium-High |
| Phase 4: Device Views | 3 features | Medium |
| Phase 5: Reporting | 3 features | Medium |
| Phase 6: Security | 3 dashboards | Medium |
| Phase 7: Mobile/Notifications | 2 features | Low |
| Phase 8: Multi-Tenant | 2 features | Medium |
| Phase 9: Quality of Life | 4 features | Low-Medium |

---

## How to Use This List

Ask Claude to complete items like:

```
Complete Phase 1.1: Script Editor with all listed requirements
```

Or for smaller chunks:

```
Implement the Monaco code editor and parameter definition UI for the Script Editor
```

Or batch by complexity:

```
Complete all Phase 2 items (replace mock data with API integration)
```
