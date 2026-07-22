// Response shapes the dashboard consumes. These mirror the API responses
// (see the route files referenced on each type) — narrow to the fields the
// dashboard actually renders.

/** GET /devices/stats — apps/api/src/routes/devices/stats.ts */
export interface DeviceStats {
  total: number;
  online: number;
  offline: number;
  byStatus: Record<string, number>;
}

/** GET /alerts/summary — apps/api/src/routes/alerts/alerts.ts */
export interface AlertsSummary {
  bySeverity: { critical: number; high: number; medium: number; low: number; info: number };
  byStatus: { active: number; acknowledged: number; resolved: number; suppressed: number; dismissed: number };
  total: number;
}

/** GET /alerts (list rows) — apps/api/src/routes/alerts/alerts.ts */
export interface AlertRow {
  id: string;
  title: string | null;
  message?: string | null;
  severity: string;
  status: string;
  deviceId?: string | null;
  deviceHostname?: string | null;
  orgName?: string | null;
  createdAt: string;
  triggeredAt?: string | null;
}

/** GET /tickets/stats — apps/api/src/routes/tickets/tickets.ts */
export interface TicketStats {
  open: number;
  unassigned: number;
  mine: number;
  breached: number;
  atRisk: number;
}

/** GET /patches/compliance — apps/api/src/routes/patches/compliance.ts */
export interface PatchCompliance {
  summary: { total: number; pending: number; installed: number; failed: number; missing: number; skipped: number };
  compliancePercent: number;
  totalDevices: number;
  compliantDevices: number;
  criticalSummary: { total: number; patched: number; pending: number };
}

/** GET /security/dashboard — apps/api/src/routes/security/dashboard.ts */
export interface SecurityOverview {
  totalDevices: number;
  atRiskDevices: number;
  unprotectedDevices: number;
  activeThreats: number;
  securityScore: number;
  trend: Array<{ timestamp: string; score: number }>;
}

/** GET /vulnerabilities/stats — apps/api/src/routes/vulnerabilities.ts */
export interface VulnerabilityStats {
  criticalOpen: number;
  kevCveCount: number;
  kevDeviceCount: number;
  patchReadyFindingCount: number;
  acceptedExpiringSoon: number;
  totalFindings: number;
  lastDetectedAt: string | null;
}

/** GET /devices?status=offline rows (fields the fleet card uses) */
export interface OfflineDevice {
  id: string;
  name?: string | null;
  hostname?: string | null;
  lastSeen?: string | null;
  lastHeartbeat?: string | null;
}

/** GET /audit-logs/logs rows (fields the activity table uses) */
export interface AuditLogEntry {
  id: string;
  userName?: string;
  user?: { id: string; name: string; email: string };
  action: string;
  resourceType?: string;
  targetType?: string;
  target?: string;
  targetName?: string;
  resource?: { type?: string; id?: string; name?: string };
  timestamp: string;
  createdAt?: string;
}
