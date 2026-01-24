import { useCallback, useEffect, useMemo, useState } from 'react';
import {
  AlertCircle,
  AlertTriangle,
  Calendar,
  CheckCircle,
  ClipboardCheck,
  Download,
  FileText,
  Image,
  Link2,
  Loader2,
  Monitor,
  ShieldCheck,
  User,
  XCircle
} from 'lucide-react';
import {
  CartesianGrid,
  Line,
  LineChart,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis
} from 'recharts';
import { cn } from '@/lib/utils';
import { fetchWithAuth } from '../../stores/auth';

type FrameworkOption = {
  id: string;
  label: string;
};

type ComplianceSummary = {
  total: number;
  passing: number;
  failing: number;
  warning: number;
};

type ComplianceTrendPoint = {
  date: string;
  percent: number;
};

type EvidenceType = 'document' | 'screenshot' | 'link' | 'other';

type EvidenceItem = {
  id: string;
  title: string;
  type: EvidenceType;
  linkedBy?: string;
  linkedAt?: string;
  controlId?: string;
};

type RemediationStatus = 'open' | 'in_progress' | 'blocked' | 'resolved' | 'scheduled';

type RemediationItem = {
  id: string;
  title: string;
  assignee?: string;
  dueDate?: string;
  status: RemediationStatus;
};

type ComplianceStatusData = {
  framework: string;
  compliancePercent: number;
  summary: ComplianceSummary;
  trend: ComplianceTrendPoint[];
  evidence: EvidenceItem[];
  remediations: RemediationItem[];
};

type ControlStatus = 'pass' | 'fail' | 'warning' | 'not_applicable' | 'unknown';

type ControlDevice = {
  id: string;
  name: string;
  ip?: string;
  status?: ControlStatus;
};

type ComplianceControl = {
  id: string;
  title: string;
  description?: string;
  category?: string;
  owner?: string;
  status: ControlStatus;
  evidenceCount: number;
  affectedDevices: ControlDevice[];
  lastChecked?: string;
};

const frameworks: FrameworkOption[] = [
  { id: 'cis', label: 'CIS' },
  { id: 'nist', label: 'NIST' },
  { id: 'hipaa', label: 'HIPAA' },
  { id: 'soc2', label: 'SOC2' },
  { id: 'custom', label: 'Custom' }
];

const tooltipStyle = {
  backgroundColor: 'hsl(var(--card))',
  border: '1px solid hsl(var(--border))',
  borderRadius: '0.5rem',
  fontSize: '12px'
};

const controlStatusConfig: Record<
  ControlStatus,
  { label: string; icon: typeof CheckCircle; iconClass: string; badgeClass: string }
> = {
  pass: {
    label: 'Pass',
    icon: CheckCircle,
    iconClass: 'text-green-600',
    badgeClass: 'border-green-500/40 bg-green-500/10 text-green-700'
  },
  fail: {
    label: 'Fail',
    icon: XCircle,
    iconClass: 'text-red-600',
    badgeClass: 'border-red-500/40 bg-red-500/10 text-red-700'
  },
  warning: {
    label: 'Warning',
    icon: AlertTriangle,
    iconClass: 'text-yellow-600',
    badgeClass: 'border-yellow-500/40 bg-yellow-500/10 text-yellow-700'
  },
  not_applicable: {
    label: 'N/A',
    icon: AlertCircle,
    iconClass: 'text-muted-foreground',
    badgeClass: 'border-muted bg-muted/40 text-muted-foreground'
  },
  unknown: {
    label: 'Unknown',
    icon: AlertCircle,
    iconClass: 'text-muted-foreground',
    badgeClass: 'border-muted bg-muted/40 text-muted-foreground'
  }
};

const remediationStatusConfig: Record<
  RemediationStatus,
  { label: string; className: string }
