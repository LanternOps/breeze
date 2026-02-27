import type {
  CisCatalogLevel,
  CisCheckSeverity,
  CisFinding,
  CisOsType,
  CisRemediationApprovalStatus,
  CisRemediationStatus,
  CisScanSchedule,
} from '../db/schema';

// Valid remediation state transitions: [currentStatus, currentApproval] -> [newStatus, newApproval]
const VALID_TRANSITIONS: ReadonlyArray<{
  from: { status: CisRemediationStatus; approval: CisRemediationApprovalStatus };
  to: { status: CisRemediationStatus; approval: CisRemediationApprovalStatus };
}> = [
  // Approval flow
  { from: { status: 'pending_approval', approval: 'pending' }, to: { status: 'queued', approval: 'approved' } },
  { from: { status: 'pending_approval', approval: 'pending' }, to: { status: 'cancelled', approval: 'rejected' } },
  // Execution flow
  { from: { status: 'queued', approval: 'approved' }, to: { status: 'in_progress', approval: 'approved' } },
  { from: { status: 'queued', approval: 'approved' }, to: { status: 'failed', approval: 'approved' } },
  { from: { status: 'in_progress', approval: 'approved' }, to: { status: 'completed', approval: 'approved' } },
  { from: { status: 'in_progress', approval: 'approved' }, to: { status: 'failed', approval: 'approved' } },
];

export function validateRemediationTransition(
  currentStatus: CisRemediationStatus,
  currentApproval: CisRemediationApprovalStatus,
  newStatus: CisRemediationStatus,
  newApproval: CisRemediationApprovalStatus,
): void {
  const valid = VALID_TRANSITIONS.some(
    (t) =>
      t.from.status === currentStatus &&
      t.from.approval === currentApproval &&
      t.to.status === newStatus &&
      t.to.approval === newApproval,
  );
  if (!valid) {
    throw new Error(
      `Invalid remediation state transition: (${currentStatus}, ${currentApproval}) -> (${newStatus}, ${newApproval})`,
    );
  }
}

export type CisCatalogEntry = {
  checkId: string;
  title: string;
  osType: CisOsType;
  benchmarkVersion: string;
  level: CisCatalogLevel;
  severity: CisCheckSeverity;
  defaultAction: string;
};

export const defaultCisCatalog: CisCatalogEntry[] = [
  {
    checkId: '1.1.1',
    title: 'Enforce password history',
    osType: 'windows',
    benchmarkVersion: 'CIS Microsoft Windows 11 Enterprise Benchmark v2.0.0',
    level: 'l1',
    severity: 'high',
    defaultAction: 'set_local_password_policy'
  },
  {
    checkId: '9.1',
    title: 'Enable host firewall',
    osType: 'windows',
    benchmarkVersion: 'CIS Microsoft Windows 11 Enterprise Benchmark v2.0.0',
    level: 'l1',
    severity: 'critical',
    defaultAction: 'set_firewall_state'
  },
  {
    checkId: '5.6',
    title: 'Disable guest account',
    osType: 'windows',
    benchmarkVersion: 'CIS Microsoft Windows 11 Enterprise Benchmark v2.0.0',
    level: 'l1',
    severity: 'high',
    defaultAction: 'disable_local_account'
  },
  {
    checkId: '5.2.5',
    title: 'Disable PermitRootLogin in SSH',
    osType: 'linux',
    benchmarkVersion: 'CIS Ubuntu Linux 22.04 LTS Benchmark v2.0.0',
    level: 'l1',
    severity: 'critical',
    defaultAction: 'harden_sshd_config'
  },
  {
    checkId: '1.1.1.1',
    title: 'Disable unused filesystem modules',
    osType: 'linux',
    benchmarkVersion: 'CIS Ubuntu Linux 22.04 LTS Benchmark v2.0.0',
    level: 'l1',
    severity: 'medium',
    defaultAction: 'disable_kernel_module'
  },
  {
    checkId: '1.5.3',
    title: 'Enable ASLR',
    osType: 'linux',
    benchmarkVersion: 'CIS Ubuntu Linux 22.04 LTS Benchmark v2.0.0',
    level: 'l1',
    severity: 'high',
    defaultAction: 'set_sysctl'
  },
  {
    checkId: '2.2.1',
    title: 'Enable FileVault',
    osType: 'macos',
    benchmarkVersion: 'CIS Apple macOS 14.0 Benchmark v1.0.0',
    level: 'l1',
    severity: 'critical',
    defaultAction: 'enable_filevault'
  },
  {
    checkId: '5.1.1',
    title: 'Enable application firewall',
    osType: 'macos',
    benchmarkVersion: 'CIS Apple macOS 14.0 Benchmark v1.0.0',
    level: 'l1',
    severity: 'high',
    defaultAction: 'set_application_firewall'
  },
  {
    checkId: '6.1.2',
    title: 'Disable automatic login',
    osType: 'macos',
    benchmarkVersion: 'CIS Apple macOS 14.0 Benchmark v1.0.0',
    level: 'l1',
    severity: 'high',
    defaultAction: 'disable_auto_login'
  }
];

