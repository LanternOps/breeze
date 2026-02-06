import { useEffect, useMemo, useRef, useState } from 'react';
import type { ElementType, FormEvent } from 'react';
import {
  Activity,
  BarChart3,
  Bell,
  Calendar,
  Columns,
  Database,
  Filter,
  GripVertical,
  LineChart,
  Loader2,
  Mail,
  Monitor,
  Package,
  PieChart,
  Plus,
  Save,
  Shield,
  Table,
  Trash2,
  X
} from 'lucide-react';
import { cn } from '@/lib/utils';
import type { ReportFormat, ReportSchedule, ReportType as LegacyReportType } from './ReportsList';
import { fetchWithAuth } from '../../stores/auth';
import type { FilterConditionGroup } from '@breeze/shared';
import { FilterBuilder, DEFAULT_FILTER_FIELDS } from '../filters/FilterBuilder';
import { FilterPreview } from '../filters/FilterPreview';
import { useFilterPreview } from '../../hooks/useFilterPreview';

type BuilderReportType = 'devices' | 'alerts' | 'patches' | 'compliance' | 'activity';
type ReportBuilderType = BuilderReportType | LegacyReportType;
type ChartType = 'table' | 'bar' | 'line' | 'pie';
type AggregationType = 'count' | 'sum' | 'avg';

type FilterCondition = {
  id: string;
  logic: 'and' | 'or';
  field: string;
  operator: string;
  value: string;
};

type Aggregation = {
  type: AggregationType;
  field?: string;
};

type DataSourceField = {
  id: string;
  label: string;
  type: 'select' | 'toggle' | 'text';
  options?: { value: string; label: string }[];
  helper?: string;
};

type FieldDefinition = {
  id: string;
  label: string;
  dataType: 'string' | 'number' | 'date';
};

export type ReportBuilderFormValues = {
  name?: string;
  type: ReportBuilderType;
  builderType?: BuilderReportType;
  dataSource?: Record<string, string | boolean>;
  columns?: string[];
  filterConditions?: FilterCondition[];
  groupBy?: string;
  aggregation?: Aggregation;
  chartType?: ChartType;
  schedule?: ReportSchedule;
  scheduleTime?: string;
  scheduleDay?: string;
  scheduleDate?: string;
  exportFormats?: ReportFormat[];
  format?: ReportFormat;
  emailRecipients?: string[];
  saveTemplate?: boolean;
  templateName?: string;
  dateRange?: { preset?: string; start?: string; end?: string };
  filters?: Record<string, unknown>;
};

type ReportBuilderProps = {
  mode?: 'create' | 'edit' | 'adhoc' | 'builder';
  defaultValues?: Partial<ReportBuilderFormValues>;
  reportId?: string;
  onSubmit?: (values: ReportBuilderFormValues) => void | Promise<void>;
  onPreview?: (values: ReportBuilderFormValues) => void | Promise<void>;
  onCancel?: () => void;
};

const builderTypeValues: BuilderReportType[] = ['devices', 'alerts', 'patches', 'compliance', 'activity'];

const reportTypeOptions: { value: BuilderReportType; label: string; description: string; icon: ElementType }[] = [
  {
    value: 'devices',
    label: 'Devices',
    description: 'Inventory and health posture across managed endpoints',
    icon: Monitor
  },
  {
    value: 'alerts',
    label: 'Alerts',
    description: 'Alert volume, severity, and response performance',
    icon: Bell
  },
  {
    value: 'patches',
    label: 'Patches',
    description: 'Patch readiness, deployment status, and exposure',
    icon: Package
  },
  {
    value: 'compliance',
    label: 'Compliance',
    description: 'Audit readiness and policy alignment visibility',
    icon: Shield
  },
  {
    value: 'activity',
    label: 'Activity',
    description: 'User, admin, and system activity trails',
    icon: Activity
  }
];

const builderToLegacyType: Record<BuilderReportType, LegacyReportType> = {
  devices: 'device_inventory',
  alerts: 'alert_summary',
  patches: 'software_inventory',
  compliance: 'compliance',
  activity: 'performance'
};

const legacyToBuilderType: Record<LegacyReportType, BuilderReportType> = {
  device_inventory: 'devices',
  software_inventory: 'patches',
  alert_summary: 'alerts',
  compliance: 'compliance',
  performance: 'activity',
  executive_summary: 'activity'
};

const scheduleOptions: { value: ReportSchedule; label: string; description: string }[] = [
  { value: 'daily', label: 'Daily', description: 'Run every day' },
  { value: 'weekly', label: 'Weekly', description: 'Run once a week' },
  { value: 'monthly', label: 'Monthly', description: 'Run once a month' }
];

const exportFormatOptions: { value: ReportFormat; label: string; description: string }[] = [
  { value: 'pdf', label: 'PDF', description: 'Formatted document' },
  { value: 'csv', label: 'CSV', description: 'Comma-separated values' },
  { value: 'excel', label: 'Excel', description: 'Spreadsheet workbook' }
];

const chartTypeOptions: { value: ChartType; label: string; icon: ElementType }[] = [
  { value: 'table', label: 'Table', icon: Table },
  { value: 'bar', label: 'Bar', icon: BarChart3 },
  { value: 'line', label: 'Line', icon: LineChart },
  { value: 'pie', label: 'Pie', icon: PieChart }
];

const filterOperators = [
  { value: 'is', label: 'Is' },
  { value: 'is_not', label: 'Is not' },
  { value: 'contains', label: 'Contains' },
  { value: 'gt', label: 'Greater than' },
  { value: 'lt', label: 'Less than' }
];