> = {
  open: {
    label: 'Open',
    className: 'border-red-500/40 bg-red-500/10 text-red-700'
  },
  in_progress: {
    label: 'In progress',
    className: 'border-yellow-500/40 bg-yellow-500/10 text-yellow-700'
  },
  blocked: {
    label: 'Blocked',
    className: 'border-orange-500/40 bg-orange-500/10 text-orange-700'
  },
  resolved: {
    label: 'Resolved',
    className: 'border-green-500/40 bg-green-500/10 text-green-700'
  },
  scheduled: {
    label: 'Scheduled',
    className: 'border-blue-500/40 bg-blue-500/10 text-blue-700'
  }
};

const evidenceTypeConfig: Record<EvidenceType, { label: string; icon: typeof FileText }> = {
  document: { label: 'Document', icon: FileText },
  screenshot: { label: 'Screenshot', icon: Image },
  link: { label: 'Link', icon: Link2 },
  other: { label: 'Evidence', icon: FileText }
};

function toNumber(value: unknown, fallback = 0): number {
  if (value === null || value === undefined || value === '') return fallback;
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : fallback;
}

function toString(value: unknown, fallback = ''): string {
  if (value === null || value === undefined) return fallback;
  return String(value);
}

function clampPercent(value: number): number {
  return Math.max(0, Math.min(100, Math.round(value)));
}

function formatDate(value?: string): string {
  if (!value) return 'TBD';
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return value;
  return date.toLocaleDateString(undefined, { month: 'short', day: 'numeric', year: 'numeric' });
}

function normalizeControlStatus(value: unknown): ControlStatus {
  const text = toString(value).toLowerCase();
  if (['pass', 'passed', 'compliant', 'ok', 'success'].includes(text)) return 'pass';
  if (['fail', 'failed', 'non_compliant', 'noncompliant', 'error'].includes(text)) return 'fail';
  if (['warn', 'warning', 'partial', 'needs_attention', 'at_risk'].includes(text)) return 'warning';
  if (['na', 'n/a', 'not_applicable', 'not applicable'].includes(text)) return 'not_applicable';
  return 'unknown';
}

function normalizeRemediationStatus(value: unknown): RemediationStatus {
  const text = toString(value).toLowerCase();
  if (['open', 'new', 'todo'].includes(text)) return 'open';
  if (['in_progress', 'in progress', 'working'].includes(text)) return 'in_progress';
  if (['blocked', 'on_hold', 'on hold'].includes(text)) return 'blocked';
  if (['resolved', 'closed', 'done', 'complete'].includes(text)) return 'resolved';
  if (['scheduled', 'planned'].includes(text)) return 'scheduled';
  return 'open';
}

function normalizeEvidenceType(value: unknown): EvidenceType {
  const text = toString(value).toLowerCase();
  if (['doc', 'document', 'policy', 'file', 'pdf'].includes(text)) return 'document';
  if (['screenshot', 'image', 'photo', 'png', 'jpg'].includes(text)) return 'screenshot';
  if (['link', 'url', 'uri'].includes(text)) return 'link';
  return 'other';
}

function extractRecordArray(value: unknown): Record<string, unknown>[] {
  if (!Array.isArray(value)) return [];
  return value.filter(item => item && typeof item === 'object') as Record<string, unknown>[];
}

function normalizeEvidence(raw: Record<string, unknown>, index: number): EvidenceItem {
  const id = toString(raw.id ?? raw.evidenceId ?? raw.key, `evidence-${index + 1}`);
  const title = toString(raw.title ?? raw.name ?? raw.filename, `Evidence ${index + 1}`);
  const type = normalizeEvidenceType(raw.type ?? raw.kind ?? raw.category ?? raw.mimeType);
  const linkedBy = raw.linkedBy ?? raw.owner ?? raw.uploader;
  const linkedAt = raw.linkedAt ?? raw.createdAt ?? raw.date;
  const controlId = raw.controlId ?? raw.control_id ?? raw.control;

  return {
    id,
    title,
    type,
    linkedBy: linkedBy ? toString(linkedBy) : undefined,
    linkedAt: linkedAt ? toString(linkedAt) : undefined,
    controlId: controlId ? toString(controlId) : undefined
  };
}

