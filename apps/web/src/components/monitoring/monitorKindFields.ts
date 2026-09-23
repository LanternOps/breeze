import type { MonitorKind } from '@breeze/shared';

/**
 * The monitor editor's condition fields render from this map rather than
 * hand-coding each kind's form (#5289). Keys MUST match `monitorConditionSchemas`
 * in `packages/shared/src/validators/monitors.ts` exactly — `monitorKindFields.test.ts`
 * asserts every key here is a key of the corresponding zod object's shape, and
 * `defaultConditionFor` must produce a value the schema accepts.
 */
export type FieldKind = 'number' | 'text' | 'select' | 'operator' | 'script' | 'boolean';

export interface KindField {
  key: string;
  labelKey: string;
  kind: FieldKind;
  options?: readonly string[];
  min?: number;
  max?: number;
  step?: number;
  optional?: boolean;
  unit?: string;
  /**
   * Render this field only while a sibling condition field currently holds
   * `equals` (string-compared against the sibling's live form value). Powers
   * the "only relevant for this check" fields on the W04 kinds (#5291)
   * without hand-coding a bespoke form per kind — `MonitorConditionFields`
   * reads the sibling via `useWatch` and skips rendering when it doesn't
   * match.
   */
  showWhen?: { key: string; equals: string };
}

const OPERATOR: KindField = { key: 'operator', labelKey: 'monitoring:fields.operator', kind: 'operator' };
const DURATION_MINUTES = (max = 1440): KindField => ({
  key: 'durationMinutes',
  labelKey: 'monitoring:fields.durationMinutes',
  kind: 'number',
  min: 1,
  max,
  optional: true,
});

function percentValue(): KindField {
  return { key: 'value', labelKey: 'monitoring:fields.value', kind: 'number', min: 0, max: 100, unit: '%' };
}

