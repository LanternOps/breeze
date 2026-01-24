# Breeze RMM - UI URLs

Generated: 2026-01-14

## Public Pages (No Auth Required)
| URL | Description |
|-----|-------------|
| `/` | Home / Dashboard |
| `/login` | User login |
| `/register` | User registration |
| `/forgot-password` | Password recovery |
| `/reset-password` | Password reset |

## Devices
| URL | Description |
|-----|-------------|
| `/devices` | Device list |
| `/devices/[id]` | Device detail view |
| `/devices/compare` | Device comparison |
| `/devices/groups` | Device groups management |

## Scripts
| URL | Description |
|-----|-------------|
| `/scripts` | Scripts list |
| `/scripts/new` | Create new script |
| `/scripts/[id]` | Script detail/edit |
| `/scripts/[id]/executions` | Script execution history |

## Alerts
| URL | Description |
|-----|-------------|
| `/alerts` | Alerts dashboard |
| `/alerts/rules` | Alert rules list |
| `/alerts/rules/new` | Create alert rule |
| `/alerts/rules/[id]` | Edit alert rule |
| `/alerts/channels` | Notification channels |

## Remote Access
| URL | Description |
|-----|-------------|
| `/remote` | Remote access overview |
| `/remote/sessions` | Remote sessions list |
| `/remote/terminal/[deviceId]` | Terminal session |
| `/remote/files/[deviceId]` | File browser |
| `/remote/tools` | Remote tools |

## Automations
| URL | Description |
|-----|-------------|
| `/automations` | Automations list |
| `/automations/new` | Create automation |
| `/automations/[id]` | Edit automation |

## Policies
| URL | Description |
|-----|-------------|
| `/policies` | Policies list |
| `/policies/new` | Create policy |
| `/policies/[id]` | Edit policy |
| `/policies/compliance` | Policy compliance view |

## Reports
| URL | Description |
|-----|-------------|
| `/reports` | Reports list |
| `/reports/new` | Create report |
| `/reports/builder` | Report builder |
| `/reports/[id]/edit` | Edit report |

## Settings
| URL | Description |
|-----|-------------|
| `/settings` | Settings overview |
| `/settings/profile` | User profile |
| `/settings/organization` | Organization settings |
| `/settings/organizations` | Organizations list (multi-tenant) |
| `/settings/users` | User management |
| `/settings/roles` | Roles & permissions |
| `/settings/sites` | Sites management |
| `/settings/api-keys` | API key management |
| `/settings/sso` | SSO configuration |
| `/settings/access-reviews` | Access reviews |
| `/settings/webhooks` | Webhook configuration |
| `/settings/alert-templates/[id]` | Alert template editor |

## Settings - Integrations
| URL | Description |
|-----|-------------|
| `/settings/integrations/ticketing` | Ticketing integrations |
| `/settings/integrations/communication` | Communication integrations |
| `/settings/integrations/monitoring` | Monitoring integrations |
| `/settings/integrations/psa` | PSA integrations |

## Integrations (Top-Level)
| URL | Description |
|-----|-------------|
| `/integrations/webhooks` | Webhooks management |
| `/integrations/psa` | PSA integration |

## Other Features
| URL | Description |
|-----|-------------|
| `/profile` | User profile page |
| `/patches` | Patch management |
| `/discovery` | Network discovery |
| `/analytics` | Analytics dashboard |
| `/software` | Software inventory |
| `/backup` | Backup management |
| `/audit` | Audit logs |
| `/snmp` | SNMP management |
| `/compliance` | Compliance dashboard |
| `/security` | Security center |
| `/partner` | Partner portal |

---

## URL Parameters

- `[id]` - Resource UUID (e.g., `/scripts/550e8400-e29b-41d4-a716-446655440000`)
- `[deviceId]` - Device UUID for remote access

## Total Pages: 62
