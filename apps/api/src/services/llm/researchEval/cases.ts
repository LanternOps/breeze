/**
 * Research eval dataset (AI Suggested Fixes W2, Task 22): ~20 generic alert
 * shapes spanning OS x problem family. Every case seeds a catalog with one
 * right-OS script, one wrong-OS script and one irrelevant script, so validity
 * and OS filtering are measured. Public repo: invented names only, no hosts,
 * IPs or customers (guarded by cases.test.ts).
 */
export type EvalOs = 'windows' | 'linux' | 'macos';
export type EvalFamily = 'patch' | 'disk' | 'service' | 'memory';
export type EvalKind = 'catalog' | 'builtin_action' | 'manual_steps' | 'draft_request' | 'none';

export interface ResearchEvalCase {
  id: string;
  os: EvalOs;
  family: EvalFamily;
  alert: { title: string; severity: 'high' | 'critical'; message: string; context?: Record<string, unknown>; ruleConditions?: unknown };
  catalog: Array<{ name: string; osTypes: EvalOs[]; language: 'powershell' | 'bash' | 'python'; description: string }>;
  expect: { anyOf: EvalKind[]; builtinAction?: string; forbid?: string[] };
}

type CatalogEntry = ResearchEvalCase['catalog'][number];
const LANG: Record<EvalOs, CatalogEntry['language']> = { windows: 'powershell', linux: 'bash', macos: 'bash' };
const OTHER: Record<EvalOs, EvalOs> = { windows: 'linux', linux: 'windows', macos: 'windows' };

/** One right-OS script, one wrong-OS script, one irrelevant script (`wrongOnly` drops the right one). */
function catalogFor(os: EvalOs, right: string, rightDescription: string, wrongOnly = false): CatalogEntry[] {
  const other = OTHER[os];
  const entries: CatalogEntry[] = [
    { name: `${right} (${other})`, osTypes: [other], language: LANG[other], description: `${rightDescription} (${other} only)` },
    { name: 'Inventory printer drivers', osTypes: [os], language: LANG[os], description: 'Lists installed printer drivers; read-only inventory.' },
  ];
  if (!wrongOnly) entries.unshift({ name: right, osTypes: [os], language: LANG[os], description: rightDescription });
  return entries;
}

const leaf = (l: Record<string, unknown>) => ({ conditions: [l] });
const metric = (metricName: string) => leaf({ type: 'metric', metric: metricName, operator: 'gt', value: 90 });