const CIS_STATUSES = new Set(['pass', 'fail', 'not_applicable', 'error']);
const CIS_SEVERITIES = new Set(['low', 'medium', 'high', 'critical']);

function clampInteger(value: unknown, min: number, max: number, fallback: number): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    return fallback;
  }
  return Math.min(max, Math.max(min, Math.trunc(value)));
}

function readString(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : null;
}

export function normalizeCisSchedule(raw: unknown): CisScanSchedule {
  const now = new Date();
  if (!raw || typeof raw !== 'object') {
    return {
      enabled: true,
      intervalHours: 24,
      nextScanAt: new Date(now.getTime() + 24 * 60 * 60 * 1000).toISOString()
    };
  }

  const input = raw as Record<string, unknown>;
  const intervalHours = clampInteger(input.intervalHours, 1, 24 * 7, 24);
  const enabled = input.enabled !== false;

  let nextScanAt: string | null = null;
  if (typeof input.nextScanAt === 'string') {
    const parsed = new Date(input.nextScanAt);
    if (!Number.isNaN(parsed.getTime())) {
      nextScanAt = parsed.toISOString();
    }
  }
  if (!nextScanAt && enabled) {
    nextScanAt = new Date(now.getTime() + intervalHours * 60 * 60 * 1000).toISOString();
  }

  return {
    enabled,
    intervalHours,
    nextScanAt
  };
}

export function normalizeCisFindings(raw: unknown): CisFinding[] {
  if (!Array.isArray(raw)) return [];

  const findings: CisFinding[] = [];
  for (const item of raw) {
    if (!item || typeof item !== 'object') continue;
    const row = item as Record<string, unknown>;
    const checkId = readString(row.checkId) ?? readString(row.id) ?? readString(row.ruleId);
    if (!checkId) continue;

    const statusInput = (readString(row.status) ?? readString(row.result) ?? 'error').toLowerCase();
    const status = CIS_STATUSES.has(statusInput) ? statusInput as CisFinding['status'] : 'error';

    const severityInput = (readString(row.severity) ?? 'medium').toLowerCase();
    const severity = CIS_SEVERITIES.has(severityInput) ? severityInput as CisFinding['severity'] : 'medium';

    findings.push({
      checkId,
      title: readString(row.title) ?? readString(row.description) ?? `CIS check ${checkId}`,
      severity,
      status,
      evidence: (row.evidence && typeof row.evidence === 'object')
        ? row.evidence as Record<string, unknown>
        : null,
      remediation: (row.remediation && typeof row.remediation === 'object')
        ? row.remediation as CisFinding['remediation']
        : null,
      message: readString(row.message)
    });
  }

  return findings;
}

