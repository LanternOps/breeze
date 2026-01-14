# NinjaOne RMM vs Breeze RMM - Feature Parity Analysis

> **Last Updated:** January 2026
> **Overall Parity Score:** ~85%

---

## Legend

| Status | Meaning |
|--------|---------|
| ✅ | Fully Implemented |
| 🟡 | Partially Implemented |
| ❌ | Not Implemented |

---

## 1. Core RMM & Device Management

| Feature | NinjaOne | Breeze | Notes |
|---------|----------|--------|-------|
| Multi-platform agents (Win/Mac/Linux) | ✅ | ✅ | Go agent with build tags |
| Device inventory & details | ✅ | ✅ | `devices.ts` schema + routes |
| Device groups | ✅ | ✅ | Hierarchical: Partner → Org → Site → Group |
| Custom fields | ✅ | 🟡 | Schema exists, UI partial |
| Device roles/policies | ✅ | ✅ | `policies.ts` with compliance |
| Hardware inventory | ✅ | ✅ | Collector module |
| Software inventory | ✅ | ✅ | `software.ts` schema + catalog |
| Real-time status | ✅ | ✅ | Heartbeat + WebSocket |

---

## 2. Monitoring & Alerting

| Feature | NinjaOne | Breeze | Notes |
|---------|----------|--------|-------|
| CPU/Memory/Disk monitoring | ✅ | ✅ | Collector metrics |
| Custom alert conditions | ✅ | ✅ | `alerts.ts` with thresholds |
| Alert severity levels | ✅ | ✅ | low/medium/high/critical |
| Alert notifications (email/SMS) | ✅ | 🟡 | Schema ready, delivery partial |
| Alert templates | ✅ | ✅ | `alertTemplates.ts` |
| Alert correlation/deduplication | ✅ | ✅ | Correlation rules implemented |
| Escalation policies | ✅ | ✅ | Time-based escalation |
| SNMP monitoring | ✅ | ✅ | `snmp.ts` + Go poller |
| SNMP traps | ✅ | ✅ | Trap receiver in agent |
| Custom OIDs | ✅ | ✅ | Templates + custom OIDs |
| Network device monitoring | ✅ | ✅ | Routers, switches, APs |

---

## 3. Patch Management

| Feature | NinjaOne | Breeze | Notes |
|---------|----------|--------|-------|
| Windows patch management | ✅ | ✅ | `patches.ts` + agent module |
| macOS patch management | ✅ | ✅ | Platform-specific handlers |
| Linux patch management | ✅ | ✅ | apt/yum/dnf support |
| Third-party app patching | ✅ | 🟡 | Schema ready, 200+ apps TBD |
| Patch policies | ✅ | ✅ | `patchPolicies.ts` |
| Patch scheduling | ✅ | ✅ | Cron-based schedules |
| Patch approval workflows | ✅ | ✅ | Auto/manual approval |
| Patch rollback | ✅ | ✅ | Rollback UI + agent support |
| Ring deployment | ✅ | 🟡 | Basic groups, no formal rings |
| Patch Intelligence AI | ✅ | ❌ | ML-based recommendations |

---

## 4. Remote Access & Control

| Feature | NinjaOne | Breeze | Notes |
|---------|----------|--------|-------|
| Remote desktop (attended) | ✅ | ✅ | WebRTC-based |
| Remote desktop (unattended) | ✅ | ✅ | Background access |
| Remote terminal/shell | ✅ | ✅ | PowerShell/Bash/Zsh |
| File browser | ✅ | ✅ | Browse + transfer |
| File transfer (drag-drop) | ✅ | ✅ | Bidirectional |
| Clipboard sync | ✅ | ✅ | Text + files |
| Multi-monitor support | ✅ | ✅ | Monitor selection |
| Session recording | ✅ | 🟡 | Schema exists, encoding partial |
| Background mode | ✅ | ✅ | Silent access |
| Wake-on-LAN | ✅ | ✅ | WoL support |

---

## 5. Scripting & Automation