export const RESEARCH_EVAL_CASES: readonly ResearchEvalCase[] = [
  { id: 'w-svc-1', os: 'windows', family: 'service',
    alert: { title: 'Service stopped: Spooler', severity: 'high', message: 'The Print Spooler service is not running.', ruleConditions: leaf({ type: 'service_stopped', serviceName: 'Spooler' }) },
    catalog: catalogFor('windows', 'Restart print spooler', 'Restarts the Spooler service and clears the queue.'),
    expect: { anyOf: ['builtin_action'], builtinAction: 'restart_service', forbid: ['reboot'] } },
  { id: 'w-svc-2', os: 'windows', family: 'service',
    alert: { title: 'Service stopped: wuauserv', severity: 'high', message: 'The Windows Update service is stopped.', ruleConditions: leaf({ type: 'service_stopped', serviceName: 'wuauserv' }) },
    catalog: catalogFor('windows', 'Reset Windows Update components', 'Stops services, clears the update cache and restarts them.'),
    expect: { anyOf: ['builtin_action', 'catalog'] } },
  { id: 'w-disk-1', os: 'windows', family: 'disk',
    alert: { title: 'Disk usage high on C:', severity: 'high', message: 'Disk usage is 96% on drive C:.', ruleConditions: metric('disk_percent') },
    catalog: catalogFor('windows', 'Clean temp files', 'Removes temporary files and empties the recycle bin.'),
    expect: { anyOf: ['builtin_action', 'catalog'] } },
  { id: 'w-disk-2', os: 'windows', family: 'disk',
    alert: { title: 'Disk full on C:', severity: 'critical', message: 'Drive C: has 1% free space.', ruleConditions: metric('disk_percent') },
    catalog: catalogFor('windows', 'Clean old logs', 'Deletes logs older than 14 days under /var/log.', true),
    expect: { anyOf: ['builtin_action', 'manual_steps'] } },
  { id: 'w-mem-1', os: 'windows', family: 'memory',
    alert: { title: 'Process memory high: example-agent.exe', severity: 'high', message: 'example-agent.exe is using 6 GB of memory.', ruleConditions: leaf({ type: 'process_memory_high', processName: 'example-agent.exe' }) },
    catalog: catalogFor('windows', 'Restart example agent service', 'Restarts the example agent service.'),
    expect: { anyOf: ['builtin_action', 'manual_steps', 'catalog'] } },
  { id: 'w-patch-1', os: 'windows', family: 'patch',
    alert: { title: 'Patch job failed', severity: 'high', message: 'Security updates failed to install on the last patch job.', context: { source: 'patch-job-finalizer', category: 'security' } },
    catalog: catalogFor('windows', 'Repair Windows Update', 'Runs DISM and SFC repair for the servicing stack.'),
    expect: { anyOf: ['manual_steps', 'catalog'] } },
  { id: 'w-patch-2', os: 'windows', family: 'patch',
    alert: { title: 'Reboot pending', severity: 'high', message: 'The device has had a reboot pending for 12 days.', context: { source: 'reboot_pending' } },
    catalog: catalogFor('windows', 'Check pending reboot reasons', 'Reports why a reboot is pending; read-only.'),
    expect: { anyOf: ['builtin_action'], builtinAction: 'reboot' } },
  { id: 'w-exit-1', os: 'windows', family: 'service',
    alert: { title: 'Script failed with exit code 1603', severity: 'high', message: 'The software install script exited with code 1603.', ruleConditions: leaf({ type: 'script_exit_code', exitCode: 1603 }) },
    catalog: catalogFor('windows', 'Collect installer logs', 'Gathers MSI installer logs from the temp folder.'),
    expect: { anyOf: ['manual_steps', 'draft_request'] } },
  { id: 'l-svc-1', os: 'linux', family: 'service',
    alert: { title: 'Service stopped: cron', severity: 'high', message: 'The cron service is not running.', ruleConditions: leaf({ type: 'service_stopped', serviceName: 'cron' }) },
    catalog: catalogFor('linux', 'Restart cron', 'Restarts the cron daemon.'),
    expect: { anyOf: ['builtin_action'], builtinAction: 'restart_service' } },
  { id: 'l-disk-1', os: 'linux', family: 'disk',
    alert: { title: 'Disk usage high on /', severity: 'high', message: 'Root filesystem is 95% full.', ruleConditions: metric('disk_percent') },
    catalog: catalogFor('linux', 'Rotate and prune logs', 'Vacuums the journal and prunes rotated logs.'),
    expect: { anyOf: ['builtin_action', 'catalog'] } },
  { id: 'l-disk-2', os: 'linux', family: 'disk',
    alert: { title: 'Journal growth filling disk', severity: 'high', message: 'The systemd journal grew by 8 GB in a day.', ruleConditions: metric('disk_percent') },
    catalog: catalogFor('linux', 'Vacuum journal', 'Runs journalctl --vacuum-size.', true),
    expect: { anyOf: ['builtin_action', 'manual_steps'] } },
  { id: 'l-mem-1', os: 'linux', family: 'memory',
    alert: { title: 'Process memory high: java', severity: 'high', message: 'A java process is using 90% of RAM.', ruleConditions: leaf({ type: 'process_memory_high', processName: 'java' }) },
    catalog: catalogFor('linux', 'Restart java service', 'Restarts the java application service.'),
    expect: { anyOf: ['manual_steps', 'builtin_action'] } },
  { id: 'l-patch-1', os: 'linux', family: 'patch',
    alert: { title: 'Patch compliance below target', severity: 'high', message: '14 security updates are outstanding for over 30 days.', ruleConditions: leaf({ type: 'patch_compliance' }) },
    catalog: catalogFor('linux', 'List pending updates', 'Lists pending package updates; read-only.'),
    expect: { anyOf: ['manual_steps', 'draft_request'] } },
  { id: 'l-cpu-1', os: 'linux', family: 'memory',
    alert: { title: 'Process CPU high: example-worker', severity: 'high', message: 'example-worker has used 100% CPU for 30 minutes.', ruleConditions: leaf({ type: 'process_cpu_high', processName: 'example-worker' }) },
    catalog: catalogFor('linux', 'Restart example worker', 'Restarts the example worker service.'),
    expect: { anyOf: ['builtin_action', 'manual_steps'] } },
  { id: 'm-svc-1', os: 'macos', family: 'service',
    alert: { title: 'Process stopped: example-daemon', severity: 'high', message: 'example-daemon is not running.', ruleConditions: leaf({ type: 'process_stopped', processName: 'example-daemon' }) },
    catalog: catalogFor('macos', 'Reload example daemon', 'Reloads the launchd job for example-daemon.'),
    expect: { anyOf: ['manual_steps', 'builtin_action', 'catalog'] } },
  { id: 'm-disk-1', os: 'macos', family: 'disk',
    alert: { title: 'Disk usage high', severity: 'high', message: 'The startup volume is 94% full.', ruleConditions: metric('disk_percent') },
    catalog: catalogFor('macos', 'Clear user caches', 'Clears user and system caches.'),
    expect: { anyOf: ['builtin_action', 'catalog'] } },
  { id: 'm-mem-1', os: 'macos', family: 'memory',
    alert: { title: 'Memory usage high', severity: 'high', message: 'RAM usage has been above 92% for an hour.', ruleConditions: metric('ram_percent') },
    catalog: catalogFor('macos', 'Report top memory processes', 'Lists the top memory consumers; read-only.'),
    expect: { anyOf: ['manual_steps'] } },
  { id: 'm-patch-1', os: 'macos', family: 'patch',
    alert: { title: 'Patch compliance below target', severity: 'high', message: 'macOS security updates are overdue.', ruleConditions: leaf({ type: 'patch_compliance' }) },
    catalog: catalogFor('macos', 'List available macOS updates', 'Runs softwareupdate --list; read-only.'),
    expect: { anyOf: ['manual_steps', 'draft_request'] } },
  { id: 'x-none-1', os: 'windows', family: 'service',
    alert: { title: 'Certificate expiring', severity: 'high', message: 'A machine certificate expires in 5 days.', ruleConditions: leaf({ type: 'cert_expiry' }) },
    catalog: catalogFor('windows', 'List certificates', 'Lists local machine certificates; read-only.'),
    expect: { anyOf: ['none', 'manual_steps'] } },
  { id: 'x-none-2', os: 'linux', family: 'disk',
    alert: { title: 'Disk hardware failing', severity: 'critical', message: 'SMART reports a failing disk component.', ruleConditions: leaf({ type: 'hardware_health', component: 'disk' }) },
    catalog: catalogFor('linux', 'Prune old logs', 'Prunes logs to free space.'),
    expect: { anyOf: ['none', 'manual_steps'], forbid: ['disk_cleanup'] } },
];
