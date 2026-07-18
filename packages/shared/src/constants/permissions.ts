// Canonical permission registry — the single source of truth for resource:action
// grants. Shared so the API (requirePermission, role seeding) and the web UI
// (permission-aware nav/action gating) type their permission references against
// the same closed set. The API re-exports this as `PERMISSIONS` from
// `services/permissions.ts`; the web derives `PermissionGrant`/`PermissionResource`/
// `PermissionAction` for its gate literals.
//
// Adding a permission: add it here (and to DEFAULT_PERMISSIONS in the API seed +
// a migration that inserts the row). A typo'd resource/action in any gate then
// fails to compile instead of silently never matching.
//
// NB: named PERMISSION_GRANTS (not PERMISSIONS) to avoid colliding with the
// older nested PERMISSIONS constant in this package.
export const PERMISSION_GRANTS = {
  // Backup / recovery
  BACKUP_READ: { resource: 'backup', action: 'read' },
  BACKUP_WRITE: { resource: 'backup', action: 'write' },

  // Devices
  DEVICES_READ: { resource: 'devices', action: 'read' },
  DEVICES_WRITE: { resource: 'devices', action: 'write' },
  DEVICES_DELETE: { resource: 'devices', action: 'delete' },
  DEVICES_EXECUTE: { resource: 'devices', action: 'execute' },

  // Network topology (discovery topology view + saved layout — #1728)
  TOPOLOGY_READ: { resource: 'topology', action: 'read' },
  TOPOLOGY_WRITE: { resource: 'topology', action: 'write' },

  // Scripts
  SCRIPTS_READ: { resource: 'scripts', action: 'read' },
  SCRIPTS_WRITE: { resource: 'scripts', action: 'write' },
  SCRIPTS_DELETE: { resource: 'scripts', action: 'delete' },
  SCRIPTS_EXECUTE: { resource: 'scripts', action: 'execute' },

  // Alerts
  ALERTS_READ: { resource: 'alerts', action: 'read' },
  ALERTS_WRITE: { resource: 'alerts', action: 'write' },
  ALERTS_ACKNOWLEDGE: { resource: 'alerts', action: 'acknowledge' },

  // Tickets
  TICKETS_READ: { resource: 'tickets', action: 'read' },
  TICKETS_WRITE: { resource: 'tickets', action: 'write' },
  TICKETS_MANAGE: { resource: 'tickets', action: 'manage' },

  // Microsoft 365 partner-global ticket mailbox administration
  TICKET_MAILBOX_READ: { resource: 'ticket_mailbox', action: 'read' },
  TICKET_MAILBOX_ADMIN: { resource: 'ticket_mailbox', action: 'admin' },

  // Catalog (billing/invoicing program)
  CATALOG_READ: { resource: 'catalog', action: 'read' },
  CATALOG_WRITE: { resource: 'catalog', action: 'write' },
  CATALOG_DELETE: { resource: 'catalog', action: 'delete' },

  // Invoices (billing/invoicing program — sub-project 2)
  INVOICES_READ: { resource: 'invoices', action: 'read' },
  INVOICES_WRITE: { resource: 'invoices', action: 'write' },
  INVOICES_SEND: { resource: 'invoices', action: 'send' },
  INVOICES_EXPORT: { resource: 'invoices', action: 'export' },

  // Contracts (recurring-contracts — sub-project 3)
  CONTRACTS_READ: { resource: 'contracts', action: 'read' },
  CONTRACTS_WRITE: { resource: 'contracts', action: 'write' },
  CONTRACTS_MANAGE: { resource: 'contracts', action: 'manage' },

  // Quotes / Proposals (billing program — sub-project 4)
  QUOTES_READ: { resource: 'quotes', action: 'read' },
  QUOTES_WRITE: { resource: 'quotes', action: 'write' },
  QUOTES_SEND: { resource: 'quotes', action: 'send' },

  // Time entries (ticketing Phase 3)
  TIME_ENTRIES_READ: { resource: 'time_entries', action: 'read' },
  TIME_ENTRIES_WRITE: { resource: 'time_entries', action: 'write' },

  // Users
  USERS_READ: { resource: 'users', action: 'read' },
  USERS_WRITE: { resource: 'users', action: 'write' },
  USERS_DELETE: { resource: 'users', action: 'delete' },
  USERS_INVITE: { resource: 'users', action: 'invite' },

  // Organizations
  ORGS_READ: { resource: 'organizations', action: 'read' },
  ORGS_WRITE: { resource: 'organizations', action: 'write' },
  ORGS_DELETE: { resource: 'organizations', action: 'delete' },

  // SSO administration: configure providers + manage verified domains. A
  // higher-trust capability than organizations:write (security review #2 H-2).
  SSO_ADMIN: { resource: 'sso', action: 'admin' },

  // Sites
  SITES_READ: { resource: 'sites', action: 'read' },
  SITES_WRITE: { resource: 'sites', action: 'write' },
  SITES_DELETE: { resource: 'sites', action: 'delete' },

  // Automations
  AUTOMATIONS_READ: { resource: 'automations', action: 'read' },
  AUTOMATIONS_WRITE: { resource: 'automations', action: 'write' },
  AUTOMATIONS_DELETE: { resource: 'automations', action: 'delete' },

  // Remote access
  REMOTE_ACCESS: { resource: 'remote', action: 'access' },

  // Audit
  AUDIT_READ: { resource: 'audit', action: 'read' },
  AUDIT_EXPORT: { resource: 'audit', action: 'export' },

  // Reports
  REPORTS_READ: { resource: 'reports', action: 'read' },
  REPORTS_WRITE: { resource: 'reports', action: 'write' },
  REPORTS_DELETE: { resource: 'reports', action: 'delete' },
  REPORTS_EXPORT: { resource: 'reports', action: 'export' },

  // Billing
  BILLING_MANAGE: { resource: 'billing', action: 'manage' },

  // Vulnerability management (BE-16) — risk-acceptance governance capability.
  // Gates accept-risk + reopen above devices:write so a default technician
  // cannot unilaterally waive a critical/KEV finding.
  VULN_RISK_ACCEPT: { resource: 'vulnerabilities', action: 'accept_risk' },

  // AI session audit (SR5-09) — read OTHER users' AI session history via the
  // admin dashboard. A dedicated, higher-trust capability: ordinary AI reads use
  // organizations:read and only ever return the caller's OWN sessions, so the
  // cross-user admin/audit surface must NOT be gated on organizations:read.
  AI_SESSIONS_READ_ALL: { resource: 'ai_sessions', action: 'read_all' },

  // Action intents / durable approvals — gates who may decide (approve/deny) a
  // pending action-intent approval, distinct from creating/reading intents.
  APPROVALS_DECIDE: { resource: 'approvals', action: 'decide' },

  // Admin
  ADMIN_ALL: { resource: '*', action: '*' },
} as const;

/** Union of the exact `{ resource, action }` literal pairs in the registry. */
export type PermissionGrant = (typeof PERMISSION_GRANTS)[keyof typeof PERMISSION_GRANTS];
/** Union of every known resource (includes the `*` wildcard). */
export type PermissionResource = PermissionGrant['resource'];
/** Union of every known action (includes the `*` wildcard). */
export type PermissionAction = PermissionGrant['action'];