function normalizeRemediation(raw: Record<string, unknown>, index: number): RemediationItem {
  const id = toString(raw.id ?? raw.issueId ?? raw.key, `issue-${index + 1}`);
  const title = toString(raw.title ?? raw.name ?? raw.summary, `Issue ${index + 1}`);
  const assignee = raw.assignee ?? raw.owner ?? raw.assignedTo;
  const dueDate = raw.dueDate ?? raw.due_at ?? raw.due;
  const status = normalizeRemediationStatus(raw.status ?? raw.state ?? raw.progress);

  return {
    id,
    title,
    assignee: assignee ? toString(assignee) : undefined,
    dueDate: dueDate ? toString(dueDate) : undefined,
    status
  };
}

function normalizeDevice(raw: Record<string, unknown>, index: number): ControlDevice {
  const id = toString(raw.id ?? raw.deviceId ?? raw.device_id ?? raw.key, `device-${index + 1}`);
  const name = toString(raw.name ?? raw.deviceName ?? raw.hostname ?? raw.label, `Device ${index + 1}`);
  const ip = raw.ip ?? raw.ipAddress ?? raw.address;
  const status = normalizeControlStatus(raw.status ?? raw.complianceStatus ?? raw.state);

  return {
    id,
    name,
    ip: ip ? toString(ip) : undefined,
    status
  };
}

function normalizeControl(raw: Record<string, unknown>, index: number): ComplianceControl {
  const id = toString(raw.id ?? raw.controlId ?? raw.control_id ?? raw.key, `control-${index + 1}`);
  const title = toString(raw.title ?? raw.name ?? raw.controlName, `Control ${index + 1}`);
  const description = raw.description ?? raw.summary;
  const category = raw.category ?? raw.family ?? raw.domain;
  const owner = raw.owner ?? raw.assignee ?? raw.controlOwner;
  const status = normalizeControlStatus(raw.status ?? raw.result ?? raw.state ?? raw.compliance);
  const evidenceList = Array.isArray(raw.evidence) ? raw.evidence : undefined;
  const evidenceCount = toNumber(
    raw.evidenceCount ?? raw.evidence_count ?? raw.evidenceTotal ?? evidenceList?.length,
    0
  );
  const devicesRaw = raw.affectedDevices ?? raw.devices ?? raw.impactedDevices ?? raw.affected;
  const affectedDevices = extractRecordArray(devicesRaw).map((device, deviceIndex) =>
    normalizeDevice(device, deviceIndex)
  );
  const lastChecked = raw.lastCheckedAt ?? raw.lastChecked ?? raw.updatedAt ?? raw.checkedAt;

  return {
    id,
    title,
    description: description ? toString(description) : undefined,
    category: category ? toString(category) : undefined,
    owner: owner ? toString(owner) : undefined,
    status,
    evidenceCount,
    affectedDevices,
    lastChecked: lastChecked ? toString(lastChecked) : undefined
  };
}

function normalizeControls(payload: unknown): ComplianceControl[] {
  if (!payload || typeof payload !== 'object') return [];
  const record = payload as Record<string, unknown>;
  const nested = record.data && typeof record.data === 'object' && !Array.isArray(record.data)
    ? (record.data as Record<string, unknown>)
    : undefined;
  const list =
    record.controls ??
    record.items ??
    record.results ??
    nested?.controls ??
    nested?.items ??
    nested?.results ??
    record.data ??
    record.rows ??
    (Array.isArray(payload) ? payload : []);

  return extractRecordArray(list).map((item, index) => normalizeControl(item, index));
}

