import { useCallback, useEffect, useMemo, useState } from 'react';
import {
  AlertTriangle,
  ChevronRight,
  KeyRound,
  Loader2,
  Lock,
  RefreshCw,
  ShieldCheck,
  ShieldOff,
  Sparkles,
  TrendingUp,
  User
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
import { cn, formatNumber } from '@/lib/utils';

type Priority = 'critical' | 'high' | 'medium' | 'low';

type Recommendation = {
  id: string;
  title: string;
  description?: string;
  priority: Priority;
};

type AdminDevice = {
  id: string;
  name: string;
  issue?: string;
};

type SecurityOverview = {
  securityScore: number;
  antivirus: { protected: number; unprotected: number };
  firewall: { enabled: number; disabled: number };
  encryption: { bitlockerEnabled: number; filevaultEnabled: number; total: number };
  passwordCompliance: number;
  adminAudit: {
    defaultAccounts: number;
    weakAccounts: number;
    deviceCount: number;
    devices: AdminDevice[];
  };
  recommendations: Recommendation[];
  trend: Array<{ timestamp: string; score: number }>;
};

type VulnerabilitySummary = {
  critical: number;
  high: number;
  medium: number;
  low: number;
  total: number;
};

type ScoreMeta = {
  label: string;
  text: string;
  bar: string;
  badge: string;
};

const priorityOrder: Record<Priority, number> = {
  critical: 0,
  high: 1,
  medium: 2,
  low: 3
};

const priorityStyles: Record<Priority, string> = {
  critical: 'bg-red-500/15 text-red-700 border-red-500/30',
  high: 'bg-orange-500/15 text-orange-700 border-orange-500/30',
  medium: 'bg-yellow-500/15 text-yellow-800 border-yellow-500/30',
  low: 'bg-blue-500/15 text-blue-700 border-blue-500/30'
};

const severityStyles: Record<Priority, string> = {
  critical: 'bg-red-500',
  high: 'bg-orange-500',
  medium: 'bg-yellow-500',
  low: 'bg-blue-500'
};

const chartTooltipStyle = {
  backgroundColor: 'hsl(var(--card))',
  border: '1px solid hsl(var(--border))',
  borderRadius: '0.5rem',
  fontSize: '12px'
};

const defaultOverview: SecurityOverview = {
  securityScore: 0,
  antivirus: { protected: 0, unprotected: 0 },
  firewall: { enabled: 0, disabled: 0 },
  encryption: { bitlockerEnabled: 0, filevaultEnabled: 0, total: 0 },
  passwordCompliance: 0,
  adminAudit: {
    defaultAccounts: 0,
    weakAccounts: 0,
    deviceCount: 0,
    devices: []
  },
  recommendations: [],
  trend: []
};

const defaultVulnerabilities: VulnerabilitySummary = {
  critical: 0,
  high: 0,
  medium: 0,
  low: 0,
  total: 0
};

const isRecord = (value: unknown): value is Record<string, unknown> => (
  Boolean(value) && typeof value === 'object' && !Array.isArray(value)
);

const getRecord = (value: unknown): Record<string, unknown> => (isRecord(value) ? value : {});

const parseNumber = (value: unknown): number | undefined => {
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  if (typeof value === 'string') {
    const parsed = Number(value);
    if (Number.isFinite(parsed)) return parsed;
  }
  return undefined;
};

const pickOptionalNumber = (...values: unknown[]): number | undefined => {
  for (const value of values) {
    const parsed = parseNumber(value);
    if (parsed !== undefined) return parsed;
  }
  return undefined;
};

const pickNumber = (...values: unknown[]): number => pickOptionalNumber(...values) ?? 0;

const clamp = (value: number, min = 0, max = 100) => Math.min(Math.max(value, min), max);

const getScoreMeta = (score: number): ScoreMeta => {
  if (score >= 80) {
    return {
      label: 'Strong',
      text: 'text-emerald-600',
      bar: 'bg-emerald-500',
      badge: 'bg-emerald-500/10 text-emerald-700 border-emerald-500/30'
    };
  }
  if (score >= 60) {
    return {
      label: 'Elevated',
      text: 'text-amber-600',
      bar: 'bg-amber-500',
      badge: 'bg-amber-500/10 text-amber-700 border-amber-500/30'
    };
  }
  return {
    label: 'High risk',
    text: 'text-red-600',
    bar: 'bg-red-500',
    badge: 'bg-red-500/10 text-red-700 border-red-500/30'
  };
};

const normalizeTrendData = (raw: unknown): Array<{ timestamp: string; score: number }> => {
  if (!raw) return [];
  const record = getRecord(raw);
  const data = Array.isArray(raw)
    ? raw
    : Array.isArray(record.data)
      ? record.data
      : Array.isArray(record.trend)
        ? record.trend
        : Array.isArray(record.history)
          ? record.history
          : [];

  if (!Array.isArray(data)) return [];

  return data
    .map((entry, index) => {
      const item = getRecord(entry);
      const label = item.timestamp ?? item.date ?? item.label ?? item.period;
      const timestamp = label ? String(label) : String(index + 1);
      const score = pickOptionalNumber(
        item.score,
        item.securityScore,
        item.value,
        item.total,
        item.average
      );
      if (score === undefined) return null;
      return { timestamp, score };
    })
    .filter((item): item is { timestamp: string; score: number } => Boolean(item));
};

const normalizeRecommendations = (raw: unknown): Recommendation[] => {
  if (!raw) return [];
  const record = getRecord(raw);
  const list = Array.isArray(raw)
    ? raw
    : Array.isArray(record.recommendations)
      ? record.recommendations
      : Array.isArray(record.items)
        ? record.items
        : Array.isArray(record.actions)
          ? record.actions
          : Array.isArray(record.remediations)
            ? record.remediations
            : [];

  return list
    .map((entry, index) => {
      const item = getRecord(entry);
      const title = item.title ?? item.name ?? item.summary ?? item.recommendation;
      if (!title) return null;
      const rawPriority = String(item.priority ?? item.severity ?? item.level ?? 'medium').toLowerCase();
      const priority: Priority =
        rawPriority === 'critical'
          ? 'critical'
          : rawPriority === 'high'
            ? 'high'
            : rawPriority === 'low'
              ? 'low'
              : 'medium';
      const description =
        typeof item.description === 'string'
          ? item.description
          : typeof item.details === 'string'
            ? item.details
            : undefined;

      return {
        id: String(item.id ?? `${title}-${index}`),
        title: String(title),
        description,
        priority
      };
    })
    .filter((item): item is Recommendation => Boolean(item));
};

const normalizeAdminAudit = (raw: unknown) => {
  const record = getRecord(raw);
  const deviceList = Array.isArray(record.devices)
    ? record.devices
    : Array.isArray(record.deviceList)
      ? record.deviceList
      : Array.isArray(record.items)
        ? record.items
        : [];

  const devices = deviceList
    .map((entry, index) => {
      const item = getRecord(entry);
      const name = item.name ?? item.deviceName ?? item.hostname ?? item.asset;
      if (!name) return null;
      const issue =
        typeof item.issue === 'string'
          ? item.issue
          : typeof item.reason === 'string'
            ? item.reason
            : typeof item.summary === 'string'
              ? item.summary
              : undefined;

      return {
        id: String(item.id ?? name ?? index),
        name: String(name),
        issue
      };
    })
    .filter((item): item is AdminDevice => Boolean(item));

  const defaultAccounts = pickNumber(
    record.defaultAccounts,
    record.default,
    record.defaults,
    record.defaultCount
  );
  const weakAccounts = pickNumber(
    record.weakAccounts,
    record.weak,
    record.weakCount,
    record.weakAdminAccounts,
    record.atRisk
  );
  const deviceCount = pickOptionalNumber(
    record.deviceCount,
    record.devicesAffected,
    record.affectedDevices,
    record.count
  );

  return {
    defaultAccounts,
    weakAccounts,
    deviceCount: deviceCount ?? devices.length,
    devices
  };
};

const normalizeOverview = (raw: unknown): SecurityOverview => {
  const record = getRecord(raw);
  const data = isRecord(record.data) ? record.data : record;

  const securityScore = clamp(
    pickNumber(
      data.securityScore,
      data.score,
      data.overallScore,
      data.postureScore,
      data.rating
    )
  );

  const antivirusRecord = getRecord(
    data.antivirus ??
    data.av ??
    data.endpointProtection ??
    data.protection ??
    data.antivirusStatus
  );
  const antivirusProtected = pickNumber(
    antivirusRecord.protected,
    antivirusRecord.enabled,
    antivirusRecord.active,
    data.protectedDevices,
    data.protectedEndpoints
  );
  const antivirusUnprotected = pickNumber(
    antivirusRecord.unprotected,
    antivirusRecord.disabled,
    antivirusRecord.inactive,
    data.unprotectedDevices,
    data.unprotectedEndpoints
  );

  const firewallRecord = getRecord(data.firewall ?? data.firewallStatus);
  const firewallEnabled = pickNumber(
    firewallRecord.enabled,
    firewallRecord.active,
    firewallRecord.on,
    data.firewallEnabled
  );
  const firewallDisabled = pickNumber(
    firewallRecord.disabled,
    firewallRecord.inactive,
    firewallRecord.off,
    data.firewallDisabled
  );

  const encryptionRecord = getRecord(data.encryption ?? data.diskEncryption ?? data.encryptionStatus);
  const bitlockerEnabled = pickNumber(
    encryptionRecord.bitlockerEnabled,
    encryptionRecord.bitlocker,
    encryptionRecord.windowsEnabled,
    encryptionRecord.bitlockerCount
  );
  const filevaultEnabled = pickNumber(
    encryptionRecord.filevaultEnabled,
    encryptionRecord.filevault,
    encryptionRecord.macosEnabled,
    encryptionRecord.filevaultCount
  );
  const encryptionTotal = pickOptionalNumber(
    encryptionRecord.total,
    encryptionRecord.devices,
    encryptionRecord.deviceCount,
    data.totalDevices
  );

  const passwordCompliance = clamp(
    pickNumber(
      data.passwordPolicyCompliance,
      data.passwordCompliance,
      getRecord(data.passwordPolicy).compliance,
      getRecord(data.passwordPolicy).percentage,
      getRecord(data.passwordPolicy).score,
      getRecord(data.password).compliance
    )
  );

  const adminAudit = normalizeAdminAudit(
    data.adminAccountAudit ?? data.adminAccounts ?? data.adminAudit ?? data.admins
  );

  const recommendations = normalizeRecommendations(
    data.recommendations ?? data.recommendationList ?? data.actions ?? data.remediations
  );

  const trend = normalizeTrendData(
    data.trend ?? data.scoreTrend ?? data.securityScoreTrend ?? data.history ?? data.trends
  );

  return {
    securityScore,
    antivirus: { protected: antivirusProtected, unprotected: antivirusUnprotected },
    firewall: { enabled: firewallEnabled, disabled: firewallDisabled },
    encryption: {
      bitlockerEnabled,
      filevaultEnabled,
      total: encryptionTotal ?? bitlockerEnabled + filevaultEnabled
    },
    passwordCompliance,
    adminAudit,
    recommendations,
    trend
  };
};

const normalizeVulnerabilities = (raw: unknown): VulnerabilitySummary => {
  const record = getRecord(raw);
  const data = isRecord(record.data) ? record.data : record;
  const summary = isRecord(data.summary) ? data.summary : data;

  let critical = pickNumber(summary.critical, summary.criticalCount, summary.criticalIssues);
  let high = pickNumber(summary.high, summary.highCount, summary.highIssues);
  let medium = pickNumber(summary.medium, summary.mediumCount, summary.mediumIssues);
  let low = pickNumber(summary.low, summary.lowCount, summary.lowIssues);

  const list = Array.isArray(data.items)
    ? data.items
    : Array.isArray(data.vulnerabilities)
      ? data.vulnerabilities
      : Array.isArray(data.data)
        ? data.data
        : Array.isArray(raw)
          ? raw
          : [];

  if (Array.isArray(list) && list.length > 0) {
    const counts = { critical: 0, high: 0, medium: 0, low: 0 };
    list.forEach((entry) => {
      const item = getRecord(entry);
      const severity = String(item.severity ?? item.priority ?? '').toLowerCase();
      if (severity === 'critical') counts.critical += 1;
      else if (severity === 'high') counts.high += 1;
      else if (severity === 'medium') counts.medium += 1;
      else if (severity === 'low') counts.low += 1;
    });
    if (critical === 0 && high === 0 && medium === 0 && low === 0) {
      ({ critical, high, medium, low } = counts);
    }
  }

  const total = critical + high + medium + low;
  return { critical, high, medium, low, total };
};

const fetchJson = async (url: string) => {
  const response = await fetch(url);
  if (!response.ok) {
    throw new Error(`${response.status} ${response.statusText}`);
  }
  const text = await response.text();
  if (!text) return null;
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
};

export default function SecurityDashboard() {
  const [overview, setOverview] = useState<SecurityOverview>(defaultOverview);
  const [vulnerabilities, setVulnerabilities] = useState<VulnerabilitySummary>(defaultVulnerabilities);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string>();
  const [lastUpdated, setLastUpdated] = useState<Date | null>(null);

  const fetchSecurityData = useCallback(async () => {
    setError(undefined);
    setLoading(true);
    const errors: string[] = [];

    await Promise.all([
      (async () => {
        try {
          const overviewData = await fetchJson('/api/security/overview');
          setOverview(normalizeOverview(overviewData));
        } catch (err) {
          errors.push('overview');
          setOverview(defaultOverview);
        }
      })(),
      (async () => {
        try {
          const vulnerabilityData = await fetchJson('/api/security/vulnerabilities');
          setVulnerabilities(normalizeVulnerabilities(vulnerabilityData));
        } catch (err) {
          errors.push('vulnerabilities');
          setVulnerabilities(defaultVulnerabilities);
        }
      })()
    ]);

    if (errors.length > 0) {
      setError(`Unable to load: ${errors.join(', ')}`);
    }

    setLastUpdated(new Date('2024-01-15T12:00:00.000Z'));
    setLoading(false);
  }, []);

  useEffect(() => {
    fetchSecurityData();
  }, [fetchSecurityData]);

  const scoreMeta = useMemo(() => getScoreMeta(overview.securityScore), [overview.securityScore]);

  const antivirusTotal = overview.antivirus.protected + overview.antivirus.unprotected;
  const antivirusProtectedPercent = antivirusTotal
    ? Math.round((overview.antivirus.protected / antivirusTotal) * 100)
    : 0;
  const antivirusUnprotectedPercent = antivirusTotal
    ? Math.round((overview.antivirus.unprotected / antivirusTotal) * 100)
    : 0;

  const firewallTotal = overview.firewall.enabled + overview.firewall.disabled;
  const firewallEnabledPercent = firewallTotal
    ? Math.round((overview.firewall.enabled / firewallTotal) * 100)
    : 0;
  const firewallDisabledPercent = firewallTotal
    ? Math.round((overview.firewall.disabled / firewallTotal) * 100)
    : 0;

  const encryptionEnabledTotal = overview.encryption.bitlockerEnabled + overview.encryption.filevaultEnabled;
  const encryptionTotal = overview.encryption.total || encryptionEnabledTotal;
  const encryptionPercent = encryptionTotal ? Math.round((encryptionEnabledTotal / encryptionTotal) * 100) : 0;

  const passwordCompliance = clamp(overview.passwordCompliance);

  const sortedRecommendations = useMemo(
    () =>
      [...overview.recommendations].sort(
        (a, b) => priorityOrder[a.priority] - priorityOrder[b.priority]
      ),
    [overview.recommendations]
  );

  const isInitialLoading = loading && !lastUpdated;

  const vulnerabilityRows = [
    { label: 'Critical', value: vulnerabilities.critical, severity: 'critical' as const },
    { label: 'High', value: vulnerabilities.high, severity: 'high' as const },
    { label: 'Medium', value: vulnerabilities.medium, severity: 'medium' as const },
    { label: 'Low', value: vulnerabilities.low, severity: 'low' as const }
  ];

  const adminDevices = overview.adminAudit.devices.slice(0, 3);

  return (
    <div className="space-y-6">
      <div className="flex flex-col gap-4 lg:flex-row lg:items-center lg:justify-between">
        <div>
          <h2 className="text-xl font-semibold">Security</h2>
          <p className="text-sm text-muted-foreground">
            Track protection coverage, vulnerabilities, and policy compliance.
          </p>
        </div>
        <div className="flex flex-wrap items-center gap-3">
          <button
            type="button"
            onClick={fetchSecurityData}
            className="inline-flex h-9 items-center gap-2 rounded-md border bg-background px-3 text-sm hover:bg-muted"
            disabled={loading}
          >
            {loading ? <Loader2 className="h-4 w-4 animate-spin" /> : <RefreshCw className="h-4 w-4" />}
            Refresh
          </button>
          {lastUpdated && (
            <span className="text-xs text-muted-foreground">
              Updated {lastUpdated.toLocaleTimeString()}
            </span>
          )}
        </div>
      </div>

      {error && (
        <div className="rounded-lg border border-destructive/40 bg-destructive/10 p-4 text-center">
          <p className="text-sm text-destructive">{error}</p>
          <button
            type="button"
            onClick={fetchSecurityData}
            className="mt-2 inline-flex items-center gap-1 text-sm text-primary hover:underline"
          >
            <RefreshCw className="h-3 w-3" />
            Retry
          </button>
        </div>
      )}

      <div className="grid gap-6 lg:grid-cols-12">
        {isInitialLoading ? (
          <>
            <div className="h-64 rounded-lg border bg-muted/30 p-6 shadow-sm lg:col-span-4" />
            <div className="h-64 rounded-lg border bg-muted/30 p-6 shadow-sm lg:col-span-8" />
            <div className="h-56 rounded-lg border bg-muted/30 p-6 shadow-sm lg:col-span-4" />
            <div className="h-56 rounded-lg border bg-muted/30 p-6 shadow-sm lg:col-span-4" />
            <div className="h-56 rounded-lg border bg-muted/30 p-6 shadow-sm lg:col-span-4" />
            <div className="h-56 rounded-lg border bg-muted/30 p-6 shadow-sm lg:col-span-4" />
            <div className="h-56 rounded-lg border bg-muted/30 p-6 shadow-sm lg:col-span-4" />
            <div className="h-56 rounded-lg border bg-muted/30 p-6 shadow-sm lg:col-span-4" />
            <div className="h-64 rounded-lg border bg-muted/30 p-6 shadow-sm lg:col-span-12" />
          </>
        ) : (
          <>
            <div className="rounded-lg border bg-card p-6 shadow-sm lg:col-span-4">
              <div className="flex items-start justify-between">
                <div>
                  <p className="text-sm text-muted-foreground">Security Score</p>
                  <div className="mt-2 flex items-baseline gap-2">
                    <span className={cn('text-3xl font-semibold', scoreMeta.text)}>
                      {Math.round(overview.securityScore)}
                    </span>
                    <span className="text-sm text-muted-foreground">/ 100</span>
                  </div>
                </div>
                <div className={cn('rounded-full border p-2.5', scoreMeta.badge)}>
                  <ShieldCheck className="h-4 w-4" />
                </div>
              </div>
              <div className="mt-4 space-y-2">
                <div className={cn('inline-flex items-center rounded-full border px-2.5 py-1 text-xs font-medium', scoreMeta.badge)}>
                  {scoreMeta.label}
                </div>
                <div className="h-2 w-full rounded-full bg-muted">
                  <div
                    className={cn('h-2 rounded-full', scoreMeta.bar)}
                    style={{ width: `${overview.securityScore}%` }}
                  />
                </div>
                <div className="flex items-center justify-between text-xs text-muted-foreground">
                  <span>0</span>
                  <span>100</span>
                </div>
              </div>
              <div className="mt-4 flex items-center justify-between text-xs">
                <span className="text-muted-foreground">Overall posture</span>
                <a
                  href="/security/score"
                  className="inline-flex items-center gap-1 text-primary hover:underline"
                >
                  View details
                  <ChevronRight className="h-3 w-3" />
                </a>
              </div>
            </div>

            <div className="rounded-lg border bg-card p-6 shadow-sm lg:col-span-8">
              <div className="flex items-start justify-between">
                <div>
                  <p className="text-sm font-semibold">Security Score Trend</p>
                  <p className="text-xs text-muted-foreground">Score movement over time</p>
                </div>
                <div className="rounded-full border bg-muted/30 p-2.5">
                  <TrendingUp className="h-4 w-4 text-muted-foreground" />
                </div>
              </div>
              <div className="mt-4 h-64">
                {overview.trend.length === 0 ? (
                  <div className="flex h-full items-center justify-center rounded-md border border-dashed text-xs text-muted-foreground">
                    No data available
                  </div>
                ) : (
                  <ResponsiveContainer width="100%" height="100%">
                    <LineChart data={overview.trend}>
                      <CartesianGrid strokeDasharray="3 3" className="stroke-muted" />
                      <XAxis dataKey="timestamp" tick={{ fontSize: 10 }} className="text-muted-foreground" />
                      <YAxis domain={[0, 100]} tick={{ fontSize: 10 }} className="text-muted-foreground" />
                      <Tooltip contentStyle={chartTooltipStyle} />
                      <Line
                        type="monotone"
                        dataKey="score"
                        name="Score"
                        stroke="#22c55e"
                        strokeWidth={2}
                        dot={false}
                      />
                    </LineChart>
                  </ResponsiveContainer>
                )}
              </div>
              <div className="mt-4 flex items-center justify-between text-xs">
                <span className="text-muted-foreground">Trend insights</span>
                <a
                  href="/security/trends"
                  className="inline-flex items-center gap-1 text-primary hover:underline"
                >
                  View details
                  <ChevronRight className="h-3 w-3" />
                </a>
              </div>
            </div>

            <div className="rounded-lg border bg-card p-6 shadow-sm lg:col-span-4">
              <div className="flex items-start justify-between">
                <div>
                  <p className="text-sm font-semibold">Vulnerabilities</p>
                  <p className="text-xs text-muted-foreground">
                    {formatNumber(vulnerabilities.total)} open items
                  </p>
                </div>
                <div className="rounded-full border bg-muted/30 p-2.5">
                  <AlertTriangle className="h-4 w-4 text-muted-foreground" />
                </div>
              </div>
              <div className="mt-4 space-y-3">
                {vulnerabilityRows.map((row) => (
                  <div key={row.label} className="flex items-center justify-between text-sm">
                    <div className="flex items-center gap-2">
                      <span className={cn('h-2.5 w-2.5 rounded-full', severityStyles[row.severity])} />
                      <span>{row.label}</span>
                    </div>
                    <span className="font-medium">{formatNumber(row.value)}</span>
                  </div>
                ))}
              </div>
              <div className="mt-4 flex items-center justify-between text-xs">
                <span className="text-muted-foreground">Across all assets</span>
                <a
                  href="/security/vulnerabilities"
                  className="inline-flex items-center gap-1 text-primary hover:underline"
                >
                  View details
                  <ChevronRight className="h-3 w-3" />
                </a>
              </div>
            </div>

            <div className="rounded-lg border bg-card p-6 shadow-sm lg:col-span-4">
              <div className="flex items-start justify-between">
                <div>
                  <p className="text-sm font-semibold">Antivirus Coverage</p>
                  <p className="text-xs text-muted-foreground">
                    {formatNumber(antivirusTotal)} devices tracked
                  </p>
                </div>
                <div className="rounded-full border bg-muted/30 p-2.5">
                  <ShieldCheck className="h-4 w-4 text-muted-foreground" />
                </div>
              </div>
              <div className="mt-4 space-y-3">
                <div className="flex items-center justify-between text-sm">
                  <span className="text-muted-foreground">Protected</span>
                  <span className="font-medium">
                    {formatNumber(overview.antivirus.protected)} ({antivirusProtectedPercent}%)
                  </span>
                </div>
                <div className="flex items-center justify-between text-sm">
                  <span className="text-muted-foreground">Unprotected</span>
                  <span className="font-medium">
                    {formatNumber(overview.antivirus.unprotected)} ({antivirusUnprotectedPercent}%)
                  </span>
                </div>
                <div className="h-2 w-full rounded-full bg-muted">
                  <div
                    className="h-2 rounded-full bg-emerald-500"
                    style={{ width: `${antivirusProtectedPercent}%` }}
                  />
                </div>
              </div>
              <div className="mt-4 flex items-center justify-between text-xs">
                <span className="text-muted-foreground">Real-time protection</span>
                <a
                  href="/security/antivirus"
                  className="inline-flex items-center gap-1 text-primary hover:underline"
                >
                  View details
                  <ChevronRight className="h-3 w-3" />
                </a>
              </div>
            </div>

            <div className="rounded-lg border bg-card p-6 shadow-sm lg:col-span-4">
              <div className="flex items-start justify-between">
                <div>
                  <p className="text-sm font-semibold">Firewall Status</p>
                  <p className="text-xs text-muted-foreground">
                    {formatNumber(firewallTotal)} devices audited
                  </p>
                </div>
                <div className="rounded-full border bg-muted/30 p-2.5">
                  <ShieldOff className="h-4 w-4 text-muted-foreground" />
                </div>
              </div>
              <div className="mt-4 space-y-3">
                <div className="flex items-center justify-between text-sm">
                  <span className="text-muted-foreground">Enabled</span>
                  <span className="font-medium">
                    {formatNumber(overview.firewall.enabled)} ({firewallEnabledPercent}%)
                  </span>
                </div>
                <div className="flex items-center justify-between text-sm">
                  <span className="text-muted-foreground">Disabled</span>
                  <span className="font-medium">
                    {formatNumber(overview.firewall.disabled)} ({firewallDisabledPercent}%)
                  </span>
                </div>
                <div className="h-2 w-full rounded-full bg-muted">
                  <div
                    className="h-2 rounded-full bg-sky-500"
                    style={{ width: `${firewallEnabledPercent}%` }}
                  />
                </div>
              </div>
              <div className="mt-4 flex items-center justify-between text-xs">
                <span className="text-muted-foreground">Network defense</span>
                <a
                  href="/security/firewall"
                  className="inline-flex items-center gap-1 text-primary hover:underline"
                >
                  View details
                  <ChevronRight className="h-3 w-3" />
                </a>
              </div>
            </div>

            <div className="rounded-lg border bg-card p-6 shadow-sm lg:col-span-4">
              <div className="flex items-start justify-between">
                <div>
                  <p className="text-sm font-semibold">Encryption Status</p>
                  <p className="text-xs text-muted-foreground">
                    {formatNumber(encryptionTotal)} devices reviewed
                  </p>
                </div>
                <div className="rounded-full border bg-muted/30 p-2.5">
                  <Lock className="h-4 w-4 text-muted-foreground" />
                </div>
              </div>
              <div className="mt-4 space-y-3">
                <div className="flex items-center justify-between text-sm">
                  <span className="text-muted-foreground">BitLocker enabled</span>
                  <span className="font-medium">{formatNumber(overview.encryption.bitlockerEnabled)}</span>
                </div>
                <div className="flex items-center justify-between text-sm">
                  <span className="text-muted-foreground">FileVault enabled</span>
                  <span className="font-medium">{formatNumber(overview.encryption.filevaultEnabled)}</span>
                </div>
                <div className="h-2 w-full rounded-full bg-muted">
                  <div
                    className="h-2 rounded-full bg-violet-500"
                    style={{ width: `${encryptionPercent}%` }}
                  />
                </div>
              </div>
              <div className="mt-4 flex items-center justify-between text-xs">
                <span className="text-muted-foreground">Disk protection</span>
                <a
                  href="/security/encryption"
                  className="inline-flex items-center gap-1 text-primary hover:underline"
                >
                  View details
                  <ChevronRight className="h-3 w-3" />
                </a>
              </div>
            </div>

            <div className="rounded-lg border bg-card p-6 shadow-sm lg:col-span-4">
              <div className="flex items-start justify-between">
                <div>
                  <p className="text-sm font-semibold">Password Policy</p>
                  <p className="text-xs text-muted-foreground">Compliance rate</p>
                </div>
                <div className="rounded-full border bg-muted/30 p-2.5">
                  <KeyRound className="h-4 w-4 text-muted-foreground" />
                </div>
              </div>
              <div className="mt-4 space-y-3">
                <div className="flex items-baseline gap-2">
                  <span className="text-3xl font-semibold">{Math.round(passwordCompliance)}%</span>
                  <span className="text-xs text-muted-foreground">compliant</span>
                </div>
                <div className="h-2 w-full rounded-full bg-muted">
                  <div
                    className="h-2 rounded-full bg-emerald-500"
                    style={{ width: `${passwordCompliance}%` }}
                  />
                </div>
              </div>
              <div className="mt-4 flex items-center justify-between text-xs">
                <span className="text-muted-foreground">Policy adherence</span>
                <a
                  href="/security/password-policy"
                  className="inline-flex items-center gap-1 text-primary hover:underline"
                >
                  View details
                  <ChevronRight className="h-3 w-3" />
                </a>
              </div>
            </div>

            <div className="rounded-lg border bg-card p-6 shadow-sm lg:col-span-4">
              <div className="flex items-start justify-between">
                <div>
                  <p className="text-sm font-semibold">Admin Account Audit</p>
                  <p className="text-xs text-muted-foreground">
                    {formatNumber(overview.adminAudit.deviceCount)} devices flagged
                  </p>
                </div>
                <div className="rounded-full border bg-muted/30 p-2.5">
                  <User className="h-4 w-4 text-muted-foreground" />
                </div>
              </div>
              <div className="mt-4 grid grid-cols-2 gap-3">
                <div className="rounded-md border bg-muted/30 p-3">
                  <p className="text-xs text-muted-foreground">Default admins</p>
                  <p className="mt-1 text-lg font-semibold">
                    {formatNumber(overview.adminAudit.defaultAccounts)}
                  </p>
                </div>
                <div className="rounded-md border bg-muted/30 p-3">
                  <p className="text-xs text-muted-foreground">Weak admins</p>
                  <p className="mt-1 text-lg font-semibold">
                    {formatNumber(overview.adminAudit.weakAccounts)}
                  </p>
                </div>
              </div>
              <div className="mt-4 space-y-2">
                {adminDevices.length > 0 ? (
                  adminDevices.map((device) => (
                    <div key={device.id} className="rounded-md border bg-muted/30 px-3 py-2 text-xs">
                      <p className="font-medium">{device.name}</p>
                      {device.issue && <p className="text-muted-foreground">{device.issue}</p>}
                    </div>
                  ))
                ) : (
                  <p className="text-xs text-muted-foreground">No weak admin accounts detected.</p>
                )}
              </div>
              <div className="mt-4 flex items-center justify-between text-xs">
                <span className="text-muted-foreground">Privileged access</span>
                <a
                  href="/security/admin-audit"
                  className="inline-flex items-center gap-1 text-primary hover:underline"
                >
                  View details
                  <ChevronRight className="h-3 w-3" />
                </a>
              </div>
            </div>

            <div className="rounded-lg border bg-card p-6 shadow-sm lg:col-span-12">
              <div className="flex items-start justify-between">
                <div>
                  <p className="text-sm font-semibold">Security Recommendations</p>
                  <p className="text-xs text-muted-foreground">
                    {formatNumber(sortedRecommendations.length)} actions prioritized
                  </p>
                </div>
                <div className="rounded-full border bg-muted/30 p-2.5">
                  <Sparkles className="h-4 w-4 text-muted-foreground" />
                </div>
              </div>
              <div className="mt-4 grid gap-3 lg:grid-cols-2">
                {sortedRecommendations.length > 0 ? (
                  sortedRecommendations.map((rec) => (
                    <div key={rec.id} className="rounded-md border bg-muted/30 p-4">
                      <div className="flex items-start justify-between gap-4">
                        <div>
                          <p className="text-sm font-medium">{rec.title}</p>
                          {rec.description && (
                            <p className="mt-1 text-xs text-muted-foreground">{rec.description}</p>
                          )}
                        </div>
                        <span
                          className={cn(
                            'rounded-full border px-2 py-1 text-[11px] font-semibold uppercase',
                            priorityStyles[rec.priority]
                          )}
                        >
                          {rec.priority}
                        </span>
                      </div>
                    </div>
                  ))
                ) : (
                  <div className="rounded-md border border-dashed p-6 text-center text-sm text-muted-foreground lg:col-span-2">
                    No recommendations right now. Keep monitoring for new guidance.
                  </div>
                )}
              </div>
              <div className="mt-4 flex items-center justify-between text-xs">
                <span className="text-muted-foreground">Remediation guidance</span>
                <a
                  href="/security/recommendations"
                  className="inline-flex items-center gap-1 text-primary hover:underline"
                >
                  View details
                  <ChevronRight className="h-3 w-3" />
                </a>
              </div>
            </div>
          </>
        )}
      </div>
    </div>
  );
}
