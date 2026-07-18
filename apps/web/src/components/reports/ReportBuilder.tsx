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
import { cn, widthPercentClass } from '@/lib/utils';
import { formatNumber } from '@/lib/i18n/format';
import type { ReportFormat, ReportSchedule, ReportType as LegacyReportType } from './ReportsList';
import { fetchWithAuth } from '../../stores/auth';
import { useOrgStore } from '../../stores/orgStore';
import type { FilterConditionGroup } from '@breeze/shared';
import { FilterBuilder, DEFAULT_FILTER_FIELDS } from '../filters/FilterBuilder';
import { FilterPreview } from '../filters/FilterPreview';
import { useFilterPreview } from '../../hooks/useFilterPreview';
import { useTranslation } from 'react-i18next';

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
  /**
   * The report's stored `config`. PUT /reports/:id replaces `config` wholesale,
   * so anything the builder doesn't reconstruct is dropped on save. Report types
   * that carry their own config — `security_compliance_posture`,
   * `executive_summary` — must pass it here or their settings are silently reset
   * to schema defaults on the next edit.
   */
  baseConfig?: Record<string, unknown>;
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
  executive_summary: 'activity',
  // Posture is delivered via a curated template, not the freeform builder; map to
  // the closest builder data-source so the legacy builder degrades gracefully.
  security_compliance_posture: 'compliance'
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

type PreviewRow = Record<string, unknown>;
type PreviewSummary = Record<string, unknown> | null;

const chartCategoryFieldByType: Record<BuilderReportType, string[]> = {
  devices: ['status', 'osType', 'os'],
  alerts: ['severity', 'status', 'rule'],
  patches: ['vendor', 'publisher', 'title'],
  compliance: ['status', 'control_family', 'osType'],
  activity: ['action', 'resource', 'result']
};

const parseReportTimestamp = (value: unknown): number | null => {
  if (typeof value !== 'string' || !value) return null;
  const parsed = new Date(value).getTime();
  return Number.isNaN(parsed) ? null : parsed;
};

const toNumber = (value: unknown): number | null => {
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  if (typeof value === 'string' && value.trim()) {
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : null;
  }
  return null;
};

const normalizePreviewRow = (type: BuilderReportType, row: PreviewRow): PreviewRow => {
  const normalized: PreviewRow = { ...row };

  if (type === 'devices') {
    const osType = typeof row.osType === 'string' ? row.osType : '';
    const osVersion = typeof row.osVersion === 'string' ? row.osVersion : '';
    normalized.os = [osType, osVersion].filter(Boolean).join(' ').trim();
    normalized.serial = row.serial ?? row.serialNumber ?? null;
    normalized.last_seen = row.last_seen ?? row.lastSeenAt ?? null;
    normalized.memory = row.memory ?? row.ramTotalMb ?? null;
    normalized.disk_usage = row.disk_usage ?? row.diskTotalGb ?? null;
    normalized.patch_level = row.patch_level ?? row.agentVersion ?? null;
  } else if (type === 'alerts') {
    normalized.alert_id = row.alert_id ?? row.id ?? row.title ?? null;
    normalized.rule = row.rule ?? row.ruleName ?? null;
    normalized.device = row.device ?? row.deviceHostname ?? null;
    normalized.triggered_at = row.triggered_at ?? row.triggeredAt ?? null;
    normalized.resolved_at = row.resolved_at ?? row.resolvedAt ?? null;

    const triggeredAt = parseReportTimestamp(normalized.triggered_at);
    const resolvedAt = parseReportTimestamp(normalized.resolved_at);
    if (triggeredAt !== null) {
      const end = resolvedAt ?? Date.now();
      normalized.duration_minutes = Math.max(0, Math.round((end - triggeredAt) / 60000));
    }
  } else if (type === 'patches') {
    normalized.patch_id = row.patch_id ?? row.id ?? row.softwareName ?? null;
    normalized.title = row.title ?? row.softwareName ?? null;
    normalized.vendor = row.vendor ?? row.publisher ?? null;
    normalized.release_date = row.release_date ?? row.installDate ?? null;
    normalized.approved_at = row.approved_at ?? row.installDate ?? null;
    normalized.device_count = row.device_count ?? 1;
    normalized.missing_count = row.missing_count ?? 0;
  } else if (type === 'compliance') {
    const compliant =
      typeof row.isCompliant === 'boolean'
        ? row.isCompliant
        : typeof row.status === 'string'
          ? row.status.toLowerCase() === 'compliant'
          : null;
    const issues = Array.isArray(row.issues) ? row.issues : [];
    normalized.policy = row.policy ?? row.hostname ?? null;
    normalized.score = row.score ?? (compliant === null ? null : compliant ? 100 : 0);
    normalized.status = row.status ?? (compliant === null ? null : compliant ? 'Compliant' : 'Non-compliant');
    normalized.last_audit = row.last_audit ?? row.lastSeenAt ?? null;
    normalized.exception_count = row.exception_count ?? issues.length;
    normalized.device_count = row.device_count ?? 1;
    normalized.control_family = row.control_family ?? row.osType ?? null;
  } else if (type === 'activity') {
    normalized.user = row.user ?? row.hostname ?? null;
    normalized.action = row.action ?? 'Metrics';
    normalized.target = row.target ?? row.hostname ?? null;
    normalized.resource = row.resource ?? 'Performance';
    normalized.timestamp = row.timestamp ?? null;
    normalized.result = row.result ?? 'Collected';
    normalized.duration_seconds = row.duration_seconds ?? row.avgCpu ?? null;
  }

  return normalized;
};