function normalizeStatus(payload: unknown, framework: string): ComplianceStatusData {
  const record = payload && typeof payload === 'object' ? (payload as Record<string, unknown>) : {};
  const root = record.data && typeof record.data === 'object' && !Array.isArray(record.data)
    ? (record.data as Record<string, unknown>)
    : record;
  const summaryRaw =
    (root.summary && typeof root.summary === 'object' ? root.summary : undefined) ??
    (root.overview && typeof root.overview === 'object' ? root.overview : undefined);

  const summary = summaryRaw as Record<string, unknown> | undefined;
  const passing = toNumber(summary?.passing ?? summary?.passed ?? root.passing ?? root.passed ?? root.controlsPassing);
  const failing = toNumber(summary?.failing ?? summary?.failed ?? root.failing ?? root.failed ?? root.controlsFailing);
  const warning = toNumber(summary?.warning ?? summary?.warnings ?? root.warning ?? root.warnings ?? root.controlsWarning);
  let total = toNumber(summary?.total ?? root.total ?? root.totalControls ?? root.controlsTotal);
  if (total === 0) {
    total = passing + failing + warning;
  }

  const percentValue = toNumber(
    root.compliancePercent ?? root.complianceScore ?? summary?.compliancePercent ?? summary?.score ?? root.percent,
    -1
  );
  let compliancePercent =
    percentValue >= 0 ? percentValue : total > 0 ? Math.round((passing / total) * 100) : 0;
  if (compliancePercent > 0 && compliancePercent <= 1) {
    compliancePercent = compliancePercent * 100;
  }
  compliancePercent = clampPercent(compliancePercent);

  const trendSource =
    root.trend ?? root.history ?? root.complianceTrend ?? root.complianceHistory ?? root.timeline ?? [];
  const trendList = Array.isArray(trendSource) ? trendSource : [];
  const trend = trendList.map((point, index) => {
    if (point && typeof point === 'object') {
      const record = point as Record<string, unknown>;
      const date = toString(record.date ?? record.timestamp ?? record.period ?? record.label, `Period ${index + 1}`);
      let percent = toNumber(record.percent ?? record.value ?? record.compliance ?? record.score, 0);
      if (percent > 0 && percent <= 1) {
        percent = percent * 100;
      }
      return { date, percent: clampPercent(percent) };
    }
    let percent = toNumber(point, 0);
    if (percent > 0 && percent <= 1) {
      percent = percent * 100;
    }
    return { date: `Period ${index + 1}`, percent: clampPercent(percent) };
  });

  const evidenceSource = root.evidence ?? root.evidenceItems ?? root.documents ?? root.files ?? [];
  const evidence = extractRecordArray(evidenceSource).map((item, index) => normalizeEvidence(item, index));

  const remediationSource = root.remediations ?? root.issues ?? root.findings ?? root.remediationItems ?? [];
  const remediations = extractRecordArray(remediationSource).map((item, index) =>
    normalizeRemediation(item, index)
  );

  return {
    framework,
    compliancePercent,
    summary: {
      total,
      passing,
      failing,
      warning
    },
    trend,
    evidence,
    remediations
  };
}

function buildQuery(framework: string): string {
  const params = new URLSearchParams();
  if (framework) params.set('framework', framework);
  const query = params.toString();
  return query ? `?${query}` : '';
}

