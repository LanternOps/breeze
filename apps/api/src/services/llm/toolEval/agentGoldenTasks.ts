/**
 * #7428: a small golden set of realistic headless agent tasks, scored on the
 * first real tool call exactly like the chat set (`goldenPrompts.ts`).
 *
 * Each task is an `AgentRunPromptContext`, rendered through the production
 * `buildAgentRunSystemPrompt` / `buildAgentRunTaskPrompt`, so a task sees the
 * same system prompt and task turn a queued run would. The trigger text
 * (alert titles, ticket bodies) mirrors what the alert and ticket pipelines
 * put into those fields.
 *
 * `expect` lists every first call a competent technician would accept. The
 * set mixes tasks whose answer is one of the tool-search `alwaysLoad` tools
 * (hot tools stay loaded under search) with tasks whose answer is deferred
 * under search, because the second kind is where a search round-trip or a
 * wrong-but-loaded first call would show up.
 */
import type { AgentRunPromptContext } from '../../aiAgents/runnerPrompt';
import type { AgentCaptureSurfaceId } from '../toolCapture/surfaces';
import type { GoldenExpectation } from './goldenPrompts';

export interface AgentGoldenTask {
  id: string;
  /** One-line description for the report. */
  title: string;
  surface: AgentCaptureSurfaceId;
  context: AgentRunPromptContext;
  expect: GoldenExpectation[];
}

type FullRunInput = Partial<Pick<AgentRunPromptContext, 'device' | 'alert' | 'ticket' | 'anomaly' | 'instructions'>> & {
  id: string;
  kind?: AgentRunPromptContext['agent']['kind'];
  mode?: AgentRunPromptContext['run']['mode'];
  trigger?: AgentRunPromptContext['run']['triggerKind'];
};

function fullRun(input: FullRunInput): AgentRunPromptContext {
  const n = input.id.replace(/\D/g, '').padStart(12, '0');
  return {
    agent: { name: input.kind === 'helpdesk' ? 'Helpdesk agent' : input.kind === 'patch' ? 'Patch agent' : 'Alert triage agent', kind: input.kind ?? 'triage' },
    run: { id: `00000000-0000-4000-8000-${n}`, mode: input.mode ?? 'shadow', triggerKind: input.trigger ?? 'alert' },
    device: input.device ?? null,
    alert: input.alert ?? null,
    ticket: input.ticket ?? null,
    anomaly: input.anomaly ?? null,
    instructions: input.instructions ?? null,
    profile: 'full',
    correlationGroup: null,
    sweep: null,
    narrative: null,
    design: null,
  };
}

function device(n: number, hostname: string, osType = 'windows'): NonNullable<AgentRunPromptContext['device']> {
  return { id: `00000000-0000-4000-9000-${String(n).padStart(12, '0')}`, hostname, osType };
}

function analysisRun(id: string, goal: string, deviceCount: number, handles: string[]): AgentRunPromptContext {
  return {
    ...fullRun({ id, trigger: 'manual' }),
    agent: { name: 'Fleet analyst', kind: 'triage' },
    profile: 'analysis',
    analysis: {
      goal,
      deviceIds: Array.from({ length: deviceCount }, (_, i) => device(100 + i, 'x').id),
      handles,
    },
  };
}

const FS01 = device(1, 'FS-01');
const SQL01 = device(2, 'SQL-01');
const PRINT = device(3, 'PRINT-SRV');
const LAB = device(4, 'LAB-WS-042');
const WEB03 = device(5, 'WEB-03');
const HRLT = device(6, 'HR-LT-07');
const APP02 = device(7, 'APP-02', 'linux');
const DC01 = device(8, 'DC-01');
const HV = device(9, 'HV-HOST-01');
const SALES = device(10, 'SALES-LT-12');