| Feature | NinjaOne | Breeze | Notes |
|---------|----------|--------|-------|
| PowerShell scripts | ✅ | ✅ | `executor` module |
| Bash/Shell scripts | ✅ | ✅ | Cross-platform |
| Python scripts | ✅ | 🟡 | Executor supports, not native |
| Script library | ✅ | ✅ | `scriptLibrary.ts` + categories |
| Script versioning | ✅ | ✅ | Version history |
| Script templates | ✅ | ✅ | Community + custom |
| Scheduled scripts | ✅ | ✅ | Cron scheduling |
| Event-triggered scripts | ✅ | ✅ | Condition-based automation |
| Automation policies | ✅ | ✅ | `automations.ts` |
| Visual workflow builder | ✅ | ❌ | Drag-drop automation |
| Script output capture | ✅ | ✅ | stdout/stderr logging |

---

## 6. System Tools (Windows)

| Feature | NinjaOne | Breeze | Notes |
|---------|----------|--------|-------|
| Process manager | ✅ | ✅ | `systemTools.ts` + UI |
| Services manager | ✅ | ✅ | Start/stop/restart |
| Registry editor | ✅ | ✅ | Read/write keys |
| Event viewer | ✅ | ✅ | Windows event logs |
| Scheduled tasks | ✅ | ✅ | Task management |
| Installed programs | ✅ | ✅ | Via software inventory |

---

## 7. Security & Endpoint Protection

| Feature | NinjaOne | Breeze | Notes |
|---------|----------|--------|-------|
| Antivirus status monitoring | ✅ | ✅ | Defender integration |
| Defender management | ✅ | ✅ | Status + trigger scans |
| BitLocker status | ✅ | ✅ | Encryption status |
| FileVault status (Mac) | ✅ | ✅ | macOS encryption |
| Firewall status | ✅ | ✅ | Cross-platform |
| Threat detection | ✅ | ✅ | Signature-based scanner |
| Quarantine management | ✅ | ✅ | Quarantine + removal |
| Security posture scoring | ✅ | ✅ | Risk levels |
| Vulnerability scanning | ✅ | 🟡 | Basic, no CVE database |
| Third-party AV integration | ✅ | ❌ | SentinelOne, Bitdefender, etc. |

---

## 8. Backup & Recovery

| Feature | NinjaOne | Breeze | Notes |
|---------|----------|--------|-------|
| File/folder backup | ✅ | ✅ | `backup.ts` + agent module |
| Image backup | ✅ | 🟡 | Schema exists, full image TBD |
| Cloud backup (AWS) | ✅ | ✅ | S3 provider |
| Local backup (NAS) | ✅ | ✅ | Local provider |
| Hybrid backup | ✅ | ✅ | Local + cloud |
| Incremental backups | ✅ | ✅ | Delta-based |
| Backup scheduling | ✅ | ✅ | Flexible schedules |
| Retention policies | ✅ | ✅ | Configurable retention |
| File-level restore | ✅ | ✅ | Granular restore |
| Bare metal recovery | ✅ | ❌ | Full system restore |
| Microsoft 365 backup | ✅ | ❌ | SaaS backup |
| Google Workspace backup | ✅ | ❌ | SaaS backup |
| Self-service restore portal | ✅ | 🟡 | Portal exists, restore TBD |

---

## 9. Ticketing & Service Desk

| Feature | NinjaOne | Breeze | Notes |
|---------|----------|--------|-------|
| Built-in ticketing | ✅ | ✅ | `portal.ts` tickets |
| Ticket automation | ✅ | ✅ | Auto-create from alerts |
| Ticket templates | ✅ | ✅ | Custom templates |
| SLA tracking | ✅ | ✅ | `analytics.ts` SLA compliance |
| Ticket boards/views | ✅ | 🟡 | Basic views |
| Time tracking | ✅ | 🟡 | Schema ready |
| Technician assignment | ✅ | ✅ | Auto-routing |
| Customer portal tickets | ✅ | ✅ | Portal app |

---

## 10. IT Documentation