export const MONITOR_KIND_FIELDS: Record<MonitorKind, readonly KindField[]> = {
  cpu: [OPERATOR, percentValue(), DURATION_MINUTES()],
  memory: [OPERATOR, percentValue(), DURATION_MINUTES()],
  disk: [OPERATOR, percentValue(), DURATION_MINUTES()],
  offline: [
    { key: 'durationMinutes', labelKey: 'monitoring:fields.durationMinutes', kind: 'number', min: 1, max: 10080 },
  ],
  event_log: [
    {
      key: 'category',
      labelKey: 'monitoring:fields.category',
      kind: 'select',
      options: ['security', 'hardware', 'application', 'system'],
    },
    { key: 'level', labelKey: 'monitoring:fields.level', kind: 'select', options: ['warning', 'error', 'critical'] },
    { key: 'sourcePattern', labelKey: 'monitoring:fields.sourcePattern', kind: 'text', optional: true },
    { key: 'messagePattern', labelKey: 'monitoring:fields.messagePattern', kind: 'text', optional: true },
    { key: 'countThreshold', labelKey: 'monitoring:fields.countThreshold', kind: 'number', min: 1 },
    { key: 'windowMinutes', labelKey: 'monitoring:fields.windowMinutes', kind: 'number', min: 1, max: 1440 },
  ],
  patch_compliance: [OPERATOR, percentValue()],
  service: [
    { key: 'serviceName', labelKey: 'monitoring:fields.serviceName', kind: 'text' },
    {
      key: 'consecutiveFailures',
      labelKey: 'monitoring:fields.consecutiveFailures',
      kind: 'number',
      min: 1,
      max: 100,
      optional: true,
    },
  ],
  process: [
    { key: 'processName', labelKey: 'monitoring:fields.processName', kind: 'text' },
    {
      key: 'consecutiveFailures',
      labelKey: 'monitoring:fields.consecutiveFailures',
      kind: 'number',
      min: 1,
      max: 100,
      optional: true,
    },
  ],
  process_resource: [
    { key: 'resource', labelKey: 'monitoring:fields.resource', kind: 'select', options: ['cpu', 'memory'] },
    { key: 'processName', labelKey: 'monitoring:fields.processName', kind: 'text' },
    OPERATOR,
    { key: 'value', labelKey: 'monitoring:fields.value', kind: 'number', min: 0 },
    DURATION_MINUTES(),
  ],
  cert_expiry: [
    { key: 'withinDays', labelKey: 'monitoring:fields.withinDays', kind: 'number', min: 1, max: 365 },
  ],
  bandwidth: [
    { key: 'direction', labelKey: 'monitoring:fields.direction', kind: 'select', options: ['in', 'out', 'total'] },
    OPERATOR,
    { key: 'value', labelKey: 'monitoring:fields.value', kind: 'number', min: 0, unit: 'Mbps' },
    DURATION_MINUTES(),
  ],
  disk_io: [
    { key: 'direction', labelKey: 'monitoring:fields.direction', kind: 'select', options: ['read', 'write', 'total'] },
    OPERATOR,
    { key: 'value', labelKey: 'monitoring:fields.value', kind: 'number', min: 0, unit: 'MB/s' },
    DURATION_MINUTES(),
  ],
  network_errors: [
    { key: 'interfaceName', labelKey: 'monitoring:fields.interfaceName', kind: 'text', optional: true },
    { key: 'errorType', labelKey: 'monitoring:fields.errorType', kind: 'select', options: ['in', 'out', 'total'] },
    OPERATOR,
    { key: 'value', labelKey: 'monitoring:fields.value', kind: 'number', min: 0 },
    { ...DURATION_MINUTES(1440), key: 'windowMinutes', labelKey: 'monitoring:fields.windowMinutes' },
  ],
  antivirus: [
    {
      key: 'check',
      labelKey: 'monitoring:fields.check',
      kind: 'select',
      options: ['not_protected', 'definitions_stale', 'realtime_disabled', 'threats_present'],
    },
    {
      key: 'staleAfterDays',
      labelKey: 'monitoring:fields.staleAfterDays',
      kind: 'number',
      min: 1,
      max: 365,
      optional: true,
      showWhen: { key: 'check', equals: 'definitions_stale' },
    },
    {
      key: 'minThreatCount',
      labelKey: 'monitoring:fields.minThreatCount',
      kind: 'number',
      min: 1,
      max: 1000,
      optional: true,
      showWhen: { key: 'check', equals: 'threats_present' },
    },
  ],
  software_presence: [
    { key: 'name', labelKey: 'monitoring:fields.softwareName', kind: 'text' },
    { key: 'vendor', labelKey: 'monitoring:fields.vendor', kind: 'text', optional: true },
    {
      key: 'presence',
      labelKey: 'monitoring:fields.presence',
      kind: 'select',
      options: ['installed', 'not_installed', 'version_below'],
    },
    {
      key: 'version',
      labelKey: 'monitoring:fields.version',
      kind: 'text',
      optional: true,
      showWhen: { key: 'presence', equals: 'version_below' },
    },
  ],
  backup_continuity: [
    {
      key: 'check',
      labelKey: 'monitoring:fields.backupCheck',
      kind: 'select',
      options: ['no_successful_backup', 'consecutive_failures'],
    },
    {
      key: 'maxAgeHours',
      labelKey: 'monitoring:fields.maxAgeHours',
      kind: 'number',
      min: 1,
      max: 8760,
      optional: true,
      showWhen: { key: 'check', equals: 'no_successful_backup' },
    },
    {
      key: 'failureCount',
      labelKey: 'monitoring:fields.failureCount',
      kind: 'number',
      min: 1,
      max: 50,
      optional: true,
      showWhen: { key: 'check', equals: 'consecutive_failures' },
    },
  ],
  script: [
    { key: 'scriptId', labelKey: 'monitoring:fields.script', kind: 'script' },
    { key: 'intervalMinutes', labelKey: 'monitoring:fields.intervalMinutes', kind: 'number', min: 5, max: 1440 },
    { key: 'timeoutSeconds', labelKey: 'monitoring:fields.timeoutSeconds', kind: 'number', min: 10, max: 3600 },
    { key: 'breachOnNonZeroExit', labelKey: 'monitoring:fields.breachOnNonZeroExit', kind: 'boolean' },
    // `parameters` (free-form record) is intentionally not authored here —
    // the editor doesn't collect it this wave (#5291 Task 8).
  ],
  network_check: [
    {
      key: 'checkType',
      labelKey: 'monitoring:fields.checkType',
      kind: 'select',
      options: ['icmp_ping', 'tcp_port', 'http_check', 'dns_check'],
    },
    { key: 'target', labelKey: 'monitoring:fields.target', kind: 'text' },
    {
      key: 'port',
      labelKey: 'monitoring:fields.port',
      kind: 'number',
      min: 1,
      max: 65535,
      optional: true,
      showWhen: { key: 'checkType', equals: 'tcp_port' },
    },
    {
      key: 'expectStatus',
      labelKey: 'monitoring:fields.expectStatus',
      kind: 'number',
      min: 100,
      max: 599,
      optional: true,
      showWhen: { key: 'checkType', equals: 'http_check' },
    },
    {
      key: 'pollingIntervalSeconds',
      labelKey: 'monitoring:fields.pollingIntervalSeconds',
      kind: 'number',
      min: 30,
      max: 3600,
    },
    { key: 'timeoutSeconds', labelKey: 'monitoring:fields.timeoutSeconds', kind: 'number', min: 1, max: 120 },
    {
      key: 'consecutiveFailures',
      labelKey: 'monitoring:fields.consecutiveFailures',
      kind: 'number',
      min: 1,
      max: 100,
    },
  ],
  // W05c1: the composite kind exists in the shared enum so the API can compile
  // it; W05c2 supplies the children editor and response controls.
  // Keep the picker exhaustive; do not add a composite exclusion.
  composite: [
    { key: 'match', labelKey: 'monitoring:fields.match', kind: 'select', options: ['all', 'any'] },
  ],

};

