// ============================================
// SNMP Types
// ============================================

export type SnmpVersion = 'v1' | 'v2c' | 'v3';
export type SnmpDeviceStatus = 'online' | 'offline' | 'warning' | 'maintenance';

export type SnmpOidType = 'gauge' | 'counter' | 'string' | 'integer' | 'timeticks' | 'oid' | 'octet_string';

export interface SnmpOid {
  oid: string;
  name: string;
  label?: string;
  unit?: string;
  type: SnmpOidType;
  description?: string;
}

export interface SnmpTemplate {
  id: string;
  name: string;
  description: string | null;
  vendor: string | null;
  deviceType: string | null;
  oids: SnmpOid[];
  isBuiltIn: boolean;
  createdAt: string;
}

export interface SnmpDevice {
  id: string;
  orgId: string;
  name: string;
  ipAddress: string;
  snmpVersion: SnmpVersion;
  port: number;
  templateId: string | null;
  templateName?: string | null;
  isActive: boolean;
  lastPolledAt: string | null;
  lastStatus: SnmpDeviceStatus | null;
  status: SnmpDeviceStatus;
  pollingInterval: number;
  createdAt: string;
}

export interface SnmpMetricPoint {
  timestamp: string;
  value: string | number | null;
}

export interface SnmpMetricSeries {
  oid: string;
  name: string;
  unit?: string;
  points: SnmpMetricPoint[];
}

export interface SnmpMetricSample {
  oid: string;
  name: string;
  value: string | number | null;
  unit?: string;
  recordedAt: string;
}

export interface SnmpDeviceMetrics {
  deviceId: string;
  capturedAt: string;
  metrics: SnmpMetricSample[];
}

export type SnmpThresholdOperator = 'gt' | 'lt' | 'gte' | 'lte' | 'eq' | 'neq';
export type SnmpThresholdSeverity = 'critical' | 'high' | 'medium' | 'low' | 'info';

export interface SnmpThreshold {
  id: string;
  deviceId: string;
  oid: string;
  operator: SnmpThresholdOperator;
  threshold: string;
  severity: SnmpThresholdSeverity;
  message: string | null;
  isActive: boolean;
}

export interface SnmpDashboardData {
  totals: {
    devices: number;
    templates: number;
    thresholds: number;
  };
  status: Record<string, number>;
  templateUsage: Array<{
    templateId: string | null;
    name: string;
    deviceCount: number;
  }>;
  topInterfaces: Array<{
    deviceId: string;
    name: string;
    inOctets: number;
    outOctets: number;
    totalOctets: number;
  }>;
  recentPolls: Array<{
    deviceId: string;
    name: string;
    lastPolledAt: string | null;
    status: SnmpDeviceStatus;
  }>;
}