const dataSourceFieldsByType: Record<BuilderReportType, DataSourceField[]> = {
  devices: [
    {
      id: 'scope',
      label: 'Device scope',
      type: 'select',
      options: [
        { value: 'all_devices', label: 'All devices' },
        { value: 'by_site', label: 'By site' },
        { value: 'by_tag', label: 'By tag' }
      ]
    },
    {
      id: 'platform',
      label: 'Platform',
      type: 'select',
      options: [
        { value: 'all', label: 'All platforms' },
        { value: 'windows', label: 'Windows' },
        { value: 'macos', label: 'macOS' },
        { value: 'linux', label: 'Linux' }
      ]
    },
    {
      id: 'ownership',
      label: 'Ownership',
      type: 'select',
      options: [
        { value: 'managed', label: 'Managed devices' },
        { value: 'unmanaged', label: 'Unmanaged devices' },
        { value: 'all', label: 'All devices' }
      ]
    },
    {
      id: 'inventorySource',
      label: 'Inventory source',
      type: 'select',
      options: [
        { value: 'agent', label: 'Agent reported' },
        { value: 'cmdb', label: 'CMDB import' },
        { value: 'combined', label: 'Combined sources' }
      ]
    },
    {
      id: 'includeInactive',
      label: 'Include inactive devices',
      type: 'toggle'
    }
  ],
  alerts: [
    {
      id: 'timeWindow',
      label: 'Time window',
      type: 'select',
      options: [
        { value: 'last_24h', label: 'Last 24 hours' },
        { value: 'last_7d', label: 'Last 7 days' },
        { value: 'last_30d', label: 'Last 30 days' }
      ]
    },
    {
      id: 'severity',
      label: 'Severity',
      type: 'select',
      options: [
        { value: 'all', label: 'All severities' },
        { value: 'critical', label: 'Critical' },
        { value: 'high', label: 'High' },
        { value: 'medium', label: 'Medium' },
        { value: 'low', label: 'Low' }
      ]
    },
    {
      id: 'status',
      label: 'Alert status',
      type: 'select',
      options: [
        { value: 'all', label: 'All statuses' },
        { value: 'open', label: 'Open' },
        { value: 'acknowledged', label: 'Acknowledged' },
        { value: 'resolved', label: 'Resolved' }
      ]
    },
    {
      id: 'source',
      label: 'Alert source',
      type: 'select',
      options: [
        { value: 'all', label: 'All sources' },
        { value: 'monitoring', label: 'Monitoring' },
        { value: 'security', label: 'Security' },
        { value: 'operations', label: 'Operations' }
      ]
    }
  ],
  patches: [
    {
      id: 'catalog',
      label: 'Patch catalog',
      type: 'select',
      options: [
        { value: 'os_updates', label: 'OS updates' },
        { value: 'third_party', label: 'Third-party apps' },
        { value: 'firmware', label: 'Firmware and BIOS' }
      ]
    },
    {
      id: 'approval',
      label: 'Approval state',
      type: 'select',
      options: [
        { value: 'pending', label: 'Pending approval' },
        { value: 'approved', label: 'Approved' },
        { value: 'deployed', label: 'Deployed' }
      ]
    },
    {
      id: 'vendor',
      label: 'Vendor',
      type: 'select',
      options: [
        { value: 'all', label: 'All vendors' },
        { value: 'microsoft', label: 'Microsoft' },
        { value: 'apple', label: 'Apple' },
        { value: 'linux', label: 'Linux' }
      ]
    },
    {
      id: 'priority',
      label: 'Priority',
      type: 'select',
      options: [
        { value: 'critical', label: 'Critical' },
        { value: 'important', label: 'Important' },
        { value: 'routine', label: 'Routine' }
      ]
    }
  ],
  compliance: [
    {
      id: 'policySet',
      label: 'Policy set',
      type: 'select',
      options: [
        { value: 'cis', label: 'CIS Benchmarks' },
        { value: 'iso27001', label: 'ISO 27001' },
        { value: 'hipaa', label: 'HIPAA' },
        { value: 'custom', label: 'Custom policies' }
      ]
    },
    {
      id: 'scoring',
      label: 'Scoring method',
      type: 'select',
      options: [
        { value: 'pass_fail', label: 'Pass / fail' },
        { value: 'weighted', label: 'Weighted scoring' }
      ]
    },
    {
      id: 'scope',
      label: 'Coverage scope',
      type: 'select',
      options: [
        { value: 'all_devices', label: 'All devices' },
        { value: 'by_site', label: 'By site' },
        { value: 'by_group', label: 'By device group' }
      ]
    },
    {
      id: 'includeExceptions',
      label: 'Include exceptions',
      type: 'toggle'
    }
  ],
  activity: [
    {
      id: 'source',
      label: 'Activity source',
      type: 'select',
      options: [
        { value: 'auth', label: 'Authentication' },
        { value: 'admin', label: 'Admin actions' },
        { value: 'system', label: 'System events' },
        { value: 'api', label: 'API activity' }
      ]
    },
    {
      id: 'timeWindow',
      label: 'Time window',
      type: 'select',
      options: [
        { value: 'last_24h', label: 'Last 24 hours' },
        { value: 'last_7d', label: 'Last 7 days' },
        { value: 'last_30d', label: 'Last 30 days' }
      ]
    },
    {
      id: 'region',
      label: 'Region',
      type: 'select',
      options: [
        { value: 'all', label: 'All regions' },
        { value: 'na', label: 'North America' },
        { value: 'emea', label: 'EMEA' },
        { value: 'apac', label: 'APAC' }
      ]
    },
    {
      id: 'includeSystem',
      label: 'Include system accounts',
      type: 'toggle'
    }
  ]
};

const dataSourceDefaultsByType: Record<BuilderReportType, Record<string, string | boolean>> = {
  devices: {
    scope: 'all_devices',
    platform: 'all',
    ownership: 'managed',
    inventorySource: 'agent',
    includeInactive: false
  },
  alerts: {
    timeWindow: 'last_7d',
    severity: 'all',
    status: 'open',
    source: 'all'
  },
  patches: {
    catalog: 'os_updates',
    approval: 'pending',
    vendor: 'all',
    priority: 'critical'
  },
  compliance: {
    policySet: 'cis',
    scoring: 'weighted',
    scope: 'all_devices',
    includeExceptions: true
  },
  activity: {
    source: 'auth',
    timeWindow: 'last_24h',
    region: 'all',
    includeSystem: false
  }
};

const fieldDefinitionsByType: Record<BuilderReportType, FieldDefinition[]> = {
  devices: [
    { id: 'hostname', label: 'Hostname', dataType: 'string' },
    { id: 'os', label: 'OS', dataType: 'string' },
    { id: 'status', label: 'Status', dataType: 'string' },
    { id: 'site', label: 'Site', dataType: 'string' },
    { id: 'owner', label: 'Owner', dataType: 'string' },
    { id: 'serial', label: 'Serial', dataType: 'string' },
    { id: 'last_seen', label: 'Last seen', dataType: 'date' },
    { id: 'cpu', label: 'CPU usage', dataType: 'number' },
    { id: 'memory', label: 'Memory usage', dataType: 'number' },
    { id: 'disk_usage', label: 'Disk usage', dataType: 'number' },
    { id: 'patch_level', label: 'Patch level', dataType: 'string' }
  ],
  alerts: [
    { id: 'alert_id', label: 'Alert ID', dataType: 'string' },
    { id: 'severity', label: 'Severity', dataType: 'string' },
    { id: 'status', label: 'Status', dataType: 'string' },
    { id: 'rule', label: 'Rule', dataType: 'string' },
    { id: 'source', label: 'Source', dataType: 'string' },
    { id: 'device', label: 'Device', dataType: 'string' },
    { id: 'triggered_at', label: 'Triggered at', dataType: 'date' },
    { id: 'resolved_at', label: 'Resolved at', dataType: 'date' },
    { id: 'duration_minutes', label: 'Duration (min)', dataType: 'number' }
  ],
  patches: [
    { id: 'patch_id', label: 'Patch ID', dataType: 'string' },
    { id: 'title', label: 'Title', dataType: 'string' },
    { id: 'vendor', label: 'Vendor', dataType: 'string' },
    { id: 'severity', label: 'Severity', dataType: 'string' },
    { id: 'status', label: 'Status', dataType: 'string' },
    { id: 'release_date', label: 'Release date', dataType: 'date' },
    { id: 'approved_at', label: 'Approved at', dataType: 'date' },
    { id: 'device_count', label: 'Devices', dataType: 'number' },
    { id: 'missing_count', label: 'Missing', dataType: 'number' }
  ],
  compliance: [
    { id: 'policy', label: 'Policy', dataType: 'string' },
    { id: 'score', label: 'Score', dataType: 'number' },
    { id: 'status', label: 'Status', dataType: 'string' },
    { id: 'last_audit', label: 'Last audit', dataType: 'date' },
    { id: 'exception_count', label: 'Exceptions', dataType: 'number' },
    { id: 'device_count', label: 'Devices', dataType: 'number' },
    { id: 'control_family', label: 'Control family', dataType: 'string' }
  ],
  activity: [
    { id: 'user', label: 'User', dataType: 'string' },
    { id: 'action', label: 'Action', dataType: 'string' },
    { id: 'target', label: 'Target', dataType: 'string' },
    { id: 'resource', label: 'Resource', dataType: 'string' },
    { id: 'ip_address', label: 'IP address', dataType: 'string' },
    { id: 'location', label: 'Location', dataType: 'string' },
    { id: 'timestamp', label: 'Timestamp', dataType: 'date' },
    { id: 'result', label: 'Result', dataType: 'string' },
    { id: 'duration_seconds', label: 'Duration (sec)', dataType: 'number' }
  ]
};

const defaultFieldsByType: Record<BuilderReportType, string[]> = {
  devices: ['hostname', 'os', 'status', 'site', 'last_seen'],
  alerts: ['alert_id', 'severity', 'status', 'rule', 'triggered_at'],
  patches: ['patch_id', 'title', 'severity', 'status', 'missing_count'],
  compliance: ['policy', 'score', 'status', 'last_audit'],
  activity: ['user', 'action', 'target', 'timestamp', 'result']
};