export default function ComplianceDashboard() {
  const [framework, setFramework] = useState<string>(frameworks[0]?.id ?? 'cis');
  const [statusData, setStatusData] = useState<ComplianceStatusData | null>(null);
  const [controls, setControls] = useState<ComplianceControl[]>([]);
  const [selectedControlId, setSelectedControlId] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string>();

  const fetchCompliance = useCallback(async (selectedFramework: string) => {
    try {
      setLoading(true);
      setError(undefined);
      const query = buildQuery(selectedFramework);
      const [statusResponse, controlsResponse] = await Promise.all([
        fetchWithAuth(`/policies/compliance/status${query}`),
        fetchWithAuth(`/policies/compliance/controls${query}`)
      ]);

      if (!statusResponse.ok) {
        throw new Error('Failed to fetch compliance status');
      }
      if (!controlsResponse.ok) {
        throw new Error('Failed to fetch compliance controls');
      }

      const statusPayload = await statusResponse.json();
      const controlsPayload = await controlsResponse.json();

      setStatusData(normalizeStatus(statusPayload, selectedFramework));
      setControls(normalizeControls(controlsPayload));
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to fetch compliance data');
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    fetchCompliance(framework);
  }, [fetchCompliance, framework]);

  useEffect(() => {
    if (controls.length === 0) {
      setSelectedControlId(null);
      return;
    }

    const firstControl = controls[0];
    setSelectedControlId(prev => (prev && controls.some(control => control.id === prev) ? prev : firstControl?.id ?? null));
  }, [controls]);

  const frameworkLabel = useMemo(
    () => frameworks.find(option => option.id === framework)?.label ?? framework,
    [framework]
  );

  const controlSummary = useMemo(() => {
    return controls.reduce(
      (acc, control) => {
        acc.total += 1;
        if (control.status === 'pass') acc.passing += 1;
        if (control.status === 'fail') acc.failing += 1;
        if (control.status === 'warning') acc.warning += 1;
        return acc;
      },
      { total: 0, passing: 0, failing: 0, warning: 0 }
    );
  }, [controls]);

  const summary: ComplianceSummary = statusData?.summary.total
    ? statusData.summary
    : {
        total: controlSummary.total,
        passing: controlSummary.passing,
        failing: controlSummary.failing,
        warning: controlSummary.warning
      };

  const derivedCompliance = summary.total > 0 ? clampPercent((summary.passing / summary.total) * 100) : 0;
  const compliancePercent = statusData?.summary.total ? statusData.compliancePercent : derivedCompliance;
  const trend = statusData?.trend ?? [];
  const evidenceItems = statusData?.evidence ?? [];
  const remediations = statusData?.remediations ?? [];

  const selectedControl = useMemo(() => {
    if (!selectedControlId) return controls[0] ?? null;
    return controls.find(control => control.id === selectedControlId) ?? controls[0] ?? null;
  }, [controls, selectedControlId]);

  const controlLookup = useMemo(() => {
    const map = new Map<string, string>();
    controls.forEach(control => {
      map.set(control.id, control.title);
    });
    return map;
  }, [controls]);

  const handleExport = async () => {
    const params = new URLSearchParams({
      framework,
      format: 'pdf',
      includeEvidence: 'true'
    });
    try {
      const response = await fetchWithAuth(`/policies/compliance/report?${params.toString()}`);
      if (response.ok) {
        const blob = await response.blob();
        const url = URL.createObjectURL(blob);
        const link = document.createElement('a');
        link.href = url;
        link.download = `compliance-report-${framework}.pdf`;
        link.click();
        URL.revokeObjectURL(url);
      }
    } catch (err) {
      console.error('Failed to export report:', err);
    }
  };

  if (loading && !statusData && controls.length === 0) {
    return (
      <div className="flex items-center justify-center py-12">
        <div className="text-center">
          <Loader2 className="mx-auto h-8 w-8 animate-spin text-muted-foreground" />
          <p className="mt-4 text-sm text-muted-foreground">Loading compliance data...</p>
        </div>
      </div>
    );
  }

  if (error && !statusData && controls.length === 0) {
    return (
      <div className="rounded-lg border border-destructive/40 bg-destructive/10 p-6 text-center">
        <p className="text-sm text-destructive">{error}</p>
        <button
          type="button"
          onClick={() => fetchCompliance(framework)}
          className="mt-4 rounded-md bg-primary px-4 py-2 text-sm font-medium text-primary-foreground hover:opacity-90"
        >
          Try again
        </button>
      </div>
    );
  }

  return (
    <div className="space-y-6">
      <div className="flex flex-col gap-4 sm:flex-row sm:items-center sm:justify-between">
        <div>
          <h1 className="text-2xl font-semibold">Compliance Dashboard</h1>
          <p className="text-sm text-muted-foreground">
            Track {frameworkLabel} controls, evidence, and remediation readiness.
          </p>
        </div>
        <div className="flex flex-col gap-2 sm:flex-row sm:items-center">
          <select
            value={framework}
            onChange={event => setFramework(event.target.value)}
            className="h-10 w-full rounded-md border bg-background px-3 text-sm focus:outline-none focus:ring-2 focus:ring-ring sm:w-44"
          >
            {frameworks.map(option => (
              <option key={option.id} value={option.id}>
                {option.label}
              </option>
            ))}
          </select>
          <button
            type="button"
            onClick={handleExport}
            className="inline-flex h-10 items-center justify-center gap-2 rounded-md bg-primary px-4 text-sm font-medium text-primary-foreground hover:opacity-90"
          >
            <Download className="h-4 w-4" />
            Export PDF
          </button>
        </div>
      </div>

      {error && (
        <div className="rounded-lg border border-destructive/40 bg-destructive/10 px-4 py-3 text-sm text-destructive">
          {error}
        </div>
      )}

      <div className="grid gap-6 lg:grid-cols-3">
        <div className="rounded-lg border bg-card p-6 shadow-sm">
          <div className="flex items-center gap-2 text-sm text-muted-foreground">
            <ShieldCheck className="h-4 w-4" />
            Overall compliance
          </div>
          <div className="mt-6 flex flex-col items-center gap-4">
            <div className="relative h-36 w-36">
              <div
                className="absolute inset-0 rounded-full"
                style={{
                  background: `conic-gradient(hsl(var(--primary)) ${compliancePercent * 3.6}deg, hsl(var(--muted)) 0deg)`
                }}
              />
              <div className="absolute inset-3 rounded-full bg-card" />
              <div className="absolute inset-0 flex items-center justify-center text-center">
                <div>
                  <p className="text-3xl font-semibold">{compliancePercent}%</p>
                  <p className="text-xs text-muted-foreground">Compliant</p>
                </div>
              </div>
            </div>
            <div className="grid w-full grid-cols-3 gap-2 text-center">
              <div className="rounded-md border bg-muted/30 p-2">
                <p className="text-xs text-muted-foreground">Pass</p>
                <p className="text-lg font-semibold text-green-600">{summary.passing}</p>
              </div>
              <div className="rounded-md border bg-muted/30 p-2">
                <p className="text-xs text-muted-foreground">Warn</p>
                <p className="text-lg font-semibold text-yellow-600">{summary.warning}</p>
              </div>
              <div className="rounded-md border bg-muted/30 p-2">
                <p className="text-xs text-muted-foreground">Fail</p>
                <p className="text-lg font-semibold text-red-600">{summary.failing}</p>
              </div>
            </div>
            <p className="text-xs text-muted-foreground">
              {summary.total} controls assessed
            </p>
          </div>
        </div>

        <div className="rounded-lg border bg-card p-6 shadow-sm lg:col-span-2">
          <div className="flex items-center justify-between">
            <div>
              <h2 className="text-lg font-semibold">Compliance trend</h2>
              <p className="text-sm text-muted-foreground">Progress over the last reporting periods.</p>
            </div>
          </div>
          <div className="mt-6 h-60">
            {trend.length === 0 ? (
              <div className="flex h-full items-center justify-center rounded-md border border-dashed text-sm text-muted-foreground">
                No trend data available
              </div>
            ) : (
              <ResponsiveContainer width="100%" height="100%">
                <LineChart data={trend}>
                  <CartesianGrid strokeDasharray="3 3" className="stroke-muted" />
                  <XAxis dataKey="date" tick={{ fontSize: 10 }} className="text-muted-foreground" />
                  <YAxis domain={[0, 100]} tick={{ fontSize: 10 }} className="text-muted-foreground" />
                  <Tooltip contentStyle={tooltipStyle} />
                  <Line type="monotone" dataKey="percent" stroke="hsl(var(--primary))" strokeWidth={2} dot={false} />
                </LineChart>
              </ResponsiveContainer>
            )}
          </div>
        </div>
      </div>

      <div className="grid gap-6 lg:grid-cols-3">
        <div className="rounded-lg border bg-card p-6 shadow-sm lg:col-span-2">
          <div className="flex flex-col gap-2 sm:flex-row sm:items-center sm:justify-between">
            <div className="flex items-center gap-2">
              <ClipboardCheck className="h-5 w-5 text-muted-foreground" />
              <div>
                <h2 className="text-lg font-semibold">Control checklist</h2>
                <p className="text-xs text-muted-foreground">
                  {summary.passing} passing, {summary.warning} warnings, {summary.failing} failing
                </p>
              </div>
            </div>
            <p className="text-xs text-muted-foreground">{summary.total} total controls</p>
          </div>

          <div className="mt-5 grid gap-4 lg:grid-cols-[1.1fr_0.9fr]">
            <div className="space-y-3">
              {controls.length === 0 ? (
                <div className="rounded-md border border-dashed p-6 text-center text-sm text-muted-foreground">
                  No controls returned for this framework.
                </div>
              ) : (
                controls.map(control => {
                  const config = controlStatusConfig[control.status];
                  const StatusIcon = config.icon;
                  const isSelected = control.id === selectedControl?.id;

                  return (
                    <button
                      key={control.id}
                      type="button"
                      onClick={() => setSelectedControlId(control.id)}
                      className={cn(
                        'flex w-full items-start justify-between gap-3 rounded-md border p-3 text-left transition hover:bg-muted/30',
                        isSelected ? 'border-primary/40 bg-primary/5' : 'bg-background'
                      )}
                      aria-pressed={isSelected}
                    >
                      <div className="flex items-start gap-3">
                        <StatusIcon className={cn('mt-0.5 h-5 w-5', config.iconClass)} />
                        <div>
                          <p className="text-sm font-medium">{control.title}</p>
                          <p className="text-xs text-muted-foreground">
                            {control.category ?? 'General controls'}
                          </p>
                          <div className="mt-2 flex flex-wrap gap-2 text-xs text-muted-foreground">
                            <span>{control.affectedDevices.length} devices</span>
                            <span>{control.evidenceCount} evidence items</span>
                          </div>
                        </div>
                      </div>
                      <span className={cn('inline-flex items-center rounded-full border px-2 py-0.5 text-xs font-medium', config.badgeClass)}>
                        {config.label}
                      </span>
                    </button>
                  );
                })
              )}
            </div>

            <div className="rounded-md border bg-muted/20 p-4">
              {selectedControl ? (
                <div className="space-y-4">
                  <div className="flex items-start justify-between gap-4">
                    <div>
                      <p className="text-sm font-semibold">{selectedControl.title}</p>
                      <p className="text-xs text-muted-foreground">
                        {selectedControl.category ?? 'Control detail'}
                      </p>
                    </div>
                    <span
                      className={cn(
                        'inline-flex items-center rounded-full border px-2 py-0.5 text-xs font-medium',
                        controlStatusConfig[selectedControl.status].badgeClass
                      )}
                    >
                      {controlStatusConfig[selectedControl.status].label}
                    </span>
                  </div>

                  {selectedControl.description && (
                    <p className="text-sm text-muted-foreground">{selectedControl.description}</p>
                  )}

                  <div className="flex flex-wrap gap-3 text-xs text-muted-foreground">
                    <span>Owner: {selectedControl.owner ?? 'Unassigned'}</span>
                    <span>Last checked: {formatDate(selectedControl.lastChecked)}</span>
                  </div>

                  <div>
                    <p className="text-xs font-semibold uppercase text-muted-foreground">Affected devices</p>
                    <div className="mt-3 space-y-2">
                      {selectedControl.affectedDevices.length === 0 ? (
                        <div className="rounded-md border border-dashed p-3 text-center text-xs text-muted-foreground">
                          No impacted devices reported.
                        </div>
                      ) : (
                        selectedControl.affectedDevices.map(device => {
                          const deviceStatus = device.status ? controlStatusConfig[device.status] : undefined;
                          return (
                            <div key={device.id} className="flex items-center justify-between rounded-md border bg-background px-3 py-2">
                              <div className="flex items-center gap-2">
                                <Monitor className="h-4 w-4 text-muted-foreground" />
                                <div>
                                  <p className="text-xs font-medium">{device.name}</p>
                                  {device.ip && <p className="text-xs text-muted-foreground">{device.ip}</p>}
                                </div>
                              </div>
                              {deviceStatus && (
                                <span className={cn('rounded-full border px-2 py-0.5 text-[10px] font-medium', deviceStatus.badgeClass)}>
                                  {deviceStatus.label}
                                </span>
                              )}
                            </div>
                          );
                        })
                      )}
                    </div>
                  </div>
                </div>
              ) : (
                <div className="flex h-full items-center justify-center text-sm text-muted-foreground">
                  Select a control to view details.
                </div>
              )}
            </div>
          </div>
        </div>

        <div className="space-y-6">
          <div className="rounded-lg border bg-card p-6 shadow-sm">
            <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
              <div className="flex items-center gap-2">
                <FileText className="h-4 w-4 text-muted-foreground" />
                <div>
                  <h3 className="text-sm font-semibold">Evidence collection</h3>
                  <p className="text-xs text-muted-foreground">Link documents and screenshots.</p>
                </div>
              </div>
              <div className="flex flex-wrap gap-2">
                <button
                  type="button"
                  className="inline-flex items-center gap-2 rounded-md border bg-background px-3 py-1.5 text-xs font-medium hover:bg-muted"
                >
                  <Link2 className="h-3 w-3" />
                  Link document
                </button>
                <button
                  type="button"
                  className="inline-flex items-center gap-2 rounded-md border bg-background px-3 py-1.5 text-xs font-medium hover:bg-muted"
                >
                  <Image className="h-3 w-3" />
                  Add screenshot
                </button>
              </div>
            </div>

            <div className="mt-4 space-y-3">
              {evidenceItems.length === 0 ? (
                <div className="rounded-md border border-dashed p-4 text-center text-xs text-muted-foreground">
                  No evidence linked yet.
                </div>
              ) : (
                evidenceItems.slice(0, 4).map(item => {
                  const config = evidenceTypeConfig[item.type];
                  const Icon = config.icon;
                  const linkedControl = item.controlId ? controlLookup.get(item.controlId) : undefined;
                  return (
                    <div key={item.id} className="rounded-md border bg-background p-3">
                      <div className="flex items-start justify-between gap-3">
                        <div className="flex items-start gap-3">
                          <Icon className="mt-0.5 h-4 w-4 text-muted-foreground" />
                          <div>
                            <p className="text-sm font-medium">{item.title}</p>
                            <p className="text-xs text-muted-foreground">
                              {config.label}
                              {linkedControl ? ` · ${linkedControl}` : ''}
                            </p>
                          </div>
                        </div>
                        <span className="text-xs text-muted-foreground">{formatDate(item.linkedAt)}</span>
                      </div>
                      <div className="mt-2 text-xs text-muted-foreground">
                        Linked by {item.linkedBy ?? 'Security team'}
                      </div>
                    </div>
                  );
                })
              )}
            </div>
          </div>

          <div className="rounded-lg border bg-card p-6 shadow-sm">
            <div className="flex items-center gap-2">
              <AlertTriangle className="h-4 w-4 text-muted-foreground" />
              <div>
                <h3 className="text-sm font-semibold">Remediation tracking</h3>
                <p className="text-xs text-muted-foreground">Open issues and owners.</p>
              </div>
            </div>

            <div className="mt-4 space-y-3">
              {remediations.length === 0 ? (
                <div className="rounded-md border border-dashed p-4 text-center text-xs text-muted-foreground">
                  No open remediation items.
                </div>
              ) : (
                remediations.slice(0, 4).map(item => (
                  <div key={item.id} className="rounded-md border bg-background p-3">
                    <div className="flex items-start justify-between gap-3">
                      <p className="text-sm font-medium">{item.title}</p>
                      <span className={cn('inline-flex items-center rounded-full border px-2 py-0.5 text-xs font-medium', remediationStatusConfig[item.status].className)}>
                        {remediationStatusConfig[item.status].label}
                      </span>
                    </div>
                    <div className="mt-2 flex flex-wrap items-center gap-3 text-xs text-muted-foreground">
                      <span className="flex items-center gap-1">
                        <User className="h-3 w-3" />
                        {item.assignee ?? 'Unassigned'}
                      </span>
                      <span className="flex items-center gap-1">
                        <Calendar className="h-3 w-3" />
                        Due {formatDate(item.dueDate)}
                      </span>
                    </div>
                  </div>
                ))
              )}
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}