/**
 * Per-`checkType` default targets for the `network_check` kind (#MSA-1). When
 * the editor's `checkType` select changes, `MonitorConditionFields` resets
 * `target` to the NEW type's default if it still holds the PREVIOUS type's
 * default here (or is empty) — a stale ICMP `8.8.8.8` silently carrying over
 * onto an HTTP check reads as a plausible default rather than the ping
 * leftover it is. A target the user actually typed is left alone. Every
 * value here must satisfy `target: z.string().min(1).max(500)`
 * (`packages/shared/src/validators/monitors.ts`) — an empty string would be
 * a valid-looking reset that fails validation on save.
 */
export const NETWORK_CHECK_TARGET_DEFAULTS: Record<string, string> = {
  icmp_ping: '8.8.8.8',
  tcp_port: '8.8.8.8',
  http_check: 'https://example.com',
  dns_check: '8.8.8.8',
};

/**
 * First valid values for a freshly-chosen kind — every one of these MUST pass
 * `monitorConditionSchemas[kind].safeParse(...)` (asserted in the test). String
 * fields that are required (min length 1) get a short placeholder value rather
 * than an empty string; the operator picks the direction that reads naturally
 * for a "watch" (over a threshold for resource kinds, under it for compliance).
 */
export function defaultConditionFor(kind: MonitorKind): Record<string, unknown> {
  switch (kind) {
    case 'cpu':
    case 'memory':
    case 'disk':
      return { operator: 'gt', value: 90, durationMinutes: 5 };
    case 'offline':
      return { durationMinutes: 5 };
    case 'event_log':
      return { category: 'application', level: 'error', countThreshold: 1, windowMinutes: 60 };
    case 'patch_compliance':
      return { operator: 'lt', value: 90 };
    case 'service':
      return { serviceName: 'MyService' };
    case 'process':
      return { processName: 'process.exe' };
    case 'process_resource':
      return { resource: 'cpu', processName: 'process.exe', operator: 'gt', value: 80 };
    case 'cert_expiry':
      return { withinDays: 30 };
    case 'bandwidth':
      return { direction: 'total', operator: 'gt', value: 100 };
    case 'disk_io':
      return { direction: 'total', operator: 'gt', value: 50 };
    case 'network_errors':
      return { errorType: 'total', operator: 'gt', value: 10 };
    case 'antivirus':
      return { check: 'not_protected' };
    case 'software_presence':
      return { name: 'Example App', presence: 'not_installed' };
    case 'backup_continuity':
      return { check: 'no_successful_backup', maxAgeHours: 24 };
    case 'script':
      // Nil UUID placeholder — same idiom as `service`/`process`'s placeholder
      // names above; the editor's script picker replaces it once a real
      // script is chosen.
      return { scriptId: '00000000-0000-0000-0000-000000000000', intervalMinutes: 60, timeoutSeconds: 300, breachOnNonZeroExit: true };
    case 'network_check':
      return { checkType: 'icmp_ping', target: '8.8.8.8', pollingIntervalSeconds: 60, timeoutSeconds: 5, consecutiveFailures: 2 };
    case 'composite':
      return {
        match: 'all',
        children: [
          { kind: 'cpu', condition: { operator: 'gt', value: 90, durationMinutes: 5 } },
          { kind: 'memory', condition: { operator: 'gt', value: 90, durationMinutes: 5 } },
        ],
      };

  }
}