const sampleDataByType: Record<BuilderReportType, Record<string, string | number>[]> = {
  devices: [
    {
      hostname: 'atlas-01',
      os: 'Windows 11',
      status: 'Healthy',
      site: 'HQ',
      owner: 'A. Fields',
      serial: 'SN-1842',
      last_seen: '2024-09-12 09:14',
      cpu: 38,
      memory: 62,
      disk_usage: 71,
      patch_level: '2024.08'
    },
    {
      hostname: 'nova-22',
      os: 'macOS 14',
      status: 'Warning',
      site: 'Austin',
      owner: 'M. Rogers',
      serial: 'SN-4410',
      last_seen: '2024-09-12 08:51',
      cpu: 67,
      memory: 74,
      disk_usage: 83,
      patch_level: '2024.07'
    },
    {
      hostname: 'summit-08',
      os: 'Ubuntu 22.04',
      status: 'Healthy',
      site: 'Berlin',
      owner: 'P. Nair',
      serial: 'SN-3048',
      last_seen: '2024-09-12 08:29',
      cpu: 22,
      memory: 49,
      disk_usage: 58,
      patch_level: '2024.08'
    },
    {
      hostname: 'ember-19',
      os: 'Windows 10',
      status: 'At Risk',
      site: 'HQ',
      owner: 'K. Mendoza',
      serial: 'SN-7781',
      last_seen: '2024-09-11 22:05',
      cpu: 81,
      memory: 88,
      disk_usage: 91,
      patch_level: '2024.06'
    }
  ],
  alerts: [
    {
      alert_id: 'AL-1024',
      severity: 'High',
      status: 'Open',
      rule: 'CPU Spike',
      source: 'Monitoring',
      device: 'atlas-01',
      triggered_at: '2024-09-12 08:21',
      resolved_at: '-',
      duration_minutes: 46
    },
    {
      alert_id: 'AL-1032',
      severity: 'Critical',
      status: 'Acknowledged',
      rule: 'Ransomware Signal',
      source: 'Security',
      device: 'ember-19',
      triggered_at: '2024-09-12 07:54',
      resolved_at: '-',
      duration_minutes: 82
    },
    {
      alert_id: 'AL-0988',
      severity: 'Medium',
      status: 'Resolved',
      rule: 'Disk Near Full',
      source: 'Monitoring',
      device: 'nova-22',
      triggered_at: '2024-09-11 23:15',
      resolved_at: '2024-09-12 00:02',
      duration_minutes: 47
    },
    {
      alert_id: 'AL-1011',
      severity: 'Low',
      status: 'Resolved',
      rule: 'Agent Restart',
      source: 'Operations',
      device: 'summit-08',
      triggered_at: '2024-09-11 21:04',
      resolved_at: '2024-09-11 21:08',
      duration_minutes: 4
    }
  ],
  patches: [
    {
      patch_id: 'KB-501',
      title: 'Endpoint Defender Update',
      vendor: 'Microsoft',
      severity: 'Critical',
      status: 'Pending',
      release_date: '2024-09-05',
      approved_at: '2024-09-10',
      device_count: 412,
      missing_count: 67
    },
    {
      patch_id: 'PKG-220',
      title: 'Chrome 127.0.1',
      vendor: 'Google',
      severity: 'High',
      status: 'Deployed',
      release_date: '2024-09-02',
      approved_at: '2024-09-03',
      device_count: 389,
      missing_count: 12
    },
    {
      patch_id: 'FW-77',
      title: 'BIOS Update 1.8',
      vendor: 'Dell',
      severity: 'Medium',
      status: 'Approved',
      release_date: '2024-08-28',
      approved_at: '2024-09-01',
      device_count: 154,
      missing_count: 29
    },
    {
      patch_id: 'APT-18',
      title: 'OpenSSL 3.2',
      vendor: 'Linux',
      severity: 'High',
      status: 'Pending',
      release_date: '2024-09-06',
      approved_at: '2024-09-11',
      device_count: 88,
      missing_count: 44
    }
  ],
  compliance: [
    {
      policy: 'CIS L1',
      score: 92,
      status: 'Passing',
      last_audit: '2024-09-10',
      exception_count: 4,
      device_count: 312,
      control_family: 'Authentication'
    },
    {
      policy: 'ISO 27001',
      score: 85,
      status: 'At Risk',
      last_audit: '2024-09-09',
      exception_count: 12,
      device_count: 145,
      control_family: 'Asset Mgmt'
    },
    {
      policy: 'HIPAA',
      score: 78,
      status: 'At Risk',
      last_audit: '2024-09-08',
      exception_count: 18,
      device_count: 62,
      control_family: 'Logging'
    },
    {
      policy: 'Custom Secure',
      score: 96,
      status: 'Passing',
      last_audit: '2024-09-11',
      exception_count: 2,
      device_count: 289,
      control_family: 'Network'
    }
  ],
  activity: [
    {
      user: 'ariana.fields',
      action: 'Login',
      target: 'Portal',
      resource: 'SSO',
      ip_address: '198.51.100.24',
      location: 'Austin, TX',
      timestamp: '2024-09-12 08:44',
      result: 'Success',
      duration_seconds: 12
    },
    {
      user: 'miguel.rogers',
      action: 'Patch Approve',
      target: 'Patch KB-501',
      resource: 'Patching',
      ip_address: '203.0.113.19',
      location: 'Denver, CO',
      timestamp: '2024-09-12 08:12',
      result: 'Success',
      duration_seconds: 34
    },
    {
      user: 'kai.mendoza',
      action: 'Policy Change',
      target: 'CIS L1',
      resource: 'Compliance',
      ip_address: '203.0.113.77',
      location: 'Berlin, DE',
      timestamp: '2024-09-11 19:58',
      result: 'Success',
      duration_seconds: 46
    },
    {
      user: 'grace.liu',
      action: 'Login',
      target: 'Console',
      resource: 'SSO',
      ip_address: '198.51.100.88',
      location: 'New York, NY',
      timestamp: '2024-09-11 19:41',
      result: 'Failed',
      duration_seconds: 8
    }
  ]
};

const defaultChartSeriesByType: Record<BuilderReportType, { label: string; value: number }[]> = {
  devices: [
    { label: 'Healthy', value: 318 },
    { label: 'Warning', value: 52 },
    { label: 'At Risk', value: 19 }
  ],
  alerts: [
    { label: 'Critical', value: 12 },
    { label: 'High', value: 28 },
    { label: 'Medium', value: 47 },
    { label: 'Low', value: 63 }
  ],
  patches: [
    { label: 'Pending', value: 140 },
    { label: 'Approved', value: 92 },
    { label: 'Deployed', value: 210 }
  ],
  compliance: [
    { label: 'Passing', value: 284 },
    { label: 'At Risk', value: 74 },
    { label: 'Failing', value: 22 }
  ],
  activity: [
    { label: 'Logins', value: 240 },
    { label: 'Policy', value: 36 },
    { label: 'Patching', value: 58 },
    { label: 'Admin', value: 18 }
  ]
};

const weekDays = [
  { value: 'monday', label: 'Monday' },
  { value: 'tuesday', label: 'Tuesday' },
  { value: 'wednesday', label: 'Wednesday' },
  { value: 'thursday', label: 'Thursday' },
  { value: 'friday', label: 'Friday' },
  { value: 'saturday', label: 'Saturday' },
  { value: 'sunday', label: 'Sunday' }
];

const monthDays = Array.from({ length: 28 }, (_, index) => String(index + 1));

const chartColors = ['#0ea5e9', '#10b981', '#f59e0b', '#ef4444', '#14b8a6'];

const normalizeBuilderType = (value?: ReportBuilderType): BuilderReportType => {
  if (!value) return 'devices';
  if (builderTypeValues.includes(value as BuilderReportType)) {
    return value as BuilderReportType;
  }
  return legacyToBuilderType[value as LegacyReportType] ?? 'devices';
};

const normalizeSchedule = (value?: ReportSchedule): ReportSchedule => {
  if (!value || value === 'one_time') return 'weekly';
  return value;
};

const formatLabel = (value: string) =>
  value
    .replace(/_/g, ' ')
    .replace(/([a-z])([A-Z])/g, '$1 $2')
    .replace(/^./, char => char.toUpperCase());

let filterIdCounter = 0;
const buildFilterId = (prefix: string = 'filter') => {
  filterIdCounter += 1;
  return `${prefix}-${filterIdCounter}`;
};