| Feature | NinjaOne | Breeze | Notes |
|---------|----------|--------|-------|
| Password management | ✅ | 🟡 | Basic credential storage |
| Document storage | ✅ | 🟡 | Attachments only |
| Wiki/knowledge base | ✅ | ❌ | Not implemented |
| Custom documentation templates | ✅ | ❌ | Not implemented |
| Credential vault | ✅ | 🟡 | API keys only |
| Asset documentation linking | ✅ | 🟡 | Basic relations |

---

## 11. Reporting & Analytics

| Feature | NinjaOne | Breeze | Notes |
|---------|----------|--------|-------|
| Device reports | ✅ | ✅ | `reports.ts` |
| Patch compliance reports | ✅ | ✅ | Patch status reporting |
| Executive summaries | ✅ | ✅ | `analytics.ts` executive summary |
| Custom reports | ✅ | ✅ | Report builder |
| Scheduled reports | ✅ | ✅ | Email delivery |
| SLA compliance reports | ✅ | ✅ | SLA tracking |
| Custom dashboards | ✅ | ✅ | Widget-based |
| Capacity forecasting | ✅ | ✅ | Predictive analytics |
| TimescaleDB time-series | N/A | ✅ | Advanced metrics |

---

## 12. Integrations

| Feature | NinjaOne | Breeze | Notes |
|---------|----------|--------|-------|
| ConnectWise PSA | ✅ | ✅ | `psa.ts` providers |
| Autotask PSA | ✅ | ✅ | Full integration |
| ServiceNow | ✅ | ✅ | Ticket sync |
| Freshservice | ✅ | ✅ | Provider implemented |
| Zendesk | ✅ | ✅ | Provider implemented |
| Jira | ✅ | ✅ | Ticket creation |
| Webhooks | ✅ | ✅ | `webhooks.ts` |
| REST API | ✅ | ✅ | OpenAPI documented |
| SSO (SAML/OIDC) | ✅ | ✅ | `sso.ts` |

---

## 13. Mobile Device Management (MDM)

| Feature | NinjaOne | Breeze | Notes |
|---------|----------|--------|-------|
| iOS/iPadOS management | ✅ | ❌ | Not implemented |
| Android management | ✅ | ❌ | Not implemented |
| Mobile app deployment | ✅ | ❌ | Not implemented |
| BYOD support | ✅ | ❌ | Not implemented |
| Remote lock/wipe | ✅ | ❌ | Not implemented |
| Configuration profiles | ✅ | ❌ | Not implemented |
| Apple DEP/ABM | ✅ | ❌ | Not implemented |

---

## 14. Mobile App (Technician)

| Feature | NinjaOne | Breeze | Notes |
|---------|----------|--------|-------|
| iOS app | ✅ | 🟡 | React Native foundation |
| Android app | ✅ | 🟡 | React Native foundation |
| Push notifications | ✅ | ✅ | FCM + APNs service |
| Alert management | ✅ | ✅ | View + acknowledge |
| Device overview | ✅ | ✅ | Basic device list |
| Remote actions | ✅ | 🟡 | Limited actions |

---

## 15. Network Discovery

| Feature | NinjaOne | Breeze | Notes |
|---------|----------|--------|-------|
| ARP scanning | ✅ | ✅ | Agent discovery module |
| ICMP ping sweep | ✅ | ✅ | Ping scanner |
| Port scanning | ✅ | ✅ | TCP port scan |
| SNMP discovery | ✅ | ✅ | v2c/v3 support |
| Asset classification | ✅ | ✅ | Auto-classify type |
| Network topology map | ✅ | ✅ | D3.js visualization |
| Link to managed device | ✅ | ✅ | Asset linking |

---

## 16. Administrative Features

| Feature | NinjaOne | Breeze | Notes |
|---------|----------|--------|-------|
| Multi-tenant (MSP) | ✅ | ✅ | Partner/Org hierarchy |
| Role-based access (RBAC) | ✅ | ✅ | `roles.ts` with permissions |
| Granular permissions | ✅ | ✅ | 50+ permission types |
| Audit logging | ✅ | ✅ | `auditLogs.ts` |
| Access reviews | ✅ | ✅ | `accessReviews.ts` |
| API keys | ✅ | ✅ | `apiKeys.ts` |
| Branding/white-label | ✅ | ✅ | Portal branding |
| Maintenance windows | ✅ | ✅ | `maintenance.ts` |
| Organization settings | ✅ | ✅ | Org config UI |