export function summarizeCisFindings(findings: CisFinding[]): {
  totalChecks: number;
  passedChecks: number;
  failedChecks: number;
  score: number;
  bySeverity: Record<string, number>;
} {
  const passedChecks = findings.filter((f) => f.status === 'pass').length;
  const failedChecks = findings.filter((f) => f.status === 'fail').length;
  const totalChecks = passedChecks + failedChecks;
  const score = totalChecks > 0 ? Math.round((passedChecks / totalChecks) * 100) : 100;
  const bySeverity: Record<string, number> = {
    low: 0,
    medium: 0,
    high: 0,
    critical: 0
  };

  for (const finding of findings) {
    if (finding.status !== 'fail') continue;
    bySeverity[finding.severity] = (bySeverity[finding.severity] ?? 0) + 1;
  }

  return {
    totalChecks,
    passedChecks,
    failedChecks,
    score,
    bySeverity
  };
}

export function extractFailedCheckIds(rawFindings: unknown): Set<string> {
  const findings = normalizeCisFindings(rawFindings);
  const failed = new Set<string>();
  for (const finding of findings) {
    if (finding.status === 'fail') {
      failed.add(finding.checkId);
    }
  }
  return failed;
}

export function parseCisCollectorOutput(stdout: string | undefined): {
  checkedAt: Date;
  findings: CisFinding[];
  totalChecks: number;
  passedChecks: number;
  failedChecks: number;
  score: number;
  rawSummary: Record<string, unknown>;
} {
  let parsed: Record<string, unknown> = {};
  let parseError: string | null = null;
  if (stdout) {
    try {
      const asJson = JSON.parse(stdout) as unknown;
      if (asJson && typeof asJson === 'object' && !Array.isArray(asJson)) {
        parsed = asJson as Record<string, unknown>;
      } else {
        parseError = 'Collector output JSON must be an object';
      }
    } catch (err) {
      const detail = err instanceof SyntaxError ? err.message : 'unknown parse error';
      parseError = `Collector output was not valid JSON: ${detail}`;
    }
  } else {
    parseError = 'Collector output was empty';
  }

  const checkedAtRaw = readString(parsed.checkedAt);
  const checkedAt = checkedAtRaw ? new Date(checkedAtRaw) : new Date();
  const findings = normalizeCisFindings(parsed.findings ?? parsed.checks);

  if (parseError && findings.length === 0) {
    findings.push({
      checkId: 'collector.parse',
      title: 'CIS collector output parsing',
      severity: 'high',
      status: 'fail',
      evidence: null,
      remediation: null,
      message: parseError,
    });
  }

  const summary = summarizeCisFindings(findings);
  const hasExplicitTotal = typeof parsed.totalChecks === 'number' && Number.isFinite(parsed.totalChecks);
  const hasExplicitPassed = typeof parsed.passedChecks === 'number' && Number.isFinite(parsed.passedChecks);
  const hasExplicitFailed = typeof parsed.failedChecks === 'number' && Number.isFinite(parsed.failedChecks);
  const totalChecks = hasExplicitTotal
    ? clampInteger(parsed.totalChecks, 0, 100_000, summary.totalChecks)
    : summary.totalChecks;
  const passedChecks = hasExplicitPassed
    ? clampInteger(parsed.passedChecks, 0, 100_000, summary.passedChecks)
    : summary.passedChecks;
  const failedChecks = hasExplicitFailed
    ? clampInteger(parsed.failedChecks, 0, 100_000, summary.failedChecks)
    : summary.failedChecks;
  const score = clampInteger(parsed.score, 0, 100, summary.score);

  return {
    checkedAt: Number.isNaN(checkedAt.getTime()) ? new Date() : checkedAt,
    findings,
    totalChecks,
    passedChecks,
    failedChecks,
    score,
    rawSummary: parsed.summary && typeof parsed.summary === 'object'
      ? parsed.summary as Record<string, unknown>
      : parseError
        ? { parseError }
        : {}
  };
}