const evaluateSimpleCondition = (row: PreviewRow, condition: FilterCondition): boolean => {
  const value = row[condition.field];
  const expected = condition.value.trim();

  if (!expected) return true;

  if (condition.operator === 'gt' || condition.operator === 'lt') {
    const left = toNumber(value);
    const right = toNumber(expected);
    if (left === null || right === null) return false;
    return condition.operator === 'gt' ? left > right : left < right;
  }

  const left = String(value ?? '').toLowerCase();
  const right = expected.toLowerCase();

  if (condition.operator === 'contains') {
    return left.includes(right);
  }
  if (condition.operator === 'is_not') {
    return left !== right;
  }
  return left === right;
};

const rowMatchesSimpleFilters = (row: PreviewRow, conditions: FilterCondition[]): boolean => {
  if (conditions.length === 0) return true;

  let matched = evaluateSimpleCondition(row, conditions[0]!);
  for (let index = 1; index < conditions.length; index += 1) {
    const condition = conditions[index]!;
    const current = evaluateSimpleCondition(row, condition);
    matched = condition.logic === 'or' ? matched || current : matched && current;
  }

  return matched;
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
const chartColorClasses = ['bg-sky-500', 'bg-emerald-500', 'bg-amber-500', 'bg-red-500', 'bg-teal-500'];

const normalizeBuilderType = (value?: ReportBuilderType): BuilderReportType => {
  if (!value) return 'devices';
  if (builderTypeValues.includes(value as BuilderReportType)) {
    return value as BuilderReportType;
  }
  return legacyToBuilderType[value as LegacyReportType] ?? 'devices';
};

/**
 * Whether a report `type` round-trips losslessly through the freeform builder:
 * opening it (normalizeBuilderType) and re-saving it (builderToLegacyType)
 * yields the same type. Types that do NOT survive — e.g.
 * `security_compliance_posture` → `compliance`, `executive_summary` →
 * `performance` — are silently downgraded by the builder and must instead be
 * created directly with their true type. This is the single source of truth
 * for that decision; callers should derive from it rather than hand-maintain a
 * per-template flag.
 */
export const reportTypeSurvivesBuilder = (value: ReportBuilderType): boolean => {
  // Native builder types are represented directly and always round-trip.
  if (builderTypeValues.includes(value as BuilderReportType)) return true;
  return builderToLegacyType[normalizeBuilderType(value)] === value;
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
  baseConfig,
  onSubmit,
  onPreview,
  onCancel
}: ReportBuilderProps) {
  const { t } = useTranslation('reports');
  const { currentOrgId } = useOrgStore();
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
  const [livePreviewRows, setLivePreviewRows] = useState<PreviewRow[]>([]);
  const [livePreviewSummary, setLivePreviewSummary] = useState<PreviewSummary>(null);
  const [livePreviewLoading, setLivePreviewLoading] = useState(false);
  const [livePreviewError, setLivePreviewError] = useState<string>();
  const [filterMode, setFilterMode] = useState<'simple' | 'advanced'>('simple');
  const [deviceFilter, setDeviceFilter] = useState<FilterConditionGroup>({
    operator: 'AND',
    conditions: []
  });
  const previewRequestIdRef = useRef(0);
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

  const getReportTypeOptionLabel = (type: BuilderReportType) =>
    t(/* i18n-dynamic */ `reports.reportBuilder.reportTypes.${type}.label`);
  const getReportTypeOptionDescription = (type: BuilderReportType) =>
    t(/* i18n-dynamic */ `reports.reportBuilder.reportTypes.${type}.description`);
  const getDataSourceFieldLabel = (fieldId: string) =>
    t(/* i18n-dynamic */ `reports.reportBuilder.dataSource.${builderType}.${fieldId}.label`);
  const getDataSourceOptionLabel = (fieldId: string, value: string) =>
    t(/* i18n-dynamic */ `reports.reportBuilder.dataSource.${builderType}.${fieldId}.options.${value}`);
  const getFilterOperatorLabel = (operator: string) =>
    t(/* i18n-dynamic */ `reports.reportBuilder.filterOperators.${operator}`);
  const getWeekDayLabel = (day: string) => t(/* i18n-dynamic */ `reports.reportBuilder.weekDays.${day}`);
  const getScheduleOptionLabel = (value: ReportSchedule) =>
    t(/* i18n-dynamic */ `reports.reportBuilder.scheduleOptions.${value}.label`);
  const getExportFormatLabel = (value: ReportFormat) =>
    t(/* i18n-dynamic */ `reports.reportBuilder.exportFormats.${value}.label`);
  const getExportFormatDescription = (value: ReportFormat) =>
    t(/* i18n-dynamic */ `reports.reportBuilder.exportFormats.${value}.description`);
  const getChartTypeLabel = (value: ChartType) => t(/* i18n-dynamic */ `reports.reportBuilder.chartTypes.${value}`);

  const fieldLabelMap = useMemo(() => {
    const map = new Map<string, string>();
    fieldDefinitions.forEach(field => {
      map.set(field.id, t(/* i18n-dynamic */ `reports.reportBuilder.fields.${builderType}.${field.id}`));
    });
    return map;
  }, [builderType, fieldDefinitions, t]);

  const getFieldLabel = (fieldId: string) => fieldLabelMap.get(fieldId) ?? formatLabel(fieldId);

  const groupedMetricKey = useMemo(() => {
    if (!groupBy) return '';
    if (aggregation.type === 'count') return 'count';
    return `${aggregation.type}_${aggregation.field || 'metric'}`;
  }, [aggregation, groupBy]);

  const groupedMetricLabel = useMemo(() => {
    if (!groupBy) return '';
    if (aggregation.type === 'count') return t('reports.reportBuilder.groupedMetric.count');
    const fieldLabel = aggregation.field ? getFieldLabel(aggregation.field) : t('reports.reportBuilder.groupedMetric.value');
    return t(/* i18n-dynamic */ `reports.reportBuilder.groupedMetric.${aggregation.type}`, { field: fieldLabel });
  }, [aggregation, groupBy, fieldLabelMap, t]);

  useEffect(() => {
    if (mode === 'adhoc') return;

    let mounted = true;
    const requestId = previewRequestIdRef.current + 1;
    previewRequestIdRef.current = requestId;
    setLivePreviewLoading(true);
    setLivePreviewError(undefined);

    const timer = window.setTimeout(async () => {
      try {
        const inheritedFilters =
          defaultValues?.filters && typeof defaultValues.filters === 'object' && !Array.isArray(defaultValues.filters)
            ? { ...(defaultValues.filters as Record<string, unknown>) }
            : {};

        const appendFilterValue = (key: string, value: string) => {
          const currentValues = Array.isArray(inheritedFilters[key]) ? inheritedFilters[key] as unknown[] : [];
          if (currentValues.includes(value)) return;
          inheritedFilters[key] = [...currentValues, value];
        };

        if (builderType === 'devices') {
          const platform = String(dataSource.platform ?? '');
          if (platform === 'windows' || platform === 'macos' || platform === 'linux') {
            inheritedFilters.osTypes = [platform];
          }
        }

        if (builderType === 'alerts') {
          const severity = String(dataSource.severity ?? '');
          if (severity && severity !== 'all') {
            appendFilterValue('severity', severity.toLowerCase());
          }
          const status = String(dataSource.status ?? '');
          if (status && status !== 'all') {
            appendFilterValue('status', status.toLowerCase());
          }
        }

        filterConditions.forEach(condition => {
          const expected = condition.value.trim().toLowerCase();
          if (!expected || condition.operator !== 'is') return;

          if (condition.field === 'severity' || condition.field === 'status') {
            appendFilterValue(condition.field, expected);
          }
          if ((condition.field === 'os' || condition.field === 'osType') && ['windows', 'macos', 'linux'].includes(expected)) {
            appendFilterValue('osTypes', expected);
          }
        });

        const config: Record<string, unknown> = {};
        if (defaultValues?.dateRange) {
          config.dateRange = defaultValues.dateRange;
        }
        if (Object.keys(inheritedFilters).length > 0) {
          config.filters = inheritedFilters;
        }

        const response = await fetchWithAuth('/reports/generate', {
          method: 'POST',
          body: JSON.stringify({
            type: builderToLegacyType[builderType],
            config,
            format: exportFormats[0] ?? 'csv',
            ...(currentOrgId ? { orgId: currentOrgId } : {})
          })
        });

        const payload = await response.json().catch(() => ({})) as {
          error?: string;
          data?: {
            rows?: unknown[];
            summary?: Record<string, unknown>;
          };
        };

        if (!response.ok) {
          throw new Error(payload.error || t('reports.reportBuilder.errors.loadLivePreview'));
        }

        if (!mounted || previewRequestIdRef.current !== requestId) return;

        const rows = Array.isArray(payload.data?.rows)
          ? payload.data.rows.filter((item): item is PreviewRow => Boolean(item) && typeof item === 'object')
          : [];
        const summary =
          payload.data?.summary && typeof payload.data.summary === 'object' && !Array.isArray(payload.data.summary)
            ? payload.data.summary
            : null;

        setLivePreviewRows(rows);
        setLivePreviewSummary(summary);
      } catch (err) {
        if (!mounted || previewRequestIdRef.current !== requestId) return;
        setLivePreviewRows([]);
        setLivePreviewSummary(null);
        setLivePreviewError(err instanceof Error ? err.message : t('reports.reportBuilder.errors.loadLivePreview'));
      } finally {
        if (!mounted || previewRequestIdRef.current !== requestId) return;
        setLivePreviewLoading(false);
      }
    }, 300);

    return () => {
      mounted = false;
      window.clearTimeout(timer);
    };
  }, [builderType, currentOrgId, dataSource, defaultValues?.dateRange, defaultValues?.filters, exportFormats, filterConditions, mode, t]);

  const normalizedPreviewRows = useMemo(
    () => livePreviewRows.map(row => normalizePreviewRow(builderType, row)),
    [builderType, livePreviewRows]
  );

  const advancedHostnameFilter = useMemo(() => {
    if (filterMode !== 'advanced' || deviceFilter.conditions.length === 0 || !deviceFilterPreview) {
      return null;
    }
    return new Set(deviceFilterPreview.devices.map(device => device.hostname.toLowerCase()));
  }, [deviceFilter.conditions.length, deviceFilterPreview, filterMode]);

  const filteredRows = useMemo(() => {
    if (normalizedPreviewRows.length === 0) return [];

    const enforceAdvanced =
      filterMode === 'advanced' && deviceFilter.conditions.length > 0 && !deviceFilterPreviewLoading;

    return normalizedPreviewRows.filter(row => {
      if (!rowMatchesSimpleFilters(row, filterConditions)) {
        return false;
      }

      if (!enforceAdvanced) {
        return true;
      }

      if (!advancedHostnameFilter || advancedHostnameFilter.size === 0) {
        return false;
      }

      const candidates = [row.hostname, row.device, row.deviceHostname, row.displayName]
        .filter((value): value is string => typeof value === 'string')
        .map(value => value.toLowerCase());

      return candidates.some(candidate => advancedHostnameFilter.has(candidate));
    });
  }, [
    advancedHostnameFilter,
    deviceFilter.conditions.length,
    deviceFilterPreviewLoading,
    filterConditions,
    filterMode,
    normalizedPreviewRows
  ]);

  const groupedRows = useMemo(() => {
    if (!groupBy) return [];
    const grouped = new Map<string, { count: number; sum: number }>();
    const fieldKey = aggregation.field ?? '';

    filteredRows.forEach(row => {
      const key = String(row[groupBy] ?? 'Unknown');
      const current = grouped.get(key) ?? { count: 0, sum: 0 };
      current.count += 1;
      if (aggregation.type !== 'count' && fieldKey) {
        const value = toNumber(row[fieldKey]);
        if (value !== null) {
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
  }, [aggregation, filteredRows, groupBy, groupedMetricKey]);

  const previewColumns = useMemo(() => {
    if (groupBy) {
      return [groupBy, groupedMetricKey].filter((value): value is string => Boolean(value));
    }
    const isAvailable = (field: string) =>
      filteredRows.some(row => row[field] !== undefined && row[field] !== null);

    const safeSelected = selectedFields.filter(isAvailable);
    if (safeSelected.length) return safeSelected;

    const safeDefaults = defaultFieldsByType[builderType].filter(isAvailable);
    if (safeDefaults.length) return safeDefaults;

    const firstRow = filteredRows[0];
    if (!firstRow) return [];
    return Object.keys(firstRow).slice(0, 6);
  }, [builderType, filteredRows, groupBy, groupedMetricKey, selectedFields]);

  const previewRows = useMemo(() => {
    const baseRows = groupBy ? groupedRows : filteredRows;
    return baseRows.slice(0, 5);
  }, [filteredRows, groupBy, groupedRows]);

  const chartSeries = useMemo(() => {
    if (groupBy) {
      return groupedRows.map(row => ({
        label: String(row[groupBy] ?? ''),
        value: Number(row[groupedMetricKey] ?? 0)
      }));
    }

    const summarySeries = Object.entries(livePreviewSummary ?? {})
      .filter(([, value]) => typeof value === 'number' && Number.isFinite(value))
      .map(([label, value]) => ({ label: formatLabel(label), value: Number(value) }));
    if (summarySeries.length > 0) {
      return summarySeries;
    }

    if (filteredRows.length === 0) {
      return [];
    }

    const preferredKeys = chartCategoryFieldByType[builderType];
    const categoryKey = preferredKeys.find(key =>
      filteredRows.some(row => {
        const value = row[key];
        return typeof value === 'string' && value.trim().length > 0;
      })
    );

    if (!categoryKey) return [];

    const buckets = new Map<string, number>();
    filteredRows.forEach(row => {
      const rawLabel = String(row[categoryKey] ?? 'Unknown').trim();
      const label = rawLabel || 'Unknown';
      buckets.set(label, (buckets.get(label) ?? 0) + 1);
    });

    return Array.from(buckets.entries())
      .sort((a, b) => b[1] - a[1])
      .slice(0, 8)
      .map(([label, value]) => ({ label, value }));
  }, [builderType, filteredRows, groupBy, groupedRows, groupedMetricKey, livePreviewSummary]);

  const maxSeriesValue = Math.max(1, ...chartSeries.map(series => series.value));

  const dataSourceSummary = useMemo(() => {
    return dataSourceFields
      .map(field => {
        const value = dataSource[field.id];
        const fieldLabel = getDataSourceFieldLabel(field.id);
        if (field.type === 'toggle') {
          return t('reports.reportBuilder.dataSourceSummary', {
            label: fieldLabel,
            value: value
              ? t('reports.reportBuilder.values.on')
              : t('reports.reportBuilder.values.off')
          });
        }
        if (field.type === 'select') {
          const optionValue = field.options?.find(option => option.value === value)?.value;
          const optionLabel = optionValue ? getDataSourceOptionLabel(field.id, optionValue) : value;
          return t('reports.reportBuilder.dataSourceSummary', { label: fieldLabel, value: optionLabel });
        }
        if (field.type === 'text') {
          return value ? t('reports.reportBuilder.dataSourceSummary', { label: fieldLabel, value }) : null;
        }
        return null;
      })
      .filter((value): value is string => Boolean(value));
  }, [builderType, dataSource, dataSourceFields, t]);

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
      setEmailError(t('reports.reportBuilder.errors.validEmail'));
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
    if (typeof value === 'number') return formatNumber(value);
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
      setError(err instanceof Error ? err.message : t('reports.reportBuilder.errors.generatePreview'));
    } finally {
      setPreviewing(false);
    }
  };

  const handleFormSubmit = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    setError(undefined);
    setEmailError(undefined);

    if (mode !== 'adhoc' && !reportName.trim()) {
      setError(t('reports.reportBuilder.errors.reportNameRequired'));
      return;
    }

    if (saveTemplate && !templateName.trim()) {
      setError(t('reports.reportBuilder.errors.templateNameRequired'));
      return;
    }

    if (exportFormats.length === 0) {
      setError(t('reports.reportBuilder.errors.selectExportFormat'));
      return;
    }

    const values = buildFormValues();
    const primaryFormat = values.format ?? 'pdf';

    const payload = {
      name: values.name || 'Untitled Report',
      type: values.type,
      schedule: values.schedule,
      format: primaryFormat,
      ...(currentOrgId ? { orgId: currentOrgId } : {}),
      config: {
        // Keys the builder doesn't own (posture thresholds, executive-summary
        // settings) come first so live builder state below still wins.
        ...baseConfig,
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
            format: primaryFormat,
            ...(currentOrgId ? { orgId: currentOrgId } : {})
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
        throw new Error(t('reports.reportBuilder.errors.saveReport'));
      }

      onSubmit?.(values);
    } catch (err) {
      setError(err instanceof Error ? err.message : t('reports.reportBuilder.errors.generic'));
    } finally {
      setSaving(false);
    }
  };

  const renderPreviewTable = (compact = false) => {
    if (previewColumns.length === 0) {
      return (
        <div className="rounded-md border border-dashed p-6 text-center text-sm text-muted-foreground">
          {t('reports.reportBuilder.previewTable.selectFields')}
        </div>
      );
    }

    return (
      <div className="overflow-hidden rounded-md border">
        <table className={cn('w-full text-left text-sm', compact && 'text-xs')}>
          <thead className="bg-muted/40">
            <tr>
              {previewColumns.map(column => (
                <th key={column} className="px-3 py-2 text-xs font-semibold uppercase tracking-wide text-muted-foreground">
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
          {t('reports.reportBuilder.chart.notEnoughData')}
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
                  className={cn(
                    'h-2 rounded-full',
                    chartColorClasses[index % chartColorClasses.length],
                    widthPercentClass(Math.round((item.value / maxSeriesValue) * 100))
                  )}
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
      let offset = 0;
      const segments = chartSeries.map((item, index) => {
        const percent = Math.max(0, (item.value / total) * 100);
        const segment = {
          key: `${item.label}-${index}`,
          percent,
          offset,
          color: chartColors[index % chartColors.length]
        };
        offset += percent;
        return segment;
      });

      return (
        <div className="flex flex-wrap items-center gap-6">
          <svg viewBox="0 0 36 36" className="h-28 w-28 -rotate-90" aria-label={t('reports.reportBuilder.chart.pieChartPreview')}>
            {segments.map((segment) => (
              <circle
                key={segment.key}
                cx="18"
                cy="18"
                r="15.9155"
                fill="none"
                stroke={segment.color}
                strokeWidth="8"
                strokeDasharray={`${segment.percent} ${100 - segment.percent}`}
                strokeDashoffset={`${25 - segment.offset}`}
              />
            ))}
          </svg>
          <div className="space-y-2 text-xs">
            {chartSeries.map((item, index) => (
              <div key={`${item.label}-${index}`} className="flex items-center gap-2">
                <span className={cn('h-2 w-2 rounded-full', chartColorClasses[index % chartColorClasses.length])} />
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

  const scheduleLabel = getScheduleOptionLabel(schedule);
  const scheduleDetail =
    schedule === 'weekly'
      ? getWeekDayLabel(scheduleDay)
      : schedule === 'monthly'
        ? t('reports.reportBuilder.scheduleDetail.day', { date: scheduleDate })
        : t('reports.reportBuilder.scheduleDetail.everyDay');

  const previewTypeLabel = getReportTypeOptionLabel(builderType);

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

        <div className="rounded-lg border bg-card p-6 shadow-xs space-y-4">
          <div>
            <h2 className="text-sm font-semibold">{t('reports.reportBuilder.sections.reportDetails.title')}</h2>
            <p className="text-xs text-muted-foreground">{t('reports.reportBuilder.sections.reportDetails.description')}</p>
          </div>

          <div className="grid gap-4 sm:grid-cols-2">
            <div className="space-y-2">
              <label htmlFor="report-name" className="text-sm font-medium">
                {t('reports.reportBuilder.fieldsShared.reportName')}
              </label>
              <input
                id="report-name"
                placeholder={t('reports.reportBuilder.placeholders.reportName')}
                value={reportName}
                onChange={event => setReportName(event.target.value)}
                className="h-10 w-full rounded-md border bg-background px-3 text-sm focus:outline-hidden focus:ring-2 focus:ring-ring"
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
                {t('reports.reportBuilder.fieldsShared.saveAsTemplate')}
              </label>
            </div>
          </div>

          {saveTemplate && (
            <div className="space-y-2">
              <label htmlFor="template-name" className="text-sm font-medium">
                {t('reports.reportBuilder.fieldsShared.templateName')}
              </label>
              <input
                id="template-name"
                placeholder={t('reports.reportBuilder.placeholders.templateName')}
                value={templateName}
                onChange={event => setTemplateName(event.target.value)}
                className="h-10 w-full rounded-md border bg-background px-3 text-sm focus:outline-hidden focus:ring-2 focus:ring-ring"
              />
            </div>
          )}
        </div>

        <div className="rounded-lg border bg-card p-6 shadow-xs space-y-4">
          <div className="flex items-center gap-2">
            <Monitor className="h-4 w-4 text-muted-foreground" />
            <div>
              <h2 className="text-sm font-semibold">{t('reports.reportBuilder.sections.reportType.title')}</h2>
              <p className="text-xs text-muted-foreground">{t('reports.reportBuilder.sections.reportType.description')}</p>
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
                    <span className="font-medium">{getReportTypeOptionLabel(type.value)}</span>
                  </div>
                  <p className="text-xs text-muted-foreground">{getReportTypeOptionDescription(type.value)}</p>
                </button>
              );
            })}
          </div>
        </div>

        <div className="rounded-lg border bg-card p-6 shadow-xs space-y-4">
          <div className="flex items-center gap-2">
            <Database className="h-4 w-4 text-muted-foreground" />
            <div>
              <h2 className="text-sm font-semibold">{t('reports.reportBuilder.sections.dataSource.title')}</h2>
              <p className="text-xs text-muted-foreground">{t('reports.reportBuilder.sections.dataSource.description')}</p>
            </div>
          </div>

          <div className="grid gap-4 sm:grid-cols-2">
            {dataSourceFields.map(field => (
              <div key={field.id} className="space-y-2">
                <label className="text-xs font-medium text-muted-foreground">{getDataSourceFieldLabel(field.id)}</label>
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
                    {field.helper ?? t('reports.reportBuilder.values.enabled')}
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
                    className="h-10 w-full rounded-md border bg-background px-3 text-sm focus:outline-hidden focus:ring-2 focus:ring-ring"
                  >
                    {field.options?.map(option => (
                      <option key={option.value} value={option.value}>
                        {getDataSourceOptionLabel(field.id, option.value)}
                      </option>
                    ))}
                  </select>
                )}
              </div>
            ))}
          </div>
        </div>

        <div className="rounded-lg border bg-card p-6 shadow-xs space-y-4">
          <div className="flex items-center gap-2">
            <Columns className="h-4 w-4 text-muted-foreground" />
            <div>
              <h2 className="text-sm font-semibold">{t('reports.reportBuilder.sections.columns.title')}</h2>
              <p className="text-xs text-muted-foreground">{t('reports.reportBuilder.sections.columns.description')}</p>
            </div>
          </div>

          <div className="grid gap-4 lg:grid-cols-2">
            <div className="space-y-3">
              <p className="text-xs font-medium text-muted-foreground">{t('reports.reportBuilder.availableFields')}</p>
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
                      {getFieldLabel(field.id)}
                    </button>
                  );
                })}
              </div>
            </div>
            <div className="space-y-3">
              <p className="text-xs font-medium text-muted-foreground">{t('reports.reportBuilder.selectedFields')}</p>
              {selectedFields.length === 0 ? (
                <div className="rounded-md border border-dashed p-4 text-xs text-muted-foreground">
                  {t('reports.reportBuilder.noFieldsSelected')}
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

        <div className="rounded-lg border bg-card p-6 shadow-xs space-y-4">
          <div className="flex items-center justify-between">
            <div className="flex items-center gap-2">
              <Filter className="h-4 w-4 text-muted-foreground" />
              <div>
                <h2 className="text-sm font-semibold">{t('reports.reportBuilder.sections.filters.title')}</h2>
                <p className="text-xs text-muted-foreground">{t('reports.reportBuilder.sections.filters.description')}</p>
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
                {t('reports.reportBuilder.filterModes.recordFilters')}
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
                {t('reports.reportBuilder.filterModes.deviceFilter')}
              </button>
            </div>
          </div>

          {filterMode === 'simple' ? (
            <>
              {filterConditions.length === 0 ? (
                <div className="rounded-md border border-dashed p-4 text-xs text-muted-foreground">
                  {t('reports.reportBuilder.noFilters')}
                </div>
              ) : (
                <div className="space-y-3">
                  {filterConditions.map((condition, index) => (
                    <div key={condition.id} className="grid gap-2 sm:grid-cols-[80px_1fr_1fr_1fr_auto]">
                      {index === 0 ? (
                        <div className="text-xs font-medium uppercase tracking-wide text-muted-foreground self-center">
                          {t('reports.reportBuilder.where')}
                        </div>
                      ) : (
                        <select
                          value={condition.logic}
                          onChange={event => updateFilterCondition(condition.id, { logic: event.target.value as 'and' | 'or' })}
                          className="h-9 rounded-md border bg-background px-2 text-xs focus:outline-hidden focus:ring-2 focus:ring-ring"
                        >
                          <option value="and">{t('reports.reportBuilder.logic.and')}</option>
                          <option value="or">{t('reports.reportBuilder.logic.or')}</option>
                        </select>
                      )}
                      <select
                        value={condition.field}
                        onChange={event => updateFilterCondition(condition.id, { field: event.target.value })}
                        className="h-9 rounded-md border bg-background px-2 text-xs focus:outline-hidden focus:ring-2 focus:ring-ring"
                      >
                        {fieldDefinitions.map(field => (
                          <option key={field.id} value={field.id}>
                            {getFieldLabel(field.id)}
                          </option>
                        ))}
                      </select>
                      <select
                        value={condition.operator}
                        onChange={event => updateFilterCondition(condition.id, { operator: event.target.value })}
                        className="h-9 rounded-md border bg-background px-2 text-xs focus:outline-hidden focus:ring-2 focus:ring-ring"
                      >
                        {filterOperators.map(operator => (
                          <option key={operator.value} value={operator.value}>
                            {getFilterOperatorLabel(operator.value)}
                          </option>
                        ))}
                      </select>
                      <input
                        value={condition.value}
                        onChange={event => updateFilterCondition(condition.id, { value: event.target.value })}
                        className="h-9 rounded-md border bg-background px-2 text-xs focus:outline-hidden focus:ring-2 focus:ring-ring"
                        placeholder={t('reports.reportBuilder.placeholders.value')}
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
                {t('reports.reportBuilder.addCondition')}
              </button>
            </>
          ) : (
            <div className="space-y-4">
              <p className="text-xs text-muted-foreground">
                {t('reports.reportBuilder.deviceFilterDescription')}
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

        <div className="rounded-lg border bg-card p-6 shadow-xs space-y-4">
          <div className="flex items-center gap-2">
            <BarChart3 className="h-4 w-4 text-muted-foreground" />
            <div>
              <h2 className="text-sm font-semibold">{t('reports.reportBuilder.sections.grouping.title')}</h2>
              <p className="text-xs text-muted-foreground">{t('reports.reportBuilder.sections.grouping.description')}</p>
            </div>
          </div>

          <div className="grid gap-4 sm:grid-cols-2">
            <div className="space-y-2">
              <label className="text-xs font-medium text-muted-foreground">{t('reports.reportBuilder.groupBy')}</label>
              <select
                value={groupBy}
                onChange={event => setGroupBy(event.target.value)}
                className="h-10 w-full rounded-md border bg-background px-3 text-sm focus:outline-hidden focus:ring-2 focus:ring-ring"
              >
                <option value="">{t('reports.reportBuilder.noGrouping')}</option>
                {groupByOptions.map(field => (
                  <option key={field.id} value={field.id}>
                    {getFieldLabel(field.id)}
                  </option>
                ))}
              </select>
            </div>
            <div className="space-y-2">
              <label className="text-xs font-medium text-muted-foreground">{t('reports.reportBuilder.aggregation')}</label>
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
                className="h-10 w-full rounded-md border bg-background px-3 text-sm focus:outline-hidden focus:ring-2 focus:ring-ring"
              >
                <option value="count">{t('reports.reportBuilder.aggregationOptions.count')}</option>
                <option value="sum">{t('reports.reportBuilder.aggregationOptions.sum')}</option>
                <option value="avg">{t('reports.reportBuilder.aggregationOptions.avg')}</option>
              </select>
            </div>
          </div>

          {aggregation.type !== 'count' && (
            <div className="space-y-2">
              <label className="text-xs font-medium text-muted-foreground">{t('reports.reportBuilder.aggregationField')}</label>
              <select
                value={aggregation.field ?? ''}
                onChange={event => setAggregation(prev => ({ ...prev, field: event.target.value }))}
                className="h-10 w-full rounded-md border bg-background px-3 text-sm focus:outline-hidden focus:ring-2 focus:ring-ring"
              >
                {numericFields.length === 0 && <option value="">{t('reports.reportBuilder.noNumericFields')}</option>}
                {numericFields.map(field => (
                  <option key={field.id} value={field.id}>
                    {getFieldLabel(field.id)}
                  </option>
                ))}
              </select>
            </div>
          )}
        </div>

        <div className="rounded-lg border bg-card p-6 shadow-xs space-y-4">
          <div className="flex items-center gap-2">
            <PieChart className="h-4 w-4 text-muted-foreground" />
            <div>
              <h2 className="text-sm font-semibold">{t('reports.reportBuilder.sections.chartType.title')}</h2>
              <p className="text-xs text-muted-foreground">{t('reports.reportBuilder.sections.chartType.description')}</p>
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
                  {getChartTypeLabel(option.value)}
                </button>
              );
            })}
          </div>
        </div>

        {showDelivery && (
          <div className="rounded-lg border bg-card p-6 shadow-xs space-y-5">
            <div className="flex items-center gap-2">
              <Calendar className="h-4 w-4 text-muted-foreground" />
              <div>
                <h2 className="text-sm font-semibold">{t('reports.reportBuilder.sections.delivery.title')}</h2>
                <p className="text-xs text-muted-foreground">{t('reports.reportBuilder.sections.delivery.description')}</p>
              </div>
            </div>

            <div className="space-y-3">
              <p className="text-xs font-medium text-muted-foreground">{t('reports.reportBuilder.schedule')}</p>
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
                    {getScheduleOptionLabel(option.value)}
                  </button>
                ))}
              </div>

              <div className="grid gap-3 sm:grid-cols-3">
                <div className="space-y-2">
                  <label className="text-xs font-medium text-muted-foreground">{t('reports.reportBuilder.runTime')}</label>
                  <input
                    type="time"
                    value={scheduleTime}
                    onChange={event => setScheduleTime(event.target.value)}
                    className="h-9 w-full rounded-md border bg-background px-2 text-xs focus:outline-hidden focus:ring-2 focus:ring-ring"
                  />
                </div>
                {schedule === 'weekly' && (
                  <div className="space-y-2">
                    <label className="text-xs font-medium text-muted-foreground">{t('reports.reportBuilder.dayOfWeek')}</label>
                    <select
                      value={scheduleDay}
                      onChange={event => setScheduleDay(event.target.value)}
                      className="h-9 w-full rounded-md border bg-background px-2 text-xs focus:outline-hidden focus:ring-2 focus:ring-ring"
                    >
                      {weekDays.map(day => (
                        <option key={day.value} value={day.value}>
                          {getWeekDayLabel(day.value)}
                        </option>
                      ))}
                    </select>
                  </div>
                )}
                {schedule === 'monthly' && (
                  <div className="space-y-2">
                    <label className="text-xs font-medium text-muted-foreground">{t('reports.reportBuilder.dayOfMonth')}</label>
                    <select
                      value={scheduleDate}
                      onChange={event => setScheduleDate(event.target.value)}
                      className="h-9 w-full rounded-md border bg-background px-2 text-xs focus:outline-hidden focus:ring-2 focus:ring-ring"
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
              <p className="text-xs font-medium text-muted-foreground">{t('reports.reportBuilder.exportFormatsTitle')}</p>
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
                      <span className="font-medium">{getExportFormatLabel(format.value)}</span>
                      <span className="text-muted-foreground">{getExportFormatDescription(format.value)}</span>
                    </button>
                  );
                })}
              </div>
            </div>

            <div className="space-y-3">
              <div className="flex items-center gap-2">
                <Mail className="h-4 w-4 text-muted-foreground" />
                <p className="text-xs font-medium text-muted-foreground">{t('reports.reportBuilder.emailDistributionList')}</p>
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
                  placeholder={t('reports.reportBuilder.placeholders.email')}
                  className="h-9 flex-1 rounded-md border bg-background px-2 text-xs focus:outline-hidden focus:ring-2 focus:ring-ring"
                />
                <button
                  type="button"
                  onClick={addEmailRecipient}
                  className="h-9 rounded-md border px-3 text-xs font-medium hover:bg-muted"
                >
                  {t('reports.reportBuilder.addRecipient')}
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
              {t('reports.reportBuilder.actions.cancel')}
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
              {t('reports.reportBuilder.actions.preview')}
            </button>
          )}

          <button
            data-testid="report-builder-submit"
            type="submit"
            disabled={saving}
            className="flex h-11 w-full items-center justify-center gap-2 rounded-md bg-primary text-sm font-medium text-primary-foreground transition hover:opacity-90 disabled:opacity-60 sm:w-auto sm:px-6"
          >
            {saving ? <Loader2 className="h-4 w-4 animate-spin" /> : <Save className="h-4 w-4" />}
            {mode === 'edit'
              ? t('reports.reportBuilder.actions.updateReport')
              : mode === 'adhoc'
                ? t('reports.reportBuilder.actions.generateReport')
                : t('reports.reportBuilder.actions.saveReport')}
          </button>
        </div>
      </div>

      <div className="space-y-6 lg:sticky lg:top-6 self-start">
        <div className="rounded-lg border bg-card p-6 shadow-xs space-y-5">
          <div className="flex items-center justify-between">
            <div>
              <h2 className="text-sm font-semibold">{t('reports.reportBuilder.livePreview.title')}</h2>
              <p className="text-xs text-muted-foreground">{t('reports.reportBuilder.livePreview.description')}</p>
            </div>
            <span className="rounded-full border px-2 py-1 text-xs text-muted-foreground">
              {chartType.toUpperCase()}
            </span>
          </div>

          <div className="space-y-1">
            <h3 className="text-lg font-semibold">{reportName || t('reports.reportBuilder.livePreview.untitledReport')}</h3>
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
            <p className="text-xs font-medium text-muted-foreground">{t('reports.reportBuilder.sections.dataSource.title')}</p>
            <div className="flex flex-wrap gap-2">
              {dataSourceSummary.map(summary => (
                <span key={summary} className="rounded-md border px-2 py-1 text-xs text-muted-foreground">
                  {summary}
                </span>
              ))}
            </div>
          </div>

          <div className="rounded-md border bg-muted/10 p-4 space-y-4">
            {livePreviewLoading && (
              <div className="flex items-center justify-center gap-2 rounded-md border border-dashed p-6 text-sm text-muted-foreground">
                <Loader2 className="h-4 w-4 animate-spin" />
                {t('reports.reportBuilder.livePreview.loading')}
              </div>
            )}

            {!livePreviewLoading && livePreviewError && (
              <div className="rounded-md border border-destructive/40 bg-destructive/10 p-4 text-sm text-destructive">
                {livePreviewError}
              </div>
            )}

            {!livePreviewLoading && !livePreviewError && previewRows.length === 0 && (
              <div className="rounded-md border border-dashed p-6 text-center text-sm text-muted-foreground">
                {t('reports.reportBuilder.livePreview.noData')}
              </div>
            )}

            {!livePreviewLoading && !livePreviewError && previewRows.length > 0 && (
              <>
                {chartType === 'table' ? (
                  renderPreviewTable()
                ) : (
                  <>
                    {renderChart()}
                    <div className="space-y-2">
                      <p className="text-xs font-medium text-muted-foreground">{t('reports.reportBuilder.livePreview.previewRows')}</p>
                      {renderPreviewTable(true)}
                    </div>
                  </>
                )}
              </>
            )}
          </div>
        </div>
      </div>
    </form>
  );
}