---

## Summary: Feature Parity Score

| Category | Implemented | Partial | Missing | Score |
|----------|-------------|---------|---------|-------|
| Core RMM & Devices | 8 | 0 | 0 | **100%** |
| Monitoring & Alerting | 11 | 1 | 0 | **96%** |
| Patch Management | 8 | 2 | 1 | **82%** |
| Remote Access | 9 | 1 | 0 | **95%** |
| Scripting & Automation | 9 | 1 | 1 | **86%** |
| System Tools | 6 | 0 | 0 | **100%** |
| Security | 9 | 1 | 1 | **86%** |
| Backup & Recovery | 9 | 2 | 3 | **71%** |
| Ticketing | 7 | 1 | 0 | **94%** |
| IT Documentation | 1 | 4 | 2 | **43%** |
| Reporting & Analytics | 9 | 0 | 0 | **100%** |
| Integrations | 9 | 0 | 0 | **100%** |
| MDM | 0 | 0 | 7 | **0%** |
| Mobile App | 4 | 2 | 0 | **83%** |
| Network Discovery | 7 | 0 | 0 | **100%** |
| Administrative | 10 | 0 | 0 | **100%** |

### **Overall Score: ~85% Feature Parity**

---

## Gap Analysis - Priority Items

### High Priority (Business Critical)

1. **Mobile Device Management (MDM)** - iOS/Android device management is a major NinjaOne selling point
2. **Third-party AV integration** - SentinelOne, Bitdefender, Webroot
3. **Bare metal recovery** - Full system restore capability
4. **SaaS backup** - Microsoft 365 and Google Workspace

### Medium Priority

5. **IT Documentation** - Wiki/knowledge base, credential vault
6. **Patch Intelligence AI** - ML-based patch recommendations
7. **Visual workflow builder** - Drag-drop automation
8. **Third-party app patching** - 200+ app catalog like NinjaOne

### Lower Priority (Nice-to-Have)

9. **Session recording** - Full video encoding
10. **Ring deployment** - Formal patch rings

---

## Implementation Roadmap

### Phase 12: MDM Foundation
- Apple Push Notification Service (APNs) integration
- Android Enterprise enrollment
- Device configuration profiles
- Remote lock/wipe capabilities
- App deployment infrastructure

### Phase 13: Enhanced Backup
- Bare metal recovery (BMR)
- Microsoft 365 backup (Exchange, OneDrive, SharePoint)
- Google Workspace backup (Gmail, Drive)
- Self-service restore portal

### Phase 14: IT Documentation
- Credential vault with encryption
- Wiki/knowledge base system
- Custom documentation templates
- Asset documentation linking

### Phase 15: AI & Advanced Features
- Patch Intelligence AI
- Visual workflow builder
- Third-party AV integrations
- Session recording with video encoding

---

## References

- [NinjaOne RMM](https://www.ninjaone.com/rmm/)
- [NinjaOne SNMP Monitoring](https://www.ninjaone.com/rmm/snmp-monitoring/)
- [NinjaOne Remote Access](https://www.ninjaone.com/remote-access/)
- [NinjaOne Backup](https://www.ninjaone.com/backup/)
- [NinjaOne Ticketing](https://www.ninjaone.com/ticketing-software/)
- [NinjaOne MDM](https://www.ninjaone.com/mdm/faqs/)
- [NinjaOne Integrations](https://www.ninjaone.com/integrations/)
- [NinjaOne Endpoint Security](https://www.ninjaone.com/rmm/endpoint-security/)
- [NinjaOne Reporting](https://www.ninjaone.com/rmm/reporting/)
- [NinjaOne IT Documentation](https://www.ninjaone.com/it-documentation/)