export const AGENT_GOLDEN_TASKS: readonly AgentGoldenTask[] = [
  {
    id: 'a01', title: 'Disk space alert on a file server', surface: 'agent-full-remediation',
    context: fullRun({ id: 'a01', mode: 'act', device: FS01,
      alert: { title: 'Low disk space on C:', severity: 'high', message: 'C: has 3% free space (4.1 GB of 120 GB).' } }),
    expect: [{ tool: 'analyze_disk_usage' }, { tool: 'analyze_metrics' }, { tool: 'get_device_details' }],
  },
  {
    id: 'a02', title: 'Sustained CPU alert on a SQL server', surface: 'agent-full-remediation',
    context: fullRun({ id: 'a02', device: SQL01,
      alert: { title: 'CPU usage above 95% for 15 minutes', severity: 'high', message: 'Average CPU 97% over the last 15 minutes.' } }),
    expect: [{ tool: 'analyze_metrics' }, { tool: 'get_device_details' }],
  },
  {
    id: 'a03', title: 'Stopped service alert', surface: 'agent-full-remediation',
    context: fullRun({ id: 'a03', mode: 'act', device: PRINT,
      alert: { title: 'Service stopped: Print Spooler', severity: 'medium', message: 'The Spooler service is not running (expected: Automatic, Running).' } }),
    expect: [{ tool: 'manage_services' }, { tool: 'search_logs' }, { tool: 'get_device_details' }],
  },
  {
    id: 'a04', title: 'Backup job failure alert', surface: 'agent-full-remediation',
    context: fullRun({ id: 'a04', device: FS01,
      alert: { title: 'Backup failed: Nightly file backup', severity: 'high', message: 'The 02:00 backup job ended with status failed after 3 retries.' } }),
    expect: [{ tool: 'get_backup_status' }, { tool: 'query_backups' }],
  },
  {
    id: 'a05', title: 'Device offline alert', surface: 'agent-full-remediation',
    context: fullRun({ id: 'a05', device: LAB,
      alert: { title: 'Device offline', severity: 'medium', message: 'No heartbeat for 30 minutes.' } }),
    expect: [{ tool: 'get_device_details' }, { tool: 'search_agent_logs' }, { tool: 'get_ip_history' }],
  },
  {
    id: 'a06', title: 'SentinelOne threat alert', surface: 'agent-full-remediation',
    context: fullRun({ id: 'a06', device: WEB03,
      alert: { title: 'SentinelOne: threat detected', severity: 'critical', message: 'Malicious file quarantined: C:\\Users\\Public\\invoice.exe' } }),
    expect: [{ tool: 'get_s1_threats' }, { tool: 'get_s1_status' }],
  },
  {
    id: 'a07', title: 'Huntress incident alert', surface: 'agent-full-remediation',
    context: fullRun({ id: 'a07', device: SALES,
      alert: { title: 'Huntress incident report', severity: 'high', message: 'Huntress opened a new incident for this host.' } }),
    expect: [{ tool: 'get_huntress_incidents' }, { tool: 'get_huntress_status' }],
  },
  {
    id: 'a08', title: 'Missing critical updates (patch agent)', surface: 'agent-full-remediation',
    context: fullRun({ id: 'a08', kind: 'patch', device: HRLT,
      alert: { title: 'Critical updates missing for more than 30 days', severity: 'high', message: '4 critical updates pending since 2026-08-12.' } }),
    expect: [{ tool: 'manage_patches' }],
  },
  {
    id: 'a09', title: 'Known-exploited CVE alert', surface: 'agent-full-remediation',
    context: fullRun({ id: 'a09', device: WEB03,
      alert: { title: 'Known exploited vulnerability detected', severity: 'critical', message: 'CVE-2026-21337 (CISA KEV) affects installed software on this device.' } }),
    expect: [{ tool: 'get_device_vulnerabilities' }, { tool: 'get_vulnerability_report' }],
  },
  {
    id: 'a10', title: 'Memory anomaly', surface: 'agent-full-remediation',
    context: fullRun({ id: 'a10', device: APP02, trigger: 'anomaly',
      anomaly: {
        anomalyType: 'metric', bucketSeconds: 300, windowStart: '2026-09-27T01:00:00.000Z',
        firstSeenAt: '2026-09-27T01:05:00.000Z', lastSeenAt: '2026-09-27T02:10:00.000Z',
        peakScore: 6.4, rowCount: 14, metricNames: ['memory_percent'], truncated: false,
        siblings: [{
          metricName: 'memory_percent', kind: 'spike', score: 6.4, observedValue: 96, baselineValue: 61,
          baselineMin: 48, baselineMax: 72, evidence: { zScore: 6.4 }, baseline: { mean: 61, stddev: 5.5 },
        }],
      } }),
    expect: [{ tool: 'analyze_metrics' }, { tool: 'get_device_details' }],
  },
  {
    id: 'a11', title: 'Helpdesk ticket: slow laptop', surface: 'agent-full-remediation',
    context: fullRun({ id: 'a11', kind: 'helpdesk', trigger: 'ticket',
      ticket: {
        subject: 'Laptop extremely slow since this morning', status: 'open', priority: 'normal', category: 'Hardware',
        tags: [], dueDate: null, similarResolvedTickets: [], truncated: false,
        description: 'Everything takes minutes to open, Outlook freezes. Rebooted twice, no change.',
        comments: [{ authorType: 'portal', content: 'Still slow after lunch.', createdAt: '2026-09-27T13:10:00.000Z' }],
        linkedDevice: {
          hostname: 'SALES-LT-12', displayName: null, osType: 'windows', alerts: [], sweepFindings: [],
          verdicts: { actionable: 0, transient_self_healed: 0, recurring_pattern: 0, duplicate_of_group: 0, needs_human: 0 },
        },
      } }),
    expect: [{ tool: 'analyze_metrics' }, { tool: 'get_device_details' }, { tool: 'query_devices' },
      { tool: 'get_user_experience_metrics' }, { tool: 'analyze_boot_performance' }],
  },
  {
    id: 'a12', title: 'Scheduled org security posture review', surface: 'agent-full-remediation',
    context: fullRun({ id: 'a12', trigger: 'schedule',
      instructions: 'Every Monday, review antivirus, firewall and disk-encryption coverage for this organization and list the gaps.' }),
    expect: [{ tool: 'get_security_posture' }],
  },
  {
    id: 'a13', title: 'Failed-logon burst on a domain controller', surface: 'agent-full-remediation',
    context: fullRun({ id: 'a13', device: DC01,
      alert: { title: 'Event log: 250 failed logons (4625) in 10 minutes', severity: 'high', message: 'Event ID 4625 from multiple source IPs.' } }),
    expect: [{ tool: 'search_logs' }, { tool: 'get_log_trends' }],
  },
  {
    id: 'a14', title: 'Website monitor down', surface: 'agent-full-remediation',
    context: fullRun({ id: 'a14',
      alert: { title: 'Monitor down: Contoso customer portal (HTTPS)', severity: 'critical', message: 'HTTP check to https://portal.contoso.example failed 3 times: connection timed out.' } }),
    expect: [{ tool: 'query_monitors' }, { tool: 'get_monitor' }, { tool: 'list_monitors' }, { tool: 'get_service_monitoring_status' }],
  },
  {
    id: 'a15', title: 'Unknown device on the network', surface: 'agent-full-remediation',
    context: fullRun({ id: 'a15',
      alert: { title: 'New unknown device discovered on 10.20.0.0/24', severity: 'medium', message: 'MAC 3C:22:FB:10:4A:91 at 10.20.0.187, vendor unknown.' } }),
    expect: [{ tool: 'get_network_changes' }, { tool: 'get_recent_network_changes' }, { tool: 'list_network_assets' }, { tool: 'get_network_asset' }],
  },
  {
    id: 'a16', title: 'Hyper-V VM stopped unexpectedly', surface: 'agent-full-remediation',
    context: fullRun({ id: 'a16', device: HV,
      alert: { title: 'Hyper-V VM stopped: VM-APP-03', severity: 'high', message: 'VM state changed Running -> Off without a shutdown request.' } }),
    expect: [{ tool: 'query_hyperv_vms' }, { tool: 'get_hyperv_vm_details' }, { tool: 'search_logs' }],
  },
  {
    id: 'b01', title: 'Analysis: CPU outliers across 12 devices', surface: 'agent-analysis',
    context: analysisRun('b01', 'Compare CPU utilisation across these devices for the last 30 days and name the three biggest outliers.', 12, []),
    expect: [{ tool: 'export_dataset' }, { tool: 'analyze_fleet_metrics' }, { tool: 'analyze_metrics' }],
  },
  {
    id: 'b02', title: 'Analysis: parse staged IIS logs', surface: 'agent-analysis',
    context: analysisRun('b02', 'Parse the staged IIS logs and count HTTP 5xx responses per URL path, top 20.', 0,
      ['art_00000000000000000000000000000001']),
    expect: [{ tool: 'workspace_stage' }],
  },
  {
    id: 'b03', title: 'Analysis: correlate error spikes across devices', surface: 'agent-analysis',
    context: analysisRun('b03', 'Find error spikes in the event logs of these devices over the last week and whether they line up in time.', 8, []),
    expect: [{ tool: 'export_dataset' }, { tool: 'get_log_trends' }, { tool: 'detect_log_correlations' }, { tool: 'search_logs' }],
  },
];
