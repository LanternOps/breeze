// OS Types
export const OS_TYPES = ['windows', 'macos', 'linux'] as const;

// Device Status
export const DEVICE_STATUSES = ['online', 'offline', 'maintenance', 'decommissioned'] as const;

// Alert Severities
export const ALERT_SEVERITIES = ['critical', 'high', 'medium', 'low', 'info'] as const;

// Alert Statuses
export const ALERT_STATUSES = ['active', 'acknowledged', 'resolved', 'suppressed'] as const;

// Script Languages
export const SCRIPT_LANGUAGES = ['powershell', 'bash', 'python', 'cmd'] as const;

// Script Run As
export const SCRIPT_RUN_AS = ['system', 'user', 'elevated'] as const;

// Execution Statuses
export const EXECUTION_STATUSES = ['pending', 'queued', 'running', 'completed', 'failed', 'timeout', 'cancelled'] as const;

// Role Scopes
export const ROLE_SCOPES = ['system', 'partner', 'organization'] as const;

// User Statuses
export const USER_STATUSES = ['active', 'invited', 'disabled'] as const;

// Notification Channel Types
export const NOTIFICATION_CHANNEL_TYPES = ['email', 'slack', 'teams', 'webhook', 'pagerduty', 'sms'] as const;

// Remote Session Types
export const REMOTE_SESSION_TYPES = ['terminal', 'desktop', 'file_transfer'] as const;

// Partner Plans
export const PARTNER_PLANS = ['free', 'pro', 'enterprise', 'unlimited'] as const;

// Built-in Permissions
export const PERMISSIONS = {
  DEVICES: {
    READ: 'devices:read',
    WRITE: 'devices:write',
    DELETE: 'devices:delete',
    EXECUTE: 'devices:execute'
  },
  SCRIPTS: {
    READ: 'scripts:read',
    WRITE: 'scripts:write',
    DELETE: 'scripts:delete',
    EXECUTE: 'scripts:execute'
  },
  ALERTS: {
    READ: 'alerts:read',
    WRITE: 'alerts:write',
    ACKNOWLEDGE: 'alerts:acknowledge',
    RESOLVE: 'alerts:resolve'
  },
  AUTOMATIONS: {
    READ: 'automations:read',
    WRITE: 'automations:write',
    DELETE: 'automations:delete',
    EXECUTE: 'automations:execute'
  },
  USERS: {
    READ: 'users:read',
    WRITE: 'users:write',
    DELETE: 'users:delete',
    ADMIN: 'users:admin'
  },
  ORGS: {
    READ: 'orgs:read',
    WRITE: 'orgs:write',
    DELETE: 'orgs:delete',
    ADMIN: 'orgs:admin'
  },
  AUDIT: {
    READ: 'audit:read',
    EXPORT: 'audit:export'
  },
  REMOTE: {
    TERMINAL: 'remote:terminal',
    DESKTOP: 'remote:desktop',
    FILE_TRANSFER: 'remote:file_transfer'
  }
} as const;

// Default heartbeat interval (seconds)
export const DEFAULT_HEARTBEAT_INTERVAL = 60;

// Default metrics collection interval (seconds)
export const DEFAULT_METRICS_INTERVAL = 30;

// Default script timeout (seconds)
export const DEFAULT_SCRIPT_TIMEOUT = 300;

// Default alert cooldown (minutes)
export const DEFAULT_ALERT_COOLDOWN = 15;

// Default policy check interval (minutes)
export const DEFAULT_POLICY_CHECK_INTERVAL = 60;

// Pagination defaults
export const DEFAULT_PAGE_SIZE = 50;
export const MAX_PAGE_SIZE = 100;

// Session timeouts
export const ACCESS_TOKEN_EXPIRY = '15m';
export const REFRESH_TOKEN_EXPIRY = '7d';
export const SESSION_EXPIRY_HOURS = 24;