export default function ReportBuilder({
  mode = 'create',
  defaultValues,
  reportId,
  onSubmit,
  onPreview,
  onCancel
}: ReportBuilderProps) {
  const defaultsAppliedRef = useRef(false);
  const initialType = normalizeBuilderType(defaultValues?.builderType ?? defaultValues?.type);

  const [builderType, setBuilderType] = useState<BuilderReportType>(initialType);
  const [reportName, setReportName] = useState(defaultValues?.name ?? '');
  const [dataSource, setDataSource] = useState<Record<string, string | boolean>>(
    defaultValues?.dataSource ?? dataSourceDefaultsByType[initialType]
  );
  const [selectedFields, setSelectedFields] = useState<string[]>(
    defaultValues?.columns ?? defaultFieldsByType[initialType]
  );
  const [filterConditions, setFilterConditions] = useState<FilterCondition[]>(
    defaultValues?.filterConditions ?? []
  );
  const [groupBy, setGroupBy] = useState(defaultValues?.groupBy ?? '');
  const [aggregation, setAggregation] = useState<Aggregation>(defaultValues?.aggregation ?? { type: 'count' });
  const [chartType, setChartType] = useState<ChartType>(defaultValues?.chartType ?? 'table');
  const [schedule, setSchedule] = useState<ReportSchedule>(normalizeSchedule(defaultValues?.schedule));
  const [scheduleTime, setScheduleTime] = useState(defaultValues?.scheduleTime ?? '09:00');
  const [scheduleDay, setScheduleDay] = useState(defaultValues?.scheduleDay ?? 'monday');
  const [scheduleDate, setScheduleDate] = useState(defaultValues?.scheduleDate ?? '1');
  const [exportFormats, setExportFormats] = useState<ReportFormat[]>(
    defaultValues?.exportFormats ?? (defaultValues?.format ? [defaultValues.format] : ['pdf'])
  );
  const [emailRecipients, setEmailRecipients] = useState<string[]>(defaultValues?.emailRecipients ?? []);
  const [saveTemplate, setSaveTemplate] = useState(defaultValues?.saveTemplate ?? false);
  const [templateName, setTemplateName] = useState(defaultValues?.templateName ?? '');
  const [emailInput, setEmailInput] = useState('');
  const [emailError, setEmailError] = useState<string>();
  const [draggedIndex, setDraggedIndex] = useState<number | null>(null);
  const [saving, setSaving] = useState(false);
  const [previewing, setPreviewing] = useState(false);
  const [error, setError] = useState<string>();
  const [filterMode, setFilterMode] = useState<'simple' | 'advanced'>('simple');
  const [deviceFilter, setDeviceFilter] = useState<FilterConditionGroup>({
    operator: 'AND',
    conditions: []
  });
  const { preview: deviceFilterPreview, loading: deviceFilterPreviewLoading } = useFilterPreview(deviceFilter, {
    enabled: filterMode === 'advanced' && deviceFilter.conditions.length > 0
  });

  useEffect(() => {
    if (!defaultValues || defaultsAppliedRef.current) return;
    defaultsAppliedRef.current = true;

    const normalizedType = normalizeBuilderType(defaultValues.builderType ?? defaultValues.type);
    setBuilderType(normalizedType);
    setReportName(defaultValues.name ?? '');
    setDataSource(defaultValues.dataSource ?? dataSourceDefaultsByType[normalizedType]);
    setSelectedFields(defaultValues.columns ?? defaultFieldsByType[normalizedType]);
    setFilterConditions(defaultValues.filterConditions ?? []);
    setGroupBy(defaultValues.groupBy ?? '');
    setAggregation(defaultValues.aggregation ?? { type: 'count' });
    setChartType(defaultValues.chartType ?? 'table');
    setSchedule(normalizeSchedule(defaultValues.schedule));
    setScheduleTime(defaultValues.scheduleTime ?? '09:00');
    setScheduleDay(defaultValues.scheduleDay ?? 'monday');
    setScheduleDate(defaultValues.scheduleDate ?? '1');
    setExportFormats(defaultValues.exportFormats ?? (defaultValues.format ? [defaultValues.format] : ['pdf']));
    setEmailRecipients(defaultValues.emailRecipients ?? []);
    setSaveTemplate(defaultValues.saveTemplate ?? false);
    setTemplateName(defaultValues.templateName ?? '');
  }, [defaultValues]);

  const fieldDefinitions = fieldDefinitionsByType[builderType];
  const dataSourceFields = dataSourceFieldsByType[builderType];
  const numericFields = useMemo(
    () => fieldDefinitions.filter(field => field.dataType === 'number'),
    [fieldDefinitions]
  );
  const groupByOptions = useMemo(
    () => fieldDefinitions.filter(field => field.dataType !== 'number'),
    [fieldDefinitions]
  );

  const fieldLabelMap = useMemo(() => {
    const map = new Map<string, string>();
    fieldDefinitions.forEach(field => map.set(field.id, field.label));
    return map;
  }, [fieldDefinitions]);

  const getFieldLabel = (fieldId: string) => fieldLabelMap.get(fieldId) ?? formatLabel(fieldId);

  const groupedMetricKey = useMemo(() => {
    if (!groupBy) return '';
    if (aggregation.type === 'count') return 'count';
    return `${aggregation.type}_${aggregation.field || 'metric'}`;
  }, [aggregation, groupBy]);

  const groupedMetricLabel = useMemo(() => {
    if (!groupBy) return '';
    if (aggregation.type === 'count') return 'Count';
    const fieldLabel = aggregation.field ? getFieldLabel(aggregation.field) : 'Value';
    return `${aggregation.type === 'sum' ? 'Sum' : 'Avg'} ${fieldLabel}`;
  }, [aggregation, groupBy, fieldLabelMap]);

  const groupedRows = useMemo(() => {
    if (!groupBy) return [];
    const grouped = new Map<string, { count: number; sum: number }>();
    const fieldKey = aggregation.field ?? '';

    sampleDataByType[builderType].forEach(row => {
      const key = String(row[groupBy] ?? 'Unknown');
      const current = grouped.get(key) ?? { count: 0, sum: 0 };
      current.count += 1;
      if (aggregation.type !== 'count' && fieldKey) {
        const value = Number(row[fieldKey] ?? 0);
        if (!Number.isNaN(value)) {
          current.sum += value;
        }
      }
      grouped.set(key, current);
    });

    return Array.from(grouped.entries()).map(([key, stats]) => {
      let metricValue = stats.count;
      if (aggregation.type === 'sum') {
        metricValue = Math.round(stats.sum * 10) / 10;
      }
      if (aggregation.type === 'avg') {
        metricValue = stats.count ? Math.round((stats.sum / stats.count) * 10) / 10 : 0;
      }
      return {
        [groupBy]: key,
        [groupedMetricKey]: metricValue
      };
    });
  }, [aggregation, builderType, groupBy, groupedMetricKey]);

  const previewColumns = useMemo(() => {
    if (groupBy) {
      return [groupBy, groupedMetricKey].filter((value): value is string => Boolean(value));
    }
    const safeSelected = selectedFields.filter(field => fieldLabelMap.has(field));
    return safeSelected.length ? safeSelected : defaultFieldsByType[builderType];
  }, [builderType, fieldLabelMap, groupBy, groupedMetricKey, selectedFields]);

  const previewRows = useMemo(() => {
    const baseRows = groupBy ? groupedRows : sampleDataByType[builderType];
    return baseRows.slice(0, 5);
  }, [builderType, groupBy, groupedRows]);

  const chartSeries = useMemo(() => {
    if (groupBy) {
      return groupedRows.map(row => ({
        label: String(row[groupBy] ?? ''),
        value: Number(row[groupedMetricKey] ?? 0)
      }));
    }
    return defaultChartSeriesByType[builderType];
  }, [builderType, groupBy, groupedRows, groupedMetricKey]);

  const maxSeriesValue = Math.max(1, ...chartSeries.map(series => series.value));

  const dataSourceSummary = useMemo(() => {
    return dataSourceFields
      .map(field => {
        const value = dataSource[field.id];
        if (field.type === 'toggle') {
          return `${field.label}: ${value ? 'On' : 'Off'}`;
        }
        if (field.type === 'select') {
          const optionLabel = field.options?.find(option => option.value === value)?.label ?? value;
          return `${field.label}: ${optionLabel}`;
        }
        if (field.type === 'text') {
          return value ? `${field.label}: ${value}` : null;
        }
        return null;
      })
      .filter((value): value is string => Boolean(value));
  }, [dataSource, dataSourceFields]);

  const handleTypeSelect = (type: BuilderReportType) => {
    setBuilderType(type);
    setDataSource(dataSourceDefaultsByType[type]);
    setSelectedFields(defaultFieldsByType[type]);
    setFilterConditions([]);
    setGroupBy('');
    setAggregation({ type: 'count' });
  };

  const toggleField = (fieldId: string) => {
    setSelectedFields(prev => {
      if (prev.includes(fieldId)) {
        const next = prev.filter(field => field !== fieldId);
        if (groupBy === fieldId) {
          setGroupBy('');
        }
        if (aggregation.field === fieldId) {
          setAggregation(current => ({ ...current, field: '' }));
        }
        return next;
      }
      return [...prev, fieldId];
    });
  };

  const updateFilterCondition = (id: string, patch: Partial<FilterCondition>) => {
    setFilterConditions(prev => prev.map(item => (item.id === id ? { ...item, ...patch } : item)));
  };

  const addFilterCondition = () => {
    const defaultField = fieldDefinitions[0]?.id;
    if (!defaultField) return;
    setFilterConditions(prev => [
      ...prev,
      {
        id: buildFilterId(),
        logic: 'and',
        field: defaultField,
        operator: 'is',
        value: ''
      }
    ]);
  };

  const removeFilterCondition = (id: string) => {
    setFilterConditions(prev => prev.filter(item => item.id !== id));
  };

  const toggleExportFormat = (format: ReportFormat) => {
    setExportFormats(prev => {
      if (prev.includes(format)) {
        if (prev.length === 1) return prev;
        return prev.filter(item => item !== format);
      }
      return [...prev, format];
    });
  };

  const addEmailRecipient = () => {
    const trimmed = emailInput.trim();
    if (!trimmed) return;
    const isValid = /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(trimmed);
    if (!isValid) {
      setEmailError('Enter a valid email address.');
      return;
    }
    setEmailError(undefined);
    setEmailRecipients(prev => (prev.includes(trimmed) ? prev : [...prev, trimmed]));
    setEmailInput('');
  };

  const removeEmailRecipient = (email: string) => {
    setEmailRecipients(prev => prev.filter(item => item !== email));
  };

  const formatCellValue = (value: unknown) => {
    if (value === null || value === undefined || value === '') return '-';
    if (typeof value === 'number') return value.toLocaleString();
    return String(value);
  };

  const buildFormValues = (): ReportBuilderFormValues => {
    const primaryFormat = exportFormats[0] ?? 'pdf';
    return {
      name: reportName.trim(),
      type: builderToLegacyType[builderType],
      builderType,
      dataSource,
      columns: selectedFields,
      filterConditions,
      groupBy,
      aggregation,
      chartType,
      schedule,
      scheduleTime,
      scheduleDay,
      scheduleDate,
      exportFormats,
      format: primaryFormat,
      emailRecipients,
      saveTemplate,
      templateName: saveTemplate ? templateName : undefined,
      filters: defaultValues?.filters,
      dateRange: defaultValues?.dateRange
    };
  };

  const handlePreview = async () => {
    if (!onPreview) return;
    const values = buildFormValues();
    setPreviewing(true);
    setError(undefined);
    try {
      await onPreview(values);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to generate preview');
    } finally {
      setPreviewing(false);
    }
  };

  const handleFormSubmit = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    setError(undefined);
    setEmailError(undefined);

    if (mode !== 'adhoc' && !reportName.trim()) {
      setError('Report name is required.');
      return;
    }

    if (saveTemplate && !templateName.trim()) {
      setError('Template name is required.');
      return;
    }

    if (exportFormats.length === 0) {
      setError('Select at least one export format.');
      return;
    }

    const values = buildFormValues();
    const primaryFormat = values.format ?? 'pdf';

    const payload = {
      name: values.name || 'Untitled Report',
      type: values.type,
      schedule: values.schedule,
      format: primaryFormat,
      config: {
        builderType,
        dataSource,
        columns: selectedFields,
        filterConditions,
        groupBy,
        aggregation,
        chartType,
        schedule: {
          time: scheduleTime,
          day: scheduleDay,
          date: scheduleDate
        },
        exportFormats,
        emailRecipients,
        saveTemplate,
        templateName: saveTemplate ? templateName : undefined,
        legacyFilters: defaultValues?.filters,
        dateRange: defaultValues?.dateRange
      }
    };

    setSaving(true);
    try {
      let response: Response | undefined;

      if (mode === 'adhoc') {
        response = await fetchWithAuth('/reports/generate', {
          method: 'POST',
          body: JSON.stringify({
            type: payload.type,
            config: payload.config,
            format: primaryFormat
          })
        });
      } else if (mode === 'edit' && reportId) {
        response = await fetchWithAuth(`/reports/${reportId}`, {
          method: 'PUT',
          body: JSON.stringify(payload)
        });
      } else {
        response = await fetchWithAuth('/reports', {
          method: 'POST',
          body: JSON.stringify(payload)
        });
      }

      if (!response.ok) {
        throw new Error('Failed to save report');
      }

      onSubmit?.(values);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'An error occurred');
    } finally {
      setSaving(false);
    }
  };

  const renderPreviewTable = (compact = false) => {
    if (previewColumns.length === 0) {
      return (
        <div className="rounded-md border border-dashed p-6 text-center text-sm text-muted-foreground">
          Select fields to populate the preview table.
        </div>
      );
    }

    return (
      <div className="overflow-hidden rounded-md border">
        <table className={cn('w-full text-left text-sm', compact && 'text-xs')}>
          <thead className="bg-muted/40">
            <tr>
              {previewColumns.map(column => (
                <th key={column} className="px-3 py-2 font-medium text-muted-foreground">
                  {column === groupedMetricKey ? groupedMetricLabel : getFieldLabel(column)}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {previewRows.map((row, index) => (
              <tr key={`row-${index}`} className="border-t">
                {previewColumns.map(column => (
                  <td key={`${column}-${index}`} className="px-3 py-2">
                    {formatCellValue(row[column])}
                  </td>
                ))}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    );
  };

  const renderChart = () => {
    if (!chartSeries.length) {
      return (
        <div className="rounded-md border border-dashed p-6 text-center text-sm text-muted-foreground">
          Not enough data to chart.
        </div>
      );
    }

    if (chartType === 'bar') {
      return (
        <div className="space-y-3">
          {chartSeries.map((item, index) => (
            <div key={`${item.label}-${index}`} className="flex items-center gap-3 text-xs">
              <span className="w-20 truncate text-muted-foreground">{item.label}</span>
              <div className="flex-1 rounded-full bg-muted/50">
                <div
                  className="h-2 rounded-full"
                  style={{
                    width: `${Math.round((item.value / maxSeriesValue) * 100)}%`,
                    backgroundColor: chartColors[index % chartColors.length]
                  }}
                />
              </div>
              <span className="w-10 text-right font-medium">{item.value}</span>
            </div>
          ))}
        </div>
      );
    }

    if (chartType === 'line') {
      const points = chartSeries
        .map((item, index) => {
          const x = chartSeries.length === 1 ? 50 : (index / (chartSeries.length - 1)) * 100;
          const y = 40 - (item.value / maxSeriesValue) * 32;
          return `${x},${y}`;
        })
        .join(' ');

      return (
        <div className="space-y-4">
          <svg viewBox="0 0 100 40" className="h-28 w-full">
            <polyline
              fill="none"
              stroke="currentColor"
              strokeWidth="2"
              className="text-primary"
              points={points}
            />
            {chartSeries.map((item, index) => {
              const x = chartSeries.length === 1 ? 50 : (index / (chartSeries.length - 1)) * 100;
              const y = 40 - (item.value / maxSeriesValue) * 32;
              return <circle key={`${item.label}-${index}`} cx={x} cy={y} r="2.5" fill="#0ea5e9" />;
            })}
          </svg>
          <div className="flex flex-wrap gap-3 text-xs text-muted-foreground">
            {chartSeries.map(item => (
              <span key={item.label}>{item.label}</span>
            ))}
          </div>
        </div>
      );
    }

    if (chartType === 'pie') {
      const total = chartSeries.reduce((sum, item) => sum + item.value, 0) || 1;
      let cursor = 0;
      const slices = chartSeries.map((item, index) => {
        const start = (cursor / total) * 100;
        cursor += item.value;
        const end = (cursor / total) * 100;
        return `${chartColors[index % chartColors.length]} ${start}% ${end}%`;
      });

      return (
        <div className="flex flex-wrap items-center gap-6">
          <div
            className="h-28 w-28 rounded-full"
            style={{ background: `conic-gradient(${slices.join(', ')})` }}
          />
          <div className="space-y-2 text-xs">
            {chartSeries.map((item, index) => (
              <div key={`${item.label}-${index}`} className="flex items-center gap-2">
                <span
                  className="h-2 w-2 rounded-full"
                  style={{ backgroundColor: chartColors[index % chartColors.length] }}
                />
                <span className="text-muted-foreground">{item.label}</span>
                <span className="font-medium">{item.value}</span>
              </div>
            ))}
          </div>
        </div>
      );
    }

    return renderPreviewTable();
  };

  const scheduleLabel = scheduleOptions.find(option => option.value === schedule)?.label ?? 'Weekly';
  const scheduleDetail =
    schedule === 'weekly'
      ? weekDays.find(day => day.value === scheduleDay)?.label
      : schedule === 'monthly'
        ? `Day ${scheduleDate}`
        : 'Every day';

  const previewTypeLabel = reportTypeOptions.find(option => option.value === builderType)?.label ?? 'Report';

  const showDelivery = mode !== 'adhoc';

  return (
    <form
      onSubmit={handleFormSubmit}
      className="grid gap-6 lg:grid-cols-[minmax(0,1fr)_420px]"
    >
      <div className="space-y-6">
        {error && (
          <div className="rounded-md border border-destructive/40 bg-destructive/10 px-4 py-3 text-sm text-destructive">
            {error}
          </div>
        )}

        <div className="rounded-lg border bg-card p-6 shadow-sm space-y-4">
          <div>
            <h2 className="text-sm font-semibold">Report details</h2>
            <p className="text-xs text-muted-foreground">Name the report and decide if it becomes a template.</p>
          </div>

          <div className="grid gap-4 sm:grid-cols-2">
            <div className="space-y-2">
              <label htmlFor="report-name" className="text-sm font-medium">
                Report name
              </label>
              <input
                id="report-name"
                placeholder="Monthly Security Overview"
                value={reportName}
                onChange={event => setReportName(event.target.value)}
                className="h-10 w-full rounded-md border bg-background px-3 text-sm focus:outline-none focus:ring-2 focus:ring-ring"
              />
            </div>
            <div className="flex items-end gap-2">
              <label className="flex items-center gap-2 text-sm font-medium">
                <input
                  type="checkbox"
                  checked={saveTemplate}
                  onChange={event => setSaveTemplate(event.target.checked)}
                  className="h-4 w-4 rounded border"
                />
                Save as template
              </label>
            </div>
          </div>

          {saveTemplate && (
            <div className="space-y-2">
              <label htmlFor="template-name" className="text-sm font-medium">
                Template name
              </label>
              <input
                id="template-name"
                placeholder="Quarterly Compliance Pack"
                value={templateName}
                onChange={event => setTemplateName(event.target.value)}
                className="h-10 w-full rounded-md border bg-background px-3 text-sm focus:outline-none focus:ring-2 focus:ring-ring"
              />
            </div>
          )}
        </div>

        <div className="rounded-lg border bg-card p-6 shadow-sm space-y-4">
          <div className="flex items-center gap-2">
            <Monitor className="h-4 w-4 text-muted-foreground" />
            <div>
              <h2 className="text-sm font-semibold">Report type</h2>
              <p className="text-xs text-muted-foreground">Choose the kind of report you are building.</p>
            </div>
          </div>

          <div className="grid gap-3 sm:grid-cols-2">
            {reportTypeOptions.map(type => {
              const isSelected = builderType === type.value;
              return (
                <button
                  key={type.value}
                  type="button"
                  onClick={() => handleTypeSelect(type.value)}
                  className={cn(
                    'flex flex-col items-start gap-2 rounded-lg border p-4 text-left transition',
                    isSelected ? 'border-primary bg-primary/5 ring-1 ring-primary' : 'hover:bg-muted'
                  )}
                >
                  <div className="flex items-center gap-2">
                    <type.icon className={cn('h-5 w-5', isSelected ? 'text-primary' : 'text-muted-foreground')} />
                    <span className="font-medium">{type.label}</span>
                  </div>
                  <p className="text-xs text-muted-foreground">{type.description}</p>
                </button>
              );
            })}
          </div>
        </div>

        <div className="rounded-lg border bg-card p-6 shadow-sm space-y-4">
          <div className="flex items-center gap-2">
            <Database className="h-4 w-4 text-muted-foreground" />
            <div>
              <h2 className="text-sm font-semibold">Data source</h2>
              <p className="text-xs text-muted-foreground">Configure the dataset for this report type.</p>
            </div>
          </div>

          <div className="grid gap-4 sm:grid-cols-2">
            {dataSourceFields.map(field => (
              <div key={field.id} className="space-y-2">
                <label className="text-xs font-medium text-muted-foreground">{field.label}</label>
                {field.type === 'toggle' ? (
                  <label className="flex items-center gap-2 text-sm font-medium">
                    <input
                      type="checkbox"
                      checked={Boolean(dataSource[field.id])}
                      onChange={event =>
                        setDataSource(prev => ({
                          ...prev,
                          [field.id]: event.target.checked
                        }))
                      }
                      className="h-4 w-4 rounded border"
                    />
                    {field.helper ?? 'Enabled'}
                  </label>
                ) : (
                  <select
                    value={String(dataSource[field.id] ?? '')}
                    onChange={event =>
                      setDataSource(prev => ({
                        ...prev,
                        [field.id]: event.target.value
                      }))
                    }
                    className="h-10 w-full rounded-md border bg-background px-3 text-sm focus:outline-none focus:ring-2 focus:ring-ring"
                  >
                    {field.options?.map(option => (
                      <option key={option.value} value={option.value}>
                        {option.label}
                      </option>
                    ))}
                  </select>
                )}
              </div>
            ))}
          </div>
        </div>

        <div className="rounded-lg border bg-card p-6 shadow-sm space-y-4">
          <div className="flex items-center gap-2">
            <Columns className="h-4 w-4 text-muted-foreground" />
            <div>
              <h2 className="text-sm font-semibold">Columns and fields</h2>
              <p className="text-xs text-muted-foreground">Pick fields and drag to reorder.</p>
            </div>
          </div>

          <div className="grid gap-4 lg:grid-cols-2">
            <div className="space-y-3">
              <p className="text-xs font-medium text-muted-foreground">Available fields</p>
              <div className="flex flex-wrap gap-2">
                {fieldDefinitions.map(field => {
                  const isSelected = selectedFields.includes(field.id);
                  return (
                    <button
                      key={field.id}
                      type="button"
                      onClick={() => toggleField(field.id)}
                      className={cn(
                        'rounded-md border px-3 py-1.5 text-xs font-medium transition',
                        isSelected
                          ? 'border-primary bg-primary/10 text-foreground'
                          : 'hover:bg-muted'
                      )}
                    >
                      {field.label}
                    </button>
                  );
                })}
              </div>
            </div>
            <div className="space-y-3">
              <p className="text-xs font-medium text-muted-foreground">Selected fields</p>
              {selectedFields.length === 0 ? (
                <div className="rounded-md border border-dashed p-4 text-xs text-muted-foreground">
                  No fields selected yet.
                </div>
              ) : (
                <div className="space-y-2">
                  {selectedFields.map((field, index) => (
                    <div
                      key={field}
                      draggable
                      onDragStart={() => setDraggedIndex(index)}
                      onDragOver={event => event.preventDefault()}
                      onDragEnd={() => setDraggedIndex(null)}
                      onDrop={() => {
                        if (draggedIndex === null || draggedIndex === index) return;
                        setSelectedFields(prev => {
                          const next = [...prev];
                          const [moved] = next.splice(draggedIndex, 1);
                          next.splice(index, 0, moved);
                          return next;
                        });
                        setDraggedIndex(null);
                      }}
                      className={cn(
                        'flex items-center justify-between rounded-md border bg-background px-3 py-2 text-sm',
                        draggedIndex === index && 'border-primary/60 bg-primary/5'
                      )}
                    >
                      <div className="flex items-center gap-2">
                        <GripVertical className="h-4 w-4 text-muted-foreground" />
                        <span>{getFieldLabel(field)}</span>
                      </div>
                      <button
                        type="button"
                        onClick={() => toggleField(field)}
                        className="text-muted-foreground hover:text-foreground"
                      >
                        <X className="h-4 w-4" />
                      </button>
                    </div>
                  ))}
                </div>
              )}
            </div>
          </div>
        </div>

        <div className="rounded-lg border bg-card p-6 shadow-sm space-y-4">
          <div className="flex items-center justify-between">
            <div className="flex items-center gap-2">
              <Filter className="h-4 w-4 text-muted-foreground" />
              <div>
                <h2 className="text-sm font-semibold">Filters</h2>
                <p className="text-xs text-muted-foreground">Filter report data by records or device properties.</p>
              </div>
            </div>
            <div className="flex rounded-md border">
              <button
                type="button"
                onClick={() => setFilterMode('simple')}
                className={cn(
                  'px-3 py-1.5 text-xs font-medium rounded-l-md transition',
                  filterMode === 'simple' ? 'bg-primary text-primary-foreground' : 'hover:bg-muted'
                )}
              >
                Record Filters
              </button>
              <button
                type="button"
                onClick={() => setFilterMode('advanced')}
                className={cn(
                  'px-3 py-1.5 text-xs font-medium rounded-r-md transition',
                  filterMode === 'advanced' ? 'bg-primary text-primary-foreground' : 'hover:bg-muted'
                )}
              >
                <Filter className="h-3 w-3 inline mr-1" />
                Device Filter
              </button>
            </div>
          </div>

          {filterMode === 'simple' ? (
            <>
              {filterConditions.length === 0 ? (
                <div className="rounded-md border border-dashed p-4 text-xs text-muted-foreground">
                  No filters yet. Add your first condition.
                </div>
              ) : (
                <div className="space-y-3">
                  {filterConditions.map((condition, index) => (
                    <div key={condition.id} className="grid gap-2 sm:grid-cols-[80px_1fr_1fr_1fr_auto]">
                      {index === 0 ? (
                        <div className="text-xs font-medium uppercase tracking-wide text-muted-foreground self-center">
                          Where
                        </div>
                      ) : (
                        <select
                          value={condition.logic}
                          onChange={event => updateFilterCondition(condition.id, { logic: event.target.value as 'and' | 'or' })}
                          className="h-9 rounded-md border bg-background px-2 text-xs focus:outline-none focus:ring-2 focus:ring-ring"
                        >
                          <option value="and">AND</option>
                          <option value="or">OR</option>
                        </select>
                      )}
                      <select
                        value={condition.field}
                        onChange={event => updateFilterCondition(condition.id, { field: event.target.value })}
                        className="h-9 rounded-md border bg-background px-2 text-xs focus:outline-none focus:ring-2 focus:ring-ring"
                      >
                        {fieldDefinitions.map(field => (
                          <option key={field.id} value={field.id}>
                            {field.label}
                          </option>
                        ))}
                      </select>
                      <select
                        value={condition.operator}
                        onChange={event => updateFilterCondition(condition.id, { operator: event.target.value })}
                        className="h-9 rounded-md border bg-background px-2 text-xs focus:outline-none focus:ring-2 focus:ring-ring"
                      >
                        {filterOperators.map(operator => (
                          <option key={operator.value} value={operator.value}>
                            {operator.label}
                          </option>
                        ))}
                      </select>
                      <input
                        value={condition.value}
                        onChange={event => updateFilterCondition(condition.id, { value: event.target.value })}
                        className="h-9 rounded-md border bg-background px-2 text-xs focus:outline-none focus:ring-2 focus:ring-ring"
                        placeholder="Value"
                      />
                      <button
                        type="button"
                        onClick={() => removeFilterCondition(condition.id)}
                        className="flex h-9 w-9 items-center justify-center rounded-md border text-muted-foreground hover:text-foreground"
                      >
                        <Trash2 className="h-4 w-4" />
                      </button>
                    </div>
                  ))}
                </div>
              )}

              <button
                type="button"
                onClick={addFilterCondition}
                className="inline-flex items-center gap-2 rounded-md border px-3 py-2 text-xs font-medium hover:bg-muted"
              >
                <Plus className="h-3 w-3" />
                Add condition
              </button>
            </>
          ) : (
            <div className="space-y-4">
              <p className="text-xs text-muted-foreground">
                Scope this report to devices matching the filter below.
              </p>
              <FilterBuilder
                value={deviceFilter}
                onChange={setDeviceFilter}
                filterFields={DEFAULT_FILTER_FIELDS}
              />
              {deviceFilter.conditions.length > 0 && (
                <FilterPreview
                  preview={deviceFilterPreview}
                  loading={deviceFilterPreviewLoading}
                  error={null}
                  onRefresh={() => setDeviceFilter({ ...deviceFilter })}
                />
              )}
            </div>
          )}
        </div>

        <div className="rounded-lg border bg-card p-6 shadow-sm space-y-4">
          <div className="flex items-center gap-2">
            <BarChart3 className="h-4 w-4 text-muted-foreground" />
            <div>
              <h2 className="text-sm font-semibold">Grouping and aggregation</h2>
              <p className="text-xs text-muted-foreground">Summarize data with counts, sums, or averages.</p>
            </div>
          </div>

          <div className="grid gap-4 sm:grid-cols-2">
            <div className="space-y-2">
              <label className="text-xs font-medium text-muted-foreground">Group by</label>
              <select
                value={groupBy}
                onChange={event => setGroupBy(event.target.value)}
                className="h-10 w-full rounded-md border bg-background px-3 text-sm focus:outline-none focus:ring-2 focus:ring-ring"
              >
                <option value="">No grouping</option>
                {groupByOptions.map(field => (
                  <option key={field.id} value={field.id}>
                    {field.label}
                  </option>
                ))}
              </select>
            </div>
            <div className="space-y-2">
              <label className="text-xs font-medium text-muted-foreground">Aggregation</label>
              <select
                value={aggregation.type}
                onChange={event => {
                  const nextType = event.target.value as AggregationType;
                  setAggregation(prev => {
                    if (nextType === 'count') {
                      return { type: nextType };
                    }
                    const numericFallback = numericFields[0]?.id ?? prev.field ?? '';
                    return { type: nextType, field: numericFallback };
                  });
                }}
                className="h-10 w-full rounded-md border bg-background px-3 text-sm focus:outline-none focus:ring-2 focus:ring-ring"
              >
                <option value="count">Count</option>
                <option value="sum">Sum</option>
                <option value="avg">Average</option>
              </select>
            </div>
          </div>

          {aggregation.type !== 'count' && (
            <div className="space-y-2">
              <label className="text-xs font-medium text-muted-foreground">Aggregation field</label>
              <select
                value={aggregation.field ?? ''}
                onChange={event => setAggregation(prev => ({ ...prev, field: event.target.value }))}
                className="h-10 w-full rounded-md border bg-background px-3 text-sm focus:outline-none focus:ring-2 focus:ring-ring"
              >
                {numericFields.length === 0 && <option value="">No numeric fields</option>}
                {numericFields.map(field => (
                  <option key={field.id} value={field.id}>
                    {field.label}
                  </option>
                ))}
              </select>
            </div>
          )}
        </div>

        <div className="rounded-lg border bg-card p-6 shadow-sm space-y-4">
          <div className="flex items-center gap-2">
            <PieChart className="h-4 w-4 text-muted-foreground" />
            <div>
              <h2 className="text-sm font-semibold">Chart type</h2>
              <p className="text-xs text-muted-foreground">Choose how the report is visualized.</p>
            </div>
          </div>

          <div className="grid gap-3 sm:grid-cols-4">
            {chartTypeOptions.map(option => {
              const isSelected = chartType === option.value;
              return (
                <button
                  key={option.value}
                  type="button"
                  onClick={() => setChartType(option.value)}
                  className={cn(
                    'flex flex-col items-center gap-2 rounded-md border px-3 py-3 text-xs font-medium transition',
                    isSelected ? 'border-primary bg-primary/10 text-foreground' : 'hover:bg-muted'
                  )}
                >
                  <option.icon className={cn('h-4 w-4', isSelected ? 'text-primary' : 'text-muted-foreground')} />
                  {option.label}
                </button>
              );
            })}
          </div>
        </div>

        {showDelivery && (
          <div className="rounded-lg border bg-card p-6 shadow-sm space-y-5">
            <div className="flex items-center gap-2">
              <Calendar className="h-4 w-4 text-muted-foreground" />
              <div>
                <h2 className="text-sm font-semibold">Schedule and delivery</h2>
                <p className="text-xs text-muted-foreground">Set cadence, formats, and recipients.</p>
              </div>
            </div>

            <div className="space-y-3">
              <p className="text-xs font-medium text-muted-foreground">Schedule</p>
              <div className="flex flex-wrap gap-2">
                {scheduleOptions.map(option => (
                  <button
                    key={option.value}
                    type="button"
                    onClick={() => setSchedule(option.value)}
                    className={cn(
                      'rounded-md border px-3 py-2 text-xs font-medium transition',
                      schedule === option.value
                        ? 'border-primary bg-primary/10 text-foreground'
                        : 'hover:bg-muted'
                    )}
                  >
                    {option.label}
                  </button>
                ))}
              </div>

              <div className="grid gap-3 sm:grid-cols-3">
                <div className="space-y-2">
                  <label className="text-xs font-medium text-muted-foreground">Run time</label>
                  <input
                    type="time"
                    value={scheduleTime}
                    onChange={event => setScheduleTime(event.target.value)}
                    className="h-9 w-full rounded-md border bg-background px-2 text-xs focus:outline-none focus:ring-2 focus:ring-ring"
                  />
                </div>
                {schedule === 'weekly' && (
                  <div className="space-y-2">
                    <label className="text-xs font-medium text-muted-foreground">Day of week</label>
                    <select
                      value={scheduleDay}
                      onChange={event => setScheduleDay(event.target.value)}
                      className="h-9 w-full rounded-md border bg-background px-2 text-xs focus:outline-none focus:ring-2 focus:ring-ring"
                    >
                      {weekDays.map(day => (
                        <option key={day.value} value={day.value}>
                          {day.label}
                        </option>
                      ))}
                    </select>
                  </div>
                )}
                {schedule === 'monthly' && (
                  <div className="space-y-2">
                    <label className="text-xs font-medium text-muted-foreground">Day of month</label>
                    <select
                      value={scheduleDate}
                      onChange={event => setScheduleDate(event.target.value)}
                      className="h-9 w-full rounded-md border bg-background px-2 text-xs focus:outline-none focus:ring-2 focus:ring-ring"
                    >
                      {monthDays.map(day => (
                        <option key={day} value={day}>
                          {day}
                        </option>
                      ))}
                    </select>
                  </div>
                )}
              </div>
            </div>

            <div className="space-y-3">
              <p className="text-xs font-medium text-muted-foreground">Export formats</p>
              <div className="grid gap-3 sm:grid-cols-3">
                {exportFormatOptions.map(format => {
                  const isSelected = exportFormats.includes(format.value);
                  return (
                    <button
                      key={format.value}
                      type="button"
                      onClick={() => toggleExportFormat(format.value)}
                      className={cn(
                        'flex flex-col items-start gap-1 rounded-md border px-3 py-2 text-left text-xs transition',
                        isSelected ? 'border-primary bg-primary/10 text-foreground' : 'hover:bg-muted'
                      )}
                    >
                      <span className="font-medium">{format.label}</span>
                      <span className="text-muted-foreground">{format.description}</span>
                    </button>
                  );
                })}
              </div>
            </div>

            <div className="space-y-3">
              <div className="flex items-center gap-2">
                <Mail className="h-4 w-4 text-muted-foreground" />
                <p className="text-xs font-medium text-muted-foreground">Email distribution list</p>
              </div>
              <div className="flex flex-wrap gap-2">
                {emailRecipients.map(email => (
                  <span
                    key={email}
                    className="inline-flex items-center gap-1 rounded-full border px-3 py-1 text-xs"
                  >
                    {email}
                    <button type="button" onClick={() => removeEmailRecipient(email)}>
                      <X className="h-3 w-3 text-muted-foreground" />
                    </button>
                  </span>
                ))}
              </div>
              <div className="flex flex-col gap-2 sm:flex-row">
                <input
                  type="email"
                  value={emailInput}
                  onChange={event => setEmailInput(event.target.value)}
                  onKeyDown={event => {
                    if (event.key === 'Enter') {
                      event.preventDefault();
                      addEmailRecipient();
                    }
                  }}
                  placeholder="name@company.com"
                  className="h-9 flex-1 rounded-md border bg-background px-2 text-xs focus:outline-none focus:ring-2 focus:ring-ring"
                />
                <button
                  type="button"
                  onClick={addEmailRecipient}
                  className="h-9 rounded-md border px-3 text-xs font-medium hover:bg-muted"
                >
                  Add recipient
                </button>
              </div>
              {emailError && <p className="text-xs text-destructive">{emailError}</p>}
            </div>
          </div>
        )}

        <div className="flex flex-col gap-3 sm:flex-row sm:justify-end">
          {onCancel && (
            <button
              type="button"
              onClick={onCancel}
              className="h-11 w-full rounded-md border bg-background text-sm font-medium text-foreground transition hover:bg-muted sm:w-auto sm:px-6"
            >
              Cancel
            </button>
          )}

          {mode === 'adhoc' && onPreview && (
            <button
              type="button"
              onClick={handlePreview}
              disabled={previewing}
              className="flex h-11 w-full items-center justify-center gap-2 rounded-md border bg-background text-sm font-medium transition hover:bg-muted disabled:opacity-60 sm:w-auto sm:px-6"
            >
              {previewing ? <Loader2 className="h-4 w-4 animate-spin" /> : null}
              Preview
            </button>
          )}

          <button
            type="submit"
            disabled={saving}
            className="flex h-11 w-full items-center justify-center gap-2 rounded-md bg-primary text-sm font-medium text-primary-foreground transition hover:opacity-90 disabled:opacity-60 sm:w-auto sm:px-6"
          >
            {saving ? <Loader2 className="h-4 w-4 animate-spin" /> : <Save className="h-4 w-4" />}
            {mode === 'edit' ? 'Update report' : mode === 'adhoc' ? 'Generate report' : 'Save report'}
          </button>
        </div>
      </div>

      <div className="space-y-6 lg:sticky lg:top-6 self-start">
        <div className="rounded-lg border bg-card p-6 shadow-sm space-y-5">
          <div className="flex items-center justify-between">
            <div>
              <h2 className="text-sm font-semibold">Live preview</h2>
              <p className="text-xs text-muted-foreground">Updates as you configure the report.</p>
            </div>
            <span className="rounded-full border px-2 py-1 text-xs text-muted-foreground">
              {chartType.toUpperCase()}
            </span>
          </div>

          <div className="space-y-1">
            <h3 className="text-lg font-semibold">{reportName || 'Untitled report'}</h3>
            <p className="text-xs text-muted-foreground">{previewTypeLabel}</p>
          </div>

          <div className="flex flex-wrap gap-2">
            <span className="rounded-md border bg-muted/30 px-2 py-1 text-xs">{scheduleLabel}</span>
            <span className="rounded-md border bg-muted/30 px-2 py-1 text-xs">{scheduleDetail}</span>
            <span className="rounded-md border bg-muted/30 px-2 py-1 text-xs">
              {exportFormats.map(format => format.toUpperCase()).join(', ')}
            </span>
          </div>

          <div className="space-y-2">
            <p className="text-xs font-medium text-muted-foreground">Data source</p>
            <div className="flex flex-wrap gap-2">
              {dataSourceSummary.map(summary => (
                <span key={summary} className="rounded-md border px-2 py-1 text-xs text-muted-foreground">
                  {summary}
                </span>
              ))}
            </div>
          </div>

          <div className="rounded-md border bg-muted/10 p-4 space-y-4">
            {chartType === 'table' ? (
              renderPreviewTable()
            ) : (
              <>
                {renderChart()}
                <div className="space-y-2">
                  <p className="text-xs font-medium text-muted-foreground">Sample rows</p>
                  {renderPreviewTable(true)}
                </div>
              </>
            )}
          </div>
        </div>
      </div>
    </form>
  );
}
